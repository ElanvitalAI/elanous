import { expect, spyOn, test } from 'bun:test';
import * as core from '../../../core-turn/run-core-turn.js';
import * as registry from '../../../tool-runtime/registry.js';
import { withSimClock } from '../../fake-clock.js';
import { simWorldScenarios } from './c7-mcp.js';

test('C7 cleans up and reports a probe that never reaches the MCP client', async () => {
  let registered = '';
  const register = spyOn(registry, 'registerToolRuntime');
  const original = register.getMockImplementation();
  register.mockImplementation(rt => { registered = rt.id; return original!(rt); });
  let turnSignal: AbortSignal | undefined;
  const run = spyOn(core, 'runCoreTurn').mockImplementation(ctx => {
    turnSignal = ctx.signal;
    return new Promise(() => {});
  });
  try {
    await withSimClock(0, async clock => {
      const scene = simWorldScenarios[0]!;
      const outcome = scene.run({ recorder: { event() {} } } as never);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(registered).not.toBe('');
      await clock.tickAndFlushMicrotasks(5_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await clock.tickAndFlushMicrotasks(1_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const race = Promise.race([outcome.then(() => 'unexpected success', error => String(error.message)),
        new Promise<string>(resolve => setTimeout(() => resolve('hung'), 50))]);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await clock.tickAndFlushMicrotasks(50);
      expect(await race).toBe('C7 MCP turn did not settle after cleanup abort');
      expect(turnSignal?.aborted).toBe(true);
      expect(registry.getToolRuntime(registered)).toBeUndefined();
    });
  } finally {
    run.mockRestore();
    register.mockRestore();
    if (registered) registry.unregisterToolRuntime(registered);
  }
});
