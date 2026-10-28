import { afterEach, describe, expect, test } from 'bun:test';
import { AgentRegistry } from './registry.js';

const definition = { name: 'managed-self-implement', systemPrompt: 'managed job' };

describe('AgentRegistry.runManaged', () => {
  test('stamps running and terminal state and notifies once with the rendered result', async () => {
    const registry = new AgentRegistry();
    const task = registry.register(definition, 'feature');
    const terminal: string[] = [];
    const sub = registry.onTaskDone((done) => terminal.push(done.id));
    try {
      const value = await registry.runManaged(task.id, async (signal) => {
        expect(signal.aborted).toBe(false);
        expect(task.state).toBe('running');
        return { runId: 'run-1' };
      }, (result) => `finished ${result.runId}`);
      expect(value).toEqual({ runId: 'run-1' });
      expect(task).toMatchObject({ state: 'done', result: 'finished run-1' });
      expect(task.startedAt).toBeNumber();
      expect(task.finishedAt).toBeNumber();
      expect(terminal).toEqual([task.id]);
    } finally { sub.dispose(); }
  });

  test('registry abort reaches the real managed runner and publishes aborted exactly once', async () => {
    const registry = new AgentRegistry();
    const task = registry.register(definition, 'feature');
    let terminalCount = 0;
    const sub = registry.onTaskDone(() => { terminalCount += 1; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = registry.runManaged(task.id, async (signal) => {
      await blocked;
      if (signal.aborted) throw new Error('cancelled');
      return 'done';
    });
    expect(registry.abort(task.id)).toBe(true);
    release();
    await expect(running).rejects.toThrow('cancelled');
    expect(task.state).toBe('aborted');
    expect(terminalCount).toBe(1);
    sub.dispose();
  });

  test('rejects duplicate lifecycle starts', async () => {
    const registry = new AgentRegistry();
    const task = registry.register(definition, 'feature');
    const running = registry.runManaged(task.id, async () => 'done');
    await running;
    await expect(registry.runManaged(task.id, async () => 'again')).rejects.toThrow('not pending');
  });
});
