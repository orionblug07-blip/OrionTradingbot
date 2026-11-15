/**
 * ─── Strategy lab ────────────────────────────────────────────────────────────
 * Is there a strategy worth trading? Answered the honest way:
 *
 *  1. Download years of daily candles for every symbol (from MetaApi, i.e. the
 *     broker's own prices).
 *  2. Split time: the first 65% is for CHOOSING, the last 35% is for JUDGING.
 *  3. For each strategy family, try every setting on the first part and keep
 *     the one with the best average result per trade (at least 30 trades).
 *  4. Run that one setting ONCE on the unseen last part.
 *  5. PASS only if it made money after costs there AND the whole 95% range of
 *     its average result is above zero (so it is unlikely to be luck), with at
 *     least 30 trades.
 *
 * Real-money trading can only be unlocked for a strategy that PASSED.
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/redis');
const mt = require('../lib/metaapi');
const cfg = require('../config');
const { FAMILIES, prepare, strategyId } = require('../strategies/fx');
const { simulate, stats, portfolio } = require('./backtest');

const RESULT_KEY = 'fx:lab:result';
const TRAIN_FRAC = 0.65;
const MIN_TRADES = 30;
const SLIPPAGE_PIPS = 0.2; // per side

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Round-trip cost in price units: the larger of the broker's candle spread (+ slippage) and our cautious table. */
function costFor(symbol, candles, tickSize) {
  const pip = cfg.pipSize(symbol);
  const fallback = (cfg.FALLBACK_COST_PIPS[symbol.toUpperCase()] ?? cfg.DEFAULT_COST_PIPS) * pip;
  const sp = median(candles.map(c => c.spread));
  const fromCandles = sp != null && tickSize ? sp * tickSize + 2 * SLIPPAGE_PIPS * pip : 0;
  return Math.max(fallback, fromCandles);
}

/** Download candles + costs for the universe. */
async function loadData(acct, symbols = cfg.symbols(), bars = 3000, log = () => {}) {
  const data = {};
  for (const symbol of symbols) {
    try {
      const candles = closedOnly(await mt.history(acct, symbol, '1d', bars));
      let tickSize = null;
      try { tickSize = (await mt.specification(acct, symbol))?.tickSize || null; } catch { /* spread table is the fallback */ }
      if (candles.length < 400) { log(`${symbol}: only ${candles.length} days of history — skipped`); continue; }
      data[symbol] = { candles, cost: costFor(symbol, candles, tickSize) };
      log(`${symbol}: ${candles.length} days, cost ${(data[symbol].cost / cfg.pipSize(symbol)).toFixed(1)} pips`);
    } catch (err) {
      log(`${symbol}: ${err.message}`);
    }
  }
  return data;
}

/** Drop the bar that is still forming (a daily bar is closed 24h after it opened). */
function closedOnly(candles, now = Date.now()) {
  return candles.filter(c => c.time + 24 * 3600 * 1000 <= now);
}

function verdictOf(test) {
  if (!test.trades || test.trades < MIN_TRADES) return { verdict: 'TOO FEW TRADES', why: `only ${test.trades || 0} trades on unseen data (need ${MIN_TRADES})` };
  if (test.range95[0] > 0) return { verdict: 'PASS', why: 'made money after costs on data it never saw, and the result is unlikely to be luck' };
  if (test.expectancyR > 0) return { verdict: 'NOT PROVEN', why: 'made a little on unseen data, but the result could easily be luck' };
  return { verdict: 'FAIL', why: 'lost money after costs on unseen data' };
}

/**
 * Pure: run the lab on already-loaded data.
 * @param {Object<string,{candles: Array, cost: number}>} data
 */
function runLab(data, { trainFrac = TRAIN_FRAC } = {}) {
  const symbols = Object.keys(data);
  if (!symbols.length) throw new Error('No price data to test');
  const times = [...new Set(symbols.flatMap(s => data[s].candles.map(c => c.time)))].sort((a, b) => a - b);
  const split = times[Math.floor(times.length * trainFrac)];
  const inds = Object.fromEntries(symbols.map(s => [s, prepare(data[s].candles)]));

  const families = [];
  for (const [family, fam] of Object.entries(FAMILIES)) {
    const variants = fam.grid().map(params => {
      const all = symbols.flatMap(s => simulate(data[s].candles, family, params, { cost: data[s].cost, symbol: s, ind: inds[s] }));
      const train = all.filter(t => t.signalTime < split);
      const test = all.filter(t => t.signalTime >= split);
      return { params, train, test, trainStats: stats(train) };
    });
    const eligible = variants.filter(v => v.trainStats.trades >= MIN_TRADES);
    const pool = eligible.length ? eligible : variants;
    const best = pool.reduce((a, b) => ((b.trainStats.expectancyR ?? -Infinity) > (a.trainStats.expectancyR ?? -Infinity) ? b : a));
    const testStats = stats(best.test);
    families.push({
      family,
      name: fam.name,
      chosen: { id: strategyId(family, best.params), params: best.params, label: fam.describe(best.params) },
      train: best.trainStats,
      test: testStats,
      portfolioTest: portfolio(best.test, { riskPct: cfg.LIMITS.riskPct, maxOpen: cfg.LIMITS.maxOpen }),
      variantsTried: variants.length,
      ...verdictOf(testStats),
    });
  }

  // Pick the strategy to run: among PASSes, the best on the CHOOSING period
  // (picking by the judging period would quietly re-introduce luck).
  const byTrain = (a, b) => (b.train.expectancyR ?? -Infinity) - (a.train.expectancyR ?? -Infinity);
  const passed = families.filter(f => f.verdict === 'PASS').sort(byTrain);
  const pick = passed[0] || [...families].sort(byTrain)[0];

  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return {
    generatedAt: new Date().toISOString(),
    rules: { entry: 'next daily open', stops: 'on the server; gaps fill at the open', trainFrac, minTrades: MIN_TRADES, swaps: 'none (swap-free account)' },
    universe: symbols,
    costsPips: Object.fromEntries(symbols.map(s => [s, Math.round((data[s].cost / cfg.pipSize(s)) * 10) / 10])),
    period: { from: iso(times[0]), split: iso(split), to: iso(times[times.length - 1]) },
    families,
    chosen: { family: pick.family, params: pick.chosen.params, id: pick.chosen.id, label: pick.chosen.label, verdict: pick.verdict },
  };
}

async function saveResult(result) {
  await store.setJSON(RESULT_KEY, result);
}

/** Latest lab result: Redis (lab run from Telegram) → data file (lab run locally) → null. */
async function latestResult() {
  try { const r = await store.getJSON(RESULT_KEY); if (r) return r; } catch { /* fall through */ }
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), cfg.STRATEGY_FILE), 'utf8')); } catch { return null; }
}

/** The strategy the auto-trader runs, with its verdict. */
async function activeStrategy() {
  const r = await latestResult();
  if (r && r.chosen && FAMILIES[r.chosen.family]) return { ...r.chosen, testedAt: r.generatedAt };
  const f = cfg.FALLBACK_STRATEGY;
  return { ...f, label: FAMILIES[f.family].describe(f.params), verdict: 'NOT TESTED', testedAt: null };
}

/** Short text summary for Telegram. */
function summary(r) {
  if (!r) return 'No lab result yet. Admin: send `lab run`.';
  const lines = [`🧪 *Strategy lab* (${r.period.from} → ${r.period.to})`, `Chose settings on data up to ${r.period.split}, judged on the rest.`, ''];
  const icon = { PASS: '✅', 'NOT PROVEN': '🟡', FAIL: '❌', 'TOO FEW TRADES': '⚪' };
  for (const f of r.families) {
    const t = f.test;
    lines.push(`${icon[f.verdict] || '•'} *${f.name}* — ${f.verdict}`);
    lines.push(`   ${f.chosen.label}`);
    if (t.trades) lines.push(`   Unseen data: ${t.trades} trades · ${t.winRatePct}% wins · avg ${t.expectancyR > 0 ? '+' : ''}${t.expectancyR}R (likely ${t.range95[0]} to ${t.range95[1]})`);
    if (f.portfolioTest?.taken) lines.push(`   At ${cfg.LIMITS.riskPct}% risk: ${f.portfolioTest.returnPct > 0 ? '+' : ''}${f.portfolioTest.returnPct}%, worst drop ${f.portfolioTest.maxDrawdownPct}%`);
  }
  lines.push('', `▶️ In use: *${r.chosen.label}* (${r.chosen.verdict})`);
  if (r.chosen.verdict !== 'PASS') lines.push('Nothing passed, so real-money trading stays locked. Demo trading continues as a forward test.');
  lines.push('_Past results are not a promise._');
  return lines.join('\n');
}

module.exports = { runLab, loadData, closedOnly, costFor, saveResult, latestResult, activeStrategy, summary, verdictOf, RESULT_KEY };
