// ── 약속 원장 `commitment-ledger` (ELN-COMMITMENT-LEDGER · I1 · 2026-11-17) ──────────────────────────────
//
// 🚨 무엇을 푸는가: 답에 적힌 약속(«다음 스텝·이어서·…하겠습니다·확인 후 보고»)이 추적되지 않아, 턴이 끝나면
//   자리도 OP 도 «무엇이 남았나»를 화면 재열독으로만 알았다(METHOD-SELF-PROACTIVE-1117 I1 · 원칙 P1·P2).
// ⭐ 이 모듈은 자리 단위 영속 원장이다 — 항목 {id · 내용 · 근거 문장 · 상태 open/done/dropped/blocked · 깨우개 · 시각 · 자리/세션}.
//   계획 목록(seat-task-decompose.ts · PLAN-ONE-ACTIVE)과 «같은 원장의 한 층»: 항목은 `layer: 'commitment'` 이고 선택적
//   `planTaskId` 로 계획 작업(DecomposedTask.id)을 가리킨다. 계획 목록은 아직 저장소가 없어(순수 모듈 · SeatTaskQueuePort
//   인터페이스뿐 · ELN-PLAN-WIRE-SEAT 미배선) 그 옆에 작은 저장소를 둔다.
// ⛔ 상태 전이는 명시 호출만(§6 불변식 10 «접수 ≠ 개정» · 9 «완료엔 근거»):
//   · record 는 추가만 한다 — 같은 세션에 같은 내용의 열린 항목이 있으면 새로 만들지 않고 기존 것을 돌려준다.
//   · 자동 닫기 없음. done 은 근거(evidence) 필수 · dropped/blocked 는 사유 필수 · done/dropped 는 종단(되돌리면 충돌 오류).
// 저장: `<state>/commitments/<SEAT>.json`(자리 단위 · 세션은 항목 칸). 자리 재기동(E2 ③ 새 판)에도 열린 약속이 남게
//   세션 파일이 아니라 자리 파일로 둔다. 쓰기 = 임시 파일 ⊕ rename(반쯤 쓴 파일 0).
//
// 세 얼굴:
//   관측 = debug.log('commitment', 'commitment.recorded' | 'commitment.closed' | 'commitment.state' | 'commitment.waker-attached', {...})
//   판단 근거 = 항목의 evidence(답 원문 문장) ⊕ 상태 전이 사유/근거 칸
//   수복과 인계 = listOpen 이 I2(턴 끝 관문)·I4(스스로 집기)·E1(감시기)의 입력 · 깨우개(I3)는 attachWaker 로 묶는다
//
// ⚠️ v2(ELN-PLAN-LEDGER-ONE · 대표 11-17 08:4x · 내부 문서 `ELN-SELF-PROACTIVE` «v2 — 구조 상태 한 원장»):
//   정본 원장은 «계획 도구 상태» 하나다. 이 파일의 원장(CommitmentLedger)은 더는 권위가 아니고, 턴 끝 이음매
//   `recordReplyCommitments` 는 원장에 쓰지 않는 그림자 비교(turn-outcome-shadow.ts · `turn.outcome-mismatch`)만 한다.
//   옛 API → 계획 항목 연산: listOpen → done 아닌 항목 · markBlocked → status blocked ⊕ reason · attachWaker → item.wake.
//   만료 11-24(OP) — 그날 불일치율을 보고 이 원장·추출기 제거를 판단한다.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { extractCommitments, type CommitmentPattern, type CommitmentWaitHint } from './commitment-extract.js';
import { compareTurnOutcome, type PlanOutcomeReadView, type TurnOutcomeEmit, type TurnOutcomeVerdict } from './turn-outcome-shadow.js';

export type CommitmentStatus = 'open' | 'done' | 'dropped' | 'blocked';
export const COMMITMENT_TERMINAL: ReadonlySet<CommitmentStatus> = new Set(['done', 'dropped']);

/** 이 항목에 묶인 깨우개(I3 `eln msg wait-for`) — 원장은 참조만 든다(깨우개 상태의 정본은 깨우개 저장소). */
export interface CommitmentWakerRef {
  wakerId: string;
  /** 조건 문법 그대로 — `pr-merged:38049` · `time:30m` … */
  condition: string;
  attachedAt: string;
}

export interface CommitmentEntry {
  id: string;
  /** 같은 원장의 층 표지 — 계획 작업(DecomposedTask)과 나란히 읽을 때 구분. */
  layer: 'commitment';
  seat: string;
  sessionId: string;
  /** 사람이 읽는 약속 내용. */
  text: string;
  /** 근거 문장 — 답 원문 그대로(요약 금지). */
  evidence: string;
  status: CommitmentStatus;
  source: 'extractor' | 'explicit';
  pattern?: CommitmentPattern;
  waitHint?: CommitmentWaitHint;
  wakers: CommitmentWakerRef[];
  /** 계획 목록 항목과의 연결(선택). */
  planTaskId?: string;
  createdAt: string;
  updatedAt: string;
  /** done 의 근거(시험·영수증 참조 한 줄) — done 전이에 필수. */
  doneEvidence?: string;
  /** dropped·blocked 의 사유 한 줄. */
  reason?: string;
}

export interface CommitmentAddInput {
  seat: string;
  sessionId: string;
  text: string;
  evidence: string;
  source?: CommitmentEntry['source'];
  pattern?: CommitmentPattern;
  waitHint?: CommitmentWaitHint;
  planTaskId?: string;
}

/** 종단 항목 조작·없는 항목 조작 — 아무것도 바꾸지 않고 던진다(opencode LifecycleConflict 꼴 · §6 불변식 2). */
export class CommitmentLifecycleConflict extends Error {
  constructor(message: string) { super(message); this.name = 'CommitmentLifecycleConflict'; }
}

export type CommitmentEmit = (category: string, event: string, data: Record<string, unknown>) => void;

export interface CommitmentLedgerDeps {
  /** 원장 디렉터리 — 기본 `<state>/commitments`. 시험은 임시 디렉터리. */
  root?: string;
  now?: () => Date;
  newId?: () => string;
  emit?: CommitmentEmit;
}

export const COMMITMENT_LOG_CATEGORY = 'commitment';
export const COMMITMENT_RECORDED_EVENT = 'commitment.recorded';
export const COMMITMENT_CLOSED_EVENT = 'commitment.closed';
export const COMMITMENT_STATE_EVENT = 'commitment.state';
export const COMMITMENT_WAKER_ATTACHED_EVENT = 'commitment.waker-attached';

/** 녹화 켜기 env — I2 턴 끝 관문이 부르는 `recordReplyCommitments` 의 문. 기본 off(행동 변화 0). */
export const COMMITMENT_LEDGER_ENV = 'ELANOUS_COMMITMENT_LEDGER';

export function defaultCommitmentRoot(): string { return join(elanousStateRoot(), 'commitments'); }

function seatFileName(seat: string): string {
  const safe = seat.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  if (!safe) throw new Error('commitment seat must be nonempty');
  return `${safe}.json`;
}

function contentKey(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\s.!。…~]+$/u, '').trim().toLowerCase();
}

interface LedgerFile { version: 1; entries: CommitmentEntry[] }

/**
 * @deprecated ELN-PLAN-LEDGER-ONE(11-17) — 정본은 계획 도구 상태다. 만료 11-24.
 * 대응: listOpen → 계획 항목 중 done 아님 · markBlocked → status 'blocked' ⊕ reason · attachWaker → item.wake.
 */
export class CommitmentLedger {
  readonly root: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly emit: CommitmentEmit;

  constructor(deps: CommitmentLedgerDeps = {}) {
    this.root = deps.root ?? defaultCommitmentRoot();
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => `c-${randomUUID().slice(0, 8)}`);
    this.emit = deps.emit ?? ((category, event, data) => debug.log(category, event, data));
  }

  pathFor(seat: string): string { return join(this.root, seatFileName(seat)); }

  private read(seat: string): CommitmentEntry[] {
    const path = this.pathFor(seat);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LedgerFile>;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  }

  private write(seat: string, entries: CommitmentEntry[]): void {
    mkdirSync(this.root, { recursive: true });
    const path = this.pathFor(seat);
    const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries } satisfies LedgerFile, null, 2)}\n`);
    renameSync(tmp, path);
  }

  /** 항목 추가 — 같은 세션의 열린(open·blocked) 항목과 내용이 같으면 새로 만들지 않고 그것을 돌려준다(이벤트 0). */
  add(input: CommitmentAddInput): { entry: CommitmentEntry; created: boolean } {
    const text = input.text.trim();
    const evidence = input.evidence.trim();
    if (!text) throw new Error('commitment text must be nonempty');
    if (!evidence) throw new Error('commitment evidence must be nonempty');
    const seat = input.seat.trim().toUpperCase();
    const entries = this.read(seat);
    const key = contentKey(text);
    const existing = entries.find(e => e.sessionId === input.sessionId && !COMMITMENT_TERMINAL.has(e.status) && contentKey(e.text) === key);
    if (existing) return { entry: existing, created: false };
    const at = this.now().toISOString();
    const entry: CommitmentEntry = {
      id: this.newId(), layer: 'commitment', seat, sessionId: input.sessionId, text, evidence,
      status: 'open', source: input.source ?? 'explicit',
      ...(input.pattern ? { pattern: input.pattern } : {}),
      ...(input.waitHint ? { waitHint: input.waitHint } : {}),
      ...(input.planTaskId ? { planTaskId: input.planTaskId } : {}),
      wakers: [], createdAt: at, updatedAt: at,
    };
    this.write(seat, [...entries, entry]);
    this.emit(COMMITMENT_LOG_CATEGORY, COMMITMENT_RECORDED_EVENT, {
      id: entry.id, seat, sessionId: entry.sessionId, source: entry.source, pattern: entry.pattern ?? null, text: entry.text,
    });
    return { entry, created: true };
  }

  get(seat: string, id: string): CommitmentEntry | undefined {
    return this.read(seat).find(e => e.id === id);
  }

  /** 전 항목(등재 순). */
  list(seat: string, filter: { sessionId?: string; status?: CommitmentStatus | readonly CommitmentStatus[] } = {}): CommitmentEntry[] {
    const statuses = filter.status === undefined ? null : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    return this.read(seat).filter(e => (filter.sessionId === undefined || e.sessionId === filter.sessionId)
      && (statuses === null || statuses.has(e.status)));
  }

  /** 열린 항목 — open 만(blocked 는 사람 몫이라 «할 일 있음»에 넣지 않는다 · 필요하면 list 로). */
  listOpen(seat: string, filter: { sessionId?: string } = {}): CommitmentEntry[] {
    return this.list(seat, { ...filter, status: 'open' });
  }

  private transition(seat: string, id: string, to: CommitmentStatus, patch: Partial<CommitmentEntry>): CommitmentEntry {
    const entries = this.read(seat);
    const index = entries.findIndex(e => e.id === id);
    if (index < 0) throw new CommitmentLifecycleConflict(`commitment not found: ${seat}/${id}`);
    const before = entries[index]!;
    if (COMMITMENT_TERMINAL.has(before.status)) {
      throw new CommitmentLifecycleConflict(`commitment ${id} is ${before.status} (terminal) — cannot move to ${to}`);
    }
    if (before.status === to) throw new CommitmentLifecycleConflict(`commitment ${id} is already ${to}`);
    const after: CommitmentEntry = { ...before, ...patch, status: to, updatedAt: this.now().toISOString() };
    entries[index] = after;
    this.write(seat, entries);
    const data = { id, seat: after.seat, sessionId: after.sessionId, from: before.status, to, reason: after.reason ?? null, doneEvidence: after.doneEvidence ?? null };
    this.emit(COMMITMENT_LOG_CATEGORY, COMMITMENT_TERMINAL.has(to) ? COMMITMENT_CLOSED_EVENT : COMMITMENT_STATE_EVENT, data);
    return after;
  }

  /** open|blocked → done · 근거 필수(§6 불변식 9 — 자식 «끝» 알림은 근거가 아니다). */
  markDone(seat: string, id: string, evidence: string): CommitmentEntry {
    if (!evidence?.trim()) throw new Error('done requires evidence (test result · receipt reference)');
    return this.transition(seat, id, 'done', { doneEvidence: evidence.trim() });
  }

  /** open|blocked → dropped · 사유 필수. */
  markDropped(seat: string, id: string, reason: string): CommitmentEntry {
    if (!reason?.trim()) throw new Error('dropped requires a reason');
    return this.transition(seat, id, 'dropped', { reason: reason.trim() });
  }

  /** open → blocked · 사유 필수(무엇을·누구를·언제까지 — 원칙 P2). */
  markBlocked(seat: string, id: string, reason: string): CommitmentEntry {
    if (!reason?.trim()) throw new Error('blocked requires a reason');
    return this.transition(seat, id, 'blocked', { reason: reason.trim() });
  }

  /** blocked → open(막힘 풀림). */
  reopen(seat: string, id: string): CommitmentEntry {
    const entry = this.get(seat, id);
    if (entry && entry.status !== 'blocked') throw new CommitmentLifecycleConflict(`commitment ${id} is ${entry.status} — only blocked can reopen`);
    return this.transition(seat, id, 'open', {});
  }

  /** 깨우개 묶기 — 종단 항목엔 못 묶는다 · 같은 wakerId 는 한 번만(멱등). */
  attachWaker(seat: string, id: string, waker: { wakerId: string; condition: string }): CommitmentEntry {
    const entries = this.read(seat);
    const index = entries.findIndex(e => e.id === id);
    if (index < 0) throw new CommitmentLifecycleConflict(`commitment not found: ${seat}/${id}`);
    const before = entries[index]!;
    if (COMMITMENT_TERMINAL.has(before.status)) throw new CommitmentLifecycleConflict(`commitment ${id} is ${before.status} — cannot attach a waker`);
    if (before.wakers.some(w => w.wakerId === waker.wakerId)) return before;
    const at = this.now().toISOString();
    const after: CommitmentEntry = { ...before, wakers: [...before.wakers, { wakerId: waker.wakerId, condition: waker.condition, attachedAt: at }], updatedAt: at };
    entries[index] = after;
    this.write(seat, entries);
    this.emit(COMMITMENT_LOG_CATEGORY, COMMITMENT_WAKER_ATTACHED_EVENT, { id, seat: after.seat, wakerId: waker.wakerId, condition: waker.condition });
    return after;
  }
}

// ── I2 이음매(HAND-TUI-C · ELN-TURN-END-DECISION-GATE) — v2: 그림자 비교만 ─────────────────────

/** 켜짐 값 — 'shadow'(v2 이름) · 옛 값 'record'·'1'·'on'·'true' 도 이제 그림자 비교만 한다. 기본 off. */
export function isCommitmentLedgerRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[COMMITMENT_LEDGER_ENV] ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'record' || v === '1' || v === 'on' || v === 'true';
}

export interface RecordReplyCommitmentsInput {
  seat: string;
  sessionId: string;
  /** 어시스턴트 최종 답 전문(턴 끝) — 추출에만 쓰고 이벤트·원장 어디에도 싣지 않는다. */
  finalText: string;
  /** 이 턴의 id — `turn.outcome-mismatch` 의 turnId. 없으면 sessionId. */
  turnId?: string;
  /** 계획 상태 스냅샷(정본) — 관문이 넘긴다. 없으면 no-structure(비교·이벤트 0). */
  plan?: PlanOutcomeReadView;
}

export interface RecordReplyCommitmentsResult {
  enabled: boolean;
  /** v2 — 항상 'shadow'(원장 쓰기 0). 꺼짐이면 없음. */
  mode?: 'shadow';
  /** 추출기 ↔ 계획 상태 비교 결과. 꺼짐이면 없음. */
  verdict?: TurnOutcomeVerdict;
  /** @deprecated v2 에서 항상 [] — 원장에 등재하지 않는다. 만료 11-24. */
  recorded: CommitmentEntry[];
  /** @deprecated v2 에서 항상 [] — 만료 11-24. */
  existing: CommitmentEntry[];
}

/**
 * 턴 끝 이음매 — 관문(I2 v2)이 매 턴 끝에 부른다. 꺼져 있으면 아무것도 안 한다(enabled:false).
 * v2: 원장에 쓰지 않는다. 추출기를 돌려 계획 상태 스냅샷과 비교하고, 불일치일 때만 `turn.outcome-mismatch` 를 남긴다.
 * 턴 흐름·자동 계속·깨우기는 바꾸지 않는다 — 판정은 계획 상태로 관문이 한다.
 * `deps.ledger` 는 옛 호출부 호환으로만 받고 쓰지 않는다(@deprecated · 만료 11-24).
 */
export function recordReplyCommitments(
  input: RecordReplyCommitmentsInput,
  deps: { ledger?: CommitmentLedger; env?: NodeJS.ProcessEnv; force?: boolean; emit?: TurnOutcomeEmit } = {},
): RecordReplyCommitmentsResult {
  const enabled = deps.force === true || isCommitmentLedgerRecordingEnabled(deps.env);
  if (!enabled) return { enabled: false, recorded: [], existing: [] };
  const patterns = extractCommitments(input.finalText).map(c => c.pattern);
  const { verdict } = compareTurnOutcome({
    seat: input.seat,
    turnId: input.turnId ?? input.sessionId,
    extractedPatterns: patterns,
    ...(input.plan ? { plan: input.plan } : {}),
  }, deps.emit ? { emit: deps.emit } : {});
  return { enabled: true, mode: 'shadow', verdict, recorded: [], existing: [] };
}
