import { expect, test } from 'bun:test';
import { reselectChildForRework } from './rework-child-provider.js';

const grok = { provider: 'grok', model: 'grok-4.6', source: 'config' as const };
const codex = { provider: 'openai-codex', model: 'gpt-6-sol', source: 'config' as const };

test('rework reselection switches exhausted or unauthenticated Grok to an available, non-exhausted alternate', () => {
  for (const failure of [
    { grokQuota: 'exhausted' as const, grokCredential: 'available' as const, reason: 'grok-quota-exhausted' },
    { grokQuota: 'usable' as const, grokCredential: 'unavailable' as const, reason: 'grok-credential-missing' },
  ]) {
    expect(reselectChildForRework({ current: grok, alternate: codex, alternateCredential: 'available', ...failure }))
      .toMatchObject({ action: 'reselect', selection: codex, reason: failure.reason });
  }
});

test('rework keeps the current model when quota is unknown or no usable alternate exists', () => {
  expect(reselectChildForRework({ current: grok, grokQuota: 'unknown', grokCredential: 'available', alternate: codex, alternateCredential: 'available' }))
    .toMatchObject({ action: 'keep', reason: 'quota-unknown' });
  expect(reselectChildForRework({ current: grok, grokQuota: 'exhausted', grokCredential: 'available', alternate: codex, alternateCredential: 'available', alternateQuotaExhausted: true }))
    .toMatchObject({ action: 'keep', reason: 'no-alternate' });
});

test('missing Grok credential triggers reselection even when quota is unknown', () => {
  expect(reselectChildForRework({ current: grok, grokQuota: 'unknown', grokCredential: 'unavailable', alternate: codex, alternateCredential: 'available' }))
    .toMatchObject({ action: 'reselect', selection: codex, reason: 'grok-credential-missing' });
});
