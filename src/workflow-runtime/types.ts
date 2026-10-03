// Archon-port T2.1 (2026-05-08) — workflow runtime types.
//
// Mini DAG executor. Source pattern: Archon
// `packages/workflows/src/{schemas,executor}.ts`. elanous subset:
// 5 node types (prompt | bash | skill | cft | approval) and
// `depends_on` + `when` + `trigger_rule` topology.

import type { ToolPolicy } from '../tool-runtime/tool-policy.js';
import type { CapabilityRequirements } from '../registry/resolver.js';

export type { CapabilityRequirements } from '../registry/resolver.js';

/** Result of a single node's execution. `output` is whatever the node
 *  produced (bash stdout, prompt LLM text, parsed JSON via output_format,
 *  CFT method return, skill executeSkill display, approval response). */
export interface NodeOutput {
  /** Raw output value. Strings for bash/prompt-without-output_format,
   *  arbitrary JSON when output_format is set, structured for cft/skill. */
  output: unknown;
  /** Whether the node succeeded. Failed nodes still produce an output
   *  (typically an error message string) so downstream `when` clauses
   *  can branch on `$<id>.error`. */
  ok: boolean;
  /** Error message when ok=false. */
  error?: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Run id of the workflow called by a subworkflow node, including failures. */
  childRunId?: string;
}

/** Lifecycle event streamed during workflow execution. Consumers
 *  (PWA SSE, CLI, tests) listen and render. */
export type WorkflowRunMode = 'full' | 'only' | 'from' | 'test';

export type WorkflowEvent = (
  | { type: 'workflow_start'; workflow: string; runId: string }
  | { type: 'node_start'; nodeId: string; nodeType: string; childRunId?: string }
  | { type: 'node_skipped'; nodeId: string; reason: string }
  | { type: 'node_done'; nodeId: string; result: NodeOutput; childRunId?: string }
  | { type: 'workflow_done'; outputs: Record<string, NodeOutput> }
  | { type: 'workflow_failed'; error: string; partial: Record<string, NodeOutput> }
) & { mode?: WorkflowRunMode };

/** Trigger rule semantics for a node with multiple `depends_on` edges:
 *  - all_success: every dep must have ok=true (strict — Archon default)
 *  - one_success: at least one dep ok=true (parallel try / first wins)
 *  - all_done: every dep finished (regardless of ok) — gather pattern */
export type TriggerRule = 'all_success' | 'one_success' | 'all_done';

/** Common fields shared by every node. */
export interface DagNodeBase {
  id: string;
  depends_on?: string[];
  when?: string;
  trigger_rule?: TriggerRule;
  /** Run this node on failure; the failed NodeOutput is available as $<id>.output / $<id>.error. */
  on_error?: string;
  model?: string;
  provider?: string;
  /** ToolPolicy (T1.1). Same wire format as skill manifest. */
  allowed_tools?: string[];
  denied_tools?: string[];
  output_format?: Record<string, unknown>;
  idle_timeout?: number;
  /** RFC #2161 Phase 3 — declared capability requirements. The
   *  executor blocks the node when the resolved (provider, model) does
   *  not satisfy every clause and surfaces a precise unmet-capability
   *  error so workflow authors can pick a compatible model up-front
   *  instead of debugging a silent runtime failure. */
  requires?: CapabilityRequirements;
  /** Optional declarative supervision contract. When absent, the node follows
   *  its existing execution path unchanged. */
  judgment?: string;
  cadence?: 'once' | 'always' | 'on-signal' | 'scheduled';
  observes?: string[];
  vocabulary?: string[];
  executions?: string[];
}

export interface PromptNode extends DagNodeBase {
  prompt: string;
}
export interface BashNode extends DagNodeBase {
  bash: string;
}
export interface SkillNode extends DagNodeBase {
  skill: string;
  arguments?: string;
}
export interface CftNode extends DagNodeBase {
  cft: string;
  config?: Record<string, unknown>;
}
/** Node-catalog N1.1 (2026-05-11) — boolean branch node. The
 *  condition is evaluated with the same parser as `when` (see
 *  `evaluateWhen` in variables.ts), so authors can reuse familiar
 *  expressions:
 *    if: { condition: "$score.output == 'high'" }
 *  The node's output is the literal string `'then'` or `'else'`,
 *  so downstream nodes branch via:
 *    when: $route.output == 'then'
 *  Multi-handle visual rendering (Tier E1.2 LR + handle 좌우 위에) is
 *  layered later (E1.2 carries the handle convention; this PR ports
 *  the runtime). */
export interface IfNode extends DagNodeBase {
  if: {
    condition: string;
  };
}
/** Node-catalog N1.2 (2026-05-11) — N-way branch. `value` is an
 *  interpolation expression (the same surface as `$<id>.output`,
 *  `$ARGUMENTS`, `$<id>.output.field`). The matched case string is
 *  emitted as the node's output; non-matches fall through to
 *  `'default'`, so downstream branches read `when: $route.output ==
 *  'case-a'`. The cases array is kept order-stable to match user
 *  expectations on the visual editor (first match wins). */
export interface SwitchNode extends DagNodeBase {
  switch: {
    value: string;
    cases: string[];
  };
}
/** Node-catalog N1.3 (2026-05-11) — v1 sequential iteration. `items`
 *  is interpolated and resolved to an array (JSON array preferred,
 *  newline-split fallback). For each element the `body` bash snippet
 *  runs with two extra substitutions on top of the standard
 *  interpolation surface:
 *    `$item`  → the current element (JSON.stringified if non-string)
 *    `$index` → the zero-based index as a string
 *  The node's output is an array of per-iteration stdout strings; the
 *  node fails fast on the first iteration that returns a non-zero exit
 *  code. Sub-DAG iteration (full nested workflow per element) is a v2
 *  follow-up — v1 keeps the executor footprint small. */
export interface IterationNode extends DagNodeBase {
  iteration: {
    items: string;
    body: string;
  };
}
/** Node-catalog N2.1 (2026-05-11) — LLM-driven classification.
 *  Wraps the standard `callLLM` dep with a prompt that asks the model
 *  to pick exactly one of the supplied `classes`. Emits the chosen
 *  class string as output (or `'unknown'` if the model refuses to
 *  commit). Downstream nodes branch via `when: $route.output ==
 *  'class-a'`, identical to If/Switch routing. */
export interface ClassifyNode extends DagNodeBase {
  classify: {
    input: string;
    classes: string[];
    /** Optional context appended to the system prompt — e.g.
     *  domain hints ("classes are music genres"). */
    hint?: string;
    /** Node-catalog v2 (2026-05-11) — retry wrap. When > 0, the
     *  executor retries `callLLM` up to `retries` times on either
     *  a thrown error or a `'unknown'` resolution. Backoff doubles
     *  each retry, starting at `retryDelayMs` (default 250ms). */
    retries?: number;
    retryDelayMs?: number;
  };
}
/** Node-catalog N3.1 (2026-05-11) — Set / Variable Assigner. Emits a
 *  JSON object built by interpolating each value expression through
 *  the standard variable surface. Downstream nodes read fields via
 *  `$set.output.field`. Useful for collecting derived values into a
 *  single record without writing bash + jq. */
export interface SetNode extends DagNodeBase {
  set: {
    /** Field name → interpolation expression. Values are
     *  string-typed in YAML; interpolation may produce JSON-encoded
     *  output (when reading from `$node.output` of upstream prompt
     *  with `output_format` etc.) but the Set node does not parse
     *  them — the field is stored as the resolved string. */
    fields: Record<string, string>;
  };
}
/** Node-catalog N3.2 (2026-05-11) — array filter. Resolves `items` to
 *  an array (same JSON/newline-split logic as Iteration) and keeps
 *  only elements where `condition` evaluates true. The condition has
 *  `$item` and `$index` injected on top of the standard surface so
 *  authors can filter on element content. */
export interface FilterNode extends DagNodeBase {
  filter: {
    items: string;
    condition: string;
  };
}
/** Node-catalog N4.1 (2026-05-11) — Schedule trigger. v1 = schema +
 *  executor pass-through. Daemon-side cron / interval registration is
 *  deferred to a follow-up that touches `nexus/daemon/scheduler.ts` +
 *  user-config (`workflows.schedules.<name>`). The executor side runs
 *  the trigger as a manifest pass-through (output = the schedule
 *  descriptor) so workflows declaring the trigger still pass
 *  validation and can be invoked from the CLI / PWA manually. */
export interface ScheduleTriggerNode extends DagNodeBase {
  scheduleTrigger: {
    /** `cron` = standard 5-field cron expression; `interval` = ms. */
    type: 'cron' | 'interval';
    cron?: string;
    interval?: number;
    /** Surface-unification §B1 (2026-05-11) — IANA timezone for cron
     *  evaluation (e.g. `"Asia/Seoul"`). v1 = author-facing only; the
     *  daemon scheduler will respect it once the cron-source migration
     *  lands. Defaulting to the daemon host TZ when omitted. */
    timezone?: string;
    /** Surface-unification §B1 — randomized launch delay (seconds) to
     *  smear simultaneous fires. v1 = author-facing only. */
    jitter_seconds?: number;
    /** Surface-unification §B1 — stop after N successful runs. */
    max_runs?: number;
    /** Surface-unification §B1 — disable without removing the node. */
    enabled?: boolean;
  };
}
/** Node-catalog N4.2 (2026-05-11) — Webhook trigger. v1 = schema +
 *  executor pass-through. Daemon-side dynamic HTTP route registration
 *  is deferred to a follow-up that touches `src/nexus/api/http-server
 *  .ts`. The executor runs the trigger as a manifest pass-through
 *  (output = the webhook descriptor) so authors can declare the entry
 *  point now and wire daemon dispatch later without re-writing the
 *  workflow. */
export interface WebhookTriggerNode extends DagNodeBase {
  webhookTrigger: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Path under the daemon's HTTP server. Must begin with `/`. */
    path: string;
    /** v1 auth: omitted = open. `hmac` verifies a provider signature over
     *  the raw body (Linear `linear-signature` · GitHub `x-hub-signature-256`
     *  with prefix `sha256=` · Asana `x-hook-signature`). `secretRef` names a
     *  secret-store id — the secret itself never sits in the workflow YAML. */
    auth?:
      | { type: 'bearer'; token: string }
      | { type: 'basic'; username: string; password: string }
      | WebhookHmacAuth;
  };
}

export interface WebhookHmacAuth {
  type: 'hmac';
  /** Request header carrying the signature (case-insensitive). */
  header: string;
  secretRef: string;
  /** Default 'sha256'. */
  algorithm?: 'sha256' | 'sha1';
  /** Default 'hex'. */
  encoding?: 'hex' | 'base64';
  /** Literal text before the digest in the header, e.g. 'sha256='. */
  prefix?: string;
}
/** Node-catalog N4.4 (2026-05-11 · scheduler-retirement R6) — Discord
 *  trigger. v1 = schema + executor pass-through. Daemon-side AXON
 *  bridge wiring (`src/discord.ts` event tap) is deferred to a
 *  follow-up that needs cross-track NOTICE per ROADMAP §10 group G.
 *  The executor side runs as a manifest pass-through so authors can
 *  declare the trigger now. */
export interface DiscordTriggerNode extends DagNodeBase {
  discordTrigger: {
    kind: 'message' | 'mention' | 'reaction';
    /** Channel name or snowflake. Omit / use '*' for all channels. */
    channel?: string;
    /** Author filter — user id, name, or '*' for all (default '*'). */
    user?: string;
    /** Optional regex applied to message body (kind=message|mention)
     *  or emoji name (kind=reaction). */
    pattern?: string;
  };
}
/** Node-catalog N4.5 (2026-05-11 · scheduler-retirement R7) — Telegram
 *  trigger. v1 = schema + executor pass-through + daemon-side
 *  TelegramSource. AXON `src/telegram.ts` bridge wiring is deferred
 *  to a follow-up that needs cross-track NOTICE per ROADMAP §10
 *  group G. */
export interface TelegramTriggerNode extends DagNodeBase {
  telegramTrigger: {
    kind: 'message' | 'command' | 'callback_query';
    /** Chat id or username (`@my_group`). Omit / use '*' for all. */
    chat?: string;
    /** Sender filter — user id, username, or '*' (default '*'). */
    user?: string;
    /** Command name without the leading `/` (kind=command only). */
    command?: string;
    /** Optional regex applied to message body / callback_data. */
    pattern?: string;
  };
}
/** Node-catalog N4.3 (2026-05-11) — HTTP request. v1 covers
 *  method/url/headers/body + basic + bearer auth. Native `fetch`,
 *  no new dep. Returns ok=true if response status is < 400 with
 *  output = parsed JSON when content-type=application/json,
 *  raw text otherwise. */
export interface HttpRequestNode extends DagNodeBase {
  http: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    /** Optional auth shorthand. `basic` = `username:password` base64,
     *  `bearer` = `Bearer <token>`. */
    auth?:
      | { type: 'basic'; username: string; password: string }
      | { type: 'bearer'; token: string };
    /** Request timeout in milliseconds (default = node.idle_timeout
     *  or 30s). */
    timeout?: number;
  };
}
/** Node-catalog N3.3 (2026-05-11) — Handlebars-lite template
 *  transform. `template` is a free-form string with `{{ path }}`
 *  substitutions, where `path` is one of:
 *    `ARGUMENTS`             → run args
 *    `ARTIFACTS_DIR`         → artifacts dir
 *    `<id>.output`           → upstream node output (stringified)
 *    `<id>.output.field`     → JSON field access
 *  Whitespace inside `{{ ... }}` is trimmed; missing references emit
 *  empty string. No new dep — self-rolled parser.
 *  Output = rendered string. */
export interface TemplateNode extends DagNodeBase {
  template: {
    template: string;
  };
}
/** Node-catalog N2.2 (2026-05-11) — LLM-driven structured extraction.
 *  Wraps `callLLM` with a prompt that asks the model to fill in a
 *  schema of `field: 'description'` pairs. Output is the parsed JSON
 *  object — downstream nodes read `$node.output.field`. Returns
 *  `ok: false` when the model's response is not valid JSON, so
 *  authors can wire a retry/fallback branch. */
export interface ExtractNode extends DagNodeBase {
  extract: {
    input: string;
    /** Field name → short description shown to the LLM. */
    schema: Record<string, string>;
    /** Optional context appended to the system prompt. */
    hint?: string;
    /** Node-catalog v2 (2026-05-11) — retry wrap. When > 0, the
     *  executor retries `callLLM` up to `retries` times on either
     *  a thrown error or a JSON parse failure. Backoff doubles each
     *  retry, starting at `retryDelayMs` (default 250ms). */
    retries?: number;
    retryDelayMs?: number;
  };
}
export interface ApprovalNode extends DagNodeBase {
  approval: {
    message: string;
    capture_response?: boolean;
    /** archon-port BACKLOG #4 (2026-05-11) — restrict the approval to a
     *  specific HITL delivery channel. Omitted = race every registered
     *  channel (PWA modal + Pushcut + Telegram + Discord + terminal) ·
     *  the Nexus runtime's existing default. Specify e.g. `pushcut` to
     *  skip the PWA modal entirely (useful for off-device approvals
     *  where the desktop user is presumed away from the screen). */
    delivery?:
      | 'modal'
      | 'terminal'
      | 'telegram'
      | 'discord'
      | 'pushcut'
      | 'all';
  };
}

/** Surface-unification §B6 (2026-05-11 · n8n ManualTrigger port) —
 *  Manual trigger. Marks a workflow as explicitly run by the user
 *  (dry-run · "▶ Run now" from the editor · CLI `elanous wf run <name>`)
 *  rather than fired by an external source. The daemon never auto-
 *  subscribes to it — it exists so the graph has a visible entry
 *  point for the dependent chain. n8n's `maxNodes: 1` convention
 *  applies (the schema enforces only one Manual trigger per workflow).
 *
 *  Reference: ~/source/ref/n8n/packages/nodes-base/nodes/ManualTrigger
 *  /ManualTrigger.node.ts — minimal 51 LOC variant. */
export interface ManualTriggerNode extends DagNodeBase {
  manualTrigger: {
    /** Optional author-visible description rendered on the card. */
    description?: string;
  };
}

/** Surface-unification §B7 (2026-05-11 · n8n ChatTrigger v1 port) —
 *  Chat trigger v1 = webhook mode. elanous's `/chat` surface (or any
 *  external POST) can fire the workflow via the daemon route
 *  `POST /v1/workflows/<name>/chat`. v1 supports auth = none/bearer,
 *  optional per-session continuity, streaming-response opt-in. v2
 *  follow-ups (BACKLOG): hosted chat page, AI memory connection, file
 *  upload, multi-response nodes.
 *
 *  Reference: ~/source/ref/n8n/packages/@n8n/nodes-langchain/nodes/
 *  trigger/ChatTrigger/ChatTrigger.node.ts (961 LOC full version).
 *  Schema-only v1 here mirrors the executor pass-through pattern of
 *  the other trigger nodes — daemon-side dynamic HTTP route + ACP
 *  streaming bridge land in a follow-up. */
export interface ChatTriggerNode extends DagNodeBase {
  chatTrigger: {
    /** Path under the daemon, e.g. `/research/chat`. Must start with `/`. */
    path: string;
    /** v1 auth: omitted = open. */
    auth?:
      | { type: 'bearer'; token: string };
    /** `per-session` reuses runId per chat session id; `stateless`
     *  spawns a fresh run per message (default = stateless). */
    sessionMode?: 'stateless' | 'per-session';
    /** When true, the workflow's last-node output is streamed back to
     *  the caller as Server-Sent Events. Default = false (single JSON
     *  response). v1 daemon support = follow-up. */
    streaming?: boolean;
    /** V2.2-2 (2026-05-12) — hosted chat UI opt-in. When `enabled`,
     *  the PWA exposes a self-contained chat page at
     *  `/app/workflows/chat-ui/?workflow=<name>&token=<bearer>` (the
     *  HANDOFF specified `/workflows/<name>/chat-ui` path-style; the
     *  static-export PWA can't pre-generate dynamic routes, so query
     *  params carry the workflow name). The bearer also gates the
     *  underlying `POST /v1/workflows/chat/<path>` so external users
     *  share one link + one secret. URL leak = auth leak — the page
     *  carries a banner reminder. */
    hostedUi?: {
      enabled: boolean;
      /** Optional bearer token. When omitted, falls back to
       *  `auth.token` if present, else no auth gate. */
      bearer?: string;
    };
  };
}

// W6 Z8 · multi-model cascade as a workflow node. Cf. ROADMAP §4 Z8.
export type ShowroomAggregator =
  | 'majority'
  | 'vote_with_reasoning'
  | 'first-finalize'
  | 'unanimous-or-escalate';

export type ShowroomLaneRoleNode = 'plan' | 'build' | 'review' | 'reflect';

export interface ShowroomLaneSpecNode {
  role: ShowroomLaneRoleNode;
  model: string;
  prompt: string;
}

export interface ShowroomNode extends DagNodeBase {
  showroom: {
    title?: string;
    lanes: ShowroomLaneSpecNode[];
    aggregator: ShowroomAggregator;
    mode?: 'sequential' | 'parallel';
  };
}

/** TOX task from a workflow (RFC external tasks §A8 · X5b). Every field is
 *  interpolated. `external` is required — a workflow task always carries
 *  where it came from, and therefore waits for approval like any other
 *  external task unless `tox.external.autoRun` matches. */
export interface TaskNode extends DagNodeBase {
  task: {
    title: string;
    description?: string;
    /** low | medium | high (urgent needs acceptance checks — not here). */
    priority?: string;
    /** Idempotency key for the event that produced this task. */
    eventId?: string;
    external: {
      /** asana | linear | telegram | github | other */
      provider: string;
      ref: string;
      url?: string;
      project?: string;
      team?: string;
      assignee?: string;
    };
  };
}

export interface WorkflowTaskRequest {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  eventId?: string;
  external: { provider: string; ref: string; url?: string; project?: string; team?: string; assignee?: string };
}

export interface WorkflowTaskResult {
  taskId?: string;
  deduplicated?: boolean;
  /** Why no task was created (validation or TOX unavailable). */
  error?: string;
}

/** Invoke a discovered workflow as one node. */
export interface SubworkflowNode extends DagNodeBase {
  kind: 'subworkflow';
  workflow: string;
  /** Input name → expression interpolated against the parent's outputs. */
  inputs: Record<string, string>;
}

/** Plugin node. `kind` is `<plugin>:<kind>` registered in the graph-kinds registry.
 *  The body lives on the registry entry's `run`, not on the node. */
export interface PluginKindNode extends DagNodeBase {
  kind: string;
  inputs: Record<string, unknown>;
}

export type DagNode =
  | (PromptNode & { kind?: undefined })
  | (BashNode & { kind?: undefined })
  | (SkillNode & { kind?: undefined })
  | (CftNode & { kind?: undefined })
  | (ApprovalNode & { kind?: undefined })
  | (IfNode & { kind?: undefined })
  | (SwitchNode & { kind?: undefined })
  | (IterationNode & { kind?: undefined })
  | (ClassifyNode & { kind?: undefined })
  | (ExtractNode & { kind?: undefined })
  | (SetNode & { kind?: undefined })
  | (FilterNode & { kind?: undefined })
  | (TemplateNode & { kind?: undefined })
  | (HttpRequestNode & { kind?: undefined })
  | (ShowroomNode & { kind?: undefined })
  | (TaskNode & { kind?: undefined })
  | (ScheduleTriggerNode & { kind?: undefined })
  | (WebhookTriggerNode & { kind?: undefined })
  | (DiscordTriggerNode & { kind?: undefined })
  | (TelegramTriggerNode & { kind?: undefined })
  | (ManualTriggerNode & { kind?: undefined })
  | (ChatTriggerNode & { kind?: undefined })
  | SubworkflowNode
  | PluginKindNode;

/** M4-3.2 (FU8 PR #8 · 2026-05-12) — provenance metadata stamped on
 *  workflows generated by the intake pipeline. Lets the M4-3
 *  endpoint (`/v1/intake/missions/<id>`) join workflows back to
 *  their parent mission + originating intake row without needing
 *  a sidecar mapping store. All fields optional — workflows
 *  authored by hand have `_meta` absent entirely. */
export interface WorkflowMeta {
  /** Owning mission URN — `mission:<slug>` format (slug = the
   *  TOX Mission row's id). Conservative path: schema-only, no KGS
   *  cross-link (KGS Mission entity wiring is BACKLOG per FU8
   *  feature doc §5). */
  missionId?: string;
  /** Originating intake submission id (`/v1/intake/pipeline-{preview,
   *  commit}` request body's `intakeId`). Same source as the
   *  intake-runs aggregate row. */
  intakeId?: string;
  /** Originating task key (`m-<n>/t-<n>`) within the decomposition.
   *  Useful when several workflows share the same missionId but
   *  trace to different tasks. */
  sourceTaskKey?: string;
}

/** Top-level workflow definition. */
export interface WorkflowDefinition {
  name: string;
  description: string;
  provider?: string;
  model?: string;
  interactive?: boolean;
  /** Maximum simultaneous nodes (1 by default, at most 8). */
  concurrency?: number;
  nodes: DagNode[];
  /** M4-3.2 — optional provenance block. See `WorkflowMeta`. */
  _meta?: WorkflowMeta;
}

/** Source descriptor for a discovered workflow. */
export interface WorkflowSource {
  /** 'project' (`<cwd>/.elanous/workflows/`), 'global' (`~/.elanous/workflows/`),
   *  or 'builtin' (`samples/workflows/`). */
  source: 'project' | 'global' | 'builtin';
  /** Absolute path to the YAML file. */
  path: string;
}

export interface WorkflowEntry {
  source: WorkflowSource;
  definition: WorkflowDefinition;
}

/** Inputs to a single node's executor. */
export interface NodeExecContext {
  /** User-provided arguments passed to `elanous workflow run <name> "<args>"`. */
  arguments: string;
  /** Run-scoped artifacts directory (auto-created). */
  artifactsDir: string;
  /** Map of completed node outputs (id → result). */
  outputs: Record<string, NodeOutput>;
  /** Workflow-level provider/model + node overrides resolved. */
  resolvedProvider: string | undefined;
  resolvedModel: string | undefined;
  /** Per-node tool policy (composed from workflow + node `allowed_tools`/`denied_tools`). */
  toolPolicy: ToolPolicy;
  /** Optional abort signal (forwarded to bash / LLM calls). */
  signal?: AbortSignal;
  /** Optional environment for bash nodes. */
  env?: NodeJS.ProcessEnv;
  /** Current screen observation, supplied only to judgment nodes that declare it. */
  screen?: unknown;
  /** Surface-unification v2.2 (V2.2-1 · 2026-05-12) — token streaming
   *  hook. Prompt-shaped nodes (prompt · classify · extract) forward
   *  each partial LLM chunk to this callback so streaming triggers
   *  (chat trigger SSE) can emit `event: token` frames. Closure-bound
   *  to the executing nodeId by the executor so consumers can attribute
   *  chunks. Omitted when no streaming consumer is attached. */
  onTokenChunk?: (chunk: string) => void;
}

/** Run options. */
export interface RunWorkflowOpts {
  workflow: WorkflowDefinition;
  arguments: string;
  /** Auto-created if omitted: `<root>/<runId>/artifacts/` where `<root>`
   *  defaults to `~/.elanous/workflows-runs/` but can be overridden via
   *  the `ELANOUS_WORKFLOWS_RUNS_DIR` env var (HANDOFF §4.4). */
  artifactsDir?: string;
  /** Parent directory holding `artifacts/`, `nodes/`, and `run.json`.
   *  Default: `<root>/<runId>/` where `<root>` is
   *  `ELANOUS_WORKFLOWS_RUNS_DIR` (when set) or `~/.elanous/workflows-runs/`.
   *  When set (default or explicit), the executor persists per-node
   *  outputs and a final run summary to disk so the run survives
   *  process restarts and can be inspected post-mortem. Tests that
   *  pass only `artifactsDir` (without `runDir`) opt out of this
   *  persistence to keep their fixtures hermetic. */
  runDir?: string;
  /** Force-disable disk persistence even when runDir resolves. Default:
   *  follows the runDir signal (persist when runDir is set or
   *  defaulted; skip when only artifactsDir is overridden). */
  persistRun?: boolean;
  signal?: AbortSignal;
  /** Current screen observation for judgment nodes that explicitly request it. */
  screen?: unknown;
  /** Run-scoped observations supplied only to judgment nodes that declare them. */
  judgmentContext?: Omit<JudgmentContext, 'goal' | 'outcome' | 'lifecycle' | 'screen'>;
  /** Override the runId (default: `wf-<unix-ms>-<rnd6>`). */
  runId?: string;
  /** Execute just this node, without running its upstream dependencies. */
  onlyNode?: string;
  /** Resume at this node using node results from a completed prior run. */
  fromNode?: string;
  previousOutputs?: Record<string, NodeOutput>;
  /** Active workflow names, propagated only to child runs for cycle protection. */
  workflowStack?: string[];
  /** Maximum number of nested workflow calls (default 5). */
  maxSubworkflowDepth?: number;
  /** Child runs ignore pins so only the parent editor's pins are applied. */
  ignorePins?: boolean;
  /** Test blocks unpinned external side-effect nodes. */
  mode?: WorkflowRunMode;
  /** Surface-unification §D3 (2026-05-11) — when true, every trigger
   *  node is emitted as `node_skipped` (reason='dry-run') instead of
   *  being executed. Lets the PWA "▶ Run now (skip triggers)" button
   *  jump straight to the dependent chain without waiting for the
   *  daemon's cron/webhook/discord subscription to fire. */
  dryRun?: boolean;
  /** Surface-unification v2.2 (V2.2-1 · 2026-05-12) — token streaming
   *  fan-out. Prompt-shaped nodes call this callback with each partial
   *  LLM chunk + the executing nodeId. Streaming triggers (chat
   *  trigger SSE) push frames as the chunks arrive. Omitted = no
   *  fan-out (executor still buffers the full text into NodeOutput). */
  onTokenChunk?: (nodeId: string, chunk: string) => void;
}

/** Module-level injectable deps — kept here so node implementations
 *  receive them via context rather than importing the world. Tests
 *  override individual fields (e.g. an LLM stub for prompt nodes). */
export interface JudgmentContext {
  goal?: string;
  outcome?: Record<string, NodeOutput>;
  history?: unknown;
  kind?: string;
  lifecycle?: { workflow: string; nodeId: string };
  screen?: unknown;
}

export interface JudgmentResult {
  output: unknown;
  verdict?: string;
  ok?: boolean;
  error?: string;
}

export interface WorkflowDeps {
  /** Streaming LLM call. Mirrors `streamLLM` in `src/llm.ts`.
   *  V2.2-1 (2026-05-12) — `onPartialChunk` lets the prompt-shaped
   *  nodes forward each partial chunk to the executor's
   *  `NodeExecContext.onTokenChunk` so streaming triggers (chat SSE)
   *  can emit token-by-token frames. Implementations that don't have a
   *  streaming consumer (CLI buffer mode · unit tests) accept the
   *  callback and ignore it. */
  callLLM: (args: {
    prompt: string;
    model?: string;
    provider?: string;
    systemPrompt?: string;
    signal?: AbortSignal;
    onPartialChunk?: (chunk: string) => void;
  }) => Promise<string>;
  /** Run a bash one-liner / heredoc. */
  runBash: (
    body: string,
    opts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Create a TOX task (`task` node). Omitted = the in-process TOX
   *  `dispatchTaskCreate`. */
  createTask?: (req: WorkflowTaskRequest) => Promise<WorkflowTaskResult>;
  /** Invoke a registered skill by slug. */
  /** `opts.skillsDir` — 먼저 찾을 스킬 폴더(플러그인 노드 = 그 플러그인의 `skills/`). 없으면 종전 위치. */
  runSkill?: (slug: string, args: string, opts?: { skillsDir?: string }) => Promise<string>;
  /** Invoke a CFT method by name. */
  runCft?: (method: string, config: Record<string, unknown>) => Promise<unknown>;
  /** Evaluate a declared judgment contract through an injected implementation. */
  runJudgment?: (contractId: string, ctx: JudgmentContext) => Promise<JudgmentResult>;
  /** HITL approval prompt. Resolves to user's response when
   *  capture_response is true; `undefined` otherwise. Throws on reject.
   *
   *  BACKLOG #4 (2026-05-11) — second optional `opts.delivery`
   *  argument lets the runtime forward an approval node's per-channel
   *  preference. Implementations that don't consume it (CLI stdin
   *  reader) ignore the opt and prompt as before. */
  requestApproval?: (
    message: string,
    opts?: {
      delivery?:
        | 'modal'
        | 'terminal'
        | 'telegram'
        | 'discord'
        | 'pushcut'
        | 'all';
    },
  ) => Promise<string | undefined>;
}
