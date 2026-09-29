import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalRunDbPath } from './goal-run-store.js';

export interface GoalRunRecordFragment {
  runId: string;
  path: string;
  markdown: string;
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || id === '..') {
    throw new Error(`Invalid goal record identifier: ${id}`);
  }
  return id;
}

function fragmentsDir(goalId: string): string {
  // The goal-run ledger and these fragments share the same instance-scoped state root.
  return join(dirname(dirname(goalRunDbPath())), 'goal-records', safeId(goalId));
}

/** Atomically replace this run's complete Markdown fragment (never expose a partial write). */
export function writeGoalRunRecordFragment(goalId: string, runId: string, markdown: string): string {
  const directory = fragmentsDir(goalId);
  const destination = join(directory, `${safeId(runId)}.md`);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${runId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, markdown, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The temporary file may not have been created. */ }
    throw error;
  }
  return destination;
}

/** Return complete fragments for one goal, ordered by run ID; absent goals have no records. */
export function listGoalRunRecordFragments(goalId: string): GoalRunRecordFragment[] {
  const directory = fragmentsDir(goalId);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      runId: entry.name.slice(0, -3),
      path: join(directory, entry.name),
      markdown: readFileSync(join(directory, entry.name), 'utf8'),
    }));
}
