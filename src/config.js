/**
 * ─── All trading settings in one place ───────────────────────────────────────
 * Symbols, safety limits and what it takes to unlock real-money trading.
 */

const DEFAULT_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'XAUUSD'];

function symbols() {
  const env = (process.env.FX_SYMBOLS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_SYMBOLS;
}

/**
 * Size of one "pip" for messages and the fallback spread table.
 * JPY pairs: 0.01. Gold: 0.1 ($0.10). Everything else: 0.0001.
 */
function pipSize(symbol) {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.01;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

/**
 * Typical round-trip cost in pips (spread + a little slippage) used by the lab
 * when the broker's candles carry no spread. Deliberately on the high side of
 * Octa's published averages, so the test is not flattering.
 */
const FALLBACK_COST_PIPS = {
  EURUSD: 1.2, GBPUSD: 1.6, USDJPY: 1.5, AUDUSD: 1.4, USDCAD: 2.0,
  USDCHF: 2.0, NZDUSD: 2.0, XAUUSD: 4.0, // gold: $0.40
};
const DEFAULT_COST_PIPS = 2.5;

module.exports = {
  symbols,
  pipSize,
  FALLBACK_COST_PIPS,
  DEFAULT_COST_PIPS,

  // Every order the bot sends carries this magic number, so it never touches
  // trades the user places by hand.
  MAGIC: 20261115,
  COMMENT: 'JijazyFX',

  // Safety limits (demo AND real)
  LIMITS: {
    riskPct: 1,          // % of equity lost if a trade hits its first stop
    maxOpen: 4,          // at most this many bot positions at once
    maxPerCurrency: 2,   // e.g. at most 2 positions that are long USD
    maxLeverage: 5,      // total position value ≤ 5 × equity
    dailyLossPct: 3,     // equity fell this much since yesterday → no new trades today
  },

  // What real-money trading needs before the admin can unlock it
  GATE: {
    researchVerdict: 'PASS', // from the lab
    forwardDays: 56,         // the admin's demo account has auto-traded 8+ weeks
    forwardTrades: 20,       // with at least 20 closed trades
    forwardProfit: true,     // and made money after costs
  },

  // Fallback strategy if no lab result exists yet. It can run on DEMO only:
  // without a PASS verdict real money stays locked.
  FALLBACK_STRATEGY: { family: 'donchian', params: { entryN: 55, exitN: 20 }, id: 'donchian:55-20' },
  STRATEGY_FILE: 'data/fx-strategy.json',

  LIVE_CONFIRM: 'I UNDERSTAND REAL MONEY',
};
