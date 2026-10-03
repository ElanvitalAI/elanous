import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ARCHITECTURE_MAP } from './architecture-map';

const root = resolve(dirname(import.meta.path), '../../../../../');

test('four pillars, observing floor and harness foundation each point to existing repository files', () => {
  expect(ARCHITECTURE_MAP).toHaveLength(6);
  expect(ARCHITECTURE_MAP.map((entry) => entry.id)).toEqual([
    'mission-fabric', 'graph-engineering', 'pty-intelligence', 'loop-agent', 'observation', 'harness',
  ]);
  for (const entry of ARCHITECTURE_MAP) {
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.oneLine.length).toBeGreaterThan(0);
    expect(entry.docs.length).toBeGreaterThanOrEqual(1);
    expect(entry.docs.length).toBeLessThanOrEqual(3);
    expect(entry.code.length).toBeGreaterThanOrEqual(1);
    expect(entry.code.length).toBeLessThanOrEqual(3);
    for (const path of [...entry.docs, ...entry.code]) {
      expect(path.startsWith('/') || path.includes('..')).toBe(false);
      expect(existsSync(resolve(root, path))).toBe(true);
    }
  }
});
