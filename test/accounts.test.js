const test = require('node:test');
const assert = require('node:assert');
const mt = require('../src/lib/metaapi');
const store = require('../src/lib/redis');
const accounts = require('../src/services/accounts');
const { fakeMetaApi, resetEnv } = require('./helpers');

let f;
test.beforeEach(() => { resetEnv(); f = fakeMetaApi(); mt._setHttp(f.http); });

test('connect: immediate success stores the MetaApi account, never the password', async () => {
  const r = await accounts.connect('42', { login: '87654321', password: 'S3cret!', server: 'OctaFX-Demo' });
  assert.strictEqual(r.done, true);
  const a = await accounts.get('42');
  assert.strictEqual(a.login, '87654321');
  assert.strictEqual(a.region, 'london');
  assert.strictEqual(a.live, false);
  assert.strictEqual(a.autotrade, false, 'auto-trading starts off');
  assert.strictEqual(await accounts.hasPending('42'), false);
  const everything = JSON.stringify(await store.cmd('HGETALL', 'fx:acct:42'));
  assert.ok(!everything.includes('S3cret!'));
  assert.strictEqual(f.calls.find(c => c.method === 'POST').data.magic, 20261115);
});

test('connect: 202 keeps an encrypted password only until MetaApi answers', async () => {
  f.nextCreate.push({ status: 202 });
  const r = await accounts.connect('42', { login: '87654321', password: 'S3cret!', server: 'OctaFX-Demo' });
  assert.strictEqual(r.done, false);
  const pending = store.hashToObject(await store.cmd('HGETALL', 'fx:connect:42'));
  assert.ok(pending.pwd && !pending.pwd.includes('S3cret!'), 'stored encrypted');
  const notes = [];
  await accounts.retryPending(async (id, acct, err) => notes.push({ id, acct, err }));
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].acct.login, '87654321');
  assert.strictEqual(await accounts.hasPending('42'), false, 'password gone');
});

test('connect: wrong password → clear message and the stored password is deleted', async () => {
  f.nextCreate.push({ status: 400, message: 'Failed to authenticate', details: 'E_AUTH' });
  await assert.rejects(accounts.connect('42', { login: '87654321', password: 'nope', server: 'OctaFX-Demo' }), /couldn't log in/);
  assert.strictEqual(await accounts.hasPending('42'), false);
});

test('connect: input checks', async () => {
  await assert.rejects(accounts.connect('1', { login: 'abc', password: 'x1234', server: 'OctaFX-Demo' }), /digits/);
  await assert.rejects(accounts.connect('1', { login: '1234', password: 'x1234', server: '!' }), /server/);
});

test('real-money server names are detected', () => {
  assert.strictEqual(accounts.isLiveServer('OctaFX-Demo'), false);
  assert.strictEqual(accounts.isLiveServer('OctaFX-Real'), true);
  assert.strictEqual(accounts.isLiveServer('OctaFX-Real2'), true);
});

test('disconnect removes the account from MetaApi and the bot', async () => {
  await accounts.connect('42', { login: '87654321', password: 'S3cret!', server: 'OctaFX-Demo' });
  const id = (await accounts.get('42')).metaId;
  assert.ok(f.accounts[id]);
  await accounts.disconnect('42');
  assert.strictEqual(f.accounts[id], undefined);
  assert.strictEqual(await accounts.get('42'), null);
  assert.deepStrictEqual(await accounts.allChatIds(), []);
});

test('a stopped (UNDEPLOYED) account is started again by status and before trading', async () => {
  mt._setHttp(f.http, { fast: true });
  await accounts.connect('42', { login: '87654321', password: 'S3cret!', server: 'OctaFX-Demo' });
  const a = await accounts.get('42');
  Object.assign(f.accounts[a.metaId], { state: 'UNDEPLOYED', connectionStatus: 'DISCONNECTED' });
  const s = await accounts.status('42');
  assert.strictEqual(s.deployRequested, true);
  assert.strictEqual(f.accounts[a.metaId].state, 'DEPLOYED');
  Object.assign(f.accounts[a.metaId], { state: 'UNDEPLOYED', connectionStatus: 'DISCONNECTED' });
  const r = await mt.ensureDeployed(a.ref, { waitMs: 1000, pollMs: 1 });
  assert.strictEqual(r.ready, true);
  Object.assign(f.accounts[a.metaId], { state: 'UNDEPLOYING', connectionStatus: 'CONNECTED' });
  const r2 = await mt.ensureDeployed(a.ref, { waitMs: 0, pollMs: 1 });
  assert.strictEqual(r2.ready, false);
  assert.strictEqual(r2.state, 'UNDEPLOYING');
});
