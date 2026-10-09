// ACP client — spawns an ACP-speaking subprocess (claude-agent-acp,
// grok, etc.) and exposes a small surface for prompts +
// streaming session updates.
//
// Architecture (matches zed/crates/agent_servers/src/acp.rs:193-280):
//   1. spawn the backend binary with stdio piped
//   2. wrap stdin/stdout in an ndJsonStream from @agentclientprotocol/sdk
//   3. construct a ClientSideConnection — that handles JSON-RPC framing,
//      message routing, and the request/notification split
//   4. our Client implementation receives sessionUpdate notifications
//      and routes them by sessionId to the in-flight prompt's callback
//
// One AcpAgent owns ONE subprocess but can host MANY sessions. The
// session-store layer maps chatId → sessionId so a Telegram or
// Discord chat keeps its conversation across messages.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { getSessionCwd } from '../session/working-dir.js';
import { NESTED_AGENT_ENV_BLOCKLIST } from '../agent/nested-agent-env.js';
import { claudeBackend, geminiBackend, grokBackend } from '../agent-mission/driver.js';
import { debug, redactSecretText } from '../debug/log.js';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type Client,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type SessionId,
  type SessionConfigOption,
  type StopReason,
} from '@agentclientprotocol/sdk';
import { getAcpBackend, type AcpBackendSpec } from './backend-registry.js';
import { grokApiKeyEnvName } from './grok-auth-probe.js';
import { grokAuthHint, isGrokAuthError } from './grok-auth.js';
import { providerEnvKey } from '../llm/provider-credentials.js';
import { getUserConfig } from '../user-config.js';
import {
  AcpForkSessionUnsupportedError,
  AcpListSessionsUnsupportedError,
  AcpLoadSessionUnsupportedError,
  AcpResumeSessionUnsupportedError,
  buildClientDeclaration,
  checkProtocolVersion,
  parsePeerCapabilities,
  type ElanousCapabilities,
} from './capabilities.js';
import type {
  ForkSessionResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  McpServer,
  ResumeSessionResponse,
} from '@agentclientprotocol/sdk';

// Keep the legacy wire shape for consumers and peers that still advertise session models.
interface ModelInfo { modelId: string; name: string }
interface SessionModelState { currentModelId: string; availableModels: ModelInfo[] }

function claudeModelState(options: SessionConfigOption[] | null | undefined): SessionModelState | undefined {
  // claude-agent-acp 0.81.2 publishes its model selector as a config option.
  const model = options?.find(option => option.id === 'model' && option.type === 'select');
  if (!model || model.type !== 'select') return undefined;
  return {
    currentModelId: model.currentValue,
    availableModels: model.options.flatMap(option => 'options' in option ? option.options : [option])
      .map(option => ({ modelId: option.value, name: option.name })),
  };
}

export class AcpAuthRequiredError extends Error {
  readonly backendId: string;
  constructor(backendId: string) {
    super('Claude Code 구독 로그인이 필요합니다 — 터미널에서 `claude /login`');
    this.name = 'AcpAuthRequiredError';
    this.backendId = backendId;
  }
}

export const ACP_UNKNOWN_EXTERNAL_PERFORMER = 'acp-external:unknown';

export function resolveAcpClientTurnPerformer(backendId: string | null | undefined): string {
  return backendId && backendId.trim().length > 0 ? backendId : ACP_UNKNOWN_EXTERNAL_PERFORMER;
}

/** MT3 — Prepare env for a nested elanous (or agent) subprocess. The
 *  child must not inherit the parent's XDG_CONFIG_HOME so its hints/
 *  plugins/allowlist live in a separate directory. Generates a fresh
 *  ELANOUS_SESSION_ID if the caller didn't pin one. The returned object
 *  can be merged over process.env; the blocklist above handles
 *  stripping the parent-only identity vars. */
export function prepareNestedChildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const xdgRoot = overrides['XDG_CONFIG_HOME'] ?? `/tmp/elanous-nested-${process.pid}-${Date.now()}`;
  const sessionId = overrides['ELANOUS_SESSION_ID']
    ?? `nested-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...overrides,
    XDG_CONFIG_HOME: xdgRoot,
    ELANOUS_SESSION_ID: sessionId,
  };
}

/** Per-prompt streaming callback. Called for every SessionUpdate the
 *  agent emits during the turn (text chunks, tool calls, plan
 *  updates, ...). Synchronous so the agent's stream isn't held up
 *  by slow consumers — enqueue + drain in your own code if needed. */
export type AcpUpdateCallback = (update: SessionUpdate) => void;

export const ACP_FRAME_LOG_BODY_LIMIT_BYTES = 8 * 1024;

type AcpFrameDirection = 'outgoing' | 'incoming';

function truncateAcpFrameBody(body: string): { body: string; bodyTruncated: boolean } {
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.byteLength <= ACP_FRAME_LOG_BODY_LIMIT_BYTES) return { body, bodyTruncated: false };

  let end = ACP_FRAME_LOG_BODY_LIMIT_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    body: bytes.subarray(0, end).toString('utf8'),
    bodyTruncated: true,
  };
}

function observeAcpFrame(direction: AcpFrameDirection, frame: Uint8Array): void {
  try {
    const rawBody = new TextDecoder().decode(frame);
    const parsed = JSON.parse(rawBody) as { id?: unknown; method?: unknown };
    const method = typeof parsed.method === 'string' ? parsed.method : null;
    // Authentication notifications may contain an email: never log their raw frame.
    if (direction === 'incoming' && method === '_auth/status_update') return;
    const truncated = truncateAcpFrameBody(redactSecretText(rawBody));
    debug.log('acp.client', 'frame', {
      direction,
      id: parsed.id ?? null,
      method,
      hasMethod: method !== null,
      bytes: frame.byteLength,
      ...truncated,
      parseFailed: false,
    });
  } catch {
    try {
      const truncated = truncateAcpFrameBody(redactSecretText(new TextDecoder().decode(frame)));
      debug.log('acp.client', 'frame', {
        direction,
        id: null,
        method: null,
        hasMethod: false,
        bytes: frame.byteLength,
        ...truncated,
        parseFailed: true,
      });
    } catch {
      // Observation must never interrupt ACP transport.
    }
  }
}

function createAcpFrameObserver(direction: AcpFrameDirection): (chunk: Uint8Array) => void {
  let pending = new Uint8Array(0);
  return (chunk: Uint8Array): void => {
    try {
      const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
      combined.set(pending);
      combined.set(chunk, pending.byteLength);
      let frameStart = 0;
      for (let index = 0; index < combined.byteLength; index += 1) {
        if (combined[index] === 0x0a) {
          const frameEnd = index > frameStart && combined[index - 1] === 0x0d ? index - 1 : index;
          observeAcpFrame(direction, combined.subarray(frameStart, frameEnd));
          frameStart = index + 1;
        }
      }
      pending = combined.slice(frameStart);
    } catch {
      // Observation must never interrupt ACP transport.
    }
  };
}

/** Wrap the streams owned by AcpAgent, observing complete NDJSON frames without
 * changing the bytes or ordering supplied to the ACP SDK. */
export function createObservedAcpStreams(
  writable: WritableStream<Uint8Array>,
  readable: ReadableStream<Uint8Array>,
): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
  const observeOutgoing = createAcpFrameObserver('outgoing');
  const observeIncoming = createAcpFrameObserver('incoming');
  const writer = writable.getWriter();
  return {
    writable: new WritableStream<Uint8Array>({
      async write(chunk): Promise<void> {
        observeOutgoing(chunk);
        await writer.write(chunk);
      },
      async close(): Promise<void> {
        await writer.close();
      },
      async abort(reason): Promise<void> {
        await writer.abort(reason);
      },
    }),
    readable: readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        observeIncoming(chunk);
        controller.enqueue(chunk);
      },
    })),
  };
}

/** Resolved prompt result. `stopReason` mirrors the ACP enum
 *  ('end_turn' | 'cancelled' | 'max_tokens' | ...). */
export interface AcpPromptResult {
  stopReason: StopReason;
}

export interface AcpPermissionApprovalRequest {
  backendId: string;
  sessionId: string;
  title: string;
  kind?: string;
  rawInput?: unknown;
  options: PermissionOption[];
}

export type AcpPermissionApprover = (req: AcpPermissionApprovalRequest) => Promise<boolean>;

/** AU5 — ACP question bridge. Shape of a structured question the
 *  ACP subprocess wants to surface. Mirrors elanous's AskUserQuestion
 *  request (1-3 questions × 2-4 options) so the hosting dashboard
 *  can route directly into the same modal.
 *
 *  Subprocesses that don't emit this shape continue to use the
 *  permission path unchanged — no compatibility break. When they
 *  DO emit it (via either a custom session update or the
 *  request_permission piggyback we detect below), the dashboard
 *  can route through AskUserQuestionResolver (AU4). */
export interface AcpQuestionRequest {
  backendId: string;
  sessionId: string;
  /** 1-3 questions, each with id + header + options. */
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    multiSelect?: boolean;
    includeOther?: boolean;
  }>;
}

export interface AcpQuestionResponse {
  /** id → selected label (single) or array of labels (multiSelect). */
  answers: Record<string, string | string[]>;
  /** Optional free-form responses when the user picked "Other". */
  otherText?: Record<string, string>;
  /** User dismissed without answering — subprocess should treat
   *  this the same as a permission 'cancelled'. */
  cancelled?: boolean;
}

export type AcpQuestionApprover = (req: AcpQuestionRequest) => Promise<AcpQuestionResponse>;

interface PendingSession {
  onUpdate: AcpUpdateCallback;
  agentChars: number;
}

interface AcpAuthEnvObservation {
  authEnvPresent: boolean;
  authEnvName: string | null;
}

interface AcpBillingEnvScrubObservation {
  billingEnvScrubEnabled: boolean;
  scrubbedBillingEnv: string[];
  forcedBillingEnv: string[];
}

function acpBillingEnvByBackend(): Readonly<Record<string, readonly string[]>> {
  return {
    claude: claudeBackend.scrubEnv ?? [],
    gemini: geminiBackend.scrubEnv ?? [],
    grok: grokBackend.scrubEnv ?? [],
  };
}

const ACP_FORCED_BILLING_ENV_BY_BACKEND: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  grok: { GROK_DISABLE_API_KEY_AUTH: '1' },
};

function scrubAcpBillingEnv(spec: AcpBackendSpec, env: NodeJS.ProcessEnv): AcpBillingEnvScrubObservation {
  const billingEnvScrubEnabled = spec.id === 'claude' || getUserConfig().acp.scrubBillingEnv !== false;
  const scrubbedBillingEnv: string[] = [];
  const forcedBillingEnv: string[] = [];
  if (billingEnvScrubEnabled) {
    for (const key of acpBillingEnvByBackend()[spec.id] ?? []) {
      if (key in env) {
        delete env[key];
        scrubbedBillingEnv.push(key);
      }
    }
    for (const [key, value] of Object.entries(ACP_FORCED_BILLING_ENV_BY_BACKEND[spec.id] ?? {})) {
      if (!(key in env)) {
        env[key] = value;
        forcedBillingEnv.push(key);
      }
    }
  }
  return { billingEnvScrubEnabled, scrubbedBillingEnv, forcedBillingEnv };
}

function observeAcpAuthEnv(spec: AcpBackendSpec, env: NodeJS.ProcessEnv): AcpAuthEnvObservation {
  const authEnvName = spec.id === 'grok'
    ? grokApiKeyEnvName(env)
    : providerEnvKey(spec.id === 'claude' ? 'anthropic' : spec.id) ?? spec.requiresEnv ?? null;
  return {
    authEnvPresent: authEnvName !== null && Boolean(env[authEnvName]),
    authEnvName: authEnvName !== null && env[authEnvName] ? authEnvName : null,
  };
}

function agentUpdateChars(update: SessionUpdate): number {
  return update.sessionUpdate === 'agent_message_chunk'
    && update.content.type === 'text'
    ? update.content.text.length
    : 0;
}

export interface AcpClientInfo {
  name: string;
  version: string;
}

export type AcpPackageMetadataReader = () => unknown;

const DEFAULT_CLIENT_INFO: AcpClientInfo = { name: 'elanous', version: '0.0.0' };

function readOwnPackageMetadata(): unknown {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
}

export function readClientInfo(
  readPackageMetadata: AcpPackageMetadataReader = readOwnPackageMetadata,
): AcpClientInfo {
  try {
    const metadata = readPackageMetadata();
    if (typeof metadata !== 'object' || metadata === null) return DEFAULT_CLIENT_INFO;
    const { name, version } = metadata as { name?: unknown; version?: unknown };
    return {
      name: typeof name === 'string' && name.length > 0 ? name : DEFAULT_CLIENT_INFO.name,
      version: typeof version === 'string' && version.length > 0 ? version : DEFAULT_CLIENT_INFO.version,
    };
  } catch {
    return DEFAULT_CLIENT_INFO;
  }
}

export interface AcpAgentOpts {
  /** Backend id from ACP_BACKENDS. */
  backendId: string;
  /** Review-owned ACP executable override; never changes the shared backend registry. */
  backendSpec?: AcpBackendSpec;
  /** Working directory the agent runs in (cwd argument to spawn).
   *  Affects file-tool resolution. Default: getSessionCwd() so a
   *  Ctrl+W / /wd in the dashboard retargets new ACP agents. */
  cwd?: string;
  /** Extra env vars to pass to the subprocess. Inherits from
   *  process.env unless overridden. */
  env?: Record<string, string>;
  /** Test seam: replace the child process without launching Claude. */
  spawnChild?: typeof spawn;
  /** Session-scoped Codex app-server configuration arguments. Ignored by
   *  non-Codex ACP backends. */
  codexArgs?: readonly string[];
  /** Logger — wired from elanous's debug.log when running inside the
   *  bot, or console.error when running standalone. Receives both
   *  ACP-level events and stderr lines from the subprocess. */
  log?: (msg: string) => void;
  /** Called after a successful initialize negotiation with the normalized
   *  peer capability snapshot. Observers must not affect ACP operation. */
  onCapabilities?: (capabilities: ElanousCapabilities) => void;
  /** Optional UI bridge for ACP session/request_permission. When
   *  omitted, sensitive tool calls are cancelled by default. */
  permissionApprover?: AcpPermissionApprover;
  /** AU5 — optional UI bridge for structured user questions emitted
   *  by the subprocess. When omitted, questions detected inside a
   *  request_permission call fall back to the permission approver
   *  (i.e. degrade gracefully as yes/no). */
  questionApprover?: AcpQuestionApprover;
}

function isUnsupportedSteerMethodError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return /method[ _-]?not[ _-]?found|unknown method|-32601/i.test(String(error));
  }
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    data?: { details?: unknown };
  };
  if (candidate.code === -32601) return true;
  const details = candidate.data?.details;
  const diagnostic = [candidate.message, details]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /method[ _-]?not[ _-]?found|unknown method|-32601/i.test(diagnostic);
}

export class AcpAgent {
  private readonly spec: AcpBackendSpec;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnChild: typeof spawn;
  private readonly billingEnvScrub: AcpBillingEnvScrubObservation;
  private readonly log: (msg: string) => void;
  private readonly onCapabilities: ((capabilities: ElanousCapabilities) => void) | undefined;
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private connection: ClientSideConnection | null = null;
  private readonly pendingBySession = new Map<SessionId, PendingSession>();
  /** Per-session model catalog captured from `session/new` (Claude configOptions
   *  or the legacy model extension). Lets callers pick a model tier via
   *  `selectSessionModel`. Empty when the backend doesn't advertise models. */
  private readonly sessionModels = new Map<SessionId, SessionModelState>();
  private initialized = false;
  private permissionApprover: AcpPermissionApprover | null;
  private questionApprover: AcpQuestionApprover | null;
  /** H2 #4 — peer capability snapshot captured from initialize
   *  response. Null until start() completes. Consumers call
   *  `getCapabilities()` to feature-gate without plumbing the raw
   *  AgentCapabilities blob through every layer. */
  private peerCapabilities: ElanousCapabilities | null = null;
  private authMethods: string[] = [];

  constructor(opts: AcpAgentOpts) {
    this.spec = opts.backendSpec ?? getAcpBackend(opts.backendId);
    // WD7 — default to the session working directory; ACP agents
    // inherit the "active project" concept.
    this.cwd = opts.cwd ?? getSessionCwd();
    // Inherit env, then strip any flags that would confuse a child
    // ACP agent. CLAUDECODE / CLAUDE_CODE_* indicate the parent
    // process is already a Claude Code session; the child may
    // refuse to start nested ("nested sessions share runtime
    // resources and will crash all active sessions"). Same problem
    // hits anyone running elanous inside a `claude` terminal — strip
    // proactively. Mirrors zed's env-strip pattern for provider
    // tokens (acp.rs:232-243), generalized here for any env that
    // breaks nested agents.
    const cleanEnv: NodeJS.ProcessEnv = opts.backendSpec && opts.env ? { ...opts.env, NODE_ENV: process.env.NODE_ENV } : { ...process.env, ...opts.env };
    for (const key of Object.keys(cleanEnv)) {
      if (NESTED_AGENT_ENV_BLOCKLIST.has(key) || /^CLAUDE_CODE_/.test(key)) {
        delete cleanEnv[key];
      }
    }
    this.billingEnvScrub = scrubAcpBillingEnv(this.spec, cleanEnv);
    this.env = cleanEnv;
    this.spawnChild = opts.spawnChild ?? spawn;
    this.log = opts.log ?? ((m) => console.error(`[acp:${this.spec.id}] ${m}`));
    this.onCapabilities = opts.onCapabilities;
    this.permissionApprover = opts.permissionApprover ?? null;
    this.questionApprover = opts.questionApprover ?? null;
  }

  setPermissionApprover(approver?: AcpPermissionApprover): void {
    this.permissionApprover = approver ?? null;
  }

  setQuestionApprover(approver?: AcpQuestionApprover): void {
    this.questionApprover = approver ?? null;
  }

  /** Spawn the subprocess + run the ACP initialize handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.initialized) return;

    // Resolve the binary via the local node_modules/.bin so we don't
    // depend on the user's PATH containing it. The binary is shipped
    // with the npm package we bundled.
    const resolvedBin = this.resolveBinPath();
    const spawnEvent = {
      backendId: this.spec.id,
      bin: resolvedBin.path,
      cwd: this.cwd,
      ...this.billingEnvScrub,
      ...observeAcpAuthEnv(this.spec, this.env),
    };
    const billingEnvMode = this.billingEnvScrub.billingEnvScrubEnabled ? 'subscription' : 'billing-env preserved';
    const scrubbedBillingEnv = this.billingEnvScrub.scrubbedBillingEnv.join(',') || 'none';
    const forcedBillingEnv = this.billingEnvScrub.forcedBillingEnv.join(',') || 'none';
    this.log(`spawning ${resolvedBin.path} ${this.spec.args.join(' ')} (path=${resolvedBin.path}, reason=${resolvedBin.reason}, billing-env=${billingEnvMode}, scrubbed=${scrubbedBillingEnv}, forced=${forcedBillingEnv})`);
    // A missing cwd makes posix_spawn fail with a MISLEADING ENOENT
    // that blames the binary — reject with the real cause up front.
    if (this.cwd && !existsSync(this.cwd)) {
      debug.log('acp.client', 'spawn', { ...spawnEvent, success: false });
      throw new Error(`acp spawn: cwd does not exist: ${this.cwd}`);
    }

    if (this.spec.id === 'claude') {
      const remaining = (claudeBackend.scrubEnv ?? []).filter(key => key in this.env);
      debug.log('acp.claude', 'auth-source', {
        apiKeyPresent: remaining.length > 0,
        source: remaining.length > 0 ? 'billing-env' : 'subscription',
      });
      if (remaining.length > 0 && process.env.NODE_ENV !== 'test' && !process.env.ELANOUS_TEST_HOME) {
        throw new Error('ACP Claude refused: billing authentication environment remains after scrub');
      }
    }

    const child = this.spawnChild(resolvedBin.path, this.spec.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    // spawn() reports launch failures (ENOENT bin/cwd, EACCES) as an
    // ASYNC 'error' event — without a listener it becomes an uncaught
    // exception that kills the WHOLE host process (2026-07-12: a
    // discord NL-delegate with a not-yet-created cwd took down the
    // messenger runner). Fail the start() await instead, and keep the
    // listener attached so late errors only log.
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        debug.log('acp.client', 'spawn', { ...spawnEvent, success: true });
        resolve();
      });
      child.once('error', (err: Error) => {
        debug.log('acp.client', 'spawn', { ...spawnEvent, success: false, error: redactSecretText(err.message) });
        reject(new Error(`acp spawn failed: ${err.message}`));
      });
    });
    child.on('error', (err: Error) => {
      this.log(`subprocess error: ${err.message}`);
      this.proc = null;
      this.connection = null;
      this.initialized = false;
    });
    await spawned;

    // Stderr from the agent is opaque text — log it so the operator
    // sees errors from the subprocess (auth, network, etc.) without
    // having to attach a debugger.
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.log(`stderr: ${line}`);
      }
    });
    child.on('exit', (code, signal) => {
      this.log(`subprocess exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.connection = null;
      this.initialized = false;
    });

    // Convert Node streams to Web Streams the SDK expects. Bun has
    // these on the prototype; Node 18+ via .toWeb() helpers. The
    // SDK types the stream as `ReadableStream<Uint8Array>`, but
    // Node's toWeb() returns a generic ReadableStream<any>. At
    // runtime the chunks are always Uint8Array, so double-casting
    // through `unknown` is the correct TS escape hatch.
    const nodeWritable = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const nodeReadable = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const { writable, readable } = createObservedAcpStreams(nodeWritable, nodeReadable);
    const stream = ndJsonStream(writable, readable);

    this.connection = new ClientSideConnection(
      (_agent: Agent): Client => this.buildClient(),
      stream,
    );

    // Initialize handshake. We advertise no fs or terminal RPC capability.
    // Claude receives terminal auth support so it can advertise login methods;
    // elanous only provides a CLI hint and never executes the login. The agent
    // will refuse to use filesystem tools, which is fine for P1
    // smoke tests. P3 will add fs callbacks for real coding tasks.
    // ACP backends such as Codex require clientInfo, so identify this
    // package while retaining a safe startup path outside npm metadata.
    const clientInfo = readClientInfo();
    this.log(`initializing — clientInfo name=${clientInfo.name} version=${clientInfo.version}`);
    const response = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo,
      clientCapabilities: this.spec.id === 'claude'
        ? { ...buildClientDeclaration(), auth: { terminal: true } }
        : buildClientDeclaration(),
    });
    // H2 #4 — fail loudly on protocol-version mismatch instead of
    // silently proceeding. Message points at the upgrade path.
    const versionErr = checkProtocolVersion(PROTOCOL_VERSION, response.protocolVersion);
    if (versionErr) throw versionErr;
    this.authMethods = this.spec.id === 'claude'
      ? (response.authMethods?.map(({ id }) => id) ?? [])
        .filter((id) => id === 'claude-login' || id === 'claude-ai-login')
      : [];
    this.recordCapabilities(response.agentCapabilities, response.protocolVersion);
    this.initialized = true;
  }

  /** Captures the normalized peer state, then emits an isolated immutable
   *  observer snapshot. Observer failures and mutation attempts must not
   *  alter ACP capability gates or interrupt a completed negotiation. */
  private recordCapabilities(
    agentCapabilities: Parameters<typeof parsePeerCapabilities>[0],
    protocolVersion: Parameters<typeof parsePeerCapabilities>[1],
  ): void {
    const capabilities = parsePeerCapabilities(agentCapabilities, protocolVersion);
    this.peerCapabilities = capabilities;
    const snapshot: ElanousCapabilities = {
      ...capabilities,
      prompt: { ...capabilities.prompt },
      session: { ...capabilities.session },
      mcp: { ...capabilities.mcp },
      fileOps: { ...capabilities.fileOps },
      ui: { ...capabilities.ui },
      term: { ...capabilities.term },
      ask: { ...capabilities.ask },
    };
    Object.freeze(snapshot.prompt);
    Object.freeze(snapshot.session);
    Object.freeze(snapshot.mcp);
    Object.freeze(snapshot.fileOps);
    Object.freeze(snapshot.ui);
    Object.freeze(snapshot.term);
    Object.freeze(snapshot.ask);
    Object.freeze(snapshot);
    try {
      this.onCapabilities?.(snapshot);
    } catch (error) {
      // ⛔ `throw null` 같은 비-Error 예외에서 `.message` 를 읽으면 «관측 실패가 런을 죽인다».
      //    관측은 결론을 막지 않는다(리뷰 should-fix ② · 2026-08-06).
      this.log(`capability observer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.log(`initialized — agent protocol ${capabilities.protocolVersion}, ` +
      `caps: image=${capabilities.prompt.image} ` +
      `audio=${capabilities.prompt.audio} ` +
      `loadSession=${capabilities.loadSession} ` +
      `session.fork=${capabilities.session.fork} ` +
      `session.list=${capabilities.session.list} ` +
      `session.resume=${capabilities.session.resume} ` +
      `mcp.http=${capabilities.mcp.http} ` +
      `mcp.sse=${capabilities.mcp.sse}`);
    debug.log('acp.client', 'initialized', {
      protocolVersion: capabilities.protocolVersion,
      image: capabilities.prompt.image,
      audio: capabilities.prompt.audio,
      loadSession: capabilities.loadSession,
      session: capabilities.session,
      mcp: capabilities.mcp,
    });
  }

  /** H2 #4 — peer capability snapshot. Null before start() completes,
   *  non-null after. Consumers (skill-tool, session-persistence,
   *  background-agent) feature-gate against this instead of re-parsing
   *  the wire response. */
  getCapabilities(): ElanousCapabilities | null {
    return this.peerCapabilities;
  }


  /** H2 #5 — resume a previously-minted session by calling the ACP
   *  `session/load` RPC. Gated by the peer's advertised
   *  `AgentCapabilities.loadSession`; throws
   *  `AcpLoadSessionUnsupportedError` when the peer didn't advertise
   *  support. `cwd` defaults to the agent's configured cwd; callers
   *  pass the session's original cwd from the persisted record so
   *  agent-side file tooling resolves correctly.
   *
   *  Capability advertisement at the protocol level varies per pinned
   *  backend. Tier 1 S1 (2026-04-27) verified that claude-code-acp
   *  0.16.2 advertises `loadSession: true` (acp-agent.js:73) — the
   *  earlier "all advertise false" comment in this slot drifted. The
   *  backend may still reject any concrete sessionId at runtime when
   *  the SDK can't restore the conversation, so callers handle the
   *  rejection separately (see DashboardAcpChat's stale-session
   *  recovery branch). codex-acp 0.11.1 and gemini-cli 0.38.0 still
   *  advertise loadSession: false at the time of this comment.
   */
  async loadSession(req: {
    sessionId: SessionId;
    cwd?: string;
    mcpServers?: McpServer[];
  }): Promise<LoadSessionResponse> {
    if (!this.connection) throw new Error('AcpAgent not started');
    if (!this.peerCapabilities?.loadSession) {
      throw new AcpLoadSessionUnsupportedError(this.spec.id);
    }
    return this.connection.loadSession({
      sessionId: req.sessionId,
      cwd: req.cwd ?? this.cwd,
      mcpServers: req.mcpServers ?? [],
    });
  }

  /** Resume an existing session without returning its previous messages.
   * The unstable SDK call is intentionally isolated here and is only reached
   * after the peer advertised the corresponding session capability. */
  async resumeSession(req: {
    sessionId: SessionId;
    cwd?: string;
    mcpServers?: McpServer[];
  }): Promise<ResumeSessionResponse> {
    if (!this.connection) throw new Error('AcpAgent not started');
    if (!this.peerCapabilities?.session.resume) {
      throw new AcpResumeSessionUnsupportedError(this.spec.id);
    }
    debug.log('acp.client', 'session-resume', { sessionId: req.sessionId });
    return this.connection.resumeSession({
      sessionId: req.sessionId,
      cwd: req.cwd ?? this.cwd,
      mcpServers: req.mcpServers ?? [],
    });
  }

  /** Fork an existing session into a distinct session without modifying the
   * original history. The unstable SDK call is isolated here and only reached
   * after the peer advertised the corresponding session capability. */
  async forkSession(req: {
    sessionId: SessionId;
    cwd?: string;
    mcpServers?: McpServer[];
  }): Promise<ForkSessionResponse> {
    if (!this.connection) throw new Error('AcpAgent not started');
    if (!this.peerCapabilities?.session.fork) {
      throw new AcpForkSessionUnsupportedError(this.spec.id);
    }
    debug.log('acp.client', 'session-fork', { sessionId: req.sessionId });
    return this.connection.unstable_forkSession({
      sessionId: req.sessionId,
      cwd: req.cwd ?? this.cwd,
      mcpServers: req.mcpServers ?? [],
    });
  }

  /** Return one cursor-addressable page of the peer's sessions. The caller
   * follows `nextCursor` when it needs additional pages. */
  async listSessions(req: { cursor?: string; cwd?: string } = {}): Promise<ListSessionsResponse> {
    if (!this.connection) throw new Error('AcpAgent not started');
    if (!this.peerCapabilities?.session.list) {
      throw new AcpListSessionsUnsupportedError(this.spec.id);
    }
    const response = await this.connection.listSessions({
      cursor: req.cursor,
      cwd: req.cwd ?? this.cwd,
    });
    debug.log('acp.client', 'session-list', {
      hasCursor: req.cursor !== undefined,
      sessionCount: response.sessions.length,
    });
    return response;
  }

  /** Begin a new session in the configured cwd. Returns the agent-
   *  assigned sessionId — caller stores this for follow-up turns. */
  async newSession(): Promise<SessionId> {
    if (!this.connection) throw new Error('AcpAgent not started');
    let response;
    try {
      response = await this.connection.newSession({
        cwd: this.cwd,
        mcpServers: [],
      });
    } catch (error) {
      if (this.spec.id === 'claude'
        && (this.authMethods.includes('claude-login') || this.authMethods.includes('claude-ai-login'))
        && error instanceof RequestError
        && error.code === RequestError.authRequired().code) {
        debug.log('acp.client', 'auth-required', { backendId: this.spec.id, methods: this.authMethods });
        throw new AcpAuthRequiredError(this.spec.id);
      }
      throw error;
    }
    // Claude's model selector is a config option; other peers may still use
    // the legacy models extension. Keep their behavior unchanged.
    const models = this.spec.id === 'claude'
      ? claudeModelState(response.configOptions)
      : (response as typeof response & { models?: SessionModelState }).models;
    if (models) this.sessionModels.set(response.sessionId, models);
    this.log(`new session ${response.sessionId}`);
    debug.log('acp.client', 'session-new', { sessionId: response.sessionId });
    return response.sessionId;
  }

  /** Model catalog for a session (available models + current), or undefined
   *  when the backend didn't advertise model selection. */
  getSessionModels(sessionId: SessionId): SessionModelState | undefined {
    return this.sessionModels.get(sessionId);
  }

  /** Set the active model for a session by concrete modelId (raw primitive).
   *  Claude uses `session/set_config_option`; other peers retain their
   *  existing UNSTABLE `session/set_model` extension. */
  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    if (!this.connection) throw new Error('AcpAgent not started');
    if (this.spec.id === 'claude') {
      const response = await this.connection.setSessionConfigOption({ sessionId, configId: 'model', value: modelId });
      const models = claudeModelState(response.configOptions);
      if (models) this.sessionModels.set(sessionId, models);
    } else {
      await this.connection.extMethod('session/set_model', { sessionId, modelId });
      const state = this.sessionModels.get(sessionId);
      if (state) this.sessionModels.set(sessionId, { ...state, currentModelId: modelId });
    }
  }

  /** Select a session model by a tier alias (e.g. "opus"/"sonnet"/"haiku").
   *  Resolves against the session's advertised models with a lenient
   *  includes-match, then applies it. Returns the picked model, or null when
   *  no model matched or the backend advertises none / rejects the change —
   *  callers stay on the backend default in that case rather than failing hard. */
  async selectSessionModel(sessionId: SessionId, alias: string): Promise<ModelInfo | null> {
    const state = this.sessionModels.get(sessionId);
    if (!state || state.availableModels.length === 0) return null;
    const q = alias.trim().toLowerCase();
    const pick = state.availableModels.find((m) =>
      m.modelId.toLowerCase() === q ||
      m.modelId.toLowerCase().includes(q) ||
      m.name.toLowerCase() === q ||
      m.name.toLowerCase().includes(q),
    );
    if (!pick) return null;
    if (pick.modelId === state.currentModelId) return pick; // already active
    try { await this.setSessionModel(sessionId, pick.modelId); }
    catch (e) { this.log(`${this.spec.id === 'claude' ? 'model selection' : 'set_model'} failed (${(e as Error).message}) — staying on default`); return null; }
    return pick;
  }

  /** Send a prompt for an existing session and wait for the turn to
   *  resolve. `onUpdate` receives each session update (text chunk,
   *  tool call, etc.) as it arrives — stream into your UI from there.
   *
   *  Follow-up #4 — `meta` rides the ACP `PromptRequest._meta` field so
   *  peers that speak the Zed subagent-meta extension (or any other
   *  `_meta`-based extension) can auto-recognize. Omit when no
   *  extension data is being forwarded. */
  async prompt(
    sessionId: SessionId,
    blocks: ContentBlock[],
    onUpdate: AcpUpdateCallback,
    meta?: Record<string, unknown>,
  ): Promise<AcpPromptResult> {
    if (!this.connection) throw new Error('AcpAgent not started');
    if (this.pendingBySession.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a turn in flight`);
    }
    const chars = blocks.reduce((total, block) => total + ('text' in block && typeof block.text === 'string' ? block.text.length : 0), 0);
    const startedAt = Date.now();
    this.pendingBySession.set(sessionId, { onUpdate, agentChars: 0 });
    debug.log('acp.client', 'prompt-start', { sessionId, chars });
    try {
      const req: { sessionId: SessionId; prompt: ContentBlock[]; _meta?: Record<string, unknown> } = {
        sessionId,
        prompt: blocks,
      };
      if (meta !== undefined) req._meta = meta;
      const response = await this.connection.prompt(req);
      debug.log('acp.client', 'prompt-end', {
        sessionId,
        stopReason: response.stopReason,
        durationMs: Date.now() - startedAt,
        agentChars: this.pendingBySession.get(sessionId)?.agentChars ?? 0,
        performer: resolveAcpClientTurnPerformer(this.spec.id),
      });
      return { stopReason: response.stopReason };
    } catch (error) {
      // grok 구독 OAuth 만료는 «일반 실패처럼» 올라온다 — 문면만 보면 사용자가
      // 자기 프롬프트를 의심한다. 백엔드가 grok 일 때만 감지해서 실행 가능한
      // 한 줄을 잇는다. ⛔ 여기서 `grok login` 을 «자동으로 띄우지 않는다** —
      // 턴 도중에 브라우저를 여는 것은 침습적이라 codex 의 실배선
      // (codex-app-server-agent.ts:1457)도 힌트만 낸다. 실제 로그인 구동은
      // 사용자가 부르는 `elanous acp login grok` 이 소유한다.
      const grokAuthFailure = this.spec.id === 'grok' && isGrokAuthError(error);
      debug.log('acp.client', 'prompt-failed', {
        sessionId,
        durationMs: Date.now() - startedAt,
        agentChars: this.pendingBySession.get(sessionId)?.agentChars ?? 0,
        error: redactSecretText(error instanceof Error ? error.message : String(error)),
        ...(grokAuthFailure ? { authFailure: 'grok-oauth' } : {}),
      });
      if (grokAuthFailure) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(`${original} · ${grokAuthHint()}`, { cause: error });
      }
      // claude-agent-acp may create a session before Claude Code checks the
      // saved login. The same authRequired rejection can arrive on prompt.
      if (this.spec.id === 'claude'
        && (this.authMethods.includes('claude-login') || this.authMethods.includes('claude-ai-login'))
        && error instanceof RequestError
        && error.code === RequestError.authRequired().code) {
        debug.log('acp.client', 'auth-required', { backendId: this.spec.id, methods: this.authMethods });
        throw new AcpAuthRequiredError(this.spec.id);
      }
      throw error;
    } finally {
      this.pendingBySession.delete(sessionId);
    }
  }

  /** Inject text blocks into a live elanous ACP turn when the peer supports
   *  the elanous/session/steer extension. */
  async steer(sessionId: SessionId, blocks: readonly ContentBlock[]): Promise<boolean> {
    if (!this.connection) return false;
    const text = blocks
      .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
        'text' in block && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (text.trim().length === 0) return false;
    try {
      const response = await this.connection.extMethod('elanous/session/steer', { sessionId, text }) as {
        accepted?: unknown;
      };
      return response?.accepted === true;
    } catch (error) {
      if (!isUnsupportedSteerMethodError(error)) throw error;
      debug.log('acp.steer', 'unsupported', { sessionId });
      return false;
    }
  }

  /** Cancel an in-flight turn. Notifies the agent; the corresponding
   *  prompt() resolves with stopReason='cancelled'. */
  async cancel(sessionId: SessionId): Promise<void> {
    if (!this.connection) return;
    await this.connection.cancel({ sessionId });
  }

  /** Kill the subprocess + close the connection. After stop(), the
   *  agent must be start()ed again before further calls. */
  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.connection = null;
    this.initialized = false;
    this.authMethods = [];
    this.pendingBySession.clear();
  }

  private buildClient(): Client {
    return {
      // Routes session updates to the per-session callback. If the
      // update arrives outside any pending prompt window (rare —
      // usually agent-initiated state updates), drop it with a log.
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const pending = this.pendingBySession.get(params.sessionId);
        if (!pending) {
          this.log(`session update for ${params.sessionId} with no pending turn — dropping`);
          return;
        }
        try {
          pending.agentChars += agentUpdateChars(params.update);
          pending.onUpdate(params.update);
        } catch (err: any) {
          this.log(`onUpdate handler threw: ${err?.message ?? err}`);
        }
      },

      extNotification: async (method, params): Promise<void> => {
        try {
          if (this.spec.id === 'claude' && method === '_auth/status_update') {
            const status = params.authStatus;
            if (status && typeof status === 'object' && 'kind' in status
              && ['account', 'api_key', 'gateway', 'external', 'none'].includes(String(status.kind))) {
              debug.log('acp.client', 'auth-status', { backendId: this.spec.id, kind: status.kind });
            }
            return;
          }
          debug.log('acp.client', 'ext-notification', {
            backendId: this.spec.id,
            method,
            paramsBytes: Buffer.byteLength(JSON.stringify(params), 'utf8'),
          });
        } catch {
          // Observation must not reject a vendor notification.
        }
      },

      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const title = params.toolCall.title ?? 'ACP tool call';

        // AU5 — detect a structured question piggybacked on the
        // permission request. Subprocesses that emit toolCall.kind
        // === 'ask-user-question' (OR set rawInput.__elanousQuestion:
        // true with a questions array) route through the dashboard's
        // AskUserQuestion modal instead of a yes/no prompt. Graceful
        // fallback to the normal permission flow if the question
        // approver is unwired or detection doesn't trigger.
        const questionReq = extractAcpQuestion(params, this.spec.id);
        if (questionReq && this.questionApprover) {
          try {
            const answer = await this.questionApprover(questionReq);
            if (answer.cancelled) return { outcome: { outcome: 'cancelled' } };
            // Map the selected label to an ACP option id so the
            // subprocess sees a normal "selected" outcome even though
            // the UI was a richer question. We pick the first allow-
            // ish option (AU4-style best-effort).
            const picked = chooseAcpPermissionOption(params.options, true);
            if (!picked) return { outcome: { outcome: 'cancelled' } };
            return { outcome: { outcome: 'selected', optionId: picked } };
          } catch (err: any) {
            this.log(`AU5 question approver threw: ${err?.message ?? err} — falling back to permission approver`);
            // fall through
          }
        }

        const approver = this.permissionApprover;
        if (!approver) {
          this.log(`auto-cancelling permission for ${JSON.stringify(title)} — no permission approver configured`);
          return { outcome: { outcome: 'cancelled' } };
        }
        const approved = await approver({
          backendId: this.spec.id,
          sessionId: params.sessionId,
          title,
          kind: params.toolCall.kind ?? undefined,
          rawInput: params.toolCall.rawInput,
          options: params.options,
        });
        const optionId = chooseAcpPermissionOption(params.options, approved);
        if (!optionId) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId } };
      },

      // Filesystem + terminal capabilities are NOT advertised in
      // initialize(), so the agent shouldn't call these. Defensive
      // implementations included to satisfy the interface; both
      // refuse with a clear error.
      readTextFile: async () => {
        throw new Error('fs.readTextFile not supported by this client');
      },
      writeTextFile: async () => {
        throw new Error('fs.writeTextFile not supported by this client');
      },
    };
  }

  private resolveBinPath(): { path: string; reason: 'configured' | 'configured-missing' | 'default' } {
    const configuredPath = getUserConfig().acp.binaryPaths?.[this.spec.id];
    if (configuredPath) {
      return {
        path: configuredPath,
        reason: existsSync(configuredPath) ? 'configured' : 'configured-missing',
      };
    }

    // node_modules/.bin/<command> is what npm/bun symlinks. Resolve
    // from process.cwd() upward to handle monorepo layouts.
    const candidates = [
      `${process.cwd()}/node_modules/.bin/${this.spec.command}`,
      // Fallback: search up to repo root by looking for our own
      // package's node_modules. Not exhaustive but covers the
      // typical install layouts (root + workspaces).
      `${import.meta.dir}/../../node_modules/.bin/${this.spec.command}`,
      // Extra spec-provided candidates (e.g. grok's `~/.grok/bin/grok`
      // from xAI install.sh · outside node_modules layout). Expand
      // leading `~` to homedir.
      ...(this.spec.extraBinCandidates ?? []).map((p) =>
        p.startsWith('~/')
          ? `${require('node:os').homedir()}/${p.slice(2)}`
          : p,
      ),
    ];
    for (const p of candidates) {
      try {
        // Bun has Bun.file().exists(), Node has fs.existsSync — both
        // are sync and fast. Use require('node:fs').existsSync for
        // portability.
        const fs = require('node:fs') as typeof import('node:fs');
        if (fs.existsSync(p)) return { path: p, reason: 'default' };
      } catch { /* keep searching */ }
    }
    // Last resort: rely on PATH. Lets the user globally install the
    // backend (`bun add -g @agentclientprotocol/claude-agent-acp`).
    return { path: this.spec.command, reason: 'default' };
  }
}

export function chooseAcpPermissionOption(options: PermissionOption[], approved: boolean): string | null {
  const preferredKinds = approved
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  for (const kind of preferredKinds) {
    const option = options.find(o => o.kind === kind);
    if (option) return option.optionId;
  }
  return null;
}

/** AU5 — heuristic: detect a structured question piggybacked on
 *  a request_permission call. Two signal paths:
 *    1. `toolCall.kind === 'ask-user-question'` (future-standard name)
 *    2. `toolCall.rawInput.__elanousQuestion === true` with a
 *       `questions: [...]` array (opt-in extension)
 *  Returns null when neither matches. Stays side-effect-free so the
 *  normal permission path is unchanged when ACP subprocesses don't
 *  speak this extension. Exported for tests + the dashboard adapter. */
export function extractAcpQuestion(
  params: RequestPermissionRequest,
  backendId: string,
): AcpQuestionRequest | null {
  const kind = String(params.toolCall.kind ?? '');
  const raw = params.toolCall.rawInput as { __elanousQuestion?: boolean; questions?: unknown } | undefined;

  const hasKind = kind === 'ask-user-question' || kind === 'ask_user_question';
  const hasMarker = !!(raw && raw.__elanousQuestion === true);
  if (!hasKind && !hasMarker) return null;

  const arr = raw && Array.isArray(raw.questions) ? raw.questions : null;
  if (!arr || arr.length === 0) return null;

  // Shallow-copy with defensive picks so a malformed question from
  // the subprocess can't crash our modal.
  const questions: AcpQuestionRequest['questions'] = [];
  for (const q of arr as Array<Record<string, unknown>>) {
    if (!q || typeof q !== 'object') continue;
    const id = typeof q.id === 'string' && q.id ? q.id : `q${questions.length + 1}`;
    const header = typeof q.header === 'string'
      ? q.header.length > 12
        ? `${q.header.slice(0, q.header.charCodeAt(10) >= 0xd800 && q.header.charCodeAt(10) <= 0xdbff && q.header.charCodeAt(11) >= 0xdc00 && q.header.charCodeAt(11) <= 0xdfff ? 10 : 11)}…`
        : q.header
      : 'Choice';
    if (typeof q.header === 'string' && q.header.length > 12) {
      debug.log('acp.client', 'question-header-truncated', {
        originalLength: q.header.length,
        retainedLength: header.length,
      });
    }
    const question = typeof q.question === 'string' ? q.question : '(no question text)';
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>)
          .filter(o => o && typeof o.label === 'string')
          .map(o => ({
            label: String(o.label),
            description: typeof o.description === 'string' ? o.description : '',
            preview: typeof o.preview === 'string' ? o.preview : undefined,
          }))
          .slice(0, 4)
      : [];
    if (options.length < 2) continue;  // skip ill-formed
    questions.push({
      id,
      header,
      question,
      options,
      multiSelect: !!q.multiSelect,
      includeOther: q.includeOther !== false,
    });
  }
  if (questions.length === 0) return null;

  return {
    backendId,
    sessionId: params.sessionId,
    questions: questions.slice(0, 3),
  };
}
