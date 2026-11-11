import { createNextTuiCoreInput } from '../tui/core/input.js';

export interface NextTuiCoreInputSimResult {
  readonly previousPrompt: string;
  readonly restoredDraft: string;
  readonly historyIndex: number;
  readonly foldedPaste: string;
  readonly expandedPaste: string;
  readonly heldAfterSubmit: number;
  readonly heldAfterDeletion: number;
  readonly queuedPasteExpanded: string;
  readonly heldQueuedAfterDeletion: number;
  readonly heldQueuedAfterSubmit: number;
}

function key(name: string, options: { ctrl?: boolean; paste?: string } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    shift: false,
    raw: name,
    ...(options.paste !== undefined ? { paste: options.paste } : {}),
  };
}

/** Drive the production Next TUI input controller through deterministic keyboard and paste events. */
export function simulateNextTuiCoreInput(): NextTuiCoreInputSimResult {
  const input = createNextTuiCoreInput();
  const apply = (pressed: ReturnType<typeof key>) => {
    const result = input.applyKey(pressed);
    input.noteAction(result.action);
    return result;
  };
  for (const character of 'unsent draft') apply(key(character));
  input.browseHistory('up', ['previous prompt']);
  const previousPrompt = input.editor.text;
  input.browseHistory('down', ['previous prompt']);
  const restoredDraft = input.editor.text;
  const historyIndex = input.historyIndex;

  input.setText('');
  const original = '붙여넣기 첫째\n둘째\n셋째\n넷째';
  apply(key('paste', { paste: input.foldPaste(original) }));
  const foldedPaste = input.editor.text;
  const submitted = apply(key('enter')).submitted ?? '';
  const expandedPaste = input.expandSubmission(submitted, [input.editor.text]);
  const heldAfterSubmit = input.heldPasteCount;

  apply(key('paste', { paste: input.foldPaste(original) }));
  apply(key('backspace'));
  const heldAfterDeletion = input.heldPasteCount;

  const queuedInput = createNextTuiCoreInput();
  const inputToken = queuedInput.foldPaste(original);
  const queuedOriginal = '대기열 붙여넣기 첫째\n둘째\n셋째\n넷째';
  const queuedToken = queuedInput.foldPaste(queuedOriginal);
  queuedInput.setText(inputToken);
  queuedInput.applyKey(key('backspace'), [queuedToken]);
  const heldQueuedAfterDeletion = queuedInput.heldPasteCount;
  const queuedPasteExpanded = queuedInput.expandSubmission(queuedToken, [queuedInput.editor.text]);
  const heldQueuedAfterSubmit = queuedInput.heldPasteCount;

  return { previousPrompt, restoredDraft, historyIndex, foldedPaste, expandedPaste, heldAfterSubmit, heldAfterDeletion,
    queuedPasteExpanded, heldQueuedAfterDeletion, heldQueuedAfterSubmit };
}
