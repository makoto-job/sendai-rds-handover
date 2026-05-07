/* ========================================
   現場引継ぎ — Service Worker
   App Shell: pre-cache, Runtime: stale-while-revalidate
   ======================================== */

const CACHE_NAME = 'vha-cache-v6';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './auth.js',
  './voice.js',
  './sendai-data.js',
  './firebase-sync.js',
  './firebase-config.local.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// Firebase SDK CDN は別途ランタイムキャッシュ
const RUNTIME_CACHE_PATTERNS = [
  /^https:\/\/www\.gstatic\.com\/firebasejs\//
];

// Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for app shell, stale-while-revalidate for runtime
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;
  const isFirebaseSDK = RUNTIME_CACHE_PATTERNS.some(p => p.test(url));

  // Firestore リアルタイム同期 (firestore.googleapis.com 等) はキャッシュしない
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebaseio.com') ||
      url.includes('identitytoolkit.googleapis.com')) {
    return; // ブラウザのデフォルトに任せる
  }

  if (isFirebaseSDK) {
    // Stale-while-revalidate: キャッシュ即返、バックグラウンドで更新
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req).then(cached => {
          const fetched = fetch(req).then(res => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // App Shell: cache-first
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      // 同一オリジンの新規リソースもランタイムキャッシュへ
      if (res.ok && req.url.startsWith(self.location.origin)) {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
      }
      return res;
    }).catch(() => cached))
  );
});
