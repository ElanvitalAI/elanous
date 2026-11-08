import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S2: ClassifyGoal LLM tool ──
//
// Expose the Conductor's classify + dispatch pipeline to the LLM as a
// first-class tool. Typical flow:
//   LLM user: "이 요청이 coding 인지 research 인지 먼저 분류해줘"
//   LLM calls: ClassifyGoal({ intake: "...", goal_slug: "slug" })
//   → returns { kind, confidence, classifier, adapter_hint, ... }
// The LLM can then decide whether to continue with `EnterAutoMode`
// (passing the classified kind) or hand off to a different workflow.
//
// This tool does NOT persist ACTIVE.md by itself — that's EnterAutoMode's
// responsibility once it commits to a session. ClassifyGoal is a
// pure read-only query.


import {
  dispatchGoalKind,
} from '../dispatch.js';
import type {
  AdapterResult,
  ClassifyResult,
  GoalKind,
  Intake,
} from '../types.js';
import type { DispatchInput } from '../dispatch.js';

export interface ClassifyGoalToolInput {
  intake: string;
  goal_slug?: string;
  force_kind?: GoalKind;
  channel?: Intake['channel'];
  /** Optional priority hint carried along to the classifier snapshot. */
  priority?: 'urgent' | 'normal' | 'whenever';
}

export interface ClassifyGoalToolResult {
  output: string;
  kind: GoalKind;
  confidence: number;
  classifier: ClassifyResult['classifier'];
  keyword_hits: ClassifyResult['keywordHits'];
  scores: ClassifyResult['scores'];
  adapter: AdapterResult;
  routed_adapter: string;
  pending_tracks?: readonly string[];
  hint?: string;
  notices?: string[];
}

export async function dispatchClassifyGoal(
  raw: ClassifyGoalToolInput,
): Promise<ClassifyGoalToolResult> {
  if (!raw.intake || typeof raw.intake !== 'string' || !raw.intake.trim()) {
    throw new Error('ClassifyGoal: intake is required (non-empty string)');
  }

  const intake: Intake = {
    raw: raw.intake,
    ...(raw.channel ? { channel: raw.channel } : {}),
    ...(raw.priority ? { priorityHint: raw.priority } : {}),
  };

  const input: DispatchInput = {
    goalSlug: raw.goal_slug ?? 'classify-only',
    intake,
    ...(raw.force_kind ? { force_kind: raw.force_kind } : {}),
  };

  const r = await dispatchGoalKind(input);

  const summary =
    `ClassifyGoal → kind: ${r.classify.kind} `
    + `(classifier: ${r.classify.classifier}, confidence: ${r.classify.confidence.toFixed(2)}) `
    + `· adapter: ${r.adapter.adapter} (${r.adapter.status})`;

  return {
    output: summary,
    kind: r.classify.kind,
    confidence: r.classify.confidence,
    classifier: r.classify.classifier,
    keyword_hits: r.classify.keywordHits,
    scores: r.classify.scores,
    adapter: r.adapter,
    routed_adapter: r.adapter.adapter,
    ...(r.adapter.pendingTracks ? { pending_tracks: r.adapter.pendingTracks } : {}),
    ...(r.adapter.hint ? { hint: r.adapter.hint } : {}),
    ...(r.classify.notices ? { notices: r.classify.notices } : {}),
  };
}

export function buildClassifyGoalTool(): LLMToolSpec {
  return {
    name: 'ClassifyGoal',
    description:
      'Classify a natural-language business request into one of 5 goal kinds '
      + '(research / coding / analysis / monitoring / refactor) and report which adapter would '
      + 'handle it. Heuristic keyword-regex first; falls back to low-confidence "research" '
      + 'default when no strong signal. Returns adapter hint (e.g. "coding needs TOX-2 + AXON-P1") '
      + 'so the LLM can decide whether to proceed via EnterAutoMode or hand off elsewhere. '
      + 'Read-only — does NOT persist ACTIVE.md; use EnterAutoMode with the same intake for that.',
    parameters: {
      type: 'object',
      properties: {
        intake: {
          type: 'string',
          description: 'The raw natural-language request (Korean or English supported by the keyword table).',
        },
        goal_slug: {
          type: 'string',
          description: 'Optional — echoed back in the adapter context (used for hint composition).',
        },
        force_kind: {
          type: 'string',
          enum: ['research', 'coding', 'analysis', 'monitoring', 'refactor'],
          description: 'Operator override — bypass classification and route directly to this adapter.',
        },
        channel: {
          type: 'string',
          enum: ['chat', 'telegram', 'scheduler', 'webhook', 'cli'],
          description: 'Origin channel of the intake (informational; stored in result).',
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'normal', 'whenever'],
          description: 'Priority hint (informational; future PM-framework plug-in will consume).',
        },
      },
      required: ['intake'],
      additionalProperties: false,
    },
  };
}
