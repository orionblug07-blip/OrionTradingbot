/**
 * ─── MetaApi REST client (MetaTrader 4/5 in the cloud) ──────────────────────
 * The only file that talks to MetaApi. Every call needs METAAPI_TOKEN.
 *
 *  Provisioning (add / remove MT accounts):
 *    https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai
 *  Trading + account state (per region):
 *    https://mt-client-api-v1.{region}.{domain}
 *  Historical candles (per region):
 *    https://mt-market-data-client-api-v1.{region}.{domain}
 *
 * {domain} comes from /users/current/servers/mt-client-api (cached 10 min),
 * {region} from the account itself (london / new-york / singapore …).
 *
 * An "acct" argument is { id, region } — what we store for each user.
 */

const axios = require('axios');
const crypto = require('crypto');

const PROVISIONING = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const DEFAULT_DOMAIN = 'agiliumtrade.ai';

class MetaApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let http = (cfg) => axios(cfg); // replaced in tests
function _setHttp(fn, { fast = false } = {}) { http = fn; domainCache = null; sleep = fast ? async () => {} : realSleep; }

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));
let sleep = realSleep;
const token = () => process.env.METAAPI_TOKEN || '';
const isConfigured = () => !!token();

/** One HTTP call with auth, retrying 429 / 5xx / network errors twice. */
async function request(method, url, { data, params, headers = {}, timeout = 20000, retries = 2 } = {}) {
  if (!isConfigured()) throw new MetaApiError('METAAPI_TOKEN is not set');
  let attempt = 0;
  for (;;) {
    try {
      const resp = await http({
        method, url, data, params, timeout,
        headers: { 'auth-token': token(), Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
        validateStatus: () => true,
      });
      const s = resp.status;
      if (s >= 200 && s < 300) return { status: s, data: resp.data, headers: resp.headers || {} };
      const retryable = s === 429 || s >= 500;
      if (retryable && attempt < retries) {
        const ra = Number(resp.headers?.['retry-after']);
        await sleep(Math.min(8000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt));
        attempt++;
        continue;
      }
      const body = resp.data || {};
      throw new MetaApiError(body.message || `MetaApi HTTP ${s}`, { status: s, code: body.error, details: body.details });
    } catch (err) {
      if (err instanceof MetaApiError) throw err;
      const net = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(err.code);
      if (net && attempt < retries) { await sleep(1000 * 2 ** attempt); attempt++; continue; }
      throw new MetaApiError(`MetaApi unreachable: ${err.message}`);
    }
  }
}

// ─── Region hosts ────────────────────────────────────────────────────────────
let domainCache = null;
async function domain() {
  if (domainCache && domainCache.at > Date.now() - 10 * 60 * 1000) return domainCache.domain;
  try {
    const { data } = await request('GET', `${PROVISIONING}/users/current/servers/mt-client-api`, { retries: 1 });
    domainCache = { domain: data?.domain || DEFAULT_DOMAIN, at: Date.now() };
  } catch {
    domainCache = { domain: DEFAULT_DOMAIN, at: Date.now() };
  }
  return domainCache.domain;
}

function requireAcct(acct) {
  if (!acct || !acct.id || !acct.region) throw new MetaApiError('MetaApi account id/region missing — reconnect the account');
}
async function clientBase(acct) { requireAcct(acct); return `https://mt-client-api-v1.${acct.region}.${await domain()}/users/current/accounts/${acct.id}`; }
async function marketBase(acct) { requireAcct(acct); return `https://mt-market-data-client-api-v1.${acct.region}.${await domain()}/users/current/accounts/${acct.id}`; }

// ─── Provisioning: add / read / remove MetaTrader accounts ──────────────────
const newTransactionId = () => crypto.randomBytes(16).toString('hex'); // 32 chars

/**
 * Add an MT account to MetaApi. MetaApi may answer 202 ("still detecting the
 * broker's settings, retry later") — call again with the SAME transactionId.
 * @returns {{done: true, id: string, state: string} | {done: false, retryAfterSec: number, message: string}}
 */
async function createAccount({ login, password, server, name, platform = 'mt5', region, magic }, transactionId) {
  const data = {
    name, login: String(login), password, server, platform,
    magic: Number(magic) || 0,
    type: 'cloud-g2',
    reliability: 'regular', // cheaper; 'high' adds a standby copy
    keywords: [String(server).split(/[-\s]/)[0]],
  };
  if (region) data.region = region;
  const r = await request('POST', `${PROVISIONING}/users/current/accounts`, {
    data, headers: { 'transaction-id': transactionId }, timeout: 30000, retries: 1,
  });
  if (r.status === 202) {
    const ra = r.headers['retry-after'];
    let sec = Number(ra);
    if (!Number.isFinite(sec)) { const t = Date.parse(ra); sec = Number.isFinite(t) ? Math.max(5, Math.round((t - Date.now()) / 1000)) : 30; }
    return { done: false, retryAfterSec: sec, message: r.data?.message || 'MetaApi is still checking the account' };
  }
  return { done: true, id: r.data.id, state: r.data.state };
}

async function getAccount(id) {
  return (await request('GET', `${PROVISIONING}/users/current/accounts/${id}`)).data;
}
async function deployAccount(id) {
  await request('POST', `${PROVISIONING}/users/current/accounts/${id}/deploy`);
}
async function deleteAccount(id) {
  try { await request('DELETE', `${PROVISIONING}/users/current/accounts/${id}`); }
  catch (err) { if (err.status !== 404) throw err; }
}

/**
 * Make sure the account is running in MetaApi's cloud. Deploys an UNDEPLOYED
 * account and waits (up to waitMs) until it is DEPLOYED and CONNECTED.
 * @returns {{ready: boolean, state: string, connectionStatus: string}}
 */
async function ensureDeployed(acct, { waitMs = 20000, pollMs = 4000 } = {}) {
  requireAcct(acct);
  let a = await getAccount(acct.id);
  if (a.state === 'UNDEPLOYED' || a.state === 'DEPLOY_FAILED') {
    await deployAccount(acct.id);
  }
  const until = Date.now() + waitMs;
  for (;;) {
    if (a.state === 'DEPLOYED' && a.connectionStatus === 'CONNECTED') return { ready: true, state: a.state, connectionStatus: a.connectionStatus };
    if (Date.now() >= until) return { ready: false, state: a.state, connectionStatus: a.connectionStatus };
    await sleep(pollMs);
    a = await getAccount(acct.id);
    if (a.state === 'UNDEPLOYED') await deployAccount(acct.id); // it finished undeploying — start it again
  }
}

// ─── Account state ───────────────────────────────────────────────────────────
/** { platform, broker, currency, server, balance, equity, margin, freeMargin, leverage, marginLevel, tradeAllowed, investorMode, name, login } */
async function accountInfo(acct) {
  return (await request('GET', `${await clientBase(acct)}/account-information`)).data;
}
/** Open positions: [{ id, type: POSITION_TYPE_BUY|SELL, symbol, magic, openPrice, currentPrice, stopLoss, takeProfit, volume, profit, swap, commission, time, comment, clientId }] */
async function positions(acct) {
  return (await request('GET', `${await clientBase(acct)}/positions`)).data || [];
}
/** { symbol, bid, ask, profitTickValue, lossTickValue, time } — tick values are per 1 lot, in account currency */
async function price(acct, symbol) {
  return (await request('GET', `${await clientBase(acct)}/symbols/${encodeURIComponent(symbol)}/current-price`)).data;
}
/** { symbol, tickSize, minVolume, maxVolume, volumeStep, contractSize, digits, tradeMode, ... } */
async function specification(acct, symbol) {
  return (await request('GET', `${await clientBase(acct)}/symbols/${encodeURIComponent(symbol)}/specification`)).data;
}

/** Deals of one position (to learn how a closed trade ended): [{ type, entryType, profit, commission, swap, price, time }] */
async function dealsByPosition(acct, positionId) {
  const { data } = await request('GET', `${await clientBase(acct)}/history-deals/position/${encodeURIComponent(positionId)}`);
  return Array.isArray(data) ? data : (data?.deals || []);
}

// ─── Trading ─────────────────────────────────────────────────────────────────
const OK_CODES = new Set([10008, 10009, 10010]); // placed / done / partial done

/** Send a trade request. Throws MetaApiError unless MetaTrader accepted it. */
async function trade(acct, body) {
  const { data } = await request('POST', `${await clientBase(acct)}/trade`, { data: body, retries: 0, timeout: 30000 });
  if (!data || !OK_CODES.has(Number(data.numericCode))) {
    throw new MetaApiError(`Trade rejected: ${data?.message || 'unknown'} (${data?.stringCode || data?.numericCode})`, { code: data?.stringCode, details: data });
  }
  return data;
}

// ─── Historical candles ─────────────────────────────────────────────────────
/**
 * Up to 1000 candles ending at startTime (MetaApi loads backwards in time).
 * Returns oldest → newest: [{ time (ms), open, high, low, close, spread, tickVolume }]
 */
async function candles(acct, symbol, timeframe = '1d', { startTime, limit = 1000 } = {}) {
  const params = { limit };
  if (startTime) params.startTime = new Date(startTime).toISOString();
  const { data } = await request('GET', `${await marketBase(acct)}/historical-market-data/symbols/${encodeURIComponent(symbol)}/timeframes/${timeframe}/candles`, { params, timeout: 30000 });
  return (data || [])
    .map(c => ({ time: Date.parse(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close, spread: c.spread == null ? null : +c.spread, tickVolume: c.tickVolume }))
    .filter(c => Number.isFinite(c.time) && c.high > 0)
    .sort((a, b) => a.time - b.time);
}

/** Page backwards until `bars` candles (or the broker's history runs out). */
async function history(acct, symbol, timeframe = '1d', bars = 3000) {
  let out = [];
  let startTime = null;
  for (let guard = 0; out.length < bars && guard < 20; guard++) {
    const page = await candles(acct, symbol, timeframe, { startTime, limit: 1000 });
    const older = out.length ? page.filter(c => c.time < out[0].time) : page;
    if (!older.length) break;
    out = older.concat(out);
    startTime = older[0].time - 1;
    if (page.length < 1000) break;
  }
  return out.slice(-bars);
}

module.exports = {
  MetaApiError, isConfigured, newTransactionId,
  createAccount, getAccount, deployAccount, deleteAccount, ensureDeployed,
  accountInfo, positions, price, specification, dealsByPosition, trade,
  candles, history,
  _setHttp,
};
