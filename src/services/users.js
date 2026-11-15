/**
 * ─── Who may use the bot ─────────────────────────────────────────────────────
 * fx:users HASH chatId → JSON { status: pending|approved|blocked, name, username, at }
 * The admin (TELEGRAM_CHAT_ID) is always approved. Everyone else asks once and
 * waits for the admin's `approve ID`.
 */
const store = require('../lib/redis');

const KEY = 'fx:users';
const adminId = () => String(process.env.TELEGRAM_CHAT_ID || '');
const isAdmin = (chatId) => !!adminId() && String(chatId) === adminId();

async function get(chatId) {
  const raw = await store.cmd('HGET', KEY, String(chatId));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function set(chatId, data) {
  await store.cmd('HSET', KEY, String(chatId), JSON.stringify({ ...data, at: new Date().toISOString() }));
}

/** @returns {'approved'|'pending'|'blocked'|'new'} */
async function access(chatId) {
  if (isAdmin(chatId)) return 'approved';
  const u = await get(chatId);
  return u ? u.status : 'new';
}

async function request(chatId, from = {}) {
  await set(chatId, { status: 'pending', name: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username || '' });
}

async function setStatus(chatId, status) {
  const u = (await get(chatId)) || {};
  await set(chatId, { ...u, status });
  return u;
}

async function list() {
  const h = store.hashToObject(await store.cmd('HGETALL', KEY));
  return Object.entries(h).map(([id, v]) => { try { return { id, ...JSON.parse(v) }; } catch { return { id }; } });
}

module.exports = { isAdmin, access, request, setStatus, list, get };
