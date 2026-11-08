import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Opportunistic followup §6.2 #4 (2026-05-13) — `agent.plan` LLM tool
// wire. Two paired tools:
//   - `Plan` — LLM declares an ordered step list at the start of a
//     complex turn. Daemon emits a phase=start `agent.plan` envelope
//     so PWA `<PlanBlock>` renders the step list (all pending,
//     activeIndex=0). Renderer shipped M3 PR #2483 with mock-test
//     coverage; this is its first production caller.
//   - `MarkStepDone` — LLM signals step completion. Daemon emits
//     phase=update envelopes carrying the updated step status +
//     advancing activeIndex. `<PlanBlock>` upserts in place (same
//     blockId) so the user sees progress without React remount.
//
// State model: one active plan per `ctx.sessionId`. The module-level
// `activePlanBySessionId` map keeps the step list + ref id + emit
// seq-tracker so subsequent `MarkStepDone` calls in the same turn
// (or any later turn for the same session) operate on the same
// envelope blockId. Re-issuing `Plan(...)` replaces the active plan
// (new ref + new blockId).
//
// Why explicit `MarkStepDone` rather than heuristic step inference?
// Heuristic (matching subsequent tool calls to step index) would
// produce 70%-correct progress signals at best; explicit gives the
// LLM full agency over what counts as "step done" without elanous
// guessing. Cost is one extra tool call per step — negligible.


import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
  type SeqTracker,
} from '../../feedback/envelope.js';

import { ToolSafetyError, type DaemonToolDispatchCtx } from './types.js';

export type PlanStepStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface PlanArgs {
  // Spec shape (Plan tool schema): `[{text: "..."}, ...]`.
  // Tolerant shape (gemma-4-a4b et al observed 2026-05-14 dogfood):
  // `["...", "...", ...]` — dispatchPlan coerces the string form
  // into the object form before normalisation.
  steps: Array<{ text: string } | string>;
}

export interface PlanResult {
  ref: string;
  steps: PlanStep[];
  activeIndex: number;
}

export interface MarkStepDoneArgs {
  stepIndex: number;
  status?: 'done' | 'skipped';
}

export interface MarkStepDoneResult {
  ref: string;
  steps: PlanStep[];
  activeIndex: number;
}

interface ActivePlan {
  ref: string;
  blockId: string;
  sessionId: string;
  steps: PlanStep[];
  seqTracker: SeqTracker;
}

const activePlanBySessionId = new Map<string, ActivePlan>();

/** Test-only — clear all active plans. Production code never calls
 *  this; the daemon process never explicitly resets (sessions die with
 *  the process anyway). */
export function _resetActivePlansForTests(): void {
  activePlanBySessionId.clear();
}

export function buildPlanTool(): LLMToolSpec {
  return {
    name: 'Plan',
    description:
      'Declare an ordered plan of steps you intend to execute. Surfaces a live progress block to the user so they see what you intend to do before you do it. Call this once at the start of a multi-step turn; use MarkStepDone after each step completes (or is skipped) so the block advances.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered step list. Each step is a short imperative sentence.',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'One-line description of the step.',
              },
            },
            required: ['text'],
          },
        },
      },
      required: ['steps'],
    },
  };
}

export function buildMarkStepDoneTool(): LLMToolSpec {
  return {
    name: 'MarkStepDone',
    description:
      'Mark the step at the given 0-based index as done (or skipped). The user-visible plan block advances to the next pending step. Call after the actual work for that step finishes — not before.',
    parameters: {
      type: 'object',
      properties: {
        stepIndex: {
          type: 'number',
          description: '0-based index of the step that just finished.',
        },
        status: {
          type: 'string',
          enum: ['done', 'skipped'],
          description: 'Defaults to "done". Use "skipped" when the step turned out to be unnecessary.',
        },
      },
      required: ['stepIndex'],
    },
  };
}

function nextActiveIndex(steps: readonly PlanStep[]): number {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.status === 'pending' || steps[i]!.status === 'in-progress') {
      return i;
    }
  }
  return steps.length;
}

function emitPlanEnvelope(
  plan: ActivePlan,
  phase: 'start' | 'update' | 'end',
  ctx: DaemonToolDispatchCtx,
): void {
  if (!ctx.emitFeedback) return;
  const activeIndex = nextActiveIndex(plan.steps);
  let env: FeedbackEnvelope;
  try {
    env = makeEnvelope(
      {
        kind: 'agent.plan',
        sessionId: plan.sessionId,
        blockId: plan.blockId,
        phase,
        payload: {
          ref: plan.ref,
          steps: plan.steps.map((s) => ({ text: s.text, status: s.status })),
          activeIndex,
        },
        asciiFallback: plan.steps.map((s, i) => `${formatGlyph(s.status, i === activeIndex)} ${s.text}`),
        ...(ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {}),
      },
      plan.seqTracker,
    );
  } catch {
    return;
  }
  try {
    ctx.emitFeedback(env);
  } catch {
    /* wire glue swallows — emit must not break the tool turn */
  }
}

function emitStepEnvelope(
  plan: ActivePlan,
  stepIndex: number,
  ctx: DaemonToolDispatchCtx,
): void {
  if (!ctx.emitFeedback) return;
  const step = plan.steps[stepIndex]!;
  try {
    ctx.emitFeedback(makeEnvelope(
      {
        kind: 'tool.progress',
        sessionId: plan.sessionId,
        blockId: plan.blockId,
        phase: 'update',
        payload: {
          stream: 'generic',
          lines: [],
          stepId: `${plan.ref}:${stepIndex}:${step.text}`,
        },
        ...(ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {}),
      },
      plan.seqTracker,
    ));
  } catch {
    /* wire glue swallows — emit must not break the tool turn */
  }
}

function formatGlyph(status: PlanStepStatus, active: boolean): string {
  if (status === 'done') return '●';
  if (status === 'skipped') return '∅';
  if (status === 'in-progress' || active) return '◐';
  return '○';
}

export async function dispatchPlan(
  args: PlanArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<PlanResult> {
  if (!args || !Array.isArray(args.steps) || args.steps.length === 0) {
    throw new ToolSafetyError(
      'unavailable',
      'Plan: `steps` must be a non-empty array',
    );
  }
  // Tolerant input shape (2026-05-14 iOS dogfood) — some local LLMs
  // (gemma-4-a4b on LM Studio observed) emit `steps: ["str", "str"]`
  // instead of the schema-required `steps: [{text: "str"}, ...]`.
  // The model then burns turns retrying after the schema refusal
  // never knowing how to fix the shape. Coerce string entries into
  // `{text: string}` so the call succeeds + the plan UI renders.
  const normalized: PlanStep[] = args.steps.map((s, idx) => {
    // String form: gemma-4-a4b style. Coerce.
    if (typeof s === 'string') {
      const t = s.trim();
      if (t.length === 0) {
        throw new ToolSafetyError(
          'unavailable',
          `Plan: step[${idx}] is an empty string`,
        );
      }
      return { text: t, status: 'pending' };
    }
    // Object form: spec.
    if (!s || typeof s.text !== 'string' || s.text.length === 0) {
      throw new ToolSafetyError(
        'unavailable',
        `Plan: step[${idx}] is missing a non-empty \`text\` field`,
      );
    }
    return { text: s.text, status: 'pending' };
  });
  // Plan tool is session-scoped — `sessionId` is required so the
  // envelope wire (PWA accumulator → <PlanBlock>) can correlate the
  // block. Surfaces that omit sessionId (skill runner, CLI scripts)
  // get a no-op tool result rather than a noisy refusal — the LLM
  // can keep using the plan internally even without a renderer.
  const sessionId = ctx.sessionId;
  const ref = makePlanRef();
  const blockId = sessionId
    ? `${sessionId}:plan:${ref}`
    : `local:plan:${ref}`;
  const plan: ActivePlan = {
    ref,
    blockId,
    sessionId: sessionId ?? 'local',
    steps: normalized,
    seqTracker: createSeqTracker(),
  };
  if (sessionId) {
    activePlanBySessionId.set(sessionId, plan);
    emitPlanEnvelope(plan, 'start', ctx);
  }
  return {
    ref,
    steps: plan.steps.map((s) => ({ text: s.text, status: s.status })),
    activeIndex: 0,
  };
}

export async function dispatchMarkStepDone(
  args: MarkStepDoneArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<MarkStepDoneResult> {
  if (!args || typeof args.stepIndex !== 'number' || !Number.isInteger(args.stepIndex) || args.stepIndex < 0) {
    throw new ToolSafetyError(
      'unavailable',
      'MarkStepDone: `stepIndex` must be a non-negative integer',
    );
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    throw new ToolSafetyError(
      'unavailable',
      'MarkStepDone: requires an active session — call Plan first within the same chat turn',
    );
  }
  const plan = activePlanBySessionId.get(sessionId);
  if (!plan) {
    throw new ToolSafetyError(
      'unavailable',
      'MarkStepDone: no active plan for this session — call Plan first',
    );
  }
  if (args.stepIndex >= plan.steps.length) {
    throw new ToolSafetyError(
      'unavailable',
      `MarkStepDone: stepIndex ${args.stepIndex} is out of range (plan has ${plan.steps.length} steps)`,
    );
  }
  const nextStatus: PlanStepStatus = args.status === 'skipped' ? 'skipped' : 'done';
  plan.steps[args.stepIndex] = {
    text: plan.steps[args.stepIndex]!.text,
    status: nextStatus,
  };
  const allTerminal = plan.steps.every(
    (s) => s.status === 'done' || s.status === 'skipped',
  );
  emitPlanEnvelope(plan, allTerminal ? 'end' : 'update', ctx);
  emitStepEnvelope(plan, args.stepIndex, ctx);
  if (allTerminal) {
    activePlanBySessionId.delete(sessionId);
  }
  return {
    ref: plan.ref,
    steps: plan.steps.map((s) => ({ text: s.text, status: s.status })),
    activeIndex: nextActiveIndex(plan.steps),
  };
}

function makePlanRef(): string {
  // Short ref id (8 hex chars). Plenty for in-process uniqueness —
  // never persisted, never cross-process.
  const a = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const b = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${a}${b}`;
}
