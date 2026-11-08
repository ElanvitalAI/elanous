import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4 P3: Budget LLM tool ──
//
// Wraps BudgetMeter for the 4 actions the research loop needs:
//   snapshot      — peek current usage + tripped/warning axes
//   add           — increment usage and persist
//   can_afford    — "would this next step fit remaining budget?"
//   reset_weekly  — manual roll of the weeklyUsd window (e.g. tests)
//
// Per DD-S4-10, every goal owns budget.json under its goalRoot. The
// helper `loadGoalBudget` restores the spec persisted on init so the
// tool does not need the spec as an input.


import {
  discoverObsidianVault,
  type ObsidianVault,
} from '../obsidian-bridge.js';
import { resolveGoalPaths } from '../goal-paths.js';
import { existsSync, readFileSync } from 'node:fs';
import {
  BudgetMeter,
  type BudgetAxis,
  type BudgetSnapshot,
  type BudgetSpec,
  type BudgetUsage,
  formatBudgetLine,
} from '../budget-meter.js';
import { loadGoalBudget } from '../budget-loader.js';

function readPersistedSpec(path: string): BudgetSpec {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { spec?: BudgetSpec };
    return raw.spec && typeof raw.spec === 'object' ? raw.spec : {};
  } catch {
    return {};
  }
}

export type BudgetAction = 'snapshot' | 'add' | 'can_afford' | 'reset_weekly';

export interface BudgetInput {
  action: BudgetAction;
  goal_slug: string;
  delta?: Partial<Pick<BudgetUsage, 'tokens' | 'wallclockMs' | 'usd' | 'weeklyUsd'>>;
  required?: BudgetSpec;
}

// NB: declared as a `type` alias (not `interface`) on purpose. The
// ToolRuntime<Req, Out> constraint requires Out to satisfy
// ToolRunResult = { output: string } | Record<string, unknown>.
// Interfaces get no implicit string index signature (they stay open to
// declaration merging), so an `interface BudgetResult` fails the
// `Record<string, unknown>` arm ("Index signature ... is missing"). An
// object type alias is treated as closed and IS assignable, which is
// the accurate contract: BudgetResult is a fixed record, not extensible.
export type BudgetResult = {
  goal_slug: string;
  snapshot: BudgetSnapshot;
  budget_line: string;
  can_afford?: boolean;
  reason?: string;
  notices?: string[];
};

export interface BudgetDispatchOpts {
  vault?: ObsidianVault;
  now?: number;
}

export async function dispatchBudget(
  input: BudgetInput,
  opts: BudgetDispatchOpts = {},
): Promise<BudgetResult> {
  if (!input.goal_slug) throw new Error('Budget: goal_slug is required');
  const vault = opts.vault ?? discoverObsidianVault();
  const paths = resolveGoalPaths(vault, input.goal_slug);
  const now = opts.now ?? Date.now();

  switch (input.action) {
    case 'snapshot': {
      const meter = loadGoalBudget(paths.budgetFile, {}, now);
      const snap = meter.snapshot(now);
      return shape(input.goal_slug, snap);
    }
    case 'add': {
      const meter = loadGoalBudget(paths.budgetFile, {}, now);
      if (input.delta) meter.add(input.delta, now);
      await meter.persist(paths.budgetFile);
      const snap = meter.snapshot(now);
      const notices: string[] = ['usage persisted'];
      if (snap.tripped.length > 0) notices.push(`TRIPPED axes: ${snap.tripped.join(', ')}`);
      else if (snap.warning.length > 0) notices.push(`≥90% warning: ${snap.warning.join(', ')}`);
      return { ...shape(input.goal_slug, snap), notices };
    }
    case 'can_afford': {
      const meter = loadGoalBudget(paths.budgetFile, {}, now);
      const snap = meter.snapshot(now);
      const { ok, reason } = canAfford(snap, input.required ?? {});
      return { ...shape(input.goal_slug, snap), can_afford: ok, reason };
    }
    case 'reset_weekly': {
      // Create a fresh meter with the persisted spec + existing usage
      // but weeklyUsd zeroed. BudgetMeter.add rejects negative deltas,
      // so we go through the constructor instead.
      const meter = loadGoalBudget(paths.budgetFile, {}, now);
      const raw = meter.rawUsage();
      const spec = readPersistedSpec(paths.budgetFile);
      const fresh = new BudgetMeter(spec, { ...raw, weeklyUsd: 0 }, now);
      await fresh.persist(paths.budgetFile);
      const snap = fresh.snapshot(now);
      return { ...shape(input.goal_slug, snap), notices: ['weeklyUsd reset to 0'] };
    }
  }
  throw new Error(`Budget: unknown action '${input.action}'`);
}

// ── Helpers ────────────────────────────────────────────────────────────

function shape(slug: string, snap: BudgetSnapshot): BudgetResult {
  return {
    goal_slug: slug,
    snapshot: snap,
    budget_line: formatBudgetLine(snap),
  };
}

function canAfford(snap: BudgetSnapshot, required: BudgetSpec): { ok: boolean; reason: string } {
  const axes: BudgetAxis[] = ['tokens', 'wallclockMs', 'usd', 'weeklyUsd'];
  const misses: string[] = [];
  for (const axis of axes) {
    const need = required[axis];
    if (need === undefined || need <= 0) continue;
    const remaining = snap.remaining[axis];
    if (remaining === undefined) continue;   // axis unlimited — skip
    if (remaining < need) {
      misses.push(`${axis} remaining ${remaining} < required ${need}`);
    }
  }
  if (snap.tripped.length > 0) misses.push(`tripped axes: ${snap.tripped.join(',')}`);
  if (misses.length > 0) return { ok: false, reason: misses.join('; ') };
  return { ok: true, reason: 'within budget' };
}


// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildBudgetTool(): LLMToolSpec {
  return {
    name: 'Budget',
    description:
      'Inspect and update the 4-axis budget meter for a research goal (tokens, wallclockMs, usd, weeklyUsd). '
      + 'Use `snapshot` for a read, `add` after every paid action to persist usage, `can_afford` before '
      + 'launching an expensive experiment, and `reset_weekly` to force-roll the weeklyUsd window (normally '
      + 'auto-resets at Monday 00:00 UTC).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['snapshot', 'add', 'can_afford', 'reset_weekly'] },
        goal_slug: { type: 'string' },
        delta: {
          type: 'object',
          description: 'Per-axis non-negative increments for `add`.',
          properties: {
            tokens: { type: 'number' },
            wallclockMs: { type: 'number' },
            usd: { type: 'number' },
            weeklyUsd: { type: 'number' },
          },
          additionalProperties: false,
        },
        required: {
          type: 'object',
          description: 'Per-axis non-negative requirements for `can_afford`.',
          properties: {
            tokens: { type: 'number' },
            wallclockMs: { type: 'number' },
            usd: { type: 'number' },
            weeklyUsd: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      required: ['action', 'goal_slug'],
      additionalProperties: false,
    },
  };
}
