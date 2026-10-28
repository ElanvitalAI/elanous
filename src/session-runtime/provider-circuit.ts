/**
 * ⚡ SURVIVAL-PROVIDER-CIRCUIT — 공급자별 회로 차단기 (S2)
 * 정본: 내부 문서 `RFC-tui-never-stop-survival-ladder-2026-10-27` §3 S2 · §6 B
 *
 * 턴 «안»의 공급자 전환(src/llm.ts decideProviderFallback → provider-fallback)은
 * 이미 있지만, 턴이 끝나면 «방금 누가 고장 났나»를 잊는다. 다음 턴은 다시
 * 1순위부터 열어 매번 무응답 대기를 먼저 치른다. 이 모듈은 프로세스 안에
 * 공급자별 회로 상태를 남겨 턴을 넘어 건강을 기억한다.
 *
 * ⭐ 사람 의도가 이긴다(src/oauth/fallback-chain.ts 규율 ②) — 회로는 어디까지나
 * 폴백 판정 보조다. opts.provider 로 명시·고정된 턴은 회로를 보지 않는다.
 *
 * 상태기계:
 *   closed  —(10분 창 안 «전환 사유» 연속 2회 실패)→ open (냉각 5분)
 *   open    —(냉각 경과)→ half-open
 *   half-open —(다음 시도 1회)→ 성공: closed / 실패: open (냉각 2배, 상한 30분)
 *
 * 전환 사유 범주는 `isProviderFallbackEligible` 이 참인 범주
 * (network-transient · rate-limit · overloaded · malformed) ⊕
 * `StreamIdleTimeoutError`(stream-idle-timeout) · `OverloadFailoverError`
 * (overload-failover) 로 한정한다. 그 외 범주(context-window · safety-blocked
 * 등 사용자 탓)는 회로에 기록하지 않는다 — 사용자가 문면을 고치기 전까지
 * 다른 공급자로 도망갈 이유가 없다.
 */
import { debug } from '../debug/log.js';
import { isProviderFallbackEligible, type RetryCategory } from './retry-policy.js';

export type ProviderCircuitState = 'closed' | 'open' | 'half-open';

/** 회로 실패로 세는 «전환 사유» 범주에 추가로 들어가는 두 에러의 범주명. */
export const CIRCUIT_EXTRA_CATEGORIES = ['stream-idle-timeout', 'overload-failover'] as const;

/** 10분 창 — 같은 공급자의 «전환 사유» 실패 2회가 이 창 안에 있어야 열린다. */
export const CIRCUIT_FAILURE_WINDOW_MS = 10 * 60_000;
/** 첫 냉각 5분 — 다시 열릴 때마다 2배. */
export const CIRCUIT_COOLDOWN_BASE_MS = 5 * 60_000;
export const CIRCUIT_COOLDOWN_MAX_MS = 30 * 60_000;
export const CIRCUIT_FAILURE_THRESHOLD = 2;

interface CircuitEntry {
  /** «전환 사유» 실패 시각(에포크 ms) — 10분 창 밖은 다듬는다. */
  eligibleFailures: number[];
  state: 'closed' | 'open';
  cooldownMs: number;
  openedAt: number;
}

/** 프로세스 안 상태 — 턴을 넘어 살아 있어야 하니 모듈 스코프에 둔다. */
const circuits = new Map<string, CircuitEntry>();

/** 실패 범주가 회로 실패(«전환 사유»)로 세는가 — 순수 판정. */
export function isCircuitFailureCategory(category: string): boolean {
  if ((CIRCUIT_EXTRA_CATEGORIES as readonly string[]).includes(category)) return true;
  return isProviderFallbackEligible(
    new Error(`circuit:${category}`),
    category as RetryCategory,
  );
}

function entry(name: string): CircuitEntry {
  let entry = circuits.get(name);
  if (!entry) {
    entry = { eligibleFailures: [], state: 'closed', cooldownMs: CIRCUIT_COOLDOWN_BASE_MS, openedAt: 0 };
    circuits.set(name, entry);
  }
  return entry;
}

function logState(
  event: 'circuit-open' | 'circuit-half-open' | 'circuit-closed',
  provider: string,
  failures: number,
  cooldownMs: number,
): void {
  debug.log('tui.survival', event, { provider, failures, cooldownMs });
}

/** 회로 차단기에 실패를 기록한다. «전환 사유» 범주만 세며, half-open 시험
 * 실패는 냉각을 2배(상한 30분)로 갈아 open 을 다시 연다. */
export function recordProviderFailure(name: string, category: string, now: number): void {
  if (!isCircuitFailureCategory(category)) return;
  const e = entry(name);
  if (e.state === 'open' && now >= e.openedAt + e.cooldownMs) {
    // half-open 시험 실패 — 다시 열리고 냉각은 2배(상한 30분).
    e.cooldownMs = Math.min(e.cooldownMs * 2, CIRCUIT_COOLDOWN_MAX_MS);
    e.openedAt = now;
    e.eligibleFailures.push(now);
    logState('circuit-open', name, e.eligibleFailures.length, e.cooldownMs);
    return;
  }
  e.eligibleFailures = e.eligibleFailures.filter((t) => now - t <= CIRCUIT_FAILURE_WINDOW_MS);
  e.eligibleFailures.push(now);
  if (e.state === 'closed' && e.eligibleFailures.length >= CIRCUIT_FAILURE_THRESHOLD) {
    e.state = 'open';
    e.openedAt = now;
    e.cooldownMs = CIRCUIT_COOLDOWN_BASE_MS;
    logState('circuit-open', name, e.eligibleFailures.length, e.cooldownMs);
  }
}

/** 성공 — half-open 이면 closed 로 회복하고, closed 의 실패 이력 창을 정리한다. */
export function recordProviderSuccess(name: string, now: number): void {
  const e = circuits.get(name);
  if (!e) return;
  if (e.state === 'open' && now >= e.openedAt + e.cooldownMs) {
    e.state = 'closed';
    e.cooldownMs = CIRCUIT_COOLDOWN_BASE_MS;
    e.eligibleFailures = [];
    logState('circuit-closed', name, 0, e.cooldownMs);
    return;
  }
  if (e.eligibleFailures.length > 0) e.eligibleFailures = [];
}

/** 현재 회로 상태 — 주입 시계로만 판정한다. */
export function circuitState(name: string, now: number): ProviderCircuitState {
  const e = circuits.get(name);
  if (!e || e.state === 'closed') return 'closed';
  return now < e.openedAt + e.cooldownMs ? 'open' : 'half-open';
}

/** 턴의 첫 공급자 후보 — 체인 순서 그대로 첫 `closed`, 없으면 첫 `half-open`,
 * 모두 `open` 이면 `undefined`(호출부가 원래 1순위로 열며 `circuit-all-open` 을 남긴다). */
export function pickInitialProvider(
  chainNames: readonly string[],
  now: number,
): string | undefined {
  let firstHalfOpen: string | undefined;
  for (const name of chainNames) {
    const state = circuitState(name, now);
    if (state === 'closed') return name;
    if (state === 'half-open' && firstHalfOpen === undefined) firstHalfOpen = name;
  }
  return firstHalfOpen;
}

/** 테스트 전용 — 프로세스 안 회로 상태를 리셋한다. */
export function resetProviderCircuitForTest(): void {
  circuits.clear();
}