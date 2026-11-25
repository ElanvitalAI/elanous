// AUTOPILOT-GOAL-DRIVE (대표 11-25 16:1x «goal 턴이 왜 이렇게 빨리 끝나나») — a goal turn that ends with work it can do now
// continues in the same session instead of waiting for a wake.
//
// S: eln OP's autopilot turns ended after 27–59 s («X는 아직 … 다음은 Y» · «16:18에 다시 확인 (ScheduleWakeup)») while the
//    pinned goal was open. turnEnded() saw the model's own ScheduleWakeup as «a wake is scheduled → arm nothing» and the
//    shortest self wake was 5 min — so every goal turn ended in a wait, never in the next step.
// C: never loop on volume (back-off rules stay), never run over a person, an approval, or a failure; the model's wake can
//    still be the right call when it truly waits on someone.
// Q: from which STRUCTURED facts may the turn end continue now?
// A: this pure judge. Continue when an open (not done, not parked) goal is active, the turn did not fail, nothing waits on
//    a person / approval / a reply / a background agent, the same reply did not repeat 3 turns in a row, and either
//    (1) the model set its own ScheduleWakeup due within {@link DRIVE_SHORT_WAKE_MS} in this turn (it planned to come back
//    soon — the work it could do now remains), or (2) the turn made a state-changing call (it is moving: keep it moving), or
//    (3) the turn end left an open continuation (requirement / goal-continue armed). Never prose: no regex on the reply.
//    Bounded: at most {@link DRIVE_MAX_CONTINUES} continuations per goal per {@link DRIVE_WINDOW_MS}.
//
// 세 얼굴: 관측 = debug.log('autopilot', 'drive-continue' | 'drive-stop', {reason, goal, streak}) · 판단 근거 = {@link decideGoalDrive}
// · 수복과 인계 = the continuation turn (same session) · stop → the model's own wake / the autopilot cadence wake as before.

/** At most this many immediate continuations per goal inside {@link DRIVE_WINDOW_MS}. */
export const DRIVE_MAX_CONTINUES = 3;
export const DRIVE_WINDOW_MS = 30 * 60_000;
/** A model-set wake due sooner than this = «I'll come back soon» — the drive continues now instead. */
export const DRIVE_SHORT_WAKE_MS = 20 * 60_000;

export const DRIVE_CONTINUE_PROMPT = (goal: string): string =>
  `🚗 자율주행 · 골 미완: ${goal}\n`
  + '방금 턴이 다음 단계를 남기고 끝났다. 지금 할 수 있는 다음 단계를 바로 이어서 한다(깨움을 기다리지 않는다). '
  + '정말로 다른 자리·외부 결과만 기다리는 상태면 무엇을 기다리는지 한 줄로 말하고 멈춘다. 골이 끝났으면 goal_done 으로 닫는다.';

/**
 * HAND-PULL-FIRST (대표 11-25 17:1x «work assignment is PULL-first») — a HAND seat whose cell closed (green/done/landed)
 * or that holds no cell takes the next cell itself in the same session: `eln work next` (exit 3 = «일감 0» → one line, end).
 * Guarded by `workNextAvailable` (the installed eln answers `eln work next --help`).
 */
export const DRIVE_HAND_PULL_PROMPT = (cell: HandCellState): string =>
  `🚗 자율주행 · ${cell === 'closed' ? '내 칸이 닫혔다(green·done·PR 착지)' : cell === 'waiting' ? '내 칸이 남을 기다린다(판정·영수·HOLD·답신) — 기다리는 칸은 일이 아니다' : '내 칸이 없다'}\n`
  + (cell === 'waiting' ? '다른 자리의 승인·HOLD·결정을 기다리는 칸이면 먼저 `eln work block <칸> --on <그 자리> --reason "<한 줄>"` 로 보드에 돌려놓는다. ' : '')
  + '기다리지 말고 지금 `eln work next` 를 실행해 다음 칸을 가져가 이 턴 안에서 바로 시작한다. '
  + '`eln work next` 가 exit 3 이면 «일감 0» 한 줄로 턴을 닫는다.';

/** waiting = every open cell waits on someone else (verdict · receipt · HOLD · a reply) — rail 30 (11-25 18:2x). */
export type HandCellState = 'open' | 'closed' | 'none' | 'waiting';
export interface HandPullInput {
  /** The hand's own cell: open (work left) · closed (green/done/landed) · none (no cell owned). */
  readonly cell: HandCellState;
  /** `eln work next --help` succeeded (#40096 is installed). */
  readonly workNextAvailable: boolean;
}

/** Cell statuses that mean «this cell is finished» (checklist status · lower-cased). */
export const CLOSED_CELL_STATUSES: readonly string[] = ['green', 'done', 'landed', 'merged', 'closed', 'complete', 'completed'];

/** The hand's cell state from the current release's cells (owner match is case-insensitive). */
export function handCellState(seat: string, cells: readonly { readonly status: string; readonly owner: string | null }[]): HandCellState {
  const mine = cells.filter((cell) => (cell.owner ?? '').trim().toUpperCase() === seat.trim().toUpperCase());
  if (mine.length === 0) return 'none';
  return mine.some((cell) => !CLOSED_CELL_STATUSES.includes(cell.status.trim().toLowerCase())) ? 'open' : 'closed';
}

export type DriveSignal = 'model-wake-short' | 'progress' | 'open-work' | 'hand-pull';
export type DriveStop = 'no-goal' | 'failed' | 'paused' | 'backoff' | 'person-input' | 'needs-human' | 'waiting-reply'
  | 'agents-running' | 'no-progress' | 'repeat-tool' | 'cap' | 'no-signal' | 'standing-goal' | 'no-ledger-progress' | 'blocked';

export type DriveVerdict = { readonly kind: 'continue'; readonly signal: DriveSignal } | { readonly kind: 'stop'; readonly reason: DriveStop };

export interface DriveInput {
  /** The open goal's id (first-class or pin) — undefined when none is open (done · parked · none). */
  readonly goalId?: string;
  readonly failed: boolean;
  readonly paused: boolean;
  readonly backoff: boolean;
  /** A person's queued line (TUI typed · not a notice). */
  readonly personQueued: number;
  /** A needs-human block (approval · HITL) is open. */
  readonly needsHuman: boolean;
  readonly waitingOn: number;
  readonly backgroundRunning: number;
  /** The same reply 3 drive turns in a row (the same blocker 3 consecutive turns — codex ext/goal · grok-build backoff). */
  readonly sameReply: boolean;
  /** The drive turn repeated the previous drive turn's tool calls exactly (same names and args) — a loop, not progress. */
  readonly repeatToolCall?: boolean;
  /** Delay (ms) of the earliest ScheduleWakeup the model set in THIS turn; undefined = it set none. */
  readonly modelWakeInMs?: number;
  readonly stateChanged?: boolean;
  /** Fresh, goal-scoped progress evidence, consumed once by the caller; never a global ledger change. */
  readonly goalProgress?: boolean;
  readonly openWork?: boolean;
  /**
   * GOAL-DRIVE-NARROW (CEO 11-25 17:1x) — the open goal is a TASK goal (structured done check · `goal:task` · a crown
   * directive). false = a standing/KPI goal: never continued, checked on the periodic cadence only. undefined = not judged.
   */
  readonly taskGoal?: boolean;
  /** GOAL-DRIVE-NARROW — the previous drive turn changed nothing in the ledger (cells · PR · receipt · ✋ · goal progress). */
  readonly ledgerUnchanged?: boolean;
  /** GOAL-DRIVE-NARROW — the goal is blocked (3 drive turns in a row changed nothing) until the ledger moves. */
  readonly blocked?: boolean;
  /** HAND-PULL-FIRST — present only on a hand seat (never a coordinator). */
  readonly handPull?: HandPullInput;
  /** Epoch ms of earlier continuations for this goal (any window — the judge filters). */
  readonly history: readonly number[];
  readonly now: number;
}

/** GOAL-DRIVE-NARROW — consecutive drive turns with no ledger change before the goal is marked blocked (codex ext/goal). */
export const DRIVE_BLOCK_AFTER_UNCHANGED = 3;

/** The goal facts that make a goal a TASK goal (structured fields only — never the goal's prose). */
export interface GoalTaskFacts {
  /** A structured done check (pr-merged · checklist · file · mail). */
  readonly hasCheck: boolean;
  /** Explicitly set as a task (`eln autopilot goal set --task` → ref `goal:task` · a crown→pin directive). */
  readonly taskFlag: boolean;
  /** A crown directive id carried by the goal. */
  readonly crownDirective: boolean;
}
export function isTaskGoal(f: GoalTaskFacts): boolean {
  return f.hasCheck || f.taskFlag || f.crownDirective;
}

/** Pure — in order: goal · failure · paused/backoff · person · approval · waits · no-progress · repeat-tool · standing/blocked/ledger · cap · signal. */
export function decideGoalDrive(input: DriveInput): DriveVerdict {
  const stop = (reason: DriveStop): DriveVerdict => ({ kind: 'stop', reason });
  // HAND-PULL-FIRST — a hand with a closed cell or none pulls the next one even without an open goal.
  // PULL-CLAIMABLE-WAITING (rail 30) — an open cell whose turn ended waiting on someone else (waitingOn > 0) is a waiting
  // cell: the hand pulls `eln work next` meanwhile (WIP counts active work only; work next hands an active cell back first).
  const cellWaits = input.handPull !== undefined && (input.handPull.cell === 'waiting' || (input.handPull.cell === 'open' && input.waitingOn > 0));
  const pull = input.handPull !== undefined && (input.handPull.cell !== 'open' || cellWaits) && input.handPull.workNextAvailable;
  if (!input.goalId && !pull) return stop('no-goal');
  if (input.failed) return stop('failed');
  if (input.paused) return stop('paused');
  if (input.backoff) return stop('backoff');
  if (input.personQueued > 0) return stop('person-input');
  if (input.needsHuman) return stop('needs-human');
  // Waiting on a reply never blocks a hand's pull — that is exactly when it takes the next cell.
  if (input.waitingOn > 0 && !pull) return stop('waiting-reply');
  if (input.backgroundRunning > 0) return stop('agents-running');
  if (input.sameReply) return stop('no-progress');
  if (input.repeatToolCall === true) return stop('repeat-tool');
  if (input.goalId && !pull) {
    if (input.taskGoal === false) return stop('standing-goal');
    if (input.blocked === true) return stop('blocked');
    if (input.ledgerUnchanged === true) return stop('no-ledger-progress');
  }
  if (driveWindow(input.history, input.now).length >= DRIVE_MAX_CONTINUES) {
    if (!pull && input.goalId && input.goalProgress === true) return { kind: 'continue', signal: 'progress' };
    return stop('cap');
  }
  if (pull) return { kind: 'continue', signal: 'hand-pull' };
  if (input.modelWakeInMs !== undefined && input.modelWakeInMs < DRIVE_SHORT_WAKE_MS) return { kind: 'continue', signal: 'model-wake-short' };
  if (input.stateChanged === true) return { kind: 'continue', signal: 'progress' };
  if (input.openWork === true) return { kind: 'continue', signal: 'open-work' };
  return stop('no-signal');
}

/** The continuations still inside the window (the rest are forgotten on save). */
export function driveWindow(history: readonly number[], now: number): number[] {
  return history.filter((at) => at <= now && now - at < DRIVE_WINDOW_MS);
}

/**
 * The earliest ScheduleWakeup the model set in this turn, from its tool rows (structured: tool name + `delaySeconds`).
 * Undefined when it set none or the args carry no delay.
 */
export function modelWakeDelayMs(rows: readonly { readonly role?: string; readonly toolName?: string; readonly toolArgs?: unknown }[]): number | undefined {
  let best: number | undefined;
  for (const row of rows) {
    if (row.role !== 'tool' || row.toolName !== 'ScheduleWakeup') continue;
    const args = row.toolArgs as { delaySeconds?: unknown } | null | undefined;
    const seconds = typeof args?.delaySeconds === 'number' ? args.delaySeconds : typeof args?.delaySeconds === 'string' ? Number(args.delaySeconds) : NaN;
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const delay = seconds * 1000;
    best = best === undefined ? delay : Math.min(best, delay);
  }
  return best;
}
