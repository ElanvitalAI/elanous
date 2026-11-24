/** Chat-turn lifetime for the Next TUI. Key parsing and queued submissions live in sibling cores. */
import type { AgentDisplayEvent } from './agents.js';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { NextTuiAuthError, type NextTuiAuthFailureKind } from '../../tui-client/next-auth-preflight.js';
import type { PlanWire } from '../../code-edit/plan-wire.js';
export interface NextTuiTurnInput {
  readonly sessionId: string;
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface NextTuiTurnResult {
  readonly goalComplete?: boolean;
  readonly goalStopReason?: string;
  /** The plan state at turn end — the structured outcome the end-of-turn gate reads. */
  readonly planOutcome?: PlanWire;
}

export interface NextTuiTurnOutcome {
  readonly kind: 'completed' | 'cancelled' | 'failed';
  readonly goalComplete: boolean;
  readonly goalStopReason?: string;
  readonly planOutcome?: PlanWire;
  readonly compacted: boolean;
  readonly compactNote?: string;
  readonly error?: string;
  readonly authFailureKind?: NextTuiAuthFailureKind;
}

export interface NextTuiTurnDeps {
  run(input: NextTuiTurnInput, onDelta: (text: string, replace?: boolean, source?: 'assistant-text') => void,
    onCompact: (status: string) => void, onNotice: (line: string) => void,
    onAgent: (event: AgentDisplayEvent) => void, onStatus: (line: string) => void,
    onMessageBlock: (block: MessageBlock) => void): Promise<NextTuiTurnResult | void>;
  onStreamOpen?(): void;
  onProgress?(): void;
  onPreview?(text: string, replace: boolean, source?: 'assistant-text'): void;
  /** TUI-ANSWER-VANISH-ON-TOOLCALL — a tool-round clear frame hands the shown pre-tool lines to the screen holder. */
  onHeldAnswer?(text: string): void;
  onCompact?(status: string): void;
  onNotice?(line: string): void;
  onAgent?(event: AgentDisplayEvent): void;
  onStatus?(line: string): void;
  onMessageBlock?(block: MessageBlock): void;
  onSettled?(outcome: NextTuiTurnOutcome): void | Promise<void>;
  now?(): number;
}

export interface NextTuiTurnHandle {
  readonly controller: AbortController;
  readonly done: Promise<NextTuiTurnOutcome>;
  abort(): void;
  /** Deliver a throttled preview now, so an ordered event (a tool start) sees all text before it. */
  flushPreview(): void;
}

/** Run one turn; stream preview is provisional until the caller reloads canonical history on settle. */
export function startNextTuiTurn(input: Omit<NextTuiTurnInput, 'signal'>, deps: NextTuiTurnDeps): NextTuiTurnHandle {
  const controller = new AbortController();
  let preview = '';
  const pemOpening = '-----BEGIN';
  let pemOpeningTail = '';
  let secretPreviewBlocked = false;
  let previewSource: 'assistant-text' | undefined;
  let lastRender = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let streamOpened = false;
  let compacted = false;
  let compactNote: string | undefined;
  let settled = false;
  const now = deps.now ?? (() => performance.now());
  const clearRenderTimer = (): void => {
    if (renderTimer !== null) clearTimeout(renderTimer);
    renderTimer = null;
  };
  controller.signal.addEventListener('abort', () => {
    if (settled) return;
    const hadPreview = preview.length > 0;
    preview = '';
    previewSource = undefined;
    clearRenderTimer();
    if (hadPreview) deps.onPreview?.('', true);
  }, { once: true });
  const onDelta = (text: string, replace = false, source?: 'assistant-text'): void => {
    if (settled || controller.signal.aborted) return;
    deps.onProgress?.();
    if (!streamOpened) { streamOpened = true; deps.onStreamOpen?.(); }
    // Every frame carries security state, including text on replacement/reset frames.
    const securityText = pemOpeningTail + text;
    secretPreviewBlocked ||= securityText.toUpperCase().includes(pemOpening);
    pemOpeningTail = securityText.slice(-(pemOpening.length - 1));
    if (replace) {
      // TUI-ANSWER-VANISH-ON-TOOLCALL — a tool-round clear frame hands the streamed pre-tool
      // lines to the screen holder before the preview restarts clean; a blocked secret clears silently.
      if (preview.trim() !== '' && !secretPreviewBlocked) deps.onHeldAnswer?.(preview);
      preview = '';
      previewSource = undefined;
      clearRenderTimer();
      lastRender = now();
      deps.onPreview?.('', true);
      return;
    }
    // Security state belongs to the turn, not to a provenance lane or replaceable preview.
    // Conservatively stop provisional text after any PEM opening; canonical history is unchanged.
    if (secretPreviewBlocked) {
      preview = '';
      previewSource = undefined;
      clearRenderTimer();
      deps.onPreview?.('', true);
      return;
    }
    // Never promote an earlier unclassified chunk when a typed assistant delta arrives.
    if (source !== previewSource) preview = '';
    previewSource = source;
    // The turn-scoped latch survives truncation; normal text keeps its latest streamed tail.
    preview = (preview + text).slice(-32_768);
    const timestamp = now();
    if (lastRender === 0 || timestamp - lastRender >= 33) {
      lastRender = timestamp;
      deps.onPreview?.(preview, false, previewSource);
    } else if (renderTimer === null) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (settled || controller.signal.aborted) return;
        lastRender = now();
        deps.onPreview?.(preview, false, previewSource);
      }, 33 - (timestamp - lastRender));
    }
  };
  const done = Promise.resolve().then(async (): Promise<NextTuiTurnOutcome> => {
    // A turn already aborted before this microtask (Esc, or a stall that never opened) skips
    // run() and settles cancelled, so nothing can announce a turn that never started (A207).
    if (settled || controller.signal.aborted) {
      settled = true;
      clearRenderTimer();
      const cancelled: NextTuiTurnOutcome = { kind: 'cancelled', goalComplete: false, compacted: false };
      await deps.onSettled?.(cancelled);
      return cancelled;
    }
    let result: NextTuiTurnResult | void = undefined;
    let error: string | undefined;
    let authFailureKind: NextTuiAuthFailureKind | undefined;
    try {
      result = await deps.run({ ...input, signal: controller.signal }, onDelta, (status) => {
        if (settled || controller.signal.aborted) return;
        compacted = true;
        compactNote = status;
        deps.onCompact?.(status);
      }, (line) => { if (!settled && !controller.signal.aborted) deps.onNotice?.(line); },
      (event) => { if (!settled && !controller.signal.aborted) deps.onAgent?.(event); },
      (line) => { if (!settled && !controller.signal.aborted) deps.onStatus?.(line); },
      (block) => { if (!settled && !controller.signal.aborted) deps.onMessageBlock?.(block); });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof NextTuiAuthError) authFailureKind = cause.kind;
    }
    settled = true;
    clearRenderTimer();
    const outcome: NextTuiTurnOutcome = {
      kind: controller.signal.aborted ? 'cancelled' : error ? 'failed' : 'completed',
      goalComplete: result?.goalComplete === true,
      ...(result?.goalStopReason ? { goalStopReason: result.goalStopReason } : {}),
      ...(result?.planOutcome ? { planOutcome: result.planOutcome } : {}),
      compacted,
      ...(compactNote ? { compactNote } : {}),
      ...(error ? { error } : {}),
      ...(authFailureKind ? { authFailureKind } : {}),
    };
    await deps.onSettled?.(outcome);
    return outcome;
  });
  const flushPreview = (): void => {
    if (renderTimer === null || settled || controller.signal.aborted) return;
    clearRenderTimer();
    lastRender = now();
    deps.onPreview?.(preview, false, previewSource);
  };
  return { controller, done, abort: () => controller.abort(), flushPreview };
}

/** User submissions take priority; a cancelled turn cannot open an automatic follow-up. */
export function decideNextTuiAutoContinue(
  outcome: NextTuiTurnOutcome, queuedCount: number, draft: string,
): 'complete' | 'check' | 'yield' | 'none' {
  if (outcome.kind === 'cancelled') return 'none';
  if (outcome.goalComplete) return 'complete';
  return queuedCount > 0 || draft.length > 0 ? 'yield' : 'check';
}
