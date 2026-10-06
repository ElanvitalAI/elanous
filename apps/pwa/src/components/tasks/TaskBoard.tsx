'use client';

import { maskCardsForPublic } from './card-public';
import { maskValueForPublic } from '@/lib/live-public';
import { cardMetaParts } from './card-meta';
import { useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { boardColumn, cardTitle, foldCard, type BoardColumn, type TaskCard, type TaskCardEntry, type TaskCardSection } from '@/lib/task-card-model';
import { createNexusClient, NexusApiError, type TaskCardWire, type WishPlacementWire } from '@/nexus/client';
import { TaskCardDetail } from './TaskCardDetail';

const COLUMNS: BoardColumn[] = ['steward', 'execution', 'landing', 'release', 'done'];
const SECTIONS = new Set<TaskCardSection>([
  'intake', 'triage', 'gates', 'relations', 'memory', 'workspace', 'run', 'landing', 'release', 'incidents',
]);

/** The card journal is append-only; group entries before folding each task. */
/** How often the board re-reads cards (the steward adds them on its own schedule). */
export const BOARD_REFRESH_MS = 10_000;

export function cardsFromEntries(entries: readonly TaskCardEntry[]): TaskCard[] {
  const byTask = new Map<string, TaskCardEntry[]>();
  for (const entry of entries) {
    const group = byTask.get(entry.taskId) ?? [];
    group.push(entry);
    byTask.set(entry.taskId, group);
  }
  return Array.from(byTask.values()).map(foldCard).filter((card): card is TaskCard => card !== null);
}

/** Translate the read-only task-card API into the board's section model. */
export function cardFromWire(wire: TaskCardWire): TaskCard {
  const entries: TaskCardEntry[] = [];
  const createdAt = Date.parse(wire.createdAt);
  const replySection = wire.sections.find(section => section.key === 'intake:reply:0');
  let wishReply: TaskCard['wishReply'] = null;
  if (replySection) {
    try {
      const value: unknown = JSON.parse(replySection.content);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const { surface, address } = value as Record<string, unknown>;
        if (typeof surface === 'string' && (typeof address === 'string' || address === null)) wishReply = { surface, address };
      }
    } catch { /* An unreadable address is not a usable reply destination. */ }
  }
  for (const section of wire.sections) {
    if (!SECTIONS.has(section.key as TaskCardSection)) continue;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(section.content);
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown> : { content: section.content };
    } catch {
      data = { content: section.content };
    }
    const ts = Date.parse(section.createdAt);
    entries.push({ taskId: wire.id, section: section.key as TaskCardSection,
      key: `${section.key}:${section.createdAt}:${entries.length}`, owner: section.owner,
      ts: Number.isFinite(ts) ? ts : createdAt, data,
      ...(typeof data.runId === 'string' ? { runId: data.runId } : {}),
    });
  }
  if (entries.length === 0) {
    entries.push({ taskId: wire.id, section: 'triage', key: 'api:title', owner: 'task-card API',
      ts: createdAt, data: { title: wire.title } });
  }
  if (wire.status === 'closed') {
    const lastRelease = entries.filter((entry) => entry.section === 'release')
      .sort((a, b) => b.ts - a.ts)[0];
    entries.push({ taskId: wire.id, section: 'release', key: 'api:closed', owner: 'task-card API',
      ts: Math.max(createdAt, ...entries.map((entry) => entry.ts)),
      data: { ...lastRelease?.data, status: 'done' } });
  }
  return { ...foldCard(entries)!, apiTitle: wire.title, status: wire.status,
    ...(wire.closedReason === undefined ? {} : { closedReason: wire.closedReason }),
    ...(wire.goalId.startsWith('wish:') ? { wishReply } : {}) };
}

export function openIncidentCount(card: TaskCard): number {
  const latest = new Map<string, TaskCardEntry>();
  for (const entry of card.incidents) {
    const id = entry.data.incidentId ?? entry.data.id;
    const identity = typeof id === 'string' && id.trim() ? id : entry.key;
    const previous = latest.get(identity);
    if (!previous || entry.ts >= previous.ts) latest.set(identity, entry);
  }
  return Array.from(latest.values()).filter((entry) =>
    entry.data.status !== 'closed' && entry.data.status !== 'resolved').length;
}

/** 같은 카드 재선택인가 — 그러면 상세를 비우지 않고 그대로 둔다. */
export function isSameSelection(current: string | null, next: string | null): boolean {
  return next !== null && current === next;
}

export function TaskBoardView({ cards, selectedId, onSelect, selectedCard, detailError, placements, onCloseCard, publicCapture }: {
  cards: readonly TaskCard[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  selectedCard?: TaskCard | null;
  detailError?: string | null;
  placements?: readonly WishPlacementWire[];
  onCloseCard?: (reason: string) => Promise<void>;
  publicCapture?: boolean;
}) {
  const selected = selectedCard?.taskId === selectedId ? selectedCard : null;
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">보드</h1>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((column) => (
          <section key={column} aria-label={`${column} column`} className="min-w-0 space-y-2 rounded-xl border border-border p-3">
            <h2 className="text-sm font-semibold capitalize">{column}</h2>
            {cards.filter((card) => boardColumn(card) === column).map((card) => (
              <button key={card.taskId} type="button" onClick={() => onSelect(card.taskId)}
                aria-pressed={selectedId === card.taskId}
                className="w-full rounded-lg border border-border bg-card p-3 text-left text-sm hover:bg-accent/40">
                <span className="block font-medium">{cardTitle(card)}</span>
                <span className="block text-xs text-muted-foreground">
                  <time dateTime={new Date(card.updatedAt).toISOString()} title={new Date(card.updatedAt).toLocaleString()}>{cardMetaParts(card, openIncidentCount(card), Date.now()).join(' · ')}</time>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
      {selectedId && (
        <aside className="max-w-3xl space-y-2" aria-label="Selected card">
          <button type="button" onClick={() => onSelect(null)} aria-label="Close card detail" className="text-sm text-muted-foreground">Close</button>
          {selected ? <TaskCardDetail card={selected} placements={placements} onClose={onCloseCard} publicCapture={publicCapture} /> :
            <p role="status">{detailError ?? 'Loading card detail…'}</p>}
        </aside>
      )}
    </div>
  );
}

export function TaskBoard() {
  const { config } = useDaemon();
  const client = useMemo(() => config.baseUrl
    ? createNexusClient({ baseUrl: config.baseUrl, ...(config.token ? { token: config.token } : {}) })
    : null, [config.baseUrl, config.token]);
  const [cards, setCards] = useState<TaskCard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<TaskCard | null>(null);
  const [placements, setPlacements] = useState<WishPlacementWire[] | undefined>(undefined);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectCard = (id: string | null) => {
    // 같은 카드를 다시 누르면 무시한다 — selectedId 가 안 바뀌면 상세 조회 effect 가 다시 돌지 않아 상세가 «로딩»에 갇힌다(리뷰 R3).
    if (isSameSelection(selectedId, id)) return;
    setSelectedCard(null);
    setPlacements(undefined);
    setDetailError(null);
    setSelectedId(id);
  };

  // «공개 캡처»(`?capture=public`) — 녹화 전에 카드 제목의 호스트·계정·경로·금액을 가린다(Live·Trace 와 같은 가면).
  const [publicCapture, setPublicCapture] = useState(false);
  useEffect(() => { if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('capture') === 'public') setPublicCapture(true); }, []);
  const shownCards = useMemo(() => (publicCapture ? maskCardsForPublic(cards) : cards), [cards, publicCapture]);
  const shownSelectedCard = publicCapture && selectedCard ? maskCardsForPublic([selectedCard])[0] : selectedCard;
  const shownPlacements = publicCapture && placements ? maskValueForPublic(placements, []) : placements;

  useEffect(() => {
    let cancelled = false;
    setCards([]);
    setSelectedId(null);
    setSelectedCard(null);
    setPlacements(undefined);
    setDetailError(null);
    if (!client) {
      setMessage('Connect to NEXUS to load task cards.');
      return;
    }
    setMessage(null);
    const load = () => client.getTaskCards().then(({ cards: loaded }) => {
      if (!cancelled) { setCards(loaded.map(cardFromWire)); setMessage(null); }
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof NexusApiError && error.status === 404
        ? 'Task cards are not available yet (pre-E1).'
        : error instanceof Error ? error.message : String(error));
    });
    void load();
    // The steward writes cards on its own schedule — re-read so new cards appear without a reload.
    const timer = setInterval(() => { void load(); }, BOARD_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client]);

  useEffect(() => {
    if (!client || !selectedId) return;
    let cancelled = false;
    setSelectedCard(null);
    setPlacements(undefined);
    setDetailError(null);
    void client.getTaskCard(selectedId).then(({ card, placements: assigned }) => {
      if (!cancelled) { setPlacements(assigned); setSelectedCard(cardFromWire(card)); }
    }).catch((error: unknown) => {
      if (!cancelled) setDetailError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [client, selectedId]);

  const closeSelectedCard = async (reason: string) => {
    if (!client || !selectedId || publicCapture) throw new Error('Card close unavailable');
    const id = selectedId;
    const { card } = await client.closeTaskCard(id, reason);
    setSelectedCard((current) => current?.taskId === id ? cardFromWire(card) : current);
    setCards((current) => current.map((item) => item.taskId === card.id ? cardFromWire(card) : item));
  };

  return <>{message && <p role="status" className="p-4 text-sm text-muted-foreground">{message}</p>}
    <TaskBoardView cards={shownCards} selectedId={selectedId} selectedCard={shownSelectedCard} detailError={detailError} placements={shownPlacements} onSelect={selectCard} onCloseCard={closeSelectedCard} publicCapture={publicCapture} />
  </>;
}
