import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineCommit } from './gate-baseline-manifest.js';

test('baseline manifest validation and gate-node import boundary stay stable', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-baseline-manifest-'));
  const releaseDir = join(root, 'release', '0.3.7');
  mkdirSync(releaseDir, { recursive: true });
  try {
    const path = join(releaseDir, 'release.json');
    const shortCommit = 'a'.repeat(7);
    const fullUpperCommit = 'A'.repeat(40);
    writeFileSync(path, JSON.stringify({ sourceCommit: shortCommit }));
    expect(baselineCommit(root, '0.3.7')).toBe(shortCommit);
    writeFileSync(path, JSON.stringify({ sourceCommit: fullUpperCommit }));
    expect(baselineCommit(root, '0.3.7')).toBe(fullUpperCommit);
    writeFileSync(path, JSON.stringify({}));
    expect(() => baselineCommit(root, '0.3.7')).toThrow('missing sourceCommit');
    writeFileSync(path, '{');
    expect(() => baselineCommit(root, '0.3.7')).toThrow();

    const macSmoke = readFileSync(join(import.meta.dir, 'mac-smoke-node.ts'), 'utf8');
    const gateNode = readFileSync(join(import.meta.dir, 'gate-node.ts'), 'utf8');
    expect(macSmoke).toContain("import { baselineCommit } from './gate-baseline-manifest.js';");
    expect(macSmoke).not.toMatch(/from ['"][^'"]*gate-node/);
    expect(gateNode).toContain("export { baselineCommit } from './gate-baseline-manifest.js';");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
