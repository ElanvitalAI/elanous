import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createWorld, destroyWorld, executeWorldScenario, parseSimWorld } from './world.js';

const scenario = join(import.meta.dir, '../../scenarios/ux-sim/app-demo-1114.yaml');

test('SIM-CHAIN-APP keeps existing app-host steps valid and rejects malformed self-contained steps', async () => {
  const source = await Bun.file(scenario).text();
  expect(parseSimWorld(source).apps?.map((app) => app.slug)).toEqual(['voice-notes', 'shop-studio']);
  expect(parseSimWorld(source.replace('observe: app-demo-1114', 'observe: app-host')).apps).toBeDefined();
  expect(() => parseSimWorld(source.replace('  - observe: app-demo-1114', '  - null')))
    .toThrow('world.steps must be a list of scenario step objects');
});

test('SIM-CHAIN-APP rehearses the KAIST voice-note and shop flow hermetically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-app-demo-1114-'));
  const previousRoot = getTestStateRoot();
  const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
  setTestStateRoot(root);
  process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
  const changedTranscript = '상품 설명 <script>alert(1)</script>을 확인해 주세요';
  const source = await Bun.file(scenario).text();
  const originalFile = join(root, 'app-demo-1114-original.yaml');
  const changedFile = join(root, 'app-demo-1114-changed.yaml');
  writeFileSync(originalFile, source.replace('world: app-demo-1114', 'world: app-demo-1114-original'));
  writeFileSync(changedFile, source.replace('world: app-demo-1114', 'world: app-demo-1114-changed')
    .replace('transcript: 상품 소개 자료를 확인해 주세요', `transcript: '${changedTranscript}'`));
  let originalWorld: Awaited<ReturnType<typeof createWorld>> | undefined;
  let changedWorld: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    originalWorld = await createWorld(originalFile);
    const original = await executeWorldScenario(originalWorld, originalFile);
    changedWorld = await createWorld(changedFile);
    const result = await executeWorldScenario(changedWorld, changedFile);
    expect(result.pass).toBe(true);
    expect(original.pass).toBe(true);
    expect(result.billing).toEqual({ provider: 'fake-higgsfield', spendCents: 0, externalNetworkAttempts: 0 });
    expect(result.observations.map((row) => row.event)).toEqual([
      'demo-build-and-deploy', 'product-photo-upload', 'higgsfield-job', 'recording-and-transcription',
      'summary-todos-and-tts', 'one-line-change-and-redeploy', 'public-share-link',
    ]);
    expect(result.observations.find((row) => row.event === 'higgsfield-job')?.verdict).toContain('fake-provider submissions=1');
    expect(result.observations.find((row) => row.event === 'higgsfield-job')?.verdict).toContain('external-provider-calls=0');
    expect(original.publicShare).toMatchObject({ status: 200, version: 'v3-generated-1114' });
    expect(result.publicShare).toMatchObject({ status: 200, version: 'v3-generated-1114' });
    expect(result.publicShare?.body).not.toBe(original.publicShare?.body);
    expect(result.publicShare?.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.publicShare?.body).toContain('을 확인해 주세요');
    expect(result.publicShare?.body).not.toContain('<script>');
    expect(result.publicShare?.body).toContain('data-app-version="v3-generated-1114"');
    const output = JSON.stringify({ original, changed: result });
    for (const value of ['SIM-SECRET-OPENAI-DO-NOT-LEAK', 'SIM-SECRET-TTS-DO-NOT-LEAK',
      'SIM-SECRET-HIGGSFIELD-ID-DO-NOT-LEAK', 'SIM-SECRET-HIGGSFIELD-KEY-DO-NOT-LEAK']) {
      expect(output).not.toContain(value);
    }
    expect(originalWorld.networkEvents).toEqual([]);
    expect(changedWorld.networkEvents).toEqual([]);
  } finally {
    if (originalWorld) await destroyWorld(originalWorld);
    if (changedWorld) await destroyWorld(changedWorld);
    setTestStateRoot(previousRoot ?? null);
    if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    rmSync(root, { recursive: true, force: true });
  }
});
