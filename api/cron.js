/**
 * Scheduled jobs. Call every hour with the key, e.g. from cron-job.org:
 *   https://YOUR-APP.vercel.app/api/cron?key=CRON_SECRET
 *
 *   (default)   finish account connects in progress, continue a lab job, and
 *               run the daily auto-trading check (acts once per daily candle)
 *   ?job=lab    continue the lab job only (the lab calls this itself)
 *   ?force=1    run the daily check even if the candle was already handled
 */
const { requireCronKey } = require('../src/lib/auth');
const { deferUntilAfterResponse } = require('../src/lib/background');
const tg = require('../src/lib/telegram');
const accounts = require('../src/services/accounts');
const autoTrader = require('../src/services/autoTrader');
const labJob = require('../src/services/labJob');
const { CONNECT_HELP } = require('../src/bot/commands');

async function notifyConnect(chatId, account, error) {
  if (error) return tg.send(chatId, `❌ ${error}\n\n${CONNECT_HELP}`);
  return tg.send(chatId, `✅ Your MT5 account ${account.login} (${account.live ? 'REAL' : 'demo'}) is connected. Send \`status\` in a few minutes to see your balance, and \`auto on\` when you're ready.`);
}

module.exports = async (req, res) => {
  if (!requireCronKey(req, res)) return;
  const job = req.query?.job;

  if (job === 'lab') {
    const work = labJob.step().catch(err => console.error('[lab]', err));
    if (deferUntilAfterResponse(work)) return res.status(202).json({ ok: true, started: true });
    return res.status(200).json({ ok: true, result: await work });
  }

  const out = {};
  try { await accounts.retryPending(notifyConnect); out.connects = 'checked'; } catch (err) { out.connects = err.message; }
  try {
    const j = await labJob.job();
    if (j && j.status === 'running') out.lab = await labJob.step();
  } catch (err) { out.lab = err.message; }
  try { out.daily = await autoTrader.runDaily({ force: req.query?.force === '1' }); } catch (err) { out.daily = { error: err.message }; }
  if (out.lab && out.lab.result) out.lab = { finished: true };
  return res.status(200).json({ ok: true, ...out });
};
