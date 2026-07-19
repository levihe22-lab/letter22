// Service Worker v7 — caches application shell only.
// Chat data is served by direct-import.js or vault.js from IndexedDB.
const CACHE = 'wcv-shell-v7';
const SHELL = [
    '/', '/index.html',
    '/app.js', '/app.js?v=5',
    '/direct-import.js', '/direct-import.js?v=1',
    '/vault.js', '/vault.js?v=3',
    '/style.css', '/style.css?v=7',
    '/manifest.json',
    '/icon-192.png', '/icon-512.png',
    // JSZip CDN (cached for offline use)
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await Promise.all(SHELL.map(async (path) => {
            try { await cache.add(path); }
            catch (error) { console.warn('Shell cache miss:', path, error); }
        }));
    })());
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never cache data paths — they come from IndexedDB via direct-import.js or vault.js
    if (url.pathname.startsWith('/data/')) return;
    // Never cache avatar paths — they also come from IndexedDB
    if (url.pathname === '/avatar_me.jpg' || url.pathname === '/avatar_even.jpg') return;

    // For same-origin and CDN requests, try cache first, then network
    if (url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net') {
        if (event.request.mode === 'navigate') {
            event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
            return;
        }
        event.respondWith(caches.match(event.request).then((cached) => {
            return cached || fetch(event.request).then((response) => {
                if (!response.ok || event.request.method !== 'GET') return response;
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(event.request, copy));
                return response;
            });
        }));
    }
});
