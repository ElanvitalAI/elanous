import { expect, test } from 'bun:test';
import { orderHotspotPrsByRadius } from './hotspot-radius-ordering.js';

// Source: RFC-train-manager-loop-agent.md §5: wider hotspot first, S1 first; values below are scenario fixtures.
const row = (pr: string, files: string[], radius: number, priority?: 'S1' | 'normal') => ({ pr, files, radius, priority });

test('shared hotspot lands S1 first, then wider radius, with FIFO ties', () => {
  const queue = [
    row('101', ['src/shared.ts'], 3),
    row('102', ['src/shared.ts'], 8),
    row('103', ['src/unrelated.ts'], 20),
    row('104', ['src/shared.ts'], 8),
    row('105', ['src/shared.ts'], 1, 'S1'),
  ];
  expect(orderHotspotPrsByRadius(queue).map(pr => pr.pr)).toEqual(['105', '102', '104', '101', '103']);
  expect(queue.map(pr => pr.pr)).toEqual(['101', '102', '103', '104', '105']);
});

test('transitive shared files form one hotspot and separate groups keep queue position', () => {
  const queue = [
    row('201', ['src/a.ts'], 2),
    row('202', ['src/other.ts'], 30),
    row('203', ['src/a.ts', 'src/b.ts'], 4),
    row('204', ['src/b.ts'], 6),
  ];
  expect(orderHotspotPrsByRadius(queue).map(pr => pr.pr)).toEqual(['204', '203', '201', '202']);
});

test('unknown radius and duplicate PR identity fail before changing order', () => {
  expect(() => orderHotspotPrsByRadius([row('301', ['src/a.ts'], Number.NaN)])).toThrow('unmeasured hotspot radius');
  expect(() => orderHotspotPrsByRadius([row('301', ['src/a.ts'], 1), row('301', ['src/a.ts'], 2)])).toThrow('invalid hotspot PR');
});
