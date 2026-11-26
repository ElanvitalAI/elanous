// ── 셀프 타이머·감시 `self-timer-watch` (ELN-SELF-TIMER-WATCH · I3 · 2026-11-17) ──────────────────────────
//
// 🚨 무엇을 푸는가: 자리가 «PR 리뷰 오면 반영하겠습니다»·«30분 뒤 다시 보겠습니다» 라고 적고 쉬면, 깨워 줄 장치가
//   없어 OP 가 30분마다 화면을 보고 «계속»을 쳤다(METHOD-SELF-PROACTIVE-1117 S·C · 원칙 P3 «걸지 않은 기다림 금지»).
// ⭐ 이 모듈은 자리가 «직접 거는» 깨우개다 — 조건(시간·PR 머지·리뷰 도착·우편 회신·파일 생성)이 차면 그 자리 주소로
//   우편 notice 를 남긴다. 그 뒤는 기존 길이 잇는다: 우편 도착 → 큐 notice(#38031 CHILD-NOTICE) → 유휴면 자동 깨움
//   (src/dashboard/input/seat-autowake.ts · #38013 AUTOWAKE — 안 읽은 우편 > 0 이면 다음 턴).
// ⛔ 새 상주 프로세스 0: 감시는 «상한 있는 until-loop(백오프)»가 끝나면 나가는 한 번짜리 실행이거나(`msg wait-for`),
//   일정 틱이 한 번 훑는 `msg wait-tick` 이다. `eln schedule` 은 crontab 반복이라 일회 타이머가 없다 — 틱 등록은
//   OP 몫으로 남기고 이 PR 은 어떤 일정도 등록하지 않는다.
// 규칙(I3): 모든 깨우개는 원장 항목(src/commitment/ledger.ts)에 묶인다(없거나 닫힌 항목이면 거부) · 최대 지평 · 만료는
//   «expired» notice 로 시끄럽게 · 같은 항목·같은 조건의 깨우개는 하나로 합친다. 발화·만료는 원장을 닫지 않는다(§6 불변식 9·10).
//
// 세 얼굴:
//   관측 = debug.log('self-timer', 'self-timer.armed' | '.merged' | '.fired' | '.expired' | '.probe-error', {...})
//   판단 근거 = 깨우개 칸(조건·armedAt·deadlineAt·checks·lastCheckedAt) ⊕ 원장 항목 근거 문장
//   수복과 인계 = 발화 → 자리 우편 notice(자동 깨움) · 만료 → «expired» notice(자리가 다시 걸거나 blocked/dropped 로 정리)

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { WAKEUP_MIN_DELAY_MS } from '../skills/tools/schedule-wakeup.js';
import { COMMITMENT_TERMINAL, CommitmentLedger, defaultCommitmentRoot, type CommitmentEntry } from '../commitment/ledger.js';
import { canonicalSeatId } from './msg-store.js';
import { MSG_WAIT_DEFAULT_WITHIN_MS, MSG_WAIT_RETRY_GRACE_MS } from './msg-wait-contract.js';
import { findPregateReceipt, pregateGreenDir } from '../commitment/pregate-receipt-dir.js';

// ── 상수(NUMGUARD — 출처 주석 필수) ─────────────────────────────────────────────────────

/** 깨우개 최대 지평 — 이보다 먼 기다림은 거부한다(원장 blocked ⊕ 사람에게 사유로). */
// 출처: METHOD-SELF-PROACTIVE-1117 I3 «최대 지평(기본 4h)»
export const SELF_TIMER_MAX_HORIZON_MS = 4 * 60 * 60_000;
/** 조건 점검 첫 간격 — H5 자기 예약 깨움의 최소 지연과 같은 값(schedule-wakeup.ts WAKEUP_MIN_DELAY_MS 재사용). */
export const SELF_TIMER_POLL_MIN_MS = WAKEUP_MIN_DELAY_MS;
/** 조건 점검 간격 상한 — 지금 OP 손 점검 주기(30분 · METHOD-SELF-PROACTIVE-1117 C)의 절반: 깨우개가 손 점검보다 늦게 알면 뜻이 없다. */
export const SELF_TIMER_POLL_MAX_MS = 15 * 60_000;
/** 백오프 배수 — 두 배(지수 백오프 관례): 지평 안 점검 횟수를 log2(상한/하한) ⊕ 지평/상한 으로 묶는다. */
export const SELF_TIMER_BACKOFF_FACTOR = 2;

export const SELF_TIMER_LOG_CATEGORY = 'self-timer';
export const SELF_TIMER_EVENTS = {
  armed: 'self-timer.armed',
  merged: 'self-timer.merged',
  fired: 'self-timer.fired',
  expired: 'self-timer.expired',
  probeError: 'self-timer.probe-error',
  cancelled: 'self-timer.cancelled',
  /** MSG-WAIT-CONTRACT — a mail-reply wait reached its horizon: one reminder went to the counterpart, the horizon moved +5m. */
  retried: 'self-timer.retried',
} as const;
/** MSG-WAIT-CONTRACT — default horizon of a `mail-reply:` waker (other conditions keep the max horizon). */
export const SELF_TIMER_MAIL_REPLY_DEFAULT_MS = MSG_WAIT_DEFAULT_WITHIN_MS;
/** 발화·만료 notice 의 우편 kind. */
export const SELF_TIMER_NOTICE_KIND = 'notice';

// ── 조건 ───────────────────────────────────────────────────────────────────────────

export type WaitCondition =
  | { kind: 'time'; ms: number }
  | { kind: 'pr-merged'; pr: number }
  | { kind: 'review'; pr: number }
  | { kind: 'mail-reply'; message: number }
  | { kind: 'file'; path: string }
  // COND-WATCH(11-25 · MAIL-HANDLING-DESIGN-1125 ⑤) — outcomes read from the ledgers, not from a reply.
  | { kind: 'pregate-receipt'; pr: number; head?: string }
  | { kind: 'cell-status'; cell: string; status?: 'green' | 'yellow' | 'red' | 'done'; owner?: string }
  | { kind: 'seat-idle'; seat: string }
  | { kind: 'mail-from'; seat: string };

const CELL_STATUSES: ReadonlySet<string> = new Set(['green', 'yellow', 'red', 'done']);
const SEAT_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;
function seatToken(raw: string, what: string): string {
  const v = raw.trim();
  if (!SEAT_TOKEN.test(v)) throw new Error(`${what} must be a seat id: ${raw}`);
  return v.toUpperCase();
}

const DURATION = /^(\d+)\s*(s|sec|m|min|h|hr)$/i;
const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000 };

/** «30s·10m·2h» → ms. 0·음수·형식 밖은 거부. */
export function parseDuration(raw: string): number {
  const m = DURATION.exec(raw.trim());
  if (!m) throw new Error(`duration must look like 30s, 10m or 2h: ${raw}`);
  const ms = Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`duration must be positive: ${raw}`);
  return ms;
}

function positiveInt(raw: string, what: string): number {
  const v = raw.trim().replace(/^#/, '');
  if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`${what} must be a positive integer: ${raw}`);
  return Number(v);
}

/**
 * 조건 문법 — `time:<dur>` · `pr-merged:<N>` · `review:<N>` · `mail-reply:<M>` · `file:<path>`.
 * 원장 항목의 `waitHint`(commitment-extract.ts)와 1:1 이다(time 은 분 → `time:<N>m`).
 */
export function parseWaitCondition(raw: string, cwd: string = process.cwd()): WaitCondition {
  const index = raw.indexOf(':');
  if (index <= 0) throw new Error(`condition must be kind:value (time:30m · pr-merged:N · review:N · mail-reply:M · file:<path>): ${raw}`);
  const kind = raw.slice(0, index).trim().toLowerCase();
  const value = raw.slice(index + 1).trim();
  switch (kind) {
    case 'time': return { kind: 'time', ms: parseDuration(value) };
    case 'pr-merged': return { kind: 'pr-merged', pr: positiveInt(value, 'PR number') };
    case 'review': return { kind: 'review', pr: positiveInt(value, 'PR number') };
    case 'mail-reply': return { kind: 'mail-reply', message: positiveInt(value, 'message id') };
    case 'file':
    case 'file-exists': {
      if (!value) throw new Error('file condition needs a path');
      return { kind: 'file', path: isAbsolute(value) ? value : resolve(cwd, value) };
    }
    case 'pregate-receipt': {
      const at = value.indexOf('@');
      const pr = positiveInt(at < 0 ? value : value.slice(0, at), 'PR number');
      if (at < 0) return { kind: 'pregate-receipt', pr };
      const head = value.slice(at + 1).trim().toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(head)) throw new Error(`pregate-receipt head must be a hex sha (7-40): ${raw}`);
      return { kind: 'pregate-receipt', pr, head: head.slice(0, 12) };
    }
    case 'cell-status': {
      // cell-status:<id>=green · cell-status:<id>=owner=<seat>
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error(`cell-status needs <id>=<green|yellow|red|done> or <id>=owner=<seat>: ${raw}`);
      const cell = value.slice(0, eq).trim();
      const want = value.slice(eq + 1).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cell)) throw new Error(`cell-status id must be a checklist id: ${raw}`);
      if (want.toLowerCase().startsWith('owner=')) return { kind: 'cell-status', cell, owner: seatToken(want.slice('owner='.length), 'cell owner') };
      if (!CELL_STATUSES.has(want.toLowerCase())) throw new Error(`cell-status wants green|yellow|red|done or owner=<seat>: ${raw}`);
      return { kind: 'cell-status', cell, status: want.toLowerCase() as 'green' | 'yellow' | 'red' | 'done' };
    }
    case 'seat-idle': return { kind: 'seat-idle', seat: seatToken(value, 'seat') };
    case 'mail-from': return { kind: 'mail-from', seat: seatToken(value, 'seat') };
    default: throw new Error(`unknown condition kind: ${kind}`);
  }
}

/** 정규형 — 중복 합치기의 열쇠. */
export function formatWaitCondition(c: WaitCondition): string {
  switch (c.kind) {
    case 'time': return `time:${c.ms % 3_600_000 === 0 ? `${c.ms / 3_600_000}h` : c.ms % 60_000 === 0 ? `${c.ms / 60_000}m` : `${c.ms / 1000}s`}`;
    case 'pr-merged': return `pr-merged:${c.pr}`;
    case 'review': return `review:${c.pr}`;
    case 'mail-reply': return `mail-reply:${c.message}`;
    case 'file': return `file:${c.path}`;
    case 'pregate-receipt': return `pregate-receipt:${c.pr}${c.head ? `@${c.head}` : ''}`;
    case 'cell-status': return `cell-status:${c.cell}=${c.owner ? `owner=${c.owner}` : c.status}`;
    case 'seat-idle': return `seat-idle:${c.seat}`;
    case 'mail-from': return `mail-from:${c.seat}`;
  }
}

/** Kinds a sender states as the awaited OUTCOME (a ledger watch) — the rest are timers or reply-waits. */
export const WATCH_KINDS: ReadonlySet<WaitCondition['kind']> = new Set(['pr-merged', 'review', 'file', 'pregate-receipt', 'cell-status', 'seat-idle', 'mail-from']);

// ── 깨우개 저장소 ────────────────────────────────────────────────────────────────────

/** cancelled = 약속이 닫혀(done·blocked·dropped) 더 깨울 일이 없다(COMMITMENT-CLOSE). */
export type WakerStatus = 'armed' | 'fired' | 'expired' | 'cancelled';

export interface WakerRecord {
  id: string;
  seat: string;
  commitmentId: string;
  /** 정규형 조건. */
  condition: string;
  armedAt: string;
  /** 지평 끝 — 이때까지 조건이 안 차면 expired. armedAt + min(within, 최대 지평). */
  deadlineAt: string;
  /** time 조건의 발화 시각. */
  fireAt?: string;
  status: WakerStatus;
  checks: number;
  lastCheckedAt?: string;
  closedAt?: string;
  /** cancelled 의 까닭 — 닫은 약속 상태(«commitment done» 등). */
  cancelReason?: string;
  noticeMessageId?: number;
  /** until-loop 를 돌리는 프로세스 — 중복 호출이 두 번째 루프를 띄우지 않게. */
  watcherPid?: number;
  /** MSG-WAIT-CONTRACT — when the one reminder for a mail-reply wait was sent (the horizon then moved +5m). */
  retriedAt?: string;
  /** COND-WATCH — a stated outcome watch: when the condition holds the commitment closes itself (done ⊕ evidence line). */
  autoClose?: true;
  /** COND-WATCH — the evidence line the probe returned when the condition held. */
  evidence?: string;
}

export class WakerBindingError extends Error {
  constructor(message: string) { super(message); this.name = 'WakerBindingError'; }
}

export class WakerHorizonError extends Error {
  constructor(message: string) { super(message); this.name = 'WakerHorizonError'; }
}

export type SelfTimerEmit = (category: string, event: string, data: Record<string, unknown>) => void;

/** 조건 탐침 — 기본은 gh · 리뷰 결과 파일 · 우편 저장소 · 파일 시스템. 시험은 가짜를 넣는다. */
export interface WaitProbes {
  prMerged(pr: number): Promise<boolean>;
  /** sinceIso 뒤에 도착한 리뷰 결과가 있나. */
  reviewArrived(pr: number, sinceIso: string): Promise<boolean>;
  mailReplied(messageId: number): Promise<boolean>;
  fileExists(path: string): Promise<boolean>;
  // COND-WATCH probes — each returns the evidence line when the condition holds, null when not yet. Optional so older
  // fakes still type-check; a missing probe is a probe error (the waker stays pending and expires loudly).
  pregateReceipt?(pr: number, head: string | undefined): Promise<string | null>;
  cellStatus?(cell: string): Promise<{ status: string; owner?: string } | null>;
  seatIdle?(seat: string): Promise<boolean>;
  /** Any mail from `from` to `to` stored at or after sinceIso — the mail id, or null. */
  mailFrom?(from: string, to: string, sinceIso: string): Promise<number | null>;
  /** OP-CLOSE-ON-OUTCOME — the assignee seat's pane in one line (state · last screen line), null when unknown. */
  seatPane?(seat: string): Promise<string | null>;
}

export interface SelfTimerDeps {
  /** 깨우개 디렉터리 — 기본 `<state>/commitments/wakers`. */
  root?: string;
  ledger?: CommitmentLedger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  emit?: SelfTimerEmit;
  probes?: WaitProbes;
  /** 자리 주소로 notice 우편 — 돌려준 값은 우편 id. */
  postNotice?: (seat: string, body: string) => Promise<number | null>;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /**
   * HAND-RAISE-LADDER preemption — asked between polls of a blocking watch: a line («✋ arrived: …») ends the watch early
   * (`preempted`, the waker stays armed) so a coordinator is never deaf to a ✋ while it waits. null = keep waiting.
   */
  preempt?: () => Promise<string | null> | string | null;
  /**
   * MSG-WAIT-CONTRACT — what a `mail-reply:` waker does at its horizon instead of expiring: one reminder to the
   * counterpart (then +5m), then a cancel with a result (asker notice ⊕ coordinator once). Default: the mail ledger —
   * except when probes are injected (tests) and no contract is given, where the old «expired» path stays.
   * Returning null (message unknown) falls back to «expired».
   */
  waitContract?: WaitContractPort | null;
  /**
   * COND-WATCH event trigger — paths whose change should re-measure a watch now instead of at the next poll
   * (pregate receipt directory · a watched file's parent). Default: fs.watch on those paths — except when probes are
   * injected (tests) and no trigger is given, where the fake clock's sleep stays the only wait. null = poll only.
   */
  trigger?: ((paths: readonly string[]) => WatchTrigger | null) | null;
  /**
   * RAIL30 ⑥ — is the process that started this blocking watch still there? false = the parent TUI died (the watcher was
   * re-parented to pid 1): the watch ends `orphaned`, the waker stays armed for `wait-tick`. Checked at least every
   * {@link SELF_TIMER_PARENT_CHECK_MS}. Absent = no check (tests · `--arm-only`).
   */
  parentAlive?: () => boolean;
}

/** An event source that ends a poll sleep early. */
export interface WatchTrigger { next(ms: number): Promise<void>; close(): void }

export interface WaitContractPort {
  retry(seat: string, messageId: number, waitedMs: number): Promise<{ mailId: number } | null>;
  cancel(seat: string, messageId: number, waitedMs: number): Promise<{ result: string; noticeId: number } | null>;
}

/** With a preempt probe the blocking watch never sleeps longer than this between checks. */
export const SELF_TIMER_PREEMPT_POLL_MS = 10_000;

interface Resolved {
  root: string;
  ledger: CommitmentLedger;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  emit: SelfTimerEmit;
  probes: WaitProbes;
  postNotice: (seat: string, body: string) => Promise<number | null>;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  waitContract: WaitContractPort | null;
}

/** The waker directory (`<state>/commitments/wakers`). */
export function defaultWakersRoot(): string { return join(defaultCommitmentRoot(), 'wakers'); }

function resolveDeps(deps: SelfTimerDeps): Resolved {
  return {
    root: deps.root ?? defaultWakersRoot(),
    ledger: deps.ledger ?? new CommitmentLedger(),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    newId: deps.newId ?? (() => `w-${randomUUID().slice(0, 8)}`),
    emit: deps.emit ?? ((category, event, data) => debug.log(category, event, data)),
    probes: deps.probes ?? defaultWaitProbes(),
    postNotice: deps.postNotice ?? defaultPostNotice,
    pid: deps.pid ?? process.pid,
    isPidAlive: deps.isPidAlive ?? defaultPidAlive,
    waitContract: deps.waitContract !== undefined ? deps.waitContract : deps.probes ? null : defaultWaitContract,
  };
}

function shared(deps: SelfTimerDeps, r: Resolved): SelfTimerDeps { return { ...deps, ...r }; }

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function wakerFile(root: string, seat: string): string { return join(root, `${seat.replace(/[^A-Z0-9_-]/g, '_')}.json`); }

function readWakers(root: string, seat: string): WakerRecord[] {
  const path = wakerFile(root, seat);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { wakers?: WakerRecord[] };
  return Array.isArray(parsed.wakers) ? parsed.wakers : [];
}

function writeWakers(root: string, seat: string, wakers: WakerRecord[]): void {
  mkdirSync(root, { recursive: true });
  const path = wakerFile(root, seat);
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, wakers }, null, 2)}\n`);
  renameSync(tmp, path);
}

function updateWaker(r: Resolved, seat: string, id: string, patch: Partial<WakerRecord>): WakerRecord {
  const wakers = readWakers(r.root, seat);
  const index = wakers.findIndex(w => w.id === id);
  if (index < 0) throw new Error(`waker not found: ${seat}/${id}`);
  const next = { ...wakers[index]!, ...patch };
  wakers[index] = next;
  writeWakers(r.root, seat, wakers);
  return next;
}

export function listWakers(seat: string, deps: SelfTimerDeps = {}): WakerRecord[] {
  return readWakers(resolveDeps(deps).root, canonicalSeatId(seat));
}

// ── 걸기 ───────────────────────────────────────────────────────────────────────────

export interface ArmWakerInput {
  seat: string;
  commitmentId: string;
  condition: string | WaitCondition;
  /** 기다림 상한 — 없으면 mail-reply 는 10분(MSG-WAIT-CONTRACT) · 그 밖은 최대 지평. 최대 지평보다 길면 거부. */
  withinMs?: number;
  cwd?: string;
  /** COND-WATCH — close the bound commitment (done ⊕ evidence) when the condition holds. */
  autoClose?: boolean;
}

export interface ArmWakerResult {
  waker: WakerRecord;
  /** 같은 항목·같은 조건의 살아 있는 깨우개에 합쳐졌다. */
  merged: boolean;
  commitment: CommitmentEntry;
}

export function armWaker(input: ArmWakerInput, deps: SelfTimerDeps = {}): ArmWakerResult {
  const r = resolveDeps(deps);
  const seat = canonicalSeatId(input.seat);
  const commitment = r.ledger.get(seat, input.commitmentId);
  if (!commitment) throw new WakerBindingError(`waker must bind to a ledger entry — ${seat}/${input.commitmentId} not found (record it first)`);
  if (COMMITMENT_TERMINAL.has(commitment.status)) {
    throw new WakerBindingError(`waker must bind to a live ledger entry — ${seat}/${input.commitmentId} is ${commitment.status}`);
  }
  const parsed = typeof input.condition === 'string' ? parseWaitCondition(input.condition, input.cwd) : input.condition;
  const condition = formatWaitCondition(parsed);
  const withinMs = input.withinMs ?? (parsed.kind === 'mail-reply' ? SELF_TIMER_MAIL_REPLY_DEFAULT_MS : SELF_TIMER_MAX_HORIZON_MS);
  if (!(withinMs > 0) || withinMs > SELF_TIMER_MAX_HORIZON_MS) {
    throw new WakerHorizonError(`--within exceeds the max horizon (${SELF_TIMER_MAX_HORIZON_MS / 60_000}m) — longer waits go to the ledger as blocked with a reason`);
  }
  if (parsed.kind === 'time' && parsed.ms > withinMs) {
    throw new WakerHorizonError(`${condition} is beyond its horizon (${withinMs / 60_000}m)`);
  }

  const wakers = readWakers(r.root, seat);
  const same = wakers.find(w => w.status === 'armed' && w.commitmentId === commitment.id && w.condition === condition);
  if (same) {
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.merged, { seat, wakerId: same.id, commitmentId: commitment.id, condition });
    return { waker: same, merged: true, commitment };
  }
  const armed = r.now();
  const waker: WakerRecord = {
    id: r.newId(), seat, commitmentId: commitment.id, condition,
    armedAt: armed.toISOString(),
    deadlineAt: new Date(armed.getTime() + (parsed.kind === 'time' ? parsed.ms : withinMs)).toISOString(),
    ...(parsed.kind === 'time' ? { fireAt: new Date(armed.getTime() + parsed.ms).toISOString() } : {}),
    status: 'armed', checks: 0,
    ...(input.autoClose ? { autoClose: true as const } : {}),
  };
  writeWakers(r.root, seat, [...wakers, waker]);
  const bound = r.ledger.attachWaker(seat, commitment.id, { wakerId: waker.id, condition });
  r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.armed, {
    seat, wakerId: waker.id, commitmentId: commitment.id, condition, deadlineAt: waker.deadlineAt,
  });
  if (waker.autoClose) r.emit(COMMITMENT_WATCH_CATEGORY, COMMITMENT_WATCH_EVENTS.armed, { kind: parsed.kind, seat, wakerId: waker.id, commitmentId: commitment.id, condition });
  return { waker, merged: false, commitment: bound };
}

// ── 한 번 재기 ────────────────────────────────────────────────────────────────────────

export type WakerTick = { outcome: 'fired' | 'expired' | 'pending' | 'closed' | 'cancelled'; waker: WakerRecord };

/** COND-WATCH metrics — `commitment.watch.armed|satisfied|expired {kind}` (category commitment). */
export const COMMITMENT_WATCH_CATEGORY = 'commitment';
export const COMMITMENT_WATCH_EVENTS = {
  armed: 'commitment.watch.armed',
  satisfied: 'commitment.watch.satisfied',
  expired: 'commitment.watch.expired',
} as const;

function needProbe<T>(probe: T | undefined, kind: string): T {
  if (probe === undefined) throw new Error(`no probe for ${kind}`);
  return probe;
}

/** One measurement: met ⊕ the evidence line a watch closes its commitment with. */
async function conditionMet(r: Resolved, waker: WakerRecord, now: Date): Promise<{ met: boolean; evidence: string }> {
  const c = parseWaitCondition(waker.condition);
  const yes = (met: boolean, evidence: string) => ({ met, evidence });
  switch (c.kind) {
    case 'time': return yes(now.getTime() >= Date.parse(waker.fireAt ?? waker.deadlineAt), `time reached ${waker.fireAt ?? waker.deadlineAt}`);
    case 'pr-merged': return yes(await r.probes.prMerged(c.pr), `PR #${c.pr} merged`);
    case 'review': return yes(await r.probes.reviewArrived(c.pr, waker.armedAt), `review on PR #${c.pr} after ${waker.armedAt}`);
    case 'mail-reply': return yes(await r.probes.mailReplied(c.message), `reply to mail #${c.message}`);
    case 'file': return yes(await r.probes.fileExists(c.path), `file exists ${c.path}`);
    case 'pregate-receipt': {
      const line = await needProbe(r.probes.pregateReceipt, c.kind).call(r.probes, c.pr, c.head);
      return yes(line !== null, line ?? '');
    }
    case 'cell-status': {
      const cell = await needProbe(r.probes.cellStatus, c.kind).call(r.probes, c.cell);
      if (!cell) return yes(false, '');
      const met = c.owner !== undefined ? (cell.owner ?? '').toUpperCase().split('/')[0] === c.owner : cell.status === c.status;
      return yes(met, `cell ${c.cell} status=${cell.status}${cell.owner ? ` owner=${cell.owner}` : ''}`);
    }
    case 'seat-idle': return yes(await needProbe(r.probes.seatIdle, c.kind).call(r.probes, c.seat), `seat ${c.seat} idle`);
    case 'mail-from': {
      const id = await needProbe(r.probes.mailFrom, c.kind).call(r.probes, c.seat, waker.seat, waker.armedAt);
      return yes(id !== null, `mail #${id} from ${c.seat}`);
    }
  }
}

/**
 * OP-CLOSE-ON-OUTCOME — measure a done-when predicate once, from facts (the same probes a watch uses).
 * `met` true/false with the evidence line, or `missing` with why the facts could not be read (never a guess).
 */
export type PredicateResult = { kind: 'met'; evidence: string } | { kind: 'not-met'; evidence: string } | { kind: 'missing'; reason: string };
export async function measurePredicate(condition: string, input: { seat: string; sinceIso: string }, deps: SelfTimerDeps = {}): Promise<PredicateResult> {
  const r = resolveDeps(deps);
  const now = r.now();
  const probeWaker: WakerRecord = { id: 'predicate', seat: canonicalSeatId(input.seat), commitmentId: 'predicate', condition,
    armedAt: input.sinceIso, deadlineAt: now.toISOString(), status: 'armed', checks: 0 };
  try {
    const { met, evidence } = await conditionMet(r, probeWaker, now);
    return met ? { kind: 'met', evidence } : { kind: 'not-met', evidence: evidence || `${condition} does not hold` };
  } catch (error) {
    return { kind: 'missing', reason: String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}

/** OP-CLOSE-ON-OUTCOME — the one-line verdict a check-at wake and the digest carry. */
export function formatPredicateLine(condition: string, result: PredicateResult): string {
  if (result.kind === 'met') return `done-when ${condition} = HOLDS · facts: ${result.evidence}`;
  if (result.kind === 'not-met') return `done-when ${condition} = NOT MET · facts: ${result.evidence}`;
  return `done-when ${condition} = FACTS MISSING · ${result.reason}`;
}

/** 닫는 문 안내 — 실제로 있는 도구·CLI 이름만 적는다(#160639·#160695: 없는 «원장 done» 을 찾다 NEED HUMAN). */
export function formatCloseHint(commitmentId: string): string {
  return `닫기: CommitmentClose(id=${commitmentId}, status=done, evidence=<근거 한 줄>) 또는 eln commitment done ${commitmentId} --evidence "<근거>"`
    + ` · 막혔으면 status=blocked / eln commitment blocked ${commitmentId} --evidence "<사유>"`
    + ` · 다른 손으로 넘겼으면 status=reassigned / eln commitment reassigned ${commitmentId} --evidence "<누구에게·왜>"`
    + ' · done-when 이 있으면 done 은 그 조건이 사실로 찰 때만 받는다(회신·«기존 수행선 유지»는 완료가 아니다)';
}

/** COND-WATCH — the one wake a satisfied watch sends: the evidence line, and the commitment is already closed. */
export function formatSatisfiedNotice(w: WakerRecord, commitment: CommitmentEntry | undefined, evidence: string, closed: boolean): string {
  return `✅ watch satisfied · ${w.condition} · ${evidence} · commitment ${w.commitmentId}${commitment ? ` «${commitment.text}»` : ''}`
    + (closed ? ' — closed done with this evidence; no reply was needed' : ` — close it: ${formatCloseHint(w.commitmentId)}`);
}

export function formatFiredNotice(w: WakerRecord, commitment: CommitmentEntry | undefined): string {
  return `⏰ 깨우개 발화 · ${w.condition} · 약속 ${w.commitmentId}${commitment ? ` «${commitment.text}»` : ''} — 조건이 찼다, 이 약속을 이어서 한다`
    + ` (${formatCloseHint(w.commitmentId)})`;
}

export function formatExpiredNotice(w: WakerRecord, commitment: CommitmentEntry | undefined, facts?: { predicate?: string; pane?: string }): string {
  return `⌛ 깨우개 만료(expired) · ${w.condition} · ${w.armedAt} ~ ${w.deadlineAt} 안에 조건이 안 찼다 · 약속 ${w.commitmentId}`
    + `${commitment ? ` «${commitment.text}»` : ''}`
    + (facts?.predicate ? `\n  ${facts.predicate}` : '')
    + (facts?.pane ? `\n  ${commitment?.assignee ?? 'assignee'} pane: ${facts.pane}` : '')
    + `\n  — 다시 걸거나 정리한다 (${formatCloseHint(w.commitmentId)})`;
}

/**
 * 약속이 닫히면 그 약속의 armed 깨우개를 모두 cancelled 로 — 더 발화·만료 notice 를 내지 않는다.
 * 돌고 있는 until-loop(watchWaker)는 다음 재기에서 status ≠ armed 를 보고 'closed' 로 나간다. 돌려준 값 = 거둔 깨우개.
 */
export function cancelCommitmentWakers(seat: string, commitmentId: string, reason: string, deps: SelfTimerDeps = {}): WakerRecord[] {
  const r = resolveDeps(deps);
  const s = canonicalSeatId(seat);
  const wakers = readWakers(r.root, s);
  const at = r.now().toISOString();
  const cancelled: WakerRecord[] = [];
  const next = wakers.map(w => {
    if (w.commitmentId !== commitmentId || w.status !== 'armed') return w;
    const closed: WakerRecord = { ...w, status: 'cancelled', closedAt: at, cancelReason: reason };
    cancelled.push(closed);
    return closed;
  });
  if (cancelled.length === 0) return [];
  writeWakers(r.root, s, next);
  for (const w of cancelled) r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.cancelled, { seat: s, wakerId: w.id, commitmentId, condition: w.condition, reason });
  return cancelled;
}

/** 깨우개 하나를 한 번 잰다 — 찼으면 발화 notice, 지평이 지났으면 expired notice, 아니면 그대로. */
export async function evaluateWaker(seat: string, id: string, deps: SelfTimerDeps = {}): Promise<WakerTick> {
  const r = resolveDeps(deps);
  const s = canonicalSeatId(seat);
  const current = readWakers(r.root, s).find(w => w.id === id);
  if (!current) throw new Error(`waker not found: ${s}/${id}`);
  if (current.status !== 'armed') return { outcome: 'closed', waker: current };
  const now = r.now();
  let met = false;
  let evidence = '';
  let probeFailed: string | undefined;
  try {
    ({ met, evidence } = await conditionMet(r, current, now));
  } catch (error) {
    probeFailed = String(error instanceof Error ? error.message : error).slice(0, 200);
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.probeError, { seat: s, wakerId: id, condition: current.condition, error: String(error).slice(0, 200) });
  }
  const checked = { checks: current.checks + 1, lastCheckedAt: now.toISOString() };
  const commitment = r.ledger.get(s, current.commitmentId);
  // 약속이 이미 종단(done·dropped)이면(닫기와 재기 사이 경합) notice 없이 거둔다. blocked 위 깨우개는 그대로 둔다 —
  // blocked 닫기는 close.ts 가 명시로 거둔다.
  if (commitment && COMMITMENT_TERMINAL.has(commitment.status)) {
    cancelCommitmentWakers(s, current.commitmentId, `commitment ${commitment.status}`, shared(deps, r));
    return { outcome: 'closed', waker: readWakers(r.root, s).find(w => w.id === id) ?? current };
  }
  if (met && current.autoClose) {
    // COND-WATCH — mark fired FIRST (a crash after this never wakes twice), then close the commitment, then wake once.
    updateWaker(r, s, id, { ...checked, status: 'fired', closedAt: now.toISOString(), evidence });
    let closed = false;
    if (commitment && !COMMITMENT_TERMINAL.has(commitment.status)) {
      try { r.ledger.markDone(s, current.commitmentId, `watch ${current.condition}: ${evidence}`); closed = true; }
      catch (error) { r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.probeError, { seat: s, wakerId: id, condition: current.condition, error: `auto-close: ${String(error).slice(0, 180)}` }); }
    }
    if (closed) cancelCommitmentWakers(s, current.commitmentId, 'commitment done (watch satisfied)', shared(deps, r));
    const messageId = await r.postNotice(s, formatSatisfiedNotice(current, commitment, evidence, closed));
    const waker = updateWaker(r, s, id, messageId === null ? {} : { noticeMessageId: messageId });
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.fired, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, noticeMessageId: messageId });
    r.emit(COMMITMENT_WATCH_CATEGORY, COMMITMENT_WATCH_EVENTS.satisfied, { kind: parseWaitCondition(current.condition).kind, seat: s, wakerId: id, commitmentId: current.commitmentId, closed, evidence: evidence.slice(0, 200) });
    return { outcome: 'fired', waker };
  }
  if (met) {
    const messageId = await r.postNotice(s, formatFiredNotice(current, commitment));
    const waker = updateWaker(r, s, id, { ...checked, status: 'fired', closedAt: now.toISOString(), ...(messageId === null ? {} : { noticeMessageId: messageId }) });
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.fired, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, noticeMessageId: messageId });
    return { outcome: 'fired', waker };
  }
  if (now.getTime() >= Date.parse(current.deadlineAt)) {
    // MSG-WAIT-CONTRACT — a reply wait never just expires: one reminder to the counterpart (+5m), then a cancel with a result.
    const cond = parseWaitCondition(current.condition);
    if (cond.kind === 'mail-reply' && r.waitContract) {
      const waitedMs = now.getTime() - Date.parse(current.armedAt);
      try {
        if (!current.retriedAt) {
          const retried = await r.waitContract.retry(s, cond.message, waitedMs);
          if (retried) {
            const waker = updateWaker(r, s, id, { ...checked, retriedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + MSG_WAIT_RETRY_GRACE_MS).toISOString() });
            r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.retried, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, mailId: retried.mailId });
            return { outcome: 'pending', waker };
          }
        } else {
          const cancelled = await r.waitContract.cancel(s, cond.message, waitedMs);
          if (cancelled) {
            const waker = updateWaker(r, s, id, { ...checked, status: 'cancelled', closedAt: now.toISOString(), cancelReason: cancelled.result, noticeMessageId: cancelled.noticeId });
            r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.cancelled, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, reason: cancelled.result, noticeMessageId: cancelled.noticeId });
            return { outcome: 'cancelled', waker };
          }
        }
      } catch (error) {
        r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.probeError, { seat: s, wakerId: id, condition: current.condition, error: `wait-contract: ${String(error).slice(0, 180)}` });
      }
    }
    const expiring = updateWaker(r, s, id, { ...checked, status: 'expired', closedAt: now.toISOString() });
    // OP-CLOSE-ON-OUTCOME — the check-at wake carries the predicate result from facts (and the assignee's pane when known).
    const predicateCond = commitment?.doneWhen ?? (cond.kind === 'time' || cond.kind === 'mail-reply' ? undefined : current.condition);
    const predicate = predicateCond === undefined ? undefined
      : predicateCond === current.condition ? formatPredicateLine(predicateCond, evidence ? { kind: 'not-met', evidence } : probeFailed ? { kind: 'missing', reason: probeFailed } : { kind: 'not-met', evidence: `${predicateCond} does not hold` })
        : formatPredicateLine(predicateCond, await measurePredicate(predicateCond, { seat: s, sinceIso: current.armedAt }, shared(deps, r)));
    let pane: string | undefined;
    if (commitment?.assignee && r.probes.seatPane) {
      try { pane = (await r.probes.seatPane(commitment.assignee)) ?? undefined; } catch (error) { pane = `facts missing (${String(error).slice(0, 80)})`; }
    }
    const messageId = await r.postNotice(s, formatExpiredNotice(current, commitment, { ...(predicate ? { predicate } : {}), ...(pane ? { pane } : {}) }));
    const waker = messageId === null ? expiring : updateWaker(r, s, id, { noticeMessageId: messageId });
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.expired, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, noticeMessageId: messageId });
    if (current.autoClose) r.emit(COMMITMENT_WATCH_CATEGORY, COMMITMENT_WATCH_EVENTS.expired, { kind: parseWaitCondition(current.condition).kind, seat: s, wakerId: id, commitmentId: current.commitmentId });
    return { outcome: 'expired', waker };
  }
  return { outcome: 'pending', waker: updateWaker(r, s, id, checked) };
}

/** 일정 틱용 — 자리(없으면 전 자리)의 armed 깨우개를 한 번씩 잰다. 루프 없음 · 바로 끝난다. */
export async function tickWakers(seat: string | undefined, deps: SelfTimerDeps = {}): Promise<WakerTick[]> {
  const r = resolveDeps(deps);
  const seats = seat !== undefined ? [canonicalSeatId(seat)]
    : existsSync(r.root) ? readdirSync(r.root).filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length)) : [];
  const out: WakerTick[] = [];
  for (const s of seats) {
    for (const w of readWakers(r.root, s).filter(x => x.status === 'armed')) out.push(await evaluateWaker(s, w.id, { ...deps, ...r }));
  }
  return out;
}

/** 다음 점검까지 기다릴 시간 — 백오프 간격을 지평 끝·발화 시각에서 자른다. */
export function nextPollDelay(interval: number, waker: WakerRecord, nowMs: number): number {
  const until = Math.min(Date.parse(waker.deadlineAt), waker.fireAt ? Date.parse(waker.fireAt) : Number.POSITIVE_INFINITY) - nowMs;
  return Math.max(0, Math.min(interval, until));
}

export function nextBackoff(interval: number): number {
  return Math.min(interval * SELF_TIMER_BACKOFF_FACTOR, SELF_TIMER_POLL_MAX_MS);
}

/**
 * 상한 있는 until-loop — 발화 또는 만료로 반드시 끝난다(지평 ≤ 최대 지평). 같은 깨우개를 다른 살아 있는 프로세스가
 * 이미 지켜보고 있으면 두 번째 루프를 돌지 않고 바로 'watched-elsewhere' 로 나간다.
 */
/** RAIL30 ⑥ — how often a blocking watch checks that its parent is still alive (4 orphans on ppid 1 · 11-25). */
export const SELF_TIMER_PARENT_CHECK_MS = 30_000;

/** The production parent probe: the parent pid this process started with is still its parent (not re-parented to 1). */
export function parentAliveProbe(ppidAtStart: number = process.ppid, currentPpid: () => number = () => process.ppid): (() => boolean) | undefined {
  if (!Number.isInteger(ppidAtStart) || ppidAtStart <= 1) return undefined; // started detached on purpose: no parent to follow
  return () => currentPpid() === ppidAtStart;
}

export async function watchWaker(seat: string, id: string, deps: SelfTimerDeps = {}): Promise<WakerTick | { outcome: 'watched-elsewhere'; waker: WakerRecord } | { outcome: 'preempted'; waker: WakerRecord; line: string } | { outcome: 'orphaned'; waker: WakerRecord }> {
  const r = resolveDeps(deps);
  const s = canonicalSeatId(seat);
  const current = readWakers(r.root, s).find(w => w.id === id);
  if (!current) throw new Error(`waker not found: ${s}/${id}`);
  if (current.status !== 'armed') return { outcome: 'closed', waker: current };
  if (current.watcherPid !== undefined && current.watcherPid !== r.pid && r.isPidAlive(current.watcherPid)) {
    return { outcome: 'watched-elsewhere', waker: current };
  }
  updateWaker(r, s, id, { watcherPid: r.pid });
  const shared: SelfTimerDeps = { ...deps, ...r };
  // COND-WATCH — a local-ledger watch polls at the 1/min floor (no backoff: the probe is a readdir or one ledger read)
  // and, where a path names the outcome, an fs event re-measures at once. Network probes (gh) keep the backoff.
  const cond = parseWaitCondition(current.condition);
  const steady = current.autoClose === true && LOCAL_WATCH_KINDS.has(cond.kind);
  const paths = watchPathsFor(cond);
  let trigger: WatchTrigger | null = null;
  try { trigger = paths.length === 0 ? null : (deps.trigger !== undefined ? deps.trigger : deps.probes ? null : defaultFsTrigger)?.(paths) ?? null; }
  catch { trigger = null; }
  try {
    let interval = SELF_TIMER_POLL_MIN_MS;
    for (;;) {
      const tick = await evaluateWaker(s, id, shared);
      if (tick.outcome !== 'pending') return tick;
      let line: string | null = null;
      try { line = deps.preempt ? await deps.preempt() : null; }
      catch (error) { r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.probeError, { seat: s, wakerId: id, condition: tick.waker.condition, error: `preempt: ${String(error).slice(0, 180)}` }); }
      if (line) {
        r.emit('needhuman', 'needhuman.preempted-wait', { seat: s, wakerId: id, condition: tick.waker.condition });
        return { outcome: 'preempted', waker: tick.waker, line };
      }
      const delay = nextPollDelay(interval, tick.waker, r.now().getTime());
      const ms = deps.preempt ? Math.min(delay, SELF_TIMER_PREEMPT_POLL_MS) : delay;
      if (deps.parentAlive) {
        // RAIL30 ⑥ — sleep in parent-check slices; a dead parent ends the watch (the waker stays armed for wait-tick).
        let left = ms;
        let orphaned = false;
        for (;;) {
          if (!deps.parentAlive()) { orphaned = true; break; }
          if (left <= 0) break;
          const slice = Math.min(left, SELF_TIMER_PARENT_CHECK_MS);
          if (trigger) { await trigger.next(slice); break; }
          await r.sleep(slice);
          left -= slice;
        }
        if (orphaned) {
          const waker = updateWaker(r, s, id, { watcherPid: undefined });
          r.emit(SELF_TIMER_LOG_CATEGORY, 'self-timer.orphaned', { seat: s, wakerId: id, condition: waker.condition });
          return { outcome: 'orphaned', waker };
        }
      } else await (trigger ? trigger.next(ms) : r.sleep(ms));
      if (!steady) interval = nextBackoff(interval);
    }
  } finally { trigger?.close(); }
}

/** Watches whose probe reads a local ledger (no network) — polled at the floor, never backed off. */
export const LOCAL_WATCH_KINDS: ReadonlySet<WaitCondition['kind']> = new Set(['file', 'pregate-receipt', 'cell-status', 'mail-from', 'seat-idle']);

/** Paths whose change can satisfy the condition (fs event trigger). */
export function watchPathsFor(c: WaitCondition, env: NodeJS.ProcessEnv = process.env): string[] {
  if (c.kind === 'pregate-receipt') return [pregateGreenDir(env)];
  if (c.kind === 'file') return [dirname(c.path)];
  return [];
}

/** fs.watch on existing paths; a change (or the timeout) resolves `next`. Missing paths → no trigger (poll only). */
function defaultFsTrigger(paths: readonly string[]): WatchTrigger | null {
  const { watch } = require('node:fs') as typeof import('node:fs');
  const watchers: import('node:fs').FSWatcher[] = [];
  let pending: (() => void) | null = null;
  let fired = false;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try { watchers.push(watch(p, { persistent: false }, () => { fired = true; pending?.(); })); } catch { /* poll only */ }
  }
  if (watchers.length === 0) return null;
  return {
    next(ms) {
      if (fired) { fired = false; return Promise.resolve(); }
      return new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); pending = null; fired = false; resolve(); }
        pending = done;
      });
    },
    close() { for (const w of watchers) { try { w.close(); } catch { /* closed */ } } pending?.(); },
  };
}

// ── 기본 탐침·notice ─────────────────────────────────────────────────────────────────

function spawnJson(cmd: string[]): unknown {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`${cmd[0]} ${cmd[1]} exited ${proc.exitCode}`);
  return JSON.parse(proc.stdout.toString());
}

/** 리뷰 결과 파일 저장소(TA `review-results/<card>-<pr>-<head12>.json` · review-result-capture.ts) 안에 sinceIso 뒤 결과가 있나. */
export function reviewResultFileArrived(dir: string, pr: number, sinceIso: string, parse: (text: string) => { pr?: number } | null): boolean {
  if (!existsSync(dir)) return false;
  const since = Date.parse(sinceIso);
  const marker = `-${pr}-`;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || !name.includes(marker)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < since) continue;
      const parsed = parse(readFileSync(path, 'utf8'));
      if (parsed && (parsed.pr === undefined || parsed.pr === pr)) return true;
    } catch { /* 읽기 실패는 «아직» — 다음 점검이 다시 본다 */ }
  }
  return false;
}

export function defaultWaitProbes(): WaitProbes {
  return {
    async prMerged(pr) {
      const v = spawnJson(['gh', 'pr', 'view', String(pr), '--json', 'state']) as { state?: string };
      return v.state === 'MERGED';
    },
    async reviewArrived(pr, sinceIso) {
      const { taskAgentStatePath } = await import('../task-agent/task-card-state.js');
      const { parseReviewResultOutput } = await import('../task-agent/review-result-capture.js');
      if (reviewResultFileArrived(join(dirname(taskAgentStatePath()), 'review-results'), pr, sinceIso, parseReviewResultOutput)) return true;
      const v = spawnJson(['gh', 'pr', 'view', String(pr), '--json', 'reviews']) as { reviews?: { submittedAt?: string }[] };
      const since = Date.parse(sinceIso);
      return (v.reviews ?? []).some(x => typeof x.submittedAt === 'string' && Date.parse(x.submittedAt) >= since);
    },
    async mailReplied(messageId) {
      // MSG-WAIT-CONTRACT — a linked reply, or ANY later mail from the counterpart to the asker (sender match).
      const { openMsgStoreReadOnly } = await import('./msg-store.js');
      const { replyMatchLogged } = await import('./msg-wait-contract.js');
      const store = openMsgStoreReadOnly();
      try {
        const question = store.getMessage(messageId);
        if (!question) return store.listReplies(messageId, 1).length > 0;
        return replyMatchLogged(store, question) !== null;
      } finally { store.close(); }
    },
    async fileExists(path) { return existsSync(path); },
    async pregateReceipt(pr, head) {
      const dir = pregateGreenDir();
      const lane = findPregateReceipt(dir, pr, head);
      return lane === null ? null : `receipt ${join(dir, lane)}`;
    },
    async cellStatus(cell) {
      const { checklistDevVersion, listChecklist } = await import('../release-loop/checklist.js');
      const item = listChecklist(checklistDevVersion()).items.find((x) => x.id === cell);
      return item ? { status: item.status, ...(item.owner ? { owner: item.owner } : {}) } : null;
    },
    async seatIdle(seat) {
      // The els journal answer (one socket call · no screen reading): every pane of the seat reports idle.
      const listed = spawnJson(['els', 'ls', '--json']) as { panes?: { seat?: string | null; state?: string; status?: { state?: string } | null }[] };
      const panes = (listed.panes ?? []).filter((p) => (p.seat ?? '').toUpperCase() === seat);
      return panes.length > 0 && panes.every((p) => (p.status?.state ?? p.state ?? '').toUpperCase() === 'IDLE');
    },
    async seatPane(seat) {
      // One els journal read (no screen scrape): the seat's pane state and title.
      const listed = spawnJson(['els', 'ls', '--json']) as { panes?: { seat?: string | null; state?: string; title?: string | null; status?: { state?: string; detail?: string | null } | null }[] };
      const panes = (listed.panes ?? []).filter((p) => (p.seat ?? '').toUpperCase() === seat.toUpperCase());
      if (panes.length === 0) return null;
      return panes.map((p) => `${(p.status?.state ?? p.state ?? '?').toUpperCase()}${p.status?.detail ? ` ${p.status.detail}` : p.title ? ` ${p.title}` : ''}`).join(' | ').slice(0, 240);
    },
    async mailFrom(from, to, sinceIso) {
      const { openMsgStoreReadOnly } = await import('./msg-store.js');
      const store = openMsgStoreReadOnly();
      try {
        const row = store.db.query('SELECT id FROM msg_messages WHERE sender = ? AND recipient = ? AND created_at >= ? ORDER BY id ASC LIMIT 1')
          .get(canonicalSeatId(from), canonicalSeatId(to), sinceIso) as { id: number } | null;
        return row ? row.id : null;
      } finally { store.close(); }
    },
  };
}

/** MSG-WAIT-CONTRACT production port — the mail ledger ⊕ the federation ladder (coordinator = parentOf(seat)). */
const defaultWaitContract: WaitContractPort = {
  async retry(seat, messageId, waitedMs) {
    const { openMsgStore } = await import('./msg-store.js');
    const { postWaitRetry } = await import('./msg-wait-contract.js');
    const store = openMsgStore();
    try {
      const m = store.getMessage(messageId);
      if (!m) return null;
      const counterpart = canonicalSeatId(m.from) === seat ? m.to : m.from;
      return { mailId: postWaitRetry(store, { messageId, asker: seat, counterpart }, waitedMs).mail.id };
    } finally { store.close(); }
  },
  async cancel(seat, messageId, waitedMs) {
    const { openMsgStore } = await import('./msg-store.js');
    const { postWaitCancel } = await import('./msg-wait-contract.js');
    const { loadFederationLadder } = await import('./hand-raise-ladder.js');
    const store = openMsgStore();
    try {
      const m = store.getMessage(messageId);
      if (!m) return null;
      const counterpart = canonicalSeatId(m.from) === seat ? m.to : m.from;
      const ladder = (() => { try { return loadFederationLadder(); } catch { return null; } })();
      const done = postWaitCancel(store, { messageId, asker: seat, counterpart }, waitedMs, ladder ? { parentOf: ladder.parentOf } : {});
      return { result: done.result, noticeId: done.noticeId };
    } finally { store.close(); }
  },
};

/** 기본 notice — `msg post` 와 같은 길(영속 우편 ⊕ 받는 자리 깨움 · 깨움 실패는 우편 성패를 바꾸지 않는다). */
async function defaultPostNotice(seat: string, body: string): Promise<number | null> {
  // MAIL-ANTI-FLOOD F — a seat's own waker notice is a scheduled wake, not a mailbox row (11-25: 228 of OP's 1068 mails
  // were these). The seat's TUI drains the self-wake ledger into its ScheduleWakeup door. A failed append falls back to
  // the old mail row (nothing is dropped).
  try {
    const { appendDiverted } = await import('./diverted-mail.js');
    appendDiverted('self-wake', { seat, from: seat, kind: SELF_TIMER_NOTICE_KIND, body, at: new Date().toISOString() });
    return null;
  } catch { /* fall back to the mail row below */ }
  const { openMsgStore } = await import('./msg-store.js');
  const store = openMsgStore();
  let id: number;
  try { id = store.post({ from: seat, to: seat, kind: SELF_TIMER_NOTICE_KIND, body }).id; } finally { store.close(); }
  try {
    const { wakeRecipient } = await import('../loops/msg-wake.js');
    await wakeRecipient(seat, id, { from: seat, kind: SELF_TIMER_NOTICE_KIND });
  } catch { /* 깨움은 fail-open — 우편은 이미 영속이고 자동 깨움(seat-autowake)이 안 읽은 우편을 본다 */ }
  return id;
}
