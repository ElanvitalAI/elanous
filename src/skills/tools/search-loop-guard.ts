import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { getAmbientSessionId } from '../../debug/log.js';

// 캡슐(자식) 범위 — 자식은 부모의 ambient 세션을 물려받으므로 세션 키만으로는 부모·자식이 계수기를
// 같이 쓴다(11-25 감사). dispatchAgent 가 자식 도구 호출을 runInSearchLoopScope('capsule:<taskId>') 안에서 돌린다.
const capsuleScope = new AsyncLocalStorage<string>();

/** fn 안의 Grep/ListDir/Read 가 `scope` 의 계수기를 쓴다(await 넘어 이어진다). */
export function runInSearchLoopScope<T>(scope: string, fn: () => T): T {
  return capsuleScope.run(scope, fn);
}

interface SearchLoopState {
  key: string;
  kind: 'broad-search';
  startedAt: number;
  consecutive: number;
}

/** One loop-guard window per session (ambient async session scope). A process used
 *  to share a single counter, so broad searches from separate sessions poisoned each
 *  other and a fresh session could be blocked on its first lookups. */
const recentBySession = new Map<string, SearchLoopState>();
const NO_SESSION_KEY = '\0no-session';
const MAX_TRACKED_SESSIONS = 256;

const SEARCH_LOOP_WINDOW_MS = 30_000;
const SEARCH_LOOP_BLOCK_THRESHOLD = 4;

function now(): number {
  return Date.now();
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function sessionKey(sessionId?: string | null): string {
  return sessionId ?? capsuleScope.getStore() ?? getAmbientSessionId() ?? NO_SESSION_KEY;
}

function remember(scope: string, state: SearchLoopState): void {
  recentBySession.delete(scope);
  recentBySession.set(scope, state);
  if (recentBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = recentBySession.keys().next().value;
    if (oldest !== undefined) recentBySession.delete(oldest);
  }
}

export function noteBroadSearch(
  parts: readonly string[],
  coarseParts?: readonly string[],
  sessionId?: string | null,
): { blocked: false } | { blocked: true; consecutive: number } {
  const t = now();
  const scope = sessionKey(sessionId);
  const key = hash(coarseParts ?? parts);
  const recent = recentBySession.get(scope);
  if (!recent || recent.kind !== 'broad-search' || (t - recent.startedAt) > SEARCH_LOOP_WINDOW_MS) {
    remember(scope, { key, kind: 'broad-search', startedAt: t, consecutive: 1 });
    return { blocked: false };
  }
  const next: SearchLoopState = recent.key === key
    ? { ...recent, consecutive: recent.consecutive + 1 }
    : { key, kind: 'broad-search', startedAt: recent.startedAt, consecutive: recent.consecutive + 1 };
  remember(scope, next);
  if (next.consecutive >= SEARCH_LOOP_BLOCK_THRESHOLD) {
    return { blocked: true, consecutive: next.consecutive };
  }
  return { blocked: false };
}

export function noteNarrowingAction(sessionId?: string | null): void {
  recentBySession.delete(sessionKey(sessionId));
}

export function resetSearchLoopGuardForTest(): void {
  recentBySession.clear();
}
