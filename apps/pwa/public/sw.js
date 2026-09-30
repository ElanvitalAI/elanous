// elanous PWA service worker — Phase 1 (foundation).
//
// What this file does today:
//   - install:  bumps to activate immediately (no precache yet)
//   - activate: claims clients + drops any caches from older SW
//               versions (defensive — Phase 4 introduces real caches)
//   - fetch:    pure passthrough — never intercepts. Network behaviour
//               must be byte-for-byte identical to no-SW for callers
//               that fall back to runtime detection.
//   - message:  handles `{type:'SKIP_WAITING'}` so the in-page
//               registration helper can prompt-then-skip instead of
//               waiting for the user to close every tab.
//
// What it deliberately does NOT do yet:
//   - cache /app routes (Phase 4 — Offline cache)
//   - intercept POST /app/share/ for Share Target Level 2 (Phase 2)
//   - push subscription / showNotification (Phase 3 — Web Push)
//
// The point of Phase 1 is to land the SW lifecycle WITHOUT touching
// runtime fetch behaviour. Once this is on main + dogfooded for a
// couple of days (any unexpected SW-induced regressions surface),
// subsequent phases layer in functionality with a clear baseline to
// roll back to.
//
// Versioning: bumping CACHE_VERSION on each future cache-touching
// change forces `activate` to drop the old cache. Phase 1 has no
// cache, but the constant is in place so Phase 4 doesn't need a
// breaking schema change.

importScripts('sw-strategies.js');

const CACHE_VERSION = 'v4-phase-4-offline-cache';
const CACHE_PREFIX = 'elanous-pwa-';
// Phase 2 — dedicated cache for incoming share-target POST payloads.
// Each share gets a unique key (`shared-${id}`) under this cache so
// multiple in-flight shares don't clobber each other. The Share page
// reads + drains entries during its onMount.
const SHARE_CACHE = `${CACHE_PREFIX}share-target-${CACHE_VERSION}`;
// Phase 4 — runtime + precache. The runtime cache holds /_next/static/*
// and similar fingerprinted assets at first hit; offline fallback
// shells live in the precache. Both bump on CACHE_VERSION change so
// breaking schema changes auto-invalidate.
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const PRECACHE = `${CACHE_PREFIX}precache-${CACHE_VERSION}`;
// PRECACHE_URLS — the absolute minimum that lets the user see *any*
// elanous UI when the daemon is unreachable. We don't precache a full
// page (Next.js App Router pages are render-time, not static), but
// we do precache the offline fallback page + manifest + critical
// fonts so the empty-state has a real face.
const PRECACHE_URLS = [
  '/app/offline.html',
  '/app/manifest.webmanifest',
  '/app/icons/elanous-192.png',
  '/app/icons/elanous-512.png',
];

self.addEventListener('install', (event) => {
  // Phase 4 — precache the offline fallback shell + manifest. We do
  // this in the install handler so the moment activate fires, the
  // shell is ready to serve. Failures are non-fatal: if a precache
  // entry 404s (e.g. offline.html not yet deployed) the SW still
  // installs and runtime cache fills in over time.
  event.waitUntil((async () => {
    try {
      const cache = await self.caches.open(PRECACHE);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try { await cache.add(url); } catch { /* tolerate */ }
        }),
      );
    } catch { /* tolerate */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older elanous SW versions. Defensive — Phase 1
    // doesn't create any, but if we land Phase 1 + 4 in quick
    // succession the cleanup runs once and never gets in the way.
    const keys = await self.caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && !k.endsWith(CACHE_VERSION))
        .map((k) => self.caches.delete(k)),
    );
    // Take control of pages already open before this SW activated so
    // the registration helper sees `controller` immediately instead
    // of after a manual reload.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Phase 2 — Share Target Level 2 receiver.
  if (req.method === 'POST' && url.pathname === '/app/share/') {
    event.respondWith(handleSharePost(req));
    return;
  }

  // Phase 4 — caching strategies. Three buckets:
  //
  // 1. Static fingerprinted assets (/_next/static/* + /app/fonts/*):
  //    Cache First with runtime backfill. These never change byte-for-
  //    byte without a URL change (Next builds emit hashed filenames),
  //    so a cache hit is always correct + saves a network round-trip.
  //
  // 2. PWA shell (anything under /app/ that's a navigation request):
  //    Network First with offline fallback. Live data wins when the
  //    daemon is reachable; when it's not, we serve /app/offline.html
  //    so the user sees a real face instead of a Chrome dino.
  //
  // 3. Everything else (API calls /v1/*, daemon WebSocket, share-target
  //    POST already handled above): pure passthrough — caching live
  //    data would be actively harmful.
  if (req.method !== 'GET') return;

  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/app/_next/static/')
      || url.pathname.startsWith('/app/fonts/')) {
    event.respondWith(cacheFirst(req, self.caches, fetch, RUNTIME_CACHE));
    return;
  }
  if (req.mode === 'navigate'
      || (req.headers.get('accept') || '').includes('text/html')) {
    if (url.pathname.startsWith('/app/')) {
      event.respondWith(networkFirstWithOfflineFallback(req, self.caches, fetch, RUNTIME_CACHE, PRECACHE));
      return;
    }
  }
  // Default: passthrough.
});

async function handleSharePost(request) {
  try {
    const formData = await request.formData();
    const title = String(formData.get('title') ?? '');
    const text = String(formData.get('text') ?? '');
    const sharedUrl = String(formData.get('url') ?? '');
    const files = formData.getAll('files').filter((f) => f instanceof File);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const cache = await self.caches.open(SHARE_CACHE);

    // Store each File as a Response in the cache. Cache Storage holds
    // arbitrary Response objects (binary OK) and survives SW restart,
    // which is exactly what we want — the redirected page can pull
    // them back at its own pace.
    const fileMetas = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const filename = f.name || `share-${id}-${i}`;
      const cacheUrl = `/__share/${id}/${i}/${encodeURIComponent(filename)}`;
      const headers = new Headers({
        'content-type': f.type || 'application/octet-stream',
      });
      await cache.put(cacheUrl, new Response(f, { headers }));
      fileMetas.push({
        index: i,
        cacheUrl,
        filename,
        type: f.type || 'application/octet-stream',
        size: f.size,
      });
    }

    // Manifest entry for the page to discover everything in one read.
    const manifest = {
      id,
      ts: Date.now(),
      title,
      text,
      url: sharedUrl,
      files: fileMetas,
    };
    await cache.put(
      `/__share/${id}/manifest.json`,
      new Response(JSON.stringify(manifest), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    // Redirect the user to the Share page. We pass the shared id in
    // the query so the page knows which manifest to read. The page
    // then promotes files into the daemon's `/v1/attachments` and
    // hands off to /chat.
    return Response.redirect(`/app/share/?shared=${id}`, 303);
  } catch (e) {
    // If anything blows up, surface a minimal HTML page so the user
    // sees a real error instead of a blank tab. The fail-safe is one
    // of the only places where the SW responds with custom content.
    const message = e instanceof Error ? e.message : String(e);
    return new Response(
      `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:24px"><h1>📥 공유 처리 실패</h1><p>${message}</p><p><a href="/app/chat">/chat 으로 이동</a></p></body>`,
      { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && typeof data === 'object' && data.type === 'SKIP_WAITING') {
    // Page-side helper requests an immediate swap. Useful when an
    // updated SW is waiting and the user has confirmed they want
    // the new version now.
    self.skipWaiting();
  }
});

// Phase 3 — Web Push receiver.
// daemon → push service → SW. Payload is JSON the sender wraps
// with `{title, body?, url?, tag?, data?}`. Browser shows a system
// notification + remembers `data` for the click handler.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'elanous', body: event.data.text() };
  }
  const title = payload.title || 'elanous';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'elanous-default',
    data: payload.data || {},
    // iOS Safari ignores most of these; they're for Android/desktop.
    badge: '/app/icon-badge.png',
    icon: '/app/icon-192.png',
  };
  if (payload.url) {
    options.data = { ...options.data, url: payload.url };
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tap → focus an existing PWA tab (or open a new one) at
// `data.url` if provided, else fall back to `/app/`.
//
// BACKLOG #17 (2026-05-06) — session-aware focus preference:
//   1. Prefer a client whose URL already contains `session=<id>` query
//      matching `data.sessionId` (the user clicked an "agent done"
//      notification → focus the tab already on that session)
//   2. Fall back to any client on the PWA scope (`/app/`) — better
//      than a random tab that may be on chat.openai.com etc.
//   3. Else open a new window.
//
// This avoids the previous bug where the first-found client was
// focused regardless of URL, then navigated away — disrupting the
// user's other PWA tab content.
// R3 (BACKLOG #5 · 2026-05-09) — `event.action` branch.
//   - When the user taps an inline action button (sent via the
//     payload's `actions` array · see src/web-push/notify-turn-end.ts),
//     `event.action` is the action id (e.g. 'intent-0'..'intent-5').
//     We POST to `/v1/notification-action` with the session id +
//     action id; the server resolves it back to the canonical
//     label and records as an intent-prediction feedback tap
//     (recency boost). No focus/navigate — fire-and-forget so the
//     user can keep doing whatever they were doing.
//   - When `event.action === ''` (body tap), behave as before:
//     focus an existing tab matching the session, else open a new
//     window.
//
// The POST URL is derived from the page origin via
// `self.registration.scope` — works for tailnet (https://mbp.ts.net:31415/app/)
// and localhost equally without baking the daemon URL into the SW.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data && typeof event.notification.data === 'object')
    ? event.notification.data
    : {};
  const target = (typeof data.url === 'string' && data.url) || '/app/';
  const targetSessionId = (typeof data.sessionId === 'string' && data.sessionId) || null;
  const actionId = typeof event.action === 'string' && event.action.length > 0
    ? event.action
    : null;

  // Action button click — fire-and-forget POST, no navigate.
  if (actionId !== null) {
    event.waitUntil((async () => {
      try {
        const scope = self.registration.scope || '/app/';
        // scope ends with '/' (e.g. 'https://host/app/'); resolve the
        // endpoint at the daemon root (one level up from /app/).
        const endpoint = new URL('../v1/notification-action', scope).toString();
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: targetSessionId,
            action: actionId,
          }),
          // Body tap may want to grab auth from cookies; here we
          // intentionally use credentials:'omit' since the daemon
          // accepts unauth POST on this endpoint (same trust model
          // as the existing intent-prediction feedback POST that
          // the in-page IntentPanel calls).
          credentials: 'omit',
        });
      } catch {
        // Network failure or daemon offline — silent. The user
        // already got the OS-level notification; failing the POST
        // shouldn't surface a banner since the SW has no UI surface
        // when the page is closed anyway.
      }
      // β (BACKLOG-pwa-mobile-readiness §6.1 #5 metric · 2026-05-12) —
      // emit userIntentLogger event alongside the action POST. SW
      // can't import the typed PWA logger module, so we fetch the
      // canonical /v1/user-intents/emit endpoint directly with the
      // same shape MemoIntakePreview's emit produces. Same scope
      // resolution + credentials:'omit' as the action POST above.
      try {
        const scope = self.registration.scope || '/app/';
        const emitEndpoint = new URL('../v1/user-intents/emit', scope).toString();
        await fetch(emitEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            surface: 'pwa',
            intent: {
              layer: 'selection',
              kind: 'pwa.selection.push_action_tap',
              target: { kind: 'push_action', id: actionId },
              value: { actionId, hadSession: targetSessionId !== null },
            },
            ...(targetSessionId
              ? { context: { active_showroom_session_id: targetSessionId } }
              : {}),
          }),
          credentials: 'omit',
        });
      } catch {
        // Silent — emit is best-effort telemetry.
      }
    })());
    return;
  }

  // Body tap — original focus/navigate flow.
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Strategy: prefer session match → PWA scope match → first → openWindow.
    let preferred = null;
    let pwaScope = null;
    if (allClients.length > 0) {
      for (const client of allClients) {
        const clientUrl = client.url || '';
        if (targetSessionId
          && clientUrl.includes(`session=${encodeURIComponent(targetSessionId)}`)) {
          preferred = client;
          break;
        }
        if (clientUrl.includes('/app/') && !pwaScope) {
          pwaScope = client;
        }
      }
    }
    const chosen = preferred || pwaScope || allClients[0] || null;

    if (chosen && 'focus' in chosen) {
      try {
        await chosen.focus();
        // Only navigate when the chosen client isn't already on a
        // matching URL — otherwise focusing alone is enough and
        // calling navigate() would reload state pointlessly.
        const needsNav = !chosen.url || (
          targetSessionId
            ? !chosen.url.includes(`session=${encodeURIComponent(targetSessionId)}`)
            : !chosen.url.endsWith(target)
        );
        if (needsNav && 'navigate' in chosen && typeof chosen.navigate === 'function') {
          await chosen.navigate(target);
        }
        return;
      } catch { /* fall through to openWindow */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});
