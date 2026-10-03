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

  test('goal text inside orchestrator arguments is not a test runner', () => {
    const command = 'bun bin/elanous.mjs self orchestrate --goal-file x.md "판정 신호: bun test /tmp/elanous"';
    expect(classifyGarbage([row(44, command)]).garbage).toMatchObject([{ pid: 44, reason: 'orphan-elanous' }]);
    expect(classifyGarbage([row(45, runner)]).garbage).toMatchObject([{ pid: 45, reason: 'orphan-test-runner' }]);
  });

  test('gate runners keep being classified — `bun run gate-baseline …` and `bun scripts/…gate….ts` (PROC1 round 3)', () => {
    expect(classifyGarbage([row(46, 'bun run gate-baseline /tmp/repo.worktrees/x')]).garbage).toMatchObject([{ pid: 46, reason: 'orphan-test-runner' }]);
    expect(classifyGarbage([row(47, '/Users/me/.bun/bin/bun gate-baseline /tmp/repo.worktrees/y')]).garbage).toMatchObject([{ pid: 47, reason: 'orphan-test-runner' }]);
    expect(classifyGarbage([row(48, 'bun scripts/ci-gate.ts /tmp/repo.worktrees/z')]).garbage).toMatchObject([{ pid: 48, reason: 'orphan-test-runner' }]);
    // The same words inside goal text in an orchestrator's argv are not a gate runner.
    expect(classifyGarbage([row(49, 'bun bin/elanous.mjs self orchestrate "관측 = bun run gate-baseline /tmp/repo.worktrees/q"')]).garbage)
      .toMatchObject([{ pid: 49, reason: 'orphan-elanous' }]);
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
