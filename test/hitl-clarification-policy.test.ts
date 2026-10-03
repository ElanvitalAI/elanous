import { describe, expect, spyOn, test } from 'bun:test';

import { debug } from '../src/debug/log.js';
import {
  decideAndObserveClarification,
  decideClarification,
  defaultClarificationBudget,
  resolveClarification,
  toAskUserQuestionRequest,
  type ClarificationCandidate,
} from '../src/hitl/clarification-policy.js';

const candidate = (overrides: Partial<ClarificationCandidate> = {}): ClarificationCandidate => ({
  id: 'storage_scope',
  decision: 'where to persist decisions',
  prompt: 'Which persistence scope should this use?',
  whyNow: 'The choice changes cross-session behaviour.',
  impact: 'high',
  replanTrigger: 'A second surface needs the saved decision.',
  options: [
    { label: 'Session only', description: 'Fast and reversible.' },
    { label: 'Shared store', description: 'Available to every surface.', recommended: true },
  ],
  ...overrides,
});

describe('progressive clarification policy', () => {
  test('asks one high-impact decision within budget and creates one wire question', () => {
    const decision = decideClarification(candidate(), {
      phase: 'intake',
      budget: defaultClarificationBudget('intake'),
    });

    expect(decision.action).toBe('ask');
    expect(decision.recommendedOption).toBe('Shared store');
    expect(decision.budgetCost).toBe(1);

    const request = toAskUserQuestionRequest(decision);
    expect(request?.questions).toHaveLength(1);
    expect(request?.questions[0]).toMatchObject({ id: 'storage_scope', includeOther: true, impact: 'high', recommendedIndex: 1 });
    expect(request?.questions[0]?.options).toEqual([
      { label: 'Session only', description: 'Fast and reversible.' },
      { label: 'Shared store', description: 'Available to every surface.' },
    ]);
    expect(request?.questions[0]?.question).toContain('Recommended: Shared store');
  });

  test('investigates resolvable facts instead of interrupting the user', () => {
    const decision = decideClarification(candidate({ factResolvable: true }), {
      phase: 'planning',
      budget: defaultClarificationBudget('planning'),
    });

    expect(decision.action).toBe('assume');
    expect(decision.reason).toContain('investigated');
    expect(toAskUserQuestionRequest(decision)).toBeUndefined();
  });

  test('does not pile a question onto an existing interview', () => {
    const decision = decideClarification(candidate(), {
      phase: 'planning',
      budget: defaultClarificationBudget('planning'),
      pendingQuestionCount: 1,
    });

    expect(decision.action).toBe('defer');
    expect(decision.reason).toContain('never batch');
  });

  test('defers non-critical questions after the phase budget is spent', () => {
    const decision = decideClarification(candidate(), {
      phase: 'execution',
      budget: { limit: 1, used: 1 },
    });

    expect(decision.action).toBe('defer');
    expect(decision.recommendedOption).toBe('Shared store');
    expect(decision.budgetCost).toBe(0);
  });

  test('asks critical boundaries even when the convenience budget is exhausted', () => {
    const decision = decideClarification(candidate({ impact: 'critical' }), {
      phase: 'execution',
      budget: { limit: 1, used: 1 },
    });

    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain('Critical safety');
  });

  test('routes an approved question through the existing multi-surface race', async () => {
    let observed = '';
    const result = await resolveClarification(candidate(), {
      phase: 'intake', budget: defaultClarificationBudget('intake'),
    }, {
      channels: [{
        name: 'test',
        async ask(request) {
          expect(request.questions).toHaveLength(1);
          return { answers: { storage_scope: 'Session only' } };
        },
        cancel() {},
      }],
      onDecision: decision => { observed = decision.action; },
    });

    expect(observed).toBe('ask');
    expect(result.answer?.result.answers.storage_scope).toBe('Session only');
    expect(result.answer?.channel).toBe('test');
  });

  test('assumes low-impact details and rejects unbounded option sets', () => {
    const low = decideClarification(candidate({ impact: 'low' }), {
      phase: 'intake', budget: defaultClarificationBudget('intake'),
    });
    const invalid = decideClarification(candidate({ options: [{ label: 'Only', description: 'No comparison.', recommended: true }] }), {
      phase: 'intake', budget: defaultClarificationBudget('intake'),
    });

    expect(low.action).toBe('assume');
    expect(invalid.action).toBe('assume');
    expect(invalid.reason).toContain('2–4 options');
  });

  test('execution observation does not log the recommended choice while intake keeps its fields', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const execution = { phase: 'execution' as const, budget: defaultClarificationBudget('execution') };
      decideAndObserveClarification(candidate(), execution, { consumer: 'self-implement-execution' });
      decideAndObserveClarification(candidate(), { ...execution, phase: 'intake' }, { consumer: 'test' });
      expect(log.mock.calls[0]?.[2]).not.toHaveProperty('recommendedOption');
      expect(log.mock.calls[1]?.[2]).toHaveProperty('recommendedOption', 'Shared store');
    } finally {
      log.mockRestore();
    }
  });

  test('observes ask/assume/defer decisions through the elanous debug log', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const context = { phase: 'intake' as const, budget: defaultClarificationBudget('intake') };
      decideAndObserveClarification(candidate(), context, { consumer: 'test' });
      decideAndObserveClarification(candidate({ factResolvable: true }), context, { consumer: 'test' });
      decideAndObserveClarification(candidate(), { ...context, budget: { limit: 1, used: 1 } }, { consumer: 'test' });

      expect(log).toHaveBeenCalledTimes(3);
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        'hitl.clarification-policy', 'hitl.clarification-policy', 'hitl.clarification-policy',
      ]);
      expect(log.mock.calls.map((call) => (call[2] as { action: string }).action)).toEqual([
        'ask', 'assume', 'defer',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
