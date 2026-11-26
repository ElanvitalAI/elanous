// GOAL-ORCHESTRATION-NL — goal (plain words) → orchestration/v1 spec. The LLM picks the pattern and drafts items;
// its answer is validated like a hand-written file. No LLM, or an answer that does not validate → the keyword
// heuristic drafts the spec instead (the plan says which). The person always sees the plan before it runs.
import { normalizePattern, PATTERNS, validateSpec, WORKER_KINDS, type OrchestrationPattern, type OrchestrationSpec } from './spec.js';
import { presetFor, templateFor } from './templates.js';

export type LlmText = (prompt: string) => Promise<string>;
export interface PlanResult { readonly spec: OrchestrationSpec; readonly source: 'llm' | 'heuristic' | 'preset'; readonly reason: string; readonly warnings: readonly string[] }

/** Keyword fallback: which of the five shapes the goal reads as. English and Korean cues. */
export function heuristicPattern(goal: string): { pattern: OrchestrationPattern; reason: string } {
  const g = goal.toLowerCase();
  if (/\b(until|keep (going|trying)|iterate)\b|될 때까지|반복/u.test(g)) return { pattern: 'loop-until', reason: 'the goal repeats until a condition holds' };
  if (/\b(write|draft)\b.*\b(review|revise|edit)\b|쓰고.*(검토|리뷰)|작성.*검토/u.test(g)) return { pattern: 'pipeline', reason: 'write → review → revise is an ordered chain' };
  if (/\b(debate|panel|pros and cons|argue|should we)\b|토론|패널|찬반/u.test(g)) return { pattern: 'panel', reason: 'several viewpoints judge one question' };
  if (/\b(compare|recommend|evaluate|rank|survey|each of)\b|비교|추천|평가/u.test(g)) return { pattern: 'map-reduce', reason: 'the same analysis runs over several items, then one recommendation' };
  return { pattern: 'supervisor-workers', reason: 'an open goal: a supervisor splits it, workers do the parts' };
}

/** «Compare 3 note-taking apps» → three placeholder items; explicit «A, B and C» lists win. */
export function heuristicItems(goal: string): string[] {
  const list = /:\s*(.+)$/u.exec(goal)?.[1] ?? /\b(?:between|among)\s+(.+)$/iu.exec(goal)?.[1];
  if (list) {
    const parts = list.split(/,|\band\b|\bor\b|·|와|과/u).map((s) => s.trim().replace(/[.?!]$/u, '')).filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 8);
  }
  const n = Number(/\b(\d{1,2})\b/u.exec(goal)?.[1] ?? 0);
  const noun = /\b\d{1,2}\s+([\w-]+(?:\s[\w-]+)?)/u.exec(goal)?.[1]?.replace(/s$/u, '') ?? 'option';
  if (n >= 2 && n <= 8) return Array.from({ length: n }, (_, i) => `${noun} #${i + 1} (worker picks a well-known one, distinct from the others)`);
  return [];
}

export function plannerPrompt(goal: string): string {
  return [
    'You plan a multi-agent orchestration. Answer with ONE JSON object only, no prose.',
    `Goal: ${goal}`,
    `Pick "pattern" from: ${PATTERNS.join(', ')}.`,
    '- map-reduce: same analysis over several items, then combine. pipeline: ordered stages, each uses the previous output.',
    '- panel: several personas judge one question, then vote. supervisor-workers: a supervisor splits an open goal. loop-until: repeat until a check passes.',
    'Fields: {"pattern": "...", "reason": "one line", "items": ["..."] (map-reduce items or pipeline stages, concrete),',
    ` "workers": [{"kind": "${WORKER_KINDS.join('|')}", "role": "...", "persona": "optional"}] (2-6, mix kinds),`,
    ' "success": "all-ok | contains:<text> | min-length:<n> | min-items:<n> | llm-judge"}',
  ].join('\n');
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { const v = JSON.parse(text.slice(start, end + 1)) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { return undefined; }
}

export function heuristicPlan(goal: string, why = ''): PlanResult {
  const { pattern, reason } = heuristicPattern(goal);
  return { spec: templateFor(pattern, goal, heuristicItems(goal)), source: 'heuristic', reason: `${reason}${why ? ` (${why})` : ''}`, warnings: [] };
}

export async function planFromGoal(goal: string, opts: { llm?: LlmText; pattern?: OrchestrationPattern } = {}): Promise<PlanResult> {
  const text = goal.trim();
  if (!text) throw new Error('goal is empty');
  if (opts.pattern) return { spec: templateFor(opts.pattern, text, heuristicItems(text)), source: 'heuristic', reason: `pattern set by the user (${opts.pattern})`, warnings: [] };
  const preset = presetFor(text);
  if (preset) {
    const checked = validateSpec(preset.build(text));
    if (checked.ok && checked.spec) return { spec: checked.spec, source: 'preset', reason: `scenario preset «${preset.id}»`, warnings: checked.warnings };
  }
  if (!opts.llm) return heuristicPlan(text, 'no model available');
  let answer: Record<string, unknown> | undefined;
  try { answer = extractJson(await opts.llm(plannerPrompt(text))); } catch (error) { return heuristicPlan(text, `model failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120)); }
  const pattern = normalizePattern(answer?.pattern);
  if (!answer || !pattern) return heuristicPlan(text, 'model answer had no valid pattern');
  const items = Array.isArray(answer.items) ? answer.items.map((x) => String(x).trim()).filter(Boolean) : [];
  const base = templateFor(pattern, text, items);
  const workers = Array.isArray(answer.workers) && answer.workers.length >= 1 ? answer.workers : base.workers;
  const candidate = { ...base, workers, reduce: { ...base.reduce, ...(typeof answer.success === 'string' ? { success: answer.success } : {}) } };
  const checked = validateSpec(candidate);
  if (checked.ok && checked.spec) return { spec: checked.spec, source: 'llm', reason: String(answer.reason ?? '').slice(0, 200) || `model picked ${pattern}`, warnings: checked.warnings };
  // Keep the model's pattern; fall back to the template's workers/criterion when its fields broke a rule.
  const fallback = validateSpec({ ...base, tasks: items.length ? items : base.tasks });
  if (fallback.ok && fallback.spec) return { spec: fallback.spec, source: 'llm', reason: `model picked ${pattern}; template workers used (${checked.errors[0] ?? 'invalid fields'})`, warnings: checked.errors };
  return heuristicPlan(text, `model draft invalid: ${checked.errors[0] ?? ''}`);
}

/** The plan as the person reads it before confirming (English, product text). */
export function describePlan(plan: PlanResult): string {
  const s = plan.spec;
  return [
    `Goal: ${s.goal}`,
    `Pattern: ${s.pattern}  (${plan.source === 'llm' ? 'chosen by the model' : plan.source === 'preset' ? 'scenario preset' : 'chosen by rules'}: ${plan.reason})`,
    `Workers: ${s.workers.map((w) => `${w.id} [${w.kind}${w.model ? ` · ${w.model}` : ''}] ${w.persona ?? w.role}${w.fetch ? ' + data' : ''}`).join(' · ')}`,
    ...(s.tasks.length ? [`${s.pattern === 'pipeline' ? 'Stages' : 'Items'}: ${s.tasks.map((t, i) => `${i + 1}. ${t}`).join('  ')}`] : []),
    `Reduce: ${s.reduce.method} · success when ${s.reduce.success}`,
    ...(s.voice ? ['Voice: brief → mp3 (skipped without a key)'] : []),
    ...(s.publish ? [`Publish: ${s.publish.title ?? s.publish.command}`] : []),
    `Limits: ${s.limits.maxParallel} parallel · ${s.limits.timeoutSec}s per worker · budget $${s.limits.budgetUsd} · up to ${s.limits.maxRounds} rounds`,
  ].join('\n');
}
