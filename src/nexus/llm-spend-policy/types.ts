// NEXUS · LLM 지출 정책 한 장 — 타입·상태 계약 (LLM-SPEND-POLICY-ONE-SHOT · 0.3.31)
//
// 🔗 지시서: seat-state/OP/orders/LLM-SPEND-POLICY-ONE-SHOT.md · OP 정정 #107839/#107857 ·
//   TC-H-CC-1 계약 #107882 · 공급 순서 TC #108130.
//
// ⛔⭐ 정본은 넥서스 «한 벌»이다(OP #107839 정정). 호스트별 로컬 파일이 아니다 —
//   저장 형식은 YAML 이지만 그 파일의 소유자는 넥서스 데이터 영역(<config-dir>/nexus/)이고,
//   모든 실행 자리(자리 TUI·하니스·Pod·리뷰·원격 호스트)는 넥서스에서 «정책 + 금고 임대»를
//   «함께» 받는다. 넥서스에 안 닿으면 «마지막 정상 정책 + 남은 임대» 만 쓴다(새 임대 0 = fail-closed).
//   ⇒ 이 모듈은 그 «정책 한 장»의 데이터 모양을 정의한다. 저장은 store.ts, 판정은
//   src/oauth/llm-spend-decision.ts(resolveCodexAccountForRun 위 «공급자 일반화 한 층»).
//
// ⛔ 비밀 0(OP #107857 · JUD #107847): 이 문서 어디에도 토큰·키 «값»이 오지 않는다.
//   - 행마다 금고 항목 «이름» 만(vault · 예 oauth:codex:default — vault meta id 형식).
//   - 임대 상태는 id·TTL 만(leaseId·expiresAt — src/secret/lease-store.ts 와 같은 values-free 규약).
//   - 스키마 검증기(schema.ts)가 키 모양(sk-·ghp_·ems_·emt_·eyJ·긴 무작위) 문자열을 거부한다.
//   - 직렬화(store.ts)는 허용 목록 필드만 디스크에 적는다(vault meta serializer 와 같은 원리).
//
// ── 이 PR 이 «문서로만» 남기는 후속 칸 인터페이스(실배선 금지) ─────────────────────
//   · «패널» 칸(넥서스 편집 API·화면): 이 모듈의 LlmSpendPolicyDoc 를 POST 로 받아
//     store.writeStoredSpendPolicy 로 저장한다. 권한은 owner 인증 «만»(회원·자리·els 토큰 0)
//     · POST + Origin 검증 · 틀리면 검증 사유를 그대로 표시하고 이전 정책 유지(fail-closed).
//     CLI 편집 노출 0 — 이 PR 의 `eln llm policy` 는 조회 전용이다.
//   · GUARD 자동 회전 칸: 금고 항목 등록·회전이 이 정책의 vault «이름» 을 채운다.
//     코드 기본 행은 금고 이름을 지어내지 않는다(확립된 oauth:codex:<account> 관례만).
//   · 리셋 실측 복귀 칸(LLM-RETURN-ON-WINDOW-RESET): 쿼터 신호·리셋 실측이
//     SubscriptionWindowState.observed 로 들어와 returnOnReset 판정에 쓰인다.
//   · 공급자 API 읽기 칸(CREDIT-PROVIDER-TOPUP-READ): CC-1(TC-H-CC-1) 의
//     readOpenRouterCredit 가 CreditBalanceState·AutoTopUpState 를 실측해 주입한다.
//   · secret supply 칸: 결정 함수가 고른 행의 vault 이름으로 금고에서 임대를 받는다
//     (TTL·원장·revoke — 임대 값 자체는 결정 함수·정책 어디에도 오지 않는다).
//   · 소진 속도 자동 이동 칸: SubscriptionWindowState 의 연속 실측(기울기 %/h)으로
//     역할별 이동 순서를 정한다 — 이 PR 은 상태 슬롯만 정의한다.

// ── 정책 문서 칼럼(실측 칼럼 포함) ────────────────────────────────────────────────

/** 구독 창 칼럼 — 5h·주간 창 길이(hours) · 리셋 시각 실측(resetAt: 'HH:MM' 일간 리셋 또는 ISO 시각). */
export interface SubscriptionWindowColumn {
  readonly hours?: number;
  readonly resetAt?: string;
}

// ── 역할(지출 정책 역할 — MODEL_ROLES 와 다른 별도의 축) ──────────────────────────

/** 대표 07:4x/07:5x 역할 절의 역할 목록. 없는 역할 키는 검증이 거부한다. */
export const LLM_SPEND_POLICY_ROLES = [
  'review', 'judgement', 'authoring', 'hand-seat', 'ta-child', 'recovery', 'supervisor', 'seat-op',
] as const;
export type LlmSpendPolicyRole = (typeof LLM_SPEND_POLICY_ROLES)[number];

export function isLlmSpendPolicyRole(v: unknown): v is LlmSpendPolicyRole {
  return typeof v === 'string' && (LLM_SPEND_POLICY_ROLES as readonly string[]).includes(v);
}

// ── 공급자 상태(실측 «입력» — 결정 함수는 주입된 것만 본다) ──────────────────────

/** CC-1 계약(#107882): 크레딧 공급자 잔액. 읽기(readOpenRouterCredit)는 CC-1 몫 — 여기선 «받는» 타입만. */
export type CreditBalanceState =
  | {
    readonly status: 'measured';
    readonly usd: number;
    readonly totalCreditsUsd: number;
    readonly totalUsageUsd: number;
    readonly source: string;
    readonly observedAt: string;
  }
  | { readonly status: 'unmeasured'; readonly reason: string };

/** CC-1 계약(#107882): 자동 충전 상태. OR 공식 /credits 에는 topup 필드가 없어 not-provided 로 시작한다. */
export type AutoTopUpState =
  | {
    readonly status: 'measured';
    readonly enabled: boolean;
    readonly amountUsd?: number;
    readonly source?: string;
    readonly observedAt: string;
  }
  | { readonly status: 'unmeasured'; readonly reason: string };

/**
 * 구독 창 실측(지출 판정 입력). 쿼터 신호·리셋 실측 칸이 채운다.
 * ⛔ fail-closed: `unmeasured` 는 «창이 비었다»가 «아니라» «못 쟀다»다 — 판정은 이 행을
 *   못 쓴다(OBS-T188: 모름이 0%로 접히면 소진된 자격 위에 머문다).
 */
export type SubscriptionWindowState =
  | {
    readonly status: 'measured';
    readonly usedPct: number;
    readonly resetAt?: string;
    /** 실측 소진 기울기(%/h) — 연속 실측에서 얻은 값. 없으면 소진 속도 이동 판정 불가(이동 0). */
    readonly slopePctPerHour?: number;
    readonly source?: string;
    readonly observedAt: string;
  }
  | { readonly status: 'unmeasured'; readonly reason: string };

/** 지출 실측(일·월). 공급자 API 읽기 칸이나 지출 원장이 채운다 — spendCap 판정의 «소진 쪽» 값. */
export interface CreditSpendState {
  readonly todayUsd?: number;
  readonly monthUsd?: number;
  /** 역할별 몫 지출 실측 — creditSpendCap 판정(없으면 그 역할 크레딧 불가 · fail-closed). */
  readonly byRole?: Readonly<Partial<Record<LlmSpendPolicyRole, { readonly todayUsd?: number; readonly monthUsd?: number }>>>;
  readonly source?: string;
  readonly observedAt: string;
}

/** ACP 장치 헬스·세션 실측 — 없으면 «모른다» = 그 장치 불가(fail-closed). */
export type AcpDeviceHealthState =
  | { readonly status: 'measured'; readonly alive: boolean; readonly sessions: number; readonly observedAt: string }
  | { readonly status: 'unmeasured'; readonly reason: string };

/** 금고 임대 상태 — id·TTL 만(값 0). 만료·부재 = 그 행을 «못 쓴다»(fail-closed · 새 임대 0 = 정지). */
export type VaultLeaseState =
  | { readonly leaseId: string; readonly expiresAt: string }
  | { readonly leaseId: null; readonly reason: string };

/**
 * 결정 함수에 주입되는 «행 하나» 상태. 없는 칸 = 미주입(unmeasured/무임대)으로 표기하고
 * 판정은 fail-closed 로 그 행을 건너뛴다. 조회(CLI)도 주입된 것만 보여 준다.
 */
export interface LlmSpendRowState {
  readonly row: string;
  readonly provider: string;
  /** kind subscription·acp-device 행의 창 실측. */
  readonly window?: SubscriptionWindowState;
  /** kind credit 행의 잔액(CC-1). */
  readonly balance?: CreditBalanceState;
  /** kind credit 행의 자동 충전(CC-1). */
  readonly autoTopUp?: AutoTopUpState;
  /** kind credit 행의 지출 실측(일·월) — spendCap 판정. */
  readonly spend?: CreditSpendState;
  /** kind acp-device 행의 장치 헬스·동시 세션 수. */
  readonly device?: AcpDeviceHealthState;
  /** 이 행 자격의 금고 임대(id·TTL 만). */
  readonly lease?: VaultLeaseState;
}

// ── 정책 문서(«정책 한 장» — 계정·공급자마다 한 행) ─────────────────────────────

export type LlmSpendRowKind = 'subscription' | 'credit' | 'acp-device';

/** 구독 행 — 창·상한·소진 순서. capPct 범위 0..100(0 = 못 씀). */
export interface SubscriptionRowPolicy {
  readonly kind: 'subscription';
  readonly provider: string;
  /** 금고 항목 «이름» 만(값 0). 없으면 임대를 못 받아 실행 불가 — 이름은 GUARD 칸이 채운다. */
  readonly vault?: string;
  /** 창 길이·리셋 시각 — 실측 칼럼(없어도 판정은 주입 상태로 한다). */
  readonly window?: SubscriptionWindowColumn;
  readonly capPct: number;
  /** 소진 시 순서: 다른 행 키 → … → 'stop'. 없으면 fallbackOrder 의 나머지를 걷는다. */
  readonly onExhausted: readonly (string | 'stop')[];
}

/** 유료 크레딧 행 — 모델 허용 목록·지출 상한. spendCap 빠짐/0 = 크레딧 0(fail-closed). */
export interface CreditRowPolicy {
  readonly kind: 'credit';
  readonly provider: string;
  readonly vault?: string;
  readonly models: readonly string[];
  readonly spendCap: { readonly dailyUsd?: number; readonly monthlyUsd?: number };
  /** 실측 스냅샷(CC-1 꼴) — 공급자 API 읽기 칸이 갱신한다. 판정은 «주입 상태» 를 쓴다. */
  readonly autoTopUp?: AutoTopUpState;
}

/** ACP 장치 행(claude-acp 등) — 호스트 레인 전용·구독 상한(기존 claude-acp 상한 85 관례). */
export interface AcpDeviceRowPolicy {
  readonly kind: 'acp-device';
  readonly provider: string;
  readonly vault?: string;
  /** Pod 실행이면 제외된다. 기본 true(claude-acp 는 host 만 · Pod 불가 — 기존 규칙). */
  readonly hostOnly: boolean;
  /** 동시 세션 상한(정수 ≥1). 없으면 상한 검사 없음. */
  readonly maxSessions?: number;
  readonly capPct: number;
  readonly window?: SubscriptionWindowColumn;
  readonly onExhausted: readonly (string | 'stop')[];
}

export type LlmSpendRowPolicy = SubscriptionRowPolicy | CreditRowPolicy | AcpDeviceRowPolicy;

/** 역할 절 한 행 — 선호 모델 목록(순서)·크레딧 감수 여부·금지 목록. creditOk 빠짐 = false(fail-closed). */
export type LlmSpendDifficulty = 'high' | 'mid' | 'low';
export const LLM_SPEND_DIFFICULTIES: readonly LlmSpendDifficulty[] = ['high', 'mid', 'low'];

export interface LlmSpendRolePolicy {
  readonly prefer: readonly string[];
  /** 난이도 등급별 선호 목록(대표 11-17 «소총 일에 탱크 금지») — 요청 난이도의 목록이 있으면 prefer 를 대신한다. */
  readonly difficulty?: Readonly<Partial<Record<LlmSpendDifficulty, readonly string[]>>>;
  /** 이 역할의 크레딧 몫(전역 spendCap 안) — 넘으면 이 역할은 크레딧 불가. 빠짐 = 전역 상한만. */
  readonly creditSpendCap?: { readonly dailyUsd?: number; readonly monthlyUsd?: number };
  readonly creditOk: boolean;
  /** 금지 모델 패턴(대소문자 무시 부분 일치) — 코드 상수(llm-spend-decision CODE_DENY_RULES)와 «이중» 으로 검사. */
  readonly deny: readonly string[];
}

/** 정책 문서 전체. YAML 저장 형식 = schema.ts 의 검증기가 이 모양 그대로만 받는다. */
export interface LlmSpendPolicyDoc {
  readonly version: 1;
  /** 행 키(계정·공급자 행 id) → 한 행. */
  readonly providers: Readonly<Record<string, LlmSpendRowPolicy>>;
  /** 전역 순서: 구독(창 남은 것·capPct 아래) → 다음 구독 → 크레딧(spendCap 아래·models 일치). */
  readonly fallbackOrder: readonly string[];
  /** 구독 창 리셋 실측 → 다음 호출부터 다시 구독 우선. */
  readonly returnOnReset: boolean;
  readonly roles: Readonly<Partial<Record<LlmSpendPolicyRole, LlmSpendRolePolicy>>>;
  /** 소진 속도 이동 순서 — 리셋 전 capPct 도달이 예상되면 «앞» 역할부터 다음 후보로 뺀다. 이동 순서도 YAML. */
  readonly shiftOrder: readonly LlmSpendPolicyRole[];
}

export type LlmSpendPolicySource = 'default' | 'stored';

export interface LlmSpendPolicyValidation {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

// ── 전환 원장(C · 결정·전환·되돌아오기 각 1줄) ─────────────────────────────────

/** observe = 정책 없는 우주의 통과 기록 · 합성 사건 주입 기록(결정이 아닌 «관측» 줄). */
export type LlmSpendLedgerAction = 'decision' | 'switch' | 'return' | 'observe';

/** 원장 한 줄 — 누가(actor)·무엇(what: 행)·이전→이후(from→to)·사유(reason)·시각(at). */
export interface LlmSpendLedgerEntry {
  readonly at: string;
  readonly actor: string;
  readonly action: LlmSpendLedgerAction;
  readonly what: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly reason: string;
  /** 합성 사건 주입(eln llm policy inject)이 쓴 줄 — true 만 허용(표시 없이 합성을 쓰는 경로 0). */
  readonly synthetic?: true;
}
