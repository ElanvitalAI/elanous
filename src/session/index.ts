// ── Session persistence ──
//
// JSONL-backed conversation log. Design heavily borrowed from
// claude-code-fork (`~/.claude/projects/.../{sessionId}.jsonl`) but
// stripped to the minimum needed here:
//
//   - One JSONL file per session — append-only for crash-safety.
//   - One index.json listing SessionMeta entries (id, title, counts,
//     source tag) — rewritten atomically on every append. No FTS,
//     no compaction; small enough at thousands-of-sessions scale
//     that a full rewrite is cheaper than a real DB.
//   - Data root: ~/.local/share/elanous/sessions/ (XDG_DATA_HOME aware).
//     Config lives at ~/.config; sessions grow, so they belong in
//     data, not config. A ~/.local/state/elanous/active file tracks
//     "most recent session" so `elanous session resume` can default.
//
// Session IDs are uuid v4 via crypto.randomUUID(). Title defaults to
// the first 60 chars of the first user message.
//
// Concurrency: we don't claim to be concurrent-safe. One process at a
// time per session file (CLI dashboard vs telegram daemon should use
// DIFFERENT sessions). Telegram maps chat_id → sessionId, CLI maps
// active → sessionId — no crossover.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  renameSync, unlinkSync, readdirSync, rmdirSync, statSync, copyFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InputSourceKind } from '../input/input-source-kind.js';
import { resolveInstanceName } from '../instance-identity.js';
import { isInHarnessSpace } from '../harness/harness-space.js';
import { recordSessionObservation } from './session-observation.js';
import { telegramEndpointKey, discordEndpointKey, telegramOldPathTarget } from './session-endpoint-key.js';
import { truncateBeforeNthUser } from '../acp/session-fork.js';
import { mintTurnUri } from '../mss/uri/builder.js';
import type { TurnUri } from '../mss/uri/brand.js';
import type { ContentBlock } from '../llm.js';

/** Existing origin field value that marks a session as harness-created.
 *  Reuses SessionMeta.origin — no new identity axis. */
export const HARNESS_SESSION_ORIGIN = 'harness';

/** True when origin says this session was created by a harness child. */
export function isHarnessSessionOrigin(origin: string | undefined): boolean {
  return origin === HARNESS_SESSION_ORIGIN;
}

/** Persist origin='harness' when the creating process is inside a harness space
 *  and the caller did not already declare origin. Explicit origin always wins. */
export function resolveCreateSessionOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isHarnessSessionOrigin(origin)) return HARNESS_SESSION_ORIGIN;
  if (origin) return origin;
  return isInHarnessSpace(env) ? HARNESS_SESSION_ORIGIN : undefined;
}

// ── Paths ────────────────────────────────────────────────────────────

export function sessionRoot(): string {
  // Test seam — the store roots at homedir (XDG 거부), so a test that
  // drives the production dispatcher (default `root`) can't isolate via
  // XDG and would otherwise read/write the REAL ~/.elanous/sessions.
  // ELANOUS_SESSION_ROOT lets such a test point the whole store at a temp
  // dir. Prod never sets it, so behavior is unchanged.
  const override = process.env.ELANOUS_SESSION_ROOT?.trim();
  if (override) return override;
  // ELANOUS_STATE_DIR — the unified isolated-state knob (sessions +
  // acp-sessions + surface_events + codex-threads under one dir). Lets a
  // process like `elanous telegram-test` keep ALL mutable state separate
  // from the production daemon while still reusing the prod config.
  const stateDir = process.env.ELANOUS_STATE_DIR?.trim();
  if (stateDir) return join(stateDir, 'sessions');
  // ⚠️ 안전망 (2026-07-24) — 격리를 잊은 `bun test` 가 운영 스토어를 만지는 걸 차단.
  // 위 XDG 거부(2026-07-09)가 테스트 2개의 격리를 **조용히 무력화**해 ~1500개 픽스처
  // 세션이 운영 스토어에 쌓인 뒤에야 발견됐다 — #5246(PTY 매니페스트) 과 같은 결함의
  // 세션 판본. skip 이 아니라 **redirect** 인 이유: 세션은 write-only 인 PTY 매니페스트와
  // 달리 read-back 이 있어 skip 하면 의미가 깨진다. 리다이렉트하면 격리를 잊은 테스트도
  // 그대로 통과하되 운영 스토어만 안 건드린다. 명시 `root` 인자를 넘기는 테스트는 애초에
  // 이 함수를 안 탄다. 설계=내부 문서 `PLAN-self-cognition-observability-surgery-2026-07-24` §2
  if (process.env.NODE_ENV === 'test') return testSessionRootFallback();
  // 2026-07-09 — 세션 저장소를 ~/.elanous/ config 디렉토리로 일원화(대표 지시 · XDG 거부 ·
  // ~/.elanous/ 루트 일원화 방침). legacy(~/.local/share/elanous/sessions)는 1회 이관.
  // (object storage 백업은 후속 연구.)
  return join(homedir(), '.elanous', 'sessions');
}

/** 격리를 안 건 테스트 런의 세션 폴백 루트 — 프로세스(pid) 스코프라 같은 런 안에서는
 *  read-back 이 일관된다. 첫 사용 시 1회만 관측을 남겨 "어느 테스트가 규율을 빠뜨렸나"를
 *  추적 가능하게 한다(제1원칙 — 조용한 폴백은 또 다른 침묵이다). */
let testFallbackRoot: string | undefined;
function testSessionRootFallback(): string {
  if (testFallbackRoot) return testFallbackRoot;
  testFallbackRoot = join(tmpdir(), `elanous-test-sessions-${process.pid}`);
  try {
    const { debug } = require('../debug/log.js') as typeof import('../debug/log.js');
    debug.log('session.store', 'test-root-redirect', {
      pid: process.pid,
      root: testFallbackRoot,
      why: 'NODE_ENV=test without ELANOUS_SESSION_ROOT/ELANOUS_STATE_DIR',
    });
  } catch { /* 관측 실패가 격리를 막지 않는다 */ }
  return testFallbackRoot;
}

/** legacy XDG 세션 경로(이관 소스). */
function legacySessionRoot(): string {
  const base = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
    ? process.env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share');
  return join(base, 'elanous', 'sessions');
}

let migrationChecked = false;
/** ~/.local/share/elanous/sessions → ~/.elanous/sessions 1회 이관. 신규가 비었고
 *  legacy 가 있을 때만(index.json + *.jsonl 복사). fail-soft. */
function migrateLegacySessions(): void {
  if (migrationChecked) return;
  migrationChecked = true;
  // Explicit isolation (ELANOUS_STATE_DIR / ELANOUS_SESSION_ROOT) means the caller
  // wants a CLEAN store — e.g. `elanous telegram-test`. Copying legacy sessions
  // in would defeat the isolation (it dumped ~90 prod sessions into the test
  // store, drowning the bot's real turns). Never migrate into an isolated root.
  if (process.env.ELANOUS_STATE_DIR?.trim() || process.env.ELANOUS_SESSION_ROOT?.trim()) return;
  try {
    const dest = sessionRoot();
    const src = legacySessionRoot();
    if (src === dest) return;
    if (existsSync(indexPath(dest))) return;   // 이미 신규 사용 중
    if (!existsSync(indexPath(src))) return;    // legacy 없음
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src)) {
      if (f === 'index.json' || f.endsWith('.jsonl')) {
        try { copyFileSync(join(src, f), join(dest, f)); } catch { /* skip 1건 */ }
      }
    }
  } catch { /* fail-soft — 이관 실패해도 신규 경로로 계속 */ }
}

function stateRoot(): string {
  const base = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim()
    ? process.env.XDG_STATE_HOME
    : join(homedir(), '.local', 'state');
  return join(base, 'elanous');
}

function indexPath(root: string = sessionRoot()): string { return join(root, 'index.json'); }
export function sessionFile(id: string, root: string = sessionRoot()): string { return join(root, `${id}.jsonl`); }
function activeFile(): string { return join(stateRoot(), 'active'); }

// ── Types ────────────────────────────────────────────────────────────

/** Persisted provenance for the surface that first created a session.
 * This deliberately differs from SessionSurface (subscription identity) and
 * DaemonSessionOrigin (daemon transport vocabulary). */
export type SessionSource = 'cli' | 'telegram' | 'discord' | 'pwa' | 'native' | 'tui' | 'voice' | 'unknown';

/** Persisted protocol path, independent from the surface that created the session.
 * Absent means no transport was declared; legacy records remain transport-unknown. */
export type SessionTransport = 'acp';

export function isSessionSource(value: unknown): value is SessionSource {
  return value === 'cli'
    || value === 'telegram'
    || value === 'discord'
    || value === 'pwa'
    || value === 'native'
    || value === 'tui'
    || value === 'voice'
    || value === 'unknown';
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  provider: string;
  model: string;
  messageCount: number;
  source: SessionSource;
  /** Protocol path declared by the creating layer; omitted when it is unknown or not applicable. */
  transport?: SessionTransport;
  /** Whether source was declared by the creator, defaulted, or malformed in a legacy parser. */
  sourceSource?: 'declared' | 'default' | 'malformed';
  sourceKind?: InputSourceKind;
  /** Optional parent session id when this session was forked from an
   *  earlier transcript. Mirrors Codex's `forked_from_id` concept but
   *  stays in the local session index schema. */
  forkedFromId?: string;
  /** 표면 origin(cli/pwa/tg/dc/harness) — source(cli/telegram) 밖의 세밀 라벨. PWA 챗
   *  write-through(elanous-session-N) 세션을 목록에서 "PWA"로 구분하기 위해.
   *  `harness` = 하니스 자식이 만든 세션(기존 칸에 신분 값을 채움). */
  origin?: string;
  /** 이 세션을 **생성한 elanous 인스턴스** 이름(prod · test:<repo> …·LF7 로그 `instance`
   *  컬럼과 동일 유도). 멀티 인스턴스(글로벌 데몬 + 폴더별 --test)가 세션을 공유/연합
   *  조회할 때 출처 구분·필터용. 인스턴스 정체성 = ELANOUS_STATE_DIR(config-dir/worktree
   *  아님). ~/.elanous 공유 스토어 세션은 전부 'prod'. append 는 이 값을 보존(생성자 귀속).
   *  구 세션엔 부재(tolerant read) — 미상 = 필터 비매치. */
  originInstance?: string;
  /** Project association, omitted for sessions without an assigned project (including legacy records). */
  projectId?: string;
  /** For telegram-sourced sessions; undefined for cli. */
  tgChatId?: number;
  tgThreadId?: number;
  /** Receiving bot id (token prefix) — scopes the session to a specific
   *  telegram channel so multi-bot DMs sharing a chatId stay separate.
   *  Absent on pre-multi-channel sessions. */
  tgBotId?: string;
  /** Stable identity for a persona's resident conversation. */
  personaId?: string;
  /** Telegram session-key used for lookup by chat, e.g.
   *  `telegram:8799226199:dm:123:0` (bot-scoped) or legacy
   *  `telegram:dm:123:0`. Constructed once at create time. */
  tgSessionKey?: string;
  /** Multi-channel attachments. While `source` records where the
   *  session was FIRST created, `bindings` records where it can
   *  CURRENTLY be reached. A CLI-started session that calls
   *  `/telegram attach` adds a `telegram` entry here — the Telegram
   *  daemon's inbound routing (findSessionByTelegramChat) treats
   *  both sources as first-class. Detach clears the entry. */
  bindings?: SessionBindings;
  /** SAM S0 seed — optional retirement marker (ISO-8601). null or
   *  absent = actively available. Non-null = retired but still
   *  resumable; future SAM phases wire the lifecycle state machine
   *  (active → dormant → archived → cold) onto this bit. Setting has
   *  **no runtime effect today** — placeholder for schema stability so
   *  future coordinator does not require a migration pass. */
  retiredAt?: string | null;
}

/** Runtime channel attachments. Each key is optional; presence means
 *  "reachable via this channel". Multiple bindings allowed (e.g. a
 *  session can be active in both TUI and Telegram simultaneously —
 *  that IS the handoff case). */
export interface SessionBindings {
  /** True while a TUI session is "active" / attached. Mirrors the
   *  on-disk active-session marker so queries against the index can
   *  tell which session is currently foregrounded without reading
   *  the separate active file. */
  cli?: boolean;
  /** Telegram chat (+ optional supergroup thread) attached to this
   *  session. At most one telegram binding per session. `botId` scopes
   *  the binding to the RECEIVING bot — in a private chat `chat.id` is
   *  the user's id and is IDENTICAL across different bots, so without it
   *  a multi-bot (multi-channel) setup collapses every bot's DM into one
   *  session. Absent on pre-multi-channel records. */
  telegram?: { chatId: number; threadId?: number; botId?: string };
  /** Discord channel attached to this session (S1 · 2026-07-12).
   *  `channelId` is the stable chat identity for BOTH DMs and guild
   *  text channels (a DM channel id is per-user-stable), so one key
   *  covers the telegram chatId+threadId pair's job. At most one
   *  discord binding per session; one channel binds at most one
   *  session (attach throws on conflict — telegram 동형). Replaces
   *  the never-written `{userId}` reservation. */
  discord?: { channelId: string; guildId?: string };
  /** P0 (2026-07-16) — 동시 구독자 집합. bindings.{cli,telegram,discord} 는
   *  "채널당 1개" 라우팅 키(누가 소유/attach)인데, `subscribers` 는 "지금 이 세션을
   *  동시에 보고 있는 N 서피스"를 1급으로 모델링한다(1세션=N 구독자). 각 항목은
   *  subscribeSession/unsubscribeSession(leave) 로만 변이. 부재/빈 배열 = 구독자 모델
   *  이전 세션(tolerant). 상세 = session/subscribers 프리미티브. */
  subscribers?: SessionSubscriber[];
}

/** 세션 구독 서피스 축(C1 양방향 인덱스 키의 surface 부분). */
export type SessionSurface = 'cli' | 'telegram' | 'discord' | 'pwa' | 'acp' | 'voice';

/** 구독자 presence 상태기계(C12 · Zed answering_connection_lost 패턴). */
export type SubscriberPresence = 'active' | 'grace' | 'left';

/** 한 세션을 구독 중인 한 서피스 엔드포인트. 키 = `<surface>:<endpoint>`(dedup·leave 타겟). */
export interface SessionSubscriber {
  surface: SessionSurface;
  /** 서피스별 안정 엔드포인트 — tg chatId · dc channelId · pwa/acp peerId/clientId · cli 'local'. */
  endpoint: string;
  /** rw = 입력 가능(턴 소유권 경쟁) · ro = 읽기 전용(스트림 관전). */
  role: 'rw' | 'ro';
  joinedAt: string;
  lastSeenAt: string;
  presence: SubscriberPresence;
}

export interface SerializedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  tokenEstimate?: number;
  /** Per-turn stable identifier. Auto-populated by `appendMessage` when the
   *  caller omits it (SAM S0 seed · M1.2 narrow). The wire format stays a
   *  bare 26-char ULID; external inputs should pass through `asTurnUri()`
   *  to cross the brand boundary. */
  turn_id?: TurnUri;
}

/** Flatten LLM content for JSONL. Named tool-use keeps the live SSE wording (`🔧 <name>`);
 *  a missing/blank name stays the pre-existing unknown marker (`[tool_use]`). */
export function persistMessageContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  try {
    return content
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name.trim() : '';
          return name ? `🔧 ${name}` : '[tool_use]';
        }
        return `[${block.type}]`;
      })
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

type ToolUseById = ReadonlyMap<string, { name: string; input: Record<string, unknown> }>;

/** Index structured `tool_use` blocks by id. String content is ignored — names
 *  come from the block, never from a content marker. */
export function collectToolUseById(
  messages: readonly { content: string | ContentBlock[] }[],
): Map<string, { name: string; input: Record<string, unknown> }> {
  const byId = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      byId.set(block.id, { name, input: block.input });
    }
  }
  return byId;
}

/** Copy optional tool-trace fields from structured content blocks.
 *  Plain strings (including lookalike markers like `[tool_result]`) yield
 *  nothing — callers must not parse content to recover a tool name. */
export function toolTraceFieldsFromContent(
  content: string | ContentBlock[],
  toolUseById?: ToolUseById,
): Pick<SerializedMessage, 'toolName' | 'toolArgs' | 'toolResult'> | undefined {
  if (typeof content === 'string' || !Array.isArray(content)) return undefined;
  const fields: Pick<SerializedMessage, 'toolName' | 'toolArgs' | 'toolResult'> = {};
  for (const block of content) {
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (name && fields.toolName === undefined) fields.toolName = name;
      if (block.input !== undefined && fields.toolArgs === undefined) fields.toolArgs = block.input;
      continue;
    }
    if (block.type !== 'tool_result') continue;
    if (fields.toolResult === undefined) fields.toolResult = block.content;
    if (fields.toolName !== undefined || !toolUseById) continue;
    const matched = toolUseById.get(block.tool_use_id);
    if (!matched) continue;
    if (matched.name) fields.toolName = matched.name;
    if (fields.toolArgs === undefined) fields.toolArgs = matched.input;
  }
  if (fields.toolName === undefined && fields.toolArgs === undefined && fields.toolResult === undefined) {
    return undefined;
  }
  return fields;
}

export interface CreateSessionOpts {
  provider?: string;
  model?: string;
  source?: SessionSource;
  /** Protocol path declared by the creator; omitted rather than inferred. */
  transport?: SessionTransport;
  sourceKind?: InputSourceKind;
  forkedFromId?: string;
  tgChatId?: number;
  tgThreadId?: number;
  /** Receiving bot's id (token prefix before ':') — scopes the session
   *  to a specific telegram channel/bot so multi-bot DMs (same chatId)
   *  don't share one session. */
  tgBotId?: string;
  /** Stable identity for a persona's resident conversation. */
  personaId?: string;
  projectId?: string;
  title?: string;
  /** 표면 origin(cli/pwa/tg/dc/harness) — source 유니온 밖의 세밀 라벨(PWA 챗 구분용). */
  origin?: string;
}

export interface ForkSessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts?: string;
}

export interface ForkSessionOpts extends CreateSessionOpts {
  messages: ForkSessionMessage[];
}

export function defaultSessionSourceKind(
  source: CreateSessionOpts['source'] | SessionMeta['source'] | undefined,
): InputSourceKind {
  switch (source) {
    case 'telegram':
      return 'telegram';
    case 'native':
      return 'native';
    case 'cli':
    default:
      return 'keyboard';
  }
}

// ── Index I/O ────────────────────────────────────────────────────────

function ensureRoots(root: string): void {
  if (root === sessionRoot()) migrateLegacySessions();  // 기본 경로 접근 시만
  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(activeFile()), { recursive: true });
}

function readIndex(root: string = sessionRoot()): SessionMeta[] {
  if (root === sessionRoot()) migrateLegacySessions();  // 기본 경로 접근 시만(테스트 tmp root 제외)
  const p = indexPath(root);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((m): m is SessionMeta =>
      m && typeof m === 'object' && typeof m.id === 'string');
  } catch {
    return [];
  }
}

// 여러 프로세스(`elanous ask` 동시 실행 등)가 같은 목록을 «읽고-고치고-통째로 쓰기» 한다.
// 쓰기 직전 잠금 안에서 디스크의 최신 목록을 다시 읽어 id 로 합치고, 임시 파일 이름은 프로세스마다 다르게 한다
// (10-01 MK 재현: 고정 `index.json.tmp` → 한쪽 ENOENT · 덮어쓰기로 남의 세션이 목록에서 사라짐).
function writeIndex(entries: SessionMeta[], root: string = sessionRoot(), removed: Iterable<string> = []): void {
  ensureRoots(root);
  const p = indexPath(root);
  withDirLock(join(root, '.index.lock'), INDEX_LOCK_TIMEOUT_MS, () => {
    const mine = new Set(entries.map((m) => m.id));
    const gone = new Set(removed);
    const peers = readIndex(root).filter((m) => !mine.has(m.id) && !gone.has(m.id));
    const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify([...peers, ...entries], null, 2) + '\n', 'utf-8');
    renameSync(tmp, p);
  });
}

/** 세션 메타 하나를 잠금 «안에서» 디스크의 최신 목록 위에 고쳐 쓴다(IA1b).
 *  `appendMessage` 가 잠금 밖에서 읽은 목록을 통째로 쓰면, 그 사이 다른 프로세스가 바꾼
 *  같은 세션의 `projectId`·`messageCount` 를 옛 값으로 덮었다. 없는 id 면 `null`. */
export function updateSessionMeta(
  id: string,
  mutate: (meta: SessionMeta) => void,
  root: string = sessionRoot(),
  opts: { bubble?: boolean } = {},
): SessionMeta | null {
  ensureRoots(root);
  const p = indexPath(root);
  return withDirLock(join(root, '.index.lock'), INDEX_LOCK_TIMEOUT_MS, () => {
    const idx = readIndex(root);
    const pos = idx.findIndex((m) => m.id === id);
    if (pos < 0) return null;
    const meta = { ...idx[pos] };
    mutate(meta);
    idx.splice(pos, 1);
    if (opts.bubble) idx.unshift(meta);
    else idx.splice(pos, 0, meta);
    const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf-8');
    renameSync(tmp, p);
    return meta;
  });
}

// ── Tier 1 Phase 3 — listener primitive ──────────────────────────────
//
// Channel-agnostic subscribe API the daemon-mirror module (PR 2) hooks
// into. Listeners fire AFTER the on-disk write so a subscriber reading
// `loadSession()` from inside the listener sees the just-appended tail.
//
// Two independent listener sets:
//   - sessionCreatedListeners — fires from createSession()
//   - messageAppendedListeners — fires from appendMessage()
//
// Listener errors are swallowed so a wedged subscriber can't poison
// session creation / message persistence (matches the pattern from
// DaemonSessionHistory.onAppend in PR #837).

type SessionCreatedListener = (meta: SessionMeta) => void;
type MessageAppendedListener = (id: string, msg: SerializedMessage, meta: SessionMeta) => void;

const sessionCreatedListeners = new Set<SessionCreatedListener>();
const messageAppendedListeners = new Set<MessageAppendedListener>();

/** Subscribe to session creation. Returns an unsubscribe function. */
export function onSessionCreated(listener: SessionCreatedListener): () => void {
  sessionCreatedListeners.add(listener);
  return () => { sessionCreatedListeners.delete(listener); };
}

/** Subscribe to per-message append events. Returns an unsubscribe function. */
export function onMessageAppended(listener: MessageAppendedListener): () => void {
  messageAppendedListeners.add(listener);
  return () => { messageAppendedListeners.delete(listener); };
}

function fireSessionCreated(meta: SessionMeta): void {
  for (const l of sessionCreatedListeners) {
    try { l(meta); } catch { /* observer must not break createSession */ }
  }
}

function fireMessageAppended(id: string, msg: SerializedMessage, meta: SessionMeta): void {
  for (const l of messageAppendedListeners) {
    try { l(id, msg, meta); } catch { /* observer must not break append */ }
  }
}

/** Test helper — clears all subscribed listeners. Used by daemon-mirror
 *  tests to isolate listener counts between cases. */
export function _clearSessionListenersForTest(): void {
  sessionCreatedListeners.clear();
  messageAppendedListeners.clear();
}

// ── Public API ───────────────────────────────────────────────────────

export function createSession(opts: CreateSessionOpts = {}, root: string = sessionRoot()): SessionMeta {
  ensureRoots(root);
  const now = new Date().toISOString();
  const id = randomUUID();
  const source: SessionSource = opts.source ?? 'cli';
  const sourceSource: NonNullable<SessionMeta['sourceSource']> = opts.source === undefined ? 'default' : 'declared';
  const sourceKind: InputSourceKind = opts.sourceKind
    ?? defaultSessionSourceKind(source);
  const tgSessionKey = source === 'telegram' && opts.tgChatId != null
    ? `telegram:${opts.tgBotId ? opts.tgBotId + ':' : ''}${opts.tgThreadId != null ? 'group' : 'dm'}:${opts.tgChatId}:${opts.tgThreadId ?? 0}`
    : undefined;
  const origin = resolveCreateSessionOrigin(opts.origin);
  const meta: SessionMeta = {
    id,
    createdAt: now,
    updatedAt: now,
    title: opts.title ?? '(new session)',
    provider: opts.provider ?? 'auto',
    model: opts.model ?? '',
    messageCount: 0,
    source,
    ...(opts.transport ? { transport: opts.transport } : {}),
    sourceSource,
    sourceKind,
    forkedFromId: opts.forkedFromId,
    ...(origin ? { origin } : {}),
    originInstance: resolveInstanceName(),
    tgChatId: opts.tgChatId,
    tgThreadId: opts.tgThreadId,
    ...(opts.tgBotId ? { tgBotId: opts.tgBotId } : {}),
    ...(opts.personaId ? { personaId: opts.personaId } : {}),
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    tgSessionKey,
  };
  writeFileSync(sessionFile(id, root), '', 'utf-8');
  const idx = readIndex(root);
  idx.unshift(meta);
  writeIndex(idx, root);
  // Tier 1 Phase 3 — fire AFTER on-disk write so listeners reading
  // back the session see consistent state.
  fireSessionCreated(meta);
  // C1 — 텔레그램 origin 세션은 옛 경로 대상(origin chat)을 자동 구독(parity 수신자 일치). 디스코드는
  // source='cli'+origin='dc'로 생성 후 attachDiscordBinding 에서 binding+구독을 붙인다(그 게이트로 대칭).
  if (source === 'telegram') autoSubscribeOldPath(id, root);
  return meta;
}

/** 명시 id 로 on-disk 세션 채택(멱등) — 데몬이 민팅한 id(elanous-session-N 등)를
 *  on-disk 저장소에 first-class 로 등록. 이미 있으면 기존 meta 반환(무변경).
 *  PWA 챗 write-through(R3) + TUI 어댑트가 이 경로로 세션 저장소를 일원화한다. */
export function adoptSession(id: string, opts: CreateSessionOpts = {}, root: string = sessionRoot()): SessionMeta {
  ensureRoots(root);
  const idx = readIndex(root);
  const existing = idx.find((m) => m.id === id);
  if (existing) return existing; // 멱등 — 이미 채택됨
  const now = new Date().toISOString();
  const source: SessionSource = opts.source ?? 'cli';
  const sourceSource: NonNullable<SessionMeta['sourceSource']> = opts.source === undefined ? 'default' : 'declared';
  const origin = resolveCreateSessionOrigin(opts.origin);
  const meta: SessionMeta = {
    id,
    createdAt: now,
    updatedAt: now,
    title: opts.title ?? '(new session)',
    provider: opts.provider ?? 'auto',
    model: opts.model ?? '',
    messageCount: 0,
    source,
    ...(opts.transport ? { transport: opts.transport } : {}),
    sourceSource,
    sourceKind: opts.sourceKind ?? defaultSessionSourceKind(source),
    ...(opts.forkedFromId ? { forkedFromId: opts.forkedFromId } : {}),
    ...(origin ? { origin } : {}),
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    originInstance: resolveInstanceName(),
    ...(opts.tgChatId != null ? { tgChatId: opts.tgChatId } : {}),
    ...(opts.tgThreadId != null ? { tgThreadId: opts.tgThreadId } : {}),
  };
  if (!existsSync(sessionFile(id, root))) writeFileSync(sessionFile(id, root), '', 'utf-8');
  idx.unshift(meta);
  writeIndex(idx, root);
  fireSessionCreated(meta);
  return meta;
}

export function forkSessionFromHistory(
  opts: ForkSessionOpts,
  root: string = sessionRoot(),
): LoadedSession {
  const meta = createSession({
    provider: opts.provider,
    model: opts.model,
    source: opts.source,
    transport: opts.transport,
    sourceKind: opts.sourceKind,
    forkedFromId: opts.forkedFromId,
    tgChatId: opts.tgChatId,
    tgThreadId: opts.tgThreadId,
    title: opts.title,
    origin: opts.origin,
    projectId: opts.projectId,
  }, root);
  for (const msg of opts.messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content.trim()) continue;
    appendMessage(meta.id, {
      role: msg.role,
      content,
      ts: msg.ts ?? new Date().toISOString(),
    }, root);
  }
  return loadSession(meta.id, root)!;
}

export function appendMessage(id: string, msg: SerializedMessage, root: string = sessionRoot()): SessionMeta {
  ensureRoots(root);
  const file = sessionFile(id, root);
  if (!existsSync(file)) throw new Error(`session not found: ${id}`);
  // SAM S0 seed — auto-populate `turn_id` when caller omitted so
  // future turn-level primitives can reference turns without rebuilding
  // persistence. Caller-supplied ids are preserved (migration tooling).
  const enriched: SerializedMessage = msg.turn_id !== undefined
    ? msg
    : { ...msg, turn_id: mintTurnUri() };
  const line = JSON.stringify(enriched) + '\n';
  appendFileSync(file, line, 'utf-8');

  // Bubble to front of index so listSessions returns newest-first.
  const meta = updateSessionMeta(id, (m) => {
    m.updatedAt = msg.ts || new Date().toISOString();
    m.messageCount = m.messageCount + 1;
    // Auto-title on first user message.
    if (m.title === '(new session)' && msg.role === 'user' && msg.content) {
      m.title = msg.content.replace(/\s+/g, ' ').slice(0, 60).trim() || '(empty)';
    }
  }, root, { bubble: true });
  if (!meta) throw new Error(`session missing from index: ${id}`);
  // Tier 1 Phase 3 — fire AFTER on-disk write + index update.
  // Listeners (daemon-mirror) read the just-appended message + meta
  // from a consistent state.
  fireMessageAppended(id, enriched, meta);
  return meta;
}

/** Atomically replace a session's entire on-disk history with a new
 *  message list. Written to a temp file then renamed so a crash mid-
 *  write can never truncate the live JSONL (mirrors writeIndex's
 *  tmp+rename discipline). Used by auto-compaction (§5-⑤) to swap a
 *  grown transcript for a compacted [summary, …tail] history.
 *
 *  Unlike appendMessage this does NOT fire message-appended listeners —
 *  a rewrite is not an append, and the daemon mirror re-syncs on the
 *  next real append. messageCount + updatedAt are refreshed in the
 *  index so listSessions stays consistent. */
export function rewriteSessionMessages(
  id: string,
  messages: SerializedMessage[],
  root: string = sessionRoot(),
): SessionMeta {
  ensureRoots(root);
  const file = sessionFile(id, root);
  if (!existsSync(file)) throw new Error(`session not found: ${id}`);
  const body = messages
    .map(m => JSON.stringify(m.turn_id !== undefined ? m : { ...m, turn_id: mintTurnUri() }))
    .join('\n');
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, body ? body + '\n' : '', 'utf-8');
  renameSync(tmp, file);

  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === id);
  if (pos < 0) throw new Error(`session missing from index: ${id}`);
  const meta = idx[pos];
  meta.messageCount = messages.length;
  meta.updatedAt = new Date().toISOString();
  idx.splice(pos, 1);
  idx.unshift(meta);
  writeIndex(idx, root);
  return meta;
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: SerializedMessage[];
}

export function loadSession(id: string, root: string = sessionRoot()): LoadedSession | null {
  const idx = readIndex(root);
  const meta = idx.find(m => m.id === id);
  if (!meta) return null;
  const file = sessionFile(id, root);
  if (!existsSync(file)) return { meta, messages: [] };
  const raw = readFileSync(file, 'utf-8');
  const messages: SerializedMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') messages.push(parsed as SerializedMessage);
    } catch { /* skip malformed line, don't fail whole load */ }
  }
  return { meta, messages };
}

/** 리스트 프리뷰용 — 마지막 대화(비-tool·본문 있음) 메시지 1건. 파일 끝에서 역스캔(전체 파싱 회피).
 *  없으면 null(빈 세션·tool-only). */
export function lastConversationMessage(
  id: string, root: string = sessionRoot(),
): { role: string; content: string } | null {
  const file = sessionFile(id, root);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf-8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const m = JSON.parse(line) as SerializedMessage;
      if (m && m.role && m.role !== 'tool' && typeof m.content === 'string' && m.content.trim()) {
        return { role: m.role, content: m.content };
      }
    } catch { /* skip malformed */ }
  }
  return null;
}

export interface ListSessionsOpts {
  limit?: number;
  source?: SessionSource;
  sourceKind?: InputSourceKind;
  /** Filter to only sessions matching this tg chatId. */
  tgChatId?: number;
  tgThreadId?: number;
  /** 생성 인스턴스 정확 일치(prod · test:<repo> …). 구 세션(부재)은 비매치. */
  originInstance?: string;
  /** Project id exact match; sessions without the field do not match. */
  projectId?: string;
  /** 표면 origin 정확 일치(cli | pwa | tg | dc | harness). */
  origin?: string;
  /** 제외할 origin(들) — 예: ['harness'] 로 하니스 자식 세션을 사용자 대화 목록에서 숨김. */
  excludeOrigins?: string[];
  /** 제외할 source(들) — 예: ['cli'] 로 미션 spawn cli 노이즈 제거. */
  excludeSources?: SessionSource[];
  /** 제외할 sourceKind(들) — 예: ['scheduled'] 로 운영 크론 실행(leverage/free-swing/
   *  buzz-dig-cycle) 을 사용자 대화 목록/검색에서 숨김. 명시 sourceKind 필터와 상호배타. */
  excludeSourceKinds?: InputSourceKind[];
  /** 최소 메시지 수 — 이 미만(빈 세션 등) 제외. */
  minMessages?: number;
  /** 빈(0msg) 미션 세션(title `mission:*`) 숨김 — autopilot spawn 노이즈 제거. */
  hideEmptyMissions?: boolean;
  /** 빈(0msg) 세션 전부 숨김 — 미션·"(new session)"·미사용 스크래치 모두(내용 없음).
   *  실데이터 검증(2026-07-16): 노이즈는 mission:* 뿐 아니라 "(new session)" 0msg 다수. */
  hideEmpty?: boolean;
  /** hideEmpty 예외로 항상 유지할 세션 id(활성 세션 — 방금 만들었을 수 있음). */
  keepIds?: string[];
}

/** 미션 spawn 세션인가(title `mission:` 접두) — autopilot 이 만든 비대화 세션. */
export function isMissionSession(m: SessionMeta): boolean {
  return typeof m.title === 'string' && m.title.startsWith('mission:');
}

export function listSessions(opts: ListSessionsOpts = {}, root: string = sessionRoot()): SessionMeta[] {
  let idx = readIndex(root);
  if (opts.source) idx = idx.filter(m => m.source === opts.source);
  if (opts.excludeSources && opts.excludeSources.length > 0) {
    idx = idx.filter(m => !opts.excludeSources!.includes(m.source));
  }
  if (opts.sourceKind) idx = idx.filter(m => m.sourceKind === opts.sourceKind);
  if (opts.excludeSourceKinds && opts.excludeSourceKinds.length > 0) {
    idx = idx.filter(m => !m.sourceKind || !opts.excludeSourceKinds!.includes(m.sourceKind));
  }
  if (opts.originInstance) idx = idx.filter(m => m.originInstance === opts.originInstance);
  if (opts.projectId !== undefined) idx = idx.filter(m => m.projectId === opts.projectId);
  if (opts.origin) idx = idx.filter(m => m.origin === opts.origin);
  if (opts.excludeOrigins && opts.excludeOrigins.length > 0) {
    idx = idx.filter((m) => {
      if (!m.origin) return true;
      return !opts.excludeOrigins!.some((excluded) =>
        isHarnessSessionOrigin(excluded)
          ? isHarnessSessionOrigin(m.origin)
          : m.origin === excluded,
      );
    });
  }
  if (opts.minMessages != null) idx = idx.filter(m => m.messageCount >= opts.minMessages!);
  if (opts.hideEmptyMissions) idx = idx.filter(m => !(isMissionSession(m) && m.messageCount === 0));
  if (opts.hideEmpty) {
    const keep = new Set(opts.keepIds ?? []);
    idx = idx.filter(m => m.messageCount > 0 || keep.has(m.id));
  }
  if (opts.tgChatId != null) {
    idx = idx.filter(m => m.tgChatId === opts.tgChatId
      && (opts.tgThreadId == null || (m.tgThreadId ?? 0) === (opts.tgThreadId ?? 0)));
  }
  const limit = opts.limit ?? idx.length;
  return idx.slice(0, limit);
}

const RESIDENT_SESSION_LOCK_STALE_MS = 30_000;
const RESIDENT_SESSION_LOCK_TIMEOUT_MS = 5_000;

function residentSessionLockPath(root: string): string {
  return join(root, '.resident-session.lock');
}

function withResidentSessionLock<T>(root: string, action: () => T): T {
  ensureRoots(root);
  return withDirLock(residentSessionLockPath(root), RESIDENT_SESSION_LOCK_TIMEOUT_MS, action);
}

const INDEX_LOCK_TIMEOUT_MS = 10_000;

function withDirLock<T>(lock: string, timeoutMs: number, action: () => T): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!existsSync(lock)) continue;
      try {
        if (Date.now() - statSync(lock).mtimeMs > RESIDENT_SESSION_LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring lock ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      void error;
    }
  }
  try {
    return action();
  } finally {
    try { rmdirSync(lock); } catch { /* lock cleanup is best effort */ }
  }
}

/** Return a persona's resident session, creating it through the standard
 * session persistence path when no prior session carries that identity.
 * The root-scoped lock serializes the read/create/index-write transaction
 * across personas and processes, so index updates cannot overwrite peers. */
export function getOrCreatePersonaSession(
  personaId: string,
  opts: Omit<CreateSessionOpts, 'personaId'> = {},
  root: string = sessionRoot(),
): SessionMeta {
  const normalizedPersonaId = personaId.trim();
  if (!normalizedPersonaId) throw new Error('personaId must not be empty');
  return withResidentSessionLock(root, () => {
    // ⛔⭐ 이 조회가 «이 함수의 본체»다 — 비워 두면 매번 새 세션이 생겨
    //    「상주 대화」라는 이름이 «거짓»이 된다(자식의 첫 판이 `const existing = undefined` 였다).
    //    ⭐ 여럿이면 «가장 최근 것»을 고른다 — 과거에 갈린 것이 있어도 하나로 수렴한다.
    const existing = readIndex(root)
      .filter((m) => m.personaId === normalizedPersonaId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0];
    return existing ?? createSession({ ...opts, personaId: normalizedPersonaId }, root);
  });
}

export function deleteSession(id: string, root: string = sessionRoot()): boolean {
  const file = sessionFile(id, root);
  if (existsSync(file)) unlinkSync(file);
  const idx = readIndex(root);
  const before = idx.length;
  const next = idx.filter(m => m.id !== id);
  if (next.length === before) return false;
  writeIndex(next, root, [id]);
  // Clear active marker if it pointed at the deleted session.
  if (getActiveSessionId() === id) clearActiveSessionId();
  return true;
}

/** Bulk delete — unlink each file then rewrite the index ONCE. Calling
 *  deleteSession() in a loop is O(N²) (re-reads/writes the whole index per id);
 *  purging ~1500 leaked test fixtures needs a single index rewrite. Returns the
 *  number of index rows actually removed. Clears the active marker if it was
 *  among the deleted. */
export function deleteSessions(ids: string[], root: string = sessionRoot()): number {
  const set = new Set(ids);
  if (set.size === 0) return 0;
  for (const id of set) {
    const file = sessionFile(id, root);
    if (existsSync(file)) unlinkSync(file);
  }
  const idx = readIndex(root);
  const next = idx.filter(m => !set.has(m.id));
  const removed = idx.length - next.length;
  if (removed > 0) writeIndex(next, root, set);
  const active = getActiveSessionId();
  if (active && set.has(active)) clearActiveSessionId();
  return removed;
}

/** Find an existing telegram-sourced session by chat+thread. Returns
 *  null if no session has been created for that conversation yet.
 *
 *  Kept for back-compat; new call sites should prefer
 *  findSessionByTelegramChat which also honors runtime `bindings`
 *  (attach handoff from a CLI-started session). */
export function findTelegramSession(
  chatId: number,
  threadId?: number,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const t = threadId ?? 0;
  return idx.find(m =>
    m.source === 'telegram'
    && m.tgChatId === chatId
    && (m.tgThreadId ?? 0) === t
  ) ?? null;
}

/** Bindings-aware lookup. Priority:
 *    1. Any session with `bindings.telegram` matching (chatId, threadId).
 *       This is how a TUI session that ran /telegram attach catches
 *       inbound Telegram messages before falling back to per-chat
 *       auto-created sessions.
 *    2. Legacy source==='telegram' session (pre-bindings schema).
 *  Returns null when neither matches. */
export function findSessionByTelegramChat(
  chatId: number,
  threadId?: number,
  botId?: string,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const t = threadId ?? 0;
  // When a botId is supplied, the match is BOT-SCOPED — only a session
  // minted for the same bot qualifies. This is what keeps two channels
  // that share a chatId (multi-bot DMs) in separate sessions. A pre-multi
  // -channel session (no botId) therefore does NOT match a bot-scoped
  // lookup → a fresh bot-scoped session is minted (one-time reset per bot;
  // old transcripts are preserved). botId omitted (external queries like
  // session_manage) keeps the legacy match-any behavior.
  const byBinding = idx.find(m => {
    const b = m.bindings?.telegram;
    if (b == null || b.chatId !== chatId || (b.threadId ?? 0) !== t) return false;
    // An EXPLICIT binding without a botId (TUI /telegram attach handoff, or
    // pre-multi-channel) is bot-agnostic — it catches the chat regardless
    // of bot so the attach handoff keeps working. A bot-scoped binding
    // must match the receiving bot.
    return botId === undefined || b.botId === undefined || b.botId === botId;
  });
  if (byBinding) return byBinding;
  return idx.find(m => {
    if (m.source !== 'telegram' || m.tgChatId !== chatId || (m.tgThreadId ?? 0) !== t) return false;
    // Auto-created session — bot-scoped. A pre-multi-channel auto session
    // (no tgBotId) does NOT match a bot-scoped lookup, so each bot mints
    // its own fresh session instead of inheriting a shared (contaminated)
    // one. This is the one-time reset that de-collides multi-bot DMs.
    return botId === undefined || m.tgBotId === botId;
  }) ?? null;
}

/** S2+S3 (2026-07-12) — fork an existing session BY ID: copies its
 *  user/assistant/system history into a new session with
 *  `forkedFromId` lineage. Tool rows are dropped (historyFromSession
 *  규약 — 내부 브레드크럼은 재생 의미 없음). Returns null when the
 *  source is unknown. Surface commands (tg `/fork` · dc `!fork` ·
 *  CLI `elanous session fork`) all route through this one helper.
 *
 *  S3 time-travel: `opts.beforeUser = N` truncates the copy to just
 *  BEFORE the Nth (1-based) user message — codex ForkSnapshot의
 *  TruncateBeforeNthUserMessage 동형 (`acp/session-fork.ts` 엔진 첫
 *  프로덕션 배선). N=1 ⇒ 빈 히스토리, N>사용자턴수 ⇒ 전체 복사(클램프). */
export function forkSessionById(
  sourceId: string,
  opts: { beforeUser?: number; origin?: string } = {},
  root: string = sessionRoot(),
): LoadedSession | null {
  const src = historyFromSession(sourceId, root);
  if (!src) return null;
  let messages: ForkSessionMessage[] = src.history;
  let titleMark = '⑂';
  if (opts.beforeUser !== undefined) {
    const { items } = truncateBeforeNthUser(
      src.history.map((m) => ({ role: m.role, content: m.content })),
      opts.beforeUser,
    );
    messages = items as ForkSessionMessage[];
    titleMark = `⑂@u${opts.beforeUser}`;
  }
  return forkSessionFromHistory({
    messages,
    provider: src.meta.provider,
    model: src.meta.model,
    source: src.meta.source,
    sourceKind: src.meta.sourceKind,
    forkedFromId: sourceId,
    origin: opts.origin ?? src.meta.origin,
    title: `${titleMark} ${src.meta.title}`.slice(0, 60),
  }, root);
}

/** Find the session bound to a Discord channel (S1 · 텔레그램
 *  findSessionByTelegramChat 동형, 단 legacy 키 폴백 없음 — 디스코드
 *  바인딩은 처음부터 bindings 단일 메커니즘). Returns null when the
 *  channel has no live binding (caller mints a fresh session). */
export function findSessionByDiscordChannel(
  channelId: string,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  return idx.find(m => m.bindings?.discord?.channelId === channelId) ?? null;
}

// ── Binding primitives (attach / detach) ─────────────────────────────
//
// These mutate a session's `bindings` map so slash commands on either
// side (TUI `/telegram attach`, Telegram `/attach`) can toggle which
// chats a given conversation answers on. Rules:
//
//   - One telegram chat can bind to at most one session. Attempts to
//     bind a chat that is already bound to a DIFFERENT session throw
//     with the occupying session's id so the caller can surface a
//     "detach first" error. Re-binding to the SAME session is idempotent.
//   - detach is a no-op when the binding is already absent.
//   - Deleting a session implicitly drops its bindings (deleteSession
//     removes the index row entirely — nothing else holds bindings).

/** Attach a Telegram chat to a session. Throws on conflict. */
export function attachTelegramBinding(
  sessionId: string,
  chatId: number,
  threadId?: number,
  root: string = sessionRoot(),
): SessionMeta {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) throw new Error(`session not found: ${sessionId}`);
  const t = threadId ?? 0;
  const clashing = idx.find(m =>
    m.id !== sessionId
    && m.bindings?.telegram?.chatId === chatId
    && (m.bindings?.telegram?.threadId ?? 0) === t,
  );
  if (clashing) {
    throw new Error(
      `telegram chat ${chatId}${threadId ? `/thread ${threadId}` : ''} is already attached to session ${clashing.id.slice(0, 8)} — detach first`,
    );
  }
  const meta = idx[pos];
  meta.bindings = {
    ...(meta.bindings ?? {}),
    telegram: { chatId, ...(threadId != null ? { threadId } : {}) },
  };
  idx[pos] = meta;
  writeIndex(idx, root);
  autoSubscribeOldPath(sessionId, root);   // C1 — attach = 서피스 합류 → 자동 구독
  return meta;
}

/** Attach a Discord channel to a session. Throws on conflict (channel
 *  already bound to a DIFFERENT session — caller surfaces "detach
 *  first" or auto-unbinds). Re-binding the same pair is idempotent. */
export function attachDiscordBinding(
  sessionId: string,
  channelId: string,
  guildId?: string,
  root: string = sessionRoot(),
): SessionMeta {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) throw new Error(`session not found: ${sessionId}`);
  const clashing = idx.find(m =>
    m.id !== sessionId && m.bindings?.discord?.channelId === channelId,
  );
  if (clashing) {
    throw new Error(
      `discord channel ${channelId} is already attached to session ${clashing.id.slice(0, 8)} — detach first`,
    );
  }
  const meta = idx[pos];
  meta.bindings = {
    ...(meta.bindings ?? {}),
    discord: { channelId, ...(guildId ? { guildId } : {}) },
  };
  idx[pos] = meta;
  writeIndex(idx, root);
  autoSubscribeOldPath(sessionId, root);   // C1 — attach = 서피스 합류 → 자동 구독
  return meta;
}

/** Remove the Discord binding from a session. Returns updated meta, or
 *  null when there was no discord binding (no-op). The transcript and
 *  index row are preserved — this is `!new`'s "fresh conversation
 *  WITHOUT history wipe" semantics (unbindTelegramSession 동형). */
export function detachDiscordBinding(
  sessionId: string,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) throw new Error(`session not found: ${sessionId}`);
  const meta = idx[pos];
  if (!meta.bindings?.discord) return null;
  const { discord: _dropped, ...rest } = meta.bindings;
  meta.bindings = Object.keys(rest).length > 0 ? rest : undefined;
  idx[pos] = meta;
  writeIndex(idx, root);
  return meta;
}

/** Unbind a session from its Telegram chat WITHOUT deleting it — clears
 *  the tg association keys (tgChatId / tgThreadId / tgSessionKey) AND any
 *  `bindings.telegram`, so `findSessionByTelegramChat` no longer resolves
 *  it and the NEXT message starts a fresh session. The transcript, index
 *  row, `source` and title are PRESERVED (still listable / loadable by
 *  id — it just detaches from the live chat). This is what `/new`·/clear·
 *  /reset use: a fresh conversation, NOT a history wipe (deleteSession).
 *  Returns the updated meta, or null when the session isn't found. */
export function unbindTelegramSession(
  sessionId: string,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) return null;
  const meta = idx[pos];
  delete meta.tgChatId;
  delete meta.tgThreadId;
  delete meta.tgSessionKey;
  if (meta.bindings?.telegram) {
    const { telegram: _dropped, ...rest } = meta.bindings;
    meta.bindings = Object.keys(rest).length > 0 ? rest : undefined;
  }
  idx[pos] = meta;
  writeIndex(idx, root);
  return meta;
}

/** Remove the Telegram binding from a session. Returns the updated
 *  meta when a binding was cleared, or null when the session had no
 *  telegram binding to begin with (caller can render "no-op"). */
export function detachTelegramBinding(
  sessionId: string,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) throw new Error(`session not found: ${sessionId}`);
  const meta = idx[pos];
  if (!meta.bindings?.telegram) return null;
  const { telegram: _dropped, ...rest } = meta.bindings;
  meta.bindings = Object.keys(rest).length > 0 ? rest : undefined;
  idx[pos] = meta;
  writeIndex(idx, root);
  return meta;
}

/** Mark a session as actively foregrounded in the TUI. Mirror of
 *  setActiveSessionId but lives on the session row — used by
 *  `/sessions` in Telegram to answer "which session is the laptop
 *  currently using" without the caller having to read the state
 *  file. Setting `active=true` on one session automatically clears
 *  the flag on others so the index stays consistent. */
export function setCliBinding(
  sessionId: string,
  active: boolean,
  root: string = sessionRoot(),
): SessionMeta {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) throw new Error(`session not found: ${sessionId}`);
  if (active) {
    // Clear cli flag on everyone else in one pass.
    for (let i = 0; i < idx.length; i++) {
      if (i === pos) continue;
      const b = idx[i]!.bindings;
      if (b?.cli) {
        const { cli: _c, ...rest } = b;
        idx[i]!.bindings = Object.keys(rest).length > 0 ? rest : undefined;
      }
    }
    const meta = idx[pos];
    meta.bindings = { ...(meta.bindings ?? {}), cli: true };
    idx[pos] = meta;
  } else {
    const meta = idx[pos];
    if (meta.bindings?.cli) {
      const { cli: _c, ...rest } = meta.bindings;
      meta.bindings = Object.keys(rest).length > 0 ? rest : undefined;
      idx[pos] = meta;
    }
  }
  writeIndex(idx, root);
  return idx[pos]!;
}

// ── Subscriber primitives (P0 · 2026-07-16) ──────────────────────────
//
// 동시 구독 모델: 1세션 = N 구독자(surface+endpoint). bindings.{cli,telegram,
// discord}(채널당 1개 라우팅 키)와 구분 — 여기 subscribers 는 "지금 동시에 보고
// 있는 서피스 집합". detach(이동·소유권 이전)와 leave(합류 후 나만 이탈)는 다르다.
//
// 진실원천 = 영속 meta.bindings.subscribers. 추가로 in-memory **역방향 인덱스**
// (subscriberKey → Set<sessionId>·C1)를 유지해 "이 서피스가 구독 중인 세션들"을
// 전 코퍼스 스캔 없이 O(1) 회수(P1 fan-out·P2 presence 가 소비). 역인덱스는 캐시라
// 프로세스 로컬 — 부팅 후 첫 subscribe 부터 채워진다(영속본이 진실).

/** 구독자 안정 키 — dedup + leave 타겟. */
export function subscriberKey(surface: SessionSurface, endpoint: string): string {
  return `${surface}:${endpoint}`;
}

/** in-memory 역인덱스(subscriberKey → sessionId 집합). C1 양방향의 역방향. */
const subscriberReverseIndex = new Map<string, Set<string>>();

function reverseAdd(key: string, sessionId: string): void {
  let set = subscriberReverseIndex.get(key);
  if (!set) { set = new Set(); subscriberReverseIndex.set(key, set); }
  set.add(sessionId);
}
function reverseRemove(key: string, sessionId: string): void {
  const set = subscriberReverseIndex.get(key);
  if (!set) return;
  set.delete(sessionId);
  if (set.size === 0) subscriberReverseIndex.delete(key);
}

/** 이 구독자(키)가 구독 중인 세션 id 들 — P1 fan-out·크로스세션 presence 가 소비. */
export function sessionsForSubscriber(key: string): string[] {
  return [...(subscriberReverseIndex.get(key) ?? [])];
}

/** 테스트 seam — 역인덱스 초기화(파일 간 상태 격리). */
export function _clearSubscriberIndexForTest(): void {
  subscriberReverseIndex.clear();
}

export interface SubscribeOpts {
  role?: 'rw' | 'ro';
  /** presence 초기값(기본 active). 재구독(유예→active) 시 명시. */
  presence?: SubscriberPresence;
  /** 시각 주입(테스트 결정론). 기본 now. */
  now?: string;
}

/** 세션에 구독자 합류(멱등·dedup by key). 이미 있으면 lastSeenAt/presence/role 갱신(재합류).
 *  진실원천 meta.bindings.subscribers 갱신 + 역인덱스 반영. 관측(session.subscribe) 발화. */
export function subscribeSession(
  sessionId: string,
  sub: { surface: SessionSurface; endpoint: string },
  opts: SubscribeOpts = {},
  root: string = sessionRoot(),
): SessionMeta {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) throw new Error(`session not found: ${sessionId}`);
  const now = opts.now ?? new Date().toISOString();
  const key = subscriberKey(sub.surface, sub.endpoint);
  const meta = idx[pos]!;
  const subs = [...(meta.bindings?.subscribers ?? [])];
  const existingPos = subs.findIndex(s => subscriberKey(s.surface, s.endpoint) === key);
  const rejoined = existingPos >= 0;
  const entry: SessionSubscriber = {
    surface: sub.surface,
    endpoint: sub.endpoint,
    role: opts.role ?? (rejoined ? subs[existingPos]!.role : 'rw'),
    joinedAt: rejoined ? subs[existingPos]!.joinedAt : now,
    lastSeenAt: now,
    presence: opts.presence ?? 'active',
  };
  if (rejoined) subs[existingPos] = entry; else subs.push(entry);
  meta.bindings = { ...(meta.bindings ?? {}), subscribers: subs };
  idx[pos] = meta;
  writeIndex(idx, root);
  reverseAdd(key, sessionId);
  recordSessionObservation({
    sessionId, subsystem: 'subscribe', event: rejoined ? 'rejoined' : 'joined',
    surface: sub.surface, subscriberKey: key,
    rationale: `${sub.surface} ${rejoined ? '재합류' : '합류'} (role=${entry.role})`,
    refs: { count: subs.length },
  });
  return meta;
}

/** 세션 구독 취소 = **leave**(나만 제거·남은 구독자 유지). detach(이동)와 구분 —
 *  transcript·index·bindings 채널키는 무변경. 없으면 null(no-op). 관측 발화. */
export function unsubscribeSession(
  sessionId: string,
  key: string,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) return null;
  const meta = idx[pos]!;
  const subs = meta.bindings?.subscribers ?? [];
  const next = subs.filter(s => subscriberKey(s.surface, s.endpoint) !== key);
  if (next.length === subs.length) return null; // 구독 아님 — no-op
  const rest = { ...(meta.bindings ?? {}) };
  if (next.length > 0) rest.subscribers = next; else delete rest.subscribers;
  meta.bindings = Object.keys(rest).length > 0 ? rest : undefined;
  idx[pos] = meta;
  writeIndex(idx, root);
  reverseRemove(key, sessionId);
  recordSessionObservation({
    sessionId, subsystem: 'subscribe', event: next.length === 0 ? 'left-last' : 'left',
    subscriberKey: key,
    rationale: `구독 이탈(leave·남은 구독자 ${next.length})`,
    refs: { remaining: next.length },
    // 마지막 구독자 이탈은 셀프힐 관심사(고아 후보) — 약간 상향.
    ...(next.length === 0 ? { importance: 5 } : {}),
  });
  return meta;
}

/** 세션의 현재 구독자 목록(영속 진실원천). presence 필터 옵션. */
export function listSubscribers(
  sessionId: string,
  opts: { presence?: SubscriberPresence } = {},
  root: string = sessionRoot(),
): SessionSubscriber[] {
  const meta = readIndex(root).find(m => m.id === sessionId);
  const subs = meta?.bindings?.subscribers ?? [];
  return opts.presence ? subs.filter(s => s.presence === opts.presence) : subs;
}

/** presence 전이(활성↔유예↔이탈) — P2 상태기계가 소비. 없으면 null. 관측 발화. */
export function setSubscriberPresence(
  sessionId: string,
  key: string,
  presence: SubscriberPresence,
  root: string = sessionRoot(),
): SessionMeta | null {
  const idx = readIndex(root);
  const pos = idx.findIndex(m => m.id === sessionId);
  if (pos < 0) return null;
  const meta = idx[pos]!;
  const subs = meta.bindings?.subscribers ?? [];
  const sPos = subs.findIndex(s => subscriberKey(s.surface, s.endpoint) === key);
  if (sPos < 0) return null;
  const prev = subs[sPos]!.presence;
  if (prev === presence) return meta; // 무변경
  const nextSubs = [...subs];
  nextSubs[sPos] = { ...subs[sPos]!, presence, lastSeenAt: new Date().toISOString() };
  meta.bindings = { ...(meta.bindings ?? {}), subscribers: nextSubs };
  idx[pos] = meta;
  writeIndex(idx, root);
  if (presence === 'left') reverseRemove(key, sessionId); else reverseAdd(key, sessionId);
  recordSessionObservation({
    sessionId, subsystem: 'presence', event: `${prev}→${presence}`, subscriberKey: key,
    surface: nextSubs[sPos]!.surface,
    rationale: `presence 전이 ${prev}→${presence}`,
    ...(presence === 'left' ? { stateful: true } : {}),
  });
  return meta;
}

/** C1 (cutover · 2026-07-16) — 서피스가 세션에 붙을 때 **옛 경로 배달 대상을 자동 구독자로
 *  등록**. 구독자 모델이 현실(옛 배달 대상)을 반영 → parity 수신자 일치(flip 안전 신호)·shadow
 *  는 여전히 excludeKeys 로 중복 안 냄. 멱등(subscribeSession dedup). fail-soft. */
export function autoSubscribeOldPath(sessionId: string, root: string = sessionRoot()): void {
  try {
    const meta = readIndex(root).find(m => m.id === sessionId);
    if (!meta) return;
    // C2 완전스코프 승격 — endpoint 는 <instance>:<botId>:<chatId>:<threadId>(멀티봇·인스턴스
    // 분리를 한 방어선으로). oldPathRecipientKeys 와 **같은 키**여야 parity 수신자 일치·shadow
    // excludeKeys 중복방지가 성립(둘 다 telegram/discordEndpointKey 사용).
    const tg = telegramOldPathTarget(meta);
    if (tg) subscribeSession(sessionId, { surface: 'telegram', endpoint: telegramEndpointKey(tg) }, {}, root);
    const dc = meta.bindings?.discord;
    if (dc) subscribeSession(sessionId, { surface: 'discord', endpoint: discordEndpointKey({ channelId: dc.channelId }) }, {}, root);
  } catch { /* fail-soft — auto-subscribe 실패가 세션 생성/attach 를 막지 않음 */ }
}

/** presence 셀프힐(§P1) — grace 유예가 TTL 초과한 구독자를 left 로 전이(연결 드롭 후
 *  재연결 실패 = 이탈 확정). 스위퍼/재연결 실패 경로가 호출. 반환 = 이탈시킨 구독자 키.
 *  now/ttl 주입 가능(테스트 결정론). reconcile 관측 발화(기록 vs 현실 self-perception). */
export interface PresenceReconcileOpts {
  /** grace 유예 상한(ms). 기본 5분. */
  ttlMs?: number;
  /** 기준 시각(ms). 기본 Date.now(). */
  now?: number;
}
export function reconcileSessionPresence(
  sessionId: string,
  opts: PresenceReconcileOpts = {},
  root: string = sessionRoot(),
): string[] {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now();
  const subs = listSubscribers(sessionId, { presence: 'grace' }, root);
  const evicted: string[] = [];
  for (const s of subs) {
    const seen = Date.parse(s.lastSeenAt);
    if (Number.isFinite(seen) && now - seen > ttl) {
      const key = subscriberKey(s.surface, s.endpoint);
      setSubscriberPresence(sessionId, key, 'left', root);
      evicted.push(key);
    }
  }
  if (evicted.length > 0) {
    recordSessionObservation({
      sessionId, subsystem: 'reconcile', event: 'grace-evicted',
      rationale: `유예 TTL(${Math.round(ttl / 1000)}s) 초과 ${evicted.length}건 이탈 확정`,
      stateful: true, refs: { evicted },
    });
  }
  return evicted;
}

/** presence 스위퍼(§P2 배선) — 인덱스 1회 스캔으로 grace 구독자 가진 세션만 골라
 *  reconcileSessionPresence 일괄 호출(데몬 주기 타이머가 호출). 반환 = 총 이탈 수.
 *  grace 구독자 없으면 세션당 비용 0(스킵). */
export function sweepSessionPresence(
  opts: PresenceReconcileOpts = {},
  root: string = sessionRoot(),
): number {
  const ids = readIndex(root)
    .filter(m => (m.bindings?.subscribers ?? []).some(s => s.presence === 'grace'))
    .map(m => m.id);
  let evicted = 0;
  for (const id of ids) evicted += reconcileSessionPresence(id, opts, root).length;
  return evicted;
}

/** Convert a session's JSONL into the ChatMessage shape the TUI's
 *  in-memory `chat.history` uses. Purpose: the laptop-resume path —
 *  after a mobile-side reply landed in the JSONL via /attach, the
 *  user calls `/session load <id>` in the TUI and the dashboard
 *  replaces its in-memory history with this result, so the next
 *  turn has the full cross-device context.
 *
 *  We drop `tool` rows (they're internal tool-round breadcrumbs —
 *  not meaningful as replayed user/assistant history) and blank
 *  entries. System messages are preserved so any attached preset
 *  survives the round-trip. Returns null when the session id is
 *  unknown so callers can render a friendly "not found". */
export function historyFromSession(
  sessionId: string,
  root: string = sessionRoot(),
): { meta: SessionMeta; history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> } | null {
  const loaded = loadSession(sessionId, root);
  if (!loaded) return null;
  const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  for (const m of loaded.messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    history.push({ role: m.role, content });
  }
  return { meta: loaded.meta, history };
}

/** List sessions that have ANY binding. Use opts.channel to filter. */
export function listBoundSessions(
  opts: { channel?: 'telegram' | 'cli' | 'discord' } = {},
  root: string = sessionRoot(),
): SessionMeta[] {
  const idx = readIndex(root);
  return idx.filter(m => {
    if (!m.bindings) return false;
    if (!opts.channel) return Object.keys(m.bindings).length > 0;
    return m.bindings[opts.channel] != null;
  });
}

/** Resolve a session by full id or unique prefix. Returns null on no
 *  match, throws on ambiguous prefix. */
export function resolveSessionId(
  prefix: string,
  root: string = sessionRoot(),
): string | null {
  const idx = readIndex(root);
  const matches = idx.filter(m => m.id.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`ambiguous session prefix "${prefix}" — matches ${matches.length} sessions`);
  }
  return matches[0].id;
}

// ── Active session marker ────────────────────────────────────────────

export function getActiveSessionId(): string | null {
  const p = activeFile();
  if (!existsSync(p)) return null;
  try {
    const s = readFileSync(p, 'utf-8').trim();
    return s || null;
  } catch {
    return null;
  }
}

export function setActiveSessionId(id: string): void {
  mkdirSync(dirname(activeFile()), { recursive: true });
  writeFileSync(activeFile(), id, 'utf-8');
}

export function clearActiveSessionId(): void {
  const p = activeFile();
  if (existsSync(p)) unlinkSync(p);
}

// ── Test helpers ─────────────────────────────────────────────────────

/** Purge every session file + index under `root`. Used by tests; do
 *  NOT call from production paths — no confirmation, no recycle bin. */
export function _nukeSessionsForTest(root: string = sessionRoot()): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      const s = statSync(p);
      if (s.isFile()) unlinkSync(p);
    } catch { /* ignore */ }
  }
}
