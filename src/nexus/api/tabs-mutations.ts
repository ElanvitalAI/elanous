// NEXUS · /v1/nexus/tabs* mutation routes (Phase N-3 PR ι)
//
// Adds the 6 supervisor-driven endpoints:
//   POST   /v1/nexus/tabs                — create a tab from {kind, ...opts}
//   DELETE /v1/nexus/tabs/:id            — stop + unregister
//   PATCH  /v1/nexus/tabs/:id            — patch label (spec-level patches
//                                          land in PR μ via SwitchRegistry)
//   POST   /v1/nexus/tabs/:id/start      — supervisor.startTab
//   POST   /v1/nexus/tabs/:id/stop       — supervisor.stopTab(?graceMs=N)
//   POST   /v1/nexus/tabs/:id/restart    — stop then start
//
// Each handler validates input, mutates the registry through the
// supervisor (so supervisor's spawn / health / restart wiring stays in
// the loop), and emits the relevant SSE events (tab.created · tab.up ·
// tab.down). View-only kinds (chat / webterm) accept register/start/stop
// but startTab is a no-op since they have no spawn.

import type { NexusState } from '../state/state.js';
import type { TabRegistry } from '../state/tab-registry.js';
import type { Supervisor } from '../supervisor/index.js';
import type { TabKind, TabSpec } from '../kinds/types.js';
import { createChatTabSpec } from '../kinds/chat.js';
import { createWebtermTabSpec } from '../kinds/webterm.js';
import { createDaemonTabSpec } from '../kinds/daemon.js';
import { createPwaHostTabSpec } from '../kinds/pwa-host.js';
import {
  createChannelBotTabSpec,
  type ChannelBotPlatform,
} from '../kinds/channel-bot.js';
// Surface-unification v2.2 V2.2-8 (2026-05-11) — scheduler kind retired.
import { jsonResponse } from './http-server.js';

export interface MutationContext {
  state: NexusState;
  registry: TabRegistry;
  /** Authorizes matched write requests before their handler can mutate state. */
  authorize?: (req: Request) => Response | undefined;
  /** Supervisor is required for the mutation API to be wired. The
   *  http server falls back to 503 when the supervisor was skipped
   *  (e.g., test mode with skipSupervisor=true). */
  supervisor?: Supervisor;
}

// Surface-unification v2.2 V2.2-8 (2026-05-11) — 'scheduler' kind retired.
const VALID_KINDS: ReadonlySet<TabKind> = new Set([
  'chat', 'webterm', 'daemon', 'pwa-host', 'channel-bot',
]);

const SPAWNABLE_KINDS: ReadonlySet<TabKind> = new Set([
  'daemon', 'pwa-host', 'channel-bot',
]);

function noSupervisorResponse(): Response {
  return jsonResponse(
    { error: 'supervisor-unavailable', hint: 'runNexus was started with skipSupervisor=true' },
    503,
  );
}

function noAuthorizationRuntimeResponse(): Response {
  return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
}

function nextTabId(registry: TabRegistry, kind: TabKind, requestedId?: string): string {
  if (requestedId && requestedId.length > 0) return requestedId;
  const prefix = `${kind}:`;
  let max = 0;
  for (const tab of registry.list()) {
    if (!tab.spec.id.startsWith(prefix)) continue;
    const tail = tab.spec.id.slice(prefix.length);
    const n = Number.parseInt(tail, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

interface CreateTabBody {
  kind?: string;
  id?: string;
  label?: string;
  /** Conversation owning a newly created webterm. */
  sessionId?: string;
  /** Kind-specific factory opts (passed through to the factory). */
  kindOpts?: Record<string, unknown>;
  /** When true (default), supervisor.startTab is called immediately
   *  after register for spawn-able kinds. */
  start?: boolean;
}

function buildTabSpec(body: CreateTabBody, id: string): { spec: TabSpec; reason?: string } | { error: Response } {
  const kind = body.kind as TabKind | undefined;
  if (!kind || !VALID_KINDS.has(kind)) {
    return { error: jsonResponse({ error: 'unknown-kind', kind }, 400) };
  }
  const opts = { id, label: body.label, ...(body.kindOpts ?? {}) } as Record<string, unknown>;
  switch (kind) {
    case 'chat':
      return { spec: createChatTabSpec(opts as Parameters<typeof createChatTabSpec>[0]) };
    case 'webterm':
      return { spec: createWebtermTabSpec({ ...opts, sessionId: body.sessionId ?? opts.sessionId } as Parameters<typeof createWebtermTabSpec>[0]) };
    case 'daemon':
      return { spec: createDaemonTabSpec(opts as Parameters<typeof createDaemonTabSpec>[0]) };
    case 'pwa-host':
      return { spec: createPwaHostTabSpec(opts as Parameters<typeof createPwaHostTabSpec>[0]) };
    case 'channel-bot': {
      const platform = (body.kindOpts?.platform ?? '') as ChannelBotPlatform;
      if (platform !== 'telegram' && platform !== 'discord') {
        return { error: jsonResponse({ error: 'channel-bot-platform-required', got: platform || null }, 400) };
      }
      return {
        spec: createChannelBotTabSpec({
          platform,
          ...(opts as Omit<Parameters<typeof createChannelBotTabSpec>[0], 'platform'>),
        }),
      };
    }
    // Surface-unification v2.2 V2.2-8 (2026-05-11) — scheduler kind retired.
  }
  // Unreachable when `kind` is in VALID_KINDS (5 enumerated above).
  return { error: jsonResponse({ error: 'unknown-kind', kind }, 400) };
}

export async function handleCreateTab(req: Request, ctx: MutationContext): Promise<Response> {
  if (!ctx.supervisor) return noSupervisorResponse();
  let body: CreateTabBody;
  try {
    body = (await req.json()) as CreateTabBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (!body.kind) {
    return jsonResponse({ error: 'kind-required' }, 400);
  }
  const id = nextTabId(ctx.registry, body.kind as TabKind, body.id);
  if (ctx.registry.has(id)) {
    return jsonResponse({ error: 'tab-id-conflict', id }, 409);
  }
  const built = buildTabSpec(body, id);
  if ('error' in built) return built.error;

  ctx.registry.register(built.spec);
  let started = false;
  const shouldStart = (body.start ?? true) && SPAWNABLE_KINDS.has(built.spec.kind);
  if (shouldStart) {
    try {
      await ctx.supervisor.startTab(id);
      started = ctx.registry.get(id)?.pid != null;
    } catch (err) {
      // Spawn failures surface via tab status; report 200 with started=false
      // and lastError so the caller can show the reason.
      started = false;
    }
  }
  return jsonResponse({ tab: ctx.registry.get(id), started }, 201);
}

export async function handleDeleteTab(ctx: MutationContext, id: string): Promise<Response> {
  if (!ctx.supervisor) return noSupervisorResponse();
  if (!ctx.registry.has(id)) {
    return jsonResponse({ error: 'tab-not-found', id }, 404);
  }
  await ctx.supervisor.stopTab(id, { graceMs: 0 });
  ctx.registry.unregister(id);
  return jsonResponse({ deleted: true, id }, 200);
}

interface PatchTabBody {
  label?: string;
}

export async function handlePatchTab(req: Request, ctx: MutationContext, id: string): Promise<Response> {
  const tab = ctx.registry.get(id);
  if (!tab) return jsonResponse({ error: 'tab-not-found', id }, 404);
  let body: PatchTabBody;
  try {
    body = (await req.json()) as PatchTabBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (typeof body.label === 'string' && body.label.length > 0) {
    // spec is shared by reference; mutate label and let the next snapshot
    // pick it up. Spec-shape changes (env / restart) land in PR μ.
    tab.spec.label = body.label;
  }
  return jsonResponse({ tab: ctx.registry.get(id) }, 200);
}

export async function handleStartTab(ctx: MutationContext, id: string): Promise<Response> {
  if (!ctx.supervisor) return noSupervisorResponse();
  const tab = ctx.registry.get(id);
  if (!tab) return jsonResponse({ error: 'tab-not-found', id }, 404);
  if (!tab.spec.spawn) {
    return jsonResponse({ error: 'view-only-kind', kind: tab.spec.kind }, 409);
  }
  try {
    await ctx.supervisor.startTab(id);
  } catch (err) {
    return jsonResponse(
      { error: 'start-failed', id, message: (err as Error).message ?? String(err) },
      500,
    );
  }
  const after = ctx.registry.get(id);
  return jsonResponse({ tab: after, started: after?.pid != null }, 200);
}

export async function handleStopTab(req: Request, ctx: MutationContext, id: string): Promise<Response> {
  if (!ctx.supervisor) return noSupervisorResponse();
  const tab = ctx.registry.get(id);
  if (!tab) return jsonResponse({ error: 'tab-not-found', id }, 404);
  const url = new URL(req.url);
  const graceMs = readGraceMs(url);
  await ctx.supervisor.stopTab(id, { graceMs });
  return jsonResponse({ tab: ctx.registry.get(id), stopped: true }, 200);
}

export async function handleRestartTab(req: Request, ctx: MutationContext, id: string): Promise<Response> {
  if (!ctx.supervisor) return noSupervisorResponse();
  const tab = ctx.registry.get(id);
  if (!tab) return jsonResponse({ error: 'tab-not-found', id }, 404);
  if (!tab.spec.spawn) {
    return jsonResponse({ error: 'view-only-kind', kind: tab.spec.kind }, 409);
  }
  const url = new URL(req.url);
  const graceMs = readGraceMs(url);
  try {
    await ctx.supervisor.stopTab(id, { graceMs });
    await ctx.supervisor.startTab(id);
  } catch (err) {
    return jsonResponse(
      { error: 'restart-failed', id, message: (err as Error).message ?? String(err) },
      500,
    );
  }
  const after = ctx.registry.get(id);
  return jsonResponse({ tab: after, restarted: true, started: after?.pid != null }, 200);
}

function readGraceMs(url: URL): number {
  const raw = url.searchParams.get('graceMs');
  if (!raw) return 2000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 2000;
  return n;
}

// ---------------------------------------------------------------------------
// Router dispatch — wired by http-server.ts when method != GET
// ---------------------------------------------------------------------------

export interface MutationDispatchResult {
  matched: boolean;
  response?: Response | Promise<Response>;
}

export function dispatchMutation(req: Request, ctx: MutationContext): MutationDispatchResult {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;
  const isTabMutation = method === 'POST' || method === 'PATCH' || method === 'DELETE';

  if (
    isTabMutation
    && (pathname === '/v1/nexus/tabs' || pathname.startsWith('/v1/nexus/tabs/'))
  ) {
    if (!ctx.authorize) {
      return { matched: true, response: noAuthorizationRuntimeResponse() };
    }
    const unauthorized = ctx.authorize(req);
    if (unauthorized) return { matched: true, response: unauthorized };
  }

  if (pathname === '/v1/nexus/tabs') {
    if (method === 'POST') return { matched: true, response: handleCreateTab(req, ctx) };
    return { matched: true, response: jsonResponse({ error: 'method-not-allowed', method }, 405) };
  }

  if (pathname.startsWith('/v1/nexus/tabs/')) {
    const tail = pathname.slice('/v1/nexus/tabs/'.length);
    const segments = tail.split('/');
    const id = segments[0] ?? '';
    const action = segments[1];

    if (!id) return { matched: false };

    if (!action) {
      if (method === 'DELETE') return { matched: true, response: handleDeleteTab(ctx, id) };
      if (method === 'PATCH') return { matched: true, response: handlePatchTab(req, ctx, id) };
      return { matched: false }; // GET handled by read-side
    }

    if (method !== 'POST') {
      return { matched: true, response: jsonResponse({ error: 'method-not-allowed', method }, 405) };
    }

    if (action === 'start')   return { matched: true, response: handleStartTab(ctx, id) };
    if (action === 'stop')    return { matched: true, response: handleStopTab(req, ctx, id) };
    if (action === 'restart') return { matched: true, response: handleRestartTab(req, ctx, id) };

    return { matched: true, response: jsonResponse({ error: 'unknown-action', action }, 404) };
  }

  return { matched: false };
}
