import { expect, spyOn, test } from 'bun:test';
import { completedNestedAgents, createNextTuiBackgroundBridge } from './index.js';
import type { AgentTask } from '../agent/types.js';

test('only completed descendants of this session roots enter the persistent frame', () => {
  const task = (id: string, parentTaskId?: string, state: AgentTask['state'] = 'done') => ({
    id, parentTaskId, state, label: id, definition: { name: id },
  }) as AgentTask;
  const tasks = [task('ours'), task('child', 'ours'), task('grandchild', 'child'),
    task('other'), task('foreign-grandchild', 'other'), task('pending', 'ours', 'running')];
  expect(completedNestedAgents(tasks, new Set(['ours']))).toEqual([
    { id: 'child', description: '↳ child', status: 'done' },
    { id: 'grandchild', description: '↳ grandchild', status: 'done' },
  ]);
  // At the next turn boundary the root set is replaced, even if a
  // grandchild from that tree is still running.
  expect(completedNestedAgents(tasks, new Set())).toEqual([]);
  tasks[5]!.state = 'done';
  expect(completedNestedAgents(tasks, new Set(['other']))).toEqual([
    { id: 'foreign-grandchild', description: '↳ foreign-grandchild', status: 'done' },
  ]);
});

test('an unregistered Agent promise remains visible across later turns', () => {
  const previous = process.env.ELANOUS_NEXT_TUI_BG_STATUS;
  process.env.ELANOUS_NEXT_TUI_BG_STATUS = '1';
  const frames: Array<{ promised: boolean; running: number }> = [];
  const write = spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    const line = String(chunk);
    if (line.startsWith('ELANOUS_TUI_BG_STATUS\t')) frames.push(JSON.parse(line.slice('ELANOUS_TUI_BG_STATUS\t'.length)));
    return true;
  });
  const bridge = createNextTuiBackgroundBridge('promise-session', () => 0);
  try {
    expect(bridge).not.toBeNull();
    bridge!.observeToolResult('Agent', { run_in_background: true }, { taskId: 'missing-registration', background: true });
    expect(frames.at(-1)?.promised).toBe(true);
    bridge!.beginTurn();
    bridge!.emit();
    expect(frames.at(-1)?.promised).toBe(true);
    bridge!.beginTurn();
    expect(frames.at(-1)?.promised).toBe(true);
    expect(frames.at(-1)?.running).toBe(0);
  } finally {
    bridge?.dispose();
    write.mockRestore();
    // Keep the test independent of the developer's optional TUI bridge setting.
    if (previous === undefined) delete process.env.ELANOUS_NEXT_TUI_BG_STATUS;
    else process.env.ELANOUS_NEXT_TUI_BG_STATUS = previous;
  }
});
