// SEAT-IDLE-STALL-SENTINEL — OP 의 30분 손 점검을 1분 감독 루프로 흡수한다(PLAN-PROACTIVE-1117 §4 · 대표 11-17).
// 이 파일은 순수 판정만 한다: 자리 하나의 스냅샷(상태 · 활동 표본 · 할 일 · 미ack 배정 우편) ⊕ 시계 ⊕ 정책 →
// ok | stalled | idling | mail-missed | unknown ⊕ 증거 ⊕ 처방 제안(wake · continue · restart-proposal · notify-op).
// 관측(수집기)은 seat-sentinel-collect.ts, 한 번의 틱(수집 → 판정 → 사건 · 그림자 처방)은 seat-sentinel-tick.ts.
import type { GraphViewEvent, GraphViewStageStatus } from '../graph-view/model.js';

/** Pane state as the sentinel reads it. `running` = an agent turn is in flight; `blocked` = waiting on an approval prompt. */
export type SeatPaneStatus = 'running' | 'idle' | 'blocked' | 'dead' | 'unknown';
export type SeatRoute = 'herdr' | 'tmux' | 'none';
export type SeatHealthVerdict = 'ok' | 'stalled' | 'idling' | 'mail-missed' | 'unknown';
export type SeatPrescription = 'none' | 'wake' | 'continue' | 'restart-proposal' | 'notify-op';

/** One observation of a seat. `fingerprint` is a normalized screen hash; `tokens` a cumulative token counter when known. */
export interface SeatActivitySample {
  readonly at: number;
  readonly status: SeatPaneStatus;
  readonly fingerprint?: string;
  readonly tokens?: number;
}

/** A source the sentinel could not read stays typed as unknown with its reason — never silently «0». */
export type Known<T> = { readonly known: true; readonly value: T } | { readonly known: false; readonly reason: string };

export interface SeatUnackedMail { readonly id: number; readonly from: string; readonly createdAt: number }

export interface SeatHealthSnapshot {
  readonly seat: string;
  readonly host: string;
  readonly route: SeatRoute;
  /** Where the current status came from (herdr agent_status · screen markers · none) — evidence only. */
  readonly statusSource: string;
  /** Samples oldest → newest; the newest is this tick's observation. */
  readonly samples: readonly SeatActivitySample[];
  /** Time of the last visible completed turn / output (epoch ms) when the screen shows one. */
  readonly lastOutputAt?: number;
  /** Open work the seat owns (plan items · owned checklist cells), by id. */
  readonly openWork: Known<readonly string[]>;
  /** Unacked mail addressed to the seat. */
  readonly mail: Known<readonly SeatUnackedMail[]>;
}

export interface SeatSentinelPolicy {
  readonly stallMinutes: number;
  readonly restartProposalMinutes: number;
  readonly idleWithWorkMinutes: number;
  readonly mailUnackedMinutes: number;
  readonly assignmentSenders: readonly string[];
  readonly sampleRetentionMinutes: number;
  readonly actuateCooldownMinutes: number;
}

// 출처: PLAN-PROACTIVE-1117 §4 «running + 토큰 변화 0 N분» — N 미정(OP 확정 대상). OP 손 점검 주기 30분의 절반:
// 감시는 점검보다 먼저 봐야 한다. E·D 실측(30분+ 무변화)이 이 선을 넘는다.
export const SEAT_SENTINEL_STALL_MINUTES = 15;
// 출처: PLAN-PROACTIVE-1117 §4 «재기동 제안» — 정체가 이 선을 넘으면 «계속» 대신 재기동 제안. MOB-1 셸 63분 정체(A201 #38024 이전)가
// 이 선 위, E·D 30분대는 아래(먼저 «계속»).
export const SEAT_SENTINEL_RESTART_PROPOSAL_MINUTES = 45;
// 출처: OP tools/idle-nudge.sh «쉰 지 4분»(대표 11-06 21:1x «자리 세션들이 많이 논다 → 빨리») — 할 일 있는 놀기의 선.
export const SEAT_SENTINEL_IDLE_WITH_WORK_MINUTES = 4;
// 출처: PLAN-PROACTIVE-1117 §3 SEAT-MAIL-ACK-SLA «N분 안에 ack» — N 미정. msg-wake WAKE_DEBOUNCE_MS(5분) 의 두 배:
// 깨움 한 번 ⊕ 재두드림 한 번 뒤에도 ack 0 이면 수신 누락.
export const SEAT_SENTINEL_MAIL_UNACKED_MINUTES = 10;
// 출처: RES tools/seat-main-liveness.py pending_op_rows(sender='OP') — 배정 우편 = OP 가 보낸 것.
export const SEAT_SENTINEL_ASSIGNMENT_SENDERS: readonly string[] = ['OP'];
// 출처: 재기동 제안 선을 판정하려면 그만큼의 표본이 남아 있어야 한다 — 재기동 선 ⊕ 정체 선만큼 여유.
export const SEAT_SENTINEL_SAMPLE_RETENTION_MINUTES = SEAT_SENTINEL_RESTART_PROPOSAL_MINUTES + SEAT_SENTINEL_STALL_MINUTES;
// 출처: OP tools/idle-nudge.sh «같은 패널 15분에 한 번»(900초).
export const SEAT_SENTINEL_ACTUATE_COOLDOWN_MINUTES = 15;
// 출처: PLAN-PROACTIVE-1117 §4 «1분마다».
export const SEAT_SENTINEL_TICK_MINUTES = 1;

export const DEFAULT_SEAT_SENTINEL_POLICY: SeatSentinelPolicy = {
  stallMinutes: SEAT_SENTINEL_STALL_MINUTES,
  restartProposalMinutes: SEAT_SENTINEL_RESTART_PROPOSAL_MINUTES,
  idleWithWorkMinutes: SEAT_SENTINEL_IDLE_WITH_WORK_MINUTES,
  mailUnackedMinutes: SEAT_SENTINEL_MAIL_UNACKED_MINUTES,
  assignmentSenders: SEAT_SENTINEL_ASSIGNMENT_SENDERS,
  sampleRetentionMinutes: SEAT_SENTINEL_SAMPLE_RETENTION_MINUTES,
  actuateCooldownMinutes: SEAT_SENTINEL_ACTUATE_COOLDOWN_MINUTES,
};

const MS_PER_MINUTE = 60_000;

export interface SeatHealthFinding {
  readonly verdict: Exclude<SeatHealthVerdict, 'ok' | 'unknown'>;
  readonly prescription: SeatPrescription;
  /** Stable reason tag: no-progress · blocked-prompt · pane-dead · idle-with-work · unacked-assignment. */
  readonly reason: string;
}

export interface SeatHealthEvidence {
  readonly status: SeatPaneStatus;
  readonly statusSource: string;
  readonly route: SeatRoute;
  readonly host: string;
  /** Minutes the seat has been running with no fingerprint/token change (running/blocked only). */
  readonly unchangedMinutes?: number;
  /** Minutes the seat has been idle (idle only). */
  readonly idleMinutes?: number;
  readonly openWork: number | 'unknown';
  readonly openWorkIds?: readonly string[];
  readonly unackedAssignments?: ReadonlyArray<{ readonly id: number; readonly from: string; readonly ageMinutes: number }>;
  readonly unknown?: readonly string[];
}

export interface SeatHealthResult {
  readonly seat: string;
  readonly verdict: SeatHealthVerdict;
  readonly prescription: SeatPrescription;
  readonly reason: string;
  readonly findings: readonly SeatHealthFinding[];
  readonly evidence: SeatHealthEvidence;
}

function sameActivity(a: SeatActivitySample, b: SeatActivitySample): boolean {
  if (a.tokens !== undefined && b.tokens !== undefined) return a.tokens === b.tokens;
  return a.fingerprint !== undefined && a.fingerprint === b.fingerprint;
}

/** Start of the newest uninterrupted run of samples that share `newest`'s status (and, when `sameScreen`, its activity). */
function streakStart(samples: readonly SeatActivitySample[], sameScreen: boolean): number | undefined {
  const newest = samples.at(-1);
  if (!newest) return undefined;
  let start = newest.at;
  for (let index = samples.length - 2; index >= 0; index--) {
    const sample = samples[index]!;
    if (sample.status !== newest.status) break;
    if (sameScreen && !sameActivity(sample, newest)) break;
    start = sample.at;
  }
  return start;
}

const minutesSince = (now: number, at: number): number => Math.max(0, Math.floor((now - at) / MS_PER_MINUTE));

/**
 * Classify one seat. Pure: no I/O, no wall clock (the caller passes `now`).
 * Precedence when several findings hold: stalled > mail-missed > idling. All findings are returned.
 */
export function classifySeatHealth(snapshot: SeatHealthSnapshot, now: Date, policy: SeatSentinelPolicy = DEFAULT_SEAT_SENTINEL_POLICY): SeatHealthResult {
  const nowMs = now.getTime();
  const samples = [...snapshot.samples].filter((sample) => sample.at <= nowMs).sort((a, b) => a.at - b.at);
  const status = samples.at(-1)?.status ?? 'unknown';
  const unknown: string[] = [];
  const findings: SeatHealthFinding[] = [];

  const openWork = snapshot.openWork.known ? snapshot.openWork.value : null;
  if (!snapshot.openWork.known) unknown.push(`openWork:${snapshot.openWork.reason}`);
  if (!snapshot.mail.known) unknown.push(`mail:${snapshot.mail.reason}`);
  if (status === 'unknown') unknown.push(`status:${snapshot.statusSource}`);

  let unchangedMinutes: number | undefined;
  let idleMinutes: number | undefined;
  if (status === 'running' || status === 'blocked') {
    const start = streakStart(samples, status === 'running');
    // A sample without fingerprint/tokens is no evidence of «no change»: the streak is just this tick.
    // `lastOutputAt` is the last *completed* turn — not evidence about an in-flight one — so only samples count here.
    unchangedMinutes = start === undefined ? 0 : minutesSince(nowMs, start);
    if (unchangedMinutes >= policy.stallMinutes) {
      if (status === 'blocked') findings.push({ verdict: 'stalled', prescription: 'notify-op', reason: 'blocked-prompt' });
      else findings.push({ verdict: 'stalled', reason: 'no-progress',
        prescription: unchangedMinutes >= policy.restartProposalMinutes ? 'restart-proposal' : 'continue' });
    }
  } else if (status === 'idle') {
    const start = streakStart(samples, false);
    const fromStreak = start === undefined ? 0 : minutesSince(nowMs, start);
    const fromOutput = snapshot.lastOutputAt === undefined ? 0 : minutesSince(nowMs, snapshot.lastOutputAt);
    idleMinutes = Math.max(fromStreak, fromOutput);
  } else if (status === 'dead' && (openWork?.length ?? 0) > 0) {
    findings.push({ verdict: 'stalled', prescription: 'restart-proposal', reason: 'pane-dead' });
  }

  const overdue = snapshot.mail.known
    ? snapshot.mail.value
      .filter((mail) => policy.assignmentSenders.includes(mail.from))
      .map((mail) => ({ id: mail.id, from: mail.from, ageMinutes: minutesSince(nowMs, mail.createdAt) }))
      .filter((mail) => mail.ageMinutes >= policy.mailUnackedMinutes)
    : [];
  if (overdue.length) findings.push({ verdict: 'mail-missed', reason: 'unacked-assignment',
    // Only an idle pane can safely take a wake line; any other state (running · blocked · dead · no route) goes to OP.
    prescription: status === 'idle' && snapshot.route !== 'none' ? 'wake' : 'notify-op' });

  if (status === 'idle' && openWork !== null && openWork.length > 0 && (idleMinutes ?? 0) >= policy.idleWithWorkMinutes)
    findings.push({ verdict: 'idling', prescription: snapshot.route === 'none' ? 'notify-op' : 'wake', reason: 'idle-with-work' });

  const rank: Record<SeatHealthFinding['verdict'], number> = { stalled: 0, 'mail-missed': 1, idling: 2 };
  findings.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  const primary = findings[0];
  const verdict: SeatHealthVerdict = primary?.verdict ?? (status === 'unknown' ? 'unknown' : 'ok');
  const evidence: SeatHealthEvidence = {
    status, statusSource: snapshot.statusSource, route: snapshot.route, host: snapshot.host,
    ...(unchangedMinutes !== undefined ? { unchangedMinutes } : {}),
    ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    openWork: openWork === null ? 'unknown' : openWork.length,
    ...(openWork?.length ? { openWorkIds: openWork.slice(0, 5) } : {}),
    ...(overdue.length ? { unackedAssignments: overdue } : {}),
    ...(unknown.length ? { unknown } : {}),
  };
  return { seat: snapshot.seat, verdict, prescription: primary?.prescription ?? 'none',
    reason: primary?.reason ?? (status === 'unknown' ? 'status-unknown' : 'healthy'), findings, evidence };
}

/** Append this tick's sample and drop samples older than the retention window. Pure. */
export function appendSeatSample(history: readonly SeatActivitySample[], sample: SeatActivitySample, policy: SeatSentinelPolicy = DEFAULT_SEAT_SENTINEL_POLICY): SeatActivitySample[] {
  const floor = sample.at - policy.sampleRetentionMinutes * MS_PER_MINUTE;
  return [...history.filter((row) => row.at >= floor && row.at < sample.at), sample];
}

const WORKER_STATUS: Record<SeatHealthVerdict, GraphViewStageStatus> = {
  ok: 'done', unknown: 'skipped', stalled: 'failed', 'mail-missed': 'failed', idling: 'failed',
};

/**
 * One supervision loop per tick in the graph-view grammar (내부 문서 `GRAPH-LOOP-VIEW`):
 * stages observe → judge → prescribe, one worker per seat (lane = host), one decision.made per finding (route code),
 * and a waiting checkpoint on prescribe when a finding needs OP (notify-op · restart-proposal).
 */
export function seatSentinelGraphEvents(results: readonly SeatHealthResult[], at: number, opts: { loopId: string; actuate: boolean }): GraphViewEvent[] {
  const { loopId } = opts;
  const events: GraphViewEvent[] = [
    { type: 'loop.started', loopId, at, kind: 'seat_sentinel', lead: 'seat-sentinel', title: opts.actuate ? 'seat supervision' : 'seat supervision · shadow' },
    { type: 'stage.changed', loopId, at, stage: 'observe', label: 'observe', status: 'done' },
    { type: 'stage.changed', loopId, at, stage: 'judge', label: 'judge', status: 'running' },
  ];
  for (const result of results)
    events.push({ type: 'worker.changed', loopId, at, worker: result.seat, stage: 'judge', status: WORKER_STATUS[result.verdict],
      lane: result.evidence.host, joinTo: 'prescribe' });
  events.push({ type: 'stage.changed', loopId, at, stage: 'judge', status: 'done' });
  const findings = results.filter((result) => result.verdict !== 'ok' && result.verdict !== 'unknown');
  events.push({ type: 'stage.changed', loopId, at, stage: 'prescribe', label: 'prescribe', status: findings.length ? 'running' : 'done' });
  for (const result of findings)
    events.push({ type: 'decision.made', loopId, at, question: `${result.seat} ${result.verdict} (${result.reason})`,
      choice: opts.actuate ? result.prescription : `${result.prescription} · shadow`, route: 'code' });
  const forOp = findings.filter((result) => result.prescription === 'notify-op' || result.prescription === 'restart-proposal');
  if (forOp.length)
    events.push({ type: 'checkpoint.changed', loopId, at, checkpoint: 'prescribe:op', status: 'waiting', actor: 'OP',
      summary: forOp.map((result) => `${result.seat} ${result.prescription}`).join(' · ') });
  if (findings.length) events.push({ type: 'stage.changed', loopId, at, stage: 'prescribe', status: 'done' });
  events.push({ type: 'loop.ended', loopId, at, status: 'done' });
  return events;
}
