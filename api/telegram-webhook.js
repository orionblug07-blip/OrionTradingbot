/**
 * Telegram webhook. Answers Telegram at once (so it never re-sends an update)
 * and handles the message in the background.
 */
const { verifyTelegramWebhook } = require('../src/lib/auth');
const { deferUntilAfterResponse } = require('../src/lib/background');
const store = require('../src/lib/redis');
const { handleUpdate } = require('../src/bot/commands');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'JijazyFX webhook' });
  if (!verifyTelegramWebhook(req)) return res.status(401).json({ ok: false });
  const update = req.body || {};

  // Telegram can deliver the same update twice — handle each one once.
  if (update.update_id != null) {
    const fresh = await store.cmd('SET', `fx:upd:${update.update_id}`, '1', 'NX', 'EX', 3600).catch(() => 'OK');
    if (fresh !== 'OK') return res.status(200).json({ ok: true, duplicate: true });
  }

  const work = handleUpdate(update).catch(err => console.error('[webhook]', err));
  if (deferUntilAfterResponse(work)) return res.status(200).json({ ok: true });
  await work;
  return res.status(200).json({ ok: true });
};
