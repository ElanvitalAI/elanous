import type { LLMToolSpec } from '../llm/tool-spec.js';
// CV-3 DM-1 — Daemon Multi-LLM dispatch bridge.
//
// Companion to `bridgeCoreTurnToAcp` (single-LLM path). When the
// inbound `session/prompt` carries `_meta.elanous.multiLlm.targets`,
// this bridge fans out N `runCoreTurn` calls in parallel — each with
// its own provider/model — and routes every chunk back via
// `turnCtx.pushWithMeta` annotated with `{ elanous: { modelId,
// provider } }` so the client (Showroom) demultiplexes per panel.
//
// File-disjoint from `core-turn-bridge.ts` by design: the legacy
// single-LLM hot path stays untouched, the multi-LLM addition is
// opt-in via the prompt's `_meta` hint, and tests can drive each
// path independently.
//
// Spec compatibility: ACP `_meta` is the standard extension point on
// every type (request, notification, content blocks). Adding a
// elanous-namespaced blob preserves wire compatibility with vanilla
// ACP clients — they simply ignore the `_meta` they don't recognise.
//
// See also: 내부 문서 `PLAN-cv-3-daemon-multi-llm-2026-05-08` (RFC v2 ·
// 13 D 결정)

import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { runCoreTurn } from '../core-turn/run-core-turn.js';
import type { CoreTurnDispatchTool } from '../core-turn/types.js';
import type { AcpServerOptions, AcpTurnContext } from './server.js';
import { DEFAULT_BRIDGE_ABORT_POLL_MS } from './core-turn-bridge.js';
import { globalDualRoleManager } from './dual-role-manager.js';
import { getOrCreatePersonaSession } from '../session/index.js';

/** DM stage 2 — per-target agent CLI session cache. Keys by `${backend}:${targetId}`
 *  so each panel reuses its own sub-process across turns. The cache is
 *  process-wide (matches globalAcpAgentManager's caching by backend+cwd). */
const _agentSessionByTargetKey = new Map<string, string>();

function agentTargetKey(backend: string, targetId: string): string {
  return `${backend}::${targetId}`;
}

/** Internal helper — agent CLI dispatch for a multi-LLM hint target.
 *  Lazy-creates a session via globalDualRoleManager, then forwards
 *  the prompt and routes update chunks back through the parent's
 *  annotate(chunk) (text) / annotateToolCall (tool_call lifecycle),
 *  both of which annotate with `_meta.elanous = { modelId, provider }`
 *  so the client demultiplexes per panel.
 *
 *  DM stage 3 FU (HANDOFF §3.2 · 2026-05-09): tool_call /
 *  tool_call_update SessionUpdate variants are now forwarded too —
 *  enables ShowroomPanel activity pill + expandable tool list (was
 *  removed when DM stage 3 routing replaced #1985 panel-local agent
 *  dispatch and the bridge filtered them as noise).
 *
 *  Aborts: when ctrl.signal fires, the caller is expected to also
 *  call agent.cancel — this helper just propagates AbortError.
 *  Sub-process lifecycle is managed by globalAcpAgentManager so we
 *  never tear down here. */
async function dispatchAgentTarget(opts: {
  target: MultiLlmTarget;
  userText: string;
  annotate: (chunk: string) => Promise<void>;
  annotateToolCall: (update: Readonly<Record<string, unknown>>) => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { target, userText, annotate, annotateToolCall, signal } = opts;
  if (!target.backend) throw new Error('agent target missing backend');
  const manager = globalDualRoleManager();
  const key = agentTargetKey(target.backend, target.id);
  let sessionId = _agentSessionByTargetKey.get(key);
  if (!sessionId) {
    const record = await manager.clientSessionCreate({
      backendId: target.backend,
      cwd: process.cwd(),
    });
    sessionId = record.id;
    _agentSessionByTargetKey.set(key, sessionId);
  }
  // Route SessionUpdate chunks through the parent's annotate path.
  // Pure routing logic lives in `routeAgentSessionUpdate` (exported
  // for unit tests · CLAUDE.md memory bans mock.module so the wider
  // dispatchAgentTarget integration path isn't unit-tested here).
  const onUpdate = (update: unknown): void => {
    routeAgentSessionUpdate(update, {
      onText: (chunk) => { void annotate(chunk); },
      onToolCall: (u) => { void annotateToolCall(u); },
    });
  };
  // Best-effort abort propagation.
  const abortListener = (): void => {
    const rec = manager.clientSessionById(sessionId!);
    if (rec) {
      void rec.agent.cancel(rec.backendSessionId).catch(() => {});
    }
  };
  if (signal.aborted) abortListener();
  else signal.addEventListener('abort', abortListener, { once: true });
  try {
    await manager.clientSessionSend({
      sessionId,
      message: userText,
      onUpdate,
    });
  } finally {
    signal.removeEventListener('abort', abortListener);
  }
}

/** Test seam — clear the per-target session cache so unit tests don't
 *  leak agent sessions between cases. */
export function _resetMultiLlmAgentSessionCacheForTest(): void {
  _agentSessionByTargetKey.clear();
}

/** DM stage 3 FU — pure router for agent CLI sub-process SessionUpdate
 *  events. Forks text chunks (`agent_message_chunk`) into `onText` and
 *  the two tool-call lifecycle variants (`tool_call`,
 *  `tool_call_update`) into `onToolCall`. Other SessionUpdate kinds
 *  (thought chunks, plan steps, …) are dropped — extension point if
 *  Showroom later wants to surface them too.
 *
 *  Exported so the routing decision is unit-testable without mocking
 *  globalDualRoleManager. */
export function routeAgentSessionUpdate(
  update: unknown,
  cb: {
    onText: (chunk: string) => void;
    onToolCall: (update: Readonly<Record<string, unknown>>) => void;
  },
): void {
  if (update === null || typeof update !== 'object') return;
  const u = update as {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
    toolCallId?: string;
  };
  if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && u.content.text) {
    cb.onText(u.content.text);
    return;
  }
  if (
    (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
    && typeof u.toolCallId === 'string'
  ) {
    cb.onToolCall(update as Readonly<Record<string, unknown>>);
  }
}

/** Wire shape for the prompt-side hint. Mirrored on the client (PWA
 *  Showroom) — the runtime helper there builds this blob and ships
 *  it as `prompt._meta.elanous.multiLlm`. */
export interface MultiLlmTarget {
  /** Stable client-side panel id (e.g. `'p-2026-05-08-3a'`). The
   *  daemon echoes this id verbatim on every `update._meta.elanous.modelId`
   *  so the client demultiplexes per panel without provider-name
   *  collisions (two panels on the same provider work). */
  id: string;
  /** Provider key — same vocabulary as the global LLM stack
   *  (`'claude'` · `'gemini'` · `'grok'` · `'codex'` · `''` for
   *  daemon default). */
  provider: string;
  /** Optional model override. When omitted, falls back to the
   *  provider's default. */
  model?: string;
  /** DM stage 2 (#1982 follow-up · agent CLI dispatch) — when
   *  `'agent'`, the bridge routes this target via
   *  `globalDualRoleManager().clientSessionSend` (real codex/claude/
   *  gemini CLI sub-process) instead of the LLM API path. Default =
   *  `'chat'` (legacy LLM API). chat panels MUST NOT set this field
   *  to `'agent'` (sanitized server-side regardless). */
  kind?: 'chat' | 'agent';
  /** DM stage 2 — agent backend id when `kind === 'agent'`. Mirrors
   *  `nexus/chat/backend-mapping.AcpBackendIdLike`. Required for
   *  agent targets, ignored for chat. */
  backend?: 'codex-app-server' | 'claude' | 'gemini';
  /** §6.4 — optional persona binding. The global PersonaRegistry
   *  (`src/persona/global-registry.ts`) is consulted at dispatch time
   *  to resolve `systemPrompt` (via `assemblePersonaPrompt`). Unknown
   *  ids resolve to no-op (base systemPrompt only · debug log surface).
   *  Persona's `brand` (when explicit) does NOT auto-coerce
   *  `target.provider` here — the client (PWA Showroom) is responsible
   *  for that synchronization (Hybrid lock semantic · §6.4 Q3). */
  personaId?: string;
  /** DM stage 4 (2026-05-09 night) — the panel's last assistant turn,
   *  forwarded by the client when `historyMode === 'mixed'`. Sibling
   *  targets see this as a `<prior_answer model=X>` block prepended
   *  to the current user prompt; the target's own `lastAssistant` is
   *  ignored (each model already has its own thread). Client-managed
   *  history (matches DM-1's stateless-on-multi-LLM design). */
  lastAssistant?: string;
}

export interface MultiLlmHint {
  targets: readonly MultiLlmTarget[];
  /** P3 follow-up — when `'mixed'`, a target's seeded messages will
   *  include prior assistant turns from sibling targets (cross-model
   *  context · DM-3 phase). MVP default = `'isolated'` (each target
   *  only sees its own thread). */
  historyMode?: 'isolated' | 'mixed';
}

/** Pull the multi-LLM hint off a `promptMeta` blob, with type guards.
 *  Returns `null` when the hint is absent OR malformed (single-LLM
 *  legacy path). Exported so callers (`createDaemonRunTurn` wrappers)
 *  can sniff before deciding which bridge to invoke. */
export function readMultiLlmHint(
  promptMeta: Readonly<Record<string, unknown>> | undefined,
): MultiLlmHint | null {
  const elanous = (promptMeta?.elanous ?? null) as
    | { multiLlm?: unknown }
    | null;
  const raw = elanous?.multiLlm as
    | { targets?: unknown; historyMode?: unknown }
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const targets = raw.targets;
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const cleanTargets: MultiLlmTarget[] = [];
  for (const t of targets) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0) continue;
    if (typeof rec.provider !== 'string') continue;
    // Phase 2 (RFC #2161 · 2026-05-10) — normalize wire's
    // `target.provider` through Layer A alias map. PWA Showroom + DM
    // pre-Phase-2 sometimes shipped 'claude' (UI-friendly label); the
    // bridge needs the canonical id ('anthropic') for downstream
    // routing. Falls through to raw value on miss so a typo surfaces
    // at the dispatch layer (not silently swallowed).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { normalizeProviderId } = require('../registry/normalize.js') as {
      normalizeProviderId: (s: string | null | undefined) => string | null;
    };
    const provider = normalizeProviderId(rec.provider) ?? rec.provider;
    const target: MultiLlmTarget = { id: rec.id, provider };
    if (typeof rec.model === 'string' && rec.model.length > 0) {
      target.model = rec.model;
    }
    // DM stage 2 — sniff agent kind + backend. Unknown values silently
    // drop to chat (defensive: client could ship malformed hint).
    if (rec.kind === 'agent') {
      const b = rec.backend;
      if (b === 'codex-app-server' || b === 'claude' || b === 'gemini') {
        target.kind = 'agent';
        target.backend = b;
      }
    }
    // §6.4 — sniff personaId. Trim + length cap defensive against
    // malformed clients. Unknown ids surface at lookup time (caller
    // resolves via PersonaRegistry).
    if (typeof rec.personaId === 'string') {
      const pid = rec.personaId.trim();
      if (pid.length > 0 && pid.length < 256) target.personaId = pid;
    }
    // DM stage 4 — sniff lastAssistant. Empty/missing OK (target may
    // be on its very first turn). Hard cap at 32KB to prevent a
    // pathological client from blowing up the context window — the
    // sibling text is meant for terse "last reply" injection, not
    // wholesale history.
    if (typeof rec.lastAssistant === 'string') {
      const text = rec.lastAssistant;
      if (text.length > 0 && text.length <= 32 * 1024) {
        target.lastAssistant = text;
      }
    }
    cleanTargets.push(target);
  }
  if (cleanTargets.length === 0) return null;
  const hint: MultiLlmHint = { targets: cleanTargets };
  if (raw.historyMode === 'mixed' || raw.historyMode === 'isolated') {
    hint.historyMode = raw.historyMode;
  }
  return hint;
}

/** Per-target seed callback. Multi-LLM hint dispatch builds an
 *  independent seed per target (D10 isolated default — each panel
 *  sees only its own thread). DM-3 (mixed history) will introduce a
 *  variant that mixes sibling histories. */
export interface MultiLlmGetMessagesCtx {
  sessionId: string;
  userText: string;
  promptBlocks: AcpTurnContext['promptBlocks'];
  promptMeta: AcpTurnContext['promptMeta'];
  target: MultiLlmTarget;
  /** All targets for the same prompt. DM-3 `'mixed'` history will
   *  consult this to seed cross-target context; DM-1 ignores it. */
  allTargets: readonly MultiLlmTarget[];
  historyMode: 'isolated' | 'mixed';
}

/** Per-target tool catalog. D10 isolated default — each target may
 *  have its own surface (e.g. a "thinker" panel without write tools).
 *  When the host returns the same array shape for every target it
 *  collapses to the single-LLM path semantics. */
export interface MultiLlmGetToolsCtx {
  sessionId: string;
  userText: string;
  target: MultiLlmTarget;
}

export interface MultiLlmCoreTurnDeps {
  /** Per-target message seed. */
  getMessages: (
    ctx: MultiLlmGetMessagesCtx,
  ) => LLMMessage[] | Promise<LLMMessage[]>;
  /** Per-target tool catalog. */
  getTools: (
    ctx: MultiLlmGetToolsCtx,
  ) => LLMToolSpec[] | Promise<LLMToolSpec[]>;
  /** Tool dispatcher — same contract as single-LLM path. The
   *  per-target `_meta` is forwarded via the dispatchTool's ctx so a
   *  single tool surface can route per panel if desired. */
  dispatchTool: CoreTurnDispatchTool;
  /** Per-target turn-complete hook. Hosts persist into history with
   *  the `target.id` / `target.provider` annotation so subsequent
   *  isolated-mode turns can rebuild the per-panel thread. */
  onTurnComplete?: (ctx: {
    sessionId: string;
    target: MultiLlmTarget;
    newMessages: LLMMessage[];
  }) => void | Promise<void>;
  /** Optional poll cadence override (mirrors core-turn-bridge). */
  abortPollMs?: number;
}

/** Compose a `runTurn` handler that dispatches to N parallel
 *  `runCoreTurn` calls when the inbound prompt carries the multi-LLM
 *  hint. When the hint is absent, the handler returns immediately —
 *  callers MUST chain a single-LLM bridge for the legacy path
 *  (see `createDaemonMultiLlmRunTurn` for the canonical composition).
 *
 *  Failure isolation: each target runs under its own AbortController.
 *  An abort on the parent ACP turn (sessionId-level) cancels every
 *  child. A failure inside one `runCoreTurn` is captured per
 *  Promise.allSettled — sibling targets keep streaming.
 *
 *  Annotation contract: every chunk this bridge emits via
 *  `pushWithMeta` carries `_meta.elanous = { modelId: target.id,
 *  provider: target.provider }`. The client filters per `modelId` to
 *  drive its own panel UI. */
export function bridgeMultiLlmCoreTurnsToAcp(
  deps: MultiLlmCoreTurnDeps,
): NonNullable<AcpServerOptions['runTurn']> {
  const pollMs = deps.abortPollMs ?? DEFAULT_BRIDGE_ABORT_POLL_MS;
  return async (turnCtx: AcpTurnContext): Promise<void> => {
    const hint = readMultiLlmHint(turnCtx.promptMeta);
    if (!hint) {
      // Bridge is multi-LLM only. Caller composes legacy fallback.
      debug.log('acp.multi-llm', 'no-hint.skip', {
        sessionId: turnCtx.sessionId,
      });
      return;
    }
    const historyMode = hint.historyMode ?? 'isolated';
    debug.log('acp.multi-llm', 'dispatch.start', {
      sessionId: turnCtx.sessionId,
      targets: hint.targets.length,
      providers: hint.targets.map((t) => t.provider),
      historyMode,
    });

    const ctrl = new AbortController();
    const poll = setInterval(() => {
      if (turnCtx.isAborted() && !ctrl.signal.aborted) ctrl.abort();
    }, pollMs);
    (poll as unknown as { unref?: () => void }).unref?.();

    try {
      const settled = await Promise.allSettled(
        hint.targets.map(async (target) => {
          const targetSessionId = target.personaId
            ? getOrCreatePersonaSession(target.personaId, { source: 'pwa', transport: 'acp' }).id
            : turnCtx.sessionId;
          const meta: Record<string, unknown> = {
            elanous: { modelId: target.id, provider: target.provider },
          };
          const annotate = (chunk: string) => turnCtx.pushWithMeta(chunk, meta);
          // DM stage 3 FU — forward agent CLI sub-process tool_call /
          // tool_call_update SessionUpdate verbatim, with the same
          // `_meta.elanous = { modelId, provider }` annotation so the
          // Showroom client demultiplexes per panel and renders the
          // activity pill + expandable tool list.
          const annotateToolCall = (
            update: Readonly<Record<string, unknown>>,
          ): Promise<void> => turnCtx.pushSessionUpdate(update, meta);
          // DM stage 2 (#1982 follow-up) — agent CLI dispatch via
          // globalDualRoleManager. Skip the LLM-API runCoreTurn flow
          // entirely. Per-target session is created/reused on the
          // first invocation; subsequent broadcasts reuse the cached
          // sub-process.
          if (target.kind === 'agent' && target.backend) {
            try {
              await dispatchAgentTarget({
                target,
                userText: turnCtx.userText,
                annotate,
                annotateToolCall,
                signal: ctrl.signal,
              });
              await turnCtx.pushWithMeta('', {
                elanous: {
                  modelId: target.id,
                  provider: target.provider,
                  stopReason: ctrl.signal.aborted ? 'cancelled' : 'end_turn',
                },
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await turnCtx.pushWithMeta('', {
                elanous: {
                  modelId: target.id,
                  provider: target.provider,
                  stopReason: 'error',
                  error: errMsg,
                },
              });
              debug.log('acp.multi-llm', 'agent-target.error', {
                sessionId: turnCtx.sessionId,
                targetId: target.id,
                backend: target.backend,
                error: errMsg.slice(0, 200),
              }, { level: 'error' });
              throw err;
            }
            return;
          }
          try {
            const messages = await Promise.resolve(
              deps.getMessages({
                sessionId: targetSessionId,
                userText: turnCtx.userText,
                promptBlocks: turnCtx.promptBlocks,
                promptMeta: turnCtx.promptMeta,
                target,
                allTargets: hint.targets,
                historyMode,
              }),
            );
            const tools = await Promise.resolve(
              deps.getTools({
                sessionId: targetSessionId,
                userText: turnCtx.userText,
                target,
              }),
            );
            await runCoreTurn({
              sessionId: turnCtx.sessionId,
              userText: turnCtx.userText,
              messages,
              tools,
              dispatchTool: deps.dispatchTool,
              signal: ctrl.signal,
              ...(target.model !== undefined ? { modelOverride: target.model } : {}),
              callbacks: {
                onText: (delta) => {
                  // Fire-and-forget — pushWithMeta is async but
                  // ordering is preserved by the SDK serialization.
                  void annotate(delta);
                },
                onTurnComplete: async (newMessages) => {
                  if (deps.onTurnComplete) {
                    await deps.onTurnComplete({
                      sessionId: turnCtx.sessionId,
                      target,
                      newMessages,
                    });
                  }
                },
              },
            });
          } catch (err) {
            // Surface a per-target stop so the client can tear down
            // the panel placeholder. D13 — modelId-scoped stopReason
            // in `_meta.elanous.stopReason`.
            const errMsg = err instanceof Error ? err.message : String(err);
            await turnCtx.pushWithMeta('', {
              elanous: {
                modelId: target.id,
                provider: target.provider,
                stopReason: 'error',
                error: errMsg,
              },
            });
            debug.log('acp.multi-llm', 'target.error', {
              sessionId: turnCtx.sessionId,
              targetId: target.id,
              provider: target.provider,
              error: errMsg.slice(0, 200),
            }, { level: 'error' });
            throw err;
          }
          // Per-target end-of-turn marker (D13). Empty chunk + meta
          // tells the client the panel finished cleanly.
          await turnCtx.pushWithMeta('', {
            elanous: {
              modelId: target.id,
              provider: target.provider,
              stopReason: ctrl.signal.aborted ? 'cancelled' : 'end_turn',
            },
          });
        }),
      );
      const ok = settled.filter((s) => s.status === 'fulfilled').length;
      const fail = settled.length - ok;
      debug.log('acp.multi-llm', 'dispatch.done', {
        sessionId: turnCtx.sessionId,
        ok,
        fail,
      });
    } finally {
      clearInterval(poll);
    }
  };
}
