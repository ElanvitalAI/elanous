import { describe, expect, test } from 'bun:test';

import {
  classifyError,
  decideProviderFallback,
  decideRetry,
  formatProviderFallbackOutput,
  isProviderFallbackEligible,
  isUserCausedTerminalCategory,
  ProviderFallbackError,
  providerNamesFromFallbackChain,
  sanitizeProviderFailureReason,
} from './retry-policy.js';

describe('classifyError — connection failures are network-transient', () => {
  test('ECONNREFUSED code is network-transient, not unknown', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    expect(classifyError(err)).toBe('network-transient');
    expect(classifyError(err)).not.toBe('unknown');
  });

  test('provider connection wording is network-transient, not unknown', () => {
    const err = new Error('Unable to connect. Is the computer able to access the url?');
    expect(classifyError(err)).toBe('network-transient');
    expect(classifyError(err)).not.toBe('unknown');
  });

  test('existing network wording still classifies as network-transient', () => {
    expect(classifyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe('network-transient');
    expect(classifyError(new Error('fetch failed'))).toBe('network-transient');
  });

  test('user-caused terminals stay classified (not weakened to network-transient)', () => {
    expect(classifyError(new Error('prompt is too long for context window'))).toBe('context-window-exceeded');
    expect(classifyError(new Error('Gemini safety filter blocked content (finishReason=SAFETY)'))).toBe('safety-blocked');
    expect(classifyError(new Error('store must be set to false'))).toBe('endpoint-policy-rejection');
    expect(classifyError(new Error('Invalid argument: path is required'))).toBe('tool-invalid-args');
  });
});

describe('classifyError — server failures are overloaded', () => {
  test('classifies Codex server-error message variants and 5xx codes as overloaded', () => {
    for (const err of [
      new Error('Codex API error: server_error'),
      new Error('Codex API error: An error occurred while processing your request. You can retry your request.'),
      ...[500, 502, 504].map((code) => Object.assign(new Error(`HTTP ${code}`), { code })),
    ]) {
      expect(classifyError(err)).toBe('overloaded');
    }
  });

  test('keeps context, quota, and rate-limit classifications ahead of server-error wording', () => {
    expect(classifyError(new Error('context_length_exceeded: server_error'))).toBe('context-window-exceeded');
    expect(classifyError(new Error('quota exceeded: server_error'))).toBe('quota-exceeded');
    expect(classifyError(Object.assign(new Error('server_error'), { code: 429 }))).toBe('rate-limit');
    expect(classifyError(new Error('invalid argument: required field'))).not.toBe('overloaded');
  });

  test('advances openai-codex server failures to grok', () => {
    const verdict = decideProviderFallback({
      err: new Error('Codex API error: An error occurred while processing your request. You can retry your request.'),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
    });
    expect(verdict).toEqual(expect.objectContaining({ action: 'advance', nextProvider: 'grok', category: 'overloaded' }));
  });
});

describe('decideRetry — ECONNREFUSED follows the network-transient branch', () => {
  test('retries with backoff', () => {
    const err = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' });
    const d = decideRetry(err, { attempt: 0, doomStatus: 'normal' });
    expect(d.action).toBe('retry');
    expect(d.category).toBe('network-transient');
    expect(d.delayMs).toBeGreaterThan(0);
  });
});

describe('provider-fallback eligibility policy', () => {
  test('network-transient advances to a remaining fallback; unknown does not', () => {
    const network = decideProviderFallback({
      err: Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' }),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
    });
    expect(network).toEqual(expect.objectContaining({ action: 'advance', nextProvider: 'grok', category: 'network-transient' }));
    expect(network.attempts).toEqual([
      expect.objectContaining({ provider: 'openai-codex', category: 'network-transient' }),
    ]);

    // #16667 리뷰 must-fix — 첫 판본은 여기서 'advance' 를 못 박았다.
    // 그 넓힘은 ECONNREFUSED 오분류를 덮던 우회로였고, 분류를 고친 지금은
    // 프로바이더를 바꿔도 달라지지 않을 오류까지 체인을 태우는 부작용만 남는다.
    const unknown = decideProviderFallback({
      err: new Error('mystery provider failure'),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
    });
    expect(unknown.action).toBe('stop');
    expect(unknown.category).toBe('unknown');
    expect(isProviderFallbackEligible(new Error('mystery provider failure'))).toBe(false);
  });

  test('user-caused terminals stop immediately and do not spend remaining fallbacks', () => {
    const cases: Array<[string, ReturnType<typeof classifyError>]> = [
      ['prompt is too long for context window', 'context-window-exceeded'],
      ['Gemini safety filter blocked content (finishReason=SAFETY)', 'safety-blocked'],
      ['store must be set to false', 'endpoint-policy-rejection'],
    ];
    for (const [message, category] of cases) {
      expect(isUserCausedTerminalCategory(category)).toBe(true);
      const verdict = decideProviderFallback({
        err: new Error(message),
        failedProvider: 'openai-codex',
        remainingProviders: ['grok', 'anthropic'],
      });
      expect(verdict.action).toBe('stop');
      expect(verdict.category).toBe(category);
      expect(verdict.attempts).toHaveLength(1);
      expect(verdict.action === 'stop' && verdict.reason).toBe('category is not provider-dependent; do not spend remaining fallbacks');
      expect(formatProviderFallbackOutput(verdict.action === 'stop' ? verdict : { action: 'stop', category, attempts: verdict.attempts, reason: '' })).toContain('[LLM PROVIDER STOPPED]');
    }
  });

  test('exhaustion terminates with sanitized attempt history and never loops', () => {
    const first = decideProviderFallback({
      err: Object.assign(new Error('Unable to connect. token=sk-abcdefghijklmnopqrstuvwxyz'), { code: 'ECONNREFUSED' }),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
    });
    expect(first.action).toBe('advance');
    const exhausted = decideProviderFallback({
      err: new Error('Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz'),
      failedProvider: 'grok',
      remainingProviders: ['grok', 'openai-codex'],
      attempted: first.action === 'advance' || first.action === 'exhaust' || first.action === 'stop' ? first.attempts : [],
    });
    expect(exhausted.action).toBe('exhaust');
    expect(exhausted.action === 'exhaust' && exhausted.reason).toBe('fallback candidates exhausted');
    expect(exhausted.attempts.map((entry) => entry.provider)).toEqual(['openai-codex', 'grok']);
    for (const entry of exhausted.attempts) {
      expect(entry.reason).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
      expect(entry.reason).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    }
    if (exhausted.action !== 'exhaust') throw new Error('expected exhaust');
    const rendered = formatProviderFallbackOutput(exhausted);
    expect(rendered).toContain('[LLM PROVIDER BLOCKED] fallback candidates exhausted');
    expect(rendered).toContain('openai-codex:');
    expect(rendered).toContain('grok:');
    expect(rendered).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');

    const frozen = Object.freeze(new Error('Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz'));
    const aggregated = new ProviderFallbackError(exhausted, frozen);
    expect(aggregated.message).toBe(rendered);
    expect(aggregated.verdictReason).toBe('fallback candidates exhausted');
    expect(aggregated.fallbackAttempts.map((entry) => entry.provider)).toEqual(['openai-codex', 'grok']);
    expect(aggregated.originalCause).toBe(frozen);
    expect(aggregated.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(String(aggregated.stack ?? '')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(Object.isFrozen(frozen)).toBe(true);
    expect((frozen as { fallbackAttempts?: unknown }).fallbackAttempts).toBeUndefined();

    const fromString = new ProviderFallbackError(exhausted, 'Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz');
    expect(fromString.originalCause).toBe('Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz');
    expect(fromString.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  test('null/undefined errors are not fallback-eligible', () => {
    expect(isProviderFallbackEligible(null)).toBe(false);
    expect(isProviderFallbackEligible(undefined)).toBe(false);
  });

  test('sanitizeProviderFailureReason strips credentials and tokens', () => {
    const sanitized = sanitizeProviderFailureReason('Unable to connect Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz');
    expect(sanitized).toContain('Unable to connect');
    expect(sanitized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  test('providerNamesFromFallbackChain maps caller-supplied steps without baking a chain', () => {
    expect(providerNamesFromFallbackChain(['codex-rotate', 'grok'])).toEqual(['openai-codex', 'grok']);
    expect(providerNamesFromFallbackChain(['grok'])).toEqual(['grok']);
    expect(providerNamesFromFallbackChain(['unknown-step', 'grok'])).toEqual(['grok']);
    const remaining = providerNamesFromFallbackChain(['codex-rotate', 'grok']).filter((name) => name !== 'openai-codex');
    const verdict = decideProviderFallback({
      err: Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' }),
      failedProvider: 'openai-codex',
      remainingProviders: remaining,
    });
    expect(verdict.action).toBe('advance');
    expect(verdict.action === 'advance' && verdict.nextProvider).toBe('grok');
  });
});

// ── #16667 리뷰 must-fix 수렴 — 폴백 자격이 «좁아졌는가»를 무는 자 ──────────
//
// 이 describe 가 없으면 `isProviderFallbackEligible` 을 다시 「빼고 전부」로
// 되돌려도 위 시험들은 «전부 초록»이다(그것들은 자격이 «있는» 경우만 누른다).
// ⇒ 자는 알려진 양성 ⊕ 알려진 «음성» 양쪽에 눌러야 한다.
describe('provider fallback eligibility is an allowlist, not a blacklist', () => {
  const failing = (message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), extra);

  test('provider-independent request errors stop at the first failure — they do not spend the chain', () => {
    // 우리 쪽 요청 조립 버그. 어느 프로바이더로 가도 똑같이 실패한다.
    const err = failing('400 Bad Request: invalid_request_error — unexpected field "storee"', { status: 400 });
    expect(classifyError(err)).toBe('unknown');
    expect(isProviderFallbackEligible(err)).toBe(false);

    const verdict = decideProviderFallback({
      err,
      failedProvider: 'openai-codex',
      remainingProviders: ['grok', 'anthropic'],
    });
    expect(verdict.action).toBe('stop');
    expect(verdict.attempts).toHaveLength(1);
    expect(verdict.attempts[0]?.provider).toBe('openai-codex');
  });

  test('unknown never advances even when candidates remain', () => {
    const verdict = decideProviderFallback({
      err: failing('something we have never seen'),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
    });
    expect(verdict.action).toBe('stop');
  });

  test('the four provider-dependent categories still advance', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['socket hang up', {}],                       // network-transient
      ['429 too many requests', { status: 429 }],   // rate-limit
      ['quota exceeded for this org', {}],          // quota-exceeded
      ['upstream overloaded', {}],                  // overloaded
    ];
    for (const [message, extra] of cases) {
      const err = failing(message, extra);
      expect(isProviderFallbackEligible(err)).toBe(true);
      const verdict = decideProviderFallback({ err, failedProvider: 'openai-codex', remainingProviders: ['grok'] });
      expect(verdict.action).toBe('advance');
    }
  });

  test('EAI_AGAIN is network-transient from the message alone (no code field)', () => {
    // ⛔ 코드 필드가 «없는» 판본 — 코드 Set 만 고치면 이 시험이 빨강이다.
    const err = failing('getaddrinfo EAI_AGAIN api.example.com');
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(classifyError(err)).toBe('network-transient');
    expect(isProviderFallbackEligible(err)).toBe(true);
  });

  test('"usage limit" keeps the provider switch the old whitelist gave it', () => {
    // 옛 isSwitchableProviderBlock 정규식 `usage.?limit` 이 덮던 자리.
    // 허용목록으로 좁히면서 이 문면이 unknown 으로 떨어지면 조용한 회귀가 된다.
    for (const message of ['usage limit reached for this account', 'monthly usage_limit hit']) {
      const err = failing(message);
      expect(classifyError(err)).toBe('quota-exceeded');
      expect(isProviderFallbackEligible(err)).toBe(true);
    }
  });

  test('user-caused terminal categories still stop', () => {
    for (const message of ['context window exceeded', 'blocked by safety filter', 'store must be set to false']) {
      expect(isProviderFallbackEligible(failing(message))).toBe(false);
    }
  });
});

// ── #16667 재심 should-fix ③ — provider-unavailable 이 «과분류»하지 않는가 ──────
//
// ⛔ 양성만 누르면 이 자는 살아 있는 척한다. 첫 판의 `/\bunavailable:\s/` 는
//   아래 «음성» 넷을 전부 통과시켰고, 그러면 프로바이더 API 의 본문 오류가
//   체인을 태운다. 그래서 음성 대조군이 이 시험의 본체다.
describe('provider-unavailable classification does not over-match', () => {
  // 📏 지어낸 문면이 아니다 — src/llm.ts 의 실제 발생원에서 그대로 옮겼다.
  const REAL_PROVIDER_UNAVAILABLE = [
    'Anthropic unavailable: configure apiKey via `elanous setup`',
    'OpenRouter unavailable: configure apiKey via `elanous setup`',
    'openai-codex unavailable: run `elanous login openai-codex` or set `llm.apiKey`',
    'Grok unavailable: run `grok login` (구독) 또는 XAI_API_KEY/GROK_API_KEY 설정',
    'OpenAI unavailable: set OPENAI_API_KEY',
    'Gemini unavailable: set GEMINI_API_KEY or GOOGLE_API_KEY',
    'Local LLM unavailable: set LOCAL_LLM_URL or run /llm refresh',
  ];

  // 프로바이더 «API 가» 내는 본문 오류 — 다른 프로바이더로 가도 뜻이 없거나,
  // 애초에 「이 프로바이더가 구성 안 됨」이 아니다.
  const NOT_PROVIDER_UNAVAILABLE = [
    'model unavailable: try another model',
    'the requested feature is unavailable: contact support',
    'tool unavailable: the sandbox is offline',
    'service temporarily unavailable',
  ];

  test('every real provider-unavailable message classifies and is fallback-eligible', () => {
    for (const message of REAL_PROVIDER_UNAVAILABLE) {
      expect(classifyError(new Error(message))).toBe('provider-unavailable');
      expect(isProviderFallbackEligible(new Error(message))).toBe(true);
    }
  });

  test('non-provider "unavailable:" messages must NOT become provider-unavailable', () => {
    for (const message of NOT_PROVIDER_UNAVAILABLE) {
      expect(classifyError(new Error(message))).not.toBe('provider-unavailable');
    }
  });

  test('provider-unavailable aborts rather than retrying the same provider', () => {
    const decision = decideRetry(new Error('OpenAI unavailable: set OPENAI_API_KEY'), { attempt: 0, doomStatus: 'normal' });
    expect(decision.action).toBe('abort');
    expect(decision.category).toBe('provider-unavailable');
  });

  test('missing OpenRouter credentials abort the same-provider retry', () => {
    const decision = decideRetry(new Error('OpenRouter unavailable: configure apiKey via `elanous setup`'), { attempt: 0, doomStatus: 'normal' });
    expect(decision).toMatchObject({ action: 'abort', category: 'provider-unavailable' });
  });
});
