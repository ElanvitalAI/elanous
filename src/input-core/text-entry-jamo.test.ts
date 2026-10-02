// U1 · 2026-10-02 — 한글 자모를 «따로» 치면(ㅋㅋ · ㅠㅠ · ㄱㄴ) 채팅 입력에 그 자모가 그대로 들어가야 한다.
// 실측(설치본 0.2.7 · pty): «ㅋㅋㅋ ㅎㅎ ㅠㅠ 감사 ㅏ» → «zzz gg bb 감사 k». 단축키용 QWERTY 이름은 그대로 둔다.
import { describe, expect, test } from 'bun:test';
import { splitKeys } from '../tui.js';
import { resolveTextInputTextAction } from '../chat/input-text-key.js';
import { createInlineEditorState } from './inline-editor.js';
import { keyEventToTextInsertion } from './text-entry.js';

function typeIntoChat(text: string): string {
  let state = createInlineEditorState('');
  for (const ch of [...text]) {
    for (const key of splitKeys(ch)) {
      const action = resolveTextInputTextAction(state, key);
      if (action.kind === 'insert') state = action.next;
    }
  }
  return state.text;
}

describe('lone Hangul jamo stay jamo in text, keep their QWERTY name for hotkeys', () => {
  test('chat composer receives what was typed', () => {
    expect(typeIntoChat('ㅋㅋㅋ ㅎㅎ ㅠㅠ 감사 ㅏ ㄱㄴ ㄲ')).toBe('ㅋㅋㅋ ㅎㅎ ㅠㅠ 감사 ㅏ ㄱㄴ ㄲ');
    expect(typeIntoChat('Hello zZ 가나다 🙂')).toBe('Hello zZ 가나다 🙂');
  });

  test('the parsed key name is still the QWERTY position (hotkeys under the Korean IME)', () => {
    const [key] = splitKeys('ㅋ');
    expect(key?.name).toBe('z');
    expect(key?.raw).toBe('ㅋ');
    const [shifted] = splitKeys('ㄲ');
    expect(shifted?.name).toBe('r');
    expect(shifted?.shift).toBe(true);
  });

  test('KeyEvent composers (sequence) get the jamo too; ctrl/alt chords insert nothing', () => {
    expect(keyEventToTextInsertion({ name: 'z', ctrl: false, shift: false, sequence: 'ㅋ' } as never)).toBe('ㅋ');
    expect(keyEventToTextInsertion({ name: 'z', ctrl: true, shift: false, sequence: 'ㅋ' } as never)).toBeNull();
  });
});
