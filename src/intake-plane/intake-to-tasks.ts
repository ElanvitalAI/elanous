import { debug } from '../debug/log.js';
import type { TaskPriority } from '../task-orchestrator/types.js';
import { TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { listIntakeItems, markIntakeItem, type IntakeItem } from './items.js';

export interface IntakeTaskRequest {
  title: string;
  description: string;
  priority: Exclude<TaskPriority, 'urgent'>;
  external: { provider: 'intake'; ref: string; url?: string };
}

export interface IntakeTaskInterpretation {
  title: string;
  description: string;
  priority: Exclude<TaskPriority, 'urgent'>;
}

export type IntakeTaskType = 'implement' | 'research' | 'document' | 'operate';

export interface IntakeInputTask extends IntakeTaskInterpretation {
  type: IntakeTaskType;
  acceptanceCriteria: string[];
}

export interface IntakeInputInterpretation {
  tasks: IntakeInputTask[];
  questions: string[];
}

export function interpretIntakeInput(response: string): IntakeInputInterpretation | null {
  const text = response.trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (text.startsWith('```') && !fenced) return null;
  let raw: unknown;
  try { raw = JSON.parse(fenced ? fenced[1] : text); }
  catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.tasks) || !Array.isArray(value.questions)) return null;

  const questions = value.questions.filter((question): question is string => typeof question === 'string' && question.trim().length > 0)
    .map((question) => question.trim());
  const tasks: IntakeInputTask[] = [];
  for (const candidate of value.tasks) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const task = candidate as Record<string, unknown>;
    if (task.type !== 'implement' && task.type !== 'research' && task.type !== 'document' && task.type !== 'operate') continue;
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.trim().length > TASK_DEFAULTS.titleMaxLen) continue;
    if (typeof task.description !== 'string' || task.description.length > TASK_DEFAULTS.descriptionMaxLen) continue;
    if (task.priority !== 'low' && task.priority !== 'medium' && task.priority !== 'high') continue;
    if (!Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.some((criterion) => typeof criterion === 'string' && criterion.trim())) {
      questions.push(task.title.trim());
      continue;
    }
    if (tasks.length < 3) tasks.push({
      type: task.type,
      title: task.title.trim(),
      description: task.description,
      priority: task.priority,
      acceptanceCriteria: task.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === 'string' && criterion.trim().length > 0)
        .map((criterion) => criterion.trim()),
    });
  }
  return { tasks, questions };
}

export interface IntakeToTasksDeps {
  llm: (item: IntakeItem) => Promise<string>;
  post: (request: IntakeTaskRequest) => Promise<{ taskId: string; deduplicated?: boolean }>;
  list?: typeof listIntakeItems;
  mark?: typeof markIntakeItem;
}

export interface IntakeToTasksResult {
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  items: Array<{ id: string; status: 'created' | 'deduplicated' | 'dry-run' | 'skipped' | 'failed'; taskId?: string; reason?: string }>;
}

export function interpretIntakeItem(response: string): IntakeTaskInterpretation | null {
  const text = response.trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (text.startsWith('```') && !fenced) return null;
  let raw: unknown;
  try { raw = JSON.parse(fenced ? fenced[1] : text); }
  catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== 'string') return null;
  const title = value.title.trim();
  if (!title || title.length > TASK_DEFAULTS.titleMaxLen) return null;
  if (typeof value.description !== 'string' || value.description.length > TASK_DEFAULTS.descriptionMaxLen) return null;
  if (value.priority !== 'low' && value.priority !== 'medium' && value.priority !== 'high') return null;
  return { title, description: value.description, priority: value.priority };
}

export function toIntakeTaskRequest(item: IntakeItem, interpretation: IntakeTaskInterpretation): IntakeTaskRequest {
  return {
    ...interpretation,
    external: { provider: 'intake', ref: item.id, ...(item.url ? { url: item.url } : {}) },
  };
}

export async function runIntakeToTasks(
  instanceRoot: string,
  opts: { limit?: number; dryRun?: boolean },
  deps: IntakeToTasksDeps,
): Promise<IntakeToTasksResult> {
  const limit = opts.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  const queued = (deps.list ?? listIntakeItems)(instanceRoot, { status: 'queued' })
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
    .slice(0, limit);
  const result: IntakeToTasksResult = { processed: queued.length, created: 0, skipped: 0, failed: 0, items: [] };
  for (const item of queued) {
    try {
      const interpreted = interpretIntakeItem(await deps.llm(item));
      if (!interpreted) {
        result.skipped++;
        result.items.push({ id: item.id, status: 'skipped', reason: 'invalid-llm-response' });
        continue;
      }
      if (opts.dryRun) {
        result.items.push({ id: item.id, status: 'dry-run' });
        continue;
      }
      const response = await deps.post(toIntakeTaskRequest(item, interpreted));
      if (!response.taskId) throw new Error('Nexus returned no taskId');
      if (!(deps.mark ?? markIntakeItem)(instanceRoot, item.id, { status: 'routed' })) throw new Error('intake item disappeared');
      if (!response.deduplicated) result.created++;
      result.items.push({ id: item.id, status: response.deduplicated ? 'deduplicated' : 'created', taskId: response.taskId });
    } catch {
      result.failed++;
      result.items.push({ id: item.id, status: 'failed', reason: 'intake-to-tasks request failed' });
      debug.log('intake.to-tasks', 'failed', { id: item.id });
    }
  }
  return result;
}
