// public/sw.js — Sonnencafe Wien Service Worker
// Cache-first strategy for static data files so repeat visits are instant.

const CACHE = "sonnencafe-wien-v1";

const PRECACHE = [
  "/buildings-cache.json",
  "/green-areas-cache.json",
  "/sun-emoji.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isCacheable = PRECACHE.some((p) => url.pathname === p);
  if (isCacheable) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) => cached ?? fetch(event.request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          return res;
        })
      )
    );
  }
});
