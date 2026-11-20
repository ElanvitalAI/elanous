// LLM 호출 관문 어댑터 — «정책 읽기 → 상태 수집 → runLlmSpendGuard → 결과» 와 «호출 뒤 정산(settle)» 두 함수.
// (LLM-AUTO-PROVIDER-E2E · 배선 준비 E)
//
// 실경로 연결은 llm-call-live.ts(streamLLM 합류점). 대표 켜짐은 «데이터 유무»: 정책 정본이 없으면 pass-through(지금 동작 그대로 · 원장 observe 1줄),
//   있으면 가드 적용, 있는데 깨졌으면 멈춤(policy-unreadable). 깃발·env 스위치 0 — 되돌림 = 정책 파일 제거.
//   배선 지점·위험은 seat-state/HAND-ELN-ELS-API/evidence/llm-wire-map.md 참조.
// ⛔ 결정은 decideLlmSpend 한 곳(가드가 부른다). 여기는 «주입 받은 것을 이어 붙이는» 얇은 껍질 — 정책 저장소·관측기·원장·시계·기록 슬롯 전부 주입.
// ⛔ 비밀 0: 행 이름·사유·시각·금액만 다룬다. 관측기·기록 슬롯이 throw 해도 호출 경로로 예외가 새지 않는다(관측 실패 = 모름 = 그 행 불가).

import { debug } from '../debug/log.js';
import type {
  LlmSpendDifficulty, LlmSpendLedgerEntry, LlmSpendPolicyDoc, LlmSpendPolicyRole, LlmSpendRowState,
} from '../nexus/llm-spend-policy/types.js';
import { readAppliedSpendPolicy, readStoredSpendPolicy } from '../nexus/llm-spend-policy/store.js';
import { mergeRowStates } from '../nexus/llm-spend-policy/credit-adapter.js';
import { runLlmSpendGuard, type GuardMemoryStore, type SpendReservationHandle } from './llm-spend-guard.js';
import type { LlmSpendSkippedRow } from './llm-spend-decision.js';
import type { SpendReservationLedger } from './llm-spend-reservation.js';

/** 행 상태 관측기 — 구독 창·크레딧 잔액·ACP 헬스·임대 등 «한 가지 관측» 을 행 상태 배열로 낸다. throw = 그 관측 없음(모름). */
export type RowStateObserver = () => readonly LlmSpendRowState[] | Promise<readonly LlmSpendRowState[]>;

export interface LlmCallGateRequest {
  readonly role: LlmSpendPolicyRole;
  readonly difficulty?: LlmSpendDifficulty;
  readonly location: 'host' | 'pod';
  /** 후보 모델(앞이 우선). 비면 모델 조건 없이 판정. 둘 이상이면 앞에서부터 «멈춤이 아닌» 첫 결정을 쓴다. */
  readonly models?: readonly string[];
  /** 이 호출의 추정 지출(USD). 크레딧 행은 유한·0 이상이어야 통과(아니면 크레딧 거부). */
  readonly estimateUsd?: number;
  /** 호출 태그용 자리(seat) 이름 — 판정에는 쓰지 않고 settle 의 사용량 태그로만 간다. */
  readonly seat?: string;
  /** 원장 «누가». 없으면 seat · 없으면 role. */
  readonly actor?: string;
}

/** 호출 한 건의 태그 — `eln usage runs` 의 role·자리 축이 none 으로 뭉개지지 않게 호출마다 남기는 칸(OP #109959). */
export interface LlmCallTag {
  readonly callId: string;
  readonly at: string;
  readonly role: LlmSpendPolicyRole;
  readonly seat: string | null;
  readonly row: string;
  readonly provider: string;
  readonly model: string;
  readonly status: LlmCallOutcomeStatus;
  readonly usd: number | null;
}

export interface LlmSpendRecord {
  readonly callId: string;
  readonly at: string;
  readonly row: string;
  readonly role: LlmSpendPolicyRole;
  readonly usd: number;
}

export interface LlmCallGateDeps {
  /**
   * 정책 읽기 — 기본은 정책 저장소(readPolicyFromStore). 대표 켜짐은 «데이터 유무»:
   *   null = 이 우주에 정책 파일 없음 → 관문 통과(pass-through · 지금 동작 그대로) · 문서 = 관문 적용 ·
   *   throw = 정책이 «있는데» 못 읽음·깨짐 → 멈춤(fail-closed · policy-unreadable).
   */
  readonly readPolicy?: () => Promise<LlmSpendPolicyDoc | null>;
  /** 상태 관측기들 — 결과를 행 단위로 병합(뒤가 앞을 덮는다). */
  readonly observers: readonly RowStateObserver[];
  readonly memory: GuardMemoryStore;
  readonly appendLedger: (entry: LlmSpendLedgerEntry) => void | Promise<void>;
  readonly now: () => Date;
  readonly reservations?: SpendReservationLedger;
  readonly newReservationId?: () => string;
  /** 호출 id 생성(시험 주입). */
  readonly newCallId?: () => string;
  /** settle 이 지출을 남기는 슬롯(크레딧 행 · 호출이 일어난 경우만). */
  readonly recordSpend?: (record: LlmSpendRecord) => void | Promise<void>;
  /** settle 이 호출 태그를 남기는 usage 기록 슬롯. */
  readonly recordUsageTag?: (tag: LlmCallTag) => void | Promise<void>;
  /** settle 이 «실제 신호»(429 usage_limit_reached · 402)를 관측 저장소에 남기는 슬롯. */
  readonly recordSignal?: (record: LlmSignalRecord) => void | Promise<void>;
}

/** 호출 결과에서 읽은 «실제 소진 신호». */
export type LlmCallSignal =
  | { readonly kind: 'usage_limit_reached'; readonly resetsAt?: string }
  | { readonly kind: 'insufficient_credits' };

export interface LlmSignalRecord {
  readonly callId: string;
  readonly at: string;
  readonly row: string;
  readonly provider: string;
  readonly signal: LlmCallSignal;
}

export interface LlmCallHandle {
  readonly callId: string;
  readonly row: string;
  readonly provider: string;
  readonly model: string;
  readonly role: LlmSpendPolicyRole;
  readonly seat: string | null;
  readonly estimateUsd: number | null;
  readonly reservation: SpendReservationHandle | null;
  readonly settleDeps: Pick<LlmCallGateDeps, 'now' | 'recordSpend' | 'recordUsageTag' | 'recordSignal'>;
}

export type LlmCallGateResult =
  | {
    readonly outcome: 'go';
    readonly row: string;
    readonly provider: string;
    readonly model: string;
    readonly reservation: SpendReservationHandle | null;
    readonly ledgerLines: readonly LlmSpendLedgerEntry[];
    readonly skipped: readonly LlmSpendSkippedRow[];
    readonly handle: LlmCallHandle;
  }
  | {
    /** 정책 파일 없는 우주 — 선택 행 없음 · 기존 선택을 건드리지 않는다(원장 observe 1줄만). */
    readonly outcome: 'pass-through';
    readonly ledgerLines: readonly LlmSpendLedgerEntry[];
    readonly skipped: readonly LlmSpendSkippedRow[];
  }
  | {
    readonly outcome: 'stop';
    readonly reason: string;
    readonly ledgerLines: readonly LlmSpendLedgerEntry[];
    readonly skipped: readonly LlmSpendSkippedRow[];
  };

let callSeq = 0;

async function collectStates(observers: readonly RowStateObserver[]): Promise<LlmSpendRowState[]> {
  let merged: LlmSpendRowState[] = [];
  for (const observe of observers) {
    try { merged = mergeRowStates(merged, await observe()); } catch { /* 관측 실패 = 모름 — 그 칸은 비어 있고 결정 함수가 그 행을 fail-closed 로 건너뛴다 */ }
  }
  return merged;
}

/**
 * 기본 정책 읽기 — 정책 정본(policy.yaml) 유무가 «켜짐»이다.
 *   없음 → null · 있음+유효(정본 또는 마지막 정상 사본) → 적용 정책 · 있음+깨짐·병합 오류 → throw(fail-closed).
 */
export async function readPolicyFromStore(dir?: string): Promise<LlmSpendPolicyDoc | null> {
  const opts = dir !== undefined ? { dir } : {};
  const stored = await readStoredSpendPolicy(dir);
  if (!stored.present) return null;
  if (!stored.valid) throw new Error(`정책 정본이 있으나 무효: ${stored.errors.join(' · ') || '(검증 실패)'}`);
  const view = await readAppliedSpendPolicy(opts);
  if (view.overlayErrors.length > 0) throw new Error(`정책 병합 오류: ${view.overlayErrors.join(' · ')}`);
  return view.policy;
}

/** 호출 오류에서 «실제 소진 신호» 를 읽는다 — 429 usage_limit_reached(resetsAt) · 402. 아니면 undefined. */
export function llmSignalFromError(err: unknown): LlmCallSignal | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown; resetsAt?: unknown; resets_at?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (status === 402) return { kind: 'insufficient_credits' };
  if (status === 429 && /usage_limit_reached/.test(message)) {
    let resetsAt: string | undefined;
    const direct = e?.resetsAt ?? e?.resets_at;
    const fromMsg = /"?resets?_?[aA]t"?\s*[:=]\s*"?([0-9T:.\-+Z]+)"?/.exec(message)?.[1];
    const raw = direct ?? fromMsg;
    if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) {
      const n = Number(raw);
      const ms = n < 1e12 ? n * 1000 : n; // 초 단위 epoch 도 받는다
      if (Number.isFinite(ms)) resetsAt = new Date(ms).toISOString();
    } else if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) resetsAt = new Date(raw).toISOString();
    return { kind: 'usage_limit_reached', ...(resetsAt !== undefined ? { resetsAt } : {}) };
  }
  return undefined;
}

let stopSeq = 0;

/** 결정 근거 상태 중 합성(synthetic) 실측이 하나라도 있나 — 시험 우주 합성 입력으로 낸 결정을 운영 결정과 구분하는 표지. */
function usedSynthetic(states: readonly LlmSpendRowState[]): boolean {
  return states.some((s) => [s.window, s.balance, s.spend, s.autoTopUp, s.device].some((x) => (x as { source?: string } | undefined)?.source === 'synthetic'));
}

/**
 * 결정 1건 = logs.db 이벤트 1줄(category `llm-gate` · event `decision`). 정책이 있는 우주의 go/stop 만(pass-through 는 원장 observe 가 따로 있다).
 * ⛔ 비밀 0: 허용 목록 필드(runId·decision·provider·row·synthetic·reason 코드)만 — 사유 «전문»(오류 메시지 포함)·lease id·actor·seat 는 싣지 않는다.
 * ⛔ 로그 실패는 여기서 삼킨다 — 결정(go/stop)을 바꾸거나 던지지 않는다.
 */
function logGateDecision(result: LlmCallGateResult, states: readonly LlmSpendRowState[], now: () => Date): void {
  if (result.outcome === 'pass-through') return;
  try {
    const go = result.outcome === 'go';
    const reasonCode = go ? 'choice' : (/^[a-z][a-z0-9-]*/.exec(result.reason)?.[0] ?? 'stop');
    debug.log('llm-gate', 'decision', {
      runId: go ? result.handle.callId : `stop-${now().getTime()}-${++stopSeq}`,
      decision: go ? 'chosen' : 'stop',
      provider: go ? result.provider : null,
      row: go ? result.row : null,
      // 건너뛴 행의 합성 입력이 선택을 바꿨어도 표지(#39238 합성 영수에서 드러난 결함) — 고려한 전 행을 본다.
      synthetic: usedSynthetic(states),
      reason: reasonCode,
    });
  } catch { /* 로그 실패 = 모름 — 결정은 그대로 */ }
}

/** 호출 «전» 관문 — 어느 행(공급자·계정)으로 갈지, 또는 멈출지. 결정마다 logs.db 이벤트 1줄. */
export async function gateLlmCall(request: LlmCallGateRequest, deps: LlmCallGateDeps): Promise<LlmCallGateResult> {
  const seen: { states: readonly LlmSpendRowState[] } = { states: [] };
  const result = await decideGate(request, deps, seen);
  logGateDecision(result, seen.states, deps.now);
  return result;
}

async function decideGate(request: LlmCallGateRequest, deps: LlmCallGateDeps, seen: { states: readonly LlmSpendRowState[] }): Promise<LlmCallGateResult> {
  const ledgerLines: LlmSpendLedgerEntry[] = [];
  let policy: LlmSpendPolicyDoc | null;
  try { policy = await (deps.readPolicy ?? readPolicyFromStore)(); } catch (error) {
    const reason = `policy-unreadable(정책 저장소를 못 읽음 — fail-closed 멈춤): ${error instanceof Error ? error.message : String(error)}`;
    const entry: LlmSpendLedgerEntry = { at: deps.now().toISOString(), actor: request.actor ?? request.seat ?? request.role, action: 'decision', what: 'stop', from: null, to: null, reason };
    try { await deps.appendLedger(entry); ledgerLines.push(entry); } catch { /* 원장 실패도 멈춤은 그대로 */ }
    return { outcome: 'stop', reason, ledgerLines, skipped: [] };
  }
  if (policy === null) {
    const entry: LlmSpendLedgerEntry = {
      at: deps.now().toISOString(), actor: request.actor ?? request.seat ?? request.role, action: 'observe', what: 'pass-through', from: null, to: null,
      reason: 'policy-absent(정책 정본 없음 — 관문 통과 · 선택 행 없음 · 원장만 기록)',
    };
    try { await deps.appendLedger(entry); ledgerLines.push(entry); } catch { /* 기록 실패가 기존 호출을 막지 않는다(켜짐 전 = 지금 동작 그대로) */ }
    return { outcome: 'pass-through', ledgerLines, skipped: [] };
  }
  const states = await collectStates(deps.observers);
  seen.states = states;
  const guardDeps = {
    policy, memory: deps.memory, now: deps.now,
    readStates: () => states,
    appendLedger: async (entry: LlmSpendLedgerEntry) => { await deps.appendLedger(entry); ledgerLines.push(entry); },
    ...(deps.reservations ? { reservations: deps.reservations } : {}),
    ...(deps.newReservationId ? { newReservationId: deps.newReservationId } : {}),
  };
  const candidates: (string | undefined)[] = request.models && request.models.length > 0 ? [...request.models] : [undefined];
  let last: Awaited<ReturnType<typeof runLlmSpendGuard>> | undefined;
  for (const model of candidates) {
    const result = await runLlmSpendGuard(guardDeps, {
      role: request.role, execLocation: request.location,
      ...(request.difficulty !== undefined ? { difficulty: request.difficulty } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(request.estimateUsd !== undefined ? { estimateUsd: request.estimateUsd } : {}),
      actor: request.actor ?? request.seat ?? request.role,
    });
    last = result;
    const { decision } = result;
    if (decision.outcome === 'choice') {
      const providerRow = policy.providers[decision.row];
      const provider = providerRow?.provider ?? decision.row;
      const callId = deps.newCallId?.() ?? `call-${deps.now().getTime()}-${++callSeq}`;
      const handle: LlmCallHandle = {
        callId, row: decision.row, provider, model: decision.model, role: request.role, seat: request.seat ?? null,
        estimateUsd: request.estimateUsd ?? null, reservation: result.reservation ?? null,
        settleDeps: { now: deps.now, ...(deps.recordSpend ? { recordSpend: deps.recordSpend } : {}), ...(deps.recordUsageTag ? { recordUsageTag: deps.recordUsageTag } : {}), ...(deps.recordSignal ? { recordSignal: deps.recordSignal } : {}) },
      };
      return { outcome: 'go', row: decision.row, provider, model: decision.model, reservation: result.reservation ?? null, ledgerLines, skipped: decision.skipped, handle };
    }
  }
  const stop = last!.decision;
  return { outcome: 'stop', reason: stop.reason, ledgerLines, skipped: stop.skipped };
}

export type LlmCallOutcomeStatus = 'ok' | 'failed' | 'not-called';

export interface LlmCallOutcome {
  /** ok = 호출 성공 · failed = 호출했으나 실패(과금됐을 수 있다) · not-called = 호출 자체가 일어나지 않았다. */
  readonly status: LlmCallOutcomeStatus;
  /** 실제 지출(USD) — 모르면 생략(추정액으로 확정한다 · 과소 계상 0). */
  readonly actualUsd?: number;
  /** 호출 결과가 알려 준 «실제 소진 신호»(429 usage_limit_reached · 402) — 그 행 창/잔액을 소진으로 관측 저장소에 남긴다. */
  readonly signal?: LlmCallSignal;
}

export interface LlmCallSettlement {
  readonly committed: boolean;
  readonly released: boolean;
  readonly spendRecorded: boolean;
  readonly tagRecorded: boolean;
  readonly signalRecorded?: boolean;
  readonly errors: readonly string[];
}

/**
 * 호출 «뒤» 정산 — 예약 commit/release · 지출 기록(크레딧 행) · 호출 태그(role·seat) 기록. 어떤 슬롯이 throw 해도 예외를 밖으로 내지 않는다.
 *   not-called → release(추정액 반환) · ok/failed → commit(actualUsd ?? 추정액 — 모르면 «쓴 것으로» 본다).
 */
export async function settleLlmCall(handle: LlmCallHandle, outcome: LlmCallOutcome): Promise<LlmCallSettlement> {
  const errors: string[] = [];
  const at = handle.settleDeps.now().toISOString();
  let committed = false;
  let released = false;
  let spendRecorded = false;
  let tagRecorded = false;
  const usd = outcome.status === 'not-called' ? null
    : outcome.actualUsd !== undefined && Number.isFinite(outcome.actualUsd) && outcome.actualUsd >= 0 ? outcome.actualUsd
      : handle.estimateUsd;
  if (handle.reservation) {
    try {
      if (outcome.status === 'not-called') released = handle.reservation.release();
      else committed = handle.reservation.commit(usd ?? handle.reservation.estimateUsd);
    } catch (error) { errors.push(`reservation: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (handle.reservation && usd !== null && outcome.status !== 'not-called' && handle.settleDeps.recordSpend) {
    try { await handle.settleDeps.recordSpend({ callId: handle.callId, at, row: handle.row, role: handle.role, usd }); spendRecorded = true; } catch (error) {
      errors.push(`recordSpend: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (handle.settleDeps.recordUsageTag) {
    try {
      await handle.settleDeps.recordUsageTag({
        callId: handle.callId, at, role: handle.role, seat: handle.seat, row: handle.row, provider: handle.provider,
        model: handle.model, status: outcome.status, usd,
      });
      tagRecorded = true;
    } catch (error) { errors.push(`recordUsageTag: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let signalRecorded = false;
  if (outcome.signal && handle.settleDeps.recordSignal) {
    try { await handle.settleDeps.recordSignal({ callId: handle.callId, at, row: handle.row, provider: handle.provider, signal: outcome.signal }); signalRecorded = true; } catch (error) {
      errors.push(`recordSignal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { committed, released, spendRecorded, tagRecorded, ...(outcome.signal ? { signalRecorded } : {}), errors };
}
