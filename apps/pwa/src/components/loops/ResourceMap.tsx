'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Background, Controls, ReactFlow, type Node, type Edge, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { toPublicText } from '@/components/inside/public-text';
import { RESOURCE_NODE, zoomTier } from '@/components/inside/loop-activity-map';

export interface ResourceGraph { nodes: Node[]; edges: Edge[] }

/** The resource snapshot is read-only; labels are projections, not ledger entries. */
export function resourceGraph(snapshot: ResourceSnapshot, near: boolean): ResourceGraph {
  const seats = snapshot.resource.seats;
  const detail = near ? seats.map(row =>
    `${row.seat} ${row.running}/${row.cap} · 몫 ${row.baseShare ?? '못 읽음'} · 발사 상한 ${row.launchCap} · 임대 ${row.borrowed} · 대여 ${row.lent} · ${row.nextCell ? `대기 잡 ${row.nextCell.id} ${row.nextCell.title} (${row.idle ? '요청 가능' : '대기 중'})` : '다음 잡 판정 없음'}`,
  ).join(' / ') : `자리 ${seats.length} · 미배정 런 ${snapshot.resource.unassigned}`;
  return { nodes: [{ id: RESOURCE_NODE, type: 'resource', position: { x: 0, y: 0 }, data: { label: '자원 관리 루프', detail } }], edges: [] };
}

export interface ResourceSnapshot {
  resource: {
    seats: Array<{ seat: string; running: number; cap: number; baseShare: number | null; borrowed: number; lent: number;
      launchCap: number; idle: boolean; nextCell: { id: string; title: string } | null }>;
    unassigned: number;
    now: string;
  };
}

function ResourceNode({ data }: NodeProps) {
  const { label, detail } = data as { label: string; detail: string };
  return <div className="relative w-72 rounded-xl border border-sky-400 bg-[#173556] p-3 text-white shadow-md">
    <strong className="break-words">{toPublicText(label)}</strong>
    <p className="mt-1 break-words text-xs">{toPublicText(detail)}</p>
  </div>;
}
const TYPES: NodeTypes = { resource: ResourceNode };

/** One LOOP-INTERACT resource hub; near zoom reveals the measured seat, job, loan and wait details. */
export function ResourceMap({ snapshot }: { snapshot: ResourceSnapshot }) {
  const [zoom, setZoom] = useState(1);
  const near = zoomTier(zoom) === 'near';
  const seats = snapshot.resource.seats;
  const { nodes, edges } = resourceGraph(snapshot, near);
  return <section aria-label="자원 LOOP-INTERACT" className="space-y-3">
    <p className="text-sm">자리 · 잡 · 임대 · 대기 — 확대하면 자리 몫과 다음 잡을 볼 수 있습니다.</p>
    <div className="h-[520px] w-full min-w-0 rounded-xl border bg-[#10243b]">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={TYPES} fitView minZoom={0.25} maxZoom={2.5}
        onInit={instance => setZoom(instance.getZoom())} onMove={(_event, viewport) => setZoom(viewport.zoom)}
        nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <ul aria-label="자원 목록" className="grid gap-2 sm:grid-cols-2">{seats.map(row => <li key={row.seat} className="rounded-lg border p-3">
      <strong>{row.seat} {row.running}/{row.cap}</strong> · 몫 {row.baseShare ?? '못 읽음'} · 발사 상한 {row.launchCap}
      {' · '}임대 {row.borrowed} · 대여 {row.lent} · {row.nextCell ? `대기 잡 ${toPublicText(row.nextCell.id)} · ${toPublicText(row.nextCell.title)} · ${row.idle ? '요청 가능' : '대기 중'}` : '다음 잡 판정 없음'}
    </li>)}</ul>
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
        const snapshot = await client.fetchJson<ResourceSnapshot>('/v1/loops/resources');
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
