import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';

export interface RepairPrLandedEvent {
  schema: 1;
  prNumber: number;
  repairRunId: string;
  head: string;
  mergeSha: string;
  base: string;
  mergedAt: string;
}

export class RepairLandingRecoveryExhaustedError extends Error {
  constructor(message: string) { super(message); this.name = 'RepairLandingRecoveryExhaustedError'; }
}

export class RepairLandingHeadMismatchError extends Error {
  constructor(message: string) { super(message); this.name = 'RepairLandingHeadMismatchError'; }
}

function eventPath(prNumber: number, root = effectiveInstanceRoot()): string {
  return join(root, 'release', 'repair-pr-landings', `${prNumber}.json`);
}

function validateEvent(value: unknown, expectedPr?: number): RepairPrLandedEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = value as Partial<RepairPrLandedEvent>;
  if (event.schema !== 1 || !Number.isSafeInteger(event.prNumber) || event.prNumber! < 1 ||
    (expectedPr !== undefined && event.prNumber !== expectedPr) || typeof event.repairRunId !== 'string' || !event.repairRunId.trim() ||
    typeof event.base !== 'string' || !event.base.trim() ||
    typeof event.head !== 'string' || !/^[0-9a-f]{40}$/i.test(event.head) ||
    typeof event.mergeSha !== 'string' || !/^[0-9a-f]{40}$/i.test(event.mergeSha) ||
    typeof event.mergedAt !== 'string' || !Number.isFinite(Date.parse(event.mergedAt))) return undefined;
  return event as RepairPrLandedEvent;
}

function readEvent(prNumber: number, root: string): RepairPrLandedEvent | undefined {
  try { return validateEvent(JSON.parse(readFileSync(eventPath(prNumber, root), 'utf8')), prNumber); }
  catch { return undefined; }
}

/** Called only after `pr land` confirms a merge. Rename publishes one complete event atomically. */
export function publishRepairPrLanded(event: RepairPrLandedEvent, root = effectiveInstanceRoot()): void {
  if (!validateEvent(event, event.prNumber)) throw new Error('invalid release repair PR landing event');
  const path = eventPath(event.prNumber, root);
  mkdirSync(join(root, 'release', 'repair-pr-landings'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(event)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Event subscription used by the active repair node; checks before and after watcher setup to close the race. */
export async function waitForRepairPrLanded(prNumber: number, options: {
  repairRunId?: string;
  root?: string;
  signal?: AbortSignal;
  watchDirectory?: (directory: string, onEvent: () => void) => () => void;
  /** Re-query the authoritative PR state when the durable event is missing. `undefined` means it is not merged yet. */
  recover?: () => Promise<RepairPrLandedEvent | undefined>;
  expectedHead?: string;
  recoveryIntervalMs?: number;
  maxRecoveryFailures?: number;
} = {}): Promise<RepairPrLandedEvent> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('repair PR number must be positive');
  const root = options.root ?? effectiveInstanceRoot();
  const directory = join(root, 'release', 'repair-pr-landings');
  const matches = (event: RepairPrLandedEvent | undefined) => {
    if (!event || (options.repairRunId !== undefined && event.repairRunId !== options.repairRunId) || event.base !== 'main') return undefined;
    if (options.expectedHead !== undefined && event.head !== options.expectedHead) {
      throw new RepairLandingHeadMismatchError(`repair PR #${prNumber} landed head ${event.head} differs from inspected head ${options.expectedHead}`);
    }
    return event;
  };
  const existing = matches(readEvent(prNumber, root));
  if (existing) return existing;
  if (options.signal?.aborted) throw new Error('repair PR landing wait aborted');
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
  const maxRecoveryFailures = options.maxRecoveryFailures ?? 3;
  if (options.recover && (!Number.isSafeInteger(recoveryIntervalMs) || recoveryIntervalMs < 1 ||
    !Number.isSafeInteger(maxRecoveryFailures) || maxRecoveryFailures < 1)) {
    throw new Error('repair PR landing recovery limits must be positive integers');
  }
  return new Promise<RepairPrLandedEvent>((resolve, reject) => {
    let closeWatcher: (() => void) | undefined;
    let recoveryTimer: ReturnType<typeof setInterval> | undefined;
    let watchSetupError: Error | undefined;
    let recoveryInFlight = false;
    let consecutiveRecoveryFailures = 0;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      closeWatcher?.();
      if (recoveryTimer) clearInterval(recoveryTimer);
      options.signal?.removeEventListener('abort', aborted);
    };
    const check = () => {
      const event = matches(readEvent(prNumber, root));
      if (!event) return;
      cleanup();
      resolve(event);
    };
    const aborted = () => { cleanup(); reject(new Error('repair PR landing wait aborted')); };
    const startWatcher = () => {
      if (closed || closeWatcher) return;
      try {
        mkdirSync(directory, { recursive: true });
        if (options.watchDirectory) closeWatcher = options.watchDirectory(directory, check);
        else {
          const watcher = watch(directory, (_kind, filename) => {
            if (filename === null || filename.toString() === `${prNumber}.json`) check();
          });
          closeWatcher = () => watcher.close();
        }
        watchSetupError = undefined;
        check();
      } catch (error) {
        watchSetupError = error instanceof Error ? error : new Error(String(error));
      }
    };
    const recover = async () => {
      if (!options.recover || closed || recoveryInFlight) return;
      recoveryInFlight = true;
      try {
        startWatcher();
        if (closed) return;
        const event = await options.recover();
        if (closed) return;
        if (!event) {
          if (watchSetupError) throw watchSetupError;
          consecutiveRecoveryFailures = 0;
        } else {
          if (event.prNumber !== prNumber || (options.repairRunId !== undefined && event.repairRunId !== options.repairRunId)) {
            throw new Error('recovered repair PR landing event identity mismatch');
          }
          if (event.base !== 'main') throw new Error('recovered repair PR landing event base mismatch');
          if (options.expectedHead !== undefined && event.head !== options.expectedHead) {
            throw new RepairLandingHeadMismatchError(`recovered repair PR head ${event.head} differs from inspected head ${options.expectedHead}`);
          }
          publishRepairPrLanded(event, root);
          consecutiveRecoveryFailures = 0;
          check();
        }
      } catch (error) {
        if (closed) return;
        if (error instanceof RepairLandingHeadMismatchError) {
          cleanup();
          reject(error);
          return;
        }
        consecutiveRecoveryFailures++;
        if (consecutiveRecoveryFailures >= maxRecoveryFailures) {
          cleanup();
          reject(new RepairLandingRecoveryExhaustedError(`repair PR #${prNumber} (run ${options.repairRunId ?? 'unspecified'}) landing recovery exhausted after ${consecutiveRecoveryFailures} attempts: ${String(error).slice(0, 240)}`));
        }
      } finally { recoveryInFlight = false; }
    };
    options.signal?.addEventListener('abort', aborted, { once: true });
    startWatcher();
    check();
    if (watchSetupError && !options.recover) {
      cleanup();
      reject(watchSetupError);
    } else if (options.recover && !closed) {
      recoveryTimer = setInterval(() => { void recover(); }, recoveryIntervalMs);
      void recover();
    }
  });
}
