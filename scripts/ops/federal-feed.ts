/** MSG-EXCHANGE-DESIGN §A2: routine state transitions go to the federal TSV feed;
 * OP mail is reserved for alerts, questions and cards. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dateKey } from '../../src/time/calendar.js';
import { withFileLockSync } from '../../src/storage/file-lock.js';
import { canonicalSeatId } from '../../src/msg/msg-store.js';

const KST = 'Asia/Seoul';
export type FederalKind = 'transition' | 'alert' | 'question' | 'card';
export interface FederalUpdate {
  kind: FederalKind;
  from: string;
  cell: string;
  state: string;
  evidence: string;
  detail: string;
}
export interface FederalFeedRow extends FederalUpdate { at: string }
export interface FederalSummary {
  from: string;
  to: string;
  count: number;
  source: 'complete' | 'partial' | 'unmeasured';
  bySeat: Record<string, number>;
  anomalies: Array<{ from: string; cell: string; state: string; evidence: string }>;
}

function field(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (/[\t\r\n\u2028\u2029]/.test(value)) throw new Error(`${name} must be one TSV field`);
  return value.trim();
}
function update(input: FederalUpdate): FederalUpdate {
  if (!['transition', 'alert', 'question', 'card'].includes(input.kind)) throw new Error('invalid feed kind');
  return { kind: input.kind, from: canonicalSeatId(input.from), cell: field(input.cell, 'cell'),
    state: field(input.state, 'state'), evidence: field(input.evidence, 'evidence'), detail: field(input.detail, 'detail') };
}
function feedPath(root: string, at: Date): string {
  return join(root, 'OPS', `FEED-${dateKey(at, { timeZone: KST }).replaceAll('-', '')}.tsv`);
}

/** Write exactly one append-only row with a system timestamp. The caller cannot supply time. */
export function appendFederalTransition(input: FederalUpdate, opts: { root?: string; now?: () => Date } = {}): { path: string; row: FederalFeedRow } {
  const value = update(input);
  if (value.kind !== 'transition') throw new Error('only state transitions may enter the feed');
  const at = (opts.now ?? (() => new Date()))();
  if (!Number.isFinite(at.getTime())) throw new Error('invalid system time');
  const path = feedPath(opts.root ?? join(homedir(), 'elanous-hq', 'seat-state'), at);
  const row = { ...value, at: at.toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const line = [row.at, row.from, row.cell, row.state, row.evidence, row.detail].join('\t') + '\n';
  withFileLockSync(`${path}.lock`, () => appendFileSync(path, line, 'utf8'), { breakDeadHolder: true });
  return { path, row };
}

/** An OP post is an explicit exceptional route, never a side effect of a routine feed row. */
export function routeFederalUpdate(input: FederalUpdate, deps: {
  append?: typeof appendFederalTransition;
  postOp?: (input: { from: string; kind: Exclude<FederalKind, 'transition'>; body: string }) => void;
} = {}): 'feed' | 'op' {
  const value = update(input);
  if (value.kind === 'transition') { (deps.append ?? appendFederalTransition)(value); return 'feed'; }
  const body = `${value.cell}: ${value.detail} [${value.state}] ${value.evidence}`;
  (deps.postOp ?? postOp)( { from: value.from, kind: value.kind, body } );
  return 'op';
}

function postOp(input: { from: string; kind: Exclude<FederalKind, 'transition'>; body: string }): void {
  const child = spawnSync('eln', ['msg', 'post', '--from', input.from, '--to', 'OP', '--kind', input.kind, '--body', input.body], { encoding: 'utf8' });
  if (child.error || child.status !== 0) throw new Error(`OP mail failed: ${child.error?.message ?? child.stderr?.trim() ?? child.status}`);
  if (child.stdout) process.stdout.write(child.stdout);
}

function stateAndEvidence(parts: string[]): { state: string; evidence: string } | null {
  // The writer produces six columns. The older feed has a source column before
  // status; self-wake rows also carry a target column. Never infer status from
  // evidence or detail, where words such as "hold" occur in ordinary prose.
  if (parts.length === 6) return { state: parts[3] ?? '', evidence: parts[4] ?? '' };
  if (parts.length === 7) return { state: parts[4] ?? '', evidence: parts[5] ?? '' };
  if (parts.length === 8) return { state: parts[4] ?? '', evidence: parts[6] ?? '' };
  return null;
}

function anomalyState(state: string): string | null {
  const value = state.trim();
  const normalized = value.toLowerCase();
  const validStates = new Set(['green', 'yellow', 'red', 'hold', 'blocked', 'failed', 'error', 'incident',
    'unmeasured', 'owner-needed', 'working-skip', 'idle-under-10-or-unknown', 'first-receipt', 'first-receipt-yellow']);
  if (!validStates.has(normalized)) {
    return value ? `invalid:${value}` : 'invalid:(empty)';
  }
  return new Set(['red', 'hold', 'blocked', 'failed', 'error', 'incident', 'unmeasured', 'owner-needed']).has(normalized) ? value : null;
}

/** Read a half-open 15-minute window from the existing append-only TSV, including midnight rollover. */
export function summarizeFederalFeed(end: Date, root: string = join(homedir(), 'elanous-hq', 'seat-state')): FederalSummary {
  const toMs = end.getTime();
  if (!Number.isFinite(toMs)) throw new Error('invalid summary end');
  const fromMs = toMs - 15 * 60_000;
  const dates = new Set([feedPath(root, new Date(fromMs)), feedPath(root, new Date(toMs - 1))]);
  const bySeat: Record<string, number> = {};
  const anomalies: FederalSummary['anomalies'] = [];
  let count = 0;
  let filesRead = 0;
  for (const path of dates) {
    if (!existsSync(path)) continue;
    filesRead++;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      const at = Date.parse(parts[0] ?? '');
      if (!Number.isFinite(at) || at < fromMs || at >= toMs || !parts[1]) continue;
      const from = parts[1]!;
      count++;
      bySeat[from] = (bySeat[from] ?? 0) + 1;
      const parsed = stateAndEvidence(parts);
      const state = parsed ? anomalyState(parsed.state) : 'invalid:(row-shape)';
      if (state) anomalies.push({ from, cell: parts[2] ?? '-', state, evidence: parsed?.evidence || '-' });
    }
  }
  const source = filesRead === 0 ? 'unmeasured' : filesRead === dates.size ? 'complete' : 'partial';
  return { from: new Date(fromMs).toISOString(), to: end.toISOString(), count, source, bySeat, anomalies };
}

export function formatFederalSummary(summary: FederalSummary): string {
  const seats = Object.entries(summary.bySeat).sort(([a], [b]) => a.localeCompare(b)).map(([seat, count]) => `${seat}=${count}`).join(' ') || '-';
  const anomalies = summary.anomalies.slice(0, 5).map(row => `${row.from}/${row.cell}:${row.state}`).join(' · ') || '-';
  return `15m ${summary.from}..${summary.to} source=${summary.source} events=${summary.count} seats=${seats} anomalies=${summary.anomalies.length} ${anomalies}`;
}

function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key?.startsWith('--') || args[i + 1] === undefined) throw new Error(`invalid argument: ${key ?? '(missing)'}`);
    result[key.slice(2)] = args[i + 1]!;
  }
  return result;
}

if (import.meta.main) {
  try {
    const [command, ...rest] = Bun.argv.slice(2);
    const f = flags(rest);
    if (command === 'summary') {
      const end = f.end ? new Date(f.end) : new Date();
      console.log(formatFederalSummary(summarizeFederalFeed(end, f.root)));
    } else if (command === 'record') {
      const kind = (f.kind ?? 'transition') as FederalKind;
      const input = { kind, from: f.from!, cell: f.cell!, state: f.state!, evidence: f.evidence!, detail: f.detail! };
      const destination = routeFederalUpdate(input, { append: value => appendFederalTransition(value, { root: f.root }) });
      console.log(destination);
    } else throw new Error('usage: federal-feed.ts record --from SEAT --cell CELL --state STATE --evidence PATH --detail TEXT [--kind transition|alert|question|card] | summary [--end ISO]');
  } catch (error) {
    console.error(`federal-feed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
