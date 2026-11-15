/**
 * ─── Users' MetaTrader accounts ──────────────────────────────────────────────
 * fx:acct:{chatId}  HASH
 *   metaId, region   MetaApi account (MetaApi holds the MT5 password, not us)
 *   login, server    MT5 login number and broker server
 *   live             '0' demo, '1' real money (from the server name)
 *   autotrade        '1' on, '0' off (always off after connecting)
 *   connectedAt, lastError
 * fx:accts          SET of chat ids with an account
 * fx:connect:{chatId} HASH (15 min) — a connect still in progress. Holds the
 *   password ENCRYPTED only while MetaApi checks the account; deleted after.
 */

const store = require('../lib/redis');
const box = require('../lib/secretBox');
const mt = require('../lib/metaapi');
const cfg = require('../config');

const K = {
  acct: (id) => `fx:acct:${id}`,
  all: 'fx:accts',
  pending: (id) => `fx:connect:${id}`,
};
const PENDING_TTL = 15 * 60;

class AccountError extends Error {}

const isLiveServer = (server) => !/demo|practice|contest/i.test(String(server));

async function get(chatId) {
  const r = store.hashToObject(await store.cmd('HGETALL', K.acct(chatId)));
  if (!r.metaId) return null;
  return { ...r, chatId: String(chatId), live: r.live === '1', autotrade: r.autotrade === '1', ref: { id: r.metaId, region: r.region } };
}

async function allChatIds() {
  return (await store.cmd('SMEMBERS', K.all)) || [];
}

async function hasPending(chatId) {
  return (await store.cmd('EXISTS', K.pending(chatId))) === 1;
}

/**
 * Start connecting an MT5 account.
 * @returns {{done: boolean, account?: object, message: string}}
 */
async function connect(chatId, { login, password, server }) {
  if (!mt.isConfigured()) throw new AccountError('This bot is not linked to MetaApi yet (admin: set METAAPI_TOKEN).');
  if (!box.isConfigured()) throw new AccountError('This bot is not set up to add accounts yet (admin: set TRADING_ENCRYPTION_KEY).');
  login = String(login || '').trim();
  server = String(server || '').trim();
  password = String(password || '');
  if (!/^\d{4,12}$/.test(login)) throw new AccountError('The login should be your MT5 account number (digits only).');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\-]{2,60}$/.test(server)) throw new AccountError('That doesn\'t look like an MT5 server name (e.g. OctaFX-Demo).');
  if (password.length < 4 || password.length > 64) throw new AccountError('That doesn\'t look like an MT5 password.');
  if (await get(chatId)) throw new AccountError('You already have an account connected. Send `disconnect` first to switch.');

  await store.cmd('DEL', K.pending(chatId));
  await store.cmd('HSET', K.pending(chatId),
    'tx', mt.newTransactionId(), 'login', login, 'server', server,
    'pwd', box.encrypt(password), 'createdAt', new Date().toISOString(), 'tries', '0');
  await store.cmd('EXPIRE', K.pending(chatId), PENDING_TTL);
  return tryFinish(chatId);
}

/**
 * Ask MetaApi again for a connect in progress (same transaction id).
 * Deletes the stored password as soon as MetaApi gives a final answer.
 */
async function tryFinish(chatId) {
  const p = store.hashToObject(await store.cmd('HGETALL', K.pending(chatId)));
  if (!p.tx) return { done: false, gone: true, message: 'No connection in progress. Send `connect` again.' };
  let res;
  try {
    res = await mt.createAccount({
      login: p.login,
      password: box.decrypt(p.pwd),
      server: p.server,
      name: `JijazyFX ${chatId}`,
      platform: 'mt5',
      region: process.env.METAAPI_REGION || undefined,
      magic: cfg.MAGIC,
    }, p.tx);
  } catch (err) {
    if (err.status && err.status >= 400 && err.status < 500) {
      await store.cmd('DEL', K.pending(chatId)); // final answer: forget the password
      throw new AccountError(explainCreateError(err));
    }
    await store.cmd('HINCRBY', K.pending(chatId), 'tries', 1).catch(() => {});
    throw err; // temporary — the next retry may work
  }
  if (!res.done) {
    return { done: false, retryAfterSec: res.retryAfterSec, message: 'MetaApi is checking your account with the broker. This can take a minute or two — I\'ll message you when it\'s ready.' };
  }

  let region = null;
  try { region = (await mt.getAccount(res.id))?.region || null; } catch { /* read below */ }
  if (!region) region = process.env.METAAPI_REGION || 'new-york';
  await store.cmd('HSET', K.acct(chatId),
    'metaId', res.id, 'region', region, 'login', p.login, 'server', p.server,
    'live', isLiveServer(p.server) ? '1' : '0', 'autotrade', '0',
    'connectedAt', new Date().toISOString(), 'lastError', '');
  await store.cmd('SADD', K.all, String(chatId));
  await store.cmd('DEL', K.pending(chatId));
  if (res.state && res.state !== 'DEPLOYED') { try { await mt.deployAccount(res.id); } catch { /* status shows it */ } }
  return { done: true, account: await get(chatId), message: 'Connected.' };
}

function explainCreateError(err) {
  const d = JSON.stringify(err.details || '') + ' ' + err.message;
  if (/password|auth|invalid account|E_AUTH/i.test(d)) return 'MetaApi couldn\'t log in to that account. Check the login number, the password (use the MAIN password, not the investor one) and the server name, then try again.';
  if (/server|E_SRV_NOT_FOUND|broker/i.test(d)) return 'MetaApi couldn\'t find that server. Copy the server name exactly as your broker shows it (e.g. OctaFX-Demo).';
  if (/quota|limit|payment|top up|balance/i.test(d)) return 'The bot\'s MetaApi plan has no room for another account right now. The admin needs to top up MetaApi.';
  return `MetaApi refused the account: ${err.message}`;
}

/** Retry every connect in progress (run by the hourly job). */
async function retryPending(notify = async () => {}) {
  const keys = await store.keys('fx:connect:*');
  for (const key of keys) {
    const chatId = key.split(':').pop();
    try {
      const r = await tryFinish(chatId);
      if (r.done) await notify(chatId, r.account, null);
    } catch (err) {
      if (err instanceof AccountError) await notify(chatId, null, err.message);
    }
  }
}

/** MetaApi state + live balance (best effort). */
async function status(chatId) {
  const a = await get(chatId);
  if (!a) return null;
  const out = { ...a, state: null, connectionStatus: null, info: null };
  try { const m = await mt.getAccount(a.metaId); out.state = m.state; out.connectionStatus = m.connectionStatus; } catch (err) { out.error = err.message; }
  if (out.connectionStatus === 'CONNECTED') {
    try { out.info = await mt.accountInfo(a.ref); } catch (err) { out.error = err.message; }
  }
  return out;
}

async function setAutotrade(chatId, on) {
  await store.cmd('HSET', K.acct(chatId), 'autotrade', on ? '1' : '0');
}

async function setError(chatId, msg) {
  await store.cmd('HSET', K.acct(chatId), 'lastError', msg ? String(msg).slice(0, 300) : '');
}

/** Remove the account from MetaApi (stops its billing) and from the bot. */
async function disconnect(chatId) {
  const a = await get(chatId);
  await store.cmd('DEL', K.pending(chatId));
  if (!a) return false;
  await mt.deleteAccount(a.metaId);
  await store.pipeline([['DEL', K.acct(chatId)], ['SREM', K.all, String(chatId)]]);
  return true;
}

module.exports = { get, allChatIds, connect, tryFinish, retryPending, status, setAutotrade, setError, disconnect, hasPending, isLiveServer, AccountError, K };
