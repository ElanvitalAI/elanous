import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGateBatchSafe } from './gate-batch-safe';

test('gate batch is disabled unless a file has explicit evidence in the opt-in list', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-batch-safe-'));
  try {
    expect(loadGateBatchSafe(root).size).toBe(0);
    mkdirSync(join(root, 'release'));
    writeFileSync(join(root, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests: [
      { file: 'src/a.test.ts', evidence: 'same rc and JUnit identities in own and batch Pods' },
    ] }));
    expect([...loadGateBatchSafe(root)]).toEqual(['src/a.test.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate batch refuses malformed or unevidenced entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-batch-bad-'));
  try {
    mkdirSync(join(root, 'release'));
    for (const tests of [[{ file: 'src/a.test.ts', evidence: '' }], [
      { file: 'src/a.test.ts', evidence: 'a' }, { file: 'src/a.test.ts', evidence: 'b' },
    ]]) {
      writeFileSync(join(root, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests }));
      expect(() => loadGateBatchSafe(root)).toThrow('invalid gate batch safe list');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
