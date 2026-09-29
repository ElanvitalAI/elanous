import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listGoalRunRecordFragments, writeGoalRunRecordFragment } from './goal-execution-records.js';

describe('goal execution record fragments', () => {
  let state: string;
  let previous: string | undefined;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'goal-fragments-'));
    previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = state;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(state, { recursive: true, force: true });
  });

  it('stores complete Markdown in a separate state-scoped fragment per run', () => {
    const goalId = '0123456789abcdef';
    const fragment = '## 실행 기록\n- runId: run-a\n  outcome: completed\n';
    const path = writeGoalRunRecordFragment(goalId, 'run-a', fragment);
    const directory = join(state, 'goal-records', goalId);
    const expectedPath = join(state, 'goal-records', goalId, 'run-a.md');
    expect(path).toBe(expectedPath);
    expect(readFileSync(expectedPath, 'utf8')).toBe(fragment);
    expect(readdirSync(directory)).toEqual(['run-a.md']);
    expect(listGoalRunRecordFragments(goalId)).toEqual([{ runId: 'run-a', path, markdown: fragment }]);
  });

  it('replaces only the matching run atomically, ignores temporary files and isolates goals', () => {
    const a = writeGoalRunRecordFragment('goal-a', 'run-a', 'old');
    const b = writeGoalRunRecordFragment('goal-a', 'run-b', 'second');
    writeGoalRunRecordFragment('goal-b', 'run-a', 'other goal');
    expect(writeGoalRunRecordFragment('goal-a', 'run-a', 'new')).toBe(a);
    expect(readdirSync(dirname(a)).sort()).toEqual(['run-a.md', 'run-b.md']);
    expect(listGoalRunRecordFragments('goal-a')).toEqual([
      { runId: 'run-a', path: a, markdown: 'new' },
      { runId: 'run-b', path: b, markdown: 'second' },
    ]);
    expect(listGoalRunRecordFragments('goal-b').map((entry) => entry.markdown)).toEqual(['other goal']);
  });

  it('does not create a directory for reads of missing goals; rejects path traversal', () => {
    expect(listGoalRunRecordFragments('missing')).toEqual([]);
    expect(readdirSync(state)).toEqual([]);
    expect(() => writeGoalRunRecordFragment('../escape', 'run', 'bad')).toThrow('Invalid goal record identifier');
    expect(() => writeGoalRunRecordFragment('good', '../escape', 'bad')).toThrow('Invalid goal record identifier');
    expect(() => listGoalRunRecordFragments('../escape')).toThrow('Invalid goal record identifier');
    expect(readdirSync(state)).toEqual([]);
  });
});
