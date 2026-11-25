/**
 * Graph trigger registry — the single SSOT for «which graph fires when, for whom, and what counts as done».
 *
 * SCHEDULER-TO-GRAPH-RUNNER Phase 1 (대표 11-25 P0). A loop graph declares its trigger in its `loop:` header
 * (cron · owner · goal predicate · failure policy · legacy path). `registerTrigger` copies that declaration
 * into one registry row (graph_trigger_registry in the same graph-trigger-registry.db that already holds the
 * per-run dispatch bindings), and one crontab entry — `eln loop trigger tick` — drives every registered graph.
 *
 * Per tick, per trigger:
 *   1. due window = latest cron fire ≤ now (older missed windows are recorded `stale-skipped`, never replayed).
 *   2. claim (graph_id, window) with INSERT OR IGNORE → a double trigger / concurrent tick dedupes to one run.
 *   3. run the graph (runId bound through registerGraphTriggerRun so the run identity is the existing SSOT).
 *   4. goal predicate (checkable from a file or ledger) decides done; a failed run or a missed goal deadline
 *      retries with backoff, and exhausting retries posts an exception card to the owner — never silent.
 *   5. shadow → live: in `shadow` the graph writes only a shadow receipt (no side effect) while the legacy path
 *      keeps running; after N goal-verified shadow windows the legacy entry is disabled (schedule CRUD or a
 *      cutover marker) and only then the trigger turns `live` — legacy first, so there is no gap and no double.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { previousLoopFire } from './schedule-due.js';
import { registerGraphTriggerDispatchBinding } from './graph-trigger-dispatch-lease.js';
import { evaluatePredicate, parsePredicate, parseWhen, type ConditionProbes, type Predicate } from './trigger-conditions.js';

export type TriggerStage = 'shadow' | 'live' | 'retired';
export type FireStatus = 'running' | 'dispatched' | 'retry-wait' | 'done' | 'exception' | 'stale-skipped';

export type GoalDecl =
  | { kind: 'file-mtime'; path: string }
  | { kind: 'ledger-line'; path: string; contains: string };

export type LegacyDecl =
  | { kind: 'schedule'; id: string }
  | { kind: 'marker'; path: string };

/**
 * Condition trigger: fire when `predicate` holds with a key not fired before (edge + dedupe), at most once per
 * `cooldownMin`. `maxWaitMin` (relative to the last fire) or `maxWaitAt` (absolute, e.g. a release cutAt) is the
 * fallback clock: when it passes with the predicate still false, `onMaxWait` decides — `fire` runs the graph once
 * (bulletin «30 min max»), `card` tells the owner once and does NOT run it (release cut without notes is never silent).
 */
export interface ConditionDecl {
  predicate: Predicate;
  cooldownMin: number;
  maxWaitMin?: number;
  maxWaitAt?: string;
  onMaxWait: 'fire' | 'card';
}

export interface TriggerDecl {
  graphId: string;
  file: string;
  owner: string;
  /** Exactly one of cron / condition. */
  cron?: string;
  condition?: ConditionDecl;
  timeZone?: string;
  goal: GoalDecl;
  /** Minutes after dispatch by which the goal must hold, else the window counts as failed. */
  goalDeadlineMin: number;
  maxAttempts: number;
  /** Backoff before attempt k+1 (seconds), indexed by k-1; the last value repeats. */
  backoffSec: number[];
  legacy?: LegacyDecl;
  /** Goal-verified shadow windows before cutover. */
  cutoverAfter: number;
  /** A due window older than this is not fired (restart catch-up fires only the latest window). */
  staleAfterMin: number;
}

export interface TriggerRow extends TriggerDecl {
  stage: TriggerStage;
  shadowSuccesses: number;
  declSha: string;
  registeredAt: string;
  lastWindow: string | null;
  lastStatus: FireStatus | null;
  lastRunId: string | null;
  lastAt: string | null;
}

export interface FireRow {
  graphId: string;
  window: string;
  stage: TriggerStage;
  status: FireStatus;
  attempt: number;
  runId: string | null;
  dispatchedAt: string | null;
  checkAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
  card: string | null;
}

export interface TickRunResult { status: string; runId: string; error?: string }

export interface TriggerTickDeps {
  now: () => Date;
  /** Run one graph for a window; the engine never spawns on its own so sims inject a virtual runner. */
  runGraph: (decl: TriggerDecl, input: TriggerRunInput, runId: string) => Promise<TickRunResult>;
  /** Exception card to the owner; must return an identifier (mail id) — the engine records it. */
  postCard: (owner: string, body: string) => Promise<string>;
  /** Disable / enable a legacy schedule through the schedule CRUD. */
  scheduleAction: (action: 'disable' | 'enable', id: string) => Promise<void>;
  /** Template variables for goal and marker paths. */
  vars: { seatState: string; stateRoot: string };
  /** Condition predicate probes (required only when a condition trigger is registered). */
  probes?: ConditionProbes;
  /** Global `loops.trigger.cutoverAfter` override; 0 = cut over on the first tick after register (no shadow run). */
  cutoverAfterOverride?: number;
}

export interface TriggerRunInput {
  graphId: string;
  window: string;
  stage: TriggerStage;
  attempt: number;
  shadowDir: string;
  vars: TriggerTickDeps['vars'];
  /** Why this run fired: `cron`, `condition: <evidence>`, `max-wait: <evidence>`. */
  reason?: string;
}

export interface TickEvent {
  graphId: string;
  window?: string;
  event: 'fired' | 'deduped' | 'stale-skipped' | 'done' | 'retry-scheduled' | 'exception' | 'cutover' | 'cutover-failed' | 'goal-pending'
    | 'cooldown-held' | 'max-wait-card' | 'condition-error';
  detail?: string;
}

const DEFAULT_POLICY = { goalDeadlineMin: 20, maxAttempts: 3, backoffSec: [60, 300], cutoverAfter: 2, staleAfterMin: 30 } as const;
/** Extra minutes past the goal deadline before a silent `running` claim is treated as a dead tick. */
const RUNNING_GRACE_MIN = 10;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function triggerRegistryPath(stateRoot: string): string { return join(stateRoot, 'graph-trigger-registry.db'); }

export function openTriggerRegistry(stateRoot: string): Database {
  mkdirSync(stateRoot, { recursive: true });
  const db = new Database(triggerRegistryPath(stateRoot));
  db.exec('PRAGMA busy_timeout = 5000'); // Source: same bounded lock wait as graph-trigger-dispatch-lease.ts.
  db.exec(`CREATE TABLE IF NOT EXISTS graph_trigger_registry (
    graph_id TEXT PRIMARY KEY,
    decl_json TEXT NOT NULL,
    decl_sha TEXT NOT NULL,
    stage TEXT NOT NULL,
    shadow_successes INTEGER NOT NULL DEFAULT 0,
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS graph_trigger_fires (
    graph_id TEXT NOT NULL,
    window TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    run_id TEXT,
    dispatched_at TEXT,
    check_at TEXT,
    next_retry_at TEXT,
    error TEXT,
    card TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (graph_id, window)
  )`);
  try { db.exec('ALTER TABLE graph_trigger_fires ADD COLUMN reason TEXT'); } catch { /* already there */ }
  db.exec(`CREATE TABLE IF NOT EXISTS graph_trigger_conditions (
    graph_id TEXT PRIMARY KEY,
    fired_key TEXT,
    last_fire_at TEXT,
    max_wait_done TEXT,
    last_eval_at TEXT,
    last_met INTEGER,
    last_evidence TEXT
  )`);
  return db;
}

function sha(text: string): string { return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16); }

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Read the trigger declaration from a graph's `loop:` header. Throws when a field the engine needs is missing. */
export function readTriggerDecl(file: string, root: string): TriggerDecl {
  const path = resolve(root, file);
  const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!doc || typeof doc.graph_id !== 'string' || !SAFE_ID.test(doc.graph_id)) throw new Error(`trigger graph has no safe graph_id: ${file}`);
  const loop = (doc.loop ?? {}) as Record<string, unknown>;
  const trigger = (loop.trigger ?? {}) as Record<string, unknown>;
  const goal = loop.goal as Record<string, unknown> | undefined;
  const failure = (loop.failure ?? {}) as Record<string, unknown>;
  const legacy = loop.legacy as Record<string, unknown> | undefined;
  const hasCron = typeof trigger.cron === 'string';
  if (hasCron === (trigger.condition !== undefined)) throw new Error(`trigger ${doc.graph_id}: loop.trigger needs exactly one of cron | condition`);
  if (hasCron && (trigger.cron as string).trim().split(/\s+/).length !== 5) throw new Error(`trigger ${doc.graph_id}: loop.trigger.cron must be a 5-field cron`);
  let condition: ConditionDecl | undefined;
  if (!hasCron) {
    const c = trigger.condition as Record<string, unknown>;
    if (!c || typeof c !== 'object') throw new Error(`trigger ${doc.graph_id}: loop.trigger.condition must be an object`);
    if (c.on_max_wait !== undefined && c.on_max_wait !== 'fire' && c.on_max_wait !== 'card') throw new Error(`trigger ${doc.graph_id}: on_max_wait must be fire|card`);
    if (c.max_wait_at !== undefined && (typeof c.max_wait_at !== 'string' || Number.isNaN(Date.parse(c.max_wait_at)))) throw new Error(`trigger ${doc.graph_id}: max_wait_at must be an ISO time`);
    if ((c.predicate === undefined) === (c.when === undefined)) throw new Error(`trigger ${doc.graph_id}: condition needs exactly one of predicate | when`);
    condition = { predicate: c.when !== undefined ? parseWhen(c.when, `trigger ${doc.graph_id}: condition.when`) : parsePredicate(c.predicate, `trigger ${doc.graph_id}: condition.predicate`), cooldownMin: num(c.cooldown_min, 0),
      ...(typeof c.max_wait_min === 'number' ? { maxWaitMin: num(c.max_wait_min, 0) } : {}),
      ...(typeof c.max_wait_at === 'string' ? { maxWaitAt: c.max_wait_at } : {}),
      onMaxWait: c.on_max_wait === 'card' ? 'card' : 'fire' };
  }
  if (typeof loop.owner !== 'string' || !loop.owner) throw new Error(`trigger ${doc.graph_id}: loop.owner is required (exception cards go there)`);
  if (!goal || (goal.kind !== 'file-mtime' && goal.kind !== 'ledger-line') || typeof goal.path !== 'string')
    throw new Error(`trigger ${doc.graph_id}: loop.goal {kind: file-mtime|ledger-line, path} is required — a trigger without a checkable done-when is refused`);
  if (goal.kind === 'ledger-line' && typeof goal.contains !== 'string') throw new Error(`trigger ${doc.graph_id}: ledger-line goal needs contains`);
  let legacyDecl: LegacyDecl | undefined;
  if (legacy) {
    if (legacy.kind === 'schedule' && typeof legacy.id === 'string') legacyDecl = { kind: 'schedule', id: legacy.id };
    else if (legacy.kind === 'marker' && typeof legacy.path === 'string') legacyDecl = { kind: 'marker', path: legacy.path };
    else throw new Error(`trigger ${doc.graph_id}: loop.legacy must be {kind: schedule, id} or {kind: marker, path}`);
  }
  const backoff = Array.isArray(failure.backoff_sec) && failure.backoff_sec.every(v => typeof v === 'number' && v >= 0)
    ? failure.backoff_sec as number[] : [...DEFAULT_POLICY.backoffSec];
  return {
    graphId: doc.graph_id, file, owner: loop.owner, ...(hasCron ? { cron: (trigger.cron as string).trim() } : { condition: condition! }),
    ...(typeof trigger.time_zone === 'string' ? { timeZone: trigger.time_zone } : {}),
    goal: goal.kind === 'file-mtime' ? { kind: 'file-mtime', path: goal.path as string } : { kind: 'ledger-line', path: goal.path as string, contains: goal.contains as string },
    goalDeadlineMin: num(failure.goal_deadline_min, DEFAULT_POLICY.goalDeadlineMin),
    maxAttempts: Math.max(1, Math.floor(num(failure.max_attempts, DEFAULT_POLICY.maxAttempts))),
    backoffSec: backoff.length ? backoff : [...DEFAULT_POLICY.backoffSec],
    ...(legacyDecl ? { legacy: legacyDecl } : {}),
    cutoverAfter: Math.max(1, Math.floor(num(loop.cutover_after, DEFAULT_POLICY.cutoverAfter))),
    staleAfterMin: num(trigger.stale_after_min, DEFAULT_POLICY.staleAfterMin),
  };
}

function rowFrom(raw: Record<string, unknown>, db: Database): TriggerRow {
  const decl = JSON.parse(String(raw.decl_json)) as TriggerDecl;
  const last = db.query(`SELECT window, status, run_id, updated_at FROM graph_trigger_fires WHERE graph_id = ? ORDER BY window DESC LIMIT 1`)
    .get(decl.graphId) as { window: string; status: FireStatus; run_id: string | null; updated_at: string } | null;
  return { ...decl, stage: raw.stage as TriggerStage, shadowSuccesses: Number(raw.shadow_successes), declSha: String(raw.decl_sha),
    registeredAt: String(raw.registered_at), lastWindow: last?.window ?? null, lastStatus: last?.status ?? null,
    lastRunId: last?.run_id ?? null, lastAt: last?.updated_at ?? null };
}

/**
 * Single registration. The same declaration twice is a no-op (`created: false`); a different declaration for an
 * already registered graph is refused unless `update` is set — two writers cannot silently overwrite each other.
 * New triggers start in `shadow` when they declare a legacy path, otherwise `live`.
 */
export function registerTrigger(db: Database, decl: TriggerDecl, options: { now?: Date; update?: boolean } = {}): { created: boolean; updated: boolean; row: TriggerRow } {
  const json = JSON.stringify(decl);
  const declSha = sha(json);
  const at = (options.now ?? new Date()).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(decl.graphId) as Record<string, unknown> | null;
    let created = false; let updated = false;
    if (!existing) {
      db.query(`INSERT INTO graph_trigger_registry (graph_id, decl_json, decl_sha, stage, shadow_successes, registered_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)`).run(decl.graphId, json, declSha, decl.legacy ? 'shadow' : 'live', at, at);
      created = true;
    } else if (existing.decl_sha !== declSha) {
      if (!options.update) throw new Error(`trigger ${decl.graphId} is already registered with a different declaration (sha ${String(existing.decl_sha)} ≠ ${declSha}); re-register with --update`);
      db.query('UPDATE graph_trigger_registry SET decl_json = ?, decl_sha = ?, updated_at = ? WHERE graph_id = ?').run(json, declSha, at, decl.graphId);
      updated = true;
    }
    db.exec('COMMIT');
    const row = rowFrom(db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(decl.graphId) as Record<string, unknown>, db);
    debug.log('loops.trigger-registry', 'register', { graphId: decl.graphId, created, updated, stage: row.stage });
    return { created, updated, row };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function listTriggers(db: Database): TriggerRow[] {
  return (db.query('SELECT * FROM graph_trigger_registry ORDER BY graph_id').all() as Record<string, unknown>[]).map(raw => rowFrom(raw, db));
}

export function listFires(db: Database, graphId?: string, limit = 50): FireRow[] {
  const rows = (graphId
    ? db.query('SELECT * FROM graph_trigger_fires WHERE graph_id = ? ORDER BY window DESC LIMIT ?').all(graphId, limit)
    : db.query('SELECT * FROM graph_trigger_fires ORDER BY window DESC LIMIT ?').all(limit)) as Record<string, unknown>[];
  return rows.map(r => ({ graphId: String(r.graph_id), window: String(r.window), stage: r.stage as TriggerStage, status: r.status as FireStatus,
    attempt: Number(r.attempt), runId: (r.run_id as string | null) ?? null, dispatchedAt: (r.dispatched_at as string | null) ?? null,
    checkAt: (r.check_at as string | null) ?? null, nextRetryAt: (r.next_retry_at as string | null) ?? null,
    error: (r.error as string | null) ?? null, card: (r.card as string | null) ?? null }));
}

function windowDate(window: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(Number.isNaN(Date.parse(window)) ? new Date() : new Date(window)); // a manual run has no window: today
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

export function expandTemplate(template: string, vars: TriggerTickDeps['vars'], window: string, timeZone?: string): string {
  const out = template
    .replaceAll('{seatState}', vars.seatState)
    .replaceAll('{stateRoot}', vars.stateRoot)
    .replaceAll('{window}', window)
    .replaceAll('{date}', windowDate(window, timeZone));
  return out.startsWith('~/') ? join(homedir(), out.slice(2)) : out;
}

/** The goal predicate: true only when the declared effect is observable for this window. */
export function goalHolds(decl: TriggerDecl, window: string, vars: TriggerTickDeps['vars']): { ok: boolean; why: string } {
  const path = expandTemplate(decl.goal.path, vars, window, decl.timeZone);
  if (!existsSync(path)) return { ok: false, why: `goal file missing: ${path}` };
  if (decl.goal.kind === 'file-mtime') {
    const mtime = statSync(path).mtimeMs;
    return mtime >= Date.parse(window) ? { ok: true, why: `${path} updated ${new Date(mtime).toISOString()} ≥ window` }
      : { ok: false, why: `${path} last updated ${new Date(mtime).toISOString()} < window ${window}` };
  }
  const needle = expandTemplate(decl.goal.contains, vars, window, decl.timeZone);
  return readFileSync(path, 'utf8').split('\n').some(line => line.includes(needle))
    ? { ok: true, why: `${path} has a line containing ${needle}` } : { ok: false, why: `${path} has no line containing ${needle}` };
}

function setFire(db: Database, graphId: string, window: string, fields: Partial<Record<'status' | 'attempt' | 'run_id' | 'dispatched_at' | 'check_at' | 'next_retry_at' | 'error' | 'card', string | number | null>>, at: string, guard?: { status: FireStatus; attempt: number }): boolean {
  const keys = Object.keys(fields);
  const sql = `UPDATE graph_trigger_fires SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE graph_id = ? AND window = ?${guard ? ' AND status = ? AND attempt = ?' : ''}`;
  const params = [...keys.map(k => fields[k as keyof typeof fields] ?? null), at, graphId, window, ...(guard ? [guard.status, guard.attempt] : [])];
  return db.query(sql).run(...(params as Array<string | number | null>)).changes === 1;
}

async function dispatch(db: Database, row: TriggerRow, window: string, attempt: number, deps: TriggerTickDeps, events: TickEvent[]): Promise<void> {
  const now = deps.now();
  const at = now.toISOString();
  // Run identity goes through the existing binding SSOT: same (trigger, window#attempt) → same runId.
  const triggerId = `${row.condition ? 'condition' : 'cron'}:${row.graphId}`;
  const bindOpts = { registryRoot: deps.vars.stateRoot, stateRoot: deps.vars.stateRoot };
  let binding = registerGraphTriggerDispatchBinding({ triggerId, dedupeKey: `${window}#${attempt}`, graphId: row.graphId }, bindOpts);
  // A reused binding means this (window, attempt) already started a run once (crash recovery re-dispatch, or a
  // retry landing on an old key): the graph runner refuses an existing run id, so bind a fresh one (11-25 op-pulse).
  for (let n = 2; !binding.created; n++)
    binding = registerGraphTriggerDispatchBinding({ triggerId, dedupeKey: `${window}#${attempt}~${n}`, graphId: row.graphId }, bindOpts);
  setFire(db, row.graphId, window, { run_id: binding.runId }, at);
  const reason = (db.query('SELECT reason FROM graph_trigger_fires WHERE graph_id = ? AND window = ?').get(row.graphId, window) as { reason: string | null } | null)?.reason;
  const input: TriggerRunInput = { graphId: row.graphId, window, stage: row.stage, attempt,
    shadowDir: join(deps.vars.stateRoot, 'loops', 'shadow', row.graphId), vars: deps.vars, ...(reason ? { reason } : {}) };
  let result: TickRunResult;
  try { result = await deps.runGraph(row, input, binding.runId); }
  catch (error) { result = { status: 'failed', runId: binding.runId, error: error instanceof Error ? error.message : String(error) }; }
  const after = deps.now().toISOString();
  if (result.status === 'done') {
    const checkAt = new Date(deps.now().getTime() + row.goalDeadlineMin * 60_000).toISOString();
    setFire(db, row.graphId, window, { status: 'dispatched', dispatched_at: after, check_at: checkAt, error: null }, after);
    events.push({ graphId: row.graphId, window, event: 'fired', detail: `attempt ${attempt} run ${binding.runId}` });
    return;
  }
  await fail(db, row, window, attempt, `graph run ${result.status}${result.error ? `: ${result.error}` : ''}`, deps, events);
}

async function fail(db: Database, row: TriggerRow, window: string, attempt: number, why: string, deps: TriggerTickDeps, events: TickEvent[]): Promise<void> {
  const now = deps.now();
  const at = now.toISOString();
  if (attempt < row.maxAttempts) {
    const backoff = row.backoffSec[Math.min(attempt - 1, row.backoffSec.length - 1)] ?? 60;
    setFire(db, row.graphId, window, { status: 'retry-wait', next_retry_at: new Date(now.getTime() + backoff * 1000).toISOString(), error: why }, at);
    events.push({ graphId: row.graphId, window, event: 'retry-scheduled', detail: `attempt ${attempt}/${row.maxAttempts} failed (${why}); retry in ${backoff}s` });
    debug.log('loops.trigger-registry', 'retry-scheduled', { graphId: row.graphId, window, attempt, why });
    return;
  }
  setFire(db, row.graphId, window, { status: 'exception', error: why }, at);
  const body = `[graph-trigger exception] ${row.graphId} window ${window} (${row.stage}) failed ${attempt}/${row.maxAttempts} attempts: ${why}. `
    + `Goal: ${row.goal.kind} ${row.goal.path}. Re-run: eln loop trigger retry ${row.graphId} --window ${window}`;
  let card: string;
  try { card = await deps.postCard(row.owner, body); }
  catch (error) { card = `card-post-failed: ${error instanceof Error ? error.message : String(error)}`; }
  setFire(db, row.graphId, window, { card }, at);
  events.push({ graphId: row.graphId, window, event: 'exception', detail: `${why} → card ${card} to ${row.owner}` });
  debug.log('loops.trigger-registry', 'exception', { graphId: row.graphId, window, attempt, why, card });
}

async function cutover(db: Database, row: TriggerRow, deps: Pick<TriggerTickDeps, 'now' | 'vars' | 'scheduleAction' | 'postCard'>, events: TickEvent[], reason?: string): Promise<boolean> {
  const at = deps.now().toISOString();
  try {
    // Legacy first: the trigger turns live only after the old path is off — no double fire, and while the
    // legacy path is still on, the graph is still shadow — no gap.
    if (row.legacy?.kind === 'schedule') await deps.scheduleAction('disable', row.legacy.id);
    else if (row.legacy?.kind === 'marker') {
      const path = expandTemplate(row.legacy.path, deps.vars, at);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ graphId: row.graphId, cutoverAt: at, shadowSuccesses: row.shadowSuccesses })}\n`);
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    events.push({ graphId: row.graphId, event: 'cutover-failed', detail: why });
    try { await deps.postCard(row.owner, `[graph-trigger cutover failed] ${row.graphId}: legacy ${JSON.stringify(row.legacy)} not disabled (${why}); trigger stays shadow, legacy keeps running.`); }
    catch { /* the event row above is the record */ }
    return false;
  }
  db.query(`UPDATE graph_trigger_registry SET stage = 'live', updated_at = ? WHERE graph_id = ? AND stage = 'shadow'`).run(at, row.graphId);
  events.push({ graphId: row.graphId, event: 'cutover', detail: `legacy ${JSON.stringify(row.legacy)} disabled ${reason ?? `after ${row.shadowSuccesses} shadow successes`}` });
  debug.log('loops.trigger-registry', 'cutover', { graphId: row.graphId, legacy: row.legacy, reason });
  return true;
}

/** Effective shadow-success threshold: the global config override wins over the declaration. */
export function effectiveCutoverAfter(row: Pick<TriggerRow, 'cutoverAfter'>, override?: number): number {
  return typeof override === 'number' && Number.isFinite(override) && override >= 0 ? Math.floor(override) : row.cutoverAfter;
}

/**
 * Manual promote shadow → live without waiting for goal-verified shadow fires. Same order as the automatic
 * cutover — legacy disabled (marker written / schedule off) first, stage live second — so no gap and no double.
 * A trigger without a legacy path is set live directly; an already-live trigger is a no-op.
 */
export async function promoteTrigger(db: Database, graphId: string, deps: Pick<TriggerTickDeps, 'now' | 'vars' | 'scheduleAction' | 'postCard'>,
  reason?: string): Promise<{ row: TriggerRow; events: TickEvent[] }> {
  const raw = db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(graphId) as Record<string, unknown> | null;
  if (!raw) throw new Error(`trigger not registered: ${graphId}`);
  const row = rowFrom(raw, db);
  const events: TickEvent[] = [];
  if (row.stage === 'retired') throw new Error(`trigger ${graphId} is retired`);
  if (row.stage !== 'live') {
    const why = `by manual promote${reason ? `: ${reason}` : ''}`;
    if (row.legacy) {
      if (!await cutover(db, row, deps, events, why)) throw new Error(`promote ${graphId} failed: ${events.at(-1)?.detail ?? 'legacy not disabled'}; trigger stays shadow`);
    } else {
      db.query(`UPDATE graph_trigger_registry SET stage = 'live', updated_at = ? WHERE graph_id = ? AND stage = 'shadow'`).run(deps.now().toISOString(), graphId);
      events.push({ graphId, event: 'cutover', detail: `no legacy path; live ${why}` });
    }
  }
  return { row: rowFrom(db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(graphId) as Record<string, unknown>, db), events };
}

/** Roll a live trigger back to shadow: re-enable the legacy path first, then reset the shadow count. */
export async function rollbackTrigger(db: Database, graphId: string, deps: Pick<TriggerTickDeps, 'scheduleAction' | 'vars' | 'now'>): Promise<TriggerRow> {
  const raw = db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(graphId) as Record<string, unknown> | null;
  if (!raw) throw new Error(`trigger not registered: ${graphId}`);
  const row = rowFrom(raw, db);
  if (!row.legacy) throw new Error(`trigger ${graphId} has no legacy path to roll back to`);
  if (row.legacy.kind === 'schedule') await deps.scheduleAction('enable', row.legacy.id);
  else {
    const path = expandTemplate(row.legacy.path, deps.vars, deps.now().toISOString());
    if (existsSync(path)) (await import('node:fs')).rmSync(path);
  }
  db.query(`UPDATE graph_trigger_registry SET stage = 'shadow', shadow_successes = 0, updated_at = ? WHERE graph_id = ?`).run(deps.now().toISOString(), graphId);
  return rowFrom(db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(graphId) as Record<string, unknown>, db);
}

/** Re-arm one exception window for a manual retry (attempt counter restarts). */
export function retryWindow(db: Database, graphId: string, window: string, now = new Date()): boolean {
  return db.query(`UPDATE graph_trigger_fires SET status = 'retry-wait', attempt = 0, next_retry_at = ?, card = NULL, updated_at = ?
    WHERE graph_id = ? AND window = ? AND status = 'exception'`).run(now.toISOString(), now.toISOString(), graphId, window).changes === 1;
}

interface ConditionState { fired_key: string | null; last_fire_at: string | null; max_wait_done: string | null }

/** Claim a condition fire with compare-and-set on the state row, so two concurrent ticks fire one run. */
function claimConditionFire(db: Database, graphId: string, prev: ConditionState, next: { key: string; at: string }): boolean {
  return db.query(`UPDATE graph_trigger_conditions SET fired_key = ?, last_fire_at = ? WHERE graph_id = ?
    AND fired_key IS ? AND last_fire_at IS ?`).run(next.key, next.at, graphId, prev.fired_key, prev.last_fire_at).changes === 1;
}

/**
 * Condition trigger step: evaluate the predicate; fire on a new key (edge + dedupe) outside the cooldown; on a positive
 * NO-GO card the owner once per key; when the fallback clock passes with the predicate false, fire once or card once.
 */
async function conditionStep(db: Database, row: TriggerRow, cond: ConditionDecl, deps: TriggerTickDeps, events: TickEvent[]): Promise<void> {
  const now = deps.now();
  const at = now.toISOString();
  db.query('INSERT OR IGNORE INTO graph_trigger_conditions (graph_id) VALUES (?)').run(row.graphId);
  const state = db.query('SELECT fired_key, last_fire_at, max_wait_done FROM graph_trigger_conditions WHERE graph_id = ?').get(row.graphId) as ConditionState;
  if (!deps.probes) throw new Error(`condition trigger ${row.graphId} needs condition probes`);
  let result;
  try {
    result = await evaluatePredicate(cond.predicate, deps.probes, { expand: s => expandTemplate(s, deps.vars, at, row.timeZone), sinceIso: state.last_fire_at ?? row.registeredAt });
  } catch (error) {
    // A probe that cannot measure is not «false»: record it loudly; the fallback clock still runs below.
    const why = error instanceof Error ? error.message : String(error);
    events.push({ graphId: row.graphId, event: 'condition-error', detail: why });
    debug.log('loops.trigger-registry', 'condition-error', { graphId: row.graphId, why });
    result = null;
  }
  if (result) db.query('UPDATE graph_trigger_conditions SET last_eval_at = ?, last_met = ?, last_evidence = ? WHERE graph_id = ?').run(at, result.met ? 1 : 0, result.evidence, row.graphId);
  const sinceFire = state.last_fire_at ? now.getTime() - Date.parse(state.last_fire_at) : Infinity;
  const fire = async (key: string, reason: string) => {
    const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    if (!claimConditionFire(db, row.graphId, state, { key, at })) { events.push({ graphId: row.graphId, window, event: 'deduped', detail: 'another tick claimed this edge' }); return; }
    const inserted = db.query(`INSERT OR IGNORE INTO graph_trigger_fires (graph_id, window, stage, status, attempt, updated_at, reason)
      VALUES (?, ?, ?, 'running', 1, ?, ?)`).run(row.graphId, window, row.stage, at, reason).changes === 1;
    if (inserted) { await dispatch(db, row, window, 1, deps, events); return; }
    // A second edge inside the same minute window (fire rows are per minute): un-claim so the next tick fires it —
    // otherwise the new key is consumed with no run (lost edge · found by the release-traffic test-universe run).
    db.query('UPDATE graph_trigger_conditions SET fired_key = ?, last_fire_at = ? WHERE graph_id = ? AND fired_key IS ?').run(state.fired_key, state.last_fire_at, row.graphId, key);
    events.push({ graphId: row.graphId, window, event: 'deduped', detail: `edge ${key} deferred to the next minute (window already fired)` });
  };
  if (result?.blocked) {
    const key = `blocked:${result.key}`;
    if (state.max_wait_done !== key) {
      db.query('UPDATE graph_trigger_conditions SET max_wait_done = ? WHERE graph_id = ?').run(key, row.graphId);
      const card = await safeCard(deps, row.owner, `[graph-trigger NO-GO] ${row.graphId}: ${result.blocked}. Not advancing. Evidence: ${result.evidence}`);
      events.push({ graphId: row.graphId, event: 'max-wait-card', detail: `NO-GO → card ${card}: ${result.blocked}` });
    }
    return;
  }
  if (result?.met && result.key !== state.fired_key) {
    if (sinceFire < cond.cooldownMin * 60_000) { events.push({ graphId: row.graphId, event: 'cooldown-held', detail: `${result.key} within ${cond.cooldownMin}m cooldown` }); return; }
    await fire(result.key, `condition: ${result.evidence}`);
    return;
  }
  // Fallback clock. An absolute phase clock (maxWaitAt) only matters until the phase has advanced once.
  if (cond.maxWaitAt && state.last_fire_at) return;
  const base = state.last_fire_at ?? row.registeredAt;
  const deadline = cond.maxWaitAt ?? (cond.maxWaitMin !== undefined ? new Date(Date.parse(base) + cond.maxWaitMin * 60_000).toISOString() : null);
  if (!deadline || now.getTime() < Date.parse(deadline)) return;
  const waitKey = `max-wait@${deadline}`;
  if (state.max_wait_done === waitKey) return;
  db.query('UPDATE graph_trigger_conditions SET max_wait_done = ? WHERE graph_id = ? AND max_wait_done IS ?').run(waitKey, row.graphId, state.max_wait_done);
  const evidence = result?.evidence ?? 'predicate could not be measured';
  if (cond.onMaxWait === 'fire') { await fire(waitKey, `max-wait: ${evidence}`); return; }
  const card = await safeCard(deps, row.owner, `[graph-trigger max-wait] ${row.graphId}: condition not met by ${deadline} — not running it. Evidence: ${evidence}`);
  events.push({ graphId: row.graphId, event: 'max-wait-card', detail: `card ${card}: ${evidence}` });
}

async function safeCard(deps: TriggerTickDeps, owner: string, body: string): Promise<string> {
  try { return await deps.postCard(owner, body); }
  catch (error) { return `card-post-failed: ${error instanceof Error ? error.message : String(error)}`; }
}

/** One tick over every registered trigger. Safe to run concurrently: every state change is a guarded update. */
export async function tickTriggers(db: Database, deps: TriggerTickDeps, options: { only?: string } = {}): Promise<TickEvent[]> {
  const events: TickEvent[] = [];
  for (const row of listTriggers(db)) {
    if (row.stage === 'retired' || (options.only && options.only !== row.graphId)) continue;
    const now = deps.now();
    const at = now.toISOString();
    // 0. threshold already met (e.g. global cutoverAfter 0): cut over before firing, so this window runs live.
    if (row.stage === 'shadow' && row.legacy && row.shadowSuccesses >= effectiveCutoverAfter(row, deps.cutoverAfterOverride)
      && await cutover(db, row, deps, events, `at threshold ${effectiveCutoverAfter(row, deps.cutoverAfterOverride)} (config)`)) row.stage = 'live';
    // 1. due window (cron) or predicate edge (condition)
    if (row.condition) await conditionStep(db, row, row.condition, deps, events);
    const window = row.cron ? previousLoopFire(row.cron, now, row.timeZone) : null;
    if (window) {
      const claimed = db.query(`INSERT OR IGNORE INTO graph_trigger_fires (graph_id, window, stage, status, attempt, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(row.graphId, window, row.stage,
          now.getTime() - Date.parse(window) > row.staleAfterMin * 60_000 ? 'stale-skipped' : 'running', 1, at).changes === 1;
      const fire = listFires(db, row.graphId, 1).find(f => f.window === window);
      if (claimed && fire?.status === 'stale-skipped') events.push({ graphId: row.graphId, window, event: 'stale-skipped', detail: `due ${window} older than ${row.staleAfterMin}m` });
      else if (claimed) await dispatch(db, row, window, 1, deps, events);
      else if (fire?.status === 'running' || fire?.status === 'dispatched' || fire?.status === 'done') events.push({ graphId: row.graphId, window, event: 'deduped', detail: `already ${fire.status}` });
    }
    // 2. goal checks and retries on open windows of this trigger
    const open = (db.query(`SELECT * FROM graph_trigger_fires WHERE graph_id = ? AND status IN ('running', 'dispatched', 'retry-wait')`).all(row.graphId) as Record<string, unknown>[]);
    for (const raw of open) {
      const w = String(raw.window); const attempt = Number(raw.attempt);
      const nowMs = deps.now().getTime();
      if (raw.status === 'running') {
        // Crash recovery: a run claimed by a tick that died never reports; past the goal deadline it counts as failed.
        const staleAt = Date.parse(String(raw.updated_at)) + (row.goalDeadlineMin + RUNNING_GRACE_MIN) * 60_000;
        if (nowMs < staleAt) continue;
        if (!setFire(db, row.graphId, w, { status: 'running' }, deps.now().toISOString(), { status: 'running', attempt })) continue;
        await fail(db, row, w, attempt, 'run claimed but never reported (tick died mid-run)', deps, events);
      } else if (raw.status === 'dispatched') {
        const goal = goalHolds(row, w, deps.vars);
        if (goal.ok) {
          if (!setFire(db, row.graphId, w, { status: 'done', error: null }, deps.now().toISOString(), { status: 'dispatched', attempt })) continue;
          events.push({ graphId: row.graphId, window: w, event: 'done', detail: goal.why });
          if (String(raw.stage) === 'shadow' && row.stage === 'shadow') {
            db.query('UPDATE graph_trigger_registry SET shadow_successes = shadow_successes + 1, updated_at = ? WHERE graph_id = ?').run(deps.now().toISOString(), row.graphId);
            const fresh = rowFrom(db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(row.graphId) as Record<string, unknown>, db);
            if (fresh.shadowSuccesses >= effectiveCutoverAfter(fresh, deps.cutoverAfterOverride) && fresh.legacy) await cutover(db, fresh, deps, events);
          }
        } else if (raw.check_at && nowMs >= Date.parse(String(raw.check_at))) {
          if (!setFire(db, row.graphId, w, { status: 'running' }, deps.now().toISOString(), { status: 'dispatched', attempt })) continue;
          await fail(db, row, w, attempt, `goal not met by deadline: ${goal.why}`, deps, events);
        } else events.push({ graphId: row.graphId, window: w, event: 'goal-pending', detail: goal.why });
      } else if (raw.next_retry_at && nowMs >= Date.parse(String(raw.next_retry_at))) {
        // Claim the retry with a guarded update so two concurrent ticks cannot both re-run it.
        if (!setFire(db, row.graphId, w, { status: 'running', attempt: attempt + 1 }, deps.now().toISOString(), { status: 'retry-wait', attempt })) continue;
        const current = rowFrom(db.query('SELECT * FROM graph_trigger_registry WHERE graph_id = ?').get(row.graphId) as Record<string, unknown>, db);
        await dispatch(db, { ...current, stage: String(raw.stage) as TriggerStage }, w, attempt + 1, deps, events);
      }
    }
  }
  debug.log('loops.trigger-registry', 'tick', { events: events.length, kinds: events.map(e => e.event) });
  return events;
}
