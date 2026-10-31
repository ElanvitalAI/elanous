'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Background, Controls, ReactFlow, type Node, type Edge, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { toPublicText } from '@/components/inside/public-text';
import { RESOURCE_NODE, zoomTier } from '@/components/inside/loop-activity-map';

export interface ResourceSeatRow {
  seat: string;
  running: number;
  cap: number;
  baseShare: number | null;
  borrowed: number;
  lent: number;
  launchCap: number;
  idle: boolean;
  nextCell: { id: string; title: string } | null;
}

/** Tail rows from the existing Nexus event ring (`GET /v1/nexus`). */
export interface ResourceEventWire {
  ts?: number;
  kind: string;
  tabId?: string;
  detail?: Record<string, unknown>;
}

/** Existing pod-worker lease projection from `GET /v1/loops/resources`. */
export interface ResourcePodWorker {
  id: string;
  machine: string;
  workerId: string;
  state: string;
  generation: number;
  ageMs: number;
  expired: boolean;
}

/** Read-only host probe projection from the existing `GET /v1/grid` endpoint. */
export interface ResourceGridSnapshot {
  members?: Array<{
    context: string;
    capacity: number;
    running: number | null;
    pending: number | null;
    occupied: number | null;
    reason: string | null;
  }>;
  poolReason?: string | null;
}

export interface ResourceSnapshot {
  resource: { seats: ResourceSeatRow[]; unassigned: number; now: string };
  recentEvents?: ResourceEventWire[] | null;
  podWorkers?: ResourcePodWorker[] | null;
  grid?: ResourceGridSnapshot | null;
}

export interface ResourceGraph { nodes: Node[]; edges: Edge[] }

interface ResourceCellSpec { id: string; members: string }

/** Keep this inventory aligned with DEMO-1104-MASTER-SCRIPT.md §3b. */
export const RESOURCE_CELLS: ResourceCellSpec[] = [
  { id: '머신', members: 'mbp·node-b·node-c·minim5·elangram·host-e(WSL)' },
  { id: '손', members: 'Codex·Claude Code' },
  { id: '모델', members: 'gpt 계열·Claude·Grok·GLM' },
  { id: '검색', members: 'Exa·Firecrawl·Grok' },
  { id: '업무 도구', members: 'Linear·Telegram·browser·메일(초안)' },
  { id: '영상 파이프라인', members: 'graphs/video/explainer-line.yaml' },
];

interface ResourceCell { id: string; members: string; lit: boolean; status: 'active' | 'idle' | 'unmeasured'; activity: string }

const RECENT_EVENT_WINDOW_MS = 2 * 60_000;
const EVENT_TEXT_KEYS = ['title', 'text', 'message', 'prompt', 'variant', 'workflowName', 'nodeId', 'name'] as const;
const RESOURCE_IDENTITY_KEYS = ['provider', 'model', 'agent', 'hand', 'tool', 'toolName', 'service', 'channel', 'who', 'machine', 'machineName', 'host', 'variant', 'workflowName'] as const;
const HAND_NAMES = ['codex', 'claude'] as const;
const MODEL_NAMES = ['gpt', 'claude', 'grok', 'glm'] as const;
const SEARCH_NAMES = ['exa', 'firecrawl', 'grok'] as const;
const TOOL_NAMES = ['linear', 'telegram', 'browser'] as const;
type SeatRow = ResourceSnapshot['resource']['seats'][number];

/** The waiting cell a seat shows: the same ID rule the Nexus resource API serves. */
export function shownCell(row: SeatRow): SeatRow['nextCell'] {
  return row.nextCell && row.nextCell.id.trim() !== '' ? row.nextCell : null;
}

function detailText(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  for (const key of EVENT_TEXT_KEYS) {
    const value = detail[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function eventText(event: ResourceEventWire): string {
  const detail = detailText(event.detail);
  return detail ? `${event.kind} — ${detail}` : event.kind;
}

function resourceIdentity(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  const values = RESOURCE_IDENTITY_KEYS.flatMap(key => {
    const value = detail[key];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as Record<string, unknown>;
      return [row.who, row.provider, row.model, row.agent, row.kind]
        .filter((item): item is string => typeof item === 'string');
    });
    return [];
  });
  const graphEvents = detail.graphEvents;
  if (Array.isArray(graphEvents)) {
    for (const entry of graphEvents) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      values.push(...[row.who, row.provider, row.model, row.agent, row.kind]
        .filter((item): item is string => typeof item === 'string'));
    }
  }
  return values.join(' ').toLowerCase();
}

function hasNamedResource(text: string, name: string): boolean {
  return text.split(/[^a-z0-9]+/).includes(name.toLowerCase());
}

function eventMatchesCell(event: ResourceEventWire, cellId: string): boolean {
  const kind = event.kind.toLowerCase();
  const identity = resourceIdentity(event.detail);
  if (cellId === '머신') return kind.startsWith('tab.') || kind.startsWith('host.');
  if (cellId === '손') return kind.startsWith('mission.')
    && (HAND_NAMES.some(name => hasNamedResource(identity, name))
      || (Array.isArray(event.detail?.graphEvents) && event.detail.graphEvents.some(entry =>
        !!entry && typeof entry === 'object' && 'kind' in entry && entry.kind === 'hand'
          && 'who' in entry && typeof entry.who === 'string'
          && HAND_NAMES.some(name => hasNamedResource(entry.who as string, name)))));
  if (cellId === '모델') return kind.startsWith('session.')
    && MODEL_NAMES.some(name => hasNamedResource(identity, name));
  if (cellId === '검색') return (kind.startsWith('trigger.') || kind.includes('.search'))
    && SEARCH_NAMES.some(name => hasNamedResource(identity, name) || kind.includes(name));
  if (cellId === '업무 도구') return TOOL_NAMES.some(name => kind.startsWith(`${name}.`))
    || (kind.startsWith('hitl.') && TOOL_NAMES.some(name => hasNamedResource(identity, name)));
  if (cellId === '영상 파이프라인') return kind.startsWith('media.');
  return false;
}

function isRecent(event: ResourceEventWire, now: number): boolean {
  return typeof event.ts === 'number' && Number.isFinite(event.ts)
    && event.ts <= now + 5_000 && now - event.ts <= RECENT_EVENT_WINDOW_MS;
}

function activePodWorkers(snapshot: ResourceSnapshot): ResourcePodWorker[] {
  return (snapshot.podWorkers ?? []).filter(worker => worker.state === 'leased' && !worker.expired);
}

function machineActivity(snapshot: ResourceSnapshot): { active: string[]; unmeasured: string[] } {
  const lines: string[] = [];
  const unmeasured: string[] = [];
  const members = snapshot.grid?.members;
  for (const member of members ?? []) {
    if (member.occupied !== null && member.occupied > 0) {
      lines.push(`${member.context} ${member.occupied}/${member.capacity} occupied`);
    } else if (member.occupied === null) {
      unmeasured.push(`${member.context} 호스트 프로브 미측정${member.reason ? ` (${member.reason})` : ''}`);
    }
  }
  if (snapshot.grid && members === undefined) {
    unmeasured.push('호스트 프로브 미측정');
  } else if (snapshot.grid && members?.length === 0 && snapshot.grid.poolReason) {
    unmeasured.push(`호스트 프로브 미측정 (${snapshot.grid.poolReason})`);
  }
  for (const worker of activePodWorkers(snapshot)) lines.push(`${worker.machine}·${worker.workerId} ${worker.state}`);
  if (snapshot.grid == null) unmeasured.push('호스트 프로브 미측정');
  if (snapshot.podWorkers == null) unmeasured.push('Pod 원장 미측정');
  return { active: lines, unmeasured };
}

function handActivity(snapshot: ResourceSnapshot): { active: string[]; unmeasured: string[] } {
  const active = activePodWorkers(snapshot)
    .filter(worker => HAND_NAMES.some(name => worker.workerId.toLowerCase().includes(name)))
    .map(worker => `${worker.machine}·${worker.workerId} ${worker.state}`);
  return { active, unmeasured: snapshot.podWorkers == null ? ['Pod 원장 미측정'] : [] };
}

/** Project recent existing graph events, host probes, and Pod lease rows into the fixed demo cells. */
export function resourceCells(snapshot: ResourceSnapshot, now = Date.now()): ResourceCell[] {
  const events = (snapshot.recentEvents ?? []).filter(event => isRecent(event, now));
  return RESOURCE_CELLS.map(spec => {
    const latest = [...events].reverse().find(event => eventMatchesCell(event, spec.id));
    const supporting = spec.id === '머신' ? machineActivity(snapshot)
      : spec.id === '손' ? handActivity(snapshot) : { active: [], unmeasured: [] };
    const live = [latest ? eventText(latest) : '', ...supporting.active].filter(Boolean);
    const uncertainty = [...(snapshot.recentEvents == null ? ['이벤트 스트림 미측정'] : []), ...supporting.unmeasured];
    const lit = live.length > 0;
    return { id: spec.id, members: spec.members, lit, status: lit ? 'active' : uncertainty.length ? 'unmeasured' : 'idle',
      activity: [...live, ...uncertainty].join(' · ') };
  });
}

/** Combine the existing resource ledger, Nexus event ring, and host grid read. */
export function enrichResourceSnapshot(
  resource: Omit<ResourceSnapshot, 'recentEvents' | 'grid'>,
  nexus: { recentEvents?: ResourceEventWire[] | null } | null,
  grid: ResourceGridSnapshot | null,
): ResourceSnapshot {
  return { ...resource, recentEvents: nexus?.recentEvents ?? null, grid };
}

/** The resource snapshot is read-only; labels are projections, not ledger entries. */
export function resourceGraph(snapshot: ResourceSnapshot, near: boolean, projectedCells = resourceCells(snapshot)): ResourceGraph {
  const seats = snapshot.resource.seats;
  const detail = near ? seats.map(row => {
    const cell = shownCell(row);
    return `${row.seat} ${row.running}/${row.cap} · 몫 ${row.baseShare ?? '못 읽음'} · 발사 상한 ${row.launchCap} · 임대 ${row.borrowed} · 대여 ${row.lent} · ${cell ? `대기 잡 ${cell.id} ${cell.title} (${row.idle ? '요청 가능' : '대기 중'})` : '다음 잡 판정 없음'}`;
  }).join(' / ') : `자리 ${seats.length} · 미배정 런 ${snapshot.resource.unassigned}`;
  const cells = projectedCells;
  const nodes: Node[] = [
    { id: RESOURCE_NODE, type: 'resource', position: { x: 0, y: 0 }, data: { label: '자원 관리 루프', detail } },
    ...cells.map((cell, index) => {
      const angle = (index / cells.length) * Math.PI * 2 - Math.PI / 2;
      const label = cell.members ? `${cell.id}(${cell.members})` : cell.id;
      return {
        id: `resource-cell:${cell.id}`,
        type: 'resourceCell',
        position: { x: Math.round(Math.cos(angle) * 320), y: Math.round(Math.sin(angle) * 240) },
        data: { label, detail: cell.activity, lit: cell.lit, status: cell.status, cellId: cell.id },
      };
    }),
  ];
  const edges: Edge[] = cells.map(cell => ({
    id: `resource-edge:${cell.id}`,
    source: RESOURCE_NODE,
    target: `resource-cell:${cell.id}`,
    animated: cell.lit,
  }));
  return { nodes, edges };
}

function ResourceNode({ data }: NodeProps) {
  const { label, detail } = data as { label: string; detail: string };
  return <div className="relative w-72 rounded-xl border border-sky-400 bg-[#173556] p-3 text-white shadow-md">
    <strong className="break-words">{toPublicText(label)}</strong>
    <p className="mt-1 break-words text-xs">{toPublicText(detail)}</p>
  </div>;
}

function ResourceCellNode({ data }: NodeProps) {
  const { label, detail, lit, status, cellId } = data as { label: string; detail: string; lit: boolean; status: ResourceCell['status']; cellId: string };
  const stateText = status === 'active' ? `● ${toPublicText(detail)}` : status === 'unmeasured' ? `◌ ${toPublicText(detail)}` : '○ 최근 관측 없음';
  return <div role="group" aria-label={`${toPublicText(label)} ${stateText}`}
    data-resource-cell={cellId} data-lit={String(lit)} data-linked-node={RESOURCE_NODE}
    className={`relative w-64 rounded-xl border p-3 text-white shadow-md ${lit ? 'border-emerald-400 bg-[#14532d]' : 'border-slate-500 bg-slate-800'}`}>
    <strong className="break-words">{toPublicText(label)}</strong>
    <p className={`mt-1 break-words text-xs ${lit ? 'text-emerald-200' : status === 'unmeasured' ? 'text-amber-200' : 'text-slate-400'}`}>
      {stateText}
    </p>
  </div>;
}

const TYPES: NodeTypes = { resource: ResourceNode, resourceCell: ResourceCellNode };

/** The map keeps every demo resource visible while event-fed cells show the current work. */
export function ResourceMap({ snapshot }: { snapshot: ResourceSnapshot }) {
  const [zoom, setZoom] = useState(1);
  const near = zoomTier(zoom) === 'near';
  const seats = snapshot.resource.seats;
  const now = Date.now();
  const cells = resourceCells(snapshot, now);
  const { nodes, edges } = resourceGraph(snapshot, near, cells);
  return <section aria-label="자원 LOOP-INTERACT" data-observed-at={snapshot.resource.now} className="space-y-3">
    <p className="text-sm">자리 · 잡 · 임대 · 대기 — 확대하면 자리 몫과 다음 잡을 볼 수 있습니다.</p>
    <div className="h-[520px] w-full min-w-0 rounded-xl border bg-[#10243b]">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={TYPES} fitView minZoom={0.25} maxZoom={2.5}
        onInit={instance => setZoom(instance.getZoom())} onMove={(_event, viewport) => setZoom(viewport.zoom)}
        nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <ul aria-label="데모 자원" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {cells.map(cell => {
        const label = cell.members ? `${cell.id}(${cell.members})` : cell.id;
        return <li key={cell.id} data-resource-cell={cell.id} data-lit={String(cell.lit)}
          className={`min-h-16 rounded-lg border p-3 ${cell.lit ? 'border-emerald-400 bg-emerald-950 text-emerald-100' : 'border-border bg-card text-muted-foreground'}`}>
          <strong>{toPublicText(label)}</strong>
          <p className={`mt-1 text-xs ${cell.status === 'unmeasured' ? 'text-amber-700 dark:text-amber-300' : ''}`}>
            {cell.status === 'active' ? `● ${toPublicText(cell.activity)}` : cell.status === 'unmeasured' ? `◌ ${toPublicText(cell.activity)}` : '○ 최근 관측 없음'}
          </p>
        </li>;
      })}
    </ul>
    <ul aria-label="자원 목록" className="grid gap-2 sm:grid-cols-2">{seats.map(row => {
      const cell = shownCell(row);
      return <li key={row.seat} data-cell-id={cell ? cell.id : undefined} className="rounded-lg border p-3">
        <strong>{row.seat} {row.running}/{row.cap}</strong> · 몫 {row.baseShare ?? '못 읽음'} · 발사 상한 {row.launchCap}
        {' · '}임대 {row.borrowed} · 대여 {row.lent} · {cell ? `대기 잡 ${toPublicText(cell.id)} · ${toPublicText(cell.title)} · ${row.idle ? '요청 가능' : '대기 중'}` : '다음 잡 판정 없음'}
      </li>;
    })}</ul>
  </section>;
}

export function ResourcePanel() {
  const { client } = useDaemon();
  const [state, setState] = useState<{ source: typeof client; snapshot: ResourceSnapshot | null; error: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (!active || busy || document.hidden) return;
      busy = true;
      try {
        const [resource, nexus, grid] = await Promise.all([
          client.fetchJson<Omit<ResourceSnapshot, 'recentEvents' | 'grid'>>('/v1/loops/resources'),
          client.fetchJson<{ recentEvents?: ResourceEventWire[] }>('/v1/nexus').catch(() => null),
          client.fetchJson<ResourceGridSnapshot>('/v1/grid').catch(() => null),
        ]);
        const snapshot = enrichResourceSnapshot(resource, nexus, grid);
        if (!Array.isArray(snapshot.resource?.seats)) throw new Error('resource observation unavailable');
        if (active) setState({ source: client, snapshot, error: false });
      } catch { if (active) setState({ source: client, snapshot: null, error: true }); }
      finally { busy = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 10_000);
    const visible = () => { void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [client]);
  const current = state?.source === client ? state : null;
  return <main className="mx-auto max-w-[1400px] space-y-4 p-4">
    <header className="flex items-center justify-between gap-2"><h1 className="text-xl font-semibold">자원</h1>
      <Link href="/loops?view=interact" className="rounded-lg border px-3 py-2 text-sm">루프 상호작용 →</Link></header>
    {current?.error && <p role="alert">자원 원천을 읽지 못했습니다</p>}
    {!current && <p role="status">자원을 읽는 중…</p>}
    {current?.snapshot && <ResourceMap snapshot={current.snapshot} />}
  </main>;
}
