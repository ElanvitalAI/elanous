import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PersonaTodo {
  id: string;
  title: string;
  status: 'open' | 'done';
  createdAt: string;
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
    && Number.isFinite(Date.parse(item.createdAt));
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

/** Earliest created open item; original order breaks equal-timestamp ties. */
export function nextPersonaTodo(todos: readonly PersonaTodo[]): PersonaTodo | null {
  let oldest: PersonaTodo | null = null;
  for (const todo of todos) {
    if (todo.status === 'open' && (!oldest || Date.parse(todo.createdAt) < Date.parse(oldest.createdAt))) {
      oldest = todo;
    }
  }
  return oldest;
}
