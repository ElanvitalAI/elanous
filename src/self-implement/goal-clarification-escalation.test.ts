import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendSupervisorPlanRevision,
  escalateGoalDocumentClarifications,
  recordSupervisorPlanRevision,
  mapClarificationDeliveryIds,
  GOAL_CLARIFICATION_ESCALATION_CATEGORY,
  GOAL_CLARIFICATION_DELIVERY_SOURCES,
} from './goal-clarification-escalation.js';
import type { AskUserQuestionDispatchResult } from '../ask-user-question/tool.js';
import type { AskUserQuestionResult } from '../ask-user-question/types.js';
import {
  createPendingQuestion,
  readPendingQuestions,
  writePendingQuestion,
} from '../ask-user-question/pending-questions.js';
import { debug } from '../debug/log.js';
import { defaultGoalAuthorSelfResolve, parseGoalDocumentClarifications } from './goal-author-clarification.js';

const unresolvedGoal = [
  'Goal',
  '- Clarification:',
  '  - id: delivery_scope',
  '  - header: Delivery',
  '  - question: Which human surface should receive this?',
  '  - options:',
  '    - label: Telegram',
  '      description: Send the question to the Telegram operator.',
  '    - label: Discord',
  '      description: Send the question to the Discord operator.',
  '  - includeOther: true',
  '  - answer: DEFERRED-UNTIL: Which human surface should receive this?',
  '',
].join('\n');

function goalFile(document: string): { path: string; clean: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'goal-clarification-escalation-'));
  const path = join(root, 'GOAL.txt');
  writeFileSync(path, document);
  return { path, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function pendingPersistenceStub(): {
  create: typeof createPendingQuestion;
  write: (question: ReturnType<typeof createPendingQuestion>) => void;
} {
  return { create: createPendingQuestion, write: () => {} };
}

describe('mapClarificationDeliveryIds', () => {
  test('preserves single and distinct IDs while disambiguating duplicates deterministically', () => {
    expect(mapClarificationDeliveryIds([{ questionId: 'one' }])).toEqual([
      { clarification: { questionId: 'one' }, deliveryId: 'one', clarificationOccurrence: 0 },
    ]);
    expect(mapClarificationDeliveryIds([{ questionId: 'one' }, { questionId: 'two' }])).toEqual([
      { clarification: { questionId: 'one' }, deliveryId: 'one', clarificationOccurrence: 0 },
      { clarification: { questionId: 'two' }, deliveryId: 'two', clarificationOccurrence: 0 },
    ]);
    expect(mapClarificationDeliveryIds([{ questionId: 'one' }, { questionId: 'one' }])).toEqual([
      { clarification: { questionId: 'one' }, deliveryId: 'one__clarification_1', clarificationOccurrence: 0 },
      { clarification: { questionId: 'one' }, deliveryId: 'one__clarification_2', clarificationOccurrence: 1 },
    ]);
  });
});

describe('escalateGoalDocumentClarifications', () => {
  test('canary without a preservation-contract line self-answers through the existing escalation caller', async () => {
    const document = [
      '대상 경로: src/self-implement/goal-author-clarification.ts, src/self-implement/goal-clarification-escalation.ts',
      ...Array.from({ length: 20 }, (_, index) => `- evidence: src/self-implement/goal-author-clarification.ts:${index + 1}: exported API names only`),
      '## WHAT TO BUILD', 'Question: NOT-GROUNDED — Which preservation contract?',
      'Answer: UNANSWERED — preservation_contract', '',
      '- Clarification:', '  - id: preservation_contract', '  - header: Clarification',
      '  - question: Which preservation contract?', '  - options:',
      '    - label: Failing test', '      description: Name a failing test.',
      '  - includeOther: true', '  - answer: DEFERRED-UNTIL: Which preservation contract?', '',
    ].join('\n');
    const file = goalFile(document);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const priorRunId = process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_RUN_ID;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path, runId: 'run-canary', selfAnswerPath: 'say-first',
        selfResolveClarification: (context) => defaultGoalAuthorSelfResolve(context, {
          stream: async () => '{"answer":null}',
        }),
        dispatch: async () => { throw new Error('should not ask a human'); },
      });
      expect(result).toMatchObject({ outcome: 'skipped', unanswered: 0, answeredBy: 'agent' });
      const updated = readFileSync(file.path, 'utf8');
      expect(updated).toContain('  - provenance.source: default');
      expect(updated).toContain('기존 공개 동작');
      expect(updated).toContain('goal-author-clarification.ts: selfAnswerGoalDocumentClarifications');
      expect(updated).toContain('goal-clarification-escalation.ts: escalateGoalDocumentClarifications');
      expect(updated).not.toContain('Answer: UNANSWERED — preservation_contract');
      // Exactly one default event, and the goal file the implementation stage reads carries no unanswered question.
      expect(log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'self-answer-default-applied'))
        .toEqual([['goal-author', 'self-answer-default-applied', {
          runId: 'run-canary', questionId: 'preservation_contract', exportCount: expect.any(Number),
        }]]);
      expect(parseGoalDocumentClarifications(updated).filter((item) => !item.answered)).toHaveLength(0);
      // observeGoalAuthor mirrors each goal-author event once into harness.author: across every debug.log call
      // the default is recorded exactly once per category, never more.
      expect(log.mock.calls.filter(([, event]) => event === 'self-answer-default-applied').map(([category]) => category))
        .toEqual(['goal-author', 'harness.author']);
    } finally {
      if (priorRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = priorRunId;
      log.mockRestore();
      file.clean();
    }
  });

  test('attempts self-answer before missing-delivery-resolver fallback in rework', async () => {
    const file = goalFile(`${unresolvedGoal}\n  - evidence: src/example.ts: grounded`);
    const sequence: string[] = [];
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        selfAnswerPath: 'rework',
        selfResolveClarification: async ({ evidence }) => {
          sequence.push('self-answer');
          return { answer: 'Telegram', evidence };
        },
        dispatch: async () => {
          sequence.push('dispatch');
          return { output: 'requires a HITL resolver, but none is installed in this surface', absenceReason: 'no-delivery-resolver' };
        },
        fallback: () => { sequence.push('fallback'); },
        pendingQuestionPersistence: pendingPersistenceStub(),
      });
      expect(sequence).toEqual(['self-answer']);
      expect(result.outcome).toBe('skipped');
      expect(readFileSync(file.path, 'utf8')).toContain('  - answer: Telegram');
    } finally { file.clean(); }
  });
  test('partial self-answer only dispatches and falls back for the remaining question', async () => {
    const second = unresolvedGoal.replaceAll('delivery_scope', 'delivery_other')
      .replaceAll('Which human surface should receive this?', 'Which other surface should receive this?');
    const file = goalFile(`${unresolvedGoal}\n${second}\n  - evidence: src/example.ts: grounded`);
    const dispatched: string[][] = [];
    const fallback: string[] = [];
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path, selfAnswerPath: 'ask',
        selfResolveClarification: async ({ questionId, evidence }) => questionId === 'delivery_scope'
          ? { answer: 'Telegram', evidence } : {},
        dispatch: async ({ questions }) => {
          dispatched.push((questions as Array<{ id: string }>).map(({ id }) => id));
          return { output: 'requires a HITL resolver, but none is installed in this surface', absenceReason: 'no-delivery-resolver' };
        },
        fallback: (message) => { fallback.push(message); },
        pendingQuestionPersistence: pendingPersistenceStub(),
      });
      expect(dispatched).toEqual([['delivery_other']]);
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toContain('Which other surface');
      expect(result).toMatchObject({ unanswered: 1, answeredBy: 'agent', outcome: 'fallback' });
      const updated = readFileSync(file.path, 'utf8');
      expect(updated).toContain('  - answer: Telegram');
      expect(updated).toContain('  - answer: DEFERRED-UNTIL: Which other surface should receive this?');
    } finally { file.clean(); }
  });

  test('defers fallback until after self-answer abstains', async () => {
    const file = goalFile(`${unresolvedGoal}\n  - evidence: src/example.ts: grounded`);
    const order: string[] = [];
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path, selfAnswerPath: 'rework',
        selfResolveClarification: async () => { order.push('self-answer'); return {}; },
        dispatch: async () => {
          order.push('dispatch');
          return { output: 'requires a HITL resolver, but none is installed in this surface', absenceReason: 'no-delivery-resolver' };
        },
        fallback: () => { order.push('fallback'); },
        pendingQuestionPersistence: pendingPersistenceStub(),
      });
      expect(order).toEqual(['self-answer', 'dispatch', 'fallback']);
      expect(result.outcome).toBe('fallback');
      expect(readFileSync(file.path, 'utf8')).toContain('  - answer: DEFERRED-UNTIL: Which human surface should receive this?');
    } finally { file.clean(); }
  });

  test('keeps an unmarked resolver compatible and infers a returned answer as human', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let request: Record<string, unknown> | undefined;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async (value) => {
          request = value;
          return { output: '{"answers":{"delivery_scope":"Telegram"}}', result: { answers: { delivery_scope: 'Telegram' } } };
        },
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'delivered', answeredBy: 'human' });
      expect(request).toMatchObject({
        questions: [{ id: 'delivery_scope', header: 'Delivery', includeOther: true }],
      });
      expect(request).not.toHaveProperty('delivery');
      expect(events).toContainEqual(expect.objectContaining({
        category: GOAL_CLARIFICATION_ESCALATION_CATEGORY,
        event: 'delivered',
        data: expect.objectContaining({
          delivery: 'modal',
          deliverySource: 'none',
          unanswered: 1,
          answeredBy: 'human',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('delivers duplicate question IDs with unique transport IDs and injects each returned answer', async () => {
    const duplicateQuestionIdGoal = `${unresolvedGoal}\n- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: DEFERRED-UNTIL: Which duplicate surface should receive this?\n`;
    const file = goalFile(duplicateQuestionIdGoal);
    try {
      let request: Record<string, unknown> | undefined;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async (value) => {
          request = value;
          return {
            output: '{}',
            result: { answers: { delivery_scope__clarification_1: 'Telegram', delivery_scope__clarification_2: 'Discord' } },
          };
        },
      });

      expect(result).toEqual({ unanswered: 2, escalated: 2, delivery: 'modal', outcome: 'delivered', answeredBy: 'human' });
      expect(request).toMatchObject({
        questions: [
          { id: 'delivery_scope__clarification_1' },
          { id: 'delivery_scope__clarification_2' },
        ],
      });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('- Clarification:\n  - id: delivery_scope\n  - header: Delivery\n  - question: Which human surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n    - label: Discord\n      description: Send the question to the Discord operator.\n  - includeOther: true\n  - answer: Telegram');
      expect(persisted).toContain('- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: Discord');
    } finally {
      file.clean();
    }
  });

  test('keeps a duplicate delivery ID and injects only its matching block after the first occurrence is answered', async () => {
    const partiallyAnsweredGoal = unresolvedGoal.replace('DEFERRED-UNTIL: Which human surface should receive this?', 'Telegram')
      + unresolvedGoal.replace('  - header: Delivery', '  - header: Duplicate delivery')
        .replace('Which human surface should receive this?', 'Which duplicate surface should receive this?');
    const file = goalFile(partiallyAnsweredGoal);
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async (request) => {
          expect(request.questions).toEqual([expect.objectContaining({ id: 'delivery_scope__clarification_2' })]);
          return { output: '{}', result: { answers: { delivery_scope__clarification_2: 'Discord' } } };
        },
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'delivered', answeredBy: 'human' });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('  - header: Delivery\n  - question: Which human surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n    - label: Discord\n      description: Send the question to the Discord operator.\n  - includeOther: true\n  - answer: Telegram');
      expect(persisted).toContain('  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n    - label: Discord\n      description: Send the question to the Discord operator.\n  - includeOther: true\n  - answer: Discord');
    } finally {
      file.clean();
    }
  });

  test('injects duplicate answers into their matching blocks when the first free-form answer is multiline', async () => {
    const duplicateQuestionIdGoal = `${unresolvedGoal}\n- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: DEFERRED-UNTIL: Which duplicate surface should receive this?\n\nPreserved tail.`;
    const file = goalFile(duplicateQuestionIdGoal);
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({
          output: '{}',
          result: {
            answers: { delivery_scope__clarification_1: 'Other', delivery_scope__clarification_2: 'Discord' },
            otherText: { delivery_scope__clarification_1: 'First line\nSecond line' },
          },
        }),
      });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('- Clarification:\n  - id: delivery_scope\n  - header: Delivery\n  - question: Which human surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n    - label: Discord\n      description: Send the question to the Discord operator.\n  - includeOther: true\n  - answer: First line\n    Second line');
      expect(persisted).toContain('- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: Discord');
      expect(persisted).toContain('Preserved tail.');
    } finally {
      file.clean();
    }
  });

  test('observes handled question IDs as an ordered, deduplicated string array', async () => {
    const duplicateQuestionIdGoal = `${unresolvedGoal}\n- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: DEFERRED-UNTIL: Which duplicate surface should receive this?\n`;
    const file = goalFile(duplicateQuestionIdGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{}', result: { answers: {}, cancelled: true } }),
      });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'no-response',
        data: expect.objectContaining({ questionIds: ['delivery_scope'] }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('observes every handled question ID for a multi-question escalation', async () => {
    const multipleQuestionGoal = `${unresolvedGoal}\n- Clarification:\n  - id: execution_scope\n  - header: Scope\n  - question: Which scope should this run cover?\n  - options:\n    - label: Targeted\n      description: Cover the named files only.\n  - answer: DEFERRED-UNTIL: Which scope should this run cover?\n`;
    const file = goalFile(multipleQuestionGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{}', result: { answers: {}, cancelled: true } }),
      });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'no-response',
        data: expect.objectContaining({ questionIds: ['delivery_scope', 'execution_scope'] }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('observes an empty question ID array when no clarification is unanswered', async () => {
    const file = goalFile(unresolvedGoal.replace('DEFERRED-UNTIL: Which human surface should receive this?', 'Telegram'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await escalateGoalDocumentClarifications({ goalFile: file.path });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'skipped',
        data: expect.objectContaining({ questionIds: [] }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('writes dispatched answers to the goal file and observes the written count', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{}', result: { answers: { delivery_scope: 'Telegram' } } }),
      });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('  - answer: Telegram');
      expect(persisted).not.toContain('  - answer: DEFERRED-UNTIL: Which human surface should receive this?');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({ answersWritten: 1 }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('writes non-empty free-form text instead of the selected label when Other is allowed', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({
          output: '{}',
          result: {
            answers: { delivery_scope: 'Telegram' },
            otherText: { delivery_scope: 'Use src/self-implement/goal-clarification-escalation.test.ts.' },
          },
        }),
      });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('  - answer: Use src/self-implement/goal-clarification-escalation.test.ts.');
      expect(persisted).not.toContain('  - answer: Telegram');
    } finally {
      file.clean();
    }
  });

  test('uses the selected label when Other is not allowed', async () => {
    const file = goalFile(unresolvedGoal.replace('includeOther: true', 'includeOther: false').replace('label: Telegram', 'label: 0'));
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({
          output: '{}',
          result: {
            answers: { delivery_scope: '0' },
            otherText: { delivery_scope: 'Do not write this free-form answer.' },
          },
        }),
      });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('  - answer: 0');
      expect(persisted).not.toContain('Do not write this free-form answer.');
    } finally {
      file.clean();
    }
  });

  test('uses the selected label when Other text is blank or absent', async () => {
    for (const otherText of [{ delivery_scope: '' }, undefined]) {
      const file = goalFile(unresolvedGoal);
      try {
        await escalateGoalDocumentClarifications({
          goalFile: file.path,
          dispatch: async () => ({
            output: '{}',
            result: { answers: { delivery_scope: 'Telegram' }, ...(otherText === undefined ? {} : { otherText }) },
          }),
        });
        const persisted = readFileSync(file.path, 'utf8');
        expect(persisted).toContain('  - answer: Telegram');
        expect(persisted).not.toContain('DEFERRED-UNTIL: Which human surface should receive this?');
      } finally {
        file.clean();
      }
    }
  });

  test('does not write the goal file when dispatch returns no answers', async () => {
    const file = goalFile(unresolvedGoal);
    const before = readFileSync(file.path, 'utf8');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{}', result: { answers: {} } }),
      });
      expect(readFileSync(file.path, 'utf8')).toBe(before);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({ answersWritten: 0 }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('leaves deferred answer in place when dispatch returns a blank answer', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{}', result: { answers: { delivery_scope: '   ' } } }),
      });
      expect(readFileSync(file.path, 'utf8')).toContain('  - answer: DEFERRED-UNTIL: Which human surface should receive this?');
    } finally {
      file.clean();
    }
  });

  test('forwards caller-provided delivery unchanged and observes its source', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let request: Record<string, unknown> | undefined;
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async (value) => {
          request = value;
          return { output: '{}', result: { answers: {} } };
        },
      });
      expect(request).toMatchObject({ delivery: 'telegram' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({
          delivery: 'telegram',
          deliverySource: 'input',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('keeps omitted and caller-provided delivery requests and observations distinct', async () => {
    const file = goalFile(unresolvedGoal);
    const requests: Record<string, unknown>[] = [];
    const deliverySources: unknown[] = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      if (event === 'delivered') deliverySources.push((data as Record<string, unknown>).deliverySource);
    }) as typeof debug.log;
    try {
      const dispatch = async (request: Record<string, unknown>) => {
        requests.push(request);
        return { output: '{}', result: { answers: {} } };
      };
      await escalateGoalDocumentClarifications({ goalFile: file.path, dispatch });
      await escalateGoalDocumentClarifications({ goalFile: file.path, delivery: 'telegram', dispatch });

      expect(requests[0]).not.toHaveProperty('delivery');
      expect(requests[1]).toMatchObject({ delivery: 'telegram' });
      expect(requests[0]?.delivery).not.toBe(requests[1]?.delivery);
      expect(deliverySources).toEqual(['none', 'input']);
      expect(deliverySources[0]).not.toBe(deliverySources[1]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('prefers resolved origin delivery and observes its source', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let request: Record<string, unknown> | undefined;
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatchContext: { sessionId: 'origin-session' },
        resolveOriginDelivery: (sessionId) => {
          expect(sessionId).toBe('origin-session');
          return 'terminal';
        },
        dispatch: async (value) => {
          request = value;
          return { output: '{}', result: { answers: {} } };
        },
      });
      expect(request).toMatchObject({ delivery: 'terminal' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({ deliverySource: 'origin' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('falls back to input delivery when origin resolution is undefined or throws', async () => {
    for (const resolveOriginDelivery of [
      () => undefined,
      () => { throw new Error('origin resolver unavailable'); },
    ]) {
      const file = goalFile(unresolvedGoal);
      try {
        let request: Record<string, unknown> | undefined;
        await escalateGoalDocumentClarifications({
          goalFile: file.path,
          delivery: 'telegram',
          dispatchContext: { sessionId: 'origin-session' },
          resolveOriginDelivery,
          dispatch: async (value) => {
            request = value;
            return { output: '{}', result: { answers: {} } };
          },
        });
        expect(request).toMatchObject({ delivery: 'telegram' });
      } finally {
        file.clean();
      }
    }
  });

  test('does not resolve origin delivery without a session id', async () => {
    const file = goalFile(unresolvedGoal);
    let originCalls = 0;
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        resolveOriginDelivery: () => {
          originCalls += 1;
          return 'terminal';
        },
        dispatch: async () => ({ output: '{}', result: { answers: {} } }),
      });
      expect(originCalls).toBe(0);
    } finally {
      file.clean();
    }
  });

  test('records an internal resolvedDelivery as omitted, not caller provenance', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let request: Record<string, unknown> | undefined;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        // Internal orchestrator-chosen delivery; the caller never provided `delivery`.
        resolvedDelivery: 'file',
        dispatch: async (value) => {
          request = value;
          return { output: '{}', result: { answers: {} } };
        },
      });
      expect(request).not.toHaveProperty('delivery');
      expect(result).toMatchObject({ delivery: 'file' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({
          delivery: 'file',
          deliverySource: 'none',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('forwards dispatch context unchanged to every AskUserQuestion dispatch', async () => {
    const file = goalFile(unresolvedGoal);
    const dispatchContext = { sessionId: 'elanous-session-parent', signal: new AbortController().signal };
    try {
      let receivedContext: typeof dispatchContext | undefined;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatchContext,
        dispatch: async (_request, context) => {
          receivedContext = context as typeof dispatchContext | undefined;
          return { output: '{}', result: { answers: {} } };
        },
      });
      expect(result).toMatchObject({ outcome: 'delivered', answeredBy: 'none' });
      expect(receivedContext).toBe(dispatchContext);
      expect(receivedContext?.sessionId).toBe('elanous-session-parent');
    } finally {
      file.clean();
    }
  });

  test('preserves agent provenance in the escalation result and observation', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{"answers":{"delivery_scope":"Telegram"},"answeredBy":"agent"}', result: { answers: { delivery_scope: 'Telegram' }, answeredBy: 'agent' } }),
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'delivered', answeredBy: 'agent' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({ answeredBy: 'agent' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('preserves explicit human provenance in the escalation result and observation', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{"answers":{"delivery_scope":"Telegram"},"answeredBy":"human"}', result: { answers: { delivery_scope: 'Telegram' }, answeredBy: 'human' } }),
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'delivered', answeredBy: 'human' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'delivered',
        data: expect.objectContaining({ answeredBy: 'human' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('applies a stored pending answer before delivery and observes its exclusion', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let reads = 0;
      let dispatched = false;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => {
          dispatched = true;
          return { output: '{}', result: { answers: {} } };
        },
        pendingQuestionPersistence: {
          ...pendingPersistenceStub(),
          readAnswer: (id) => {
            reads += 1;
            expect(id).toBe(`goal-clarification:${file.path}:delivery_scope`);
            return { ok: true as const, answer: { id, result: { answers: { delivery_scope: 'Telegram' } } } };
          },
        },
      });
      expect(reads).toBe(1);
      expect(dispatched).toBe(false);
      expect(result).toEqual({ unanswered: 0, escalated: 0, delivery: 'modal', outcome: 'skipped', answeredBy: 'human' });
      expect(readFileSync(file.path, 'utf8')).toContain('  - answer: Telegram');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'answered-from-store',
        data: expect.objectContaining({ questionId: 'delivery_scope', applied: 1, answersWritten: 1 }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('continues delivery when an injected store omits its reader, has no answer, or its reader throws', async () => {
    for (const readAnswer of [
      undefined,
      () => ({ ok: true as const, answer: null }),
      () => { throw new Error('pending store unavailable'); },
    ]) {
      const file = goalFile(unresolvedGoal);
      try {
        let dispatched = false;
        const result = await escalateGoalDocumentClarifications({
          goalFile: file.path,
          dispatch: async (request) => {
            dispatched = true;
            expect(request.questions).toEqual([expect.objectContaining({ id: 'delivery_scope' })]);
            return { output: '{}', result: { answers: {} } };
          },
          pendingQuestionPersistence: { ...pendingPersistenceStub(), readAnswer },
        });
        expect(dispatched).toBe(true);
        expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'delivered', answeredBy: 'none' });
        expect(readFileSync(file.path, 'utf8')).toContain('  - answer: DEFERRED-UNTIL: Which human surface should receive this?');
      } finally {
        file.clean();
      }
    }
  });

  test('records a skip rather than dispatching when every clarification was answered', async () => {
    const file = goalFile(unresolvedGoal.replace('DEFERRED-UNTIL: Which human surface should receive this?', 'Telegram'));
    try {
      let dispatched = false;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => {
          dispatched = true;
          return { output: '{}', result: { answers: {} } };
        },
      });
      expect(result).toEqual({ unanswered: 0, escalated: 0, delivery: 'modal', outcome: 'skipped', answeredBy: 'none' });
      expect(dispatched).toBe(false);
    } finally {
      file.clean();
    }
  });

  test('stamps a non-blocking terminal fallback when a non-TUI delivery has no resolver', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const surfaced: string[] = [];
      const pending: ReturnType<typeof createPendingQuestion>[] = [];
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => ({ output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface." }),
        fallback: (message) => surfaced.push(message),
        pendingQuestionPersistence: { create: createPendingQuestion, write: (question) => { pending.push(question); } },
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'telegram', outcome: 'fallback', answeredBy: 'none', fallbackSurface: 'terminal' });
      expect(surfaced).toEqual([expect.stringContaining('Which human surface should receive this?')]);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: `goal-clarification:${file.path}:delivery_scope`, questions: [{ id: 'delivery_scope' }] });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'fallback',
        data: expect.objectContaining({ delivery: 'telegram', fallbackSurface: 'terminal', answeredBySoFar: 'none', reason: 'missing-delivery-resolver', pendingWritten: 1 }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('writes duplicate clarification fallback records with their unique delivery IDs', async () => {
    const duplicateQuestionIdGoal = `${unresolvedGoal}\n- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: DEFERRED-UNTIL: Which duplicate surface should receive this?\n`;
    const file = goalFile(duplicateQuestionIdGoal);
    try {
      const pending: ReturnType<typeof createPendingQuestion>[] = [];
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => ({ output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface." }),
        fallback: () => {},
        pendingQuestionPersistence: { create: createPendingQuestion, write: (question) => { pending.push(question); } },
      });

      expect(result).toMatchObject({ outcome: 'fallback', escalated: 2 });
      expect(pending).toEqual([
        expect.objectContaining({ id: `goal-clarification:${file.path}:delivery_scope__clarification_1`, questions: [expect.objectContaining({ id: 'delivery_scope__clarification_1' })] }),
        expect.objectContaining({ id: `goal-clarification:${file.path}:delivery_scope__clarification_2`, questions: [expect.objectContaining({ id: 'delivery_scope__clarification_2' })] }),
      ]);
    } finally {
      file.clean();
    }
  });

  test('reads sequential fallback answers with stable duplicate delivery IDs across executions', async () => {
    const duplicateQuestionIdGoal = `${unresolvedGoal}\n- Clarification:\n  - id: delivery_scope\n  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: DEFERRED-UNTIL: Which duplicate surface should receive this?\n`;
    const file = goalFile(duplicateQuestionIdGoal);
    const answers = new Map<string, { id: string; result: AskUserQuestionResult }>();
    const readAnswer = (id: string) => ({ ok: true as const, answer: answers.get(id) ?? null });
    try {
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => ({ output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface." }),
        fallback: () => {},
        pendingQuestionPersistence: { ...pendingPersistenceStub(), readAnswer },
      });
      const firstId = `goal-clarification:${file.path}:delivery_scope__clarification_1`;
      const secondId = `goal-clarification:${file.path}:delivery_scope__clarification_2`;
      answers.set(firstId, { id: firstId, result: { answers: { delivery_scope__clarification_1: 'Telegram' } } });
      await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async (request) => {
          expect(request.questions).toEqual([expect.objectContaining({ id: 'delivery_scope__clarification_2' })]);
          return { output: '{}', result: { answers: {} } };
        },
        pendingQuestionPersistence: { ...pendingPersistenceStub(), readAnswer },
      });
      answers.set(secondId, { id: secondId, result: { answers: { delivery_scope__clarification_2: 'Discord' } } });
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => {
          throw new Error('both pending answers should be consumed before dispatch');
        },
        pendingQuestionPersistence: { ...pendingPersistenceStub(), readAnswer },
      });
      expect(result).toEqual({ unanswered: 0, escalated: 0, delivery: 'modal', outcome: 'skipped', answeredBy: 'human' });
      const persisted = readFileSync(file.path, 'utf8');
      expect(persisted).toContain('  - header: Delivery\n  - question: Which human surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n    - label: Discord\n      description: Send the question to the Discord operator.\n  - includeOther: true\n  - answer: Telegram');
      expect(persisted).toContain('  - header: Duplicate delivery\n  - question: Which duplicate surface should receive this?\n  - options:\n    - label: Telegram\n      description: Send the question to the Telegram operator.\n  - answer: Discord');
    } finally {
      file.clean();
    }
  });

  test('round-trips fallback pending records through the real isolated store', async () => {
    const file = goalFile(unresolvedGoal);
    const root = mkdtempSync(join(tmpdir(), 'goal-clarification-pending-store-'));
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => ({
          output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface.",
        }),
        fallback: () => {},
        pendingQuestionPersistence: {
          create: createPendingQuestion,
          write: (question) => writePendingQuestion(question, { root: () => root }),
        },
      });
      const records = readPendingQuestions({ root: () => root });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'telegram', outcome: 'fallback', answeredBy: 'none', fallbackSurface: 'terminal' });
      expect(records).toEqual(expect.objectContaining({ ok: true }));
      if (!records.ok) throw new Error(records.error);
      expect(records.questions).toEqual([expect.objectContaining({
        id: `goal-clarification:${file.path}:delivery_scope`,
        questions: [expect.objectContaining({ id: 'delivery_scope', question: 'Which human surface should receive this?' })],
      })]);
    } finally {
      file.clean();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not create pending questions after successful delivery', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      let writes = 0;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{}', result: { answers: {} } }),
        pendingQuestionPersistence: { create: createPendingQuestion, write: () => { writes += 1; } },
      });
      expect(result).toMatchObject({ outcome: 'delivered', escalated: 1 });
      expect(writes).toBe(0);
    } finally {
      file.clean();
    }
  });

  test('continues fallback batches when pending persistence throws', async () => {
    const file = goalFile([
      unresolvedGoal,
      unresolvedGoal.replaceAll('delivery_scope', 'second'),
      unresolvedGoal.replaceAll('delivery_scope', 'third'),
      unresolvedGoal.replaceAll('delivery_scope', 'fourth'),
    ].join('\n'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let dispatches = 0;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => {
          dispatches += 1;
          return { output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface." };
        },
        fallback: () => {},
        pendingQuestionPersistence: { create: createPendingQuestion, write: () => { throw new Error('disk unavailable'); } },
      });
      expect(result).toEqual({ unanswered: 4, escalated: 4, delivery: 'telegram', outcome: 'fallback', answeredBy: 'none', fallbackSurface: 'terminal' });
      expect(dispatches).toBe(2);
      expect(events.filter(({ event }) => event === 'fallback').map(({ data }) => data.pendingWritten)).toEqual([0, 0]);
      expect(events.filter(({ event }) => event === 'fallback').map(({ data }) => data.pendingWriteFailed)).toEqual([3, 1]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('falls back non-blockingly for the structured ACP no-capable-peer reason', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      const surfaced: string[] = [];
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => ({
          output: 'AskUserQuestion failed (resolver): no elanous/ask cap-able peer attached to session elanous-session-6tidkn',
          absenceReason: 'no-capable-peer',
        }),
        fallback: (message) => surfaced.push(message),
        pendingQuestionPersistence: pendingPersistenceStub(),
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'telegram', outcome: 'fallback', answeredBy: 'none', fallbackSurface: 'terminal' });
      expect(surfaced).toHaveLength(1);
    } finally {
      file.clean();
    }
  });

  test('falls back and records a pending question when neither TUI deps nor a resolver are available', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      const surfaced: string[] = [];
      const pending: ReturnType<typeof createPendingQuestion>[] = [];
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({
          output: 'AskUserQuestion failed: no TUI dependencies or resolver available',
          absenceReason: 'no-tui-deps-no-resolver',
        }),
        fallback: (message) => surfaced.push(message),
        pendingQuestionPersistence: { create: createPendingQuestion, write: (question) => { pending.push(question); } },
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'fallback', answeredBy: 'none', fallbackSurface: 'terminal' });
      expect(surfaced).toEqual([expect.stringContaining('Which human surface should receive this?')]);
      expect(pending).toEqual([expect.objectContaining({
        id: `goal-clarification:${file.path}:delivery_scope`,
        questions: [expect.objectContaining({ id: 'delivery_scope' })],
      })]);
    } finally {
      file.clean();
    }
  });

  test('does not swallow a real resolver failure as an absence fallback', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      let fallbackCalled = false;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: 'AskUserQuestion failed (resolver): delivery transport broke' }),
        fallback: () => { fallbackCalled = true; },
      });
      expect(result).toMatchObject({ unanswered: 1, escalated: 0, outcome: 'failed' });
      expect(fallbackCalled).toBe(false);
    } finally {
      file.clean();
    }
  });

  test('records no-response separately from missing-resolver fallback when an installed resolver is unanswered', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => ({ output: '{"answers":{},"cancelled":true}', result: { answers: {}, cancelled: true } }),
      });
      expect(result).toEqual({ unanswered: 1, escalated: 1, delivery: 'modal', outcome: 'no-response', answeredBy: 'none' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'no-response',
        data: expect.objectContaining({
          delivery: 'modal',
          deliverySource: 'none',
          unanswered: 1,
          escalated: 1,
          answeredBy: 'none',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('records a failed delivery instead of treating an unavailable HitlDelivery as success', async () => {
    const file = goalFile(unresolvedGoal);
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'discord',
        dispatch: async () => ({ output: "AskUserQuestion failed: delivery='discord' requires a HITL resolver" }),
      });
      // ⛔ 전달되지 않은 질문은 escalated 에 세지 않는다. 이 기대가 1 이던 것이 결함이었다 —
      //    「사람에게 도달한 수」가 「보내려고 시도한 수」를 뜻하게 되어 있었다.
      expect(result).toMatchObject({ unanswered: 1, escalated: 0, delivery: 'discord', outcome: 'failed' });
    } finally {
      file.clean();
    }
  });

  test('counts only the batches whose delivery was confirmed when a later batch fails', async () => {
    const file = goalFile([
      unresolvedGoal,
      unresolvedGoal.replaceAll('delivery_scope', 'second'),
      unresolvedGoal.replaceAll('delivery_scope', 'third'),
      unresolvedGoal.replaceAll('delivery_scope', 'fourth'),
    ].join('\n'));
    try {
      let call = 0;
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => {
          call += 1;
          return call === 1
            ? { output: '{}', result: { answers: {} } }
            : { output: 'AskUserQuestion failed: no resolver' };
        },
      });
      // 첫 배치 3건만 도달했고 둘째 배치는 실패했다 ⇒ 4 도 0 도 아닌 3 이다.
      expect(result).toMatchObject({ unanswered: 4, escalated: 3, outcome: 'failed' });
    } finally {
      file.clean();
    }
  });

  test('delivers every unanswered clarification in explicit AskUserQuestion-sized batches', async () => {
    const file = goalFile([unresolvedGoal, unresolvedGoal.replaceAll('delivery_scope', 'second'), unresolvedGoal.replaceAll('delivery_scope', 'third'), unresolvedGoal.replaceAll('delivery_scope', 'fourth')].join('\n'));
    try {
      const batches: string[][] = [];
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async (request) => {
          batches.push((request.questions as Array<{ id: string }>).map((question) => question.id));
          return { output: '{}', result: { answers: {} } };
        },
      });
      expect(result).toEqual({ unanswered: 4, escalated: 4, delivery: 'modal', outcome: 'delivered', answeredBy: 'none' });
      expect(batches).toEqual([['delivery_scope', 'second', 'third'], ['fourth']]);
    } finally {
      file.clean();
    }
  });

  // ⛔⭐ 리뷰 R6 이 「잘못된 동작을 고정한 테스트」로 짚은 자리 —
  //    명시 agent 뒤에 «표시 없는» 답이 오면 그건 «다른 출처»이므로 mixed 다.
  //    레포 안 리졸버는 이제 전부 명시하므로, 표시 없음은 legacy/외부 = 사람 경로로 읽는다.
  test('명시값 뒤에 «표시 없는» 답이 오면 — human 이면 human, agent 면 mixed (순서 무관)', async () => {
    for (const provenance of ['human', 'agent'] as const) {
      const file = goalFile([
        unresolvedGoal,
        unresolvedGoal.replaceAll('delivery_scope', 'second'),
        unresolvedGoal.replaceAll('delivery_scope', 'third'),
        unresolvedGoal.replaceAll('delivery_scope', 'fourth'),
      ].join('\n'));
      try {
        let call = 0;
        const result = await escalateGoalDocumentClarifications({
          goalFile: file.path,
          dispatch: async (request) => {
            call += 1;
            const answers = Object.fromEntries(
              (request.questions as Array<{ id: string }>).map((question) => [question.id, 'Telegram']),
            );
            return call === 1
              ? { output: JSON.stringify({ answers, answeredBy: provenance }), result: { answers, answeredBy: provenance } }
              : { output: JSON.stringify({ answers }), result: { answers } };
          },
        });
        // ⭐ human ⊕ 표시없음(=human) → human · agent ⊕ 표시없음(=human) → mixed
        expect(result).toEqual({
          unanswered: 4, escalated: 4, delivery: 'modal', outcome: 'delivered',
          answeredBy: provenance === 'human' ? 'human' : 'mixed',
        });
      } finally {
        file.clean();
      }
    }
  });

  test('records a structured failure when dispatch throws', async () => {
    const file = goalFile(unresolvedGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        dispatch: async () => { throw new Error('delivery transport broke'); },
      });
      expect(result).toMatchObject({ unanswered: 1, escalated: 0, outcome: 'failed', error: 'delivery transport broke' });
      expect(events).toContainEqual(expect.objectContaining({ event: 'failed', data: expect.objectContaining({ stage: 'dispatch' }) }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });
});

// ⛔ 무인 리뷰 should-fix — 「여러 배치에서 서로 다른 provenance 가 오면?」의 «현재 동작»을 고정한다.
//    ⚠️ 이것이 «옳은 규칙인지»는 이 테스트가 답하지 않는다 — 조인해서 쓰는 쪽의 결정이다(#5730).
describe('answeredBy 집계 — 배치가 여럿일 때', () => {
  const twoBatchGoal = [
    'Goal',
    ...Array.from({ length: 4 }, (_, i) => [
      '- Clarification:',
      `  - id: q${i}`,
      `  - header: H${i}`,
      `  - question: Q${i}?`,
      '  - options:',
      '    - label: A',
      '      description: a',
      '    - label: B',
      '      description: b',
      `  - answer: DEFERRED-UNTIL: Q${i}?`,
    ]).flat(),
    '',
  ].join('\n');

  test('⭐ agent 다음 human 이면 «mixed» — 앞 배치를 덮지 않는다', async () => {
    const file = goalFile(twoBatchGoal);
    let call = 0;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => {
          call += 1;
          return {
            output: 'ok',
            result: { answers: { a: 'A' }, answeredBy: call === 1 ? 'agent' as const : 'human' as const },
          };
        },
      });
      expect(call).toBe(2);                    // 4문항 ÷ 배치 3 = 2회
      expect(result.answeredBy).toBe('mixed'); // ⭐ 둘 다 있었다는 사실이 «살아 있다»
    } finally { file.clean(); }
  });

  test('human 다음 agent 도 «mixed» — 순서가 결과를 바꾸지 «않는다»', async () => {
    const file = goalFile(twoBatchGoal);
    let call = 0;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => {
          call += 1;
          return {
            output: 'ok',
            result: { answers: { a: 'A' }, answeredBy: call === 1 ? 'human' as const : 'agent' as const },
          };
        },
      });
      expect(result.answeredBy).toBe('mixed');
    } finally { file.clean(); }
  });
});

// ⛔⭐⭐⭐ 무인 리뷰 R2 must-fix — 「부분 성공 뒤 실패」에서 «누가 답했는지»가 거짓이 되던 자리.
//    앞 배치가 답했는데 뒤 배치가 취소·실패·폴백이면 answeredBy 를 'none' 으로 «하드코딩»했다.
describe('answeredBy — 부분 성공 뒤 실패·취소·폴백', () => {
  const twoBatchGoal = [
    'Goal',
    ...Array.from({ length: 4 }, (_, i) => [
      '- Clarification:',
      `  - id: q${i}`,
      `  - header: H${i}`,
      `  - question: Q${i}?`,
      '  - options:',
      '    - label: A',
      '      description: a',
      '    - label: B',
      '      description: b',
      `  - answer: DEFERRED-UNTIL: Q${i}?`,
    ]).flat(),
    '',
  ].join('\n');

  test('⭐ 첫 배치가 답했고 둘째가 «취소»면 answeredBy 가 살아 있다', async () => {
    const file = goalFile(twoBatchGoal);
    let call = 0;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async (): Promise<AskUserQuestionDispatchResult> => {
          call += 1;
          return call === 1
            ? { output: 'ok', result: { answers: { a: 'A' }, answeredBy: 'agent' } }
            : { output: 'cancelled', result: { answers: {}, cancelled: true } };
        },
      });
      expect(result.outcome).toBe('no-response');
      expect(result.answeredBy).toBe('agent');   // ⛔ 'none' 이면 「아무도 안 답했다」는 거짓이다
    } finally { file.clean(); }
  });

  test('⭐ 첫 배치가 답했고 둘째가 «던지면» answeredBy 가 살아 있다', async () => {
    const file = goalFile(twoBatchGoal);
    let call = 0;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => {
          call += 1;
          if (call === 1) return { output: 'ok', result: { answers: { a: 'A' }, answeredBy: 'human' as const } };
          throw new Error('boom');
        },
      });
      expect(result.outcome).toBe('failed');
      expect(result.answeredBy).toBe('human');
    } finally { file.clean(); }
  });

  test('⭐ 첫 배치가 답했고 둘째가 «리졸버 부재 폴백»이면 answeredBy 가 살아 있다', async () => {
    const file = goalFile(twoBatchGoal);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    let call = 0;
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        fallback: () => {},
        pendingQuestionPersistence: pendingPersistenceStub(),
        dispatch: async () => {
          call += 1;
          return call === 1
            ? { output: 'ok', result: { answers: { a: 'A' }, answeredBy: 'agent' as const } }
            : { output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface." };
        },
      });
      expect(result.outcome).toBe('fallback');
      expect(result.answeredBy).toBe('agent');
      // ⛔ «중간 로그»도 최종 결과와 모순되면 안 된다 — R3 이 잡은 자리다.
      const fb = events.find((e) => e.event === 'fallback');
      // ⭐ 중간 로그는 「그 배치까지의 값」이라 이름이 다르다 — 최종과 «다른 것»이지 모순이 아니다.
      expect(fb?.data.answeredBySoFar).toBe('agent');
      expect(fb?.data.answeredBy).toBeUndefined();
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      file.clean();
    }
  });

  test('⭐ 취소인데 «부분 답변»이 있으면 human 이다 — none 이 아니다', async () => {
    const file = goalFile(twoBatchGoal);
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: file.path,
        delivery: 'telegram',
        dispatch: async () => ({ output: 'partial', result: { answers: { q0: '0' }, cancelled: true } }),
      });
      expect(result.outcome).toBe('no-response');
      expect(readFileSync(file.path, 'utf8')).toContain('  - answer: A');
      expect(result.answeredBy).toBe('human');   // ⛔ 답이 «있었는데» none 이면 거짓이다
    } finally { file.clean(); }
  });

  // ⭐ should-fix R6 — «역순»도 같은 답이어야 한다. 순서가 결과를 바꾸면 그 값은 못 센다.
  test('«표시 없는» 답이 «먼저» 와도 결과가 같다 — 순서 독립', async () => {
    for (const provenance of ['human', 'agent'] as const) {
      const file = goalFile(twoBatchGoal);
      let call = 0;
      try {
        const result = await escalateGoalDocumentClarifications({
          goalFile: file.path,
          delivery: 'telegram',
          dispatch: async (): Promise<AskUserQuestionDispatchResult> => {
            call += 1;
            return call === 1
              ? { output: 'legacy', result: { answers: { a: 'A' } } }                     // 표시 없음
              : { output: 'ok', result: { answers: { b: 'B' }, answeredBy: provenance } }; // 명시
          },
        });
        expect(result.answeredBy).toBe(provenance === 'human' ? 'human' : 'mixed');
      } finally { file.clean(); }
    }
  });
});

describe('supervisor plan revision persistence', () => {
  const authoredGoal = [
    '# Goal',
    '',
    '## PROBLEM',
    'Original contract remains readable.',
    '',
    '## WHAT TO BUILD',
    'Original contract remains readable.',
    '',
  ].join('\n');

  test('appends contract-conflict records while preserving authored headings and content', () => {
    const first = appendSupervisorPlanRevision(authoredGoal, { round: 1, reason: 'The API shape conflicts with the preservation contract.' });
    const second = appendSupervisorPlanRevision(first, { round: 2, reason: 'The corrected plan still conflicts with the runtime boundary.' });

    expect(second).toContain('## PROBLEM\nOriginal contract remains readable.');
    expect(second).toContain('## WHAT TO BUILD\nOriginal contract remains readable.');
    expect(second.match(/^## .+$/gm)).toEqual(['## PROBLEM', '## WHAT TO BUILD', '## SUPERVISOR PLAN REVISIONS']);
    expect(second).toContain('- verdict: CONTRACT-CONFLICT\n  - round: 1\n  - reason: The API shape conflicts with the preservation contract.');
    expect(second).toContain('- verdict: CONTRACT-CONFLICT\n  - round: 2\n  - reason: The corrected plan still conflicts with the runtime boundary.');
  });

  test('replaces one verified acceptance criterion and audits previous, replacement, reason, and application together', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n`;
    const file = goalFile(document);
    try {
      const result = recordSupervisorPlanRevision(file.path, {
        round: 1,
        reason: 'The runtime API cannot retain the legacy shape.',
        relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-1: Preserve the supported runtime API.' },
      });
      const updated = readFileSync(file.path, 'utf8');
      expect(result).toEqual({ status: 'applied' });
      expect(updated).toContain('- AC-1: Preserve the supported runtime API.');
      expect(updated).toContain('  - previous: - AC-1: Keep the legacy API.');
      expect(updated).toContain('  - replacement: - AC-1: Preserve the supported runtime API.');
      expect(updated).toContain('  - reason: The runtime API cannot retain the legacy shape.');
      expect(updated).toContain('  - application: applied');
      expect(updated).toContain('## PROBLEM\nOriginal contract remains readable.');
    } finally { file.clean(); }
  });

  test('does not guess for missing or ambiguous expected text and records the failed application', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- same\n- same\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- same', expected: '- same', replacement: '- changed' } });
    expect(updated).toContain('- same\n- same');
    expect(updated).toContain('  - application: failed (expected-text-ambiguous)');
    expect(appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- missing', replacement: '- changed' } })).toContain('  - application: failed (expected-text-not-found)');
  });

  test('changes only the uniquely targeted acceptance criterion and rejects problem or audit lookalikes', () => {
    const document = `${authoredGoal}Problem repeats - AC-1: Keep the legacy API.\n\n## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n\n## SUPERVISOR PLAN REVISIONS\n- previous: - AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-1: Preserve the supported runtime API.' } });
    expect(updated).toContain('Problem repeats - AC-1: Keep the legacy API.');
    expect(updated).toContain('  - previous: - AC-1: Keep the legacy API.');
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-1: Preserve the supported runtime API.');
  });

  test('rejects a target that does not identify the expected acceptance criterion', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-2: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-1: Preserve the supported runtime API.' } });
    expect(updated).toContain('- AC-1: Keep the legacy API.');
    expect(updated).toContain('  - application: failed (target-does-not-identify-expected-criterion)');
  });

  test('allows a replacement row with changed wording while preserving authored headings', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-2: Preserve the supported runtime API.' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-2: Preserve the supported runtime API.');
    expect(updated).toContain('  - application: applied');
    expect(updated.match(/^## .+$/gm)).toEqual(['## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## SUPERVISOR PLAN REVISIONS']);
  });

  test('replaces only the exact full-line target among criteria with the same prefix', () => {
    const target = '- Checkable requested criterion: preserve old API';
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- Checkable requested criterion: preserve baseline docs\n${target}\n- Checkable requested criterion: preserve telemetry\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target, expected: target, replacement: '- Checkable requested criterion: preserve runtime API' } });
    const criteriaSection = updated.slice(updated.indexOf('## ACCEPTANCE CRITERIA'), updated.indexOf('## SUPERVISOR PLAN REVISIONS'));
    expect(criteriaSection).toContain('## ACCEPTANCE CRITERIA\n- Checkable requested criterion: preserve baseline docs\n- Checkable requested criterion: preserve runtime API\n- Checkable requested criterion: preserve telemetry\n');
    expect(criteriaSection).not.toContain(`${target}\n`);
    expect(updated).toContain('  - application: applied');
  });

  test('rejects the old prefix target when multiple criteria share that prefix', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- Checkable requested criterion: preserve baseline docs\n- Checkable requested criterion: preserve runtime API\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: 'Checkable requested criterion', expected: '- Checkable requested criterion: preserve runtime API', replacement: '- Checkable requested criterion: preserve implemented runtime API' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- Checkable requested criterion: preserve baseline docs\n- Checkable requested criterion: preserve runtime API\n');
    expect(updated).toContain('  - application: failed (invalid-relaxation-fields)');
  });

  test('rejects an exact full-line target that appears more than once without mutating criteria', () => {
    const target = '- Checkable requested criterion: duplicate row';
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n${target}\n${target}\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target, expected: target, replacement: '- Checkable requested criterion: relaxed duplicate row' } });
    expect(updated).toContain(`${target}\n${target}`);
    expect(updated).toContain('  - application: failed (expected-text-ambiguous)');
  });

  test('rejects a found exact target row when expected text is absent without mutating criteria', () => {
    const target = '- Checkable requested criterion: current runtime row';
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n${target}\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target, expected: '- Checkable requested criterion: missing old row', replacement: '- Checkable requested criterion: relaxed runtime row' } });
    expect(updated).toContain(`## ACCEPTANCE CRITERIA\n${target}\n`);
    expect(updated).toContain('  - application: failed (expected-text-not-found)');
  });

  test('replaces the exact targeted criterion row when an earlier section line contains its expected text', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\nExplanation repeats - AC-1: Keep the legacy API. before the actual criterion.\n- AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-1: Preserve the supported runtime API.' } });
    expect(updated).toContain('Explanation repeats - AC-1: Keep the legacy API. before the actual criterion.');
    expect(updated).toContain('## ACCEPTANCE CRITERIA\nExplanation repeats - AC-1: Keep the legacy API. before the actual criterion.\n- AC-1: Preserve the supported runtime API.');
    expect(updated).toContain('  - application: applied');
  });

  test('rejects non-criterion relaxation lines without mutating explanatory acceptance text', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\nExplanatory note that is not a criterion row.\n- AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: 'Explanatory note that is not a criterion row.', expected: 'Explanatory note that is not a criterion row.', replacement: '- AC-1: Relax explanatory text.' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\nExplanatory note that is not a criterion row.\n- AC-1: Keep the legacy API.\n');
    expect(updated).toContain('  - application: failed (invalid-relaxation-fields)');
  });

  test('rejects multiline replacement fields before changing the targeted criterion', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-1: Preserve the supported runtime API.\n- AC-2: Injected criterion.' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n');
    expect(updated).toContain('  - application: failed (invalid-relaxation-fields)');
  });

  test('rejects a criterion replacement that would change authored goal headings', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'conflict', relaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '## Changed' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n');
    expect(updated).toContain('  - application: failed (invalid-relaxation-fields)');
  });

  test('reapplying the same relaxation record after replacement leaves authored criteria unchanged and audits idempotence', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: original\n`;
    const file = goalFile(document);
    const relaxation = { target: '- AC-1: original', expected: '- AC-1: original', replacement: '- AC-1: relaxed' };
    try {
      expect(recordSupervisorPlanRevision(file.path, { round: 1, reason: 'first application', relaxation })).toEqual({ status: 'applied' });
      const once = readFileSync(file.path, 'utf8');
      expect(recordSupervisorPlanRevision(file.path, { round: 2, reason: 'same relaxation repeated', relaxation })).toEqual({ status: 'already-applied' });
      const twice = readFileSync(file.path, 'utf8');
      expect(twice).toContain('## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n');
      expect(twice.match(/^- AC-1: relaxed$/gm)).toHaveLength(1);
      expect(twice).not.toContain('## ACCEPTANCE CRITERIA\n- AC-1: original\n');
      expect(twice.slice(0, twice.indexOf('## SUPERVISOR PLAN REVISIONS'))).toBe(once.slice(0, once.indexOf('## SUPERVISOR PLAN REVISIONS')));
      expect(twice).toContain('  - application: already-applied');
    } finally { file.clean(); }
  });

  test('keeps a missing original target rejected when neither replacement nor expected criteria identify the row', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-2: unrelated\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'repeat', relaxation: { target: '- AC-1: original', expected: '- AC-1: original', replacement: '- AC-1: relaxed' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-2: unrelated\n');
    expect(updated).toContain('  - application: failed (expected-text-not-found)');
  });

  test('does not treat a preexisting replacement row as already applied without a matching supervisor audit record', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'repeat', relaxation: { target: '- AC-1: original', expected: '- AC-1: original', replacement: '- AC-1: relaxed' } });
    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n');
    expect(updated).toContain('  - application: failed (expected-text-not-found)');
    expect(updated).not.toContain('  - application: already-applied');
  });

  test('does not accept a standalone already-applied audit record as prior-application evidence', () => {
    // ⛔ 감사 기록이 «already-applied» 뿐이면 실제 적용은 «한 번도» 없었던 것이다.
    //   그 기록을 증거로 받으면 선재 replacement 행 하나만으로 멱등을 가장할 수 있다.
    const relaxation = { target: '- AC-1: original', expected: '- AC-1: original', replacement: '- AC-1: relaxed' };
    const audit = [
      '## SUPERVISOR PLAN REVISIONS',
      '- verdict: CONTRACT-CONFLICT',
      '  - round: 1',
      '  - reason: earlier',
      `  - target: ${relaxation.target}`,
      `  - previous: ${relaxation.expected}`,
      `  - replacement: ${relaxation.replacement}`,
      '  - application: already-applied',
      '',
    ].join('\n');
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n\n${audit}`;

    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'repeat', relaxation });

    expect(updated).toContain('## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n');
    expect(updated).toContain('  - application: failed (expected-text-not-found)');
  });

  test('accepts an applied audit record as prior-application evidence', () => {
    // ✅ 대조군 — «applied» 기록이 있으면 같은 완화의 재적용은 already-applied 다.
    const relaxation = { target: '- AC-1: original', expected: '- AC-1: original', replacement: '- AC-1: relaxed' };
    const audit = [
      '## SUPERVISOR PLAN REVISIONS',
      '- verdict: CONTRACT-CONFLICT',
      '  - round: 1',
      '  - reason: earlier',
      `  - target: ${relaxation.target}`,
      `  - previous: ${relaxation.expected}`,
      `  - replacement: ${relaxation.replacement}`,
      '  - application: applied',
      '',
    ].join('\n');
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n\n${audit}`;

    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'repeat', relaxation });

    expect(updated).toContain('  - application: already-applied');
  });

  test('rejects already-applied replacement when the replacement row is ambiguous', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: relaxed\n- AC-1: relaxed\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'repeat', relaxation: { target: '- AC-1: original', expected: '- AC-1: original', replacement: '- AC-1: relaxed' } });
    expect(updated).toContain('- AC-1: relaxed\n- AC-1: relaxed');
    expect(updated).toContain('  - application: failed (target-does-not-identify-replacement-criterion)');
  });

  test('rejects already-applied replacement when it does not match the requested target row', () => {
    const document = `${authoredGoal}## ACCEPTANCE CRITERIA\n- AC-1: original\n- AC-2: relaxed\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'repeat', relaxation: { target: '- AC-1: original', expected: '- AC-1: missing', replacement: '- AC-2: relaxed' } });
    expect(updated).toContain('- AC-1: original\n- AC-2: relaxed');
    expect(updated).toContain('  - application: failed (target-does-not-identify-replacement-criterion)');
  });

  test('inserts a record inside its existing section before the next authored heading', () => {
    const document = `${authoredGoal}## SUPERVISOR PLAN REVISIONS\nPrior supervisor record.\n\n## ACCEPTANCE CRITERIA\nThe following authored section remains last.\n`;

    const updated = appendSupervisorPlanRevision(document, { round: 2, reason: 'The runtime contract still conflicts.' });

    expect(updated).toBe(`${authoredGoal}## SUPERVISOR PLAN REVISIONS\nPrior supervisor record.\n- verdict: CONTRACT-CONFLICT\n  - round: 2\n  - reason: The runtime contract still conflicts.\n\n## ACCEPTANCE CRITERIA\nThe following authored section remains last.\n`);
    expect(updated.match(/^## .+$/gm)).toEqual(['## PROBLEM', '## WHAT TO BUILD', '## SUPERVISOR PLAN REVISIONS', '## ACCEPTANCE CRITERIA']);
  });

  test('reuses the sole CRLF revision section across repeated supervisor records', () => {
    const document = `${authoredGoal.replace(/\n/g, '\r\n')}## SUPERVISOR PLAN REVISIONS\r\nPrior supervisor record.\r\n\r\n## ACCEPTANCE CRITERIA\r\nThe authored section remains last.\r\n`;
    const once = appendSupervisorPlanRevision(document, { round: 1, reason: 'The first runtime contract conflicts.' });
    const twice = appendSupervisorPlanRevision(once, { round: 2, reason: 'The second runtime contract conflicts.' });

    expect(twice.match(/^## SUPERVISOR PLAN REVISIONS\r?$/gm)).toHaveLength(1);
    expect(twice).toContain('  - round: 1\r\n  - reason: The first runtime contract conflicts.');
    expect(twice).toContain('  - round: 2\r\n  - reason: The second runtime contract conflicts.');
    expect(twice).toContain('## ACCEPTANCE CRITERIA\r\nThe authored section remains last.\r\n');
  });

  test('ignores revision-shaped headings inside fenced code blocks', () => {
    const document = `${authoredGoal}\`\`\`markdown\n## SUPERVISOR PLAN REVISIONS\nThis code sample is authored content.\n\`\`\`\n\n## ACCEPTANCE CRITERIA\nThe authored section remains last.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'The runtime contract conflicts.' });

    expect(updated).toContain('```markdown\n## SUPERVISOR PLAN REVISIONS\nThis code sample is authored content.\n```');
    expect(updated).toContain('## SUPERVISOR PLAN REVISIONS\n- verdict: CONTRACT-CONFLICT\n  - round: 1\n  - reason: The runtime contract conflicts.');
    expect(updated.indexOf('- verdict: CONTRACT-CONFLICT')).toBeGreaterThan(updated.indexOf('```\n'));
    expect(updated).toContain('## ACCEPTANCE CRITERIA\nThe authored section remains last.\n');
  });

  test('keeps fenced headings hidden after a non-closing info-string fence line', () => {
    const document = `${authoredGoal}\`\`\`markdown\n\`\`\`typescript\n## SUPERVISOR PLAN REVISIONS\nThis remains code-block content.\n\`\`\`\n\n## ACCEPTANCE CRITERIA\nThe authored section remains last.\n`;
    const updated = appendSupervisorPlanRevision(document, { round: 1, reason: 'The runtime contract conflicts.' });

    expect(updated).toContain('```markdown\n```typescript\n## SUPERVISOR PLAN REVISIONS\nThis remains code-block content.\n```');
    expect(updated.match(/^## SUPERVISOR PLAN REVISIONS$/gm)).toHaveLength(2);
    expect(updated).toContain('## SUPERVISOR PLAN REVISIONS\n- verdict: CONTRACT-CONFLICT\n  - round: 1\n  - reason: The runtime contract conflicts.');
    expect(updated.indexOf('- verdict: CONTRACT-CONFLICT')).toBeGreaterThan(updated.indexOf('## ACCEPTANCE CRITERIA'));
    expect(updated).toContain('## ACCEPTANCE CRITERIA\nThe authored section remains last.\n');
  });

  test.each([1, 2, 3])('reuses the actual revision section after a %i-space-indented closing fence', (indent) => {
    const document = `${authoredGoal}\`\`\`\`markdown\nFenced example content.\n${' '.repeat(indent)}\`\`\`\`\n\n## SUPERVISOR PLAN REVISIONS\nPrior supervisor record.\n\n## ACCEPTANCE CRITERIA\nThe authored section remains last.\n`;
    const once = appendSupervisorPlanRevision(document, { round: 1, reason: 'The first runtime contract conflicts.' });
    const twice = appendSupervisorPlanRevision(once, { round: 2, reason: 'The second runtime contract conflicts.' });
    const revisionStart = twice.indexOf('## SUPERVISOR PLAN REVISIONS');
    const revisionEnd = twice.indexOf('## ACCEPTANCE CRITERIA');

    expect(twice.match(/^## SUPERVISOR PLAN REVISIONS$/gm)).toHaveLength(1);
    expect(twice.match(/^- verdict: CONTRACT-CONFLICT$/gm)).toHaveLength(2);
    expect(twice.indexOf('  - round: 1')).toBeGreaterThan(revisionStart);
    expect(twice.indexOf('  - round: 2')).toBeGreaterThan(revisionStart);
    expect(twice.indexOf('  - reason: The first runtime contract conflicts.')).toBeLessThan(revisionEnd);
    expect(twice.indexOf('  - reason: The second runtime contract conflicts.')).toBeLessThan(revisionEnd);
    expect(twice).toContain(`${' '.repeat(indent)}\`\`\`\`\n\n## SUPERVISOR PLAN REVISIONS`);
  });

  test('rejects invalid records and does not write a damaged document', () => {
    const file = goalFile(authoredGoal);
    const before = readFileSync(file.path, 'utf8');
    try {
      expect(() => recordSupervisorPlanRevision(file.path, { round: 1, reason: '  ' })).toThrow('supervisor plan revision reason must be a non-empty single line');
      expect(readFileSync(file.path, 'utf8')).toBe(before);
      expect(() => recordSupervisorPlanRevision(file.path, { round: 0, reason: 'valid reason' })).toThrow('supervisor plan revision round must be a positive integer');
      expect(readFileSync(file.path, 'utf8')).toBe(before);
      expect(() => appendSupervisorPlanRevision('## SUPERVISOR PLAN REVISIONS\n\n## SUPERVISOR PLAN REVISIONS\n', { round: 1, reason: 'valid reason' })).toThrow('ambiguous supervisor plan revision sections');
    } finally {
      file.clean();
    }
  });

  test('propagates temporary write failure without altering source-file bytes', () => {
    const file = goalFile(authoredGoal);
    const before = readFileSync(file.path, 'utf8');
    const temporaryFile = `${file.path}.write-failure.tmp`;
    try {
      expect(() => recordSupervisorPlanRevision(file.path, { round: 1, reason: 'runtime conflict' }, {
        readFile: (path) => readFileSync(path, 'utf8'),
        writeFile: (path, document) => {
          writeFileSync(path, document);
          throw new Error('disk unavailable');
        },
        renameFile: (from, to) => { renameSync(from, to); },
        removeFile: (path) => { rmSync(path, { force: true }); },
        temporaryFile: () => temporaryFile,
      })).toThrow('disk unavailable');
      expect(readFileSync(file.path, 'utf8')).toBe(before);
    } finally {
      file.clean();
    }
  });
});
