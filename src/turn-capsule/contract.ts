/**
 * TURN-CAPSULE-EVENTS contract (내부 문서 `TURN-CAPSULE-EVENTS` §3) — the shared names every lane builds on.
 *
 * Principle (CEO, 11-18): no capsule (subagent · harness child · long shell · graph run · long MCP call) may hijack the
 * main turn; the seat can always talk to the outside. A capsule runs detached, its completion comes back as an event,
 * and that event opens a new turn through the one door.
 *
 * This file is types, constants and event ordering — no wiring. Lane B
 * (capsule host · completion frames), lane C (event bus · the door) and lane A (capsule policy) implement against it;
 * the SIM-WORLD-CAPSULE-EVENTS devices use the same names. Capsule behavior has no switch.
 */

// ── Capsules ──────────────────────────────────────────────────────────────────────────────────────────────
export const CAPSULE_KINDS = ['shell', 'agent', 'harness', 'graph', 'mcp'] as const;
export type CapsuleKind = (typeof CAPSULE_KINDS)[number];

export type CapsuleStatus = 'ok' | 'failed' | 'timeout' | 'cancelled';

/** One folded progress line of a running capsule (the «key activity» line, cell CAPSULE-B3). */
export interface CapsuleProgressEvent {
  readonly type: 'capsule-progress';
  readonly capsuleId: string;
  readonly kind: CapsuleKind;
  readonly sessionId: string;
  readonly at: number;
  readonly line: string;
}

/** A capsule finished (any status). It returns to the main loop as a turn event (source `capsule-done`). */
export interface CapsuleDoneEvent {
  readonly type: 'capsule-done';
  readonly capsuleId: string;
  readonly kind: CapsuleKind;
  readonly sessionId: string;
  readonly seat?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: CapsuleStatus;
  /** Short, already-redacted summary for the notice turn — never raw tool output. */
  readonly summary: string;
}

export type CapsuleEvent = CapsuleProgressEvent | CapsuleDoneEvent;

// ── Turn events (one bus) ─────────────────────────────────────────────────────────────────────────────────
/** Highest priority first. A person always goes before anything automatic. */
export const TURN_EVENT_SOURCES = ['human', 'urgent-mail', 'capsule-done', 'wakeup', 'mail', 'watch'] as const;
export type TurnEventSource = (typeof TURN_EVENT_SOURCES)[number];

export interface TurnEvent {
  readonly id: string;
  readonly source: TurnEventSource;
  /** Same key = same logical event (msgId · wakeupId · capsuleId); a second publish is a duplicate, never a second turn. */
  readonly dedupeKey: string;
  readonly arrivedAt: number;
  /** Latest useful delivery time; past it the event is still delivered (late), never dropped silently. */
  readonly deliverBy?: number;
  readonly text: string;
  readonly capsule?: CapsuleDoneEvent;
}

/** Bus order: source priority, then arrival, then id — total and deterministic. */
export function compareTurnEvents(a: TurnEvent, b: TurnEvent): number {
  const rank = TURN_EVENT_SOURCES.indexOf(a.source) - TURN_EVENT_SOURCES.indexOf(b.source);
  if (rank !== 0) return rank;
  if (a.arrivedAt !== b.arrivedAt) return a.arrivedAt - b.arrivedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How a batch left the door (v1.1 · JUD FU 1):
 * - responded — the turn answered: events are done (seen).
 * - failed    — the turn errored: events go back to waiting with the source's backoff.
 * - cancelled — a person cancelled the turn: events go back to waiting at once, no backoff (they were not wrong).
 * - stopped   — a cap or the system stopped the turn (wall cap · shutdown): events go back to waiting at once and the
 *               next offer carries the checkpoint; never counted as a failure.
 */
export type TurnEventOutcome = 'responded' | 'failed' | 'cancelled' | 'stopped';
export const TURN_EVENT_OUTCOMES: readonly TurnEventOutcome[] = ['responded', 'failed', 'cancelled', 'stopped'];

/** Lane C (CAPSULE-C1). Sources publish only through adapters; the door is the only consumer. */
export interface TurnEventBus {
  publish(event: TurnEvent): { readonly duplicate: boolean };
  /** Waiting events in bus order, without taking them. */
  pending(): readonly TurnEvent[];
  /** Up to `max` events in bus order, moved to in-flight until acked. */
  take(max: number): readonly TurnEvent[];
  /** See {@link TurnEventOutcome}: responded → done · failed → waiting with backoff · cancelled/stopped → waiting now. */
  ack(ids: readonly string[], outcome: TurnEventOutcome): void;
}

// ── The one door (lane C · CAPSULE-C2) ────────────────────────────────────────────────────────────────────
export interface DoorReservation {
  readonly token: string;
  readonly reservedAt: number;
}

export type DoorOfferReason = 'event' | 'turn-end' | 'boot' | 'watchdog';

/** Why the door would not reserve: a turn is already reserved/running, or a person is typing (a person goes first). */
export type DoorRefusal = 'busy' | 'human-first';
export type DoorReserveResult =
  | { readonly ok: true; readonly reservation: DoorReservation }
  | { readonly ok: false; readonly refusal: DoorRefusal };

// ── Turn state machine (v1.1 · JUD FU 3) ─────────────────────────────────────────────────────────────────
/** idle → reserved (reserve) → running (start) → closing (end) → idle (batch acked). reserved → idle = start never came. */
export const TURN_STATES = ['idle', 'reserved', 'running', 'closing'] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  idle: ['reserved'],
  reserved: ['running', 'idle'],
  running: ['closing'],
  closing: ['idle'],
};

export function canTurnTransition(from: TurnState, to: TurnState): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

export interface TurnDoor {
  /** Something may be waiting: the door decides (idle · no human typing) and starts at most one turn. */
  offer(reason: DoorOfferReason): void;
  /** Synchronous: marks busy before any await, so two offers can never open two turns (v1.1 · JUD FU 2: the refusal says why). */
  reserve(): DoorReserveResult;
  start(reservation: DoorReservation, batch: readonly TurnEvent[]): void;
  end(reservation: DoorReservation, outcome: TurnEventOutcome): void;
  busy(): boolean;
}

// ── Capsule policy (lane A · CAPSULE-A1) ──────────────────────────────────────────────────────────────────
/** Longest a capsule may hold the main turn synchronously before it is detached. 출처: CEO principle 11-18 18:1x («짧은 상한 · 예 10초»). */
export const CAPSULE_SYNC_CAP_MS = 10_000;
/**
 * RUNSHELL-BG-ENDS-TURN (0.3.37 P1) — a shell call (RunShell · Bash) holds the turn this long before it detaches.
 * 출처: codex keeps the turn while a command runs; Claude Code waits up to a timeout — 10s cut seat `eln` bundles,
 * focused tests and pregate mid-answer (opus «shell only» 8/12 runs ended early). Tuned by `turn.shellSyncCapMs`.
 */
export const SHELL_SYNC_CAP_MS = 60_000;

/**
 * RUNSHELL-BG-ENDS-TURN ② — the repo's known long runners start in the background (completion wake armed) instead of
 * holding the turn for the cap first. Matched on the argv's executable + subcommand, never on prose.
 * 출처: 대표 safeguard (OP 11-25) — pregate, `els update-all`, rail scripts, `bun run test:deterministic` (unambiguous runners only).
 */
export const KNOWN_LONG_SHELL_RUNNERS: readonly { readonly label: string; readonly match: (argv: readonly string[]) => boolean }[] = [
  { label: 'bun run test:deterministic', match: (a) => a[0] === 'bun' && a[1] === 'run' && a[2] === 'test:deterministic' },
  // Plain `bun test` / `bun run test` are not listed (Terra r3): whether a run is full or focused depends on its
  // arguments, so they take the 60 s wait → background + wake like any other command.
  { label: 'pregate', match: (a) => /^python3?$/.test(a[0] ?? '') && baseName(a[1]) === 'pregate.py' },
  { label: 'els update-all', match: (a) => a[0] === 'els' && a[1] === 'update-all' },
  { label: 'rail script', match: (a) => isRailScript(a[0]) || ((a[0] === 'bash' || a[0] === 'sh' || a[0] === 'zsh') && isRailScript(a[1])) },
];

function baseName(path: string | undefined): string { return (path ?? '').split('/').pop() ?? ''; }
function isRailScript(path: string | undefined): boolean { const b = baseName(path); return b.startsWith('rail-') && b.endsWith('.sh'); }

/** argv of a shell call: RunShell's array as is; a Bash string split on whitespace (leading `VAR=x` and `timeout N`
 *  wrappers skipped). Only the leading words matter, so quoting inside later arguments never changes the verdict. */
export function shellArgvOf(command: string | readonly string[]): readonly string[] {
  const words = typeof command === 'string' ? command.trim().split(/\s+/).filter(Boolean) : [...command];
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  if (words[i] === 'timeout' && /^\d+[smh]?$/.test(words[i + 1] ?? '')) i += 2;
  return words.slice(i).map((word, n) => (n === 0 ? baseName(word) || word : word));
}

/** The known-long runner this command is, or null. */
export function knownLongShellRunner(command: string | readonly string[]): string | null {
  const argv = shellArgvOf(command);
  return KNOWN_LONG_SHELL_RUNNERS.find((runner) => runner.match(argv))?.label ?? null;
}

/** RUNSHELL-BG-ENDS-TURN — an A2 shell capsule id (`shell-<b36>-<n>`): its started result promised the turn a wake on
 *  completion. `shell:<handle>` (explicit `mode:'bg'`) and other kinds stay passive results. */
export function isPromisedWakeCapsule(event: { readonly kind: string; readonly capsuleId: string }): boolean {
  return event.kind === 'shell' && /^shell-[0-9a-z]+-\d+$/.test(event.capsuleId);
}

export interface CapsuleDecisionInput {
  readonly tool: string;
  readonly kind: CapsuleKind | null;
  readonly requestedBackground?: boolean;
}

export interface CapsuleDecision {
  readonly mode: 'sync' | 'detach';
  /** For `sync`: how long the main turn may wait before handing the capsule to the background. */
  readonly syncCapMs: number;
  readonly reason: string;
}

export interface CapsulePolicy {
  decide(input: CapsuleDecisionInput): CapsuleDecision;
}

// ── No switches (대표 11-18 21:5x CAPSULE-FLAGS-REMOVE-DEFAULT) ─────────────────────────────────────────────────
// The capsule path is the only path: no `turn.capsuleMode`, no `turn.capsuleStages`, no env override. The way back is a revert PR.
