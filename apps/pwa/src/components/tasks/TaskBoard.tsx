'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { boardColumn, cardTitle, foldCard, type BoardColumn, type TaskCard, type TaskCardEntry, type TaskCardSection } from '@/lib/task-card-model';
import { createNexusClient, NexusApiError, type TaskCardWire } from '@/nexus/client';
import { TaskCardDetail } from './TaskCardDetail';

const COLUMNS: BoardColumn[] = ['steward', 'execution', 'landing', 'release', 'done'];
const SECTIONS = new Set<TaskCardSection>([
  'intake', 'triage', 'gates', 'relations', 'memory', 'workspace', 'run', 'landing', 'release', 'incidents',
]);

/** The card journal is append-only; group entries before folding each task. */
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
  return { ...foldCard(entries)!, apiTitle: wire.title };
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

export function TaskBoardView({ cards, selectedId, onSelect, selectedCard, detailError }: {
  cards: readonly TaskCard[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  selectedCard?: TaskCard | null;
  detailError?: string | null;
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
                  Incidents {openIncidentCount(card)} · {card.runId?.slice(0, 8) ?? '—'} · <time dateTime={new Date(card.updatedAt).toISOString()}>{new Date(card.updatedAt).toISOString()}</time>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
      {selectedId && (
        <aside className="max-w-3xl space-y-2" aria-label="Selected card">
          <button type="button" onClick={() => onSelect(null)} aria-label="Close card detail" className="text-sm text-muted-foreground">Close</button>
          {selected ? <TaskCardDetail card={selected} /> :
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
  const [detailError, setDetailError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectCard = (id: string | null) => {
    // 같은 카드를 다시 누르면 무시한다 — selectedId 가 안 바뀌면 상세 조회 effect 가 다시 돌지 않아 상세가 «로딩»에 갇힌다(리뷰 R3).
    if (isSameSelection(selectedId, id)) return;
    setSelectedCard(null);
    setDetailError(null);
    setSelectedId(id);
  };

  useEffect(() => {
    let cancelled = false;
    setCards([]);
    setSelectedId(null);
    setSelectedCard(null);
    setDetailError(null);
    if (!client) {
      setMessage('Connect to NEXUS to load task cards.');
      return;
    }
    setMessage(null);
    void client.getTaskCards().then(({ cards: loaded }) => {
      if (!cancelled) setCards(loaded.map(cardFromWire));
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof NexusApiError && error.status === 404
        ? 'Task cards are not available yet (pre-E1).'
        : error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (!client || !selectedId) return;
    let cancelled = false;
    setSelectedCard(null);
    setDetailError(null);
    void client.getTaskCard(selectedId).then(({ card }) => {
      if (!cancelled) setSelectedCard(cardFromWire(card));
    }).catch((error: unknown) => {
      if (!cancelled) setDetailError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [client, selectedId]);

  return <>{message && <p role="status" className="p-4 text-sm text-muted-foreground">{message}</p>}
    <TaskBoardView cards={cards} selectedId={selectedId} selectedCard={selectedCard} detailError={detailError} onSelect={selectCard} />
  </>;
}
