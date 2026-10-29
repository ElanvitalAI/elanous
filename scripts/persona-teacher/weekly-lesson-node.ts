/**
 * SW-PERSONA-TEACHER-WEEKLY-FU (GoalId d68f0e7e17725cef) — weekly lesson node commands.
 *
 * 각 명령은 runner 가 심는 `ELANOUS_GRAPH_CONTEXT`(이번 노드의 input + 앞 노드들의 구조 산출)를 읽고
 * 마지막 한 줄 JSON 으로 다음 간선의 `outcome` 을 낸다. 진도는 새 저장소를 만들지 않는다 —
 * 첫 실행의 `record-progress` 산출이 그래프 런 원장(`graph-runs/weekly-lesson/<runId>.json`)에 남고,
 * 다음 실행의 `read-progress` 가 그 원장을 그대로 읽어 다음 단원을 고른다.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SYLLABUS = ['unit-1', 'unit-2', 'unit-3', 'unit-4', 'unit-5'] as const;
const WEEKLY_TIMEZONE = 'Asia/Seoul';
const WEEKLY_CRON_WEEKDAY = 'Sun';
const WEEKLY_CRON_HOUR = 20;

type Lesson = (typeof SYLLABUS)[number] | string;

interface StepOutput {
  outcome?: string;
  lesson?: string;
  completed?: string[];
  nextLesson?: string | null;
  [key: string]: unknown;
}

interface GraphContext {
  graphId?: string;
  runId?: string;
  nodeId?: string;
  input?: unknown;
  outputs?: Record<string, unknown>;
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseStepOutput(value: unknown): StepOutput {
  if (typeof value === 'string') {
    const last = value.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
    if (!last?.startsWith('{')) throw new Error('step output must end with a JSON object');
    try { return JSON.parse(last) as StepOutput; }
    catch (error) { throw new Error('step output ended with invalid JSON', { cause: error }); }
  }
  return asObject(value) as StepOutput;
}

function context(): { value: GraphContext; root: string } {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
  const stateRoot = process.env.ELANOUS_STATE_DIR;
  if (!stateRoot) throw new Error('ELANOUS_STATE_DIR is required');
  return { value: JSON.parse(readFileSync(path, 'utf8')) as GraphContext, root: resolve(stateRoot) };
}

/** 일요일 20:00 Asia/Seoul 인가 — 스케줄러가 주입한 tick 시각을 그 자리에서 검증한다. */
function isWeeklySlot(scheduledAt: unknown): boolean {
  if (typeof scheduledAt !== 'string' || !Number.isFinite(Date.parse(scheduledAt))) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WEEKLY_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(scheduledAt));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return get('weekday') === WEEKLY_CRON_WEEKDAY && Number(get('hour')) === WEEKLY_CRON_HOUR && Number(get('minute')) === 0;
}

/** 저장된 진도 = 앞선 런 원장의 성공한 `record-progress` 산출(lesson·completed). */
function completedLessons(root: string): { completed: Lesson[]; runs: number } {
  const dir = join(root, 'graph-runs', 'weekly-lesson');
  let files: string[];
  try { files = readdirSync(dir).filter((file) => file.endsWith('.json') && !file.endsWith('.decision.json')); }
  catch { return { completed: [], runs: 0 }; }
  const completed: Lesson[] = [];
  let runs = 0;
  for (const file of files) {
    let state: { nodes?: Array<{ nodeId?: string; ok?: boolean; output?: unknown }> };
    try { state = JSON.parse(readFileSync(join(dir, file), 'utf8')) as typeof state; }
    catch { continue; }
    runs += 1;
    for (const node of state.nodes ?? []) {
      if (node.nodeId !== 'record-progress' || node.ok !== true) continue;
      const recorded = parseStepOutput(node.output);
      for (const lesson of recorded.completed ?? []) if (typeof lesson === 'string' && !completed.includes(lesson)) completed.push(lesson);
      if (typeof recorded.lesson === 'string' && !completed.includes(recorded.lesson)) completed.push(recorded.lesson);
    }
  }
  return { completed, runs };
}

function nextLesson(completed: readonly string[]): Lesson | undefined {
  return SYLLABUS.find((lesson) => !completed.includes(lesson));
}

function readProgress(): void {
  const { value, root } = context();
  const input = asObject(value.input);
  if (!isWeeklySlot(input.scheduledAt)) {
    emit({ outcome: 'fail', error: 'off-schedule: weekly ticks run Sunday 20:00 Asia/Seoul', scheduledAt: input.scheduledAt ?? null });
    return;
  }
  const { completed, runs } = completedLessons(root);
  emit({ outcome: 'ok', scheduledAt: input.scheduledAt, completed, nextLesson: nextLesson(completed) ?? null,
    ledgerRuns: runs, source: runs === 0 ? 'empty-ledger' : 'run-ledger' });
}

function selectNext(): void {
  const { value } = context();
  const prior = parseStepOutput(value.outputs?.['read-progress']);
  const completed = (prior.completed ?? []).filter((lesson): lesson is string => typeof lesson === 'string');
  const lesson = typeof prior.nextLesson === 'string' ? prior.nextLesson : nextLesson(completed);
  if (!lesson) {
    emit({ outcome: 'fail', error: 'syllabus-complete', completed });
    return;
  }
  emit({ outcome: completed.length === 0 ? 'baseline' : 'next', lesson, completed, scheduledAt: prior.scheduledAt ?? null,
    requestedBy: { graphId: value.graphId ?? null, runId: value.runId ?? null } });
}

function packLesson(): void {
  const { value, root } = context();
  const selected = parseStepOutput(asObject(value.input)['select-next']);
  if (typeof selected.lesson !== 'string') {
    emit({ outcome: 'fail', error: 'lesson-pack requires a selected lesson' });
    return;
  }
  if (!(SYLLABUS as readonly string[]).includes(selected.lesson)) {
    emit({ outcome: 'fail', error: `lesson-pack received an unknown lesson: ${selected.lesson}` });
    return;
  }
  const dir = join(root, 'lesson-pack', 'inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${selected.lesson}.json`), `${JSON.stringify({
    lesson: selected.lesson, scheduledAt: selected.scheduledAt ?? null,
    requestedBy: asObject(selected.requestedBy), packedBy: { graphId: value.graphId ?? null, runId: value.runId ?? null },
  }, null, 2)}\n`);
  emit({ outcome: 'ok', lesson: selected.lesson, completed: selected.completed ?? [] });
}

function recordProgress(): void {
  const { value } = context();
  const selected = parseStepOutput(value.outputs?.['select-next']);
  const packed = parseStepOutput(value.outputs?.['lesson-pack']);
  const lesson = typeof packed.lesson === 'string' ? packed.lesson : typeof selected.lesson === 'string' ? selected.lesson : undefined;
  if (!lesson) {
    emit({ outcome: 'fail', error: 'record-progress requires the delivered lesson' });
    return;
  }
  const completed = (selected.completed ?? []).filter((item): item is string => typeof item === 'string');
  if (!completed.includes(lesson)) completed.push(lesson);
  emit({ outcome: 'ok', lesson, completed, recordedAt: asObject(value.input).scheduledAt ?? null });
}

const commands: Record<string, () => void> = {
  'read-progress': readProgress,
  'select-next': selectNext,
  pack: packLesson,
  'record-progress': recordProgress,
};

if (import.meta.main) {
  const command = process.argv[2] ?? '';
  const run = commands[command];
  if (!run) {
    console.error(`unknown weekly-lesson command: ${command} (expected ${Object.keys(commands).join('|')})`);
    process.exit(2);
  }
  run();
}
