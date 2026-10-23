import { describe, expect, test } from 'bun:test';
import { resolvePtySpecialKey } from './pty-special-keys.js';
import { splitKeys } from '../tui.js';

const EXPECTED_SPECIAL_KEY_BYTES = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
} as const;

describe('PTY special key SSOT', () => {
  test('resolves all canonical names to their exact ANSI bytes', () => {
    for (const [name, bytes] of Object.entries(EXPECTED_SPECIAL_KEY_BYTES)) {
      expect(resolvePtySpecialKey(name)).toBe(bytes);
    }
  });

  test('resolves normalized escape alias to the exact canonical ESC byte', () => {
    expect(resolvePtySpecialKey(' escape ')).toBe('\x1b');
    expect(resolvePtySpecialKey('ESC')).toBe('\x1b');
    expect(resolvePtySpecialKey('escape')).toBe(resolvePtySpecialKey('esc'));
  });

  test('rejects unknown names with available names', () => {
    expect(() => resolvePtySpecialKey('launch-missiles')).toThrow('unknown PTY special key: launch-missiles; available names:');
    expect(() => resolvePtySpecialKey('launch-missiles')).toThrow('escape');
    expect(() => resolvePtySpecialKey('launch-missiles')).toThrow('esc');
  });
});

describe('PTY-KEY-MODIFIERS — 조합 키 인코딩 ⊕ TUI 파서 왕복', () => {
  test.each([
    ['shift+enter', '\x1b[27;2;13~', '\x1b[13;2u'],
    ['alt+enter', '\x1b[27;3;13~', '\x1b[13;3u'],
    ['ctrl+enter', '\x1b[27;5;13~', '\x1b[13;5u'],
    ['ctrl+shift+tab', '\x1b[27;6;9~', '\x1b[9;6u'],
    ['shift+backspace', '\x1b[27;2;127~', '\x1b[127;2u'],
  ])('%s → xterm %j · kitty %j', (name, xterm, kitty) => {
    expect(resolvePtySpecialKey(name)).toBe(xterm);
    expect(resolvePtySpecialKey(name, { encoding: 'kitty' })).toBe(kitty);
  });

  test('화살표·home/end 는 CSI 1;<mod><F> · delete/pageup 은 CSI <n>;<mod>~ (두 인코딩 공통)', () => {
    expect(resolvePtySpecialKey('shift+up')).toBe('\x1b[1;2A');
    expect(resolvePtySpecialKey('alt+left', { encoding: 'kitty' })).toBe('\x1b[1;3D');
    expect(resolvePtySpecialKey('ctrl+end')).toBe('\x1b[1;5F');
    expect(resolvePtySpecialKey('shift+delete')).toBe('\x1b[3;2~');
    expect(resolvePtySpecialKey('ctrl+pagedown')).toBe('\x1b[6;5~');
  });

  test('수식자 없는 키 · ctrl+<글자> 는 예전 바이트 그대로', () => {
    expect(resolvePtySpecialKey('enter')).toBe('\r');
    expect(resolvePtySpecialKey('ctrl+c')).toBe('\x03');
    expect(resolvePtySpecialKey('ctrl+j')).toBe('\n');
  });

  test('모르는 수식자·키·한 글자·프로토타입 이름은 «unknown PTY special key» 로 거부', () => {
    for (const bad of ['hyper+enter', 'shift+nope', 'ctrl+1', 'meta+c', 'ctrl++c', 'shift+', 'constructor+enter', 'shift+constructor', 'shift+__proto__', 'toString+tab']) {
      expect(() => resolvePtySpecialKey(bad)).toThrow(/unknown PTY special key/);
    }
  });

  test('TUI 파서(splitKeys)가 보낸 바이트를 같은 조합 키로 읽는다 — xterm·kitty 둘 다', () => {
    for (const encoding of ['xterm', 'kitty'] as const) {
      const [shiftEnter] = splitKeys(resolvePtySpecialKey('shift+enter', { encoding }));
      expect(shiftEnter).toMatchObject({ name: 'enter', shift: true, ctrl: false, alt: false });
      const [altEnter] = splitKeys(resolvePtySpecialKey('alt+enter', { encoding }));
      expect(altEnter).toMatchObject({ name: 'enter', shift: false, alt: true });
      const [ctrlShiftTab] = splitKeys(resolvePtySpecialKey('ctrl+shift+tab', { encoding }));
      expect(ctrlShiftTab).toMatchObject({ name: 'tab', ctrl: true, shift: true });
    }
  });
});

