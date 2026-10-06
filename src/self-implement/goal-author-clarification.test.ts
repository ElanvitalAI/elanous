import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { authorGoal, type GoalAuthorDeps } from './goal-author.js';
import type { IntakeClarification } from '../autopilot/mission-intake-clarify.js';
import { defaultGoalAuthorSelfResolve, injectGoalDocumentClarificationAnswer, injectGoalDocumentClarificationOption, injectGoalDocumentClarificationOtherAnswer, parseGoalAuthorClarifications, parseGoalDocumentClarifications, resolveGoalAuthorClarification, seedGoalAuthorFromClarification, serializeGoalAuthorClarification, serializeResolvedGoalAuthorClarification,
  planClarificationIntake,
  applyClarificationReply,
  selfAnswerGoalDocumentClarifications,
} from './goal-author-clarification.js';

function clarification(overrides: Partial<IntakeClarification> = {}): IntakeClarification {
  return {
    questionId: 'q-auto',
    kind: 'scope',
    header: 'Clarification',
    question: 'Choose a repository target.',
    options: [
      { label: 'Recommended target', recommended: true },
      { label: 'Alternative target' },
    ],
    blocking: true,
    ...overrides,
  };
}

function responseFor(clarification: IntakeClarification) {
  return parseGoalAuthorClarifications(serializeGoalAuthorClarification(clarification))[0].response;
}

test('shared document self-answer persists one response and leaves the other deferred', async () => {
  const document = ['## WHAT TO BUILD', '- TRACED PATHS:', '  - evidence: src/example.ts: contract',
    ...['one', 'two'].flatMap((id) => [
      '- Clarification:', `  - id: ${id}`, '  - header: Clarification', `  - question: Question ${id}?`,
      '  - options:', '    - label: Option', '      description: Choose option.',
      '  - includeOther: true', `  - answer: DEFERRED-UNTIL: Question ${id}?`, '',
    ]),
  ].join('\n');
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  try {
    const result = await selfAnswerGoalDocumentClarifications(document, {
      path: 'ask', resolver: async ({ questionId, evidence }) => questionId === 'one'
        ? { answer: 'Option', evidence } : {},
  });
    expect(result).toMatchObject({ asked: 2, answered: 1, unanswered: 1 });
    expect(parseGoalDocumentClarifications(result.document).map(({ answer, answered }) => ({ answer, answered }))).toEqual([
      { answer: 'Option', answered: true },
      { answer: 'DEFERRED-UNTIL: Question two?', answered: false },
    ]);
    expect(result.document).toContain('  - provenance.source: self-authored');
    expect(log).toHaveBeenCalledWith('self-implement.clarification-escalation', 'self-answer', {
      path: 'ask', asked: 2, answered: 1, unanswered: 1, reason: 'insufficient-evidence',
    });
  } finally { log.mockRestore(); }
});

test('say-first keeps existing self-authored answers and still attempts the questions left unanswered', async () => {
  const document = [
    '- Clarification:', '  - id: existing', '  - header: Clarification', '  - question: Which contract?',
    '  - options:', '    - label: Keep API', '      description: Verified.', '  - includeOther: true',
    '  - answer: Keep API', '  - provenance.source: self-authored', '  - evidence: src/api.ts:12', '',
    '- Clarification:', '  - id: pending', '  - header: Clarification', '  - question: Which other?',
    '  - options:', '    - label: Other', '      description: Unknown.', '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: Which other?', '',
  ].join('\n');
  const asked: string[] = [];
  const result = await selfAnswerGoalDocumentClarifications(document, {
    path: 'say-first', evidence: ['src/api.ts:12: contract'],
    resolver: async ({ questionId, evidence }) => { asked.push(questionId); return { answer: 'Other', evidence }; },
  });
  // The already self-authored answer is never re-asked; the deferred one is attempted and answered.
  expect(asked).toEqual(['pending']);
  expect(result).toMatchObject({ asked: 2, answered: 2, unanswered: 0 });
  expect(parseGoalDocumentClarifications(result.document).every((item) => item.answered)).toBe(true);
});

test('say-first with no evidence-backed answer leaves the question unanswered and reports it', async () => {
  const document = [
    '- Clarification:', '  - id: pending', '  - header: Clarification', '  - question: Which other?',
    '  - options:', '    - label: Other', '      description: Unknown.', '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: Which other?', '',
  ].join('\n');
  const result = await selfAnswerGoalDocumentClarifications(document, { path: 'say-first', resolver: async () => ({}) });
  expect(result).toEqual({ document, asked: 1, answered: 0, unanswered: 1, newlyAnswered: 0 });
});

test('a resolver failure on one question leaves it unanswered, still attempts the rest and still observes', async () => {
  const document = ['- evidence: src/example.ts: contract', ...['one', 'two'].flatMap((id) => [
    '- Clarification:', `  - id: ${id}`, '  - header: Clarification', `  - question: Question ${id}?`,
    '  - options:', '    - label: Option', '      description: Choose option.',
    '  - includeOther: true', `  - answer: DEFERRED-UNTIL: Question ${id}?`, '',
  ])].join('\n');
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  try {
    const result = await selfAnswerGoalDocumentClarifications(document, {
      path: 'rework', resolver: async ({ questionId, evidence }) => {
        if (questionId === 'one') throw new Error('provider down');
        return { answer: 'Option', evidence };
      },
    });
    expect(result).toMatchObject({ asked: 2, answered: 1, unanswered: 1, newlyAnswered: 1 });
    expect(parseGoalDocumentClarifications(result.document).map(({ questionId, answered }) => ({ questionId, answered }))).toEqual([
      { questionId: 'one', answered: false }, { questionId: 'two', answered: true },
    ]);
    expect(log).toHaveBeenCalledWith('self-implement.clarification-escalation', 'self-answer', {
      path: 'rework', asked: 2, answered: 1, unanswered: 1, reason: 'insufficient-evidence',
    });
  } finally { log.mockRestore(); }
});

test('say-first counts existing self-authored answers but reports none as newly answered', async () => {
  const document = [
    '- Clarification:', '  - id: existing', '  - header: Clarification', '  - question: Which contract?',
    '  - options:', '    - label: Keep API', '      description: Verified.', '  - includeOther: true',
    '  - answer: Keep API', '  - provenance.source: self-authored', '  - evidence: src/api.ts:12', '',
  ].join('\n');
  const result = await selfAnswerGoalDocumentClarifications(document, { path: 'say-first', resolver: async () => { throw new Error('not called'); } });
  expect(result).toEqual({ document, asked: 1, answered: 1, unanswered: 0, newlyAnswered: 0 });
});

test('shared self-answer keeps duplicate IDs deferred and never overwrites a prior answer', async () => {
  const block = (id: string, answer: string) => [
    '- Clarification:', `  - id: ${id}`, '  - header: Clarification', `  - question: Question ${id}?`,
    '  - options:', '    - label: A', '      description: A', '    - label: B', '      description: B',
    '  - includeOther: true', `  - answer: ${answer}`, '',
  ].join('\n');
  const document = ['- evidence: src/test.ts: fact', block('answered', 'A'), block('duplicate', 'DEFERRED-UNTIL: Q'), block('duplicate', 'DEFERRED-UNTIL: Q')].join('\n');
  let calls = 0;
  const result = await selfAnswerGoalDocumentClarifications(document, {
    path: 'rework', resolver: async ({ evidence }) => { calls++; return { answer: 'B', evidence }; },
  });
  expect(calls).toBe(0);
  expect(result).toMatchObject({ asked: 2, answered: 0, unanswered: 2, document });
});

test('auto-answers exactly one recommended non-safety option and preserves the clarification round trip', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);

  expect(responseFor(clarification())).toMatchObject({
    answer: 'Recommended target',
    status: 'ANSWERED',
  });
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'auto-answered', {
    questionId: 'q-auto',
    kind: 'scope',
    label: 'Recommended target',
    selfResolutionSelected: false,
  });
  expect(log).toHaveBeenCalledTimes(2);
  log.mockRestore();
});

test('dual-emits clarification and self-resolution outcomes under harness author categories', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  try {
    await resolveGoalAuthorClarification(clarification());
    await defaultGoalAuthorSelfResolve({
      questionId: 'q-dual-emit',
      question: 'Which command preserves the contract?',
      kind: 'term',
      options: [],
      evidence: ['src/example.ts: command contract'],
    }, { stream: async () => '{"answer":"bun test src/example.test.ts"}' });

    expect(log.mock.calls).toContainEqual([
      'goal-author.clarify', 'auto-answered', {
        questionId: 'q-auto', kind: 'scope', answer: 'Recommended target', selfResolutionSelected: false,
      },
    ]);
    expect(log.mock.calls).toContainEqual([
      'harness.author.clarify', 'auto-answered', {
        questionId: 'q-auto', kind: 'scope', answer: 'Recommended target', selfResolutionSelected: false,
      },
    ]);
    const legacySelfResolution = log.mock.calls.find(([category, event]) => category === 'goal-author' && event === 'self-resolve-answered');
    const harnessSelfResolution = log.mock.calls.find(([category, event]) => category === 'harness.author' && event === 'self-resolve-answered');
    expect(harnessSelfResolution?.slice(1)).toEqual(legacySelfResolution?.slice(1));
  } finally {
    log.mockRestore();
  }
});

test('defers safety and ambiguous recommendations while preserving injected answers', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  expect(serializeGoalAuthorClarification(clarification({ kind: 'safety' }))).toContain('"status":"DEFERRED-UNTIL: Choose a repository target."');

  expect(responseFor(clarification({ kind: 'safety' }))).toMatchObject({
    answer: null,
    status: 'DEFERRED-UNTIL: Choose a repository target.',
  });
  expect(responseFor(clarification({
    options: [
      { label: 'Recommended target', recommended: true },
      { label: 'Also recommended', recommended: true },
    ],
  }))).toMatchObject({
    answer: null,
    status: 'DEFERRED-UNTIL: Choose a repository target.',
  });
  expect(responseFor(clarification({ answer: 'Injected answer' }))).toMatchObject({
    answer: 'Injected answer',
    status: 'ANSWERED',
  });
  expect(log).not.toHaveBeenCalled();
});

test('self-authors eligible multi-option, zero-option, and free-input answers with evidence', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const resolve = async ({ question, evidence }: { question: string; evidence: readonly string[] }) => ({
    answer: question.includes('value') ? 'bun test src/self-implement/goal-author-clarification.test.ts' : 'Alternative target',
    evidence,
  });
  const deps = { selfResolve: resolve, evidence: ['src/self-implement/goal-author-clarification.test.ts: focused contract'] };

  for (const item of [
    clarification({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }),
    clarification({ options: [] }),
    clarification({ question: 'Provide a value that preserves the contract.', options: [] }),
  ]) {
    const response = await resolveGoalAuthorClarification(item, deps);
    expect(response).toMatchObject({ answer: item.question.includes('value') ? 'bun test src/self-implement/goal-author-clarification.test.ts' : 'Alternative target', status: 'ANSWERED', provenance: { source: 'self-authored', evidence: deps.evidence } });
  }
  const serialized = await serializeResolvedGoalAuthorClarification(clarification({ options: [] }), deps);
  expect(parseGoalAuthorClarifications(serialized)[0].response).toMatchObject({
    answer: 'Alternative target',
    provenance: { source: 'self-authored', evidence: deps.evidence },
  });
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'self-answered', expect.objectContaining({ questionId: 'q-auto', evidence: deps.evidence }));
  log.mockRestore();
});

test('parser requires the exact provenance shape for deterministic and self-authored responses', async () => {
  const mutate = (serialized: string, provenance: unknown) => {
    const record = JSON.parse(serialized.slice('- Clarification: '.length)) as { response: { provenance?: unknown } };
    record.response.provenance = provenance;
    return `- Clarification: ${JSON.stringify(record)}`;
  };
  const safety = serializeGoalAuthorClarification(clarification({ kind: 'safety' }));
  const injected = serializeGoalAuthorClarification(clarification({ answer: 'Injected answer' }));
  const recommended = serializeGoalAuthorClarification(clarification());
  const selfAuthored = await serializeResolvedGoalAuthorClarification(clarification({ options: [] }), {
    evidence: ['src/example.ts: grounded'],
    selfResolve: async ({ evidence }) => ({ answer: 'generated', evidence }),
  });

  expect(parseGoalAuthorClarifications(mutate(safety, { source: 'self-authored', evidence: ['src/example.ts: forged'] }))).toEqual([]);
  expect(parseGoalAuthorClarifications(mutate(injected, { source: 'self-authored', evidence: ['src/example.ts: forged'] }))).toEqual([]);
  expect(parseGoalAuthorClarifications(mutate(recommended, { source: 'recommended', evidence: [] }))).toEqual([]);
  expect(parseGoalAuthorClarifications(mutate(safety, {}))).toEqual([]);
  expect(parseGoalAuthorClarifications(mutate(selfAuthored, { source: 'self-authored', evidence: ['src/example.ts: grounded'], extra: true }))).toEqual([]);
  expect(parseGoalAuthorClarifications(recommended)).toHaveLength(1);
  expect(parseGoalAuthorClarifications(selfAuthored)).toHaveLength(1);
});

test('self-resolution remains unresolved without an injected resolver and never invokes the default model resolver', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const modelResolver = spyOn({ resolve: defaultGoalAuthorSelfResolve }, 'resolve');

  await expect(resolveGoalAuthorClarification(clarification({ options: [] }))).resolves.toMatchObject({
    answer: null,
    status: 'DEFERRED-UNTIL: Choose a repository target.',
  });
  expect(modelResolver).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'unresolved', expect.objectContaining({
    questionId: 'q-auto',
    selfResolutionSelected: false,
  }));
  modelResolver.mockRestore();
  log.mockRestore();
});

test('self-resolution abstains on uncertainty or error and never overrides safety or injected answers', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const abstain = async () => ({});
  const error = async () => { throw new Error('timeout'); };
  for (const deps of [{ selfResolve: abstain }, { selfResolve: error }]) {
    await expect(resolveGoalAuthorClarification(clarification({ options: [] }), deps)).resolves.toMatchObject({
      answer: null,
      status: 'DEFERRED-UNTIL: Choose a repository target.',
    });
  }
  const resolver = spyOn({ resolve: async () => ({ answer: 'wrong', evidence: ['evidence'] }) }, 'resolve');
  await expect(resolveGoalAuthorClarification(clarification({ kind: 'safety', options: [] }), { selfResolve: resolver })).resolves.toMatchObject({ answer: null });
  await expect(resolveGoalAuthorClarification(clarification({ answer: 'Human override', options: [] }), { selfResolve: resolver })).resolves.toMatchObject({ answer: 'Human override', provenance: { source: 'injected' } });
  expect(resolver).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'self-answer-deferred', expect.objectContaining({ reason: 'timeout', selfResolutionSelected: true }));
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'answer-injected', expect.objectContaining({
    questionId: 'q-auto',
    selfResolutionSelected: true,
  }));
  log.mockRestore();
});

test('resolver observations match deterministic answers and leave abstention ownership to the author flow', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const recommended = await resolveGoalAuthorClarification(clarification(), { selfResolve: async () => ({}) });
  const abstained = await resolveGoalAuthorClarification(clarification({ options: [] }), { selfResolve: async () => ({}) });

  expect(recommended).toMatchObject({ answer: 'Recommended target', status: 'ANSWERED' });
  expect(abstained).toMatchObject({ answer: null, status: 'DEFERRED-UNTIL: Choose a repository target.' });
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'auto-answered', expect.objectContaining({ questionId: 'q-auto', answer: 'Recommended target', selfResolutionSelected: true }));
  expect(log.mock.calls.filter(([category, event]) => category === 'goal-author.clarify' && event === 'unresolved')).toHaveLength(0);
  log.mockRestore();
});

test('authorGoal leaves generated clarifications unresolved without a resolver and records the default selection', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const deps: GoalAuthorDeps = {
    ground: async () => ({
      grounded: true, context: '', files: ['src/example.ts'],
      persistentEvidence: [],
      codeFacts: ['[code:src/example.ts] exampleExport'], skillFacts: [], memoryFacts: [], documentFacts: [],
      documentMatches: [], searchTerms: [], genericSearchScope: false, refFacts: [], ptyFacts: [],
    }),
    enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
  };
  const authored = await authorGoal('Preserve the current contract.', deps);

  expect(authored.document).toContain('DEFERRED-UNTIL:');
  expect(authored.document).not.toContain('provenance.source: self-authored');
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'unresolved', expect.objectContaining({ selfResolutionSelected: false }));
  log.mockRestore();
});

test('authorGoal wires its generated clarification through an explicitly injected resolver', async () => {
  const selfResolveClarification = spyOn({ resolve: async () => ({ answer: 'bun test src/self-implement/goal-author-clarification.test.ts → 0 fail', evidence: ['src/example.ts: current contract'] }) }, 'resolve');
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const deps: GoalAuthorDeps = {
    ground: async () => ({
      grounded: true, context: '', files: ['src/example.ts'],
      persistentEvidence: [],
      codeFacts: ['[code:src/example.ts] exampleExport'], skillFacts: [], memoryFacts: [], documentFacts: [],
      documentMatches: [], searchTerms: [], genericSearchScope: false, refFacts: [], ptyFacts: [],
    }),
    enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
    selfResolveClarification,
  };
  const authored = await authorGoal('Preserve the current contract.', deps);

  expect(selfResolveClarification).toHaveBeenCalled();
  expect(authored.document).toContain('bun test src/self-implement/goal-author-clarification.test.ts → 0 fail');
  expect(authored.document).toContain('  - provenance.source: self-authored');
  expect(authored.document).toContain('  - evidence: src/example.ts: current contract');
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'self-answered', expect.objectContaining({ selfResolutionSelected: true }));
  log.mockRestore();
});

test('default self-resolver prompts the elanous model, parses valid JSON, and aborts on timeout', async () => {
  const context = {
    questionId: 'q-model',
    question: 'Which command preserves the contract?',
    kind: 'term' as const,
    options: [],
    evidence: ['src/example.ts: command contract'],
  };
  let prompt = '';
  const resolved = await defaultGoalAuthorSelfResolve(context, {
    stream: async (input) => {
      prompt = input;
      return '{"answer":"bun test src/example.test.ts"}';
    },
  });
  expect(prompt).toContain('Do not delegate to an implementation agent.');
  expect(prompt).toContain('Options: (free input)');
  expect(resolved).toEqual({ answer: 'bun test src/example.test.ts', evidence: context.evidence });
  await expect(defaultGoalAuthorSelfResolve(context, { stream: async () => 'not json' })).resolves.toEqual({});

  let aborted = false;
  await expect(defaultGoalAuthorSelfResolve(context, {
    timeoutMs: 1,
    stream: (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = signal.aborted;
      reject(signal.reason);
    }, { once: true })),
  })).resolves.toEqual({});
  expect(aborted).toBe(true);
});

describe('defaultGoalAuthorSelfResolve observations distinguish five outcomes', () => {
  const context = {
    questionId: 'q-observe',
    question: 'Which command preserves the contract?',
    kind: 'term' as const,
    options: [],
    evidence: ['src/example.ts: command contract'],
  };

  function selfResolveLogs(log: ReturnType<typeof spyOn<typeof debug, 'log'>>) {
    return log.mock.calls.filter((call) => call[0] === 'goal-author' && String(call[1]).startsWith('self-resolve-'));
  }

  test('empty evidence records no-evidence, does not call the model, and returns the empty shape', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    let called = 0;
    const resolved = await defaultGoalAuthorSelfResolve(
      { ...context, evidence: [] },
      { stream: async () => { called += 1; return '{"answer":"should-not-run"}'; } },
    );
    const observations = selfResolveLogs(log);
    expect(called).toBe(0);
    expect(resolved).toEqual({});
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-no-evidence');
    expect(observations[0][2]).toEqual(expect.objectContaining({
      questionId: 'q-observe',
      elapsedMs: expect.any(Number),
      usage: 'unmeasured',
    }));
    log.mockRestore();
  });

  test('a model answer string records answered with length and returns the answered shape', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const answer = 'bun test src/example.test.ts';
    const resolved = await defaultGoalAuthorSelfResolve(context, {
      stream: async () => JSON.stringify({ answer }),
    });
    const observations = selfResolveLogs(log);
    expect(resolved).toEqual({ answer, evidence: context.evidence });
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-answered');
    expect(observations[0][2]).toEqual(expect.objectContaining({
      questionId: 'q-observe',
      elapsedMs: expect.any(Number),
      answerLength: answer.length,
    }));
    expect((observations[0][2] as { answerLength: number }).answerLength).toBeGreaterThan(0);
    log.mockRestore();
  });

  test('an answered self-resolution accumulates safe usage into distinct measured totals', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const answer = 'bun test src/example.test.ts';
    await defaultGoalAuthorSelfResolve(context, {
      stream: async (_prompt, _signal, onUsage) => {
        onUsage({ provider: 'anthropic', inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 10, outputTokens: 30, reasoningOutputTokens: 5 });
        onUsage({ provider: 'openai', inputTokens: 10, cacheReadInputTokens: -1, cacheCreationInputTokens: Number.NaN, outputTokens: 4, reasoningOutputTokens: 9 });
        onUsage({ provider: 'openai', inputTokens: 0, outputTokens: 0 });
        return JSON.stringify({ answer });
      },
    });
    const observation = selfResolveLogs(log).find((call) => call[1] === 'self-resolve-answered');
    expect(observation?.[2]).toEqual(expect.objectContaining({
      answerLength: answer.length,
      contextTokens: 140,
      totalTokens: 174,
    }));
    expect((observation?.[2] as { contextTokens: number }).contextTokens).not.toBe(
      (observation?.[2] as { totalTokens: number }).totalTokens,
    );
    log.mockRestore();
  });

  test('an answered self-resolution normalizes opposite cache conventions without dropping reasoning', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    await defaultGoalAuthorSelfResolve(context, {
      stream: async (_prompt, _signal, onUsage) => {
        onUsage({ provider: 'anthropic', inputTokens: 300, cacheReadInputTokens: 700, cacheCreationInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 });
        onUsage({ provider: 'openai', inputTokens: 1000, cacheReadInputTokens: 700, cacheCreationInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 });
        return '{"answer":"normalized"}';
      },
    });
    const observation = selfResolveLogs(log).find((call) => call[1] === 'self-resolve-answered');
    expect(observation?.[2]).toEqual(expect.objectContaining({ contextTokens: 2000, totalTokens: 2400 }));
    log.mockRestore();
  });

  test('an answered self-resolution marks unknown provider usage unmeasured instead of zero', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    await defaultGoalAuthorSelfResolve(context, {
      stream: async (_prompt, _signal, onUsage) => {
        onUsage({ inputTokens: 100, cacheReadInputTokens: 50, outputTokens: 20 });
        return '{"answer":"measured separately"}';
      },
    });
    const observation = selfResolveLogs(log).find((call) => call[1] === 'self-resolve-answered');
    expect(observation?.[2]).toEqual(expect.objectContaining({ usage: 'unmeasured' }));
    expect(observation?.[2]).not.toEqual(expect.objectContaining({ contextTokens: 0, totalTokens: 0 }));
    log.mockRestore();
  });

  test('an answered self-resolution marks absent usage unmeasured instead of zero', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    await defaultGoalAuthorSelfResolve(context, { stream: async () => '{"answer":"measured separately"}' });
    const observation = selfResolveLogs(log).find((call) => call[1] === 'self-resolve-answered');
    expect(observation?.[2]).toEqual(expect.objectContaining({ usage: 'unmeasured' }));
    expect(observation?.[2]).not.toEqual(expect.objectContaining({ contextTokens: 0, totalTokens: 0 }));
    log.mockRestore();
  });

  test('a null model answer records declined unanswered usage and evidence count, distinct from timeout', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const resolved = await defaultGoalAuthorSelfResolve(context, {
      stream: async (_prompt, _signal, onUsage) => {
        onUsage({ provider: 'openai', inputTokens: 40, outputTokens: 8 });
        return '{"answer":null}';
      },
    });
    const observations = selfResolveLogs(log);
    expect(resolved).toEqual({});
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-unanswered');
    expect(observations[0][1]).not.toBe('self-resolve-timeout');
    expect(observations[0][2]).toEqual(expect.objectContaining({
      questionId: 'q-observe',
      elapsedMs: expect.any(Number),
      reason: 'declined',
      evidenceCount: context.evidence.length,
      contextTokens: 40,
      totalTokens: 48,
    }));
    log.mockRestore();
  });

  test('an answer shape outside the contract records shape-mismatch without changing resolution', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const resolved = await defaultGoalAuthorSelfResolve(context, {
      stream: async () => '{"other":"value"}',
    });
    const observation = selfResolveLogs(log)[0];
    expect(resolved).toEqual({});
    expect(observation[1]).toBe('self-resolve-unanswered');
    expect(observation[2]).toEqual(expect.objectContaining({
      reason: 'shape-mismatch',
      evidenceCount: context.evidence.length,
      usage: 'unmeasured',
    }));
    log.mockRestore();
  });

  test('a timeout abort records timeout usage and returns empty', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const resolved = await defaultGoalAuthorSelfResolve(context, {
      timeoutMs: 1,
      stream: (_, signal, onUsage) => new Promise((_, reject) => {
        onUsage({ provider: 'openai', inputTokens: 25, outputTokens: 5 });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const observations = selfResolveLogs(log);
    expect(resolved).toEqual({});
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-timeout');
    expect(observations[0][2]).toEqual(expect.objectContaining({
      questionId: 'q-observe',
      elapsedMs: expect.any(Number),
      contextTokens: 25,
      totalTokens: 30,
    }));
    log.mockRestore();
  });

  test('non-JSON output records parse-failed, distinct from timeout, and returns empty', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const resolved = await defaultGoalAuthorSelfResolve(context, {
      stream: async () => 'not json',
    });
    const observations = selfResolveLogs(log);
    expect(resolved).toEqual({});
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-parse-failed');
    expect(observations[0][1]).not.toBe('self-resolve-timeout');
    expect(observations[0][2]).toEqual(expect.objectContaining({
      questionId: 'q-observe',
      elapsedMs: expect.any(Number),
    }));
    log.mockRestore();
  });

  test('a non-timeout exception is not folded into timeout and still returns empty', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const resolved = await defaultGoalAuthorSelfResolve(context, {
      stream: async () => { throw new Error('stream exploded'); },
    });
    const observations = selfResolveLogs(log);
    expect(resolved).toEqual({});
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-error');
    expect(observations[0][1]).not.toBe('self-resolve-timeout');
    log.mockRestore();
  });

  test('the five outcomes keep answered shape only when the model answered', async () => {
    const cases = [
      { evidence: [] as string[], stream: async () => '{"answer":"x"}', expected: {} },
      { evidence: context.evidence, stream: async () => '{"answer":"kept"}', expected: { answer: 'kept', evidence: context.evidence } },
      { evidence: context.evidence, stream: async () => '{"answer":null}', expected: {} },
      {
        evidence: context.evidence,
        timeoutMs: 1,
        stream: (_: string, signal: AbortSignal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
        expected: {},
      },
      { evidence: context.evidence, stream: async () => 'not json', expected: {} },
    ];
    for (const item of cases) {
      await expect(defaultGoalAuthorSelfResolve(
        { ...context, evidence: item.evidence },
        { stream: item.stream, timeoutMs: item.timeoutMs },
      )).resolves.toEqual(item.expected);
    }
  });

  test('a long answer is observed by length only, never as the full body', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const answer = 'ANSWER-BODY-'.repeat(400);
    await defaultGoalAuthorSelfResolve(context, {
      stream: async () => JSON.stringify({ answer }),
    });
    const observations = selfResolveLogs(log);
    expect(observations).toHaveLength(1);
    expect(observations[0][1]).toBe('self-resolve-answered');
    expect(JSON.stringify(observations[0][2])).not.toContain(answer);
    expect(observations[0][2]).toEqual(expect.objectContaining({ answerLength: answer.length }));
    log.mockRestore();
  });

  test('the clarification identifier from context is on the observation', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    await defaultGoalAuthorSelfResolve({ ...context, questionId: 'q-join-key' }, {
      stream: async () => '{"answer":null}',
    });
    const observations = selfResolveLogs(log);
    expect(observations[0][2]).toEqual(expect.objectContaining({ questionId: 'q-join-key' }));
    log.mockRestore();
  });
});

const goalDocument = `Goal title
- Clarification:
  - id: target
  - header: Clarification
  - question: Which target?
  - options:
    - label: Focused test
      description: Name the failing test.
    - label: Error line
      description: Provide one error line.
  - includeOther: true
  - answer: DEFERRED-UNTIL: Which target?

Other verbatim content.
- Clarification:
  - id: already-answered
  - header: Clarification
  - question: Existing answer?
  - options:
    - label: Keep
      description: Keep it.
  - includeOther: true
  - answer: existing value
`;

test('lists multiline authored-goal clarifications and injects one answer without changing other content', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => undefined);
  const before = parseGoalDocumentClarifications(goalDocument);
  const updated = injectGoalDocumentClarificationAnswer(goalDocument, 'target', 'Focused test');
  const after = parseGoalDocumentClarifications(updated);

  expect(before.map(({ questionId, answered, options, includeOther }) => ({ questionId, answered, options, includeOther }))).toEqual([
    { questionId: 'target', answered: false, options: [{ label: 'Focused test', description: 'Name the failing test.' }, { label: 'Error line', description: 'Provide one error line.' }], includeOther: true },
    { questionId: 'already-answered', answered: true, options: [{ label: 'Keep', description: 'Keep it.' }], includeOther: true },
  ]);
  expect(updated).toContain('  - answer: Focused test');
  expect(updated).toContain('Other verbatim content.');
  expect(after.map(({ questionId, answer }) => ({ questionId, answer }))).toEqual([
    { questionId: 'target', answer: 'Focused test' },
    { questionId: 'already-answered', answer: 'existing value' },
  ]);
  expect(log).toHaveBeenCalledWith('goal-author.clarify', 'answer-injected', {
    questionId: 'target',
    source: 'cli',
    selfResolutionSelected: false,
  });
  log.mockRestore();
});

test('stops parsing at the clarification block boundary and does not replace a later answer field', () => {
  const document = `${goalDocument}\nUnrelated section:\n  - answer: preserve this answer\n`;
  const updated = injectGoalDocumentClarificationAnswer(document, 'target', 'Focused test');

  expect(updated).toContain('  - answer: Focused test');
  expect(updated).toContain('  - answer: preserve this answer');
  expect(parseGoalDocumentClarifications(updated).map(({ questionId, answer }) => ({ questionId, answer }))).toEqual([
    { questionId: 'target', answer: 'Focused test' },
    { questionId: 'already-answered', answer: 'existing value' },
  ]);
});

const renderedGoalDocument = `${goalDocument}\n## PROBLEM\nSituation: GROUNDED — The answer must synchronize both surfaces.\nComplication: GROUNDED — The rendered answer can be stale.\n\n## WHAT TO BUILD\nQuestion: GROUNDED — Which target?\nAnswer: UNANSWERED — target\n\nOriginal ask (verbatim, unmodified):\n\`\`\`\nQuestion: GROUNDED — Which target?\nAnswer: UNANSWERED — target\n\`\`\`\n\n> Answer: UNANSWERED — target\n\n## ACCEPTANCE CRITERIA\nQuestion: GROUNDED — Which target?\nAnswer: UNANSWERED — target\n`;

function whatToBuildAnswer(document: string): string | undefined {
  return /^## WHAT TO BUILD\nQuestion: GROUNDED — Which target\?\n(Answer: .+)$/m.exec(document)?.[1];
}

test('injects a free-form answer into the structured and WHAT TO BUILD render surfaces only', () => {
  const preservedMarker = 'Answer: UNANSWERED — target';
  expect(renderedGoalDocument.match(new RegExp(preservedMarker, 'g'))).toHaveLength(4);

  const updated = injectGoalDocumentClarificationOtherAnswer(renderedGoalDocument, 'target', 'Implementation anchor');

  expect(whatToBuildAnswer(updated)).toBe('Answer: GROUNDED — Implementation anchor');
  expect(updated.match(new RegExp(preservedMarker, 'g'))).toHaveLength(3);
  expect(updated).toContain('Original ask (verbatim, unmodified):\n```\nQuestion: GROUNDED — Which target?\nAnswer: UNANSWERED — target\n```');
  expect(updated).toContain('> Answer: UNANSWERED — target');
  expect(updated).toContain('## ACCEPTANCE CRITERIA\nQuestion: GROUNDED — Which target?\nAnswer: UNANSWERED — target');
  expect(parseGoalDocumentClarifications(updated).find(({ questionId }) => questionId === 'target')).toMatchObject({
    answered: true,
    answer: 'Implementation anchor',
  });
});

test('all human injection APIs replace self-authored answers and remove generated evidence', () => {
  const selfAuthored = (answer: string) => renderedGoalDocument.replace(
    '  - answer: DEFERRED-UNTIL: Which target?',
    `  - answer: ${answer}\n  - provenance.source: self-authored\n  - evidence: src/example.ts: generated grounding`,
  );
  const cases = [
    { updated: injectGoalDocumentClarificationAnswer(selfAuthored('generated answer'), 'target', 'Human override'), answer: 'Human override' },
    { updated: injectGoalDocumentClarificationOption(selfAuthored('generated option'), 'target', '1'), answer: 'Error line' },
    { updated: injectGoalDocumentClarificationOtherAnswer(selfAuthored('generated free input'), 'target', 'Human free input'), answer: 'Human free input' },
  ];

  for (const { updated, answer } of cases) {
    expect(updated).toContain(`  - answer: ${answer}\n  - provenance.source: injected`);
    expect(updated).not.toContain('self-authored');
    expect(updated).not.toContain('src/example.ts: generated grounding');
    expect(whatToBuildAnswer(updated)).toBe(`Answer: GROUNDED — ${answer}`);
    expect(parseGoalDocumentClarifications(updated).find(({ questionId }) => questionId === 'target')).toMatchObject({
      answer,
      answered: true,
      provenanceSource: 'injected',
      provenanceLines: [expect.any(Number)],
    });
  }
});

test('injects an option answer into the structured and WHAT TO BUILD render surfaces only', () => {
  const updated = injectGoalDocumentClarificationOption(renderedGoalDocument, 'target', '1');

  expect(whatToBuildAnswer(updated)).toBe('Answer: GROUNDED — Error line');
  expect(updated.match(/Answer: UNANSWERED — target/g)).toHaveLength(3);
  expect(parseGoalDocumentClarifications(updated).find(({ questionId }) => questionId === 'target')).toMatchObject({
    answered: true,
    answer: 'Error line',
  });
});

test('updates every matching WHAT TO BUILD render marker but preserves matching markers outside it', () => {
  const document = renderedGoalDocument.replace(
    'Answer: UNANSWERED — target\n\nOriginal ask',
    'Answer: UNANSWERED — target\nQuestion: GROUNDED — Which target?\nAnswer: UNANSWERED — target\n\nOriginal ask',
  );
  const updated = injectGoalDocumentClarificationAnswer(document, 'target', 'Focused test');

  expect(updated.match(/Answer: GROUNDED — Focused test/g)).toHaveLength(2);
  expect(updated.match(/Answer: UNANSWERED — target/g)).toHaveLength(3);
});

test('keeps legacy documents without a rendered answer surface compatible', () => {
  const updated = injectGoalDocumentClarificationAnswer(goalDocument, 'target', 'Focused test');

  expect(updated).toContain('  - answer: Focused test');
  expect(parseGoalDocumentClarifications(updated).find(({ questionId }) => questionId === 'target')).toMatchObject({
    answered: true,
    answer: 'Focused test',
  });
});

test('rejects multiline free-form answers before updating either clarification surface', () => {
  expect(() => injectGoalDocumentClarificationOtherAnswer(renderedGoalDocument, 'target', 'first\nsecond'))
    .toThrow('clarification answer must be a non-empty single line');
});

test('seeds a child ask and exact parent provenance from one pending clarification', () => {
  expect(seedGoalAuthorFromClarification(goalDocument, 'docs/goals/GOAL-parent.txt', 'target')).toEqual({
    ask: 'Which target?',
    parent: { goalFile: 'docs/goals/GOAL-parent.txt', questionId: 'target' },
  });
  expect(() => seedGoalAuthorFromClarification(goalDocument, 'docs/goals/GOAL-parent.txt', 'already-answered'))
    .toThrow('goal clarification already answered: already-answered');
});

test('rejects already answered, missing, and duplicate clarification IDs without modifying the document', () => {
  expect(() => injectGoalDocumentClarificationAnswer(goalDocument, 'already-answered', 'replacement'))
    .toThrow('goal clarification already answered: already-answered');
  expect(() => injectGoalDocumentClarificationAnswer(goalDocument, 'missing', 'answer'))
    .toThrow('goal clarification not found: missing');

  const duplicate = `${goalDocument}\n- Clarification:\n  - id: target\n  - header: Duplicate\n  - question: Duplicate target?\n  - options:\n    - label: Duplicate\n      description: Duplicate answer.\n  - includeOther: true\n  - answer: DEFERRED-UNTIL: Duplicate target?\n`;
  expect(() => injectGoalDocumentClarificationAnswer(duplicate, 'target', 'replacement'))
    .toThrow('goal clarification is ambiguous: target');
  expect(duplicate).toContain('  - answer: DEFERRED-UNTIL: Which target?');
  expect(duplicate).toContain('  - answer: DEFERRED-UNTIL: Duplicate target?');
});

// ⛔⭐⭐⭐ 되묻기 «수신» — 대표 2026-08-11 지적으로 생겼다.
//   🔎 그전까지 저작기는 «묻는데» 답을 받을 창구가 없어 골에 DEFERRED 가 박힌 채 발사됐다.
//   ⛔ 무인 계약은 유지한다 — 대화형이 아니면 지나가되 «그 사실을 값으로» 낸다.
describe('planClarificationIntake — 물을지 말지', () => {
  const doc = [
    '- Clarification:',
    '  - id: q1',
    '  - header: Clarification',
    '  - question: 무엇을 대상으로 하나?',
    '  - options:',
    '    - label: A',
    '      description: 첫째',
    '    - label: B',
    '      description: 둘째',
    '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: 무엇을 대상으로 하나?',
  ].join('\n');

  test('[none] 미답이 없으면 물을 것이 없다', () => {
    expect(planClarificationIntake('본문만 있다', true)).toMatchObject({ mode: 'none' });
  });

  test('[ask] 대화형이면 «묻는다»', () => {
    const plan = planClarificationIntake(doc, true);
    expect(plan.mode).toBe('ask');
    expect(plan.pending).toHaveLength(1);
  });

  test('[deferred-noninteractive] 비대화형이면 지나가되 «그 사실이 값으로» 남는다', () => {
    // ⛔ 「물을 것이 없다(none)」와 「못 물었다」를 같은 값으로 두지 않는다 — 오늘의 0 vs 못 셈 규율.
    const plan = planClarificationIntake(doc, false);
    expect(plan.mode).toBe('deferred-noninteractive');
    expect(plan.pending).toHaveLength(1);
  });
});

describe('applyClarificationReply — 한 줄을 어디로 보내나', () => {
  const item = {
    questionId: 'q1', header: 'Clarification', question: 'Q',
    options: [{ label: 'A', description: '첫째' }, { label: 'B', description: '둘째' }],
    includeOther: true, answer: 'DEFERRED-UNTIL: Q', answered: false, answerLine: 0,
  };
  const doc = [
    '- Clarification:',
    '  - id: q1',
    '  - header: Clarification',
    '  - question: Q',
    '  - options:',
    '    - label: A',
    '      description: 첫째',
    '    - label: B',
    '      description: 둘째',
    '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: Q',
  ].join('\n');

  test('[skip] 빈 줄은 «답이 아니다» — 사람이 「모른다」를 말할 수 있어야 한다', () => {
    expect(applyClarificationReply(doc, item, '   ')).toMatchObject({ answered: false, kind: 'skipped' });
  });

  test('[option] 범위 안 숫자는 옵션으로 간다', () => {
    const applied = applyClarificationReply(doc, item, '1');
    expect(applied).toMatchObject({ answered: true, kind: 'option' });
    expect(applied.document).not.toBe(doc);
  });

  test('[out-of-range-is-free-text] ⛔ 범위 «밖» 숫자는 옵션이 아니라 자유 답이다', () => {
    // ⛔ 범위를 벗어난 인덱스로 문서를 깨뜨리지 않는다.
    expect(applyClarificationReply(doc, item, '9')).toMatchObject({ answered: true, kind: 'other' });
  });

  test('[free-text] 그 밖의 입력은 자유 답', () => {
    expect(applyClarificationReply(doc, item, 'src/foo.ts 의 bar 함수')).toMatchObject({ answered: true, kind: 'other' });
  });
});

// 🆕 2026-09-24 — 🅞 관측: 무인 `implementation_target` 이 4/4 거절(evidenceCount=20). 답변기가 요청을 못 봤다.
describe('self-resolution sees the request being authored', () => {
  const base = { questionId: 'implementation_target', question: 'Which file?', kind: 'term' as const, options: [], evidence: ['src/a.ts: parseBenchRecords'] };
  test('the prompt carries the ask when given, and omits the block when not', async () => {
    const prompts: string[] = [];
    const stream = async (prompt: string) => { prompts.push(prompt); return '{"answer":null}'; };
    await defaultGoalAuthorSelfResolve({ ...base, ask: 'parseBenchRecords 가 total 불일치를 기록한다' }, { stream });
    await defaultGoalAuthorSelfResolve(base, { stream });
    expect(prompts[0]).toContain('Request being authored:\nparseBenchRecords 가 total 불일치를 기록한다');
    expect(prompts[1]).not.toContain('Request being authored');
  });
  test('a very long ask is truncated with a visible marker', async () => {
    let prompt = '';
    await defaultGoalAuthorSelfResolve({ ...base, ask: 'x'.repeat(5_000) }, { stream: async (p) => { prompt = p; return '{"answer":null}'; } });
    expect(prompt).toContain('…(truncated 1000 chars)');
  });
  test('resolveGoalAuthorClarification forwards deps.ask to the resolver', async () => {
    const seen: (string | undefined)[] = [];
    await resolveGoalAuthorClarification(
      { questionId: 'implementation_target', kind: 'term', header: 'h', question: 'Which file?', options: [], blocking: false },
      { selfResolve: async (context) => { seen.push(context.ask); return {}; }, evidence: ['e'], ask: 'the ask' },
    );
    expect(seen).toEqual(['the ask']);
  });
});
