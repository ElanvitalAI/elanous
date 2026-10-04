// NEXUS · personas REST handlers. Presets clone into the state persona store;
// writes reload the global registry so subsequent reads see the saved profile.

import {
  awaitGlobalPersonaLoad,
  getGlobalPersonaRegistry,
  reloadGlobalPersonaRegistry,
  resolveStatePersonaDir,
} from '../../persona/global-registry.js';
import { clonePreset, editPersona, loadPresets } from '../../persona/presets.js';
import type { PersonaRegistryEvent } from '../../persona/registry.js';
import type { PersonaProfile } from '../../persona/types.js';
import {
  MAX_PERSONA_DESCRIPTION_LENGTH,
  updatePersonaDescription,
} from '../../persona/write-description.js';
import { SSE_HEARTBEAT_MS } from './sse-heartbeat.js';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function notFound(msg: string): Response {
  return jsonResponse({ error: msg }, 404);
}

/** Wire shape returned to clients. Subset of `PersonaProfile` —
 *  systemPrompt body included so PWA can preview before binding (the
 *  multi-llm-bridge resolves it again at dispatch time, so the wire
 *  is informational only). */
export interface PersonaWire {
  personaId: string;
  displayName: string;
  description?: string;
  brand?: string;
  primaryModel?: string;
  systemPrompt?: string;
  avatarUrl?: string;
  brandColor?: string;
  mentionPatterns?: readonly string[];
}

function toWire(p: PersonaProfile): PersonaWire {
  const wire: PersonaWire = {
    personaId: p.personaId,
    displayName: p.displayName,
  };
  if (p.description) wire.description = p.description;
  if (p.brand) wire.brand = p.brand;
  if (p.models?.primary) wire.primaryModel = p.models.primary;
  if (p.systemPrompt) wire.systemPrompt = p.systemPrompt;
  if (p.avatarUrl) wire.avatarUrl = p.avatarUrl;
  if (p.brandColor) wire.brandColor = p.brandColor;
  if (p.mentionPatterns && p.mentionPatterns.length > 0) {
    wire.mentionPatterns = p.mentionPatterns;
  }
  return wire;
}

export interface PersonaRouteOpts {
  /** Optional auth check — production routes through the same
   *  meta-api `checkAuth` shape; tests pass undefined to skip. */
  checkAuth?: (req: Request) => boolean;
}

/** GET /v1/personas — list all loaded personas.
 *
 *  First call awaits the lazy global load so the PWA picker doesn't
 *  see an empty list during cold-start. Subsequent calls return
 *  immediately from the cached registry. */
export async function handlePersonasList(
  req: Request,
  opts: PersonaRouteOpts = {},
): Promise<Response> {
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  // Ensure first-load completes before responding.
  await awaitGlobalPersonaLoad();
  const registry = getGlobalPersonaRegistry();
  const list = registry.list();
  const wire: PersonaWire[] = list
    .map(toWire)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return jsonResponse({ personas: wire, count: wire.length }, 200);
}

/** GET /v1/personas/:personaId — single persona profile. */
export async function handlePersonaGet(
  req: Request,
  personaId: string,
  opts: PersonaRouteOpts = {},
): Promise<Response> {
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  await awaitGlobalPersonaLoad();
  const registry = getGlobalPersonaRegistry();
  const persona = registry.get(personaId);
  if (!persona) return notFound(`persona ${personaId} not found`);
  return jsonResponse({ persona: toWire(persona) }, 200);
}

/** R6 Task 3 · §6.4 SSE — `GET /v1/personas/events` returns a long-
 *  lived `text/event-stream` that mirrors the global PersonaRegistry's
 *  load/reload/upsert/remove events. The PWA picker subscribes to
 *  invalidate its TTL cache the moment yaml on disk changes; the gap
 *  between save and refresh drops from ≤60s (TTL polling) to <500ms.
 *
 *  Frame format:
 *    event: <kind>
 *    data: <json payload>
 *
 *  Where `<kind>` is one of `load-dir | reload-all | upsert | remove`
 *  (same shape as `PersonaRegistryEvent`). The first frame is always
 *  a synthetic `event: hello` with `{ count: <current size> }` so a
 *  fresh subscriber gets a baseline immediately.
 *
 *  Connection lifecycle: the response holds the stream open; closing
 *  the request unsubscribes. A 5s heartbeat (`: ping\n\n` · see
 *  `sse-heartbeat.ts`) keeps the connection alive across HTTP
 *  intermediaries that close idle streams sub-12s. */
export function handlePersonasEvents(
  req: Request,
  opts: PersonaRouteOpts = {},
): Response {
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const registry = getGlobalPersonaRegistry();
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
      // Hello frame — gives the client an immediate baseline so it
      // doesn't have to chain a separate GET to know the size.
      send('hello', { count: registry.size() });
      unsubscribe = registry.on((event: PersonaRegistryEvent) => {
        send(event.kind, event);
      });
      // Heartbeat — comments are silently ignored by EventSource but
      // keep the underlying TCP/HTTP intermediaries from closing the
      // stream as idle.
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
      // CORS hint — same-origin in production but PWA dev runs on a
      // different port. Conservative: list only what the EventSource
      // client actually needs.
      'access-control-allow-origin': '*',
    },
  });
}

/** GET /v1/persona-presets — shipped preset catalog in index order. */
export function handlePersonaPresets(req: Request, opts: PersonaRouteOpts = {}): Response {
  if (opts.checkAuth && !opts.checkAuth(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  return jsonResponse({ presets: loadPresets() }, 200);
}

/** POST /v1/personas — clone a shipped preset into the user's persona store. */
export async function handlePersonaCreate(req: Request, opts: PersonaRouteOpts = {}): Promise<Response> {
  if (opts.checkAuth && !opts.checkAuth(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'invalid-body' }, 400);
  const { preset, name } = body as Record<string, unknown>;
  if (typeof preset !== 'string' || !preset.trim() || typeof name !== 'string' || !name.trim()) {
    return jsonResponse({ error: 'preset-and-name-required' }, 400);
  }
  await awaitGlobalPersonaLoad();
  if (!loadPresets().some((p) => p.personaId === preset)) return notFound(`preset ${preset} not found`);
  try {
    const created = clonePreset(preset, name.trim(), { dir: resolveStatePersonaDir() });
    await reloadGlobalPersonaRegistry();
    const persona = getGlobalPersonaRegistry().get(created.personaId);
    if (!persona) return notFound(`persona ${created.personaId} not found after reload`);
    return jsonResponse({ persona: toWire(persona) }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('persona name already exists:')) {
      return jsonResponse({ error: 'persona-name-conflict' }, 409);
    }
    return jsonResponse({ error: 'create-failed' }, 500);
  }
}

/** PATCH /v1/personas/:personaId — description-only edits retain the
 *  existing surgical YAML behavior; multi-field edits use the persona store. */
export async function handlePersonaPatch(
  req: Request,
  personaId: string,
  opts: PersonaRouteOpts = {},
): Promise<Response> {
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let parsed: unknown;
  try { parsed = await req.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonResponse({ error: 'invalid-body' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  const fields = Object.keys(body);
  if (!fields.length) return jsonResponse({ error: 'description-required' }, 400);
  if (fields.some((field) => !['displayName', 'description', 'systemPrompt'].includes(field))) {
    return jsonResponse({ error: 'invalid-persona-field' }, 400);
  }
  if (fields.some((field) => typeof body[field] !== 'string')
    || (body.displayName !== undefined && !(body.displayName as string).trim())) {
    return jsonResponse({ error: 'invalid-persona-field' }, 400);
  }
  if (typeof body.description === 'string' && body.description.length > MAX_PERSONA_DESCRIPTION_LENGTH * 4) {
    return jsonResponse({ error: 'description-too-long' }, 400);
  }

  await awaitGlobalPersonaLoad();
  const registry = getGlobalPersonaRegistry();
  if (!registry.get(personaId)) {
    return notFound(`persona ${personaId} not found`);
  }

  const dir = resolveStatePersonaDir();
  if (fields.length === 1 && typeof body.description === 'string') {
    const result = updatePersonaDescription(dir, personaId, body.description);
    if (!result.ok) {
      const status = result.reason === 'file-not-found' ? 404 : 400;
      return jsonResponse({ error: 'patch-failed', reason: result.reason }, status);
    }
  } else {
    const edits: Record<string, unknown> = {};
    for (const field of fields) edits[field] = body[field];
    if (typeof edits.description === 'string') {
      const description = edits.description.trim();
      edits.description = description;
      if (description.length > MAX_PERSONA_DESCRIPTION_LENGTH) {
        return jsonResponse({ error: 'description-too-long' }, 400);
      }
    }
    try {
      editPersona(personaId, edits, { dir });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('persona not found:')) {
        return notFound(`persona ${personaId} not found in state store`);
      }
      if (error instanceof Error && error.message.startsWith('persona name already exists:')) {
        return jsonResponse({ error: 'persona-name-conflict' }, 409);
      }
      return jsonResponse({ error: 'patch-failed', reason: error instanceof Error ? error.message : 'invalid-persona' }, 400);
    }
  }

  // Reload so the in-memory registry reflects the saved fields on the
  // next GET. fs.watch would auto-reload but is async + race-y vs the
  // immediate echo below.
  await reloadGlobalPersonaRegistry();
  const reloaded = getGlobalPersonaRegistry().get(personaId);
  if (!reloaded) {
    return notFound(`persona ${personaId} not found after reload`);
  }
  return jsonResponse({ persona: toWire(reloaded) }, 200);
}

/** Combined dispatcher — `/v1/persona-presets` + `/v1/personas[/:id]` + `/v1/personas/events`.
 *  Returns null when the pathname doesn't match so the caller chains. */
export async function dispatchPersonaRoute(
  req: Request,
  pathname: string,
  opts: PersonaRouteOpts = {},
): Promise<Response | null> {
  const method = req.method.toUpperCase();
  if (pathname === '/v1/persona-presets') {
    if (method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
    return handlePersonaPresets(req, opts);
  }
  if (pathname === '/v1/personas') {
    if (method === 'GET') return handlePersonasList(req, opts);
    if (method === 'POST') return handlePersonaCreate(req, opts);
    return jsonResponse({ error: 'method not allowed' }, 405);
  }
  // SSE — must come BEFORE the single-persona regex so that the
  // literal "events" segment isn't misread as a personaId.
  if (pathname === '/v1/personas/events') {
    if (method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }
    return handlePersonasEvents(req, opts);
  }
  const match = pathname.match(/^\/v1\/personas\/([^/]+)$/);
  if (!match) return null;
  let personaId: string;
  try { personaId = decodeURIComponent(match[1]!); }
  catch { return jsonResponse({ error: 'invalid-persona-id' }, 400); }
  if (method === 'PATCH') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(personaId)) {
      return jsonResponse({ error: 'invalid-persona-id' }, 400);
    }
    return handlePersonaPatch(req, personaId, opts);
  }
  if (method !== 'GET') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }
  return handlePersonaGet(req, personaId, opts);
}
