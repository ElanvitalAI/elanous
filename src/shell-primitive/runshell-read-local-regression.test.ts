import { expect, test } from 'bun:test';
import { runShell } from './runtime.js';
import { prepareRunnerRunShell } from '../shell-runner/prepare-runshell.js';

test('real runtime and runner admit read-local git without a signing session', async () => {
  for (const sandbox of ['off', 'auto'] as const) {
    const result = await runShell({ command: ['git', 'log', '--oneline'], cwd: '/tmp', sandbox });
    // /tmp need not be a repository; reaching git is the assertion.
    expect(result.outcome).toBe('exit');
    const prepared = await prepareRunnerRunShell({ command: ['git', 'log'], cwd: '/tmp', sandbox });
    expect(prepared).not.toBeNull();
    expect(prepared?.grant).toBeUndefined();
  }
  const outside = await runShell({ command: ['git', 'status'], cwd: '/tmp', approval: 'none' }, true);
  expect(outside.outcome).not.toBe('exit');
});
