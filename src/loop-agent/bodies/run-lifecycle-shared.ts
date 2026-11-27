// Shared readers for the run-lifecycle supervisors (run-supervisor → run-doctor → autopsy): one pass over the run ledger
// (<stateRoot>/run-ledger/*.jsonl) and one over the RES pregate evidence mirrors. Pure parsing lives here so the three
// bodies classify the same facts the same way; every reader returns null («unknown») when its source cannot be read —
// never an empty list that would read as «0».
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const seatStateRoot = (): string => process.env.ELANOUS_SEAT_STATE ?? join(homedir(), 'elanous-hq', 'seat-state');

// ── run ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface RunTerminal { readonly kind: 'stop' | 'status' | 'terminal'; readonly cls: string; readonly at: string; readonly failed: boolean }
export interface RunSummary {
  readonly runId: string;
  readonly graphId: string;
  /** Timestamp of the `start` event (null = the ledger has no start: a child-only ledger). */
  readonly startedAt: string | null;
  readonly lastAt: string;
  readonly terminal: RunTerminal | null;
  readonly lastNodeOutcome: string | null;
  readonly stage: string | null;
}

interface Row { timestamp?: unknown; event?: unknown; data?: unknown }
const TERMINAL_STATUSES = new Set(['failed', 'completed', 'cancelled', 'parked']);
const FAILED_TERMINALS = new Set(['failed', 'aborted', 'gate-failed', 'review-blocked', 'timed-out']);

/** Summarize one run ledger's text (same terminal rule as `eln tasks doctor`: stop · run-status terminal · terminal event). */
export function summarizeRunLedger(runId: string, text: string): RunSummary | null {
  let startedAt: string | null = null; let lastAt = ''; let graphId = ''; let terminal: RunTerminal | null = null;
  let lastNodeOutcome: string | null = null; let stage: string | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r: Row;
    try { r = JSON.parse(line) as Row; } catch { continue; }
    const at = typeof r.timestamp === 'string' ? r.timestamp : '';
    if (at > lastAt) lastAt = at;
    const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    if (typeof d.graphId === 'string' && d.graphId) graphId = d.graphId;
    if (typeof d.stage === 'string' && d.stage) stage = d.stage;
    switch (r.event) {
      case 'start': if (!startedAt) startedAt = at; break;
      case 'pipeline-node-exit': if (typeof d.outcome === 'string') lastNodeOutcome = `${typeof d.node === 'string' ? d.node : '?'}:${d.outcome}`; break;
      case 'stop': if (!terminal || terminal.kind !== 'stop') terminal = { kind: 'stop', cls: typeof d.class === 'string' ? d.class : 'unclassified', at, failed: true }; break;
      case 'run-status': {
        const s = String(d.runStatus ?? '');
        if (TERMINAL_STATUSES.has(s) && (!terminal || terminal.kind !== 'stop')) terminal = { kind: 'status', cls: s, at, failed: s === 'failed' };
        break;
      }
      case 'terminal': {
        const t = typeof d.terminal === 'string' ? d.terminal : typeof d.ok === 'boolean' ? (d.ok ? 'ok' : 'failed') : '';
        if (t && !terminal) terminal = { kind: 'terminal', cls: t, at, failed: d.ok === false || FAILED_TERMINALS.has(t) };
        break;
      }
      default: break;
    }
  }
  if (!lastAt) return null;
  return { runId, graphId: graphId || '?', startedAt, lastAt, terminal, lastNodeOutcome, stage };
}

/** Run ledgers touched since `sinceMs` (newest first, at most `cap`). null = the ledger directory cannot be read. */
export function scanRunLedgers(dir: string, sinceMs: number, cap = 600): RunSummary[] | null {
  let names: string[];
  try { names = readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { return null; }
  const recent: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    try { const m = statSync(join(dir, name)).mtimeMs; if (m >= sinceMs) recent.push({ name, mtime: m }); } catch { /* raced */ }
  }
  recent.sort((a, b) => b.mtime - a.mtime);
  const out: RunSummary[] = [];
  for (const { name } of recent.slice(0, cap)) {
    try {
      const s = summarizeRunLedger(name.slice(0, -'.jsonl'.length), readFileSync(join(dir, name), 'utf8'));
      if (s) out.push(s);
    } catch { /* unreadable file = skipped, the directory itself was readable */ }
  }
  return out;
}

// ── pregate evidence (RES pregate.py mirrors) ───────────────────────────────────────────────────────────────────────
export interface PregateSummary {
  /** `<pr>-<head12>-<host>` — the time-suffixed duplicate dirs pregate also writes are folded into this id. */
  readonly id: string;
  readonly dir: string;
  readonly pr: number | null;
  readonly head: string;
  readonly host: string;
  readonly at: number;
  readonly status: string;
  readonly mode: string | null;
  readonly minutes: number | null;
  /** Stages run, in order — on RED the last one is the stage that failed (each failed stage stops the rest). */
  readonly stages: readonly string[];
}

const DIR_RE = /^(\d+|x)-([0-9a-f]{6,40})-([a-z0-9]+)(?:-(\d{6}))?$/u;

/** One evidence lane (PREGATE-RED or PREGATE-GREEN) since `sinceMs`. null = the lane cannot be read. */
export function scanPregateLane(laneDir: string, sinceMs: number): PregateSummary[] | null {
  let names: string[];
  try { names = readdirSync(laneDir); } catch { return null; }
  const byId = new Map<string, PregateSummary>();
  for (const name of names) {
    const m = DIR_RE.exec(name);
    if (!m) continue;
    const dir = join(laneDir, name);
    let at: number;
    try { at = statSync(dir).mtimeMs; } catch { continue; }
    if (at < sinceMs) continue;
    const id = `${m[1]}-${m[2]}-${m[3]}`;
    const prev = byId.get(id);
    if (prev && prev.at >= at) continue;
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(readFileSync(join(dir, 'SUMMARY.json'), 'utf8')) as Record<string, unknown>; } catch { /* a dir without SUMMARY still names pr/head/host */ }
    byId.set(id, {
      id, dir, pr: m[1] === 'x' ? null : Number(m[1]), head: typeof j.head === 'string' ? j.head : m[2]!, host: typeof j.host === 'string' ? j.host : m[3]!, at,
      status: typeof j.status === 'string' ? j.status : '?', mode: typeof j.mode === 'string' ? j.mode : null,
      minutes: typeof j.minutes === 'number' ? j.minutes : null,
      stages: Array.isArray(j.stages) ? j.stages.filter((s): s is string => typeof s === 'string') : [],
    });
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

export const pregateEvidenceRoot = (seatState = seatStateRoot()): string => join(seatState, 'RES', 'evidence');
export const pregateLane = (lane: 'PREGATE-RED' | 'PREGATE-GREEN', seatState = seatStateRoot()): string => join(pregateEvidenceRoot(seatState), lane);

/** Admitted pregate hosts from RES/PREGATE-HOSTS.json (fallback = the hardcoded local lanes). */
export function admittedPregateHosts(seatState = seatStateRoot(), nowMs = Date.now()): string[] {
  const fallback = ['node-b', 'minim5'];
  const p = join(seatState, 'RES', 'PREGATE-HOSTS.json');
  if (!existsSync(p)) return fallback;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { hosts?: Array<{ host?: unknown; admitted?: unknown; expiresAt?: unknown; priority?: unknown }> };
    const rows = (j.hosts ?? []).filter(h => typeof h.host === 'string' && h.admitted !== false)
      .filter(h => {
        if (h.expiresAt === undefined || h.expiresAt === null) return true;
        const t = typeof h.expiresAt === 'number' ? h.expiresAt * 1000 : Date.parse(String(h.expiresAt));
        return Number.isFinite(t) && t > nowMs;
      })
      .sort((a, b) => (typeof a.priority === 'number' ? a.priority : 99) - (typeof b.priority === 'number' ? b.priority : 99));
    const hosts = rows.map(h => String(h.host));
    return hosts.length ? hosts : fallback;
  } catch { return fallback; }
}

/** `ps` elapsed time `[[dd-]hh:]mm:ss` → seconds (null = unparseable). */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(s.trim());
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86_400) + (Number(m[2] ?? 0) * 3_600) + (Number(m[3]) * 60) + Number(m[4]);
}

/** Exact-PID process read through `ps` (command line + elapsed seconds) — null = gone or unreadable. */
export function readProcess(pid: number): { cmd: string; elapsedSec: number } | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync('ps', ['-o', 'etime=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    if (r.status !== 0 || !r.stdout.trim()) return null;
    const line = r.stdout.trim().split('\n')[0]!.trim();
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    const elapsedSec = parseEtime(line.slice(0, sp));
    if (elapsedSec === null) return null;
    return { cmd: line.slice(sp + 1).trim(), elapsedSec };
  } catch { return null; }
}

/** Append-only JSONL helpers for a body's own ledger inside its agent home. */
export function readJsonlFile<T>(path: string): T[] {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } }); }
  catch { return []; }
}
