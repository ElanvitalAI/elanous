import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSeminarRehearsal, renderSeminarRehearsal, SEMINAR_SCENES, seminarRehearsalSweep, simSeminarRehearsal, type SeminarSceneRecord } from './seminar-rehearsal.js';
import { withSimClock } from './fake-clock.js';
import { createSimWorld, destroySimWorld, listSimWorlds } from './world-store.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';

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

describe('seminar same-build freeze device', () => {
  test('serializes a third pass against an unapproved build change across processes', async () => {
    const previousRoot = getTestStateRoot();
    const root = mkdtempSync(join(tmpdir(), 'sim-seminar-freeze-race-'));
    const worlds = join(root, 'sim', 'worlds');
    mkdirSync(worlds, { recursive: true, mode: 0o700 });
    setTestStateRoot(root);
    try {
      const world = createSimWorld('seminar-freeze-race', { worldsDir: worlds });
      const passes = fullPassRecords();
      recordSeminarRehearsal(world, { buildId: 'build-a', records: passes });
      recordSeminarRehearsal(world, { buildId: 'build-a', records: passes });
      const childCode = `
        import { setTestStateRoot } from './src/nexus/paths.js';
        import { listSimWorlds } from './src/ux-sim/world-store.js';
        import { recordSeminarRehearsal } from './src/ux-sim/seminar-rehearsal.js';
        import { existsSync, writeFileSync } from 'node:fs';
        writeFileSync(process.env.SIM_READY, 'ready');
        const cell = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.SIM_START)) Atomics.wait(cell, 0, 0, 5);
        setTestStateRoot(process.env.SIM_TEST_ROOT);
        const world = listSimWorlds({ worldsDir: process.env.SIM_WORLDS }).find((item) => item.id === process.env.SIM_WORLD_ID);
        const attempt = recordSeminarRehearsal(world, { buildId: process.env.SIM_BUILD_ID, records: JSON.parse(process.env.SIM_RECORDS) });
        process.stdout.write(JSON.stringify({ accepted: attempt.accepted, decision: attempt.decision, requestedBuildId: process.env.SIM_BUILD_ID, stateBuildId: attempt.state.buildId, frozen: attempt.state.frozen }));
      `;
      const startFile = join(root, 'start');
      const runChild = (buildId: string, side: string) => Bun.spawn([process.execPath, '-e', childCode], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, SIM_TEST_ROOT: root, SIM_WORLDS: worlds, SIM_WORLD_ID: world.id, SIM_BUILD_ID: buildId, SIM_READY: join(root, side + '.ready'), SIM_START: startFile, SIM_RECORDS: JSON.stringify(passes) },
        stdout: 'pipe', stderr: 'pipe',
      });
      const children = [runChild('build-a', 'a'), runChild('build-b', 'b')];
      const readyDeadline = Date.now() + 5_000;
      while ((!existsSync(join(root, 'a.ready')) || !existsSync(join(root, 'b.ready'))) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(existsSync(join(root, 'a.ready')) && existsSync(join(root, 'b.ready'))).toBe(true);
      writeFileSync(startFile, 'go');
      const results = await Promise.all(children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exitCode, stderr).toBe(0);
        return JSON.parse(stdout) as { accepted: boolean; decision: string; requestedBuildId: string; stateBuildId: string; frozen: boolean };
      }));
      const buildA = results.find((result) => result.requestedBuildId === 'build-a')!;
      const buildB = results.find((result) => result.requestedBuildId === 'build-b')!;
      if (buildA.frozen) expect(buildB).toMatchObject({ accepted: false, decision: 'owner-approval-required', stateBuildId: 'build-a' });
      else expect(buildB.accepted).toBe(true);
      const finalWorld = listSimWorlds({ worldsDir: worlds }).find((candidate) => candidate.id === world.id)!;
      if (buildA.frozen) {
        expect(recordSeminarRehearsal(finalWorld, { buildId: "build-b", records: passes })).toMatchObject({ accepted: false, state: { buildId: "build-a", consecutivePasses: 3, frozen: true } });
      } else {
        expect(JSON.parse(readFileSync(join(finalWorld.stateDir, 'seminar-rehearsal-freeze.json'), 'utf8'))).toMatchObject({ buildId: 'build-a', consecutivePasses: 1, frozen: false });
      }
      expect(destroySimWorld(world.id, { worldsDir: worlds })).toBe(true);
    } finally {
      setTestStateRoot(previousRoot ?? null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists three consecutive passes, refuses an unapproved build change, and resumes on owner approval', async () => {
    const previousRoot = getTestStateRoot();
    const root = mkdtempSync(join(tmpdir(), 'sim-seminar-freeze-'));
    const worlds = join(root, 'sim', 'worlds');
    mkdirSync(worlds, { recursive: true, mode: 0o700 });
    setTestStateRoot(root);
    try {
      const world = createSimWorld('seminar-freeze', { worldsDir: worlds, now: () => new Date('2026-11-03T00:00:00.000Z') });
      const passes = fullPassRecords();
      const passesSeen: number[] = [];
      const passTimestamps: string[] = [];
      let laterFailure!: ReturnType<typeof recordSeminarRehearsal>;
      let refusal!: ReturnType<typeof recordSeminarRehearsal>;
      let mismatchedApproval!: ReturnType<typeof recordSeminarRehearsal>;
      let approved!: ReturnType<typeof recordSeminarRehearsal>;
      let persistedAtRefusal: unknown;
      let simulatedNow = 0;
      await withSimClock(new Date('2026-11-03T00:00:00.000Z'), (clock) => {
        const firstPass = recordSeminarRehearsal(world, { buildId: 'build-a', records: passes });
        passesSeen.push(firstPass.state.consecutivePasses);
        passTimestamps.push(firstPass.state.updatedAt);
        clock.tick(1_000);
        const interrupted = recordSeminarRehearsal(world, { buildId: 'build-a', records: [{ ...passes[0]!, outcome: 'fail' }, ...passes.slice(1)] });
        passesSeen.push(interrupted.state.consecutivePasses);
        clock.tick(1_000);
        for (let expected = 1; expected <= 3; expected += 1) {
          const attempt = recordSeminarRehearsal(world, { buildId: 'build-a', records: passes });
          passesSeen.push(attempt.state.consecutivePasses);
          passTimestamps.push(attempt.state.updatedAt);
          clock.tick(1_000);
        }
        const reopenedWorld = listSimWorlds({ worldsDir: worlds }).find((candidate) => candidate.id === world.id)!;
        laterFailure = recordSeminarRehearsal(reopenedWorld, { buildId: 'build-a', records: [{ ...passes[0]!, outcome: 'fail' }, ...passes.slice(1)] });
        refusal = recordSeminarRehearsal(reopenedWorld, { buildId: 'build-b', records: passes });
        mismatchedApproval = recordSeminarRehearsal(reopenedWorld, { buildId: 'build-b', records: passes, approval: { owner: 'OP', buildId: 'build-a', receiptId: 'wrong-build' } });
        const receiptPath = join(world.stateDir, 'seminar-rehearsal-freeze.json');
        persistedAtRefusal = JSON.parse(readFileSync(receiptPath, 'utf8'));
        approved = recordSeminarRehearsal(reopenedWorld, {
          buildId: 'build-b', records: passes, approval: { owner: 'OP', buildId: 'build-b', receiptId: 'approval-0301-1' },
        });
        simulatedNow = clock.now();
      });
      expect(passesSeen).toEqual([1, 0, 1, 2, 3]);
      expect(passTimestamps).toEqual(['2026-11-03T00:00:00.000Z', '2026-11-03T00:00:02.000Z', '2026-11-03T00:00:03.000Z', '2026-11-03T00:00:04.000Z']);
      expect(laterFailure.state).toMatchObject({ consecutivePasses: 3, frozen: true });
      expect(refusal).toMatchObject({ accepted: false, decision: 'owner-approval-required', rehearsal: null, state: { buildId: 'build-a', consecutivePasses: 3, frozen: true, lastDeniedBuildId: 'build-b' } });
      expect(mismatchedApproval).toMatchObject({ accepted: false, decision: 'owner-approval-required', rehearsal: null });
      expect(persistedAtRefusal).toMatchObject({ buildId: 'build-a', frozen: true, lastDeniedBuildId: 'build-b' });
      expect(approved).toMatchObject({ accepted: true, decision: 'recorded', rehearsal: { verdict: 'pass' }, state: { buildId: 'build-b', consecutivePasses: 1, frozen: false, approvedBy: 'OP' } });
      expect(simulatedNow).toBe(Date.parse('2026-11-03T00:00:05.000Z'));
      const reset = recordSeminarRehearsal(world, { buildId: 'build-b', records: [{ ...passes[0]!, outcome: 'fail' }, ...passes.slice(1)] });
      expect(reset.state).toMatchObject({ buildId: 'build-b', consecutivePasses: 0, frozen: false });
      expect(destroySimWorld(world.id, { worldsDir: worlds })).toBe(true);
    } finally {
      setTestStateRoot(previousRoot ?? null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
