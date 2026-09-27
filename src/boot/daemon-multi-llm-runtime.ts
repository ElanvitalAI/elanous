// CV-3 DM-1 — Daemon multi-LLM runtime composer.
//
// File-disjoint partner of `createDaemonRunTurn` (single-LLM legacy
// path · `daemon-runtime.ts:445`). Sniffs the inbound prompt for the
// `_meta.elanous.multiLlm` hint:
//   - hint present → dispatch via `bridgeMultiLlmCoreTurnsToAcp`
//     (parallel `runCoreTurn` per target · update._meta.elanous.modelId
//     annotation per chunk · D13 stopReason in trailing chunk).
//   - hint absent → fall through to the legacy single-LLM bridge so
//     vanilla ACP clients (every existing chat / webterm peer) keep
//     their current behaviour. backwards compat = 100% (D7).
//
// MVP scope (D4 + DM-1 minimum):
//   - history is *client-managed* on the multi-LLM path. Each panel
//     of Showroom sends its own per-target history seed inline as part
//     of `_meta.elanous.multiLlm.targets[i].messages` (optional · falls
//     back to fresh seed when absent). Daemon stays stateless on the
//     multi-LLM channel — DM-3 (mixed history) revisits with a
//     daemon-side store for cross-target context.
//   - `onTurnComplete` receives the `target` so callers may persist
//     model-annotated turns into their own ledger. The default ledger
//     (`DaemonSessionHistory`) does NOT branch yet — that's a
//     follow-up (DM-2 client-side decoder is the user-visible value
//     gate; DM-3 unlocks server-side mixed history).
//
// See: 내부 문서 `PLAN-cv-3-daemon-multi-llm-2026-05-08` (RFC v2 · 13 D)

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { notifyDaemonActivity } from '../dispatch/idle-detector.js';
import {
  composeDaemonSystemPrompt,
  createDaemonRunTurn,
  createDaemonBootToolCwdResolver,
  type DaemonRuntimeOpts,
  type DaemonSessionHistory,
} from './daemon-runtime.js';
import {
  bridgeMultiLlmCoreTurnsToAcp,
  readMultiLlmHint,
  type MultiLlmGetMessagesCtx,
  type MultiLlmTarget,
} from '../acp/multi-llm-bridge.js';
import { toolSurface } from './daemon-tools/index.js';
import { createToolCwdResolver, type ToolCwdResolver } from './tool-cwd.js';
import type { AcpServerOptions, AcpTurnContext } from '../acp/server.js';
import { getGlobalPersonaRegistry } from '../persona/global-registry.js';
import { assemblePersonaPrompt } from '../persona/prompt-assembler.js';

/** Build a `runTurn` handler that fans into the multi-LLM bridge when
 *  the prompt's `_meta` carries the hint, and chains through to the
 *  legacy single-LLM bridge otherwise.
 *
 *  Composition is intentionally additive — the multi-LLM bridge
 *  exits silently when the hint is absent (`readMultiLlmHint → null`),
 *  letting this wrapper fall through to the legacy bridge without
 *  duplicating either implementation. */
export function createDaemonMultiLlmRunTurn(
  history: DaemonSessionHistory,
  opts: DaemonRuntimeOpts = {},
  toolCwdResolver = createDaemonBootToolCwdResolver(opts, opts.tools ?? 'none'),
): NonNullable<AcpServerOptions['runTurn']> {
  // Legacy single-LLM bridge (used when no multiLlm hint). Both paths share
  // one resolver so cwd validation runs once while write worktrees stay lazy.
  const legacyRunTurn = createDaemonRunTurn(history, opts, toolCwdResolver);

  // Tool surface — same surface as the legacy path (D10 isolated tool
  // sharing means each target sees the same surface but invokes its
  // own dispatchTool calls; nothing is shared across targets).
  const surface = toolSurface(opts.tools ?? 'none');
  const turnToolCwd = new AsyncLocalStorage<ToolCwdResolver>();

  // Multi-LLM bridge — fans out N runCoreTurn per target.
  const multiBridge = bridgeMultiLlmCoreTurnsToAcp({
    getMessages: (ctx: MultiLlmGetMessagesCtx) => {
      // §5-③ Phase D — a user prompt on the daemon path is activity;
      // reset the continuation scheduler's idle window so it pauses while
      // the operator is active. (Continuation turns use a separate path
      // and never reach here, so the loop can't reset its own idle.)
      notifyDaemonActivity('acp');
      return buildMessagesForTarget(ctx, opts);
    },
    getTools: () => surface.specs,
    dispatchTool: async (name, args, ctx) => {
      const ctrl = new AbortController();
      const resolver = turnToolCwd.getStore() ?? toolCwdResolver;
      const dispatchCtx: import('./daemon-tools/types.js').DaemonToolDispatchCtx = {
        cwd: resolver.cwd!,
        resolveWriteCwd: resolver.resolveWriteCwd,
        signal: ctrl.signal,
        // Elanous's own LLM assembles tool arguments from natural language.
        entry: 'elanous-apparatus',
      };
      if (ctx?.sessionId) dispatchCtx.sessionId = ctx.sessionId;
      // PLAN-ios-rich-dev-feedback-hydrate M1-S (ACP-path · 2026-05-13) —
      // multi-LLM 동족 wire (sibling to daemon-runtime.ts:createDaemonRunTurn).
      // Showroom 의 multi-LLM 동시 호출 시에도 각 target 의 tool envelope 가
      // 같은 sessionId 의 모든 peer (iOS · PWA · TUI) 에게 broadcast.
      if (ctx?.sessionId) {
        const { getActiveAcpFeedbackBroadcaster } = require('../acp/server.js') as
          typeof import('../acp/server.js');
        const broadcast = getActiveAcpFeedbackBroadcaster();
        if (broadcast) {
          const sid = ctx.sessionId;
          dispatchCtx.emitFeedback = (env) => { void broadcast(sid, env); };
        }
      }
      return surface.dispatch(name, args, dispatchCtx);
    },
    // DM-1 minimum: do not persist multi-LLM turns into the central
    // history (each target would otherwise stomp the legacy single-
    // assistant slot). DM-3 introduces a target-aware ledger; for now
    // the client (Showroom) keeps per-panel history in client state.
    // onTurnComplete intentionally omitted.
  });

  return async (turnCtx: AcpTurnContext): Promise<void> => {
    const hint = readMultiLlmHint(turnCtx.promptMeta);
    if (!hint) {
      await legacyRunTurn(turnCtx);
      return;
    }
    if (opts.acpSessionCwd) {
      const resolver = createToolCwdResolver({ tools: opts.tools ?? 'none', toolCwd: turnCtx.cwd });
      await turnToolCwd.run(resolver, () => multiBridge(turnCtx));
    } else {
      await multiBridge(turnCtx);
    }
  };
}

/** Per-target message seed builder.
 *
 *  D4 isolated default — when the prompt's `_meta.elanous.multiLlm`
 *  carries an inline `messages` array per target, that wins (client-
 *  managed history). Otherwise we seed a single-turn conversation
 *  with the target's user prompt under a shared system prompt.
 *
 *  DM stage 4 (2026-05-09 night) — when `historyMode === 'mixed'`,
 *  sibling targets' `lastAssistant` (their last reply, supplied by
 *  the client) is prepended to the current target's user prompt as
 *  `<prior_answer model="X" provider="Y">…</prior_answer>` blocks.
 *  This automates cross-model deliberation without requiring the
 *  user to manually promote each turn (DM-3 chip flow stays usable
 *  on top — the two are additive). */
function buildMessagesForTarget(
  ctx: MultiLlmGetMessagesCtx,
  opts: DaemonRuntimeOpts,
): LLMMessage[] {
  const baseSystemPrompt = composeDaemonSystemPrompt(
    opts.systemPrompt,
    ctx.promptMeta,
    ctx.sessionId,
  );
  // §6.4 — persona binding. When the target carries `personaId`, look
  // it up in the global PersonaRegistry and prepend its systemPrompt
  // to the base via `assemblePersonaPrompt` (persona identity first,
  // base operational instructions after). Unknown id = base only +
  // debug log (no error · client may ship a stale id after rename).
  const composedSystemPrompt = applyPersonaSystemPrompt(
    ctx.target.personaId,
    baseSystemPrompt ?? '',
  );
  // DM-2 wire seam — when the client ships an inline per-target
  // history we honour it verbatim. DM-1 server-only deployments
  // (smoke / golden-path tests) seed a fresh single-turn conversation.
  // (Inline history bypasses mixed-mode injection — it's a manual
  // override path; mixed mode operates on the userText fallback path.)
  const inline = (ctx.target as MultiLlmTarget & { messages?: unknown }).messages;
  if (Array.isArray(inline)) {
    const cleaned = inline.filter((m): m is LLMMessage => isLLMMessage(m));
    if (cleaned.length > 0) return cleaned;
  }
  // DM stage 4 — in mixed mode, prepend sibling priors to the user text.
  const userTextForTurn = ctx.historyMode === 'mixed'
    ? composeMixedUserText(ctx.userText, ctx.target, ctx.allTargets)
    : ctx.userText;
  const seed: LLMMessage[] = [];
  if (composedSystemPrompt && composedSystemPrompt.length > 0) {
    seed.push({ role: 'system', content: composedSystemPrompt });
  }
  seed.push({ role: 'user', content: userTextForTurn });
  return seed;
}

/** DM stage 4 — assemble `<prior_answer>` blocks from siblings'
 *  `lastAssistant` and prepend to the user prompt. The current
 *  target's own `lastAssistant` is intentionally skipped (it's
 *  redundant — the target's own thread is its own context). */
export function composeMixedUserText(
  userText: string,
  current: MultiLlmTarget,
  allTargets: readonly MultiLlmTarget[],
): string {
  const priorBlocks: string[] = [];
  for (const sibling of allTargets) {
    if (sibling.id === current.id) continue;
    const last = sibling.lastAssistant;
    if (typeof last !== 'string' || last.length === 0) continue;
    // Escape the inner text minimally — strip the closing tag so a
    // malicious-looking sibling reply can't break the wrapper. Other
    // characters pass through (LLMs handle unescaped XML-ish text fine).
    const safe = last.replace(/<\/prior_answer>/gi, '</prior-answer-escaped>');
    priorBlocks.push(
      `<prior_answer model="${sibling.id}" provider="${sibling.provider}">${safe}</prior_answer>`,
    );
  }
  if (priorBlocks.length === 0) return userText;
  // Single newline between blocks · double newline before the actual
  // user text (visual separator the LLMs all understand).
  return `${priorBlocks.join('\n')}\n\n${userText}`;
}

/** §6.4 — resolve persona via global registry and prepend its
 *  systemPrompt. No-op when personaId is undefined or unknown. */
function applyPersonaSystemPrompt(
  personaId: string | undefined,
  basePrompt: string,
): string {
  if (!personaId) return basePrompt;
  const registry = getGlobalPersonaRegistry();
  const persona = registry.get(personaId);
  if (!persona) {
    debug.log('persona.binding', 'unknown-id', { personaId });
    return basePrompt;
  }
  const assembled = assemblePersonaPrompt(persona, basePrompt);
  debug.log('persona.binding', 'applied', {
    personaId,
    bytes: assembled.systemPrompt.length,
  });
  return assembled.systemPrompt;
}

function isLLMMessage(value: unknown): value is LLMMessage {
  if (!value || typeof value !== 'object') return false;
  const role = (value as { role?: unknown }).role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    return false;
  }
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' || Array.isArray(content);
}
