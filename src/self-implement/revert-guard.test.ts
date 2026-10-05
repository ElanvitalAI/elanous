import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { commitWorktree } from './seams.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { dropStaleReverts } from './revert-guard.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
const commit = (message: string) => { git('add', '-A'); git('commit', '-m', message); };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'revert-guard-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
  writeFileSync(join(repo, 'inside.ts'), 'old');
  commit('old');
  writeFileSync(join(repo, 'outside.ts'), 'landed A');
  writeFileSync(join(repo, 'inside.ts'), 'landed A');
  commit('landing A');
  writeFileSync(join(repo, 'other.ts'), 'extra');
  commit('another landing');
});
afterEach(() => rmSync(repo, { force: true, recursive: true }));

describe('pre-commit stale-revert guard', () => {
  test('out-of-scope ancestor bytes are restored to HEAD and excluded from the commit', () => {
    writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
    writeFileSync(join(repo, 'other.ts'), 'legitimate change');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const outcome = dropStaleReverts(repo, ['inside.ts'], 'run-1');
      expect(outcome).toEqual({ reverted: ['outside.ts'], protected: [] });
      expect(log).toHaveBeenCalledWith('self-implement.revert-guard', 'reverted-stale', expect.objectContaining({ runId: 'run-1', files: ['outside.ts'], matchedCommit: git('rev-parse', 'HEAD~2') }));
      expect(commitWorktree(repo, 'harness run').ok).toBe(true);
      expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('other.ts');
      expect(readFileSync(join(repo, 'outside.ts'), 'utf8')).toBe('landed A');
    } finally { log.mockRestore(); }
  });

  test('base 이후 main에 추가된 대상 밖 삭제는 복원하고 커밋의 D에서 제외한다', () => {
    const base = git('rev-parse', 'HEAD~2');
    rmSync(join(repo, 'other.ts'));
    writeFileSync(join(repo, 'inside.ts'), 'feature change');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = dropStaleReverts(repo, ['inside.ts'], 'run-delete', 50, base);
      expect(result).toMatchObject({ staleDeleted: ['other.ts'], reverted: ['other.ts'], protected: [] });
      expect(log).toHaveBeenCalledWith('self-implement.revert-guard', 'reverted-stale-delete', { runId: 'run-delete', files: ['other.ts'] });
      expect(readFileSync(join(repo, 'other.ts'), 'utf8')).toBe('extra');
      expect(commitWorktree(repo, 'harness change').ok).toBe(true);
      expect(git('show', '--format=', '--name-status', 'HEAD')).toBe('M\tinside.ts');
    } finally { log.mockRestore(); }
  });

  test('staged D라도 작업 트리에 파일이 다시 있으면 삭제로 취급하지 않는다', () => {
    const base = git('rev-parse', 'HEAD~2');
    rmSync(join(repo, 'other.ts'));
    git('add', '-A');
    writeFileSync(join(repo, 'other.ts'), 'updated content');
    const result = dropStaleReverts(repo, ['inside.ts'], 'run-restored-worktree', 50, base);
    expect(result).toEqual({ reverted: [], protected: [] });
    expect(commitWorktree(repo, 'updated worktree').ok).toBe(true);
    expect(git('show', '--format=', '--name-status', 'HEAD')).toBe('M\tother.ts');
  });

  test('staged D 뒤 대상 밖 경로에 끊어진 symlink를 만들면 링크를 덮어쓰거나 삭제로 집계하지 않는다', () => {
    const base = git('rev-parse', 'HEAD~2');
    rmSync(join(repo, 'other.ts'));
    git('add', '-A');
    symlinkSync('nonexistent-target', join(repo, 'other.ts'));
    expect(git('diff', '--cached', '--name-status', 'HEAD', '--', 'other.ts')).toBe('D\tother.ts');
    expect(lstatSync(join(repo, 'other.ts')).isSymbolicLink()).toBe(true);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(dropStaleReverts(repo, ['inside.ts'], 'run-symlink', 50, base)).toEqual({ reverted: [], protected: [] });
      expect(log.mock.calls.filter(([category, event]) => category === 'self-implement.revert-guard' && event === 'reverted-stale-delete')).toEqual([]);
      expect(lstatSync(join(repo, 'other.ts')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repo, 'other.ts'))).toBe('nonexistent-target');
      expect(commitWorktree(repo, 'replace with symlink').ok).toBe(true);
      expect(git('show', '--format=', '--name-status', 'HEAD')).toBe('T\tother.ts');
      expect(git('ls-tree', 'HEAD', '--', 'other.ts')).toMatch(/^120000 blob /);
    } finally { log.mockRestore(); }
  });

  test('대상 안 삭제는 복원하지 않고 커밋의 D에 남는다', () => {
    rmSync(join(repo, 'inside.ts'));
    const outcome = dropStaleReverts(repo, ['inside.ts'], 'run-inside-delete', 50, git('rev-parse', 'HEAD~2'));
    expect(outcome).toEqual({ reverted: [], protected: [] });
    expect(commitWorktree(repo, 'intentional delete').ok).toBe(true);
    expect(git('show', '--format=', '--name-status', 'HEAD')).toBe('D\tinside.ts');
  });

  test('base에 있던 대상 밖 삭제는 경고만 하고 커밋의 D에 남는다', () => {
    rmSync(join(repo, 'outside.ts'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const outcome = dropStaleReverts(repo, ['inside.ts'], 'run-old-delete', 50, git('rev-parse', 'HEAD~2'));
      expect(outcome).toMatchObject({ reverted: [], protected: [], outsideDeleted: ['outside.ts'] });
      expect(log).toHaveBeenCalledWith('self-implement.revert-guard', 'outside-delete', { runId: 'run-old-delete', files: ['outside.ts'] }, { level: 'warn' });
      expect(commitWorktree(repo, 'intentional outside delete').ok).toBe(true);
      expect(git('show', '--format=', '--name-status', 'HEAD')).toBe('D\toutside.ts');
    } finally { log.mockRestore(); }
  });

  test('text-converted repository blobs still compare against exact worktree bytes', () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt text eol=lf\n');
    git('config', 'core.safecrlf', 'false');
    writeFileSync(join(repo, 'converted.txt'), 'older\r\n');
    commit('converted old');
    writeFileSync(join(repo, 'converted.txt'), 'newer\r\n');
    commit('converted landing');
    writeFileSync(join(repo, 'converted.txt'), 'older\r\n');
    expect(dropStaleReverts(repo, [], 'run-converted').reverted).toEqual([]);
    expect(readFileSync(join(repo, 'converted.txt'), 'utf8')).toBe('older\r\n');
  });

  test('staged stale files are also removed before add -A', () => {
    writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
    git('add', 'outside.ts');
    expect(dropStaleReverts(repo, [], 'run-staged').reverted).toEqual(['outside.ts']);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(git('diff', '--name-only')).toBe('');
  });

  test('in-scope ancestor bytes are retained with a warning', () => {
    writeFileSync(join(repo, 'inside.ts'), 'old');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(dropStaleReverts(repo, ['inside.ts'], 'run-2')).toEqual({ reverted: [], protected: ['inside.ts'] });
      expect(log).toHaveBeenCalledWith('self-implement.revert-guard', 'protected-target', expect.objectContaining({ files: ['inside.ts'] }), { level: 'warn' });
      expect(commitWorktree(repo, 'intentional rollback').ok).toBe(true);
      expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('inside.ts');
    } finally { log.mockRestore(); }
  });

  test('ordinary changes and changes beyond configured depth are left alone', () => {
    writeFileSync(join(repo, 'outside.ts'), 'fresh value');
    expect(dropStaleReverts(repo, [], 'run-3')).toEqual({ reverted: [], protected: [] });
    writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
    expect(dropStaleReverts(repo, [], 'run-3', 1)).toEqual({ reverted: [], protected: [] });
    expect(readFileSync(join(repo, 'outside.ts'))).toEqual(Buffer.from([0, 1, 255]));
  });

  test('orchestrator drops out-of-scope stale files before commit and puts count in PR Gate', async () => {
    let body = '';
    let order: string[] = [];
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/revert-guard', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => {
        writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
        writeFileSync(join(repo, 'inside.ts'), 'feature change');
        return { ok: true, summary: 'implemented' };
      },
      commitWork: (cwd, message) => {
        order.push('commit');
        expect(readFileSync(join(repo, 'outside.ts'), 'utf8')).toBe('landed A');
        commitWorktree(cwd, message);
      },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/1', number: 1 }; },
    });
    const outcome = await runSelfImplement({ feature: '대상 경로: inside.ts\nChange inside.ts only.', seams: s, runId: 'run-integration' });
    expect(outcome.stage).toBe('pr-opened');
    expect(order).toEqual(['commit']);
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('inside.ts');
    expect(body).toContain('## Gate\n');
    expect(body).toContain('- 되돌림 방지: 1파일 제외');
  });

  test('orchestrator의 commit 직전 stale-delete 복원과 PR Gate 삭제 제외·경고가 이어진다', async () => {
    const base = git('rev-parse', 'HEAD~2');
    let body = '';
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/stale-delete', resolvedBase: base, invokedHead: base }),
      implement: async () => {
        rmSync(join(repo, 'other.ts'));
        rmSync(join(repo, 'outside.ts'));
        writeFileSync(join(repo, 'inside.ts'), 'new implementation');
        return { ok: true, summary: 'implemented' };
      },
      commitWork: (cwd, message) => {
        expect(readFileSync(join(repo, 'other.ts'), 'utf8')).toBe('extra');
        commitWorktree(cwd, message);
      },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/stale-delete', number: 11 }; },
    });
    expect((await runSelfImplement({ feature: '대상 경로: inside.ts\nChange inside.ts only.', seams: s, runId: 'run-stale-delete' })).stage).toBe('pr-opened');
    expect(git('show', '--format=', '--name-status', 'HEAD')).toBe('M\tinside.ts\nD\toutside.ts');
    expect(body).toContain('## Gate');
    expect(body).toContain('- 되돌림 방지: 삭제 1파일 제외');
    expect(body).toContain('- 삭제 경고: 대상 밖 1파일 유지 (outside.ts)');
  });

  test('orchestrator does not protect stale files merely mentioned in piece prose as out of scope', async () => {
    let body = '';
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/outside.ts'), 'old piece');
    commit('piece base');
    writeFileSync(join(repo, 'src/outside.ts'), 'new piece');
    commit('piece landing');

    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/piece-target', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => {
        writeFileSync(join(repo, 'src/outside.ts'), 'old piece');
        writeFileSync(join(repo, 'inside.ts'), 'old');
        return { ok: true, summary: 'implemented' };
      },
      commitFinishedChildWork: () => ({ ok: true, out: '' }),
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/3', number: 3 }; },
    });
    expect((await runSelfImplement({ feature: '대상 경로: inside.ts\n조각: src/outside.ts 는 범위 밖 낡은 파일', seams: s, runId: 'run-piece' })).stage).toBe('pr-opened');
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('inside.ts');
    expect(readFileSync(join(repo, 'src/outside.ts'), 'utf8')).toBe('new piece');
    expect(body).toContain('- 되돌림 방지: 1파일 제외');
    expect(body).toContain('되돌림 경고: 대상 경로 1파일 유지 (inside.ts)');
  });

  test('an explicitly declared piece target stays protected', async () => {
    let body = '';
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/outside.ts'), 'old piece');
    commit('piece base');
    writeFileSync(join(repo, 'src/outside.ts'), 'new piece');
    commit('piece landing');
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/explicit-piece', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => {
        writeFileSync(join(repo, 'src/outside.ts'), 'old piece');
        writeFileSync(join(repo, 'inside.ts'), 'old');
        return { ok: true, summary: 'implemented' };
      },
      commitFinishedChildWork: () => ({ ok: true, out: '' }),
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/6', number: 6 }; },
    });
    expect((await runSelfImplement({ feature: '대상 경로: inside.ts\n조각 대상 경로: src/outside.ts', seams: s, runId: 'run-explicit-piece' })).stage).toBe('pr-opened');
    expect(git('show', '--format=', '--name-only', 'HEAD')).toContain('src/outside.ts');
    expect(body).toContain('되돌림 경고: 대상 경로 2파일 유지');
    expect(body).not.toContain('되돌림 방지:');
  });

  test('multiline piece target outside the ask target is preserved through commit', async () => {
    let body = '';
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/piece.ts'), 'old piece');
    commit('piece base');
    writeFileSync(join(repo, 'src/piece.ts'), 'landed piece');
    commit('piece landing');
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/multiline-piece', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => {
        writeFileSync(join(repo, 'inside.ts'), 'old');
        writeFileSync(join(repo, 'src/piece.ts'), 'old piece');
        return { ok: true, summary: 'intentional piece revert' };
      },
      commitFinishedChildWork: () => ({ ok: true, out: '' }),
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/multiline-piece', number: 9 }; },
    });
    expect((await runSelfImplement({ feature: '대상 경로: inside.ts\n조각 대상 경로:\n - src/piece.ts', seams: s, runId: 'run-multiline-piece' })).stage).toBe('pr-opened');
    expect(readFileSync(join(repo, 'src/piece.ts'), 'utf8')).toBe('old piece');
    expect(git('show', '--format=', '--name-only', 'HEAD')).toContain('src/piece.ts');
    expect(body).toContain('- 되돌림 경고: 대상 경로 2파일 유지 (inside.ts, src/piece.ts)');
    expect(body).not.toContain('- 되돌림 방지:');
  });

  test('multiline target declaration preserves intentional ancestor bytes through commit and Gate', async () => {
    let body = '';
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/inside.ts'), 'old piece');
    writeFileSync(join(repo, 'src/second.ts'), 'old second');
    commit('piece base');
    writeFileSync(join(repo, 'src/inside.ts'), 'landed piece');
    writeFileSync(join(repo, 'src/second.ts'), 'landed second');
    commit('piece landing');
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/multiline-target', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => {
        writeFileSync(join(repo, 'src/inside.ts'), 'old piece');
        writeFileSync(join(repo, 'src/second.ts'), 'old second');
        writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
        return { ok: true, summary: 'intentional revert' };
      },
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/multiline', number: 7 }; },
    });
    const outcome = await runSelfImplement({
      feature: '대상 경로:\n  - src/inside.ts\n  - src/second.ts\n\n조각 대상 경로:\n  - src/inside.ts\n의도적 되돌림. outside.ts 는 범위 밖.',
      seams: s, runId: 'run-multiline',
    });
    expect(outcome.stage).toBe('pr-opened');
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('src/inside.ts\nsrc/second.ts');
    expect(readFileSync(join(repo, 'src/inside.ts'), 'utf8')).toBe('old piece');
    expect(readFileSync(join(repo, 'src/second.ts'), 'utf8')).toBe('old second');
    expect(readFileSync(join(repo, 'outside.ts'), 'utf8')).toBe('landed A');
    expect(body).toContain('- 되돌림 경고: 대상 경로 2파일 유지 (src/inside.ts, src/second.ts)');
    expect(body).toContain('- 되돌림 방지: 1파일 제외');
  });

  test('orchestrator retains an in-scope revert and puts its warning in PR Gate', async () => {
    let body = '';
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/intentional-revert', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => { writeFileSync(join(repo, 'inside.ts'), 'old'); return { ok: true, summary: 'implemented' }; },
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/2', number: 2 }; },
    });
    expect((await runSelfImplement({ feature: '대상 경로: inside.ts\nIntentional revert.', seams: s, runId: 'run-intentional' })).stage).toBe('pr-opened');
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('inside.ts');
    expect(body).toContain('- 되돌림 경고: 대상 경로 1파일 유지 (inside.ts)');
    expect(body).not.toContain('되돌림 방지:');
  });

  test('ancestor matches at default depth but not when depth is one', () => {
    writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
    expect(dropStaleReverts(repo, [], 'run-default').reverted).toEqual(['outside.ts']);
    writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
    expect(dropStaleReverts(repo, [], 'run-shallow', 1).reverted).toEqual([]);
  });

  test('normal out-of-scope change survives the real pre-commit path', async () => {
    let body = '';
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/ordinary', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => { writeFileSync(join(repo, 'outside.ts'), 'fresh value'); return { ok: true, summary: 'implemented' }; },
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/4', number: 4 }; },
    });
    expect((await runSelfImplement({ feature: '대상 경로: inside.ts\nFix inside.ts.', seams: s, runId: 'run-normal' })).stage).toBe('pr-opened');
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('outside.ts');
    expect(readFileSync(join(repo, 'outside.ts'), 'utf8')).toBe('fresh value');
    expect(body).not.toContain('되돌림 방지:');
  });

  test('git inspection failure leaves the changed file for commit and exposes the reason', () => {
    writeFileSync(join(repo, 'outside.ts'), Buffer.from([0, 1, 255]));
    const fakeBin = join(repo, 'bin-fail-git');
    mkdirSync(fakeBin);
    const realGit = execFileSync('which', ['git']).toString().trim();
    writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\nif [ "$1" = rev-list ]; then echo 'simulated rev-list failure' >&2; exit 1; fi\nexec "${realGit}" "$@"\n`);
    chmodSync(join(fakeBin, 'git'), 0o755);
    const path = process.env.PATH;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let result;
    try {
      process.env.PATH = `${fakeBin}:${path ?? ''}`;
      result = dropStaleReverts(repo, [], 'run-fail-open');
    } finally { process.env.PATH = path; log.mockRestore(); }
    expect(result.warning).toContain('simulated rev-list failure');
    expect(result.reverted).toEqual([]);
    rmSync(fakeBin, { recursive: true, force: true });
    expect(commitWorktree(repo, 'fail-open commit').ok).toBe(true);
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('outside.ts');
  });

  test('inspection failure is visible in the PR Gate while commit proceeds', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'revert-guard-git-fail-'));
    const realGit = execFileSync('which', ['git']).toString().trim();
    writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\nif [ "$1" = rev-list ]; then echo 'simulated rev-list failure' >&2; exit 1; fi\nexec "${realGit}" "$@"\n`);
    chmodSync(join(fakeBin, 'git'), 0o755);
    let body = '';
    const s = seams({
      createWorktree: async () => ({ path: repo, branch: 'se/fail-open', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => { writeFileSync(join(repo, 'outside.ts'), 'fresh'); return { ok: true, summary: 'implemented' }; },
      commitWork: (cwd, message) => { commitWorktree(cwd, message); },
      mergeMain: async () => ({ status: 'up-to-date' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/fail-open', number: 5 }; },
    });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      expect((await runSelfImplement({ feature: '대상 경로: inside.ts\nFix inside.ts.', seams: s, runId: 'run-fail-open-pr' })).stage).toBe('pr-opened');
    } finally {
      process.env.PATH = previousPath;
      rmSync(fakeBin, { recursive: true, force: true });
    }
    expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('outside.ts');
    expect(body).toContain('되돌림 검사 실패(커밋 계속): git inspection failed:');
  });

  test('git failure does not prevent commit and is reported', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'revert-guard-nonrepo-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = dropStaleReverts(notRepo, [], 'run-4');
      expect(result.warning).toContain('git inspection failed');
      expect(result.reverted).toEqual([]);
      expect(log).toHaveBeenCalledWith('self-implement.revert-guard', 'fail-open', expect.objectContaining({ runId: 'run-4', reason: result.warning }), { level: 'warn' });
    } finally { log.mockRestore(); rmSync(notRepo, { recursive: true, force: true }); }
  });
});
