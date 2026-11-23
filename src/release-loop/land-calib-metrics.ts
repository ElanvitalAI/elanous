import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Row = Record<string, unknown>;
type Input = { dispatches: string; memory: string; refusals: string; mainLog?: string; trainLedger?: string };

/** Count first-parent main commits, classifying train only on a unique merge SHA. */
export function landingCounts(log: string, ledger: string, now: number) {
  const commits = new Set<string>();
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const [sha, rawEpoch] = line.split('\t');
    const time = Number(rawEpoch) * 1000;
    if (!sha || !/^[a-f0-9]{40}$/.test(sha) || !rawEpoch || !Number.isFinite(time)) throw new Error('invalid main log');
    if (time > now - 3_600_000 && time <= now) commits.add(sha);
  }
  const matches = new Set<string>();
  for (const line of ledger.split('\n')) {
    const columns = line.split('\t');
    if (columns.length < 7 || !/^merged(?:\s|$|\()/i.test(columns[6] ?? '')) continue;
    const sha = columns[3] ?? '';
    if (!/^[a-f0-9]{7,40}$/.test(sha)) continue;
    const matched = [...commits].filter(commit => commit.startsWith(sha));
    if (matched.length === 1) matches.add(matched[0]!);
  }
  return { mainFirstParentCommits: commits.size, matchedTrainCommits: matches.size, otherOrUnknownCommits: commits.size - matches.size, direct: null };
}

function rows(input: string): Row[] {
  return input.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { const row: unknown = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row as Row] : []; }
    catch { throw new Error('invalid JSONL observation'); }
  });
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
}
function at(row: Row): number { return typeof row.at === 'string' ? Date.parse(row.at) : NaN; }
function inWindow(row: Row, now: number): boolean { const time = at(row); return time > now - 3_600_000 && time <= now; }

/** Read-only observations; absent and unimplemented signals remain null, never inferred as zero. */
export function landCalibMetrics(input: Input, now: number) {
  const dispatches = rows(input.dispatches);
  const memories = rows(input.memory);
  const refusals = rows(input.refusals).filter(row => inWindow(row, now));
  const byRun = new Map<string, Row>();
  for (const row of dispatches) if (typeof row.runId === 'string' && row.runId && Number.isFinite(at(row))) byRun.set(row.runId, row);
  const completed = new Map<string, { host: string; minutes: number }>();
  for (const row of memories) {
    if (row.eventType !== 'batch-gate' || !inWindow(row, now) || typeof row.runId !== 'string' || !row.runId) continue;
    const start = byRun.get(row.runId);
    const elapsed = start ? at(row) - at(start) : NaN;
    if (!start || !Number.isFinite(elapsed) || elapsed < 0 || typeof start.host !== 'string' || row.host !== start.host) continue;
    completed.set(row.runId, { host: start.host, minutes: elapsed / 60_000 });
  }
  const gateMinutes: Record<string, number[]> = {};
  for (const { host, minutes } of completed.values()) (gateMinutes[host] ??= []).push(minutes);
  const preflightSeconds: Record<string, number[]> = {};
  for (const row of memories) if (row.eventType === 'enqueue-typecheck' && inWindow(row, now) && typeof row.host === 'string' && typeof row.secs === 'number' && Number.isFinite(row.secs) && row.secs >= 0) (preflightSeconds[row.host] ??= []).push(row.secs);
  const medians = (v: Record<string, number[]>) => Object.fromEntries(Object.entries(v).map(([host, values]) => [host, median(values)]));
  const refusalKinds = { infra: 0, violation: 0, unknown: 0 };
  for (const row of refusals) {
    // Only explicit producer classifications are authoritative; legacy free text is unknown.
    const kind = row.kind === 'infra' || row.kind === 'violation' ? row.kind : 'unknown';
    refusalKinds[kind]++;
  }
  return { asOf: new Date(now).toISOString(), windowMinutes: 60, gate: { matchedCompleted: completed.size, medianMinutesByHost: medians(gateMinutes) }, preflight: { medianSecondsByHost: medians(preflightSeconds) }, refusals: refusalKinds, landing: input.mainLog !== undefined && input.trainLedger !== undefined ? landingCounts(input.mainLog, input.trainLedger, now) : null, queue: null, judgeFirstPassRate: null, hosts: null, greenIncrease: null };
}

if (import.meta.main) {
  const op = process.env.LAND_CALIB_OP_DIR ?? join(homedir(), 'elanous-hq/seat-state/OP');
  const read = (path: string) => readFileSync(join(op, path), 'utf8');
  try {
    const now = Date.now();
    const git = spawnSync('git', ['log', 'origin/main', '--first-parent', `--since-as-filter=${new Date(now - 3_600_000).toISOString()}`, '--format=%H%x09%ct'], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(`main log unavailable: ${git.stderr.trim()}`);
    console.log(JSON.stringify(landCalibMetrics({ dispatches: read('train-manager/preflight-dispatches.jsonl'), memory: read('train-memory.jsonl'), refusals: read('train-manager/refusal-events.jsonl'), trainLedger: read('train-ledger.tsv'), mainLog: git.stdout }, now)));
    // origin/main is the locally observed ref; no network refresh is performed.
  } catch (error) { console.error(`land-calib-metrics: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
