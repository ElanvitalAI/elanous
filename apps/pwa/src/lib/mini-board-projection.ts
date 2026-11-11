import { boardColumn, cardTitle, foldCard, type BoardColumn, type TaskCardEntry, type TaskCardSection } from './task-card-model';

export const MINI_BOARD_COLUMNS: readonly BoardColumn[] = Object.freeze([
  'steward', 'landing', 'execution', 'release', 'done',
]);

export interface MiniBoardCard {
  taskId: string;
  title: string;
  summary: string;
  column: BoardColumn;
  updatedAt: number;
  runId?: string;
  resultUrl?: string;
}

export interface MiniBoardProjection {
  updatedAt: number;
  columns: Record<BoardColumn, MiniBoardCard[]>;
}

export const MINI_BOARD_STORE_EVENT_SECTIONS: readonly TaskCardSection[] = Object.freeze([
  'intake', 'triage', 'gates', 'relations', 'memory', 'workspace', 'run', 'landing', 'release', 'incidents',
]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseStoreEventJson(value: unknown): TaskCardEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const taskId = nonEmptyString(record.taskId);
  const owner = nonEmptyString(record.owner);
  const key = nonEmptyString(record.key);
  const section = record.section;
  const data = record.data;
  const hasRunId = Object.hasOwn(record, 'runId');
  const runId = hasRunId ? nonEmptyString(record.runId) : undefined;
  if (!taskId || !owner || !key || typeof record.ts !== 'number' || !Number.isFinite(record.ts)
    || typeof section !== 'string' || !MINI_BOARD_STORE_EVENT_SECTIONS.includes(section as TaskCardSection)
    || !data || typeof data !== 'object' || Array.isArray(data) || (hasRunId && !runId)) return undefined;
  return {
    ts: record.ts,
    taskId,
    section: section as TaskCardSection,
    owner,
    key,
    data: data as Record<string, unknown>,
    ...(runId ? { runId } : {}),
  };
}

function latestSection(card: ReturnType<typeof foldCard>): TaskCardEntry | undefined {
  if (!card) return undefined;
  return Object.values(card.sections).filter((entry): entry is TaskCardEntry => Boolean(entry))
    .reduce<TaskCardEntry | undefined>((latest, entry) => !latest || entry.ts >= latest.ts ? entry : latest, undefined);
}

function safePublicUrl(value: unknown): string | undefined {
  const candidate = nonEmptyString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function completedResultUrl(card: NonNullable<ReturnType<typeof foldCard>>, journal: readonly TaskCardEntry[]): string | undefined {
  const release = card.sections.release;
  if (release?.data.status !== 'done' && release?.data.status !== 'completed') return undefined;
  const releaseUrl = safePublicUrl(release.data.resultUrl) ?? safePublicUrl(release.data.publicUrl);
  if (releaseUrl) return releaseUrl;
  return journal
    .filter(entry => entry.section === 'run' && entry.key.startsWith('app-publish:'))
    .slice()
    .sort((left, right) => right.ts - left.ts)
    .map(entry => safePublicUrl(entry.data.publicUrl))
    .find(Boolean);
}

function projectColumn(card: NonNullable<ReturnType<typeof foldCard>>, activity: TaskCardEntry | undefined): BoardColumn {
  const release = card.sections.release?.data;
  if (release?.status === 'done' || release?.status === 'completed') return 'done';
  if (activity?.section === 'release') return 'release';
  if (activity?.section === 'landing') return 'landing';
  if (activity && ['workspace', 'run', 'gates', 'relations', 'memory'].includes(activity.section)) return 'execution';
  return boardColumn(card);
}

/** Read-only projection of JSON store events into the existing card model. It creates no second card state. */
export function projectMiniBoard(events: readonly unknown[]): MiniBoardProjection {
  const grouped = new Map<string, TaskCardEntry[]>();
  let updatedAt: number | undefined;
  for (const value of events) {
    const entry = parseStoreEventJson(value);
    if (!entry) continue;
    updatedAt = updatedAt === undefined ? entry.ts : Math.max(updatedAt, entry.ts);
    const group = grouped.get(entry.taskId) ?? [];
    group.push(entry);
    grouped.set(entry.taskId, group);
  }

  const columns: MiniBoardProjection['columns'] = {
    steward: [], landing: [], execution: [], release: [], done: [],
  };
  for (const journal of grouped.values()) {
    const card = foldCard(journal);
    if (!card) continue;
    const section = latestSection(card);
    const column = projectColumn(card, section);
    const title = cardTitle(card);
    const summary = nonEmptyString(section?.data.summary) ?? nonEmptyString(section?.data.text) ?? title;
    const resultUrl = completedResultUrl(card, journal);
    columns[column].push({
      taskId: card.taskId,
      title,
      summary,
      column,
      updatedAt: card.updatedAt,
      ...(card.runId ? { runId: card.runId.slice(0, 4) } : {}),
      ...(resultUrl ? { resultUrl } : {}),
    });
  }
  for (const column of MINI_BOARD_COLUMNS) columns[column].sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId));
  return { updatedAt: updatedAt ?? 0, columns };
}
