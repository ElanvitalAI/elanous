import type { LLMToolSpec } from '../llm/tool-spec.js';
// update_plan tool — Phase WF2.
//
// Progress checklist for multi-step tasks. Adapted from codex-rs's
// `update_plan` tool (Apache 2.0). Each call REPLACES the current
// plan state (there is only ever one plan per session), so the LLM
// sends the full list back every time — cheap, deterministic, easy
// to diff on the UI side.
//
// Invariants:
//   - at most one step may be `in_progress` at a time (hard error
//     otherwise — prevents batch-completion anti-patterns)
//   - each update replaces the plan in full; UI emits the whole
//     board on every change
//   - plan mode (WF3/WF4) REJECTS update_plan — plan mode is for
//     high-level spec, update_plan is runtime progress tracking.
//     The rejection hook is a callback the plan-mode module fills
//     in at its init time (defaulting to null = never rejected).



export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface UpdatePlanArgs {
  plan: PlanStep[];
  explanation?: string;
}

export interface PlanState {
  steps: PlanStep[];
  updatedAt: number;
  lastExplanation?: string;
  /** Monotonic version so consumers can tell "new state" vs replay. */
  version: number;
}

// ── Singleton state ─────────────────────────────────────────────

let _state: PlanState = { steps: [], updatedAt: 0, version: 0 };

export function getPlanState(): PlanState {
  return {
    steps: _state.steps.map((s) => ({ ...s })),
    updatedAt: _state.updatedAt,
    lastExplanation: _state.lastExplanation,
    version: _state.version,
  };
}

export function _resetPlanStateForTesting(): void {
  _state = { steps: [], updatedAt: 0, version: 0 };
}

// ── Plan-mode guard hook ────────────────────────────────────────
//
// When plan mode (WF3/WF4) is active, `update_plan` is disallowed.
// Plan mode can register a predicate; default is null = always
// allow. Returning a non-empty string from the predicate blocks the
// call and surfaces the message to the LLM.

type PlanModeGuard = () => string | null;
let planModeGuard: PlanModeGuard | null = null;

export function setPlanToolPlanModeGuard(fn: PlanModeGuard | null): void {
  planModeGuard = fn;
}

// ── Events ───────────────────────────────────────────────────────

type PlanListener = (state: PlanState) => void;
const listeners = new Set<PlanListener>();

export function subscribePlanUpdate(fn: PlanListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function publishPlanUpdate(state: PlanState): void {
  for (const fn of listeners) {
    try { fn(state); } catch { /* never break runtime */ }
  }
}

export function _clearPlanListenersForTesting(): void {
  listeners.clear();
}

// ── Parse + validate ─────────────────────────────────────────────

export function parseUpdatePlanArgs(
  raw: Record<string, unknown>,
): { ok: true; args: UpdatePlanArgs } | { ok: false; reason: string } {
  const planRaw = raw.plan;
  if (!Array.isArray(planRaw) || planRaw.length === 0) {
    return { ok: false, reason: 'plan must be a non-empty array' };
  }
  const steps: PlanStep[] = [];
  let inProgressCount = 0;
  for (let i = 0; i < planRaw.length; i++) {
    const s = planRaw[i] as Record<string, unknown>;
    const step = typeof s.step === 'string' ? s.step.trim() : '';
    const status = typeof s.status === 'string' ? s.status : '';
    if (!step) return { ok: false, reason: `step ${i}: "step" text required` };
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return { ok: false, reason: `step ${i}: status must be pending | in_progress | completed (got "${status}")` };
    }
    if (status === 'in_progress') inProgressCount++;
    steps.push({ step, status });
  }
  if (inProgressCount > 1) {
    return { ok: false, reason: `only one step may be in_progress at a time (got ${inProgressCount})` };
  }
  const explanation = typeof raw.explanation === 'string' ? raw.explanation : undefined;
  return { ok: true, args: { plan: steps, ...(explanation ? { explanation } : {}) } };
}

// ── Tool descriptor + dispatcher ─────────────────────────────────

export function buildUpdatePlanTool(): LLMToolSpec {
  return {
    name: 'update_plan',
    description:
      'Track progress on a multi-step task. Use for non-trivial work with 3+ logically ordered steps; '
      + 'skip entirely for single-step or trivial tasks. At most ONE step may be `in_progress` at a time. '
      + 'Update after EACH step completes — never batch-complete multiple steps in a single call. '
      + 'Each call REPLACES the entire plan; pass the full step list every time. Optional `explanation` '
      + 'surfaces a one-sentence note about why the plan just changed (useful when you reorder or split '
      + 'steps mid-flight). Do NOT call this tool while in plan mode — plan mode is for drafting the '
      + 'high-level spec; update_plan is for execution-phase progress.',
    parameters: {
      type: 'object',
      properties: {
        explanation: {
          type: 'string',
          description: 'Short note on why the plan just changed (optional; omit when unchanged).',
        },
        plan: {
          type: 'array',
          description: 'Full plan — order matters; send the complete list every time.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: 'One short sentence describing the step.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'pending = not started, in_progress = currently working on, completed = done.',
              },
            },
            required: ['step', 'status'],
            additionalProperties: false,
          },
          minItems: 1,
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  };
}

export interface UpdatePlanDispatchResult {
  output: string;
  state?: PlanState;
}

export async function dispatchUpdatePlan(
  raw: Record<string, unknown>,
): Promise<UpdatePlanDispatchResult> {
  const block = planModeGuard?.();
  if (block) return { output: `update_plan failed: ${block}` };

  const parsed = parseUpdatePlanArgs(raw);
  if (parsed.ok !== true) return { output: `update_plan failed: ${parsed.reason}` };

  const next: PlanState = {
    steps: parsed.args.plan,
    updatedAt: Date.now(),
    lastExplanation: parsed.args.explanation,
    version: _state.version + 1,
  };
  _state = next;
  publishPlanUpdate(getPlanState());

  const summary = summarizePlan(next);
  return { output: `update_plan: ${summary}`, state: getPlanState() };
}

function summarizePlan(s: PlanState): string {
  const total = s.steps.length;
  const done = s.steps.filter((x) => x.status === 'completed').length;
  const inProgress = s.steps.find((x) => x.status === 'in_progress')?.step;
  const inPart = inProgress ? ` — now: "${truncateLine(inProgress, 60)}"` : '';
  return `${done}/${total} complete${inPart}`;
}

function truncateLine(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}
