/**
 * Task Orchestrator — core type module
 *
 * Origin: `내부 문서 `PLAN-session-task-orchestrator-coevolution`` §3.1
 * Session: TOX-1 foundation · Phase 1 (types only)
 *
 * The shapes here are **data-only**. No IO, no LLM call, no side
 * effects. Graph / scheduler / dispatcher modules consume them.
 *
 * Naming: `Task` / `TaskExecution` collide with nothing in src because
 * `src/scheduler/types.ts` uses the `Scheduler*`/`ScheduledJob` prefix
 * and `TaskMeta`/`TaskPriority`/`TaskIsolation` are re-exported here
 * as single source of truth.
 */
// Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — TaskPriority /
// TaskIsolation 을 task-orchestrator 자체 정의로 흡수 (이전에는 src/scheduler/
// types.ts 에서 import). V2.2-8 의 `src/scheduler/**` 17 파일 삭제 cascade
// 의 사전 dep 정리.
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskIsolation = 'shared' | 'worktree';

// ───────────────────────── Status ────────────────────────────────────

/**
 * Lifecycle of a Task. Values are persisted (SQLite) and LLM-visible
 * via `TaskList` / `TaskGet`, so additions need migration planning.
 *
 * Transitions (legal):
 *
 *   backlog     → blocked | ready | cancelled | superseded
 *   blocked     → ready | cancelled | superseded
 *   scheduled   → ready | cancelled
 *   ready       → running | cancelled | superseded
 *   running     → review | failed | cancelled
 *   review      → done | failed
 *   done        → (terminal)
 *   failed      → ready (retry)  | cancelled | superseded
 *   cancelled   → (terminal)
 *   superseded  → (terminal; history only)
 */
export type TaskStatus =
  | 'backlog'
  | 'blocked'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'blocked',
  'scheduled',
  'ready',
  'running',
  'review',
  'done',
  'failed',
  'cancelled',
  'superseded',
];

/** Statuses considered "open" — graph still cares about them. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'blocked',
  'scheduled',
  'ready',
  'running',
  'review',
];

/** Statuses considered "terminal" — no more transitions. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'done',
  'failed',
  'cancelled',
  'superseded',
];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

export function isOpenStatus(s: TaskStatus): boolean {
  return (OPEN_TASK_STATUSES as readonly string[]).includes(s);
}

export function isTerminalStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s);
}

// ──────────────────── Deterministic checks ──────────────────────────

/**
 * Post-execution gates. When all pass, task moves to `done`. When any
 * fail, task moves to `failed` (retry-eligible if `attempt < maxRetries`).
 *
 * Designed so the dispatcher can evaluate them synchronously (no LLM
 * call). `acceptance.criteria` (natural-language) is evaluated by an
 * LLM review phase and is cheaper — but less reliable — and only runs
 * after deterministic checks are all green.
 */
export type TaskDeterministicCheck =
  | { kind: 'exit-code'; expected: number }
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-contains'; path: string; pattern: string }
  | { kind: 'output-matches'; pattern: string }
  | { kind: 'shell-zero'; command: string; timeoutMs?: number };

export const DETERMINISTIC_CHECK_KINDS = [
  'exit-code',
  'file-exists',
  'file-contains',
  'output-matches',
  'shell-zero',
] as const;

export function isTaskDeterministicCheck(v: unknown): v is TaskDeterministicCheck {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== 'string') return false;
  switch (o.kind) {
    case 'exit-code':
      return typeof o.expected === 'number' && Number.isInteger(o.expected);
    case 'file-exists':
      return typeof o.path === 'string' && o.path.length > 0;
    case 'file-contains':
      return typeof o.path === 'string' && typeof o.pattern === 'string';
    case 'output-matches':
      return typeof o.pattern === 'string';
    case 'shell-zero':
      return typeof o.command === 'string' && (o.timeoutMs === undefined || typeof o.timeoutMs === 'number');
    default:
      return false;
  }
}

export interface TaskAcceptance {
  /** Natural-language criteria evaluated in `review` phase by an LLM. */
  criteria: string[];
  /** Deterministic gates — evaluated first, synchronous when possible. */
  checks?: TaskDeterministicCheck[];
}

export interface ReviewVerdict {
  criterionIndex: number;
  passed: boolean;
  reason: string;
  reviewerTaskId?: string;
  timestamp: number;
}

// ──────────────────────── Surface ────────────────────────────────────

/**
 * Terminal spawn spec — keep loose so TOX doesn't import the full
 * terminal-matrix module at type-check time. Dispatcher bridges to
 * `matrix.spawn` in Phase 2.
 */
export interface TerminalSpawnLite {
  title?: string;
  cwd?: string;
  command?: string;
  shellArgs?: readonly string[];
  env?: Record<string, string>;
  character?: { kind: 'shell' | 'claude-code' | 'codex' | 'custom'; name?: string };
  transport?: { kind: 'local' | 'tailscale' | 'ssh'; host?: string; user?: string; port?: number };
  visibility?: 'user' | 'both' | 'llm-only';
  metadata?: Record<string, unknown>;
}

/**
 * AskUserQuestion-compatible shape — dispatcher forwards to the
 * real runtime. Kept minimal so this module stays IO-free.
 */
export interface ChatPromptSpec {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  includeOther?: boolean;
}

/** AXON P6 — known ACP agent brands. Adding a brand requires a
 *  backend-registry entry + sidebar AgentKind mapping. `elanous-self`
 *  represents the server-side path (parent IDE drives our elanous);
 *  the three client brands are the external agents we drive. */
export type AcxAgentBrand = 'claude-code' | 'codex' | 'gemini-cli' | 'elanous-self';

export const ACX_AGENT_BRANDS: readonly AcxAgentBrand[] = [
  'claude-code', 'codex', 'gemini-cli', 'elanous-self',
];

export function isAcxAgentBrand(v: unknown): v is AcxAgentBrand {
  return typeof v === 'string' && (ACX_AGENT_BRANDS as readonly string[]).includes(v);
}

/**
 * Where a task actually runs. Eight variants — adding one requires a
 * dispatcher switch case. Picked by the LLM in TaskGenerator (PLAN
 * §3.3) so the dispatcher never decides policy.
 *
 * AXON P6 (2026-04-20) — `acx-session` added as the 8th variant for
 * running tasks inside an ACP (AgentClientProtocol) session, either
 * an external agent we drive (claude-code / codex / gemini-cli) or
 * our own server session an external IDE has spawned ('elanous-self').
 */
export type TaskSurface =
  | { kind: 'terminal-pane'; spec: TerminalSpawnLite }
  | { kind: 'vw-slot'; windowId: string; slotId: string }
  | { kind: 'subagent'; definitionName: string; prompt: string; model?: string }
  | { kind: 'skill'; skillName: string; args?: Record<string, unknown> }
  | { kind: 'chat-prompt'; question: ChatPromptSpec }
  | { kind: 'cron'; scheduleText: string; jobRef?: string }
  | { kind: 'llm-direct'; model?: string; prompt: string; systemPrompt?: string }
  | {
      /** AXON P6 — external / server ACP session. */
      kind: 'acx-session';
      /** DualRoleManager-resolvable id — either the namespaced form
       *  (`acp-cli:claude:sess-42` / `acp-srv:elanous-session-7`) or the
       *  raw backend session id (manager's secondary index handles
       *  both). */
      sessionId: string;
      /** Which ACP brand runs the session — drives sidebar icon,
       *  metrics attribution, and server-vs-client routing. */
      agentBrand: AcxAgentBrand;
      /** Prompt text to send. Plain string; the callable wraps this
       *  in a single `{type:'text'}` ContentBlock. */
      prompt: string;
      /** Optional model pin — overrides ctx.modelHint + agent default. */
      model?: string;
      /** Optional turn index — surfaced in metrics for multi-turn
       *  chained tasks; not functional. */
      turn?: number;
      /** Warp-style child-profile inheritance (default true). Propagates
       *  parent env to the AcpAgent subprocess minus NESTED_AGENT_
       *  ENV_BLOCKLIST. Callable reads this to set up env for spawn. */
      inheritEnv?: boolean;
      /** Permission mode for the child turn. 'plan' = no edits,
       *  'auto' = approve within whitelist, 'default' = prompt for
       *  every decision. */
      permissionMode?: 'plan' | 'auto' | 'default';
    }
  // W4 Z3 — multi-model cascade surface. Cf. ROADMAP-showroom-x-task-fabric §4 Z3.
  | {
      kind: 'showroom';
      /** Human-readable showroom title surfaced in board widgets + retros. */
      title: string;
      /** Ordered lane spec — `mode: 'sequential'` feeds each lane's output
       *  to the next; `'parallel'` runs all lanes concurrently and returns
       *  the joined transcript. Lane roles drive lane-template selection. */
      lanes: ShowroomLaneSpec[];
      /** Default `'sequential'`. */
      mode?: 'sequential' | 'parallel';
      /** Preamble injected as systemPrompt for every lane. */
      preamble?: string;
    }
  // Parallel self-dev (2026-07-21) — one job = a `elanous self implement`
  // subprocess (its own process.env → its own harness-space, so N jobs
  // fan out without clobbering each other). The adapter spawns the
  // existing CLI; the full worktree→gate→review→merge pipeline runs
  // inside the child. Cf. PLAN-parallel-self-dev-orchestrator-2026-07-21.
  | {
      kind: 'self-implement';
      /** Feature/goal text passed to `elanous self implement <feature>`. */
      feature: string;
      /** Pod queue predecessor goal ID or PR number. */
      after?: string | number;
      /** Optional base ref (branch/tag) — maps to `--base`. */
      base?: string;
      /** Auto-merge on review-clean — maps to `--auto-merge`. */
      autoMerge?: boolean;
      /** G8 — attach `auto-review` opt-in label (eligibility self-assessed) — maps to `--auto-review`. */
      autoReview?: boolean;
      /** S3 — open a draft PR via the job's own merge-decision node
       *  (HITL gate) — maps to `--open-pr`. Promotion flows through the
       *  review node so disposition is recorded internally. */
      openPr?: boolean;
      /** Draft PR (default true; emits `--no-draft` when explicitly false). */
      draft?: boolean;
    }
  // Parallel execution line (2026-07-22) — one job = a `elanous harness
  // run-detached` subprocess (dev-harness P→E→R→D, or a --domain executor:
  // web publish / invest research). Reuses dispatchRunDevHarnessDetached's
  // proven subprocess+space-isolation infra; each job gets its own
  // harness-space. Lighter than self-implement (web/invest = read-only /
  // render), so a higher concurrency cap. Cf. MANUAL-execution-harness-usage.
  | {
      kind: 'dev-harness';
      /** Objective text passed to `harness run <objective>`. */
      objective: string;
      /** Non-code domain — 'web'|'publish'|'invest'|'research'|'digest'. Omit = code. */
      domain?: string;
      /** Target — 'self' (default) or an absolute path. */
      target?: string;
      /** Autonomy — 'off'|'safe'|'on' (default resolved from objective). */
      autoDrive?: string;
      /** ★ G9 P2(2026-07-25) — auto-review 라벨 부착 인텐트. true 면 자식 `harness run-detached` 가
       *  deploy 에서 자기판단(assessAutonomyEligibility) 통과 시 auto-review 라벨을 달아 병렬 실행 라인도
       *  L3 무인 리뷰 파이프라인에 진입(단발 `harness run` 과 대칭). */
      autoReview?: boolean;
    };

export type ShowroomLaneRole = 'plan' | 'build' | 'review' | 'reflect';

export interface ShowroomLaneSpec {
  /** Lane role · drives prompt template + lane glyph in the showroom. */
  role: ShowroomLaneRole;
  /** Model id pin. Caller's LLM runner resolves the baseUrl. */
  model: string;
  /** Per-lane prompt addendum. Sequential mode appends the prior lane's
   *  output before this addendum. */
  prompt?: string;
}

export const TASK_SURFACE_KINDS = [
  'terminal-pane',
  'vw-slot',
  'subagent',
  'skill',
  'chat-prompt',
  'cron',
  'llm-direct',
  'acx-session',
  'showroom',
  'self-implement',
  'dev-harness',
] as const;

export type TaskSurfaceKind = typeof TASK_SURFACE_KINDS[number];

export function isTaskSurfaceKind(v: unknown): v is TaskSurfaceKind {
  return typeof v === 'string' && (TASK_SURFACE_KINDS as readonly string[]).includes(v);
}

export function isTaskSurface(v: unknown): v is TaskSurface {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!isTaskSurfaceKind(o.kind)) return false;
  switch (o.kind) {
    case 'terminal-pane':
      return typeof o.spec === 'object' && o.spec !== null;
    case 'vw-slot':
      return typeof o.windowId === 'string' && typeof o.slotId === 'string';
    case 'subagent':
      return typeof o.definitionName === 'string' && typeof o.prompt === 'string';
    case 'skill':
      return typeof o.skillName === 'string' && o.skillName.length > 0;
    case 'chat-prompt':
      return typeof o.question === 'object' && o.question !== null;
    case 'cron':
      return typeof o.scheduleText === 'string' && o.scheduleText.length > 0;
    case 'llm-direct':
      return typeof o.prompt === 'string' && o.prompt.length > 0;
    case 'acx-session':
      return typeof o.sessionId === 'string' && o.sessionId.length > 0
        && isAcxAgentBrand(o.agentBrand)
        && typeof o.prompt === 'string' && o.prompt.length > 0;
    case 'showroom':
      return typeof o.title === 'string' && o.title.length > 0
        && Array.isArray(o.lanes) && o.lanes.length > 0
        && o.lanes.every((l) => isShowroomLaneSpec(l));
    case 'self-implement':
      return typeof o.feature === 'string' && o.feature.length > 0;
    case 'dev-harness':
      return typeof o.objective === 'string' && o.objective.length > 0;
    default:
      return false;
  }
}

const SHOWROOM_LANE_ROLES: readonly ShowroomLaneRole[] = ['plan', 'build', 'review', 'reflect'];

export function isShowroomLaneSpec(v: unknown): v is ShowroomLaneSpec {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.role === 'string'
    && (SHOWROOM_LANE_ROLES as readonly string[]).includes(o.role)
    && typeof o.model === 'string' && o.model.length > 0
    && (o.prompt === undefined || typeof o.prompt === 'string');
}

/** Display glyph used by board widgets + loop-prompt. */
export function surfaceGlyph(kind: TaskSurfaceKind): string {
  switch (kind) {
    case 'terminal-pane': return '▶';
    case 'vw-slot':       return '▣';
    case 'subagent':      return '◆';
    case 'skill':         return '✦';
    case 'chat-prompt':   return '❓';
    case 'cron':          return '⏰';
    case 'llm-direct':    return '✎';
    case 'acx-session':   return '⊛';
    case 'showroom':      return '✺';
    case 'self-implement': return '⚒';
    case 'dev-harness':   return '⚙';
  }
}

// ──────────────────── Provenance ─────────────────────────────────────

export type TaskGeneratedBy =
  | { kind: 'user'; actorId?: string }
  | { kind: 'llm'; modelId?: string; turn?: number }
  | { kind: 'cron'; jobRef: string }
  | { kind: 'followUp'; parentTaskId: string }
  | { kind: 'regenerate'; parentTaskId?: string; depth: number }
  | { kind: 'external'; provider: 'asana' | 'linear' | 'telegram' | 'github' | 'agent-plugin' | 'intake' | 'other'; ref: string; url?: string };

export type ExternalTaskSource = Extract<TaskGeneratedBy, { kind: 'external' }>;
export interface TaskApproval {
  /** pending = waits for a person · auto = matched a `tox.external.autoRun` rule ·
   *  approved = a person approved it (`POST /v1/tasks/:id/approve`). */
  state: 'pending' | 'auto' | 'approved';
  /** The autoRun rule that matched (state `auto` only). */
  rule?: string;
  /** Who approved it (state `approved` only). */
  approvedBy?: 'manual';
  approvedAt?: number;
  fingerprint?: string;
}

// ──────────────────── Task ───────────────────────────────────────────

/** Hard caps — single source of truth. */
export const TASK_DEFAULTS = {
  maxRetries: 2,
  triggerChainMaxHops: 5,
  decomposeMaxDepth: 4,
  titleMaxLen: 80,
  descriptionMaxLen: 4000,
} as const;

export interface Task {
  readonly id: string;             // 'task:<hex>' — element-registry addressable
  readonly createdAt: number;      // epoch ms
  updatedAt: number;
  readonly version: number;        // bumped on regenerate; supersede path preserves history

  title: string;                   // imperative, ≤ titleMaxLen
  description: string;
  surface: TaskSurface;

  // graph position
  parentId?: string;
  goalSlug?: string;               // S2 auto-research goal binding
  /** Phase 1 I6 — reverse pointer to the parent Mission (when this task
   *  was generated as part of an intake decomposition). The Mission row
   *  remains the source of truth (`Mission.taskIds`); this pointer is a
   *  denormalised cache for O(1) lookups. */
  missionId?: string;
  dependsOn: readonly string[];    // must be `done` before this task becomes `ready`
  triggers?: readonly string[];    // hint — inverse index

  // classification
  priority: TaskPriority;          // 'low' | 'medium' | 'high' | 'urgent'
  estimateMs?: number;
  estimateTokens?: number;
  estimateUsd?: number;
  featureName?: string;

  // execution hints
  isolation: TaskIsolation;        // 'shared' | 'worktree'
  maxRetries: number;              // ≥ 0. Default 2.
  attempt: number;                 // 0 on first run
  timeoutMs?: number;

  // status
  status: TaskStatus;
  scheduleText?: string;
  schedulerJobId?: string;
  lastExecutionId?: string;
  acceptance?: TaskAcceptance;
  reviewVerdicts?: ReviewVerdict[];
  notes: string[];                 // [ATTEMPT N] / [LEARNING] lines, append-only

  // provenance
  generatedBy?: TaskGeneratedBy;
  approval?: TaskApproval;
  triggerChain: readonly string[]; // parent taskIds (hop ≤ 5)

  /** Cascade-zyu Z0 (2026-05-12) — optional anchor to an existing
   *  Showroom session, used by the PWA "Open in showroom" jump on
   *  `/tasks/<id>` and the inverse "Save as task" round-trip on
   *  `/showroom`. Distinct from `surface.kind === 'showroom'` (W4 Z3 —
   *  TaskSurface 9, which makes the task itself run inside a
   *  showroom): this field links a Task to a *separate* showroom
   *  session for review / cross-reference. */
  showroomSessionId?: string;
}

export interface TaskInit {
  title: string;
  description?: string;
  surface: TaskSurface;
  parentId?: string;
  goalSlug?: string;
  missionId?: string;
  dependsOn?: readonly string[];
  triggers?: readonly string[];
  priority?: TaskPriority;
  estimateMs?: number;
  estimateTokens?: number;
  estimateUsd?: number;
  featureName?: string;
  isolation?: TaskIsolation;
  maxRetries?: number;
  timeoutMs?: number;
  acceptance?: TaskAcceptance;
  generatedBy?: TaskGeneratedBy;
  approval?: TaskApproval;
  triggerChain?: readonly string[];
  /** Optional override — default is `'backlog'`. */
  status?: TaskStatus;
  scheduleText?: string;
  schedulerJobId?: string;
  /** Cascade-zyu Z0 — see {@link Task.showroomSessionId}. */
  showroomSessionId?: string;
}

// ──────────────────── TaskExecution ─────────────────────────────────

export type TaskExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface TaskExecution {
  readonly id: string;             // 'exec:<hex>'
  readonly taskId: string;
  readonly startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TaskExecutionStatus;
  surface: TaskSurface;
  /**
   * Runtime address — e.g. `term:5` / `pane:abc` / `agent:plan` /
   * `skill:omni-crawl`. Unset when execution is pending spawn.
   */
  surfaceAddress?: string;
  output?: string;                 // ≤ 4 KB tail; larger goes to outputPath
  /** The agent ran, but its reported outcome needs human review rather than automatic completion. */
  reviewRequired?: boolean;
  outputPath?: string;
  error?: { code: string; message: string; stack?: string };
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  modelId?: string;
  hostId?: string;
  hostname?: string;
}

// ──────────────────── Factories ─────────────────────────────────────

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // globalThis.crypto is available in Bun + modern Node (>=19). Falls
  // back to a weak RNG so test harnesses that stub crypto still work.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newTaskId(): string {
  return `task:${randomHex(6)}`;
}

export function newExecutionId(): string {
  return `exec:${randomHex(6)}`;
}

export function isTaskId(v: unknown): v is string {
  return typeof v === 'string' && /^task:[0-9a-f]{2,16}$/.test(v);
}

export function isExecutionId(v: unknown): v is string {
  return typeof v === 'string' && /^exec:[0-9a-f]{2,16}$/.test(v);
}

/**
 * Build a Task with sensible defaults. Pure — no IO, no clock read
 * beyond `Date.now()`.
 *
 * Throws `RangeError` when constraints are violated (title length,
 * maxRetries negative, triggerChain > 5 hops, etc.) so callers fail
 * fast rather than persist corrupt rows.
 *
 * TOX-6 FU-2: `priority: 'urgent'` requires at least one
 * `acceptance.checks` or `acceptance.criteria` entry — critical work
 * without a verification gate is treated as an authoring error.
 * Override with `opts.allowUncheckedUrgent: true` for exceptional
 * cases; this still appends a warning note so downstream reviewers
 * see the choice.
 */
export function createTask(
  init: TaskInit,
  opts?: { now?: number; id?: string; allowUncheckedUrgent?: boolean },
): Task {
  const now = opts?.now ?? Date.now();
  if (!init.title || init.title.length === 0) {
    throw new RangeError('Task.title must be non-empty');
  }
  if (init.title.length > TASK_DEFAULTS.titleMaxLen) {
    throw new RangeError(`Task.title exceeds ${TASK_DEFAULTS.titleMaxLen} chars`);
  }
  if (init.description && init.description.length > TASK_DEFAULTS.descriptionMaxLen) {
    throw new RangeError(`Task.description exceeds ${TASK_DEFAULTS.descriptionMaxLen} chars`);
  }
  if (!isTaskSurface(init.surface)) {
    throw new RangeError('Task.surface: invalid tagged union');
  }
  const maxRetries = init.maxRetries ?? TASK_DEFAULTS.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('Task.maxRetries must be a non-negative integer');
  }
  const triggerChain = init.triggerChain ?? [];
  if (triggerChain.length > TASK_DEFAULTS.triggerChainMaxHops) {
    throw new RangeError(
      `Task.triggerChain length ${triggerChain.length} exceeds ${TASK_DEFAULTS.triggerChainMaxHops}-hop guard`
    );
  }
  const priority = init.priority ?? 'medium';
  const checksLen = init.acceptance?.checks?.length ?? 0;
  const criteriaLen = init.acceptance?.criteria?.length ?? 0;
  let initialNotes: string[] = [];
  if (priority === 'urgent' && checksLen === 0 && criteriaLen === 0) {
    if (!opts?.allowUncheckedUrgent) {
      throw new RangeError(
        'Task.priority=urgent requires at least one acceptance.checks or acceptance.criteria entry ' +
          '(pass { allowUncheckedUrgent: true } to override)',
      );
    }
    initialNotes = ['[WARN] urgent task created without acceptance gate — override used'];
  }
  return {
    id: opts?.id ?? newTaskId(),
    createdAt: now,
    updatedAt: now,
    version: 1,
    title: init.title,
    description: init.description ?? '',
    surface: init.surface,
    parentId: init.parentId,
    goalSlug: init.goalSlug,
    missionId: init.missionId,
    dependsOn: Object.freeze([...(init.dependsOn ?? [])]),
    triggers: init.triggers ? Object.freeze([...init.triggers]) : undefined,
    priority: init.priority ?? 'medium',
    estimateMs: init.estimateMs,
    estimateTokens: init.estimateTokens,
    estimateUsd: init.estimateUsd,
    featureName: init.featureName,
    isolation: init.isolation ?? 'shared',
    maxRetries,
    attempt: 0,
    timeoutMs: init.timeoutMs,
    status: init.status ?? 'backlog',
    scheduleText: init.scheduleText,
    schedulerJobId: init.schedulerJobId,
    acceptance: init.acceptance,
    notes: initialNotes,
    generatedBy: init.generatedBy,
    approval: init.approval,
    triggerChain: Object.freeze([...triggerChain]),
    showroomSessionId: init.showroomSessionId,
  };
}

export function createExecution(
  task: Task,
  opts?: { now?: number; id?: string; modelId?: string }
): TaskExecution {
  return {
    id: opts?.id ?? newExecutionId(),
    taskId: task.id,
    startedAt: opts?.now ?? Date.now(),
    status: 'running',
    surface: task.surface,
    modelId: opts?.modelId,
  };
}

// ──────────────────── Showroom anchor (cascade-zyu Z0) ───────────────

/**
 * Return a new Task with `showroomSessionId` set. Bumps `updatedAt`
 * unless the id is unchanged (idempotent). PWA "Save as task" round-
 * trip + future PATCH endpoint use this so the SQLite store sees a
 * clean immutable update.
 */
export function linkShowroomSessionToTask(
  task: Task,
  showroomSessionId: string,
  opts?: { now?: number },
): Task {
  if (!showroomSessionId || showroomSessionId.length === 0) {
    throw new RangeError('showroomSessionId must be non-empty');
  }
  if (task.showroomSessionId === showroomSessionId) return task;
  const now = opts?.now ?? Date.now();
  return { ...task, showroomSessionId, updatedAt: now };
}

/** Return a new Task with the showroom anchor cleared. No-op when
 *  already unset. */
export function unlinkShowroomSessionFromTask(
  task: Task,
  opts?: { now?: number },
): Task {
  if (task.showroomSessionId === undefined) return task;
  const { showroomSessionId: _drop, ...rest } = task;
  const now = opts?.now ?? Date.now();
  return { ...rest, updatedAt: now };
}

// ──────────────────── Serialization helpers ────────────────────────

/**
 * Project a Task to a JSON-safe shape. Currently identity — Task is
 * designed to be serialization-friendly — but the indirection gives
 * the SQLite store a stable hook if future fields contain Dates etc.
 */
export function serializeTask(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    version: t.version,
    title: t.title,
    description: t.description,
    surface: t.surface,
    parentId: t.parentId,
    goalSlug: t.goalSlug,
    missionId: t.missionId,
    dependsOn: [...t.dependsOn],
    triggers: t.triggers ? [...t.triggers] : undefined,
    priority: t.priority,
    estimateMs: t.estimateMs,
    estimateTokens: t.estimateTokens,
    estimateUsd: t.estimateUsd,
    featureName: t.featureName,
    isolation: t.isolation,
    maxRetries: t.maxRetries,
    attempt: t.attempt,
    timeoutMs: t.timeoutMs,
    status: t.status,
    scheduleText: t.scheduleText,
    schedulerJobId: t.schedulerJobId,
    lastExecutionId: t.lastExecutionId,
    acceptance: t.acceptance,
    reviewVerdicts: t.reviewVerdicts,
    notes: [...t.notes],
    generatedBy: t.generatedBy,
    approval: t.approval,
    triggerChain: [...t.triggerChain],
    showroomSessionId: t.showroomSessionId,
  };
}
