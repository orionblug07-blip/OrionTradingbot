const test = require('node:test');
const assert = require('node:assert');
const mt = require('../src/lib/metaapi');
const tg = require('../src/lib/telegram');
const store = require('../src/lib/redis');
const accounts = require('../src/services/accounts');
const autoTrader = require('../src/services/autoTrader');
const labJob = require('../src/services/labJob');
const { route, handleUpdate } = require('../src/bot/commands');
const webhook = require('../api/telegram-webhook');
const { fakeMetaApi, captureTelegram, resetEnv, makeCandles } = require('./helpers');

let f, sent;
test.beforeEach(() => {
  resetEnv({ FX_SYMBOLS: 'EURUSD,GBPUSD' });
  f = fakeMetaApi({ candles: { EURUSD: makeCandles({ n: 3000, seed: 1, regime: 100, drift: 0.001 }), GBPUSD: makeCandles({ n: 3000, seed: 2, start: 1.3, regime: 100, drift: 0.001 }) } });
  mt._setHttp(f.http);
  sent = captureTelegram(tg);
});
const texts = (chatId) => sent.filter(m => m.chatId === String(chatId)).map(m => m.text).join('\n---\n');

test('new users ask the admin for access; approve lets them in', async () => {
  await route('500', 'start', { first_name: 'Ada', username: 'ada' }, 1);
  assert.match(texts('500'), /access request has been sent/);
  const req = sent.find(m => m.chatId === '111');
  assert.match(req.text, /Ada @ada \(id 500\)/);
  assert.strictEqual(req.opts.markup.inline_keyboard[0][0].callback_data, 'approve 500');
  await route('111', 'approve 500', {}, 2);
  assert.match(texts('500'), /approved/);
  await route('500', 'status', {}, 3);
  assert.match(texts('500'), /Connect your MT5 account/);
});

test('connect deletes the password message first, then connects', async () => {
  await route('111', 'connect 12345678 Pa55word OctaFX-Demo', {}, 77);
  const del = sent.find(m => m.method === 'deleteMessage');
  assert.deepStrictEqual(del.payload, { chat_id: '111', message_id: 77 });
  assert.ok(sent.indexOf(del) < sent.findIndex(m => m.text), 'deleted before any reply');
  assert.match(texts('111'), /Connected/);
  assert.ok(!JSON.stringify(sent).includes('Pa55word'), 'password never echoed');
  assert.strictEqual(f.calls.find(c => c.method === 'POST').data.password, 'Pa55word', 'case preserved');
});

test('connect even deletes the message of a user who is not approved yet', async () => {
  await route('600', 'connect 12345678 Pa55word OctaFX-Demo', {}, 9);
  assert.ok(sent.some(m => m.method === 'deleteMessage' && m.payload.chat_id === '600'));
  assert.strictEqual(await accounts.get('600'), null);
});

test('auto on: demo switches on; real money needs the unlock AND the confirmation phrase', async () => {
  await route('111', 'connect 12345678 Pa55word OctaFX-Demo', {}, 1);
  await route('111', 'auto on', {}, 2);
  assert.strictEqual((await accounts.get('111')).autotrade, true);
  await route('111', 'disconnect confirm', {}, 3);

  await route('111', 'connect 12345678 Pa55word OctaFX-Real', {}, 4);
  await route('111', 'auto on', {}, 5);
  assert.match(texts('111'), /locked/);
  assert.strictEqual((await accounts.get('111')).autotrade, false);
  await autoTrader.setFlag('live', true);
  await route('111', 'auto on', {}, 6);
  assert.match(texts('111'), /I UNDERSTAND REAL MONEY/);
  assert.strictEqual((await accounts.get('111')).autotrade, false);
  await route('111', 'auto on I UNDERSTAND REAL MONEY', {}, 7);
  assert.strictEqual((await accounts.get('111')).autotrade, true);
});

test('status shows balance; positions mark bot vs manual trades', async () => {
  await route('111', 'connect 12345678 Pa55word OctaFX-Demo', {}, 1);
  await route('111', 'status', {}, 2);
  assert.match(texts('111'), /Equity \$10000\.00/);
  f.positions.push({ id: '1', type: 'POSITION_TYPE_BUY', symbol: 'EURUSD', magic: 20261115, volume: 0.1, openPrice: 1.1, currentPrice: 1.11, stopLoss: 1.09, profit: 100 });
  f.positions.push({ id: '2', type: 'POSITION_TYPE_SELL', symbol: 'GBPUSD', magic: 0, volume: 0.2, openPrice: 1.3, currentPrice: 1.29, stopLoss: 0, profit: 200 });
  await route('111', 'positions', {}, 3);
  assert.match(texts('111'), /🤖 EURUSD BUY 0\.1/);
  assert.match(texts('111'), /👤 GBPUSD SELL 0\.2 .* stop none/);
});

test('close all closes only the bot\'s trades', async () => {
  await route('111', 'connect 12345678 Pa55word OctaFX-Demo', {}, 1);
  f.positions.push({ id: '1', type: 'POSITION_TYPE_BUY', symbol: 'EURUSD', magic: 20261115, volume: 0.1, profit: 5 });
  f.positions.push({ id: '2', type: 'POSITION_TYPE_BUY', symbol: 'GBPUSD', magic: 0, volume: 0.1, profit: 5 });
  await route('111', 'close all', {}, 2);
  assert.deepStrictEqual(f.positions.map(p => p.id), ['2']);
});

test('admin-only commands are refused to normal users', async () => {
  await route('111', 'approve 700', {}, 1);
  await route('700', 'unlock live', {}, 2);
  assert.match(texts('700'), /didn't understand/);
  assert.strictEqual((await autoTrader.flags()).live, false);
});

test('unlock live is refused until the gate is met', async () => {
  await route('111', 'unlock live', {}, 1);
  assert.match(texts('111'), /Can't unlock yet/);
  assert.strictEqual((await autoTrader.flags()).live, false);
});

test('lab run (off Vercel) downloads, tests and reports to the admin', async () => {
  await route('111', 'connect 12345678 Pa55word OctaFX-Demo', {}, 1);
  await route('111', 'lab run', {}, 2);
  assert.match(texts('111'), /Strategy lab/);
  const j = await labJob.job();
  assert.strictEqual(j.status, 'done');
  assert.ok(await store.getJSON('fx:lab:result'));
  await route('111', 'strategy', {}, 3);
  assert.match(texts('111'), /In use/);
});

test('button taps are routed like typed commands', async () => {
  await handleUpdate({ callback_query: { id: 'q', data: 'help', message: { chat: { id: 111 } }, from: {} } });
  assert.match(texts('111'), /JijazyFX/);
});

test('webhook: rejects a wrong secret and ignores duplicate updates', async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3';
  const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const bad = res();
  await webhook({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, body: {} }, bad);
  assert.strictEqual(bad.code, 401);
  const upd = { update_id: 5, message: { message_id: 1, text: 'help', chat: { id: 111, type: 'private' }, from: {} } };
  const r1 = res(); await webhook({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3' }, body: upd }, r1);
  const r2 = res(); await webhook({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3' }, body: upd }, r2);
  assert.strictEqual(r2.body.duplicate, true);
  assert.strictEqual(sent.filter(m => m.chatId === '111').length, 1);
});
