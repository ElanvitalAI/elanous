// Launch gate: the next self-mission child follows llm.call/outcome only.
// #24256 superseded — llm.response / llm.stream rows are not a sample.
import { describe, expect, test } from 'bun:test';

import { decideOverloadFailoverLaunch, outcomesFromCallRows } from '../oauth/overload-failover.js';
import { applyLaunchOverloadFailover } from '../oauth/overload-failover-launch.js';
import { OVERLOAD_FAILOVER_STREAK } from '../session-runtime/retry-policy.js';

describe('overload failover launch', () => {
  test('legacy categories produce zero samples, so the child stays on codex', () => {
    const outcomes = outcomesFromCallRows([
      { category: 'llm.response', event: 'status', ts_ms: 1, data: JSON.stringify({ status: 503 }) },
      { category: 'llm.stream', event: 'consume-start', ts_ms: 2, data: JSON.stringify({ provider: 'codex' }) },
      { category: 'llm.response.status', event: '503', ts_ms: 3, data: JSON.stringify({ provider: 'codex', status: 503 }) },
    ]);
    expect(outcomes).toHaveLength(0);
    const decision = decideOverloadFailoverLaunch({
      codexExplicit: false,
      provider: 'openai-codex',
      outcomes,
    });
    expect(decision.switched).toBe(false);
    expect(decision.provider).toBe('openai-codex');
    expect(decision.why).toBe('below-streak');
  });

  test('k real outcomes move an unpinned launch; an explicit codex flag does not', () => {
    const outcomes = Array.from({ length: OVERLOAD_FAILOVER_STREAK }, (_, i) => ({
      provider: 'codex',
      status: i === 0 ? 429 : 503,
      kind: (i === 0 ? 'rate-limit' : '5xx') as 'rate-limit' | '5xx',
    }));
    const moved = applyLaunchOverloadFailover(undefined, {}, () => outcomes);
    expect(moved?.provider).toBe('grok');
    expect(moved?.model?.length).toBeGreaterThan(0);
    const explicit = applyLaunchOverloadFailover(
      { provider: 'openai-codex', model: 'gpt-test', source: 'flag' },
      { provider: 'openai-codex' },
      () => outcomes,
    );
    expect(explicit?.provider).toBe('openai-codex');
    expect(explicit?.model).toBe('gpt-test');
  });

  test('recovery puts the following launch back on codex', () => {
    const outcomes = [
      ...Array.from({ length: 3 }, () => ({ provider: 'codex', status: 503, kind: '5xx' as const })),
      ...Array.from({ length: OVERLOAD_FAILOVER_STREAK }, () => ({ provider: 'codex', status: 200, kind: 'ok' as const })),
    ];
    const next = applyLaunchOverloadFailover(
      { provider: 'openai-codex', model: 'gpt-test', source: 'config' },
      {},
      () => outcomes,
    );
    expect(next?.provider).toBe('openai-codex');
  });
});

describe('overload failover launch — test processes never read the host log store', () => {
  const codex = { provider: 'openai-codex', model: 'gpt-6-sol', source: 'config' as const };
  const overloaded = () => Array.from({ length: OVERLOAD_FAILOVER_STREAK }, () => ({ provider: 'codex', status: 503, kind: 'overloaded' as const }));

  test('NODE_ENV=test without an injected reader keeps the selection (no host logs.db read)', () => {
    expect(applyLaunchOverloadFailover(codex, {}, undefined, { NODE_ENV: 'test' })).toEqual(codex);
    expect(applyLaunchOverloadFailover(codex, {}, undefined, { ELANOUS_TEST_HOME: '/tmp/x' })).toEqual(codex);
  });

  test('an injected reader is still honoured, so the gate itself stays testable', () => {
    const next = applyLaunchOverloadFailover(codex, { grokAvailable: true }, overloaded, { NODE_ENV: 'test' });
    expect(next?.provider).toBe('grok');
  });

  test('a host without a grok credential stays on codex even after an overload streak', () => {
    expect(applyLaunchOverloadFailover(codex, { grokAvailable: false }, overloaded, { NODE_ENV: 'test' })).toEqual(codex);
  });
});

