// NEXUS N-1.5 PR d — voice / push / attachments meta-API native handlers.
//
// These endpoints lived in `src/boot/daemon-public-server.ts` (lines
// 1124-1279 prior to v6 cutover). The backing modules
// (`src/web-push/*`, `src/voice/voice-rest-handler.ts`,
// `src/boot/attachment-store.ts`) are call-site agnostic — both the
// daemon-public-server and the NEXUS HTTP server can dispatch into
// the same store. Web Push subscription storage at
// `~/.elanous/push-subs.json` is location-stable so PR d cutover is
// zero-migration (decision: VAPID = NEXUS 단독, store = same path).
//
// Mount via `NexusHttpServerOpts.metaApi`. Until the supervisor wires
// it (PR i / PR j boot rewire), every route returns 503 — the
// scaffolding lands now so the boot orchestrator can flip the switch
// without touching http-server.ts again.

import { randomUUID } from 'node:crypto';
import { matchTempToken } from '../../auth/temp-tokens.js';
import { matchSetupBearer } from '../../auth/setup-link-tokens.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { isSameOriginRequest, isTrustedSameOriginPeer } from '../../boot/check-same-origin.js';
import { record as recordAuthTrace, snapshot as authTraceSnapshot } from './auth-trace.js';
import {
  getActiveAcpBroadcaster,
  getActiveAcpFeedbackBroadcaster,
} from '../../acp/server.js';
import { debug } from '../../debug/log.js';
import { createThinkingBridge } from '../../feedback/agent-bridge.js';
import { createDebugBridge, type DebugBridge } from '../../feedback/debug-bridge.js';
import { createPerfTicker, type PerfTicker } from '../../feedback/perf-ticker.js';
import type { FeedbackEnvelope, HudSegmentPayload } from '../../feedback/envelope.js';
import { pushTokenGaugeFromTurn } from './daemon-hud-writer.js';
import { inspectActiveProvider } from '../../provider-summary.js';
import type { AgentStatusStore } from '../../agent-status/store.js';
import type { SessionStatus } from '../../session/card.js';
import type { HudStore } from '../state/hud-store.js';
import type { VoiceRestHandler } from '../../voice/voice-rest-handler.js';
import type { PwaTtsBridge } from '../../voice/voice-pwa-tts-bridge.js';
import type { DaemonSessionHistory } from '../../boot/daemon-runtime.js';
import { isDaemonSessionOrigin } from '../../boot/daemon-runtime.js';
import { deriveOriginFromInputSourceKind } from '../../boot/daemon-session-origin-derive.js';
import type { DaemonToolSurface } from '../../boot/daemon-tools/types.js';
import { toolSurface as buildDaemonToolSurface } from '../../boot/daemon-tools/index.js';
import type { IntakeStore } from '../../intake-plane/store.js';
import type { LLMMessage } from '../../llm.js';
import { createApiIntakeRecord } from '../../intake-plane/adapters/api.js';
import {
  answerIntakeQuestion,
  applyIntakeSession,
  archiveIntakeSession,
  decideIntakeSession,
  proposeIntakeSession,
  replayIntakeSession,
  scheduleIntakeSession,
} from '../../intake-plane/actions.js';
import type { IntakeDetail } from '../../intake-plane/http-client.js';
import { buildIntakeNextActions } from '../../intake-plane/presenter.js';
import { buildIntakeDetailDeclarativeSpec } from '../../intake-plane/http-declarative-view.js';
import { ingestIntakeRecord, type IntakeIngestPolicy } from '../../intake-plane/service.js';
import { defaultControlSignalBus } from '../../input/control-signal.js';
import { defaultControlSignalObserver } from '../../input/control-signal-observer.js';
import { emitTurnSubmitBeginSignal } from '../../input/turn-submit-control.js';
import { acquireTurn, currentTurnHolder, releaseTurn } from '../../session/session-input-arbiter.js';
import { parseControlSignalEmitBody } from '../../input/control-signal-request.js';
import {
  TurnSubmitRevisionAbortError,
  abortTurnSubmitOnRecentQuickPass,
} from '../../input/turn-submit-revision.js';
import { listSimulationScenarios } from '../../sim/catalog.js';
import { parseDaemonPromptBody, type DaemonPromptBody } from '../../boot/daemon-prompt-request.js';
import { runDaemonPromptTurn } from '../../boot/daemon-prompt-turn.js';
import { resolveSurfaceKindFromInputSource } from '../../agent/surface-ux/from-input-source.js';
import {
  createDaemonPromptTurnSubmit,
  runDaemonPromptSubmit,
} from '../../boot/daemon-prompt-submit-runtime.js';
import { coerceHitlCallbackAnswer, type HitlPendingCallbacks } from './hitl-runtime.js';
import { createPwaConfirmChannel, createPwaQuestionChannel } from './hitl-pwa-channel.js';
import type { NexusEventBus } from './event-bus.js';
import { jsonResponse } from './http-server.js';
import { defaultChatEventBus } from './chat-event-bus.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export const PWA_TOOL_RESULT_MAX_BYTES = 64 * 1024;

export type ToolResultMeta = {
  id: string;
  name: string;
  ok: boolean;
  summary?: string;
  result?: unknown;
};

type PwaToolResultMeta = Omit<ToolResultMeta, 'result'> & {
  result?: unknown;
  resultOmittedReason?: 'too_large' | 'unserializable';
};

/** Preserve raw tool results for the PWA only when their JSON wire value is safe. */
export function projectPwaToolResult(info: ToolResultMeta): PwaToolResultMeta {
  const { result, ...meta } = info;
  if (result === undefined) return meta;
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) return { ...meta, resultOmittedReason: 'unserializable' };
    if (Buffer.byteLength(serialized, 'utf8') > PWA_TOOL_RESULT_MAX_BYTES) {
      return { ...meta, resultOmittedReason: 'too_large' };
    }
    return { ...meta, result: JSON.parse(serialized) };
  } catch {
    return { ...meta, resultOmittedReason: 'unserializable' };
  }
}

export function projectDashboardToolResult(info: ToolResultMeta): {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: 'completed' | 'failed';
  title?: string;
} {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: info.id,
    status: info.ok ? 'completed' : 'failed',
    ...(info.summary ? { title: info.summary } : {}),
  };
}

export interface MetaApiOpts {
  /** When supplied, voice transcribe/cost routes dispatch to it.
   *  Built via `createVoiceRestHandler({ getSttProvider })` — the
   *  same handler shape daemon-public-server uses. */
  voiceRest?: VoiceRestHandler;
  /** When `false`, all routes are open. Otherwise the bearer token is
   *  compared constant-time against the `Authorization: Bearer …`
   *  header. */
  bearerToken?: string;
  /** Server-side human identity verification, independent of the shared bearer credential.
   *  Never derive this result from request body, claimed source, or bearer possession alone.
   *  Without a verifier, prompt tool mutations remain unavailable. */
  resolveVerifiedOwner?: (req: Request) => { id: string } | undefined;
  /** Convenience for Tailscale-only / dogfood-loopback mode. */
  noAuth?: boolean;
  // ── PR k · runtime DI for the lifted endpoints ─────────────────
  // When the matching field is undefined the route returns 503
  // `meta-api-runtime-not-wired` (preserving the PR e/f/h stub
  // contract). When wired, the handler dispatches into the runtime.
  /** Daemon session history — backs `/v1/sessions[/...]` and the
   *  `/v1/prompt` turn pipeline. */
  history?: DaemonSessionHistory;
  /** Intake plane store — backs `/v1/intake[/...]`. */
  intakeStore?: IntakeStore;
  /** Active LLM tool surface — used by `/v1/prompt` to dispatch tools
   *  + by `/v1/tools` to enumerate the active spec list. */
  toolSurface?: DaemonToolSurface;
  /** Tool dispatch cwd (Read · Grep). Defaults to process.cwd() inside
   *  the prompt runtime when omitted. */
  toolCwd?: string;
  /** System preamble injected at the head of every `/v1/prompt` turn. */
  systemPrompt?: string;
  /** HITL Pushcut callback resolver — backs
   *  `POST /v1/hitl/callback/:requestId`. */
  hitlPending?: HitlPendingCallbacks;
  /** NEXUS event bus for PWA HITL channels on prompt turns. */
  eventBus?: NexusEventBus;
  /** Phase 5b (PWA voice 일원화 server-side TTS · 2026-05-07) — when
   *  the same sessionId has an active voice WS attached (via
   *  pwaAdapter.onSessionOpen), `handlePromptStreamPost` pushes each
   *  text-delta into the bridge. The bridge's sentence-boundary
   *  emitter then flows TTS PCM back through the WS downstream chan
   *  to the browser's voice-playback. Optional — when undefined the
   *  chat REST handler runs unchanged (Phase 5 Web Speech API client
   *  fallback stays the only audio path). */
  pwaTtsBridge?: PwaTtsBridge;
  /** IPC followup (2026-05-13) — `POST /v1/agent-status` sink. The
   *  daemon's canonical AgentStatusStore (created in runNexus, exposed
   *  via RunNexusHandle.agentStatusStore). Wired by the boot
   *  orchestrator so any external process (dashboard PTY parsers,
   *  future MCP server inbound, sidecar tools) can push transitions
   *  with a single HTTP POST. The handler dedupes via the store's
   *  own state check and fans out through the existing
   *  `wireAgentStatusEvents` bridge — no new transport required. */
  agentStatusStore?: AgentStatusStore;
  /** PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — `POST
   *  /v1/hud-segment` sink. The daemon-native HudStore (created in
   *  runNexus, attached via NexusState.hudStore). Wired by the boot
   *  orchestrator so the dashboard mirror (M3) + future writers
   *  (sidecar tools · MCP rate gauge · K8s pod monitor) push segment
   *  set/clear with a single HTTP POST. Dedupe via the store's own
   *  payload-equality check; SSE fanout via `wireHudSegmentEvents`. */
  hudStore?: HudStore;
  /** iOS session-list track (2026-05-14) — when supplied, `DELETE
   *  /v1/sessions/:id` fires the ACP per-session `aborted` flag
   *  before deleting the history record. Returns `true` if the ACP
   *  server recognised the sessionId (and flagged it for cancel on
   *  its next checkpoint), `false` otherwise. Wired in NEXUS boot
   *  via the ACP server's `onAbortHandle` callback so meta-api
   *  doesn't need a direct reference to the ACP sessions Map.
   *  Without this wire the DELETE still removes history but any
   *  in-flight LLM/tool turn keeps running until natural end_turn
   *  (zombie LM Studio queue · HANDOFF §2.4 격차). */
  abortSession?: (sessionId: string) => boolean;
}

type AuthReason =
  | 'noauth'
  | 'same-origin'
  | 'untrusted-same-origin-peer'
  | 'bearer-match'
  | 'temp-token'
  | 'setup-bearer'
  | 'setup-scope-denied'
  | 'no-bearer-configured'
  | 'missing-auth-header'
  | 'bearer-length-mismatch'
  | 'bearer-mismatch';

type PublicAuthFailureReason =
  | 'no-bearer-configured'
  | 'missing-auth-header'
  | 'invalid-bearer';

function publicAuthFailureReason(reason: AuthReason): PublicAuthFailureReason {
  switch (reason) {
    case 'no-bearer-configured':
    case 'missing-auth-header':
      return reason;
    case 'untrusted-same-origin-peer':
    case 'bearer-length-mismatch':
    case 'bearer-mismatch':
      return 'invalid-bearer';
    default:
      throw new Error(`Cannot create an auth failure response for ${reason}`);
  }
}

const authPeerAddresses = new WeakMap<Request, string | undefined>();

/** Register the transport peer before routing so existing checkAuth callers
 * retain their signature. Undefined is intentionally recorded as unknown and
 * therefore cannot unlock the same-origin bypass. */
export function registerAuthPeerAddress(req: Request, peerAddress: string | undefined): void {
  authPeerAddresses.set(req, peerAddress);
}

function setupRouteAllowed(req: Request): boolean {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/v1/setup/')) return true;
  return (req.method === 'POST' && path === '/v1/prompt/stream')
    || (req.method === 'GET' && (
      /^\/v1\/sessions\/store\/[^/]+$/.test(path) || path === '/v1/chat/events'
    ));
}

function decideAuth(req: Request, opts: MetaApiOpts): { ok: boolean; reason: AuthReason } {
  if (opts.noAuth) return { ok: true, reason: 'noauth' };
  const offered = req.headers.get('authorization');
  if (offered?.startsWith('Bearer elsb_')) {
    const owner = decideBearer(req, opts);
    if (owner.ok) return owner;
    const bearer = offered.slice('Bearer '.length).trim();
    if (!matchSetupBearer(bearer)) return { ok: false, reason: 'bearer-mismatch' };
    return setupRouteAllowed(req)
      ? { ok: true, reason: 'setup-bearer' }
      : { ok: false, reason: 'setup-scope-denied' };
  }
  const peerAddress = authPeerAddresses.get(req);
  if (isSameOriginRequest(req, peerAddress)) return { ok: true, reason: 'same-origin' };
  const peerRejected = req.headers.get('sec-fetch-site') === 'same-origin'
    && !isTrustedSameOriginPeer(peerAddress);
  return decideBearer(req, opts, peerRejected);
}

function decideBearer(req: Request, opts: MetaApiOpts, peerRejected = false): { ok: boolean; reason: AuthReason } {
  const token = opts.bearerToken;
  if (!token) return { ok: false, reason: peerRejected ? 'untrusted-same-origin-peer' : 'no-bearer-configured' };
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return { ok: false, reason: peerRejected ? 'untrusted-same-origin-peer' : 'missing-auth-header' };
  }
  const offered = auth.slice('Bearer '.length).trim();
  // 단기 소유자 토큰(`elanous token issue` · 해시·만료 대조) — 소유자 토큰과 같은 권한 · 수명만 짧다.
  if (offered.startsWith('elt_') && matchTempToken(offered)) return { ok: true, reason: 'temp-token' };
  if (offered.length !== token.length) return { ok: false, reason: 'bearer-length-mismatch' };
  let diff = 0;
  for (let i = 0; i < offered.length; i += 1) {
    diff |= offered.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0
    ? { ok: true, reason: 'bearer-match' }
    : { ok: false, reason: 'bearer-mismatch' };
}

/** Bearer-only credential check that ignores the same-origin shortcut. `checkAuth` returns
 * `same-origin` before it ever looks at the Authorization header, so a paired PWA that sends its
 * token is still reported as same-origin — write paths that must not trust same-origin alone
 * (graph approvals) ask this instead. Returns the credential kind, or undefined if none matched. */
export function bearerCredential(req: Request, opts: MetaApiOpts): 'noauth' | 'bearer-match' | 'temp-token' | undefined {
  if (opts.noAuth) return 'noauth';
  const decision = decideBearer(req, opts);
  return decision.ok && (decision.reason === 'bearer-match' || decision.reason === 'temp-token') ? decision.reason : undefined;
}

// Exported so sibling NEXUS API modules (e.g. T5.G `tasks-scheduler.ts`)
// can reuse the exact same gate — same-origin + constant-time bearer
// check — without duplicating security-sensitive code.
const authDecisions = new WeakMap<Request, { ok: boolean; reason: AuthReason }>();

export function setupBearerScopeDenied(req: Request, opts: MetaApiOpts): boolean {
  return decideAuth(req, opts).reason === 'setup-scope-denied';
}

export function checkAuth(req: Request, opts: MetaApiOpts): boolean {
  const decision = decideAuth(req, opts);
  authDecisions.set(req, decision);
  // In-memory ring buffer trace — see `auth-trace.ts`. Sync, no IO.
  // Captures EVERY decision (ok + fail) so the user can see "PWA
  // settings hit /v1/tools and we returned X because Y" without
  // tailing daemon logs. Surfaced via GET /v1/diag/auth-trace.
  let pathname = req.url;
  try { pathname = new URL(req.url).pathname; } catch { /* keep raw */ }
  recordAuthTrace({
    ts: Date.now(),
    method: req.method,
    path: pathname,
    ok: decision.ok,
    reason: decision.reason,
    sfs: req.headers.get('sec-fetch-site'),
    origin: req.headers.get('origin'),
    host: req.headers.get('host'),
    referer: req.headers.get('referer'),
    hasBearer: Boolean(opts.bearerToken),
    peerAddress: authPeerAddresses.get(req),
  });
  return decision.ok;
}

/** Return the safe public reason for a preceding failed `checkAuth` call.
 * Internal auth diagnostics stay in the trace; bearer mismatch variants
 * intentionally collapse here to avoid exposing token-length information. */
function authFailureResponse(req: Request, opts: MetaApiOpts): Response {
  const decision = authDecisions.get(req) ?? decideAuth(req, opts);
  if (decision.reason === 'setup-scope-denied') return jsonResponse({ error: 'forbidden' }, 403);
  return jsonResponse({ error: 'unauthorized', reason: publicAuthFailureReason(decision.reason) }, 401);
}

/** GET /v1/diag/auth-trace — return the in-memory ring buffer. Same
 *  auth gate as the rest of /v1/* (same-origin or bearer). */
export function handleAuthTraceGet(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  return jsonResponse({ entries: authTraceSnapshot() }, 200);
}

export async function handleVapidPublicKey(): Promise<Response> {
  // Public — no auth gate. PWA fetches before the user pastes a token.
  const { loadVapidKeyPair } = await import('../../web-push/vapid-keys.js');
  const keys = await loadVapidKeyPair();
  return jsonResponse({ publicKey: keys.publicKey, subject: keys.subject }, 200);
}

/** IPC followup (2026-05-13) — universal agent.status push seam.
 *  Any process with a daemon bearer token can POST a transition;
 *  the daemon dedupes via its store's own change-check and the
 *  existing `wireAgentStatusEvents` bridge fans it onto the
 *  `/v1/events` bus so PWA `<StatusChip>` hydrates. Status enum
 *  matches `AgentStatusStore.set`'s `SessionStatus` — translation
 *  to the envelope's `running/queued/done/error` happens PWA-side
 *  (`consumeAgentStatusSse`, shipped PR #2504).
 *
 *  Body: { agentId: string; status: SessionStatus;
 *          lastEvent?: string }
 *  Returns 204 No Content on success, 400 on bad body, 503 when no
 *  store is wired, 401 when auth fails. */
const VALID_SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  'idle', 'working', 'awaiting', 'done', 'err',
]);

export async function handleAgentStatusPost(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.agentStatusStore) {
    return jsonResponse({ error: 'agent-status-store-not-wired' }, 503);
  }
  let body: { agentId?: unknown; status?: unknown; lastEvent?: unknown };
  try {
    body = (await req.json()) as { agentId?: unknown; status?: unknown; lastEvent?: unknown };
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) return jsonResponse({ error: 'invalid-agent-id' }, 400);
  if (typeof body.status !== 'string' || !VALID_SESSION_STATUSES.has(body.status)) {
    return jsonResponse({ error: 'invalid-status', allowed: [...VALID_SESSION_STATUSES] }, 400);
  }
  const lastEvent = typeof body.lastEvent === 'string' && body.lastEvent.length > 0
    ? body.lastEvent
    : undefined;
  opts.agentStatusStore.set(agentId, body.status as SessionStatus, lastEvent);
  return new Response(null, { status: 204 });
}

/** PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — universal
 *  hud.segment push seam. Mirrors handleAgentStatusPost but writes the
 *  process-wide HudStore (one strip shared across PWA tabs/sessions —
 *  reasoning level · ssh-remote · ctx gauge etc.). Two body shapes:
 *
 *    upsert: { key, value, priority?, tone?, glyph? }
 *    clear:  { key, clear: true }
 *
 *  Returns 204 on success · 400 on bad body · 503 when store not wired
 *  · 401 when auth fails. Dedupe lives in the store: redundant payloads
 *  (deep-equal) no-op without firing the bus bridge. */
const VALID_HUD_TONES_SERVER: ReadonlySet<string> = new Set<string>([
  'normal',
  'warn',
  'danger',
  'success',
  'info',
  'muted',
]);

export async function handleHudSegmentPost(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.hudStore) {
    return jsonResponse({ error: 'hud-store-not-wired' }, 503);
  }
  let body: {
    key?: unknown;
    value?: unknown;
    priority?: unknown;
    tone?: unknown;
    glyph?: unknown;
    clear?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return jsonResponse({ error: 'invalid-key' }, 400);

  if (body.clear === true) {
    opts.hudStore.clear(key);
    return new Response(null, { status: 204 });
  }

  if (typeof body.value !== 'string') {
    return jsonResponse({ error: 'invalid-value' }, 400);
  }
  const payload: HudSegmentPayload = {
    key,
    value: body.value,
    ...(typeof body.priority === 'number' && Number.isFinite(body.priority)
      ? { priority: body.priority }
      : {}),
    ...(typeof body.tone === 'string' && VALID_HUD_TONES_SERVER.has(body.tone)
      ? { tone: body.tone as HudSegmentPayload['tone'] }
      : {}),
    ...(typeof body.glyph === 'string' && body.glyph.length > 0
      ? { glyph: body.glyph }
      : {}),
  };
  opts.hudStore.set(payload);
  return new Response(null, { status: 204 });
}

export async function handleSubscribePush(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  let body: { subscription?: unknown; label?: unknown };
  try {
    body = (await req.json()) as { subscription?: unknown; label?: unknown };
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  const sub = body.subscription as
    | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    | undefined;
  if (!sub || typeof sub.endpoint !== 'string'
      || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
    return jsonResponse({ error: 'invalid-subscription' }, 400);
  }
  const { addSubscription } = await import('../../web-push/subscriptions.js');
  const record = addSubscription({
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    ...(typeof body.label === 'string' ? { label: body.label } : {}),
  });
  return jsonResponse({ id: record.id, createdAt: record.createdAt }, 201);
}

export async function handleUnsubscribePush(req: Request, id: string, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const { removeSubscription } = await import('../../web-push/subscriptions.js');
  const removed = removeSubscription(id);
  return jsonResponse({ deleted: removed, id }, removed ? 200 : 404);
}

export async function handleTestPush(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const { sendPushToAll } = await import('../../web-push/sender.js');
  const result = await sendPushToAll({
    title: 'elanous — test notification',
    body: 'Web Push delivery is working.',
    tag: 'elanous-test',
  });
  return jsonResponse(result, 200);
}

/** T5.D — GET /v1/push/subscriptions: list active subscribers (auth-gated).
 *  PWA `/settings` 의 Notifications 카드 가 사용해서 사용자 본인의 active
 *  subscription 만 노출. 보안상 전체 endpoint URL · keys 는 마스킹하고
 *  id · label · createdAt 만 반환. */
export async function handleListPushSubscriptions(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const { listSubscriptions } = await import('../../web-push/subscriptions.js');
  const records = listSubscriptions();
  const subscriptions = records.map((r) => ({
    id: r.id,
    label: r.label ?? null,
    createdAt: r.createdAt,
    endpointHost: maskEndpoint(r.subscription.endpoint),
  }));
  return jsonResponse({ subscriptions, count: subscriptions.length }, 200);
}

function maskEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return u.host;
  } catch {
    return '(invalid)';
  }
}

export function handleVoiceTranscribe(req: Request, opts: MetaApiOpts): Response | Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.voiceRest) return jsonResponse({ error: 'voice-rest-disabled' }, 503);
  return opts.voiceRest.handleTranscribe(req);
}

export function handleVoiceCost(req: Request, opts: MetaApiOpts): Response | Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.voiceRest) return jsonResponse({ error: 'voice-rest-disabled' }, 503);
  return opts.voiceRest.handleCost();
}

export async function handleAttachmentUpload(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.startsWith('multipart/form-data')) {
    return jsonResponse({ error: 'bad_request', reason: 'expected multipart/form-data' }, 400);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return jsonResponse({
      error: 'bad_request',
      reason: `failed to parse multipart body: ${String(err)}`,
    }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'bad_request', reason: 'file field must be a Blob' }, 400);
  }
  const filenameField = form.get('filename');
  const filename = typeof filenameField === 'string' && filenameField.length > 0
    ? filenameField
    : (file instanceof File ? file.name : 'upload.bin');
  const { saveAttachmentBlob } = await import('../../boot/attachment-store.js');
  const result = await saveAttachmentBlob({ blob: file, filename });
  if (!result.ok) {
    return jsonResponse(
      { error: result.reason, detail: result.detail },
      result.reason === 'too-large' ? 413 : 400,
    );
  }
  return jsonResponse({
    id: result.entry.id,
    filename: result.entry.filename,
    mediaType: result.entry.mediaType,
    size: result.entry.size,
    createdAt: result.entry.createdAt,
    downloadUrl: `/v1/attachments/${result.entry.id}`,
    path: result.entry.path,
  }, 201);
}

/** T5.C — `findLastScreenshotInMessages` mirror (daemon-public 의 동일
 *  함수에서 lift). 세션 history 를 뒤에서부터 순회하며 가장 최근의
 *  image-bearing tool_result block 을 찾는다. */
function findLastScreenshotInMessages(
  messages: readonly LLMMessage[],
): { mediaType: string; base64: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (typeof msg.content === 'string') continue;
    for (let b = msg.content.length - 1; b >= 0; b--) {
      const block = msg.content[b]!;
      if (block.type !== 'tool_result' || typeof block.content === 'string') continue;
      for (let c = block.content.length - 1; c >= 0; c--) {
        const item = block.content[c]!;
        if (item.type === 'image' && item.base64 && item.mediaType.startsWith('image/')) {
          return { mediaType: item.mediaType, base64: item.base64 };
        }
      }
    }
  }
  return null;
}

/** T5.C — GET /v1/turns/last/screenshot?session=<id>. */
export function handleLastScreenshotGet(req: Request, url: URL, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  const sessionId = url.searchParams.get('session') ?? '';
  if (!sessionId) return jsonResponse({ error: 'missing_session' }, 400);
  const messages = opts.history.get(sessionId);
  const found = findLastScreenshotInMessages(messages);
  if (!found) return jsonResponse({ error: 'not_found' }, 404);
  try {
    const buf = Buffer.from(found.base64, 'base64');
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': found.mediaType,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return jsonResponse({ error: 'not_found' }, 404);
  }
}

/** T5.C — GET /v1/recordings/<recorderId>.cast. asciicast file 서빙
 *  (~/.elanous/timelines/). filename 은 [a-zA-Z0-9_.-]{1,256}.cast 만
 *  허용 (path traversal 방지). */
export async function handleRecordingGet(
  req: Request,
  pathname: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const PATH_PREFIX = '/v1/recordings/';
  const filename = pathname.slice(PATH_PREFIX.length);
  if (!/^[a-zA-Z0-9_.-]{1,256}\.cast$/.test(filename) || filename.includes('..')) {
    return jsonResponse({ error: 'invalid_recording_filename' }, 400);
  }
  try {
    const { defaultTimelineBaseDir } = await import('../../tool-runtime/recording-runtimes-paths.js');
    const baseDir = defaultTimelineBaseDir();
    const { join: joinPath2, resolve: resolvePath } = await import('node:path');
    const filePath = joinPath2(baseDir, filename);
    const resolved = resolvePath(filePath);
    const root = resolvePath(baseDir);
    if (!resolved.startsWith(root)) return jsonResponse({ error: 'not_found' }, 404);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    const buf = readFileSync(resolved);
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': 'application/x-asciicast',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return jsonResponse({ error: 'not_found' }, 404);
  }
}

export async function handleAttachmentGet(req: Request, id: string, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!/^att-[a-z0-9]+-[a-z0-9]+$/.test(id)) {
    return jsonResponse({ error: 'invalid_attachment_id' }, 400);
  }
  const { resolveAttachmentPath } = await import('../../boot/attachment-store.js');
  const filePath = resolveAttachmentPath(id);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': mime,
      'cache-control': 'private, max-age=3600',
    },
  });
}

/** `GET /v1/media/:id` — 로컬에 보관한 생성물을 준다.
 *
 *  ⭐ 이것이 있어야 「복원」이 상대 CDN 수명에 안 걸린다(생성물은 30일 뒤 삭제된다).
 *  ⛔ id 검증은 «저장소 안»에서 한다(`resolveMediaPath`) — 경로 탈출은 그 자리가 막는다.
 *  ⚠️ 없으면 404 다. 앱은 그때 «원격 주소»로 되돌아가면 되고, 그것이 fail-soft 의 값이다.
 */
export async function handleMediaGet(req: Request, id: string, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const { resolveMediaPath } = await import('./media-store.js');
  const filePath = resolveMediaPath(id);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': mime,
      // ⭐ 내용이 id(주소 해시)에 «못 박혀» 있으므로 오래 캐시해도 안전하다.
      'cache-control': 'private, max-age=86400',
    },
  });
}

// ── PR k · prompt / intake / sessions / control-signals / hitl ─────
//
// Handlers below are lifted from `src/boot/daemon-public-server.ts`
// (the canonical pre-v6 host) so the contract is preserved. Each
// function dispatches into the runtime field on `MetaApiOpts`; the
// http-server caller checks the matching field and falls back to
// 503 `meta-api-runtime-not-wired` when absent (preserving PR e/f/h
// stub contract).

const RUNTIME_NOT_WIRED = 'meta-api-runtime-not-wired';

// M2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — monotonic
// per-process turn counter. Used as `turnSeq` for the ThinkingBridge's
// blockId so two concurrent turns on the same sessionId don't collide.
// Wraps at MAX_SAFE_INTEGER (effectively never under realistic load).
let nextThinkingTurnSeq = 0;

function badRequest(reason: string): Response {
  return jsonResponse({ error: 'bad_request', reason }, 400);
}

/** PR-D (PWA surface picker · 2026-05-13) — resolve the effective tool
 *  surface for a single turn. Per-request `body.tools` override wins
 *  over the daemon's boot-time `opts.toolSurface` (set via CLI `--tools`
 *  or `global.tools`); when neither is present, returns `undefined` so
 *  `runDaemonPromptTurn` falls back to its text-only path. Surface
 *  rebuilding per turn is cheap (no I/O — pure spec list + dispatcher
 *  closure) so we don't bother memoizing. */
function resolvePromptHitlChannels(sessionId: string, opts: MetaApiOpts): {
  surfaceHitlChannels: ReturnType<typeof createPwaConfirmChannel>[];
  surfaceQuestionChannels: ReturnType<typeof createPwaQuestionChannel>[];
} | undefined {
  if (!sessionId || !opts.eventBus || !opts.hitlPending) return undefined;
  return {
    surfaceHitlChannels: [createPwaConfirmChannel({
      bus: opts.eventBus,
      awaitCallback: (requestId) => opts.hitlPending!.awaitCallback(requestId),
    })],
    surfaceQuestionChannels: [createPwaQuestionChannel({
      bus: opts.eventBus,
      awaitCallback: (requestId) => opts.hitlPending!.awaitQuestionCallback(requestId),
    })],
  };
}

function resolvePerRequestToolSurface(
  parsedTools: import('../../boot/daemon-prompt-request.js').DaemonPromptRequest['tools'],
  bootSurface: DaemonToolSurface | undefined,
): DaemonToolSurface | undefined {
  if (parsedTools !== null) return buildDaemonToolSurface(parsedTools);
  return bootSurface;
}

function notFound(payload: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: 'not_found', ...payload }, 404);
}

// ── /v1/prompt ────────────────────────────────────────────────────

export function promptVerifiedOwner(req: Request, opts: MetaApiOpts): { id: string } | undefined {
  const owner = opts.resolveVerifiedOwner?.(req);
  return typeof owner?.id === 'string' && owner.id.trim() ? { id: owner.id.trim() } : undefined;
}

export async function handlePromptPost(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  let body: DaemonPromptBody;
  try {
    body = (await req.json()) as DaemonPromptBody;
  } catch {
    return badRequest('invalid JSON body');
  }
  const parsed = parseDaemonPromptBody(body, opts.systemPrompt);
  if (!parsed.ok) return badRequest(parsed.reason);
  const submit = createDaemonPromptTurnSubmit({
    kind: 'submit-turn',
    source: parsed.value.source ?? { kind: 'daemon-api', route: '/v1/prompt' },
    text: parsed.value.userText,
    route: 'daemon-prompt',
  });
  try {
    const result = await runDaemonPromptSubmit({
      submit,
      beforeExecute: (next) => {
        abortTurnSubmitOnRecentQuickPass({
          signalBus: defaultControlSignalBus(),
          scope: { channel: 'nexus', surface: 'daemon-prompt' },
        });
        emitTurnSubmitBeginSignal({
          submit: next,
          signalBus: defaultControlSignalBus(),
          scope: { channel: 'nexus', surface: 'daemon-prompt' },
        });
      },
      runDaemonPrompt: async () => {
        const effectiveSurface = resolvePerRequestToolSurface(parsed.value.tools, opts.toolSurface);
        const surfaceResolution = resolveSurfaceKindFromInputSource(parsed.value.source);
        return runDaemonPromptTurn({
          history: opts.history!,
          request: parsed.value,
        surface: surfaceResolution.surface,
        surfaceResolutionReason: surfaceResolution.reason,
        ...(parsed.value.userContent ? { promptBlocks: parsed.value.userContent } : {}),
        ...((owner) => owner ? { verifiedOwner: owner } : {})(promptVerifiedOwner(req, opts)),
        ...(resolvePromptHitlChannels(typeof body.sessionId === 'string' ? body.sessionId : '', opts) ?? {}),
        ...(effectiveSurface ? { toolSurface: effectiveSurface } : {}),
        ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
        dispatchToolErrorMessage: 'NEXUS prompt runtime has no tool surface (start nexus with `--tools readonly|webterm`)',
        });
      },
    });
    // P-1 — tag the session with its inbound origin (tg / dc / pwa / cli)
    // so the picker UI can show a per-session pill. Idempotent (overwrites
    // on every turn with the same value when the bridge stays consistent);
    // ACP-internal sources leave the tag undefined.
    const inboundOrigin = deriveOriginFromInputSourceKind(submit.source.kind);
    if (inboundOrigin) {
      opts.history.setOrigin(result.sessionId, inboundOrigin);
    }
    // 응답에 실제 활성 provider+model 태깅 — PWA 가 "어느 LLM 이 답했나"(elanous ->
    // claude/opus·grok 등) 를 메시지에 작게 표시. config 기반 활성 provider.
    let provider: string | undefined;
    let model: string | undefined;
    try {
      const active = inspectActiveProvider();
      provider = active.provider;
      model = active.model;
    } catch { /* fail-soft — 태깅 없으면 표시 생략 */ }
    return jsonResponse({
      sessionId: result.sessionId,
      text: result.text,
      stopReason: result.stopReason,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    }, 200);
  } catch (err) {
    if (err instanceof TurnSubmitRevisionAbortError) {
      return jsonResponse({
        error: 'turn_preempted',
        message: err.message,
        signalId: err.signalId,
        signalKind: err.signalKind,
      }, 409);
    }
    return jsonResponse({
      error: 'turn_failed',
      message: (err as Error).message,
    }, 500);
  }
}

// ── /v1/prompt/stream — Phase B-1 (PWA chat streaming · 2026-05-06) ──
//
// SSE variant of `/v1/prompt`. Same request body shape, same auth +
// runtime gate. Wire format (one event block per `\n\n`-terminated
// chunk):
//
//   event: turn-begin
//   data: {"sessionId":"…"}
//
//   event: text-delta
//   data: {"delta":"Hel","full":"Hel"}
//
//   event: feedback
//   data: {"envelopeVersion":1,"sessionId":"…","blockId":"…","kind":"agent.thinking"|…,
//          "phase":"start"|"delta"|"update"|"end","emittedAt":1700000000000,"seq":1,
//          "payload":{…},"asciiFallback":["…"]}
//
//   event: turn-end
//   data: {"sessionId":"…","text":"…","stopReason":"end_turn"}
//
//   event: error
//   data: {"error":"turn_preempted"|"turn_failed","message":"…",…}
//
// M1 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) added
// the `feedback` event for the carrier-agnostic Feedback Envelope
// fabric. PWA `parsePromptSseStream` / `consumeObserverSse` validate
// each envelope via `isFeedbackEnvelopeWire` before dispatch — daemon
// emits are expected to satisfy `src/feedback/envelope.ts`'s
// `FeedbackEnvelope` schema. Server-side emit callers land in M2/M5
// (agent-bridge · debug-bridge · tool runtime opt-in).
//
// Errors are emitted as terminal `error` events rather than HTTP error
// statuses because the SSE response has already started streaming with
// status 200 by the time `runDaemonPromptTurn` throws. Auth + body
// parse failures still return JSON 401/400/503 before any event flushes.

export async function handlePromptStreamPost(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  let body: DaemonPromptBody;
  try {
    body = (await req.json()) as DaemonPromptBody;
  } catch {
    return badRequest('invalid JSON body');
  }
  const parsed = parseDaemonPromptBody(body, opts.systemPrompt);
  if (!parsed.ok) return badRequest(parsed.reason);
  // M6 PR 1 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — opt-in
  // debug-tap. PWA `/chat?debug-tap=on` propagates the query down to
  // `/v1/prompt/stream`; the debug-bridge created below activates only
  // when this gate is on so the legacy chat client sees no extra
  // envelopes by default.
  let debugTapEnabled = false;
  try {
    const reqUrl = new URL(req.url);
    debugTapEnabled = reqUrl.searchParams.get('debug-tap') === 'on';
  } catch {
    /* malformed URL — leave gate closed */
  }
  const submit = createDaemonPromptTurnSubmit({
    kind: 'submit-turn',
    source: parsed.value.source ?? { kind: 'daemon-api', route: '/v1/prompt/stream' },
    text: parsed.value.userText,
    route: 'daemon-prompt',
  });
  const enc = new TextEncoder();
  // Phase B-3 (2026-05-06) — client disconnect ⇒ daemon abort. The
  // `cancel` callback fires when the consumer (PWA fetch) closes the
  // stream early — typically because the user clicked Stop or
  // navigated away. Abort the per-turn controller so `runCoreTurn`
  // unwinds promptly instead of running to completion against a
  // disconnected reader. The signal also gates other supplemental
  // hooks (image / tool-result) — once aborted, write() becomes a
  // no-op via the controller-closed catch below.
  const turnAbortController = new AbortController();
  // Phase B-4 (2026-05-06) — publish every event we emit on the
  // single-receiver POST stream to the process chat-event bus too.
  // Observers subscribed via `GET /v1/chat/events?sessionId=…` then
  // receive the same wire shape — the foundation for multi-tab
  // consistency. `publishedSessionId` captures the daemon-resolved
  // sessionId (which may have been minted by parseDaemonPromptBody
  // when the caller submitted with no id).
  const bus = defaultChatEventBus();
  const publishedSessionId = parsed.value.sessionId;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: string, data: unknown): void => {
        try {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // controller already closed by abort — swallow.
        }
        // Phase B-4 — fanout. Errors are isolated by the bus so a
        // bad listener can't break the POST consumer; we still
        // double-guard here to keep the SSE writer robust.
        try {
          bus.publish(publishedSessionId, { event, data });
        } catch {
          /* swallow — fanout is supplemental */
        }
      };
      const sessionId = parsed.value.sessionId;
      const key = `nexus:daemon-prompt#${randomUUID()}`;
      const acquired = acquireTurn(sessionId, key);
      if (!acquired.granted) {
        releaseTurn(sessionId, key);
        write('error', {
          error: 'turn_busy',
          message: `This session is currently receiving input from ${currentTurnHolder(sessionId) ?? acquired.holder}. Please try again when that turn finishes.`,
          holder: acquired.holder,
        });
        try { controller.close(); } catch { /* already closed */ }
        return;
      }
      try {
        write('turn-begin', { sessionId });
        const result = await runDaemonPromptSubmit({
          submit,
          beforeExecute: (next) => {
            abortTurnSubmitOnRecentQuickPass({
              signalBus: defaultControlSignalBus(),
              scope: { channel: 'nexus', surface: 'daemon-prompt' },
            });
            emitTurnSubmitBeginSignal({
              submit: next,
              signalBus: defaultControlSignalBus(),
              scope: { channel: 'nexus', surface: 'daemon-prompt' },
            });
          },
          runDaemonPrompt: async () => {
            // ACP streaming Phase E (PLAN v1.2 · 2026-05-07) — dual-emit:
            // SSE write for chat client (legacy compat) + ACP broadcast
            // for cross-surface peers (webterm dock, TUI, other PWA tabs)
            // on the same daemon sessionId. acpBroadcast may be null if
            // runAcpServer hasn't booted yet (degenerate test mode); in
            // that case only SSE fires and cross-surface mirror is no-op.
            const acpBroadcast = getActiveAcpBroadcaster();
            const acpFeedbackBroadcast = getActiveAcpFeedbackBroadcaster();
            const turnSessionId = parsed.value.sessionId;
            if (debug.enabled) {
              debug.log('acp.dual-emit.init', turnSessionId, {
                hasBroadcaster: !!acpBroadcast,
                hasFeedbackBroadcaster: !!acpFeedbackBroadcast,
                hasSessionId: !!turnSessionId,
                hasPwaTtsBridge: !!opts.pwaTtsBridge,
              });
            }
            let eventBusDeliveryFailureCount = 0;
            const recordEventBusDeliveryFailure = (reason: 'event_bus_absent' | 'publish_threw'): void => {
              eventBusDeliveryFailureCount += 1;
              if (eventBusDeliveryFailureCount === 1) {
                debug.log('nexus.event-bus', 'feedback-delivery-failed', { reason });
              }
            };
            // M2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
            // ThinkingBridge emits `agent.thinking` envelopes (start /
            // coalesced delta / end) so PWA <ThinkingPill> can pulse
            // alongside the existing text-delta stream.
            //
            // PLAN-ios-rich-dev-feedback-hydrate · M1-S (2026-05-13) —
            // dual-emit now also fans out via ACP `sessionUpdate:
            // 'feedback'` so non-SSE peers (iOS native ACP client ·
            // future Mesh transport) hydrate the same envelopes.
            // SSE write is preserved unchanged (PWA stays on its
            // legacy `/v1/prompt/stream` event channel).
            const dualEmitFeedback = (env: FeedbackEnvelope): void => {
              write('feedback', env);
              if (acpFeedbackBroadcast && turnSessionId) {
                void acpFeedbackBroadcast(turnSessionId, env);
              }
              if (!opts.eventBus) {
                recordEventBusDeliveryFailure('event_bus_absent');
                return;
              }
              try {
                opts.eventBus.publish({
                  ts: Date.now(),
                  kind: 'media.feedback',
                  detail: env as unknown as Record<string, unknown>,
                });
              } catch {
                recordEventBusDeliveryFailure('publish_threw');
              }
            };
            const thinkingBridge = createThinkingBridge({
              emit: dualEmitFeedback,
              sessionId: turnSessionId,
              turnSeq: ++nextThinkingTurnSeq,
            });
            thinkingBridge.begin();
            // M6 PR 1 — debug-tap bridge. Registers a sink on the
            // process-wide `debug` singleton; sink stays inert until
            // `activate()` flips the gate (PWA passed ?debug-tap=on).
            // Disposed in the `finally` below so the sink unregisters
            // regardless of how the turn unwinds.
            const debugBridge: DebugBridge = createDebugBridge({
              emit: dualEmitFeedback,
              sessionId: turnSessionId,
            });
            if (debugTapEnabled) debugBridge.activate();
            // Opportunistic followup §6.2 #6 — `perf.tick` source.
            // Same dual-emit wire as ThinkingBridge / debug-bridge;
            // 1Hz coalesced sample rate for the built-in
            // `llm.tokens-per-sec` metric. Other LLM-economy
            // metrics (cost, latency) attach via perfTicker.tick(...)
            // from future emit sites without touching this closure.
            const perfTicker: PerfTicker = createPerfTicker({
              emit: dualEmitFeedback,
              sessionId: turnSessionId,
            });
            perfTicker.begin();
            const dualEmitTextDelta = (delta: string, full: string): void => {
              write('text-delta', { delta, full });
              thinkingBridge.observeTextDelta(delta);
              perfTicker.observeTextDelta(delta);
              if (acpBroadcast && turnSessionId) {
                void acpBroadcast(turnSessionId, {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: delta },
                });
              }
              // Phase 5b (PWA voice 일원화 server-side TTS · 2026-05-07)
              // — same sessionId 의 active voice WS 가 attach 되어
              // 있으면 bridge 가 sentence boundary 마다 PCM emit →
              // /v1/voice/ws downstream → 브라우저 voice-playback 재생.
              // bridge undefined (provider 미설정 OR opts 미주입) 시
              // 호출 0 — 회귀 영향 없음. 모든 errors swallow (bridge
              // 자체가 디자인상 swallow 함 · voice-pwa-tts-bridge.ts:160).
              if (opts.pwaTtsBridge && turnSessionId) {
                try { opts.pwaTtsBridge.pushChunk(turnSessionId, delta); }
                catch { /* swallow — telemetric */ }
              }
            };
            const dualEmitImageBlock = (info: { src: string; mediaType: string; alt?: string }): void => {
              write('image-block', info.alt !== undefined
                ? { src: info.src, mediaType: info.mediaType, alt: info.alt }
                : { src: info.src, mediaType: info.mediaType });
              if (acpBroadcast && turnSessionId) {
                void acpBroadcast(turnSessionId, {
                  sessionUpdate: 'agent_message_chunk',
                  content: {
                    type: 'image',
                    data: info.src,
                    mimeType: info.mediaType,
                    ...(info.alt ? { uri: info.alt } : {}),
                  },
                });
              }
            };
            const dualEmitToolCall = (info: { id: string; name: string; args: Record<string, unknown> }): void => {
              write('tool-call', info);
              if (acpBroadcast && turnSessionId) {
                void acpBroadcast(turnSessionId, {
                  sessionUpdate: 'tool_call',
                  toolCallId: info.id,
                  rawInput: info.args,
                  title: info.name,
                  status: 'in_progress',
                });
              }
            };
            const dualEmitToolResult = (info: ToolResultMeta): void => {
              const projected = projectPwaToolResult(info);
              // ⛔⭐⭐ 위젯 이음매 관측 — 이 자리가 「위젯 주소가 살아서 나가나」의 «마지막 데몬측 지점»이다.
              //   📏 2026-08-21: 사슬 여덟 조각이 전부 통과하는데 화면엔 위젯이 «안 떴다».
              //     홉마다 코드를 읽어 좁혔지만 정적으로는 «전부 통과»였다 ⇒ 실물에서만 갈린다.
              //   ⇒ 그래서 여기에 계측을 «남긴다». 다음에 같은 질문이 오면 읽기가 아니라 조회로 답한다.
              //   ⛔ 「없다」와 「못 쟀다」를 가른다 — result 자체가 빠졌으면 그 이유도 같이 남는다.
              // ⛔ `debug.enabled` 로 감싸지 «않는다» — 그 플래그는 파일 로깅과 «다른 축»이고,
              //   2026-08-21 에 내가 그걸로 감쌌다가 «관측 0」을 「배선이 안 탄다」로 읽을 뻔했다.
              //   실을 것은 다섯 칸뿐이라 비용이 없다.
              {
                const r = projected.result;
                const meta = r && typeof r === 'object' && !Array.isArray(r)
                  ? (r as Record<string, unknown>)._meta : undefined;
                const ui = meta && typeof meta === 'object' && !Array.isArray(meta)
                  ? (meta as Record<string, unknown>).ui : undefined;
                const uri = ui && typeof ui === 'object' && !Array.isArray(ui)
                  ? (ui as Record<string, unknown>).resourceUri : undefined;
                debug.log('mcp.widget', 'tool-result-projected', {
                  path: 'rest',
                  tool: info.name,
                  resultPresent: projected.result !== undefined,
                  omittedReason: projected.resultOmittedReason ?? null,
                  hasMeta: meta !== undefined,
                  resourceUri: typeof uri === 'string' ? uri : null,
                });
              }
              write('tool-result', projected);
              if (acpBroadcast && turnSessionId) {
                void acpBroadcast(turnSessionId, projectDashboardToolResult(info));
              }
            };
            try {
              const effectiveSurface = resolvePerRequestToolSurface(
                parsed.value.tools,
                opts.toolSurface,
              );
              const surfaceResolution = resolveSurfaceKindFromInputSource(parsed.value.source);
              return await runDaemonPromptTurn({
                history: opts.history!,
                request: parsed.value,
                surface: surfaceResolution.surface,
                surfaceResolutionReason: surfaceResolution.reason,
                ...(parsed.value.userContent ? { promptBlocks: parsed.value.userContent } : {}),
                ...((owner) => owner ? { verifiedOwner: owner } : {})(promptVerifiedOwner(req, opts)),
                ...(resolvePromptHitlChannels(typeof body.sessionId === 'string' ? body.sessionId : '', opts) ?? {}),
                ...(effectiveSurface ? { toolSurface: effectiveSurface } : {}),
                ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
                signal: turnAbortController.signal,
                onTextDelta: dualEmitTextDelta,
                onImageBlock: dualEmitImageBlock,
                onToolCall: dualEmitToolCall,
                onToolResultMeta: dualEmitToolResult,
                // M5 PR 2 — same emitter the ThinkingBridge writes
                // through, but now also reaches tool runtimes via
                // DaemonToolDispatchCtx.emitFeedback. Grep is the
                // first caller; future Read / Bash / Edit lan with
                // their own envelopes on the same wire.
                onFeedback: dualEmitFeedback,
                dispatchToolErrorMessage:
                  'NEXUS prompt runtime has no tool surface (start nexus with `--tools readonly|webterm`)',
              });
            } finally {
              // M2 — emit final `agent.thinking` phase=end envelope
              // regardless of how the turn unwinds (success · abort ·
              // tool error). Idempotent so it's safe under nested
              // catch sites.
              thinkingBridge.end();
              // §6.2 #6 — final perf-tick flush + timer teardown.
              perfTicker.end();
              // M6 PR 1 — unregister the debug-bridge sink. Idempotent.
              debugBridge.dispose();
              if (eventBusDeliveryFailureCount > 0) {
                debug.log('nexus.event-bus', 'feedback-delivery-failures', {
                  count: eventBusDeliveryFailureCount,
                });
              }
            }
          },
        });
        // P-1 — same origin tagging as /v1/prompt. Done before
        // turn-end so the picker UI's `GET /v1/sessions` reflects the
        // tag immediately if a refresh races the close.
        const inboundOrigin = deriveOriginFromInputSourceKind(submit.source.kind);
        if (inboundOrigin && opts.history) {
          opts.history.setOrigin(result.sessionId, inboundOrigin);
        }
        // Same fail-soft tagging as `/v1/prompt`: inspect once before
        // turn-end so the bubble (provider·model) and HUD share one result.
        let provider: string | undefined;
        let model: string | undefined;
        try {
          const active = inspectActiveProvider();
          provider = active.provider;
          model = active.model;
        } catch { /* fail-soft — 태깅 없으면 표시 생략 */ }
        write('turn-end', {
          sessionId: result.sessionId,
          text: result.text,
          stopReason: result.stopReason,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        });
        // PR-B1 (chat-only HUD · 2026-05-13) — daemon-side token-gauge
        // writer. Without this the daemon HudStore stays empty when the
        // dashboard process isn't running, and PWA `<ChatHud>` renders
        // nothing (segments.length === 0 → null). Pushes the metrics
        // snapshot via `pushTokenGaugeFromTurn` so the same SSE that
        // delivers `feedback` envelopes also carries the gauge update.
        if (opts.hudStore) {
          try {
            pushTokenGaugeFromTurn(opts.hudStore, {
              model,
              inputText: parsed.value.userText,
              outputText: result.text,
            });
          } catch (err) {
            // Best-effort observer — never break the turn for a HUD push.
            debug.log('hud.daemon-writer.error', String(err), { level: 'error' });
          }
        }
        // Phase 5b — flush 잔여 buffer 를 마지막 sentence 로 emit.
        // 사용자가 마지막 한 문장을 못 듣고 끊기는 회귀 회피.
        // abort/error path 에서는 별도 cancel 안 함 — voice WS detach
        // 시 bridge 자동 cleanup (voice-pwa-tts-bridge.ts:240).
        if (opts.pwaTtsBridge && result.sessionId) {
          try { await opts.pwaTtsBridge.flush(result.sessionId); }
          catch { /* swallow — telemetric */ }
        }
      } catch (err) {
        if (err instanceof TurnSubmitRevisionAbortError) {
          write('error', {
            error: 'turn_preempted',
            message: err.message,
            signalId: err.signalId,
            signalKind: err.signalKind,
          });
        } else {
          write('error', {
            error: 'turn_failed',
            message: (err as Error).message ?? String(err),
          });
        }
      } finally {
        releaseTurn(sessionId, key);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel(): void {
      // Client disconnected mid-turn (Stop button / navigation /
      // network drop). Fire abort so the LLM stream and any pending
      // tool dispatch unwind. The catch around the runDaemonPrompt
      // call maps the AbortError to a `turn_failed` SSE event, but
      // the controller is already closed at that point so write() is
      // a no-op — the user just sees the bubble freeze, which is
      // the expected UX for a deliberate Stop.
      turnAbortController.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // Tailscale Serve / proxies sometimes buffer text/event-stream
      // by default — this header asks them to flush per write.
      'x-accel-buffering': 'no',
    },
  });
}

// ── /v1/chat/events — Phase B-4 (PWA chat streaming · 2026-05-06) ──
//
// Long-lived SSE observer for chat turn events. Any peer subscribed
// to `?sessionId=X` receives the same wire shape that
// `POST /v1/prompt/stream` writes, fanned out from the in-process
// chat-event bus. Foundation for multi-tab `/chat` consistency: a
// second tab can subscribe and watch the active turn even though it
// did not initiate the POST.
//
// Scope: in-process only (no IPC), no replay (late subscribers see
// only future events), no auth-scoped session — `sessionId` matching
// is the access boundary, the same as `/v1/prompt/stream`.
//
// Disconnect handling: `ReadableStream.cancel` calls the unsubscribe
// fn, releasing the listener slot. Active POST turns are unaffected
// — observers do not gate the producer.
//
// ## Auth policy (intentional asymmetry vs `/v1/events`)
//
// `/v1/events` (NEXUS read-only state SSE) is unauthenticated — it
// carries process metadata (tab lifecycle · health · template
// catalog) that a curious peer on loopback can already infer from
// connection behavior. `/v1/chat/events` is bearer-gated through
// `checkAuth` because the payload mirrors user-typed prompts +
// LLM-generated content + tool args (potentially file paths, config
// secrets, attachment URLs) — same access boundary as the writer
// (`POST /v1/prompt/stream`). Treat the two endpoints as distinct
// scopes: state-channel (open to loopback peers) vs content-channel
// (bearer-gated). NEXUS review #1788 flagged the asymmetry; this
// jsdoc records the intent so future reviewers don't unify them by
// reflex.

export function handleChatEventsGet(
  req: Request,
  url: URL,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return jsonResponse(
      { error: 'bad_request', reason: 'sessionId query param required' },
      400,
    );
  }
  const bus = defaultChatEventBus();
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Tell the consumer the subscription is live before any real
      // events flow. Mirrors the `turn-begin` shape expected by the
      // existing `parsePromptSseStream` — observers can reuse the
      // same parser, treating this as a no-op marker.
      try {
        controller.enqueue(
          enc.encode(
            `event: subscribed\ndata: ${JSON.stringify({ sessionId })}\n\n`,
          ),
        );
      } catch { /* already closed */ }
      unsubscribe = bus.subscribe(sessionId, (e) => {
        try {
          controller.enqueue(
            enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
          );
        } catch {
          // Controller closed — unsubscribe via cancel callback below.
        }
      });
    },
    cancel(): void {
      if (unsubscribe) {
        try { unsubscribe(); } catch { /* swallow */ }
        unsubscribe = null;
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

// ── /v1/intake ────────────────────────────────────────────────────

interface IntakeBody {
  intakeId?: string;
  text?: string;
  source?: 'api' | 'document' | 'url';
  mode?: IntakeIngestPolicy['mode'];
  scheduleText?: string;
  /** check 모드의 사실 목록. 없으면 text 한 줄을 사실로 본다. */
  facts?: Array<{ text?: string; quote?: string; sourceRef?: string }>;
  receivedAt?: string;
  actor?: { id?: string; display?: string };
  channelContext?: {
    chatId?: string;
    guildId?: string;
    threadId?: string;
    deviceId?: string;
  };
}

interface IntakeActionBody {
  force?: boolean;
  mode?: 'apply-now' | 'review-later' | 'backlog-only' | 'discard';
  questionId?: string;
  answer?: string;
  scheduleText?: string;
}

function summarizeIntakeSession(
  session: import('../../intake-plane/types.js').IntakeSession,
  opts: { detailed?: boolean } = {},
): Record<string, unknown> {
  const raw = opts.detailed
    ? {
        text: session.raw.rawText,
        transcriptSource: session.raw.transcriptSource ?? null,
        attachments: session.raw.attachments.map((attachment) => ({
          name: attachment.name,
          kind: attachment.kind,
          localPath: attachment.localPath,
          mimeType: attachment.mimeType ?? null,
          sourceUrl: attachment.sourceUrl ?? null,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          duration: attachment.duration ?? null,
          sizeBytes: attachment.sizeBytes ?? null,
        })),
      }
    : undefined;
  return {
    intakeId: session.intakeId,
    state: session.state,
    source: session.raw.source,
    receivedAt: session.raw.receivedAt,
    updatedAt: session.updatedAt,
    actor: session.raw.actor ?? null,
    channelContext: session.raw.channelContext ?? null,
    draft: session.draft
      ? {
          title: session.draft.title,
          summary: session.draft.summary,
          itemCount: session.draft.items.length,
          openQuestionCount: session.draft.openQuestions.length,
          suggestedMode: session.draft.suggestedMode,
          ...(opts.detailed
            ? {
                confidence: session.draft.confidence,
                items: session.draft.items.map((item) => ({
                  id: item.id,
                  kind: item.kind,
                  text: item.text,
                  links: [...item.links],
                  priorityHint: item.priorityHint ?? null,
                  targetSurface: item.targetSurface ?? null,
                  needsClarification: item.needsClarification,
                  proposedAction: item.proposedAction,
                })),
                openQuestions: session.draft.openQuestions.map((question) => ({
                  id: question.id,
                  scope: question.scope,
                  itemId: question.itemId ?? null,
                  question: question.question,
                  reason: question.reason,
                })),
              }
            : {}),
        }
      : null,
    decisionMode: session.decision?.mode ?? null,
    ...(opts.detailed
      ? {
          decision: session.decision
            ? {
                mode: session.decision.mode,
                approvedItemIds: [...session.decision.approvedItemIds],
                deferredItemIds: [...session.decision.deferredItemIds],
                clarifiedAnswers: { ...session.decision.clarifiedAnswers },
              }
            : null,
          proposal: session.proposal
            ? {
                objective: session.proposal.objective,
                goalSlug: session.proposal.goalSlug ?? null,
                preferredSurfaces: session.proposal.preferredSurfaces ?? null,
                budgetUsdRemaining: session.proposal.budgetUsdRemaining ?? null,
                scheduleText: session.proposal.scheduleText ?? null,
                contextNotes: [...session.proposal.contextNotes],
              }
            : null,
          applyTokenPresent: !!session.applyToken,
          nextActions: buildIntakeNextActions(session, 'http'),
          raw,
        }
      : {}),
  };
}

export async function handleIntakePost(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.intakeStore) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  let body: IntakeBody;
  try { body = (await req.json()) as IntakeBody; }
  catch { return badRequest('invalid JSON body'); }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return badRequest('text required');
  const mode = body.mode ?? 'review';
  if (!['review', 'apply-now', 'backlog-only', 'schedule-followup', 'check'].includes(mode)) {
    return badRequest('mode must be review | apply-now | backlog-only | schedule-followup | check');
  }
  if (mode === 'schedule-followup' && (!body.scheduleText || !body.scheduleText.trim())) {
    return badRequest('scheduleText required for schedule-followup');
  }
  const now = new Date();
  const intakeId = body.intakeId
    ?? `api-${now.toISOString().replace(/[:.]/g, '-').toLowerCase()}`;
  const checkFacts = Array.isArray(body.facts)
    ? body.facts.flatMap((fact) => {
      const factText = typeof fact?.text === 'string' ? fact.text.trim() : '';
      if (!factText) return [];
      return [{
        text: factText,
        ...(typeof fact.quote === 'string' ? { quote: fact.quote } : {}),
        ...(typeof fact.sourceRef === 'string' ? { sourceRef: fact.sourceRef } : {}),
      }];
    })
    : undefined;
  const documentCheck = mode === 'check' && body.source === 'document' && !checkFacts;
  const result = documentCheck
    ? await (async () => {
      const { defaultIntakeCheckDeps, runIntakeCheckDocument, parseFactList } = await import('../../intake-plane/check.js');
      const { buildIntakeDocumentStageCallables } = await import('../../intake-plane/runtime-callables.js');
      const stages = buildIntakeDocumentStageCallables();
      const facts = parseFactList(text, 'document');
      const report = await runIntakeCheckDocument(facts, defaultIntakeCheckDeps(process.cwd(), {
        preprocess: stages.preprocess,
        compare: stages.compare,
      }), { document: text, sourceBulletCount: facts.length });
      return {
        intakeId,
        state: 'captured' as const,
        session: {
          intakeId,
          raw: createApiIntakeRecord({
            intakeId,
            text,
            receivedAt: typeof body.receivedAt === 'string' && body.receivedAt.trim()
              ? body.receivedAt
              : now.toISOString(),
            ...(body.actor ? { actor: body.actor } : {}),
            ...(body.channelContext ? { channelContext: body.channelContext } : {}),
          }),
          state: 'captured' as const,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        output: report.items.map((item) => item.line).join('\n'),
        taskIds: undefined,
        taskId: undefined,
        check: report,
      };
    })()
    : await ingestIntakeRecord(
      opts.intakeStore,
      createApiIntakeRecord({
        intakeId,
        text,
        receivedAt: typeof body.receivedAt === 'string' && body.receivedAt.trim()
          ? body.receivedAt
          : now.toISOString(),
        ...(body.actor ? { actor: body.actor } : {}),
        ...(body.channelContext ? { channelContext: body.channelContext } : {}),
      }),
      mode === 'schedule-followup'
        ? { mode, scheduleText: body.scheduleText?.trim() }
        : { mode },
      checkFacts,
    );
  const check = result.check
    ? {
      mode: result.check.mode,
      tree: result.check.tree,
      commit: result.check.commit,
      harnessLaunches: result.check.harnessLaunches,
      goalDraftPaths: result.check.goalDraftPaths,
      ...(typeof result.check.keptClaims === 'number' ? {
        keptClaims: result.check.keptClaims,
        discardedFacts: result.check.discardedFacts,
        discards: result.check.discards,
      } : {}),
      ...(typeof result.check.proposalCount === 'number' ? {
        proposalCount: result.check.proposalCount,
        proposals: result.check.proposals,
      } : {}),
      items: result.check.items.map((item) => ({
        fact: item.fact,
        current: item.current,
        verdict: item.verdict,
        line: item.line,
        quotes: item.quotes,
        evidence: item.evidence,
        patterns: item.patterns,
        failures: item.failures,
        ...(item.goalDraftPath ? { goalDraftPath: item.goalDraftPath } : {}),
      })),
    }
    : undefined;
  return jsonResponse({
    output: result.output,
    ...summarizeIntakeSession(result.session, { detailed: true }),
    taskIds: result.taskIds ?? null,
    taskId: result.taskId ?? null,
    ...(check ? { check } : {}),
  }, 200);
}

export function handleIntakeListGet(
  req: Request,
  url: URL,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.intakeStore) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  const state = url.searchParams.get('state') ?? undefined;
  const source = url.searchParams.get('source') ?? undefined;
  const query = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  const sessions = opts.intakeStore.listSessions({
    ...(state ? { state: state as import('../../intake-plane/types.js').IntakeState } : {}),
    ...(source ? { source: source as import('../../intake-plane/types.js').RawIntakeRecord['source'] } : {}),
  }).filter((session) => {
    if (!query) return true;
    return [
      session.intakeId,
      session.raw.rawText,
      session.draft?.title ?? '',
      session.draft?.summary ?? '',
    ].some((value) => value.toLowerCase().includes(query));
  });
  return jsonResponse({
    sessions: sessions.map((session) => summarizeIntakeSession(session)),
  }, 200);
}

export async function handleIntakeIdRoute(
  req: Request,
  suffix: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.intakeStore) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  if (!suffix) return notFound();
  const store = opts.intakeStore;

  if (req.method === 'POST' && suffix.endsWith('/replay')) {
    const intakeId = suffix.slice(0, -'/replay'.length);
    if (!intakeId || !store.getSession(intakeId)) return notFound();
    const replayed = replayIntakeSession(
      store,
      intakeId,
      new Date(),
      `api-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`,
    );
    return jsonResponse({
      sourceId: intakeId,
      ...summarizeIntakeSession(replayed.session),
    }, 200);
  }

  for (const action of ['propose', 'apply', 'decide', 'answer', 'schedule', 'archive'] as const) {
    if (req.method === 'POST' && suffix.endsWith(`/${action}`)) {
      const intakeId = suffix.slice(0, -(action.length + 1));
      if (!intakeId || !store.getSession(intakeId)) return notFound();
      let body: IntakeActionBody = {};
      try {
        if (req.headers.get('content-length') !== '0') body = (await req.json()) as IntakeActionBody;
      } catch { body = {}; }

      if (action === 'propose') {
        const proposed = await proposeIntakeSession(store, intakeId);
        return jsonResponse({
          output: proposed.output,
          ...summarizeIntakeSession(proposed.session, { detailed: true }),
          applyToken: proposed.applyToken ?? null,
        }, 200);
      }
      if (action === 'apply') {
        const applied = await applyIntakeSession(store, intakeId, body.force === true);
        return jsonResponse({
          output: applied.output,
          ...summarizeIntakeSession(applied.session, { detailed: true }),
          taskIds: applied.taskIds ?? null,
          taskId: applied.taskId ?? null,
        }, 200);
      }
      if (action === 'decide') {
        if (body.mode !== 'apply-now' && body.mode !== 'review-later'
          && body.mode !== 'backlog-only' && body.mode !== 'discard') {
          return badRequest('mode required for decide');
        }
        const decided = decideIntakeSession(store, intakeId, body.mode);
        return jsonResponse({
          output: decided.output,
          ...summarizeIntakeSession(decided.session, { detailed: true }),
        }, 200);
      }
      if (action === 'answer') {
        const questionId = String(body.questionId ?? '').trim();
        const answer = String(body.answer ?? '').trim();
        if (!questionId || !answer) return badRequest('questionId and answer required');
        const answered = answerIntakeQuestion(store, intakeId, questionId, answer);
        return jsonResponse({
          output: answered.output,
          ...summarizeIntakeSession(answered.session, { detailed: true }),
        }, 200);
      }
      if (action === 'schedule') {
        const scheduleText = String(body.scheduleText ?? '').trim();
        if (!scheduleText) return badRequest('scheduleText required');
        const scheduled = scheduleIntakeSession(store, intakeId, scheduleText);
        return jsonResponse({
          output: scheduled.output,
          ...summarizeIntakeSession(scheduled.session, { detailed: true }),
        }, 200);
      }
      const archived = archiveIntakeSession(store, intakeId);
      return jsonResponse({
        output: archived.output,
        ...summarizeIntakeSession(archived.session, { detailed: true }),
      }, 200);
    }
  }

  if (req.method === 'GET' && suffix.endsWith('/review-view')) {
    const intakeId = suffix.slice(0, -'/review-view'.length);
    if (!intakeId) return notFound();
    const session = store.getSession(intakeId);
    if (!session) return notFound();
    const detail = summarizeIntakeSession(session, { detailed: true }) as unknown as IntakeDetail;
    return jsonResponse({
      intakeId,
      view: buildIntakeDetailDeclarativeSpec(detail),
    }, 200);
  }
  if (req.method === 'GET' && suffix.endsWith('/events')) {
    const intakeId = suffix.slice(0, -'/events'.length);
    if (!intakeId) return notFound();
    const session = store.getSession(intakeId);
    if (!session) return notFound();
    const events = store.listEvents({ intakeId });
    return jsonResponse({ intakeId, events }, 200);
  }
  if (req.method === 'GET') {
    const session = store.getSession(suffix);
    if (!session) return notFound();
    return jsonResponse(summarizeIntakeSession(session, { detailed: true }), 200);
  }
  return notFound();
}

// ── /v1/sessions ──────────────────────────────────────────────────

export function handleSessionsList(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  return jsonResponse({ sessions: opts.history.summary() }, 200);
}

export async function handleSessionRegister(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  let body: unknown;
  try { body = await req.json(); }
  catch { return badRequest('invalid JSON body'); }
  const b = body as { sessionId?: unknown; messages?: unknown; origin?: unknown };
  if (typeof b.sessionId !== 'string' || b.sessionId.length === 0) {
    return badRequest('sessionId required (non-empty string)');
  }
  if (b.sessionId.includes('/') || b.sessionId.includes('\\') || b.sessionId.includes('..')) {
    return badRequest('invalid sessionId (path traversal)');
  }
  const messages: LLMMessage[] = [];
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (
        m && typeof m === 'object' &&
        typeof (m as { role?: unknown }).role === 'string' &&
        'content' in (m as object)
      ) {
        messages.push(m as LLMMessage);
      }
    }
  }
  const originRaw = b.origin;
  const origin = isDaemonSessionOrigin(originRaw) ? originRaw : undefined;
  try {
    opts.history.register(
      b.sessionId,
      messages,
      origin ? { origin } : undefined,
    );
  } catch (err) {
    return badRequest((err as Error).message ?? 'register failed');
  }
  return jsonResponse({
    ok: true,
    sessionId: b.sessionId,
    msgCount: opts.history.get(b.sessionId).length,
  }, 200);
}

export function handleSessionDelete(
  req: Request,
  id: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return badRequest('invalid sessionId');
  }
  // Fire the ACP abort flag BEFORE we drop the history record — the
  // turn runner picks up `session.aborted` at its next checkpoint
  // (between LLM streaming chunks / tool calls) and exits with
  // stopReason='cancelled'. Without this any in-flight turn keeps
  // running, leaving an orphan LM Studio request even though the
  // user-visible session is gone (HANDOFF §2.4 zombie 격차).
  const aborted = opts.abortSession?.(id) ?? false;
  const existed = opts.history.has(id);
  opts.history.forget(id);
  return jsonResponse({ ok: true, sessionId: id, deleted: existed, aborted }, 200);
}

export function handleSessionGet(
  req: Request,
  id: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.history) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return badRequest('invalid sessionId');
  }
  if (!opts.history.has(id)) {
    return jsonResponse({ error: 'unknown_session', sessionId: id }, 404);
  }
  return jsonResponse({ sessionId: id, messages: opts.history.get(id) }, 200);
}

// ── /v1/control-signals ───────────────────────────────────────────

export function handleControlSignalsList(
  req: Request,
  url: URL,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  // ControlSignalObserver is a process-wide singleton — no runtime
  // field to gate on, so this dispatches whenever metaApi auth is
  // satisfied. Stub-contract tests that omit metaApi entirely never
  // reach this branch (http-server handles the no-metaApi path).
  const observer = defaultControlSignalObserver();
  const kind = url.searchParams.get('kind')?.trim() || undefined;
  const channel = url.searchParams.get('channel')?.trim() || undefined;
  const surface = url.searchParams.get('surface')?.trim() || undefined;
  const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
  const minUrgency = url.searchParams.get('minUrgency')?.trim() || undefined;
  const rawLimit = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(200, Math.trunc(rawLimit)))
    : 50;
  const all = observer.list({
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(surface ? { surface } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(minUrgency ? { minUrgency: minUrgency as never } : {}),
  });
  const items = all.slice(Math.max(0, all.length - limit));
  const countsByKind: Record<string, number> = {};
  for (const signal of all) {
    countsByKind[signal.kind] = (countsByKind[signal.kind] ?? 0) + 1;
  }
  return jsonResponse({
    total: all.length,
    limit,
    latest: items.length > 0 ? items[items.length - 1] : null,
    countsByKind,
    items,
  }, 200);
}

export async function handleControlSignalsEmit(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  let body: unknown;
  try { body = await req.json(); }
  catch { return badRequest('invalid JSON body'); }
  const parsed = parseControlSignalEmitBody(body);
  if (!parsed.ok) return badRequest(parsed.reason);
  const signal = defaultControlSignalBus().emit({
    kind: parsed.value.kind,
    urgency: parsed.value.urgency ?? 'normal',
    source: parsed.value.source ?? 'system',
    ...(parsed.value.payload !== undefined ? { payload: parsed.value.payload } : {}),
    ...(parsed.value.scope ? { scope: parsed.value.scope } : {}),
    ...(typeof parsed.value.mayPreempt === 'boolean' ? { mayPreempt: parsed.value.mayPreempt } : {}),
    ...(parsed.value.expiresAt ? { expiresAt: parsed.value.expiresAt } : {}),
  });
  return jsonResponse(signal, 200);
}

// ── /v1/simulations ───────────────────────────────────────────────

export function handleSimulationsList(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  return jsonResponse({ scenarios: listSimulationScenarios() }, 200);
}

// ── /v1/tools ─────────────────────────────────────────────────────

export function handleToolsList(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.toolSurface) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  return jsonResponse({
    kind: opts.toolSurface.kind,
    specs: opts.toolSurface.specs.map((s) => ({
      name: s.name,
      description: s.description,
    })),
  }, 200);
}

// ── /v1/hitl/callback/:requestId ──────────────────────────────────

export async function handleHitlCallback(
  req: Request,
  requestId: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  if (!opts.hitlPending) return jsonResponse({ error: RUNTIME_NOT_WIRED }, 503);
  if (!requestId) return badRequest('missing requestId');
  let body: unknown;
  try { body = await req.json(); }
  catch { return badRequest('invalid JSON body'); }
  const answer = coerceHitlCallbackAnswer((body as { answer?: unknown })?.answer);
  if (answer === undefined) {
    return badRequest('answer must be boolean or a structured AskUserQuestion result');
  }
  const fired = opts.hitlPending.resolveAnswer(requestId, answer);
  if (!fired) return jsonResponse({ error: 'no_pending_request', requestId }, 404);
  return jsonResponse({ ok: true, requestId, answer }, 200);
}

// ── /v1/tools/runtime · /v1/tools/<id>/call ───────────────────────
//
// REST shim over the ToolRuntime registry (B 트랙 Post-Closure ·
// 2026-05-13). The MCP transports (`POST /v1/mcp` Streamable HTTP ·
// stdio `elanous mcp serve`) already expose the registry to MCP-aware
// clients, but non-MCP callers (iOS Shortcuts · shell / Makefile ·
// n8n / Zapier · webhook receivers) need plain REST.
//
// Both endpoints share the same PFC capture seam as the MCP
// transports — `emitProxyCallIntent` from `src/mcp/server.ts` tags
// each call with `origin: 'rest'` so the Patcher / KGS can
// distinguish where a tool dispatch originated.

import {
  listToolRuntimes as listRuntimeRegistry,
  getToolRuntime as getRuntimeRegistry,
} from '../../tool-runtime/registry.js';
import { emitProxyCallIntent } from '../../mcp/server.js';
import type { ToolSurface as RuntimeToolSurface } from '../../tool-runtime/types.js';

/** Parse `/v1/tools/<id>/call` → `<id>`. Returns null when the path
 *  doesn't match (so the GET-side `/v1/tools` and `/v1/tools/runtime`
 *  routes still win). Tool ids may contain dots (`xcode.build_target`)
 *  — only the trailing `/call` segment is fixed. */
export function parseRuntimeToolCallPath(pathname: string): string | null {
  const prefix = '/v1/tools/';
  const suffix = '/call';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!id || id.includes('/')) return null;
  return id;
}

/** GET /v1/tools/runtime — full ToolRuntime registry view. Each
 *  entry exposes `{ id, surface, surfaces?, description, inputSchema }`
 *  so external curl callers can discover and shape arguments without
 *  speaking JSON-RPC. Filter via `?surface=<skill|dashboard|plugin|mcp>`. */
export function handleRuntimeToolsList(
  req: Request,
  opts: MetaApiOpts,
  url: URL,
): Response {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  const surfaceParam = url.searchParams.get('surface');
  const surface = (surfaceParam ?? undefined) as RuntimeToolSurface | undefined;
  const runtimes = listRuntimeRegistry(surface);
  return jsonResponse({
    tools: runtimes.map((rt) => ({
      id: rt.id,
      surfaces: rt.surfaces,
      description: rt.spec.description,
      inputSchema: rt.spec.parameters,
    })),
  }, 200);
}

/** POST /v1/tools/<id>/call — REST shim for tool dispatch. Body
 *  shape: `{ args?: Record<string, unknown> }`. Returns
 *  `{ ok: true, result }` on success or `{ ok: false, error }` on
 *  failure (HTTP 200 for both — REST callers prefer to read `ok`
 *  rather than branch on status, and HTTP 400 is reserved for body
 *  shape errors).
 *
 *  Dispatch context uses `surface: 'mcp'` so proxy MCP runtimes (the
 *  primary external-facing surface) receive a consistent surface tag
 *  in their `_ctx` — matches `src/mcp/server.ts` behaviour. The
 *  `emitProxyCallIntent` call wires the PFC capture seam with
 *  `origin: 'rest'`. */
export async function handleRuntimeToolCall(
  req: Request,
  opts: MetaApiOpts,
  toolId: string,
): Promise<Response> {
  if (!checkAuth(req, opts)) return authFailureResponse(req, opts);
  let body: unknown;
  try { body = await req.json(); }
  catch { return badRequest('invalid JSON body'); }
  const args = (body && typeof body === 'object' && !Array.isArray(body)
    ? ((body as { args?: unknown }).args ?? {})
    : {}) as Record<string, unknown>;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return badRequest('args must be an object');
  }
  const rt = getRuntimeRegistry(toolId);
  if (!rt) {
    emitProxyCallIntent(toolId, 'rest', false, 'unknown_tool');
    return jsonResponse({ ok: false, error: `unknown tool: ${toolId}` }, 404);
  }
  try {
    const out = await rt.run(args as never, { surface: 'mcp' });
    emitProxyCallIntent(toolId, 'rest', true);
    return jsonResponse({ ok: true, result: out }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitProxyCallIntent(toolId, 'rest', false, msg);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
}
