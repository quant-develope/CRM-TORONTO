// Телефония через Twilio. Клиент звонит на торонтовский номер → Twilio спрашивает /twilio/voice, что делать со звонком.
// CRM записывает номер, показывает уведомление Quant и КЦ и переадресует звонок на телефоны операторов (если они указаны).
// Из звонка КЦ одной кнопкой начинает заявку с уже подставленным номером.
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can } = require('../roles');
const { html, escape, utcToLocal, when, phoneLink } = require('../html');
const { addEvent } = require('../push');

const CALL_STATUS = {
  ringing: ['Звонит', 'blue'],
  answered: ['Принят', 'green'],
  missed: ['Пропущен — перезвонить', 'red'],
  called_back: ['Перезвонили', 'gray'],
};

// Последние 10 цифр: так «+1 (416) 555-0100», «416-555-0100» и «+14165550100» считаются одним номером.
const digits10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const PHONE_SQL = "substr(replace(replace(replace(replace(replace(replace(client_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), -10)";

// «+14165550100» → «+1 416 555-0100».
function prettyPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `+1 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6)}`;
  return d.length >= 7 ? phone : '';
}

// Последняя заявка с этого номера — чтобы узнать постоянного клиента.
function lastOrderFor(phone) {
  const d = digits10(phone);
  if (d.length < 10) return undefined;
  return get(`SELECT * FROM orders WHERE ${PHONE_SQL} = ? ORDER BY id DESC LIMIT 1`, d);
}

// Номера операторов для переадресации хранятся в settings (их меняет Quant на странице «Звонки»).
async function forwardNumbers() {
  const row = await get("SELECT value FROM settings WHERE key = 'call_forward'");
  return String(row ? row.value : '').split(/[\s,;]+/).map(normalizePhone).filter(Boolean);
}

// Номер в формате E.164: «416 555 0100» → «+14165550100».
function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length >= 11) return `+${d}`;
  return '';
}

// --- Запросы от Twilio (без входа в CRM, но с проверкой подписи) ---

const twilio = new Router();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// Подпись X-Twilio-Signature: HMAC-SHA1 от полного адреса и всех параметров формы, отсортированных по имени.
async function validTwilio(req) {
  const token = req.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  if (!token || !signature) return false;
  const data = req.url.href + Object.keys(req.body).sort().map((k) => k + req.body[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const expected = b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const twiml = (res, body) => {
  res.headers.set('content-type', 'text/xml; charset=utf-8');
  return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
};

const SAY_BUSY = '<Say voice="Polly.Joanna">Thank you for calling. All our operators are busy right now. We will call you back shortly.</Say><Hangup/>';

twilio.use(async (req, res, next) => {
  if (req.method !== 'POST' || !(await validTwilio(req))) return res.status(403).send('Forbidden');
  next();
});

// Входящий звонок.
twilio.post('/voice', async (req, res) => {
  const from = String(req.body.From || '');
  const sid = String(req.body.CallSid || '');
  const numbers = await forwardNumbers();
  const status = numbers.length ? 'ringing' : 'missed';
  const { changes, lastInsertRowid } = await run('INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, status) VALUES (?, ?, ?, ?)',
    sid, from, String(req.body.To || ''), status);
  if (changes) {
    const client = await lastOrderFor(from);
    await addEvent(req, {
      status: 'call',
      title: `📞 Звонок ${prettyPhone(from) || 'со скрытого номера'}`,
      body: client ? `${client.client_name || 'Клиент'} · ${client.address} · нажмите, чтобы создать заявку` : 'Новый клиент · нажмите, чтобы создать заявку',
      url: `/orders/new?call=${lastInsertRowid}`,
    });
  }
  if (!numbers.length) return twiml(res, SAY_BUSY);
  // Звонят все телефоны операторов сразу, разговор достаётся тому, кто ответил первым. На экране оператора — номер клиента.
  const callerId = /^\+\d{8,15}$/.test(from) ? ` callerId="${escape(from)}"` : '';
  twiml(res, `<Dial${callerId} timeout="25" action="/twilio/dial-done">${numbers.map((n) => `<Number>${escape(n)}</Number>`).join('')}</Dial>`);
});

// Переадресация закончилась: оператор поговорил или никто не ответил.
twilio.post('/dial-done', async (req, res) => {
  const answered = req.body.DialCallStatus === 'completed';
  const call = await get('SELECT * FROM calls WHERE call_sid = ?', String(req.body.CallSid || ''));
  if (call && call.status === 'ringing') {
    await run('UPDATE calls SET status = ? WHERE id = ?', answered ? 'answered' : 'missed', call.id);
    if (!answered) {
      await addEvent(req, {
        status: 'call',
        title: `Пропущенный звонок ${prettyPhone(call.from_number)}`,
        body: 'Никто не ответил — перезвоните клиенту',
        url: '/calls',
      });
    }
  }
  twiml(res, answered ? '<Hangup/>' : SAY_BUSY);
});

// Звонок закончился (Call status changes в настройках номера). Если клиент положил трубку, пока звонили операторы, — пропущен.
twilio.post('/status', async (req, res) => {
  if (req.body.CallStatus === 'completed' || req.body.CallStatus === 'no-answer' || req.body.CallStatus === 'busy') {
    await run("UPDATE calls SET status = 'missed' WHERE call_sid = ? AND status = 'ringing'", String(req.body.CallSid || ''));
  }
  res.status(204).send('');
});

// --- Страница «Звонки» для Quant и КЦ ---

const calls = new Router();

calls.use((req, res, next) => (can.manageOrders(req.user) ? next() : res.denied()));

const callFlag = (status) => {
  const [label, color] = CALL_STATUS[status] || [status, 'gray'];
  return html`<span class="flag flag-${color}"><i></i>${label}</span>`;
};

calls.get('/', async (req, res) => {
  // Звонок, который «звонит» дольше 3 минут, на самом деле закончился без ответа.
  await run("UPDATE calls SET status = 'missed' WHERE status = 'ringing' AND created_at < datetime('now', '-3 minutes')");
  const rows = await all('SELECT * FROM calls ORDER BY id DESC LIMIT 200');
  const known = new Map();
  for (const c of rows) {
    const d = digits10(c.from_number);
    if (!known.has(d)) known.set(d, await lastOrderFor(c.from_number));
  }
  const missed = rows.filter((c) => c.status === 'missed').length;
  const numbers = await forwardNumbers();
  const quant = can.manageStaff(req.user);
  res.page('Звонки', html`
${req.env.TWILIO_AUTH_TOKEN ? '' : html`<p class="notice">Телефония ещё не подключена: в Cloudflare нет секрета <b>TWILIO_AUTH_TOKEN</b>. Инструкция — в README, раздел «Телефония».</p>`}
${missed ? html`<p class="notice">Пропущенных звонков: <b>${missed}</b> — нужно перезвонить.</p>` : ''}
${rows.length ? html`<div class="table-wrap"><table>
<tr><th>Время</th><th>Номер</th><th>Клиент</th><th>Звонок</th><th>Заявка</th></tr>
${rows.map((c) => {
    const client = known.get(digits10(c.from_number));
    return html`<tr>
  <td class="nowrap">${when(utcToLocal(c.created_at))}</td>
  <td class="nowrap">${prettyPhone(c.from_number) ? phoneLink(prettyPhone(c.from_number)) : 'скрытый номер'}</td>
  <td>${client ? html`${client.client_name || '—'}<br><span class="muted small">${client.address}</span>` : html`<span class="muted">новый</span>`}</td>
  <td>${callFlag(c.status)}${c.status === 'missed' ? html`<form method="post" action="/calls/${c.id}/called-back" class="inline"><button class="secondary small">Перезвонили</button></form>` : ''}</td>
  <td class="nowrap">${c.order_id ? html`<a href="/orders/${c.order_id}">№${c.order_id}</a>` : html`<a href="/orders/new?call=${c.id}" class="button small">Создать заявку</a>`}</td>
</tr>`;
  })}
</table></div>` : html`<p class="muted">Звонков пока не было.</p>`}
<h2>Переадресация</h2>
<p class="muted">Звонок на номер CRM переадресуется на эти телефоны: звонят все сразу, разговор у того, кто ответил первым.
Если никто не ответил за 25 секунд, клиенту говорят, что ему перезвонят, а звонок попадает в пропущенные.
${numbers.length ? '' : 'Сейчас номеров нет — клиенту сразу говорят, что ему перезвонят.'}</p>
${quant ? html`<form method="post" action="/calls/forward" class="grid">
  <label class="wide">Телефоны операторов (через запятую)<input name="numbers" value="${numbers.map(prettyPhone).join(', ')}" placeholder="+1 416 555-0100, +1 647 555-0101" autocomplete="off"></label>
  <div><button>Сохранить</button></div>
</form>` : html`<p>${numbers.length ? numbers.map(prettyPhone).join(', ') : '—'} <span class="muted small">(меняет Quant)</span></p>`}`, { refresh: 30 });
});

calls.post('/forward', async (req, res) => {
  if (!can.manageStaff(req.user)) return res.denied();
  const numbers = String(req.body.numbers || '').split(/[,;\n]+/).map(normalizePhone).filter(Boolean);
  await run("INSERT INTO settings (key, value) VALUES ('call_forward', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", numbers.join(','));
  res.flash(numbers.length ? `Переадресация: ${numbers.map(prettyPhone).join(', ')}.` : 'Переадресация выключена.');
  res.redirect('/calls');
});

calls.post('/:id/called-back', async (req, res) => {
  await run("UPDATE calls SET status = 'called_back' WHERE id = ? AND status = 'missed'", req.params.id);
  res.redirect('/calls');
});

// Для формы новой заявки: номер звонка и данные клиента из его прошлой заявки.
async function callPrefill(callId) {
  const call = await get('SELECT * FROM calls WHERE id = ?', Number(callId) || 0);
  if (!call) return null;
  const client = await lastOrderFor(call.from_number);
  return {
    call,
    order: {
      client_phone: prettyPhone(call.from_number),
      client_name: client ? client.client_name : '',
      address: client ? client.address : '',
    },
  };
}

module.exports = { twilio, calls, callPrefill };
