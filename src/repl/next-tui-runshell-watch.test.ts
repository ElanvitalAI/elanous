import { expect, test } from 'bun:test';
import { globalTaskNotificationQueue } from '../agent/task-notification.js';
import { CAPSULE_FRAME_PREFIX, parseCapsuleFrame } from '../turn-capsule/capsule-frame.js';
import { watchShellLineFrames } from '../turn-capsule/shell-watch-frame.js';
import { buildReplTools } from './index.js';

test('Next TUI offers RunShell with its background line-watch inputs', () => {
  const tools = buildReplTools();
  const spec = tools.specs.find(tool => tool.name === 'RunShell');
  expect(spec).toBeDefined();
  expect(spec?.parameters.properties).toHaveProperty('watchPattern');
  expect(spec?.parameters.properties).toHaveProperty('watchMinLines');
});

test('RunShell cannot bypass approval or silently ignore a requested sandbox', async () => {
  const tools = buildReplTools();
  expect(await tools.dispatch('RunShell', { command: ['echo', 'test'], mode: 'bg', approval: 'always' }))
    .toEqual({ error: 'Bash blocked: human approval channel is unavailable.' });
  expect(await tools.dispatch('RunShell', { command: ['echo', 'test'], mode: 'bg', sandbox: 'strict' }))
    .toEqual({ error: 'RunShell runner cannot enforce the requested sandbox.' });
});

test('a real background RunShell match becomes one session-scoped progress frame', async () => {
  const frames: string[] = [];
  const stop = watchShellLineFrames('o1-test', globalTaskNotificationQueue, frame => frames.push(frame));
  try {
    const tools = buildReplTools();
    const result = await tools.dispatch('RunShell', {
      command: ['sh', '-c', 'sleep 0.2; echo O1_IGNORE; sleep 0.2; echo O1_MATCH; sleep 0.2'],
      mode: 'bg', watchPattern: '^O1_MATCH$', approval: 'none',
    }) as { outcome?: string };
    expect(result.outcome).toBe('started');
    const deadline = Date.now() + 5000;
    while (frames.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(frames).toHaveLength(1);
    const event = parseCapsuleFrame(frames[0]!.slice(CAPSULE_FRAME_PREFIX.length), 'o1-test');
    expect(event).toMatchObject({ type: 'capsule-progress', kind: 'shell', sessionId: 'o1-test' });
    expect(event?.type === 'capsule-progress' && event.line).toContain('O1_MATCH');
    expect(event?.type === 'capsule-progress' && event.line).not.toContain('O1_IGNORE');
    await Bun.sleep(300);
    expect(frames).toHaveLength(1);
  } finally { stop(); }
}, 10_000);
