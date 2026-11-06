/**
 * `GET /v1/intake/runs` — Phase 1 dogfood retrospective surface (I10).
 *
 * Reads `~/.elanous/intake/pipeline-runs.jsonl` (the file every
 * pipeline-preview / pipeline-commit call appends to · see
 * `src/intake-plane/pipeline-metrics.ts`) and returns the most
 * recent N rows + aggregates the FULL file produces. The PWA dogfood
 * dashboard (BACKLOG) consumes this; users can also `curl` it
 * directly during the 1-2 week dogfood window.
 *
 * Query params:
 *   limit=<n>   number of rows to return (1..1000 · default 50).
 *
 * Response:
 *   { total, rows: [...], aggregates: {...} }
 *
 * Cross-ref:
 *   src/intake-plane/pipeline-metrics.ts (writer + reader + aggregator)
 *   src/nexus/api/intake-pipeline-preview.ts (preview emitter)
 *   src/nexus/api/intake-pipeline-commit.ts (commit emitter)
 */
import { listPipelineRuns } from '../../intake-plane/pipeline-metrics.js';

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function handleIntakeRunsList(
  req: Request,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const result = listPipelineRuns(limit);
  return jsonResponse(result, 200);
}
