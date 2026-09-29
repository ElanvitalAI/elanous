import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { emitDecision } from '../live/detail-switch.js';
import { cronMatches } from '../domains/cron-match.js';
import { resolveTimeZone } from '../time/format.js';
import { inventoryCrontab, listSchedules, openSchedulesDb, type ScheduleRow } from '../domains/schedule-registry.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';

export interface LoopRun {
  at: string;
  status: GraphRunState['status'];
  path: string;
  runId: string;
  failedNodes: string[];
  durationMs: number | null;
}
export interface LoopEntry {
  id: string;
  title: string;
  description: string | null;
  file: string;
  trigger: { cron: string | null; events: string[] };
  jobs: Array<{ id: string; cron: string | null; enabled: boolean }>;
  enabled: boolean;
  lastRun: LoopRun | null;
  nextRun: string | null;
}
export interface LoopRegistryOptions {
  root?: string;
  stateRoot?: string;
  now?: Date;
  /** An already-inventoried registry; keeps focused tests isolated. */
  schedules?: ScheduleRow[];
  scheduleAction?: (action: 'create' | 'enable' | 'disable', args: Record<string, unknown>) => Promise<unknown>;
}

function graphFiles(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap(e => e.isDirectory() ? graphFiles(join(dir, e.name)) : e.isFile() && /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []).sort();
}

/** Match only the actual graph CLI invocation, not a filename mentioned in a shell argument. */
export function graphJobMatches(command: string | null, file: string, root: string): boolean {
  if (!command) return false;
  const invocation = /(?:^|&&\s*|;\s*)(?:(?:\S*\/)?(?:bun|node)\s+(?:\S*\/)?bin\/elanous\.mjs|(?:\S*\/)?elanous)\s+(?:--test(?:=\S+|\s+\S+)\s+)?graph\s+run\s+(['"]?)([^\s'";&|]+)\1(?=\s|$|[;&|])/g;
  for (const match of command.matchAll(invocation)) {
    const arg = match[2]!;
    if (resolve(root, arg) === file || (isAbsolute(arg) && resolve(arg) === file)) return true;
  }
  return false;
}

function recentRuns(id: string, stateRoot: string, count = 5): LoopRun[] {
  const dir = join(stateRoot, 'graph-runs', id);
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.decision.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files.map(file => ({ file, at: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, count).map(({ file, at }) => {
      const path = join(dir, file);
      const state = JSON.parse(readFileSync(path, 'utf8')) as GraphRunState;
      if (state.graphId !== id) throw new Error(`graph run identity mismatch: ${path}`);
      const start = state.startedAt ? Date.parse(state.startedAt) : NaN;
      const end = state.finishedAt ? Date.parse(state.finishedAt) : NaN;
      return { at: state.startedAt ?? new Date(at).toISOString(), status: state.status, path, runId: state.runId,
        failedNodes: state.nodes.filter(n => !n.ok || !!n.error).map(n => n.nodeId),
        durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null };
    });
}

export function nextLoopFire(cron: string, now: Date): string | null {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  let minute = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  const timeZone = resolveTimeZone().timeZone;
  // Covers leap years and annual cron expressions; a nonmatching expression stays unknown.
  for (let i = 0; i < 527040; i++, minute += 60000) {
    if (cronMatches(cron, new Date(minute), { timeZone })) return new Date(minute).toISOString();
  }
  return null;
}

function schedules(opts: LoopRegistryOptions): ScheduleRow[] {
  if (opts.schedules) return opts.schedules;
  const db: Database = openSchedulesDb();
  try {
    inventoryCrontab(db);
    return listSchedules(db);
  } finally { db.close(); }
}

export function listLoops(opts: LoopRegistryOptions = {}): LoopEntry[] {
  const root = resolve(opts.root ?? process.cwd());
  const stateRoot = opts.stateRoot ?? effectiveInstanceRoot();
  const rows = schedules(opts);
  const loops: LoopEntry[] = [];
  for (const file of graphFiles(join(root, 'graphs'))) {
    let doc: Record<string, unknown> | null;
    try { doc = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown> | null; }
    catch (error) {
      debug.log('loops.registry', 'graph-read-failed', { file, error: String(error) });
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.graph_id !== 'string' || !doc.graph_id) continue;
    const header = doc.loop && typeof doc.loop === 'object' && !Array.isArray(doc.loop) ? doc.loop as Record<string, unknown> : null;
    const trigger = header?.trigger && typeof header.trigger === 'object' && !Array.isArray(header.trigger) ? header.trigger as Record<string, unknown> : null;
    const declaredCron = typeof trigger?.cron === 'string' ? trigger.cron : null;
    const events = Array.isArray(trigger?.events) ? trigger.events.filter((e): e is string => typeof e === 'string') : [];
    const matched = rows.filter(row => graphJobMatches(row.command, file, root) && row.source === 'crontab' && row.run_via === 'crontab' && row.disabled_reason !== 'vanished');
    if (!declaredCron && !events.length && !matched.length) continue;
    if (!/^[a-zA-Z0-9][\w.-]*$/.test(doc.graph_id)) throw new Error(`unsafe loop graph_id: ${doc.graph_id}`);
    if (loops.some(loop => loop.id === doc.graph_id)) throw new Error(`duplicate loop graph_id: ${doc.graph_id}`);
    const jobs = matched.map(row => ({ id: row.id, cron: row.cron, enabled: !!row.enabled }));
    const active = matched.filter(row => !!row.enabled && !!row.cron);
    const next = active.map(row => nextLoopFire(row.cron!, opts.now ?? new Date())).filter((v): v is string => v !== null).sort()[0] ?? null;
    const entry: LoopEntry = { id: doc.graph_id, title: typeof header?.title === 'string' ? header.title : doc.graph_id,
      description: typeof header?.description === 'string' ? header.description : null, file: relative(root, file),
      trigger: { cron: declaredCron, events }, jobs, enabled: matched.some(row => !!row.enabled),
      lastRun: recentRuns(doc.graph_id, stateRoot, 1)[0] ?? null, nextRun: next };
    loops.push(entry);
  }
  debug.log('loops.registry', 'list', { count: loops.length });
  return loops;
}

export function loopStatus(id: string, opts: LoopRegistryOptions = {}): LoopEntry & { recentRuns: LoopRun[] } {
  const loop = listLoops(opts).find(entry => entry.id === id);
  if (!loop) throw new Error(`loop not found: ${id}`);
  const recent = recentRuns(id, opts.stateRoot ?? effectiveInstanceRoot());
  debug.log('loops.registry', 'status', { id, runs: recent.length });
  return { ...loop, recentRuns: recent };
}

export async function setLoopEnabled(id: string, enabled: boolean, yes = false, opts: LoopRegistryOptions = {}): Promise<unknown> {
  const loop = loopStatus(id, opts);
  const action = enabled ? 'start' : 'stop';
  if (!loop.jobs.length && (!enabled || !loop.trigger.cron)) throw new Error(`loop ${id} has no cron job to ${action}`);
  const pending = loop.jobs.filter(job => job.enabled !== enabled);
  if (!pending.length && loop.jobs.length) return { action, id, changed: false, enabled: loop.enabled };
  const changes = loop.jobs.length ? pending.map(job => ({ action: enabled ? 'enable' : 'disable', id: job.id })) :
    [{ action: 'create', cron: loop.trigger.cron, command: `elanous graph run ${loop.file}` }];
  if (!yes) return { action, id, dryRun: true, changes, note: 'Apply with --yes (crontab backup).' };
  const dispatch = opts.scheduleAction ?? (async (kind: 'create' | 'enable' | 'disable', args: Record<string, unknown>) => {
    const { dispatchScheduleManage } = await import('../domains/schedule-manage-tool.js');
    return dispatchScheduleManage({ action: kind, ...args });
  });
  const results = [];
  for (const change of changes) {
    const { action: kind, ...args } = change;
    const result = await dispatch(kind as 'create' | 'enable' | 'disable', args);
    if (result && typeof result === 'object' && 'error' in result) throw new Error(String(result.error));
    results.push(result);
  }
  debug.log('loops.registry', action, { id, changes });
  emitDecision({ kind: 'ROUTE', what: `루프 ${enabled ? '켬' : '끔'}: ${id}`, reason: enabled ? '사용자 요청으로 예약 발화 활성화' : '사용자 요청으로 예약 발화 일시 중지', purpose: '루프 라이프사이클 제어', target: id });
  return { action, id, changed: true, results };
}

export async function runLoop(id: string, dryRun = false, opts: LoopRegistryOptions = {}): Promise<GraphRunState> {
  const loop = loopStatus(id, opts);
  debug.log('loops.registry', 'run', { id, dryRun });
  return runGraph(join(resolve(opts.root ?? process.cwd()), loop.file), { dryRun, deps: { root: opts.stateRoot ?? effectiveInstanceRoot() } });
}
