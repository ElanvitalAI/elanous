import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { TrackAgentDecision, TrackAgentInput, TrackAgentResult } from './track-agent.js';

const exec = promisify(execFile);
const dateInKst = (now: Date): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

export type ShadowLedgerEntry = {
  at: string;
  missionId: string;
  taskId: string;
  track: string;
  event: 'decision-started' | 'decision' | 'orchestrate-started' | 'orchestrate';
  action?: TrackAgentDecision['action'];
  status?: TrackAgentResult['status'];
  workdir?: string | null;
  workdirs?: (string | null)[];
};

export type ShadowOptions = {
  ledgerDir?: string;
  now?: () => Date;
  maxDecisionsPerDay?: number;
  orchestrate?: (args: string[]) => Promise<{ stdout: string }>;
};

export function shadowLedgerPath(options: ShadowOptions = {}): string {
  const now = options.now?.() ?? new Date();
  return join(options.ledgerDir ?? join(effectiveInstanceRoot(), 'autopilot', 'track-agent-shadow'), `${dateInKst(now)}.jsonl`);
}

function append(entry: ShadowLedgerEntry, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
}

function entryFor(input: TrackAgentInput, event: ShadowLedgerEntry['event'], now: Date): ShadowLedgerEntry {
  return { at: now.toISOString(), missionId: input.missionId, taskId: input.taskId, track: input.track, event };
}

/** Reserve a daily decision slot on disk before invoking the agent. An unreadable ledger never grants a slot. */
export async function decideShadowTrackAction(
  input: TrackAgentInput,
  decide: (input: TrackAgentInput) => Promise<TrackAgentDecision> | TrackAgentDecision,
  options: ShadowOptions = {},
): Promise<TrackAgentDecision> {
  const now = options.now?.() ?? new Date();
  const path = shadowLedgerPath({ ...options, now: () => now });
  const configured = options.maxDecisionsPerDay ?? 20;
  const limit = Number.isSafeInteger(configured) && configured >= 0 ? configured : 20;
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // The lock spans only count + reservation, never the callback. A contested slot fails closed.
    mkdirSync(lockPath);
  } catch {
    return { action: 'hold', reason: 'shadow 원장 확인 실패' };
  }
  let reserved = false;
  let capped = false;
  try {
    let rows: string[];
    try { rows = readFileSync(path, 'utf8').split('\n').filter(Boolean); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      rows = [];
    }
    const count = rows.reduce((total, row) => {
      const value: unknown = JSON.parse(row);
      if (!value || typeof value !== 'object' || !('event' in value)) throw new Error('invalid shadow ledger');
      return total + ((value as { event: unknown }).event === 'decision-started' ? 1 : 0);
    }, 0);
    if (count >= limit) capped = true;
    else { append(entryFor(input, 'decision-started', now), path); reserved = true; }
  } catch { /* The callback cannot run without a durable reservation. */ }
  finally {
    try { rmdirSync(lockPath); }
    catch { reserved = false; }
  }
  if (capped) return { action: 'hold', reason: '일일 판정 상한' };
  if (!reserved) return { action: 'hold', reason: 'shadow 원장 확인 실패' };
  try {
    const decision = await decide(input);
    append({ ...entryFor(input, 'decision', now), action: decision.action }, path);
    return decision;
  } catch {
    return { action: 'hold', reason: '판정 실패 — 사람 확인' };
  }
}

function outcomeFromOutput(stdout: string): { workdirs: (string | null)[]; succeeded: boolean } {
  const parsed: unknown = JSON.parse(stdout.trim());
  const results = parsed && typeof parsed === 'object' && 'results' in parsed
    ? (parsed as { results: unknown }).results : parsed;
  const items: unknown[] = Array.isArray(results) ? results : [results];
  const workdirs = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    const path = value.worktreePath ?? value.workdir;
    return typeof path === 'string' && path.length > 0 ? path : null;
  });
  return {
    workdirs,
    succeeded: items.length > 0 && items.every((item, index) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
      && (item as Record<string, unknown>).status === 'done' && workdirs[index] !== null),
  };
}

/** Called only after the ordinary track/forbidden-task/budget gates approve the work. */
export async function launchTrackAgentShadow(input: TrackAgentInput, options: ShadowOptions = {}): Promise<TrackAgentResult> {
  const now = options.now?.() ?? new Date();
  const path = shadowLedgerPath({ ...options, now: () => now });
  try {
    append(entryFor(input, 'orchestrate-started', now), path);
  } catch { return { status: 'failed', detail: 'shadow 원장 기록 실패' }; }
  const args = ['self', 'orchestrate', '--json', `${input.title}\n${input.prompt}`];
  let status: TrackAgentResult['status'] = 'failed';
  let workdirs: (string | null)[] = [];
  try {
    const run = options.orchestrate ?? (async (values: string[]) => {
      const instanceRoot = effectiveInstanceRoot();
      const { stdout } = await exec('bun', ['bin/elanous.mjs', '--config-dir', instanceRoot, ...values], {
        cwd: process.env.ELANOUS_TOOL_CWD?.trim() || resolve(import.meta.dir, '../..'),
        env: { ...process.env, ELANOUS_STATE_DIR: instanceRoot, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(instanceRoot) },
        encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
      return { stdout };
    });
    const outcome = outcomeFromOutput((await run(args)).stdout);
    workdirs = outcome.workdirs;
    if (outcome.succeeded) status = 'launched';
  } catch (error) {
    // self orchestrate may exit nonzero after writing its JSON results; retain every observed workdir.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string') {
      try { workdirs = outcomeFromOutput(stdout).workdirs; } catch { /* malformed result has no observed workdir */ }
    }
  }
  try {
    append({ ...entryFor(input, 'orchestrate', now), status, workdir: workdirs[0] ?? null, workdirs }, path);
  } catch { return { status: 'failed', detail: 'shadow 원장 기록 실패' }; }
  return status === 'launched'
    ? { status, detail: workdirs.join(', ') }
    : { status, detail: 'shadow 실행 실패 또는 workdir 미관측' };
}
