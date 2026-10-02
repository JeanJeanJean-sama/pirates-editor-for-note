/* sw.js — オフラインでも開けるようにする（画面のファイルだけを保存。記録データは扱わない） */
const CACHE = 'pen-web-0.7.0';
const FILES = ['./', 'index.html', 'install.html', 'privacy.html', 'manifest.webmanifest',
  'app/env.js', 'app/db.js', 'app/data.js', 'app/store.js', 'app/threads.js', 'app/backup.js', 'app/web.js', 'app/dashboard.js', 'app/periods.js', 'app/views.js', 'app/cardtrend.js', 'app/share.js', 'app/search.js', 'app/calendar.js', 'app/missions.js', 'app/features.js', 'app/account.js', 'app/beta.js', 'app/colors.js', 'app/settings.js', 'app/guide.js', 'app/bodies.js', 'app/perks.js', 'app/theme-boot.js', 'app/webapp.js', 'app/dashboard.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'icons/apple-touch-icon.png', 'icons/pen-logo.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// 通信できるときは最新を取得し、できないときは保存しておいたものを表示
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
