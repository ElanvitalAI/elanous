import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { debug, redactSecretText } from '../../debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { gateShardsPath, readGateShards, summarizeShards, type GateShardsFile, type GateShardsSummary } from '../../release-loop/gate-shards.js';
import { listChecklist } from '../../release-loop/checklist.js';
import { getSchedule } from '../../release-loop/release-schedule.js';
import { jsonResponse } from './json-response.js';
import { operatorSignal } from './operator.js';
import { createSeatsCache, todayKst } from './ops-seats.js';
import { liveSeatsSources } from './ops-seats-sources.js';
import type { MetaApiOpts } from './meta-api.js';

const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const IDENTIFIER = /^[A-Za-z0-9-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
let seatsCache: ReturnType<typeof createSeatsCache> | null = null;
/** Tests swap the sources; production builds them lazily on first use. */
export function setSeatsCacheForTest(cache: ReturnType<typeof createSeatsCache> | null): void { seatsCache = cache; }
const LOG_PATH = /^\/v1\/ops\/release\/runs\/([^/]+)\/nodes\/([^/]+)\/log$/;

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
  /** GATE-LIVE-OBS — 지금 gate 노드에 있는 런에만 싣는다(발행 원장 `gate-logs/cut/shards.json`). 파일이 없으면 생략. */
  gateShards?: GateShardsFile & { summary: GateShardsSummary };
}

/** 도는 gate 노드의 조각 표 — 다른 판의 파일을 붙이지 않게 version 이 같을 때만. */
function gateShardsFor(version: string | null, status: string, nodes: ReleaseRunNodeView[], ledgerRoot: string, now: number):
  ReleaseRunView['gateShards'] | undefined {
  if (!version || status !== 'running' || !nodes.some((node) => node.nodeId === 'gate' && node.ok === null)) return undefined;
  const file = readGateShards(gateShardsPath(version, ledgerRoot));
  if (!file || file.version !== version) return undefined;
  return { ...file, shards: file.shards.map((shard) => shard.waitReason ? { ...shard, waitReason: redactSecretText(shard.waitReason) } : shard),
    summary: summarizeShards(file, now) };
}

/** The release run ledger as `/v1/ops/release/runs` serves it (newest 20) — shared with Telegram /release and away mode
 *  so every surface reads the same verdicts. `'unavailable'` = the directory exists but cannot be read. */
export function readReleaseRuns(version: string | null = null,
  dir: string = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop'),
  opts: { facts?: boolean; ledgerRoot?: string; now?: number } = {}): ReleaseRunView[] | 'unavailable' {
  let filenames: string[];
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
    const gateShards = gateShardsFor(v, run.status, nodes, opts.ledgerRoot ?? releaseLedgerRoot(), opts.now ?? Date.now());
    return [{
      runId: redactSecretText(filename.slice(0, -5)), status: redactSecretText(run.status),
      startedAt: redactSecretText(run.startedAt), version: v,
      path: run.path.filter((step): step is string => typeof step === 'string').map(redactSecretText),
      nodes, ...(gateShards ? { gateShards } : {}),
    }];
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
}

/** The sole data gate for every read-only /v1/ops endpoint. */
export function handleOpsApi(req: Request, metaApi: MetaApiOpts | undefined): Response | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);

  const signal = metaApi ? operatorSignal(req, metaApi) : { operator: false, operatorSource: null };
  if (!signal.operator) {
    debug.log('ops.api', 'refused', { path: pathname, source: signal.operatorSource });
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  const served = (response: Response): Response => {
    debug.log('ops.api', 'served', { path: pathname, source: signal.operatorSource });
    response.headers.set('cache-control', 'no-store');
    return response;
  };
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
