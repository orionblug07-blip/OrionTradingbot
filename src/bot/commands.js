/**
 * ─── Telegram commands ───────────────────────────────────────────────────────
 * handleUpdate(update) is called by api/telegram-webhook.js for every message
 * and button tap.
 */

const tg = require('../lib/telegram');
const store = require('../lib/redis');
const cfg = require('../config');
const users = require('../services/users');
const accounts = require('../services/accounts');
const autoTrader = require('../services/autoTrader');
const lab = require('../services/lab');
const labJob = require('../services/labJob');
const { money, px } = autoTrader;

const MENU = (admin) => ({
  inline_keyboard: [
    [{ text: '📊 Status', callback_data: 'status' }, { text: '📂 Positions', callback_data: 'positions' }],
    [{ text: '🤖 Auto-trade', callback_data: 'auto' }, { text: '📡 Signals', callback_data: 'signals' }],
    [{ text: '🧪 Strategy', callback_data: 'strategy' }, { text: '📈 Results', callback_data: 'results' }],
    [{ text: '❓ Help', callback_data: 'help' }].concat(admin ? [{ text: '🛠 Admin', callback_data: 'admin' }] : []),
  ],
});

const CONNECT_HELP = [
  '*Connect your MT5 account*',
  'Send this in ONE message:',
  '`connect LOGIN PASSWORD SERVER`',
  'e.g. `connect 12345678 MyPass123 OctaFX-Demo`',
  '',
  '• Use the *main (trading) password*, not the investor one — the investor password can\'t trade.',
  '• I delete your message as soon as I read it.',
  '• Your password goes to MetaApi, the service that runs MetaTrader in the cloud for this bot. This bot keeps it only while MetaApi checks the account (encrypted, a few minutes at most), then deletes it.',
  '• Start with a *demo* account. Real accounts can only auto-trade once the strategy has passed its tests.',
].join('\n');

function helpText(admin) {
  const lines = [
    '*JijazyFX* — forex auto-trading on your own MT5 account',
    '',
    '`connect LOGIN PASSWORD SERVER` — link your MT5 account',
    '`status` — account, balance, auto-trading',
    '`positions` — open trades',
    '`auto on` / `auto off` — automatic trading',
    '`signals` — today\'s signals',
    '`strategy` — the strategy and its test results',
    '`results` — how the bot\'s trades went on your account',
    '`close EURUSD` / `close all` — close the bot\'s trades now',
    '`disconnect` — unlink your account',
    '',
    `Every trade risks ${cfg.LIMITS.riskPct}% of your equity, with a stop on the broker's server from the first second. The bot never touches trades you open yourself.`,
  ];
  if (admin) lines.push('', 'Admin: `admin` for the admin commands');
  return lines.join('\n');
}

const ADMIN_HELP = [
  '*Admin*',
  '`lab run` — test the strategies on the broker\'s price history (takes a few minutes)',
  '`run now` — run today\'s auto-trading check now',
  '`pause` / `resume` — stop / allow new trades for everyone (stops are still managed)',
  '`gate` — what real-money trading still needs',
  '`unlock live` / `lock live` — allow real accounts to auto-trade',
  '`users` · `approve ID` · `block ID`',
].join('\n');

// ─── Entry point ─────────────────────────────────────────────────────────────
async function handleUpdate(update) {
  if (update.callback_query) {
    const q = update.callback_query;
    await tg.answerCallback(q.id);
    const chatId = q.message?.chat?.id;
    if (chatId == null) return;
    return route(chatId, String(q.data || ''), q.from || {}, null);
  }
  const m = update.message;
  if (!m || !m.text || m.chat?.type !== 'private') return;
  return route(m.chat.id, m.text.trim(), m.from || {}, m.message_id);
}

async function route(chatId, text, from, messageId) {
  const admin = users.isAdmin(chatId);
  const lower = text.toLowerCase().replace(/^\//, '').replace(/@\w+/, '');
  const [cmd, ...args] = lower.split(/\s+/);

  // Never leave a password visible, whatever happens next.
  if (cmd === 'connect' && messageId && args.length >= 2) {
    try { await tg.call('deleteMessage', { chat_id: chatId, message_id: messageId }); } catch { /* best effort */ }
  }

  const access = await users.access(chatId);
  if (access === 'blocked') return;
  if (access !== 'approved') {
    if (access === 'new') {
      await users.request(chatId, from);
      const who = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` @${from.username}` : '');
      if (process.env.TELEGRAM_CHAT_ID) {
        await tg.send(process.env.TELEGRAM_CHAT_ID, `🆕 Access request: ${who} (id ${chatId})`, {
          plain: true,
          markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve ${chatId}` }, { text: '🚫 Block', callback_data: `block ${chatId}` }]] },
        });
      }
    }
    return tg.send(chatId, '👋 Welcome to JijazyFX. Your access request has been sent to the admin — you\'ll get a message when it\'s approved.', { plain: true });
  }

  try {
    switch (cmd) {
      case 'start': case 'menu':
        return tg.send(chatId, `👋 *JijazyFX*\n${(await accounts.get(chatId)) ? 'Pick an option:' : 'First, connect your MT5 account — tap Help or send `connect`.'}`, { markup: MENU(admin) });
      case 'help': return tg.send(chatId, helpText(admin), { markup: MENU(admin) });
      case 'connect': return cmdConnect(chatId, text);
      case 'status': case 'account': case 'balance': return cmdStatus(chatId);
      case 'positions': case 'trades': return cmdPositions(chatId);
      case 'auto': case 'autotrade': return cmdAuto(chatId, args, text);
      case 'signals': return cmdSignals(chatId);
      case 'strategy': case 'lab':
        if (admin && args[0] === 'run') return cmdLabRun(chatId);
        return tg.sendLong(chatId, lab.summary(await lab.latestResult()) + (await strategyFooter()));
      case 'results': return cmdResults(chatId);
      case 'close': return cmdClose(chatId, args);
      case 'disconnect': return cmdDisconnect(chatId, args);
    }
    if (admin) {
      switch (cmd) {
        case 'admin': return tg.send(chatId, ADMIN_HELP);
        case 'run': return cmdRunNow(chatId);
        case 'pause': await autoTrader.setFlag('paused', true); return tg.send(chatId, '⏸ Paused. No new trades for anyone; open trades keep their stops and still get trailed.');
        case 'resume': await autoTrader.setFlag('paused', false); return tg.send(chatId, '▶️ Resumed. New trades allowed from the next daily run.');
        case 'gate': return cmdGate(chatId);
        case 'unlock': return cmdUnlock(chatId);
        case 'lock': await autoTrader.setFlag('live', false); return tg.send(chatId, '🔒 Live trading locked. Real accounts will be skipped; their open trades keep their stops.');
        case 'users': return cmdUsers(chatId);
        case 'approve': case 'block': return cmdApprove(chatId, cmd, args[0]);
      }
    }
    return tg.send(chatId, 'I didn\'t understand that. Send `help` for the commands.', { markup: MENU(admin) });
  } catch (err) {
    console.error('[bot]', err);
    return tg.send(chatId, `⚠️ ${err instanceof accounts.AccountError ? err.message : `Something went wrong: ${err.message}`}`, { plain: true });
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────
async function cmdConnect(chatId, text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return tg.send(chatId, CONNECT_HELP);
  const [, login, password, ...serverParts] = parts;
  await tg.send(chatId, '🔐 Got it — your message is deleted. Checking the account with MetaApi…', { plain: true });
  let r;
  try {
    r = await accounts.connect(chatId, { login, password, server: serverParts.join(' ') });
  } catch (err) {
    if (err instanceof accounts.AccountError) return tg.send(chatId, `❌ ${err.message}`, { plain: true });
    return tg.send(chatId, `⏳ MetaApi didn't answer properly (${err.message}). I'll keep trying for a few minutes and message you.`, { plain: true });
  }
  if (!r.done) {
    await tg.send(chatId, `⏳ ${r.message}`, { plain: true });
    // Keep asking for up to ~45 s in this call; the hourly job continues after that.
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      await tg.sleep(Math.min(15000, Math.max(5000, (r.retryAfterSec || 10) * 1000)));
      try { r = await accounts.tryFinish(chatId); } catch (err) {
        if (err instanceof accounts.AccountError) return tg.send(chatId, `❌ ${err.message}`, { plain: true });
      }
      if (r.done || r.gone) break;
    }
    if (!r.done) return tg.send(chatId, 'Still checking. I\'ll message you as soon as MetaApi has finished (usually within a few minutes).', { plain: true });
  }
  return tg.send(chatId, connectedText(r.account), { markup: MENU(users.isAdmin(chatId)) });
}

function connectedText(a) {
  return [
    `✅ *Connected* — MT5 ${a.login} on ${a.server} (${a.live ? '💵 REAL money' : '🧪 demo'})`,
    'MetaApi is starting the account in the cloud; it can take a few minutes before `status` shows your balance.',
    '',
    'Auto-trading is *off*. Send `auto on` when you\'re ready.',
    a.live ? '🔒 This is a real account. Auto-trading on real accounts stays locked until the strategy has passed its tests and a demo forward test.' : '',
  ].filter(Boolean).join('\n');
}

async function cmdStatus(chatId) {
  if (await accounts.hasPending(chatId) && !(await accounts.get(chatId))) return tg.send(chatId, '⏳ Your account is still being checked by MetaApi. I\'ll message you when it\'s ready.', { plain: true });
  const s = await accounts.status(chatId);
  if (!s) return tg.send(chatId, CONNECT_HELP);
  const f = await autoTrader.flags();
  const lines = [
    `*MT5 ${s.login}* · ${s.server} · ${s.live ? '💵 REAL' : '🧪 demo'}`,
    `MetaApi: ${s.state || '?'} / ${s.connectionStatus || '?'}`,
  ];
  if (s.info && s.state === 'DEPLOYED') {
    lines.push(`Balance ${money(+s.info.balance, s.info.currency)} · Equity ${money(+s.info.equity, s.info.currency)}`);
    lines.push(`Free margin ${money(+s.info.freeMargin, s.info.currency)} · Leverage 1:${s.info.leverage}`);
    if (s.info.investorMode) lines.push('⚠️ Connected with the INVESTOR password — the bot can\'t trade. Disconnect and connect again with the main password.');
  } else if (s.deployRequested || /UNDEPLOY/.test(s.state || '')) {
    lines.push('Your account was stopped in MetaApi\'s cloud. I\'ve asked MetaApi to start it again — check `status` in a few minutes.');
  } else if (s.connectionStatus && s.connectionStatus !== 'CONNECTED') {
    lines.push('The account is still starting up in the cloud, or MetaApi can\'t reach the broker. Try again in a few minutes.');
  }
  lines.push(`Auto-trading: ${s.autotrade ? '✅ on' : '⏹ off'}${s.live && !f.live ? ' (🔒 real accounts locked)' : ''}${f.paused ? ' · ⏸ paused by admin' : ''}`);
  if (s.lastError) lines.push(`Last problem: ${s.lastError}`);
  if (s.error) lines.push(`(${s.error})`);
  return tg.send(chatId, lines.join('\n'), { markup: MENU(users.isAdmin(chatId)) });
}

async function cmdPositions(chatId) {
  const a = await accounts.get(chatId);
  if (!a) return tg.send(chatId, CONNECT_HELP);
  const mt = require('../lib/metaapi');
  const pos = await mt.positions(a.ref);
  if (!pos.length) return tg.send(chatId, 'No open positions.');
  const lines = ['*Open positions* (🤖 = the bot\'s, 👤 = yours, left alone)'];
  for (const p of pos) {
    const side = String(p.type).includes('SELL') ? 'SELL' : 'BUY';
    const mine = Number(p.magic) === cfg.MAGIC ? '🤖' : '👤';
    lines.push(`${mine} ${p.symbol} ${side} ${p.volume} @ ${px(p.symbol, +p.openPrice)} → ${px(p.symbol, +p.currentPrice)} · stop ${p.stopLoss ? px(p.symbol, +p.stopLoss) : 'none'} · ${money(+p.profit + (+p.swap || 0) + (+p.commission || 0))}`);
  }
  return tg.send(chatId, lines.join('\n'));
}

async function cmdAuto(chatId, args, text) {
  const a = await accounts.get(chatId);
  if (!a) return tg.send(chatId, CONNECT_HELP);
  const strat = await lab.activeStrategy();
  const sub = args[0];
  if (sub !== 'on' && sub !== 'off') {
    return tg.send(chatId, [
      `🤖 *Auto-trading is ${a.autotrade ? 'ON' : 'OFF'}*`,
      `Strategy: ${strat.label}`,
      `Test result: *${strat.verdict}*`,
      `Risk: ${cfg.LIMITS.riskPct}% of equity per trade, max ${cfg.LIMITS.maxOpen} trades, stops on the broker's server.`,
      'It checks once a day, after the daily candle closes.',
    ].join('\n'), { markup: { inline_keyboard: [[a.autotrade ? { text: '⏹ Turn off', callback_data: 'auto off' } : { text: '✅ Turn on', callback_data: 'auto on' }]] } });
  }
  if (sub === 'off') {
    await accounts.setAutotrade(chatId, false);
    return tg.send(chatId, '⏹ Auto-trading off. Open trades keep their stops on the broker\'s server but will no longer be trailed. Send `close all` to close them.');
  }
  if (a.live) {
    const f = await autoTrader.flags();
    if (!f.live) return tg.send(chatId, '🔒 Auto-trading on *real* accounts is locked until the strategy passes the lab test and a demo forward test. Use a demo account for now.');
    if (!text.toUpperCase().includes(cfg.LIVE_CONFIRM)) {
      return tg.send(chatId, `⚠️ This is a *real-money* account. Trading forex with leverage can lose money quickly, and past test results are not a promise.\nIf you accept that, send:\n\`auto on ${cfg.LIVE_CONFIRM}\``);
    }
  }
  await accounts.setAutotrade(chatId, true);
  return tg.send(chatId, [
    `✅ Auto-trading *on* (${a.live ? '💵 REAL' : '🧪 demo'}).`,
    `Strategy: ${strat.label} — test result *${strat.verdict}*.`,
    `Each trade risks ${cfg.LIMITS.riskPct}% of your equity. The first check runs after the next daily candle closes; I'll tell you what it does and why.`,
  ].join('\n'));
}

async function cmdSignals(chatId) {
  const s = await store.getJSON(autoTrader.K.signals);
  if (!s) return tg.send(chatId, 'No daily run yet. Signals appear after the first daily check.');
  const lines = [`📡 *Signals* — daily candle of ${new Date(s.barTime).toISOString().slice(0, 10)}`, `Strategy ${s.strategy} (${s.verdict})`, ''];
  for (const x of s.list) lines.push(`${x.signal ? (x.signal === 'buy' ? '🟢 BUY ' : '🔴 SELL') : '⚪ —   '} ${x.symbol}${x.close ? ` ${px(x.symbol, x.close)}` : ''}${x.error ? ` (${x.error})` : ''}`);
  return tg.send(chatId, lines.join('\n'));
}

async function strategyFooter() {
  const r = await lab.latestResult();
  return r ? '' : `\n\nUntil the lab has run, demo accounts use: ${(await lab.activeStrategy()).label} (NOT TESTED).`;
}

async function cmdResults(chatId) {
  const st = await autoTrader.forwardStats(chatId);
  const last = await autoTrader.closedTrades(chatId, 5);
  const lines = ['📈 *The bot\'s trades on your account*'];
  if (!st.closed) lines.push('No closed trades yet.');
  else {
    lines.push(`${st.closed} closed · ${st.wins} won · total ${money(st.profit)}${st.avgR != null ? ` · avg ${st.avgR > 0 ? '+' : ''}${st.avgR}R` : ''}`);
    if (st.since) lines.push(`Since ${st.since.slice(0, 10)} (${st.days} days)`);
    lines.push('', 'Last trades:');
    for (const t of last) lines.push(`• ${t.symbol} ${t.side === 'buy' ? 'BUY' : 'SELL'} — ${t.profit == null ? '?' : money(t.profit)}${t.r != null ? ` (${t.r > 0 ? '+' : ''}${t.r}R)` : ''} · ${String(t.closedAt).slice(0, 10)}`);
  }
  return tg.send(chatId, lines.join('\n'));
}

async function cmdClose(chatId, args) {
  if (!args[0]) return tg.send(chatId, 'Send `close EURUSD` or `close all` (only the bot\'s trades are closed).');
  const done = await autoTrader.closeBotPositions(chatId, args[0] === 'all' ? null : args[0].toUpperCase());
  if (!done.length) return tg.send(chatId, 'No bot trades to close.');
  return tg.send(chatId, `Closed: ${done.map(d => `${d.symbol} ${d.side.toUpperCase()} (${money(d.profit)})`).join(', ')}`);
}

async function cmdDisconnect(chatId, args) {
  if (!(await accounts.get(chatId)) && !(await accounts.hasPending(chatId))) return tg.send(chatId, 'No account connected.');
  if (args[0] !== 'confirm') {
    return tg.send(chatId, 'This removes your account from the bot and from MetaApi. Open trades stay open on your account with their stops, but will no longer be managed.', { markup: { inline_keyboard: [[{ text: '🔌 Yes, disconnect', callback_data: 'disconnect confirm' }]] } });
  }
  await accounts.disconnect(chatId);
  return tg.send(chatId, '🔌 Disconnected. Your MT5 password is no longer stored by MetaApi for this bot. Consider changing it in your broker\'s area for peace of mind.');
}

async function cmdLabRun(chatId) {
  const j = await labJob.job();
  if (j && j.status === 'running' && Date.now() - Date.parse(j.startedAt) < 30 * 60 * 1000) return tg.send(chatId, '🧪 The lab is already running. I\'ll send the result when it\'s done.');
  await labJob.start(chatId);
  await tg.send(chatId, '🧪 Lab started: downloading ~10 years of daily prices for each symbol from your broker, then testing every strategy. This takes a few minutes; I\'ll send the result.');
  let r = await labJob.step();
  // Off Vercel there is no self-call, so finish inline.
  while (!r.finished && !process.env.VERCEL) r = await labJob.step({ selfCall: false });
  return null;
}

async function cmdRunNow(chatId) {
  await tg.send(chatId, '⏳ Running today\'s check…');
  const r = await autoTrader.runDaily({ force: true });
  if (r.skipped) return tg.send(chatId, `Skipped: ${r.skipped}${r.errors ? '\n' + JSON.stringify(r.errors) : ''}`, { plain: true });
  return null; // the run sends its own report
}

async function cmdGate(chatId) {
  const g = await autoTrader.liveGate();
  const f = await autoTrader.flags();
  const lines = [`🔐 *Live trading* is ${f.live ? 'UNLOCKED' : 'locked'}`, `Strategy: ${g.strategy.label} (${g.strategy.verdict})`, `Demo forward test: ${g.forward.days} days · ${g.forward.closed} closed trades · ${money(g.forward.profit || 0)}`];
  lines.push('', g.ok ? '✅ All conditions met — `unlock live` is available.' : `Still needed:\n${g.reasons.map(r => `• ${r}`).join('\n')}`);
  return tg.send(chatId, lines.join('\n'));
}

async function cmdUnlock(chatId) {
  const g = await autoTrader.liveGate();
  if (!g.ok) return tg.send(chatId, `🔒 Can't unlock yet:\n${g.reasons.map(r => `• ${r}`).join('\n')}`);
  await autoTrader.setFlag('live', true);
  return tg.send(chatId, '🔓 Live trading unlocked. Each real-account user still has to switch it on and confirm themselves.');
}

async function cmdUsers(chatId) {
  const list = await users.list();
  if (!list.length) return tg.send(chatId, 'No users yet.');
  const lines = ['*Users*'];
  for (const u of list) {
    const a = await accounts.get(u.id);
    lines.push(`${u.status === 'approved' ? '✅' : u.status === 'blocked' ? '🚫' : '⏳'} ${u.id} ${u.name || ''}${u.username ? ' @' + u.username : ''}${a ? ` · MT5 ${a.login} ${a.live ? 'REAL' : 'demo'}${a.autotrade ? ' · auto' : ''}` : ''}`);
  }
  return tg.send(chatId, lines.join('\n'), { plain: true });
}

async function cmdApprove(chatId, cmd, id) {
  if (!id || !/^-?\d+$/.test(id)) return tg.send(chatId, `Send \`${cmd} ID\`.`);
  await users.setStatus(id, cmd === 'approve' ? 'approved' : 'blocked');
  if (cmd === 'approve') await tg.send(id, `✅ You're approved for JijazyFX!\n\n${CONNECT_HELP}`);
  if (cmd === 'block') {
    if (await accounts.get(id)) { await accounts.setAutotrade(id, false); }
  }
  return tg.send(chatId, `${cmd === 'approve' ? '✅ Approved' : '🚫 Blocked'} ${id}.`);
}

module.exports = { handleUpdate, route, helpText, CONNECT_HELP };
