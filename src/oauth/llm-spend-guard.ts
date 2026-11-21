// LLM 지출 가드 — 구독 바닥 → onExhausted 순서 · 창 리셋 실측 → 구독 복귀 (0.3.31)
// CODEX-SUBSCRIPTION-CREDIT-GUARD + LLM-RETURN-ON-WINDOW-RESET
//
// ⛔⭐ 결정은 «한 곳» — `decideLlmSpend`(src/oauth/llm-spend-decision.ts) 만 판정한다. 이 파일은 그 결정 함수를
//   «부르는 얇은 껍질» 이다: ① 창 리셋 실측(리셋 시각 경과 · 사용률 하락)을 상태에 반영 ② 직전 행 기억 ③ 원장 한 줄.
//   새 결정 로직(순서 걷기·capPct·spendCap·models)은 여기 «없다». (플래핑 방지 히스테리시스는 결정 함수 쪽에 있다.)
//
// ⛔ 시계·사용률·잔액·기억 저장·원장 쓰기 전부 «주입» — 순수·결정적 시험이 된다. 비밀 값 0(행 이름·사유·시각뿐).
//
// ⛔ 이 PR 은 `resolveCodexAccountForRun` 실경로에 «배선하지 않는다»: 금고 임대(secret supply)·넥서스 정책 수급이
//   아직 없어, 지금 배선하면 임대 없음 = 전 행 불가(fail-closed) 로 모든 codex 호출이 멈춘다. 배선 지점과 선행 조건은
//   보고서의 «빈칸». 여기서는 배선이 부를 «한 함수»(runLlmSpendGuard)와 codex 후보 → 행 상태 매퍼를 낸다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  LlmSpendLedgerEntry, LlmSpendPolicyDoc, LlmSpendRowState, SubscriptionWindowState, VaultLeaseState,
} from '../nexus/llm-spend-policy/types.js';
import { decideLlmSpend, type LlmSpendDecision, type LlmSpendDecisionRequest } from './llm-spend-decision.js';
import type { RotationCandidate } from './codex-account-rotation.js';
import { withSpendLock, type SpendReservationLedger } from './llm-spend-reservation.js';

// ── 창 리셋 실측 ──────────────────────────────────────────────────────────────

/** 사용률이 이 %p 이상 «떨어졌으면» 창이 리셋된 것으로 본다(작은 흔들림은 리셋이 아니다). */
export const WINDOW_RESET_DROP_PCT = 30;

export type WindowResetKind = 'reset-elapsed' | 'usage-drop' | 'reset-advanced';

/** 직전 관측 스냅샷 — 행별로 기억한다. */
export interface WindowSnapshot {
  readonly usedPct: number;
  readonly resetAt?: string;
  readonly observedAt: string;
}

export interface WindowObservation {
  /** 결정 함수에 넘길 창 상태(리셋 경과면 합성된 «리셋 직후» 상태). */
  readonly window: SubscriptionWindowState;
  readonly reset: WindowResetKind | null;
  /** 다음 호출이 비교할 스냅샷(없으면 기억을 지우지 않고 이전 값을 유지). */
  readonly snapshot: WindowSnapshot | undefined;
}

function ms(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * 창 리셋 실측 — 순수. 리셋으로 보는 것은 «관측된» 것뿐이다(추정 0):
 *   ① reset-elapsed: 직전 스냅샷의 리셋 시각이 지났고, 지금 받은 값이 그 리셋 «이전» 관측(낡은 값)이거나 값이 없다
 *      → 리셋 직후(usedPct 0)로 합성한다. 새 실측이 오면 다음 호출이 그것으로 덮는다.
 *   ② usage-drop: 리셋 «이후» 새로 잰 사용률이 직전보다 WINDOW_RESET_DROP_PCT 이상 낮다.
 *   ③ reset-advanced: 새 값의 리셋 시각이 직전보다 뒤로 밀렸고 사용률이 내려갔다(창이 굴렀다).
 * 직전 스냅샷이 없으면 리셋을 «추정하지 않는다»(첫 관측).
 */
export function observeWindow(
  prev: WindowSnapshot | undefined,
  current: SubscriptionWindowState | undefined,
  now: Date,
): WindowObservation {
  const nowMs = now.getTime();
  const prevResetMs = ms(prev?.resetAt);
  const measured = current?.status === 'measured' ? current : undefined;
  const curObservedMs = measured ? ms(measured.observedAt) : undefined;

  const staleAfterReset = prev !== undefined && prevResetMs !== undefined && prevResetMs <= nowMs
    && (measured === undefined || (curObservedMs !== undefined && curObservedMs < prevResetMs));
  if (staleAfterReset) {
    const synthesized: SubscriptionWindowState = {
      status: 'measured', usedPct: 0, source: 'reset-elapsed', observedAt: now.toISOString(),
    };
    return { window: synthesized, reset: 'reset-elapsed', snapshot: { usedPct: 0, observedAt: now.toISOString() } };
  }
  if (!measured) {
    return { window: current ?? { status: 'unmeasured', reason: '주입된 실측 없음' }, reset: null, snapshot: prev };
  }
  const snapshot: WindowSnapshot = {
    usedPct: measured.usedPct, ...(measured.resetAt ? { resetAt: measured.resetAt } : {}), observedAt: measured.observedAt,
  };
  if (prev === undefined) return { window: measured, reset: null, snapshot };
  const dropped = prev.usedPct - measured.usedPct;
  if (dropped >= WINDOW_RESET_DROP_PCT) return { window: measured, reset: 'usage-drop', snapshot };
  const curResetMs = ms(measured.resetAt);
  if (curResetMs !== undefined && prevResetMs !== undefined && curResetMs > prevResetMs && dropped > 0) {
    return { window: measured, reset: 'reset-advanced', snapshot };
  }
  return { window: measured, reset: null, snapshot };
}

// ── 기억(직전 행 · 창 스냅샷 · 멈춤 여부) ─────────────────────────────────────

export interface GuardMemory {
  readonly currentRow?: string;
  readonly stopped?: boolean;
  readonly windows: Readonly<Record<string, WindowSnapshot>>;
  /** 저잔액·구독 소진 알림 중복 억제 — 행 → 마지막으로 우편을 보낸 레벨(llm-low-balance-alert.ts). 회복하면 지운다(재무장). */
  readonly alerted?: Readonly<Record<string, string>>;
}

export interface GuardMemoryStore {
  load(): GuardMemory;
  save(memory: GuardMemory): void;
}

export function createInMemoryGuardStore(initial: GuardMemory = { windows: {} }): GuardMemoryStore & { readonly current: () => GuardMemory } {
  let memory = initial;
  return { load: () => memory, save: (next) => { memory = next; }, current: () => memory };
}

/** 파일 기억 — 원자 쓰기(tmp → rename). 못 읽으면 «빈 기억»(첫 결정으로 취급 — 복귀·전환 판정만 늦어질 뿐 fail-open 아님). */
export function createFileGuardStore(path: string): GuardMemoryStore {
  return {
    load() {
      try {
        if (!existsSync(path)) return { windows: {} };
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuardMemory>;
        return {
          ...(typeof parsed.currentRow === 'string' ? { currentRow: parsed.currentRow } : {}),
          ...(parsed.stopped === true ? { stopped: true } : {}),
          windows: parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {},
          ...(parsed.alerted && typeof parsed.alerted === 'object' ? { alerted: parsed.alerted } : {}),
        };
      } catch { return { windows: {} }; }
    },
    save(memory) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(memory), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

// ── 가드 한 번 ────────────────────────────────────────────────────────────────

export interface LlmSpendGuardDeps {
  readonly policy: LlmSpendPolicyDoc;
  /** 실측 주입 — 창 사용률·잔액·지출·임대. */
  readonly readStates: () => readonly LlmSpendRowState[];
  readonly memory: GuardMemoryStore;
  /** 원장 한 줄 쓰기(실배선: appendSpendTransition). throw 가능. */
  readonly appendLedger: (entry: LlmSpendLedgerEntry) => void | Promise<void>;
  /** 주입 시계. */
  readonly now: () => Date;
  /**
   * 예약 원장(선택) — 주면 «판정 + 예약» 이 한 임계 구역(같은 프로세스 직렬화)에서 일어나, 동시 호출이 같은 잔여 상한을
   * 둘 다 쓰지 못한다. 이때 크레딧 행은 request.estimateUsd(유한·0 이상)가 필수다(없으면 크레딧 거부 · fail-closed).
   */
  readonly reservations?: SpendReservationLedger;
  /** 예약 id 생성(시험 주입) — 기본 호출 순번 기반. */
  readonly newReservationId?: () => string;
}

/** 크레딧 행 예약 핸들 — 호출이 끝나면 commit(실제 지출액) · 호출이 안 일어났으면 release. */
export interface SpendReservationHandle {
  readonly id: string;
  readonly row: string;
  readonly estimateUsd: number;
  readonly commit: (actualUsd: number) => boolean;
  readonly release: () => boolean;
}

let reservationSeq = 0;

export interface LlmSpendGuardResult {
  readonly decision: LlmSpendDecision;
  readonly resets: Readonly<Record<string, WindowResetKind>>;
  /** 이번 호출에 원장에 실제로 한 줄 남겼나(stay 는 남기지 않는다 — 호출마다 한 줄이면 원장이 묻힌다). */
  readonly ledgerWritten: boolean;
  readonly ledgerError?: string;
  /** 크레딧 행이 선택되고 예약 원장이 주입됐을 때만. */
  readonly reservation?: SpendReservationHandle;
}

/**
 * 모든 호출 경로가 지나는 한 함수 — 창 리셋 반영 → 결정 함수 → 기억 갱신 → 원장.
 * ⛔ fail-closed: 크레딧 행으로 «넘어가는» 결정은 원장 한 줄이 써진 뒤에만 유효하다(못 쓰면 멈춤 — 안 보이는 지출 0).
 * 원장은 전환(첫 결정·switch·return)·멈춤 «진입»·멈춤 «해소» 에만 남긴다(stay·반복 멈춤은 줄 0).
 */
export function runLlmSpendGuard(
  deps: LlmSpendGuardDeps,
  request: Omit<LlmSpendDecisionRequest, 'currentRow' | 'now' | 'reservations'>,
): Promise<LlmSpendGuardResult> {
  // 같은 프로세스 직렬화 — 실측 읽기·판정·예약·기억 저장이 호출끼리 겹치지 않는다(원장 없으면 기억 저장소 기준).
  // ⭐ 파일 원장이면 그 «위에» 교차 프로세스 락(withExclusive)을 겹쳐, 다른 프로세스와도 판정 + 예약이 겹치지 않는다.
  //   락을 못 잡으면(대기 초과) fail-closed 멈춤 — 모르는 상태에 차감 0.
  const ledger = deps.reservations;
  const run = (): Promise<LlmSpendGuardResult> => ledger?.withExclusive
    ? ledger.withExclusive<LlmSpendGuardResult>(() => runLlmSpendGuardLocked(deps, request)).catch((error: unknown) => lockFailedStop(deps, error))
    : runLlmSpendGuardLocked(deps, request);
  return withSpendLock(deps.reservations ?? deps.memory, run);
}

function lockFailedStop(deps: LlmSpendGuardDeps, error: unknown): LlmSpendGuardResult {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith('spend-lock-timeout')) throw error;
  const at = deps.now().toISOString();
  const reason = `spend-lock-timeout(교차 프로세스 락 대기 초과 — fail-closed 멈춤): ${message}`;
  return {
    decision: { outcome: 'stop', reason, skipped: [], ledger: { at, actor: 'system', action: 'decision', what: 'stop', from: null, to: null, reason } },
    resets: {}, ledgerWritten: false,
  };
}

async function runLlmSpendGuardLocked(
  deps: LlmSpendGuardDeps,
  request: Omit<LlmSpendDecisionRequest, 'currentRow' | 'now' | 'reservations'>,
): Promise<LlmSpendGuardResult> {
  const now = deps.now();
  const memory = deps.memory.load();
  const resets: Record<string, WindowResetKind> = {};
  const windows: Record<string, WindowSnapshot> = { ...memory.windows };

  const states = deps.readStates().map((state): LlmSpendRowState => {
    const policyRow = deps.policy.providers[state.row];
    if (!policyRow || policyRow.kind === 'credit') return state; // 창이 없는 행
    const observed = observeWindow(memory.windows[state.row], state.window, now);
    if (observed.snapshot) windows[state.row] = observed.snapshot;
    if (observed.reset) resets[state.row] = observed.reset;
    return { ...state, window: observed.window };
  });

  const decision = decideLlmSpend(deps.policy, states, {
    ...request, now,
    ...(deps.reservations ? { reservations: deps.reservations.snapshot(now), estimateUsd: request.estimateUsd ?? NaN } : {}), ...(memory.currentRow !== undefined ? { currentRow: memory.currentRow } : {}),
  });

  let entry: LlmSpendLedgerEntry | undefined;
  let nextRow = memory.currentRow;
  let stopped = memory.stopped === true;
  if (decision.outcome === 'stop') {
    if (!stopped) entry = decision.ledger; // 진입 한 번만
    stopped = true;
  } else {
    nextRow = decision.row;
    const stay = decision.reason.startsWith('stay:');
    if (stopped) {
      entry = { ...decision.ledger, action: decision.ledger.action, reason: `resume-after-stop · ${decision.ledger.reason}` };
    } else if (!stay) {
      entry = decision.ledger;
    }
    stopped = false;
    if (entry && decision.ledger.action === 'return') {
      const kinds = Object.entries(resets).filter(([row]) => row === decision.row).map(([, kind]) => kind);
      if (kinds.length > 0) entry = { ...entry, reason: `${entry.reason} · 관측:${kinds.join(',')}` };
    }
  }

  let ledgerWritten = false;
  let ledgerError: string | undefined;
  if (entry) {
    try { await deps.appendLedger(entry); ledgerWritten = true; } catch (error) {
      ledgerError = error instanceof Error ? error.message : String(error);
    }
  }

  const choseCredit = decision.outcome === 'choice' && deps.policy.providers[decision.row]?.kind === 'credit';
  if (entry && !ledgerWritten && choseCredit && decision.outcome === 'choice') {
    // 크레딧 진입을 원장에 못 남겼다 — 안 보이는 지출 0: 멈춘다(기억은 갱신하지 않아 다음 호출이 다시 시도).
    const reason = `ledger-write-failed(크레딧 전환 원장 실패 — fail-closed 멈춤): ${ledgerError}`;
    const stopDecision: LlmSpendDecision = {
      outcome: 'stop', reason, skipped: decision.skipped,
      ledger: { at: now.toISOString(), actor: decision.ledger.actor, action: 'decision', what: 'stop', from: memory.currentRow ?? null, to: null, reason },
    };
    deps.memory.save({ ...memory, windows });
    return { decision: stopDecision, resets, ledgerWritten: false, ledgerError: ledgerError! };
  }

  let reservation: SpendReservationHandle | undefined;
  if (deps.reservations && choseCredit && decision.outcome === 'choice') {
    const ledger = deps.reservations;
    const id = deps.newReservationId?.() ?? `rsv-${now.getTime()}-${++reservationSeq}`;
    const estimateUsd = request.estimateUsd as number; // 결정 함수가 유한·0 이상임을 이미 검증했다(아니면 크레딧 거부)
    if (!ledger.reserve({ id, row: decision.row, ...(request.role !== undefined ? { role: request.role } : {}), estimateUsd, at: now.toISOString() })) {
      const reason = 'reserve-failed(예약 원장 차감 실패 — fail-closed 멈춤)';
      deps.memory.save({ ...memory, windows });
      return {
        decision: { outcome: 'stop', reason, skipped: decision.skipped, ledger: { at: now.toISOString(), actor: decision.ledger.actor, action: 'decision', what: 'stop', from: memory.currentRow ?? null, to: null, reason } },
        resets, ledgerWritten, ...(ledgerError !== undefined ? { ledgerError } : {}),
      };
    }
    reservation = {
      id, row: decision.row, estimateUsd,
      commit: (actualUsd) => ledger.commit(id, actualUsd, deps.now().toISOString()),
      release: () => ledger.release(id),
    };
  }

  deps.memory.save({
    windows,
    ...(nextRow !== undefined ? { currentRow: nextRow } : {}),
    ...(stopped ? { stopped: true } : {}),
    ...(memory.alerted ? { alerted: memory.alerted } : {}),
  });
  return { decision, resets, ledgerWritten, ...(ledgerError !== undefined ? { ledgerError } : {}), ...(reservation ? { reservation } : {}) };
}

// ── codex 후보 → 행 상태 매퍼(순수) ────────────────────────────────────────────

/**
 * 기존 codex 회전 후보(RotationCandidate)의 쿼터 신호를 결정 함수 입력 행 상태로 바꾼다. 행 키 = `codex-<계정명>`.
 * ⛔ 「모른다」는 unmeasured(못 쓴다) — reached=true 는 100%, 사용률이 있으면 그 값, 둘 다 없으면 unmeasured.
 * 임대는 주입(없으면 미주입 = 그 행 불가 · fail-closed).
 */
export function codexCandidatesToRowStates(
  candidates: readonly RotationCandidate[],
  observedAt: string,
  leases: Readonly<Record<string, VaultLeaseState>> = {},
  resetAtByAccount: Readonly<Record<string, string>> = {},
): LlmSpendRowState[] {
  return candidates.map((candidate): LlmSpendRowState => {
    const row = `codex-${candidate.name}`;
    const usedPct = candidate.usedPercent !== undefined ? candidate.usedPercent : candidate.reached === true ? 100 : undefined;
    const reset = resetAtByAccount[candidate.name];
    const window: SubscriptionWindowState = usedPct === undefined
      ? { status: 'unmeasured', reason: 'codex 쿼터 신호 없음' }
      : { status: 'measured', usedPct: candidate.reached === true ? Math.max(usedPct, 100) : usedPct, ...(reset ? { resetAt: reset } : {}), source: 'codex-quota-signal', observedAt };
    const lease = leases[candidate.name];
    return { row, provider: 'openai-codex', window, ...(lease ? { lease } : {}) };
  });
}
