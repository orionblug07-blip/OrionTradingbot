/**
 * ─── Forex strategy families (daily candles, long AND short) ────────────────
 * Shared by the lab (src/services/lab.js) and the live auto-trader
 * (src/services/autoTrader.js), so what is tested is exactly what runs.
 *
 * Every strategy is: an ENTRY rule checked on the daily close (trade at the
 * next open), an initial stop, and a TRAILING stop that only tightens. Exits
 * are by stop only — the stop sits on the broker's server, so live, demo and
 * the backtest handle exits the same way.
 *
 *   donchian  Close breaks the N-day high (buy) or N-day low (sell).
 *             Stop/trail = the M-day low (buy) or M-day high (sell).
 *   emaTrend  Fast EMA above slow EMA and the close crosses back above the fast
 *             EMA (buy); mirror for sell. Trail = best close − k·ATR.
 *   tsmom     The L-day return turns positive (buy) or negative (sell), and the
 *             price is on the same side of its 100-day EMA. Trail = k·ATR.
 */

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === n - 1) prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else if (i >= n) prev = values[i] * k + prev * (1 - k);
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

/** Wilder ATR(n) */
function atr(c, n = 20) {
  const out = new Array(c.length).fill(null);
  let prev = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i < n) { prev += tr; if (i === n - 1) { prev /= n - 1; out[i] = prev; } continue; }
    prev = (prev * (n - 1) + tr) / n;
    out[i] = prev;
  }
  return out;
}

/** Highest high / lowest low of the n bars BEFORE bar i. */
function priorHigh(c, i, n) { if (i - n < 0) return null; let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, c[j].high); return m; }
function priorLow(c, i, n) { if (i - n < 0) return null; let m = Infinity; for (let j = i - n; j < i; j++) m = Math.min(m, c[j].low); return m; }
/** Lowest low / highest high of the n bars ENDING at bar i (inclusive). */
function lowIncl(c, i, n) { if (i - n + 1 < 0) return null; let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, c[j].low); return m; }
function highIncl(c, i, n) { if (i - n + 1 < 0) return null; let m = -Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.max(m, c[j].high); return m; }

/** Indicators for one symbol (computed once, shared by every variant). */
function prepare(c) {
  const close = c.map(x => x.close);
  const emas = {};
  for (const n of [10, 20, 50, 100, 200]) emas[n] = ema(close, n);
  return { c, close, ema: emas, atr: atr(c, 20) };
}

const MIN_STOP_ATR = 0.5; // never place a stop closer than half a day's average range

const FAMILIES = {
  donchian: {
    name: 'Breakout',
    describe: (p) => `Breakout — buy a close above the ${p.entryN}-day high, sell a close below the ${p.entryN}-day low; stop trails the ${p.exitN}-day low/high`,
    grid: () => {
      const g = [];
      for (const entryN of [20, 55, 100]) for (const exitN of [10, 20, 50]) if (exitN < entryN) g.push({ entryN, exitN });
      return g;
    },
    warmup: (p) => Math.max(p.entryN, p.exitN) + 21,
    signal(ind, i, p) {
      const { c } = ind;
      const hi = priorHigh(c, i, p.entryN), lo = priorLow(c, i, p.entryN);
      if (hi == null) return null;
      if (c[i].close > hi) return 'buy';
      if (c[i].close < lo) return 'sell';
      return null;
    },
    trail(ind, i, side, p) {
      return side === 'buy' ? lowIncl(ind.c, i, p.exitN) : highIncl(ind.c, i, p.exitN);
    },
  },

  emaTrend: {
    name: 'Trend pullback',
    describe: (p) => `Trend pullback — EMA${p.fast} above EMA${p.slow} and the close crosses back above EMA${p.fast} (buy), mirror for sell; stop trails ${p.k}×ATR from the best close`,
    grid: () => {
      const g = [];
      for (const [fast, slow] of [[10, 50], [20, 100], [50, 200]]) for (const k of [2, 3, 4]) g.push({ fast, slow, k });
      return g;
    },
    warmup: (p) => p.slow + 21,
    signal(ind, i, p) {
      const f = ind.ema[p.fast], s = ind.ema[p.slow], cl = ind.close;
      if (i < 1 || f[i] == null || s[i] == null || f[i - 1] == null) return null;
      if (f[i] > s[i] && cl[i - 1] <= f[i - 1] && cl[i] > f[i]) return 'buy';
      if (f[i] < s[i] && cl[i - 1] >= f[i - 1] && cl[i] < f[i]) return 'sell';
      return null;
    },
    trail(ind, i, side, p, entryIdx) { return atrTrail(ind, i, side, p.k, entryIdx); },
  },

  tsmom: {
    name: 'Momentum',
    describe: (p) => `Momentum — the ${p.lookback}-day return turns positive above the 100-day EMA (buy) or negative below it (sell); stop trails ${p.k}×ATR`,
    grid: () => {
      const g = [];
      for (const lookback of [60, 120, 250]) for (const k of [3, 4, 5]) g.push({ lookback, k });
      return g;
    },
    warmup: (p) => Math.max(p.lookback + 1, 100) + 21,
    signal(ind, i, p) {
      const cl = ind.close, e = ind.ema[100];
      if (i - p.lookback - 1 < 0 || e[i] == null) return null;
      const r = cl[i] / cl[i - p.lookback] - 1;
      const rPrev = cl[i - 1] / cl[i - 1 - p.lookback] - 1;
      if (r > 0 && rPrev <= 0 && cl[i] > e[i]) return 'buy';
      if (r < 0 && rPrev >= 0 && cl[i] < e[i]) return 'sell';
      return null;
    },
    trail(ind, i, side, p, entryIdx) { return atrTrail(ind, i, side, p.k, entryIdx); },
  },
};

function atrTrail(ind, i, side, k, entryIdx) {
  const a = ind.atr[i];
  if (a == null) return null;
  const from = Math.max(0, entryIdx ?? i);
  let best = side === 'buy' ? -Infinity : Infinity;
  for (let j = from; j <= i; j++) best = side === 'buy' ? Math.max(best, ind.close[j]) : Math.min(best, ind.close[j]);
  return side === 'buy' ? best - k * a : best + k * a;
}

/** Initial stop for a signal on bar i, filled at entryPrice. */
function initialStop(fam, ind, i, side, p, entryPrice) {
  let stop = fam.trail(ind, i, side, p, i);
  const minDist = MIN_STOP_ATR * (ind.atr[i] || 0);
  if (stop == null) return null;
  if (side === 'buy') stop = Math.min(stop, entryPrice - minDist);
  else stop = Math.max(stop, entryPrice + minDist);
  return stop;
}

/** Tighten-only update of an existing stop. */
function nextStop(fam, ind, i, side, p, entryIdx, current) {
  const cand = fam.trail(ind, i, side, p, entryIdx);
  if (cand == null) return current;
  return side === 'buy' ? Math.max(current, cand) : Math.min(current, cand);
}

function strategyId(family, params) {
  return `${family}:${Object.values(params).join('-')}`;
}

module.exports = { FAMILIES, prepare, initialStop, nextStop, strategyId, ema, atr };
