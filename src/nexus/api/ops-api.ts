import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { debug, redactSecretText } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { listChecklist } from '../../release-loop/checklist.js';
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

interface RunNode { nodeId: string; ok?: unknown; output?: unknown }
interface RunRecord {
  status: string;
  path: string[];
  startedAt: string;
  input?: unknown;
  nodes: RunNode[];
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
    return served(jsonResponse(listChecklist(version)));
  }
  if (pathname === '/v1/ops/release/runs') {
    if (version !== null && !VERSION.test(version)) return jsonResponse({ error: 'invalid-version' }, 400);
    const dir = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop');
    let filenames: string[];
    try {
      filenames = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json')
          && IDENTIFIER.test(entry.name.slice(0, -5)))
        .map((entry) => entry.name);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return served(jsonResponse([]));
      return jsonResponse({ error: 'runs-unavailable' }, 500);
    }
    const runs = filenames.flatMap((filename) => {
      const run = recordAt(join(dir, filename));
      if (!run) return [];
      const v = runVersion(run.input);
      if (version !== null && v !== version) return [];
      return [{
        runId: redactSecretText(filename.slice(0, -5)), status: redactSecretText(run.status),
        startedAt: redactSecretText(run.startedAt), version: v,
        path: run.path.filter((step): step is string => typeof step === 'string').map(redactSecretText),
        nodes: run.nodes.filter((node) => node && typeof node.nodeId === 'string').map((node) => ({
          nodeId: redactSecretText(node.nodeId), ok: typeof node.ok === 'boolean' ? node.ok : null,
          summary: nodeSummary(node.output),
        })),
      }];
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
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
