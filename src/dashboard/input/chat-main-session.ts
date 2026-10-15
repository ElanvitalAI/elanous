import type { PromptFrame } from '../../display/prompt-frame.js';
import { hLine, ansi } from '../../tui.js';
import type { SurfaceRegistry } from '../../surface/index.js';

export interface ChatMainInputSession {
  inputRow: number;
  getInputRow: () => number;
  inputWidth: number;
  getInputWidth: () => number;
  paintChrome: () => void;
  shouldPaint: () => boolean;
  register: () => void;
  unregister: () => void;
}

export interface CreateChatMainInputSessionDeps {
  promptFrame: PromptFrame;
  getPromptFrame?: () => PromptFrame;
  inputCols: number;
  getInputCols?: () => number;
  surfaceRegistry: SurfaceRegistry;
  invalidateRenderCacheRow: (row0: number) => void;
  buildPromptFrameDividerRows: (promptFrame: PromptFrame, divider: string) => Array<{ row: number; text: string }>;
  shouldPaint: () => boolean;
  debugLog?: (event: string, label: string, payload: Record<string, unknown>) => void;
}

const CHAT_MAIN_INPUT_ADDR = { kind: 'input' as const, inputId: 'chat-main' };

export function createChatMainInputSession(
  deps: CreateChatMainInputSessionDeps,
): ChatMainInputSession {
  const inputRow = deps.promptFrame.promptBottomRow;
  const getPromptFrame = (): PromptFrame => deps.getPromptFrame?.() ?? deps.promptFrame;
  const getInputRow = (): number => getPromptFrame().promptBottomRow;
  // Match the prompt-frame divider width exactly. Narrowing the input
  // surface by 2 cells made picker separators and overlays stop short
  // of the full-width divider, which reads like the border width
  // flickered when slash/search pickers appear.
  const inputWidth = deps.inputCols;
  const getInputWidth = (): number => deps.getInputCols?.() ?? inputWidth;

  const paintChrome = () => {
    const divider = hLine(getInputWidth());
    for (const row of deps.buildPromptFrameDividerRows(getPromptFrame(), divider)) {
      deps.invalidateRenderCacheRow(row.row - 1);
      process.stdout.write(ansi.moveTo(row.row, 1) + '\x1b[2K' + row.text);
    }
  };

  const shouldPaint = () => deps.shouldPaint();

  const register = () => {
    deps.surfaceRegistry.register({
      addr: CHAT_MAIN_INPUT_ADDR,
      kindTag: 'chat-main-input',
      title: 'chat-main',
      visible: true,
    });
    deps.debugLog?.('input.surface.register', 'chat-main', {
      inputId: 'chat-main',
      row: getInputRow(),
      width: getInputWidth(),
    });
  };

  const unregister = () => {
    try { deps.surfaceRegistry.unregister(CHAT_MAIN_INPUT_ADDR); } catch { /* ignore */ }
    deps.debugLog?.('input.surface.dispose', 'chat-main', { inputId: 'chat-main' });
  };

  return {
    inputRow,
    getInputRow,
    inputWidth,
    getInputWidth,
    paintChrome,
    shouldPaint,
    register,
    unregister,
  };
}
