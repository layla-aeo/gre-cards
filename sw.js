const VERSION = 'v13';
const CACHE = 'gre-cards-' + VERSION;

// Code: always try the network first so a fix reaches the phone immediately.
const CODE = ['./', './index.html', './manifest.webmanifest',
  './assets/app.css', './assets/app.js', './assets/config.js'];
// Data and icons never change in place; serve them from cache.
const DATA = [
  './assets/icons/icon-180.png', './assets/icons/icon-192.png',
  './assets/icons/icon-512.png', './assets/icons/icon-maskable-512.png',
  './books/index.js', './books/gre.js', './books/ielts.js',
  './books/gre.jing3000.js', './books/gre.jingjing7.js', './books/gre.dengjia.js',
  './books/gre.reading.js', './books/gre.math.js', './books/cet6.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CODE.concat(DATA)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

function isCode(url) {
  return /\/$|\.html$|app\.css$|app\.js$|config\.js$|\.webmanifest$/.test(new URL(url).pathname);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache, refresh in the background.
  if (/fonts\.(googleapis|gstatic)\.com/.test(req.url)) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req).then((res) => {
            if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
            return res;
          }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (isCode(req.url)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
