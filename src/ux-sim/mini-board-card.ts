import {
  cardTitle,
  foldCard,
  type BoardColumn,
  type TaskCard,
  type TaskCardEntry,
} from '../../apps/pwa/src/lib/task-card-model.js';

export type MiniBoardStage = 'proposal' | 'approved' | 'in-development' | 'test' | 'deployed';

export interface MiniBoardCardProjection {
  taskId: string;
  stage: MiniBoardStage;
  title: string;
  summary: string;
  runId?: string;
  resultUrl?: string;
}

export interface MiniBoardTransition {
  eventKey: string;
  column: BoardColumn;
  stage: MiniBoardStage;
  title: string;
  summary: string;
  resultUrl?: string;
}

const BOARD_COLUMN_STAGE: Record<BoardColumn, MiniBoardStage> = {
  steward: 'proposal',
  landing: 'approved',
  execution: 'in-development',
  release: 'test',
  done: 'deployed',
};

function latestActivity(card: TaskCard): TaskCardEntry | undefined {
  return Object.values(card.sections)
    .filter((entry): entry is TaskCardEntry => entry !== undefined)
    .sort((left, right) => right.ts - left.ts)[0];
}

function textField(entry: TaskCardEntry | undefined, key: string): string | undefined {
  const value = entry?.data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Derive the mini-board view from the existing task-card journal projection. */
export function projectMiniBoardCard(card: TaskCard): MiniBoardCardProjection {
  const activity = latestActivity(card);
  const column: BoardColumn = activity?.section === 'landing'
    ? 'landing'
    : activity?.section === 'run' || activity?.section === 'workspace' || activity?.section === 'gates'
      ? 'execution'
      : activity?.section === 'release'
        ? activity.data.status === 'done' || activity.data.status === 'completed' ? 'done' : 'release'
        : 'steward';
  const title = cardTitle(card);
  const summary = textField(activity, 'summary') ?? textField(activity, 'text') ?? title;
  const resultUrl = column === 'done'
    ? textField(activity, 'resultUrl') ?? textField(activity, 'publicUrl')
    : undefined;

  return {
    taskId: card.taskId,
    stage: BOARD_COLUMN_STAGE[column],
    title,
    summary,
    ...(card.runId ? { runId: card.runId.replace(/^run-/, '').slice(0, 8) } : {}),
    ...(resultUrl ? { resultUrl } : {}),
  };
}

/** Replay real TaskCardEntry-shaped board events, folding them through the PWA card model. */
export function replayMiniBoardEvents(events: readonly TaskCardEntry[]): MiniBoardTransition[] {
  const transitions: MiniBoardTransition[] = [];
  const journal: TaskCardEntry[] = [];

  for (const event of events) {
    journal.push(event);
    const card = foldCard(journal);
    if (!card) continue;
    const projection = projectMiniBoardCard(card);
    transitions.push({
      eventKey: event.key,
      column: projection.stage === 'proposal' ? 'steward'
        : projection.stage === 'approved' ? 'landing'
          : projection.stage === 'in-development' ? 'execution'
            : projection.stage === 'test' ? 'release' : 'done',
      ...projection,
    });
  }

  return transitions;
}
