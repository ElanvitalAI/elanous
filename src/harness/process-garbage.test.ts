import { describe, expect, test } from 'bun:test';
import { classifyGarbage, isGarbageProcessTarget, type GarbageProcessRow } from './process-garbage.js';

const daemon = 'bun /tmp/elanous-nexus-cli-X/daemon.ts /private/tmp/elanous-nexus-cli-X/.elanous-test';
const production = 'bun /opt/current/node_modules/elanous/bin/elanous.mjs nexus run';
const runner = 'bun test /tmp/elanous/repo.worktrees/self-impl/test/gate.test.ts';

function row(pid: number, command: string, overrides: Partial<GarbageProcessRow> = {}): GarbageProcessRow {
  return { pid, ppid: 1, elapsedSeconds: 3 * 3600, command, ...overrides };
}

describe('classifyGarbage', () => {
  test('classifies orphan test daemons, gate runners, and elanous while leaving unrelated ps rows outside the population', () => {
    const rows = [
      row(10, daemon),
      row(11, runner),
      row(12, 'bun /tmp/elanous/repo.worktrees/self-impl/scripts/gate-baseline.ts'),
      row(13, 'bun bin/elanous.mjs --test harness processes'),
      row(14, 'bun /tmp/scratchpad/worker.ts'),
    ];
    expect(rows.map((item) => isGarbageProcessTarget(item.command))).toEqual([true, true, true, true, false]);
    expect(classifyGarbage(rows, { nowMs: 1_000_000 }).garbage.map(({ pid, reason }) => ({ pid, reason }))).toEqual([
      { pid: 10, reason: 'orphan-test-daemon' },
      { pid: 11, reason: 'orphan-test-runner' },
      { pid: 12, reason: 'orphan-test-runner' },
      { pid: 13, reason: 'orphan-elanous' },
    ]);
  });

  test('three hours is inclusive by default; a thirty-minute orphan or living child is not garbage', () => {
    expect(classifyGarbage([
      row(1, daemon, { elapsedSeconds: 1800 }),
      row(2, daemon, { elapsedSeconds: 10_799 }),
      row(3, daemon, { elapsedSeconds: 10_800 }),
      row(4, runner, { ppid: 45 }),
    ]).garbage.map(({ pid }) => pid)).toEqual([3]);
    expect(classifyGarbage([row(5, runner, { elapsedSeconds: 1800 })], { minOrphanSeconds: 1800 }).garbage)
      .toMatchObject([{ pid: 5, reason: 'orphan-test-runner' }]);
  });

  test('operational nexus and launchd-managed PIDs never become garbage, including test-marked PIDs', () => {
    expect(classifyGarbage([
      row(20, production),
      row(21, `${production} --test`),
      row(22, daemon, { launchd: 'managed' }),
      row(23, 'bun bin/elanous.mjs --test harness processes', { launchd: 'managed' }),
      row(24, 'bun /tmp/daemon.ts --test'),
    ]).garbage.map(({ pid }) => pid)).toEqual([21]);
  });
});
