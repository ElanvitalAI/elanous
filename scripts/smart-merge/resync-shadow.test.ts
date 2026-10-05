import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResyncShadow, shadowSummary, conflictingHarnessDrafts, type ShadowRow } from './resync-shadow.js';
import type { MergeGitSeam } from '../../src/autopilot/build/llm-conflict-merge.js';

const base = '# Next\n\n## Fix\n- Base fix.\n';
const ours = '# Next\n\n## Fix\n- Base fix.\n- Draft fix.\n';
const theirs = '# Next\n\n## Fix\n- Base fix.\n- Main fix.\n';

test('three conflicting harness drafts: clean, deterministic next.md, unresolved code; no remote writes or leftover trees', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'resync-ledger-'));
  const scratchBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('elanous-resync-shadow-')));
  const calls: string[] = [];
  const summaries: string[] = [];
  let current = 0;
  let tick = 0;
  let llmCalls = 0;
  const run = (_cwd: string, program: 'git' | 'gh', args: readonly string[]) => {
    calls.push(`${program} ${args.join(' ')}`);
    if (program === 'gh') return { status: 0, stdout: JSON.stringify([
      { number: 101, headRefName: 'self-impl/clean', isDraft: true, mergeable: 'CONFLICTING' },
      { number: 102, headRefName: 'self-impl/next', isDraft: true, mergeable: false },
      { number: 103, headRefName: 'self-impl/code', isDraft: true, mergeable: 'CONFLICTING' },
      { number: 104, headRefName: 'human/topic', isDraft: true, mergeable: 'CONFLICTING' },
      { number: 105, headRefName: 'self-impl/ready', isDraft: true, mergeable: 'MERGEABLE' },
    ]), stderr: '' };
    if (args[0] === 'fetch' && args[2]?.startsWith('refs/pull/')) current = Number(args[2].split('/')[2]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const git: MergeGitSeam = {
    isConfiguredRemote: () => true,
    fetch: () => true,
    merge: () => current === 101 ? { ok: true, conflict: false, stdout: '' } : { ok: false, conflict: true, stdout: '' },
    conflictedFiles: () => current === 102 ? ['release/next.md'] : ['src/code.ts'],
    readIndexStage: (_wt, stage) => stage === 1 ? base : stage === 2 ? ours : theirs,
    readFile: () => '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n',
    writeFile: () => {}, add: () => {}, commit: () => true, abort: () => {},
  };
  try {
    const rows = await runResyncShadow({ repo: stateRoot, stateRoot, run, git, log: (line) => summaries.push(line),
      now: () => ++tick, resolve: async (_file, conflicted) => { llmCalls++; return conflicted; } });
    expect(rows.map((row) => row.outcome)).toEqual(['clean', 'resolved-deterministic', 'unresolved']);
    expect(rows.map((row) => row.files)).toEqual([[], ['release/next.md'], ['src/code.ts']]);
    expect(rows.map((row) => row.durationMs)).toEqual([1, 1, 1]);
    expect(llmCalls).toBe(1);
    expect(summaries).toEqual(['충돌 draft 3 중 살릴 수 있음 2 = 67%']);
    const persisted = readFileSync(join(stateRoot, 'smart-merge/resync-shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ShadowRow);
    expect(persisted).toEqual(rows);
    expect(calls.filter((call) => call.startsWith('gh '))).toHaveLength(1);
    expect(calls.some((call) => /\b(push|comment|label|edit|close)\b/.test(call))).toBe(false);
    expect(calls.filter((call) => call.includes('worktree remove'))).toHaveLength(3);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('elanous-resync-shadow-') && !scratchBefore.has(name))).toEqual([]);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('failed lookup is unmeasured, failed worktree is excluded, and limit bounds selected drafts', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'resync-fail-'));
  try {
    const listed = [{ number: 201, headRefName: 'self-impl/a', isDraft: true, mergeable: 'CONFLICTING' },
      { number: 202, headRefName: 'self-impl/b', isDraft: true, mergeable: 'CONFLICTING' }];
    const calls: string[] = [];
    const rows = await runResyncShadow({ repo: stateRoot, stateRoot, limit: 1, log: () => {},
      run: (_cwd, cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'gh') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
        return { status: args[0] === 'worktree' && args[1] === 'add' ? 1 : 0, stdout: '', stderr: 'worktree failed' };
      },
    });
    expect(rows.map((row) => [row.pr, row.outcome])).toEqual([[201, 'unmeasured']]);
    expect(shadowSummary(rows)).toBe('충돌 draft 0 중 살릴 수 있음 0 = 0%');
    expect(calls.some((call) => call.includes('202'))).toBe(false);
    const failed = await runResyncShadow({ repo: stateRoot, stateRoot, log: () => {},
      run: () => ({ status: 1, stdout: '', stderr: 'offline' }) });
    expect(failed).toEqual([]);
    expect(existsSync(join(stateRoot, 'smart-merge/resync-shadow.jsonl'))).toBe(true);
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test('incomplete GitHub inventory is not counted as an empty draft set', () => {
  expect(() => conflictingHarnessDrafts('[{"number":1,"isDraft":true,"headRefName":"self-impl/x"}]')).toThrow('incomplete');
});

test('drafts whose mergeable is still UNKNOWN are reported as not yet measured, not as zero conflicts', async () => {
  const { conflictingHarnessDrafts, unknownMergeableDrafts } = await import('./resync-shadow.js');
  const json = JSON.stringify([
    { number: 1, isDraft: true, headRefName: 'self-impl/a', mergeable: 'UNKNOWN' },
    { number: 2, isDraft: true, headRefName: 'self-impl/b', mergeable: 'UNKNOWN' },
    { number: 3, isDraft: true, headRefName: 'self-impl/c', mergeable: 'CONFLICTING' },
    { number: 4, isDraft: false, headRefName: 'self-impl/d', mergeable: 'UNKNOWN' },
  ]);
  expect(conflictingHarnessDrafts(json).map((row) => row.number)).toEqual([3]);
  expect(unknownMergeableDrafts(json)).toBe(2);
});
