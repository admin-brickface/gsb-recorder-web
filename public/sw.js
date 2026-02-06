const CACHE_NAME = 'gsb-recorder-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/main.js',
    '/silence.mp3',
    '/manifest.json',
    '/icon.svg',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Skip non-GET and API requests
    if (event.request.method !== 'GET') return;
    if (event.request.url.includes('googleapis.com')) return;
    if (event.request.url.includes('accounts.google.com')) return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            return cached || fetch(event.request).then((response) => {
                // Cache successful responses
                if (response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => caches.match('/index.html'))
    );
});
