'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getSeats, type OpsResult, type OpsSeat, type OpsSeats } from '@/lib/ops-api';
import { maskPublicRefs, seatLineIsPublicSafe, seatNowLine } from '@/lib/seat-public';

const ORDER = [
  { seat: 'OP', role: 'COO' }, { seat: 'MK', role: 'CMO' },
  { seat: 'TC', role: 'CTO' }, { seat: 'UX', role: 'CXO' },
] as const;

function numberOrUnreadable(value: number | null): string {
  return value === null ? '못 읽음' : String(value);
}

function visibleLines(text: string, publicCapture: boolean, identifiers: string[]): string[] {
  const lines = text.split(/\r?\n/);
  return publicCapture
    ? lines.filter((line) => seatLineIsPublicSafe(line) && !identifiers.some((id) => line.includes(id))).map(maskPublicRefs)
    : lines;
}

function SeatCard({ seat, role, publicCapture, identifiers }: { seat?: OpsSeat; role: string; publicCapture: boolean; identifiers: string[] }) {
  const landed = seat?.landed ?? null;
  const blocked = seat?.blocked ?? null;
  const checklist = seat?.checklist ?? null;
  return <article className="min-w-0 space-y-5 rounded-2xl border bg-card p-5 shadow-sm" aria-label={`${role} 자리`}>
    <header><h2 className="text-3xl font-bold tracking-tight">{role}</h2>
      <div className="mt-3 min-h-12 break-words text-muted-foreground" aria-label="지금 하는 일">
        {seat?.now ? visibleLines(seatNowLine(seat.now.text), publicCapture, identifiers).map((line, index) => <p key={index}>{line}</p>) : '못 읽음'}
      </div>
    </header>
    <section aria-label="오늘 착지">
      <h3 className="font-semibold">오늘 착지 <strong className={`${publicCapture ? 'text-5xl' : 'text-3xl'} ${landed === null ? 'text-muted-foreground' : ''}`}>{numberOrUnreadable(landed?.length ?? null)}</strong></h3>
      {landed && <ul className="mt-2 space-y-1">{landed.slice(-5).reverse().flatMap((item) =>
        visibleLines(item.title, publicCapture, identifiers).map((line, index) => <li key={`${item.pr}-${index}`} className="break-words">{publicCapture ? line : `#${item.pr} · ${line}`}</li>))}</ul>}
    </section>
    <section aria-label="막힘"><h3 className="font-semibold text-red-600 dark:text-red-400">막힘 <strong className={`${publicCapture ? 'text-5xl' : 'text-3xl'} ${blocked === null ? 'text-muted-foreground' : ''}`}>{numberOrUnreadable(blocked?.length ?? null)}</strong></h3>
      {blocked && <ul className="mt-2 space-y-1 text-red-600 dark:text-red-400">{blocked.flatMap((item) =>
        visibleLines(item.title, publicCapture, identifiers).map((line, index) => <li key={`${item.id}-${index}`} className="break-words">{publicCapture ? line : `${item.id} · ${line}`}</li>))}</ul>}
    </section>
    <p>대표 결정 대기 <strong className={`${publicCapture ? 'text-5xl' : 'text-3xl'} ${seat?.pendingDecisions == null ? 'text-muted-foreground' : ''}`}>{numberOrUnreadable(seat?.pendingDecisions ?? null)}</strong></p>
    <section aria-label="칸 상태" className="flex flex-wrap gap-2 border-t pt-3">
      {checklist ? <>{(['green', 'yellow', 'red', 'done'] as const).map((key, i) =>
        <span key={key} aria-label={`${key} ${checklist[key]}`}>{['🟢', '🟡', '🔴', '✅'][i]} {checklist[key]}</span>)}</>
        : <span className="text-muted-foreground">못 읽음</span>}
    </section>
  </article>;
}

export function SeatBoardContent({ result, refreshedAt, publicCapture = false }: {
  result: OpsResult<OpsSeats> | null; refreshedAt: string | null; publicCapture?: boolean;
}): React.ReactNode {
  if (result?.kind === 'forbidden') return <p>운영자만 볼 수 있습니다</p>;
  const seats = result?.kind === 'ready' ? result.data.seats : [];
  const identifiers = seats.flatMap((entry) => [
    ...(entry.landed ?? []).flatMap((item) => [String(item.pr), ...(item.checklistId ? [item.checklistId] : [])]),
    ...(entry.blocked ?? []).map((item) => item.id),
  ]);
  const total = (field: 'landed' | 'blocked' | 'pendingDecisions') => {
    if (result?.kind !== 'ready' || ORDER.some(({ seat }) => !seats.find((entry) => entry.seat === seat) || seats.find((entry) => entry.seat === seat)?.[field] === null)) return '못 읽음';
    return String(seats.reduce((sum, entry) => sum + (field === 'pendingDecisions' ? entry.pendingDecisions! : entry[field]!.length), 0));
  };
  return <main className={`mx-auto w-full max-w-[1920px] space-y-6 p-4 text-foreground md:p-8 ${publicCapture ? 'flex min-h-screen flex-col text-base' : ''}`}>
    <header><p className="text-muted-foreground">운영 / 자리 현황</p><h1 className="text-3xl font-bold">자리 현황</h1></header>
    <section aria-label="오늘 합계" className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border bg-card p-5">
      {(['landed', 'blocked', 'pendingDecisions'] as const).map((field) => {
        const value = total(field);
        return <p key={field}>{field === 'landed' ? '오늘 착지' : field === 'blocked' ? '막힘' : '결정 대기'} <strong className={`${publicCapture ? 'text-5xl' : 'text-3xl'}${value === '못 읽음' ? ' text-muted-foreground' : ''}`}>{value}</strong></p>;
      })}
      <p>마지막 갱신 <time dateTime={refreshedAt ?? undefined}>{refreshedAt ? new Date(refreshedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '못 읽음'}</time></p>
    </section>
    {result === null && <p role="status">자리 현황을 불러오는 중…</p>}
    {result?.kind === 'error' && <p role="alert">자리 현황을 불러오지 못했습니다 ({result.status})</p>}
    {result?.kind === 'ready' && <div className="grid grid-cols-1 gap-4 md:grid-cols-2 min-[1440px]:grid-cols-4">
      {ORDER.map(({ seat, role }) => <SeatCard key={seat} seat={seats.find((row) => row.seat === seat)} role={role} publicCapture={publicCapture} identifiers={identifiers} />)}
    </div>}
    {publicCapture && <footer className="mt-auto border-t pt-4 text-center font-semibold tracking-wide">PUBLIC CAPTURE · 가린 화면</footer>}
  </main>;
}

export function SeatBoardView(): React.ReactNode {
  const { client } = useDaemon();
  const [result, setResult] = useState<OpsResult<OpsSeats> | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [publicCapture, setPublicCapture] = useState<boolean | null>(null);
  useEffect(() => { setPublicCapture(new URLSearchParams(window.location.search).get('capture') === 'public'); }, []);
  useEffect(() => {
    let active = true;
    let busy = false;
    let forbidden = false;
    const refresh = async () => {
      if (!active || busy || forbidden || document.hidden) return;
      busy = true;
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
      const next = await getSeats(client, date);
      busy = false;
      if (!active) return;
      setResult(next);
      if (next.kind === 'forbidden') forbidden = true;
      if (next.kind === 'ready') setRefreshedAt(new Date().toISOString());
    };
    setResult(null);
    setRefreshedAt(null);
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [client]);
  if (publicCapture === null) return null;
  return <SeatBoardContent result={result} refreshedAt={refreshedAt} publicCapture={publicCapture} />;
}
