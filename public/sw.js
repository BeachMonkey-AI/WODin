/* App service worker — stale-while-revalidate for the shell, network-first for everything else.
 * CACHE name is bumped by scripts/build.mjs from a content hash on every build.
 */
const CACHE = 'app-dev';
// Relative to this script's own location, so this works unmodified whether it's
// deployed at / (prod) or /preview/pr-<N>/ — self.location gives that automatically.
const SHELL = ['.', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png']
  .map(p => new URL(p, self.location.href).pathname);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  if (SHELL.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  event.respondWith(networkFirst(request));
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached ?? (await fetchPromise) ?? new Response('Offline', { status: 503 });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? new Response('Offline', { status: 503 });
  }
}
