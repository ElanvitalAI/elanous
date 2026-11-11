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
  expect(status.line()).toBe('⧗ 백그라운드 1 · ✓ 결과 대기 1');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 0, pending: 1 }));
  expect(status.line()).toBe('✓ 결과 대기 1');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 0, pending: 0 }));
  expect(status.line()).toBe('⚠ 약속한 백그라운드 없음');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: false, running: 0, pending: 0 }));
  expect(status.line()).toBe('');
  status.setSessionId('session-c');
  expect(status.snapshot()).toBeNull();
  expect(status.accept('not json')).toBe(false);
  expect(status.accept(JSON.stringify({ sessionId: 'session-c', promised: true, running: -1, pending: 0 }))).toBe(false);
});

test('restores last observed job state when switching back to a session', () => {
  const status = new BackgroundJobStatus('session-a');
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: true, running: 2, pending: 0 }));
  status.setSessionId('session-b');
  expect(status.snapshot()).toBeNull();
  status.accept(JSON.stringify({ sessionId: 'session-b', promised: false, running: 0, pending: 1 }));
  status.setSessionId('session-a');
  expect(status.snapshot()).toEqual({ sessionId: 'session-a', promised: true, running: 2, pending: 0 });
  status.setSessionId('session-b');
  expect(status.snapshot()).toEqual({ sessionId: 'session-b', promised: false, running: 0, pending: 1 });
});

test('keeps each background Agent ID and terminal state for a five-task roster', () => {
  const status = new BackgroundJobStatus('session-a');
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    id: `task-${index}-unique`, label: `worker ${index}`, state: index === 0 ? 'done' : index === 1 ? 'error' : 'running',
  }));
  expect(status.accept(JSON.stringify({ sessionId: 'session-a', promised: false, running: 3, pending: 2, tasks }))).toBe(true);
  expect(status.taskLines()).toEqual([
    'task-0-u · worker 0 · done', 'task-1-u · worker 1 · failed',
    'task-2-u · worker 2 · running', 'task-3-u · worker 3 · running', 'task-4-u · worker 4 · running',
  ]);
  expect(status.resolveTask('task-3')).toBe('task-3-unique');
  expect(status.resolveTask('task-')).toBeNull();
});

test('eight-character ID collisions display selectable unique prefixes', () => {
  const status = new BackgroundJobStatus('session-a');
  const first = 'abcdef01-a111-4111-8111-111111111111';
  const second = 'abcdef01-b222-4222-8222-222222222222';
  status.accept(JSON.stringify({ sessionId: 'session-a', promised: false, running: 2, pending: 0, tasks: [
    { id: first, label: 'first worker', state: 'running' },
    { id: second, label: 'second worker', state: 'running' },
  ] }));
  expect(status.taskLines()).toEqual([
    'abcdef01-a · first worker · running',
    'abcdef01-b · second worker · running',
  ]);
  expect(status.resolveTask('abcdef01')).toBeNull();
  expect(status.resolveTask(status.displayTaskId(first))).toBe(first);
  expect(status.resolveTask(status.displayTaskId(second))).toBe(second);
});
