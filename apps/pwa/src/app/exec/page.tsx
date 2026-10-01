'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { DaemonClient, ExecRequestDetail, ExecRequestItem, ExecRequestStatus, ExecSeatStatus } from '@/lib/daemon-client';

function requestLabel(status: ExecRequestStatus): string {
  switch (status) {
    case 'planning': return '계획 중';
    case 'running': return '진행 중';
    case 'done': return '완료';
    case 'failed': return '멈춤';
  }
}

function seatLabel(status: ExecSeatStatus): string {
  switch (status) {
    case 'waiting': return '대기';
    case 'running': return '진행 중';
    case 'done': return '완료';
    case 'failed': return '못 함';
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? '';
}

function resultUrl(url: string, id: string): { url: string; daemonFile: boolean } | null {
  if (url.startsWith(`/v1/exec-requests/${encodeURIComponent(id)}/files/`)) {
    return { url, daemonFile: true };
  }
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
      return { url: parsed.href, daemonFile: false };
    }
  } catch {
    return null;
  }
  return null;
}

function ResultLink({ client, id, result }: { client: DaemonClient; id: string; result: ExecRequestDetail['results'][number] }) {
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const target = resultUrl(result.url, id);
  if (!target) return null;
  const label = result.title || result.kind;

  async function openFile() {
    if (!target?.daemonFile || opening) return;
    setOpening(true);
    setError('');
    try {
      const response = await client.fetchResponse(target.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = decodeURIComponent(target.url.split('/').at(-1) ?? label);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch {
      setError('결과 파일을 열지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <li className="rounded-lg border border-border bg-background px-4 py-3 text-sm">
      {target.daemonFile ? (
        <button type="button" onClick={() => void openFile()} disabled={opening} className="font-medium text-primary underline underline-offset-4 disabled:opacity-50">
          {opening ? '여는 중…' : label}
        </button>
      ) : (
        <a href={target.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">{label}</a>
      )}
      <span className="ml-2 text-muted-foreground">{result.seat.toUpperCase()}</span>
      {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
    </li>
  );
}

export default function ExecPage() {
  const { client } = useDaemon();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [items, setItems] = useState<ExecRequestItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState('');
  const [sendError, setSendError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExecRequestDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const pending = useRef<Map<string, ExecRequestItem>>(new Map());
  const connectionGeneration = useRef(0);
  const polling = items.some(item => item.status === 'planning' || item.status === 'running');
  const selectedStatus = items.find(item => item.id === selectedId)?.status;

  useEffect(() => {
    connectionGeneration.current += 1;
    pending.current = new Map();
    setText('');
    setSending(false);
    setItems([]);
    setLoaded(false);
    setListError('');
    setSendError('');
    setSelectedId(null);
    setDetail(null);
    setDetailError('');
    return () => { connectionGeneration.current += 1; };
  }, [client]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await client.listExecRequests();
        if (!active) return;
        for (const item of response.items) pending.current.delete(item.id);
        setItems([...pending.current.values(), ...response.items]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
        setListError('');
      } catch {
        if (active) setListError('맡긴 일을 읽지 못했습니다. 연결을 확인해 주세요.');
      } finally {
        inFlight = false;
        if (active) setLoaded(true);
      }
    }
    void refresh();
    const timer = polling ? setInterval(() => void refresh(), 5_000) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [client, polling]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await client.getExecRequest(selectedId!);
        if (!active) return;
        setDetail(response);
        setDetailError('');
      } catch {
        if (active) setDetailError('상세를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const timer = selectedStatus === 'planning' || selectedStatus === 'running'
      ? setInterval(() => void refresh(), 5_000) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [client, selectedId, selectedStatus]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    const generation = connectionGeneration.current;
    setSending(true);
    setSendError('');
    try {
      const accepted = await client.submitExecRequest(value);
      if (connectionGeneration.current !== generation) return;
      const item: ExecRequestItem = { id: accepted.id, text: value, createdAt: new Date().toISOString(), status: accepted.status, seats: [], resultCount: 0 };
      pending.current.set(item.id, item);
      setItems(previous => [item, ...previous.filter(existing => existing.id !== item.id)]);
      setText('');
    } catch {
      if (connectionGeneration.current === generation) setSendError('보내지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      if (connectionGeneration.current === generation) setSending(false);
    }
  }

  const selected = items.find(item => item.id === selectedId);
  const displayedDetail = detail?.id === selectedId ? detail : null;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 px-5 py-10 sm:py-14">
      <section aria-labelledby="exec-compose" className="space-y-4">
        <div>
          <h1 id="exec-compose" className="text-2xl font-semibold tracking-tight">COO 에게 맡기기</h1>
          <p className="mt-2 text-sm text-muted-foreground">할 일을 한 줄로 적어 보내세요. 자리별 진행과 결과를 여기서 볼 수 있습니다.</p>
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <label htmlFor="exec-text" className="sr-only">한 줄로 맡길 일</label>
          <input id="exec-text" name="text" value={text} onChange={event => setText(event.target.value)} placeholder="한 줄로 맡길 일" className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          <button type="submit" disabled={!text.trim() || sending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{sending ? '보내는 중…' : '보내기'}</button>
        </form>
        {sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}
      </section>

      <section aria-labelledby="exec-list" className="space-y-3">
        <h2 id="exec-list" className="text-xl font-semibold">맡긴 일</h2>
        {listError && <p role="alert" className="text-sm text-destructive">{listError}</p>}
        {!loaded && items.length === 0 && <p className="text-sm text-muted-foreground">불러오는 중…</p>}
        {loaded && items.length === 0 && !listError && <p className="text-sm text-muted-foreground">아직 맡긴 일이 없습니다.</p>}
        <ul className="space-y-2">
          {items.map(item => (
            <li key={item.id}>
              <button type="button" onClick={() => { if (selectedId === item.id) return; setSelectedId(item.id); setDetail(null); setDetailError(''); }} aria-expanded={selectedId === item.id} className="w-full rounded-xl border border-border bg-card p-4 text-left hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-semibold">{firstLine(item.text)}</span>
                  <span className="shrink-0 text-sm font-medium text-primary">{requestLabel(item.status)}</span>
                </span>
                {item.seats.length > 0 && <span className="mt-2 block truncate text-xs text-muted-foreground">{item.seats.map(seat => `${seat.seat.toUpperCase()} ${seatLabel(seat.status)}`).join(' · ')}</span>}
                {item.resultCount > 0 && <span className="mt-1 block text-xs text-muted-foreground">결과 {item.resultCount}개</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selectedId && (
        <section aria-labelledby="exec-detail" className="space-y-5 rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 id="exec-detail" className="text-lg font-semibold">맡긴 일 상세</h2>
            <button type="button" onClick={() => { setSelectedId(null); setDetail(null); }} className="text-sm text-primary underline underline-offset-4">닫기</button>
          </div>
          <p className="whitespace-pre-wrap text-sm">{displayedDetail?.text ?? selected?.text}</p>
          <p className="text-sm text-muted-foreground">{requestLabel(displayedDetail?.status ?? selected?.status ?? 'planning')}</p>
          {detailError && <p role="alert" className="text-sm text-destructive">{detailError}</p>}
          {!displayedDetail && !detailError && <p className="text-sm text-muted-foreground">상세 불러오는 중…</p>}
          {displayedDetail && (
            <>
              {displayedDetail.summary && <p className="text-sm">{displayedDetail.summary}</p>}
              <div className="space-y-2">
                <h3 className="font-semibold">이렇게 나눠 맡겼습니다</h3>
                {displayedDetail.seats.length === 0 && <p className="text-sm text-muted-foreground">{displayedDetail.status === 'planning' ? 'COO 가 나누는 중입니다' : '맡은 자리가 없습니다'}</p>}
                <ul className="space-y-2">
                  {displayedDetail.seats.map(seat => (
                    <li key={`${seat.seat}:${seat.title}`} className="rounded-lg border border-border bg-background px-4 py-3 text-sm">
                      <div className="flex justify-between gap-2"><span className="font-semibold">{seat.seat.toUpperCase()} · {seat.title}</span><span className="shrink-0 text-muted-foreground">{seatLabel(seat.status)}</span></div>
                      {seat.status === 'failed' && seat.reason && <p className="mt-2 text-destructive">못 한 이유 · {seat.reason}</p>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold">결과</h3>
                {displayedDetail.results.length === 0 && <p className="text-sm text-muted-foreground">아직 결과가 없습니다.</p>}
                <ul className="space-y-2">{displayedDetail.results.map(result => <ResultLink key={result.url} client={client} id={displayedDetail.id} result={result} />)}</ul>
              </div>
              {displayedDetail.approvals.length > 0 && <div className="space-y-2"><h3 className="font-semibold">게시 승인</h3><ul className="space-y-1">{displayedDetail.approvals.map(approval => <li key={`${approval.graphId}:${approval.runId}`} className="text-sm">{approval.message}</li>)}</ul></div>}
            </>
          )}
        </section>
      )}
    </main>
  );
}
