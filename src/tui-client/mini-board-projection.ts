import {
  boardColumn,
  cardTitle,
  foldCard,
  type BoardColumn,
  type TaskCardEntry,
} from '../../apps/pwa/src/lib/task-card-model.js';
import { pad, wrapAnsiByWidth } from '../tui.js';
import { terminalSafeText } from './terminal-safe-text.js';

export const TUI_MINI_BOARD_COLUMNS: readonly BoardColumn[] = [
  'steward', 'landing', 'execution', 'release', 'done',
];

const COLUMN_LABEL: Record<BoardColumn, string> = {
  steward: '제안',
  landing: '승인',
  execution: '개발 중',
  release: '시험',
  done: '배포됨',
};

export interface TuiMiniBoardCard {
  readonly taskId: string;
  readonly column: BoardColumn;
  readonly title: string;
  readonly summary: string;
  readonly runId?: string;
  readonly resultUrl?: string;
  readonly updatedAt: number;
  readonly attachments?: readonly { kind: string; title: string; url: string }[];
}

export interface TuiMiniBoardColumn {
  readonly id: BoardColumn;
  readonly label: string;
  readonly cards: readonly TuiMiniBoardCard[];
}

export interface TuiMiniBoardProjection {
  readonly columns: readonly TuiMiniBoardColumn[];
  readonly updatedAt: number;
}

function textField(entry: TaskCardEntry | undefined, key: string): string | undefined {
  const value = entry?.data[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function latestSummary(sections: readonly (TaskCardEntry | undefined)[]): string | undefined {
  return sections
    .filter((entry): entry is TaskCardEntry => entry !== undefined
      && (textField(entry, 'summary') !== undefined || textField(entry, 'text') !== undefined))
    .sort((left, right) => right.ts - left.ts)
    .map((entry) => textField(entry, 'summary') ?? textField(entry, 'text'))
    .find((value): value is string => value !== undefined);
}

function attachmentsFor(rows: readonly TaskCardEntry[]): { kind: string; title: string; url: string }[] {
  const latest = [...rows].sort((a, b) => b.ts - a.ts)[0];
  const values = latest?.data.attachments;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if ((row.kind !== 'diagram' && row.kind !== 'pdf') || typeof row.title !== 'string' || typeof row.url !== 'string') return [];
    try {
      const url = new URL(row.url);
      if (url.protocol !== 'https:' || url.username || url.password) return [];
      return [{ kind: row.kind, title: row.title, url: url.href }];
    } catch { return []; }
  });
}

/** Fold the existing journal and PWA model into read-only TUI card fields. */
export function projectTuiMiniBoard(
  events: readonly TaskCardEntry[],
  updatedAt = Date.now(),
): TuiMiniBoardProjection {
  const byTask = new Map<string, TaskCardEntry[]>();
  for (const event of events) {
    const rows = byTask.get(event.taskId) ?? [];
    rows.push(event);
    byTask.set(event.taskId, rows);
  }

  const columns = new Map<BoardColumn, TuiMiniBoardCard[]>(
    TUI_MINI_BOARD_COLUMNS.map((column) => [column, []]),
  );
  for (const [taskId, rows] of byTask) {
    const card = foldCard(rows);
    if (!card) continue;
    const column = boardColumn(card);
    const title = [...rows].sort((a, b) => b.ts - a.ts).map(row => textField(row, 'title')).find(Boolean) ?? cardTitle(card);
    const release = card.sections.release;
    const resultUrl = column === 'done'
      ? textField(release, 'resultUrl') ?? textField(release, 'publicUrl')
      : undefined;
    const attachments = attachmentsFor(rows);
    columns.get(column)!.push({
      taskId,
      column,
      title,
      summary: latestSummary(rows) ?? title,
      ...(card.runId ? { runId: card.runId.replace(/^run-/, '').slice(0, 8) } : {}),
      ...(resultUrl ? { resultUrl } : {}),
      updatedAt: card.updatedAt,
      ...(attachments.length ? { attachments } : {}),
    });
  }

  return {
    columns: TUI_MINI_BOARD_COLUMNS.map((id) => ({
      id,
      label: COLUMN_LABEL[id],
      cards: (columns.get(id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt),
    })),
    updatedAt,
  };
}

/** Contractual single-line card text shared by the board and briefing-card host. */
export function formatTuiMiniBoardCard(card: TuiMiniBoardCard): string {
  return terminalSafeText([
    card.title,
    card.summary,
    card.runId ? `run ${card.runId}` : '',
    card.resultUrl ? `↗ ${card.resultUrl}` : '',
    ...(card.attachments ?? []).map((attachment) => `${attachment.kind === 'pdf' ? 'PDF' : '도면'} ${attachment.title} ↗ ${attachment.url}`),
  ].filter(Boolean).join(' · '));
}

function wrap(line: string, width: number): string[] {
  return wrapAnsiByWidth(terminalSafeText(line), Math.max(1, width));
}

function fit(line: string, width: number): string {
  return pad(line, width);
}

function clockLabel(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** TUI surface rendering; the projection stays usable by other surfaces. */
export function renderTuiMiniBoard(
  board: TuiMiniBoardProjection,
  width: number,
): string[] {
  if (width <= 0) return [];
  const lines = wrap(`미니 보드 · 갱신 ${clockLabel(board.updatedAt)}`, width);
  const narrow = width < 90;

  if (narrow) {
    for (const column of board.columns) {
      lines.push(...wrap(`${column.label}(${column.cards.length})`, width));
      if (column.cards.length === 0) lines.push(...wrap('  —', width));
      for (const card of column.cards) {
        const wrapped = wrap(formatTuiMiniBoardCard(card), Math.max(1, width - 2));
        lines.push(...wrapped.map((line) => `  ${line}`));
      }
    }
    return lines.map((line) => fit(line, width));
  }

  const base = Math.floor(width / board.columns.length);
  const widths = board.columns.map((_, index) => base + (index === board.columns.length - 1 ? width - base * board.columns.length : 0));
  const columnWidths = widths.map((value) => Math.max(1, value));
  const headerLines = board.columns.map((column, index) => wrap(`${column.label}(${column.cards.length})`, columnWidths[index]!));
  const headerHeight = Math.max(...headerLines.map((wrapped) => wrapped.length));
  for (let line = 0; line < headerHeight; line++) {
    lines.push(headerLines.map((wrapped, index) => fit(wrapped[line] ?? '', columnWidths[index]!)).join(''));
  }
  const rowCount = Math.max(1, ...board.columns.map((column) => column.cards.length));
  for (let row = 0; row < rowCount; row++) {
    const cardRows = board.columns.map((column, index) => {
      const card = column.cards[row];
      if (!card) return [[], [], [], [], []] as const;
      return [
        wrap(card.title, columnWidths[index]!),
        wrap(card.summary, columnWidths[index]!),
        card.runId ? wrap(`run ${card.runId}`, columnWidths[index]!) : [],
        card.resultUrl ? wrap(`↗ ${card.resultUrl}`, columnWidths[index]!) : [],
        (card.attachments ?? []).flatMap((attachment) => wrap(`${attachment.kind === 'pdf' ? 'PDF' : '도면'} ${attachment.title} ↗ ${attachment.url}`, columnWidths[index]!)),
      ] as const;
    });
    for (let field = 0; field < 5; field++) {
      const height = Math.max(1, ...cardRows.map((fields) => fields[field].length));
      for (let line = 0; line < height; line++) {
        lines.push(cardRows.map((fields, index) => fit(fields[field][line] ?? '', columnWidths[index]!)).join(''));
      }
    }
  }
  return lines;
}
