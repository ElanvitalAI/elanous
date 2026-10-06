import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';

export interface LandingFreeze {
  reason: string;
  startedAt: string;
  until: string | null;
  by: string;
}

export function landingFreezePath(root = effectiveInstanceRoot()): string {
  return join(root, 'landing-freeze.json');
}

export function readLandingFreeze(root = effectiveInstanceRoot(), now = new Date()): LandingFreeze | null {
  const path = landingFreezePath(root);
  let text: string;
  // Read without an existence pre-check: a concurrent `freeze off` between the two would surface as ENOENT.
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const record: unknown = JSON.parse(text);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`invalid landing freeze: ${path}`);
  const freeze = record as Partial<LandingFreeze>;
  if (typeof freeze.reason !== 'string' || typeof freeze.by !== 'string' ||
      typeof freeze.startedAt !== 'string' || !Number.isFinite(Date.parse(freeze.startedAt)) ||
      !(freeze.until === null || (typeof freeze.until === 'string' && Number.isFinite(Date.parse(freeze.until))))) {
    throw new Error(`invalid landing freeze: ${path}`);
  }
  // An expired freeze reads as «off». The file is left alone: deleting it here could race a concurrent `freeze on`
  // that just wrote a new one (only `freeze off` removes it; the next `freeze on` overwrites it).
  if (freeze.until && Date.parse(freeze.until) <= now.getTime()) return null;
  return freeze as LandingFreeze;
}

export function enableLandingFreeze(opts: { reason?: string; until?: string; by?: string }, root = effectiveInstanceRoot(), now = new Date()): LandingFreeze {
  const until = opts.until === undefined ? null : opts.until;
  if (until !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(until) || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= now.getTime())) {
    throw new Error('--until must be a future ISO timestamp with timezone');
  }
  const freeze: LandingFreeze = { reason: opts.reason?.trim() || 'operator freeze', startedAt: now.toISOString(), until: until === null ? null : new Date(until).toISOString(), by: opts.by?.trim() || process.env.ELANOUS_TRACK || process.env.USER || 'cli' };
  const path = landingFreezePath(root);
  mkdirSync(root, { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(freeze, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return freeze;
}

export function disableLandingFreeze(root = effectiveInstanceRoot()): void {
  rmSync(landingFreezePath(root), { force: true });
}

/** In-flight merge markers: a merger writes its marker «before» reading the freeze file, and `freeze on` writes the
 *  freeze file «before» counting markers — so either the merger sees the freeze or the freeze waits for the merger. */
function mergesDir(root: string): string { return join(root, 'landing-merges'); }

export interface LandingMergeGuard { frozen: LandingFreeze | null; end: () => void }

/** Mark both authorities before reading either freeze: the host and the child each drain their own in-flight merges. */
export function beginLandingMerge(root = effectiveInstanceRoot(), now = new Date(), prodFreezeRoot = prodInstanceRoot(), forceReason?: string): LandingMergeGuard {
  const markers: string[] = [];
  const end = () => { for (const marker of markers) rmSync(marker, { force: true }); };
  try {
    for (const authority of new Set([prodFreezeRoot, root])) {
      const dir = mergesDir(authority);
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, `${process.pid}-${randomUUID()}.json`);
      markers.push(marker);
      writeFileSync(marker, `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`, { mode: 0o600 });
    }
  } catch (error) { end(); throw error; }
  let frozen: LandingFreeze | null;
  try { frozen = readLandingFreeze(prodFreezeRoot, now) ?? (root === prodFreezeRoot ? null : readLandingFreeze(root, now)); }
  catch (error) { end(); throw error; }
  if (frozen && !forceReason?.trim()) { end(); return { frozen, end: () => {} }; }
  return { frozen: null, end };
}

/** Live in-flight merges; markers of dead processes are removed. */
export function inFlightLandingMerges(root = effectiveInstanceRoot()): number {
  const dir = mergesDir(root);
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let live = 0;
  for (const name of names) {
    const pid = Number(name.split('-')[0]);
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    }
    if (alive) live++; else rmSync(join(dir, name), { force: true });
  }
  return live;
}

/** `freeze on` completes only after merges that passed their freeze check have finished (or the wait runs out). */
export async function awaitLandingMergesDrained(
  root = effectiveInstanceRoot(),
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ drained: boolean; pending: number }> {
  const timeoutMs = opts.timeoutMs ?? 600_000, pollMs = opts.pollMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = inFlightLandingMerges(root);
    if (pending === 0) return { drained: true, pending: 0 };
    if (Date.now() >= deadline) return { drained: false, pending };
    await sleep(pollMs);
  }
}

/** Thrown where a release run stops for a freeze, so the scheduled `--if-ready` path can defer instead of failing. */
export class LandingFrozenError extends Error {
  constructor(readonly freeze: LandingFreeze) { super(landingFreezeMessage(freeze)); this.name = 'LandingFrozenError'; }
}

const FREEZE_MESSAGE_HEAD = '동결 중 · ';

/** True when a node's recorded output or error is the freeze refusal written by {@link landingFreezeMessage}. */
export function isLandingFreezeRefusal(text: string): boolean { return text.includes(FREEZE_MESSAGE_HEAD); }

export function landingFreezeMessage(freeze: LandingFreeze): string {
  return `${FREEZE_MESSAGE_HEAD}${freeze.reason} · 끝 시각 ${freeze.until ?? '미지정'}`;
}
