import type { LLMToolSpec } from '../llm/tool-spec.js';
// TUI-TOKEN-GUARD-WIRE — shared request-size guard (#32254 cap).
//
// The 400k-char cap used to be built only inside `session/chat.ts runTurn`.
// The production TUI does not run that function: it goes
// DashboardSession → bridgeCoreTurnToAcp → runCoreTurn/runGoalLoop, so the
// guard never reached `llm.ts` and no `request-size-compact` event fired
// (root cause: seat-state/OP/tmp/TUI-TOKEN-BURN-ROOT-CAUSE-1028.md).
//
// This module owns the guard construction so both paths share one policy:
//   - `createRequestSizeGuard` — the `LLMOpts.requestSizeGuard` object.
//     The first measured request may use a caller hook (`compactFirstRequest`)
//     that compacts the caller's *persisted* history; every other request
//     (and a first request whose hook declines) compacts the live message list.
//   - `compactLiveMessages` — the live compaction (Layer 1/2 + optional
//     Layer 3 summarize) shared by the guard and by hosts that compact their
//     own history store.
//   - `estimateRequestChars` — cheap pre-send estimate (JSON chars of the
//     messages plus tool specs) used by the ACP bridge preflight.
//
// `llm.ts` applies the compacted list to its provider copy, then invokes the
// optional `onCompacted` callback to replace `streamLLMWithTools`'s canonical
// history before the next tool round. A host writer may additionally persist
// the session-facing transcript across turns.

import { createHash } from 'node:crypto';
import type { LLMMessage, LLMOpts } from '../llm.js';
import type { CompactProvider } from '../compact/provider.js';
import { truncateProportional } from '../compact/truncate-proportional.js';
import { appendArchiveEntry, archiveReferencePath, getDefaultArchiveDir, inspectArchive } from '../compact/archive.js';

/** #32254 — the wire cap for Codex TUI requests (serialized body chars). */
export const REQUEST_SIZE_MAX_CHARS = 400_000;
// Source: OP48041 requests proactive compaction at 85% of the unchanged hard cap.
const REQUEST_SIZE_COMPACT_RATIO = 0.85;

export type RequestSizeGuard = NonNullable<LLMOpts['requestSizeGuard']>;
export type RequestSizeMeasurement = Parameters<NonNullable<RequestSizeGuard['onMeasured']>>[0];
export type RequestSizeCompactInfo = Parameters<RequestSizeGuard['compactMessages']>[1];
export type RequestSizeCompactResult = Awaited<ReturnType<RequestSizeGuard['compactMessages']>>;

export type RunCompactPipeline = typeof import('../compact/pipeline.js').runCompactPipeline;

export interface CompactLiveMessagesOptions {
  sessionId?: string;
  activeModelId?: string;
  preserveLastN?: number;
  archiveEnabled?: boolean;
  archiveDir?: string;
  /** Test seam — defaults to the real `runCompactPipeline` with the default compact provider. */
  runCompactPipeline?: RunCompactPipeline;
}

function currentUserTextIndex(messages: LLMMessage[]): number {
  // Dashboard ACP marks the just-entered turn explicitly. That provenance
  // wins over transcript-shaped user/tool-result messages in the same wire.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]! as LLMMessage & { transientTurnUser?: boolean };
    if (message.role !== 'user' || message.transientTurnUser !== true) continue;
    const hasText = typeof message.content === 'string' ? message.content.length > 0
      : message.content.some(block => block.type === 'text' && block.text.length > 0);
    if (hasText) return i;
  }
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string') {
      if (message.content.length > 0) {
        turnStart = i + 1;
        break;
      }
      continue;
    }
    const hasToolUse = message.content.some(block => block.type === 'tool_use');
    const hasText = message.content.some(block => block.type === 'text' && block.text.length > 0);
    if (!hasToolUse && hasText) {
      turnStart = i + 1;
      break;
    }
  }
  const turnToolUseIds = new Set<string>();
  for (let i = turnStart; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) if (block.type === 'tool_use') turnToolUseIds.add(block.id);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (i < turnStart) break;
    if (message.role !== 'user') continue;
    const hasText = typeof message.content === 'string' ? message.content.length > 0
      : message.content.some(block => block.type === 'text' && block.text.length > 0);
    if (!hasText) continue;
    const isToolResultForThisTurn = typeof message.content !== 'string'
      && message.content.some(block => block.type === 'tool_result' && turnToolUseIds.has(block.tool_use_id));
    if (!isToolResultForThisTurn) return i;
  }
  return -1;
}

function compactMixedMessageText(messages: LLMMessage[], opts: CompactLiveMessagesOptions, includeSeparate = false): { messages: LLMMessage[]; reason: string } | null {
  if (opts.archiveEnabled === false) return null;
  const sessionId = opts.sessionId ?? 'default';
  const dir = opts.archiveDir ?? getDefaultArchiveDir();
  let changed = false;
  const currentUserIndex = currentUserTextIndex(messages);
  const compactText = (text: string, messageIndex: number, blockIndex?: number): string => {
    if (text.length <= 8_000) return text;
    const hash = createHash('sha256').update(text, 'utf16le').digest('hex');
    const pointer = `[Full text (${text.length} chars) saved to: ${archiveReferencePath(sessionId, dir)}] [message index: ${messageIndex}${blockIndex === undefined ? '' : `, block index: ${blockIndex}`}] [sha256-utf16le: ${hash}]\n`;
    const replacement = pointer + truncateProportional({ text, maxChars: Math.max(0, 8_000 - pointer.length) });
    if (replacement.length >= text.length || !appendArchiveEntry({
      ts: Date.now(), layer: 'truncate-proportional', sessionId,
      origin: { kind: 'truncated_tail', messageIndex }, content: text, replacement,
    }, dir)) return text;
    changed = true;
    return replacement;
  };
  const result = messages.map((message, index) => {
    if (message.role === 'system' || index === currentUserIndex) return message;
    if (typeof message.content === 'string') {
      return includeSeparate ? { ...message, content: compactText(message.content, index) } : message;
    }
    if (!includeSeparate && !message.content.some(block => block.type === 'tool_result')) return message;
    return { ...message, content: message.content.map((block, blockIndex) => block.type === 'text'
      ? { ...block, text: compactText(block.text, index, blockIndex) } : block) };
  });
  return changed ? { messages: result, reason: 'mixed-message-text-compact' } : null;
}

/** Compact a live message list. Returns `null` when no layer changed anything. */
export async function compactLiveMessages(
  messages: LLMMessage[],
  opts: CompactLiveMessagesOptions,
): Promise<{ messages: LLMMessage[]; reason: string } | null> {
  const mixed = compactMixedMessageText(messages, opts);
  if (mixed) return mixed;
  let run = opts.runCompactPipeline;
  let provider: CompactProvider | undefined;
  if (!run) {
    run = (await import('../compact/pipeline.js')).runCompactPipeline;
    provider = (await import('../compact/provider.js')).getDefaultCompactProvider();
  }
  const compacted = await run(messages, {
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(opts.activeModelId !== undefined ? { activeModelId: opts.activeModelId } : {}),
    policy: {
      ...(opts.preserveLastN !== undefined ? { preserveLastN: opts.preserveLastN } : {}),
      ...(opts.archiveEnabled !== undefined ? { archiveEnabled: opts.archiveEnabled } : {}),
      ...(opts.archiveDir !== undefined ? { archiveDir: opts.archiveDir } : {}),
    },
  });
  const diagnostics = compacted.diagnostics;
  const changed = diagnostics.layer1ResponsesTrimmed > 0
    || diagnostics.layer2MicrocompactCleared > 0
    || diagnostics.layer3SummaryApplied === 1
    || diagnostics.layer5FallbackTruncated === 1;
  return changed ? { messages: compacted.messages, reason: 'live-request-compact' } : null;
}

export interface CreateRequestSizeGuardOptions {
  maxChars?: number;
  /** Live-compaction options, resolved lazily at compaction time (config is
   *  read only when a request is actually over the cap). */
  compactOptions: () => CompactLiveMessagesOptions;
  /** First measured request only: compact the caller's persisted history and
   *  return the rebuilt request. `null` falls through to live compaction. */
  compactFirstRequest?: (
    currentMessages: LLMMessage[],
    info: RequestSizeCompactInfo,
  ) => Promise<RequestSizeCompactResult>;
  onCompacted?: RequestSizeGuard['onCompacted'];
  onMeasured?: (measurement: RequestSizeMeasurement) => void;
}

function preservesActiveInstructions(before: LLMMessage[], after: LLMMessage[]): boolean {
  const currentUser = before[currentUserTextIndex(before)];
  const candidates = before.filter(message => (message.role === 'system'
    && (message as LLMMessage & { transientPreamble?: boolean }).transientPreamble !== true)
    || message === currentUser);
  const sameProtectedContent = (left: LLMMessage, right: LLMMessage) =>
    left.role === right.role && JSON.stringify(left.content) === JSON.stringify(right.content);
  // A transient preamble and historical system message may intentionally
  // have identical content. If provenance was stripped by a caller, one
  // surviving copy still preserves that instruction; don't require twins.
  const protectedMessages = candidates.filter((message, index) =>
    candidates.findIndex(candidate => sameProtectedContent(candidate, message)) === index);
  let cursor = 0;
  for (const message of after) {
    if (cursor < protectedMessages.length && sameProtectedContent(message, protectedMessages[cursor]!)) cursor++;
  }
  return cursor === protectedMessages.length;
}

export function createRequestSizeGuard(opts: CreateRequestSizeGuardOptions): RequestSizeGuard {
  let measuredProviderRequests = 0;
  return {
    maxChars: opts.maxChars ?? REQUEST_SIZE_MAX_CHARS,
    compactAtChars: Math.floor((opts.maxChars ?? REQUEST_SIZE_MAX_CHARS) * REQUEST_SIZE_COMPACT_RATIO),
    compactMessages: async (currentMessages, info) => {
      const hasToolResults = currentMessages.some(message => Array.isArray(message.content)
        && message.content.some(block => block.type === 'tool_result'));
      if (hasToolResults) {
        const mixed = compactMixedMessageText(currentMessages, opts.compactOptions(), true);
        return mixed;
      }
      if (measuredProviderRequests === 0 && opts.compactFirstRequest) {
        const first = await opts.compactFirstRequest(currentMessages, info);
        if (first && preservesActiveInstructions(currentMessages, first.messages)) return first;
      }
      const result = await compactLiveMessages(currentMessages, opts.compactOptions());
      return result && preservesActiveInstructions(currentMessages, result.messages) ? result : null;
    },
    compactNext: async (messages, startIndex) => {
      const options = opts.compactOptions();
      if (options.archiveEnabled === false) return null;
      const sessionId = options.sessionId ?? 'default';
      const dir = options.archiveDir ?? getDefaultArchiveDir();
      const archived = inspectArchive(sessionId, dir).entries;
      let index = 0;
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]!;
        if (!Array.isArray(message.content)) continue;
        for (let j = 0; j < message.content.length; j++) {
          const block = message.content[j]!;
          if (block.type !== 'tool_result') continue;
          const currentIndex = index++;
          if (currentIndex < startIndex) continue;
          // Structured tool results also contribute to the wire cap.
          // Persist their exact JSON before replacing with a reference.
          const original = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          if (archived.some(entry => entry.origin.kind === 'tool_result'
            && entry.origin.tool_use_id === block.tool_use_id && entry.replacement === block.content)) continue;
          const contentHash = createHash('sha256').update(original, 'utf16le').digest('hex');
          const replacement = `[Full output (${original.length} chars) saved to: ${archiveReferencePath(sessionId, dir)}] [tool_use_id: ${block.tool_use_id}] [sha256-utf16le: ${contentHash}]`;
          if (!appendArchiveEntry({
            ts: Date.now(), layer: 'tool-output-budget', sessionId,
            origin: { kind: 'tool_result', tool_use_id: block.tool_use_id },
            content: original, replacement,
          }, dir)) continue;
          const content = message.content.slice();
          content[j] = { ...block, content: replacement };
          const candidate = messages.slice();
          candidate[i] = { ...message, content };
          return { messages: candidate, reason: 'archive-tool-result', nextIndex: currentIndex + 1 };
        }
      }
      return null;
    },
    onMeasured: (measurement) => {
      measuredProviderRequests += 1;
      opts.onMeasured?.(measurement);
    },
    ...(opts.onCompacted ? { onCompacted: opts.onCompacted } : {}),
  };
}

/** Cheap pre-send size estimate: JSON chars of the messages plus tool specs.
 *  It tracks the Codex wire body closely (the wire also serializes both). */
export function estimateRequestChars(messages: readonly LLMMessage[], tools: readonly LLMToolSpec[] = []): number {
  try {
    return JSON.stringify(messages).length + (tools.length > 0 ? JSON.stringify(tools).length : 0);
  } catch {
    return 0;
  }
}

/** One-line status text shared by chat.ts and the ACP bridge. */
export function formatRequestSizeStatus(measurement: RequestSizeMeasurement): string {
  return `ctx ${measurement.requestChars.toLocaleString()} chars / ${measurement.maxChars.toLocaleString()}`
    + (measurement.compacted ? ` · compact ${measurement.reason}` : '');
}
