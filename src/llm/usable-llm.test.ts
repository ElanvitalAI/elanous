import { expect, test } from 'bun:test';
import { getUserConfig } from '../user-config.js';
import { decideProviderForConfig } from '../llm.js';
import { resolveUsableLlm } from './usable-llm.js';

const config = { ...getUserConfig(), llm: { ...getUserConfig().llm, provider: 'auto' as const } };

test('login, key, local server, and no route follow the runtime selector result without exposing a credential', () => {
  const cases = [
    [{ provider: 'auto:openai-codex', auth: 'oauth', model: 'm' }, { usable: true, provider: 'openai-codex', via: 'login' }],
    [{ provider: 'auto:openai', auth: 'apikey', model: 'm' }, { usable: true, provider: 'openai', via: 'key' }],
    [{ provider: 'auto:local', auth: 'local', model: 'm' }, { usable: true, provider: 'local', via: 'local-server' }],
    [{ provider: 'auto', auth: 'none', model: '(none)' }, { usable: false, via: 'none' }],
  ] as const;
  for (const [decision, expected] of cases) {
    const result = resolveUsableLlm({ config, decide: (input) => { expect(input).toBe(config); return decision; } });
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain('sk-credential-secret');
  }
});

test('default uses the existing auto selector without changing its decision', () => {
  const decision = decideProviderForConfig(config);
  const result = resolveUsableLlm({ config });
  expect(result.usable).toBe(decision.auth !== 'none' && decision.provider !== 'auto');
  if (result.usable) expect(result.provider).toBe(decision.provider.replace(/^auto:/, ''));
});

test('credential strings in a configured model or unknown provider are never returned', () => {
  const secret = 'sk-credential-secret';
  const result = resolveUsableLlm({ config, decide: () => ({ provider: 'auto:local', auth: 'local', model: secret }) });
  expect(JSON.stringify(result)).not.toContain(secret);
  const unknown = resolveUsableLlm({ config, decide: () => ({ provider: `auto:${secret}` as never, auth: 'apikey', model: secret }) });
  expect(unknown).toEqual({ usable: false, via: 'none', why: 'no usable LLM route selected' });
  expect(JSON.stringify(unknown)).not.toContain(secret);
});

test('a local server not selected by auto cannot claim usability', () => {
  expect(resolveUsableLlm({ config, decide: () => ({ provider: 'auto', auth: 'none', model: '(none)' }) }))
    .toEqual({ usable: false, via: 'none', why: 'no usable LLM route selected' });
});

test('an explicitly selected provider without credentials stays named so callers offer that provider fix', () => {
  expect(resolveUsableLlm({ config, decide: () => ({ provider: 'openai', auth: 'none', model: 'm' }) }))
    .toEqual({ usable: false, provider: 'openai', via: 'none', why: 'no usable LLM route selected' });
  expect(resolveUsableLlm({ config, decide: () => ({ provider: 'auto:openai', auth: 'none', model: 'm' }) }))
    .toEqual({ usable: false, via: 'none', why: 'no usable LLM route selected' });
});
