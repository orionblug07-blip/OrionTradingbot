/**
 * ─── Running the lab on Vercel (60-second functions) ────────────────────────
 * Downloading ~10 years of daily candles for 8 symbols can take longer than one
 * function call, so the lab runs as a job in steps:
 *
 *   step 1..n  download symbols until ~40 s are used; cache each one (24 h)
 *   last step  run the lab on the cached data, save the result, tell the admin
 *
 * After an unfinished step the job calls itself again (/api/cron?job=lab).
 * The hourly cron also continues a job that got stuck.
 */

const axios = require('axios');
const store = require('../lib/redis');
const mt = require('../lib/metaapi');
const tg = require('../lib/telegram');
const cfg = require('../config');
const lab = require('./lab');
const autoTrader = require('./autoTrader');

const JOB = 'fx:lab:job';
const DATA = (s) => `fx:labdata:${s}`;
const BARS = 2700;
const BUDGET_MS = 40000;

const pack = (d) => JSON.stringify({ cost: d.cost, c: d.candles.map(x => [x.time, x.open, x.high, x.low, x.close]) });
const unpack = (s) => { const o = JSON.parse(s); return { cost: o.cost, candles: o.c.map(([time, open, high, low, close]) => ({ time, open, high, low, close })) }; };

async function start(requestedBy) {
  for (const s of cfg.symbols()) await store.cmd('DEL', DATA(s));
  await store.setJSON(JOB, { status: 'running', requestedBy: String(requestedBy || ''), startedAt: new Date().toISOString(), log: [] });
}

async function job() { return store.getJSON(JOB); }

/** One step. Returns { finished, result?, progress }. */
async function step({ now = Date.now, selfCall = true } = {}) {
  const j = await job();
  if (!j || j.status !== 'running') return { finished: true, idle: true };
  if (!(await store.lock('fx:lock:lab', 58))) return { finished: false, busy: true };
  const t0 = now();
  try {
    const acct = await autoTrader.dataAccount();
    const symbols = cfg.symbols();
    let have = 0;
    for (const s of symbols) {
      if (await store.cmd('EXISTS', DATA(s))) { have++; continue; }
      if (now() - t0 > BUDGET_MS) break;
      const loaded = await lab.loadData(acct, [s], BARS, (m) => j.log.push(m));
      if (loaded[s]) await store.cmd('SET', DATA(s), pack(loaded[s]), 'EX', 24 * 3600);
      else await store.cmd('SET', DATA(s), JSON.stringify({ skip: true }), 'EX', 24 * 3600);
      have++;
    }
    if (have < symbols.length) {
      await store.setJSON(JOB, j);
      if (selfCall) await kick();
      return { finished: false, progress: `${have}/${symbols.length}` };
    }

    const data = {};
    for (const s of symbols) {
      const raw = await store.cmd('GET', DATA(s));
      if (!raw) continue;
      const o = JSON.parse(raw);
      if (!o.skip) data[s] = unpack(raw);
    }
    const result = lab.runLab(data);
    await lab.saveResult(result);
    await store.setJSON(JOB, { ...j, status: 'done', finishedAt: new Date().toISOString() });
    const to = j.requestedBy || process.env.TELEGRAM_CHAT_ID;
    if (to) await tg.sendLong(to, lab.summary(result));
    return { finished: true, result };
  } catch (err) {
    await store.setJSON(JOB, { ...j, status: 'failed', error: err.message });
    const to = j.requestedBy || process.env.TELEGRAM_CHAT_ID;
    if (to) await tg.send(to, `❌ Lab failed: ${err.message}`, { plain: true });
    return { finished: true, error: err.message };
  } finally {
    await store.cmd('DEL', 'fx:lock:lab').catch(() => {});
  }
}

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

/** Fire-and-forget call to continue the job in a fresh function. */
/** The cron endpoint answers at once and runs the step in the background. */
async function kick() {
  const base = baseUrl();
  if (!base || !process.env.CRON_SECRET) return;
  await axios.get(`${base}/api/cron`, { params: { job: 'lab' }, headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, timeout: 8000 }).catch(() => {});
}

module.exports = { start, step, job, pack, unpack };
