import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4 P1: ResearchPlan LLM tool ──
//
// One entry point for every non-mutable read and mission-level write
// on a research goal. The other S4 tools (QuestionQueue / Budget /
// TerminationCheck / EnterAutoMode) assume the goal dir exists — this
// tool's `init` action is the canonical creation site (DD-S4-9).

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  appendNote,
  discoverObsidianVault,
  parseFrontmatter,
  readNote,
  writeNote,
  type ObsidianVault,
} from '../obsidian-bridge.js';
import {
  ensureGoalDir,
  resolveGoalPaths,
  seedGoalKnowledgeFiles,
  type GoalPaths,
} from '../goal-paths.js';
import {
  BudgetMeter,
  type BudgetSnapshot,
  type BudgetSpec,
  formatBudgetLine,
} from '../budget-meter.js';
import { loadGoalBudget } from '../budget-loader.js';
import type { TerminationRule } from '../termination-dsl.js';

export type ResearchPlanAction =
  | 'read'
  | 'init'
  | 'update_plan'
  | 'append_win'
  | 'append_source'
  | 'write_now'
  | 'write_summary'
  | 'list_goals';

export interface ResearchPlanInput {
  action: ResearchPlanAction;
  goal_slug?: string;
  mission?: string;
  deadline?: string;
  budget?: BudgetSpec;
  termination?: TerminationRule;
  plan?: string;
  win?: string;
  source?: string;
  now?: string;
  summary?: string;
}

export interface ResearchPlanGoalSummary {
  slug: string;
  mission: string;
  createdAt: number;
  deadline?: string;
  hasSummary: boolean;
}

export type ResearchPlanResult = {
  goal_slug?: string;
  goalRoot?: string;
  mission?: string;
  plan?: string;
  now_note?: string | null;
  queue_pending_count?: number;
  wins_count?: number;
  sources_count?: number;
  has_summary?: boolean;
  summary?: string | null;
  deadline?: string;
  budget?: BudgetSnapshot;
  budget_line?: string;
  vault_label?: string;
  goals?: ResearchPlanGoalSummary[];
  notices?: string[];
  created?: boolean;
  termination?: TerminationRule;
};

export interface ResearchPlanDispatchOpts {
  vault?: ObsidianVault;
  now?: number;
}

export async function dispatchResearchPlan(
  input: ResearchPlanInput,
  opts: ResearchPlanDispatchOpts = {},
): Promise<ResearchPlanResult> {
  const vault = opts.vault ?? discoverObsidianVault();
  const action = input.action;
  if (!action) throw new Error('ResearchPlan: `action` is required');

  if (action === 'list_goals') {
    return listGoals(vault);
  }

  const slug = input.goal_slug;
  if (!slug) throw new Error(`ResearchPlan: action='${action}' requires goal_slug`);
  const paths = resolveGoalPaths(vault, slug);

  switch (action) {
    case 'init': return initGoal(paths, input, opts.now ?? Date.now());
    case 'read': return readGoal(paths);
    case 'update_plan': return updatePlan(paths, input.plan ?? '');
    case 'append_win': return appendWin(paths, input.win ?? '');
    case 'append_source': return appendSource(paths, input.source ?? '');
    case 'write_now': return writeNow(paths, input.now ?? '');
    case 'write_summary': return writeSummary(paths, input.summary ?? '');
  }
  throw new Error(`ResearchPlan: unknown action '${action}'`);
}

// ── Per-action implementations ─────────────────────────────────────────

function initGoal(paths: GoalPaths, input: ResearchPlanInput, now: number): ResearchPlanResult {
  ensureGoalDir(paths);
  seedGoalKnowledgeFiles(paths);
  const notices: string[] = [];
  const alreadyExisted = existsSync(paths.active);

  if (!alreadyExisted) {
    const mission = (input.mission ?? '').trim();
    if (!mission) throw new Error('ResearchPlan init: mission is required for new goal');
    const frontmatter: Record<string, unknown> = {
      mission,
      created: new Date(now).toISOString(),
    };
    if (input.deadline) frontmatter.deadline = input.deadline;
    const terminationYaml = input.termination ? renderTerminationRule(input.termination) : '';
    const body = terminationYaml ? `\n## Termination rule\n\n\`\`\`json\n${JSON.stringify(input.termination, null, 2)}\n\`\`\`\n` : '';
    writeNote(paths.vault, relFromVault(paths.vault, paths.active), body, frontmatter);
    writeFileSync(paths.plan, `# ${mission}\n\n(Plan not yet drafted — call ResearchPlan action=update_plan.)\n`, 'utf-8');
    writeFileSync(paths.queue, '', 'utf-8');
  } else {
    notices.push(`ACTIVE.md already exists for '${paths.goalSlug}' — mission preserved`);
  }

  const spec = resolveBudgetSpecOnInit(paths.budgetFile, input.budget, alreadyExisted);
  const meter = BudgetMeter.load(paths.budgetFile, spec, now);
  void meter.persist(paths.budgetFile);

  const result = readGoal(paths);
  result.created = !alreadyExisted;
  if (notices.length > 0) result.notices = [...(result.notices ?? []), ...notices];
  if (input.termination) result.termination = input.termination;
  return result;
}

function readGoal(paths: GoalPaths): ResearchPlanResult {
  if (!existsSync(paths.goalRoot)) {
    throw new Error(`ResearchPlan read: goal '${paths.goalSlug}' does not exist — call action='init' first`);
  }
  const active = readNote(paths.vault, relFromVault(paths.vault, paths.active)) ?? '';
  const parsed = active ? parseFrontmatter(active) : { frontmatter: {}, body: '' };
  const planBody = readNote(paths.vault, relFromVault(paths.vault, paths.plan)) ?? '';
  const queueBody = existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : '';
  const winsBody = existsSync(paths.wins) ? readFileSync(paths.wins, 'utf-8') : '';
  const sourcesBody = existsSync(paths.sources) ? readFileSync(paths.sources, 'utf-8') : '';
  const nowNote = existsSync(paths.nowPath) ? readFileSync(paths.nowPath, 'utf-8') : null;
  const summaryExists = existsSync(paths.summary);
  const summaryBody = summaryExists ? readFileSync(paths.summary, 'utf-8') : null;

  const meter = loadGoalBudget(paths.budgetFile);
  const snapshot = meter.snapshot();

  return {
    goal_slug: paths.goalSlug,
    goalRoot: paths.goalRoot,
    mission: typeof parsed.frontmatter.mission === 'string' ? parsed.frontmatter.mission : undefined,
    deadline: typeof parsed.frontmatter.deadline === 'string' ? parsed.frontmatter.deadline : undefined,
    plan: planBody,
    now_note: nowNote,
    queue_pending_count: countMarked(queueBody, ' '),
    wins_count: countListLines(winsBody),
    sources_count: countListLines(sourcesBody),
    has_summary: summaryExists && (summaryBody?.trim().length ?? 0) > 0,
    summary: summaryBody,
    budget: snapshot,
    budget_line: formatBudgetLine(snapshot),
    vault_label: paths.vault.label,
  };
}

function updatePlan(paths: GoalPaths, plan: string): ResearchPlanResult {
  requireGoal(paths);
  const body = plan.endsWith('\n') ? plan : plan + '\n';
  writeNote(paths.vault, relFromVault(paths.vault, paths.plan), body);
  return { ...readGoal(paths), notices: [`plan.md updated (${body.length} chars)`] };
}

function appendWin(paths: GoalPaths, win: string): ResearchPlanResult {
  requireGoal(paths);
  const entry = win.trim();
  if (!entry) throw new Error('ResearchPlan append_win: win text is required');
  appendNote(paths.vault, relFromVault(paths.vault, paths.wins), `- ${entry}\n`);
  return { ...readGoal(paths), notices: [`win appended`] };
}

function appendSource(paths: GoalPaths, source: string): ResearchPlanResult {
  requireGoal(paths);
  const entry = source.trim();
  if (!entry) throw new Error('ResearchPlan append_source: source text is required');
  appendNote(paths.vault, relFromVault(paths.vault, paths.sources), `- ${entry}\n`);
  return { ...readGoal(paths), notices: [`source appended`] };
}

function writeNow(paths: GoalPaths, now: string): ResearchPlanResult {
  requireGoal(paths);
  writeFileSync(paths.nowPath, now, 'utf-8');
  return { ...readGoal(paths), notices: [`NOW.md written`] };
}

function writeSummary(paths: GoalPaths, summary: string): ResearchPlanResult {
  requireGoal(paths);
  const body = summary.trim();
  if (body.length === 0) throw new Error('ResearchPlan write_summary: summary is required');
  writeFileSync(paths.summary, body + (body.endsWith('\n') ? '' : '\n'), 'utf-8');
  return { ...readGoal(paths), notices: [`executive-summary.md written (${body.length} chars)`] };
}

function listGoals(vault: ObsidianVault): ResearchPlanResult {
  const root = join(vault.root, 'goals');
  if (!existsSync(root)) return { vault_label: vault.label, goals: [] };
  const out: ResearchPlanGoalSummary[] = [];
  for (const entry of readdirSync(root)) {
    const goalDir = join(root, entry);
    try {
      const st = statSync(goalDir);
      if (!st.isDirectory()) continue;
      const active = join(goalDir, 'ACTIVE.md');
      if (!existsSync(active)) continue;
      const raw = readFileSync(active, 'utf-8');
      const parsed = parseFrontmatter(raw);
      const mission = typeof parsed.frontmatter.mission === 'string' ? parsed.frontmatter.mission : '(no mission)';
      const createdRaw = parsed.frontmatter.created;
      const created = typeof createdRaw === 'string' ? Date.parse(createdRaw) || st.birthtimeMs : st.birthtimeMs;
      const deadline = typeof parsed.frontmatter.deadline === 'string' ? parsed.frontmatter.deadline : undefined;
      const summaryExists = existsSync(join(goalDir, 'executive-summary.md'));
      const entrySummary: ResearchPlanGoalSummary = {
        slug: entry,
        mission,
        createdAt: created,
        hasSummary: summaryExists,
      };
      if (deadline) entrySummary.deadline = deadline;
      out.push(entrySummary);
    } catch {
      // ignore broken entries
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return { vault_label: vault.label, goals: out };
}

// ── Helpers ────────────────────────────────────────────────────────────

function requireGoal(paths: GoalPaths): void {
  if (!existsSync(paths.active)) {
    throw new Error(`ResearchPlan: goal '${paths.goalSlug}' not initialised — call action='init' first`);
  }
}

function countMarked(raw: string, marker: ' ' | 'x' | '!'): number {
  let n = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*-\s*\[([ x!])\]/);
    if (m && m[1] === marker) n++;
  }
  return n;
}

function countListLines(raw: string): number {
  let n = 0;
  for (const line of raw.split('\n')) {
    if (/^\s*-\s+\S/.test(line)) n++;
  }
  return n;
}

function relFromVault(vault: ObsidianVault, absPath: string): string {
  if (!absPath.startsWith(vault.root)) {
    // Callers may have a vault outside — still work by stripping root up
    // to commonality or falling back to basename.
    return absPath.slice(dirname(absPath).length - 1);
  }
  const rel = absPath.slice(vault.root.length).replace(/^\/+/, '');
  return rel;
}

function renderTerminationRule(rule: TerminationRule): string {
  return JSON.stringify(rule);
}

function resolveBudgetSpecOnInit(
  budgetPath: string,
  requested: BudgetSpec | undefined,
  preserve: boolean,
): BudgetSpec {
  if (preserve && existsSync(budgetPath)) {
    try {
      const raw = JSON.parse(readFileSync(budgetPath, 'utf-8')) as { spec?: BudgetSpec };
      if (raw.spec && typeof raw.spec === 'object') return raw.spec;
    } catch { /* fall through */ }
  }
  return requested ?? {};
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildResearchPlanTool(): LLMToolSpec {
  return {
    name: 'ResearchPlan',
    description:
      'Read and write the mission-level state of an autonomous research goal: plan, wins, sources, NOW handoff, '
      + 'executive summary, and the per-goal budget file. Use `init` to create a goal (required before any other '
      + 'research tool can operate on the slug), `read` to fetch the current snapshot, and the append/write '
      + 'actions to record progress. Returns a structured snapshot the parent LLM can inject into the next turn.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'init', 'update_plan', 'append_win', 'append_source', 'write_now', 'write_summary', 'list_goals'],
          description: 'Which mutation/read to perform.',
        },
        goal_slug: {
          type: 'string',
          description: 'Goal directory slug (lowercase-hyphen form). Required for every action except list_goals.',
        },
        mission: {
          type: 'string',
          description: 'One-line mission statement. Required for init on a new goal.',
        },
        deadline: {
          type: 'string',
          description: 'ISO 8601 deadline. Stored in ACTIVE.md frontmatter.',
        },
        budget: {
          type: 'object',
          description: 'Budget spec (tokens/wallclockMs/usd/weeklyUsd) — written to budget.json on init.',
          additionalProperties: true,
        },
        termination: {
          type: 'object',
          description: 'Termination rule AST stored alongside mission. Used by TerminationCheck when ACTIVE.md '
            + 'is queried without an override.',
          additionalProperties: true,
        },
        plan: { type: 'string', description: 'New plan body (update_plan).' },
        win: { type: 'string', description: 'One-line win entry (append_win).' },
        source: { type: 'string', description: 'One-line source reference (append_source).' },
        now: { type: 'string', description: 'NOW handoff note body (write_now).' },
        summary: { type: 'string', description: 'Executive summary body (write_summary).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}
