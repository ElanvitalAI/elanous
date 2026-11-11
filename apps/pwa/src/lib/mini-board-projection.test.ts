import { describe, expect, test } from 'bun:test';
import { projectMiniBoard } from './mini-board-projection';
import type { BoardColumn } from './task-card-model';

function entry(taskId: string, section: string, ts: number, key: string,
  data: Record<string, unknown> = {}, runId?: string) {
  return { taskId, section, ts, key, owner: 'fake-cap-store', data, ...(runId ? { runId } : {}) };
}

describe('projectMiniBoard', () => {
  test('folds fake store events through the five stages and only reveals a completed public result', () => {
    const events: unknown[] = [];
    const stages: Array<{ event: ReturnType<typeof entry>; column: BoardColumn }> = [
      { event: entry('task-1', 'intake', 1, 'intake', { title: 'KAIST demo', summary: 'Request collected' }), column: 'steward' },
      { event: entry('task-1', 'landing', 2, 'approval', { summary: 'Owner approved' }), column: 'landing' },
      { event: entry('task-1', 'workspace', 3, 'workspace', { summary: 'App source changed' }, '42c1abc9'), column: 'execution' },
      { event: entry('task-1', 'release', 4, 'release-test', { status: 'testing', summary: 'Remote checks running', publicUrl: 'https://demo--owner.elanous.app/' }), column: 'release' },
      { event: entry('task-1', 'release', 5, 'release-done', { status: 'done', summary: 'Upgrade published', publicUrl: 'https://demo--owner.elanous.app/' }, '42c1abc9'), column: 'done' },
    ];

    for (const { event, column } of stages) {
      events.push(JSON.parse(JSON.stringify(event)) as unknown);
      const projected = projectMiniBoard(events);
      const visible = Object.values(projected.columns).flat().find(card => card.taskId === 'task-1');
      expect(visible?.column).toBe(column);
      if (column !== 'done') expect(visible).not.toHaveProperty('resultUrl');
    }
    expect(projectMiniBoard(events).columns.done).toMatchObject([{
      taskId: 'task-1', title: 'KAIST demo', summary: 'Upgrade published', runId: '42c1',
      resultUrl: 'https://demo--owner.elanous.app/',
    }]);
  });

  test('prefers resultUrl, hides invalid URLs, orders cards by latest activity, and leaves inputs untouched', () => {
    const older = entry('older', 'release', 1, 'release', { status: 'completed', publicUrl: 'https://demo--owner.elanous.app/' });
    const newer = entry('newer', 'release', 2, 'release', {
      status: 'done', resultUrl: 'https://result.example/path', publicUrl: 'javascript:alert(1)',
    });
    const events = Object.freeze(JSON.parse(JSON.stringify([older, newer])) as unknown[]);
    const projection = projectMiniBoard(events);
    expect(projection.columns.done.map(card => card.taskId)).toEqual(['newer', 'older']);
    expect(projection.columns.done[0]?.resultUrl).toBe('https://result.example/path');
    expect(events).toEqual([older, newer]);

    const invalid = projectMiniBoard([entry('bad', 'release', 3, 'release', { status: 'done', publicUrl: 'javascript:alert(1)' })]);
    expect(invalid.columns.done[0]).not.toHaveProperty('resultUrl');
  });

  test('ignores malformed JSON event shapes without creating a card', () => {
    const projection = projectMiniBoard([
      { ts: 'later', taskId: 'bad', section: 'release', owner: 'sim', key: 'r1', data: { status: 'done' } },
      { ts: 1, taskId: 'bad-section', section: 'capability', owner: 'sim', key: 'r2', data: { status: 'done' } },
      { ts: 2, taskId: 'bad-run-id', section: 'intake', owner: 'sim', key: 'i2', runId: 7, data: { title: 'Invalid run ID' } },
      { ts: 2, taskId: 'good', section: 'intake', owner: 'sim', key: 'i1', data: { title: 'Valid card' } },
    ]);
    expect(projection.columns.steward.map(card => card.taskId)).toEqual(['good']);
    expect(projection.updatedAt).toBe(2);
  });

  test('uses the newest valid app-publish URL only after release completion', () => {
    const projection = projectMiniBoard([
      entry('published', 'release', 60, 'release-done', { status: 'done' }),
      entry('published', 'run', 50, 'run:unrelated', { publicUrl: 'https://unrelated.example/' }),
      entry('published', 'run', 45, 'app-publish:invalid', { publicUrl: 'javascript:alert(1)' }),
      entry('published', 'run', 35, 'app-publish:latest-valid', { publicUrl: 'https://latest.example/' }),
      entry('published', 'run', 25, 'app-publish:older-valid', { publicUrl: 'https://older.example/' }),
    ]);
    expect(projection.columns.done[0]?.resultUrl).toBe('https://latest.example/');

    const unrelatedOnly = projectMiniBoard([
      entry('unpublished', 'run', 10, 'run:unrelated', { publicUrl: 'https://unrelated.example/' }),
      entry('unpublished', 'release', 20, 'release-done', { status: 'done' }),
    ]);
    expect(unrelatedOnly.columns.done[0]).not.toHaveProperty('resultUrl');
  });

  test('preserves the latest timestamp when valid event timestamps are negative', () => {
    const projection = projectMiniBoard([
      entry('negative-time', 'intake', -5, 'i1', { title: 'Early' }),
      entry('negative-time', 'triage', -2, 't1', { summary: 'Latest negative time' }),
    ]);
    expect(projection.updatedAt).toBe(-2);
  });
});
