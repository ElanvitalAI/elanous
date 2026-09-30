import { describe, expect, test } from 'bun:test';

import { noProviderReply } from './no-provider-reply.js';

describe('noProviderReply', () => {
  test('returns the ordinary message to the input with a warning and an unsent notice', () => {
    expect(noProviderReply('  hello survey  ')).toEqual({
      lines: [
        { tone: 'warning', text: 'No LLM provider available. Run `elanous setup` or `elanous codex setup`.' },
        { tone: 'muted', text: '보내지 않았다 — 입력칸에 그대로 두었다 · setup 뒤 Enter' },
      ],
      prefill: 'hello survey',
    });
  });

  test('preserves internal newlines while trimming outer whitespace', () => {
    expect(noProviderReply(' \nfirst line\nsecond line\n ').prefill).toBe('first line\nsecond line');
  });

  test('does not prefill whitespace-only text', () => {
    expect(noProviderReply(' \n  \t ').prefill).toBe('');
  });

  test('keeps the existing warning verbatim', () => {
    expect(noProviderReply('hello').lines[0]).toEqual({
      tone: 'warning',
      text: 'No LLM provider available. Run `elanous setup` or `elanous codex setup`.',
    });
  });
});
