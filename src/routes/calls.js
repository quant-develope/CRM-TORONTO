// Телефония через Twilio. Клиент звонит на торонтовский номер → Twilio спрашивает /twilio/voice, что делать со звонком.
// CRM записывает номер, показывает уведомление Quant и КЦ и переадресует звонок на телефоны операторов (если они указаны).
// Из звонка КЦ одной кнопкой начинает заявку с уже подставленным номером.
// Сюда же попадают заявки с сайтов (форма «Get a free quote»): их присылают сайты через SiteLeads (src/worker.js).
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can } = require('../roles');
const { html, whatsappButton, escape, date, utcToLocal, when, phoneLink, fullName, options } = require('../html');
const { addEvent } = require('../push');
const { digits10, prettyPhone, normalizePhone, lineFor, ensureClient, backfill } = require('./clients');

const CALL_STATUS = {
  ringing: ['Звонит', 'blue'],
  answered: ['Принят', 'green'],
  missed: ['Пропущен — перезвонить', 'red'],
  recorded: ['Записан (код)', 'orange'],
  called_back: ['Перезвонили', 'gray'],
  site: ['Заявка с сайта — позвонить', 'red'],
};
// Звонки и заявки, по которым нужно перезвонить клиенту.
const CALLBACK = ['missed', 'site'];

// Номера операторов для переадресации хранятся в settings (их меняет Quant на странице «Звонки»).
async function forwardNumbers() {
  const row = await get("SELECT value FROM settings WHERE key = 'call_forward'");
  return String(row ? row.value : '').split(/[\s,;]+/).map(normalizePhone).filter(Boolean);
}

// --- Запросы от Twilio (без входа в CRM, но с проверкой подписи) ---

const twilio = new Router();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// Подпись X-Twilio-Signature: HMAC-SHA1 от полного адреса и всех параметров формы, отсортированных по имени.
// SignalWire (совместим с Twilio) подписывает так же, своим Signing Key; заголовок может быть любым из двух.
// Возвращает пустую строку, если подпись верна, иначе — причину отказа.
async function signatureCheck(req) {
  const keys = [req.env.TWILIO_AUTH_TOKEN, req.env.SIGNALWIRE_SIGNING_KEY].filter(Boolean);
  const signatures = [req.headers['x-twilio-signature'], req.headers['x-signalwire-signature']].filter(Boolean);
  if (!keys.length) return 'в Cloudflare нет секрета TWILIO_AUTH_TOKEN или SIGNALWIRE_SIGNING_KEY';
  if (!signatures.length) return 'в запросе нет подписи';
  const data = req.url.href + Object.keys(req.body).sort().map((k) => k + req.body[k]).join('');
  for (const token of keys) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const expected = b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
    for (const signature of signatures) {
      if (expected.length !== signature.length) continue;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
      if (diff === 0) return '';
    }
  }
  return `подпись не совпала (секреты: ${[req.env.TWILIO_AUTH_TOKEN && 'TWILIO_AUTH_TOKEN', req.env.SIGNALWIRE_SIGNING_KEY && 'SIGNALWIRE_SIGNING_KEY'].filter(Boolean).join(', ')}; `
    + `заголовки: ${['x-twilio-signature', 'x-signalwire-signature'].filter((h) => req.headers[h]).join(', ')}; адрес: ${req.url.href})`;
}

const twiml = (res, body) => {
  res.headers.set('content-type', 'text/xml; charset=utf-8');
  return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
};

const SAY_BUSY = '<Say voice="woman">Thank you for calling. All our operators are busy right now. We will call you back shortly.</Say><Hangup/>';

twilio.use(async (req, res, next) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const problem = await signatureCheck(req);
  if (problem) {
    // Последний отказ виден на странице «Звонки» — чтобы понять, почему звонок не дошёл.
    console.error('twilio', problem);
    await run("INSERT INTO settings (key, value) VALUES ('call_error', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${problem}`);
    return res.status(403).send('Forbidden');
  }
  next();
});

// Режим «принять код»: Quant включает на 10 минут, звонки не переадресуются, а записываются и расшифровываются
// (например, сервис диктует код подтверждения). Срок хранится в settings как время UTC.
async function codeModeUntil() {
  const row = await get("SELECT value FROM settings WHERE key = 'code_mode_until'");
  return row && row.value > new Date().toISOString() ? row.value : '';
}

// Входящий звонок.
twilio.post('/voice', async (req, res) => {
  const from = String(req.body.From || '');
  const sid = String(req.body.CallSid || '');
  const to = String(req.body.To || '');
  if (req.body.AccountSid) await run("INSERT INTO settings (key, value) VALUES ('twilio_account', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(req.body.AccountSid));
  if (await codeModeUntil()) {
    await run("INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, status) VALUES (?, ?, ?, 'recorded')", sid, from, to);
    await addEvent(req, { status: 'call', title: `🎙 Записываю звонок ${prettyPhone(from) || 'со скрытого номера'}`, body: 'Режим «принять код»: расшифровка появится в «Звонках»', url: '/calls' });
    // Робот (например, WhatsApp) просит «нажмите 1, чтобы получить код»: ждём начала фразы и нажимаем 1 дважды с паузой 2 секунды.
    return twiml(res, '<Pause length="3"/><Play digits="1wwww1"/><Record maxLength="90" timeout="15" playBeep="false" trim="do-not-trim" action="/twilio/recorded" transcribe="true" transcribeCallback="/twilio/transcript"/><Hangup/>');
  }
  // Номер, на который позвонили, принадлежит оператору: клиент закрепляется за ним, звонок идёт на его личный телефон.
  const line = await lineFor(to);
  const personal = line ? normalizePhone(line.user_phone) : '';
  const numbers = personal ? [personal] : await forwardNumbers();
  const status = numbers.length ? 'ringing' : 'missed';
  const client = await ensureClient({ phone: from, ownerId: line ? line.user_id : null, firstNumber: to });
  const { changes, lastInsertRowid } = await run('INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, status, client_id) VALUES (?, ?, ?, ?, ?)',
    sid, from, to, status, client ? client.id : null);
  if (changes) {
    const owner = client && client.owner_id ? await get('SELECT first_name, last_name, login FROM users WHERE id = ?', client.owner_id) : null;
    const known = client && (client.name || client.address);
    await addEvent(req, {
      status: 'call',
      title: `📞 Звонок ${prettyPhone(from) || 'со скрытого номера'}`,
      body: `${known ? `${client.name || 'Клиент'}${client.address ? ` · ${client.address}` : ''}` : 'Новый клиент'}${owner ? ` · оператор ${fullName(owner)}` : ''} · нажмите, чтобы создать заявку`,
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

// Запись готова.
twilio.post('/recorded', async (req, res) => {
  const call = await get('SELECT * FROM calls WHERE call_sid = ?', String(req.body.CallSid || ''));
  if (call && req.body.RecordingUrl) {
    await run('UPDATE calls SET recording_url = ? WHERE id = ?', String(req.body.RecordingUrl), call.id);
    await addEvent(req, { status: 'call', title: `🎙 Запись звонка ${prettyPhone(call.from_number)}`, body: 'Нажмите, чтобы послушать', url: '/calls' });
  }
  twiml(res, '<Hangup/>');
});

// Расшифровка записи (Twilio присылает через минуту-две).
twilio.post('/transcript', async (req, res) => {
  const call = await get('SELECT * FROM calls WHERE call_sid = ?', String(req.body.CallSid || ''));
  const text = String(req.body.TranscriptionText || '').trim();
  if (call) {
    await run('UPDATE calls SET transcript = ? WHERE id = ?', text || '(не удалось расшифровать — послушайте запись)', call.id);
    await addEvent(req, { status: 'call', title: `Расшифровка звонка ${prettyPhone(call.from_number)}`, body: text || 'Не удалось расшифровать — послушайте запись', url: '/calls' });
  }
  res.status(204).send('');
});

// Входящее SMS (в Twilio: «A message comes in» → /twilio/sms).
twilio.post('/sms', async (req, res) => {
  const from = String(req.body.From || '');
  const body = String(req.body.Body || '');
  await run('INSERT INTO sms (from_number, to_number, body) VALUES (?, ?, ?)', from, String(req.body.To || ''), body);
  await addEvent(req, { status: 'call', title: `✉️ SMS ${prettyPhone(from) || from}`, body, url: '/calls' });
  twiml(res, '');
});

// Звонок закончился (Call status changes в настройках номера). Если клиент положил трубку, пока звонили операторы, — пропущен.
twilio.post('/status', async (req, res) => {
  if (req.body.CallStatus === 'completed' || req.body.CallStatus === 'no-answer' || req.body.CallStatus === 'busy') {
    await run("UPDATE calls SET status = 'missed' WHERE call_sid = ? AND status = 'ringing'", String(req.body.CallSid || ''));
  }
  res.status(204).send('');
});

// --- Заявка с сайта ---

const clip = (v, n = 200) => String(v || '').trim().slice(0, n);

// lead — поля формы сайта: name, phone, email, address, city, property, service, message, utm_*, gclid, page,
// site — адрес сайта, site_phone — номер на сайте (по нему находим оператора сайта, см. «Сайты»).
async function siteLead(req, lead) {
  const phone = normalizePhone(lead.phone) || clip(lead.phone, 30);
  if (digits10(phone).length < 10) throw new Error('site lead: phone is missing');
  const sitePhone = normalizePhone(lead.site_phone);
  const name = clip(lead.name, 80);
  const address = [clip(lead.address, 160), clip(lead.city, 60)].filter(Boolean).join(', ');
  const source = [lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term].map((v) => clip(v, 80)).filter(Boolean).join(' / ');
  const note = [
    lead.service && `Услуга: ${clip(lead.service)}`,
    lead.property && `Участок: ${clip(lead.property)}`,
    lead.message && `Комментарий: ${clip(lead.message, 1500)}`,
    lead.email && `Email: ${clip(lead.email, 120)}`,
    source && `Реклама: ${source}`,
    lead.gclid && 'Клик Google Ads',
  ].filter(Boolean).join('\n');
  const line = sitePhone ? await lineFor(sitePhone) : null;
  const client = await ensureClient({ phone, name, address, ownerId: line ? line.user_id : null, firstNumber: sitePhone });
  const { lastInsertRowid } = await run(`INSERT INTO calls (call_sid, from_number, to_number, status, client_id, source, lead_name, lead_address, note)
                                         VALUES (?, ?, ?, 'site', ?, ?, ?, ?, ?)`,
  `site-${crypto.randomUUID()}`, phone, sitePhone, client ? client.id : null, clip(lead.site, 120), name, address, note);
  await addEvent(req, {
    status: 'call',
    title: `🌐 Заявка с сайта ${clip(lead.site, 120)}`.trim(),
    body: `${name || 'Клиент'} · ${prettyPhone(phone) || phone}${address ? ` · ${address}` : ''}${lead.service ? ` · ${clip(lead.service)}` : ''} · нажмите, чтобы создать заявку`,
    url: `/orders/new?call=${lastInsertRowid}`,
  });
  return { ok: true, id: lastInsertRowid };
}

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
  await backfill();
  const rows = await all(`SELECT k.*, c.name AS client_name, c.address AS client_address, u.first_name, u.last_name, u.login
                          FROM calls k LEFT JOIN clients c ON c.id = k.client_id LEFT JOIN users u ON u.id = c.owner_id
                          ORDER BY k.id DESC LIMIT 200`);
  const lines = await all('SELECT l.*, u.first_name, u.last_name, u.login, u.phone FROM lines l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.number10');
  const missed = rows.filter((c) => c.status === 'missed').length;
  const fromSites = rows.filter((c) => c.status === 'site').length;
  const numbers = await forwardNumbers();
  const quant = can.manageCalls(req.user);
  const office = Object.fromEntries((await all("SELECT * FROM users WHERE active = 1 AND role IN ('quant', 'web', 'dispatcher') ORDER BY first_name"))
    .map((u) => [u.id, fullName(u)]));
  const lastError = quant ? await get("SELECT value FROM settings WHERE key = 'call_error'") : null;
  const codeUntil = await codeModeUntil();
  const sms = await all('SELECT * FROM sms ORDER BY id DESC LIMIT 30');
  res.page('Звонки', html`
${quant ? html`<div class="notice">
  ${codeUntil ? html`<b>Режим «принять код» включён</b> до ${date(utcToLocal(codeUntil.slice(0, 19).replace('T', ' ')))}: звонки не переадресуются, а записываются и расшифровываются.
    <form method="post" action="/calls/code-mode" class="inline"><input type="hidden" name="off" value="1"><button class="secondary small">Выключить</button></form>`
    : html`<b>Принять код по звонку.</b> На 10 минут звонки не переадресуются: CRM сама берёт трубку, нажимает «1» (для кода WhatsApp), записывает до 90 секунд и показывает расшифровку здесь.
    <form method="post" action="/calls/code-mode" class="inline"><button class="small">Включить на 10 минут</button></form>`}
</div>` : ''}
${sms.length ? html`<h2>SMS</h2><div class="table-wrap"><table>
<tr><th>Время</th><th>От кого</th><th>Текст</th></tr>
${sms.map((m) => html`<tr><td class="nowrap">${when(utcToLocal(m.created_at))}</td><td class="nowrap">${prettyPhone(m.from_number) || m.from_number}</td><td><b>${m.body}</b></td></tr>`)}
</table></div><h2>Звонки</h2>` : ''}
${req.env.TWILIO_AUTH_TOKEN || req.env.SIGNALWIRE_SIGNING_KEY ? '' : html`<p class="notice">Телефония ещё не подключена: в Cloudflare нет секрета <b>TWILIO_AUTH_TOKEN</b>. Инструкция — в README, раздел «Телефония».</p>`}
${lastError ? html`<p class="notice">Последний отклонённый звонок: ${date(utcToLocal(lastError.value.slice(0, 19)))} — ${lastError.value.slice(20)}
  <form method="post" action="/calls/clear-error" class="inline"><button class="secondary small">Скрыть</button></form></p>` : ''}
${missed ? html`<p class="notice">Пропущенных звонков: <b>${missed}</b> — нужно перезвонить.</p>` : ''}
${fromSites ? html`<p class="notice">Заявок с сайтов ждут звонка: <b>${fromSites}</b>.</p>` : ''}
${rows.length ? html`<div class="table-wrap"><table>
<tr><th>Время</th><th>Номер</th><th>Клиент</th><th>Звонок</th><th>Заявка</th></tr>
${rows.map((c) => html`<tr>
  <td class="nowrap">${when(utcToLocal(c.created_at))}</td>
  <td class="nowrap">${prettyPhone(c.from_number) ? html`${phoneLink(prettyPhone(c.from_number))} ${whatsappButton(c.from_number, { small: true })}` : 'скрытый номер'}</td>
  <td>${c.client_id ? html`<a href="/clients/${c.client_id}">${c.client_name || 'Без имени'}</a>${c.client_address ? html`<br><span class="muted small">${c.client_address}</span>` : ''}${c.login ? html`<br><span class="muted small">оператор ${fullName(c)}</span>` : ''}` : html`<span class="muted">—</span>`}</td>
  <td>${callFlag(c.status)}${c.recording_url ? html` <a href="/calls/${c.id}/recording" target="_blank">▶ запись</a>` : ''}${c.transcript ? html`<br><b>${c.transcript}</b>` : c.status === 'recorded' ? html`<br><span class="muted small">расшифровка через 1–2 минуты</span>` : ''}${c.source ? html`<br><span class="muted small">🌐 ${c.source}</span>` : ''}${c.note ? html`<div class="small" style="white-space: pre-line">${c.note}</div>` : ''}${CALLBACK.includes(c.status) ? html`<form method="post" action="/calls/${c.id}/called-back" class="inline"><button class="secondary small">Перезвонили</button></form>` : ''}</td>
  <td class="nowrap">${c.order_id ? html`<a href="/orders/${c.order_id}">№${c.order_id}</a>` : html`<a href="/orders/new?call=${c.id}" class="button small">Создать заявку</a>`}</td>
</tr>`)}
</table></div>` : html`<p class="muted">Звонков пока не было.</p>`}
<h2>Номера и операторы</h2>
<p class="muted">Клиент, позвонивший на номер оператора, закрепляется за этим оператором, а звонок идёт на его личный телефон (из карточки сотрудника).
Номера, которых здесь нет, ищутся среди номеров сайтов («Сайты» → кто ведёт).</p>
${lines.length ? html`<div class="table-wrap"><table>
<tr><th>Номер</th><th>Оператор</th><th>Звонок идёт на</th>${quant ? html`<th></th>` : ''}</tr>
${lines.map((l) => html`<tr><td class="nowrap">${prettyPhone(l.number)}</td><td>${l.user_id ? fullName(l) : '—'}</td>
  <td class="nowrap">${l.phone ? prettyPhone(l.phone) || l.phone : html`<span class="muted">телефона нет — на общую переадресацию</span>`}</td>
  ${quant ? html`<td><form method="post" action="/calls/lines/delete" class="inline"><input type="hidden" name="number10" value="${l.number10}"><button class="secondary small">Убрать</button></form></td>` : ''}</tr>`)}
</table></div>` : html`<p class="muted">Номера пока не привязаны.</p>`}
${quant ? html`<form method="post" action="/calls/lines" class="grid">
  <label>Номер телефонии<input name="number" type="tel" placeholder="+1 416 555-0100" required autocomplete="off"></label>
  <label>Оператор<select name="user_id" required>${options(office, null, { empty: '— выберите —' })}</select></label>
  <div><button>Привязать</button></div>
</form>` : ''}

<h2>Общая переадресация</h2>
<p class="muted">Звонок на номер без оператора переадресуется на эти телефоны: звонят все сразу, разговор у того, кто ответил первым.
Если никто не ответил за 25 секунд, клиенту говорят, что ему перезвонят, а звонок попадает в пропущенные.
${numbers.length ? '' : 'Сейчас номеров нет — клиенту сразу говорят, что ему перезвонят.'}</p>
${quant ? html`<form method="post" action="/calls/forward" class="grid">
  <label class="wide">Телефоны операторов (через запятую)<input name="numbers" value="${numbers.map(prettyPhone).join(', ')}" placeholder="+1 416 555-0100, +1 647 555-0101" autocomplete="off"></label>
  <div><button>Сохранить</button></div>
</form>` : html`<p>${numbers.length ? numbers.map(prettyPhone).join(', ') : '—'} <span class="muted small">(меняют Quant и Веб)</span></p>`}`, { refresh: 30 });
});

calls.post('/forward', async (req, res) => {
  if (!can.manageCalls(req.user)) return res.denied();
  const numbers = String(req.body.numbers || '').split(/[,;\n]+/).map(normalizePhone).filter(Boolean);
  await run("INSERT INTO settings (key, value) VALUES ('call_forward', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", numbers.join(','));
  res.flash(numbers.length ? `Переадресация: ${numbers.map(prettyPhone).join(', ')}.` : 'Переадресация выключена.');
  res.redirect('/calls');
});

calls.post('/lines', async (req, res) => {
  if (!can.manageCalls(req.user)) return res.denied();
  const number = normalizePhone(req.body.number);
  const userId = Number(req.body.user_id) || null;
  if (!number || !userId) {
    res.flash('Укажите номер и оператора.');
    return res.redirect('/calls');
  }
  await run('INSERT INTO lines (number10, number, user_id) VALUES (?, ?, ?) ON CONFLICT (number10) DO UPDATE SET number = excluded.number, user_id = excluded.user_id',
    digits10(number), number, userId);
  res.flash(`Номер ${prettyPhone(number)} привязан.`);
  res.redirect('/calls');
});

calls.post('/lines/delete', async (req, res) => {
  if (!can.manageCalls(req.user)) return res.denied();
  await run('DELETE FROM lines WHERE number10 = ?', String(req.body.number10 || ''));
  res.redirect('/calls');
});

calls.post('/code-mode', async (req, res) => {
  if (!can.manageCalls(req.user)) return res.denied();
  const until = req.body.off ? '' : new Date(Date.now() + 10 * 60e3).toISOString();
  await run("INSERT INTO settings (key, value) VALUES ('code_mode_until', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", until);
  res.flash(until ? 'Режим «принять код» включён на 10 минут.' : 'Режим «принять код» выключен.');
  res.redirect('/calls');
});

// Запись звонка: Twilio отдаёт её только с логином (Account SID + Auth Token), поэтому CRM скачивает и отдаёт сама.
calls.get('/:id/recording', async (req, res) => {
  const call = await get('SELECT recording_url FROM calls WHERE id = ?', Number(req.params.id) || 0);
  const account = await get("SELECT value FROM settings WHERE key = 'twilio_account'");
  if (!call || !call.recording_url) return res.status(404).send('Нет записи');
  const headers = account && req.env.TWILIO_AUTH_TOKEN ? { authorization: `Basic ${btoa(`${account.value}:${req.env.TWILIO_AUTH_TOKEN}`)}` } : {};
  const audio = await fetch(`${call.recording_url}.mp3`, { headers });
  if (!audio.ok) return res.status(502).send(`Twilio не отдал запись (${audio.status})`);
  res.raw(new Response(audio.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, no-store' } }));
});

calls.post('/clear-error', async (req, res) => {
  if (!can.manageCalls(req.user)) return res.denied();
  await run("DELETE FROM settings WHERE key = 'call_error'");
  res.redirect('/calls');
});

calls.post('/:id/called-back', async (req, res) => {
  await run("UPDATE calls SET status = 'called_back' WHERE id = ? AND status IN ('missed', 'site')", req.params.id);
  res.redirect('/calls');
});

// Для формы новой заявки: номер звонка и данные клиента из базы.
async function callPrefill(callId) {
  const call = await get('SELECT * FROM calls WHERE id = ?', Number(callId) || 0);
  if (!call) return null;
  const client = call.client_id ? await get('SELECT * FROM clients WHERE id = ?', call.client_id) : null;
  return {
    call,
    client,
    order: {
      client_phone: prettyPhone(call.from_number),
      // Заявка с сайта: имя, адрес и пожелания — из формы.
      client_name: call.lead_name || (client ? client.name : ''),
      address: call.lead_address || (client ? client.address : ''),
      task: call.note ? call.note.split('\n').filter((l) => !/^(Email|Реклама|Клик)/.test(l)).join('\n') : undefined,
    },
  };
}

module.exports = { twilio, calls, callPrefill, siteLead };
