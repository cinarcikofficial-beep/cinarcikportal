/* Marmara'nın İncisi — Service Worker
   Strateji: sayfalar network-first (çevrimdışıysa önbellek / offline sayfası),
   statik dosyalar stale-while-revalidate. Admin, API ve auth asla önbelleğe alınmaz. */
const VERSION = 'v1';
const STATIC_CACHE = 'cinarcik-static-' + VERSION;
const PAGE_CACHE = 'cinarcik-pages-' + VERSION;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/img/logo-circle.webp'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isBypass(url) {
  return /^\/(admin|api|auth|captcha|logout|login)/.test(url.pathname) || url.pathname === '/sw.js';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isBypass(url)) return;

  // Sayfalar: önce ağ, olmazsa önbellek, o da yoksa offline sayfası
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(PAGE_CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match(OFFLINE_URL)))
    );
    return;
  }

  // Statik: CSS/JS/görsel/font
  if (/\.(css|js|png|jpe?g|webp|svg|gif|ico|woff2?)$/i.test(url.pathname) || url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      caches.open(STATIC_CACHE).then((cache) => cache.match(req).then((cached) => {
        const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
        return cached || net;
      }))
    );
  }
});

