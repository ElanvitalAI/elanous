import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissionRequestJudge } from './mission-request-judge.js';

test('08:05 schedule judges requests on every run without repeating its composite escalation cycle', async () => {
  const previousScheduleId = process.env.CRON_RUN_SCHEDULE_ID;
  const root = await mkdtemp(join(tmpdir(), 'mission-request-judge-'));
  await mkdir(join(root, 'docs/mission-requests'), { recursive: true });
  process.env.CRON_RUN_SCHEDULE_ID = 'e27030c5f0be';
  let cycles = 0;
  try {
    const runCompositeCycle = async () => {
      cycles += 1;
      return { actions: [{ requestId: 'same-request', action: 'escalated' as const, reason: 'same failure' }] };
    };
    const firstRun = await runMissionRequestJudge(['--root', root, '--tick'], { runCompositeCycle });
    const secondRun = await runMissionRequestJudge(['--root', root, '--tick'], { runCompositeCycle });

    expect(cycles).toBe(0);
    expect(firstRun).not.toContain('🔁 복합 회차 1건');
    expect(secondRun).not.toContain('🔁 복합 회차 1건');
    expect(firstRun.at(-1)).toMatch(/^📏 훑은 \d+ · invalid 0$/);
    expect(secondRun.at(-1)).toMatch(/^📏 훑은 \d+ · invalid 0$/);

    process.env.CRON_RUN_SCHEDULE_ID = 'another-schedule';
    delete process.env.CRON_RUN_SCHEDULE_ID;
    const manualTick = await runMissionRequestJudge(['--root', root, '--tick'], { runCompositeCycle });
    expect(cycles).toBe(1);
    expect(manualTick).toContain('🔁 복합 회차 1건');
  } finally {
    if (previousScheduleId === undefined) delete process.env.CRON_RUN_SCHEDULE_ID;
    else process.env.CRON_RUN_SCHEDULE_ID = previousScheduleId;
    await rm(root, { recursive: true, force: true });
  }
});
