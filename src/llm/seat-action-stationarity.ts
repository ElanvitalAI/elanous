/**
 * SEAT-TURN-FOLLOWUPS ① — action stationarity for seat tool loops (reference: grok-build «action stationarity» nudges
 * after 8 identical consecutive calls and stops after 12; openclaw 10/20/30).
 *
 * S: #40092 gave seat loops a 400-round cap and took them out of the W5-G round-4 cut. The only repeat guard left was the
 *    codex same-args dedup, which blocks the 3rd identical exploratory call with a stub — far too tight for a seat that
 *    legitimately polls `eln seat pool` or re-runs a check, and nothing bounded a seat calling the same thing forever.
 * C: identical = same tool + same normalized args (+ the target's mtime/size for Read/ListDir — H5), counted over consecutive calls (any result). A repeat is a signal to
 *    change approach, not a refusal: the call still runs.
 * Q: how does a seat loop notice it is stationary without cutting legitimate retries?
 * A: 8 in a row → one system note («you are repeating X; change approach or end with a summary»); 12 in a row → one
 *    tools-off summary step (done / remaining / next) ends the turn. Member chat keeps the old dedup (3) and the
 *    gemini-style 5-window nudge unchanged; seat loops skip those two and use this instead.
 *
 * 세 얼굴: 관측 = `tool-loop.seat-stationarity {verdict, tool, run}` (llm.ts) · 판단 = this tracker · 수복과 인계 = the
 *          nudge note, then the summary step that names what is left for the next turn.
 */

export const SEAT_REPEAT_NUDGE_AT = 8;
export const SEAT_REPEAT_STOP_AT = 12;

export type StationarityVerdict = 'ok' | 'nudge' | 'stop';

/** Key-sorted JSON with trimmed, whitespace-collapsed strings and null/undefined fields dropped. */
export function normalizeToolArgs(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') return v.trim().replace(/\s+/gu, ' ');
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[key];
        if (inner === undefined || inner === null) continue;
        out[key] = norm(inner);
      }
      return out;
    }
    return v;
  };
  try { return JSON.stringify(norm(value ?? {})); } catch { return '<unserializable>'; }
}

export function toolCallFingerprint(name: string, args: unknown, freshness = ''): string {
  return `${name}|${normalizeToolArgs(args)}${freshness ? `|${freshness}` : ''}`;
}

/** Tools whose same-args call legitimately returns new content when the target changed (H5: coach-notes.md re-reads). */
const FRESHNESS_TOOLS: ReadonlySet<string> = new Set(['Read', 'ListDir']);

/**
 * SEAT-TURN-FOLLOWUPS H5 — a cheap freshness token (mtime ⊕ size of the target) so re-reading a file that changed is
 * not «identical». '' when the tool has no path target or the stat fails (then the args alone decide).
 */
export function toolFreshnessToken(name: string, args: unknown, stat: (path: string) => { mtimeMs: number; size: number } = defaultStat): string {
  if (!FRESHNESS_TOOLS.has(name) || !args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const target = typeof a.file_path === 'string' ? a.file_path : typeof a.path === 'string' ? a.path : null;
  if (!target) return '';
  try { const st = stat(target); return `${Math.trunc(st.mtimeMs)}:${st.size}`; } catch { return ''; }
}
function defaultStat(path: string): { mtimeMs: number; size: number } {
  const { statSync } = require('node:fs') as typeof import('node:fs');
  return statSync(path);
}

export interface StationarityTracker {
  /** Record one dispatched call; the verdict fires once per threshold crossing (8 → nudge, 12 → stop). */
  record(name: string, args: unknown, freshness?: string): StationarityVerdict;
  /** Current consecutive run length of the last fingerprint. */
  readonly run: number;
  readonly lastTool: string | null;
}

export function createStationarityTracker(nudgeAt: number = SEAT_REPEAT_NUDGE_AT, stopAt: number = SEAT_REPEAT_STOP_AT): StationarityTracker {
  let last: string | null = null;
  let lastTool: string | null = null;
  let run = 0;
  return {
    record(name, args, freshness = '') {
      const fp = toolCallFingerprint(name, args, freshness);
      if (fp === last) run += 1;
      else { last = fp; lastTool = name; run = 1; }
      if (run === stopAt) return 'stop';
      if (run === nudgeAt) return 'nudge';
      return 'ok';
    },
    get run() { return run; },
    get lastTool() { return lastTool; },
  };
}

/** The one system note on the nudge. */
export function stationarityNudgeNote(tool: string, run: number): string {
  return `[system] You are repeating ${tool} with identical arguments (${run} calls in a row). The result will not change. `
    + 'Change approach (a different command, a different target, or act on what you already have), '
    + 'or end the turn with a summary: done / remaining / next.';
}

/** The tools-off summary prompt on the stop. */
export function stationaritySummaryPrompt(tool: string, run: number): string {
  return `Tools are off for this step: ${tool} was called ${run} times in a row with identical arguments. `
    + 'Write the turn summary now as plain text in three short parts — Done: what this turn finished (with evidence). '
    + 'Remaining: what is still open toward the goal. Next: the one concrete next action (a different approach from the repeated call). '
    + 'Do not request tools.';
}

/** The summary when the tools-off step itself returns nothing usable. */
export function stationarityFallbackSummary(tool: string, run: number): string {
  return `[stationary stop] ${tool} was called ${run} times in a row with identical arguments; the turn ended here.\n`
    + `Done: see the tool results above.\nRemaining: the goal is still open.\nNext: change approach — do not repeat ${tool} with the same arguments.`;
}

// ── GOAL-DRIVE-NARROW ② (CEO 11-25 17:1x) — side-effect budget per goal-drive continuation ──────────────────────────
// Live incident: OP's standing goal «착지 10/h — 멈춘 칸 재배정» ⊕ a non-idempotent `eln seat assign` → 77 assign mails in
// 20 min (38 duplicates). A continuation may take at most DRIVE_SIDE_EFFECT_MAX outward actions; the same outward action
// (same tool + same target) twice ends the continuation with a summary. Classification reads the call's argv head and the
// tool name (structured), never the model's prose.

export const DRIVE_SIDE_EFFECT_MAX = 5;
export type SideEffectVerdict = 'not-outward' | 'ok' | 'duplicate' | 'over-budget';

/** Outward tools by name (product tools). */
const OUTWARD_TOOLS: ReadonlySet<string> = new Set(['MsgPost', 'SeatAssign', 'WorkClaim', 'WorkNext', 'ElsSend', 'PrCreate', 'GitPush']);
/** Outward shell argv heads: [program, ...subcommand words]. */
const OUTWARD_ARGV: readonly (readonly string[])[] = [
  ['eln', 'msg', 'post'], ['elanous', 'msg', 'post'], ['eln', 'seat', 'assign'], ['elanous', 'seat', 'assign'],
  ['eln', 'work', 'claim'], ['eln', 'work', 'next'], ['elanous', 'work', 'claim'], ['elanous', 'work', 'next'],
  ['els', 'send'], ['gh', 'pr', 'create'], ['git', 'push'],
];

/** The outward action's identity (tool + target), or null when the call has no outward effect. */
export function outwardActionKey(name: string, args: unknown): string | null {
  if (OUTWARD_TOOLS.has(name)) return `${name}|${normalizeToolArgs(args)}`;
  if (name !== 'Bash' && name !== 'RunShell') return null;
  const command = args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string' ? (args as { command: string }).command : '';
  // Each `&&` / `;` / `|` segment is a separate action; the first outward segment decides (one call = one action).
  for (const segment of command.split(/&&|\|\||;|\|/u)) {
    const words = segment.trim().split(/\s+/u).filter((w) => !/^[A-Z_][A-Z0-9_]*=/u.test(w));
    if (words[0] === 'bun' && words[1]?.endsWith('elanous.mjs')) words.splice(0, 2, 'elanous');
    if (OUTWARD_ARGV.some((head) => head.every((w, i) => words[i] === w))) return `Bash|${words.join(' ')}`;
  }
  return null;
}

export interface SideEffectBudget {
  check(name: string, args: unknown): SideEffectVerdict;
  readonly count: number;
}

export function createSideEffectBudget(max: number = DRIVE_SIDE_EFFECT_MAX): SideEffectBudget {
  const seen = new Set<string>();
  return {
    check(name, args) {
      const key = outwardActionKey(name, args);
      if (key === null) return 'not-outward';
      if (seen.has(key)) return 'duplicate';
      if (seen.size >= max) return 'over-budget';
      seen.add(key);
      return 'ok';
    },
    get count() { return seen.size; },
  };
}

/** One-shot «the next seat turn is a goal-drive continuation» mark (set when the drive opens · read by the tool loop). */
let driveContinuationArmedAt: number | null = null;
/** A mark older than this is stale (the drive turn did not start) and is ignored. */
const DRIVE_MARK_TTL_MS = 2 * 60_000;
export function armDriveContinuation(now: number = Date.now()): void { driveContinuationArmedAt = now; }
export function takeDriveContinuation(now: number = Date.now()): boolean {
  const at = driveContinuationArmedAt;
  driveContinuationArmedAt = null;
  return at !== null && now - at <= DRIVE_MARK_TTL_MS;
}

/** The tools-off summary prompt when a continuation hits its side-effect rule. */
export function sideEffectSummaryPrompt(why: 'duplicate' | 'over-budget', tool: string, count: number): string {
  return `Tools are off for this step: this goal-drive continuation ${why === 'duplicate'
    ? `repeated the same outward action (${tool}, same target)` : `reached its budget of ${count} outward actions`}. `
    + 'Write the summary now as plain text — Done: what this continuation changed (with evidence). Remaining: what is still open. '
    + 'Next: the one next action (never a repeat of an action already taken). Do not request tools.';
}
export function sideEffectFallbackSummary(why: 'duplicate' | 'over-budget', tool: string, count: number): string {
  return `[continuation stopped · ${why}] ${tool} · ${count} outward action(s) taken.\nDone: see the tool results above.\nRemaining: the goal is still open.\nNext: check the ledger before any further outward action.`;
}

// ── SEAT-TURN-FOLLOWUPS — a retraction cancels same-target actions (66-run experiment: in 4/6 runs a PR still went to
// pregate 30–160 s after the steer). A retraction mail (`supersedes` · #40100 `--retracts`) names its target through the
// retracted mail's structured refs (`cell:` · `pr:`); outward actions naming that target are refused for the next 2 h.
export const RETRACT_TARGET_TTL_MS = 2 * 60 * 60_000;
const retractedTargets = new Map<string, number>();
/** Register targets (cell ids · PR numbers) from a retracted mail's refs. */
export function noteRetractedRefs(refs: readonly string[], now: number = Date.now()): string[] {
  const targets = refs.flatMap((ref) => (ref.startsWith('cell:') || ref.startsWith('pr:') ? [ref.slice(ref.indexOf(':') + 1).trim().replace(/^#/u, '')] : []))
    .filter((t) => t.length > 0);
  for (const t of targets) retractedTargets.set(t.toUpperCase(), now);
  return targets;
}
export function clearRetractedTargets(): void { retractedTargets.clear(); }
/** The retracted target this outward action names, or null. Token match on the action key (never on prose). */
export function retractedTargetOf(name: string, args: unknown, now: number = Date.now()): string | null {
  if (retractedTargets.size === 0) return null;
  const key = outwardActionKey(name, args);
  if (key === null) return null;
  const tokens = new Set(key.toUpperCase().split(/[\s|"'=,:#/]+/u).filter(Boolean));
  for (const [target, at] of retractedTargets) {
    if (now - at > RETRACT_TARGET_TTL_MS) { retractedTargets.delete(target); continue; }
    if (tokens.has(target)) return target;
  }
  return null;
}
