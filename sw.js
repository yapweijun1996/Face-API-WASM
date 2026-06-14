/**
 * sw.js — Face Recognition System (root demo) Service Worker
 *
 * Strategy (mirrors examples/TMS/sw.js — "always-latest code + offline-capable"):
 *  - App shell (*.html / js/core/*.js / js/icons.js / manifest) → network-first:
 *    online always serves the freshest server copy; offline falls back to cache.
 *  - Heavy assets (models/ ~12MB, js/lib/ ~4MB — near-immutable) → cache-first:
 *    fetched once on first use, then instant + offline. NOT precached on install
 *    (too large); cache-first grabs them the first time a page requests them.
 *
 * Scope note: this SW is registered from "./sw.js" at the repo root, giving it
 * scope "/". The TMS example registers its own SW from examples/TMS/sw.js with the
 * narrower scope "/examples/TMS/", which wins for pages under it — so the two
 * coexist. Root demo pages load js/icons.js (which registers THIS sw); TMS pages
 * do not load icons.js, so they are unaffected.
 *
 * Update flow: bump VERSION → new SW installs → activate clears old caches →
 * clients.claim() takes control. Pages are reloaded by the browser on next nav.
 */

const VERSION = 'faceapi-v1';
const APP_CACHE = `app-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;

// App shell — network-first; precached so the first offline load has a shell.
const APP_SHELL = [
    './',
    './home.html',
    './index.html',
    './face_register.html',
    './face_verify.html',
    './face_verify_image.html',
    './face_verify_adhoc.html',
    './settings.html',
    './manifest.webmanifest',
    './favicon.svg',
    './js/icons.js',
    './js/core/DeviceProfile.js',
    './js/core/PerfOverlay.js',
    './js/core/utils.js',
    './js/core/FaceStorage.js',
    './js/core/FaceMatcher.js',
    './js/core/FaceRegistrationManager.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(APP_CACHE).then((c) => c.addAll(APP_SHELL)).catch(() => {})
    );
    // New SW activates as soon as it finishes installing — these are stateless
    // demo pages (no in-progress flow to protect, unlike TMS clock-in).
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter((k) => k !== APP_CACHE && k !== STATIC_CACHE).map((k) => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // Only handle same-origin requests; let cross-origin (CDNs, APIs) pass through.
    if (url.origin !== self.location.origin) return;
    // Do not intercept the TMS sub-app — it has its own service worker.
    if (url.pathname.includes('/examples/TMS/')) return;

    const isHeavy =
        url.pathname.includes('/models/') ||
        url.pathname.includes('/js/lib/');

    event.respondWith(isHeavy ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    } catch (e) {
        return hit || Response.error();
    }
}

async function networkFirst(req) {
    const cache = await caches.open(APP_CACHE);
    try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    } catch (e) {
        const hit = await cache.match(req);
        if (hit) return hit;
        // Offline navigation with no cached match → fall back to the home shell.
        if (req.mode === 'navigate') {
            const shell = await cache.match('./home.html');
            if (shell) return shell;
        }
        return Response.error();
    }
}
