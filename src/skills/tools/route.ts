import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H6 P3 Bundle 1 · LLM tools: PolicyDecide · PolicyExplain.
//
// Both tools are pure reads (no side effects on the UsageStore /
// override store); they invoke `PolicyRouter.decide()` + read the
// cached `lastDecision()`. Output contract mirrors the budget tools
// (`{ output: string; metadata: object; isError?: true }`).
//
// Naming note: the vision PLAN sketched `PolicyDecide` · the PFC-S5
// intelligence-map track already owns an LLM tool with that exact
// name (`src/intelligence-map/tools/route-to-model.ts`) but a
// different schema (task_type enum · model-catalog + system-load
// driven). To avoid collision + schema confusion we namespace ours
// under Policy* — same underlying `/route` slash UX.
//
// PolicyDecide:
//   input  = { task, estimatedInputTokens?, strengths?, preferred? }
//   output = { decision, alternatives, readableSummary }
//
// PolicyExplain:
//   input  = { task? }           // omit = explain lastDecision
//   output = { trace, narrative } // step-by-step reason chain


import type {
  RouteCandidate,
  RouteDecision,
  RouteTrace,
  RouteTraceStep,
  StrengthTag,
} from '../../policy/types.js';
import type { UsageProvider } from '../../budget/types.js';
import { getPolicyRouter } from '../../policy/router.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const VALID_STRENGTHS: readonly StrengthTag[] = [
  'code', 'research', 'chat', 'reasoning', 'vision', 'long-context',
];
const VALID_BRANDS: readonly UsageProvider[] = ['codex', 'claude', 'gemini', 'local-llm'];

function normalizeBrand(raw: unknown): UsageProvider | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = raw.trim().toLowerCase();
  return (VALID_BRANDS as string[]).includes(n) ? (n as UsageProvider) : undefined;
}

function normalizeStrengths(raw: unknown): StrengthTag[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StrengthTag[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    const n = s.trim().toLowerCase();
    if ((VALID_STRENGTHS as string[]).includes(n)) out.push(n as StrengthTag);
  }
  return out.length > 0 ? out : undefined;
}

function labelOf(brand: UsageProvider, model?: string): string {
  return model ? `${brand}/${model}` : brand;
}

// ─── PolicyDecide ────────────────────────────────────────────────────

export interface PolicyDecideArgs {
  task: string;
  estimatedInputTokens?: number;
  strengths?: StrengthTag[];
  preferred?: { brand?: UsageProvider; model?: string };
}

export interface PolicyDecideAlternative {
  brand: UsageProvider;
  model?: string;
  availability: RouteCandidate['availability'];
  costTier?: string;
  contextWindow?: number;
}

export interface PolicyDecideResult {
  output: string;
  metadata: {
    decision: {
      brand: UsageProvider;
      model?: string;
      mode: string;
      confidence: number;
      requiresConfirmation: boolean;
    };
    alternatives: PolicyDecideAlternative[];
    trace: {
      steps: { ruleId: string; priority: number; kind: string; reason?: string }[];
      elapsedMs: number;
    };
  };
  isError?: true;
}

export function buildPolicyDecideTool(): LLMToolSpec {
  return {
    name: 'PolicyDecide',
    description:
      'Ask the policy router which (brand, model) to use for a task. Returns a decision ranked by rule priority: session-lock · per-turn · budget-throttle (HITL) · budget-warn (redirect) · capability-filter · persistent-default · cloud-first. `requiresConfirmation: true` means the caller MUST ask the user before launching (throttle gate, ≥95% usage). Output is a recommendation — callers may still ignore it and launch what they want (enforce mode ships in Bundle 2).',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Free-form description of the work to route. Rule-filter inputs (context + strengths) are derived from this.',
        },
        estimatedInputTokens: {
          type: 'number',
          description: 'Optional estimate of input context size. Used by capability-filter (20% safety margin). Default heuristic = task.length / 4 when omitted.',
        },
        strengths: {
          type: 'array',
          items: { type: 'string', enum: [...VALID_STRENGTHS] },
          description: 'Required capabilities. Candidates lacking ALL listed strengths are filtered out.',
        },
        preferred: {
          type: 'object',
          properties: {
            brand: { type: 'string', enum: [...VALID_BRANDS] },
            model: { type: 'string' },
          },
          description: 'Soft hint. Honored as per-turn unless overridden by session-lock / budget.',
          additionalProperties: false,
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  };
}

export async function dispatchPolicyDecide(
  rawArgs: Record<string, unknown>,
): Promise<PolicyDecideResult> {
  const task = typeof rawArgs.task === 'string' ? rawArgs.task : '';
  if (!task.trim()) {
    return {
      output: 'PolicyDecide: `task` required',
      metadata: {
        decision: { brand: 'codex', mode: 'auto', confidence: 0, requiresConfirmation: false },
        alternatives: [],
        trace: { steps: [], elapsedMs: 0 },
      },
      isError: true,
    };
  }
  const estRaw = typeof rawArgs.estimatedInputTokens === 'number' ? rawArgs.estimatedInputTokens : undefined;
  const estimatedInputTokens = estRaw !== undefined && Number.isFinite(estRaw) && estRaw > 0
    ? Math.floor(estRaw)
    : Math.floor(task.length / 4);
  const strengths = normalizeStrengths(rawArgs.strengths);
  const preferredRaw = rawArgs.preferred as { brand?: unknown; model?: unknown } | undefined;
  const preferredBrand = preferredRaw ? normalizeBrand(preferredRaw.brand) : undefined;
  const preferredModel = preferredRaw && typeof preferredRaw.model === 'string' && preferredRaw.model.trim()
    ? preferredRaw.model.trim()
    : undefined;
  const preferred = preferredBrand || preferredModel
    ? {
        ...(preferredBrand ? { brand: preferredBrand } : {}),
        ...(preferredModel ? { model: preferredModel } : {}),
      }
    : undefined;

  const router = getPolicyRouter();
  try {
    const decision = router.decide({
      task,
      estimatedInputTokens,
      ...(strengths ? { strengths } : {}),
      ...(preferred ? { preferred } : {}),
    });
    const alternatives = buildAlternatives(decision);
    const readable = buildReadableSummary(decision, task);
    return {
      output: readable,
      metadata: {
        decision: {
          brand: decision.brand,
          ...(decision.model ? { model: decision.model } : {}),
          mode: decision.mode ?? 'auto',
          confidence: decision.confidence,
          requiresConfirmation: decision.requiresConfirmation,
        },
        alternatives,
        trace: {
          steps: decision.trace.steps.map(stepSummary),
          elapsedMs: decision.trace.elapsedMs,
        },
      },
    };
  } catch (err) {
    return {
      output: `PolicyDecide: ${err instanceof Error ? err.message : String(err)}`,
      metadata: {
        decision: { brand: 'codex', mode: 'auto', confidence: 0, requiresConfirmation: false },
        alternatives: [],
        trace: { steps: [], elapsedMs: 0 },
      },
      isError: true,
    };
  }
}

function buildAlternatives(decision: RouteDecision): PolicyDecideAlternative[] {
  const out: PolicyDecideAlternative[] = [];
  for (const cand of decision.trace.finalCandidates) {
    if (cand.brand === decision.brand && (cand.model ?? null) === (decision.model ?? null)) continue;
    out.push({
      brand: cand.brand,
      ...(cand.model ? { model: cand.model } : {}),
      availability: cand.availability,
      ...(cand.capability?.costTier ? { costTier: cand.capability.costTier } : {}),
      ...(cand.capability?.contextWindow ? { contextWindow: cand.capability.contextWindow } : {}),
    });
  }
  return out.slice(0, 6); // cap to avoid noise
}

function buildReadableSummary(decision: RouteDecision, task: string): string {
  const label = labelOf(decision.brand, decision.model);
  const hitl = decision.requiresConfirmation ? ' · HITL required' : '';
  const winningStep = [...decision.trace.steps].reverse().find(
    (s) => s.result.kind === 'prefer' || s.result.kind === 'flag-confirm',
  );
  const reason = winningStep?.result.kind === 'prefer' || winningStep?.result.kind === 'flag-confirm'
    ? winningStep.result.reason
    : 'default ordering';
  const trimmedTask = task.length > 60 ? task.slice(0, 57) + '…' : task;
  return `PolicyDecide: ${label} (conf=${decision.confidence.toFixed(2)})${hitl}\n  task=${JSON.stringify(trimmedTask)}\n  reason=${reason}`;
}

function stepSummary(step: RouteTraceStep): { ruleId: string; priority: number; kind: string; reason?: string } {
  const result = step.result;
  const reason = result.kind === 'pass'
    ? result.reason
    : (result as { reason?: string }).reason;
  return {
    ruleId: step.ruleId,
    priority: step.priority,
    kind: result.kind,
    ...(reason ? { reason } : {}),
  };
}

// ─── PolicyExplain ────────────────────────────────────────────────────

export interface PolicyExplainArgs {
  task?: string;
}

export interface PolicyExplainResult {
  output: string;
  metadata: {
    trace: {
      steps: { ruleId: string; priority: number; kind: string; reason?: string }[];
      finalCandidates: PolicyDecideAlternative[];
      elapsedMs: number;
    };
    decision: {
      brand: UsageProvider;
      model?: string;
      requiresConfirmation: boolean;
    } | null;
  };
  isError?: true;
}

export function buildPolicyExplainTool(): LLMToolSpec {
  return {
    name: 'PolicyExplain',
    description:
      'Return a step-by-step trace of the last (or a fresh) policy-router decision. With no `task` argument, explains the most recent `PolicyDecide` call. With a `task`, runs a fresh decide and returns both the trace and decision.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Optional. When provided, runs a fresh decide; when omitted, explains the cached last decision.',
        },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchPolicyExplain(
  rawArgs: Record<string, unknown>,
): Promise<PolicyExplainResult> {
  const taskRaw = typeof rawArgs.task === 'string' ? rawArgs.task.trim() : '';
  const router = getPolicyRouter();
  let decision: RouteDecision | undefined;
  let trace: RouteTrace | undefined;
  if (taskRaw) {
    try {
      decision = router.decide({ task: taskRaw });
      trace = decision.trace;
    } catch (err) {
      return {
        output: `PolicyExplain: ${err instanceof Error ? err.message : String(err)}`,
        metadata: { trace: { steps: [], finalCandidates: [], elapsedMs: 0 }, decision: null },
        isError: true,
      };
    }
  } else {
    decision = router.lastDecision();
    trace = decision?.trace;
  }
  if (!trace || !decision) {
    return {
      output: 'PolicyExplain: no prior decision · pass `task` to run a fresh decide',
      metadata: { trace: { steps: [], finalCandidates: [], elapsedMs: 0 }, decision: null },
    };
  }
  const narrative = buildNarrative(decision, trace);
  return {
    output: narrative,
    metadata: {
      trace: {
        steps: trace.steps.map(stepSummary),
        finalCandidates: trace.finalCandidates.map((c) => ({
          brand: c.brand,
          ...(c.model ? { model: c.model } : {}),
          availability: c.availability,
          ...(c.capability?.costTier ? { costTier: c.capability.costTier } : {}),
          ...(c.capability?.contextWindow ? { contextWindow: c.capability.contextWindow } : {}),
        })),
        elapsedMs: trace.elapsedMs,
      },
      decision: {
        brand: decision.brand,
        ...(decision.model ? { model: decision.model } : {}),
        requiresConfirmation: decision.requiresConfirmation,
      },
    },
  };
}

function buildNarrative(decision: RouteDecision, trace: RouteTrace): string {
  const lines: string[] = [];
  lines.push(`PolicyExplain → ${labelOf(decision.brand, decision.model)} (conf=${decision.confidence.toFixed(2)}${decision.requiresConfirmation ? ' · HITL' : ''})`);
  for (const step of trace.steps) {
    const r = step.result;
    const reason = r.kind === 'pass' ? r.reason : (r as { reason?: string }).reason;
    const suffix = r.kind === 'prefer' || r.kind === 'flag-confirm'
      ? ` → ${labelOf((r as { winner: RouteCandidate }).winner.brand, (r as { winner: RouteCandidate }).winner.model)}`
      : r.kind === 'filter'
        ? ` → ${(r as { kept: readonly RouteCandidate[] }).kept.length} candidates`
        : '';
    lines.push(`  [${step.priority}] ${step.ruleId} · ${r.kind}${suffix}${reason ? ` · ${reason}` : ''}`);
  }
  lines.push(`  (elapsed ${trace.elapsedMs}ms · ${trace.finalCandidates.length} finalists)`);
  return lines.join('\n');
}
