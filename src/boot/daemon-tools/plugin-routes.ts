// APP-BUILD-TOOLS-IN-DAEMON-TURN (0.3.28) — the daemon chat turn (web chat · PWA · ACP) gets the same plugin
// route tools as the Next TUI and the agent CLI.
//
// Before: `toolSurface('chat')` only carried `app_deploy` (through buildSharedAppTools). The route adapter's
// merged host tools (`app_build`, `app_build_plan`, `app_create`, …) were never added, so a one-line app request
// in web chat had nothing to pin (#38215 live probe: «app_build not in the turn pool»).
//
// Member turns get only DAEMON_MEMBER_ROUTE_TOOL_ALLOWLIST (OP security verdict 11-18 · r2: app_create removed).
//
// One source of truth: the catalog and dispatch come from `createChildPluginRoutes` — the same function
// `createChildPluginRuntimeContract` (Next TUI REPL · agent CLI) uses — and the specs from
// `routeOnlyHostToolSpecs`, the same merge helper the REPL uses. No second list lives here.
//
// The approval/authority path is unchanged: confirmation, owner and graph trust checks stay inside the route
// adapter and the child graph dispatcher. The daemon only supplies, per dispatch, what the TUI supplies from
// its session: the verified owner (server-bound ctx, never tool arguments) and the triggering chat's HITL
// confirm channels. No channel ⇒ the decision is «unavailable» ⇒ the route fails closed exactly as in the TUI.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import type { DaemonToolDispatchCtx } from './types.js';
import { debug } from '../../debug/log.js';
import type { ChildPluginRoutes, ChildPluginRuntimeOptions } from '../../cli/child-plugin-runtime.js';
import type { ApprovalOutcome } from '../../graph-runner/approval-outcome.js';
import {
  createAppBuildDeclineTurnGuard, isAppBuildDeclined, type AppBuildDeclineTurnGuard,
} from '../../plugins/core/app-build-decline-guard.js';
import { SEAT_TURN_CAP_DEFAULTS } from '../../core-turn/seat-turn-cap.js';

/** Route host tools a member turn (web chat · PWA · ACP) may receive. Explicit allowlist; every other route
 *  tool is denied by default.
 *  출처: OP security verdict on #38230 (11-18) — member turns get the app_build family only. Names are the
 *  declared aiTools of plugins/elanous-app-build (app_build_plan · app_build) and plugins/elanous-app-deploy
 *  (app_deploy). Matched by exact tool name, never by keyword.
 *  r2 (11-18): app_create is excluded — it is native:file_artifact_write on the daemon host filesystem and no
 *  member-scoped write boundary exists yet (separate cell). */
export const DAEMON_MEMBER_ROUTE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'app_build_plan', 'app_build', 'app_deploy',
]);

/** How long an armed decline guard lives without a turn id.
 *  출처: the TUI guard is scoped to one turn (createAppBuildDeclineTurnGuard); the daemon ctx carries no turn id,
 *  so the guard lives as long as one turn can — the default seat turn wall cap (SEAT_TURN_CAP_DEFAULTS.maxWallMs). */
export const APP_BUILD_DECLINE_GUARD_TTL_MS = SEAT_TURN_CAP_DEFAULTS.maxWallMs;

type RoutesFactory = (options: ChildPluginRuntimeOptions) => ChildPluginRoutes;

/** The dispatch ctx of the call in flight, and the approval outcomes asked during it. Concurrent turns each
 *  see only their own scope. */
interface DispatchScope { ctx: DaemonToolDispatchCtx; outcomes: ApprovalOutcome[] }
const dispatchScope = new AsyncLocalStorage<DispatchScope>();

const defaultFactory: RoutesFactory = (options) =>
  (require('../../cli/child-plugin-runtime.js') as typeof import('../../cli/child-plugin-runtime.js'))
    .createChildPluginRoutes(options);
let factory: RoutesFactory = defaultFactory;
let cached: ChildPluginRoutes | undefined;

/** Decline guards, one per session (or, without a session, per verified owner). The daemon ctx has no turn id,
 *  so an armed guard lives for APP_BUILD_DECLINE_GUARD_TTL_MS, or until the session is forgotten. */
const declineGuards = new Map<string, { guard: AppBuildDeclineTurnGuard; armedAtMs: number }>();
let now: () => number = () => Date.now();

/** Never a shared key: by session, else by verified owner; with neither the guard is not used (such a call
 *  cannot reach a declined app_build anyway — the route refuses it for the missing owner first). */
function guardKey(ctx: DaemonToolDispatchCtx): string | undefined {
  if (ctx.sessionId) return `session:${ctx.sessionId}`;
  if (ctx.verifiedOwner?.id) return `owner:${ctx.verifiedOwner.id}`;
  return undefined;
}

function sweepExpiredDeclineGuards(at: number): void {
  for (const [key, entry] of declineGuards) {
    if (at - entry.armedAtMs >= APP_BUILD_DECLINE_GUARD_TTL_MS) declineGuards.delete(key);
  }
}

/** Session end: drop that session's guard (called from the daemon session store's forget). */
export function clearAppBuildDeclineGuard(sessionId: string): void {
  declineGuards.delete(`session:${sessionId}`);
}

/** Owner authority comes only from the server-verified ctx. The member app slot is attached only when the
 *  Nexus receipt names the same member; an external-agent turn never carries owner authority. */
function verifiedOwnerOf(ctx: DaemonToolDispatchCtx | undefined): { id: string; appSlug?: string } | undefined {
  if (!ctx) return undefined;
  const owner = ctx.verifiedOwner;
  if (!owner?.id || ctx.requestOrigin === 'external-agent') return undefined;
  const receipt = ctx.appDeploymentOwner;
  return receipt && receipt.memberId === owner.id ? { id: owner.id, appSlug: receipt.appSlug } : { id: owner.id };
}

/** The triggering chat's confirm channels decide. Only an answered «no» is a refusal; timeout, a cancelled turn
 *  or no channel leave the node on hold (same reasons the TUI approver returns). Each outcome is recorded in the
 *  dispatch scope so the decline guard arms only on an answered «no». */
async function decideOnSurface(prompt: string, turnSignal?: AbortSignal,
  options?: { readonly timeoutMs?: number }): Promise<ApprovalOutcome> {
  const scope = dispatchScope.getStore();
  const outcome = await askSurface(prompt, turnSignal ?? scope?.ctx.signal, scope?.ctx.surfaceHitlChannels, options);
  scope?.outcomes.push(outcome);
  return outcome;
}

async function askSurface(prompt: string, signal: AbortSignal | undefined,
  channels: DaemonToolDispatchCtx['surfaceHitlChannels'], options?: { readonly timeoutMs?: number }): Promise<ApprovalOutcome> {
  if (signal?.aborted) return { approved: false, reason: 'turn-cancelled' };
  if (!channels?.length) return { approved: false, reason: 'unavailable' };
  const { requestConfirmation } = await import('../../hitl/confirm.js');
  const asked = requestConfirmation({
    prompt, header: '앱 만들기', yesLabel: 'y', noLabel: 'N', channels, onTimeout: () => false,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  // A cancelled turn ends the wait at once; an answer that lands after the cancel does not count.
  const cancelled = signal ? new Promise<'cancelled'>((resolve) =>
    signal.addEventListener('abort', () => resolve('cancelled'), { once: true })) : undefined;
  const result = cancelled ? await Promise.race([asked, cancelled]) : await asked;
  if (result === 'cancelled' || signal?.aborted) return { approved: false, reason: 'turn-cancelled' };
  if (result.channel === 'timeout') return { approved: false, reason: 'timeout' };
  if (result.channel === 'all-failed') return { approved: false, reason: 'unavailable' };
  return result.answer ? { approved: true } : { approved: false, reason: 'declined' };
}

function daemonRouteOptions(): ChildPluginRuntimeOptions {
  return {
    resolveVerifiedOwner: async () => verifiedOwnerOf(dispatchScope.getStore()?.ctx),
    resolveSignal: () => dispatchScope.getStore()?.ctx.signal,
    requestDecision: decideOnSurface,
  };
}

/** The shared route bridge, built once per process. A registry read failure is not cached: the surface
 *  keeps its other tools and the next assembly tries again. */
export function daemonPluginRoutes(): ChildPluginRoutes | undefined {
  if (cached) return cached;
  try {
    cached = factory(daemonRouteOptions());
    return cached;
  } catch (error) {
    debug.log('capability.resolve', 'daemon-plugin-routes-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' });
    return undefined;
  }
}

/** Route specs this surface adds: routed host tools whose names the surface does not already expose. */
export function daemonPluginRouteSpecs(exposedNames: ReadonlySet<string>): LLMToolSpec[] {
  const routes = daemonPluginRoutes();
  if (!routes) return [];
  const { routeOnlyHostToolSpecs } = require('../../cli/child-plugin-runtime.js') as typeof import('../../cli/child-plugin-runtime.js');
  const allowed = routes.hostTools.filter((tool) => DAEMON_MEMBER_ROUTE_TOOL_ALLOWLIST.has(tool.name));
  return routeOnlyHostToolSpecs(allowed, new Set(exposedNames));
}

/** Dispatch one exposed route tool with this call's ctx in scope. */
export async function dispatchDaemonPluginRoute(name: string, args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx): Promise<unknown> {
  if (!DAEMON_MEMBER_ROUTE_TOOL_ALLOWLIST.has(name)) return { ok: false, error: `route tool not allowed on this surface: ${name}` };
  const routes = daemonPluginRoutes();
  if (!routes) return { ok: false, error: `plugin route registry unavailable: ${name}` };
  const scope: DispatchScope = { ctx, outcomes: [] };
  const result = await dispatchScope.run(scope, () => routes.dispatchPluginTool(name, args));
  const key = guardKey(ctx);
  // Only an owner's answered «no» arms the guard; a hold (no channel, timeout, cancelled turn) does not.
  const answeredNo = scope.outcomes.some((outcome) => !outcome.approved && outcome.reason === 'declined');
  if (isAppBuildDeclined(result) && answeredNo && key !== undefined) {
    const at = now();
    sweepExpiredDeclineGuards(at);
    const guard = createAppBuildDeclineTurnGuard(() => undefined);
    guard.observe(result);
    declineGuards.set(key, { guard, armedAtMs: at });
  }
  return result;
}

/** APP-BUILD-DECLINE-NO-BYPASS-DEPLOY on the daemon surface: after a declined app_build in this session,
 *  a shell call that deploys or exposes a host is refused (same guard as the Next TUI). */
export function refuseBypassAfterAppBuildDecline(name: string, args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx): unknown {
  const key = guardKey(ctx);
  const entry = key === undefined ? undefined : declineGuards.get(key);
  if (!entry || key === undefined) return null;
  if (now() - entry.armedAtMs >= APP_BUILD_DECLINE_GUARD_TTL_MS) { declineGuards.delete(key); return null; }
  return entry.guard.refuse(name, args);
}

/** Number of armed decline guards (observability and tests). */
export function appBuildDeclineGuardCount(): number {
  return declineGuards.size;
}

/** Test seam: swap the bridge factory (e.g. a fake graph executor) and the clock, and clear cached state. */
export function resetDaemonPluginRoutesForTest(next?: RoutesFactory, clock?: () => number): void {
  factory = next ?? defaultFactory;
  now = clock ?? (() => Date.now());
  cached = undefined;
  declineGuards.clear();
}
