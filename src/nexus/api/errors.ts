// NEXUS · /v1/nexus/errors routes (Phase N-3 cleanup PR γ')
//
// Read + ack surface for error snapshots written by
// `supervisor/error-snapshot.ts` when a tab's halt-pattern fires or it
// exceeds the rolling restart cap. PWA `<TabDetail>` + TUI fail modal
// both consume the JSON the writer dropped under
// `~/.elanous/nexus/errors/<tabId>/<ts>.json`.

import { jsonResponse } from './json-response.js';
import {
  deleteErrorSnapshot,
  listErrorSnapshots,
  readErrorSnapshot,
} from '../supervisor/error-snapshot.js';

// GET /v1/nexus/errors[?tabId=...&limit=...]
export function handleErrorsList(url: URL): Response {
  const tabId = url.searchParams.get('tabId') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const opts: { tabId?: string; limit?: number } = {};
  if (tabId) opts.tabId = tabId;
  if (limitRaw) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n) && n > 0) opts.limit = n;
  }
  const entries = listErrorSnapshots(opts);
  return jsonResponse({ errors: entries }, 200);
}

// GET /v1/nexus/errors/:tabId — list for a single tab
export function handleErrorsForTab(tabId: string): Response {
  if (!tabId) return jsonResponse({ error: 'tab-id-required' }, 400);
  return jsonResponse({ errors: listErrorSnapshots({ tabId }) }, 200);
}

// GET /v1/nexus/errors/:tabId/:ts — single snapshot
export function handleErrorGet(tabId: string, ts: number): Response {
  if (!tabId) return jsonResponse({ error: 'tab-id-required' }, 400);
  if (!Number.isFinite(ts) || ts <= 0) return jsonResponse({ error: 'invalid-ts' }, 400);
  const snap = readErrorSnapshot(tabId, ts);
  if (!snap) return jsonResponse({ error: 'snapshot-not-found', tabId, ts }, 404);
  return jsonResponse({ snapshot: snap }, 200);
}

// DELETE /v1/nexus/errors/:tabId/:ts — ack/dismiss
export function handleErrorDismiss(tabId: string, ts: number): Response {
  if (!tabId) return jsonResponse({ error: 'tab-id-required' }, 400);
  if (!Number.isFinite(ts) || ts <= 0) return jsonResponse({ error: 'invalid-ts' }, 400);
  const removed = deleteErrorSnapshot(tabId, ts);
  if (!removed) return jsonResponse({ error: 'snapshot-not-found', tabId, ts }, 404);
  return jsonResponse({ deleted: true, tabId, ts }, 200);
}

/** Path parser for `/v1/nexus/errors[/:tabId[/:ts]]`. Returns the
 *  decoded segments, or null when the prefix doesn't match. */
export function parseErrorsPath(pathname: string): { tabId?: string; ts?: number } | null {
  if (pathname === '/v1/nexus/errors') return {};
  const prefix = '/v1/nexus/errors/';
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  if (!tail) return {};
  const parts = tail.split('/');
  const out: { tabId?: string; ts?: number } = {};
  if (parts[0]) out.tabId = decodeURIComponent(parts[0]);
  if (parts[1]) {
    const n = Number.parseInt(parts[1], 10);
    if (Number.isFinite(n)) out.ts = n;
  }
  return out;
}
