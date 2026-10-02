import { expect, test } from 'bun:test';
import { browserUnavailableReason } from './browser-availability.js';
import { readFileSync } from 'node:fs';

test('OB5d — a Mac reached over ssh says why the browser login cannot finish and what to do instead', () => {
  const why = browserUnavailableReason({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.3 22' }, 'darwin');
  expect(why).toContain('원격(ssh) 접속이라 브라우저 로그인을 마칠 수 없습니다');
  expect(why).toContain('이 Mac 화면의 터미널에서 같은 명령을 실행하면 브라우저가 바로 열립니다');
  expect(why).toContain('아래 코드로');
  expect(browserUnavailableReason({ SSH_TTY: '/dev/ttys001' }, 'win32')).toContain('이 PC 화면의 터미널');
});

test('a local Mac or a Linux desktop has no reason (the browser is tried first)', () => {
  expect(browserUnavailableReason({}, 'darwin')).toBeNull();
  expect(browserUnavailableReason({ DISPLAY: ':0' }, 'linux')).toBeNull();
  expect(browserUnavailableReason({ WAYLAND_DISPLAY: 'wayland-0', SSH_CONNECTION: 'x' }, 'linux')).toBeNull();
});

test('a Linux session without a display explains it, naming ssh when that is the cause', () => {
  expect(browserUnavailableReason({}, 'linux')).toContain('화면(디스플레이)이 없는 세션');
  expect(browserUnavailableReason({ SSH_CLIENT: 'x' }, 'linux')).toContain('원격(ssh) 접속이고 화면이 없어');
});

test('availability stays a pure decision and never launches a process', () => {
  const source = readFileSync(new URL('./browser-availability.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/child_process|spawn\s*\(|execFile\s*\(|Bun\.spawn/);
  expect(browserUnavailableReason({ SSH_CONNECTION: 'x' }, 'darwin')).not.toBeNull();
  expect(browserUnavailableReason({}, 'linux')).toContain('화면(디스플레이)');
  expect(browserUnavailableReason({}, 'darwin')).toBeNull();
});
