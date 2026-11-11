/** Chat-turn lifetime for the Next TUI. Key parsing and queued submissions live in sibling cores. */
import type { AgentDisplayEvent } from './agents.js';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
export interface NextTuiTurnInput {
  readonly sessionId: string;
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface NextTuiTurnResult {
  readonly goalComplete?: boolean;
  readonly goalStopReason?: string;
}

export interface NextTuiTurnOutcome {
  readonly kind: 'completed' | 'cancelled' | 'failed';
  readonly goalComplete: boolean;
  readonly goalStopReason?: string;
  readonly compacted: boolean;
  readonly compactNote?: string;
  readonly error?: string;
}

export interface NextTuiTurnDeps {
  run(input: NextTuiTurnInput, onDelta: (text: string, replace?: boolean) => void,
    onCompact: (status: string) => void, onNotice: (line: string) => void,
    onAgent: (event: AgentDisplayEvent) => void, onStatus: (line: string) => void,
    onMessageBlock: (block: MessageBlock) => void): Promise<NextTuiTurnResult | void>;
  onStreamOpen?(): void;
  onProgress?(): void;
  onPreview?(text: string, replace: boolean): void;
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
}

/** Run one turn; stream preview is provisional until the caller reloads canonical history on settle. */
export function startNextTuiTurn(input: Omit<NextTuiTurnInput, 'signal'>, deps: NextTuiTurnDeps): NextTuiTurnHandle {
  const controller = new AbortController();
  let preview = '';
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
  const onDelta = (text: string, replace = false): void => {
    if (settled || controller.signal.aborted) return;
    deps.onProgress?.();
    if (!streamOpened) { streamOpened = true; deps.onStreamOpen?.(); }
    if (replace) {
      preview = '';
      clearRenderTimer();
      lastRender = now();
      deps.onPreview?.('', true);
      return;
    }
    preview = (preview + text).slice(-32_768);
    const timestamp = now();
    if (lastRender === 0 || timestamp - lastRender >= 33) {
      lastRender = timestamp;
      deps.onPreview?.(preview, false);
    } else if (renderTimer === null) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (settled || controller.signal.aborted) return;
        lastRender = now();
        deps.onPreview?.(preview, false);
      }, 33 - (timestamp - lastRender));
    }
  };
  const done = Promise.resolve().then(async (): Promise<NextTuiTurnOutcome> => {
    let result: NextTuiTurnResult | void = undefined;
    let error: string | undefined;
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
    }
    settled = true;
    clearRenderTimer();
    const outcome: NextTuiTurnOutcome = {
      kind: controller.signal.aborted ? 'cancelled' : error ? 'failed' : 'completed',
      goalComplete: result?.goalComplete === true,
      ...(result?.goalStopReason ? { goalStopReason: result.goalStopReason } : {}),
      compacted,
      ...(compactNote ? { compactNote } : {}),
      ...(error ? { error } : {}),
    };
    await deps.onSettled?.(outcome);
    return outcome;
  });
  return { controller, done, abort: () => controller.abort() };
}

/** User submissions take priority; a cancelled turn cannot open an automatic follow-up. */
export function decideNextTuiAutoContinue(
  outcome: NextTuiTurnOutcome, queuedCount: number, draft: string,
): 'complete' | 'check' | 'yield' | 'none' {
  if (outcome.kind === 'cancelled') return 'none';
  if (outcome.goalComplete) return 'complete';
  return queuedCount > 0 || draft.length > 0 ? 'yield' : 'check';
}
