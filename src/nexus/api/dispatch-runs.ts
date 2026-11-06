/**
 * `GET /v1/dispatch/runs` — Phase 2 dispatch retrospective surface (D8).
 *
 * Sibling to `/v1/intake/runs` (I10) — reads
 * `~/.elanous/dispatch/runs.jsonl` and returns recent rows + aggregates
 * across the full file. The 7-day dispatch dogfood gate
 * (RESEARCH §11.3 · success rate per axis · top reject reasons)
 * consumes this surface.
 *
 * Query params:
 *   limit=<n>   number of rows to return (1..1000 · default 50).
 *
 * Response:
 *   { total, rows: [...], aggregates: {...} }
 *
 * Cross-ref:
 *   src/dispatch/dispatch-metrics.ts (writer + aggregator)
 *   src/dispatch/opportunistic-launcher.ts (emission consumer)
 */
import { listDispatchRuns } from '../../dispatch/dispatch-metrics.js';

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

export function handleDispatchRunsList(
  req: Request,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const result = listDispatchRuns(limit);
  return jsonResponse(result, 200);
}
