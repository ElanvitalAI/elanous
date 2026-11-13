import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo1114RootPlan } from './demo1114-root-run.js';

test('operating CLI plan starts six scene commands inside one graph run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-root-cli-'));
  const beforeBearer = process.env.DEMO_DEVICE_REGISTRY_BEARER;
  process.env.DEMO_DEVICE_REGISTRY_BEARER = 'isolated-registry-token';
  const registry = Bun.serve({ port: 0, fetch: request => request.headers.get('authorization')
    === 'Bearer isolated-registry-token' ? Response.json({ catalogVersion: 2,
      deviceCatalogVersion: 32, devices: [{ id: 'scene-device' }] }) : new Response(null, { status: 401 }) });
  try {
    const entryFile = join(root, 'scene.ts');
    writeFileSync(entryFile, `import { writeFileSync } from 'node:fs';
const scene = Number(process.env.DEMO_SCENE);
const evidencePath = process.env.DEMO_SCENE_RECEIPT_PATH;
writeFileSync(evidencePath, JSON.stringify({ scene, status: 'done',
  rootRunId: process.env.DEMO_ROOT_RUN_ID, sceneRunId: process.env.DEMO_ROOT_RUN_ID + '-s' + scene,
  memberId: process.env.DEMO_MEMBER_ID, sourceScrapId: process.env.DEMO_SOURCE_SCRAP_ID || 'scrap-1',
  sourceCommit: process.env.DEMO_SOURCE_COMMIT, deviceId: 'scene-device',
  registryCatalogVersion: 2, deviceCatalogVersion: 32, evidencePath,
  registryBearerPresent: Boolean(process.env.DEMO_DEVICE_REGISTRY_BEARER) }));\n`);
    const entries = [1, 2, 3, 4, 5, 6] as const;
    const result = await runDemo1114RootPlan({ root,
      registryUrl: `http://127.0.0.1:${registry.port}/v1/ux-sim/devices`,
      memberId: 'member-1', sourceCommit: 'a'.repeat(40),
      registryCatalogVersion: 2, deviceCatalogVersion: 32,
      deviceIds: Object.fromEntries(entries.map(scene => [scene, 'scene-device'])) as Record<typeof entries[number], string>,
      sceneCommands: Object.fromEntries(entries.map(scene => [scene, {
        entryFile, cwd: root, receiptPath: join(root, `scene-${scene}.json`),
      }])) as Record<typeof entries[number], { entryFile: string; cwd: string; receiptPath: string }>,
    });
    expect(result.graph.status).toBe('done');
    expect(result.scenes).toHaveLength(6);
    expect(new Set(result.scenes.map(row => row.rootRunId))).toEqual(new Set([result.graph.runId]));
    expect(new Set(result.scenes.map(row => row.sourceScrapId))).toEqual(new Set(['scrap-1']));
    expect(JSON.parse(readFileSync(join(root, 'scene-1.json'), 'utf8')).registryBearerPresent).toBe(false);
  } finally {
    registry.stop(); rmSync(root, { recursive: true, force: true });
    if (beforeBearer === undefined) delete process.env.DEMO_DEVICE_REGISTRY_BEARER;
    else process.env.DEMO_DEVICE_REGISTRY_BEARER = beforeBearer;
  }
});

test('operating CLI rejects missing bearer, plaintext off-loopback and caller-plus-server version drift', async () => {
  const beforeBearer = process.env.DEMO_DEVICE_REGISTRY_BEARER;
  const root = mkdtempSync(join(tmpdir(), 'demo-root-registry-negative-'));
  const registry = Bun.serve({ port: 0, fetch: () => Response.json({ catalogVersion: 3,
    deviceCatalogVersion: 33, devices: [{ id: 'scene-device' }] }) });
  const redirect = Bun.serve({ port: 0, fetch: () => Response.redirect('https://example.test/v1/ux-sim/devices') });
  const plan = { root, registryUrl: `http://127.0.0.1:${registry.port}/v1/ux-sim/devices`,
    memberId: 'member-1', sourceCommit: 'a'.repeat(40), registryCatalogVersion: 2,
    deviceCatalogVersion: 32, deviceIds: { 1: 'scene-device', 2: 'scene-device',
      3: 'scene-device', 4: 'scene-device', 5: 'scene-device', 6: 'scene-device' },
    sceneCommands: {} } as Parameters<typeof runDemo1114RootPlan>[0];
  try {
    delete process.env.DEMO_DEVICE_REGISTRY_BEARER;
    await expect(runDemo1114RootPlan(plan)).rejects.toThrow('bearer is required');
    process.env.DEMO_DEVICE_REGISTRY_BEARER = 'isolated-registry-token';
    await expect(runDemo1114RootPlan({ ...plan, registryUrl: 'http://example.test/v1/ux-sim/devices' }))
      .rejects.toThrow('HTTP requires loopback');
    await expect(runDemo1114RootPlan({ ...plan, registryCatalogVersion: 3, deviceCatalogVersion: 33 }))
      .rejects.toThrow('untrusted catalog versions');
    await expect(runDemo1114RootPlan(plan)).rejects.toThrow('does not match the pinned plan');
    await expect(runDemo1114RootPlan({ ...plan,
      registryUrl: `http://127.0.0.1:${redirect.port}/v1/ux-sim/devices` })).rejects.toThrow();
  } finally {
    registry.stop(); redirect.stop(); rmSync(root, { recursive: true, force: true });
    if (beforeBearer === undefined) delete process.env.DEMO_DEVICE_REGISTRY_BEARER;
    else process.env.DEMO_DEVICE_REGISTRY_BEARER = beforeBearer;
  }
});
