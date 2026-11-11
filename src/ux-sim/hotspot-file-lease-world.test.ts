import { expect, test } from 'bun:test';
import { simulateHotspotFileLeaseWorld } from './hotspot-file-lease-world.js';
import { recordHotspotStartForecast } from '../cli/hotspot-start-forecast.js';

// Source: RFC-train-manager-loop-agent.md §3c and #35929's approved planned-file guard contract.
const base = 'a'.repeat(40);
const head = (number: number) => number.toString(16).padStart(40, '0');

test('HOTSPOT-FILE-LEASE: planned overlap writes one unknown-conflict row per observed head', async () => {
  const result = await simulateHotspotFileLeaseWorld({
    base, owner: 'R-HOTSPOT', now: '2026-11-10T00:00:00.000Z',
    plannedStart: { status: 'refuse', reason: 'hotspot-op-approval-required', hotspots: [{
      file: 'src/shared.ts', prs: [{ number: 501, headSha: head(501) }, { number: 502, headSha: head(502) }],
    }] },
    prs: [501, 502].map(number => ({ number, head: head(number), baseRef: 'main', state: 'open' as const,
      gate: 'passed' as const, owner: `MVP-${number}`, files: ['src/shared.ts'] })),
  });
  expect(result.rows.map(row => row.otherPr)).toEqual([501, 502]);
  expect(result.rows.every(row => row.conflict === null && row.detector === 'open-guard')).toBe(true);
  expect(result.train.conflictForecastJsonl).toContain('"detector":"overlap-evidence"');
  expect(result.conflictForecastJsonl.trim().split('\n')).toHaveLength(3);
});

test('HOTSPOT-FILE-LEASE: unknown inventory records unknown, clean start records nothing', () => {
  const rows = [] as ReturnType<typeof recordHotspotStartForecast>;
  const unknown = recordHotspotStartForecast({ base, verdict: { status: 'unknown', hotspots: [], reason: 'inventory-unknown' },
    append: row => { rows.push(row); } });
  expect(unknown).toMatchObject([{ otherPr: null, conflict: null, unmeasuredReason: 'inventory-unknown' }]);
  expect(rows).toHaveLength(1);
  expect(recordHotspotStartForecast({ base, verdict: { status: 'allow', hotspots: [] }, append: row => { rows.push(row); } })).toEqual([]);
  expect(rows).toHaveLength(1);
});
