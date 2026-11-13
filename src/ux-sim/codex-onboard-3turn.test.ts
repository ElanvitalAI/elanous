import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFirstRun } from '../onboarding/first-run.js';
import { buildUserConfig } from '../user-config.js';
import { getProviderForConfig } from '../llm.js';
import { withFakeFetchDevice } from './fake-fetch.js';

test('Codex default onboarding keeps one session and model through three simulated turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-onboard-three-turn-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldSuppress = process.env.ELANOUS_SUPPRESS_XDG_WARNING;
  const oldLlmMode = process.env.ELANOUS_LLM_MODE;
  const oldAccessOnly = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  const configPath = join(root, 'config.json');
  try {
    const xdg = join(root, 'xdg');
    const codexHome = join(root, 'codex-home');
    mkdirSync(join(xdg, 'elanous'), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.CODEX_HOME = codexHome;
    process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
    process.env.ELANOUS_LLM_MODE = 'real';
    process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';

    const initial = buildUserConfig(configPath);
    expect(initial.onboarding.ready).not.toBe(true);
    const result = await runFirstRun({
      path: configPath, config: initial, env: {}, isTTY: false, locale: 'ko', print: () => {},
      detectProviders: async () => [
        { provider: 'openai-codex', auth: 'oauth', source: 'test', available: true, rank: 0 },
      ],
    });
    expect(result).toMatchObject({ outcome: 'ready', provider: 'openai-codex', inputs: 0 });
    const saved = buildUserConfig(configPath);
    expect(saved.onboarding.ready).toBe(true);
    expect(saved.llm.provider).toBe('openai-codex');
    const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', tokens: { access_token: accessToken, refresh_token: '', account_id: 'sim-account' },
    }));

    const provider = getProviderForConfig(saved);
    const requests: Array<{ model: string; sessionId: string; authorization: string; input: unknown }> = [];
    await withFakeFetchDevice([{
      url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST',
      response: (request) => {
        const body = JSON.parse(request.body ?? '{}');
        requests.push({
          model: body.model, sessionId: request.headers['session-id'] ?? '',
          authorization: request.headers.authorization ?? '', input: body.input,
        });
        const answer = `codex-${requests.length}`;
        return new Response(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: answer })}\n\n` +
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${requests.length}`, status: 'completed', output: [] } })}\n\n` +
          'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    }], async () => {
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const turn of [1, 2, 3]) {
        history.push({ role: 'user', content: `Codex 질문 ${turn}` });
        const events = await Array.fromAsync(provider.streamChat!(history, { sessionId: 'one-onboard-session' }));
        const answer = events.filter((event) => event.type === 'text').map((event) => event.delta).join('');
        expect(answer).toBe(`codex-${turn}`);
        history.push({ role: 'assistant', content: answer });
      }
    });
    expect(requests).toHaveLength(3);
    expect(requests.map(({ sessionId }) => sessionId)).toEqual(Array(3).fill('one-onboard-session'));
    expect(requests.map(({ model }) => model)).toEqual(Array(3).fill(requests[0]!.model));
    expect(requests.map(({ authorization }) => authorization)).toEqual(Array(3).fill(`Bearer ${accessToken}`));
    expect(requests[0]!.model).toBe(provider.defaultModel);
    expect(requests.map(({ input }) => Array.isArray(input) ? input.length : -1)).toEqual([1, 3, 5]);
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldSuppress === undefined) delete process.env.ELANOUS_SUPPRESS_XDG_WARNING;
    else process.env.ELANOUS_SUPPRESS_XDG_WARNING = oldSuppress;
    if (oldLlmMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = oldLlmMode;
    if (oldAccessOnly === undefined) delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
    else process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = oldAccessOnly;
    rmSync(root, { recursive: true, force: true });
  }
});
