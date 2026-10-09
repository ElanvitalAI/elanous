import { expect, test } from 'bun:test';
import { defaultListHarnessProcesses } from './harness-cli-command.js';

const ps = [
  '101 1 0.0 01:00 bun /repo/bin/elanous.mjs harness say one',
  '102 1 0.0 01:00 bun /repo/bin/elanous.mjs harness ask two.md',
  '103 1 0.0 01:00 bun /repo/bin/elanous.mjs harness say three',
  '104 1 0.0 01:00 bun /repo/bin/elanous.mjs harness queue tick',
].join('\n');

test('10-08 tick hang: include drops records before any per-process read, and reads past the budget stay unknown', () => {
  let now = 0;
  const reads: number[] = [];
  const observation = defaultListHarnessProcesses({
    psOutput: () => ps, cwdOnly: true, deadlineMs: 250, clock: () => now,
    include: (record) => / harness (?:say|ask) /.test(record.command),
    readCwd: (pid) => { reads.push(pid); now += 200; return { cwd: `/work/${pid}`, cwdStatus: 'observed' }; },
  });
  expect(observation.status).toBe('ok');
  if (observation.status !== 'ok') return;
  // 104 (not a launch) is never read; 103 is past the 250 ms budget, so it is reported unknown rather than waited for.
  expect(reads).toEqual([101, 102]);
  expect(observation.records.map((record) => [record.pid, record.cwdStatus, record.cwdFailureReason ?? null, record.ownership ?? null]))
    .toEqual([[101, 'observed', null, null], [102, 'observed', null, null], [103, 'unknown', 'observation deadline 250ms exceeded', null]]);
});
