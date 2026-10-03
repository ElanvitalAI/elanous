// REL7c — two harness landings append to the same release/next.md section: both lines survive, no LLM.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNextMdConflict } from './next-md-merge.js';
import { defaultGitMergeSeam, mergeMainWithLlmResolve } from '../autopilot/build/llm-conflict-merge.js';

const BASE = '# Next\n\n## Feat\n\n- feat — old line. Target: next.\n\n## Fix\n\n- fix — old fix. Target: next.\n';
const lineA = '- feat — Landing A adds this. Target: next.';
const lineB = '- feat — Landing B adds this. Target: next.';
const withFeat = (...lines: string[]) => BASE.replace('- feat — old line. Target: next.\n', ['- feat — old line. Target: next.', ...lines].join('\n') + '\n');

test('same section, different lines → both kept, separator blank line stays', () => {
  const merged = resolveNextMdConflict(BASE, withFeat(lineA), withFeat(lineB))!;
  expect(merged).toContain(lineA);
  expect(merged).toContain(lineB);
  expect(merged.indexOf(lineB)).toBeLessThan(merged.indexOf('## Fix'));
  expect(merged).toContain(`${lineA}\n\n## Fix`);
});

test('same sentence on both sides → once', () => {
  const merged = resolveNextMdConflict(BASE, withFeat(lineA), withFeat(lineA))!;
  expect(merged.split(lineA).length - 1).toBe(1);
});

test('our side deleted a line → not decidable here (null)', () => {
  const ours = BASE.replace('- fix — old fix. Target: next.\n', '');
  expect(resolveNextMdConflict(BASE, ours, withFeat(lineB))).toBeNull();
});

test('their side removed released lines (dev-bump) → kept removed, our addition added', () => {
  const theirs = BASE.replace('- feat — old line. Target: next.\n', '');
  const merged = resolveNextMdConflict(BASE, withFeat(lineA), theirs)!;
  expect(merged).not.toContain('old line');
  expect(merged).toContain(lineA);
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function repoWithTwoLandings(otherFileConflict = false) {
  const root = mkdtempSync(join(tmpdir(), 'next-md-merge-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'release'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'release', 'next.md'), BASE);
  writeFileSync(join(repo, 'other.ts'), 'export const x = 0;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'landing-b');
  writeFileSync(join(repo, 'release', 'next.md'), withFeat(lineB));
  if (otherFileConflict) writeFileSync(join(repo, 'other.ts'), 'export const x = 2;\n');
  git(repo, 'commit', '-qam', 'landing B');
  git(repo, 'checkout', '-q', 'main');
  // Landing A merged first.
  writeFileSync(join(repo, 'release', 'next.md'), withFeat(lineA));
  if (otherFileConflict) writeFileSync(join(repo, 'other.ts'), 'export const x = 1;\n');
  git(repo, 'commit', '-qam', 'landing A');
  git(repo, 'checkout', '-q', 'landing-b');
  return repo;
}

test('★ concurrent landing: the second sync to main keeps both next.md lines without calling the LLM', async () => {
  const repo = repoWithTwoLandings();
  let llmCalls = 0;
  const outcome = await mergeMainWithLlmResolve(repo, 'main', async () => { llmCalls += 1; throw new Error('LLM must not be called for next.md'); }, defaultGitMergeSeam());
  expect(outcome.status).toBe('llm-resolved');
  expect(outcome.resolvedFiles).toEqual(['release/next.md']);
  expect(llmCalls).toBe(0);
  const merged = readFileSync(join(repo, 'release', 'next.md'), 'utf8');
  expect(merged).toContain(lineA);
  expect(merged).toContain(lineB);
  expect(merged.split(lineA).length - 1).toBe(1);
  expect(merged).not.toMatch(/^<{7}|^>{7}/m);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

test('another file also conflicts → that file goes to the usual resolver; an unresolved one still stops (abort)', async () => {
  const repo = repoWithTwoLandings(true);
  const seen: string[] = [];
  const outcome = await mergeMainWithLlmResolve(repo, 'main', async (file, conflicted) => { seen.push(file); return conflicted; }, defaultGitMergeSeam());
  expect(seen).toEqual(['other.ts']);
  expect(outcome.status).toBe('conflict-unresolved');
  expect(readFileSync(join(repo, 'release', 'next.md'), 'utf8')).toBe(withFeat(lineB));
});
