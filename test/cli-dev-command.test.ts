// U4 — `elanous dev` 실험 엔트리 실행수준 통합(subprocess). Commander 등록·옵션 검증·종료코드 회귀.
//   self dispatch는 실제 worktree spawn을 피하고, shell-drive 성공 경로는 짧은 실제 자식으로 검증한다.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { snapshotWorktreeRoot, sweepNewEmptyWorktreeRoots } from './helpers/worktree-root-leak.js';

// ⛔ 이 파일은 `elanous dev` 를 «자식 프로세스»로 돌리므로, 그 자식이 만든 인스턴스 뿌리를
//   fixture 의 cleanup 이 «원리상» 못 잡는다(부모에게 그 경로가 없다).
//   🩸 실측 2026-09-08: 이 파일을 한 번 돌리면 `elanous-dev-behind-*` 가 «2개» 늘었다(36→38).
let worktreeRootBefore: ReadonlySet<string> = new Set();
beforeAll(() => { worktreeRootBefore = snapshotWorktreeRoot(); });
afterAll(() => { sweepNewEmptyWorktreeRoots(worktreeRootBefore); });

const CLI = resolve(import.meta.dir, '..', 'bin', 'elanous.mjs');
const childRoot = mkdtempSync(join(tmpdir(), 'elanous-cli-dev-child-'));
const childHome = join(childRoot, 'home');
const childConfig = join(childRoot, 'config');
const childState = join(childRoot, 'state');
for (const dir of [childHome, childConfig, childState]) mkdirSync(dir, { recursive: true });
writeFileSync(join(childState, 'config.json'), '{}');
afterAll(() => rmSync(childRoot, { recursive: true, force: true }));

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI|ANTHROPIC|CLAUDE|GOOGLE|GEMINI|GROK|XAI|OPENROUTER|AZURE_OPENAI|AWS|CODEX)_/.test(key)
      || /^(?:ELANOUS_(?:RUN_ID|TEST_HOME|CONFIG_DIR|STATE_DIR|STATE_DIR_SOURCE|CODEX_ACCOUNT|LLM_API_KEY)|CODEX_HOME)$/.test(key)) delete env[key];
  }
  return {
    ...env, NODE_ENV: 'development', HOME: childHome, XDG_CONFIG_HOME: childConfig, XDG_STATE_HOME: childState, ELANOUS_TEST_HOME: childHome,
    ELANOUS_CONFIG_DIR: childConfig, ELANOUS_STATE_DIR: childState,
    CODEX_HOME: join(childHome, '.codex'), ...extra,
  };
}

function assertNoProductionConfigMaterialization(output: string): void {
  expect(output).not.toContain('[test-isolation] 운영 config 물질화');
}

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync('bun', [CLI, `--test=${childState}`, ...args], { encoding: 'utf-8', env: childEnv({ NODE_ENV: 'test' }) });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assertNoProductionConfigMaterialization(out);
  return { code: r.status ?? 1, out };
}

function runIsolatedCli(args: string[], cwd?: string): { code: number; out: string } {
  const r = spawnSync('bun', [CLI, `--test=${childState}`, ...args], { cwd, encoding: 'utf-8', env: childEnv({ NODE_ENV: 'test' }) });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assertNoProductionConfigMaterialization(out);
  return { code: r.status ?? 1, out };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function createGitFixture(behind: number | 'no-origin'): { invoked: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'elanous-dev-behind-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const invoked = join(root, 'invoked');
  // ⛔ 이식성(무인 리뷰 should-fix) — bare 의 기본 브랜치는 `init.defaultBranch` 를 따른다.
  //   그 값이 `master` 인 환경에서는 bare 의 HEAD 가 `refs/heads/master` 를 가리키는데 우리가 미는 것은
  //   `main` 이라, clone 이 **체크아웃 없는 트리**를 만들고 fixture 가 이 저장소 밖에서만 깨진다.
  //   ⇒ bare 쪽 기본 브랜치를 명시해 환경 설정과 무관하게 만든다(`-b` 는 bare 에도 먹는다).
  git(root, ['init', '--bare', '-b', 'main', remote]);
  git(root, ['init', '-b', 'main', seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test User']);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', remote, invoked]);
  if (behind === 'no-origin') {
    git(invoked, ['remote', 'remove', 'origin']);
  } else {
    for (let index = 0; index < behind; index += 1) {
      writeFileSync(join(seed, 'README.md'), `commit ${index}\n`);
      git(seed, ['add', 'README.md']);
      git(seed, ['commit', '-m', `ahead ${index}`]);
    }
    if (behind > 0) git(seed, ['push', 'origin', 'main']);
    git(invoked, ['fetch', 'origin']);
  }
  return { invoked, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runDevFixture(cwd: string, runId: string): {
  output: string;
  logs: Array<{ event: string; data: string }>;
} {
  const env = childEnv({ ELANOUS_RUN_ID: runId });
  const result = spawnSync('bun', [CLI, `--test=${childState}`, 'dev', 'runtime git fixture', '--backend', 'codex', '--transport', 'acp'], {
    cwd, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  });
  // 프로세스 종료와 pipeline 진입을 별개로 확인한다. 관측 `plan` 이 없으면
  // 경고를 출력했어도 실행 경로에 닿지 못한 것이다.
  if (result.error || result.signal) {
    throw new Error(`dev spawn 실패: ${result.error?.message ?? result.signal}`);
  }
  const logResult = spawnSync('bun', [CLI, `--test=${childState}`, 'logs', '--exact-category', 'dev-pipeline', '--since', '10m', '--json', '--limit', '10'], {
    cwd, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  });
  if (logResult.error) throw new Error(`logs spawn 실패: ${logResult.error.message}`);
  if (logResult.signal) throw new Error(`logs 가 시그널로 죽었다(관측을 못 읽었다): signal=${logResult.signal}`);
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(2);
  expect(logResult.status, `${logResult.stdout ?? ''}${logResult.stderr ?? ''}`).toBe(0);
  const logs = logResult.stdout.trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data: string })
    .filter((record) => {
      try { return (JSON.parse(record.data) as { runId?: string }).runId === runId; } catch { return false; }
    });
  expect(logs.some(({ event }) => event === 'plan')).toBe(true);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assertNoProductionConfigMaterialization(output);
  return { output, logs };
}

describe('elanous dev — 실험 엔트리 등록·검증(subprocess)', () => {
  // `--help` matches `dev`, but drive runtime accepts only --goal, --max-steps,
  // --poll-ms, --model, and --cwd; every other dev option is explicitly rejected.
  it('drive explicitly rejects dev-only --elanous at runtime', () => {
    const r = run(['drive', 'printf done', '--goal', 'finish', '--elanous']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('drive: 지원하지 않는 옵션: --elanous');
  });
  it('--help 는 실험 엔트리로 resolve', () => {
    const r = run(['dev', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('실험');
    expect(r.out).toContain('--backend');
    const all = run(['dev', '--help-all']);
    expect(all.code).toBe(0);
    expect(all.out).toContain('--context');
    expect(all.out).toContain('--context-text');
    expect(all.out).toContain('--no-supervise');
    expect(all.out).toContain('--child-llm-effort');
    expect(all.out).not.toContain('--supervise-rounds');
  });

  // dev 에서 은퇴한 상한 옵션은 값과 --no-supervise 조합에 관계없이 파서가 거부한다.
  it('--supervise-rounds fails with --no-supervise and with invalid limits, before self execution', () => {
    for (const args of [
      ['dev', 'do not launch', '--no-supervise', '--supervise-rounds', '2'],
      ['dev', 'do not launch', '--supervise-rounds', '0'],
      ['dev', 'do not launch', '--supervise-rounds', '-1'],
    ]) {
      const r = run(args);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('--supervise-rounds');
    }
  });

  it('기본 감독을 끄는 --no-supervise 는 help-all 에 계속 노출한다', () => {
    const all = run(['dev', '--help-all']);
    expect(all.code).toBe(0);
    expect(all.out).toContain('--no-supervise');
  });

  it('drive rejects the dev-only reviewer context options', () => {
    for (const option of [['--context', 'README.md'], ['--context-text', 'review premise']] as const) {
      const r = run(['drive', 'exit 0', '--goal', 'finish', ...option]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`drive: 지원하지 않는 옵션: ${option[0]}`);
    }
  });

  it('dev --file derives traced paths through the repository reader, reports labels, preserves explicit context priority, and keeps text goals empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-dev-traced-context-'));
    const goalPath = join(directory, 'goal.md');
    const validGoal = (tracedPaths: string) => [
      '## PROBLEM\nproblem', '## WHAT TO BUILD\nbuild', '## RULES\nrules',
      '## ACCEPTANCE CRITERIA\ncriteria', '## REQUIRED EVIDENCE\n- [test] proof',
      `## TRACED PATHS\n${tracedPaths}`, '## SCOPE BOUNDARY\nboundary', '## 불변식\nkeep', '## 판정 신호\nsignal',
    ].join('\n\n');
    try {
      writeFileSync(goalPath, validGoal('- src/index.ts — goal evidence\n- missing.ts — nonfatal diagnostic'));
      const derived = runIsolatedCli(['dev', '--file', goalPath, '--backend', 'codex', '--transport', 'acp', '--allow-goal-lint-errors']);
      expect(derived.code, derived.out).toBe(2);
      expect(derived.out).toContain('acp 완료 · ok=false');
      expect(derived.out).toContain('Reviewer context: 1 loaded, 1 not loaded.');
      expect(derived.out).toContain('- src/index.ts');
      expect(derived.out).toContain('- missing.ts: missing');

      const explicit = runIsolatedCli(['dev', '--file', goalPath, '--backend', 'codex', '--transport', 'acp', '--context', 'src/self-dev/dev-cli.ts', '--allow-goal-lint-errors']);
      expect(explicit.code, explicit.out).toBe(2);
      expect(explicit.out).toContain('acp 완료 · ok=false');
      expect(explicit.out).toContain('Reviewer context: 1 loaded, 0 not loaded.');
      expect(explicit.out).toContain('- src/self-dev/dev-cli.ts');
      expect(explicit.out).not.toContain('- src/index.ts');

      const text = runIsolatedCli(['dev', 'text goal', '--backend', 'codex', '--transport', 'acp']);
      expect(text.code, text.out).toBe(2);
      expect(text.out).toContain('acp 완료 · ok=false');
      expect(text.out).not.toContain('Reviewer context:');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it('bin 실물 argv는 혼합 reviewer context 옵션을 등록·drive 거부·저장소 경계 읽기 실패까지 전달한다', () => {
    const help = runIsolatedCli(['dev', '--help-all']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--context');
    expect(help.out).toContain('--context-text');

    for (const option of [['--context', 'README.md'], ['--context-text', 'review premise']] as const) {
      const drive = runIsolatedCli(['drive', 'exit 0', '--goal', 'finish', ...option]);
      expect(drive.code).not.toBe(0);
      expect(drive.out).toContain(`drive: 지원하지 않는 옵션: ${option[0]}`);
    }

    const missing = 'definitely-missing-review-context.md';
    const context = runIsolatedCli(['dev', 'no child launch', '--context', missing, '--context-text=inline premise']);
    expect(context.code).not.toBe(0);
    expect(context.out).toContain(missing);
    expect(context.out).toMatch(/not found|없|missing/i);
    expect(context.out).toContain('Reviewer context: 1 loaded, 1 not loaded.');
    // ⛔ 이 시험은 실제 CLI 를 «세 번» spawn 한다 — bun 기본 5초 창은 부하 아래서 모자란다
    //   (실측 2026-08-20: 같은 코드가 조용할 땐 통과, 리뷰 프로세스와 함께 돌 땐 5,083ms 에 타임아웃).
    //   ⇒ 흔들린 것은 «판정»이 아니라 «창»이다. 검사문은 그대로 두고 창만 넓힌다.
  }, 30_000);

  it('뒤처진 invoked worktree는 정확한 경고·dev-pipeline 관측을 남기고 pipeline 발사를 계속한다', () => {
    const fixture = createGitFixture(2);
    try {
      const runId = `behind-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const result = runDevFixture(fixture.invoked, runId);
      expect(result.output).toContain('origin/main보다 2개 커밋 뒤처져 있습니다');
      const behindEvents = result.logs.filter(({ event }) => event === 'worktree-behind-main');
      expect(behindEvents).toHaveLength(1);
      expect(JSON.parse(behindEvents[0]!.data)).toMatchObject({ runId, behind: 2, hostId: expect.any(String) });
      expect(result.logs.some(({ event }) => event === 'plan')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 35_000);

  it('origin/main과 동기화된 invoked worktree는 무경고로 pipeline 발사를 계속한다', () => {
    const fixture = createGitFixture(0);
    try {
      const result = runDevFixture(fixture.invoked, `current-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      expect(result.output).not.toContain('작업 트리는 origin/main보다');
      expect(result.logs.some(({ event }) => event === 'worktree-behind-main')).toBe(false);
      expect(result.logs.some(({ event }) => event === 'plan')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 35_000);

  it('origin을 측정할 수 없는 invoked worktree는 무경고로 pipeline 발사를 계속한다', () => {
    const fixture = createGitFixture('no-origin');
    try {
      const result = runDevFixture(fixture.invoked, `unknown-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      expect(result.output).not.toContain('작업 트리는 origin/main보다');
      expect(result.logs.some(({ event }) => event === 'worktree-behind-main')).toBe(false);
      expect(result.logs.some(({ event }) => event === 'plan')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 35_000);

  it('dev --json --worktree preserves created provenance when the real child initialization throws', () => {
    const fixture = createGitFixture(0);
    const runId = `worktree-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const invalidIsolationRoot = join(fixture.invoked, 'not-a-directory');
    writeFileSync(invalidIsolationRoot, 'blocks directory creation\n');
    let testFailed = true;
    try {
      const result = spawnSync('bun', [CLI, `--test=${childState}`, 'dev', 'exercise child dispatch', '--elanous', '--hold', '--isolated-root', invalidIsolationRoot, '--worktree', '--json'], {
        cwd: fixture.invoked,
        encoding: 'utf8',
        timeout: 15_000, killSignal: 'SIGKILL',
        env: childEnv({ ELANOUS_RUN_ID: runId, NODE_ENV: 'test' }),
      });
      expect(result.error).toBeUndefined();
      assertNoProductionConfigMaterialization(`${result.stdout ?? ''}${result.stderr ?? ''}`);
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(1);
      const jsonStart = result.stdout.lastIndexOf('\n{');
      expect(jsonStart, result.stdout).toBeGreaterThanOrEqual(0);
      const output = JSON.parse(result.stdout.slice(jsonStart + 1)) as { error: string; autoWorktree: { environment: { branch: string }; worktree: { path: string; branch: string; owner: string; command: string; createdAt: string } } };
      const worktreePath = findHarnessWorktree(fixture.invoked, `dev/${runId}`).path;
      expect(worktreePath).toBeDefined();
      expect(output.error).toMatch(/held elanous TUI owner exited before registering a PTY/);
      expect(result.stdout).toContain('"held":false');
      const ownerLogPath = output.error.match(/전문: (.+\.log)\)/)?.[1];
      expect(ownerLogPath).toBeDefined();
      const ownerLog = readFileSync(ownerLogPath!, 'utf8');
      assertNoProductionConfigMaterialization(ownerLog);
      expect(ownerLog).toContain(`cannot establish isolated elanous TUI root at ${invalidIsolationRoot}`);
      expect(ownerLog).toContain('EEXIST');
      expect(output.autoWorktree.environment.branch).toBe('main');
      expect(output.autoWorktree.worktree).toMatchObject({ branch: `dev/${runId}`, owner: `dev:${runId}`, command: 'dev' });
      expect(worktreePath!.startsWith(`${realpathSync(fixture.invoked)}/`)).toBe(false);
      const resolvedDevWorktree = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: output.autoWorktree.worktree.path, encoding: 'utf8' });
      expect(resolvedDevWorktree.status).toBe(0);
      expect(resolvedDevWorktree.stdout.trim()).toBe(worktreePath!);
      expect(output.autoWorktree.worktree.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.command'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim()).toBe('dev');
      expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim()).toBe(`dev:${runId}`);
      expect(readFileSync(invalidIsolationRoot, 'utf8')).toBe('blocks directory creation\n');
      testFailed = false;
    } finally {
      // ⛔ 성공/실패 «어느 경로에서도» 판정자에게 다시 물어 지운다(리뷰 must-fix).
      cleanupHarnessWorktree(fixture.invoked, `dev/${runId}`, testFailed);
      fixture.cleanup();
    }
  }, 30_000);

/** ⛔⭐ 「없다」와 「못 봤다」를 «다른 값»으로 돌려준다 — 이 저장소가 반복해 밟은 축이다.
 *  `{ found }` = 정말 없다(안 만들어졌다) · `{ path }` = 찾았다 · throw = «조회 자체»가 실패했다. */
function findHarnessWorktree(repoCwd: string, branch: string): { readonly path?: string } {
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoCwd, encoding: 'utf8' });
  if (listed.status !== 0) {
    // ⛔ 조회 실패를 「없다」로 접으면 «지워야 할 것»을 조용히 놓친다.
    throw new Error(`[test] git worktree list 실패 rc=${listed.status}: ${listed.stderr}`);
  }
  let current: string | undefined;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    if (line.trim() === `branch refs/heads/${branch}` && current) return { path: current };
  }
  return {};
}

/** ⛔⭐ 하니스 워크트리는 «사람 트리 밖»(하니스 루트)에 생긴다 —
 *  그래서 fixture 루트만 rmSync 하면 ***워크트리와 git 메타데이터가 누적된다***(리뷰 #10554 must-fix).
 *  ⚠️ 이것은 가설이 아니라 관측된 축이다: 이 저장소의 워크트리 수가 며칠 만에 156 → 370 으로 늘었다.
 *  ⇒ 찾았으면 «지운다». 실패는 삼키되(정리는 판정이 아니다) 조용하지 않게 남긴다. */
function removeHarnessWorktree(repoCwd: string, worktreePath: string): void {
  const removed = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoCwd, encoding: 'utf8' });
  if (removed.status !== 0) {
    throw new Error(`[test-cleanup] worktree remove 실패 rc=${removed.status}: ${worktreePath}\n${removed.stderr}`);
  }
}

/** ⛔⭐ 정리를 «성공 경로»에 매달지 않는다 — 시험이 어디서 죽든 워크트리는 이미 «생겼다».
 *
 *  리뷰 #10554 라운드3 must-fix: 종전 판은 assertion 이 먼저 깨지면 `createdWorktree` 가
 *  비어 있어 정리가 통째로 안 돌았다. ***누수는 성공할 때가 아니라 «실패할 때» 난다.***
 *  ⇒ finally 에서 «브랜치로 다시 찾아» 지운다. 없으면 안 만들어진 것이므로 조용히 넘어간다.
 *
 *  ⛔ 그리고 정리 실패를 «삼키지 않는다»(should-fix) — 본 시험이 통과했는데 정리가 실패하면
 *  그것은 「시험 위생 회귀」이고 CI 에서 보여야 한다. 다만 «본 시험이 이미 실패 중»이면
 *  원래 실패를 덮지 않도록 정리 실패는 경고로만 남긴다(진단을 가리지 않는다). */
function cleanupHarnessWorktree(repoCwd: string, branch: string, testAlreadyFailed: boolean): void {
  try {
    // ⛔ 조회 실패는 findHarnessWorktree 가 throw 한다 — 「없다」로 삼키지 않는다(리뷰 라운드4 must-fix).
    const found = findHarnessWorktree(repoCwd, branch);
    if (found.path === undefined) return;   // ← 정말 «안 만들어졌다». 지울 것이 없다.
    removeHarnessWorktree(repoCwd, found.path);
  } catch (error) {
    // ⛔ 본 시험이 «이미 실패 중»이면 원래 진단을 덮지 않는다 — 경고로만.
    if (testAlreadyFailed) { console.warn(String(error)); return; }
    throw error;
  }
}

  describe('시험 위생 helper — 「없다」와 「못 봤다」를 «가른다»', () => {
    // ⛔ 이 시험이 있는 이유(리뷰 #10554 라운드4 should-fix):
    //   정리 helper 가 조회 실패를 「없었다」로 삼키면, «지워야 할 워크트리»를 조용히 놓치고도
    //   시험은 초록이다. 그 약화가 다시 들어오면 여기가 먼저 빨개진다.

    it('git 저장소가 «아닌» 곳에서는 「없다」가 아니라 «던진다»', () => {
      const notARepo = mkdtempSync(join(tmpdir(), 'elanous-not-a-repo-'));
      try {
        // 본 시험이 통과 중(testAlreadyFailed=false)이면 정리 실패는 «보여야» 한다.
        expect(() => cleanupHarnessWorktree(notARepo, 'dev/never-created', false)).toThrow(/worktree list 실패/);
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
      }
    });

    it('본 시험이 «이미 실패 중»이면 정리 실패가 원래 진단을 덮지 않는다', () => {
      const notARepo = mkdtempSync(join(tmpdir(), 'elanous-not-a-repo-'));
      try {
        expect(() => cleanupHarnessWorktree(notARepo, 'dev/never-created', true)).not.toThrow();
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
      }
    });

    it('진짜 저장소인데 그 브랜치 워크트리가 «없으면» 조용히 넘어간다', () => {
      expect(() => cleanupHarnessWorktree(process.cwd(), 'dev/definitely-not-a-branch-xyz', false)).not.toThrow();
    });
  });

  it('drive --worktree runs a real failing child and preserves git worktree metadata', () => {
    const fixture = createGitFixture(0);
    const runId = `drive-worktree-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let testFailed = true;
    try {
      const result = spawnSync('bun', [CLI, `--test=${childState}`, 'drive', 'printf child-dispatch-failed >&2; exit 23', '--goal', 'observe the child failure', '--worktree'], {
        cwd: fixture.invoked,
        encoding: 'utf8',
        // ⛔⭐ 이 창은 «고정 상수가 아니라 관측값»이다 — 실측 2026-08-20 (같은 코드, 같은 기계):
        //     15,000ms → 15,220ms 에 SIGTERM   ⇒ 25,000 으로 넓힘
        //     25,000ms → 25,353ms 에 SIGTERM   ⇒ ***넓힌 만큼 더 걸렸다***
        //   🔑 그 지문은 「자식이 느리다」가 아니라 ***「저장소의 워크트리 수에 비례한다」***를 가리킨다
        //     (그날 이 저장소의 워크트리가 275개였다 · git worktree 조작이 전수를 훑는다).
        //   ⇒ 그러니 이 값을 다시 올리기 전에 «워크트리 수»를 먼저 재라 —
        //     창을 올리는 것은 증상 완화이고, 수가 늘면 또 넘는다.
        timeout: 60_000, killSignal: 'SIGKILL',
        env: childEnv({ ELANOUS_RUN_ID: runId, NODE_ENV: 'test' }),
      });
      expect(result.error).toBeUndefined();
      assertNoProductionConfigMaterialization(`${result.stdout ?? ''}${result.stderr ?? ''}`);
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(23);
      // PTY merges child stderr into the CLI stdout stream; require the actual output, not the echoed command.
      expect(result.stdout).toMatch(/(?:^|\n)child-dispatch-failed(?:\r?\n|$)/);
      const worktreePath = findHarnessWorktree(fixture.invoked, `dev/${runId}`).path;
      expect(worktreePath).toBeDefined();
      const reportedPath = result.stdout.match(/^worktree\.path: (.+)$/m)?.[1];
      expect(reportedPath).toBeDefined();
      const resolvedDriveWorktree = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: reportedPath!, encoding: 'utf8' });
      expect(resolvedDriveWorktree.status).toBe(0);
      expect(resolvedDriveWorktree.stdout.trim()).toBe(worktreePath!);
      expect(result.stdout).toContain(`worktree.branch: dev/${runId}`);
      expect(result.stdout).toContain(`worktree.command: drive`);
      expect(worktreePath!.startsWith(`${realpathSync(fixture.invoked)}/`)).toBe(false);
      expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.command'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim()).toBe('drive');
      expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim()).toBe(`dev:${runId}`);
      expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.createdAt'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      testFailed = false;
    } finally {
      // ⛔ 성공/실패 «어느 경로에서도» 판정자에게 다시 물어 지운다(리뷰 must-fix).
      cleanupHarnessWorktree(fixture.invoked, `dev/${runId}`, testFailed);
      fixture.cleanup();
    }
  }, 120_000);

  it('dev와 self implement는 공식 --observe-only 창구를 Commander 도움말에 노출한다', () => {
    const dev = run(['dev', '--help-all']);
    const selfImplement = run(['self', 'implement', '--help']);
    expect(dev.code).toBe(0);
    expect(selfImplement.code).toBe(0);
    expect(dev.out).toContain('--observe-only');
    expect(selfImplement.out).toContain('--observe-only');
  });

  it('external backend + --branch 누락 → agent-mission 대응 명령을 안내하고 branch 부재를 거부한다', () => {
    const r = run(['dev', '기능', '--backend', 'codex']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('elanous agent-mission mission --backend codex');
    expect(r.out).toMatch(/--branch.*(?:필수|필요|없)/);
    expect(r.out).not.toContain('무효한 옵션: context');
  }, 30_000);

  it('--file 과 <text> 동시 → 상호배타 거부(exit≠0·조용한 무시 없음)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devcli-'));
    try {
      const f = join(dir, 'm.md');
      writeFileSync(f, '미션');
      const r = run(['dev', '텍스트', '--file', f]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('동시 사용 불가');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('--backend 잘못된 값 → commander choices 거부(exit≠0)', () => {
    const r = run(['dev', '기능', '--backend', 'bogus']);
    expect(r.code).not.toBe(0);
    expect(r.out.toLowerCase()).toContain('choices');
  });

  it('shell target은 dev에서 기존 drive 옵션을 받고 shell-drive 경로의 무효 옵션을 거부한다', () => {
    const r = run(['dev', 'printf done', '--goal', 'finish', '--max-steps', '2', '--poll-ms', '0', '--model', 'brain', '--cwd', '/work', '--isolated-root', '/iso']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('shell-drive');
    expect(r.out).toContain('isolatedRoot');
  });

  it('drive는 dev의 Commander alias이고 command·goal 검증·shell-only 경계를 보존하며 top-level help에는 독립 항목으로 노출되지 않는다', () => {
    const noCommand = run(['drive', '--goal', 'finish']);
    expect(noCommand.code).not.toBe(0);
    expect(noCommand.out).toContain('drive: command 필요');
    const noGoal = run(['drive', 'printf done']);
    expect(noGoal.code).not.toBe(0);
    expect(noGoal.out).toContain('drive: --goal 필요');
    const elanous = run(['drive', 'printf done', '--goal', 'finish', '--elanous']);
    expect(elanous.code).not.toBe(0);
    expect(elanous.out).toContain('drive: 지원하지 않는 옵션: --elanous');
    const help = run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^  dev\b/m);
    expect(help.out).not.toMatch(/^  drive\b/m);
  }, 15_000);

  it('옵션값 drive를 alias 호출로 오인하지 않는다', () => {
    const r = run(['dev', '--elanous', '--goal', 'drive', '--max-steps', '0']);
    expect(r.out).not.toContain('drive:');
    expect(r.out).toContain('--max-steps 는 양의 정수여야');
  });

  it('drive는 legacy 비지원 dev 옵션을 수락 후 무시하지 않는다', () => {
    for (const option of [['--backend', 'codex'], ['--transport', 'acp']]) {
      const r = run(['drive', 'exit 0', '--goal', 'finish', ...option]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('drive: 지원하지 않는 옵션');
    }
  }, 15_000);

  // 실제 셸 제어 루프는 임시 cwd 에서만 구동한다. 자격증명 없이도 자식 종료 코드를 전파한다.
  it('drive subprocess는 실제 shell child exit code를 그대로 전파한다', () => {
    const r = run(['drive', 'exit 7', '--goal', 'finish', '--poll-ms', '0', '--cwd', childRoot]);
    expect(r.code, r.out).toBe(7);
  }, 30_000);

  it('drive subprocess는 성공 자식의 exit 0 도 그대로 전파한다', () => {
    const r = run(['drive', 'true', '--goal', 'finish', '--poll-ms', '0', '--cwd', childRoot]);
    expect(r.code).toBe(0);
  }, 30_000);

  it('drive 는 무인 완결을 끄는 --no-* 를 받지 않고 기존처럼 거부한다', () => {
    for (const option of ['--no-open-pr', '--no-auto-review', '--no-auto-merge'] as const) {
      const r = run(['drive', 'exit 0', '--goal', 'finish', option]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('drive: 지원하지 않는 옵션');
    }
  }, 30_000);

  it('U6 — --backend self --transport acp → 거부(self 는 transport-free·silent-ignore 금지)', () => {
    const r = run(['dev', '기능', '--backend', 'self', '--transport', 'acp']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('transport 는 external backend 전용');
  });

  it('U6 — --transport 잘못된 값 → commander choices 거부', () => {
    const r = run(['dev', '기능', '--backend', 'codex', '--transport', 'bad']);
    expect(r.code).not.toBe(0);
    expect(r.out.toLowerCase()).toContain('choices');
  });
});

describe('U4b — agent-mission mission 이 runDevPipeline 로 재라우팅(검증계약 보존)', () => {
  // 재라우팅 후에도 기존 CLI 검증(branch 필수·bad backend fail-fast)이 실행 전에 보존됨(무회귀·실행 미유발).
  it('--branch 누락 → 여전히 거부(commander requiredOption)', () => {
    const r = run(['agent-mission', 'mission', 'x']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--branch');
  });

  it('bad backend → resolveBackend 조기 거부(재라우팅 전)', () => {
    const r = run(['agent-mission', 'mission', 'x', '--branch', 'b', '--backend', 'bogus']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('알 수 없는 agent backend');
  });

  // 재라우팅 실행 검증은 src/agent-mission/mission-cli.test.ts 가 runAgentMissionCliCommand seam 을
  // 주입·실행해 커버(runDevPipeline 호출·모든 옵션·exit-code). 여기선 CLI 등록/검증계약만.
});

// ⭐⭐⭐ S1 — **사람이 쏘는 정문에 골 린트 여섯 축이 걸렸는가**(2026-08-03).
//   에이전트가 부르는 `ElanousAutopilotLaunch` 에는 fail-closed 로 걸려 있었고 `elanous dev --file` 에는
//   `REQUIRED EVIDENCE` 한 축만 있었다. 이 스위트가 재는 것은 **로직이 아니라 경로**다 —
//   셸에서 치는 그 명령이 프로세스로 떠서 린트를 돌고 거부하는가.
//   ⛔ **in-process 단위 테스트로는 못 가른다**(그 층은 CLI 배선을 안 지난다) — `#6701` 이 그것으로 통과했다.
//
//   ⚠️ **운반체로 `--backend codex --transport acp` 를 쓰는 이유**: 이 경로는 capability 미검증이라
//      worktree 도 자식도 만들지 않고 즉시 완료한다 ⇒ **진짜 개발 런을 띄우지 않고** 관문 통과 여부만 가른다.
//      (`--backend self` 로 쓰면 우회 케이스가 실제 구현 런을 시작해 테스트가 부작용을 만든다.)
describe('elanous dev --file — 골 린트 여섯 축 preflight(subprocess)', () => {
  const LINT_ERROR_GOAL = '## ACCEPTANCE CRITERIA\nx\n\n## REQUIRED EVIDENCE\n- [t] tag\n';

  function withGoal<T>(body: (goalPath: string) => T): T {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-dev-lint-'));
    try {
      const goalPath = join(directory, 'lint-error-goal.txt');
      writeFileSync(goalPath, LINT_ERROR_GOAL);
      return body(goalPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('lint ERROR 가 있는 골은 발사 전에 거부되고, 걸린 축과 우회 경로를 문면에 말한다', () => {
    withGoal((goalPath) => {
      // ⚠️ 디폴트 backend(self)로 둔다 — **거부는 디스패치 전에** 나므로 자식이 뜨지 않는다.
      //   ⛔ 운반체로 `--transport acp` 를 얹지 않는다: 그 경로는 이 진입점에서 **완료하지 않고 멈추고**,
      //      멈춘 자식이 프로세스로 **누적**된다(2026-08-03 실측 — 좀비 11개를 손으로 걷었다).
      const r = run(['dev', '--file', goalPath]);
      // ⛔ 종료 코드만으로는 못 가른다 — 무엇이 걸렸는지 문면이 말해야 사람이 고칠 수 있다.
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('ERROR [canonical-structure]');
      expect(r.out).toContain('## PROBLEM');
      // FINDING-prohibition-without-a-path — 금지만 주고 길을 안 주면 자식이 멈춘다.
      expect(r.out).toContain('--allow-goal-lint-errors');
    });
  }, 120_000);

  it('--help 는 명시 lint 우회 플래그를 정문에 노출한다', () => {
    const r = run(['dev', '--help-all']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--allow-goal-lint-errors');
  });
});

describe('은퇴 입구가 «사람 눈에» 닿는다 (subprocess · RFC-one-door-many-entrances P2)', () => {
  // ⛔ 리뷰 #10572 must-fix: 「접두사를 만들 수 있다」만 무는 시험은 «배선 누락»을 못 잡는다.
  //   ⇒ 진짜 CLI 를 띄워 --help 를 읽는다. 2026-08-17 사고가 정확히 「선언은 있는데 표면이 조용」이었다.

  it('elanous harness dogfood --help 가 은퇴 사실과 «갈 곳»을 둘 다 말한다', () => {
    const help = runIsolatedCli(['harness', 'dogfood', '--help']);
    expect(help.code, help.out).toBe(0);
    expect(help.out).toContain('DEPRECATED');
    expect(help.out).toContain('cli-harness-dogfood');       // 어느 입구인지 «이름»으로
    expect(help.out).toContain('elanous harness ask <골문서>'); // ⛔ 갈 곳이 «있어야» 한다
    // ⭐ 원래 설명을 «잃지 않는다» — 앞에 붙일 뿐이다.
    expect(help.out).toContain('RunDevHarness로 HITL 유지');
  }, 60_000);

  it('live 입구(elanous dev --help)에는 은퇴 표시가 «안 붙는다»', () => {
    const help = runIsolatedCli(['dev', '--help']);
    expect(help.code, help.out).toBe(0);
    expect(help.out).not.toContain('DEPRECATED(cli-');
  }, 60_000);
});
