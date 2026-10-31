import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, loadRunLedger } from './run-ledger.js';
import { projectRunChart, readRunChart, recordRunChartDecision, recordRunChartWaitHandoff, runChartMetrics, type RunChartDevice } from './run-chart.js';
import { runDoctorHandoff } from './doctor-visit.js';
import { decideNextRun, type SupervisorJobResult } from '../self-dev/run-supervisor.js';
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
  expect(runChartMetrics(loadRunLedger(runId, dir) ?? []).emptyHandoffs).toBe(0);
  expect(chart.filter((cell) => cell.verdict !== 'summary').every((cell) => cell.handoff === 'none')).toBe(true);
});

test('mock supervisor→doctor→macrophage→outer-supervisor handoff is read before each next decision and exhausted retry budget reaches a person', async () => {
  const { runId, dir } = fixture();
  const waitStopKey = `${runId}:wait-streak:1`;
  expect(recordRunChartWaitHandoff({ runId, stopKey: waitStopKey, waitCount: 3, dir, readStopKeys: [] })).toBe('recorded');

  const doctor = await runDoctorHandoff({ runId, stopKey: waitStopKey, dir,
    dispatch: (action) => ({ outcome: action === 'reauthor-from-materialized' ? 'heal-graph-requested' : 'unexpected' }) });
  expect(doctor).toMatchObject({ status: 'acted', action: 'reauthor-from-materialized' });

  const macrophageBefore = readRunChart(runId, 'macrophage', dir);
  expect(macrophageBefore.map((cell) => cell.stopKey)).toContain(waitStopKey);
  const macrophageStopKey = `${runId}:macrophage:1`;
  expect(recordRunChartDecision({ runId, dir, device: 'macrophage', stopKey: macrophageStopKey,
    observed: 'doctor reauthor handoff', verdict: 'needs-owner', action: 'route-to-supervisor', handoff: 'outer-supervisor',
    why: 'outer supervisor must consume the reauthor result', readStopKeys: macrophageBefore.map((cell) => cell.stopKey) })).toBe('recorded');

  const failed = { taskId: 'chart-reauthor-candidate', feature: 'chart-reauthor-candidate', status: 'failed', stage: 'error',
    error: { code: 'BOOM', message: 'needs human without the reauthor handoff' } } as unknown as SupervisorJobResult;
  const outerBefore = readRunChart(runId, 'outer-supervisor', dir);
  expect(outerBefore.map((cell) => cell.stopKey)).toContain(macrophageStopKey);
  const reauthorDecision = decideNextRun({ results: [failed], runChart: outerBefore });
  expect(reauthorDecision).toMatchObject({ action: 'relaunch', rerunnable: ['chart-reauthor-candidate'], needsHuman: [] });
  expect(recordRunChartDecision({ runId, dir, device: 'outer-supervisor', stopKey: `${runId}:outer:reauthor`,
    observed: 'consumed doctor reauthor', verdict: reauthorDecision.action, action: reauthorDecision.action,
    handoff: 'macrophage', why: reauthorDecision.why, readStopKeys: outerBefore.map((cell) => cell.stopKey) })).toBe('recorded');

  const budgetCandidate = { taskId: 'budget-candidate', feature: 'budget-candidate', status: 'failed', stage: 'error',
    error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
    decomposeProposal: { pieces: [{ id: 'piece-a', feature: 'bounded repair a', dependsOn: [] },
      { id: 'piece-b', feature: 'bounded repair b', dependsOn: [] }] } } as unknown as SupervisorJobResult;
  const exhausted = decideNextRun({ results: [budgetCandidate], decompositionExecution: true, limits: { maxRounds: 0 } });
  expect(exhausted).toMatchObject({ action: 'stop', stopReason: 'needs-human' });
  const beforeHuman = readRunChart(runId, 'outer-supervisor', dir);
  expect(recordRunChartDecision({ runId, dir, device: 'outer-supervisor', stopKey: `${runId}:outer:human`,
    observed: 'relaunch budget exhausted', verdict: exhausted.action, action: exhausted.stopReason ?? exhausted.action,
    handoff: 'human', why: exhausted.why, readStopKeys: beforeHuman.map((cell) => cell.stopKey) })).toBe('recorded');

  const chart = projectRunChart(runId, dir);
  expect(chart.map((cell) => cell.device)).toEqual(['run-supervisor', 'run-doctor', 'macrophage', 'outer-supervisor', 'outer-supervisor']);
  expect(chart.map((cell) => cell.handoff)).toEqual(['run-doctor', 'reauthor', 'outer-supervisor', 'macrophage', 'human']);
  expect(chart.slice(1).every((cell) => cell.readStopKeys.length > 0)).toBe(true);
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
  expect(metrics).toEqual({ emptyHandoffs: 2, unreadHandoffs: 0, conflictingVerdicts: 1 });
  expect(events).toContainEqual(['run-chart', 'metrics', expect.objectContaining(metrics)]);
});
