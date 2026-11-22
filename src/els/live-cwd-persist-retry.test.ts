import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

test('proc cwd retries failed journal saves on the same observation, then deduplicates', async () => {
  let stored = emptyJournal();
  let failures = 0;
  let attempts = 0; // 출처: #39597 시험의 저장 시도 횟수 초기값
  const callbacks = new Set<(data: string) => void>();
  const pty: ElsPty = {
    id: 'synthetic-pty', pid: 42, isAlive: () => true, write: () => {},
    renderScreen: async () => '', onExit: () => {}, kill: () => {},
    onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; },
  };
  const core = createElsCore({
    load: () => stored,
    save: journal => {
      attempts++;
      if (failures > 0) { failures--; throw new Error('synthetic disk failure'); }
      stored = journal;
    },
    spawn: () => pty,
    procCwdReader: { read: async () => '/observed', dispose: () => {} },
  });
  const wait = () => new Promise(resolve => setTimeout(resolve, 180));
  try {
    expect(core.start()).toBeUndefined();
    expect(core.newPane({ ws: 'W', cwd: '/original', command: ['sh'] }).exitCode).toBe(0);
    failures = 2;
    await wait();
    expect(stored.panes[0]!.cwd).toBe('/original');
    expect(attempts).toBe(2);
    for (const cb of callbacks) cb('synthetic output');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(stored.panes[0]!.cwd).toBe('/original');
    expect(attempts).toBe(3);
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(stored.panes[0]!.cwd).toBe('/observed');
    expect(attempts).toBe(4);
    for (const cb of callbacks) cb('synthetic output');
    await wait();
    expect(attempts).toBe(4);
  } finally { core.stopAll(); }
});
