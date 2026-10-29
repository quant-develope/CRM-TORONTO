const { ROLES, STATUS, can, is } = require('./roles');

const TZ = 'America/Toronto';
// Меняйте вместе с VERSION в public/sw.js: так браузеры сразу получают новые style.css и app.js.
const ASSET_VERSION = '15';

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
  // Канадский формат: $1,250 CAD, $12.50 CAD, −$180 CAD.
  const v = Number(n || 0);
  const s = Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}$${s} CAD`;
}

function phoneHref(phone) {
  return `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;
}

function phoneLink(phone) {
  if (!phone) return '—';
  return html`<a href="${phoneHref(phone)}">${phone}</a>`;
}

// Написать клиенту в WhatsApp: ссылка wa.me с номером в международном формате (10 цифр — Канада/США, +1).
const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>';

function whatsappButton(phone, { small = false } = {}) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = `1${d}`;
  if (d.length < 11) return '';
  return html`<a href="https://wa.me/${d}" target="_blank" rel="noopener" class="button wa${small ? ' small' : ''}">${raw(WA_ICON)}WhatsApp</a>`;
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
    groups.push(['Заявки', [['/orders/new', 'Новая заявка'], ['/orders', 'Все заявки'], ['/leads', 'Заявки с сайтов'], ['/clients', 'Клиенты'], ['/calls', 'Звонки'], ['/drivers', 'Свободны / заняты'], ['/report', 'Отчёт']]]);
  }
  if (is(user, 'driver')) {
    groups.push(['Мои заявки', [['/jobs/done', 'Выполненные заявки']]]);
  }
  if (can.viewStaff(user)) {
    const links = [['/staff', 'Сотрудники'], ['/sites', 'Сайты']];
    if (can.manageStaff(user)) links.push(['/staff/new', 'Добавить сотрудника']);
    if (can.viewAuthLog(user)) links.push(['/auth-log', 'Журнал входов']);
    groups.push(['Команда', links]);
  }
  groups.push(['Аккаунт', [['/account', 'Мой пароль']]]);
  return groups;
}

// Кнопка «Установить приложение» — только на компьютере (Chrome/Edge), показывает /app.js.
function installBox() {
  return html`<div class="install" data-install>
  <b>Установить приложение</b>
  <span>Toronto CRM откроется с рабочего стола, как обычная программа.</span>
    <button type="button" class="secondary" data-install-button>Установить</button>
</div>`;
}

// Плашка на главной: включить push на этом телефоне (скрывается, когда уже включены).
function pushBanner(text) {
  return html`<div class="notice push-banner" data-push data-banner hidden>
  <b>Уведомления на телефон</b>
  <span>${text}</span>
  <span data-push-status></span>
  <button type="button" data-push-button hidden>Включить уведомления</button>
</div>`;
}

// Ползунок «В сети»: зелёный — в сети, серый — нет. Переключается сразу, без отдельной кнопки.
function onlineSwitch(user, path) {
  return html`<form method="post" action="/online" class="online-switch" id="online">
  <input type="hidden" name="back" value="${path}">
  <label class="switch${user.online ? ' on' : ''}">
    <input type="checkbox" name="online" value="1"${user.online ? raw(' checked') : ''} onchange="this.form.submit()" aria-label="В сети">
    <span class="switch-track"><span class="switch-knob"></span></span>
    <span class="switch-text">${user.online ? 'В сети' : 'Не в сети'}</span>
  </label>
  <noscript><button class="secondary small-btn">Сохранить</button></noscript>
</form>`;
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
<html lang="ru"${user ? html` data-events="1"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
${refresh ? html`<meta http-equiv="refresh" content="${refresh}">` : ''}
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/inter-cyrillic.woff2" as="font" type="font/woff2" crossorigin>
<title>Toronto CRM</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai">
<link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Toronto CRM">
<script src="/app.js?v=${ASSET_VERSION}" defer></script>
<script type="speculationrules">{"prefetch":[{"where":{"and":[{"href_matches":"/*"},{"not":{"href_matches":"/logout*"}}]},"eagerness":"moderate"}]}</script>
</head>
<body>
${user ? html`
<input type="checkbox" id="nav-toggle" class="nav-toggle" hidden>
<header class="top">
  <a href="/" class="brand">${brandLogo()}TORONTO CRM</a>
  ${user.online ? '' : html`<a href="#online" class="offline-badge" onclick="document.getElementById('nav-toggle').checked = true; return false;">вы не в сети</a>`}
  <label for="nav-toggle" class="burger" aria-label="Меню"><span></span><span></span><span></span></label>
</header>
<label for="nav-toggle" class="scrim" aria-hidden="true"></label>
<aside class="drawer">
  <div class="drawer-head">
    <div class="who">
      <div class="who-name">${fullName(user)}</div>
      <div class="who-line">
        ${can.viewStaff(user) ? html`<span class="role role-${user.role}">${ROLES[user.role]}</span>` : ''}
        ${onlineSwitch(user, path)}
      </div>
    </div>
    <label for="nav-toggle" class="close" aria-label="Закрыть"></label>
  </div>
  <nav class="side">
    <div class="nav-group"><a href="/" class="${path === '/' ? 'active' : ''}">Главная</a></div>
    ${nav}
  </nav>
  <div class="drawer-foot">
    <div class="push-box" data-push hidden>
      <span data-push-status>Уведомления</span>
      <button type="button" class="secondary" data-push-button hidden>Включить уведомления</button>
    </div>
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
  html, raw, escape, layout, brandLogo, installBox, pushBanner, fullName, date, when, nowLocal, todayLocal, utcToLocal, money,
  phoneHref, phoneLink, whatsappButton, navUrl, wazeUrl, mapsLink, roleTag, statusFlag, options,
};
