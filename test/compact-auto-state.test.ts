// ── Wave 5 · auto-state breaker + verify-probe gating ──

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAutoCompactBreakerReason,
  isAutoCompactBreakerTripped,
  isVerifyProbeEnabled,
  recordAutoCompactFailure,
  recordAutoCompactSuccess,
  resetAutoCompactStateForTest,
  runCompactPipeline,
  setVerifyProbeEnabled,
  type CompactProvider,
} from '../src/compact';
import { runVerifyProbe } from '../src/compact/verify-probe';
import type { LLMMessage } from '../src/llm';

function archDir(): string {
  return mkdtempSync(join(tmpdir(), 'compact-auto-'));
}

beforeEach(() => resetAutoCompactStateForTest());
afterEach(() => resetAutoCompactStateForTest());

describe('Wave 5 · auto-compact circuit breaker', () => {
  test('clean slate — breaker not tripped, no failures', () => {
    expect(isAutoCompactBreakerTripped()).toBe(false);
    expect(getAutoCompactBreakerReason()).toBe('');
  });

  test('trips after 3 consecutive failures', () => {
    expect(recordAutoCompactFailure('first').tripped).toBe(false);
    expect(recordAutoCompactFailure('second').tripped).toBe(false);
    const last = recordAutoCompactFailure('third');
    expect(last.tripped).toBe(true);
    expect(last.consecutive).toBe(3);
    expect(isAutoCompactBreakerTripped()).toBe(true);
    expect(getAutoCompactBreakerReason()).toBe('third');
  });

  test('success resets the consecutive counter', () => {
    recordAutoCompactFailure('a');
    recordAutoCompactFailure('b');
    recordAutoCompactSuccess();
    expect(isAutoCompactBreakerTripped()).toBe(false);
    expect(recordAutoCompactFailure('c').tripped).toBe(false);
  });

  test('pipeline skips Layer 3 when breaker is tripped', async () => {
    recordAutoCompactFailure('one');
    recordAutoCompactFailure('two');
    recordAutoCompactFailure('three');
    expect(isAutoCompactBreakerTripped()).toBe(true);
    let summarizeCalled = false;
    const provider: CompactProvider = {
      summarize: async () => {
        summarizeCalled = true;
        return null;
      },
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const r = await runCompactPipeline(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
      { provider, policy: { archiveDir: archDir() } },
    );
    expect(summarizeCalled).toBe(false);
    expect(r.diagnostics.breakerTripped).toBe(1);
    expect(r.diagnostics.layer3SummaryApplied).toBe(0);
  });

  test('summarize returning null bumps the breaker counter', async () => {
    const provider: CompactProvider = {
      summarize: async () => null,
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    await runCompactPipeline(
      [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
      ],
      { provider, policy: { archiveDir: archDir(), preserveLastN: 1 } },
    );
    // After one failure breaker not yet tripped; do two more to trip.
    expect(isAutoCompactBreakerTripped()).toBe(false);
    await runCompactPipeline(
      [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
      ],
      { provider, policy: { archiveDir: archDir(), preserveLastN: 1 } },
    );
    await runCompactPipeline(
      [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
      ],
      { provider, policy: { archiveDir: archDir(), preserveLastN: 1 } },
    );
    expect(isAutoCompactBreakerTripped()).toBe(true);
  });
});

describe('Wave 5 · verify probe gating', () => {
  test('default off; setVerifyProbeEnabled flips the flag', () => {
    expect(isVerifyProbeEnabled()).toBe(false);
    setVerifyProbeEnabled(true);
    expect(isVerifyProbeEnabled()).toBe(true);
  });

  test('verify=skipped when probe is disabled', async () => {
    const provider: CompactProvider = {
      summarize: async () => ({ summary: 'mock', sourceMessageCount: 2 }),
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const r = await runCompactPipeline(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
      ],
      { provider, policy: { archiveDir: archDir(), preserveLastN: 1 } },
    );
    expect(r.diagnostics.layer3SummaryApplied).toBe(1);
    expect(r.diagnostics.layer4VerifyVerdict).toBe('skipped');
  });
});

describe('Wave 5 · Layer 5 fallback truncate', () => {
  test('summarize null → fallback truncates largest tool_result', async () => {
    const huge = 'Q'.repeat(40_000);
    const provider: CompactProvider = {
      summarize: async () => null,
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: huge }],
      },
      { role: 'user', content: 'pad-1' },
      { role: 'assistant', content: 'pad-2' },
      { role: 'user', content: 'pad-3' },
      { role: 'assistant', content: 'pad-4' },
      { role: 'user', content: 'pad-5' },
      { role: 'assistant', content: 'pad-6' },
    ];
    const r = await runCompactPipeline(messages, {
      provider,
      policy: {
        archiveDir: archDir(),
        preserveLastN: 3,
        // Layer 1 budget high enough that the huge passes through;
        // fallback budget = budget/2 = 30K, smaller than huge, so
        // truncateProportional actually shortens it.
        toolOutputCharBudget: 60_000,
        // Keep Layer 2 from clearing the huge result before fallback
        // can see it — set the age threshold high so nothing's "old".
        microcompactAgeThreshold: 100,
      },
    });
    expect(r.diagnostics.layer5FallbackTruncated).toBe(1);
    const block = (r.messages[0]?.content as any)[0];
    expect(block.content.length).toBeLessThan(huge.length);
    expect(block.content).toContain('truncated');
  });

  test('no eligible tool_result = fallback skipped (no Q to truncate)', async () => {
    const provider: CompactProvider = {
      summarize: async () => null,
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const r = await runCompactPipeline(
      [
        { role: 'user', content: 'plain text' },
        { role: 'assistant', content: 'ok' },
      ],
      { provider, policy: { archiveDir: archDir() } },
    );
    expect(r.diagnostics.layer5FallbackTruncated).toBe(0);
  });
});

describe('MK 0.2.25 · verify-probe status with injected stream', () => {
  const slice: LLMMessage[] = [
    { role: 'user', content: 'edit src/x.ts' },
    { role: 'assistant', content: 'done' },
  ];

  test('runVerifyProbe status pass/fail/error with injected stream', async () => {
    // ⓐ probe replies 'none' → pass, ok true
    const pass = await runVerifyProbe({
      summary: 'edited src/x.ts',
      originalSlice: slice,
      stream: async () => 'none',
    });
    expect(pass.status).toBe('pass');
    expect(pass.ok).toBe(true);

    // ⓑ probe reports a lost detail → fail, ok false
    const fail = await runVerifyProbe({
      summary: 'edited a file',
      originalSlice: slice,
      stream: async () => 'lost the file path src/x.ts',
    });
    expect(fail.status).toBe('fail');
    expect(fail.ok).toBe(false);

    // ⓒ injected stream throws → error, fail-open keeps ok true
    const error = await runVerifyProbe({
      summary: 'edited src/x.ts',
      originalSlice: slice,
      stream: async () => {
        throw new Error('boom');
      },
    });
    expect(error.status).toBe('error');
    expect(error.ok).toBe(true);

    // ⓓ summarizerModel reaches the stream's 3rd arg and the result model
    let seenOpts: any;
    const model = await runVerifyProbe({
      summary: 'edited src/x.ts',
      originalSlice: slice,
      summarizerModel: 'z-ai/glm-5.3',
      stream: async (_msgs: LLMMessage[], _onChunk: any, opts: any) => {
        seenOpts = opts;
        return 'none';
      },
    });
    expect(seenOpts).toEqual({ model: 'z-ai/glm-5.3' });
    expect(model.model).toBe('z-ai/glm-5.3');
    expect(model.status).toBe('pass');
  });
});
