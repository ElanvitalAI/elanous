import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureAuthorSectionContribution } from './author-section-contribution.js';

test('authorRunId-only summary selects the closest subsequent run of the assigned goal, not all runs', () => {
  const summary = [{ authorRunId: 'author-1', sectionChars: { boundary: 45, signal: 10 } }];
  expect(summary[0]).not.toHaveProperty('goalId');
  const events = [{ category: 'goal-author', event: 'goal-id-assigned', ts: '2026-10-05T10:00:00Z', data: { authorRunId: 'author-1', goalId: '0123456789abcdef' } }];
  const runs = [
    { runId: 'discarded', goalId: '0123456789abcdef', startedAt: '2026-10-05T09:55:00Z', outcome: 'abandoned' },
    { runId: 'merged', goalId: '0123456789abcdef', startedAt: '2026-10-05T10:01:00Z', outcome: 'merged' },
    { runId: 'later', goalId: '0123456789abcdef', startedAt: '2026-10-05T11:00:00Z', outcome: 'abandoned' },
  ];
  expect(measureAuthorSectionContribution(summary, events, runs)).toEqual([
    { authorRunId: 'author-1', goalId: '0123456789abcdef', runId: 'merged', section: 'boundary', chars: 45, outcome: 'merged' },
    { authorRunId: 'author-1', goalId: '0123456789abcdef', runId: 'merged', section: 'signal', chars: 10, outcome: 'merged' },
  ]);
});

test('duplicate assignment events produce one execution for an author run', () => {
  const summary = [{ authorRunId: 'author-1', sectionChars: { boundary: 45 } }];
  const assignment = { category: 'goal-author', event: 'goal-id-assigned', ts: '2026-10-05T10:00:00Z', data: { authorRunId: 'author-1', goalId: 'goal-a' } };
  const runs = [
    { runId: 'first', goalId: 'goal-a', startedAt: '2026-10-05T10:01:00Z', outcome: 'merged' },
    { runId: 'second', goalId: 'goal-a', startedAt: '2026-10-05T10:02:00Z', outcome: 'abandoned' },
  ];
  expect(measureAuthorSectionContribution(summary, [assignment, { ...assignment }], runs)).toEqual([
    { authorRunId: 'author-1', goalId: 'goal-a', runId: 'first', section: 'boundary', chars: 45, outcome: 'merged' },
  ]);
});

test('multiple goal assignments select one deterministic assignment before selecting a run', () => {
  const summary = [{ authorRunId: 'author-1', sectionChars: { boundary: 45 } }];
  const first = { category: 'goal-author', event: 'goal-id-assigned', ts: '2026-10-05T10:00:00Z', data: { authorRunId: 'author-1', goalId: 'goal-a' } };
  const later = { category: 'goal-author', event: 'goal-id-assigned', ts: '2026-10-05T10:02:00Z', data: { authorRunId: 'author-1', goalId: 'goal-b' } };
  const runs = [
    { runId: 'second-goal-run', goalId: 'goal-b', startedAt: '2026-10-05T10:03:00Z', outcome: 'abandoned' },
    { runId: 'first-goal-run', goalId: 'goal-a', startedAt: '2026-10-05T10:01:00Z', outcome: 'merged' },
  ];
  const expected = [
    { authorRunId: 'author-1', goalId: 'goal-a', runId: 'first-goal-run', section: 'boundary', chars: 45, outcome: 'merged' },
  ];
  expect(measureAuthorSectionContribution(summary, [later, first], runs)).toEqual(expected);
  expect(measureAuthorSectionContribution(summary, [first, later], runs)).toEqual(expected);
  const sameTime = { ...later, ts: first.ts };
  expect(measureAuthorSectionContribution(summary, [sameTime, first], runs)).toEqual(expected);
});

test('no assignment or no following run cannot be attributed', () => {
  const summary = [{ authorRunId: 'author-1', sectionChars: { boundary: 45 } }];
  const event = { category: 'goal-author', event: 'goal-id-assigned', ts: '2026-10-05T10:00:00Z', data: { authorRunId: 'other', goalId: '0123456789abcdef' } };
  const run = { runId: 'discarded', goalId: '0123456789abcdef', startedAt: '2026-10-05T09:55:00Z', outcome: 'abandoned' };
  expect(measureAuthorSectionContribution(summary, [event], [run])).toEqual([]);
  expect(measureAuthorSectionContribution(summary, [{ ...event, data: { ...event.data, authorRunId: 'author-1' } }], [run])).toEqual([]);
});

test('CLI reads authorRunId summary, assignment log and goal-run ledger without inventing summary goalId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'author-section-contribution-'));
  try {
    const summaries = join(dir, 'summaries.json');
    const events = join(dir, 'events.jsonl');
    const ledger = join(dir, 'runs.db');
    writeFileSync(summaries, JSON.stringify([{ authorRunId: 'author-1', sectionChars: { boundary: 45 } }]));
    writeFileSync(events, JSON.stringify({ category: 'goal-author', event: 'goal-id-assigned', ts: '2026-10-05T10:00:00Z', data: { authorRunId: 'author-1', goalId: '0123456789abcdef' } }) + '\n');
    const db = new Database(ledger);
    try {
      db.run('CREATE TABLE goal_run (run_id TEXT, goal_id TEXT, doc TEXT)');
      db.run('INSERT INTO goal_run VALUES (?, ?, ?)', ['discarded', '0123456789abcdef', JSON.stringify({ startedAt: '2026-10-05T09:55:00Z', outcome: 'abandoned' })]);
      db.run('INSERT INTO goal_run VALUES (?, ?, ?)', ['merged', '0123456789abcdef', JSON.stringify({ startedAt: '2026-10-05T10:01:00Z', outcome: 'merged' })]);
    } finally { db.close(); }
    const proc = Bun.spawnSync(['bun', 'scripts/measure/author-section-contribution.ts', summaries, events, ledger], { cwd: process.cwd() });
    expect(proc.exitCode).toBe(0);
    const output = proc.stdout.toString();
    expect(output).toContain('| author-1 | 0123456789abcdef | merged | boundary | 45 | merged |');
    expect(output).not.toContain('| discarded |');
    expect(readFileSync(summaries, 'utf8')).not.toContain('goalId');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
