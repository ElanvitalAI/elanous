import type { Key } from '../tui.js';

export type TextInputControlAction =
  | { kind: 'none' }
  | { kind: 'newline'; stripTrailingBackslash: boolean }
  | { kind: 'submit' }
  | { kind: 'cancel' }
  | { kind: 'goto-pane' }
  | { kind: 'save' }
  | { kind: 'view-switch'; view: string }
  | { kind: 'arm-chord' };

export interface TextInputControlState {
  currentLine: string;
  cursor: number;
}

export function resolveTextInputControlAction(
  key: Pick<Key, 'name' | 'ctrl' | 'shift'> & { alt?: boolean },
  state: TextInputControlState,
): TextInputControlAction {
  const stripTrailingBackslash =
    key.name === 'enter'
    && state.cursor > 0
    && state.currentLine[state.cursor - 1] === '\\';
  // ⭐ Alt+Enter 도 줄바꿈이다 — kitty 프로토콜을 켠 멀티플렉서(herdr)는 바깥의 `ESC CR` 을
  //    `CSI 13;3u`(alt) 로 바꿔 넘긴다. 종전엔 그 꼴이 «제출»로 떨어져 대체 키가 죽어 있었다.
  const isNewline =
    (key.name === 'enter' && (key.shift || key.alt === true))
    || (key.name === 'j' && key.ctrl)
    || stripTrailingBackslash;

  if (isNewline) {
    return { kind: 'newline', stripTrailingBackslash };
  }
  if (key.name === 'enter' && !key.shift && !key.alt) {
    return { kind: 'submit' };
  }
  if (key.name === 'escape') {
    return { kind: 'cancel' };
  }
  if (key.ctrl && (key.name === 'm' || key.name === 'ㅡ' || key.name === 't' || key.name === 'ㅅ')) {
    return { kind: 'goto-pane' };
  }
  if (key.ctrl && (key.name === 's' || key.name === 'ㄴ')) {
    return { kind: 'save' };
  }
  if (key.ctrl && /^[1-9]$/.test(key.name)) {
    return { kind: 'view-switch', view: key.name };
  }
  // ⭐ 코드 리더 = `Ctrl+X`(⊕ 한글 `ㅌ`). 2026-08-19 에 `Ctrl+B` 에서 옮겼다(대표 지시) —
  //   `Ctrl+B` 를 ***백그라운드 승격***에 쓰기 위해서다(claude-code `task:background` 와 동형).
  //   ⚠️ `Ctrl+X` 는 emacs 계열의 전통적 «접두»이고 claude-code 도 코드 접두로 쓴다.
  //   ⛔ `Ctrl+W` 는 터미널에서 「단어 삭제」라 입력창에서 쓰면 안 된다.
  if (key.ctrl && (key.name === 'x' || key.name === 'ㅌ')) {
    return { kind: 'arm-chord' };
  }
  return { kind: 'none' };
}
