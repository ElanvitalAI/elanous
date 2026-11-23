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
  // With a grant route (seat identity) only a hold-class argv (here destructive) still needs the signed grant;
  // a non-destructive non-local argv runs (CEO 11-23 relax).
  const prevTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'test-seat';
  try {
    const destructive = await runShell({ command: ['git', 'push', '--force', 'origin', 'main'], cwd: '/tmp', approval: 'none' }, true);
    expect(destructive.outcome).toBe('denied');
    const outside = await runShell({ command: ['git', 'status'], cwd: '/tmp', approval: 'none' }, true);
    expect(outside.outcome).toBe('exit');
  } finally {
    if (prevTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prevTrack;
  }
});
