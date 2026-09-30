// Classic service-worker script, loaded by sw.js via importScripts.
// Dependencies and cache names are supplied by the fetch handler.

async function cacheFirst(request, caches, doFetch, runtimeCache) {
  const cache = await caches.open(runtimeCache);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await doFetch(request);
    if (fresh.ok) {
      // Don't cache opaque or partial responses.
      cache.put(request, fresh.clone()).catch(() => { /* swallow */ });
    }
    return fresh;
  } catch (e) {
    // Cache miss + offline = give the user something. The runtime
    // cache may have a stale fingerprinted asset under a slightly
    // different query — best effort.
    return new Response('', { status: 504, statusText: 'offline + uncached' });
  }
}

async function networkFirstWithOfflineFallback(request, caches, doFetch, runtimeCache, precacheName) {
  try {
    const fresh = await doFetch(request);
    if (fresh.ok) {
      const cache = await caches.open(runtimeCache);
      cache.put(request, fresh.clone()).catch(() => { /* swallow */ });
    }
    return fresh;
  } catch {
    const cache = await caches.open(runtimeCache);
    const cached = await cache.match(request);
    if (cached) return cached;
    // Absolute last resort — the precached offline shell.
    const precache = await caches.open(precacheName);
    const offline = await precache.match('/app/offline.html');
    if (offline) return offline;
    return new Response('Offline · daemon unreachable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
