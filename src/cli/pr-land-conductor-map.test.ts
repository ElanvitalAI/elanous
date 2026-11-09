import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsConductorMapRefresh, openConductorMapRefreshPr } from './pr-land-conductor-map.js';

test('post-land map refresh is only scheduled for fragment-only PRs', () => {
  expect(needsConductorMapRefresh(['docs/conductor/cells/release-loop.md'])).toBe(true);
  expect(needsConductorMapRefresh(['docs/conductor/cells/release-loop.md', 'docs/conductor/CONDUCTOR.md'])).toBe(false);
  expect(needsConductorMapRefresh(['docs/conductor/CONDUCTOR.md'])).toBe(false);
  expect(needsConductorMapRefresh(['scripts/generate-conductor-cell-map.ts'])).toBe(false);
});

test('post-land generated map PR is Terra-reviewed and pinned into the serialized queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-map-postland-test-'));
  mkdirSync(join(root, 'node_modules'));
  const branch = `docs/conductor-map-after-17-${'a'.repeat(8)}`;
  const head = 'b'.repeat(40);
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner = (command: string, args: readonly string[], cwd: string) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[4] as string, { recursive: true });
    if (command === 'git' && args[0] === 'diff' && args[1] === '--quiet') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && args[2] === '17')
      return { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } }), stderr: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/example/repo/pull/99', stderr: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && args[2] === '99')
      return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefName: branch, headRefOid: head }), stderr: '' };
    if (command === 'bun' && args[0] === 'bin/elanous.mjs')
      return { status: 0, stdout: JSON.stringify({ verdict: 'warn', mustFix: [], headCommit: head }), stderr: '' };
    if (command.endsWith('/land-enqueue.sh'))
      return { status: 0, stdout: `OK #99 head=${head.slice(0, 12)} headFull=${head}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    expect(await openConductorMapRefreshPr(17, root, runner)).toBe('https://github.com/example/repo/pull/99');
    const review = calls.findIndex((call) => call.command === 'bun' && call.args.includes('review'));
    const enqueue = calls.findIndex((call) => call.command.endsWith('/land-enqueue.sh'));
    expect(review).toBeGreaterThanOrEqual(0);
    expect(enqueue).toBeGreaterThan(review);
    expect(calls[review]?.args).toContain('gpt-6.1-terra');
    expect(calls[enqueue]?.args).toEqual(['99', expect.any(String), '--expected-head', head]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
