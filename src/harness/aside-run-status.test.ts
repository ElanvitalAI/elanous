import { expect, test } from 'bun:test';
import { classifyAsideRun } from './aside-run-status.js';

test('stderr의 앱 부재는 인증 timeout 문장보다 먼저 not-running으로 판정한다', () => {
  const status = classifyAsideRun({ stdout: '', stderr: "Failed to request daemon auth challenge: The operation was aborted due to timeout\nAside isn't running on this machine.", exitCode: 1 });
  expect(status.kind).toBe('not-running');
  expect(status.hint).toContain('Aside 브라우저를 켜고 다시 · 또는 `aside exec --host <host>`');
});

test('앱 부재 문장 없이 daemon auth challenge timeout은 auth-timeout', () => {
  expect(classifyAsideRun({ stdout: '', stderr: 'Failed to request daemon auth challenge: The operation was aborted due to timeout', exitCode: 1 }).kind).toBe('auth-timeout');
});

test('끝의 ANSI error 표지는 repl-error', () => {
  expect(classifyAsideRun({ stdout: 'ReferenceError\n\x1b[2m[error | 12ms]\x1b[0m', stderr: '', exitCode: 1 }).kind).toBe('repl-error');
});

test('완료 표지가 없으면 no-marker', () => {
  expect(classifyAsideRun({ stdout: '{"title":"page"}', stderr: '', exitCode: 1 }).kind).toBe('no-marker');
});

test('정상 JSON과 끝 ok 표지는 종료 코드와 별개로 ok', () => {
  const output = { stdout: '{"title":"page"}\n[ok | 12ms]', stderr: '' };
  expect(classifyAsideRun({ ...output, exitCode: 0 }).kind).toBe('ok');
  expect(classifyAsideRun({ ...output, exitCode: 1 }).kind).toBe('ok');
});

test('실패 종료의 환경 진단은 표지보다 먼저 판정하고, 정상 종료의 같은 문구는 진단하지 않는다', () => {
  const output = { stdout: '[ok | 12ms]', stderr: "Aside isn't running on this machine." };
  expect(classifyAsideRun({ ...output, exitCode: 1 }).kind).toBe('not-running');
  expect(classifyAsideRun({ ...output, exitCode: 0 }).kind).toBe('ok');
  expect(classifyAsideRun({ stdout: '[ok | 12ms]', stderr: 'daemon auth challenge timeout', exitCode: 1 }).kind).toBe('auth-timeout');
  expect(classifyAsideRun({ stdout: '[ok | 12ms]', stderr: 'daemon auth challenge timeout', exitCode: 0 }).kind).toBe('ok');
});

test('페이지 제목의 Aside 미실행 문구는 실행 진단이 아니다', () => {
  expect(classifyAsideRun({ stdout: '{"title":"Aside isn\'t running","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\n[ok | 12ms]', stderr: '', exitCode: 0 })).toEqual({ kind: 'ok' });
});

test('페이지 제목의 auth timeout 문구도 실행 진단이 아니다', () => {
  expect(classifyAsideRun({ stdout: '{"title":"daemon auth challenge timeout","bodyLength":88,"unloadedImageCount":0,"screenshotBytes":11}\n[ok | 12ms]', stderr: '', exitCode: 0 })).toEqual({ kind: 'ok' });
});

test('killed at our timeout with no output is «not answering», not a missing marker', () => {
  expect(classifyAsideRun({ stdout: '', stderr: '', exitCode: null, timedOut: true }).kind).toBe('auth-timeout');
  expect(classifyAsideRun({ stdout: '{"title":"x"}\n', stderr: '', exitCode: null, timedOut: true }).kind).toBe('no-marker');
});
