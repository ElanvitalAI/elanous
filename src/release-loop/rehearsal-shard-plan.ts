import { spawnSync } from 'node:child_process';
import { availableParallelism, cpus as hostCpus, freemem, totalmem } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectGateTestFiles } from '../self-implement/gate-cli.js';
import { readFileMemory } from '../../scripts/release-loop/shard-plan.js';
import { gateShardsPath, readGateShards } from './gate-shards.js';
import { LIGHT_RC_ALWAYS_FILE, LIGHT_RC_DEFAULT_SHARDS, parseAlwaysIncludeList, previousCutBase } from './light-rc.js';

const FILE_MEMORY_SOURCE = 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv';

export interface RehearsalShardPlan {
  shards: number;
  testFiles: number | null;
  /** Observed on the tick host, not necessarily the remote gate host. */
  resources: { cpus: number; freeBytes: number; totalBytes: number };
  gatePlanShards: number | null;
  /** Local preflight budget, not a measured remote peak-RSS or a workload-specific guarantee. */
  capacity?: { reserveBytes: number; bytesPerShard: number; memoryShards: number | null; requiredBytes: number; measuredFiles: number; peakFileBytes: number | null };
  unmeasured: string | null;
  /** The remote host's capacity is checked by the actual RC, after this preflight. */
  remoteCapacityPending?: boolean;
  rssRevisionPending?: boolean;
  planningGaps?: string[];
  remoteCapacityVerifiedBy?: string;
}

export interface RehearsalShardPlanDeps {
  /** Rehearsal light RC dispatches remotely; local CPU/memory is evidence only, not a gate-host limit. */
  remoteGate?: boolean;
  select?: (checkout: string, options: { base: string; alwaysInclude: string[]; includeImporterTests: true }) => { testFiles: string[]; alwaysIncludeMissing?: readonly string[]; lookupFailed?: string | null; unrunImporterTotal?: number | null; skipTestStep?: boolean; routeLookupFailures?: readonly unknown[]; unverified?: readonly string[]; callerTestsOverflow?: readonly unknown[] };
  resources?: () => RehearsalShardPlan['resources'];
  board?: typeof readGateShards;
  readAlways?: (path: string) => string;
  resolveBase?: (version: string, checkout: string, root: string) => string;
  fileMemory?: (path: string) => Map<string, number>;
}

/** Preflight only: the gate still performs its own selection at execution time. The local budget uses measured
 * selected-file peak RSS with a 2 GiB floor per shard and reserves 1 GiB for the host. The RC result is the
 * authority for whether execution on its actual gate host succeeded. */
const GIB = 1024 ** 3;
const RESERVE_BYTES = GIB;
const BYTES_PER_SHARD = 2 * GIB;

/** The dated TSV has no dependency graph/revision. Require the whole checkout to match its source commit;
 * otherwise RSS is provisional until a completed RC measures this actual checkout on its gate host. */
function measurementMatchesCheckout(checkout: string): boolean {
  const source = spawnSync('git', ['log', '-1', '--format=%H', '--', FILE_MEMORY_SOURCE], { cwd: checkout, encoding: 'utf8' });
  const commit = source.stdout?.trim();
  if (source.status !== 0 || !/^[0-9a-f]{40}$/.test(commit ?? '')) return false;
  const diff = spawnSync('git', ['diff', '--quiet', commit!, 'HEAD', '--', '.'], { cwd: checkout, encoding: 'utf8' });
  if (diff.status !== 0) return false;
  const working = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: checkout, encoding: 'utf8' });
  return working.status === 0 && !working.stdout?.trim();
}

/** OS free memory can describe the entire host rather than the tick's container; bound it by cgroup headroom. */
export function rehearsalHostResources(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): RehearsalShardPlan['resources'] {
  const cpus = Math.max(1, Number(availableParallelism?.() ?? hostCpus()?.length ?? 1) || 1);
  let freeBytes = freemem(), totalBytes = totalmem();
  for (const [limitPath, usagePath] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ]) {
    try {
      const limit = Number(read(limitPath).trim()), usage = Number(read(usagePath).trim());
      if (Number.isSafeInteger(limit) && limit > 0 && limit < totalBytes && Number.isSafeInteger(usage) && usage >= 0) {
        totalBytes = limit;
        freeBytes = Math.min(freeBytes, Math.max(0, limit - usage));
        break;
      }
    } catch { /* not running inside this cgroup version */ }
  }
  return { cpus, freeBytes, totalBytes };
}

export function planRehearsalShards(version: string, root: string, checkout: string, deps: RehearsalShardPlanDeps = {}): RehearsalShardPlan {
  const reasons: string[] = [];
  let rssRevisionPending = false;
  let resources: RehearsalShardPlan['resources'];
  try { resources = (deps.resources ?? rehearsalHostResources)(); }
  catch (error) {
    resources = { cpus: 0, freeBytes: 0, totalBytes: 0 };
    reasons.push(`host resource probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let gatePlanShards: number | null = null;
  try {
    const board = (deps.board ?? readGateShards)(gateShardsPath(version, root));
    gatePlanShards = board?.version === version && board.shards.length && new Set(board.shards.map(shard => shard.id)).size === board.shards.length ? board.shards.length : null;
  } catch (error) { reasons.push(`persisted gate shard plan unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  let testFiles: number | null = null;
  let measuredFiles = 0;
  let peakFileBytes: number | null = null;
  try {
    const path = join(checkout, LIGHT_RC_ALWAYS_FILE);
    const text = deps.readAlways ? deps.readAlways(path) : existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (text === undefined) throw new Error(`${LIGHT_RC_ALWAYS_FILE} missing`);
    const base = (deps.resolveBase ?? ((v, cwd, ledgerRoot) => previousCutBase(v, { cwd, ledgerRoot })))(version, checkout, root);
    const selection = (deps.select ?? ((cwd, opts) => selectGateTestFiles(cwd, opts)))(checkout, { base, alwaysInclude: parseAlwaysIncludeList(text), includeImporterTests: true });
    const files = [...new Set(selection.testFiles)];
    testFiles = files.length;
    try {
      const memory = (deps.fileMemory ?? readFileMemory)(join(checkout, FILE_MEMORY_SOURCE));
      const peaks = files.map(file => memory.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
      measuredFiles = peaks.length;
      if (peaks.length) peakFileBytes = Math.ceil(peaks.reduce((largest, value) => Math.max(largest, value), 0) * 1_000_000);
      if (measuredFiles !== testFiles) reasons.push(`selected file memory not measured: ${testFiles - measuredFiles}/${testFiles}`);
      if (!deps.fileMemory && files.length && !measurementMatchesCheckout(checkout)) {
        if (deps.remoteGate) rssRevisionPending = true;
        else reasons.push('selected file RSS measurement revision not verified against checkout');
      }
    } catch (error) { reasons.push(`selected file memory unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (selection.alwaysIncludeMissing?.length) reasons.push(`always-include missing: ${selection.alwaysIncludeMissing.join(', ')}`);
    if (selection.lookupFailed) reasons.push(`importer lookup failed: ${selection.lookupFailed}`);
    if (selection.unrunImporterTotal === undefined) reasons.push('importer coverage not reported');
    if (selection.unrunImporterTotal === null || (selection.unrunImporterTotal ?? 0) > 0) reasons.push(`importer tests not run: ${selection.unrunImporterTotal ?? 'unknown'}`);
    if (selection.routeLookupFailures?.length) reasons.push(`route lookup failed: ${selection.routeLookupFailures.length}`);
    if (selection.unverified?.length) reasons.push(`unverified scope: ${selection.unverified.length}`);
    if (selection.callerTestsOverflow?.length) reasons.push(`caller tests overflow: ${selection.callerTestsOverflow.length}`);
    if (selection.skipTestStep) reasons.push('gate test step skipped');
    if (!testFiles) reasons.push('selected test files empty');
  } catch (error) { reasons.push(`test selection unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (gatePlanShards === null) reasons.push('persisted gate shard plan unavailable');
  const cpuValid = Number.isSafeInteger(resources.cpus) && resources.cpus > 0;
  const memoryValid = Number.isFinite(resources.freeBytes) && resources.freeBytes >= 0 && Number.isFinite(resources.totalBytes) && resources.totalBytes > 0 && resources.freeBytes <= resources.totalBytes;
  if (!deps.remoteGate && (!cpuValid || !memoryValid)) reasons.push('host resources unavailable');
  const bytesPerShard = Math.max(BYTES_PER_SHARD, peakFileBytes ?? 0);
  const memoryShards = memoryValid ? Math.max(0, Math.floor((resources.freeBytes - RESERVE_BYTES) / bytesPerShard)) : null;
  const candidate = Math.max(1, Math.min(gatePlanShards ?? LIGHT_RC_DEFAULT_SHARDS, testFiles ?? LIGHT_RC_DEFAULT_SHARDS, deps.remoteGate ? Number.MAX_SAFE_INTEGER : cpuValid ? resources.cpus : LIGHT_RC_DEFAULT_SHARDS));
  if (!deps.remoteGate && peakFileBytes !== null && memoryValid && resources.freeBytes < RESERVE_BYTES + peakFileBytes) {
    reasons.push(`selected file peak exceeds host memory: peak ${peakFileBytes}, free ${resources.freeBytes}, reserve ${RESERVE_BYTES} bytes`);
  }
  // Never treat a 0-slot host as sufficient for one shard. The caller must leave an unrun step retryable.
  const shards = deps.remoteGate || memoryShards === null ? candidate : Math.max(1, Math.min(candidate, memoryShards));
  const capacity = { reserveBytes: RESERVE_BYTES, bytesPerShard, memoryShards, requiredBytes: RESERVE_BYTES + shards * bytesPerShard, measuredFiles, peakFileBytes };
  if (!deps.remoteGate && memoryShards === 0) reasons.push(`host memory insufficient: free ${resources.freeBytes} < required ${capacity.requiredBytes} bytes for 1 shard`);
  // The exported local planner has no local RC caller to validate aggregate workload capacity. A prior board's
  // shard count and individual file peaks cannot prove that hundreds of tests fit one shard.
  if (!deps.remoteGate) reasons.push('local gate shard workload sufficiency not measured');
  // A complete selected-file measurement plus the persisted shard count and a valid host budget is enough to
  // select a candidate. Execution on another host is judged by the RC result, not by a permanent preflight warning.
  const remoteCapacityReason = 'remote gate host resources unmeasured before RC';
  const rssRevisionReason = 'selected file RSS measurement revision not verified before RC';
  return { shards, testFiles, resources, gatePlanShards, capacity,
    ...(deps.remoteGate ? { remoteCapacityPending: true, rssRevisionPending, planningGaps: reasons } : {}),
    unmeasured: reasons.length || deps.remoteGate ? [...reasons, ...(rssRevisionPending ? [rssRevisionReason] : []), ...(deps.remoteGate ? [remoteCapacityReason] : [])].join('; ') : null,
  };
}
