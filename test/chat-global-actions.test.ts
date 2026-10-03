import { describe, expect, test } from 'bun:test';

import { matchTextInputGlobalAction } from '../src/chat/global-actions.js';
import { textInput } from '../src/chat/index.js';
import type { Key } from '../src/tui.js';

function key(name: string, mods: Partial<Key> = {}): Key {
  return { name, ctrl: false, shift: false, ...mods };
}

describe('matchTextInputGlobalAction', () => {
  test('matches shared goto-log and log resize shortcuts', () => {
    expect(matchTextInputGlobalAction(key('g', { ctrl: true }))).toEqual({ kind: 'goto-log' });
    expect(matchTextInputGlobalAction(key('up', { ctrl: true }))).toEqual({ kind: 'resize-log', delta: 1 });
    expect(matchTextInputGlobalAction(key('down', { ctrl: true, shift: true }))).toEqual({ kind: 'resize-log', delta: -5 });
    expect(matchTextInputGlobalAction(key('0', { ctrl: true }))).toEqual({ kind: 'resize-log', delta: 0, reset: true });
  });

  test('matches ctrl+shift global actions with opt-out guards', () => {
    expect(matchTextInputGlobalAction(key('l', { ctrl: true, shift: true }))).toEqual({ kind: 'copy-log-pane' });
    expect(matchTextInputGlobalAction(key('t', { ctrl: true, shift: true }))).toEqual({ kind: 'spawn-terminal-modal' });
    expect(matchTextInputGlobalAction(key('z', { ctrl: true, shift: true }))).toEqual({ kind: 'toggle-log-zoom' });
    expect(matchTextInputGlobalAction(key('t', { ctrl: true, shift: true }), {
      allowSpawnTerminalModal: false,
    })).toBeNull();
    expect(matchTextInputGlobalAction(key('z', { ctrl: true, shift: true }), {
      allowToggleLogZoom: false,
    })).toBeNull();
  });

  test('input consumes Ctrl+C before the global dispatcher, including Korean IME', async () => {
    const chunks: string[] = [];
    const oldWrite = process.stdout.write;
    let globalDispatches = 0;
    const keys = [key('c', { ctrl: true }), key('ㅊ', { ctrl: true })];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = await textInput({
        row: 3, col: 1, width: 80,
        host: { dispatchGlobalAction: () => { globalDispatches++; } },
        readKey: async () => {
          const next = keys.shift();
          if (!next) throw new Error('Ctrl+C was not handled by the input loop');
          return next;
        },
      });
      expect(result).toEqual({ text: '/quit', submitted: true });
      expect(chunks.join('')).toContain('한 번 더 누르면 나갑니다 · /quit');
      expect(globalDispatches).toBe(0);
    } finally {
      process.stdout.write = oldWrite;
    }
  });

  test('includes copy-last-block only when requested', () => {
    expect(matchTextInputGlobalAction(key('y', { ctrl: true }))).toBeNull();
    expect(matchTextInputGlobalAction(key('y', { ctrl: true }), {
      includeCopyLastBlock: true,
    })).toEqual({ kind: 'copy-last-block' });
  });

  // Regression: when 한글 IME is active and user presses Ctrl+Shift+T,
  // ghostty captures via macOS IME → produces 'ㅆ' (Shift+'ㅅ' on the
  // 2-bul layout). The shift bit may or may not be set in the kitty
  // CSI-u modifier mask depending on terminal config — the codepoint
  // already encodes shift. Accept the Korean shifted form with ctrl
  // alone so the chord doesn't silently fail in 한글 IME mode.
  test('matches Ctrl+Shift+T with 한글 shifted jamo (regression)', () => {
    // Standard chord (English / un-shifted Korean) still requires
    // both modifiers.
    expect(matchTextInputGlobalAction(key('ㅅ', { ctrl: true, shift: true }))).toEqual({ kind: 'spawn-terminal-modal' });
    expect(matchTextInputGlobalAction(key('ㅅ', { ctrl: true }))).toBeNull();
    // Korean shifted form 'ㅆ': accept ctrl alone (shift implicit).
    expect(matchTextInputGlobalAction(key('ㅆ', { ctrl: true, shift: true }))).toEqual({ kind: 'spawn-terminal-modal' });
    expect(matchTextInputGlobalAction(key('ㅆ', { ctrl: true }))).toEqual({ kind: 'spawn-terminal-modal' });
  });

  // Regression: 한글 'ㅋ' has no shifted form on the 2-bul layout, so
  // both Z and Shift+Z produce 'ㅋ'. Accept Ctrl+'ㅋ' as Ctrl+Shift+Z
  // regardless of the shift bit. elanous doesn't bind Ctrl+Z anywhere
  // in chat input, so the conflation is moot.
  test('matches Ctrl+Shift+Z with 한글 ㅋ (regression)', () => {
    expect(matchTextInputGlobalAction(key('ㅋ', { ctrl: true, shift: true }))).toEqual({ kind: 'toggle-log-zoom' });
    expect(matchTextInputGlobalAction(key('ㅋ', { ctrl: true }))).toEqual({ kind: 'toggle-log-zoom' });
  });

  // Ctrl+Shift+L(copy-log-pane) — shift 비트가 명시된 경우만. 'ㅣ' ctrl-only 는
  // 한글 IME 의 Ctrl+L 이므로 force-redraw 로 재정의(2026-07-12 대표 지적 —
  // 영문/한글 IME 에 따라 다른 동작이 되던 충돌 해소).
  test('Ctrl+Shift+L copy vs Ctrl+L redraw — 한글 ㅣ 분기', () => {
    expect(matchTextInputGlobalAction(key('ㅣ', { ctrl: true, shift: true }))).toEqual({ kind: 'copy-log-pane' });
    expect(matchTextInputGlobalAction(key('ㅣ', { ctrl: true }))).toEqual({ kind: 'force-redraw' });
  });

  // Ctrl+L(shift 없음) = 화면 클리어+리페인트 — codex clear_terminal ·
  // claude-code app:redraw 관례 정렬. 입력 재진입 semantics 폐기.
  test('Ctrl+L → force-redraw (영문/한글 IME 동일)', () => {
    expect(matchTextInputGlobalAction(key('l', { ctrl: true }))).toEqual({ kind: 'force-redraw' });
    expect(matchTextInputGlobalAction(key('L', { ctrl: true, shift: true }))).toEqual({ kind: 'copy-log-pane' });
  });

  // Regression 2026-05-05 — Alt+M was registered as a global keybinding
  // (`display.registerKeyBinding({ key: 'M-m' })`) but only the
  // dashboard's main input loop drains coordinator key routes. While
  // textInput owns the readKey loop (chat input mode), Alt+M needs the
  // global-action seam. Forensic trace from log/debug-…184601 line
  // 157: `chat.input.readKey ㅡ` with `alt:true` and no follow-up
  // `key.route` event → silently swallowed.
  test('matches Alt+M (provider-rotate-next) with 한글 ㅡ', () => {
    expect(matchTextInputGlobalAction(key('m', { alt: true })))
      .toEqual({ kind: 'provider-rotate-next' });
    expect(matchTextInputGlobalAction(key('M', { alt: true })))
      .toEqual({ kind: 'provider-rotate-next' });
    expect(matchTextInputGlobalAction(key('ㅡ', { alt: true })))
      .toEqual({ kind: 'provider-rotate-next' });
    // Plain m / Ctrl+M / Ctrl+Alt+M shouldn't match — Alt-only.
    expect(matchTextInputGlobalAction(key('m'))).toBeNull();
    expect(matchTextInputGlobalAction(key('m', { ctrl: true }))).toBeNull();
    expect(matchTextInputGlobalAction(key('m', { alt: true, ctrl: true }))).toBeNull();
  });
});
