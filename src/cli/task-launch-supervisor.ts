import { spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLEANUP_POLL_MS = 1_000;
const CLEANUP_DIR_ENV = 'ELANOUS_TASK_LAUNCH_CLEANUP_DIR';
const LAUNCHER_PID_ENV = 'ELANOUS_TASK_LAUNCH_PARENT_PID';

/** TA-LAUNCH-STDIO-EVIDENCE-RETAIN — the fatal line lives at the tail, so keep the last 16 KiB. */
const RETAINED_STDERR_TAIL_BYTES = 16 * 1024;

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

/**
 * TA-LAUNCH-STDIO-EVIDENCE-RETAIN (0.3.29 P1) — the launcher watches only a short early-exit
 * window (ORCH-LIVE-1008). A child that dies AFTER the window — e.g. `harness say` exit 2 on
 * release-gate pool exclusivity — used to vanish together with the scratch dir: card «launched»,
 * run ledger empty, no cause line anywhere (2026-11-18 run-7c4f3e67 · card ta-20261118-521a0c).
 * The supervisor is the only process still watching that child, so it retains the evidence
 * BEFORE `finish()` schedules the scratch cleanup:
 *   ① a ≤16 KiB stderr tail at `<run-ledger>/launch-failures/<runId>.stderr` (mode 0600);
 *   ② exactly one `event='stop'` line (class `launch-failed`) — the checked append skips when a
 *      stop already exists (the launcher's early-window path won that race), so a run keeps «런마다 한 줄»;
 *   ③ the whole run scratch directory at `<run-ledger>/launch-failures/<runId>/` (Terra must 1 —
 *      abnormal termination must keep the run directory inspectable, not only the stderr tail).
 *      Best-effort: a copy failure still lands ① and ② with the tail as evidenceRef.
 * Fail-soft by design: retention must never mask the child's own exit code.
 */
export async function retainLaunchFailureEvidence(scratchDirectory: string, code: number): Promise<void> {
  if (code === 0) return;
  try {
    const stderrName = readdirSync(scratchDirectory).find((name) => name.endsWith('.stderr'));
    if (!stderrName) return;
    const runId = stderrName.slice(0, -'.stderr'.length);
    const stderrPath = join(scratchDirectory, stderrName);
    const size = statSync(stderrPath).size;
    const start = Math.max(0, size - RETAINED_STDERR_TAIL_BYTES);
    const bytes = Buffer.alloc(size - start);
    if (bytes.length > 0) {
      const fd = openSync(stderrPath, 'r');
      try { readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
    }
    const { runLedgerDir, runLedgerPath, appendRunLedgerEntryChecked } = await import('../self-implement/run-ledger.js');
    const { boundRunStopCause } = await import('../self-implement/run-stop.js');
    runLedgerPath(runId); // canonical run-id contract gate — an invalid id stays fail-soft
    const retainedDir = join(runLedgerDir(), 'launch-failures');
    mkdirSync(retainedDir, { recursive: true, mode: 0o700 });
    const retainedPath = join(retainedDir, `${runId}.stderr`);
    writeFileSync(retainedPath, bytes, { mode: 0o600 });
    // ③ Terra must 1 — keep the run scratch directory itself, not only the tail.
    const retainedRunDir = join(retainedDir, runId);
    let runDirRetained = false;
    try {
      cpSync(scratchDirectory, retainedRunDir, { recursive: true });
      runDirRetained = true;
    } catch { /* best-effort: ① tail + ② stop line still land */ }
    const evidenceRef = `file:${runDirRetained ? retainedRunDir : retainedPath}`;
    const lines = bytes.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const actionable = lines.find((line) => /^(?:❌|error:|fatal:)/i.test(line)) ?? lines[0] ?? '';
    const cause = boundRunStopCause(`child rc=${code}${actionable ? `: ${actionable}` : ''}`);
    appendRunLedgerEntryChecked<'stop-written' | 'stop-exists'>(runId, (entries) =>
      (entries ?? []).some((entry) => entry.event === 'stop')
        ? { append: false, result: 'stop-exists' as const }
        : {
            append: true,
            entry: {
              timestamp: new Date().toISOString(),
              runId,
              event: 'stop',
              data: {
                class: 'launch-failed',
                site: 'launch-failed-supervisor',
                cause,
                evidenceRef,
                nextMove: 'Read the retained run directory (stderr tail beside it), fix the launch argv/config, then re-hand the card',
              },
            },
          });
    // A child may have already written a stop. Keep the single-stop invariant while
    // recording this supervisor observation for the card-binding race.
    appendRunLedgerEntryChecked(runId, (entries) =>
      (entries ?? []).some((entry) => entry.event === 'launch-failed-supervisor')
        ? { append: false, result: false }
        : { append: true, entry: { timestamp: new Date().toISOString(), runId,
            event: 'launch-failed-supervisor', data: { cause } } });
    const cardId = process.env.ELANOUS_TASK_CARD_ID;
    const statePath = process.env.ELANOUS_TASK_STATE_PATH;
    if (cardId && statePath) {
      const { reconcileLateLaunchFailure } = await import('../task-agent/late-launch-failure.js');
      reconcileLateLaunchFailure(statePath, cardId, runId);
    }
  } catch { /* fail-soft: retention never masks the child exit code */ }
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
  // TA-LAUNCH-STDIO-EVIDENCE-RETAIN — retain the evidence BEFORE finish() schedules the scratch cleanup.
  child.once('exit', (code, signal) => {
    const normalized = code ?? (signal ? 1 : 0);
    if (normalized === 0) { finish(0); return; }
    void retainLaunchFailureEvidence(scratchDirectory, normalized).catch(() => {}).then(() => finish(normalized));
  });
}

export function isTaskLaunchSupervisorEntrypoint(argv: string[] = process.argv): boolean {
  return Boolean(argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url));
}

if (isTaskLaunchSupervisorEntrypoint()) {
  const args = process.argv.slice(2);
  if (args[0] === '--cleanup') cleanupMode();
  else supervise(args);
}
