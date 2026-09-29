import { describe, expect, test } from 'bun:test';
import { boardColumn, cardTitle, foldCard, type TaskCardEntry } from './task-card-model';

function entry(section: TaskCardEntry['section'], ts: number, key: string, data: Record<string, unknown> = {}): TaskCardEntry {
  return { taskId: 'task-1', ts, section, key, owner: 'loop', data };
}

function card(...entries: TaskCardEntry[]) {
  const folded = foldCard(entries);
  if (!folded) throw new Error('expected a card');
  return folded;
}

describe('foldCard', () => {
  test('empty journal has no card', () => {
    expect(foldCard([])).toBeNull();
  });

  test('duplicate keys do not overwrite sections, update the timestamp, or repeat incidents', () => {
    const original = entry('intake', 10, 'intake-1', { title: 'Original' });
    const incident = entry('incidents', 11, 'incident-1', { kind: 'pod-oom' });
    const folded = card(original, { ...original, ts: 99, data: { title: 'Duplicate' } }, incident,
      { ...incident, ts: 100, data: { kind: 'duplicate' } });
    expect(folded.sections.intake).toEqual(original);
    expect(folded.incidents).toEqual([incident]);
    expect(folded.updatedAt).toBe(11);
  });

  test('latest section by timestamp wins independently of journal order; other sections remain', () => {
    const newest = entry('gates', 30, 'gate-2', { budget: 'proceed', location: 'pod' });
    const oldest = entry('gates', 10, 'gate-1', { budget: 'wait-reset' });
    const intake = entry('intake', 20, 'intake-1', { title: 'Keep me' });
    const folded = card(newest, intake, oldest);
    expect(folded.sections.gates).toEqual(newest);
    expect(folded.sections.intake).toEqual(intake);
    expect(folded.updatedAt).toBe(30);
  });

  test('incidents accumulate while subsequent sections are replaced without mutating input', () => {
    const first = entry('incidents', 2, 'incident-1', { kind: 'quota' });
    const second = entry('incidents', 5, 'incident-2', { kind: 'pod-oom' });
    const oldRun = entry('run', 3, 'run-1', { stage: 'started' });
    const newRun = { ...entry('run', 4, 'run-2', { stage: 'review' }), runId: 'run-12345678' };
    const journal = Object.freeze([first, oldRun, second, newRun]);
    const folded = card(...journal);
    expect(folded.incidents).toEqual([first, second]);
    expect(folded.sections.run).toEqual(newRun);
    expect(folded.runId).toBe('run-12345678');
    expect(journal).toEqual([first, oldRun, second, newRun]);
  });

  test('does not mix events from another task into the card', () => {
    const other = { ...entry('incidents', 20, 'other', { kind: 'unrelated' }), taskId: 'task-2' };
    expect(card(entry('intake', 1, 'first'), other).incidents).toEqual([]);
  });
});

describe('boardColumn', () => {
  test('places a card in each of the five columns', () => {
    expect(boardColumn(card(entry('intake', 1, 'a')))).toBe('steward');
    expect(boardColumn(card(entry('triage', 1, 'a'), entry('gates', 2, 'b')))).toBe('execution');
    expect(boardColumn(card(entry('run', 1, 'a'), entry('landing', 2, 'b')))).toBe('landing');
    expect(boardColumn(card(entry('landing', 1, 'a'), entry('release', 2, 'b', { status: 'pending' })))).toBe('release');
    expect(boardColumn(card(entry('release', 1, 'a', { status: 'done' })))).toBe('done');
  });
});

describe('cardTitle', () => {
  test('uses the latest triage title then intake, falling back to taskId', () => {
    expect(cardTitle(card(entry('intake', 1, 'a', { title: 'Initial' }),
      entry('triage', 2, 'b', { title: 'Old' }), entry('triage', 3, 'c', { title: 'Current' })))).toBe('Current');
    expect(cardTitle(card(entry('intake', 1, 'a', { title: 'Initial' })))).toBe('Initial');
    expect(cardTitle(card(entry('intake', 1, 'a')))).toBe('task-1');
  });
});
