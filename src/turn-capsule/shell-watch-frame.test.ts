import { expect, test } from 'bun:test';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { CAPSULE_FRAME_PREFIX, parseCapsuleFrame } from './capsule-frame.js';
import { watchShellLineFrames } from './shell-watch-frame.js';

test('only this session’s watched running lines leave as progress, not completion', () => {
  const queue = new TaskNotificationQueue();
  const frames: string[] = [];
  const dispose = watchShellLineFrames('s1', queue, frame => frames.push(frame));
  const base = { agentName: 'RunShell', output: 'line=O1_MATCH', truncated: false, durationMs: 7, finishedAt: 10 };
  queue.enqueue({ ...base, taskId: 'shell-watch:h:1', parentSessionId: 's1', state: 'running' });
  queue.enqueue({ ...base, taskId: 'shell-watch:h:2', parentSessionId: 's2', state: 'running' });
  queue.enqueue({ ...base, taskId: 'shell:h:1', parentSessionId: 's1', state: 'done' });
  expect(frames).toHaveLength(1);
  expect(parseCapsuleFrame(frames[0]!.slice(CAPSULE_FRAME_PREFIX.length), 's1')).toMatchObject({
    type: 'capsule-progress', capsuleId: 'shell-watch:h:1', kind: 'shell', line: 'line=O1_MATCH',
  });
  expect(parseCapsuleFrame(frames[0]!.slice(CAPSULE_FRAME_PREFIX.length), 's2')).toBeNull();
  dispose();
  queue.enqueue({ ...base, taskId: 'shell-watch:h:3', state: 'running' });
  expect(frames).toHaveLength(1);
});
