// Toronto CRM в браузере: service worker, установка приложения (PWA) и быстрые клавиши на компьютере.
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvent = null;

function showInstall() {
  if (standalone) return;
  document.querySelectorAll('[data-install]').forEach((box) => {
    box.classList.add('show');
    box.classList.toggle('ios-only', ios && !installEvent);
  });
}

// Android и Chrome/Edge на компьютере: браузер сам сообщает, что приложение можно установить.
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installEvent = event;
  showInstall();
});
addEventListener('appinstalled', () => document.querySelectorAll('[data-install]').forEach((box) => box.classList.remove('show')));

document.addEventListener('DOMContentLoaded', () => {
  if (ios) showInstall(); // Safari не умеет ставить по кнопке — показываем подсказку.
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
