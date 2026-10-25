/**
 * TA-REJUDGE-PERIODIC — the steward (coordinator) tick re-runs `tasks rejudge --all` on a cadence.
 *
 * `tasks rejudge` only ran when someone typed it (OP bridged the gap with a 30-minute shell loop). This node is the
 * product form: the steward graph already ticks every 15 minutes, so the rejudge rides that tick — no new resident loop.
 *
 * - Off by default: `taskAgent.rejudgeEveryMinutes` absent/0 → one `disabled` line per tick and nothing else.
 *   Rejudge can land PRs (per `taskAgent.liveMoves`), so it is switched on by an operator, not by an upgrade.
 * - Cadence: due when the last started run is ≥ interval − 2 min ago (tick start jitter must not skip a whole tick).
 * - Load guard: 1-minute load average above `taskAgent.rejudgeMaxLoad` (default 60) skips this tick without stamping,
 *   so the next tick retries.
 * - Fail-soft: every outcome exits 0 — a rejudge problem never stops the steward's own stages.
 * - Observation: one `debug.log('loop.steward', 'rejudge-tick', …)` per tick.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { spawnElanous } from '../instance/spawn-elanous.js';
import { getUserConfig } from '../user-config.js';
import { resyncPendingPath, resyncPendingRecoveryPath } from './resync-tick.js';

export const REJUDGE_TICK_EVENT = 'rejudge-tick';
export const REJUDGE_DEFAULT_MAX_LOAD = 60;
export const REJUDGE_JITTER_MS = 2 * 60_000;
export const REJUDGE_TIMEOUT_MS = 600_000;

export type RejudgeTickDecision = 'disabled' | 'not-due' | 'load-skip' | 'ran' | 'failed';

export interface RejudgeTickResult {
  decision: RejudgeTickDecision;
  everyMinutes: number | null;
  load?: number;
  maxLoad?: number;
  lastStartedAt?: string | null;
  rc?: number | null;
  timedOut?: boolean;
  cards?: number;
  decisions?: Record<string, number>;
  ms?: number;
  reason?: string;
}

export interface RejudgeRun { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface RejudgeTickDeps {
  now?: () => Date;
  /** `taskAgent.rejudgeEveryMinutes` / `taskAgent.rejudgeMaxLoad` — default reads the user config. */
  config?: () => { rejudgeEveryMinutes?: number; rejudgeMaxLoad?: number } | undefined;
  load?: () => number;
  stampPath?: string;
  pendingPath?: string;
  run?: () => Promise<RejudgeRun>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

function defaultStampPath(): string {
  // Resolved at call time, in the node process's own universe (prod cron vs --test graph run).
  return join(effectiveInstanceRoot(), 'steward', 'rejudge-tick.json');
}

function readStamp(path: string): string | null {
  try {
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { startedAt?: unknown }).startedAt;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      throw new Error(`invalid steward stamp startedAt: ${path}`);
    }
    return value;
  } catch (error) {
    // A missing stamp is the first tick. A corrupt or unreadable existing stamp is not:
    // claiming it would overwrite the evidence and could launch an overlapping rejudge.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Same universe as this process (env inherited) · same installed version (entry next to this module). */
export function defaultRejudgeRun(timeoutMs = REJUDGE_TIMEOUT_MS): Promise<RejudgeRun> {
  return new Promise(done => {
    const child = spawnElanous(['tasks', 'rejudge', '--all', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); done({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut }); });
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
  });
}

/** The last `[...]` line of `tasks rejudge --all --json` → card count and a decision histogram. */
function summarize(stdout: string): { cards: number; decisions: Record<string, number> } | null {
  const line = stdout.split('\n').map(text => text.trim()).filter(text => text.startsWith('[')).at(-1);
  if (!line) return null;
  try {
    const rows = JSON.parse(line) as Array<{ card?: unknown; decision?: unknown }>;
    if (!Array.isArray(rows)) return null;
    const decisions: Record<string, number> = {};
    for (const row of rows) { const key = String(row?.decision ?? 'unknown'); decisions[key] = (decisions[key] ?? 0) + 1; }
    return { cards: new Set(rows.map(row => String(row?.card))).size, decisions };
  } catch { return null; }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function rejudgeTick(deps: RejudgeTickDeps = {}): Promise<RejudgeTickResult> {
  const log = deps.log ?? ((event, data) => debug.log('loop.steward', event, data));
  const emit = (result: RejudgeTickResult): RejudgeTickResult => {
    try { log(REJUDGE_TICK_EVENT, { ...result }); } catch { /* fail-soft */ }
    return result;
  };
  try {
    const cfg = (deps.config ?? (() => getUserConfig().taskAgent))();
    const everyMinutes = positive(cfg?.rejudgeEveryMinutes);
    if (everyMinutes === null) return emit({ decision: 'disabled', everyMinutes: null, reason: 'taskAgent.rejudgeEveryMinutes unset' });
    const now = (deps.now ?? (() => new Date()))();
    const stampPath = deps.stampPath ?? defaultStampPath();
    const lastStartedAt = readStamp(stampPath);
    const pendingAt = readPending(deps.pendingPath ?? resyncPendingPath());
    const savedSinceLastRun = pendingAt !== null && (!lastStartedAt || Date.parse(pendingAt) > Date.parse(lastStartedAt));
    if (!savedSinceLastRun && lastStartedAt && now.getTime() - Date.parse(lastStartedAt) < everyMinutes * 60_000 - REJUDGE_JITTER_MS) {
      return emit({ decision: 'not-due', everyMinutes, lastStartedAt });
    }
    const maxLoad = positive(cfg?.rejudgeMaxLoad) ?? REJUDGE_DEFAULT_MAX_LOAD;
    const load = (deps.load ?? (() => loadavg()[0] ?? 0))();
    if (load > maxLoad) return emit({ decision: 'load-skip', everyMinutes, load, maxLoad, lastStartedAt });
    // Claim before running so an overlapping steward tick does not start a second rejudge.
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ startedAt: now.toISOString() }));
    const started = Date.now();
    const run = await (deps.run ?? (() => defaultRejudgeRun()))();
    const summary = summarize(run.stdout);
    const ok = run.code === 0 && !run.timedOut && summary !== null;
    return emit({
      decision: ok ? 'ran' : 'failed', everyMinutes, load, maxLoad, lastStartedAt, rc: run.code, timedOut: run.timedOut,
      cards: summary?.cards ?? 0, decisions: summary?.decisions ?? {}, ms: Date.now() - started,
      ...(ok ? {} : { reason: (run.stderr || run.stdout).trim().slice(-300) || (summary === null ? 'no JSON result line' : 'nonzero exit') }),
    });
  } catch (error) {
    return emit({ decision: 'failed', everyMinutes: null, reason: (error instanceof Error ? error.message : String(error)).slice(-300) });
  }
}

/**
 * The resync marker, or its recovery sibling when the primary record could not be written after a push. Both carry
 * `{ savedAt }`, so a same-tick rejudge still sees the new head instead of falling back to the cadence alone.
 */
function readPending(path: string): string | null {
  for (const candidate of [path, resyncPendingRecoveryPath(path)]) {
    try {
      const value = (JSON.parse(readFileSync(candidate, 'utf8')) as { savedAt?: unknown }).savedAt;
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
    } catch { /* missing or unreadable: fall through to the recovery marker */ }
  }
  return null;
}

if (import.meta.main) {
  try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('steward'); }
  catch (error) { console.error(`steward rejudge: log sink registration failed — ${error instanceof Error ? error.message : String(error)}`); }
  const result = await rejudgeTick();
  console.log(`steward rejudge: ${result.decision}${result.reason ? ` — ${result.reason}` : ''}`);
  process.exitCode = 0;
}
