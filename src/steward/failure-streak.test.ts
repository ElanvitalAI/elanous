import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureAlertText, markStageEnd, markStageStart, readFailureStreak, shouldAlert, writeFailureStreak } from './failure-streak.js';

const clock = new Date('2026-10-01T00:00:00.000Z');
function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'steward-streak-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('third consecutive failure alerts once; fourth does not, success resets the alert window', () => fixture(root => {
  for (let n = 1; n <= 4; n++) {
    markStageStart(root, 'triage', clock);
    const state = markStageEnd(root, 'triage', false, 'bad judgment', clock);
    expect(state.consecutive).toBe(n);
    expect(shouldAlert(state, 3)).toBe(n >= 3 && n === 3);
    if (n === 3) { state.alertedAt = clock.toISOString(); writeFailureStreak(root, state); }
  }
  markStageStart(root, 'sync', clock);
  const recovered = markStageEnd(root, 'sync', true, undefined, clock);
  expect(recovered.consecutive).toBe(0);
  expect(recovered.alertedAt).toBeUndefined();
  for (let n = 1; n <= 3; n++) {
    markStageStart(root, 'schedule', clock);
    const state = markStageEnd(root, 'schedule', false, 'again', clock);
    expect(shouldAlert(state, 3)).toBe(n === 3);
  }
}));

test('a killed open stage is counted once when the next stage starts', () => fixture(root => {
  markStageStart(root, 'triage', clock);
  const next = markStageStart(root, 'sync', new Date('2026-10-01T00:10:00.000Z'));
  expect(next).toMatchObject({ consecutive: 1, lastStage: 'triage', lastReason: 'killed or timed out: triage', open: { stage: 'sync', startedAt: '2026-10-01T00:10:00.000Z' } });
  expect(readFailureStreak(root).consecutive).toBe(1);
  markStageEnd(root, 'sync', false, 'sync failed', clock);
  expect(readFailureStreak(root)).toMatchObject({ consecutive: 2, lastStage: 'sync' });
  expect(readFailureStreak(root).open).toBeUndefined();
}));

test('corrupt streak.json starts clean without throwing', () => fixture(root => {
  markStageStart(root, 'sync', clock);
  writeFileSync(join(root, 'steward', 'streak.json'), '{bad json');
  expect(readFailureStreak(root).consecutive).toBe(0);
  expect(markStageStart(root, 'triage', clock)).toMatchObject({ consecutive: 0, open: { stage: 'triage' } });
  expect(JSON.parse(readFileSync(join(root, 'steward', 'streak.json'), 'utf8')).consecutive).toBe(0);
}));

test('alert text masks secrets and bounds the last reason to 120 characters', () => fixture(root => {
  const state = markStageEnd(root, 'triage', false, 'x'.repeat(130), clock);
  expect(failureAlertText(state)).toBe(`스튜어드 연속 실패 1회 · 마지막 triage · ${'x'.repeat(120)} · 로그 /tmp/elanous-loop-steward.log`);
  const secret = 'sk-ant-api03-' + 'a'.repeat(32);
  const masked = markStageEnd(root, 'triage', false, `failed ${secret}`, clock);
  expect(readFailureStreak(root).lastReason).not.toContain(secret);
  expect(failureAlertText(masked)).not.toContain(secret);
}));
