import { execFile } from 'node:child_process';
import { listRunLedgers } from '../self-implement/run-ledger.js';
import { runGitCommand } from '../git-fs/runner.js';
import type { PodLeasePredecessor } from './admission.js';

/** merged = admit · waiting = keep queued (open, unknown, unreadable) · blocked = predecessor closed without merging. */
export type PredecessorState = 'merged' | 'waiting' | 'blocked';

type PrState = string | null;

type DependencyStateDeps = {
  prState?: (number: number, signal?: AbortSignal) => PrState | Promise<PrState>;
  ledgers?: () => ReturnType<typeof listRunLedgers>['matches'];
};

function githubRepository(): string | null {
  const remote = runGitCommand(process.cwd(), ['config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 5_000 });
  const repository = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.stdout.trim())?.[1];
  return remote.status !== 0 || !repository || repository.includes('..') ? null : repository;
}

/** Async so a slow GitHub lookup never blocks the event loop (admission, cancellation, other launches). */
function githubPrState(number: number, signal?: AbortSignal): Promise<PrState> {
  const repository = githubRepository();
  if (!repository) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', String(number), '--repo', repository, '--json', 'state'], {
      encoding: 'utf8', timeout: 15_000, env: process.env, ...(signal ? { signal } : {}),
    }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const response: unknown = JSON.parse(stdout);
        resolve(response && typeof response === 'object' && 'state' in response && typeof response.state === 'string' ? response.state : null);
      } catch { resolve(null); }
    });
  });
}

const prNumberOf = (after: PodLeasePredecessor): number | null => {
  const number = typeof after === 'number' ? after : Number(after.replace(/^#/, ''));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

async function readState(number: number, deps: DependencyStateDeps, signal?: AbortSignal): Promise<PrState> {
  try { return await (deps.prState ?? githubPrState)(number, signal); } catch { return null; }
}

/** Only a verified merged predecessor grants a Pod lease; a predecessor closed without merging blocks; everything else waits. */
export async function predecessorState(after: PodLeasePredecessor, deps: DependencyStateDeps = {}, signal?: AbortSignal): Promise<PredecessorState> {
  const isPr = typeof after === 'number' || (typeof after === 'string' && !/^[a-f0-9]{16}$/.test(after) && /^#?[1-9]\d*$/.test(after));
  if (isPr) {
    const number = prNumberOf(after);
    if (number === null) return 'waiting';
    const state = await readState(number, deps, signal);
    return state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'blocked' : 'waiting';
  }
  if (typeof after !== 'string' || !after.trim()) return 'waiting';
  let numbers: Set<number>;
  try {
    const matches = (deps.ledgers ?? (() => listRunLedgers().matches))()
      .filter(({ entries }) => entries.some((entry) => entry.goalId === after));
    numbers = new Set<number>();
    for (const { entries } of matches) {
      for (const entry of entries) {
        if (entry.event !== 'pr-opened' || entry.goalId !== after) continue;
        const number = entry.data.number;
        if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) numbers.add(number);
      }
    }
  } catch { return 'waiting'; }
  if (numbers.size === 0) return 'waiting';
  // A later attempt or manual merge can land an opened PR without an in-run merged event.
  let allClosed = true;
  for (const number of numbers) {
    const state = await readState(number, deps, signal);
    if (state === 'MERGED') return 'merged';
    if (state !== 'CLOSED') allClosed = false;
  }
  return allClosed ? 'blocked' : 'waiting';
}

/** Back-compat boolean view: true only when merged. */
export async function predecessorMerged(after: PodLeasePredecessor, deps: DependencyStateDeps = {}, signal?: AbortSignal): Promise<boolean> {
  return (await predecessorState(after, deps, signal)) === 'merged';
}
