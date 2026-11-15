#!/usr/bin/env bun
/** A158: exercise the installed package, never a checkout or the operator's Nexus. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface NexusFirstRunReceipt {
  ok: boolean;
  versionLine: string;
  pid?: number;
  health: number;
  healthOk: boolean;
  app: number;
  testUniverse: boolean;
  ownPidStopped: boolean;
  forcedKill: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  error?: string;
}

/** Used at both graph boundaries, including reuse of a previously prepared archive. */
export function isNexusFirstRunPass(value: unknown): value is NexusFirstRunReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<NexusFirstRunReceipt>;
  return receipt.ok === true && !receipt.error && typeof receipt.versionLine === 'string'
    && /^\S+ [a-f0-9]{40}$/i.test(receipt.versionLine) && receipt.health === 200 && receipt.healthOk === true
    && receipt.app === 200 && receipt.testUniverse === true && receipt.ownPidStopped === true
    && receipt.forcedKill === false && receipt.exitCode === 0
    && Number.isSafeInteger(receipt.pid) && receipt.pid! > 0;
}

/** Deliberately an allowlist: no production config, credentials, NODE_OPTIONS or auth bypass. */
export function firstRunEnvironment(home: string, path = process.env.PATH ?? ''): NodeJS.ProcessEnv {
  return { PATH: `${dirname(process.execPath)}:${path}`, HOME: home, SHELL: '/bin/sh',
    TMPDIR: home, LANG: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1', NODE_ENV: 'production' };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('first-run port unavailable');
  const port = address.port;
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

const delay = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms));
async function waitForExit(exit: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([exit, new Promise<void>(accept => { timer = setTimeout(accept, ms); })]); }
  finally { clearTimeout(timer!); }
}
function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Real process/HTTP boundary; tests use a tiny installed-CLI fixture, never a live account. */
export async function verifyNexusFirstRun(binary: string, expectedVersion?: string, expectedCommit?: string,
  timing: { bootMs?: number; stopMs?: number } = {}): Promise<NexusFirstRunReceipt> {
  // macOS /var and /tmp aliases must not trip Nexus's canonical-private-directory guard.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-nexus-first-run-')));
  const home = join(root, 'home');
  const state = join(root, 'test-state');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace);
  const env = firstRunEnvironment(home);
  const receipt: NexusFirstRunReceipt = { ok: false, versionLine: '', health: 0, healthOk: false, app: 0,
    testUniverse: false, ownPidStopped: false, forcedKill: false };
  let child: ReturnType<typeof spawn> | undefined;
  let exited = false;
  let exitPromise: Promise<void> | undefined;
  try {
    const version = spawnSync(resolve(binary), ['--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 15_000 });
    receipt.versionLine = (version.stdout ?? '').trim();
    const match = /^(\S+) ([a-f0-9]{40})$/i.exec(receipt.versionLine);
    if (version.status !== 0 || !match || expectedVersion && match[1] !== expectedVersion
      || expectedCommit && match[2] !== expectedCommit) throw new Error('installed version/full commit mismatch');
    const port = await freePort();
    // Global --test=<dir> BEFORE the command selects the inline, owned child lifecycle.
    // `nexus run --test` instead forks through pwa-test and cannot prove this PID owns it.
    child = spawn(resolve(binary), [`--test=${state}`, 'nexus', 'run', '--headless', '--http-host', '127.0.0.1',
      '--port', String(port), '--no-auto-build', '--no-auto-install', '--no-auto-restart', '--no-watch', '--no-mcp',
      '--tool-cwd', workspace], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain output without logging generated bearer tokens or unbounded startup output.
    child.stdout?.resume(); child.stderr?.resume();
    exitPromise = new Promise<void>(accept => {
      child!.once('exit', () => { exited = true; accept(); });
      child!.once('error', () => { exited = true; accept(); });
    });
    if (!child.pid) throw new Error('first-run Nexus spawn failed');
    receipt.pid = child.pid;
    const deadline = Date.now() + (timing.bootMs ?? 60_000);
    while (Date.now() < deadline && !exited) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1_000), redirect: 'error' });
        receipt.health = health.status;
        const body = await health.json() as { ok?: unknown; testUniverse?: unknown; universeRoot?: unknown };
        receipt.healthOk = body.ok === true;
        receipt.testUniverse = body.testUniverse === true && body.universeRoot === join(state, 'nexus');
        if (health.status === 200 && body.ok === true && receipt.testUniverse) break;
      } catch { /* Startup may not have bound yet; the absolute deadline never resets. */ }
      await delay(100);
    }
    if (exited || receipt.health !== 200 || !receipt.healthOk || !receipt.testUniverse)
      throw new Error('nexus first-run health failed (200/ok:true/exact test root required)');
    const app = await fetch(`http://127.0.0.1:${port}/app/`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    receipt.app = app.status;
    await app.body?.cancel();
    if (app.status !== 200 || exited) throw new Error('nexus first-run app failed (200 required)');
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : 'nexus first-run failed';
  } finally {
    if (child?.pid && exitPromise) {
      const requestedStop = !exited;
      if (requestedStop) child.kill('SIGINT');
      await waitForExit(exitPromise, timing.stopMs ?? 12_000);
      if (!exited) {
        receipt.forcedKill = true;
        child.kill('SIGKILL');
        await waitForExit(exitPromise, 2_000);
      }
      receipt.ownPidStopped = exited && !pidExists(child.pid);
      receipt.exitCode = child.exitCode;
      receipt.exitSignal = child.signalCode;
      if (!requestedStop || receipt.exitCode !== 0)
        receipt.error ??= 'nexus exited unexpectedly or own-PID shutdown failed';
      if (!receipt.ownPidStopped || receipt.forcedKill) receipt.error ??= 'nexus own PID did not stop cleanly';
    }
    if (!child?.pid || receipt.ownPidStopped) rmSync(root, { recursive: true, force: true });
  }
  receipt.ok = !receipt.error && receipt.health === 200 && receipt.healthOk && receipt.app === 200
    && receipt.testUniverse && receipt.ownPidStopped && !receipt.forcedKill;
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const binary = value('--binary');
  if (!binary) throw new Error('--binary is required');
  const result = await verifyNexusFirstRun(binary, value('--expected-version'), value('--expected-commit'));
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
