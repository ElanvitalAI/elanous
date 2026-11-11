import { projectMiniBoard, type MiniBoardCard } from '@/lib/mini-board-projection';
import type { BoardColumn, TaskCardEntry } from '@/lib/task-card-model';

export type MemberBoardState = 'proposed' | 'approved' | 'developing' | 'testing' | 'deployed' | 'failed';

export interface MemberBoardAttachment {
  kind: 'diagram' | 'diagram-source' | 'pdf' | 'html';
  title: string;
  url: string;
  mime: string;
  sha256: string;
  producedBy: string;
}

export interface MemberBoardCard {
  id: string;
  memberId: string;
  title: string;
  state: MemberBoardState;
  progress?: string;
  summary?: string;
  reason?: string;
  runId?: string;
  resultUrl?: string;
  publicUrl?: string;
  retryable?: boolean;
  attachments?: MemberBoardAttachment[];
  updatedAt?: string;
}

export interface BriefingTopic { title?: string; summary?: string; }
export interface BriefingCard {
  id?: string;
  memberId: string;
  day?: string;
  topics?: BriefingTopic[];
  todos?: Array<string | { text?: string }>;
}

export const MINI_BOARD_COLUMNS: readonly { id: BoardColumn; label: string }[] = [
  { id: 'steward', label: '제안' },
  { id: 'landing', label: '승인' },
  { id: 'execution', label: '개발 중' },
  { id: 'release', label: '시험' },
  { id: 'done', label: '배포됨' },
];

const sectionForState: Record<MemberBoardState, TaskCardEntry['section']> = {
  proposed: 'intake', approved: 'landing', developing: 'workspace', testing: 'release', deployed: 'release', failed: 'release',
};

/** Adapt the member API response to the shared JSON event contract; #36158 owns projection semantics. */
export function memberBoardEvents(card: MemberBoardCard): TaskCardEntry[] {
  const parsedAt = card.updatedAt ? Date.parse(card.updatedAt) : NaN;
  const ts = Number.isFinite(parsedAt) ? parsedAt : 0;
  const current: TaskCardEntry = {
    ts,
    taskId: card.id,
    section: sectionForState[card.state],
    owner: 'member board API',
    key: `member-board:${card.id}:${card.state}:${card.updatedAt ?? ''}`,
    ...(card.runId ? { runId: card.runId.replace(/^run-/, '') } : {}),
    data: {
      title: card.title,
      ...((card.summary?.trim() || (card.state === 'failed' ? card.reason?.trim() : undefined) || card.progress?.trim() || card.reason?.trim())
        ? { summary: card.summary?.trim() || (card.state === 'failed' ? card.reason?.trim() : undefined) || card.progress?.trim() || card.reason?.trim() }
        : {}),
      ...(card.progress ? { progress: card.progress } : {}),
      ...(card.reason ? { reason: card.reason } : {}),
      ...(card.state === 'deployed' ? { status: 'done', ...((card.resultUrl || card.publicUrl) ? { resultUrl: card.resultUrl || card.publicUrl } : {}) }
        : card.state === 'failed' ? { status: 'failed' } : card.state === 'testing' ? { status: 'testing' } : {}),
    },
  };
  if (card.state === 'proposed') return [current];
  const title: TaskCardEntry = {
    ts, taskId: card.id, section: 'intake', owner: 'member board API',
    key: `member-board:${card.id}:title`, data: { title: card.title },
  };
  return [title, current];
}

/** Project verified member cards together so duplicate task events fold consistently. */
export function projectMemberBoardCards(cards: readonly MemberBoardCard[]): Record<BoardColumn, MiniBoardCard[]> {
  return projectMiniBoard(cards.flatMap(memberBoardEvents)).columns;
}

export function rowsFromApi<T>(value: unknown, key: 'cards' | 'briefings'): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const rows = object[key] ?? object.items;
  return Array.isArray(rows) ? rows as T[] : [];
}

export function rowsForVerifiedMember<T extends { memberId?: unknown }>(rows: readonly T[], memberId: string): T[] {
  return rows.filter((row) => row.memberId === memberId);
}

export function todayInSeoul(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}


/** Delay to the next Seoul calendar day, independent of the browser host timezone. */
export function msUntilNextSeoulMidnight(now = new Date()): number {
  const [year, month, day] = todayInSeoul(now).split("-").map(Number);
  const nextMidnightUtc = Date.UTC(year, month - 1, day + 1) - 9 * 60 * 60 * 1000;
  return Math.max(1, nextMidnightUtc - now.getTime());
}
