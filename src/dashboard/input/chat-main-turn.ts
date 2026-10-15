import { textInput, type InputResult } from '../../chat/index.js';
import { ansi, resetRenderCache } from '../../tui.js';
import type { ChatMainInputSession } from './chat-main-session.js';

export type ChatMainTextInputBaseOpts = Omit<
  Parameters<typeof textInput>[0],
  'row' | 'getRow' | 'col' | 'width' | 'getWidth' | 'prompt' | 'maxLines' | 'initialText' | 'history' | 'onPaintChrome' | 'shouldPaint' | 'placeholder' | 'preferHistoryArrowKeys'
>;

export interface RunChatMainInputTurnDeps {
  session: ChatMainInputSession;
  initialText?: string;
  preferHistoryArrowKeys?: boolean;
  history: string[];
  placeholder: string;
  textInputOpts: ChatMainTextInputBaseOpts;
}

export function buildChatMainTextInputRequest(
  deps: RunChatMainInputTurnDeps,
): Parameters<typeof textInput>[0] {
  return {
    row: deps.session.getInputRow(),
    getRow: deps.session.getInputRow,
    col: 1,
    width: deps.session.inputWidth,
    getWidth: deps.session.getInputWidth,
    prompt: '\u276f ',
    maxLines: 8,
    onPaintChrome: deps.session.paintChrome,
    shouldPaint: deps.session.shouldPaint,
    ...(deps.initialText ? { initialText: deps.initialText } : {}),
    preferHistoryArrowKeys: deps.preferHistoryArrowKeys,
    history: deps.history,
    placeholder: deps.placeholder,
    ...deps.textInputOpts,
  };
}

export async function runChatMainInputTurn(
  deps: RunChatMainInputTurnDeps,
): Promise<InputResult> {
  resetRenderCache();
  process.stdout.write(ansi.moveTo(deps.session.getInputRow(), 1) + '\x1b[2K');
  deps.session.register();
  try {
    return await textInput(buildChatMainTextInputRequest(deps));
  } finally {
    deps.session.unregister();
  }
}
