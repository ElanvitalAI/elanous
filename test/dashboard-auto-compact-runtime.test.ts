import { describe, expect, test } from 'bun:test';

import { runDashboardAutoCompact } from '../src/dashboard/auto-compact-runtime.js';

describe('runDashboardAutoCompact', () => {
  test('rewrites history with summary and boundary when auto-compact fires', async () => {
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ] as any[];
    const chatLines: string[] = [];
    const debugLines: string[] = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: history as any,
      userMsg: { role: 'user', content: 'u2' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: true,
        partial: false,
        preserveLastN: 1,
        reason: 'budget',
        ratio: 0.9,
        usedTokens: 900,
        maxTokens: 1000,
      }),
      compactConversation: async () => ({ summary: 'summary text' }),
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: (_mode, detail) => `boundary:${detail}`,
      pushChatLine: (line) => { chatLines.push(line); },
      pushDebugLine: (line) => { debugLines.push(line); },
      muted: (text) => text,
      debugLog: () => {},
    });

    expect(history.map((entry) => entry.role)).toEqual(['system', 'assistant', 'assistant', 'user']);
    expect(String(history[1].content)).toContain('summary text');
    expect(chatLines[0]).toContain('boundary:budget 90.0%');
    expect(debugLines[0]).toContain('[auto-compact: budget 900/1000 (90.0%)]');
  });

  test('reports skip errors instead of throwing', async () => {
    const debugLines: string[] = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: [{ role: 'user', content: 'u1' }] as any,
      userMsg: { role: 'user', content: 'u1' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: true,
        partial: false,
        preserveLastN: 1,
        reason: 'budget',
        ratio: 0.9,
        usedTokens: 900,
        maxTokens: 1000,
      }),
      compactConversation: async () => {
        throw new Error('boom');
      },
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: (line) => { debugLines.push(line); },
      muted: (text) => text,
      debugLog: () => {},
    });

    expect(debugLines[0]).toContain('[auto-compact skipped: boom]');
  });

  // PR2 §5.2 — Layer 1+2 pre-pass + ChatCompactConfig wire-up.

  test('Layer 1+2 pre-pass mutates chatHistory when pipeline reduces something', async () => {
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ] as any[];

    let pipelineSessionId = '';
    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: history as any,
      userMsg: { role: 'user', content: 'u2' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: false, partial: false, preserveLastN: 0,
        reason: 'below threshold', ratio: 0.1, usedTokens: 100, maxTokens: 1000,
      }),
      compactConversation: async () => ({ summary: '' }),
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: () => {},
      chatCompactConfig: {
        verifyProbe: false,
        archiveEnabled: true,
        archiveRetentionDays: 30,
        archiveRetentionMb: 100,
      },
      runCompactPipeline: async (messages, opts) => {
        pipelineSessionId = opts.sessionId;
        const trimmed = messages.slice(0, 2); // pretend Layer 1 trimmed two
        return {
          messages: trimmed,
          diagnostics: {
            layer1ToolOutputBudgetSavedChars: 1000,
            layer1ResponsesTrimmed: 1,
            layer2MicrocompactCleared: 0,
            layer2MicrocompactSavedChars: 0,
            layer3SummaryApplied: 0 as 0 | 1,
            layer3SummaryModel: '',
            layer3SummaryChars: 0,
            layer4VerifyVerdict: 'skipped' as const,
            layer5FallbackTruncated: 0 as 0 | 1,
            breakerTripped: 0 as 0 | 1,
            archived: 1,
          },
        };
      },
      sessionId: 'session-pre-pass',
    });

    expect(pipelineSessionId).toBe('session-pre-pass');
    // history was [sys, u1, a1, u2]. Pre-pass returned [sys, u1] (2 msgs).
    // The runtime preserves system + appends userMsg → final [sys, u1, u2].
    expect(history.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  test('verifyProbe flag is propagated via setVerifyProbeEnabled', async () => {
    const verifyCalls: boolean[] = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: [{ role: 'user', content: 'u1' }] as any,
      userMsg: { role: 'user', content: 'u1' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: false, partial: false, preserveLastN: 0,
        reason: 'no', ratio: 0, usedTokens: 0, maxTokens: 1,
      }),
      compactConversation: async () => ({ summary: '' }),
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: () => {},
      chatCompactConfig: {
        verifyProbe: true,
        archiveEnabled: false,
        archiveRetentionDays: 30,
        archiveRetentionMb: 100,
      },
      runCompactPipeline: async (messages) => ({
        messages,
        diagnostics: {
          layer1ToolOutputBudgetSavedChars: 0,
          layer1ResponsesTrimmed: 0,
          layer2MicrocompactCleared: 0,
          layer2MicrocompactSavedChars: 0,
          layer3SummaryApplied: 0 as 0 | 1,
          layer3SummaryModel: '',
          layer3SummaryChars: 0,
          layer4VerifyVerdict: 'skipped' as const,
          layer5FallbackTruncated: 0 as 0 | 1,
          breakerTripped: 0 as 0 | 1,
          archived: 0,
        },
      }),
      setVerifyProbeEnabled: (v) => { verifyCalls.push(v); },
    });

    expect(verifyCalls).toEqual([true]);
  });

  test('pre-pass error is swallowed and logged via debugLog', async () => {
    const history = [{ role: 'user', content: 'u1' }] as any[];
    const debugCalls: Array<{ event: string; action: string }> = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: history as any,
      userMsg: { role: 'user', content: 'u1' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: false, partial: false, preserveLastN: 0,
        reason: 'no', ratio: 0, usedTokens: 0, maxTokens: 1,
      }),
      compactConversation: async () => ({ summary: '' }),
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: (event, action) => { debugCalls.push({ event, action }); },
      runCompactPipeline: async () => { throw new Error('boom'); },
    });

    expect(history.length).toBe(1); // unchanged
    expect(debugCalls.some((c) => c.action === 'error')).toBe(true);
  });

  test('pre-pass with no reduction does not mutate chatHistory', async () => {
    const history = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ] as any[];
    const before = history.map((m) => m.content);

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: history as any,
      userMsg: { role: 'user', content: 'u2' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: false, partial: false, preserveLastN: 0,
        reason: 'below', ratio: 0, usedTokens: 0, maxTokens: 1,
      }),
      compactConversation: async () => ({ summary: '' }),
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: () => {},
      runCompactPipeline: async (messages) => ({
        messages,
        diagnostics: {
          layer1ToolOutputBudgetSavedChars: 0,
          layer1ResponsesTrimmed: 0,
          layer2MicrocompactCleared: 0,
          layer2MicrocompactSavedChars: 0,
          layer3SummaryApplied: 0 as 0 | 1,
          layer3SummaryModel: '',
          layer3SummaryChars: 0,
          layer4VerifyVerdict: 'skipped' as const,
          layer5FallbackTruncated: 0 as 0 | 1,
          breakerTripped: 0 as 0 | 1,
          archived: 0,
        },
      }),
    });

    expect(history.map((m) => m.content)).toEqual(before);
  });

  // PR3 §5.2 follow-up — pipeline-based fire path. Provider supplied
  // → runCompactPipeline runs Layer 3+5; legacy path used as fallback
  // when pipeline no-ops or errors out.

  test('fire + provider produces Layer 3 summary; chatHistory is replaced + userMsg appended', async () => {
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ] as any[];
    const chatLines: string[] = [];
    const debugLines: string[] = [];
    const compactConvCalls: string[] = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: history as any,
      userMsg: { role: 'user', content: 'u2' } as any,
      model: 'claude-opus-4-7',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: true, partial: false, preserveLastN: 1,
        reason: 'budget', ratio: 0.9, usedTokens: 900, maxTokens: 1000,
      }),
      compactConversation: async () => {
        compactConvCalls.push('full');
        return { summary: 'should not be called' };
      },
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: (_mode, detail) => `boundary:${detail}`,
      pushChatLine: (line) => { chatLines.push(line); },
      pushDebugLine: (line) => { debugLines.push(line); },
      muted: (t) => t,
      debugLog: () => {},
      runCompactPipeline: async (_messages, opts) => ({
        // Pipeline returned a summary system message + tail.
        messages: [
          { role: 'system', content: '<context_summary>\nfake summary\n</context_summary>' },
        ],
        diagnostics: {
          layer1ToolOutputBudgetSavedChars: 0,
          layer1ResponsesTrimmed: 0,
          layer2MicrocompactCleared: 0,
          layer2MicrocompactSavedChars: 0,
          layer3SummaryApplied: 1 as 0 | 1,
          layer3SummaryModel: opts.activeModelId ?? 'unknown',
          layer3SummaryChars: 12,
          layer4VerifyVerdict: 'skipped' as const,
          layer5FallbackTruncated: 0 as 0 | 1,
          breakerTripped: 0 as 0 | 1,
          archived: 0,
        },
      }),
      getCompactProvider: () => ({
        async summarize() { return { summary: 'unused', sourceMessageCount: 1 }; },
        getContextWindow() { return 200_000; },
        getAutoCompactThreshold() { return 100_000; },
      }),
    });

    // Pipeline path was taken — legacy compactConversation NOT called.
    expect(compactConvCalls).toEqual([]);
    // History = [pipeline-summary, userMsg] (no system, since pipeline
    // already emitted a system message; runtime preserves whatever the
    // pipeline returned and appends userMsg).
    expect(history.length).toBe(2);
    expect(String(history[0].content)).toContain('fake summary');
    expect(history[1].content).toBe('u2');
    expect(chatLines[0]).toContain('boundary:budget 90.0%');
    expect(chatLines[0]).toContain('pipeline:claude-opus-4-7');
  });

  test('fire + provider with Layer 5 fallback also replaces chatHistory', async () => {
    const history = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
    ] as any[];
    const chatLines: string[] = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: history as any,
      userMsg: { role: 'user', content: 'u2' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: true, partial: false, preserveLastN: 1,
        reason: 'budget', ratio: 0.95, usedTokens: 950, maxTokens: 1000,
      }),
      compactConversation: async () => ({ summary: 'unused' }),
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: (_mode, detail) => `boundary:${detail}`,
      pushChatLine: (l) => { chatLines.push(l); },
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: () => {},
      runCompactPipeline: async (messages) => ({
        messages, // pipeline applied truncate fallback in-place
        diagnostics: {
          layer1ToolOutputBudgetSavedChars: 0,
          layer1ResponsesTrimmed: 0,
          layer2MicrocompactCleared: 0,
          layer2MicrocompactSavedChars: 0,
          layer3SummaryApplied: 0 as 0 | 1,
          layer3SummaryModel: '',
          layer3SummaryChars: 0,
          layer4VerifyVerdict: 'skipped' as const,
          layer5FallbackTruncated: 1 as 0 | 1,
          breakerTripped: 0 as 0 | 1,
          archived: 0,
        },
      }),
      getCompactProvider: () => ({
        async summarize() { return null; },
        getContextWindow() { return 200_000; },
        getAutoCompactThreshold() { return 100_000; },
      }),
    });

    expect(chatLines[0]).toContain('fallback');
  });

  test('pipeline no-op falls through to legacy compactConversation path', async () => {
    const compactConvCalls: string[] = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ] as any,
      userMsg: { role: 'user', content: 'u2' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: true, partial: false, preserveLastN: 1,
        reason: 'budget', ratio: 0.9, usedTokens: 900, maxTokens: 1000,
      }),
      compactConversation: async () => {
        compactConvCalls.push('full');
        return { summary: 'legacy-summary' };
      },
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: () => {},
      runCompactPipeline: async (messages) => ({
        messages, // no-op
        diagnostics: {
          layer1ToolOutputBudgetSavedChars: 0,
          layer1ResponsesTrimmed: 0,
          layer2MicrocompactCleared: 0,
          layer2MicrocompactSavedChars: 0,
          layer3SummaryApplied: 0 as 0 | 1,
          layer3SummaryModel: '',
          layer3SummaryChars: 0,
          layer4VerifyVerdict: 'skipped' as const,
          layer5FallbackTruncated: 0 as 0 | 1,
          breakerTripped: 0 as 0 | 1,
          archived: 0,
        },
      }),
      getCompactProvider: () => ({
        async summarize() { return null; },
        getContextWindow() { return 200_000; },
        getAutoCompactThreshold() { return 100_000; },
      }),
    });

    // Pipeline no-op'd → legacy path was used.
    expect(compactConvCalls).toEqual(['full']);
  });

  test('pipeline error falls through to legacy path without throwing', async () => {
    const compactConvCalls: string[] = [];
    const debugCalls: Array<{ event: string; action: string }> = [];

    await runDashboardAutoCompact({
      preamble: [],
      chatHistory: [{ role: 'user', content: 'u1' }] as any,
      userMsg: { role: 'user', content: 'u1' } as any,
      model: 'gpt-5',
      autoCompactConfig: {},
      shouldAutoCompact: () => ({
        fire: true, partial: false, preserveLastN: 0,
        reason: 'budget', ratio: 0.9, usedTokens: 900, maxTokens: 1000,
      }),
      compactConversation: async () => {
        compactConvCalls.push('full');
        return { summary: 'fallback-summary' };
      },
      compactConversationPartial: async () => ({ summary: '' }),
      renderCompactBoundary: () => '',
      pushChatLine: () => {},
      pushDebugLine: () => {},
      muted: (t) => t,
      debugLog: (event, action) => { debugCalls.push({ event, action }); },
      runCompactPipeline: async () => { throw new Error('pipeline boom'); },
      getCompactProvider: () => ({
        async summarize() { return null; },
        getContextWindow() { return 200_000; },
        getAutoCompactThreshold() { return 100_000; },
      }),
    });

    expect(compactConvCalls).toEqual(['full']);
    expect(debugCalls.some((c) => c.event === 'chat.presentation.auto-compact.pipeline' && c.action === 'error')).toBe(true);
  });
});
