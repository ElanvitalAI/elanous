import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { runGitCli } from './git-cli.js';
import { createTempGitRepo } from '../ux-sim/temp-git-repo.js';
import { gitPushTimeoutAfterRemoteApplyShim } from '../ux-sim/git-push-timeout-partial-outcome-remote-verify.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repositoryRoot = process.cwd();
const entrypoint = [join(repositoryRoot, 'bin/elanous.mjs')];
// 근거: #35934 bounds child CLIs that exercise real local bare Git remotes.
const GIT_PUSH_TEST_CHILD_TIMEOUT_MS = 60_000;

function findGitExecutable(): string {
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Continue through PATH, matching executable lookup behavior. */ }
  }
  throw new Error('git executable is unavailable in PATH');
}

function inIsolatedGitWorktree<T>(run: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-git-cli-cwd-'));
  const initialized = spawnSync('git', ['init', '-q'], { cwd });
  if (initialized.status !== 0) throw new Error(`test git init failed: ${initialized.stderr.toString()}`);
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function isolatedCliEnvironment(home: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ELANOUS_SUPPRESS_XDG_WARNING: '1',
    // Keep child stderr byte-exact for the git status-line contract.
    MSS_LOG_STORE_DIAGNOSTICS: '0',
  };
}

function invokeGit(args: string[], env?: NodeJS.ProcessEnv) {
  return inIsolatedGitWorktree((cwd) => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
    try {
      return spawnSync('bun', [...entrypoint, '--test', 'git', ...args], {
        cwd,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, env),
        timeout: 60_000,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

/** ⭐ GATE-SPEED ③(2026-10-08) — `runGitCli()` 를 «같은 프로세스»에서 부른다.
 *  초판은 시험마다 `bun bin/elanous.mjs --test git …` 를 새로 띄웠다(30개 시험 · 게이트 867s · 로컬 건당 ≈2s).
 *  대부분의 시험이 재는 것은 CLI 기동이 아니라 `runGitCli` 의 바이트·상태 줄·rc·마커 판정이다.
 *  ⇒ 그 시험들은 여기서 같은 조건(작업 디렉토리 · PATH 의 가짜 git · 격리 HOME/XDG)을 «프로세스 전역»에
 *    잠깐 세우고 부른 뒤 되돌린다. `process.stdout/stderr.write` 를 바이트로 받고 `process.exitCode` 를 rc 로 읽는다.
 *  ⛔ 배선(commander 의 argv 통과 · `--help` 통과 · 파이프 · 실물 충돌 한 건)은 `invokeGit`/`runInRepoReal` 의
 *    실물 spawn 이 계속 문다 — «배선 PR 은 실물을 한 번 돌린다». */
function runGitCliInProcess(cwd: string, args: string[], pathPrefix?: string, extraEnv: NodeJS.ProcessEnv = {}): { status: number; stdout: Buffer; stderr: Buffer } {
  const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
  const savedCwd = process.cwd();
  const envKeys = [...new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', ...Object.keys(extraEnv)])];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<(typeof envKeys)[number], string | undefined>;
  const savedExitCode = process.exitCode;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const capture = (sink: Buffer[]) => ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
    sink.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (typeof done === 'function') (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
  let status: number;
  try {
    process.chdir(cwd);
    if (pathPrefix) process.env.PATH = `${pathPrefix}:${savedEnv.PATH ?? ''}`;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.XDG_STATE_HOME = join(home, '.local', 'state');
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = 0;
    process.stdout.write = capture(out);
    process.stderr.write = capture(err);
    try {
      runGitCli(args);
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
    status = Number(process.exitCode ?? 0);
  } finally {
    process.chdir(savedCwd);
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    // ⚠️ Bun 은 `process.exitCode = undefined` 로는 안 되돌아간다(실측: 0 fail 인데 rc=1) — 0 으로 되돌린다.
    process.exitCode = savedExitCode ?? 0;
    rmSync(home, { recursive: true, force: true });
  }
  return { status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

function asText(result: { status: number; stdout: Buffer; stderr: Buffer }) {
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}

/** 격리 git 작업 트리에서 `runGitCli` 를 같은 프로세스로 부른다(문자열 결과). */
function invokeGitInProcess(args: string[], pathPrefix?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return inIsolatedGitWorktree((cwd) => asText(runGitCliInProcess(cwd, args, pathPrefix, extraEnv)));
}

function makePushOwnershipFixture(
  pr: { number: number; headRefName: string; body: string; labels: { name: string }[]; headRepositoryOwner?: { login: string }; headRepositoryFullName?: string },
  options: { remoteUrl?: string; remoteUrls?: string[]; parentRepository?: string; targetBranches?: string[]; defaultRemote?: string } = {},
) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-push-owner-'));
  const pushLog = join(binDir, 'push.log');
  const ghLog = join(binDir, 'gh.log');
  const auditDir = join(binDir, 'state');
  const gitPath = join(binDir, 'git');
  const ghPath = join(binDir, 'gh');
  const remoteUrls = options.remoteUrls ?? [options.remoteUrl ?? 'https://github.com/ElanvitalAI/elanous.git'];
  const remoteUrl = remoteUrls[0]!;
  const targetBranches = options.targetBranches ?? ['feat/foreign-cell'];
  const defaultRemote = options.defaultRemote ?? '';
  const porcelain = remoteUrls.flatMap((url) => [`To ${url}`, ...targetBranches.map((branch) =>
    `* HEAD:refs/heads/${branch} [up to date]`)])
    .map((line) => `'${line.replaceAll("'", "'\\''")}'`).join(' ');
  const remoteUrlArgs = remoteUrls.map((url) => `'${url.replaceAll("'", "'\\''")}'`).join(' ');
  const metadata = JSON.stringify({ full_name: remoteUrl.match(/(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?$/)?.[1],
    ...(options.parentRepository ? { parent: { full_name: options.parentRepository } } : {}) });
  const restPr = JSON.stringify([{
    number: pr.number, body: pr.body, labels: pr.labels,
    head: { ref: pr.headRefName, repo: {
      full_name: pr.headRepositoryFullName ?? remoteUrl.match(/(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?$/)?.[1],
      owner: { login: pr.headRepositoryOwner?.login ?? remoteUrl.match(/(?:github\.com[:/])([^/]+)\//)?.[1] ?? 'ElanvitalAI' },
    } },
  }]);
  writeFileSync(gitPath, `#!/bin/sh
if [ "$1" = -C ]; then shift; shift; fi
if [ "$1" = config ] && [ "$2" = --get ] && [ "$3" = remote.pushDefault ] && [ -n '${defaultRemote}' ]; then printf '%s\n' '${defaultRemote}'; exit 0; fi
if [ "$1" = push ]; then
  case " $* " in
    *" --dry-run "*) printf '%s\\n' ${porcelain} ;;
    *) printf '%s\\n' "$*" >> '${pushLog}'; printf 'fake git reached\\n' ;;
  esac
  exit 0
fi
if [ "$1" = remote ]; then printf '%s\\n' ${remoteUrlArgs}; exit 0; fi
if [ "$1" = symbolic-ref ]; then printf '%s\\n' '${targetBranches[0]}'; exit 0; fi
exit 0
`);
  writeFileSync(ghPath, `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog}'
if [ "$1" = api ]; then
  case " $* " in
    *"/pulls "*) printf '%s' '${restPr}' ;;
    *) printf '%s' '${metadata}' ;;
  esac
fi
`);
  chmodSync(gitPath, 0o755); chmodSync(ghPath, 0o755);
  return { binDir, pushLog, ghLog, auditDir };
}

function invokeFakeGit(stdout: string, stderr: string, status: number) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-'));
  const gitPath = join(binDir, 'git');
  writeFileSync(gitPath, `#!/bin/sh\nprintf %s '${stdout}'\nprintf %s '${stderr}' >&2\nexit ${status}\n`);
  chmodSync(gitPath, 0o755);
  try {
    return invokeGitInProcess(['fixture'], binDir);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** Spawn `elanous git fixture` against a fake git whose stdout/stderr are written
 *  from raw byte files, so the test can emit large payloads and invalid UTF-8
 *  bytes without any shell-quoting or encoding round-trip. */
function invokeFakeGitBytes(stdout: Buffer, stderr: Buffer, status: number) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-bytes-'));
  const gitPath = join(binDir, 'git');
  const outPath = join(binDir, 'out.bin');
  const errPath = join(binDir, 'err.bin');
  writeFileSync(outPath, stdout);
  writeFileSync(errPath, stderr);
  writeFileSync(gitPath, `#!/bin/sh\ncat '${outPath}'\ncat '${errPath}' >&2\nexit ${status}\n`);
  chmodSync(gitPath, 0o755);
  try {
    return inIsolatedGitWorktree((cwd) => runGitCliInProcess(cwd, ['fixture'], binDir));
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('elanous git', () => {
  test('incident simulation: warns and records a push into another seat\'s open PR, then passes it through', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('seat:TC');
      expect(result.stderr).toContain('warning');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push');
      expect(JSON.parse(readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim())).toMatchObject({
        seat: 'OPC', verdict: 'foreign-owner-warning', PR: [{ repository: 'ElanvitalAI/elanous', number: 35704 }],
        targets: [{ repository: 'ElanvitalAI/elanous', branch: 'feat/foreign-cell' }],
      });
      expect(readFileSync(fixture.ghLog, 'utf8')).toContain('api --method GET repos/ElanvitalAI/elanous/pulls -f state=open -f head=ElanvitalAI:feat/foreign-cell');
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('--force-owner logs one audit row and is not passed through to git', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push', '--force-owner'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(fixture.pushLog, 'utf8').trim()).toBe('push');
      expect(readFileSync(fixture.pushLog, 'utf8')).not.toContain('--force-owner');
      const audit = readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim().split('\n');
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!)).toMatchObject({ seat: 'OPC', verdict: 'foreign-owner-warning', forceOwnerRequested: true, PR: [{ repository: 'ElanvitalAI/elanous', number: 35704, seat: 'TC' }], targets: [{ repository: 'ElanvitalAI/elanous', branch: 'feat/foreign-cell' }], reason: 'push to another seat open PR branch' });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('foreign PR push proceeds with a warning even when audit storage fails', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      writeFileSync(fixture.auditDir, 'not a directory');
      const result = invokeGitInProcess(['push'], fixture.binDir, { ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(result.stderr).toContain('audit write failed');
      expect(readFileSync(fixture.pushLog, 'utf8').trim()).toBe('push');
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('--force-owner used as a push-option operand is preserved and observed', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push', '-o', '--force-owner', 'origin', 'HEAD'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(readFileSync(fixture.pushLog, 'utf8').trim()).toBe('push -o --force-owner origin HEAD');
      expect(JSON.parse(readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim())).toMatchObject({ verdict: 'foreign-owner-warning' });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('foreign push with --force-owner still proceeds when its audit ledger cannot be written', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      writeFileSync(fixture.auditDir, 'not a directory');
      const result = invokeGitInProcess(['push', '--force-owner'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('audit write failed');
      expect(existsSync(fixture.pushLog)).toBe(true);
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('unknown or same-seat PR ownership remains pass-through with an observable warning when unknown', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('ownership is unknown');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push');
      expect(JSON.parse(readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim())).toMatchObject({ verdict: 'pass-uncertain', reason: 'open PR or caller seat ownership is unknown' });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('same-seat PR with a different cell marker is not refused by the seat ownership guard', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:OPC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('push refused');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push');
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('default push settings warn on the actual foreign destination branch', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push'], fixture.binDir, { ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(existsSync(fixture.pushLog)).toBe(true);
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('explicit configured upstream remote is ownership-checked', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } }, { defaultRemote: 'upstream' });
    try {
      const result = invokeGitInProcess(['push', 'upstream'], fixture.binDir, { ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(readFileSync(fixture.pushLog, 'utf8').trim()).toBe('push upstream');
      expect(JSON.parse(readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim())).toMatchObject({ verdict: 'foreign-owner-warning' });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('explicit refspec is warned, recorded, and passed through', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const result = invokeGitInProcess(['push', 'origin', 'HEAD'], fixture.binDir, { ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push origin HEAD');
      expect(JSON.parse(readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim())).toMatchObject({ verdict: 'foreign-owner-warning' });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('git -C records a warning for the target seat path when environment identity is absent', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    const seatPath = join(fixture.binDir, 'seats', 'OPC');
    mkdirSync(seatPath, { recursive: true });
    try {
      const result = invokeGitInProcess(['-C', seatPath, 'push', 'origin'], fixture.binDir, {
        ELANOUS_TRACK: undefined, ELANOUS_HARNESS_SEAT: undefined, ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('current seat:OPC');
      expect(existsSync(fixture.pushLog)).toBe(true);
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('real Git relative -C bare push to another seat is warned and passed through', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/rejected', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const remote = join(fixture.binDir, 'remote.git');
    try {
      const result = inIsolatedGitWorktree((cwd) => {
        const seed = join(cwd, 'seed');
        const seat = join(cwd, 'seats', 'OPC');
        mkdirSync(seed, { recursive: true });
        mkdirSync(join(cwd, 'seats'), { recursive: true });
        const initBare = spawnSync(realGit, ['init', '--bare', '-q', remote], { cwd, encoding: 'utf8' });
        if (initBare.status !== 0) throw new Error(`bare git init failed: ${initBare.stderr}`);
        const init = spawnSync(realGit, ['init', '-q', '-b', 'feat/rejected'], { cwd: seed, encoding: 'utf8' });
        if (init.status !== 0) throw new Error(`seed git init failed: ${init.stderr}`);
        for (const [key, value] of [['user.email', 'opc@example.invalid'], ['user.name', 'OPC test']]) {
          const configured = spawnSync(realGit, ['config', key, value], { cwd: seed, encoding: 'utf8' });
          if (configured.status !== 0) throw new Error(`seed git config failed: ${configured.stderr}`);
        }
        const commitSeed = (file: string, contents: string, message: string) => {
          writeFileSync(join(seed, file), contents);
          const add = spawnSync(realGit, ['add', file], { cwd: seed, encoding: 'utf8' });
          if (add.status !== 0) throw new Error(`seed git add failed: ${add.stderr}`);
          const commit = spawnSync(realGit, ['commit', '-q', '-m', message], { cwd: seed, encoding: 'utf8' });
          if (commit.status !== 0) throw new Error(`seed git commit failed: ${commit.stderr}`);
        };
        commitSeed('seed.txt', 'seed\n', 'seed');
        spawnSync(realGit, ['remote', 'add', 'origin', remote], { cwd: seed });
        const firstPush = spawnSync(realGit, ['push', '-q', 'origin', 'HEAD:refs/heads/feat/rejected'], { cwd: seed, encoding: 'utf8' });
        if (firstPush.status !== 0) throw new Error(`initial remote push failed: ${firstPush.stderr}`);
        const clone = spawnSync(realGit, ['clone', '-q', '--branch', 'feat/rejected', remote, seat], { cwd, encoding: 'utf8' });
        if (clone.status !== 0) throw new Error(`seat git clone failed: ${clone.stderr}`);
        const wrapper = join(fixture.binDir, 'git');
        const githubRemote = 'https://github.com/ElanvitalAI/elanous.git';
        const realPushLog = join(fixture.binDir, 'real-push.log');
        const dryRunStderr = join(fixture.binDir, 'dry-run.stderr');
        writeFileSync(wrapper, `#!/bin/sh
is_push=0
dry_run=0
is_remote=0
is_get_url=0
for arg in "$@"; do
  [ "$arg" = "push" ] && is_push=1
  [ "$arg" = "--dry-run" ] && dry_run=1
  [ "$arg" = "remote" ] && is_remote=1
  [ "$arg" = "get-url" ] && is_get_url=1
done
if [ "$is_remote" = 1 ] && [ "$is_get_url" = 1 ]; then printf '%s\\n' '${githubRemote}'; exit 0; fi
if [ "$is_push" = 1 ] && [ "$dry_run" = 1 ]; then
    output=$('${realGit}' "$@" 2>'${dryRunStderr}')
    rc=$?
    printf '%s\\n' "$output" | sed 's#^To .*#To ${githubRemote}#'
    sed 's#^To .*#To ${githubRemote}#' '${dryRunStderr}' >&2
    exit "$rc"
fi
if [ "$is_push" = 1 ]; then printf '%s\\n' "$*" >> '${realPushLog}'; exit 0; fi
exec '${realGit}' "$@"
`);
        chmodSync(wrapper, 0o755);
        return runGitCliInProcess(cwd, ['-C', 'seats/OPC', 'push'], fixture.binDir, {
          ELANOUS_TRACK: undefined, ELANOUS_HARNESS_SEAT: undefined, ELANOUS_STATE_DIR: fixture.auditDir,
        });
      });
      expect(result.stderr.toString()).toContain('current seat:OPC');
      expect(result.status).toBe(0);
      expect(existsSync(join(fixture.binDir, 'real-push.log'))).toBe(true);
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('multi-refspec partial failure warns, records one row, and passes through', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/updatable', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } }, {
      targetBranches: ['feat/rejected', 'feat/updatable'],
    });
    try {
      const result = invokeGitInProcess(['push', 'origin', 'HEAD:refs/heads/feat/rejected', 'HEAD:refs/heads/feat/updatable'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push origin HEAD:refs/heads/feat/rejected HEAD:refs/heads/feat/updatable');
      const rows = readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim().split('\n');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!)).toMatchObject({ verdict: 'foreign-owner-warning', targets: [{ branch: 'feat/rejected' }, { branch: 'feat/updatable' }], PR: [{ number: 35704, branch: 'feat/updatable', seat: 'TC' }] });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('push-option operand and --no-dry-run mode are warned, recorded, and passed through', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    try {
      const variants = [
        ['push', '-o', 'incident-note', '--no-dry-run', 'origin', 'HEAD:refs/heads/feat/foreign-cell'],
        ['push', '-qo', 'incident-note', '--no-dry-run', 'origin', 'HEAD:refs/heads/feat/foreign-cell'],
        ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feat/foreign-cell'],
        ['push', '--future-option', 'origin', 'HEAD:refs/heads/feat/foreign-cell'],
      ];
      for (const args of variants) {
        const result = invokeGitInProcess(args, fixture.binDir, {
          ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('push owner guard warning');
      }
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push -o incident-note --no-dry-run origin HEAD:refs/heads/feat/foreign-cell');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push -qo incident-note --no-dry-run origin HEAD:refs/heads/feat/foreign-cell');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push --force-with-lease origin HEAD:refs/heads/feat/foreign-cell');
      expect(readFileSync(fixture.pushLog, 'utf8')).toContain('push --future-option origin HEAD:refs/heads/feat/foreign-cell');
      const rows = readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim().split('\n');
      expect(rows).toHaveLength(4);
      expect(JSON.parse(rows[3]!)).toMatchObject({ verdict: 'foreign-owner-warning', unsupportedOption: '--future-option' });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('test-universe CLI entry warns and passes through the simulated push into a foreign-seat PR', () => {
    const currentBranch = 'feat/test-universe-guard';
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: currentBranch, body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } });
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const gitPath = join(fixture.binDir, 'git');
    writeFileSync(gitPath, `#!/bin/sh
if [ "$1" = -C ]; then shift; shift; fi
if [ "$1" = push ]; then
  case " $* " in
    *" --dry-run "*) printf '%s\\n' 'To https://github.com/ElanvitalAI/elanous.git' '* HEAD:refs/heads/${currentBranch} [up to date]' ;;
    *) printf '%s\\n' "$*" >> '${fixture.pushLog}'; printf 'fake git reached\\n' ;;
  esac
  exit 0
fi
if [ "$1" = remote ]; then printf '%s\\n' 'https://github.com/ElanvitalAI/elanous.git'; exit 0; fi
if [ "$1" = symbolic-ref ]; then printf '%s\\n' '${currentBranch}'; exit 0; fi
exec '${realGit}' "$@"
`);
    chmodSync(gitPath, 0o755);
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-entry-home-'));
    try {
      const result = spawnSync('bun', [...entrypoint, '--test', 'git', 'push'], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000,
        env: isolatedCliEnvironment(home, {
          PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
        }),
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(existsSync(fixture.pushLog)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('multi-refspec force-owner checks every destination and records foreign PRs', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } }, {
      targetBranches: ['feat/foreign-cell', 'feat/second-destination'],
    });
    try {
      const result = invokeGitInProcess(['push', 'origin', 'HEAD:refs/heads/feat/foreign-cell', 'HEAD:refs/heads/feat/second-destination', '--force-owner'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      const audit = readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim().split('\n');
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!)).toMatchObject({ verdict: 'foreign-owner-warning', targets: [{ branch: 'feat/foreign-cell' }, { branch: 'feat/second-destination' }], forceOwnerRequested: true });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('multiple pushurl destinations are passed through with one uncertainty row', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' } }, {
      remoteUrls: [
        'https://github.com/ElanvitalAI/elanous.git',
        'git@github.com:mirror/elanous-agent.git',
      ],
      targetBranches: ['feat/foreign-cell'],
    });
    try {
      const result = invokeGitInProcess(['push'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('default remote origin has 2 push destinations');
      expect(readFileSync(fixture.pushLog, 'utf8').trim()).toBe('push');
      expect(JSON.parse(readFileSync(join(fixture.auditDir, 'git', 'push-owner-guard.jsonl'), 'utf8').trim())).toMatchObject({
        verdict: 'pass-uncertain', reason: 'default remote origin has 2 push destinations',
      });
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('fork remote lookup warns for the matching foreign PR', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'forker' } }, {
      remoteUrl: 'git@github.com:forker/elanous-agent.git', parentRepository: 'ElanvitalAI/elanous',
    });
    try {
      const result = invokeGitInProcess(['push', 'origin'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(readFileSync(fixture.ghLog, 'utf8')).toContain('api --method GET repos/ElanvitalAI/elanous/pulls -f state=open -f head=forker:feat/foreign-cell');
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('same head owner and branch in a different fork does not match the push target repository', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'ElanvitalAI' }, headRepositoryFullName: 'ElanvitalAI/other-fork' });
    try {
      const result = invokeGitInProcess(['push'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(fixture.pushLog, 'utf8').trim()).toBe('push');
      expect(result.stderr).not.toContain('push refused');
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('GitHub head owner comparison is case-insensitive for warning and audit', () => {
    const fixture = makePushOwnershipFixture({ number: 35704, headRefName: 'feat/foreign-cell', body: '칸: TSC-SCC-SWEEP-6', labels: [{ name: 'seat:TC' }], headRepositoryOwner: { login: 'Joosung80' } });
    try {
      const result = invokeGitInProcess(['push', 'origin'], fixture.binDir, {
        ELANOUS_TRACK: 'OPC', ELANOUS_STATE_DIR: fixture.auditDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('push owner guard warning');
      expect(existsSync(fixture.pushLog)).toBe(true);
    } finally {
      rmSync(fixture.binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('forwards successful git output and appends its success status', () => {
    const result = invokeGit(['status', '--porcelain']);
    expect(result.status).toBe(0);
    // ⛔⭐ 2026-08-09 계약 정정 — 상태 줄은 «stderr» 다. stdout 은 «원 바이트 그대로»여야 한다.
    //   초판은 stdout 에 붙였고 그래서 `$(elanous git rev-parse HEAD)` 가 «두 줄»을 돌려줬다(실측).
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] status ok rc=0');
    expect(result.stdout).not.toContain('[git]');
  }, 90_000);

  test('prefixes top-level help with guidance while preserving git help and its status line', () => {
    const baseline = spawnSync('git', ['--help'], { encoding: 'utf8', timeout: 60_000 });
    const result = invokeGit(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(baseline.stdout);
    expect(result.stdout).toStartWith('usage: git');
    expect(result.stderr).toContain('Wraps git and automatically retries transient lock failures.');
    expect(result.stderr).toContain("Git's own help follows.");
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] (none) ok rc=0');
  }, 90_000);

  test('does not show help guidance when help spellings are subcommand values or options', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-help-arguments-'));
    const gitPath = join(binDir, 'git');
    writeFileSync(gitPath, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n');
    chmodSync(gitPath, 0o755);
    try {
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
      const invocations = [
        ['commit', '-m', '--help'],
        ['grep', '-h', 'needle'],
        ['clone', '--origin', '--help', 'repository'],
      ];
      for (const args of invocations) {
        const result = invokeGit(args, env);
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('[elanous git]');
        expect(result.stdout).toBe(args.map((arg) => `<${arg}>\n`).join(''));
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('passes option operands and following arguments to git in their original order', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-argv-'));
    const gitPath = join(binDir, 'git');
    writeFileSync(gitPath, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n');
    chmodSync(gitPath, 0o755);
    try {
      const repository = join(binDir, 'repository operand');
      const result = invokeGit(['-C', repository, 'status'], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('[git] status ok rc=0\n');
      // ⭐ stdout 은 «원 바이트 그대로» — argv 전달 확인이 상태 줄에 오염되지 않는다
      expect(result.stdout).toBe(`<-C>\n<${repository}>\n<status>\n`);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('forwards git failure and exits with git actual exit code', () => {
    const result = invokeGitInProcess(['no-such-subcommand']);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain(`[git] no-such-subcommand FAILED rc=${result.status}`);
  }, 90_000);

  test('keeps failure visible after stderr and stdout are piped to tail', () => {
    const result = inIsolatedGitWorktree((cwd) => spawnSync('bash', ['-lc', `bun ${entrypoint[0]} --test git no-such-subcommand 2>&1 | tail -1`], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    }));
    expect(result.status).toBe(0);
    // ⭐⭐ 이 테스트가 이 명령의 «존재 이유»다 — `2>&1` 로 합쳐 파이프에 넣어도 실패가 «마지막 줄»에 남는다.
    //   ⛔ 2026-08-09 계약 정정 뒤에도 이 계약은 «그대로»다: 상태 줄이 stderr 로 갔지만
    //     `2>&1` 이 그것을 stdout 으로 합치므로 `tail -1` 이 여전히 그 줄을 준다.
    expect(result.stdout.trimEnd().split(/\r?\n/).at(-1)).toMatch(/^\[git\] no-such-subcommand FAILED rc=[1-9]\d*$/);
  }, 90_000);

  // ⭐⭐ 2026-08-19 — 「실패했다」와 「아무것도 안 바뀌었다」는 다른 값이다.
  //   실측: `elanous git merge origin/main` 이 충돌로 rc=1 을 냈는데 작업 트리엔 머지가 절반 들어가 있었다.
  //   상태 줄이 `FAILED rc=1` 뿐이면 읽는 사람이 「아무 일도 없었다」로 읽고 되돌려서 작업을 잃는다.
  //
  // ⛔⭐ 리뷰 must-fix: 판정은 «문면»이 아니라 «파일시스템 상태»(git 이 남기는 MERGE_HEAD 등)로 한다.
  //   그래서 이 테스트들은 가짜 git 이 아니라 ***진짜 충돌 저장소***를 만든다 —
  //   가짜 git 으로 문구만 흉내내면 초판의 «오탐»을 오히려 정당화하는 테스트가 된다.
  function inRealConflictRepo<T>(run: (cwd: string) => T): T {
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-git-cli-conflict-'));
    // ⛔ 리뷰 should-fix: 준비 명령의 종료 코드를 «본다». 안 보면 git 환경 차이가
    //   「원인 불명 실패」로 나타나고, 그때 사람은 테스트가 아니라 «구현»을 의심한다.
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`test fixture git ${args.join(' ')} failed rc=${r.status}: ${r.stderr}`);
      return r;
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      writeFileSync(join(cwd, 'a.txt'), 'base\n');
      git('add', 'a.txt'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'other');
      writeFileSync(join(cwd, 'a.txt'), 'other\n');
      git('commit', '-qam', 'other');
      git('checkout', '-q', 'main');
      writeFileSync(join(cwd, 'a.txt'), 'mine\n');
      git('commit', '-qam', 'mine');
      return run(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  /** 충돌 판정 시험의 기본 경로 — `runGitCli` 를 같은 프로세스에서(위 `runGitCliInProcess` 참조). */
  function runInRepo(cwd: string, args: string[]) {
    return asText(runGitCliInProcess(cwd, args));
  }

  /** 실물 진입점(`bun bin/elanous.mjs --test git …`) — 배선을 무는 시험에만. */
  function runInRepoReal(cwd: string, args: string[], options: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
    const home = options.home ?? mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
    try {
      return spawnSync('bun', [...entrypoint, '--test', 'git', ...args], {
        cwd, encoding: 'utf8', env: isolatedCliEnvironment(home, options.env), timeout: GIT_PUSH_TEST_CHILD_TIMEOUT_MS,
      });
    } finally {
      if (!options.home) rmSync(home, { recursive: true, force: true });
    }
  }

  test('진짜 머지 충돌 — 트리에 상태가 «남았다»는 사실을 상태 줄이 말한다', () => {
    inRealConflictRepo((cwd) => {
      // ⭐ 실물 진입점 — 충돌 표지가 CLI 를 거쳐서도 마지막 줄에 남는지(배선) 한 번은 실물로 잰다.
      const result = runInRepoReal(cwd, ['merge', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] merge FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      // ⛔ 「성공했다」고 쓰지 않는다 — 쓰는 것은 「트리가 바뀌었다」는 사실뿐이다.
      expect(result.stderr).not.toContain('merge ok rc=');
      // 📏 그리고 그 말이 «참»인지 확인한다 — git 이 실제로 MERGE_HEAD 를 남겼다.
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⛔ 오탐 방지 — 출력에 그 «문구»가 있어도 상태가 안 남았으면 표지가 없다', () => {
    inRealConflictRepo((cwd) => {
      // 초판은 출력을 정규식으로 훑어서 이런 diff 를 충돌로 «오인»했다.
      writeFileSync(join(cwd, 'a.txt'), 'Automatic merge failed; fix conflicts and then commit the result.\n');
      const result = runInRepo(cwd, ['diff', '--exit-code']);
      expect(result.status).not.toBe(0); // diff 가 있으므로 실패로 나간다
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe(`[git] diff FAILED rc=${result.status}`);
      expect(result.stderr).not.toContain('worktree-changed');
    });
  }, 120_000);

  test('⛔ 충돌 없이 실패한 merge 에는 표지가 안 붙는다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['merge', 'no-such-branch']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('worktree-changed');
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
    });
  }, 120_000);

  test('⛔ 이미 «중단된 머지»가 있는 상태에서 실패하면 표지를 안 붙인다 (stale marker 오탐)', () => {
    // ⭐ 리뷰 must-fix 2라운드: 「지금 마커가 있다」로는 부족하다.
    //   이미 MERGE_HEAD 가 있는 상태에서 새 merge 를 치면 git 은 「머지를 안 끝냈다」로 실패하는데,
    //   그 마커는 «원래» 있던 것이다 — 이번 명령은 아무것도 안 했다.
    inRealConflictRepo((cwd) => {
      const first = runInRepo(cwd, ['merge', 'other']);
      expect(first.stderr).toContain('worktree-changed=yes'); // 첫 번째는 «이번에» 남겼다
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);

      // 같은 상태에서 다시 친다 — git 은 실패하고, 마커는 «전에도» 있었다.
      const second = runInRepo(cwd, ['merge', 'other']);
      expect(second.status).not.toBe(0);
      expect(second.stderr).not.toContain('worktree-changed');
      expect(second.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe(`[git] merge FAILED rc=${second.status}`);
    });
  }, 120_000);

  test('rebase 충돌도 «진짜»로 표지가 붙는다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['rebase', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] rebase FAILED rc=${result.status} worktree-changed=yes reason=rebase-conflict`);
      // 📏 말이 «참»인지 확인 — git 이 실제로 rebase 상태를 남겼다.
      expect(existsSync(join(cwd, '.git', 'rebase-merge')) || existsSync(join(cwd, '.git', 'rebase-apply'))).toBe(true);
    });
  }, 120_000);

  test('cherry-pick 충돌도 «진짜»로 표지가 붙는다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['cherry-pick', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] cherry-pick FAILED rc=${result.status} worktree-changed=yes reason=cherry-pick-conflict`);
      expect(existsSync(join(cwd, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⛔ "would be overwritten" 류 — git 이 «아무것도 안 하고» 멈춘 실패엔 표지가 없다', () => {
    inRealConflictRepo((cwd) => {
      // 커밋 안 한 로컬 변경을 두고 merge 하면 git 은 손대지 않고 거부한다.
      writeFileSync(join(cwd, 'a.txt'), 'uncommitted local edit\n');
      const result = runInRepo(cwd, ['merge', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('worktree-changed');
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
    });
  }, 120_000);

  test('pull 충돌도 «진짜»로 표지가 붙는다 (내부적으로 merge 를 돌린다)', () => {
    inRealConflictRepo((cwd) => {
      // 자기 자신을 remote 로 삼아 other 를 당긴다 — pull 은 fetch ⊕ merge 이고 MERGE_HEAD 를 남긴다.
      const result = runInRepo(cwd, ['pull', '--no-rebase', '.', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] pull FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⭐ `-C <dir>` 등 전역 옵션이 앞에 붙어도 하위 명령과 git-dir 을 옳게 찾는다', () => {
    // ⛔ 리뷰 4라운드가 「gitSubcommand 가 <dir> 을 subcommand 로 오인한다」고 지적했으나
    //   실측하면 옳게 동작한다(GLOBAL_OPTIONS_WITH_OPERANDS 가 피연산자를 건너뛴다).
    //   ⇒ 반론만 하지 않고 «회귀로 못 박는다» — 이 경로가 깨지면 표지가 조용히 사라진다.
    // ⚠️ 저장소 «밖»에서 돌리면 elanous 의 격리 관문이 먼저 막는다(별개 축) — 그래서 저장소 «안»에서
    //   전역 옵션만 앞에 붙여 «파서»를 잰다. 피연산자를 건너뛰는지가 이 테스트의 대상이다.
    inRealConflictRepo((cwd) => {
      // ⭐ 실물 진입점 — `-c`·`-C` 가 commander 를 «그대로» 통과하는지도 이 시험의 대상이다.
      const result = runInRepoReal(cwd, ['-c', 'user.name=probe', '-C', cwd, 'merge', 'other']);
      expect(result.status).not.toBe(0);
      // 하위 명령이 `merge` 로 잡혔다 — `-c` 의 값도 `-C` 의 디렉토리도 «아니다».
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] merge FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⛔ 마커가 생겨도 «충돌이 아니면» conflict 라 쓰지 않는다 (rebase --exec false)', () => {
    // ⭐ 리뷰 must-fix 5라운드: 마커 생성 ≠ 충돌.
    //   `--exec false` 는 충돌 없이도 rebase 를 중단시켜 상태를 남긴다.
    //   그때 「conflict」라 쓰면 ***안 일어난 일을 적는 것***이다.
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['rebase', '--exec', 'false', 'HEAD~1']);
      expect(result.status).not.toBe(0);
      const last = result.stderr.trimEnd().split(/\r?\n/).at(-1);
      expect(last).toContain('worktree-changed=yes');
      // 상태는 남았지만 «충돌»은 아니다 — 그래서 in-progress 다.
      expect(last).toContain('reason=rebase-in-progress');
      expect(last).not.toContain('conflict');
    });
  }, 120_000);

  test('pull --rebase 충돌은 «rebase» 상태로 잡힌다 (MERGE_HEAD 만 보면 놓친다)', () => {
    // ⭐ 리뷰 must-fix 5라운드: pull.rebase 면 rebase 마커를 남긴다.
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['pull', '--rebase', '.', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] pull FAILED rc=${result.status} worktree-changed=yes reason=rebase-conflict`);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false); // merge 가 아니다
    });
  }, 120_000);

  test('충돌 «경로가 많아도» conflict 로 잡힌다 (산출 길이에 안 기댄다)', () => {
    // ⭐ 경로 «목록»으로 물으면 대량 충돌에서 maxBuffer 를 넘겨 진짜 충돌이 in-progress 로
    //   거짓 표기된다. `--quiet` 은 산출을 아예 안 내므로 그 부류가 구조적으로 사라진다.
    // ⚠️ 정직하게: ***이 테스트는 1MiB 조건을 «재현하지 않는다».*** 60개로는 그만큼이 안 나온다.
    //   이 테스트가 고정하는 것은 「경로가 여럿일 때도 판정이 유지된다」뿐이고,
    //   버퍼 부류의 제거는 «구조»(산출 0바이트)가 보장한다.
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-git-cli-many-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} rc=${r.status}: ${r.stderr}`);
      return r;
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      const names = Array.from({ length: 60 }, (_, i) => `f${i}.txt`);
      for (const n of names) writeFileSync(join(cwd, n), 'base\n');
      git('add', '.'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'other');
      for (const n of names) writeFileSync(join(cwd, n), 'other\n');
      git('commit', '-qam', 'other');
      git('checkout', '-q', 'main');
      for (const n of names) writeFileSync(join(cwd, n), 'mine\n');
      git('commit', '-qam', 'mine');

      const result = asText(runGitCliInProcess(cwd, ['merge', 'other']));
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] merge FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  test('pull.rebase=true 설정 경로도 rebase 상태로 잡힌다', () => {
    // ⭐ 리뷰 should-fix: --rebase 플래그만이 아니라 «설정»으로도 같은 상태가 된다.
    inRealConflictRepo((cwd) => {
      const configured = spawnSync('git', ['config', 'pull.rebase', 'true'], { cwd, encoding: 'utf8', timeout: 60_000 });
      expect(configured.status).toBe(0); // fixture 준비 실패를 즉시 드러낸다
      const result = runInRepo(cwd, ['pull', '.', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] pull FAILED rc=${result.status} worktree-changed=yes reason=rebase-conflict`);
    });
  }, 120_000);

  test('성공한 명령에는 어떤 경우에도 그 표지가 안 붙는다', () => {
    const result = invokeFakeGit('Automatic merge failed; fix conflicts and then commit the result.\n', '', 0);
    expect(result.status).toBe(0);
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] fixture ok rc=0');
  }, 90_000);

  test('separates its status line after newline-free stdout and preserves the git exit code', () => {
    const result = invokeFakeGit('raw-stdout', '', 7);
    expect(result.status).toBe(7);
    // ⭐ 핵심 회귀: stdout 은 «원 바이트 그대로**(separator 도 안 붙는다)
    expect(result.stdout).toBe('raw-stdout');
    expect(result.stderr).toBe('[git] fixture FAILED rc=7\n');
  }, 90_000);

  test('separates its status line after newline-free stderr without rewriting that stream', () => {
    const result = invokeFakeGit('', 'raw-stderr', 9);
    expect(result.status).toBe(9);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('raw-stderr\n[git] fixture FAILED rc=9\n');
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] fixture FAILED rc=9');
  }, 90_000);

  // ⛔⭐⭐⭐ 리뷰 must-fix(2026-08-03) — **이 조합이 없어서 결함이 가려져 있었다.**
  //    stdout 이 개행 없이 끝나고 stderr 가 개행으로 끝나면, 초판 로직(stderr 우선)은 separator 를
  //    건너뛰어 stdout 이 `raw-stdout[git] …` 로 붙었다. **stdout 만 파이프로 받는 소비자**에게는
  //    상태 줄이 독립된 마지막 줄이 아니게 된다 — 이 명령이 존재하는 계약 그 자체다.
  test('separates its status line when stdout lacks a newline but stderr ends with one', () => {
    const result = invokeFakeGit('raw-stdout', 'raw-stderr\n', 5);
    expect(result.status).toBe(5);
    expect(result.stderr).toBe('raw-stderr\n[git] fixture FAILED rc=5\n');
    // ⭐ stdout 만 파이프로 받는 소비자에게는 «순수 산출»만 간다 — 이것이 새 계약이다.
    expect(result.stdout).toBe('raw-stdout');
  }, 90_000);

  test('separates its status line after stdout ending in a lone CR', () => {
    const result = invokeFakeGit('raw-stdout\r', '', 7);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('raw-stdout\r');
    expect(result.stderr).toBe('[git] fixture FAILED rc=7\n');
  }, 90_000);

  test('separates its status line after stderr ending in a lone CR', () => {
    const result = invokeFakeGit('', 'raw-stderr\r', 9);
    expect(result.status).toBe(9);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('raw-stderr\r\n[git] fixture FAILED rc=9\n');
  }, 90_000);

  test('does not add an extra separator after CRLF stdout', () => {
    const result = invokeFakeGit('raw-stdout\r\n', '', 7);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('raw-stdout\r\n');
    expect(result.stderr).toBe('[git] fixture FAILED rc=7\n');
  }, 90_000);

  test('does not add an extra separator after CRLF stderr', () => {
    const result = invokeFakeGit('', 'raw-stderr\r\n', 9);
    expect(result.status).toBe(9);
    expect(result.stderr).toBe('raw-stderr\r\n[git] fixture FAILED rc=9\n');
    expect(result.stdout).toBe('');
  }, 90_000);

  test('forwards stdout larger than the default 1MB spawn buffer without truncation', () => {
    // 3MB exceeds the historical default maxBuffer (1MB) that would ENOBUFS-truncate the output.
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x61); // 'a'
    const result = invokeFakeGitBytes(payload, Buffer.alloc(0), 0);
    expect(result.status).toBe(0);
    const out = result.stdout as unknown as Buffer;
    // ⭐ stdout 은 «원 바이트 그대로» — 접미 한 글자도 안 붙는다(새 계약)
    expect(out.length).toBe(payload.length);
    expect(out.equals(payload)).toBe(true);
    expect(String(result.stderr)).toBe('[git] fixture ok rc=0\n');
  }, 90_000);

  test('passes invalid UTF-8 bytes through stdout and stderr unchanged', () => {
    // 0xff 0xfe 0x80 are not valid UTF-8; utf8 decoding would replace them with U+FFFD (ef bf bd).
    const rawOut = Buffer.from([0xff, 0xfe, 0x80, 0x72, 0x61, 0x77]);
    const rawErr = Buffer.from([0x80, 0xc0, 0xaf, 0x65, 0x72, 0x72]);
    const result = invokeFakeGitBytes(rawOut, rawErr, 3);
    expect(result.status).toBe(3);
    const out = result.stdout as unknown as Buffer;
    const err = result.stderr as unknown as Buffer;
    // stdout: ⭐ raw bytes «만» — 상태 줄도 separator 도 안 붙는다(새 계약).
    expect(out.equals(rawOut)).toBe(true);
    // stderr: raw bytes 를 그대로 보존한 «뒤» separator ⊕ 상태 줄이 붙는다.
    const errSuffix = Buffer.from('\n[git] fixture FAILED rc=3\n');
    expect(err.subarray(0, rawErr.length).equals(rawErr)).toBe(true);
    expect(err.subarray(rawErr.length).equals(errSuffix)).toBe(true);
    // Guard against the U+FFFD replacement byte sequence leaking into either stream.
    expect(out.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(err.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  }, 90_000);

  test('records the wrapper numerator, exit code, duration, and lock retries without touching streams', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-observation-'));
    const gitPath = join(binDir, 'git');
    const countPath = join(binDir, 'count');
    writeFileSync(gitPath, `#!/bin/sh\ncount=0; [ -f '${countPath}' ] && count=$(cat '${countPath}'); count=$((count + 1)); printf %s "$count" > '${countPath}'; if [ "$count" -eq 1 ]; then printf 'index.lock' >&2; exit 1; fi; printf raw-output; exit 0\n`);
    chmodSync(gitPath, 0o755);
    const script = `const root = process.env.REPOSITORY_ROOT; const { debug } = await import(root + '/src/debug/log.js'); const { runGitCli } = await import(root + '/src/git-fs/git-cli.js'); debug.setFileEnabled(false); debug.setVerboseEnabled(true); const records = []; const off = debug.registerSink({ name: 'git-cli-observation-capture', emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }) }); runGitCli(['status', '--short']); off(); debug.setVerboseEnabled(false); process.stderr.write(JSON.stringify(records));`;
    try {
      const result = inIsolatedGitWorktree((cwd) => spawnSync('bun', ['-e', script], {
        cwd,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, REPOSITORY_ROOT: repositoryRoot },
        encoding: 'utf8',
        timeout: 60_000,
      }));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('raw-output');
      const [status, recordsJson] = result.stderr.trimEnd().split('\n');
      expect(status).toBe('[git] status ok rc=0');
      const records = JSON.parse(recordsJson!) as Array<{ category: string; event: string; data?: Record<string, unknown> }>;
      const record = records.find(({ category, event }) => category === 'git.cli' && event === 'completed');
      expect(record?.data).toMatchObject({ subcommand: 'status', exitCode: 0, ok: true, lockRetryCount: 1, measurementScope: 'wrapper-numerator-only; raw shell git and PATH/hook denominator are out of scope' });
      expect(record?.data?.durationMs).toBeNumber();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('confirms a timed-out push by ls-remote and emits a PARTIAL_OUTCOME receipt', () => {
    const fixture = createTempGitRepo({ branch: 'topic/push-timeout', files: { 'timeout.txt': 'accepted remotely\n' } });
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-push-timeout-'));
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-push-timeout-home-'));
    const gitPath = join(binDir, 'git');
    const lsRemoteCalls = join(binDir, 'ls-remote-calls');
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
    try {
      if (realGit.status !== 0 || !realGit.stdout.trim()) throw new Error('git executable is unavailable');
      writeFileSync(gitPath, gitPushTimeoutAfterRemoteApplyShim());
      writeFileSync(lsRemoteCalls, '');
      chmodSync(gitPath, 0o755);
      const target = 'refs/heads/topic/push-timeout';
      const sourceRef = 'refs/heads/topic/push-timeout';
      const expectedSha = fixture.git(fixture.repo, ['rev-parse', 'HEAD']);
      const result = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', 'origin', `${sourceRef}:${sourceRef}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'after-apply',
        }),
        timeout: 60_000,
      });
      const remoteLine = fixture.git(fixture.repo, ['ls-remote', fixture.remote, target]).trim();
      expect(remoteLine).toBe(`${expectedSha}\t${target}`);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`PARTIAL_OUTCOME primary-outcome=CONFIRMED_APPLIED verification=ls-remote ref=${target} sha=${expectedSha} rc=0`);
      expect(result.stderr).toContain('simulated transport timeout after remote accepted push');

      const beforeApplyTarget = 'refs/heads/not-applied';
      const unconfirmed = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', 'origin', `${sourceRef}:${beforeApplyTarget}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'before-apply',
        }),
        timeout: 60_000,
      });
      expect(unconfirmed.status).toBe(1);
      expect(unconfirmed.stderr).toContain(`PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=ls-remote reason=ref-mismatch ref=${beforeApplyTarget} rc=1`);
      expect(unconfirmed.stderr).toContain('simulated transport timeout before remote accepted push');
      expect(readFileSync(lsRemoteCalls, 'utf8').trim().split('\n')).toEqual([
        `ls-remote --quiet ${fixture.remote} ${target}`,
        `ls-remote --quiet ${fixture.remote} ${beforeApplyTarget}`,
      ]);

      const upstreamRef = 'refs/heads/topic/upstream-side-effect';
      fixture.git(fixture.repo, ['branch', 'topic/upstream-side-effect', expectedSha]);
      const upstream = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', '-u', 'origin', `${upstreamRef}:${upstreamRef}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'after-apply',
        }),
        timeout: 60_000,
      });
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, upstreamRef]).trim()).toBe(`${expectedSha}\t${upstreamRef}`);
      expect(upstream.status).toBe(1);
      expect(upstream.stderr).toContain('PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=not-attempted reason=unsupported-push-shape');

      const symbolicRef = 'refs/heads/topic/push-timeout-alias';
      fixture.git(fixture.repo, ['symbolic-ref', symbolicRef, sourceRef]);
      const symbolic = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', 'origin', `${symbolicRef}:${symbolicRef}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'after-apply',
        }),
        timeout: 60_000,
      });
      expect(symbolic.status).toBe(1);
      expect(symbolic.stderr).toContain('PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=not-attempted reason=unsupported-push-shape');

      const pinnedTarget = 'refs/heads/pinned-before-ref-move';
      const pinned = runInRepoReal(fixture.repo, ['push', 'origin', `${sourceRef}:${pinnedTarget}`], {
        home,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'move-source-then-apply',
        },
      });
      expect(pinned.status).toBe(1);
      expect(fixture.git(fixture.repo, ['rev-parse', sourceRef])).not.toBe(expectedSha);
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, pinnedTarget]).trim())
        .toBe(`${expectedSha}\t${pinnedTarget}`);
      expect(pinned.stderr).toContain('reason=source-ref-changed');
      fixture.git(fixture.repo, ['reset', '--hard', expectedSha]);

      const movedBack = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', 'origin', `${sourceRef}:${sourceRef}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'before-apply-restore-head',
          ELANOUS_SIM_PUSH_RESTORE_SHA: expectedSha,
        }),
        timeout: 60_000,
      });
      expect(fixture.git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(expectedSha);
      expect(movedBack.status).toBe(1);
      expect(movedBack.stderr).toContain('PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=not-attempted reason=source-ref-changed');

      const symbolicTarget = 'refs/heads/topic/push-timeout-symbolic-target';
      fixture.git(fixture.repo, ['branch', 'topic/push-timeout-symbolic-target', expectedSha]);
      const symbolicCycle = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', 'origin', `${sourceRef}:${sourceRef}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'before-apply-ref-cycle',
          ELANOUS_SIM_PUSH_SOURCE_REF: sourceRef,
          ELANOUS_SIM_PUSH_SYMBOLIC_TARGET: symbolicTarget,
          ELANOUS_SIM_PUSH_RESTORE_SHA: expectedSha,
        }),
        timeout: 60_000,
      });
      expect(fixture.git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(expectedSha);
      expect(symbolicCycle.status).toBe(1);
      expect(symbolicCycle.stderr).toContain('PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=not-attempted reason=source-ref-changed');

      const race = spawnSync('bun', [...entrypoint, '--test', 'git', 'push', 'origin', `${sourceRef}:${sourceRef}`], {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit.stdout.trim(),
          ELANOUS_SIM_GIT_LS_REMOTE_CALLS: lsRemoteCalls,
          ELANOUS_SIM_PUSH_TIMEOUT_MODE: 'before-apply-move-head',
        }),
        timeout: 60_000,
      });
      expect(race.status).toBe(1);
      expect(race.stderr).toContain('PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=not-attempted reason=source-ref-changed');
    } finally {
      fixture.cleanup();
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test('test-universe CLI pins packed refs and refuses to change the pre-push hook local-ref contract', () => {
    const fixture = createTempGitRepo({ branch: 'topic/packed-source', files: { 'packed.txt': 'source\n' } });
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-packed-home-'));
    const hookInput = join(fixture.root, 'pre-push-input');
    const hook = join(fixture.repo, '.git', 'hooks', 'pre-push');
    try {
      const source = 'refs/heads/topic/packed-source';
      const target = 'refs/heads/topic/pinned-packed';
      const sha = fixture.git(fixture.repo, ['rev-parse', source]).trim();
      fixture.git(fixture.repo, ['pack-refs', '--all', '--prune']);
      expect(existsSync(join(fixture.repo, '.git', source))).toBe(false);
      const pinned = runInRepoReal(fixture.repo, ['push', 'origin', `${source}:${target}`], { home });
      expect(pinned.status).toBe(0);
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, target]).trim()).toBe(`${sha}\t${target}`);

      const nullHooksTarget = 'refs/heads/topic/null-hooks';
      const nullHooks = runInRepoReal(fixture.repo,
        ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `${source}:${nullHooksTarget}`], { home });
      expect(nullHooks.status).toBe(0);
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, nullHooksTarget]).trim()).toBe(`${sha}\t${nullHooksTarget}`);

      writeFileSync(hook, `#!/bin/sh\ncat > '${hookInput}'\n`);
      chmodSync(hook, 0o755);
      const hookedTarget = 'refs/heads/topic/hook-contract';
      const refused = runInRepoReal(fixture.repo, ['push', 'origin', `${source}:${hookedTarget}`], { home });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('push source pin refused: an executable pre-push hook requires the original local ref');
      expect(existsSync(hookInput)).toBe(false);
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, hookedTarget]).trim()).toBe('');

      const missing = runInRepoReal(fixture.repo, ['push', 'origin', 'refs/heads/missing:refs/heads/missing'], { home });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('push source pin refused: cannot resolve refs/heads/missing to a commit');
      expect(existsSync(hookInput)).toBe(false);
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, 'refs/heads/missing']).trim()).toBe('');
    } finally { fixture.cleanup(); rmSync(home, { recursive: true, force: true }); }
  }, 90_000);

  test('test-universe CLI refuses when a pre-push hook appears after the first pin check', () => {
    const fixture = createTempGitRepo({ branch: 'topic/hook-race', files: { 'hook-race.txt': 'source\n' } });
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-hook-race-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-hook-race-bin-'));
    const gitPath = join(binDir, 'git');
    const hookPath = join(fixture.repo, '.git', 'hooks', 'pre-push');
    const hookRun = join(fixture.root, 'pre-push-ran');
    const hookQueryCount = join(fixture.root, 'hook-query-count');
    const realGit = findGitExecutable();
    try {
      writeFileSync(gitPath, `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ] && [ "$3" = "--git-path" ] && [ "$4" = "hooks/pre-push" ]; then
  count=$(cat "$ELANOUS_SIM_HOOK_QUERY_COUNT" 2>/dev/null || printf 0)
  count=$((count + 1))
  printf '%s' "$count" > "$ELANOUS_SIM_HOOK_QUERY_COUNT"
  if [ "$count" -eq 2 ]; then
    printf '#!/bin/sh\\nprintf ran > "%s"\\n' "$ELANOUS_SIM_HOOK_RUN" > "$ELANOUS_SIM_HOOK_PATH"
    chmod 755 "$ELANOUS_SIM_HOOK_PATH"
  fi
fi
exec "$ELANOUS_SIM_REAL_GIT" "$@"
`);
      chmodSync(gitPath, 0o755);
      const target = 'refs/heads/topic/hook-race-target';
      const result = runInRepoReal(fixture.repo, ['push', 'origin', `refs/heads/topic/hook-race:${target}`], {
        home,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_SIM_REAL_GIT: realGit,
          ELANOUS_SIM_HOOK_QUERY_COUNT: hookQueryCount,
          ELANOUS_SIM_HOOK_PATH: hookPath,
          ELANOUS_SIM_HOOK_RUN: hookRun,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('push source pin refused: pre-push hook state changed before git push');
      expect(existsSync(hookPath)).toBe(true);
      expect(existsSync(hookRun)).toBe(false);
      expect(fixture.git(fixture.repo, ['ls-remote', fixture.remote, target]).trim()).toBe('');
    } finally {
      fixture.cleanup();
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

});
