// Toronto CRM в браузере: service worker, установка приложения (PWA) и быстрые клавиши на компьютере.
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvent = null;

function showInstall() {
  if (standalone) return;
  document.querySelectorAll('[data-install]').forEach((box) => {
    box.classList.add('show');
  });
}

// Chrome/Edge на компьютере: браузер сам сообщает, что приложение можно установить.
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installEvent = event;
  showInstall();
});
addEventListener('appinstalled', () => document.querySelectorAll('[data-install]').forEach((box) => box.classList.remove('show')));

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-install-button]').forEach((button) => button.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
  }));
});

// Быстрые клавиши (КЦ на компьютере): N — новая заявка, Z — заявки, D — свободны / заняты.
const KEYS = { n: '/orders/new', z: '/orders', d: '/drivers' };
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable]')) return;
  const href = KEYS[event.key.toLowerCase()];
  if (href && document.querySelector(`.side a[href="${href}"]`)) location.href = href;
});

// --- Геолокация работника ---
// Точка отправляется не постоянно, а когда CRM попросила (флаг geo в /api/events), при «Принять» и по кнопке разрешения.
const geoOn = document.documentElement.dataset.geo === '1';
// iPad с iPadOS 13+ представляется как Mac — отличаем по сенсорному экрану.
const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const android = /android/i.test(navigator.userAgent);
let geoBusy = false;

// Браузер уже отдавал точку: плашку больше не показываем (Safari на iPhone не сообщает «разрешено» через permissions).
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (err) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (err) { /* без хранилища */ } },
};

function sendGeo({ timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!geoOn || geoBusy || !('geolocation' in navigator)) return resolve(false);
    geoBusy = true;
    const done = (ok) => { geoBusy = false; geoState(); resolve(ok); };
    navigator.geolocation.getCurrentPosition(async (pos) => {
      store.set('geoOk', '1');
      try {
        await fetch('/api/geo', {
          method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        });
      } catch (err) { /* нет связи — CRM попросит ещё раз */ }
      done(true);
    }, (err) => {
      if (err.code === 1) store.set('geoOk', null);
      done(false);
    }, { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}

// Как разрешить геолокацию навсегда: отдельно для iPhone / Android / компьютера и для браузера / приложения с экрана «Домой».
const GEO_HELP = [
  { id: 'iphone-browser', title: 'iPhone, в браузере Safari', steps: [
    'Нажмите «аА» слева от адреса сайта.',
    '«Настройки веб-сайта» → «Геопозиция».',
    'Выберите «Разрешить».',
  ] },
  { id: 'iphone-app', title: 'iPhone, приложение с экрана «Домой»', steps: [
    'Откройте «Настройки» iPhone → «Конфиденциальность и безопасность» → «Службы геолокации» (должны быть включены).',
    'Пролистайте до «Сайты Safari» и выберите «При использовании приложения».',
    'Включите «Точная геопозиция».',
  ] },
  { id: 'android-browser', title: 'Android, в браузере Chrome', steps: [
    'Нажмите значок настроек слева от адреса сайта.',
    '«Разрешения» → «Местоположение».',
    'Выберите «Разрешить». На телефоне должна быть включена геолокация (шторка → «Местоположение»).',
  ] },
  { id: 'android-app', title: 'Android, приложение с экрана «Домой»', steps: [
    'Откройте Chrome → меню ⋮ → «Настройки» → «Настройки сайтов» → «Местоположение».',
    'Найдите сайт CRM (crm-toronto1…) и выберите «Разрешить».',
    'Проверьте, что геолокация на телефоне включена (шторка → «Местоположение»).',
  ] },
  { id: 'computer', title: 'Компьютер', steps: [
    'Нажмите значок слева от адреса сайта.',
    'В «Разрешениях» для «Местоположение» выберите «Разрешить».',
  ] },
];
const geoDevice = iphone ? `iphone-${standalone ? 'app' : 'browser'}` : android ? `android-${standalone ? 'app' : 'browser'}` : 'computer';

function helpBlock({ title, steps }, tag = 'div') {
  const block = document.createElement(tag);
  block.className = 'geo-help-item';
  const h = document.createElement('b');
  h.textContent = title;
  const ol = document.createElement('ol');
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    ol.append(li);
  }
  block.append(h, ol);
  return block;
}

// Инструкция для этого устройства, остальные — под «Другое устройство».
function geoHelp(box, show) {
  let help = box.querySelector('[data-geo-help]');
  if (!help) {
    help = document.createElement('div');
    help.className = 'geo-help';
    help.dataset.geoHelp = '';
    box.querySelector('[data-geo-button]').before(help);
  }
  help.hidden = !show;
  if (!show || help.childElementCount) return;
  help.append(helpBlock(GEO_HELP.find((h) => h.id === geoDevice)));
  const other = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Другое устройство';
  other.append(summary, ...GEO_HELP.filter((h) => h.id !== geoDevice).map((h) => helpBlock(h)));
  help.append(other);
}

// Плашка «Разрешить геолокацию»: видна, пока доступ не дан. На iPhone после первого разрешения —
// один раз подсказка, как разрешить навсегда (иначе Safari спрашивает снова при каждом открытии сайта).
async function geoState() {
  const box = document.querySelector('[data-geo-banner]');
  if (!box || !geoOn) return;
  const status = box.querySelector('[data-geo-status]');
  const button = box.querySelector('[data-geo-button]');
  if (!('geolocation' in navigator)) {
    status.textContent = 'Этот браузер не даёт местоположение — системное предложение вас не учтёт.';
    button.hidden = true;
    box.hidden = false;
    return;
  }
  let state = 'prompt';
  try { state = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch (err) { /* старый браузер — покажем кнопку */ }
  if (state === 'denied') {
    store.set('geoOk', null);
    status.textContent = 'Геолокация запрещена — система не сможет предлагать вам заявки рядом. Как разрешить:';
    geoHelp(box, true);
    button.hidden = true;
    box.hidden = false;
    return;
  }
  if (state === 'granted' || store.get('geoOk')) {
    if (iphone && !store.get('geoTip2')) {
      status.textContent = 'Готово. Чтобы iPhone больше не спрашивал разрешение:';
      geoHelp(box, true);
      button.textContent = 'Понятно';
      button.dataset.tip = '1';
      button.hidden = false;
      box.hidden = false;
      return;
    }
    box.hidden = true;
    return;
  }
  geoHelp(box, false);
  box.hidden = false;
}

if (geoOn) {
  document.addEventListener('DOMContentLoaded', geoState);
  document.addEventListener('click', (event) => {
    const b = event.target.closest('[data-geo-button]');
    if (!b) return;
    if (b.dataset.tip) { store.set('geoTip2', '1'); geoState(); return; }
    sendGeo();
  });
  // «Принять» заявку: сначала точка (откуда работник выезжает), потом переход в навигатор.
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!form.matches('form[action$="/accept"]') || form.dataset.sent) return;
    event.preventDefault();
    form.dataset.sent = '1';
    await sendGeo({ timeout: 5000 });
    form.submit();
  });
}

// Страница работника без заявки в работе обновляется сама, но без перезагрузки: только содержимое.
// Так новая заявка появляется сразу, а браузер не спрашивает геолокацию заново после каждой перезагрузки.
const softRefresh = Number(document.documentElement.dataset.softRefresh) || 0;
let lastMain = null;
if (softRefresh) {
  setInterval(async () => {
    if (document.hidden || document.activeElement?.closest('input, textarea, select') || document.querySelector('details[open]')) return;
    try {
      const res = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok || res.redirected) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const fresh = doc.querySelector('main');
      const main = document.querySelector('main');
      if (!fresh || !main || fresh.innerHTML === lastMain) return;
      lastMain = fresh.innerHTML;
      // Плашки сохраняют своё состояние (скрыта / показана), остальное заменяется.
      const keep = [...main.querySelectorAll('[data-geo-banner], [data-push]')];
      main.innerHTML = fresh.innerHTML;
      for (const old of keep) {
        const sel = old.matches('[data-geo-banner]') ? '[data-geo-banner]' : '[data-push]';
        const slot = main.querySelector(sel);
        if (slot) slot.replaceWith(old);
      }
      // Заявка взята в работу — дальше страница больше не обновляется сама.
      if (!doc.documentElement.dataset.softRefresh) location.reload();
    } catch (err) { /* нет связи — в следующий раз */ }
  }, softRefresh * 1000);
}

// --- Расстояние до работника и системное предложение (КЦ, Веб, Quant) ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Заявка: блок «Где работник». Телефон работника присылает точку в течение ~10 секунд, поэтому спрашиваем несколько раз.
async function loadDistance(box) {
  const text = box.querySelector('[data-distance-text]');
  const note = box.querySelector('[data-distance-note]');
  for (const wait of [0, 6000, 8000, 10000]) {
    await sleep(wait);
    try {
      const d = await (await fetch(box.dataset.distance, { credentials: 'same-origin', cache: 'no-store' })).json();
      text.textContent = d.text;
      note.textContent = d.note || '';
      if (!d.waiting) return;
    } catch (err) { return; }
  }
}

// Новая заявка: по адресу — работник в сети с наименьшим числом заявок и ближе всех.
function setupSuggest(box) {
  const form = box.closest('form');
  const address = form.querySelector('[name="address"]');
  const select = form.querySelector('[name="driver_id"]');
  let run = 0;
  let autoPicked = false;
  const render = (d) => {
    box.replaceChildren();
    const head = document.createElement('div');
    head.className = 'suggest-head';
    head.textContent = 'Системное предложение';
    box.append(head);
    if (!d.best) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = d.text;
      box.append(p);
      return;
    }
    const line = document.createElement('div');
    line.className = 'suggest-best';
    const name = document.createElement('b');
    name.textContent = d.best.name;
    const info = document.createElement('span');
    info.textContent = d.best.info;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'secondary small-btn';
    pick.textContent = String(select.value) === String(d.best.id) ? 'Выбран' : 'Назначить';
    pick.addEventListener('click', () => { select.value = d.best.id; pick.textContent = 'Выбран'; });
    line.append(name, info, pick);
    box.append(line);
    if (d.text) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = d.text;
      box.append(p);
    }
    if (d.others.length) {
      const ul = document.createElement('ul');
      ul.className = 'suggest-others small';
      for (const o of d.others) {
        const li = document.createElement('li');
        li.textContent = `${o.name} — ${o.info}`;
        ul.append(li);
      }
      box.append(ul);
    }
  };
  const load = async () => {
    const value = address.value.trim();
    if (!value) { box.hidden = true; return; }
    const mine = ++run;
    box.hidden = false;
    for (const wait of [0, 6000, 8000, 10000]) {
      await sleep(wait);
      if (mine !== run) return;
      try {
        const q = new URLSearchParams({ address: value, order: box.dataset.order || '' });
        const d = await (await fetch(`/orders/suggest?${q}`, { credentials: 'same-origin', cache: 'no-store' })).json();
        if (mine !== run) return;
        // Водитель ещё не выбран — подставляем предложение.
        if (d.best && (!select.value || autoPicked)) { select.value = d.best.id; autoPicked = true; }
        render(d);
        if (!d.waiting) return;
      } catch (err) { return; }
    }
  };
  select.addEventListener('change', () => { autoPicked = false; });
  address.addEventListener('change', load);
  if (address.value.trim()) load();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-distance]').forEach((box) => loadDistance(box));
  document.querySelectorAll('[data-suggest]').forEach((box) => setupSuggest(box));
});

// --- Уведомления ---
// Всплывающее уведомление в правом верхнем углу: сайт раз в 10 секунд спрашивает новые события.
const eventsOn = document.documentElement.dataset.events === '1';
let lastEvent = null;
const shownEvents = new Set();

function toast(e) {
  if (shownEvents.has(e.id)) return;
  shownEvents.add(e.id);
  let box = document.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const a = document.createElement('a');
  a.className = 'toast';
  a.href = e.url;
  const title = document.createElement('b');
  title.textContent = e.title;
  const body = document.createElement('span');
  body.textContent = e.body;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  close.addEventListener('click', (ev) => { ev.preventDefault(); a.remove(); });
  a.append(title, body, close);
  box.prepend(a);
  // Звонок висит дольше: оператор успевает нажать и начать заявку.
  const ms = e.status === 'call' ? 45000 : 12000;
  setTimeout(() => a.classList.add('hide'), ms);
  setTimeout(() => a.remove(), ms + 600);
}

async function pollEvents() {
  if (!eventsOn || document.hidden) return;
  try {
    const url = lastEvent === null ? '/api/events' : `/api/events?after=${lastEvent}`;
    const data = await (await fetch(url, { credentials: 'same-origin', cache: 'no-store' })).json();
    if (geoOn && data.geo) sendGeo();
    if (lastEvent === null) { lastEvent = data.last; return; }
    for (const e of data.events) { toast(e); lastEvent = Math.max(lastEvent, e.id); }
  } catch (err) { /* нет связи — спросим в следующий раз */ }
}

if (eventsOn) {
  try { const saved = Number(sessionStorage.getItem('lastEvent')); if (saved) lastEvent = saved; } catch (err) { /* без хранилища */ }
  pollEvents();
  setInterval(pollEvents, 10000);
  document.addEventListener('visibilitychange', pollEvents);
  addEventListener('pagehide', () => { try { if (lastEvent !== null) sessionStorage.setItem('lastEvent', lastEvent); } catch (err) { /* без хранилища */ } });
  // Пришёл push, а сайт открыт — сразу показать уведомление в углу.
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (m) => { if (m.data === 'events') pollEvents(); });
}

// Push на телефон и компьютер: кнопка в меню «Уведомления на этом устройстве».
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function pushState(box) {
  const status = box.querySelector('[data-push-status]');
  const button = box.querySelector('[data-push-button]');
  box.hidden = false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    status.textContent = /iphone|ipad/i.test(navigator.userAgent)
      ? 'На iPhone уведомления работают, если открыть Toronto CRM с экрана «Домой».'
      : 'Этот браузер не поддерживает уведомления.';
    button.hidden = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  // Уведомления уже включены — ни плашки, ни кнопки в меню не показываем.
  if (sub || (box.dataset.banner !== undefined && Notification.permission === 'denied')) { box.hidden = true; return; }
  if (Notification.permission === 'denied') {
    status.textContent = 'Уведомления запрещены в настройках браузера.';
    button.hidden = true;
  } else {
    status.textContent = box.dataset.banner !== undefined ? '' : sub ? 'Уведомления включены на этом устройстве.' : 'Уведомления на этом устройстве выключены.';
    button.textContent = sub ? 'Выключить' : 'Включить уведомления';
    button.hidden = false;
  }
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (sub) {
        await fetch('/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      } else {
        if ((await Notification.requestPermission()) !== 'granted') return;
        const { key } = await (await fetch('/push/key')).json();
        const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        await fetch('/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fresh) });
      }
    } catch (err) {
      status.textContent = 'Не получилось. Попробуйте ещё раз.';
      console.error(err);
    } finally {
      button.disabled = false;
      document.querySelectorAll('[data-push]').forEach((b) => pushState(b).catch(console.error));
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-push]').forEach((box) => pushState(box).catch(console.error));
});
