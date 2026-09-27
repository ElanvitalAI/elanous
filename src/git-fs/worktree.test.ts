// git-fs worktree — resetExisting 견고화 실git 테스트(대표 지시 2026-07-12).
// 재실행/재구현 시 안정 브랜치명(se/…-<phaseHex>)이 이전 세대에서 고아로 남아도
// SE 격리가 하드 실패("branch already exists") 대신 흡수해야 한다(dogfood: KGS 즉사).
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, lstatSync, chmodSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWorktree, gateWorktreeReuse, isUnbornHeadError, linkWorktreeDependencies, worktreeParentDir, worktreeDirName, observeGitResidue, gateGitResidue, removeWorktree, syncBaseWithRemote, DEFAULT_BRANCH_WORKTREE_BASE, DEFAULT_WORKTREE_DEPENDENCY_PATHS, type GitRunner, type WorktreeReuseExpectation } from './worktree.js';
import { recordHarnessWorktreeProvenance } from '../harness/harness-worktree-add.js';
import { isTransientGitError } from './retry.js';
import { setGitCommandRunnerForTesting } from './runner.js';
import { debug } from '../debug/log.js';
import { reviewScopeDiff } from '../self-implement/seams.js';

function git(repo: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} — ${r.stderr}`);
}

describe('createWorktree — resetExisting 견고화', () => {
  let tmp: string, repo: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-reset-'));
    repo = join(tmp, 'monad-agent');
    git(tmp, 'init', '-q', 'monad-agent');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  // ⛔ 회귀 — 수용 기준은 **게이트 반환값이 아니라 실제 삭제 여부**다(무인 리뷰 should-fix).
  //    `removeWorktree` 수준에서 셋을 고정한다: 정상 삭제 · 고아 잔여 차단(트리가 남는다) ·
  //    갓 생긴 잠금은 통과(오탐 금지).
  test('removeWorktree — 잔여 없으면 지우고, 고아 잔여면 막고 트리를 남기고, 갓 생긴 잠금은 통과한다', () => {
    const mk = (branch: string): string => createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch, base: 'HEAD', resetExisting: true }).path;

    // ⑴ 잔여 없음 → 실제로 사라진다
    const clean = mk('se/clean');
    expect(existsSync(clean)).toBe(true);
    removeWorktree(repo, clean, true);
    expect(existsSync(clean)).toBe(false);

    // ⑵ 고아 잔여(오래된 index.lock) → 막히고 **트리가 남는다**
    const blocked = mk('se/blocked');
    const blockedGitFile = join(blocked, '.git');
    const blockedGitDir = readFileSync(blockedGitFile, 'utf8').replace(/^gitdir:\s*/, '').trim();
    const staleLock = join(blockedGitDir, 'index.lock');
    writeFileSync(staleLock, '');
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(staleLock, old, old);
    expect(() => removeWorktree(repo, blocked, true)).toThrow(/residue/);
    expect(existsSync(blocked)).toBe(true);        // ⛔ 막혔으면 지우지 않는다

    // ⑶ 갓 생긴 잠금 → 통과(오탐 금지). 같은 트리에서 잠금만 새것으로 바꾼다.
    const now = new Date();
    utimesSync(staleLock, now, now);
    removeWorktree(repo, blocked, true);
    expect(existsSync(blocked)).toBe(false);
  });

  test('기본(resetExisting 미지정) — 브랜치 이미 존재 시 하드 실패(TUI 보호)', () => {
    git(repo, 'branch', 'se/x'); // 브랜치 선점
    expect(() => createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/x', base: 'HEAD' })).toThrow(/already exists/);
  });

  test('★ resetExisting=true — 고아 브랜치 존재해도 -B 로 재생성 성공(재실행 흡수)', () => {
    git(repo, 'branch', 'se/x'); // 이전 세대 고아 브랜치
    const res = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/x', base: 'HEAD', resetExisting: true });
    expect(existsSync(res.path)).toBe(true);
    expect(res.branch).toBe('se/x');
    expect(res.base).toBe('HEAD');
    expect(res.resolvedBase).toMatch(/^[0-9a-f]{40}$/);
    expect(res.resolvedBase).toBe(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: res.path, encoding: 'utf8' }).stdout.trim());
    // 실제 worktree 로 등록됐는지
    const list = spawnSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).stdout;
    expect(list).toContain(worktreeDirName('se/x'));
  });

  test('★ resetExisting=true — 브랜치도 경로도 없을 때 정상 신규 생성', () => {
    const res = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/fresh', base: 'HEAD', resetExisting: true });
    expect(existsSync(res.path)).toBe(true);
    expect(res.path).toContain(worktreeParentDir(repo, dirname(repo)));
  });

  // ⭐ `base` 는 **ref 이름**(생략 시 'HEAD')이고 `resolvedBase` 는 **그 ref 가 가리킨 SHA** 다.
  //    'HEAD' 라는 이름만으로는 어디서 갈렸는지 알 수 없다는 것이 이 필드가 생긴 이유다.
  //    ⛔ `base` 의 기존 의미(해소된 ref)를 바꾸지 않는다 — 공유 계약이고 이 목표에 불필요하다(리뷰 must-fix).
  test('base 는 해소된 ref 이고, 시작 커밋 SHA 는 resolvedBase 가 따로 답한다', () => {
    const res = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/default', resetExisting: true });
    expect(res.base).toBe('HEAD');
    expect(res.resolvedBase).toMatch(/^[0-9a-f]{7,40}$/);
    expect(res.resolvedBase).toBe(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: res.path, encoding: 'utf8' }).stdout.trim());
  });

  // ⛔ `base: 'HEAD'` 로만 검증하면 **아무것도 증명하지 못한다** — 기본값과 결과가 같아서
  //    "명시한 ref 를 실제로 썼나" 가 안 갈린다(리뷰 should-fix). 그래서 **다른 커밋**을 만들고
  //    그 이전 커밋을 base 로 준다: resolvedBase 가 HEAD 가 아니라 **그 ref** 를 가리켜야 한다.
  test('명시 base 는 HEAD 가 아니라 그 ref 의 커밋에서 갈린다', () => {
    const first = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    git(repo, 'tag', 'base-point');
    writeFileSync(join(repo, 'second.txt'), 'second\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    expect(head).not.toBe(first);   // 전제: 두 커밋이 실제로 다르다

    const res = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/explicit', base: 'base-point', resetExisting: true });
    expect(res.base).toBe('base-point');
    expect(res.resolvedBase).toBe(first);
    expect(res.resolvedBase).not.toBe(head);   // ⭐ 이 줄이 'HEAD' 테스트가 못 하던 일을 한다
  });
});

describe('createWorktree — elanous dev 기본 브랜치 분기', () => {
  let tmp: string, origin: string, repo: string, mainSha: string, callerSha: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-default-base-'));
    origin = join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', 'origin.git');
    repo = join(tmp, 'monad-agent');
    git(tmp, 'init', '-q', '-b', 'main', 'monad-agent');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'shared.txt'), 'main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'main');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    mainSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    git(repo, 'checkout', '-q', '-b', 'feature/caller');
    writeFileSync(join(repo, 'caller-only.txt'), 'caller\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'caller commit');
    callerSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  test('기본 표식은 피처 HEAD 대신 기본 브랜치에서 시작하며 호출자 커밋을 diff에 싣지 않는다', () => {
    const child = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/default', base: DEFAULT_BRANCH_WORKTREE_BASE, resetExisting: true });
    expect(child.resolvedBase).toBe(mainSha);
    expect(child.resolvedBase).not.toBe(callerSha);
    const diff = spawnSync('git', ['diff', '--name-only', 'origin/main...child/default'], { cwd: repo, encoding: 'utf8' }).stdout;
    expect(diff).not.toContain('caller-only.txt');
  });

  test('실제 reviewScopeDiff 입력은 기본 자식에서 호출자 커밋을 빼고 --base HEAD 탈출구에서는 유지한다', async () => {
    const defaultChild = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/review-default', base: DEFAULT_BRANCH_WORKTREE_BASE, resetExisting: true });
    const defaultReviewDiff = await reviewScopeDiff(defaultChild.path, 'origin/main');
    expect(defaultReviewDiff).not.toContain('caller-only.txt');

    const headChild = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/review-head', base: 'HEAD', resetExisting: true });
    const headReviewDiff = await reviewScopeDiff(headChild.path, 'origin/main');
    expect(headChild.base).toBe('HEAD');
    expect(headChild.resolvedBase).toBe(callerSha);
    expect(headReviewDiff).toContain('caller-only.txt');
  });

  test('임의 명시 base는 기본 표식으로 대체되지 않는다', () => {
    const child = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/explicit', base: 'main', resetExisting: true });
    expect(child.base).toBe('main');
    expect(child.resolvedBase).toBe(mainSha);
  });

  test('참조 거울 origin 의 비기본 base 로 발사하면 fetch 를 지나 원격 tip 에서 시작한다', () => {
    git(repo, 'push', '-q', 'origin', 'feature/caller');
    const child = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/from-feature', base: 'origin/feature/caller', resetExisting: true });
    expect(child.base).toBe('origin/feature/caller');
    expect(child.baseFreshness).toBe('remote-synced');
    expect(child.resolvedBase).toBe(callerSha);
    expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: child.path, encoding: 'utf8' }).stdout.trim()).toBe(callerSha);
  });

  test('기본 브랜치 교정은 선택한 base를 실행 관측으로 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/observed', base: DEFAULT_BRANCH_WORKTREE_BASE, resetExisting: true });
      expect(log).toHaveBeenCalledWith(
        'git-fs.worktree',
        'base.default-branch',
        expect.objectContaining({ branch: 'child/observed', base: 'origin/main', callerBase: 'HEAD', defaultBranchResolved: true }),
      );
    } finally {
      log.mockRestore();
    }
  });

  test('origin develop도 기본 브랜치로 해석해 발사를 계속한다', () => {
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'develop');
    writeFileSync(join(repo, 'develop.txt'), 'develop\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'develop');
    git(repo, 'push', '-q', '-u', 'origin', 'develop');
    const developSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    git(tmp, '--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
    git(repo, 'remote', 'set-head', 'origin', '--auto');
    git(repo, 'checkout', '-q', '-b', 'feature/develop-caller');

    const child = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child/develop', base: DEFAULT_BRANCH_WORKTREE_BASE, resetExisting: true });
    expect(child.resolvedBase).toBe(developSha);
    expect(child.base).toBe('origin/develop');
  });
});

describe('linkWorktreeDependencies — 항목별 fail-soft 결과', () => {
  let tmp: string, repo: string, worktree: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-deps-'));
    repo = join(tmp, 'repo');
    worktree = join(tmp, 'worktree');
    mkdirSync(repo, { recursive: true });
    mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('원본 유무와 기존 대상을 구분해 반환하고 대상 부모를 만든다', () => {
    mkdirSync(join(repo, 'present', 'package'), { recursive: true });
    mkdirSync(join(worktree, 'already'), { recursive: true });
    mkdirSync(join(repo, 'already'), { recursive: true });

    const result = linkWorktreeDependencies(repo, worktree, ['present/package', 'missing/package', 'already']);

    expect(result).toEqual({
      linked: ['present/package'],
      skippedMissingSource: [...DEFAULT_WORKTREE_DEPENDENCY_PATHS, 'missing/package'],
      skippedExistingTarget: ['already'],
      failed: [],
    });
    expect(lstatSync(join(worktree, 'present', 'package')).isSymbolicLink()).toBe(true);
  });

  test('주입한 심링크 실패는 모든 항목에 기록되고 다음 항목을 계속 시도한다', () => {
    mkdirSync(join(repo, 'first'), { recursive: true });
    mkdirSync(join(repo, 'second'), { recursive: true });
    const attempted: string[] = [];

    const result = linkWorktreeDependencies(repo, worktree, ['first', 'second'], {
      symlink: (_source, target) => {
        attempted.push(target);
        throw new Error(`denied: ${target}`);
      },
    });

    expect(attempted).toEqual([join(worktree, 'first'), join(worktree, 'second')]);
    expect(result.linked).toEqual([]);
    expect(result.skippedMissingSource).toEqual([...DEFAULT_WORKTREE_DEPENDENCY_PATHS]);
    expect(result.failed).toEqual([
      { path: 'first', reason: `Error: denied: ${join(worktree, 'first')}` },
      { path: 'second', reason: `Error: denied: ${join(worktree, 'second')}` },
    ]);
  });
});

describe('createWorktree — node_modules 링크(시스템 보강 2026-07-21·리뷰 오판 방지)', () => {
  let tmp: string, repo: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-nm-'));
    repo = join(tmp, 'monad-agent');
    git(tmp, 'init', '-q', 'monad-agent');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  test('★ 중앙 계획의 루트·PWA node_modules 를 worktree 에 symlink(자식 통합검증 가능)', () => {
    mkdirSync(join(repo, 'node_modules', 'somepkg'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'pwa', 'node_modules', 'pwa-pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'somepkg', 'index.js'), 'module.exports=1');
    writeFileSync(join(repo, 'apps', 'pwa', 'node_modules', 'pwa-pkg', 'index.js'), 'module.exports=2');
    const res = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/nm', base: 'HEAD', resetExisting: true });

    for (const relativePath of DEFAULT_WORKTREE_DEPENDENCY_PATHS) {
      const target = join(res.path, relativePath);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(realpathSync(target)).toBe(realpathSync(join(repo, relativePath)));
    }
    expect(existsSync(join(res.path, 'node_modules', 'somepkg', 'index.js'))).toBe(true);
    expect(existsSync(join(res.path, 'apps', 'pwa', 'node_modules', 'pwa-pkg', 'index.js'))).toBe(true);
  });

  test('중앙 계획의 원본이 없으면 링크를 건너뛰고 worktree 생성은 성공한다', () => {
    const res = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/no-nm', base: 'HEAD', resetExisting: true });
    expect(existsSync(res.path)).toBe(true);
    for (const relativePath of DEFAULT_WORKTREE_DEPENDENCY_PATHS) {
      expect(existsSync(join(res.path, relativePath))).toBe(false);
    }
  });

  test('재사용 worktree도 중앙 계획의 새 하위 앱 의존성을 idempotent 하게 연결한다', () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const created = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/reuse-deps', base: 'HEAD', resetExisting: true });
    mkdirSync(join(repo, 'apps', 'pwa', 'node_modules', 'pwa-pkg'), { recursive: true });
    recordHarnessWorktreeProvenance(created.path, { owner: 'dev:reuse-deps', command: 'elanous dev', createdAt: '2026-08-16T00:00:00.000Z' });

    const reused = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/reuse-deps', reuseOwnedWorktree: true });

    expect(reused.reused).toBe(true);
    expect(lstatSync(join(reused.path, 'apps', 'pwa', 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(reused.path, 'apps', 'pwa', 'node_modules'))).toBe(realpathSync(join(repo, 'apps', 'pwa', 'node_modules')));
  });
});

// ★ 병렬 안전 — git 락 경쟁 판정(auto-merge dogfood 실측 근본)
describe('createWorktree — 이미 점유한 브랜치', () => {
  let tmp: string, repo: string, holder: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-held-branch-'));
    repo = join(tmp, 'monad-agent');
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'initial');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'initial');
    git(repo, 'branch', 'se/held');
    holder = join(tmp, 'holder');
    git(repo, 'worktree', 'add', '-q', holder, 'se/held');
  });

  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  // ⚠️ 무인 리뷰 should-fix — 경로에 작은따옴표가 있으면 `[^']+` 가 경로를 잘라
  //    엉뚱한 값을 메시지·관측에 남긴다. git 문면은 경로가 줄 끝이므로 거기서 끊는다.
  test("작은따옴표가 든 holder 경로도 온전히 남는다", () => {
    const quoted = join(repo, "it's-a-worktree");
    const g = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    g('worktree', 'add', '-b', 'se/quoted', quoted);
    try {
      expect(() => createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/quoted', base: 'HEAD', resetExisting: true }))
        .toThrow(quoted);
    } finally {
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', quoted], { encoding: 'utf8' });
    }
  });

  test('clean holder를 detach하지 않고 경로를 메시지와 관측에 남긴다', () => {
    const holderPath = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: holder, encoding: 'utf8' }).stdout.trim();
    const holderRef = 'refs/heads/se/held';
    const headBefore = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: holder, encoding: 'utf8' }).stdout.trim();
    const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: holder, encoding: 'utf8' }).stdout.trim();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(() => createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/held', base: 'HEAD', resetExisting: true }))
        .toThrow(new RegExp(`already used by worktree at ${holderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      const headAfter = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: holder, encoding: 'utf8' }).stdout.trim();
      const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: holder, encoding: 'utf8' }).stdout.trim();
      expect(headBefore).toBe(holderRef);
      expect(headAfter).toBe(holderRef);
      expect(headAfter).toBe(headBefore);
      expect(statusAfter).toBe(statusBefore);
      expect(log).toHaveBeenCalledWith(
        'git-fs.worktree',
        'add.branch-held',
        expect.objectContaining({ attempt: 1, branch: 'se/held', blockingPath: holderPath }),
        { level: 'warn' },
      );
      const heldLog = log.mock.calls.find(([, event]) => event === 'add.branch-held');
      expect(heldLog?.[2]).not.toHaveProperty('err');
    } finally {
      log.mockRestore();
    }
  });
});

describe('observeGitResidue — 공유 저장소 중단 상태 관측', () => {
  let tmp: string, repo: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'git-residue-'));
    repo = join(tmp, 'repo');
    git(tmp, 'init', '-q', 'repo');
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('residue-present: 종류별 마커를 구분하고 판정은 저장소를 바꾸지 않는다', async () => {
    const gitDir = join(repo, '.git');
    mkdirSync(join(gitDir, 'sequencer'));
    writeFileSync(join(gitDir, 'sequencer', 'todo'), 'pick deadbeef subject\n');
    mkdirSync(join(gitDir, 'rebase-merge'));
    writeFileSync(join(gitDir, 'MERGE_HEAD'), 'merge');
    writeFileSync(join(gitDir, 'index.lock'), 'lock');
    const before = readFileSync(join(gitDir, 'MERGE_HEAD'), 'utf8');

    expect(await observeGitResidue(repo)).toEqual({ state: 'observed', residues: ['cherry-pick', 'merge', 'rebase', 'index-lock'] });
    expect(readFileSync(join(gitDir, 'MERGE_HEAD'), 'utf8')).toBe(before);
    expect(existsSync(join(gitDir, 'sequencer'))).toBe(true);
  });

  test('single-commit cherry-pick conflict: Git이 남긴 CHERRY_PICK_HEAD만으로 잔여를 관측한다', async () => {
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'conflict.txt'), 'base\n');
    git(repo, 'add', 'conflict.txt');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-qb', 'topic');
    writeFileSync(join(repo, 'conflict.txt'), 'topic\n');
    git(repo, 'commit', '-am', 'topic');
    git(repo, 'checkout', '-q', '-');
    writeFileSync(join(repo, 'conflict.txt'), 'main\n');
    git(repo, 'commit', '-am', 'main');
    const result = spawnSync('git', ['cherry-pick', 'topic'], { cwd: repo, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(existsSync(join(repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
    expect(existsSync(join(repo, '.git', 'sequencer'))).toBe(false);
    expect(await observeGitResidue(repo)).toEqual({ state: 'observed', residues: ['cherry-pick'] });
  });

  test('linked worktree: its per-worktree CHERRY_PICK_HEAD does not contaminate the main checkout', async () => {
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'conflict.txt'), 'base\n');
    git(repo, 'add', 'conflict.txt');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-qb', 'topic');
    writeFileSync(join(repo, 'conflict.txt'), 'topic\n');
    git(repo, 'commit', '-am', 'topic');
    git(repo, 'checkout', '-q', '-');
    writeFileSync(join(repo, 'conflict.txt'), 'main\n');
    git(repo, 'commit', '-am', 'main');
    const linked = join(tmp, 'linked');
    git(repo, 'worktree', 'add', '-qb', 'linked', linked, 'HEAD');
    const result = spawnSync('git', ['cherry-pick', 'topic'], { cwd: linked, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(await observeGitResidue(linked)).toEqual({ state: 'observed', residues: ['cherry-pick'] });
    expect(await observeGitResidue(repo)).toEqual({ state: 'observed', residues: [] });
  });

  test('bisect: Git이 만든 BISECT_START를 중단 상태로 관측한다', async () => {
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'history.txt'), 'one\n');
    git(repo, 'add', 'history.txt');
    git(repo, 'commit', '-qm', 'one');
    git(repo, 'bisect', 'start');

    expect(existsSync(join(repo, '.git', 'BISECT_START'))).toBe(true);
    expect(await observeGitResidue(repo)).toEqual({ state: 'observed', residues: ['bisect'] });
  });

  test('residue marker inventory: Git 중단 마커를 전수로 관측하고 같은 kind는 중복하지 않는다', async () => {
    const gitDir = join(repo, '.git');
    for (const marker of ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD', 'BISECT_START', 'index.lock']) {
      writeFileSync(join(gitDir, marker), marker);
    }
    mkdirSync(join(gitDir, 'sequencer'));
    writeFileSync(join(gitDir, 'sequencer', 'todo'), 'pick deadbeef subject\n');
    mkdirSync(join(gitDir, 'rebase-merge'));
    mkdirSync(join(gitDir, 'rebase-apply'));

    expect(await observeGitResidue(repo)).toEqual({
      state: 'observed',
      residues: ['cherry-pick', 'revert', 'merge', 'rebase', 'bisect', 'index-lock'],
    });
  });

  test('residue-absent: 마커가 없으면 observed 빈 목록으로 남는다', async () => {
    expect(await observeGitResidue(repo)).toEqual({ state: 'observed', residues: [] });
  });

  test('gate: fresh index lock passes but stale lock and interrupted state stop cleanup', () => {
    const lock = join(repo, '.git', 'index.lock');
    writeFileSync(lock, 'lock');
    const now = Date.now();
    expect(gateGitResidue(repo, now)).toMatchObject({ allowed: true, observation: { residues: ['index-lock'] } });
    const stale = new Date(now - 6 * 60_000);
    utimesSync(lock, stale, stale);
    expect(gateGitResidue(repo, now)).toMatchObject({ allowed: false, observation: { residues: ['index-lock'] } });
    expect(() => removeWorktree(repo, repo, true)).toThrow('git residue blocks operation: index-lock');
    rmSync(lock);
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'merge');
    expect(gateGitResidue(repo, now)).toMatchObject({ allowed: false, observation: { residues: ['merge'] } });
  });

  test('unreadable: lstat 권한 거부는 빈 목록이 아닌 unreadable로 남는다', () => {
    expect(observeGitResidue(repo, {
      lstat: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      readFile: () => '',
    })).toEqual({ state: 'unreadable' });
  });

  test('sequencer: todo가 pick이 아니면 cherry-pick으로 단정하지 않는다', async () => {
    const gitDir = join(repo, '.git');
    mkdirSync(join(gitDir, 'sequencer'));
    writeFileSync(join(gitDir, 'sequencer', 'todo'), 'revert deadbeef subject\n');
    expect(await observeGitResidue(repo)).toEqual({ state: 'observed', residues: ['sequencer'] });
  });

  test('mutation: 종류를 단일 boolean으로 접으면 실패한다', async () => {
    const gitDir = join(repo, '.git');
    mkdirSync(join(gitDir, 'sequencer'));
    writeFileSync(join(gitDir, 'sequencer', 'todo'), 'pick deadbeef subject\n');
    writeFileSync(join(gitDir, 'MERGE_HEAD'), 'merge');
    const observation = await observeGitResidue(repo);
    expect(observation).toEqual({ state: 'observed', residues: ['cherry-pick', 'merge'] });
    expect(observation).not.toEqual({ state: 'observed', residues: ['cherry-pick'] });
  });
});

describe('createWorktree — unborn HEAD guidance', () => {
  let tmp: string, repo: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-unborn-head-'));
    repo = join(tmp, 'repo');
    git(tmp, 'init', '-q', 'repo');
  });

  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  test('unborn HEAD 문면만 순수하게 판정한다', () => {
    expect(isUnbornHeadError('fatal: invalid reference: HEAD')).toBe(true);
    expect(isUnbornHeadError("fatal: 'se/x' is already used by worktree at '/tmp/holder'")).toBe(false);
    expect(isUnbornHeadError('fatal: not a valid object name')).toBe(false);
  });

  test('커밋 없는 저장소는 재시도 없이 빈 저장소에서도 되는 첫 커밋 명령을 안내한다', () => {
    expect(() => createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/unborn', base: 'HEAD' }))
      .toThrow('this repository has no commits yet; create the first commit with: git commit --allow-empty -m "Initial commit"');
  });

  test('안내한 빈 초기 커밋 후 실제 워크트리를 생성한다', () => {
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'commit', '--allow-empty', '-m', 'Initial commit');

    const created = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'se/recovered', base: 'HEAD' });

    expect(existsSync(created.path)).toBe(true);
    expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: created.path, encoding: 'utf8' }).status).toBe(0);
  });
});

describe('isTransientGitError — 병렬 worktree add 락 판정', () => {
  test('락/일시적 에러 = true(재시도 대상)', () => {
    for (const e of [
      'fatal: could not lock config file',
      "fatal: Unable to create '/repo/.git/index.lock': File exists",
      'error: cannot lock ref',
      'another git process seems to be running',
      'fatal: Unable to write new index file',
    ]) expect(isTransientGitError(e)).toBe(true);
  });
  test('진짜 에러 = false(즉시 throw)', () => {
    for (const e of [
      "fatal: invalid reference: origin/nope",
      'fatal: not a valid object name',
      "fatal: '../wt' already exists",
    ]) expect(isTransientGitError(e)).toBe(false);
  });
});

// ⭐⭐ 낡은 로컬 base 차단(2026-07-29 실측) — `git worktree add <path> <base>` 는 base 를
// **로컬에서만** 푼다. 원격이 앞서 있으면 자식이 낡은 지점에서 갈리고 **실패하지 않는다**.
// 실사례: `--base <PR 브랜치>` 를 줬는데 자식이 4커밋 전에서 갈려 이미 있는 파일을 새로 썼고,
// 그 스택 머지가 base 를 삼켜 리뷰가 남의 작업을 이 PR 것으로 읽었다(거짓 scope-creep).
// 네트워크 없이 재현한다 — 로컬 bare repo 를 origin 으로 쓴다.
describe('createWorktree — base 신선도 (원격이 앞설 때)', () => {
  let tmp: string, origin: string, repo: string, oldSha: string, newSha: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-base-'));
    origin = join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', 'origin.git');

    repo = join(tmp, 'monad-agent');
    git(tmp, 'init', '-q', 'monad-agent');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'A');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'A');
    git(repo, 'checkout', '-q', '-b', 'feat');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'feat');
    oldSha = spawnSync('git', ['rev-parse', 'feat'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    // 이 repo 를 'feat' 밖으로 빼둔다 — worktree add 가 체크아웃된 브랜치를 못 쓴다.
    git(repo, 'checkout', '-q', '--detach');

    // 원격만 전진시킨다(다른 클론에서 push) — repo 의 로컬 refs/heads/feat 는 그대로 낡는다.
    const other = join(tmp, 'other');
    git(tmp, 'clone', '-q', origin, 'other');
    git(other, 'config', 'user.email', 't@t.t');
    git(other, 'config', 'user.name', 't');
    git(other, 'checkout', '-q', 'feat');
    writeFileSync(join(other, 'f.txt'), 'B');
    git(other, 'commit', '-qam', 'B');
    git(other, 'push', '-q', 'origin', 'feat');
    newSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: other, encoding: 'utf8' }).stdout.trim();
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  test('로컬 ref 가 낡았어도 원격 tip 에서 갈린다 (freshness=remote-synced)', () => {
    // 전제: 이 시점에 로컬 feat 는 아직 낡아 있다 — 그래야 이 테스트가 무언가를 잰다.
    const localBefore = spawnSync('git', ['rev-parse', 'feat'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    expect(localBefore).toBe(oldSha);
    expect(newSha).not.toBe(oldSha);

    const r = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child-fresh', base: 'feat', resetExisting: true });
    expect(r.baseFreshness).toBe('remote-synced');
    expect(r.resolvedBase).toBe(newSha);          // ⭐ 원격 tip
    expect(r.resolvedBase).not.toBe(oldSha);      // ⛔ 낡은 로컬이 아니다
    expect(r.base).toBe('feat');                  // 요청한 ref 이름은 그대로 보고한다
  });

  test('skipRemoteBaseSync=true 면 낡은 로컬에서 갈리고 그 사실을 값으로 말한다', () => {
    const r = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child-stale', base: 'feat', resetExisting: true, skipRemoteBaseSync: true });
    expect(r.baseFreshness).toBe('local-only');
    expect(r.resolvedBase).toBe(oldSha);          // 낡은 지점 — 그러나 freshness 가 그렇다고 말한다
  });

  test('base 미지정이면 원격을 보지 않는다 (freshness=head)', () => {
    const r = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'child-head', resetExisting: true });
    expect(r.baseFreshness).toBe('head');
  });
});

// ⭐ 사후 리뷰(PR #5921) must-fix 4건 + should-fix 회귀 가드.
// 최초 구현은 리뷰 없이 main 에 직행했고, 사후 리뷰가 아래 넷을 잡았다:
//   ① ls-remote tail 매칭이라 `feat` 가 `x/feat` 에 걸린다
//   ② ls-remote 로 읽은 SHA 에서 갈려 fetch 사이 원격 전진을 놓친다
//   ③ skip 검사가 SHA 판정보다 앞이라 명시 SHA 가 local-only 로 보고된다
//   ④ hex 이름 브랜치가 SHA 로 오분류돼 원격 동기화를 건너뛴다
describe('createWorktree — base 신선도 실패·모호 분기 (사후 리뷰 must-fix)', () => {
  let tmp: string, origin: string, repo: string;
  const setupRepo = (withOrigin: boolean) => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-edge-'));
    repo = join(tmp, 'monad-agent');
    git(tmp, 'init', '-q', 'monad-agent');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'A');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'A');
    if (withOrigin) {
      origin = join(tmp, 'origin.git');
      git(tmp, 'init', '-q', '--bare', 'origin.git');
      git(repo, 'remote', 'add', 'origin', origin);
    }
  };
  afterEach(() => {
    try { if (origin) chmodSync(join(origin, 'objects'), 0o755); } catch { /* */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  test('③ 명시 SHA 는 skip 여부와 무관하게 sha 로 보고된다', () => {
    setupRepo(false);
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const a = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'c-sha-a', base: sha, resetExisting: true });
    expect(a.baseFreshness).toBe('sha');
    const b = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'c-sha-b', base: sha, resetExisting: true, skipRemoteBaseSync: true });
    expect(b.baseFreshness).toBe('sha');   // ⛔ 종전엔 skip 이 먼저라 local-only 로 거짓 보고
  });

  test('④ hex 이름 **브랜치**는 SHA 로 오분류되지 않는다', () => {
    setupRepo(false);
    git(repo, 'branch', 'abc1234');
    const r = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'c-hexname', base: 'abc1234', resetExisting: true });
    // origin 이 없으니 remote-unreachable — 중요한 건 'sha' 로 새지 않았다는 것이다.
    expect(r.baseFreshness).not.toBe('sha');
    expect(['remote-unreachable', 'local-only']).toContain(r.baseFreshness);
  });

  test('① 접미가 같은 다른 네임스페이스 브랜치를 원격 tip 으로 오인하지 않는다', () => {
    setupRepo(true);
    // origin 에는 `x/feat` 만 있고 `feat` 는 없다. tail 매칭이면 `feat` 가 여기 걸린다.
    git(repo, 'checkout', '-q', '-b', 'x/feat');
    writeFileSync(join(repo, 'f.txt'), 'X');
    git(repo, 'commit', '-qam', 'X');
    git(repo, 'push', '-q', 'origin', 'x/feat');
    git(repo, 'checkout', '-q', '-b', 'feat', 'HEAD~1');   // 로컬 전용 `feat`
    const localFeat = spawnSync('git', ['rev-parse', 'feat'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    git(repo, 'checkout', '-q', '--detach');

    const r = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'c-ns', base: 'feat', resetExisting: true });
    expect(r.baseFreshness).toBe('local-only');   // origin 에 `refs/heads/feat` 는 없다
    expect(r.resolvedBase).toBe(localFeat);       // ⛔ 종전엔 `x/feat` 의 tip 으로 갈릴 수 있었다
  });

  test('origin 이 없으면 remote-unreachable 로 말하고 로컬로 간다 (fail-soft)', () => {
    setupRepo(false);
    git(repo, 'branch', 'solo');
    const solo = spawnSync('git', ['rev-parse', 'solo'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const r = createWorktree({ repoRoot: repo, worktreeRoot: dirname(repo), branch: 'c-noorigin', base: 'solo', resetExisting: true });
    expect(r.baseFreshness).toBe('remote-unreachable');
    expect(r.resolvedBase).toBe(solo);
  });

});

// ⭐ base 동기화의 **실패 분기**는 실 git 으로 결정론적으로 못 만든다(objects 를 지우면
// ls-remote 까지 죽어 다른 분기로 샌다 — 실제로 그렇게 새는 것을 확인했다). seam 으로 잰다.
// 사후 리뷰(PR #5921) should-fix: 그 분기들이 회귀 무방비였다.
describe('syncBaseWithRemote — 실패 분기 (seam)', () => {
  const REMOTE = 'f'.repeat(40);
  const AHEAD = 'a'.repeat(40);
  const LOCAL = '9'.repeat(40);
  const ok = (stdout = ''): ReturnType<GitRunner> => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr = 'boom'): ReturnType<GitRunner> => ({ status: 1, stdout: '', stderr });

  /** 기본 응답을 주고 필요한 것만 덮는다 — 대역이 "요청한 것만" 답하게 유지한다. */
  function runner(over: Partial<Record<'showRef' | 'lsRemote' | 'fetch' | 'fetchHead' | 'localRev', ReturnType<typeof ok>>> = {}): GitRunner {
    return (args) => {
      if (args[0] === 'show-ref') return over.showRef ?? fail();
      if (args[0] === 'ls-remote') return over.lsRemote ?? ok(`${REMOTE}\trefs/heads/feat\n`);
      if (args[0] === 'fetch') return over.fetch ?? ok();
      if (args[0] === 'rev-parse' && args[2] === 'FETCH_HEAD^{commit}') return over.fetchHead ?? ok(`${REMOTE}\n`);
      if (args[0] === 'rev-parse') return over.localRev ?? ok(`${LOCAL}\n`);
      return fail();
    };
  }

  test('⛔ origin 에 있는데 fetch 가 실패하면 던진다 (fail-closed · 낡은 채로 진행 금지)', () => {
    expect(() => syncBaseWithRemote('/r', 'feat', false, runner({ fetch: fail('network down') })))
      .toThrow(/base sync failed.*fetch failed/s);
  });

  test('fetch 실패에 status·signal·stdout·stderr 가 남고 stderr 가 비어도 사유가 비지 않는다', () => {
    expect(() => syncBaseWithRemote('/r', 'feat', false, runner({
      fetch: { status: null, signal: 'SIGTERM', stdout: 'fetch interrupted\n', stderr: '' },
    }))).toThrow('fetch failed: status=null, signal=SIGTERM, stdout="fetch interrupted", stderr=""');
    expect(() => syncBaseWithRemote('/r', 'feat', false, runner({
      fetch: { status: 128, stdout: '', stderr: '' },
    }))).toThrow('fetch failed: status=128, signal=none, stdout="", stderr=""');
  });

  function remoteRepo(): { repo: string; dispose: () => void } {
    const tmp = mkdtempSync(join(tmpdir(), 'wt-sync-retry-'));
    const repo = join(tmp, 'repo');
    const origin = join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', 'origin.git');
    git(tmp, 'init', '-q', '-b', 'feat', 'repo');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'feat');
    return { repo, dispose: () => rmSync(tmp, { recursive: true, force: true }) };
  }

  test('runner 미주입 fetch는 공용 runner에서 lock 실패 뒤 재시도해 정상 동기화한다', () => {
    const fixture = remoteRepo();
    let fetchCalls = 0;
    const calls: string[][] = [];
    setGitCommandRunnerForTesting((cwd, args, options) => {
      calls.push([...args]);
      if (args[0] === 'fetch') {
        expect(options).toMatchObject({ encoding: 'utf8', timeout: 30_000 });
        fetchCalls += 1;
        if (fetchCalls === 1) return fail('fatal: cannot lock ref \'refs/remotes/origin/feat\': is at old');
      }
      const result = spawnSync('git', args, { ...options, cwd });
      return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    });
    try {
      expect(syncBaseWithRemote(fixture.repo, 'feat', false)).toMatchObject({ freshness: 'remote-synced' });
      expect(fetchCalls).toBe(2);
      expect(calls.filter((args) => args[0] === 'fetch')).toEqual([
        ['fetch', 'origin', 'refs/heads/feat'],
        ['fetch', 'origin', 'refs/heads/feat'],
      ]);
    } finally {
      setGitCommandRunnerForTesting(undefined);
      fixture.dispose();
    }
  });

  test('runner 주입 fetch는 재시도 seam을 우회하고 이전처럼 한 번만 호출한다', () => {
    const calls: string[][] = [];
    expect(() => syncBaseWithRemote('/r', 'feat', false, (args) => {
      calls.push([...args]);
      if (args[0] === 'show-ref') return fail();
      if (args[0] === 'ls-remote') return ok(`${REMOTE}\trefs/heads/feat\n`);
      if (args[0] === 'fetch') return fail('fatal: cannot lock ref');
      return fail('unexpected');
    })).toThrow(/base sync failed.*fetch failed/s);
    expect(calls.filter((args) => args[0] === 'fetch')).toEqual([['fetch', 'origin', 'refs/heads/feat']]);
  });

  test('runner 미주입 fetch가 lock 재시도를 소진하면 fail-closed로 던진다', () => {
    const fixture = remoteRepo();
    let fetchCalls = 0;
    setGitCommandRunnerForTesting((cwd, args, options) => {
      if (args[0] === 'fetch') {
        fetchCalls += 1;
        return fail('fatal: cannot lock ref \'refs/remotes/origin/feat\'');
      }
      const result = spawnSync('git', args, { ...options, cwd });
      return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    });
    try {
      expect(() => syncBaseWithRemote(fixture.repo, 'feat', false)).toThrow(/base sync failed.*fetch failed/s);
      expect(fetchCalls).toBe(6);
    } finally {
      setGitCommandRunnerForTesting(undefined);
      fixture.dispose();
    }
  }, 10_000);

  test('⛔ fetch 는 됐는데 FETCH_HEAD 를 못 읽으면 던진다 (모름을 값으로 바꾸지 않는다)', () => {
    expect(() => syncBaseWithRemote('/r', 'feat', false, runner({ fetchHead: fail() })))
      .toThrow(/FETCH_HEAD is unreadable/);
  });

  test('② fetch 사이 원격이 전진하면 **가져온 tip** 에서 갈린다 (ls-remote 가 읽은 옛 SHA 아님)', () => {
    const r = syncBaseWithRemote('/r', 'feat', false, runner({ fetchHead: ok(`${AHEAD}\n`) }));
    expect(r.freshness).toBe('remote-synced');
    expect(r.checkout).toBe(AHEAD);      // ⭐ FETCH_HEAD
    expect(r.checkout).not.toBe(REMOTE); // ⛔ ls-remote 가 먼저 읽은 값이 아니다
  });

  test('① 정확한 ref 로 묻고, 정확히 그 ref 인 줄만 원격 존재로 친다', () => {
    const seen: string[][] = [];
    const base = runner();
    const r = syncBaseWithRemote('/r', 'feat', false, (args) => {
      seen.push(args);
      // 접미만 같은 다른 네임스페이스만 응답 → 원격에 `refs/heads/feat` 는 없다.
      if (args[0] === 'ls-remote') return ok(`${REMOTE}\trefs/heads/x/feat\n`);
      return base(args);
    });
    expect(seen.find((a) => a[0] === 'ls-remote')).toEqual(['ls-remote', '--heads', 'origin', 'refs/heads/feat']);
    expect(r.freshness).toBe('local-only');
    expect(seen.some((a) => a[0] === 'fetch')).toBe(false);   // 없는 것을 가져오려 하지 않는다
  });

  test('ls-remote 자체가 실패하면 remote-unreachable — 로컬로 가되 그 사실을 말한다', () => {
    const r = syncBaseWithRemote('/r', 'feat', false, runner({ lsRemote: fail('no network') }));
    expect(r.freshness).toBe('remote-unreachable');
    expect(r.checkout).toBe('feat');
  });

  test('④ hex 이름이어도 로컬 브랜치면 SHA 로 치지 않는다', () => {
    const r = syncBaseWithRemote('/r', 'abc1234', false, runner({ showRef: ok(), lsRemote: fail() }));
    expect(r.freshness).not.toBe('sha');
    expect(r.freshness).toBe('remote-unreachable');
  });
});

// ⭐ 리뷰 must-fix(#5922 ②차): hex 이름 판정이 **로컬 heads 만** 봐서, 원격에만 있거나
// remote-tracking 으로만 있는 hex 이름 브랜치가 로컬 커밋 약어와 겹치면 여전히 SHA 로 샌다.
describe('syncBaseWithRemote — hex 이름 모호성 (2차 리뷰 must-fix)', () => {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = () => ({ status: 1, stdout: '', stderr: 'no' });
  const REMOTE = 'b'.repeat(40);

  test('원격에만 있는 hex 이름 브랜치는 SHA 가 아니라 브랜치다', () => {
    const r = syncBaseWithRemote('/r', 'abc1234', false, (args) => {
      if (args[0] === 'show-ref') return fail();                      // 로컬엔 아무 ref 도 없다
      if (args[0] === 'ls-remote') return ok('x\trefs/heads/abc1234\n');  // ⭐ 원격엔 있다
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[2] === 'FETCH_HEAD^{commit}') return ok(`${REMOTE}\n`);
      if (args[0] === 'rev-parse') return ok('deadbee\n');            // 커밋으로도 풀린다(모호)
      return fail();
    });
    expect(r.freshness).toBe('remote-synced');   // ⛔ 종전엔 'sha' 로 샜다
    expect(r.checkout).toBe(REMOTE);
  });

  test('remote-tracking ref 로만 알려진 hex 이름도 SHA 로 치지 않는다', () => {
    const r = syncBaseWithRemote('/r', 'abc1234', true, (args) => {
      if (args[0] === 'show-ref') return args[3]?.startsWith('refs/remotes/') ? ok() : fail();
      if (args[0] === 'rev-parse') return ok('deadbee\n');
      return fail();
    });
    expect(r.freshness).toBe('local-only');      // skip 이지만 'sha' 가 아니다
  });

  test('어디에도 ref 가 없고 커밋으로 풀리면 그때는 sha 다', () => {
    const r = syncBaseWithRemote('/r', 'abc1234', false, (args) => {
      if (args[0] === 'show-ref') return fail();
      if (args[0] === 'ls-remote') return ok('');   // 원격에도 없다
      if (args[0] === 'rev-parse') return ok('deadbee\n');
      return fail();
    });
    expect(r.freshness).toBe('sha');
  });
});

// ⭐ 리뷰 must-fix(#5922 4차): `skip` 이면 ls-remote 전에 반환하므로 **원격에만 있는 hex 브랜치**가
// 로컬 커밋 약어로도 풀릴 때 `sha` 로 오분류된다. skip 은 네트워크를 안 쓰겠다는 뜻이므로 그 경우를
// **알 방법이 없다** — 모르는 것을 `sha` 라고 단언하지 않는다.
describe('syncBaseWithRemote — skip 일 때의 hex 모호성 (4차 리뷰 must-fix)', () => {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = () => ({ status: 1, stdout: '', stderr: 'no' });
  const noLocalRefButResolves: GitRunner = (args) => {
    if (args[0] === 'show-ref') return fail();          // 로컬 heads·remote-tracking 둘 다 없다
    if (args[0] === 'rev-parse') return ok('deadbee\n'); // 그런데 커밋으로는 풀린다(모호)
    return fail();
  };

  test('skip + **축약** hex 는 sha 라고 단언하지 않는다 (모름 → local-only)', () => {
    const r = syncBaseWithRemote('/r', 'abc1234', true, noLocalRefButResolves);
    expect(r.freshness).toBe('local-only');   // ⛔ 종전엔 'sha' 로 단언했다
  });

  test('skip + **완전한 40자 oid** 는 모호하지 않으므로 sha 다', () => {
    const full = 'c'.repeat(40);
    const r = syncBaseWithRemote('/r', full, true, noLocalRefButResolves);
    expect(r.freshness).toBe('sha');
  });

  test('ls-remote 가 "그런 브랜치 없다" 고 답하면 축약 hex 도 sha 다 (모호성이 풀렸다)', () => {
    const r = syncBaseWithRemote('/r', 'abc1234', false, (args) => {
      if (args[0] === 'show-ref') return fail();
      if (args[0] === 'ls-remote') return ok('');       // 원격에도 없다 ⇒ 모호하지 않다
      if (args[0] === 'rev-parse') return ok('deadbee\n');
      return fail();
    });
    expect(r.freshness).toBe('sha');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 소유 워크트리 재사용 (2026-08-11) — 안전장치를 «푸는» 변경이라 조건을 좁게 잡았다.
//
// 왜: 외부 에이전트 백엔드로 PR 을 낸 뒤 그 PR 의 리뷰를 «같은 브랜치»에 이어 붙이려 하면
//     종전엔 `add.branch-held` 에서 무조건 막혀 사람이 손으로 워크트리를 지우고 다시 쏴야 했다.
//     ⇒ 수리 라운드가 무인으로 안 돈다.
// 무엇을 무는가: ⑴ 허용/거부의 «산출이 다르다» ⑵ 거부 사유가 «조건마다 다른 값»이다
//               ⑶ 요청하지 않은 호출자의 문면이 «한 글자도 안 바뀐다».
// ⚠️ 소유 표시는 **이 저장소의 기록기**(`recordHarnessWorktreeProvenance`)로 남긴다 — 테스트가
//    관례의 실물을 물게 하기 위해서다. 여기서 키를 손으로 쓰면 관례가 바뀔 때 테스트가 안 죽는다.
describe('createWorktree — 소유 워크트리 재사용', () => {
  let tmp: string, repo: string, root: string;

  // ⚠️ macOS 의 tmp 는 심링크(`/var` → `/private/var`)다. `createWorktree` 는 «만든» 경로를
  //    `resolve` 로 돌려주는데 `git worktree list` 는 «실경로»를 낸다 — 그 비대칭은 종전부터
  //    있던 것이고 이 변경의 대상이 아니다. 테스트는 실경로로 맞춰 잰다.
  const real = (path: string): string => realpathSync(path);
  const mkHolder = (branch: string) => {
    const created = createWorktree({ repoRoot: repo, worktreeRoot: root, branch, base: 'HEAD', skipRemoteBaseSync: true });
    return { ...created, path: real(created.path) };
  };
  const stamp = (path: string, owner = 'dev:run-abcdef12') =>
    recordHarnessWorktreeProvenance(path, { owner, command: 'elanous dev', createdAt: new Date().toISOString() });
  const reuse = (branch: string, currentOwner?: string) =>
    createWorktree({
      repoRoot: repo,
      worktreeRoot: root,
      branch,
      base: 'HEAD',
      skipRemoteBaseSync: true,
      reuseOwnedWorktree: true,
      ...(currentOwner !== undefined ? { currentOwner } : {}),
    });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wt-reuse-'));
    repo = join(tmp, 'monad-agent');
    root = join(tmp, 'roots');
    mkdirSync(root, { recursive: true });
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  test('소유 표시가 있고 깨끗하고 호출자가 요청하면 — 같은 트리를 그대로 돌려준다', () => {
    const first = mkHolder('se/reuse-ok');
    stamp(first.path);
    const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: first.path, encoding: 'utf8' }).stdout.trim();

    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let again: ReturnType<typeof createWorktree>;
    try {
      again = reuse('se/reuse-ok');
      expect(log).toHaveBeenCalledWith(
        'git-fs.worktree',
        'add.branch-held-reused',
        expect.objectContaining({ branch: 'se/reuse-ok', worktreePath: first.path, owner: 'dev:run-abcdef12' }),
        { level: 'warn' },
      );
    } finally {
      log.mockRestore();
    }

    // ⛔ 「재사용했다」는 **경로가 같다**로 끝나지 않는다 — 트리를 안 건드렸다는 것까지 본다.
    expect(real(again.path)).toBe(first.path);
    expect(again.reused).toBe(true);
    expect(again.baseFreshness).toBe('reused');
    expect(again.resolvedBase).toBe(headBefore);
    expect(existsSync(first.path)).toBe(true);
    expect(spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: first.path, encoding: 'utf8' }).stdout.trim())
      .toBe('refs/heads/se/reuse-ok');
  });

  // ⭐⭐ 판정 신호의 본체 — **허용과 거부의 산출이 다르고, 거부 사유가 조건마다 다른 값**이다.
  test('조건마다 다른 이유로 거부하고, 허용된 경우와 산출이 다르다', () => {
    const refusalOf = (branch: string): string => {
      try { reuse(branch); }
      catch (error) { return String((error as Error).message); }
      throw new Error(`재사용이 거부되지 않았다 — ${branch}`);
    };
    const reasonOf = (message: string): string | null => message.match(/reuse refused: ([a-z-]+)$/)?.[1] ?? null;

    // ⑴ 소유 표시가 «없다»(이 저장소가 만들었어도 기록기를 안 거친 트리)
    const unowned = mkHolder('se/reuse-unowned');
    const unownedMessage = refusalOf('se/reuse-unowned');

    // ⑵ 표시가 «있으나 이 저장소의 문면이 아니다**
    const foreign = mkHolder('se/reuse-foreign');
    stamp(foreign.path, 'somebody-else');
    const foreignMessage = refusalOf('se/reuse-foreign');

    // ⑶ 커밋되지 않은 변경이 있다
    const dirty = mkHolder('se/reuse-dirty');
    stamp(dirty.path);
    writeFileSync(join(dirty.path, 'f.txt'), 'edited-but-not-committed');
    const dirtyMessage = refusalOf('se/reuse-dirty');

    // ⑷ 허용 — 셋과 «산출 종류 자체»가 다르다(던지지 않고 값을 낸다)
    const allowed = mkHolder('se/reuse-allowed');
    stamp(allowed.path);
    const allowedResult = reuse('se/reuse-allowed');

    const reasons = [reasonOf(unownedMessage), reasonOf(foreignMessage), reasonOf(dirtyMessage)];
    expect(reasons).toEqual(['owner-not-recorded', 'owner-foreign', 'worktree-dirty']);
    expect(new Set(reasons).size).toBe(3);                    // ⛔ 조건마다 «다른 값»이어야 한다
    expect(allowedResult.reused).toBe(true);                  // 허용은 값을 낸다
    expect(real(allowedResult.path)).toBe(allowed.path);

    // ⛔ 거부는 트리를 지우지 않는다 — 거절이 파괴로 새면 안전장치를 «푼 것»이 아니라 «깬 것»이다
    for (const held of [unowned, foreign, dirty]) expect(existsSync(held.path)).toBe(true);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: dirty.path, encoding: 'utf8' }).stdout.trim()).not.toBe('');
  });

  test('같은 런이 자기 dirt 가 있는 워크트리를 다시 요청하면 — 재사용하고 내용을 지우지 않는다', () => {
    const first = mkHolder('se/reuse-own-dirty');
    stamp(first.path, 'dev:run-self');
    writeFileSync(join(first.path, 'artifact.html'), 'round-1 output');
    const dirtBefore = spawnSync('git', ['status', '--porcelain'], { cwd: first.path, encoding: 'utf8' }).stdout;

    const again = reuse('se/reuse-own-dirty', 'dev:run-self');
    expect(real(again.path)).toBe(first.path);
    expect(again.reused).toBe(true);
    expect(again.baseFreshness).toBe('reused');
    expect(readFileSync(join(first.path, 'artifact.html'), 'utf8')).toBe('round-1 output');
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: first.path, encoding: 'utf8' }).stdout).toBe(dirtBefore);
  });

  test('다른 런의 dirt 가 있는 워크트리를 요청하면 — worktree-dirty 로 거부한다', () => {
    const held = mkHolder('se/reuse-foreign-dirty');
    stamp(held.path, 'dev:run-first');
    writeFileSync(join(held.path, 'f.txt'), 'someone-elses-dirt');
    expect(() => reuse('se/reuse-foreign-dirty', 'dev:run-other'))
      .toThrow(/reuse refused: worktree-dirty$/);
    expect(existsSync(held.path)).toBe(true);
    expect(readFileSync(join(held.path, 'f.txt'), 'utf8')).toBe('someone-elses-dirt');
  });

  test('지금 요청하는 런 값을 안 주고 부르면 — 더티는 종전대로 worktree-dirty 로 거부한다', () => {
    const held = mkHolder('se/reuse-no-current-owner');
    stamp(held.path, 'dev:run-self');
    writeFileSync(join(held.path, 'f.txt'), 'own-but-unclaimed');
    expect(() => reuse('se/reuse-no-current-owner'))
      .toThrow(/reuse refused: worktree-dirty$/);
    expect(() => reuse('se/reuse-no-current-owner', '   '))
      .toThrow(/reuse refused: worktree-dirty$/);
  });

  // ⛔ 불변식 — 요청하지 않은 호출자에게는 **한 글자도 바뀌지 않는다**.
  test('호출자가 요청하지 않으면 종전 문면 그대로 거부하고, 관측에는 이유가 남는다', () => {
    const held = mkHolder('se/reuse-not-asked');
    stamp(held.path);                                          // 소유·청결을 «다» 갖췄어도
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(() => createWorktree({ repoRoot: repo, worktreeRoot: root, branch: 'se/reuse-not-asked', base: 'HEAD', skipRemoteBaseSync: true }))
        .toThrow(`git worktree add failed — branch se/reuse-not-asked is already used by worktree at ${held.path}`);
      const message = (() => {
        try { createWorktree({ repoRoot: repo, worktreeRoot: root, branch: 'se/reuse-not-asked', base: 'HEAD', skipRemoteBaseSync: true }); }
        catch (error) { return String((error as Error).message); }
        return '';
      })();
      expect(message.endsWith(held.path)).toBe(true);          // ⛔ 접미 없음 — 종전 문면 그대로
      expect(message).not.toContain('reuse refused');
      expect(log).toHaveBeenCalledWith(
        'git-fs.worktree',
        'add.branch-held',
        expect.objectContaining({ attempt: 1, branch: 'se/reuse-not-asked', blockingPath: held.path, reuseRefusal: 'reuse-not-requested' }),
        { level: 'warn' },
      );
    } finally {
      log.mockRestore();
    }
  });

  // 실 git 으로 못 만드는 «모름» 분기들 — 주입 러너로 결정론적으로 잰다.
  // ⛔ 부재(`owner-not-recorded`)와 미지(`owner-unreadable`)를 «같은 값»으로 두지 않는다.
  test('gateWorktreeReuse — 못 읽은 것과 없는 것과 못 잰 것이 각각 다른 값이다', () => {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const runner = (overrides: Record<string, { status: number | null; stdout: string; stderr: string }>): GitRunner => (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return overrides.revParse ?? ok('/wt\n');
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return overrides.commonDir ?? ok('/repo/.git\n');
      if (args[0] === 'symbolic-ref') return overrides.head ?? ok('refs/heads/se/x\n');
      if (args[0] === 'config' && args[1] === '--get') return overrides.extension ?? ok('true\n');
      if (args[0] === 'config' && args[1] === '--worktree') {
        const key = args[args.length - 1];
        if (key.endsWith('.owner')) return overrides.owner ?? ok('dev:run-1\n');
        if (key.endsWith('.command')) return overrides.command ?? ok('elanous dev\n');
        return overrides.createdAt ?? ok('2026-08-11T00:00:00.000Z\n');
      }
      if (args[0] === 'status') return overrides.status ?? ok('');
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    const expected = { branch: 'se/x', commonGitDir: '/repo/.git' };
    const gate = (
      overrides: Record<string, { status: number | null; stdout: string; stderr: string }>,
      requested = true,
      want: WorktreeReuseExpectation = expected,
      currentOwner?: string,
    ) => {
      const result = gateWorktreeReuse('/wt', requested, want, runner(overrides), currentOwner);
      return result.reuse ? 'allowed' : result.reason;
    };

    expect(gate({})).toBe('allowed');
    expect(gate({}, false)).toBe('reuse-not-requested');
    expect(gate({ revParse: { status: 128, stdout: '', stderr: 'not a git repository' } })).toBe('worktree-unavailable');
    expect(gate({ commonDir: { status: 128, stdout: '', stderr: 'broken' } })).toBe('worktree-unavailable');
    // ⛔ 후보 경로가 «다른 저장소»의 체크아웃으로 대체된 경우 — 소유·청결이 아무리 좋아도 거부다
    expect(gate({ commonDir: ok('/other-repo/.git\n') })).toBe('repo-mismatch');
    expect(gate({}, true, { branch: 'se/x', commonGitDir: null })).toBe('repo-mismatch');
    // ⛔ 그 트리가 «다른 브랜치»를 쥐고 있거나 detach 면 거부다 — 안 그러면 남의 브랜치에 커밋한다
    expect(gate({ head: ok('refs/heads/se/other\n') })).toBe('branch-mismatch');
    expect(gate({ head: { status: 1, stdout: '', stderr: '' } })).toBe('branch-mismatch');
    expect(gate({ extension: { status: 1, stdout: '', stderr: '' } })).toBe('owner-not-recorded');
    expect(gate({ owner: { status: 1, stdout: '', stderr: '' } })).toBe('owner-not-recorded');
    expect(gate({ owner: { status: 4, stdout: '', stderr: 'permission denied' } })).toBe('owner-unreadable');
    expect(gate({ createdAt: ok('not-a-timestamp\n') })).toBe('owner-foreign');
    expect(gate({ status: { status: 128, stdout: '', stderr: 'broken' } })).toBe('dirty-unknown');
    expect(gate({ status: ok(' M f.txt\n') })).toBe('worktree-dirty');
    expect(gate({ status: ok(' M f.txt\n') }, true, expected, 'dev:run-1')).toBe('allowed');
    expect(gate({ status: ok(' M f.txt\n') }, true, expected, 'dev:run-other')).toBe('worktree-dirty');
    expect(gate({ status: ok(' M f.txt\n') }, true, expected, undefined)).toBe('worktree-dirty');
    expect(gate({ status: ok(' M f.txt\n') }, true, expected, '')).toBe('worktree-dirty');
    expect(gate({ status: { status: 128, stdout: '', stderr: 'broken' } }, true, expected, 'dev:run-1')).toBe('dirty-unknown');
    // ⭐ 상대 경로로 나오는 `--git-common-dir` 도 절대화해 «같은 것»으로 읽는다(오탐 금지)
    expect(gateWorktreeReuse('/repo/wt', true, { branch: 'se/x', commonGitDir: '/repo/.git' }, runner({ commonDir: ok('../.git\n') })).reuse).toBe(true);
  });

  // ⛔⭐ 무인 리뷰 must-fix(#8257) — 후보 경로는 `git worktree list` 라는 **별개 호출의 스냅숏**이다.
  //    등록이 낡아 그 자리에 «다른» 체크아웃이 들어앉으면(그리고 그것이 마침 소유 표시를 갖고
  //    깨끗하면) 소유·청결만 묻는 게이트는 통과시키고 호출자는 «남의 트리»에 커밋한다.
  //    ⇒ 실 git 으로 그 대체를 만들어 거부를 고정한다.
  test('등록이 낡아 다른 저장소가 그 자리에 들어앉으면 — 소유·청결해도 repo-mismatch 로 거부한다', () => {
    const held = mkHolder('se/reuse-swapped');
    stamp(held.path);
    expect(reuse('se/reuse-swapped').reused).toBe(true);   // 전제: 대체 «전»에는 재사용된다

    // 그 경로를 «다른 저장소»로 갈아끼운다(git 등록은 prune 하지 않아 그대로 남는다).
    rmSync(held.path, { recursive: true, force: true });
    mkdirSync(held.path, { recursive: true });
    git(held.path, 'init', '-q', '-b', 'se/reuse-swapped', held.path);
    git(held.path, 'config', 'user.email', 't@t.t');
    git(held.path, 'config', 'user.name', 't');
    writeFileSync(join(held.path, 'imposter.txt'), 'not this repo');
    git(held.path, 'add', '.');
    git(held.path, 'commit', '-qm', 'imposter');
    stamp(held.path);                                       // 소유 표시까지 «갖춰도» 소용없어야 한다
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: held.path, encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout)
      .toContain('branch refs/heads/se/reuse-swapped');      // 전제: 등록은 아직 그 브랜치를 가리킨다

    let message = '';
    try { reuse('se/reuse-swapped'); } catch (error) { message = String((error as Error).message); }
    expect(message).toContain('reuse refused: repo-mismatch');
  });
});
