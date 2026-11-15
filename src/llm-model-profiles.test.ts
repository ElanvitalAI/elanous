import { describe, expect, test } from 'bun:test';
import profileData from './llm-model-profiles.json';
import { resolveModelProfile } from './llm-model-profiles';

const MODEL_PROFILES = profileData.profiles;

describe('static model profiles (no provider calls)', () => {
  test('the five requested model families have unique, nonempty prefixes and evidence', () => {
    expect(MODEL_PROFILES).toHaveLength(5);
    const prefixes = MODEL_PROFILES.flatMap((profile) => profile.id_match);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const profile of MODEL_PROFILES) {
      expect(profile.id_match).not.toEqual([]);
      expect(profile.evidence).not.toEqual([]);
      expect(profile.id_match.every((prefix) => prefix === prefix.trim().toLowerCase())).toBe(true);
    }
  });

  test('provider transport wrappers and case do not change the selected profile', () => {
    expect(resolveModelProfile('openrouter/openrouter/grok/grok-4.7')?.name).toBe('Grok 4.7');
    expect(resolveModelProfile(' OPENROUTER/QWEN/QWEN3.8-FLASH ')?.name).toBe('Qwen 3.8');
    expect(resolveModelProfile('openrouter/z-ai/glm-5.3')?.name).toBe('GLM 5.3');
    expect(resolveModelProfile('openrouter/deepseek/deepseek-v3.2')?.name).toBe('DeepSeek V3.2');
    expect(resolveModelProfile('upstage/solar-pro3')?.name).toBe('Solar Pro 3');
    expect(resolveModelProfile('grok/grok-4.7:preview')?.name).toBe('Grok 4.7');
    expect(resolveModelProfile('grok/grok-4.7/preview')?.name).toBe('Grok 4.7');
    expect(resolveModelProfile('grok-4.7')?.name).toBe('Grok 4.7');
  });

  test('longest safe prefix wins even when a general profile is listed first', () => {
    const seed = resolveModelProfile('grok/grok-4.7')!;
    const general = { ...seed, name: 'general', id_match: ['vendor/family'] };
    const specific = { ...seed, name: 'specific', id_match: ['vendor/family/model'] };
    expect(resolveModelProfile('vendor/family/model:fast', [general, specific])?.name).toBe('specific');
    expect(resolveModelProfile('vendor/family/model/fast', [specific, general])?.name).toBe('specific');
    expect(resolveModelProfile('vendor/family/model-extra', [general, specific])?.name).toBe('general');
  });

  test('unknown and unrelated model IDs do not override provider defaults', () => {
    expect(resolveModelProfile('')).toBeUndefined();
    expect(resolveModelProfile('openrouter/anthropic/claude-sonnet-4')).toBeUndefined();
    expect(resolveModelProfile('z-ai/glm-5.2')).toBeUndefined();
    expect(resolveModelProfile('z-ai/glm-5.3-flash')).toBeUndefined();
    expect(resolveModelProfile('grok/grok-4.70')).toBeUndefined();
    expect(resolveModelProfile('grok-4.70')).toBeUndefined();
    expect(resolveModelProfile('solar-pro2')).toBeUndefined();
    // The reference supplies Pro 3 values only; demo Pro 4/Mini 4 keep their existing wire defaults.
    expect(resolveModelProfile('openrouter/upstage/solar-pro4')).toBeUndefined();
    expect(resolveModelProfile('openrouter/upstage/solar-mini4')).toBeUndefined();
  });

  test('reference values are available but unverified reasoning flags remain null', () => {
    expect(resolveModelProfile('solar-pro3')?.limits.context).toBe(131072);
    expect(resolveModelProfile('grok/grok-4.7')?.timeouts.idle_chunk_s).toBe(300);
    expect(resolveModelProfile('qwen/qwen3.8-flash')?.sampling.temperature).toBe(0.55);
    expect(resolveModelProfile('qwen/qwen3.8-flash')?.timeouts.idle_chunk_s).toBe(180);
    expect(resolveModelProfile('z-ai/glm-5.3')?.sampling.temperature).toBe(1);
    expect(resolveModelProfile('z-ai/glm-5.3')?.reasoning.can_disable).toBeNull();
    expect(resolveModelProfile('deepseek/deepseek-v3.2')?.timeouts.idle_chunk_s).toBe(600);
    expect(resolveModelProfile('deepseek/deepseek-v3.2')?.reasoning.echo_reasoning_content).toBeNull();
    for (const profile of MODEL_PROFILES) {
      expect(profile.sampling).not.toHaveProperty('frequency_penalty');
    }
  });
});
