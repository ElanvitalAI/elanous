import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupGoal } from './goal-lookup.js';

const root = mkdtempSync(join(tmpdir(), 'goal-lookup-'));
const goalsDir = join(root, 'goals');
const runsDir = join(root, 'self-dev-runs');
mkdirSync(goalsDir);
mkdirSync(runsDir);
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  for (const name of readdirSync(goalsDir)) rmSync(join(goalsDir, name));
  for (const name of readdirSync(runsDir)) rmSync(join(runsDir, name));
});

function goal(name: string, contents: string): void {
  writeFileSync(join(goalsDir, name), contents);
}
function run(runId: string, results: unknown[]): void {
  writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify({ runId, createdAt: 1, updatedAt: 2, results }));
}
const options = { goalsDir, runsDir };

test('PR lookup joins the exact execution block and self-dev result, returning the full original body', () => {
  const body = 'Implement A.\n- GoalId: 0123456789abcdef\n- KanId: KAN-42\n\n## REQUIRED EVIDENCE\n- keep intact';
  const document = `${body}\n## 실행 기록\n- runId: run-old\n  stage: failed\n  outcome: abandoned\n  prNumber: 12\n## 실행 기록\n- runId: run-new\n  stage: pr-opened\n  outcome: completed\n  prNumber: 123\n`;
  goal('GOAL-a.txt', document);
  run('parent-run', [{ taskId: 'task-1', feature: 'A', runId: 'run-new', status: 'done', stage: 'pr-opened', prNumber: 123 }]);
  const result = lookupGoal('#123', options);
  expect(result.goalBody).toBe(body);
  expect(result.kanId).toBe('KAN-42');
  expect(result.goalFile).toBe(join(goalsDir, 'GOAL-a.txt'));
  expect(result.runId).toBe('run-new');
  expect(result.record).toEqual({ runId: 'run-new', stage: 'pr-opened', outcome: 'completed', prNumber: 123 });
  expect(result.runState?.runId).toBe('parent-run');
  expect(readFileSync(join(goalsDir, 'GOAL-a.txt'), 'utf8')).toBe(document);
  expect(readdirSync(runsDir)).toEqual(['parent-run.json']);
});

test('runId matches the document even without a checkpoint, without matching another record PR', () => {
  goal('GOAL-a.md', 'Goal body\n## 실행 기록\n- runId: run-a\n  stage: merged\n  outcome: completed\n  prNumber: 73\n## 실행 기록\n- runId: run-b\n  stage: gate-failed\n  outcome: abandoned\n');
  const result = lookupGoal('run-b', options);
  expect(result).toMatchObject({ goalBody: 'Goal body', kanId: null, runId: 'run-b', runState: null,
    record: { runId: 'run-b', stage: 'gate-failed', outcome: 'abandoned', prNumber: null } });
  expect(lookupGoal('73', options).record?.runId).toBe('run-a');
  expect(lookupGoal('7', options).goalFile).toBeNull();
});

test('missing goal and missing run remain distinct; body text, unrelated files and corrupt states cannot impersonate records', () => {
  goal('GOAL-a.txt', 'PR 91 and run-needle in original ask\n## 실행 기록\n- runId: run-other\n  stage: merged\n  outcome: completed\n  prNumber: 19\n');
  goal('NOT-GOAL.txt', '## 실행 기록\n- runId: run-needle\n  prNumber: 91\n');
  writeFileSync(join(runsDir, 'corrupt.json'), '{');
  run('run-needle', []);
  expect(lookupGoal('run-needle', options)).toMatchObject({ goalBody: null, runId: 'run-needle', record: null, runState: { runId: 'run-needle' } });
  expect(lookupGoal('91', options)).toMatchObject({ goalBody: null, runId: null, record: null, runState: null });
  expect(lookupGoal('19', options)).toMatchObject({ runId: 'run-other', runState: null });
});

test('PR lookup does not borrow an unrelated document PR merely because its runId matches a checkpoint', () => {
  run('parent-run', [{ taskId: 'task-a', feature: 'A', runId: 'run-shared', status: 'done', prNumber: 91 }]);
  goal('GOAL-a.txt', 'Wrong goal\n## 실행 기록\n- runId: run-shared\n  prNumber: 92\n');
  goal('GOAL-b.txt', 'Right goal\n## 실행 기록\n- runId: run-shared\n  prNumber: 91\n');
  expect(lookupGoal('91', options)).toMatchObject({ goalBody: 'Right goal', goalFile: join(goalsDir, 'GOAL-b.txt') });
});

test('direct PR match across all documents outranks earlier runId-only fallback', () => {
  run('parent-run', [{ taskId: 'task-1', feature: 'A', runId: 'run-child', status: 'done', prNumber: 88 }]);
  goal('GOAL-a.txt', 'Fallback goal\n## 실행 기록\n- runId: run-child\n  stage: merged\n');
  goal('GOAL-b.txt', 'Direct goal\n## 실행 기록\n- runId: run-direct\n  stage: pr-opened\n  outcome: completed\n  prNumber: 88\n');
  expect(lookupGoal('88', options)).toMatchObject({ goalBody: 'Direct goal', goalFile: join(goalsDir, 'GOAL-b.txt'),
    runId: 'run-direct', record: { runId: 'run-direct', stage: 'pr-opened', outcome: 'completed', prNumber: 88 } });
  // The checkpoint matched run-child, not the selected document's run-direct: it must not be returned as its run state.
  expect(lookupGoal('88', options).runState).toBeNull();
});

test('direct PR match re-resolves the run state of the selected document run', () => {
  run('parent-run', [{ taskId: 'task-1', feature: 'A', runId: 'run-child', status: 'done', prNumber: 88 }]);
  run('direct-parent', [{ taskId: 'task-2', feature: 'B', runId: 'run-direct', status: 'done', stage: 'pr-opened' }]);
  goal('GOAL-b.txt', 'Direct goal\n## 실행 기록\n- runId: run-direct\n  stage: pr-opened\n  outcome: completed\n  prNumber: 88\n');
  const result = lookupGoal('88', options);
  expect(result.runId).toBe('run-direct');
  expect(result.runState?.runId).toBe('direct-parent');
  expect(result.runState?.results.some((r) => (r as { runId?: string }).runId === 'run-direct')).toBe(true);
});

test('checkpoint status done is not a document outcome when outcome is absent', () => {
  run('parent-run', [{ taskId: 'task-1', feature: 'A', runId: 'run-child', status: 'done', stage: 'merged', prNumber: 88 }]);
  goal('GOAL-a.txt', 'Ask\n## 실행 기록\n- runId: run-child\n  stage: merged\n  prNumber: 88\n');
  const result = lookupGoal('88', options);
  expect(result.record).toEqual({ runId: 'run-child', stage: 'merged', outcome: null, prNumber: 88 });
  expect(result.runState?.results[0]?.status).toBe('done');
  expect(lookupGoal('999', options).record).toBeNull();
});

test('PR in a checkpoint resolves a legacy document that records only its child runId', () => {
  run('parent-run', [{ taskId: 'task-1', feature: 'A', runId: 'run-child', status: 'done', stage: 'merged', prNumber: 88 }]);
  goal('GOAL-legacy.txt', 'Legacy ask\n## 실행 기록\n- runId: run-child\n  stage: merged\n  outcome: completed\n');
  expect(lookupGoal('88', options)).toMatchObject({ goalBody: 'Legacy ask', runId: 'run-child',
    record: { runId: 'run-child', stage: 'merged', outcome: 'completed', prNumber: 88 },
    runState: { runId: 'parent-run' } });
});

test('malformed result entries in an earlier checkpoint do not block a later matching checkpoint', () => {
  run('a-damaged', [null, false, 88, '88', [], { prNumber: 88 },
    { runId: 'run-child', prNumber: 88, stage: 42 },
    { runId: 'run-child', prNumber: '88', stage: 'merged' }]);
  run('z-valid', [{ taskId: 'task-1', feature: 'A', runId: 'run-child', status: 'done', stage: 'merged', prNumber: 88 }]);
  goal('GOAL-valid.txt', 'Original ask\n## 실행 기록\n- runId: run-child\n  stage: merged\n  outcome: completed\n  prNumber: 88\n');
  const result = lookupGoal('88', options);
  expect(result).toMatchObject({ goalBody: 'Original ask', runId: 'run-child', runState: { runId: 'z-valid' },
    record: { runId: 'run-child', stage: 'merged', outcome: 'completed', prNumber: 88 } });
  expect(lookupGoal('run-child', options)).toMatchObject({ runState: { runId: 'z-valid' },
    record: { runId: 'run-child', stage: 'merged', outcome: 'completed', prNumber: 88 } });
  expect(readdirSync(runsDir).sort()).toEqual(['a-damaged.json', 'z-valid.json']);
});

test('missing directories do not get created during lookup', () => {
  const missing = { goalsDir: join(root, 'absent-goals'), runsDir: join(root, 'absent-runs') };
  expect(lookupGoal('run-none', missing)).toMatchObject({ goalBody: null, runState: null });
  expect(readdirSync(root).sort()).toEqual(['goals', 'self-dev-runs']);
});
