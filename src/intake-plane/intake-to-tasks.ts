import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { debug } from '../debug/log.js';
import type { TaskPriority } from '../task-orchestrator/types.js';
import { TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { intakeLedgerDir, listIntakeItems, type IntakeItem } from './items.js';
import { intakeOutboxDir } from './route.js';

export interface IntakeTaskRequest {
  title: string;
  description: string;
  priority: Exclude<TaskPriority, 'urgent'>;
  type?: IntakeTaskType;
  acceptance?: { criteria: string[] };
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

export type IntakeTaskInput =
  | { kind: 'goal-line'; id: string; fact: string; current: string; url?: string }
  | { kind: 'idea-note'; id: string; content: string; url?: string };

export interface IntakeToTasksDeps {
  llm: (input: IntakeTaskInput) => Promise<string>;
  post: (request: IntakeTaskRequest) => Promise<{ taskId: string; deduplicated?: boolean }>;
  list?: typeof listIntakeItems;
  readNote?: (path: string) => string;
}

export interface IntakeToTasksResult {
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  items: Array<{ id: string; status: 'created' | 'deduplicated' | 'dry-run' | 'skipped' | 'failed'; taskId?: string; types?: IntakeTaskType[]; reason?: string }>;
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

function goalLineId(file: string, index: number): string {
  return `goal:${createHash('sha256').update(`${file}:${index}`).digest('hex').slice(0, 16)}`;
}

function consumedFile(root: string): string { return join(intakeLedgerDir(root), 'to-tasks.jsonl'); }

interface SavedTaskPlan {
  inputId: string;
  tasks: IntakeInputTask[];
  completed: Array<{ taskId: string; deduplicated: boolean } | null>;
}

function planFile(root: string, id: string): string {
  return join(intakeLedgerDir(root), 'to-tasks-plans', `${createHash('sha256').update(id).digest('hex')}.json`);
}

function loadTaskPlan(root: string, id: string): SavedTaskPlan | null {
  const path = planFile(root, id);
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid saved task plan');
  const value = raw as Record<string, unknown>;
  if (value.inputId !== id || !Array.isArray(value.completed) || !Array.isArray(value.tasks)
    || value.tasks.length < 1 || value.tasks.length > 3 || value.completed.length !== value.tasks.length) {
    throw new Error('invalid saved task plan');
  }
  const parsed = interpretIntakeInput(JSON.stringify({ tasks: value.tasks, questions: [] }));
  if (!parsed || parsed.tasks.length !== value.tasks.length
    || value.completed.some((entry) => entry !== null && (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.taskId !== 'string' || !entry.taskId || typeof entry.deduplicated !== 'boolean'))) {
    throw new Error('invalid saved task plan');
  }
  return { inputId: id, tasks: parsed.tasks, completed: value.completed as SavedTaskPlan['completed'] };
}

function saveTaskPlan(root: string, plan: SavedTaskPlan): void {
  const path = planFile(root, plan.inputId);
  mkdirSync(join(intakeLedgerDir(root), 'to-tasks-plans'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(plan));
  renameSync(temporary, path);
}

function consumedInputs(root: string): Set<string> {
  const file = consumedFile(root);
  if (!existsSync(file)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && 'id' in row && typeof row.id === 'string') ids.add(row.id);
    } catch { /* ignore incomplete ledger lines */ }
  }
  return ids;
}

function goalLines(root: string): IntakeTaskInput[] {
  const dir = join(intakeOutboxDir(root), 'goals');
  if (!existsSync(dir)) return [];
  const rows: IntakeTaskInput[] = [];
  for (const file of readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, index) => {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const row = value as Record<string, unknown>;
        if (typeof row.fact !== 'string' || !row.fact.trim()) return;
        rows.push({ kind: 'goal-line', id: goalLineId(file, index), fact: row.fact, current: typeof row.current === 'string' ? row.current : '',
          ...(typeof row.url === 'string' ? { url: row.url } : {}) });
      } catch { /* ignore malformed outbox lines */ }
    });
  }
  return rows;
}

function noteRoutingHistory(root: string): { eligible: Set<string>; legacyPosted: Set<string> } {
  const file = join(intakeLedgerDir(root), 'items.jsonl');
  if (!existsSync(file)) return { eligible: new Set(), legacyPosted: new Set() };
  const previous = new Map<string, string>();
  const eligible = new Set<string>();
  const legacyPosted = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const item = row as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.status !== 'string') continue;
      const prior = previous.get(item.id);
      if (item.status === 'routed' && prior !== 'routed') {
        // Old to-tasks changed queued → routed after POST under item.id. Route uses absorbed → routed.
        if (prior === 'queued') legacyPosted.add(item.id);
        if ((prior === 'absorbed' || prior === 'checked') && !legacyPosted.has(item.id)) eligible.add(item.id);
        else eligible.delete(item.id);
      }
      previous.set(item.id, item.status);
    } catch { /* ignore incomplete ledger lines */ }
  }
  for (const id of legacyPosted) eligible.delete(id);
  return { eligible, legacyPosted };
}

function ideaNotes(root: string, deps: IntakeToTasksDeps): Array<{ input: IntakeTaskInput; path: string }> {
  const { eligible: routedNotes, legacyPosted } = noteRoutingHistory(root);
  return (deps.list ?? listIntakeItems)(root)
    .filter((item) => !legacyPosted.has(item.id) && (item.status === 'absorbed' || (item.status === 'routed' && routedNotes.has(item.id))) && item.privacy === 'public'
      && item.outputs.some((output) => output.kind === 'note' && isAbsolute(output.ref))
      && !item.outputs.some((output) => output.kind === 'goal'))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
    .map((item) => ({ input: { kind: 'idea-note' as const, id: `note:${item.id}`, content: '',
      ...(item.url ? { url: item.url } : {}) },
      path: [...item.outputs].reverse().find((output) => output.kind === 'note' && isAbsolute(output.ref))!.ref }));
}

export async function runIntakeToTasks(
  instanceRoot: string,
  opts: { limit?: number; dryRun?: boolean },
  deps: IntakeToTasksDeps,
): Promise<IntakeToTasksResult> {
  const limit = opts.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  if (limit === 0) return { processed: 0, created: 0, skipped: 0, failed: 0, items: [] };
  const consumed = consumedInputs(instanceRoot);
  const selected: Array<{ input: IntakeTaskInput; path?: string }> = [...goalLines(instanceRoot).map((input) => ({ input })), ...ideaNotes(instanceRoot, deps)]
    .filter(({ input }) => !consumed.has(input.id)).slice(0, limit);
  const result: IntakeToTasksResult = { processed: selected.length, created: 0, skipped: 0, failed: 0, items: [] };
  for (const { input, path } of selected) {
    try {
      let plan = loadTaskPlan(instanceRoot, input.id);
      if (!plan) {
        let safeInput = input;
        if (input.kind === 'idea-note') {
          try {
            const content = (deps.readNote ?? ((notePath: string) => readFileSync(notePath, 'utf8')))(path!);
            if (!content.trim()) throw new Error('empty note');
            safeInput = { ...input, content: content.slice(0, 12_000) };
          } catch {
            result.skipped++;
            result.items.push({ id: input.id, status: 'skipped', reason: 'note-read-failed' });
            continue;
          }
        }
        const interpreted = interpretIntakeInput(await deps.llm(safeInput));
        if (!interpreted || (!interpreted.tasks.length && !interpreted.questions.length)) {
          result.skipped++;
          result.items.push({ id: input.id, status: 'skipped', reason: 'invalid-llm-response' });
          continue;
        }
        if (interpreted.tasks.length === 0) {
          result.skipped++;
          result.items.push({ id: input.id, status: 'skipped', reason: 'needs-clarification' });
          continue;
        }
        plan = { inputId: input.id, tasks: interpreted.tasks, completed: interpreted.tasks.map(() => null) };
        if (!opts.dryRun) saveTaskPlan(instanceRoot, plan);
      }
      if (opts.dryRun) {
        result.items.push({ id: input.id, status: 'dry-run', types: plan.tasks.map((task) => task.type) });
        continue;
      }
      for (const [index, task] of plan.tasks.entries()) {
        if (plan.completed[index]) continue;
        const request: IntakeTaskRequest = {
          title: task.title, description: task.description, priority: task.priority,
          type: task.type, acceptance: { criteria: task.acceptanceCriteria },
          external: { provider: 'intake', ref: `${input.id}:${index}`, ...(input.url ? { url: input.url } : {}) },
        };
        const response = await deps.post(request);
        if (!response.taskId) throw new Error('Nexus returned no taskId');
        plan.completed[index] = { taskId: response.taskId, deduplicated: !!response.deduplicated };
        saveTaskPlan(instanceRoot, plan);
        if (!response.deduplicated) result.created++;
      }
      const allDeduplicated = plan.completed.every((entry) => entry?.deduplicated);
      const lastTaskId = plan.completed.at(-1)?.taskId;
      if (!lastTaskId) throw new Error('incomplete saved task plan');
      mkdirSync(intakeLedgerDir(instanceRoot), { recursive: true });
      appendFileSync(consumedFile(instanceRoot), JSON.stringify({ id: input.id, taskId: lastTaskId }) + '\n');
      result.items.push({ id: input.id, status: allDeduplicated ? 'deduplicated' : 'created', taskId: lastTaskId,
        types: plan.tasks.map((task) => task.type) });
    } catch {
      result.failed++;
      result.items.push({ id: input.id, status: 'failed', reason: 'intake-to-tasks request failed' });
      debug.log('intake.to-tasks', 'failed', { id: input.id });
    }
  }
  return result;
}
