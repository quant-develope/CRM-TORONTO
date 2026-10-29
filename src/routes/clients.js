// База клиентов. Клиента узнаём по номеру телефона (последние 10 цифр).
// Клиент закреплён за оператором, на чей номер он позвонил (см. «Звонки» → «Номера и операторы»);
// если клиент пришёл не по звонку — за тем, кто создал его первую заявку.
// «Работал с нами» — есть выполненная заявка; «закрыл» — кто создал первую выполненную заявку (может быть другой оператор).
// Менять данные клиента могут Quant и оператор клиента; оператора клиента меняет Quant.
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can, is, OFFICE, STATUS } = require('../roles');
const { html, whatsappButton, fullName, date, when, utcToLocal, money, phoneLink, mapsLink, statusFlag, options } = require('../html');

// Последние 10 цифр: так «+1 (416) 555-0100», «416-555-0100» и «+14165550100» считаются одним номером.
const digits10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

// «+14165550100» → «+1 416 555-0100».
function prettyPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `+1 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6)}`;
  return d.length >= 7 ? phone : '';
}

// Номер в формате E.164: «416 555 0100» → «+14165550100».
function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length >= 11) return `+${d}`;
  return '';
}

// Оператор номера, на который позвонили: из «Номеров и операторов», иначе — кто ведёт сайт с этим номером (КЦ в первую очередь).
async function lineFor(number) {
  const d = digits10(number);
  if (d.length < 10) return null;
  const line = await get(`SELECT l.*, CASE WHEN l.forward_to != '' THEN l.forward_to ELSE u.phone END AS user_phone FROM lines l JOIN users u ON u.id = l.user_id
                          WHERE l.number10 = ? AND u.active = 1`, d);
  if (line) return line;
  const sites = await all('SELECT id, phones FROM sites');
  const site = sites.find((s) => String(s.phones || '').split(',').some((p) => digits10(p) === d));
  if (!site) return null;
  const user = await get(`SELECT u.id, u.phone FROM user_sites us JOIN users u ON u.id = us.user_id
                          WHERE us.site_id = ? AND u.active = 1 ORDER BY CASE u.role WHEN 'dispatcher' THEN 0 ELSE 1 END, u.id LIMIT 1`, site.id);
  return user ? { user_id: user.id, user_phone: user.phone } : null;
}

const findClient = (phone) => {
  const d = digits10(phone);
  return d.length === 10 ? get('SELECT * FROM clients WHERE phone10 = ?', d) : Promise.resolve(undefined);
};

// Найти клиента по номеру или завести нового. Пустые имя и адрес дополняются, оператор не меняется.
async function ensureClient({ phone, name = '', address = '', ownerId = null, firstNumber = '' }) {
  const d = digits10(phone);
  if (d.length < 10) return null;
  await run(`INSERT INTO clients (phone10, phone, name, address, owner_id, first_number) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (phone10) DO NOTHING`, d, prettyPhone(phone) || phone, name, address, ownerId, firstNumber);
  if (name) await run("UPDATE clients SET name = ? WHERE phone10 = ? AND name = ''", name, d);
  if (address) await run("UPDATE clients SET address = ? WHERE phone10 = ? AND address = ''", address, d);
  if (ownerId) await run('UPDATE clients SET owner_id = ? WHERE phone10 = ? AND owner_id IS NULL', ownerId, d);
  return get('SELECT * FROM clients WHERE phone10 = ?', d);
}

// Один раз: завести клиентов из прошлых звонков и заявок.
let backfilled = false;
async function backfill() {
  if (backfilled) return;
  if (!(await get("SELECT 1 AS ok FROM settings WHERE key = 'clients_backfill'"))) {
    for (const c of await all('SELECT * FROM calls WHERE client_id IS NULL ORDER BY id')) {
      const line = await lineFor(c.to_number);
      const client = await ensureClient({ phone: c.from_number, ownerId: line ? line.user_id : null, firstNumber: c.to_number });
      if (client) await run('UPDATE calls SET client_id = ? WHERE id = ?', client.id, c.id);
    }
    for (const o of await all('SELECT * FROM orders WHERE client_id IS NULL ORDER BY id')) {
      const client = await ensureClient({ phone: o.client_phone, name: o.client_name, address: o.address, ownerId: o.created_by });
      if (client) await run('UPDATE orders SET client_id = ? WHERE id = ?', client.id, o.id);
    }
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('clients_backfill', '1')");
  }
  backfilled = true;
}

const canEdit = (user, client) => is(user, 'quant') || client.owner_id === user.id;

// Работал ли с нами и кто закрыл: первая выполненная заявка клиента и кто её создал.
const CLIENT_SQL = `SELECT c.*, ow.first_name, ow.last_name, ow.login,
    (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id) AS orders_n,
    (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id AND o.status = 'done') AS done_n,
    (SELECT COALESCE(SUM(COALESCE(o.paid_amount, o.price)), 0) FROM orders o WHERE o.client_id = c.id AND o.status = 'done') AS paid_sum,
    (SELECT o.created_by FROM orders o WHERE o.client_id = c.id AND o.status = 'done' ORDER BY o.done_at, o.id LIMIT 1) AS closer_id,
    (SELECT MAX(k.created_at) FROM calls k WHERE k.client_id = c.id) AS last_call
  FROM clients c LEFT JOIN users ow ON ow.id = c.owner_id`;

const r = new Router();

r.use((req, res, next) => (can.manageOrders(req.user) ? next() : res.denied()));
r.use(async (req, res, next) => { await backfill(); next(); });

const FILTERS = {
  all: ['Все', '1 = 1'],
  mine: ['Мои', 'c.owner_id = ?'],
  worked: ['Работали с нами', "EXISTS (SELECT 1 FROM orders o WHERE o.client_id = c.id AND o.status = 'done')"],
  new: ['Ещё не работали', "NOT EXISTS (SELECT 1 FROM orders o WHERE o.client_id = c.id AND o.status = 'done')"],
};

async function usersById() {
  return new Map((await all('SELECT id, first_name, last_name, login FROM users')).map((u) => [u.id, u]));
}

r.get('/', async (req, res) => {
  const filter = FILTERS[req.query.show] ? req.query.show : 'all';
  const q = String(req.query.q || '').trim();
  const where = [FILTERS[filter][1]];
  const params = filter === 'mine' ? [req.user.id] : [];
  if (q) {
    const d = q.replace(/\D/g, '');
    where.push(`(c.name LIKE ? OR c.address LIKE ?${d.length >= 3 ? ' OR c.phone10 LIKE ?' : ''})`);
    params.push(`%${q}%`, `%${q}%`, ...(d.length >= 3 ? [`%${d}%`] : []));
  }
  const rows = await all(`${CLIENT_SQL} WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 500`, ...params);
  const users = await usersById();
  res.page('Клиенты', html`
<div class="toolbar">
  <div class="fchips">${Object.entries(FILTERS).map(([key, [label]]) => html`<a href="/clients?show=${key}" class="fchip ${key === filter ? 'on' : ''}">${label}</a>`)}</div>
  <form method="get" class="search"><input type="hidden" name="show" value="${filter}"><input name="q" value="${q}" placeholder="Имя, телефон или адрес" type="search"></form>
</div>
${rows.length ? html`<div class="table-wrap"><table>
<tr><th>Клиент</th><th>Адрес</th><th>Оператор</th><th>Работал с нами</th><th>Закрыл</th><th>Заявки</th></tr>
${rows.map((c) => html`<tr>
  <td><a href="/clients/${c.id}">${c.name || 'Без имени'}</a><br><span class="small">${phoneLink(c.phone)}</span> ${whatsappButton(c.phone, { small: true })}</td>
  <td>${c.address || '—'}</td>
  <td>${c.owner_id ? fullName(c) : '—'}</td>
  <td>${c.done_n ? html`<span class="flag flag-green"><i></i>Да</span>` : html`<span class="flag flag-gray"><i></i>Нет</span>`}</td>
  <td>${c.closer_id ? fullName(users.get(c.closer_id)) : '—'}</td>
  <td class="nowrap">${c.orders_n}${c.done_n ? html` <span class="muted small">(${money(c.paid_sum)})</span>` : ''}</td>
</tr>`)}
</table></div>` : html`<p class="muted">Клиентов не найдено.</p>`}`);
});

r.get('/:id', async (req, res) => {
  const c = await get(`${CLIENT_SQL} WHERE c.id = ?`, Number(req.params.id) || 0);
  if (!c) return res.status(404).page('Клиент не найден', html`<p><a href="/clients">К клиентам</a></p>`);
  const users = await usersById();
  const orders = await all('SELECT o.*, u.first_name, u.last_name, u.login FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE o.client_id = ? ORDER BY o.id DESC', c.id);
  const calls = await all('SELECT * FROM calls WHERE client_id = ? ORDER BY id DESC LIMIT 50', c.id);
  const edit = canEdit(req.user, c);
  const office = is(req.user, 'quant')
    ? Object.fromEntries((await all(`SELECT * FROM users WHERE active = 1 AND role IN (${OFFICE.map(() => '?').join(', ')}) ORDER BY first_name`, ...OFFICE))
      .map((u) => [u.id, fullName(u)]))
    : null;
  res.page(c.name || prettyPhone(c.phone) || 'Клиент', html`
<div class="toolbar"><span>${whatsappButton(c.phone)}</span><a href="/orders/new?client=${c.id}" class="button">+ Заявка для клиента</a></div>
<dl class="facts">
  <dt>Телефон</dt><dd>${phoneLink(c.phone)}</dd>
  <dt>Адрес</dt><dd>${mapsLink(c.address)}</dd>
  <dt>Оператор</dt><dd>${c.owner_id ? fullName(c) : '—'}${c.first_number ? html` <span class="muted small">· позвонил на ${prettyPhone(c.first_number)}</span>` : ''}</dd>
  <dt>Работал с нами</dt><dd>${c.done_n ? html`Да · выполнено заявок: ${c.done_n} на ${money(c.paid_sum)}` : 'Нет'}</dd>
  <dt>Закрыл</dt><dd>${c.closer_id ? fullName(users.get(c.closer_id)) : '—'}</dd>
  <dt>В базе с</dt><dd>${date(utcToLocal(c.created_at))}</dd>
  ${c.note && !edit ? html`<dt>Заметка</dt><dd class="task-text">${c.note}</dd>` : ''}
</dl>
${edit ? html`<h2>Изменить</h2>
<form method="post" action="/clients/${c.id}" class="grid">
  <label>Имя<input name="name" value="${c.name}" autocomplete="off"></label>
  <label>Телефон<input name="phone" type="tel" value="${c.phone}" required autocomplete="off"></label>
  <label class="wide">Адрес<input name="address" value="${c.address}" autocomplete="off"></label>
  <label class="wide">Заметка<textarea name="note">${c.note}</textarea></label>
  ${office ? html`<label class="wide">Оператор клиента<select name="owner_id">${options(office, c.owner_id, { empty: '— нет —' })}</select></label>` : ''}
  <div><button>Сохранить</button></div>
</form>` : html`<p class="muted small">Менять данные клиента могут Quant и оператор клиента.</p>`}
<h2>Заявки</h2>
${orders.length ? html`<div class="table-wrap"><table>
<tr><th>№</th><th>Приезд</th><th>Адрес</th><th>Сумма</th><th>Создал</th><th>Статус</th></tr>
${orders.map((o) => html`<tr><td><a href="/orders/${o.id}">№${o.id}</a></td><td class="nowrap">${when(o.arrive_at)}</td><td>${o.address}</td>
  <td class="nowrap">${money(o.paid_amount ?? o.price)}</td><td>${fullName(o)}</td><td>${statusFlag(o.status)}</td></tr>`)}
</table></div>` : html`<p class="muted">Заявок ещё не было.</p>`}
<h2>Звонки</h2>
${calls.length ? html`<ul>${calls.map((k) => html`<li>${date(utcToLocal(k.created_at))} · на ${prettyPhone(k.to_number) || '—'}${k.order_id ? html` · <a href="/orders/${k.order_id}">заявка №${k.order_id}</a>` : ''}</li>`)}</ul>`
    : html`<p class="muted">Звонков не было.</p>`}
<p><a href="/clients">← Все клиенты</a></p>`);
});

r.post('/:id', async (req, res) => {
  const c = await get('SELECT * FROM clients WHERE id = ?', Number(req.params.id) || 0);
  if (!c) return res.redirect('/clients');
  if (!canEdit(req.user, c)) return res.denied();
  const phone = String(req.body.phone || '').trim();
  const d = digits10(phone);
  if (d.length < 10) {
    res.flash('Укажите телефон полностью, 10 цифр.');
    return res.redirect(`/clients/${c.id}`);
  }
  const other = await get('SELECT id FROM clients WHERE phone10 = ? AND id != ?', d, c.id);
  if (other) {
    res.flash('Этот номер уже есть у другого клиента.');
    return res.redirect(`/clients/${other.id}`);
  }
  let ownerId = c.owner_id;
  if (is(req.user, 'quant')) ownerId = Number(req.body.owner_id) || null;
  await run('UPDATE clients SET name = ?, phone = ?, phone10 = ?, address = ?, note = ?, owner_id = ? WHERE id = ?',
    String(req.body.name || '').trim(), prettyPhone(phone) || phone, d, String(req.body.address || '').trim(), String(req.body.note || '').trim(), ownerId, c.id);
  res.flash('Клиент сохранён.');
  res.redirect(`/clients/${c.id}`);
});

module.exports = { clients: r, digits10, prettyPhone, normalizePhone, lineFor, findClient, ensureClient, backfill };
