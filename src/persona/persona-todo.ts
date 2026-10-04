import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PersonaTodo {
  id: string;
  title: string;
  status: 'open' | 'done';
  createdAt: string;
  priority?: number;
  dueAt?: string;
}

export interface PersonaTodoReadResult {
  todos: PersonaTodo[];
  errors: { line: number; message: string }[];
}

/** One JSONL file per persona. Reject path components in the id. */
export function personaTodoPath(dir: string, personaId: string): string {
  if (!personaId || personaId === '.' || personaId === '..' || /[/\\]/.test(personaId)) {
    throw new Error('Invalid persona id');
  }
  return join(dir, `${personaId}.todo.jsonl`);
}

function isPersonaTodo(value: unknown): value is PersonaTodo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.title === 'string' && item.title.length > 0
    && (item.status === 'open' || item.status === 'done')
    && typeof item.createdAt === 'string'
    && Number.isFinite(Date.parse(item.createdAt))
    && (item.priority === undefined || (typeof item.priority === 'number' && Number.isInteger(item.priority) && item.priority >= 0))
    && (item.dueAt === undefined || (typeof item.dueAt === 'string' && Number.isFinite(Date.parse(item.dueAt))));
}

/** Missing files are empty; malformed lines are skipped and returned for observation. */
export function readPersonaTodos(dir: string, personaId: string): PersonaTodoReadResult {
  const path = personaTodoPath(dir, personaId);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { todos: [], errors: [] };
    throw error;
  }

  const todos: PersonaTodo[] = [];
  const errors: PersonaTodoReadResult['errors'] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const item: unknown = JSON.parse(line);
      if (!isPersonaTodo(item)) throw new Error('Invalid todo record');
      todos.push(item);
    } catch (error) {
      errors.push({ line: index + 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { todos, errors };
}

/** Replace a persona's JSONL file with one valid record per line. */
export function writePersonaTodos(dir: string, personaId: string, todos: readonly PersonaTodo[]): void {
  const path = personaTodoPath(dir, personaId);
  for (const todo of todos) {
    if (!isPersonaTodo(todo)) throw new Error('Invalid todo record');
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, todos.map(todo => JSON.stringify(todo)).join('\n') + (todos.length ? '\n' : ''), 'utf8');
}

/** Higher priority first, then earlier deadline, then earlier creation; file order breaks ties. */
export function orderedPersonaTodos(todos: readonly PersonaTodo[]): PersonaTodo[] {
  return [...todos].filter((todo) => todo.status === 'open').sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0)
    || (a.dueAt && b.dueAt ? Date.parse(a.dueAt) - Date.parse(b.dueAt) : a.dueAt ? -1 : b.dueAt ? 1 : 0)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function nextPersonaTodo(todos: readonly PersonaTodo[]): PersonaTodo | null {
  return orderedPersonaTodos(todos)[0] ?? null;
}
