import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicallyRepairFiles, repairKoreanMarkdown, runNotesRepair } from './notes-repair.js';

function ownedDocsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-owned-'));
  const bare = join(root, 'origin.git');
  const tree = join(root, 'tree');
  const state = join(root, 'state');
  const version = '0.2.37';
  const branch = `release-docs/${version}`;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'clone', bare, tree);
  git(tree, 'config', 'user.name', 'Repair Fixture');
  git(tree, 'config', 'user.email', 'repair@example.invalid');
  const notes = join(tree, 'release/public/docs/releases', `${version}.md`);
  mkdirSync(join(tree, 'release/public/docs/releases'), { recursive: true });
  writeFileSync(notes, 'English intro\n한국어 변경\n');
  git(tree, 'add', '--', 'release/public/docs/releases/0.2.37.md');
  git(tree, 'commit', '-m', 'docs seed');
  git(tree, 'push', '-u', 'origin', 'main');
  git(tree, 'switch', '-c', branch);
  git(tree, 'push', '-u', 'origin', branch);
  const head = git(tree, 'rev-parse', 'HEAD');
  mkdirSync(join(state, 'release', version), { recursive: true });
  const owner = { runId: 'same-run', attempt: 0 };
  const docs = { outcome: 'ok', worktree: tree, notes, branch, artifactOwner: owner };
  const receiptPath = join(state, 'release', version, 'docs-branch-owner.json');
  writeFileSync(receiptPath, JSON.stringify({ owner, branch, worktree: tree, outcome: 'pushed', head, result: docs }) + '\n');
  const context = { runId: 'same-run', input: { version, previousVersion: '0.2.36' }, outputs: {
    docs, 'notes-check': { outcome: 'fail', findings: [{ rule: 'B11', file: notes, line: 2 }] },
  } };
  return { root, bare, tree, state, notes, branch, receiptPath, head, git, context };
}

describe('release notes Korean repair', () => {
  test('0.2.36 B1 failure reaches the repair node and fails closed without calling a model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-notes-b1-'));
    const notes = join(root, '0.2.36.md');
    writeFileSync(notes, 'Publishing internal Markdown remains in progress. (#30393)\n');
    try {
      const result = await runNotesRepair({ runId: '226ca1fa-b383-4b9b-b667-bec6b625e7d4', input: { version: '0.2.36', previousVersion: '0.2.35' }, outputs: {
        docs: { outcome: 'ok', worktree: root, notes },
        'notes-check': { outcome: 'fail', findings: [{ rule: 'B1', file: notes, line: 1 }] },
      } }, async () => { throw new Error('model must not run for B1'); });
      expect(result).toMatchObject({ outcome: 'fail', error: 'notes-check has non-B11 findings; translation cannot repair them' });
      expect(readFileSync(notes, 'utf8')).toContain('#30393');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('graph runner command dispatches notes-repair instead of unknown node', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-notes-dispatch-'));
    const notes = join(root, '0.2.36.md');
    writeFileSync(notes, 'Publishing internal Markdown remains in progress. (#30393)\n');
    try {
      const context = { nodeId: 'notes-repair', runId: '226ca1fa-b383-4b9b-b667-bec6b625e7d4',
        input: { version: '0.2.36', previousVersion: '0.2.35' }, outputs: {
          docs: { outcome: 'ok', worktree: root, notes },
          'notes-check': { outcome: 'fail', findings: [{ rule: 'B1', file: notes, line: 1 }] },
        } };
      const child = spawnSync('bun', ['scripts/release-loop/docs-node.ts', '--json'], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8',
        env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
      });
      expect(child.status).toBe(1);
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}');
      expect(result).toMatchObject({ outcome: 'fail', summary: 'notes-check has non-B11 findings; translation cannot repair them' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('B11 publishes only repaired docs to its owned remote branch and replays at the verified head', async () => {
    const f = ownedDocsFixture();
    try {
      const result = await runNotesRepair(f.context, async () => 'Korean change', { stateRoot: f.state });
      expect(result).toMatchObject({ outcome: 'ok', files: [f.notes], translatedLines: [2] });
      const head = f.git(f.tree, 'rev-parse', 'HEAD');
      expect(head).not.toBe(f.head);
      expect(f.git(f.bare, 'rev-parse', f.branch)).toBe(head);
      expect(f.git(f.tree, 'show', `${head}:release/public/docs/releases/0.2.37.md`))
        .toBe('English intro\nKorean change');
      expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).head).toBe(head);
      expect(f.git(f.tree, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'))
        .toBe('release/public/docs/releases/0.2.37.md');
      // Simulate a process stop after push but before the receipt rename: replay must verify
      // the same-run repair commit and recover the receipt without a second model call.
      const stale = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
      writeFileSync(f.receiptPath, JSON.stringify({ ...stale, head: f.head }) + '\n');
      const replay = await runNotesRepair(f.context, async () => { throw new Error('replay must not translate'); }, { stateRoot: f.state });
      expect(replay).toMatchObject({ outcome: 'ok', files: [], translatedLines: [], head });
      expect(f.git(f.bare, 'rev-parse', f.branch)).toBe(head);
      expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).head).toBe(head);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('B11 refuses a foreign remote advance before editing the owned worktree', async () => {
    const f = ownedDocsFixture();
    try {
      const foreign = join(f.root, 'foreign');
      f.git(f.root, 'clone', f.bare, foreign);
      f.git(foreign, 'config', 'user.name', 'Foreign Fixture');
      f.git(foreign, 'config', 'user.email', 'foreign@example.invalid');
      f.git(foreign, 'switch', '-c', f.branch, '--track', `origin/${f.branch}`);
      writeFileSync(join(foreign, 'foreign.txt'), 'foreign\n');
      f.git(foreign, 'add', 'foreign.txt');
      f.git(foreign, 'commit', '-m', 'foreign advance');
      f.git(foreign, 'push', 'origin', f.branch);
      const remote = f.git(f.bare, 'rev-parse', f.branch);
      const result = await runNotesRepair(f.context, async () => 'Korean change', { stateRoot: f.state });
      expect(result).toMatchObject({ outcome: 'fail' });
      expect(result.error).toContain('local/remote head differs');
      expect(readFileSync(f.notes, 'utf8')).toContain('한국어 변경');
      expect(f.git(f.bare, 'rev-parse', f.branch)).toBe(remote);
      expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).head).toBe(f.head);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  test('translates Korean prose lines and preserves English, inline code, and fenced code', async () => {
    const input = [
      '# Release notes',
      'This release improves speed.',
      '수정된 항목은 `release-loop` 입니다.',
      '```text',
      '한국어 코드 예시',
      '```',
    ].join('\n');
    const calls: string[] = [];
    const result = await repairKoreanMarkdown(input, async (line, model) => {
      calls.push(`${model}:${line}`);
      return 'The updated item is ⟦CODE0⟧.';
    });
    expect(calls).toEqual(['openrouter/z-ai/glm-5.3:수정된 항목은 ⟦CODE0⟧ 입니다.']);
    expect(result.text).toBe([
      '# Release notes',
      'This release improves speed.',
      'The updated item is `release-loop`.',
      '```text',
      '한국어 코드 예시',
      '```',
    ].join('\n'));
    expect(result.translatedLines).toEqual([3]);
  });

  test('retains original text and reports the line when translation fails', async () => {
    const input = 'English\n한국어 문장';
    const result = await repairKoreanMarkdown(input, async () => { throw new Error('provider unavailable'); });
    expect(result.text).toBe(input);
    expect(result.error).toBe('line 2: provider unavailable');
  });

  test('rejects an empty translation and keeps original text', async () => {
    const input = '한국어 문장';
    const result = await repairKoreanMarkdown(input, async () => '   ');
    expect(result.text).toBe(input);
    expect(result.error).toBe('line 1: translator returned empty text');
  });

  test('repairs only the B11 line numbers supplied by the real checker', async () => {
    const input = '허용된 한국어 <!-- announce:allow B11 -->\n문제 한국어';
    const calls: string[] = [];
    const result = await repairKoreanMarkdown(input, async (line) => { calls.push(line); return 'Problematic Korean'; }, new Set([2]));
    expect(calls).toEqual(['문제 한국어']);
    expect(result.text).toBe('허용된 한국어 <!-- announce:allow B11 -->\nProblematic Korean');
  });

  test('does not write any file when a later translation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-notes-repair-'));
    const first = join(root, 'first.md');
    const second = join(root, 'second.md');
    writeFileSync(first, '한국어 하나');
    writeFileSync(second, '한국어 둘');
    try {
      const result = await atomicallyRepairFiles([{ path: first, lines: [1] }, { path: second, lines: [1] }], async (line) => {
        if (line === '한국어 둘') throw new Error('model error');
        return 'English one';
      });
      expect(result.error).toBe(`${second}: line 1: model error`);
      expect(readFileSync(first, 'utf8')).toBe('한국어 하나');
      expect(readFileSync(second, 'utf8')).toBe('한국어 둘');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
