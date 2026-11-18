import { findGraphFile } from '../../graph-runner/graph-file-lookup.js';
import { createGraphRunHost, parseGraphRunOrigin, type GraphRunHost } from '../../graph-runner/graph-run-host.js';
import { jsonResponse } from './json-response.js';

export const GRAPH_RUNS_PATH = '/v1/graph-runs';

export interface GraphRunsRouteDeps {
  readonly host?: GraphRunHost;
  /** The caller holds the local trusted bearer. Nothing else (session, same-origin, loopback, noAuth) may start a run. */
  readonly trusted?: boolean;
}

let defaultHost: GraphRunHost | undefined;
function hostOf(deps: GraphRunsRouteDeps): GraphRunHost {
  return deps.host ?? (defaultHost ??= createGraphRunHost({ resolveGraphFile: graphId => findGraphFile(graphId) }));
}

const STATUS = { 'graph-not-found': 404, 'bad-origin': 400, 'bad-request': 400, 'record-write-failed': 500 } as const;
const BODY_FIELDS: ReadonlySet<string> = new Set(['graphId', 'input', 'origin']);

/** POST /v1/graph-runs {graphId, input?, origin} → {runId, status:'started'} at once. Bearer only; every call is a new run. There is no GET here (reading comes in a later stage). */
export async function handleGraphRunsRoute(req: Request, pathname: string, deps: GraphRunsRouteDeps = {}): Promise<Response | null> {
  if (pathname !== GRAPH_RUNS_PATH) return null;
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  if (!deps.trusted) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad-request' }, 400);
  // A field this stage does not honour (for example a retry key) is refused, never silently ignored.
  if (Object.keys(body).some(field => !BODY_FIELDS.has(field))) return jsonResponse({ error: 'bad-request' }, 400);
  const { graphId, input, origin } = body as Record<string, unknown>;
  const result = hostOf(deps).start({ graphId, input, origin: parseGraphRunOrigin(origin) });
  if (!result.ok) return jsonResponse({ error: result.error }, STATUS[result.error]);
  return jsonResponse({ runId: result.runId, status: result.status }, 202);
}
