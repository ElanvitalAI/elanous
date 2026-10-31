import { debug } from '../debug/log.js';
import { appendRunLedgerEntryChecked, loadRunLedger, type RunLedgerEntry } from './run-ledger.js';

export const RUN_DOCTOR_HANDOFF_WAIT_THRESHOLD = 3;
export const RUN_DOCTOR_HANDOFF_INPUT_PREFIX = '[run-chart handoff=doctor]';
export const RUN_CHART_MAX_CELLS = 20;
export const RUN_CHART_READ_CELLS = 5;
export type RunChartDevice = 'run-supervisor' | 'macrophage' | 'run-doctor' | 'outer-supervisor';
export interface RunChartCell {
  runId: string; device: RunChartDevice | 'summary'; stopKey: string; observed: string; verdict: string; action: string;
  handoff: string | null; why: string; readStopKeys: string[]; waitCount?: number; failureClass?: string;
}
export interface RunChartDecision extends Omit<RunChartCell, 'device'> { device: RunChartDevice; dir: string }
export type RunChartWriteResult = 'recorded' | 'already-recorded' | 'conflicting-verdict' | 'missing-ledger' | 'ledger-write-refused';

function chartEvents(entries: readonly RunLedgerEntry[]): RunLedgerEntry[] {
  const all = entries.filter((e) => e.event === 'run-chart-cell');
  const compactedAt = all.reduce((last, entry, index) => entry.data.compacted ? index : last, -1);
  if (compactedAt < 0) return all;
  const compacted = all[compactedAt]!;
  const summaryData = compacted.data.compacted as Record<string, unknown>;
  const cutoff = typeof summaryData.lastStopKey === 'string' ? summaryData.lastStopKey : '';
  const cutoffDevice = typeof summaryData.lastDevice === 'string' ? summaryData.lastDevice : '';
  const cutoffAt = all.findIndex((e) => e.data.device === cutoffDevice && e.data.stopKey === cutoff);
  const summary: RunLedgerEntry = { ...compacted, data: { device: 'summary', stopKey: `summary:${String(compacted.data.stopKey)}`,
    observed: `${String(summaryData.count)} earlier chart cells folded`, verdict: 'summary',
    action: 'compact', handoff: null, why: String(summaryData.verdicts ?? ''), readStopKeys: [] } };
  return [summary, ...all.slice(cutoffAt >= 0 ? cutoffAt + 1 : compactedAt)];
}

function toChartCell(runId: string, e: RunLedgerEntry): RunChartCell {
  return {
    runId, device: e.data.device as RunChartDevice | 'summary', stopKey: String(e.data.stopKey ?? ''),
    observed: String(e.data.observed ?? ''), verdict: String(e.data.verdict ?? ''), action: String(e.data.action ?? ''),
    handoff: typeof e.data.handoff === 'string' ? e.data.handoff : null, why: String(e.data.why ?? ''),
    readStopKeys: Array.isArray(e.data.readStopKeys) ? e.data.readStopKeys.filter((x): x is string => typeof x === 'string') : [],
    ...(typeof e.data.waitCount === 'number' ? { waitCount: e.data.waitCount } : {}),
    ...(typeof e.data.failureClass === 'string' ? { failureClass: e.data.failureClass } : {}),
  };
}

export function projectRunChart(runId: string, dir: string): RunChartCell[] {
  return chartEvents(loadRunLedger(runId, dir) ?? []).map((entry) => toChartCell(runId, entry));
}

export function readRunChart(runId: string, device: RunChartDevice, dir: string): RunChartCell[] {
  const entries = loadRunLedger(runId, dir) ?? [];
  const cells = chartEvents(entries).slice(-RUN_CHART_READ_CELLS).map((e) => toChartCell(runId, e));
  const metrics = runChartMetrics(entries);
  try { debug.log('run-chart', 'read', { runId, device, count: cells.length, stopKeys: cells.map((c) => c.stopKey) });
    debug.log('run-chart', 'metrics', { runId, ...metrics }); } catch { /* observation is fail-soft */ }
  return cells;
}

export function runChartMetrics(entries: readonly RunLedgerEntry[]): { emptyHandoffs: number; unreadHandoffs: number; conflictingVerdicts: number } {
  const cells = entries.filter((e) => e.event === 'run-chart-cell');
  const emptyHandoffs = cells.filter((e) => !String(e.data.handoff ?? '').trim()).length;
  const unreadHandoffs = cells.filter((e) => {
    const handoff = String(e.data.handoff ?? '').trim().toLowerCase();
    return handoff !== '' && handoff !== 'none'
      && !cells.some((next) => next.data.readStopKeys instanceof Array && next.data.readStopKeys.includes(String(e.data.stopKey)));
  }).length;
  const verdicts = new Map<string, Set<string>>();
  for (const cell of cells) {
    const key = `${String(cell.data.device)}\0${String(cell.data.stopKey)}`;
    const values = verdicts.get(key) ?? new Set<string>(); values.add(String(cell.data.verdict)); verdicts.set(key, values);
  }
  const conflictingVerdicts = [...verdicts.values()].filter((values) => values.size > 1).length;
  return { emptyHandoffs, unreadHandoffs, conflictingVerdicts };
}

export function recordRunChartDecision(input: RunChartDecision): RunChartWriteResult {
  const result = appendRunLedgerEntryChecked(input.runId, (entries) => {
    if (entries === null) return { append: false, result: 'missing-ledger' as const };
    const existing = entries.find((entry) => entry.event === 'run-chart-cell'
      && entry.data.device === input.device && entry.data.stopKey === input.stopKey);
    if (existing) return { append: false, result: existing.data.verdict === input.verdict
      ? 'already-recorded' as const : 'conflicting-verdict' as const };
    const current = chartEvents(entries);
    const overflow = current.length >= RUN_CHART_MAX_CELLS;
    const foldCount = overflow ? current.length - (RUN_CHART_MAX_CELLS - 2) : 0;
    const toFold = current.slice(0, foldCount);
    const append: RunLedgerEntry[] = [];
    if (toFold.length) {
      const foldedCells = toFold.filter((e) => e.data.verdict !== 'summary');
      const priorSummary = toFold.find((e) => e.data.verdict === 'summary');
      const priorCount = Number(String(priorSummary?.data.observed ?? '').match(/^\d+/)?.[0] ?? 0);
      const count = priorCount + foldedCells.length;
      const lastFolded = foldedCells.at(-1);
      append.push({ timestamp: new Date().toISOString(), runId: input.runId, event: 'run-chart-summary',
        data: { count, firstStopKey: toFold[0]?.data.stopKey, lastStopKey: lastFolded?.data.stopKey,
          verdicts: toFold.map((e) => `${String(e.data.device)}:${String(e.data.verdict)}`).join('; ').slice(0, 500) } });
    }
    append.push({ timestamp: new Date().toISOString(), runId: input.runId, event: 'run-chart-cell', data: {
      device: input.device, stopKey: input.stopKey, observed: input.observed.slice(0, 240), verdict: input.verdict,
      action: input.action, handoff: input.handoff ?? 'none', why: input.why.slice(0, 240), readStopKeys: input.readStopKeys.slice(-RUN_CHART_READ_CELLS),
      ...(input.waitCount === undefined ? {} : { waitCount: input.waitCount }),
      ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    } });
    // appendRunLedgerEntryChecked writes one row. Store summary with the decision row as a compact payload.
    return { append: true, entry: append.length === 1 ? append[0]! : { ...append[1]!, data: { ...append[1]!.data,
      compacted: { count: append[0]!.data.count, firstStopKey: append[0]!.data.firstStopKey,
        lastStopKey: append[0]!.data.lastStopKey, lastDevice: toFold.filter((e) => e.data.verdict !== 'summary').at(-1)?.data.device,
        verdicts: append[0]!.data.verdicts } } } };
  }, input.dir);
  const status = result.appended ? 'recorded' : result.result ?? 'ledger-write-refused';
  if (status === 'recorded') {
    try { debug.log('run-chart', 'decision', { runId: input.runId, device: input.device, stopKey: input.stopKey,
      handoff: input.handoff, why: input.why.slice(0, 120) }); } catch { /* observation is fail-soft */ }
  }
  return status;
}

export interface RunChartWaitHandoff { runId: string; stopKey: string; waitCount: number; dir: string; readStopKeys?: string[] }
export type RunChartWaitHandoffResult = RunChartWriteResult;
export function recordRunChartWaitHandoff(input: RunChartWaitHandoff): RunChartWaitHandoffResult {
  const readStopKeys = input.readStopKeys ?? readRunChart(input.runId, 'run-supervisor', input.dir).map((cell) => cell.stopKey);
  return recordRunChartDecision({ runId: input.runId, device: 'run-supervisor', stopKey: input.stopKey,
    observed: `consecutive wait decisions=${input.waitCount}`, verdict: 'wait', action: 'wait', handoff: 'run-doctor',
    why: 'wait streak reached run doctor handoff threshold', readStopKeys,
    waitCount: input.waitCount, failureClass: 'implement-aborted', dir: input.dir });
}
