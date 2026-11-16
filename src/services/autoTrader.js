/**
 * ─── Auto-trader ─────────────────────────────────────────────────────────────
 * Runs from the hourly job, but acts only once per new daily candle:
 *
 *  1. Download the latest daily candles (from one "data" account) and work out
 *     today's signals with the strategy the lab chose.
 *  2. For every user with auto-trading on:
 *     - notice positions that closed since yesterday (stop hit) and report them
 *     - tighten each open position's stop (never loosen), on the broker server
 *     - open new positions for today's signals, sized so that hitting the first
 *       stop loses 1% of equity, with the stop placed on the server at once
 *
 * Safety limits (src/config.js): 1% risk per trade, at most 4 positions,
 * at most 2 positions leaning the same way on one currency, total position
 * value ≤ 5× equity, no new trades after a 3% daily drop, one entry per symbol
 * per day. Admin kill switch: `pause`. Real-money accounts are skipped until
 * the admin unlocks live trading (which needs a lab PASS + a demo forward test).
 */

const store = require('../lib/redis');
const mt = require('../lib/metaapi');
const tg = require('../lib/telegram');
const { mapLimit } = require('../lib/concurrency');
const cfg = require('../config');
const accounts = require('./accounts');
const lab = require('./lab');
const { FAMILIES, prepare, initialStop, nextStop } = require('../strategies/fx');

const DAY = 24 * 3600 * 1000;
const K = {
  flags: 'fx:flags',
  lastBar: 'fx:lastbar',
  signals: 'fx:signals',
  lock: 'fx:lock:daily',
  did: (day, id, sym) => `fx:did:${day}:${id}:${sym}`,
  lastEq: (id) => `fx:lasteq:${id}`,
  open: (id) => `fx:open:${id}`,
  closed: (id) => `fx:closed:${id}`,
  first: (id) => `fx:first:${id}`,
  dataAcct: 'fx:dataacct',
};

const dryRun = () => String(process.env.AUTOTRADE_DRY_RUN || '').toLowerCase() === 'true';
const adminId = () => String(process.env.TELEGRAM_CHAT_ID || '');

// ─── Formatting ──────────────────────────────────────────────────────────────
function decimals(symbol) {
  const pip = cfg.pipSize(symbol);
  return pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
}
const px = (symbol, x) => (Number.isFinite(x) ? x.toFixed(decimals(symbol)) : '—');
const money = (x, ccy = 'USD') => `${x < 0 ? '−' : ''}${ccy === 'USD' ? '$' : ''}${Math.abs(x).toFixed(2)}${ccy === 'USD' ? '' : ' ' + ccy}`;
const sideWord = (side) => (side === 'buy' ? 'BUY' : 'SELL');

/** Base and quote currency of a symbol ("EURUSD.m" → ["EUR","USD"]). */
function currencies(symbol) {
  const l = symbol.replace(/[^A-Za-z]/g, '').toUpperCase();
  return [l.slice(0, 3), l.slice(3, 6)];
}
/** "EUR:+1" style exposure counts for a list of {symbol, side}. */
function exposure(list) {
  const m = new Map();
  for (const { symbol, side } of list) {
    const [b, q] = currencies(symbol);
    const sb = side === 'buy' ? '+' : '-', sq = side === 'buy' ? '-' : '+';
    m.set(`${b}${sb}`, (m.get(`${b}${sb}`) || 0) + 1);
    m.set(`${q}${sq}`, (m.get(`${q}${sq}`) || 0) + 1);
  }
  return m;
}
const floorStep = (v, step) => (step > 0 ? Math.floor(v / step + 1e-9) * step : v);
const roundTick = (v, tick) => (tick > 0 ? Math.round(v / tick) * tick : v);
const posSide = (p) => (String(p.type).includes('SELL') ? 'sell' : 'buy');

// ─── Flags ───────────────────────────────────────────────────────────────────
async function flags() {
  const f = store.hashToObject(await store.cmd('HGETALL', K.flags));
  return { paused: f.paused === '1', live: f.live === '1' };
}
const setFlag = (name, on) => store.cmd('HSET', K.flags, name, on ? '1' : '0');

// ─── Data account (prices for signals) ───────────────────────────────────────
async function dataAccount() {
  const envId = process.env.FX_DATA_ACCOUNT_ID;
  if (envId) {
    const cached = await store.getJSON(K.dataAcct);
    if (cached && cached.id === envId) return cached;
    const a = await mt.getAccount(envId);
    const ref = { id: envId, region: a.region || process.env.METAAPI_REGION || 'new-york' };
    await store.setJSON(K.dataAcct, ref);
    return ref;
  }
  const admin = adminId() && await accounts.get(adminId());
  if (admin) return admin.ref;
  for (const id of await accounts.allChatIds()) { const a = await accounts.get(id); if (a) return a.ref; }
  throw new Error('No account to read prices from. The admin should connect their demo account first.');
}

/** Today's signals for every symbol. */
async function computeSignals(acct, strategy, now = Date.now()) {
  const fam = FAMILIES[strategy.family];
  const need = fam.warmup(strategy.params) + 60;
  const out = {};
  await mapLimit(cfg.symbols(), 3, async (symbol) => {
    try {
      const candles = lab.closedOnly(await mt.history(acct, symbol, '1d', Math.max(300, need)), now);
      if (candles.length < fam.warmup(strategy.params) + 2) { out[symbol] = { error: 'not enough history' }; return; }
      const ind = prepare(candles);
      const i = candles.length - 1;
      out[symbol] = { candles, ind, i, signal: fam.signal(ind, i, strategy.params), lastTime: candles[i].time, close: candles[i].close };
    } catch (err) {
      out[symbol] = { error: err.message };
    }
  });
  return out;
}

// ─── Closed-trade bookkeeping (for reports and the forward test) ─────────────
async function tracked(chatId) {
  const h = store.hashToObject(await store.cmd('HGETALL', K.open(chatId)));
  const o = {};
  for (const [id, v] of Object.entries(h)) { try { o[id] = JSON.parse(v); } catch { o[id] = {}; } }
  return o;
}

async function recordClosed(user, positionId, info) {
  let profit = null;
  try {
    const deals = await mt.dealsByPosition(user.ref, positionId);
    if (deals.length) profit = deals.reduce((a, d) => a + (+d.profit || 0) + (+d.commission || 0) + (+d.swap || 0), 0);
  } catch { /* unknown result */ }
  const rec = {
    positionId, symbol: info.symbol, side: info.side, openedAt: info.openedAt, closedAt: new Date().toISOString(),
    profit, r: profit != null && info.riskMoney ? Math.round((profit / info.riskMoney) * 100) / 100 : null,
  };
  await store.cmd('LPUSH', K.closed(user.chatId), JSON.stringify(rec));
  await store.cmd('HDEL', K.open(user.chatId), positionId);
  return rec;
}

async function closedTrades(chatId, n = 200) {
  return ((await store.cmd('LRANGE', K.closed(chatId), 0, n - 1)) || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

async function forwardStats(chatId) {
  const trades = await closedTrades(chatId, 1000);
  const first = await store.cmd('GET', K.first(chatId));
  const known = trades.filter(t => t.profit != null);
  const profit = known.reduce((a, t) => a + t.profit, 0);
  const rs = trades.filter(t => t.r != null).map(t => t.r);
  return {
    since: first || null,
    days: first ? Math.floor((Date.now() - Date.parse(first)) / DAY) : 0,
    closed: trades.length,
    wins: known.filter(t => t.profit > 0).length,
    profit: Math.round(profit * 100) / 100,
    avgR: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null,
  };
}

/** What real-money trading needs before the admin can unlock it. */
async function liveGate() {
  const reasons = [];
  const strat = await lab.activeStrategy();
  if (strat.verdict !== cfg.GATE.researchVerdict) reasons.push(`the lab hasn't given the strategy a PASS (it says ${strat.verdict})`);
  const admin = adminId() && await accounts.get(adminId());
  if (!admin) reasons.push('the admin has no demo account connected for the forward test');
  else if (admin.live) reasons.push('the admin\'s connected account is a real one — the forward test must run on demo');
  const fwd = admin ? await forwardStats(adminId()) : { days: 0, closed: 0, profit: 0 };
  if (fwd.days < cfg.GATE.forwardDays) reasons.push(`the demo forward test has run ${fwd.days} of ${cfg.GATE.forwardDays} days`);
  if (fwd.closed < cfg.GATE.forwardTrades) reasons.push(`it has ${fwd.closed} of ${cfg.GATE.forwardTrades} closed trades`);
  if (cfg.GATE.forwardProfit && !(fwd.profit > 0)) reasons.push('it hasn\'t made money yet');
  return { ok: reasons.length === 0, reasons, strategy: strat, forward: fwd };
}

// ─── One user ────────────────────────────────────────────────────────────────
async function manageUser(user, sig, strategy, ctx) {
  const fam = FAMILIES[strategy.family];
  const p = strategy.params;
  const acct = user.ref;
  const rep = { chatId: user.chatId, opened: [], moved: [], closedNow: [], stoppedOut: [], skipped: [] };

  const info = await mt.accountInfo(acct);
  const equity = Number(info.equity);
  const ccy = info.currency || 'USD';
  rep.equity = equity; rep.ccy = ccy;
  let mine = (await mt.positions(acct)).filter(x => Number(x.magic) === cfg.MAGIC);

  // a) positions that closed since the last run (stop hit on the server)
  const was = await tracked(user.chatId);
  const nowIds = new Set(mine.map(x => String(x.id)));
  for (const [id, t] of Object.entries(was)) {
    if (!nowIds.has(id)) rep.stoppedOut.push(await recordClosed(user, id, t));
  }
  for (const x of mine) {
    if (!was[String(x.id)]) await store.cmd('HSET', K.open(user.chatId), String(x.id), JSON.stringify({ symbol: x.symbol, side: posSide(x), openedAt: x.time, riskMoney: null }));
  }

  // b) tighten stops
  for (const x of [...mine]) {
    const s = sig[x.symbol];
    if (!s || s.error) continue;
    const side = posSide(x);
    const opened = Date.parse(x.time);
    let entryIdx = s.candles.findIndex(c => c.time + DAY > opened);
    if (entryIdx < 0) entryIdx = s.i;
    const current = Number(x.stopLoss) || (side === 'buy' ? -Infinity : Infinity);
    const target = nextStop(fam, s.ind, s.i, side, p, entryIdx, current);
    if (!Number.isFinite(target)) continue;
    const nowPx = Number(x.currentPrice);
    const crossed = side === 'buy' ? nowPx <= target : nowPx >= target;
    const minMove = cfg.pipSize(x.symbol) * 0.5;
    try {
      if (crossed) {
        if (!dryRun()) await mt.trade(acct, { actionType: 'POSITION_CLOSE_ID', positionId: String(x.id) });
        rep.closedNow.push({ symbol: x.symbol, side, price: nowPx, profit: Number(x.profit) });
        if (!dryRun()) { await recordClosed(user, String(x.id), { ...(was[String(x.id)] || {}), symbol: x.symbol, side }); mine = mine.filter(m => m !== x); }
      } else if (Math.abs(target - current) >= minMove || !Number.isFinite(current)) {
        const body = { actionType: 'POSITION_MODIFY', positionId: String(x.id), stopLoss: Number(target.toFixed(decimals(x.symbol))) };
        if (x.takeProfit) body.takeProfit = x.takeProfit;
        if (!dryRun()) await mt.trade(acct, body);
        rep.moved.push({ symbol: x.symbol, side, from: current, to: target });
      }
    } catch (err) {
      rep.skipped.push({ symbol: x.symbol, why: `couldn't update the stop: ${err.message}` });
    }
  }

  // c) daily loss brake
  const lastEq = Number(await store.cmd('GET', K.lastEq(user.chatId)));
  const braked = lastEq > 0 && equity < lastEq * (1 - cfg.LIMITS.dailyLossPct / 100);
  await store.cmd('SET', K.lastEq(user.chatId), String(equity), 'EX', 4 * 24 * 3600);

  // d) new entries
  const wanted = Object.entries(sig).filter(([, s]) => s && !s.error && s.signal);
  if (ctx.paused && wanted.length) { rep.skipped.push({ symbol: '—', why: 'auto-trading is paused by the admin (stops are still managed)' }); return rep; }
  if (braked && wanted.length) { rep.skipped.push({ symbol: '—', why: `equity fell more than ${cfg.LIMITS.dailyLossPct}% since yesterday — no new trades today` }); return rep; }
  const day = new Date(ctx.barTime).toISOString().slice(0, 10);

  for (const [symbol, s] of wanted) {
    const side = s.signal;
    if (mine.length >= cfg.LIMITS.maxOpen) { rep.skipped.push({ symbol, why: `already ${cfg.LIMITS.maxOpen} positions open` }); continue; }
    if (mine.some(x => x.symbol === symbol)) continue; // already in it (stop is being trailed)
    const exp = exposure([...mine.map(x => ({ symbol: x.symbol, side: posSide(x) })), { symbol, side }]);
    if ([...exp.values()].some(n => n > cfg.LIMITS.maxPerCurrency)) { rep.skipped.push({ symbol, why: `would put more than ${cfg.LIMITS.maxPerCurrency} trades on the same currency move` }); continue; }

    try {
      const [q, spec] = await Promise.all([mt.price(acct, symbol), mt.specification(acct, symbol)]);
      if (spec.tradeMode && !/FULL/.test(spec.tradeMode)) { rep.skipped.push({ symbol, why: `the broker doesn't allow opening trades on it right now (${spec.tradeMode})` }); continue; }
      const entry = side === 'buy' ? Number(q.ask) : Number(q.bid);
      const tick = Number(spec.tickSize) || cfg.pipSize(symbol) / 10;
      let stop = initialStop(fam, s.ind, s.i, side, p, entry);
      stop = roundTick(stop, tick);
      if (!Number.isFinite(stop) || (side === 'buy' ? stop >= entry : stop <= entry)) { rep.skipped.push({ symbol, why: 'price already moved past the stop' }); continue; }
      const tickValue = Number(q.lossTickValue || q.profitTickValue);
      if (!(tickValue > 0)) { rep.skipped.push({ symbol, why: 'broker gave no tick value' }); continue; }
      const lossPerLot = (Math.abs(entry - stop) / tick) * tickValue;
      const riskMoney = equity * cfg.LIMITS.riskPct / 100;
      const notionalPerLot = entry * tickValue / tick;
      const step = Number(spec.volumeStep) || 0.01;
      let volume = floorStep(riskMoney / lossPerLot, step);
      volume = Math.min(volume, floorStep((equity * cfg.LIMITS.maxLeverage / cfg.LIMITS.maxOpen) / notionalPerLot, step), Number(spec.maxVolume) || Infinity);
      const minVol = Number(spec.minVolume) || 0.01;
      if (volume < minVol) {
        const needed = Math.ceil((minVol * lossPerLot) / (cfg.LIMITS.riskPct / 100));
        rep.skipped.push({ symbol, why: `account too small for this stop: the smallest trade (${minVol} lot) would risk more than ${cfg.LIMITS.riskPct}% (needs about ${money(needed, ccy)})` });
        continue;
      }
      volume = Number(volume.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
      if ((await store.cmd('SET', K.did(day, user.chatId, symbol), '1', 'NX', 'EX', 3 * 24 * 3600)) !== 'OK') continue;

      const body = { actionType: side === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL', symbol, volume, stopLoss: Number(stop.toFixed(decimals(symbol))), comment: cfg.COMMENT };
      let positionId = null;
      if (!dryRun()) {
        const r = await mt.trade(acct, body);
        positionId = String(r.positionId || r.orderId || '');
        if (positionId) await store.cmd('HSET', K.open(user.chatId), positionId, JSON.stringify({ symbol, side, openedAt: new Date().toISOString(), riskMoney: volume * lossPerLot, entry, stop }));
        await store.cmd('SET', K.first(user.chatId), new Date().toISOString(), 'NX');
      }
      const placed = { symbol, side, volume, entry, stop, risk: volume * lossPerLot, why: whyText(strategy, symbol, side, s), dry: dryRun() };
      rep.opened.push(placed);
      mine.push({ symbol, type: side === 'buy' ? 'POSITION_TYPE_BUY' : 'POSITION_TYPE_SELL', id: positionId });
    } catch (err) {
      await store.cmd('DEL', K.did(day, user.chatId, symbol));
      rep.skipped.push({ symbol, why: err.message });
    }
  }
  return rep;
}

function whyText(strategy, symbol, side, s) {
  const p = strategy.params;
  const c = s.candles[s.i];
  switch (strategy.family) {
    case 'donchian': return side === 'buy'
      ? `closed at ${px(symbol, c.close)}, above its highest price of the last ${p.entryN} days`
      : `closed at ${px(symbol, c.close)}, below its lowest price of the last ${p.entryN} days`;
    case 'emaTrend': return side === 'buy'
      ? `uptrend (${p.fast}-day average above the ${p.slow}-day) and the price closed back above the ${p.fast}-day average`
      : `downtrend (${p.fast}-day average below the ${p.slow}-day) and the price closed back below the ${p.fast}-day average`;
    case 'tsmom': return side === 'buy'
      ? `its ${p.lookback}-day change turned positive and it's above its 100-day average`
      : `its ${p.lookback}-day change turned negative and it's below its 100-day average`;
    default: return strategy.label;
  }
}

function userMessage(rep, user) {
  const lines = [];
  const tag = user.live ? '💵 REAL' : '🧪 Demo';
  for (const t of rep.stoppedOut) {
    const res = t.profit == null ? 'result not available yet' : `${t.profit >= 0 ? '✅' : '🔻'} ${money(t.profit, rep.ccy)}${t.r != null ? ` (${t.r > 0 ? '+' : ''}${t.r}R)` : ''}`;
    lines.push(`🔔 ${t.symbol} ${sideWord(t.side)} closed at its stop — ${res}`);
  }
  for (const t of rep.closedNow) lines.push(`🔔 ${t.symbol} ${sideWord(t.side)} closed: price was already past the new stop (${money(t.profit, rep.ccy)})`);
  for (const t of rep.opened) {
    lines.push(`${t.dry ? '🧾 (dry run) would open' : '🟢 Opened'} *${t.symbol} ${sideWord(t.side)}* ${t.volume} lot at ~${px(t.symbol, t.entry)}`);
    lines.push(`   Stop ${px(t.symbol, t.stop)} on the broker's server · risk ${money(t.risk, rep.ccy)} (${cfg.LIMITS.riskPct}% of equity)`);
    lines.push(`   Why: ${t.why}.`);
  }
  for (const t of rep.moved) lines.push(`↕️ ${t.symbol} stop moved ${Number.isFinite(t.from) ? px(t.symbol, t.from) + ' → ' : 'to '}${px(t.symbol, t.to)}`);
  for (const t of rep.skipped) lines.push(`⏭ ${t.symbol}: ${t.why}`);
  if (!lines.length) return null;
  return `${tag} · *JijazyFX daily run*\n${lines.join('\n')}\n\nEquity: ${money(rep.equity, rep.ccy)}`;
}

// ─── The daily run ───────────────────────────────────────────────────────────
/**
 * @param {{force?: boolean, now?: number, notify?: boolean}} opts
 */
async function runDaily({ force = false, now = Date.now(), notify = true } = {}) {
  if (!(await store.lock(K.lock, 55))) return { skipped: 'another run is in progress' };
  try {
    const strategy = await lab.activeStrategy();
    const acct = await dataAccount();
    const ready = await mt.ensureDeployed(acct, { waitMs: 15000 });
    if (!ready.ready) return { skipped: `price account not connected yet (${ready.state} / ${ready.connectionStatus}); MetaApi was asked to start it` };
    const sig = await computeSignals(acct, strategy, now);
    const barTime = Math.max(0, ...Object.values(sig).filter(s => s.lastTime).map(s => s.lastTime));
    if (!barTime) return { skipped: 'no price data', errors: Object.fromEntries(Object.entries(sig).map(([k, v]) => [k, v.error])) };
    const last = Number(await store.cmd('GET', K.lastBar)) || 0;
    if (!force && barTime <= last) return { skipped: 'no new daily candle yet' };

    const f = await flags();
    const ctx = { paused: f.paused, barTime };
    const users = [];
    const lockedLive = [];
    for (const id of await accounts.allChatIds()) {
      const a = await accounts.get(id);
      if (!a || !a.autotrade) continue;
      if (a.live && !f.live) { lockedLive.push(id); continue; }
      users.push(a);
    }

    const reports = await mapLimit(users, 3, async (u) => {
      try {
        if (u.metaId !== acct.id) {
          const r = await mt.ensureDeployed(u.ref, { waitMs: 10000 });
          if (!r.ready) throw new Error(`your account isn't running in MetaApi yet (${r.state} / ${r.connectionStatus}); I've asked it to start and will try again next run`);
        }
        const rep = await manageUser(u, sig, strategy, ctx);
        await accounts.setError(u.chatId, null);
        const msg = userMessage(rep, u);
        if (notify && msg) await tg.send(u.chatId, msg);
        return rep;
      } catch (err) {
        await accounts.setError(u.chatId, err.message);
        if (notify) await tg.send(u.chatId, `⚠️ JijazyFX couldn't manage your account today: ${err.message}\nYour open trades keep their stops on the broker's server.`, { plain: true });
        return { chatId: u.chatId, error: err.message };
      }
    });

    await store.cmd('SET', K.lastBar, String(barTime));
    const signalList = Object.entries(sig).map(([symbol, s]) => ({ symbol, signal: s.signal || null, close: s.close ?? null, error: s.error || null }));
    await store.setJSON(K.signals, { at: new Date().toISOString(), barTime, strategy: strategy.id, verdict: strategy.verdict, list: signalList });

    const summary = {
      barDate: new Date(barTime).toISOString().slice(0, 10),
      strategy: strategy.id, verdict: strategy.verdict,
      signals: signalList.filter(s => s.signal).map(s => `${s.symbol} ${sideWord(s.signal)}`),
      users: reports.length, opened: reports.reduce((a, r) => a + (r.opened?.length || 0), 0),
      errors: reports.filter(r => r.error).length, lockedLive: lockedLive.length, paused: f.paused,
    };
    if (notify && adminId()) {
      await tg.send(adminId(), [
        `🗓 *JijazyFX daily run* — candle of ${summary.barDate}`,
        `Strategy: ${strategy.label} (${strategy.verdict})`,
        `Signals: ${summary.signals.join(', ') || 'none'}`,
        `Accounts managed: ${summary.users} · trades opened: ${summary.opened}${summary.errors ? ` · ⚠️ errors: ${summary.errors}` : ''}`,
        summary.lockedLive ? `🔒 ${summary.lockedLive} real account(s) skipped — live trading is locked.` : null,
        f.paused ? '⏸ Paused: no new trades, stops still managed.' : null,
      ].filter(Boolean).join('\n'));
    }
    return summary;
  } finally {
    await store.cmd('DEL', K.lock).catch(() => {});
  }
}

/** One-tap close of the bot's positions on a user's account (all, or one symbol). */
async function closeBotPositions(chatId, symbol = null) {
  const user = await accounts.get(chatId);
  if (!user) throw new accounts.AccountError('No account connected.');
  const mine = (await mt.positions(user.ref)).filter(x => Number(x.magic) === cfg.MAGIC && (!symbol || x.symbol.toUpperCase() === symbol.toUpperCase()));
  const done = [];
  const was = await tracked(chatId);
  for (const x of mine) {
    if (!dryRun()) await mt.trade(user.ref, { actionType: 'POSITION_CLOSE_ID', positionId: String(x.id) });
    done.push({ symbol: x.symbol, side: posSide(x), profit: Number(x.profit) });
    if (!dryRun()) await recordClosed(user, String(x.id), { ...(was[String(x.id)] || {}), symbol: x.symbol, side: posSide(x) });
  }
  return done;
}

module.exports = {
  runDaily, manageUser, computeSignals, dataAccount, closeBotPositions,
  flags, setFlag, liveGate, forwardStats, closedTrades,
  exposure, currencies, userMessage, px, money, K,
};
