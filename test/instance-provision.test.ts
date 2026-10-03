// 파생 우주 물질화 (2026-07-27) — 3층 스위치가 켜진 뒤 self-dev 가 한 건도 완주하지 못한
// 회귀의 근본 수리를 고정한다.
//
// 사슬: 3층 ON → 자식이 `<worktree>/.elanous-test` 로 파생 → 갓 만든 워크트리라 그 우주가
//       비어 있음 → needsOnboarding 참 → 헤드리스 자식이 대화형 마법사를 띄움 → 툴콜 0 ·
//       1200초 타임아웃 · aborted.
//
// 두 방어선을 함께 고정한다:
//   ① 물질화(provisionDerivedUniverse) — 자식이 태어날 우주에 config 를 미리 깐다
//   ② fail-fast(runOnboarding) — 그래도 빈 우주면 즉시·읽히는 에러로 죽는다(무한 대기 금지)

import { setDefaultTimeout, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { setGitCommandRunnerForTesting } from '../src/git-fs/runner.js';
import { provisionDerivedUniverse } from '../src/instance/provision.js';
import { setTreeDerivedTestForTesting } from '../src/instance/resolve.js';
import { spawnSyncText } from '../src/util/spawn-sync-output.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

/** macOS aliases /var → /private/var; run() has already removed the temp tree, so normalise the string (no filesystem lookup). */
const realPath = (p: string | null | undefined): string => String(p).replace(/^\/private(?=\/var\/)/, '');

const { tmpdir } = os;

type ChildProvisionResult = {
  outcome?: string; root?: string | null; treeRoot?: string; hasConfig?: boolean; provider?: unknown;
  needsOnboarding?: boolean; auxCopied?: boolean; derivedUntouched?: boolean;
  threw?: boolean; error?: string;
};

type ChildProcessOutput = {
  status: number | null;
  signal: string | null;
  stdout: string | null;
  stderr: string | null;
};

function parseChildProvisionResult(result: ChildProcessOutput): ChildProvisionResult {
  const stdout = (result.stdout ?? '').trim();
  const diagnostic = `status=${result.status ?? 'null'}, signal=${result.signal ?? 'null'}, stderr=${JSON.stringify(result.stderr ?? '')}`;
  if (!stdout) {
    throw new Error(`instance provision child produced no stdout (${diagnostic})`);
  }

  const output = stdout.split('\n').pop()!;
  try {
    return JSON.parse(output) as ChildProvisionResult;
  } catch (error) {
    throw new Error(`instance provision child produced invalid JSON stdout (${diagnostic}, stdout=${JSON.stringify(output)}): ${String(error)}`);
  }
}

describe('provisionDerivedUniverse — 자식이 태어날 우주를 채운다', () => {
  /** 격리 HOME + 별도 git 트리에서 물질화를 돌리고 결과를 돌려준다.
   *  ⚠️ 서브프로세스 — Bun 의 os.homedir() 는 in-process HOME 변경을 무시한다. */
  async function run(opts: {
    switchOn: boolean; preExisting?: boolean; explicitRoot?: string; blockRootAsFile?: boolean;
  }): Promise<ChildProvisionResult> {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'prov-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'prov-tree-'));
    try {
      mkdirSync(join(home, '.elanous'));
      // 운영 config — 물질화의 원본. provider 가 실려야 자식이 온보딩에 안 걸린다.
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
        instance: { treeDerivedTest: opts.switchOn },
        onboarding: { completed: true },
        llm: { provider: 'openai-codex' },
      }));
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/some/other/leader', promotedAt: 'x' }));
      // 부속 파일 — 물질화가 자격까지 실어야 자식이 인증할 수 있다.
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'fake' }));
      mkdirSync(join(tree, '.git'));   // findTreeRoot 가 트리로 인정하게
      if (opts.blockRootAsFile) {
        // 파생 루트를 **파일**로 점유 — 그 밑에 디렉터리를 못 만드니 복사가 반드시 깨진다.
        writeFileSync(join(tree, '.elanous-test'), 'not a directory');
      }
      if (opts.preExisting) {
        mkdirSync(join(tree, '.elanous-test'));
        writeFileSync(join(tree, '.elanous-test', 'config.json'), JSON.stringify({ marker: 'pre-existing' }));
      }
      // ★ 온보딩 회피의 **실제 조건**은 provider 가 아니라 needsOnboarding 이다(리뷰 must-fix).
      //   sync 가 onboarding.completed 를 떨어뜨리면 provider 가 실려도 자식은 마법사에 걸린다.
      //   그래서 물질화된 config 를 실제 로더로 읽어 needsOnboarding 을 직접 단정한다.
      const script = `
        const {provisionDerivedUniverse}=require('${process.cwd()}/src/instance/provision.ts');
        const {treeDerivedRootFor}=require('${process.cwd()}/src/instance/resolve.ts');
        const {needsOnboarding}=await import('${process.cwd()}/src/onboarding.ts');
        const {getUserConfig}=require('${process.cwd()}/src/user-config.ts');
        const {readFileSync,existsSync}=require('node:fs');
        // ★ fail-open 계약 — 던지면 여기서 잡혀 threw:true 로 보고된다(스폰이 막혔다는 뜻).
        let r, threw=false;
        try { r=provisionDerivedUniverse('${tree}', ${JSON.stringify(opts.explicitRoot ? { explicitRoot: opts.explicitRoot } : {})}); }
        catch(e){ threw=true; r={outcome:'THREW', root:null, error:String(e&&e.message||e)}; }
        const cfgPath=(r.root||'')+'/config.json';
        const has=!!r.root&&existsSync(cfgPath);
        const parsed=has?JSON.parse(readFileSync(cfgPath,'utf-8')):null;
        let onb=null;
        if(has){ try{ onb=needsOnboarding(getUserConfig(cfgPath)); }catch(e){ onb='ERR:'+e.message; } }
        console.log(JSON.stringify({
          outcome:r.outcome, root:r.root, treeRoot:treeDerivedRootFor(process.cwd()), hasConfig:has,
          provider:parsed&&parsed.llm&&parsed.llm.provider,
          needsOnboarding:onb,
          auxCopied: !!r.root && existsSync((r.root||'')+'/auth.json'),
          derivedUntouched: !existsSync('${tree}/.elanous-test'),
          threw, error:r.error,
        }));
      `;
      const r = spawnSync('bun', ['-e', script], {
        encoding: 'utf8', timeout: 60_000, cwd: tree,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '' },
      });
      return parseChildProvisionResult(r);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  }

  test('빈 자식 stdout은 종료 상태와 stderr를 담은 진단으로 실패한다', () => {
    expect(() => parseChildProvisionResult({ status: 0, signal: null, stdout: '', stderr: '' })).toThrow(
      'instance provision child produced no stdout (status=0, signal=null, stderr="")',
    );
  });

  test('비JSON 자식 stdout은 별도 JSON 진단으로 실패한다', () => {
    expect(() => parseChildProvisionResult({ status: 1, signal: 'SIGTERM', stdout: 'not json', stderr: 'child failed' })).toThrow(
      'instance provision child produced invalid JSON stdout (status=1, signal=SIGTERM, stderr="child failed", stdout="not json")',
    );
  });

  test('★빈 파생 우주를 물질화한다 — needsOnboarding 이 실제로 false 가 된다', async () => {
    const out = await run({ switchOn: true });
    expect(out.outcome).toBe('provisioned');
    expect(out.treeRoot?.endsWith('.elanous-test')).toBe(true);
    // macOS: tmpdir() is /var/… while one side comes back as /private/var/… — compare real paths on BOTH sides.
    expect(realPath(out.root)).toBe(realPath(out.treeRoot));
    expect(out.hasConfig).toBe(true);            // ★종전엔 config.json 이 아예 없었다
    // ★이게 이 트랙의 진짜 계약이다 — 자식이 죽던 조건은 provider 부재가 아니라
    //   needsOnboarding(= !onboarding.completed) 이었다. sync 가 그 필드를 떨어뜨리면
    //   provider 가 실려도 자식은 마법사에 걸린다. 그러니 결과를 직접 단정한다.
    expect(out.needsOnboarding).toBe(false);
    expect(out.provider).toBe('openai-codex');   // 운영 provider 가 따라온다
    expect(out.auxCopied).toBe(true);            // 자격(auth.json)도 함께 — 없으면 인증 못 한다
  }, 90_000);

  // ★리졸버 층 우선순위 정합(리뷰 must-fix) — 스포너가 우주를 명시하면 자식은 파생하지
  //   않는다. 그런데도 파생 루트를 물질화하면 **자식이 쓰지도 않을 곳에 자격을 뿌린다**.
  test('★명시 우주가 있으면 파생 루트를 건드리지 않는다 (자격 확산 방지)', async () => {
    const explicitRoot = join(tmpdir(), `explicit-universe-${process.pid}-${Date.now()}`);
    const out = await run({ switchOn: true, explicitRoot });
    expect(out.outcome).toBe('explicit');
    expect(out.root).toBe(explicitRoot);
    expect(out.treeRoot?.endsWith('.elanous-test')).toBe(true);
    expect(out.root).not.toBe(out.treeRoot);
    expect(out.hasConfig).toBe(false);
    expect(out.derivedUntouched).toBe(true);     // ★파생 루트는 생성조차 안 됐다(자격 확산 0)
  }, 90_000);

  test('이미 config 가 있으면 건드리지 않는다 (덮어쓰기 금지)', async () => {
    const out = await run({ switchOn: true, preExisting: true });
    expect(out.outcome).toBe('already');
    // macOS: tmpdir() is /var/… while one side comes back as /private/var/… — compare real paths on BOTH sides.
    expect(realPath(out.root)).toBe(realPath(out.treeRoot));
  }, 90_000);

  // fail-open 계약(리뷰 should-fix) — 물질화가 깨져도 **던지지 않는다**. 부모가 자식의 우주
  // 때문에 죽으면 self-dev 가 통째로 멈춘다(이 트랙이 고치려던 바로 그 증상).
  test('★물질화가 깨져도 던지지 않고 failed 로 돌려준다 (fail-open)', async () => {
    // `.elanous-test` 를 **파일**로 만들어 두면 그 밑에 디렉터리를 못 만든다 = 복사 실패.
    const out = await run({ switchOn: true, blockRootAsFile: true });
    expect(out.outcome).toBe('failed');
    // macOS: tmpdir() is /var/… while one side comes back as /private/var/… — compare real paths on BOTH sides.
    expect(realPath(out.root)).toBe(realPath(out.treeRoot));
    expect(out.threw).toBeFalsy();          // ★던졌다면 스폰이 막힌다
    expect(out.error).toBeTruthy();         // 사유는 남는다(관측 + 반환값)
  }, 90_000);

  // 설정 졸업 1-d(2026-09-26): 3층은 늘 켠다 — 설정 파일의 `instance.treeDerivedTest:false` 는 폐기 키라 «더 끄지 못한다».
  test('폐기 키 treeDerivedTest:false 로는 3층을 끄지 못한다 (늘 켬 · 설정 졸업 1-d)', async () => {
    const out = await run({ switchOn: false });
    expect(out.outcome).toBe('provisioned');
    // macOS: tmpdir() is /var/… while one side comes back as /private/var/… — compare real paths on BOTH sides.
    expect(realPath(out.root)).toBe(realPath(out.treeRoot));
  }, 90_000);
});

describe('provisionDerivedUniverse — 모든 결과를 관측한다', () => {
  type Observation = [string, string, unknown, unknown?];

  function withProvisionFixture<T>(
    switchOn: boolean,
    run: (tree: string) => T,
  ): T {
    const home = mkdtempSync(join(tmpdir(), 'provision-observation-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'provision-observation-tree-'));
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const previousConfigDir = process.env.ELANOUS_CONFIG_DIR;
    const previousNexusDir = process.env.ELANOUS_NEXUS_DIR;
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);
    const previousArgv = process.argv;
    try {
      mkdirSync(join(home, '.elanous'));
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
        instance: { treeDerivedTest: switchOn },
        onboarding: { completed: true },
        llm: { provider: 'openai-codex' },
      }));
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'fake' }));
      mkdirSync(join(tree, '.git'));
      process.argv = [previousArgv[0] ?? 'bun', join(tree, 'bin', 'elanous.mjs')];
      process.env.HOME = home;
      delete process.env.ELANOUS_STATE_DIR;
      delete process.env.ELANOUS_CONFIG_DIR;
      delete process.env.ELANOUS_NEXUS_DIR;
      setTreeDerivedTestForTesting(switchOn);
      return run(tree);
    } finally {
      setTreeDerivedTestForTesting(undefined);
      process.argv = previousArgv;
      homedirSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
      if (previousConfigDir === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previousConfigDir;
      if (previousNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR; else process.env.ELANOUS_NEXUS_DIR = previousNexusDir;
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  }

  function captureObservation<T>(run: () => T): { result: T; calls: Observation[] } {
    const originalLog = debug.log;
    const calls: Observation[] = [];
    debug.log = ((...args: unknown[]) => { calls.push(args as Observation); }) as typeof debug.log;
    try {
      return { result: run(), calls };
    } finally {
      debug.log = originalLog;
    }
  }

  test('ls-files 실패의 비어 있지 않은 stdout은 추적 경로로 소비하지 않는다', () => {
    const failed = withProvisionFixture(true, tree => {
      setGitCommandRunnerForTesting((_cwd, args) => args[0] === 'ls-files'
        ? { status: 17, stdout: '.elanous-test/auth.json\n', stderr: 'ls-files failed' }
        : { status: 0, stdout: '', stderr: '' });
      try {
        return provisionDerivedUniverse(tree);
      } finally {
        setGitCommandRunnerForTesting(undefined);
      }
    });
    expect(failed).toEqual({ outcome: 'provisioned', root: expect.any(String) });

    const succeeded = withProvisionFixture(true, tree => {
      setGitCommandRunnerForTesting((_cwd, args) => args[0] === 'ls-files'
        ? { status: 0, stdout: '.elanous-test/auth.json\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' });
      try {
        return provisionDerivedUniverse(tree);
      } finally {
        setGitCommandRunnerForTesting(undefined);
      }
    });
    expect(succeeded).toEqual({
      outcome: 'failed',
      root: expect.any(String),
      error: expect.stringContaining('.elanous-test/auth.json'),
    });
  });

  test('폐기된 switch-off 설정은 파생 우주를 막지 않는다', () => {
    const { result, calls } = withProvisionFixture(false, tree => {
      mkdirSync(join(tree, '.elanous-test'));
      writeFileSync(join(tree, '.elanous-test', 'config.json'), '{}');
      return captureObservation(() => provisionDerivedUniverse(tree));
    });
    expect(result).toEqual({ outcome: 'already', root: expect.stringContaining('.elanous-test') });
    expect(calls).toEqual([]);
  });

  test('기존 관측 결과와 반환값은 그대로다', () => {
    const explicit = withProvisionFixture(true, tree => captureObservation(() => provisionDerivedUniverse(tree, { explicitRoot: '/caller-supplied-universe' })));
    expect(explicit.result).toEqual({ outcome: 'explicit', root: '/caller-supplied-universe' });
    expect(explicit.calls).toEqual([['instance.provision', 'explicit-root', {
      cwd: expect.any(String), explicit: '/caller-supplied-universe',
      why: '스포너가 우주를 명시 — 파생이 없으므로 물질화 대상 아님(자격 확산 방지)',
    }]]);

    const noTree = withProvisionFixture(true, tree => {
      const originalArgv = process.argv;
      process.argv = [originalArgv[0] ?? 'bun', join(tree, '..', 'not-a-tree', 'elanous.mjs')];
      try { return captureObservation(() => provisionDerivedUniverse(join(tree, '..', 'not-a-tree'))); }
      finally { process.argv = originalArgv; }
    });
    expect(noTree.result).toEqual({ outcome: 'no-tree', root: null });
    expect(noTree.calls).toEqual([['instance.provision', 'no-tree', {
      cwd: expect.any(String), why: '3층 ON 이나 cwd 위쪽에 git 트리가 없어 자식 우주를 특정 못 함',
    }]]);

    const materialized = withProvisionFixture(true, tree => ({ tree, ...captureObservation(() => provisionDerivedUniverse(tree)) }));
    expect(materialized.result).toEqual({ outcome: 'provisioned', root: join(materialized.tree, '.elanous-test') });
    expect(materialized.calls).toEqual([
      ['config.test-sync', 'secrets-stripped', { count: 0, paths: [] }],
      ['instance.provision', 'materialized', {
        cwd: expect.any(String), root: expect.any(String), copied: expect.any(Array), skippedMissing: expect.any(Array), telegramMode: expect.any(String),
        why: '빈 파생 우주 — 물질화 없이는 자식이 온보딩 마법사에 걸려 타임아웃한다',
      }],
    ]);

    const already = withProvisionFixture(true, tree => {
      mkdirSync(join(tree, '.elanous-test'));
      writeFileSync(join(tree, '.elanous-test', 'config.json'), '{}');
      return captureObservation(() => provisionDerivedUniverse(tree));
    });
    expect(already.result).toEqual({ outcome: 'already', root: expect.any(String) });
    expect(already.calls).toEqual([]);

    const unsafe = withProvisionFixture(true, tree => {
      const outside = mkdtempSync(join(tmpdir(), 'provision-observation-outside-'));
      symlinkSync(outside, join(tree, '.elanous-test'));
      try {
        return captureObservation(() => provisionDerivedUniverse(tree));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
    expect(unsafe.result).toEqual({
      outcome: 'failed', root: expect.any(String), error: expect.stringContaining('파생 루트가 심볼릭 링크'),
    });
    expect(unsafe.calls).toEqual([['instance.provision', 'unsafe-root', {
      cwd: expect.any(String), root: expect.any(String), why: expect.any(String),
    }, { level: 'error' }]]);

    const sealFailed = withProvisionFixture(true, tree => {
      mkdirSync(join(tree, '.elanous-test'));
      mkdirSync(join(tree, '.elanous-test', '.gitignore'));
      return captureObservation(() => provisionDerivedUniverse(tree));
    });
    expect(sealFailed.result).toEqual({
      outcome: 'failed', root: expect.any(String), error: '파생 우주를 봉인하지 못했다 — 자격을 놓지 않고 중단한다(유출 방지)',
    });
    expect(sealFailed.calls).toEqual([['instance.provision', 'seal-failed', {
      cwd: expect.any(String), root: expect.any(String),
      error: '파생 우주를 봉인하지 못했다 — 자격을 놓지 않고 중단한다(유출 방지)',
      why: '봉인 없이 복사하면 자식의 git add -A 로 auth.json 이 유출된다',
    }, { level: 'error' }]]);

    const failed = withProvisionFixture(true, tree => {
      mkdirSync(join(tree, '.elanous-test'));
      writeFileSync(join(tree, '.elanous-test', '.gitignore'), '*\n');
      mkdirSync(join(tree, '.elanous-test', 'auth.json'));
      return captureObservation(() => provisionDerivedUniverse(tree));
    });
    expect(failed.result).toEqual({ outcome: 'failed', root: expect.any(String), error: expect.any(String) });
    expect(failed.calls).toEqual([
      ['config.test-sync', 'secrets-stripped', { count: 0, paths: [] }],
      ['instance.provision', 'failed', {
        cwd: expect.any(String), root: expect.any(String), error: expect.any(String),
        why: '물질화 실패 — 자식은 그대로 진행(fail-open)하나 온보딩에 걸릴 수 있다',
      }, { level: 'warn' }],
    ]);
  });
});

// ★ 배선 게이트 (리뷰 must-fix · 2026-07-27) — 위 테스트들은 `provisionDerivedUniverse` 를
//   **직접** 부른다. 그러니 self-implement seam 의 호출이 삭제되거나 spawn **뒤로** 밀려도
//   전부 통과한다(무보호). 이 트랙의 실제 계약은 *"자식이 태어나기 전에 우주가 있다"* 이므로,
//   문자열 검사가 아니라 **자식이 관측한 사실**로 고정한다:
//     stub `bin/elanous.mjs` 가 자기 실행 시점에 `<tree>/.elanous-test/config.json` 의 존재를
//     기록 → 한 줄이라도 false 면 순서가 깨진 것이다(= spawn 후 물질화 = 회귀 재발).
describe('self-implement seam 배선 — 자식은 이미 채워진 우주에서 태어난다', () => {
  test('★stub 자식이 spawn 시점에 config 를 본다 (호출 삭제·순서 역전 동시 차단)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'wire-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'wire-tree-'));
    const stub = mkdtempSync(join(tmpdir(), 'wire-bin-'));
    try {
      mkdirSync(join(home, '.elanous'));
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
        instance: { treeDerivedTest: true },
        onboarding: { completed: true },
        llm: { provider: 'openai-codex' },
      }));
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/some/other/leader', promotedAt: 'x' }));
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'fake' }));
      // ⚠️ PTY 전송은 `process.env` 가 아니라 **부팅 시 캡처한 로그인쉘 env** 를 쓴다(buildPtyEnv·F3).
      //    HOME 을 격리했으므로 그 쉘은 실제 사용자의 PATH 를 못 본다 → `command not found: bun`.
      //    격리 HOME 의 쉘 초기화 파일에 현재 런타임 경로를 심어 전송과 무관하게 자식이 뜨게 한다.
      const { dirname } = await import('node:path');
      writeFileSync(join(home, '.zshenv'), `export PATH="${dirname(process.execPath)}:$PATH"\n`);
      writeFileSync(join(home, '.profile'), `export PATH="${dirname(process.execPath)}:$PATH"\n`);
      // 진짜 git repo — worktreeHasChanges 가 여기서 git 을 돌린다.
      spawnSync('git', ['init', '-q'], { cwd: tree });
      const marker = join(stub, 'observed.jsonl');
      // stub 코딩에이전트 — 아무것도 안 하고, **자기가 본 우주 상태만** 남기고 즉시 끝난다.
      mkdirSync(join(stub, 'bin'));
      writeFileSync(join(stub, 'bin', 'elanous.mjs'),
        'import {existsSync,appendFileSync} from "node:fs";\n'
        + `appendFileSync(${JSON.stringify(marker)}, JSON.stringify({`
        + `seen: existsSync(${JSON.stringify(join(tree, '.elanous-test', 'config.json'))})}) + "\\n");\n`
        + 'process.exit(0);\n');

      const script = `
        const {defaultSeams}=require('${process.cwd()}/src/self-implement/seams.ts');
        const seams=defaultSeams({elanousBinRoot:'${stub}', implementMaxWaitSec:3});
        seams.implement({cwd:'${tree}', feature:'noop'}).then(()=>console.log('DONE'),e=>console.log('DONE:'+e));
      `;
      spawnSync('bun', ['-e', script], {
        encoding: 'utf8', timeout: 150_000, cwd: tree,
        env: {
          ...process.env, HOME: home,
          ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '', ELANOUS_NEST_DEPTH: '0',
        },
      });

      // 자식이 한 번도 안 떴다면 이 테스트는 아무것도 증명하지 못한다 — 통과로 보면 안 된다.
      expect(existsSync(marker)).toBe(true);
      const seen = readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { seen: boolean });
      expect(seen.length).toBeGreaterThanOrEqual(1);
      // ★ 전부 true 여야 한다. 물질화가 spawn 뒤로 밀리면 첫 줄이 false 로 떨어진다.
      expect(seen.every(s => s.seen)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  }, 180_000);
});

// ★ 위 배선 테스트가 잡아낸 결함(2026-07-27) — 물질화가 워크트리 안에 `.elanous-test/` 를 남기는데
//   self-build 성공 판정이 artifact-first(`changed && !timedOut`)라, 자식이 **툴콜 0 으로 아무것도
//   안 해도** 우리가 깐 디렉터리 때문에 `ok:true` 가 됐다(합성 repo 실측: `변경: yes · 툴콜 0`).
//   elanous 레포는 .gitignore 의 `/.elanous-test/` 가 우연히 가려주지만 **외부 repo 개발 경로엔 그 줄이 없다**.
describe('worktreeHasChanges — 우리가 흘린 것을 자식 산출물로 세지 않는다', () => {
  test('★.elanous-test 만 있으면 변경 없음 · 실제 파일이 생기면 변경 있음', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const repo = mkdtempSync(join(tmpdir(), 'leav-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      const { worktreeHasChanges, changedFiles } = await import('../src/self-implement/seams.js');
      expect(worktreeHasChanges(repo)).toBe(false);          // 빈 repo — 당연히 없다
      // 물질화가 남긴 것만 있는 상태 = 자식은 아무것도 안 했다.
      mkdirSync(join(repo, '.elanous-test'));
      writeFileSync(join(repo, '.elanous-test', 'config.json'), '{}');
      expect(worktreeHasChanges(repo)).toBe(false);          // ★종전엔 true(공수표 성공)
      expect(changedFiles(repo)).toEqual([]);                // 리뷰어도 이걸 변경으로 보면 안 된다
      // 자식이 실제로 뭔가 쓰면 그건 변경이다 — 배제가 과하면 진짜 산출물을 놓친다.
      writeFileSync(join(repo, 'real.ts'), 'export const x = 1;\n');
      expect(worktreeHasChanges(repo)).toBe(true);
      expect(changedFiles(repo)).toContain('real.ts');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

// ★★ 자격 유출 차단 (리뷰 must-fix · 2026-07-27) — 물질화는 워크트리 **안**에 운영 auth.json 을
//    놓는다. 부모의 status 호출에서만 숨기는 pathspec 은 **자식의 git 에는 아무 효력이 없다**.
//    self-build 자식은 스스로 커밋하는 에이전트이므로 `git add -A` 한 번이면 남의 레포 히스토리에
//    자격이 박힌다. 그래서 status 가 아니라 **staged·committed 까지** 단정한다.
describe('물질화 봉인 — 자식의 git add -A 로도 자격이 새지 않는다', () => {
  test('★add -A → commit 해도 .elanous-test 는 한 파일도 추적되지 않는다', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'seal-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'seal-tree-'));
    try {
      mkdirSync(join(home, '.elanous'));
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
        instance: { treeDerivedTest: true }, onboarding: { completed: true }, llm: { provider: 'openai-codex' },
      }));
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
      spawnSync('git', ['init', '-q'], { cwd: tree });
      // ⚠️ 외부 repo 를 모사한다 — `.gitignore` 에 `/.elanous-test/` 가 **없다**(elanous 레포만 그 줄이 있다).
      writeFileSync(join(tree, 'README.md'), '# external repo\n');

      const script = `
        const {provisionDerivedUniverse}=require('${process.cwd()}/src/instance/provision.ts');
        console.log(JSON.stringify(provisionDerivedUniverse('${tree}')));
      `;
      spawnSync('bun', ['-e', script], {
        encoding: 'utf8', timeout: 60_000, cwd: tree,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '' },
      });

      // 자식이 하는 짓 그대로 — 전부 담고 커밋한다.
      spawnSync('git', ['add', '-A'], { cwd: tree });
      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: tree, encoding: 'utf8' }).stdout ?? '';
      expect(staged).toContain('README.md');            // 정상 파일은 담긴다(봉인이 과하지 않다)
      expect(staged).not.toMatch(/\.elanous-test/);       // ★자격은 담기지 않는다
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x'], { cwd: tree });
      expect(() => spawnSyncText('git', ['ls-files', '--not-a-valid-option'], { cwd: tree, encoding: 'utf8' }))
        .toThrow(/git ls-files --not-a-valid-option failed \(status=/);
      const tracked = spawnSyncText('git', ['ls-files'], { cwd: tree, encoding: 'utf8' });
      expect(tracked).toContain('README.md');
      expect(tracked).not.toMatch(/\.elanous-test/);      // ★히스토리에도 없다
      // 그리고 봉인은 자기 자신도 숨긴다 — 남의 레포 status 에 우리 파일이 뜨면 안 된다.
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: tree, encoding: 'utf8' }).stdout ?? '';
      expect(st).not.toMatch(/\.elanous-test/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  }, 90_000);

  // ★ 3R 리뷰 must-fix — 존재 확인만으로 봉인을 인정하면 **구버전 우주가 그대로 샌다**.
  //   봉인 이전 버전이 깐 `.elanous-test` 에는 `.gitignore` 가 없거나(→ 신규 생성) 있어도 `*` 가
  //   없을 수 있고, `*` 뒤에 되살림(`!auth.json`)이 오면 git 은 **마지막 패턴**을 따른다.
  test('★기존 .gitignore 에 * 가 없거나 되살림이 뒤따르면 봉인을 채운다 (소급)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    for (const preSeal of ['# 아무 패턴도 없다\n', '*\n!auth.json\n']) {
      const home = mkdtempSync(join(tmpdir(), 'ret-home-'));
      const tree = mkdtempSync(join(tmpdir(), 'ret-tree-'));
      try {
        mkdirSync(join(home, '.elanous'));
        writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
          instance: { treeDerivedTest: true }, onboarding: { completed: true }, llm: { provider: 'openai-codex' },
        }));
        writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
        writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
        spawnSync('git', ['init', '-q'], { cwd: tree });
        // 봉인 이전 버전이 남긴 우주 — 자격이 **이미** 놓여 있고 .gitignore 는 봉인이 아니다.
        mkdirSync(join(tree, '.elanous-test'));
        writeFileSync(join(tree, '.elanous-test', 'config.json'), '{}');
        writeFileSync(join(tree, '.elanous-test', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
        writeFileSync(join(tree, '.elanous-test', '.gitignore'), preSeal);

        spawnSync('bun', ['-e',
          `const {provisionDerivedUniverse}=require('${process.cwd()}/src/instance/provision.ts');`
          + `provisionDerivedUniverse('${tree}');`], {
          encoding: 'utf8', timeout: 60_000, cwd: tree,
          env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '' },
        });

        spawnSync('git', ['add', '-A'], { cwd: tree });
        const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: tree, encoding: 'utf8' }).stdout ?? '';
        expect(staged).not.toMatch(/\.elanous-test/);   // ★소급 봉인이 안 되면 여기서 샌다
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(tree, { recursive: true, force: true });
      }
    }
  }, 120_000);

  // ★ 3R 리뷰 must-fix — 봉인이 실패했는데 복사가 진행되면 **자격만 남는다**. 순서를 뒤집어
  //   (봉인 → 복사) "봉인 못 하면 자격을 아예 놓지 않는다"를 성립시켰고, 그걸 여기서 단정한다.
  test('★봉인이 불가능하면 자격을 놓지 않는다 (스폰은 계속 · 노출은 fail-closed)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'nose-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'nose-tree-'));
    try {
      mkdirSync(join(home, '.elanous'));
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
        instance: { treeDerivedTest: true }, onboarding: { completed: true }, llm: { provider: 'openai-codex' },
      }));
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
      spawnSync('git', ['init', '-q'], { cwd: tree });
      // `.gitignore` 자리를 **디렉터리**로 점유 — 봉인 기록이 반드시 실패한다.
      mkdirSync(join(tree, '.elanous-test'), { recursive: true });
      mkdirSync(join(tree, '.elanous-test', '.gitignore'));

      const out = spawnSync('bun', ['-e',
        `const {provisionDerivedUniverse}=require('${process.cwd()}/src/instance/provision.ts');`
        + `let threw=false,r;try{r=provisionDerivedUniverse('${tree}');}catch(e){threw=true;r={outcome:'THREW'};}`
        + `console.log(JSON.stringify({outcome:r.outcome,threw}));`], {
        encoding: 'utf8', timeout: 60_000, cwd: tree,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '' },
      });
      const res = JSON.parse((out.stdout ?? '').trim().split('\n').pop() ?? '{}') as { outcome?: string; threw?: boolean };
      expect(res.threw).toBe(false);            // 스폰은 막히지 않는다(fail-open)
      expect(res.outcome).toBe('failed');
      // ★★ 핵심 — 봉인이 안 된 채로 자격이 놓이면 안 된다.
      expect(existsSync(join(tree, '.elanous-test', 'auth.json'))).toBe(false);
      expect(existsSync(join(tree, '.elanous-test', 'config.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  }, 90_000);

  // ★ 5R 리뷰 must-fix — `already`(구버전이 깐 우주) + 봉인 실패 + 스폰 지속. 자격이 **이미**
  //   거기 있는데 봉인은 안 되고 스폰은 못 막으니(fail-open), 남은 레버는 **자격을 치우는 것**뿐이다.
  //   자식의 인증 실패가 자격이 남의 레포에 박히는 것보다 낫다.
  test('★기존 우주를 봉인 못 하면 자격을 격리한다 (스폰은 계속·노출은 0)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'quar-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'quar-tree-'));
    try {
      mkdirSync(join(home, '.elanous'));
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
        instance: { treeDerivedTest: true }, onboarding: { completed: true }, llm: { provider: 'openai-codex' },
      }));
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
      spawnSync('git', ['init', '-q'], { cwd: tree });
      // 봉인 이전 버전이 깐 우주 — config 가 있으니 `already` 로 가고, 자격이 이미 놓여 있다.
      mkdirSync(join(tree, '.elanous-test'));
      writeFileSync(join(tree, '.elanous-test', 'config.json'), '{}');
      writeFileSync(join(tree, '.elanous-test', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
      mkdirSync(join(tree, '.elanous-test', '.gitignore'));   // 봉인 기록을 불가능하게

      const out = spawnSync('bun', ['-e',
        `const {provisionDerivedUniverse}=require('${process.cwd()}/src/instance/provision.ts');`
        + `let threw=false,r;try{r=provisionDerivedUniverse('${tree}');}catch(e){threw=true;r={outcome:'THREW'};}`
        + `console.log(JSON.stringify({outcome:r.outcome,threw}));`], {
        encoding: 'utf8', timeout: 60_000, cwd: tree,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '' },
      });
      const res = JSON.parse((out.stdout ?? '').trim().split('\n').pop() ?? '{}') as { outcome?: string; threw?: boolean };
      expect(res.threw).toBe(false);       // 스폰은 계속된다(fail-open 유지)
      expect(res.outcome).toBe('failed');
      // ★★ 핵심 — 미봉인 자격이 남아 있으면 안 된다.
      expect(existsSync(join(tree, '.elanous-test', 'auth.json'))).toBe(false);
      // 자식이 하는 짓 그대로 해도 자격이 안 실린다.
      spawnSync('git', ['add', '-A'], { cwd: tree });
      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: tree, encoding: 'utf8' }).stdout ?? '';
      expect(staged).not.toMatch(/auth\.json/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  }, 90_000);

  // ★ 4R 리뷰 must-fix — `.gitignore` 는 **추적되지 않는** 파일에만 효력이 있다. 외부 repo 가
  //   `.elanous-test/auth.json` 을 이미 커밋해 뒀다면 우리가 그 위에 운영 자격을 덮어써도 봉인이
  //   무력하고, 자식의 `git add -A` 에 그대로 실린다. 심볼릭 링크면 자격이 딴 데로 나간다.
  test('★이미 추적 중이거나 링크면 자격을 놓지 않는다 (봉인 무력 구간)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    for (const mode of ['tracked', 'symlink'] as const) {
      const home = mkdtempSync(join(tmpdir(), 'unsafe-home-'));
      const tree = mkdtempSync(join(tmpdir(), 'unsafe-tree-'));
      const away = mkdtempSync(join(tmpdir(), 'unsafe-away-'));
      try {
        mkdirSync(join(home, '.elanous'));
        writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
          instance: { treeDerivedTest: true }, onboarding: { completed: true }, llm: { provider: 'openai-codex' },
        }));
        writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
        writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ token: 'SUPER-SECRET' }));
        spawnSync('git', ['init', '-q'], { cwd: tree });
        if (mode === 'tracked') {
          // 외부 repo 가 이 경로를 **커밋해 둔** 상태 — 봉인은 여기에 아무 효력이 없다.
          mkdirSync(join(tree, '.elanous-test'));
          writeFileSync(join(tree, '.elanous-test', 'auth.json'), '{"token":"harmless-placeholder"}');
          spawnSync('git', ['add', '-A'], { cwd: tree });
          spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pre'], { cwd: tree });
        } else {
          symlinkSync(away, join(tree, '.elanous-test'));   // 자격이 트리 밖으로 나가는 경로
        }

        const out = spawnSync('bun', ['-e',
          `const {provisionDerivedUniverse}=require('${process.cwd()}/src/instance/provision.ts');`
          + `console.log(JSON.stringify(provisionDerivedUniverse('${tree}')));`], {
          encoding: 'utf8', timeout: 60_000, cwd: tree,
          env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '' },
        });
        const res = JSON.parse((out.stdout ?? '').trim().split('\n').pop() ?? '{}') as { outcome?: string; error?: string };
        expect(res.outcome).toBe('failed');
        expect(res.error).toBeTruthy();
        if (mode === 'tracked') {
          // ★추적 파일을 운영 자격으로 덮어쓰지 않았다 — 원래 내용 그대로다.
          expect(readFileSync(join(tree, '.elanous-test', 'auth.json'), 'utf-8')).not.toContain('SUPER-SECRET');
        } else {
          expect(existsSync(join(away, 'auth.json'))).toBe(false);   // ★링크 너머로 안 나갔다
        }
      } finally {
        for (const d of [home, tree, away]) rmSync(d, { recursive: true, force: true });
      }
    }
  }, 120_000);
});

describe('runOnboarding — 자율 컨텍스트 fail-fast', () => {
  test('★self-build 자식은 마법사 대신 즉시 읽히는 에러로 죽는다', async () => {
    const prev = process.env.ELANOUS_RUN_CONTEXT;
    try {
      process.env.ELANOUS_RUN_CONTEXT = 'self-build';
      const { runOnboarding } = await import('../src/onboarding.js');
      // io 주입 없이(=대화형 진입) 부르면 던져야 한다. 종전엔 여기서 피커를 띄우고
      // 아무도 없는 화면의 입력을 기다렸다(툴콜 0 · 타임아웃).
      await expect(runOnboarding()).rejects.toThrow(/--non-interactive/);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_RUN_CONTEXT; else process.env.ELANOUS_RUN_CONTEXT = prev;
    }
  });

  test('거부 판정은 주입되지 않은 production 비-TTY도 막고, 주입 IO를 보존한다', async () => {
    const { shouldRefuseInteractiveOnboarding: refuse } = await import('../src/onboarding.js');
    expect(refuse({ ioInjected: false, ctx: 'production', stdinIsTTY: false })).toBe(true);
    expect(refuse({ ioInjected: true, ctx: 'production', stdinIsTTY: false })).toBe(false);
    expect(refuse({ ioInjected: false, ctx: 'production', stdinIsTTY: true })).toBe(false);
    expect(refuse({ ioInjected: false, ctx: 'self-build', stdinIsTTY: true })).toBe(true);
  });

  test('★자율이어도 IO 가 주입되면 가드가 안 잡는다 (비대화형 진입 보존)', async () => {
    const prev = process.env.ELANOUS_RUN_CONTEXT;
    try {
      process.env.ELANOUS_RUN_CONTEXT = 'self-build';
      const { runOnboarding } = await import('../src/onboarding.js');
      // 자율 컨텍스트인데도 IO 가 주입됐으므로 **가드는 침묵해야** 한다. 마법사 자체는
      // 빈 io/막힌 경로 때문에 어차피 실패하니, 여기서 보는 건 **실패 사유**다.
      // 가드가 IO 축을 무시하면 runOnboardingNonInteractive 같은 정당한 무인 진입이 죽는다.
      let msg = '';
      try { await runOnboarding({ io: {} as never, path: '/dev/null/nope/config.json' }); }
      catch (e) { msg = e instanceof Error ? e.message : String(e); }
      expect(msg).not.toMatch(/자율 컨텍스트/);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_RUN_CONTEXT; else process.env.ELANOUS_RUN_CONTEXT = prev;
    }
  });
});
