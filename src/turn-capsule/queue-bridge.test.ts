import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue, type PendingTaskNotification } from '../agent/task-notification.js';
import { CAPSULE_FRAME_PREFIX, capsuleDoneTurnEvent, parseCapsuleFrame } from './capsule-frame.js';
import { bridgedCapsuleKind, watchQueueCapsuleDone } from './queue-bridge.js';

const note = (taskId: string, extra: Partial<PendingTaskNotification> = {}): PendingTaskNotification => ({
  taskId, agentName: 'RunShell', label: 'build', state: 'done', output: 'ok', truncated: false,
  durationMs: 3_000, finishedAt: 10_000, parentSessionId: 's-1', ...extra,
});

describe('CAPSULE-B5 — queue-only completions leave as capsule-done frames', () => {
  test('kind by task id: shell: → shell · self-implement-stop: → harness · everything already framed → null', () => {
    expect(bridgedCapsuleKind('shell:h7:1')).toBe('shell');
    expect(bridgedCapsuleKind('self-implement-stop:run-1:task-2')).toBe('harness');
    expect(bridgedCapsuleKind('shell-m1abc-3')).toBeNull();
    expect(bridgedCapsuleKind('shell-watch:h7:2')).toBeNull();
    expect(bridgedCapsuleKind('7f1c2c80-0000-4000-8000-000000000000')).toBeNull();
  });

  test('a real queue: RunShell completion and run-stop → one frame each; A2 capsule, line hit, Agent, other session, supplement → none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b5-bridge-'));
    const queue = new TaskNotificationQueue(join(dir, 'results'), 10_000_000, join(dir, 'queue.json'));
    const lines: string[] = [];
    const watch = watchQueueCapsuleDone('s-1', queue, (line) => { lines.push(line); });
    try {
      queue.enqueue(note('shell:h7:1'));
      queue.enqueue(note('self-implement-stop:run-1:task-2', { agentName: 'self-implement', label: 'fix lint', state: 'error' }));
      queue.enqueue(note('shell-m1abc-3'));
      queue.enqueue(note('shell-watch:h7:2', { state: 'running' }));
      queue.enqueue(note('7f1c2c80-0000-4000-8000-000000000000', { agentName: 'general' }));
      queue.enqueue(note('shell:h9:1', { parentSessionId: 's-2' }));
      queue.enqueue(note('shell:h8:1', { completionDelivery: 'supplement' }));
      const events = lines.map((line) => parseCapsuleFrame(line.slice(CAPSULE_FRAME_PREFIX.length).trimEnd(), 's-1'));
      expect(events).toEqual([
        { type: 'capsule-done', capsuleId: 'shell:h7:1', kind: 'shell', sessionId: 's-1', startedAt: 7_000, endedAt: 10_000, status: 'ok', summary: 'build · ok · 3s' },
        { type: 'capsule-done', capsuleId: 'self-implement-stop:run-1:task-2', kind: 'harness', sessionId: 's-1', startedAt: 7_000, endedAt: 10_000, status: 'failed', summary: 'fix lint · failed · 3s' },
      ]);
      watch.dispose();
      queue.enqueue(note('shell:h7:9'));
      expect(lines.length).toBe(2);
    } finally {
      watch.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


test('B5 emission carries the same event ID the real capsule adapter publishes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b5-correlation-'));
  const queue = new TaskNotificationQueue(join(dir, 'results'), 10_000_000, join(dir, 'queue.json'));
  const log = spyOn(debug, 'log');
  const lines: string[] = [];
  const watch = watchQueueCapsuleDone('s-1', queue, line => { lines.push(line); });
  try {
    queue.enqueue(note('shell:h7:1'));
    const life = log.mock.calls.filter(call => call[0] === 'turn-life' && call[1] === 'turn-life:capsule-done-emitted');
    expect(life).toHaveLength(1);
    expect(life[0]![2]).toMatchObject({ sessionId: 's-1', capsuleId: 'shell:h7:1', eventId: 'capsule-done:shell:h7:1', kind: 'shell' });
    expect(life[0]![2]).not.toHaveProperty('turnId');
    expect(lines).toHaveLength(1);
    const decoded = parseCapsuleFrame(lines[0]!.slice(CAPSULE_FRAME_PREFIX.length).trimEnd(), 's-1');
    expect(decoded?.type).toBe('capsule-done');
    if (decoded?.type === 'capsule-done') expect((life[0]![2] as { eventId: string }).eventId).toBe(capsuleDoneTurnEvent(decoded).id);
  } finally {
    watch.dispose(); log.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
});
