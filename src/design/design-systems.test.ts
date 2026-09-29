import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDesignSystemsDir, listDesignSystems } from './design-systems.js';
import { debug } from '../debug/log.js';

function fixture(root: string, id: string, complete = true): void {
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Example', category: 'Modern' }));
  writeFileSync(join(dir, 'DESIGN.md'), '# Example\n\n> Category: Modern\n> A distinct visual language.\n');
  if (complete) writeFileSync(join(dir, 'tokens.css'), ':root {\n --bg: #101010;\n --fg: #fefefe;\n --accent: #abc123;\n --font-display: Display, serif;\n --font-body: Body, sans-serif;\n}');
}

describe('listDesignSystems', () => {
  test('reads manifest, summary, swatch, fonts and source commit from two temporary folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'design-systems-'));
    try {
      writeFileSync(join(root, 'SOURCE.json'), JSON.stringify({ commit: '1234567890abcdef' }));
      fixture(root, 'alpha');
      fixture(root, 'beta');
      expect(listDesignSystems(root)).toEqual(['alpha', 'beta'].map((id) => ({
        id, name: 'Example', category: 'Modern', summary: 'A distinct visual language.',
        swatch: { bg: '#101010', fg: '#fefefe', accent: '#abc123' },
        fonts: { display: 'Display, serif', body: 'Body, sans-serif' },
        sourceCommit: '1234567890abcdef',
      })));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('skips an incomplete folder and logs its id and reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'design-systems-'));
    const originalLog = debug.log;
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: unknown) => {
      records.push({ category, event, data });
    }) as typeof debug.log;
    try {
      writeFileSync(join(root, 'SOURCE.json'), JSON.stringify({ commit: 'abc' }));
      fixture(root, 'valid');
      fixture(root, 'broken', false);
      expect(listDesignSystems(root).map((system) => system.id)).toEqual(['valid']);
      expect(records).toContainEqual({ category: 'design.systems', event: 'skipped', data: expect.objectContaining({ id: 'broken', reason: expect.stringContaining('tokens.css') }) });
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bundled systems contain at least 50 usable summaries and accents', () => {
    const systems = listDesignSystems(defaultDesignSystemsDir());
    const source = JSON.parse(readFileSync(join(defaultDesignSystemsDir(), 'SOURCE.json'), 'utf8')) as { systems: Array<{ id: string }> };
    expect(source.systems).toHaveLength(52);
    expect(systems).toHaveLength(source.systems.length);
    expect(systems.length).toBeGreaterThanOrEqual(50);
    for (const system of systems) {
      expect(system.summary.length).toBeGreaterThan(0);
      expect(system.swatch.accent.length).toBeGreaterThan(0);
    }
  });
});
