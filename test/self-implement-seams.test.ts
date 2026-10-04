import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertBaseBranchOnOrigin, buildPrBody, defaultSeams, resolveCompletionDisposition } from '../src/self-implement/seams.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../src/git-fs/worktree.js';
import { setGitCommandRunnerForTesting } from '../src/git-fs/runner.js';
import type { PrManager } from '../src/autopilot/pr-manager.js';

function gitTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return env;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
}

describe('git test helper isolation', () => {
  it('does not send git init --bare or config writes into an inherited GIT_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-git-env-'));
    const shared = join(root, 'shared');
    const bare = join(root, 'origin.git');
    const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    try {
      runGit(root, ['init', shared]);
      const sharedConfig = join(shared, '.git', 'config');
      const readSharedBare = () => spawnSync('git', ['config', '--file', sharedConfig, '--get', 'core.bare'], { cwd: root, env: gitTestEnv(), encoding: 'utf8' }).stdout.trim();
      expect(readSharedBare()).toBe('false');
      const explicitTarget = spawnSync('git', ['init', '--bare', bare], { cwd: shared, env: { ...gitTestEnv(), GIT_DIR: join(shared, '.git') }, encoding: 'utf8' });
      expect(explicitTarget.status).toBe(0);
      expect(readSharedBare()).toBe('false');
      const leakedInit = spawnSync('git', ['init', '--bare'], { cwd: shared, env: { ...gitTestEnv(), GIT_DIR: join(shared, '.git') }, encoding: 'utf8' });
      expect(leakedInit.status).toBe(0);
      expect(readSharedBare()).toBe('true');
      runGit(root, ['config', '--file', sharedConfig, 'core.bare', 'false']);
      process.env.GIT_DIR = join(shared, '.git');
      runGit(root, ['init', '--bare']);
      expect(readSharedBare()).toBe('false');
      process.env.GIT_WORK_TREE = shared;
      process.env.GIT_COMMON_DIR = join(shared, '.git');
      runGit(root, ['init', '--bare', join(root, 'isolated.git')]);
      runGit(bare, ['config', 'user.email', 'test@example.com']);
      const isolated = spawnSync('git', ['config', '--file', join(bare, 'config'), '--get', 'user.email'], { cwd: root, env: gitTestEnv(), encoding: 'utf8' });
      expect(isolated.stdout.trim()).toBe('test@example.com');
      const sharedBare = spawnSync('git', ['config', '--file', join(shared, '.git', 'config'), '--get', 'core.bare'], { cwd: root, env: gitTestEnv(), encoding: 'utf8' });
      expect(sharedBare.stdout.trim()).toBe('false');
    } finally {
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assertBaseBranchOnOrigin', () => {
  it('기본 브랜치 표식을 origin 기본 브랜치로 해석해 PR manager에도 전달한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-pr-base-'));
    const remote = join(root, 'origin.git');
    const repo = join(root, 'repo');
    const calls: unknown[] = [];
    const prManager: PrManager = {
      findPrForBranch: () => null,
      upsertPr: (input) => {
        calls.push(input);
        return { ok: true, url: 'https://github.com/o/r/pull/42', reused: false };
      },
      closePr: () => true,
      mergePr: () => true,
    };
    try {
      runGit(root, ['init', '--bare', remote]);
      runGit(root, ['init', '-b', 'main', repo]);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      writeFileSync(join(repo, 'README.md'), 'initial\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'initial']);
      runGit(repo, ['remote', 'add', 'origin', remote]);
      runGit(repo, ['push', '-u', 'origin', 'main']);

      // ⛔ 이 테스트는 2026-08-02 까지 'origin/main' 을 기대했다 — 그 기대가 곧 결함이었다.
      //    GitHub 에 'origin/main' 이라는 브랜치는 없어서 PR 개설이
      //    `Proposed base branch 'origin/main' was not found` 로 죽었다(#6604).
      expect(assertBaseBranchOnOrigin(repo, DEFAULT_BRANCH_WORKTREE_BASE)).toBe('main');
      await defaultSeams({ prManager }).openPr({
        title: 'title', body: 'body', head: 'self-impl/feature', base: DEFAULT_BRANCH_WORKTREE_BASE, cwd: repo,
      });
      expect(calls).toEqual([expect.objectContaining({ base: 'main' })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('명시한 origin base는 바꾸지 않고 로컬 전용 base는 계속 차단한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-pr-base-'));
    const remote = join(root, 'origin.git');
    const repo = join(root, 'repo');
    try {
      runGit(root, ['init', '--bare', remote]);
      runGit(root, ['init', '-b', 'main', repo]);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      writeFileSync(join(repo, 'README.md'), 'initial\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'initial']);
      runGit(repo, ['remote', 'add', 'origin', remote]);
      runGit(repo, ['push', '-u', 'origin', 'main']);
      runGit(repo, ['checkout', '-b', 'release']);
      runGit(repo, ['push', '-u', 'origin', 'release']);
      runGit(repo, ['branch', 'local-only-base']);

      expect(assertBaseBranchOnOrigin(repo, 'release')).toBe('release');
      expect(() => assertBaseBranchOnOrigin(repo, 'local-only-base')).toThrow(
        'base 브랜치 local-only-base 가 origin 에 없다 — 먼저 push 하거나 origin 브랜치를 base 로 지정하라',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('self-implement PR upsert and template', () => {
  it('repo root PR 템플릿을 본문 구조 앞에 보존한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-pr-template-'));
    try {
      mkdirSync(join(root, '.github'));
      writeFileSync(join(root, '.github', 'pull_request_template.md'), '## Summary\n\n## Test plan\n');
      expect(buildPrBody(root, '## 구현 요약\n변경')).toBe('## Summary\n\n## Test plan\n\n## 구현 요약\n변경');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('같은 헤드 브랜치는 주입된 upsertPr로 갱신한다', async () => {
    const calls: unknown[] = [];
    const prManager: PrManager = {
      findPrForBranch: () => null,
      upsertPr: (input) => {
        calls.push(input);
        return { ok: true, url: 'https://github.com/o/r/pull/42', reused: true };
      },
      closePr: () => true,
      mergePr: () => true,
    };
    const root = mkdtempSync(join(tmpdir(), 'elanous-pr-upsert-'));
    try {
      mkdirSync(join(root, '.github'));
      writeFileSync(join(root, '.github', 'pull_request_template.md'), '## Summary\n');
      const pr = await defaultSeams({ prManager }).openPr({ title: 'title', body: 'body', head: 'self-impl/feature', draft: true, labels: ['auto-review'], cwd: root });
      expect(pr).toEqual({ url: 'https://github.com/o/r/pull/42', number: 42 });
      expect(calls).toEqual([{
        branch: 'self-impl/feature', worktreePath: root, title: 'title', body: '## Summary\n\nbody',
        commitMessage: 'title', draft: true, labels: ['auto-review'],
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 게이트 스코프 **배선** 통합 회귀 (2026-07-26 · 리뷰 must-fix) ─────────────────────
//
// ⚠️ 왜 순수 테스트로 부족한가: `resolveGateScope`(순수)만 검증했더니 `seams.ts` 배선에 남은
//    풀 폴백 경로를 놓쳤다 — `gateSteps === ['test']` 이고 test 를 건너뛰어야 할 때, 종전 fail-safe 가
//    `steps=['test']` + `testArgs` 없음 = **풀 `bun test`** 를 되살렸다. 실제 `runIntegrityGate`
//    호출 옵션을 검사해야 그 경로가 잠긴다.
/** 임시 git repo + 변경 파일(untracked 도 gitChangedFiles 가 센다) → gate 호출 옵션 캡처. */
async function captureGateOpts(
  files: readonly string[],
  opts: {
    gateSteps?: ('test' | 'typecheck' | 'nexus-build' | 'cli-smoke')[];
    committed?: readonly string[];
    testStep?: { ok: boolean; skipped?: boolean; output?: string };
    runVerifyByBreaking?: () => { files: Array<{ file: string; classification: 'distinguishes' | 'does-not-distinguish' | 'unknown'; base: { status: 'pass' | 'test-fail' | 'unknown' } }>; baseStatuses: { pass: number; 'test-fail': number; unknown: number } };
    runGateBaseline?: () => { status: 'pass' | 'test-fail' | 'unknown'; output?: string; log: string };
    rerunBunTimeoutFailures?: (cwd: string, failures: readonly { name: string; file?: string; diagnostic?: string }[]) => Map<string, ('pass' | 'timeout' | 'failure')[]>;
    mutateTestArgs?: (testArgs: string[]) => string[];
    keepRepo?: boolean;
  } = {},
): Promise<{
  steps?: string[];
  testArgs?: string[];
  log?: string;
  verifyByBreaking?: unknown;
  passed?: boolean;
  baselineFailures?: unknown;
  reflectGateFacts?: unknown;
  baselineInput?: string[];
  cwd: string;
}> {
  const repo = mkdtempSync(join(tmpdir(), 'elanous-gate-scope-'));
  try {
    runGit(repo, ['init', '-b', 'main', repo]);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    for (const f of opts.committed ?? []) {
      const abs = join(repo, f);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '// committed\n');
    }
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'init']);
    for (const f of files) {
      const abs = join(repo, f);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '// x\n');
    }
    let captured: { steps?: string[]; testArgs?: string[]; log?: string } = {};
    let baselineInput: string[] | undefined;
    const seams = defaultSeams({
      ...(opts.gateSteps ? { gateSteps: opts.gateSteps } : {}),
      runIntegrityGate: (_cwd: string, gopts: { steps?: string[]; testArgs?: string[] }) => {
        if (opts.mutateTestArgs && gopts.testArgs && gopts.testArgs.length > 0) {
          gopts.testArgs = opts.mutateTestArgs([...gopts.testArgs]);
        }
        captured = { ...(gopts.steps ? { steps: [...gopts.steps] } : {}), ...(gopts.testArgs ? { testArgs: [...gopts.testArgs] } : {}) };
        return {
          passed: opts.testStep?.ok !== false,
          steps: opts.testStep ? [{ name: 'test', skipped: false, ...opts.testStep }] : [],
          log: '',
        } as never;
      },
      ...(opts.runVerifyByBreaking ? { runVerifyByBreaking: opts.runVerifyByBreaking } : {}),
      ...(opts.runGateBaseline ? {
        runGateBaseline: (_cwd: string, files: readonly string[]) => {
          baselineInput = [...files];
          return opts.runGateBaseline!();
        },
      } : {}),
      ...(opts.rerunBunTimeoutFailures ? { rerunBunTimeoutFailures: opts.rerunBunTimeoutFailures } : {}),
    } as never);
    const res = await seams.gate!(repo);
    return {
      ...captured,
      log: res.log,
      verifyByBreaking: res.verifyByBreaking,
      passed: res.passed,
      baselineFailures: res.baselineFailures,
      reflectGateFacts: res.reflectGateFacts,
      ...(baselineInput ? { baselineInput } : {}),
      cwd: repo,
    };
  } finally {
    if (!opts.keepRepo) rmSync(repo, { recursive: true, force: true });
  }
}

describe('defaultSeams.gate — verify-by-breaking 구조화 결과', () => {
  it('미실행과 세 수가 모두 0인 실행을 서로 다르게 반환한다', async () => {
    const skipped = await captureGateOpts(['docs/A.md']);
    const ranWithNoFiles = await captureGateOpts(['src/a.js', 'src/a.test.js'], {
      testStep: { ok: true },
      runVerifyByBreaking: () => ({
        files: [],
        baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 },
      }),
    });

    expect(skipped.verifyByBreaking).toEqual({
      ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: 'docs-only',
    });
    expect(ranWithNoFiles.verifyByBreaking).toEqual({
      ran: true, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, missingAtBase: 0,
    });
  });
});

describe('defaultSeams.gate — 스코프 배선(runIntegrityGate 호출 옵션)', () => {
  it('변경에 유일한 테스트가 있으면 그것만 타깃한다(changed-tests)', async () => {
    const got = await captureGateOpts(['src/a.ts', 'src/a.test.ts']);
    expect(got.testArgs).toEqual(['src/a.test.ts']);
    expect(got.steps ?? []).not.toContain('test');   // 기본 steps 미지정 → steps 미설정
  });

  it('⭐ changed-tests는 새 test/ 테스트와 기존 co-located sibling을 함께 타깃한다', async () => {
    const got = await captureGateOpts(['src/a.ts', 'test/a.test.ts'], { committed: ['src/a.test.ts'] });
    expect(got.testArgs).toEqual(['test/a.test.ts', 'src/a.test.ts']);
    expect(got.log ?? '').not.toContain('존재하지만 실행하지 않은 연관 테스트');
  });

  it('docs-only 면 test 스텝이 빠진다', async () => {
    const got = await captureGateOpts(['docs/A.md']);
    expect(got.testArgs).toBeUndefined();
    expect(got.steps).toBeDefined();
    expect(got.steps).not.toContain('test');
  });

  it('⭐ 소스 O·테스트 X·연관 존재 → 유도된 것만(풀 폴백 아님)', async () => {
    // ⚠️ 연관 테스트는 **커밋되어 있어야** 한다 — untracked 면 gitChangedFiles 가 세어
    //    changed-tests 경로로 빠져 derived 를 검증하지 못한다(첫 작성 시 실제로 그랬다).
    const got = await captureGateOpts(['src/a.ts'], { committed: ['src/a.test.ts'] });
    expect(got.testArgs).toEqual(['src/a.test.ts']);
    expect(got.steps ?? []).not.toContain('test');
  });

  it('⭐ derived — test/ 평탄화 관례도 유도한다', async () => {
    const got = await captureGateOpts(['src/x/y.ts'], { committed: ['test/x-y.test.ts'] });
    expect(got.testArgs).toEqual(['test/x-y.test.ts']);
  });

  it('⭐ 소스 O·테스트 X·연관 없음 → test 스텝이 빠진다(풀 폴백 아님)', async () => {
    const got = await captureGateOpts(['src/only-source.ts']);
    expect(got.testArgs).toBeUndefined();
    expect(got.steps).toBeDefined();
    expect(got.steps).not.toContain('test');
  });

  it('⭐⭐ 회귀 가드 — gateSteps=["test"] 에서도 풀 폴백이 되살아나지 않는다', async () => {
    // 종전 fail-safe 는 여기서 steps=['test'] + testArgs 없음 = 풀 실행을 냈다(리뷰 must-fix).
    const got = await captureGateOpts(['src/only-source.ts'], { gateSteps: ['test'] });
    const wouldRunFullTest = (got.steps ?? []).includes('test') && !got.testArgs?.length;
    expect(wouldRunFullTest).toBe(false);
    expect(got.steps).toEqual([]);   // test 를 빼면 빈 배열 — runIntegrityGate 는 passed:true
  });

  it('⭐⭐ 회귀 가드 — testArgs 가 설정되면 절대 빈 배열이 아니다', async () => {
    // 빈 배열은 integrity-gate 에서 필터 미적용 = 풀 실행이라 근본이 되돌아간다.
    for (const files of [['docs/A.md'], ['src/only-source.ts'], ['src/a.ts', 'src/a.test.ts']]) {
      const got = await captureGateOpts(files);
      if (got.testArgs !== undefined) expect(got.testArgs.length).toBeGreaterThan(0);
    }
  });
});

// ── 스킵 사실의 **관측성** (거짓통과 오독 방지 · 2026-07-26) ──────────────────────────
//
// test 스텝을 건너뛰면 `passed:true` 가 "검증됨"으로 오독될 수 있다(거짓통과). 게이트 로그가 그 사실을
// 명시해야 한다. ⚠️ **명명 정정(리뷰 should-fix 3R)**: 이것을 "셀프힐링 배선"이라 부른 것은 과장이었다 —
// `orchestrator.ts:415` 는 `!gate.passed` 일 때만 `gate.log` 를 읽으므로 **통과 라운드의 자식에겐
// 되먹임되지 않는다**(seams.ts 주석이 그 갭을 명명한다). 여기서 검증하는 것은 **관측성**이다.
describe('defaultSeams.gate — 스킵 사실의 관측성(거짓통과 오독 방지)', () => {
  it('⭐ no-related-tests 면 로그가 "검증되지 않았다"를 명시하고 수복 방법을 알려준다', async () => {
    const got = await captureGateOpts(['src/only-source.ts']);
    expect(got.log).toContain('[gate-scope] no-related-tests');
    expect(got.log).toContain('src/only-source.ts');
    expect(got.log).toContain('동작 검증이 되지 않았다');
    expect(got.log).toContain('.test.ts');       // 수복 방법(테스트 경로 관례) 안내
  });

  it('docs-only 는 정상이라고 알린다(불필요한 경보 금지)', async () => {
    const got = await captureGateOpts(['docs/A.md']);
    expect(got.log).toContain('[gate-scope] docs-only');
    expect(got.log).toContain('정상');
    expect(got.log).not.toContain('동작 검증이 되지 않았다');
  });

  it('타깃 실행된 경우엔 스킵 노트를 붙이지 않는다', async () => {
    const got = await captureGateOpts(['src/a.ts'], { committed: ['src/a.test.ts'] });
    expect(got.log ?? '').not.toContain('[gate-scope]');
  });
});

// ── unverified 가 실제 note·관측에 실리나 (리뷰 should-fix · #5500) ────────────────────
//
// 순수 `resolveGateScope` 만 검증하면 "note 가 실제 미검증 파일을 싣는다"는 계약이 **간접적으로만**
// 잠긴다. 종전 결함이 정확히 그 지점이었다(note 가 `sourceFiles` 를 실어 config 변경 시 빈 목록).
describe('defaultSeams.gate — 비문서 변경의 note 가 실제 미검증 파일을 싣는다', () => {
  it('⭐ package.json 단독 변경 → docs-only 가 아니고 note 가 그 파일을 명시한다', async () => {
    const got = await captureGateOpts(['package.json']);
    expect(got.steps).toBeDefined();
    expect(got.steps).not.toContain('test');            // 여전히 test 는 못 돈다(타깃 부재)
    expect(got.log).toContain('[gate-scope] no-related-tests');
    expect(got.log).toContain('package.json');          // ⭐ 빈 목록이 아니다
    expect(got.log).toContain('동작 검증이 되지 않았다');
    expect(got.log).not.toContain('정상');               // "정상"으로 보고하지 않는다
  });

  it('⭐ 문서만 변경 → docs-only 이고 "문서만 변경"이라고 알린다(설정 언급 없음)', async () => {
    const got = await captureGateOpts(['docs/A.md']);
    expect(got.log).toContain('[gate-scope] docs-only');
    expect(got.log).toContain('문서만 변경');
    expect(got.log).not.toContain('동작 검증이 되지 않았다');
  });

  it('note 안내가 소스 전용 표현이 아니라 일반화돼 있다', async () => {
    const got = await captureGateOpts(['package.json']);
    expect(got.log).toContain('해당 변경을 검증할 테스트/타깃');
  });
});

// ── gate.scope 관측 이벤트 배선 (리뷰 should-fix · #5500) ────────────────────────────
//
// 종전 테스트는 **note 문자열**만 봤다 — 구조화 관측값(`unverified` 등)이 실제 logger 이벤트에
// 실리는지는 검증하지 않았다. 관측은 note 와 **다른 소비자**(로그 조회·회고)를 가지므로 따로 잠근다.
async function captureScope(
  files: readonly string[],
  opts: { committed?: readonly string[] } = {},
): Promise<{ data?: Record<string, unknown>; level?: string }> {
  let out: { data?: Record<string, unknown>; level?: string } = {};
  const spy = spyOn(debug, 'log').mockImplementation(((_c: string, event: string, data?: Record<string, unknown>, opt?: { level?: string }) => {
    if (event === 'gate.scope') out = { ...(data ? { data } : {}), ...(opt?.level ? { level: opt.level } : {}) };
  }) as never);
  try { await captureGateOpts(files, opts); } finally { spy.mockRestore(); }
  return out;
}
const captureScopeEvent = async (f: readonly string[]) => (await captureScope(f)).data;

describe('defaultSeams.gate — gate.scope 이벤트가 구조화 관측값을 싣는다', () => {

  // ⚠️ **Goodhart 방지**(리뷰 must-fix) — 초판은 `unverified === 1`(개수)만 봐서, 이벤트가 목록 대신
  //    개수만 실어도 통과했다. "무엇이 검증 안 됐나"는 **경로 배열**로만 답이 된다.
  it('⭐ 비문서 변경의 unverified **파일 목록**이 이벤트에 실린다', async () => {
    const ev = await captureScopeEvent(['package.json']);
    expect(ev?.scopeReason).toBe('no-related-tests');
    expect(ev?.unverified).toEqual(['package.json']);   // 개수가 아니라 배열
    expect(ev?.unverifiedCount).toBe(1);
    expect(ev?.testStepSkipped).toBe(true);
  });

  it('⭐ 문서+비문서 혼합 — 비문서만 목록에 담긴다', async () => {
    const ev = await captureScopeEvent(['docs/A.md', 'package.json', 'scripts/x.sh']);
    expect(ev?.scopeReason).toBe('no-related-tests');
    expect(ev?.unverified).toEqual(['package.json', 'scripts/x.sh']);
    expect(ev?.unverifiedCount).toBe(2);
  });

  it('목록은 상한 8건이되 총수는 별도로 남는다(생략 은폐 금지)', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `cfg${i}.json`);
    const ev = await captureScopeEvent(many);
    expect((ev?.unverified as string[]).length).toBe(8);
    expect(ev?.unverifiedCount).toBe(11);
  });

  it('문서만 변경이면 docs-only 이고 unverified 는 0', async () => {
    const ev = await captureScopeEvent(['docs/A.md']);
    expect(ev?.scopeReason).toBe('docs-only');
    expect(ev?.unverified).toEqual([]);
    expect(ev?.unverifiedCount).toBe(0);
  });

  it('테스트 변경이면 changed-tests 이고 targeted 및 changedTests가 같은 실행 집합에서 실린다', async () => {
    const ev = await captureScopeEvent(['src/a.ts', 'src/a.test.ts']);
    expect(ev?.scopeReason).toBe('changed-tests');
    expect(ev?.targeted).toBe(1);
    expect(ev?.changedTests).toEqual(['src/a.test.ts']);
    expect(ev?.changedTestCount).toBe(1);
  });
});

// ── 혼합 변경에서 미검증 파일이 은폐되지 않는다 (리뷰 must-fix · #5500) ─────────────────
//
// ⚠️ 종전 구멍: `unverified` 를 `no-related-tests` 분기에서만 채워, `src/a.ts`(연관 테스트 있음)
// + `package.json` 이면 `derived` **조기 반환**으로 config 변경이 warn·note 에서 통째로 사라졌다.
// "테스트가 돌았으니 안전"으로 읽히지만 검증되지 않았다.
describe('defaultSeams.gate — 테스트가 돌아도 커버 안 된 변경은 드러난다', () => {
  it('⭐ src/a.ts(+연관 테스트 커밋됨) + package.json → derived 인데도 package.json 이 노출된다', async () => {
    const got = await captureGateOpts(['src/a.ts', 'package.json'], { committed: ['src/a.test.ts'] });
    expect(got.testArgs).toEqual(['src/a.test.ts']);          // 테스트는 실제로 돈다
    expect(got.log).toContain('테스트는 돌았으나');
    expect(got.log).toContain('package.json');                 // 은폐되지 않는다
  });

  it('⭐ 변경 테스트 + package.json → changed-tests 인데도 노출된다', async () => {
    const got = await captureGateOpts(['src/a.test.ts', 'package.json']);
    expect(got.testArgs).toEqual(['src/a.test.ts']);
    expect(got.log).toContain('테스트는 돌았으나');
    expect(got.log).toContain('package.json');
  });

  it('커버되는 변경만 있으면 불필요한 경보를 내지 않는다', async () => {
    const got = await captureGateOpts(['src/a.ts'], { committed: ['src/a.test.ts'] });
    expect(got.log ?? '').not.toContain('테스트는 돌았으나');
  });
});

// ── unverified 가 있으면 실제 로그 **레벨**이 warn 이다 (리뷰 should-fix · #5500) ────────
//
// debug 레벨이면 운영 로그에서 필터링돼 위험이 안 보인다 — 레벨 자체를 잠근다(문자열 존재만으로 부족).
describe('defaultSeams.gate — gate.scope 레벨 정책', () => {
  it('⭐ 비문서 미검증이 있으면 warn', async () => {
    expect((await captureScope(['package.json'])).level).toBe('warn');
  });

  it('⭐ 테스트가 돌았어도 커버 안 된 변경이 있으면 warn', async () => {
    expect((await captureScope(['src/a.test.ts', 'package.json'])).level).toBe('warn');
  });

  it('전부 커버되면 warn 이 아니다(오경보 방지)', async () => {
    // ⚠️ 커버되려면 연관 테스트가 **커밋**돼 있어야 한다(untracked 면 변경으로 세어 changed-tests 로 빠진다).
    const r = await captureScope(['src/a.ts'], { committed: ['src/a.test.ts'] });
    expect(r.level).not.toBe('warn');
  });

  it('문서만 변경도 warn 이 아니다', async () => {
    expect((await captureScope(['docs/A.md'])).level).not.toBe('warn');
  });
});

// ── gate.baseline 귀속 계측 (실패가 없어도 한 줄 · 네 수는 한 호출) ────────────────
async function captureGateBaselineLog(
  files: readonly string[],
  opts: Parameters<typeof captureGateOpts>[1] = {},
): Promise<{
  calls: Array<{ category: string; data: Record<string, unknown> }>;
  passed?: boolean;
  baselineFailures?: unknown;
  reflectGateFacts?: unknown;
  baselineInput?: string[];
  cwd: string;
}> {
  const calls: Array<{ category: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (event === 'gate.baseline') calls.push({ category, data: data ?? {} });
  }) as never);
  try {
    const res = await captureGateOpts(files, opts);
    return { calls, passed: res.passed, baselineFailures: res.baselineFailures, reflectGateFacts: res.reflectGateFacts, baselineInput: res.baselineInput, cwd: res.cwd };
  } finally {
    spy.mockRestore();
  }
}

const GATE_BASELINE_PRESERVED_KEYS = [
  'introduced',
  'preexisting',
  'unknown',
  'preconditionUnmet',
  'failures',
  'baselineFiles',
  'baselineStatus',
] as const;

describe('defaultSeams.gate — gate.baseline 귀속 네 수', () => {
  const scopedFiles = ['src/a.ts', 'src/a.test.ts'] as const;

  afterEach(() => setGitCommandRunnerForTesting(undefined));

  it('2/1/3/0 게이트 보고는 gate.baseline 한 호출에 네 수를 함께 싣는다', async () => {
    const worktreeLog = [
      '(fail) unknown one',
      '(fail) unknown two',
      '(fail) unknown three',
      'test/a.test.ts:',
      '(fail) old case',
      '(fail) new case one',
      '(fail) new case two',
    ].join('\n');
    const baselineLog = ['test/a.test.ts:', '(fail) old case'].join('\n');
    const got = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'test-fail', output: baselineLog, log: 'base reproduced' }),
      keepRepo: true,
    });

    try {
      expect(got.calls).toHaveLength(1);
      expect(got.calls[0]?.category).toBe('self-implement');
      const payload = got.calls[0]?.data ?? {};
      expect(payload).toMatchObject({
        introduced: 2, preexisting: 1, unknown: 3, preconditionUnmet: 0,
      });
      expect(payload).toHaveProperty('timedOut');
      expect(payload).toHaveProperty('branch');
      expect(payload).toHaveProperty('workdir');
      expect(payload.branch).toBe('main');
      expect(payload.workdir).toBe(got.cwd);
      expect(got.passed).toBe(false);
      expect(got.reflectGateFacts).toMatchObject({ introduced: 2, preexisting: 1, unknown: 3 });
      expect((got.baselineFailures as Array<{ attribution: string }> | undefined)?.map((failure) => failure.attribution))
        .toEqual(['unknown', 'unknown', 'unknown', 'preexisting', 'introduced', 'introduced']);
    } finally {
      rmSync(got.cwd, { recursive: true, force: true });
    }
  });

  it('0/0/0/0 게이트 보고도 gate.baseline 한 호출에 네 수 0을 싣는다', async () => {
    const got = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: true },
      runVerifyByBreaking: () => ({
        files: [],
        baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 },
      }),
      keepRepo: true,
    });

    try {
      expect(got.calls).toHaveLength(1);
      expect(got.calls[0]?.category).toBe('self-implement');
      const payload = got.calls[0]?.data ?? {};
      expect(payload.introduced).toBe(0);
      expect(payload.preexisting).toBe(0);
      expect(payload.unknown).toBe(0);
      expect(payload.preconditionUnmet).toBe(0);
      expect(payload.timedOut).toBe(0);
      expect(payload).toHaveProperty('branch');
      expect(payload).toHaveProperty('workdir');
      expect(payload.branch).toBe('main');
      expect(payload.workdir).toBe(got.cwd);
      expect(got.baselineFailures).toBeUndefined();
      expect(got.reflectGateFacts).toBeUndefined();
    } finally {
      rmSync(got.cwd, { recursive: true, force: true });
    }
  });

  it('실패/무실패 두 가지가 timedOut·branch·workdir 키를 같은 모양으로 싣는다', async () => {
    const worktreeLog = ['test/a.test.ts:', '(fail) new case'].join('\n');
    const failure = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
    });
    const noFailure = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: true },
      runVerifyByBreaking: () => ({
        files: [],
        baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 },
      }),
    });
    const failureKeys = Object.keys(failure.calls[0]?.data ?? {});
    const noFailureKeys = Object.keys(noFailure.calls[0]?.data ?? {});
    for (const key of ['timedOut', 'branch', 'workdir'] as const) {
      expect(failureKeys).toContain(key);
      expect(noFailureKeys).toContain(key);
    }
    expect(noFailure.calls[0]?.data.timedOut).toBe(0);
  });

  it('timeout rerun helper의 유효한 pass 관측을 classifier에 전달해 may-vary로 분류한다', async () => {
    const worktreeLog = [
      'test/a.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 10000ms',
      '',
      '1 fail',
    ].join('\n');
    let receivedFailures: readonly { name: string; file?: string; diagnostic?: string }[] = [];
    const got = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
      rerunBunTimeoutFailures: (_cwd, failures) => {
        receivedFailures = failures;
        return new Map([['test/a.test.ts > intermittent timeout', ['pass']]]);
      },
    });

    expect(receivedFailures).toEqual([expect.objectContaining({
      name: 'test/a.test.ts > intermittent timeout',
      file: 'test/a.test.ts',
      diagnostic: '^ this test timed out after 10000ms',
    })]);
    expect(got.baselineFailures).toEqual([expect.objectContaining({
      attribution: 'flaky-timeout',
      timeoutVariability: 'may-vary',
    })]);
    expect(got.passed).toBe(false);
  });

  it('report.timedOut 이 2 이면 페이로드 timedOut 도 2 다', async () => {
    const worktreeLog = [
      'test/a.test.ts:',
      '(fail) slow one',
      '^ this test timed out after 10000ms',
      'test/b.test.ts:',
      '(fail) also slow',
      '^ this test timed out after 10000ms',
      '',
      '2 fail',
    ].join('\n');
    const got = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
    });
    expect(got.calls[0]?.data.timedOut).toBe(2);
    expect(got.passed).toBe(false);
  });

  it('브랜치 관측이 예외를 던져도 게이트는 완료하고 branch 는 null 이다', async () => {
    setGitCommandRunnerForTesting((_cwd, args) => {
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) throw new Error('injected branch observation failure');
      const actual = spawnSync('git', args, { cwd: _cwd, env: gitTestEnv(), encoding: 'utf8' });
      return { status: actual.status, stdout: actual.stdout ?? '', stderr: actual.stderr ?? '' };
    });
    const worktreeLog = ['test/a.test.ts:', '(fail) new case'].join('\n');
    const got = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
      keepRepo: true,
    });
    try {
      expect(got.calls).toHaveLength(1);
      expect(got.calls[0]?.data.branch).toBeNull();
      expect(got.calls[0]?.data).toHaveProperty('branch');
      expect(got.calls[0]?.data.workdir).toBe(got.cwd);
      expect(got.passed).toBe(false);
    } finally {
      rmSync(got.cwd, { recursive: true, force: true });
    }
  });

  it('이번 변경 전 키 일곱은 실패 가지에 그대로 있고 값도 같다', async () => {
    const worktreeLog = [
      '(fail) unknown one',
      '(fail) unknown two',
      '(fail) unknown three',
      'test/a.test.ts:',
      '(fail) old case',
      '(fail) new case one',
      '(fail) new case two',
    ].join('\n');
    const baselineLog = ['test/a.test.ts:', '(fail) old case'].join('\n');
    const got = await captureGateBaselineLog(scopedFiles, {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'test-fail', output: baselineLog, log: 'base reproduced' }),
    });
    const payload = got.calls[0]?.data ?? {};
    for (const key of GATE_BASELINE_PRESERVED_KEYS) {
      expect(payload).toHaveProperty(key);
    }
    expect(payload.introduced).toBe(2);
    expect(payload.preexisting).toBe(1);
    expect(payload.unknown).toBe(3);
    expect(payload.preconditionUnmet).toBe(0);
    expect(Array.isArray(payload.failures)).toBe(true);
    expect((payload.failures as unknown[]).length).toBe(6);
    expect(payload.baselineStatus).toBe('test-fail');
    expect(got.passed).toBe(false);
    expect(payload.baselineScope).toBe('worktree-bundle');
  });

  it('워크트리 묶음이 있으면 실패한 파일만이 아니라 그 묶음 전체를 베이스라인에 넘긴다', async () => {
    const worktreeLog = ['src/a.test.ts:', '(fail) only a'].join('\n');
    const got = await captureGateBaselineLog(['src/a.ts', 'src/a.test.ts', 'src/b.ts', 'src/b.test.ts'], {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
    });
    expect(got.baselineInput).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(got.calls[0]?.data.baselineScope).toBe('worktree-bundle');
    expect(got.passed).toBe(false);
  });

  it('gateOpts.testArgs 가 비면 실패한 파일 목록으로 폴백한다', async () => {
    const worktreeLog = ['src/a.test.ts:', '(fail) only a'].join('\n');
    const got = await captureGateBaselineLog(['src/a.ts', 'src/a.test.ts'], {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
      mutateTestArgs: () => [],
    });
    expect(got.baselineInput).toEqual(['src/a.test.ts']);
    expect(got.calls[0]?.data.baselineScope).toBe('failed-files-fallback');
    expect(got.passed).toBe(false);
  });

  it('베이스라인 목록은 워크트리 순서를 유지한 채 중복을 한 번만 남긴다', async () => {
    const worktreeLog = ['src/a.test.ts:', '(fail) only a'].join('\n');
    const got = await captureGateBaselineLog(['src/a.ts', 'src/a.test.ts', 'src/b.ts', 'src/b.test.ts'], {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
      mutateTestArgs: (testArgs) => [...testArgs, testArgs[0]!],
    });
    expect(got.baselineInput).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(got.calls[0]?.data.baselineScope).toBe('worktree-bundle');
  });

  it('실패가 있는 게이트의 통과·실패 판정은 이번 변경 전과 같다', async () => {
    const worktreeLog = ['src/a.test.js:', '(fail) only a'].join('\n');
    const introduced = await captureGateBaselineLog(['src/a.js', 'src/a.test.js', 'src/b.js', 'src/b.test.js'], {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
    });
    const preexisting = await captureGateBaselineLog(['src/a.js', 'src/a.test.js'], {
      testStep: { ok: false, output: worktreeLog },
      runGateBaseline: () => ({ status: 'test-fail', output: worktreeLog, log: 'base reproduced' }),
    });
    expect(introduced.passed).toBe(false);
    expect(preexisting.passed).toBe(true);
    expect(introduced.calls[0]?.data.introduced).toBe(1);
    expect(preexisting.calls[0]?.data.preexisting).toBe(1);
    expect(introduced.calls[0]?.data.baselineScope).toBe('worktree-bundle');
    expect(preexisting.calls[0]?.data.baselineScope).toBe('worktree-bundle');
  });
});

describe('defaultSeams.diagnose — 잘린 진단 입력의 결손 표시', () => {
  it('renders supplied machine-counted review evidence while preserving the verdict rules', async () => {
    let prompt = '';
    const diagnose = defaultSeams({ llmReview: async (input) => { prompt = input; return 'BUDGET: EXTEND\nREASON: test'; } }).diagnose!;
    await diagnose({
      runId: 'run-diagnose-evidence', note: 'current critique', kind: 'review', round: 2, cwd: '/tmp', goal: 'goal', history: ['prior critique'], effectiveMax: 3,
      reviewFindingTelemetry: {
        citedReviewSymbolOccurrences: [{ hash: 'symbol-hash', symbol: 'reviewSymbol', firstSeenRound: 0, lastSeenRound: 2, occurrence: 2 }],
        normalizedReviewFindingRepeatCounts: [{ hash: 'finding-hash', firstSeenRound: 0, repeatedAtRound: 2, occurrence: 2 }],
        symbolKeyedReviewFindingCount: 0,
        proseFallbackReviewFindingCount: 0,
      },
    });
    expect(prompt).toContain('"symbolKeyedReviewFindingCount":0');
    expect(prompt).toContain('"symbol":"reviewSymbol"');
    expect(prompt).toContain('"repeatedAtRound":2');
    expect(prompt).toContain('EXTEND는 새 지적이 좁아져 한 라운드 더로 풀릴 때만');
    expect(prompt).toContain('SUFFICIENT는 리뷰만 실패했고 gate는 통과했으며');
    expect(prompt).toContain('UNCONVERGEABLE은 같은 지적 반복');
  });

  it('⭐ 긴 라운드 이력과 현재 지적의 앞부분 생략을 판정 프롬프트에 명시한다', async () => {
    let prompt = '';
    const diagnose = defaultSeams({ llmReview: async (input) => { prompt = input; return 'BUDGET: EXTEND\nREASON: test'; } }).diagnose!;
    await diagnose({
      runId: 'run-diagnose-truncation', note: `CRITIQUE-FIRST-${'c'.repeat(3500)}-CRITIQUE-LAST`, kind: 'review', round: 2, cwd: '/tmp', goal: 'goal',
      history: [`HISTORY-FIRST-${'h'.repeat(5500)}-HISTORY-LAST`], effectiveMax: 3,
    });
    expect(prompt).toContain('[상한 4800자 — 앞부분');
    expect(prompt).toContain('HISTORY-LAST');
    expect(prompt).not.toContain('HISTORY-FIRST');
    expect(prompt).toContain('[상한 3000자 — 앞부분');
    expect(prompt).toContain('CRITIQUE-LAST');
    expect(prompt).not.toContain('CRITIQUE-FIRST');
  });
});

describe('resolveCompletionDisposition', () => {
  it('완료 마커·툴콜 있음·변경 없음·타임아웃 아님은 completed-without-changes다', () => {
    expect(resolveCompletionDisposition({
      reachedCompletion: true, toolCalls: 19, changed: false, timedOut: false,
    })).toBe('completed-without-changes');
  });

  it('완료 마커 없음·툴콜 0·변경 없음은 completed-without-changes가 아니다', () => {
    expect(resolveCompletionDisposition({
      reachedCompletion: false, toolCalls: 0, changed: false, timedOut: false,
    })).toBeUndefined();
  });

  it('완료 마커 없이 툴콜이 있어도 completed-without-changes가 아니다', () => {
    expect(resolveCompletionDisposition({
      reachedCompletion: false, toolCalls: 1, changed: false, timedOut: false,
    })).toBeUndefined();
  });

  it.each([
    ['타임아웃', { reachedCompletion: true, toolCalls: 1, changed: false, timedOut: true }],
    ['변경 있음', { reachedCompletion: true, toolCalls: 1, changed: true, timedOut: false }],
    ['툴콜 없음', { reachedCompletion: true, toolCalls: 0, changed: false, timedOut: false }],
  ])('%s이면 completed-without-changes가 아니다', (_name, input) => {
    expect(resolveCompletionDisposition(input)).toBeUndefined();
  });
});

describe('defaultSeams.implement — PTY 폴백 강등 관측', () => {
  const degraded = ['live-progress', 'registry', 'non-blocking-parent', 'pty-identity'];

  async function observeFallback(opts: {
    ptyAvailable: () => boolean;
    runHeadlessGoalLoopPty?: () => ReturnType<typeof import('../src/self-implement/headless-elanous-driver.js').runHeadlessGoalLoopPty>;
  }): Promise<Array<{ event: string; data: Record<string, unknown>; level?: string }>> {
    const events: Array<{ event: string; data: Record<string, unknown>; level?: string }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>, options?: { level?: string }) => {
      if (event === 'headless.pty-fallback' || event === 'implement.result') events.push({ event, data: data ?? {}, level: options?.level });
    }) as never);
    try {
      const result = await defaultSeams({
        ptyAvailable: opts.ptyAvailable,
        ...(opts.runHeadlessGoalLoopPty ? { runHeadlessGoalLoopPty: opts.runHeadlessGoalLoopPty as never } : {}),
        spawnSync: (() => ({ status: 0, stdout: 'GOAL-COMPLETE\n', stderr: '', signal: null })) as never,
      }).implement!({ cwd: process.cwd(), feature: 'x', runId: 'run-pty-fallback-observation' });
      expect(result.summary).toContain('GOAL-COMPLETE');
    } finally {
      log.mockRestore();
    }
    return events;
  }

  for (const [name, options, reason, error] of [
    ['unavailable', { ptyAvailable: () => false }, 'unavailable', undefined],
    ['cap', { ptyAvailable: () => true, runHeadlessGoalLoopPty: async () => { throw new Error('max 8 concurrent PTY shells reached (all detached or actively driven)'); } }, 'cap', 'max 8 concurrent PTY shells reached'],
    ['error', { ptyAvailable: () => true, runHeadlessGoalLoopPty: async () => { throw new Error('invalid preallocated PTY id "self_deadbeef"'); } }, 'error', 'invalid preallocated PTY id'],
  ] as const) {
    it(`${name} 폴백은 warn·구조적 손실·종료 강등 상태를 남긴다`, async () => {
      const events = await observeFallback(options);
      const fallback = events.find((event) => event.event === 'headless.pty-fallback')!;
      const result = events.find((event) => event.event === 'implement.result')!;
      expect(fallback.level).toBe('warn');
      expect(fallback.data).toMatchObject({ reason, degraded });
      if (error) expect(fallback.data.error).toContain(error);
      else expect(fallback.data.error).toBeUndefined();
      expect(result.data).toMatchObject({ transport: 'spawnSync', ptyDegraded: true, ptyDegradedReason: reason });
    });
  }

  it('usable result 없이 정상 반환하면 error로 분류하고 원인을 보존한다', async () => {
    const events = await observeFallback({
      ptyAvailable: () => true,
      runHeadlessGoalLoopPty: async () => ({
        ok: false, reachedCompletion: false, transcript: '', toolCalls: 0,
        timedOut: false, exitReason: 'child-exit', exitCode: 1, ptyId: 'pty-test',
      }),
    });
    const fallback = events.find((event) => event.event === 'headless.pty-fallback')!;
    const result = events.find((event) => event.event === 'implement.result')!;
    expect(fallback.level).toBe('warn');
    expect(fallback.data).toMatchObject({
      reason: 'error', degraded,
      error: 'PTY runner returned no usable result',
    });
    expect(result.data).toMatchObject({ transport: 'spawnSync', ptyDegraded: true, ptyDegradedReason: 'error' });
  });

  it('PTY 성공 반환의 toolCalls 는 이미 센 값과 같다', async () => {
    const returned = await defaultSeams({
      ptyAvailable: () => true,
      runHeadlessGoalLoopPty: async () => ({
        ok: true, reachedCompletion: false, transcript: '화면',
        toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty-test',
      }),
    }).implement({ cwd: process.cwd(), feature: 'x', runId: 'run-toolcalls-pty-return' });
    expect(returned.toolCalls).toBe(0);
  });

  it('spawnSync 폴백 반환의 toolCalls 는 트랜스크립트에서 센 값과 같다', async () => {
    const transcript = 'head\n⏺ Bash(ls)\nGOAL-COMPLETE\n';
    const returned = await defaultSeams({
      ptyAvailable: () => false,
      spawnSync: ((_cmd: string, _args: readonly string[]) => ({
        status: 0, stdout: transcript, stderr: '', signal: null,
      })) as never,
    }).implement({ cwd: process.cwd(), feature: 'x', runId: 'run-toolcalls-sync-return' });
    expect(returned.toolCalls).toBe((transcript.match(/⏺\s+\w+\(/g) || []).length);
  });
});
