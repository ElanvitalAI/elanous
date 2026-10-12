import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ARCHITECTURE_MAP } from './architecture-map';

const root = resolve(dirname(import.meta.path), '../../../../../');
// The retired 10-01 positioning terms are assembled from parts so this contract file never spells them.
const retiredTerms = [['four', 'pillars'].join(' '), ['네', '기둥'].join(' ')];

test('positioning hierarchy leads with loop agents and graph engineering; every layer points to existing repository files', () => {
  expect(ARCHITECTURE_MAP).toHaveLength(6);
  expect(ARCHITECTURE_MAP.map((entry) => entry.id)).toEqual([
    'loop-agent', 'graph-engineering', 'pty-intelligence', 'harness', 'mission-fabric', 'observation',
  ]);
  expect(ARCHITECTURE_MAP[0]?.id).toBe('loop-agent');
  expect(ARCHITECTURE_MAP[1]?.id).toBe('graph-engineering');
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
  for (const name of ['architecture-map.ts', 'ArchitectureScene.tsx', 'InsidePage.test.tsx', 'architecture-map.test.ts']) {
    const source = readFileSync(join(dirname(import.meta.path), name), 'utf8').toLowerCase();
    for (const term of retiredTerms) expect(source.includes(term)).toBe(false);
  }
});
