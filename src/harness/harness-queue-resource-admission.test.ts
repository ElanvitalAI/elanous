import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { addHarnessQueue, tickHarnessQueue, withQueueRecommendation, type HarnessQueueDeps } from './harness-queue.js';

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'harness-queue-resource-admission-'));
  roots.push(path);
  return path;
};
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(dir: string, recommended: number | null, hostLoad: number | null | (() => number | null), launched: number[]): HarnessQueueDeps {
  return {
    root: dir,
    pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 2, recommended }),
    resourceHostLoad: typeof hostLoad === 'function' ? hostLoad : () => hostLoad,
    cap: () => 2,
    processes: () => [],
    burstMax: 1,
    launchStaggerMs: 0,
    authorShadow: () => {},
    idleRequest: () => {},
    launch: async () => { launched.push(1); return 101; },
    log: () => {},
  };
}

test('queue emits resource allow/deny/unmeasured beside policy and keeps the actual launch unchanged', async () => {
  const original = debug.log;
  const events: Record<string, unknown>[] = [];
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'harness.queue' && event === 'admission-shadow') events.push(data as Record<string, unknown>);
  }) as typeof debug.log;
  try {
    const deniedLaunches: number[] = [];
    const denied = fixture(root(), 0, 0.25, deniedLaunches);
    const deniedItem = await addHarnessQueue({ seat: 'TC', say: 'shadow zero headroom' }, denied);
    expect(await tickHarnessQueue(denied)).toMatchObject({ outcome: 'launched' });
    expect(deniedLaunches).toEqual([1]);

    const allowedLaunches: number[] = [];
    const allowed = fixture(root(), 2, 0.25, allowedLaunches);
    const allowedItem = await addHarnessQueue({ seat: 'TC', say: 'shadow available' }, allowed);
    expect(await tickHarnessQueue(allowed)).toMatchObject({ outcome: 'launched' });
    expect(allowedLaunches).toEqual([1]);

    const unknownLaunches: number[] = [];
    const unknown = fixture(root(), null, null, unknownLaunches);
    const unknownItem = await addHarnessQueue({ seat: 'TC', say: 'shadow unmeasured' }, unknown);
    expect(await tickHarnessQueue(unknown)).toMatchObject({ outcome: 'launched' });
    expect(unknownLaunches).toEqual([1]);

    const throwingLoadLaunches: number[] = [];
    const throwingLoad = fixture(root(), 2, () => { throw new Error('load probe unavailable'); }, throwingLoadLaunches);
    const throwingItem = await addHarnessQueue({ seat: 'TC', say: 'shadow load error' }, throwingLoad);
    expect(await tickHarnessQueue(throwingLoad)).toMatchObject({ outcome: 'launched' });
    expect(throwingLoadLaunches).toEqual([1]);

    expect(events).toEqual([
      { id: deniedItem.id, seat: 'TC', policy: { allow: true, reason: 'within-cap', cap: 2 }, resource: 'deny', resourceReason: 'pool-headroom-empty', agree: false, poolHeadroom: 0, hostLoad: 0.25 },
      { id: allowedItem.id, seat: 'TC', policy: { allow: true, reason: 'within-cap', cap: 2 }, resource: 'allow', resourceReason: 'resource-headroom', agree: true, poolHeadroom: 2, hostLoad: 0.25 },
      { id: unknownItem.id, seat: 'TC', policy: { allow: true, reason: 'within-cap', cap: 2 }, resource: 'unmeasured', resourceReason: 'resource-input-unmeasured', agree: null, poolHeadroom: null, hostLoad: null },
      { id: throwingItem.id, seat: 'TC', policy: { allow: true, reason: 'within-cap', cap: 2 }, resource: 'unmeasured', resourceReason: 'resource-input-unmeasured', agree: null, poolHeadroom: 2, hostLoad: null },
    ]);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('a failed resource recommendation leaves the measured policy pool fields intact', () => {
  expect(withQueueRecommendation({ running: 1, pending: 2, reserved: 3, limit: 8 }, () => {
    throw new Error('recommendation config unreadable');
  })).toEqual({ running: 1, pending: 2, reserved: 3, limit: 8, recommended: null });
});

test('a throwing injected host-load probe is unmeasured and cannot block policy launch', async () => {
  const launched: number[] = [];
  const events: Record<string, unknown>[] = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'harness.queue' && event === 'admission-shadow') events.push(data as Record<string, unknown>);
  }) as typeof debug.log;
  try {
    const deps = fixture(root(), 2, () => { throw new Error('injected host load failure'); }, launched);
    const item = await addHarnessQueue({ seat: 'TC', say: 'throwing host-load regression' }, deps);
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched' });
    expect(launched).toEqual([1]);
    expect(events).toEqual([{
      id: item.id,
      seat: 'TC',
      policy: { allow: true, reason: 'within-cap', cap: 2 },
      resource: 'unmeasured',
      resourceReason: 'resource-input-unmeasured',
      agree: null,
      poolHeadroom: 2,
      hostLoad: null,
    }]);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});
