import type { LLMToolSpec } from './llm/tool-spec.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexStagePromptCacheKey, getProviderForConfig } from './llm.js';
import { saveTokens } from './oauth/store.js';
import type { UserConfig } from './user-config.js';
import { withFakeFetchDevice } from './ux-sim/fake-fetch.js';

let envSnapshot: Record<string, string | undefined> = {};
test('Codex Responses keeps a byte-stable same-stage prefix and forwards provider cache usage', async () => {
  envSnapshot = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'codex-cache-prefix-'));
  try {
    const xdg = join(root, 'xdg');
    const codexHome = join(root, 'codex-home');
    mkdirSync(join(xdg, 'elanous'), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.CODEX_HOME = codexHome;
    process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
    delete process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_CODEX_ACCOUNT;
    saveTokens('openai-codex', {
      accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false }, join(xdg, 'elanous', 'auth.json'));
    const provider = getProviderForConfig({ llm: { provider: 'openai-codex', model: 'gpt-6.1-sol' } } as unknown as UserConfig);
    const messages = [{ role: 'user' as const, content: 'same prompt' }];
    const alpha: LLMToolSpec = { name: 'alpha', description: 'alpha', parameters: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } } };
    const alphaReordered: LLMToolSpec = { name: 'alpha', description: 'alpha', parameters: { properties: { a: { type: 'number' }, z: { type: 'string' } }, type: 'object' } };
    const beta: LLMToolSpec = { name: 'beta', description: 'beta', parameters: { type: 'object', properties: {} } };
    const toolStages: Array<{ model?: string; tools: LLMToolSpec[] }> = [
      { tools: [beta, alpha] },
      { tools: [alphaReordered, beta] },
      { tools: [alpha] },
      { model: 'gpt-6-luna', tools: [alpha] },
    ];
    const observedUsage: Array<{ cacheReadInputTokens?: number }> = [];
    const bodies: Record<string, unknown>[] = [];
    const serializedBodies: string[] = [];
    const sessionIds: string[] = [];
    await withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: request => {
      serializedBodies.push(String(request.body));
      bodies.push(JSON.parse(String(request.body)) as Record<string, unknown>);
      sessionIds.push(request.headers['session-id'] ?? '');
      const cached = bodies.length === 1 ? 0 : 512;
      return new Response(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 1024, output_tokens: 3, input_tokens_details: { cached_tokens: cached } } },
      })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } }], async (device) => {
      for (const stage of toolStages) {
        for await (const event of provider.streamChat!(messages, {
          sessionId: 'session-cache-test', tools: stage.tools,
          ...(stage.model ? { model: stage.model } : {}),
        })) {
          if (event.type === 'usage') observedUsage.push(event.usage);
        }
      }
      expect(device.calls()).toHaveLength(4);
    });
    expect(bodies).toHaveLength(4);
    expect(sessionIds).toEqual(Array(4).fill('session-cache-test'));
    expect(serializedBodies[0]).toBe(serializedBodies[1]);
    expect(bodies[0]!.instructions).toBe(bodies[1]!.instructions);
    expect(bodies[0]!.input).toEqual(bodies[1]!.input);
    expect(bodies[0]!.tools).toEqual(bodies[1]!.tools);
    expect(bodies[0]!.prompt_cache_key).toBe(bodies[1]!.prompt_cache_key);
    expect(bodies[2]!.prompt_cache_key).not.toBe(bodies[0]!.prompt_cache_key);
    expect(bodies[3]!.model).toBe('gpt-6-luna');
    expect(bodies[3]!.prompt_cache_key).not.toBe(bodies[2]!.prompt_cache_key);
    expect(observedUsage.map((usage) => usage.cacheReadInputTokens)).toEqual([0, 512, 512, 512]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key];
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('Codex cache routing separates models and tool stages, independent of object key order', () => {
  const schemaA = [{ name: 'lookup', parameters: { type: 'object', properties: { a: { type: 'string' }, z: { type: 'number' } } } }];
  const schemaAReordered = [{ name: 'lookup', parameters: { properties: { z: { type: 'number' }, a: { type: 'string' } }, type: 'object' } }];
  const schemaB = [{ name: 'write', parameters: { type: 'object', properties: {} } }];
  const unicodeA = [{ name: 'lookup', parameters: { type: 'object', properties: { 'é': { type: 'string' }, 'e\u0301': { type: 'number' } } } }];
  const unicodeB = [{ name: 'lookup', parameters: { type: 'object', properties: { 'e\u0301': { type: 'number' }, 'é': { type: 'string' } } } }];
  const key = codexStagePromptCacheKey('session-cache-test', 'gpt-6.1-sol', schemaA);
  expect(codexStagePromptCacheKey('session-cache-test', 'gpt-6.1-sol', schemaAReordered)).toBe(key);
  expect(codexStagePromptCacheKey('session-cache-test', 'gpt-6.1-sol', schemaB)).not.toBe(key);
  expect(codexStagePromptCacheKey('session-cache-test', 'gpt-6-luna', schemaA)).not.toBe(key);
  expect(codexStagePromptCacheKey('session-cache-test', 'gpt-6.1-sol', unicodeB))
    .toBe(codexStagePromptCacheKey('session-cache-test', 'gpt-6.1-sol', unicodeA));
});
