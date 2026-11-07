import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMacrophageSafeCleanup } from './macrophage-safe-cleanup.js';

test('safe live cleanup inventory includes only merged rows and clean inactive merged worktrees under HQ work', () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-clean-'));
  const repoRoot = join(root, 'repo');
  const worktreeRoot = join(root, 'hq/work');
  const queueFile = join(root, 'land-queue.tsv');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(join(worktreeRoot, 'merged'), { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  const mergedRow = `123\t${'a'.repeat(40)}\t${join(worktreeRoot, 'task')}\t${join(root, 'evidence.json')}`;
  const openRow = `124\t${'b'.repeat(40)}\t${join(worktreeRoot, 'open')}\t${join(root, 'open.json')}`;
  writeFileSync(queueFile, `${mergedRow}\n${openRow}\n`);
  const calls: string[] = [];
  const cleanup = createMacrophageSafeCleanup({ repoRoot, queueFile, worktreeRoot, activeDirectories: () => [], run: (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'gh' && args[2] === '123') return { status: 0, stdout: '{"state":"MERGED","mergedAt":"2026-11-06T00:00:00Z"}', stderr: '' };
    if (command === 'gh') return { status: 0, stdout: '{"state":"OPEN","mergedAt":null}', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0,
      stdout: `worktree ${repoRoot}\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n\nworktree ${join(worktreeRoot, 'merged')}\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/feat/merged\n\nworktree ${join(root, 'outside')}\nHEAD ${'3'.repeat(40)}\nbranch refs/heads/feat/outside\n`, stderr: '' };
    if (args[0] === 'branch') return { status: 0, stdout: 'feat/merged\n', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  } });
  try {
    const inventory = cleanup.inventory();
    expect(inventory.map((scrap) => scrap.kind)).toEqual(['merged-land-queue-row', 'orphan-worktree']);
    const rowResult = cleanup.cleanup(inventory[0]!);
    expect(rowResult).toContain('merged PR #123');
    expect(readFileSync(queueFile, 'utf8')).toBe(`${openRow}\n`);
    const worktreeResult = cleanup.cleanup(inventory[1]!);
    expect(worktreeResult).toContain('feat/merged');
    expect(calls.some((call) => call.includes(`worktree remove ${join(worktreeRoot, 'merged')}`))).toBe(true);
    expect(calls.some((call) => call.includes('worktree remove') && call.includes('outside'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
