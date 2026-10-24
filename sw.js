// Narada service worker.
//  • App shell is precached so the app opens offline.
//  • HTML: network-first (so deploys show up), falling back to the cache.
//  • Everything else (incl. avatar/clip .glb files): stale-while-revalidate,
//    so a clip you've viewed once keeps working offline and refreshes in the background.
// Bump VERSION when you change the shell file list.
const VERSION = 'narada-v2';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/nocturne-styles.css',
  'css/app.css',
  'fonts/inter-latin-wght-normal.woff2',
  'vendor/phosphor/style.css',
  'vendor/phosphor/Phosphor.woff2',
  'vendor/three.bundle.js',
  'js/app.js',
  'js/avatar.js',
  'js/clips.js',
  'js/gloss.js',
  'js/recognizer.js',
  'js/store.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/logo-mark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  // HEAD probes (used to detect which clip files exist): answer from cache if we can.
  if (req.method === 'HEAD') {
    event.respondWith(caches.match(req, { ignoreMethod: true }).then((hit) => hit || fetch(req)));
    return;
  }
  if (req.method !== 'GET') return;

  // 3D files: network first (an old cached copy must never be mixed with a new one); cache only as an offline fallback.
  if (url.pathname.endsWith('.glb')) {
    event.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          const type = res.headers.get('content-type') || '';
          // Don't cache 404s or SPA-fallback HTML answering for a missing file.
          if (res.ok && !(type.includes('text/html') && !req.url.endsWith('.html'))) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit || Response.error());
      if (hit) { event.waitUntil(network); return hit; }
      return network;
    })
  );
});
