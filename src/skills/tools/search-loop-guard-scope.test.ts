import { beforeEach, expect, test } from 'bun:test';
import { withAmbientSessionScope } from '../../debug/log.js';
import { noteBroadSearch, resetSearchLoopGuardForTest, runInSearchLoopScope } from './search-loop-guard.js';

beforeEach(() => resetSearchLoopGuardForTest());

test('a capsule has its own broad-search counter — parent searches do not block the child', async () => {
  for (let i = 0; i < 3; i += 1) expect(noteBroadSearch(['grep', 'parent', String(i)]).blocked).toBe(false);
  // child starts fresh even though the parent is one step from the block threshold (4)
  await runInSearchLoopScope('capsule:t1', async () => {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      expect(noteBroadSearch(['grep', 'child', String(i)]).blocked).toBe(false);
    }
  });
  // the parent's 4th broad search still blocks — the child's 3 did not reset or add to it
  expect(noteBroadSearch(['grep', 'parent', '3'])).toEqual({ blocked: true, consecutive: 4 });
});

test('two capsules do not share a counter', () => {
  runInSearchLoopScope('capsule:a', () => { for (let i = 0; i < 3; i += 1) noteBroadSearch(['a', String(i)]); });
  runInSearchLoopScope('capsule:b', () => {
    expect(noteBroadSearch(['b', '0']).blocked).toBe(false);
  });
  expect(runInSearchLoopScope('capsule:a', () => noteBroadSearch(['a', '3']))).toEqual({ blocked: true, consecutive: 4 });
});

test('a capsule inside the parent ambient session still gets its own counter', async () => {
  await withAmbientSessionScope('sess-parent', async () => {
    for (let i = 0; i < 3; i += 1) noteBroadSearch(['p', String(i)]);
    await runInSearchLoopScope('capsule:t9', async () => {
      await Promise.resolve();
      expect(noteBroadSearch(['c', '0']).blocked).toBe(false);
    });
    expect(noteBroadSearch(['p', '3'])).toEqual({ blocked: true, consecutive: 4 });
  });
});
