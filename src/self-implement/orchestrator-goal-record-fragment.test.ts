import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import { listGoalRunRecordFragments } from './goal-execution-records.js';
import { appendGoalExecutionRecord, type GoalExecutionRecord } from './orchestrator.js';

const goalId = '0123456789abcdef';
const record: GoalExecutionRecord = { runId: 'run-fragment', stage: 'pr-opened', outcome: 'completed', ok: true, rounds: 1 };
let directory: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-goal-fragment-'));
  previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = directory;
});

afterEach(() => {
  setUserConfigOverlay(null);
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  rmSync(directory, { recursive: true, force: true });
});

test('default appends the goal document and writes the identical complete fragment with a run-aware debug event', () => {
  const file = join(directory, 'GOAL.md');
  const original = `# Goal\n- GoalId: ${goalId}\n`;
  writeFileSync(file, original);
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const originalLog = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    events.push({ category, event, data });
  }) as typeof debug.log;
  try {
    appendGoalExecutionRecord(file, record);
    const [fragment] = listGoalRunRecordFragments(goalId);
    expect(fragment?.runId).toBe(record.runId);
    expect(fragment?.markdown).toBe(readFileSync(file, 'utf8').slice(original.length));
    expect(fragment?.markdown).toContain('- runId: run-fragment\n  stage: pr-opened\n  outcome: completed\n  ok: true\n  rounds: 1\n');
    expect(events).toContainEqual({ category: 'self-implement', event: 'goal-record-fragment-written', data: { runId: record.runId, goalId, path: fragment!.path } });
    appendGoalExecutionRecord(file, record);
    expect(readFileSync(file, 'utf8')).toBe(original + fragment!.markdown);
    expect(listGoalRunRecordFragments(goalId)).toEqual([fragment]);
  } finally {
    (debug as { log: typeof debug.log }).log = originalLog;
  }
});

test('goalRecordInDoc false leaves the goal file untouched while still writing the fragment', () => {
  setUserConfigOverlay((config) => ({ ...config, tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, goalRecordInDoc: false } } }));
  const file = join(directory, 'GOAL.md');
  const original = `# Goal\n- GoalId: ${goalId}\n`;
  writeFileSync(file, original);
  appendGoalExecutionRecord(file, record);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(listGoalRunRecordFragments(goalId)).toEqual([expect.objectContaining({ runId: record.runId, markdown: expect.stringContaining('  outcome: completed\n') })]);
});

test('no GoalId retains the legacy append without creating a fragment', () => {
  const file = join(directory, 'GOAL.md');
  writeFileSync(file, '# Goal\n');
  appendGoalExecutionRecord(file, record);
  expect(readFileSync(file, 'utf8')).toContain('- runId: run-fragment\n');
  expect(listGoalRunRecordFragments(goalId)).toEqual([]);
});

test('no GoalId still retains the legacy append with goalRecordInDoc false because no fragment can be written', () => {
  setUserConfigOverlay((config) => ({ ...config, tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, goalRecordInDoc: false } } }));
  const file = join(directory, 'GOAL.md');
  const original = '# Legacy goal\n';
  writeFileSync(file, original);
  appendGoalExecutionRecord(file, record);
  const saved = readFileSync(file, 'utf8');
  expect(saved).toContain('- runId: run-fragment\n  stage: pr-opened\n  outcome: completed\n  ok: true\n');
  expect(listGoalRunRecordFragments(goalId)).toEqual([]);
  appendGoalExecutionRecord(file, record);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});
