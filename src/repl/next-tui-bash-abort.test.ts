import { expect, test } from 'bun:test';
import { buildReplTools } from './index.js';
import { dispatchBash } from '../skills/tools/index.js';

test('Next turn abort stops a running Bash child and settles within five seconds', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const tools = buildReplTools({
    getSignal: () => controller.signal,
    dispatchBash: (args, options) => {
      started();
      return dispatchBash(args, options);
    },
  });
  const pending = tools.dispatch('Bash', { command: 'sleep 20 & child=$!; echo "child_pid=$child"; wait "$child"' });
  await dispatched;
  await Bun.sleep(100);
  controller.abort(); // Next TUI Esc → confirmed stop reaches this turn signal.
  const result = await Promise.race([
    pending,
    Bun.sleep(5_000).then(() => { throw new Error('Bash child did not settle within five seconds'); }),
  ]) as { aborted?: boolean; stdout?: string };
  expect(result.aborted).toBe(true);
  const childPid = Number(result.stdout?.match(/child_pid=(\d+)/)?.[1]);
  expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
  expect(() => process.kill(childPid, 0)).toThrow();
}, 10_000);
