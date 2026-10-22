import { expect, test } from 'bun:test';
import { BackgroundJobStatus } from './background-job-status.js';

test('session snapshots distinguish live work, completed results, missing promised work, and unknown state', () => {
  const status = new BackgroundJobStatus('session-a');
  expect(status.line()).toBe('');
  expect(status.accept(JSON.stringify({ sessionId: 'session-b', promised: true, running: 4, pending: 2 }))).toBe(false);
  expect(status.line()).toBe('');
  expect(status.accept(JSON.stringify({ sessionId: 'session-a', promised: false, running: 0, pending: 0 }))).toBe(true);
  expect(status.line()).toBe('');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 2, pending: 0 }));
  expect(status.line()).toBe('⧗ 백그라운드 2');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 1, pending: 1 }));
  expect(status.line()).toBe('⧗ 백그라운드 1 · ✓ 백그라운드 끝 1 · 결과 대기');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 0, pending: 1 }));
  expect(status.line()).toBe('✓ 백그라운드 끝 1 · 결과 대기');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 0, pending: 0 }));
  expect(status.line()).toBe('⚠ 약속한 백그라운드 없음');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: false, running: 0, pending: 0 }));
  expect(status.line()).toBe('');
  status.setSessionId('session-c');
  expect(status.snapshot()).toBeNull();
  expect(status.accept('not json')).toBe(false);
  expect(status.accept(JSON.stringify({ sessionId: 'session-c', promised: true, running: -1, pending: 0 }))).toBe(false);
});
