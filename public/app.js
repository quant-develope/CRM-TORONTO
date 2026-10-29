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
  setTimeout(() => a.classList.add('hide'), 12000);
  setTimeout(() => a.remove(), 12600);
}

async function pollEvents() {
  if (!eventsOn || document.hidden) return;
  try {
    const url = lastEvent === null ? '/api/events' : `/api/events?after=${lastEvent}`;
    const data = await (await fetch(url, { credentials: 'same-origin', cache: 'no-store' })).json();
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
