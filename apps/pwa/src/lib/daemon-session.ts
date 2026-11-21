/**
 * sessionId management — localStorage default + URL ?session= override.
 * Mirrors PR #1555 sticky REPL semantics: stable per browser, with explicit
 * fork (:fork meta-command) producing a fresh id.
 */

const STORAGE_KEY = 'elanous.daemon.sessionId';

// 출처: #39459 JUD HOLD #123572(OP #123577) · OP 결정 #123699 — 폴백 난수 원천. 이 id 는
// seat-ask 응답 조회·ack 분리 키(x-seat-ask-client) 겸 회원 session owner 로도 쓰여 추측
// 가능하면 안 된다. 예전 Math.random 8자는 추측 가능이라 폐기 — crypto.getRandomValues 는
// 비보안(insecure) 원점에도 있으므로 64bit(8바이트 hex 16자)를 쓴다(#123699) — 기존 정책
// 정규식 {1,16}(회원 sessionId · SEAT_ASK_CLIENT_ID)을 그대로 통과한다(서버 변경 0).
// Math.random 은 0번(#123699): crypto 부재(SSR 모양)면 throw — 상위 렌더는
// ChatErrorBoundary(#39459)가 잡는다.
function fallbackRandomHex64(): string {
  const bytes = new Uint8Array(8); // 64bit → hex 16자(OP #123699)
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateSessionId(): string {
  // crypto.randomUUID exists in modern browsers + Node 20+.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback(insecure 원점 등): s-<ts36>-<hex64> — 64bit crypto 난수(HOLD #123572 · OP #123699).
  return `s-${Date.now().toString(36)}-${fallbackRandomHex64()}`;
}

export function loadSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  // URL override wins (e.g. ?session=abc-123 in href).
  const fromUrl = new URLSearchParams(window.location.search).get('session');
  if (fromUrl) {
    localStorage.setItem(STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(STORAGE_KEY);
}

export function ensureSessionId(): string {
  const existing = loadSessionId();
  if (existing) return existing;
  const fresh = generateSessionId();
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, fresh);
  }
  return fresh;
}

export function forkSession(): string {
  const fresh = generateSessionId();
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, fresh);
  }
  return fresh;
}

export function clearSession(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
}
