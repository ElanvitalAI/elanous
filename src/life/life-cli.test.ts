import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { registerLifeCommands } from './life-cli.js';

afterEach(() => {
  process.exitCode = 0;
});

test('life kinds logs an observable event without changing JSON stdout', async () => {
  const events: unknown[][] = [];
  const eventSpy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { events.push(args); }) as typeof debug.log);
  const output: string[] = [];
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    output.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write);

  try {
    const program = new Command();
    registerLifeCommands(program);
    await program.parseAsync(['life', 'kinds', '--json'], { from: 'user' });

    expect(events).toContainEqual(['life.cli', 'kinds-listed', { count: 4 }]);
    expect(JSON.parse(output.join(''))).toHaveLength(4);
    expect(output.join('')).toContain('"kind":"dev"');
  } finally {
    eventSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
});
