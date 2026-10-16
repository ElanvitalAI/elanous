// Self-Evolution SE3b 격리 인스턴스 단위테스트 — 주입 worktree(무git·tmp fs).
import { describe, test, expect } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync as fsExists } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setGitCommandRunnerForTesting } from '../../git-fs/runner.js';
import { createTempGitRemote } from '../../ux-sim/temp-git-remote.js';
import {
  isolatedPort, planIsolatedInstance, assertIsolationSafe, buildTestConfig,
  createIsolatedInstance, ensureWorktreeDeps, PRODUCTION_PORT, ISOLATED_PORT_BASE,
  defaultMergeMainIntoWorktree,
} from './isolated-instance.js';

const REPO = '/Users/x/source/leader/monad-agent';

describe('isolatedPort', () => {
  test('정식 포트 회피 + 범위 내', () => {
    for (const slug of ['a', 'conversation-memory', 'codex-fork', 'zzz-long-slug-here']) {
      const p = isolatedPort(slug);
      expect(p).not.toBe(PRODUCTION_PORT);
      expect(p).toBeGreaterThanOrEqual(ISOLATED_PORT_BASE);
      expect(p).toBeLessThan(ISOLATED_PORT_BASE + 84);
    }
  });
  test('결정론(같은 slug 같은 포트)', () => {
    expect(isolatedPort('memory')).toBe(isolatedPort('memory'));
  });
});

describe('planIsolatedInstance', () => {
  test('브랜치·경로·config-dir 규칙', () => {
    // ⛔⭐ 뿌리를 «주입»한다 — 종전 판은 전역 config 을 읽고 `~/.elanous/worktrees` 를 기대해서
    //    ***사용자가 `worktreeRoot` 를 커스텀하면 실패하는 «비격리» 테스트***였다(리뷰 4R must-fix ②).
    //    이 테스트가 재는 것은 「뿌리가 무엇인가」가 아니라 「브랜치·경로·config-dir 규칙」이다.
    const root = mkdtempSync(join(tmpdir(), 'se-plan-root-'));
    try {
      const plan = planIsolatedInstance(REPO, 'conv-memory', root);
      expect(plan.branch).toBe('se/conv-memory');
      expect(plan.worktreePath.startsWith(`${root}/`)).toBe(true);
      expect(plan.worktreePath).toContain('/monad-agent.worktrees/');
      expect(plan.worktreePath).toContain('se-conv-memory');
      expect(plan.configDir).toContain(plan.worktreePath);
      expect(plan.configDir).toContain('.elanous-se');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assertIsolationSafe', () => {
  test('정상 → 통과', () => {
    expect(() => assertIsolationSafe(planIsolatedInstance(REPO, 'x'))).not.toThrow();
  });
  test('정식 포트 → throw', () => {
    const plan = { ...planIsolatedInstance(REPO, 'x'), port: PRODUCTION_PORT };
    expect(() => assertIsolationSafe(plan)).toThrow(/정식 포트/);
  });
  test('config-dir 홈 오염 → throw', () => {
    const plan = { ...planIsolatedInstance(REPO, 'x'), configDir: `${process.env.HOME}/.elanous/x`, worktreePath: `${process.env.HOME}/.elanous` };
    expect(() => assertIsolationSafe(plan)).toThrow();
  });
  test('se/ 접두 아님 → throw', () => {
    const plan = { ...planIsolatedInstance(REPO, 'x'), branch: 'main' };
    expect(() => assertIsolationSafe(plan)).toThrow(/se\//);
  });
});

describe('buildTestConfig — disarmed', () => {
  test('매매/발송/자율 전부 off', () => {
    const c = buildTestConfig(31420) as any;
    expect(c.__self_evolution_isolated).toBe(true);
    expect(c.nexus.httpPort).toBe(31420);
    expect(c.dispatch.enabled).toBe(false);
    expect(c.finance.dispatch.enabled).toBe(false);
    expect(c.autopilot.merge.armed).toBe(false);
    expect(c.autopilot.reboot.armed).toBe(false);
  });
  test('부팅 필수 키 상속(llm) — 데몬 부팅 게이트 통과', () => {
    const c = buildTestConfig(31421, { llm: { provider: 'openai-codex', apiKey: 'sk-x' }, mcp: { servers: [] } }) as any;
    expect(c.llm.provider).toBe('openai-codex');
    expect(c.llm.apiKey).toBe('sk-x');
    expect(c.mcp).toBeDefined();
  });
  test('★ 상속이 disarmed 를 재-arm 못 함(override 우선·정식 분리 보증)', () => {
    // 정식 config 이 finance/dispatch armed 여도 격리는 강제 disarmed.
    const c = buildTestConfig(31422, {
      llm: { provider: 'anthropic', apiKey: 'k' },
      finance: { dispatch: { enabled: true } },   // 재-arm 시도
      dispatch: { enabled: true },
    }) as any;
    expect(c.dispatch.enabled).toBe(false);
    expect(c.finance.dispatch.enabled).toBe(false);
    expect(c.llm.provider).toBe('anthropic');  // llm 은 상속됨
  });
  test('preserves inherited sibling tools and self-implement settings while overriding worktree root', () => {
    const c = buildTestConfig(31423, {
      tools: {
        deferred: { mode: 'manual' },
        selfImplement: { observeOnly: true, childInstanceMode: 'inherit', worktreeRoot: '/old/root' },
      },
    }, '/isolated/root') as any;
    expect(c.tools.deferred).toEqual({ mode: 'manual' });
    expect(c.tools.selfImplement.observeOnly).toBe(true);
    expect(c.tools.selfImplement.childInstanceMode).toBe('inherit');
    expect(c.tools.selfImplement.worktreeRoot).toBe('/isolated/root');
  });
});

describe('ensureWorktreeDeps — node_modules 심링크(dogfood 발견)', () => {
  test('정식 node_modules 와 PWA 산출물을 worktree 로 심링크', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'se-nm-'));
    try {
      const repoRoot = join(tmp, 'repo');
      mkdirSync(join(repoRoot, 'node_modules', 'somepkg'), { recursive: true });
      mkdirSync(join(repoRoot, 'apps', 'pwa', 'out'), { recursive: true });
      const wt = join(tmp, 'repo.worktrees', 'se-x');
      mkdirSync(wt, { recursive: true });
      const plan = { ...planIsolatedInstance(repoRoot, 'x'), worktreePath: wt };
      ensureWorktreeDeps(repoRoot, plan);
      expect(fsExists(join(wt, 'node_modules', 'somepkg'))).toBe(true); // 심링크 통해 보임
      expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(wt, 'apps', 'pwa', 'out')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  test('정식 node_modules 없으면 no-op(fail-soft)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'se-nm2-'));
    const plan = { ...planIsolatedInstance(join(tmp, 'repo'), 'x'), worktreePath: join(tmp, 'wt') };
    mkdirSync(plan.worktreePath, { recursive: true });
    expect(() => ensureWorktreeDeps(join(tmp, 'repo'), plan)).not.toThrow();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('createIsolatedInstance — 주입 worktree', () => {
  test('worktree 생성 호출 + 테스트 config 기록', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'se-iso-'));
    const repoRoot = join(tmp, 'monad-agent');
    // ⛔⭐ 뿌리를 «주입»한다 — 안 주면 전역 config(기본 `~/.elanous/worktrees`)을 읽어
    //    실제 홈 디렉터리 아래에 worktree·config.json 을 만들고 `rmSync(tmp)` 로는 안 지워진다.
    //    종전 판이 정확히 그랬다(리뷰 must-fix ①).
    const injectedRoot = join(tmp, 'wt-root');
    let created: any = null;
    // createWorktree 주입 — 실 git 대신 디렉토리만 만들어 config 기록 검증.
    const mkWt = (opts: any) => {
      created = opts;
      return { path: planIsolatedInstance(repoRoot, 'x', injectedRoot).worktreePath, branch: opts.branch, base: 'HEAD' };
    };
    // ⛔⭐⭐ 종전 판은 「홈 뿌리가 «없었으면» 없어야 한다」였는데, 그 디렉터리는 «항상 존재»하므로
    //    ***그 검사는 항상 건너뛰었다 — 죽은 검사였다***(리뷰 4R must-fix ①).
    // 🩹 그래서 「전후 «하위 경로» 스냅샷이 같은가」로 바꾼다 — 기존 홈 아래에 «새» 잔존물이
    //    생기는 회귀를 실제로 잡는다.
    const homeWorktreeRoot = join(homedir(), '.elanous', 'worktrees');
    // ⛔⭐ «직계 항목»만 세면 기존 repository-scope 폴더 «안»에 새 산출물이 생기는 회귀를 놓친다
    //    (리뷰 8R must-fix ① — 그 폴더 이름은 안 늘고 그 «아래»가 는다). ⇒ 재귀로 센다.
    const snapshotHome = (): string[] => {
      const walk = (dir: string, depth: number): string[] => {
        if (depth > 3) return [dir];
        try {
          return readdirSync(dir, { withFileTypes: true })
            .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), depth + 1) : [join(dir, e.name)]));
        } catch { return []; }
      };
      return walk(homeWorktreeRoot, 0).sort();
    };
    const homeBefore = snapshotHome();
    const plan = createIsolatedInstance(repoRoot, 'x', undefined, { createWorktree: mkWt as any, worktreeRoot: injectedRoot });
    expect(created.branch).toBe('se/x');
    // ⭐ 주입한 뿌리가 «세 자리 전부»에 같은 값으로 내려갔나 — plan · createWorktree · 기록된 config.
    expect(created.worktreeRoot).toBe(injectedRoot);
    expect(plan.worktreePath.startsWith(injectedRoot)).toBe(true);
    // ★ 재실행 견고화(대표 2026-07-12) — SE 격리는 고아 브랜치/경로를 흡수하도록 resetExisting.
    expect(created.resetExisting).toBe(true);
    const cfgPath = join(plan.configDir, 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.__self_evolution_isolated).toBe(true);
    expect(cfg.tools.selfImplement.worktreeRoot).toBe(injectedRoot);
    expect(cfg.nexus.httpPort).toBe(plan.port);
    // ⛔⭐⭐ 회귀 못박기 — 이 테스트가 «사용자 홈» 아래에 «새» 항목을 만들지 않았다.
    expect(snapshotHome()).toEqual(homeBefore);
    rmSync(tmp, { recursive: true, force: true });
  });

  test('★ defaultMergeMainIntoWorktree — 실패 status·stderr 충돌 신호를 보존해 abort한다 (주입 runner)', () => {
    const calls: Array<{ cwd: string; args: string[]; encoding: unknown }> = [];
    setGitCommandRunnerForTesting((cwd, args, options) => {
      calls.push({ cwd, args, encoding: options.encoding });
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'merge' && args[1] === '--abort') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'CONFLICT (content): merge conflict in src/a.ts' };
    });
    try {
      expect(defaultMergeMainIntoWorktree('/tmp/worktree')).toBe('conflict-abort');
      expect(calls).toEqual([
        { cwd: '/tmp/worktree', args: ['fetch', 'origin', 'main', '--quiet'], encoding: 'utf8' },
        { cwd: '/tmp/worktree', args: ['merge', '--no-edit', '-X', 'theirs', 'origin/main'], encoding: 'utf8' },
        { cwd: '/tmp/worktree', args: ['merge', '--abort'], encoding: 'utf8' },
      ]);
    } finally {
      setGitCommandRunnerForTesting(undefined);
    }
  });

  test('★ defaultMergeMainIntoWorktree — fetch 실패 → error / up-to-date / merged (실 git)', () => {
    const fixture = createTempGitRemote();
    // 함수의 실제 Git 명령을 실행하되 환경은 이 runner 한 곳에만 준다(프로세스 env 불변).
    setGitCommandRunnerForTesting((cwd, args, options) => {
      const result = spawnSync('git', args, { ...options, cwd, env: { ...process.env, ...fixture.gitEnv } });
      return { status: result.status, stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '' };
    });
    try {
      expect(defaultMergeMainIntoWorktree(fixture.checkout)).toBe('up-to-date');
      fixture.advanceMain(1);
      expect(defaultMergeMainIntoWorktree(fixture.checkout)).toBe('merged');
      fixture.removeOrigin();
      expect(defaultMergeMainIntoWorktree(fixture.checkout)).toBe('error');
    } finally {
      setGitCommandRunnerForTesting(undefined);
      fixture.cleanup();
    }
  });
});
