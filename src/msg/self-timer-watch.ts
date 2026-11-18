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
// 규칙(I3): 모든 깨우개는 원장 항목(commitment-ledger.ts)에 묶인다(없거나 닫힌 항목이면 거부) · 최대 지평 · 만료는
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
import { COMMITMENT_TERMINAL, CommitmentLedger, defaultCommitmentRoot, type CommitmentEntry } from '../dashboard/input/commitment-ledger.js';
import { canonicalSeatId } from './msg-store.js';

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
} as const;
/** 발화·만료 notice 의 우편 kind. */
export const SELF_TIMER_NOTICE_KIND = 'notice';

// ── 조건 ───────────────────────────────────────────────────────────────────────────

export type WaitCondition =
  | { kind: 'time'; ms: number }
  | { kind: 'pr-merged'; pr: number }
  | { kind: 'review'; pr: number }
  | { kind: 'mail-reply'; message: number }
  | { kind: 'file'; path: string };

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
    case 'file': {
      if (!value) throw new Error('file condition needs a path');
      return { kind: 'file', path: isAbsolute(value) ? value : resolve(cwd, value) };
    }
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
  }
}

// ── 깨우개 저장소 ────────────────────────────────────────────────────────────────────

export type WakerStatus = 'armed' | 'fired' | 'expired';

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
  noticeMessageId?: number;
  /** until-loop 를 돌리는 프로세스 — 중복 호출이 두 번째 루프를 띄우지 않게. */
  watcherPid?: number;
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
}

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
}

function resolveDeps(deps: SelfTimerDeps): Resolved {
  return {
    root: deps.root ?? join(defaultCommitmentRoot(), 'wakers'),
    ledger: deps.ledger ?? new CommitmentLedger(),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    newId: deps.newId ?? (() => `w-${randomUUID().slice(0, 8)}`),
    emit: deps.emit ?? ((category, event, data) => debug.log(category, event, data)),
    probes: deps.probes ?? defaultWaitProbes(),
    postNotice: deps.postNotice ?? defaultPostNotice,
    pid: deps.pid ?? process.pid,
    isPidAlive: deps.isPidAlive ?? defaultPidAlive,
  };
}

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
  /** 기다림 상한 — 없으면 최대 지평. 최대 지평보다 길면 거부. */
  withinMs?: number;
  cwd?: string;
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
  const withinMs = input.withinMs ?? SELF_TIMER_MAX_HORIZON_MS;
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
  };
  writeWakers(r.root, seat, [...wakers, waker]);
  const bound = r.ledger.attachWaker(seat, commitment.id, { wakerId: waker.id, condition });
  r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.armed, {
    seat, wakerId: waker.id, commitmentId: commitment.id, condition, deadlineAt: waker.deadlineAt,
  });
  return { waker, merged: false, commitment: bound };
}

// ── 한 번 재기 ────────────────────────────────────────────────────────────────────────

export type WakerTick = { outcome: 'fired' | 'expired' | 'pending' | 'closed'; waker: WakerRecord };

async function conditionMet(r: Resolved, waker: WakerRecord, now: Date): Promise<boolean> {
  const c = parseWaitCondition(waker.condition);
  switch (c.kind) {
    case 'time': return now.getTime() >= Date.parse(waker.fireAt ?? waker.deadlineAt);
    case 'pr-merged': return r.probes.prMerged(c.pr);
    case 'review': return r.probes.reviewArrived(c.pr, waker.armedAt);
    case 'mail-reply': return r.probes.mailReplied(c.message);
    case 'file': return r.probes.fileExists(c.path);
  }
}

export function formatFiredNotice(w: WakerRecord, commitment: CommitmentEntry | undefined): string {
  return `⏰ 깨우개 발화 · ${w.condition} · 약속 ${w.commitmentId}${commitment ? ` «${commitment.text}»` : ''} — 조건이 찼다, 이 약속을 이어서 한다`
    + ` (닫을 때는 근거와 함께 원장 done)`;
}

export function formatExpiredNotice(w: WakerRecord, commitment: CommitmentEntry | undefined): string {
  return `⌛ 깨우개 만료(expired) · ${w.condition} · ${w.armedAt} ~ ${w.deadlineAt} 안에 조건이 안 찼다 · 약속 ${w.commitmentId}`
    + `${commitment ? ` «${commitment.text}»` : ''} — 다시 걸거나 원장 blocked(사유)·dropped(사유)로 정리`;
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
  try {
    met = await conditionMet(r, current, now);
  } catch (error) {
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.probeError, { seat: s, wakerId: id, condition: current.condition, error: String(error).slice(0, 200) });
  }
  const checked = { checks: current.checks + 1, lastCheckedAt: now.toISOString() };
  const commitment = r.ledger.get(s, current.commitmentId);
  if (met) {
    const messageId = await r.postNotice(s, formatFiredNotice(current, commitment));
    const waker = updateWaker(r, s, id, { ...checked, status: 'fired', closedAt: now.toISOString(), ...(messageId === null ? {} : { noticeMessageId: messageId }) });
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.fired, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, noticeMessageId: messageId });
    return { outcome: 'fired', waker };
  }
  if (now.getTime() >= Date.parse(current.deadlineAt)) {
    const messageId = await r.postNotice(s, formatExpiredNotice(current, commitment));
    const waker = updateWaker(r, s, id, { ...checked, status: 'expired', closedAt: now.toISOString(), ...(messageId === null ? {} : { noticeMessageId: messageId }) });
    r.emit(SELF_TIMER_LOG_CATEGORY, SELF_TIMER_EVENTS.expired, { seat: s, wakerId: id, commitmentId: current.commitmentId, condition: current.condition, noticeMessageId: messageId });
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
export async function watchWaker(seat: string, id: string, deps: SelfTimerDeps = {}): Promise<WakerTick | { outcome: 'watched-elsewhere'; waker: WakerRecord }> {
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
  let interval = SELF_TIMER_POLL_MIN_MS;
  for (;;) {
    const tick = await evaluateWaker(s, id, shared);
    if (tick.outcome !== 'pending') return tick;
    await r.sleep(nextPollDelay(interval, tick.waker, r.now().getTime()));
    interval = nextBackoff(interval);
  }
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
      const { openMsgStoreReadOnly } = await import('./msg-store.js');
      const store = openMsgStoreReadOnly();
      try { return store.listReplies(messageId, 1).length > 0; } finally { store.close(); }
    },
    async fileExists(path) { return existsSync(path); },
  };
}

/** 기본 notice — `msg post` 와 같은 길(영속 우편 ⊕ 받는 자리 깨움 · 깨움 실패는 우편 성패를 바꾸지 않는다). */
async function defaultPostNotice(seat: string, body: string): Promise<number | null> {
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
