const test = require('node:test');
const assert = require('node:assert');
const mt = require('../src/lib/metaapi');
const tg = require('../src/lib/telegram');
const store = require('../src/lib/redis');
const accounts = require('../src/services/accounts');
const autoTrader = require('../src/services/autoTrader');
const { fakeMetaApi, captureTelegram, resetEnv, DAY } = require('./helpers');

const T0 = Date.UTC(2026, 0, 1);
const NOW = T0 + 400 * DAY;

/** n flat days then (optionally) a breakout close on the last day. dir: 1 up, -1 down, 0 none */
function series(price, dir = 0, n = 120) {
  const w = price * 0.001;
  const c = [];
  for (let i = 0; i < n; i++) c.push({ time: T0 + i * DAY, open: price, high: price + w, low: price - w, close: price, spread: 10 });
  if (dir) {
    const last = c[n - 1];
    last.close = price + dir * 6 * w; last.high = Math.max(last.high, last.close); last.low = Math.min(last.low, last.close);
  }
  return c;
}

let f, sent;
async function setup({ symbols = 'EURUSD,GBPUSD,USDJPY', candles, equity = 10000, server = 'OctaFX-Demo', chatId = '111', auto = true, env = {} } = {}) {
  resetEnv({ FX_SYMBOLS: symbols, ...env });
  f = fakeMetaApi({ candles: candles || { EURUSD: series(1.1, 1), GBPUSD: series(1.3), USDJPY: series(150) }, equity });
  mt._setHttp(f.http);
  sent = captureTelegram(tg);
  await accounts.connect(chatId, { login: '12345678', password: 'pw123456', server });
  if (auto) await accounts.setAutotrade(chatId, true);
}

const opens = () => f.trades.filter(t => /^ORDER_TYPE_/.test(t.actionType));

test('opens the breakout with a server-side stop, sized to risk 1% of equity, and says why', async () => {
  await setup();
  const r = await autoTrader.runDaily({ now: NOW });
  assert.strictEqual(r.opened, 1);
  const o = opens()[0];
  assert.strictEqual(o.actionType, 'ORDER_TYPE_BUY');
  assert.strictEqual(o.symbol, 'EURUSD');
  assert.ok(o.stopLoss < 1.1, 'stop below the market');
  const entry = 1.1066 + 0.00005;
  const lossPerLot = ((entry - o.stopLoss) / 0.00001) * 1; // $1 per tick per lot
  const risk = o.volume * lossPerLot;
  const levCap = Math.floor((10000 * 5 / 4) / (entry / 0.00001) / 0.01) * 0.01; // total value ≤ 5× equity over 4 slots
  assert.ok(risk <= 100 + 1e-6, `risk ${risk} must not exceed 1%`);
  assert.ok(risk > 100 - lossPerLot * 0.01 - 1e-6 || Math.abs(o.volume - levCap) < 1e-9, `sized by risk or by the leverage cap (volume ${o.volume}, cap ${levCap})`);
  const msg = sent.find(m => m.chatId === '111' && /Opened/.test(m.text || ''));
  assert.ok(msg, 'user told about the trade');
  assert.match(msg.text, /Why: closed at .* above its highest price of the last 55 days/);
  assert.ok(sent.some(m => /daily run/.test(m.text || '') && /Signals: EURUSD BUY/.test(m.text)), 'admin summary');
});

test('acts once per daily candle; a forced re-run does not double up', async () => {
  await setup();
  await autoTrader.runDaily({ now: NOW });
  const again = await autoTrader.runDaily({ now: NOW });
  assert.match(again.skipped, /no new daily candle/);
  await autoTrader.runDaily({ now: NOW, force: true });
  assert.strictEqual(opens().length, 1);
});

test('trails the stop up after new candles, never down', async () => {
  await setup();
  await autoTrader.runDaily({ now: NOW });
  const pos = f.positions[0];
  pos.time = new Date(T0 + 119 * DAY).toISOString();
  const first = pos.stopLoss;
  // 25 more days climbing: the 20-day low rises
  const c = f.candles.EURUSD;
  for (let k = 1; k <= 25; k++) { const p = 1.107 + k * 0.001; c.push({ time: T0 + (119 + k) * DAY, open: p, high: p + 0.0011, low: p - 0.0011, close: p }); }
  pos.currentPrice = c[c.length - 1].close;
  await autoTrader.runDaily({ now: NOW + 30 * DAY });
  const mod = f.trades.find(t => t.actionType === 'POSITION_MODIFY');
  assert.ok(mod, 'stop modified');
  assert.ok(mod.stopLoss > first, `${mod.stopLoss} > ${first}`);
  // prices fall back: the stop must not move down
  const higher = pos.stopLoss;
  for (let k = 26; k <= 28; k++) { const p = 1.12; c.push({ time: T0 + (119 + k) * DAY, open: p, high: p + 0.0005, low: p - 0.0005, close: p }); }
  pos.currentPrice = 1.13;
  await autoTrader.runDaily({ now: NOW + 40 * DAY });
  assert.ok(f.positions[0].stopLoss >= higher);
});

test('a position closed by its stop is reported with its result in R', async () => {
  await setup();
  await autoTrader.runDaily({ now: NOW });
  const pos = f.positions.pop(); // the broker closed it at the stop
  f.deals[pos.id] = [{ profit: 0 }, { profit: -100, commission: -2, swap: 0 }];
  f.candles.EURUSD.push({ time: T0 + 120 * DAY, open: 1.1, high: 1.101, low: 1.09, close: 1.095 });
  await autoTrader.runDaily({ now: NOW + DAY });
  const msg = sent.find(m => /closed at its stop/.test(m.text || ''));
  assert.ok(msg);
  assert.match(msg.text, /−\$102\.00/);
  const st = await autoTrader.forwardStats('111');
  assert.strictEqual(st.closed, 1);
  assert.ok(st.avgR < -1 && st.avgR > -1.5, `avgR ${st.avgR}`);
});

test('real-money accounts are skipped while live trading is locked', async () => {
  await setup({ server: 'OctaFX-Real' });
  const r = await autoTrader.runDaily({ now: NOW });
  assert.strictEqual(r.lockedLive, 1);
  assert.strictEqual(opens().length, 0);
  await autoTrader.setFlag('live', true);
  await autoTrader.runDaily({ now: NOW, force: true });
  assert.strictEqual(opens().length, 1);
});

test('no more than 2 trades leaning the same way on one currency', async () => {
  await setup({ symbols: 'EURUSD,GBPUSD,AUDUSD', candles: { EURUSD: series(1.1, 1), GBPUSD: series(1.3, 1), AUDUSD: series(0.66, 1) } });
  await autoTrader.runDaily({ now: NOW });
  assert.strictEqual(opens().length, 2);
  assert.ok(sent.some(m => /same currency move/.test(m.text || '')));
});

test('a tiny account is told it is too small instead of over-risking', async () => {
  await setup({ equity: 20 });
  await autoTrader.runDaily({ now: NOW });
  assert.strictEqual(opens().length, 0);
  assert.ok(sent.some(m => /account too small/.test(m.text || '')));
});

test('pause stops new trades; dry run sends nothing to the broker', async () => {
  await setup();
  await autoTrader.setFlag('paused', true);
  await autoTrader.runDaily({ now: NOW });
  assert.strictEqual(opens().length, 0);
  await autoTrader.setFlag('paused', false);
  process.env.AUTOTRADE_DRY_RUN = 'true';
  await autoTrader.runDaily({ now: NOW, force: true });
  assert.strictEqual(f.trades.length, 0);
  assert.ok(sent.some(m => /dry run/.test(m.text || '')));
});

test('daily loss brake: no new trades after a 3% drop since yesterday', async () => {
  await setup();
  await store.cmd('SET', 'fx:lasteq:111', '10500');
  await autoTrader.runDaily({ now: NOW });
  assert.strictEqual(opens().length, 0);
  assert.ok(sent.some(m => /fell more than 3%/.test(m.text || '')));
});

test('sell signals open sells with the stop above the market', async () => {
  await setup({ candles: { EURUSD: series(1.1, -1), GBPUSD: series(1.3), USDJPY: series(150) } });
  await autoTrader.runDaily({ now: NOW });
  const o = opens()[0];
  assert.strictEqual(o.actionType, 'ORDER_TYPE_SELL');
  assert.ok(o.stopLoss > 1.1);
});

test('manual trades (other magic numbers) are never touched', async () => {
  await setup();
  f.positions.push({ id: 'manual1', type: 'POSITION_TYPE_BUY', symbol: 'EURUSD', magic: 0, volume: 1, openPrice: 1.1, currentPrice: 1.1, stopLoss: 0, time: new Date(T0).toISOString() });
  await autoTrader.runDaily({ now: NOW });
  assert.ok(!f.trades.some(t => t.positionId === 'manual1'));
  assert.strictEqual(opens().length, 1, 'the bot still opens its own EURUSD trade');
});

test('live gate lists what is missing', async () => {
  await setup();
  const g = await autoTrader.liveGate();
  assert.strictEqual(g.ok, false);
  assert.ok(g.reasons.some(r => /PASS/.test(r)));
  assert.ok(g.reasons.some(r => /56 days/.test(r)));
});
