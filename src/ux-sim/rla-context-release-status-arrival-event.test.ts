import { expect, test } from 'bun:test';
import { simulateReleaseStatusArrivalEvent } from './rla-context-release-status-arrival-event.js';

test('RLA context bus arrival event updates CLI, TUI, and Telegram without a seeded graph run', async () => {
  const snapshots = await simulateReleaseStatusArrivalEvent();
  expect(snapshots).toHaveLength(1);
  const [snapshot] = snapshots;
  expect(snapshot?.release).toMatchObject({ version: '9.8.7', status: 'running', currentNode: 'done', phase: 'done' });
  expect(snapshot?.release?.sourceRefs?.find(ref => ref.signal === 'node-arrival')?.source)
    .toBe(snapshot?.expectedArrivalSource);
  expect(snapshot?.cli).toContain('현재 done');
  expect(snapshot?.telegram).toContain('현재 done');
  expect(snapshot?.tui.join('\n')).toContain('현재 done');
  expect(snapshot?.tui.join('\n')).toContain('node-arrival=elanous://graph-event/');
});
