/**
 * sw.js — TMS PWA Service Worker
 *
 * 策略（满足「强制加载最新代码 + 离线可用」）：
 *  - 应用代码（index.html / tms-*.js / manifest）→ network-first：
 *    在线时永远先拿服务器最新版本，离线时回退缓存。
 *  - 重资源（models / js/lib / js/core，几乎不变、共 ~12MB）→ cache-first：
 *    首次下载后缓存，后续秒开、可离线。
 *
 * 更新流程：
 *  改动代码后，把下面的 VERSION 加一 → 新 SW 进入 waiting →
 *  页面弹「立即更新」→ 用户点击 → postMessage(SKIP_WAITING) →
 *  skipWaiting + controllerchange → 页面自动 reload，运行最新代码。
 */

const VERSION = 'tms-v27';
const APP_CACHE = `app-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;

// 应用外壳（network-first；预缓存以便离线首屏）
const APP_SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './js/tms-i18n.js',
    './js/tms-db.js',
    './js/tms-tracker.js',
    './js/tms-liveness.js',
    './js/tms-modal.js',
    './js/tms-tabular.js',
    './js/tms-app.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(APP_CACHE).then((c) => c.addAll(APP_SHELL)).catch(() => {})
        // 注意：不在 install 里 skipWaiting，等用户点击「立即更新」再接管，
        // 避免在用户打卡途中突然刷新。
    );
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

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // LM Studio (跨源 localhost:6501) 的请求不拦截，直接走网络
    if (url.origin !== self.location.origin) return;

    const isHeavy =
        url.pathname.includes('/models/') ||
        url.pathname.includes('/js/lib/') ||
        url.pathname.includes('/js/core/');

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
        // 导航请求离线时回退到首页外壳
        if (req.mode === 'navigate') {
            const shell = await cache.match('./index.html');
            if (shell) return shell;
        }
        return Response.error();
    }
}
