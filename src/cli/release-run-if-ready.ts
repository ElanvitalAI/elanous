import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import type { ReleaseReadiness } from '../../scripts/release-loop/release-readiness.js';

export type ReleaseIfReadySkip = { skipped: true; reason: Exclude<ReleaseReadiness, { ready: true }>['reason']; detail: string };

export async function runReleaseIfReady<T>(version: string, deps: {
  readiness: (version: string, options?: { isPidAlive?: (pid: number) => boolean }) => ReleaseReadiness | Promise<ReleaseReadiness>;
  run: () => Promise<T>;
  ledgerRoot?: string;
  pid?: number;
  now?: () => Date;
}): Promise<ReleaseIfReadySkip | { skipped: false; result: T }> {
  const skip = (readiness: Exclude<ReleaseReadiness, { ready: true }>): ReleaseIfReadySkip => {
    const detail = readiness.reason === 'checklist-blocked'
      ? [...readiness.details.red, ...readiness.details.undecided, ...readiness.details.blocked].join(', ')
      : readiness.details;
    debug.log('release-loop.readiness', readiness.reason, { version, detail });
    return { skipped: true, reason: readiness.reason, detail };
  };
  const readiness = await deps.readiness(version);
  if (!readiness.ready) return skip(readiness);

  const dir = join(deps.ledgerRoot ?? releaseLedgerRoot(), 'release', version);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'run.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const detail = 'run.lock already exists';
    debug.log('release-loop.readiness', 'already-running', { version, detail });
    return { skipped: true, reason: 'already-running', detail };
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: deps.pid ?? process.pid, startedAt: (deps.now ?? (() => new Date()))().toISOString() })}\n`);
    // This call still checks publication and checklist, but must not treat our own lock as another runner.
    const insideLock = await deps.readiness(version, { isPidAlive: () => false });
    if (!insideLock.ready) return skip(insideLock);
    debug.log('release-loop.readiness', 'ready', { version });
    return { skipped: false, result: await deps.run() };
  } finally {
    closeSync(fd);
    rmSync(lock);
  }
}
