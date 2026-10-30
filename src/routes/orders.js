// Заявки для КЦ и Quant: создать, назначить водителя, изменить, отменить.
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can, STATUS, STEPS, ACTIVE, PAY_METHODS, PAY_HOW, paidAmount, paidMethod, paidDiffers } = require('../roles');
const { html, raw, whatsappButton, fullName, date, when, nowLocal, todayLocal, money, phoneLink, mapsLink, statusFlag, options } = require('../html');
const { driversBoard, boardBlock, ACTIVE_SQL } = require('../board');
const { notify } = require('../push');
const { callPrefill } = require('./calls');
const { ensureClient } = require('./clients');
const { suggest, orderDistance, ageText, kmText, geocodeMany, driverPoints, requestGeo } = require('../geo');

const r = new Router();

r.use((req, res, next) => {
  if (!can.manageOrders(req.user)) return res.denied();
  next();
});

const FILTERS = {
  active: ['Активные', `o.status IN (${ACTIVE_SQL})`],
  done: ['Выполненные', "o.status = 'done'"],
  cancelled: ['Отменённые', "o.status = 'cancelled'"],
  all: ['Все', '1 = 1'],
};

r.get('/', async (req, res) => {
  const filter = FILTERS[req.query.status] ? req.query.status : 'active';
  const counts = Object.fromEntries(await Promise.all(Object.entries(FILTERS)
    .map(async ([key, [, where]]) => [key, (await get(`SELECT COUNT(*) AS n FROM orders o WHERE ${where}`)).n])));
  const order = filter === 'active' ? 'o.arrive_at, o.id' : 'COALESCE(o.done_at, o.cancelled_at, o.arrive_at) DESC, o.id DESC';
  const rows = await all(`SELECT o.*, u.first_name, u.last_name, u.login FROM orders o LEFT JOIN users u ON u.id = o.driver_id
                          WHERE ${FILTERS[filter][1]} ORDER BY ${order} LIMIT 300`);
  res.page('Заявки', html`
<div class="toolbar">
  <div class="fchips">${Object.entries(FILTERS).map(([key, [label]]) => html`<a href="/orders?status=${key}" class="fchip ${key === filter ? 'on' : ''}">${label} <b>${counts[key]}</b></a>`)}</div>
  <a href="/orders/new" class="button">+ Новая заявка</a>
</div>
${rows.length ? html`<div class="table-wrap"><table>
<tr><th>№</th><th>Приезд</th><th>Клиент</th><th>Адрес</th><th>Водитель</th><th>Договорённая цена</th><th>Работнику</th><th>Статус</th></tr>
${rows.map((o) => html`<tr>
  <td><a href="/orders/${o.id}">№${o.id}</a></td>
  <td class="nowrap">${when(o.arrive_at)}</td>
  <td>${o.client_name || '—'}<br><span class="small">${phoneLink(o.client_phone)}</span></td>
  <td>${o.address}</td>
  <td>${o.driver_id ? fullName(o) : '—'}</td>
  <td class="nowrap">${money(o.price)} <span class="muted small">${PAY_METHODS[o.pay_method]}</span>${paidDiffers(o) ? html`<br><span class="paid-diff">заплатил ${money(paidAmount(o))} ${PAY_HOW[paidMethod(o)]}</span>` : ''}</td>
  <td class="nowrap">${money(o.worker_pay)}</td>
  <td>${statusFlag(o.status)}</td>
</tr>`)}
</table></div>` : html`<p class="muted">Заявок нет.</p>`}`);
});

// Значение для поля datetime-local: «2026-10-29T08:30».
const localInput = (d) => String(d || '').replace(' ', 'T').slice(0, 16);

// Через час от текущего времени, с округлением до 15 минут.
function defaultArrive() {
  const [d, t] = nowLocal().split(' ');
  const [h, m] = t.split(':').map(Number);
  const total = Math.ceil((h * 60 + m + 60) / 15) * 15;
  const day = new Date(`${d}T00:00:00Z`);
  day.setUTCMinutes(total);
  return day.toISOString().slice(0, 16);
}

async function form(o, { action, submit, callId }) {
  const board = await driversBoard();
  const { drivers, busy } = board;
  const busyIds = new Set(busy.map((d) => d.id));
  const driverOptions = Object.fromEntries(drivers.map((d) => [d.id, `${fullName(d)} — ${busyIds.has(d.id) && d.id !== o.driver_id ? 'занят' : d.online ? 'свободен' : 'не в сети'}`]));
  return html`
<div class="with-side">
<form method="post" action="${action}">
  ${callId ? html`<input type="hidden" name="call_id" value="${callId}">` : ''}
  <div class="grid">
    <h2 class="wide">Клиент</h2>
    <label>Имя клиента<input name="client_name" value="${o.client_name || ''}" required autocomplete="off"></label>
    <label>Телефон<input name="client_phone" type="tel" value="${o.client_phone || ''}" required autocomplete="off" placeholder="+1 416 555-0100"></label>

    <h2 class="wide">Адрес</h2>
    <label class="wide">Адрес или ссылка на карту<input name="address" value="${o.address || ''}" required autocomplete="off" placeholder="123 Queen St W, Toronto, ON"></label>
    <div class="wide house-view" data-house hidden>
      <div class="house-pane" data-house-sv hidden></div>
      <a class="button secondary small-btn" data-house-link target="_blank" rel="noopener">Открыть Street View ↗</a>
    </div>
    <div class="wide"><button type="button" class="secondary small-btn" data-map-open>Открыть карту: клиент и водители</button></div>
    <div class="wide order-map-wrap" data-map-wrap hidden>
      <div class="order-map" data-map></div>
      <div class="map-legend small"><span><i class="md md-green"></i>свободен</span><span><i class="md md-yellow"></i>на заказе, скоро освободится</span><span><i class="md md-orange"></i>2 заказа</span><span><i class="md md-red"></i>3 и больше</span><span><i class="md md-client"></i>клиент</span></div>
    </div>

    <h2 class="wide">Во сколько приехать</h2>
    <label>Дата и время (Торонто)<input name="arrive_at" type="datetime-local" value="${localInput(o.arrive_at) || defaultArrive()}" required></label>

    <h2 class="wide">Сколько платит клиент</h2>
    <label>Договорённая цена, $ CAD<input name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${o.price ?? ''}" required></label>
    <label>Способ оплаты<select name="pay_method">${options(PAY_METHODS, o.pay_method || 'cash')}</select></label>

    <h2 class="wide">Сколько получит работник</h2>
    <label>Оплата работнику, $ CAD<input name="worker_pay" type="number" min="0" step="0.01" inputmode="decimal" value="${o.worker_pay ?? ''}" required></label>

    <h2 class="wide">Задача</h2>
    <label class="wide">Что сделать<textarea name="task" required placeholder="Почистить подъездную дорожку и тротуар, посыпать солью">${o.task || ''}</textarea></label>

    <h2 class="wide">По прибытии</h2>
    <fieldset class="wide">
      <label class="check"><input type="radio" name="notify_client" value="1"${o.notify_client ? raw(' checked') : ''}> Позвонить клиенту по прибытии</label>
      <label class="check"><input type="radio" name="notify_client" value="0"${!o.notify_client ? raw(' checked') : ''}> Можно сразу приступать к работе</label>
    </fieldset>

    <h2 class="wide">Водитель</h2>
    <div class="wide suggest" data-suggest data-order="${o.id || ''}" hidden></div>
    <label class="wide">Кому назначить<select name="driver_id" required>${options(driverOptions, o.driver_id, { empty: drivers.length ? '— выберите водителя —' : 'Сначала добавьте водителей' })}</select></label>
  </div>
  <div class="actions"><button>${submit}</button><a href="${o.id ? `/orders/${o.id}` : '/orders'}" class="button secondary">Отмена</a></div>
</form>
<aside class="side-panel">${boardBlock(board, { compact: true })}</aside>
</div>`;
}

async function readForm(body) {
  const o = {
    client_name: String(body.client_name || '').trim(),
    client_phone: String(body.client_phone || '').trim(),
    address: String(body.address || '').trim(),
    arrive_at: String(body.arrive_at || '').trim().replace('T', ' ').slice(0, 16),
    price: Math.max(0, Number(body.price) || 0),
    pay_method: PAY_METHODS[body.pay_method] ? body.pay_method : 'cash',
    worker_pay: Math.max(0, Number(body.worker_pay) || 0),
    task: String(body.task || '').trim(),
    notify_client: body.notify_client === '1' ? 1 : 0,
    driver_id: Number(body.driver_id) || null,
  };
  let error = '';
  if (!o.address) error = 'Укажите адрес.';
  else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(o.arrive_at)) error = 'Укажите дату и время приезда.';
  else if (!o.driver_id || !(await get("SELECT id FROM users WHERE id = ? AND role = 'driver' AND active = 1", o.driver_id))) error = 'Выберите водителя.';
  return { o, error };
}

// ?call=ID — заявка по входящему звонку: номер уже подставлен, имя и адрес — из прошлой заявки этого клиента.
r.get('/new', async (req, res) => {
  const fromCall = req.query.call ? await callPrefill(req.query.call) : null;
  // ?client=ID — заявка из карточки клиента.
  const client = req.query.client ? await get('SELECT * FROM clients WHERE id = ?', Number(req.query.client) || 0) : null;
  const prefill = fromCall ? fromCall.order : client ? { client_name: client.name, client_phone: client.phone, address: client.address } : {};
  const o = { ...prefill, driver_id: Number(req.query.driver) || null };
  const callId = fromCall ? fromCall.call.id : null;
  res.page('Новая заявка', html`
${fromCall && fromCall.call.order_id ? html`<p class="notice">По этому звонку уже есть <a href="/orders/${fromCall.call.order_id}">заявка №${fromCall.call.order_id}</a>.</p>` : ''}
${fromCall && fromCall.client && (o.client_name || o.address) ? html`<p class="notice">Клиент уже есть в базе: <a href="/clients/${fromCall.client.id}">${o.client_name || 'карточка клиента'}</a>. Имя и адрес подставлены — проверьте.</p>` : ''}
${await form(o, { action: '/orders', submit: 'Создать и назначить', callId })}`);
});

r.post('/', async (req, res) => {
  const { o, error } = await readForm(req.body);
  if (error) {
    res.flash(error);
    return res.status(400).page('Новая заявка', await form(o, { action: '/orders', submit: 'Создать и назначить', callId: Number(req.body.call_id) || null }));
  }
  const now = nowLocal();
  const { lastInsertRowid } = await run(
    `INSERT INTO orders (client_name, client_phone, address, arrive_at, price, pay_method, worker_pay, task, notify_client, driver_id,
       status, created_by, created_at, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`,
    o.client_name, o.client_phone, o.address, o.arrive_at, o.price, o.pay_method, o.worker_pay, o.task, o.notify_client, o.driver_id,
    req.user.id, now, now,
  );
  // Клиент заявки: найти по номеру или завести; если новый — закрепить за тем, кто создал заявку.
  const client = await ensureClient({ phone: o.client_phone, name: o.client_name, address: o.address, ownerId: req.user.id });
  if (client) await run('UPDATE orders SET client_id = ? WHERE id = ?', client.id, lastInsertRowid);
  if (Number(req.body.call_id)) await run('UPDATE calls SET order_id = ? WHERE id = ? AND order_id IS NULL', lastInsertRowid, Number(req.body.call_id));
  await notify(req, { order: await get('SELECT * FROM orders WHERE id = ?', lastInsertRowid), status: 'assigned', target: o.driver_id });
  res.flash(`Заявка №${lastInsertRowid} создана и назначена водителю.`);
  res.redirect(`/orders/${lastInsertRowid}`);
});

const json = (res, data) => {
  res.headers.set('content-type', 'application/json; charset=utf-8');
  res.headers.set('cache-control', 'no-store');
  return res.send(JSON.stringify(data));
};

const jobsText = (n) => {
  if (!n) return 'свободен';
  const word = n % 10 === 1 && n % 100 !== 11 ? 'заявка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'заявки' : 'заявок';
  return `${n} ${word}`;
};

// Системное предложение для формы заявки (см. src/geo.js и /app.js).
r.get('/suggest', async (req, res) => {
  const { target, drivers } = await suggest(req.query.address, { exceptOrder: req.query.order });
  const info = (d) => [jobsText(d.jobs),
    d.trip ? `${kmText(d.trip.km)}, ~${d.trip.min} мин${d.trip.rough ? ' (по прямой)' : ''}` : target ? 'нет местоположения' : '',
    d.trip ? `точка ${ageText(d.geo_age)}` : ''].filter(Boolean).join(' · ');
  const view = (d) => ({ id: d.id, name: fullName(d), info: info(d) });
  const [best, ...others] = drivers;
  const notes = [];
  if (!drivers.length) notes.push('Нет работников в сети.');
  else if (!target) notes.push('Адрес не найден на карте — предложение только по загрузке работников.');
  json(res, {
    best: best ? view(best) : null,
    others: others.slice(0, 4).map(view),
    text: notes.join(' '),
    waiting: drivers.some((d) => !d.geo_at || d.geo_age >= 1),
    // Для карты: адрес клиента и водители в сети с известной точкой.
    target,
    // Ключ Google Maps Embed API (секрет GOOGLE_MAPS_EMBED_KEY в Cloudflare) — встроенный Street View; без него — ссылка.
    streetViewKey: req.env.GOOGLE_MAPS_EMBED_KEY || '',
    points: drivers.filter((d) => d.lat !== null && d.geo_at).map((d) => ({
      id: d.id, name: fullName(d), info: `${jobsText(d.jobs)} · точка ${ageText(d.geo_age)}`, lat: d.lat, lng: d.lng, jobs: d.jobs,
      trip: d.trip ? `${kmText(d.trip.km)}, ~${d.trip.min} мин${d.trip.rough ? ' (по прямой)' : ''}` : '',
    })),
  });
});

// Карта на главной: клиенты с активными заявками; show=done — отработанные (есть выполненные заявки);
// show=all — все клиенты из базы. fresh=1 — попросить телефоны водителей прислать свежую точку (кнопка «Обновить водителей»).
r.get('/map-data', async (req, res) => {
  const show = ['active', 'done', 'all'].includes(req.query.show) ? req.query.show : 'active';
  const orders = show === 'done' ? [] : await all(`SELECT o.id, o.client_id, o.client_name, o.client_phone, o.address, o.status, o.arrive_at,
                              u.first_name, u.last_name, u.login FROM orders o LEFT JOIN users u ON u.id = o.driver_id
                            WHERE o.status IN (${ACTIVE_SQL}) ORDER BY o.arrive_at, o.id`);
  const done = show === 'active' ? [] : await all(`SELECT address, MAX(client_id) AS client_id, MAX(client_name) AS client_name,
                              MAX(client_phone) AS client_phone, COUNT(*) AS n FROM orders WHERE status = 'done' GROUP BY address`);
  const clients = show === 'all' ? await all("SELECT id, name, phone, address FROM clients WHERE address != '' ORDER BY id DESC LIMIT 1000") : [];
  // Один пин на адрес: клиент, его активные заявки и сколько заявок выполнено.
  const byAddress = new Map();
  const pin = (address, { name, phone, clientId }) => {
    const key = String(address || '').trim().slice(0, 500);
    if (!byAddress.has(key)) byAddress.set(key, { address: key, name: '', phone: '', clientId: null, orders: [], done: 0 });
    const p = byAddress.get(key);
    p.name = p.name || name || '';
    p.phone = p.phone || phone || '';
    p.clientId = p.clientId || clientId || null;
    return p;
  };
  for (const o of orders) {
    pin(o.address, { name: o.client_name, phone: o.client_phone, clientId: o.client_id })
      .orders.push({ id: o.id, when: when(o.arrive_at), status: STATUS[o.status][0], driver: fullName(o) });
  }
  for (const d of done) pin(d.address, { name: d.client_name, phone: d.client_phone, clientId: d.client_id }).done = d.n;
  for (const c of clients) pin(c.address, { name: c.name, phone: c.phone, clientId: c.id });
  const { points, pending } = await geocodeMany([...byAddress.keys()]);
  const drivers = await driverPoints();
  if (req.query.fresh === '1') await requestGeo((await all("SELECT id FROM users WHERE role = 'driver' AND active = 1 AND online = 1")).map((d) => d.id));
  // kind: active — есть активная заявка, done — отработанный (были выполненные), none — заявок не было.
  const kind = (p) => (p.orders.length ? 'active' : p.done ? 'done' : 'none');
  json(res, {
    clients: [...byAddress.values()].filter((p) => points.has(p.address)).map((p) => ({ ...p, ...points.get(p.address), kind: kind(p) })),
    notFound: [...byAddress.keys()].filter((a) => !points.has(a)).length - pending,
    pending,
    points: drivers.map((d) => ({ id: d.id, name: fullName(d), lat: d.lat, lng: d.lng, jobs: d.jobs, info: `${jobsText(d.jobs)} · точка ${ageText(d.geo_age)}`, trip: '' })),
  });
});

// Все работы с клиентом (карточка клиента на карте): по клиенту из базы и по адресу.
r.get('/client-jobs', async (req, res) => {
  const rows = await all(`SELECT o.id, o.status, o.arrive_at, o.done_at, o.price, o.pay_method, o.paid_amount, o.paid_method, o.address,
                            u.first_name, u.last_name, u.login FROM orders o LEFT JOIN users u ON u.id = o.driver_id
                          WHERE (o.client_id = ? AND o.client_id IS NOT NULL) OR o.address = ?
                          ORDER BY COALESCE(o.done_at, o.cancelled_at, o.arrive_at) DESC, o.id DESC LIMIT 50`,
  Number(req.query.client) || null, String(req.query.address || '').trim());
  json(res, {
    jobs: rows.map((o) => ({
      id: o.id, when: date(o.status === 'done' ? o.done_at : o.arrive_at), status: STATUS[o.status][0], driver: o.login ? fullName(o) : '—',
      money: money(o.status === 'done' ? paidAmount(o) : o.price), address: o.address,
    })),
  });
});

// Карточка водителя на карте: сколько выполнено, что впереди, на каком этапе текущая заявка.
r.get('/driver/:id', async (req, res) => {
  const d = await get("SELECT id, first_name, last_name, login, phone, online, geo_at FROM users WHERE id = ? AND role = 'driver'", req.params.id);
  if (!d) return json(res, { error: 'Водитель не найден.' });
  const done = await get(`SELECT COUNT(*) AS total, COALESCE(SUM(substr(done_at, 1, 10) = ?), 0) AS today
                          FROM orders WHERE driver_id = ? AND status = 'done'`, todayLocal(), d.id);
  const jobs = await all(`SELECT id, arrive_at, address, status FROM orders WHERE driver_id = ? AND status IN (${ACTIVE_SQL})
                          ORDER BY arrive_at, id`, d.id);
  // Текущая — та, что уже в пути или в работе; иначе ближайшая по времени.
  const current = jobs.find((j) => j.status !== 'assigned') || jobs[0] || null;
  const step = (j) => `${STATUS[j.status][0]} (этап ${STEPS.indexOf(j.status) + 1} из ${STEPS.length})`;
  json(res, {
    name: fullName(d),
    phone: d.phone,
    doneToday: done.today,
    doneTotal: done.total,
    current: current ? { id: current.id, address: current.address, step: step(current) } : null,
    schedule: jobs.map((j) => ({ id: j.id, when: when(j.arrive_at), address: j.address, status: STATUS[j.status][0], current: current && j.id === current.id })),
  });
});

// Как далеко работник от адреса заявки; если едет — сколько минут до клиента.
r.get('/:id/distance', async (req, res) => {
  const o = await get('SELECT id, address, status, driver_id FROM orders WHERE id = ?', req.params.id);
  if (!o || !o.driver_id || !['assigned', 'accepted'].includes(o.status)) return json(res, { text: '' });
  json(res, await orderDistance(o));
});

const loadOrder = (id) => get(`SELECT o.*, u.first_name, u.last_name, u.login, u.phone AS driver_phone,
  c.first_name AS c_first, c.last_name AS c_last, c.login AS c_login
  FROM orders o LEFT JOIN users u ON u.id = o.driver_id LEFT JOIN users c ON c.id = o.created_by WHERE o.id = ?`, id);

const STEP_AT = { assigned: 'assigned_at', accepted: 'accepted_at', arrived: 'arrived_at', started: 'started_at', done: 'done_at' };

r.get('/:id', async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).page('Заявка не найдена', html`<p><a href="/orders">К заявкам</a></p>`);
  const open = ACTIVE.includes(o.status);
  res.page(`Заявка №${o.id}`, html`
<p>${statusFlag(o.status)}</p>
<dl class="facts">
  <dt>Клиент</dt><dd>${o.client_id ? html`<a href="/clients/${o.client_id}">${o.client_name || 'Клиент'}</a>` : o.client_name || '—'} · ${phoneLink(o.client_phone)} ${whatsappButton(o.client_phone, { small: true })}</dd>
  <dt>Адрес</dt><dd>${mapsLink(o.address)}</dd>
  <dt>Приехать</dt><dd>${date(o.arrive_at)}</dd>
  <dt>Договорённая цена</dt><dd>${money(o.price)} · ${PAY_METHODS[o.pay_method]}</dd>
  ${o.status === 'done' ? html`<dt>Клиент заплатил</dt><dd class="${paidDiffers(o) ? 'paid-diff' : ''}">${money(paidAmount(o))} · ${PAY_METHODS[paidMethod(o)]}${paidDiffers(o) ? ' — не как в заявке' : ''}</dd>` : ''}
  <dt>Работнику</dt><dd>${money(o.worker_pay)}</dd>
  <dt>Задача</dt><dd class="task-text">${o.task || '—'}</dd>
  <dt>По прибытии</dt><dd>${o.notify_client ? html`<span class="notify-yes">Позвонить клиенту</span>` : 'Сразу приступать к работе'}</dd>
  <dt>Водитель</dt><dd>${o.driver_id ? html`${fullName(o)} · ${phoneLink(o.driver_phone)}` : '—'}</dd>
  ${o.driver_id && ['assigned', 'accepted'].includes(o.status) ? html`<dt>${o.status === 'accepted' ? 'До клиента' : 'Где работник'}</dt>
  <dd class="distance" data-distance="/orders/${o.id}/distance"><span data-distance-text>Узнаём местоположение…</span><br><span class="muted small" data-distance-note></span></dd>` : ''}
  <dt>Создал</dt><dd>${fullName({ first_name: o.c_first, last_name: o.c_last, login: o.c_login })} · ${date(o.created_at)}</dd>
</dl>
${o.status === 'done' && can.editPayment(req.user) ? html`
<details class="pay-edit">
  <summary class="button secondary">Изменить суммы</summary>
  <form method="post" action="/orders/${o.id}/payment" class="grid">
    <label>Клиент заплатил, $ CAD<input name="paid_amount" type="number" min="0" step="0.01" inputmode="decimal" value="${paidAmount(o)}" required></label>
    <label>Как заплатил<select name="paid_method">${options(PAY_METHODS, paidMethod(o))}</select></label>
    <label>Работнику, $ CAD<input name="worker_pay" type="number" min="0" step="0.01" inputmode="decimal" value="${o.worker_pay}" required></label>
    <div class="actions wide"><button>Сохранить</button></div>
  </form>
</details>` : ''}
<h2>Ход выполнения</h2>
<ol class="steps">${STEPS.map((s) => html`<li class="${o[STEP_AT[s]] ? 'done' : ''}">${STATUS[s][0]}${o[STEP_AT[s]] ? html` — ${date(o[STEP_AT[s]])}` : ''}</li>`)}</ol>
${o.status === 'cancelled' ? html`<p class="muted">Отменена ${date(o.cancelled_at)}.</p>` : ''}
${can.setStatus(req.user) && o.driver_id ? html`
<form method="post" action="/orders/${o.id}/status" class="status-form">
  <label>Сменить статус<select name="status">${options(Object.fromEntries(STEPS.map((s) => [s, STATUS[s][0]])), o.status === 'cancelled' ? '' : o.status)}</select></label>
  <button class="secondary">Сохранить статус</button>
</form>` : ''}
${open ? html`
<div class="actions">
  <a href="/orders/${o.id}/edit" class="button">Изменить / переназначить</a>
  ${can.cancelOrders(req.user) ? html`<form method="post" action="/orders/${o.id}/cancel" onsubmit="return confirm('Отменить заявку №${o.id}?')"><button class="secondary">Отменить заявку</button></form>` : ''}
</div>` : ''}
<p><a href="/orders">← Все заявки</a></p>`);
});

r.get('/:id/edit', async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o || !ACTIVE.includes(o.status)) return res.redirect(`/orders/${req.params.id}`);
  res.page(`Заявка №${o.id}: изменить`, html`
${o.status !== 'assigned' ? html`<p class="notice">Водитель уже принял заявку. Если выбрать другого водителя, заявка начнётся заново: новый водитель должен её принять.</p>` : ''}
${await form(o, { action: `/orders/${o.id}/edit`, submit: 'Сохранить' })}`);
});

r.post('/:id/edit', async (req, res) => {
  const old = await loadOrder(req.params.id);
  if (!old || !ACTIVE.includes(old.status)) return res.redirect(`/orders/${req.params.id}`);
  const { o, error } = await readForm(req.body);
  if (error) {
    res.flash(error);
    return res.status(400).page(`Заявка №${old.id}: изменить`, await form({ ...o, id: old.id }, { action: `/orders/${old.id}/edit`, submit: 'Сохранить' }));
  }
  await run(`UPDATE orders SET client_name = ?, client_phone = ?, address = ?, arrive_at = ?, price = ?, pay_method = ?, worker_pay = ?, task = ?,
             notify_client = ? WHERE id = ?`,
  o.client_name, o.client_phone, o.address, o.arrive_at, o.price, o.pay_method, o.worker_pay, o.task, o.notify_client, old.id);
  const client = await ensureClient({ phone: o.client_phone, name: o.client_name, address: o.address, ownerId: old.created_by });
  await run('UPDATE orders SET client_id = ? WHERE id = ?', client ? client.id : null, old.id);
  // Новый водитель — заявка снова ждёт принятия.
  if (o.driver_id !== old.driver_id) {
    await run(`UPDATE orders SET driver_id = ?, status = 'assigned', assigned_at = ?, accepted_at = NULL, arrived_at = NULL, started_at = NULL
               WHERE id = ?`, o.driver_id, nowLocal(), old.id);
    await notify(req, { order: await get('SELECT * FROM orders WHERE id = ?', old.id), status: 'assigned', target: o.driver_id });
  }
  res.flash('Заявка сохранена.');
  res.redirect(`/orders/${old.id}`);
});

r.post('/:id/cancel', async (req, res) => {
  if (!can.cancelOrders(req.user)) return res.denied();
  await run(`UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status IN (${ACTIVE_SQL})`, nowLocal(), req.params.id);
  res.flash('Заявка отменена, водитель свободен.');
  res.redirect(`/orders/${req.params.id}`);
});

// Исправить сумму по закрытой заявке: сколько заплатил клиент, как, и сколько получает работник.
r.post('/:id/payment', async (req, res) => {
  if (!can.editPayment(req.user)) return res.denied();
  const amount = Number(req.body.paid_amount);
  const pay = Number(req.body.worker_pay);
  if (req.body.paid_amount === '' || req.body.worker_pay === '' || !(amount >= 0) || !(pay >= 0) || !PAY_METHODS[req.body.paid_method]) {
    res.flash('Укажите суммы числом от 0.');
    return res.redirect(`/orders/${req.params.id}`);
  }
  const { changes } = await run("UPDATE orders SET paid_amount = ?, paid_method = ?, worker_pay = ? WHERE id = ? AND status = 'done'",
    amount, req.body.paid_method, pay, req.params.id);
  res.flash(changes ? 'Суммы сохранены.' : 'Суммы меняются только у закрытой заявки.');
  res.redirect(`/orders/${req.params.id}`);
});

// Quant вручную ставит этап: прошедшие этапы получают время (если его не было), следующие — очищаются.
r.post('/:id/status', async (req, res) => {
  if (!can.setStatus(req.user)) return res.denied();
  const o = await loadOrder(req.params.id);
  const to = String(req.body.status || '');
  if (!o || !o.driver_id || !STEPS.includes(to)) return res.redirect(`/orders/${req.params.id}`);
  const now = nowLocal();
  const reached = STEPS.slice(0, STEPS.indexOf(to) + 1);
  const sets = STEPS.map((s) => `${STEP_AT[s]} = ${reached.includes(s) ? `COALESCE(${STEP_AT[s]}, ?)` : 'NULL'}`);
  const params = reached.map(() => now);
  // Заявка больше не закрыта — сбрасываем оплату и отметку о сданных наличных.
  const reset = to === 'done' ? '' : ', paid_amount = NULL, paid_method = NULL, settled_at = NULL, settled_by = NULL';
  await run(`UPDATE orders SET status = ?, ${sets.join(', ')}, cancelled_at = NULL${reset} WHERE id = ?`, to, ...params, o.id);
  res.flash(`Статус заявки: ${STATUS[to][0]}.`);
  res.redirect(`/orders/${o.id}`);
});

module.exports = r;
