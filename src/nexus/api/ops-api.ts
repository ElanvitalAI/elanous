import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { debug, redactSecretText } from '../../debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { gateShardsPath, readGateShards, summarizeShards, type GateShardsFile, type GateShardsSummary } from '../../release-loop/gate-shards.js';
import { listChecklist } from '../../release-loop/checklist.js';
import { getSchedule } from '../../release-loop/release-schedule.js';
import { jsonResponse } from './json-response.js';
import { subscribeInsideEvent } from './inside-events.js';
import { operatorSignal } from './operator.js';
import { createSeatsCache, todayKst } from './ops-seats.js';
import { liveSeatsSources } from './ops-seats-sources.js';
import { createOverviewCache } from '../../ops/overview-cache.js';
import { resourcesFromOverview } from '../../ops/resources.js';
import { loopsMapFromCache } from '../../ops/loops-map.js';
import { parseSince } from '../../ops/overview-collect.js';
import { handleResourceLedgerApi } from './resource-ledger.js';
import { handleResourceGuardianApi } from './resource-guardian.js';
import { buildTrainThroughput, collectTrainSummaryEvents, isValidTrainDate, parseTrainThroughputLogs, trainIdentityFromBatchDirectory, trainKeysFromManifest, trainRejectionsFromSummary } from './train-throughput.js';
import type { MetaApiOpts } from './meta-api.js';

const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const IDENTIFIER = /^[A-Za-z0-9-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function defaultTrainArtifactDirectory(home = process.env.HOME || homedir()): string {
  return join(home, 'elanous-hq', 'seat-state', 'OP', 'train-artifacts');
}

export function resolveTrainArtifactDirectory(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME || homedir()): string {
  return env.ELANOUS_TRAIN_ARTIFACT_DIR?.trim() || defaultTrainArtifactDirectory(home);
}

let seatsCache: ReturnType<typeof createSeatsCache> | null = null;
/** Tests swap the sources; production builds them lazily on first use. */
export function setSeatsCacheForTest(cache: ReturnType<typeof createSeatsCache> | null): void { seatsCache = cache; }
let overviewCache: ReturnType<typeof createOverviewCache> | null = null;
export function setOverviewCacheForTest(cache: ReturnType<typeof createOverviewCache> | null): void {
  overviewCache?.stop();
  overviewCache = cache;
}
const LOG_PATH = /^\/v1\/ops\/release\/runs\/([^/]+)\/nodes\/([^/]+)\/log$/;
const RELEASE_EVENTS_PATH = /^\/v1\/ops\/release\/runs\/([A-Za-z0-9-]+)\/events$/;

interface RunNode { nodeId: string; ok?: unknown; output?: unknown; startedAt?: unknown; endedAt?: unknown }
interface RunRecord {
  status: string;
  path: string[];
  startedAt: string;
  input?: unknown;
  nodes: RunNode[];
  currentNode?: { nodeId?: unknown; startedAt?: unknown };
}

/** Node times come only from the ledger (GRAPH-NODE-TIMES); older ledgers have none and the screen says so. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function nodeTimes(node: RunNode): { startedAt?: string; endedAt?: string } {
  const startedAt = isoTime(node.startedAt);
  const endedAt = isoTime(node.endedAt);
  return { ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}) };
}

/** The running node has no record yet — show it with its start time when the ledger names it as the path tail. */
function runningNode(run: RunRecord, recorded: number): Array<{ nodeId: string; ok: null; summary: string; startedAt: string }> {
  const current = run.currentNode;
  const startedAt = isoTime(current?.startedAt);
  if (run.status !== 'running' || !startedAt || typeof current?.nodeId !== 'string' ||
      run.path.length !== recorded + 1 || run.path.at(-1) !== current.nodeId) return [];
  return [{ nodeId: redactSecretText(current.nodeId), ok: null, summary: '', startedAt }];
}

function recordAt(path: string): RunRecord | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const run = value as Partial<RunRecord>;
    if (typeof run.status !== 'string' || !Array.isArray(run.path)
      || typeof run.startedAt !== 'string' || !Array.isArray(run.nodes)) return null;
    return run as RunRecord;
  } catch { return null; }
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  return JSON.stringify(output) ?? '';
}

function nodeSummary(output: unknown): string {
  let value = output;
  if (typeof value === 'string') {
    const text = value;
    try { value = JSON.parse(text) as unknown; }
    catch {
      const last = text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
      try { value = JSON.parse(last ?? '') as unknown; } catch { return ''; }
    }
  }
  if (!value || typeof value !== 'object') return '';
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === 'string' ? redactSecretText(summary).slice(0, 300) : '';
}

function runVersion(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const version = (input as { version?: unknown }).version;
  return typeof version === 'string' && VERSION.test(version) ? version : null;
}

/** Facts away mode prints for a node — only built when asked, so the HTTP shape stays as it was. */
export interface ReleaseNodeFacts { verdict?: string; introduced?: number; preexisting?: number; waiver?: string }
export interface ReleaseRunNodeView {
  nodeId: string; ok: boolean | null; summary: string; startedAt?: string; endedAt?: string; facts?: ReleaseNodeFacts;
}

function parsedOutput(output: unknown): Record<string, unknown> | null {
  let value = output;
  if (typeof value === 'string') {
    const text = value;
    try { value = JSON.parse(text) as unknown; }
    catch {
      const last = text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
      try { value = JSON.parse(last ?? '') as unknown; } catch { return null; }
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function releaseNodeFacts(output: unknown): ReleaseNodeFacts {
  const value = parsedOutput(output);
  if (!value) return {};
  const verdict = typeof value.verdict === 'string' ? value.verdict : typeof value.outcome === 'string' ? value.outcome : undefined;
  const introduced = Array.isArray(value.introduced) ? value.introduced.length : typeof value.introduced === 'number' ? value.introduced : undefined;
  const preexisting = typeof value.preexisting === 'number' ? value.preexisting : undefined;
  const waiver = typeof value.waiver === 'string' && value.waiver.trim() ? redactSecretText(value.waiver).slice(0, 200) : undefined;
  return {
    ...(verdict ? { verdict: redactSecretText(verdict).slice(0, 40) } : {}),
    ...(introduced !== undefined ? { introduced } : {}),
    ...(preexisting !== undefined ? { preexisting } : {}),
    ...(waiver ? { waiver } : {}),
  };
}
export interface ReleaseRunView {
  runId: string; status: string; startedAt: string; version: string | null; path: string[]; nodes: ReleaseRunNodeView[];
  graph?: ReleaseRunGraph;
  gateProgress?: Array<{ kind: 'release.gate.progress'; graphId: 'release-loop'; runId: string; at?: string;
    data: Record<string, unknown> }>;
  /** Explicit project ownership. The release ledger does not currently populate this field. */
  projectId?: string;
  /** GATE-LIVE-OBS — 해당 런의 시간대에 기록된 발행 원장 shard board. 파일이 없거나 다른 런이면 생략. */
  gateShards?: GateShardsFile & { summary: GateShardsSummary };
}

export interface ReleaseRunGraph {
  nodes: Array<{ nodeId: string; kind: string; needs: string[] }>;
}

let cachedReleaseRunGraph: ReleaseRunGraph | null | undefined;
function releaseRunGraph(): ReleaseRunGraph | undefined {
  if (cachedReleaseRunGraph !== undefined) return cachedReleaseRunGraph ?? undefined;
  try {
    const raw = parseYaml(readFileSync(join(import.meta.dir, '../../../graphs/release/release-loop.yaml'), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { cachedReleaseRunGraph = null; return undefined; }
    const nodes = (raw as Record<string, unknown>).nodes;
    if (!Array.isArray(nodes)) { cachedReleaseRunGraph = null; return undefined; }
    const viewNodes = nodes.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const node = entry as Record<string, unknown>;
      if (typeof node.node_id !== 'string' || typeof node.kind !== 'string') return [];
      const needs = Array.isArray(node.needs) ? node.needs.filter((value): value is string => typeof value === 'string') : [];
      return [{ nodeId: redactSecretText(node.node_id), kind: redactSecretText(node.kind), needs }];
    });
    cachedReleaseRunGraph = viewNodes.length ? { nodes: viewNodes } : null;
    return cachedReleaseRunGraph ?? undefined;
  } catch {
    cachedReleaseRunGraph = null;
    return undefined;
  }
}

function releaseRunEvents(req: Request, runId: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    req.signal.removeEventListener('abort', close);
  };
  const close = () => {
    cleanup();
    try { controllerRef?.close(); } catch { /* already cancelled */ }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (req.signal.aborted) { close(); return; }
      unsubscribe = subscribeInsideEvent((event) => {
        if (event.kind !== 'release.gate.progress' || event.graphId !== 'release-loop' || event.runId !== runId) return;
        const frame = `event: release.gate.progress\ndata: ${JSON.stringify(event)}\n\n`;
        const bytes = encoder.encode(frame);
        if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
        try { controller.enqueue(bytes); } catch { close(); }
      });
      heartbeat = setInterval(() => {
        if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { close(); }
      }, 15_000);
      req.signal.addEventListener('abort', close, { once: true });
      if (!closed) controller.enqueue(encoder.encode(': connected\n\n'));
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 8, size: () => 1 });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' } });
}

/** 도는 gate 노드의 조각 표 — 다른 판의 파일을 붙이지 않게 version 이 같을 때만. */
function gateShardsFor(version: string | null, runId: string, status: string, nodes: ReleaseRunNodeView[], ledgerRoot: string, now: number):
  ReleaseRunView['gateShards'] | undefined {
  if (!version) return undefined;
  const gateNode = nodes.find((node) => node.nodeId === 'gate');
  if (!gateNode) return undefined;
  const gateStartedAt = Date.parse(gateNode.startedAt ?? '');
  const gateEndedAt = Date.parse(gateNode.endedAt ?? '');
  const activeGate = status === 'running' && gateNode.ok === null;
  // A completed gate may still be shown only when its own time window is recorded. Without an
  // end time, a later run's shard board could be attached to a run that has already moved on.
  const completedGate = gateNode.ok !== null && Number.isFinite(gateEndedAt);
  if (!activeGate && !completedGate) return undefined;
  const file = readGateShards(gateShardsPath(version, ledgerRoot));
  if (!file || file.version !== version || file.runId !== runId) return undefined;
  const updatedAt = Date.parse(file.updatedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(gateStartedAt) || updatedAt < gateStartedAt) return undefined;
  if (Number.isFinite(gateEndedAt) && updatedAt > gateEndedAt) return undefined;
  const shards = file.shards.map((shard) => Object.fromEntries(Object.entries(shard).map(([key, value]) =>
    [key, typeof value === 'string' ? redactSecretText(value).slice(0, 240) : value])) as typeof shard);
  const safeFile = { ...file, runId: redactSecretText(file.runId), shards };
  return { ...safeFile, summary: summarizeShards(safeFile, now) };
}

/** Persisted gate phase events live beside the run context. Keep only the operator graph contract. */
function gateProgressFor(runId: string, runDirectory: string): ReleaseRunView['gateProgress'] {
  const contexts = join(runDirectory, `${runId}.json.contexts`);
  let names: string[];
  try {
    names = readdirSync(contexts).filter((name) => /^\d+\.json\.gate-progress\.jsonl$/.test(name))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)).slice(-32);
  }
  catch { return undefined; }
  const events: NonNullable<ReleaseRunView['gateProgress']> = [];
  let bytesRead = 0;
  const maxBytes = 1_048_576;
  const maxFileBytes = 262_144;
  for (const name of names) {
    if (events.length >= 512) break;
    const path = join(contexts, name);
    try {
      const size = statSync(path).size;
      if (size > maxFileBytes || bytesRead + size > maxBytes) break;
      bytesRead += size;
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (events.length >= 512) break;
        if (!line.trim()) continue;
        let raw: unknown;
        try { raw = JSON.parse(line) as unknown; } catch { continue; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const row = raw as Record<string, unknown>;
        if (row.phase !== 'shard-plan' && row.phase !== 'shard-decision') continue;
        const data: Record<string, unknown> = { phase: row.phase };
        for (const key of ['shard', 'decision', 'reason'] as const) {
          const value = row[key];
          if (typeof value === 'string' && value.length <= 240) data[key] = redactSecretText(value);
        }
        for (const key of ['shardIndex', 'shardTotal', 'reuseCount', 'rerunCount', 'radiusInvalidatedCount'] as const) {
          const value = row[key];
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) data[key] = value;
        }
        if (row.rerunReasons && typeof row.rerunReasons === 'object' && !Array.isArray(row.rerunReasons)) {
          const reasons = Object.fromEntries(Object.entries(row.rerunReasons as Record<string, unknown>)
            .filter(([reason, count]) => reason.length <= 160 && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
            .map(([reason, count]) => [redactSecretText(reason), count]));
          if (Object.keys(reasons).length) data.rerunReasons = reasons;
        }
        events.push({ kind: 'release.gate.progress', graphId: 'release-loop', runId: redactSecretText(runId),
          ...(typeof row.eventId === 'string' ? { eventId: row.eventId } : {}),
          ...(typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? { at: row.at } : {}), data });
      }
    } catch { /* partial or retired context files do not erase the run or its other events */ }
  }
  return events.length ? events : undefined;
}

/** The release run ledger as `/v1/ops/release/runs` serves it (newest 20) — shared with Telegram /release and away mode
 *  so every surface reads the same verdicts. `'unavailable'` = the directory exists but cannot be read. */
export function readReleaseRuns(version: string | null = null,
  dir: string = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop'),
  opts: { facts?: boolean; ledgerRoot?: string; now?: number } = {}): ReleaseRunView[] | 'unavailable' {
  let filenames: string[];
  const graph = releaseRunGraph();
  try {
    filenames = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json')
        && IDENTIFIER.test(entry.name.slice(0, -5)))
      .map((entry) => entry.name);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return 'unavailable';
  }
  return filenames.flatMap((filename) => {
    const run = recordAt(join(dir, filename));
    if (!run) return [];
    const v = runVersion(run.input);
    if (version !== null && v !== version) return [];
    const nodes: ReleaseRunNodeView[] = [...run.nodes.filter((node) => node && typeof node.nodeId === 'string').map((node) => ({
      nodeId: redactSecretText(node.nodeId), ok: typeof node.ok === 'boolean' ? node.ok : null,
      summary: nodeSummary(node.output), ...nodeTimes(node),
      ...(opts.facts ? { facts: releaseNodeFacts(node.output) } : {}),
    })), ...runningNode(run, run.nodes.length)];
    const runId = filename.slice(0, -5);
    const gateShards = gateShardsFor(v, runId, run.status, nodes, opts.ledgerRoot ?? releaseLedgerRoot(), opts.now ?? Date.now());
    const gateProgress = gateProgressFor(runId, dir);
    return [{
      runId: redactSecretText(runId), status: redactSecretText(run.status),
      startedAt: redactSecretText(run.startedAt), version: v,
      path: run.path.filter((step): step is string => typeof step === 'string').map(redactSecretText),
      nodes, ...(graph ? { graph } : {}), ...(gateShards ? { gateShards } : {}), ...(gateProgress ? { gateProgress } : {}),
    }];
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
}

/**
 * 요청이 «자격을 하나라도 실어 왔는가» — operatorSignal 이 판정에 쓰는 축(베어러·프록시 헤더·쿠키)만 본다.
 * 아무것도 없으면 401(인증 없음), 있는데 운영자가 아니면 403(권한 없음)으로 가른다.
 */
function offeredCredential(req: Request): boolean {
  return Boolean(req.headers.get('authorization') || req.headers.get('x-elanous-operator') || req.headers.get('cookie'));
}

/** The sole data gate for every read-only /v1/ops endpoint. */
export function handleOpsApi(req: Request, metaApi: MetaApiOpts | undefined): Response | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);

  const signal = metaApi ? operatorSignal(req, metaApi) : { operator: false, operatorSource: null };
  if (!signal.operator) {
    debug.log('ops.api', 'refused', { path: pathname, source: signal.operatorSource });
    // RES-FLOOR-API: no credential was offered at all — this endpoint names it 401; every other path keeps 403.
    if (pathname === '/v1/ops/resources') return jsonResponse({ error: 'unauthorized' }, 401);
    if (pathname === '/v1/ops/resources/ledger' && !offeredCredential(req)) return jsonResponse({ error: 'unauthorized' }, 401);
    if (pathname === '/v1/ops/resources/guardian' && !offeredCredential(req)) return jsonResponse({ error: 'unauthorized' }, 401);
    // LOOP-MAP-API: a request that offers no credential at all is 401 in the same body shape;
    // a credential that is not an operator stays 403, exactly like the neighbouring ops paths.
    if (pathname === '/v1/ops/loops-map' && !offeredCredential(req)) return jsonResponse({ error: 'unauthorized' }, 401);
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  const served = (response: Response): Response => {
    debug.log('ops.api', 'served', { path: pathname, source: signal.operatorSource });
    response.headers.set('cache-control', 'no-store');
    return response;
  };
  if (pathname === '/v1/ops/overview') {
    let since: ReturnType<typeof parseSince>;
    try { since = parseSince(url.searchParams.get('since') ?? undefined); }
    catch { return jsonResponse({ error: 'invalid-since' }, 400); }
    const version = url.searchParams.get('version');
    if (version !== null && !VERSION.test(version)) return jsonResponse({ error: 'invalid-version' }, 400);
    overviewCache ??= createOverviewCache();
    return overviewCache.get({ sinceMs: since.ms, sinceLabel: since.label,
      ...(version ? { version } : {}), ...(url.searchParams.has('owner') ? { owner: url.searchParams.get('owner')! } : {}) })
      .then((overview) => served(jsonResponse(overview)), () => jsonResponse({ error: 'overview-unavailable' }, 500));
  }
  if (pathname === '/v1/ops/resources') {
    // RES-FLOOR-API — shares the overview cache; no new collection, no kubectl/ssh call, never waits.
    overviewCache ??= createOverviewCache();
    const peeked = overviewCache.peek();
    return Promise.resolve(peeked
      ? served(jsonResponse(resourcesFromOverview(peeked.snapshot, peeked.pods, peeked.at)))
      : served(jsonResponse({ stale: true })));
  }
  if (pathname === '/v1/ops/resources/ledger') return served(handleResourceLedgerApi());
  if (pathname === '/v1/ops/resources/guardian') return served(handleResourceGuardianApi());
  if (pathname === '/v1/ops/train-throughput') {
    const date = url.searchParams.get('date') ?? todayKst();
    if (!isValidTrainDate(date)) return jsonResponse({ error: 'invalid-date' }, 400);
    const logDir = resolveTrainArtifactDirectory();
    if (!existsSync(logDir)) return served(jsonResponse({ error: 'train-throughput-source-unconfigured' }, 503));
    try {
      const logFiles = readdirSync(logDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^train-auto-loop-[A-Za-z0-9._-]+\.log$/.test(entry.name))
        .map(entry => join(logDir, entry.name));
      let sourceIncomplete = false;
      const lines = logFiles.flatMap(path => {
        try { return readFileSync(path, 'utf8').split(/\r?\n/); } catch { sourceIncomplete = true; return []; }
      });
      const attempts = logFiles.flatMap(path => {
        try {
          const anchorDate = statSync(path).mtime.toISOString().slice(0, 10);
          return parseTrainThroughputLogs(readFileSync(path, 'utf8').split(/\r?\n/), { date, anchorDate });
        } catch { sourceIncomplete = true; return []; }
      });
      const summaryDir = process.env.ELANOUS_TRAIN_SUMMARY_DIR ?? logDir;
      const summaries = summaryDir ? readdirSync(summaryDir, { withFileTypes: true }).flatMap(entry => {
        try {
          if (entry.isFile() && /^summary-[A-Za-z0-9._-]+\.json$/.test(entry.name)) {
            return collectTrainSummaryEvents(JSON.parse(readFileSync(join(summaryDir, entry.name), 'utf8')));
          }
          if (!entry.isDirectory() || !/^batch-[A-Za-z0-9._-]+$/.test(entry.name)) return [];
          const file = join(summaryDir, entry.name, 'summary.json');
          if (!existsSync(file) || !lstatSync(file).isFile()) { sourceIncomplete = true; return []; }
          const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
          const manifestFile = join(summaryDir, entry.name, 'manifest.json');
          let manifest: unknown;
          try { manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown : undefined; } catch { sourceIncomplete = true; manifest = undefined; }
          const identity = trainIdentityFromBatchDirectory(entry.name, manifest);
          return [...collectTrainSummaryEvents(value), ...(identity ? [
            ...trainKeysFromManifest(manifest, identity.host, identity.runId),
            ...trainRejectionsFromSummary(value, identity.host, identity.runId, manifest),
          ] : [])];
        } catch { sourceIncomplete = true; return []; }
      }) : undefined;
      const embedded = lines.flatMap(line => {
        const marker = line.indexOf(' · {');
        if (marker < 0) return [];
        try { return collectTrainSummaryEvents(JSON.parse(line.slice(marker + 3))); } catch { sourceIncomplete = true; return []; }
      });
      const result = buildTrainThroughput(attempts, summaries ? [...summaries, ...embedded] : embedded.length ? embedded : undefined, date);
      return served(jsonResponse({ ...result, sourceIncomplete }));
    } catch (error) {
      debug.log('ops.api', 'train-throughput-unavailable', { detail: String(error) });
      return jsonResponse({ error: 'train-throughput-unavailable' }, 503);
    }
  }
  if (pathname === '/v1/ops/loops-map') {
    // LOOP-MAP-API — projects only the shared overview cache's loops snapshot
    // (name·era·beat cell observedAt; null/unmeasured value and reason preserved);
    // no new remote fan-out of its own. Loop-edge joining is a later shard.
    overviewCache ??= createOverviewCache();
    // peek, not get: a cold cache answers «아직 캐시 없음» instead of starting a collection.
    return Promise.resolve(served(jsonResponse(loopsMapFromCache(overviewCache.peek()))));
  }
  if (pathname === '/v1/ops/seats') {
    const date = url.searchParams.get('date') ?? todayKst();
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+09:00`))) return jsonResponse({ error: 'invalid-date' }, 400);
    seatsCache ??= createSeatsCache(liveSeatsSources());
    return seatsCache(date).then((board) => served(jsonResponse(board)), () => jsonResponse({ error: 'seats-unavailable' }, 500));
  }
  const version = url.searchParams.get('version');
  if (pathname === '/v1/ops/checklist') {
    if (!version || !VERSION.test(version)) return jsonResponse({ error: 'invalid-version' }, 400);
    // OPS2 header «컷 · 착지 마감»: the version's row in the release schedule (REL9a), or null when none is set.
    let schedule: { cutAt: string; landBy: string | null } | null = null;
    try {
      const row = getSchedule(version);
      schedule = row ? { cutAt: row.cutAt, landBy: row.landBy ?? null } : null;
    } catch (error) {
      debug.log('ops.api', 'schedule-unreadable', { version, reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
    }
    return served(jsonResponse({ ...listChecklist(version), schedule }));
  }
  if (pathname === '/v1/ops/release/runs') {
    if (version !== null && !VERSION.test(version)) return jsonResponse({ error: 'invalid-version' }, 400);
    const runs = readReleaseRuns(version);
    if (runs === 'unavailable') return jsonResponse({ error: 'runs-unavailable' }, 500);
    return served(jsonResponse(runs));
  }
  const eventsMatch = RELEASE_EVENTS_PATH.exec(pathname);
  if (eventsMatch) return served(releaseRunEvents(req, eventsMatch[1]!));
  // WHATWG URL normalizes a literal runs/../nodes/... before routing.
  if (pathname.startsWith('/v1/ops/release/nodes/')) return jsonResponse({ error: 'invalid-id' }, 400);
  if (pathname.startsWith('/v1/ops/release/runs/')) {
    const match = LOG_PATH.exec(pathname);
    if (!match) return jsonResponse({ error: 'invalid-id' }, 400);
    const [, id, nodeId] = match;
    if (!IDENTIFIER.test(id!) || !IDENTIFIER.test(nodeId!)) return jsonResponse({ error: 'invalid-id' }, 400);
    const run = recordAt(join(effectiveInstanceRoot(), 'graph-runs', 'release-loop', `${id}.json`));
    const node = run?.nodes.find((candidate) => candidate?.nodeId === nodeId);
    if (!node || node.output === undefined || node.output === null) return jsonResponse({ error: 'not-found' }, 404);
    return served(jsonResponse({ log: redactSecretText(outputText(node.output)).slice(-4_000) }));
  }
  return jsonResponse({ error: 'not-found' }, 404);
}
