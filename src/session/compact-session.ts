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
  /** Internal — this call is the one retry after the store's prefix changed under a summary. */
  storeChangedRetry?: boolean;
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

/** OP-LONG-SESSION-COMPACT — audit-only rows (tool telemetry · goal-loop interim replies). chat.ts
 *  toLLM never replays them. The compactor leaves them out of the summarizer input and keeps the
 *  ORIGINAL stored rows (role `tool`, ts, from, turn_id) byte-for-byte — never converted to `user`,
 *  which would replay audit content as if the person had said it. */
function isAuditRow(m: SerializedMessage): boolean {
  return m.role === 'tool' || m.goalInterim === true;
}

/** SerializedMessage → LLM wire role, for conversation rows only (audit rows never get here). */
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

/** Index of the oldest non-system message outside the preserve window, or -1 when nothing is
 *  droppable so the retry loop terminates. */
function dropOldestIndex(messages: LLMMessage[], preserveLastN: number): number {
  const preserveFrom = Math.max(0, messages.length - preserveLastN);
  for (let i = 0; i < preserveFrom; i++) {
    if (messages[i]!.role === 'system') continue;
    return i;
  }
  return -1;
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
/** OP-LONG-SESSION-COMPACT — the write after an async summary never overwrites rows that arrived in
 *  the meantime. The store is re-read in the same synchronous section as the write (no await between
 *  them; in-process only — cross-process safety is the follow-up cell OP-LONG-SESSION-COMPACT-LOCK):
 *  - unchanged, or only grown by appends (the snapshot is still its prefix): write the compacted
 *    history followed by every appended row, in order;
 *  - prefix changed (a row edited or the store rewritten): write nothing and report it. */
type StoreWrite = 'written' | 'prefix-changed' | 'missing';

function writeKeepingAppends(
  sessionId: string,
  snapshot: readonly SerializedMessage[],
  rewritten: readonly SerializedMessage[],
  root: string | undefined,
): { outcome: StoreWrite; written: SerializedMessage[] } {
  const current = loadSession(sessionId, root)?.messages;
  if (!current) return { outcome: 'missing', written: [] };
  const prefixIntact = current.length >= snapshot.length
    && snapshot.every((row, i) => JSON.stringify(row) === JSON.stringify(current[i]));
  if (!prefixIntact) return { outcome: 'prefix-changed', written: [] };
  const written = [...rewritten, ...current.slice(snapshot.length)];
  rewriteSessionMessages(sessionId, written, root);
  return { outcome: 'written', written };
}

export async function compactSessionHistory(
  sessionId: string,
  opts: CompactSessionOpts,
): Promise<CompactSessionResult> {
  const loaded = loadSession(sessionId, opts.root);
  if (!loaded) return ZERO(0, 'session-not-found');
  const before = loaded.messages.length;

  const rows = loaded.messages;
  // Conversation rows only; `workingRows[k]` is the stored index of `working[k]`.
  const convoIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) if (!isAuditRow(rows[i]!)) convoIdx.push(i);
  const llm = convoIdx.map(i => toLLMMessage(rows[i]!));
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
  let workingRows = convoIdx;
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
    const drop = dropOldestIndex(working, opts.config.preserveLastN);
    if (drop < 0) break; // nothing left to shed
    working = [...working.slice(0, drop), ...working.slice(drop + 1)];
    workingRows = [...workingRows.slice(0, drop), ...workingRows.slice(drop + 1)];
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
  const rewritten = rewriteKeepingAuditRows(rows, workingRows, result, ts);
  // Deferred commit (codex request-size guard): the same append-keeping write; a changed prefix
  // skips the commit and leaves the store as it is.
  const commit = () => {
    const { outcome } = writeKeepingAppends(sessionId, rows, rewritten, opts.root);
    if (outcome !== 'written') debug.log('session.compact', 'skipped', { sessionId, reason: `commit-${outcome}` }, { level: 'warn' });
  };
  if (!opts.prepareOnly) {
    const { outcome, written } = writeKeepingAppends(sessionId, rows, rewritten, opts.root);
    if (outcome === 'prefix-changed' && !opts.storeChangedRetry) {
      // One retry from a fresh snapshot.
      debug.log('session.compact', 'retry', { sessionId, reason: 'store-prefix-changed' }, { level: 'warn' });
      return compactSessionHistory(sessionId, { ...opts, storeChangedRetry: true });
    }
    if (outcome !== 'written') {
      debug.log('session.compact', 'skipped', { sessionId, reason: outcome === 'prefix-changed' ? 'store-changed' : 'store-missing' }, { level: 'warn' });
      return { ...ZERO(before, outcome === 'prefix-changed' ? 'store-changed' : 'store-missing', decision.usedTokens, decision.ratio), overflowRetries };
    }
    return {
      fired: true,
      reason: decision.reason,
      before,
      after: written.length,
      usedTokens: decision.usedTokens,
      ratio: decision.ratio,
      layer3Applied: result.diagnostics.layer3SummaryApplied === 1,
      overflowRetries,
    };
  }
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

/** Map the pipeline output back onto the stored rows without converting any role.
 *  - Layer 3 (LLM summary, written first since no anchors are pinned here): the audit rows before the
 *    kept tail stay in their original order, then the summary (+ replayed user), then the stored tail
 *    rows as they are — audit rows inside the tail keep their position.
 *  - Otherwise (Layer 5 truncation, one message per working row): each kept conversation row keeps its
 *    stored identity with only its content updated; audit rows stay where they are. */
function rewriteKeepingAuditRows(
  rows: readonly SerializedMessage[],
  workingRows: readonly number[],
  result: Awaited<ReturnType<typeof runCompactPipeline>>,
  ts: string,
): SerializedMessage[] {
  const messages = result.messages;
  const summaryAt = messages.findIndex(m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('<context_summary>'));
  if (result.diagnostics.layer3SummaryApplied === 1 && summaryAt >= 0) {
    const replay = result.diagnostics.userReplayApplied === 1 ? 1 : 0;
    const tailLen = messages.length - summaryAt - 1 - replay;
    const tailStart = tailLen > 0 ? workingRows[workingRows.length - tailLen]! : rows.length;
    const anchors = workingRows.slice(0, summaryAt);
    const keptHead = rows.slice(0, tailStart).filter((row, i) => isAuditRow(row) || anchors.includes(i));
    return [
      ...keptHead,
      toSerialized(messages[summaryAt]!, ts),
      ...(replay === 1 ? [toSerialized(messages[summaryAt + 1]!, ts)] : []),
      ...rows.slice(tailStart),
    ];
  }
  // An output that does not line up 1:1 with the working rows cannot be mapped safely — keep the store.
  if (messages.length !== workingRows.length) return [...rows];
  const kept = new Map<number, LLMMessage>();
  workingRows.forEach((rowIndex, k) => kept.set(rowIndex, messages[k]!));
  return rows.flatMap((row, i) => {
    if (isAuditRow(row)) return [row];
    const message = kept.get(i);
    if (!message) return [];
    const content = collapseContent(message.content);
    return [content === row.content ? row : { ...row, content, tokenEstimate: estimateTokens(content) }];
  });
}
