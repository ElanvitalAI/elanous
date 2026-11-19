import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalTargetPaths } from './difficulty.js';
import { buildUserConfig, saveUserConfig } from '../user-config.js';

test('target paths come from the authored line, not incidental prose', () => {
  expect(goalTargetPaths('Goal\n대상 경로: src/a.ts · `src/b.ts`\nother src/c.ts')).toEqual(['src/a.ts', 'src/b.ts']);
});

test('legacy placement setting is discarded on read and save without dropping neighboring config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'difficulty-retired-')); const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({ harness: { difficultyPlacement: true, defaultRepo: 'kept' } }));
      const cfg = buildUserConfig(path);
      expect(cfg.harness).not.toHaveProperty('difficultyPlacement');
      saveUserConfig(cfg, path);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved.harness).not.toHaveProperty('difficultyPlacement');
      expect(saved.harness.defaultRepo).toBe('kept');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
