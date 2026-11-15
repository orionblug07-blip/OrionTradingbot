const test = require('node:test');
const assert = require('node:assert');
const { simulate, stats, portfolio } = require('../src/services/backtest');
const { FAMILIES, prepare, initialStop } = require('../src/strategies/fx');
const { runLab, verdictOf, summary, costFor, closedOnly } = require('../src/services/lab');
const { makeCandles, DAY } = require('./helpers');

function flatThenBreakout() {
  // 60 flat days around 1.1000, then a jump up, then a crash through the stop with a gap.
  const c = [];
  const t0 = Date.UTC(2020, 0, 1);
  for (let i = 0; i < 90; i++) c.push({ time: t0 + i * DAY, open: 1.1, high: 1.101, low: 1.099, close: 1.1 });
  c.push({ time: t0 + 90 * DAY, open: 1.1, high: 1.106, low: 1.0995, close: 1.105 }); // breaks the 55-day high
  c.push({ time: t0 + 91 * DAY, open: 1.106, high: 1.108, low: 1.104, close: 1.107 }); // entry at this open
  c.push({ time: t0 + 92 * DAY, open: 1.09, high: 1.092, low: 1.085, close: 1.088 }); // gaps below the stop
  return c;
}

test('breakout: enters next open, gap through the stop fills at the open, costs applied', () => {
  const c = flatThenBreakout();
  const trades = simulate(c, 'donchian', { entryN: 55, exitN: 20 }, { cost: 0.0002, symbol: 'EURUSD' });
  assert.strictEqual(trades.length, 1);
  const t = trades[0];
  assert.strictEqual(t.side, 'buy');
  assert.ok(Math.abs(t.entry - 1.1061) < 1e-9, 'entry = next open + half the cost');
  assert.ok(t.stop0 < 1.0995, 'stop below the 20-day low');
  assert.ok(Math.abs(t.exit - (1.09 - 0.0001)) < 1e-9, 'gap fill at the open minus half the cost');
  assert.ok(t.r < -1, 'a gap through the stop loses more than 1R');
});

test('sell signals mirror buys', () => {
  const c = flatThenBreakout().map(x => ({ ...x, open: 2.2 - x.open, close: 2.2 - x.close, high: 2.2 - x.low, low: 2.2 - x.high }));
  const trades = simulate(c, 'donchian', { entryN: 55, exitN: 20 }, { cost: 0.0002 });
  assert.strictEqual(trades[0].side, 'sell');
  assert.ok(trades[0].r < -1);
});

test('initial stop is never closer than half an ATR', () => {
  const c = makeCandles({ n: 300, seed: 9 });
  const ind = prepare(c);
  const i = 250;
  const entry = c[i].close;
  const stop = initialStop(FAMILIES.emaTrend, ind, i, 'buy', { fast: 20, slow: 100, k: 0.01 }, entry);
  assert.ok(entry - stop >= 0.5 * ind.atr[i] - 1e-12);
});

test('random walk without trend: costs make the average trade negative', () => {
  const all = [];
  for (let s = 1; s <= 6; s++) all.push(...simulate(makeCandles({ n: 2500, seed: s }), 'donchian', { entryN: 20, exitN: 10 }, { cost: 0.0004 }));
  const st = stats(all);
  assert.ok(st.trades > 100);
  assert.ok(st.expectancyR < 0.05, `expected no edge, got ${st.expectancyR}`);
});

test('stats: win rate, 95% range and profit factor', () => {
  const st = stats([{ r: 2, bars: 5, exitTime: 1 }, { r: -1, bars: 3, exitTime: 2 }, { r: -1, bars: 2, exitTime: 3 }, { r: 3, bars: 9, exitTime: 4 }]);
  assert.strictEqual(st.trades, 4);
  assert.strictEqual(st.winRatePct, 50);
  assert.strictEqual(st.expectancyR, 0.75);
  assert.strictEqual(st.profitFactor, 2.5);
  assert.ok(st.range95[0] < 0.75 && st.range95[1] > 0.75);
  assert.strictEqual(st.maxDrawdownR, 2);
});

test('portfolio: respects max open and one position per symbol', () => {
  const T = (symbol, entryTime, exitTime, r) => ({ symbol, entryTime, exitTime, r });
  const p = portfolio([T('A', 1, 10, 1), T('A', 2, 5, 1), T('B', 3, 8, -1), T('C', 4, 9, 2)], { riskPct: 1, maxOpen: 2 });
  assert.strictEqual(p.taken, 2); // A and B; second A (same symbol) and C (max open) skipped
});

test('verdicts', () => {
  assert.strictEqual(verdictOf({ trades: 10, expectancyR: 1, range95: [0.5, 1.5] }).verdict, 'TOO FEW TRADES');
  assert.strictEqual(verdictOf({ trades: 40, expectancyR: 0.3, range95: [0.05, 0.55] }).verdict, 'PASS');
  assert.strictEqual(verdictOf({ trades: 40, expectancyR: 0.1, range95: [-0.1, 0.3] }).verdict, 'NOT PROVEN');
  assert.strictEqual(verdictOf({ trades: 40, expectancyR: -0.1, range95: [-0.3, 0.1] }).verdict, 'FAIL');
});

test('lab: splits time, picks per family on the first part, judges on the rest', () => {
  const data = {};
  ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD'].forEach((s, k) => { data[s] = { candles: makeCandles({ n: 2200, regime: 120, drift: 0.0012, seed: k + 11 }), cost: 0.00015 }; });
  const r = runLab(data);
  assert.strictEqual(r.families.length, Object.keys(FAMILIES).length);
  assert.ok(r.period.from < r.period.split && r.period.split < r.period.to);
  for (const f of r.families) {
    assert.ok(f.chosen.label);
    assert.ok(['PASS', 'NOT PROVEN', 'FAIL', 'TOO FEW TRADES'].includes(f.verdict));
  }
  assert.ok(r.chosen.family);
  const text = summary(r);
  assert.match(text, /Strategy lab/);
  assert.match(text, /In use/);
});

test('lab: no trend in the data → nothing passes', () => {
  const data = {};
  ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF'].forEach((s, k) => { data[s] = { candles: makeCandles({ n: 2500, seed: k + 40 }), cost: 0.0003 }; });
  const r = runLab(data);
  assert.ok(r.families.every(f => f.verdict !== 'PASS'), JSON.stringify(r.families.map(f => [f.family, f.verdict, f.test.range95])));
  assert.match(summary(r), /real-money trading stays locked/);
});

test('cost: the larger of candle spread + slippage and the cautious table', () => {
  const c = [{ spread: 5 }, { spread: 6 }, { spread: 7 }];
  assert.ok(Math.abs(costFor('EURUSD', c, 0.00001) - 0.00012) < 1e-12, 'table wins (1.2 pips)');
  const wide = [{ spread: 30 }, { spread: 30 }, { spread: 30 }];
  assert.ok(Math.abs(costFor('EURUSD', wide, 0.00001) - (0.0003 + 0.00004)) < 1e-12, 'candles win when wider');
});

test('closedOnly drops the bar still forming', () => {
  const now = Date.UTC(2026, 10, 15, 12);
  const c = [{ time: now - 2 * DAY }, { time: now - DAY - 1 }, { time: now - 3600 * 1000 }];
  assert.strictEqual(closedOnly(c, now).length, 2);
});
