import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { TRACK_AGENT_FORBIDDEN_ACTION_REGEX, universeLaunch } from '../autopilot/track-agent.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { getUserConfig, type SeatLoopConfig } from '../user-config.js';
import { listChecklist } from '../release-loop/checklist.js';
import { readSchedules } from '../release-loop/feature-store.js';

// `kind`/`createdAt` are the V3 shadow-compare keys (내부 문서 `METHOD-v3-shadow-compare-2026-10-02` · MK 10-02 18:54).
export type SeatItem = { source: 'request' | 'checklist'; kind?: 'request' | 'cell'; id: string; title: string; text: string; version?: string; queuedAt?: string; createdAt?: string };
export type SeatInputs = { requests: SeatItem[]; checklist: SeatItem[]; role: string };
// V3 ledger row: `ts` · `item.id` · `item.kind` · `item.createdAt` · `action` (door or skipped-*) · `reason` (forbidden word for a decision).
export type SeatAction = 'decision' | 'harness' | 'skipped-budget' | 'skipped-empty';
export type SeatEntry = { seat: string; ts?: string; at: string; status: 'shadow' | 'attempting' | 'outcome-unknown' | 'launched' | 'hitl' | 'skipped-budget' | 'skipped-empty'; item?: SeatItem; action?: SeatAction; reason?: string; runId?: string };
export type SeatLoopResult = SeatEntry | { seat: string; status: 'skipped-off' };
export type SeatDeps = {
  root?: string;
  repo?: string;
  config?: SeatLoopConfig;
  now?: () => Date;
  read?: (path: string) => string;
  run?: (args: string[]) => Promise<string>;
  append?: (path: string, entry: SeatEntry) => void;
  versions?: () => string[];
  /** Checklist items of one version — default reads the release ledger DB (checklist.json is only a legacy import source since REL5b). */
  checklistItems?: (version: string) => Array<{ id: string; title: string; status: string; owner?: string | null }>;
  ledgerFiles?: (directory: string) => string[];
  lockContended?: () => void;
};

const repoRoot = resolve(import.meta.dir, '../..');
const exec = promisify(execFile);
const defaultRead = (path: string): string => {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
};
const defaultRun = async (args: string[]): Promise<string> => {
  const { argv, env } = universeLaunch(args);
  const { stdout } = await exec('bun', argv, {
    cwd: repoRoot, env, encoding: 'utf8',
    timeout: args[0] === 'harness' && args[1] === 'say' ? 3_600_000 : 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};
const defaultAppend = (path: string, entry: SeatEntry): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
};
const observe = (event: string, data: Record<string, unknown>): void => {
  try { debug.log('seat.loop', event, data); } catch { /* logging cannot change execution */ }
};

// SQLite's OS lock survives the awaited external call and is released if the process exits.
async function withSeatLock<T>(directory: string, action: () => Promise<T>, contended?: () => void): Promise<T> {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, '.once.mutex.sqlite');
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    const deadline = Date.now() + 120_000;
    let signalled = false;
    while (true) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        if (!signalled) { contended?.(); signalled = true; }
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    try { return await action(); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

export function seatDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function seatLedgerPath(seat: string, root: string, now: Date): string {
  return join(root, 'seat-loop', seat, `${seatDay(now)}.jsonl`);
}

function rows(text: string): Record<string, unknown>[] {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function versionOrder(a: string, b: string): number {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  return (aa[0]! - bb[0]!) || (aa[1]! - bb[1]!) || (aa[2]! - bb[2]!);
}

export async function gatherSeatInputs(seat: string, deps: SeatDeps = {}): Promise<SeatInputs> {
  const read = deps.read ?? defaultRead;
  const root = deps.root ?? effectiveInstanceRoot();
  const requests = new Map<string, Record<string, unknown>>();
  for (const row of rows(read(join(root, 'seat-requests', 'requests.jsonl')))) {
    if (typeof row.key === 'string') requests.set(row.key, row);
  }
  const pending = [...requests.values()]
    .filter((row) => row.seat === seat && (row.status === 'pending' || row.status === 'queued') && typeof row.text === 'string')
    .map((row) => ({ source: 'request' as const, kind: 'request' as const, id: String(row.key), title: String(row.text), text: String(row.text), queuedAt: String(row.queuedAt ?? ''), createdAt: String(row.queuedAt ?? '') }))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
  const releaseRoot = deps.root ?? releaseLedgerRoot();
  const versions = deps.versions ?? (() => {
    const dir = join(releaseRoot, 'release');
    const fromDirs = existsSync(dir) ? readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)) : [];
    let fromSchedule: string[] = [];
    try { fromSchedule = readSchedules().map((row) => row.version); } catch { /* ledger unreadable — directories only */ }
    return [...new Set([...fromDirs, ...fromSchedule])].filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  });
  const itemsOf = deps.checklistItems ?? ((version: string) => listChecklist(version).items);
  const checklist: SeatItem[] = [];
  for (const version of versions().sort(versionOrder)) {
    let items: ReturnType<typeof itemsOf>;
    try { items = itemsOf(version); } catch (error) {
      debug.log('seat.loop', 'checklist-unreadable', { seat, version, error: String(error).slice(0, 200) });
      continue;
    }
    for (const item of items) {
      if (item.owner === seat && (item.status === 'yellow' || item.status === 'red')) {
        checklist.push({ source: 'checklist', kind: 'cell', version, id: item.id, title: item.title, text: item.title });
      }
    }
  }
  checklist.sort((a, b) => versionOrder(a.version!, b.version!) || a.id.localeCompare(b.id));
  return { requests: pending, checklist, role: read(join(deps.repo ?? repoRoot, 'docs', 'roles', `${seat}.md`)).slice(0, 4_000) };
}

function itemKey(item: SeatItem): string { return `${item.source}:${item.version ?? ''}:${item.id}`; }

// In shadow mode a shadowed item counts as handled, so a rehearsal day walks the queue like the seat would.
export function pickNext(inputs: SeatInputs, ledger: readonly SeatEntry[], opts: { shadow?: boolean } = {}): SeatItem | null {
  const handled = new Set(ledger.filter((entry) => entry.status === 'launched' || entry.status === 'hitl' || entry.status === 'attempting' || entry.status === 'outcome-unknown' || (opts.shadow === true && entry.status === 'shadow'))
    .filter((entry): entry is SeatEntry & { item: SeatItem } => !!entry.item && !!entry.item.source && typeof entry.item.id === 'string').map((entry) => itemKey(entry.item)));
  return [...inputs.requests, ...inputs.checklist].find((item) => !handled.has(itemKey(item))) ?? null;
}

export function planAction(item: SeatItem, seat?: string): { kind: 'decision' | 'harness'; text: string; reason?: string } {
  const hit = `${item.id}\n${item.title}\n${item.text}`.match(TRACK_AGENT_FORBIDDEN_ACTION_REGEX);
  const kind = hit ? 'decision' : 'harness';
  return { kind, text: seat && kind === 'harness' ? seatTaskText(seat, item) : `${item.id} ${item.title}`, ...(hit ? { reason: hit[0] } : {}) };
}

// The launched sentence names the seat, the source and the release so same-named items stay distinct.
export function seatTaskText(seat: string, item: SeatItem): string {
  const where = item.source === 'checklist' ? `${item.version ?? '?'} 체크리스트 칸 ${item.id}` : `자리 요청 ${item.id}`;
  return `[${seat} 자리 · ${where} · 역할 docs/roles/${seat}.md] ${item.title.replace(/[\r\n]+/g, ' ')}`;
}

export async function runSeatLoopOnce(seat: string, deps: SeatDeps = {}): Promise<SeatLoopResult> {
  if (!/^(?:MK|OP|TC|UX)$/.test(seat)) throw new Error(`unknown seat: ${seat}`);
  const config = deps.config ?? getUserConfig().loops?.seat ?? { mode: 'off' };
  if (config.mode === 'off' || !(config.seats ?? ['MK']).includes(seat)) {
    observe('skipped-off', { seat });
    return { seat, status: 'skipped-off' };
  }
  const now = (deps.now ?? (() => new Date()))();
  const path = seatLedgerPath(seat, deps.root ?? effectiveInstanceRoot(), now);
  const directory = dirname(path);
  return withSeatLock(directory, async () => {
  const files = deps.ledgerFiles?.(directory) ?? (existsSync(directory) ? readdirSync(directory) : []);
  const ledger = files.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name <= `${seatDay(now)}.jsonl`)
    .flatMap((name) => rows((deps.read ?? defaultRead)(join(directory, name))) as SeatEntry[]);
  const inputs = await gatherSeatInputs(seat, deps);
  const item = pickNext(inputs, ledger, { shadow: config.mode === 'shadow' });
  if (item) observe('picked', { seat, item, date: seatDay(now) });
  const planned = item ? planAction(item, seat) : undefined;
  const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), status: item ? 'shadow' : 'skipped-empty',
    ...(item ? { item, action: planned!.kind, ...(planned!.reason ? { reason: planned!.reason } : {}) } : { action: 'skipped-empty' as const }) };
  const append = deps.append ?? defaultAppend;
  if (config.mode === 'shadow' || !item) {
    append(path, entry);
    if (config.mode === 'shadow') observe('shadow', { seat, item, status: entry.status });
    return entry;
  }
  const run = deps.run ?? defaultRun;
  let outcome: string | undefined;
  try { outcome = (JSON.parse(await run(['harness', 'budget', '--json'])) as { outcome?: string }).outcome; }
  catch { /* failed budget observation is never permission to launch */ }
  if (outcome !== 'proceed' && outcome !== 'next-provider') {
    entry.status = 'skipped-budget';
    entry.action = 'skipped-budget';
    delete entry.reason;
    append(path, entry);
    observe('skipped-budget', { seat, item, outcome: outcome ?? 'unavailable' });
    return entry;
  }
  const action = planned!;
  // Persist the intent before crossing the process boundary: an unreturned call may already have acted.
  append(path, { ...entry, status: 'attempting' });
  try {
    if (action.kind === 'decision') {
      const title = `${seat}: ${action.text.replace(/[\r\n]+/g, ' ')}`;
      const raised = await run(['decisions', 'raise', '--title', title, '--category', 'other',
        '--s', `${seat} 배정 항목: ${action.text.replace(/[\r\n]+/g, ' ')}\n역할: ${inputs.role}`, '--c', '자동 실행 금지 문면에 해당하여 사람 결정이 필요하다',
        '--option', 'a=사람 승인:승인 후 별도로 집행', '--option', 'b=보류:집행하지 않음',
        '--skip-recommend', '금지 문면은 자동으로 권고하지 않는다', '--agent', 'seat-loop', '--json']);
      const decision: unknown = JSON.parse(raised.trim());
      if (!decision || typeof decision !== 'object' || typeof (decision as { id?: unknown }).id !== 'string') {
        throw new Error('decisions raise returned no decision id');
      }
      entry.status = 'hitl';
      append(path, entry);
      observe('hitl', { seat, item });
      return entry;
    }
    const output = await run(['harness', 'say', action.text, '--substrate', 'pod', '--pod-pool', config.podPool ?? 'pool-node-b@node-b:8', '--base', 'main', '--json']);
    const results: unknown = JSON.parse(output.trim());
    if (!Array.isArray(results) || results.length === 0 || results.some((result) =>
      !result || typeof result !== 'object' || (result as { status?: unknown }).status !== 'done')) {
      throw new Error('harness say did not complete successfully');
    }
    const runId = (results[0] as { runId?: unknown }).runId;
    if (typeof runId !== 'string' || !/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error('harness say output has no runId');
    }
    entry.status = 'launched';
    entry.runId = runId;
    append(path, entry);
    observe('launched', { seat, item, runId });
    return entry;
  } catch (error) {
    append(path, { ...entry, status: 'outcome-unknown' });
    throw error;
  }
  }, deps.lockContended);
}
