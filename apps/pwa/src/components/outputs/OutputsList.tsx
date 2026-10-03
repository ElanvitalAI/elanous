'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getOutputs, type OutputItem } from '@/lib/outputs-api';

const seatNames: Record<string, string> = { OP: 'COO', MK: 'CMO', TC: 'CTO', UX: 'CXO' };
const kstTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function formatKst(at: string): string {
  const parts = Object.fromEntries(kstTime.formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  return `${parts.month}월 ${parts.day}일 ${parts.hour}:${parts.minute}`;
}

export function OutputsList() {
  const { client } = useDaemon();
  const [outputs, setOutputs] = useState<OutputItem[]>([]);
  const [selected, setSelected] = useState('all');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    getOutputs(client).then(({ outputs: rows }) => {
      if (active) { setOutputs(rows); setStatus('ready'); }
    }).catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [client]);

  return <OutputsListView outputs={outputs} selected={selected} onSelect={setSelected} status={status} />;
}

export function OutputsListView({ outputs, selected, onSelect, status }: {
  outputs: OutputItem[];
  selected: string;
  onSelect: (kind: string) => void;
  status: 'loading' | 'ready' | 'error';
}) {
  const kinds = Array.from(new Map(outputs.map((row) => [row.kind, row.kindLabel])).entries());
  const visible = selected === 'all' ? outputs : outputs.filter((row) => row.kind === selected);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-5 py-10 sm:py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">산출물</h1>
        <p className="text-sm text-muted-foreground">엘라누스가 만든 문서·슬라이드·보고서·영상을 한곳에서 봅니다.</p>
      </header>
      {status === 'loading' && <p role="status" className="text-sm text-muted-foreground">산출물을 불러오는 중…</p>}
      {status === 'error' && <p role="alert" className="text-sm text-destructive">산출물 목록을 읽지 못했습니다</p>}
      {status === 'ready' && (
        <>
          <div role="group" aria-label="종류 고르기" className="flex flex-wrap gap-2">
            {([['all', '전부'], ...kinds] as [string, string][]).map(([kind, label]) => (
              <button key={kind} type="button" onClick={() => onSelect(kind)} aria-pressed={selected === kind}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === kind ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-muted'}`}>
                {label} {kind === 'all' ? outputs.length : outputs.filter((row) => row.kind === kind).length}
              </button>
            ))}
          </div>
          {outputs.length === 0 ? <p className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">아직 만든 산출물이 없습니다 — 일을 맡기면 여기에 쌓입니다</p> : (
            <ul className="space-y-3" aria-label="산출물 목록">
              {visible.map((row, index) => (
                <li key={`${row.at}-${row.kind}-${index}`} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-md bg-muted px-2 py-1 font-medium text-foreground">{row.kindLabel}</span>
                    {row.seat && <span>{seatNames[row.seat] ?? row.seat}</span>}
                    <time dateTime={row.at}>{formatKst(row.at)}</time>
                    <span>{row.source === 'exec' ? '맡긴 일' : '현장'}</span>
                  </div>
                  <h2 className="mt-3 font-semibold leading-snug">{row.title}</h2>
                  {row.url ? <a href={row.url} target="_blank" rel="noopener" className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">열기</a>
                    : row.fileName && <p className="mt-3 text-sm text-muted-foreground">{row.fileName}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
