import { expect, test } from 'bun:test';
import { conflictMarkerBlock, conflictMarkerFiles } from './pr-cli.js';

// MARKER-GUARD: 10-06 02:4x a hand landing put conflict markers into release/next.md on main (hotfix #24333).
const files: Record<string, string> = {
  'release/next.md': '# Next\n\n<<<<<<< HEAD\n- a line\n=======\n>>>>>>> origin/main\n',
  'docs/setext.md': 'Title\n=======\n\nbody\n',
  'src/clean.ts': 'export const x = 1;\n',
  'src/half.ts': '// <<<<<<< mentioned in a comment without a closing marker\n',
};
const read = (path: string) => files[path];

test('a file with both opening and closing conflict markers is refused; a Markdown underline or half marker is not', () => {
  expect(conflictMarkerFiles(Object.keys(files), '/repo', read)).toEqual(['release/next.md']);
  const errors: string[] = [];
  const ok = conflictMarkerBlock(Object.keys(files), '/repo', { log: () => {}, error: (m) => errors.push(m) }, read);
  expect(ok).toBe(false);
  expect(errors[0]).toContain('release/next.md');
});

test('clean changes pass and an unreadable or deleted file is not a marker hit', () => {
  const errors: string[] = [];
  expect(conflictMarkerBlock(['src/clean.ts', 'gone.ts'], '/repo', { log: () => {}, error: (m) => errors.push(m) }, read)).toBe(true);
  expect(conflictMarkerBlock(undefined, '/repo', { log: () => {}, error: (m) => errors.push(m) }, read)).toBe(true);
  expect(errors).toEqual([]);
});

test('a large file (over 4 MiB) with markers is still refused through the default reader (ACP must-fix)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'marker-big-'));
  try {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(5 * 1024 * 1024) + '\n<<<<<<< HEAD\na\n=======\n>>>>>>> main\n');
    expect(conflictMarkerFiles(['big.md', 'missing.md'], dir)).toEqual(['big.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
