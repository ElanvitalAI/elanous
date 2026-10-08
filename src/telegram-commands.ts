// Telegram slash-command dispatcher.
//
// These are the commands that land in the user's Telegram "Menu"
// button + `/…` autocomplete. They're registered server-side via
// setMyCommands so adding a new one doesn't require anything on the
// user's side — the bot publishes the list on startup and clients
// fetch the updated menu automatically.
//
// Keep the command SET small and focused: each command should be
// useful in the Telegram UX specifically (one-shot text ops, no
// long-running work). For anything interactive or heavy, defer to
// the host-side CLI + dashboard.

import type { TgIncoming, TgMessageStreamer } from './telegram.js';
import type { UserConfig } from './user-config.js';
import { botCommandsToTelegram } from './bots/command-surface.js';
import { SLASH_COMMANDS, type SlashCommand } from './chat/index.js';
import { FEATURE_MATURITY, type Maturity } from './maturity/feature-maturity.js';
import { buildBotSlashCatalog } from './maturity/bot-slash-catalog.js';
import {
  appendMessage,
  attachTelegramBinding,
  createSession,
  unbindTelegramSession,
  detachTelegramBinding,
  findSessionByTelegramChat,
  getActiveSessionId,
  listBoundSessions,
  loadSession,
  resolveSessionId,
  forkSessionById,
} from './session/index.js';
import { getSkillIndex, applySkillFilter } from './skills/index.js';
import { parseSkillMd, executeSkill } from './skills/runner.js';
import { globalAcpSessionStore } from './acp/session-store.js';
import { canonicalizeBackendId } from './acp/backend-registry.js';
import { cancelAcpTurn, runAcpTurn, SLASH_FOCUS_TURNS_DEFAULT } from './acp/turn-runner.js';
import {
  setActiveDelegation, clearActiveDelegation, getActiveDelegation, delegationChatKey,
} from './acp/active-delegation.js';
import { executionFooter } from './telegram-exec-footer.js';
import { buildToolTraceMessage } from './session/chat.js';
import { recordInboundTurn } from './domains/surface-events.js';
import { recordAutonomousActionSafe } from './domains/autonomy-log.js';
import { handleTextChannelIntakeCommand } from './intake-plane/channel-command.js';
import { readDaemonSessionHistory } from './telegram/daemon-history-reader.js';
import { renderTelegramReplayPreviewHtml } from './telegram/replay-preview.js';
import { classifyIntake } from './ad-pipeline/intake.js';
import { createAdPipelineDeps, runAdPipeline } from './ad-pipeline/run.js';
import { projectCommand } from './telegram-project-command.js';
import { telegramNowSlash } from './context-bus/context-now-surfaces.js';
import { telegramLoopsStatus } from './telegram-loops-command.js';
import { telegramAwaySlash, telegramReleaseStatus } from './telegram-away-command.js';
import { createWishCard } from './intake-plane/wish-card.js';
import { telegramDecisionOwner } from './decisions/telegram-decision-cards.js';
import { CardStore } from './task-cards/card-store.js';
import type { ContextNowDeps } from './context-bus/context-now.js';
import type { RunningRunsResult } from './self-implement/running-runs.js';

/** How many prior user/assistant turns to pass into `executeSkill` as
 *  the `## Recent conversation` block. Mirrors the dashboard default
 *  (see src/dashboard.ts:391) — six is enough context for follow-ups
 *  like "now apply that summary to the next url" without blowing
 *  token budget on stale turns. */
const SKILL_PRIOR_TURN_LIMIT = 6;

/** Pull the last N user/assistant turns from the telegram session
 *  associated with this chat and shape them for `executeSkill`'s
 *  priorConversation opt. Returns [] for a fresh chat or when the
 *  session is unreadable (treat as first skill call). */
function buildTelegramSkillPriorConversation(
  chatId: number,
  threadId: number | undefined,
  botId: string | undefined,
  limit: number = SKILL_PRIOR_TURN_LIMIT,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const meta = findSessionByTelegramChat(chatId, threadId, botId);
  if (!meta) return [];
  const loaded = loadSession(meta.id);
  if (!loaded) return [];
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (let i = loaded.messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = loaded.messages[i]!;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    out.push({ role: m.role, text });
  }
  return out.reverse();
}

/** B (session carry-in) — a bounded recent-conversation digest prepended to a
 *  delegation's FIRST prompt so the coding agent can resolve references to
 *  the prior chat ("아까 그거 구현해줘"). Only injected on a FRESH ACP session
 *  (subsequent turns already have continuity), and tightly capped so it's
 *  negligible against the backend's context window. Empty ⇒ no preamble. */
export function buildAcpContextPreamble(
  chatId: number, threadId: number | undefined, botId: string | undefined,
  opts: { sinceTs?: string } = {},
): string {
  const meta = findSessionByTelegramChat(chatId, threadId, botId);
  if (!meta) return '';
  return buildAcpContextPreambleForSession(meta.id, opts);
}

/** Session-id keyed core of the carry-in preamble (M4b) — the discord
 *  surface keys its chat session by channelId, not telegram chat, so it
 *  consumes this directly. Formatting/caps identical to the telegram
 *  wrapper above. */
export function buildAcpContextPreambleForSession(
  sessionId: string,
  opts: { sinceTs?: string } = {},
): string {
  const loaded = loadSession(sessionId);
  if (!loaded) return '';
  const sinceMs = opts.sinceTs ? Date.parse(opts.sinceTs) : NaN;
  const delta = Number.isFinite(sinceMs);
  // Fresh session ⇒ last 6 turns (resolve "그거/아까"). Continued session ⇒
  // the DELTA since this backend last ran (interleaved self / other-backend
  // turns) so a `/cc → self → /cc` handoff carries the interim work. Walk
  // newest→oldest; for delta, stop at the last-activity mark.
  const maxTurns = delta ? 12 : 6;
  const picked: Array<{ role: string; text: string }> = [];
  for (let i = loaded.messages.length - 1; i >= 0 && picked.length < maxTurns; i--) {
    const m = loaded.messages[i]!;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (delta && m.ts && Date.parse(m.ts) <= sinceMs) break;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    picked.push({ role: m.role, text });
  }
  if (picked.length === 0) return '';
  picked.reverse();
  const lines = picked.map(t => `${t.role === 'user' ? '사용자' : 'elanous'}: ${t.text.replace(/\s+/g, ' ').slice(0, 240)}`);
  const body = lines.join('\n').slice(0, delta ? 2500 : 1500);
  const header = delta
    ? '[직전 위임 이후 이 대화에서 진행된 상황(self·다른 백엔드 포함) — 이어서 반영. 실제 지시는 아래]'
    : '[최근 대화 맥락 — 이 위임 직전 사용자와 나눈 대화. "그거/아까/방금" 등 참조 해소용. 실제 지시는 아래]';
  return `${header}\n${body}\n---\n`;
}

/** A single registered slash command. Handlers return:
 *    - a string → the bot replies with it (markdown-aware)
 *    - void     → the bot stays silent (handler already sent via bot ref)
 *    - throw    → caught by dispatcher, turned into "Error: …" reply */
export interface TgSlashCommand {
  /** Lowercase name without the `/`, e.g. "help". 1-32 chars,
   *  letters / digits / underscore only (Telegram constraint). */
  name: string;
  /** One-line description shown in the client menu. 1-256 chars. */
  description: string;
  /** When true, the caller posts a `⏳ Working…` placeholder and
   *  hands the handler a `streamer` on `opts` so partial output
   *  edits the placeholder in-place. Use for skill runs and other
   *  multi-second ops. Default false = instant one-shot reply. */
  streaming?: boolean;
  /** Handler. args is the tokenized tail after the command. */
  handler: (args: string[], ctx: TgIncoming, opts: TgCommandContext) => Promise<string | void>;
}

/** Host-side context passed to every command handler. Keeps the
 *  handler pure (no module-level singletons) so we can unit-test. */
export interface TgCommandContext {
  userConfig: UserConfig;
  /** All registered commands — used by `/help` to enumerate. */
  allCommands: TgSlashCommand[];
  sendButtons?: (text: string, buttons: Array<Array<{ text: string; data: string }>>) => Promise<void>;
  /** When the caller posted a placeholder for a streaming command,
   *  the streamer edits it in-place as the handler accumulates
   *  output. Undefined for instant commands. Handlers must tolerate
   *  streamer=undefined (fall back to returning a final string). */
  streamer?: TgMessageStreamer;
  /** Lazily download + normalize the incoming message's attachments
   *  into the ACP ContentBlock shape. Text-only slash commands
   *  (/help, /status, /ping) ignore this to avoid paying the
   *  download round-trip. /cc and friends call it so photos + docs
   *  land in the prompt. Returns [] when the message had nothing
   *  attached. */
  downloadAttachments?: () => Promise<import('./acp/content-blocks.js').NormalizedAttachment[]>;
  /** Tier 1 telegram fan-out arc — opaque bridge handle. /resume
   *  casts to TelegramAcpBridge and calls
   *  setDaemonSessionForChat. Other commands ignore. Kept opaque to
   *  avoid a slash-commands → telegram-bridge import cycle. */
  daemonBridge?: unknown;
  /** Surface-scoped HITL confirm channel bound to THIS chat + thread.
   *  `/cc` and friends pass it into `runAcpTurn` so a delegated Claude
   *  Code / Codex agent's permission (and clarifying-question) prompts
   *  land back in the chat that issued the mission. Undefined when the
   *  bot has no inline-keyboard HITL wired. */
  hitlConfirmChannel?: import('./hitl/confirm.js').ConfirmChannel;
  /** Paired multi-option question channel for THIS chat — lets a
   *  delegated agent's structured questions render as option buttons
   *  instead of a yes/no collapse. */
  hitlQuestionChannel?: import('./hitl/question.js').QuestionChannel;
  /** 🖼️ 이 채팅에 «파일·그림»을 거는 관. 표면마다 있을 수도 없을 수도 있어서 optional 이다 —
   *  ⛔ 부르는 쪽은 「없다」를 «조용히 글로» 떨어뜨리지 말고 «그 사실»을 사람에게 말해야 한다.
   *  `/screen <봇> --shot` 이 이것으로 화면 한 장을 건다. */
  fileSink?: import('./channel/file-sink.js').FileSink;
}

/** Dispatch result. Null when the text wasn't a recognized slash
 *  command (caller falls through to the LLM path). */
export type TgDispatchResult =
  | { handled: true; reply: string | void }
  | { handled: false };

/** Parse a message body as a slash command WITHOUT running the
 *  handler. The caller (telegram.ts handleIncoming) uses this to
 *  decide whether to post a placeholder + attach a streamer (for
 *  streaming commands) before invoking the handler itself. Returns:
 *    - `{kind:'none'}`    — not a slash attempt (falls through to LLM)
 *    - `{kind:'unknown'}` — slash-shaped but name not registered
 *    - `{kind:'match'}`   — matched command + parsed args */
export type TgSlashParse =
  | { kind: 'none' }
  | { kind: 'unknown'; name: string }
  | { kind: 'match'; cmd: TgSlashCommand; args: string[] };

export function parseTelegramSlash(text: string, commands: TgSlashCommand[]): TgSlashParse {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'none' };
  const firstSpace = trimmed.indexOf(' ');
  const head = firstSpace >= 0 ? trimmed.slice(1, firstSpace) : trimmed.slice(1);
  const tail = firstSpace >= 0 ? trimmed.slice(firstSpace + 1) : '';
  const name = head.split('@')[0]!.toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(name)) return { kind: 'none' };
  const args = tail.trim() ? tail.trim().split(/\s+/) : [];
  const cmd = commands.find(c => c.name === name);
  if (!cmd) return { kind: 'unknown', name };
  return { kind: 'match', cmd, args };
}

/** Build the "Unknown command" reply — enumerates available commands
 *  so the user can self-correct without a round-trip. Exposed so the
 *  caller (handleIncoming) can send it directly without going through
 *  dispatchTelegramSlash when it already has the parse result. */
export function buildUnknownSlashReply(name: string, commands: TgSlashCommand[]): string {
  const unsupported = buildBotSlashCatalog({
    surface: 'telegram', coreCommands: SLASH_COMMANDS, maturity: FEATURE_MATURITY,
    handledCommands: commands,
  }).unsupportedReply(name);
  if (unsupported) return unsupported;
  const names = commands.map(c => `/${c.name}`).join(' ');
  return `Unknown command: /${name}\nAvailable: ${names}`;
}

/** Parse a message body and dispatch if it's a slash command. Matches
 *  leading `/name` or `/name@botusername` (Telegram's group-chat
 *  addressing form). Unknown commands surface a "Unknown command"
 *  reply rather than falling through to the LLM — less surprising
 *  than having `/foo` accidentally feed prose to the model. */
export async function dispatchTelegramSlash(
  ctx: TgIncoming,
  opts: TgCommandContext,
): Promise<TgDispatchResult> {
  const parsed = parseTelegramSlash(ctx.text, opts.allCommands);
  if (parsed.kind === 'none') return { handled: false };
  if (parsed.kind === 'unknown') {
    return { handled: true, reply: buildUnknownSlashReply(parsed.name, opts.allCommands) };
  }
  try {
    const reply = await parsed.cmd.handler(parsed.args, ctx, opts);
    return { handled: true, reply };
  } catch (err: any) {
    return { handled: true, reply: `Error running /${parsed.cmd.name}: ${err?.message ?? String(err)}` };
  }
}

/** Start a FRESH conversation on this chat — unbind the current session so
 *  the next message creates a new one, but PRESERVE the old transcript
 *  (unbind, not delete). Shared by /new, /clear, /reset (aliases matching
 *  chat muscle-memory). The old session stays in history — `elanous session
 *  list/show <id>` still reach it. (Previously this deleted the whole
 *  session, wiping past history — wrong concept: /new should reset context,
 *  not erase the record.) */
/** C (smart termination) — drop this chat's bound ACP sessions across all
 *  backends. Shared by /cc_clear and /new so a topic reset also ends the
 *  delegated coding session (previously /new left the ACP session live, so a
 *  later /cc silently resumed a stale coding context). Returns dropped ids. */
function clearChatAcpSessions(ctx: TgIncoming): string[] {
  const store = globalAcpSessionStore();
  const dropped: string[] = [];
  // Canonical backend ids — sessions are stored under 'codex-app-server'
  // (the '/cdx' alias 'codex' is normalized before the store is keyed).
  for (const backendId of ['claude', 'codex-app-server', 'gemini']) {
    if (store.delete(ctx.chatId, backendId, ctx.threadId)) dropped.push(backendId);
  }
  return dropped;
}

function dropChatSessionReply(ctx: TgIncoming): string {
  // Exit any active ACP delegation AND drop the bound coding sessions — /new
  // resets the WHOLE context (chat + delegated coding), not just the chat.
  clearActiveDelegation(delegationChatKey(ctx.botId, ctx.chatId, ctx.threadId));
  const droppedAcp = clearChatAcpSessions(ctx);
  const sess = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
  if (!sess) {
    return droppedAcp.length > 0
      ? `_No chat session — but ended ACP coding session(s): ${droppedAcp.join(', ')}. Next message starts fresh._`
      : '_No active session — next message will create one._';
  }
  const unbound = unbindTelegramSession(sess.id);
  const acpNote = droppedAcp.length > 0 ? ` ACP 코딩 세션(${droppedAcp.join(', ')})도 종료.` : '';
  return unbound
    ? `✓ 새 대화 시작. 이전 세션 \`${sess.id.slice(0, 8)}\`(${sess.messageCount} msg)은 기록에 **보존**됨 (\`elanous session show ${sess.id.slice(0, 8)}\`).${acpNote} 다음 메시지부터 새 세션.`
    : `_Session \`${sess.id.slice(0, 8)}\` was already gone._`;
}

/** `/runs` — the Telegram twin of TUI `/harness runs`: the same `renderRunningRuns` text over the same
 *  production-universe query. The query is injectable so a test can prove the reply equals the renderer
 *  output for one data set. Long replies are chunked by the bot's sender, so no run line is dropped here. */
export async function telegramRunsSlash(args: readonly string[], query?: () => RunningRunsResult,
  runCli: (argv: readonly string[]) => Promise<{ code: number | null; stdout: string }> = runSelfCli): Promise<string> {
  if (args.length > 0) return 'Usage: /runs';
  const { queryRunningRuns, renderRunningRuns } = await import('./self-implement/running-runs.js');
  if (query) return renderRunningRuns(query());
  // The ledger scan is synchronous and took 30–58 s under load (TC 10-07 17:37) — run inside the daemon it would freeze
  // every bot and HTTP reply for that long. Ask the CLI twin (`self running-runs`, same renderer) in a child process,
  // pinned to this daemon's universe; fall back in-process only when the child cannot start.
  const { effectiveInstanceRoot } = await import('./instance/resolve.js');
  try {
    const { code, stdout } = await runCli(['--config-dir', effectiveInstanceRoot(), 'self', 'running-runs']);
    if (code === 0 && stdout.trim()) return stdout.trimEnd();
  } catch { /* fall through */ }
  return renderRunningRuns(queryRunningRuns({ includeTest: false, caller: 'telegram' }));
}

/** Run this same elanous entry as a child (`bun <entry> …`) with a hard time limit. */
async function runSelfCli(argv: readonly string[]): Promise<{ code: number | null; stdout: string }> {
  const { spawn } = await import('node:child_process');
  const entry = process.argv[1];
  if (!entry) throw new Error('no elanous entry');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')); }, 120_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}

/** Build the default command set for a Telegram bot wired via
 *  botFromConfig. Returns the array rather than mutating globals so
 *  tests can construct a variant set with stubbed handlers. */
export function defaultTelegramCommands(
  nowDeps?: ContextNowDeps,
  coreCommands: readonly SlashCommand[] = SLASH_COMMANDS,
  maturity: { tuiSlash: Readonly<Record<string, Maturity>>; telegramCommand: Readonly<Record<string, Maturity>>; discordCommand: Readonly<Record<string, Maturity>> } = FEATURE_MATURITY,
  runningRunsQuery?: () => RunningRunsResult,
): TgSlashCommand[] {
  const handled: TgSlashCommand[] = [
    {
      name: 'help',
      description: 'List available commands',
      handler: async (_args, _ctx, { allCommands }) => {
        const lines = ['**Commands**', ''];
        for (const c of allCommands) {
          lines.push(`• /${c.name} — ${c.description}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'now',
      description: 'Show current release, decisions, seats and context: /now [topic]',
      handler: async (args) => telegramNowSlash(args, nowDeps),
    },
    {
      name: 'loops',
      description: '루프·크론 현황 — 늦음·실패를 먼저 보여줍니다',
      handler: (args) => telegramLoopsStatus(args),
    },
    {
      name: 'runs',
      description: 'Running harness runs — same output as TUI /harness runs',
      handler: async (args) => telegramRunsSlash(args, runningRunsQuery),
    },
    {
      name: 'release',
      description: '발행 현황 — 지금 런·노드·막힘을 한 통으로',
      handler: async (args) => telegramReleaseStatus(args),
    },
    {
      name: 'away',
      description: '외출 모드 — /away on|off|status (켜면 발행 전이를 여기로)',
      handler: async (args) => telegramAwaySlash(args),
    },
    {
      name: 'status',
      description: 'Show bot identity, current session, provider + model',
      handler: async (_args, ctx, { userConfig }) => {
        const sess = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
        const provider = userConfig.llm.provider ?? '(auto)';
        const model = userConfig.llm.model ?? '(provider default)';
        const lines = [
          '**Status**',
          '',
          `provider: \`${provider}\``,
          `model:    \`${model}\``,
          `session:  ${sess ? `\`${sess.id}\` (${sess.messageCount} msgs)` : '_(new — next message starts one)_'}`,
        ];
        return lines.join('\n');
      },
    },
    {
      name: 'new',
      description: 'Start a fresh conversation (drops this chat\'s session)',
      handler: async (_args, ctx) => dropChatSessionReply(ctx),
    },
    {
      name: 'clear',
      description: 'Clear the conversation & reset the session (alias of /new)',
      handler: async (_args, ctx) => dropChatSessionReply(ctx),
    },
    {
      name: 'reset',
      description: 'Reset the session — start fresh (alias of /new)',
      handler: async (_args, ctx) => dropChatSessionReply(ctx),
    },
    {
      name: 'brain',
      description: 'ACP 위임 연속 모드를 끄고 elanous 브레인(self)으로 복귀',
      handler: async (_args, ctx) => {
        const key = delegationChatKey(ctx.botId, ctx.chatId, ctx.threadId);
        const was = getActiveDelegation(key);
        clearActiveDelegation(key);
        return was
          ? `🧠 브레인(self) 모드로 복귀. (was: acp-${was})`
          : '🧠 이미 브레인(self) 모드입니다.';
      },
    },
    {
      name: 'ping',
      description: 'Health check — returns pong + latency hint',
      handler: async () => {
        // The actual RTT is measured by the user (their message
        // timestamp vs. ours); we just ack fast so the number is
        // meaningful. Include a ✓ so it reads as a "bot is alive"
        // signal at a glance.
        return `✓ pong (${new Date().toISOString()})`;
      },
    },
    {
      name: 'provider',
      description: 'Show the LLM provider + model this bot is using',
      handler: async (_args, _ctx, { userConfig }) => {
        const provider = userConfig.llm.provider ?? '(auto)';
        const model = userConfig.llm.model ?? '(provider default)';
        const lines = [
          '**LLM provider**',
          '',
          `provider: \`${provider}\``,
          `model:    \`${model}\``,
          '',
          '_Change via `elanous setup` on the host — the bot reads from user-config._',
        ];
        return lines.join('\n');
      },
    },
    {
      name: 'skills',
      description: 'List installed skills the bot can run via /skill',
      handler: async (_args, _ctx, { userConfig }) => {
        // Respect the user's allow/deny config so the mobile list
        // matches what actually routes on the host (session 21).
        const skillsCfg = userConfig.skills;
        const index = applySkillFilter(getSkillIndex(), {
          allow: skillsCfg.allow, deny: skillsCfg.deny,
        });
        if (index.length === 0) {
          return '_No skills indexed. Install via `elanous sync` on the host._';
        }
        const lines = ['**Installed skills**', ''];
        // Cap the description to 80 chars so a 40-skill list doesn't
        // blow past 4096. Users can drill in with /skill <name> to
        // get the full SKILL.md prompt behavior.
        for (const s of index) {
          const d = s.description.length > 80 ? s.description.slice(0, 77) + '…' : s.description;
          lines.push(`• \`${s.name}\` — ${d}`);
        }
        lines.push('', '_Run: /skill <name> <input>_');
        return lines.join('\n');
      },
    },
    {
      name: 'skill',
      description: 'Run a named skill: /skill <name> <input>',
      streaming: true,
      handler: runNamedSkill,
    },
    {
      name: 'digest',
      description: 'Summarize a URL / file via the omni-digest skill',
      streaming: true,
      handler: async (args, ctx, opts) =>
        runNamedSkill(['omni-digest', ...args], ctx, opts),
    },
    {
      name: 'cc',
      description: 'Run Claude Code (ACP): /cc <prompt>',
      streaming: true,
      handler: async (args, ctx, opts) => runAcpViaSlash('claude', args, ctx, opts),
    },
    {
      name: 'cdx',
      description: 'Run OpenAI Codex (ACP): /cdx <prompt>',
      streaming: true,
      handler: async (args, ctx, opts) => runAcpViaSlash('codex', args, ctx, opts),
    },
    {
      name: 'gem',
      description: 'Run Google Gemini (ACP): /gem <prompt>',
      streaming: true,
      handler: async (args, ctx, opts) => runAcpViaSlash('gemini', args, ctx, opts),
    },
    {
      name: 'cc_clear',
      description: 'Drop this chat\'s ACP sessions (all backends) — next turn starts fresh',
      handler: async (_args, ctx) => {
        // Also exit active delegation — clearing the sessions means there's
        // nothing to continue.
        clearActiveDelegation(delegationChatKey(ctx.botId, ctx.chatId, ctx.threadId));
        const dropped = clearChatAcpSessions(ctx);
        return dropped.length > 0
          ? `✓ Cleared sessions: ${dropped.join(', ')}. Next turn starts fresh.`
          : '_No ACP sessions in this chat._';
      },
    },
    {
      name: 'local',
      description: 'Local LLM — status / ping / test (OpenAI-compatible endpoint)',
      streaming: true,
      handler: async (args, _ctx, { userConfig, streamer }) => {
        const sub = (args[0] ?? 'status').toLowerCase();
        const url = userConfig.llm.baseUrl ?? process.env.LOCAL_LLM_URL ?? '';
        const model = userConfig.llm.model ?? process.env.LOCAL_LLM_MODEL ?? '';

        if (sub === 'status') {
          const lines = [
            '**Local LLM**',
            '',
            `provider : \`${userConfig.llm.provider}\``,
            `baseUrl  : \`${url || '(unset)'}\``,
            `model    : \`${model || '(unset)'}\``,
            '',
            '_subcommands: /local ping | /local test_',
          ];
          return lines.join('\n');
        }

        if (!url || !model) {
          return '_baseUrl or model not configured. Run `elanous local setup --url … --model …` on the host._';
        }

        const { resolveLocalEndpoints, runLocalLLMCompat } = await import('./local-llm-test.js');

        if (sub === 'ping') {
          const { models } = resolveLocalEndpoints(url);
          const t0 = Date.now();
          try {
            const res = await fetch(models, { signal: AbortSignal.timeout(10_000) });
            const ms = Date.now() - t0;
            return res.ok
              ? `✓ ${models} — HTTP ${res.status}, ${ms}ms`
              : `✗ ${models} — HTTP ${res.status}`;
          } catch (err: any) {
            return `✗ ${err?.message ?? err}`;
          }
        }

        if (sub === 'test') {
          // Stream matrix rows into the placeholder as they complete so
          // the user watches progress live rather than waiting ~60s for
          // a single edit at the end.
          let preview = '⏳ running compat matrix…\n';
          streamer?.edit(preview);
          const summary = await runLocalLLMCompat({
            baseUrl: url,
            model,
            timeoutMs: 60_000,
            onProgress: (r) => {
              const g = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '·';
              preview += `${g} ${r.label} — ${r.detail ?? ''}\n`;
              streamer?.edit(preview);
            },
          });
          const { pass, fail, skip } = summary.counts;
          return preview + `\n**total** ${summary.results.length}  pass=${pass}  fail=${fail}  skip=${skip}  (${summary.totalMs}ms)`;
        }

        return `Unknown /local subcommand: \`${sub}\`. Try: status | ping | test`;
      },
    },
    {
      name: 'attach',
      description: 'Attach this chat to a TUI session: /attach [session-prefix] (default = laptop\'s active)',
      handler: async (args, ctx) => {
        // Decide which session to bind: explicit prefix wins, else
        // whatever the TUI currently treats as its active session.
        // The TUI-side `setActiveSessionId` lives in ~/.local/state/…
        // so the telegram daemon can read it directly.
        let targetId: string | null = null;
        if (args[0]) {
          try {
            targetId = resolveSessionId(args[0]);
          } catch (err: any) {
            return `_Ambiguous session prefix \`${args[0]}\` — be more specific._`;
          }
          if (!targetId) return `_No session matches prefix \`${args[0]}\`._`;
        } else {
          targetId = getActiveSessionId();
          if (!targetId) {
            return '_No active TUI session and no prefix given. Run `/telegram attach` from the laptop instead, or pass `/attach <session-prefix>`._';
          }
        }
        try {
          const meta = attachTelegramBinding(targetId, ctx.chatId, ctx.threadId);
          return [
            `✓ Attached session \`${meta.id.slice(0, 8)}\` to this chat.`,
            `_${meta.messageCount} prior turns loaded. Next message continues where the laptop left off._`,
          ].join('\n');
        } catch (err: any) {
          return `Attach failed: ${err?.message ?? err}`;
        }
      },
    },
    {
      name: 'detach',
      description: 'Detach this chat from its attached session (next message starts fresh)',
      handler: async (_args, ctx) => {
        // The chat may be bound via EITHER the runtime bindings API
        // (our /attach) OR the legacy source==telegram auto-created
        // session. findSessionByTelegramChat tries both. Detach only
        // touches the bindings entry — it won't delete a legacy
        // auto-session (that's what /new is for).
        const sess = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
        if (!sess || !sess.bindings?.telegram) {
          return '_No explicit attachment on this chat — /new drops the auto-session instead._';
        }
        const dropped = detachTelegramBinding(sess.id);
        return dropped
          ? `✓ Detached session \`${sess.id.slice(0, 8)}\`. Next message starts a fresh session.`
          : '_Already detached._';
      },
    },
    {
      name: 'sessions',
      description: 'List sessions bound to this chat + recently attached ones',
      handler: async (_args, ctx) => {
        const bound = listBoundSessions({ channel: 'telegram' });
        if (bound.length === 0) return '_No Telegram-attached sessions on this daemon._';
        const lines = ['**Telegram-attached sessions**', ''];
        for (const m of bound) {
          const b = m.bindings?.telegram;
          const marker = b?.chatId === ctx.chatId && (b?.threadId ?? 0) === (ctx.threadId ?? 0)
            ? '▸'
            : ' ';
          const title = m.title || '(no title)';
          lines.push(`${marker} \`${m.id.slice(0, 8)}\` → chat ${b?.chatId ?? '?'} — ${m.messageCount} msgs — ${title.slice(0, 40)}`);
        }
        lines.push('', '_▸ = this chat. Use `/detach` to unbind the attached session here._');
        return lines.join('\n');
      },
    },
    projectCommand(),
    {
      name: 'wish',
      description: '소원을 카드로 남기기',
      handler: async (args, ctx, { userConfig }) => {
        if (String(ctx.userId) !== telegramDecisionOwner(userConfig) || ctx.chatId !== ctx.userId || !ctx.isDm) {
          return '대표만 쓸 수 있습니다';
        }
        if (args.length === 0) return '/wish <소원 한 줄>';
        const store = new CardStore();
        try {
          const card = createWishCard({ text: args.join(' '), source: 'telegram', ref: `${ctx.chatId}:${ctx.messageId}`,
            replyTo: { surface: 'telegram', chatId: String(ctx.chatId), ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}), ...(ctx.botId ? { botId: ctx.botId } : {}) } }, store);
          return `소원 카드로 남겼습니다 — ${card.title} (카드 ${card.cardId.slice(0, 8)})`;
        } finally {
          store.close();
        }
      },
    },
    {
      name: 'fork',
      description: 'Fork the current chat session (or /fork <prefix>) and continue HERE on the fork · time-travel: /fork before:N',
      handler: async (args, ctx) => {
        // S2 (2026-07-12) — 세션 패브릭: 지금까지의 맥락을 복제해
        // "여기서부터 갈라져서 계속". 원본은 그대로 보존·복귀 가능.
        // S3 — `before:N` 토큰: N번째 사용자 발화 이전으로 타임트래블 포크.
        const beforeTok = args.find((a) => /^before:\d+$/i.test(a.trim()));
        const beforeUser = beforeTok ? Number(beforeTok.trim().split(':')[1]) : undefined;
        let sourceId: string | null = null;
        const prefix = (args.find((a) => a.trim() && a !== beforeTok) ?? '').trim();
        if (prefix) {
          try { sourceId = resolveSessionId(prefix); }
          catch (err) { return `⚠️ ${err instanceof Error ? err.message : String(err)}`; }
          if (!sourceId) return `세션을 찾을 수 없습니다: \`${prefix}\``;
        } else {
          sourceId = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId)?.id ?? null;
          if (!sourceId) return '포크할 세션이 없습니다 — 먼저 대화를 시작하거나 `/fork <prefix>`로 지정하세요.';
        }
        const fork = forkSessionById(sourceId, beforeUser !== undefined ? { beforeUser } : {});
        if (!fork) return `세션을 찾을 수 없습니다: \`${sourceId.slice(0, 8)}\``;
        // Move this chat onto the fork: release the old association
        // (transcript preserved) and bind the fork explicitly.
        const current = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
        if (current) unbindTelegramSession(current.id);
        try { attachTelegramBinding(fork.meta.id, ctx.chatId, ctx.threadId); }
        catch (err) { return `⚠️ 포크는 생성됐으나 바인딩 실패: ${err instanceof Error ? err.message : String(err)}`; }
        clearActiveDelegation(delegationChatKey(ctx.botId, ctx.chatId, ctx.threadId));
        return [
          `⑂ 세션 \`${sourceId.slice(0, 8)}\` 포크 → \`${fork.meta.id.slice(0, 8)}\` (${fork.messages.length}개 턴 복사)`,
          '이 채팅은 이제 포크에서 이어집니다.',
          `원본 복귀: \`/attach ${sourceId.slice(0, 8)}\``,
        ].join('\n');
      },
    },
    {
      name: 'resume',
      description: 'Resume a daemon session by id: /resume <elanous-session-N> — binds chat + shows last turns',
      handler: async (args, ctx, opts): Promise<string | void> => {
        // Tier 1 telegram fan-out arc — /resume surfaces a daemon
        // session's recent turns as immediate context. PR 3 scope:
        // preview only. PR 4 wires the daemon-sessionId into the
        // bridge's chat→session map so subsequent messages route
        // through the resumed session (currently the next message
        // still hits the chat's default elanous-TUI session).
        const id = (args[0] ?? '').trim();
        if (!id) {
          return [
            'Usage: `/resume <daemon-session-id>`',
            '',
            '_Lists daemon sessions with `/status` (when ELANOUS_HISTORY_DIR is set on the daemon)._',
          ].join('\n');
        }

        const result = readDaemonSessionHistory(id);
        if (!result.exists) {
          const hint = result.historyDir
            ? `_searched ${result.historyDir}_`
            : '_(daemon runtime metadata missing — is `elanous serve` running with ELANOUS_HISTORY_DIR set?)_';
          return [
            `✗ Unknown daemon session: \`${id}\``,
            hint,
          ].join('\n');
        }

        // Tier 1 telegram fan-out arc — bind chat to the daemon
        // session before rendering preview. Subsequent user
        // messages route through this sessionId via the bot's
        // resolveDaemonSessionId callback. Cursor starts at the
        // current jsonl length so the preview's last-N doesn't
        // get re-emitted on the next bot restart's catch-up.
        const bridge = opts.daemonBridge as {
          setDaemonSessionForChat?: (a: {
            chatId: number;
            threadId: number | undefined;
            sessionId: string;
            lastSeenMsgIdx: number;
          }) => void;
        } | undefined;
        bridge?.setDaemonSessionForChat?.({
          chatId: ctx.chatId,
          threadId: ctx.threadId,
          sessionId: id,
          lastSeenMsgIdx: result.messages.length,
        });

        if (result.messages.length === 0) {
          return [
            `↩ Resumed daemon session \`${id}\``,
            '_(history is empty — first turn coming up)_',
          ].join('\n');
        }

        const previews = renderTelegramReplayPreviewHtml(result.messages, {
          limit: 5,
          linesPerMessage: 8,
          header: `↩ Resumed <code>${id}</code> — last turns:`,
          moreFooterPrefix: '_…earlier turns omitted, total:_',
        });

        // The slash dispatcher treats handler return values as a
        // single markdown reply. We have multiple HTML pre-rendered
        // entries (one per message after the 4096 cap split). Use
        // the streamer when present (it supports incremental edits
        // — but for /resume the messages are pre-formed and final).
        // Fallback: stitch the html chunks with a separator and
        // return as one markdown blob; the dispatcher will pass it
        // through markdownToTelegramHtml a second time, which is
        // idempotent for already-converted html.
        if (opts.streamer) {
          // Streaming path — fold all preview chunks into one edit.
          // Telegram's edit takes markdown via the bot's `edit()`,
          // which converts to HTML internally. Collapsing here keeps
          // PR 3 scope narrow (PR 4 sinker handles per-chunk
          // sendMessage with rate-limit awareness).
          opts.streamer.edit(previews.map((p) => p.html).join('\n\n'));
          return;
        }
        return previews.map((p) => p.html).join('\n\n');
      },
    },
    {
      name: 'ad',
      description: 'Create an advertising plan from a URL, brief, or attached image',
      streaming: true,
      handler: async (args, _ctx, opts) => {
        const attachments = opts.downloadAttachments ? await opts.downloadAttachments() : [];
        const imagePaths = attachments.filter((attachment) => attachment.kind === 'photo').map((attachment) => attachment.localPath);
        const classified = classifyIntake({ values: args, imagePaths });
        if (!classified.ok) return `Cannot run /ad: ${classified.message}`;
        const result = await runAdPipeline(classified.intake, createAdPipelineDeps({
          ask: async (gate, plan) => {
            const answer = await opts.hitlConfirmChannel?.request({
              prompt: `Approve advertising gate ${gate}?`,
              detail: `Input: ${plan.intake.kind}`,
              yesLabel: 'Approve',
              noLabel: 'Reject',
            });
            return answer === true;
          },
          report: (line) => { opts.streamer?.edit(line); },
        }));
        if (result.status === 'rejected') return `Advertising pipeline stopped at ${result.stoppedGate}.`;
        if (result.status === 'blocked') return `Advertising pipeline blocked: ${result.reason}`;

        const readiness = result.productionReadiness;
        if (!readiness) return `Advertising gates approved; production readiness unmeasured: ${result.unwiredProduction.join(', ') || 'no master output'}.`;

        const needsInput = readiness
          .filter((step) => step.status === 'needs-input')
          .map((step) => `${step.step} (${step.missing})`);
        const unwired = readiness
          .filter((step) => step.status === 'unwired')
          .map((step) => step.step);
        const details = [
          needsInput.length ? `production incomplete: ${needsInput.join(', ')}` : '',
          unwired.length ? `not yet implemented: ${unwired.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        return `Advertising gates approved; ${details || 'production ready'}.`;
      },
    },
    {
      name: 'intake',
      description: 'Capture raw notes into the task sketchbook plane',
      handler: async (args, ctx, opts) => {
        return handleTextChannelIntakeCommand(args, {
          surface: 'telegram',
          source: 'telegram',
          text: ctx.text,
          attachments: opts.downloadAttachments ? await opts.downloadAttachments() : [],
          actor: {
            id: String(ctx.userId),
            display: ctx.userName ?? String(ctx.userId),
          },
          channelContext: {
            chatId: String(ctx.chatId),
            ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
          },
        });
      },
    },
    {
      name: 'decisions',
      description: '열린 결정 목록 — 카드를 다시 보내 여기서 바로 정할 수 있습니다',
      handler: async (_args, ctx) => {
        const { telegramDecisionService } = await import('./decisions/telegram-decision-cards.js');
        const service = telegramDecisionService();
        if (!service) return '결정 카드가 이 봇에 연결되어 있지 않습니다.';
        if (!service.isOwner(String(ctx.userId))) return '결정은 소유자만 볼 수 있습니다.';
        // A group would show every member the cards (and route memos from them) — private chat only (TC review #22660).
        if (ctx.chatId !== ctx.userId) return '결정은 개인 대화에서만 볼 수 있습니다.';
        return service.listOpen(String(ctx.chatId));
      },
    },
    ...(['coo', 'cto', 'cmo', 'cxo'] as const).map((command) => ({
      name: command,
      description: `${command.toUpperCase()} 자리에 일을 넘깁니다 — /${command} <할 일> (조율 채널 ⊕ 자리 메시지함)`,
      handler: async (args: string[], ctx: { chatId: number; userId: number }) => {
        const [{ handleCeoSeatCommand }, { telegramDecisionOwner }, { runGh }, { getUserConfig }, { openMsgStore }] = await Promise.all([
          import('./seat-dispatch/ceo-commands.js'), import('./decisions/telegram-decision-cards.js'), import('./decisions/decision-cards.js'),
          import('./user-config.js'), import('./msg/msg-store.js'),
        ]);
        const cfg = getUserConfig();
        const replyTarget = (cfg.raw?.decisions as { replyGhPr?: unknown } | undefined)?.replyGhPr;
        return handleCeoSeatCommand(command, args, ctx, {
          ownerId: telegramDecisionOwner(cfg), replyTarget: typeof replyTarget === 'string' ? replyTarget : null, runGh,
          append: (message) => { const store = openMsgStore(); try { return store.append(message); } finally { store.close(); } },
        });
      },
    })),
    {
      name: 'work',
      description: '글을 알맞은 곳(흡수·태스크·하니스)에 넣고 결과를 여기로 답합니다 — /work [absorb|tasks|graph] <글>',
      handler: async (args, ctx) => {
        const { handleTelegramWork } = await import('./intake-plane/telegram-work.js');
        return handleTelegramWork(args, { chatId: ctx.chatId, messageId: ctx.messageId, ...(ctx.botId ? { botId: ctx.botId } : {}), ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}) });
      },
    },
    {
      name: 'harness',
      description: 'Capture a task and launch its harness implementation',
      handler: async (args, ctx, opts) => {
        if (args.length === 0) return 'Usage: /harness <task...>';
        const intakeContext = {
          surface: 'telegram' as const,
          source: 'telegram' as const,
          text: ctx.text,
          attachments: opts.downloadAttachments ? await opts.downloadAttachments() : [],
          actor: {
            id: String(ctx.userId),
            display: ctx.userName ?? String(ctx.userId),
          },
          channelContext: {
            chatId: String(ctx.chatId),
            ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
          },
        };
        await handleTextChannelIntakeCommand(['capture', ...args], intakeContext);
        return handleTextChannelIntakeCommand(['implement'], intakeContext);
      },
    },
    {
      name: 'cancel',
      description: 'Cancel the in-flight turn for this chat — an ACP delegation OR a self/terminal (Bash·PtyShell) task (no-op if nothing running)',
      handler: async (_args, ctx) => {
        try {
          const hit = await cancelAcpTurn(ctx.chatId, ctx.threadId);
          return hit
            ? '✓ Cancel requested — the running task is being stopped (Bash killed · headless PTYs terminated).'
            : '_No ACP turn in this chat._';
        } catch (err: any) {
          return `cancel failed: ${err?.message ?? err}`;
        }
      },
    },
    {
      // goal control — 현재 미션 조회(삭제할 id 확인용).
      name: 'missions',
      description: '현재 활성 미션 목록(id·상태·골) — 삭제는 /mission_del',
      handler: async () => {
        const { listMissions, openAutopilotMissionsDb } = await import('./autopilot/mission-registry.js');
        const store = openAutopilotMissionsDb();
        try {
          const rows = listMissions(store, {}).filter((m) => !['done', 'cancelled', 'failed'].includes(m.status));
          if (rows.length === 0) return '_활성 미션 없음._';
          const lines = ['**활성 미션**', ''];
          for (const m of rows) {
            const short = m.id.split('_').pop() ?? m.id;
            lines.push(`• [${m.status}] ${m.goal.slice(0, 46)}`);
            lines.push(`  \`${m.id}\`  → 삭제: /mission_del ${short}`);
          }
          return lines.join('\n');
        } finally {
          store.close();
        }
      },
    },
    {
      // goal control — 미션 + 파생물(크론 autopilot_id·태스크 goalSlug) 태그 cascade 삭제.
      name: 'mission_del',
      description: '미션 + 파생 크론·태스크 일괄 삭제 — /mission_del <id 또는 끝6자리>',
      handler: async (args) => {
        const idArg = (args[0] ?? '').trim();
        if (!idArg) return '사용법: `/mission_del <미션id 또는 끝6자리 hash>` (/missions 로 id 확인)';
        const { listMissions, openAutopilotMissionsDb } = await import('./autopilot/mission-registry.js');
        const { cancelMission } = await import('./autopilot/mission-lifecycle.js');
        let fullId = idArg;
        if (!idArg.startsWith('apm_')) {
          const store = openAutopilotMissionsDb();
          try {
            const hit = listMissions(store, {}).find((m) => m.id.split('_').pop() === idArg || m.id.endsWith(`_${idArg}`));
            if (!hit) return `미션 못 찾음: \`${idArg}\` (/missions 로 확인)`;
            fullId = hit.id;
          } finally {
            store.close();
          }
        }
        // 대량 파생 크론(투자 앵커 등) 오삭제 방지 — >3 이면 confirm 요구.
        const { openSchedulesDb, listSchedules } = await import('./domains/schedule-registry.js');
        const sdb = openSchedulesDb();
        let cronCount = 0;
        try { cronCount = listSchedules(sdb).filter((r) => r.autopilot_id === fullId).length; } finally { sdb.close(); }
        const confirmed = (args[1] ?? '').trim().toLowerCase() === 'confirm';
        if (cronCount > 3 && !confirmed) {
          return `⚠️ 이 미션은 파생 크론 **${cronCount}개**를 함께 삭제합니다(대량·투자 앵커 등 주의).\n확실하면 \`/mission_del ${idArg} confirm\` 으로 다시 실행.`;
        }
        const r = await cancelMission(fullId);
        if (!r.ok) return `삭제 실패: ${r.error}`;
        const lines = ['✅ 미션 삭제(파생물 cascade)', `\`${fullId}\``, `· 파생 크론 ${r.releasedCrons} 삭제`, `· 태스크 ${r.releasedTasks} 정리`];
        if (r.releasedWorkflows) lines.push(`· workflow 정의 ${r.releasedWorkflows} 삭제(재발견 방지)`);
        return lines.join('\n');
      },
    },
    {
      name: 'taste',
      description: 'taste 제안 확인·승인·기각 (list | approve <테마> | reject <테마>)',
      handler: async (args) => {
        const { pendingProposals, recordProposalDecision } = await import('./domains/taste-propose.js');
        const sub = (args[0] ?? 'list').toLowerCase();
        if (sub === 'approve' || sub === 'reject') {
          const theme = args.slice(1).join(' ').trim();
          if (!theme) return `테마를 지정하세요: \`/taste ${sub} <테마>\``;
          // 부분일치 → 정확 테마 해소(pending 중에서).
          const pend = pendingProposals();
          const hit = pend.find((p) => p.theme === theme || p.theme.includes(theme) || p.label.includes(theme));
          const target = hit?.theme ?? theme;
          recordProposalDecision(target, sub === 'approve' ? 'approve' : 'reject');
          return sub === 'approve'
            ? `✅ 승인 라벨 기록: "${target}"\n(라벨일 뿐 미션 생성 아님 — 미션으로 만들려면 \`미션: …\` 로 직접 던지세요.)`
            : `🚫 기각 라벨 기록: "${target}" (이 테마는 재제안 안 됨)`;
        }
        // list
        const pend = pendingProposals();
        if (!pend.length) return '💡 미결 taste 제안이 없습니다.';
        const lines = pend.map((p, i) => `${i + 1}. *${p.label}* (강도 ${p.score.toFixed(2)})\n   ${p.rationale}`);
        return `💡 미결 taste 제안 ${pend.length}건 — 승인/기각: \`/taste approve <테마>\` · \`/taste reject <테마>\`\n\n${lines.join('\n\n')}`;
      },
    },
    ...botCommandsToTelegram(),
  ];
  const catalog = buildBotSlashCatalog({
    surface: 'telegram', coreCommands, maturity,
    handledCommands: handled,
  });
  const handlers = new Map(handled.map((command) => [command.name, command]));
  return catalog.commands.map((entry) => handlers.get(entry.name) ?? {
    name: entry.name,
    description: entry.description,
    handler: async () => catalog.unsupportedReply(entry.name)!,
  });
}

/** Telegram-side adapter over the messenger-agnostic ACP turn runner.
 *  Returns the text for the final placeholder edit; the outer
 *  slash dispatcher handles edit + error surfacing. */
export async function runAcpViaSlash(
  backendId: string,
  args: string[],
  ctx: TgIncoming,
  { streamer, downloadAttachments, hitlConfirmChannel, hitlQuestionChannel, userConfig }: TgCommandContext,
): Promise<string | void> {
  // Allow attachment-only turns — the user can send a photo with
  // caption "/cc" (no text after) and still expect the LLM to see
  // the image. Only bail when BOTH the arg list and the attachment
  // list would be empty.
  const slashLabel = backendId === 'claude' ? 'cc' : backendId === 'codex' ? 'cdx' : backendId === 'gemini' ? 'gem' : backendId;
  const hasAttachments = ctx.attachments.length > 0;
  if (args.length === 0 && !hasAttachments) {
    return `Usage: /${slashLabel} <prompt>`;
  }
  const promptText = args.join(' ');
  // B + interweave — carry chat context into the backend so it understands
  // "그거/아까" AND picks up work done on OTHER surfaces (self / other
  // backend) since it last ran. FRESH session ⇒ last 6 turns; CONTINUED ⇒
  // only the DELTA since this backend's last activity (updatedAt), so a
  // `/cc → self → /cc` handoff stays seamless. Session record + tool trace
  // keep the ORIGINAL promptText; only the text SENT to the backend gets it.
  const acpRec = globalAcpSessionStore().getRecord(ctx.chatId, canonicalizeBackendId(backendId), ctx.threadId);
  const preamble = acpRec
    ? buildAcpContextPreamble(ctx.chatId, ctx.threadId, ctx.botId, { sinceTs: acpRec.updatedAt })
    : buildAcpContextPreamble(ctx.chatId, ctx.threadId, ctx.botId);
  const acpPromptText = preamble + promptText;

  // The /cc turn runs in a SEPARATE backend ACP subprocess session — it
  // is NOT written to this chat's telegram session by runAcpTurn. Without
  // a breadcrumb here, elanous's brain (the NL chat path, which reads THIS
  // session's transcript) has zero record of the delegated job, so a
  // follow-up "is my CC job done?" hallucinates about unrelated state.
  // Resolve-or-create + append the user turn up front (mirrors
  // runNamedSkill) so the job is visible even if the turn throws.
  let sessionMeta = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
  if (!sessionMeta) {
    sessionMeta = createSession({
      source: 'telegram',
      sourceKind: 'telegram',
      tgChatId: ctx.chatId,
      tgThreadId: ctx.threadId,
      tgBotId: ctx.botId,
      provider: userConfig.llm.provider,
      model: userConfig.llm.model ?? '',
      title: `tg:${ctx.userName ?? ctx.userId}`,
    });
  }
  appendMessage(sessionMeta.id, {
    role: 'user',
    content: `/${slashLabel} ${promptText}`.trim(),
    ts: new Date().toISOString(),
  });

  // Immediate progress feedback — resolveSession/loadSession can take
  // 60s+ (claude-code-acp replays a large accumulated session transcript)
  // and is otherwise SILENT, so the placeholder just sits there and reads
  // as "no response". Show a "preparing" note the moment the job starts.
  streamer?.edit(`⏳ ${slashLabel.toUpperCase()} 세션 준비 중… (첫 턴은 세션 로드로 수십 초 걸릴 수 있음)`);

  const attachments = downloadAttachments ? await downloadAttachments() : [];
  // Slash = targeted → tight focus budget (config `acp.slashMaxTurns`,
  // default 8). NL delegation goes through the brain, not here, so it
  // stays generous.
  const focusTurns = userConfig.acp.slashMaxTurns ?? SLASH_FOCUS_TURNS_DEFAULT;
  const { text, stopReason, model } = await runAcpTurn({
    backendId,
    promptText: acpPromptText,
    chatId: ctx.chatId,
    threadId: ctx.threadId,
    streamer,
    attachments,
    focusTurns,
    // Route the delegated agent's HITL prompts back to THIS chat.
    ...(hitlConfirmChannel ? { hitlConfirmChannels: [hitlConfirmChannel] } : {}),
    ...(hitlQuestionChannel ? { hitlQuestionChannels: [hitlQuestionChannel] } : {}),
  });
  const base = stopReason === 'cancelled'
    ? text + '\n\n_⏹ cancelled_'
    : stopReason !== 'end_turn'
      ? text + `\n\n_(stop: ${stopReason})_`
      : text;
  // Execution footer — ACP delegate turn. Show the backend + its real model
  // when the backend reports one (codex); claude-code-acp doesn't, so it stays
  // backend-only rather than guessing.
  const reply = `${base}\n\n${executionFooter({ delegatedBackend: backendId, model })}`;

  // P2 (ACP 기억 패리티) — structured tool-trace row so a FOLLOW-UP self turn's
  // buildRecentToolObservations (which filters role:'tool' after the last user)
  // can surface what the ACP delegate did, not just re-parse the flat reply.
  // Ordered user → tool → assistant, mirroring the self path's per-tool rows.
  try {
    appendMessage(sessionMeta.id, buildToolTraceMessage(`acp:${backendId}`, promptText, text));
  } catch { /* telemetry persistence must not break the turn */ }

  // Persist the result + a self-awareness breadcrumb so the brain can
  // recall "what did /cc do" on a later NL turn (both the transcript and
  // the autonomy recall log feed self_recall).
  appendMessage(sessionMeta.id, {
    role: 'assistant',
    content: reply,
    ts: new Date().toISOString(),
  });
  recordAutonomousActionSafe({
    loop: 'delegate',
    action: `/${slashLabel} 위임: ${promptText.slice(0, 100)}`,
    rationale: '텔레그램 슬래시 코딩 위임(사용자가 backend 지목)',
    outcome: `${stopReason} · ${text.length}자 산출`,
    refs: { backend: backendId, chatId: String(ctx.chatId), sessionId: sessionMeta.id },
  });
  // P2 — cross-surface memory parity with the self path: record the delegate
  // turn into surface_events so memory_recall surfaces "/cc did X" later
  // (self turns go through recordInboundTurn; ACP turns previously did not).
  try {
    recordInboundTurn({
      surface: 'telegram',
      userText: `/${slashLabel} ${promptText}`.trim(),
      responseText: text,
      sessionId: sessionMeta.id,
      ...(ctx.threadId !== undefined ? { threadId: String(ctx.threadId) } : {}),
    });
  } catch { /* fail-soft */ }

  // P1 — enter active delegation so plain NL follow-ups continue THIS ACP
  // session (session/load reuse) instead of hitting the brain. Cancelled
  // turns don't arm it. Exits: /brain·/new·/cc_clear·different backend·TTL.
  if (stopReason !== 'cancelled') {
    setActiveDelegation(delegationChatKey(ctx.botId, ctx.chatId, ctx.threadId), backendId);
  }

  return reply;
}

/** Shared handler for `/skill <name> <input>` and `/digest <input>`
 *  (which injects `omni-digest` as the name). Resolves the skill via
 *  parseSkillMd, invokes executeSkill with a streaming onChunk that
 *  forwards to the telegram streamer, and returns the full response
 *  for the final placeholder edit. */
async function runNamedSkill(
  args: string[],
  ctx: TgIncoming,
  { streamer, userConfig }: TgCommandContext,
): Promise<string | void> {
  if (args.length === 0) {
    return 'Usage: `/skill <name> [input]` — list names via `/skills`.';
  }
  const [name, ...rest] = args;
  const input = rest.join(' ');
  const manifest = parseSkillMd(name!);
  if (!manifest) {
    return `Unknown skill: \`${name}\`. List with /skills.`;
  }

  // Resolve (or create) the telegram session for this chat so we can
  // both READ prior turns (for executeSkill's priorConversation) and
  // WRITE the user turn + skill response back. Without the write,
  // sequential /skill calls would each see only pre-slash history —
  // `/skill A` → `/skill B` wouldn't let B see A's output.
  let sessionMeta = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
  if (!sessionMeta) {
    sessionMeta = createSession({
      source: 'telegram',
      sourceKind: 'telegram',
      tgChatId: ctx.chatId,
      tgThreadId: ctx.threadId,
      tgBotId: ctx.botId,
      provider: userConfig.llm.provider,
      model: userConfig.llm.model ?? '',
      title: `tg:${ctx.userName ?? ctx.userId}`,
    });
  }

  // Record the user's slash-command turn BEFORE running the skill so
  // if the skill throws mid-stream we still have a breadcrumb.
  const userTurn = `/skill ${name} ${input}`.trim();
  appendMessage(sessionMeta.id, { role: 'user', content: userTurn, ts: new Date().toISOString() });

  const result = await executeSkill(
    manifest,
    input,
    (_delta, full) => { streamer?.edit(full); },
    {
      priorConversation: buildTelegramSkillPriorConversation(ctx.chatId, ctx.threadId, ctx.botId),
    },
  );

  // Persist the assistant turn so the NEXT /skill or regular chat
  // message sees this skill's output in priorConversation.
  appendMessage(sessionMeta.id, {
    role: 'assistant',
    content: result.fullResponse,
    ts: new Date().toISOString(),
  });

  return result.fullResponse;
}

/** Serialize the command set for Telegram's /setMyCommands API. Each
 *  entry must have `command` + `description` keys; we pass them as-is
 *  for the private-chat scope (the default scope). */
export function toTelegramBotCommands(
  commands: TgSlashCommand[],
): { command: string; description: string }[] {
  return commands.map(c => ({
    command: c.name,
    description: c.description.length > 256
      ? c.description.slice(0, 253) + '…'
      : c.description,
  }));
}
