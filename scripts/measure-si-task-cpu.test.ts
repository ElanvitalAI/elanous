import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuMillis, measureSiTaskCpu } from './measure-si-task-cpu.js';

const dateKst = '2026-10-16';
const context = 'pool-node-b';
const namespace = 'elanous-test';
const now = new Date('2026-10-16T12:40:00Z');

function pod(name: string, created: string, phase = 'Running', finishedAt?: string) {
  return { metadata: { name, creationTimestamp: created }, status: { phase, containerStatuses: finishedAt ? [{ state: { terminated: { finishedAt } } }] : [] },
    spec: { containers: [{ resources: { requests: { cpu: '250m' } } }] } };
}
function metric(name: string, cpu: string, timestamp = '2026-10-16T12:39:00Z') {
  return { metadata: { name }, timestamp, containers: [{ usage: { cpu } }] };
}

describe('si-task CPU measurement', () => {
  test('parses Kubernetes CPU units without silently treating missing values as zero', () => {
    expect(cpuMillis('250m')).toBe(250);
    expect(cpuMillis('123456789n')).toBeCloseTo(123.456789);
    expect(cpuMillis('500000u')).toBe(500);
    expect(cpuMillis('1')).toBe(1000);
    expect(cpuMillis('')).toBeNull();
    expect(cpuMillis('oops')).toBeNull();
  });

  test('measures only same-day si-task metrics and reports missing coverage', () => {
    const names = ['si-task-a', 'si-task-b', 'si-task-c', 'si-task-d'];
    const pods = { items: [
      ...names.map((name) => pod(name, '2026-10-16T02:00:00Z')),
      pod('si-task-old', '2026-10-14T02:00:00Z', 'Succeeded', '2026-10-15T01:00:00Z'),
      pod('gate-e', '2026-10-16T02:00:00Z'),
    ] };
    const metrics = { items: [metric(names[0]!, '100m'), metric(names[1]!, '250m'), metric(names[2]!, '700m'),
      metric(names[3]!, '999m', '2026-10-15T12:39:00Z')] };
    const result = measureSiTaskCpu(pods, metrics, { dateKst, context, namespace, now });
    expect(result.podsSeenToday).toBe(4);
    expect(result.podsWithMetric).toBe(3);
    expect(result.podsWithoutMetric).toBe(1);
    expect(result.pods.find((row) => row.name === names[3])?.metricTimestamp).toBe('2026-10-15T12:39:00Z');
    expect(result.pods.find((row) => row.name === names[3])?.metricAgeSeconds).toBe(86_460);
    expect(result.cpuMillis).toEqual({ p50: 250, p95: 700, max: 700 });
    expect(result.candidates.map((row) => row.observedComparison)).toEqual(['observed-p95-above-request', 'observed-p95-above-request', 'observed-p95-within-request']);
    expect(result.candidates.every((row) => row.decision === 'stale-snapshot')).toBe(true);
  });

  test('completed Pods without retained metrics produce null percentiles and no recommendation', () => {
    const result = measureSiTaskCpu({ items: [pod('si-task-done', '2026-10-16T02:00:00Z', 'Succeeded', '2026-10-16T03:00:00Z')] },
      { items: [] }, { dateKst, context, namespace, now });
    expect(result.cpuMillis).toEqual({ p50: null, p95: null, max: null });
    expect(result.podsWithoutMetric).toBe(1);
    expect(result.candidates.every((row) => row.decision === 'unmeasured')).toBe(true);
  });

  test('omits a Pod when one of its containers has no CPU metric', () => {
    const two = pod('si-task-two', '2026-10-16T02:00:00Z');
    two.spec.containers.push({ resources: { requests: { cpu: '250m' } } });
    const result = measureSiTaskCpu({ items: [two] }, { items: [metric('si-task-two', '100m')] },
      { dateKst, context, namespace, now });
    expect(result.podsWithMetric).toBe(0);
    expect(result.podsWithoutMetric).toBe(1);
    expect(result.pods[0]?.metricTimestamp).toBe('2026-10-16T12:39:00Z');
  });

  test('marks prior-day terminal Pods without finish time as unknown overlap', () => {
    const result = measureSiTaskCpu({ items: [pod('si-task-unknown', '2026-10-15T02:00:00Z', 'Failed')] },
      { items: [] }, { dateKst, context, namespace, now });
    expect(result.podsSeenToday).toBe(0);
    expect(result.unknownOverlapPods).toBe(1);
  });

  test('keeps a Running Pod when one container terminated yesterday', () => {
    const running = pod('si-task-partial', '2026-10-15T02:00:00Z', 'Running', '2026-10-15T03:00:00Z');
    const result = measureSiTaskCpu({ items: [running] }, { items: [metric('si-task-partial', '125m')] },
      { dateKst, context, namespace, now });
    expect(result.podsSeenToday).toBe(1);
    expect(result.cpuMillis.p95).toBe(125);
  });

  test('reports an out-of-day metric as stale alongside a current metric', () => {
    const result = measureSiTaskCpu({ items: [pod('si-task-now', '2026-10-16T02:00:00Z'), pod('si-task-yesterday', '2026-10-15T02:00:00Z')] },
      { items: [metric('si-task-now', '125m'), metric('si-task-yesterday', '900m', '2026-10-15T12:39:00Z')] },
      { dateKst, context, namespace, now });
    expect(result.cpuMillis.p95).toBe(125);
    expect(result.podsWithoutMetric).toBe(1);
    expect(result.candidates.every((row) => row.decision === 'stale-snapshot')).toBe(true);
  });

  test('a fresh-in-seconds metric from before KST midnight is still stale evidence', () => {
    const result = measureSiTaskCpu({ items: [pod('si-task-midnight', '2026-10-15T12:00:00Z')] },
      { items: [metric('si-task-midnight', '100m', '2026-10-15T14:59:30Z')] },
      { dateKst, context, namespace, now: new Date('2026-10-15T15:01:00Z') });
    expect(result.cpuMillis.p95).toBeNull();
    expect(result.pods[0]?.metricAgeSeconds).toBe(90);
    expect(result.candidates.every((row) => row.decision === 'stale-snapshot')).toBe(true);
  });

  test('an old offline metric has an explicit age and cannot decide request suitability', () => {
    const result = measureSiTaskCpu({ items: [pod('si-task-old-sample', '2026-10-16T02:00:00Z')] },
      { items: [metric('si-task-old-sample', '100m', '2026-10-16T02:01:00Z')] },
      { dateKst, context: 'unknown', namespace: 'unknown', now });
    expect(result.cpuMillis.p95).toBeNull();
    expect(result.oldestMetricAgeSeconds).toBe(38_340);
    expect(result.candidates.every((row) => row.decision === 'stale-snapshot')).toBe(true);
  });

  test('an old same-day metric is visible but excluded from the current p95', () => {
    const result = measureSiTaskCpu({ items: [pod('si-task-stale-today', '2026-10-16T02:00:00Z')] },
      { items: [metric('si-task-stale-today', '900m', '2026-10-16T12:30:00Z')] },
      { dateKst, context, namespace, now });
    expect(result.cpuMillis.p95).toBeNull();
    expect(result.pods[0]?.metricTimestamp).toBe('2026-10-16T12:30:00Z');
    expect(result.candidates.every((row) => row.decision === 'stale-snapshot')).toBe(true);
  });

  test('offline JSON does not claim a default cluster source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'si-cpu-'));
    try {
      const pods = join(dir, 'pods.json');
      const metrics = join(dir, 'metrics.json');
      writeFileSync(pods, '{"items":[]}');
      writeFileSync(metrics, '{"items":[]}');
      const run = spawnSync(process.execPath, ['scripts/measure-si-task-cpu.ts', '--date', dateKst,
        '--pods-json', pods, '--metrics-json', metrics], { encoding: 'utf8', cwd: join(import.meta.dir, '..') });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ context: 'unknown', namespace: 'unknown' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
