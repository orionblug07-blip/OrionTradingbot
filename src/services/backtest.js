/**
 * ─── Backtester ──────────────────────────────────────────────────────────────
 * Replays daily candles through a strategy family exactly the way the live
 * auto-trader trades it:
 *
 *   Signal   on the daily close
 *   Entry    next day's OPEN, paying half the round-trip cost (spread + slippage)
 *   Stop     on the broker's server; filled at the stop, or at the open if the
 *            price gaps through it (weekends!). Pays the other half of the cost.
 *   Trail    after each daily close the stop tightens, never loosens
 *   Results  in R: R = the distance from entry to the first stop. +1R means the
 *            trade made what it risked. A full stop costs a bit more than −1R.
 *
 * Octa accounts are swap-free, so no overnight financing is charged. For a
 * broker that charges swaps, results would be somewhat worse for long holds.
 */

const { FAMILIES, prepare, initialStop, nextStop } = require('../strategies/fx');

/**
 * @param {Array} c candles oldest→newest (closed bars only)
 * @param {string} family
 * @param {object} p params
 * @param {object} o { cost: round-trip cost in price units, from, to: entry window (ms), symbol }
 * @returns {Array} trades
 */
function simulate(c, family, p, o = {}) {
  const fam = FAMILIES[family];
  if (!fam) throw new Error(`Unknown family ${family}`);
  const ind = o.ind || prepare(c);
  const half = (o.cost || 0) / 2;
  const from = o.from ?? -Infinity, to = o.to ?? Infinity;
  const trades = [];
  let pos = null;
  const start = fam.warmup(p);

  for (let j = start; j < c.length; j++) {
    const bar = c[j];
    // 1) open a pending entry at this bar's open
    if (pos && pos.pending) {
      const entry = pos.side === 'buy' ? bar.open + half : bar.open - half;
      const stop = initialStop(fam, ind, pos.signalIdx, pos.side, p, entry);
      const risk = Math.abs(entry - stop);
      if (stop == null || !(risk > 0)) { pos = null; }
      else Object.assign(pos, { pending: false, entry, stop, stop0: stop, risk, entryIdx: j, entryTime: bar.time });
    }
    // 2) stop hit during this bar?
    if (pos && !pos.pending) {
      let fill = null;
      if (pos.side === 'buy') {
        if (bar.open <= pos.stop) fill = bar.open; else if (bar.low <= pos.stop) fill = pos.stop;
      } else if (bar.open >= pos.stop) fill = bar.open; else if (bar.high >= pos.stop) fill = pos.stop;
      if (fill != null) {
        trades.push(close(pos, fill, bar.time, j, half, o.symbol));
        pos = null;
      } else {
        // 3) trail after the close
        pos.stop = nextStop(fam, ind, j, pos.side, p, pos.entryIdx, pos.stop);
      }
    }
    // 4) new signal on this close → enter at next open
    if (!pos && j < c.length - 1 && bar.time >= from && bar.time < to) {
      const side = fam.signal(ind, j, p);
      if (side) pos = { pending: true, side, signalIdx: j, signalTime: bar.time };
    }
  }
  if (pos && !pos.pending) {
    const last = c[c.length - 1];
    const t = close(pos, last.close, last.time, c.length - 1, half, o.symbol);
    t.open = true;
    trades.push(t);
  }
  return trades;
}

function close(pos, fill, time, idx, half, symbol) {
  const exit = pos.side === 'buy' ? fill - half : fill + half;
  const move = pos.side === 'buy' ? exit - pos.entry : pos.entry - exit;
  return {
    symbol, side: pos.side,
    signalTime: pos.signalTime, entryTime: pos.entryTime, exitTime: time,
    entry: pos.entry, exit, stop0: pos.stop0,
    r: move / pos.risk,
    riskPct: (pos.risk / pos.entry) * 100,
    bars: idx - pos.entryIdx + 1,
  };
}

/** Summary statistics in R with a 95% range for the average. */
function stats(trades) {
  const n = trades.length;
  if (!n) return { trades: 0, winRatePct: null, expectancyR: null, range95: null, profitFactor: null, avgBars: null, maxDrawdownR: null, bestR: null, worstR: null };
  const rs = trades.map(t => t.r);
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  const wins = rs.filter(r => r > 0);
  const gain = wins.reduce((a, b) => a + b, 0);
  const loss = -rs.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    trades: n,
    winRatePct: Math.round((wins.length / n) * 1000) / 10,
    expectancyR: r3(mean),
    range95: [r3(mean - 1.96 * se), r3(mean + 1.96 * se)],
    profitFactor: loss > 0 ? Math.round((gain / loss) * 100) / 100 : null,
    avgBars: Math.round(trades.reduce((a, t) => a + t.bars, 0) / n),
    maxDrawdownR: r3(dd),
    bestR: r3(Math.max(...rs)),
    worstR: r3(Math.min(...rs)),
  };
}

/**
 * Account simulation: risk `riskPct` of current equity per trade, at most
 * `maxOpen` positions at once (signals beyond that are skipped). Equity changes
 * when trades close, so the drawdown is on closed trades.
 */
function portfolio(trades, { riskPct = 1, maxOpen = 4 } = {}) {
  const events = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let equity = 100, peak = 100, dd = 0, taken = 0;
  const open = [];
  const settle = (until) => {
    open.sort((a, b) => a.t.exitTime - b.t.exitTime);
    while (open.length && open[0].t.exitTime <= until) {
      const { t, riskMoney } = open.shift();
      equity += riskMoney * t.r;
      peak = Math.max(peak, equity);
      dd = Math.max(dd, (peak - equity) / peak);
    }
  };
  for (const t of events) {
    settle(t.entryTime);
    if (open.length >= maxOpen || open.some(o => o.t.symbol === t.symbol)) continue;
    open.push({ t, riskMoney: equity * riskPct / 100 });
    taken++;
  }
  settle(Infinity);
  return { taken, returnPct: Math.round((equity - 100) * 10) / 10, maxDrawdownPct: Math.round(dd * 1000) / 10 };
}

module.exports = { simulate, stats, portfolio };
