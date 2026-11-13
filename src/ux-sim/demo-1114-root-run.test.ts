import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo1114Root, type DemoSceneNumber, type DemoSceneReceipt } from './demo-1114-root-run.js';

const sourceCommit = 'a'.repeat(40);
const memberId = 'member-demo';
const deviceIds = { 1: 'demo-scene-device', 2: 'demo-scene-device', 3: 'demo-scene-device',
  4: 'demo-scene-device', 5: 'demo-scene-device', 6: 'demo-scene-device' } as const;

function scenes(root: string, override?: (receipt: DemoSceneReceipt) => DemoSceneReceipt) {
  const calls: DemoSceneNumber[] = [];
  const adapters = Object.fromEntries(([1, 2, 3, 4, 5, 6] as DemoSceneNumber[]).map(scene => [scene,
    async ({ rootRunId, previous }: { rootRunId: string; previous: readonly DemoSceneReceipt[] }) => {
      calls.push(scene);
      expect(previous.map(row => row.scene)).toEqual(calls.slice(0, -1));
      const receipt: DemoSceneReceipt = { scene, status: 'done', rootRunId,
        sceneRunId: `${rootRunId}-s${scene}`, memberId, sourceScrapId: 'scrap-demo', sourceCommit,
        deviceId: 'demo-scene-device', registryCatalogVersion: 2,
        deviceCatalogVersion: 32, evidencePath: join(root, `scene-${scene}.json`) };
      const observed = override?.(receipt) ?? receipt;
      writeFileSync(observed.evidencePath, JSON.stringify(observed));
      return observed;
    }])) as Record<DemoSceneNumber, (input: { rootRunId: string; previous: readonly DemoSceneReceipt[] }) => Promise<DemoSceneReceipt>>;
  return { adapters, calls };
}

test('one production graph run binds all six scene receipts to a root and source scrap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-1114-root-'));
  try {
    const device = scenes(root);
    const result = await runDemo1114Root({ root, memberId, sourceCommit,
      deviceIds, registryCatalogVersion: 2, deviceCatalogVersion: 32, scenes: device.adapters });
    expect(result.graph.status).toBe('done');
    expect(result.graph.path).toEqual(['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-5', 'scene-6', 'done']);
    expect(result.scenes).toHaveLength(6);
    expect(new Set(result.scenes.map(row => row.rootRunId))).toEqual(new Set([result.graph.runId]));
    expect(device.calls).toEqual([1, 2, 3, 4, 5, 6]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a scene with a different source scrap fails the root before later scenes run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-1114-root-drift-'));
  try {
    const device = scenes(root, receipt => receipt.scene === 3 ? { ...receipt, sourceScrapId: 'other-scrap' } : receipt);
    const result = await runDemo1114Root({ root, memberId, sourceCommit,
      deviceIds, registryCatalogVersion: 2, deviceCatalogVersion: 32, scenes: device.adapters });
    expect(result.graph.status).toBe('failed');
    expect(result.graph.path).toEqual(['scene-1', 'scene-2', 'scene-3', 'failed']);
    expect(result.scenes).toHaveLength(2);
    expect(device.calls).toEqual([1, 2, 3]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a wrong scene device ID stops the graph and withholds later scenes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-1114-root-device-drift-'));
  try {
    const device = scenes(root, receipt => receipt.scene === 2 ? { ...receipt, deviceId: 'other-device' } : receipt);
    const result = await runDemo1114Root({ root, memberId, sourceCommit,
      deviceIds, registryCatalogVersion: 2, deviceCatalogVersion: 32, scenes: device.adapters });
    expect(result.graph.status).toBe('failed');
    expect(result.graph.path).toEqual(['scene-1', 'scene-2', 'failed']);
    expect(device.calls).toEqual([1, 2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
