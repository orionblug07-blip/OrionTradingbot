const test = require('node:test');
const assert = require('node:assert');
const mt = require('../src/lib/metaapi');
const { fakeMetaApi, resetEnv, makeCandles } = require('./helpers');

test.beforeEach(() => resetEnv());

test('client URLs use the account region and the resolved domain; token in auth-token header', async () => {
  const f = fakeMetaApi();
  mt._setHttp(f.http);
  await mt.accountInfo({ id: 'abc', region: 'london' });
  const call = f.calls.find(c => c.url.endsWith('/account-information'));
  assert.strictEqual(call.url, 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/abc/account-information');
  assert.strictEqual(call.headers['auth-token'], 'test-token');
});

test('createAccount: 202 → retry later with the same transaction id; 201 → id', async () => {
  const f = fakeMetaApi();
  f.nextCreate.push({ status: 202 });
  mt._setHttp(f.http);
  const tx = mt.newTransactionId();
  assert.strictEqual(tx.length, 32);
  const a = await mt.createAccount({ login: '123', password: 'p', server: 'OctaFX-Demo', name: 'n', magic: 1 }, tx);
  assert.deepStrictEqual([a.done, a.retryAfterSec], [false, 5]);
  const b = await mt.createAccount({ login: '123', password: 'p', server: 'OctaFX-Demo', name: 'n', magic: 1 }, tx);
  assert.strictEqual(b.done, true);
  const posts = f.calls.filter(c => c.method === 'POST');
  assert.ok(posts.every(p => p.headers['transaction-id'] === tx));
  assert.strictEqual(posts[0].data.platform, 'mt5');
  assert.strictEqual(posts[0].data.login, '123');
});

test('trade: throws unless MetaTrader accepted it', async () => {
  const f = fakeMetaApi({ candles: { EURUSD: makeCandles({ n: 5 }) } });
  f.rejectNext = true;
  mt._setHttp(f.http);
  await assert.rejects(mt.trade({ id: 'a', region: 'london' }, { actionType: 'ORDER_TYPE_BUY', symbol: 'EURUSD', volume: 0.01 }), /rejected/);
  const ok = await mt.trade({ id: 'a', region: 'london' }, { actionType: 'ORDER_TYPE_BUY', symbol: 'EURUSD', volume: 0.01 });
  assert.strictEqual(ok.stringCode, 'TRADE_RETCODE_DONE');
});

test('history pages backwards past 1000 candles, oldest first, no duplicates', async () => {
  const candles = makeCandles({ n: 2500 });
  const f = fakeMetaApi({ candles: { EURUSD: candles } });
  mt._setHttp(f.http);
  const h = await mt.history({ id: 'a', region: 'london' }, 'EURUSD', '1d', 2300);
  assert.strictEqual(h.length, 2300);
  assert.strictEqual(h[h.length - 1].time, candles[candles.length - 1].time);
  for (let i = 1; i < h.length; i++) assert.ok(h[i].time > h[i - 1].time);
});

test('HTTP errors become MetaApiError with the status', async () => {
  mt._setHttp(async () => ({ status: 401, data: { error: 'UnauthorizedError', message: 'bad token' }, headers: {} }));
  await assert.rejects(mt.getAccount('x'), (e) => e instanceof mt.MetaApiError && e.status === 401 && /bad token/.test(e.message));
});

test('missing token is a clear error', async () => {
  delete process.env.METAAPI_TOKEN;
  await assert.rejects(mt.getAccount('x'), /METAAPI_TOKEN/);
});
