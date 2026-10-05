import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { redactSecretText } from '../../debug/log.js';
import { logsDbPath, LogStore } from '../../mss/logging/log-store.js';
import {
  listSchedules, parseCronLine, cronEntryId, unwrapCronCommand, scriptName, readCrontab, schedulesDbPath,
  type ScheduleRow,
} from '../../domains/schedule-registry.js';
import {
  computeScheduleState, displayName, findDuplicates, futureRuns, listLaunchdElanous,
  type LaunchdEntry, type ScheduleState,
} from '../../domains/schedule-state.js';
import { getToxRuntimeDeps } from '../../task-orchestrator/runtime-deps.js';
import { tasksDbPath } from '../../task-orchestrator/paths.js';
import { jsonResponse } from './http-server.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { listScheduleRuns } from '../../domains/schedule-runs.js';
import { listLoops } from '../../loops/registry.js';

export interface SchedulesReadDeps {
  rows?: () => ScheduleRow[];
  crontab?: () => string;
  launchd?: () => LaunchdEntry[];
  triggerIds?: () => ReadonlySet<string>;
  logsPath?: () => string;
  /** 발화 이력 원천(`schedule_runs`) — 기본은 schedules.db 를 읽기 전용으로 연다. */
  schedulesDbPath?: () => string;
  loopOwners?: () => Array<{ id: string; title: string; owner?: string | null; enabled: boolean; lastRun: { at: string; status: string } | null; jobs: Array<{ id: string }> }>;
  now?: () => Date;
}

interface ScheduleRun {
  at: string;
  status: string | null;
  exit: number | null;
  durationMs: number | null;
  via: string | null;
  matchedBy: 'name' | 'id';
  runId?: string | null;
}

interface ScheduleCard {
  id: string;
  name: string;
  source: string;
  cron: string | null;
  intervalMs: number | null;
  command: string | null;
  /** 레지스트리 메타(🅕 09-28 · PWA Schedules 탭이 대시보드 경로 없이 그리게) — 실행 주체·분류·설명. */
  runVia: string | null;
  category: string | null;
  domain: string | null;
  note: string | null;
  state: ScheduleState;
  registryEnabled: boolean;
  next: string[];
  lastRun: { at: string; status: string | null; exit: number | null; durationMs: number | null; via: string | null } | null;
  flags: string[];
  pid?: number | null;
  lastExit?: number | null;
}

/** Open only existing stores and never invoke inventory/migration on a GET. */
function registryRows(): ScheduleRow[] {
  if (!existsSync(schedulesDbPath())) return [];
  try {
    const db = new Database(schedulesDbPath(), { readonly: true });
    try { return listSchedules(db); } finally { db.close(); }
  } catch { return []; }
}

/** Match persisted TOX task identity to an *active* daemon subscription, not to registry.enabled. */
function registeredTriggerIds(): ReadonlySet<string> {
  const daemon = getToxRuntimeDeps().getWorkflowDaemon?.() as {
    status?: () => { started: boolean; subscriptions: Array<{ workflowName: string; nodeId: string }> };
  } | null | undefined;
  let status: { started: boolean; subscriptions: Array<{ workflowName: string; nodeId: string }> } | undefined;
  try { status = daemon?.status?.(); } catch { return new Set(); }
  if (!status?.started || !existsSync(tasksDbPath())) return new Set();
  const subscriptions = new Set(status.subscriptions.filter(s => s.nodeId === 'trigger').map(s => s.workflowName));
  try {
    const db = new Database(tasksDbPath(), { readonly: true });
    try {
      const tasks = db.query("SELECT id, scheduler_job_id FROM tox_tasks WHERE scheduler_job_id IS NOT NULL AND schedule_text IS NOT NULL AND status NOT IN ('done','failed','cancelled','superseded')").all() as Array<{ id: string; scheduler_job_id: string }>;
      return new Set(tasks.filter(t => subscriptions.has(`tox-task-${t.id}`)).map(t => t.scheduler_job_id));
    } finally { db.close(); }
  } catch { return new Set(); }
}

function recordedRuns(name: string, path: string = logsDbPath()): ScheduleRun[] {
  if (!existsSync(path)) return [];
  let store: LogStore;
  try { store = LogStore.openReadOnly(path); } catch { return []; }
  try {
    // The current log has no schedule id; match the exact event name, never substring grep.
    return store.query({ exactCategories: ['schedule.run'], events: [name], limit: 50 }).map(row => {
      let data: { status?: string; exit?: number | null; ms?: number | null; via?: string } = {};
      try { data = JSON.parse(row.data ?? '{}'); } catch { /* old log without JSON */ }
      return { at: row.ts, status: data.status ?? null, exit: data.exit ?? null,
        durationMs: data.ms ?? null, via: data.via ?? null, matchedBy: 'name' };
    });
  } catch { return []; } finally { store.close(); }
}

/** 행 id 로 쓴 발화 이력(`schedule_runs` · S2) — 이름 매칭보다 정확하다. 표·파일이 없으면 빈 목록. */
function idRuns(id: string, deps: SchedulesReadDeps, opts: { limit?: number; before?: string } = {}): ScheduleRun[] {
  const path = deps.schedulesDbPath?.() ?? schedulesDbPath();
  if (path !== ':memory:' && !existsSync(path)) return [];
  let db: Database;
  try { db = new Database(path, { readonly: true }); } catch { return []; }
  try {
    return listScheduleRuns(db, id, opts).map((run) => ({
      at: run.fired_at, status: run.status, exit: run.exit, durationMs: run.duration_ms, via: run.via, matchedBy: 'id' as const, runId: run.run_id,
    }));
  } finally { db.close(); }
}

function inventory(deps: SchedulesReadDeps): { cards: ScheduleCard[]; names: Map<string, string> } {
  const now = deps.now?.() ?? new Date();
  const lines = (deps.crontab ?? readCrontab)().split('\n');
  const launches = (deps.launchd ?? listLaunchdElanous)();
  const triggers = (deps.triggerIds ?? registeredTriggerIds)();
  const rows = [...(deps.rows ?? registryRows)()];
  const known = new Set(rows.map(r => r.id));
  // Bare crontab jobs are part of the live inventory even before the registry has scanned them.
  for (const line of lines) {
    const entry = parseCronLine(line);
    if (!entry) continue;
    const id = cronEntryId(entry.cron, unwrapCronCommand(entry.command));
    if (known.has(id) || rows.some(r => r.cron === entry.cron &&
      (unwrapCronCommand(r.command ?? '').trim() === unwrapCronCommand(entry.command).trim() ||
        (!!r.raw && r.raw.trim() === line.trim())))) continue;
    known.add(id);
    rows.push({ id, name: scriptName(entry.command), source: 'crontab', cron: entry.cron,
      interval_ms: null, command: entry.command, category: 'maintenance', domain: null, enabled: 0,
      last_seen: null, last_run: null, note: null, managed_by: 'manual', raw: line, run_via: 'crontab' });
  }
  const names = new Map<string, string>();
  const cards: ScheduleCard[] = rows.map(row => {
    const next = futureRuns(row, now);
    const state = computeScheduleState({ row, crontabLines: lines, triggerRegistered: triggers.has(row.id),
      launchdLoaded: false, now, nextRuns: next });
    names.set(row.id, row.name);
    return {
      id: row.id, name: redactSecretText(row.command ? displayName(row.command) : row.name), source: row.source,
      cron: row.cron, intervalMs: row.interval_ms, command: row.command ? redactSecretText(row.command) : null,
      runVia: row.run_via ?? null, category: row.category ?? null, domain: row.domain ?? null,
      note: row.note ? redactSecretText(row.note) : null,
      state, registryEnabled: !!row.enabled, next,
      lastRun: row.last_run ? { at: row.last_run, status: row.last_status ?? null, exit: row.last_exit ?? null,
        durationMs: row.last_duration_ms ?? null, via: row.last_via ?? null } : null,
      flags: [ ...(state === 'stale' ? ['stale'] : []), ...(!row.last_run ? ['no-history'] : []),
        ...(/(?:^|\s|\/)pilot(?:\/|\s|$)/.test(row.command ?? '') ? ['pilot-path'] : []) ],
    } satisfies ScheduleCard;
  });
  for (const row of rows) {
    if (!triggers.has(row.id)) continue;
    const crontabOwns = lines.some(line => {
      const parsed = parseCronLine(line);
      return !!parsed && parsed.cron === row.cron &&
        (unwrapCronCommand(parsed.command).trim() === unwrapCronCommand(row.command ?? '').trim() ||
          (!!row.raw && line.trim() === row.raw.trim()));
    });
    if (!crontabOwns) continue;
    const original = cards.find(card => card.id === row.id)!;
    cards.push({ ...original, id: `trigger:${row.id}`, source: 'trigger', runVia: 'trigger',
      state: computeScheduleState({ row: { ...row, run_via: 'trigger' }, crontabLines: [], triggerRegistered: true,
        launchdLoaded: false, now, nextRuns: original.next }) });
    names.set(`trigger:${row.id}`, row.name);
  }
  for (const launch of launches) {
    cards.push({ id: `launchd:${launch.label}`, name: launch.label.slice('com.elanous.'.length), source: 'launchd',
      cron: null, intervalMs: null, command: null, runVia: 'launchd', category: 'maintenance', domain: 'elanous', note: null, state: 'live', registryEnabled: false, next: [],
      lastRun: null, flags: ['no-history'], pid: launch.pid, lastExit: launch.lastExit });
  }
  const commands = new Map(rows.map(row => [row.id, row.command]));
  for (const row of rows) if (triggers.has(row.id)) commands.set(`trigger:${row.id}`, row.command);
  const duplicateCandidates = cards.map(card => ({ command: commands.get(card.id) ?? null,
    state: card.state, flags: [] as string[] }));
  findDuplicates(duplicateCandidates);
  duplicateCandidates.forEach((candidate, index) => {
    if (candidate.flags.includes('duplicate')) cards[index]!.flags.push('duplicate');
  });
  // The same active crontab line twice collapses into one row above; each copy still fires, so count them.
  for (const row of rows) {
    const copies = lines.filter(line => {
      const parsed = parseCronLine(line);
      return !!parsed && parsed.cron === row.cron &&
        (unwrapCronCommand(parsed.command).trim() === unwrapCronCommand(row.command ?? '').trim() ||
          (!!row.raw && line.trim() === row.raw.trim()));
    }).length;
    const card = cards.find(c => c.id === row.id);
    if (copies >= 2 && card && !card.flags.includes('duplicate')) card.flags.push('duplicate');
  }
  return { cards, names };
}

export function readSchedulesInventory(deps: SchedulesReadDeps = {}): ScheduleCard[] {
  return inventory(deps).cards;
}

export function handleSchedulesList(req: Request, opts: MetaApiOpts, deps: SchedulesReadDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const cards = readSchedulesInventory(deps);
  const schedules = new URL(req.url).searchParams.get('includeOff') === '1' ? cards : cards.filter(c => c.state !== 'off');
  if (new URL(req.url).searchParams.get('includeOwners') === '1') {
    try {
      const owners = (deps.loopOwners ?? (() => listLoops({ schedules: registryRows() })))().map(loop => ({ id: loop.id, title: redactSecretText(loop.title), owner: loop.owner ?? null,
        enabled: loop.enabled, lastRun: loop.lastRun ? { at: loop.lastRun.at, status: loop.lastRun.status } : null,
        jobs: loop.jobs.map(job => job.id) }));
      return jsonResponse({ schedules, count: schedules.length, owners }, 200);
    } catch {
      // The ordinary inventory stays readable; an opted-in map must not mistake an outage for unowned loops.
      return jsonResponse({ schedules, count: schedules.length, owners: null }, 200);
    }
  }
  return jsonResponse({ schedules, count: schedules.length }, 200);
}

export function handleScheduleDetail(req: Request, id: string, opts: MetaApiOpts, deps: SchedulesReadDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return jsonResponse({ error: 'bad_request' }, 400);
  const { cards, names } = inventory(deps);
  const schedule = cards.find(card => card.id === id);
  if (!schedule) return jsonResponse({ error: 'not_found' }, 404);
  const byId = idRuns(id, deps);
  const runs = byId.length ? byId : names.has(id) ? recordedRuns(names.get(id)!, deps.logsPath?.()) : [];
  return jsonResponse({ schedule, runs }, 200);
}

/** `GET /v1/schedules/:id/runs?before=&limit=` — 행 id 로 쓴 발화 이력 쪽 넘김(최신순 · 기본 50 · 상한 500). */
export function handleScheduleRuns(req: Request, id: string, opts: MetaApiOpts, deps: SchedulesReadDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return jsonResponse({ error: 'bad_request' }, 400);
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const before = url.searchParams.get('before') ?? undefined;
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  try {
    const runs = idRuns(id, deps, { ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) });
    return jsonResponse({ id, runs, count: runs.length }, 200);
  } catch (error) {
    return jsonResponse({ error: 'bad_request', reason: error instanceof Error ? error.message : String(error) }, 400);
  }
}
