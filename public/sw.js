// Service worker Toronto CRM: оболочка сайта (стили, логотип, иконки, шрифт) берётся из кэша,
// страницы с данными всегда загружаются с сервера и в кэш не попадают.
// После изменения style.css или иконок увеличьте VERSION, чтобы телефоны получили новые файлы.
const VERSION = 'toronto-v1';
const SHELL = [
  '/style.css',
  '/logo.png',
  '/logo.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/offline',
];
const FONTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Страницы: только с сервера; без связи — страница «Нет связи».
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    return;
  }

  // Оболочка и шрифт: сразу из кэша, в фоне обновляется.
  const shell = url.origin === location.origin && SHELL.includes(url.pathname);
  if (shell || FONTS.includes(url.hostname)) {
    event.respondWith(caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(request);
      const fresh = fetch(request).then((response) => {
        if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
        return response;
      });
      if (cached) {
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    }));
  }
});
