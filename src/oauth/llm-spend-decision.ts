// LLM 지출 결정 함수 «한 곳» — 공급자 일반화 한 층 (LLM-SPEND-POLICY-ONE-SHOT · 0.3.31)
//
// ⛔⭐ 자리(OP #107857): 이 함수는 `resolveCodexAccountForRun`(src/oauth/codex-account-store.ts) 위의
//   «공급자 일반화 한 층» 이다 — codex 계정 하나를 고르던 자리가, 계정·공급자 «행» 전부를 같은 규칙으로 걷는다.
//   순수 함수다: 파일·네트워크·시계·자격 읽기가 전혀 없다. 정책(LlmSpendPolicyDoc)과 실측 상태
//   (LlmSpendRowState[])와 요청만 받아 {choice|stop · 사유 · 원장 줄} 을 낸다.
//
// ⛔ 이 PR(ONE-SHOT)은 «배선하지 않는다». 실배선은 후속 칸들이다:
//   · CODEX-SUBSCRIPTION-CREDIT-GUARD: codex provider 의 회전 주입점(src/llm.ts makeCodexProvider →
//     src/oauth/codex.ts:479/543 resolveCodexAccountForRun 호출부)이 이 함수를 먼저 지나게 한다 —
//     이 결정이 고른 «행» 이 그 아래 계정 해석을 이긴다.
//   · 공급자 상태 주입: 쿼터 신호(구독 창 usedPct) · CC-1 readOpenRouterCredit(잔액·자동 충전 · #107882) ·
//     지출 원장(일·월 사용) 칸들이 LlmSpendRowState[] 를 만들어 넣는다.
//   · 정책 수급: 실행 자리는 넥서스에서 «정책 + 금고 임대»를 함께 받는다(#107839) —
//     넥서스 안 닿으면 마지막 정상 정책 + 남은 임대만, 새 임대 0 = fail-closed.
//   · 원장: 반환된 `ledger` 줄을 호출자가 appendSpendTransition(src/nexus/llm-spend-policy/ledger.ts)로
//     한 줄 남긴다(결정·전환·되돌아오기 각 1줄).
//   · secret supply: 결정이 고른 행의 vault «이름» 으로 금고에서 임대를 받는다(값은 여기에 오지 않는다).
//
// 결정 규칙(지시서 B · 대표 07:2x~07:5x):
//   1. fallbackOrder 걷기 — 구독(창 남음·capPct 아래) → 다음 구독 → 크레딧(spendCap 아래·models 일치).
//      구독 행이 소진됐으면 그 행의 onExhausted 순서를 먼저 걷는다(끝의 'stop' = 멈춤).
//   2. 역할 creditOk=false(빠짐도 false)면 크레딧 행을 쓰지 않는다(멈춤+사유).
//   3. deny 는 절대 — YAML roles.deny 와 코드 상수(CODE_DENY_RULES)를 «이중» 으로 넘지 않는다.
//   4. hostOnly(ACP) 장치는 Pod 실행이면 제외된다.
//   5. returnOnReset — 구독 창이 리셋 실측으로 다시 쓸 수 있게 되돌아오면 다음 호출부터 구독 우선.
//   6. fail-closed — spendCap 빠짐/0 = 그 공급자 크레딧 0 · creditOk 빠짐 = false · 임대 만료/없음 = 그 행
//      불가(새 임대 0 = 멈춤) · 창·잔액·지출 unmeasured = 못 쓴다(«모른다»를 «비었다»로 접지 않는다 —
//      OBS-T188) · 로컬 자격 폴백 0(이 함수는 자격을 만지지도 않는다).

import type {
  LlmSpendDifficulty, LlmSpendLedgerEntry, LlmSpendPolicyDoc, LlmSpendPolicyRole, LlmSpendRowPolicy,
  LlmSpendRowState, SubscriptionWindowState, VaultLeaseState,
} from '../nexus/llm-spend-policy/types.js';
import { resolveSpendRolePolicy } from '../nexus/llm-spend-policy/schema.js';

// ── 코드 상수 deny(YAML deny 와 «별도» 이중 — OP #107857/JUD ②) ───────────────────

export interface LlmSpendCodeDenyRule {
  readonly role: LlmSpendPolicyRole | '*';
  readonly modelIncludes: string;
  readonly why: string;
}

/** 고정 금지 규칙 — YAML 을 고쳐도 «코드가 한 번 더» 막는다(예: 리뷰 GLM 금지 · #38337 계열). */
export const CODE_DENY_RULES: readonly LlmSpendCodeDenyRule[] = [
  { role: 'review', modelIncludes: 'glm', why: '리뷰 GLM 금지(코드 상수)' },
];

function codeDenyHit(role: LlmSpendPolicyRole | undefined, model: string): string | null {
  if (!model) return null;
  for (const rule of CODE_DENY_RULES) {
    if (rule.role !== '*' && rule.role !== role) continue;
    if (model.toLowerCase().includes(rule.modelIncludes.toLowerCase())) return `${rule.why}: ${rule.modelIncludes}`;
  }
  return null;
}

// ── 되돌아오기 히스테리시스(LLM-RETURN-ON-WINDOW-RESET) ─────────────────────────

/**
 * 크레딧 행에서 구독으로 «되돌아오는» 문턱 여유(%p). 구독은 usedPct ≤ capPct − 이 값일 때만 복귀 후보다.
 * 이유: 구독이 capPct 바로 아래(예 94%/95%)라서 되돌아가자마자 다시 소진 → 크레딧 → 복귀 … 로 떠는(플래핑) 것을 막는다.
 * 창이 실제로 리셋되면 usedPct 는 ~0 이라 이 여유를 쉽게 통과한다. 나가는 쪽 문턱(capPct)은 그대로다.
 */
export const RETURN_HYSTERESIS_PCT = 10;

// ── 요청·결과 ─────────────────────────────────────────────────────────────────

export interface LlmSpendDecisionRequest {
  /** 지출 정책 역할(review·judgement·…) — 역할 절의 creditOk·deny·prefer 가 적용된다. */
  readonly role?: LlmSpendPolicyRole;
  /** 난이도 등급(상·중·하) — 역할 절 difficulty 목록이 있으면 prefer 대신 쓴다(소총 일에 탱크 금지). */
  readonly difficulty?: LlmSpendDifficulty;
  /** 요청 모델 — 주어지면 크레딧 행의 models 일치 검사에 쓴다(없으면 역할 prefer 순). */
  readonly model?: string;
  /** 실행 위치 — Pod 면 hostOnly 장치가 제외된다. */
  readonly execLocation: 'host' | 'pod';
  /** 이 런이 직전까지 쓰던 행 — 전환/되돌아오기 판정의 기준(undefined = 첫 결정). */
  readonly currentRow?: string;
  /** 주입 시계(시험) — 실배선 때는 넣지 않는다. */
  readonly now?: Date;
  /** 원장 «누가» — 호출자 식별(자리·런 id). 없으면 role · 없으면 'system'. */
  readonly actor?: string;
  /** 되돌아오기 히스테리시스 여유(%p) 덮어쓰기(시험·정책 확장). 기본 RETURN_HYSTERESIS_PCT. */
  readonly returnHysteresisPct?: number;
  /** 이 호출의 추정 지출(USD) — 크레딧 행은 «실측+예약+추정 ≤ 상한» 일 때만 통과. 미지정 = 0(상한 «도달» 검사만). NaN·음수 = 크레딧 거부. */
  readonly estimateUsd?: number;
  /** 예약 원장 스냅샷(llm-spend-reservation.ts) — 같은 잔여 상한을 동시 호출이 둘 다 쓰지 못하게 실측에 더한다. */
  readonly reservations?: readonly SpendReservation[];
  /** 지출 실측 신선도 창(ms) 덮어쓰기. 기본 SPEND_OBSERVATION_MAX_AGE_MS. */
  readonly spendMaxAgeMs?: number;
}

export interface LlmSpendSkippedRow {
  readonly row: string;
  readonly why: string;
}

export type LlmSpendDecision =
  | {
    readonly outcome: 'choice';
    readonly row: string;
    readonly model: string;
    readonly switched: boolean;
    readonly reason: string;
    readonly ledger: LlmSpendLedgerEntry;
    /** 걷는 길에 건너뛴 행과 사유(관측 — «왜 이 행인가»의 근거). */
    readonly skipped: readonly LlmSpendSkippedRow[];
  }
  | {
    readonly outcome: 'stop';
    readonly reason: string;
    readonly skipped: readonly LlmSpendSkippedRow[];
    readonly ledger: LlmSpendLedgerEntry;
  };

// ── 소진 속도(기울기 %/h) → 리셋 전 capPct 도달 예상 → 역할 이동 ──────────────────

export interface BurnProjection {
  /** capPct 도달 예상까지 남은 시간(h) — 이미 도달이면 0. */
  readonly hoursToCap: number;
  /** 리셋까지 남은 시간(h). */
  readonly hoursToReset: number;
  readonly reachesCapBeforeReset: boolean;
  readonly projectedCapAt: string;
}

/** 실측 기울기·리셋(ISO)이 모두 있을 때만 계산한다 — 하나라도 «모름»이면 null(이동 0 · fail-closed 가 아니라 «판정 보류»). */
export function projectBurn(row: LlmSpendRowPolicy, state: LlmSpendRowState | undefined, now: Date): BurnProjection | null {
  if (row.kind === 'credit') return null;
  const window = state?.window;
  if (!window || window.status !== 'measured') return null;
  const slope = window.slopePctPerHour;
  if (slope === undefined || !Number.isFinite(slope) || slope <= 0) return null;
  const resetMs = window.resetAt === undefined ? NaN : Date.parse(window.resetAt);
  if (!Number.isFinite(resetMs)) return null;
  const hoursToReset = (resetMs - now.getTime()) / 3_600_000;
  if (hoursToReset <= 0) return null;
  const hoursToCap = Math.max((row.capPct - window.usedPct) / slope, 0);
  return {
    hoursToCap, hoursToReset,
    reachesCapBeforeReset: hoursToCap < hoursToReset,
    projectedCapAt: new Date(now.getTime() + hoursToCap * 3_600_000).toISOString(),
  };
}

/**
 * 이 구독 행에서 «빠져야 하는» 역할들 — shiftOrder 앞에서부터.
 * 도달 예상이 리셋보다 이르면 1개 · 남은 시간의 절반보다 이르면 2개 · 4분의 1보다 이르면 3개(순서 목록 끝까지).
 * 리셋되면(상태가 다시 낮아지면) 자연히 빈 목록 = 원래 배합 복귀.
 */
export function rolesShiftedOffRow(policy: LlmSpendPolicyDoc, row: LlmSpendRowPolicy, state: LlmSpendRowState | undefined, now: Date): readonly LlmSpendPolicyRole[] {
  const burn = projectBurn(row, state, now);
  if (!burn || !burn.reachesCapBeforeReset) return [];
  const ratio = burn.hoursToCap / burn.hoursToReset;
  const count = ratio < 0.25 ? 3 : ratio < 0.5 ? 2 : 1;
  return policy.shiftOrder.slice(0, count);
}

// ── 행 게이트(kind별) — 반환은 [통과?, 사유] ───────────────────────────────────

function leaseWhy(state: LlmSpendRowState | undefined, now: Date): string | null {
  const lease = state?.lease as VaultLeaseState | undefined;
  if (!lease) return 'no-lease(새 임대 0 = fail-closed · 넥서스에서 정책+임대를 함께 받아라)';
  if (lease.leaseId === null) return `no-lease:${lease.reason}`;
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt)) return 'lease-expiry-unreadable';
  if (expiresAt <= now.getTime()) return `lease-expired(${lease.expiresAt})`;
  return null;
}

function windowWhy(row: LlmSpendRowPolicy, state: LlmSpendRowState | undefined): string | null {
  const capPct = row.kind === 'subscription' || row.kind === 'acp-device' ? row.capPct : undefined;
  if (capPct === undefined) return null;
  const window = state?.window as SubscriptionWindowState | undefined;
  if (!window || window.status !== 'measured') {
    return `window-unmeasured(${window?.status === 'unmeasured' ? window.reason : '주입된 실측 없음'} — «모른다»를 «비었다»로 접지 않는다)`;
  }
  if (window.usedPct >= capPct) return `cap-pct-exhausted(${window.usedPct}% ≥ 상한 ${capPct}%)`;
  return null;
}

function deviceWhy(row: LlmSpendRowPolicy, state: LlmSpendRowState | undefined): string | null {
  if (row.kind !== 'acp-device') return null;
  const device = state?.device;
  if (!device || device.status !== 'measured') {
    return `device-health-unmeasured(${device?.status === 'unmeasured' ? device.reason : '주입된 헬스 실측 없음'} — 살아 있음을 모르면 다음 후보)`;
  }
  if (!device.alive) return 'device-health-failed(장치 헬스 실패 — 다음 후보)';
  if (row.maxSessions !== undefined && device.sessions >= row.maxSessions) {
    return `device-sessions-full(${device.sessions} ≥ 동시 세션 상한 ${row.maxSessions})`;
  }
  return null;
}

/** 지출 실측 신선도 창(ms) — 이보다 오래된(또는 미래인) observedAt 의 지출 실측은 «모름» 으로 본다(fail-closed). */
export const SPEND_OBSERVATION_MAX_AGE_MS = 15 * 60 * 1000; // 출처: #39172 JUD(msg 109296 must①) — 지출 실측 신선도 창 15분(코드 상수 · 호출자가 request.spendMaxAgeMs 로 좁힐 수 있다)
/** 실측 시계가 판정 시계보다 «앞서도» 되는 허용 오차(ms) — 그 이상 미래면 신뢰하지 않는다. */
export const SPEND_OBSERVATION_FUTURE_SKEW_MS = 60 * 1000; // 출처: #39172 JUD(msg 109296 must①) — 시계 오차 1분(코드 상수)

/** 예약 원장 한 건 — 크레딧 행 지출 «진행 중/막 확정» 몫. 결정 함수는 읽기만 한다(상태 저장은 llm-spend-reservation.ts). */
export interface SpendReservation {
  readonly id: string;
  readonly row: string;
  readonly role?: LlmSpendPolicyRole;
  /** reserved = 예약 중(추정액) · committed = 확정(actualUsd). */
  readonly state: 'reserved' | 'committed';
  readonly usd: number;
  readonly at: string;
  /** reserved 만료 시각(ISO) — 지나면 crash 로 남은 것으로 보고 원장이 snapshot 에서 뺀다. */
  readonly expiresAt?: string;
  /** committed 시각 — 지출 실측 observedAt 이 이보다 뒤면 실측이 이미 포함한 것으로 본다(이중 계산 방지). */
  readonly committedAt?: string;
}

/** 이 행의 «아직 실측에 안 들어온» 예약 합 — 순수. reserved 는 항상, committed 는 실측이 committedAt 이전일 때만. */
export function outstandingReservedUsd(
  reservations: readonly SpendReservation[], row: string, role: LlmSpendPolicyRole | undefined, spendObservedMs: number,
): { rowUsd: number; roleUsd: number } {
  let rowUsd = 0;
  let roleUsd = 0;
  for (const r of reservations) {
    if (r.row !== row && r.row !== '*') continue; // '*' = 못 읽은 원장 표식(모든 행에 적용 · fail-closed)
    if (!Number.isFinite(r.usd) || r.usd < 0) { rowUsd = Infinity; roleUsd = Infinity; continue; } // 깨진 원장 = 초과로 본다(fail-closed)
    if (r.state === 'committed') {
      const c = Date.parse(r.committedAt ?? '');
      if (Number.isFinite(c) && Number.isFinite(spendObservedMs) && spendObservedMs >= c) continue;
    }
    rowUsd += r.usd;
    if (role !== undefined && r.role === role) roleUsd += r.usd;
  }
  return { rowUsd, roleUsd };
}

const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

interface CreditCtx {
  readonly now: Date;
  readonly maxAgeMs: number;
  readonly estimateUsd: number;
  readonly reservations: readonly SpendReservation[];
}

function creditWhy(row: CreditRowView, rowKey: string, state: LlmSpendRowState | undefined, creditOk: boolean, roleCap: { dailyUsd?: number; monthlyUsd?: number } | undefined, role: LlmSpendPolicyRole | undefined, ctx: CreditCtx): string | null {
  if (!creditOk) return 'role-credit-not-ok(역할 creditOk=false — 크레딧 미사용)';
  const cap = row.spendCap;
  if (cap.dailyUsd === undefined && cap.monthlyUsd === undefined) {
    return 'spend-cap-missing(빠짐 = 그 공급자 크레딧 0 · fail-closed)';
  }
  if (cap.dailyUsd === 0 || cap.monthlyUsd === 0) return 'spend-cap-zero(0 = 크레딧 0 · fail-closed)';
  if (!usable(ctx.estimateUsd)) return 'estimate-invalid(요청 추정액이 유한한 0 이상 수가 아님 — fail-closed)';
  const spend = state?.spend;
  const observedMs = spend ? Date.parse(spend.observedAt) : NaN;
  if (!spend || !Number.isFinite(observedMs)) return 'spend-unmeasured(지출 실측 없음 또는 observedAt 없음 — 상한 검증 불가)';
  const ageMs = ctx.now.getTime() - observedMs;
  if (ageMs > ctx.maxAgeMs) return `spend-stale(지출 실측 ${Math.round(ageMs / 1000)}s 전 > 신선도 창 ${Math.round(ctx.maxAgeMs / 1000)}s — 낡은 값으로 통과 0)`;
  if (ageMs < -SPEND_OBSERVATION_FUTURE_SKEW_MS) return 'spend-stale(지출 실측 시각이 미래 — 신뢰 불가)';
  const held = outstandingReservedUsd(ctx.reservations, rowKey, role, observedMs);
  if (cap.dailyUsd !== undefined) {
    if (!usable(spend.todayUsd)) return `spend-unmeasured(today 지출 실측값이 유한 수가 아님: ${String(spend.todayUsd)} — 일 상한 검증 불가)`;
    const used = spend.todayUsd + held.rowUsd + ctx.estimateUsd;
    if (used > cap.dailyUsd || spend.todayUsd >= cap.dailyUsd) return `spend-cap-exceeded:today(${spend.todayUsd}+예약 ${held.rowUsd}+추정 ${ctx.estimateUsd} > ${cap.dailyUsd}USD)`;
  }
  if (cap.monthlyUsd !== undefined) {
    if (!usable(spend.monthUsd)) return `spend-unmeasured(month 지출 실측값이 유한 수가 아님: ${String(spend.monthUsd)} — 월 상한 검증 불가)`;
    const used = spend.monthUsd + held.rowUsd + ctx.estimateUsd;
    if (used > cap.monthlyUsd || spend.monthUsd >= cap.monthlyUsd) return `spend-cap-exceeded:month(${spend.monthUsd}+예약 ${held.rowUsd}+추정 ${ctx.estimateUsd} > ${cap.monthlyUsd}USD)`;
  }
  if (roleCap && (roleCap.dailyUsd !== undefined || roleCap.monthlyUsd !== undefined)) {
    const mine = role === undefined ? undefined : spend.byRole?.[role];
    if (!mine) return 'role-spend-unmeasured(역할 몫 지출 실측 없음 — creditSpendCap 검증 불가)';
    if (roleCap.dailyUsd !== undefined) {
      if (roleCap.dailyUsd === 0) return 'role-spend-cap-exceeded:today(역할 몫 0USD)';
      if (!usable(mine.todayUsd)) return `role-spend-unmeasured(역할 today 실측값이 유한 수가 아님: ${String(mine.todayUsd)})`;
      if (mine.todayUsd + held.roleUsd + ctx.estimateUsd > roleCap.dailyUsd || mine.todayUsd >= roleCap.dailyUsd) {
        return `role-spend-cap-exceeded:today(${mine.todayUsd}+예약 ${held.roleUsd}+추정 ${ctx.estimateUsd} > 역할 몫 ${roleCap.dailyUsd}USD)`;
      }
    }
    if (roleCap.monthlyUsd !== undefined) {
      if (roleCap.monthlyUsd === 0) return 'role-spend-cap-exceeded:month(역할 몫 0USD)';
      if (!usable(mine.monthUsd)) return `role-spend-unmeasured(역할 month 실측값이 유한 수가 아님: ${String(mine.monthUsd)})`;
      if (mine.monthUsd + held.roleUsd + ctx.estimateUsd > roleCap.monthlyUsd || mine.monthUsd >= roleCap.monthlyUsd) {
        return `role-spend-cap-exceeded:month(${mine.monthUsd}+예약 ${held.roleUsd}+추정 ${ctx.estimateUsd} > 역할 몫 ${roleCap.monthlyUsd}USD)`;
      }
    }
  }
  const balance = state?.balance;
  if (!balance || balance.status !== 'measured') {
    return `balance-unmeasured(${balance?.status === 'unmeasured' ? balance.reason : '주입된 실측 없음'})`;
  }
  if (!Number.isFinite(balance.usd)) return `balance-unmeasured(잔액 실측값이 유한 수가 아님: ${String(balance.usd)})`;
  if (balance.usd <= 0) return `balance-empty(${balance.usd}USD)`;
  if (balance.usd < held.rowUsd + ctx.estimateUsd) return `balance-insufficient(잔액 ${balance.usd} < 예약 ${held.rowUsd}+추정 ${ctx.estimateUsd}USD)`;
  return null;
}

type CreditRowView = Extract<LlmSpendRowPolicy, { kind: 'credit' }>;

/** 행이 이 요청에 쓸 모델 하나 — 못 쓰면 사유. (모델-공급자 «적합성» 사다리는 model-tier 칸 — 여기는 정책 게이트만.) */
function candidateModel(row: LlmSpendRowPolicy, prefer: readonly string[], requested: string): { model: string; whyNot?: string } {
  if (requested) {
    if (row.kind === 'credit' && !row.models.includes(requested)) {
      return { model: requested, whyNot: `model-mismatch(${requested} ∈ models 아님)` };
    }
    return { model: requested };
  }
  for (const model of prefer) {
    if (row.kind === 'credit' && !row.models.includes(model)) continue;
    return { model };
  }
  if (row.kind === 'credit') {
    if (row.models.length === 0) return { model: '', whyNot: 'models-empty(허용 모델 목록 없음)' };
    return { model: row.models[0]! };
  }
  return { model: '' };
}

// ── 결정 함수(순수) ────────────────────────────────────────────────────────────

/**
 * 정책 한 장 + 주입된 행 상태 + 요청으로 «이번 호출이 쓸 행» 하나를 고른다.
 * ⛔ 아무것도 못 고르면 stop — «멈춤» 도 결정이다(사유와 함께 원장 줄이 나온다).
 * ⛔ 이 함수는 정책·상태를 믿는다: 문서는 이미 검증기를 통과한 것만 넘겨라(스토어 참조).
 */
export function decideLlmSpend(
  policy: LlmSpendPolicyDoc,
  states: readonly LlmSpendRowState[],
  request: LlmSpendDecisionRequest,
): LlmSpendDecision {
  const now = request.now ?? new Date();
  const resolvedRole = resolveSpendRolePolicy(policy, request.role);
  const tiered = request.difficulty === undefined ? undefined : resolvedRole.difficulty?.[request.difficulty];
  const rolePolicy = tiered !== undefined && tiered.length > 0 ? { ...resolvedRole, prefer: tiered } : resolvedRole;
  const stateByRow = new Map(states.map((state) => [state.row, state]));
  const requestedModel = request.model?.trim() ?? '';
  const actor = request.actor ?? request.role ?? 'system';
  const at = now.toISOString();
  const skipped: LlmSpendSkippedRow[] = [];
  const creditCtx: CreditCtx = {
    now, maxAgeMs: request.spendMaxAgeMs ?? SPEND_OBSERVATION_MAX_AGE_MS,
    estimateUsd: request.estimateUsd ?? 0, reservations: request.reservations ?? [],
  };

  /** 행 게이트 전체 — 통과면 null, 아니면 사유. */
  const rowWhy = (rowKey: string): { model: string; why: string } | { model: string; ok: true } => {
    const row = policy.providers[rowKey];
    if (!row) return { model: '', why: 'unknown-row(정책에 없는 행 — 검증기가 이미 잡아야 한다)' };
    const state = stateByRow.get(rowKey);
    const candidate = candidateModel(row, rolePolicy.prefer, requestedModel);
    if (candidate.whyNot) return { model: candidate.model, why: candidate.whyNot };
    const model = candidate.model;
    for (const denied of rolePolicy.deny) {
      if (model && model.toLowerCase().includes(denied.toLowerCase())) {
        return { model, why: `deny:${denied}(YAML 역할 deny — 절대)` };
      }
    }
    const codeDenied = codeDenyHit(request.role, model);
    if (codeDenied) return { model, why: `deny:${codeDenied}(코드 상수 — 절대)` };
    if (row.kind === 'acp-device' && row.hostOnly && request.execLocation === 'pod') {
      return { model, why: 'host-only-device(ACP 장치는 Pod 실행에서 제외)' };
    }
    const lease = leaseWhy(state, now);
    if (lease) return { model, why: lease };
    if (row.kind === 'credit') {
      const why = creditWhy(row, rowKey, state, rolePolicy.creditOk, rolePolicy.creditSpendCap, request.role, creditCtx);
      if (why) return { model, why };
      return { model, ok: true };
    }
    const device = deviceWhy(row, state);
    if (device) return { model, why: device };
    const window = windowWhy(row, state);
    if (window) return { model, why: window };
    if (request.role !== undefined && rolesShiftedOffRow(policy, row, state, now).includes(request.role)) {
      const burn = projectBurn(row, state, now)!;
      return { model, why: `burn-shift(소진 기울기 → ${burn.projectedCapAt} 에 capPct 도달 예상 < 리셋까지 ${burn.hoursToReset.toFixed(1)}h · 역할 ${request.role} 이동)` };
    }
    return { model, ok: true };
  };

  const stop = (reason: string): LlmSpendDecision => ({
    outcome: 'stop',
    reason,
    skipped,
    ledger: { at, actor, action: 'decision', what: 'stop', from: request.currentRow ?? null, to: null, reason },
  });

  // ① 이전 행 상태 — 여전히 쓸 수 있으면 그대로(「이번 호출도 그 행」 — 전환 최소화).
  //    ⛔ 단, returnOnReset 이 켜져 있고 «크레딧 행» 을 쓰는 중이고 구독 창이 리셋 실측으로
  //    돌아왔다면 — 되돌아오기가 stay 보다 먼저다(크레딧은 돈이다).
  const hysteresisPct = request.returnHysteresisPct ?? RETURN_HYSTERESIS_PCT;
  const currentRow = request.currentRow;
  const currentPolicyRow = currentRow === undefined ? undefined : policy.providers[currentRow];
  const currentJudged = currentRow === undefined || !currentPolicyRow ? undefined : rowWhy(currentRow);
  const subscriptionBack = policy.returnOnReset && currentPolicyRow?.kind === 'credit'
    ? policy.fallbackOrder.find((rowKey) => {
      const row = policy.providers[rowKey];
      if (row === undefined || row.kind === 'credit' || !('ok' in rowWhy(rowKey))) return false;
      // 히스테리시스 — 게이트(< capPct)만으로는 부족하다: capPct − 여유 이하로 «충분히» 내려왔을 때만 복귀한다.
      const window = stateByRow.get(rowKey)?.window;
      return window?.status === 'measured' && window.usedPct <= row.capPct - hysteresisPct;
    })
    : undefined;
  if (currentJudged !== undefined) {
    if ('ok' in currentJudged && subscriptionBack === undefined) {
      return {
        outcome: 'choice',
        row: currentRow!,
        model: currentJudged.model,
        switched: false,
        reason: 'stay:게이트 통과(이전 행 유지)',
        ledger: { at, actor, action: 'decision', what: currentRow!, from: currentRow!, to: currentRow!, reason: 'stay:게이트 통과(이전 행 유지)' },
        skipped,
      };
    }
    if (!('ok' in currentJudged)) skipped.push({ row: currentRow!, why: currentJudged.why });
  }

  // ② 걷기 순서 — 소진된 구독 행의 onExhausted 우선, 아니면 전역 fallbackOrder.
  //     returnOnReset: 크레딧 행을 쓰고 있던 중 구독 창이 리셋 실측으로 돌아오면 처음부터(구독 우선).
  let walk: readonly (string | 'stop')[];
  const returnOnResetHit = subscriptionBack !== undefined;
  if (currentRow !== undefined && currentPolicyRow && (currentPolicyRow.kind === 'subscription' || currentPolicyRow.kind === 'acp-device')
    && currentPolicyRow.onExhausted.length > 0) {
    walk = currentPolicyRow.onExhausted;
  } else if (returnOnResetHit) {
    walk = [subscriptionBack!]; // 히스테리시스 통과한 첫 구독 행만(여유 안쪽 구독은 후보가 아니다)
  } else if (currentRow !== undefined && currentPolicyRow) {
    walk = policy.fallbackOrder.slice(Math.max(policy.fallbackOrder.indexOf(currentRow) + 1, 0));
  } else {
    walk = policy.fallbackOrder;
  }

  for (const entry of walk) {
    if (entry === 'stop') return stop(`on-exhausted-stop(${currentRow ?? ''} 소진 순서의 끝 — 멈춤이 정책이다)`);
    const judged = rowWhy(entry);
    if ('ok' in judged) {
      const switched = currentRow !== undefined && currentRow !== entry;
      const reason = returnOnResetHit ? 'return-on-reset(구독 창 리셋 실측 → 다시 구독 우선)' : switched ? 'switch(fallbackOrder 걷기)' : 'decision(fallbackOrder 걷기)';
      return {
        outcome: 'choice',
        row: entry,
        model: judged.model,
        switched,
        reason,
        ledger: {
          at, actor,
          action: returnOnResetHit ? 'return' : currentRow === undefined ? 'decision' : switched ? 'switch' : 'decision',
          what: entry,
          from: currentRow ?? null,
          to: entry,
          reason,
        },
        skipped,
      };
    }
    skipped.push({ row: entry, why: judged.why });
  }

  return stop(`no-candidate(걷는 순서 전부 불가 — ${skipped.map((s) => `${s.row}:${s.why}`).join(' · ') || '순서 비어 있음'})`);
}
