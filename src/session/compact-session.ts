// ── Auto-compaction for persisted sessions (Loop engineering §5-⑤) ──
//
// Bridges the session JSONL layer to the existing compact pipeline so a
// long-running autonomous continuation loop can compress its grown
// transcript in place instead of reloading an ever-growing history each
// turn (codex `run_auto_compact` pattern — token-threshold trigger,
// replace history with [summary, …tail], then continue).
//
// This module is deliberately isolated from the shared hot-path
// `runTurn`: it operates on a session id, loads → decides → compacts →
// rewrites, and touches no interactive caller. The continuation loop
// (Phase B) calls it pre-turn.
//
// codex #1 (compact.rs:284 `remove_first_item`) is ported here as a
// drop-oldest retry loop: when the summarizer itself overflows on a
// huge transcript, elanous's provider returns null and the pipeline
// no-ops. Rather than give up (fatal for an unattended run), we shed
// the oldest non-preserved message and retry so the summarizer input
// shrinks until it fits.

import type { ContentBlock, LLMMessage } from '../llm.js';
import { estimateTokens } from '../tokens.js';
import { debug } from '../debug/log.js';
import { shouldAutoCompact } from '../compact/auto.js';
import { runCompactPipeline } from '../compact/pipeline.js';
import { getDefaultCompactProvider, type CompactProvider } from '../compact/provider.js';
import type { ChatAutoCompactConfig } from '../user-config/chat.js';
import { loadSession, rewriteSessionMessages, type SerializedMessage } from './index.js';

export interface CompactSessionOpts {
  /** Active model id — drives context-window inference + summarizer
   *  routing. */
  modelId?: string;
  config: ChatAutoCompactConfig;
  /** Override the compact provider (test injection). Defaults to the
   *  shipped `getDefaultCompactProvider()`. */
  provider?: CompactProvider;
  /** codex #1 — max drop-oldest retries when the summarizer overflows /
   *  returns nothing. Default 3. */
  maxOverflowRetries?: number;
  root?: string;
  /** Force compaction unconditionally — bypass the shouldAutoCompact token-
   *  ratio gate. For the external `elanous session compact --force` trigger:
   *  run the full pipeline (incl. Layer 3 summarize) regardless of how full
   *  the context is. Below-threshold histories may still no-op if there is
   *  nothing to summarize. */
  force?: boolean;
  /** Prepare the rewritten session without persisting it until accepted. */
  prepareOnly?: boolean;
}

export interface CompactSessionResult {
  fired: boolean;
  reason: string;
  /** Message count before / after the rewrite. Equal when not fired. */
  before: number;
  after: number;
  usedTokens: number;
  ratio: number;
  /** Whether Layer 3 (LLM summarize) produced the compaction (vs a
   *  Layer 5 truncate fallback). */
  layer3Applied: boolean;
  /** How many drop-oldest retries the overflow guard consumed. */
  overflowRetries: number;
  preparedMessages?: SerializedMessage[];
  commit?: () => void;
}

/** SerializedMessage → LLM wire role. Mirrors chat.ts `toLLM`: tool
 *  entries render as plain user content (we don't replay tool rounds). */
function toLLMMessage(m: SerializedMessage): LLMMessage {
  const role: LLMMessage['role'] =
    m.role === 'user' ? 'user'
    : m.role === 'assistant' ? 'assistant'
    : m.role === 'system' ? 'system'
    : 'user';
  return { role, content: m.content };
}

/** Collapse an LLM message back to a stored string. Continuation
 *  history is already string-only; ContentBlock[] (interactive image
 *  turns) is flattened to its text blocks defensively. */
function collapseContent(content: LLMMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content as ContentBlock[])
    .filter(b => (b as ContentBlock).type === 'text')
    .map(b => (b as { text: string }).text)
    .join('\n');
}

function toSerialized(m: LLMMessage, ts: string): SerializedMessage {
  const content = collapseContent(m.content);
  const role: SerializedMessage['role'] =
    m.role === 'assistant' ? 'assistant'
    : m.role === 'system' ? 'system'
    : 'user';
  return { role, content, ts, tokenEstimate: estimateTokens(content) };
}

/** Drop the oldest non-system message outside the preserve window.
 *  Returns the same array (by length) when nothing is droppable so the
 *  retry loop terminates. */
function dropOldest(messages: LLMMessage[], preserveLastN: number): LLMMessage[] {
  const preserveFrom = Math.max(0, messages.length - preserveLastN);
  for (let i = 0; i < preserveFrom; i++) {
    if (messages[i]!.role === 'system') continue;
    return [...messages.slice(0, i), ...messages.slice(i + 1)];
  }
  return messages;
}

const ZERO = (before: number, reason: string, usedTokens = 0, ratio = 0): CompactSessionResult => ({
  fired: false,
  reason,
  before,
  after: before,
  usedTokens,
  ratio,
  layer3Applied: false,
  overflowRetries: 0,
});

/** Compact a persisted session in place when its history exceeds the
 *  configured token ratio. No-op (fired:false) below threshold, when
 *  disabled, or when the pipeline produces no reduction. Never throws
 *  on LLM failure — the overflow guard + pipeline fallbacks fail open,
 *  leaving the original history untouched. */
export async function compactSessionHistory(
  sessionId: string,
  opts: CompactSessionOpts,
): Promise<CompactSessionResult> {
  const loaded = loadSession(sessionId, opts.root);
  if (!loaded) return ZERO(0, 'session-not-found');
  const before = loaded.messages.length;

  const llm = loaded.messages.map(toLLMMessage);
  const decision = shouldAutoCompact(llm, opts.modelId, opts.config);
  // Force bypasses the token-ratio gate (external `elanous session compact
  // --force`); otherwise the auto path no-ops below threshold.
  if (!decision.fire && !opts.force) {
    return ZERO(before, decision.reason, decision.usedTokens, decision.ratio);
  }
  debug.log('compact.session', opts.force && !decision.fire ? 'force' : 'auto', {
    sessionId, before, ratio: Number(decision.ratio.toFixed(2)),
    usedTokens: decision.usedTokens, forced: opts.force === true,
  });

  const provider = opts.provider ?? getDefaultCompactProvider();
  const maxRetries = opts.maxOverflowRetries ?? 3;
  const policy = { preserveLastN: opts.config.preserveLastN };

  // codex #1 remove_first_item — run the pipeline; if it produced no
  // reduction (summarizer overflow / null + no fallback target), shed
  // the oldest non-preserved message and retry so the summarizer input
  // shrinks until it fits.
  let working = llm;
  let result = await runCompactPipeline(working, {
    sessionId,
    provider,
    policy,
    ...(opts.modelId ? { activeModelId: opts.modelId } : {}),
  });
  let overflowRetries = 0;
  const applied = (r: typeof result): boolean =>
    r.diagnostics.layer3SummaryApplied === 1 || r.diagnostics.layer5FallbackTruncated === 1;

  while (!applied(result) && overflowRetries < maxRetries) {
    const trimmed = dropOldest(working, opts.config.preserveLastN);
    if (trimmed.length === working.length) break; // nothing left to shed
    working = trimmed;
    overflowRetries++;
    result = await runCompactPipeline(working, {
      sessionId,
      provider,
      policy,
      ...(opts.modelId ? { activeModelId: opts.modelId } : {}),
    });
  }

  if (!applied(result)) {
    return {
      ...ZERO(before, 'no-op', decision.usedTokens, decision.ratio),
      overflowRetries,
    };
  }

  const ts = new Date().toISOString();
  const rewritten = result.messages.map(m => toSerialized(m, ts));
  const commit = () => rewriteSessionMessages(sessionId, rewritten, opts.root);
  if (!opts.prepareOnly) commit();
  return {
    fired: true,
    reason: decision.reason,
    before,
    after: rewritten.length,
    usedTokens: decision.usedTokens,
    ratio: decision.ratio,
    layer3Applied: result.diagnostics.layer3SummaryApplied === 1,
    overflowRetries,
    ...(opts.prepareOnly ? { preparedMessages: rewritten, commit } : {}),
  };
}
