// UI-Core arc Phase U3c Step 2 — dashboard ACP client boot composer.
//
// Boots a `DashboardSession` that wraps an in-process ACP server +
// client pair, giving the dashboard a way to send prompts through the
// same code path the Web / iPhone clients will eventually use. Phase 4
// flipped individual turn-event sites (renderStreaming, tool render
// blocks, usage recording) onto `.send(...)` one at a time; Phase 5c
// (2026-04-25) retired the legacy direct path entirely — every
// dashboard turn now routes through the in-process ACP pair.
//
// Research contract (내부 문서 `RESEARCH-u3c-dashboard-turn-event-fanout`
// §5):
//   • Getter injection — every dashboard read (history, tools,
//     dispatch) happens at turn-start, not closure-capture, so the
//     9-dep tool runtime + autoCompact rewrites don't hand the bridge
//     a stale snapshot.
//
// This module sits in `src/dashboard/` (not `src/tui-client/`)
// because it imports dashboard-specific types (ChatMessage, tool
// runtime, history store) that the headless core must never see.
// The static headless-guard test continues to enforce that boundary
// by scanning `src/tui-client/` — this composer is dashboard-side
// wiring and deliberately excluded from that scan.

import type { ChatMessage } from '../chat/index.js';
import type { LLMMessage, LLMToolSpec } from '../llm.js';
import type { CoreTurnDispatchTool } from '../core-turn/index.js';
import {
  DashboardSession,
  type DashboardRequestPermissionHandler,
  type DashboardSessionOptions,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '../tui-client/dashboard-session.js';
import type { AcpTransportConnection } from '../acp/transport/index.js';
import { debug } from '../debug/log.js';
import { recordDashboardToolCatalog } from './tool-catalog-observability.js';

type DashboardAcpBootBranch = 'remote-daemon' | 'in-process';

function recordDashboardAcpBootBranch(
  branch: DashboardAcpBootBranch,
  dispatcherAttached: boolean,
): void {
  try {
    debug.log('dashboard.acp', 'boot-branch-selected', { branch, dispatcherAttached });
  } catch {
    // Observability must not prevent the dashboard from booting.
  }
}

function recordDashboardAcpBootOutcome(result: DashboardAcpBootResult): void {
  const sessionId = result.sessionId ?? result.session.id;
  try {
    debug.log('dashboard.acp', 'boot-session-established', {
      mode: result.mode,
      sessionIdPresent: sessionId.length > 0,
    });
    if (debug.enabled) {
      debug.log('dashboard.acp', 'boot-session-detail', {
        mode: result.mode,
        sessionId,
        resumedFromSession: result.mode === 'resumed',
        resumeFallback: result.resumeFallbackReason !== undefined,
      });
    }
  } catch {
    // Observability must not prevent the dashboard from booting.
  }
}

/** Composer input — every field a getter so the bridge reads fresh
 *  state each turn. See research §5.1 for the rationale: closures
 *  over dashboard history / tool catalog / 9-dep dispatcher all
 *  race with autoCompact history rewrites and per-turn runtime dep
 *  mutations. */
export interface DashboardAcpBootDeps {
  /** M2.4 — remote daemon target. When set, the dashboard's session
   *  attaches to a remote ACP server over WebSocket instead of booting
   *  an in-process server. Tool dispatch + history live on the daemon
   *  side, so the dashboard's `getTools`/`dispatchTool`/`getMessages`
   *  callbacks become unused — the daemon's `runTurn` owns those.
   *  `getCwd()` is still consulted to populate `newSession(cwd)`. */
  remote?: { url: string; token?: string; label?: string };
  /** Tier 1 daemon-resume — when set together with `remote`,
   *  the boot flips from `DashboardSession.attach()`
   *  (which mints a new sessionId) to `attachExisting({sessionId})`
   *  (which calls ACP `session/load` so the daemon's existing
   *  history is reused). The daemon must advertise
   *  `loadSession:true` (elanous daemons do, post-M2.3) and have the
   *  id in its `hasSession` ledger; otherwise the load throws and
   *  the caller falls back to a fresh session.
   *
   *  Driven by the `--resume <id>` CLI flag or
   *  `ELANOUS_RESUME_SESSION` env (resolved in `main()`). Has no
   *  effect when `remote` is not set —
   *  in-process resume goes through the existing TUI session
   *  store (`/session load`), not this path. */
  resumeSessionId?: string;
  /** Session working-directory, reported in ACP `newSession(cwd)`. */
  getCwd(): string;
  /** Chat history (assistant/user/tool blocks) at turn start. The
   *  composer prepends preamble + appends the current user text. */
  getChatHistory(): readonly ChatMessage[];
  /** System-prompt preamble (plan-mode / ask / approval / sandbox /
   *  git / impl-discipline / conciseness). Rebuilt per turn by the
   *  caller; returning `[]` is valid.
   *
   *  Phase 5a — receives `{ userText }` so the caller can reuse the
   *  dashboard's per-turn impl-discipline + surface guidance builders
   *  (both branch on user text). */
  getPreamble(ctx: { sessionId: string; userText: string }): readonly LLMMessage[];
  /** Current turn's tool catalog (tier-split active set). Return `[]`
   *  for text-only turns; the bridge falls through to plain
   *  streamLLM.
   *
   *  Phase 5a — receives `{ userText }` so the caller can drive
   *  `buildSessionRuntimeToolSpecs` (intent-based tool-family
   *  selection) directly from this getter. */
  getTools(ctx: { userText: string }): readonly LLMToolSpec[];
  /** Active model identifier — surfaced via `resolveModel`. `null`
   *  defers to the LLM provider's default. */
  getActiveModel(ctx: { userText: string }): string | null;
  /** 9-dep tool dispatcher — typically a wrapper around
   *  `dispatchSessionRuntimeTool`. Must never capture a closure over
   *  stale runtime deps; rebuild each turn from current dashboard
   *  state. */
  dispatchTool: CoreTurnDispatchTool;
  /** Persistence hook — called with the messages the turn
   *  accumulated (assistant text + tool_use + user tool_result
   *  blocks). Dashboard stashes this into its history store so the
   *  next turn sees real tool evidence. */
  pushTurnToolHistory(messages: readonly LLMMessage[]): void;
  /** Optional: agent name/version piped into the ACP handshake. */
  agentName?: string;
  agentVersion?: string;
  /** F1 — approval gateway. Called when the ACP server emits
   *  `requestPermission` (e.g. future Web/iPhone clients, or Phase 4
   *  tool dispatchers that route through the bridge). Receives the
   *  toolName (pulled from `toolCall.title`) + raw input and returns
   *  a boolean. Default maps every request to a single generic
   *  "Approve {toolName}?" prompt via the caller-provided gateway. */
  approvalGateway?: (ctx: {
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => Promise<boolean>;
}

/** Outcome of a daemon-attach boot. Mirrors `DashboardSession` plus
 *  metadata callers use to render the resume status (success / fall-
 *  back to new / partial). Non-resume boots still return `kind:
 *  'attached'` so the caller can branch uniformly. */
export interface DashboardAcpBootResult {
  session: DashboardSession;
  /** 'resumed' = attachExisting succeeded · 'new' = attach() (default
   *  or fallback after a failed resume) · 'in-process' = local pair. */
  mode: 'resumed' | 'new' | 'in-process';
  /** When mode='resumed', the sessionId the dashboard is now bound to.
   *  When 'new' (after resume fallback), the freshly-minted id (so
   *  callers can surface "started a new session instead"). */
  sessionId?: string;
  /** When the resume attempt failed and we fell back to a new
   *  session, the error message for surfacing to the user. */
  resumeFallbackReason?: string;
}

/** Boot a dashboard-owned `DashboardSession`. Two paths:
 *    - `deps.remote` set → M2.4 thin attach over WebSocket
 *    - otherwise         → in-process ACP server + client pair (default)
 *  The remote branch uses `DashboardSession.attach` with the gateway
 *  forwarded. The returned handle stays hot for the dashboard's lifetime — `close()`
 *  tears down the local pair (or drops the daemon connection while
 *  the daemon survives).
 *
 *  Tier 1 daemon-resume — when `deps.resumeSessionId` is set together
 *  with `deps.remote`, the boot calls `attachExisting()` instead
 *  of `attach()`. On daemon-side `loadSession` failure (unknown id,
 *  capability missing) the boot logs + transparently falls back to
 *  `attach()` so the user gets a working session even with a stale
 *  resume id. */
export async function bootDashboardAcpSession(
  deps: DashboardAcpBootDeps,
): Promise<DashboardAcpBootResult> {
  const gateway0 = deps.approvalGateway;
  const onPerm = gateway0
    ? { onRequestPermission: createDefaultRequestPermissionHandler(gateway0) }
    : {};

  if (deps.remote) {
    recordDashboardAcpBootBranch('remote-daemon', false);
    // M2.4 — thin remote attach: WS conn → DashboardSession.{attach,
    // attachExisting}. Tool dispatch + history live on the daemon
    // side so getTools / dispatchTool / getMessages are not wired
    // in this branch.
    const { connectWebSocketClient } = await import(
      '../tui-client/acp-transport-ws-client.js'
    );
    const result = await attachWithOptionalResume({
      cwd: deps.getCwd(),
      resumeSessionId: deps.resumeSessionId,
      onPerm,
      connect: () =>
        connectWebSocketClient({
          url: deps.remote!.url,
          ...(deps.remote!.token ? { token: deps.remote!.token } : {}),
          ...(deps.remote!.label ? { label: deps.remote!.label } : {}),
        }),
    });
    recordDashboardAcpBootOutcome(result);
    return result;
  }

  recordDashboardAcpBootBranch('in-process', true);
  const gateway = deps.approvalGateway;
  const opts: DashboardSessionOptions = {
    cwd: deps.getCwd(),
    getMessages: ({ sessionId, userText }) => buildTurnMessages(deps, sessionId, userText),
    getTools: ({ sessionId, userText }) => {
      const tools = [...deps.getTools({ userText })];
      recordDashboardToolCatalog(sessionId, tools);
      return tools;
    },
    dispatchTool: deps.dispatchTool,
    onTurnComplete: ({ newMessages }) => {
      deps.pushTurnToolHistory(newMessages);
    },
    resolveModel: ({ userText }) => {
      const model = deps.getActiveModel({ userText });
      return model ?? undefined;
    },
    ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
    ...(deps.agentVersion !== undefined ? { agentVersion: deps.agentVersion } : {}),
    ...(gateway
      ? { onRequestPermission: createDefaultRequestPermissionHandler(gateway) }
      : {}),
  };

  const result: DashboardAcpBootResult = {
    session: await DashboardSession.create(opts),
    mode: 'in-process',
  };
  recordDashboardAcpBootOutcome(result);
  return result;
}

// ─── Tier 1 daemon-resume helpers ────────────────────────────────

/** Remote daemon attach path. When `resumeSessionId` is set, calls
 *  `DashboardSession.attachExisting()` so the daemon's prior turns are
 *  preserved. Falls back to fresh `attach()` on any failure (unknown
 *  id · loadSession unsupported · transport hiccup) so the user always
 *  gets a working session — the resume failure surfaces back through
 *  the result so the caller can render a one-line warning. */
async function attachWithOptionalResume(args: {
  cwd: string;
  resumeSessionId?: string;
  onPerm: { onRequestPermission?: DashboardRequestPermissionHandler };
  connect: () => Promise<AcpTransportConnection>;
}): Promise<DashboardAcpBootResult> {
  // Resume attempt — try attachExisting first, but if it throws we
  // need a FRESH connection for the fallback `attach()` (the
  // attachExisting closes its conn on failure).
  if (args.resumeSessionId) {
    try {
      const conn = await args.connect();
      const session = await DashboardSession.attachExisting({
        sessionId: args.resumeSessionId,
        conn,
        cwd: args.cwd,
        ...args.onPerm,
      });
      return { session, mode: 'resumed', sessionId: args.resumeSessionId };
    } catch (err) {
      // Fall through to fresh attach — the resume id was bad but the
      // user shouldn't lose the dashboard. Track the reason so the
      // caller can surface it.
      const reason = err instanceof Error ? err.message : String(err);
      const conn = await args.connect();
      const session = await DashboardSession.attach({
        conn,
        cwd: args.cwd,
        ...args.onPerm,
      });
      return {
        session,
        mode: 'new',
        sessionId: session.id,
        resumeFallbackReason: reason,
      };
    }
  }
  const conn = await args.connect();
  const session = await DashboardSession.attach({
    conn,
    cwd: args.cwd,
    ...args.onPerm,
  });
  return {
    session,
    mode: 'new',
    sessionId: session.id,
  };
}

/** Build a daemon HTTP base from the `remote.url` ACP WebSocket URL.
 *  Replaces `ws://` → `http://`, `wss://` → `https://`, and drops the
 *  `/v1/acp` suffix so callers can append `/v1/sessions/:id` etc.
 *  Returns null when the input doesn't match (caller skips REST
 *  features gracefully). Exported so `src/dashboard/index.ts` can
 *  reuse the same conversion when fetching daemon history / list. */
export function deriveDaemonHttpBase(wsUrl: string): string | null {
  let url: URL;
  try { url = new URL(wsUrl); }
  catch { return null; }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Strip a trailing /v1/acp segment (the dashboard's WS path) so the
  // base is suitable for `${base}/v1/sessions/:id`. Anything else is
  // left intact — callers expect to append from this base.
  const path = url.pathname.replace(/\/v1\/acp\/?$/, '');
  url.pathname = path;
  // Drop any trailing slash so concatenation is clean.
  return url.toString().replace(/\/$/, '');
}

/** Tier 1 web client also uses these — exported for reuse from the
 *  dashboard's /session list merge + boot-time history replay. Both
 *  return null on shape failure (caller logs + skips). */
export interface DaemonSessionSummary {
  id: string;
  msgCount: number;
  lastTurnAt: string;
}

export async function fetchDaemonSessionList(
  httpBase: string,
  token?: string,
): Promise<DaemonSessionSummary[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const r = await fetch(`${httpBase}/v1/sessions`, { headers });
    if (!r.ok) return null;
    const body = await r.json() as { sessions?: DaemonSessionSummary[] };
    return body.sessions ?? null;
  } catch { return null; }
}

export async function fetchDaemonSessionHistory(
  httpBase: string,
  sessionId: string,
  token?: string,
): Promise<LLMMessage[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const r = await fetch(
      `${httpBase}/v1/sessions/${encodeURIComponent(sessionId)}`,
      { headers },
    );
    if (!r.ok) return null;
    const body = await r.json() as { messages?: LLMMessage[] };
    return body.messages ?? null;
  } catch { return null; }
}

/** F1 — build the default `RequestPermission` handler that maps an
 *  inbound ACP permission request to the caller-provided boolean
 *  `approvalGateway` (typically a wrapper around the dashboard's
 *  existing approver factory). Response picks the first option whose
 *  kind matches the boolean verdict (`allow_once` for true,
 *  `reject_once` for false); if the options list omits the expected
 *  kind, the first option wins — callers that want richer semantics
 *  override this by supplying their own handler upstream. */
export function createDefaultRequestPermissionHandler(
  gateway: (ctx: { toolName: string; toolArgs: Record<string, unknown> }) => Promise<boolean>,
): DashboardRequestPermissionHandler {
  return async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const toolName = typeof req.toolCall.title === 'string' ? req.toolCall.title : '';
    const toolArgs = (req.toolCall.rawInput as Record<string, unknown> | undefined) ?? {};
    let approved = false;
    try {
      approved = await gateway({ toolName, toolArgs });
    } catch {
      // Gateway error → safe default (reject)
      approved = false;
    }
    const preferredKind = approved ? 'allow_once' : 'reject_once';
    const options = req.options as PermissionOption[];
    const chosen = options.find((o) => o.kind === preferredKind) ?? options[0];
    if (!chosen) return { outcome: { outcome: 'cancelled' as const } };
    return {
      outcome: {
        outcome: 'selected' as const,
        optionId: chosen.optionId,
      },
    };
  };
}

/** Build the messages array the bridge passes to `runCoreTurn`.
 *  Shape matches the dashboard's `buildRequestMessages` flow at
 *  `src/dashboard/index.ts:19546` — preamble (system messages) +
 *  prior history + new user text. Dashboard-side history already
 *  contains the latest user message for the direct path, so this
 *  helper does NOT append another one; callers that haven't stored
 *  the user message yet should do so before invoking `.send()`. */
function buildTurnMessages(
  deps: DashboardAcpBootDeps,
  sessionId: string,
  userText: string,
): LLMMessage[] {
  const preamble = [...deps.getPreamble({ sessionId, userText })];
  const history = [...deps.getChatHistory()] as unknown as LLMMessage[];
  // If the caller already appended the current user text to history,
  // the last entry IS `{ role:'user', content: userText }` and we
  // don't need to re-add. This mirrors the dashboard's current flow
  // where `chat.history.push(userMsg)` runs BEFORE streamLLMWithTools.
  const last = history[history.length - 1];
  const hasTrailingUser = last?.role === 'user'
    && typeof last.content === 'string'
    && last.content.includes(userText);
  if (hasTrailingUser) {
    return [...preamble, ...history];
  }
  return [
    ...preamble,
    ...history,
    { role: 'user', content: userText },
  ];
}
