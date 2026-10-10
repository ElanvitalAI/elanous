/** LAND-QUEUE-P3 — the merge train's integration gate (changed-file tsc · changed tests · PWA reach/build) for ONE
 *  integration commit, run only on the gate host (node-b) through the GATE-REMOTE path (`runOnRemote`).
 *  Unlike `dispatchHeavyCheck` it never falls back to a local run: a busy host or an infra failure is «unmeasured».
 *  The only local commands are git (cat-file · rev-parse · push · diff). */
import { debug } from '../debug/log.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import {
  realGateRemoteRunner, resolveGateRemoteSettings, runOnRemote,
  type GateRemoteRunner, type GateRemoteSettings, type RemoteRunOutcome,
} from './gate-remote.js';

export type TrainGateOutcome = 'pass' | 'fail' | 'unmeasured';

export interface TrainGateInput {
  repo: string;
  /** The integration commit (40-char sha, present locally — need not be checked out). */
  commit: string;
  /** The base the changed-file checks measure against (TSC_BASE_REF). */
  baseSha: string;
  /** Repo-relative changed paths of the integration commit vs baseSha. */
  changedFiles: readonly string[];
  /** Paths deleted by the integration commit — kept in `changedFiles` for tsc/PWA reach, never run as tests. */
  deletedFiles?: readonly string[];
  settings?: GateRemoteSettings;
}

export interface TrainGateResult { outcome: TrainGateOutcome; host: string; ms?: number; rc?: number; reason?: string }

export interface TrainGateObservation {
  host: string; commit: string; baseSha: string; outcome: TrainGateOutcome;
  rc?: number; ms?: number; reason?: string; changedFiles: number;
}

export interface TrainGateDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Observation sink (default: category `merge-queue` in the log store, so a standalone CLI records it too). */
  observe?: (entry: TrainGateObservation) => void;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** The host-side shell body: each step runs only if the one before it passed. Exported for tests. */
export function trainGateScript(baseSha: string, changedFiles: readonly string[], deleted: ReadonlySet<string> = new Set()): string {
  // A deleted test file is a changed path (tsc/PWA reach) but not something to run.
  const tests = changedFiles.filter((file) => TEST_FILE.test(file) && !deleted.has(file));
  const steps = [
    `TSC_BASE_REF=${quote(baseSha)} bun scripts/ci-typecheck-changed.ts --local`,
    ...(tests.length ? [`bun run test:deterministic ${tests.map(quote).join(' ')}`] : []),
    `bun scripts/ci-pwa-build-gate.ts --changed-files ${changedFiles.map(quote).join(' ')}`,
  ];
  return steps.join(' && ');
}

async function loadSettings(): Promise<GateRemoteSettings> {
  try {
    const { getUserConfig } = await import('../user-config.js');
    return resolveGateRemoteSettings(getUserConfig().gateRemote);
  } catch { return resolveGateRemoteSettings(undefined); }
}

function defaultObserve(entry: TrainGateObservation): void {
  const store = getDefaultLogStore();
  if (!store) return;
  store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'merge-queue', event: 'train-gate', data: entry }, surface: 'merge-queue' }]);
}

/** The integration gate runs only on the gate host (LAND-QUEUE-P3 · review must-fix): another configured host is «unmeasured». */
export const TRAIN_GATE_HOST = 'node-b';

export async function runTrainGateOnHost(input: TrainGateInput, runner: GateRemoteRunner = realGateRemoteRunner, deps: TrainGateDeps = {}): Promise<TrainGateResult> {
  const settings = input.settings ?? await loadSettings();
  const host = settings.host;
  if (host !== TRAIN_GATE_HOST) {
    const entry: TrainGateObservation = { host, commit: input.commit, baseSha: input.baseSha, outcome: 'unmeasured', reason: `host-not-gate-host (${host} ≠ ${TRAIN_GATE_HOST})`, changedFiles: input.changedFiles.length };
    debug.log('merge-queue', 'train-gate', entry);
    try { (deps.observe ?? defaultObserve)(entry); } catch { /* observation only */ }
    return { outcome: 'unmeasured', host, reason: entry.reason };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + settings.slotWaitSeconds * 1000;
  const script = trainGateScript(input.baseSha, input.changedFiles, new Set(input.deletedFiles ?? []));
  let outcome: RemoteRunOutcome;
  for (;;) {
    try {
      outcome = runOnRemote({
        repo: input.repo, host, mirror: settings.mirror, commit: input.commit, refs: [input.baseSha],
        argv: ['sh', '-c', script], installPwa: true, hostCap: settings.hostCap,
      }, runner);
    } catch (error) {
      outcome = { kind: 'infra', reason: `exception: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (outcome.kind !== 'busy') break;
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(15_000, left));
    if (now() >= deadline) break;
  }
  const result: TrainGateResult = outcome.kind === 'ran'
    ? { outcome: outcome.rc === 0 ? 'pass' : 'fail', host, ms: outcome.ms, rc: outcome.rc }
    : { outcome: 'unmeasured', host, reason: outcome.kind === 'busy' ? `host-busy (cap ${settings.hostCap} held for ${settings.slotWaitSeconds}s)` : outcome.reason };
  const entry: TrainGateObservation = {
    host, commit: input.commit, baseSha: input.baseSha, outcome: result.outcome,
    rc: result.rc, ms: result.ms, reason: result.reason, changedFiles: input.changedFiles.length,
  };
  debug.log('merge-queue', 'train-gate', entry);
  try { (deps.observe ?? defaultObserve)(entry); } catch (error) {
    debug.log('merge-queue', 'train-gate-observe-failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return result;
}

/** The merge train's `gate` seam: `(commitSha, prNumbers) → 'pass' | 'fail' | 'unmeasured'`. Changed files are the
 *  integration commit's diff against `baseSha` (local git only); a diff failure is «unmeasured», never a local run. */
export type TrainGate = (commitSha: string, prNumbers: readonly number[]) => Promise<TrainGateOutcome>;

export function trainGateOnHost(opts: { repo: string; baseSha: string; settings?: GateRemoteSettings }, runner: GateRemoteRunner = realGateRemoteRunner, deps: TrainGateDeps = {}): TrainGate {
  const unmeasured = (commitSha: string, reason: string): 'unmeasured' => {
    const entry: TrainGateObservation = { host: opts.settings?.host ?? TRAIN_GATE_HOST, commit: commitSha, baseSha: opts.baseSha, outcome: 'unmeasured', reason, changedFiles: 0 };
    debug.log('merge-queue', 'train-gate', entry);
    try { (deps.observe ?? defaultObserve)(entry); } catch { /* observation only */ }
    return 'unmeasured';
  };
  return async (commitSha) => {
    try {
      const diff = runner.local('git', ['diff', '--name-status', '-z', opts.baseSha, commitSha], opts.repo);
      if (diff.rc !== 0 || diff.error) return unmeasured(commitSha, 'changed-files-unavailable');
      const { changedFiles, deletedFiles } = parseNameStatus(diff.stdout);
      return (await runTrainGateOnHost({ repo: opts.repo, commit: commitSha, baseSha: opts.baseSha, changedFiles, deletedFiles, settings: opts.settings }, runner, deps)).outcome;
    } catch (error) {
      // Any preparation failure (local git spawn, parse, settings) is «unmeasured» — never a rejected promise, never a local run.
      return unmeasured(commitSha, `prepare-failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
    }
  };
}

/** `git diff --name-status -z` → changed paths (renames contribute both sides) ⊕ deleted paths. Exported for tests. */
export function parseNameStatus(out: string): { changedFiles: string[]; deletedFiles: string[] } {
  const parts = out.split('\0').filter((part) => part !== '');
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]!;
    if (/^[RC]/.test(status)) {
      const from = parts[i++]; const to = parts[i++];
      if (from) { changed.push(from); if (status.startsWith('R')) deleted.push(from); }
      if (to) changed.push(to);
    } else {
      const path = parts[i++];
      if (!path) break;
      changed.push(path);
      if (status === 'D') deleted.push(path);
    }
  }
  return { changedFiles: [...new Set(changed)], deletedFiles: [...new Set(deleted)] };
}
