// Сотрудники. Список с ролями видят Quant и КЦ, добавляет и меняет людей только Quant.
const { Router } = require('../mini');
const { get, all, run, hashPassword } = require('../db');
const { can, ROLES, STAFF_ROLES } = require('../roles');
const { html, raw, fullName, date, utcToLocal, money, phoneLink, roleTag, options } = require('../html');
const { ACTIVE_SQL } = require('../board');

const r = new Router();

r.use((req, res, next) => {
  if (!can.viewStaff(req.user)) return res.denied();
  next();
});

const manageOnly = (req, res, next) => (can.manageStaff(req.user) ? next() : res.denied());

r.get('/', async (req, res) => {
  const rows = await all(`SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status IN (${ACTIVE_SQL})) AS open_jobs,
      (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status = 'done') AS done_jobs
    FROM users u ORDER BY u.active DESC, CASE u.role WHEN 'quant' THEN 0 WHEN 'dispatcher' THEN 1 ELSE 2 END, u.first_name, u.last_name`);
  const manage = can.manageStaff(req.user);
  res.page('Сотрудники', html`
${manage ? html`<div class="toolbar"><span></span><a href="/staff/new" class="button">+ Добавить сотрудника</a></div>` : ''}
<div class="table-wrap"><table>
<tr><th>Имя</th><th>Роль</th><th>Телефон</th><th>Логин</th><th>Заявки</th><th></th></tr>
${rows.map((u) => html`<tr class="${u.active ? '' : 'inactive'}">
  <td>${fullName(u)}${u.active ? '' : html` <span class="muted small">(отключён)</span>`}</td>
  <td>${roleTag(u.role)}</td>
  <td>${phoneLink(u.phone)}</td>
  <td>${u.login}</td>
  <td>${u.role === 'driver' ? html`${u.open_jobs ? html`<span class="flag flag-orange"><i></i>занят</span>` : html`<span class="flag flag-green"><i></i>свободен</span>`} <span class="muted small">выполнено ${u.done_jobs}</span>` : ''}</td>
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
