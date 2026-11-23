// 강·중·약 섞기 정책 v0 (대표 11-17 20:5x «강한 모델은 중요한 순간에만 · 메이저 시간은 약한 모델»)
// 출처: seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md §강·중·약 섞기 정책 v0.
//
// S: ROUTER 는 일감 하나에 등급을 고른다. 그러나 한 일감 안에서도 «순간»마다 필요한 세기가 다르다.
// C: 강한 모델이 손일까지 하면 비용이 새고, 약한 모델이 막힌 채 같은 오류를 반복하면 라운드가 샌다.
// Q: 언제 한 단계 올리고 언제 내리며, 그 몫이 목표 안에 있는지 어떻게 보나?
// A: 순수 정책 함수(올림 계기 → 한 단계 위 · 판단 하나 뒤 즉시 내림) ⊕ 호출마다 {등급·계기} 칸 ⊕
//    `eln usage runs --by role` 의 등급별 몫 칸(강 >10% = 노랑). 등급은 tier 사다리 «이름»으로만 푼다.
//    런타임 신호(같은 오류 횟수·빨강 라운드)는 HARNESS-ADVISOR-CHECKPOINTS 칸이 `escalateOnce` 에 넣는다.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelTier } from './types.js';
import { LLM_TIER_MAP_BY_PROVIDER, type LlmTierProvider } from './llm-tier-map.js';
import type { CoreCallLedgerFields, EscalationTrigger as CoreEscalationTrigger, WorkTierClass, WorkTierTrigger } from './orchestration-core.js';

export type { WorkTierClass, WorkTierTrigger } from './orchestration-core.js';
export const WORK_TIER_CLASSES: readonly WorkTierClass[] = ['weak', 'mid', 'strong'];

/** 사다리 칸 → 등급. budget = 약 · balanced/better = 중 · best/loaded = 강. */
export const WORK_TIER_CLASS_OF: Readonly<Record<ModelTier, WorkTierClass>> = {
  budget: 'weak', balanced: 'mid', better: 'mid', best: 'strong', loaded: 'strong',
};

/** 등급 → 사다리에서 풀 칸(라우터와 같은 칸: 약 budget · 중 better · 강 best). */
export const WORK_TIER_LADDER_CELL: Readonly<Record<WorkTierClass, ModelTier>> = {
  weak: 'budget', mid: 'better', strong: 'best',
};

// ── 목표 몫·상한(출처: ASK §강·중·약 섞기 정책 v0 표) ──────────────────────────
/** 약 몫 하한 — 표 «≥70%». */
export const WEAK_SHARE_MIN = 0.7;
/** 중 몫 목표 범위 — 표 «~20~25%». */
export const MID_SHARE_TARGET = { min: 0.2, max: 0.25 } as const;
/** 강 몫 상한 — 표 «≤5~10%» 의 위 끝. 넘으면 노랑(«목표 이탈(강 >10%)이면 노랑»). */
export const STRONG_SHARE_YELLOW_ABOVE = 0.1;
/** 강 모델 출력 상한(토큰) — «짧은 조언·계획·판정(≤400 토큰)». */
export const STRONG_OUTPUT_MAX_TOKENS = 400;
/** 올림 계기: 같은 오류 횟수 — «같은 오류 2회». */
export const SAME_ERROR_ESCALATE_AT = 2;
/** 올림 계기: 연속 빨강 라운드 — «시험이 3 라운드 빨강». */
export const RED_ROUNDS_ESCALATE_AT = 3;

/** 섞기 정책 v0 표의 계기(코어 어휘의 부분집합 — ADVISOR 계기 `advisor:<moment>` 는 `advisor-checkpoints.ts`). */
export type EscalationTrigger = Extract<CoreEscalationTrigger, 'same-error-twice' | 'red-rounds' | 'risky-first-design'>;

/** ADVISOR 칸이 채울 런타임 신호(이 PR 에서는 관측하지 않는다). */
export interface EscalationSignals {
  /** 같은 단계에서 같은 오류(정규화된 오류 코드 기준)가 난 횟수. */
  readonly sameErrorCount?: number;
  /** 연속 빨강 시험 라운드 수. */
  readonly redRounds?: number;
  /** 위험 경로(영속·잠금·보안) 일감의 «첫» 설계 순간인가. */
  readonly riskyFirstDesign?: boolean;
}

export interface EscalationStep {
  readonly from: WorkTierClass;
  readonly to: WorkTierClass;
  readonly trigger: EscalationTrigger;
  /** 올린 등급이 낼 출력 상한 — 강이면 STRONG_OUTPUT_MAX_TOKENS, 아니면 없음. */
  readonly maxOutputTokens?: number;
  /** 판단 «하나»만 받는다 — 그 뒤 `afterJudgement` 로 즉시 내려온다. */
  readonly judgements: 1;
}

function oneStepUp(tier: WorkTierClass): WorkTierClass | null {
  const index = WORK_TIER_CLASSES.indexOf(tier);
  return WORK_TIER_CLASSES[index + 1] ?? null;
}

/** 계기 판정 순서 — 위험 첫 설계 › 같은 오류 › 빨강 라운드(하나만 고른다 · 여러 개여도 한 단계). */
export function escalationTrigger(signals: EscalationSignals): EscalationTrigger | null {
  if (signals.riskyFirstDesign === true) return 'risky-first-design';
  if ((signals.sameErrorCount ?? 0) >= SAME_ERROR_ESCALATE_AT) return 'same-error-twice';
  if ((signals.redRounds ?? 0) >= RED_ROUNDS_ESCALATE_AT) return 'red-rounds';
  return null;
}

/** 순수: 계기가 있으면 «한 단계만» 위. 이미 강이거나 계기가 없으면 null(올리지 않는다). */
export function escalateOnce(current: WorkTierClass, signals: EscalationSignals): EscalationStep | null {
  const trigger = escalationTrigger(signals);
  if (!trigger) return null;
  const to = oneStepUp(current);
  if (!to) return null;
  return { from: current, to, trigger, judgements: 1, ...(to === 'strong' ? { maxOutputTokens: STRONG_OUTPUT_MAX_TOKENS } : {}) };
}

/** 판단 하나를 받은 뒤 — 올리기 전 등급으로 즉시 내린다. */
export function afterJudgement(step: EscalationStep): WorkTierClass {
  return step.from;
}

// ── 상시 하향 계기(ROUTER-STEP-UP-DOWN r1 · OP #127661) ──────────────────────
// 칸 본문: «고급(terra/sol)은 checkpoint(계획·최종 검토·보안)와 «실패 신호» 때 1턴만 올렸다가 바로 내림» —
// 그 역변으로, 쉬운 일에 성공이 쌓이면 «상시»로 한 단계씩 내려 가벼운 모델 장기 점유로 돌아간다.
// 올림(escalateOnce·afterJudgement)과 달리 하향은 판정 하나 뒤가 아니라 계기가 살아 있는 동안 계속 적용된다.
// 런타임 신호(연속 성공 턴·쉬운 일 분류·순간)는 HARNESS-ADVISOR-CHECKPOINTS 칸이 `stepDownOnce` 에 넣는다(escalateOnce 와 같은 배선).

/** 하향 계기: 연속 성공 턴 수 — «성공 N턴». 쉬운 일 분류와 함께 충족되어야 한다.
 *  NUMGUARD: 출처 = OP #127661 «상시 하향 계기 — N은 이 PR 튜닝 상수»(ROUTER-STEP-UP-DOWN r1). 실측 재튜닝은 #39502 원장. */
export const WORK_STEPDOWN_SUCCESS_TURNS = 3;

/** 하향 금지 순간 — 칸 본문 checkpoint(계획·최종 검토·보안). advisor 순간 어휘(plan·pre-complete)와 정합. */
export const STEPDOWN_CHECKPOINT_MOMENTS: readonly string[] = ['plan', 'pre-complete', 'security'];

/** 하향 계기 이름 — 코어 `advisor:${순간}` 어휘의 부분집합이라 원장의 WorkTierTrigger 칸에 그대로 실린다. */
export type StepDownTrigger = 'advisor:step-down';

/** ADVISOR 칸이 채울 런타임 하향 신호(이 PR 에서는 관측하지 않는다 — escalateOnce 와 같은 배선). */
export interface StepDownSignals {
  /** 지금 과제에서 연속 성공(녹색 판정·완결)한 턴 수. */
  readonly successTurns?: number;
  /** 과제가 쉬운 일로 분류되었는가(라우터 budget/cheap 분류). */
  readonly easyTask?: boolean;
  /** 지금 순간의 checkpoint 이름 — STEPDOWN_CHECKPOINT_MOMENTS 안이면 고급이 필요한 순간이라 내리지 않는다. */
  readonly checkpointMoment?: string;
  /** 올림 계기(실패 신호) — 살아 있으면 올림이 우선이라 내리지 않는다. */
  readonly escalating?: EscalationSignals;
}

export interface StepDownStep {
  readonly from: WorkTierClass;
  readonly to: WorkTierClass;
  readonly trigger: StepDownTrigger;
}

function oneStepDown(tier: WorkTierClass): WorkTierClass | null {
  const index = WORK_TIER_CLASSES.indexOf(tier);
  return index > 0 ? WORK_TIER_CLASSES[index - 1] ?? null : null;
}

/** 순수: «성공 N턴 + 쉬운 일 분류» 상시 계기가 살아 있으면 «한 단계만» 아래.
 *  checkpoint 순간 · 살아 있는 올림 계기 · 최하등급(weak)이면 null(내리지 않는다). */
export function stepDownOnce(current: WorkTierClass, signals: StepDownSignals): StepDownStep | null {
  if (signals.checkpointMoment !== undefined && STEPDOWN_CHECKPOINT_MOMENTS.includes(signals.checkpointMoment)) return null;
  if (escalationTrigger(signals.escalating ?? {})) return null;
  if (signals.easyTask !== true) return null;
  // terra r1 mustFix(유한 턴 수만 허용): NaN·Infinity 는 «성공 N턴 확인됨»이 아니므로 내리지 않는다.
  // 결함: NaN < N 은 거짓이라 (successTurns ?? 0) < N 가드를 통과해 3턴 미확인인데도 하향했다.
  const successTurns = signals.successTurns;
  if (typeof successTurns !== 'number' || !Number.isFinite(successTurns) || successTurns < WORK_STEPDOWN_SUCCESS_TURNS) return null;
  const to = oneStepDown(current);
  return to === null ? null : { from: current, to, trigger: 'advisor:step-down' };
}

/** 등급의 출력 상한(강만). 호출측은 이 값을 요청 max_tokens 로 쓴다. */
export function outputCapForClass(tier: WorkTierClass): number | undefined {
  return tier === 'strong' ? STRONG_OUTPUT_MAX_TOKENS : undefined;
}

/** 강 출력이 상한을 넘었나(원장·경고용). */
export function strongOutputOverCap(tier: WorkTierClass, outputTokens: number | undefined): boolean {
  return tier === 'strong' && typeof outputTokens === 'number' && outputTokens > STRONG_OUTPUT_MAX_TOKENS;
}

// ── 호출 원장 칸 ───────────────────────────────────────────────────────────

/** provider 사다리에서 모델이 처음 나오는 «가장 낮은» 칸의 등급. 사다리에 없으면 undefined(지어 세지 않는다).
 *  ⚠️ 같은 모델이 여러 칸에 있으면 가장 낮은 칸을 쓴다(예: grok-4.7 = better·best → 중). */
export function workTierClassForModel(provider: string | undefined, model: string | undefined): WorkTierClass | undefined {
  if (!provider || !model) return undefined;
  const name = provider.replace(/^auto:/, '');
  if (!Object.prototype.hasOwnProperty.call(LLM_TIER_MAP_BY_PROVIDER, name)) return undefined;
  const ladder = LLM_TIER_MAP_BY_PROVIDER[name as LlmTierProvider];
  for (const tier of ['budget', 'balanced', 'better', 'best', 'loaded'] as const) {
    if (ladder[tier].model === model) return WORK_TIER_CLASS_OF[tier];
  }
  return undefined;
}

/** 호출 단위 «지금 등급» 문맥 — ADVISOR 가 상담 한 번을 `runWithWorkTierContext` 로 감싼다.
 *  AsyncLocalStorage 라서 같은 프로세스의 다른 세션·병렬 호출에는 새지 않고, 겹친 상담끼리 서로 풀지 않는다(Opus 리뷰 sf1). */
export interface WorkTierContext {
  readonly tier: WorkTierClass;
  readonly trigger: WorkTierTrigger;
  /** ROUTER-OR-CODEX-MIX-CHOKEPOINT(OP #132227) — 이 호출을 낸 코어 결정의 id. 같은 id 가 llm.usage 줄(routeDecisionId)까지 이어진다. */
  readonly decisionId?: string;
}

const tierContextStore = new AsyncLocalStorage<WorkTierContext>();

/** `fn` 과 그 안의 비동기 사슬에서만 문맥이 보인다 — 끝나면 자동으로 내려온다. */
export function runWithWorkTierContext<T>(context: WorkTierContext, fn: () => T): T {
  return tierContextStore.run(context, fn);
}

export function workTierContext(): WorkTierContext | null {
  return tierContextStore.getStore() ?? null;
}

/** `llm-usage` 한 줄에 덧붙일 칸 — 등급·계기·출처만(문면 0). 토큰·비용은 그 줄의 기존 칸이다. */
export function workTierUsageFields(provider: string | undefined, model: string): Partial<CoreCallLedgerFields> {
  const context = workTierContext();
  if (context) return { workTier: context.tier, workTierTrigger: context.trigger, workTierSource: 'context', ...(context.decisionId ? { routeDecisionId: context.decisionId } : {}) };
  const tier = workTierClassForModel(provider, model);
  return tier ? { workTier: tier, workTierTrigger: 'base', workTierSource: 'model-lookup' } : {};
}

// ── 등급별 몫 보기(`eln usage runs --by role`) ───────────────────────────────

export interface TierShareInput {
  readonly runId?: string | null;
  readonly workTier?: string | null;
  readonly billingProvider?: string | null;
  readonly model?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cost?: { kind?: string; usd?: number | null; apiEquivalentUsd?: number } | null;
}

export interface TierShareRow {
  readonly tier: WorkTierClass | 'unknown';
  readonly calls: number;
  readonly tokens: number;
  /** tokens ÷ 등급이 정해진 호출의 토큰 합. unknown 은 몫 계산에서 뺀다(지어 세지 않는다). */
  readonly share: number | null;
  readonly usdKnown: number;
  readonly apiEquivalentUsd: number;
  readonly runs: number;
}

export interface TierShareReport {
  readonly rows: readonly TierShareRow[];
  readonly strongShare: number | null;
  /** 약 몫 — WEAK_SHARE_MIN 아래면 status 가 GREEN 이 아니다(HARNESS-DIFFICULTY-ROUTER-WEAK70-FU). */
  readonly weakShare: number | null;
  readonly status: 'GREEN' | 'YELLOW' | 'UNMEASURED';
  readonly targets: { readonly weakMin: number; readonly mid: { readonly min: number; readonly max: number }; readonly strongYellowAbove: number };
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isClass(value: unknown): value is WorkTierClass {
  return typeof value === 'string' && (WORK_TIER_CLASSES as readonly string[]).includes(value);
}

export function summarizeTierShares(inputs: readonly TierShareInput[]): TierShareReport {
  const buckets = new Map<WorkTierClass | 'unknown', { calls: number; tokens: number; usd: number; equiv: number; runs: Set<string> }>();
  for (const data of inputs) {
    const tier = isClass(data.workTier) ? data.workTier : workTierClassForModel(data.billingProvider ?? undefined, data.model ?? undefined) ?? 'unknown';
    const bucket = buckets.get(tier) ?? { calls: 0, tokens: 0, usd: 0, equiv: 0, runs: new Set<string>() };
    bucket.calls += 1;
    bucket.tokens += finite(data.inputTokens) + finite(data.outputTokens);
    if (data.cost?.kind === 'included') bucket.equiv += finite(data.cost.apiEquivalentUsd);
    else bucket.usd += finite(data.cost?.usd);
    // 라운드 열은 두지 않는다 — llm-usage 줄에 round 가 없다. 라운드는 runId 로 런 원장(data.round)과 잇는다(후속 MODEL-CORE-FOLLOWUP).
    if (data.runId) bucket.runs.add(data.runId);
    buckets.set(tier, bucket);
  }
  const classified = [...buckets].filter(([tier]) => tier !== 'unknown').reduce((sum, [, bucket]) => sum + bucket.tokens, 0);
  const order: Array<WorkTierClass | 'unknown'> = [...WORK_TIER_CLASSES, 'unknown'];
  const rows: TierShareRow[] = order.flatMap((tier) => {
    const bucket = buckets.get(tier);
    if (!bucket) return [];
    return [{
      tier, calls: bucket.calls, tokens: bucket.tokens,
      share: tier === 'unknown' || classified === 0 ? null : bucket.tokens / classified,
      usdKnown: bucket.usd, apiEquivalentUsd: bucket.equiv,
      runs: bucket.runs.size,
    }];
  });
  const strongShare = classified === 0 ? null : (buckets.get('strong')?.tokens ?? 0) / classified;
  const weakShare = classified === 0 ? null : (buckets.get('weak')?.tokens ?? 0) / classified;
  // P2-13 HARNESS-DIFFICULTY-ROUTER-WEAK70-FU(ROSTER-0334): WEAK_SHARE_MIN 은 표시만이 아니라 status 에도 반영된다 —
  // 약 몫이 하한 아래면 GREEN 이 아니다(기존 상태 어휘 'YELLOW' 재사용 · 새 상수·새 상태값 0).
  return {
    rows,
    strongShare,
    weakShare,
    status: strongShare === null ? 'UNMEASURED'
      : strongShare > STRONG_SHARE_YELLOW_ABOVE || (weakShare !== null && weakShare < WEAK_SHARE_MIN) ? 'YELLOW'
      : 'GREEN',
    targets: { weakMin: WEAK_SHARE_MIN, mid: { ...MID_SHARE_TARGET }, strongYellowAbove: STRONG_SHARE_YELLOW_ABOVE },
  };
}

export function formatTierShareReport(report: TierShareReport): string[] {
  const pct = (value: number | null) => (value === null ? '-' : `${(value * 100).toFixed(1)}%`);
  const lines = [
    `등급별 몫·비용 — ${report.status} (약 ${pct(report.weakShare)} · 강 ${pct(report.strongShare)} · 목표 약 ≥${pct(report.targets.weakMin)} · 중 ${pct(report.targets.mid.min)}~${pct(report.targets.mid.max)} · 강 ≤${pct(report.targets.strongYellowAbove)})`,
  ];
  for (const row of report.rows) {
    lines.push(`  ${row.tier}  calls=${row.calls}  tokens=${row.tokens}  share=${pct(row.share)}  usdKnown=${row.usdKnown}  apiEquivalentUsd=${row.apiEquivalentUsd}  runs=${row.runs}`);
  }
  return lines;
}
