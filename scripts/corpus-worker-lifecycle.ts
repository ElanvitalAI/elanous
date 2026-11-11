import { debug } from '../src/debug/log.js';
import { killCorpusProcessGroup } from './corpus-process-group.js';

const CATEGORY = 'goal-grounding.corpus';
const DEFAULT_ORPHAN_CHECK_MS = 100;

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Workers must not outlive their corpus runner. The runner grants a cap slightly
 * above its 120s call timeout: normal calls take 57–94s, so 10s preserves the
 * parent-side timeout as the primary hang detector while bounding an orphan.
 */
/** End the detached worker's whole process group, including LLM-wrapper grandchildren.
 * On POSIX `kill(-pid)` targets the group created by the runner's `detached:true`.
 * A non-detached direct fixture has no private group, so it falls back to this worker
 * only rather than risking its test runner's process group. */
function terminateOwnGroup(reason: 'orphan-detected' | 'lifetime-expired', data: Record<string, unknown>): void {
  debug.log(CATEGORY, reason, data);
  killCorpusProcessGroup(process.pid);
  process.exit(1);
}

export function installCorpusWorkerLiveness(): void {
  const parentPid = Number(process.env.CORPUS_WORKER_PARENT_PID);
  const maxLifetimeMs = Number(process.env.CORPUS_WORKER_MAX_LIFETIME_MS);
  const orphanCheckMs = Number(process.env.CORPUS_WORKER_ORPHAN_CHECK_MS ?? DEFAULT_ORPHAN_CHECK_MS);
  const exitFor = (event: 'orphan-detected' | 'lifetime-expired', data: Record<string, unknown>): void => terminateOwnGroup(event, data);

  if (Number.isInteger(parentPid) && parentPid > 1) {
    const watcher = setInterval(() => {
      if (!isLiveProcess(parentPid)) exitFor('orphan-detected', { pid: process.pid, parentPid });
    }, Number.isFinite(orphanCheckMs) && orphanCheckMs > 0 ? orphanCheckMs : DEFAULT_ORPHAN_CHECK_MS);
    watcher.unref();
  }

  if (Number.isFinite(maxLifetimeMs) && maxLifetimeMs > 0) {
    // Normal calls take 57–94s and parent timeout is 120s; the runner grants 10s
    // teardown grace, then this cap bounds an orphan even if its parent was SIGKILLed.
    const deadline = setTimeout(() => exitFor('lifetime-expired', { pid: process.pid, maxLifetimeMs }), maxLifetimeMs);
    deadline.unref();
  }
}
