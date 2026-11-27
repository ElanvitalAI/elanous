// SEAT-INPLACE-UPDATE (대표 11-25 20:4x) — a coordinator seat moves to a new installed build in its own pane, at an idle
// turn boundary, instead of the rail closing the pane and opening a new one (6 OP restarts on 11-25, each one cut OP's
// context and self-scheduled promises).
//
// Shape (design B): the pane command is a thin launcher (`seat-launcher.ts`) that runs eln with `--resume <session>`.
// eln exits with SEAT_UPDATE_EXIT_CODE only at an idle boundary; the launcher relaunches the new build in the same pane
// (same pane id, so watchers keep pointing at it). Without the launcher the existing seat-control migrate door
// (execve in place · src/tui/exec-in-place.ts) does the same job.
//
// What crosses the switch:
//   · durable already (files keyed by seat + session): wakeups (seat-state/<SEAT>/wakeups/<session>.json, incl. past-due
//     and folded entries), autopilot state (goal · task pins · goal clearing), the session transcript, provider/model.
//   · volatile → carried here (carry file, read once by the new build): composer draft, queued person lines,
//     pending notices (full texts), held notices.
// Before/after: `snapshotDurable` hashes every durable file at the exit; the new build diffs the same files and reports.
//
// 세 얼굴: 관측 = debug `seat.inplace-update {decide|carry-written|carry-restored|verify}` / 판단 근거 = decideInPlaceUpdate
//          (installed commit ≠ running · idle · nobody typing · outside the release window · entry probe ok) /
//          수복과 인계 = a failed probe or diff keeps the old build and posts ONE card to OPC (the OP coach).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Coordinator + leader seats that update in place. Hands keep the update-all migrate path. */
export const IN_PLACE_SEATS: readonly string[] = ['OP', 'TC', 'UX', 'MK', 'JUD'];
/** EX_TEMPFAIL — «relaunch me on the current install». Any other code is a normal exit or a crash. */
export const SEAT_UPDATE_EXIT_CODE = 75;
/** A person who pressed a key this recently is still typing — the switch waits. */
export const TYPING_QUIET_MS = 20_000;
/** A failed entry probe is retried at most this many times per target commit before the seat stays + one card. */
export const PROBE_ATTEMPTS = 2;

export type InPlaceDecision =
  | { readonly action: 'none'; readonly reason: 'not-a-coordinator' | 'same-build' | 'install-unreadable' | 'already-failed' }
  | { readonly action: 'wait'; readonly reason: 'turn-running' | 'person-typing' | 'queued-person-line' | 'capsule-running' | 'release-window' | 'probe-retry' }
  | { readonly action: 'go'; readonly toCommit: string }
  | { readonly action: 'stay-card'; readonly toCommit: string; readonly reason: 'probe-failed' };

export interface InPlaceInput {
  readonly seat: string | null;
  readonly runningCommit: string | null;
  readonly installedCommit: string | null;
  readonly busy: boolean;
  readonly capsulesActive: boolean;
  readonly draftChars: number;
  readonly queuedPersonLines: number;
  readonly lastHumanKeyAgoMs: number;
  readonly releaseWindow: string | null;
  /** Commits whose probe already failed PROBE_ATTEMPTS times (card sent) — no retry loop. */
  readonly failedCommits: ReadonlySet<string>;
  /** Did `bun <new entry> --version` exit 0? Called only when everything else says go. */
  readonly probe: () => boolean;
  readonly probeFailures?: number;
}

/** Pure — the one judgement. Order matters: the cheap «same build» check first, the probe last. */
export function decideInPlaceUpdate(input: InPlaceInput): InPlaceDecision {
  if (!input.seat || !IN_PLACE_SEATS.includes(input.seat)) return { action: 'none', reason: 'not-a-coordinator' };
  if (!input.installedCommit) return { action: 'none', reason: 'install-unreadable' };
  if (input.runningCommit === input.installedCommit) return { action: 'none', reason: 'same-build' };
  if (input.failedCommits.has(input.installedCommit)) return { action: 'none', reason: 'already-failed' };
  if (input.busy) return { action: 'wait', reason: 'turn-running' };
  if (input.capsulesActive) return { action: 'wait', reason: 'capsule-running' };
  if (input.queuedPersonLines > 0) return { action: 'wait', reason: 'queued-person-line' };
  if (input.draftChars > 0 && input.lastHumanKeyAgoMs < TYPING_QUIET_MS) return { action: 'wait', reason: 'person-typing' };
  if (input.releaseWindow) return { action: 'wait', reason: 'release-window' };
  if (!input.probe()) {
    return (input.probeFailures ?? 0) + 1 >= PROBE_ATTEMPTS
      ? { action: 'stay-card', toCommit: input.installedCommit, reason: 'probe-failed' }
      : { action: 'wait', reason: 'probe-retry' };
  }
  return { action: 'go', toCommit: input.installedCommit };
}

// ── durable snapshot ─────────────────────────────────────────────────────────────────────────────────────────────
export type DurableSnapshot = Readonly<Record<string, string>>;

/** sha256 of each file's bytes (`absent` when missing). Keys are the given labels, not paths. */
export function snapshotDurable(files: Readonly<Record<string, string>>): DurableSnapshot {
  const out: Record<string, string> = {};
  for (const [label, path] of Object.entries(files)) {
    try { out[label] = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent'; }
    catch { out[label] = 'unreadable'; }
  }
  return out;
}

/** Labels whose content changed between the two snapshots (empty = nothing lost). */
export function diffDurable(before: DurableSnapshot, after: DurableSnapshot): string[] {
  const labels = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...labels].filter((label) => before[label] !== after[label]).sort();
}

// ── carry file (volatile state) ──────────────────────────────────────────────────────────────────────────────────
export interface SeatCarry {
  readonly v: 1;
  readonly seat: string;
  readonly sessionId: string;
  readonly fromCommit: string | null;
  readonly toCommit: string;
  readonly writtenAt: number;
  readonly provider?: { readonly provider: string; readonly model?: string };
  readonly draft: string;
  readonly queuedPersonLines: readonly string[];
  readonly notices: readonly { readonly text: string; readonly source: string }[];
  /** FU: in-memory caps (epoch ms of the last act) — e.g. handBlockPullAt (10-min hand-block pull cap). */
  readonly caps?: Readonly<Record<string, number>>;
  readonly durable: DurableSnapshot;
  readonly durableFiles: Readonly<Record<string, string>>;
}

export const carryPath = (root: string, seat: string): string => join(root, 'seat-control', `inplace-carry-${seat}.json`);

/** Atomic write (tmp + rename) — a half-written carry is never read. */
export function writeCarry(root: string, carry: SeatCarry): string {
  const path = carryPath(root, carry.seat);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(carry)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Read once and delete. A carry for another session, or older than maxAgeMs, is dropped (and reported). */
export function takeCarry(root: string, seat: string, sessionId: string | null, now: number, maxAgeMs = 30 * 60_000):
  { readonly carry: SeatCarry | null; readonly dropped?: 'other-session' | 'stale' | 'unreadable' } {
  const path = carryPath(root, seat);
  if (!existsSync(path)) return { carry: null };
  let parsed: SeatCarry | null = null;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as SeatCarry; } catch { parsed = null; }
  try { rmSync(path, { force: true }); } catch { /* next boot drops it as stale */ }
  if (!parsed || parsed.v !== 1) return { carry: null, dropped: 'unreadable' };
  if (sessionId && parsed.sessionId !== sessionId) return { carry: null, dropped: 'other-session' };
  if (now - parsed.writtenAt > maxAgeMs) return { carry: null, dropped: 'stale' };
  return { carry: parsed };
}

/** Restore plan for the new build: what goes back into the composer, the queue and the verify line. */
export function planRestore(carry: SeatCarry, currentDraft: string, afterDurable: DurableSnapshot): {
  readonly draft: string; readonly personLines: readonly string[]; readonly notices: SeatCarry['notices'];
  readonly lost: readonly string[];
} {
  // Keys typed into the new build before the restore ran are kept after the carried draft (never overwritten).
  const draft = currentDraft && carry.draft ? `${carry.draft}${currentDraft}` : carry.draft || currentDraft;
  return { draft, personLines: carry.queuedPersonLines, notices: carry.notices, lost: diffDurable(carry.durable, afterDurable) };
}

export function inPlaceCardBody(seat: string, reason: string, detail: string): string {
  return `[${seat} · in-place update] stayed on the old build — ${reason}: ${detail}. Seat keeps running; next try on the next install.`;
}
