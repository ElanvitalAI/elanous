import { describe, expect, test } from 'bun:test';
import { SLASH_COMMANDS } from '../../chat/index.js';
import { lookupLlmTierSpec } from '../../model-tier/index.js';
import {
  HUMAN_MODEL_WORDS,
  MODEL_CODE_NAMES,
  MODEL_TARGETS,
  humanWordForModel,
  modelChangeLine,
  modelOverviewLines,
  resolveModelChoice,
} from './model-choices.js';

describe('TUI-SLASH-DECIDE-NOW C — /model human words', () => {
  const cases = [
    ['빠름', 'fast', 'budget'],
    ['보통', 'normal', 'better'],
    ['깊음', 'deep', 'best'],
  ] as const;
  for (const [word, english, tier] of cases) {
    test(`${word} (${english}) goes to the current provider's ${tier} tier`, () => {
      for (const provider of ['openai-codex', 'anthropic', 'grok'] as const) {
        const spec = lookupLlmTierSpec(provider, tier);
        const expected = { model: spec.model, provider };
        for (const arg of [word, english, english.toUpperCase(), ` ${word} `]) {
          const resolved = resolveModelChoice(arg, provider);
          expect(resolved).toEqual({ kind: 'human', word, tier, target: expected, ...(spec.reasoningLevel ? { reasoningLevel: spec.reasoningLevel } : {}) });
        }
      }
    });
  }

  test('a human word under provider auto asks for a provider instead of guessing', () => {
    expect(resolveModelChoice('깊음', 'auto')).toEqual({ kind: 'needs-provider', word: '깊음' });
  });

  test('unknown arguments are reported, not switched', () => {
    expect(resolveModelChoice('turbo', 'anthropic')).toEqual({ kind: 'unknown', arg: 'turbo' });
  });
});

describe('TUI-SLASH-DECIDE-NOW C — /model code names keep their model and provider', () => {
  const expected = {
    codex: { model: 'gpt-5.5', provider: 'openai-codex' },
    terra: { model: lookupLlmTierSpec('openai-codex', 'better').model, provider: 'openai-codex' },
    sol: { model: lookupLlmTierSpec('openai-codex', 'best').model, provider: 'openai-codex' },
    luna: { model: lookupLlmTierSpec('openai-codex', 'budget').model, provider: 'openai-codex' },
    opus: { model: 'claude-opus-4-8', provider: 'anthropic' },
    sonnet: { model: 'claude-sonnet-5', provider: 'anthropic' },
    grok: { model: lookupLlmTierSpec('grok', 'best').model, provider: 'grok' },
  } as const;

  test('the seven code names are exactly the old set', () => {
    expect([...MODEL_CODE_NAMES]).toEqual(Object.keys(expected));
    expect(MODEL_TARGETS).toEqual(expected);
  });

  for (const [name, target] of Object.entries(expected)) {
    test(`/model ${name} → ${target.provider}/${target.model} whatever the current provider`, () => {
      for (const current of ['anthropic', 'openai-codex', 'auto'] as const) {
        expect(resolveModelChoice(name, current)).toEqual({ kind: 'code', name, target });
        expect(resolveModelChoice(name.toUpperCase(), current)).toEqual({ kind: 'code', name, target });
      }
    });
  }
});

describe('TUI-SLASH-DECIDE-NOW C — /model lines', () => {
  test('overview names the current choice in human words and offers the three words first', () => {
    const deep = lookupLlmTierSpec('openai-codex', 'best');
    const [now, codes] = modelOverviewLines('openai-codex', deep.model, deep.reasoningLevel);
    expect(now).toBe(`지금: 깊음 (${deep.model}) · 고르기: /model 빠름 | 보통 | 깊음`);
    const fast = lookupLlmTierSpec('openai-codex', 'budget').model;
    expect(modelOverviewLines('openai-codex', fast)[0]).toStartWith(`지금: 빠름 (${fast})`);
    // better and best share a model on this ladder: without the reasoning level the word would be a guess.
    expect(humanWordForModel('openai-codex', deep.model)).toBeUndefined();
    expect(codes).toContain(MODEL_CODE_NAMES.join(' · '));
    expect(modelOverviewLines('anthropic', 'some-custom-model')[0]).toBe('지금: some-custom-model · 고르기: /model 빠름 | 보통 | 깊음');
    expect(modelOverviewLines('anthropic', undefined)[0]).toStartWith('지금: 기본 모델 · ');
  });

  test('confirmation reads «보통 → 깊음 (<model>)»', () => {
    const normal = lookupLlmTierSpec('openai-codex', 'better');
    const deep = lookupLlmTierSpec('openai-codex', 'best');
    expect(humanWordForModel('openai-codex', normal.model, normal.reasoningLevel)).toBe('보통');
    const resolved = resolveModelChoice('깊음', 'openai-codex');
    if (resolved.kind !== 'human') throw new Error('expected a human resolution');
    expect(resolved.reasoningLevel).toBe(deep.reasoningLevel);
    expect(modelChangeLine({ provider: 'openai-codex', model: normal.model, reasoning: normal.reasoningLevel }, resolved))
      .toBe(`모델: 보통 → 깊음 (${deep.model} · 생각 ${deep.reasoningLevel})`);
    // A code name keeps reasoning and names itself when its model is not one tier.
    const code = resolveModelChoice('sol', 'anthropic');
    if (code.kind !== 'code') throw new Error('expected a code resolution');
    const opus = lookupLlmTierSpec('anthropic', 'better');
    expect(modelChangeLine({ provider: 'anthropic', model: opus.model, reasoning: opus.reasoningLevel }, code))
      .toBe(`모델: 보통 → sol (${code.target.model})  · provider openai-codex`);
    const luna = resolveModelChoice('luna', 'openai-codex');
    if (luna.kind !== 'code') throw new Error('expected a code resolution');
    expect(modelChangeLine({ provider: 'openai-codex', model: 'custom' }, luna)).toBe(`모델: custom → 빠름 (${luna.target.model})`);
  });

  test('the /model slash entry leads with the human words and keeps every code name', () => {
    const entry = SLASH_COMMANDS.find(({ name }) => name === 'model')!;
    expect(entry.description).toBe('모델 바꾸기 — /model 빠름|보통|깊음 (코드명도 됨)');
    expect(entry.subcommands).toEqual([...HUMAN_MODEL_WORDS, ...MODEL_CODE_NAMES]);
  });
});
