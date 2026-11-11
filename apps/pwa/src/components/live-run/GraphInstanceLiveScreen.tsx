'use client';

import { useQuery } from '@tanstack/react-query';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { GraphInstanceRichView, type GraphInstanceView } from './GraphInstanceRichView';

export interface GraphInstanceKey {
  source: GraphInstanceView['instance']['source'];
  runId?: string;
  graphId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function validNode(value: unknown): boolean {
  const node = record(value);
  if (!node || typeof node.id !== 'string' || typeof node.label !== 'string'
    || !oneOf(node.state, ['queued', 'running', 'waiting', 'done', 'failed', 'unknown', 'on', 'off', 'stopped'])) return false;
  if ((node.role !== undefined && typeof node.role !== 'string') || (node.model !== undefined && typeof node.model !== 'string')) return false;
  const resource = node.resource === undefined ? null : record(node.resource);
  if (node.resource !== undefined && (!resource || !oneOf(resource.hostKind, ['local', 'cloud']) || !Array.isArray(resource.tasks)
    || !resource.tasks.every(task => { const entry = record(task); return entry && oneOf(entry.kind, ['seat', 'pod', 'train', 'gate', 'rehearsal', 'review']) && typeof entry.label === 'string'; }))) return false;
  if (resource && ((resource.cpuCores !== undefined && typeof resource.cpuCores !== 'number')
    || (resource.loadavg !== undefined && (!Array.isArray(resource.loadavg) || !resource.loadavg.every(value => typeof value === 'number')))
    || (resource.memory !== undefined && (!record(resource.memory) || typeof record(resource.memory)?.usedBytes !== 'number' || typeof record(resource.memory)?.totalBytes !== 'number')))) return false;
  if (node.progress !== undefined) {
    const progress = record(node.progress);
    if (!progress || typeof progress.done !== 'number' || typeof progress.total !== 'number') return false;
  }
  return true;
}

/** Reject an unexpected version or a different selected instance before drawing server JSON. */
export function matchingGraphInstanceView(value: unknown, key: GraphInstanceKey): GraphInstanceView | null {
  const root = record(value);
  const instance = record(root?.instance);
  const progress = record(root?.progress);
  if (root?.schemaVersion !== 1 || !instance || instance.source !== key.source
    || (key.source === 'resource' && instance.runId !== 'resource-fleet')
    || (key.source !== 'resource' && key.runId && instance.runId !== key.runId)
    || (key.source !== 'resource' && key.graphId && instance.graphId !== key.graphId)
    || typeof instance.runId !== 'string' || typeof instance.title !== 'string' || typeof instance.observedAt !== 'string'
    || !oneOf(instance.state, ['running', 'waiting', 'done', 'failed', 'unknown'])
    || (instance.graphId !== undefined && typeof instance.graphId !== 'string')
    || !Array.isArray(root.nodes) || !Array.isArray(root.edges) || !Array.isArray(root.logs)
    || !root.nodes.every(validNode)
    || (instance.source === 'resource' && !root.nodes.every((value: unknown) => Boolean(record(value)?.resource)))
    || !root.edges.every((value: unknown) => { const edge = record(value); return edge && typeof edge.id === 'string' && typeof edge.from === 'string' && typeof edge.to === 'string' && oneOf(edge.kind, ['flow', 'branch', 'join']) && oneOf(edge.state, ['planned', 'taken', 'unknown']); })
    || !root.logs.every((value: unknown) => { const log = record(value); return log && typeof log.seq === 'number' && oneOf(log.level, ['info', 'warn', 'error']) && typeof log.text === 'string' && (log.at === undefined || typeof log.at === 'string') && (log.nodeId === undefined || typeof log.nodeId === 'string'); })
    || !progress || typeof progress.completed !== 'number' || !(progress.total === null || typeof progress.total === 'number') || !strings(progress.activeNodeIds)
    || (progress.label !== undefined && typeof progress.label !== 'string')
    || typeof root.statusLine !== 'string'
    || !['ok', 'partial', 'unavailable'].includes(String(root.readState))) return null;
  return value as GraphInstanceView;
}

// Source: JSON v1 live view is polled while active, waiting for approval, or recovering from a transient read error.
export function graphInstanceRefreshInterval(view: GraphInstanceView | null, source: GraphInstanceKey['source'], failed: boolean): number | false {
  return source === 'resource' || failed || view?.instance.state === 'running' || view?.instance.state === 'waiting' ? 4000 : false;
}

export function GraphInstanceLiveScreen({ instanceKey }: { instanceKey: GraphInstanceKey }) {
  const client = useOptionalNexusClient();
  if (!client) return <main className="p-4" role="status">넥서스에 연결하면 인스턴스 원장을 읽습니다.</main>;
  return <GraphInstanceLiveScreenConnected instanceKey={instanceKey} client={client} />;
}

function GraphInstanceLiveScreenConnected({ instanceKey, client }: { instanceKey: GraphInstanceKey; client: NonNullable<ReturnType<typeof useOptionalNexusClient>> }) {
  const query = useQuery({
    queryKey: ['graph-instance-view', instanceKey.source, instanceKey.runId, instanceKey.graphId],
    queryFn: () => client.getGraphInstanceView(instanceKey),
    refetchInterval: (state) => {
      const view = matchingGraphInstanceView(state.state.data, instanceKey);
      return graphInstanceRefreshInterval(view, instanceKey.source, state.state.status === 'error' || (state.state.data !== undefined && !view));
    },
    retry: false,
  });
  const view = matchingGraphInstanceView(query.data, instanceKey);
  return <main className="mx-auto w-full max-w-7xl p-4">
    {query.isPending ? <p role="status">인스턴스 원장을 읽는 중…</p>
      : query.isError ? <p role="alert">인스턴스 원장을 읽지 못했습니다. 연결과 접근 권한을 확인해 주세요.</p>
      : !view ? <p role="alert">선택한 인스턴스와 응답 JSON v1이 일치하지 않습니다.</p>
      : <GraphInstanceRichView view={view} />}
  </main>;
}
