import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, loadRunLedger } from './run-ledger.js';
import { projectRunChart, readRunChart, recordRunChartDecision, runChartMetrics, type RunChartDevice } from './run-chart.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): { runId: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'run-chart-')); roots.push(dir);
  const runId = 'shared-chart-run';
  appendRunLedgerEntry({ runId, event: 'start', data: {} }, dir);
  return { runId, dir };
}
function decide(runId: string, dir: string, device: RunChartDevice, stopKey: string, readStopKeys: string[], handoff: string | null = null, verdict = 'continue') {
  return recordRunChartDecision({ runId, dir, device, stopKey, readStopKeys, handoff,
    observed: `${device} saw previous ${readStopKeys.length}`, verdict, action: 'inspect', why: `${device} judgment` });
}

test('same run chart is pulled and appended by all four devices in judgment order', () => {
  const { runId, dir } = fixture();
  const devices: RunChartDevice[] = ['run-supervisor', 'macrophage', 'run-doctor', 'outer-supervisor'];
  const readCounts: number[] = [];
  for (const device of devices) {
    const prior = readRunChart(runId, device, dir);
    readCounts.push(prior.length);
    expect(decide(runId, dir, device, `${runId}:shared-stop`, prior.map((cell) => cell.stopKey))).toBe('recorded');
  }
  expect(readCounts).toEqual([0, 1, 2, 3]);
  expect(readRunChart(runId, 'run-doctor', dir).map((cell) => cell.device)).toEqual(devices);
  expect(decide(runId, dir, 'run-supervisor', `${runId}:shared-stop`, [])).toBe('already-recorded');
  expect(decide(runId, dir, 'run-supervisor', `${runId}:shared-stop`, [], 'human', 'stop')).toBe('conflicting-verdict');
  for (let i = 0; i < 24; i += 1) {
    const before = readRunChart(runId, 'outer-supervisor', dir);
    expect(decide(runId, dir, 'outer-supervisor', `${runId}:budget:${i}`, before.map((cell) => cell.stopKey))).toBe('recorded');
    expect(projectRunChart(runId, dir).length).toBeLessThanOrEqual(20);
  }
  const chart = projectRunChart(runId, dir);
  expect(chart.length).toBeLessThanOrEqual(20);
  expect(chart[0]?.verdict).toBe('summary');
  expect(readRunChart(runId, 'run-doctor', dir)).toHaveLength(5);
  expect(runChartMetrics(loadRunLedger(runId, dir) ?? []).emptyHandoffs).toBeGreaterThan(0);
});

test('run-chart debug metrics count unread handoffs and conflicting verdicts and emit all three degeneration fields', () => {
  const { runId, dir } = fixture();
  const handoffKey = `${runId}:handoff`;
  expect(recordRunChartDecision({ runId, dir, device: 'run-supervisor', stopKey: handoffKey,
    observed: 'stalled', verdict: 'wait', action: 'wait', handoff: 'run-doctor', why: 'stalled', readStopKeys: [] })).toBe('recorded');
  expect(recordRunChartDecision({ runId, dir, device: 'run-doctor', stopKey: `${runId}:doctor`,
    observed: 'read handoff', verdict: 'acted', action: 'reauthor', handoff: null, why: 'accepted', readStopKeys: [handoffKey] })).toBe('recorded');
  appendRunLedgerEntry({ runId, event: 'run-chart-cell', data: { device: 'macrophage', stopKey: `${runId}:conflict`,
    verdict: 'retry', handoff: null, readStopKeys: [] } }, dir);
  appendRunLedgerEntry({ runId, event: 'run-chart-cell', data: { device: 'macrophage', stopKey: `${runId}:conflict`,
    verdict: 'stop', handoff: null, readStopKeys: [] } }, dir);
  const events: unknown[][] = [];
  const log = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { events.push(args); }) as never);
  try {
    readRunChart(runId, 'outer-supervisor', dir);
  } finally { log.mockRestore(); }
  const metrics = runChartMetrics(loadRunLedger(runId, dir) ?? []);
  expect(metrics).toEqual({ emptyHandoffs: 3, unreadHandoffs: 0, conflictingVerdicts: 1 });
  expect(events).toContainEqual(['run-chart', 'metrics', expect.objectContaining(metrics)]);
});
