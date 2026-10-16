import type {
  InputResult,
  TextInputExternalSubmitRequest,
  TextInputGlobalAction,
  TextInputHost,
} from '../../chat/index.js';
import type { PromptFrame } from '../../display/prompt-frame.js';
import type { SurfaceRegistry } from '../../surface/index.js';
import { createChatMainInputHost } from './chat-main-host.js';
import { createChatMainInputSession } from './chat-main-session.js';
import { runChatMainInputTurn, type ChatMainTextInputBaseOpts } from './chat-main-turn.js';

export interface RunDashboardChatMainEntryDeps {
  promptFrame: PromptFrame;
  getPromptFrame?: () => PromptFrame;
  inputCols: number;
  getInputCols: () => number;
  surfaceRegistry: SurfaceRegistry;
  invalidateRenderCacheRow: (row0: number) => void;
  buildPromptFrameDividerRows: (promptFrame: PromptFrame, divider: string) => Array<{ row: number; text: string }>;
  shouldPaint: () => boolean;
  promptCtl: {
    repaint: () => void;
    insertAtCursor?: (text: string) => void;
    submit?: (request?: string | TextInputExternalSubmitRequest) => void;
  };
  setInputLines: (visibleLines: number) => boolean;
  redraw: () => void;
  dispatchGlobalAction: (action: TextInputGlobalAction) => void | Promise<void>;
  initialText?: string;
  paintFrameNow?: () => void;
  preferHistoryArrowKeys?: boolean;
  history: string[];
  placeholder: string;
  textInputOpts: ChatMainTextInputBaseOpts;
  debugLog?: (event: string, label: string, payload: Record<string, unknown>) => void;
}

export async function runDashboardChatMainEntry(
  deps: RunDashboardChatMainEntryDeps,
): Promise<InputResult> {
  deps.debugLog?.('chat-main.entry-runtime', 'ownership-gates', {
    hasCanClaimCursor: typeof deps.textInputOpts.canClaimCursor === 'function',
    hasShouldSyncPickers: typeof deps.textInputOpts.shouldSyncPickers === 'function',
    canClaimCursorNow:
      typeof deps.textInputOpts.canClaimCursor === 'function'
        ? deps.textInputOpts.canClaimCursor()
        : null,
    shouldSyncPickersNow:
      typeof deps.textInputOpts.shouldSyncPickers === 'function'
        ? deps.textInputOpts.shouldSyncPickers()
        : null,
  });
  const getPromptFrame = (): PromptFrame => deps.getPromptFrame?.() ?? deps.promptFrame;
  if (deps.paintFrameNow) {
    deps.paintFrameNow();
    deps.debugLog?.('chat-main.entry-runtime', 'frame-painted-before-input', {
      initialTextLength: deps.initialText?.length ?? 0,
    });
  }
  const session = createChatMainInputSession({
    promptFrame: deps.promptFrame,
    getPromptFrame,
    inputCols: deps.inputCols,
    getInputCols: deps.getInputCols,
    surfaceRegistry: deps.surfaceRegistry,
    invalidateRenderCacheRow: deps.invalidateRenderCacheRow,
    buildPromptFrameDividerRows: deps.buildPromptFrameDividerRows,
    shouldPaint: deps.shouldPaint,
    debugLog: deps.debugLog,
  });
  const host: TextInputHost = createChatMainInputHost({
    promptCtl: deps.promptCtl,
    setInputLines: deps.setInputLines,
    redraw: deps.redraw,
    dispatchGlobalAction: deps.dispatchGlobalAction,
  });
  const result = await runChatMainInputTurn({
    session,
    initialText: deps.initialText,
    preferHistoryArrowKeys: deps.preferHistoryArrowKeys,
    history: deps.history,
    placeholder: deps.placeholder,
    textInputOpts: {
      ...deps.textInputOpts,
      host,
    },
  });
  // textInput has returned: its paint closure now holds the submitted buffer.
  // Disarm the repaint hook until the next entry re-arms it, otherwise every
  // queued dashboard draw (which repaints the live prompt afterwards) paints
  // the just-sent text back into the prompt for the whole streaming turn.
  deps.promptCtl.repaint = () => {};

  // Auto-clear the input band the instant the user hits Enter. textInput
  // paints its live buffer via direct stdout writes that the composer's
  // render-cache diff is blind to, so on submit the just-sent text stays
  // on screen until the NEXT full input turn re-enters — which, on a slow
  // model (codex can stream for a minute+), leaves the submitted text
  // sitting in the prompt for the whole turn. Invalidating the prompt
  // rows and redrawing here forces the composer to repaint the ❯
  // placeholder over the stale buffer immediately, before the turn runs.
  if (result.submitted) {
    for (
      let row = getPromptFrame().promptTopRow;
      row <= getPromptFrame().promptBottomRow;
      row++
    ) {
      deps.invalidateRenderCacheRow(row - 1);
    }
    deps.redraw();
  }

  return result;
}
