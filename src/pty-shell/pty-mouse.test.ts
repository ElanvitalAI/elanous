import { expect, test } from 'bun:test';
import { detectMouseMode, encodeSgrMouse, trackPtyMouseOutput, mouseModeForPty, forgetPtyMouseMode, mouseModeOffReason, MOUSE_MODE_OFF_REASON } from './pty-mouse.js';

test('SGR click emits press and release with 1-based coordinates and button codes', () => {
  expect(encodeSgrMouse({ x: 10, y: 5, kind: 'click' })).toBe('\x1b[<0;10;5M\x1b[<0;10;5m');
  expect(encodeSgrMouse({ x: 1, y: 1, kind: 'click', button: 'right' })).toBe('\x1b[<2;1;1M\x1b[<2;1;1m');
  expect(() => encodeSgrMouse({ x: 0, y: 1, kind: 'click' })).toThrow('1-based');
});

test('live PTY mode wins over stale snapshot and is forgotten at exit', () => {
  const handle = { id: 'mouse-mode-unit', snapshot: () => '\x1b[?1000;1006h' };
  expect(mouseModeForPty(handle)).toBe(false);
  expect(mouseModeOffReason(handle)).toBe(MOUSE_MODE_OFF_REASON);
  trackPtyMouseOutput(handle.id, '\x1b[?1000;1006h');
  expect(mouseModeForPty(handle)).toBe(true);
  expect(mouseModeOffReason(handle)).toBeUndefined();
  trackPtyMouseOutput(handle.id, '\x1b[?1000l');
  expect(mouseModeForPty(handle)).toBe(false);
  forgetPtyMouseMode(handle.id);
});

test('scroll emits wheel button 64/65', () => {
  expect(encodeSgrMouse({ x: 1, y: 2, kind: 'scroll-up' })).toBe('\x1b[<64;1;2M');
  expect(encodeSgrMouse({ x: 1, y: 2, kind: 'scroll-down' })).toBe('\x1b[<65;1;2M');
});

test('mode tracker follows split and combined enable/disable of 1000/1002/1003/1006', () => {
  const mode = detectMouseMode('');
  mode.feed('\x1b[?1000h');
  expect(mode.enabled).toBe(false);
  mode.feed('\x1b['); mode.feed('?100'); mode.feed('6h');
  expect(mode.enabled).toBe(true);
  mode.feed('\x1b[?1000l'); expect(mode.enabled).toBe(false);
  mode.feed('\x1b[?1002;1003h'); expect(mode.enabled).toBe(true);
  mode.feed('\x1b[?1002l'); mode.feed('unrelated screen text');
  expect(mode.enabled).toBe(true);
  mode.feed('\x1b[?1003;1006l'); expect(mode.enabled).toBe(false);
  mode.feed('\x1b[?1006h'); expect(mode.enabled).toBe(false);
  mode.feed('\x1b[?1003h'); expect(mode.enabled).toBe(true);
  mode.feed('\x1b[?1006l'); expect(mode.enabled).toBe(false);
  mode.feed('\x1b'); mode.feed('[?1000;1006h'); expect(mode.enabled).toBe(true);
  mode.feed('\x1b[?1000;1003l'); expect(mode.enabled).toBe(false);
});
