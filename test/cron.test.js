const test = require('node:test');
const assert = require('node:assert');
const mt = require('../src/lib/metaapi');
const tg = require('../src/lib/telegram');
const accounts = require('../src/services/accounts');
const labJob = require('../src/services/labJob');
const cron = require('../api/cron');
const health = require('../api/health');
const { fakeMetaApi, captureTelegram, resetEnv, makeCandles } = require('./helpers');

const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
let f, sent;
test.beforeEach(() => {
  resetEnv({ FX_SYMBOLS: 'EURUSD,GBPUSD,USDJPY', CRON_SECRET: 'k' });
  f = fakeMetaApi({ candles: { EURUSD: makeCandles({ n: 1200 }), GBPUSD: makeCandles({ n: 1200, seed: 2 }), USDJPY: makeCandles({ n: 1200, seed: 3, start: 150 }) } });
  mt._setHttp(f.http);
  sent = captureTelegram(tg);
});

test('cron needs the key', async () => {
  const r = res();
  await cron({ query: {}, headers: {} }, r);
  assert.strictEqual(r.code, 401);
});

test('cron finishes a connect that MetaApi was still checking, then runs the daily check', async () => {
  f.nextCreate.push({ status: 202 });
  await accounts.connect('111', { login: '12345678', password: 'pw123456', server: 'OctaFX-Demo' });
  const r = res();
  await cron({ query: { key: 'k' }, headers: {} }, r);
  assert.strictEqual(r.code, 200);
  assert.ok(await accounts.get('111'));
  assert.ok(sent.some(m => m.chatId === '111' && /is connected/.test(m.text || '')));
  assert.ok(r.body.daily.barDate, JSON.stringify(r.body.daily));
});

test('lab job resumes across steps when time runs out', async () => {
  await accounts.connect('111', { login: '12345678', password: 'pw123456', server: 'OctaFX-Demo' });
  await labJob.start('111');
  let t = 0;
  const clock = () => (t += 30000); // every symbol "takes" 30 s
  const s1 = await labJob.step({ now: clock, selfCall: false });
  assert.strictEqual(s1.finished, false);
  assert.match(s1.progress, /\/3$/);
  let s = s1;
  for (let k = 0; k < 5 && !s.finished; k++) { t = 0; s = await labJob.step({ now: clock, selfCall: false }); }
  assert.strictEqual(s.finished, true);
  assert.ok(s.result.families.length >= 3);
  assert.ok(sent.some(m => /Strategy lab/.test(m.text || '')));
});

test('health lists missing settings', async () => {
  delete process.env.METAAPI_TOKEN;
  const r = res();
  await health({ query: { key: 'k' }, headers: {} }, r);
  assert.ok(r.body.missing.includes('METAAPI_TOKEN'));
});

test('lab with wrong symbol names explains why there is no data', async () => {
  process.env.FX_SYMBOLS = 'EURUSDX,GBPUSDX';
  await accounts.connect('111', { login: '12345678', password: 'pw123456', server: 'OctaFX-Demo' });
  await labJob.start('111');
  const s = await labJob.step({ selfCall: false });
  assert.strictEqual(s.finished, true);
  const msg = sent.find(m => /Lab failed/.test(m.text || ''));
  assert.match(msg.text, /EURUSDX: only 0 days/);
  assert.match(msg.text, /FX_SYMBOLS/);
});
