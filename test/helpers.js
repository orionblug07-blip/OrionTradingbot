/** Test helpers: synthetic candles, fake MetaApi, captured Telegram messages. */

const DAY = 24 * 3600 * 1000;

/** Seeded PRNG so tests are repeatable. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * Daily candles from a random walk. `drift` per day (fraction), `vol` daily range.
 * Regimes flip trend every `regime` days if given.
 */
function makeCandles({ n = 1500, start = 1.1, drift = 0, vol = 0.006, seed = 1, regime = 0, startTime = Date.UTC(2018, 0, 1) } = {}) {
  const r = rng(seed);
  const out = [];
  let price = start;
  let d = drift;
  for (let i = 0; i < n; i++) {
    if (regime && i % regime === 0) d = (r() < 0.5 ? -1 : 1) * Math.abs(drift || 0.001);
    const open = price;
    const change = (r() - 0.5) * 2 * vol + d;
    const close = open * (1 + change);
    const high = Math.max(open, close) * (1 + r() * vol * 0.5);
    const low = Math.min(open, close) * (1 - r() * vol * 0.5);
    out.push({ time: startTime + i * DAY, open, high, low, close, spread: 8 });
    price = close;
  }
  return out;
}

module.exports = { makeCandles, rng, DAY };

/**
 * A pretend MetaApi + broker behind metaapi._setHttp(). Records every request.
 * fake.candles[symbol] = [...]; fake.prices / specs / positions can be edited.
 */
function fakeMetaApi({ candles = {}, equity = 10000, currency = 'USD' } = {}) {
  const f = {
    calls: [], trades: [], nextCreate: [], accounts: {}, positions: [], deals: {},
    candles, equity, currency, posSeq: 1000,
    prices: {}, specs: {},
    region: 'london',
  };
  const ok = (data, status = 200, headers = {}) => ({ status, data, headers });
  f.http = async (cfg) => {
    const { method, url } = cfg;
    f.calls.push({ method, url, data: cfg.data, params: cfg.params, headers: cfg.headers });
    if (url.endsWith('/users/current/servers/mt-client-api')) return ok({ domain: 'agiliumtrade.ai', hostname: 'mt-client-api-v1' });
    if (method === 'POST' && /\/users\/current\/accounts$/.test(url)) {
      const next = f.nextCreate.shift() || { status: 201 };
      if (next.status === 202) return ok({ message: 'detecting' }, 202, { 'retry-after': '5' });
      if (next.status >= 400) return ok({ error: 'ValidationError', message: next.message || 'bad', details: next.details }, next.status);
      const id = `acc-${Object.keys(f.accounts).length + 1}`;
      f.accounts[id] = { _id: id, region: f.region, state: 'DEPLOYED', connectionStatus: 'CONNECTED', body: cfg.data };
      return ok({ id, state: 'DEPLOYED' }, 201);
    }
    let m = url.match(/provisioning.*\/accounts\/([^/]+)$/);
    if (m && method === 'GET') return f.accounts[m[1]] ? ok(f.accounts[m[1]]) : ok({ message: 'not found' }, 404);
    if (m && method === 'DELETE') { delete f.accounts[m[1]]; return ok(null, 204); }
    m = url.match(/accounts\/([^/]+)\/deploy$/);
    if (m) { f.deployCalls = (f.deployCalls || 0) + 1; const a = f.accounts[m[1]]; if (a) { a.state = 'DEPLOYED'; a.connectionStatus = 'CONNECTED'; } return ok(null, 204); }
    if (url.endsWith('/account-information')) return ok({ balance: f.equity, equity: f.equity, currency: f.currency, leverage: 500, freeMargin: f.equity, platform: 'mt5' });
    if (url.endsWith('/positions')) return ok(f.positions);
    m = url.match(/\/symbols\/([^/]+)\/current-price$/);
    if (m) { const s = decodeURIComponent(m[1]); return ok(f.prices[s] || priceFromCandles(f, s)); }
    m = url.match(/\/symbols\/([^/]+)\/specification$/);
    if (m) { const s = decodeURIComponent(m[1]); return ok(f.specs[s] || defaultSpec(s)); }
    m = url.match(/\/history-deals\/position\/([^/]+)$/);
    if (m) return ok(f.deals[decodeURIComponent(m[1])] || []);
    m = url.match(/historical-market-data\/symbols\/([^/]+)\/timeframes\/([^/]+)\/candles$/);
    if (m) {
      const s = decodeURIComponent(m[1]);
      let list = (f.candles[s] || []).slice();
      if (cfg.params?.startTime) { const t = Date.parse(cfg.params.startTime); list = list.filter(c => c.time <= t); }
      list = list.slice(-(cfg.params?.limit || 1000));
      return ok(list.map(c => ({ ...c, time: new Date(c.time).toISOString() })));
    }
    if (url.endsWith('/trade')) {
      const b = cfg.data;
      f.trades.push(b);
      if (f.rejectNext) { f.rejectNext = false; return ok({ numericCode: 10006, stringCode: 'TRADE_RETCODE_REJECT', message: 'Request rejected' }); }
      if (b.actionType === 'ORDER_TYPE_BUY' || b.actionType === 'ORDER_TYPE_SELL') {
        const id = String(f.posSeq++);
        const p = priceFromCandles(f, b.symbol);
        f.positions.push({ id, type: b.actionType === 'ORDER_TYPE_BUY' ? 'POSITION_TYPE_BUY' : 'POSITION_TYPE_SELL', symbol: b.symbol, magic: 20261115, volume: b.volume, openPrice: b.actionType === 'ORDER_TYPE_BUY' ? p.ask : p.bid, currentPrice: p.bid, stopLoss: b.stopLoss, profit: 0, time: new Date().toISOString() });
        return ok({ numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', message: 'Request completed', orderId: id, positionId: id });
      }
      if (b.actionType === 'POSITION_MODIFY') { const p = f.positions.find(x => x.id === b.positionId); if (p) p.stopLoss = b.stopLoss; }
      if (b.actionType === 'POSITION_CLOSE_ID') f.positions = f.positions.filter(x => x.id !== b.positionId);
      return ok({ numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', message: 'Request completed', positionId: b.positionId });
    }
    return ok({ message: `fake: no route for ${method} ${url}` }, 404);
  };
  return f;
}

function priceFromCandles(f, s) {
  const c = (f.candles[s] || []).slice(-1)[0];
  const mid = c ? c.close : 1.1;
  const pip = s.includes('JPY') ? 0.01 : s.startsWith('XAU') ? 0.1 : 0.0001;
  // tick value per lot for a USD account: XXXUSD → contract × tick; USDXXX → / price
  const spec = f.specs[s] || defaultSpec(s);
  const tv = s.endsWith('USD') ? spec.contractSize * spec.tickSize : (spec.contractSize * spec.tickSize) / mid;
  return { symbol: s, bid: mid - pip / 2, ask: mid + pip / 2, profitTickValue: tv, lossTickValue: tv };
}

function defaultSpec(s) {
  if (s.startsWith('XAU')) return { symbol: s, tickSize: 0.01, contractSize: 100, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tradeMode: 'SYMBOL_TRADE_MODE_FULL' };
  if (s.includes('JPY')) return { symbol: s, tickSize: 0.001, contractSize: 100000, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tradeMode: 'SYMBOL_TRADE_MODE_FULL' };
  return { symbol: s, tickSize: 0.00001, contractSize: 100000, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, tradeMode: 'SYMBOL_TRADE_MODE_FULL' };
}

/** Capture Telegram traffic instead of sending it. */
function captureTelegram(tg) {
  const sent = [];
  tg.send = async (chatId, text, opts = {}) => { sent.push({ chatId: String(chatId), text, opts }); return { message_id: sent.length }; };
  tg.sendLong = tg.send;
  tg.call = async (method, payload) => { sent.push({ method, payload }); return method === 'getWebhookInfo' ? { url: 'x' } : true; };
  tg.answerCallback = async () => {};
  tg.sleep = async () => {};
  return sent;
}

/** Fresh env + memory store for each test. */
function resetEnv(extra = {}) {
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'FX_SYMBOLS', 'FX_DATA_ACCOUNT_ID', 'AUTOTRADE_DRY_RUN', 'METAAPI_REGION', 'VERCEL', 'PUBLIC_BASE_URL']) delete process.env[k];
  Object.assign(process.env, {
    METAAPI_TOKEN: 'test-token',
    TRADING_ENCRYPTION_KEY: 'a'.repeat(64),
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHAT_ID: '111',
    ...extra,
  });
  require('../src/lib/redis')._resetMemory();
}

module.exports.fakeMetaApi = fakeMetaApi;
module.exports.captureTelegram = captureTelegram;
module.exports.resetEnv = resetEnv;
module.exports.defaultSpec = defaultSpec;
