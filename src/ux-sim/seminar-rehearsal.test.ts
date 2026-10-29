import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSeminarRehearsal, SEMINAR_SCENES, seminarRehearsalSweep, simSeminarRehearsal, type SeminarSceneRecord } from './seminar-rehearsal.js';

function fullPassRecords(): SeminarSceneRecord[] {
  return SEMINAR_SCENES.map((scene) => ({
    scene: scene.id,
    elapsedMinutes: scene.targetMinutes,
    medium: `mock-medium-${scene.id}`,
    evidenceId: `mock-evidence-${scene.id}`,
    outcome: 'pass',
    publicSafe: true,
    fallbackUsed: false,
    offlineFallbackPlayed: null,
  }));
}

describe('simSeminarRehearsal', () => {
  test('simulates seven ordered scenes and the 40-minute target without claiming a real event', () => {
    const result = seminarRehearsalSweep();
    expect(result).toMatchObject({ simulated: true, totalTargetMinutes: 40, verdict: 'pass' });
    expect(result.scenes.map((scene) => scene.scene)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(renderSeminarRehearsal(result)[0]).toContain('실제 행사 실행 증거 아님');
  });

  test('missing evidence stays unknown instead of becoming a pass', () => {
    const records = fullPassRecords();
    records.splice(3, 1);
    const result = simSeminarRehearsal(records);
    expect(result.verdict).toBe('unknown');
    expect(result.scenes[3]).toMatchObject({ verdict: 'unknown', observedMinutes: null });
  });

  test('runbook scene targets match the simulator and ±1 minute passes while ±2 fails', () => {
    const storyline = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'marketing', 'STORYLINE-ceo-seminar-2026-10-27.md'), 'utf8');
    const targets = [...storyline.matchAll(/^\|\s*(\d+)\s*\|\s*(\d+)[–-](\d+)\s*\|/gm)].map((match) => ({ id: Number(match[1]), minutes: Number(match[3]) - Number(match[2]) }));
    expect(targets).toEqual(SEMINAR_SCENES.map((scene) => ({ id: scene.id, minutes: scene.targetMinutes })));

    const withinBoundary = fullPassRecords();
    withinBoundary[0] = { ...withinBoundary[0]!, elapsedMinutes: 4 };
    expect(simSeminarRehearsal(withinBoundary).scenes[0]?.verdict).toBe('pass');
    withinBoundary[0] = { ...withinBoundary[0]!, elapsedMinutes: 5 };
    expect(simSeminarRehearsal(withinBoundary).scenes[0]?.verdict).toBe('fail');
  });

  test('time overrun, unsafe disclosure, and unplayed fallback fail the simulated rehearsal', () => {
    const overrun = fullPassRecords();
    overrun[1] = { ...overrun[1]!, elapsedMinutes: 7 };
    expect(simSeminarRehearsal(overrun).scenes[1]?.verdict).toBe('fail');

    const unsafe = fullPassRecords();
    unsafe[5] = { ...unsafe[5]!, publicSafe: false };
    expect(simSeminarRehearsal(unsafe).scenes[5]?.verdict).toBe('fail');

    const noFallback = fullPassRecords();
    noFallback[4] = { ...noFallback[4]!, fallbackUsed: true, offlineFallbackPlayed: false };
    expect(simSeminarRehearsal(noFallback).scenes[4]?.verdict).toBe('fail');

    const unknownFallback = fullPassRecords();
    unknownFallback[4] = { ...unknownFallback[4]!, fallbackUsed: null };
    expect(simSeminarRehearsal(unknownFallback).scenes[4]?.verdict).toBe('unknown');
  });

  test('unknown scene results take precedence over measured failures; invalid scene ids are rejected', () => {
    const mixed = fullPassRecords();
    mixed[0] = { ...mixed[0]!, outcome: 'fail' };
    mixed[1] = { ...mixed[1]!, evidenceId: null };
    expect(simSeminarRehearsal(mixed).verdict).toBe('unknown');

    const invalid = [...fullPassRecords(), { ...fullPassRecords()[0]!, scene: 8 as SeminarSceneRecord['scene'] }];
    expect(() => simSeminarRehearsal(invalid)).toThrow('unknown scene record');
  });

  test('duplicate scene records are rejected', () => {
    const records = fullPassRecords();
    records.push(records[0]!);
    expect(() => simSeminarRehearsal(records)).toThrow('duplicate scene record');
  });

  test('CLI exposes only the simulation flag and rejects mixing it with unrelated modes', () => {
    const script = join(import.meta.dir, '..', '..', 'scripts', 'ux-sim.ts');
    const ok = spawnSync(process.execPath, [script, '--seminar-rehearsal'], { encoding: 'utf8', timeout: 90_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('sim only (실제 행사 실행 증거 아님)');
    expect(ok.stdout).toContain('S7 close');
    const mixed = spawnSync(process.execPath, [script, '--seminar-rehearsal', '--fault', 'pool-cap'], { encoding: 'utf8', timeout: 90_000 });
    expect(mixed.status).toBe(2);
  }, 120_000);
});
