// STEWARD-SPACE (행정관) — the seat activity clock. «Idle since» is NOT els `status.since`: for an eln pane without a
// code report els derives WORKING from PTY output within 30 s, so every redraw (mail badge, status line, a notice landing)
// flips the pane WORKING and restarts `since` — on 11-25 06:37–07:40Z no TC hand ever read more than 6.1 min idle while
// its session showed no model activity for an hour. The clock here is the seat's own session ledger: the last assistant or
// tool row the model wrote (a turn end, a tool call). A notice row (role user) is mail arriving, not work.
// els stays a cross-check only: a pane WORKING continuously for ≥ ELS_CONTINUOUS_WORK_MS is a long tool/model call.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** A model row this recent = the seat is working. */
export const MODEL_ACTIVE_WINDOW_MS = 60_000;
/** els WORKING this long without a break = real work (a long tool or model call writes no row until it ends). */
export const ELS_CONTINUOUS_WORK_MS = 3 * 60_000;
const TAIL_BYTES = 256 * 1024;

/** The eln session a pane runs: `--resume <id>` / `--resume=<id>` / `-r <id>` in its foreground command. */
export function sessionIdOfCommand(command: unknown): string | null {
  if (!Array.isArray(command)) return null;
  const args = command.map(String);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--resume=(.+)$/.exec(a);
    if (m) return valid(m[1]!);
    if ((a === '--resume' || a === '-r') && args[i + 1]) return valid(args[i + 1]!);
  }
  return null;
}
const valid = (id: string): string | null => (/^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null);

/** Epoch ms of the newest model row (role assistant · tool) at or before `asOfMs` in a session jsonl; null = none seen. */
export function lastModelActivityMs(text: string, asOfMs = Number.POSITIVE_INFINITY): number | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let row: { role?: unknown; ts?: unknown };
    try { row = JSON.parse(line) as typeof row; } catch { continue; }
    if (row.role !== 'assistant' && row.role !== 'tool') continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : typeof row.ts === 'number' ? row.ts : NaN;
    if (Number.isFinite(at) && at <= asOfMs) return at;
  }
  return null;
}

/** Reads only the tail of the session file (a seat session is MBs). */
export function sessionModelActivityMs(sessionsDir: string, sessionId: string): number | null {
  const path = join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return lastModelActivityMs(buf.toString('utf8'));
  } finally { closeSync(fd); }
}

export interface ActivityInput {
  /** els activityState (working · idle · blocked · exited · …). */
  readonly els: string;
  /** els `status.since` when its state is WORKING (how long the pane has been WORKING without a break). */
  readonly elsWorkingSinceMs: number | null;
  /** The session clock; undefined = no session known (els decides, as before). */
  readonly modelAtMs: number | null | undefined;
}

/** Activity ⊕ idle duration from the model clock, els as cross-check. Null result = the model clock is unknown. */
export function activityFromClock(input: ActivityInput, nowMs: number): { activity: string; idleForMs: number | null; lastActiveMs: number } | null {
  if (input.modelAtMs === undefined || input.modelAtMs === null) return null;
  if (input.els === 'exited' || input.els === 'blocked') return { activity: input.els, idleForMs: null, lastActiveMs: input.modelAtMs };
  const continuous = input.els === 'working' && input.elsWorkingSinceMs !== null && nowMs - input.elsWorkingSinceMs >= ELS_CONTINUOUS_WORK_MS;
  const last = continuous ? nowMs : input.modelAtMs;
  const quiet = Math.max(0, nowMs - last);
  return quiet < MODEL_ACTIVE_WINDOW_MS ? { activity: 'working', idleForMs: null, lastActiveMs: last } : { activity: 'idle', idleForMs: quiet, lastActiveMs: last };
}
