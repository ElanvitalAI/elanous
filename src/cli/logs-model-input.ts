import { existsSync } from 'node:fs';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { LogStore } from '../mss/logging/log-store.js';
import type { ModelInputObservation } from '../harness/model-input-observation.js';
import { collectDegenerateRows } from './logs-degenerate.js';
import { parseSince, resolveLogTargets } from './logs-cli.js';

const DAY_MS = 86_400_000;
const CATEGORY = 'harness.model-input';
const EVENT = 'recorded';

type Baseline = { scope: ModelInputObservation['scope']; nodeKind: string; measured: number; unmeasured: number; median: number | null; p90: number | null };
export interface ModelInputReport {
  since: string;
  until: string;
  stores: string[];
  records: number;
  baselines: Baseline[];
}
export interface LogsModelInputOpts {
  since?: string;
  json?: boolean;
  test?: boolean;
  instance?: string;
  all?: boolean;
  includeTest?: boolean;
}
export interface LogsModelInputDeps {
  exists: typeof existsSync;
  openReadOnly: typeof LogStore.openReadOnly;
  resolveTargets: typeof resolveLogTargets;
  now: () => number;
  write: (line: string) => void;
  writeError: (line: string) => void;
}
const DEFAULT_DEPS: LogsModelInputDeps = {
  exists: existsSync, openReadOnly: LogStore.openReadOnly, resolveTargets: resolveLogTargets,
  now: Date.now, write: console.log, writeError: console.error,
};

/** Only observations with a known state enter the baseline; unavailable usage is not zero. */
export function summarizeModelInput(rows: readonly LogStoreRow[], since: string, until: string, stores: string[]): ModelInputReport {
  const groups = new Map<string, { scope: Baseline['scope']; nodeKind: string; values: number[]; unmeasured: number }>();
  let records = 0;
  for (const row of rows) {
    if (row.category !== CATEGORY || row.event !== EVENT || !row.data) continue;
    let data: unknown;
    try { data = JSON.parse(row.data); } catch { continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const observation = data as Partial<ModelInputObservation>;
    if ((observation.scope !== 'harness-node' && observation.scope !== 'loop-tick')
      || typeof observation.nodeKind !== 'string' || !observation.nodeKind.trim()) continue;
    const measured = observation.status === 'measured'
      && typeof observation.inputTokens === 'number'
      && Number.isSafeInteger(observation.inputTokens) && observation.inputTokens >= 0;
    const unmeasured = observation.status === 'unmeasured' && observation.inputTokens === null;
    if (!measured && !unmeasured) continue;
    const key = JSON.stringify([observation.scope, observation.nodeKind]);
    const group = groups.get(key) ?? { scope: observation.scope, nodeKind: observation.nodeKind, values: [], unmeasured: 0 };
    if (measured) group.values.push(observation.inputTokens as number);
    else group.unmeasured += 1;
    groups.set(key, group);
    records += 1;
  }
  const baselines = [...groups.values()].map(({ scope, nodeKind, values, unmeasured }): Baseline => {
    values.sort((a, b) => a - b);
    const n = values.length;
    return {
      scope, nodeKind, measured: n, unmeasured,
      median: n === 0 ? null : n % 2 === 1 ? values[Math.floor(n / 2)]! : (values[n / 2 - 1]! + values[n / 2]!) / 2,
      p90: n === 0 ? null : values[Math.ceil(n * 0.9) - 1]!,
    };
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.nodeKind.localeCompare(b.nodeKind));
  return { since, until, stores, records, baselines };
}

export function renderModelInput(report: ModelInputReport): string {
  return [
    `model input tokens · ${report.since} ~ ${report.until} · stores=${report.stores.join(', ') || '(없음)'} · records=${report.records}`,
    'scope\tnodeKind\tmeasured\tmedian\tp90\t못 잼',
    ...(report.baselines.length === 0 ? ['(관측 표본 없음)'] : report.baselines.map((item) =>
      `${item.scope}\t${item.nodeKind}\t${item.measured}\t${item.median ?? '못 잼'}\t${item.p90 ?? '못 잼'}\t${item.unmeasured}`)),
  ].join('\n');
}

/** Read the entire bounded time window rather than just the newest default page. */
export function runLogsModelInput(opts: LogsModelInputOpts, deps: LogsModelInputDeps = DEFAULT_DEPS): number {
  const untilMs = deps.now();
  const relative = opts.since === undefined ? null : /^(\d+)(s|m|h|d)$/.exec(opts.since.trim());
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: DAY_MS };
  const sinceMs = opts.since === undefined ? untilMs - 3 * DAY_MS
    : relative ? untilMs - Number(relative[1]) * unitMs[relative[2] as keyof typeof unitMs]
      : parseSince(opts.since);
  if (sinceMs === null || !Number.isFinite(sinceMs) || sinceMs > untilMs) {
    deps.writeError('elanous logs model-input: --since 파싱 불가 또는 미래 시각 (예: 3d, ISO)');
    return 1;
  }
  const resolved = deps.resolveTargets({ test: opts.test, instance: opts.instance, all: opts.all, includeTest: opts.includeTest });
  if (resolved.error) { deps.writeError(`elanous logs model-input: ${resolved.error}`); return 1; }
  const rows: LogStoreRow[] = [];
  const stores: string[] = [];
  // Without a stable observation ID, equal timestamps and payloads in different
  // stores may belong to distinct executions. Count every stored record.
  for (const target of resolved.targets) {
    if (!deps.exists(target.dbPath)) {
      deps.writeError(`elanous logs model-input: 로그 스토어 없음: ${target.name} (${target.dbPath})`);
      return 1;
    }
    let store: LogStore;
    try { store = deps.openReadOnly(target.dbPath); }
    catch (error) {
      deps.writeError(`elanous logs model-input: ${target.name} 열기 실패: ${String(error)}`);
      return 1;
    }
    try {
      const scan = collectDegenerateRows(store, { exactCategories: [CATEGORY], events: [EVENT], sinceMs, untilMs });
      if (scan.truncated) {
        deps.writeError(`elanous logs model-input: ${target.name} 스캔 상한 도달 — --since 창을 좁혀라`);
        return 1;
      }
      stores.push(target.name);
      rows.push(...scan.rows);
    } catch (error) {
      deps.writeError(`elanous logs model-input: ${target.name} 조회 실패: ${String(error)}`);
      return 1;
    } finally { store.close(); }
  }
  const report = summarizeModelInput(rows, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString(), stores);
  deps.write(opts.json ? JSON.stringify(report) : renderModelInput(report));
  return 0;
}
