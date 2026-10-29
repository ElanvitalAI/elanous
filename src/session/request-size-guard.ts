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
// ⚠️ `llm.ts` applies the compacted list with `messages.splice(...)`, but the
// array it receives is a per-request copy (`mapProviderToolNamesInMessages`),
// not `streamLLMWithTools`'s `history`. Compaction therefore does not survive
// into the next tool round by itself — the guard re-measures each request —
// and only a host write-back (chat.ts session rewrite / dashboard history
// replace) makes it survive into the next prompt.

import type { LLMMessage, LLMOpts, LLMToolSpec } from '../llm.js';
import type { CompactProvider } from '../compact/provider.js';

/** #32254 — the wire cap for Codex TUI requests (serialized body chars). */
export const REQUEST_SIZE_MAX_CHARS = 400_000;

export type RequestSizeGuard = NonNullable<LLMOpts['requestSizeGuard']>;
export type RequestSizeMeasurement = Parameters<NonNullable<RequestSizeGuard['onMeasured']>>[0];
export type RequestSizeCompactInfo = Parameters<RequestSizeGuard['compactMessages']>[1];
export type RequestSizeCompactResult = Awaited<ReturnType<RequestSizeGuard['compactMessages']>>;

type RunCompactPipeline = typeof import('../compact/pipeline.js').runCompactPipeline;

export interface CompactLiveMessagesOptions {
  sessionId?: string;
  activeModelId?: string;
  preserveLastN?: number;
  archiveEnabled?: boolean;
  /** Test seam — defaults to the real `runCompactPipeline` with the default compact provider. */
  runCompactPipeline?: RunCompactPipeline;
}

/** Compact a live message list. Returns `null` when no layer changed anything. */
export async function compactLiveMessages(
  messages: LLMMessage[],
  opts: CompactLiveMessagesOptions,
): Promise<{ messages: LLMMessage[]; reason: string } | null> {
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
  onMeasured?: (measurement: RequestSizeMeasurement) => void;
}

export function createRequestSizeGuard(opts: CreateRequestSizeGuardOptions): RequestSizeGuard {
  let measuredProviderRequests = 0;
  return {
    maxChars: opts.maxChars ?? REQUEST_SIZE_MAX_CHARS,
    compactMessages: async (currentMessages, info) => {
      if (measuredProviderRequests === 0 && opts.compactFirstRequest) {
        const first = await opts.compactFirstRequest(currentMessages, info);
        if (first) return first;
      }
      return compactLiveMessages(currentMessages, opts.compactOptions());
    },
    onMeasured: (measurement) => {
      measuredProviderRequests += 1;
      opts.onMeasured?.(measurement);
    },
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
