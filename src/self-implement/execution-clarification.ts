import { randomUUID } from 'node:crypto';

import { createPendingQuestion, writePendingQuestion } from '../ask-user-question/pending-questions.js';
import { createFileAskUserQuestionResolver } from '../ask-user-question/tool.js';
import { debug } from '../debug/log.js';
import {
  decideAndObserveClarification,
  defaultClarificationBudget,
  toAskUserQuestionRequest,
  type ClarificationCandidate,
  type ClarificationContext,
} from '../hitl/clarification-policy.js';
import { getUserConfig } from '../user-config.js';
import { appendRunLedgerEntry, type RunLedgerWriter } from './run-ledger.js';

export interface ExecutionClarificationContext {
  runId: string;
  budget?: ClarificationContext['budget'];
  pendingQuestionCount?: number;
  config?: { hitl?: { executionDeadlineMinutes?: number } };
}

export type ExecutionClarificationResult =
  | { choice: string; by: 'assumed' | 'owner' | 'auto-recommended' }
  | { deferred: true }
  | { parked: true; reason: 'critical-unanswered'; questionId: string };

export interface ExecutionClarificationDeps {
  now?: () => number;
  createId?: () => string;
  resolver?: typeof createFileAskUserQuestionResolver;
  resolverDeps?: Parameters<typeof createFileAskUserQuestionResolver>[1];
  writeRunLedger?: RunLedgerWriter;
}

/** A single execution-phase decision; the file resolver owns the pending/answer lifecycle. */
export async function askAtExecution(
  candidate: ClarificationCandidate,
  ctx: ExecutionClarificationContext,
  deps: ExecutionClarificationDeps = {},
): Promise<ExecutionClarificationResult> {
  const recommended = candidate.options.filter(option => option.recommended);
  if (candidate.options.length < 2 || candidate.options.length > 4 || recommended.length !== 1
    || new Set(candidate.options.map(option => option.label)).size !== candidate.options.length) {
    throw new Error('Execution clarification requires 2–4 distinct options and exactly one recommendation.');
  }
  const observe = (event: 'assumed' | 'asked' | 'answered' | 'auto-recommended' | 'parked', questionId?: string): void => {
    try {
      debug.log('hitl.execution', event, { runId: ctx.runId, questionId, impact: candidate.impact });
    } catch { /* Logging must not decide the user's choice. */ }
  };
  const record = (event: 'assumed' | 'auto-recommended' | 'parked', data: Record<string, unknown>): void => {
    (deps.writeRunLedger ?? appendRunLedgerEntry)({
      timestamp: new Date((deps.now ?? Date.now)()).toISOString(),
      runId: ctx.runId,
      event,
      data: { impact: candidate.impact, ...data },
    });
  };
  const decision = decideAndObserveClarification(candidate, {
    phase: 'execution',
    budget: ctx.budget ?? defaultClarificationBudget('execution'),
    pendingQuestionCount: ctx.pendingQuestionCount,
  }, { consumer: 'self-implement-execution' });
  if (decision.action === 'defer') return { deferred: true };
  if (decision.action === 'assume') {
    record('assumed', { choice: recommended[0]!.label, assumption: decision.assumption });
    observe('assumed');
    return { choice: recommended[0]!.label, by: 'assumed' };
  }

  const request = toAskUserQuestionRequest(decision);
  if (!request) throw new Error('Execution clarification policy approved a question without a valid wire request.');
  const configured = ctx.config === undefined
    ? getUserConfig().hitl?.executionDeadlineMinutes
    : ctx.config.hitl?.executionDeadlineMinutes;
  const minutes = configured === undefined ? 30 : configured;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 35_791) {
    throw new Error('hitl.executionDeadlineMinutes must be a positive integer within the resolver timer limit.');
  }
  const questionId = (deps.createId ?? (() => `execution:${ctx.runId}:${randomUUID()}`))();
  let expired = false;
  let written = false;
  const resolver = (deps.resolver ?? createFileAskUserQuestionResolver)(minutes * 60_000, {
    ...deps.resolverDeps,
    observe: (state, data) => {
      if (state === 'answer-missing') expired = true;
      deps.resolverDeps?.observe?.(state, data);
    },
    createId: () => questionId,
    write: (pending) => {
      const question = createPendingQuestion(questionId, { ...request, runId: ctx.runId }, undefined,
        { now: () => new Date((deps.now ?? Date.now)()) },
        { surface: 'file', delivery: 'file', expiresAt: pending.expiresAt });
      (deps.resolverDeps?.write ?? writePendingQuestion)(question);
      written = true;
      observe('asked', questionId);
    },
  });
  const answer = await resolver({ ...request, runId: ctx.runId });
  const chosen = answer.answers[candidate.id];
  if (written && !expired && !answer.cancelled && typeof chosen === 'string' && candidate.options.some(option => option.label === chosen)) {
    observe('answered', questionId);
    return { choice: chosen, by: 'owner' };
  }
  if (!written || !expired) throw new Error('Execution clarification was cancelled or could not read its answer before expiry.');
  if (candidate.impact === 'critical') {
    record('parked', { questionId, reason: 'critical-unanswered' });
    observe('parked', questionId);
    return { parked: true, reason: 'critical-unanswered', questionId };
  }
  record('auto-recommended', { questionId, choice: recommended[0]!.label, by: 'auto-recommended' });
  observe('auto-recommended', questionId);
  return { choice: recommended[0]!.label, by: 'auto-recommended' };
}
