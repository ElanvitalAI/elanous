'use client';

import { useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getOpsChecklist, type ChecklistStatus, type OpsResult, type OpsChecklist } from '@/lib/ops-api';

function localTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function cutLabel(cut: Date, now: Date | null): string {
  const today = now && new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const tomorrow = now && new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const day = new Date(cut.getFullYear(), cut.getMonth(), cut.getDate()).getTime();
  const prefix = day === today ? '오늘' : day === tomorrow ? '내일'
    : `${String(cut.getMonth() + 1).padStart(2, '0')}/${String(cut.getDate()).padStart(2, '0')} (${['일', '월', '화', '수', '목', '금', '토'][cut.getDay()]})`;
  return `${prefix} ${localTime(cut)}`;
}

function ScheduleLine({ schedule, now }: { schedule: OpsChecklist['schedule']; now: number | null }): React.ReactNode {
  if (!schedule) return <p className="text-sm text-muted-foreground">판 일정 없음</p>;
  const cut = new Date(schedule.cutAt);
  const land = schedule.landBy === null ? null : new Date(schedule.landBy);
  const remaining = land && now !== null ? land.getTime() - now : null;
  const urgency = remaining !== null && remaining <= 0 ? 'text-red-600'
    : remaining !== null && remaining <= 3 * 60 * 60 * 1000 ? 'text-orange-600' : 'text-muted-foreground';
  const minutes = remaining !== null && remaining > 0 ? Math.ceil(remaining / 60_000) : 0;
  const countdown = `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}시간` : ''}${minutes % 60 ? `${Math.floor(minutes / 60) ? ' ' : ''}${minutes % 60}분` : minutes < 60 ? '0분' : ''}`;
  return <p aria-label="판 일정" className={`text-sm ${urgency}`}>
    컷 {cutLabel(cut, now === null ? null : new Date(now))}
    {land && <> · 착지 마감 {land.toDateString() === cut.toDateString() ? localTime(land) : cutLabel(land, now === null ? null : new Date(now))}{remaining !== null && <> · {remaining <= 0 ? '착지 마감 지남' : `마감까지 ${countdown}`}</>}</>}
  </p>;
}

export function ChecklistContent({ result, version, owner, status, pendingOnly, expandedId, onVersion, onOwner, onStatus, onPending, onExpand, now = null }: {
  result: OpsResult<OpsChecklist> | null;
  version: string;
  owner: string;
  status: string;
  pendingOnly: boolean;
  expandedId: string | null;
  now?: number | null;
  onVersion: (value: string) => void;
  onOwner: (value: string) => void;
  onStatus: (value: string) => void;
  onPending: (value: boolean) => void;
  onExpand: (value: string | null) => void;
}): React.ReactNode {
  if (result?.kind === 'forbidden') return <p>운영자만 볼 수 있습니다</p>;
  const data = result?.kind === 'ready' ? result.data : null;
  const items = data?.items.filter((item) => (!owner || item.owner === owner)
    && (!status || item.status === status) && (!pendingOnly || item.status === 'yellow')) ?? [];
  return <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 overflow-x-hidden px-4 py-6 text-foreground">
    <header className="space-y-1"><p className="text-sm text-muted-foreground">운영 / 판별 피처</p><h1 className="text-2xl font-semibold">판별 피처</h1></header>
    <label className="block space-y-2 text-sm font-medium">판
      <input aria-label="판" list="ops-checklist-versions" value={version} onChange={(event) => onVersion(event.target.value)} className="block w-full max-w-xs rounded-md border bg-background p-2" />
      <datalist id="ops-checklist-versions"><option value="0.2.8" /><option value="0.2.9" /><option value="0.2.10" /></datalist>
    </label>
    {result === null && <p role="status">칸을 불러오는 중…</p>}
    {result?.kind === 'error' && <p role="alert">칸을 불러오지 못했습니다 ({result.status})</p>}
    {data && <>
      <ScheduleLine schedule={data.schedule} now={now} />
      <section aria-label="상태별 수" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([['🟢', 'green'], ['🟡', 'yellow'], ['🔴', 'red'], ['✅', 'done']] as const).map(([icon, key]) =>
          <div key={key} className="rounded-md border p-3 text-sm">{icon} {data[key]}</div>)}
      </section>
      <section className="flex min-w-0 flex-wrap items-end gap-3" aria-label="거르기">
        <label className="space-y-1 text-sm">자리<select aria-label="자리" className="block rounded-md border bg-background p-2" value={owner} onChange={(event) => onOwner(event.target.value)}>
          <option value="">전체</option>{['OP', 'MK', 'TC', 'UX'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select></label>
        <label className="space-y-1 text-sm">상태<select aria-label="상태" className="block rounded-md border bg-background p-2" value={status} onChange={(event) => onStatus(event.target.value)}>
          <option value="">전체</option>{(['green', 'yellow', 'red', 'done'] as ChecklistStatus[]).map((v) => <option key={v} value={v}>{v}</option>)}
        </select></label>
        <label className="flex items-center gap-2 p-2 text-sm"><input type="checkbox" checked={pendingOnly} onChange={(event) => onPending(event.target.checked)} />판정 대기만</label>
      </section>
      <section className="min-w-0 space-y-2" aria-label="칸 목록">
        <h2 className="font-semibold">칸 목록</h2>
        {items.length === 0 && <p className="text-sm text-muted-foreground">해당하는 칸이 없습니다.</p>}
        {items.map((item) => <div key={item.id} className="min-w-0 rounded-md border">
          <button type="button" className="flex w-full min-w-0 items-center gap-2 overflow-hidden p-3 text-left hover:bg-muted" aria-expanded={expandedId === item.id} onClick={() => onExpand(expandedId === item.id ? null : item.id)}>
            <span className="max-w-[35%] shrink-0 truncate text-sm font-medium">{item.id}</span><span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="shrink-0 text-xs">{item.owner ?? '—'} · {item.status}</span>
          </button>
          {expandedId === item.id && <div className="min-w-0 space-y-2 border-t p-3 text-sm">
            <p className="break-all font-medium">{item.title}</p><p className="whitespace-pre-wrap break-all">{item.evidence ?? '근거 없음'}</p>
          </div>}
        </div>)}
      </section>
    </>}
  </main>;
}

export function ChecklistView(): React.ReactNode {
  const { client } = useDaemon();
  const [version, setVersion] = useState('0.2.9');
  const [result, setResult] = useState<OpsResult<OpsChecklist> | null>(null);
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let interval: number | undefined;
    const visibility = () => {
      if (interval !== undefined) { window.clearInterval(interval); interval = undefined; }
      if (!document.hidden) {
        setNow(Date.now());
        interval = window.setInterval(() => setNow(Date.now()), 60_000);
      }
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { if (interval !== undefined) window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const [denied, setDenied] = useState(false);
  const permissionDenied = useRef(false);
  const priorClient = useRef(client);
  useEffect(() => {
    let active = true;
    if (priorClient.current !== client) {
      priorClient.current = client;
      permissionDenied.current = false;
      setDenied(false);
    }
    if (permissionDenied.current) return () => { active = false; };
    if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) { setResult(null); return () => { active = false; }; }
    setResult(null);
    void getOpsChecklist(client, version).then((next) => {
      if (!active || permissionDenied.current) return;
      if (next.kind === 'forbidden') { permissionDenied.current = true; setDenied(true); }
      setResult(next);
    });
    return () => { active = false; };
  }, [client, version]);
  if (denied) return <p>운영자만 볼 수 있습니다</p>;
  return <ChecklistContent result={result} version={version} owner={owner} status={status} pendingOnly={pendingOnly}
    now={now} expandedId={expandedId} onVersion={(next) => { setVersion(next); setExpandedId(null); }} onOwner={setOwner} onStatus={setStatus}
    onPending={setPendingOnly} onExpand={setExpandedId} />;
}
