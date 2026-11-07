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
} = {}): Promise<RepairPrLandedEvent> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('repair PR number must be positive');
  const root = options.root ?? effectiveInstanceRoot();
  const directory = join(root, 'release', 'repair-pr-landings');
  const matches = (event: RepairPrLandedEvent | undefined) => event &&
    (options.repairRunId === undefined || event.repairRunId === options.repairRunId) ? event : undefined;
  const existing = matches(readEvent(prNumber, root));
  if (existing) return existing;
  if (options.signal?.aborted) throw new Error('repair PR landing wait aborted');
  mkdirSync(directory, { recursive: true });
  return new Promise<RepairPrLandedEvent>((resolve, reject) => {
    let closeWatcher: (() => void) | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      closeWatcher?.();
      options.signal?.removeEventListener('abort', aborted);
    };
    const check = () => {
      const event = matches(readEvent(prNumber, root));
      if (!event) return;
      cleanup();
      resolve(event);
    };
    const aborted = () => { cleanup(); reject(new Error('repair PR landing wait aborted')); };
    options.signal?.addEventListener('abort', aborted, { once: true });
    try {
      if (options.watchDirectory) closeWatcher = options.watchDirectory(directory, check);
      else {
        const watcher = watch(directory, (_kind, filename) => {
          if (filename === null || filename.toString() === `${prNumber}.json`) check();
        });
        closeWatcher = () => watcher.close();
      }
      check();
    } catch (error) { cleanup(); reject(error); }
  });
}
