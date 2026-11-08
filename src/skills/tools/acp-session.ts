import type { LLMToolSpec } from '../../llm/tool-spec.js';
// AXON P1 — ACP Session LLM tools.
//
// Three tools that let the LLM drive a client-side ACP session:
//
//   AcpSessionCreate — spawn / reuse an ACP agent + start a fresh session,
//                      returning the namespaced session id.
//   AcpSessionSend   — send a text prompt, await the turn, return output
//                      plus the agent's stopReason + lastSeenAt stamp.
//   AcpSessionClose  — cancel + drop the session (agent subprocess stays
//                      alive for other sessions of the same backend+cwd).
//
// Server-side sessions are NOT surfaced as LLM tools — those are registered
// by the ACP server module when an external IDE calls newSession(), and
// they're controlled by the peer, not by us.
//
// The runtime wrapper lives in `src/tool-runtime/acp-session-runtime.ts`.


import { listAcpBackends } from '../../acp/backend-registry.js';
import {
  CLIENT_NAMESPACE,
  globalDualRoleManager,
  ReentrancyError,
  UnknownSessionError,
  type ClientSessionRecord,
} from '../../acp/dual-role-manager.js';
import { globalAcpAgentManager } from '../../acp/agent-manager.js';
import {
  globalAcpSessionPersistence,
  type AcpSessionPersistence,
  type PersistedAcpSession,
} from '../../acp/session-persistence.js';
import { AcpLoadSessionUnsupportedError } from '../../acp/capabilities.js';
import {
  globalBackgroundManager,
  type BackgroundManager,
  type BackgroundSessionRecord,
  type BackgroundState,
} from '../../acp/background-manager.js';
// PLAN-tui-redundancy-cleanup T1 (2026-05-16) — vw-join-bridge trim.
// `AcpSessionJoin({promoteToVW:true})` 의 VW promote path 는 사용자
// 미사용 명시 (ACP resident window 안 씀) · noop 으로 변경 ·
// promoted: false 반환.
import { writeSubagentMeta } from '../../acp/subagent-meta.js';
import { unsafeBrandSessionUri } from '../../mss/uri/brand.js';
import {
  writeSessionMode,
  wrapPlanModeMessage,
  type SessionMode,
} from '../../acp/session-mode-meta.js';
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';

export interface AcpSessionCreateArgs {
  brand: string;
  cwd?: string;
  /** H3 #7 — spawn as a subagent linked to this parent session. The
   *  parent session must already be registered (typically via a prior
   *  AcpSessionCreate). Triggers chain-depth HOP_CAP check; throws
   *  ReentrancyError when the resulting depth would reach the cap
   *  (default 3). */
  parentSessionId?: string;
  /** H4 Phase 2 — codex-native only · per-session ThreadOptions
   *  override. Silently ignored for other brands (forward-compat).
   *  These values are persisted to the codex-native thread index so
   *  AcpSessionResume replays with the same config. */
  model?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  networkAccessEnabled?: boolean;
  webSearchMode?: 'disabled' | 'cached' | 'live';
  additionalDirectories?: string[];
  /** Plan/Execute Bridge P1 — when set, applies the mode's intent
   *  defaults before caller overrides. `plan` forces codex-native to
   *  `sandboxMode='read-only'` + `approvalPolicy='never'` so the
   *  external agent stays read-only. Explicit caller values for
   *  sandboxMode / approvalPolicy still win, so passing
   *  `{ sessionMode: 'plan', sandboxMode: 'workspace-write' }`
   *  preserves the explicit override. Other brands round-trip the meta
   *  but no per-brand sandbox enforcement yet (lands in P6). */
  sessionMode?: SessionMode;
}

export interface AcpSessionSpawnSubArgs {
  parentSessionId: string;
  brand: string;
  initialMessage: string;
  /** Optional cap on captured text chunks. Defaults to 32 KB. */
  maxOutputChars?: number;
  /** Optional cwd override. Defaults to the parent's cwd. */
  cwd?: string;
  /** Plan/Execute Bridge P4 — when 'plan', forces the child into
   *  read-only review mode (codex-native: sandboxMode='read-only' +
   *  approvalPolicy='never'). Other brands round-trip the meta key but
   *  no per-brand sandbox enforcement yet. */
  sessionMode?: SessionMode;
}

export interface AcpSessionSendArgs {
  sessionId: string;
  message: string;
  /** Optional cap on captured text chunks. Defaults to 32 KB. */
  maxOutputChars?: number;
}

export interface AcpSessionCloseArgs {
  sessionId: string;
}

export interface AcpSessionListArgs {
  /** Optional filter. When set, only sessions persisted against this
   *  backend id are returned. */
  brand?: string;
}

/** Plan/Execute Bridge P4-B — bundle "plan, get review, then execute"
 *  into one LLM tool call. Internally spawns two subagents (or two
 *  one-shot turns under the same parent), wires the plan output as
 *  context for the execute prompt, and returns both. */
export interface AcpPlanThenExecuteArgs {
  parentSessionId: string;
  brand: string;
  planPrompt: string;
  executePrompt: string;
  /** Optional cap on captured text per phase. Defaults to 32 KB each. */
  maxOutputChars?: number;
  /** Optional cwd override for both phases. Defaults to parent's cwd. */
  cwd?: string;
  /** Optional brand override for the execute phase — enables the
   *  "Codex plans, Claude executes" pattern (시나리오 2 from PLAN). */
  executeBrand?: string;
}

export interface AcpPlanThenExecuteResult {
  /** Plan-phase result. */
  plan: {
    sessionId: string;
    output: string;
    stopReason: string;
    truncated: boolean;
  };
  /** Execute-phase result. */
  execute: {
    sessionId: string;
    output: string;
    stopReason: string;
    truncated: boolean;
  };
  /** Combined chain depth (max of the two phases). */
  chainDepth: number;
}

export interface AcpSessionStartBackgroundArgs {
  brand: string;
  cwd?: string;
  initialMessage: string;
  /** Free-form tag for persistence / sidebar rendering. */
  origin?: string;
  /** Follow-up #5 — start as a subagent linked to this parent session
   *  (like AcpSessionCreate({parentSessionId})). Subjects the BG's
   *  underlying client session to the H3 #7 parent-child graph: HOP_CAP
   *  check at creation (ReentrancyError when depth would reach the cap)
   *  and cascade close (closing the parent terminates the BG). Absent
   *  = BG is a root. */
  parentSessionId?: string;
  /** Plan/Execute Bridge P4 — `plan` makes the BG read-only review-style
   *  (codex-native: sandboxMode='read-only' + approvalPolicy='never').
   *  Pairs naturally with long-running plan-only background tasks
   *  ("30-min architectural review while I work on something else"). */
  sessionMode?: SessionMode;
}

export interface AcpSessionStatusArgs {
  backgroundId: string;
}

export interface AcpSessionCancelArgs {
  backgroundId: string;
}

export interface AcpSessionJoinArgs {
  backgroundId: string;
  /** Follow-up #2 — when true AND the session is still alive, spawn a
   *  Virtual Window pane backed by this background record so the user
   *  can watch the live stream. Ignored (silently) for terminal BG
   *  sessions and when the VW bridge isn't wired. Returns `windowId` /
   *  `paneId` in the result on success. */
  promoteToVW?: boolean;
}

export interface AcpSessionResumeArgs {
  sessionId: string;
}

const DEFAULT_MAX_OUTPUT = 32 * 1024;

function backendEnum(): string[] {
  return listAcpBackends().map(b => b.id);
}

export function buildAcpSessionCreateTool(): LLMToolSpec {
  const brands = backendEnum();
  return {
    name: 'AcpSessionCreate',
    description:
      'Start a new ACP client session against an external coding agent (' +
      brands.join(' / ') + '). Returns a namespaced sessionId (`' +
      CLIENT_NAMESPACE + '<brand>:<id>`) to pass to AcpSessionSend / AcpSessionClose. ' +
      'The underlying subprocess is reused across sessions with the same brand+cwd, ' +
      'so this is cheap to call repeatedly. Pass parentSessionId to spawn a ' +
      'subagent linked to an existing session (chain-depth capped at ' +
      'DEFAULT_HOP_CAP=3; deeper nesting throws ReentrancyError). ' +
      'The `model` / `sandboxMode` / `reasoningEffort` / `approvalPolicy` / ' +
      '`networkAccessEnabled` / `webSearchMode` / `additionalDirectories` ' +
      'fields are accepted for backward compatibility but silently ignored ' +
      'since sprint 5B (2026-04-28) removed the codex-native consumer.',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: brands,
          description: 'ACP backend id. Must exist in the backend registry.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the spawned agent. Defaults to the session working dir.',
        },
        parentSessionId: {
          type: 'string',
          description:
            'Optional — spawn as a subagent linked to this parent session. Must be an ' +
            'existing namespaced session id returned by a prior AcpSessionCreate.',
        },
        model: {
          type: 'string',
          description:
            'Legacy codex-native ThreadOptions field — silently ignored since sprint 5B (2026-04-28).',
        },
        sandboxMode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Legacy codex-native field — silently ignored since sprint 5B (2026-04-28).',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          description: 'Legacy codex-native field — silently ignored since sprint 5B (2026-04-28).',
        },
        approvalPolicy: {
          type: 'string',
          enum: ['never', 'on-request', 'on-failure', 'untrusted'],
          description: 'Legacy codex-native field — silently ignored since sprint 5B (2026-04-28).',
        },
        networkAccessEnabled: {
          type: 'boolean',
          description: 'Legacy codex-native field — silently ignored since sprint 5B (2026-04-28).',
        },
        webSearchMode: {
          type: 'string',
          enum: ['disabled', 'cached', 'live'],
          description: 'Legacy codex-native field — silently ignored since sprint 5B (2026-04-28).',
        },
        additionalDirectories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Legacy codex-native field — silently ignored since sprint 5B (2026-04-28).',
        },
        sessionMode: {
          type: 'string',
          enum: ['plan', 'execute'],
          description:
            'Plan/Execute Bridge — `plan` makes the session read-only review-style by ' +
            'prepending a "[REVIEW MODE — read-only · plan-only]" prefix to the first ' +
            'message and carrying `_meta.session_mode=plan`. `execute` is the default.',
        },
      },
      required: ['brand'],
    },
  };
}

export function buildAcpSessionSpawnSubTool(): LLMToolSpec {
  const brands = backendEnum();
  return {
    name: 'AcpSessionSpawnSub',
    description:
      'One-shot helper: spawn a subagent, send `initialMessage`, wait for the turn ' +
      'to resolve, and tear down the child. Returns the child sessionId plus its ' +
      'text output, stopReason, and chainDepth. Use this for fire-and-forget ' +
      'subtask delegation — for interactive flows, call AcpSessionCreate + Send + ' +
      'Close separately. Throws ReentrancyError when the resulting chain depth would ' +
      'reach DEFAULT_HOP_CAP=3.',
    parameters: {
      type: 'object',
      properties: {
        parentSessionId: {
          type: 'string',
          description: 'Existing namespaced session id to spawn under.',
        },
        brand: {
          type: 'string',
          enum: brands,
          description: 'ACP backend id for the child.',
        },
        initialMessage: {
          type: 'string',
          description: 'Prompt text sent to the child immediately after spawn.',
        },
        maxOutputChars: {
          type: 'integer',
          description:
            'Cap on the concatenated output text returned from this call. Default ' + DEFAULT_MAX_OUTPUT + '.',
        },
        cwd: {
          type: 'string',
          description: 'Optional cwd override. Defaults to the parent session\'s cwd.',
        },
        sessionMode: {
          type: 'string',
          enum: ['plan', 'execute'],
          description:
            'Plan/Execute Bridge — `plan` makes the spawned child read-only ' +
            '(codex-native: forces sandboxMode=read-only + approvalPolicy=never). ' +
            'Use for "spawn a subagent that only reviews / plans, never writes". ' +
            'Defaults to execute (current behavior).',
        },
      },
      required: ['parentSessionId', 'brand', 'initialMessage'],
    },
  };
}

export function buildAcpPlanThenExecuteTool(): LLMToolSpec {
  const brands = backendEnum();
  return {
    name: 'AcpPlanThenExecute',
    description:
      'Plan/Execute Bridge P4-B — bundle a "plan, then execute" workflow into ' +
      'one tool call. Phase 1 spawns a sub-agent in plan mode (sessionMode=plan, ' +
      'codex-native: sandbox=read-only) and sends `planPrompt`; the agent ' +
      'returns a plan WITHOUT modifying anything. Phase 2 spawns another sub-' +
      'agent in execute mode and sends the previous plan + `executePrompt` ' +
      'as combined context. Set `executeBrand` different from `brand` to use ' +
      'one model for planning and another for execution (e.g. Codex plans, ' +
      'Claude executes). Returns both plan and execute outputs.',
    parameters: {
      type: 'object',
      properties: {
        parentSessionId: {
          type: 'string',
          description: 'Existing session id to spawn both phases under.',
        },
        brand: {
          type: 'string',
          enum: brands,
          description: 'ACP backend for the plan phase (default execute phase too).',
        },
        planPrompt: {
          type: 'string',
          description: 'Prompt sent in plan-only phase. Agent returns plan, no writes.',
        },
        executePrompt: {
          type: 'string',
          description:
            'Prompt sent in execute phase, with the plan output prepended as context.',
        },
        maxOutputChars: {
          type: 'integer',
          description:
            'Per-phase cap on captured text. Default ' + DEFAULT_MAX_OUTPUT + ' each.',
        },
        cwd: {
          type: 'string',
          description: 'Optional cwd override for both phases.',
        },
        executeBrand: {
          type: 'string',
          enum: brands,
          description:
            'Optional brand override for execute phase — enables the "Codex plans, ' +
            'Claude executes" pattern. Defaults to `brand`.',
        },
      },
      required: ['parentSessionId', 'brand', 'planPrompt', 'executePrompt'],
    },
  };
}

export function buildAcpSessionSendTool(): LLMToolSpec {
  return {
    name: 'AcpSessionSend',
    description:
      'Send a text prompt to an existing ACP client session and wait for the turn to resolve. ' +
      'Returns the concatenated text chunks the agent streamed plus stopReason and lastSeenAt.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Namespaced session id returned by AcpSessionCreate.',
        },
        message: {
          type: 'string',
          description: 'Prompt text. Content blocks other than text are not yet supported.',
        },
        maxOutputChars: {
          type: 'integer',
          description:
            'Cap on the concatenated output text returned from this call. Default ' + DEFAULT_MAX_OUTPUT + '.',
        },
      },
      required: ['sessionId', 'message'],
    },
  };
}

export function buildAcpSessionListTool(): LLMToolSpec {
  const brands = backendEnum();
  return {
    name: 'AcpSessionList',
    description:
      'List ACP sessions that have been persisted to local storage ' +
      `(${brands.join(' / ')}). Returns a sorted array (most recently active first) ` +
      'with enough metadata to pick one for AcpSessionResume. Does NOT touch the ' +
      'agent subprocess — this is a pure read from disk.',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: brands,
          description:
            'Optional filter. When set, only sessions persisted against this backend id are returned.',
        },
      },
      required: [],
    },
  };
}

export function buildAcpSessionResumeTool(): LLMToolSpec {
  return {
    name: 'AcpSessionResume',
    description:
      'Resume a previously persisted ACP session. Loads the record from disk and ' +
      'calls the ACP `session/load` RPC on the agent subprocess. Only works when ' +
      'the peer advertises `loadSession: true` in its initialize capabilities — ' +
      'otherwise throws AcpLoadSessionUnsupportedError with a clear message. ' +
      'H4 Phase 2 · `codex-native` now advertises loadSession:true and restores ' +
      'real conversation context via `Codex.resumeThread` + disk-backed thread ' +
      'index (elanous synth-id → Codex thread_id, with original ThreadOptions ' +
      'replayed). Pinned ACP-shim backends (claude / codex / gemini) still ' +
      'return false today — their loadSession RPCs are not wired server-side.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description:
            'Namespaced session id returned by AcpSessionCreate (e.g. `acp-cli:claude:abc-123`).',
        },
      },
      required: ['sessionId'],
    },
  };
}

export function buildAcpSessionCloseTool(): LLMToolSpec {
  return {
    name: 'AcpSessionClose',
    description:
      'Cancel the current turn (if any) and drop the session record. ' +
      'The backend subprocess stays alive for other sessions; use acp agent-manager shutdown for full teardown.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Namespaced session id returned by AcpSessionCreate.',
        },
      },
      required: ['sessionId'],
    },
  };
}

export interface AcpSessionCreateResult {
  sessionId: string;
  backendId: string;
  backendSessionId: string;
  createdAt: number;
  /** H3 #7 — chain depth of the created session. Root = 0, subagent of
   *  root = 1, … Echoed so LLM callers can reason about remaining
   *  spawning budget without a separate query. */
  chainDepth: number;
  /** H3 #7 — parent session id for subagents. Absent on roots. */
  parentSessionId?: string;
}

export interface AcpSessionSpawnSubResult {
  sessionId: string;
  backendId: string;
  backendSessionId: string;
  parentSessionId: string;
  chainDepth: number;
  output: string;
  stopReason: string;
  lastSeenAt: number;
  truncated: boolean;
}

export interface AcpSessionSendResult {
  sessionId: string;
  output: string;
  stopReason: string;
  lastSeenAt: number;
  truncated: boolean;
}

export interface AcpSessionCloseResult {
  ok: boolean;
  sessionId: string;
}

export interface AcpSessionListResultItem {
  sessionId: string;
  backendSessionId: string;
  backendId: string;
  cwd: string;
  createdAt: number;
  lastSeenAt: number;
  origin?: string;
}

export interface AcpSessionListResult {
  sessions: AcpSessionListResultItem[];
}

export interface AcpSessionResumeResult {
  sessionId: string;
  backendSessionId: string;
  backendId: string;
  cwd: string;
  protocolVersion: number;
  restoredAt: number;
  history: PersistedAcpSession['history'];
  planSnapshot: PersistedAcpSession['planSnapshot'];
  toolCalls: PersistedAcpSession['toolCalls'];
}

export async function dispatchAcpSessionCreate(
  args: AcpSessionCreateArgs,
): Promise<AcpSessionCreateResult> {
  validateBrand(args.brand);
  const manager = globalDualRoleManager();
  const createOpts: Parameters<typeof manager.clientSessionCreate>[0] = {
    backendId: args.brand,
    cwd: args.cwd,
  };
  if (typeof args.parentSessionId === 'string' && args.parentSessionId.length > 0) {
    createOpts.parentSessionId = args.parentSessionId;
  }
  // Sprint 5B (2026-04-28) — codex-native consumer is gone, so the
  // ThreadOptions override fields are silently ignored. Field still
  // accepted on the input shape for backward LLM tool args.
  const record: ClientSessionRecord = await manager.clientSessionCreate(createOpts);
  const result: AcpSessionCreateResult = {
    sessionId: record.id,
    backendId: record.backendId,
    backendSessionId: record.backendSessionId,
    createdAt: record.createdAt,
    chainDepth: record.chainDepth,
  };
  if (record.parentSessionId !== undefined) result.parentSessionId = record.parentSessionId;
  return result;
}

export async function dispatchAcpSessionSpawnSub(
  args: AcpSessionSpawnSubArgs,
): Promise<AcpSessionSpawnSubResult> {
  if (typeof args.parentSessionId !== 'string' || args.parentSessionId.length === 0) {
    throw new Error('AcpSessionSpawnSub: parentSessionId is required');
  }
  if (typeof args.initialMessage !== 'string' || args.initialMessage.length === 0) {
    throw new Error('AcpSessionSpawnSub: initialMessage is required');
  }
  validateBrand(args.brand);
  const cap = typeof args.maxOutputChars === 'number' && args.maxOutputChars > 0
    ? args.maxOutputChars
    : DEFAULT_MAX_OUTPUT;

  const manager = globalDualRoleManager();
  // Resolve cwd from parent when caller didn't supply one — keeps the
  // subagent's file-tool resolution pinned to the parent's project
  // root unless explicitly retargeted.
  let cwd = args.cwd;
  if (cwd === undefined) {
    const parent = manager.clientSessionById(args.parentSessionId);
    if (parent) cwd = parent.cwd;
  }

  const createOpts: Parameters<typeof manager.clientSessionCreate>[0] = {
    backendId: args.brand,
    parentSessionId: args.parentSessionId,
  };
  if (cwd !== undefined) createOpts.cwd = cwd;

  // Sprint 5B (2026-04-28) — codex-native sandbox/approval propagation
  // dropped along with the consumer. sessionMode meta still flows via
  // `_meta.session_mode` below so peers that recognise the key still
  // get the signal.

  // HOP_CAP / UnknownSessionError surface here — we don't wrap them so
  // the LLM sees the typed error name verbatim.
  const child = await manager.clientSessionCreate(createOpts);

  const chunks: string[] = [];
  let captured = 0;
  let truncated = false;
  const onUpdate = (update: SessionUpdate): void => {
    if (captured >= cap) { truncated = true; return; }
    const text = extractUpdateText(update);
    if (!text) return;
    const room = cap - captured;
    if (text.length <= room) {
      chunks.push(text);
      captured += text.length;
    } else {
      chunks.push(text.slice(0, room));
      captured = cap;
      truncated = true;
    }
  };

  // Follow-up #4 — ride the ACP `_meta` field with the canonical
  // subagent-session-info payload so Zed-family peers auto-recognize
  // the child as a linked sub-thread. Opaque to non-Zed peers (per
  // ACP spec: "Implementations MUST NOT make assumptions about values
  // at these keys"), so it's safe to forward unconditionally.
  // Namespaced ACP ids (`acp-cli:<brand>:<raw>`) are not ElanousUri
  // grammar, so we reapply the SessionUri brand at this boundary the
  // same way DRM does when feeding these ids into SessionUri-typed
  // events (dual-role-manager.ts). `readSubagentMeta` re-brands the
  // wire strings symmetrically on the read path.
  const subagentMeta = writeSubagentMeta({
    parentSessionId: unsafeBrandSessionUri(args.parentSessionId),
    sessionId: unsafeBrandSessionUri(child.id),
  });
  // Plan/Execute Bridge P4 — merge `_meta.session_mode` alongside the
  // subagent linkage when the caller specified a mode.
  const sendMeta = args.sessionMode
    ? { ...subagentMeta, ...writeSessionMode(args.sessionMode) }
    : subagentMeta;
  // Plan/Execute Bridge P6 — every brand gets a prompt-level read-only
  // review prefix when sessionMode='plan'. (Sprint 5B removed the
  // codex-native short-circuit since the SDK sandbox is gone.)
  const sendMessage = wrapPlanModeMessage(args.initialMessage, args.brand, args.sessionMode);

  try {
    const sendResult = await manager.clientSessionSend({
      sessionId: child.id,
      message: sendMessage,
      onUpdate,
      meta: sendMeta,
    });
    return {
      sessionId: child.id,
      backendId: child.backendId,
      backendSessionId: child.backendSessionId,
      parentSessionId: args.parentSessionId,
      chainDepth: child.chainDepth,
      output: chunks.join(''),
      stopReason: String(sendResult.stopReason),
      lastSeenAt: sendResult.lastSeenAt,
      truncated,
    };
  } finally {
    // Always tear the child down — SpawnSub is fire-and-forget. If
    // the caller wants interactive follow-up, they use Create + Send
    // + Close directly.
    try { await manager.clientSessionClose(child.id); }
    catch { /* best-effort */ }
  }
}

/** Plan/Execute Bridge P4-B — composes two SpawnSub calls under the
 *  same parent: phase 1 in plan mode (read-only review), phase 2 in
 *  execute mode with the plan output prepended. Each phase respects
 *  its own brand (default both = `args.brand`; pass `executeBrand` to
 *  cross brands). Errors in phase 1 abort phase 2 (no half-execution). */
export async function dispatchAcpPlanThenExecute(
  args: AcpPlanThenExecuteArgs,
): Promise<AcpPlanThenExecuteResult> {
  if (typeof args.parentSessionId !== 'string' || args.parentSessionId.length === 0) {
    throw new Error('AcpPlanThenExecute: parentSessionId is required');
  }
  if (typeof args.planPrompt !== 'string' || args.planPrompt.length === 0) {
    throw new Error('AcpPlanThenExecute: planPrompt is required');
  }
  if (typeof args.executePrompt !== 'string' || args.executePrompt.length === 0) {
    throw new Error('AcpPlanThenExecute: executePrompt is required');
  }
  validateBrand(args.brand);
  if (args.executeBrand !== undefined) validateBrand(args.executeBrand);

  // Phase 1 — plan-only spawn. SpawnSub teardown happens automatically
  // so we don't need to manage child cleanup here.
  const planSpawnArgs: AcpSessionSpawnSubArgs = {
    parentSessionId: args.parentSessionId,
    brand: args.brand,
    initialMessage: args.planPrompt,
    sessionMode: 'plan',
  };
  if (args.maxOutputChars !== undefined) planSpawnArgs.maxOutputChars = args.maxOutputChars;
  if (args.cwd !== undefined) planSpawnArgs.cwd = args.cwd;
  const planResult = await dispatchAcpSessionSpawnSub(planSpawnArgs);

  // Phase 2 — execute spawn with plan output as context. We prepend
  // the plan as a quoted block so the executing agent sees the
  // structure clearly. brand defaults to args.brand; executeBrand
  // overrides for cross-model patterns.
  const executeMessage =
    `[Plan from previous review]\n${planResult.output}\n\n` +
    `[Now execute the plan above:]\n${args.executePrompt}`;
  const executeBrand = args.executeBrand ?? args.brand;
  const executeSpawnArgs: AcpSessionSpawnSubArgs = {
    parentSessionId: args.parentSessionId,
    brand: executeBrand,
    initialMessage: executeMessage,
    sessionMode: 'execute',
  };
  if (args.maxOutputChars !== undefined) executeSpawnArgs.maxOutputChars = args.maxOutputChars;
  if (args.cwd !== undefined) executeSpawnArgs.cwd = args.cwd;
  const executeResult = await dispatchAcpSessionSpawnSub(executeSpawnArgs);

  return {
    plan: {
      sessionId: planResult.sessionId,
      output: planResult.output,
      stopReason: planResult.stopReason,
      truncated: planResult.truncated,
    },
    execute: {
      sessionId: executeResult.sessionId,
      output: executeResult.output,
      stopReason: executeResult.stopReason,
      truncated: executeResult.truncated,
    },
    chainDepth: Math.max(planResult.chainDepth, executeResult.chainDepth),
  };
}

export async function dispatchAcpSessionSend(
  args: AcpSessionSendArgs,
): Promise<AcpSessionSendResult> {
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('AcpSessionSend: sessionId is required');
  }
  if (typeof args.message !== 'string') {
    throw new Error('AcpSessionSend: message must be a string');
  }
  const cap = typeof args.maxOutputChars === 'number' && args.maxOutputChars > 0
    ? args.maxOutputChars
    : DEFAULT_MAX_OUTPUT;

  const manager = globalDualRoleManager();
  const chunks: string[] = [];
  let captured = 0;
  let truncated = false;
  const onUpdate = (update: SessionUpdate): void => {
    if (captured >= cap) { truncated = true; return; }
    const text = extractUpdateText(update);
    if (!text) return;
    const room = cap - captured;
    if (text.length <= room) {
      chunks.push(text);
      captured += text.length;
    } else {
      chunks.push(text.slice(0, room));
      captured = cap;
      truncated = true;
    }
  };

  try {
    const result = await manager.clientSessionSend({
      sessionId: args.sessionId,
      message: args.message,
      onUpdate,
    });
    return {
      sessionId: result.sessionId,
      output: chunks.join(''),
      stopReason: String(result.stopReason),
      lastSeenAt: result.lastSeenAt,
      truncated,
    };
  } catch (err) {
    if (err instanceof UnknownSessionError || err instanceof ReentrancyError) {
      throw err;
    }
    throw err;
  }
}

/** Test injection — override the default persistence singleton so
 *  dispatchAcpSessionList / Resume don't touch real disk. Production
 *  call sites never set this. */
let _persistenceForTests: AcpSessionPersistence | null = null;
export function _setAcpSessionPersistenceForTests(
  p: AcpSessionPersistence | null,
): void {
  _persistenceForTests = p;
}
function persistenceInstance(): AcpSessionPersistence {
  return _persistenceForTests ?? globalAcpSessionPersistence();
}

/** Test injection — override the agent resolver so Resume doesn't
 *  spawn real subprocesses. Factory receives the backend id + cwd
 *  from the persisted record. */
export type AcpResumeAgentFactory = (opts: {
  backendId: string;
  cwd: string;
}) => Promise<{
  loadSession: (req: { sessionId: string; cwd?: string }) => Promise<unknown>;
}>;
let _resumeAgentFactoryForTests: AcpResumeAgentFactory | null = null;
export function _setAcpResumeAgentFactoryForTests(
  f: AcpResumeAgentFactory | null,
): void {
  _resumeAgentFactoryForTests = f;
}

export async function dispatchAcpSessionList(
  args: AcpSessionListArgs,
): Promise<AcpSessionListResult> {
  const filter: { backendId?: string } = {};
  if (typeof args.brand === 'string' && args.brand.length > 0) {
    validateBrand(args.brand);
    filter.backendId = args.brand;
  }
  const records = persistenceInstance().list(filter);
  return {
    sessions: records.map((r) => {
      const item: AcpSessionListResultItem = {
        sessionId: r.sessionId,
        backendSessionId: r.backendSessionId,
        backendId: r.backendId,
        cwd: r.cwd,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
      };
      if (r.origin !== undefined) item.origin = r.origin;
      return item;
    }),
  };
}

export async function dispatchAcpSessionResume(
  args: AcpSessionResumeArgs,
): Promise<AcpSessionResumeResult> {
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('AcpSessionResume: sessionId is required');
  }
  const record = persistenceInstance().load(args.sessionId);
  if (!record) {
    throw new UnknownSessionError(args.sessionId);
  }
  const factory = _resumeAgentFactoryForTests ?? (async (opts: {
    backendId: string;
    cwd: string;
  }) => {
    const agent = await globalAcpAgentManager().getAgent(opts.backendId, {
      cwd: opts.cwd,
    });
    return agent as unknown as {
      loadSession: (req: { sessionId: string; cwd?: string }) => Promise<unknown>;
    };
  });
  const agent = await factory({ backendId: record.backendId, cwd: record.cwd });
  // Throws AcpLoadSessionUnsupportedError if the peer doesn't advertise
  // loadSession — propagate as-is so the LLM sees a clean typed error.
  await agent.loadSession({
    sessionId: record.backendSessionId,
    cwd: record.cwd,
  });
  return {
    sessionId: record.sessionId,
    backendSessionId: record.backendSessionId,
    backendId: record.backendId,
    cwd: record.cwd,
    protocolVersion: record.protocolVersion,
    restoredAt: Date.now(),
    history: record.history,
    planSnapshot: record.planSnapshot,
    toolCalls: record.toolCalls,
  };
}

// Re-export so callers handling the typed failure can `instanceof`
// without adding a second import.
export { AcpLoadSessionUnsupportedError };

export async function dispatchAcpSessionClose(
  args: AcpSessionCloseArgs,
): Promise<AcpSessionCloseResult> {
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('AcpSessionClose: sessionId is required');
  }
  const manager = globalDualRoleManager();
  const ok = await manager.clientSessionClose(args.sessionId);
  return { ok, sessionId: args.sessionId };
}

function validateBrand(brand: unknown): asserts brand is string {
  if (typeof brand !== 'string' || brand.length === 0) {
    throw new Error('AcpSessionCreate: brand is required');
  }
  const known = backendEnum();
  if (!known.includes(brand)) {
    throw new Error(`AcpSessionCreate: unknown brand '${brand}'. Known: ${known.join(', ')}`);
  }
}

/** Best-effort extraction of text deltas from the ACP SessionUpdate
 *  union. Non-text updates (tool_call, plan update, ...) are ignored
 *  for the captured output — the LLM can still observe them via a
 *  custom onUpdate callback on a non-tool dispatch path, but the
 *  tool's structured result keeps it simple. */
export function extractUpdateText(update: SessionUpdate): string {
  const u = update as unknown as {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
  };
  if (!u || typeof u !== 'object') return '';
  const kind = u.sessionUpdate;
  if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return '';
  const content = u.content;
  if (!content || content.type !== 'text' || typeof content.text !== 'string') return '';
  return content.text;
}

// ─── H3 #6 · Background agent LLM tools ──────────────────────────

export function buildAcpSessionStartBackgroundTool(): LLMToolSpec {
  const brands = backendEnum();
  return {
    name: 'AcpSessionStartBackground',
    description:
      'Spawn an ACP session and kick off `initialMessage` as a background turn. ' +
      'Returns immediately with a `backgroundId` — the turn runs async. Use ' +
      '`AcpSessionStatus` to poll state, `AcpSessionCancel` to abort, and ' +
      '`AcpSessionJoin` to retrieve the final output once state is terminal. ' +
      'Approval-pending / completion transitions fire iPhone push notifications ' +
      '(when Pushcut is configured). Warp Oz cloud-agent parity for long-running ' +
      'subtasks that shouldn\'t block elanous\'s main loop. Pass ' +
      '`parentSessionId` to link the BG under an existing session (HOP_CAP ' +
      'chain-depth check applies; closing the parent cascades the BG cancel).',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: brands,
          description: 'ACP backend id.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the agent. Defaults to the session working dir.',
        },
        initialMessage: {
          type: 'string',
          description: 'Prompt text sent immediately after the session is created.',
        },
        origin: {
          type: 'string',
          description:
            'Optional free-form tag — messenger chat id, dashboard pane id, etc. ' +
            'Useful for sidebar rendering + persistence cross-links.',
        },
        parentSessionId: {
          type: 'string',
          description:
            'Optional — link the background under this parent session. Must be an ' +
            'existing namespaced session id returned by a prior AcpSessionCreate. ' +
            'Triggers chain-depth HOP_CAP check; throws ReentrancyError when the ' +
            'resulting depth would reach the cap.',
        },
        sessionMode: {
          type: 'string',
          enum: ['plan', 'execute'],
          description:
            'Plan/Execute Bridge — `plan` runs the BG turn read-only ' +
            '(codex-native: sandboxMode=read-only + approvalPolicy=never). Pairs ' +
            'naturally with long deep-reasoning plans ("30-min architectural ' +
            'review while I work elsewhere"). Other brands round-trip the meta.',
        },
      },
      required: ['brand', 'initialMessage'],
    },
  };
}

export function buildAcpSessionStatusTool(): LLMToolSpec {
  return {
    name: 'AcpSessionStatus',
    description:
      'Read the current state of a background session. Returns the lifecycle ' +
      'state (running / waiting_for_confirmation / completed / failed / cancelled) ' +
      'plus a capped output preview (~2KB). For the full output, use AcpSessionJoin ' +
      'after the state is terminal.',
    parameters: {
      type: 'object',
      properties: {
        backgroundId: {
          type: 'string',
          description: 'Namespaced id returned by AcpSessionStartBackground.',
        },
      },
      required: ['backgroundId'],
    },
  };
}

export function buildAcpSessionCancelTool(): LLMToolSpec {
  return {
    name: 'AcpSessionCancel',
    description:
      'Cancel an in-flight background turn. Idempotent — returns `cancelled: false` ' +
      'when the session is already terminal. Does NOT delete the record; the ' +
      'cancelled snapshot remains retrievable via AcpSessionStatus / AcpSessionJoin.',
    parameters: {
      type: 'object',
      properties: {
        backgroundId: {
          type: 'string',
          description: 'Namespaced id returned by AcpSessionStartBackground.',
        },
      },
      required: ['backgroundId'],
    },
  };
}

export function buildAcpSessionJoinTool(): LLMToolSpec {
  return {
    name: 'AcpSessionJoin',
    description:
      'Retrieve the full collected output of a background session. When the session ' +
      'is still running, returns the partial output so far. When terminal, returns ' +
      'the complete output + stopReason / error. Intended as the companion to ' +
      'AcpSessionStartBackground — call after Status reports a terminal state. ' +
      'Pass `promoteToVW: true` to additionally spawn a Virtual Window pane backed ' +
      'by this background session (alive sessions only); the pane streams live ' +
      'output until the user closes it.',
    parameters: {
      type: 'object',
      properties: {
        backgroundId: {
          type: 'string',
          description: 'Namespaced id returned by AcpSessionStartBackground.',
        },
        promoteToVW: {
          type: 'boolean',
          description:
            'When true, spawn a Virtual Window pane backed by this background session so ' +
            'the user can watch the live stream. Ignored when the session is terminal ' +
            'or when the VW bridge is not wired. On success, result includes ' +
            'windowId + paneId.',
        },
      },
      required: ['backgroundId'],
    },
  };
}

// ─── Result shapes ────────────────────────────────────────────────

export interface AcpSessionStartBackgroundResult {
  backgroundId: string;
  clientSessionId: string;
  backendSessionId: string;
  backendId: string;
  state: BackgroundState;
  startedAt: number;
  origin?: string;
  /** Follow-up #5 — populated when the BG was spawned with a
   *  `parentSessionId`. Echoes the H3 #7 chain-depth cached on the
   *  underlying client record so callers don't have to re-look up. */
  parentSessionId?: string;
  chainDepth?: number;
}

export interface AcpSessionStatusResult {
  backgroundId: string;
  state: BackgroundState;
  backendId: string;
  cwd: string;
  initialMessage: string;
  startedAt: number;
  lastSeenAt: number;
  endedAt?: number;
  stopReason?: string;
  error?: string;
  outputPreview: string;
  origin?: string;
}

export interface AcpSessionCancelResult {
  backgroundId: string;
  cancelled: boolean;
  previousState: BackgroundState;
}

export interface AcpSessionJoinResult extends AcpSessionStatusResult {
  fullOutput: string;
  /** Follow-up #2 — populated when `promoteToVW: true` succeeded. */
  windowId?: number;
  paneId?: string;
  /** Follow-up #2 — true when a VW pane was spawned. Absent/false
   *  means no promotion (terminal state, bridge not wired, or
   *  promoteToVW was not requested). */
  promoted?: boolean;
}

// ─── Test seams ───────────────────────────────────────────────────

let _backgroundManagerForTests: BackgroundManager | null = null;

/** Test injection — override the global background manager so
 *  dispatch paths don't touch the process singleton. */
export function _setBackgroundManagerForTests(m: BackgroundManager | null): void {
  _backgroundManagerForTests = m;
}

function backgroundManagerInstance(): BackgroundManager {
  return _backgroundManagerForTests ?? globalBackgroundManager();
}

// ─── Dispatchers ──────────────────────────────────────────────────

function recordToStatus(record: BackgroundSessionRecord): AcpSessionStatusResult {
  const out: AcpSessionStatusResult = {
    backgroundId: record.id,
    state: record.state,
    backendId: record.backendId,
    cwd: record.cwd,
    initialMessage: record.initialMessage,
    startedAt: record.startedAt,
    lastSeenAt: record.lastSeenAt,
    outputPreview: record.outputPreview,
  };
  if (record.endedAt !== undefined) out.endedAt = record.endedAt;
  if (record.stopReason !== undefined) out.stopReason = String(record.stopReason);
  if (record.error !== undefined) out.error = record.error;
  if (record.origin !== undefined) out.origin = record.origin;
  return out;
}

export async function dispatchAcpSessionStartBackground(
  args: AcpSessionStartBackgroundArgs,
): Promise<AcpSessionStartBackgroundResult> {
  validateBrand(args.brand);
  if (typeof args.initialMessage !== 'string' || args.initialMessage.length === 0) {
    throw new Error('AcpSessionStartBackground: initialMessage is required');
  }
  const manager = globalDualRoleManager();
  const bg = backgroundManagerInstance();

  // Follow-up #5 — accept an optional parentSessionId so a BG can be
  // linked under an existing session (subjects it to the H3 #7 HOP_CAP
  // check + cascade close via the underlying client session). Absent
  // = BG is a root. The DRM surface throws UnknownSessionError for
  // bogus parent ids and ReentrancyError on HOP_CAP breach; both
  // propagate unwrapped so LLM tool callers see the typed error.
  const createOpts: Parameters<typeof manager.clientSessionCreate>[0] = {
    backendId: args.brand,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
  };
  if (typeof args.parentSessionId === 'string' && args.parentSessionId.length > 0) {
    createOpts.parentSessionId = args.parentSessionId;
  }
  // Sprint 5B (2026-04-28) — codex-native consumer is gone; sessionMode
  // is now carried via `_meta.session_mode` only (the prompt-prefix
  // wrapper applied below enforces the read-only review intent for
  // every brand uniformly).
  const client = await manager.clientSessionCreate(createOpts);

  // Text-chunk sink + approval-signal hook registered via the
  // BackgroundManager's start callbacks.
  let feedChunk: ((text: string) => void) | null = null;
  let signalWaiting: (() => void) | null = null;
  let signalResumed: (() => void) | null = null;

  const onUpdate = (update: SessionUpdate): void => {
    const text = extractUpdateText(update);
    if (text && feedChunk) feedChunk(text);
    // Approval-pending detection: tool_call / tool_call_update with
    // status === 'waiting_for_confirmation' (client-side state layered
    // by H1 #3 · surfaces here via the wire status field when the
    // peer signals it). We also observe HITL requests arriving via
    // the permission approver in AcpAgent; here we do a defensive
    // check on the wire shape so the test seam is straightforward.
    const u = update as unknown as {
      sessionUpdate?: string;
      status?: string;
    };
    if (!u || typeof u !== 'object') return;
    if (u.sessionUpdate === 'tool_call_update') {
      if (u.status === 'waiting_for_confirmation' && signalWaiting) {
        signalWaiting();
      } else if (
        (u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed') &&
        signalResumed
      ) {
        signalResumed();
      }
    }
  };

  // Deferred turn-promise pattern — critical ordering:
  //  1. We create the promise + resolver first.
  //  2. Pass to `bg.start()` so feedChunk / signalWaiting / signalResumed
  //     get wired into local closures BEFORE any onUpdate fires.
  //  3. Then kick off `clientSessionSend`, which may synchronously emit
  //     onUpdate during its inner `await agent.prompt(...)` step.
  // Without this ordering, the first chunks arrive before feedChunk is
  // bound and get silently dropped.
  let resolveTurn!: (r: { stopReason: StopReason }) => void;
  let rejectTurn!: (e: Error) => void;
  const turnPromise = new Promise<{ stopReason: StopReason }>((res, rej) => {
    resolveTurn = res;
    rejectTurn = rej;
  });

  const record = bg.start({
    clientSessionId: client.id,
    backendSessionId: client.backendSessionId,
    backendId: client.backendId,
    cwd: client.cwd,
    initialMessage: args.initialMessage,
    turnPromise,
    registerChunk: (feed) => { feedChunk = feed; },
    registerApprovalSignal: (w, r) => { signalWaiting = w; signalResumed = r; },
    ...(args.origin !== undefined ? { origin: args.origin } : {}),
  });

  // Plan/Execute Bridge P6 — apply read-only prompt prefix for non-codex
  // brands when sessionMode='plan'. Codex-native already enforced via
  // sandboxMode in createOpts above. The BG record stores the raw
  // initialMessage (so persistence reflects the user's intent), but the
  // wire send goes out wrapped.
  const wireMessage = wrapPlanModeMessage(args.initialMessage, args.brand, args.sessionMode);

  // Now kick off the actual turn; onUpdate can safely reach feedChunk.
  manager
    .clientSessionSend({
      sessionId: client.id,
      message: wireMessage,
      onUpdate,
    })
    .then(
      (result) => resolveTurn({ stopReason: result.stopReason }),
      (err: unknown) => rejectTurn(err instanceof Error ? err : new Error(String(err))),
    );

  // Swallow unhandled rejection — BackgroundManager catches via the
  // promise handlers it attached in `start`. Node warns if we don't
  // also attach a no-op catch here because of the fire-and-forget flow.
  turnPromise.catch(() => {});

  const result: AcpSessionStartBackgroundResult = {
    backgroundId: record.id,
    clientSessionId: record.clientSessionId,
    backendSessionId: record.backendSessionId,
    backendId: record.backendId,
    state: record.state,
    startedAt: record.startedAt,
  };
  if (record.origin !== undefined) result.origin = record.origin;
  // Follow-up #5 — surface parent linkage in the result. chainDepth is
  // always populated (roots get 0) so callers can reason about budget
  // without having to look up the underlying ClientSessionRecord.
  result.chainDepth = client.chainDepth;
  if (client.parentSessionId !== undefined) result.parentSessionId = client.parentSessionId;
  return result;
}

export async function dispatchAcpSessionStatus(
  args: AcpSessionStatusArgs,
): Promise<AcpSessionStatusResult> {
  if (typeof args.backgroundId !== 'string' || args.backgroundId.length === 0) {
    throw new Error('AcpSessionStatus: backgroundId is required');
  }
  const bg = backgroundManagerInstance();
  const record = bg.status(args.backgroundId);
  if (!record) throw new UnknownSessionError(args.backgroundId);
  return recordToStatus(record);
}

export async function dispatchAcpSessionCancel(
  args: AcpSessionCancelArgs,
): Promise<AcpSessionCancelResult> {
  if (typeof args.backgroundId !== 'string' || args.backgroundId.length === 0) {
    throw new Error('AcpSessionCancel: backgroundId is required');
  }
  const bg = backgroundManagerInstance();
  const record = bg.status(args.backgroundId);
  if (!record) throw new UnknownSessionError(args.backgroundId);
  const previousState = record.state;
  const manager = globalDualRoleManager();
  const cancelled = await bg.cancel(args.backgroundId, async () => {
    await manager.clientSessionClose(record.clientSessionId);
  });
  return {
    backgroundId: args.backgroundId,
    cancelled,
    previousState,
  };
}

export async function dispatchAcpSessionJoin(
  args: AcpSessionJoinArgs,
): Promise<AcpSessionJoinResult> {
  if (typeof args.backgroundId !== 'string' || args.backgroundId.length === 0) {
    throw new Error('AcpSessionJoin: backgroundId is required');
  }
  const bg = backgroundManagerInstance();
  const record = bg.join(args.backgroundId);
  if (!record) throw new UnknownSessionError(args.backgroundId);
  const base: AcpSessionJoinResult = {
    ...recordToStatus(record),
    fullOutput: record.fullOutput,
  };
  // PLAN-tui-redundancy-cleanup T1 (2026-05-16) — VW pane promotion
  // path deprecated. ACP resident window 자산 자체 미사용 · backend
  // chip 통한 main chat path 가 동일 capability 제공.
  if (args.promoteToVW === true) {
    base.promoted = false;
  }
  return base;
}
