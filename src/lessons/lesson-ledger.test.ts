import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonLedger } from './lesson-ledger.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'lessons-ledger-')));
const input = (id: string, source: string, disproof?: string) => ({
  id, incident: 'worktree state changed unexpectedly', cause: 'Shared state', remedy: 'Isolate the state directory', owner: 'TC', source,
  ...(disproof ? { disproof } : {}),
});

test('add, recurrence candidate, promotion disproof, enforcement and ranked find', () => {
  const stateDir = root();
  const ledger = new LessonLedger({ stateDir, now: () => new Date('2026-10-04T00:00:00Z') });
  try {
    expect(ledger.path).toBe(join(stateDir, 'lessons', 'lessons.sqlite'));
    expect(ledger.add(input('L1', 'docs/INCIDENT.md'))).toMatchObject({ status: 'open', occurrence_count: 1 });
    expect(ledger.get('L1').occurrences).toMatchObject([{ source: 'docs/INCIDENT.md', note: '' }]);
    expect(ledger.recur('L1', { source: 'PR#2', note: 'again', by: 'UX' })).toMatchObject({ status: 'candidate', occurrence_count: 2 });
    expect(ledger.candidates().map(row => row.id)).toEqual(['L1']);
    expect(() => ledger.promote('L1', { rulePath: '.rules/rule.md', by: 'UX' })).toThrow('disproof is required');
    expect(ledger.get('L1').history.map(row => row.event)).toEqual(['add', 'recur']);
    ledger.add(input('L2', 'PR#3', 'bun test src/lessons/lesson-ledger.test.ts'));
    expect(ledger.promote('L2', { rulePath: '.rules/20-repo/rule.md', by: 'TC' })).toMatchObject({ status: 'promoted', enforced_by: '.rules/20-repo/rule.md' });
    expect(ledger.recur('L2', { source: 'channel/4', note: '', by: 'TC' })).toMatchObject({ status: 'promoted', occurrence_count: 2 });
    expect(ledger.enforce('L1', { enforcedBy: 'src/lessons/lesson-ledger.test.ts,elanous lesson candidates', by: 'TC' }))
      .toMatchObject({ status: 'enforced', occurrence_count: 2, enforced_by: 'src/lessons/lesson-ledger.test.ts,elanous lesson candidates' });
    expect(ledger.candidates()).toEqual([]);
    expect(ledger.recur('L1', { source: 'PR#5', note: '', by: 'TC' }).status).toBe('candidate');
    expect(ledger.find('WORKTREE').map(row => [row.id, row.occurrence_count])).toEqual([['L1', 3], ['L2', 2]]);
    expect(ledger.find('shared state')).toHaveLength(2);
    expect(ledger.get('L1').history[0]?.by).toBe('TC');
    expect(ledger.find('ISOLATE')).toHaveLength(2);
    expect(ledger.get('L2')).toMatchObject({ status: 'promoted', occurrences: [{ source: 'PR#3' }, { source: 'channel/4' }],
      history: [{ event: 'add' }, { event: 'promote', detail: '.rules/20-repo/rule.md' }, { event: 'recur' }] });
    expect(ledger.enforce('L2', { enforcedBy: 'test/rules-contract.test.ts', by: 'TC' }).status).toBe('promoted');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('list ranks all rows by occurrence count then updated time and filters by status', () => {
  const stateDir = root();
  let clock = '2026-10-04T00:00:00Z';
  const ledger = new LessonLedger({ stateDir, now: () => new Date(clock) });
  try {
    expect(ledger.list()).toEqual([]);
    ledger.add(input('early', 'PR#1'));
    clock = '2026-10-05T00:00:00Z';
    ledger.add(input('late', 'PR#2'));
    ledger.add(input('tie', 'PR#3'));
    clock = '2026-10-06T00:00:00Z';
    ledger.recur('early', { source: 'PR#4', by: 'TC' });
    ledger.recur('late', { source: 'PR#5', by: 'TC' });
    ledger.enforce('tie', { enforcedBy: '.rules/lesson.md', by: 'TC' });
    expect(ledger.list().map(row => row.id)).toEqual(['early', 'late', 'tie']);
    expect(ledger.list({ status: 'candidate' }).map(row => row.id)).toEqual(['early', 'late']);
    expect(ledger.list({ status: 'enforced' }).map(row => row.id)).toEqual(['tie']);
    expect(ledger.list({ status: 'promoted' })).toEqual([]);
    clock = '2026-10-07T00:00:00Z';
    ledger.enforce('late', { enforcedBy: '.rules/another.md', by: 'TC' });
    expect(ledger.list().map(row => row.id)).toEqual(['late', 'early', 'tie']);
    expect(ledger.list({ status: 'candidate' }).map(row => row.id)).toEqual(['early']);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('two instances alternate writes without losing rows or history', () => {
  const stateDir = root();
  const a = new LessonLedger({ stateDir });
  const b = new LessonLedger({ stateDir });
  try {
    a.add(input('L1', 'PR#1'));
    b.add(input('L2', 'PR#2'));
    b.recur('L1', { source: 'PR#3', note: 'repeated', by: 'UX' });
    a.enforce('L2', { enforcedBy: 'test/rules-contract.test.ts', by: 'TC' });
    expect(a.get('L1')).toMatchObject({ occurrence_count: 2, status: 'candidate', history: [{ event: 'add' }, { event: 'recur' }] });
    expect(b.get('L2')).toMatchObject({ occurrence_count: 1, status: 'enforced', history: [{ event: 'add' }, { event: 'enforce' }] });
    expect(() => b.add(input('L1', 'PR#4'))).toThrow();
    expect(a.get('L1').occurrence_count).toBe(2);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
