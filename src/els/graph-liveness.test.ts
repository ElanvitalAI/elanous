// Fake ledger events with a controllable clock, exercising the actual els child tree.
import { expect, test } from 'bun:test';
import { createElsCore } from './core.js';
import { createChildTabs } from './child-tabs.js';
import { emptyJournal } from './space.js';

test('graph-node liveness uses the last event at the 5 and 25 minute boundaries', () => {
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => { throw new Error('no pty'); } });
  core.start();
  let now = 0;
  const tabs = createChildTabs({ core, now: () => now, setTimer: () => 1, clearTimer: () => {} });
  tabs.start({ id: 'run', ws: 'W', source: 'graph', label: 'build' });
  tabs.start({ id: 'node', ws: 'W', source: 'graph-node', parent: 'run', label: 'verify' });
  tabs.progress('node', 'round 1');
  const line = () => tabs.tree('W').find(row => row.id === 'node')!.text;
  now = 300_000; expect(line()).toBe('  🟢 verify · round 1');
  now = 300_001; expect(line()).toBe('  ⏸ verify · round 1');
  now = 1_500_000; expect(line()).toBe('  ⏸ verify · round 1');
  now = 1_500_001; expect(line()).toBe('  🔴 verify · round 1');
  tabs.progress('node', 'round 2');
  expect(line()).toBe('  🟢 verify · round 2');
  tabs.end('node', true, 'done');
  now += 1_800_000; expect(line()).toBe('  ✅ verify · done');
});
