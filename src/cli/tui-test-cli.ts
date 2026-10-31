import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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

export function buildHeldTuiArgs(entry: string, tuiStateDir: string, readyTimeoutMs: number, cwd: string): string[] {
  return [entry, '--test', 'dev', '--elanous', '--hold', '--json', '--isolated-root', tuiStateDir, '--ready-timeout-ms', String(readyTimeoutMs), '--cwd', cwd];
}

export function parseReadyHeldPty(output: string): { id: string; runId: string } | undefined {
  const rows = JSON.parse(output) as Array<{ id: string; runId?: string; alive: boolean }>;
  const row = rows.find((item) => item.alive && !!item.runId);
  return row?.runId ? { id: row.id, runId: row.runId } : undefined;
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

function launchHeldTui(entry: string, cwd: string, env: NodeJS.ProcessEnv, stateDir: string, deadline: number): ChildProcess {
  const logPath = join(stateDir, 'tui-test-held.log');
  const logFd = openSync(logPath, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawnElanous(buildHeldTuiArgs(entry, join(stateDir, '..', '.elanous-test-tui'), Math.max(1, deadline - Date.now()), cwd).slice(1), {
      bin: entry,
      stateDir: join(stateDir, '..', '.elanous-test-tui'),
      cwd, env, detached: true, stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  child.once('error', () => {});
  return child;
}

async function waitForHeldTui(entry: string, cwd: string, env: NodeJS.ProcessEnv, stateDir: string, child: ChildProcess, deadline: number, deps: TuiTestDeps): Promise<{ id: string; runId: string }> {
  const logPath = join(stateDir, 'tui-test-held.log');
  const startedAt = Date.now();
  let last = 'PTY registry has no row yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const output = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      throw new Error(`held TUI launcher exited before its PTY was registered (status=${child.exitCode}): ${output.slice(-1200)}`);
    }
    try {
      const output = checkedRun(deps, 'bun', [entry, '--test-state-dir', stateDir, 'pty', 'list', '--json'], cwd, env, Math.min(15_000, Math.max(1, deadline - Date.now())));
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

  const entry = join(worktree, 'bin/elanous.mjs');
  const testStateDir = join(worktree, '.elanous-test');
  const tuiStateDir = join(worktree, '.elanous-test-tui');
  const testEnv = { ...process.env };
  delete testEnv.ELANOUS_STATE_DIR;
  delete testEnv.ELANOUS_CONFIG_DIR;
  delete testEnv.ELANOUS_NEXUS_HEADLESS;
  checkedRun(deps, 'bun', [entry, 'config', 'sync-test', '--state-dir', testStateDir, '--json'], worktree, testEnv, 30_000);
  checkedRun(deps, 'bun', [entry, '--config-dir', testStateDir, 'config', 'set', 'global.nexus.pwa.shareTailnet', 'disabled', '--no-backup'], worktree, testEnv, 30_000);
  mkdirSync(testStateDir, { recursive: true });
  const nexusLogPath = join(testStateDir, 'tui-test-nexus.log');
  const nexusLogFd = openSync(nexusLogPath, 'a');
  const nexusEntry = join(repoRoot, 'bin/elanous.mjs');
  const nexusEnv = { ...testEnv, ELANOUS_CONFIG_DIR: testStateDir, ELANOUS_TOOL_CWD: worktree };
  const nexusProcess = spawnElanous(['--test-state-dir', testStateDir, 'nexus', 'run', '--no-auto-build', '--no-watch', '--no-mcp', '--no-auth', '--http-host', '127.0.0.1', '--tool-cwd', worktree], {
    bin: nexusEntry,
    stateDir: testStateDir,
    cwd: worktree, env: nexusEnv, detached: true, stdio: ['ignore', nexusLogFd, nexusLogFd],
  });
  closeSync(nexusLogFd);
  nexusProcess.unref();
  const readinessDeadline = Date.now() + readyTimeoutMs;
  try {
    const nexusUrl = await waitForNexus(nexusLogPath, nexusProcess, readinessDeadline, deps.fetch ?? fetch);
    const ptyReadyStartedAt = Date.now();
    const launcher = launchHeldTui(entry, worktree, testEnv, testStateDir, readinessDeadline);
    const held = await waitForHeldTui(entry, worktree, testEnv, testStateDir, launcher, readinessDeadline, deps);
    const ptyId = held.id;

    const isolatedArgs = ['--test-state-dir', testStateDir];
    const ptyList = JSON.parse(checkedRun(deps, 'bun', [entry, ...isolatedArgs, 'pty', 'list', '--json'], worktree, testEnv, 30_000)) as Array<{ id: string; runId?: string; alive: boolean }>;
    const row = ptyList.find((item) => item.id === ptyId && item.alive);
    if (row?.runId !== held.runId) throw new Error(`held PTY ${ptyId} is absent or has a different runId in the same test universe`);
    const snapshot = checkedRun(deps, 'bun', [entry, ...isolatedArgs, 'pty', 'snapshot', ptyId], worktree, testEnv, 30_000);
    const evidenceDir = join(testStateDir, 'evidence');
    const snapshotPath = join(evidenceDir, 'tui-test-snapshot.txt');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(snapshotPath, snapshot, 'utf8');
    return { worktree, ptyId, runId: row.runId, nexusUrl, nexusPid: nexusProcess.pid ?? -1, snapshotPath, readyTimeoutMs, waitedMs: Date.now() - ptyReadyStartedAt, pwaBuild };
  } catch (error) {
    try { checkedRun(deps, 'bun', [entry, '--test-state-dir', testStateDir, 'nexus', 'stop'], worktree, testEnv, 15_000); } catch { /* preserve the primary readiness failure */ }
    throw error;
  }
}
