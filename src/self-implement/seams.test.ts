// self-implement seam — worktreeHasChanges(버그A·self-commit 감지) + featurePrompt(버그B·PR 금지).
import { setDefaultTimeout, test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { worktreeHasChanges, preservationHasChanges, changedFiles, commitTitles, commitWorktree, unstageElanousRuntimeArtifacts, featurePrompt, defaultSeams, changedFileTypecheck, mergeBaseDiagnostics, gateChangedFiles, gateWorktreeBehindMain, resolveBootFailureReason, toReviewIntentInput, worktreeDiff, reviewScopeDiff, REVIEW_SCOPE_UNMEASURABLE, type DefaultSeamsOptions } from './seams.js';
import type { PrManager } from '../autopilot/pr-manager.js';
import type { SelfImplementSeams } from './orchestrator.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { runIntegrityGate, type GateResult, type GateStepName } from '../autopilot/build/integrity-gate.js';
import { stageFile } from './shadow-stage.js';
import { dropStaleReverts } from './revert-guard.js';
import { createSelfImplementControlBrain, launchDevGoalFileDetached, SELF_IMPLEMENT_COMPLETION_REPORT_HINT } from './seams.js';
import { assertBaseBranchOnOrigin } from './seams.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../git-fs/worktree.js';
import { configuredWorktreeRoot } from '../user-config.js';
import { setGitCommandRunnerForTesting } from '../git-fs/runner.js';
import { createLlmControlBrain } from '../autopilot/llm-control-brain.js';
import { HARNESS_BOUNDARY_REQUESTS_ENV, HARNESS_BOUNDARY_RESPONSES_ENV } from '../harness/harness-space.js';
import { supervisorGoalDigest } from './goal-digest.js';
import { stableMustFixId } from './reflect-mustfix.js';
import { SUPERVISION_REWORK_SOURCES } from './supervision-vocabulary.js';
import { getAskUserQuestionResolver, setAskUserQuestionResolver } from '../ask-user-question/tool.js';

function git(cwd: string, ...argv: string[]) {
  return spawnSync('git', argv, { cwd, encoding: 'utf8' });
}

describe('launchDevGoalFileDetached', () => {
  type SpawnObservation = {
    args: string[];
    options: { detached?: boolean; stdio?: string };
    unrefCalls: number;
  };

  function fakeSpawn(received: SpawnObservation[]): typeof import('node:child_process').spawn {
    return ((_command: string, args: string[], options: SpawnObservation['options']) => {
      const observation: SpawnObservation = { args, options, unrefCalls: 0 };
      received.push(observation);
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => { observation.unrefCalls += 1; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
  }

  test('target을 --base 바로 뒤의 인접 argv 두 칸으로 전달한다', async () => {
    const received: SpawnObservation[] = [];
    await launchDevGoalFileDetached({ goalFile: 'g.md', base: 'main', target: '/tmp/x' }, fakeSpawn(received));
    expect(received.map(({ args }) => args)).toEqual([[ELANOUS_ENTRY_SCRIPT, 'dev', '--file', 'g.md', '--base', 'main', '--target', '/tmp/x']]);   // 절대 경로(사용자 프로젝트 cwd 에서도)
  });

  function expectDetachedLaunch(observation: SpawnObservation, args: string[]): void {
    expect(observation.args).toEqual(args);
    expect(observation.options.detached).toBe(true);
    expect(observation.options.stdio).toBe('ignore');
    expect(observation.unrefCalls).toBe(1);
  }

  test('captured correlation argv를 dev CLI가 받고 없는 파일까지 진행하며 detached spawn 계약을 보존한다', async () => {
    const received: SpawnObservation[] = [];
    await launchDevGoalFileDetached({ goalFile: 'tmp/nonexistent-zzz.md', base: 'main', correlation: 'request-zzz' }, fakeSpawn(received));
    expect(received).toHaveLength(1);
    const argv = received[0]!.args;
    expectDetachedLaunch(received[0]!, [ELANOUS_ENTRY_SCRIPT, 'dev', '--file', 'tmp/nonexistent-zzz.md', '--base', 'main', '--correlation', 'request-zzz']);

    const result = spawnSync(process.execPath, [argv[0]!, '--test', ...argv.slice(1)], {
      cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8', timeout: 30_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).not.toContain("unknown option '--correlation'");
    expect(output).toContain('ENOENT: no such file');
  });
});

describe('worktreeHasChanges — 버그A(self-commit false-negative)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-git-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  test('클린 repo(HEAD=main) → false', () => {
    expect(worktreeHasChanges(repo)).toBe(false);
  });

  test('untracked 파일 → true(porcelain)', () => {
    writeFileSync(join(repo, 'src.ts'), 'x');
    expect(worktreeHasChanges(repo)).toBe(true);
  });

  test('★ 브랜치에 self-commit(워킹트리 clean) → true (버그A 회귀)', () => {
    git(repo, 'checkout', '-b', 'dev/x');
    writeFileSync(join(repo, 'math.ts'), 'export const clamp=1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'feat: clamp');
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');
    expect(worktreeHasChanges(repo)).toBe(true);
  });

  test('변경 없이 브랜치만 파생 → false', () => {
    git(repo, 'checkout', '-b', 'dev/empty');
    expect(worktreeHasChanges(repo)).toBe(false);
  });

  // 2026-09-24: 오케스트레이터가 복사한 골 문서가 «자식의 변경»으로 세어져 빈 런이 ok:true 로 리뷰까지 갔다.
  test('하니스가 깐 경로(골 문서)만 있으면 제외 인자로 false · 다른 파일이 하나라도 있으면 true', () => {
    mkdirSync(join(repo, 'seeded'), { recursive: true });
    writeFileSync(join(repo, 'seeded', 'GOAL-x.md'), '# goal\n');
    expect(worktreeHasChanges(repo)).toBe(true);
    expect(worktreeHasChanges(repo, ['seeded/GOAL-x.md'])).toBe(false);
    writeFileSync(join(repo, 'impl.ts'), 'export const done = true;\n');
    expect(worktreeHasChanges(repo, ['seeded/GOAL-x.md'])).toBe(true);
  });

  test('하니스가 깐 경로를 커밋한 브랜치도 제외 인자로 false(커밋 diff 검사도 뺀다)', () => {
    git(repo, 'checkout', '-b', 'dev/seeded');
    mkdirSync(join(repo, 'seeded'), { recursive: true });
    writeFileSync(join(repo, 'seeded', 'GOAL-x.md'), '# goal\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'goal doc only');
    expect(worktreeHasChanges(repo)).toBe(true);
    expect(worktreeHasChanges(repo, ['seeded/GOAL-x.md'])).toBe(false);
  });

  test('main 전진분만 동기화한 clean branch는 일반 변경이지만 보존 산출물은 아니다', () => {
    git(repo, 'checkout', '-b', 'dev/post-sync');
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'main-only.ts'), 'export const upstream = true;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main advances');
    git(repo, 'checkout', 'dev/post-sync');
    git(repo, 'merge', '--no-edit', 'main');
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');
    expect(preservationHasChanges(repo, 'main')).toBe(false);
  });
});

describe('git call observation', () => {
  let repo: string;
  let worktree: string;
  let separateGitDir: string;
  let separateRepo: string;
  let submoduleSource: string;
  let submodule: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-git-observation-'));
    worktree = join(repo, 'linked-worktree');
    separateGitDir = join(repo, 'separate.git');
    separateRepo = join(repo, 'separate-repo');
    submoduleSource = join(repo, 'submodule-source');
    submodule = join(repo, 'submodule');
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'worktree', 'add', '-b', 'feature/observed', worktree);

    mkdirSync(separateRepo);
    git(separateRepo, 'init', '--separate-git-dir', separateGitDir, '-b', 'main');
    git(separateRepo, 'config', 'user.email', 't@t.co');
    git(separateRepo, 'config', 'user.name', 'T');
    writeFileSync(join(separateRepo, 'README.md'), '# separate\n');
    git(separateRepo, 'add', '-A');
    git(separateRepo, 'commit', '-m', 'init');

    mkdirSync(submoduleSource);
    git(submoduleSource, 'init', '-b', 'main');
    git(submoduleSource, 'config', 'user.email', 't@t.co');
    git(submoduleSource, 'config', 'user.name', 'T');
    writeFileSync(join(submoduleSource, 'README.md'), '# submodule\n');
    git(submoduleSource, 'add', '-A');
    git(submoduleSource, 'commit', '-m', 'init');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'submodule');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  test('main checkout과 linked worktree의 git 호출에 root·branch·worktree·subcommand·success만 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      changedFiles(repo);
      expect(worktreeHasChanges(worktree)).toBe(false);
      expect(log).toHaveBeenCalledWith('self-implement.git', 'call', expect.objectContaining({
        repositoryRoot: realpathSync(repo),
        branch: 'main',
        isWorktree: false,
        subcommand: 'status',
        ok: true,
      }));
      expect(log).toHaveBeenCalledWith('self-implement.git', 'call', expect.objectContaining({
        repositoryRoot: realpathSync(worktree),
        branch: 'feature/observed',
        isWorktree: true,
        subcommand: 'status',
        ok: true,
      }));
      for (const call of log.mock.calls.filter((call) => call[1] === 'call')) {
        const data = call[2] as Record<string, unknown>;
        expect(data).not.toHaveProperty('argv');
        expect(data).not.toHaveProperty('out');
        expect(data).not.toHaveProperty('output');
      }
    } finally {
      log.mockRestore();
    }
  });

  test('linked worktree만 true이고 --separate-git-dir 주 저장소와 submodule은 .git 파일이어도 false를 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(git(separateRepo, 'rev-parse', '--git-dir').stdout.trim()).not.toBe('.git');
      expect(git(submodule, 'rev-parse', '--git-dir').stdout.trim()).not.toBe('.git');
      changedFiles(worktree);
      changedFiles(separateRepo);
      changedFiles(submodule);
      const observations = log.mock.calls
        .filter(([category, event]) => category === 'self-implement.git' && event === 'call')
        .map(([, , data]) => data as Record<string, unknown>);
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ repositoryRoot: realpathSync(worktree), isWorktree: true }),
        expect.objectContaining({ repositoryRoot: realpathSync(separateRepo), isWorktree: false }),
        expect.objectContaining({ repositoryRoot: realpathSync(submodule), isWorktree: false }),
      ]));
    } finally {
      log.mockRestore();
    }
  });

  // ⛔⭐⭐ **런 사실 수집은 fail-soft 여야 한다** — 이 값들은 PR 본문의 「관측과 잇는 좌표」일 뿐이고,
  //   못 걷었다고 PR 개설을 막거나 런을 죽이면 «부수적인 것이 본체를 죽인다».
  //   ⚠️ 리뷰가 *"구현상 보호되지만 직접적인 회귀 테스트는 없다"* 고 짚은 자리다 —
  //     보호되는 것과 «보호된다고 잰 것»은 다르다.
  test('런 사실 수집은 git 저장소가 아니어도 던지지 않고 빈 목록으로 떨어진다', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'run-facts-not-a-repo-'));
    try {
      expect(() => commitTitles(notARepo)).not.toThrow();
      expect(commitTitles(notARepo)).toEqual([]);
      expect(() => changedFiles(notARepo)).not.toThrow();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  test('같은 cwd에서 checkout 뒤 다음 git 호출은 그때의 새 브랜치를 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      changedFiles(repo);
      const beforeCheckout = log.mock.calls.length;
      git(repo, 'checkout', '-b', 'feature/after-observation');
      changedFiles(repo);
      const afterCheckout = log.mock.calls.slice(beforeCheckout);
      expect(afterCheckout).toContainEqual([
        'self-implement.git',
        'call',
        expect.objectContaining({
          repositoryRoot: realpathSync(repo),
          branch: 'feature/after-observation',
          isWorktree: false,
          subcommand: 'status',
          ok: true,
        }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  // ⛔ 교차 세션 리뷰 must-fix — detached HEAD 와 git 실패가 둘 다 branch:null 이면,
  //    이 트랙이 잡으려는 사고("자동 교정이 사람 트리를 detach 한다")의 서명이 지워진다.
  test('detached HEAD 와 판정 불가가 다른 값으로 남는다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      changedFiles(repo);                       // 브랜치 위
      git(repo, 'checkout', '--detach');
      changedFiles(repo);                       // detached
      const states = log.mock.calls
        .filter((c) => c[0] === 'self-implement.git' && c[1] === 'call')
        .map((c) => (c[2] as { branch: string | null; branchState: string }));
      expect(states.some((s) => s.branchState === 'named' && s.branch === 'main')).toBe(true);
      expect(states.some((s) => s.branchState === 'detached' && s.branch === null)).toBe(true);
      // ⭐ 두 상태가 같은 값으로 접히지 않는다 — branch 는 둘 다 null 일 수 있어도 state 가 다르다.
      expect(new Set(states.map((s) => s.branchState)).size).toBeGreaterThan(1);
      // ⛔ 무인 리뷰 should-fix — unknown 도 실제로 만들어 단언한다(비-git 디렉토리).
      const nonRepo = mkdtempSync(join(tmpdir(), 'seam-not-a-repo-'));
      try {
        changedFiles(nonRepo);
        const unknowns = log.mock.calls
          .filter((c) => c[0] === 'self-implement.git' && c[1] === 'call')
          .map((c) => c[2] as { branchState: string; repositoryRoot: string | null })
          .filter((s) => s.branchState === 'unknown');
        expect(unknowns.length).toBeGreaterThan(0);
        expect(unknowns.some((u) => u.repositoryRoot === null)).toBe(true);
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    } finally {
      log.mockRestore();
    }
  });

  // ⛔ 무인 리뷰 should-fix — ok 가 상수 true 로 퇴행해도 위 검사들은 통과한다.
  test('실패한 git 호출은 ok:false 로 남는다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      // origin/main ref 가 없는 저장소라 rev-list 호출이 실패한다(판정이 아니라 호출 실패를 만든다).
      gateWorktreeBehindMain(repo);
      const okValues = log.mock.calls
        .filter((c) => c[0] === 'self-implement.git' && c[1] === 'call')
        .map((c) => (c[2] as { ok: boolean }).ok);
      expect(okValues).toContain(false);
    } finally {
      log.mockRestore();
    }
  });

  // ⛔ 무인 리뷰 must-fix 2회 — ⑴ 키 이름만 보면 Goodhart 다 ⑵ 값이 **관측 대상 러너의 argv 로**
  //    흘러야 유출 회귀를 잡는다. commitWorktree 는 git(cwd, ['commit','-m',<메시지>]) 를 부르므로
  //    메시지가 argv 두 번째 값 자리에 실린다 — 종전 argv.slice(0,2) 였다면 그대로 새어 나온다.
  test('관측 대상 러너의 argv 값이 관측에 실리지 않는다', () => {
    writeFileSync(join(repo, 'payload.ts'), 'export const x = 1;\n');
    const secret = 'SECRET-PAYLOAD-do-not-log';
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const r = commitWorktree(repo, secret);
      expect(r.ok).toBe(true);
      const records = log.mock.calls
        .filter((c) => c[0] === 'self-implement.git' && c[1] === 'call')
        .map((c) => c[2] as Record<string, unknown>);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some((rec) => rec.subcommand === 'commit')).toBe(true);
      for (const rec of records) {
        expect(typeof rec.subcommand).toBe('string');
        expect(JSON.stringify(rec)).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
    }
  });
});

// ★ JDG-T2 회귀 — 리뷰어가 받는 것이 "PR diff" 인가 "워크트리 diff" 인가. 실측(`run-e252c392`/`#6138`)에서
//   인수 발사 런의 리뷰가 이미 커밋된 1차 산출을 못 봐 *"핵심 wiring 이 없다"* 로 죽었다.
describe('reviewScopeDiff — 이미 커밋된 산출도 리뷰 범위에 든다 (실제 Git)', () => {
  let box: string;
  let work: string;
  let noOrigin: string;

  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), 'seam-review-scope-'));
    const origin = join(box, 'origin.git');
    work = join(box, 'work');
    noOrigin = join(box, 'no-origin');

    git(box, 'init', '--bare', origin);
    const seed = join(box, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-b', 'main');
    git(seed, 'config', 'user.email', 't@t.co');
    git(seed, 'config', 'user.name', 'T');
    writeFileSync(join(seed, 'README.md'), 'base\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'base');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-u', 'origin', 'main');

    git(box, 'clone', '-b', 'main', origin, work);
    git(work, 'config', 'user.email', 't@t.co');
    git(work, 'config', 'user.name', 'T');

    mkdirSync(noOrigin);
    git(noOrigin, 'init', '-b', 'main');
    git(noOrigin, 'config', 'user.email', 't@t.co');
    git(noOrigin, 'config', 'user.name', 'T');
    writeFileSync(join(noOrigin, 'README.md'), 'local only\n');
    git(noOrigin, 'add', 'README.md');
    git(noOrigin, 'commit', '-m', 'local only');
  });
  afterEach(() => { rmSync(box, { recursive: true, force: true }); });

  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('직전 런이 커밋해 둔 산출 ⊕ 이번 런의 미커밋 변경을 한 diff 로 담는다', async () => {
    // ① 직전 런이 죽으며 preserveBlockedArtifacts 가 산출을 커밋해 둔 상태
    writeFileSync(join(work, 'wiring.ts'), 'export const wiring = 1;\n');
    git(work, 'add', 'wiring.ts');
    git(work, 'commit', '-m', 'preserved by the previous run');
    // ② 인수 발사한 이번 런이 얹은 미커밋 변경
    writeFileSync(join(work, 'followup.ts'), 'export const followup = 2;\n');

    const legacy = await worktreeDiff(work);
    const scoped = await reviewScopeDiff(work);

    // ⛔ 종전 구현이 리뷰어에게 준 것 — 이번 라운드분만 보인다(이것이 결함이었다)
    expect(legacy).toContain('followup.ts');
    expect(legacy).not.toContain('wiring.ts');
    // ✅ 수리 — PR 이 main 에 담을 전부가 보인다
    expect(scoped).toContain('followup.ts');
    expect(scoped).toContain('wiring.ts');
  });

  // ⛔ 위 테스트는 서로 다른 파일이라 "두 diff 를 이어 붙인" 구현으로도 통과한다. 같은 파일을 커밋 후
  //    다시 고쳐 **file patch 가 하나만** 나오는 것을 고정한다(이어붙이기면 헤더가 두 번 나온다 ⇒
  //    splitDiffByFile 예산 분할이 같은 파일을 두 조각으로 세게 된다).
  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('같은 파일이 커밋·미커밋 양쪽에서 바뀌어도 file patch 는 하나다', async () => {
    writeFileSync(join(work, 'shared.ts'), 'export const a = 1;\n');
    git(work, 'add', 'shared.ts');
    git(work, 'commit', '-m', 'preserved by the previous run');
    writeFileSync(join(work, 'shared.ts'), 'export const a = 1;\nexport const b = 2;\n');

    const scoped = await reviewScopeDiff(work);
    const headers = scoped.match(/^diff --git a\/shared\.ts b\/shared\.ts$/gm) ?? [];

    expect(headers).toHaveLength(1);
    expect(scoped).toContain('export const a = 1;');   // 커밋분
    expect(scoped).toContain('export const b = 2;');   // 미커밋분
  });

  // ⭐ 수용기준 6 — 관측이 남는 것만이 아니라 **그 수가 참인가**. committedChars 를 뺄셈으로 구하면
  //    같은 파일이 양쪽에서 바뀔 때 거짓이 되므로(1R must-fix) 실제 diff 길이와 대조해 고정한다.
  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('review.diff-scope 관측의 세 수가 실제 diff 길이와 일치한다', async () => {
    writeFileSync(join(work, 'shared.ts'), 'export const a = 1;\n');
    git(work, 'add', 'shared.ts');
    git(work, 'commit', '-m', 'preserved by the previous run');
    writeFileSync(join(work, 'shared.ts'), 'export const a = 1;\nexport const b = 2;\n');

    const events: Array<Record<string, unknown>> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => {
      if (event === 'review.diff-scope') events.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    let scoped: string;
    try {
      scoped = await reviewScopeDiff(work, 'origin/main', undefined, 'resolved-base');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const mergeBase = git(work, 'merge-base', 'origin/main', 'HEAD').stdout.trim();
    const committedOnly = git(work, 'diff', '--no-color', mergeBase, 'HEAD').stdout;
    const uncommittedOnly = git(work, 'diff', '--no-color').stdout;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scope: 'pr', prBase: 'origin/main', baseOrigin: 'resolved-base' });
    expect(events[0]!.chars).toBe(scoped.length);
    expect(events[0]!.committedChars).toBe(committedOnly.length);
    expect(events[0]!.uncommittedChars).toBe(uncommittedOnly.length);
    // ⛔ 뺄셈으로 구했다면 이것이 성립하지 않는다(같은 파일이라 헤더가 한 번만 나온다).
    expect(events[0]!.committedChars).not.toBe(scoped.length - uncommittedOnly.length);
  });

  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('원격이 없어도 로컬 기본 브랜치에서 갈라진 커밋 변경을 리뷰 diff 에 담는다', async () => {
    git(noOrigin, 'checkout', '-b', 'dev/child');
    writeFileSync(join(noOrigin, 'committed.txt'), 'committed change\n');
    git(noOrigin, 'add', 'committed.txt');
    git(noOrigin, 'commit', '-m', 'child commit');
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review.diff-scope') events.push(data ?? {});
    }) as never);
    try {
      const scoped = await reviewScopeDiff(noOrigin, 'origin/main', 'run-local-default', 'resolved-base');
      expect(scoped).toContain('committed.txt');
      expect(scoped).toContain('committed change');
      expect(scoped).not.toBe(REVIEW_SCOPE_UNMEASURABLE);
    } finally {
      log.mockRestore();
    }
    expect(events).toEqual([expect.objectContaining({
      scope: 'pr', prBase: 'main', baseOrigin: 'resolved-base', scopeBase: 'local-default', runId: 'run-local-default',
    })]);
  });

  // 🩸 2026-09-23(#20027 직후 회귀): 기준이 없어도 «볼 변경»이 있으면 그것을 리뷰해야 한다 — 비었을 때만 «못 쟀다».
  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('기준을 못 구해도 미커밋 변경이 있으면 그 diff 를 준다 — 측정 불가가 아니다', async () => {
    git(noOrigin, 'checkout', '--orphan', 'orphan-dirty');
    writeFileSync(join(noOrigin, 'root.txt'), 'root\n');
    git(noOrigin, 'add', 'root.txt');
    git(noOrigin, 'commit', '-m', 'orphan root');
    writeFileSync(join(noOrigin, 'root.txt'), 'root\nedited\n');
    const scoped = await reviewScopeDiff(noOrigin, 'origin/main', 'run-uncommitted-only', 'resolved-base');
    expect(scoped).not.toBe(REVIEW_SCOPE_UNMEASURABLE);
    expect(scoped).toContain('edited');
  });

  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('어느 기준으로도 merge-base 를 못 구하면 미커밋 diff 가 아니라 측정 불가를 낸다', async () => {
    writeFileSync(join(noOrigin, 'local-change.txt'), 'changed\n');
    git(noOrigin, 'checkout', '--orphan', 'orphan');
    git(noOrigin, 'add', 'local-change.txt');
    git(noOrigin, 'commit', '-m', 'orphan root');
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review.diff-scope') events.push(data ?? {});
    }) as never);
    try {
      const scoped = await reviewScopeDiff(noOrigin, 'origin/main', 'run-no-merge-base', 'resolved-base');
      expect(scoped).toBe(REVIEW_SCOPE_UNMEASURABLE);
      expect(scoped).not.toContain('local-change.txt');
    } finally {
      log.mockRestore();
    }
    expect(events).toEqual([expect.objectContaining({
      scope: 'worktree', reason: 'no-merge-base', prBase: 'origin/main', baseOrigin: 'resolved-base', scopeBase: 'unmeasurable', runId: 'run-no-merge-base',
    })]);
  });

  // Fake bin: git; invoked command: git (execFile/spawnSync); the fake forwards all but the full diff to real git.
  test('full diff가 실패하면 실제 seam 관측에 전달된 baseOrigin과 함께 종전 동작으로 폴백한다', async () => {
    writeFileSync(join(work, 'committed.ts'), 'export const committed = true;\n');
    git(work, 'add', 'committed.ts');
    git(work, 'commit', '-m', 'committed change');
    writeFileSync(join(work, 'local-change.ts'), 'export const local = true;\n');
    const bin = join(box, 'bin');
    mkdirSync(bin);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    // Fail the full diff by its argv, not by a call count that changes when Git observation runs first.
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = diff ] && [ "$2" = --no-color ] && [ "$#" -eq 3 ]; then exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review.diff-scope') events.push(data ?? {});
    }) as never);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      const scoped = await reviewScopeDiff(work, 'origin/main', 'run-diff-failed', 'resolved-base');
      expect(scoped).toContain('local-change.ts');
      expect(scoped).not.toContain('committed.ts');
    } finally {
      process.env.PATH = previousPath;
      log.mockRestore();
    }
    expect(events).toEqual([expect.objectContaining({
      scope: 'worktree', reason: 'diff-failed', prBase: 'origin/main', baseOrigin: 'resolved-base', runId: 'run-diff-failed',
    })]);
  });
});

describe('gateWorktreeBehindMain — 실제 Git rev-list 통합 경로', () => {
  let box: string;
  let origin: string;
  let worktree: string;
  let upstream: string;
  let aheadOnly: string;
  let noOrigin: string;
  let nonRepository: string;

  function commit(cwd: string, file: string, message: string) {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-m', message);
  }

  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), 'seam-behind-main-'));
    origin = join(box, 'origin.git');
    worktree = join(box, 'worktree');
    upstream = join(box, 'upstream');
    aheadOnly = join(box, 'ahead-only');
    noOrigin = join(box, 'no-origin');
    nonRepository = join(box, 'not-a-repository');

    git(box, 'init', '--bare', origin);
    const seed = join(box, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-b', 'main');
    git(seed, 'config', 'user.email', 't@t.co');
    git(seed, 'config', 'user.name', 'T');
    commit(seed, 'README.md', 'base');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-u', 'origin', 'main');

    for (const path of [worktree, upstream, aheadOnly]) {
      git(box, 'clone', '-b', 'main', origin, path);
      git(path, 'config', 'user.email', 't@t.co');
      git(path, 'config', 'user.name', 'T');
    }
    mkdirSync(noOrigin);
    git(noOrigin, 'init', '-b', 'main');
    git(noOrigin, 'config', 'user.email', 't@t.co');
    git(noOrigin, 'config', 'user.name', 'T');
    commit(noOrigin, 'README.md', 'local only');
    mkdirSync(nonRepository);
  });
  afterEach(() => { rmSync(box, { recursive: true, force: true }); });

  test('0·N·앞섬과 origin/main/ref·repository 부재를 실제 git rev-list로 구분한다', () => {
    expect(gateWorktreeBehindMain(worktree)).toBe(0);

    commit(upstream, 'upstream-1.txt', 'upstream 1');
    commit(upstream, 'upstream-2.txt', 'upstream 2');
    git(upstream, 'push', 'origin', 'main');
    git(worktree, 'fetch', 'origin', 'main');
    expect(gateWorktreeBehindMain(worktree)).toBe(2);

    git(aheadOnly, 'fetch', 'origin', 'main');
    git(aheadOnly, 'merge', '--ff-only', 'origin/main');
    commit(aheadOnly, 'ahead.txt', 'ahead only');
    expect(gateWorktreeBehindMain(aheadOnly)).toBe(0);

    expect(gateWorktreeBehindMain(noOrigin)).toBeUndefined();
    expect(gateWorktreeBehindMain(nonRepository)).toBeUndefined();
  });
});

describe('pre-commit deletion guard — real git staging', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-stale-delete-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'outside-old.md'), 'old\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('새 main 파일의 대상 밖 staged 삭제도 복원해 D를 커밋하지 않는다', () => {
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(repo, 'outside-new.md'), 'landed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main landing');
    rmSync(join(repo, 'outside-new.md'));
    git(repo, 'add', '-A');
    writeFileSync(join(repo, 'feature.md'), 'feature\n');
    expect(dropStaleReverts(repo, ['feature.md'], 'run-seams-new', 50, base).staleDeleted).toEqual(['outside-new.md']);
    expect(commitWorktree(repo, 'feature').ok).toBe(true);
    expect(git(repo, 'show', '--format=', '--name-status', 'HEAD').stdout.trim()).toBe('A\tfeature.md');
    expect(readFileSync(join(repo, 'outside-new.md'), 'utf8')).toBe('landed\n');
  });

  test('대상 안 삭제는 D, base에 있던 대상 밖 삭제는 경고 및 D로 보존한다', () => {
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(repo, 'inside.md'), 'inside\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'inside landing');
    rmSync(join(repo, 'inside.md'));
    rmSync(join(repo, 'outside-old.md'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = dropStaleReverts(repo, ['inside.md'], 'run-seams-old', 50, base);
      expect(result).toMatchObject({ reverted: [], outsideDeleted: ['outside-old.md'] });
      expect(log).toHaveBeenCalledWith('self-implement.revert-guard', 'outside-delete', { runId: 'run-seams-old', files: ['outside-old.md'] }, { level: 'warn' });
      expect(commitWorktree(repo, 'intentional deletion').ok).toBe(true);
      expect(git(repo, 'show', '--format=', '--name-status', 'HEAD').stdout.trim()).toBe('D\tinside.md\nD\toutside-old.md');
    } finally { log.mockRestore(); }
  });
});

describe('changedFiles / commitWorktree — 버그A(harness execute changes:[] · 빈 브랜치)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-cf-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'checkout', '-b', 'dev/x');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  test('클린 → 빈 목록', () => {
    expect(changedFiles(repo)).toEqual([]);
  });

  test('★ 사후 조건 — «새로 스테이징된» elanous 런타임 산출물만 다시 내린다', () => {
    // ⛔ 사전 제외만으로는 못 막는다 — `.elanous-child-liveness.hb` 는 ***5초마다*** 쓰이므로
    //    `ls-files` 와 `add -A` «사이»에 생기면 그대로 담힌다.
    //    📏 2026-09-21: 그 경합 때문에 #19300·#19302 를 넣고도 빈 저장소 PR 에 또 들어갔다.
    writeFileSync(join(repo, 'user.ts'), 'export const u=1;\n');
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), '{"at":1}');
    mkdirSync(join(repo, '.elanous-se'), { recursive: true });
    writeFileSync(join(repo, '.elanous-se', 's.json'), 'y');
    git(repo, 'add', '-A');   // ← 경합이 «진» 상태를 그대로 재현한다

    expect(unstageElanousRuntimeArtifacts(repo).sort()).toEqual(['.elanous-child-liveness.hb', '.elanous-se/s.json']);
    expect(git(repo, 'diff', '--cached', '--name-only').stdout.trim().split('\n')).toEqual(['user.ts']);
  });

  test('★ 이미 추적 중이던 런타임 경로는 내리지 않는다 — 사람이 «일부러» 추적했을 수 있다', () => {
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), '{"at":1}');
    git(repo, 'add', '.elanous-child-liveness.hb');
    git(repo, 'commit', '-m', 'tracked on purpose');
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), '{"at":2}');
    git(repo, 'add', '-A');

    expect(unstageElanousRuntimeArtifacts(repo)).toEqual([]);   // --diff-filter=A 가 «새 파일»만 문다
    expect(git(repo, 'diff', '--cached', '--name-only').stdout.trim()).toBe('.elanous-child-liveness.hb');
  });

  test('★ untracked 신규파일 감지 (execute changes:[] 버그의 핵심)', () => {
    writeFileSync(join(repo, 'src.ts'), 'export const x=1;\n');
    writeFileSync(join(repo, 'src.test.ts'), 'test\n');
    expect(changedFiles(repo).sort()).toEqual(['src.test.ts', 'src.ts']);
  });

  test('비코드 산출물만 있으면 빈 목록 — deploy가 non-code 분기를 선택한다', () => {
    mkdirSync(join(repo, '.elanous-skill-artifacts', 'step-1'), { recursive: true });
    writeFileSync(join(repo, '.elanous-skill-artifacts', 'step-1', 'report.md'), '# published\n');
    expect(changedFiles(repo)).toEqual([]);
  });

  test('비코드 산출물과 소스 변경이 함께 있으면 소스만 센다', () => {
    mkdirSync(join(repo, '.elanous-skill-artifacts', 'step-1'), { recursive: true });
    writeFileSync(join(repo, '.elanous-skill-artifacts', 'step-1', 'report.md'), '# published\n');
    writeFileSync(join(repo, 'feature.ts'), 'export const published = true;\n');
    expect(changedFiles(repo)).toEqual(['feature.ts']);
  });

  test('commitWorktree → untracked 를 브랜치에 커밋(빈 브랜치 방지) → 워킹트리 clean', () => {
    writeFileSync(join(repo, 'feature.ts'), 'export const y=2;\n');
    const r = commitWorktree(repo, 'feat: feature');
    expect(r.ok).toBe(true);
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe(''); // 커밋됨
    // 커밋 후엔 fork(main) 대비 diff 로 여전히 변경목록에 잡힌다(브랜치가 실체를 가짐).
    expect(changedFiles(repo)).toContain('feature.ts');
  });

  test('commitWorktree — 변경 없으면 무해(nothing to commit)', () => {
    const r = commitWorktree(repo, 'noop');
    expect(r.ok).toBe(false); // 커밋할 것 없음 — 경고 없이 무해 통과
    expect(changedFiles(repo)).toEqual([]);
  });

  test('미추적 elanous 런타임 산출물은 제외하고 사용자 파일은 모두 커밋한다', () => {
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), 'alive\n');
    mkdirSync(join(repo, '.elanous', 'runtime'), { recursive: true });
    writeFileSync(join(repo, '.elanous', 'runtime', 'state.json'), '{}\n');
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
    writeFileSync(join(repo, 'README.md'), '# updated\n');

    const result = commitWorktree(repo, 'feat: user changes');
    const committed = git(repo, 'show', '--format=', '--name-only', 'HEAD').stdout.trim().split('\n').filter(Boolean);

    expect(result.ok).toBe(true);
    expect(committed.sort()).toEqual(['README.md', 'feature.ts']);
    expect(git(repo, 'status', '--porcelain').stdout.trim().split('\n').sort()).toEqual([
      '?? .elanous-child-liveness.hb',
      '?? .elanous/',
    ]);
  });

  test('한글 경로를 가진 미추적 elanous 런타임 산출물은 커밋하지 않는다', () => {
    mkdirSync(join(repo, '.elanous', 'runtime'), { recursive: true });
    writeFileSync(join(repo, '.elanous', 'runtime', '한글.json'), '{}\n');
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');

    const result = commitWorktree(repo, 'feat: exclude unicode runtime artifact');
    const committed = git(repo, 'show', '--format=', '--name-only', 'HEAD').stdout.trim().split('\n').filter(Boolean);

    expect(result.ok).toBe(true);
    expect(committed).toEqual(['feature.ts']);
    expect(git(repo, 'status', '--porcelain').stdout).toContain('?? .elanous/');
  });

  test('glob 문자가 든 미추적 런타임 산출물은 추적된 인접 경로의 변경을 제외하지 않는다', () => {
    mkdirSync(join(repo, '.elanous'), { recursive: true });
    writeFileSync(join(repo, '.elanous', 'state1.json'), '{"version": 1}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'track runtime artifact');
    writeFileSync(join(repo, '.elanous', 'state1.json'), '{"version": 2}\n');
    writeFileSync(join(repo, '.elanous', 'state*.json'), '{}\n');

    const result = commitWorktree(repo, 'chore: preserve tracked runtime artifact');
    const committed = git(repo, 'show', '--format=', '--name-only', 'HEAD').stdout.trim().split('\n').filter(Boolean);

    expect(result.ok).toBe(true);
    expect(committed).toEqual(['.elanous/state1.json']);
    expect(git(repo, 'status', '--porcelain').stdout).toContain('?? .elanous/state*.json');
  });

  test('이미 추적된 elanous 런타임 산출물의 변경은 커밋한다', () => {
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), 'initial\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'track runtime artifact');
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), 'updated\n');

    const result = commitWorktree(repo, 'chore: update runtime artifact');
    const committed = git(repo, 'show', '--format=', '--name-only', 'HEAD').stdout.trim().split('\n').filter(Boolean);

    expect(result.ok).toBe(true);
    expect(committed).toEqual(['.elanous-child-liveness.hb']);
  });

  test('런타임 산출물만 있으면 nothing-to-commit no-op으로 남는다', () => {
    writeFileSync(join(repo, '.elanous-child-liveness.hb'), 'alive\n');
    mkdirSync(join(repo, '.elanous-se'), { recursive: true });
    writeFileSync(join(repo, '.elanous-se', 'state.json'), '{}\n');

    const result = commitWorktree(repo, 'chore: runtime only');

    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/nothing to commit|nothing added to commit/);
    expect(git(repo, 'status', '--porcelain').stdout.trim().split('\n').sort()).toEqual([
      '?? .elanous-child-liveness.hb',
      '?? .elanous-se/',
    ]);
  });
});

describe('defaultSeams diagnose — 판사에게 「내 지난 예측이 맞았나」가 «프롬프트로» 간다', () => {
  // ⛔ 리뷰 #10607 must-fix: helper 결과만 비교하는 시험은 「프롬프트에 실리나」를 증명하지 못한다.
  //   ⇒ 여기서는 llmReview 가 «실제로 받는 문자열»을 붙잡는다. 심은 LLM 하나뿐이고 그 위는 전부 진짜다.
  const capturePrompt = async (
    supervisorDecisionHistory: readonly { round: number; verdict: string; reason: string }[],
  ): Promise<string> => {
    let seen = '';
    const seams = defaultSeams({
      llmReview: async (prompt: string) => { seen = prompt; return 'BUDGET: EXTEND\nREASON: test'; },
    });
    await seams.diagnose!({
      runId: 'run-judge-feedback', note: 'gate failed', kind: 'gate', round: 5, cwd: '/tmp',
      goal: 'goal', history: [], effectiveMax: 2,
      supervisorDecisionHistory: supervisorDecisionHistory as never,
    });
    return seen;
  };

  test('⭐⭐ 빗나간 이력이 있으면 «적중률 줄»이 프롬프트에 실린다', async () => {
    // 📏 🅣 가 관측한 그 런의 모양(EXTEND ×4 · 끝난 적 없음).
    const prompt = await capturePrompt([
      { round: 1, verdict: 'EXTEND', reason: '한 라운드 안에 해결 가능하다' },
      { round: 2, verdict: 'EXTEND', reason: '한 라운드 내 수정 가능하다' },
      { round: 3, verdict: 'EXTEND', reason: '남은 한 라운드에서 수정 가능하다' },
      { round: 4, verdict: 'EXTEND', reason: '남은 한 라운드에서 수정 가능하다' },
    ]);
    expect(prompt).toContain('지난 EXTEND 예측');
    expect(prompt).toContain('3건 중 0건 적중');
    expect(prompt).toContain('3건 빗나감');
    // ⛔ 「아직 모른다」를 «따로» 적는다 — 빗나감으로 접지 않는다.
    expect(prompt).toContain('결과 미확정 1건');
    // ⛔ 지시가 아니라 «사실»임을 판사가 알 수 있어야 한다.
    expect(prompt).toContain('사실 관측이지 판정 지시가 아니다');
  });

  test('CONTRACT-CONFLICT 완화 문면은 TARGET을 수용 기준 전체 원문 행으로 요구한다', async () => {
    const prompt = await capturePrompt([]);
    expect(prompt).toContain('TARGET: <## ACCEPTANCE CRITERIA 안의 전체 원문 한 줄>');
    expect(prompt).toContain('EXPECTED: <그 TARGET 행의 현재 한 줄>');
    expect(prompt).toContain('REPLACEMENT: <그 TARGET 행에서 완화한 한 줄>');
    expect(prompt).toContain('TARGET은 첫 콜론 앞 접두·식별값이나 설명문이 아니라 수용 기준 행 전체와 정확히 일치해야 하며');
    expect(prompt).toContain('EXPECTED와 REPLACEMENT도 같은 TARGET 행에서 유래한 단일 수용 기준 행이어야 한다');
  });

  test('⛔ 결과가 «하나도 확정 안 됐으면» 그 줄이 «없다» — 0/0 을 신호로 읽지 않게', async () => {
    const prompt = await capturePrompt([{ round: 1, verdict: 'EXTEND', reason: '해결 가능' }]);
    expect(prompt).not.toContain('지난 EXTEND 예측');
    // ⭐ 그런데 이력 «자체»는 그대로 실린다 — 줄이 빠진 것이지 이력이 빠진 게 아니다.
    expect(prompt).toContain('감독 자기판정 이력');
  });

  test('⛔ 이력이 «아예 없으면» 종전과 같다', async () => {
    const prompt = await capturePrompt([]);
    expect(prompt).not.toContain('지난 EXTEND 예측');
    expect(prompt).toContain('이전 감독 판정 없음');
  });
});

describe('defaultSeams diagnose — escalation triage adapter', () => {
  test('purpose=escalation-triage sends a dedicated prompt and forwards only a TRIAGE judgement', async () => {
    let prompt = '';
    const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'TRIAGE: acceptance contract contradicts runtime'; } });
    const judgement = await seams.diagnose!({
      runId: 'run-escalation-triage', note: 'gate failed', kind: 'gate', round: 1, cwd: '/tmp',
      goal: 'goal acceptance', history: ['previous failure'], effectiveMax: 1, purpose: 'escalation-triage',
    });
    expect(judgement).toBe('TRIAGE: acceptance contract contradicts runtime');
    expect(prompt).toContain('승급 재작업의 트리아지 판정자');
    expect(prompt).toContain('예산 BUDGET 판정을 내리거나 기존 budget 진단을 반복하지 마라');
    expect(prompt).toContain('현재 실패/리뷰 지적:');
    expect(prompt).not.toContain('첫 줄은 정확히 하나: BUDGET:');
  });

  test('purpose=escalation-triage rejects a budget-shaped response instead of injecting it as a judgement', async () => {
    const seams = defaultSeams({ llmReview: async () => 'BUDGET: EXTEND\nREASON: retry' });
    await expect(seams.diagnose!({
      runId: 'run-escalation-triage-budget', note: 'gate failed', kind: 'gate', round: 1, cwd: '/tmp',
      goal: 'goal acceptance', history: [], effectiveMax: 1, purpose: 'escalation-triage',
    })).resolves.toBe('');
  });
});

describe('defaultSeams diagnose — 골 요약 잘림 관측', () => {
  test('부분만 실린 절 제목을 diagnose.done 관측에 싣는다', async () => {
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({ llmReview: async () => 'BUDGET: EXTEND\nREASON: test' });
      await seams.diagnose!({
        runId: 'run-goal-digest', note: 'gate failed', kind: 'gate', round: 1, cwd: '/tmp',
        goal: `## ACCEPTANCE CRITERIA\n${'x'.repeat(4000)}`,
        history: [], effectiveMax: 2,
      });
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-goal-digest',
        droppedSections: [],
        truncatedSections: ['ACCEPTANCE CRITERIA'],
        droppedNoiseLines: 0,
      })]);
    } finally {
      log.mockRestore();
    }
  });

  test('감독 재투입 사유 어휘의 모든 값과 진단 문자열 계약을 수용한다', async () => {
    const seams = defaultSeams({ llmReview: async () => 'BUDGET: EXTEND\nREASON: test' });
    const diagnoses = await Promise.all(SUPERVISION_REWORK_SOURCES.map((kind) => seams.diagnose!({
      runId: `run-${kind}`, note: 'failure', kind, round: 1, cwd: '/tmp', goal: 'goal', history: [], effectiveMax: 2,
    })));

    expect(diagnoses).toEqual(SUPERVISION_REWORK_SOURCES.map(() => 'BUDGET: EXTEND\nREASON: test'));
  });
});

describe('toReviewIntentInput — ReviewDiffContext forwarding contract', () => {
  test('gateEvidenceNote와 shardSiblings를 빈 값 없이 리뷰 intent 입력으로 전달한다', () => {
    const input = toReviewIntentInput({
      goal: '리뷰 골',
      gateEvidenceNote: 'gate evidence',
      shardSiblings: { items: [{ runId: 'run-sibling', shardId: 'shard-a', pieceIndex: 1 }], shownItems: 1, totalItems: 1, omittedItems: 0, truncated: false },
    });
    expect(input).toMatchObject({
      goal: '리뷰 골',
      gateEvidenceNote: 'gate evidence',
      shardSiblings: { items: [{ runId: 'run-sibling', shardId: 'shard-a', pieceIndex: 1 }] },
    });
    expect(toReviewIntentInput({ goal: '리뷰 골', gateEvidenceNote: ' ', shardSiblings: { items: [], shownItems: 0, totalItems: 0, omittedItems: 0, truncated: false } }))
      .not.toHaveProperty('gateEvidenceNote');
  });

  test('선언되지 않은 런타임 컨텍스트 키는 이름을 말하며 실패한다', () => {
    expect(() => toReviewIntentInput({ goal: '리뷰 골', futureContextFact: 'missing declaration' } as never))
      .toThrow('ReviewDiffContext keys missing forwarding declaration: futureContextFact');
  });
});

describe('defaultSeams reviewDiff — reviewer context budget 조인 키', () => {
  test('ReviewDiffContext의 runId와 round를 reviewer-context-budget 관측까지 전달한다', async () => {
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'reviewer-context-budget') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({
        reviewerContext: [{ label: 'context.md', body: 'review context' }],
        reviewScopeDiff: async () => '+changed',
        llmReview: async () => 'VERDICT: PASS',
      });
      const review = await seams.reviewDiff!('/tmp/review-context', { runId: 'run-review-1', round: 3 });
      expect(review).toMatchObject({
        contextItemCount: 1, contextShownChars: 29, contextTotalChars: 29,
        contextTruncated: false, contextFullyIncludedItems: 1, contextTruncatedItems: 0, contextOmittedItems: 0,
      });
    } finally {
      log.mockRestore();
    }
    expect(events).toEqual([expect.objectContaining({ runId: 'run-review-1', round: 3 })]);
  });
});

describe('featurePrompt — 버그B(자식 PR 게이트 우회 차단)', () => {
  test('작업 디렉토리와 기존 클린빌드·검증·범위제한 요소를 모두 보존한다', () => {
    const cwd = '/absolute/worktrees/self-impl-cwd';
    const p = featurePrompt('clamp 유틸 추가하고 P→E→R→D 돌려서 PR 올려줘', cwd);
    expect(p).toContain('clamp 유틸 추가');
    expect(p).toContain(cwd);
    expect(p).toContain('클린 빌드 규율:');
    expect(p).toContain('전체 `bun test` 스위트는 돌리지 마라');
    expect(p).toContain('bun bin/elanous.mjs self typecheck');
    expect(p).toContain('Ran 0 tests');
    expect(p).toMatch(/commit.*push.*PR.*금지|git commit.*금지/);
    expect(p).toContain('워킹트리에 변경만');
    expect(p).toContain('GOAL-COMPLETE');
  });

  test('골 문서의 ## STEPS 표제가 있을 때만 Plan 진행 지시를 참고 사실 뒤와 클린 빌드 앵커 앞에 넣는다', () => {
    const p = featurePrompt('## GOAL\n구현\n\n## STEPS\n1. 첫 작업\n2. 둘째 작업', '/tmp/worktree', [
      { label: 'grounding.md', body: '참고 사실 본문' },
    ]);
    expect(p).toContain('Plan 도구로 그 목록을 그대로 선언하라');
    expect(p).toContain('0 기준 인덱스로 MarkStepDone을 불러라');
    expect(p).toContain('끝나기 전에 미리 부르지 마라');
    expect(p).toContain('스텝을 새로 지어내지 말고 골 문서의 목록을 그대로 써라');
    expect(p.indexOf('참고 사실 본문')).toBeLessThan(p.indexOf('[계획 진행]'));
    expect(p.indexOf('[계획 진행]')).toBeLessThan(p.indexOf('클린 빌드 규율:'));
  });

  test('## STEPS 표제가 없으면 기존 프롬프트 산출에 Plan 진행 지시를 추가하지 않는다', () => {
    const p = featurePrompt('## GOAL\n구현\n\n## STEP\n첫 작업', '/tmp/worktree');
    expect(p).not.toContain('[계획 진행]');
    expect(p).not.toContain('Plan 도구로 그 목록을 그대로 선언하라');
    expect(p).not.toContain('MarkStepDone을 불러라');
  });

  test('빈 cwd 또는 미지정 cwd는 작업 디렉토리 줄 없이 프롬프트를 생성한다', () => {
    expect(featurePrompt('무언가 구현', '')).not.toContain('작업 디렉토리는');
    expect(featurePrompt('무언가 구현')).not.toContain('작업 디렉토리는');
  });

  test('빈 reviewer context는 기존 프롬프트 산출을 글자 그대로 유지한다', () => {
    expect(featurePrompt('무언가 구현', '/tmp/worktree', [])).toBe(featurePrompt('무언가 구현', '/tmp/worktree'));
  });

  test('implement seam은 사람이 지목한 사실을 PTY 프롬프트와 implement.context 관측에 전달한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-prompt-cwd-'));
    let captured = '';
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'implement.context') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({
        reviewerContext: [{ label: 'human-fact.md', body: '사람이 지목한 사실 본문' }],
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          captured = opts.featurePrompt;
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' };
        },
      });
      await seams.implement({ cwd, feature: '런타임 프롬프트 전달\n\n## STEPS\n1. 프롬프트 전달', runId: 'run-test' });
      expect(captured).toContain(cwd);
      expect(captured).toContain('## 참고 사실');
      expect(captured).toContain('Plan 도구로 그 목록을 그대로 선언하라');
      expect(captured).toContain('human-fact.md');
      expect(captured).toContain('사람이 지목한 사실 본문');
      expect(events).toEqual([expect.objectContaining({ itemCount: 1, truncated: false, runId: 'run-test' })]);
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('implement ctx signal alone reaches and aborts the PTY driver', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-context-signal-'));
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          receivedSignal = opts.signal;
          return new Promise(() => {});
        },
      });
      const implementation = seams.implement({ cwd, feature: 'context signal propagation', runId: 'run-test', signal: controller.signal });
      controller.abort();
      expect(receivedSignal).toBe(controller.signal);
      expect(receivedSignal?.aborted).toBe(true);
      void implementation.catch(() => {});
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('예산을 넘긴 reviewer context는 implement.context에 잘림을 남긴다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-prompt-context-truncated-'));
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'implement.context') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({
        reviewerContext: [{ label: 'large-fact.md', body: 'x'.repeat(12_001) }],
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({ ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' }),
      });
      await seams.implement({ cwd, feature: '잘림 관측', runId: 'run-test' });
      expect(events).toEqual([expect.objectContaining({ itemCount: 1, truncated: true, truncatedItems: 1, omittedItems: 0, runId: 'run-test' })]);
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('implement ctx의 lifecycle 분류를 PTY 드라이버 두 라운드에서 순서대로 전달한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-lifecycle-classification-'));
    const classifications: string[] = [];
    let invocation = 0;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          opts.onLifecycleScreenClassification?.(invocation++ === 0 ? 'agree' : 'signal-incomplete');
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' };
        },
      });
      const ctx = { cwd, feature: '분류 전달', runId: 'run-test', onLifecycleScreenClassification: (classification: string) => classifications.push(classification) };
      await seams.implement(ctx);
      await seams.implement(ctx);
      expect(classifications).toEqual(['agree', 'signal-incomplete']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('외부 cwd는 실행 중 elanous 루트로 폴백하고 명시 루트·저장소 루트 우선순위를 보존한다', async () => {
    const outsideCwd = mkdtempSync(join(tmpdir(), 'seam-bin-root-outside-'));
    const repoCwd = mkdtempSync(join(tmpdir(), 'seam-bin-root-repo-'));
    const sourceRoot = resolve(import.meta.dir, '../..');
    const captured: string[] = [];
    const driver = async (opts: { binRoot: string }) => {
      captured.push(opts.binRoot);
      return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit' as const, exitCode: 0, ptyId: 'pty-test' };
    };
    try {
      git(repoCwd, 'init', '-b', 'main');
      const run = async (cwd: string, elanousBinRoot?: string) => {
        await defaultSeams({ ptyAvailable: () => true, runHeadlessGoalLoopPty: driver, ...(elanousBinRoot ? { elanousBinRoot } : {}) })
          .implement({ cwd, feature: 'bin root selection', runId: 'run-bin-root' });
      };

      await run(outsideCwd);
      await run(repoCwd);
      await run(outsideCwd, '/explicit-elanous-root');

      expect(captured).toEqual([sourceRoot, repoCwd, '/explicit-elanous-root']);
      expect(existsSync(join(captured[0]!, 'bin', 'elanous.mjs'))).toBe(true);
    } finally {
      rmSync(outsideCwd, { recursive: true, force: true });
      rmSync(repoCwd, { recursive: true, force: true });
    }
  });
});

describe('changedFileTypecheck — #2 변경파일 스코프 tsc 게이트', () => {
  const F = 'src/autopilot/mission-codebase-gate.ts';
  const gateConfigCwd = resolve(import.meta.dir, '../..');
  const tscOut = [
    `${F}(281,50): error TS2304: Cannot find name 'refFacts'.`,   // 변경 파일 에러(=잡아야)
    `src/views/pane-policy.ts(85,5): error TS2322: baseline.`,     // baseline(무시해야)
  ].join('\n');
  const completed = (out: string, status = out ? 1 : 0) => ({ out, status, signal: null, durationMs: 12 });

  test('변경 파일에 실제 에러가 있으면 종전처럼 실패하고 기존 오류 관측을 보존한다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F, 'src/foo.test.ts'], () => completed(tscOut));
    expect(r).toMatchObject({ passed: false, checked: 2, errors: 1, exempted: 0, noInspectionReason: null });
    expect(r.log).toContain('refFacts');
  });

  test('Next env 설정 없는 구 브랜치는 셋째 패스만 건너뛰고 로그에 config-missing을 남긴다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'no-pwa-env-config-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1;');
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{"include":["src/**/*.ts"]}');
      const calls: string[][] = [];
      const result = changedFileTypecheck(cwd, ['src/a.ts'], (_cmd, args) => { calls.push(args); return completed(''); });
      expect(calls).toHaveLength(1);
      expect(result).toMatchObject({ passed: true, noInspectionReason: null });
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({ pwaEnv: 'config-missing' }), expect.anything());
    } finally { log.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
  });

  test('test 디렉터리의 파일만 바뀌면 Next env 패스를 실행하지 않는다', () => {
    const calls: string[][] = [];
    const result = changedFileTypecheck(gateConfigCwd, ['test/helper.ts'], (_cmd, args) => {
      calls.push(args);
      return completed('');
    });
    expect(result).toMatchObject({ passed: true, errors: 0 });
    expect(calls).toHaveLength(1);
  });

  test('Next env 패스만 실행 실패하면 못 잰 것으로 막고 시험 파일만 바뀌면 건너뛴다', () => {
    const calls: string[][] = [];
    const run = (_cmd: string, args: string[]) => {
      calls.push(args);
      return calls.length === 2
        ? { out: '', status: null, signal: 'SIGKILL' as const, durationMs: 1 }
        : completed('');
    };
    const failed = changedFileTypecheck(gateConfigCwd, [F], run);
    expect(failed).toMatchObject({ passed: false, executed: false, errors: 0, noInspectionReason: null });
    expect(failed.log).toContain('SIGKILL');
    calls.length = 0;
    expect(changedFileTypecheck(gateConfigCwd, ['src/foo.test.ts'], run)).toMatchObject({ passed: true, executed: true, errors: 0 });
    expect(calls).toHaveLength(1);
  });

  test('루트 ProcessEnv 실물 범위 컴파일은 비시험 파일만 Next env 오류로 막고 단언 뒤 통과한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pwa-env-seams-'));
    const sourceRoot = resolve(import.meta.dir, '../..');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(git(cwd, 'init', '-q').status).toBe(0);
      mkdirSync(join(cwd, 'src'));
      mkdirSync(join(cwd, 'types'));
      writeFileSync(join(cwd, 'tsconfig.gate.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts', 'types/node.d.ts'] }));
      writeFileSync(join(cwd, 'tsconfig.pwa-env.json'), readFileSync(join(sourceRoot, 'tsconfig.pwa-env.json'), 'utf8').replace('"types/next-process-env-mirror.d.ts"', '"types/next-process-env-mirror.d.ts", "types/node.d.ts"'));
      writeFileSync(join(cwd, 'types/next-process-env-mirror.d.ts'), readFileSync(join(sourceRoot, 'types/next-process-env-mirror.d.ts'), 'utf8'));
      writeFileSync(join(cwd, 'types/node.d.ts'), 'declare namespace NodeJS { interface ProcessEnv { PATH?: string } }');
      writeFileSync(join(cwd, 'src/a.test.ts'), "export const e: NodeJS.ProcessEnv = { PATH: '/bin' };\n");
      const check = (literal: boolean) => {
        writeFileSync(join(cwd, 'src/a.ts'), `const e: NodeJS.ProcessEnv = ${literal ? "{ PATH: '/bin' } as NodeJS.ProcessEnv" : "{ PATH: '/bin' }"};\n`);
        const configs: string[] = [];
        const result = changedFileTypecheck(cwd, ['src/a.ts', 'src/a.test.ts'], (_cmd, args) => {
          const config = args.at(-1)!;
          configs.push(config);
          const run = spawnSync(process.execPath, [join(sourceRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', config], { cwd, encoding: 'utf8' });
          return { out: `${run.stdout ?? ''}${run.stderr ?? ''}`, status: run.status, signal: run.signal, durationMs: 1 };
        });
        return { result, configs };
      };
      const broken = check(false);
      expect(broken.result).toMatchObject({ passed: false, errors: 1 });
      expect(broken.result.log).toContain('src/a.ts');
      expect(broken.result.log).toContain("Property 'NODE_ENV' is missing");
      expect(broken.result.log).not.toContain('src/a.test.ts');
      expect(broken.configs).toHaveLength(2);
      expect(log.mock.calls.find((call) => call[0] === 'typecheck.gate' && call[1] === 'ratchet')?.[2]).toMatchObject({
        executions: [expect.objectContaining({ checkedFiles: ['src/a.ts', 'src/a.test.ts'] }), expect.objectContaining({ checkedFiles: ['src/a.ts'], scopedConfigUsed: true })],
      });
      expect(check(true).result).toMatchObject({ passed: true, errors: 0 });
    } finally { log.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
  });

  test('독립적인 root .tsx는 범위 컴파일 Next env 오류에 귀속되고 test는 제외된다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pwa-env-tsx-seams-'));
    const sourceRoot = resolve(import.meta.dir, '../..');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      git(cwd, 'init', '-q');
      mkdirSync(join(cwd, 'src'));
      mkdirSync(join(cwd, 'types'));
      writeFileSync(join(cwd, 'tsconfig.gate.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts', 'types/node.d.ts'] }));
      writeFileSync(join(cwd, 'tsconfig.pwa-env.json'), readFileSync(join(sourceRoot, 'tsconfig.pwa-env.json'), 'utf8').replace('"types/next-process-env-mirror.d.ts"', '"types/next-process-env-mirror.d.ts", "types/node.d.ts"'));
      writeFileSync(join(cwd, 'types/next-process-env-mirror.d.ts'), readFileSync(join(sourceRoot, 'types/next-process-env-mirror.d.ts'), 'utf8'));
      writeFileSync(join(cwd, 'types/node.d.ts'), 'declare namespace NodeJS { interface ProcessEnv { PATH?: string } }');
      writeFileSync(join(cwd, 'src/Widget.tsx'), "const e: NodeJS.ProcessEnv = { PATH: '/bin' };\n");
      writeFileSync(join(cwd, 'src/Widget.test.ts'), "export const e: NodeJS.ProcessEnv = { PATH: '/bin' };\n");
      const outputs: string[] = [];
      const result = changedFileTypecheck(cwd, ['src/Widget.tsx', 'src/Widget.test.ts'], (_cmd, args) => {
        const output = spawnSync(process.execPath, [join(sourceRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', args.at(-1)!], { cwd, encoding: 'utf8' });
        outputs.push(`${output.stdout ?? ''}${output.stderr ?? ''}`);
        return { out: outputs.at(-1)!, status: output.status, signal: output.signal, durationMs: 1 };
      });
      expect(outputs).toHaveLength(2);
      expect(outputs[1]).toContain('src/Widget.tsx(1,7): error TS2741');
      expect(outputs[1]).not.toContain('src/Widget.test.ts');
      expect(result).toMatchObject({ passed: false, errors: 1 });
      expect(result.log).toContain('src/Widget.tsx(1,7): error TS2741');
      expect(result.log).not.toContain('src/Widget.test.ts');
      expect(log.mock.calls.find((call) => call[0] === 'typecheck.gate' && call[1] === 'ratchet')?.[2]).toMatchObject({
        executions: [expect.anything(), { config: 'tsconfig.pwa-env.json', checkedFiles: ['src/Widget.tsx'], executed: true, scopedConfigUsed: true }],
      });
      writeFileSync(join(cwd, 'src/Widget.tsx'), "const e: NodeJS.ProcessEnv = { PATH: '/bin' } as NodeJS.ProcessEnv;\n");
      const repaired = changedFileTypecheck(cwd, ['src/Widget.tsx', 'src/Widget.test.ts'], (_cmd, args) => {
        const output = spawnSync(process.execPath, [join(sourceRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', args.at(-1)!], { cwd, encoding: 'utf8' });
        return { out: `${output.stdout ?? ''}${output.stderr ?? ''}`, status: output.status, signal: output.signal, durationMs: 1 };
      });
      expect(repaired).toMatchObject({ passed: true, errors: 0 });
    } finally { log.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
  });

  test('TypeScript 설정이 전혀 없는 작업 트리에서 .ts 하나를 바꾸면 해당 없음으로 통과하고 컴파일러를 돌리지 않는다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'no-typescript-config-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      let calls = 0;
      const result = changedFileTypecheck(cwd, [F], () => {
        calls += 1;
        return completed('');
      });
      expect(result).toMatchObject({
        passed: true, executed: false, checked: 1, errors: 0, exempted: 0,
        noInspectionReason: 'no-typescript-config',
      });
      expect(result.noInspectionReason).not.toBe('missing-typecheck-gate-config');
      expect(calls).toBe(0);
      expect(existsSync(join(cwd, 'tsconfig.gate.json'))).toBe(false);
      expect(existsSync(join(cwd, 'tsconfig.json'))).toBe(false);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executed: false,
        passed: true,
        noInspectionReason: 'no-typescript-config',
      }));
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('tsconfig.json만 있는 작업 트리는 그 설정을 -p 인자로 컴파일러에 넘긴다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tsconfig-json-only-'));
    writeFileSync(join(cwd, 'tsconfig.json'), '{}');
    try {
      const calls: string[][] = [];
      const result = changedFileTypecheck(cwd, [F], (_cmd, args) => {
        calls.push(args);
        return completed('');
      });
      expect(calls[0]).toEqual(['tsc', '--noEmit', '-p', 'tsconfig.json']);
      expect(result).toMatchObject({ passed: true, executed: true, noInspectionReason: null });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('고른 게이트 설정을 읽지 못하면 missing-typecheck-gate-config로 실패하고 통과로 접지 않는다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'unreadable-typecheck-gate-config-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      let calls = 0;
      const result = changedFileTypecheck(cwd, [F], () => {
        calls += 1;
        return completed('');
      }, { config: 'tsconfig.gate.json', path: join(cwd, 'tsconfig.gate.json') });
      expect(result).toMatchObject({
        passed: false, executed: false, checked: 1, errors: 0, exempted: 0,
        noInspectionReason: 'missing-typecheck-gate-config',
      });
      expect(result.log).toContain('tsconfig.gate.json');
      expect(result.log).toContain('컴파일러를 실행하지 않았다');
      expect(calls).toBe(0);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executed: false,
        noInspectionReason: 'missing-typecheck-gate-config',
        missingConfig: 'tsconfig.gate.json',
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('defaultSeams.gate는 TypeScript 설정이 없는 작업 트리에서 해당 없음으로 통과한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'default-seams-no-typescript-config-'));
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'ratchet') events.push(data ?? {});
    }) as never);
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'changed.ts'), 'export const changed = true;\n');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src', 'changed.ts'), 'export const changed = false;\n');

      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '' }),
      }).gate(cwd);

      expect(events).toContainEqual(expect.objectContaining({
        noInspectionReason: 'no-typescript-config',
        passed: true,
        executed: false,
      }));
      expect(existsSync(join(cwd, 'tsconfig.gate.json'))).toBe(false);
      expect(existsSync(join(cwd, 'tsconfig.json'))).toBe(false);
      expect(gate.log).not.toContain('missing-typecheck-gate-config');
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('게이트 실행 관측 이벤트는 executed·status·signal·error·durationMs를 모두 보존한다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const executionError = new Error('spawn unavailable');
    try {
      changedFileTypecheck(gateConfigCwd, [F], () => ({
        out: '',
        status: null,
        signal: 'SIGTERM',
        error: executionError,
        durationMs: 47,
      }));

      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executed: false,
        status: null,
        signal: 'SIGTERM',
        error: 'spawn unavailable',
        durationMs: 47,
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
    }
  });

  test('변경 파일에 에러 없음(baseline 만) → pass', () => {
    const r = changedFileTypecheck(gateConfigCwd, ['src/other.ts'], () => completed(tscOut));
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });

  test('변경 .ts 없음은 무검사 사유를 관측에 남기고 실행하지 않는다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let calls = 0;
    try {
      const r = changedFileTypecheck(gateConfigCwd, ['docs/x.md', 'README'], () => {
        calls += 1;
        return completed(tscOut);
      });
      expect(r).toMatchObject({
        passed: true, executed: false, checked: 0, errors: 0, exempted: 0,
        noInspectionReason: 'no-typecheckable-changed-files',
      });
      expect(calls).toBe(0);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        checked: 0, passed: true, errors: 0, exempted: 0,
        noInspectionReason: 'no-typecheckable-changed-files',
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('검사 후 통과는 무검사가 아님을 관측에 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const r = changedFileTypecheck(gateConfigCwd, [F], () => completed(''));
      expect(r).toMatchObject({
        passed: true, executed: true, checked: 1, errors: 0, exempted: 0,
        noInspectionReason: null,
      });
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executed: true, noInspectionReason: null,
      }), { level: 'info' });
    } finally {
      log.mockRestore();
    }
  });

  test('변경 파일 밖 진단은 게이트를 통과시키면서 ratchet 원장에 파일별 건수를 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const outside = 'test/unrelated-consumer.test.ts';
      const r = changedFileTypecheck(gateConfigCwd, [F], () => completed([
        `${outside}(10,1): error TS2305: Module has no exported member 'removedOne'.`,
        `${outside}(11,1): error TS2305: Module has no exported member 'removedTwo'.`,
      ].join('\n')));

      expect(r).toMatchObject({ passed: true, executed: true, errors: 0, exempted: 0 });
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        outsideChanged: [{ file: outside, count: 2 }],
      }), { level: 'info' });
    } finally {
      log.mockRestore();
    }
  });

  test('변경 파일 밖 진단이 없으면 ratchet 원장의 outsideChanged는 비어 있다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      changedFileTypecheck(gateConfigCwd, [F], () => completed(''));
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        outsideChanged: [],
      }), { level: 'info' });
    } finally {
      log.mockRestore();
    }
  });

  test('타입 검사가 신호로 죽으면 통과가 아니다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F], () => ({ out: '', status: null, signal: 'SIGTERM', durationMs: 91 }));
    expect(r.passed).toBe(false);
    expect(r.executed).toBe(false);
  });

  // ⛔ 리뷰 should-fix(3차): 한 줄 로그 계약 — error.message 의 개행이 로그를 여러 줄로 만든다.
  test('실행 실패 로그는 error 에 개행이 있어도 한 줄을 유지한다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F], () => ({
      out: '', status: null, signal: null, error: new Error('line1\nline2'), durationMs: 4,
    }));
    expect(r.passed).toBe(false);
    const failLine = r.log.split('\n').find((l) => l.includes('타입 검사 실행 실패'))!;
    expect(failLine).toContain('line1 ⏎ line2');
    expect(failLine.includes('\n')).toBe(false);
  });

  // ⛔ 리뷰 지적(2026-07-30 2차): `error` 분기 회귀가 없어 그 갈래를 못 잡는다.
  //    이 갈래가 **가장 진단적**이다 — tsc 실행 파일 자체가 없으면(ENOENT) 출력이 비고
  //    종전 판정은 그것을 "에러 0건 = 통과" 로 읽었다.
  test('타입 검사를 실행조차 못 하면(spawn error) 통과가 아니고 그 사유가 log 에 남는다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F], () => ({
      out: '', status: null, signal: null, error: new Error('spawn bunx ENOENT'), durationMs: 3,
    }));
    expect(r.passed).toBe(false);
    expect(r.executed).toBe(false);
    expect(r.log).toContain('spawn bunx ENOENT');
  });

  test('게이트 실행 관측은 실행 상태와 종료 진단 필드를 ratchet 이벤트에 보존한다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      changedFileTypecheck(gateConfigCwd, [F], () => ({
        out: '',
        status: 23,
        signal: 'SIGTERM',
        error: new Error('spawn interrupted'),
        durationMs: 91,
      }));
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executed: false,
        status: 23,
        signal: 'SIGTERM',
        error: 'spawn interrupted',
        durationMs: 91,
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
    }
  });

  test('타입 검사가 0 아닌 코드로 끝났는데 출력에 파싱 가능한 에러가 하나도 없으면 통과가 아니다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F], () => ({ out: 'configuration missing', status: 1, signal: null, durationMs: 12 }));
    expect(r.passed).toBe(false);
    expect(r.executed).toBe(false);
  });

  test('타입 검사가 0으로 끝나고 출력이 비면 통과다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F], () => completed(''));
    expect(r.passed).toBe(true);
    expect(r.executed).toBe(true);
  });

  test('게이트 실행 관측은 executed·status·signal·error·durationMs를 ratchet 이벤트에 싣는다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const error = new Error('spawn bunx ENOENT');
      changedFileTypecheck(gateConfigCwd, [F], () => ({
        out: '', status: null, signal: 'SIGTERM', error, durationMs: 77,
      }));

      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executed: false,
        status: null,
        signal: 'SIGTERM',
        error: 'spawn bunx ENOENT',
        durationMs: 77,
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
    }
  });

  test('실행 실패일 때 log 한 줄에 종료 코드와 신호와 소요 시간과 다음 행동이 모두 들어 있다', () => {
    const r = changedFileTypecheck(gateConfigCwd, [F], () => ({ out: '', status: null, signal: 'SIGKILL', durationMs: 77 }));
    expect(r.log).toContain('status=null');
    expect(r.log).toContain('signal=SIGKILL');
    expect(r.log).toContain('durationMs=77');
    expect(r.log).toContain('다시 실행하라');
    expect(r.log).not.toContain('\n');
  });

  test('PWA 파일은 PWA 설정으로만 분류해 root의 설정 누락 진단을 판정에 넣지 않는다', () => {
    const pwa = 'apps/pwa/src/App.tsx';
    const calls: string[][] = [];
    const r = changedFileTypecheck(gateConfigCwd, [pwa], (_cmd, args) => {
      calls.push(args);
      return completed(args.includes('apps/pwa/tsconfig.json')
        ? ''
        : `${pwa}(1,1): error TS2307: Cannot find module 'react'.`);
    });
    expect(calls).toEqual([
      ['tsc', '--noEmit', '-p', 'tsconfig.gate.json'],
      ['tsc', '--noEmit', '-p', 'apps/pwa/tsconfig.json'],
    ]);
    expect(r).toMatchObject({ passed: true, executed: true, checked: 1, errors: 0 });
  });

  test('PWA 파일의 진짜 타입 오류는 PWA 설정 결과로 계속 실패한다', () => {
    const pwa = 'apps/pwa/src/App.tsx';
    const r = changedFileTypecheck(gateConfigCwd, [pwa], (_cmd, args) => completed(
      args.includes('apps/pwa/tsconfig.json') ? `${pwa}(2,3): error TS2322: Type 'string' is not assignable to type 'number'.` : '',
    ));
    expect(r).toMatchObject({ passed: false, executed: true, errors: 1 });
    expect(r.log).toContain("Type 'string' is not assignable");
  });

  test('PWA entry uses its own scoped config while zero root entries fall back to the full project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-pwa-scoped-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'apps/pwa/src/view.tsx'), 'export const view = 1;\n');
      const configs: string[] = [];
      const result = changedFileTypecheck(cwd, ['apps/pwa/src/view.tsx'], (_cmd, args) => {
        configs.push(args.at(-1)!);
        if (configs.length === 2) {
          expect(JSON.parse(readFileSync(args.at(-1)!, 'utf8'))).toMatchObject({ files: ['src/view.tsx'], include: [], exclude: [] });
        }
        return completed('');
      });
      expect(result).toMatchObject({ passed: true, checked: 1, errors: 0 });
      expect(configs[0]).toBe('tsconfig.gate.json');
      expect(configs[1]).toContain('/apps/pwa/.elanous-typecheck-scope-');
      expect(readdirSync(join(cwd, 'apps/pwa')).filter((file) => file.startsWith('.elanous-typecheck-scope-'))).toEqual([]);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: [], executed: true, scopedConfigUsed: false },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: ['apps/pwa/src/view.tsx'], executed: true, scopedConfigUsed: true },
        ],
      }), { level: 'info' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('current scoped config contains changed and promoted consumer roots and is removed after inspection', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-current-scoped-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; }\n');
      writeFileSync(join(cwd, 'src/consumer.ts'), "import type { Model } from './model';\nexport const value: Model = { stable: 'ok' };\n");
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; required: boolean; }\n');
      const seen: string[][] = [];
      const diagnostic = 'src/consumer.ts(2,14): error TS2741: missing required.';
      const result = changedFileTypecheck(cwd, ['src/model.ts'], (_cmd, args) => {
        if (args.at(-1)?.includes('.elanous-typecheck-scope-')) {
          const config = JSON.parse(readFileSync(args.at(-1)!, 'utf8')) as { files: string[]; extends: string };
          expect(config.extends).toBe(join(realpathSync(cwd), 'tsconfig.gate.json')); // the writer resolves the tree (macOS /var → /private/var)
          seen.push(config.files);
        }
        return completed(diagnostic);
      }, undefined, () => []);
      expect(result).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(seen).toEqual([['src/model.ts', 'src/consumer.ts']]);
      expect(readdirSync(cwd).filter((file) => file.startsWith('.elanous-typecheck-scope-'))).toEqual([]);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [{ config: 'tsconfig.gate.json', checkedFiles: ['src/model.ts', 'src/consumer.ts'], executed: true, scopedConfigUsed: true }],
      }), expect.anything());
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('promotion compares base diagnostics: existing consumer stays outside, added consumer fails', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-diff-consumer-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; }\n');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; required: boolean; }\n');
      const oldLine = 'src/old.ts(2,1): error TS2322: existing debt.';
      const newLine = 'src/new.ts(2,1): error TS2741: Property required is missing.';
      const baseDiagnostics = (_cwd: string, config: string, files?: readonly string[]) => {
        expect(config).toBe('tsconfig.gate.json');
        expect(files).toEqual(['src/model.ts', 'src/old.ts', 'src/new.ts']);
        return [{ file: 'src/old.ts', line: oldLine, code: 'TS2322' }];
      };
      const run = () => completed(`${oldLine}\n${newLine}`);
      const result = changedFileTypecheck(cwd, ['src/model.ts'], run, undefined, baseDiagnostics);
      expect(result).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(result.log).toContain(newLine);
      expect(result.log).not.toContain(oldLine);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unavailable base diagnostics with current consumer errors warns instead of failing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-unavailable-base-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; }\n');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; required: boolean; }\n');
      const result = changedFileTypecheck(cwd, ['src/model.ts'], () => completed(
        'src/consumer.ts(2,1): error TS2741: new consumer.',
      ), undefined, () => null);
      // 골: base 를 못 얻으면 승격 소비자는 «실패»가 아니라 경고로만 — 자식이 고칠 수 없는 이유로 런을 막지 않는다.
      expect(result).toMatchObject({ passed: true, checked: 1, errors: 0 });
      expect(result.log).toContain('base 진단 비교 불가');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('PWA promotion compares PWA baseline independently of root baseline', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-pwa-diff-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; }\n');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; required: boolean; }\n');
      const oldLine = 'apps/pwa/src/a.tsx(2,1): error TS2322: old debt.';
      const newLine = 'apps/pwa/src/b.tsx(2,1): error TS2741: new consumer.';
      const configs: string[] = [];
      const result = changedFileTypecheck(cwd, ['src/model.ts'], (_cmd, args) => completed(
        args.includes('apps/pwa/tsconfig.json') ? `${oldLine}\n${newLine}` : '',
      ), undefined, (_dir, config) => {
        configs.push(config);
        return config === 'apps/pwa/tsconfig.json' ? [{ file: 'apps/pwa/src/a.tsx', line: oldLine, code: 'TS2322' }] : [];
      });
      // 루트 진단이 비었으니 루트 base 는 재지 않는다(소비자 후보가 있을 때만 base 를 잰다).
      expect(configs).toEqual(['apps/pwa/tsconfig.json']);
      expect(result).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(result.log).toContain(newLine);
      expect(result.log).not.toContain(oldLine);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing PWA workspace dependencies still runs compiler with root resolution', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-pwa-unavailable-'));
    try {
      mkdirSync(join(cwd, 'apps/pwa'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}\n');
      const configs: string[] = [];
      const result = changedFileTypecheck(cwd, ['apps/pwa/src/view.tsx'], (_cmd, args) => {
        configs.push(args.at(-1)!);
        return completed('');
      });
      expect(configs).toEqual(['tsconfig.gate.json', 'apps/pwa/tsconfig.json']);
      expect(result).toMatchObject({ passed: true, executed: true, checked: 1 });
      expect(result.log).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('base scopes only paths present at the fork, falls back for exclusively new paths, and keeps ambient declarations', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-base-new-file-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['src/**/*.ts'] }));
      writeFileSync(join(cwd, 'src/globals.d.ts'), 'declare const PROJECT_GLOBAL: number;\n');
      writeFileSync(join(cwd, 'src/existing.ts'), 'export const existing: number = PROJECT_GLOBAL;\n');
      symlinkSync(join(gateConfigCwd, 'node_modules'), join(cwd, 'node_modules'), 'dir');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', 'tsconfig.gate.json', 'src');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/new.ts'), 'export const added: number = PROJECT_GLOBAL;\n');

      expect(mergeBaseDiagnostics(cwd, 'tsconfig.gate.json', ['src/existing.ts', 'src/new.ts'])).toEqual([]);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'base-diagnostics', { config: 'tsconfig.gate.json', scopedConfigUsed: true });
      expect(mergeBaseDiagnostics(cwd, 'tsconfig.gate.json', ['src/new.ts'])).toEqual([]);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'base-diagnostics', { config: 'tsconfig.gate.json', scopedConfigUsed: false });
      expect(git(cwd, 'worktree', 'list', '--porcelain').stdout.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test('default base diagnostics uses a dependency-linked merge-base worktree and cleans it up', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typecheck-base-worktree-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/*.ts'] }));
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; }\n');
      writeFileSync(join(cwd, 'src/consumer.ts'), "import type { Model } from './model';\nexport const value: Model = { stable: 'ok' };\n");
      symlinkSync(join(gateConfigCwd, 'node_modules'), join(cwd, 'node_modules'), 'dir');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/model.ts'), 'export interface Model { stable: string; required: boolean; }\n');
      const line = "src/consumer.ts(2,14): error TS2741: Property 'required' is missing in type '{ stable: string; }' but required in type 'Model'.";
      const baseLog = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        const result = changedFileTypecheck(cwd, ['src/model.ts'], () => completed(line));
        expect(result).toMatchObject({ passed: false, checked: 2, errors: 1 });
        expect(baseLog).toHaveBeenCalledWith('typecheck.gate', 'base-diagnostics', { config: 'tsconfig.gate.json', scopedConfigUsed: true });
      } finally {
        baseLog.mockRestore();
      }
      expect(git(cwd, 'worktree', 'list', '--porcelain').stdout.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  test('export 타입에 필수 필드가 추가되면 그 타입을 쓰는 미변경 consumer도 검사 대상에 포함한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'required-export-consumer-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'src', 'model.ts'), 'export interface Model { stable: string; }\n');
      writeFileSync(join(cwd, 'src', 'consumer.ts'), "import type { Model } from './model';\nexport const value: Model = { stable: 'ok' };\n");
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src', 'model.ts'), 'export interface Model { stable: string; required: boolean; }\n');

      const r = changedFileTypecheck(cwd, ['src/model.ts'], () => completed(
        "src/consumer.ts(2,14): error TS2741: Property 'required' is missing in type '{ stable: string; }' but required in type 'Model'.",
      ), undefined, () => []);

      expect(r).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(r.log).toContain('src/consumer.ts');
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: ['src/model.ts', 'src/consumer.ts'], executed: true, scopedConfigUsed: true },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: [], executed: true, scopedConfigUsed: false },
        ],
        requiredExportFieldPromotions: [{ file: 'src/model.ts', typeName: 'Model', fieldName: 'required' }],
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('root export 타입 필수 필드 추가는 미변경 PWA consumer를 PWA 검사 대상으로 포함한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'required-export-pwa-consumer-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      mkdirSync(join(cwd, 'apps', 'pwa', 'src'), { recursive: true });
      mkdirSync(join(cwd, 'apps', 'pwa'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'apps', 'pwa', 'tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'src', 'model.ts'), 'export interface Model { stable: string; }\n');
      writeFileSync(join(cwd, 'apps', 'pwa', 'src', 'consumer.tsx'), "import type { Model } from '../../../src/model';\nexport const value: Model = { stable: 'ok' };\n");
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src', 'model.ts'), 'export interface Model { stable: string; required: boolean; }\n');

      const calls: string[][] = [];
      const r = changedFileTypecheck(cwd, ['src/model.ts'], (_cmd, args) => {
        calls.push(args);
        return completed(args.at(-1)?.includes('/apps/pwa/') || args.includes('apps/pwa/tsconfig.json')
          ? "apps/pwa/src/consumer.tsx(2,14): error TS2741: Property 'required' is missing in type '{ stable: string; }' but required in type 'Model'."
          : '');
      }, undefined, () => []);

      expect(calls.slice(0, 2)).toEqual([
        ['tsc', '--noEmit', '-p', 'tsconfig.gate.json'],
        ['tsc', '--noEmit', '-p', 'apps/pwa/tsconfig.json'],
      ]);
      expect(calls).toHaveLength(4);
      expect(calls[2]?.at(-1)).toContain('.elanous-typecheck-scope-');
      expect(calls[3]?.at(-1)).toContain('.elanous-typecheck-scope-');
      expect(r).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(r.log).toContain('apps/pwa/src/consumer.tsx');
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: ['src/model.ts'], executed: true, scopedConfigUsed: true },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: ['apps/pwa/src/consumer.tsx'], executed: true, scopedConfigUsed: true },
        ],
        requiredExportFieldPromotions: [{ file: 'src/model.ts', typeName: 'Model', fieldName: 'required' }],
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('exported 심볼 삭제는 root와 미변경 PWA consumer를 승격하고 PWA 타입 검사를 실행한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'removed-export-pwa-consumer-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      mkdirSync(join(cwd, 'apps', 'pwa', 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'apps', 'pwa', 'tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'src', 'api.ts'), 'export const removed = 1;\n');
      writeFileSync(join(cwd, 'apps', 'pwa', 'src', 'consumer.tsx'), "import { removed } from '../../../src/api';\nexport const value = removed;\n");
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src', 'api.ts'), 'export const retained = 1;\n');

      const calls: string[][] = [];
      const r = changedFileTypecheck(cwd, ['src/api.ts'], (_cmd, args) => {
        calls.push(args);
        return completed(args.at(-1)?.includes('/apps/pwa/') || args.includes('apps/pwa/tsconfig.json')
          ? "apps/pwa/src/consumer.tsx(1,10): error TS2305: Module '../../../src/api' has no exported member 'removed'."
          : '');
      }, undefined, () => []);

      expect(calls.slice(0, 2)).toEqual([
        ['tsc', '--noEmit', '-p', 'tsconfig.gate.json'],
        ['tsc', '--noEmit', '-p', 'apps/pwa/tsconfig.json'],
      ]);
      expect(calls).toHaveLength(4);
      expect(calls[2]?.at(-1)).toContain('.elanous-typecheck-scope-');
      expect(calls[3]?.at(-1)).toContain('.elanous-typecheck-scope-');
      expect(r).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        promotionTriggers: ['removed-exported-symbol'],
        removedExportedSymbolPromotions: [{ file: 'src/api.ts', name: 'removed' }],
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: ['src/api.ts'], executed: true, scopedConfigUsed: true },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: ['apps/pwa/src/consumer.tsx'], executed: true, scopedConfigUsed: true },
        ],
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('exported 함수 매개변수 증가는 미변경 root consumer를 승격하고 ratchet trigger에 기록한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'added-export-parameter-consumer-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'src', 'api.ts'), 'export function format(value: string) { return value; }\n');
      writeFileSync(join(cwd, 'src', 'consumer.ts'), "import { format } from './api';\nexport const value = format('ok');\n");
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src', 'api.ts'), 'export function format(value: string, prefix: string) { return prefix + value; }\n');

      const r = changedFileTypecheck(cwd, ['src/api.ts'], () => completed(
        'src/consumer.ts(2,22): error TS2554: Expected 2 arguments, but got 1.',
      ), undefined, () => []);

      expect(r).toMatchObject({ passed: false, checked: 2, errors: 1 });
      expect(r.log).toContain('src/consumer.ts');
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        promotionTriggers: ['added-function-parameter'],
        addedFunctionParameterPromotions: [{ file: 'src/api.ts', name: 'format', from: 1, to: 2 }],
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: ['src/api.ts', 'src/consumer.ts'], executed: true, scopedConfigUsed: true },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: [], executed: true, scopedConfigUsed: false },
        ],
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('PWA export 타입 필수 필드 추가는 무관한 미변경 root 진단을 승격하지 않는다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pwa-export-root-nonpromotion-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      mkdirSync(join(cwd, 'apps', 'pwa', 'src'), { recursive: true });
      mkdirSync(join(cwd, 'apps', 'pwa'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'apps', 'pwa', 'tsconfig.json'), '{}\n');
      writeFileSync(join(cwd, 'src', 'unrelated.ts'), 'export const broken: number = "old debt";\n');
      writeFileSync(join(cwd, 'apps', 'pwa', 'src', 'model.tsx'), 'export interface PwaModel { stable: string; }\n');
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'apps', 'pwa', 'src', 'model.tsx'), 'export interface PwaModel { stable: string; required: boolean; }\n');

      const r = changedFileTypecheck(cwd, ['apps/pwa/src/model.tsx'], (_cmd, args) => completed(
        args.includes('apps/pwa/tsconfig.json')
          ? ''
          : 'src/unrelated.ts(1,14): error TS2322: Type string is not assignable to type number.',
      ));

      expect(r).toMatchObject({ passed: true, checked: 1, errors: 0 });
      expect(r.log).not.toContain('src/unrelated.ts');
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: [], executed: true, scopedConfigUsed: false },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: ['apps/pwa/src/model.tsx'], executed: true, scopedConfigUsed: true },
        ],
        requiredExportFieldPromotions: [{ file: 'apps/pwa/src/model.tsx', typeName: 'PwaModel', fieldName: 'required' }],
      }), { level: 'info' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('필수 export 필드를 늘리지 않은 평범한 변경은 검사 대상 수를 보존한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ordinary-typecheck-scope-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
      writeFileSync(join(cwd, 'src', 'model.ts'), 'export interface Model { stable: string; }\n');
      writeFileSync(join(cwd, 'src', 'consumer.ts'), "import type { Model } from './model';\nexport const value: Model = { stable: 'ok' };\n");
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src', 'model.ts'), 'export interface Model { stable: number; }\n');

      const r = changedFileTypecheck(cwd, ['src/model.ts'], () => completed(
        "src/consumer.ts(2,31): error TS2322: Type 'string' is not assignable to type 'number'.",
      ));

      expect(r).toMatchObject({ passed: true, checked: 1, errors: 0 });
      expect(r.log).not.toContain('src/consumer.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('root 파일은 root 설정으로 계속 판정하고 PWA 검사는 실행하지 않는다', () => {
    const calls: string[][] = [];
    const r = changedFileTypecheck(gateConfigCwd, [F], (_cmd, args) => {
      calls.push(args);
      return completed(`${F}(1,1): error TS2304: Cannot find name 'rootOnly'.`);
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.slice(0, 3)).toEqual(['tsc', '--noEmit', '-p']);
    expect(calls[0]?.at(-1)).toContain('.elanous-typecheck-scope-');
    expect(calls[1]?.at(-1)).toContain('.elanous-typecheck-scope-');
    expect(r).toMatchObject({ passed: false, errors: 1 });
  });

  test('혼합 변경은 설정별 소유 파일과 실행 결과를 ratchet 관측에 남긴다', () => {
    const pwa = 'apps/pwa/src/App.tsx';
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      changedFileTypecheck(gateConfigCwd, [F, pwa], (_cmd, args) => completed(
        args.at(-1)?.includes('/apps/pwa/') || args.includes('apps/pwa/tsconfig.json')
          ? `${pwa}(2,3): error TS2322: PWA error.`
          : `${F}(1,1): error TS2304: root error.`,
      ));
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          { config: 'tsconfig.gate.json', checkedFiles: [F], executed: true, scopedConfigUsed: true },
          { config: 'apps/pwa/tsconfig.json', checkedFiles: [pwa], executed: true, scopedConfigUsed: false },
          { config: 'tsconfig.pwa-env.json', checkedFiles: [F], executed: true, scopedConfigUsed: true },
        ],
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
    }
  });

  test('PWA 검사를 실행하지 못하면 root 결과가 깨끗해도 fail-closed 한다', () => {
    const pwa = 'apps/pwa/src/App.tsx';
    const r = changedFileTypecheck(gateConfigCwd, [pwa], (_cmd, args) => args.includes('apps/pwa/tsconfig.json')
      ? { out: '', status: null, signal: 'SIGTERM' as const, durationMs: 4 }
      : completed(''));
    expect(r).toMatchObject({ passed: false, executed: false, errors: 0 });
  });

  test('.d.ts 는 제외', () => {
    const r = changedFileTypecheck(gateConfigCwd, ['src/types.d.ts'], () => completed('src/types.d.ts(1,1): error TS1005: x.'));
    expect(r.checked).toBe(0);   // .d.ts 는 변경집합에서 제외
    expect(r.passed).toBe(true);
  });
});

describe('defaultSeams — #25 apply/gate 라우팅(P2/P3)', () => {
  let box: string;
  const shadows: string[] = [];
  beforeEach(() => { box = mkdtempSync(join(tmpdir(), 'seam-apply-')); });
  afterEach(() => {
    rmSync(box, { recursive: true, force: true });
    for (const s of shadows.splice(0)) rmSync(s, { recursive: true, force: true });
  });

  test('git 타겟(옵션 없음) → apply seam 미노출(PR 경로 유지·회귀 0)', () => {
    expect(defaultSeams({}).apply).toBeUndefined();
    expect(defaultSeams({ repoRoot: '/ext/repo' }).apply).toBeUndefined();
  });

  test('targetKind=file → gate=syntax(유효 JSON 통과) + apply seam 노출·실위치 적용', async () => {
    const target = join(box, 'config.json');
    writeFileSync(target, '{"a": 1}\n');
    const s = stageFile({ target, branch: 'dev/f' }); shadows.push(s.path);
    const seams = defaultSeams({ targetKind: 'file', targetPath: target });

    // gate = config syntax(그림자 안 파일). 유효 JSON → passed.
    const g = await seams.gate(s.path);
    expect(g.passed).toBe(true);
    expect(g.log).toContain('syntax gate');

    // apply seam 노출 → 편집을 실위치에 반영(백업).
    expect(typeof seams.apply).toBe('function');
    writeFileSync(join(s.path, 'config.json'), '{"a": 2}\n');
    const r = seams.apply!({ cwd: s.path });
    expect(r.applied).toBe(true);
    expect(r.target).toBe(target);
    expect(existsSync(r.backup)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"a": 2}\n');
  });

  test('targetKind=file → 깨진 JSON 은 gate fail(적용 차단)', async () => {
    const target = join(box, 'bad.json');
    writeFileSync(target, '{"a": 1}\n');
    const s = stageFile({ target, branch: 'dev/bad' }); shadows.push(s.path);
    writeFileSync(join(s.path, 'bad.json'), '{"a": 1,,}');   // 깨뜨림
    const seams = defaultSeams({ targetKind: 'file', targetPath: target });
    const g = await seams.gate(s.path);
    expect(g.passed).toBe(false);
  });

  test('targetKind=non-git-dir → apply seam 노출(디렉토리 rsync 적용)', () => {
    const seams = defaultSeams({ targetKind: 'non-git-dir', targetPath: join(box, 'x') });
    expect(typeof seams.apply).toBe('function');
  });
});


describe('defaultSeams — worktree integration ancestry', () => {
  let box: string;
  let repo: string;
  let origin: string;
  const worktrees: string[] = [];

  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), 'seam-integration-base-'));
    origin = join(box, 'origin.git');
    repo = join(box, 'repo');
    git(box, 'init', '--bare', origin);
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');
  });
  afterEach(() => {
    // ⛔⭐ 워크트리를 지워도 «인스턴스 뿌리»는 남는다 — `~/.elanous/worktrees/<instance>/repo.worktrees/<wt>`
    //   구조라 두 칸 위가 이 시험이 «만든» 디렉토리다. 그것을 안 걷으면 빈 껍데기가 쌓인다.
    //   🩸 실측 2026-09-08: `seam-integration-base-*` 가 **328개** 쌓여 있었고, 이 파일을 한 번 돌리면
    //     정확히 «1개» 는다(328→329 로 눌러 확인). 09-07 46개 · 09-08 33개 — «지금도» 자란다.
    //   ⛔ 글롭(`seam-integration-base-*`)으로 지우지 않는다 — 남의 디렉토리를 지울 수 있다.
    //     이 시험이 «만든 경로»에서만 거슬러 올라간다.
    const instanceRoots = new Set(worktrees.map((path) => dirname(dirname(path))));
    for (const path of worktrees.splice(0)) git(repo, 'worktree', 'remove', '--force', path);
    rmSync(box, { recursive: true, force: true });
    // ⛔ 비어 있을 때만 지운다 — 다른 것이 들어 있으면 내 것이 아니다(fail-safe).
    for (const root of instanceRoots) {
      try {
        const container = join(root, 'repo.worktrees');
        if (existsSync(container) && readdirSync(container).length === 0) rmSync(container, { recursive: true, force: true });
        if (existsSync(root) && readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
      } catch { /* 정리 실패가 시험을 죽이지 않는다 */ }
    }
  });

  test('resolved base가 origin/main의 조상이거나 같으면 true, feature-only면 false', async () => {
    const seams = defaultSeams({ repoRoot: repo });
    const integration = await seams.createWorktree({ branch: 'self-impl/integration-base' });
    worktrees.push(integration.path);
    expect(integration.baseIsIntegration).toBe(true);

    git(repo, 'checkout', '-b', 'feature/unlanded');
    writeFileSync(join(repo, 'feature.ts'), 'export const unlanded = true;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'unlanded feature');
    const feature = await seams.createWorktree({ branch: 'self-impl/feature-base' });
    worktrees.push(feature.path);
    expect(feature.baseIsIntegration).toBe(false);
  });
});

describe('defaultSeams.gate — source policy feedback', () => {
  test('passing tests and typecheck cannot hide an injected isolation policy failure; the log reaches rework', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-policy-gate-'));
    const policyEvents: unknown[] = [];
    const observation = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'self-implement' && event === 'gate.policy') policyEvents.push(data);
    }) as never);
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'README.md'), 'base\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/x.ts'), 'export const x = 1;\n');
      const changed: string[][] = [];
      const result = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: ({ cwd: target, changedFiles }) => {
          expect(target).toBe(cwd);
          changed.push([...changedFiles]);
          return { passed: false, failures: [{ gate: 'isolation-gate', lines: ['[isolation-gate] FAIL src/x.ts'] }] };
        },
      }).gate(cwd);
      expect(changed).toEqual([['src/x.ts']]);
      expect(result.passed).toBe(false);
      expect(result.log).toContain('[isolation-gate] FAIL src/x.ts');
      expect(policyEvents).toEqual([{ passed: false, failures: ['isolation-gate'], skipped: undefined }]);
    } finally {
      observation.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a Promise-resolved public-export-import failure blocks the harness gate with its diagnostic', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-public-export-import-'));
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'README.md'), 'base\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/x.ts'), 'export const x = 1;\n');
      const result = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: async ({ changedFiles }) => {
          expect(changedFiles).toEqual(['src/x.ts']);
          await Promise.resolve();
          return { passed: false, failures: [{ gate: 'public-export-import', lines: ['src/x.ts:1 → src/private.ts'] }] };
        },
      }).gate(cwd);
      expect(result.passed).toBe(false);
      expect(result.log).toContain('src/x.ts:1 → src/private.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a passing policy leaves the previous gate.log byte-for-byte intact', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-policy-clean-'));
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'README.md'), 'base\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      const result = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [] }),
      }).gate(cwd);
      expect(result.passed).toBe(true);
      expect(result.log).toBe('[test] PASS\n\nVerify-by-breaking: skipped; reason=no-changes; evaluated-changes=[]; test-step=scope-skipped\n\n[gate-scope] no-changes — test 스텝을 건너뛰었다(변경파일 tsc 만 검증). 이 스코프가 관측한 변경이 없어 동작 테스트 대상이 없다.');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams.gate — dependency-wide validation feedback', () => {
  test('PWA reachable source invokes the dependency gate seam even without a manifest change', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-pwa-reachable-'));
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
      mkdirSync(join(cwd, 'src/llm'), { recursive: true });
      writeFileSync(join(cwd, 'apps/pwa/src/entry.tsx'), "import '../../../src/llm/x.js';\n");
      writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 2;\n');
      const calls: string[][] = [];
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [] }),
        runDependencyChangeGate: ({ changedFiles }) => {
          calls.push([...changedFiles]);
          return { ran: true, passed: false, failures: [{ step: 'pwa-build', lines: ['PWA build failed'] }] };
        },
      }).gate(cwd);
      expect(calls).toEqual([['src/llm/x.ts']]);
      expect(gate.passed).toBe(false);
      expect(gate.log).toContain('[dependency-change: pwa-build] FAIL\nPWA build failed');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test('missing PWA dependencies remain visible in the seam gate log even while passing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-pwa-unmeasured-'));
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
      mkdirSync(join(cwd, 'src/llm'), { recursive: true });
      writeFileSync(join(cwd, 'apps/pwa/src/entry.tsx'), "import '../../../src/llm/x.js';\n");
      writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 2;\n');
      const result = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [] }),
        runDependencyChangeGate: () => ({ ran: false, passed: true, failures: [], measured: false, skipped: 'pwa-deps-missing', trigger: 'pwa-reachable', pwaReachableChanged: ['src/llm/x.ts'] }),
      }).gate(cwd);
      expect(result.passed).toBe(true);
      expect(result.log).toContain('[dependency-change: pwa-build] 못 쟀다 — pwa-deps-missing');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('passing tests, changed-file tsc and policy cannot hide an unchanged consumer broken by a dependency update', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-dependency-gate-'));
    const events: unknown[] = [];
    const observation = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'self-implement' && event === 'gate.dependency-change') events.push(data);
    }) as never);
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'README.md'), 'base\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      writeFileSync(join(cwd, 'bun.lock'), 'updated lock');
      const calls: string[][] = [];
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [] }),
        runDependencyChangeGate: ({ cwd: target, changedFiles }) => {
          expect(target).toBe(cwd);
          calls.push([...changedFiles]);
          return { ran: true, passed: false, failures: [{ step: 'root-tsc', lines: ['src/acp/server.ts(36,3): error TS2724: session API removed'] }] };
        },
      }).gate(cwd);
      expect(calls).toEqual([['bun.lock']]);
      expect(gate.passed).toBe(false);
      expect(gate.log).toContain('[dependency-change: root-tsc] FAIL');
      expect(gate.log).toContain('src/acp/server.ts(36,3): error TS2724');
      expect(events).toEqual([{ ran: true, passed: false, failures: ['root-tsc'], skipped: undefined, trigger: undefined, pwaReachableChanged: undefined, measured: undefined }]);
    } finally {
      observation.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-dependency changes do not call the injected gate or change the existing gate log', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-dependency-unchanged-'));
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'README.md'), 'base\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/a.ts'), 'export const a = true;\n');
      const options: DefaultSeamsOptions = {
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] PASS' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [] }),
      };
      const baseline = await defaultSeams(options).gate(cwd);
      const result = await defaultSeams({
        ...options,
        runDependencyChangeGate: () => { throw new Error('must not call dependency gate'); },
      }).gate(cwd);
      expect(result.passed).toBe(true);
      expect(result.log).toBe(baseline.log);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams — platform gates', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-platform-gate-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  async function gate(changed: Record<string, string>, androidExit = 0, iosExit = 0) {
    for (const [file, content] of Object.entries(changed)) {
      const path = join(repo, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const androidCalls: { args: readonly string[]; cwd: string }[] = [];
    const iosCalls: { args: readonly string[]; cwd: string }[] = [];
    const integrityCalls: { steps?: GateStepName[]; testArgs?: string[] }[] = [];
    const seams = defaultSeams({
      runAndroidUnitTestGate: (io) => { androidCalls.push(io); return androidExit; },
      runIosUnitTestGate: (io) => { iosCalls.push(io); return iosExit; },
      runIntegrityGate: (_cwd, opts) => {
        integrityCalls.push(opts);
        return { passed: true, steps: [], log: '' } satisfies GateResult;
      },
    });
    const result = await seams.gate(repo);
    return { androidCalls, iosCalls, integrityCalls, result };
  }

  test('Android 변경은 실제 Bun 경계에서 Kotlin 필터를 분리하고 기존 runner를 한 번 부른다', async () => {
    const kotlinPath = join(repo, 'apps/android/src/test/FooTest.kt');
    const typescriptPath = join(repo, 'src/self-implement/seams.test.js');
    mkdirSync(dirname(kotlinPath), { recursive: true });
    mkdirSync(dirname(typescriptPath), { recursive: true });
    writeFileSync(kotlinPath, 'class FooTest\n');
    writeFileSync(typescriptPath, 'import { test } from \'bun:test\'; test(\'fixture\', () => {});\n');
    const androidCalls: { args: readonly string[]; cwd: string }[] = [];
    const integrityInputs: { steps?: GateStepName[]; testArgs?: string[] }[] = [];
    const bunCalls: string[][] = [];
    const seams = defaultSeams({
      gateSteps: ['test'],
      runAndroidUnitTestGate: (io) => { androidCalls.push(io); return 0; },
      runIosUnitTestGate: () => 0,
      runIntegrityGate: async (cwd, opts) => {
        integrityInputs.push({ ...opts, testArgs: opts.testArgs ? [...opts.testArgs] : undefined });
        return runIntegrityGate(cwd, {
          ...opts,
          runCmd: async (cmd, args) => {
            expect(cmd).toBe('bun');
            bunCalls.push([...args]);
            return { code: 0, stdout: '1 pass\n0 fail\nRan 1 test across 1 file.\n', stderr: '', timedOut: false };
          },
        });
      },
    });

    const result = await seams.gate(repo);

    expect(integrityInputs[0]!.testArgs).toContain('apps/android/src/test/FooTest.kt');
    expect(androidCalls).toHaveLength(1);
    expect(androidCalls[0]!.args).toEqual(['--changed-files', 'apps/android/src/test/FooTest.kt', 'src/self-implement/seams.test.js']);
    expect(bunCalls).toEqual([['test', 'src/self-implement/seams.test.js']]);
    expect(bunCalls.flat()).not.toContain('apps/android/src/test/FooTest.kt');
    expect(result.passed).toBe(true);
  });

  test('Swift-only 변경은 빈 Bun testArgs여도 iOS runner를 한 번 부른다', async () => {
    const observed = await gate({ 'apps/ios/Sources/Bar.swift': 'struct Bar {}\n' });
    expect(observed.androidCalls).toHaveLength(0);
    expect(observed.iosCalls).toHaveLength(1);
    expect(observed.integrityCalls[0]!.testArgs).toBeUndefined();
    expect(observed.result.passed).toBe(true);
  });

  test('platform runner 실패는 Bun gate가 통과해도 최종 gate를 실패시킨다', async () => {
    const observed = await gate({ 'apps/ios/Sources/Bar.swift': 'struct Bar {}\n' }, 0, 1);
    expect(observed.integrityCalls).toHaveLength(1);
    expect(observed.result.passed).toBe(false);
  });

  test('평범한 TypeScript 변경은 platform runner를 깨우지 않는다', async () => {
    const observed = await gate({ 'src/example.ts': 'export const example = true;\n' });
    expect(observed.androidCalls).toHaveLength(0);
    expect(observed.iosCalls).toHaveLength(0);
    expect(observed.integrityCalls).toHaveLength(1);
  });
});

describe('defaultSeams — docs-only gate scope', () => {
  let repo: string;
  let captured: { steps?: GateStepName[]; testArgs?: string[] } | undefined;
  let result: { passed?: boolean; log?: string; testStepExecuted?: boolean; scopeReason?: string; unverified?: readonly string[]; documentPaths?: readonly string[]; documentsWithoutDerivedTests?: readonly string[]; missingTestFiles?: number; comparisonBaseStatus?: string } | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-gate-scope-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  async function gate(changed: Record<string, string>, gateSteps?: GateStepName[], runId?: string, round?: number) {
    for (const [file, content] of Object.entries(changed)) {
      const path = join(repo, file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
    const seams = defaultSeams({
      ...(gateSteps ? { gateSteps } : {}),
      runIntegrityGate: (_cwd, opts) => {
        captured = opts;
        return {
          passed: true,
          steps: opts.steps?.includes('test') === false
            ? []
            : [{ name: 'test', ok: true, skipped: false, summary: 'test passed' }],
          log: '',
        } satisfies GateResult;
      },
    });
    result = await seams.gate(repo, runId || round !== undefined ? { ...(runId ? { runId } : {}), ...(round !== undefined ? { round } : {}) } : undefined);
    return captured!;
  }

  test('docs-only 변경은 test 스텝을 제외한다', async () => {
    const opts = await gate({ 'docs/A.md': 'a', 'AGENTS.md': 'b' });
    expect(opts.steps).toEqual(['cli-smoke']);
    expect(opts.testArgs).toBeUndefined();
    expect(result).toMatchObject({ testStepExecuted: false, scopeReason: 'docs-only', unverified: [], missingTestFiles: 0 });
  });

  test('혼합 문서와 소스 변경의 문서 시험 비기여를 결과와 gate.scope에 남긴다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const opts = await gate({ 'AGENTS.md': 'changed', 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': 'test(\'a\', () => {});\n' });
      expect(opts.testArgs).toEqual(['src/a.test.ts']);
      expect(result).toMatchObject({
        testStepExecuted: true,
        scopeReason: 'changed-tests',
        documentPaths: ['AGENTS.md'],
        documentsWithoutDerivedTests: ['AGENTS.md'],
      });
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.scope', expect.objectContaining({
        documentPaths: ['AGENTS.md'], documentPathCount: 1,
        documentsWithoutDerivedTests: ['AGENTS.md'], documentsWithoutDerivedTestCount: 1,
      }), expect.anything());
    } finally {
      log.mockRestore();
    }
  });

  test('비교 기준이 없으면 성공적 빈 변경 skip 대신 명시 실패하고 test를 실행하지 않는다', async () => {
    git(repo, 'checkout', '--orphan', 'no-base');
    git(repo, 'rm', '-rf', '.');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const opts = await gate({});
      expect(opts.steps).toEqual(['cli-smoke']);
      expect(opts.steps).not.toContain('test');
      expect(result).toMatchObject({
        passed: false,
        testStepExecuted: false,
        comparisonBaseStatus: 'unavailable',
        scopeReason: 'comparison-base-unavailable',
      });
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.scope', expect.objectContaining({
        comparisonBaseStatus: 'unavailable', scopeReason: 'comparison-base-unavailable', testStepSkipped: true,
      }), expect.anything());
    } finally {
      log.mockRestore();
    }
  });

  test('비교 기준이 없으면 기존 목록은 미커밋 변경만 순서대로 유지한다', () => {
    writeFileSync(join(repo, 'docs.md'), 'uncommitted only\n');
    expect(gateChangedFiles(repo, null)).toEqual({ files: ['docs.md'], comparisonBaseStatus: 'unavailable' });
  });

  test('비교 성공 뒤 변경이 없으면 no-tracked-changes와 no-changes로 test를 건너뛴다', async () => {
    const opts = await gate({});
    expect(opts.steps).toEqual(['cli-smoke']);
    expect(opts.steps).not.toContain('test');
    expect(result).toMatchObject({
      passed: true,
      testStepExecuted: false,
      comparisonBaseStatus: 'no-tracked-changes',
      scopeReason: 'no-changes',
      verifyByBreaking: expect.objectContaining({ skippedReason: 'no-changes' }),
    });
  });

  test('비교 기준 뒤 untracked 변경만 있으면 결합된 기존 목록을 보존하고 tracked-changes를 남긴다', () => {
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(repo, 'docs.md'), 'untracked only\n');
    expect(gateChangedFiles(repo, base)).toEqual({
      files: ['docs.md'],
      comparisonBaseStatus: 'tracked-changes',
    });
  });

  test('비교 git diff 실패는 기준 미획득·정상 빈 목록과 다른 comparison-failed로 남긴다', () => {
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    setGitCommandRunnerForTesting((cwd, args, options) => {
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === base) return { status: 1, stdout: '', stderr: 'injected diff failure' };
      const actual = spawnSync('git', args, { ...options, cwd, encoding: 'utf8' });
      return { status: actual.status, stdout: actual.stdout ?? '', stderr: actual.stderr ?? '' };
    });
    try {
      expect(gateChangedFiles(repo, base)).toEqual({ files: [], comparisonBaseStatus: 'comparison-failed' });
    } finally {
      setGitCommandRunnerForTesting(undefined);
    }
  });

  test('비교 실패는 성공적 빈 변경 skip 대신 명시 실패하고 test를 실행하지 않는다', async () => {
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    setGitCommandRunnerForTesting((cwd, args, options) => {
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === base) return { status: 1, stdout: '', stderr: 'injected diff failure' };
      const actual = spawnSync('git', args, { ...options, cwd, encoding: 'utf8' });
      return { status: actual.status, stdout: actual.stdout ?? '', stderr: actual.stderr ?? '' };
    });
    try {
      const opts = await gate({});
      expect(opts.steps).toEqual(['cli-smoke']);
      expect(opts.steps).not.toContain('test');
      expect(result).toMatchObject({
        passed: false,
        testStepExecuted: false,
        comparisonBaseStatus: 'comparison-failed',
        scopeReason: 'comparison-base-failed',
      });
    } finally {
      setGitCommandRunnerForTesting(undefined);
    }
  });

  test('비교 기준 대비 변경은 기존 목록 순서와 중복 제거를 유지하고 tracked-changes를 남긴다', () => {
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
    git(repo, 'add', 'src.ts');
    git(repo, 'commit', '-m', 'tracked change');
    writeFileSync(join(repo, 'docs.md'), 'uncommitted only\n');
    expect(gateChangedFiles(repo, base)).toEqual({
      files: ['src.ts', 'docs.md'],
      comparisonBaseStatus: 'tracked-changes',
    });
  });

  test('앞 라운드에 커밋된 소스의 기존 짝 시험을 마지막 라운드의 무짝 소스 게이트에서 실행한다', async () => {
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test/earlier.test.ts'), "import { test } from 'bun:test';\ntest('earlier', () => {});\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base test');
    git(repo, 'checkout', '-b', 'feature/earlier');
    mkdirSync(join(repo, 'src/cli'), { recursive: true });
    writeFileSync(join(repo, 'src/earlier.ts'), 'export const earlier = true;\n');
    git(repo, 'add', 'src/earlier.ts');
    git(repo, 'commit', '-m', 'earlier source');

    const opts = await gate({ 'src/cli/private-ledger-commands.ts': 'export const ledger = true;\n' });
    expect(opts.testArgs).toContain('test/earlier.test.ts');
    expect(result).toMatchObject({ scopeReason: 'derived', testStepExecuted: true,
      unverified: ['src/cli/private-ledger-commands.ts'] });
  });

  test('앞 라운드에서 삭제한 서버 경로의 비교-base 소비자 시험을 마지막 라운드 무짝 소스 게이트에서 실행한다', async () => {
    const server = 'src/nexus/api/old-route.ts';
    const consumer = 'apps/pwa/chrome/old-route.test.ts';
    mkdirSync(join(repo, 'src/nexus/api'), { recursive: true });
    mkdirSync(join(repo, 'apps/pwa/chrome'), { recursive: true });
    writeFileSync(join(repo, server), "server.get('/v1/old-route', handler);\n");
    writeFileSync(join(repo, consumer), "fetch('/v1/old-route');\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base route and consumer');
    git(repo, 'checkout', '-b', 'feature/remove-route');
    git(repo, 'rm', server);
    git(repo, 'commit', '-m', 'remove route');

    const opts = await gate({ 'src/cli/private-ledger-commands.ts': 'export const ledger = true;\n' });
    expect(opts.testArgs).toEqual([consumer]);
    expect(result).toMatchObject({ scopeReason: 'derived', testStepExecuted: true,
      unverified: ['src/cli/private-ledger-commands.ts'] });
  });

  test('런 전체에도 짝이 없으면 동작 검증 0 경고와 라운드를 관측한다', async () => {
    git(repo, 'checkout', '-b', 'feature/unpaired');
    mkdirSync(join(repo, 'src/cli'), { recursive: true });
    writeFileSync(join(repo, 'src/earlier.ts'), 'export const earlier = true;\n');
    git(repo, 'add', 'src/earlier.ts');
    git(repo, 'commit', '-m', 'earlier source');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const opts = await gate({ 'src/cli/private-ledger-commands.ts': 'export const ledger = true;\n' }, undefined, undefined, 3);
      expect(opts.steps).not.toContain('test');
      expect(result).toMatchObject({ scopeReason: 'no-related-tests', testStepExecuted: false });
      expect(result?.log).toContain('⚠️ 동작 검증 0: src/cli/private-ledger-commands.ts, src/earlier.ts — 사람 확인 필요');
      expect(log).toHaveBeenCalledWith('self-implement.gate-scope', 'no-related-tests',
        { files: ['src/cli/private-ledger-commands.ts', 'src/earlier.ts'], round: 3 }, { level: 'warn' });
    } finally {
      log.mockRestore();
    }
  });

  test('실제 gate는 비교 기준 뒤 커밋된 변경을 tracked-changes로 반환한다', async () => {
    git(repo, 'checkout', '-b', 'feature/tracked-change');
    writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
    git(repo, 'add', 'src.ts');
    git(repo, 'commit', '-m', 'tracked change');
    await gate({});
    expect(result).toMatchObject({ comparisonBaseStatus: 'tracked-changes' });
  });

  test('커밋된 시험 + 미커밋 release notes를 실제 게이트가 함께 재고 test 스텝을 실행한다', async () => {
    const testFile = 'scripts/release-loop/publish-node.test.ts';
    git(repo, 'checkout', '-b', 'feature/publish');
    mkdirSync(join(repo, 'scripts/release-loop'), { recursive: true });
    writeFileSync(join(repo, testFile), "import { test, expect } from 'bun:test';\ntest('publish', () => expect(2 + 2).toBe(4));\n");
    git(repo, 'add', testFile);
    git(repo, 'commit', '-m', 'test publish');
    mkdirSync(join(repo, 'release'), { recursive: true });
    writeFileSync(join(repo, 'release/next.md'), 'fix — publish\n');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const gateResult = await defaultSeams({
        gateSteps: ['test'],
        runHarnessPolicyGates: () => ({ passed: true, failures: [] }),
        runVerifyByBreaking: () => ({ files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }),
      }).gate(repo);
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.scope', expect.objectContaining({
        'evaluated-changes': ['release/next.md', testFile],
        evaluatedChangeCount: 2, scopeReason: 'changed-tests', testStepSkipped: false,
      }), expect.anything());
      expect(gateResult).toMatchObject({ passed: true, scopeReason: 'changed-tests', testStepExecuted: true, measuredFileCount: 2 });
      expect(gateResult.log).toContain('[test] PASS');
    } finally { log.mockRestore(); }
  });

  test('테스트 변경은 기존처럼 testArgs를 전달하고 test를 유지한다', async () => {
    const opts = await gate({ 'src/x.test.ts': 'test(1)' });
    expect(opts.steps).toBeUndefined();
    expect(opts.testArgs).toEqual(['src/x.test.ts']);
    expect(result).toMatchObject({ testStepExecuted: true, scopeReason: 'changed-tests', unverified: [], missingTestFiles: 0 });
  });

  test('no-related-tests는 test 스텝을 제거한다(전체 bun test 폴백 없음)', async () => {
    const opts = await gate({ 'src/x.ts': 'export const x = 1;' });
    expect(opts.steps).toEqual(['cli-smoke']);
    expect(opts.steps).not.toContain('test');
    expect(opts.testArgs).toBeUndefined();
  });

  test('서버 파일만 바뀌어도 PWA 경로 소비 시험을 실행하고 이유를 gate.scope에 남긴다', async () => {
    const pwa = 'apps/pwa/chrome/inside-events.test.ts';
    mkdirSync(join(repo, 'apps/pwa/chrome'), { recursive: true });
    writeFileSync(join(repo, pwa), "fetch('/v1/inside/events');\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'PWA route consumer');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const opts = await gate({ 'src/nexus/api/inside-events.ts': "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n" });
      expect(opts.testArgs).toEqual([pwa]);
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.scope', expect.objectContaining({
        callerTests: [{ file: pwa, reasons: ['route'] }], callerTestsOverflow: [],
      }), expect.anything());
    } finally { log.mockRestore(); }
  });

  test('실물 seam은 관례 밖 importer를 실행 집합에 추가한다', async () => {
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'off-convention.test.ts'), "import '../src/x.js';\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'off convention importer');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const opts = await gate({ 'src/x.ts': 'export const x = 1;' }, undefined, 'run-gate-scope-join');
      expect(opts.steps).toBeUndefined();
      expect(opts.testArgs).toEqual(['test/off-convention.test.ts']);
      expect(result).toMatchObject({
        scopeReason: 'derived',
        importerTestsNotRun: { total: 0, files: [], truncated: false },
      });
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.scope', expect.objectContaining({
        runId: 'run-gate-scope-join',
        callerTests: [{ file: 'test/off-convention.test.ts', reasons: ['import'] }],
        importerTestsNotRun: [], importerTestsNotRunCount: 0, importerTestsNotRunTruncated: false,
      }), expect.anything());
    } finally {
      log.mockRestore();
    }
  });

  test('실물 seam은 src 밖 변경의 관례 밖 importer도 실행 집합에 넣는다', async () => {
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'script-importer.test.ts'), "import '../scripts/x.js';\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'script importer');

    const opts = await gate({ 'scripts/x.ts': 'export const x = 1;' });
    expect(opts.steps).toBeUndefined();
    expect(opts.testArgs).toEqual(['test/script-importer.test.ts']);
    expect(result).toMatchObject({
      scopeReason: 'derived',
      importerTestsNotRun: { total: 0, files: [], truncated: false },
    });
  });

  test('실물 seam 색인은 주석·문자열·비테스트 파일을 importer로 세지 않는다', async () => {
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'comment-only.test.ts'), "// import '../src/x.js';\nconst text = \\\"import('../src/x.js')\\\";\n");
    writeFileSync(join(repo, 'test', 'helper.ts'), "import '../src/x.js';\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'non importer text');

    const opts = await gate({ 'src/x.ts': 'export const x = 1;' });
    expect(opts.steps).toEqual(['cli-smoke']);
    expect(opts.testArgs).toBeUndefined();
    expect(result).toMatchObject({ scopeReason: 'no-related-tests', importerTestsNotRun: { total: 0, files: [], truncated: false } });
  });

  test('색인 읽기 실패는 게이트를 중단하지 않고 nullable importer 관측으로 남긴다', async () => {
    mkdirSync(join(repo, 'test'), { recursive: true });
    const trackedTest = join(repo, 'test', 'deleted-importer.test.ts');
    writeFileSync(trackedTest, "import '../src/x.js';\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'tracked importer');
    rmSync(trackedTest);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const opts = await gate({ 'src/x.ts': 'export const x = 1;' });
      expect(opts.steps).toEqual(['cli-smoke']);
      expect(opts.testArgs).toBeUndefined();
      expect(result).toMatchObject({ scopeReason: 'no-related-tests', importerTestsNotRun: null });
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.scope', expect.objectContaining({
        importerTestIndexAvailable: false, importerTestsNotRun: null, importerTestsNotRunCount: null,
      }), expect.anything());
    } finally {
      log.mockRestore();
    }
  });

  test('.js importer는 .tsx 변경의 관례 밖 테스트로 실행한다', async () => {
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'tsx-importer.test.ts'), "import '../src/view.js';\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'tsx importer');
    const opts = await gate({ 'src/view.tsx': 'export const View = () => null;' });
    expect(opts.steps).toBeUndefined();
    expect(opts.testArgs).toEqual(['test/tsx-importer.test.ts']);
    expect(result).toMatchObject({
      scopeReason: 'derived',
      importerTestsNotRun: { total: 0, files: [], truncated: false },
    });
  });

  test('.js importer는 .jsx 변경의 관례 밖 테스트로도 관측한다', async () => {
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'jsx-importer.test.ts'), "import '../src/widget.js';\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'jsx importer');
    const opts = await gate({ 'src/widget.jsx': 'export const Widget = () => null;' });
    expect(opts.testArgs).toEqual(['test/jsx-importer.test.ts']);
    expect(result).toMatchObject({
      importerTestsNotRun: { total: 0, files: [], truncated: false },
    });
  });

  test("no-related-tests와 gateSteps:['test'] 조합은 steps:[]로 test 실행을 막는다", async () => {
    const opts = await gate({ 'src/x.ts': 'export const x = 1;' }, ['test']);
    expect(opts.steps).toEqual([]);
    expect(opts.testArgs).toBeUndefined();
  });

  test('docs-only 스킵은 caller gateSteps 목록을 기준으로 한다', async () => {
    const opts = await gate({ 'docs/A.md': 'a' }, ['test', 'typecheck', 'cli-smoke']);
    expect(opts.steps).toEqual(['typecheck', 'cli-smoke']);
  });

  test('docs-only에서 test 제거 결과가 비어도 steps:[]를 보존한다', async () => {
    const opts = await gate({ 'docs/A.md': 'a' }, ['test']);
    expect(opts.steps).toEqual([]);
    expect(opts.testArgs).toBeUndefined();
  });
});

describe('defaultSeams.gate — gate baseline 변동성 및 재실행 facts 전파', () => {
  test('gate.baseline events always include timeoutPassedAtBase for introduced and zero reports', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seam-gate-baseline-timeout-passed-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t.co');
      git(repo, 'config', 'user.name', 'T');
      mkdirSync(join(repo, 'test'), { recursive: true });
      writeFileSync(join(repo, 'test', 'a.test.js'), 'changed');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'base');
      writeFileSync(join(repo, 'test', 'a.test.js'), 'changed again');
      const timeoutOutput = ['test/a.test.js:', '(fail) t1', '^ this test timed out after 5000ms.', '', '1 fail'].join('\n');
      const introducedGate = await defaultSeams({
        runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test', ok: false, skipped: false, summary: 'failed', output: timeoutOutput }], log: '[test] FAIL' }),
        runGateBaseline: () => ({ status: 'pass', output: ['test/a.test.js:', '(pass) t1', '', '1 pass'].join('\n'), log: 'base passed' }),
        rerunBunTimeoutFailures: () => new Map([['test/a.test.js > t1', ['pass']]]),
      }).gate(repo);
      expect(introducedGate.reflectGateFacts).toMatchObject({ introduced: 1, timeoutPassedAtBase: 1 });
      const introduced = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown>;
      expect(introduced).toMatchObject({ introduced: 1, timeoutPassedAtBase: 1 });

      log.mockClear();
      const zeroGate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'passed' }], log: '[test] PASS' }),
      }).gate(repo);
      expect(zeroGate.reflectGateFacts).not.toHaveProperty('timeoutPassedAtBase');
      const zero = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown>;
      expect(zero).toMatchObject({ timeoutPassedAtBase: 0 });
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test('실행 경로에서 0이 아닌 변동성 및 재실행 facts만 reflectGateFacts에 싣는다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seam-gate-baseline-facts-'));
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t.co');
      git(repo, 'config', 'user.name', 'T');
      mkdirSync(join(repo, 'test'), { recursive: true });
      writeFileSync(join(repo, 'test', 'a.test.js'), 'changed');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'base');
      writeFileSync(join(repo, 'test', 'a.test.js'), 'changed again');
      const output = [
        'test/a.test.js:',
        '(pass) intermittent assertion',
        '(fail) intermittent assertion',
        'error: expect(received).toBe(expected)',
        '',
        '1 pass',
        '1 fail',
      ].join('\n');
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test', ok: false, skipped: false, summary: 'failed', output }], log: '[test] FAIL' }),
        runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
        rerunBunTimeoutFailures: () => new Map(),
      }).gate(repo);

      expect(gate.reflectGateFacts).toMatchObject({ mayVaryNonTimeout: 1 });
      expect(gate.reflectGateFacts).not.toHaveProperty('rerunAttempted');
      expect(gate.reflectGateFacts).not.toHaveProperty('rerunRecovered');

      const timeoutOutput = [
        'test/a.test.js:',
        '(fail) recovered timeout',
        '^ this test timed out after 5000ms.',
        '',
        '1 fail',
      ].join('\n');
      const rerunGate = await defaultSeams({
        runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test', ok: false, skipped: false, summary: 'failed', output: timeoutOutput }], log: '[test] FAIL' }),
        runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
        rerunBunTimeoutFailures: () => new Map([['test/a.test.js > recovered timeout', ['pass'] as const]]),
      }).gate(repo);

      expect(rerunGate.reflectGateFacts).toMatchObject({ rerunAttempted: 1, rerunRecovered: 1 });
      expect(rerunGate.reflectGateFacts).not.toHaveProperty('mayVaryNonTimeout');
      expect(rerunGate.reflectGateFacts).not.toHaveProperty('flakyRerun');

      const introducedOutput = [
        'test/a.test.js:',
        '(fail) layout holds',
        'error: Expected layout to hold',
        '',
        '1 fail',
      ].join('\n');
      const flakyGate = await defaultSeams({
        runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test', ok: false, skipped: false, summary: 'failed', output: introducedOutput }], log: '[test] FAIL' }),
        runGateBaseline: () => ({ status: 'pass', output: 'test/a.test.js:\n(pass) layout holds\n0 fail', log: 'base clean' }),
        rerunBunTimeoutFailures: () => ({ observations: new Map([['test/a.test.js > layout holds', ['pass'] as const]]), rerunNotRun: 2 }),
      }).gate(repo);
      expect(flakyGate.reflectGateFacts).toMatchObject({ introduced: 0, timedOut: 0, flakyRerun: 1, rerunNotRun: 2 });
      expect(flakyGate.passed).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams — postsync merge-base 재게이트', () => {
  let repo: string;
  let captured: { steps?: GateStepName[]; testArgs?: string[] } | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-postsync-gate-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  function seamsFor(runIntegrityGate?: DefaultSeamsOptions['runIntegrityGate']) {
    return defaultSeams({
      runIntegrityGate: runIntegrityGate ?? ((_cwd, opts) => {
        captured = opts;
        return {
          passed: true,
          steps: opts.steps?.includes('test') === false
            ? []
            : [{ name: 'test', ok: true, skipped: false, summary: 'test passed' }],
          log: '',
        } satisfies GateResult;
      }),
    });
  }

  test('일반 게이트는 커밋된 변경이 있어도 worktree-only라 no-changes다', async () => {
    git(repo, 'checkout', '-b', 'feature/worktree-only');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'committed.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'committed change');
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');
    const result = await seamsFor().gate(repo);
    expect(result).toMatchObject({
      passed: true,
      scopeReason: 'no-changes',
      measuredFileCount: 0,
    });
  });

  test('postsync는 작업 트리가 비어도 merge-base 변경 파일을 실행 범위로 잰다', async () => {
    git(repo, 'checkout', '-b', 'feature/postsync-scope');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'committed.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src', 'committed.test.ts'), 'import { x } from "./committed.ts";\nif (x !== 1) throw new Error("x");\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'committed change');
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');
    const result = await seamsFor().gate(repo, { mode: 'postsync' });
    expect(captured?.testArgs).toEqual(['src/committed.test.ts']);
    expect(result.scopeReason).toBe('changed-tests');
    expect(result.measuredFileCount).toBe(2);
    expect(result.comparisonBase).toMatch(/^[0-9a-f]{7,64}$/);
  });

  test('postsync 빈 범위는 깨끗함이 아니라 측정 불가라 passed:true를 내지 않는다', async () => {
    const result = await seamsFor().gate(repo, { mode: 'postsync' });
    expect(captured?.steps).not.toContain('test');
    expect(result).toMatchObject({
      passed: false,
      testStepExecuted: false,
      scopeReason: 'unmeasured',
      measuredFileCount: 0,
    });
    expect(result.comparisonBase).toMatch(/^[0-9a-f]{7,64}$/);
    expect(result.log).toContain('못 쟀다');
  });

  test('tsc가 빨강인 통합 트리에서 postsync 재게이트는 passed:false를 낸다', async () => {
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext' },
      include: ['src/**/*.ts'],
    }));
    writeFileSync(join(repo, 'tsconfig.gate.json'), JSON.stringify({ extends: './tsconfig.json' }));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const ok = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'typecheck config');

    git(repo, 'checkout', '-b', 'feature/green');
    writeFileSync(join(repo, 'src', 'child.ts'), 'export const child: number = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'child green');

    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const ok = "red";\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main type change');
    git(repo, 'checkout', 'feature/green');
    writeFileSync(join(repo, 'src', 'child.ts'), 'import { ok } from "./ok.ts";\nexport const child: number = ok;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'child uses ok');
    git(repo, 'merge', '--no-edit', 'main');
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');

    const worktreeOnly = await seamsFor().gate(repo);
    expect(worktreeOnly.passed).toBe(true);
    expect(worktreeOnly.scopeReason).toBe('no-changes');

    const result = await seamsFor().gate(repo, { mode: 'postsync' });
    expect(result.passed).toBe(false);
    expect(result.measuredFileCount).toBeGreaterThan(0);
    expect(result.comparisonBase).toMatch(/^[0-9a-f]{7,64}$/);
    expect(result.log).toMatch(/child\.ts|ok\.ts|TS2322|red/);
  });
});

describe('defaultSeams — changed test declaration observation', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'seam-test-declaration-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'changed.test.js'), "test('one', () => {});\ntest('two', () => {});\ntest('three', () => {});\ntest('four', () => {});\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base tests');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  async function gate(capture?: (opts: { steps?: GateStepName[]; testArgs?: string[] }) => void) {
    return defaultSeams({
      runIntegrityGate: (_cwd, opts) => {
        capture?.(opts);
        return {
          passed: true,
          steps: [{ name: 'test', ok: true, skipped: false, summary: 'test passed' }],
          log: '',
        } satisfies GateResult;
      },
    }).gate(repo);
  }

  test('남은 파일에서 사라진 테스트 선언 수를 관측하지만 gate는 통과시킨다', async () => {
    writeFileSync(join(repo, 'src', 'changed.test.js'), "test('one', () => {});\n");
    await expect(gate()).resolves.toMatchObject({ passed: true, testDeclarationDecline: 3 });
  });

  test('선언 수가 줄지 않으면 0을 남겨 감소와 구분한다', async () => {
    writeFileSync(join(repo, 'src', 'changed.test.js'), "test('one renamed', () => {});\ntest('two', () => {});\ntest('three', () => {});\ntest('four', () => {});\n");
    await expect(gate()).resolves.toMatchObject({ passed: true, testDeclarationDecline: 0 });
  });

  test('self-commit 뒤 clean worktree에서도 선언 감소를 남기고 커밋된 시험을 실행한다', async () => {
    git(repo, 'checkout', '-b', 'self-commit');
    writeFileSync(join(repo, 'src', 'changed.test.js'), "test('one', () => {});\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'remove declarations');
    expect(git(repo, 'status', '--porcelain').stdout).toBe('');
    let captured: { steps?: GateStepName[]; testArgs?: string[] } | undefined;
    await expect(gate((opts) => { captured = opts; })).resolves.toMatchObject({ passed: true, testDeclarationDecline: 3 });
    expect(captured?.testArgs).toEqual(['src/changed.test.js']);
  });

  test('base에 없는 변경 테스트 파일은 0을 꾸며내지 않고 null을 남긴다', async () => {
    writeFileSync(join(repo, 'src', 'new.test.js'), "test('new', () => {});\n");
    await expect(gate()).resolves.toMatchObject({ passed: true, testDeclarationDecline: null });
  });
});

describe('createSelfImplementControlBrain — 완료 보고 프롬프트 격리', () => {
  test('self-implement brain에만 완료 보고 보존 hint를 주입하고 범용 기본 프롬프트는 바꾸지 않는다', async () => {
    let selfImplementSystem = '';
    const brain = createSelfImplementControlBrain({
      goal: '테스트 목표',
      stream: async (messages) => {
        selfImplementSystem = String(messages[0]?.content);
        return '{\"action\":\"wait\"}';
      },
    });
    await brain.decide({ screen: '작업 중', state: 'working' as never, step: 1, intervention: undefined as never, changed: true });

    let genericSystem = '';
    const genericBrain = createLlmControlBrain({
      goal: '테스트 목표',
      stream: async (messages) => {
        genericSystem = String(messages[0]?.content);
        return '{\"action\":\"wait\"}';
      },
    });
    await genericBrain.decide({ screen: '작업 중', state: 'working' as never, step: 1, intervention: undefined as never, changed: true });

    expect(selfImplementSystem).toContain(SELF_IMPLEMENT_COMPLETION_REPORT_HINT);
    expect(genericSystem).not.toContain(SELF_IMPLEMENT_COMPLETION_REPORT_HINT);
    expect(genericSystem).toBe(`너는 PTY 로 열린 자식 프로그램/에이전트를 **화면만 보고** 구동하는 컨트롤러다.
목표: 테스트 목표
화면을 보고 **다음 행동 하나**를 JSON 으로 결정하라:
- "input": 자식이 입력을 기다리면(프롬프트/선택/blocked) 다음 입력 text(개행 필요 시 \\r 포함).
- "key": 특수키 name(enter/esc/tab/up/down/left/right 등), 선택 repeat(1~100).
- "mouse": 마우스가 켜진 TUI 에 1부터 세는 x,y 와 kind(click/scroll-up/scroll-down), 선택 button(left/middle/right). 모드가 꺼져 있으면 거절되며 다음 관측의 직전 행동 불가 이유를 보고 다른 행동을 택하라.
- "resize": 양의 정수 cols, rows 로 화면 크기 변경.
- "wait": 자식이 아직 작업 중(working)이면 대기.
- "done": 목표를 달성했으면 reason.
- "handoff": 같은 미션의 다른 담당자에게 넘길 때 to(codex/claude/elanous), mission(다음 작업), carry(diff/summary 선택). elanous 는 증거 게이트와 PR.
- "ask-human": 화면에 로그인 URL/장치 코드가 보일 때 reason, url/code(화면에 보이는 것만). 자격 파일/토큰은 읽지 마라.
화면 분류(참고 신호): working.
JSON 만 출력. 행동을 고른 화면 근거 한 줄을 reason 으로 반드시 담아라. 예: {"action":"key","name":"enter","reason":"메뉴 선택"} / {"action":"mouse","x":10,"y":5,"kind":"click","button":"left","reason":"버튼 누름"} / {"action":"resize","cols":80,"rows":24,"reason":"화면 맞춤"}. input 은 text, done 는 reason 을 싣는다.`);
  });
});

describe('defaultSeams — LLM clarification relay wiring', () => {
  test('reuses the existing relay for clarification answers and preserves agent provenance', async () => {
    const seams = defaultSeams({ llmReview: async () => '{"mode":"safe"}' });
    const dispatched = await seams.escalateGoalClarifications!({
      questions: [{
        id: 'mode', header: 'Mode', question: 'Which mode?',
        options: [{ label: 'safe', description: 'Safe' }, { label: 'fast', description: 'Fast' }],
      }],
    });
    expect(dispatched.result).toEqual({ answers: { mode: 'safe' }, answeredBy: 'agent' });
  });

  test('falls back to the existing human resolver when the relay cannot answer and records question IDs', async () => {
    const prior = getAskUserQuestionResolver();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    setAskUserQuestionResolver(async () => ({ answers: { mode: 'human' }, answeredBy: 'human' }));
    try {
      const seams = defaultSeams({ llmReview: async () => 'not JSON' });
      const dispatched = await seams.escalateGoalClarifications!({
        questions: [{
          id: 'mode', header: 'Mode', question: 'Which mode?',
          options: [{ label: 'human', description: 'Human' }, { label: 'safe', description: 'Safe' }],
        }],
      });
      expect(dispatched.result).toEqual({ answers: { mode: 'human' }, answeredBy: 'human' });
      expect(log).toHaveBeenCalledWith('self-implement', 'clarification-relay-fell-through', { reason: 'relay-no-answer', questionIds: ['mode'] });
    } finally {
      log.mockRestore();
      setAskUserQuestionResolver(prior);
    }
  });

  test('falls back to the human resolver for a parseable relay response without agent provenance', async () => {
    const prior = getAskUserQuestionResolver();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let humanCalls = 0;
    setAskUserQuestionResolver(async () => {
      humanCalls++;
      return { answers: { mode: 'human' }, answeredBy: 'human' };
    });
    try {
      const seams = defaultSeams({ llmReview: async () => '{"mode":"unknown"}' });
      const dispatched = await seams.escalateGoalClarifications!({
        questions: [{
          id: 'mode', header: 'Mode', question: 'Which mode?',
          options: [{ label: 'safe', description: 'Safe' }, { label: 'human', description: 'Human' }],
        }],
      });
      expect(humanCalls).toBe(1);
      expect(dispatched.result).toEqual({ answers: { mode: 'human' }, answeredBy: 'human' });
      expect(dispatched.result).not.toHaveProperty('answeredBy', 'agent');
      expect(log).toHaveBeenCalledWith('self-implement', 'clarification-relay-fell-through', { reason: 'relay-not-agent', questionIds: ['mode'] });
    } finally {
      log.mockRestore();
      setAskUserQuestionResolver(prior);
    }
  });

  test('routes side-effect clarification through the relay fail-closed confirm before human fallback', async () => {
    const prior = getAskUserQuestionResolver();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let asked = false;
    let humanCalls = 0;
    setAskUserQuestionResolver(async () => {
      humanCalls++;
      return { answers: { approval: 'human' }, answeredBy: 'human' };
    });
    try {
      const seams = defaultSeams({
        llmReview: async () => { asked = true; return '{"approval":"approve"}'; },
      });
      const dispatched = await seams.escalateGoalClarifications!({
        questions: [{
          id: 'approval', header: 'Approval', question: '실제 파일에 apply 할까요?',
          options: [{ label: 'approve', description: 'Approve' }, { label: 'human', description: 'Human' }],
        }],
      });
      expect(asked).toBe(false);
      expect(humanCalls).toBe(1);
      expect(dispatched.result).toEqual({ answers: { approval: 'human' }, answeredBy: 'human' });
      expect(log).toHaveBeenCalledWith('self-implement', 'clarification-relay-fell-through', { reason: 'side-effect-declined', questionIds: ['approval'] });
    } finally {
      log.mockRestore();
      setAskUserQuestionResolver(prior);
    }
  });

  test('routes a neutral question with a side-effect option label to the human resolver', async () => {
    const prior = getAskUserQuestionResolver();
    let asked = false;
    let humanCalls = 0;
    setAskUserQuestionResolver(async () => {
      humanCalls++;
      return { answers: { action: 'human' }, answeredBy: 'human' };
    });
    try {
      const seams = defaultSeams({
        llmReview: async () => { asked = true; return '{"action":"continue"}'; },
      });
      const dispatched = await seams.escalateGoalClarifications!({
        questions: [{
          id: 'action', header: 'Action', question: 'Which review path should continue?',
          options: [
            { label: 'merge now', description: 'Keep the current review scope.' },
            { label: 'continue', description: 'Continue the current review.' },
          ],
        }],
      });
      expect(asked).toBe(false);
      expect(humanCalls).toBe(1);
      expect(dispatched.result).toEqual({ answers: { action: 'human' }, answeredBy: 'human' });
    } finally {
      setAskUserQuestionResolver(prior);
    }
  });

  test('routes a neutral question with a side-effect option description to the human resolver', async () => {
    const prior = getAskUserQuestionResolver();
    let asked = false;
    let humanCalls = 0;
    setAskUserQuestionResolver(async () => {
      humanCalls++;
      return { answers: { action: 'human' }, answeredBy: 'human' };
    });
    try {
      const seams = defaultSeams({
        llmReview: async () => { asked = true; return '{"action":"continue"}'; },
      });
      const dispatched = await seams.escalateGoalClarifications!({
        questions: [{
          id: 'action', header: 'Action', question: 'Which review path should continue?',
          options: [
            { label: 'review now', description: 'Deploy the reviewed change.' },
            { label: 'continue', description: 'Continue the current review.' },
          ],
        }],
      });
      expect(asked).toBe(false);
      expect(humanCalls).toBe(1);
      expect(dispatched.result).toEqual({ answers: { action: 'human' }, answeredBy: 'human' });
    } finally {
      setAskUserQuestionResolver(prior);
    }
  });

  test('records an unparsed clarification request immediately before preserving dispatch fallback', async () => {
    const prior = getAskUserQuestionResolver();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    setAskUserQuestionResolver(async () => ({ answers: {}, cancelled: true }));
    try {
      const seams = defaultSeams({ llmReview: async () => 'unused' });
      const dispatched = await seams.escalateGoalClarifications!({ questions: 'malformed' });
      expect(dispatched.output).toContain('AskUserQuestion failed: questions must be a non-empty array');
      expect(log).toHaveBeenCalledWith('self-implement', 'clarification-relay-fell-through', { reason: 'request-unparsed', questionIds: [] });
    } finally {
      log.mockRestore();
      setAskUserQuestionResolver(prior);
    }
  });

  test('leaves the clarification dispatch seam empty and records builder failure for the existing human fallback', () => {
    const originalLog = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const seams = defaultSeams({
        llmReview: async () => 'unused',
        buildLlmHitlRelay: () => { throw new Error('LLM relay unavailable'); },
      });
      expect(seams.escalateGoalClarifications).toBeUndefined();
      expect(events).toEqual([expect.objectContaining({
        event: 'clarification-relay-unavailable',
        data: expect.objectContaining({ error: 'LLM relay unavailable' }),
      })]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('defaultSeams — child LLM driver wiring', () => {
  test('forwards an explicit child LLM to the PTY driver alongside escalation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-child-llm-'));
    let received: { childLlm?: { provider: string; model: string }; escalateTier?: string } | undefined;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          received = opts;
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' };
        },
      });
      await seams.implement({
        cwd, feature: 'child LLM forwarding', runId: 'run-child-llm', escalateTier: 'sol',
        childLlm: { provider: 'openai', model: 'gpt-5', source: 'flag' },
      });
      expect(received).toMatchObject({
        childLlm: { provider: 'openai', model: 'gpt-5', source: 'flag' },
        escalateTier: 'sol',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('omits child LLM while preserving the existing escalation path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-default-child-llm-'));
    let received: { childLlm?: unknown; escalateTier?: string } | undefined;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          received = opts;
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' };
        },
      });
      await seams.implement({ cwd, feature: 'default child LLM forwarding', runId: 'run-default-child-llm', escalateTier: 'sol' });
      expect(received).toMatchObject({ escalateTier: 'sol' });
      expect(received).not.toHaveProperty('childLlm');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams — activity grace driver wiring', () => {
  test('caller activity grace reaches headless driver options with caller source', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-activity-grace-'));
    let received: { activityGraceSec?: number; activityGraceSource?: string } | undefined;
    try {
      const seams = defaultSeams({
        implementActivityGraceSec: 600,
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          received = opts;
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' };
        },
      });
      await seams.implement({ cwd, feature: 'activity grace forwarding', runId: 'run-activity-grace' });
      expect(received).toMatchObject({ activityGraceSec: 600, activityGraceSource: 'caller' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams — in-round judge context wiring', () => {
  test('validated REFUTE reaches the production supervisor prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-refute-'));
    let prompt = '';
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'f.ts'), 'export const a = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const seams = defaultSeams({
        llmReview: async (value: string) => { prompt = value; return '1: ACCEPT'; },
      });
      await seams.reflectMustFix!({
        mustFix: ['모든 잠금을 막아라'],
        goal: '## SCOPE BOUNDARY\n- ⛔ 결정 1: 살아 있는 잠금을 막지 않는다.',
        cwd,
        refutations: [{
          findingId: 'MF-12345678',
          finding: '모든 잠금을 막아라',
          quote: '- ⛔ 결정 1: 살아 있는 잠금을 막지 않는다.',
          kind: 'preservation-contract',
          reason: '골의 보존 결정과 충돌한다.',
        }],
      });
      expect(prompt).toContain('## 자식의 REFUTE 회부 (자동 수용 금지)');
      expect(prompt).toContain('[MF-12345678] 모든 잠금을 막아라');
      expect(prompt).toContain('반드시 네가 ACCEPT 또는 REJECT로 독립 판정하라');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('recurrence history reaches the reflect prompt unchanged', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-recurrence-history-'));
    let prompt = '';
    try {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.email', 't@t.co');
      git(cwd, 'config', 'user.name', 'T');
      writeFileSync(join(cwd, 'f.ts'), 'export const a = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-m', 'base');
      git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const seams = defaultSeams({ llmReview: async (value: string) => { prompt = value; return '1: ACCEPT'; } });
      const finding = '반복 `src/example.ts` 지적';
      await seams.reflectMustFix!({
        mustFix: [finding], goal: 'goal', cwd,
        recurrenceHistory: [{ findingId: stableMustFixId(finding), occurrence: 2, observedRounds: [0, 1, 2] }],
      });
      expect(prompt).toContain('## must-fix별 반복 이력');
      expect(prompt).toContain('occurrence=2, observedRounds=[0,1,2]');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('optional rework context is forwarded to the PTY driver unchanged', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-round-context-'));
    let received: Record<string, unknown> | undefined;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (opts) => {
          received = opts.roundContext as unknown as Record<string, unknown>;
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test' };
        },
      });
      await seams.implement({
        cwd, feature: 'round context forwarding', runId: 'run-test',
        roundContext: { round: 2, effectiveMax: 4, previousRoundFailure: 'gate failed' },
      });
      expect(received).toEqual({ round: 2, effectiveMax: 4, previousRoundFailure: 'gate failed' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ⭐⭐ 리뷰 must-fix(#5925): 채널 배선 뮤테이션 가드가 없었다 — `defaultSeams.reviewDiff` 의
// `diffOutsideClaims` 전달 한 줄을 지워도 테스트가 전부 통과했다. **리뷰 프롬프트까지** 이어서 잰다.
describe('defaultSeams.reviewDiff — reviewer context와 diff 밖 이행 주장이 리뷰 프롬프트까지 간다', () => {
  test('CLI가 적재한 file/text reviewer context를 순서·라벨 그대로 리뷰어와 review.done 관측에 전달한다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-reviewer-context-'));
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'review.done') events.push(data ?? {});
    }) as never);
    let prompt = '';
    try {
      writeFileSync(join(repo, 'f.ts'), 'export const a = 1;\n');
      const seams = defaultSeams({
        llmReview: async (value: string) => { prompt = value; return 'VERDICT: PASS'; },
        reviewerContext: [
          { label: 'README.md', body: 'file premise' },
          { label: 'inline context 2', body: 'text premise' },
        ],
      });
      await seams.reviewDiff!(repo, { goal: 'review context delivery' });
      expect(prompt.indexOf('README.md')).toBeLessThan(prompt.indexOf('inline context 2'));
      expect(prompt).toContain('file premise');
      expect(prompt).toContain('text premise');
      expect(events).toEqual([expect.objectContaining({ reviewerContextLoaded: 2 })]);
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reviewer context가 없으면 ReviewInput에 없는 기존 호출 형태를 유지한다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-reviewer-context-absent-'));
    let prompt = '';
    try {
      writeFileSync(join(repo, 'f.ts'), 'export const a = 1;\n');
      const seams = defaultSeams({ llmReview: async (value: string) => { prompt = value; return 'VERDICT: PASS'; } });
      await seams.reviewDiff!(repo, { goal: 'no reviewer context' });
      expect(prompt).not.toContain('Reviewer context');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('⭐ ctx 의 diffOutsideClaims 가 리뷰 intent 블록으로 나타난다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-claims-'));
    try {
      writeFileSync(join(repo, 'f.ts'), 'export const a = 1;\n');
      let seenIntent = '';
      const seams = defaultSeams({
        llmReview: async (prompt: string) => { seenIntent = prompt; return 'VERDICT: PASS'; },
      });
      await seams.reviewDiff!(repo, {
        goal: '## 목표\n증거 채널',
        round: 1,
        diffOutsideClaims: [{ claim: '라이브에서 확인했다', verify: 'elanous logs --category dev-pipeline' }],
      });
      expect(seenIntent).toContain('자식이 주장하는 diff 밖 이행');
      expect(seenIntent).toContain('- 주장: 라이브에서 확인했다');
      expect(seenIntent).toContain('verify: elanous logs --category dev-pipeline');
      // ⛔ 주장만으로 must-fix 를 해제하지 말라는 지침이 함께 가야 한다.
      expect(seenIntent).toContain('must-fix 를 해제하지 마라');
      await seams.reviewDiff!(repo, {
        goal: '## 목표\n게이트 증빙',
        gateEvidenceNote: '## Gate execution evidence\nRan 6 tests across 1 file\n0 fail',
        shardSiblings: { items: [{ runId: 'run-sibling', shardId: 'shard-a', pieceIndex: 1 }], shownItems: 1, totalItems: 1, omittedItems: 0, truncated: false },
      });
      expect(seenIntent).toContain('게이트 실행 증거 메모');
      expect(seenIntent).toContain('## Gate execution evidence');
      expect(seenIntent).toContain('Ran 6 tests across 1 file');
      expect(seenIntent).toContain('같은 골의 형제 shard');
      expect(seenIntent).toContain('run-sibling (shard-a #1)');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams.reviewDiff — review.done 라운드 관측', () => {
  // Fake bin: none; invoked command: git (only the unmocked noDiffResult uses real reviewScopeDiff).
  test('완료·변경 없음 결과에는 전달된 라운드를 싣고, 없는 라운드 키는 만들지 않는다', async () => {
    const changedRepo = mkdtempSync(join(tmpdir(), 'seams-review-round-changed-'));
    const noDiffRepo = mkdtempSync(join(tmpdir(), 'seams-review-round-no-diff-'));
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review.done') events.push(data ?? {});
    }) as never);
    try {
      writeFileSync(join(changedRepo, 'f.ts'), 'export const a = 1;\n');
      const seams = defaultSeams({
        llmReview: async () => 'VERDICT: PASS',
        reviewScopeDiff: async (cwd) => cwd === noDiffRepo ? '' : '+changed',
      });
      await seams.reviewDiff!(changedRepo, { goal: 'round present', round: 2 });
      await seams.reviewDiff!(changedRepo, { goal: 'round absent' });
      await seams.reviewDiff!(noDiffRepo, { goal: 'no diff round', round: 3 });
    } finally {
      log.mockRestore();
      rmSync(changedRepo, { recursive: true, force: true });
      rmSync(noDiffRepo, { recursive: true, force: true });
    }
    expect(events).toContainEqual(expect.objectContaining({
      verdict: 'pass', reviewed: true, mustFix: 0, shouldFix: 0, round: 2,
    }));
    const roundAbsent = events.find((event) => event.reviewed === true && event.round === undefined);
    expect(roundAbsent).toBeDefined();
    expect(roundAbsent).not.toHaveProperty('round');
    expect(events).toContainEqual(expect.objectContaining({
      verdict: 'pass', reviewed: false, reason: 'no-diff', round: 3,
    }));
    const noDiffResult = await defaultSeams({ llmReview: async () => 'unused' }).reviewDiff!(noDiffRepo);
    expect(noDiffResult).toMatchObject({ verdict: 'pass', reviewed: false, failureReason: 'no-diff' });
  });
});

describe('defaultSeams.reviewDiff — 측정 불가와 진짜 빈 diff', () => {
  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('merge-base 를 구했는데 diff 가 비면 여전히 no-diff 다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-review-true-empty-'));
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t.co');
      git(repo, 'config', 'user.name', 'T');
      writeFileSync(join(repo, 'README.md'), 'base\\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '--allow-empty', '-m', 'base-empty');
      const result = await defaultSeams({ llmReview: async () => 'unused' }).reviewDiff!(repo);
      expect(result).toMatchObject({ verdict: 'pass', reviewed: false, failureReason: 'no-diff' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Fake bin: none; invoked command: git (fixture via spawnSync, review via execFile/spawnSync).
  test('어느 기준으로도 범위를 못 재고 작업 트리가 깨끗하면 pass 도 no-diff 도 아니다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-review-unmeasurable-'));
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review.done') events.push(data ?? {});
    }) as never);
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t.co');
      git(repo, 'config', 'user.name', 'T');
      writeFileSync(join(repo, 'README.md'), 'root\\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '--allow-empty', '-m', 'root-unmeasurable');
      git(repo, 'checkout', '--orphan', 'orphan');
      git(repo, 'commit', '--allow-empty', '-m', 'orphan root');
      const result = await defaultSeams({ llmReview: async () => 'unused' }).reviewDiff!(repo);
      expect(result.verdict).not.toBe('pass');
      expect(result.failureReason).not.toBe('no-diff');
      expect(result).toMatchObject({ reviewed: false, failureReason: 'unmeasurable-scope', verdict: 'fail' });
      expect(events).toContainEqual(expect.objectContaining({
        verdict: 'fail', reviewed: false, reason: 'unmeasurable-scope',
      }));
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams.reviewDiff — reviewerCanSelfRead 선언', () => {
  test('선언하지 않으면 canSelfRead 칸을 만들지 않고 llmReview 시그니처는 그대로다', async () => {
    const llmReview = async (prompt: string): Promise<string> => {
      expect(typeof prompt).toBe('string');
      return 'VERDICT: PASS';
    };
    const seams = defaultSeams({
      llmReview,
      reviewScopeDiff: async () => '+changed',
    });
    const review = await seams.reviewDiff!('/tmp/undeclared-capability');
    expect(Object.prototype.hasOwnProperty.call(review, 'canSelfRead')).toBe(false);
    expect(review).toMatchObject({ verdict: 'pass', reviewed: true, mustFix: [], shouldFix: [] });
  });

  test('스스로 읽을 수 있다고 선언하면 reviewDiff 가 그 boolean 을 그대로 싣는다', async () => {
    const seams = defaultSeams({
      llmReview: async () => 'VERDICT: PASS',
      reviewScopeDiff: async () => '+changed',
      reviewerCanSelfRead: true,
    });
    const review = await seams.reviewDiff!('/tmp/can-self-read');
    expect(review.canSelfRead).toBe(true);
  });

  test('스스로 읽을 수 없다고 선언하면 false 를 싣고 미선언과 구분한다', async () => {
    const declared = defaultSeams({
      llmReview: async () => 'VERDICT: PASS',
      reviewScopeDiff: async () => '+changed',
      reviewerCanSelfRead: false,
    });
    const undeclared = defaultSeams({
      llmReview: async () => 'VERDICT: PASS',
      reviewScopeDiff: async () => '+changed',
    });
    const no = await declared.reviewDiff!('/tmp/cannot-self-read');
    const unknown = await undeclared.reviewDiff!('/tmp/undeclared-self-read');
    expect(no.canSelfRead).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(unknown, 'canSelfRead')).toBe(false);
  });
});

describe('defaultSeams.diagnose — 골 요약 누락 관측', () => {
  async function diagnose(goal: string, logImplementation?: () => void) {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') {
        logImplementation?.();
        events.push(data ?? {});
      }
    }) as never);
    try {
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      const result = await seams.diagnose!({ runId: 'run-goal-summary', note: 'gate failed', kind: 'gate', round: 2, cwd: '/unused', goal, history: [], effectiveMax: 3 });
      return { events, prompt, result };
    } finally {
      log.mockRestore();
    }
  }

  test('잘린 요약의 본문은 그대로 감독에게 보내고, 못 본 절·노이즈·길이를 완료 관측에 남긴다', async () => {
    const goal = [
      '## ACCEPTANCE CRITERIA\n' + 'a'.repeat(1_600),
      '## RULES\n' + 'b'.repeat(1_600),
      '## 스코프 경계\n' + 'c'.repeat(1_600),
      '## 배경\n- Candidate requiring path tracing: ignored\n' + 'd'.repeat(1_600),
    ].join('\n\n');
    const digest = supervisorGoalDigest(goal, 3000);
    const { events, prompt, result } = await diagnose(goal);

    expect(result).toBe('BUDGET: EXTEND\nREASON: narrowed');
    expect(prompt).toContain(`골(수용기준·스코프 경계):\n${digest.text}\n라운드 이력`);
    expect(events).toEqual([expect.objectContaining({
      runId: 'run-goal-summary', kind: 'gate', round: 2, chars: result.length,
      goalChars: goal.length, digestChars: digest.text.length,
      droppedSections: digest.droppedSections, droppedNoiseLines: digest.droppedNoiseLines,
    })]);
    expect(digest.droppedSections.length + digest.droppedNoiseLines).toBeGreaterThan(0);
  });

  test('전부 담긴 요약도 빈 누락값을 남기며, 완료 관측이 실패해도 진단은 성공한다', async () => {
    const goal = '## ACCEPTANCE CRITERIA\n짧은 골';
    const { events, prompt, result } = await diagnose(goal, () => { throw new Error('log unavailable'); });

    expect(result).toBe('BUDGET: EXTEND\nREASON: narrowed');
    expect(prompt).toContain(`골(수용기준·스코프 경계):\n${supervisorGoalDigest(goal, 3000).text}\n라운드 이력`);
    expect(events).toEqual([]);
    expect(supervisorGoalDigest(goal, 3000)).toMatchObject({ droppedSections: [], droppedNoiseLines: 0 });
  });

  test('제출된 REFUTE를 감독 프롬프트에 원문·근거·종류로 싣고 완료 관측에 예산을 남긴다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: SUFFICIENT\nREASON: accepted'; } });
      await seams.diagnose!({
        runId: 'run-refute-prompt', note: 'review failed', kind: 'review', round: 2, cwd: '/unused', goal: 'goal', history: [], effectiveMax: 3, refutationRound: 1,
        refutations: [{ findingId: 'MF-deadbeef', finding: '기존 경로를 바꿔라', quote: '- Checkable preservation criterion: 기존 경로를 유지한다.', kind: 'preservation-contract', reason: '현장 구현과 충돌한다.' }],
      });
      expect(prompt).toContain('자식 REFUTE 제출(라운드 1; 아래 현장 불일치를 재판정에 사용):');
      expect(prompt).toContain('must-fix 원문: 기존 경로를 바꿔라');
      expect(prompt).toContain('인용: - Checkable preservation criterion: 기존 경로를 유지한다.');
      expect(prompt).toContain('REFUTE [findingId]: ACCEPT');
      expect(prompt).toContain('근거: 현장 구현과 충돌한다.');
      expect(prompt).toContain('[preservation-contract]');
      expect(events).toEqual([expect.objectContaining({ runId: 'run-refute-prompt', refutationPromptOriginalItems: 1, refutationPromptIncludedItems: 1, refutationPromptTruncated: false })]);
    } finally {
      log.mockRestore();
    }
  });

  test('REFUTE 섹션은 실제 라벨·구분자까지 포함해 3000자 이내이며 마지막 항목을 같은 형식으로 자른다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const refutations = [
        { findingId: 'MF-00000001', finding: 'A'.repeat(500), quote: '- Checkable preservation criterion: ' + 'Q'.repeat(950), kind: 'preservation-contract' as const, reason: 'R'.repeat(500) },
        { findingId: 'MF-00000002', finding: 'B'.repeat(500), quote: '- Checkable requested criterion: ' + 'W'.repeat(950), kind: 'requested-criterion' as const, reason: 'S'.repeat(500) },
      ];
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      await seams.diagnose!({ runId: 'run-refute-render-budget', note: 'review failed', kind: 'review', round: 2, cwd: '/unused', goal: 'goal', history: [], effectiveMax: 3, refutationRound: 1, refutations });

      const section = prompt.match(/자식 REFUTE 제출\([\s\S]*?(?=\n현재 지적:)/)?.[0];
      expect(section).toBeDefined();
      expect(section!.length).toBeLessThanOrEqual(3000);
      expect(section).toContain('[preservation-contract] findingId=MF-00000001');
      expect(section).toContain('인용: - Checkable preservation criterion:');
      expect(section).toContain('근거: R');
      expect(section).toContain('[requested-criterion] findingId=MF-00000002');
      expect(section).toContain('must-fix 원문:');
      expect(section).toContain('인용:');
      expect(section).toContain('근거:');
      expect(section).toContain('REFUTE 제출 프롬프트 예산 절단: 2/2');
      expect(events).toEqual([expect.objectContaining({ runId: 'run-refute-render-budget', refutationPromptBudgetChars: 3000, refutationPromptOriginalItems: 2, refutationPromptIncludedItems: 2, refutationPromptTruncated: true })]);
    } finally {
      log.mockRestore();
    }
  });

  test('감독 자기판정 이력은 최근 항목부터 예산 안에 넣고 절단 관측을 남긴다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const supervisorDecisionHistory = Array.from({ length: 12 }, (_, index) => ({
        round: index + 1,
        verdict: 'EXTEND' as const,
        reason: `reason-${index + 1}-${'x'.repeat(900)}`,
      }));
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      await seams.diagnose!({
        runId: 'run-supervisor-history-budget', note: 'gate failed', kind: 'gate', round: 13, cwd: '/unused', goal: 'goal', history: [], supervisorDecisionHistory, effectiveMax: 13,
      });

      const section = prompt.match(/감독 자기판정 이력\([\s\S]*?(?=\n기계 집계 근거)/)?.[0];
      expect(section).toBeDefined();
      expect(section!.length).toBeLessThanOrEqual(3000);
      const round12 = section!.indexOf('[라운드 12] BUDGET: EXTEND');
      const round11 = section!.indexOf('[라운드 11] BUDGET: EXTEND');
      const round10 = section!.indexOf('[라운드 10] BUDGET: EXTEND');
      expect(round12).toBeGreaterThanOrEqual(0);
      expect(round11).toBeGreaterThan(round12);
      expect(round10).toBeGreaterThan(round11);
      expect(section).not.toContain('[라운드 1] BUDGET: EXTEND');
      expect(section).toContain('감독 자기판정 이력 프롬프트 예산 절단: 12/');
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-supervisor-history-budget',
        supervisorDecisionHistoryPromptBudgetChars: 3000,
        supervisorDecisionHistoryPromptOriginalItems: 12,
        supervisorDecisionHistoryPromptIncludedItems: expect.any(Number),
        supervisorDecisionHistoryPromptTruncated: true,
      })]);
    } finally {
      log.mockRestore();
    }
  });

  test('모든 항목이 포함된 장문 감독 사유 절단도 최종 표식까지 3000자 안에 남긴다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      await seams.diagnose!({
        runId: 'run-supervisor-history-final-marker-budget', note: 'gate failed', kind: 'gate', round: 3, cwd: '/unused', goal: 'goal', history: [],
        supervisorDecisionHistory: [
          { round: 1, verdict: 'EXTEND', reason: `first-${'x'.repeat(1_201)}` },
          { round: 2, verdict: 'EXTEND', reason: `second-${'y'.repeat(1_201)}` },
          { round: 3, verdict: 'EXTEND', reason: `third-${'z'.repeat(1_201)}` },
        ], effectiveMax: 4,
      });

      const section = prompt.match(/감독 자기판정 이력\([\s\S]*?(?=\n기계 집계 근거)/)?.[0];
      expect(section).toBeDefined();
      expect(section!.length).toBeLessThanOrEqual(3000);
      expect(section).toContain('[라운드 2] BUDGET: EXTEND');
      expect(section).toContain('[라운드 1] BUDGET: EXTEND');
      expect(section).toContain('감독 자기판정 이력 프롬프트 예산 절단: 3/');
      expect(section).toContain('감독 자기판정 이력 사유 길이 절단:');
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-supervisor-history-final-marker-budget',
        supervisorDecisionHistoryPromptBudgetChars: 3000,
        supervisorDecisionHistoryPromptOriginalItems: 3,
        supervisorDecisionHistoryPromptIncludedItems: expect.any(Number),
        supervisorDecisionHistoryPromptReasonTruncatedItems: expect.any(Number),
        supervisorDecisionHistoryPromptTruncated: true,
      })]);
    } finally {
      log.mockRestore();
    }
  });

  test('단일 장문 감독 사유 절단을 프롬프트와 완료 관측에 남긴다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const reason = `recent-${'x'.repeat(1_201)}`;
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      await seams.diagnose!({
        runId: 'run-supervisor-history-reason-truncated', note: 'gate failed', kind: 'gate', round: 2, cwd: '/unused', goal: 'goal', history: [],
        supervisorDecisionHistory: [{ round: 1, verdict: 'EXTEND', reason }], effectiveMax: 3,
      });

      const section = prompt.match(/감독 자기판정 이력\([\s\S]*?(?=\n기계 집계 근거)/)?.[0];
      expect(section).toBeDefined();
      expect(section).toContain(`REASON: ${reason.slice(0, 1200)}`);
      expect(section).not.toContain(reason);
      expect(section).toContain('감독 자기판정 이력 사유 길이 절단: 1');
      expect(section!.length).toBeLessThanOrEqual(3000);
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-supervisor-history-reason-truncated',
        supervisorDecisionHistoryPromptBudgetChars: 3000,
        supervisorDecisionHistoryPromptOriginalItems: 1,
        supervisorDecisionHistoryPromptIncludedItems: 1,
        supervisorDecisionHistoryPromptReasonTruncatedItems: 1,
        supervisorDecisionHistoryPromptTruncated: true,
      })]);
    } finally {
      log.mockRestore();
    }
  });

  test('기계 집계 근거를 예산 안에서 항목 단위로 자르고 프롬프트·완료 관측에 남긴다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const cited = Array.from({ length: 256 }, (_, occurrence) => ({ hash: `cited-${occurrence}`, symbol: 'S'.repeat(80), firstSeenRound: 1, lastSeenRound: 2, occurrence: occurrence + 1 }));
      const repeats = Array.from({ length: 256 }, (_, occurrence) => ({ hash: `repeat-${occurrence}`, firstSeenRound: 1, repeatedAtRound: 2, occurrence: occurrence + 1 }));
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      await seams.diagnose!({
        runId: 'run-cited-budget', note: 'gate failed', kind: 'review', round: 2, cwd: '/unused', goal: '## ACCEPTANCE CRITERIA\n짧은 골', history: [], effectiveMax: 3,
        reviewFindingTelemetry: { citedReviewSymbolOccurrences: cited, normalizedReviewFindingRepeatCounts: repeats, symbolKeyedReviewFindingCount: cited.length, proseFallbackReviewFindingCount: 0 },
      });

      const machineEvidence = prompt.match(/기계 집계 근거\(산문 이력을 보강; 판정 규칙은 그대로 적용\):\n([\s\S]*?)\n현재 지적:/)?.[1];
      expect(machineEvidence).toBeDefined();
      expect(machineEvidence!.length).toBeLessThanOrEqual(3000);
      expect(prompt).toContain('기계 집계 근거 프롬프트 예산 절단: priorRuns 0/0, repeat 256/');
      expect(prompt).toContain('cited 256/');
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-cited-budget',
        reviewFindingTelemetryPromptBudgetChars: 3000,
        reviewFindingTelemetryPromptTruncated: true,
        reviewFindingTelemetryPromptOriginalCitedItems: 256,
        reviewFindingTelemetryPromptOriginalRepeatItems: 256,
        reviewFindingTelemetryPromptOriginalPriorRunItems: 0,
        reviewFindingTelemetryPromptIncludedCitedItems: expect.any(Number),
        reviewFindingTelemetryPromptIncludedRepeatItems: expect.any(Number),
        reviewFindingTelemetryPromptIncludedPriorRunItems: 0,
      })]);
      expect(events[0]!.reviewFindingTelemetryPromptIncludedRepeatItems as number).toBeGreaterThan(0);
      expect(events[0]!.reviewFindingTelemetryPromptIncludedCitedItems as number).toBe(0);
      expect(events[0]!.reviewFindingTelemetryPromptIncludedRepeatedCitedItems).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test('실린 cited 근거의 재인용 수를 완료 관측에 남긴다', async () => {
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({ llmReview: async () => 'BUDGET: EXTEND\nREASON: narrowed' });
      await seams.diagnose!({
        runId: 'run-repeated-cited-evidence', note: 'gate failed', kind: 'review', round: 2, cwd: '/unused', goal: '## ACCEPTANCE CRITERIA\n짧은 골', history: [], effectiveMax: 3,
        reviewFindingTelemetry: {
          citedReviewSymbolOccurrences: [
            { hash: 'new', symbol: 'newSymbol', firstSeenRound: 2, lastSeenRound: 2, occurrence: 0 },
            { hash: 'repeated', symbol: 'repeatedSymbol', firstSeenRound: 1, lastSeenRound: 2, occurrence: 1 },
          ],
          normalizedReviewFindingRepeatCounts: [],
          symbolKeyedReviewFindingCount: 2,
          proseFallbackReviewFindingCount: 0,
        },
      });
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-repeated-cited-evidence',
        reviewFindingTelemetryPromptIncludedCitedItems: 2,
        reviewFindingTelemetryPromptIncludedRepeatedCitedItems: 1,
      })]);
    } finally {
      log.mockRestore();
    }
  });

  test('지난 런은 읽기 실패 null과 빈 이력을 구분하고 반복 뒤 심볼 전 예산을 받는다', async () => {
    const events: Record<string, unknown>[] = [];
    let prompt = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'diagnose.done') events.push(data ?? {});
    }) as never);
    try {
      const priorRuns = Array.from({ length: 64 }, (_, occurrence) => ({ runId: `prior-${occurrence}`, outcome: 'budget-exhausted' as const, stage: 'review-blocked' as const, mustFixDigest: ['M'.repeat(90)] }));
      const cited = Array.from({ length: 64 }, (_, occurrence) => ({ hash: `cited-${occurrence}`, symbol: 'S'.repeat(90), firstSeenRound: 1, lastSeenRound: 2, occurrence: occurrence + 1 }));
      const repeats = [{ hash: 'repeat', firstSeenRound: 1, repeatedAtRound: 2, occurrence: 1 }];
      const seams = defaultSeams({ llmReview: async (input: string) => { prompt = input; return 'BUDGET: EXTEND\nREASON: narrowed'; } });
      await seams.diagnose!({
        runId: 'run-prior-budget', note: 'gate failed', kind: 'review', round: 2, cwd: '/unused', goal: '## ACCEPTANCE CRITERIA\n짧은 골', history: [], effectiveMax: 3,
        priorRuns: { priorRuns, total: 99, truncated: true },
        reviewFindingTelemetry: { citedReviewSymbolOccurrences: cited, normalizedReviewFindingRepeatCounts: repeats, symbolKeyedReviewFindingCount: cited.length, proseFallbackReviewFindingCount: 0 },
      });

      expect(prompt).toContain('"priorRuns":[{"runId":"prior-0"');
      expect(prompt).toContain('"normalizedReviewFindingRepeatCounts":[{"hash":"repeat"');
      expect(prompt).not.toContain('"citedReviewSymbolOccurrences":[{"hash":"cited-0"');
      expect(events).toEqual([expect.objectContaining({
        runId: 'run-prior-budget',
        reviewFindingTelemetryPromptOriginalPriorRunItems: 99,
        reviewFindingTelemetryPromptIncludedPriorRunItems: expect.any(Number),
        reviewFindingTelemetryPromptOriginalRepeatItems: 1,
        reviewFindingTelemetryPromptIncludedRepeatItems: 1,
        reviewFindingTelemetryPromptOriginalCitedItems: 64,
        reviewFindingTelemetryPromptIncludedCitedItems: 0,
      })]);
      expect(events[0]!.reviewFindingTelemetryPromptIncludedRepeatedCitedItems).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});

// ── 부팅 실패 사유 (2026-07-30) ────────────────────────────────────────────────
//
// ⛔ **왜 이 테스트가 있나**: 새 워크트리에서 자식 우주가 물질화되지 않으면 자식은 온보딩 거부로
//    13초에 죽는데, 파이프라인 층에는 `stage=aborted` · `screen-only` 만 남는다. S 가 그 표면만
//    보고 **세 번 헛짚었다**(골 결함 · base 해석 · 프롬프트 argv 파싱 — 셋 다 틀렸다).
//    ⇒ 사유가 **이름으로** 올라와야 한다.
describe('bootFailureReason — 부팅 실패 사유를 이름으로 올린다', () => {
  const ONBOARDING = '  error: 온보딩 마법사는 자율 컨텍스트(self-build)에서 뜰 수 없다 — config 가 비어 있다  ';

  test('온보딩 거부 진단을 뽑는다(들여쓰기·앞뒤 공백 무관)', () => {
    expect(resolveBootFailureReason(`무언가\n${ONBOARDING}\n다른 줄`, false, 0)).toContain('온보딩 마법사는 자율 컨텍스트');
  });

  test('⛔ provisionDerivedUniverse 라는 낱말만 있는 평범한 문장은 진단이 아니다', () => {
    // 리뷰 must-fix — 본문에 낱말이 있는 것으로 진단을 판정하면 무관한 출력이 사유로 올라간다.
    expect(resolveBootFailureReason('스포너가 provisionDerivedUniverse 를 부르는지 확인하라', false, 0)).toBeUndefined();
  });

  test('오류 줄 머리에서 provisionDerivedUniverse 가 나오면 진단이다', () => {
    expect(resolveBootFailureReason('error: provisionDerivedUniverse 를 부르는지 확인하라', false, 0)).toContain('provisionDerivedUniverse');
  });

  test('진단이 없으면 부팅 마커(No config yet)로 떨어진다', () => {
    expect(resolveBootFailureReason('󰁔 No config yet — launching setup wizard first.', false, 0)).toContain('No config yet');
  });

  test('⭐ 진단도 마커도 없으면 undefined — 아무 줄이나 사유로 올리지 않는다', () => {
    // ⛔ 마지막 줄 폴백을 쓰면 **모름을 특정 원인으로 뭉개는 것**이다.
    expect(resolveBootFailureReason('평범한 출력\n또 다른 줄\n끝', false, 0)).toBeUndefined();
    expect(resolveBootFailureReason('', false, 0)).toBeUndefined();
  });

  test('⭐ 1000자에서 자른다(로그 비대 방지)', () => {
    const long = `error: 온보딩 마법사는 자율 컨텍스트 ${'x'.repeat(2000)}`;
    expect(resolveBootFailureReason(long, false, 0)!.length).toBe(1000);
  });
});

describe('defaultSeams.implement — fallback child boundary mailbox env', () => {
  test('spawnSync fallback은 같은 executionId로 만든 회신함 경로를 자식에게 전달한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-boundary-response-'));
    let childEnv: NodeJS.ProcessEnv | undefined;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => false,
        spawnSync: ((_: string, __: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
          childEnv = options?.env;
          return { status: 0, stdout: 'GOAL-COMPLETE', stderr: '', signal: null };
        }) as typeof spawnSync,
      });
      await seams.implement({ cwd, feature: '회신함 경로', runId: 'run-boundary-response' });
      const requestPath = childEnv?.[HARNESS_BOUNDARY_REQUESTS_ENV];
      const responsePath = childEnv?.[HARNESS_BOUNDARY_RESPONSES_ENV];
      expect(requestPath).toMatch(/\.jsonl$/);
      expect(responsePath).toBe(`${requestPath!.slice(0, -'.jsonl'.length)}.responses.jsonl`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── 부팅 실패 사유 **배선** 통합 회귀 (리뷰 must-fix ②) ──────────────────────────
//
// ⚠️ **왜 순수 테스트로 부족한가**: 추출 함수만 검증하면 **PTY·spawnSync 두 경로의 배선을
//    지워도 전부 통과한다**(리뷰 지적). 실제 seam 을 통과시켜 `summary` 머리말을 고정해야
//    그 경로가 잠긴다. ⭐ 이 저장소에서 같은 형태를 이미 한 번 지불했다(게이트 스코프 배선).
describe('defaultSeams.implement — 부팅 실패 사유 배선(두 경로 동일 규칙)', () => {
  const REFUSAL = 'error: 온보딩 마법사는 자율 컨텍스트(self-build)에서 뜰 수 없다 — config 가 비어 있다';

  test('⭐ PTY 경로 — summary 머리말에 사유가 실린다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-boot-pty-'));
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({
          ok: true, reachedCompletion: false, transcript: `무언가\n${REFUSAL}`,
          toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test',
        }),
      });
      const res = await seams.implement({ cwd, feature: '부팅 실패', runId: 'run-boot-pty' });
      expect(res.summary).toContain('[부팅 실패]');
      expect(res.summary).toContain('온보딩 마법사는 자율 컨텍스트');
      // ⛔ `ok` 는 이 테스트의 주어가 아니다 — 임시 디렉터리는 git repo 가 아니라
      //    `worktreeHasChanges` 판정이 픽스처에 좌우된다. 여기서 고정할 것은 **사유가 실린다**다.
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('⭐ 정상 실행이면 머리말이 없다(거짓 사유 금지)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-boot-clean-'));
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({
          ok: true, reachedCompletion: true, transcript: '평범한 출력\nGOAL-COMPLETE',
          toolCalls: 3, timedOut: false, exitReason: 'completion-marker', exitCode: 0, ptyId: 'pty-test',
        }),
      });
      const res = await seams.implement({ cwd, feature: '정상', runId: 'run-boot-clean' });
      expect(res.summary).not.toContain('[부팅 실패]');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('⭐⭐ exit 0 이고 툴콜이 있어도 확정 진단이면 사유가 실린다', async () => {
    // ⛔ 이것이 리뷰 must-fix ①의 핵심 — exit code 나 정황으로 확정 진단을 가리면 안 된다.
    const cwd = mkdtempSync(join(tmpdir(), 'seam-boot-exit0-'));
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({
          ok: true, reachedCompletion: false, transcript: REFUSAL,
          toolCalls: 5, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test',
        }),
      });
      const res = await seams.implement({ cwd, feature: '진단만', runId: 'run-boot-exit0' });
      expect(res.summary).toContain('[부팅 실패]');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── `boot-failure` **관측 이벤트** 회귀 (리뷰 must-fix) ─────────────────────────
//
// ⚠️ **왜 필요한가**: 앞 라운드까지는 관측 이벤트를 **삭제해도 40개가 전부 통과**했다(리뷰 지적).
//    `summary` 머리말만 고정하면 **로그로 조회할 수 있다는 계약**이 안 잠긴다 — 그런데 이 골의
//    출발점이 정확히 *"파이프라인 층에 사유가 안 올라온다"* 였다.
describe('boot-failure 관측 이벤트 — 발생·비발생을 잠근다', () => {
  const REFUSAL = 'error: 온보딩 마법사는 자율 컨텍스트(self-build)에서 뜰 수 없다 — config 가 비어 있다';

  async function captureBootFailureEvents(transcript: string, toolCalls: number): Promise<unknown[]> {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-boot-obs-'));
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'self-implement' && event === 'boot-failure') events.push(data);
    }) as never);
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({
          ok: true, reachedCompletion: false, transcript,
          toolCalls, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test',
        }),
      });
      await seams.implement({ cwd, feature: '관측', runId: 'run-boot-obs' });
      return events;
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  test('⭐ 확정 진단이면 boot-failure 가 사유와 함께 발화한다', async () => {
    const events = await captureBootFailureEvents(`무언가\n${REFUSAL}`, 0);
    expect(events).toHaveLength(1);
    // ⛔ `changed` 는 단언하지 않는다 — 임시 디렉터리는 git repo 가 아니라
    //    `worktreeHasChanges` 판정이 픽스처에 좌우된다(이 창에서 같은 함정을 한 번 밟았다).
    expect(events[0]).toMatchObject({ transport: 'pty', runId: 'run-boot-obs', toolCalls: 0 });
    expect(String((events[0] as { reason?: string }).reason)).toContain('온보딩 마법사는 자율 컨텍스트');
  });

  test('⭐ 정상 실행이면 발화하지 않는다(거짓 관측 금지)', async () => {
    expect(await captureBootFailureEvents('평범한 출력\nGOAL-COMPLETE', 3)).toHaveLength(0);
  });
});

describe('defaultSeams.implement — 반환 toolCalls 는 이미 센 값이다', () => {
  test('PTY 경로는 runHeadlessGoalLoopPty 가 센 toolCalls 를 그대로 실어 보낸다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-toolcalls-pty-'));
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({
          ok: true, reachedCompletion: false, transcript: '화면',
          toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test',
        }),
      });
      const res = await seams.implement({ cwd, feature: '툴콜 전달', runId: 'run-toolcalls-pty' });
      expect(res.toolCalls).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('PTY 경로의 양수 toolCalls 도 다시 세지 않고 그대로 반환한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-toolcalls-pty-pos-'));
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => ({
          ok: true, reachedCompletion: true, transcript: '⏺ Edit(\nfile\n)',
          toolCalls: 7, timedOut: false, exitReason: 'completion-marker', exitCode: 0, ptyId: 'pty-test',
        }),
      });
      const res = await seams.implement({ cwd, feature: '툴콜 양수', runId: 'run-toolcalls-pty-pos' });
      expect(res.toolCalls).toBe(7);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('spawnSync 폴백은 트랜스크립트에서 이미 센 toolCalls 를 반환한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-toolcalls-sync-'));
    try {
      const transcript = 'head\n⏺ Read(path)\nmiddle\n⏺ Edit(file)\nGOAL-COMPLETE\n';
      const seams = defaultSeams({
        ptyAvailable: () => false,
        spawnSync: ((_cmd: string, _args: readonly string[]) => ({
          status: 0, stdout: transcript, stderr: '', signal: null,
        })) as typeof spawnSync,
      });
      const res = await seams.implement({ cwd, feature: '툴콜 폴백', runId: 'run-toolcalls-sync' });
      expect(res.toolCalls).toBe((transcript.match(/⏺\s+\w+\(/g) || []).length);
      expect(res.toolCalls).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ★ I-9 구조 가드 — 조립기를 만들어도 **한쪽 갈래가 안 쓰면** 그쪽만 증거를 잃는다(이 파일의
//    종전 주석이 경고하던 "두 갈래가 갈리면 한쪽만 정직해진다"). 배선 자체를 고정한다.
describe('implement seam 두 갈래가 같은 조립기를 쓴다 (구조 가드)', () => {
  const source = readFileSync(new URL('./seams.ts', import.meta.url), 'utf8');

  test('⛔ 꼬리 요약을 직접 조립하는 자리가 남아 있지 않다', () => {
    expect(source).not.toContain('transcript.slice(-2000)');
  });

  test('⭐ PTY·spawnSync 두 갈래가 buildImplementReport 를 부른다(호출 2회)', () => {
    expect(source.match(/buildImplementReport\(/g) ?? []).toHaveLength(2);
  });
});

describe('assertBaseBranchOnOrigin — PR base 는 브랜치 이름이지 remote-tracking ref 가 아니다', () => {
  let repo: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pr-base-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@e.st');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    // origin 을 자기 자신으로 걸어 remote-tracking ref 를 만든다.
    git(repo, 'remote', 'add', 'origin', repo);
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'update-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('기본 브랜치 표식은 origin/ 접두 없이 브랜치 이름으로 나온다', () => {
    // ⛔ 회귀 대상: 여기서 'origin/main' 이 나오면 gh 가
    //    "Proposed base branch 'origin/main' was not found" 로 PR 개설을 죽인다.
    const resolved = assertBaseBranchOnOrigin(repo, DEFAULT_BRANCH_WORKTREE_BASE);
    expect(resolved).toBe('main');
    expect(resolved).not.toContain('origin/');
  });

  test('origin/ 접두가 붙은 base 를 직접 줘도 브랜치 이름으로 정규화한다', () => {
    expect(assertBaseBranchOnOrigin(repo, 'origin/main')).toBe('main');
  });

  test('base 를 안 주면 그대로 undefined 다', () => {
    expect(assertBaseBranchOnOrigin(repo, undefined)).toBeUndefined();
  });
});

describe('defaultSeams.createWorktree — self-implement ownership provenance', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'seam-worktree-provenance-'));
    repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 't@e.st');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-qm', 'base');
  });
  // ⛔⭐⭐⭐ **`createWorktree` 는 워크트리를 «임시 저장소 밖»에 만든다** — `~/.elanous/worktrees/<해시>/…`.
  //   그래서 `rmSync(root)` 로 임시 저장소를 지워도 ***그 워크트리들은 살아남는다.***
  //   📏 2026-08-12 실측: `~/.elanous/worktrees` 아래 `se-provenance-*` 가 ***522개*** 쌓여 있었고
  //     날짜 분포가 08-08:100 · 08-09:205 · 08-12:68 — ***테스트를 돌릴 때마다 셋씩 는다.***
  //     (전체 하니스 워크트리 1,134 중 소유 없는 것 747 · 그 절반 이상이 이 셋이었다)
  //   ⇒ 그래서 «만든 경로»를 세어 두고 여기서 지운다. ⛔ 전역 glob 으로 지우지 않는다 —
  //     같은 시각 다른 런의 것을 지울 수 있다(이 파일이 만든 것만 안다).
  const createdWorktrees: string[] = [];
  const cleanupWarnings: string[] = [];
  const cleanupCreatedWorktrees = () => {
    const worktreeRoot = resolve(configuredWorktreeRoot());
    const createdParents = new Set(createdWorktrees.map(dirname));
    for (const path of createdWorktrees.splice(0)) {
      // ⛔ 실패를 «삼키지 않는다»(리뷰 should-fix) — 조용히 실패하면 누수가 «다시» 돌아오고
      //   그때는 「고쳤다」고 믿고 있어서 더 오래 안 보인다.
      const removed = spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { encoding: 'utf8' });
      if (removed.status !== 0) console.warn(`[seams.test] worktree remove 실패 rc=${removed.status} ${path}: ${(removed.stderr ?? '').trim().slice(0, 120)}`);
      rmSync(path, { recursive: true, force: true });
    }
    for (const createdParent of createdParents) {
      for (let parent = createdParent; parent !== worktreeRoot && parent.startsWith(`${worktreeRoot}/`); parent = dirname(parent)) {
        try {
          rmdirSync(parent);
        } catch (error) {
          const warning = `[seams.test] worktree parent remove 실패 ${parent}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
          cleanupWarnings.push(warning);
          console.warn(warning);
          break;
        }
      }
    }
  };
  afterEach(() => {
    cleanupCreatedWorktrees();
    rmSync(root, { recursive: true, force: true });
  });

  test('cleanup removes every empty owned ancestor but preserves the harness worktree root', async () => {
    const result = await defaultSeams({ repoRoot: repo }).createWorktree({ branch: 'se/provenance-parent-empty', runId: 'run-owner-parent-empty' });
    createdWorktrees.push(result.path);
    const parent = dirname(result.path);
    const ownerRoot = dirname(parent);
    const worktreeRoot = resolve(configuredWorktreeRoot());
    cleanupCreatedWorktrees();
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(ownerRoot)).toBe(false);
    expect(existsSync(worktreeRoot)).toBe(true);
    expect(cleanupWarnings).toEqual([]);
  });

  test('cleanup preserves a non-empty owned ancestor and warns before climbing above it', async () => {
    const result = await defaultSeams({ repoRoot: repo }).createWorktree({ branch: 'se/provenance-parent-preserved', runId: 'run-owner-parent-preserved' });
    createdWorktrees.push(result.path);
    const parent = dirname(result.path);
    const ownerRoot = dirname(parent);
    writeFileSync(join(ownerRoot, 'still-in-use'), 'preserve this ancestor\n');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      cleanupCreatedWorktrees();
      expect(existsSync(parent)).toBe(false);
      expect(existsSync(ownerRoot)).toBe(true);
      expect(cleanupWarnings).toEqual([expect.stringContaining(`worktree parent remove 실패 ${ownerRoot}`)]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`worktree parent remove 실패 ${ownerRoot}`));
    } finally {
      warn.mockRestore();
      rmSync(ownerRoot, { recursive: true, force: true });
    }
  });

  test('createWorktree records run-linked owner metadata through the shared provenance writer', async () => {
    const result = await defaultSeams({ repoRoot: repo }).createWorktree({ branch: 'se/provenance-success', runId: 'run-owner-42' });
    createdWorktrees.push(result.path);
    const owner = result.owner;
    const command = result.command;
    const createdAt = result.createdAt;
    if (!owner || !command || !createdAt) throw new Error('expected self-implement provenance');
    expect(owner).toBe('dev:run-owner-42');
    expect(command).toBe('elanous dev');
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe(owner);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.command'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe(command);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.createdAt'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe(createdAt);
  });

  test('same goal rerun reuses a preserved failed artifact commit and exposes reuse state', async () => {
    const branch = 'se/provenance-rerun';
    const runId = 'run-owner-rerun';
    const first = await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId });
    createdWorktrees.push(first.path);
    writeFileSync(join(first.path, 'FAILED-ARTIFACT.md'), 'failure evidence that must survive rerun\n');
    git(first.path, 'add', 'FAILED-ARTIFACT.md');
    git(first.path, 'commit', '-qm', 'preserve failed artifact');
    const head = git(first.path, 'rev-parse', 'HEAD').stdout.trim();

    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'worktree-provenance-recorded') events.push(data ?? {});
    }) as never);
    let second: Awaited<ReturnType<ReturnType<typeof defaultSeams>['createWorktree']>>;
    try {
      second = await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId });
    } finally {
      log.mockRestore();
    }

    expect(second).toMatchObject({
      path: first.path,
      branch,
      resolvedBase: head,
      baseFreshness: 'reused',
      reused: true,
      owner: `dev:${runId}`,
      command: 'elanous dev',
    });
    expect(events).toEqual([expect.objectContaining({
      path: first.path,
      baseFreshness: 'reused',
      reused: true,
      owner: `dev:${runId}`,
    })]);
    expect(readFileSync(join(second.path, 'FAILED-ARTIFACT.md'), 'utf8')).toBe('failure evidence that must survive rerun\n');
    expect(git(second.path, 'log', '-1', '--format=%s').stdout.trim()).toBe('preserve failed artifact');
    expect(git(repo, 'worktree', 'list', '--porcelain').stdout.match(new RegExp(`branch refs/heads/${branch}`, 'g'))).toHaveLength(1);
    expect(git(second.path, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()).toBe(branch);
    expect(git(second.path, 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
  });

  test('same goal rerun preserves each guarded-reuse refusal reason instead of silently reusing', async () => {
    const refusal = async (branch: string, prepare: (path: string) => void): Promise<string> => {
      const first = await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId: `run-${branch.slice(-8)}` });
      createdWorktrees.push(first.path);
      prepare(first.path);
      try {
        await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId: `retry-${branch.slice(-8)}` });
      } catch (error) {
        return String((error as Error).message);
      }
      throw new Error(`expected guarded reuse refusal for ${branch}`);
    };

    const unowned = await refusal('se/reuse-unowned', (path) => {
      git(path, 'config', '--worktree', '--unset-all', 'elanous.harness.owner');
    });
    const foreign = await refusal('se/reuse-foreign', (path) => {
      git(path, 'config', '--worktree', '--replace-all', 'elanous.harness.owner', 'foreign:run');
    });
    const dirty = await refusal('se/reuse-dirty', (path) => {
      writeFileSync(join(path, 'uncommitted-failure.txt'), 'must not be silently reused\n');
    });

    expect(unowned).toContain('reuse refused: owner-not-recorded');
    expect(foreign).toContain('reuse refused: owner-foreign');
    expect(dirty).toContain('reuse refused: worktree-dirty');
  });

  test('same-run dirty repair rerun reuses its uncommitted artifact while a foreign run stays refused', async () => {
    const branch = 'se/reuse-same-run-dirty';
    const runId = 'run-same-dirty';
    const first = await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId });
    createdWorktrees.push(first.path);
    writeFileSync(join(first.path, 'uncommitted-artifact.html'), 'round-1 output that must survive repair\n');
    const dirtBefore = git(first.path, 'status', '--porcelain').stdout;

    const second = await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId });
    expect(second).toMatchObject({
      path: first.path,
      branch,
      baseFreshness: 'reused',
      reused: true,
      owner: `dev:${runId}`,
      command: 'elanous dev',
    });
    expect(readFileSync(join(second.path, 'uncommitted-artifact.html'), 'utf8')).toBe('round-1 output that must survive repair\n');
    expect(git(second.path, 'status', '--porcelain').stdout).toBe(dirtBefore);

    try {
      await defaultSeams({ repoRoot: repo }).createWorktree({ branch, runId: 'run-foreign-dirty' });
      throw new Error('expected foreign dirty reuse to be refused');
    } catch (error) {
      expect(String((error as Error).message)).toContain('reuse refused: worktree-dirty');
    }
    expect(existsSync(first.path)).toBe(true);
    expect(readFileSync(join(first.path, 'uncommitted-artifact.html'), 'utf8')).toBe('round-1 output that must survive repair\n');
  });

  test('provenance failure retains the worktree, returns normally, and observes the reason', async () => {
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'worktree-provenance-failed') events.push(data ?? {});
    }) as never);
    try {
      const result = await defaultSeams({
        repoRoot: repo,
        recordWorktreeProvenance: () => { throw new Error('metadata unavailable'); },
      }).createWorktree({ branch: 'se/provenance-failure', runId: 'run-owner-fail' });
      createdWorktrees.push(result.path);
      expect(existsSync(result.path)).toBe(true);
      expect(result.provenanceError).toContain('metadata unavailable');
      expect(result.owner).toBeUndefined();
      expect(events).toEqual([expect.objectContaining({
        path: result.path,
        owner: 'dev:run-owner-fail',
        command: 'elanous dev',
        reason: 'metadata unavailable',
      })]);
    } finally {
      log.mockRestore();
    }
  });

  test('missing runId retains the worktree but records no unlinked owner', async () => {
    const events: Record<string, unknown>[] = [];
    const record = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'worktree-provenance-failed') events.push(data ?? {});
    }) as never);
    const provenanceWriter = () => { throw new Error('writer must not run without a runId'); };
    try {
      const result = await defaultSeams({ repoRoot: repo, recordWorktreeProvenance: provenanceWriter }).createWorktree({ branch: 'se/provenance-no-run' });
      createdWorktrees.push(result.path);
      expect(existsSync(result.path)).toBe(true);
      expect(result.owner).toBeUndefined();
      expect(result.provenanceError).toBe('worktree ownership was not recorded because runId is unavailable');
      expect(spawnSync('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).not.toBe('true');
      expect(events).toEqual([expect.objectContaining({
        path: result.path,
        reason: 'worktree ownership was not recorded because runId is unavailable',
      })]);
    } finally {
      record.mockRestore();
    }
  });
});

describe('defaultSeams.gate — reverse verify-by-breaking routing', () => {
  function changedGateRepo(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-reverse-routing-'));
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.email', 't@t.co');
    git(cwd, 'config', 'user.name', 'T');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/edited.test.js'), "import { test } from 'bun:test'; test('base', () => {});\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base');
    writeFileSync(join(cwd, 'test/edited.test.js'), "import { test } from 'bun:test'; test('changed', () => {});\n");
    return cwd;
  }

  test('gate 통과 시 네 정방향 분류를 기존 역방향 verifier에 한 번 요청한다', async () => {
    const cwd = changedGateRepo();
    const calls: string[][] = [];
    try {
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
        runVerifyByBreaking: () => ({
          baseStatuses: { pass: 1, 'test-fail': 1, unknown: 1 },
          files: [
            { file: 'test/distinguishes.test.js', classification: 'distinguishes' as const, base: { status: 'test-fail' as const, log: 'failed' } },
            { file: 'test/nodiff.test.js', classification: 'does-not-distinguish' as const, base: { status: 'pass' as const, log: 'passed' } },
            { file: 'test/unknown.test.js', classification: 'unknown' as const, base: { status: 'unknown' as const, log: 'unavailable' } },
            { file: 'test/new.test.js', classification: 'missing-at-base' as const, base: { status: 'test-fail' as const, log: 'missing' } },
          ],
        }),
        runReverseVerifyByBreaking: (_cwd, files) => {
          calls.push([...files]);
          return { ran: true, files: [], headStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } };
        },
      }).gate(cwd);
      expect(calls).toEqual([[
        'test/distinguishes.test.js',
        'test/nodiff.test.js',
        'test/unknown.test.js',
        'test/new.test.js',
      ]]);
      expect(gate.log).toContain('Reverse verify-by-breaking: ran=true');
      expect(gate.verifyByBreaking).toEqual({
        ran: true,
        distinguishes: 1,
        'does-not-distinguish': 1,
        unknown: 1,
        missingAtBase: 1,
        files: [
          { file: 'test/distinguishes.test.js', classification: 'distinguishes' },
          { file: 'test/nodiff.test.js', classification: 'does-not-distinguish' },
          { file: 'test/unknown.test.js', classification: 'unknown' },
          { file: 'test/new.test.js', classification: 'missing-at-base' },
        ],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('gate 관측은 실행별 순번을 매기고, 스킵과 미상 실행도 정직하게 남긴다', async () => {
    const cwd = changedGateRepo();
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'gate.verify-by-breaking') events.push(data ?? {});
    }) as never);
    const passingGate = () => ({ passed: true, steps: [{ name: 'test' as const, ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' });
    const verify = () => ({
      baseStatuses: { pass: 1, 'test-fail': 0, unknown: 0 },
      files: [{ file: 'test/edited.test.js', classification: 'does-not-distinguish' as const, base: { status: 'pass' as const, log: 'passed' } }],
    });
    try {
      const seams = defaultSeams({
        runIntegrityGate: passingGate,
        runVerifyByBreaking: verify,
        runReverseVerifyByBreaking: () => ({ ran: true, files: [], headStatuses: { pass: 1, 'test-fail': 0, unknown: 0 } }),
      });
      const firstGate = await seams.gate(cwd, { runId: 'run-one' });
      expect(firstGate.verifyByBreaking).toEqual({
        ran: true,
        distinguishes: 0,
        'does-not-distinguish': 1,
        unknown: 0,
        missingAtBase: 0,
        files: [{ file: 'test/edited.test.js', classification: 'does-not-distinguish' }],
      });
      await seams.gate(cwd, { runId: 'run-one' });
      await seams.gate(cwd, { runId: 'run-two' });
      await seams.gate(cwd);
      await seams.gate(cwd, { runId: '' });

      const failed = defaultSeams({ runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test' as const, ok: false, skipped: false, summary: 'fail', output: '1 fail' }], log: '[test] FAIL' }) });
      await failed.gate(cwd, { runId: 'run-failed' });
      await failed.gate(cwd, { runId: 'run-failed' });

      const skipped = defaultSeams({ gateSteps: ['cli-smoke'], runIntegrityGate: () => ({ passed: true, steps: [], log: '[cli] PASS' }) });
      await skipped.gate(cwd, { runId: 'run-skipped' });

      expect(events).toContainEqual(expect.objectContaining({ skipped: false, runId: 'run-one', ordinal: 1, distinguishes: 0, doesNotDistinguish: 1, unknown: 0, tested: 1 }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: false, runId: 'run-one', ordinal: 2, distinguishes: 0, doesNotDistinguish: 1, unknown: 0, tested: 1 }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: false, runId: 'run-two', ordinal: 1, distinguishes: 0, doesNotDistinguish: 1, unknown: 0, tested: 1 }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: false, runId: null, ordinal: null }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: false, runId: '', ordinal: null }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: true, reason: 'gate-not-passed', runId: 'run-failed', ordinal: 1 }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: true, reason: 'gate-not-passed', runId: 'run-failed', ordinal: 2 }));
      expect(events).toContainEqual(expect.objectContaining({ skipped: true, runId: 'run-skipped', ordinal: 1 }));
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test('gate 미통과 시 역방향 verifier를 요청하지 않는다', async () => {
    const cwd = changedGateRepo();
    let reverseCalls = 0;
    try {
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test', ok: false, skipped: false, summary: 'fail', output: '1 fail' }], log: '[test] FAIL' }),
        runReverseVerifyByBreaking: () => {
          reverseCalls += 1;
          return { ran: false, files: [], headStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } };
        },
      }).gate(cwd);
      expect(gate.passed).toBe(false);
      expect(reverseCalls).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams.gate — baseline worktree bundle', () => {
  function twoTestRepo(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-baseline-bundle-'));
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.email', 't@t.co');
    git(cwd, 'config', 'user.name', 'T');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/a.test.ts'), "test('a', () => {});\n");
    writeFileSync(join(cwd, 'src/b.test.ts'), "test('b', () => {});\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base');
    writeFileSync(join(cwd, 'src/a.test.ts'), "test('a changed', () => {});\n");
    writeFileSync(join(cwd, 'src/b.test.ts'), "test('b changed', () => {});\n");
    return cwd;
  }

  test('워크트리 묶음이 있으면 실패한 파일만이 아니라 그 묶음 전체를 베이스라인에 넘긴다', async () => {
    const cwd = twoTestRepo();
    const received: string[][] = [];
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'gate.baseline') events.push(data ?? {});
    }) as never);
    try {
      const gate = await defaultSeams({
        runIntegrityGate: (_dir, opts) => ({
          passed: false,
          steps: [{
            name: 'test',
            ok: false,
            skipped: false,
            summary: 'fail',
            output: `${opts.testArgs?.[0]}:\n(fail) only a\n`,
          }],
          log: '[test] FAIL',
        }),
        runGateBaseline: (_dir, files) => {
          received.push([...files]);
          return { status: 'pass', output: '0 fail', log: 'base clean' };
        },
      }).gate(cwd);
      expect(received).toEqual([['src/a.test.ts', 'src/b.test.ts']]);
      expect(events[0]?.baselineScope).toBe('worktree-bundle');
      expect(gate.passed).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('defaultSeams.closePr — PrManager.closePr 위임', () => {
  test('호출자가 준 인자와 반환이 PrManager.closePr 과 같다', () => {
    const received: Array<{ prUrl: string; comment?: string }> = [];
    const prManager = {
      closePr(prUrl: string, comment?: string) {
        received.push(comment === undefined ? { prUrl } : { prUrl, comment });
        return true;
      },
    } as PrManager;
    const seams = defaultSeams({ prManager });
    expect(seams.closePr('https://github.com/o/r/pull/53', 'stale self-impl')).toBe(true);
    expect(received).toEqual([{ prUrl: 'https://github.com/o/r/pull/53', comment: 'stale self-impl' }]);
  });

  test('comment 생략도 같은 인자로 위임하고 반환을 그대로 낸다', () => {
    const received: Array<{ prUrl: string; comment?: string }> = [];
    const prManager = {
      closePr(prUrl: string, comment?: string) {
        received.push({ prUrl, comment });
        return false;
      },
    } as PrManager;
    expect(defaultSeams({ prManager }).closePr('https://github.com/o/r/pull/9')).toBe(false);
    expect(received).toEqual([{ prUrl: 'https://github.com/o/r/pull/9', comment: undefined }]);
  });

  test('SelfImplementSeams 에 PR 을 닫는 seam 이름이 있다', () => {
    const closePr: NonNullable<SelfImplementSeams['closePr']> = defaultSeams({
      prManager: { closePr: (_prUrl: string, _comment?: string) => true } as PrManager,
    }).closePr;
    expect(typeof closePr).toBe('function');
  });
});

describe('runSelfImplement — closePr seam 은 아직 부르지 않는다', () => {
  test('런을 끝까지 돌려도 closePr 스파이가 받은 인자 목록은 비어 있다', async () => {
    const closePrCalls: Array<{ prUrl: string; comment?: string }> = [];
    await runSelfImplement({
      feature: 'closePr seam is not wired yet',
      seams: seams({
        closePr: (prUrl, comment) => {
          closePrCalls.push(comment === undefined ? { prUrl } : { prUrl, comment });
          return true;
        },
      }),
    });
    expect(closePrCalls).toEqual([]);
  });
});

describe('defaultSeams.forkSession — harness origin on child', () => {
  test('forkSessionById 에 origin=harness 를 넘겨 자식 신분을 남긴다', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'seam-fork-harness-'));
    const priorSessionRoot = process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    try {
      const { createSession, appendMessage, loadSession, HARNESS_SESSION_ORIGIN, isHarnessSessionOrigin } = await import('../session/index.js');
      const parent = createSession({ origin: 'cli', title: 'parent chat' }, sessionRoot);
      appendMessage(parent.id, { role: 'user', content: 'keep', ts: new Date().toISOString() }, sessionRoot);
      const childId = await defaultSeams().forkSession!(parent.id);
      const child = loadSession(childId, sessionRoot);
      expect(child?.meta.origin).toBe(HARNESS_SESSION_ORIGIN);
      expect(isHarnessSessionOrigin(child?.meta.origin)).toBe(true);
      expect(isHarnessSessionOrigin(loadSession(parent.id, sessionRoot)?.meta.origin)).toBe(false);
      expect(child?.meta.forkedFromId).toBe(parent.id);
      expect(loadSession(parent.id, sessionRoot)?.meta.origin).toBe('cli');
    } finally {
      if (priorSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = priorSessionRoot;
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });
});

describe('listOpenDraftsForLineage — 원장과 draft 를 PR «URL» 로 잇는다', () => {
  test('다른 저장소의 원장에 같은 번호가 있어도 이 저장소 draft 는 URL 이 맞는 런에만 이어진다', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { appendRunLedgerEntry } = await import('./run-ledger.js');
    const { listOpenDraftsForLineage } = await import('./seams.js');
    const dir = mkdtempSync(join(tmpdir(), 'lineage-join-'));
    try {
      // 먼저 열린(더 이른) 다른 저장소의 #5 — 번호로만 이으면 이것이 이긴다
      appendRunLedgerEntry({ runId: 'run-other-repo', event: 'pr-opened', timestamp: '2026-09-01T00:00:00Z', data: { number: 5, url: 'https://github.com/someone/other/pull/5' } }, dir);
      appendRunLedgerEntry({ runId: 'run-this-repo', event: 'pr-opened', timestamp: '2026-09-20T00:00:00Z', data: { number: 5, url: 'https://github.com/ElanvitalAI/elanous/pull/5' } }, dir);
      const drafts = listOpenDraftsForLineage(() => [{ number: 5, url: 'https://github.com/ElanvitalAI/elanous/pull/5' }], undefined, dir);
      expect(drafts).toEqual([{ number: 5, runId: 'run-this-repo', openedAt: '2026-09-20T00:00:00Z' }]);
      const unknown = listOpenDraftsForLineage(() => [{ number: 7, url: 'https://github.com/ElanvitalAI/elanous/pull/7' }], undefined, dir);
      expect(unknown).toEqual([{ number: 7, runId: '', openedAt: '' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { existsSync as __existsSync } from 'node:fs';
import { isAbsolute as __isAbsolute } from 'node:path';
import { ELANOUS_ENTRY_SCRIPT, launchDevGoalFileDetached as __launchDetached } from './seams.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// 2026-09-26 베어 Ubuntu 26.04 실측: 상대 경로 `bin/elanous.mjs` 로 띄워 사용자 프로젝트(cwd)에서 자식이 즉사했다.
describe('launchDevGoalFileDetached — 사용자 프로젝트에서도 진입 스크립트를 찾는다', () => {
  test('진입 스크립트는 절대 경로이고 실제로 있다 · cwd 와 무관하다', async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      const handlers: Record<string, () => void> = {};
      queueMicrotask(() => handlers.spawn?.());
      return { once: (ev: string, fn: () => void) => { handlers[ev] = fn; }, off: () => {}, unref: () => {} };
    }) as unknown as typeof import('node:child_process').spawn;
    await __launchDetached({ goalFile: '/tmp/GOAL.md' }, fakeSpawn);
    expect(__isAbsolute(calls[0]!.args[0]!)).toBe(true);
    expect(calls[0]!.args[0]).toBe(ELANOUS_ENTRY_SCRIPT);
    expect(__existsSync(ELANOUS_ENTRY_SCRIPT)).toBe(true);
    expect(calls[0]!.args.slice(1, 4)).toEqual(['dev', '--file', '/tmp/GOAL.md']);
  });
});
