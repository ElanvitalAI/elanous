// PWA · Nexus HTTP + SSE client (Phase N-4 PR ν)
//
// Pure (no React import) so unit tests can exercise the wire layer
// without a DOM. React hooks (use-nexus-state etc.) wrap this client
// in PR ξ.
//
// HTTP API:
//   - getHealth() / getNexus() / getTabs() / getTab(id)
//   - createTab() / deleteTab() / patchTab() / startTab() / stopTab() / restartTab()
//   - getTemplates() / getTemplate(name) / saveTemplate()
//   - getConfig() / getSwitches() / putSwitch() / postSecret() / deleteSecret()
//
// SSE: subscribeEvents({topics, onEvent}) returns an Unsubscribe function.

import { reportAuthRequired } from '../lib/auth-required';
import { debugLog } from '../lib/debug';
import type {
  NexusHealth,
  NexusSnapshot,
  NexusTabKind,
  NexusTabState,
  NexusEvent,
} from './types';

const TASK_CARDS_PATH = '/v1/task-cards';

export class NexusApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`nexus ${status} on ${path}: ${stringify(body)}`);
    this.name = 'NexusApiError';
  }
}

export class MissingUpstreamError extends NexusApiError {
  readonly nodes: string[];

  constructor(path: string, body: { error: 'missing-upstream'; nodes: string[] }) {
    super(400, path, body);
    this.name = 'MissingUpstreamError';
    this.nodes = body.nodes;
  }
}

export class NexusTimeoutError extends Error {
  constructor(public readonly path: string, public readonly timeoutMs: number) {
    super(`NEXUS 가 ${timeoutMs / 1000}초 안에 답하지 않았습니다 (${path}) — 방금 켰다면 잠시 뒤 다시 시도하세요.`);
    this.name = 'NexusTimeoutError';
  }
}

function stringify(body: unknown): string {
  try { return JSON.stringify(body); } catch { return String(body); }
}

// ── M1-2b · friction-free model selection wire types ─────────────────
//
// Mirror of `src/model-tier/types.ts` shaped for the PWA so we don't
// import across the package boundary (apps/pwa tsconfig doesn't see
// parent src/). Drift kept in sync by `model-tier-spec.ts` mirror
// tests.

export type ModelTierWire = 'budget' | 'balanced' | 'better' | 'best' | 'loaded';

export interface ModelTierUserConfigWire {
  profile?: 'casual' | 'power' | 'custom';
  preset?: string;
  voice?: { stt?: ModelTierWire; tts?: ModelTierWire };
  llm?: ModelTierWire;
  embedding?: ModelTierWire;
  vision?: ModelTierWire;
}

export interface BudgetUserConfigWire {
  monthlyUsdCap?: number;
  dailyUsdCap?: number;
  fallbackTier?: ModelTierWire;
  notifyAtPct?: number;
}

export interface SmartDefaultsUserConfigWire {
  autoSuggest?: boolean;
  suppressPatternHints?: boolean;
}

export interface ModelTierPutWire {
  modelTier?: ModelTierUserConfigWire | null;
  budget?: BudgetUserConfigWire | null;
  smartDefaults?: SmartDefaultsUserConfigWire | null;
}

export interface WishPlacementWire {
  cellId: string;
  cellTitle: string;
  version: string;
  status: 'green' | 'yellow' | 'red' | 'done';
}

export interface TaskCardWire {
  id: string;
  goalId: string;
  title: string;
  status: 'open' | 'closed';
  closedReason?: string;
  createdAt: string;
  sections: Array<{ key: string; owner: string; content: string; createdAt: string }>;
}

export interface NexusClientOpts {
  baseUrl: string;
  /** Test seam — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Bearer credential sent on every request when present. */
  token?: string;
  /** Default request timeout (ms). 0 = no timeout. Default 8000. */
  timeoutMs?: number;
}

export interface NexusClient {
  readonly baseUrl: string;
  // ---- read ----
  getHealth(): Promise<NexusHealth>;
  getNexus(): Promise<NexusSnapshot>;
  getTabs(opts?: { kind?: NexusTabKind }): Promise<{ tabs: NexusTabState[] }>;
  getTab(id: string): Promise<{ tab: NexusTabState; recentEvents: NexusEvent[] }>;
  getTaskCards(): Promise<{ cards: TaskCardWire[] }>;
  getTaskCard(id: string): Promise<{ card: TaskCardWire; placements?: WishPlacementWire[] }>;
  closeTaskCard(id: string, reason: string): Promise<{ card: TaskCardWire }>;
  /** PWA mirror PR 1 — chat-backend Quick Setup snapshot. PR 2's
   *  QuickSetupCard component consumes this to mirror the TUI Settings
   *  card on mobile / iOS / remote PWA users. Cache-free; the PWA's
   *  refresh button fires this fresh each time. */
  getChatBackendDetection(): Promise<ChatBackendDetection>;
  /** T4.D — mint a copy-friendly bearer token for paste-on-other-device. */
  mintConnectToken(): Promise<MintConnectToken>;
  // ---- mutation: tabs ----
  createTab(body: CreateTabBody): Promise<{ tab: NexusTabState; started: boolean }>;
  deleteTab(id: string): Promise<{ deleted: true; id: string }>;
  patchTab(id: string, body: { label?: string }): Promise<{ tab: NexusTabState }>;
  startTab(id: string): Promise<{ tab: NexusTabState; started: boolean }>;
  stopTab(id: string, opts?: { graceMs?: number }): Promise<{ tab: NexusTabState; stopped: true }>;
  restartTab(id: string, opts?: { graceMs?: number }): Promise<{ tab: NexusTabState; restarted: true; started: boolean }>;
  // ---- templates ----
  getTemplates(): Promise<{ templates: TemplateSummary[] }>;
  getTemplate(name: string): Promise<{ template: NexusTemplate }>;
  saveTemplate(body: SaveTemplateBody): Promise<{ saved: true; name: string; path?: string }>;
  // ---- plugins market (daemon-verified reads and owner-only mutations) ----
  getPluginsIndex(): Promise<MarketIndexResponse>;
  getInstalledPlugins(): Promise<InstalledPluginWire[]>;
  refreshPluginMarket(name: string): Promise<{ ok: boolean; plugins?: MarketPluginWire[]; reason?: string }>;
  installMarketPlugin(spec: string, acceptedCapabilities: string[], onLine: (line: string) => void): Promise<void>;
  removeMarketPlugin(name: string): Promise<{ removed: number }>;
  getPluginCredentials(name: string): Promise<PluginCredentialsStatus>;
  putPluginCredentials(name: string, fields: Record<string, string | null>): Promise<{ set: string[] }>;
  // ---- harness execution graphs (core read-only · mine editable) ----
  getRunGraphs(): Promise<{ graphs: RunGraphSummary[] }>;
  getRunGraph(id: string): Promise<RunGraphDetail>;
  getRunGraphYaml(id: string): Promise<{ id: string; source: 'core' | 'mine'; editable: boolean; yaml: string }>;
  putRunGraphYaml(id: string, yaml: string): Promise<{ id: string; source: 'mine'; editable: true; saved: true; version?: number; previous?: number | null }>;
  /** Create a «mine» run graph: 409 when the id exists, 403 for a core id, 400/422 for a bad id or an invalid graph. */
  createRunGraph(id: string, yaml: string): Promise<{ id: string; source?: 'mine'; editable?: true; version?: number; previous?: number | null }>;
  /** CGE-RUN — operator-only demo run of a «mine» graph (repository recipes only). */
  startRunGraphRun(id: string): Promise<{ id: string; runId: string; demo?: boolean }>;
  getRunGraphRun(id: string, runId: string): Promise<unknown>;
  cloneRunGraph(id: string, newId: string): Promise<{ id: string; source: 'mine'; editable: true; clonedFrom: string }>;
  getGraphKinds(graph: 'workflow' | 'harness'): Promise<{ kinds: GraphKindEntry[] }>;
  validateGraph(graph: 'workflow' | 'harness', yaml: string): Promise<GraphValidationResponse>;
  // ---- workflows (Archon-port T2.3) ----
  getWorkflows(): Promise<{ workflows: WorkflowSummary[] }>;
  getWorkflow(name: string): Promise<WorkflowDetail>;
  getWorkflowHistory(name: string): Promise<WorkflowHistoryResponse>;
  getWorkflowHistoryVersion(name: string, id: string): Promise<WorkflowHistoryVersionResponse>;
  getWorkflowPins(name: string): Promise<WorkflowPinsResponse>;
  putWorkflowPin(name: string, nodeId: string, value: unknown, note?: string): Promise<WorkflowPinResponse>;
  deleteWorkflowPin(name: string, nodeId: string): Promise<{ workflow: string; removed: number }>;
  saveWorkflow(name: string, body: SaveWorkflowBody): Promise<{ ok: true; path: string; scope: string }>;
  deleteWorkflow(name: string, opts?: { scope?: 'project' | 'global' }): Promise<{ ok: true; path: string; scope: string }>;
  validateWorkflow(yaml: string, opts?: { signal?: AbortSignal }): Promise<ValidateWorkflowResponse>;
  /** ROADMAP Tier 1 W1 — natural-language → workflow YAML. */
  generateWorkflow(body: GenerateWorkflowBody, opts?: { signal?: AbortSignal }): Promise<GenerateWorkflowResponse>;
  /** Surface-unification §C1 (2026-05-11) — natural-language → workflow
   *  YAML + trigger via the R3 native skill (`workflow.synth_from_intent`).
   *  Richer than `generateWorkflow`: includes triggerSummary + name +
   *  preview/register modes + self-repair. */
  synthesizeWorkflow(body: SynthesizeWorkflowBody, opts?: { signal?: AbortSignal }): Promise<SynthesizeWorkflowResponse>;
  /** Surface-unification §E1 (2026-05-11) — flat inventory of every
   *  trigger node across the discovered workflows. Drives the PWA
   *  Active-triggers panel (E2). */
  getTriggersSnapshot(opts?: { signal?: AbortSignal }): Promise<TriggerSnapshot>;
  /** Surface-unification §F2 (2026-05-11) — starter workflow templates
   *  (raw YAML + parsed metadata) for the "+ New" picker. */
  getWorkflowTemplates(opts?: { signal?: AbortSignal }): Promise<WorkflowTemplateList>;
  runWorkflow(name: string, args: string, opts?: { dryRun?: boolean; onlyNode?: string; fromNode?: string; fromRunId?: string }): Promise<WorkflowRunStartResponse>;
  getWorkflowRun(runId: string): Promise<WorkflowRunDetail>;
  getWorkflowRuns(): Promise<{ runs: WorkflowRunSummary[] }>;
  /** D4 · §6.4 SSE — URL for the workflow yaml fs.watch event stream.
   *  Used by `useWorkflows` to invalidate the cached list within
   *  <500ms of a disk yaml change (was 30s polling). Null when the
   *  client wasn't built with a base URL. */
  workflowsEventsUrl(): string | null;
  // §5.1 — approval surface
  getPendingApprovals(): Promise<{ pending: PendingApproval[] }>;
  approveRun(runId: string, body?: { response?: string }): Promise<{ ok: true; runId: string; decision: 'approved' }>;
  rejectRun(runId: string, body?: { reason?: string }): Promise<{ ok: true; runId: string; decision: 'rejected' }>;
  // ---- config + secrets ----
  getConfig(): Promise<{ config: unknown }>;
  getChatFastPath(): Promise<{ enabled: boolean }>;
  getSwitches(): Promise<{ switches: SwitchWire[] }>;
  getSwitch(id: string): Promise<{ switch: SwitchWire }>;
  putSwitch(id: string, body: { value: unknown }): Promise<PutSwitchResult>;
  postSecret(body: { id: string; value: string }): Promise<{ stored: true; id: string; ref: string }>;
  deleteSecret(id: string): Promise<{ deleted: true; id: string }>;
  getSecrets(): Promise<{ secrets: { id: string }[] }>;
  /** M1-2b — friction-free model selection sub-trees (modelTier · budget ·
   *  smartDefaults). Returns each only when set; the PWA slider hydrates
   *  from this on mount to stay cross-device consistent. */
  getModelTier(): Promise<{
    modelTier?: ModelTierUserConfigWire;
    budget?: BudgetUserConfigWire;
    smartDefaults?: SmartDefaultsUserConfigWire;
  }>;
  /** M1-2b — partial PUT. Supplied sub-trees replace; omitted preserve;
   *  `null` clears. Echoes back the post-merge state from disk. */
  putModelTier(body: ModelTierPutWire): Promise<{
    modelTier?: ModelTierUserConfigWire;
    budget?: BudgetUserConfigWire;
    smartDefaults?: SmartDefaultsUserConfigWire;
  }>;
  /** BACKLOG #2 — connected/not-configured per integration channel. */
  getPlatforms(): Promise<{ platforms: PlatformEntry[] }>;
  // ---- /setup wizard (Phase 1 · 2026-05-19) ----
  /** PWA `/setup` Phase 1 — LLM provider catalog for the first-boot
   *  picker. Server-authoritative (mirrors DASHBOARD_PROVIDER_SETUP_OPTIONS).
   *  `hasSavedKey` lets the UI render "already configured" hint without
   *  echoing the secret. */
  getLlmProviders(): Promise<LlmProvidersResponse>;
  /** PWA `/setup` Phase 1 — apply provider + apiKey. apiKey-flow + auto-
   *  flow only · codex / local surface 422 with TUI hint (Phase 1b). */
  setLlmProvider(body: SetLlmProviderBody): Promise<SetLlmProviderResponse>;
  getObsidianSkills(): Promise<ObsidianSkillsState>;
  setObsidian(body: { vault: string }): Promise<{ ok: true; obsidian: { vault: string }; warning?: string }>;
  setSkills(body: { activeSet: string } | { dirs: string[] }): Promise<{ ok: true; skills: { activeSet: string; dirs: string[] } }>;
  getChannelBots(): Promise<ChannelBotsResponse>;
  setChannelBot(body: ChannelBotSetBody): Promise<ChannelBotSetResponse>;
  getChildLlmPreference(): Promise<ChildLlmPreferenceResponse>;
  setChildLlmPreference(body: ChildLlmPreferenceBody): Promise<{ resolved: ChildLlmResolved }>;
  getAnswerPriority(): Promise<AnswerPriorityResponse>;
  setAnswerPriority(value: AnswerPriorityValue): Promise<{ value: AnswerPriorityValue }>;
  // ---- /settings PersonaCard (Phase 3 · 2026-05-19) ----
  /** §6.4 (existing) — list loaded personas + descriptions. */
  getPersonas(): Promise<PersonasListResponse>;
  getPersonaPresets(): Promise<PersonaPresetsResponse>;
  createPersona(body: CreatePersonaBody): Promise<PersonaPatchResponse>;
  patchPersona(id: string, edits: PersonaEdits): Promise<PersonaPatchResponse>;
  /** Phase 3 — update description for a single persona. Surgical yaml
   *  edit (comments/custom keys preserved). Empty string clears. */
  patchPersonaDescription(
    personaId: string,
    description: string,
  ): Promise<PersonaPatchResponse>;
  /** RFC #2161 Phase 3 — Layer A static catalog snapshot. Used by the
   *  Showroom dropdown + future LlmCatalogCard. Phase 5 sibling
   *  `getResolvedView()` will add live state on top. */
  getRegistryCatalog(): Promise<RegistryCatalogResponse>;
  /** BACKLOG #5 — active worktree visualization. */
  getWorktrees(): Promise<WorktreesResponse>;
  /** B4 — craft-rulebook verdict for the daemon's active repository. */
  getDesignCheck(): Promise<DesignCheckResponse>;
  /** Live 탭 — 런 원장. */
  getHarnessRuns(): Promise<HarnessRunsResponse>;
  /** Live 탭 — 로그 조회(최신순). `store` 는 다른 인스턴스 읽기 전용. */
  getLogs(query: LogsQuery): Promise<LogsResponse>;
  /** Live 탭 — 로그 저장소가 있는 인스턴스 목록. */
  getLogInstances(): Promise<LogInstancesResponse>;
  /** Live 탭 MAX — 하니스 상세 계측 스위치(🅢 #21452 · 소유자 토큰). */
  getLiveDetail(): Promise<LiveDetailState>;
  /** Live 탭 SHIPPED — GitHub 병합 PR 수(🅢 09-28 ① · 우주와 무관). 못 셌으면 `merged: null` ⊕ 이유. */
  getLiveShipped(since: string): Promise<LiveShippedResponse>;
  /** Trace 탭 — 판단 사슬(🅣 #21590 `GET /v1/trace`). 서버가 여러 우주를 모아 사슬·사실(PR·커밋·화면)을 붙여 준다. */
  getTrace(query: TraceQuery): Promise<TraceResponse>;
  /** Trace L4 — 로그 한 줄 원문(비밀 가림 · `ref = log:<우주>:<id>`). */
  getTraceEvidence(ref: string): Promise<TraceEvidenceResponse>;
  /** Live 탭 런 서랍 — 그 런의 화면 끝부분(`self screen --run` 과 같은 해석). */
  getRunScreen(runId: string, lines?: number): Promise<RunScreenResponse>;
  /** 하니스 런 멈춤(부드러운 멈춤 · 화면 키 = spaceId). */
  stopHarness(spaceId: string): Promise<{ stopped?: string; error?: string }>;
  setLiveDetail(body: { scope: string; ttlMin: number; by?: string }): Promise<LiveDetailState>;
  /** RFC design loop §B — write the chosen direction into the same repository
   *  the design check reads (owner auth; same function as the CLI `--set`). */
  setDesignDirection(id: string): Promise<SetDesignDirectionResponse>;
  /** POST /v1/design-system — make a library system from a URL or a palette. */
  createDesignSystem(body: CreateDesignSystemBody): Promise<CreateDesignSystemResponse>;
  /** RFC design loop §A2 — HTML previews under the design-check repository. */
  listDesignPreviews(): Promise<DesignPreviewsResponse>;
  getDesignPreview(system: string): Promise<DesignPreviewDocument>;
  /** HANDOFF §4.2 — GUI cleanup for worktrees + orphan sessions.
   *  Posts the path of a non-main worktree (or an orphaned session's
   *  worktreePath) to remove it. `force` runs `git worktree remove
   *  --force` for dirty checkouts. */
  disposeWorktree(body: DisposeWorktreeBody): Promise<DisposeWorktreeResponse>;
  // ---- log streaming ----
  getLogsTail(id: string, opts?: { lines?: number }): Promise<LogsTailResult>;
  // ---- SSE ----
  subscribeEvents(opts: SubscribeOpts): Unsubscribe;
  subscribeLogs(id: string, opts: SubscribeLogsOpts): Unsubscribe;
}

// ---- request bodies ----
export interface CreateTabBody {
  kind: NexusTabKind;
  id?: string;
  label?: string;
  kindOpts?: Record<string, unknown>;
  start?: boolean;
}

export interface TemplateSummary {
  name: string;
  description: string;
  source: 'builtin' | 'user';
  tabCount: number;
}

export interface NexusTemplate {
  version: number;
  name: string;
  description: string;
  tabs: { kind: NexusTabKind; id?: string; label?: string; kindOpts?: Record<string, unknown>; start?: boolean }[];
}

export interface SaveTemplateBody {
  name: string;
  description?: string;
  fromRegistry?: boolean;
  tabs?: NexusTemplate['tabs'];
}

export interface GraphKindEntry {
  graph: 'workflow' | 'harness';
  kind: string;
  plugin?: string | null;
  description: string;
  schema?: Record<string, unknown>;
  core: boolean;
}

export interface GraphValidationResponse {
  ok: boolean;
  errors: Array<{ message: string; path?: string }>;
  ignoredKeys: string[];
}

export interface MarketPluginWire {
  name: string;
  version: string;
  description?: string;
  category?: string;
  capabilities: string[];
  connectors: Array<{ id: string; kind: string; userConfig: Array<{ key: string; label: string; secret: boolean }> }>;
  graphs?: string[];
  pricing: { model: 'free' | 'one-time' | 'subscription'; amount?: number; currency?: string; period?: string };
  sha256: string;
}
export interface MarketIndexResponse {
  markets: Array<{ name: string; signature: 'ok' | 'missing' | 'unknown-key' | 'malformed' | 'stale'; detail?: string; plugins: MarketPluginWire[] }>;
}
export interface InstalledPluginWire { name: string; version: string; market: string; path: string; sha256: string | null; installedAt?: string }
export interface PluginCredentialsStatus { fields: Array<{ name: string; env: string; set: boolean }> }

// F-M1 — server-authoritative core graph snapshot; no mutation endpoints.
export interface RunGraphSummary {
  id: string;
  source: 'core' | 'mine';
  editable: boolean;
  nodeCount: number;
}

export interface RunGraphDetail {
  id: string;
  source: 'core' | 'mine';
  editable: boolean;
  entry_node: string;
  terminal_nodes: string[];
  nodes: Array<{ node_id: string; kind: string; recipe: string; max_visits: number }>;
  edges: Array<{ from: string; to?: string; on?: string; map?: Record<string, string> }>;
}

// Archon-port T2.3 wire format — PWA `/workflows` (T2A) consumes these.
export interface WorkflowSummary {
  name: string;
  description: string;
  source: 'project' | 'global' | 'builtin';
  path: string;
  nodeCount: number;
}

export interface WorkflowDetail {
  name: string;
  source: 'project' | 'global' | 'builtin';
  path: string;
  /** Raw YAML text — feed this back into PUT to round-trip. */
  yaml: string;
  /** Parsed schema (for validation badges, node-count display, etc.). */
  definition: {
    name: string;
    description: string;
    nodes: Array<{ id: string; depends_on?: string[]; [variantKey: string]: unknown }>;
    [topKey: string]: unknown;
  };
}

export interface WorkflowHistoryVersion {
  id: string;
  createdAt: string;
  size: number;
}

export interface WorkflowHistoryResponse {
  versions: WorkflowHistoryVersion[];
}

export interface WorkflowHistoryVersionResponse {
  yaml: string;
}

export interface WorkflowPinEntry {
  nodeId: string;
  value: unknown;
  updatedAt: string;
  note?: string;
}

export interface WorkflowPinsResponse {
  workflow: string;
  pins: Record<string, WorkflowPinEntry>;
}

export interface WorkflowPinResponse {
  workflow: string;
  pin: WorkflowPinEntry;
}

export interface SaveWorkflowBody {
  yaml: string;
  scope?: 'project' | 'global';
}

export interface ValidateWorkflowResponse {
  validation: {
    ok: boolean;
    issues: Array<{ path: string; message: string }>;
    workflow?: WorkflowDetail['definition'];
    /** M4-2 (2026-05-12) — non-fatal deterministic warnings. */
    warnings: Array<{
      code: string;
      severity: 'high' | 'medium' | 'low';
      message: string;
      nodeId?: string;
      path?: string;
      suggestion?: string;
    }>;
  };
}

/** ROADMAP Tier 1 W1 — POST /v1/workflows/generate request body. */
export interface GenerateWorkflowBody {
  prompt: string;
  model?: string;
  provider?: string;
  /** Optional skill-name vocabulary the LLM should restrict skill nodes to. */
  skills?: string[];
  /** Optional existing YAML to refine instead of generating from scratch. */
  currentYaml?: string;
}

/** ROADMAP Tier 1 W1 — POST /v1/workflows/generate response. Mirrors
 *  src/workflow/nl-generator.ts `GenerateWorkflowResponse`. */
export interface GenerateWorkflowResponse {
  yaml: string;
  warnings: string[];
  raw: string;
  definition?: WorkflowDetail['definition'];
}

/** Surface-unification §C1 (2026-05-11) — POST /v1/workflows/synth body.
 *  Mirrors `WorkflowSynthOpts` from src/workflow-synth/index.ts. */
export interface SynthesizeWorkflowBody {
  intent: string;
  context?: string;
  /** When true (default), returns the YAML without persisting it so the
   *  PWA can render a preview/confirm modal (C2). */
  preview?: boolean;
  scope?: 'project' | 'global';
}

/** Surface-unification §C1 — POST /v1/workflows/synth response. Mirrors
 *  `WorkflowSynthResult` from src/workflow-synth/index.ts. */
export interface SynthesizeWorkflowResponse {
  ok: boolean;
  yaml?: string;
  workflowName?: string;
  triggerSummary?: string;
  registered: boolean;
  registeredPath?: string;
  repaired?: boolean;
  error?: string;
}

/** Surface-unification §E1 (2026-05-11) — flat trigger inventory.
 *  Each entry corresponds to one trigger node in one workflow. */
export interface TriggerSnapshotEntry {
  workflowName: string;
  nodeId: string;
  variant: 'schedule' | 'webhook' | 'discord' | 'telegram' | 'manual' | 'chat';
  payload: Record<string, unknown>;
}
export interface TriggerSnapshot {
  triggers: TriggerSnapshotEntry[];
  workflowsScanned: number;
}

/** Surface-unification §F2 (2026-05-11) — workflow template metadata. */
export interface WorkflowTemplateEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  yaml: string;
}
export interface WorkflowTemplateList {
  templates: WorkflowTemplateEntry[];
}

export interface WorkflowRunStartResponse {
  ok: true;
  runId: string;
  /** Server (#23131): 'only' = onlyNode · 'from' = fromNode⊕fromRunId · 'full' = the whole workflow. */
  mode?: 'only' | 'from' | 'full';
}

export interface WorkflowRunEvent {
  type: string;
  nodeId?: string;
  nodeType?: string;
  reason?: string;
  result?: { ok: boolean; output: unknown; error?: string; durationMs: number };
  outputs?: Record<string, { ok: boolean; output: unknown; durationMs: number }>;
  error?: string;
  partial?: Record<string, unknown>;
}

export interface WorkflowRunDetail {
  runId: string;
  workflowName: string;
  /** Server (#23131): 'only' = a single-node test run (not a valid «retry from» source) · 'from' · 'full'. */
  mode?: 'only' | 'from' | 'full';
  startedAt: number;
  ok: boolean | undefined;
  events: WorkflowRunEvent[];
  outputs: Record<string, unknown>;
}

/** Disk-backed run summary returned by `GET /v1/workflows/runs`.
 *  Shape mirrors `DiskRunSummary` in src/nexus/api/workflows.ts. The
 *  `orphaned` status is derived: running runs older than 30 min are
 *  surfaced as orphaned to the listing only — the on-disk run.json
 *  stays at `running` so a long-tail completion can still finalize. */
export interface WorkflowRunSummary {
  runId: string;
  workflowName: string;
  startedAt: number;
  completedAt?: number;
  ok?: boolean;
  status: 'running' | 'orphaned' | 'done' | 'failed' | 'unknown';
  arguments?: string;
}

/** §5.1 — pending approval entry returned by GET /v1/workflows/runs/
 *  pending. The executor is parked on a deferred Promise here; the
 *  client unblocks it via POST /approve or /reject. */
export interface PendingApproval {
  runId: string;
  message: string;
  requestedAt: number;
}

// /setup wizard (Phase 1 · 2026-05-19) — LLM provider picker wire types.
// Mirror of `src/nexus/api/setup-llm-provider.ts` LlmProviderWire +
// LlmProvidersResponse. Drift kept in sync by `setup-llm-provider.test.ts`
// asserting the catalog shape end-to-end.
export interface LlmProviderEntry {
  provider: string;
  label: string;
  description: string;
  apiKeyLabel: string;
  flow: 'apiKey' | 'codex' | 'local' | 'auto';
  recommended: boolean;
  hasSavedKey: boolean;
}

export interface LlmProvidersResponse {
  providers: LlmProviderEntry[];
  activeProvider: string;
}

export interface SetLlmProviderBody {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface SetLlmProviderResponse {
  ok: true;
  active: {
    provider: string;
    model: string;
  };
}

export type AnswerPriorityValue = 'cost' | 'balanced' | 'quality' | 'exhaustive';
export interface AnswerPriorityResponse {
  value: AnswerPriorityValue | null;
  effective: AnswerPriorityValue;
  choices: Array<{ value: AnswerPriorityValue; label: string; description: string }>;
}

export type ChildLlmMode = 'pinned' | 'auto';
export type ChildLlmOnShortfall = 'decompose' | 'wait-reset' | 'next-provider' | 'proceed';

export interface ChildLlmChainEntry {
  provider: string;
  model?: string;
}

export interface ChildLlmResolved {
  mode: ChildLlmMode;
  chain: ChildLlmChainEntry[];
  budgetGate: {
    minHeadroomPercent: number;
    onShortfall: ChildLlmOnShortfall;
  };
  source: { mode: 'explicit' | 'inferred'; chain: 'config' | 'pinned' | 'fallbackChain' };
}

export interface ChildLlmPreferenceResponse {
  resolved: ChildLlmResolved;
  providers: string[];
}

export interface ChildLlmPreferenceBody {
  mode?: ChildLlmMode;
  chain?: ChildLlmChainEntry[];
  budgetGate?: { minHeadroomPercent?: number; onShortfall?: ChildLlmOnShortfall };
}

export interface ObsidianSkillsState {
  obsidian: { vault: string; exists: boolean; looksLikeVault: boolean };
  skills: {
    activeSet: string;
    dirs: string[];
    presets: Array<{ key: string; label: string; dir: string | null; exists: boolean }>;
  };
}

// /settings PersonaCard (Phase 3 · 2026-05-19) — wire types for persona
// list + description PATCH. Mirror of `src/nexus/api/personas.ts`
// `PersonaWire` (subset of `PersonaProfile`).
export interface PersonaWireEntry {
  personaId: string;
  displayName: string;
  description?: string;
  brand?: string;
  primaryModel?: string;
  systemPrompt?: string;
  avatarUrl?: string;
  brandColor?: string;
  mentionPatterns?: readonly string[];
}

export interface PersonasListResponse {
  personas: PersonaWireEntry[];
  count: number;
}

export interface PersonaPatchResponse {
  persona: PersonaWireEntry;
}

export interface PersonaPresetEntry {
  personaId: string;
  displayName: string;
  names: string[];
  role: string;
  title?: string | null;
  oneLine: string;
  voice: { rule: string; examples: string[] };
  tasks: Array<{ when: string; what: string }>;
  tools: Array<{ name: string; from: string; optional?: boolean }>;
  firstQuestions: string[];
  askBefore?: string[];
  doesNot: string[];
  forWhom: string;
}

export interface PersonaPresetsResponse { presets: PersonaPresetEntry[] }
export interface CreatePersonaBody { preset: string; name: string }
export interface PersonaEdits { displayName?: string; description?: string; systemPrompt?: string }

// BACKLOG #2 — GET /v1/platforms wire format. Mirrors
// `src/nexus/api/platforms.ts:PlatformEntry`. Server never returns
// secret values; `detail` and `hint` are human-readable strings.
export type ChannelBotPlatform = 'telegram' | 'discord';
export interface ChannelBotState {
  platform: ChannelBotPlatform;
  configured: boolean;
  source: 'tokenRef' | 'env' | 'plaintext' | null;
  allowedUsers: string[];
}
export interface ChannelBotsResponse { platforms: ChannelBotState[] }
export interface ChannelBotSetBody { platform: ChannelBotPlatform; token?: string; allowedUsers?: string[] }
export interface ChannelBotSetResponse { ok: true; botName?: string; restartNeeded: true }

export type PlatformId = 'discord' | 'telegram' | 'pushcut' | 'acp' | 'tailscale';
export type PlatformStatus = 'connected' | 'not-configured';
export interface PlatformEntry {
  id: PlatformId;
  label: string;
  status: PlatformStatus;
  detail: string;
  hint?: string;
}

// BACKLOG #1 types retired 2026-05-11 — `/v1/providers` endpoint
// removed alongside ProviderCapabilityCard (#2198 FU A4). The matrix
// view is now served by `/v1/registry/catalog` + LlmCatalogCard.

// RFC #2161 Phase 3 — GET /v1/registry/catalog wire format. Mirrors
// `src/nexus/api/registry-catalog.ts:CatalogResponse`. The PWA client
// keeps a structural-only mirror so we don't pull the daemon's runtime
// types into the bundle. Capability + reasoning vocabularies stay
// in-sync via the workflow yaml validator (server-authoritative).
export type RegistryCapabilityKey =
  | 'sessionResume'
  | 'mcp'
  | 'hooks'
  | 'skills'
  | 'agents'
  | 'toolRestrictions'
  | 'structuredOutput'
  | 'envInjection'
  | 'costControl'
  | 'effortControl'
  | 'thinkingControl'
  | 'fallbackModel'
  | 'sandbox'
  | 'multiHostFanout';

export type RegistryProviderCapabilities = Record<RegistryCapabilityKey, boolean>;

export interface RegistryProviderEntry {
  id: string;
  displayName: string;
  aliases: string[];
  modelPrefixes: string[];
  apiKeyEnv: string;
  endpointPattern: string;
  defaultStreaming: 'sse' | 'ws' | 'polling';
  toolCallingFormat:
    | 'native-anthropic'
    | 'native-openai'
    | 'native-gemini'
    | 'none';
  capabilities: RegistryProviderCapabilities;
  builtIn: boolean;
}

export interface RegistryModelEntry {
  id: string;
  provider: string;
  displayName: string;
  family?: string;
  familyShortcut?: string;
  contextSize?: number;
  outputMaxTokens?: number;
  vision?: 'images' | 'video' | 'pdf' | null;
  audio?: { input: boolean; output: boolean };
  reasoning?: 'off' | 'low' | 'medium' | 'high' | null;
  toolCalling?:
    | 'native-anthropic'
    | 'native-openai'
    | 'native-gemini'
    | 'none';
  pricing?: {
    inputPerMTok: number;
    outputPerMTok: number;
    cachedInputPerMTok?: number;
  };
  rateLimits?: { rpm?: number; tpm?: number };
  deprecated?: string | null;
  releaseDate?: string;
  tokenizer?: string;
  kind?: 'chat' | 'embedding' | 'image' | 'audio';
  capabilities?: Partial<RegistryProviderCapabilities>;
  discoveryMeta?: {
    source: string;
    lastSeen: string;
    autoFilled: boolean;
    confidence?: 'high' | 'medium' | 'low';
  };
}

export interface RegistryCatalogResponse {
  catalogVersion: number;
  providers: RegistryProviderEntry[];
  models: RegistryModelEntry[];
  patterns: Array<{
    provider: string;
    prefixes: Array<{ prefix: string; fallback: Partial<RegistryModelEntry> }>;
  }>;
  manifest: {
    builtinSource: string;
    globalSource: string;
    fileCount: number;
    loadedAt: string;
  };
}

// BACKLOG #5 — GET /v1/worktrees wire format. Mirrors
// `src/nexus/api/worktrees.ts:WorktreesResponse`.
export interface WorktreeViewSession {
  sessionId: string;
  enteredAt: number;
  previousCwd: string;
  alive: boolean;
}
export interface WorktreeView {
  path: string;
  branch: string | null;
  sha: string;
  isMain: boolean;
  isLocked: boolean;
  isDetached: boolean;
  session: WorktreeViewSession | null;
  orphan: boolean;
}
export interface OrphanedSessionView {
  sessionId: string;
  worktreePath: string;
  branch: string;
  enteredAt: number;
  alive: boolean;
}
export interface WorktreesResponse {
  repoRoot: string | null;
  worktrees: WorktreeView[];
  orphanedSessions: OrphanedSessionView[];
}

// B4 — GET /v1/design-check wire format. Mirrors
// `src/nexus/api/design-check.ts:buildDesignCheckView`.
//
// ⛔ Modelled as a DISCRIMINATED UNION on `ok`, not as one object with
//    optional fields. The daemon's whole reason for sending `blockedOn` is
//    that "nothing is missing" and "I could not read the directory" must not
//    look alike; collapsing them back into `rulebooks?: string[]` here would
//    undo that at the last step.
export interface DesignCheckOk {
  ok: true;
  repoRoot: string;
  /** Where the daemon found the repository: `harness.defaultRepo` or its own cwd. */
  repoSource?: 'config' | 'cwd' | null;
  documentPath: string;
  craftDirectory: string;
  /** Every rulebook elanous ships — lets the panel show "available but not
   *  declared" without a second round trip. */
  availableRulebooks: string[];
  declaredRulebooks: string[];
  /** Declared names with no matching file. Non-empty ⇒ exitCode 1. */
  unavailableRulebooks: string[];
  exitCode: 0 | 1;
  /** B5 — visual direction declared by the same DESIGN.md.
   *  ⛔ Deliberately NOT folded into `exitCode`: a rulebook that cannot be
   *  found is a broken contract, an undeclared direction is just a choice
   *  nobody has made yet. Collapsing them would make a healthy new project
   *  render as failing. */
  /** ⚠️ Optional for the same gate reason documented on `AgentToolResult.cid`
   *  (`src/skills/tools/agent.ts`): a new REQUIRED field on an exported type
   *  escalates `ci-typecheck-changed.ts` to a whole-repository check, and that
   *  scope carries 74 pre-existing non-exempt errors owned by other tracks.
   *  The daemon populates it on every `ok: true` response; the panel still
   *  guards for absence so an older daemon degrades to "no direction section"
   *  instead of crashing. */
  directions?: {
    declared: string | null;
    unavailable: string | null;
    available: DesignDirectionView[];
  };
}
export interface DesignDirectionView {
  id: string;
  mood: string;
  isDark: boolean;
  isPastel: boolean;
  swatch: { text: string; accent: string; muted: string; bg?: string; fg?: string };
  /** RFC design loop §B — optional so an older daemon still parses. */
  label?: string;
  source?: 'theme' | 'document' | 'design-system';
  typography?: { display: string | null; body: string | null } | null;
  category?: string | null;
}

// Live 탭(2026-09-28 · 내부 문서 `PLAN-live-signals-tab-teaser-and-web-2026-09-28`) — 기존 끝점만 모은다.
// GET /v1/harness/runs · GET /v1/logs · GET /v1/logs/instances. 새 필드는 전부 선택적(옛 데몬 호환).
export interface HarnessRunEntry {
  runId: string;
  status: string;
  lifecycle?: string;
  lastActivityTimestamp?: string | null;
  lastPhase?: string | null;
}
export interface HarnessRunsResponse {
  entries: HarnessRunEntry[];
  counts?: Record<string, number>;
  total?: number;
}
export interface LogRow {
  id?: number;
  ts: string;
  level?: string;
  instance?: string;
  surface?: string;
  category: string;
  event: string;
  data?: Record<string, unknown> | null;
}
export interface LogsResponse { ok: boolean; logs: LogRow[]; count: number; ts?: string; stores?: string[]; failedStores?: Array<{ name: string; reason: string }>; registeredStores?: number }
export interface LogInstance { name: string; alive?: boolean; dbExists?: boolean; current?: boolean }
export interface LogInstancesResponse { ok: boolean; self?: string; instances: LogInstance[] }
export interface TraceQuery { level: 'L0' | 'L1' | 'L2' | 'L3'; runId?: string; store?: string; limit?: number; kind?: string; q?: string; from?: number }
export interface TraceEventWire {
  id: string; ts: string; universe: string; runId?: string; parentRunId?: string; phase?: string; kind: string;
  what: string; why?: string; purpose?: string; target?: string; paths?: number | string[];
  refs: { pr?: string | number; commit?: string; logId: string; screen?: string; llmRequestId?: string };
}
export interface TraceNodeWire { id: string; level: string; label: string; count: number; universe?: string; runId?: string; firstTs?: string; lastTs?: string }
export interface TraceResponse { ok: boolean; nodes?: TraceNodeWire[]; edges?: Array<{ source: string; target: string; kind: string }>; events: TraceEventWire[]; truncated: boolean; stores?: string[]; failedStores?: Array<{ name: string; reason: string }> }
export interface TraceEvidenceResponse { ok: boolean; ref: string; evidence?: { ts: string; instance: string; category: string; event: string; data: unknown } }
export interface LiveShippedResponse { merged: number | null; since: string; repo?: string; source?: string; reason?: string; cached?: boolean }
export interface RunScreenResponse { runId: string; screenKey: string | null; text: string | null; stoppable: boolean; outcome?: 'complete' | 'incomplete' | null; reason?: string; lastEvent?: { category: string; event: string; timestamp: string } | null }
export interface LiveDetailState { on: boolean; scope?: string | null; since?: string | null; until?: string | null; remainingMs?: number | null }
export interface LogsQuery { category?: string; since?: string; limit?: number; store?: string; event?: string }

// RFC design loop §B — POST /v1/design-direction wire format. Mirrors
// `src/nexus/api/design-check.ts:handleDesignDirectionPost`. A refusal comes
// back as a NexusApiError whose body carries `reason`.
export type SetDesignDirectionResponse = {
  ok: true;
  documentPath: string;
  direction: string;
  repoRoot?: string;
  repoSource?: 'config' | 'cwd' | null;
};

/** POST /v1/design-system. Mirrors `handleDesignSystemCreate`. */
export type CreateDesignSystemBody =
  | { kind: 'url'; url: string; id?: string; name?: string; base?: string }
  | { kind: 'palette'; colors: string[]; id: string; name?: string; base?: string };

export interface CreatedDesignSystemToken {
  token: string;
  value: string;
  from: string;
}

export interface CreateDesignSystemResponse {
  ok: true;
  id: string;
  dir: string;
  tokens: CreatedDesignSystemToken[];
  unread: number;
  warnings: string[];
  extractDir?: string;
}
export interface DesignCheckBlocked {
  ok: false;
  repoRoot: string | null;
  /** Which read failed. `no-repository` means the daemon is not inside a
   *  git checkout at all — a deployment fact, not a missing file. */
  blockedOn: 'no-repository' | 'craft-directory' | 'design-document';
  path: string | null;
  exitCode: 1;
}
export type DesignCheckResponse = DesignCheckOk | DesignCheckBlocked;

/** GET /v1/design-previews. New fields stay optional so an older daemon still parses. */
export interface DesignPreviewEntry {
  system: string;
  bytes?: number;
  modifiedAt?: string;
}
export interface DesignPreviewsResponse {
  repoRoot?: string | null;
  repoSource?: 'config' | 'cwd' | null;
  previews: DesignPreviewEntry[];
}
/** GET /v1/design-previews/<system>. */
export interface DesignPreviewDocument {
  system: string;
  html: string;
}

// HANDOFF §4.2 — POST /v1/worktrees/dispose wire format. Mirrors
// `src/nexus/api/worktrees.ts:DisposeWorktreeRequest/Response`.
export interface DisposeWorktreeBody {
  path: string;
  force?: boolean;
}
export interface DisposeWorktreeResponse {
  ok: boolean;
  action: 'git-worktree-remove' | 'orphan-session-cleanup' | null;
  cleanedSession?: string;
  error?: string;
  detail?: string;
}

// T4.D — POST /v1/nexus/connect-info/mint-token wire format.
export interface MintConnectToken {
  token: string;
  /** ms-since-epoch · null = no expiry (raw bearer · v1 simple mode). */
  expiresAt: number | null;
  hint: string;
}

// PWA mirror PR 1 — chat-backend Quick Setup snapshot wire format
// (response of GET /v1/nexus/chat-backend-detection). The TUI's
// `buildQuickSetupSnapshot()` produces the same shape; PR 2's React
// card component renders these entries with ✓ / ◯ glyphs.
export type ChatBackendKind = 'codex' | 'claude-code' | 'gemini' | 'none';

export interface ChatBackendDetection {
  detection: { backend: ChatBackendKind; source: string };
  entries: ChatBackendEntry[];
}

export interface ChatBackendEntry {
  provider: 'codex' | 'claude-code' | 'gemini';
  label: string;
  paths: ChatBackendPath[];
}

export interface ChatBackendPath {
  /** Short tag — 'OAuth' / 'OPENAI_API_KEY' / etc. */
  tag: string;
  /** User-facing setup command / hint. Plain text; the card may
   *  wrap inline-code spans on its own. */
  hint: string;
  /** True when the credential is present in env / token store.
   *  Env / token VALUES are never echoed (security policy). */
  detected: boolean;
}

export interface SwitchWire {
  id: string;
  scope: 'global' | 'tab' | 'session';
  kind: 'bool' | 'enum' | 'string' | 'number' | 'secret-ref' | 'multiline' | 'path';
  label: string;
  description: string;
  default: unknown;
  enumValues?: { value: string; label: string; description?: string }[];
  hotApplicable: boolean;
  pwaPreferred?: boolean;
  redactInLogs?: boolean;
  envName?: string;
  legacyEnvName?: string;
  appliesToTabIds?: string[];
  value?: unknown;
}

export type PutSwitchResult =
  | { outcome: 'hot'; switchId: string }
  | { outcome: 'restart'; switchId: string; restartedTabs: string[] }
  | { outcome: 'no-op'; switchId: string };

export interface LogsTailResult {
  id: string;
  lines: number;
  stdout: { path: string; tail: string[]; size: number; mtime?: number };
  stderr: { path: string; tail: string[]; size: number; mtime?: number };
}

// ---- SSE ----
export type Unsubscribe = () => void;

export interface SubscribeOpts {
  /** Topic prefixes to filter (e.g., ['tab.', 'nexus.']). Empty = all. */
  topics?: string[];
  onEvent: (ev: NexusEvent) => void;
  onError?: (err: Error) => void;
  /** Optional EventSource constructor override (tests). */
  EventSourceImpl?: typeof EventSource;
  /** Forward-compat — register named listeners for additional kinds
   *  not in the built-in `KNOWN_KINDS` list. Use when a server adds a
   *  new event kind before the client knows about it. */
  kinds?: string[];
}

export interface SubscribeLogsOpts {
  onLine: (line: { stream: 'stdout' | 'stderr'; line: string }) => void;
  onError?: (err: Error) => void;
  EventSourceImpl?: typeof EventSource;
}

// ---------------------------------------------------------------------------
// createNexusClient
// ---------------------------------------------------------------------------

export function createNexusClient(opts: NexusClientOpts): NexusClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? 8000;
  const optsToken = opts.token;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      // Each attempt owns its timer and abort bridge; a timed-out signal cannot
      // leak into the retry, and caller cancellation always wins if it fires first.
      const ctrl = defaultTimeoutMs > 0 || opts?.signal ? new AbortController() : null;
      let timedOut = false;
      let cleanupExternalAbort: (() => void) | null = null;
      if (ctrl && opts?.signal) {
        const ext = opts.signal;
        if (ext.aborted) {
          ctrl.abort();
        } else {
          const onAbort = () => ctrl.abort();
          ext.addEventListener('abort', onAbort);
          cleanupExternalAbort = () => ext.removeEventListener('abort', onAbort);
        }
      }
      const timer = ctrl && defaultTimeoutMs > 0
        ? setTimeout(() => {
          if (!ctrl.signal.aborted) {
            timedOut = true;
            ctrl.abort();
          }
        }, defaultTimeoutMs)
        : null;
      try {
        const res = await fetchImpl(url, {
          method,
          ...(ctrl ? { signal: ctrl.signal } : {}),
          ...((body !== undefined || optsToken) ? {
            headers: {
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(optsToken ? { authorization: `Bearer ${optsToken}` } : {}),
            },
          } : {}),
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (res.status === 401) reportAuthRequired(path);
        let parsed: unknown = null;
        try {
          parsed = await res.json();
        } catch (err) {
          // Only malformed JSON keeps the old null body; an interrupted read
          // reaches the outer timeout/caller-cancellation handler.
          if (!(err instanceof SyntaxError)) throw err;
        }
        if (!res.ok) {
          if (res.status === 400 && path.startsWith('/v1/workflows/') && path.endsWith('/run')
            && parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error === 'missing-upstream'
            && 'nodes' in parsed && Array.isArray(parsed.nodes) && parsed.nodes.every((node) => typeof node === 'string')) {
            throw new MissingUpstreamError(path, parsed as { error: 'missing-upstream'; nodes: string[] });
          }
          throw new NexusApiError(res.status, path, parsed);
        }
        return parsed as T;
      } catch (err) {
        if (!timedOut || !(err instanceof Error) || err.name !== 'AbortError') throw err;
        if (method !== 'GET' || attempt > 0) throw new NexusTimeoutError(path, defaultTimeoutMs);
      } finally {
        if (timer != null) clearTimeout(timer);
        cleanupExternalAbort?.();
      }
      await new Promise<void>((resolve, reject) => {
        const ext = opts?.signal;
        if (ext?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        const onAbort = () => {
          clearTimeout(delay);
          ext?.removeEventListener('abort', onAbort);
          reject(new DOMException('aborted', 'AbortError'));
        };
        const delay = setTimeout(() => {
          ext?.removeEventListener('abort', onAbort);
          resolve();
        }, 100);
        ext?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  async function installMarketPlugin(spec: string, acceptedCapabilities: string[], onLine: (line: string) => void): Promise<void> {
    const path = '/v1/plugins/install';
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(optsToken ? { authorization: `Bearer ${optsToken}` } : {}) },
      body: JSON.stringify({ spec, acceptedCapabilities }),
    });
    if (res.status === 401) reportAuthRequired(path);
    if (!res.ok) throw new NexusApiError(res.status, path, await res.json());
    if (!res.body) throw new Error('설치 진행 정보를 읽을 수 없습니다.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end).trim();
          pending = pending.slice(end + 1);
          if (line) onLine(line);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) onLine(pending.trim());
    } finally { reader.releaseLock(); }
  }

  return {
    baseUrl,
    // ---- read ----
    getHealth: () => request<NexusHealth>('GET', '/v1/health'),
    getNexus:  () => request<NexusSnapshot>('GET', '/v1/nexus'),
    getTabs: (qopts) => {
      const q = qopts?.kind ? `?kind=${encodeURIComponent(qopts.kind)}` : '';
      return request<{ tabs: NexusTabState[] }>('GET', `/v1/nexus/tabs${q}`);
    },
    getTab: (id) => request('GET', `/v1/nexus/tabs/${encodeURIComponent(id)}`),
    getTaskCards: () => request('GET', TASK_CARDS_PATH),
    getTaskCard: (id) => request('GET', `${TASK_CARDS_PATH}/${encodeURIComponent(id)}`),
    closeTaskCard: (id, reason) => request('POST', `${TASK_CARDS_PATH}/${encodeURIComponent(id)}/close`, { reason }),
    getChatBackendDetection: () => request<ChatBackendDetection>('GET', '/v1/nexus/chat-backend-detection'),
    mintConnectToken: () => request<MintConnectToken>('POST', '/v1/nexus/connect-info/mint-token', {}),
    // ---- tabs mutation ----
    createTab: (body) => request('POST', '/v1/nexus/tabs', body),
    deleteTab: (id) => request('DELETE', `/v1/nexus/tabs/${encodeURIComponent(id)}`),
    patchTab: (id, body) => request('PATCH', `/v1/nexus/tabs/${encodeURIComponent(id)}`, body),
    startTab: (id) => request('POST', `/v1/nexus/tabs/${encodeURIComponent(id)}/start`),
    stopTab: (id, sopts) => {
      const q = sopts?.graceMs !== undefined ? `?graceMs=${sopts.graceMs}` : '';
      return request('POST', `/v1/nexus/tabs/${encodeURIComponent(id)}/stop${q}`);
    },
    restartTab: (id, sopts) => {
      const q = sopts?.graceMs !== undefined ? `?graceMs=${sopts.graceMs}` : '';
      return request('POST', `/v1/nexus/tabs/${encodeURIComponent(id)}/restart${q}`);
    },
    // ---- templates ----
    getTemplates: () => request('GET', '/v1/nexus/templates'),
    getTemplate: (name) => request('GET', `/v1/nexus/templates/${encodeURIComponent(name)}`),
    saveTemplate: (body) => request('POST', '/v1/nexus/templates', body),
    getPluginsIndex: () => request('GET', '/v1/plugins/index'),
    getInstalledPlugins: () => request('GET', '/v1/plugins'),
    refreshPluginMarket: (name) => request('POST', `/v1/plugins/markets/${encodeURIComponent(name)}/refresh`, {}),
    installMarketPlugin,
    removeMarketPlugin: (name) => request('DELETE', `/v1/plugins/${encodeURIComponent(name)}`),
    getPluginCredentials: (name) => request('GET', `/v1/plugins/${encodeURIComponent(name)}/credentials`),
    putPluginCredentials: (name, fields) => request('PUT', `/v1/plugins/${encodeURIComponent(name)}/credentials`, { fields }),
    getRunGraphs: () => request('GET', '/v1/graphs'),
    getRunGraph: (id) => request('GET', `/v1/graphs/${encodeURIComponent(id)}`),
    getRunGraphYaml: (id) => request('GET', `/v1/graphs/${encodeURIComponent(id)}/yaml`),
    putRunGraphYaml: (id, yaml) => request('PUT', `/v1/graphs/${encodeURIComponent(id)}/yaml`, { yaml }),
    cloneRunGraph: (id, newId) => request('POST', `/v1/graphs/${encodeURIComponent(id)}/clone`, { newId }),
    createRunGraph: (id, yaml) => request('POST', '/v1/graphs', { id, yaml }),
    startRunGraphRun: (id) => request('POST', `/v1/graphs/${encodeURIComponent(id)}/run`),
    getRunGraphRun: (id, runId) => request('GET', `/v1/graphs/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
    getGraphKinds: (graph) => request('GET', `/v1/graph/kinds?graph=${graph}`),
    validateGraph: async (graph, yaml) => {
      try {
        return await request<GraphValidationResponse>('POST', '/v1/graphs/validate', { graph, yaml });
      } catch (error) {
        if (error instanceof NexusApiError && error.status === 422 && error.body && typeof error.body === 'object' && 'ok' in error.body) {
          return error.body as GraphValidationResponse;
        }
        throw error;
      }
    },
    // ---- workflows (Archon-port T2.3) ----
    getWorkflows: () => request('GET', '/v1/workflows'),
    getWorkflow: (name) => request('GET', `/v1/workflows/${encodeURIComponent(name)}`),
    getWorkflowHistory: (name) => request<WorkflowHistoryResponse>('GET', `/v1/workflows/${encodeURIComponent(name)}/history`),
    getWorkflowHistoryVersion: (name, id) => request<WorkflowHistoryVersionResponse>('GET', `/v1/workflows/${encodeURIComponent(name)}/history/${encodeURIComponent(id)}`),
    getWorkflowPins: (name) => request('GET', `/v1/workflows/${encodeURIComponent(name)}/pins`),
    putWorkflowPin: (name, nodeId, value, note) => request('PUT', `/v1/workflows/${encodeURIComponent(name)}/pins/${encodeURIComponent(nodeId)}`, {
      value,
      ...(note !== undefined ? { note } : {}),
    }),
    deleteWorkflowPin: (name, nodeId) => request('DELETE', `/v1/workflows/${encodeURIComponent(name)}/pins/${encodeURIComponent(nodeId)}`),
    saveWorkflow: (name, body) => request('PUT', `/v1/workflows/${encodeURIComponent(name)}`, body),
    deleteWorkflow: (name, dopts) => {
      const q = dopts?.scope ? `?scope=${encodeURIComponent(dopts.scope)}` : '';
      return request('DELETE', `/v1/workflows/${encodeURIComponent(name)}${q}`);
    },
    validateWorkflow: (yaml, opts) => request('POST', '/v1/workflows/validate', { yaml }, opts),
    generateWorkflow: (body, opts) => request('POST', '/v1/workflows/generate', body, opts),
    synthesizeWorkflow: (body, opts) => request('POST', '/v1/workflows/synth', body, opts),
    getTriggersSnapshot: (opts) => request('GET', '/v1/triggers', undefined, opts),
    getWorkflowTemplates: (opts) => request('GET', '/v1/workflows/templates', undefined, opts),
    runWorkflow: (name, args, runOpts) =>
      request('POST', `/v1/workflows/${encodeURIComponent(name)}/run`, {
        arguments: args,
        ...(runOpts?.dryRun ? { dryRun: true } : {}),
        ...(runOpts?.onlyNode !== undefined ? { onlyNode: runOpts.onlyNode } : {}),
        ...(runOpts?.fromNode !== undefined ? { fromNode: runOpts.fromNode } : {}),
        ...(runOpts?.fromRunId !== undefined ? { fromRunId: runOpts.fromRunId } : {}),
      }),
    getWorkflowRun: (runId) => request('GET', `/v1/workflows/runs/${encodeURIComponent(runId)}`),
    getWorkflowRuns: () => request('GET', '/v1/workflows/runs'),
    workflowsEventsUrl: () => (baseUrl ? `${baseUrl}/v1/workflows/events` : null),
    getPendingApprovals: () => request('GET', '/v1/workflows/runs/pending'),
    approveRun: (runId, body) =>
      request('POST', `/v1/workflows/runs/${encodeURIComponent(runId)}/approve`, body ?? {}),
    rejectRun: (runId, body) =>
      request('POST', `/v1/workflows/runs/${encodeURIComponent(runId)}/reject`, body ?? {}),
    // ---- config + secrets ----
    getConfig: () => request('GET', '/v1/config'),
    getChatFastPath: () => request('GET', '/v1/config/chat-fast-path'),
    getSwitches: () => request('GET', '/v1/config/switches'),
    getSwitch: (id) => request('GET', `/v1/config/switches/${encodeURIComponent(id)}`),
    putSwitch: (id, body) => request('PUT', `/v1/config/switches/${encodeURIComponent(id)}`, body),
    postSecret: (body) => request('POST', '/v1/config/secrets', body),
    deleteSecret: (id) => request('DELETE', `/v1/config/secrets/${encodeURIComponent(id)}`),
    getSecrets: () => request('GET', '/v1/config/secrets'),
    // M1-2b — friction-free model selection sub-tree round-trip.
    getModelTier: () => request('GET', '/v1/config/model-tier'),
    putModelTier: (body) => request('PUT', '/v1/config/model-tier', body),
    getPlatforms: () => request('GET', '/v1/platforms'),
    // ---- /setup wizard (Phase 1 · 2026-05-19) ----
    getLlmProviders: () => request<LlmProvidersResponse>('GET', '/v1/setup/llm-providers'),
    setLlmProvider: (body) => request<SetLlmProviderResponse>('POST', '/v1/setup/llm-provider', body),
    getObsidianSkills: () => request<ObsidianSkillsState>('GET', '/v1/setup/obsidian-skills'),
    setObsidian: (body) => request('POST', '/v1/setup/obsidian', body),
    setSkills: (body) => request('POST', '/v1/setup/skills', body),
    getChannelBots: () => request<ChannelBotsResponse>('GET', '/v1/setup/channel-bots'),
    setChannelBot: (body) => request<ChannelBotSetResponse>('POST', '/v1/setup/channel-bot', body),
    getChildLlmPreference: () => request<ChildLlmPreferenceResponse>('GET', '/v1/setup/child-llm'),
    setChildLlmPreference: (body) => request<{ resolved: ChildLlmResolved }>('POST', '/v1/setup/child-llm', body),
    getAnswerPriority: () => request<AnswerPriorityResponse>('GET', '/v1/setup/answer-priority'),
    setAnswerPriority: (value) => request<{ value: AnswerPriorityValue }>('POST', '/v1/setup/answer-priority', { value }),
    // ---- /settings PersonaCard (Phase 3 · 2026-05-19) ----
    getPersonas: () => request<PersonasListResponse>('GET', '/v1/personas'),
    getPersonaPresets: () => request<PersonaPresetsResponse>('GET', '/v1/persona-presets'),
    createPersona: (body) => request<PersonaPatchResponse>('POST', '/v1/personas', body),
    patchPersona: (id, edits) => request<PersonaPatchResponse>('PATCH', `/v1/personas/${encodeURIComponent(id)}`, edits),
    patchPersonaDescription: (personaId, description) =>
      request<PersonaPatchResponse>(
        'PATCH',
        `/v1/personas/${encodeURIComponent(personaId)}`,
        { description },
      ),
    getRegistryCatalog: () => request<RegistryCatalogResponse>('GET', '/v1/registry/catalog'),
    getWorktrees: () => request('GET', '/v1/worktrees'),
    getDesignCheck: () => request('GET', '/v1/design-check'),
    getHarnessRuns: () => request('GET', '/v1/harness/runs'),
    getLogs: (query) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, String(v));
      return request('GET', `/v1/logs?${q.toString()}`);
    },
    getLogInstances: () => request('GET', '/v1/logs/instances'),
    getLiveDetail: () => request('GET', '/v1/live/detail'),
    getTrace: (q) => {
      const p = new URLSearchParams({ level: q.level });
      if (q.runId) p.set('runId', q.runId);
      if (q.store) p.set('store', q.store);
      if (q.limit) p.set('limit', String(q.limit));
      if (q.kind) p.set('kind', q.kind);
      if (q.q) p.set('q', q.q);
      if (q.from) p.set('from', new Date(q.from).toISOString());
      return request('GET', `/v1/trace?${p}`);
    },
    // ⛔ ref 를 다시 인코딩하지 않는다 — 서버가 우주 이름을 이미 인코딩해 실었고, 라우트는 날 pathname 을 `^log:` 로 읽는다.
    getTraceEvidence: (ref) => request('GET', `/v1/trace/evidence/${ref}`),
    getLiveShipped: (since) => request('GET', `/v1/live/shipped?since=${encodeURIComponent(since)}`),
    getRunScreen: (runId, lines = 60) => request('GET', `/v1/harness/run-screen?runId=${encodeURIComponent(runId)}&lines=${lines}`),
    stopHarness: (spaceId) => request('POST', '/v1/harness/stop', { spaceId }),
    setLiveDetail: (body) => request('POST', '/v1/live/detail', body),
    setDesignDirection: (id) => request('POST', '/v1/design-direction', { id }),
    createDesignSystem: (body) => request('POST', '/v1/design-system', body),
    listDesignPreviews: () => request('GET', '/v1/design-previews'),
    getDesignPreview: (system) => request('GET', `/v1/design-previews/${encodeURIComponent(system)}`),
    disposeWorktree: (body) => request('POST', '/v1/worktrees/dispose', body),
    // ---- log streaming ----
    getLogsTail: (id, lopts) => {
      const q = lopts?.lines !== undefined ? `?lines=${lopts.lines}` : '';
      return request('GET', `/v1/nexus/tabs/${encodeURIComponent(id)}/logs${q}`);
    },
    // ---- SSE ----
    subscribeEvents: (subOpts) => {
      const ESImpl = subOpts.EventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
      if (!ESImpl) {
        throw new Error('EventSource not available · pass EventSourceImpl');
      }
      const topics = (subOpts.topics ?? []).join(',');
      const url = `${baseUrl}/v1/events${topics ? `?topics=${encodeURIComponent(topics)}` : ''}`;
      const es = new ESImpl(url);
      const handler = (e: MessageEvent): void => {
        try {
          const ev = JSON.parse(e.data) as NexusEvent;
          subOpts.onEvent(ev);
        } catch (err) {
          subOpts.onError?.(err as Error);
        }
      };
      // The server (`src/nexus/api/events.ts`) emits each frame as
      // `event: <kind>\ndata: <json>\n\n`. Per the EventSource spec a
      // frame with an explicit `event:` field dispatches to a named
      // listener — `addEventListener('message', ...)` ALONE will miss
      // every frame that has the field. So we attach the same handler
      // to each known kind explicitly. Kinds list mirrors
      // `NexusEvent.kind` in `src/nexus/state/state.ts`.
      //
      // Caller can also pass `kinds` to extend (forward-compat — when
      // the server adds a kind the union will fail typecheck, but the
      // wire still flows because callers can pre-register).
      const KNOWN_KINDS: readonly string[] = [
        'nexus.boot',
        'nexus.shutdown',
        'tab.created',
        'tab.up',
        'tab.down',
        'tab.unhealthy',
        'tab.restart',
        'tab.halt',
        'config.changed',
        'workflow.approval.pending',
        'workflow.approval.resolved',
        'workflow.run.started',
        'workflow.run.node-started',
        'workflow.run.node-skipped',
        'workflow.run.node-done',
        'workflow.run.completed',
        'workflow.run.failed',
        // β-1a · in-app HITL banner
        'hitl.banner.show',
        'hitl.banner.cancel',
        // 2026-05-09 dogfood fix — IntentPanel ranker fan-out via
        // global event bus. The container subscribes with
        // `kinds: ['intent-prediction.ranking']` but `subscribeEvents`
        // only attaches named-event listeners for kinds in this
        // KNOWN_KINDS array (or what `subOpts.kinds` adds — see the
        // merge below). We bake the kind in here so callers don't
        // need to pass it.
        'intent-prediction.ranking',
      ];
      const allKinds = subOpts.kinds
        ? [...new Set([...KNOWN_KINDS, ...subOpts.kinds])]
        : KNOWN_KINDS;
      es.addEventListener('message', handler as EventListener);
      for (const k of allKinds) {
        es.addEventListener(k, handler as EventListener);
      }
      es.addEventListener('error', () => {
        try {
          debugLog('nexus.sse.error', {
            url,
            readyState: es.readyState,
            connectionState: es.readyState === 0 ? 'reconnecting' : es.readyState === 2 ? 'closed' : 'open',
          });
        } catch { /* observability must not disrupt SSE error handling */ }
        subOpts.onError?.(new Error('SSE error'));
      });
      return () => { try { es.close(); } catch { /* idempotent */ } };
    },
    subscribeLogs: (id, subOpts) => {
      const ESImpl = subOpts.EventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
      if (!ESImpl) {
        throw new Error('EventSource not available · pass EventSourceImpl');
      }
      const url = `${baseUrl}/v1/nexus/tabs/${encodeURIComponent(id)}/logs?stream=1`;
      const es = new ESImpl(url);
      const handler = (e: MessageEvent): void => {
        try {
          const parsed = JSON.parse(e.data) as { stream: 'stdout' | 'stderr'; line: string };
          subOpts.onLine(parsed);
        } catch (err) {
          subOpts.onError?.(err as Error);
        }
      };
      es.addEventListener('message', handler as EventListener);
      es.addEventListener('log', handler as EventListener);
      es.addEventListener('error', () => {
        try {
          debugLog('nexus.sse.error', {
            url,
            readyState: es.readyState,
            connectionState: es.readyState === 0 ? 'reconnecting' : es.readyState === 2 ? 'closed' : 'open',
          });
        } catch { /* observability must not disrupt SSE error handling */ }
        subOpts.onError?.(new Error('SSE error'));
      });
      return () => { try { es.close(); } catch { /* idempotent */ } };
    },
  };
}
