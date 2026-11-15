/**
 * Setup check:  /api/health?key=CRON_SECRET
 * Shows which settings are missing and whether Telegram, Upstash and MetaApi answer.
 */
const { requireAdminKey } = require('../src/lib/auth');
const store = require('../src/lib/redis');
const tg = require('../src/lib/telegram');
const box = require('../src/lib/secretBox');
const mt = require('../src/lib/metaapi');
const lab = require('../src/services/lab');
const autoTrader = require('../src/services/autoTrader');

module.exports = async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const need = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'CRON_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'TRADING_ENCRYPTION_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'METAAPI_TOKEN'];
  const out = { missing: need.filter(k => !process.env[k]), encryptionKeyValid: box.isConfigured(), checks: {} };

  try { out.checks.telegram = (await tg.call('getWebhookInfo', {})).url || 'no webhook — open /api/set-commands'; } catch (err) { out.checks.telegram = `ERROR ${err.message}`; }
  try { await store.cmd('SET', 'fx:health', String(Date.now()), 'EX', 60); out.checks.upstash = store.isEnabled() ? 'ok' : 'NOT SET — using temporary memory'; } catch (err) { out.checks.upstash = `ERROR ${err.message}`; }
  try { const d = await autoTrader.dataAccount(); out.checks.dataAccount = d.id; await mt.accountInfo(d); out.checks.metaapi = 'ok'; } catch (err) { out.checks.metaapi = `${err.message}`; }
  try { const s = await lab.activeStrategy(); out.strategy = { id: s.id, verdict: s.verdict, testedAt: s.testedAt }; } catch (err) { out.strategy = err.message; }
  try { out.flags = await autoTrader.flags(); } catch { /* ignore */ }
  out.dryRun = String(process.env.AUTOTRADE_DRY_RUN || '').toLowerCase() === 'true';
  return res.status(200).json(out);
};
