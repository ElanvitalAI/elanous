// FED-OBSERVE — `eln fed snapshot [--json] [--anomalies]` and `eln fed chatlog [...]` (see snapshot.ts · chatlog.ts).
// Every snapshot is saved (rotating) next to the fed-state ledger: `<state>/fed-state/snapshots/` — `latest.json` is what
// OP's pulse digest and the board read; the timestamped files keep the last SNAPSHOT_KEEP for «what was it at 23:10».
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { fedStatePath } from '../fed-state/ledger.js';
import { parseWindow } from '../fed-state/kpi.js';
import { ANOMALY_MAX_CHARS, buildFedSnapshot, formatAnomalies, formatSnapshot, type FedSnapshot, type FedSources } from './snapshot.js';
import { buildChatlog, DEFAULT_CLIP, formatChatlog, type ChatlogQuery, type MailRow, type OutcomeFacts, type SeatSession } from './chatlog.js';

// 출처: a 5-minute pulse cadence × 8 h of night watch.
export const SNAPSHOT_KEEP = 96;

export function snapshotDir(root?: string): string { return join(dirname(fedStatePath(root)), 'snapshots'); }

/** Write `latest.json` (atomic) and one timestamped file; prune to the newest `keep`. Fail-open (returns false). */
export function saveSnapshot(s: FedSnapshot, dir: string = snapshotDir(), keep = SNAPSHOT_KEEP): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const text = `${JSON.stringify(s)}\n`;
    const stamp = s.at.replace(/[:.]/g, '-');
    writeFileSync(join(dir, `snap-${stamp}.json`), text);
    const tmp = join(dir, `latest.json.${process.pid}.tmp`);
    writeFileSync(tmp, text); renameSync(tmp, join(dir, 'latest.json'));
    const files = readdirSync(dir).filter(f => /^snap-.*\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) { try { unlinkSync(join(dir, f)); } catch { /* raced */ } }
    return true;
  } catch { return false; }
}

export function readLatestSnapshot(dir: string = snapshotDir()): FedSnapshot | null {
  try {
    const p = join(dir, 'latest.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as FedSnapshot : null;
  } catch { return null; }
}

/** OP pulse digest: the latest snapshot's anomaly block (≤ maxChars), or null when there is none or it is older than
 *  `maxAgeMs` (then `stale` is true so the caller can refresh it in the background). Never throws. */
export function latestAnomalyBlock(opts: { now?: number; maxAgeMs?: number; maxChars?: number; dir?: string } = {}): { text: string | null; stale: boolean } {
  const now = opts.now ?? Date.now();
  const s = readLatestSnapshot(opts.dir);
  if (!s) return { text: null, stale: true };
  const age = now - Date.parse(s.at);
  if (!Number.isFinite(age) || age > (opts.maxAgeMs ?? 20 * 60_000)) return { text: null, stale: true };
  const text = formatAnomalies(s, opts.maxChars ?? ANOMALY_MAX_CHARS);
  return { text: text || null, stale: age > 10 * 60_000 };
}

export interface SnapshotCliDeps {
  readonly collect?: (now: Date) => Promise<{ sources: FedSources }>;
  readonly save?: (s: FedSnapshot) => boolean;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

export async function runFedSnapshotCli(opts: { json?: boolean; anomalies?: boolean; save?: boolean; quiet?: boolean; all?: boolean }, deps: SnapshotCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const now = (deps.now ?? (() => new Date()))();
  const collect = deps.collect ?? (async (n: Date) => (await import('./sources-live.js')).collectFedSources(n));
  const started = Date.now();
  const { sources } = await collect(now);
  const snap = buildFedSnapshot(sources);
  const saved = opts.save === false ? false : (deps.save ?? saveSnapshot)(snap);
  debug.log('fed.observe', 'snapshot', { seats: snap.seats.length, anomalies: snap.anomalies.length, red: snap.anomalies.filter(a => a.severity === 'red').length,
    unmeasured: snap.unmeasured, saved, ms: Date.now() - started });
  // A save failure is visible (stderr, even with --quiet) and in --json; the printed snapshot still goes out.
  if (opts.save !== false && !saved) (deps.err ?? ((l: string) => process.stderr.write(`${l}\n`)))(`fed snapshot: not saved to ${snapshotDir()} (write failed) — the pulse digest keeps the previous snapshot`);
  if (opts.quiet) return 0;
  if (opts.anomalies) {
    if (opts.json) out(JSON.stringify({ at: snap.at, saved, anomalies: snap.anomalies, unmeasured: snap.unmeasured }));
    else out(formatAnomalies(snap) || `[fed snapshot ${snap.at}] no anomalies${snap.unmeasured.length ? ` (unmeasured: ${snap.unmeasured.join(' · ')})` : ''}`);
    return 0;
  }
  out(opts.json ? JSON.stringify({ ...snap, saved }) : formatSnapshot(snap, { all: opts.all === true }));
  return 0;
}

export interface ChatlogCliOpts { since?: string; turns?: string; seat?: string; grep?: string; json?: boolean; clip?: string; mail?: boolean; maxBytes?: string }
export interface ChatlogCliDeps {
  readonly collect?: (input: { now: Date; sinceMs: number; maxBytes: number }) => Promise<{ sessions: SeatSession[]; mails: MailRow[]; facts: OutcomeFacts; unmeasured: string[] }>;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

const wholeNumber = (v: string | undefined, name: string): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number ≥ 0 (got ${v})`);
  return n;
};

export async function runFedChatlogCli(opts: ChatlogCliOpts, deps: ChatlogCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = (deps.now ?? (() => new Date()))();
  let q: ChatlogQuery; let maxBytes: number;
  try {
    const turns = wholeNumber(opts.turns, 'turns');
    const sinceWin = opts.since ? parseWindow(opts.since) : turns === null ? parseWindow('30m') : null;
    const clip = wholeNumber(opts.clip, 'clip') ?? DEFAULT_CLIP;
    maxBytes = (wholeNumber(opts.maxBytes, 'max-bytes') ?? 0) || (sinceWin !== null && sinceWin > 6 * 3_600_000 ? 32 : 8) * 1024 * 1024;
    const seats = opts.seat ? new Set(opts.seat.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) : null;
    q = { now: now.getTime(), since: sinceWin === null ? null : now.getTime() - sinceWin, turns, seats, grep: opts.grep?.trim() || null, clip, mail: opts.mail !== false };
  } catch (e) { err(`fed chatlog: ${(e as Error).message}`); return 2; }
  const collect = deps.collect ?? (async (input: { now: Date; sinceMs: number; maxBytes: number }) => (await import('./sources-live.js')).collectChatSources(input));
  // --turns alone: mails of the last day (the window is narrowed to the shown turns afterwards).
  const src = await collect({ now, sinceMs: q.since ?? now.getTime() - 24 * 3_600_000, maxBytes });
  const entries = buildChatlog(src.sessions, src.mails, q, src.facts);
  debug.log('fed.observe', 'chatlog', { entries: entries.length, sessions: src.sessions.length, mails: src.mails.length, unmeasured: src.unmeasured });
  if (opts.json) { out(JSON.stringify({ at: now.toISOString(), entries, unmeasured: src.unmeasured })); return 0; }
  out(`fed chatlog ${q.since === null ? `last ${q.turns} turn(s)/seat (mails: last 24h)` : `since ${new Date(q.since).toISOString()}`} · ${src.sessions.length} seat sessions · ${entries.filter(e => e.type === 'turn').length} turns · ${entries.filter(e => e.type === 'mail').length} mails${src.unmeasured.length ? ` · unmeasured: ${src.unmeasured.slice(0, 6).join(' · ')}` : ''}`);
  for (const line of formatChatlog(entries)) out(line);
  return 0;
}
