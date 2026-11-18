// AXON P1 — ACP Dual-Role Manager.
//
// Unified registry for elanous's two-way ACP sessions:
//
//   - SERVER sessions — elanous is the agent, parent IDE / orchestrator drives.
//     Ids live in the `acp-srv:` namespace and are registered by
//     `src/acp/server.ts` when a client calls newSession().
//
//   - CLIENT sessions — elanous drives an external ACP agent (claude-code-acp,
//     codex-acp, gemini ACP). Ids live in the `acp-cli:` namespace and are
//     created through `clientSessionCreate()` below, which spawns / reuses
//     an AcpAgent via the existing agent-manager.
//
// Why a single manager? Because the two surfaces can meet mid-turn — a
// server session may spawn a client session as a sub-tool, and reentrancy
// protection needs a shared hop counter to throw before stacks blow up.
// Keeping both namespaces in one map also means sidebar / TOX / debug
// tools only learn one lookup.
//
// Out of MVP scope (future): persistent store, audit log, distributed
// lock. Process-wide singleton is enough for the single-elanous-per-tty
// topology we target.

import { basename } from 'node:path';
import type { ContentBlock, StopReason } from '@agentclientprotocol/sdk';
import type {
  AcpAgent,
  AcpPermissionApprover,
  AcpPromptResult,
  AcpQuestionApprover,
  AcpUpdateCallback,
} from './client.js';
import { globalAcpAgentManager } from './agent-manager.js';
import type { AcpSessionStub, AgentKind } from '../session/card.js';
import { debug } from '../debug/log.js';
import { llmObserveDelegation } from '../session-runtime/llm-call-gateway.js';
import type { SessionUri } from '../mss/uri/brand.js';
import { unsafeBrandSessionUri } from '../mss/uri/brand.js';

// ⛔ 값은 «잎»이 갖는다 — 이유는 `namespaces.ts` 머리말(무거운 그래프 없이 접두만 쓰려는 소비처가 있다).
import { CLIENT_NAMESPACE, SERVER_NAMESPACE } from './namespaces.js';
export { CLIENT_NAMESPACE, SERVER_NAMESPACE };

/** UI-Core arc Phase U1 — narrow change event emitted for SessionStore
 *  facade subscription. Deliberately free of AcpAgent references so the
 *  payload can cross a wire in Phase U4 without re-normalizing.
 *
 *  MSS M1.1 Phase B3 — `sessionId` / `parentSessionId` narrowed to the
 *  `SessionUri` brand. DRM records still hold these as `string`
 *  (namespaced `acp-cli:<brand>:<raw>` / `acp-srv:<raw>` ids are not
 *  themselves ElanousUri-shaped), so the emit path brands via
 *  `unsafeBrandSessionUri` at each call site — phantom cast, zero
 *  runtime cost. */
export type DualRoleChangeEvent =
  | { kind: 'client-registered'; sessionId: SessionUri; backendId: string; backendSessionId: string; cwd: string; parentSessionId?: SessionUri }
  | { kind: 'client-evicted'; sessionId: SessionUri; backendId: string; backendSessionId: string }
  | { kind: 'client-turn-ended'; sessionId: SessionUri; backendId: string; backendSessionId: string }
  | { kind: 'server-registered'; sessionId: SessionUri; backendSessionId: string; cwd: string }
  | { kind: 'server-unregistered'; sessionId: SessionUri; backendSessionId: string };

/** AXON P6 — env vars stripped when deriving a ChildProfile via
 *  `inheritProfile()`. Mirrors `src/acp/client.ts::NESTED_AGENT_ENV_
 *  BLOCKLIST` so children spawned outside the AcpAgent path still
 *  get the same hygiene. Any env var whose key appears here (or
 *  starts with one of `AXON_CHILD_ENV_BLOCK_PREFIXES`) is removed
 *  from the inherited environment. */
export const AXON_CHILD_ENV_BLOCKLIST: readonly string[] = [
  'CLAUDECODE',
  'ELANOUS_SESSION_ID',
  'ELANOUS_UNDO_REF',
  'ELANOUS_GUARDIAN',
  'ELANOUS_UNDO',
  'ELANOUS_HITL_CALLBACK_PORT',
  'ELANOUS_HITL_PORT',
  'ELANOUS_HITL_PORT_SCAN_RANGE',
];

export const AXON_CHILD_ENV_BLOCK_PREFIXES: readonly string[] = [
  'CLAUDE_CODE_',  // matches client.ts regex
];

/** Backend id → sidebar AgentKind. The ACP backend registry uses
 *  short canonical ids (`claude` / `codex` / `gemini`); the sidebar
 *  palette uses more descriptive AgentKinds (`claude-code` /
 *  `codex` / `gemini-cli`). This mapping is the one-source-of-truth
 *  at the rendering boundary. */
export function backendIdToAgentKind(backendId: string): AgentKind {
  switch (backendId) {
    case 'claude': return 'claude-code';
    case 'codex':  return 'codex';
    case 'gemini': return 'gemini-cli';
    default:       return 'other';
  }
}

/** Profile shape returned by `DualRoleManager.inheritProfile`. */
export interface ChildProfile {
  model?: string;
  permissionMode?: 'plan' | 'auto' | 'default';
  env?: Record<string, string>;
  /** Warp "Last seen by agent at" — propagated from the parent so the
   *  child's sidebar row starts with the correct activity stamp. */
  lastSeenAt?: number;
}

export interface InheritProfileOpts {
  /** Override the blocklist — tests + advanced callers. Default is
   *  `AXON_CHILD_ENV_BLOCKLIST`. */
  envBlocklist?: readonly string[];
  /** Override the block-prefix list. Default is
   *  `AXON_CHILD_ENV_BLOCK_PREFIXES`. */
  envBlockPrefix?: readonly string[];
  /** Source env map. Defaults to `process.env`; tests inject a fixture
   *  to avoid polluting global state. */
  parentEnv?: NodeJS.ProcessEnv;
}

/** Reentrancy guard — a server turn that spawns a client, which emits
 *  a tool call that re-enters the server, and so on. Three hops is
 *  enough to cross one back-and-forth cycle (srv → cli → srv). More
 *  than that is almost certainly a loop, and blowing up early keeps
 *  the stack trace readable. */
export const DEFAULT_HOP_CAP = 3;

/** Follow-up #7 — per-brand HOP_CAP resolver. Dashboard boot wires
 *  this against the user's config (`acp.hopCap.{claude,codex,gemini,
 *  default}`) so each brand can carry its own chain-depth budget
 *  without plumbing config through every caller. Returns `undefined`
 *  when no brand-specific value is set so the resolver can fall back
 *  to DEFAULT_HOP_CAP. The explicit `opts.hopCap` on
 *  `ClientSessionCreateOpts` always wins over both the resolver and
 *  the default. */
let _hopCapResolver: ((brandId: string) => number | undefined) | null = null;

export function setAcpHopCapResolver(
  fn: ((brandId: string) => number | undefined) | null,
): void {
  _hopCapResolver = fn;
}

/** Resolve the effective HOP_CAP for a brand. Precedence:
 *    1. explicit `opts.hopCap` (caller-supplied override)
 *    2. brand-specific resolver (user-config)
 *    3. DEFAULT_HOP_CAP
 *  Values ≤ 0 from the resolver are ignored · the resolver is
 *  user-sourced config so a malformed entry must not disable the
 *  reentrancy guard. */
export function resolveAcpHopCap(brandId: string, explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const resolver = _hopCapResolver;
  if (resolver) {
    try {
      const v = resolver(brandId);
      if (typeof v === 'number' && v > 0) return v;
    } catch { /* malformed resolver — ignore, fall through to default */ }
  }
  return DEFAULT_HOP_CAP;
}

export type SessionKind = 'client' | 'server';

export interface ClientSessionRecord {
  kind: 'client';
  /** Namespaced id — `acp-cli:<backend>:<sessionId>`. */
  id: string;
  /** ACP session id as assigned by the backend. Distinct from the
   *  namespaced id so callers resolving sessionId from an
   *  AcpAgent.prompt() response can still find the record. */
  backendSessionId: string;
  /** Backend brand (`claude` / `codex` / `gemini`). */
  backendId: string;
  cwd: string;
  createdAt: number;
  /** Timestamp of the last sessionUpdate we observed — Warp's
   *  "Last seen by agent at" pattern. Defaults to createdAt until
   *  the first update lands. */
  lastSeenAt: number;
  /** Bound AcpAgent — shared with other sessions of the same
   *  backend+cwd via agent-manager. */
  agent: AcpAgent;
  /** Number of hops in the current call chain. Incremented by
   *  `enterSend()`, decremented by `leaveSend()`. */
  activeHops: number;
  /** AXON P6 — optional pinned model for the session. When set,
   *  `inheritProfile()` propagates this to child agents spawned
   *  downstream. Populated via `clientSessionCreate({ model })`. */
  model?: string;
  /** AXON P6 — optional permission posture inherited by child
   *  agents. 'plan' = no edits, 'auto' = approve-within-whitelist,
   *  'default' = prompt every decision. */
  permissionMode?: 'plan' | 'auto' | 'default';
  /** H3 #7 — subagent chain linkage. Undefined for roots, set to the
   *  parent's namespaced id when spawned via `clientSessionCreate({
   *  parentSessionId })`. Never mutates after create. */
  parentSessionId?: string;
  /** H3 #7 — cached chain depth. Root = 0, child of root = 1, … Set
   *  at create time as `parent.chainDepth + 1`; never mutates. HOP_CAP
   *  check at create compares against this. O(1) read vs. walking the
   *  parent chain on every spawn. */
  chainDepth: number;
}

export interface ServerSessionRecord {
  kind: 'server';
  /** Namespaced id — `acp-srv:<backendSessionId>`. */
  id: string;
  /** ACP session id as assigned by elanous's own server (`elanous-session-N`). */
  backendSessionId: string;
  cwd: string;
  createdAt: number;
  lastSeenAt: number;
  activeHops: number;
}

export type SessionRecord = ClientSessionRecord | ServerSessionRecord;

export interface ClientSessionCreateOpts {
  backendId: string;
  cwd?: string;
  /** Override permission/question approvers on the shared AcpAgent.
   *  When omitted, the agent-manager's default wiring is respected. */
  permissionApprover?: AcpPermissionApprover;
  questionApprover?: AcpQuestionApprover;
  /** AXON P6 — pin a model for this session. Persisted on the record
   *  so `inheritProfile()` can propagate downstream. */
  model?: string;
  /** AXON P6 — set the permission posture. Persisted similarly. */
  permissionMode?: 'plan' | 'auto' | 'default';
  /** H3 #7 — parent session id. When set, spawns a subagent:
   *  records the parent link, sets `chainDepth = parent.chainDepth +
   *  1`, and throws `ReentrancyError` if the new depth would reach
   *  `hopCap`. Unknown parent → `UnknownSessionError`. */
  parentSessionId?: string;
  /** H3 #7 — override the chain-depth cap at create time. Defaults
   *  to `DEFAULT_HOP_CAP`. Independent from the per-send `hopCap`
   *  on `ClientSessionSendOpts`. */
  hopCap?: number;
  /** Legacy ThreadOptions override carried by `AcpSessionCreate` for
   *  backward compatibility. Sprint 5B (2026-04-28) removed the
   *  codex-native consumer; the field is now silently ignored on
   *  every brand and exists only to absorb LLM tool args without
   *  schema regression. */
  codexOptions?: {
    model?: string;
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
    networkAccessEnabled?: boolean;
    webSearchMode?: 'disabled' | 'cached' | 'live';
    additionalDirectories?: string[];
  };
}

export interface ClientSessionSendOpts {
  sessionId: string;
  /** Plain text or an explicit ContentBlock array. Plain text is
   *  lifted into a single `{type:'text',text}` block. */
  message: string | ContentBlock[];
  /** Per-prompt streaming callback — forwarded to AcpAgent.prompt.
   *  Updates also bump lastSeenAt on the corresponding record. */
  onUpdate?: AcpUpdateCallback;
  /** Hop-cap override for advanced use. Defaults to DEFAULT_HOP_CAP. */
  hopCap?: number;
  /** Follow-up #4 — pass-through to `AcpAgent.prompt({ _meta })`. Used
   *  by `AcpSessionSpawnSub` to carry subagent linkage (`writeSubagentMeta`
   *  output) on the wire so Zed-family peers auto-recognize the child.
   *  Opaque to the manager — callers decide the schema. */
  meta?: Record<string, unknown>;
}

export interface ClientSessionSendResult extends AcpPromptResult {
  /** The namespaced id, echoed back so LLM tools don't have to
   *  re-build it. */
  sessionId: string;
  lastSeenAt: number;
}

export class ReentrancyError extends Error {
  constructor(sessionId: string, hops: number, cap: number) {
    super(`ACP reentrancy cap exceeded for ${sessionId} — hops=${hops} cap=${cap}`);
    this.name = 'ReentrancyError';
  }
}

export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`Unknown ACP session: ${sessionId}`);
    this.name = 'UnknownSessionError';
  }
}

/** Follow-up #1 — turn-end broadcast event. Fires from
 *  `clientSessionSend`'s try-block when the underlying prompt
 *  resolves. `history` is the accumulated user blocks + a single
 *  concatenated agent-text block (H3 #6 auto-persist primitive).
 *  Listeners are best-effort (exceptions are swallowed so one bad
 *  subscriber can't derail the turn). */
export interface TurnEndEvent {
  readonly record: ClientSessionRecord;
  readonly history: ContentBlock[];
  readonly stopReason: StopReason;
}

function now(): number { return Date.now(); }

function namespacedClientId(backendId: string, backendSessionId: string): string {
  return `${CLIENT_NAMESPACE}${backendId}:${backendSessionId}`;
}

function namespacedServerId(backendSessionId: string): string {
  return `${SERVER_NAMESPACE}${backendSessionId}`;
}

export class DualRoleManager {
  private readonly records = new Map<string, SessionRecord>();
  /** Secondary index — backend session id → namespaced id. Lets us
   *  look up a record when an update / approver callback only knows
   *  the raw ACP sessionId. */
  private readonly byBackendId = new Map<string, string>();
  /** H3 #7 — parent id → set of direct child ids. Updated on create
   *  + close. O(1) childrenOf / descendantsOf lookups without scanning
   *  every record. Entries with empty sets are removed on last-child
   *  eviction to keep the map bounded. */
  private readonly childrenByParent = new Map<string, Set<string>>();
  /** Follow-up #1 — turn-end listeners. Auto-persist wiring subscribes
   *  here; other consumers can too. Process-lifetime by default · tests
   *  use `__clearForTest` to drop listeners alongside records. */
  private readonly turnEndListeners = new Set<(ev: TurnEndEvent) => void>();

  /** UI-Core arc Phase U1 — SessionStore facade subscribes here. Fires
   *  on every client/server session register/unregister/evict + turn-end
   *  with a narrow, serializable payload (no AcpAgent handle). */
  private readonly changeListeners = new Set<(ev: DualRoleChangeEvent) => void>();

  list(kind?: SessionKind): readonly SessionRecord[] {
    const all = [...this.records.values()];
    return kind ? all.filter(r => r.kind === kind) : all;
  }

  get(sessionId: string): SessionRecord | undefined {
    const direct = this.records.get(sessionId);
    if (direct) return direct;
    const resolved = this.byBackendId.get(sessionId);
    return resolved ? this.records.get(resolved) : undefined;
  }

  serverSessionById(sessionId: string): ServerSessionRecord | undefined {
    const r = this.get(sessionId);
    return r && r.kind === 'server' ? r : undefined;
  }

  clientSessionById(sessionId: string): ClientSessionRecord | undefined {
    const r = this.get(sessionId);
    return r && r.kind === 'client' ? r : undefined;
  }

  /** Register a server session — called from `src/acp/server.ts`
   *  on newSession(). The raw ACP id is remembered for lookup so
   *  the corresponding `cancel` / metrics paths can find it. */
  serverSessionRegister(backendSessionId: string, cwd: string): ServerSessionRecord {
    const id = namespacedServerId(backendSessionId);
    const record: ServerSessionRecord = {
      kind: 'server',
      id,
      backendSessionId,
      cwd,
      createdAt: now(),
      lastSeenAt: now(),
      activeHops: 0,
    };
    this.records.set(id, record);
    this.byBackendId.set(backendSessionId, id);
    this.fireChange({ kind: 'server-registered', sessionId: unsafeBrandSessionUri(id), backendSessionId, cwd });
    return record;
  }

  serverSessionUnregister(sessionId: string): boolean {
    const r = this.get(sessionId);
    if (!r || r.kind !== 'server') return false;
    this.records.delete(r.id);
    this.byBackendId.delete(r.backendSessionId);
    this.fireChange({ kind: 'server-unregistered', sessionId: unsafeBrandSessionUri(r.id), backendSessionId: r.backendSessionId });
    return true;
  }

  /** Mark a sessionUpdate / notification. Safe no-op when the
   *  id is unknown — inbound event hooks should not care. */
  markLastSeen(sessionId: string, ts: number = now()): void {
    const r = this.get(sessionId);
    if (!r) return;
    r.lastSeenAt = ts;
  }

  async clientSessionCreate(opts: ClientSessionCreateOpts): Promise<ClientSessionRecord> {
    // H3 #7 — subagent chain-depth check BEFORE spawning. Rejects
    // infinite-regress before the expensive agent.newSession() call,
    // and surfaces the typed ReentrancyError to the LLM tool layer.
    let parent: ClientSessionRecord | undefined;
    let chainDepth = 0;
    if (opts.parentSessionId !== undefined) {
      parent = this.clientSessionById(opts.parentSessionId);
      if (!parent) throw new UnknownSessionError(opts.parentSessionId);
      chainDepth = parent.chainDepth + 1;
      // Follow-up #7 — brand-aware HOP_CAP. Resolver returns the
      // per-brand cap from user-config when the dashboard is wired;
      // tests use `setAcpHopCapResolver(fn)` to drive it directly.
      // `opts.hopCap` still wins for advanced callers (tests +
      // ad-hoc overrides).
      const cap = resolveAcpHopCap(opts.backendId, opts.hopCap);
      if (chainDepth >= cap) {
        throw new ReentrancyError(parent.id, chainDepth, cap);
      }
    }
    const agent = await this.acquireAgent(opts);
    // Sprint 5B (2026-04-28) removed the codex-native branch that
    // previously forwarded `opts.codexOptions` to a per-turn SDK
    // subprocess. The field is now silently dropped — kept on the
    // input shape only so existing LLM tool args don't regress.
    const backendSessionId = await agent.newSession();
    return this.registerClientSession({
      agent,
      backendId: opts.backendId,
      backendSessionId,
      cwd: opts.cwd ?? '',
      chainDepth,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(parent !== undefined ? { parentSessionId: parent.id } : {}),
    });
  }

  /** Resolve an AcpAgent for a session create request. Overridable
   *  via `__setAgentFactoryForTest` so tests don't spawn real
   *  subprocesses. Production path always goes through
   *  `globalAcpAgentManager().getAgent()`. */
  private async acquireAgent(opts: ClientSessionCreateOpts): Promise<AcpAgent> {
    if (this.agentFactory) return this.agentFactory(opts);
    const manager = globalAcpAgentManager();
    return manager.getAgent(opts.backendId, {
      cwd: opts.cwd,
      permissionApprover: opts.permissionApprover,
      questionApprover: opts.questionApprover,
    });
  }

  private agentFactory: ((opts: ClientSessionCreateOpts) => Promise<AcpAgent> | AcpAgent) | null = null;

  /** Tests: inject a fake AcpAgent factory so `clientSessionCreate`
   *  doesn't reach into agent-manager + spawn subprocesses. */
  __setAgentFactoryForTest(
    factory: ((opts: ClientSessionCreateOpts) => Promise<AcpAgent> | AcpAgent) | null,
  ): void {
    this.agentFactory = factory;
  }

  /** Internal — shared between `clientSessionCreate` and test seams.
   *  The backendSessionId here must already be returned by the agent
   *  (or minted by the test). */
  private registerClientSession(args: {
    agent: AcpAgent;
    backendId: string;
    backendSessionId: string;
    cwd: string;
    chainDepth?: number;
    parentSessionId?: string;
    model?: string;
    permissionMode?: 'plan' | 'auto' | 'default';
  }): ClientSessionRecord {
    const record: ClientSessionRecord = {
      kind: 'client',
      id: namespacedClientId(args.backendId, args.backendSessionId),
      backendSessionId: args.backendSessionId,
      backendId: args.backendId,
      cwd: args.cwd,
      createdAt: now(),
      lastSeenAt: now(),
      agent: args.agent,
      activeHops: 0,
      chainDepth: args.chainDepth ?? 0,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      ...(args.parentSessionId !== undefined ? { parentSessionId: args.parentSessionId } : {}),
    };
    this.records.set(record.id, record);
    this.byBackendId.set(args.backendSessionId, record.id);
    if (args.parentSessionId !== undefined) {
      let children = this.childrenByParent.get(args.parentSessionId);
      if (!children) {
        children = new Set<string>();
        this.childrenByParent.set(args.parentSessionId, children);
      }
      children.add(record.id);
    }
    const payload: Extract<DualRoleChangeEvent, { kind: 'client-registered' }> = {
      kind: 'client-registered',
      sessionId: unsafeBrandSessionUri(record.id),
      backendId: record.backendId,
      backendSessionId: record.backendSessionId,
      cwd: record.cwd,
    };
    if (args.parentSessionId !== undefined) payload.parentSessionId = unsafeBrandSessionUri(args.parentSessionId);
    this.fireChange(payload);
    return record;
  }

  async clientSessionSend(opts: ClientSessionSendOpts): Promise<ClientSessionSendResult> {
    const record = this.clientSessionById(opts.sessionId);
    if (!record) throw new UnknownSessionError(opts.sessionId);

    const cap = opts.hopCap ?? DEFAULT_HOP_CAP;
    if (record.activeHops >= cap) {
      throw new ReentrancyError(record.id, record.activeHops, cap);
    }

    const blocks: ContentBlock[] = typeof opts.message === 'string'
      ? [{ type: 'text', text: opts.message }]
      : opts.message;

    // Follow-up #1 — accumulate agent text chunks so turn-end
    // listeners receive a usable history. Non-text updates (tool_call,
    // plan, ...) are observable via opts.onUpdate as usual · the
    // history blob is deliberately minimal (user message + agent text)
    // to keep auto-persist free of schema volatility. DashboardAcpChat
    // can still feed richer snapshots directly to the persistence
    // primitive when a plan / toolCalls record is needed.
    const agentTextParts: string[] = [];
    const onUpdate: AcpUpdateCallback = (update) => {
      this.markLastSeen(record.backendSessionId);
      const text = extractAgentTextFromUpdate(update);
      if (text) agentTextParts.push(text);
      if (opts.onUpdate) {
        try { opts.onUpdate(update); } catch { /* consumer error must not derail turn */ }
      }
    };

    record.activeHops += 1;
    try {
      // One delegated prompt row per ACP session/prompt invocation, not per HTTP request
      // inside the external agent subprocess. The HTTP host is not observable here.
      // The peer's active model can change after session/new; probing it is best-effort
      // telemetry and must never prevent the prompt from being sent.
      let activeModel: string | undefined;
      try { activeModel = record.agent.getSessionModels?.(record.backendSessionId)?.currentModelId; }
      catch { /* peer model unavailable — still dispatch the prompt */ }
      const result = await llmObserveDelegation({
        provider: record.backendId,
        ...(activeModel ? { model: activeModel } : {}),
        sessionId: record.id,
        ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
        role: 'child',
        requestedBy: 'acp.session/prompt',
        selectionSource: activeModel ? 'session' : 'explicit',
        ...(record.backendId === 'claude' || record.backendId === 'codex-app-server'
          ? { billing: 'subscription' as const } : {}),
      }, () => record.agent.prompt(
        record.backendSessionId,
        blocks,
        onUpdate,
        opts.meta,
      ));
      // Final lastSeen bump on turn resolution — mirrors sessionUpdate
      // arrival so clients that receive no updates still see an
      // activity stamp on completion.
      this.markLastSeen(record.backendSessionId);
      // Follow-up #1 — fire turn-end listeners. history = user blocks
      // + single agent text block (empty blob omitted so listeners
      // can skip non-textual turns).
      if (this.turnEndListeners.size > 0) {
        const history: ContentBlock[] = [...blocks];
        const joined = agentTextParts.join('');
        if (joined.length > 0) {
          history.push({ type: 'text', text: joined });
        }
        this.fireTurnEnd({ record, history, stopReason: result.stopReason });
      }
      return {
        stopReason: result.stopReason,
        sessionId: record.id,
        lastSeenAt: record.lastSeenAt,
      };
    } finally {
      record.activeHops = Math.max(0, record.activeHops - 1);
    }
  }

  /** Inject additional input into a session's CURRENTLY RUNNING turn
   *  (codex `turn/steer`) without interrupting it — for mid-mission
   *  "also do X" instructions. Only backends whose agent implements
   *  `steer()` (codex-app-server today) can steer; others return `false`
   *  so the caller can fall back to queue-for-next-turn. Returns whether
   *  the live turn was steered. */
  async clientSessionSteer(opts: { sessionId: string; message: string | ContentBlock[] }): Promise<boolean> {
    const record = this.clientSessionById(opts.sessionId);
    if (!record) throw new UnknownSessionError(opts.sessionId);
    const agent = record.agent as unknown as {
      steer?: (sessionId: string, blocks: ContentBlock[]) => Promise<boolean>;
    };
    if (typeof agent.steer !== 'function') return false;
    const blocks: ContentBlock[] = typeof opts.message === 'string'
      ? [{ type: 'text', text: opts.message }]
      : opts.message;
    const steered = await agent.steer(record.backendSessionId, blocks);
    if (steered) this.markLastSeen(record.backendSessionId);
    return steered;
  }

  /** Set a session's codex-native goal (objective + optional token
   *  budget) so the backend tracks progress + enforces the budget. Only
   *  backends whose agent implements `setGoal` (codex) act; others
   *  return null. Returns the resulting goal object (opaque here). */
  async clientSessionSetGoal(opts: {
    sessionId: string;
    objective?: string;
    tokenBudget?: number;
  }): Promise<unknown | null> {
    const record = this.clientSessionById(opts.sessionId);
    if (!record) throw new UnknownSessionError(opts.sessionId);
    const agent = record.agent as unknown as {
      setGoal?: (sessionId: string, goal: { objective?: string; tokenBudget?: number }) => Promise<unknown>;
    };
    if (typeof agent.setGoal !== 'function') return null;
    const goalInput: { objective?: string; tokenBudget?: number } = {};
    if (opts.objective !== undefined) goalInput.objective = opts.objective;
    if (opts.tokenBudget !== undefined) goalInput.tokenBudget = opts.tokenBudget;
    return (await agent.setGoal(record.backendSessionId, goalInput)) ?? null;
  }

  /** Read a session's codex goal (null when unsupported / none). */
  async clientSessionGetGoal(opts: { sessionId: string }): Promise<unknown | null> {
    const record = this.clientSessionById(opts.sessionId);
    if (!record) throw new UnknownSessionError(opts.sessionId);
    const agent = record.agent as unknown as {
      getGoal?: (sessionId: string) => Promise<unknown>;
    };
    if (typeof agent.getGoal !== 'function') return null;
    return (await agent.getGoal(record.backendSessionId)) ?? null;
  }

  /** Follow-up #1 — subscribe to turn-end events. Returns unsubscribe
   *  fn. Broadcasts synchronously; exceptions are swallowed so one
   *  listener can't wedge others. */
  onTurnEnd(listener: (ev: TurnEndEvent) => void): () => void {
    this.turnEndListeners.add(listener);
    return () => { this.turnEndListeners.delete(listener); };
  }

  private fireTurnEnd(ev: TurnEndEvent): void {
    for (const listener of Array.from(this.turnEndListeners)) {
      try {
        listener(ev);
      } catch (err) {
        if (debug.enabled) {
          debug.log('acp.drm.turn-end-listener-error', ev.record.id, {
            message: (err as Error)?.message,
          }, { level: 'error' });
        }
      }
    }
    if (ev.record.kind === 'client') {
      this.fireChange({
        kind: 'client-turn-ended',
        sessionId: unsafeBrandSessionUri(ev.record.id),
        backendId: ev.record.backendId,
        backendSessionId: ev.record.backendSessionId,
      });
    }
  }

  /** UI-Core arc Phase U1 — subscribe to narrow change events. Returns
   *  unsubscribe fn. Broadcasts synchronously; exceptions are swallowed
   *  so one listener can't wedge others. SessionStore facade is the
   *  primary consumer; raw callers can use it too for targeted hooks. */
  onChange(listener: (ev: DualRoleChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private fireChange(ev: DualRoleChangeEvent): void {
    for (const listener of Array.from(this.changeListeners)) {
      try {
        listener(ev);
      } catch (err) {
        if (debug.enabled) {
          debug.log('acp.drm.change-listener-error', ev.sessionId, {
            kind: ev.kind,
            message: (err as Error)?.message,
          }, { level: 'error' });
        }
      }
    }
  }

  async clientSessionClose(
    sessionId: string,
    opts: { cascade?: boolean } = {},
  ): Promise<boolean> {
    const record = this.clientSessionById(sessionId);
    if (!record) return false;
    const cascade = opts.cascade !== false; // default true
    // H3 #7 — cascade close: cancel + evict every transitive
    // descendant BEFORE the parent. Leaves-first ordering so a
    // parent isn't torn down while a child RPC is still in flight.
    // Errors are swallowed per the existing best-effort close
    // contract (see `record.agent.cancel` catch below).
    if (cascade) {
      const descendants = this.descendantsOf(record.id);
      for (let i = descendants.length - 1; i >= 0; i--) {
        const d = descendants[i];
        if (!d) continue;
        try { await d.agent.cancel(d.backendSessionId); }
        catch { /* best-effort */ }
        this.evictClientRecord(d);
      }
    }
    // We intentionally do NOT stop the underlying AcpAgent — it's
    // shared across (backend, cwd) and other sessions may still be
    // live. agent-manager.drop() / stopAll() is the explicit path
    // for tearing down the subprocess.
    try {
      await record.agent.cancel(record.backendSessionId);
    } catch { /* cancel best-effort; store eviction always runs */ }
    this.evictClientRecord(record);
    return true;
  }

  /** H3 #7 — single-record cleanup · shared between direct close
   *  and cascade close. Removes from records + byBackendId +
   *  detaches from parent's children set if linked. */
  private evictClientRecord(record: ClientSessionRecord): void {
    this.records.delete(record.id);
    this.byBackendId.delete(record.backendSessionId);
    this.fireChange({
      kind: 'client-evicted',
      sessionId: unsafeBrandSessionUri(record.id),
      backendId: record.backendId,
      backendSessionId: record.backendSessionId,
    });
    // Detach from parent's children set.
    if (record.parentSessionId !== undefined) {
      const siblings = this.childrenByParent.get(record.parentSessionId);
      if (siblings) {
        siblings.delete(record.id);
        if (siblings.size === 0) {
          this.childrenByParent.delete(record.parentSessionId);
        }
      }
    }
    // Clear our own children map entry so orphaned descendants don't
    // leak a stale reference (they'll still live as roots until
    // explicitly closed).
    this.childrenByParent.delete(record.id);
  }

  /** H3 #7 — direct children of the given session, in insertion
   *  order. Returns [] for unknown ids or sessions with no children. */
  childrenOf(sessionId: string): ClientSessionRecord[] {
    const childIds = this.childrenByParent.get(sessionId);
    if (!childIds || childIds.size === 0) return [];
    const out: ClientSessionRecord[] = [];
    for (const cid of childIds) {
      const rec = this.clientSessionById(cid);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** H3 #7 — BFS transitive descendants, parents-before-children
   *  order. Caller reverses the array when leaves-first traversal is
   *  needed (e.g. cascade close). Excludes the starting session. */
  descendantsOf(sessionId: string): ClientSessionRecord[] {
    const out: ClientSessionRecord[] = [];
    const queue: string[] = [sessionId];
    const seen = new Set<string>([sessionId]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const childIds = this.childrenByParent.get(id);
      if (!childIds) continue;
      for (const cid of childIds) {
        if (seen.has(cid)) continue;
        seen.add(cid);
        const rec = this.clientSessionById(cid);
        if (rec) {
          out.push(rec);
          queue.push(cid);
        }
      }
    }
    return out;
  }

  /** Current hop count for a session — exposed for introspection
   *  (tests + termination heuristic). Returns 0 for unknown ids. */
  activeHops(sessionId: string): number {
    return this.get(sessionId)?.activeHops ?? 0;
  }

  /**
   * AXON P6 — Warp-style "child AI profile inheritance". Derives a
   * `ChildProfile` from the parent session record + current env so
   * downstream spawns (e.g. a subagent invoked mid-turn) can inherit
   * the parent's model / permission posture / relevant env without
   * the caller replicating the filtering logic.
   *
   * - `model` / `permissionMode` come from the ClientSessionRecord
   *   when the parent was created with them (via
   *   `clientSessionCreate({ model, permissionMode })`). Server
   *   sessions don't carry these fields yet.
   * - `env` is the parent process env filtered through
   *   `AXON_CHILD_ENV_BLOCKLIST` + `AXON_CHILD_ENV_BLOCK_PREFIXES` —
   *   mirrors `src/acp/client.ts::prepareNestedChildEnv` so children
   *   spawned outside AcpAgent still get the same hygiene.
   * - `lastSeenAt` echoes the parent record's stamp so the child
   *   sidebar row starts with the correct activity timestamp.
   *
   * Unknown parent id ⇒ profile with env filtered from process.env
   * and every other field undefined. Callers should treat the helper
   * as best-effort — a missing parent doesn't error.
   */
  inheritProfile(parentSessionId: string, opts: InheritProfileOpts = {}): ChildProfile {
    const parent = this.get(parentSessionId);
    const rawEnv = opts.parentEnv ?? process.env;
    const blocklist = new Set(opts.envBlocklist ?? AXON_CHILD_ENV_BLOCKLIST);
    const blockPrefixes = opts.envBlockPrefix ?? AXON_CHILD_ENV_BLOCK_PREFIXES;
    const filteredEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (v === undefined) continue;
      if (blocklist.has(k)) continue;
      if (blockPrefixes.some(p => k.startsWith(p))) continue;
      filteredEnv[k] = v;
    }
    const profile: ChildProfile = { env: filteredEnv };
    if (parent) {
      profile.lastSeenAt = parent.lastSeenAt;
      if (parent.kind === 'client') {
        if (parent.model !== undefined) profile.model = parent.model;
        if (parent.permissionMode !== undefined) profile.permissionMode = parent.permissionMode;
      }
    }
    return profile;
  }

  /**
   * AXON P6 — flatten every registered session into `AcpSessionStub`
   * shape for the sessions-sidebar `listAcpSessions` source. Merges
   * client + server records into one list with a human-readable title
   * and a best-effort `agentKind` mapping from `backendId`.
   */
  listAsSidebarStubs(): AcpSessionStub[] {
    return [...this.records.values()].map(sessionRecordToStub);
  }

  /** Test-only — drop every record without touching AcpAgents. */
  __clearForTest(): void {
    this.records.clear();
    this.byBackendId.clear();
    this.childrenByParent.clear();
    this.turnEndListeners.clear();
    this.changeListeners.clear();
  }
}

/** Best-effort text extraction from a SessionUpdate — local copy to
 *  avoid coupling this module to skill-tool-acp-session. Mirrors the
 *  same narrow contract: agent_message_chunk + agent_thought_chunk
 *  with text content; everything else → empty string. */
function extractAgentTextFromUpdate(update: unknown): string {
  if (!update || typeof update !== 'object') return '';
  const u = update as {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
  };
  if (u.sessionUpdate !== 'agent_message_chunk' && u.sessionUpdate !== 'agent_thought_chunk') return '';
  const content = u.content;
  if (!content || content.type !== 'text' || typeof content.text !== 'string') return '';
  return content.text;
}

/** AXON P6 — flatten a SessionRecord to the sidebar's `AcpSessionStub`
 *  shape. Client sessions label with backend + cwd basename; server
 *  sessions label "ACP server · <cwd basename>". AgentKind is mapped
 *  via `backendIdToAgentKind`; server sessions → 'other' (we don't
 *  currently have a dedicated glyph for "external IDE driving us"). */
function sessionRecordToStub(record: SessionRecord): AcpSessionStub {
  const cwdBasename = record.cwd ? basename(record.cwd) : '';
  if (record.kind === 'client') {
    return {
      id: record.id,
      title: cwdBasename
        ? `ACP · ${record.backendId} · ${cwdBasename}`
        : `ACP · ${record.backendId}`,
      agentKind: backendIdToAgentKind(record.backendId),
      isAlive: true,
      createdAt: record.createdAt,
      lastActivityAt: record.lastSeenAt,
      meta: {
        namespace: 'acp-cli',
        backendId: record.backendId,
        backendSessionId: record.backendSessionId,
        activeHops: record.activeHops,
        ...(record.model !== undefined ? { model: record.model } : {}),
        ...(record.permissionMode !== undefined ? { permissionMode: record.permissionMode } : {}),
      },
    };
  }
  // kind === 'server'
  return {
    id: record.id,
    title: cwdBasename ? `ACP server · ${cwdBasename}` : 'ACP server',
    agentKind: 'other',
    isAlive: true,
    createdAt: record.createdAt,
    lastActivityAt: record.lastSeenAt,
    meta: {
      namespace: 'acp-srv',
      backendSessionId: record.backendSessionId,
      activeHops: record.activeHops,
    },
  };
}

let _manager: DualRoleManager | null = null;

export function globalDualRoleManager(): DualRoleManager {
  if (!_manager) _manager = new DualRoleManager();
  return _manager;
}

export function __resetDualRoleManagerForTest(): void {
  _manager = null;
  _hopCapResolver = null;
}

/** Test seam — inject a fake manager (e.g., to bypass real
 *  globalAcpAgentManager spawning during unit tests). Pass null to
 *  restore the lazy singleton path. CV-3 P5.x #1959 origin. */
export function __setDualRoleManagerForTest(
  fake: DualRoleManager | null,
): void {
  _manager = fake;
}
