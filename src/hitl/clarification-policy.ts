// Progressive Clarification Policy — bounded, decision-value-based HITL.
//
// This module intentionally owns no channel or UI. TUI, ACP, and mission
// orchestration call the same pure policy, then route an `ask` decision via
// the existing AskUserQuestion / requestQuestion transport.

import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
  Question,
  QuestionOption,
} from '../ask-user-question/types.js';
import { debug } from '../debug/log.js';
import {
  requestQuestion,
  type QuestionChannel,
  type RequestQuestionResult,
} from './question.js';

export type ClarificationPhase = 'intake' | 'planning' | 'execution';
export type ClarificationAction = 'ask' | 'assume' | 'defer';
export type ClarificationImpact = 'low' | 'medium' | 'high' | 'critical';

export interface ClarificationCandidate {
  /** Stable key, retained by mission decision logs and replan triggers. */
  id: string;
  /** The decision the user, rather than repository investigation, owns. */
  decision: string;
  /** A short, user-facing question. */
  prompt: string;
  /** Candidate choices. Exactly one is the system's recommended default. */
  options: Array<QuestionOption & { recommended?: boolean }>;
  /** Why the decision cannot safely wait for the next replan point. */
  whyNow: string;
  /** What observable event should reopen this choice after proceeding. */
  replanTrigger?: string;
  impact: ClarificationImpact;
  /** True when the answer can be found through repository/tools/known facts. */
  factResolvable?: boolean;
}

export interface ClarificationBudget {
  /** Total questions allowed at the current phase boundary. */
  limit: number;
  used: number;
}

export interface ClarificationContext {
  phase: ClarificationPhase;
  budget: ClarificationBudget;
  /** Prevents batching multiple prompts into an overwhelming interview. */
  pendingQuestionCount?: number;
}

export interface ClarificationDecision {
  action: ClarificationAction;
  reason: string;
  candidate: ClarificationCandidate;
  /** Recommended option, used by timeout/Esc and "proceed" controls. */
  recommendedOption?: string;
  /** Explicit assumption to put in a mission plan/log when not asking. */
  assumption?: string;
  /** Increment budget only when a question is actually delivered. */
  budgetCost: 0 | 1;
}

export const PROGRESSIVE_CLARIFICATION_BUDGET: Record<ClarificationPhase, number> = {
  intake: 1,
  planning: 2,
  execution: 1,
};

export function defaultClarificationBudget(phase: ClarificationPhase): ClarificationBudget {
  return { limit: PROGRESSIVE_CLARIFICATION_BUDGET[phase], used: 0 };
}

function recommendedOption(candidate: ClarificationCandidate): string | undefined {
  const recommended = candidate.options.filter(option => option.recommended);
  if (recommended.length !== 1) return undefined;
  return recommended[0].label;
}

/**
 * Decide whether a user should be interrupted now.
 *
 * Critical safety decisions are never silently assumed. All other questions
 * require a real choice, a recommended option, available budget, and no
 * already-pending question. Facts are investigated instead of asked.
 */
export function decideClarification(
  candidate: ClarificationCandidate,
  context: ClarificationContext,
): ClarificationDecision {
  const recommended = recommendedOption(candidate);

  if (candidate.factResolvable) {
    return {
      action: 'assume',
      reason: 'Resolvable facts must be investigated rather than asked.',
      candidate,
      assumption: `Investigate ${candidate.decision} from available evidence before proceeding.`,
      budgetCost: 0,
    };
  }

  if (context.pendingQuestionCount && context.pendingQuestionCount > 0) {
    return {
      action: 'defer',
      reason: 'One clarification is already pending; never batch an interview.',
      candidate,
      budgetCost: 0,
    };
  }

  if (candidate.options.length < 2 || candidate.options.length > 4 || !recommended) {
    return {
      action: 'assume',
      reason: 'A bounded question needs 2–4 options and exactly one recommended default.',
      candidate,
      assumption: `Proceed with the best supported implementation for ${candidate.decision}; record it for replan.`,
      budgetCost: 0,
    };
  }

  if (candidate.impact === 'low') {
    return {
      action: 'assume',
      reason: 'Low-impact implementation detail does not justify an interruption.',
      candidate,
      recommendedOption: recommended,
      assumption: `Proceed with recommended option: ${recommended}.`,
      budgetCost: 0,
    };
  }

  if (candidate.impact === 'critical') {
    return {
      action: 'ask',
      reason: 'Critical safety or irreversible boundary requires explicit human direction.',
      candidate,
      recommendedOption: recommended,
      budgetCost: 1,
    };
  }

  if (context.budget.used >= context.budget.limit) {
    return {
      action: 'defer',
      reason: 'Question budget is exhausted; continue with the recommended option and revisit at a replan trigger.',
      candidate,
      recommendedOption: recommended,
      budgetCost: 0,
    };
  }

  return {
    action: 'ask',
    reason: 'The answer materially changes scope, cost, or an external effect.',
    candidate,
    recommendedOption: recommended,
    budgetCost: 1,
  };
}

export interface ClarificationObservation {
  consumer: string;
  missionId?: string;
}

/** Decide through the shared policy and persist the outcome for `elanous logs`. */
export function decideAndObserveClarification(
  candidate: ClarificationCandidate,
  context: ClarificationContext,
  observation: ClarificationObservation,
): ClarificationDecision {
  const decision = decideClarification(candidate, context);
  debug.log('hitl.clarification-policy', 'decision', {
    consumer: observation.consumer,
    missionId: observation.missionId,
    phase: context.phase,
    candidateId: candidate.id,
    impact: candidate.impact,
    action: decision.action,
    reason: decision.reason,
    ...(context.phase === 'execution' ? {} : { recommendedOption: decision.recommendedOption }),
    budgetUsed: context.budget.used,
    budgetLimit: context.budget.limit,
  });
  return decision;
}

/** Prompt-facing rendering of the same policy contract used by runtime consumers. */
export function clarificationPolicyGuidance(phase: ClarificationPhase): string {
  const budget = PROGRESSIVE_CLARIFICATION_BUDGET[phase];
  return [
    `Apply the shared ClarificationPolicy for the ${phase} phase (question budget: ${budget}).`,
    '- `ask`: interrupt only for a consequential user-owned choice with 2–4 options and exactly one recommended default.',
    '- `assume`: investigate fact-resolvable ambiguity or take the recommended low-impact/reversible default.',
    '- `defer`: when the question budget is exhausted or another question is pending, proceed and reopen at a replan trigger.',
    '- Critical safety or irreversible boundaries always use `ask`.',
  ].join('\n');
}

/** Converts an approved `ask` decision into the existing cross-surface wire. */
export function toAskUserQuestionRequest(decision: ClarificationDecision): AskUserQuestionRequest | undefined {
  if (decision.action !== 'ask' || !decision.recommendedOption) return undefined;
  const candidate = decision.candidate;
  const question: Question = {
    id: candidate.id,
    header: 'Direction',
    question: `${candidate.prompt}\n\nRecommended: ${decision.recommendedOption}. ${candidate.whyNow}`,
    options: candidate.options.map(({ recommended: _recommended, ...option }) => option),
    impact: candidate.impact,
    recommendedIndex: candidate.options.findIndex(option => option.recommended),
    includeOther: true,
  };
  return { questions: [question] };
}

export interface ResolveClarificationOpts {
  channels?: QuestionChannel[];
  timeoutMs?: number;
  /** Observe the decision without coupling policy to a particular log store. */
  onDecision?: (decision: ClarificationDecision) => void;
}

export interface ClarificationResolution {
  decision: ClarificationDecision;
  /** Full question-race outcome: answer plus winning channel and latency. */
  answer?: RequestQuestionResult;
}

/**
 * Single reusable entry point for TUI, ACP, and mission callers. It applies
 * the interruption policy first; only an `ask` reaches the existing
 * multi-surface question race. `assume` and `defer` never emit a prompt.
 */
export async function resolveClarification(
  candidate: ClarificationCandidate,
  context: ClarificationContext,
  opts: ResolveClarificationOpts = {},
): Promise<ClarificationResolution> {
  const decision = decideAndObserveClarification(candidate, context, { consumer: 'resolve-clarification' });
  opts.onDecision?.(decision);
  const request = toAskUserQuestionRequest(decision);
  if (!request) return { decision };

  const answer = await requestQuestion({
    request,
    channels: opts.channels,
    timeoutMs: opts.timeoutMs,
    onTimeout: () => ({
      answers: { [candidate.id]: decision.recommendedOption! },
      cancelled: true,
    }),
  });
  return { decision, answer };
}
