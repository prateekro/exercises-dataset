/*
 * Vizion service worker — offline support for the smart-glasses coach.
 *
 * Strategy per request type:
 *   • navigations / HTML  → network-first, cache fallback (fresh code for contributors,
 *                           a working app in a basement gym)
 *   • data/*.json         → stale-while-revalidate (instant start, refreshed in background)
 *   • images/ + videos/   → cache-first with a bounded runtime cache (content-addressed
 *                           filenames, so entries never go stale)
 *   • everything else     → network-first, cache fallback
 *
 * Cross-origin requests (e.g. the TensorFlow.js model on jsDelivr) are left entirely
 * to the browser: opaque responses cannot be validated and would bloat storage.
 */
'use strict';

const VERSION = 'v1';
const SHELL_CACHE = `vizion-shell-${VERSION}`;
const DATA_CACHE = `vizion-data-${VERSION}`;
const MEDIA_CACHE = `vizion-media-${VERSION}`;
const MEDIA_LIMIT = 400; // ~400 thumbnails/GIFs kept locally, oldest evicted first

const SHELL_ASSETS = ['./glasses.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, DATA_CACHE, MEDIA_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => (keep.has(key) ? null : caches.delete(key)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Keep the media cache bounded so a long session cannot fill up device storage. */
async function trimCache(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
    if (limit) trimCache(cacheName, limit);
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request) || await cache.match('./glasses.html');
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let the browser handle CDN traffic

  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }
  if (/\/(images|videos)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE, MEDIA_LIMIT));
    return;
  }
  if (url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }
  event.respondWith(networkFirst(request, SHELL_CACHE));
});
