// NEXUS · GET /v1/registry/resolved + /v1/registry/events SSE
// (RFC #2161 Phase 5).
//
// `resolved` = catalog (Layer A) ⊕ liveStore (Layer B): every provider's
// canonical config plus the live availability snapshot. The PWA's
// useResolvedView() hook reads this at boot and subscribes to the SSE
// stream so the dropdown reacts to apiKey rotation / manual disable.
//
// Phase 6 (Discovery) extends the snapshot with health-probe + rate-
// limit data; Phase 5 stays read-mostly.

import { jsonResponse } from './json-response.js';
import { getCatalog } from '../../registry/loader.js';
import {
  getLiveStore,
  type ProviderLiveState,
} from '../../registry/live-store.js';
import type { CatalogProviderWire } from './registry-catalog.js';

export interface ResolvedProviderEntry extends CatalogProviderWire {
  /** Live state from `LiveStore` — null when the provider is in the
   *  catalog but the live store hasn't observed it yet (test fixtures). */
  live: ProviderLiveState | null;
}

export interface ResolvedViewResponse {
  catalogVersion: number;
  providers: ResolvedProviderEntry[];
  generatedAt: number;
}

export function handleRegistryResolved(): Response {
  const cat = getCatalog();
  const live = getLiveStore();
  const liveById = new Map(live.list().map((p) => [p.id, p] as const));
  const providers: ResolvedProviderEntry[] = [];
  for (const p of cat.providers.values()) {
    providers.push({
      id: p.id,
      displayName: p.displayName,
      aliases: [...p.aliases],
      modelPrefixes: [...p.modelPrefixes],
      apiKeyEnv: p.apiKeyEnv,
      endpointPattern: p.endpointPattern,
      defaultStreaming: p.defaultStreaming,
      toolCallingFormat: p.toolCallingFormat,
      capabilities: { ...p.capabilities },
      builtIn: p.builtIn,
      live: liveById.get(p.id) ?? null,
    });
  }
  providers.sort((a, b) => a.id.localeCompare(b.id));
  const body: ResolvedViewResponse = {
    catalogVersion: cat.catalogVersion,
    providers,
    generatedAt: Date.now(),
  };
  return jsonResponse(body, 200);
}

/** PUT /v1/registry/resolved/:providerId/disable — body `{disabled:bool}`. */
export async function handleRegistryProviderDisable(
  req: Request,
  providerId: string,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  const disabled = (raw as { disabled?: unknown } | null)?.disabled;
  if (typeof disabled !== 'boolean') {
    return jsonResponse({ error: 'invalid-body', detail: "body must be { disabled: boolean }" }, 400);
  }
  const next = getLiveStore().setManualDisabled(providerId, disabled);
  if (!next) {
    return jsonResponse({ error: 'provider-not-found', providerId }, 404);
  }
  return jsonResponse({ ok: true, provider: next }, 200);
}

/** SSE broadcaster — stream `provider-changed` + `reload` events from
 *  the LiveStore so the PWA hook re-fetches without a poll loop. */
export function handleRegistryEvents(): Response {
  const live = getLiveStore();
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch { /* stream closed */ }
      };
      // Initial sync — clients can drive the first paint off the SSE.
      send('snapshot', { providers: live.list() });
      const unsubscribe = live.subscribe((ev) => {
        if (ev.type === 'provider-changed') {
          send('provider-changed', { providerId: ev.providerId, state: ev.state });
        } else if (ev.type === 'reload') {
          send('reload', { providers: live.list() });
        }
      });
      // Heartbeat every 25s — keeps the connection alive through proxies
      // that drop idle streams (matches the existing /v1/events convention).
      const beat = setInterval(() => {
        try { controller.enqueue(enc.encode(': heartbeat\n\n')); }
        catch { clearInterval(beat); unsubscribe(); }
      }, 25_000);
      // The cancel callback fires when the client disconnects.
      (controller as unknown as { __unsub?: () => void }).__unsub = () => {
        unsubscribe();
        clearInterval(beat);
      };
    },
    cancel() {
      const controller = this as unknown as { __unsub?: () => void };
      controller.__unsub?.();
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
