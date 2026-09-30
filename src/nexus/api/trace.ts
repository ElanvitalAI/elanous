import { getDefaultLogStore, resolveLogInstanceName, LogStore, type LogStoreRow, type LogQuery } from '../../mss/logging/log-store.js';
import { readLogInstances, type LogInstanceView } from '../../mss/logging/instance-registry.js';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prodInstanceRoot } from '../../instance/resolve.js';
import { debug, redactSecretText, redactSecrets } from '../../debug/log.js';
import { activeStoreNames, parseSinceParam, type LogFabricDeps, registeredLogStoreCount } from './log-fabric.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';
import { runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';

export type TraceLevel = 'L0' | 'L1' | 'L2' | 'L3';
export interface TraceEvent {
  id: string;
  ts: string;
  universe: string;
  machine?: string;
  runId?: string;
  parentRunId?: string;
  phase?: string;
  shard?: string;
  kind: string;
  what: string;
  why?: string;
  purpose?: string;
  target?: string;
  paths?: number | string[];
  refs: { pr?: string | number; commit?: string; logId: string; screen?: string; llmRequestId?: string };
}
export interface TraceNode {
  id: string;
  level: TraceLevel;
  label: string;
  count: number;
  universe?: string;
  runId?: string;
  phase?: string;
  kind?: string;
  firstTs?: string;
  lastTs?: string;
}
export interface TraceEdge { source: string; target: string; kind: string }
export interface TraceResult {
  nodes: TraceNode[];
  edges: TraceEdge[];
  events: TraceEvent[];
  facets: { universe: Record<string, number>; kind: Record<string, number>; phase: Record<string, number>; unmeasured: Record<string, number> };
  truncated: boolean;
}

const DECISIONS = new Set(['PLAN', 'ROUTE', 'VERIFY', 'HEAL', 'ESCALATE', 'SHIP']);
const TRACE_LIMIT = 1000;
const RUN_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_STORES = 20;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function dataFor(row: LogStoreRow): Record<string, unknown> {
  try { return object(row.data ? JSON.parse(row.data) : null); } catch { return {}; }
}
function count(map: Record<string, number>, key: string): void { map[key] = (map[key] ?? 0) + 1; }
function evidenceRef(universe: string, id: number): string {
  return `log:${encodeURIComponent(universe)}:${id}`;
}
function eventFor(row: LogStoreRow): TraceEvent {
  const data = dataFor(row);
  const refs = object(data.refs);
  const universe = row.instance || 'unmeasured';
  const machine = text(row.host_id) ?? text(data.hostId) ?? text(data.machine);
  const runId = text(data.runId) ?? text(data.run_id);
  const kind = text(data.kind) ?? (DECISIONS.has(row.event.toUpperCase()) ? row.event.toUpperCase()
    : row.category === 'harness.decision' && row.event === 'decision' ? 'unmeasured'
      : row.category.includes('review') ? 'review' : row.category.includes('gate') ? 'gate'
      : row.category.includes('merge') ? 'merge' : row.category.includes('llm') ? 'llm'
        : row.category.includes('signal') ? 'signal' : row.event);
  return {
    id: evidenceRef(universe, row.id), ts: row.ts, universe,
    ...(machine ? { machine } : {}),
    ...(runId ? { runId } : {}),
    ...(text(data.parentRunId) ? { parentRunId: text(data.parentRunId) } : {}),
    ...(text(data.phase) ? { phase: text(data.phase) } : {}),
    ...(text(data.shard) ? { shard: text(data.shard) } : {}),
    kind, what: text(data.what) ?? `${row.category}.${row.event}`,
    ...(text(data.why) ?? text(data.reason) ? { why: text(data.why) ?? text(data.reason) } : {}),
    ...(text(data.purpose) ? { purpose: text(data.purpose) } : {}),
    ...(text(data.target) ? { target: text(data.target) } : {}),
    ...(typeof data.paths === 'number' && Number.isFinite(data.paths) ? { paths: data.paths }
      : Array.isArray(data.paths) ? { paths: data.paths.filter((p): p is string => typeof p === 'string') } : {}),
    refs: {
      ...(typeof refs.pr === 'string' || typeof refs.pr === 'number' ? { pr: refs.pr } : {}),
      ...(text(refs.commit) ? { commit: text(refs.commit) } : {}),
      logId: evidenceRef(universe, row.id),
      ...(text(refs.screen) ? { screen: text(refs.screen) } : {}),
      ...(text(refs.llmRequestId) ? { llmRequestId: text(refs.llmRequestId) } : {}),
    },
  };
}

/** Side-effect-free projection of the already selected, bounded log rows. */
export function buildTrace(rows: readonly LogStoreRow[], level: TraceLevel = 'L1', truncated = false): TraceResult {
  const events = rows.map(eventFor);
  const facets: TraceResult['facets'] = { universe: {}, kind: {}, phase: {}, unmeasured: {} };
  const nodes = new Map<string, TraceNode>();
  const edges = new Map<string, TraceEdge>();
  const add = (id: string, nodeLevel: TraceLevel, label: string, extras: Partial<TraceNode> = {}): void => {
    const existing = nodes.get(id);
    if (existing) existing.count += 1;
    else nodes.set(id, { id, level: nodeLevel, label, count: 1, ...extras });
  };
  const link = (source: string, target: string, kind: string): void => {
    if (source !== target) edges.set(`${source}\0${target}\0${kind}`, { source, target, kind });
  };
  for (const event of events) {
    count(facets.universe, event.universe);
    count(facets.kind, event.kind);
    if (event.kind === 'unmeasured') count(facets.unmeasured, 'kind');
    if (event.phase) count(facets.phase, event.phase);
    if (!event.why) count(facets.unmeasured, 'why');
    if (event.universe === 'unmeasured') count(facets.unmeasured, 'universe');
    if (!event.runId) count(facets.unmeasured, 'runId');
    if (!event.phase) count(facets.unmeasured, 'phase');
    if (!event.machine) count(facets.unmeasured, 'machine');
    if (!event.shard) count(facets.unmeasured, 'shard');
    const universeId = `universe:${event.universe}`;
    add(universeId, 'L0', event.universe, { universe: event.universe });
    if (level === 'L0' && event.machine) {
      const machineId = `machine:${event.universe}:${event.machine}`;
      add(machineId, 'L0', event.machine, { universe: event.universe });
      link(universeId, machineId, 'hosts');
    }
    if (level === 'L0' || !event.runId) continue;
    const runId = `run:${event.universe}:${event.runId}`;
    add(runId, 'L1', event.runId, { universe: event.universe, runId: event.runId });
    link(universeId, runId, 'contains');
    if (event.parentRunId && event.parentRunId !== event.runId) {
      const parentId = `run:${event.universe}:${event.parentRunId}`;
      if (!nodes.has(parentId)) nodes.set(parentId, { id: parentId, level: 'L1', label: event.parentRunId, count: 0, universe: event.universe, runId: event.parentRunId });
      link(parentId, runId, 'parent');
    }
    if (level === 'L1') continue;
    const phaseId = `phase:${event.universe}:${event.runId}:${event.phase ?? 'unmeasured'}`;
    add(phaseId, 'L2', event.phase ?? 'unmeasured', { universe: event.universe, runId: event.runId, phase: event.phase });
    link(runId, phaseId, 'phase');
    let parentId = phaseId;
    if (event.shard) {
      const shardId = `shard:${event.universe}:${event.runId}:${event.phase ?? 'unmeasured'}:${event.shard}`;
      add(shardId, 'L2', event.shard, { universe: event.universe, runId: event.runId, phase: event.phase });
      link(phaseId, shardId, 'shard');
      parentId = shardId;
    }
    if (level === 'L2') continue;
    add(event.id, 'L3', event.what, { universe: event.universe, runId: event.runId, phase: event.phase, kind: event.kind });
    link(parentId, event.id, 'decision');
  }
  if (level === 'L3') {
    const previous = new Map<string, string>();
    for (const event of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id))) {
      if (!event.runId) continue;
      const key = `${event.universe}\0${event.runId}`;
      const before = previous.get(key);
      if (before) link(before, event.id, 'next');
      previous.set(key, event.id);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], events, facets, truncated };
}

export function buildRunTrace(
  runs: Array<{ universe: string; runId: string; parentRunId: string | null; firstTs: string; lastTs: string; rows: number }>,
  level: 'L0' | 'L1',
): TraceResult {
  const nodes = new Map<string, TraceNode>();
  const edges = new Map<string, TraceEdge>();
  const facets: TraceResult['facets'] = { universe: {}, kind: {}, phase: {}, unmeasured: {} };
  for (const run of runs) {
    count(facets.universe, run.universe);
    const universeId = `universe:${run.universe}`;
    const universeNode = nodes.get(universeId);
    if (universeNode) universeNode.count++;
    else nodes.set(universeId, { id: universeId, level: 'L0', label: run.universe, count: 1, universe: run.universe });
    if (level === 'L0') continue;
    const id = `run:${run.universe}:${run.runId}`;
    nodes.set(id, { id, level: 'L1', label: run.runId, count: run.rows,
      universe: run.universe, runId: run.runId, firstTs: run.firstTs, lastTs: run.lastTs });
    edges.set(`${universeId}\0${id}\0contains`, { source: universeId, target: id, kind: 'contains' });
  }
  if (level === 'L1') for (const run of runs) {
    if (!run.parentRunId || run.parentRunId === run.runId) continue;
    const parentId = `run:${run.universe}:${run.parentRunId}`;
    const id = `run:${run.universe}:${run.runId}`;
    if (!nodes.has(parentId)) nodes.set(parentId, { id: parentId, level: 'L1', label: run.parentRunId,
      count: 0, universe: run.universe, runId: run.parentRunId });
    edges.set(`${parentId}\0${id}\0parent`, { source: parentId, target: id, kind: 'parent' });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], events: [], facets, truncated: false };
}

export interface TraceDeps extends LogFabricDeps {
  queryLog?: (details: { stores: string[]; level: TraceLevel; count: number; truncated: boolean; mode: 'rows' | 'runs'; runs: number }) => void;
  ledgerStat?: (path: string) => void;
}
function storeNames(url: URL, deps: TraceDeps): string[] {
  const names = [...new Set(url.searchParams.getAll('store').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))];
  if (names.includes('@active')) {
    let active: string[];
    try { active = activeStoreNames(deps); }
    catch { active = [resolveLogInstanceName()]; }
    return [...new Set([...active, ...names.filter((n) => n !== '@active')])];
  }
  return names.length ? names : [url.searchParams.get('universe') || resolveLogInstanceName()];
}
const registeredStoreCount = (deps: TraceDeps): number | null => registeredLogStoreCount(deps);
function selectedStores(names: string[], deps: TraceDeps): { name: string; store: LogStore | null; remote: boolean; error?: string }[] {
  const selfName = resolveLogInstanceName();
  const self = names.includes(selfName) ? (deps.store ?? getDefaultLogStore)() : null;
  const views = names.some((name) => name !== selfName) ? (deps.instances ?? readLogInstances)() : [];
  return names.map((name) => {
    if (name === selfName) return { name, store: self, remote: false };
    let view: LogInstanceView | undefined = views.find((v) => v.name === name) ?? views.find((v) => v.name === `test:${name}`);
    if (!view && name === 'prod') {
      const root = (deps.prodStateRoot ?? prodInstanceRoot)();
      const dbPath = join(root, 'logs', 'logs.db');
      view = { name, dbPath, dbExists: existsSync(dbPath), stateDir: root, configDir: root,
        pid: 0, startedAt: '', alive: false, liveness: 'dead', stateDirCount: 1, ambiguous: false, kind: 'prod' };
    }
    if (!view) return { name, store: null, remote: false, error: `unknown instance '${name}'` };
    if (!view.dbExists) return { name, store: null, remote: false, error: `instance '${name}' has no log store yet` };
    try {
      const store = (deps.openRemoteStore ?? ((v: LogInstanceView) => LogStore.openReadOnly(v.dbPath)))(view);
      return { name, store, remote: !!store, ...(!store ? { error: `instance '${name}' store open failed` } : {}) };
    } catch { return { name, store: null, remote: false, error: `instance '${name}' store open failed` }; }
  });
}
function closeStores(stores: ReturnType<typeof selectedStores>, deps: TraceDeps): void {
  for (const entry of stores) if (entry.remote && entry.store) {
    try { (deps.closeRemoteStore ?? ((store) => store.close()))(entry.store); } catch { /* response is complete */ }
  }
}
function readTime(raw: string | null): number | undefined | null {
  return raw === null ? undefined : parseSinceParam(raw);
}
function options(url: URL): { level: TraceLevel; limit: number; from?: number; to?: number; error?: string } {
  const rawLevel = url.searchParams.get('level') ?? 'L1';
  if (!['L0', 'L1', 'L2', 'L3'].includes(rawLevel)) return { level: 'L1', limit: DEFAULT_LIMIT, error: 'invalid level' };
  const level = rawLevel as TraceLevel;
  // L2 is one run's lens: without a runId it would silently mix every run in the window.
  if (level === 'L2' && !url.searchParams.get('runId')) return { level, limit: DEFAULT_LIMIT, error: 'L2 needs runId' };
  const rawLimit = url.searchParams.get('limit');
  const n = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(n) || n < 1) return { level, limit: DEFAULT_LIMIT, error: 'invalid limit' };
  const from = readTime(url.searchParams.get('from'));
  const to = readTime(url.searchParams.get('to'));
  if (from === null || to === null || (from !== undefined && to !== undefined && from > to)) return { level, limit: n, error: 'invalid time range' };
  return { level, limit: Math.min(n, TRACE_LIMIT), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}
function matches(row: LogStoreRow, url: URL): boolean {
  const data = dataFor(row);
  const runId = url.searchParams.get('runId');
  const universe = url.searchParams.get('universe');
  const kind = url.searchParams.get('kind');
  const q = url.searchParams.get('q')?.toLowerCase();
  if (runId && data.runId !== runId && data.run_id !== runId) return false;
  if (universe && row.instance !== universe) return false;
  if (kind && eventFor(row).kind !== kind) return false;
  if (q && !`${row.category} ${row.event} ${row.data ?? ''}`.toLowerCase().includes(q)) return false;
  return true;
}
function sortRows(a: LogStoreRow, b: LogStoreRow): number {
  return b.ts_ms - a.ts_ms || b.id - a.id || a.instance.localeCompare(b.instance);
}

function findRunUniverse(runId: string, selected: readonly string[], deps: TraceDeps): { universe?: string; checked: number } {
  let checked = 0;
  const views = (deps.instances ?? readLogInstances)();
  for (const view of [...views.filter((v) => selected.includes(v.name)), ...views.filter((v) => !selected.includes(v.name))]) {
    checked++;
    try {
      (deps.ledgerStat ?? statSync)(runLedgerPath(runId, runLedgerDir(view.stateDir)));
      return { universe: view.name, checked };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`unable to check run ledger for '${view.name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { checked };
}

/** Read-only bounded log-fabric fan-in, authenticated before any store access. */
export function handleTrace(req: Request, opts: MetaApiOpts, deps: TraceDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const parsed = options(url);
  if (parsed.error) return jsonResponse({ ok: false, error: 'bad_request', reason: parsed.error }, 400);
  const names = storeNames(url, deps);
  if (names.length > MAX_STORES) return jsonResponse({ ok: false, error: 'too_many_stores' }, 400);
  const requestedUniverse = url.searchParams.get('universe');
  if (requestedUniverse && !names.includes(requestedUniverse)) return jsonResponse({ ok: false, error: 'unknown_store', reason: `universe '${requestedUniverse}' not selected` }, 404);
  const stores = selectedStores(names, deps);
  try {
    const unknown = stores.length === 1 ? stores.find((entry) => entry.error?.startsWith('unknown instance') || entry.error?.includes('has no log store')) : undefined;
    if (unknown) return jsonResponse({ ok: false, error: 'unknown_store', reason: unknown.error }, 404);
    const runMode = (parsed.level === 'L0' || parsed.level === 'L1')
      && !url.searchParams.get('runId') && !url.searchParams.get('q') && !url.searchParams.get('kind');
    if (runMode) {
      const failures: Array<{ name: string; reason: string }> = [];
      const runs: Array<{ universe: string; runId: string; parentRunId: string | null; firstTs: string; lastTs: string; rows: number }> = [];
      let opened = 0;
      let runLimitReached = false;
      for (const entry of stores) {
        if (!entry.store) { failures.push({ name: entry.name, reason: entry.error ?? 'log-store-unavailable' }); continue; }
        try {
          const page = entry.store.aggregateRuns({ sinceMs: parsed.from, untilMs: parsed.to }, RUN_LIMIT);
          if (page.length >= RUN_LIMIT) runLimitReached = true;
          runs.push(...page.map((run) => ({ ...run, universe: entry.name })));
          opened++;
        } catch (e) { failures.push({ name: entry.name, reason: e instanceof Error ? e.message : String(e) }); }
      }
      if (!opened) return jsonResponse({ ok: false, error: 'log-store-unavailable', failedStores: failures }, 503);
      const trace = buildRunTrace(runs, parsed.level as 'L0' | 'L1');
      trace.truncated = runLimitReached || failures.length > 0;
      try { (deps.queryLog ?? ((details) => debug.log('logs.trace', 'query', details)))({ stores: names, level: parsed.level, count: trace.events.length, truncated: trace.truncated, mode: 'runs', runs: runs.length }); } catch { /* query logging must not block reads */ }
      return jsonResponse({ ok: true, ...trace, stores: names, registeredStores: registeredStoreCount(deps), ...(failures.length ? { failedStores: failures } : {}) }, 200);
    }
    const failures: Array<{ name: string; reason: string }> = [];
    const rows: LogStoreRow[] = [];
    let opened = 0;
    let candidateLimitReached = false;
    for (const entry of stores) {
      if (!entry.store) { failures.push({ name: entry.name, reason: entry.error ?? 'log-store-unavailable' }); continue; }
      try {
        const query: LogQuery = { sinceMs: parsed.from, untilMs: parsed.to, limit: TRACE_LIMIT + 1 };
        const search = url.searchParams.get('q');
        if (search) query.grep = search;
        // Restrict a run before paging; other JSON-only filters still apply to the bounded window.
        const runId = url.searchParams.get('runId');
        const page = runId ? entry.store.queryTraceRun(runId, query) : entry.store.query(query);
        if (page.length > TRACE_LIMIT) candidateLimitReached = true;
        rows.push(...page.map((row) => ({ ...row, instance: row.instance || entry.name })));
        opened++;
      } catch (e) { failures.push({ name: entry.name, reason: e instanceof Error ? e.message : String(e) }); }
    }
    if (!opened) return jsonResponse({ ok: false, error: 'log-store-unavailable', failedStores: failures }, 503);
    const runId = url.searchParams.get('runId');
    let resolution: { universe?: string; checked: number } | undefined;
    if ((parsed.level === 'L2' || parsed.level === 'L3') && runId && !rows.some((row) => matches(row, url)) && !requestedUniverse) {
      // A store with no log db at all («has no log store yet» — e.g. the daemon's own tree-derived universe) cannot
      // hold the run, so it must not block the ledger lookup. A store that exists but failed to open/read still does:
      // «could not read» is never answered as «not there». The reply keeps `failedStores` either way.
      const blocking = failures.filter((failure) => !/has no log store yet/.test(failure.reason));
      if (blocking.length) return jsonResponse({ ok: false, error: 'log-store-unavailable', failedStores: failures }, 503);
      try { resolution = findRunUniverse(runId, names, deps); }
      catch (error) { return jsonResponse({ ok: false, error: 'run-universe-unavailable', reason: error instanceof Error ? error.message : String(error) }, 503); }
      try { debug.log('nexus.trace', 'run-universe-resolved', { runId, universe: resolution.universe ?? 'not-found', checked: resolution.checked }); } catch { /* observation must not block reads */ }
      if (resolution.universe && !names.includes(resolution.universe)) {
        const name = resolution.universe;
        names.push(name);
        const [entry] = selectedStores([name], deps);
        if (!entry?.store) return jsonResponse({ ok: false, error: 'log-store-unavailable', failedStores: [{ name, reason: entry?.error ?? 'log-store-unavailable' }] }, 503);
        stores.push(entry);
        try {
          const query: LogQuery = { sinceMs: parsed.from, untilMs: parsed.to, limit: TRACE_LIMIT + 1 };
          const search = url.searchParams.get('q');
          if (search) query.grep = search;
          const page = entry.store.queryTraceRun(runId, query);
          if (page.length > TRACE_LIMIT) candidateLimitReached = true;
          rows.push(...page.map((row) => ({ ...row, instance: row.instance || name })));
        } catch (e) { return jsonResponse({ ok: false, error: 'log-store-unavailable', failedStores: [{ name, reason: e instanceof Error ? e.message : String(e) }] }, 503); }
      }
    }
    const filtered = rows.filter((row) => matches(row, url)).sort(sortRows);
    const trace = buildTrace(filtered.slice(0, parsed.limit), parsed.level, filtered.length > parsed.limit || candidateLimitReached || failures.length > 0);
    try { (deps.queryLog ?? ((details) => debug.log('logs.trace', 'query', details)))({ stores: names, level: parsed.level, count: trace.events.length, truncated: trace.truncated, mode: 'rows', runs: trace.nodes.filter((node) => node.level === 'L1' && node.count > 0).length }); } catch { /* query logging must not block reads */ }
    return jsonResponse({ ok: true, ...trace, stores: names, registeredStores: registeredStoreCount(deps), ...(resolution ? resolution.universe ? { resolvedFrom: 'ledger' as const, runUniverse: resolution.universe } : { runUniverse: 'not-found' as const, checked: resolution.checked } : {}), ...(failures.length ? { failedStores: failures } : {}) }, 200);
  } finally { closeStores(stores, deps); }
}

/** Evidence refs only resolve log rows in an authorized, selected store; no filesystem paths or raw URLs. */
export function handleTraceEvidence(req: Request, opts: MetaApiOpts, ref: string, deps: TraceDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const decoded = /^log:([^/]+):([1-9]\d*)$/.exec(ref);
  if (!decoded) return jsonResponse({ ok: false, error: 'bad_ref' }, 400);
  let name: string;
  try { name = decodeURIComponent(decoded[1]!); } catch { return jsonResponse({ ok: false, error: 'bad_ref' }, 400); }
  const id = Number(decoded[2]);
  if (!name || name.includes('/') || name.includes('..') || !Number.isSafeInteger(id)) return jsonResponse({ ok: false, error: 'bad_ref' }, 400);
  const stores = selectedStores([name], deps);
  try {
    const entry = stores[0]!;
    if (entry.error?.startsWith('unknown instance') || entry.error?.includes('has no log store')) return jsonResponse({ ok: false, error: 'unknown_store', reason: entry.error }, 404);
    if (!entry.store) return jsonResponse({ ok: false, error: 'log-store-unavailable' }, 503);
    // A row ID belongs only to this database. Never fall back to a different universe.
    let row: LogStoreRow | null;
    try { row = entry.store.getById(id); }
    catch { return jsonResponse({ ok: false, error: 'evidence_unavailable' }, 503); }
    if (!row) return jsonResponse({ ok: false, error: 'evidence_not_found' }, 404);
    // Evidence is a raw log line: redact before it leaves the daemon — key axis ⊕ text axis for JSON, text axis otherwise.
    const data = (() => { if (!row.data) return null; try { return redactSecrets(JSON.parse(row.data)); } catch { return redactSecretText(row.data); } })();
    return jsonResponse({ ok: true, ref, evidence: { ...row, instance: row.instance || name, data } }, 200);
  } finally { closeStores(stores, deps); }
}
