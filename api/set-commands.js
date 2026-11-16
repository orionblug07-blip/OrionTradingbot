/**
 * Open once after deploying:  /api/set-commands?key=CRON_SECRET
 * Registers the webhook (with its secret) and the command menu.
 */
const { requireAdminKey } = require('../src/lib/auth');
const tg = require('../src/lib/telegram');

const COMMANDS = [
  ['menu', 'Main menu'],
  ['status', 'Account, balance, auto-trading'],
  ['positions', 'Open trades'],
  ['signals', "Today's signals"],
  ['strategy', 'Strategy and test results'],
  ['results', "How the bot's trades went"],
  ['connect', 'Link your MT5 account'],
  ['help', 'All commands'],
];

module.exports = async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = (process.env.PUBLIC_BASE_URL || `https://${host}`).replace(/\/$/, '');
  try {
    const hook = await tg.call('setWebhook', {
      url: `${base}/api/telegram-webhook`,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }, 30000);
    const cmds = await tg.call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }, 30000);
    return res.status(200).json({ ok: true, webhook: `${base}/api/telegram-webhook`, setWebhook: hook, setMyCommands: cmds });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
