// CV-3 FP-B — daemon-side Showroom layout store (cross-device sync).
//
// Storage: ~/.elanous/showroom-layouts.json (mirrors the push-subs.json
// pattern). Single JSON file holding all named layouts so atomic
// writes are trivial. No DB dependency.
//
// Endpoints:
//   GET    /v1/showroom/layouts          — list all named layouts
//   GET    /v1/showroom/layouts/:name    — load one layout
//   PUT    /v1/showroom/layouts/:name    — save (overwrite if exists)
//   DELETE /v1/showroom/layouts/:name    — delete
//
// Auth: same checkAuth() gate as `/v1/tools` / `/v1/terminals`.
// Migration: client decides — auto-migrate on first daemon save means
//   client pushes its localStorage entries to the daemon, then keeps
//   localStorage as a cache fallback (offline / SSR). vision Q3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { SSE_HEARTBEAT_MS } from './sse-heartbeat.js';

const STORE_BASE = join(homedir(), '.elanous');
const STORE_FILE = join(STORE_BASE, 'showroom-layouts.json');

/** Cap total store size to keep accidental floods bounded. */
const MAX_BYTES = 200 * 1024;

/** Cap individual layout name length so the URL path stays sane. */
const MAX_NAME_BYTES = 200;

interface SavedShowroomLayoutWire {
  name: string;
  savedAt: number;
  panels: Array<{
    id: string;
    kind: 'chat' | 'agent';
    provider: string;
    agentBrand?: 'codex' | 'claude' | 'gemini';
    state: 'live' | 'mute' | 'freeze';
  }>;
  layoutMode?: 'horizontal' | 'vertical';
}

interface StoreShape {
  layouts: Record<string, SavedShowroomLayoutWire>;
}

// Test seam — when set, handlers route reads/writes here instead of disk.
let _testStore: StoreShape | null = null;

// R6 FU.3 (2026-05-09) — change-event listener registry. SSE handler
// subscribes here so save/delete on any device push a `reload-all`
// hint to every active stream. Module-level Set is fine: listeners
// are short-lived (per request) and the emit fan-out is small.
export type ShowroomLayoutsEvent =
  | { kind: 'upsert'; name: string; savedAt: number }
  | { kind: 'remove'; name: string };

const layoutsListeners = new Set<(ev: ShowroomLayoutsEvent) => void>();

function emitLayoutsEvent(ev: ShowroomLayoutsEvent): void {
  for (const l of layoutsListeners) {
    try { l(ev); } catch { /* swallow — listener errors must not block writes */ }
  }
}

/** Subscribe to layout store change events. Returns the unsubscribe
 *  function. Exported so tests + the SSE handler can wire up. */
export function onShowroomLayoutsChange(
  listener: (ev: ShowroomLayoutsEvent) => void,
): () => void {
  layoutsListeners.add(listener);
  return () => { layoutsListeners.delete(listener); };
}

export function _showroomLayoutsListenerCount(): number {
  return layoutsListeners.size;
}

function readStore(): StoreShape {
  if (_testStore) return _testStore;
  if (!existsSync(STORE_FILE)) return { layouts: {} };
  try {
    const text = readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'layouts' in parsed) {
      return parsed as StoreShape;
    }
    return { layouts: {} };
  } catch {
    // Corrupted file — back up and start fresh so saves can resume.
    try {
      writeFileSync(`${STORE_FILE}.corrupt-${Date.now()}`, readFileSync(STORE_FILE));
    } catch { /* swallow */ }
    return { layouts: {} };
  }
}

function writeStore(store: StoreShape): { ok: true } | { ok: false; reason: string } {
  if (_testStore) {
    _testStore = { ...store, layouts: { ...store.layouts } };
    return { ok: true };
  }
  const json = JSON.stringify(store);
  if (json.length > MAX_BYTES) {
    return { ok: false, reason: `store quota exceeded (${json.length} > ${MAX_BYTES})` };
  }
  try {
    if (!existsSync(STORE_BASE)) mkdirSync(STORE_BASE, { recursive: true });
    writeFileSync(STORE_FILE, json, 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/** GET /v1/showroom/layouts — list every saved layout (sorted by
 *  savedAt desc · matches client localStorage list order). */
export function handleShowroomLayoutsList(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const store = readStore();
  const entries = Object.values(store.layouts).sort((a, b) => b.savedAt - a.savedAt);
  return jsonResponse({ layouts: entries }, 200);
}

/** GET /v1/showroom/layouts/:name — load one layout. 404 when missing. */
export function handleShowroomLayoutGet(
  req: Request,
  opts: MetaApiOpts,
  name: string,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!name) return jsonResponse({ error: 'missing-name' }, 400);
  const store = readStore();
  const layout = store.layouts[name];
  if (!layout) return jsonResponse({ error: 'not-found', name }, 404);
  return jsonResponse({ layout }, 200);
}

/** PUT /v1/showroom/layouts/:name — save (overwrite). Body is the
 *  SavedShowroomLayout wire shape (mirrors apps/pwa types). */
export async function handleShowroomLayoutPut(
  req: Request,
  opts: MetaApiOpts,
  name: string,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const trimmed = name.trim();
  if (!trimmed) return jsonResponse({ error: 'missing-name' }, 400);
  if (trimmed.length > MAX_NAME_BYTES) {
    return jsonResponse({ error: 'name-too-long', max: MAX_NAME_BYTES }, 400);
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid-body' }, 400);
  }
  const layout = body as Partial<SavedShowroomLayoutWire>;
  if (!Array.isArray(layout.panels)) {
    return jsonResponse({ error: 'invalid-panels' }, 400);
  }
  const saved: SavedShowroomLayoutWire = {
    name: trimmed,
    savedAt: typeof layout.savedAt === 'number' ? layout.savedAt : Date.now(),
    panels: layout.panels.map((p) => ({
      id: String(p.id ?? ''),
      kind: p.kind === 'agent' ? 'agent' : 'chat',
      provider: typeof p.provider === 'string' ? p.provider : '',
      ...(p.agentBrand && ['codex', 'claude', 'gemini'].includes(p.agentBrand)
        ? { agentBrand: p.agentBrand as SavedShowroomLayoutWire['panels'][number]['agentBrand'] }
        : {}),
      state: ['live', 'mute', 'freeze'].includes(p.state ?? '')
        ? (p.state as 'live' | 'mute' | 'freeze')
        : 'live',
    })),
    ...(layout.layoutMode === 'horizontal' || layout.layoutMode === 'vertical'
      ? { layoutMode: layout.layoutMode }
      : {}),
  };
  const store = readStore();
  store.layouts[trimmed] = saved;
  const result = writeStore(store);
  if (!result.ok) return jsonResponse({ error: 'write-failed', reason: result.reason }, 500);
  emitLayoutsEvent({ kind: 'upsert', name: trimmed, savedAt: saved.savedAt });
  return jsonResponse({ ok: true, layout: saved }, 200);
}

/** DELETE /v1/showroom/layouts/:name — remove. 404 when missing. */
export function handleShowroomLayoutDelete(
  req: Request,
  opts: MetaApiOpts,
  name: string,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!name) return jsonResponse({ error: 'missing-name' }, 400);
  const store = readStore();
  if (!(name in store.layouts)) {
    return jsonResponse({ error: 'not-found', name }, 404);
  }
  delete store.layouts[name];
  const result = writeStore(store);
  if (!result.ok) return jsonResponse({ error: 'write-failed', reason: result.reason }, 500);
  emitLayoutsEvent({ kind: 'remove', name });
  return jsonResponse({ ok: true, name }, 200);
}

/** R6 FU.3 (2026-05-09) — SSE handler. Mirrors the persona events
 *  endpoint shape (hello frame + per-event push + 30s heartbeat).
 *  PWA's `ShowroomSidebarSection` subscribes to refresh its list on
 *  any save/delete, including those that originated on a different
 *  device.
 *
 *  No auth check — this is read-only metadata (layout names + saved
 *  timestamps · no body). The backing endpoints (`GET /list`) already
 *  share the same posture. */
export function handleShowroomLayoutsEvents(req: Request): Response {
  void req; // not used after auth gate (kept for symmetry)
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (kind: string, data: unknown): void => {
        try {
          const frame = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch { /* stream closed */ }
      };
      const store = readStore();
      send('hello', { count: Object.keys(store.layouts).length });
      unsubscribe = onShowroomLayoutsChange((ev) => send(ev.kind, ev));
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { /* ignore */ }
      }, SSE_HEARTBEAT_MS);
    },
    cancel() {
      if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } }
      if (heartbeat) { try { clearInterval(heartbeat); } catch { /* ignore */ } }
      unsubscribe = null;
      heartbeat = null;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
}

/** Path matcher: `/v1/showroom/layouts/:name`. Returns the (URL-decoded)
 *  name when the path matches, null otherwise. */
export function parseShowroomLayoutPath(pathname: string): string | null {
  const m = /^\/v1\/showroom\/layouts\/([^/]+)$/.exec(pathname);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/** Inject an in-memory store for unit tests. Pass null to restore the
 *  real disk-backed implementation. Tests should always reset in
 *  afterEach so cross-test bleed doesn't happen. */
export function __setShowroomStoreForTest(store: StoreShape | null): void {
  _testStore = store;
}
