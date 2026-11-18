'use client';

// WEB-CHAT-MINIMAL-SURFACE (대표 11-17 정정 2): the chat sidebar is session management only — one «새 대화», search, the
// list, and per conversation «정보» (the full id, copyable) and «삭제». Projects were removed from the chat screen
// (backup: tag archive/pwa-pre-minimal-20261117).
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { forkSession } from '@/lib/daemon-session';
import { useSessions } from '@/lib/use-sessions';
import { getSessionsService, type SessionSummary } from '@/lib/sessions-service';
import { SessionsStoreApi, type SessionStoreCard } from '@/lib/sessions-store-api';
import { SessionDeleteConfirm } from './SessionDeleteConfirm';

export function conversationTitle(s: SessionSummary, title?: string): string {
  return title?.trim() || s.lastMsgPreview?.trim().split(/\r?\n/)[0]?.trim() || '대화';
}

export function conversationTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return new Date(time).toLocaleDateString();
}

export function ChatConversationList({ onSelect }: { onSelect?: () => void }) {
  const daemon = useDaemon();
  const sessions = useSessions({ activePoll: true });
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // #38183 REVIEW-1: a delete that finds the conversation already gone (another device removed it) is said as such —
  // not as an error and not as a silent success.
  const [notice, setNotice] = useState<string | null>(null);
  // The open conversation at the moment a delete answers (the user may switch while it is in flight).
  const activeRef = useRef(daemon.sessionId);
  activeRef.current = daemon.sessionId;

  // #38183 REVIEW-1: an open conversation menu closes on Esc or on a press outside it (the menu and its toggle excepted).
  useEffect(() => {
    if (menuFor === null || typeof document === 'undefined') return;
    const doc = document; // the same object is unsubscribed, whatever `document` is at cleanup time
    // Captured and stopped: Esc closes only the top layer (this menu), not the phone drawer that holds the list
    // (ChatPanel listens to Esc on document too, and was subscribed first). «삭제» closes the menu before the confirm
    // dialog opens (#38333 REVIEW-1 ①), so while the dialog is up this listener is gone and Esc reaches the dialog.
    const onKey = (event: Event) => {
      // An Esc that ends a Korean (IME) composition belongs to the field being typed in, not to the menu.
      if ((event as KeyboardEvent).key !== 'Escape' || (event as KeyboardEvent).isComposing) return;
      event.stopPropagation();
      setMenuFor(null);
    };
    const onPress = (event: Event) => {
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      if (typeof target?.closest === 'function' && target.closest('[data-elanous-conversation-menu],[data-elanous-conversation-menu-toggle]')) return;
      setMenuFor(null);
    };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('pointerdown', onPress);
    return () => { doc.removeEventListener('keydown', onKey, true); doc.removeEventListener('pointerdown', onPress); };
  }, [menuFor]);

  useEffect(() => {
    if (notice === null) return;
    // 출처: long enough to read one short line; the list itself already shows the result.
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Titles come from the session store; a failed read keeps the preview-based titles.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let alive = true;
    void daemon.client.fetchJson<{ sessions: SessionStoreCard[] }>('/v1/sessions/store').then((body) => {
      if (alive) setTitles(Object.fromEntries((body.sessions ?? []).map((card) => [card.id, card.title])));
    }).catch(() => {});
    return () => { alive = false; };
  }, [daemon.client, sessions]);

  const filtered = [...sessions]
    .filter((s) => `${conversationTitle(s, titles[s.id])} ${s.lastMsgPreview ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt));

  const start = () => {
    daemon.setSessionId(forkSession());
    onSelect?.();
  };

  const copyId = async (id: string) => {
    try { await navigator.clipboard.writeText(id); setCopied(id); setTimeout(() => setCopied(null), 1200); } catch { /* the id stays selectable */ }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    // A notice left from the previous delete must not sit next to this attempt's error.
    setNotice(null);
    try {
      const result = await new SessionsStoreApi(daemon.client).delete(deleting.id);
      setNotice(result?.deleted === false ? '이미 지워진 대화예요 · 목록을 새로 고쳤어요' : null);
      // The open conversation was deleted: continue in a new, empty one. Checked when the answer arrives — a switch
      // made meanwhile is kept, and a switch onto the deleted one is moved off it.
      if (activeRef.current === deleting.id) daemon.setSessionId(forkSession());
      setDeleting(null);
      setMenuFor(null);
      void getSessionsService(daemon.client).forceRefresh();
    } catch (error) {
      // Kept open with the reason: nothing was removed.
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav aria-label="대화 목록" className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 space-y-3 border-b border-border p-3">
        <button type="button" onClick={start} className="flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Plus className="h-4 w-4" aria-hidden="true" /> 새 대화
        </button>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 focus-within:ring-2 focus-within:ring-ring">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input aria-label="대화 검색" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="대화 검색" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      {notice && (
        <p role="status" data-elanous-delete-notice className="mx-3 mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{notice}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">아직 대화가 없습니다</p>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">검색 결과가 없습니다</p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((s) => (
              <li key={s.id} className="relative">
                <button type="button" aria-current={daemon.sessionId === s.id ? 'page' : undefined} onClick={() => { daemon.setSessionId(s.id); onSelect?.(); }} className={`w-full rounded-lg py-2.5 pl-3 pr-9 text-left transition-colors ${daemon.sessionId === s.id ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/25' : 'text-foreground hover:bg-muted'}`}>
                  <span className="block truncate text-sm font-medium">{conversationTitle(s, titles[s.id])}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">{conversationTime(s.lastTurnAt)} · {s.msgCount}개 메시지</span>
                </button>
                <button type="button" data-elanous-conversation-menu-toggle aria-label="대화 관리" aria-expanded={menuFor === s.id} onClick={() => setMenuFor((open) => open === s.id ? null : s.id)} className="absolute right-1.5 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </button>
                {menuFor === s.id && (
                  <div role="menu" data-elanous-conversation-menu className="mt-1 space-y-2 rounded-lg border border-border bg-popover p-2 text-xs shadow-md">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">정보 · 대화 ID</div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 select-all break-all font-mono text-[11px]">{s.id}</span>
                        <button type="button" role="menuitem" aria-label="대화 ID 복사" onClick={() => void copyId(s.id)} className="shrink-0 rounded p-1 hover:bg-secondary">
                          {copied === s.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </div>
                    </div>
                    <button type="button" role="menuitem" onClick={() => { setDeleteError(null); setMenuFor(null); setDeleting(s); }} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-rose-600 hover:bg-secondary">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> 삭제
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <SessionDeleteConfirm open={deleting !== null} session={deleting} busy={busy} error={deleteError} onCancel={() => { setDeleting(null); setDeleteError(null); }} onConfirm={() => void confirmDelete()} />
    </nav>
  );
}
