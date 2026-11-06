import { existsSync } from 'node:fs';
import { LogStore } from '../mss/logging/log-store.js';
import { readWarmReuseStats, type WarmReuseStats } from '../task-orchestrator/surfaces/warm-reuse-stats.js';
import { resolveLogTargets } from './logs-cli.js';

export interface LogsWarmReuseStatsOpts {
  test?: boolean;
  instance?: string;
  all?: boolean;
  includeTest?: boolean;
  json?: boolean;
}

interface WarmReuseTargetResult { target: string; stats: WarmReuseStats; }

export interface LogsWarmReuseStatsDeps {
  exists: typeof existsSync;
  openReadOnly: typeof LogStore.openReadOnly;
  resolveTargets: typeof resolveLogTargets;
  write: (line: string) => void;
  writeError: (line: string) => void;
}

const DEFAULT_DEPS: LogsWarmReuseStatsDeps = {
  exists: existsSync,
  openReadOnly: LogStore.openReadOnly,
  resolveTargets: resolveLogTargets,
  write: console.log,
  writeError: console.error,
};

/** Read-only operator entry point; each store is reported separately and never opens as writable. */
export function runLogsWarmReuseStats(
  opts: LogsWarmReuseStatsOpts,
  deps: LogsWarmReuseStatsDeps = DEFAULT_DEPS,
): number {
  const resolved = deps.resolveTargets(opts);
  if (resolved.error) {
    deps.writeError(`elanous logs warm-reuse-stats: ${resolved.error}`);
    return 1;
  }
  if (resolved.targets.length === 0) {
    deps.writeError('elanous logs warm-reuse-stats: 읽을 로그 스토어가 없습니다');
    return 1;
  }
  const results: WarmReuseTargetResult[] = [];
  const unavailable: string[] = [];
  for (const target of resolved.targets) {
    if (!deps.exists(target.dbPath)) {
      unavailable.push(`${target.name}: store missing`);
      continue;
    }
    let store: ReturnType<typeof LogStore.openReadOnly> | undefined;
    try {
      store = deps.openReadOnly(target.dbPath);
      results.push({ target: target.name, stats: readWarmReuseStats(store) });
    } catch (error) {
      unavailable.push(`${target.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { store?.close(); }
  }
  if (opts.json) deps.write(JSON.stringify({ type: 'pod-reuse-stats', complete: unavailable.length === 0,
    results, unavailable }));
  else {
    for (const result of results) {
      const s = result.stats;
      deps.write(`${result.target}: leases=${s.observedLeases} returned=${s.returned} quarantined=${s.quarantined}`
        + ` unresolved=${s.unresolved} cleanupFailed=${s.cleanupFailureLeases}`
        + ` quarantineFailed=${s.quarantineFailureLeases} unidentifiable=${s.unidentifiableEvents}`);
      for (const [reason, count] of Object.entries(s.quarantineReasons)) deps.write(`  quarantine ${reason}: ${count}`);
    }
    for (const reason of unavailable) deps.writeError(`미측정 ${reason}`);
    if (results.every(result => result.stats.observedLeases === 0) && unavailable.length === 0)
      deps.write('관측된 SI child lease 없음 (0건은 성공 증거가 아님)');
  }
  return unavailable.length > 0 ? 2 : 0;
}
