// GOAL-ORCHESTRATION-NL (대표 11-26) — `orchestration/v1`: one YAML file says what a goal-driven run is.
// goal · pattern (map-reduce | pipeline | panel | supervisor-workers | loop-until) · workers · tasks/items · reduce ·
// layout · limits. Pure functions only: parse, validate, normalize (defaults + hard safety caps). The runner trusts
// only a normalized spec; a spec that breaks a cap is refused here, never silently clipped at run time.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const ORCHESTRATION_API = 'orchestration/v1';
export const PATTERNS = ['map-reduce', 'pipeline', 'panel', 'supervisor-workers', 'loop-until'] as const;
export type OrchestrationPattern = (typeof PATTERNS)[number];
/** Spoken/written aliases folded onto the five patterns. */
const PATTERN_ALIASES: Record<string, OrchestrationPattern> = {
  'map-reduce': 'map-reduce', mapreduce: 'map-reduce', fanout: 'map-reduce', 'fan-out': 'map-reduce',
  pipeline: 'pipeline', chain: 'pipeline',
  panel: 'panel', debate: 'panel', 'debate/panel': 'panel',
  'supervisor-workers': 'supervisor-workers', supervisor: 'supervisor-workers',
  'loop-until': 'loop-until', loop: 'loop-until',
};
export const WORKER_KINDS = ['eln', 'codex', 'claude'] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];
export const REDUCE_METHODS = ['consensus', 'concat', 'vote', 'llm-summary', 'last'] as const;
export type ReduceMethod = (typeof REDUCE_METHODS)[number];
export const TILE_GRIDS = ['auto', '2x2', '3x3', '4x3'] as const;

/** Hard caps — the validator refuses anything above them (spawn safety). */
export const HARD_CAPS = { workers: 12, maxParallel: 8, rounds: 5, timeoutSec: 1800, budgetUsd: 20, items: 24 } as const;
export const DEFAULT_LIMITS = { maxParallel: 4, timeoutSec: 300, budgetUsd: 2, maxRounds: 2 } as const;

export interface WorkerSpec {
  readonly id: string; readonly kind: WorkerKind; readonly role: string; readonly persona?: string; readonly model?: string;
  /** Optional local shell command whose output is handed to the worker as data (e.g. `eln research "…"`). Runs on this
   *  machine only, inside the worker's own tab, with the existing secret resolver — never a paid VM. */
  readonly fetch?: string;
}
export interface ReduceSpec { readonly method: ReduceMethod; readonly success: string }
export interface LayoutSpec { readonly grid: (typeof TILE_GRIDS)[number]; readonly spotlight: 'active' | 'verdict' | 'none'; readonly workspace?: string }
export interface LimitsSpec { readonly maxParallel: number; readonly timeoutSec: number; readonly budgetUsd: number; readonly maxRounds: number }
export interface OrchestrationSpec {
  readonly api: typeof ORCHESTRATION_API;
  readonly goal: string;
  readonly pattern: OrchestrationPattern;
  readonly workers: readonly WorkerSpec[];
  /** map-reduce: items to fan out over · pipeline: ordered stage tasks · others: optional task hints. */
  readonly tasks: readonly string[];
  readonly reduce: ReduceSpec;
  readonly layout: LayoutSpec;
  readonly limits: LimitsSpec;
  /** Optional final node: a local command that publishes the result ($ORCH_RESULT_FILE · $ORCH_RUN_DIR), shown as the
   *  ORCH·publish tile (e.g. PDF → Telegram). Runs only after the success criterion holds. */
  readonly publish?: { readonly command: string; readonly title?: string };
  /** Optional voice node (after the criterion holds, before publish): the result → one mp3 next to the receipt, handed
   *  to publish as $ORCH_VOICE_FILE. A missing key or a TTS failure skips it — never fails the run. */
  readonly voice?: boolean;
}

export interface ValidationResult { readonly ok: boolean; readonly errors: readonly string[]; readonly warnings: readonly string[]; readonly spec?: OrchestrationSpec }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

export function normalizePattern(raw: unknown): OrchestrationPattern | undefined {
  const key = str(raw)?.toLowerCase();
  return key ? PATTERN_ALIASES[key] : undefined;
}

/** Validate + normalize. Unknown pattern/kind/method, empty goal, caps exceeded, paid-VM hosts → errors. */
export function validateSpec(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['spec must be a YAML mapping'], warnings };
  if (raw.api !== undefined && raw.api !== ORCHESTRATION_API) errors.push(`api must be ${ORCHESTRATION_API} (got ${JSON.stringify(raw.api)})`);
  const goal = str(raw.goal);
  if (!goal) errors.push('goal is required');
  const pattern = normalizePattern(raw.pattern);
  if (!pattern) errors.push(`pattern must be one of ${PATTERNS.join(' | ')} (got ${JSON.stringify(raw.pattern)})`);
  const workersRaw = Array.isArray(raw.workers) ? raw.workers : [];
  if (workersRaw.length === 0) errors.push('workers: at least one worker is required');
  if (workersRaw.length > HARD_CAPS.workers) errors.push(`workers: ${workersRaw.length} exceeds the spawn cap ${HARD_CAPS.workers}`);
  const seen = new Set<string>();
  const workers: WorkerSpec[] = [];
  workersRaw.forEach((w, i) => {
    if (!isRecord(w)) { errors.push(`workers[${i}] must be a mapping`); return; }
    const kind = str(w.kind)?.toLowerCase();
    if (!kind || !(WORKER_KINDS as readonly string[]).includes(kind)) { errors.push(`workers[${i}].kind must be eln | codex | claude (got ${JSON.stringify(w.kind)})`); return; }
    const host = str(w.host);
    if (host && host !== 'local') errors.push(`workers[${i}].host: only local workers run here — paid VMs (${host}) are never started automatically`);
    let id = (str(w.id) ?? `${kind}-${i + 1}`).replace(/[^\w.-]+/gu, '-').slice(0, 32);
    if (seen.has(id)) { warnings.push(`workers[${i}].id ${id} repeats; renamed ${id}-${i + 1}`); id = `${id}-${i + 1}`; }
    seen.add(id);
    const role = str(w.role) ?? str(w.persona) ?? 'worker';
    const fetch = str(w.fetch);
    if (fetch && fetch.length > 400) errors.push(`workers[${i}].fetch is longer than 400 characters`);
    if (fetch && /\b(gcloud|aws|terraform)\b.*\b(start|create|run-instances|apply)\b/u.test(fetch)) errors.push(`workers[${i}].fetch: starting cloud machines is not allowed`);
    workers.push({ id, kind: kind as WorkerKind, role, ...(str(w.persona) ? { persona: str(w.persona)! } : {}), ...(str(w.model) ? { model: str(w.model)! } : {}), ...(fetch ? { fetch } : {}) });
  });
  const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw.items) ? raw.items : [];
  const tasks = tasksRaw.map((t) => isRecord(t) ? str(t.task) ?? str(t.item) ?? str(t.title) ?? '' : String(t ?? '').trim()).filter(Boolean);
  if (tasks.length > HARD_CAPS.items) errors.push(`tasks: ${tasks.length} exceeds the cap ${HARD_CAPS.items}`);
  if (pattern === 'map-reduce' && tasks.length === 0) errors.push('map-reduce needs items (tasks or items)');
  if (pattern === 'pipeline' && tasks.length < 2) errors.push('pipeline needs at least two ordered tasks (stages)');
  if (pattern === 'panel' && workers.length < 2) errors.push('panel needs at least two workers');
  if (pattern === 'supervisor-workers' && workers.length < 2) errors.push('supervisor-workers needs a supervisor plus at least one worker');
  const reduceRaw = isRecord(raw.reduce) ? raw.reduce : {};
  const method = (str(reduceRaw.method)?.toLowerCase() ?? (pattern === 'pipeline' || pattern === 'loop-until' ? 'last' : pattern === 'panel' ? 'vote' : 'llm-summary')) as ReduceMethod;
  if (!(REDUCE_METHODS as readonly string[]).includes(method)) errors.push(`reduce.method must be one of ${REDUCE_METHODS.join(' | ')} (got ${JSON.stringify(reduceRaw.method)})`);
  const success = str(reduceRaw.success) ?? str(reduceRaw.criterion) ?? 'all-ok';
  const successErr = successCriterionError(success);
  if (successErr) errors.push(`reduce.success: ${successErr}`);
  const layoutRaw = isRecord(raw.layout) ? raw.layout : {};
  const grid = (str(layoutRaw.grid) ?? 'auto') as LayoutSpec['grid'];
  if (!(TILE_GRIDS as readonly string[]).includes(grid)) errors.push(`layout.grid must be ${TILE_GRIDS.join(' | ')} (got ${JSON.stringify(layoutRaw.grid)})`);
  const spotlight = (str(layoutRaw.spotlight) ?? 'active') as LayoutSpec['spotlight'];
  if (!['active', 'verdict', 'none'].includes(spotlight)) errors.push('layout.spotlight must be active | verdict | none');
  const limitsRaw = isRecord(raw.limits) ? raw.limits : {};
  const maxParallel = num(limitsRaw.maxParallel ?? limitsRaw.max_parallel) ?? DEFAULT_LIMITS.maxParallel;
  const timeoutSec = num(limitsRaw.timeoutSec ?? limitsRaw.timeout) ?? DEFAULT_LIMITS.timeoutSec;
  const budgetUsd = num(limitsRaw.budgetUsd ?? limitsRaw.budget) ?? DEFAULT_LIMITS.budgetUsd;
  const maxRounds = num(limitsRaw.maxRounds ?? limitsRaw.rounds) ?? DEFAULT_LIMITS.maxRounds;
  if (maxParallel < 1 || maxParallel > HARD_CAPS.maxParallel) errors.push(`limits.maxParallel must be 1..${HARD_CAPS.maxParallel}`);
  if (timeoutSec < 5 || timeoutSec > HARD_CAPS.timeoutSec) errors.push(`limits.timeoutSec must be 5..${HARD_CAPS.timeoutSec}`);
  if (budgetUsd <= 0 || budgetUsd > HARD_CAPS.budgetUsd) errors.push(`limits.budgetUsd must be >0 and ≤ ${HARD_CAPS.budgetUsd}`);
  if (maxRounds < 1 || maxRounds > HARD_CAPS.rounds) errors.push(`limits.maxRounds must be 1..${HARD_CAPS.rounds}`);
  const publishRaw = isRecord(raw.publish) ? raw.publish : undefined;
  const publishCmd = str(publishRaw?.command);
  if (raw.publish !== undefined && !publishCmd) errors.push('publish.command is required when publish is set');
  if (publishCmd && publishCmd.length > 600) errors.push('publish.command is longer than 600 characters');
  if (raw.voice !== undefined && typeof raw.voice !== 'boolean') errors.push('voice must be true or false');
  if (errors.length > 0 || !goal || !pattern) return { ok: false, errors, warnings };
  return {
    ok: true, errors, warnings,
    spec: {
      api: ORCHESTRATION_API, goal, pattern, workers, tasks,
      reduce: { method, success },
      layout: { grid, spotlight, ...(str(layoutRaw.workspace) ? { workspace: str(layoutRaw.workspace)! } : {}) },
      limits: { maxParallel: Math.floor(maxParallel), timeoutSec: Math.floor(timeoutSec), budgetUsd, maxRounds: Math.floor(maxRounds) },
      ...(raw.voice === true ? { voice: true } : {}),
      ...(publishCmd ? { publish: { command: publishCmd, ...(str(publishRaw?.title) ? { title: str(publishRaw?.title)! } : {}) } } : {}),
    },
  };
}

/** Success criteria the runner can judge: all-ok · contains:<text> · min-length:<n> · min-items:<n> · llm-judge[:<question>]. */
export function successCriterionError(c: string): string | undefined {
  if (c === 'all-ok' || c === 'llm-judge' || c.startsWith('llm-judge:')) return undefined;
  if (c.startsWith('contains:')) return c.slice(9).trim() ? undefined : 'contains: needs text';
  const m = /^(min-length|min-items):\s*(\d+)$/u.exec(c);
  if (m) return undefined;
  return `unknown criterion ${JSON.stringify(c)} — use all-ok | contains:<text> | min-length:<n> | min-items:<n> | llm-judge[:<question>]`;
}

export function parseSpecYaml(text: string): ValidationResult {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (error) { return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`], warnings: [] }; }
  return validateSpec(raw);
}

export function specToYaml(spec: OrchestrationSpec): string {
  return stringifyYaml(spec, { lineWidth: 120 });
}
