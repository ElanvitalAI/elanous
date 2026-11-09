// PR-S1V.11 (sprint 22 Phase 6 · 2026-04-29) — Discord voice
// channel slash dispatcher.
//
// Parses `/voice-join` / `/voice-leave` / `/voice-status` from a
// Discord message body and routes through the adapter. The dispatcher
// is decoupled from `src/discord.ts` (the bot's gateway client)
// because the bot's onMessage callback already does the per-message
// routing — we just plug in another handler.
//
//   const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
//   const reply = await dispatcher.handle({
//     body: '/voice-join 1234567890',
//     guildId: '...', userId: '...',
//   });
//   if (reply) await sendReplyToDiscord(reply);
//
// The handler returns a reply string (sent back to the user) or
// `null` when the message wasn't a voice command (caller falls
// through to the normal LLM path).
//
// Reference: ROADMAP §7.1.

import {
  isDiscordVoiceChannelEnabled,
  resolveDiscordVoiceChannelListenFilter,
  type DiscordVoiceChannelAdapter,
  type DiscordVoiceChannelSession,
  type DiscordVoiceJoinOpts,
} from './discord-voice-channel-adapter.js';
import type { VoiceDiscordChannelListenFilter } from '../../user-config/types.js';

export interface DiscordVoiceChannelDispatcherDeps {
  adapter: DiscordVoiceChannelAdapter;
  defaultListenFilter?: VoiceDiscordChannelListenFilter;
  /** Optional hook fired right after a successful join. Wire this to
   *  elanous's voice-chat-mode controller so the audio session feeds
   *  into the harness STT/TTS round-trip. */
  onSessionStart?: (session: DiscordVoiceChannelSession, opts: DiscordVoiceJoinOpts) => void;
  /** Optional hook on session leave (or error teardown). */
  onSessionEnd?: () => void;
}

export interface DiscordVoiceCommandContext {
  /** Discord text channel where the command was issued. Used as the
   *  default transcript mirror target while the voice session is
   *  active. */
  channelId?: string;
  /** Raw message body (e.g. `'/voice-join 1234567890 caller'`). */
  body: string;
  /** Guild id where the command was issued. Required for join. */
  guildId?: string;
  /** Optional default voice channel id — when /voice-join is called
   *  without an explicit id, fall back to this. */
  defaultChannelId?: string;
  /** User id who issued the command — used as caller-only filter id
   *  when the command requests `caller` mode. */
  userId?: string;
}

export interface DiscordVoiceChannelDispatcher {
  /** Returns a reply string when the message was a recognized voice
   *  command, or `null` to indicate "not a voice command — fall
   *  through to the normal handler". */
  handle(ctx: DiscordVoiceCommandContext): Promise<string | null>;
  /** Current session (if any) — exposed for status / external wires. */
  getActiveSession(): DiscordVoiceChannelSession | null;
}

const VOICE_COMMAND_PREFIXES = [
  '/voice-join',
  '/voice-leave',
  '/voice-status',
] as const;

export function createDiscordVoiceChannelDispatcher(
  deps: DiscordVoiceChannelDispatcherDeps,
): DiscordVoiceChannelDispatcher {
  let activeSession: DiscordVoiceChannelSession | null = null;
  let activeOpts: DiscordVoiceJoinOpts | null = null;

  async function handle(ctx: DiscordVoiceCommandContext): Promise<string | null> {
    const body = ctx.body.trim();
    const matchedPrefix = VOICE_COMMAND_PREFIXES.find((p) => body === p || body.startsWith(`${p} `));
    if (!matchedPrefix) return null;
    if (!isDiscordVoiceChannelEnabled()) {
      return 'Discord voice channel is disabled. Enable `voice.discord.voiceChannel.enabled` (env fallback still supported).';
    }
    if (!deps.adapter.available) {
      return `Discord voice channel unavailable: ${deps.adapter.unavailableReason ?? 'unknown reason'}`;
    }

    const args = body.slice(matchedPrefix.length).trim().split(/\s+/).filter(Boolean);

    switch (matchedPrefix) {
      case '/voice-join':
        return await handleJoin(args, ctx);
      case '/voice-leave':
        return await handleLeave();
      case '/voice-status':
        return handleStatus();
    }
  }

  async function handleJoin(
    args: readonly string[],
    ctx: DiscordVoiceCommandContext,
  ): Promise<string> {
    if (activeSession) {
      return 'Already joined a voice channel — use `/voice-leave` first.';
    }
    const guildId = ctx.guildId;
    if (!guildId) {
      return 'Missing guildId — `/voice-join` only works inside a server.';
    }
    const channelId = args[0] ?? ctx.defaultChannelId;
    if (!channelId) {
      return 'Missing channel id — try `/voice-join <channel-id>`.';
    }
    // Optional second arg: `caller` (filter to inviter only) | `all`.
    // When omitted, user-config-first default resolves to `caller`
    // unless the operator explicitly switched the surface to `all`.
    const requestedFilter = args[1]?.toLowerCase();
    const defaultFilter = deps.defaultListenFilter ?? resolveDiscordVoiceChannelListenFilter();
    const filter = requestedFilter === 'caller' || requestedFilter === 'all'
      ? requestedFilter
      : defaultFilter;
    const opts: DiscordVoiceJoinOpts = {
      guildId,
      channelId,
      ...(ctx.channelId ? { textChannelId: ctx.channelId } : {}),
      ...(ctx.userId ? { requesterUserId: ctx.userId } : {}),
      ...(filter === 'caller' && ctx.userId ? { listenFilterUserId: ctx.userId } : {}),
    };
    try {
      const session = await deps.adapter.joinChannel(opts);
      activeSession = session;
      activeOpts = opts;
      session.onStateChange((state) => {
        if (state === 'disconnected') {
          activeSession = null;
          activeOpts = null;
          deps.onSessionEnd?.();
        }
      });
      deps.onSessionStart?.(session, opts);
      const filterMsg = opts.listenFilterUserId ? ' (caller-only filter)' : ' (all speakers)';
      return `Joined voice channel ${channelId}${filterMsg}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to join voice channel: ${msg}`;
    }
  }

  async function handleLeave(): Promise<string> {
    if (!activeSession) {
      return 'No active voice channel — nothing to leave.';
    }
    try {
      await activeSession.leave();
    } finally {
      activeSession = null;
      activeOpts = null;
      deps.onSessionEnd?.();
    }
    return 'Left voice channel.';
  }

  function handleStatus(): string {
    if (!activeSession) return 'voice-channel: not connected';
    const state = activeSession.getState();
    const filter = activeOpts?.listenFilterUserId ? ` · filter=user:${activeOpts.listenFilterUserId}` : '';
    return `voice-channel: ${state} · channel=${activeOpts?.channelId ?? '(unknown)'}${filter}`;
  }

  return {
    handle,
    getActiveSession: () => activeSession,
  };
}
