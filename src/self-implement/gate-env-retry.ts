// ── GATE-ENV-RETRY (0.2.20 P1) — 환경 결손 gate 실패는 «게이트만» 다시 돈다 ─────────────
//
// S: 하니스 후반 gate 가 «환경 결손»(시험 결과 미수신 · git index.lock 경합 · tsc 힙 OOM ·
//    「측정 불가」 · 네트워크/레지스트리 타임아웃)을 자식 실패와 같은 칸으로 받아,
//    재작업 없이 `abandoned` 로 런을 끝냈다.
// C: 📏 10-06 — TASK-AGENT 런 PR #24438 «test-result-unavailable · escalating without rework» ·
//    NESTEDGUARD3 baseline index.lock 경합 · tsc 힙 OOM «could not measure».
//    구현은 멀쩡한데 «잰 쪽»이 넘어졌고, 그 구현이 버려진 칸으로 셌다.
// Q: 구현을 버리지 않고 잴 수 있나?
// A: ⓐ 이 판정자가 «환경 결손»이라 말하면 짧게 쉬고 gate «만» 다시 돈다(기본 2회).
//    ⓑ 그래도 결손이면 브랜치·PR 을 남기고 `harvestable` 로 끝낸다(「버림」이 아니라 「수확 대기」).
//
// ⛔ 틀리는 방향이 비대칭이다(`self-dev/execution-transient.ts` 와 같은 계산):
//    도입 실패를 「환경」으로 부르면 → 자식 결손이 재작업 없이 수확 칸으로 빠진다.
//    ⇒ `introduced > 0` 또는 자식 책임이 «있음»이면 무조건 거짓. 어휘는 좁게 둔다.
// ⛔ `budget-exceeded`·`module-load-error` 는 넣지 않는다 — 다시 재도 같은 값이 나온다.

/** 환경 결손의 종류 — 관측(로그)과 PR 문면에 그대로 실린다. */
export type GateEnvDeficitKind =
  | 'test-result-unavailable'
  | 'infrastructure-failure'
  | 'git-lock'
  | 'out-of-memory'
  | 'unmeasured'
  | 'network-timeout';

export type GateEnvDeficitVerdict =
  | { readonly envDeficit: true; readonly kind: GateEnvDeficitKind }
  | { readonly envDeficit: false; readonly reason: 'passed' | 'introduced' | 'child-responsible' | 'non-retryable-reason' | 'no-env-signal' };

export interface GateEnvDeficitInput {
  readonly passed: boolean;
  readonly log?: string;
  readonly reflectGateFacts?: {
    readonly introduced?: number;
    readonly unknownReason?: string;
    readonly childResponsibility?: string;
  };
}

/** unknownReason 중 «다시 재면 풀릴 수 있는» 것만. */
const RETRYABLE_UNKNOWN_REASONS: ReadonlySet<string> = new Set(['test-result-unavailable', 'infrastructure-failure']);

/** unknownReason 중 «다시 재도 같은 값이 나오는» 것 — 로그에 환경 어휘가 섞여 있어도 이 사유가 이긴다. */
const NON_RETRYABLE_UNKNOWN_REASONS: ReadonlySet<string> = new Set(['budget-exceeded', 'module-load-error']);

/** 로그 어휘 — ⛔ 좁게(위 비대칭). 순서가 곧 우선순위. */
const LOG_PATTERNS: ReadonlyArray<readonly [GateEnvDeficitKind, RegExp]> = [
  ['git-lock', /index\.lock|another git process seems to be running|cannot lock ref/i],
  ['out-of-memory', /javascript heap out of memory|heap out of memory|oomkilled|fatal error: .*allocation failed/i],
  ['unmeasured', /could not measure|측정 불가/i],
  ['network-timeout', /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)\b|registry\.npmjs\.org.*(?:timeout|timed out)|network timeout|socket hang up/i],
];

/**
 * 순수: 실패한 gate 결과가 «환경 결손»인가를 판정한다.
 * ⛔ 도입 실패(`introduced > 0`)·자식 책임 있음은 언제나 거짓 — 그 동작은 바꾸지 않는다.
 */
export function classifyGateEnvDeficit(gate: GateEnvDeficitInput): GateEnvDeficitVerdict {
  if (gate.passed) return { envDeficit: false, reason: 'passed' };
  const facts = gate.reflectGateFacts;
  if ((facts?.introduced ?? 0) > 0) return { envDeficit: false, reason: 'introduced' };
  if (facts?.childResponsibility !== undefined && facts.childResponsibility !== 'none') {
    return { envDeficit: false, reason: 'child-responsible' };
  }
  if (facts?.unknownReason !== undefined && NON_RETRYABLE_UNKNOWN_REASONS.has(facts.unknownReason)) {
    return { envDeficit: false, reason: 'non-retryable-reason' };
  }
  if (facts?.unknownReason !== undefined && RETRYABLE_UNKNOWN_REASONS.has(facts.unknownReason)) {
    return { envDeficit: true, kind: facts.unknownReason as GateEnvDeficitKind };
  }
  const log = gate.log ?? '';
  for (const [kind, pattern] of LOG_PATTERNS) {
    if (pattern.test(log)) return { envDeficit: true, kind };
  }
  return { envDeficit: false, reason: 'no-env-signal' };
}

/** 기본 재시도 정책 — 짧게 쉬고 gate 만 최대 2회. */
export const DEFAULT_GATE_ENV_RETRY = { attempts: 2, delayMs: 20_000 } as const;

/** 수확 대기로 남길 때 PR·종료 사유에 싣는 표지. */
export const GATE_ENV_DEFICIT_HARVESTABLE_MARK = 'env-deficit, harvestable';
