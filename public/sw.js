/* Vijaya Stores service worker. It keeps ONLY the look of the app (hashed build files and icons) and a plain "you are offline"
   page. It never keeps a page, an API answer, a file or any business data: stock numbers always come fresh from the server. */
const VERSION = 'v1';
const KEEP = `vijaya-static-${VERSION}`;
const OFFLINE = '/offline.html';

self.addEventListener('install', (e) => { e.waitUntil(caches.open(KEEP).then((c) => c.add(OFFLINE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('vijaya-') && k !== KEEP).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') { e.respondWith(fetch(req).catch(() => caches.match(OFFLINE))); return; }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.open(KEEP).then(async (c) => { const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }));
  }
});
