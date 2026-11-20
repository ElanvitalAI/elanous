// PWA service worker registration helper — Phase 1 (foundation).
//
// Wraps the standard `navigator.serviceWorker.register()` lifecycle
// so the layout can call a single function and not worry about:
//   - SSR safety (`navigator` undefined in Next.js server rendering)
//   - Insecure-context (HTTP over LAN IP without TLS — iPad Safari
//     rejects SW registration silently; we surface that as an
//     `unsupported` outcome)
//   - basePath ('/app' in this PWA's next.config.ts) — ensure the
//     SW path is correct relative to the daemon static-serve mount
//   - waiting/installing detection so future phases can prompt the
//     user before swapping a new SW in
//
// What this DOESN'T do (yet):
//   - Auto-update prompt UI (Phase 4 / polish)
//   - Push subscription (Phase 3)
//   - Cache invalidation hooks (Phase 4)

import { isBareWebChatOrigin } from './daemon-config';
import { debugLog } from './debug';

/** Path the daemon static-serve mounts the SW at. PWA basePath is
 *  `/app`, so `public/sw.js` is reachable at `/app/sw.js`. */
const SW_PATH = '/app/sw.js';

/** Scope the SW controls. `/app/` matches every PWA route (term,
 *  chat, settings, etc.) without leaking to non-PWA paths the
 *  daemon also serves (`/v1/*`, `/share/*`, etc.). */
const SW_SCOPE = '/app/';

export type RegisterSwOutcome =
  | { status: 'registered'; scope: string; updateAvailable: boolean }
  | { status: 'updated'; scope: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; reason: string };

let cachedRegistration: ServiceWorkerRegistration | null = null;

/** Register the PWA service worker idempotently. Safe to call from
 *  every layout mount — the browser dedupes by (scope, scriptURL).
 *  Returns the outcome so callers can drive UI (Phase 1: silent;
 *  Phase 4: "update available, reload" toast). */
export async function registerServiceWorker(): Promise<RegisterSwOutcome> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { status: 'unsupported', reason: 'no window/navigator (SSR)' };
  }
  if (!('serviceWorker' in navigator)) {
    return { status: 'unsupported', reason: 'navigator.serviceWorker absent' };
  }
  // bare 핸들 호스트: /app/sw.js 는 릴레이의 정적 허용 목록에 없어 404 — 서비스워커는 등록하지 않는다
  // (오프라인 캐시 이득 없음 · 매 진입 콘솔 404 제거). 목록에 넣는 대신 등록을 건너뛴다(범위·쿠키 없는 방문자 안전성 확인 전).
  if (isBareWebChatOrigin()) {
    return { status: 'unsupported', reason: 'bare webchat origin does not serve the service worker' };
  }
  // iOS Safari rejects SW registration in insecure contexts (HTTP
  // over LAN IP). The browser silently fails — we check explicitly
  // so the caller can surface the cause when debugging on iPad.
  if (!window.isSecureContext) {
    return { status: 'unsupported', reason: 'page not in a secure context (HTTPS or localhost required)' };
  }

  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE });
    cachedRegistration = reg;
    debugLog('pwa.sw.registered', { scope: reg.scope });

    // Detect when an updated SW is waiting. Phase 1 doesn't act on
    // this beyond logging — Phase 4 will surface a toast prompt.
    if (reg.waiting) {
      debugLog('pwa.sw.update-waiting');
      return { status: 'registered', scope: reg.scope, updateAvailable: true };
    }

    // Listen for future updates (browser checks once per ~24h or
    // when the script byte-changes). We log only; Phase 4 acts.
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        debugLog('pwa.sw.statechange', { state: installing.state });
      });
    });

    return { status: 'registered', scope: reg.scope, updateAvailable: false };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    debugLog('pwa.sw.register-failed', { reason });
    return { status: 'error', reason };
  }
}

/** Ask the active waiting SW to skip-waiting and become the
 *  controller. Used by future "Update now" prompts (Phase 4). */
export function postSkipWaiting(): void {
  const reg = cachedRegistration;
  if (!reg || !reg.waiting) return;
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  debugLog('pwa.sw.skip-waiting-sent');
}

/** Test seam — reset cached registration between tests so module
 *  state doesn't bleed across describe() blocks. Production callers
 *  never invoke this. */
export function _resetRegisterSwCache(): void {
  cachedRegistration = null;
}
