// Сайты, которые обслуживают Quant, Веб и КЦ: адрес сайта, привязанные номера телефонов и кто его ведёт.
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can, OFFICE } = require('../roles');
const { html, raw, fullName, phoneLink, roleTag } = require('../html');

const r = new Router();

r.use((req, res, next) => (can.viewStaff(req.user) ? next() : res.denied()));
const manageOnly = (req, res, next) => (can.manageSites(req.user) ? next() : res.denied());

const phonesOf = (site) => String(site.phones || '').split(',').map((p) => p.trim()).filter(Boolean);
const siteHref = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

// Сайты и кто их ведёт: { siteId: [user, …] }.
async function sitesWithStaff() {
  const sites = await all('SELECT * FROM sites ORDER BY name');
  const links = await all(`SELECT us.site_id, u.id, u.first_name, u.last_name, u.login, u.role FROM user_sites us
                           JOIN users u ON u.id = us.user_id WHERE u.active = 1 ORDER BY u.first_name`);
  return sites.map((s) => ({ ...s, staff: links.filter((l) => l.site_id === s.id) }));
}

// Сайты сотрудника — для кнопки «Сайты» в списке сотрудников.
async function sitesByUser() {
  const rows = await all('SELECT us.user_id, s.* FROM user_sites us JOIN sites s ON s.id = us.site_id ORDER BY s.name');
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push(row);
  }
  return map;
}

function sitesDropdown(sites) {
  if (!sites || !sites.length) return html`<span class="muted small">нет сайтов</span>`;
  return html`<details class="dropdown">
  <summary class="button secondary small-btn">Сайты <b>${sites.length}</b></summary>
  <ul class="dropdown-list">${sites.map((s) => html`<li>
    <b>${s.name}</b>${s.url ? html` <a href="${siteHref(s.url)}" target="_blank" rel="noopener" class="small">${s.url} ↗</a>` : ''}
    <span class="small">${phonesOf(s).length ? phonesOf(s).map((p, i) => html`${i ? ', ' : ''}${phoneLink(p)}`) : html`<span class="muted">номеров нет</span>`}</span>
  </li>`)}</ul>
</details>`;
}

r.get('/', async (req, res) => {
  const sites = await sitesWithStaff();
  const manage = can.manageSites(req.user);
  res.page('Сайты', html`
${manage ? html`<div class="toolbar"><span></span><a href="/sites/new" class="button">+ Добавить сайт</a></div>` : ''}
${sites.length ? html`<div class="table-wrap"><table>
<tr><th>Сайт</th><th>Номера телефонов</th><th>Кто ведёт</th><th></th></tr>
${sites.map((s) => html`<tr>
  <td><b>${s.name}</b>${s.url ? html`<br><a href="${siteHref(s.url)}" target="_blank" rel="noopener" class="small">${s.url} ↗</a>` : ''}</td>
  <td>${phonesOf(s).length ? phonesOf(s).map((p) => html`<div>${phoneLink(p)}</div>`) : '—'}</td>
  <td>${s.staff.length ? s.staff.map((u) => html`<div>${fullName(u)} ${roleTag(u.role)}</div>`) : '—'}</td>
  <td>${manage ? html`<a href="/sites/${s.id}">Изменить</a>` : ''}</td>
</tr>`)}
</table></div>` : html`<p class="muted">Сайтов пока нет.${manage ? html` <a href="/sites/new">Добавить сайт →</a>` : ''}</p>`}`);
});

async function form(s, { action, submit }) {
  const office = await all(`SELECT * FROM users WHERE active = 1 AND role IN (${OFFICE.map(() => '?').join(', ')})
                            ORDER BY CASE role WHEN 'quant' THEN 0 WHEN 'web' THEN 1 ELSE 2 END, first_name`, ...OFFICE);
  const chosen = new Set((s.staffIds || []).map(Number));
  return html`
<form method="post" action="${action}">
  <div class="grid">
    <label>Название<input name="name" value="${s.name || ''}" required placeholder="Snow Removal Toronto"></label>
    <label>Адрес сайта<input name="url" value="${s.url || ''}" placeholder="snowtoronto.ca" autocapitalize="none"></label>
    <label class="wide">Номера телефонов (через запятую)<input name="phones" value="${s.phones || ''}" placeholder="+1 416 555-0100, +1 647 555-0101"></label>
    <fieldset class="wide"><legend>Кто ведёт сайт</legend>
      ${office.map((u) => html`<label class="check"><input type="checkbox" name="staff" value="${u.id}"${chosen.has(u.id) ? raw(' checked') : ''}> ${fullName(u)} ${roleTag(u.role)}</label>`)}
    </fieldset>
  </div>
  <div class="actions"><button>${submit}</button><a href="/sites" class="button secondary">Отмена</a></div>
</form>
${s.id ? html`<form method="post" action="/sites/${s.id}/delete" class="danger-zone" onsubmit="return confirm('Удалить сайт «${s.name}»?')"><button class="secondary">Удалить сайт</button></form>` : ''}`;
}

function readForm(body) {
  return {
    name: String(body.name || '').trim(),
    url: String(body.url || '').trim(),
    phones: String(body.phones || '').split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean).join(', '),
    staffIds: [].concat(body.staff || []).map(Number).filter(Boolean),
  };
}

async function saveStaff(siteId, staffIds) {
  await run('DELETE FROM user_sites WHERE site_id = ?', siteId);
  for (const id of staffIds) await run('INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)', id, siteId);
}

r.get('/new', manageOnly, async (req, res) => res.page('Новый сайт', await form({}, { action: '/sites', submit: 'Добавить' })));

r.post('/', manageOnly, async (req, res) => {
  const s = readForm(req.body);
  if (!s.name) {
    res.flash('Укажите название сайта.');
    return res.status(400).page('Новый сайт', await form(s, { action: '/sites', submit: 'Добавить' }));
  }
  const { lastInsertRowid } = await run('INSERT INTO sites (name, url, phones) VALUES (?, ?, ?)', s.name, s.url, s.phones);
  await saveStaff(lastInsertRowid, s.staffIds);
  res.flash(`Сайт «${s.name}» добавлен.`);
  res.redirect('/sites');
});

r.get('/:id', manageOnly, async (req, res) => {
  const s = await get('SELECT * FROM sites WHERE id = ?', req.params.id);
  if (!s) return res.redirect('/sites');
  s.staffIds = (await all('SELECT user_id FROM user_sites WHERE site_id = ?', s.id)).map((x) => x.user_id);
  res.page(s.name, await form(s, { action: `/sites/${s.id}`, submit: 'Сохранить' }));
});

r.post('/:id', manageOnly, async (req, res) => {
  const old = await get('SELECT * FROM sites WHERE id = ?', req.params.id);
  if (!old) return res.redirect('/sites');
  const s = readForm(req.body);
  if (!s.name) {
    res.flash('Укажите название сайта.');
    return res.status(400).page(old.name, await form({ ...s, id: old.id }, { action: `/sites/${old.id}`, submit: 'Сохранить' }));
  }
  await run('UPDATE sites SET name = ?, url = ?, phones = ? WHERE id = ?', s.name, s.url, s.phones, old.id);
  await saveStaff(old.id, s.staffIds);
  res.flash('Сохранено.');
  res.redirect('/sites');
});

r.post('/:id/delete', manageOnly, async (req, res) => {
  await run('DELETE FROM user_sites WHERE site_id = ?', req.params.id);
  await run('DELETE FROM sites WHERE id = ?', req.params.id);
  res.flash('Сайт удалён.');
  res.redirect('/sites');
});

module.exports = r;
module.exports.sitesByUser = sitesByUser;
module.exports.sitesDropdown = sitesDropdown;
module.exports.sitesWithStaff = sitesWithStaff;
