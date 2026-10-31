/** LAND-QUEUE-P3 — the merge train's integration gate (changed-file tsc · changed tests · PWA reach/build) for ONE
 *  integration commit, run only on the gate host (node-b) through the GATE-REMOTE path (`runOnRemote`).
 *  Unlike `dispatchHeavyCheck` it never falls back to a local run: a busy host or an infra failure is «unmeasured».
 *  The only local commands are git (cat-file · rev-parse · push · diff). */
import { debug } from '../debug/log.js';
import { spawnSync } from 'node:child_process';
import { parseGateScenario, readGateScenarioFile } from './gate-scenario.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { join } from 'node:path';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { saveGateReceipt, type GateReceipt } from './gate-receipt-registry.js';
import {
  gateRemoteHostCap, realGateRemoteRunner, resolveGateRemoteSettings, runOnRemote,
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
  /** Optional v0 JSON scenario. Selected tests are additive; invalid input is unmeasured. */
  scenario?: unknown;
  scenarioFile?: string;
  settings?: GateRemoteSettings;
}

export interface TrainGateResult { outcome: TrainGateOutcome; host: string; ms?: number; rc?: number; reason?: string }

const GATE_RECEIPTS_MARKER = String.fromCharCode(10) + '__GATE_RECEIPTS__';

function sharedGateReceiptPath(repo: string, runner: GateRemoteRunner): string | undefined {
  try {
    const result = runner.local('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
    const commonDir = result.stdout.trim();
    return result.rc === 0 && commonDir ? join(commonDir, 'elanous-host-regate', 'gate-receipts.json') : undefined;
  } catch { return undefined; }
}

/** The exact persistent registry used by local train receipt merging. */
export function gateReceiptRegistryPathForRepo(repo: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo, encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  const commonDir = (result.stdout ?? '').trim();
  return result.status === 0 && commonDir ? join(commonDir, 'elanous-host-regate', 'gate-receipts.json') : undefined;
}

/** Merge the existing remote-writer marker into the local common-dir registry. Invalid rows fail closed. */
export function mergeGateReceiptRegistryPayload(payload: string, path: string): number {
  let saved = 0;
  try {
    const rows = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(rows)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const receipt = value as GateReceipt;
      if (receipt.key !== key) continue;
      try { saveGateReceipt(path, receipt); saved++; }
      catch { /* Invalid remote records are discarded; local gates remain fail-open. */ }
    }
  } catch { /* A malformed response never changes the measured gate verdict. */ }
  return saved;
}

function mergeReturnedReceipts(outcome: RemoteRunOutcome, path: string | undefined): RemoteRunOutcome {
  if (outcome.kind !== 'ran' || outcome.rc !== 0 || !path) return outcome;
  const stdout = outcome.stdout.toString('utf8');
  const marker = stdout.lastIndexOf(GATE_RECEIPTS_MARKER);
  if (marker < 0) return outcome;
  const payload = stdout.slice(marker + GATE_RECEIPTS_MARKER.length).trim();
  mergeGateReceiptRegistryPayload(payload, path);
  return { ...outcome, stdout: Buffer.from(stdout.slice(0, marker)) };
}

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
  const receiptPath = sharedGateReceiptPath(input.repo, runner);
  // Each remote full gate writes into a fresh scratch registry; returned rows merge into the local shared registry.
  // No existing registry contents are needed for receipt registration.
  const payloadFiles = receiptPath ? [{ env: 'ELANOUS_GATE_RECEIPT_REGISTRY_PATH', content: '{}' }] : undefined;
  const host = settings.host;
  const hostCap = gateRemoteHostCap(settings, host);
  let scenarioTests: string[] = [];
  if (input.scenario !== undefined || input.scenarioFile !== undefined) {
    try {
      if (input.scenario !== undefined && input.scenarioFile !== undefined) throw new Error('choose scenario or scenarioFile');
      const scenario = parseGateScenario(input.scenarioFile === undefined ? input.scenario : readGateScenarioFile(input.scenarioFile), { baseSha: input.baseSha, headSha: input.commit, changedFiles: input.changedFiles });
      if (scenario.selectedTests.some(({ path }) => input.deletedFiles?.includes(path))) throw new Error('selected test deleted');
      scenarioTests = scenario.selectedTests.map(({ path }) => path);
      // The remote checks out this exact commit. Verify every path against its tree locally before spending a host slot.
      for (const path of scenarioTests) {
        const file = runner.local('git', ['cat-file', '-e', `${input.commit}:${path}`], input.repo);
        if (file.rc !== 0 || file.error) throw new Error(`selected test missing at head: ${path}`);
        const tree = runner.local('git', ['ls-tree', '-z', input.commit, '--', path], input.repo);
        if (tree.rc !== 0 || tree.error || !/^100(?:644|755) blob [0-9a-f]{40}\t/.test(tree.stdout)
          || !tree.stdout.endsWith(`\t${path}\0`)) throw new Error(`selected test is not a regular file at head: ${path}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const entry: TrainGateObservation = { host, commit: input.commit, baseSha: input.baseSha, outcome: 'unmeasured', reason, changedFiles: input.changedFiles.length };
      debug.log('merge-queue', 'train-gate', entry);
      try { (deps.observe ?? defaultObserve)(entry); } catch { /* observation only */ }
      return { outcome: 'unmeasured', host, reason };
    }
  }
  if (host !== TRAIN_GATE_HOST) {
    const entry: TrainGateObservation = { host, commit: input.commit, baseSha: input.baseSha, outcome: 'unmeasured', reason: `host-not-gate-host (${host} ≠ ${TRAIN_GATE_HOST})`, changedFiles: input.changedFiles.length };
    debug.log('merge-queue', 'train-gate', entry);
    try { (deps.observe ?? defaultObserve)(entry); } catch { /* observation only */ }
    return { outcome: 'unmeasured', host, reason: entry.reason };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + settings.slotWaitSeconds * 1000;
  let outcome: RemoteRunOutcome;
  for (;;) {
    try {
      outcome = runOnRemote({
        repo: input.repo, host, mirror: settings.mirror, commit: input.commit, refs: [input.baseSha],
        argv: ['bun', 'src/self-implement/train-gate-receipt.ts', JSON.stringify({
          repo: input.repo,
          commit: input.commit,
          baseSha: input.baseSha,
          changedFiles: input.changedFiles,
          deletedFiles: input.deletedFiles ?? [],
          scenarioTests,
        })], installPwa: true, hostCap, ...(payloadFiles ? { payloadFiles } : {}),
      }, runner);
      outcome = mergeReturnedReceipts(outcome, receiptPath);
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
    : { outcome: 'unmeasured', host, reason: outcome.kind === 'busy' ? `host-busy (occupied ${outcome.occupied ?? 'unknown'}/${hostCap}, held for ${settings.slotWaitSeconds}s)` : outcome.reason };
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

export function trainGateOnHost(opts: { repo: string; baseSha: string; settings?: GateRemoteSettings; scenario?: unknown; scenarioFile?: string }, runner: GateRemoteRunner = realGateRemoteRunner, deps: TrainGateDeps = {}): TrainGate {
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
      return (await runTrainGateOnHost({ repo: opts.repo, commit: commitSha, baseSha: opts.baseSha, changedFiles, deletedFiles, settings: opts.settings, scenario: opts.scenario, scenarioFile: opts.scenarioFile }, runner, deps)).outcome;
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
