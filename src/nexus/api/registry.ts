// NEXUS · /v1/registry/bindings/* HTTP routes (Phase N-3.5 PR τ)

import { jsonResponse } from './json-response.js';
import {
  setBinding,
  getBinding,
  deleteBinding,
  listBindings,
  listChannels,
  setChannelDescription,
  type SetBindingOpts,
} from '../registry/store.js';
import {
  BindingStoreError,
  validateChannel,
  validateKey,
} from '../registry/types.js';

// ---------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------

/** GET /v1/registry/bindings              — list channels (with counts)
 *  GET /v1/registry/bindings?channel=ch   — list bindings in a channel */
export function handleBindingsList(url: URL): Response {
  const channel = url.searchParams.get('channel');
  if (channel) {
    const err = validateChannel(channel);
    if (err) return jsonResponse({ error: 'invalid-channel', message: err }, 400);
    return jsonResponse({ channel, bindings: listBindings(channel) }, 200);
  }
  return jsonResponse({ channels: listChannels() }, 200);
}

/** GET /v1/registry/bindings/:channel/:key */
export function handleBindingGet(channel: string, key: string): Response {
  if (validateChannel(channel)) return jsonResponse({ error: 'invalid-channel' }, 400);
  if (validateKey(key)) return jsonResponse({ error: 'invalid-key' }, 400);
  const binding = getBinding(channel, key);
  if (!binding) return jsonResponse({ error: 'binding-not-found', channel, key }, 404);
  return jsonResponse({ binding }, 200);
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

interface BindingMutationBody {
  sessionId?: string;
  label?: string;
  meta?: Record<string, unknown>;
  mergeMeta?: boolean;
  /** Channel-level metadata · ignored on per-binding endpoints. */
  channelDescription?: string;
}

export async function handleBindingPost(req: Request, channel: string, key: string): Promise<Response> {
  return applyBindingWrite(req, channel, key, /* method */ 'POST');
}

export async function handleBindingPatch(req: Request, channel: string, key: string): Promise<Response> {
  return applyBindingWrite(req, channel, key, /* method */ 'PATCH');
}

async function applyBindingWrite(req: Request, channel: string, key: string, method: 'POST' | 'PATCH'): Promise<Response> {
  if (validateChannel(channel)) return jsonResponse({ error: 'invalid-channel' }, 400);
  if (validateKey(key)) return jsonResponse({ error: 'invalid-key' }, 400);
  let body: BindingMutationBody;
  try {
    body = (await req.json()) as BindingMutationBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (body.channelDescription !== undefined) {
    try { setChannelDescription(channel, body.channelDescription); }
    catch (err) { return jsonResponse({ error: 'channel-description-failed', message: (err as Error).message }, 400); }
  }
  const opts: SetBindingOpts = {
    ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    ...(body.label !== undefined ? { label: body.label } : {}),
    ...(body.meta !== undefined ? { meta: body.meta } : {}),
    ...(body.mergeMeta !== undefined
      ? { mergeMeta: body.mergeMeta }
      : (method === 'PATCH' ? { mergeMeta: true } : {})),
  };
  try {
    const result = setBinding(channel, key, opts);
    const status = result.outcome === 'created' && method === 'POST' ? 201 : 200;
    return jsonResponse({ binding: result.binding, outcome: result.outcome }, status);
  } catch (err) {
    if (err instanceof BindingStoreError) {
      return jsonResponse({ error: 'binding-write-failed', message: err.message }, 400);
    }
    throw err;
  }
}

export function handleBindingDelete(channel: string, key: string): Response {
  if (validateChannel(channel)) return jsonResponse({ error: 'invalid-channel' }, 400);
  if (validateKey(key)) return jsonResponse({ error: 'invalid-key' }, 400);
  const removed = deleteBinding(channel, key);
  if (!removed) return jsonResponse({ error: 'binding-not-found', channel, key }, 404);
  return jsonResponse({ deleted: true, channel, key }, 200);
}

// ---------------------------------------------------------------------------
// Path parsing helper for the http-server router
// ---------------------------------------------------------------------------

export interface ParsedBindingPath {
  channel?: string;
  key?: string;
}

export function parseBindingPath(pathname: string): ParsedBindingPath | null {
  if (!pathname.startsWith('/v1/registry/bindings')) return null;
  const tail = pathname.slice('/v1/registry/bindings'.length);
  if (tail === '' || tail === '/') return {};
  if (!tail.startsWith('/')) return null;
  const parts = tail.slice(1).split('/');
  const channel = parts[0];
  // Key may itself contain '/' (per SAFE_KEY_RE); rejoin remaining parts.
  const key = parts.length > 1 ? parts.slice(1).join('/') : undefined;
  return {
    ...(channel ? { channel } : {}),
    ...(key !== undefined && key.length > 0 ? { key } : {}),
  };
}
