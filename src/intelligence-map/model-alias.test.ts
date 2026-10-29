import { describe, expect, it } from 'bun:test';
import { resolveModelAlias } from './model-alias.js';

describe('GPT-6.1 aliases', () => {
  it('routes current short names to the 6.1 Codex models while preserving explicit legacy names', () => {
    expect(resolveModelAlias('codex')).toBe('gpt-6.1-terra');
    expect(resolveModelAlias('terra')).toBe('gpt-6.1-terra');
    expect(resolveModelAlias('sol')).toBe('gpt-6.1-sol');
    expect(resolveModelAlias('6.1-terra')).toBe('gpt-6.1-terra');
    expect(resolveModelAlias('6.1-sol')).toBe('gpt-6.1-sol');
    expect(resolveModelAlias('6-sol')).toBe('gpt-6-sol');
    expect(resolveModelAlias('6-luna')).toBe('gpt-6-luna');
    expect(resolveModelAlias('5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveModelAlias('5.6-terra')).toBe('gpt-5.6-terra');
  });
});
