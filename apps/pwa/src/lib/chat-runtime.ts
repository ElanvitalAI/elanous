/**
 * Chat turn runtime — ACP `session/prompt` by default, SSE `/v1/prompt/stream`
 * when ACP is unavailable, plus local meta-command dispatch.
 */

import { cardTextFromToolOutput } from './elanous-card';
import { contextSources, type ContextSource } from '../components/chat/context-sources';
import type {
  AcpConnection,
  AcpFrame,
  DaemonClient,
  PromptUserContentBlock,
} from './daemon-client';
import {
  applyFeedbackEnvelope,
  applyHudSegmentEnvelope,
  type HudSegmentPayload,
} from './feedback-block-accumulator';
import type { FeedbackEnvelopeWire } from './feedback-envelope';
import { parseElanousFeedbackEnvelope } from './elanous-feedback-envelope';
import { forkSession } from './daemon-session';
import { forkConversation, userTurns } from './chat-fork';
import { SessionsStoreApi } from './sessions-store-api';
import { debugLog } from './debug';
import { fetchBudgetStatus, type BudgetStatusBody } from './budget-status';
import { remainingLines, statusText, type UsageBody } from './chat-status';
import { fetchDaemonModelTier, type DaemonHttpConfig } from './model-tier-sync';
import { isLlmTierProvider, lookupLlmTierSpec } from './model-tier-spec';
import { handleModelCommand, parseModelCommand } from './chat-model-commands';
import { handleSessionCommand, parseSessionCommand } from './chat-session-commands';
import { handleChatPersona, selectedChatPersona } from './chat-persona';

function chatPersonaId(sessionId: string): string | undefined {
  return typeof localStorage === 'undefined' ? undefined : selectedChatPersona(sessionId, localStorage);
}
import { harnessAskText } from './chat-harness-ask';
import { submitGraph } from './intake-front-door-api';
import { runSkillExec } from './skill-exec-client';
import { isMcpAppHtmlMime } from '../../../../src/tool-runtime/mcp-app-mime';
import { mcpResultImages, mcpAppResourceUriOf } from '../../../../src/feedback/media';

export { mcpResultImages, mcpAppResourceUriOf };

// PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M1 — process-wide HUD
// state lives OUTSIDE the per-turn `ChatBlock[]` because HUD is shared
// across every chat session/tab in the PWA (multi-tab observers all see
// the same `↯ variant · ctx 87% · ● 2 agents` strip). Subscribers are
// fanned out per applied envelope; renderer (M4 `<ChatHud>`) snapshots
// inside its callback. Keep the store keyed by segment `key` so a flood
// of updates on one segment doesn't bloat memory.
const hudSegments: Map<string, HudSegmentPayload> = new Map();
const hudSubscribers: Set<() => void> = new Set();

// useSyncExternalStore requires getSnapshot to be referentially stable
// across calls when the underlying store hasn't changed — otherwise
// React detects "store changed" on every render and re-enters, hitting
// React error #185 (Maximum update depth) which the error boundary
// surfaces as #418 (hydration mismatch). Cache the sorted array and
// invalidate inside the mutation path (notifyHudSubscribers).
let hudSnapshotCache: HudSegmentPayload[] = [];
let hudSnapshotDirty = false;

/** Snapshot priority-sorted HUD segments. Callers MUST treat the array
 *  as immutable; identity is stable until the next mutation. */
export function getHudSegmentsSnapshot(): HudSegmentPayload[] {
  if (hudSnapshotDirty) {
    hudSnapshotCache = Array.from(hudSegments.values()).sort(
      (a, b) => (a.priority ?? 50) - (b.priority ?? 50),
    );
    hudSnapshotDirty = false;
  }
  return hudSnapshotCache;
}

/** Subscribe to HUD-state changes. Returns unsubscribe. Callback fires
 *  once per applied envelope — duplicates / malformed envelopes silent. */
export function subscribeHudSegments(callback: () => void): () => void {
  hudSubscribers.add(callback);
  return () => {
    hudSubscribers.delete(callback);
  };
}

/** Test-only — reset HUD state + subscribers between cases. Not exported
 *  via the index barrel; importing modules grab it directly when needed. */
export function __resetHudStateForTest(): void {
  hudSegments.clear();
  hudSubscribers.clear();
  hudSnapshotCache = [];
  hudSnapshotDirty = false;
}

function notifyHudSubscribers(): void {
  hudSnapshotDirty = true;
  for (const cb of hudSubscribers) {
    try {
      cb();
    } catch (err) {
      // A buggy subscriber must not poison the wire path. Surface to
      // debug log; subscriber's own error handler should catch.
      debugLog('chat-runtime.hud.subscriber-error', err);
    }
  }
}

/** Returns true if the envelope was a HUD segment (and was consumed —
 *  caller must NOT then also pass it through applyFeedbackEnvelope).
 *  Process-wide: NOT gated by turn lifecycle (multi-tab observer that
 *  has `dropCurrentTurn=true` should still receive HUD updates). */
function maybeDispatchHudEnvelope(env: FeedbackEnvelopeWire): boolean {
  if (env.kind !== 'hud.segment') return false;
  const result = applyHudSegmentEnvelope(hudSegments, env);
  if (result === 'applied') notifyHudSubscribers();
  return true;
}

/** Public dispatcher for HUD envelopes arriving OUTSIDE the chat-runtime
 *  onFeedback path — e.g. ChatLayout's long-lived `/v1/events?topics=
 *  hud.segment` SSE subscriber synthesizes envelopes via
 *  `consumeHudSegmentSse` (daemon-client.ts M4) and hands them off
 *  here. Internally identical to the onFeedback short-circuit so a
 *  single store + subscriber set serve both paths. */
export function dispatchHudSegmentEnvelope(env: FeedbackEnvelopeWire): void {
  maybeDispatchHudEnvelope(env);
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'meta';

/** Phase B-2 / B-3 (PWA chat streaming · 2026-05-06) — multimodal
 *  block primitives.
 *
 *  - `text` (B-1/B-2) — streaming-friendly cumulative text. The
 *    accumulator updates one text block in place from each text-delta.
 *  - `image` (B-2) — inline media surfaced from a tool_result whose
 *    convention matched `{mediaType, dataB64}` (B-2.5 daemon emit).
 *  - `tool_use` (B-3) — agent tool-loop status pill. Pushed when the
 *    SSE `tool-call` event arrives; mutated in place when the matching
 *    `tool-result` event lands so the pill flips running → done/error.
 *    Carries `args` for the expand/collapse details panel + `summary`
 *    for the collapsed 1-line state. */
export interface McpAppPayload {
  html: string;
  connectDomains?: string[];
  resourceDomains?: string[];
}

/**
 * Accept only an HTML resource that belongs to the already-known MCP App URI.
 * Malformed or unrelated tool content remains text/fallback output instead of
 * becoming executable frame input.
 */
/** ⛔⭐⭐ FeedbackEnvelope 이 `agent_thought_chunk` 「위에」 실려 올 때의 «머리 줄».
 *
 *  📏 형식의 canonical 은 `src/acp/elanous-extensions.ts` 의 `formatElanousFeedbackEnvelope` 이다:
 *  ```
 *  [elanous/feedback/emit] <blockId>
 *  <FeedbackEnvelope JSON>
 *  <<elanous-feedback-end <blockId>>>
 *  ```
 *  이 모듈은 PWA-local `parseElanousFeedbackEnvelope`로 세 줄 전체를 검증한 뒤,
 *  유효한 payload만 기존 블록 누산기로 보낸다. 봉투 모양이지만 깨진 입력은 생각 렌더러에
 *  전달하지 않아 원시 마커가 새지 않는다. */
const FEEDBACK_ENVELOPE_HEAD = /^\[elanous\/feedback\/[a-zA-Z]+\] /;

/** REL9p — a tool answer's ```elanous-card``` blocks become their own text block (rendered as cards).
 *  Every place that finishes a tool block calls this, like `mcpResultImages` — the pill never shows output. */
export function pushToolCards(blocks: ChatBlock[], rawOutput: unknown): boolean {
  const text = cardTextFromToolOutput(rawOutput);
  if (!text || blocks.some((b) => b.kind === 'text' && b.text === text)) return false;
  blocks.push({ kind: 'text', text });
  return true;
}

export function parseMcpAppPayload(rawOutput: unknown, screenUrl: string): McpAppPayload | undefined {
  if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) return undefined;
  const record = rawOutput as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const resourceRecord = content
    .filter((entry): entry is Record<string, unknown> => (
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && entry.type === 'resource'
    ))
    .map((entry) => entry.resource)
    .find((resource): resource is Record<string, unknown> => {
      if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) return false;
      const record = resource as Record<string, unknown>;
      return (
        record.uri === screenUrl
        // ⛔📏 2026-08-21 라이브: 실제 값은 `text/html;profile=mcp-app` 이라 «정확히 일치»는
        //   영영 거짓이었다. 형식 비교는 본질(`type/subtype`)로 한다 — 그 판정은 한 집에 있다.
        && isMcpAppHtmlMime(record.mimeType)
        && typeof record.text === 'string'
      );
    });
  if (!resourceRecord) return undefined;

  const meta = resourceRecord._meta;
  const ui = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).ui
    : undefined;
  const csp = ui && typeof ui === 'object' && !Array.isArray(ui)
    ? (ui as Record<string, unknown>).csp
    : undefined;
  const connectDomains = csp && typeof csp === 'object' && !Array.isArray(csp)
    ? (csp as Record<string, unknown>).connectDomains
    : undefined;
  const resourceDomains = csp && typeof csp === 'object' && !Array.isArray(csp)
    ? (csp as Record<string, unknown>).resourceDomains
    : undefined;
  const validConnectDomains = Array.isArray(connectDomains)
    ? connectDomains.filter((origin): origin is string => typeof origin === 'string')
    : undefined;
  const validResourceDomains = Array.isArray(resourceDomains)
    ? resourceDomains.filter((origin): origin is string => typeof origin === 'string')
    : undefined;

  return {
    html: resourceRecord.text as string,
    ...(validConnectDomains ? { connectDomains: validConnectDomains } : {}),
    ...(validResourceDomains ? { resourceDomains: validResourceDomains } : {}),
  };
}

export type ChatBlock =
  | { kind: 'harness_ask'; acceptanceId: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; mediaType: string; alt?: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      status: 'running' | 'done' | 'error';
      readonly startedAt?: number;
      readonly endedAt?: number;
      args?: Record<string, unknown>;
      summary?: string;
      sources?: ContextSource[];
    }
  | {
      kind: 'mcp_app';
      toolId: string;
      toolName: string;
      screenUrl: string;
      /** ⭐ 이 화면을 만든 툴 호출의 원 결과. 규범상 호스트가 «초기 상태»로 위젯에 밀어야 한다
       *  (`ui/notifications/tool-result`). 이 값이 블록에 없으면 밀 것이 없다. */
      toolResult?: unknown;
      html?: string;
      connectDomains?: string[];
      resourceDomains?: string[];
      fallbackText?: string;
    }
  // M3 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — Feedback
  // Envelope-derived blocks. Merge key is the envelope `blockId`
  // (stable across phases) so start/delta/end mutate one entry rather
  // than appending duplicates.
  | {
      kind: 'agent_thinking';
      blockId: string;
      msg: string;
      /** true when the last envelope was phase='end'. Renderer flips
       *  pulse → ✓ checkmark. */
      done: boolean;
      metrics?: { elapsedMs: number; tokenCount: number };
      asciiFallback?: readonly string[];
    }
  | {
      kind: 'agent_status';
      blockId: string;
      agentId: string;
      status: 'running' | 'queued' | 'error' | 'done';
      lastEvent?: string;
    }
  | {
      kind: 'agent_plan';
      blockId: string;
      ref: string;
      steps: Array<{
        text: string;
        status: 'pending' | 'in-progress' | 'done' | 'skipped';
      }>;
      activeIndex?: number;
    }
  // M4 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — tool.diff
  // and tool.search-hit. Same blockId merge: an Edit/Write tool dispatch
  // pushes one envelope per diff (phase=end), and a Grep/OmniSearch
  // stream phase=delta envelopes with the cumulative hit list. PWA
  // surfaces both as collapsible blocks; M5 wires the actual emit
  // callers on the daemon side.
  | {
      kind: 'tool_diff';
      blockId: string;
      filePath: string;
      language?: string;
      hunks: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }>;
      }>;
      parentToolCallId?: string;
    }
  | {
      kind: 'tool_search_hits';
      blockId: string;
      query: string;
      hits: Array<{
        filePath: string;
        line: number;
        column?: number;
        snippet: string;
        contextBefore?: string[];
        contextAfter?: string[];
      }>;
      /** Cumulative hit count — may exceed `hits.length` when the
       *  server stops streaming raw hits past a cap (truncation). */
      accumCount: number;
      /** Server-side truncation (hit cap reached). */
      truncated?: boolean;
      parentToolCallId?: string;
    }
  // M5 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — tool
  // runtime progress streams (bash stdout/stderr, HTTP body chunks,
  // large file reads). Lines accumulate across phase=delta envelopes
  // so the user sees the running tail. phase=end flips `done` and
  // records the final exitCode.
  | {
      kind: 'tool_progress';
      blockId: string;
      parentToolCallId?: string;
      stream: 'stdout' | 'stderr' | 'http' | 'generic';
      lines: string[];
      bytesSoFar?: number;
      exitCode?: number;
      done: boolean;
    }
  // M6 PR 1 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
  // session-level debug.log mirror block, populated by the
  // `debug.line` envelopes the daemon emits when the PWA opted in via
  // `/chat?debug-tap=on`. One block per session (shared blockId
  // `<sid>:debug:session`); `<DebugTapDrawer>` (M6 PR 2) reads the
  // ring out-of-band so the drawer can live at chat-shell level. Ring
  // cap matches the daemon-side bridge (200 entries · drop oldest).
  | {
      kind: 'debug_session';
      blockId: string;
      lines: Array<{
        seq: number;
        category: string;
        event: string;
        data?: unknown;
        loggedAt: number;
      }>;
    }
  // Opportunistic followup §6.2 #6 (2026-05-13) — `perf.tick`
  // rolling metric stream. One block per session (`<sid>:perf:
  // session`), populated by the daemon's per-turn PerfTicker.
  // Samples cap at 60 (1 minute @ 1Hz) — older samples drop oldest.
  // Renderer `<PerfTickSparkline>` reads the sample list and draws
  // one SVG line per distinct metric name.
  | {
      kind: 'perf_session';
      blockId: string;
      samples: Array<{
        seq: number;
        metric: string;
        value: number;
        unit?: string;
        emittedAt: number;
      }>;
    };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Plain-text rendering — kept as the legacy default for user/meta
   *  messages and for assistant messages that contain only text. When
   *  `blocks` is present + non-empty, ChatMessageView renders the
   *  blocks union and ignores `text`. */
  text: string;
  /** Multimodal block list (Phase B-2). Absent on legacy messages.
   *  Used by `runChatTurnStreaming` to attach image content emitted
   *  via the SSE `image-block` event. */
  blocks?: ChatBlock[];
  timestamp: number;
  /** ⭐ 이 메시지가 «어느 터미널과의» 대화인가 (웹터미널 Chat Dock 전용 · 다른 서피스는 안 채운다).
   *  ⛔ 없으면 배지를 안 그린다 — 채팅 페이지 등 터미널이 없는 화면의 렌더는 그대로다.
   *  📏 왜 필요한가(대표 2026-08-17): 탭을 바꾸면 부제만 바뀌고 «대화는 그대로 남아»,
   *     18:00:39 의 `btop` 문답이 실제로는 `preview-1` 과의 것인데 화면에는
   *     `self_8f9da868` 과 나눈 것처럼 보였다. 대화 자체가 상대를 말해야 한다. */
  terminalId?: string;
  // optional metadata for assistant turns (provider · model · stopReason · tokens · mirror origin)
  meta?: { provider?: string; model?: string; stopReason?: string; mirrored?: 'repl'; systemLevel?: 'note' | 'error' };
}

export interface MetaResult {
  text: string; // rendered as a `meta` message
  newSessionId?: string; // if :fork or :session changes id
  harnessAsk?: { acceptanceId: string };
}

export interface ChatRuntimeContext {
  client: DaemonClient;
  sessionId: string;
  provider: string;
  setSessionId: (id: string) => void;
  /** Daemon HTTP settings for `:budget`. Injected when the caller has them
   *  outside this context (tests, or a surface that does not hold DaemonConfig). */
  daemon?: DaemonHttpConfig;
  /** Current screen message buffer. `:history` summarizes this; it does not
   *  query the server. */
  messages?: readonly ChatMessage[];
}

const HISTORY_DEFAULT_N = 10;
const HISTORY_PREVIEW_CHARS = 80;
const EMPTY_HISTORY_TEXT = '아직 대화가 없습니다';
const BUDGET_UNREAD_TEXT = '예산 상태를 읽지 못했습니다';
const USAGE_UNREAD_TEXT = '남은 양을 읽지 못했습니다';
interface PendingWish {
  id: string;
  baseUrl: string;
  sessionId: string;
  text: string;
  ref: string;
}

const WISH_PENDING_PREFIX = 'elanous:wish:pending:';

function pendingWish(id: string): PendingWish | undefined {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const raw = localStorage.getItem(`${WISH_PENDING_PREFIX}${id}`);
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') return undefined;
  const wish = value as Record<string, unknown>;
  if (wish.id !== id || typeof wish.baseUrl !== 'string' || typeof wish.sessionId !== 'string'
    || typeof wish.text !== 'string' || typeof wish.ref !== 'string'
    || !wish.ref.startsWith(`${wish.sessionId}:`) || !wish.ref.endsWith(`:${id}`)) return undefined;
  return { id, baseUrl: wish.baseUrl, sessionId: wish.sessionId, text: wish.text, ref: wish.ref };
}

function pendingWishes(baseUrl: string, sessionId: string): PendingWish[] {
  const wishes: PendingWish[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(WISH_PENDING_PREFIX)) continue;
    try {
      const wish = pendingWish(key.slice(WISH_PENDING_PREFIX.length));
      if (wish?.baseUrl === baseUrl && wish.sessionId === sessionId) wishes.push(wish);
    } catch { /* A corrupt entry does not hide other pending wishes. */ }
  }
  return wishes;
}

async function fetchChatStatusJson(cfg: DaemonHttpConfig | undefined, path: string): Promise<unknown | null> {
  if (!cfg?.baseUrl) return null;
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
      headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function readUsage(cfg: DaemonHttpConfig | undefined): Promise<UsageBody | undefined> {
  const body = await fetchChatStatusJson(cfg, '/v1/usage');
  if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true
    || !('rows' in body) || !Array.isArray(body.rows)) return undefined;
  return body as UsageBody;
}

async function readCurrentModel(cfg: DaemonHttpConfig | undefined, provider: string): Promise<{ provider: string; model?: string }> {
  const [selection, tier] = await Promise.all([
    fetchChatStatusJson(cfg, '/v1/setup/llm-providers'),
    cfg?.baseUrl ? fetchDaemonModelTier(cfg) : null,
  ]);
  const active = selection && typeof selection === 'object' && 'activeProvider' in selection
    && typeof selection.activeProvider === 'string' && selection.activeProvider
    ? selection.activeProvider : provider;
  return { provider: active,
    ...(selection && isLlmTierProvider(active) && tier?.llm
      ? { model: lookupLlmTierSpec(active, tier.llm).model } : {}) };
}

export function formatBudgetLine(body: BudgetStatusBody): string {
  const usd = Number.isFinite(body.monthSoFarUsd) ? body.monthSoFarUsd : 0;
  return `budget ${body.monthYYYYMM}: $${usd.toFixed(2)} · 알림 ${body.notifyAtPct}%`;
}

export function formatHistoryLines(
  messages: readonly ChatMessage[],
  n = HISTORY_DEFAULT_N,
): string {
  if (messages.length === 0) return EMPTY_HISTORY_TEXT;
  const recent = messages.slice(Math.max(0, messages.length - n));
  return recent
    .map((message) => `${message.role}: ${message.text.slice(0, HISTORY_PREVIEW_CHARS)}`)
    .join('\n');
}

export const META_COMMANDS: readonly { name: string; description: string }[] = [
  { name: 'help', description: '이 도움말 보기' },
  { name: 'session', description: '현재 대화 ID 보기' },
  { name: 'remaining', description: '계정별 남은 양과 초기화 시각 보기' },
  { name: 'status', description: '현재 대화·모델·데몬 판·남은 양 보기' },
  { name: 'fork', description: '현재 대화를 복사해 새 대화로 분기' },
  { name: 'rewind', description: 'N개 사용자 턴 이전으로 분기 (/rewind N)' },
  { name: 'undo', description: '마지막 사용자 턴 이전으로 분기' },
  { name: 'budget', description: '이번 달 지출과 알림 기준 보기' },
  { name: 'history', description: '최근 N개 로컬 대화 요약 (기본 10개, 역할: 앞 80자)' },
  { name: 'clear', description: '로컬 대화 기록 지우기' },
  { name: 'sessions', description: '최근 대화 목록 보기 (/sessions [N])' },
  { name: 'resume', description: '대화 이어가기 (/resume <id 앞자리>)' },
  { name: 'persona', description: '이 대화의 페르소나 보기·고르기·빼기 (/persona [이름|-])' },
  { name: 'model', description: '모델 티어 보기·바꾸기 (/model <티어|별칭>)' },
  { name: 'reasoning', description: '추론 단계 보기·설정 안내 (/reasoning <low|medium|high>)' },
  { name: 'provider', description: '프로바이더 보기·바꾸기 (/provider next|use <이름>)' },
  { name: 'wish', description: '소원을 카드로 남기기 (:wish <소원 한 줄> · :wish --pending · :wish --retry <작업 ID>)' },
  { name: 'run-skill', description: '이름을 댄 스킬 하나 바로 실행 (/run-skill <이름> <할 일>)' },
];

const LOCAL_META_NAMES = ['help', 'session', 'fork', 'budget', 'history', 'clear', 'wish'] as const;
const HELP_TEXT = [
  '메타 명령(:이름 또는 /이름) (Meta commands):',
  ...META_COMMANDS.map(({ name, description }) => `  ${(LOCAL_META_NAMES as readonly string[]).includes(name) ? ':' : '/'}${name.padEnd(16)}${description}`),
].join('\n');

// TUI src/chat/index.ts SLASH_COMMANDS names + aliases (not imported into the PWA bundle).
// Recheck: bun test apps/pwa/src/lib/chat-runtime.meta.test.ts -t 'keeps the local TUI-name snapshot'
const TUI_SLASH_NAMES = new Set([
  'help', '?', 'resume', 'clear', 'cls', 'status', 'st', 'now', 'wish',
  'remaining', 'setup', 'quit', 'q', 'exit', 'run-skill', 'rs', 'run',
  'ad', 'design', 'design-check', 'decide', 'dec',
  'local', 'll', 'session', 'sess', 'persona', 'fork', 'rewind', 'mission',
  'resume-turn', 'context', 'ctx', 'paste', 'sync', 's', 'plugin',
  'plugins', 'widget', 'widgets', 'log', 'loops', 'memory', 'mem', 'export',
  'delta', 'diffs', 'theme', 'debug', 'rebind', 'api-allow', 'api',
  'prompt', 'prompts', 'history', 'hist', 'inputs', 'research', 'rsh',
  'harness', 'plan', 'chat', 'dashboard', 'dash', 'telegram', 'tg',
  'tablet', 'surface', 'term', 'terminal', 'claude', 'codex', 'gemini',
  'acp', 'conv', 'handoff', 'agent-room', 'showroom', 'sr', 'reply',
  'capture', 'inject', 'relay', 'lane', 'control', 'default', 'qc',
  'voice-chat', 'vc', 'auto-tts', 'tts', 'autotts', 'directive',
]);
const PWA_MODEL_ALIASES: Readonly<Record<string, string>> = {
  m: 'model', r: 'reasoning', think: 'reasoning', p: 'provider',
  rs: 'run-skill', run: 'run-skill',
};
const UNSUPPORTED_TUI_SLASH_NAMES = new Set([...TUI_SLASH_NAMES].filter((name) =>
  name !== 'harness' && !Object.hasOwn(PWA_MODEL_ALIASES, name) && !META_COMMANDS.some((command) => command.name === name),
));
const LEGACY_META_SLASH_NAMES = LOCAL_META_NAMES.filter((name) => name !== 'wish').map((name) => `/${name}`).join(' ');

async function forkFromCommand(
  command: 'fork' | 'rewind' | 'undo',
  args: string[],
  ctx: ChatRuntimeContext,
): Promise<MetaResult> {
  const turns = userTurns(ctx.messages ?? []);
  const fail = (outcome: string, text: string): MetaResult => {
    debugLog('webterm.chat.fork', { command, outcome, sessionId: ctx.sessionId });
    return { text };
  };
  if (command === 'fork' && args.length > 0) return fail('invalid', '쓰는 법: /fork');
  if (command === 'undo' && args.length > 0) return fail('invalid', '쓰는 법: /undo');
  if (command === 'rewind' && (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]!))) {
    return fail('invalid', '쓰는 법: /rewind N (양의 정수)');
  }
  const count = command === 'undo' ? 1 : command === 'rewind' ? Number(args[0]) : 0;
  if (command !== 'fork' && (!Number.isSafeInteger(count) || count > turns)) {
    return fail('out-of-range', `되돌릴 사용자 턴이 부족합니다 (${turns}개)`);
  }
  const result = await forkConversation(
    new SessionsStoreApi(ctx.client),
    ctx.sessionId,
    command === 'fork' ? {} : { beforeUser: turns - count + 1 },
  );
  if (result.kind === 'error') return fail('error', `대화 분기 실패 — ${result.error}`);
  if (result.kind === 'empty' && command !== 'fork') {
    return fail('empty', '저장된 대화가 없어 되돌릴 수 없습니다');
  }
  const id = result.kind === 'forked' ? result.id : forkSession();
  debugLog('webterm.chat.fork', {
    command, outcome: result.kind === 'empty' ? 'empty' : 'forked',
    sessionId: ctx.sessionId, newSessionId: id,
    ...(command === 'fork' ? {} : { beforeUser: turns - count + 1 }),
  });
  return {
    text: command === 'fork' ? `forked → new session ${id}` : `${count}개 사용자 턴 이전으로 분기했습니다 → ${id}`,
    newSessionId: id,
  };
}

async function submitHarnessAsk(text: string, ctx: ChatRuntimeContext): Promise<MetaResult> {
  if (!text) return { text: '무엇을 맡길까요? /harness <한 줄>' };
  try {
    const { acceptanceId } = await submitGraph(ctx.client, text);
    return { text: `하니스 접수 · ${acceptanceId.slice(0, 8)}`, harnessAsk: { acceptanceId } };
  } catch (error) {
    const firstLine = (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]!.slice(0, 200);
    return { text: `하니스 접수 실패 — ${firstLine}` };
  }
}

export const META_HANDLERS: Record<
  string,
  (args: string[], ctx: ChatRuntimeContext) => Promise<MetaResult>
> = {
  ':help': async () => ({ text: HELP_TEXT }),
  ':session': async (_args, ctx) => ({ text: `session = ${ctx.sessionId}` }),
  ':remaining': async (_args, ctx) => {
    const usage = await readUsage(ctx.daemon);
    const lines = usage ? remainingLines(usage) : [];
    const ok = usage !== undefined;
    debugLog('webterm.chat.status', { cmd: 'remaining', rows: lines.length, ok });
    return { text: ok ? (lines.length ? lines.join('\n') : '등록된 계정이 없습니다') : USAGE_UNREAD_TEXT };
  },
  ':status': async (_args, ctx) => {
    const [health, usage, selected] = await Promise.all([
      fetchChatStatusJson(ctx.daemon, '/v1/health'), readUsage(ctx.daemon), readCurrentModel(ctx.daemon, ctx.provider),
    ]);
    const version = health && typeof health === 'object' && 'nexusVersion' in health
      && typeof health.nexusVersion === 'string' ? health.nexusVersion : undefined;
    const lines = usage ? remainingLines(usage) : [];
    debugLog('webterm.chat.status', { cmd: 'status', rows: lines.length, ok: !!version || usage !== undefined });
    return { text: statusText({ sessionId: ctx.sessionId, ...selected,
      ...(version ? { version } : {}), ...(usage ? { usage } : {}) }) };
  },
  ':fork': async () => {
    const id = forkSession();
    return { text: `forked → new session ${id}`, newSessionId: id };
  },
  ':rewind': async (args, ctx) => forkFromCommand('rewind', args, ctx),
  ':undo': async (args, ctx) => forkFromCommand('undo', args, ctx),
  ':budget': async (_args, ctx) => {
    const cfg = ctx.daemon;
    if (!cfg?.baseUrl) return { text: BUDGET_UNREAD_TEXT };
    const body = await fetchBudgetStatus(cfg);
    if (!body) return { text: BUDGET_UNREAD_TEXT };
    return { text: formatBudgetLine(body) };
  },
  ':history': async (args, ctx) => {
    const requested = Number(args[0]);
    const n = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : HISTORY_DEFAULT_N;
    return { text: formatHistoryLines(ctx.messages ?? [], n) };
  },
  ':clear': async () => ({ text: '__CLEAR__' }), // sentinel; UI clears its buffer
  ':sessions': async (args, ctx) => handleSessionCommand(parseSessionCommand('sessions', args), ctx),
  ':resume': async (args, ctx) => handleSessionCommand(parseSessionCommand('resume', args), ctx),
  ':persona': async (args, ctx) => ({ text: await handleChatPersona(args, ctx.sessionId, ctx.client, localStorage) }),
  ':model': async (args, ctx) => ({ text: await handleModelCommand(parseModelCommand('model', args), ctx) }),
  ':reasoning': async (args, ctx) => ({ text: await handleModelCommand(parseModelCommand('reasoning', args), ctx) }),
  ':provider': async (args, ctx) => ({ text: await handleModelCommand(parseModelCommand('provider', args), ctx) }),
  ':wish': async (args, ctx) => {
    const text = args.join(' ').trim();
    if (!text) return { text: ':wish <소원 한 줄>' };
    const cfg = ctx.daemon;
    if (!cfg?.baseUrl) return { text: '소원 카드 저장 실패 — 데몬 연결이 없습니다' };
    const baseUrl = cfg.baseUrl.replace(/\/$/, '');
    let wish: PendingWish;
    try {
      if (text === '--pending') {
        const pending = pendingWishes(baseUrl, ctx.sessionId);
        return { text: pending.length
          ? pending.map(({ id, text: pendingText }) => `${id} — ${pendingText}`).join('\n')
          : '재시도할 소원이 없습니다' };
      }
      if (text.startsWith('--retry ')) {
        const id = text.slice('--retry '.length).trim();
        const saved = pendingWish(id);
        if (!saved || saved.baseUrl !== baseUrl || saved.sessionId !== ctx.sessionId) {
          return { text: '소원 카드 저장 실패 — 재시도할 작업을 찾을 수 없습니다' };
        }
        wish = saved;
      } else {
        const id = crypto.randomUUID();
        wish = { id, baseUrl, sessionId: ctx.sessionId, text,
          ref: `${ctx.sessionId}:${Date.now()}:${id}` };
        // Persist before sending: a committed request can lose its response or be interrupted by reload.
        localStorage.setItem(`${WISH_PENDING_PREFIX}${id}`, JSON.stringify(wish));
      }
    } catch (error) {
      return { text: `소원 카드 저장 실패 — 작업 보존 불가: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      const res = await fetch(`${baseUrl}/v1/task-cards/wish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ text: wish.text, ref: wish.ref, sessionId: wish.sessionId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const card: unknown = await res.json();
      if (!card || typeof card !== 'object' || !('title' in card) || typeof card.title !== 'string') throw new Error('잘못된 응답');
      localStorage.removeItem(`${WISH_PENDING_PREFIX}${wish.id}`);
      return { text: `소원 카드로 남겼습니다 — ${card.title}` };
    } catch (error) {
      return { text: `소원 카드 저장 실패 — ${error instanceof Error ? error.message : String(error)} · 재시도: :wish --retry ${wish.id}` };
    }
  },
  ':run-skill': async (args, ctx) => {
    if (args.length < 2) return { text: '쓰는 법: /run-skill <이름> <할 일>' };
    const skill = args[0]!;
    const task = args.slice(1).join(' ');
    const result = await runSkillExec(ctx.daemon, skill, task);
    debugLog('webterm.chat.run-skill', { skill, kind: result.kind });
    if (result.kind === 'rejected') return { text: `이 스킬은 바로 실행할 수 없습니다 — 대화로 «${skill} 으로 …» 라고 부탁해 보세요` };
    if (result.kind === 'failed') return { text: `스킬 실행을 확인하지 못했습니다(${result.error})` };
    const output = result.output.length > 8000 ? `${result.output.slice(0, 8000)}… (잘림)` : result.output;
    return { text: result.ok ? output : `스킬이 실패했습니다\n${output}` };
  },
};

// The existing command catalog is also the legacy help snapshot; keep its enumeration stable.
Object.defineProperty(META_HANDLERS, ':harness', {
  value: async (args: string[], ctx: ChatRuntimeContext) => submitHarnessAsk(args.join(' '), ctx),
});

export function isMetaCommand(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith(':')) return true;
  if (!trimmed.startsWith('/') || trimmed.length < 2 || /\s/.test(trimmed[1]!)) return false;
  const [entered] = trimmed.split(/\s+/);
  return !entered.slice(1).includes('/');
}

export async function dispatchMeta(
  line: string,
  ctx: ChatRuntimeContext,
): Promise<MetaResult | null> {
  const trimmed = line.trim();
  const harnessText = harnessAskText(line);
  if (harnessText !== null && !trimmed.startsWith('/')) return submitHarnessAsk(harnessText, ctx);
  if (!trimmed.startsWith(':') && !trimmed.startsWith('/')) return null;
  const [entered, ...args] = trimmed.split(/\s+/);
  if (entered.startsWith('/') && !isMetaCommand(line)) return null;
  if (entered === '/harness' && harnessText === null) return { text: '무엇을 맡길까요? /harness <한 줄>' };
  const slash = entered.startsWith('/');
  const cmd = slash ? `:${entered.slice(1)}` : entered;
  const alias = slash && Object.hasOwn(PWA_MODEL_ALIASES, entered.slice(1))
    ? PWA_MODEL_ALIASES[entered.slice(1)] : entered.slice(1);
  const key = `:${alias}`;
  // Keep legacy unknown-colon behavior for unrecognized provider subcommands;
  // slash commands use the new parser's available-values response.
  const unknownColonProviderAction = !slash && key === ':provider'
    && args.length > 0 && args[0] !== 'next' && args[0] !== 'use';
  const handler = slash && key === ':fork'
    ? (forkArgs: string[], forkCtx: ChatRuntimeContext) => forkFromCommand('fork', forkArgs, forkCtx)
    : !unknownColonProviderAction && Object.hasOwn(META_HANDLERS, key)
      ? META_HANDLERS[key] : undefined;
  if (!handler) {
    if (slash) {
      const supportedInTui = UNSUPPORTED_TUI_SLASH_NAMES.has(entered.slice(1));
      debugLog('webterm.chat.meta-command', { cmd, outcome: supportedInTui ? 'unsupported-tui' : 'unknown' });
      return { text: supportedInTui
        ? `${entered} 은 PWA 채팅에서 아직 안 됩니다 — 지금 되는 명령: ${LEGACY_META_SLASH_NAMES}`
        : `모르는 명령입니다: ${entered} — /help 로 목록 보기` };
    }
    debugLog('webterm.chat.meta-command', { cmd, outcome: 'unknown' });
    return { text: `unknown meta command: ${entered}` };
  }
  debugLog('webterm.chat.meta-command', { cmd, outcome: 'ok' });
  return handler(args, ctx);
}

export interface RunTurnResult {
  message: ChatMessage;
  newSessionId?: string;
}

/** Phase B-1 / B-2 / B-3 (PWA chat streaming · 2026-05-06) — SSE fallback
 *  via `/v1/prompt/stream`; forwards events to caller hooks and returns
 *  the final `RunTurnResult`.
 *
 *  Phase B-3 — also collects `tool-call` / `tool-result` events.
 *  `tool-call` pushes a tool_use block with status:'running'; the
 *  matching `tool-result` (same id) flips it to done/error + attaches
 *  the summary line. ChatLayout shows these as pills so the user can
 *  see the agent's tool loop in real time. `handlers.signal` is
 *  forwarded to fetch — on abort the daemon's SSE handler detects the
 *  client disconnect and aborts the per-turn controller (server-side).
 */
export interface RunChatTurnStreamingHandlers {
  /** Fires each text-delta event with the cumulative assistant text.
   *  ChatLayout uses this to update a placeholder assistant message
   *  in place so the user sees tokens stream. */
  onPartial?: (full: string) => void;
  /** Phase B-2/B-3 — fires after every block-list mutation (text
   *  growth · image append · tool_use push or status flip). Caller
   *  should re-render the placeholder with the supplied snapshot.
   *  The list is freshly cloned on each call so consumers can store
   *  the reference directly. */
  onPartialBlocks?: (blocks: ChatBlock[]) => void;
  /** Receives the daemon's terminal SSE error payload before the
   *  streaming promise rejects with its message. */
  onError?: (info: { error: string; message?: string; holder?: string }) => void;
  /** Optional fetch-level abort signal — forwarded to `promptStream`.
   *  When fired (Stop button / Esc / navigation) the daemon SSE
   *  stream cancel callback aborts the in-flight LLM turn server-side. */
  signal?: AbortSignal;
  /** P-3 §6.9 (2026-05-07) — multi-part user content. When present and
   *  non-empty, forwarded to the daemon as `userContent` so image /
   *  resource blocks reach the LLM intact. Composer Q1=B convention:
   *  text first, image blocks after. `userText` still travels in the
   *  request body so the daemon's legacy `submit.text` label stays
   *  populated. */
  userContent?: PromptUserContentBlock[];
  /** M6 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
   *  opt-in debug-tap. Propagates to `promptStream` so the request
   *  URL gains `?debug-tap=on` and daemon's debug-bridge activates. */
  debugTap?: boolean;
}

export async function runChatTurnStreaming(
  userText: string,
  ctx: ChatRuntimeContext,
  handlers: RunChatTurnStreamingHandlers = {},
): Promise<RunTurnResult> {
  debugLog('webterm.chat.runturn.stream.start', {
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    len: userText.length,
    contentBlocks: handlers.userContent?.length ?? 0,
  });
  // Phase B-2/B-3 — accumulate blocks alongside the running text.
  // Text block lives at index 0 (created lazily on first delta);
  // images and tool_use pills append in arrival order. tool_use
  // blocks are mutated in place when the matching `tool-result`
  // event lands (status flip from running → done/error). The final
  // ChatMessage exposes `.blocks` whenever at least one non-text
  // block (image OR tool_use) arrived — otherwise legacy `.text`
  // keeps existing renderers untouched.
  const blocks: ChatBlock[] = [];
  let textIdx = -1;
  let imageCount = 0;
  let toolCount = 0;
  let mcpAppCount = 0;
  let feedbackCount = 0;
  const snapshot = (): ChatBlock[] => blocks.map((b) => ({ ...b }));
  /** ⛔⭐⭐⭐ **끝 관측을 «한 자리»에서만 낸다 — 성공이든 실패든.**
   *
   *  📏 2026-08-22 실측(19차 `[F]` · 라이브): 데몬을 재시작한 뒤 탭의 WebSocket 이 죽어 있었고,
   *  턴을 보내니 화면엔 `error: socket closed: 1006` 이 떴는데 ***로그엔 `…stream.start` 만 남고
   *  끝이 «한 줄도» 없었다.*** ⇒ `elanous logs` 로는 「그 턴이 어떻게 됐나」를 물을 자리가 없다.
   *  🔑 ***시작만 내고 실패한 끝을 안 내면, 관측에는 「영원히 도는 턴」으로 남는다.***
   *  ⛔ 그래서 실패 갈래에도 같은 이벤트를 낸다 — 이름을 갈면 조회가 갈린다. */
  const emitEnd = (outcome: {
    stopReason: string | undefined;
    sessionId?: string | undefined;
    error?: string;
  }): void => {
    debugLog('webterm.chat.runturn.stream.end', {
      stopReason: outcome.stopReason,
      sessionId: outcome.sessionId,
      // ⭐ 실패했을 때만 «이유»를 싣는다 — 성공 payload 에 `error: undefined` 를 넣지 않는다.
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      images: imageCount,
      tools: toolCount,
      // ⛔📏 17차 `[F]`: 이 줄이 «없었다» — 이 경로는 `mcpAppCount` 를 «세면서» 안 내보냈다.
      //   ⇒ 대표 위젯 축에서 가장 알고 싶은 값이 세 경로 중 이 경로에서만 보이지 않았다.
      mcpApps: mcpAppCount,
      feedback: feedbackCount,
    });
  };
  const personaId = chatPersonaId(ctx.sessionId);
  const res = await ctx.client.promptStream(
    {
      sessionId: ctx.sessionId || undefined,
      userText,
      ...(handlers.userContent && handlers.userContent.length > 0
        ? { userContent: handlers.userContent }
        : {}),
      provider: ctx.provider || undefined,
      ...(personaId ? { personaId } : {}),
    },
    {
      onError: handlers.onError,
      onTextDelta: ({ full }) => {
        if (textIdx === -1) {
          textIdx = blocks.length;
          blocks.push({ kind: 'text', text: full });
        } else {
          blocks[textIdx] = { kind: 'text', text: full };
        }
        handlers.onPartial?.(full);
        handlers.onPartialBlocks?.(snapshot());
      },
      onImageBlock: ({ src, mediaType, alt }) => {
        imageCount += 1;
        blocks.push(
          alt !== undefined
            ? { kind: 'image', src, mediaType, alt }
            : { kind: 'image', src, mediaType },
        );
        handlers.onPartialBlocks?.(snapshot());
      },
      // M3 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
      // FeedbackEnvelope → block accumulator. Same merge semantics as
      // tool_use (blockId is stable across phases) so ThinkingPill /
      // StatusChip / PlanBlock pulse + finalize from one identity.
      onFeedback: (env) => {
        // HUD segments are process-wide — route them to the standalone
        // hudSegments map instead of the turn-scoped blocks list.
        if (maybeDispatchHudEnvelope(env)) return;
        const result = applyFeedbackEnvelope(blocks, env);
        if (result === 'applied') {
          feedbackCount += 1;
          handlers.onPartialBlocks?.(snapshot());
        }
      },
      onToolCall: ({ id, name, args }) => {
        toolCount += 1;
        blocks.push({
          kind: 'tool_use',
          id,
          name,
          status: 'running',
          startedAt: Date.now(),
          args,
        });
        handlers.onPartialBlocks?.(snapshot());
      },
      onToolResult: ({ id, name, ok, summary, rawOutput, resourceUri }) => {
        // Find the matching running pill. If no match (rare —
        // server fired result before call, or pill list mutated),
        // synthesize a fresh done pill so the user still sees the
        // tool happened.
        const idx = blocks.findIndex(
          (b) => b.kind === 'tool_use' && b.id === id,
        );
        const status: 'done' | 'error' = ok ? 'done' : 'error';
        const sources = name === 'context_now' ? contextSources(rawOutput, Date.now()) : null;
        if (idx === -1) {
          // Synthesized pill counts toward the non-text gate so the
          // finalized ChatMessage still attaches `.blocks`.
          toolCount += 1;
          blocks.push({
            kind: 'tool_use',
            id,
            name,
            status,
            startedAt: Date.now(),
            endedAt: Date.now(),
            ...(summary !== undefined ? { summary } : {}),
            ...(sources !== null ? { sources } : {}),
          });
        } else {
          const prev = blocks[idx] as Extract<ChatBlock, { kind: 'tool_use' }>;
          const updated = {
            ...prev,
            status,
            endedAt: Date.now(),
            ...(summary !== undefined ? { summary } : {}),
            ...(sources !== null ? { sources } : {}),
          };
          if (sources === null) delete updated.sources;
          blocks[idx] = updated;
        }
        pushToolCards(blocks, rawOutput);
        if (typeof resourceUri === 'string' && resourceUri.trim().length > 0) {
          mcpAppCount += 1;
          const payload = parseMcpAppPayload(rawOutput, resourceUri);
          blocks.push({
            kind: 'mcp_app',
            toolId: id,
            toolName: name,
            screenUrl: resourceUri,
            ...(rawOutput !== undefined ? { toolResult: rawOutput } : {}),
            ...(payload ? payload : {}),
            ...(summary !== undefined ? { fallbackText: summary } : {}),
          });
        }
        handlers.onPartialBlocks?.(snapshot());
      },
      ...(handlers.signal ? { signal: handlers.signal } : {}),
      ...(handlers.debugTap === true ? { debugTap: true } : {}),
    },
    // ⛔⭐ `.catch` 로 잡는다 — 본문 110줄을 `try {}` 로 감싸 «들여쓰기만» 바꾸는 diff 를 피한다.
    //   ⚠️ 되던지므로(`throw`) 호출자 계약은 불변이다 — 관측 한 줄만 «더» 나갈 뿐이다.
  ).catch((err: unknown) => {
    emitEnd({
      stopReason: handlers.signal?.aborted === true ? 'aborted' : 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  });
  emitEnd({ stopReason: res.stopReason, sessionId: res.sessionId });
  // Reconcile: ensure the final text block matches `res.text` (the
  // server's authoritative copy) so a missed-tail delta doesn't
  // truncate the bubble. If the daemon never emitted text-delta
  // (rare — text-only turn aborted before tokens) we still surface
  // the final text via legacy `.text`.
  if (textIdx !== -1 && res.text) {
    blocks[textIdx] = { kind: 'text', text: res.text };
  }
  const hasNonTextBlock = imageCount > 0 || toolCount > 0 || mcpAppCount > 0 || feedbackCount > 0;
  const message: ChatMessage = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    text: res.text ?? '',
    timestamp: Date.now(),
    meta: { provider: ctx.provider, stopReason: res.stopReason },
    ...(hasNonTextBlock ? { blocks: snapshot() } : {}),
  };
  return {
    message,
    newSessionId: res.sessionId !== ctx.sessionId ? res.sessionId : undefined,
  };
}

export function newUserMessage(text: string, terminalId?: string): ChatMessage {
  return {
    id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'user',
    text,
    timestamp: Date.now(),
    ...(terminalId ? { terminalId } : {}),
  };
}

export function newMetaMessage(text: string, terminalId?: string): ChatMessage {
  return {
    id: `meta-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'meta',
    text,
    timestamp: Date.now(),
    ...(terminalId ? { terminalId } : {}),
  };
}

/** Phase B-4 follow-up (PWA chat streaming · 2026-05-06) — observer
 *  callbacks for `runChatTurnObserver`. Mirrors the placeholder
 *  semantics ChatLayout uses for its own POST turns: a `turn-begin`
 *  asks the host to push an empty assistant placeholder; subsequent
 *  events grow the bubble; `turn-end` finalizes (replaces with the
 *  authoritative ChatMessage). The host returns a placeholder id from
 *  `onPlaceholder` so the runtime can route delta updates back to
 *  the same bubble.
 *
 *  `isLocalTurnInFlight()` is the dedupe gate — when ChatLayout has
 *  its own POST mid-stream for this session, the observer events
 *  duplicate the same wire (the bus fans out POST events too). The
 *  host returns `true` and the runtime drops the event so the local
 *  POST handler stays the sole owner of that turn's bubble.
 */
export interface ChatObserverHandlers {
  /** Called on `turn-begin`. Host inserts a fresh assistant
   *  placeholder ChatMessage and returns its id; the runtime stores
   *  the id and routes subsequent deltas back via the other hooks.
   *  Return `null` to skip the turn entirely (e.g., the runtime's
   *  built-in dedupe check is enough but the host has its own veto). */
  onPlaceholder: (info: { sessionId: string }) => string | null;
  /** Called on each `text-delta` / `image-block` / `tool-call` /
   *  `tool-result` after the placeholder is allocated. `blocks` is
   *  the full snapshot the host should render. */
  onPartialBlocks: (placeholderId: string, blocks: ChatBlock[]) => void;
  /** Called on `turn-end`. `finalMessage` is the authoritative bubble
   *  the host should swap into the placeholder slot. */
  onFinalize: (placeholderId: string, finalMessage: ChatMessage) => void;
  /** Called on terminal `error` event for the current remote turn.
   *  Host typically tags the placeholder with stopReason='error' or
   *  drops it. */
  onError?: (placeholderId: string, info: { error: string; message?: string }) => void;
  /** Dedupe gate — when the host has a local POST in flight for this
   *  session, return `true` and the observer drops the duplicate
   *  events. Default `false` (no dedupe) lets every event through. */
  isLocalTurnInFlight?: () => boolean;
  /** Provider tag for the synthesized placeholder ChatMessage.meta. */
  provider?: string;
}

/** Phase B-4 follow-up — long-lived observer for chat events on the
 *  current session. Translates the SSE wire (turn-begin / text-delta
 *  / image-block / tool-call / tool-result / turn-end) into the
 *  same placeholder + block lifecycle that ChatLayout uses for its
 *  local POST turns. Returns a disposer that ends the subscription.
 *
 *  A "remote turn" is the span between turn-begin and turn-end. The
 *  runtime owns one in-flight remote turn at a time per
 *  subscription; concurrent turns for the same session are rare in
 *  practice (LLM session is serial) and a second turn-begin
 *  finalizes the prior placeholder with whatever blocks accumulated.
 */
export function runChatTurnObserver(
  client: DaemonClient,
  sessionId: string,
  handlers: ChatObserverHandlers,
): () => void {
  // Per-remote-turn state. Reset on each turn-begin.
  let placeholderId: string | null = null;
  const blocks: ChatBlock[] = [];
  let textIdx = -1;
  let imageCount = 0;
  let toolCount = 0;
  let mcpAppCount = 0;
  let feedbackCount = 0;
  let dropCurrentTurn = false;

  const resetTurn = (): void => {
    placeholderId = null;
    blocks.length = 0;
    textIdx = -1;
    imageCount = 0;
    toolCount = 0;
    mcpAppCount = 0;
    feedbackCount = 0;
    dropCurrentTurn = false;
  };

  const snapshot = (): ChatBlock[] => blocks.map((b) => ({ ...b }));

  return client.subscribeChatEvents(sessionId, {
    onTurnBegin: (info) => {
      // If a previous remote turn never received turn-end (rare —
      // disconnect mid-stream), wipe its in-flight state before
      // starting the new turn so blocks don't carry over.
      resetTurn();
      // Dedupe — local POST owns this turn's bubble.
      if (handlers.isLocalTurnInFlight?.()) {
        dropCurrentTurn = true;
        return;
      }
      const id = handlers.onPlaceholder({ sessionId: info.sessionId });
      if (id === null) {
        dropCurrentTurn = true;
        return;
      }
      placeholderId = id;
    },
    onTextDelta: ({ full }) => {
      if (dropCurrentTurn || placeholderId === null) return;
      if (textIdx === -1) {
        textIdx = blocks.length;
        blocks.push({ kind: 'text', text: full });
      } else {
        blocks[textIdx] = { kind: 'text', text: full };
      }
      handlers.onPartialBlocks(placeholderId, snapshot());
    },
    onImageBlock: ({ src, mediaType, alt }) => {
      if (dropCurrentTurn || placeholderId === null) return;
      imageCount += 1;
      blocks.push(
        alt !== undefined
          ? { kind: 'image', src, mediaType, alt }
          : { kind: 'image', src, mediaType },
      );
      handlers.onPartialBlocks(placeholderId, snapshot());
    },
    // M3 — same accumulator as the self-turn path so multi-tab
    // observers see the identical block lifecycle for thinking /
    // status / plan envelopes.
    onFeedback: (env) => {
      // HUD segments are process-wide — bypass the per-turn drop guard
      // so multi-tab observers stay in sync even when a turn aborted.
      if (maybeDispatchHudEnvelope(env)) return;
      if (dropCurrentTurn || placeholderId === null) return;
      const result = applyFeedbackEnvelope(blocks, env);
      if (result === 'applied') {
        feedbackCount += 1;
        handlers.onPartialBlocks(placeholderId, snapshot());
      }
    },
    onToolCall: ({ id, name, args }) => {
      if (dropCurrentTurn || placeholderId === null) return;
      toolCount += 1;
      blocks.push({ kind: 'tool_use', id, name, status: 'running', startedAt: Date.now(), args });
      handlers.onPartialBlocks(placeholderId, snapshot());
    },
    onToolResult: ({ id, name, ok, summary, rawOutput, resourceUri }) => {
      if (dropCurrentTurn || placeholderId === null) return;
      const idx = blocks.findIndex(
        (b) => b.kind === 'tool_use' && b.id === id,
      );
      const status: 'done' | 'error' = ok ? 'done' : 'error';
      const sources = name === 'context_now' ? contextSources(rawOutput, Date.now()) : null;
      if (idx === -1) {
        toolCount += 1;
        blocks.push({
          kind: 'tool_use',
          id,
          name,
          status,
          startedAt: Date.now(),
          endedAt: Date.now(),
          ...(summary !== undefined ? { summary } : {}),
          ...(sources !== null ? { sources } : {}),
        });
      } else {
        const prev = blocks[idx] as Extract<ChatBlock, { kind: 'tool_use' }>;
        const updated = {
          ...prev,
          status,
          endedAt: Date.now(),
          ...(summary !== undefined ? { summary } : {}),
          ...(sources !== null ? { sources } : {}),
        };
        if (sources === null) delete updated.sources;
        blocks[idx] = updated;
      }
      pushToolCards(blocks, rawOutput);
      if (typeof resourceUri === 'string' && resourceUri.trim().length > 0) {
        mcpAppCount += 1;
        const payload = parseMcpAppPayload(rawOutput, resourceUri);
        blocks.push({
          kind: 'mcp_app',
          toolId: id,
          toolName: name,
          screenUrl: resourceUri,
          // ⛔⭐⭐⭐ 📏 2026-08-22 라이브(16차 `[F]`): ***이 한 줄이 «없어서» 위젯이 영영 비어 있었다.***
          //   같은 블록을 만드는 자리가 «둘»인데(`runChatTurnStreaming` ⊕ 여기),
          //   결과를 싣는 것은 저쪽뿐이었다 — 그리고 PWA 채팅이 실제로 쓰는 것은 «이쪽»이다.
          //   ⇒ 위젯은 규범대로 악수를 걸고, 브리지는 응답까지 했는데, ***밀 것이 없었다.***
          //   📋 그것을 말해 준 것이 이 PR 이 심은 관측이다:
          //     `mcp-app.bridge.attach {"hasTool":true,"hasToolResult":false,"skipped":"no-tool-result"}`
          //   ⛔ 이 저장소가 이름 붙인 「배선」 형태의 네 번째 재판이다(15차 §2 ②는 셋을 잡았다).
          ...(rawOutput !== undefined ? { toolResult: rawOutput } : {}),
          ...(payload ? payload : {}),
          ...(summary !== undefined ? { fallbackText: summary } : {}),
        });
      }
      handlers.onPartialBlocks(placeholderId, snapshot());
    },
    onTurnEnd: (res) => {
      if (dropCurrentTurn || placeholderId === null) {
        // ⛔⭐📏 17차 `[F]`: 이 갈래는 «조용히» 버려지고 있었다.
        //   다른 탭의 턴이 화면에 «안 그려졌을» 때 그 이유를 물을 자리가 없었다.
        //   ⇒ 「버렸다」와 「왜」를 남긴다. 세지 «않은» 것은 넣지 않는다 —
        //     블록을 누적하지 않은 갈래라 0 을 내면 「측정 불가」가 「없다」로 둔갑한다.
        debugLog('webterm.chat.runturn.observer.end', {
          sessionId,
          stopReason: res.stopReason,
          dropped: true,
          reason: dropCurrentTurn ? 'dropped-turn' : 'no-placeholder',
        });
        resetTurn();
        return;
      }
      if (textIdx !== -1 && res.text) {
        blocks[textIdx] = { kind: 'text', text: res.text };
      }
      const hasNonTextBlock = imageCount > 0 || toolCount > 0 || mcpAppCount > 0 || feedbackCount > 0;
      // ⛔⭐📏 17차 `[F]`: 이 경로에는 ***끝 관측이 통째로 없었다.***
      //   나머지 둘(`stream.end` · `acp.end`)은 내고 있었다 — ***셋 중 하나만 빠졌다.***
      //   🔑 16차 §2d 가 「블록을 만드는 자리 셋 중 둘만 결과를 실었다」를 찾았는데,
      //     ***같은 부류가 「관측」 축에서 반복되고 있었다*** — 그리고 관측 결손은
      //     사용자 눈에 안 보이므로 «아무도 못 본다».
      debugLog('webterm.chat.runturn.observer.end', {
        sessionId,
        stopReason: res.stopReason,
        dropped: false,
        images: imageCount,
        tools: toolCount,
        mcpApps: mcpAppCount,
        feedback: feedbackCount,
      });
      const finalMessage: ChatMessage = {
        id: `m-obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        text: res.text ?? '',
        timestamp: Date.now(),
        meta: {
          ...(handlers.provider ? { provider: handlers.provider } : {}),
          stopReason: res.stopReason,
        },
        ...(hasNonTextBlock ? { blocks: snapshot() } : {}),
      };
      handlers.onFinalize(placeholderId, finalMessage);
      resetTurn();
    },
    onError: (info) => {
      if (placeholderId !== null && handlers.onError) {
        handlers.onError(placeholderId, info);
      }
      resetTurn();
    },
  });
}

/** CV-1b (PLAN-pwa-webterm-voice-control v1.2 §5 · 2026-05-07) — chat client's
 *  self-turn ACP path. Replaces the legacy SSE `/v1/prompt/stream` route for
 *  chat's own POST: caller mounts a short-lived listener on the long-lived
 *  ACP connection, fires `session/prompt` RPC, accumulates `session/update`
 *  chunks into a block list, returns a `RunTurnResult` with the same shape
 *  as `runChatTurnStreaming` so the call-site swap stays minimal.
 *
 *  Why a short-lived listener (and not the long-lived
 *  `runAcpForeignTurnObserver` already mounted by ChatLayout)? Isolation —
 *  the foreign-turn observer drops self chunks via `isLocalTurnInFlight`
 *  (CV-1a Q1=A1 dedup), and this function owns the self-turn placeholder
 *  lifecycle (callbacks fire onPartial/onPartialBlocks; final ChatMessage
 *  reconciles from accumulated text). Both listeners coexist on the same
 *  WebSocket; dedup keeps them mutually exclusive.
 *
 *  Abort path — `handlers.signal` triggers an ACP `session/cancel`
 *  notification; daemon-side `acpServerBeginPrompt` flips the session's
 *  aborted flag and the in-flight `runTurn` short-circuits. The caller's
 *  Stop button / Esc shortcut both wire here. */
export interface RunChatTurnAcpHandlers {
  signal?: AbortSignal;
  /** Cumulative assistant text per delta (chat REST `onPartial` mirror). */
  onPartial?: (full: string) => void;
  /** Block-list snapshot after every text-delta / image / tool_use event. */
  onPartialBlocks?: (blocks: ChatBlock[]) => void;
  /** P-3 §6.9 multi-part user content (image / resource_link blocks). When
   *  present, replaces the default `[{type:'text', text: userText}]`. */
  userContent?: PromptUserContentBlock[];
}

export async function runChatTurnAcp(
  acp: AcpConnection,
  userText: string,
  ctx: ChatRuntimeContext,
  handlers: RunChatTurnAcpHandlers = {},
): Promise<RunTurnResult> {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    throw new Error('runChatTurnAcp: sessionId required (daemon handshake first)');
  }
  const blocks: ChatBlock[] = [];
  let textIdx = -1;
  let imageCount = 0;
  let toolCount = 0;
  // ⭐ 스트리밍 경로와 «같은 이름»으로 센다 — 두 경로를 한 조회로 비교할 수 있어야 한다.
  let mcpAppCount = 0;
  let cumulativeText = '';
  // ⛔⭐⭐⭐ **에이전트의 「생각」** — 대표 2026-08-22 결정(*"보여주시죠"*).
  //
  //  📏 17차 `[F]` 실측: 이 경로는 `session/update` 중 «셋»만 봤다
  //    (`agent_message_chunk` · `tool_call` · `tool_call_update`).
  //  ⛔ 그런데 ***ACP 규범에는 `agent_thought_chunk` 가 있고 데몬은 그것을 처리한다***
  //    (`src/acp/event-router.ts` — thought 블록을 누적한다). PWA 는 그 이름을 «어디서도» 안 봤다
  //    (전수 0건). ⇒ 그리고 16차 §2d 가 못 박았듯 ***`ChatLayout` 은 데몬이 있으면 이 길을 탄다***
  //    = 평소 쓰는 길에서 생각·계획이 통째로 사라지고 있었다.
  //
  //  ⭐ 누적 규칙은 **데몬과 «대칭»**으로 맞춘다(`event-router.ts` 의 flush 로직):
  //    ⓐ thought 청크가 오면 한 블록에 누적한다(여러 블록으로 쪼개지 않는다).
  //    ⓑ ***어시스턴트 «본문»이 시작되면 그 생각은 닫힌다***(`done: true` → 렌더러가 ✓ 로 바꾼다).
  //    ⛔ 그 반대(생각이 본문을 닫는다)는 «하지 않는다» — 본문은 턴 끝에 확정된다.
  let thoughtIdx = -1;
  let cumulativeThought = '';
  let thoughtCount = 0;
  let appliedFeedbackEnvelopeCount = 0;
  /** ⭐ 「생각 채널로 왔지만 생각이 아닌 것」의 수 — 아래 봉투 주석이 이유의 canonical.
   *  ⛔ 세면 «반드시» 내보낸다(자 `turn-end-observation` 이 강제한다). */
  let feedbackEnvelopeChunks = 0;
  /** ⛔ 어시스턴트 본문이 시작되면 진행 중인 생각을 «닫는다». 없으면 no-op.
   *  @returns 이번 호출이 «실제로» 닫았으면 true — 화면 갱신이 필요한지 부르는 쪽이 안다. */
  const closeActiveThought = (): boolean => {
    if (thoughtIdx === -1) return false;
    const prev = blocks[thoughtIdx] as Extract<ChatBlock, { kind: 'agent_thinking' }>;
    if (prev.done) return false;
    blocks[thoughtIdx] = { ...prev, done: true };
    return true;
  };
  const snapshot = (): ChatBlock[] => blocks.map((b) => ({ ...b }));

  const off = acp.on('sessionUpdate', (frame: AcpFrame) => {
    const params = frame.params as AcpSessionUpdateParams | undefined;
    if (!params || params.sessionId !== sessionId) return;
    const update = params.update;
    if (!update) return;

    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content;
      if (
        content?.type === 'text'
        && typeof content.text === 'string'
        && content.text.length > 0
      ) {
        const delta = content.text;
        cumulativeText += delta;
        if (textIdx === -1) {
          // ⛔⭐ 본문이 «시작되는» 순간 진행 중인 생각을 닫는다(데몬 flush 로직과 대칭).
          closeActiveThought();
          textIdx = blocks.length;
          blocks.push({ kind: 'text', text: cumulativeText });
        } else {
          blocks[textIdx] = { kind: 'text', text: cumulativeText };
        }
        handlers.onPartial?.(cumulativeText);
        handlers.onPartialBlocks?.(snapshot());
      } else if (
        content?.type === 'image'
        && typeof content.data === 'string'
        && typeof content.mimeType === 'string'
      ) {
        imageCount += 1;
        const imgBlock: Extract<ChatBlock, { kind: 'image' }> = {
          kind: 'image',
          src: content.data,
          mediaType: content.mimeType,
        };
        if (typeof content.uri === 'string') imgBlock.alt = content.uri;
        // ⛔⭐⭐ **이미지도 「본문의 시작」이다** — 무인 리뷰 must-fix(사후 리뷰 · PR #11308):
        //   *"이미지 분기는 `closeActiveThought()` 를 호출하지 않아, 생각 뒤에 «이미지 본문만»
        //   오는 턴에서는 완료될 때까지 `done=false` 가 유지된다."*
        //   🔑 「본문이 시작되면 생각을 닫는다」는 규칙은 ***텍스트에만* 걸린 규칙이 아니다.**
        closeActiveThought();
        blocks.push(imgBlock);
        handlers.onPartialBlocks?.(snapshot());
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      // ⛔⭐⭐⭐ 대표 2026-08-22 결정으로 «신설». 위 `thoughtIdx` 주석이 이유와 규칙의 canonical.
      const content = update.content;
      if (content?.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
        // ⛔⭐⭐⭐ **이 채널에는 「생각」만 오는 게 아니다** — 📏 라이브 실측(2026-08-22):
        //   `src/acp/elanous-extensions.ts` 가 ***FeedbackEnvelope 을 `agent_thought_chunk` text
        //   「위에」 싣는다***(ACP SDK 가 커스텀 sessionUpdate 를 거부해서 그렇게 했다).
        //   ⇒ 그래서 이 배선을 켠 «첫 라이브»에서 화면에 ***`<<elanous-feedback-end …>>` 원시 마커가
        //     그대로 샜다*** — 내가 낸 회귀다(켜기 전엔 이 채널을 통째로 무시했으니 안 보였다).
        //   🔑 ⇒ 봉투는 «생각이 아니다». 여기서 그리지 않는다.
        const feedbackEnvelope = parseElanousFeedbackEnvelope(content.text);
        if (feedbackEnvelope) {
          if (!maybeDispatchHudEnvelope(feedbackEnvelope.payload)) {
            const result = applyFeedbackEnvelope(blocks, feedbackEnvelope.payload);
            if (result === 'applied') {
              appliedFeedbackEnvelopeCount += 1;
              handlers.onPartialBlocks?.(snapshot());
            }
          }
          return;
        }
        // A feedback-shaped but malformed wire remains suppressed so raw
        // markers cannot leak into the thought renderer.
        if (FEEDBACK_ENVELOPE_HEAD.test(content.text)) {
          feedbackEnvelopeChunks += 1;
          return;
        }
        cumulativeThought += content.text;
        if (thoughtIdx === -1) {
          thoughtCount += 1;
          thoughtIdx = blocks.length;
          // ⚠️ `blockId` 는 상대가 «안 준다» — 이 턴 안에서만 유일하면 되므로 합성한다
          //   (라이브 병합 키로만 쓰이고 저장·라우팅에는 안 쓰인다).
          blocks.push({ kind: 'agent_thinking', blockId: `acp-thought-${sessionId}`, msg: cumulativeThought, done: false });
        } else {
          const prev = blocks[thoughtIdx] as Extract<ChatBlock, { kind: 'agent_thinking' }>;
          blocks[thoughtIdx] = { ...prev, msg: cumulativeThought };
        }
        handlers.onPartialBlocks?.(snapshot());
      }
    } else if (update.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
      toolCount += 1;
      blocks.push({
        kind: 'tool_use',
        id: update.toolCallId,
        name: update.title ?? '',
        status: 'running',
        startedAt: Date.now(),
        ...(update.rawInput ? { args: update.rawInput } : {}),
      });
      handlers.onPartialBlocks?.(snapshot());
    } else if (update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string') {
      const idx = blocks.findIndex(
        (b) => b.kind === 'tool_use' && b.id === update.toolCallId,
      );
      const status: 'done' | 'error' = update.status === 'completed' ? 'done' : 'error';
      if (idx === -1) {
        toolCount += 1;
        blocks.push({
          kind: 'tool_use',
          id: update.toolCallId,
          name: update.title ?? '',
          status,
          startedAt: Date.now(),
          endedAt: Date.now(),
          ...(update.title ? { summary: update.title } : {}),
        });
      } else {
        const prev = blocks[idx] as Extract<ChatBlock, { kind: 'tool_use' }>;
        blocks[idx] = {
          ...prev,
          status,
          endedAt: Date.now(),
          ...(update.title ? { summary: update.title } : {}),
        };
      }
      // ⛔⭐⭐⭐ **위젯 블록은 «여기»에도 있어야 한다 — 이 경로가 살아 있는 길이다.**
      //
      //  📏 2026-08-21 실측으로 이 자리를 찾았다. 데몬은 위젯 주소를 «제대로» 보낸다:
      //    `acp-push-tool-result | keys=['output','structured','_meta']
      //     | uri=ui://higgsfield/generation-v2.html`
      //  ⛔ 그런데 이 처리기는 «알약만» 갱신하고 `rawOutput` 을 아예 안 봤다.
      //    스트리밍 경로엔 있는 블록 생성이 ACP 경로엔 «없었고»,
      //    `ChatLayout` 은 데몬이 있으면 ***ACP 경로를 탄다***(`useAcpPath`).
      //    ⇒ 그래서 앞의 열 조각이 전부 통과하는데도 위젯이 «영영» 안 떴다.
      //  ⛔ 「두 경로가 같은 일을 한다」고 «가정»하지 않는다 — 이 저장소에서 그 가정이 여러 번 틀렸다.
      // ⭐ 결과에 이미지가 있으면 «그려서» 보여 준다 — 링크만 남기지 않는다(대표 2026-08-21).
      pushToolCards(blocks, update.rawOutput);
      for (const img of mcpResultImages(update.rawOutput)) {
        if (blocks.some((b) => b.kind === 'image' && b.src === img.src)) continue;
        imageCount += 1;
        blocks.push({ kind: 'image', ...img });
      }
      const acpResourceUri = mcpAppResourceUriOf(update.rawOutput);
      if (acpResourceUri) {
        mcpAppCount += 1;
        const payload = parseMcpAppPayload(update.rawOutput, acpResourceUri);
        blocks.push({
          kind: 'mcp_app',
          toolId: update.toolCallId,
          toolName: update.title ?? '',
          screenUrl: acpResourceUri,
          // ⛔⭐⭐⭐ 📏 2026-08-22 라이브(16차 `[F]`): ***이 한 줄이 없어서 위젯이 「뜨긴 하고 비어 있었다」.***
          //
          //  15차가 위 주석대로 이 경로에 블록 «생성»을 세웠고 — 그래서 위젯은 화면에 «떴다».
          //  그런데 ***결과를 싣는 것을 빠뜨렸다.*** 위젯은 규범대로 악수를 걸고(`ui/initialize`),
          //  브리지는 응답까지 했는데, **밀 것이 없어** 「Connecting…」 또는 빈 상자로 남았다.
          //  📋 추론이 아니라 «관측»이 이 자리를 가리켰다(같은 PR 이 심었다):
          //    `mcp-app.bridge.attach {"hasTool":true,"hasToolResult":false,"skipped":"no-tool-result"}`
          //  ⛔⭐ 그리고 이 자리는 «전수로 세서» 찾았다 — 그때 `kind: 'mcp_app'` 을 만드는 곳이 «셋»인데
          //    결과를 싣는 곳은 «둘»이었다. 두 곳만 보고 「고쳤다」고 했으면 또 틀렸다.
          //
          //  ⚠️📏 **그 「셋」은 늙었다 — 2026-08-22(17차 `[F]`) 실측으로 «넷»이다**
          //    (streaming · observer · ACP ⊕ **복원** `session-restore.ts`).
          //    ✅ 넷 다 결과를 싣는다(실측). ⛔ 그러나 ***이 축에는 아직 «자»가 없다*** —
          //    다섯째 자리가 생기면 또 조용히 빠진다.
          //  🩹 제안(17차): 블록을 만드는 «팩토리 하나»로 접어라. 그러면 자리가 한 집이 되고,
          //    결과가 없을 때 팩토리가 «말하게» 할 수 있다.
          //  ⛔ 수를 여기 다시 적지 말고 «그때» 세라 — ⭐ **줄 «전체»가 그것인 자리만** 센다:
          //      rg -n "^\s*kind: 'mcp_app',$" apps/pwa/src -g '!*.test.*'
          //    ⛔📏 처음엔 `$` 없이 적었더니 ***이 주석 자신이 세어져 5가 나왔다.***
          //    🔑 ***「재는 명령」을 적을 때는 그 명령이 «내 글»에 걸리지 않는지도 재야 한다.***
          ...(update.rawOutput !== undefined ? { toolResult: update.rawOutput } : {}),
          ...(payload ? payload : {}),
          ...(update.title ? { fallbackText: update.title } : {}),
        });
      }
      handlers.onPartialBlocks?.(snapshot());
    }
  });

  const onAbort = (): void => {
    void acp.send('session/cancel', { sessionId }).catch(() => {});
  };
  const signal = handlers.signal;
  if (signal) {
    if (signal.aborted) {
      off();
      throw new Error('aborted');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const promptBlocks: PromptUserContentBlock[] = handlers.userContent && handlers.userContent.length > 0
    ? handlers.userContent
    : [{ type: 'text', text: userText }];

  debugLog('webterm.chat.runturn.acp.start', {
    sessionId,
    provider: ctx.provider,
    len: userText.length,
    blocks: promptBlocks.length,
  });

  /** ⛔⭐⭐⭐ **끝 관측을 «한 자리»에서만 낸다 — 성공이든 실패든**(위 `runChatTurnStreaming` 과 같은 이유).
   *  📏 19차 `[F]` 라이브: 죽은 소켓 위로 턴을 보내니 `acp.start` 만 남고 끝이 «없었다». */
  const emitEnd = (outcome: { stopReason: string; error?: string }): void => {
    debugLog('webterm.chat.runturn.acp.end', {
      sessionId,
      stopReason: outcome.stopReason,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      textLen: cumulativeText.length,
      images: imageCount,
      tools: toolCount,
      mcpApps: mcpAppCount,
      // ⭐ 대표 결정으로 신설한 축 — ⛔ 세면 «반드시» 내보낸다(자 `turn-end-observation` 이 강제한다).
      thoughts: thoughtCount,
      // ⭐ 「생각 채널로 왔지만 생각이 아닌 것」 — 봉투 배선이 붙기 «전»까지 이 수가 그 크기를 말한다.
      feedbackEnvelopes: feedbackEnvelopeChunks,
    });
  };

  try {
    const personaId = chatPersonaId(sessionId);
    const res = (await acp.send('session/prompt', {
      sessionId,
      prompt: promptBlocks,
      ...(personaId ? { _meta: { elanous: { pwaPersonaId: personaId } } } : {}),
    })) as { stopReason?: string } | undefined;
    const stopReason = res?.stopReason ?? 'end_turn';
    // ⛔⭐ 턴이 끝났는데 생각이 «열린 채»면 닫는다 — 본문 없이 끝나는 턴(툴만 돈 경우)이 있다.
    //   그대로 두면 렌더러가 영영 맥박치는 알약을 그린다.
    closeActiveThought();
    emitEnd({ stopReason });
    const hasNonTextBlock = imageCount > 0 || toolCount > 0 || mcpAppCount > 0 || thoughtCount > 0 || appliedFeedbackEnvelopeCount > 0;
    const message: ChatMessage = {
      id: `m-acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      text: cumulativeText,
      timestamp: Date.now(),
      meta: { provider: ctx.provider, stopReason },
      ...(hasNonTextBlock ? { blocks: snapshot() } : {}),
    };
    // ACP `session/prompt` response carries no sessionId — caller bound the
    // session at handshake time (connectAcp({sessionId})). newSessionId is
    // undefined by definition; ChatLayout's setSessionId stays a no-op for
    // self ACP turns.
    return { message };
  } catch (err) {
    // ⛔⭐⭐⭐ **실패한 턴도 「끝」을 낸다.** 안 그러면 관측에는 ***시작만 있고 끝이 없는 턴***이 남고,
    //   그것은 「도는 중」과 구별되지 않는다. ⚠️ 되던져서 호출자 계약은 불변으로 둔다.
    emitEnd({
      stopReason: signal?.aborted === true ? 'aborted' : 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    // ⛔⭐⭐ **실패·중단에도 「생각」을 닫는다** — 무인 리뷰 must-fix(사후 리뷰 · PR #11308):
    //   *"`acp.send()` 가 reject/abort 되면 정상 반환 «뒤에만» 있는 `closeActiveThought()` 가
    //   실행되지 않아 ***열린 ThinkingPill 이 남는다***."*
    //   🔑 맥박치는 알약은 「아직 생각 중」이라고 «거짓말»한다 — 턴은 이미 죽었는데.
    //   ⚠️ 정상 경로에서 이미 닫혔으면 이 호출은 no-op 이다(`done` 을 다시 세우지 않는다).
    //   ⛔⭐⭐ **닫기만 하면 «화면은 그대로 맥박친다»** — 실패 경로는 `message` 를 반환하지 못하므로
    //     ***호출자가 블록을 다시 받을 길이 이 콜백뿐이다.*** 그래서 실제로 닫았을 때만 스냅샷을 보낸다.
    if (closeActiveThought()) handlers.onPartialBlocks?.(snapshot());
    if (signal) signal.removeEventListener('abort', onAbort);
    off();
  }
}

/** CV-1 (PLAN-pwa-webterm-voice-control v1.2 §5 · 2026-05-07) — observer for
 *  ACP `session/update` notifications on the chat client. The companion to
 *  `runChatTurnObserver` (SSE-based cross-tab fanout); this one taps the
 *  cross-surface ACP broadcaster so turns started on **other surfaces**
 *  (webterm `:agent`, TUI, multi-agent broadcasters) materialize as
 *  assistant placeholders in the chat history.
 *
 *  Why ACP and not SSE? webterm `:agent` (terminal/repl/exec) does NOT
 *  publish into the daemon `chatEventBus` — it only fires ACP broadcasts
 *  through `getActiveAcpBroadcaster`. So SSE observer never sees those
 *  turns; ACP listener is the only path to mirror them into chat.
 *
 *  Dedupe (Q1=A1) — when a chat-tab POST is in-flight, the SSE path owns
 *  that turn's bubble and the ACP broadcaster fires the same chunks (chat
 *  REST `handlePromptStreamPost` dual-emit). The host returns `true` from
 *  `isLocalTurnInFlight` and we drop those events so we don't render two
 *  placeholders for the same turn. Same gate also applies when the host's
 *  SSE observer (`runChatTurnObserver`) is mid-bubble for a foreign chat
 *  tab — supply `isRemoteSseTurnInFlight` to suppress double mirror.
 *
 *  Turn boundary heuristic — webterm `:agent` does NOT broadcast a
 *  turn-end notification (only `agent_message_chunk` / `tool_call` /
 *  `tool_call_update`). We arm an idle timer per chunk; after `idleMs`
 *  with no further chunks the placeholder is considered finalized and
 *  the host's `onFinalize` fires. Default 3000ms. Subsequent foreign
 *  turns allocate a fresh placeholder.
 */
export interface AcpForeignTurnHandlers {
  /** Allocate an empty assistant placeholder for the foreign turn and
   *  return its id. Return `null` to skip the turn entirely. */
  onPlaceholder: (info: { sessionId: string }) => string | null;
  /** Per-event snapshot push. `blocks` is freshly cloned per call. */
  onPartialBlocks: (placeholderId: string, blocks: ChatBlock[]) => void;
  /** Optional — fires after the idle timer elapses. Host typically just
   *  logs; the placeholder stays in history as a regular message. */
  onFinalize?: (placeholderId: string) => void;
  /** Dedupe: chat-tab's own POST owns this turn — drop ACP fanout. */
  isLocalTurnInFlight?: () => boolean;
  /** Dedupe: SSE observer (`runChatTurnObserver`) is mid-bubble for a
   *  cross-tab foreign chat turn — drop ACP fanout to avoid dual
   *  placeholders. */
  isRemoteSseTurnInFlight?: () => boolean;
  /** Idle ms after which the placeholder is considered final. Default
   *  3000. webterm `:agent` does not broadcast turn-end; this heuristic
   *  is the boundary. */
  idleFinalizeMs?: number;
}

interface AcpSessionUpdateContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: AcpSessionUpdateContent;
  toolCallId?: string;
  rawInput?: Record<string, unknown>;
  title?: string;
  status?: string;
  /** ⛔⭐ ACP 표준 칸. 데몬은 «이미» 채워 보내는데(실측 2026-08-21) 이 타입에 «없어서»
   *  ACP 경로가 그것을 볼 수 없었고, 그래서 MCP Apps 위젯이 영영 안 떴다.
   *  ⇒ 「타입에 없다」가 「값이 없다」로 «조용히» 바뀐 자리다. */
  rawOutput?: unknown;
}

interface AcpSessionUpdateParams {
  sessionId?: string;
  update?: AcpSessionUpdate;
}

export function runAcpForeignTurnObserver(
  acp: AcpConnection,
  sessionId: string,
  handlers: AcpForeignTurnHandlers,
): () => void {
  const idleMs = handlers.idleFinalizeMs ?? 3000;
  let placeholderId: string | null = null;
  let blocks: ChatBlock[] = [];
  let textIdx = -1;
  let imageCount = 0;
  let toolCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const reset = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    placeholderId = null;
    blocks = [];
    textIdx = -1;
    imageCount = 0;
    toolCount = 0;
  };

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const ph = placeholderId;
      // ⛔⭐📏 17차 `[F]`: 이 경로에는 «끝 관측이 통째로 없었다» — `foreign-turn.start` 만 있었다.
      //   ⭐ 수는 ***`reset()` «전»에*** 읽는다. `reset()` 이 카운터를 0 으로 되돌리므로
      //     뒤에서 읽으면 ***항상 0*** 이 된다(퇴화 검사 ⓑ「항상 영」의 교과서적 자리).
      //   ⭐ `handlers.onFinalize` 유무와 «무관하게» 낸다 — 「턴이 끝났다」는 그 핸들러의 사정이 아니다.
      //   ⚠️ 이 경로는 `mcpAppCount`·`feedbackCount` 를 «세지 않는다» ⇒ 그 축은 «넣지 않는다».
      //     0 을 내면 ***「측정 불가」가 「없다」로 둔갑한다***(`MANUAL-time-and-windows` ⑩).
      //   ⛔ 스프레드(`...counted`)로 넣지 «마라» — 자가 정적으로 못 본다(실측: 그래서 한 번 걸렸다).
      if (ph) debugLog('webterm.chat.acp.foreign-turn.end', { id: ph, images: imageCount, tools: toolCount });
      reset();
      if (ph && handlers.onFinalize) {
        try {
          handlers.onFinalize(ph);
        } catch (e) {
          debugLog('webterm.chat.acp.finalize.error', { reason: String(e) });
        }
      }
    }, idleMs);
  };

  const snapshot = (): ChatBlock[] => blocks.map((b) => ({ ...b }));

  const ensurePlaceholder = (): boolean => {
    if (placeholderId !== null) return true;
    const id = handlers.onPlaceholder({ sessionId });
    if (id === null) return false;
    placeholderId = id;
    debugLog('webterm.chat.acp.foreign-turn.start', { id });
    return true;
  };

  const off = acp.on('sessionUpdate', (frame: AcpFrame) => {
    if (handlers.isLocalTurnInFlight?.()) return;
    if (handlers.isRemoteSseTurnInFlight?.()) return;
    const params = frame.params as AcpSessionUpdateParams | undefined;
    if (!params || params.sessionId !== sessionId) return;
    const update = params.update;
    if (!update) return;

    let consumed = false;

    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content;
      if (content?.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
        if (!ensurePlaceholder()) return;
        const delta = content.text;
        if (textIdx === -1) {
          textIdx = blocks.length;
          blocks.push({ kind: 'text', text: delta });
        } else {
          const prev = blocks[textIdx] as Extract<ChatBlock, { kind: 'text' }>;
          blocks[textIdx] = { kind: 'text', text: prev.text + delta };
        }
        consumed = true;
      } else if (
        content?.type === 'image'
        && typeof content.data === 'string'
        && typeof content.mimeType === 'string'
      ) {
        if (!ensurePlaceholder()) return;
        imageCount += 1;
        const block: Extract<ChatBlock, { kind: 'image' }> = {
          kind: 'image',
          src: content.data,
          mediaType: content.mimeType,
        };
        if (typeof content.uri === 'string') block.alt = content.uri;
        blocks.push(block);
        consumed = true;
      }
    } else if (update.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
      if (!ensurePlaceholder()) return;
      toolCount += 1;
      blocks.push({
        kind: 'tool_use',
        id: update.toolCallId,
        name: update.title ?? '',
        status: 'running',
        startedAt: Date.now(),
        ...(update.rawInput ? { args: update.rawInput } : {}),
      });
      consumed = true;
    } else if (update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string') {
      if (!ensurePlaceholder()) return;
      const idx = blocks.findIndex(
        (b) => b.kind === 'tool_use' && b.id === update.toolCallId,
      );
      const status: 'done' | 'error' = update.status === 'completed' ? 'done' : 'error';
      if (idx === -1) {
        toolCount += 1;
        blocks.push({
          kind: 'tool_use',
          id: update.toolCallId,
          name: update.title ?? '',
          status,
          startedAt: Date.now(),
          endedAt: Date.now(),
          ...(update.title ? { summary: update.title } : {}),
        });
      } else {
        const prev = blocks[idx] as Extract<ChatBlock, { kind: 'tool_use' }>;
        blocks[idx] = {
          ...prev,
          status,
          endedAt: Date.now(),
          ...(update.title ? { summary: update.title } : {}),
        };
      }
      consumed = true;
    }

    if (!consumed || placeholderId === null) return;
    handlers.onPartialBlocks(placeholderId, snapshot());
    armIdle();
  });

  return () => {
    off();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
}
