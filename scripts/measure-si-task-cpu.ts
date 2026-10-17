#!/usr/bin/env bun
/** Read-only, point-in-time CPU measurement of si-task Pods. No Jobs or Pods are created. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

type Pod = {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: { phase?: string; containerStatuses?: Array<{ state?: { terminated?: { finishedAt?: string } } }> };
  spec?: { containers?: Array<{ name?: string; resources?: { requests?: { cpu?: string } } }> };
};
type PodMetric = { metadata?: { name?: string }; timestamp?: string; containers?: Array<{ name?: string; usage?: { cpu?: string } }> };
type KubeList<T> = { items?: T[] };

export type CpuObservation = {
  dateKst: string;
  context: string;
  namespace: string;
  measuredAt: string;
  coverage: 'point-in-time-current-pods-only';
  podsSeenToday: number;
  unknownOverlapPods: number;
  podsWithMetric: number;
  podsWithoutMetric: number;
  oldestMetricAgeSeconds: number | null;
  cpuMillis: { p50: number | null; p95: number | null; max: number | null };
  candidates: Array<{ request: string; requestMillis: number; p95OfRequest: number | null; observedComparison: string; decision: string }>;
  pods: Array<{ name: string; phase: string; requestMillis: number | null; usageMillis: number | null; metricTimestamp: string | null; metricAgeSeconds: number | null }>;
};

/** Kubernetes CPU quantity to millicores; null means unusable evidence. */
export function cpuMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(value);
  if (!match) return null;
  const factor = match[2] === 'n' ? 0.000001 : match[2] === 'u' ? 0.001 : match[2] === 'm' ? 1 : 1000;
  const result = Number(match[1]) * factor;
  return Number.isFinite(result) ? result : null;
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1]! * 100) / 100;
}

export function measureSiTaskCpu(
  pods: KubeList<Pod>, metrics: KubeList<PodMetric>,
  options: { dateKst: string; context: string; namespace: string; now?: Date },
): CpuObservation {
  const start = Date.parse(`${options.dateKst}T00:00:00+09:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.dateKst) || !Number.isFinite(start)
    || new Date(start + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) !== options.dateKst)
    throw new Error(`invalid KST date: ${options.dateKst}`);
  const end = start + 24 * 60 * 60 * 1000;
  const now = options.now ?? new Date();
  const byName = new Map((metrics.items ?? []).map((metric) => [metric.metadata?.name, metric]));
  let unknownOverlapPods = 0;
  const rows = (pods.items ?? []).filter((pod) => {
    const name = pod.metadata?.name ?? '';
    const created = Date.parse(pod.metadata?.creationTimestamp ?? '');
    const finished = pod.status?.containerStatuses?.map((item) => Date.parse(item.state?.terminated?.finishedAt ?? ''))
      .filter(Number.isFinite).sort((a, b) => b - a)[0];
    const terminal = ['Succeeded', 'Failed'].includes(pod.status?.phase ?? '');
    if (!name.startsWith('si-task-') || !Number.isFinite(created) || created >= end) return false;
    if (created < start && terminal && finished === undefined) {
      unknownOverlapPods++;
      return false;
    }
    return !terminal || finished === undefined || finished >= start;
  }).map((pod) => {
    const name = pod.metadata!.name!;
    const metric = byName.get(name);
    const timestamp = Date.parse(metric?.timestamp ?? '');
    const values = metric?.containers?.map((item) => cpuMillis(item.usage?.cpu)) ?? [];
    const expected = pod.spec?.containers ?? [];
    const namesMatch = expected.every((container) => !container.name || metric?.containers?.some((item) => item.name === container.name));
    const containersComplete = expected.length > 0 && values.length === expected.length && namesMatch;
    // Missing any container value is missing Pod usage, not a zero.
    const ageSeconds = Math.round((now.getTime() - timestamp) / 1000);
    const usageMillis = Number.isFinite(timestamp) && timestamp >= start && timestamp < end
      && ageSeconds >= -120 && ageSeconds <= 120
      && containersComplete && values.every((value) => value !== null)
      ? Math.round((values as number[]).reduce((sum, value) => sum + value, 0) * 100) / 100 : null;
    const requests = pod.spec?.containers?.map((item) => cpuMillis(item.resources?.requests?.cpu)) ?? [];
    return {
      name, phase: pod.status?.phase ?? 'Unknown',
      requestMillis: requests.length > 0 && requests.every((value) => value !== null)
        ? Math.round((requests as number[]).reduce((sum, value) => sum + value, 0) * 100) / 100 : null,
      usageMillis, metricTimestamp: Number.isFinite(timestamp) ? metric!.timestamp! : null,
      metricAgeSeconds: Number.isFinite(timestamp) ? ageSeconds : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const measured = rows.flatMap((row) => row.usageMillis === null ? [] : [row.usageMillis]).sort((a, b) => a - b);
  const ages = rows.flatMap((row) => row.metricAgeSeconds === null ? [] : [row.metricAgeSeconds]);
  const oldestMetricAgeSeconds = ages.length ? Math.max(...ages) : null;
  const stale = rows.some((row) => row.metricTimestamp !== null && row.metricAgeSeconds !== null
    && (Date.parse(row.metricTimestamp) < start || Date.parse(row.metricTimestamp) >= end
      || row.metricAgeSeconds < -120 || row.metricAgeSeconds > 120));
  const p95 = percentile(measured, 0.95);
  const candidates = [250, 500, 1000].map((requestMillis) => ({
    request: requestMillis === 1000 ? '1' : `${requestMillis}m`, requestMillis,
    p95OfRequest: p95 === null ? null : Math.round(p95 / requestMillis * 1000) / 10,
    observedComparison: p95 === null ? 'unmeasured' : p95 <= requestMillis ? 'observed-p95-within-request' : 'observed-p95-above-request',
    // A single metrics-server snapshot cannot justify a request change, even with full current-Pod coverage.
    decision: stale ? 'stale-snapshot' : p95 === null ? 'unmeasured'
      : measured.length < rows.length || unknownOverlapPods > 0 ? 'incomplete-coverage' : 'needs-time-series',
  }));
  return {
    dateKst: options.dateKst, context: options.context, namespace: options.namespace,
    measuredAt: now.toISOString(), coverage: 'point-in-time-current-pods-only',
    podsSeenToday: rows.length, unknownOverlapPods, podsWithMetric: measured.length, podsWithoutMetric: rows.length - measured.length,
    oldestMetricAgeSeconds,
    cpuMillis: { p50: percentile(measured, 0.5), p95, max: measured.at(-1) ?? null }, candidates, pods: rows,
  };
}

function kubectl(args: string[]): unknown {
  const result = spawnSync('kubectl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`kubectl ${args.at(-1)} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return JSON.parse(result.stdout);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const usage = 'Usage: bun scripts/measure-si-task-cpu.ts [--context pool-node-b] [--namespace elanous-test] [--date YYYY-MM-DD] [--pods-json FILE --metrics-json FILE]';
  const known = new Set(['--context', '--namespace', '--date', '--pods-json', '--metrics-json']);
  if (args.includes('--help')) { console.log(usage); process.exit(0); }
  if (args.some((arg, index) => index % 2 === 0 ? !known.has(arg) : arg.startsWith('--')) || args.length % 2) throw new Error(usage);
  const podsPath = option('--pods-json');
  const metricsPath = option('--metrics-json');
  const offline = Boolean(podsPath || metricsPath);
  const context = option('--context') ?? (offline ? 'unknown' : 'pool-node-b');
  const namespace = option('--namespace') ?? (offline ? 'unknown' : 'elanous-test');
  const dateKst = option('--date') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (Boolean(podsPath) !== Boolean(metricsPath)) throw new Error('both --pods-json and --metrics-json are required for offline input');
  const pods = podsPath ? JSON.parse(readFileSync(podsPath, 'utf8')) : kubectl(['--context', context, '-n', namespace, 'get', 'pods', '-o', 'json']);
  const metrics = metricsPath ? JSON.parse(readFileSync(metricsPath, 'utf8'))
    : kubectl(['--context', context, 'get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`]);
  console.log(JSON.stringify(measureSiTaskCpu(pods, metrics, { dateKst, context, namespace }), null, 2));
}
