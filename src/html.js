const { ROLES, STATUS, can, is } = require('./roles');

const TZ = 'America/Toronto';

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

const raw = (value) => new Raw(String(value));

function escape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

// Шаблон с автоматическим экранированием: html`<p>${text}</p>`.
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += render(value) + strings[i + 1]; });
  return new Raw(out);
}

function fullName(u) {
  if (!u) return '—';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return name || u.login || '—';
}

// Текущее время в Торонто: «2026-10-29 08:15».
function nowLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
}
const todayLocal = () => nowLocal().slice(0, 10);

// Время из SQLite datetime('now') (UTC) — во время Торонто.
function utcToLocal(d) {
  if (!d) return '';
  return new Date(`${String(d).replace(' ', 'T')}Z`).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
}

function date(d) {
  if (!d) return '—';
  const [y, m, rest] = String(d).replace('T', ' ').split('-');
  if (!rest) return d;
  const day = rest.slice(0, 2);
  const time = rest.length > 2 ? rest.slice(3, 8) : '';
  return `${day}.${m}.${y}${time ? ' ' + time : ''}`;
}

// Время приезда коротко: «сегодня 08:30», «завтра 07:00» или «31.10 09:00».
function when(d) {
  if (!d) return '—';
  const s = String(d).replace('T', ' ');
  const day = s.slice(0, 10);
  const time = s.slice(11, 16);
  const today = todayLocal();
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (day === today) return `сегодня ${time}`;
  if (day === tomorrow.toISOString().slice(0, 10)) return `завтра ${time}`;
  return `${day.slice(8, 10)}.${day.slice(5, 7)} ${time}`;
}

function money(n) {
  return `${Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} $`;
}

function phoneHref(phone) {
  return `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;
}

function phoneLink(phone) {
  if (!phone) return '—';
  return html`<a href="${phoneHref(phone)}">${phone}</a>`;
}

// В поле адреса могут вставить готовую ссылку на карты — тогда ведём прямо по ней.
const isUrl = (address) => /^https?:\/\//i.test(String(address || '').trim());

// Маршрут до адреса: на телефоне открывается приложение Google Карт в режиме навигации.
function navUrl(address) {
  if (isUrl(address)) return String(address).trim();
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving&dir_action=navigate`;
}

function wazeUrl(address) {
  return `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`;
}

function mapsLink(address) {
  if (!address) return '—';
  return html`<a href="${navUrl(address)}" target="_blank" rel="noopener">${isUrl(address) ? 'Открыть на карте' : address} ↗</a>`;
}

function roleTag(role) {
  if (!ROLES[role]) return '';
  return html`<span class="rtag rtag-${role}">${ROLES[role]}</span>`;
}

function statusFlag(status) {
  const [label, color] = STATUS[status] || [status, 'gray'];
  return html`<span class="flag flag-${color}"><i></i>${label}</span>`;
}

function options(list, selected, { empty } = {}) {
  const entries = Array.isArray(list) ? list.map((v) => [v, v]) : Object.entries(list);
  return html`${empty !== undefined ? html`<option value="">${empty}</option>` : ''}${entries.map(
    ([value, label]) => html`<option value="${value}"${String(value) === String(selected ?? '') ? raw(' selected') : ''}>${label}</option>`,
  )}`;
}

function menuFor(user) {
  const groups = [];
  if (can.manageOrders(user)) {
    groups.push(['Заявки', [['/orders/new', 'Новая заявка'], ['/orders', 'Все заявки'], ['/drivers', 'Свободны / заняты'], ['/report', 'Отчёт']]]);
  }
  if (is(user, 'driver')) {
    groups.push(['Мои заявки', [['/jobs/done', 'Выполненные заявки']]]);
  }
  if (can.viewStaff(user)) {
    const links = [['/staff', 'Сотрудники']];
    if (can.manageStaff(user)) links.push(['/staff/new', 'Добавить сотрудника']);
    if (can.viewAuthLog(user)) links.push(['/auth-log', 'Журнал входов']);
    groups.push(['Команда', links]);
  }
  groups.push(['Аккаунт', [['/account', 'Мой пароль']]]);
  return groups;
}

// Предложение установить приложение. Показывает /app.js: на Android и компьютере — кнопка, на iPhone — подсказка.
function installBox() {
  return html`<div class="install" data-install>
  <b>Установить приложение</b>
  <span>Toronto CRM откроется с экрана телефона или с рабочего стола, как обычная программа.</span>
  <span class="ios">На iPhone: в Safari нажмите «Поделиться» (квадрат со стрелкой) → «На экран „Домой“».</span>
  <button type="button" class="secondary" data-install-button>Установить</button>
</div>`;
}

function brandLogo() {
  return html`<img src="/logo.svg" alt="" class="brand-logo">`;
}

function layout({ user, title, body, path = '', flash, refresh }) {
  const groups = user ? menuFor(user) : [];
  const nav = groups.map(([label, links]) => html`
    <div class="nav-group">
      ${links.length > 1 ? html`<div class="nav-title">${label}</div>` : ''}
      ${links.map(([href, text]) => html`<a href="${href}" class="${path === href ? 'active' : ''}">${text}</a>`)}
    </div>`);

  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
${refresh ? html`<meta http-equiv="refresh" content="${refresh}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<title>${title} · Toronto CRM</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Toronto CRM">
<script src="/app.js" defer></script>
</head>
<body>
${user ? html`
<input type="checkbox" id="nav-toggle" class="nav-toggle" hidden>
<header class="top">
  <a href="/" class="brand">${brandLogo()}TORONTO CRM</a>
  <label for="nav-toggle" class="burger" aria-label="Меню"><span></span><span></span><span></span></label>
</header>
<label for="nav-toggle" class="scrim" aria-hidden="true"></label>
<aside class="drawer">
  <div class="drawer-head">
    <div class="who">
      <div class="who-name">${fullName(user)}</div>
      ${can.viewStaff(user) ? html`<span class="role role-${user.role}">${ROLES[user.role]}</span>` : ''}
    </div>
    <label for="nav-toggle" class="close" aria-label="Закрыть"></label>
  </div>
  <nav class="side">
    <div class="nav-group"><a href="/" class="${path === '/' ? 'active' : ''}">Главная</a></div>
    ${nav}
  </nav>
  <div class="drawer-foot">
    ${installBox()}
    <form method="post" action="/logout"><button class="secondary">Выйти</button></form>
  </div>
</aside>
<main>
  ${flash ? html`<div class="flash">${flash}</div>` : ''}
  <h1>${title}</h1>
  ${body}
</main>` : body}
</body>
</html>`;
}

module.exports = {
  html, raw, escape, layout, brandLogo, installBox, fullName, date, when, nowLocal, todayLocal, utcToLocal, money,
  phoneHref, phoneLink, navUrl, wazeUrl, mapsLink, roleTag, statusFlag, options,
};
