// Заявки для КЦ и Quant: создать, назначить водителя, изменить, отменить.
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can, STATUS, STEPS, ACTIVE, PAY_METHODS, PAY_HOW, paidAmount, paidMethod, paidDiffers } = require('../roles');
const { html, raw, fullName, date, when, nowLocal, money, phoneLink, mapsLink, statusFlag, options } = require('../html');
const { driversBoard, boardBlock, ACTIVE_SQL } = require('../board');
const { notify } = require('../push');
const { callPrefill } = require('./calls');

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
<tr><th>№</th><th>Приезд</th><th>Клиент</th><th>Адрес</th><th>Водитель</th><th>Клиент платит</th><th>Работнику</th><th>Статус</th></tr>
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
  const driverOptions = Object.fromEntries(drivers.map((d) => [d.id, `${fullName(d)} — ${busyIds.has(d.id) && d.id !== o.driver_id ? 'занят' : 'свободен'}`]));
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

    <h2 class="wide">Во сколько приехать</h2>
    <label>Дата и время (Торонто)<input name="arrive_at" type="datetime-local" value="${localInput(o.arrive_at) || defaultArrive()}" required></label>

    <h2 class="wide">Сколько платит клиент</h2>
    <label>Сумма, $<input name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${o.price ?? ''}" required></label>
    <label>Способ оплаты<select name="pay_method">${options(PAY_METHODS, o.pay_method || 'cash')}</select></label>

    <h2 class="wide">Сколько получит работник</h2>
    <label>Оплата работнику, $<input name="worker_pay" type="number" min="0" step="0.01" inputmode="decimal" value="${o.worker_pay ?? ''}" required></label>

    <h2 class="wide">Задача</h2>
    <label class="wide">Что сделать<textarea name="task" required placeholder="Почистить подъездную дорожку и тротуар, посыпать солью">${o.task || ''}</textarea></label>

    <h2 class="wide">По прибытии</h2>
    <fieldset class="wide">
      <label class="check"><input type="radio" name="notify_client" value="1"${o.notify_client ? raw(' checked') : ''}> Позвонить клиенту по прибытии</label>
      <label class="check"><input type="radio" name="notify_client" value="0"${!o.notify_client ? raw(' checked') : ''}> Можно сразу приступать к работе</label>
    </fieldset>

    <h2 class="wide">Водитель</h2>
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
  const o = { ...(fromCall ? fromCall.order : {}), driver_id: Number(req.query.driver) || null };
  const callId = fromCall ? fromCall.call.id : null;
  res.page('Новая заявка', html`
${fromCall && fromCall.call.order_id ? html`<p class="notice">По этому звонку уже есть <a href="/orders/${fromCall.call.order_id}">заявка №${fromCall.call.order_id}</a>.</p>` : ''}
${fromCall && o.address ? html`<p class="notice">Звонит постоянный клиент: имя и адрес взяты из его прошлой заявки — проверьте.</p>` : ''}
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
  if (Number(req.body.call_id)) await run('UPDATE calls SET order_id = ? WHERE id = ? AND order_id IS NULL', lastInsertRowid, Number(req.body.call_id));
  await notify(req, { order: await get('SELECT * FROM orders WHERE id = ?', lastInsertRowid), status: 'assigned', target: o.driver_id });
  res.flash(`Заявка №${lastInsertRowid} создана и назначена водителю.`);
  res.redirect(`/orders/${lastInsertRowid}`);
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
  <dt>Клиент</dt><dd>${o.client_name || '—'} · ${phoneLink(o.client_phone)}</dd>
  <dt>Адрес</dt><dd>${mapsLink(o.address)}</dd>
  <dt>Приехать</dt><dd>${date(o.arrive_at)}</dd>
  <dt>Клиент платит</dt><dd>${money(o.price)} · ${PAY_METHODS[o.pay_method]}</dd>
  ${o.status === 'done' ? html`<dt>Клиент заплатил</dt><dd class="${paidDiffers(o) ? 'paid-diff' : ''}">${money(paidAmount(o))} · ${PAY_METHODS[paidMethod(o)]}${paidDiffers(o) ? ' — не как в заявке' : ''}</dd>` : ''}
  <dt>Работнику</dt><dd>${money(o.worker_pay)}</dd>
  <dt>Задача</dt><dd class="task-text">${o.task || '—'}</dd>
  <dt>По прибытии</dt><dd>${o.notify_client ? html`<span class="notify-yes">Позвонить клиенту</span>` : 'Сразу приступать к работе'}</dd>
  <dt>Водитель</dt><dd>${o.driver_id ? html`${fullName(o)} · ${phoneLink(o.driver_phone)}` : '—'}</dd>
  <dt>Создал</dt><dd>${fullName({ first_name: o.c_first, last_name: o.c_last, login: o.c_login })} · ${date(o.created_at)}</dd>
</dl>
<h2>Ход выполнения</h2>
<ol class="steps">${STEPS.map((s) => html`<li class="${o[STEP_AT[s]] ? 'done' : ''}">${STATUS[s][0]}${o[STEP_AT[s]] ? html` — ${date(o[STEP_AT[s]])}` : ''}</li>`)}</ol>
${o.status === 'cancelled' ? html`<p class="muted">Отменена ${date(o.cancelled_at)}.</p>` : ''}
${open ? html`
<div class="actions">
  <a href="/orders/${o.id}/edit" class="button">Изменить / переназначить</a>
  <form method="post" action="/orders/${o.id}/cancel" onsubmit="return confirm('Отменить заявку №${o.id}?')"><button class="secondary">Отменить заявку</button></form>
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
  await run(`UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status IN (${ACTIVE_SQL})`, nowLocal(), req.params.id);
  res.flash('Заявка отменена, водитель свободен.');
  res.redirect(`/orders/${req.params.id}`);
});

module.exports = r;
