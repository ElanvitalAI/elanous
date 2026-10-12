import { describe, expect, test } from 'bun:test';
import { detectLocale } from '../expression/locale.js';
import { FRIENDLY_ERRORS, classifyFriendlyError, formatFriendlyError, type FriendlyErrorCode } from './friendly-errors.js';

const CODES = Object.keys(FRIENDLY_ERRORS) as FriendlyErrorCode[];
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
const ENGLISH_SENTENCE = /[A-Za-z]+(\s+[A-Za-z]+){2,}/;

describe('FRIENDLY_ERRORS table', () => {
  test('has ten codes, each with what/why/next in ko and en and a next that starts with `elanous `', () => {
    expect(CODES).toHaveLength(10);
    for (const code of CODES) {
      for (const language of ['ko', 'en'] as const) {
        const row = FRIENDLY_ERRORS[code][language];
        expect(row.what.trim().length).toBeGreaterThan(0);
        expect(row.why.trim().length).toBeGreaterThan(0);
        expect(row.next.trim().length).toBeGreaterThan(0);
        expect(row.next.startsWith('elanous ')).toBe(true);
      }
    }
  });
});

describe('classifyFriendlyError', () => {
  test('maps the src/llm.ts credential wordings to credential-missing', () => {
    expect(classifyFriendlyError(new Error('Grok unavailable: run `grok login` (구독) 또는 XAI_API_KEY/GROK_API_KEY 설정'))).toBe('credential-missing');
    expect(classifyFriendlyError(new Error('openai-codex unavailable: run `elanous login openai-codex` or set `llm.apiKey`'))).toBe('credential-missing');
  });

  test('maps unknown provider and provider-model mismatch separately', () => {
    expect(classifyFriendlyError(new Error('unknown provider: x'))).toBe('provider-unknown');
    expect(classifyFriendlyError(new Error('Cannot establish provider-model compatibility: unknown provider "x" for model "m"'))).toBe('model-unavailable');
  });

  test('maps the remaining wordings and retry-policy categories', () => {
    expect(classifyFriendlyError(new Error('fetch failed'))).toBe('network');
    expect(classifyFriendlyError(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe('network');
    expect(classifyFriendlyError(new Error('usage_limit_reached'))).toBe('quota');
    expect(classifyFriendlyError(new Error('Too many requests'))).toBe('quota');
    expect(classifyFriendlyError(new Error('ask --bare: input exceeds the 8000-token context budget'))).toBe('context-too-long');
    expect(classifyFriendlyError(new Error('prompt is too long'))).toBe('context-too-long');
    expect(classifyFriendlyError(new SyntaxError('JSON Parse error: Unexpected token'))).toBe('config-broken');
    expect(classifyFriendlyError(new Error('elanous_task_submit: the elanous daemon is not running in this universe'))).toBe('daemon-down');
    expect(classifyFriendlyError(Object.assign(new Error('open failed'), { code: 'EACCES' }))).toBe('permission');
    expect(classifyFriendlyError(new Error("error: unknown command 'foo'"))).toBe('unknown-command');
  });

  test('returns null for an unrelated error and for non-errors', () => {
    expect(classifyFriendlyError(new Error('something else entirely'))).toBeNull();
    expect(classifyFriendlyError(undefined)).toBeNull();
  });
});

describe('formatFriendlyError', () => {
  test('en prints no Korean, ko prints no English sentence, neither prints a stack line', () => {
    const previous = process.env.ELANOUS_LANG;
    try {
      for (const code of CODES) {
        process.env.ELANOUS_LANG = 'en';
        const en = formatFriendlyError(code, detectLocale());
        expect(HANGUL.test(en)).toBe(false);
        expect(en).not.toMatch(/^\s*at /m);
        expect(en.split('\n').at(-1)?.trim()).toBe(FRIENDLY_ERRORS[code].en.next);

        process.env.ELANOUS_LANG = 'ko';
        const ko = formatFriendlyError(code, detectLocale());
        const lines = ko.split('\n');
        expect(HANGUL.test(ko)).toBe(true);
        expect(lines.slice(0, -1).some((line) => ENGLISH_SENTENCE.test(line))).toBe(false);
        expect(ko).not.toMatch(/^\s*at /m);
        expect(lines.at(-1)?.trim()).toBe(FRIENDLY_ERRORS[code].ko.next);
      }
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_LANG;
      else process.env.ELANOUS_LANG = previous;
    }
  });

  test('locales other than ko fall back to a single English rendering', () => {
    expect(formatFriendlyError('network', 'ja')).toBe(formatFriendlyError('network', 'en'));
  });
});
