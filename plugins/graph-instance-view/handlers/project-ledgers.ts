import { existsSync, readFileSync } from 'node:fs';
import { cpus, freemem, homedir, hostname, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseGraphTemplateYaml } from '../../../src/self-implement/graph-yaml.js';
import { listGraphRuns, type GraphRunState } from '../../../src/graph-runner/runner.js';
import { loadRunLedger, type RunLedgerEntry } from '../../../src/self-implement/run-ledger.js';
import { runLedgerDir } from '../../../src/self-implement/run-ledger-paths.js';
import { readResourceLedger, resourceLedgerPath, type ResourceLedgerEvent } from '../../../src/resource-ledger/resource-ledger.js';
import { defaultResourceHosts } from '../../../src/cli/resource-ledger-cli.js';
import { elanousStateRoot } from '../../../src/autopilot/state-paths.js';
import type { CloudVmHost } from '../../../src/release-loop/cloud-vm-adapter.js';
import { releaseRehearsalConfig } from '../../../scripts/release-loop/unattended-release.js';
import type { GraphInstanceView } from './view-model.js';
import { graphInstanceViewIssues } from '../../../scripts/validate-graph-instance-view.js';

export type ViewSource = GraphInstanceView['instance']['source'];
export interface ViewQuery { source: ViewSource; runId?: string; graphId?: string }
export interface ViewLedgers {
  graphRuns(): readonly GraphRunState[];
  harness(runId: string): readonly RunLedgerEntry[] | null;
  resources(): readonly ResourceLedgerEvent[];
  hosts(): readonly string[];
  localHost?(): string;
  localMetrics?(): { cpuCores: number; loadavg: readonly [number, number, number]; memory: { usedBytes: number; totalBytes: number } };
  cloudStates?(): Readonly<Record<string, 'on' | 'off' | 'stopped' | 'unknown'>>;
  now(): string;
}

const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const safeText = (value: unknown): string => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[path]').slice(0, 120);
const stateForGraph = (status: GraphRunState['status']): GraphInstanceView['instance']['state'] =>
  status === 'done' ? 'done' : status === 'failed' || status === 'budget-exceeded' ? 'failed'
    : status === 'awaiting-approval' || status === 'paused' ? 'waiting' : status === 'running' ? 'running' : 'unknown';

export function projectGraphRun(run: GraphRunState, source: 'graph' | 'release', observedAt: string): GraphInstanceView {
  const template = run.graphPath && existsSync(run.graphPath)
    ? parseGraphTemplateYaml(readFileSync(run.graphPath, 'utf8'), run.graphPath).template : undefined;
  const ids = [...new Set([...(template?.nodes.map(node => node.nodeId) ?? []), ...run.path,
    ...run.nodes.map(node => node.nodeId), run.currentNode?.nodeId, run.pending?.nodeId].filter((id): id is string => !!id))];
  const records = new Map(run.nodes.map(node => [node.nodeId, node]));
  const nodes: GraphInstanceView['nodes'] = ids.map(id => ({ id, label: id,
    state: run.currentNode?.nodeId === id ? 'running' : run.pending?.nodeId === id ? 'waiting'
      : records.has(id) ? records.get(id)!.ok ? 'done' : 'failed' : 'queued' }));
  const transitions = new Set(run.path.slice(1).map((to, index) => `${run.path[index]}\0${to}`));
  const edges: GraphInstanceView['edges'] = template
    ? template.edges.flatMap((edge, index) => {
      const targets = [edge.to, ...Object.values(edge.map ?? {}), ...Object.values(edge.branches ?? {}).flat(), edge.join]
        .filter((to): to is string => !!to && ids.includes(to));
      return targets.map((to, targetIndex) => ({ id: `${index}-${targetIndex}`, from: edge.from, to,
        kind: edge.join === to ? 'join' as const : targets.length > 1 ? 'branch' as const : 'flow' as const,
        state: transitions.has(`${edge.from}\0${to}`) ? 'taken' as const : 'planned' as const }));
    }).filter(edge => ids.includes(edge.from))
    : run.path.slice(1).map((to, index) => ({ id: `path-${index}`, from: run.path[index]!, to,
      kind: 'flow' as const, state: 'taken' as const }));
  const active = nodes.filter(node => node.state === 'running' || node.state === 'waiting').map(node => node.id);
  const logs: GraphInstanceView['logs'] = run.nodes.slice(-20).map((node, index) => ({ seq: index + 1,
    ...(node.endedAt ? { at: node.endedAt } : {}), nodeId: node.nodeId,
    level: node.ok ? 'info' : 'error', text: `${safeText(node.nodeId)} ${node.ok ? '완료' : '실패'}` }));
  return { schemaVersion: 1, instance: { source, runId: run.runId, graphId: run.graphId,
    title: template?.loop?.title ?? run.graphId, observedAt, state: stateForGraph(run.status) },
    nodes, edges, progress: { completed: nodes.filter(node => node.state === 'done').length, total: nodes.length, activeNodeIds: active },
    logs, statusLine: `${safeText(run.runId)} · ${safeText(run.status)}`, readState: template ? 'ok' : 'partial' };
}

export function projectHarnessRun(runId: string, entries: readonly RunLedgerEntry[], observedAt: string): GraphInstanceView {
  const ids: string[] = [];
  const states = new Map<string, GraphInstanceView['nodes'][number]['state']>();
  for (const entry of entries) {
    const id = typeof entry.data.nodeId === 'string' ? entry.data.nodeId : typeof entry.data.node === 'string' ? entry.data.node : undefined;
    if (!id || !safeId(id)) continue;
    if (!states.has(id)) ids.push(id);
    states.set(id, /(?:fail|error)/i.test(entry.event) ? 'failed' : /(?:exit|complete|done)/i.test(entry.event) ? 'done' : 'running');
  }
  const nodes = ids.map(id => ({ id, label: id, state: states.get(id)! }));
  const edges = ids.slice(1).map((to, index) => ({ id: `step-${index}`, from: ids[index]!, to, kind: 'flow' as const, state: 'taken' as const }));
  const logs = entries.slice(-20).map((entry, index) => ({ seq: index + 1,
    ...(entry.timestamp ? { at: entry.timestamp } : {}), level: /(?:fail|error)/i.test(entry.event) ? 'error' as const : 'info' as const,
    text: safeText(entry.event) }));
  const last = entries.at(-1)?.event ?? '';
  const state = /(?:fail|error)/i.test(last) ? 'failed' : /(?:complete|done|succeed)/i.test(last) ? 'done'
    : /(?:wait|approval|review)/i.test(last) ? 'waiting' : entries.length ? 'running' : 'unknown';
  return { schemaVersion: 1, instance: { source: 'harness', runId, title: `Harness ${runId}`, observedAt, state },
    nodes, edges, progress: { completed: nodes.filter(node => node.state === 'done').length, total: nodes.length || null,
      activeNodeIds: nodes.filter(node => node.state === 'running').map(node => node.id) },
    logs, statusLine: `${runId} · ${state}`, readState: ids.length ? 'ok' : 'partial' };
}

const fleet = ['mbp', 'node-b', 'node-c', 'minim5', 'mshq', 'aws1', 'aws2', 'gcp1', 'gcp2', 'azure'];
const taskKind = (lane: string): 'gate' | 'train' | 'pod' | 'seat' => lane === 'gate' ? 'gate' : lane === 'train' ? 'train' : lane === 'ta' ? 'seat' : 'pod';
export function projectResources(events: readonly ResourceLedgerEvent[], hosts: readonly string[], observedAt: string,
  local?: { host: string; cpuCores: number; loadavg: readonly [number, number, number]; memory: { usedBytes: number; totalBytes: number } },
  cloudStates: Readonly<Record<string, 'on' | 'off' | 'stopped' | 'unknown'>> = {}): GraphInstanceView {
  const names = [...new Set([...fleet, ...hosts, ...(local ? [local.host] : []), ...events.flatMap(event => {
    if (event.event === 'lease-created') return [event.lease.host];
    if (event.event === 'guardian-host-lease') return [event.record.request.host];
    return 'host' in event && typeof event.host === 'string' ? [event.host] : [];
  })])].filter(safeId);
  const active = new Map<string, Array<{ kind: 'gate' | 'train' | 'pod' | 'seat'; label: string }>>();
  const leases = new Map<string, { host: string; kind: 'gate' | 'train' | 'pod' | 'seat'; label: string }>();
  for (const event of events) {
    if (event.event === 'lease-created') leases.set(event.lease.id, { host: event.lease.host,
      kind: taskKind(event.lease.lane), label: safeText(event.lease.mission.cell ?? event.lease.mission.goalId ?? event.lease.id) });
    if (event.event === 'lease-ended' || event.event === 'lease-reaped') leases.delete(event.id);
  }
  for (const lease of leases.values()) active.set(lease.host, [...(active.get(lease.host) ?? []), { kind: lease.kind, label: lease.label }]);
  const nodes: GraphInstanceView['nodes'] = names.map(host => ({ id: host, label: host,
    state: host === local?.host ? 'on' : cloudStates[host] ?? 'unknown',
    resource: { hostKind: /^(?:aws|gcp|azure)/.test(host) ? 'cloud' : 'local', tasks: active.get(host) ?? [],
      ...(host === local?.host ? { cpuCores: local.cpuCores, loadavg: local.loadavg, memory: local.memory } : {}) } }));
  const logs = events.slice(-20).map((event, index) => ({ seq: index + 1, at: event.at,
    level: 'info' as const, text: safeText(event.event) }));
  return { schemaVersion: 1, instance: { source: 'resource', runId: 'resource-fleet', title: 'Resource fleet', observedAt, state: 'unknown' },
    nodes, edges: [], progress: { label: '가동', completed: nodes.filter(node => node.state === 'on').length,
      total: nodes.length, activeNodeIds: nodes.filter(node => node.state === 'on').map(node => node.id) }, logs,
    statusLine: `자원 ${nodes.length}대 · 상태 ${local ? '일부 확인' : '미확인'}`, readState: 'partial' };
}

export function projectView(query: ViewQuery, ledgers: ViewLedgers): GraphInstanceView | null {
  const observedAt = ledgers.now();
  if (query.source === 'resource') {
    const host = ledgers.localHost?.();
    const metrics = ledgers.localMetrics?.();
    return projectResources(ledgers.resources(), ledgers.hosts(), observedAt,
      host && metrics ? { host, ...metrics } : undefined, ledgers.cloudStates?.());
  }
  if (!query.runId) return null;
  if (query.source === 'harness') {
    const entries = ledgers.harness(query.runId);
    return entries === null ? null : projectHarnessRun(query.runId, entries, observedAt);
  }
  const matches = ledgers.graphRuns().filter(item => item.runId === query.runId
    && (query.graphId ? item.graphId === query.graphId : query.source === 'release' ? item.graphId === 'release-loop' : item.graphId !== 'release-loop'));
  const run = matches.length === 1 ? matches[0] : undefined;
  return run ? projectGraphRun(run, query.source, observedAt) : null;
}

const cloudHosts: readonly CloudVmHost[] = ['aws1', 'aws2', 'gcp2'];
const execFileAsync = promisify(execFile);
/** Cloud status polling stays outside the synchronous TUI render and Nexus request path. */
export async function readCloudStatesAsync(command: string, hosts: readonly CloudVmHost[] = cloudHosts): Promise<Record<string, 'on' | 'stopped' | 'unknown'>> {
  const next: Record<string, 'on' | 'stopped' | 'unknown'> = {};
  await Promise.all(hosts.map(async host => {
    try {
      const { stdout } = await execFileAsync(command, ['status', host, '--reason', 'graph instance read-only status',
        '--source', 'graph-instance-view'], { timeout: 2_000, maxBuffer: 64 * 1024 });
      const rows = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.split(/\s+/)[0] === host);
      const state = rows.length === 1 ? rows[0]!.split(/\s+/)[5]?.toLowerCase() : undefined;
      next[host] = state === 'running' ? 'on' : ['stopped', 'terminated', 'deallocated'].includes(state ?? '') ? 'stopped' : 'unknown';
    } catch { next[host] = 'unknown'; }
  }));
  return next;
}
let cloudSnapshot: Record<string, 'on' | 'off' | 'stopped' | 'unknown'> = {};
let cloudObservedAt = 0;
let cloudRefresh: Promise<void> | null = null;
function cachedCloudStates(): Readonly<Record<string, 'on' | 'off' | 'stopped' | 'unknown'>> {
  if (!cloudRefresh && Date.now() - cloudObservedAt > 15_000) {
    cloudObservedAt = Date.now();
    cloudRefresh = (async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      let command: string | undefined;
      try { command = releaseRehearsalConfig().cloudVmCommand; } catch { cloudSnapshot = {}; return; }
      if (!command) { cloudSnapshot = {}; return; }
      cloudSnapshot = await readCloudStatesAsync(command);
    })().finally(() => { cloudRefresh = null; });
  }
  return cloudSnapshot;
}

export const liveLedgers: ViewLedgers = {
  graphRuns: () => listGraphRuns().runs,
  harness: runId => loadRunLedger(runId, runLedgerDir(elanousStateRoot())),
  resources: () => readResourceLedger(resourceLedgerPath(elanousStateRoot())),
  hosts: () => {
    const configured = defaultResourceHosts().map(host => host.host);
    const capsPath = join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'train-manager', 'host-caps.tsv');
    const caps = existsSync(capsPath) ? readFileSync(capsPath, 'utf8').split(/\r?\n/)
      .filter(line => line && !line.startsWith('#')).map(line => line.split('\t')[0] ?? '') : [];
    return [...new Set([...configured, ...caps])].filter(safeId);
  },
  localHost: () => {
    const name = hostname().toLowerCase();
    return name === 'macstudiob1' ? 'node-b' : name === 'macbookpro' ? 'mbp' : name;
  },
  localMetrics: () => ({ cpuCores: cpus().length, loadavg: loadavg() as [number, number, number],
    memory: { usedBytes: totalmem() - freemem(), totalBytes: totalmem() } }),
  cloudStates: cachedCloudStates,
  now: () => new Date().toISOString(),
};

/** Sidebar projection for a selected run; an unbound tab shows the resource fleet. */
export function readLiveGraphInstance(runId?: string, ledgers: ViewLedgers = liveLedgers): GraphInstanceView | null {
  if (!runId) {
    const view = projectView({ source: 'resource' }, ledgers);
    return view && graphInstanceViewIssues(view).length === 0 ? view : null;
  }
  const graph = ledgers.graphRuns().find(run => run.runId === runId);
  const view = graph
    ? projectView({ source: graph.graphId === 'release-loop' ? 'release' : 'graph', runId, graphId: graph.graphId }, ledgers)
    : projectView({ source: 'harness', runId }, ledgers);
  return view && graphInstanceViewIssues(view).length === 0 ? view : null;
}

export function parseViewQuery(url: URL): ViewQuery | null {
  const source = url.searchParams.get('source');
  const runId = url.searchParams.get('runId') ?? undefined;
  const graphId = url.searchParams.get('graphId') ?? undefined;
  if (!['graph', 'harness', 'release', 'resource'].includes(source ?? '') || [...url.searchParams.keys()].some(key => !['source', 'runId', 'graphId'].includes(key))) return null;
  if (source === 'resource') return !runId && !graphId ? { source } : null;
  if (!runId || !safeId(runId)) return null;
  if (source === 'harness') return !graphId ? { source, runId } : null;
  if (graphId && (!safeId(graphId) || (source === 'release' && graphId !== 'release-loop'))) return null;
  return { source: source as 'graph' | 'release', runId, ...(graphId ? { graphId } : {}) };
}
