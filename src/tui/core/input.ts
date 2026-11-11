import { createPasteFold } from '../../chat/paste-fold.js';
import { createInlineEditorState, type InlineEditorState } from '../../input-core/inline-editor.js';
import { applyComposerKey, emptyComposer } from '../input/composer.js';

type ComposerKey = Parameters<typeof applyComposerKey>[1];
type HistoryKey = 'up' | 'down';

export interface NextTuiCoreInput {
  readonly editor: InlineEditorState;
  readonly historyIndex: number;
  readonly heldPasteCount: number;
  setEditor(editor: InlineEditorState): void;
  setText(text: string): void;
  clearHistory(): void;
  foldKey(key: ComposerKey): ComposerKey;
  foldPaste(text: string): string;
  applyKey(key: ComposerKey, liveTexts?: readonly string[]): ReturnType<typeof applyComposerKey>;
  noteAction(action: ReturnType<typeof applyComposerKey>['action']): void;
  browseHistory(key: HistoryKey, prompts: readonly string[]): boolean;
  expandSubmission(submitted: string, liveTexts: readonly string[]): string;
  retainLivePasteTokens(liveTexts: readonly string[]): number;
}

/** Editor, paste and previous-prompt state owned by the next-TUI input loop. */
export function createNextTuiCoreInput(): NextTuiCoreInput {
  let editor = emptyComposer();
  let historyIndex = 0;
  let draft = '';
  const pasteFold = createPasteFold();

  return {
    get editor() { return editor; },
    get historyIndex() { return historyIndex; },
    get heldPasteCount() { return pasteFold.size(); },
    setEditor(next) { editor = next; },
    setText(text) { editor = createInlineEditorState(text); },
    clearHistory() {
      historyIndex = 0;
      draft = '';
    },
    foldKey(key) {
      return key.name === 'paste' && typeof key.paste === 'string'
        ? { ...key, paste: pasteFold.fold(key.paste) }
        : key;
    },
    foldPaste(text) { return pasteFold.fold(text); },
    applyKey(key, liveTexts = []) {
      const result = applyComposerKey(editor, key);
      editor = result.state;
      if (result.action === 'edit') pasteFold.retainOnly([editor.text, ...liveTexts]);
      return result;
    },
    noteAction(action) {
      if (action === 'edit' || action === 'cancel' || action === 'submit') historyIndex = 0;
    },
    browseHistory(key, prompts) {
      if (prompts.length === 0 || (key === 'down' && historyIndex === 0)) return true;
      if (key === 'up' && historyIndex === 0) draft = editor.text;
      historyIndex = Math.max(0, Math.min(prompts.length, historyIndex + (key === 'up' ? 1 : -1)));
      editor = createInlineEditorState(historyIndex === 0 ? draft : prompts[prompts.length - historyIndex]!);
      return true;
    },
    expandSubmission(submitted, liveTexts) {
      const expanded = pasteFold.expand(submitted);
      pasteFold.retainOnly(liveTexts);
      return expanded;
    },
    retainLivePasteTokens(liveTexts) { return pasteFold.retainOnly(liveTexts); },
  };
}
