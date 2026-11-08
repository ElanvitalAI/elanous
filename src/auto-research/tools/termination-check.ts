import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4 P4: TerminationCheck LLM tool ──
//
// Evaluates the termination DSL AST against the live goal state.
// Rule source precedence (DD-S4-6):
//   1. rule_override param (explicit LLM input)
//   2. ACTIVE.md frontmatter `termination:` (persisted on init)
//   3. DEFAULT_TERMINATION_RULE (and{ summary_written, budget_min 5% })
//
// ACTIVE.md stores the rule as a JSON code block under the
// "## Termination rule" heading (PFC-S4 P1 init writer). Parser
// extracts it with a targeted regex so we do not have to re-implement
// YAML for nested rule trees.

import { existsSync, readFileSync } from 'node:fs';

import {
  discoverObsidianVault,
  parseFrontmatter,
  type ObsidianVault,
} from '../obsidian-bridge.js';
import { resolveGoalPaths } from '../goal-paths.js';
import { loadGoalBudget } from '../budget-loader.js';
import {
  evaluateTermination,
  type TerminationContext,
  type TerminationOutcome,
  type TerminationRule,
} from '../termination-dsl.js';

export interface TerminationCheckInput {
  goal_slug: string;
  rule_override?: TerminationRule;
}

// Declared as a `type` (not `interface`) so the object literal gains an
// implicit index signature and stays assignable to `ToolRunResult`
// (`Record<string, unknown>`) — the ToolRuntime<Req, Out> constraint in
// tool-runtime/types.ts. Interfaces lack that implicit signature and would
// fail the generic bound (TS2344).
export type TerminationCheckResult = {
  goal_slug: string;
  should_terminate: boolean;
  satisfied: string[];
  unsatisfied: string[];
  diagnostics: Record<string, string>;
  rule_source: 'active_md' | 'override' | 'default';
  rule: TerminationRule;
  notices?: string[];
};

export interface TerminationCheckDispatchOpts {
  vault?: ObsidianVault;
}

export const DEFAULT_TERMINATION_RULE: TerminationRule = {
  kind: 'and',
  rules: [
    { kind: 'summary_written', path: 'executive-summary.md', minChars: 200 },
    { kind: 'budget_remaining_min', ratio: 0.05 },
  ],
};

export async function dispatchTerminationCheck(
  input: TerminationCheckInput,
  opts: TerminationCheckDispatchOpts = {},
): Promise<TerminationCheckResult> {
  if (!input.goal_slug) throw new Error('TerminationCheck: goal_slug is required');
  const vault = opts.vault ?? discoverObsidianVault();
  const paths = resolveGoalPaths(vault, input.goal_slug);

  if (!existsSync(paths.goalRoot)) {
    throw new Error(`TerminationCheck: goal '${input.goal_slug}' not initialised`);
  }

  const notices: string[] = [];
  let rule: TerminationRule;
  let source: TerminationCheckResult['rule_source'];
  if (input.rule_override) {
    const validated = validateRule(input.rule_override);
    if (validated.error) throw new Error(`TerminationCheck override: ${validated.error}`);
    rule = validated.rule!;
    source = 'override';
  } else {
    const fromActive = parseActiveTerminationRule(paths.active);
    if (fromActive.rule) {
      rule = fromActive.rule;
      source = 'active_md';
    } else {
      rule = DEFAULT_TERMINATION_RULE;
      source = 'default';
      if (fromActive.notice) notices.push(fromActive.notice);
    }
  }

  const meter = loadGoalBudget(paths.budgetFile);
  const ctx: TerminationContext = {
    vault,
    budget: meter,
    goalRoot: paths.goalRoot,
  };
  const outcome = await evaluateTermination(rule, ctx);

  return {
    goal_slug: input.goal_slug,
    should_terminate: outcome.shouldTerminate,
    satisfied: outcome.satisfied.map(r => r.kind),
    unsatisfied: outcome.unsatisfied.map(r => r.kind),
    diagnostics: outcome.diagnostics,
    rule_source: source,
    rule,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

// ── ACTIVE.md rule parser ──────────────────────────────────────────────

interface ActiveParse {
  rule?: TerminationRule;
  notice?: string;
}

function parseActiveTerminationRule(activePath: string): ActiveParse {
  if (!existsSync(activePath)) return { notice: 'ACTIVE.md absent → default rule' };
  const raw = readFileSync(activePath, 'utf-8');
  const parsed = parseFrontmatter(raw);

  // 1. Frontmatter scalar (if operator embedded a JSON string).
  const fmRule = parsed.frontmatter.termination;
  if (typeof fmRule === 'string' && fmRule.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(fmRule) as TerminationRule;
      const v = validateRule(obj);
      if (v.rule) return { rule: v.rule };
      return { notice: `frontmatter termination JSON invalid (${v.error}) → default` };
    } catch (err) {
      return { notice: `frontmatter termination JSON parse failed (${(err as Error).message}) → default` };
    }
  }

  // 2. JSON code block under "## Termination rule".
  const blockMatch = parsed.body.match(/^#+\s+Termination rule\s*\n+```json\s*\n([\s\S]*?)\n```/mi);
  if (blockMatch) {
    try {
      const obj = JSON.parse(blockMatch[1]!) as TerminationRule;
      const v = validateRule(obj);
      if (v.rule) return { rule: v.rule };
      return { notice: `ACTIVE.md termination block invalid (${v.error}) → default` };
    } catch (err) {
      return { notice: `ACTIVE.md termination JSON parse failed (${(err as Error).message}) → default` };
    }
  }
  return { notice: 'ACTIVE.md has no termination rule → default' };
}

// ── Validator ──────────────────────────────────────────────────────────

const RULE_KINDS = new Set([
  'all_questions_answered',
  'min_sources',
  'summary_written',
  'budget_remaining_min',
  'and',
  'or',
  'custom',
]);

function validateRule(candidate: unknown): { rule?: TerminationRule; error?: string } {
  if (!candidate || typeof candidate !== 'object') return { error: 'rule is not an object' };
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !RULE_KINDS.has(obj.kind)) {
    return { error: `unknown kind '${String(obj.kind)}'` };
  }
  switch (obj.kind) {
    case 'all_questions_answered':
      if (typeof obj.queuePath !== 'string') return { error: `${obj.kind} requires queuePath (string)` };
      return { rule: obj as TerminationRule };
    case 'min_sources':
      if (typeof obj.n !== 'number' || typeof obj.sourcesPath !== 'string') {
        return { error: `${obj.kind} requires n (number) + sourcesPath (string)` };
      }
      return { rule: obj as TerminationRule };
    case 'summary_written':
      if (typeof obj.path !== 'string') return { error: `${obj.kind} requires path (string)` };
      return { rule: obj as TerminationRule };
    case 'budget_remaining_min':
      if (typeof obj.ratio !== 'number') return { error: `${obj.kind} requires ratio (number 0..1)` };
      return { rule: obj as TerminationRule };
    case 'and':
    case 'or': {
      if (!Array.isArray(obj.rules)) return { error: `${obj.kind} requires rules (array)` };
      for (const inner of obj.rules) {
        const v = validateRule(inner);
        if (v.error) return { error: `${obj.kind}[]: ${v.error}` };
      }
      return { rule: obj as TerminationRule };
    }
    case 'custom':
      if (typeof obj.command !== 'string') return { error: `${obj.kind} requires command (string)` };
      return { rule: obj as TerminationRule };
  }
  return { error: `unhandled kind '${obj.kind}'` };
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildTerminationCheckTool(): LLMToolSpec {
  return {
    name: 'TerminationCheck',
    description:
      'Evaluate the termination rule AST for a research goal and report whether the autonomous loop should '
      + 'stop. The rule is loaded from ACTIVE.md frontmatter (or body JSON block) unless `rule_override` is '
      + 'provided. Returns which rule kinds are satisfied/unsatisfied plus diagnostics per rule so the parent '
      + 'LLM can explain to the operator why the loop continues or exits.',
    parameters: {
      type: 'object',
      properties: {
        goal_slug: { type: 'string' },
        rule_override: {
          type: 'object',
          description: 'Optional TerminationRule AST; overrides ACTIVE.md lookup.',
          additionalProperties: true,
        },
      },
      required: ['goal_slug'],
      additionalProperties: false,
    },
  };
}
