// Offline support, so the book works in a grocery store with no signal.
// App files and the recipe list: ask the network first (so updates show up straight away),
// fall back to the saved copy after 4 seconds or when offline.
// Photos: use the saved copy if there is one; they never change.
const CACHE = 'recipe-book-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-180.png', './setup.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  const url = new URL(req.url);
  if (url.pathname.includes('/images/')) {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = url.origin + url.pathname;   // ignore ?test and the like
    const network = fetch(req.url, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    const timeout = new Promise(resolve => setTimeout(resolve, 4000));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* offline */ }
    return (await cache.match(key)) || network.catch(() => new Response('Offline', { status: 503 }));
  }));
});
