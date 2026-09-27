// MVP M1.3 — Headless daemon runtime helper.
//
// Provides a minimal `runTurn` for `bootAcpServer` so the daemon can
// answer real LLM prompts (not just echo). Scope: text-only chat, no
// tool dispatch (tools = []), per-session history. M1.5 A.1 added
// optional disk-backed persistence (jsonl per session) so daemon
// restarts don't drop history; opt-in via `diskDir` constructor opt
// or `ELANOUS_HISTORY_DIR` env var.
//
// Follow-up (M1.5 A.2 / A.3):
//   - A.2 — read-only tool surface (Read · Grep · WebSearch)
//   - A.3 — flip dashboard default to daemon attach (currently in-process)
//   - Long-running ACP backends spawned by the daemon for fan-out
//
// The module is headless-guard-compliant (no dashboard / chat / pty
// imports). The `headless-core-guard` test enforces this.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join as joinPath } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  bridgeCoreTurnToAcp,
  extractLastAssistantText,
  type CoreTurnBridgeDeps,
} from '../acp/core-turn-bridge.js';
import { notifyAgentTurnEnd } from '../web-push/notify-turn-end.js';
import { readInputSourceMeta } from '../acp/input-source-meta.js';
import { formatInputSourceLine } from '../input/input-source-display.js';
import type { AcpServerOptions } from '../acp/server.js';
import type { LLMMessage } from '../llm.js';
import {
  appendAssistantMessages,
  appendUserAndBuildMessages,
  appendUserPromptBlocksAndBuildMessages,
} from './daemon-history-helper.js';
import { toolSurface } from './daemon-tools/index.js';
import { appendWebtermContext } from './daemon-tools/webterm-context.js';
import { PTY_SHELL_TOOL_NAMES } from './daemon-tools/pty-shell.js';
import {
  buildTerminalCapableTurn,
  PTY_BUDGET_GRANT,
  TERMINAL_MISSION_DISCIPLINE,
} from '../agent/terminal-surface.js';
import type { CoreTurnDispatchTool } from '../core-turn/index.js';
import { elanousSelfAccessPrompt } from '../agent/self-ambient.js';
import { createToolCwdResolver, type ToolCwdResolver } from './tool-cwd.js';
import { debug } from '../debug/log.js';

/** C4 (2026-07-12) — arm the non-detached-PTY kill ONCE per turn signal.
 *  Multiple tool calls in one turn share the same AbortSignal instance;
 *  the WeakSet dedupes so we don't stack listeners. Exported for tests. */
const ptyKillWiredSignals = new WeakSet<AbortSignal>();
export function wirePtyKillOnAbort(
  signal: AbortSignal,
  kill: () => void,
): boolean {
  if (ptyKillWiredSignals.has(signal)) return false;
  ptyKillWiredSignals.add(signal);
  if (signal.aborted) {
    try { kill(); } catch { /* best-effort */ }
    return true;
  }
  signal.addEventListener('abort', () => {
    try { kill(); } catch { /* best-effort */ }
  }, { once: true });
  return true;
}

/** PLAN-multi-surface-pty-shell M3 — fold the shared `_imageFile`→inline
 *  image conversion onto the ACP-path dispatcher when the tool surface
 *  exposes PtyShell. Pass-through otherwise. */
function terminalCapableDispatch(
  hasPtyShell: boolean,
  raw: CoreTurnDispatchTool,
): CoreTurnDispatchTool {
  if (!hasPtyShell) return raw;
  return buildTerminalCapableTurn({
    specs: [],
    dispatch: raw,
    systemPromptParts: [],
    inlineImages: true,
  }).dispatch;
}

export interface DaemonRuntimeOpts {
  /** Optional system preamble injected at the head of every turn.
   *  Keep it short — daemon mode is meant for lightweight chat, not
   *  the dashboard's elaborate preamble stack. */
  systemPrompt?: string;
  /** M1.5 A.1 — disk-backed session history directory. When set,
   *  `DaemonSessionHistory` mirrors all appends to
   *  `<diskDir>/<sessionId>.jsonl` so daemon restarts preserve
   *  history. When unset (default), history is in-memory only.
   *  `ELANOUS_HISTORY_DIR` env var is the conventional source. */
  diskDir?: string;
  /** Tool surface activation. Default = 'webterm' (full stack).
   *  Operators set the persistent preference via
   *  `elanous config set global.tools <kind>` (single source of truth
   *  · `ELANOUS_TOOLS` env var was removed 2026-05-13). Pass this opt
   *  to override per-invocation (CLI `--tools <kind>`). */
  tools?: import('./daemon-tools/index.js').DaemonToolSurfaceKind;
  /** M1.5 A.2 — working directory for fs-bound tools (Read · Grep).
   *  Non-ACP defaults to the daemon process's `cwd()` at boot; ACP uses
   *  this only as a fallback when its session supplies no cwd.
   *  Honoured only when `tools !== 'none'`. */
  toolCwd?: string;
  /** ACP entry only: the client supplies cwd per session, not at daemon boot. */
  acpSessionCwd?: boolean;
  /** C4 cancel seam — injected by the boot composition layer when a
   *  runtime exposes PtyShell. Keeps this headless module free of a
   *  direct pty-shell registry import while preserving cancel→PTY kill. */
  killNonDetachedPty?: () => void;
}

export function buildDaemonInputSourceLine(
  promptMeta: Readonly<Record<string, unknown>> | undefined,
): string | null {
  const source = readInputSourceMeta(promptMeta as Record<string, unknown> | undefined);
  if (!source) return null;
  return formatInputSourceLine(source);
}

export function composeDaemonSystemPrompt(
  basePrompt: string | undefined,
  promptMeta: Readonly<Record<string, unknown>> | undefined,
  sessionId?: string,
): string {
  return [basePrompt, buildDaemonInputSourceLine(promptMeta), elanousSelfAccessPrompt(sessionId)]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

/** PWA multitab workspace 2026-05-05 — origin tag distinguishes which
 *  surface created the session so cross-device picker UIs can render
 *  meaningful pills. Free-form string is rejected at the wire boundary
 *  (REST + register) — only the four canonical values + undefined are
 *  allowed. Adding a new surface = bumping this union. */
export type DaemonSessionOrigin = 'cli' | 'pwa' | 'tg' | 'dc' | 'native';

/** Per-session summary surfaced via REST + status. */
export interface DaemonSessionSummary {
  id: string;
  msgCount: number;
  lastTurnAt: string;
  /** PWA picker preview — last user/assistant text trimmed to 60 chars
   *  with `…` suffix when truncated. Undefined when the session has no
   *  messages yet or the last message has no extractable text (pure
   *  multimodal / tool-only). */
  lastMsgPreview?: string;
  /** Surface that initially registered this session. Undefined when the
   *  session was created before the origin field landed (legacy jsonl
   *  on disk) or by a path that didn't pass an origin (e.g. anonymous
   *  ACP attach without external register). */
  origin?: DaemonSessionOrigin;
}

/** Wire-side guard — accepts canonical origin string, rejects anything
 *  else. Used by register() opts and REST body parsing so an external
 *  caller can't smuggle arbitrary tags into the picker UI. */
export function isDaemonSessionOrigin(v: unknown): v is DaemonSessionOrigin {
  return v === 'cli' || v === 'pwa' || v === 'tg' || v === 'dc' || v === 'native';
}

/** PWA picker preview — last 60-char snippet of the most recent text-
 *  bearing user/assistant message. Walks msgs from the tail backwards,
 *  ignoring tool/system entries and empty content. ContentBlock arrays
 *  are flattened to their text segments only (image / resource_link
 *  blocks contribute nothing, so a screenshot-only turn yields the
 *  *previous* user prompt's preview rather than ''). Returns undefined
 *  when nothing renders. */
const PREVIEW_MAX_LEN = 60;
export function extractLastMsgPreview(
  msgs: readonly LLMMessage[],
): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = stringifyMessageText(m);
    if (!text || text.length === 0) continue;
    // Whitespace collapse — newlines / tabs in long prompts shouldn't
    // bloat the picker row.
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length === 0) continue;
    return flat.length > PREVIEW_MAX_LEN
      ? flat.slice(0, PREVIEW_MAX_LEN - 1) + '…'
      : flat;
  }
  return undefined;
}

function stringifyMessageText(m: LLMMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const block of c) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    return parts.join(' ');
  }
  return '';
}

/** Per-session message store keyed by ACP session id.
 *
 *  Two modes (selected at construction):
 *    - **memory** (default · in-process · lost on exit) — current
 *      behavior, byId Map + lastTurnAt Map. Used by `elanous serve`
 *      until M1.5 A.3 flips defaults.
 *    - **disk-backed** (M1.5 A.1 · `diskDir` set) — same in-memory
 *      cache PLUS write-through to `<diskDir>/<sessionId>.jsonl`
 *      (one JSON-encoded `LLMMessage` per line). Constructor scans
 *      the dir to seed the cache. `lastTurnAt` derives from file
 *      mtime so there's no separate index file to keep in sync.
 *
 *  C10/C12 — `summary()` and `gc(maxAgeMs)` work in both modes. The
 *  disk path also unlinks stale files during GC + on `forget()`. */
/** Tier 1 telegram fan-out arc — handler signature for `onAppend`.
 *  Channel-agnostic: receives the sessionId and the messages that were
 *  just persisted (assistant + tool batch from the turn that completed,
 *  or the user message at turn start). Consumers decide what to do —
 *  Telegram sinker (PR 4) pushes to chat, Discord/Slack would do the
 *  same. Subscribers must not throw; the registry swallows errors so
 *  one bad listener can't break the live turn (RESEARCH §3.1 ACP
 *  lingua franca: history is the single source of truth, downstream
 *  channels are observers). */
export type DaemonSessionHistoryAppendListener = (
  sessionId: string,
  msgs: readonly LLMMessage[],
) => void;

export class DaemonSessionHistory {
  private readonly byId = new Map<string, LLMMessage[]>();
  private readonly lastTurnAt = new Map<string, number>(); // epoch ms
  private readonly diskDir: string | undefined;
  /** PWA multitab workspace 2026-05-05 — origin tag per session.
   *  In-memory only (no jsonl write-through) — losing it on daemon
   *  restart is acceptable since picker UI degrades to "untagged"
   *  rather than blocking. setOrigin / register opts are the two
   *  entry points; ACP-internal session creation paths leave the tag
   *  undefined. */
  private readonly origins = new Map<string, DaemonSessionOrigin>();
  // Tier 1 telegram fan-out arc — channel-agnostic subscribe primitive.
  // `append()` fires every listener after both the in-memory cache and
  // the jsonl write-through have completed, so consumers reading
  // `get(sessionId)` from inside the listener see the just-appended
  // tail. Consumers register on attach, unsubscribe on close.
  private readonly appendListeners = new Set<DaemonSessionHistoryAppendListener>();

  /** 완전 무결 세션 공유(R5 · 2026-07-09) — 메모리에 없는 세션을 on-disk
   *  SessionStore 에서 lazy 로드(read-through). PWA 챗이 텔레그램/CLI/이전 세션을
   *  열면 그 context 를 실제 로드해 이어지게. 없으면 null. 1회 로드 후 캐시. */
  private readonly readThrough: ((sessionId: string) => LLMMessage[] | null) | undefined;

  constructor(opts: { diskDir?: string; readThrough?: (sessionId: string) => LLMMessage[] | null } = {}) {
    this.diskDir = opts.diskDir;
    this.readThrough = opts.readThrough;
    if (this.diskDir) {
      // Ensure dir exists + seed the in-memory cache from any prior
      // sessions on disk. Keeps every read path fast (memory-only)
      // and avoids re-parsing jsonl on each turn.
      mkdirSync(this.diskDir, { recursive: true });
      this.seedFromDisk();
    }
  }

  private seedFromDisk(): void {
    if (!this.diskDir) return;
    const entries = readdirSync(this.diskDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      const path = joinPath(this.diskDir, entry);
      try {
        const raw = readFileSync(path, 'utf8');
        const msgs: LLMMessage[] = [];
        for (const line of raw.split('\n')) {
          if (line.length === 0) continue;
          try { msgs.push(JSON.parse(line) as LLMMessage); }
          catch { /* skip corrupt line — best-effort recovery */ }
        }
        if (msgs.length > 0) this.byId.set(sessionId, msgs);
        const st = statSync(path);
        this.lastTurnAt.set(sessionId, st.mtimeMs);
      } catch { /* skip unreadable file */ }
    }
  }

  private diskPathFor(sessionId: string): string | null {
    if (!this.diskDir) return null;
    // Defensive: refuse session ids that contain path separators.
    // ACP session ids are minted server-side (`elanous-session-N` /
    // `http-<ts>-<rand>`), so this is a safety net for future
    // changes — never expected to fire in current code.
    if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
      return null;
    }
    return joinPath(this.diskDir, `${sessionId}.jsonl`);
  }

  get(sessionId: string): LLMMessage[] {
    const cached = this.byId.get(sessionId);
    if (cached) return cached;
    // R5 read-through — 메모리에 없으면 on-disk 에서 1회 로드해 캐시(완전 무결 공유).
    if (this.readThrough) {
      try {
        const loaded = this.readThrough(sessionId);
        if (loaded && loaded.length > 0) {
          this.byId.set(sessionId, loaded);
          if (!this.lastTurnAt.has(sessionId)) this.lastTurnAt.set(sessionId, Date.now());
          return loaded;
        }
      } catch { /* read-through 실패 시 빈 히스토리로 */ }
    }
    return [];
  }

  append(sessionId: string, msgs: LLMMessage[]): void {
    if (msgs.length === 0) return;
    const existing = this.byId.get(sessionId) ?? [];
    this.byId.set(sessionId, [...existing, ...msgs]);
    this.lastTurnAt.set(sessionId, Date.now());
    const path = this.diskPathFor(sessionId);
    if (path) {
      try {
        appendFileSync(path, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
      } catch { /* disk write failure should not break the live turn */ }
    }
    // Tier 1 telegram fan-out arc — fan out to subscribers AFTER the
    // jsonl write so a listener calling back into `get()` sees the
    // persisted tail. Listener errors are swallowed (best-effort
    // observer contract — see DaemonSessionHistoryAppendListener).
    if (this.appendListeners.size > 0) {
      const frozen: readonly LLMMessage[] = msgs;
      for (const listener of this.appendListeners) {
        try { listener(sessionId, frozen); }
        catch { /* observer must not break the turn */ }
      }
    }
  }

  /** Tier 1 telegram fan-out arc — subscribe to message-append events.
   *  Returns an unsubscribe function. Listeners fire AFTER jsonl
   *  write-through so reading history from inside the listener is
   *  consistent. Channel-agnostic by design (RESEARCH §3.1) —
   *  Telegram, Discord, future channels all share one hook. */
  onAppend(listener: DaemonSessionHistoryAppendListener): () => void {
    this.appendListeners.add(listener);
    return () => { this.appendListeners.delete(listener); };
  }

  /** Test/diagnostics — current subscriber count. */
  get appendListenerCount(): number {
    return this.appendListeners.size;
  }

  /** Tier 1 Phase 3 — register an externally-minted sessionId so
   *  `has(id)` returns true and subsequent `loadSession` RPCs accept
   *  it. Used by the TUI auto-register flow (PR 2) — TUI mints
   *  UUIDs; this lets the daemon adopt them as first-class without a
   *  namespace migration.
   *
   *  Idempotent: re-registering an existing id is a no-op (preserves
   *  any messages already appended). When `initialMessages` is
   *  provided, the session starts with those messages persisted to
   *  jsonl in one shot — useful for boot-time sync from the TUI's
   *  local jsonl. */
  register(
    sessionId: string,
    initialMessages: LLMMessage[] = [],
    opts: { origin?: DaemonSessionOrigin } = {},
  ): void {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      sessionId.includes('..')
    ) {
      throw new Error(`invalid sessionId for register: ${sessionId}`);
    }
    if (!this.byId.has(sessionId)) {
      this.byId.set(sessionId, []);
      this.lastTurnAt.set(sessionId, Date.now());
      // Touch the jsonl file when in disk mode so seedFromDisk on a
      // future daemon restart picks up the empty registration.
      const path = this.diskPathFor(sessionId);
      if (path && !existsSync(path)) {
        try {
          appendFileSync(path, '');
        } catch { /* best-effort */ }
      }
    }
    if (opts.origin && isDaemonSessionOrigin(opts.origin)) {
      this.origins.set(sessionId, opts.origin);
    }
    if (initialMessages.length > 0) {
      // Reuse append so listeners (PR #837 onAppend) fire and the
      // jsonl write-through happens through the standard path.
      this.append(sessionId, initialMessages);
    }
  }

  /** PWA multitab workspace 2026-05-05 — explicit origin tag for an
   *  existing session. Caller (e.g. PWA `POST /v1/sessions/origin`
   *  follow-up · or a bridge wrapper) sets the surface tag any time
   *  after the session exists. Idempotent. Invalid origin = no-op. */
  setOrigin(sessionId: string, origin: DaemonSessionOrigin): void {
    if (!this.byId.has(sessionId)) return;
    if (!isDaemonSessionOrigin(origin)) return;
    this.origins.set(sessionId, origin);
  }

  /** GN (2026-07-18) — pre-turn origin 태깅. `setOrigin` 은 기존 세션 전용(byId 가드)
   *  이라 첫 append 前 시점(onPromptReceived)엔 no-op 이다. 이 메서드는 세션이 아직
   *  존재하지 않아도 origins 맵에 태그를 심어, 첫 append 시 session-history-mirror 의
   *  `getOrigin` 이 읽어 S1 세션 origin 으로 전파하게 한다(네이티브 앱 소스 귀속). */
  tagOrigin(sessionId: string, origin: DaemonSessionOrigin): void {
    if (!isDaemonSessionOrigin(origin)) return;
    this.origins.set(sessionId, origin);
  }

  /** Picker UI · status — surface that initially registered the session
   *  (or `undefined` if untagged). */
  getOrigin(sessionId: string): DaemonSessionOrigin | undefined {
    return this.origins.get(sessionId);
  }

  /** Drop a session. Used when the ACP server emits cancel + no
   *  client reattaches (cleanup is a follow-up — for now, just live
   *  with retained history per session id). */
  forget(sessionId: string): void {
    this.byId.delete(sessionId);
    this.lastTurnAt.delete(sessionId);
    this.origins.delete(sessionId);
    const path = this.diskPathFor(sessionId);
    if (path && existsSync(path)) {
      try { unlinkSync(path); } catch { /* best-effort */ }
    }
  }

  /** For tests / status. Snapshot of session ids the daemon currently
   *  remembers. */
  list(): string[] {
    return [...this.byId.keys()];
  }

  /** Whether `sessionId` has any history. M2.3 loadSession will use
   *  this to validate before registering the session on attach. */
  has(sessionId: string): boolean {
    if (this.byId.has(sessionId)) return true;
    // R5 read-through — on-disk 에 있으면 로드 후 true(있는 세션 이어가기).
    return this.get(sessionId).length > 0;
  }

  /** Snapshot of all sessions for REST GET /v1/sessions. Sorted by
   *  lastTurnAt descending (most recent first).
   *
   *  PWA multitab workspace 2026-05-05 — adds `lastMsgPreview` (60-char
   *  trim of the most recent text-bearing user/assistant message) and
   *  `origin` (surface tag set via register({origin}) / setOrigin).
   *  Both are optional. */
  summary(): DaemonSessionSummary[] {
    const out: DaemonSessionSummary[] = [];
    for (const [id, msgs] of this.byId) {
      const ts = this.lastTurnAt.get(id) ?? Date.now();
      const entry: DaemonSessionSummary = {
        id,
        msgCount: msgs.length,
        lastTurnAt: new Date(ts).toISOString(),
      };
      const preview = extractLastMsgPreview(msgs);
      if (preview !== undefined) entry.lastMsgPreview = preview;
      const origin = this.origins.get(id);
      if (origin !== undefined) entry.origin = origin;
      out.push(entry);
    }
    out.sort((a, b) => b.lastTurnAt.localeCompare(a.lastTurnAt));
    return out;
  }

  /** C12 — drop sessions whose lastTurnAt is older than `maxAgeMs`.
   *  Returns the count of sessions removed. Called periodically by
   *  the daemon boot to bound memory growth (default 24h TTL). When
   *  `diskDir` is set, the on-disk file is also unlinked. */
  gc(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, ts] of this.lastTurnAt) {
      if (ts < cutoff) {
        this.byId.delete(id);
        this.lastTurnAt.delete(id);
        this.origins.delete(id);
        const path = this.diskPathFor(id);
        if (path && existsSync(path)) {
          try { unlinkSync(path); } catch { /* best-effort */ }
        }
        removed += 1;
      }
    }
    return removed;
  }

  /** M1.5 A.1 — surface the disk dir for status / diagnostics. */
  get persistencePath(): string | undefined {
    return this.diskDir;
  }
}

export function createDaemonBootToolCwdResolver(opts: DaemonRuntimeOpts, tools: string): ToolCwdResolver {
  if (opts.acpSessionCwd && tools !== 'none') {
    const defaultCwd = opts.toolCwd?.trim() || process.env.ELANOUS_TOOL_CWD?.trim();
    if (!defaultCwd) {
      return {
        cwd: undefined,
        resolveWriteCwd: () => { throw new Error('Tool surface has no working directory.'); },
      };
    }
    return createToolCwdResolver({ tools, toolCwd: defaultCwd });
  }
  return createToolCwdResolver({
    tools,
    ...(opts.toolCwd !== undefined ? { toolCwd: opts.toolCwd } : {}),
  });
}

/** Build a `runTurn` handler suitable for `bootAcpServer`'s
 *  `runTurn` option. Uses the supplied history store and the tool
 *  surface chosen via `opts.tools` (default 'none' = current
 *  text-only behavior). */
export function createDaemonRunTurn(
  history: DaemonSessionHistory,
  opts: DaemonRuntimeOpts = {},
  toolCwdResolver = createDaemonBootToolCwdResolver(opts, opts.tools ?? 'none'),
): NonNullable<AcpServerOptions['runTurn']> {
  const turnToolCwd = new AsyncLocalStorage<ToolCwdResolver>();
  // Resolve tool surface synchronously so getTools is fast on the
  // hot path. M1.5 A.2 — when 'none', behavior matches pre-A.2
  // (`getTools` returns [], dispatchTool throws); when 'readonly',
  // Read + Grep + WebSearch are wired with cwd guard.
  const surface = toolSurface(opts.tools ?? 'none');
  // PLAN-multi-surface-pty-shell M3 — surface exposes PtyShell ⇒ fold
  // the shared terminal adapters onto the ACP path: budgetGrant, the
  // `_imageFile`→inline image conversion (iOS/Android/PWA ACP peers
  // receive the frame; vision LLMs see it), and the mission-discipline
  // system-prompt block (appended in getMessages below). C4 (2026-07-12):
  // abort→PTY kill IS now wired — the bridge polls session/cancel into
  // the turn signal, runCoreTurn forwards it through the dispatch ctx,
  // and wirePtyKillOnAbort() kills non-detached PTYs on first abort.
  const surfaceHasPtyShell = surface.specs.some(
    (t) => (PTY_SHELL_TOOL_NAMES as readonly string[]).includes(t.name),
  );
  if (surfaceHasPtyShell && !opts.killNonDetachedPty) {
    throw new Error(
      'createDaemonRunTurn requires killNonDetachedPty when the selected tool surface exposes PtyShell',
    );
  }
  const killNonDetachedPty = opts.killNonDetachedPty;

  const deps: CoreTurnBridgeDeps = {
    // Persists the user message AND builds the LLM-facing list. See
    // daemon-history-helper.ts for the per-turn shape. Cleanup C1
    // moved this out of an inline closure to fix the user-message
    // persistence bug uniformly across all daemon paths.
    getMessages: ({ sessionId, userText, promptBlocks, promptMeta }) => {
      const baseSystemPrompt = composeDaemonSystemPrompt(opts.systemPrompt, promptMeta, sessionId);
      // Image-pipeline followup #4 (2026-05-05) — append daemon webterm
      // context (current ACP sessionId + active terminal summary) to
      // the system prompt when the webterm surface is active. Helper
      // returns the original prompt unchanged when nothing to add, so
      // 'none' / 'readonly' surfaces and tests w/o a session in scope
      // are unaffected.
      const webtermPrompt = appendWebtermContext(baseSystemPrompt, sessionId, surface);
      // M3 — join the terminal mission discipline when PtyShell is live.
      const systemPrompt = surfaceHasPtyShell
        ? [webtermPrompt, TERMINAL_MISSION_DISCIPLINE].filter(Boolean).join('\n\n')
        : webtermPrompt;
      // Step 2 of platform-evolution arc — when ACP delivered
      // ContentBlock[] (image / resource_link blocks present), use
      // the sibling helper that preserves them as
      // LLMMessage.content: ContentBlock[]. When the prompt is
      // text-only (or the caller didn't pass promptBlocks — legacy
      // path), fall through to the original string-content helper
      // so jsonl shape stays compact for the common case.
      const hasNonTextBlock = !!promptBlocks?.some(
        (b) => (b as { type?: string }).type !== 'text',
      );
      if (hasNonTextBlock) {
        return appendUserPromptBlocksAndBuildMessages(
          history, sessionId, promptBlocks!, systemPrompt,
        );
      }
      return appendUserAndBuildMessages(history, sessionId, userText, systemPrompt);
    },
    getTools: () => surface.specs,
    dispatchTool: terminalCapableDispatch(surfaceHasPtyShell, async (name, args, ctx) => {
      // C4 (2026-07-12) — the TURN's abort signal now arrives via the
      // dispatch ctx (bridge polls session/cancel → ctrl.abort →
      // runCoreTurn forwards ctx.signal). Thread it into the tool
      // runtime so in-flight work aborts, and — once per turn — arm
      // the non-detached PTY kill (REST/텔레그램 M3 동형: PWA/iOS의
      // 취소가 폭주 터미널 미션을 실제로 끊는다). Legacy callers
      // without a ctx.signal keep the old inert-controller behavior.
      //
      // Image-pipeline followup #1 (2026-05-05) — `ctx.sessionId` is
      // forwarded by `runCoreTurn` (set from CoreTurnContext.sessionId)
      // so session-keyed tools (WebTerminal*) can auto-inject the
      // current ACP scope when the LLM omits sessionId from args.
      const turnSignal = ctx?.signal;
      if (surfaceHasPtyShell && turnSignal) wirePtyKillOnAbort(turnSignal, killNonDetachedPty!);
      const resolver = turnToolCwd.getStore() ?? toolCwdResolver;
      const dispatchCtx: import('./daemon-tools/types.js').DaemonToolDispatchCtx = {
        cwd: resolver.cwd!,
        resolveWriteCwd: resolver.resolveWriteCwd,
        signal: turnSignal ?? new AbortController().signal,
        // Elanous's own LLM assembles tool arguments from natural language.
        entry: 'elanous-apparatus',
      };
      if (ctx?.sessionId) dispatchCtx.sessionId = ctx.sessionId;
      if (ctx?.userText) dispatchCtx.userText = ctx.userText;
      debug.log('boot.daemon-runtime', 'tool-dispatch-context', {
        userTextState: ctx?.userText ? 'present' : 'absent',
        userTextChars: ctx?.userText?.length ?? 0,
      });
      // PLAN-ios-rich-dev-feedback-hydrate M1-S (ACP-path portion · 2026-05-13) —
      // Wire FeedbackEnvelope emit from progressive tool runtimes
      // (Grep search-hit · Plan steps · Read large-file progress) into
      // the ACP broadcaster. Without this iOS native ACP path saw 0
      // envelopes because meta-api dualEmitFeedback only fires on
      // /v1/prompt/stream (PWA) path. Bound per-turn to ctx.sessionId
      // so each turn's emissions broadcast to all peers of that session
      // (originating peer included). Null when daemon hasn't booted
      // ACP server yet → tools no-op gracefully.
      if (ctx?.sessionId) {
        const { getActiveAcpFeedbackBroadcaster } = require('../acp/server.js') as
          typeof import('../acp/server.js');
        const broadcast = getActiveAcpFeedbackBroadcaster();
        if (broadcast) {
          const sid = ctx.sessionId;
          dispatchCtx.emitFeedback = (env) => { void broadcast(sid, env); };
        }
      }
      // P0b(DESIGN-cross-surface-autonomy-membrane §10) — ACP 코어 데몬 턴에 SurfaceUx confirm/question 채널
      // 주입. SelfImplement(및 delegate)의 HITL(approvePr 등)이 막(SurfaceUx)을 통해 ACP 클라이언트(iPhone/
      // PWA 시트·elanous/ask)로 도달한다. ★fail-soft: pusher 없으면(피어 없음·미부팅) 채널 미설정 →
      // SurfaceUx.confirm fail-closed(PR 안 열림·자동승인 금지·기존 동작 불변).
      if (ctx?.sessionId) {
        const { getActiveAcpAskPusher } = require('../acp/server.js') as
          typeof import('../acp/server.js');
        const pusher = getActiveAcpAskPusher();
        if (pusher) {
          const { createAcpConfirmChannel, createAcpQuestionChannel } = require('../acp/acp-surface-channels.js') as
            typeof import('../acp/acp-surface-channels.js');
          const sid = ctx.sessionId;
          dispatchCtx.surfaceHitlChannels = [createAcpConfirmChannel(sid, pusher)];
          dispatchCtx.surfaceQuestionChannels = [createAcpQuestionChannel(sid, pusher)];
        }
      }
      return surface.dispatch(name, args, dispatchCtx);
    }),
    ...(surfaceHasPtyShell ? { budgetGrant: PTY_BUDGET_GRANT } : {}),
    onTurnComplete: ({ sessionId, newMessages }) => {
      appendAssistantMessages(history, sessionId, newMessages);
      // Cleanup PR — fire Web Push to subscribed PWA clients ("agent
      // done"). Fire-and-forget; helper handles aborted/empty-text +
      // no-subscribers early-return + swallows delivery errors.
      const finalText = extractLastAssistantText(newMessages) ?? '';
      void notifyAgentTurnEnd({ sessionId, finalText });
    },
  };
  const inner = bridgeCoreTurnToAcp(deps);
  // PLAN-ios-rich-dev-feedback-hydrate M5 (ACP-path portion · 2026-05-14) —
  // Wire the M6-PR-1 debug-bridge into the ACP turn lifecycle so iOS
  // (and other ACP peers) receive `debug.line` envelopes the same way
  // PWA `/v1/prompt/stream` does (meta-api.ts:836). Without this iOS
  // saw 0 debug.line events because `createDebugBridge` was only
  // instantiated on the PWA path.
  //
  // Activation policy: always-on. Drawer visibility + per-event
  // visibility are controlled client-side (iOS Settings toggle filters
  // displayed rows; non-iOS peers harmlessly ignore unfamiliar
  // envelope kinds). The bridge already category-whitelists `^(chat|
  // tool|agent|acp)\.` and caps the in-memory ring at 200 to bound
  // bandwidth. If dogfood surfaces noise we can flip to opt-in via
  // `_meta.elanous.debugTap` in a follow-up.
  //
  // Per-turn lifecycle: instantiate when the broadcaster is available
  // (post `runAcpServer` boot), dispose in finally so a misbehaving
  // sink can't leak across turns. Broadcaster null → bridge skipped,
  // no-op gracefully (mirrors the M1-S guard at line 519).
  return async (turnCtx): Promise<void> => {
    let debugBridge: import('../feedback/debug-bridge.js').DebugBridge | null = null;
    try {
      const { getActiveAcpFeedbackBroadcaster } = require('../acp/server.js') as
        typeof import('../acp/server.js');
      const broadcast = getActiveAcpFeedbackBroadcaster();
      if (broadcast) {
        const { createDebugBridge } = require('../feedback/debug-bridge.js') as
          typeof import('../feedback/debug-bridge.js');
        const sid = turnCtx.sessionId;
        debugBridge = createDebugBridge({
          emit: (env) => { void broadcast(sid, env); },
          sessionId: sid,
        });
        debugBridge.activate();
      }
      if (opts.acpSessionCwd) {
        const resolver = createToolCwdResolver({ tools: opts.tools ?? 'none', toolCwd: turnCtx.cwd });
        await turnToolCwd.run(resolver, () => inner(turnCtx));
      } else {
        await inner(turnCtx);
      }
    } finally {
      debugBridge?.dispose();
    }
  };
}

/** Compose helper: build a fresh history + a runTurn bound to it.
 *  Returned together so callers can introspect the history + active
 *  tool surface for `elanous serve --status`.
 *
 *  Env vars (used when the matching opt is not supplied):
 *    - `ELANOUS_HISTORY_DIR=<path>` → A.1 disk-backed history
 *    - `ELANOUS_TOOLS=readonly`     → A.2 readonly tool surface
 *    - `ELANOUS_TOOL_CWD=<path>`    → A.2 fs-tool cwd
 *  Default = in-memory + 'none' tool surface (current behavior). */
export function createDaemonRuntime(
  opts: DaemonRuntimeOpts = {},
): {
  history: DaemonSessionHistory;
  runTurn: NonNullable<AcpServerOptions['runTurn']>;
  /** Active tool surface kind for status / sidecar. */
  tools: import('./daemon-tools/index.js').DaemonToolSurfaceKind;
  /** Resolved tool cwd when tools !== 'none'. */
  toolCwd?: string;
} {
  // 2026-05-13 · read the persisted user-config knob for tools. Lazy
  // require so the boot path doesn't pay the cost when no daemon is
  // booting (e.g. CLI helper invocations that don't construct a
  // runtime). Errors swallow → fall through to the 'webterm' default.
  const readGlobalToolsFromUserConfig = (): DaemonRuntimeOpts['tools'] => {
    try {
      const mod = require('../nexus/config/user-config.js') as typeof import('../nexus/config/user-config.js');
      const cfg = mod.readUserConfig();
      const raw = cfg.global?.tools;
      if (raw === 'none' || raw === 'readonly' || raw === 'chat' || raw === 'webterm') {
        return raw;
      }
      if (raw === 'all') {
        // Legacy alias documented on GlobalConfig.tools.
        return 'webterm';
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
  const diskDir = opts.diskDir ?? process.env.ELANOUS_HISTORY_DIR?.trim();
  // 2026-05-13 · tool surface resolution (env-var-free):
  //   1. `opts.tools` programmatic override (CLI `--tools <kind>`
  //      flows through here).
  //   2. `~/.elanous/config.json` → `global.tools` (single persistent
  //      surface — set via `elanous config set global.tools <kind>`).
  //   3. Fallback 'webterm' — matches the CLI option's `Default =
  //      "webterm"` promise and keeps the PWA's sticky webterm
  //      workflow alive out of the box.
  // The legacy `ELANOUS_TOOLS` env var was removed in this revision;
  // user-config is the single persistent surface (consistent with the
  // env-var removal in PR #2534 for config-dir / state-dir).
  const userConfigTools = readGlobalToolsFromUserConfig();
  const tools = opts.tools ?? userConfigTools ?? 'webterm';
  const validTools: DaemonRuntimeOpts['tools'] = tools === 'none'
    ? 'none'
    : tools === 'readonly'
      ? 'readonly'
      : tools === 'chat'
        ? 'chat'
        : tools === 'webterm'
          ? 'webterm'
          // Unrecognised values (typos in user-config, future kinds
          // forgotten by older binaries) fall through to the safest
          // permissive default — the sticky-webterm workflow stays
          // intact rather than silently disabling every tool.
          : 'webterm';
  const toolCwdResolver = createDaemonBootToolCwdResolver(opts, validTools);
  // S4 (2026-07-12) — 크로스서피스 파리티: nexus 부트만 갖던 R5
  // read-through(on-disk SessionStore lazy 로드)를 standalone `elanous
  // serve` 런타임에도 기본 장착 — 어느 데몬으로 열든 텔레그램/디스코드/
  // CLI/이전 세션 id 를 주면 그 맥락으로 이어진다.
  //
  // 2026-07-24 — 쓰기 미러(R3)도 여기로 내린다. 종전 주석은 "READ-ONLY라 테스트
  // 격리 규율과 충돌 없음(쓰기 미러 R3는 nexus 부트 계층에 유지)"이라 적혀 있었다.
  // 그 유보의 근거(테스트가 운영 스토어를 건드릴 위험)는 `sessionRoot()` 의
  // NODE_ENV=test 리다이렉트로 해소됐다. 유보의 대가가 실제로 발생했기 때문에
  // 내린다 — `elanous --acp-server` 로 나눈 대화가 **어디에도 남지 않아**
  // `elanous session search` 로 사후 조회가 불가능했고, 2026-07-23 사고 대화가
  // 통째로 소실됐다. 이 경로의 유일한 프로덕션 호출처는 src/index.ts:6662.
  // 설계: 내부 문서 `PLAN-self-cognition-observability-surgery-2026-07-24` §3
  let storeReadThrough: ((id: string) => LLMMessage[] | null) | undefined;
  let wireStoreMirror: typeof import('../nexus/api/session-history-mirror.js')['wireDaemonHistoryToStore'] | undefined;
  try {
    const mirror = require('../nexus/api/session-history-mirror.js') as
      typeof import('../nexus/api/session-history-mirror.js');
    storeReadThrough = mirror.makeSessionStoreReadThrough();
    wireStoreMirror = mirror.wireDaemonHistoryToStore;
  } catch { /* store layer unavailable — in-memory only */ }
  const history = new DaemonSessionHistory({
    ...(diskDir ? { diskDir } : {}),
    ...(storeReadThrough ? { readThrough: storeReadThrough } : {}),
  });
  // 쓰기 미러 — 실패해도 런타임을 못 세우면 안 되므로 fail-soft. 미러 내부의
  // append 실패는 session.mirror/append-failed 로 별도 관측된다.
  try { wireStoreMirror?.(history); }
  catch { /* 미러 배선 실패가 데몬 부팅을 막지 않는다 */ }
  // CV-3 DM-1 — wrap legacy single-LLM runTurn so prompts carrying
  // `_meta.elanous.multiLlm` fan out via the multi-LLM bridge while
  // every other prompt keeps the unchanged single-LLM path. Backwards
  // compat = 100% (D7) — vanilla ACP clients (chat / webterm /
  // telegram / discord / cli) never set the hint.
  const { createDaemonMultiLlmRunTurn } = require('./daemon-multi-llm-runtime.js') as
    typeof import('./daemon-multi-llm-runtime.js');
  const runTurn = createDaemonMultiLlmRunTurn(history, {
    ...opts,
    tools: validTools,
  }, toolCwdResolver);
  return {
    history,
    runTurn,
    tools: validTools,
    ...(toolCwdResolver.cwd ? { toolCwd: toolCwdResolver.cwd } : {}),
  };
}
