'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { FabricStageHeader } from '@/components/shell/FabricStageHeader';
import { createLoopRowsRefresh, type LoopRow } from './loop-status';

const TONE: Record<LoopRow['verdict'], string> = {
  '살아 있음': 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  '늦음': 'bg-red-500/15 text-red-300 ring-red-500/30',
  '실패': 'bg-red-500/15 text-red-300 ring-red-500/30',
  '꺼짐': 'bg-muted text-muted-foreground ring-border',
  '판정 불가': 'bg-muted text-muted-foreground ring-border',
};

function Verdict({ value }: { value: LoopRow['verdict'] }) {
  return <span data-loop-verdict={value} className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${TONE[value]}`}>{value}</span>;
}

export function LoopStatusContent({ rows, state }: { rows: LoopRow[]; state: 'loading' | 'ready' | 'error' }) {
  if (state === 'loading') return <p role="status" className="text-sm text-muted-foreground">루프 현황을 읽는 중…</p>;
  if (state === 'error') return <p role="alert" className="text-sm text-red-300">루프 현황을 읽지 못했습니다. 일부 레지스트리 조회가 실패했습니다. 데몬 연결을 확인하세요.</p>;
  if (!rows.length) return <p className="text-sm text-muted-foreground">등록된 루프·크론이 없습니다.</p>;
  return <div className="rounded-xl border border-border bg-card">
    <table className="hidden w-full table-fixed text-left text-sm md:table">
      <thead className="border-b border-border text-muted-foreground"><tr>
        <th scope="col" className="w-1/4 px-4 py-3">루프 · 층</th>
        <th scope="col" className="px-4 py-3">주인(자리)</th>
        <th scope="col" className="px-4 py-3">모드</th>
        <th scope="col" className="px-4 py-3">마지막 실행 시각</th>
        <th scope="col" className="px-4 py-3">판정</th>
      </tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border/60 last:border-0" data-loop-id={row.id}>
        <th scope="row" className="break-words px-4 py-3 font-medium">{row.name}<span className="block text-xs font-normal text-muted-foreground">{row.layer}</span></th>
        <td className="px-4 py-3">{row.owner}</td><td className="px-4 py-3">{row.mode}</td>
        <td className="px-4 py-3"><time dateTime={row.lastRun ?? undefined}>{row.lastRun ? new Date(row.lastRun).toLocaleString('ko-KR') : '기록 없음'}</time></td>
        <td className="px-4 py-3"><Verdict value={row.verdict} /></td>
      </tr>)}</tbody>
    </table>
    <ul className="divide-y divide-border/60 md:hidden">{rows.map((row) => <li key={row.id} className="min-w-0 px-3 py-3" data-loop-id={row.id}>
      <div className="flex items-center justify-between gap-2"><strong className="min-w-0 truncate text-sm" title={row.name}>{row.name}</strong><Verdict value={row.verdict} /></div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span>{row.layer}</span><span>· {row.owner}</span><span>· {row.mode}</span><time dateTime={row.lastRun ?? undefined}>· {row.lastRun ? new Date(row.lastRun).toLocaleString('ko-KR') : '기록 없음'}</time></div>
    </li>)}</ul>
  </div>;
}

export function LoopStatusPanel() {
  const { client } = useDaemon();
  const [snapshot, setSnapshot] = useState<{ client: typeof client; rows: LoopRow[]; state: 'ready' | 'error' } | null>(null);
  useEffect(() => {
    const poller = createLoopRowsRefresh(
      (path) => client.fetchJson<unknown>(path),
      ({ rows, state }) => setSnapshot({ client, rows, state }),
    );
    void poller.refresh();
    const timer = window.setInterval(() => void poller.refresh(), 30_000);
    return () => { poller.dispose(); window.clearInterval(timer); };
  }, [client]);
  const current = snapshot?.client === client ? snapshot : null;
  return <main className="mx-auto max-w-[1200px] space-y-5 p-4">
    <FabricStageHeader active="scheduler" />
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex items-center gap-2"><h1 className="text-xl font-semibold">루프 현황</h1><span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">beta · 운영용</span></div>
        <p className="mt-1 text-sm text-muted-foreground">데몬의 루프·크론 레지스트리 · 늦음은 마지막 실행 후 주기의 2배 초과</p></div>
      <Link href="/scheduler" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent">전체 스케줄 →</Link>
    </header>
    <LoopStatusContent rows={current?.rows ?? []} state={current?.state ?? 'loading'} />
  </main>;
}
