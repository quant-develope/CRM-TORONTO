// Уведомления: журнал событий (для всплывающих уведомлений в приложении) и Web Push на телефоны.
// Push отправляется без содержимого: телефон просыпается, service worker сам забирает текст события с сайта (/api/events).
// Так не нужно шифровать сообщения, а ключи VAPID создаются сами и хранятся в базе.
const { get, all, run } = require('./db');
const { OFFICE, STATUS, PAY_HOW, paidAmount, paidMethod, paidDiffers } = require('./roles');
const { fullName, money } = require('./html');

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const textB64 = (s) => b64url(new TextEncoder().encode(s));

let vapid = null;

// Ключи VAPID: создаются при первом обращении и сохраняются в settings.
async function vapidKeys() {
  if (vapid) return vapid;
  let row = await get("SELECT value FROM settings WHERE key = 'vapid'");
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const value = JSON.stringify({
      privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    });
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)", value);
    row = await get("SELECT value FROM settings WHERE key = 'vapid'");
  }
  const { privateJwk, publicKey } = JSON.parse(row.value);
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  vapid = { privateKey, publicKey };
  return vapid;
}

async function vapidHeader(endpoint, subject) {
  const { privateKey, publicKey } = await vapidKeys();
  const header = textB64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = textB64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

// Отправить push на все устройства этих людей. Устройства, которые отписались, удаляются.
async function pushTo(userIds, origin) {
  if (!userIds.length) return;
  const subs = await all(`SELECT * FROM push_subs WHERE user_id IN (${userIds.map(() => '?').join(', ')})`, ...userIds);
  await Promise.all(subs.map(async (s) => {
    try {
      const response = await fetch(s.endpoint, {
        method: 'POST',
        headers: { authorization: await vapidHeader(s.endpoint, origin), ttl: '3600', urgency: 'high', 'content-length': '0' },
      });
      if (response.status === 404 || response.status === 410) await run('DELETE FROM push_subs WHERE id = ?', s.id);
    } catch (err) {
      console.error('push', err);
    }
  }));
}

// Событие по заявке. target — водитель (новая заявка) или null — все Quant и КЦ (водитель сменил статус).
async function notify(req, { order, status, target = null }) {
  const driver = order.driver_id ? await get('SELECT first_name, last_name, login FROM users WHERE id = ?', order.driver_id) : null;
  const title = target
    ? `Новая заявка №${order.id}`
    : `${fullName(driver)}: ${(STATUS[status] || [status])[0]}`;
  const body = target
    ? `${order.arrive_at ? `${order.arrive_at.slice(11, 16)} · ` : ''}${order.address}`
    : `Заявка №${order.id} · ${order.address}${status === 'done' ? ` · ${money(paidAmount(order))} ${PAY_HOW[paidMethod(order)]}${paidDiffers(order) ? ` (в заявке ${money(order.price)} ${PAY_HOW[order.pay_method]})` : ''}` : ''}`;
  const url = target ? `/jobs/${order.id}` : `/orders/${order.id}`;
  await addEvent(req, { orderId: order.id, status, target, title, body, url });
}

// Записать событие и разбудить телефоны. target — один человек или null — все Quant и КЦ.
async function addEvent(req, { orderId = null, status = '', target = null, title, body = '', url = '/' }) {
  await run('INSERT INTO events (order_id, status, target_user_id, title, body, url) VALUES (?, ?, ?, ?, ?, ?)',
    orderId, status, target, title, body, url);
  await run("DELETE FROM events WHERE created_at < datetime('now', '-7 days')");
  const userIds = target ? [target]
    : (await all(`SELECT id FROM users WHERE role IN (${OFFICE.map(() => '?').join(', ')}) AND active = 1`, ...OFFICE)).map((u) => u.id);
  req.waitUntil(pushTo(userIds, req.url.origin));
}

// События, которые видит этот человек: Quant и КЦ — смены статусов, водитель — свои новые заявки.
function eventsFor(user, after, limit = 20) {
  const staff = OFFICE.includes(user.role);
  return all(`SELECT id, order_id, status, title, body, url, created_at FROM events
              WHERE id > ? AND ${staff ? 'target_user_id IS NULL' : 'target_user_id = ?'} ORDER BY id DESC LIMIT ?`,
  ...[Number(after) || 0, ...(staff ? [] : [user.id]), limit]);
}

async function lastEventId(user) {
  const [last] = await eventsFor(user, 0, 1);
  return last ? last.id : 0;
}

module.exports = { notify, addEvent, eventsFor, lastEventId, vapidKeys };
