import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logUsage, snapshotCost } from './cost-meter.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('N07 mock operations window replay: production cost rollup', () => {
  it('replays three hourly events in an isolated 24h window and preserves a correlated out-of-window counterexample', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-n07-cost-'));
    tempHomes.push(home);
    const eventPath = join(home, '.elanous', 'cost-events.jsonl');
    const snapshotAt = Date.UTC(2026, 9, 21, 12);
    const baseline = snapshotCost({ path: eventPath, now: snapshotAt });

    const replay = [
      { tick: 1, ts: snapshotAt - 24 * HOUR, taskId: 'n07-run/tick-1', usd: 0.12 },
      { tick: 2, ts: snapshotAt - 23 * HOUR, taskId: 'n07-run/tick-2', usd: 0.23 },
      { tick: 3, ts: snapshotAt - 22 * HOUR, taskId: 'n07-run/tick-3', usd: 0.34 },
    ];
    for (const event of replay) {
      await logUsage({
        modelId: 'replay-model', inputTokens: event.tick * 100,
        outputTokens: event.tick * 10, usd: event.usd,
        goalSlug: 'mock-ops-window-replay', taskId: event.taskId,
        skipAutoAttribution: true,
      }, { path: eventPath, now: event.ts });
    }
    // Same production writer and rollup, but this correlated control is older than the weekly window.
    await logUsage({
      modelId: 'replay-model', inputTokens: 900, outputTokens: 90, usd: 9,
      goalSlug: 'mock-ops-window-replay', taskId: 'n07-run/negative-old-control',
      skipAutoAttribution: true,
    }, { path: eventPath, now: snapshotAt - 8 * DAY });

    const stored = readFileSync(eventPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { ts: number; taskId: string; usd: number });
    expect(stored).toHaveLength(4);
    expect(stored.map(({ taskId }) => taskId)).toEqual([
      'n07-run/tick-1', 'n07-run/tick-2', 'n07-run/tick-3', 'n07-run/negative-old-control',
    ]);
    expect(stored.map(({ ts }) => ts)).toEqual([...replay.map(({ ts }) => ts), snapshotAt - 8 * DAY]);
    const after = snapshotCost({ path: eventPath, now: snapshotAt });
    expect(baseline.eventsCount).toBe(0);
    expect(baseline.weeklyUsd).toBe(0);
    expect(after.eventsCount - baseline.eventsCount).toBe(4);
    expect(after.totalUsd - baseline.totalUsd).toBeCloseTo(9.69, 10);
    expect(after.weeklyUsd - baseline.weeklyUsd).toBeCloseTo(0.69, 10);
    expect(after.perModel['replay-model']).toEqual({ count: 4, tokens: 1650, usd: 9.69 });
    expect(after.perGoal['mock-ops-window-replay']).toEqual({ tokens: 1650, usd: 9.69 });
    expect(replay.map(({ taskId }) => taskId)).toEqual(['n07-run/tick-1', 'n07-run/tick-2', 'n07-run/tick-3']);
    // Negative counterexample: the old row is counted in lifetime totals, but not in the 7-day rollup.
    expect(after.totalUsd - after.weeklyUsd).toBeCloseTo(9, 10);
  });
});
