'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { forkSession } from '@/lib/daemon-session';
import { useSessions } from '@/lib/use-sessions';
import type { SessionSummary } from '@/lib/sessions-service';
import { SessionsStoreApi, type SessionStoreCard } from '@/lib/sessions-store-api';
import { ProjectsApi, type Project } from '@/lib/projects-api';
import { ChatProjectSwitcher, PROJECT_SELECTION_KEY, PROJECT_PENDING_CHANGED, PROJECTS_CHANGED, notifyProjectsChanged, readPendingProjects, writePendingProjects } from './ChatProjectSwitcher';

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

// Device state is optional: storage may be missing (server render, tests) or throw (private mode).
function readStore(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, value: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* best effort */ }
}

export function ChatConversationList({ onSelect }: { onSelect?: () => void }) {
  const daemon = useDaemon();
  const sessions = useSessions({ activePoll: true });
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selection, setSelection] = useState('all');
  const [cards, setCards] = useState<SessionStoreCard[]>([]);
  const [pending, setPending] = useState<Record<string, string>>(readPendingProjects);
  useEffect(() => {
    const refresh = () => {
      setPending(readPendingProjects());
      setFailedAssignment({});
    };
    window.addEventListener(PROJECT_PENDING_CHANGED, refresh);
    return () => window.removeEventListener(PROJECT_PENDING_CHANGED, refresh);
  }, []);
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [failedAssignment, setFailedAssignment] = useState<Record<string, string>>({});
  const assigning = useRef<Set<string>>(new Set());
  const updatePending = (update: (current: Record<string, string>) => Record<string, string>) => {
    const next = update(readPendingProjects());
    writePendingProjects(next);
    setPending(next);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSelection(readStore(PROJECT_SELECTION_KEY) ?? 'all');
    let alive = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void new ProjectsApi(daemon.client).list().then((body) => {
        if (alive && current === request) setProjects(body.projects ?? []);
      }).catch(() => {});
    };
    refresh();
    window.addEventListener(PROJECTS_CHANGED, refresh);
    return () => { alive = false; window.removeEventListener(PROJECTS_CHANGED, refresh); };
  }, [daemon.client]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let alive = true;
    const filter = projects.length > 0 && selection !== 'all' && selection !== 'none' ? `?projectId=${encodeURIComponent(selection)}` : '';
    void daemon.client.fetchJson<{ sessions: SessionStoreCard[] }>(`/v1/sessions/store${filter}`).then((body) => {
      if (!alive) return;
      const next = body.sessions ?? [];
      setCards(next);
      setTitles(Object.fromEntries(next.map((card) => [card.id, card.title])));
    }).catch(() => {});
    return () => { alive = false; };
  }, [daemon.client, sessions, projects, selection]);
  useEffect(() => {
    const missing = Object.keys(pending).filter((id) => sessions.some((s) => s.id === id) && !cards.some((card) => card.id === id));
    if (missing.length === 0) return;
    let alive = true;
    for (const id of missing) {
      void daemon.client.fetchJson<{ meta?: SessionStoreCard }>(`/v1/sessions/store/${encodeURIComponent(id)}?ifExists=1`).then((body) => {
        if (alive && body.meta) setCards((previous) => previous.some((card) => card.id === id) ? previous : [...previous, body.meta!]);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [cards, daemon.client, pending, sessions]);
  useEffect(() => {
    for (const [id, projectId] of Object.entries(pending)) {
      if (id === daemon.sessionId || failedAssignment[id] === projectId || !sessions.some((s) => s.id === id) || assigning.current.has(id)) continue;
      const card = cards.find((item) => item.id === id);
      if (!card || readPendingProjects()[id] !== projectId) continue;
      if (card.projectId === projectId || assigned[id] === projectId) {
        updatePending((current) => { const next = { ...current }; delete next[id]; return next; });
        continue;
      }
      assigning.current.add(id);
      void new ProjectsApi(daemon.client).assign(id, projectId).then(() => {
        setAssigned((previous) => ({ ...previous, [id]: projectId }));
        setCards((previous) => previous.map((item) => item.id === id ? { ...item, projectId } : item));
        if (readPendingProjects()[id] === projectId) {
          updatePending((current) => { const next = { ...current }; delete next[id]; return next; });
        }
      }).catch(() => {
        setFailedAssignment((previous) => ({ ...previous, [id]: projectId }));
        if (readPendingProjects()[id] === projectId) {
          updatePending((current) => { const next = { ...current }; delete next[id]; return next; });
        }
      }).finally(() => { assigning.current.delete(id); });
    }
  }, [assigned, failedAssignment, cards, daemon.client, daemon.sessionId, pending, sessions]);
  const activeSelection = projects.some((project) => project.id === selection) || selection === 'none' ? selection : 'all';
  const visible = projects.length === 0 || activeSelection === 'all' ? sessions
    : sessions.filter((s) => {
      if (pending[s.id]) return pending[s.id] === activeSelection;
      if (activeSelection === 'none') return !cards.some((card) => card.id === s.id && card.projectId) && !assigned[s.id];
      return assigned[s.id] === activeSelection || cards.some((card) => card.id === s.id && card.projectId === activeSelection);
    });
  const filtered = [...visible]
    .filter((s) => `${conversationTitle(s, titles[s.id])} ${s.lastMsgPreview ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt));

  const start = () => {
    const id = forkSession();
    if (projects.length > 0 && activeSelection !== 'all' && activeSelection !== 'none') {
      updatePending((previous) => ({ ...previous, [id]: activeSelection }));
    }
    daemon.setSessionId(id);
    onSelect?.();
  };

  return (
    <nav aria-label="대화 목록" className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 space-y-3 border-b border-border p-3">
        <ChatProjectSwitcher projects={projects} selection={activeSelection} onChange={(value) => {
          setSelection(value);
          writeStore(PROJECT_SELECTION_KEY, value);
        }} onCreate={async (name) => {
          const { project } = await new ProjectsApi(daemon.client).create(name);
          setProjects((previous) => [...previous, project]);
          setSelection(project.id);
          writeStore(PROJECT_SELECTION_KEY, project.id);
          notifyProjectsChanged();
        }} />
        <button type="button" onClick={start} className="flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Plus className="h-4 w-4" aria-hidden="true" /> 새 대화
        </button>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 focus-within:ring-2 focus-within:ring-ring">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input aria-label="대화 검색" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="대화 검색" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div className="space-y-3 px-2 py-8 text-center text-sm text-muted-foreground">
            <p>아직 대화가 없습니다</p>
            <button type="button" onClick={start} className="rounded-lg border border-border px-3 py-2 text-foreground hover:bg-muted">＋ 새 대화</button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">검색 결과가 없습니다</p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((s) => (
              <li key={s.id}>
                <button type="button" aria-current={daemon.sessionId === s.id ? 'page' : undefined} onClick={() => { notifyProjectsChanged(); daemon.setSessionId(s.id); onSelect?.(); }} className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${daemon.sessionId === s.id ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/25' : 'text-foreground hover:bg-muted'}`}>
                  <span className="block truncate text-sm font-medium">{conversationTitle(s, titles[s.id])}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">{conversationTime(s.lastTurnAt)} · {s.msgCount}개 메시지</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
