import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { spawnElanous } from '../instance/spawn-elanous.js';
import { DEFAULT_TUI_TEST_READY_TIMEOUT_MS } from '../self-implement/elanous-tui-spawn.js';

export interface TuiTestRunResult {
  readonly worktree: string;
  readonly ptyId: string;
  readonly runId: string;
  readonly nexusUrl: string;
  readonly nexusPid: number;
  readonly snapshotPath: string;
  readonly readyTimeoutMs: number;
  readonly waitedMs: number;
  readonly pwaBuild: 'built' | 'reused' | 'skipped';
}

export interface TuiTestDeps {
  readonly repoRoot?: string;
  readonly now?: () => Date;
  readonly run?: (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number) => { status: number | null; stdout: string; stderr: string; error?: Error };
  readonly fetch?: typeof fetch;
  readonly spawn?: typeof spawnElanous;
  readonly killProcessGroup?: (pid: number) => void;
}

const runSync = (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = 5 * 60_000) => {
  const result = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
};

export function pwaBuildRequired(pwaDir: string): boolean {
  return !existsSync(join(pwaDir, 'out', 'index.html'));
}

export function pwaBuildDecision(pwaDir: string, withPwaBuild = false): 'build' | 'reuse' | 'skip' {
  if (!pwaBuildRequired(pwaDir)) return 'reuse';
  return withPwaBuild ? 'build' : 'skip';
}

export function buildHeldTuiArgs(entry: string, testStateDir: string, readyTimeoutMs: number, cwd: string): string[] {
  // `--isolated-root` is the dev child boundary. A global `--test` also
  // assigns the launcher process that same root, which makes the child reject
  // it as overlapping caller state before the held PTY can start.
  return [entry, 'dev', '--elanous', '--hold', '--json', '--isolated-root', testStateDir, '--ready-timeout-ms', String(readyTimeoutMs), '--cwd', cwd];
}

export function buildHeldTuiLaunch(entry: string, testStateDir: string, readyTimeoutMs: number, cwd: string): { args: string[]; stateDir: string } {
  // spawnElanous stamps its own caller state root into ELANOUS_STATE_DIR.
  // Keep that launcher stamp separate from --isolated-root; using the same
  // path makes the isolated-root guard reject its own child before PTY startup.
  return {
    args: buildHeldTuiArgs(entry, testStateDir, readyTimeoutMs, cwd).slice(1),
    stateDir: join(cwd, '.elanous-test-launcher'),
  };
}

export function parseReadyHeldPty(output: string): { id: string; runId: string } | undefined {
  const rows = JSON.parse(output) as Array<{ id: string; runId?: string; alive: boolean }>;
  const row = rows.find((item) => item.alive && !!item.runId);
  return row?.runId ? { id: row.id, runId: row.runId } : undefined;
}

export function buildHeldTuiRegistryArgs(entry: string, testStateDir: string): string[] {
  // The held child is registered in the isolated TUI test universe. Keep both
  // config and test state pointed at that root for list and control commands.
  return [entry, '--config-dir', testStateDir, '--test-state-dir', testStateDir, 'pty', 'list', '--json'];
}

export function buildHeldTuiQuitArgs(entry: string, testStateDir: string, ptyId: string): string[] {
  return [entry, '--config-dir', testStateDir, '--test-state-dir', testStateDir, 'pty', 'text', ptyId, '/quit', '--enter'];
}

function timeoutWithinDeadline(deadline: number, stage: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`shared readiness deadline elapsed before ${stage}`);
  return Math.min(30_000, remaining);
}

function assertTestUniverseOnboardingReady(stateDir: string): void {
  const config = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')) as { onboarding?: { ready?: unknown } };
  if (config.onboarding?.ready !== true) {
    throw new Error(`isolated TUI test config lost onboarding.ready=true: ${join(stateDir, 'config.json')}`);
  }
}

export function assertTestUniverseConfigMatches(stateDir: string, expectedConfig: string): void {
  const configPath = join(stateDir, 'config.json');
  const actualConfig = readFileSync(configPath, 'utf8');
  if (actualConfig !== expectedConfig) {
    let changedKeys = 'unknown';
    try {
      const expected = JSON.parse(expectedConfig) as Record<string, unknown>;
      const actual = JSON.parse(actualConfig) as Record<string, unknown>;
      changedKeys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
        .filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
        .sort().join(', ') || 'format/ordering only';
    } catch { /* report the path without exposing config contents */ }
    throw new Error(`isolated TUI test config changed while the held TUI was starting (keys: ${changedKeys}): ${configPath}`);
  }
}

function prepareTestUniverseConfig(stateDir: string): void {
  const configPath = join(stateDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    global?: Record<string, unknown>;
    onboarding?: Record<string, unknown>;
  };
  const global = config.global ?? {};
  const nexus = (global.nexus && typeof global.nexus === 'object' ? global.nexus : {}) as Record<string, unknown>;
  const pwa = (nexus.pwa && typeof nexus.pwa === 'object' ? nexus.pwa : {}) as Record<string, unknown>;
  config.global = { ...global, nexus: { ...nexus, pwa: { ...pwa, shareTailnet: 'disabled' } } };
  config.onboarding = { ...config.onboarding, ready: true };
  const tempPath = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tempPath, configPath);
}

async function waitForTestUniverseConfigStable(stateDir: string, deadline: number): Promise<void> {
  const configPath = join(stateDir, 'config.json');
  let previous = readFileSync(configPath, 'utf8');
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const current = readFileSync(configPath, 'utf8');
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1_000) {
      return;
    }
  }
  throw new Error('isolated TUI test config did not remain stable after Nexus readiness');
}

function checkedRun(deps: TuiTestDeps, command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number): string {
  const result = (deps.run ?? runSync)(command, args, cwd, env, timeoutMs);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (status=${result.status}): ${(result.stderr || result.stdout || result.error?.message || 'no diagnostic').trim()}`);
  return result.stdout;
}

async function waitForNexus(logPath: string, child: ChildProcess, deadline: number, fetcher: typeof fetch): Promise<string> {
  let last = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated Nexus exited before readiness (status=${child.exitCode}): ${readFileSync(logPath, 'utf8').slice(-1200)}`);
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const port = /(?:http:\/\/(?:0\.0\.0\.0|127\.0\.0\.1):|시험 대역에서 :)([0-9]+)(?: 임대)?/u.exec(log)?.[1];
    if (port) {
      try {
        const response = await fetcher(`http://127.0.0.1:${port}/v1/terminals`, { signal: AbortSignal.timeout(2_000) });
        if (response.status < 500) return `http://127.0.0.1:${port}`;
        last = `HTTP ${response.status}`;
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
    } else if (log) last = log.slice(-500);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`isolated Nexus did not answer before the shared readiness deadline (${last})`);
}

function launchHeldTui(entry: string, cwd: string, env: NodeJS.ProcessEnv, launch: { args: string[]; stateDir: string }, logStateDir: string, spawn: typeof spawnElanous): ChildProcess {
  const logPath = join(logStateDir, 'tui-test-held.log');
  const logFd = openSync(logPath, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(launch.args, {
      bin: entry,
      stateDir: launch.stateDir,
      cwd, env, detached: true, stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  child.once('error', () => {});
  return child;
}

async function waitForHeldTui(entry: string, cwd: string, env: NodeJS.ProcessEnv, logStateDir: string, registryStateDir: string, child: ChildProcess, deadline: number, deps: TuiTestDeps): Promise<{ id: string; runId: string }> {
  const logPath = join(logStateDir, 'tui-test-held.log');
  const startedAt = Date.now();
  let last = 'PTY registry has no row yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const output = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      if (child.exitCode !== 0 || !/"held"\s*:\s*true/u.test(output)) {
        throw new Error(`held TUI launcher exited before its PTY was registered (status=${child.exitCode}): ${output.slice(-1200)}`);
      }
    }
    try {
      const output = checkedRun(deps, 'bun', buildHeldTuiRegistryArgs(entry, registryStateDir), cwd, env, Math.min(15_000, Math.max(1, deadline - Date.now())));
      const held = parseReadyHeldPty(output);
      if (held) return held;
      last = 'PTY registry returned no alive held TUI';
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process may already have exited */ }
  }
  const output = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  throw new Error(`held TUI did not register an alive PTY before the shared deadline (waitedMs=${Date.now() - startedAt}; ${last}): ${output.slice(-1200)}`);
}

export async function runTuiTestUniverse(options: { readyTimeoutMs?: number; withPwaBuild?: boolean } = {}, deps: TuiTestDeps = {}): Promise<TuiTestRunResult> {
  const repoRoot = resolve(deps.repoRoot ?? process.cwd());
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_TUI_TEST_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) throw new Error('--ready-timeout-ms must be a positive integer');
  const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[-:.]/gu, '').replace('T', '-').replace('Z', 'Z');
  const branch = `codex/tui-test-${stamp}`;
  const worktreeBase = join(getElanousConfigDir(), 'worktrees', 'tui-test');
  const worktree = join(worktreeBase, stamp);
  mkdirSync(worktreeBase, { recursive: true });

  checkedRun(deps, 'git', ['fetch', 'origin', 'main'], repoRoot, undefined, 60_000);
  checkedRun(deps, 'git', ['worktree', 'add', '-b', branch, worktree, 'origin/main'], repoRoot, undefined, 5 * 60_000);
  const { linkWorktreeDependencies } = await import('../git-fs/worktree.js');
  linkWorktreeDependencies(repoRoot, worktree, ['node_modules']);

  const pwaDir = join(worktree, 'apps/pwa');
  const pwaDecision = pwaBuildDecision(pwaDir, options.withPwaBuild);
  let pwaBuild: TuiTestRunResult['pwaBuild'] = pwaDecision === 'reuse' ? 'reused' : 'skipped';
  if (pwaDecision === 'build') {
    checkedRun(deps, 'bun', ['install', '--frozen-lockfile'], pwaDir, undefined, 5 * 60_000);
    checkedRun(deps, 'bun', ['run', 'build'], pwaDir, undefined, 10 * 60_000);
    pwaBuild = 'built';
  }

  // The current CLI owns the detached launcher lifetime; Nexus and the TUI
  // itself run the generated latest-main entry.
  const launcherEntry = join(repoRoot, 'bin/elanous.mjs');
  const targetEntry = join(worktree, 'bin/elanous.mjs');
  const setupEntry = launcherEntry;
  const testStateDir = join(worktree, '.elanous-test');
  const testEnv = { ...process.env };
  delete testEnv.ELANOUS_STATE_DIR;
  delete testEnv.ELANOUS_CONFIG_DIR;
  delete testEnv.ELANOUS_NEXUS_HEADLESS;
  // Bun's test-runner control markers must not leak into the detached CLI / PTY
  // children; otherwise nested `bun pty list` can join or wait on the test worker.
  for (const key of Object.keys(testEnv)) {
    if (key.startsWith('BUN_TEST')) delete testEnv[key];
  }
  // Sync with this command's implementation: the generated latest-main tree
  // may not yet contain the empty-config bootstrap this one-command flow needs.
  checkedRun(deps, 'bun', [setupEntry, 'config', 'sync-test', '--state-dir', testStateDir, '--json'], worktree, testEnv, 30_000);
  // This disposable universe has no copied user onboarding state. Mark it
  // ready so first-run web setup cannot return from the held child before its
  // PTY remains available to the caller.
  prepareTestUniverseConfig(testStateDir);
  assertTestUniverseOnboardingReady(testStateDir);
  mkdirSync(testStateDir, { recursive: true });
  const nexusLogPath = join(testStateDir, 'tui-test-nexus.log');
  const nexusLogFd = openSync(nexusLogPath, 'a');
  const nexusEntry = targetEntry;
  const nexusEnv = { ...testEnv, ELANOUS_CONFIG_DIR: testStateDir, ELANOUS_TOOL_CWD: worktree };
  const nexusProcess = (deps.spawn ?? spawnElanous)(['--test-state-dir', testStateDir, 'nexus', 'run', '--no-auto-build', '--no-watch', '--no-mcp', '--no-auth', '--http-host', '127.0.0.1', '--tool-cwd', worktree], {
    bin: nexusEntry,
    stateDir: testStateDir,
    cwd: worktree, env: nexusEnv, detached: true, stdio: ['ignore', nexusLogFd, nexusLogFd],
  });
  closeSync(nexusLogFd);
  nexusProcess.unref();
  const readinessDeadline = Date.now() + readyTimeoutMs;
  const launcherStateDir = join(worktree, '.elanous-test-launcher');
  let launcher: ChildProcess | undefined;
  try {
    const nexusUrl = await waitForNexus(nexusLogPath, nexusProcess, readinessDeadline, deps.fetch ?? fetch);
    // Nexus may materialize config defaults while it starts. Restore the
    // disposable test-only onboarding bit after Nexus is ready, before the TUI
    // child reads its isolated config.
    prepareTestUniverseConfig(testStateDir);
    await waitForTestUniverseConfigStable(testStateDir, readinessDeadline);
    assertTestUniverseOnboardingReady(testStateDir);
    const ptyReadyStartedAt = Date.now();
    const launch = buildHeldTuiLaunch(launcherEntry, testStateDir, Math.max(1, readinessDeadline - Date.now()), worktree);
    const launcherEnv = { ...testEnv, ELANOUS_HOLD_TUI_REPO_ROOT: worktree };
    launcher = launchHeldTui(launcherEntry, worktree, launcherEnv, launch, testStateDir, deps.spawn ?? spawnElanous);
    const held = await waitForHeldTui(targetEntry, worktree, testEnv, testStateDir, testStateDir, launcher, readinessDeadline, deps);
    // The generated TUI materializes defaults on first startup. Wait for that
    // real child writer to finish before pinning the config used by this run.
    // This makes startup normalization part of the serialized setup phase;
    // subsequent writes through snapshot are treated as a race and fail closed.
    await waitForTestUniverseConfigStable(testStateDir, readinessDeadline);
    assertTestUniverseOnboardingReady(testStateDir);
    const stableConfig = readFileSync(join(testStateDir, 'config.json'), 'utf8');
    assertTestUniverseConfigMatches(testStateDir, stableConfig);
    const ptyId = held.id;

    const registryArgs = buildHeldTuiRegistryArgs(targetEntry, testStateDir).slice(1);
    const ptyListTimeout = timeoutWithinDeadline(readinessDeadline, 'final PTY registry verification');
    const ptyList = JSON.parse(checkedRun(deps, 'bun', [targetEntry, ...registryArgs], worktree, testEnv, ptyListTimeout)) as Array<{ id: string; runId?: string; alive: boolean }>;
    const row = ptyList.find((item) => item.id === ptyId && item.alive);
    if (row?.runId !== held.runId) throw new Error(`held PTY ${ptyId} is absent or has a different runId in the same test universe`);
    const snapshotTimeout = timeoutWithinDeadline(readinessDeadline, 'PTY snapshot');
    const snapshot = checkedRun(deps, 'bun', [targetEntry, ...registryArgs.slice(0, 4), 'pty', 'snapshot', ptyId], worktree, testEnv, snapshotTimeout);
    const evidenceDir = join(testStateDir, 'evidence');
    const snapshotPath = join(evidenceDir, 'tui-test-snapshot.txt');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(snapshotPath, snapshot, 'utf8');
    assertTestUniverseConfigMatches(testStateDir, stableConfig);
    timeoutWithinDeadline(readinessDeadline, 'one-command result');
    return { worktree, ptyId, runId: row.runId, nexusUrl, nexusPid: nexusProcess.pid ?? -1, snapshotPath, readyTimeoutMs, waitedMs: Date.now() - ptyReadyStartedAt, pwaBuild };
  } catch (error) {
    if (launcher?.pid !== undefined) {
      try { (deps.killProcessGroup ?? ((pid) => process.kill(-pid, 'SIGTERM')))(launcher.pid); } catch { /* launcher group may already have exited */ }
    }
    try {
      const ptyRows = JSON.parse(checkedRun(deps, 'bun', buildHeldTuiRegistryArgs(targetEntry, testStateDir), worktree, testEnv, 10_000)) as Array<{ id?: string; alive?: boolean }>;
      for (const row of ptyRows) {
        if (row.alive && row.id) {
          try { checkedRun(deps, 'bun', buildHeldTuiQuitArgs(targetEntry, testStateDir, row.id), worktree, testEnv, 10_000); } catch { /* preserve the primary failure */ }
        }
      }
    } catch { /* preserve the primary failure when the dedicated registry is unavailable */ }
    try { checkedRun(deps, 'bun', [targetEntry, '--test-state-dir', testStateDir, 'nexus', 'stop'], worktree, testEnv, 15_000); } catch { /* preserve the primary readiness failure */ }
    throw error;
  }
}
