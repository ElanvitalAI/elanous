import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import type { PoolKubectl } from '../task-orchestrator/surfaces/pod-lease.js';

export interface RunTreeRecord {
  fp: string;
  entrance?: string;
  runId?: string;
  parentFp?: string;
  parentRunId?: string;
  host?: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  pod?: string;
  job?: string;
  [key: string]: unknown;
}

export interface LiveRunPod {
  context: string;
  pod: string;
  namespace: string;
  phase: string;
  fp?: string;
  runId?: string;
  parentRunId?: string;
  parentLabel?: string;
  launchHost?: string;
  job?: string;
  node?: string;
}

export interface RunTreeNode {
  id: string;
  kind: 'run' | 'pod';
  fp?: string;
  runId?: string;
  parentFp?: string;
  parentRunId?: string;
  entrance?: string;
  host?: string;
  pod?: string;
  namespace?: string;
  job?: string;
  node?: string;
  phase?: string;
  status: string;
  orphan?: boolean;
  children: string[];
}

function objectData(row: LogStoreRow): Record<string, unknown> | undefined {
  try {
    const data: unknown = row.data ? JSON.parse(row.data) : undefined;
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function runTreeRecords(rows: readonly LogStoreRow[]): RunTreeRecord[] {
  const records = new Map<string, RunTreeRecord>();
  for (const row of rows.slice().reverse()) {
    if (row.category !== 'run.fp') continue;
    const data = objectData(row);
    if (!data || typeof data.fp !== 'string' || !data.fp.startsWith('fp_')) continue;
    const prior = records.get(data.fp) ?? { fp: data.fp };
    if (row.event === 'begin') records.set(data.fp, {
      ...prior, ...data, fp: data.fp, startedAt: String(data.startedAt ?? row.ts),
    });
    else if (row.event === 'end') records.set(data.fp, {
      ...prior, ...data, fp: data.fp, endedAt: String(data.endedAt ?? row.ts),
    });
  }
  return [...records.values()];
}

export function parseLiveRunPods(json: string, context: string): LiveRunPod[] {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new Error('kubectl Pod JSON에 items 배열이 없습니다');
  }
  const items = (parsed as { items: Array<{
      metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
      spec?: { nodeName?: string };
      status?: { phase?: string };
  }> }).items;
  return items.flatMap((item) => {
      const metadata = item.metadata;
      if (!metadata?.name || !metadata.namespace) return [];
      const labels = metadata.labels ?? {};
      const annotations = metadata.annotations ?? {};
      return [{
        context,
        pod: metadata.name,
        namespace: metadata.namespace,
        phase: item.status?.phase ?? 'unknown',
        ...(annotations['elanous.ai/fp'] ? { fp: annotations['elanous.ai/fp'] } : {}),
        ...(annotations['elanous.ai/run'] ? { runId: annotations['elanous.ai/run'] } : {}),
        ...(annotations['elanous.ai/parent'] ? { parentRunId: annotations['elanous.ai/parent'] } : {}),
        ...(labels['elanous.ai/parent'] ? { parentLabel: labels['elanous.ai/parent'] } : {}),
        ...(labels['elanous.ai/launch-host'] ? { launchHost: labels['elanous.ai/launch-host'] } : {}),
        ...(labels['job-name'] ? { job: labels['job-name'] } : {}),
        ...(item.spec?.nodeName ? { node: item.spec.nodeName } : {}),
      }];
  });
}

function resolveParent(records: readonly RunTreeRecord[], pod: LiveRunPod): RunTreeRecord | undefined {
  if (pod.parentRunId) {
    const byRunId = records.find((record) => record.runId === pod.parentRunId);
    if (byRunId) return byRunId;
  }
  if (!pod.parentLabel) return undefined;
  const matches = records.filter((record) => typeof record.runId === 'string' && record.runId.startsWith(pod.parentLabel!));
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildRunTree(records: readonly RunTreeRecord[], pods: readonly LiveRunPod[] = []): RunTreeNode[] {
  const nodes = new Map<string, RunTreeNode>();
  const byFp = new Map<string, string>();
  const byRunId = new Map<string, string>();
  for (const record of records) {
    const id = `run:${record.fp}`;
    const node: RunTreeNode = {
      id, kind: 'run', fp: record.fp,
      ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
      ...(typeof record.parentFp === 'string' ? { parentFp: record.parentFp } : {}),
      ...(typeof record.parentRunId === 'string' ? { parentRunId: record.parentRunId } : {}),
      ...(typeof record.entrance === 'string' ? { entrance: record.entrance } : {}),
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
      ...(typeof record.pod === 'string' ? { pod: record.pod } : {}),
      ...(typeof record.job === 'string' ? { job: record.job } : {}),
      ...(typeof record.endedAt === 'string' ? { status: record.status ?? 'completed' } : { status: record.status ?? 'running' }),
      children: [],
    };
    nodes.set(id, node);
    byFp.set(record.fp, id);
    if (record.runId) byRunId.set(record.runId, id);
  }
  for (const node of nodes.values()) {
    const parentId = (node.parentFp && byFp.get(node.parentFp))
      ?? (node.parentRunId && byRunId.get(node.parentRunId));
    node.orphan = !parentId && Boolean(node.parentFp || node.parentRunId);
    if (parentId && parentId !== node.id) {
      node.orphan = false;
      node.parentFp ??= nodes.get(parentId)!.fp;
      if (!nodes.get(parentId)!.children.includes(node.id)) nodes.get(parentId)!.children.push(node.id);
    }
  }
  for (const pod of pods) {
    const existing = pod.fp ? byFp.get(pod.fp) : undefined;
    const podId = existing ?? `pod:${pod.context}:${pod.namespace}/${pod.pod}`;
    const parent = resolveParent(records, pod);
    const parentId = parent ? byFp.get(parent.fp) : undefined;
    const prior = nodes.get(podId);
    if (prior) {
      prior.pod = pod.pod; prior.namespace = pod.namespace; prior.job = pod.job ?? prior.job;
      prior.phase = pod.phase; prior.host = pod.launchHost ?? pod.context; prior.status = pod.phase.toLowerCase();
      prior.node = pod.node;
      if (pod.runId) prior.runId = pod.runId;
      if (pod.parentRunId) prior.parentRunId = pod.parentRunId;
      if (parent?.fp) prior.parentFp = parent.fp;
      const recordedParentResolved = (prior.parentFp ? byFp.has(prior.parentFp) : false)
        || (prior.parentRunId ? byRunId.has(prior.parentRunId) : false);
      prior.orphan = !parentId && !recordedParentResolved
        && Boolean(pod.parentRunId || pod.parentLabel || prior.parentRunId || prior.parentFp);
      if (parentId && parentId !== podId && !nodes.get(parentId)!.children.includes(podId)) nodes.get(parentId)!.children.push(podId);
    } else {
      nodes.set(podId, {
        id: podId, kind: 'pod', ...(pod.fp ? { fp: pod.fp } : {}),
        ...(pod.runId ? { runId: pod.runId } : {}),
        ...(pod.parentRunId ? { parentRunId: pod.parentRunId } : {}),
        ...(parent?.fp ? { parentFp: parent.fp } : {}),
        host: pod.launchHost ?? pod.context, pod: pod.pod, namespace: pod.namespace,
        ...(pod.node ? { node: pod.node } : {}),
        ...(pod.job ? { job: pod.job } : {}), phase: pod.phase, status: pod.phase.toLowerCase(),
        ...(parentId ? {} : { orphan: Boolean(pod.parentRunId || pod.parentLabel) }), children: [],
      });
      if (parentId) nodes.get(parentId)!.children.push(podId);
    }
  }
  return [...nodes.values()];
}

function readRows(deps: { readRows?: () => readonly LogStoreRow[] }): readonly LogStoreRow[] {
  if (deps.readRows) return deps.readRows();
  const { logsDbPath, LogStore } = require('../mss/logging/log-store.js') as typeof import('../mss/logging/log-store.js');
  if (!existsSync(logsDbPath())) return [];
  const store = LogStore.openReadOnly(logsDbPath());
  try { return store.query({ exactCategories: ['run.fp'], limit: 5000 }); }
  finally { store.close(); }
}

export function registerRunsTreeCommands(program: Command, deps: {
  readRows?: () => readonly LogStoreRow[];
  kubectl?: PoolKubectl;
  out?: (text: string) => void;
} = {}): void {
  const runs = program.commands.find((command) => command.name() === 'runs') ?? program.command('runs').description('실행 지문 조회');
  runs.command('tree [fp|runId|pod]')
    .description('실행 지문과 host별 부모·자식 Pod 상태를 조회')
    .option('--host <context>', 'kubectl context — 생략 시 현재 context')
    .option('--live', '기존 parent label과 launch-host label을 사용해 live Pod를 읽음')
    .option('--json', '동일한 노드·관계·live 상태를 JSON 으로 출력')
    .action((target: string | undefined, options: { host?: string; live?: boolean; json?: boolean }) => {
      const out = deps.out ?? ((text: string) => console.log(text));
      const records = runTreeRecords(readRows(deps));
      let pods: LiveRunPod[] = [];
      if (options.live || options.host) {
        const context = options.host ?? 'current';
        const args = [...(options.host ? ['--context', options.host] : []), 'get', 'pods', '--all-namespaces', '-l', 'elanous.ai/parent', '-o', 'json'];
        const kubectl = deps.kubectl ?? (require('../task-orchestrator/surfaces/pod-lease.js') as typeof import('../task-orchestrator/surfaces/pod-lease.js')).leaseKubectl;
        const result = kubectl(args);
        if (result.status !== 0) throw new Error(`kubectl live Pod 조회 실패 (${context}): ${result.stderr.trim() || `rc=${result.status}`}`);
        pods = parseLiveRunPods(result.stdout, context);
      }
      const nodes = buildRunTree(records, pods);
      const targetNodeIds = target ? new Set(nodes.filter((node) => [node.fp, node.runId, node.pod, node.job]
        .some((value) => typeof value === 'string' && value === target)).map((node) => node.id)) : undefined;
      const selectedIds = targetNodeIds ? new Set(targetNodeIds) : undefined;
      if (selectedIds) {
        const byFp = new Map(nodes.filter((node) => node.fp).map((node) => [node.fp!, node]));
        const byRunId = new Map(nodes.filter((node) => node.runId).map((node) => [node.runId!, node]));
        const queue = [...selectedIds];
        while (queue.length) {
          const currentId = queue.shift()!;
          const node = nodes.find((candidate) => candidate.id === currentId);
          if (!node) continue;
          const parent = (node.parentFp && byFp.get(node.parentFp)) ?? (node.parentRunId && byRunId.get(node.parentRunId));
          for (const related of [...(parent ? [parent] : []), ...node.children.map((id) => nodes.find((candidate) => candidate.id === id)).filter((child): child is RunTreeNode => !!child)]) {
            if (!selectedIds.has(related.id)) { selectedIds.add(related.id); queue.push(related.id); }
          }
        }
      }
      const visibleIds = selectedIds ?? new Set(nodes.map((node) => node.id));
      const visible = nodes.filter((node) => visibleIds.has(node.id)).map((node) => ({
        ...node, children: node.children.filter((child) => visibleIds.has(child)),
      }));
      if (options.json) { out(JSON.stringify({ context: options.host ?? 'current', nodes: visible })); return; }
      if (!visible.length) { out(target ? `실행 지문 없음: ${target}` : '실행 지문 없음'); return; }
      const byId = new Map(visible.map((node) => [node.id, node]));
      const visited = new Set<string>();
      const lines: string[] = [];
      const visit = (node: RunTreeNode, depth: number) => {
        if (visited.has(node.id)) return;
        visited.add(node.id);
        const name = node.kind === 'pod' ? `${node.namespace}/${node.pod}` : `${node.fp} ${node.entrance ?? 'unknown'}`;
        lines.push(`${'  '.repeat(depth)}${node.orphan ? 'orphan ' : ''}${name} · ${node.status} · host=${node.host ?? 'unknown'}${node.runId ? ` · runId=${node.runId}` : ''}${node.node ? ` · node=${node.node}` : ''}`);
        for (const child of node.children) { const childNode = byId.get(child); if (childNode) visit(childNode, depth + 1); }
      };
      for (const node of visible) if (!node.parentFp && !node.parentRunId && ![...visible].some((candidate) => candidate.children.includes(node.id))) visit(node, 0);
      for (const node of visible) visit(node, 0);
      out(lines.join('\n'));
    });
}
