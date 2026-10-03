import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLedgerRoot } from '../../src/instance/resolve.js';
import { checklistGate, type ChecklistGate } from '../../src/release-loop/checklist.js';
import { getSchedule, formatKst } from '../../src/release-loop/release-schedule.js';
import { debug } from '../../src/debug/log.js';

export type ReleaseReadiness =
  | { ready: false; reason: 'already-published'; details: string }
  | { ready: false; reason: 'already-running'; details: string }
  | { ready: false; reason: 'before-cut'; details: string }
  | { ready: false; reason: 'checklist-blocked'; details: ChecklistGate }
  | { ready: true; reason: 'ready'; details: ChecklistGate };

export interface ReleaseReadinessDeps {
  ledgerRoot?: string;
  checklist?: typeof checklistGate;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
}

function readIfPresent(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** Read-only preflight; callers own acquiring and releasing run.lock around the graph. */
export function releaseReadiness(version: string, deps: ReleaseReadinessDeps = {}): ReleaseReadiness {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error(`release version must be x.y.z: ${version}`);
  const dir = join(deps.ledgerRoot ?? releaseLedgerRoot(), 'release', version);
  const record = readIfPresent(join(dir, 'release.json'));
  if (record) {
    const data = JSON.parse(record) as { publishedAt?: unknown };
    if (typeof data.publishedAt === 'string' && data.publishedAt.trim()) {
      return { ready: false, reason: 'already-published', details: data.publishedAt };
    }
  }
  const lock = readIfPresent(join(dir, 'run.lock'));
  if (lock) {
    let pid: unknown;
    try { pid = (JSON.parse(lock) as { pid?: unknown } | null)?.pid; }
    catch { pid = undefined; }
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && (deps.isPidAlive ?? isPidAlive)(pid)) {
      return { ready: false, reason: 'already-running', details: String(pid) };
    }
  }
  const schedule = getSchedule(version, deps.ledgerRoot);
  if (schedule && (deps.now ?? (() => new Date()))().getTime() < Date.parse(schedule.cutAt)) {
    debug.log('release.schedule', 'before-cut', { version, cutAt: schedule.cutAt, landBy: schedule.landBy });
    return { ready: false, reason: 'before-cut', details: `before-cut (${formatKst(schedule.cutAt)})` };
  }
  const gate = (deps.checklist ?? checklistGate)(version);
  if (!gate.ok) return { ready: false, reason: 'checklist-blocked', details: gate };
  return { ready: true, reason: 'ready', details: gate };
}
