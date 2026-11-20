// UX-SIM · LLM provider 시뮬 세계 — 시나리오 도우미 (LLM-AUTO-PROVIDER-E2E · 0.3.31)
//
// ⛔ 전부 가짜 · 실 키/토큰/네트워크 0. 시나리오 본체(세계 조작 → 결정/가드 호출 → 리터럴 기대값)는 scenarios.test.ts.
// 여기는 «세계 ↔ 결정 함수/가드» 를 잇는 얇은 조립만 한다 — 새 결정 로직 0(결정은 src/oauth 의 함수가 한다).

import { createInMemoryGuardStore, runLlmSpendGuard, type LlmSpendGuardResult } from '../../oauth/llm-spend-guard.js';
import { decideLlmSpend, type LlmSpendDecision, type LlmSpendDecisionRequest } from '../../oauth/llm-spend-decision.js';
import type { SpendReservationLedger } from '../../oauth/llm-spend-reservation.js';
import { defaultSpendPolicyDoc } from '../../nexus/llm-spend-policy/schema.js';
import type { LlmSpendLedgerEntry, LlmSpendPolicyDoc, LlmSpendRolePolicy } from '../../nexus/llm-spend-policy/types.js';
import type { SimLlmProviderWorld } from './world.js';

/** 기본 정책에 역할 절·크레딧 모델만 덮어쓴 정책 오버레이(기본 값은 그대로 · 결정 함수는 건드리지 않는다). */
export function policyWith(overlay: {
  readonly roles?: Readonly<Record<string, Partial<LlmSpendRolePolicy>>>;
  readonly creditModels?: readonly string[];
  readonly creditSpendCap?: { readonly dailyUsd?: number; readonly monthlyUsd?: number };
} = {}): LlmSpendPolicyDoc {
  const base = defaultSpendPolicyDoc();
  const credit = base.providers.openrouter;
  if (!credit || credit.kind !== 'credit') throw new Error('기본 정책에 openrouter 크레딧 행이 없다');
  const roles = { ...base.roles } as Record<string, LlmSpendRolePolicy>;
  for (const [name, patch] of Object.entries(overlay.roles ?? {})) {
    const prior = roles[name] ?? { prefer: [], creditOk: false, deny: [] };
    roles[name] = { ...prior, ...patch } as LlmSpendRolePolicy;
  }
  return {
    ...base,
    roles: roles as LlmSpendPolicyDoc['roles'],
    providers: {
      ...base.providers,
      openrouter: {
        ...credit,
        ...(overlay.creditModels ? { models: [...overlay.creditModels] } : {}),
        ...(overlay.creditSpendCap ? { spendCap: { ...overlay.creditSpendCap } } : {}),
      },
    },
  };
}

/** 결정 함수 한 번 — 세계의 states() 와 시계를 그대로 먹인다. */
export function decideOnWorld(
  world: SimLlmProviderWorld,
  request: Omit<LlmSpendDecisionRequest, 'now'>,
  policy: LlmSpendPolicyDoc = defaultSpendPolicyDoc(),
): LlmSpendDecision {
  return decideLlmSpend(policy, world.states(), { ...request, now: world.clock.now() });
}

export interface WorldGuard {
  readonly ledger: LlmSpendLedgerEntry[];
  run(request: Parameters<typeof runLlmSpendGuard>[1]): Promise<LlmSpendGuardResult>;
}

/** 가드 한 벌(기억·원장 메모리) — 세계 states/시계 주입. reservations 를 주면 판정+예약이 한 임계 구역이다. */
export function guardOnWorld(
  world: SimLlmProviderWorld,
  opts: { readonly policy?: LlmSpendPolicyDoc; readonly reservations?: SpendReservationLedger } = {},
): WorldGuard {
  const ledger: LlmSpendLedgerEntry[] = [];
  const memory = createInMemoryGuardStore();
  const policy = opts.policy ?? defaultSpendPolicyDoc();
  return {
    ledger,
    run: (request) => runLlmSpendGuard({
      policy,
      readStates: () => world.states(),
      memory,
      appendLedger: (entry) => { ledger.push(entry); },
      now: () => world.clock.now(),
      ...(opts.reservations ? { reservations: opts.reservations } : {}),
    }, request),
  };
}

/** codex ×3 · claude-code-sub 의 5h 창을 전부 소진(리셋 시각 지정). acp 는 건드리지 않는다. */
export function exhaustAllSubscriptions(world: SimLlmProviderWorld, resetsAtIso: string): void {
  for (const device of [world.codex.default, world.codex.team, world.codex.third, world.claude.sub1]) device.exhaust('five-hour', resetsAtIso);
}

/** 비밀 모양 탐침 — sk-·ghp_·JWT(eyJ)·긴 무작위(공백·하이픈 없는 32자 이상 base64 꼴). */
export const SECRET_SHAPE_PROBE = /sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/]{32,}/;

/** 임의 값 속 모든 문자열 잎을 모은다(키 포함) — 탐침 입력. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); collectStrings(v, out); }
  return out;
}
