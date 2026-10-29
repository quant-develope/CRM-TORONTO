// Сотрудники. Список с ролями, сайтами и заявками за день видят Quant, Веб и КЦ; добавляет и меняет людей только Quant.
const { Router } = require('../mini');
const { get, all, run, hashPassword } = require('../db');
const { can, ROLES, STAFF_ROLES, OFFICE } = require('../roles');
const { html, raw, fullName, date, todayLocal, utcToLocal, money, phoneLink, roleTag, options } = require('../html');
const { ACTIVE_SQL } = require('../board');
const { sitesByUser, sitesDropdown } = require('./sites');

const r = new Router();

r.use((req, res, next) => {
  if (!can.viewStaff(req.user)) return res.denied();
  next();
});

const manageOnly = (req, res, next) => (can.manageStaff(req.user) ? next() : res.denied());

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const shiftDay = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

r.get('/', async (req, res) => {
  // День для подсчёта заявок: сегодня или выбранный в календаре.
  const today = todayLocal();
  const day = isDay(req.query.day) ? req.query.day : today;
  const rows = await all(`SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.created_by = u.id AND substr(o.created_at, 1, 10) = ?) AS day_orders,
      (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status IN (${ACTIVE_SQL})) AS open_jobs,
      (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status = 'done') AS done_jobs,
      (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status = 'done' AND substr(o.done_at, 1, 10) = ?) AS day_done
    FROM users u ORDER BY u.active DESC, CASE u.role WHEN 'quant' THEN 0 WHEN 'web' THEN 1 WHEN 'dispatcher' THEN 2 ELSE 3 END, u.first_name, u.last_name`, day, day);
  const sites = await sitesByUser();
  const dayLabel = day === today ? 'сегодня' : date(day);
  const manage = can.manageStaff(req.user);
  res.page('Сотрудники', html`
<div class="toolbar">
  <form method="get" class="day-nav">
    <a href="/staff?day=${shiftDay(day, -1)}" class="button secondary" aria-label="Предыдущий день">←</a>
    <input type="date" name="day" value="${day}" max="${today}" onchange="this.form.submit()" aria-label="День">
    <a href="/staff?day=${shiftDay(day, 1)}" class="button secondary${day >= today ? ' disabled' : ''}" aria-label="Следующий день">→</a>
    ${day !== today ? html`<a href="/staff" class="small">Сегодня</a>` : ''}
  </form>
  ${manage ? html`<a href="/staff/new" class="button">+ Добавить сотрудника</a>` : ''}
</div>
<div class="table-wrap"><table class="staff-table">
<tr><th>Имя</th><th>Роль</th><th>Телефон</th><th>Логин</th><th>Сайты</th><th>Заявки — ${dayLabel}</th><th>Статус</th><th></th></tr>
${rows.map((u) => html`<tr class="${u.active ? '' : 'inactive'}">
  <td>${fullName(u)}${u.active ? '' : html` <span class="muted small">(отключён)</span>`}</td>
  <td data-label="Роль">${roleTag(u.role)}</td>
  <td data-label="Телефон" class="nowrap">${phoneLink(u.phone)}</td>
  <td data-label="Логин">${u.login}</td>
  <td data-label="Сайты">${OFFICE.includes(u.role) ? sitesDropdown(sites.get(u.id)) : ''}</td>
  <td data-label="Заявки — ${dayLabel}">${OFFICE.includes(u.role) ? html`<b>${u.day_orders}</b> <span class="muted small">оформлено</span>` : html`<b>${u.day_done}</b> <span class="muted small">выполнено</span>`}</td>
  <td data-label="Статус">${u.role === 'driver' ? html`${u.open_jobs ? html`<span class="flag flag-orange"><i></i>занят</span>` : html`<span class="flag flag-green"><i></i>свободен</span>`}` : ''}</td>
  <td>${manage && u.role !== 'quant' ? html`<a href="/staff/${u.id}">Изменить</a>` : ''}</td>
</tr>`)}
</table></div>`);
});

function form(u, { action, submit, isNew }) {
  return html`
<form method="post" action="${action}">
  <div class="grid">
    <label>Имя<input name="first_name" value="${u.first_name || ''}" required></label>
    <label>Фамилия<input name="last_name" value="${u.last_name || ''}"></label>
    <label>Телефон<input name="phone" type="tel" value="${u.phone || ''}"></label>
    <label>Роль<select name="role">${options(STAFF_ROLES, u.role || 'driver')}</select></label>
    <label>Логин<input name="login" value="${u.login || ''}" required autocomplete="off" autocapitalize="none"></label>
    <label>${isNew ? 'Пароль' : 'Новый пароль (пусто — не менять)'}<input name="password" type="text" autocomplete="new-password"${isNew ? raw(' required minlength="6"') : raw(' minlength="6"')}></label>
    <label class="wide">Заметка<input name="note" value="${u.note || ''}" placeholder="Машина, район и т. п."></label>
    ${isNew ? '' : html`<label class="check wide"><input type="checkbox" name="active" value="1"${u.active ? raw(' checked') : ''}> Может входить в CRM</label>`}
  </div>
  <div class="actions"><button>${submit}</button><a href="/staff" class="button secondary">Отмена</a></div>
</form>`;
}

function readForm(body) {
  return {
    first_name: String(body.first_name || '').trim(),
    last_name: String(body.last_name || '').trim(),
    phone: String(body.phone || '').trim(),
    role: STAFF_ROLES[body.role] ? body.role : 'driver',
    login: String(body.login || '').trim(),
    password: String(body.password || ''),
    note: String(body.note || '').trim(),
    active: body.active === '1' ? 1 : 0,
  };
}

async function checkForm(u, id) {
  if (!u.first_name) return 'Укажите имя.';
  if (!/^[\w.@-]{2,40}$/.test(u.login)) return 'Логин: от 2 до 40 латинских букв, цифр или символов . _ - @';
  if (u.password && u.password.length < 6) return 'Пароль — не короче 6 символов.';
  if (await get('SELECT id FROM users WHERE login = ? AND id IS NOT ?', u.login, id || null)) return 'Такой логин уже занят.';
  return '';
}

r.get('/new', manageOnly, (req, res) => {
  res.page('Новый сотрудник', form({ role: req.query.role }, { action: '/staff', submit: 'Добавить', isNew: true }));
});

r.post('/', manageOnly, async (req, res) => {
  const u = readForm(req.body);
  const error = (await checkForm(u)) || (u.password ? '' : 'Укажите пароль.');
  if (error) {
    res.flash(error);
    return res.status(400).page('Новый сотрудник', form(u, { action: '/staff', submit: 'Добавить', isNew: true }));
  }
  await run('INSERT INTO users (login, password_hash, role, first_name, last_name, phone, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    u.login, await hashPassword(u.password), u.role, u.first_name, u.last_name, u.phone, u.note);
  res.flash(`${fullName(u)} добавлен(а): ${ROLES[u.role]}. Логин ${u.login}.`);
  res.redirect('/staff');
});

const editable = (id) => get("SELECT * FROM users WHERE id = ? AND role != 'quant'", id);

r.get('/:id', manageOnly, async (req, res) => {
  const u = await editable(req.params.id);
  if (!u) return res.redirect('/staff');
  const stats = await get("SELECT COUNT(*) AS n, COALESCE(SUM(worker_pay), 0) AS pay FROM orders WHERE driver_id = ? AND status = 'done'", u.id);
  res.page(fullName(u), html`
${u.role === 'driver' ? html`<p class="muted">Выполнено заявок: ${stats.n} · начислено ${money(stats.pay)}. В CRM с ${date(utcToLocal(u.created_at))}.</p>` : ''}
${form(u, { action: `/staff/${u.id}`, submit: 'Сохранить' })}`);
});

r.post('/:id', manageOnly, async (req, res) => {
  const old = await editable(req.params.id);
  if (!old) return res.redirect('/staff');
  const u = readForm(req.body);
  const error = await checkForm(u, old.id);
  if (error) {
    res.flash(error);
    return res.status(400).page(fullName(old), form({ ...u, id: old.id }, { action: `/staff/${old.id}`, submit: 'Сохранить' }));
  }
  await run('UPDATE users SET login = ?, role = ?, first_name = ?, last_name = ?, phone = ?, note = ?, active = ? WHERE id = ?',
    u.login, u.role, u.first_name, u.last_name, u.phone, u.note, u.active, old.id);
  if (u.password) await run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(u.password), old.id);
  // Отключённый человек или новый пароль — старые входы больше не действуют.
  if (!u.active || u.password) await run('DELETE FROM sessions WHERE user_id = ?', old.id);
  res.flash('Сохранено.');
  res.redirect('/staff');
});

module.exports = r;
