import { spawn } from 'node:child_process';
import { closeSync, existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLEANUP_POLL_MS = 1_000;
const CLEANUP_DIR_ENV = 'ELANOUS_TASK_LAUNCH_CLEANUP_DIR';
const LAUNCHER_PID_ENV = 'ELANOUS_TASK_LAUNCH_PARENT_PID';

function scheduleScratchCleanup(directory: string, launcherPid: number): void {
  try {
    const cleanup = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cleanup'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [CLEANUP_DIR_ENV]: directory, [LAUNCHER_PID_ENV]: String(launcherPid) },
    });
    cleanup.unref();
  } catch { /* the host tmp-gc policy is the last-resort cleanup */ }
}

function cleanupMode(): void {
  const directory = process.env[CLEANUP_DIR_ENV];
  const launcherPid = Number(process.env[LAUNCHER_PID_ENV]);
  if (!directory || !basename(directory).startsWith('tasks-cli-launch-') || !Number.isInteger(launcherPid) || launcherPid <= 0) {
    process.exitCode = 2;
    return;
  }
  // Never trade diagnostic retention for a timer; the host tmp-gc policy reclaims a stale path if a PID is reused.
  const cleanupWhenSafe = () => {
    if (!existsSync(directory)) return;
    let launcherAlive = true;
    try { process.kill(launcherPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') launcherAlive = false; }
    const parentFinished = existsSync(join(directory, '.launcher-finished'));
    if (parentFinished || !launcherAlive) {
      try { rmSync(resolve(directory), { recursive: true, force: true }); }
      catch { /* host tmp-gc remains the last-resort cleanup */ }
      return;
    }
    setTimeout(cleanupWhenSafe, CLEANUP_POLL_MS);
  };
  cleanupWhenSafe();
}

function supervise(args: string[]): void {
  const [scratchDirectory, launcherPidText, command, ...commandArgs] = args;
  const launcherPid = Number(launcherPidText);
  if (!scratchDirectory || !command || !basename(scratchDirectory).startsWith('tasks-cli-launch-') || !Number.isInteger(launcherPid) || launcherPid <= 0) {
    process.exitCode = 2;
    return;
  }
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    scheduleScratchCleanup(scratchDirectory, launcherPid);
    try { closeSync(2); } catch { /* stderr may already be closed */ }
    process.exitCode = code;
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, commandArgs, { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    finish(127);
    return;
  }
  child.once('error', () => finish(127));
  child.once('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
}

export function isTaskLaunchSupervisorEntrypoint(argv: string[] = process.argv): boolean {
  return Boolean(argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url));
}

if (isTaskLaunchSupervisorEntrypoint()) {
  const args = process.argv.slice(2);
  if (args[0] === '--cleanup') cleanupMode();
  else supervise(args);
}
