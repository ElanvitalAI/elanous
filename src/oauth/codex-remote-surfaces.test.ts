import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProviderForConfig, PROVIDERS, streamLLM } from '../llm.js';
import { setUserConfigOverlay } from '../user-config.js';
import type { UserConfig } from '../user-config/types.js';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { codexOwnerMirrorAuthPath } from './codex-owner-mirror.js';
import { resolveCodexAccountForRun } from './codex-account-store.js';

test('Pod, remote tab, and remote API review consume the same owner Codex mirror', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-remote-surfaces-'));
  const saved = { ...process.env };
  const state = join(root, 'state');
  const derived = join(state, 'remote-parent-credentials', 'cli-mirror', 'auth.json');
  const podMirror = join(root, 'pod', 'remote-parent-credentials', 'cli-mirror', 'auth.json');
  const expiry = Date.now() + 3_600_000;
  const token = (name: string) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expiry / 1000), name })).toString('base64url')}.sig`;
  const writeMirror = (path: string, accessToken: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, providers: { 'openai-codex:team': {
      source: 'mirror', authMode: 'chatgpt', codexHome: join(root, 'codex-team'),
      tokens: { accessToken, refreshToken: '', refresh_token: '', expiresAt: expiry },
    } } }));
  };
  const config = { llm: { provider: 'openai-codex', model: 'gpt-6.1-terra', apiKey: 'sk-decoy-api-key', codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'remote-tab' } } as UserConfig;
  try {
    setUserConfigOverlay((current) => ({ ...current, llm: { ...current.llm, codexTokenOwnerHost: 'mshq' }, hq: { ...current.hq, hostName: 'remote-tab' } }));
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    process.env.ELANOUS_STATE_DIR = state;
    process.env.ELANOUS_CODEX_ACCOUNT = 'team';
    delete process.env.CODEX_HOME;
    process.env.NODE_ENV = 'production';
    delete process.env.BUN_TEST;
    delete process.env.ELANOUS_TEST_RUNNER;
    writeMirror(derived, token('remote'));
    writeMirror(podMirror, token('pod'));
    const observed: string[] = [];
    await withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: request => {
      observed.push(request.headers.authorization ?? '');
      return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } }], async (device) => {
      // Pod child has an isolated state root and an explicit parent mirror path.
      process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
      process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = podMirror;
      expect(codexOwnerMirrorAuthPath()).toBe(podMirror);
      expect(resolveCodexAccountForRun(process.env, { storePath: podMirror }).name).toBe('team');
      const pod = getProviderForConfig(config);
      expect(pod.available()).toBe(true);
      for await (const _ of pod.streamChat!([{ role: 'user', content: 'pod' }])) { /* drain */ }

      // Interactive remote tab reads the host's derived mirror without a launch override.
      delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
      delete process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH;
      expect(PROVIDERS['openai-codex']!.available()).toBe(true);
      for await (const _ of PROVIDERS['openai-codex']!.streamChat!([{ role: 'user', content: 'tab' }])) { /* drain */ }

      // `self review --model` enters through streamLLM with a pinned Codex provider.
      const review = getProviderForConfig(config, 'gpt-6.1-terra');
      await streamLLM([{ role: 'user', content: 'review' }], () => {}, { model: 'gpt-6.1-terra', provider: review });
      const codexCalls = device.calls().filter((call) => call.url.endsWith('/backend-api/codex/responses'));
      expect(codexCalls).toHaveLength(3);
      expect(codexCalls.every((call) => call.status === 200)).toBe(true);
    });
    expect(observed).toEqual([`Bearer ${token('pod')}`, `Bearer ${token('remote')}`, `Bearer ${token('remote')}`]);
  } finally {
    setUserConfigOverlay(null);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
