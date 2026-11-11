import { expect, test } from 'bun:test';
import type { TaskCardEntry } from '../../apps/pwa/src/lib/task-card-model.js';
import { projectMiniBoardCard, replayMiniBoardEvents } from './mini-board-card.js';

const cardId = 'task-kaist-demo';

function event(section: TaskCardEntry['section'], ts: number, key: string, data: Record<string, unknown>): TaskCardEntry {
  return { taskId: cardId, ts, section, owner: 'sim', key, data, runId: 'run-12345678' };
}

test('mini-board replays existing task-card section events through all five columns', () => {
  const events = [
    event('intake', 1, 'proposal', { title: 'KAIST demo', summary: 'Prepare the demo workspace' }),
    event('landing', 2, 'approved', { summary: 'Approved by the owner' }),
    event('workspace', 3, 'development', { summary: 'Building the demo app' }),
    event('release', 4, 'test', { status: 'testing', summary: 'Remote rehearsal is running' }),
    event('release', 5, 'deployed', { status: 'done', summary: 'Demo published', resultUrl: 'https://demo.example.test/' }),
  ];

  const transitions = replayMiniBoardEvents(events);

  expect(transitions.map(({ stage }) => stage)).toEqual([
    'proposal', 'approved', 'in-development', 'test', 'deployed',
  ]);
  expect(transitions.map(({ column }) => column)).toEqual([
    'steward', 'landing', 'execution', 'release', 'done',
  ]);
  expect(transitions.at(-1)).toMatchObject({
    taskId: cardId,
    title: 'KAIST demo',
    summary: 'Demo published',
    runId: '12345678',
    resultUrl: 'https://demo.example.test/',
  });
});

test('result URL is hidden until the existing release section is complete', () => {
  const card = {
    taskId: cardId,
    sections: {
      intake: event('intake', 1, 'proposal', { title: 'KAIST demo' }),
      release: event('release', 2, 'test', { status: 'testing', resultUrl: 'https://demo.example.test/' }),
    },
    incidents: [],
    updatedAt: 2,
  };

  expect(projectMiniBoardCard(card)).toMatchObject({ stage: 'test', title: 'KAIST demo' });
  expect(projectMiniBoardCard(card)).not.toHaveProperty('resultUrl');
});
