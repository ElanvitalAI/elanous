// 모델 오케스트레이션 코어 — 계약 한 장 (대표 11-17 21:3x «한 몸 원칙»)
//
// S: 라우터(이 순간 어느 등급), 강 모델 조언(언제 올리나), 구독 창(어느 계정)은 따로 만들면 세 갈래 호출 경로가 된다.
// C: 갈래가 셋이면 같은 호출을 두 곳이 고르고, 원장도 갈라져 «등급별 몫·비용»을 한 표로 못 본다.
// Q: 셋을 한 기계로 묶으면서 ADVISOR·창 칸이 호출부를 건드리지 않고 끼우려면 계약이 어떤 모양이어야 하나?
// A: 코어 하나가 입력(일감 신호 · 실패 사건 · 계정/창 상태)을 받아 {등급, 모델, 계정, 이유} 하나를 낸다.
//    규칙은 코어 «안»의 모듈 칸에만 끼운다 — 올림 규칙(섞기 정책 v0 · ADVISOR) · 계정 고르기(창 인지).
//    결정마다·호출마다 원장 한 줄({등급, 이유/계기, 계정, 토큰, 비용} ⊕ runId)이고 문면은 없다.
//    eln 하니스는 이 코어만 부른다. 그림자(기본)는 결정을 적기만 하고 발사 모델을 바꾸지 않는다.
//
// 칸 주인: 코어 = HARNESS-DIFFICULTY-ROUTER(TC) · 올림 모듈 = HARNESS-ADVISOR-CHECKPOINTS(OP-SHADOW-OPUS)
//          · 계정 입력 = COST-OPTIMIZER-WINDOW-AWARE. 출처: seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md §한 몸 원칙.

import type { ModelTier } from './types.js';

// ── 어휘(코어가 주인) ─────────────────────────────────────────────────────

export type WorkRiskCategory = 'persistence' | 'locking' | 'cross-process' | 'security';
export type WorkLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
export type BloomStage = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';
/** 섞기 정책 v0 의 세 등급 — 사다리 칸 «이름»으로만 푼다(약 budget · 중 better · 강 best). */
export type WorkTierClass = 'weak' | 'mid' | 'strong';
/** 일감 안의 «순간» — 설계(계획 직전) · 판정(완료 직전·리뷰) · 구현(손일). */
export type WorkMoment = 'design' | 'judge' | 'implement';
export type EscalationTrigger = 'same-error-twice' | 'red-rounds' | 'risky-first-design' | `advisor:${string}`;
/** 결정·호출 원장의 계기 칸 — 올림이 없으면 `base`. */
export type WorkTierTrigger = 'base' | EscalationTrigger;
export type CoreMode = 'shadow' | 'on';

// ── 입력 ─────────────────────────────────────────────────────────────────

/** 일감 신호 — 분류기(`classifyWorkRisk`) 출력. 골 산문은 입력이 아니다. */
export interface WorkSignals {
  readonly level: WorkLevel;
  readonly bloom: BloomStage;
  readonly riskCategories: readonly WorkRiskCategory[];
  readonly reasons: readonly string[];
}

/** 실패 사건 — 하니스 런타임이 센다(ADVISOR 칸이 채운다). */
export interface FailureEvents {
  readonly sameErrorCount?: number;
  /** 같은 오류의 정규화 키(오류 코드·시험 이름 — 문면 아님). ADVISOR 는 키마다 한 번만 상담한다. */
  readonly errorKey?: string;
  readonly redRounds?: number;
  readonly riskyFirstDesign?: boolean;
}

/** 계정 하나의 상태 — `eln usage` 가 읽는 축(구독 창 · 선불 · 크레딧). 모르는 값은 생략(지어 넣지 않는다). */
export interface AccountCandidate {
  readonly provider: string;
  readonly account: string;
  readonly billing: 'subscription' | 'prepaid' | 'credit' | 'api' | 'unknown';
  /** 이 계정에서 쓸 수 있는 사다리 칸. 생략 = 모름. */
  readonly tiers?: readonly ModelTier[];
  /** 구독 창 남은 몫(0..1) · 리셋 시각(ms). */
  readonly window?: { readonly remaining: number; readonly resetsAtMs?: number };
  readonly overage?: boolean;
  /** 이 창이 버텨야 할 시각(ms) — 이 시각 전에 리셋이 오지 않으면 예비 몫 아래로 쓰지 않는다. 생략 = 모름. */
  readonly mustLastUntilMs?: number;
  /** API 계정의 «결과당 비용» 순위(작을수록 싸다) — 값(가격)이 아니라 순위만. 생략 = 모름. */
  readonly costRank?: number;
}

export interface AccountState {
  readonly candidates: readonly AccountCandidate[];
  /** 지금 활성 계정(없으면 null) — 기본 선택기는 이것을 그대로 둔다. */
  readonly active: { readonly provider: string; readonly account: string | null } | null;
  /** COST-OPTIMIZER-WINDOW-AWARE — 스냅숏 데이터의 관측 시각(ms · 후보 중 가장 오래된 것). 생략 = 모름(낡음으로 본다). */
  readonly observedAtMs?: number;
  /** 스냅숏을 읽은 시각(ms) — 선택기는 시계를 안 본다. 이 값으로 나이를 잰다. 생략 = 모름(낡음으로 본다). */
  readonly readAtMs?: number;
  /** 창 인지 선택 모드 — `on` 만 계정을 바꾼다. 생략·그 밖 = shadow(고를 계정을 원장 이유에만). */
  readonly selection?: 'shadow' | 'on';
  /** 사람이 계정을 명시했다(예: `ELANOUS_CODEX_ACCOUNT`) — 의도가 이긴다. 창 선택기는 바꾸지 않는다. */
  readonly explicit?: boolean;
}

export interface CoreDecisionInput {
  readonly runId: string;
  readonly moment: WorkMoment;
  /** 사다리를 고를 provider(활성·역할 provider). */
  readonly provider: string;
  readonly work: WorkSignals;
  readonly failures?: FailureEvents;
  readonly accounts?: AccountState;
  /** ADVISOR 상담 순간(강 모델 조언 호출일 때만). 생략 = 손일 결정(섞기 정책 표만 적용). */
  readonly checkpoint?: AdvisorMoment;
}

/** 강 모델 조언의 세 순간 — 계기 `advisor:<moment>`. */
export type AdvisorMoment = 'plan' | 'same-error' | 'pre-complete';

// ── 출력 ─────────────────────────────────────────────────────────────────

export interface CoreDecision {
  readonly tier: WorkTierClass;
  /** 실제로 푼 사다리 칸 — 모델 id 는 이 칸에서만 나온다. */
  readonly cell: ModelTier;
  readonly provider: string;
  /** 사다리가 없는 provider 면 null(지어 넣지 않는다). */
  readonly model: string | null;
  readonly account: string | null;
  readonly trigger: WorkTierTrigger;
  /** 결정 근거 코드(문면 아님) — 등급 판정 · 올림 · 계정 고르기. */
  readonly reason: readonly string[];
  /** 강 등급이면 출력 상한(토큰). */
  readonly maxOutputTokens?: number;
  /** 계정 선택이 측정값 없이 내린 칸(정렬에서 «모름 = 뒤»로 처리됐다). 생략 = 선택기가 말하지 않음. */
  readonly unmeasured?: readonly WindowSignalField[];
}

// ── 모듈 칸(호출부를 건드리지 않고 끼운다) ────────────────────────────────────

/** 올림 규칙 — 기준 등급에서 «한 단계» 올릴지. null = 올리지 않음. 여러 규칙이 있어도 첫 제안 하나만 쓴다. */
export interface EscalateRule {
  readonly name: string;
  propose(context: { readonly input: CoreDecisionInput; readonly base: WorkTierClass }):
    { readonly trigger: EscalationTrigger; /** 생략 = 한 단계 위(섞기 정책) · 'strong' = 강 상담(ADVISOR 세 순간). */ readonly target?: 'strong' } | null;
}

/** 강 모델 조언 클라이언트 — `on` 일 때만 부른다. 돌려준 문면은 호출측 맥락에만 쓰이고 원장에는 들어가지 않는다. */
export interface AdvisorClient {
  advise(request: {
    readonly runId: string; readonly moment: AdvisorMoment; readonly provider: string; readonly model: string; readonly maxOutputTokens: number;
    /** 조언 모델에게만 가는 문면(목표 · 반복 오류 · 완료 증거). 원장·로그에는 싣지 않는다. */
    readonly prompt: { readonly objective: string; readonly detail: string };
  }):
    Promise<{ readonly advice: string; readonly inputTokens?: number; readonly outputTokens?: number; readonly cost?: { readonly kind: string; readonly usd?: number } }>;
}

/** 계정 고르기 — 같은 등급 안에서 어느 계정/provider 로 낼지(구독 창·선불·크레딧). */
/** 창 선택 신호 중 «측정 원천이 없어» 결정에 쓰지 못한 칸 — 결정 원장에 그대로 남긴다(OP #38337 ②). */
export type WindowSignalField = 'resetsAtMs' | 'costRank' | 'mustLastUntilMs';

export interface AccountSelector {
  readonly name: string;
  select(context: { readonly input: CoreDecisionInput; readonly tier: WorkTierClass; readonly cell: ModelTier }):
    { readonly provider: string; readonly account: string | null; readonly reason: string; readonly unmeasured?: readonly WindowSignalField[] };
}

export interface CoreModules {
  /** 올림 규칙 모듈 — 내장 섞기 정책 v0 표 «앞»에 돈다(ADVISOR 칸 자리). 첫 제안 하나만 쓴다. */
  readonly escalate?: readonly EscalateRule[];
  /** 계정/창 선택 — COST-OPTIMIZER-WINDOW-AWARE 자리. 기본 = 활성 계정 유지. */
  readonly accounts?: AccountSelector;
  /** provider → 사다리(기본 = `LLM_TIER_MAP_BY_PROVIDER`). 시험은 가짜 사다리를 끼운다. */
  readonly ladder?: (provider: string) => Readonly<Record<ModelTier, { readonly model: string }>> | undefined;
}

// ── 원장(결정 한 줄 · 호출 한 줄 · runId 로 잇는다 · 문면 0) ───────────────────

export interface CoreDecisionLedgerRecord {
  readonly kind: 'decision';
  readonly runId: string;
  readonly moment: WorkMoment;
  readonly level: WorkLevel;
  readonly bloom: BloomStage;
  readonly riskCategories: readonly WorkRiskCategory[];
  readonly tier: WorkTierClass;
  readonly cell: ModelTier;
  readonly provider: string;
  readonly model: string | null;
  readonly account: string | null;
  readonly trigger: WorkTierTrigger;
  readonly reason: readonly string[];
  readonly mode: CoreMode;
  /** 그림자면 false — 발사는 `launched` 로 갔다. */
  readonly applied: boolean;
  /** 적용 안 한 이유 코드(shadow · explicit-child-llm · run-env-model · non-default-role · no-tier-ladder · no-advisor-client). */
  readonly skip: string | null;
  readonly launched: { readonly provider: string | null; readonly model: string | null };
  /** COST-OPTIMIZER-WINDOW-AWARE — 발사가 자식 계정을 «실제로» 바꿨나(자식 env 를 넘겼을 때만 true · 모델 `applied` 와 별개). */
  readonly accountApplied: boolean;
  /** 바꾼 계정의 종류·해시(원 이름 아님) — `accountApplied` 가 false 면 null. */
  readonly appliedAccount: { readonly kind: AccountCandidate['billing']; readonly account: string } | null;
  /** 창 신호 중 측정 원천이 없던 칸(결정이 그 신호 없이 내려졌다는 표지). 없으면 빈 배열. */
  readonly unmeasured: readonly WindowSignalField[];
}

export interface CoreCallLedgerFields {
  readonly workTier: WorkTierClass;
  readonly workTierTrigger: WorkTierTrigger;
  /** context = 코어 결정 문맥 · model-lookup = 문맥 없이 사다리에서 역산. */
  readonly workTierSource: 'context' | 'model-lookup';
}

/** 코어 한 대. eln 하니스는 발사마다 `decide`, 모델 호출마다 `callFields` 를 부른다. */
export interface ModelOrchestrationCore {
  decide(input: CoreDecisionInput): CoreDecision;
  /** 호출 원장 칸(토큰·비용·계정은 `llm-usage` 줄의 기존 칸). 사다리에 없는 모델이면 빈 객체. */
  callFields(call: { readonly provider: string | undefined; readonly model: string }): Partial<CoreCallLedgerFields>;
  decisionRecord(decision: CoreDecision, input: CoreDecisionInput, applied: { readonly mode: CoreMode; readonly applied: boolean; readonly skip: string | null; readonly launched: { readonly provider: string | null; readonly model: string | null };
    /** 자식에 실제로 넘긴 계정(원 이름 · 원장에는 해시로만). 생략 = 계정을 바꾸지 않았다. */ readonly appliedAccount?: { readonly kind: AccountCandidate['billing']; readonly account: string } | null }): CoreDecisionLedgerRecord;
}
