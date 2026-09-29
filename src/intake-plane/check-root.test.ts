import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIntakeCheckRoot } from '../cli/intake-cli.js';
import { runGitCommand } from '../git-fs/runner.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'intake-check-root-')); dirs.push(dir); return dir; };

test('하위 docs/ 에서 git 저장소 뿌리를 얻는다', () => {
  const repo = temp();
  expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
  const docs = join(repo, 'docs');
  mkdirSync(docs);
  const calls: string[] = [];
  const git: typeof runGitCommand = (cwd, args, options) => {
    calls.push(`${cwd}:${args.join(' ')}`);
    return runGitCommand(cwd, args, options);
  };
  // macOS 임시 폴더는 /var → /private/var 실경로라 git 이 실경로를 돌려준다 — 실경로로 비교한다.
  expect(realpathSync(resolveIntakeCheckRoot(docs, git))).toBe(realpathSync(repo));
  expect(calls).toEqual([`${docs}:rev-parse --show-toplevel`]);
});

test('docs/ 에서 실제 intake check --file note.md 는 파일 주장을 읽고 저장소 뿌리로 대조한다', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const docs = join(repo, 'docs');
  const dir = temp();
  const note = join(docs, 'note.md');
  expect(existsSync(note)).toBe(false);
  const preload = join(dir, 'preload.ts');
  const claim = 'elanous 에 `src/index.ts` 가 있다';
  writeFileSync(note, `- ${claim}\n`);
  writeFileSync(preload, `import { mock } from 'bun:test';\nconst original = await import(${JSON.stringify(join(repo, 'src/intake-plane/runtime-callables.ts'))});\nmock.module(${JSON.stringify(join(repo, 'src/intake-plane/runtime-callables.ts'))}, () => ({ ...original, buildIntakeDocumentStageCallables: () => ({ preprocess: ({ document }) => JSON.stringify({ claims: [{ text: document.trim().replace(/^- /, ''), quote: document.trim(), lens: 'L1 능력' }], discards: [] }), compare: () => JSON.stringify({ proposals: [] }) }) }));\n`);
  try {
    const result = spawnSync(process.execPath, ['--preload', preload, join(repo, 'bin/elanous.mjs'), '--test', 'intake', 'check', '--file', 'note.md', '--json'], { cwd: docs, encoding: 'utf8', timeout: 90_000 });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.tree).toBe(repo);
    expect(report.items).toHaveLength(1);
    expect(report.items[0].fact).toBe(claim);
    expect(report.items[0].verdict).not.toBe('못 쟀다');
    expect(report.items[0].evidence.some((row: { path?: string }) => row.path === 'src/index.ts')).toBe(true);
  } finally {
    if (existsSync(note)) rmSync(note);
  }
});

test('git 이 아닌 폴더에서는 호출 폴더를 그대로 쓰고 git 실패도 fallback 한다', () => {
  const dir = temp();
  expect(resolveIntakeCheckRoot(dir, runGitCommand)).toBe(dir);
  expect(resolveIntakeCheckRoot(dir, () => { throw new Error('git unavailable'); })).toBe(dir);
});
