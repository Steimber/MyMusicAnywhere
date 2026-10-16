const STATIC_CACHE = 'mymusic-cache-v2';
const AUDIO_CACHE = 'mymusic-offline-audio';

const STATIC_ASSETS = [
  '/',
  '/globals.css',
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== STATIC_CACHE && k !== AUDIO_CACHE) return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // If streaming audio, try network first, fallback to offline audio cache
  if (url.pathname === '/api/stream') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.open(AUDIO_CACHE).then((cache) => {
          return cache.match(event.request.url).then((response) => {
            return response || new Response('Audio no disponible offline', { status: 503 });
          });
        });
      })
    );
    return;
  }

  // Network-only for live API search/download creation
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Stale-while-revalidate for Next.js assets and shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
