import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONDUCTOR_CELL_MAP_BEGIN,
  CONDUCTOR_CELL_MAP_END,
  renderConductorCellMap,
  replaceGeneratedConductorCellMap,
} from './generate-conductor-cell-map.js';

const repoRoot = resolve(import.meta.dir, '..');
const compareNames = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

describe('CONDUCTOR cell-map fragments', () => {
  test('sorts per-document fragments deterministically', () => {
    const result = renderConductorCellMap([
      { name: 'zeta.md', content: '| z | last |' },
      { name: 'alpha.md', content: '| a | first |' },
    ]);
    expect(result.indexOf('| a | first |')).toBeLessThan(result.indexOf('| z | last |'));
    expect(result).toContain('| 판 | 칸 |\n|---|---|');
  });

  test('replaces only the marked block and renders newly landed fragments without requiring an early map update', () => {
    const fragments = readdirSync(resolve(repoRoot, 'docs/conductor/cells'))
      .filter((name) => name.endsWith('.md'))
      .sort(compareNames)
      .map((name) => ({ name, content: readFileSync(resolve(repoRoot, 'docs/conductor/cells', name), 'utf8') }));
    const expectedBlock = renderConductorCellMap(fragments);
    const conductor = readFileSync(resolve(repoRoot, 'docs/conductor/CONDUCTOR.md'), 'utf8');
    expect(conductor).toContain(CONDUCTOR_CELL_MAP_BEGIN);
    expect(conductor).toContain(CONDUCTOR_CELL_MAP_END);
    expect(expectedBlock).toContain('| 0.3.7 | MARKETPLACE-RFC');

    const surrounding = `before\n${CONDUCTOR_CELL_MAP_BEGIN}\nold\n${CONDUCTOR_CELL_MAP_END}\nafter`;
    expect(replaceGeneratedConductorCellMap(surrounding, expectedBlock)).toBe(`before\n${expectedBlock}\nafter`);
  });

  test('rejects malformed markers and non-table fragment entries', () => {
    expect(() => replaceGeneratedConductorCellMap('no markers', 'generated')).toThrow(/marker pair/);
    expect(() => replaceGeneratedConductorCellMap(`${CONDUCTOR_CELL_MAP_BEGIN}\n${CONDUCTOR_CELL_MAP_END}\n${CONDUCTOR_CELL_MAP_END}`, 'generated')).toThrow(/marker pair/);
    expect(() => renderConductorCellMap([{ name: 'bad.md', content: 'not a row' }])).toThrow(/table row/);
  });
});
