import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginWithCodex } from '../oauth/codex.js';
import { buildUserConfig, MODEL_ROLES, resolveRoleLlm } from '../user-config.js';
import { runFirstRun } from '../onboarding/first-run.js';
import { firstChatGate } from '../onboarding/first-chat-gate.js';
import { runFirstRunProviderSetup } from '../cli/setup-keys.js';
import { OPENROUTER_ONBOARDING_CHOICES, SOLAR_DEMO_PRESET_ID } from '../cli/first-run/openrouter-picker.js';
import { resolveProviderCredentialAsync } from '../llm/provider-credentials.js';
import { makeOpenRouterProvider } from '../llm.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { testFakeLlmProvider } from './fake-llm.js';
import { withFakeFetchDevice } from './fake-fetch.js';
import { createWorld, destroyWorld, executeWorldScenario } from './world.js';

const appScenario = join(import.meta.dir, '../../scenarios/ux-sim/app-demo-1114.yaml');

test('SOLAR-ONBOARDING-OPENROUTER sim: empty config to key, Solar chat, implement role and app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'solar-onboarding-world-'));
  const path = join(root, 'config.json');
  const env: NodeJS.ProcessEnv = {};
  const secrets = new Map<string, string>();
  const key = 'sim-openrouter-key-must-stay-private';
  const lines: string[] = [];
  const presetIndex = OPENROUTER_ONBOARDING_CHOICES.findIndex((choice) => choice.id === SOLAR_DEMO_PRESET_ID) + 1;
  const answers = ['2', '1', String(presetIndex)];
  const previousRoot = getTestStateRoot();
  const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    setTestStateRoot(root);
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    const initial = buildUserConfig(path);
    expect(initial.onboarding.ready).not.toBe(true);
    const result = await runFirstRun({
      path, config: initial, env, isTTY: true, locale: 'ko', print: (line) => lines.push(line),
      detectProviders: async () => [],
      getSecretAsync: async (id) => secrets.get(id),
      setupWhenNoProvider: (config) => runFirstRunProviderSetup({
        ask: async () => answers.shift() ?? '',
        print: (line) => lines.push(line),
      }, {
        config, env, homeDir: root, cwd: root, configPath: path, loginWithCodex,
        readOpenRouterSecret: async () => secrets.get('cred:openrouter.api_key'),
        openRouterPkce: async () => key,
        verifier: async () => ({ success: true, verification: 'verified' }),
        saveCredentialSlotBatch: async (values) => {
          for (const [id, value] of Object.entries(values)) secrets.set(id, value);
        },
      }),
    });
    expect(result).toEqual({ outcome: 'ready', provider: 'openrouter', inputs: 1 });
    expect(answers).toEqual([]);
    const saved = buildUserConfig(path);
    expect(saved.onboarding.ready).toBe(true);
    expect(saved.llm.provider).toBe('openrouter');
    expect(saved.llm.model).toBe('openrouter/upstage/solar-pro4');
    expect(saved.llm.apiKey).toBeUndefined();
    expect(secrets.get('cred:openrouter.api_key')).toBe(key);
    for (const role of MODEL_ROLES) {
      const selected = resolveRoleLlm(role, { config: saved });
      expect(selected.provider).toBe('openrouter');
      expect(selected.model).toMatch(/^openrouter\/upstage\/solar-(?:pro|mini)4$/);
    }
    expect(resolveRoleLlm('implement', { config: saved }).model).toBe('openrouter/upstage/solar-pro4');
    expect(await firstChatGate(saved, {
      isTTY: false,
      runFirstRun: async () => { throw new Error('ready chat must not re-enter onboarding'); },
      runInteractive: async () => { throw new Error('non-TTY chat must not prompt'); },
      print: (line) => lines.push(line),
    })).toBe('continue');
    const credential = await resolveProviderCredentialAsync({
      provider: saved.llm.provider, baseProvider: saved.llm.provider,
      rotation: saved.llm.rotation, baseApiKey: saved.llm.apiKey, env: {},
    }, async (id) => secrets.get(id));
    expect(credential.source).toBe('secret-store');
    const requests: Array<{ url: string; model: string; authorization: string; messages: Array<{ role: string; content: string }> }> = [];
    await withFakeFetchDevice([{
      url: 'https://openrouter.ai/api/v1/chat/completions', method: 'POST',
      response: (request) => {
        const body = JSON.parse(request.body ?? '{}');
        requests.push({ url: request.url, model: body.model, authorization: request.headers.authorization ?? '', messages: body.messages });
        const answer = `solar-${requests.length}`;
        return new Response(`data: {"choices":[{"delta":{"content":"${answer}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { status: 200 });
      },
    }], async () => {
      const provider = makeOpenRouterProvider({ ...saved.llm, apiKey: credential.apiKey });
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const turn of [1, 2, 3]) {
        history.push({ role: 'user', content: `Solar 질문 ${turn}` });
        const events = await Array.fromAsync(provider.streamChat!(history));
        const answer = events.filter((event) => event.type === 'text').map((event) => event.delta).join('');
        expect(answer).toBe(`solar-${turn}`);
        history.push({ role: 'assistant', content: answer });
      }
    });
    expect(requests).toHaveLength(3);
    expect(requests.map(({ model }) => model)).toEqual(Array(3).fill('upstage/solar-pro4'));
    expect(requests.map(({ authorization }) => authorization)).toEqual(Array(3).fill(`Bearer ${key}`));
    expect(requests.map(({ messages }) => messages.length)).toEqual([1, 3, 5]);
    expect(requests[1]!.messages[1]).toMatchObject({ role: 'assistant', content: 'solar-1' });
    expect(requests[2]!.messages[3]).toMatchObject({ role: 'assistant', content: 'solar-2' });
    const firstChat = await Array.fromAsync(testFakeLlmProvider.chat([{ role: 'user', content: 'Solar 첫 채팅' }]));
    expect(firstChat.join('')).toBe('[test-fake-llm] OK');
    world = await createWorld(appScenario);
    const app = await executeWorldScenario(world, appScenario);
    expect(app.pass).toBe(true);
    expect(app.publicShare).toMatchObject({ status: 200, version: 'v3-generated-1114' });
    expect(world.networkEvents).toEqual([]);
    expect(lines.join('\n')).not.toContain(key);
  } finally {
    if (world) await destroyWorld(world);
    setTestStateRoot(previousRoot ?? null);
    if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    rmSync(root, { recursive: true, force: true });
  }
});
