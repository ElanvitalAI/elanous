import { describe, expect, test } from 'bun:test';
import {
  BLOCKERS,
  GOLDEN_STEPS,
  STALL_WAKE_MINUTES,
  depOrderViolations,
  downstream,
  fakeRunner,
  loadExecutor,
  manualSerialMinutes,
  proofTable,
  raceCheck,
  renderTable,
  type QuickpassExecutor,
} from './release-quickpass-world';

// RELEASE_QUICKPASS_EXECUTOR=<module> swaps in the real graph executor; the assertions stay the same.
const executor: QuickpassExecutor = await loadExecutor();
const SEEDS = [1, 2, 3] as const;
const statusOf = (result: Awaited<ReturnType<QuickpassExecutor['run']>>, id: string) => result.results.find((r) => r.id === id)?.status;

describe(`release-quickpass-world · executor=${executor.name}`, () => {
  test('golden path replays clean: every step passes, publish happens once, no cards, no wakes', async () => {
    for (const seed of SEEDS) {
      const result = await executor.run(GOLDEN_STEPS, fakeRunner(seed));
      expect(result.stoppedAt).toBeUndefined();
      expect(result.results.map((r) => `${r.id}:${r.status}`)).toEqual(GOLDEN_STEPS.map((s) => `${s.id}:pass`));
      expect(result.startOrder.filter((id) => id === 'publish')).toEqual(['publish']);
      expect(result.cards).toEqual([]);
      expect(result.wakes).toEqual([]);
      expect(depOrderViolations(GOLDEN_STEPS, result)).toEqual([]);
    }
  });

  for (const blocker of BLOCKERS.filter((b) => b.expect === 'continue')) {
    test(`advisory blocker «${blocker.id}» → warn + card on ${blocker.faults[0]!.step}, run continues and publishes`, async () => {
      for (const seed of SEEDS) {
        const result = await executor.run(GOLDEN_STEPS, fakeRunner(seed, blocker.faults));
        expect(result.stoppedAt).toBeUndefined();
        expect(result.published).toBe(true);
        expect(statusOf(result, blocker.faults[0]!.step)).toBe('warn');
        expect(result.cards.map((c) => c.step)).toContain(blocker.faults[0]!.step);
        expect(statusOf(result, 'update-all')).not.toBe('skipped');
        expect(depOrderViolations(GOLDEN_STEPS, result)).toEqual([]);
      }
    });
  }

  for (const blocker of BLOCKERS.filter((b) => b.expect === 'stop')) {
    test(`must-stop «${blocker.id}» → run stops at ${blocker.faults[0]!.step}; nothing new starts after it`, async () => {
      for (const seed of SEEDS) {
        const result = await executor.run(GOLDEN_STEPS, fakeRunner(seed, blocker.faults));
        expect(result.stoppedAt).toBe(blocker.faults[0]!.step);
        const stopEnd = result.results.find((r) => r.id === result.stoppedAt)!.endedAt;
        const lateStarts = result.results.filter((r) => r.status !== 'skipped' && r.status !== 'marked' && r.id !== 'traffic-restore' && r.startedAt > stopEnd);
        expect(lateStarts.map((r) => r.id)).toEqual([]);
        expect(statusOf(result, 'traffic-restore')).not.toBe('skipped');
        if (blocker.faults[0]!.step !== 'npm') expect(result.published).toBe(false);
      }
    });
  }

  test('all historical blockers at once: the release still publishes, one card per blocker, update-all stall wakes REL', async () => {
    const faults = BLOCKERS.filter((b) => b.expect === 'continue').flatMap((b) => b.faults);
    for (const seed of SEEDS) {
      const result = await executor.run(GOLDEN_STEPS, fakeRunner(seed, faults));
      expect(result.stoppedAt).toBeUndefined();
      expect(result.published).toBe(true);
      expect(new Set(result.cards.map((c) => c.step))).toEqual(new Set(faults.map((f) => f.step)));
      expect(result.wakes.map((w) => `${w.seat}:${w.step}`)).toContain('REL:update-all');
    }
  });

  test(`a step with no progress for ${STALL_WAKE_MINUTES} min wakes REL at start + ${STALL_WAKE_MINUTES}`, async () => {
    const stuck = BLOCKERS.find((b) => b.id === 'update-all-stuck')!;
    const result = await executor.run(GOLDEN_STEPS, fakeRunner(1, stuck.faults));
    const started = result.results.find((r) => r.id === 'update-all')!.startedAt;
    expect(result.wakes).toEqual([{ seat: 'REL', step: 'update-all', at: started + STALL_WAKE_MINUTES, reason: `no progress for ${STALL_WAKE_MINUTES} min` }]);
    // A long step that keeps printing progress is not a stall.
    const busy = await executor.run(GOLDEN_STEPS, fakeRunner(1, [{ step: 'docs', apply: (o) => ({ ...o, minutes: 90, progress: true }) }]));
    expect(busy.wakes).toEqual([]);
  });

  for (const step of GOLDEN_STEPS) {
    test(`--resume ${step.id}: only it and its descendants run; publish runs at most once`, async () => {
      const result = await executor.run(GOLDEN_STEPS, fakeRunner(2), { resumeFrom: step.id });
      const rerun = downstream(GOLDEN_STEPS, step.id);
      const ran = result.results.filter((r) => r.status !== 'marked').map((r) => r.id).sort();
      expect(ran).toEqual([...rerun].sort());
      expect(result.startOrder.filter((id) => id === 'publish').length).toBe(rerun.has('publish') ? 1 : 0);
      expect(result.stoppedAt).toBeUndefined();
      expect(depOrderViolations(GOLDEN_STEPS, result)).toEqual([]);
    });
  }

  test('mark: steps done by hand are never re-run; the run continues downstream of them', async () => {
    const result = await executor.run(GOLDEN_STEPS, fakeRunner(3), { marks: ['cut', 'notes', 'prepare', 'publish'] });
    for (const id of ['cut', 'notes', 'prepare', 'publish']) expect(statusOf(result, id)).toBe('marked');
    expect(result.startOrder).not.toContain('publish');
    for (const id of ['npm', 'verify', 'rail', 'els-restart', 'update-all']) expect(statusOf(result, id)).toBe('pass');
  });

  test('DAG wall time beats manual serial on the golden path, and publish never starts before its real deps', async () => {
    for (const seed of SEEDS) {
      const result = await executor.run(GOLDEN_STEPS, fakeRunner(seed));
      expect(result.wallMinutes).toBeLessThan(manualSerialMinutes(GOLDEN_STEPS, fakeRunner(seed)));
      const publish = result.results.find((r) => r.id === 'publish')!;
      for (const dep of ['prepare', 'go', 'notes-public']) expect(publish.startedAt).toBeGreaterThanOrEqual(result.results.find((r) => r.id === dep)!.endedAt);
    }
  });

  test('race: a slow + failed parallel branch neither moves publish nor changes unrelated branches', async () => {
    for (const seed of SEEDS) {
      const report = await raceCheck(executor, seed);
      expect(report.violations).toEqual([]);
      expect(report.unrelatedEqual).toBe(true);
      expect(report.publishStartWithSlowBranch).toBe(report.publishStartBaseline);
      expect(report.ok).toBe(true);
    }
  });

  test('host caps: two steps on the same capped host never overlap', async () => {
    const result = await executor.run(GOLDEN_STEPS, fakeRunner(1));
    const hostOf = new Map(GOLDEN_STEPS.map((s) => [s.id, s.host]));
    const byHost = new Map<string, { startedAt: number; endedAt: number }[]>();
    for (const r of result.results) {
      const host = hostOf.get(r.id);
      if (host) byHost.set(host, [...(byHost.get(host) ?? []), r]);
    }
    for (const spans of byHost.values()) {
      const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
      for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]!.startedAt).toBeGreaterThanOrEqual(sorted[i - 1]!.endedAt);
    }
  });

  test('proof table: every row as expected and the headline counts render', async () => {
    const table = await proofTable(executor, SEEDS);
    expect(table.rows.filter((r) => !r.ok).map((r) => r.blocker)).toEqual([]);
    const text = renderTable(executor.name, table);
    expect(text).toContain('All rows as expected: **yes**');
    expect(text).toContain('| ALL historical blockers at once |');
  });

  test('adapter seam: a module without quickpassExecutor is refused by name', async () => {
    await expect(loadExecutor({ RELEASE_QUICKPASS_EXECUTOR: 'node:path' })).rejects.toThrow('does not export quickpassExecutor.run');
    expect((await loadExecutor({})).name).toBe('reference-dag');
  });
});
