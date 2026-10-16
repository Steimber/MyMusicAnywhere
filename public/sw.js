const STATIC_CACHE = 'mymusic-shell-v7';
const AUDIO_CACHE = 'my-music-offline-audio-v1';

const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/brand/logo.svg',
  '/brand/logo-dark.svg',
  '/brand/logo.svg?v=3',
  '/brand/logo-dark.svg?v=3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      for (const url of PRECACHE_URLS) {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res.ok) await cache.put(url, res);
        } catch {}
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== STATIC_CACHE && k !== AUDIO_CACHE) {
            return caches.delete(k);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // 1. Audio streams: serve from offline AUDIO_CACHE first (instant & offline-proof), fallback to network
  if (url.pathname === '/api/stream') {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const cached = await cache.match(url.pathname + url.search) || await cache.match(event.request.url);
        if (cached) return cached;
        try {
          return await fetch(event.request);
        } catch {
          return new Response('Offline audio not found in cache', { status: 503 });
        }
      })
    );
    return;
  }

  // 2. Live API endpoints: pass through to network
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 3. HTML Navigation requests (opening or reloading the PWA):
  // Try network with a fast timeout so online updates appear, but immediately fall back to cached '/' shell offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.ok) {
            cache.put('/', networkResponse.clone());
            return networkResponse;
          }
        } catch {}
        const cachedShell = (await cache.match(event.request)) || (await cache.match('/'));
        if (cachedShell) return cachedShell;
        return new Response('Offline', { status: 503 });
      })()
    );
    return;
  }

  // 4. Static assets (/_next/static/*, icons, manifest, artwork): Cache-first with background refresh
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok && (url.origin === self.location.origin || url.hostname.endsWith('.mzstatic.com'))) {
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
