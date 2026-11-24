// DAILY-REGRESSION pack runner — `elanous --test sim run --pack daily-regression`.
// One line per scenario (PASS/FAIL/SKIP + duration), one JSON receipt under the test universe, ok=false on any FAIL.
// Kept out of the reserved `sim world run all` set on purpose: that runner executes packs under `sandbox-exec
// (deny network*)`, which also denies the unix sockets the PTY seat and the els server scenarios use.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dailyRegressionPending, dailyRegressionScenarios, type DailyRegressionScenario } from './scenarios.js';

export const SIM_REGRESSION_PACKS = ['daily-regression'] as const;
export type SimRegressionPackId = typeof SIM_REGRESSION_PACKS[number];

export interface SimRegressionRow {
  readonly id: string;
  readonly title: string;
  readonly prs: readonly number[];
  readonly verdict: 'PASS' | 'FAIL' | 'SKIP';
  readonly durationMs: number;
  /** All failed checks (FAIL) · the reason (SKIP) · null (PASS). */
  readonly detail: string | null;
  readonly notes: readonly { readonly kind: string; readonly data: Readonly<Record<string, unknown>> }[];
}
export interface SimRegressionReceipt {
  readonly schema: 'sim-regression.receipt/1';
  readonly pack: SimRegressionPackId;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly headSha: string | null;
  readonly host: string;
  readonly ok: boolean;
  readonly counts: { readonly pass: number; readonly fail: number; readonly skip: number };
  readonly rows: readonly SimRegressionRow[];
  readonly receiptPath: string;
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '(empty)';
export function formatSimRegressionLine(row: SimRegressionRow): string {
  const seconds = `${(row.durationMs / 1000).toFixed(1)}s`;
  const tail = row.verdict === 'PASS' ? row.title : `${row.title} — ${firstLine(row.detail ?? '')}`;
  return `${row.verdict.padEnd(4)} ${row.id.padEnd(5)} ${seconds.padStart(7)}  ${tail}`;
}

function headSha(): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '..', '..', '..', '..'), encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function runSimRegressionPack(options: {
  readonly pack: string;
  /** Test-universe root; the receipt goes to <stateRoot>/sim-regression/<runId>/receipt.json. */
  readonly stateRoot: string;
  readonly runId?: string;
  /** Only this scenario id (debugging one row). */
  readonly only?: string;
  readonly scenarios?: readonly DailyRegressionScenario[];
  readonly onRow?: (row: SimRegressionRow) => void;
  readonly host?: string;
}): Promise<SimRegressionReceipt> {
  if (!(SIM_REGRESSION_PACKS as readonly string[]).includes(options.pack))
    throw new Error(`unknown pack ${options.pack} (known: ${SIM_REGRESSION_PACKS.join(', ')})`);
  const runId = options.runId ?? `${new Date().toISOString().replace(/[-:.]/gu, '')}-${process.pid}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error(`run id is invalid: ${runId}`);
  const runDir = join(options.stateRoot, 'sim-regression', runId);
  mkdirSync(runDir, { recursive: true });
  const scenarios = (options.scenarios ?? dailyRegressionScenarios).filter((row) => !options.only || row.id === options.only);
  const pending = options.scenarios ? [] : dailyRegressionPending.filter((row) => !options.only || row.id === options.only);
  if (scenarios.length + pending.length === 0) throw new Error(`no scenario ${options.only} in pack ${options.pack}`);
  const startedAt = new Date().toISOString();
  const rows: SimRegressionRow[] = [];
  const emit = (row: SimRegressionRow) => { rows.push(row); options.onRow?.(row); };
  for (const scenario of scenarios) {
    const universeRoot = join(runDir, 'universe', scenario.id);
    mkdirSync(universeRoot, { recursive: true });
    const notes: { kind: string; data: Record<string, unknown> }[] = [];
    const started = performance.now();
    let verdict: SimRegressionRow['verdict'];
    let detail: string | null = null;
    try {
      const outcome = await scenario.run({ universeRoot, note: (kind, data = {}) => notes.push({ kind, data: { ...data } }) });
      verdict = outcome.ok ? 'PASS' : 'FAIL';
      if (!outcome.ok) detail = outcome.diff;
    } catch (error) {
      verdict = 'FAIL';
      detail = `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    // A passing universe is removed (receipt keeps the notes); a failing one is kept for diagnosis.
    if (verdict === 'PASS') rmSync(universeRoot, { recursive: true, force: true });
    emit({ id: scenario.id, title: scenario.title, prs: scenario.prs, verdict, durationMs: Math.round(performance.now() - started), detail, notes });
  }
  for (const row of pending) emit({ id: row.id, title: row.title, prs: [], verdict: 'SKIP', durationMs: 0, detail: row.waitingFor, notes: [] });
  const counts = { pass: rows.filter((r) => r.verdict === 'PASS').length, fail: rows.filter((r) => r.verdict === 'FAIL').length, skip: rows.filter((r) => r.verdict === 'SKIP').length };
  const receiptPath = join(runDir, 'receipt.json');
  const receipt: SimRegressionReceipt = { schema: 'sim-regression.receipt/1', pack: options.pack as SimRegressionPackId, runId, startedAt,
    finishedAt: new Date().toISOString(), headSha: headSha(), host: options.host ?? hostname(), ok: counts.fail === 0, counts, rows, receiptPath };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
