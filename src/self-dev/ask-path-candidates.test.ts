import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAskPathCandidates } from './ask-path-candidates.js';

test('identifier and backtick words find ranked code candidates with literal rg arguments', () => {
  const calls: string[][] = [];
  const result = findAskPathCandidates('Repair `scopeBoundaryCandidates` and ask-launch-flow retry.', {
    cwd: '/repo',
    run: (_command, args) => {
      calls.push([...args]);
      if (args[5] === 'scopeBoundaryCandidates') return 'src/self-implement/goal-author.ts\nsrc/self-dev/ask-launch-flow.ts\n';
      if (args[5] === 'ask-launch-flow') return 'src/self-dev/ask-launch-flow.ts\n';
      return '';
    },
  });
  expect(result.paths).toEqual(['src/self-dev/ask-launch-flow.ts', 'src/self-implement/goal-author.ts']);
  expect(result.tokens).toContain('scopeBoundaryCandidates');
  expect(calls).toContainEqual(['-l', '-F', '--glob', '!*.test.ts', '--', 'scopeBoundaryCandidates', 'src', 'scripts']);
});

test('common words yield zero candidates without searching', () => {
  let calls = 0;
  expect(findAskPathCandidates('the and test src', { cwd: '/repo', run: () => { calls++; return ''; } }))
    .toEqual({ tokens: [], paths: [] });
  expect(calls).toBe(0);
});

test('rg failure is an error, not a measured zero', () => {
  const result = findAskPathCandidates('scopeBoundaryCandidates', {
    cwd: '/repo', run: () => { throw Object.assign(new Error('rg unavailable'), { status: 2 }); },
  });
  expect(result).toEqual({ tokens: ['scopeBoundaryCandidates'], paths: [], error: 'rg unavailable' });
});

test('existing file fragments are candidates and ties sort by path, capped at five', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-path-candidate-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'actual.ts'), 'export {};');
    const result = findAskPathCandidates('`src/actual.ts`', { cwd: root, run: () => '' });
    expect(result.paths).toEqual(['src/actual.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
