// Deterministic full-suite entry point.
//
// `bun test` intentionally remains Bun's raw discovery command for focused
// work.  This wrapper is the repository-wide gate: it prevents a developer's
// HOME/configuration or credentials from silently turning a unit test into a
// live provider/CLI run.
//
// ⚠️ WHAT THIS DOES **NOT** DO — stated so nobody reads more guarantee into
// the name than it has:
//   - It does not remove `PATH`, so an installed CLI is still reachable. A
//     test that shells out to a real binary still shells out to it. Removing
//     PATH would take `bun` itself with it; containing CLI reach belongs to
//     per-test seams, not to this wrapper.
//   - It does not block network egress. A test that opens a non-loopback
//     socket still opens it. Egress control is a sandbox/CI concern.
//   - It removes ambient *configuration and credentials*, which is what makes
//     an accidental live call succeed. Without a key the call fails fast
//     instead of running up a bill — that is the boundary this buys, and the
//     tiering plan in PLAN-test-suite-diet is what closes the rest.
//   - It does not sweep leftover `elanous-deterministic-test-*` directories from
//     earlier runs. That remains out of scope on purpose.
//   - 2026-08-26 landed `child.kill` only and wrote that this wrapper "does not
//     chase grandchildren of the direct `bun test` child. Those are out of
//     scope on purpose." That boundary left interactive shells behind when the
//     full suite was interrupted (observed 2026-08-27: leftover bash --norc
//     --noprofile -i from test/pty-snapshot-resize.test.ts). The child is now
//     spawned as its own process-group leader (`detached: true`) and SIGINT /
//     SIGTERM signal that group so grandchildren die with it. This still does
//     not hunt processes by name, and it never signals this process's own
//     group. If group termination fails it falls back to the direct child and
//     reports the failure.

import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// The predicate lives in its own side-effect-free module so it can be tested:
// importing THIS file used to spawn the suite at load time. The runner is now
// behind `import.meta.main` / `runDeterministicTests()`, but the filter stays
// in the helper so an untested credential check cannot rot silently.
import { isCredentialKey } from './lib/deterministic-env.js';
import { envLiteral } from '../src/platform/env-literal.js';

export const TEMP_ROOT_PREFIX = 'elanous-deterministic-test-';
export const CHILD_EXIT_GRACE_MS = 2_000;

// A deterministic test child is not a harness executor: these inherited
// markers would activate write-boundary policy against each test's temp files.
const HARNESS_TEST_ENV_KEYS = [
  'ELANOUS_HARNESS_SPACE',
  'ELANOUS_HARNESS_SPACE_ID',
  'ELANOUS_HARNESS_BOUNDARY',
  'ELANOUS_HARNESS_ROLE',
  'ELANOUS_HARNESS_DETACHED',
] as const;

// Discovery: rg -n "process\.env\.ELANOUS_(HOST|RUN|ORIGIN|SUPERVISOR|PARENT)" src
// These are ambient execution identities, not inputs to a deterministic test.
// debug.log also attributes SUBSTRATE and ARM_ID to every plain-object record.
export const GIT_LOCATION_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

const EXECUTION_ORIGIN_ENV_KEYS = [
  'ELANOUS_HOST_ID',
  'ELANOUS_RUN_ID',
  'ELANOUS_RUN_CONTEXT',
  'ELANOUS_PARENT_RUN_ID',
  'ELANOUS_PARENT_PTY_ID',
  'ELANOUS_PARENT_SELF_DEV_RUNS_DIR',
  'ELANOUS_SUBSTRATE',
  'ELANOUS_ARM_ID',
  // Parent account selection changes CLI rotation assertions in the child.
  'ELANOUS_CODEX_ACCOUNT',
  // A parent's derived-root label must not reclassify a test's explicit state dir.
  'ELANOUS_STATE_DIR_SOURCE',
] as const;

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export type DirectChild = {
  readonly pid?: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): boolean | void;
};

export type SpawnDirectChild = (opts: {
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: 'inherit';
  stdout: 'inherit';
  stderr: 'inherit';
  detached: true;
}) => DirectChild;

export type KillProcessGroup = (pid: number, signal: NodeJS.Signals) => void;
export type GetProcessGroupId = (pid: number) => number;

export type SignalTarget = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
};

export type ShutdownSignalGate = {
  readonly received: Promise<ShutdownSignal>;
  dispose(): void;
};

export type DeterministicRunnerDeps = {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  /** 시험이 파생을 갈아 끼울 자리 — 실물 rg 를 안 부르고 목록을 준다. */
  deriveCdpPatterns?: () => string[];
  cwd?: string;
  tmpdir?: () => string;
  mkdtempSync?: (prefix: string) => string;
  rmSync?: (path: string, options: { recursive: true; force: true }) => void;
  spawn?: SpawnDirectChild;
  waitForSignal?: () => Promise<ShutdownSignal>;
  signalTarget?: SignalTarget;
  onAbsorbSignal?: (signal: ShutdownSignal) => void;
  report?: (message: string) => void;
  killSelf?: (signal: ShutdownSignal) => void;
  childGraceMs?: number;
  killProcessGroup?: KillProcessGroup;
  getProcessGroupId?: GetProcessGroupId;
  gitConfig?: (cwd: string, args: string[]) => string | undefined;
};

export function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    // EPERM means the process exists but this uid cannot signal it — not death.
    return code === 'EPERM';
  }
}

export function isLiveProcessGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'ESRCH') return false;
    // EPERM means the group exists but this uid cannot signal it — not death.
    return true;
  }
}

export async function waitUntilPidAndGroupDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLivePid(pid) && !isLiveProcessGroup(pid)) return true;
    await Bun.sleep(25);
  }
  return !isLivePid(pid) && !isLiveProcessGroup(pid);
}

function decodeSpawnOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}

export function getProcessGroupId(pid: number): number {
  const target = pid === 0 ? process.pid : pid;
  const result = Bun.spawnSync({
    cmd: ['ps', '-o', 'pgid=', '-p', String(target)],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const parsed = Number(decodeSpawnOutput(result.stdout).trim().split(/\s+/)[0]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`failed to read process group id for pid=${target}`);
  }
  return parsed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportVisible(message: string, report: (message: string) => void = console.error): void {
  report(message);
}

export function cleanupTemporaryRoot(
  testRoot: string,
  deps: { rmSync?: DeterministicRunnerDeps['rmSync']; report?: (message: string) => void } = {},
): void {
  const remove = deps.rmSync ?? rmSync;
  const report = deps.report ?? console.error;
  try {
    remove(testRoot, { recursive: true, force: true });
  } catch (error) {
    reportVisible(`failed to remove temporary root: ${testRoot}: ${formatError(error)}`, report);
  }
}

export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  deps: { getProcessGroupId?: GetProcessGroupId } = {},
): void {
  const getPgid = deps.getProcessGroupId ?? getProcessGroupId;
  const ownPgid = getPgid(0);
  if (pid === ownPgid) {
    throw new Error("refusing to signal this process's own group");
  }
  try {
    if (getPgid(pid) === ownPgid) {
      throw new Error("refusing to signal this process's own group");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("own group")) throw error;
    // getpgid failed — the detached leader pid still identifies the group.
  }
  process.kill(-pid, signal);
}

function signalDirectChild(
  child: DirectChild,
  pid: number,
  sig: NodeJS.Signals,
  report: (message: string) => void,
): void {
  try {
    child.kill(sig);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code !== 'ESRCH') {
      reportVisible(`failed to signal child pid=${pid} with ${sig}: ${formatError(error)}`, report);
    }
  }
}

export async function terminateDirectChild(
  child: DirectChild,
  signal: NodeJS.Signals,
  deps: {
    graceMs?: number;
    report?: (message: string) => void;
    killProcessGroup?: KillProcessGroup;
    getProcessGroupId?: GetProcessGroupId;
  } = {},
): Promise<void> {
  const report = deps.report ?? console.error;
  const graceMs = deps.graceMs ?? CHILD_EXIT_GRACE_MS;
  const killGroup = deps.killProcessGroup ?? ((pgid, sig) => killProcessGroup(pgid, sig, { getProcessGroupId: deps.getProcessGroupId }));
  const pid = child.pid;
  if (pid === undefined) {
    reportVisible('failed to terminate child: no pid', report);
    return;
  }

  const tryKill = (sig: NodeJS.Signals): void => {
    try {
      killGroup(pid, sig);
    } catch (error) {
      reportVisible(`failed to signal process group pgid=${pid} with ${sig}: ${formatError(error)}`, report);
      signalDirectChild(child, pid, sig, report);
    }
  };

  tryKill(signal);
  // Direct-child death is not group death: a SIGTERM-ignoring grandchild can
  // outlive the leader. Reap only when both the leader pid and the group are gone.
  if (await waitUntilPidAndGroupDead(pid, graceMs)) return;
  tryKill('SIGKILL');
  if (await waitUntilPidAndGroupDead(pid, graceMs)) return;
  reportVisible(`failed to terminate child pid=${pid}`, report);
}

function gitConfig(cwd: string, args: string[]): string | undefined {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV_KEYS) delete env[key];
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.error || (result.status !== 0 && !(result.status === 1 && args.includes('--get-all') && !result.stderr))) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
  if (result.status === 1) return undefined;
  // --null --get-all terminates each complete value with NUL, even when
  // a value itself contains newlines or is empty.
  return args.includes('--get-all') ? result.stdout : result.stdout.trim();
}

export function prepareIsolatedTestEnv(sourceEnv: NodeJS.ProcessEnv, testRoot: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => !isCredentialKey(key)
      && !HARNESS_TEST_ENV_KEYS.includes(key as typeof HARNESS_TEST_ENV_KEYS[number])
      && !EXECUTION_ORIGIN_ENV_KEYS.includes(key as typeof EXECUTION_ORIGIN_ENV_KEYS[number])
      && !GIT_LOCATION_ENV_KEYS.includes(key as typeof GIT_LOCATION_ENV_KEYS[number])),
  );
  env.HOME = testRoot;
  // userConfigPath() warns whenever XDG_CONFIG_HOME is set, including when
  // config.json is absent. Use its non-XDG path; migrateLegacyXdgUserConfig()
  // resolves the old path through ELANOUS_TEST_HOME rather than the real home.
  delete env.XDG_CONFIG_HOME;
  env.ELANOUS_TEST_HOME = testRoot;
  // HOME and ELANOUS_STATE_DIR isolate both the state and default config roots.
  // ELANOUS_CONFIG_DIR is not a config-dir override; discard an inherited value
  // rather than passing an ignored variable that appears to provide isolation.
  env.ELANOUS_STATE_DIR = join(testRoot, 'state');
  delete env.ELANOUS_CONFIG_DIR;
  // All ambient execution identities are removed by EXECUTION_ORIGIN_ENV_KEYS
  // above, before the child is spawned; logger API-shape tests need their absence.
  // ⚠️ No `ELANOUS_TEST_DETERMINISTIC` marker is exported. Nothing reads it yet,
  // and an env var with no consumer is a surface that looks like a contract
  // while guaranteeing nothing — a later test could branch on it believing it
  // means something. The tier work in PLAN-test-suite-diet introduces the
  // signal together with the code that honours it.
  return envLiteral(env);
}

const defaultSpawn: SpawnDirectChild = (opts) => Bun.spawn({
  cmd: opts.cmd,
  cwd: opts.cwd,
  env: opts.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  detached: true,
});

export function installShutdownSignalGate(
  target: SignalTarget = process,
  onAbsorb: (signal: ShutdownSignal) => void = () => {},
): ShutdownSignalGate {
  let first: ShutdownSignal | undefined;
  let resolveFirst: ((signal: ShutdownSignal) => void) | undefined;
  const received = new Promise<ShutdownSignal>((resolve) => {
    resolveFirst = resolve;
  });

  const handle = (signal: ShutdownSignal) => {
    if (first !== undefined) {
      onAbsorb(signal);
      return;
    }
    first = signal;
    resolveFirst?.(signal);
  };

  const onInt = () => handle('SIGINT');
  const onTerm = () => handle('SIGTERM');
  // Keep listeners until dispose() — a one-shot listener would restore the
  // default action mid-shutdown, so a second SIGINT/SIGTERM could kill us
  // before the direct child and temporary root are cleaned.
  target.on('SIGINT', onInt);
  target.on('SIGTERM', onTerm);

  return {
    received,
    dispose: () => {
      target.removeListener('SIGINT', onInt);
      target.removeListener('SIGTERM', onTerm);
    },
  };
}

export function resignalSelf(signal: ShutdownSignal, report: (message: string) => void = console.error): void {
  try {
    process.kill(process.pid, signal);
  } catch (error) {
    reportVisible(`failed to re-signal self with ${signal}: ${formatError(error)}`, report);
  }
}

/** CDP(실제 브라우저)를 타는 시험 파일을 ***목록으로 적지 않고 파생***한다.
 *
 *  🩸 왜 (🅕 실측 2026-09-24 · 브라우저가 «떠 있는» 상태에서):
 *    check-layout-landmark 137.6초/7건 = 19.7초/건 · check-layout 176.8초/15건 = 11.8초/건
 *    ↔ CDP 를 «안» 타는 nav-signature 는 0.9초/5건 = 0.2초/건.
 *    CDP 시험 123~199건 × 14초 ⇒ ***29~46분***. 기준선 전수 72분 중 큰 몫이었다.
 *  🔑 그리고 그 시험들은 ***브라우저 유무·부하에 따라 결과가 달라진다*** — 게이트 이름이
 *    `deterministic` 인데 결정적이지 않다(인계 §38-i: 로드 216 에서 「재서 틀린 값」을 냈다).
 *  ⛔ 목록을 손으로 적지 않는 이유: 새 CDP 시험이 생기면 ***자동으로*** 따라와야 한다.
 *  ⚠️ 판별이 덮는 것: `requireCdpBase` 직접 import ⊕ 전용 측정 포트 `9333` 직접 사용.
 *    ⛔ ***전이 호출은 못 잡는다*** — 실측: `loop/prepare-edition.test.ts` 는 자식으로
 *    `check-clone.ts` 를 spawn 한다. 그것은 «알려진 한계»이고, 그 파일들은 기본 레인에 남는다. */
export function deriveCdpTestPatterns(deps: { spawnSync?: typeof Bun.spawnSync; cwd?: string } = {}): string[] {
  const run = deps.spawnSync ?? Bun.spawnSync;
  const result = run({
    // ⛔ `requireCdpBase` «만» 으로는 못 잡는다 — 실측 2026-09-24: 여섯 파일이 포트 목록
    //    `[9333, 9222, …]` 을 ***직접 박아*** CDP 에 붙는다(test/webclone-check-layout-*).
    //    그래서 「전용 측정 포트 9333」도 같이 문다. ⚠️ 여전히 ***전이 호출은 못 잡는다***
    //    (loop/prepare-edition.test.ts 는 자식으로 check-clone.ts 를 spawn 한다) — 알려진 한계다.
    cmd: ['rg', '-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'],
    cwd: deps.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = result.stdout ? new TextDecoder().decode(result.stdout) : '';
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts'))
    .sort();
}

export async function runDeterministicTests(deps: DeterministicRunnerDeps = {}): Promise<number> {
  const makeTemp = deps.mkdtempSync ?? mkdtempSync;
  const tempBase = deps.tmpdir ?? tmpdir;
  const report = deps.report ?? console.error;
  const spawn = deps.spawn ?? defaultSpawn;
  const argv = deps.argv ?? process.argv.slice(2);
  const cwd = deps.cwd ?? process.cwd();
  const config = deps.gitConfig ?? gitConfig;
  const commonDir = config(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir === undefined) throw new Error('git common directory is unset');
  const configFile = join(resolve(cwd, commonDir), 'config');
  const configArgs = ['config', '--file', configFile];
  const watchedKeys = ['core.bare', 'user.name', 'user.email'] as const;
  // Legacy injected gitConfig fixtures supply newline-delimited results and
  // return '' for an absent key. Real Git uses NUL-delimited complete values.
  const readConfig = (key: string): string[] => {
    const value = config(cwd, [...configArgs, '--null', '--get-all', key]);
    if (value === undefined || (deps.gitConfig && value === '')) return [];
    if (deps.gitConfig && !value.includes('\0')) return value.split('\n');
    if (!value.endsWith('\0')) throw new Error(`unterminated git config value for ${key}`);
    return value.slice(0, -1).split('\0');
  };
  const before = new Map(watchedKeys.map((key) => [key, readConfig(key)]));
  let configChanged = false;
  let configChecked = false;
  const checkConfig = (): void => {
    configChecked = true;
    const visible = (values: string[]) => values.length === 0 ? '<unset>' : values.map((value) => value === '' ? '<empty>' : value.replaceAll('\n', ',')).join(',');
    for (const key of watchedKeys) {
      const original = before.get(key)!;
      let after: string[] = ['<unreadable>'];
      try {
        after = readConfig(key);
        if (JSON.stringify(after) === JSON.stringify(original)) continue;
        configChanged = true;
        if (original.length > 0) {
          config(cwd, [...configArgs, '--replace-all', key, original[0]!]);
          for (const value of original.slice(1)) config(cwd, [...configArgs, '--add', key, value]);
        } else {
          config(cwd, [...configArgs, '--unset-all', key]);
        }
        const restored = readConfig(key);
        if (JSON.stringify(restored) !== JSON.stringify(original)) throw new Error(`expected ${visible(original)}, got ${visible(restored)}`);
        report(`[test-deterministic] ${key} changed ${visible(original)} -> ${visible(after)}; restored ${visible(original)}; failing run`);
      } catch (error) {
        configChanged = true;
        report(`[test-deterministic] ${key} changed ${visible(original)} -> ${visible(after)}; restore failed: ${formatError(error)}`);
      }
    }
  };
  // ⛔ 사람이 «경로»를 직접 준 창에서는 아무것도 빼지 않는다 — 그 창은 「이것만 돌려라」다.
  const explicitPaths = argv.some((arg) => !arg.startsWith('-'));
  const cdpPatterns = explicitPaths ? [] : (deps.deriveCdpPatterns ?? deriveCdpTestPatterns)();
  const ignoreArgs = cdpPatterns.flatMap((pattern) => ['--path-ignore-patterns', pattern]);
  if (cdpPatterns.length > 0) {
    report(`[test-deterministic] CDP 시험 ${cdpPatterns.length}개 파일을 뺐다 — bun run test:cdp 로 돈다 (파생: requireCdpBase 직접 import ⊕ 포트 9333 직접 사용).`);
  }

  let testRoot: string | undefined;
  let child: DirectChild | undefined;
  let gate: ShutdownSignalGate | undefined;
  let rootCleanupAttempted = false;

  const cleanupRoot = (): void => {
    if (!testRoot || rootCleanupAttempted) return;
    rootCleanupAttempted = true;
    cleanupTemporaryRoot(testRoot, { rmSync: deps.rmSync, report });
  };

  try {
    testRoot = makeTemp(join(tempBase(), TEMP_ROOT_PREFIX));
    const env = prepareIsolatedTestEnv(deps.env ?? process.env, testRoot);
    gate = deps.waitForSignal
      ? undefined
      : installShutdownSignalGate(deps.signalTarget ?? process, deps.onAbsorbSignal);
    const signalPromise = deps.waitForSignal ? deps.waitForSignal() : gate!.received;

    child = spawn({
      cmd: ['bun', 'test', ...ignoreArgs, ...argv],
      cwd: deps.cwd ?? process.cwd(),
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: true,
    });

    const childExit = child.exited.then(
      (code) => ({ kind: 'exit' as const, code }),
      (error) => ({ kind: 'error' as const, error }),
    );
    const outcome = await Promise.race([
      childExit,
      signalPromise.then((signal) => ({ kind: 'signal' as const, signal })),
    ]);

    if (outcome.kind === 'error') {
      throw outcome.error;
    }

    if (outcome.kind === 'signal') {
      await terminateDirectChild(child, outcome.signal, {
        graceMs: deps.childGraceMs,
        report,
        killProcessGroup: deps.killProcessGroup,
        getProcessGroupId: deps.getProcessGroupId,
      });
      cleanupTemporaryRoot(testRoot, { rmSync: deps.rmSync, report });
      rootCleanupAttempted = true;
      checkConfig();
      gate?.dispose();
      gate = undefined;
      if (deps.killSelf) {
        deps.killSelf(outcome.signal);
        return 1;
      }
      if (!deps.waitForSignal) {
        resignalSelf(outcome.signal, report);
        await new Promise<never>(() => {});
      }
      return 1;
    }

    cleanupRoot();
    checkConfig();
    return configChanged ? 1 : (outcome.code ?? 1);
  } catch (error) {
    if (child) {
      try {
        await terminateDirectChild(child, 'SIGTERM', {
          graceMs: deps.childGraceMs,
          report,
          killProcessGroup: deps.killProcessGroup,
          getProcessGroupId: deps.getProcessGroupId,
        });
      } catch (terminateError) {
        reportVisible(`failed to terminate child after runner error: ${formatError(terminateError)}`, report);
      }
    }
    reportVisible(`deterministic runner failed: ${formatError(error)}`, report);
    throw error;
  } finally {
    gate?.dispose();
    cleanupRoot();
    if (!configChecked) checkConfig();
  }
}

if (import.meta.main) {
  process.exit(await runDeterministicTests());
}
