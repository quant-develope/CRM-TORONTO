// OpenPhone (Quo): звонки и SMS с номеров OpenPhone попадают в «Звонки» через webhook.
// В OpenPhone: Settings → Integrations → Webhooks → новый webhook на https://<адрес CRM>/openphone/webhook,
// события call.ringing, call.completed, call.recording.completed, call.transcript.completed, message.received.
// Signing secret webhook-а — секрет OPENPHONE_WEBHOOK_SECRET в Cloudflare.
const { Router } = require('../mini');
const { get, run } = require('../db');
const { addEvent } = require('../push');
const { prettyPhone, lineFor, ensureClient } = require('./clients');

const r = new Router();

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmacB64(secret, data) {
  const key = await crypto.subtle.importKey('raw', b64ToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))));
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Подпись: старая схема «openphone-signature: hmac;1;<время>;<подпись>» (webhook из приложения)
// или новая «webhook-id / webhook-timestamp / webhook-signature: v1,<подпись>» (webhook через API, секрет whsec_…).
async function signatureOk(req, raw) {
  const secret = String(req.env.OPENPHONE_WEBHOOK_SECRET || '').replace(/^whsec_/, '');
  if (!secret) return false;
  const legacy = req.headers['openphone-signature'];
  if (legacy) {
    const [, , ts, sig] = String(legacy).split(';');
    return Boolean(ts && sig) && same(await hmacB64(secret, `${ts}.${raw}`), sig);
  }
  const id = req.headers['webhook-id'];
  const ts = req.headers['webhook-timestamp'];
  const sigs = String(req.headers['webhook-signature'] || '').split(' ').filter((s) => s.startsWith('v1,')).map((s) => s.slice(3));
  if (!id || !ts || !sigs.length) return false;
  const expected = await hmacB64(secret, `${id}.${ts}.${raw}`);
  return sigs.some((s) => same(expected, s));
}

// Поля звонка и сообщения: старый формат — data.object, новый — data.resource + data.context.
function payload(event) {
  const d = event.data || {};
  const o = d.object || d.resource || {};
  const ctx = d.context || {};
  return {
    id: String(o.callId || o.id || ''),
    direction: o.direction || ctx.direction || '',
    from: String(o.from || ctx.senderIdentifier || ''),
    to: String(Array.isArray(o.to) ? o.to[0] : o.to || (ctx.recipientIdentifiers || [])[0] || ''),
    status: o.status || '',
    duration: Number(o.duration || 0),
    media: o.media || [],
    voicemail: o.voicemail || null,
    text: String(o.body || o.text || ''),
    dialogue: o.dialogue || [],
  };
}

r.post('/webhook', async (req, res) => {
  const raw = await req.raw.text();
  if (!(await signatureOk(req, raw))) {
    await run("INSERT INTO settings (key, value) VALUES ('call_error', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      `${new Date().toISOString().slice(0, 19).replace('T', ' ')} OpenPhone: подпись не совпала или нет секрета OPENPHONE_WEBHOOK_SECRET`);
    return res.status(403).send('Forbidden');
  }
  let event;
  try { event = JSON.parse(raw); } catch (err) { return res.status(400).send('Bad JSON'); }
  const type = String(event.type || '');
  const p = payload(event);
  const outgoing = p.direction === 'outgoing';
  // Клиент — второй участник; наш номер OpenPhone — тот, что принадлежит оператору.
  const clientPhone = outgoing ? p.to : p.from;
  const ourNumber = outgoing ? p.from : p.to;

  if (type === 'message.received') {
    await run('INSERT INTO sms (from_number, to_number, body) VALUES (?, ?, ?)', p.from, p.to, p.text);
    await addEvent(req, { status: 'call', title: `✉️ SMS ${prettyPhone(p.from) || p.from}`, body: p.text, url: '/calls' });
    return res.status(204).send('');
  }

  if (!type.startsWith('call.') || !p.id) return res.status(204).send('');
  const sid = `op:${p.id}`;
  let call = await get('SELECT * FROM calls WHERE call_sid = ?', sid);
  if (!call) {
    const line = await lineFor(ourNumber);
    const client = await ensureClient({ phone: clientPhone, ownerId: line ? line.user_id : null, firstNumber: outgoing ? '' : ourNumber });
    await run(`INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, status, client_id, source, note)
               VALUES (?, ?, ?, 'ringing', ?, 'OpenPhone', ?)`, sid, clientPhone, ourNumber, client ? client.id : null, outgoing ? 'Исходящий' : '');
    call = await get('SELECT * FROM calls WHERE call_sid = ?', sid);
    if (!outgoing && call) {
      await addEvent(req, {
        status: 'call',
        title: `📞 Звонок ${prettyPhone(clientPhone) || 'со скрытого номера'} (OpenPhone)`,
        body: `${client && client.name ? `${client.name} · ` : 'Новый клиент · '}нажмите, чтобы создать заявку`,
        url: `/orders/new?call=${call.id}`,
      });
    }
  }
  if (!call) return res.status(204).send('');

  if (type === 'call.completed') {
    const answered = p.status === 'completed' && p.duration > 0 && !p.voicemail;
    await run("UPDATE calls SET status = ? WHERE id = ? AND status IN ('ringing', 'missed', 'answered')", answered || outgoing ? 'answered' : 'missed', call.id);
  }
  const media = (p.media[0] && p.media[0].url) || (p.voicemail && p.voicemail.url);
  if (media && (type === 'call.recording.completed' || type === 'call.completed')) {
    await run('UPDATE calls SET recording_url = ? WHERE id = ?', String(media), call.id);
  }
  if (type === 'call.transcript.completed' && p.dialogue.length) {
    const text = p.dialogue.map((line) => String(line.content || '')).filter(Boolean).join(' ').slice(0, 2000);
    await run('UPDATE calls SET transcript = ? WHERE id = ?', text, call.id);
  }
  res.status(204).send('');
});

module.exports = r;
