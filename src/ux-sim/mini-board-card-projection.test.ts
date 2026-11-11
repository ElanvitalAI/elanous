import { expect, test } from 'bun:test';
import type { TaskCardEntry } from '../../apps/pwa/src/lib/task-card-model.js';
import { projectMiniBoard } from '../../apps/pwa/src/lib/mini-board-projection.js';
import { replayMiniBoardEvents } from './mini-board-card.js';

function event(section: TaskCardEntry['section'], ts: number, key: string,
  data: Record<string, unknown>, runId?: string): TaskCardEntry {
  return { taskId: 'kaist-demo', section, ts, key, owner: 'fake-cap-store', data, ...(runId ? { runId } : {}) };
}

test('JSON store projection agrees with the existing UX mini-board device', () => {
  const events = [
    event('intake', 1, 'intake:1', { title: 'KAIST demo', summary: 'Request collected' }),
    event('landing', 2, 'landing:1', { summary: 'Owner approved' }),
    event('workspace', 3, 'workspace:1', { summary: 'Isolated app changed' }, '42c1a2b3'),
    event('release', 4, 'release:test', { status: 'testing', summary: 'Simulation passed' }, '42c1a2b3'),
    event('run', 5, 'app-publish:result', { summary: 'App host published', publicUrl: 'https://kaist-demo--owner.elanous.app/' }, '42c1a2b3'),
    event('release', 6, 'release:done', { status: 'done', summary: 'Published' }, '42c1a2b3'),
  ];

  const deviceTransitions = replayMiniBoardEvents(events);
  const serializedEvents: unknown[] = JSON.parse(JSON.stringify(events));
  for (let index = 0; index < serializedEvents.length; index += 1) {
    const projection = projectMiniBoard(serializedEvents.slice(0, index + 1));
    const projectedCard = Object.values(projection.columns).flat().find(card => card.taskId === 'kaist-demo');
    const device = deviceTransitions[index];
    expect(projectedCard).toMatchObject({
      taskId: 'kaist-demo',
      title: device?.title,
      summary: device?.summary,
      column: device?.column,
    });
    if (index < serializedEvents.length - 1) expect(projectedCard).not.toHaveProperty('resultUrl');
    if (index >= 2) expect(projectedCard?.runId).toBe('42c1');
  }
  const projectedCard = projectMiniBoard(serializedEvents).columns.done[0];
  expect(projectedCard).toMatchObject({
    taskId: 'kaist-demo',
    title: deviceTransitions.at(-1)?.title,
    summary: deviceTransitions.at(-1)?.summary,
    runId: '42c1',
    resultUrl: 'https://kaist-demo--owner.elanous.app/',
  });
});
