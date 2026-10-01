import { expect, test } from 'bun:test';
import { subscriptionHint } from './subscription-hint.js';

const d = (provider: string, auth: 'oauth' | 'apikey', source: string) => ({ provider, auth, source, available: true, rank: 1 });

test('codex and grok logins are both found and codex is preferred', () => {
  const hint = subscriptionHint([d('grok', 'oauth', 'grok-auth'), d('openai-codex', 'oauth', 'codex-auth')]);
  expect(hint.found.map(f => f.provider)).toEqual(['openai-codex', 'grok']);
  expect(hint.found[0]!.line).toContain('~/.codex/auth.json');
  expect(hint.preferred).toBe('openai-codex');
});

test('grok only is preferred when it is the only subscription', () => {
  expect(subscriptionHint([d('grok', 'oauth', 'grok-auth'), d('openai', 'apikey', 'env:OPENAI_API_KEY')]).preferred).toBe('grok');
});

test('no subscription still defaults to codex, never to env-only auto', () => {
  const hint = subscriptionHint([d('openai', 'apikey', 'env:OPENAI_API_KEY')]);
  expect(hint.found).toEqual([]);
  expect(hint.preferred).toBe('openai-codex');
});
