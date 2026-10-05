export type TaskCardSection =
  | 'intake' | 'triage' | 'gates' | 'relations' | 'memory'
  | 'workspace' | 'run' | 'landing' | 'release' | 'incidents';

export interface TaskCardEntry {
  ts: number;
  taskId: string;
  section: TaskCardSection;
  owner: string;
  runId?: string;
  key: string;
  data: Record<string, unknown>;
}

export interface TaskCard {
  taskId: string;
  sections: Partial<Record<Exclude<TaskCardSection, 'incidents'>, TaskCardEntry>>;
  incidents: TaskCardEntry[];
  updatedAt: number;
  runId?: string;
  apiTitle?: string;
  wishReply?: { surface: string; address: string | null } | null;
}

export type BoardColumn = 'steward' | 'execution' | 'landing' | 'release' | 'done';

/** Fold the append-only card journal. A repeated key is the same event, not a new update. */
export function foldCard(entries: readonly TaskCardEntry[]): TaskCard | null {
  const first = entries[0];
  if (!first) return null;

  const sections: TaskCard['sections'] = {};
  const incidents: TaskCardEntry[] = [];
  const seen = new Set<string>();
  let updatedAt = first.ts;
  let runId: string | undefined;
  let runIdAt = -Infinity;
  for (const entry of entries) {
    if (entry.taskId !== first.taskId || seen.has(entry.key)) continue;
    seen.add(entry.key);
    updatedAt = Math.max(updatedAt, entry.ts);
    if (entry.runId && entry.ts >= runIdAt) {
      runId = entry.runId;
      runIdAt = entry.ts;
    }
    if (entry.section === 'incidents') {
      incidents.push(entry);
    } else {
      const previous = sections[entry.section];
      if (!previous || entry.ts >= previous.ts) sections[entry.section] = entry;
    }
  }
  return { taskId: first.taskId, sections, incidents, updatedAt, ...(runId ? { runId } : {}) };
}

export function boardColumn(card: TaskCard): BoardColumn {
  const release = card.sections.release?.data;
  if (release?.status === 'done' || release?.status === 'completed') return 'done';
  if (release) return 'release';
  if (card.sections.landing) return 'landing';
  if (card.sections.run || card.sections.workspace || card.sections.gates || card.sections.relations || card.sections.memory) return 'execution';
  return 'steward';
}

export function cardTitle(card: TaskCard): string {
  for (const section of [card.sections.triage, card.sections.intake]) {
    const title = section?.data.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return card.apiTitle?.trim() || card.taskId;
}
