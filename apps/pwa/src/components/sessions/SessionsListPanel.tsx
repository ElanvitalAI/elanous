'use client';

// ── 라이브 세션 리스트 (S2 · 2026-07-09) ──────────────────────────────────
//
// 대표 지시: PWA 세션에 대화중 세션이 안 뜨고 내용보기·복사·fork 불가. on-disk
// 세션 표면(/v1/sessions/store)을 리스트로 — REFRESH + 각 행 보기/복사/Fork.
// 자동갱신: 10s polling + novelty detection(head id/total 변화 시 갱신·orca/hermes).
// 외부 참조 패턴: codex(forked_from_id 계보)·orca(throttled refresh)·hermes(novelty).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import {
  SessionsStoreApi, relativeTime,
  type SessionStoreCard, type SessionTranscriptMessage,
} from '@/lib/sessions-store-api';

const POLL_MS = 10_000;

/** 세션 표면 종류 유도 — SourceBadge 와 필터칩이 공유(origin 우선·source 폴백). */
type SessionKind = 'cli' | 'telegram' | 'pwa';
function sessionKind(s: { source: string; origin?: string }): SessionKind {
  return s.origin === 'pwa' ? 'pwa' : s.source === 'telegram' || s.origin === 'tg' ? 'telegram' : 'cli';
}

function SourceBadge({ source, origin }: { source: string; origin?: string }) {
  // origin 우선(pwa/tg) → source 폴백. PWA 챗 write-through 세션 구분.
  const kind = sessionKind({ source, origin });
  const meta = kind === 'telegram'
    ? { label: '텔레그램', tone: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' }
    : kind === 'pwa'
      ? { label: 'PWA 챗', tone: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30' }
      : { label: 'CLI', tone: 'bg-slate-500/15 text-slate-300 ring-slate-500/30' };
  return <span className={['rounded px-1.5 py-0.5 text-[11px] ring-1', meta.tone].join(' ')}>{meta.label}</span>;
}

// P2 타임트래블(S3): 사용자 발화 행에 "여기서 갈라치기" — 그 발화 직전까지 복사한
// 새 세션으로 분기. userIndex 는 전체 transcript 의 user 발화 1-based 순번
// (엔진 truncateBeforeNthUser 와 동일 계산 — user/assistant 필터가 user 순번을
// 바꾸지 않으므로 shown 위에서 세어도 동치).
function Transcript({ messages, onTimeTravel, busy }: {
  messages: SessionTranscriptMessage[];
  onTimeTravel?: (beforeUser: number) => void;
  busy?: boolean;
}) {
  const shown = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (shown.length === 0) return <p className="text-xs text-muted-foreground">메시지 없음.</p>;
  let userIndex = 0;
  const rows = shown.map((m) => ({ m, userIndex: m.role === 'user' ? ++userIndex : 0 }));
  return (
    <div className="max-h-[360px] space-y-2 overflow-y-auto rounded-md border border-border bg-background/50 p-2.5">
      {rows.map(({ m, userIndex: uIdx }, i) => (
        <div key={i} className={['group/msg text-sm', m.role === 'user' ? 'text-foreground/90' : 'text-muted-foreground'].join(' ')}>
          <span className={['mr-1.5 rounded px-1 py-0.5 text-[10px] ring-1',
            m.role === 'user' ? 'bg-primary/15 text-primary ring-primary/30' : 'bg-muted text-muted-foreground ring-border'].join(' ')}>
            {m.role === 'user' ? '나' : 'elanous'}
          </span>
          {m.role === 'user' && onTimeTravel && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onTimeTravel(uIdx)}
              title={`이 발화 직전으로 갈라치기 — u${uIdx} 부터는 미포함 (원본 불변)`}
              className="mr-1.5 rounded px-1 py-0.5 text-[10px] text-violet-300 ring-1 ring-violet-500/30 transition-opacity hover:bg-violet-500/15 disabled:opacity-30 md:opacity-0 md:focus:opacity-100 md:group-hover/msg:opacity-100"
            >
              ⑂ 여기서 갈라치기
            </button>
          )}
          <span className="whitespace-pre-wrap">{m.content.slice(0, 2000)}</span>
        </div>
      ))}
    </div>
  );
}

function SessionRow({ api, s, onForked, onDeleted }: { api: SessionsStoreApi; s: SessionStoreCard; onForked: () => void; onDeleted: () => void }) {
  const router = useRouter();
  const { setSessionId } = useDaemon();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<SessionTranscriptMessage[] | null>(null);
  const [busy, setBusy] = useState<null | 'load' | 'copy' | 'fork' | 'open' | 'delete'>(null);

  const loadTranscript = useCallback(async (): Promise<SessionTranscriptMessage[] | null> => {
    if (messages) return messages;
    setBusy('load');
    try { const r = await api.transcript(s.id); setMessages(r.messages); return r.messages; }
    catch (e) { toast.error(`불러오기 실패: ${e instanceof Error ? e.message : String(e)}`); return null; }
    finally { setBusy(null); }
  }, [api, s.id, messages]);

  const toggle = useCallback(async () => {
    const next = !open; setOpen(next);
    if (next && !messages) await loadTranscript();
  }, [open, messages, loadTranscript]);

  const copy = useCallback(async () => {
    setBusy('copy');
    try {
      const msgs = await loadTranscript();
      if (!msgs) return;
      const text = msgs.filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `[${m.role === 'user' ? '나' : 'elanous'}] ${m.content}`).join('\n\n');
      await navigator.clipboard.writeText(text);
      toast.success(`복사 완료 (${msgs.length} 메시지)`);
    } catch (e) { toast.error(`복사 실패: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  }, [loadTranscript]);

  // 완전 무결 이어가기(R5) — PWA 챗 sessionId 를 지정 세션으로 설정하고 /chat 이동.
  // 데몬 read-through 가 그 세션의 on-disk 히스토리를 backend context 로 로드 → 실제로
  // 이어감. fork 된 세션(정상 on-disk 세션)도 동일 경로로 부모 맥락 이어받음.
  const openSession = useCallback((id: string, msg: string) => {
    setSessionId(id);
    toast.success(msg);
    router.push('/chat');
  }, [setSessionId, router]);

  // Fork & 이어가기(원클릭) — 히스토리 복사 새 세션 생성 후 바로 그 세션을 chat 에서 이어감.
  // read-through 가 복사된 맥락을 로드하므로 fork 지점에서 발산 대화 가능(원본 불변).
  const fork = useCallback(async () => {
    setBusy('fork');
    try {
      const r = await api.fork(s.id);
      if (r.ok && r.id) { onForked(); openSession(r.id, `Fork 생성 — 이어갑니다 (${r.id.slice(0, 8)}…)`); }
      else toast.error(`Fork 실패: ${r.error ?? '알 수 없음'}`);
    } catch (e) { toast.error(`Fork 실패: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  }, [api, s.id, onForked, openSession]);

  // P2 타임트래블 — N번째 사용자 발화 직전으로 절단 fork 후 바로 이어감(fork 와 동형).
  const timeTravel = useCallback(async (beforeUser: number) => {
    setBusy('fork');
    try {
      const r = await api.fork(s.id, { beforeUser });
      if (r.ok && r.id) { onForked(); openSession(r.id, `⑂ u${beforeUser} 직전으로 갈라치기 — 이어갑니다 (${r.id.slice(0, 8)}…)`); }
      else toast.error(`갈라치기 실패: ${r.error ?? '알 수 없음'}`);
    } catch (e) { toast.error(`갈라치기 실패: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  }, [api, s.id, onForked, openSession]);

  const openInChat = useCallback(() => openSession(s.id, '이 대화로 이어갑니다'), [openSession, s.id]);

  const del = useCallback(async () => {
    if (!window.confirm(`이 대화를 지울까요? 복구할 수 없습니다.\n\n"${s.title || s.id.slice(0, 8)}"`)) return;
    setBusy('delete');
    try {
      const r = await api.delete(s.id);
      if (r.ok) { toast.success('대화를 지웠습니다'); onDeleted(); }
      else toast.error(`삭제 실패: ${r.error ?? '알 수 없음'}`);
    } catch (e) { toast.error(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  }, [api, s.id, s.title, onDeleted]);

  return (
    <div className="rounded-lg border border-border bg-card/50">
      <div className="flex items-start gap-3 p-3">
        <button type="button" onClick={() => void toggle()} className="mt-0.5 text-muted-foreground">{open ? '▾' : '▸'}</button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={s.source} origin={s.origin} />
            {s.active && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/30">대화중</span>}
            {s.forkedFromId && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 ring-1 ring-violet-500/30">↳ fork</span>}
            <span className="text-[11px] text-muted-foreground">{s.messageCount} 메시지 · {relativeTime(s.updatedAt)}</span>
          </div>
          <p className="truncate text-sm font-medium text-foreground/90">{s.title || '(제목 없음)'}</p>
          {s.preview && <p className="truncate text-xs text-muted-foreground">{s.preview}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void toggle()}>{open ? '닫기' : '보기'}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void copy()}>{busy === 'copy' ? '…' : '복사'}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => openInChat()}>이어가기</Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void fork()}>{busy === 'fork' ? '…' : 'Fork'}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void del()} className="text-rose-400 hover:text-rose-300" title="대화 지우기(복구 불가)">{busy === 'delete' ? '…' : '삭제'}</Button>
        </div>
      </div>
      {open && (
        <div className="border-t border-border px-4 py-3">
          {busy === 'load' && <p className="text-xs text-muted-foreground">불러오는 중…</p>}
          {messages && (
            <Transcript
              messages={messages}
              busy={!!busy}
              onTimeTravel={(n) => void timeTravel(n)}
            />
          )}
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{s.id}</p>
        </div>
      )}
    </div>
  );
}

export function SessionsListPanel() {
  const { client } = useDaemon();
  const api = useMemo(() => new SessionsStoreApi(client), [client]);
  const [sessions, setSessions] = useState<SessionStoreCard[] | null>(null);
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [query, setQuery] = useState('');                       // P5 검색창
  const [kindFilter, setKindFilter] = useState<'all' | SessionKind>('all');  // P5 서피스 필터칩
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>('');
  const sigRef = useRef<string>('');   // novelty detection 서명(head id + total)

  const load = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    setErr(null);
    try {
      const r = await api.list(includeEmpty);
      const sig = `${r.total}:${r.sessions[0]?.id ?? ''}:${r.sessions[0]?.updatedAt ?? ''}`;
      // novelty: 서명 변화 시에만 리스트 교체(펼침 상태 흔들림 최소화).
      if (sig !== sigRef.current || !silent) {
        sigRef.current = sig;
        setSessions(r.sessions);
      }
      setLastSync(new Date().toLocaleTimeString());
    } catch (e) { if (!silent) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (!silent) setBusy(false); }
  }, [api, includeEmpty]);

  useEffect(() => { void load(); }, [load]);

  // 자동갱신(S3a) — SSE 즉시 push(세션 생성/갱신 시 <1s) + 10s polling 폴백.
  useEffect(() => {
    const h = setInterval(() => { void load(true); }, POLL_MS);
    let es: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    if (typeof window !== 'undefined') {
      const url = client.sessionStoreEventsUrl();
      if (url) {
        try {
          es = new EventSource(url);
          const onSession = () => {
            // 다발 이벤트 coalesce(500ms) 후 silent refresh.
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => { void load(true); }, 500);
          };
          es.addEventListener('session.created', onSession);
          es.addEventListener('session.updated', onSession);
          // 서버가 event 명 없이 보내면 onmessage 로도 수신.
          es.onmessage = onSession;
        } catch { es = null; }
      }
    }
    return () => {
      clearInterval(h);
      if (debounce) clearTimeout(debounce);
      es?.close();
    };
  }, [load, client]);

  // P5 (2026-07-16) — 검색창 + 서피스 필터칩. 로드된 목록을 클라 필터(제목·프리뷰·id·서피스).
  const filtered = useMemo(() => {
    if (!sessions) return null;
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (kindFilter !== 'all' && sessionKind(s) !== kindFilter) return false;
      if (!q) return true;
      return (s.title ?? '').toLowerCase().includes(q)
        || (s.preview ?? '').toLowerCase().includes(q)
        || s.id.toLowerCase().includes(q);
    });
  }, [sessions, query, kindFilter]);

  const activeCount = sessions?.filter((s) => s.active).length ?? 0;
  const kindCounts = useMemo(() => {
    const c = { all: sessions?.length ?? 0, cli: 0, telegram: 0, pwa: 0 };
    for (const s of sessions ?? []) c[sessionKind(s)] += 1;
    return c;
  }, [sessions]);
  const CHIPS: Array<{ key: 'all' | SessionKind; label: string }> = [
    { key: 'all', label: '전체' }, { key: 'cli', label: 'CLI' },
    { key: 'telegram', label: '텔레그램' }, { key: 'pwa', label: 'PWA' },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">대화 목록 <span className="text-sm font-normal text-muted-foreground">CLI · 텔레그램</span></h1>
          <p className="text-xs text-muted-foreground">
            {sessions
              ? (filtered && filtered.length !== sessions.length
                  ? `${filtered.length}/${sessions.length}개 · 대화중 ${activeCount}`
                  : `${sessions.length}개 · 대화중 ${activeCount}`)
              : '불러오는 중…'}
            {lastSync && <span className="ml-2">· 자동 갱신 {lastSync}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={includeEmpty} onChange={(e) => setIncludeEmpty(e.target.checked)} />
            빈 대화
          </label>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{busy ? '…' : '새로고침'}</Button>
        </div>
      </div>
      {/* P5 검색창 + 서피스 필터칩 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="대화 검색 (제목·내용·id)"
          aria-label="대화 검색"
          className="min-w-[180px] flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-sm outline-none ring-primary/30 focus:ring-2"
        />
        <div className="flex items-center gap-1">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setKindFilter(c.key)}
              className={['rounded-full px-2.5 py-1 text-[11px] ring-1 transition-colors',
                kindFilter === c.key
                  ? 'bg-primary/20 text-primary ring-primary/40'
                  : 'bg-muted/40 text-muted-foreground ring-border hover:bg-muted'].join(' ')}
            >
              {c.label}{c.key === 'all' || kindCounts[c.key] > 0 ? ` ${kindCounts[c.key]}` : ''}
            </button>
          ))}
        </div>
      </div>
      {err && <p className="text-xs text-rose-400">{err}</p>}
      {sessions && sessions.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          대화가 없습니다. 텔레그램이나 CLI에서 대화를 시작하면 여기에 나타납니다.
        </p>
      )}
      {filtered && sessions && sessions.length > 0 && filtered.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {query || kindFilter !== 'all' ? '검색·필터 결과가 없습니다.' : '대화가 없습니다.'}
        </p>
      )}
      {filtered && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((s) => <SessionRow key={s.id} api={api} s={s} onForked={() => void load()} onDeleted={() => void load()} />)}
        </div>
      )}
    </div>
  );
}
