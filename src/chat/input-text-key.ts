import { applyInlineEditorKey } from '../input-core/inline-editor-key.js';
import type { InlineEditorState } from '../input-core/inline-editor.js';
import type { Key } from '../tui.js';

const NON_TEXT_NAMED_KEYS = new Set([
  '',
  'backspace',
  'enter',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'mouse',
]);

export type TextInputTextAction =
  | { kind: 'none' }
  | { kind: 'insert'; next: InlineEditorState };

export function resolveTextInputTextAction(
  state: InlineEditorState,
  key: Pick<Key, 'name' | 'ctrl' | 'shift'>,
): TextInputTextAction {
  if (key.ctrl && key.name !== 'w' && key.name !== 'left' && key.name !== 'right') {
    return { kind: 'none' };
  }
  if (!key.ctrl && NON_TEXT_NAMED_KEYS.has(key.name)) {
    return { kind: 'none' };
  }

  const next = applyInlineEditorKey(state, key, { tab: '  ' });
  if (!next) {
    return { kind: 'none' };
  }
  return { kind: 'insert', next };
}
