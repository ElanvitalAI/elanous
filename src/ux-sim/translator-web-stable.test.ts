import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { createAppDatabase } from '../nexus/apps/app-db.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_RESPONSE_ENV } from './fake-llm.js';
import { createWorld, destroyWorld, executeWorldScenario } from './world.js';

test('NEXUS-WEB-STABLE: translator action and stored result produce a test-world E2E receipt', async () => {
  const template = readFileSync(resolve(import.meta.dir, '../../templates/next-app-translator/app.yaml'), 'utf8');
  const parsed = parseAppManifest(template);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  const root = mkdtempSync(join(tmpdir(), 'translator-web-stable-'));
  const previousRoot = getTestStateRoot();
  const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
  const previousReply = process.env[TEST_FAKE_LLM_RESPONSE_ENV];
  const previousCapture = process.env[TEST_FAKE_LLM_CAPTURE_ENV];
  const worldId = 'translator-web-stable';
  const worldFile = join(root, 'world.yaml');
  const scenarioFile = join(root, 'scenario.yaml');
  const scenario = {
    name: 'translate-and-save',
    steps: [
      { action: 'translate', as: 'owner', input: { text: '안녕하세요', sourceLanguage: '한국어', targetLanguage: 'English' } },
      { rpc: 'addTranslation', as: 'owner', params: {
        id: 'demo-translation', source_text: '안녕하세요', translated_text: { $actionOutput: 'text' },
        source_language: '한국어', target_language: 'English', source_audio: 'apps/translator/audio/demo.webm',
        created_at: '2026-11-10T08:00:00Z',
      } },
      { rpc: 'listTranslations', as: 'owner', params: {} },
    ],
  };
  writeFileSync(worldFile, stringifyYaml({ world: worldId, seed: 0, devices: ['fake-clock'], events: [] }));
  writeFileSync(scenarioFile, stringifyYaml({ world: worldId, steps: [], appSimulation: { manifest: parsed.manifest, scenario } }));
  setTestStateRoot(root);
  process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
  process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'Hello there';
  process.env[TEST_FAKE_LLM_CAPTURE_ENV] = join(root, 'fake-llm-capture.jsonl');
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    world = await createWorld(worldFile);
    const result = await executeWorldScenario(world, scenarioFile);
    if (!result.pass) throw new Error(JSON.stringify({ observations: result.observations, receipts: result.appSimulation?.receipts }));
    expect(result.pass).toBe(true);
    expect(result.appSimulation?.receipts).toEqual([
      expect.objectContaining({ appId: 'translator', outcome: 'passed' }),
    ]);
    expect(result.appSimulation?.events.map(event => event.data.step)).toEqual([
      'action.translate.completed', 'rpc.addTranslation.completed', 'rpc.listTranslations.completed',
    ]);
    expect(result.appSimulationEvidence?.tableRows.translations).toBe(1);
    const database = new Database(join(world.root, 'app-simulation-db', result.appSimulation!.runId, 'translator.db'), { readonly: true });
    try {
      expect(database.query('SELECT translated_text FROM translations WHERE id = ?').get('demo-translation'))
        .toEqual({ translated_text: 'Hello there' });
    } finally { database.close(); }
    const listDatabase = createAppDatabase([parsed.manifest], {
      directory: join(world.root, 'app-simulation-db', result.appSimulation!.runId),
    });
    try {
      expect(listDatabase.rpc('translator', 'listTranslations', {}, 'owner'))
        .toEqual([expect.objectContaining({ id: 'demo-translation', translated_text: 'Hello there' })]);
    } finally { listDatabase.close(); }
    expect(result.externalNetworkEvents).toEqual([]);
    expect(world.networkEvents).toEqual([]);
    const capture = readFileSync(process.env[TEST_FAKE_LLM_CAPTURE_ENV]!, 'utf8');
    expect(capture).toContain('안녕하세요');
    expect(capture).not.toContain('simulated-app-credential');
    console.info(JSON.stringify({ kind: 'translator-test-world-receipt',
      receiptId: result.appSimulation?.receipts[0]?.id, runId: result.appSimulation?.runId,
      outcome: result.appSimulation?.receipts[0]?.outcome,
      tableRows: result.appSimulationEvidence?.tableRows.translations,
      externalNetworkEvents: result.externalNetworkEvents.length }));
  } finally {
    if (world) await destroyWorld(world);
    setTestStateRoot(previousRoot ?? null);
    if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    if (previousReply === undefined) delete process.env[TEST_FAKE_LLM_RESPONSE_ENV];
    else process.env[TEST_FAKE_LLM_RESPONSE_ENV] = previousReply;
    if (previousCapture === undefined) delete process.env[TEST_FAKE_LLM_CAPTURE_ENV];
    else process.env[TEST_FAKE_LLM_CAPTURE_ENV] = previousCapture;
    rmSync(root, { recursive: true, force: true });
  }
});
