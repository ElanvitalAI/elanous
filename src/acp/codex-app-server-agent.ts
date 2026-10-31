// H4 Phase 3.B.2 · CodexAppServerAgent · duck-typed AcpAgent wrapping
// the stream-agnostic CodexAppServerClient (Phase 3.B.1 foundation).
//
// Scope for 3.B.2a (integration primitives · this arc):
//   - start   → spawn codex app-server · initialize handshake
//   - newSession → thread/start → synth SessionId
//   - prompt  → turn/start · collect server notifications · translate
//               minimal ones (agent/message/delta · turn/completed ·
//               error) into SessionUpdate · return AcpPromptResult
//   - cancel  → turn/interrupt
//   - stop    → client.close + child kill
//   - approval adapter (Phase 3.A) plugged via setServerRequestHandler
//     into the exec/file/permissions approval methods
//
// Intentionally NOT covered in 3.B.2a · deferred to 3.B.2b:
//   - Full SessionUpdate shape · tool_call_progress · plan_update etc.
//   - resume / thread/resume round-trip (SessionId recovery from disk)
//   - image input (UserInput.localImage · SDK Phase 2 feature · variant
//     name = camelCase per v2 app-server wire's `#[serde(rename_all=
//     "camelCase")]`. See `codex-app-server-proto.ts::UserInputItem` for
//     the dual-layer note · v2 wire vs core internal both define a
//     UserInput enum but serialize differently)
//   - MCP tool invocation bridge (mcpServer/tool/call · elicitation)
//   - Per-conversation MCP config (ConfigureMcpForConversation)
//   - Real-binary e2e smoke · dogfood env gate flip
//
// Shape match: duck-typed vs src/acp/client.ts::AcpAgent · callers
// that already accept `AcpAgent` (agent-manager, DRM) cast at the
// factory boundary just like CodexNativeAgent (Phase 1).

import {
  CodexAppServerClient,
  spawnCodexAppServer,
  spawnCodexRemoteTui,
  type SpawnCodexAppServerOpts,
  type SpawnedCodexAppServer,
} from './codex-app-server-client.js';
import type { InitializeResponse } from './codex-app-server-proto.js';
import {
  createCodexApprovalAdapter,
  type CodexApprovalAdapter,
} from './codex-approval-adapter.js';
import type {
  AcpPermissionApprover,
  AcpPromptResult,
  AcpQuestionApprover,
  AcpQuestionRequest,
  AcpQuestionResponse,
  AcpUpdateCallback,
} from './client.js';
import type { ElanousCapabilities } from './capabilities.js';
import { isCodexAuthError, resolvePreferredCodexBinary } from './codex-auth.js';
import { CodexAppServerError } from './codex-app-server-proto.js';
import type {
  ContentBlock,
  SessionId,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import { debug } from '../debug/log.js';
import {
  createEventState,
  translateAgentMessageDelta,
  translateCommandExecutionOutputDelta,
  translateFileChangeOutputDelta,
  translateItemNotification,
  translatePlanDelta,
  translateReasoningDelta,
  translateTurnCompleted as translateTurnCompletedEvent,
  translateTurnPlanUpdated,
  type EventState,
} from './codex-app-server-events.js';
import {
  globalCasThreadIndex,
  type CasThreadIndex,
} from './codex-app-server-thread-index.js';
import { mintSessionUri } from '../mss/uri/session-mint.js';
import {
  parseElanousUiEnvelope,
  ELANOUS_TERM_DISABLED,
  type ElanousUiMethod,
} from './elanous-extensions.js';
import { ELANOUS_ASK_DISABLED } from './ask-extensions.js';
import type {
  CodexCollaborationMode,
  CodexModeKind,
} from './codex-app-server-proto.js';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename as pathBasename,
  dirname as pathDirname,
  isAbsolute as isAbsolutePath,
  join as pathJoin,
  resolve as pathResolve,
} from 'node:path';
import { rotatedCodexChildEnv } from '../oauth/codex-account-store.js';

// ─── Module-scope helpers · 3.B.2c ─────────────────────────────────

function defaultImageTempDir(): string {
  return pathJoin(tmpdir(), `elanous-cas-images-${process.pid}`);
}

/** M6 · resolve the idle hibernate threshold. Opts wins; env fills in
 *  when opts didn't speak. Default 5 minutes. Negative / NaN → disabled. */
function resolveIdleTimeoutMs(optExplicit: number | undefined): number {
  if (typeof optExplicit === 'number' && Number.isFinite(optExplicit)) {
    return Math.max(0, optExplicit);
  }
  const raw = process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 300_000;
}

const defaultMcpToolCallHandler: CodexMcpToolCallHandler = async (params) => {
  return {
    content: [
      {
        type: 'text',
        text: `elanous MCP bridge not wired · tool "${params.tool}" unavailable in this session`,
      },
    ],
    isError: true,
    errorMessage: 'MCP bridge handler not configured',
  };
};

const defaultElicitationHandler: CodexElicitationHandler = async () => {
  return { action: 'decline' };
};

/** elicitation 스키마에서 «필드 이름만» 뽑는다 — 「무엇을 물었나」를 갈라 보려는 것이고,
 *  ⛔ 값·설명·기본값은 «싣지 않는다»(민감정보가 섞일 수 있다). 최대 12개. */
export function elicitationSchemaKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const props = (schema as Record<string, unknown>).properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>).slice(0, 12);
}

/** Per-turn image materialisation. Writes each image ContentBlock to
 *  the agent's scratch dir and returns the resulting `UserInput`
 *  entries. Codex v2 accepts both `{type:'text',text}` and
 *  `{type:'localImage',path}` in the turn/start `input` array.
 *
 *  ## Canonical spec
 *  `~/source/ref/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
 *  (openai/codex 본가의 v2 app-server wire):
 *  `#[serde(tag = "type", rename_all = "camelCase")]` ·
 *  variants `text · image · localImage · skill · mention`.
 *  See `codex-app-server-proto.ts::UserInputItem` for the full dual-layer
 *  evidence note (v2 wire camelCase vs core internal snake_case · easy
 *  to confuse since both layers expose a Rust enum named `UserInput`). */
function collectInputs(
  blocks: readonly ContentBlock[],
  imageDir: string,
  sessionKey: string,
  turnSeq: number,
): ReadonlyArray<
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }
> {
  const out: Array<
    | { type: 'text'; text: string }
    | { type: 'localImage'; path: string }
  > = [];
  let imageSeq = 0;
  let dirEnsured = false;
  for (const b of blocks) {
    const typed = b as { type?: unknown };
    if (typed.type === 'text') {
      const text = (b as { text?: unknown }).text;
      if (typeof text === 'string') out.push({ type: 'text', text });
      continue;
    }
    if (typed.type === 'image') {
      const data = (b as { data?: unknown }).data;
      const mimeType = (b as { mimeType?: unknown }).mimeType;
      if (typeof data !== 'string') continue;
      if (!dirEnsured) {
        try {
          mkdirSync(imageDir, { recursive: true });
        } catch {
          /* swallow · writeFileSync below will surface the real error */
        }
        dirEnsured = true;
      }
      const ext = mimeToExt(typeof mimeType === 'string' ? mimeType : undefined);
      // MSS M1.1 Phase B1 · sessionId is now `session/<ULID>` which
      // embeds a path separator. Sanitize for use as a filename
      // segment so the scratch dir stays flat.
      const safeKey = sessionKey.replace(/\//g, '-');
      const path = pathJoin(
        imageDir,
        `${safeKey}-turn${turnSeq}-${++imageSeq}.${ext}`,
      );
      try {
        writeFileSync(path, Buffer.from(data, 'base64'));
        out.push({ type: 'localImage', path });
      } catch {
        // Silently skip images that can't be written — we don't want a
        // bad image to fail the whole turn. Log path for diagnosis.
        debug.log('acp.cxn.appserver.image', `failed to write image ${path}`);
      }
    }
  }
  return out;
}

function mimeToExt(mime: string | undefined): string {
  if (!mime) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}

// ─── Capability snapshot ──────────────────────────────────────────

/** App-server path capabilities. 3.B.2b flipped loadSession on.
 *  3.B.2c flips `prompt.image: true` because image UserInput is now
 *  translated per-turn (see `collectImageInputs`). MCP bridge +
 *  elicitation are wired via server-request handlers below.
 *
 *  M3 (2026-04-28) flips all four `ui.*` flags on. The agent intercepts
 *  `agent_thought_chunk` updates whose text matches `elanous/ui/*`
 *  envelope shape (see `elanous-extensions.ts`) and forwards them to a
 *  registered host handler instead of letting the envelope text leak
 *  to the client as plain reasoning. */
export const CODEX_APP_SERVER_CAPS: ElanousCapabilities = {
  protocolVersion: 1,
  prompt: {
    text: true,
    resourceLink: true,
    image: true,
    audio: false,
    // E2 / TS2741 (2026-05-17) — ElanousPromptCapabilities added a
    // `video` axis (P-3 §6.9 expansion). codex agent doesn't ship
    // video uploads yet — explicit `false` keeps the capability
    // gate closed instead of relying on TS to infer the missing
    // key as undefined.
    video: false,
    embeddedContext: false,
  },
  loadSession: true,
  session: { fork: false, list: false, resume: false },
  mcp: { http: false, sse: false },
  // M2 (2026-04-28) — file ops flip ON. The agent registers fs/readFile
  // + fs/writeFile server-request handlers in wireClient(); plan mode
  // turns writeFile into a deny gate (M1 interaction).
  fileOps: {
    readTextFile: true,
    writeTextFile: true,
  },
  // M1 (2026-04-28) — plan mode flips ON. See `setSessionMode` +
  // `prompt()` collaborationMode injection below.
  planMode: true,
  ui: { showModal: true, showToast: true, updateStatusPill: true, usage: true },
  // WT-S-1 / ask arc — codex app-server 는 elanous/term·elanous/ask 확장을 미지원.
  // 명시적 DISABLED 로 capability 게이트를 닫는다(ElanousCapabilities 필수 필드).
  term: { ...ELANOUS_TERM_DISABLED },
  ask: { ...ELANOUS_ASK_DISABLED },
};

// ─── Server-request approval routing ──────────────────────────────

/** Codex server-request methods that carry an approval decision.
 *  Method names mirror the v2 protocol surface (generated TS · see
 *  `codex app-server generate-ts`). */
const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
] as const;

// ─── Goal lifecycle types + mapping (follow-up B) ─────────────────

/** codex `ThreadGoalStatus` (camelCase wire · v2/thread.rs). */
export type CodexGoalStatus =
  | 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

/** codex `ThreadGoal` (subset elanous consumes). */
export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

/** elanous mission statuses a goal status maps onto (mission-registry). */
export type MissionStatusFromGoal = 'running' | 'done' | 'failed' | 'disarmed';

export interface CodexGoalUpdate {
  sessionId: SessionId;
  /** Mapped elanous mission status. */
  missionStatus: MissionStatusFromGoal;
  /** Raw goal (null on `thread/goal/cleared`). */
  goal: CodexThreadGoal | null;
}

export type CodexGoalUpdateListener = (update: CodexGoalUpdate) => void;

/** Map a codex goal status to the elanous mission-registry status. Pure +
 *  exported so a mission layer + tests share one mapping. `active`/`paused`
 *  ⇒ running (still working); `complete` ⇒ done; `blocked`/`usageLimited`/
 *  `budgetLimited` ⇒ failed (needs attention — codex stopped making
 *  progress toward the goal). */
export function mapCodexGoalStatusToMissionStatus(status: CodexGoalStatus): MissionStatusFromGoal {
  switch (status) {
    case 'active':
    case 'paused':
      return 'running';
    case 'complete':
      return 'done';
    case 'blocked':
    case 'usageLimited':
    case 'budgetLimited':
      return 'failed';
    default:
      return 'running';
  }
}

/** codex v2 native structured-question server-request (experimental).
 *  `ToolRequestUserInputParams` → `ToolRequestUserInputResponse`
 *  (app-server-protocol v2/item.rs). Gated on the `experimentalApi`
 *  capability we now declare in the initialize handshake. */
const USER_INPUT_METHOD = 'item/tool/requestUserInput';

/** codex `ToolRequestUserInputQuestion` shape (params.questions[]). */
interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

/** Map a codex `item/tool/requestUserInput` params to elanous's generic
 *  `AcpQuestionRequest` so it flows through the same questionApprover the
 *  surface HITL QuestionChannel backs. Pure + exported for testing. */
export function mapUserInputToQuestionRequest(
  params: unknown,
  sessionId: string,
): AcpQuestionRequest {
  const p = (params ?? {}) as { questions?: unknown };
  const questions = Array.isArray(p.questions) ? (p.questions as CodexUserInputQuestion[]) : [];
  return {
    backendId: 'codex-app-server',
    sessionId,
    questions: questions.map((q) => ({
      id: q.id,
      header: (q.header ?? '').slice(0, 12),
      question: q.question ?? '',
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        description: o.description ?? '',
      })),
      multiSelect: false,
      // codex `isOther` ⇒ allow a free-form "Other" answer.
      includeOther: q.isOther === true,
    })),
  };
}

/** Map elanous's `AcpQuestionResponse` back to codex's
 *  `ToolRequestUserInputResponse` (`{answers: {[id]: {answers: []}}}`).
 *  "Other" selections are substituted with the free-form `otherText`.
 *  Pure + exported for testing. */
export function mapQuestionResponseToUserInput(
  params: unknown,
  resp: AcpQuestionResponse,
): { answers: Record<string, { answers: string[] }> } {
  const p = (params ?? {}) as { questions?: unknown };
  const questions = Array.isArray(p.questions) ? (p.questions as CodexUserInputQuestion[]) : [];
  const out: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const a = resp.answers?.[q.id];
    let list = a === undefined ? [] : Array.isArray(a) ? [...a] : [a];
    const other = resp.otherText?.[q.id];
    if (other !== undefined) list = list.map((x) => (x === 'Other' ? other : x));
    out[q.id] = { answers: list };
  }
  return { answers: out };
}

/** Map an approval outcome to the EXACT codex wire response for a given
 *  server-request method. Kept pure + exported so a unit test can pin the
 *  values against the codex protocol without standing up the full agent.
 *
 *  Sync anchor — codex app-server-protocol (checkout 2026-07-08):
 *   - v2 `item/commandExecution/requestApproval` → `CommandExecutionApprovalDecision`
 *     and `item/fileChange/requestApproval` → `FileChangeApprovalDecision`
 *     (v2/item.rs): camelCase `accept | acceptForSession | decline | cancel`.
 *   - v2 `item/permissions/requestApproval` → `PermissionsRequestApprovalResponse`
 *     (v2/permissions.rs): `{ permissions: GrantedPermissionProfile, scope? }`
 *     — NOT a decision. `{network?, fileSystem?}`; empty ⇒ nothing granted
 *     (effective deny). `scope` omitted → server default `Turn`.
 *   - legacy `execCommandApproval` / `applyPatchApproval` → core `ReviewDecision`
 *     (`approved | denied`).
 *
 *  elanous historically returned `{decision:'approve'|'deny'}`, valid in NONE of
 *  these — codex ≥0.125 rejected it on deserialize, silently breaking every
 *  Codex-backend approval. This helper is the fix. */
/** The decision string values `buildCodexApprovalResponse` can emit per
 *  approval method, tagged with the codex generated-TS enum type they must
 *  be a member of. This is the contract the proto-sync lint checks against
 *  codex's `generate-ts` output (`scripts/check-codex-proto-sync.ts`) so a
 *  future codex enum rename (the exact drift that broke approvals — the old
 *  `approve/deny`) fails CI instead of silently breaking at runtime. Keep
 *  in lock-step with `buildCodexApprovalResponse`; a unit test enforces it.
 *  `item/permissions/requestApproval` is intentionally absent — its response
 *  is a granted-profile object, not a decision enum. */
export const CODEX_APPROVAL_DECISION_CONTRACT: ReadonlyArray<{
  readonly method: string;
  readonly enumType: string;
  readonly emits: readonly string[];
}> = [
  { method: 'item/commandExecution/requestApproval', enumType: 'CommandExecutionApprovalDecision', emits: ['accept', 'acceptForSession', 'decline'] },
  { method: 'item/fileChange/requestApproval', enumType: 'FileChangeApprovalDecision', emits: ['accept', 'acceptForSession', 'decline'] },
  { method: 'execCommandApproval', enumType: 'ReviewDecision', emits: ['approved', 'denied'] },
  { method: 'applyPatchApproval', enumType: 'ReviewDecision', emits: ['approved', 'denied'] },
];

export function buildCodexApprovalResponse(
  method: string,
  approved: boolean,
  opts?: { requestedPermissions?: Record<string, unknown>; scope?: 'once' | 'session' },
): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      // `scope: 'session'` → codex `acceptForSession` so the user's "allow
      // for this session" choice suppresses re-prompts server-side.
      if (!approved) return { decision: 'decline' };
      return { decision: opts?.scope === 'session' ? 'acceptForSession' : 'accept' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      // Legacy ReviewDecision path (deprecated) — no session scope honored.
      return { decision: approved ? 'approved' : 'denied' };
    case 'item/permissions/requestApproval': {
      if (!approved) return { permissions: {} };
      const req = opts?.requestedPermissions ?? {};
      const granted: Record<string, unknown> = {};
      if (req.network !== undefined) granted.network = req.network;
      if (req.fileSystem !== undefined) granted.fileSystem = req.fileSystem;
      return { permissions: granted };
    }
    default:
      // Unknown approval-shaped method — decline via the common decision
      // shape (defensive; all wired APPROVAL_METHODS are handled above).
      return { decision: 'decline' };
  }
}

// ─── MCP bridge + elicitation · 3.B.2c ────────────────────────────

/** Result shape returned to Codex when it invokes a elanous-hosted MCP
 *  tool via server-request. Mirrors MCP `CallToolResult` but kept
 *  loose so we can evolve without a type churn cascade. */
export interface CodexMcpToolCallResult {
  readonly content: ReadonlyArray<
    | { type: 'text'; text: string }
    | { type: 'json'; json: unknown }
  >;
  readonly isError?: boolean;
  readonly errorMessage?: string;
}

/** Callback Codex invokes when it wants a elanous-side MCP tool run
 *  during a turn. Params shape mirrors v2 `McpServerToolCallParams` —
 *  we surface it loosely typed so the handler can cast as needed
 *  without this file owning the full type churn.
 *
 *  Handler contract:
 *  - return the tool result (text/json content) on success
 *  - return `{isError: true, errorMessage}` on handled failure
 *  - throw → translated into a server-side JSON-RPC error (the
 *    request promise on Codex side rejects) */
export type CodexMcpToolCallHandler = (
  params: {
    readonly threadId?: string;
    readonly server?: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  },
) => Promise<CodexMcpToolCallResult>;

/** Result returned from an elicitation prompt. ACP's permission
 *  outcomes rendered for the MCP elicitation envelope. */
export interface CodexElicitationResult {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Readonly<Record<string, unknown>>;
}

/** Callback Codex invokes when it wants to ask the user a question
 *  via `mcpServer/elicitation/request`. The default handler declines
 *  — wire a real UI prompt via `opts.elicitationHandler` to opt in. */
export type CodexElicitationHandler = (
  params: {
    readonly threadId?: string;
    readonly server?: string;
    readonly message?: string;
    readonly schema?: unknown;
  },
) => Promise<CodexElicitationResult>;

/** M3 (2026-04-28) — host handler for `elanous/ui/*` envelopes intercepted
 *  from `agent_thought_chunk` text. Mirrors the codex-native path's
 *  `pushModal` / `pushToast` / `updateStatusPill` / `recordUsage` shape
 *  the dashboard already wires for native — both transports converge on
 *  the same UI extension surface.
 *
 *  When set, every `agent_thought_chunk` whose text parses as a valid
 *  elanous/ui envelope is forwarded here AND the original update is
 *  suppressed (envelope text doesn't leak to the client as plain
 *  reasoning). When unset, envelope-shaped text passes through verbatim
 *  — extension-unaware peers still see it as text. */
export type CodexElanousUiHandler = (params: {
  readonly sessionId: string;
  readonly method: ElanousUiMethod;
  readonly payload: Record<string, unknown>;
}) => void;

/** MCP bridge methods · kept as a list so tests can assert coverage
 *  matches what v2 exposes. */
const MCP_BRIDGE_METHODS = {
  toolCall: 'mcpServer/tool/call',
  elicitation: 'mcpServer/elicitation/request',
} as const;

// ─── M2 (2026-04-28) · file ops ──────────────────────────────────────

/** Codex v2 fs server-request method names (camelCase rename_all). */
const FS_METHODS = {
  readFile: 'fs/readFile',
  writeFile: 'fs/writeFile',
} as const;

/** Default size cap for `fs/readFile` results — 10 MB raw bytes. base64
 *  inflates to ~14 MB string memory. Override via env. */
const DEFAULT_FS_MAX_BYTES = 10 * 1024 * 1024;

function resolveFsMaxBytes(opt: number | undefined): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return opt;
  const raw = process.env.ELANOUS_CODEX_FS_MAX_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_FS_MAX_BYTES;
}

/** Resolve a turn-watchdog timeout (ms). `0` disables that guard.
 *  hermes parity: quiet-timeout aborts a turn that goes silent (hung
 *  tool / stalled model); hard-deadline is the wall-clock backstop. */
function resolveTurnTimeoutMs(opt: number | undefined, envKey: string, def: number): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt >= 0) return opt;
  const raw = process.env[envKey];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return def;
}

/** Validate that `path` is inside `workspaceRoot` (after symlink
 *  resolution) and absolute. Returns null on success or a diagnostic
 *  string on rejection. Pure helper so tests can drive every branch
 *  without spawning a daemon. */
export function validateFsPath(
  path: string,
  workspaceRoot: string,
): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return 'fs path must be a non-empty string';
  }
  if (!isAbsolutePath(path)) {
    return `fs path must be absolute (got "${path}")`;
  }
  // Realpath the workspace root so symlink workspace dirs are normalised
  // once. If realpath itself fails (root missing), fall back to the raw
  // string — the prefix check below still rejects mismatches.
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
  } catch {
    canonicalRoot = pathResolve(workspaceRoot);
  }
  // Resolve the input path AS-IF the file may not yet exist (write
  // path). For symlink files we then realpath, but realpath throws on
  // missing files. Fall back to realpath(parent) + basename so platform
  // symlinks like macOS /var → /private/var still normalise even when
  // the target file hasn't been written yet.
  const resolved = pathResolve(path);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(resolved);
  } catch {
    try {
      canonicalPath = pathJoin(realpathSync(pathDirname(resolved)), pathBasename(resolved));
    } catch {
      canonicalPath = resolved;
    }
  }
  // Use a trailing separator on the root so "/work" doesn't accidentally
  // permit "/workspace" sibling paths.
  const rootWithSep = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(rootWithSep)) {
    return `fs path "${path}" outside workspace root "${workspaceRoot}"`;
  }
  return null;
}

// ─── M4' (2026-04-28) · per-session MCP policy ───────────────────────

/** M4' · host-side MCP policy mode. codex v2 protocol has no
 *  per-conversation MCP override RPC (verified against
 *  `codex-rs/app-server-protocol/src/protocol/v2.rs:3343` —
 *  `ThreadStartParams` carries no mcp fields). Plan B drops the RPC
 *  approach and lets the host decide which tools a session may invoke.
 *
 *  - `allow-all` (default · no policy registered) — every tool passes
 *  - `allow-list` — only tools matching `tools[]` are allowed
 *  - `block-list` — tools matching `tools[]` are blocked, rest allowed
 *
 *  Tool names use the `server/tool` shape that codex emits in the
 *  `mcpServer/tool/call` server-request. `server/*` matches every tool
 *  on a server. Comparison is case-sensitive (matches MCP convention). */
export type CodexMcpPolicyMode = 'allow-all' | 'allow-list' | 'block-list';

export interface CodexMcpSessionPolicy {
  readonly mode: CodexMcpPolicyMode;
  /** Patterns to match against the `server/tool` joined string. Empty
   *  on 'allow-all'. For 'allow-list': anything not matching is blocked.
   *  For 'block-list': anything matching is blocked. Patterns ending in
   *  `/*` match any tool on that server. */
  readonly tools?: readonly string[];
}

/** Match a `server/tool` invocation against a policy pattern. Pattern
 *  shapes:
 *   - `"github/create_issue"` — exact match
 *   - `"github/*"` — server-wide wildcard
 *   - `"*"` — global wildcard (rare — equivalent to allow-all/block-all)
 *
 *  Returns true when the pattern matches the candidate. Pure helper · no
 *  agent state. */
export function matchesMcpPattern(candidate: string, pattern: string): boolean {
  if (pattern === '*' || pattern === candidate) return true;
  if (pattern.endsWith('/*')) {
    const serverPrefix = pattern.slice(0, -1); // keep trailing '/'
    return candidate.startsWith(serverPrefix);
  }
  return false;
}

/** Apply a session policy to a tool name. Returns `null` when allowed,
 *  or a non-empty diagnostic string when blocked. Pure helper. */
export function evaluateMcpPolicy(
  policy: CodexMcpSessionPolicy | undefined,
  serverAndTool: string,
): string | null {
  if (!policy || policy.mode === 'allow-all') return null;
  const patterns = policy.tools ?? [];
  const anyMatch = patterns.some((p) => matchesMcpPattern(serverAndTool, p));
  if (policy.mode === 'allow-list') {
    return anyMatch ? null : `tool "${serverAndTool}" not in this session's allow-list`;
  }
  // block-list
  return anyMatch ? `tool "${serverAndTool}" is blocked for this session` : null;
}

/** Structured-only prompt failure metadata. Never records a remote error message. */
function codexPromptFailureMetadata(error: unknown): {
  errorKind: string;
  jsonRpcCode?: number;
  remoteMessageLength: number;
} {
  if (error instanceof CodexAppServerError) {
    return {
      errorKind: 'json-rpc',
      jsonRpcCode: error.code,
      remoteMessageLength: error.message.length,
    };
  }
  return {
    errorKind: 'unknown',
    remoteMessageLength: error instanceof Error ? error.message.length : String(error).length,
  };
}

// ─── Agent class ──────────────────────────────────────────────────

export interface CodexAppServerAgentOpts {
  readonly backendId: string;
  readonly cwd?: string;
  /** Optional executable forwarded to the actual app-server spawn. */
  readonly codexBinary?: string;
  /** Session-scoped argv forwarded to `spawnCodexAppServer`. */
  readonly codexArgs?: readonly string[];
  /** Explicit opt-in Codex remote side-tab Unix socket path. */
  readonly remoteSocketPath?: string;
  readonly env?: Record<string, string>;
  readonly log?: (msg: string) => void;
  /** Called after a successful initialize with this backend's advertised capabilities.
   *  Observers must not affect app-server operation. */
  readonly onCapabilities?: (capabilities: ElanousCapabilities) => void;
  readonly permissionApprover?: AcpPermissionApprover;
  readonly questionApprover?: AcpQuestionApprover;
  /** 3.B.2c · MCP bridge · route `mcpServer/tool/call` server-requests
   *  to elanous's MCP registry. When omitted, the default handler returns
   *  `{isError: true}` with an "MCP bridge not wired" message so Codex
   *  can degrade gracefully instead of hanging. */
  readonly mcpToolCallHandler?: CodexMcpToolCallHandler;
  /** 3.B.2c · Elicitation · route `mcpServer/elicitation/request` to a
   *  user-facing prompt (dashboard modal, Slack message, etc.). Default
   *  returns `{action:'decline'}` so Codex proceeds without blocking
   *  when no UI is wired. */
  readonly elicitationHandler?: CodexElicitationHandler;
  /** M3 (2026-04-28) · `elanous/ui/*` extension parity with codex-native.
   *  When set, agent_thought_chunk updates whose text matches the
   *  `elanous/ui/*` envelope are forwarded here + suppressed. When omitted,
   *  envelope-shaped text passes through verbatim. */
  readonly elanousUiHandler?: CodexElanousUiHandler;
  /** 3.B.2c · Per-turn temp dir for image inputs · defaults to
   *  `os.tmpdir()/elanous-cas-images-<pid>`. Tests can override to a
   *  scratch dir that gets cleaned up after the run. */
  readonly imageTempDir?: string;
  /** M6 (2026-04-28) · idle hibernate threshold in ms. After this many
   *  ms with no inbound or outbound traffic the agent SIGTERMs the
   *  daemon and nulls its client; the next `prompt()` / `loadSession()`
   *  triggers a lazy respawn + per-session `thread/resume`.
   *
   *  Default: env `ELANOUS_CODEX_APP_SERVER_IDLE_MS` if set + parses,
   *  otherwise 300_000 (5 min). Pass 0 (or a negative) to disable
   *  hibernation entirely. */
  readonly idleTimeoutMs?: number;
  /** M6 · poll interval for the idle check (ms). Default 30_000. Tests
   *  shrink this to drive the timer fast. */
  readonly idleCheckMs?: number;
  /** hermes-parity turn watchdog. Quiet-timeout aborts a turn that goes
   *  silent for this many ms (hung tool / stalled model); resets on every
   *  event. Default env `ELANOUS_CODEX_TURN_QUIET_MS` or 90_000. 0 disables. */
  readonly turnQuietMs?: number;
  /** hermes-parity hard wall-clock deadline per turn (ms). Default env
   *  `ELANOUS_CODEX_TURN_MAX_MS` or 600_000. 0 disables. */
  readonly turnHardMs?: number;
  /** M2 · maximum bytes returned by `fs/readFile`. Default = env
   *  `ELANOUS_CODEX_FS_MAX_BYTES` or 10 MB. Files exceeding this surface
   *  an `{isError: true, errorMessage}` payload to the daemon. */
  readonly fileOpsMaxBytes?: number;
  /** Test seam · inject a preconstructed client instead of spawning. */
  readonly _clientForTesting?: CodexAppServerClient;
  /** Test seam · inject an in-memory thread index to avoid disk I/O. */
  readonly _threadIndexForTesting?: CasThreadIndex;
  /** Factory override · lets tests supply a different spawn strategy. */
  readonly _spawnFactory?: (
    opts: SpawnCodexAppServerOpts,
  ) => SpawnedCodexAppServer;
  readonly _remoteTuiSpawnForTesting?: typeof spawnCodexRemoteTui;
}

export class CodexAppServerAgent {
  private readonly backendId: string;
  private readonly cwd?: string;
  private readonly codexBinary?: string;
  private readonly codexArgs?: readonly string[];
  private readonly remoteSocketPath?: string;
  private readonly env?: Record<string, string>;
  private readonly log: (msg: string) => void;
  private readonly onCapabilities: ((capabilities: ElanousCapabilities) => void) | undefined;

  private client: CodexAppServerClient | null;
  private child: SpawnedCodexAppServer['child'] | null = null;
  private remoteTuiChild: ReturnType<typeof spawnCodexRemoteTui> | null = null;
  private initialized = false;

  private readonly approvalAdapter: CodexApprovalAdapter;
  private permissionApprover: AcpPermissionApprover | null;
  private questionApprover: AcpQuestionApprover | null;

  /** sessionId (elanous-side synth) → Codex threadId. */
  private readonly sessionToThread = new Map<SessionId, string>();
  /** Reverse lookup for routing server notifications. */
  private readonly threadToSession = new Map<string, SessionId>();
  /** sessionId → the CURRENT in-flight turnId (captured from the
   *  `turn/start` response, cleared when the turn settles). Enables
   *  `steer()` to target the live turn with an `expectedTurnId`
   *  precondition. Absent ⇒ no turn is in flight to steer. */
  private readonly sessionToCurrentTurn = new Map<SessionId, string>();
  /** M1 · per-session collaboration mode (plan vs default). Sessions
   *  default to 'default' (omit collaborationMode on turn/start). */
  private readonly sessionModes = new Map<SessionId, CodexModeKind>();
  /** M1 · per-session model captured from `thread/start` /
   *  `thread/resume` responses. Required by codex's CollaborationMode
   *  Settings; if a session never reported a model we omit
   *  collaborationMode entirely (server-side default fallback). */
  private readonly sessionModels = new Map<SessionId, string>();
  /** M4' · host-side MCP policies keyed by sessionId. Default = absence
   *  = allow-all. Cleared on stop(); v0 is in-memory only (persistence
   *  is a follow-up — JSON shape on `CasThreadIndexEntry` is backward-
   *  compat additive). */
  private readonly sessionMcpPolicies = new Map<SessionId, CodexMcpSessionPolicy>();

  private readonly pendingTurns = new Map<
    SessionId,
    {
      onUpdate: AcpUpdateCallback;
      resolve: (result: AcpPromptResult) => void;
      reject: (err: Error) => void;
    }
  >();

  /** 3.B.2b · per-session event translator state (pending item map +
   *  output buffer caps). Keyed by sessionId because multiple sessions
   *  can run concurrently on the same agent (one per cwd bucket). */
  private readonly eventStates = new Map<SessionId, EventState>();

  private readonly threadIndex: CasThreadIndex;

  // ── M6 · daemon idle hibernate ───────────────────────────────────
  /** Resolved hibernate threshold (ms). 0 = disabled. */
  private readonly idleTimeoutMs: number;
  /** Resolved idle-check tick interval (ms). */
  private readonly idleCheckMs: number;
  /** Active poll handle. Null until start() registers it; cleared by
   *  hibernate / stop / close. */
  private idleTimerHandle: ReturnType<typeof setInterval> | null = null;
  /** M2 · file ops byte cap. Resolved from opts/env at construction. */
  private readonly fileOpsMaxBytes: number;
  /** hermes-parity turn watchdog thresholds (ms; 0 = disabled). */
  private readonly turnQuietMs: number;
  private readonly turnHardMs: number;
  /** Set when a turn failed with an auth error; the next `ensureRunning`
   *  tears the daemon down for a clean respawn so a stale/expired token
   *  session doesn't keep failing. */
  private needsRespawn = false;
  /** Sessions that have been seen by the CURRENT daemon (since the
   *  most recent start). Cleared on hibernate so the next prompt for
   *  any pre-existing session triggers a `thread/resume` against the
   *  fresh daemon before `turn/start`. */
  private readonly currentDaemonSessions = new Set<SessionId>();
  /** Promise of an in-flight `start()` call. When concurrent callers
   *  race a lazy restart, every caller awaits the same start promise
   *  rather than each spawning a competing daemon. */
  private startInFlight: Promise<void> | null = null;

  /** 3.B.2c · injected bridges · overridden by opts. */
  private mcpToolCallHandler: CodexMcpToolCallHandler;
  private elicitationHandler: CodexElicitationHandler;
  /** M3 · elanous/ui envelope handler · overridden by opts or
   *  setElanousUiHandler(). Null = pass-through (envelope text not
   *  intercepted). */
  private elanousUiHandler: CodexElanousUiHandler | null;
  /** 3.B.2c · per-session attached transports (advisory metadata
   *  surfaced for observers like HUD / debug overlays). Keyed by
   *  sessionId; entries are pushed via `attachTransport()` and
   *  cleared on `stop()`. */
  private readonly attachedTransports = new Map<
    SessionId,
    Array<{ kind: string; id: string; label?: string }>
  >();
  /** 3.B.2c · image scratch dir for per-turn localImage writes. */
  private readonly imageTempDir: string;

  private readonly _clientForTesting: CodexAppServerClient | undefined;
  private readonly _spawnFactory:
    | ((opts: SpawnCodexAppServerOpts) => SpawnedCodexAppServer)
    | undefined;
  private readonly _remoteTuiSpawnForTesting: typeof spawnCodexRemoteTui | undefined;

  constructor(opts: CodexAppServerAgentOpts) {
    this.backendId = opts.backendId;
    this.cwd = opts.cwd;
    this.codexBinary = opts.codexBinary;
    this.codexArgs = opts.codexArgs ? [...opts.codexArgs] : undefined;
    this.remoteSocketPath = opts.remoteSocketPath;
    this.env = opts.env;
    this.log = opts.log ?? ((msg) => debug.log('acp.cxn.appserver.agent', msg));
    this.onCapabilities = opts.onCapabilities;
    this.permissionApprover = opts.permissionApprover ?? null;
    this.questionApprover = opts.questionApprover ?? null;
    this.mcpToolCallHandler = opts.mcpToolCallHandler ?? defaultMcpToolCallHandler;
    this.elicitationHandler = opts.elicitationHandler ?? defaultElicitationHandler;
    this.elanousUiHandler = opts.elanousUiHandler ?? null;
    this.imageTempDir = opts.imageTempDir ?? defaultImageTempDir();
    this._clientForTesting = opts._clientForTesting;
    this._spawnFactory = opts._spawnFactory;
    this._remoteTuiSpawnForTesting = opts._remoteTuiSpawnForTesting;
    this.threadIndex = opts._threadIndexForTesting ?? globalCasThreadIndex();
    // M6 · idle hibernate config. Env override only applies when opts
    // didn't set it explicitly so tests can pin a value regardless of
    // the developer's environment.
    this.idleTimeoutMs = resolveIdleTimeoutMs(opts.idleTimeoutMs);
    this.idleCheckMs = opts.idleCheckMs ?? 30_000;
    // M2 · file op size cap (env override path).
    this.fileOpsMaxBytes = resolveFsMaxBytes(opts.fileOpsMaxBytes);
    this.turnQuietMs = resolveTurnTimeoutMs(opts.turnQuietMs, 'ELANOUS_CODEX_TURN_QUIET_MS', 90_000);
    this.turnHardMs = resolveTurnTimeoutMs(opts.turnHardMs, 'ELANOUS_CODEX_TURN_MAX_MS', 600_000);

    this.approvalAdapter = createCodexApprovalAdapter({
      permissionApprover: this.permissionApprover ?? undefined,
      questionApprover: this.questionApprover ?? undefined,
      // 3.B.2a — flip logOnly OFF so the adapter's wired approvers
      // actually produce approve/deny decisions. The client's
      // setServerRequestHandler below returns those decisions to
      // the server.
      logOnly: false,
    });

    // Eagerly register the client if supplied · avoid lazy spawn in tests.
    this.client = this._clientForTesting ?? null;
    if (this.client) {
      this.wireClient(this.client);
    }
  }

  getApprovalAdapter(): CodexApprovalAdapter {
    return this.approvalAdapter;
  }

  setPermissionApprover(approver?: AcpPermissionApprover): void {
    this.permissionApprover = approver ?? null;
    this.approvalAdapter.setPermissionApprover(this.permissionApprover);
  }

  setQuestionApprover(approver?: AcpQuestionApprover): void {
    this.questionApprover = approver ?? null;
    this.approvalAdapter.setQuestionApprover(this.questionApprover);
  }

  getCapabilities(): ElanousCapabilities | null {
    return this.initialized ? CODEX_APP_SERVER_CAPS : null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.initialized) return;
    // M6 · race-safe lazy restart — concurrent callers (e.g. two prompts
    // arriving within the same tick after hibernate) all await the same
    // in-flight start() instead of each spawning a competing daemon.
    if (this.startInFlight) {
      return this.startInFlight;
    }
    this.startInFlight = this.doStart();
    try {
      await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
  }

  private async doStart(): Promise<void> {
    if (!this.client) {
      // Production path · spawn `codex app-server`. M6 — also entered
      // after a hibernate that nulled `this.client`; the spawn factory
      // produces a fresh child + client every call.
      const spawnFn = this._spawnFactory ?? spawnCodexAppServer;
      // ⛔⭐⭐⭐ 회전한 계정을 이 자식에게 «따라가게» 한다 — codex 바이너리는 elanous 정본 토큰을
      //   안 보고 `$CODEX_HOME/auth.json` 을 읽으므로, 이 한 줄이 없으면 회전이 API 경로에만 닿고
      //   ACP 자식은 «리밋 걸린 계정»으로 계속 쏜다(그 계정에 크레딧이 남아 있으면 유료로 나간다).
      //   ⭐ 회전이 없으면 빈 객체라 종전과 동일하다. ⭐ 호출자가 준 env 가 «이긴다»(의도가 우선).
      // ⛔⭐⭐ 해석 입력은 «이 자식이 실제로 받을 env»다(리뷰 must-fix). `process.env` 만 보면
      //   호출자가 `this.env.ELANOUS_CODEX_ACCOUNT` 로 «명시»한 계정을 회전 판정이 «못 보고»,
      //   결정 ③(명시가 이긴다)이 뚫려 ***명시와 모순되는 홈이 실린다.***
      const childEnv = { ...process.env, ...(this.env ?? {}) };
      const codexBinary = this.codexBinary ?? resolvePreferredCodexBinary();
      const cwd = this.cwd ?? process.cwd();
      const spawnOpts: SpawnCodexAppServerOpts = {
        cwd,
        env: { ...rotatedCodexChildEnv(childEnv), ...(this.env ?? {}) },
        codexBinary,
        codexArgs: this.codexArgs,
        remoteSocketPath: this.remoteSocketPath,
      };
      const spawned = spawnFn(spawnOpts);
      this.client = spawned.client;
      this.child = spawned.child;
      debug.log('acp.client', 'spawn', {
        backendId: this.backendId,
        bin: codexBinary,
        cwd,
      });
      this.wireClient(this.client);
    }
    // JSON-RPC initialize handshake · Codex expects `clientInfo`.
    // `experimentalApi: true` opts this connection into codex's
    // experimental surface — required so codex will send the native
    // structured-question server-request `item/tool/requestUserInput`
    // (gated on this capability, app-server-protocol experimental_api.rs).
    // Unknown experimental notifications are dropped and unhandled
    // experimental server-requests return -32601, so the opt-in is safe.
    const initializeResponse = await this.client.request<
      { clientInfo: { name: string; version: string }; capabilities: Record<string, unknown> },
      InitializeResponse
    >('initialize', {
      clientInfo: { name: 'elanous', version: '0.x' },
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;
    debug.log('acp.client', 'initialized', {
      backendId: this.backendId,
      serverInfo: initializeResponse?.serverInfo ?? null,
      capabilities: initializeResponse?.capabilities ?? null,
    });
    this.advertiseCapabilities();
    // M6 · arm the idle poll once the daemon is live. armIdleTimer is
    // a no-op when timeout is disabled or the timer already runs.
    this.armIdleTimer();
  }

  /** Emits an immutable copy so observers cannot mutate the backend's static declaration. */
  private advertiseCapabilities(): void {
    const snapshot: ElanousCapabilities = {
      ...CODEX_APP_SERVER_CAPS,
      prompt: { ...CODEX_APP_SERVER_CAPS.prompt },
      fileOps: { ...CODEX_APP_SERVER_CAPS.fileOps },
      ui: { ...CODEX_APP_SERVER_CAPS.ui },
      term: { ...CODEX_APP_SERVER_CAPS.term },
      ask: { ...CODEX_APP_SERVER_CAPS.ask },
    };
    Object.freeze(snapshot.prompt);
    Object.freeze(snapshot.fileOps);
    Object.freeze(snapshot.ui);
    Object.freeze(snapshot.term);
    Object.freeze(snapshot.ask);
    Object.freeze(snapshot);
    try {
      this.onCapabilities?.(snapshot);
    } catch (error) {
      this.log(`capability observer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** PLAN-codex-app-server-hermes-parity §5 Phase H2·1 wire (2026-05-16) —
   *  expose the underlying JSON-RPC client so daemon-side helpers
   *  (`fetchCodexPlugins`) can issue out-of-band requests like
   *  `plugin/list`. Returns null when the agent hasn't started yet or
   *  has been stopped — callers must treat that as "no codex active". */
  getClient(): CodexAppServerClient | null {
    return this.client;
  }

  async stop(): Promise<void> {
    // M6 · stop the idle poll first so a tick mid-stop can't reenter
    // hibernate while we're already tearing down.
    this.clearIdleTimer();
    this.startInFlight = null;
    this.currentDaemonSessions.clear();
    // Reject all pending turns BEFORE closing the client. client.close()
    // rejects its own pending-request map but not our per-session
    // pendingTurns (prompts wait on turn/completed notifications, not
    // on the turn/start response).
    for (const entry of this.pendingTurns.values()) {
      entry.reject(new Error('codex-app-server agent stopped'));
    }
    this.pendingTurns.clear();
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* swallow */
      }
    }
    if (this.remoteTuiChild) {
      try {
        this.remoteTuiChild.kill('SIGTERM');
      } catch {
        /* swallow */
      }
    }
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* swallow */
      }
    }
    this.client = null;
    this.child = null;
    this.remoteTuiChild = null;
    this.initialized = false;
    this.sessionToThread.clear();
    this.threadToSession.clear();
    // 3.B.2b · event state is in-memory only · wipe on stop so a
    // restart in-process gets a clean slate. Thread index (disk) is
    // intentionally preserved for loadSession.
    this.eventStates.clear();
    // 3.B.2c · drop advisory transport list + image scratch files.
    // Image dir removal is best-effort — we don't fail stop if it
    // can't be removed (process may have other tenants under tmpdir).
    this.attachedTransports.clear();
    this.turnSeqBySession.clear();
    // M1 · per-session plan-mode state — wiped on stop for parity with
    // sessionToThread/threadToSession.
    this.sessionModes.clear();
    this.sessionModels.clear();
    // M4' · per-session MCP policies — wiped on stop for parity with
    // sessionToThread/threadToSession.
    this.sessionMcpPolicies.clear();
    try {
      rmSync(this.imageTempDir, { recursive: true, force: true });
    } catch {
      /* swallow · best-effort cleanup */
    }
  }

  // ─── M6 · idle hibernate helpers ──────────────────────────────────

  /** Start the idle poll. No-op if already running or hibernation is
   *  disabled. unref() so a CLI can still exit cleanly when the daemon
   *  is the only thing keeping the loop alive. */
  private armIdleTimer(): void {
    if (this.remoteSocketPath) return;
    if (this.idleTimerHandle !== null) return;
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimerHandle = setInterval(() => {
      try {
        this.checkIdle();
      } catch (err) {
        debug.log(
          'acp.cxn.appserver.idle-check-throw',
          err instanceof Error ? err.message : String(err),
        );
      }
    }, this.idleCheckMs);
    // Some test harnesses use timer doubles without `unref` — tolerate.
    if (typeof (this.idleTimerHandle as { unref?: () => void }).unref === 'function') {
      (this.idleTimerHandle as { unref: () => void }).unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimerHandle !== null) {
      clearInterval(this.idleTimerHandle);
      this.idleTimerHandle = null;
    }
  }

  private checkIdle(): void {
    if (!this.client || this.idleTimeoutMs <= 0) return;
    const age = this.client.getIdleAgeMs();
    if (age >= this.idleTimeoutMs) {
      this.handleIdle(age);
    }
  }

  /** Tear down the daemon while preserving the per-session lookup
   *  tables. Next `prompt()` / `loadSession()` lazy-restarts the
   *  daemon and `thread/resume`s the affected session. Pending turns
   *  cannot continue across hibernate — reject them with a clear
   *  diagnostic so callers can decide to retry. */
  private handleIdle(age: number): void {
    this.log(
      `idle hibernate · age=${age}ms threshold=${this.idleTimeoutMs}ms · sessions=${this.currentDaemonSessions.size}`,
    );
    // Stop the timer FIRST · the next setInterval tick must not fire
    // while we're tearing down (would double-kill the child).
    this.clearIdleTimer();
    this.tearDownDaemonPreservingSessions('hibernated mid-turn');
  }

  /** Kill the daemon child + null the client while KEEPING per-agent
   *  session lookup (sessionToThread / threadToSession / threadIndex) so
   *  the next `prompt()` lazy-respawns and `thread/resume`s. Pending turns
   *  can't survive the respawn — reject them with `reason`. Shared by idle
   *  hibernate and the auth-failure respawn path. */
  private tearDownDaemonPreservingSessions(reason: string): void {
    for (const entry of this.pendingTurns.values()) {
      entry.reject(new Error(`codex app-server ${reason}`));
    }
    this.pendingTurns.clear();
    if (this.client) {
      try { void this.client.close(); } catch { /* swallow */ }
    }
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* swallow */ }
    }
    this.client = null;
    this.child = null;
    this.initialized = false;
    this.eventStates.clear();
    this.currentDaemonSessions.clear();
  }

  /** Currently in-flight idle hibernate (or null). Test seam — production
   *  code never reads this; tests assert "did the timer fire?" without
   *  driving real time. */
  _testForceIdleHibernate(): void {
    this.handleIdle(this.idleTimeoutMs);
  }

  /** Read-only snapshot of the resolved idle hibernate threshold (ms). */
  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  /** Lazy-restart hook · ensures the daemon is running before issuing
   *  any client.request. Idempotent + race-safe via startInFlight. */
  private async ensureRunning(): Promise<void> {
    // Auth-failure respawn — tear the (stale-token) daemon down so start()
    // spawns a clean process. Deferred to here so it happens once, on the
    // next turn, rather than racing the failing turn's teardown.
    if (this.needsRespawn) {
      this.needsRespawn = false;
      this.log('codex auth failure recovery · retiring daemon for clean respawn');
      this.tearDownDaemonPreservingSessions('retired after auth failure');
    }
    if (this.initialized && this.client) return;
    await this.start();
  }

  /** After hibernate the daemon has zero thread state. A prompt for an
   *  existing session must `thread/resume` against the fresh daemon
   *  before `turn/start`. Tracked via `currentDaemonSessions` so we
   *  don't pay the resume RPC on every prompt. */
  private async ensureSessionResumed(
    sessionId: SessionId,
    threadId: string,
  ): Promise<void> {
    if (this.currentDaemonSessions.has(sessionId)) return;
    const client = this.client;
    if (!client) {
      throw new Error(
        'CodexAppServerAgent · ensureSessionResumed called without an active client',
      );
    }
    const entry = this.threadIndex.get(sessionId as string);
    const cwd = entry?.cwd ?? this.cwd ?? process.cwd();
    let resp: { thread: { id: string } };
    try {
      resp = await client.request<
        {
          threadId: string;
          cwd?: string | null;
          persistExtendedHistory: boolean;
        },
        { thread: { id: string } }
      >('thread/resume', {
        threadId,
        cwd,
        persistExtendedHistory: false,
      });
    } catch (err) {
      // After a daemon hibernate the in-memory thread state is gone;
      // the server may legitimately reject `thread/resume` if it
      // can't recover the conversation, or the network may have
      // glitched. Either way the persisted sessionId is now
      // unusable — drop our local mappings + surface as a stale-
      // shaped error so runAcpTurn's recovery path picks it up
      // instead of leaking the raw RPC failure to the user. */
      this.sessionToThread.delete(sessionId);
      this.threadToSession.delete(threadId);
      this.eventStates.delete(sessionId);
      this.currentDaemonSessions.delete(sessionId);
      throw new CodexAppServerSessionNotFoundError(
        String(sessionId),
        err instanceof Error ? err.message : String(err),
      );
    }
    const resumedThreadId = resp?.thread?.id;
    if (typeof resumedThreadId === 'string' && resumedThreadId.length > 0 && resumedThreadId !== threadId) {
      // Server may rotate the thread id on resume; reflect that in our
      // maps so future routing finds the session.
      this.sessionToThread.set(sessionId, resumedThreadId);
      this.threadToSession.delete(threadId);
      this.threadToSession.set(resumedThreadId, sessionId);
    }
    this.eventStates.set(sessionId, createEventState());
    this.currentDaemonSessions.add(sessionId);
    this.threadIndex.touch(sessionId as string);
    // M4'.1 — restore the persisted MCP policy (if any) before the next
    // mcpServer/tool/call arrives. The in-memory map is the authoritative
    // source; the persisted snapshot is only consulted when an entry is
    // missing locally (e.g. host restart resumed a session with a
    // pre-existing policy).
    if (entry?.mcpPolicy && !this.sessionMcpPolicies.has(sessionId)) {
      this.sessionMcpPolicies.set(sessionId, {
        mode: entry.mcpPolicy.mode,
        ...(entry.mcpPolicy.tools ? { tools: [...entry.mcpPolicy.tools] } : {}),
      });
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────

  async newSession(): Promise<SessionId> {
    // M6 — lazy restart safe: ensureRunning() waits on any in-flight
    // start (or kicks one off after hibernate) before we touch client.
    await this.ensureRunning();
    this.assertInitialized();
    const client = this.client!;
    // v2 ThreadStartResponse is { thread: { id, ... }, model, ... } —
    // the threadId lives at response.thread.id, not response.threadId.
    // See codex-rs/app-server-protocol/src/protocol/v2.rs L2744.
    const resp = await client.request<
      {
        cwd?: string | null;
        experimentalRawEvents: boolean;
        persistExtendedHistory: boolean;
      },
      { thread: { id: string }; model?: string }
    >('thread/start', {
      cwd: this.cwd ?? null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = resp?.thread?.id;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error(
        `codex-app-server · thread/start returned no thread.id (got ${JSON.stringify(resp)})`,
      );
    }
    const sessionId = this.mintSessionId();
    this.sessionToThread.set(sessionId, threadId);
    this.threadToSession.set(threadId, sessionId);
    this.eventStates.set(sessionId, createEventState());
    // M1 · capture the server-supplied model so plan-mode requests can
    // populate the required `collaborationMode.settings.model` field.
    if (typeof resp?.model === 'string' && resp.model.length > 0) {
      this.sessionModels.set(sessionId, resp.model);
    }
    // 3.B.2b · persist to disk index so loadSession can round-trip
    // after a elanous restart. cwd defaults to the agent's construction
    // cwd; thread/resume can override later.
    this.threadIndex.put(sessionId as string, {
      threadId,
      cwd: this.cwd ?? process.cwd(),
    });
    // M6 · brand-new sessions are alive in the current daemon by
    // definition · no thread/resume needed before the first turn.
    this.currentDaemonSessions.add(sessionId);
    if (this.remoteSocketPath && !this.remoteTuiChild) {
      const explicitEnv = this.env ?? {};
      const tuiEnv = {
        ...rotatedCodexChildEnv({ ...process.env, ...explicitEnv }),
        ...explicitEnv,
      };
      const spawnRemoteTui = this._remoteTuiSpawnForTesting ?? spawnCodexRemoteTui;
      this.remoteTuiChild = spawnRemoteTui({
        codexBinary: this.codexBinary ?? resolvePreferredCodexBinary(),
        socketPath: this.remoteSocketPath,
        cwd: this.cwd,
        env: tuiEnv,
      });
    }
    debug.log('acp.client', 'session-new', { backendId: this.backendId, sessionId });
    return sessionId;
  }

  async loadSession(req: {
    sessionId: SessionId;
    cwd?: string;
  }): Promise<Record<string, never>> {
    // M6 — lazy restart for the resume path too.
    await this.ensureRunning();
    this.assertInitialized();
    const client = this.client!;
    const entry = this.threadIndex.get(req.sessionId as string);
    if (!entry) {
      throw new CodexAppServerSessionNotFoundError(req.sessionId as string);
    }
    // v2 ThreadResumeResponse: { thread: { id, ... }, model, ... }.
    // The server may return the same thread.id or a new one (when
    // resuming from path). Use whatever the server supplies.
    const resp = await client.request<
      {
        threadId: string;
        cwd?: string | null;
        persistExtendedHistory: boolean;
      },
      { thread: { id: string }; model?: string }
    >('thread/resume', {
      threadId: entry.threadId,
      cwd: req.cwd ?? entry.cwd,
      persistExtendedHistory: false,
    });
    const resumedThreadId = resp?.thread?.id;
    if (typeof resumedThreadId !== 'string' || resumedThreadId.length === 0) {
      throw new Error(
        `codex-app-server · thread/resume returned no thread.id (got ${JSON.stringify(resp)})`,
      );
    }
    this.sessionToThread.set(req.sessionId, resumedThreadId);
    this.threadToSession.set(resumedThreadId, req.sessionId);
    this.eventStates.set(req.sessionId, createEventState());
    // M1 · refresh the captured model on resume too — different daemon
    // restarts may pick up a different model from config.
    if (typeof resp?.model === 'string' && resp.model.length > 0) {
      this.sessionModels.set(req.sessionId, resp.model);
    }
    this.threadIndex.touch(req.sessionId as string);
    // M6 · explicit loadSession marks the session live in the current
    // daemon — ensureSessionResumed() won't re-call thread/resume.
    this.currentDaemonSessions.add(req.sessionId);
    // M4'.1 · restore persisted MCP policy if present and not already
    // populated in-memory.
    if (entry.mcpPolicy && !this.sessionMcpPolicies.has(req.sessionId)) {
      this.sessionMcpPolicies.set(req.sessionId, {
        mode: entry.mcpPolicy.mode,
        ...(entry.mcpPolicy.tools ? { tools: [...entry.mcpPolicy.tools] } : {}),
      });
    }
    this.log(`resumed cas session ${req.sessionId} (thread ${resumedThreadId})`);
    return {};
  }

  // ─── Turn execution ──────────────────────────────────────────────

  async prompt(
    sessionId: SessionId,
    blocks: readonly ContentBlock[],
    onUpdate: AcpUpdateCallback,
  ): Promise<AcpPromptResult> {
    // M6 — lazy restart + per-session thread/resume after hibernate.
    await this.ensureRunning();
    this.assertInitialized();
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) {
      throw new Error(`codex-app-server · unknown session ${sessionId}`);
    }
    if (this.pendingTurns.has(sessionId)) {
      throw new Error(`codex-app-server · session ${sessionId} already has a turn in flight`);
    }
    await this.ensureSessionResumed(sessionId, threadId);
    // 3.B.2c · collect text + image blocks. Images are materialised to
    // the agent's scratch dir (per-turn file names) and passed as
    // `{type:'localImage', path}` inputs. See collectInputs() helper.
    const turnSeq = this.bumpTurnSeq(sessionId);
    const input = collectInputs(blocks, this.imageTempDir, sessionId as string, turnSeq);
    const chars = blocks.reduce((total, block) =>
      total + ('text' in block && typeof block.text === 'string' ? block.text.length : 0), 0);
    const startedAt = Date.now();
    debug.log('acp.client', 'prompt-start', { backendId: this.backendId, sessionId, chars });
    // M1 · build the optional collaborationMode envelope. We only emit
    // when mode === 'plan' AND we know the session's model — the
    // server requires `settings.model`, so an unknown model means we
    // omit the envelope and fall back to the thread default mode.
    const collaborationMode = this.buildCollaborationMode(sessionId);
    return new Promise<AcpPromptResult>((resolve, reject) => {
      // ── hermes-parity turn watchdog + auth-failure classification ──
      // quietTimer resets on every event (bump); hardTimer is the
      // wall-clock backstop. On expiry we interrupt the hung turn and
      // reject so the delegation doesn't stall forever (e.g. "throw a
      // mission via Telegram and walk away").
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const dispose = (): void => {
        if (quietTimer) clearTimeout(quietTimer);
        if (hardTimer) clearTimeout(hardTimer);
        quietTimer = undefined;
        hardTimer = undefined;
      };
      const failWatchdog = (msg: string): void => {
        // Only fire if the turn is still pending (not already settled).
        if (!this.pendingTurns.delete(sessionId)) return;
        dispose();
        this.log(`turn watchdog · ${msg} · session=${sessionId}`);
        // Best-effort interrupt so codex stops working on the dead turn.
        this.client?.request('turn/interrupt', { threadId }).catch(() => { /* swallow */ });
        reject(new Error(`codex-app-server · ${msg}`));
      };
      const bump = (): void => {
        if (this.turnQuietMs <= 0) return;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(
          () => failWatchdog(`turn quiet for ${this.turnQuietMs}ms — aborting (hung?)`),
          this.turnQuietMs,
        );
      };
      const wrappedResolve = (r: AcpPromptResult): void => {
        dispose();
        this.sessionToCurrentTurn.delete(sessionId);
        debug.log('acp.client', 'prompt-end', {
          backendId: this.backendId, sessionId, chars, stopReason: r.stopReason, durationMs: Date.now() - startedAt,
        });
        resolve(r);
      };
      const wrappedReject = (err: Error): void => {
        dispose();
        this.sessionToCurrentTurn.delete(sessionId);
        debug.log('acp.client', 'prompt-failed', {
          backendId: this.backendId, sessionId, chars, durationMs: Date.now() - startedAt,
          ...codexPromptFailureMetadata(err),
        });
        // Auth failure → queue a clean respawn + surface an actionable hint.
        if (isCodexAuthError(err)) {
          this.needsRespawn = true;
          this.log(`codex auth failure — respawn queued: ${err.message}`);
          reject(new Error(`${err.message} · codex 인증 만료 — 터미널에서 \`codex login\` 후 재시도`));
          return;
        }
        reject(err);
      };

      if (this.turnHardMs > 0) {
        hardTimer = setTimeout(
          () => failWatchdog(`turn exceeded ${this.turnHardMs}ms wall-clock — aborting`),
          this.turnHardMs,
        );
      }
      bump();
      this.pendingTurns.set(sessionId, {
        onUpdate: (u) => { bump(); onUpdate(u); },
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
      this.client!
        .request<
          {
            threadId: string;
            input: unknown;
            collaborationMode?: CodexCollaborationMode;
          },
          { turn?: { id?: string }; turnId?: string }
        >('turn/start', {
          threadId,
          input,
          ...(collaborationMode ? { collaborationMode } : {}),
        })
        .then((resp) => {
          // Capture the live turnId so `steer()` can target it. codex v2
          // returns `{ turn: { id } }`; tolerate a flat `{ turnId }` too.
          const tid = resp?.turn?.id ?? resp?.turnId;
          if (tid && this.pendingTurns.has(sessionId)) {
            this.sessionToCurrentTurn.set(sessionId, tid);
          }
        })
        .catch((err) => {
          if (this.pendingTurns.delete(sessionId)) {
            wrappedReject(err instanceof Error ? err : new Error(String(err)));
          }
        });
    });
  }

  /** Inject additional user input into the CURRENTLY RUNNING turn via
   *  codex `turn/steer`, without interrupting it — so a mid-mission
   *  "also add tests" reaches the live turn instead of aborting +
   *  re-prompting or waiting for the next iteration. `expectedTurnId`
   *  is the optimistic-concurrency precondition: codex rejects the steer
   *  if the turn already advanced. Returns `false` (no-op) when there's
   *  no in-flight turn for the session. */
  async steer(sessionId: SessionId, blocks: readonly ContentBlock[]): Promise<boolean> {
    const threadId = this.sessionToThread.get(sessionId);
    const turnId = this.sessionToCurrentTurn.get(sessionId);
    if (!threadId || !turnId || !this.client) return false;
    const turnSeq = this.bumpTurnSeq(sessionId);
    const input = collectInputs(blocks, this.imageTempDir, sessionId as string, turnSeq);
    await this.client.request<
      { threadId: string; turnId: string; input: unknown; expectedTurnId: string },
      { turnId?: string }
    >('turn/steer', { threadId, turnId, input, expectedTurnId: turnId });
    return true;
  }

  // ─── Goal lifecycle (follow-up B) ─────────────────────────────────

  /** Set (or update) the session's codex-native goal — objective +
   *  optional token budget. codex tracks progress + enforces the budget
   *  server-side and emits `thread/goal/updated`. Returns the current
   *  ThreadGoal, or null when the session has no live thread. */
  async setGoal(
    sessionId: SessionId,
    goal: { objective?: string; tokenBudget?: number; status?: CodexGoalStatus },
  ): Promise<CodexThreadGoal | null> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId || !this.client) return null;
    const resp = await this.client.request<
      { threadId: string; objective?: string; status?: CodexGoalStatus; tokenBudget?: number },
      { goal: CodexThreadGoal }
    >('thread/goal/set', {
      threadId,
      ...(goal.objective !== undefined ? { objective: goal.objective } : {}),
      ...(goal.status !== undefined ? { status: goal.status } : {}),
      ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    });
    return resp?.goal ?? null;
  }

  /** Read the session's current codex goal (or null when none / no thread). */
  async getGoal(sessionId: SessionId): Promise<CodexThreadGoal | null> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId || !this.client) return null;
    const resp = await this.client.request<
      { threadId: string },
      { goal: CodexThreadGoal | null }
    >('thread/goal/get', { threadId });
    return resp?.goal ?? null;
  }

  /** Clear the session's codex goal. Returns whether one was removed. */
  async clearGoal(sessionId: SessionId): Promise<boolean> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId || !this.client) return false;
    const resp = await this.client.request<
      { threadId: string },
      { cleared?: boolean }
    >('thread/goal/clear', { threadId });
    return resp?.cleared === true;
  }

  /** Register a listener for codex goal-status changes. The callback
   *  receives the mapped elanous mission status + the raw goal so a mission
   *  layer can update its registry / surface budget. `goal` is null on
   *  `thread/goal/cleared`. Returns an unsubscribe fn. */
  onGoalUpdate(fn: CodexGoalUpdateListener): () => void {
    this.goalListeners.add(fn);
    return () => { this.goalListeners.delete(fn); };
  }

  private readonly goalListeners = new Set<CodexGoalUpdateListener>();

  private handleGoalNotification(params: unknown, cleared: boolean): void {
    const p = (params ?? {}) as { threadId?: string; goal?: CodexThreadGoal };
    const threadId = cleared ? p.threadId : (p.goal?.threadId ?? p.threadId);
    if (typeof threadId !== 'string') return;
    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) return;
    const goal = cleared ? null : (p.goal ?? null);
    const missionStatus = goal ? mapCodexGoalStatusToMissionStatus(goal.status) : 'disarmed';
    for (const fn of Array.from(this.goalListeners)) {
      try { fn({ sessionId, missionStatus, goal }); }
      catch (err) { this.log(`onGoalUpdate listener threw: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  // ─── M1 · plan mode public API ────────────────────────────────────

  /** Set the collaboration mode for an existing session. Future
   *  `prompt()` calls on this session will tag their `turn/start` with
   *  `collaborationMode: { mode, settings: { model } }` when mode is
   *  `'plan'`. Setting `'default'` clears the override (server picks
   *  up the thread's natural default). Unknown sessions are silently
   *  recorded — when the session later registers, the mode is already
   *  in place. */
  setSessionMode(sessionId: SessionId, mode: CodexModeKind): void {
    if (mode === 'default') {
      this.sessionModes.delete(sessionId);
      return;
    }
    this.sessionModes.set(sessionId, mode);
  }

  /** Read the host-side mode override for a session. Returns
   *  `'default'` when no override is set (matches the wire-shape we
   *  emit — no envelope = server default mode). */
  getSessionMode(sessionId: SessionId): CodexModeKind {
    return this.sessionModes.get(sessionId) ?? 'default';
  }

  /** Read the captured model for a session (or undefined when none
   *  has been observed yet). Plan mode requires this for the
   *  `collaborationMode.settings.model` field. */
  getSessionModel(sessionId: SessionId): string | undefined {
    return this.sessionModels.get(sessionId);
  }

  /** Build the optional collaborationMode envelope for `turn/start`.
   *  Returns `undefined` (omit the field) when the session is in the
   *  default mode OR when we don't have a model to populate the
   *  required Settings field. */
  private buildCollaborationMode(sessionId: SessionId): CodexCollaborationMode | undefined {
    const mode = this.sessionModes.get(sessionId);
    if (!mode || mode === 'default') return undefined;
    const model = this.sessionModels.get(sessionId);
    if (!model) {
      this.log(
        `setSessionMode='${mode}' but no model captured for ${sessionId} · omitting collaborationMode (server default mode will apply)`,
      );
      return undefined;
    }
    return {
      mode,
      settings: { model },
    };
  }

  // ─── 3.B.2c · public setters / attach helpers ────────────────────

  /** Swap the MCP tool-call handler at runtime. Agent-manager uses
   *  this when the dashboard wires its MCP registry after the agent
   *  has already been started (dogfood path). */
  setMcpToolCallHandler(handler?: CodexMcpToolCallHandler): void {
    this.mcpToolCallHandler = handler ?? defaultMcpToolCallHandler;
  }

  /** Swap the elicitation handler at runtime. */
  setElicitationHandler(handler?: CodexElicitationHandler): void {
    this.elicitationHandler = handler ?? defaultElicitationHandler;
  }

  /** M3 (2026-04-28) · Swap the elanous/ui envelope handler at runtime.
   *  Pass `undefined` to disable interception (envelope-shaped text
   *  passes through to the client unchanged). */
  setElanousUiHandler(handler?: CodexElanousUiHandler): void {
    this.elanousUiHandler = handler ?? null;
  }

  // ─── M4' · per-session MCP policy public API ─────────────────────

  /** Set (or replace) the MCP tool policy for a session. Subsequent
   *  `mcpServer/tool/call` server-requests for that session are matched
   *  against this policy before reaching the wired tool handler — the
   *  call is short-circuited with `{isError: true}` when the policy
   *  blocks. Pass `undefined` to clear (= allow-all). Unknown sessions
   *  silently record so callers can pin a policy at session-mint time
   *  before the agent routes its first call.
   *
   *  M4'.1 (sprint 4) — persistence wired through the thread-index.
   *  Setting a policy auto-saves to disk; clearing removes the field.
   *  loadSession + ensureSessionResumed restore the in-memory map from
   *  the persisted snapshot so a host restart preserves session
   *  policies. Unknown sessionIds skip persistence (no entry to write
   *  against) but still update the in-memory map. */
  setSessionMcpPolicy(
    sessionId: SessionId,
    policy: CodexMcpSessionPolicy | undefined,
  ): void {
    if (!policy || policy.mode === 'allow-all') {
      this.sessionMcpPolicies.delete(sessionId);
      // Clear the persisted snapshot too so loadSession after this
      // doesn't restore a stale policy.
      this.threadIndex.setMcpPolicy(sessionId as string, null);
      return;
    }
    this.sessionMcpPolicies.set(sessionId, policy);
    // Snapshot is shape-identical (mode + tools) — pass through.
    this.threadIndex.setMcpPolicy(sessionId as string, {
      mode: policy.mode,
      ...(policy.tools ? { tools: [...policy.tools] } : {}),
    });
  }

  /** Read the policy for a session. Returns `undefined` when none
   *  is registered (= allow-all). */
  getSessionMcpPolicy(sessionId: SessionId): CodexMcpSessionPolicy | undefined {
    return this.sessionMcpPolicies.get(sessionId);
  }

  /** 3.B.2c · attach an advisory transport descriptor to a live
   *  session. The returned disposer removes it. Consumed by AXON /
   *  dashboard observers that want to show "session X is backed by
   *  these transports" without mutating `EmbodiedAgentSession.
   *  transports` (which is readonly in the H5 contract). */
  attachTransport(
    sessionId: SessionId,
    descriptor: { kind: string; id: string; label?: string },
  ): () => void {
    let list = this.attachedTransports.get(sessionId);
    if (!list) {
      list = [];
      this.attachedTransports.set(sessionId, list);
    }
    list.push(descriptor);
    return () => {
      const current = this.attachedTransports.get(sessionId);
      if (!current) return;
      const idx = current.indexOf(descriptor);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) this.attachedTransports.delete(sessionId);
    };
  }

  /** Read-only snapshot of a session's attached transports. Empty
   *  array when none have been attached. */
  listAttachedTransports(
    sessionId: SessionId,
  ): readonly { kind: string; id: string; label?: string }[] {
    return this.attachedTransports.get(sessionId)?.slice() ?? [];
  }

  /** Returns a transport descriptor representing THIS agent's RPC
   *  connection to codex app-server. Useful for callers that want to
   *  attach the agent-side transport to an EmbodiedAgentSession's
   *  advisory list (via `attachTransport` or upstream UI). */
  getRpcTransportDescriptor(): { kind: 'rpc'; id: string; label: string } {
    const pid = this.child?.pid;
    return {
      kind: 'rpc',
      id: `cas-${pid ?? 'in-process'}`,
      label: 'codex-app-server',
    };
  }

  // ─── Internal helpers · 3.B.2c ───────────────────────────────────

  private readonly turnSeqBySession = new Map<SessionId, number>();
  private bumpTurnSeq(sessionId: SessionId): number {
    const next = (this.turnSeqBySession.get(sessionId) ?? 0) + 1;
    this.turnSeqBySession.set(sessionId, next);
    return next;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId || !this.client) return;
    try {
      await this.client.request('turn/interrupt', { threadId });
    } catch (err) {
      this.log(`turn/interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Internal · wire the client once ─────────────────────────────

  private wireClient(client: CodexAppServerClient): void {
    // Approval adapter → server request handlers. All five approval-
    // shaped methods route to the same adapter; the adapter decides
    // based on the `method` context.
    for (const method of APPROVAL_METHODS) {
      client.setServerRequestHandler(method, async (params) => {
        return this.routeApproval(method, params);
      });
    }

    // Native structured-question elicitation (experimental) — codex asks
    // the user a multiple-choice / free-form question. Route it through
    // the same questionApprover the surface HITL QuestionChannel backs,
    // so a delegated Codex turn's question renders as option buttons in
    // the triggering chat (Telegram etc.).
    client.setServerRequestHandler(USER_INPUT_METHOD, async (params) => {
      return this.routeUserInput(params);
    });

    // 3.B.2c · MCP bridge. Codex invokes elanous-hosted MCP tools via
    // `mcpServer/tool/call`; we route to the injected handler so
    // different agent-manager configurations (default stub vs real
    // registry) can share the agent class.
    client.setServerRequestHandler(MCP_BRIDGE_METHODS.toolCall, async (params) => {
      try {
        const p = (params ?? {}) as {
          threadId?: string;
          server?: string;
          tool?: string;
          arguments?: Record<string, unknown>;
        };
        const tool = typeof p.tool === 'string' ? p.tool : '';
        if (!tool) {
          return {
            content: [{ type: 'text', text: 'missing tool name' }],
            isError: true,
            errorMessage: 'missing tool name in mcpServer/tool/call',
          };
        }
        // M4' · per-session policy gate. Resolve the sessionId from the
        // server-supplied threadId (inverse map), look up the policy,
        // and short-circuit with a deny payload when blocked. Unknown
        // sessions fall through to allow-all (default) so a tool call
        // arriving before the agent has wired the threadId on its side
        // doesn't produce a confusing block.
        const policySessionId = p.threadId
          ? this.threadToSession.get(p.threadId)
          : undefined;
        const policy = policySessionId
          ? this.sessionMcpPolicies.get(policySessionId)
          : undefined;
        const serverPart = typeof p.server === 'string' && p.server.length > 0 ? `${p.server}/` : '';
        const policyKey = `${serverPart}${tool}`;
        const denyReason = evaluateMcpPolicy(policy, policyKey);
        if (denyReason !== null) {
          this.log(`mcpServer/tool/call denied by policy · ${denyReason}`);
          return {
            content: [{ type: 'text', text: denyReason }],
            isError: true,
            errorMessage: denyReason,
          };
        }
        const result = await this.mcpToolCallHandler({
          threadId: p.threadId,
          server: p.server,
          tool,
          arguments: p.arguments,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`mcpServer/tool/call handler threw: ${msg}`);
        return {
          content: [{ type: 'text', text: `handler error: ${msg}` }],
          isError: true,
          errorMessage: msg,
        };
      }
    });

    // M2 (2026-04-28) · fs/readFile server-request — codex requests the
    // host to fetch file contents. Path is validated against the
    // workspace root + a size cap; failures surface as `{isError: true,
    // errorMessage}` so the daemon can degrade gracefully.
    client.setServerRequestHandler(FS_METHODS.readFile, async (params) => {
      try {
        const p = (params ?? {}) as { path?: string };
        const path = typeof p.path === 'string' ? p.path : '';
        const workspaceRoot = this.cwd ?? process.cwd();
        const validation = validateFsPath(path, workspaceRoot);
        if (validation !== null) {
          return { isError: true, errorMessage: validation };
        }
        const buf = readFileSync(path);
        if (buf.byteLength > this.fileOpsMaxBytes) {
          const msg = `fs/readFile · file ${path} too large (${buf.byteLength} bytes > ${this.fileOpsMaxBytes} cap)`;
          this.log(msg);
          return { isError: true, errorMessage: msg };
        }
        return { dataBase64: buf.toString('base64') };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`fs/readFile failed: ${msg}`);
        return { isError: true, errorMessage: msg };
      }
    });

    // M2 · fs/writeFile server-request. Plan-mode-aware (M1 interaction):
    // when the calling session is pinned to plan mode, the write is
    // refused without ever touching disk. Path validation + base64
    // decode then native write.
    client.setServerRequestHandler(FS_METHODS.writeFile, async (params) => {
      try {
        const p = (params ?? {}) as { threadId?: string; path?: string; dataBase64?: string };
        const path = typeof p.path === 'string' ? p.path : '';
        const dataBase64 = typeof p.dataBase64 === 'string' ? p.dataBase64 : '';
        const workspaceRoot = this.cwd ?? process.cwd();
        // Plan-mode gate · requires M1 sessionModes (sprint 2 merged).
        if (p.threadId) {
          const sessionId = this.threadToSession.get(p.threadId);
          if (sessionId && this.sessionModes.get(sessionId) === 'plan') {
            const msg = `plan mode: writeFile blocked for path "${path}"`;
            this.log(msg);
            return { isError: true, errorMessage: msg };
          }
        }
        const validation = validateFsPath(path, workspaceRoot);
        if (validation !== null) {
          return { isError: true, errorMessage: validation };
        }
        const decoded = Buffer.from(dataBase64, 'base64');
        if (decoded.byteLength > this.fileOpsMaxBytes) {
          const msg = `fs/writeFile · payload ${path} too large (${decoded.byteLength} bytes > ${this.fileOpsMaxBytes} cap)`;
          this.log(msg);
          return { isError: true, errorMessage: msg };
        }
        writeFileSync(path, decoded);
        return {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`fs/writeFile failed: ${msg}`);
        return { isError: true, errorMessage: msg };
      }
    });

    // 3.B.2c · Elicitation. Codex → elanous-ui prompt round-trip.
    client.setServerRequestHandler(MCP_BRIDGE_METHODS.elicitation, async (params) => {
      try {
        const p = (params ?? {}) as {
          threadId?: string;
          server?: string;
          message?: string;
          requestedSchema?: unknown;
        };
        const result = await this.elicitationHandler({
          threadId: p.threadId,
          server: p.server,
          message: p.message,
          schema: p.requestedSchema,
        });
        // ⛔⭐ **기본 핸들러는 «전부 거절»한다**(`defaultElicitationHandler`) 그리고
        //    🧪 `setElicitationHandler` 의 프로덕션 호출자가 «0» 이다 ⇒ 지금 elanous 는
        //    ***구조적으로 모든 elicitation 을 거절한다.*** 그런데 그것이 «결정»이 아니라
        //    «기본값»이었고 «관측이 없어서», 「아무도 안 묻는다」와 「물었는데 거절했다」를
        //    구분할 수가 없었다. ⇒ 그 둘을 가르는 값을 남긴다.
        //
        // ⛔⭐⭐ **여기서 가르는 축은 「params 인가」가 아니라 「«식별자»인가 «내용»인가」다.**
        //    ✅ 싣는다  — `server`·`threadId`. 둘 다 «라우팅 식별자»다.
        //       ***이것들이 없으면 관측이 무의미하다*** — 「어느 서버가 물었나」를 못 답한다.
        //       `server` 는 우리 config 의 서버 id 이고 `threadId` 는 elanous 내부 대화 id 다.
        //    ⛔ 안 싣는다 — `message` 본문 · 스키마의 값/기본값/설명. ***사용자 내용***이고
        //       url 모드 elicitation 은 사양상 «인증·결제»를 나른다
        //       ("Servers MUST use URL mode for interactions involving such sensitive information").
        //    📌 리뷰가 이 자리를 두 번 물었다(1R: 없는 로그를 지어냄 · 3R: 식별자를 내용으로 봄).
        //       그래서 판정 축을 여기 «이름으로» 적어 둔다 — 다시 물으면 이 줄이 답이다.
        debug.log('mcp.elicitation', 'request', {
          server: p.server,
          threadId: p.threadId,
          hasMessage: typeof p.message === 'string' && p.message.length > 0,
          schemaKeys: elicitationSchemaKeys(p.requestedSchema),
          action: (result as { action?: string } | undefined)?.action ?? 'unknown',
          handlerInstalled: this.elicitationHandler !== defaultElicitationHandler,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`mcpServer/elicitation/request handler threw: ${msg}`);
        return { action: 'cancel' };
      }
    });

    // 3.B.2b · full v2 notification fan-out. Each item/... notification
    // resolves a (sessionId, state) pair via threadId, translates via
    // the pure events module, and dispatches zero-or-more SessionUpdate
    // to the pending turn's onUpdate callback.
    client.onNotification('item/started', (params) => {
      this.dispatchItemNotification('started', params);
    });
    client.onNotification('item/completed', (params) => {
      this.dispatchItemNotification('completed', params);
    });
    client.onNotification('item/agentMessage/delta', (params) => {
      this.dispatchToUpdateCallback(params, () => translateAgentMessageDelta(params));
    });
    client.onNotification('item/plan/delta', (params) => {
      this.dispatchToUpdateCallback(params, () => translatePlanDelta(params));
    });
    client.onNotification('item/reasoning/summaryTextDelta', (params) => {
      this.dispatchToUpdateCallback(params, () => translateReasoningDelta(params));
    });
    client.onNotification('item/reasoning/textDelta', (params) => {
      this.dispatchToUpdateCallback(params, () => translateReasoningDelta(params));
    });
    client.onNotification('item/commandExecution/outputDelta', (params) => {
      this.dispatchToUpdateCallback(params, (state) =>
        translateCommandExecutionOutputDelta(params, state),
      );
    });
    client.onNotification('item/fileChange/outputDelta', (params) => {
      this.dispatchToUpdateCallback(params, (state) =>
        translateFileChangeOutputDelta(params, state),
      );
    });
    client.onNotification('turn/plan/updated', (params) => {
      this.dispatchToUpdateCallback(params, () => translateTurnPlanUpdated(params));
    });
    client.onNotification('turn/completed', (params) => {
      this.finishTurn(params);
    });
    // Goal lifecycle (follow-up B) — codex tracks the thread's persisted
    // goal (progress · token/time budget · status). Route updates to the
    // agent's onGoalUpdate hook so a mission layer can reflect codex's
    // native goal status back onto the elanous mission.
    client.onNotification('thread/goal/updated', (params) => {
      this.handleGoalNotification(params, false);
    });
    client.onNotification('thread/goal/cleared', (params) => {
      this.handleGoalNotification(params, true);
    });

    client.onExit((code) => {
      this.log(`codex app-server exited code=${code}`);
      for (const entry of this.pendingTurns.values()) {
        entry.reject(new Error('codex app-server exited'));
      }
      this.pendingTurns.clear();
      this.initialized = false;
    });
  }

  /** Resolve sessionId from the notification's threadId and route the
   *  produced SessionUpdate(s) to the pending turn's onUpdate. Shared
   *  by all delta / turn-level notifications. */
  private dispatchToUpdateCallback(
    params: unknown,
    producer: (state: EventState) => SessionUpdate[],
  ): void {
    const p = params as { threadId?: string } | undefined;
    const threadId = p?.threadId;
    if (!threadId) return;
    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) return;
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    let state = this.eventStates.get(sessionId);
    if (!state) {
      state = createEventState();
      this.eventStates.set(sessionId, state);
    }
    let updates: SessionUpdate[];
    try {
      updates = producer(state);
    } catch (err) {
      this.log(
        `event translator threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const u of updates) {
      // M3 — `elanous/ui/*` envelope interception. agent_thought_chunk
      // updates whose text parses as a valid envelope are forwarded to
      // the registered host handler and SUPPRESSED from the downstream
      // onUpdate. Extension-unaware peers + handler-absent runs see
      // envelope text pass through verbatim (parity with native, where
      // the dashboard owns parsing).
      if (this.elanousUiHandler && this.isThoughtChunk(u)) {
        const text = this.extractChunkText(u);
        if (text) {
          const parsed = parseElanousUiEnvelope(text);
          if (parsed) {
            try {
              this.elanousUiHandler({
                sessionId: sessionId as string,
                method: parsed.method,
                payload: parsed.payload,
              });
            } catch (err) {
              this.log(
                `elanousUiHandler throw: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // skip downstream onUpdate — the envelope text shouldn't
            // surface as plain reasoning to the client.
            continue;
          }
        }
      }
      try {
        pending.onUpdate(u);
      } catch (err) {
        this.log(`onUpdate throw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // M3 helpers — narrow type guards for envelope detection.
  private isThoughtChunk(u: SessionUpdate): boolean {
    return (u as { sessionUpdate?: string }).sessionUpdate === 'agent_thought_chunk';
  }

  private extractChunkText(u: SessionUpdate): string | null {
    const content = (u as { content?: { type?: string; text?: string } }).content;
    if (!content || content.type !== 'text' || typeof content.text !== 'string') {
      return null;
    }
    return content.text;
  }

  /** item/started + item/completed share the same plumbing but pass
   *  the phase through to the translator so one function can emit the
   *  right SessionUpdate shape. */
  private dispatchItemNotification(
    phase: 'started' | 'completed',
    params: unknown,
  ): void {
    this.dispatchToUpdateCallback(params, (state) =>
      translateItemNotification(phase, params, state),
    );
  }

  private finishTurn(params: unknown): void {
    const p = params as { threadId?: string } | undefined;
    const threadId = p?.threadId;
    if (!threadId) return;
    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) return;
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    this.sessionToCurrentTurn.delete(sessionId);
    // Keep eventStates entry — helpful for debugging, and cleared on
    // stop(). Reset the pending-item map so a next prompt starts clean.
    const state = this.eventStates.get(sessionId);
    if (state) state.items.clear();
    // Bump the thread index's lastTurnAt so age-based pruning (future)
    // sees accurate activity data.
    this.threadIndex.touch(sessionId as string);
    const { stopReason, errorMessage } = translateTurnCompletedEvent(params);
    if (errorMessage) {
      try {
        pending.onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `[turn error] ${errorMessage}` },
        } as unknown as SessionUpdate);
      } catch {
        /* swallow */
      }
    }
    pending.resolve({ stopReason: stopReason as StopReason });
  }

  /** Approval server-request router. Maps the server's method (which
   *  encodes the approval kind · exec vs patch vs permissions) to the
   *  adapter's three entry points defined in Phase 3.A. The request
   *  shape from Codex varies per method; this router extracts the
   *  fields each adapter entry point requires and falls back to
   *  sensible defaults when Codex sends something unexpected. */
  private async routeApproval(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const threadId = typeof p.threadId === 'string' ? p.threadId : undefined;
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
    const sessionKey = sessionId ?? 'unknown';
    const cwd = typeof p.cwd === 'string' ? p.cwd : (this.cwd ?? process.cwd());

    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const command = Array.isArray(p.command) ? (p.command as string[]) : ['<unknown>'];
      const decision = await this.approvalAdapter.onExecPolicyAmendment({
        sessionId: sessionKey,
        command,
        cwd,
        kind: 'exec-policy',
      });
      return buildCodexApprovalResponse(method, decision.approved, { scope: decision.scope });
    }

    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const path = typeof p.path === 'string' ? p.path : '(unknown)';
      const decision = await this.approvalAdapter.onExecPolicyAmendment({
        sessionId: sessionKey,
        command: ['patch', path],
        cwd,
        kind: 'exec-policy',
      });
      return buildCodexApprovalResponse(method, decision.approved, { scope: decision.scope });
    }

    if (method === 'item/permissions/requestApproval') {
      const host = typeof p.host === 'string' ? p.host : '(unspecified)';
      const port = typeof p.port === 'number' ? p.port : undefined;
      const decision = await this.approvalAdapter.onNetworkPolicyAmendment({
        sessionId: sessionKey,
        host,
        port,
        kind: 'network-policy',
      });
      return buildCodexApprovalResponse(method, decision.approved, {
        requestedPermissions: (p.permissions ?? undefined) as Record<string, unknown> | undefined,
      });
    }

    // Fallback · unknown approval-shaped method (defensive — all wired
    // APPROVAL_METHODS are handled above).
    this.log(`unknown approval method ${method} · default decline`);
    return buildCodexApprovalResponse(method, false);
  }

  /** Handle codex's native structured-question server-request
   *  (`item/tool/requestUserInput`). Maps to the generic questionApprover
   *  (which the surface HITL QuestionChannel backs) and maps the answer
   *  back to codex's `{answers: {[id]: {answers: []}}}` shape. When no
   *  approver is wired, auto-picks each question's first option (or empty)
   *  so codex isn't blocked — matching elanous's unattended-default posture. */
  private async routeUserInput(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { threadId?: unknown; questions?: unknown };
    const threadId = typeof p.threadId === 'string' ? p.threadId : undefined;
    const sessionId = (threadId ? this.threadToSession.get(threadId) : undefined) ?? threadId ?? 'unknown';
    const req = mapUserInputToQuestionRequest(params, sessionId);

    if (!this.questionApprover) {
      // No HITL wired — auto-resolve with the first option of each question.
      const resp: AcpQuestionResponse = { answers: {} };
      for (const q of req.questions) {
        if (q.options.length > 0) resp.answers[q.id] = q.options[0]!.label;
      }
      return mapQuestionResponseToUserInput(params, resp);
    }
    try {
      const resp = await this.questionApprover(req);
      return mapQuestionResponseToUserInput(params, resp);
    } catch (err) {
      this.log(`routeUserInput approver threw: ${err instanceof Error ? err.message : String(err)}`);
      return mapQuestionResponseToUserInput(params, { answers: {} });
    }
  }

  private mintSessionId(): SessionId {
    // MSS M1.1 Phase B1 · returns a Tier 2 ElanousUri (`session/<ULID>`)
    // branded as `SessionUri`, cross-cast back to the SDK's `SessionId`
    // string-alias at the wire boundary. The legacy
    // `${SESSION_PREFIX}${seq}` shape is retired — the backend
    // identification it encoded now lives in the session→thread Map
    // structure (plus the thread-index file's backend tag). External
    // ACP peers only require *some* stable string; any existing
    // on-disk session ids from before this change load by raw string
    // and continue to work (no revalidation on resume).
    return mintSessionUri() as unknown as SessionId;
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.client) {
      throw new Error('CodexAppServerAgent not started');
    }
  }
}

/** Thrown by `loadSession` when the supplied session id isn't known
 *  to the disk thread index, or by `ensureSessionResumed` when
 *  `thread/resume` fails against the live daemon (e.g. after a
 *  hibernate that drops server-side history).
 *
 *  Message format intentionally includes "Session not found" so the
 *  shared `isStaleSessionError` predicate (src/acp/turn-runner.ts)
 *  recognizes it as recoverable — `runAcpTurn` then drops + mints
 *  a fresh session instead of surfacing the raw error to the user. */
export class CodexAppServerSessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause?: string) {
    super(
      `codex-app-server: Session not found for ${sessionId}` +
        (cause ? ` · ${cause}` : ''),
    );
    this.name = 'CodexAppServerSessionNotFoundError';
    this.sessionId = sessionId;
  }
}
