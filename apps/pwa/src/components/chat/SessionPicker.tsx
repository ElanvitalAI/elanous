'use client';

// PR #4.5 — Session picker 모달.
//
// `+ chat` 클릭 또는 SessionPill `⌄` → "다른 세션 attach" 가 연다.
// PLAN §3.3 / §3.4 / §3.5 mockup 매핑.
//
// 핵심 동작:
// - 상단 "+ 새 세션" — 새 sessionId mint + close
// - list 항목 클릭 → onPick(sessionId) (caller 가 attach 결정)
// - 이미 attached 항목 → `✓ open in chat#N` + 클릭 시 그 탭 활성
// - 항목 hover/선택 시 🗑 → SessionDeleteConfirm 열기
// - 검색 box (preview text + id prefix + origin facet)
// - 키보드: ↑/↓ navigate · Enter pick · Esc close · Cmd+N 새 세션 · Cmd+F search

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, Search } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { generateSessionId } from '@/lib/daemon-session';
import {
  getSessionsService,
  type SessionOrigin,
  type SessionSummary,
} from '@/lib/sessions-service';
import { SessionsStoreApi, resolveSessionPrefix } from '@/lib/sessions-store-api';
import { useSessionsActive } from '@/lib/use-sessions';
import { SessionDeleteConfirm } from './SessionDeleteConfirm';
import { SessionIdChip } from './SessionIdChip';
import { cn } from '@/lib/utils';

export interface SessionPickerProps {
  open: boolean;
  onClose: () => void;
  /** 호출자 callback — 사용자 선택 결과:
   *  - kind:'new' = 새 sessionId mint 요청 · sessionId 동봉
   *  - kind:'existing' = 기존 sessionId attach 요청
   *  - kind:'jumpToTab' = 이미 attached 인 탭 활성 (workspace 가 처리) */
  onPick: (
    pick:
      | { kind: 'new'; sessionId: string }
      | { kind: 'existing'; sessionId: string }
      | { kind: 'jumpToTab'; tabId: string },
  ) => void;
  /** workspace 탭 id 별 attached sessionId — `✓ open in chat#N` 표시
   *  + 중복 attach 차단. key = sessionId, value = { tabId, label }. */
  attachedSessions: Map<string, { tabId: string; label: string }>;
}

const ORIGIN_LABEL: Record<SessionOrigin, string> = {
  cli: 'cli',
  pwa: 'pwa',
  tg: 'tg',
  dc: 'dc',
};

function formatRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60_000);
    if (min < 1) return '방금 전';
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}일 전`;
    return new Date(t).toLocaleDateString();
  } catch {
    return '';
  }
}

export function SessionPicker({
  open,
  onClose,
  onPick,
  attachedSessions,
}: SessionPickerProps) {
  const { client } = useDaemon();
  const svc = getSessionsService(client);
  const storeApi = useMemo(() => new SessionsStoreApi(client), [client]);
  const sessions = useSessionsActive();
  const [query, setQuery] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const [confirm, setConfirm] = useState<SessionSummary | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset 검색/선택 on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelIdx(0);
      setResolveNote(null);
      void svc.forceRefresh();
    }
  }, [open, svc]);

  // 검색어 변경 시 resolve 결과 초기화.
  useEffect(() => { setResolveNote(null); }, [query]);

  const filtered = useMemo<SessionSummary[]>(() => {
    if (!query.trim()) return [...sessions];
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (s.id.toLowerCase().startsWith(q)) return true;
      if (s.lastMsgPreview && s.lastMsgPreview.toLowerCase().includes(q)) return true;
      if (s.origin && q === `[${s.origin}]`) return true;
      if (s.origin && q === s.origin) return true;
      return false;
    });
  }, [sessions, query]);

  // selIdx 가 filtered 범위 밖이면 보정
  useEffect(() => {
    if (selIdx >= filtered.length) {
      setSelIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selIdx]);

  // Focus search on open + 키보드 단축키
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // Cmd/Ctrl + N — 새 세션
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNew();
        return;
      }
      // Cmd/Ctrl + F — search focus
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        const target = filtered[selIdx];
        if (!target) {
          // P3 — 목록에 없는 id prefix 는 Enter 로 store resolve 시도.
          if (query.trim().length >= 4) {
            e.preventDefault();
            void resolvePrefix();
          }
          return;
        }
        e.preventDefault();
        handlePickSession(target);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.target instanceof HTMLInputElement) return; // 검색에서는 정상 동작
        const target = filtered[selIdx];
        if (target) {
          e.preventDefault();
          setConfirm(target);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, filtered, selIdx, onClose, query, resolveBusy]);

  if (!open) return null;

  const handleNew = (): void => {
    const sessionId = generateSessionId();
    onPick({ kind: 'new', sessionId });
  };

  const handlePickSession = (s: SessionSummary): void => {
    const attached = attachedSessions.get(s.id);
    if (attached) {
      onPick({ kind: 'jumpToTab', tabId: attached.tabId });
      return;
    }
    onPick({ kind: 'existing', sessionId: s.id });
  };

  // P3 attach/resolve(2026-07-12) — 목록(비어있지 않은 최근 세션)에 없는 세션도
  // 짧은 id prefix 로 store 에서 resolve 해 이어가기 (디스코드 `!attach <prefix>`
  // 동형). includeEmpty 조회라 빈 세션도 잡는다. 유일 일치만 attach — 모호/0건은
  // 안내만 (신규 엔진 없음 · 기존 store list 재사용).
  const resolvePrefix = async (): Promise<void> => {
    const q = query.trim().toLowerCase();
    if (q.length < 4 || resolveBusy) return;
    setResolveBusy(true);
    try {
      const r = await storeApi.list(true);
      const resolved = resolveSessionPrefix(r.sessions ?? [], q);
      if (resolved.kind === 'one') {
        const attached = attachedSessions.get(resolved.id);
        if (attached) onPick({ kind: 'jumpToTab', tabId: attached.tabId });
        else onPick({ kind: 'existing', sessionId: resolved.id });
      } else if (resolved.kind === 'none') {
        setResolveNote(`'${q}'로 시작하는 대화가 없습니다.`);
      } else {
        setResolveNote(`${resolved.count}개의 대화가 일치합니다. ID를 더 길게 입력하세요.`);
      }
    } catch (e) {
      setResolveNote(`대화를 찾지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResolveBusy(false);
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      await svc.forget(confirm.id);
      setConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="대화 선택"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[min(640px,90vh)] w-[min(640px,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-card shadow-lg"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">대화 선택</h2>
            <button
              type="button"
              aria-label="close"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="shrink-0 px-4 py-3">
            <button
              type="button"
              onClick={handleNew}
              className="flex w-full items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-left hover:bg-primary/15"
            >
              <Plus className="h-5 w-5 text-primary" />
              <div className="flex-1">
                <div className="text-sm font-medium">새 대화 시작</div>
                <div className="text-xs text-muted-foreground">비어있는 새 채팅을 엽니다 (⌘N)</div>
              </div>
            </button>
          </div>

          <div className="shrink-0 border-y border-border bg-muted/30 px-4 py-2">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="대화 검색 — 내용 · ID · [pwa]/[cli]/[tg]/[dc]"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
              {query && (
                <button
                  type="button"
                  aria-label="clear search"
                  onClick={() => setQuery('')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-background"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  {sessions.length === 0 && !query.trim()
                    ? '아직 대화가 없습니다. 위의 "새 대화 시작"으로 첫 대화를 시작하세요.'
                    : '검색과 일치하는 대화가 없습니다.'}
                </p>
                {query.trim().length >= 4 && (
                  <button
                    type="button"
                    disabled={resolveBusy}
                    onClick={() => void resolvePrefix()}
                    className="mt-3 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-300 hover:bg-violet-500/15 disabled:opacity-50"
                  >
                    {resolveBusy ? '찾는 중…' : `ID '${query.trim()}'로 대화 이어가기 (Enter)`}
                  </button>
                )}
                {resolveNote && <p className="mt-2 text-xs text-amber-400">{resolveNote}</p>}
                {sessions.length === 0 && !query.trim() && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    다른 기기(CLI / Telegram / Discord)에서 대화를 시작하면 여기에 자동으로 나타납니다.
                  </p>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((s, i) => {
                  const attached = attachedSessions.get(s.id);
                  const selected = i === selIdx;
                  return (
                    <li key={s.id}>
                      <div
                        className={cn(
                          'group flex items-center gap-3 px-4 py-2.5 transition-colors',
                          selected
                            ? 'bg-primary/10 ring-1 ring-inset ring-primary/30'
                            : 'hover:bg-secondary/50',
                        )}
                        onMouseEnter={() => setSelIdx(i)}
                      >
                        <button
                          type="button"
                          onClick={() => handlePickSession(s)}
                          className="flex min-w-0 flex-1 flex-col items-start text-left"
                        >
                          <div className="flex w-full items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {s.lastMsgPreview ?? <span className="text-muted-foreground italic">(빈 대화)</span>}
                            </span>
                            {attached && (
                              <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                                ✓ {attached.label}에서 열림
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                            {s.origin && (
                              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                                {ORIGIN_LABEL[s.origin]}
                              </span>
                            )}
                            <span>{formatRelative(s.lastTurnAt)}</span>
                            <span>· {s.msgCount} 메시지</span>
                            {/* 2026-05-07 dogfood — 세션 ID 클릭 시
                                자동 복사. SessionIdChip 가 outer
                                "세션 attach" button click 과 충돌
                                안 하도록 stopPropagation 처리. */}
                            <SessionIdChip
                              sessionId={s.id}
                              source="picker"
                              variant="subtle"
                              showCopyIcon={false}
                            />
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={`대화 ${s.id} 지우기`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirm(s);
                          }}
                          className={cn(
                            'shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-500',
                            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                          )}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-border bg-muted/30 px-4 py-2 text-[10px] text-muted-foreground">
            <span className="mr-3">↑↓ 이동</span>
            <span className="mr-3">Enter 선택</span>
            <span className="mr-3">⌘N 새 대화</span>
            <span className="mr-3">⌘F 검색</span>
            <span>Del 지우기</span>
          </div>
        </div>
      </div>

      <SessionDeleteConfirm
        open={confirm !== null}
        session={confirm}
        busy={confirmBusy}
        onCancel={() => setConfirm(null)}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
