// ── Discord bot — Gateway WebSocket + REST client ────────────────
//
// Dependency-free mirror of the Telegram bot (fetch + ws built into
// Bun/Node 22+). Handles:
//   - Gateway v10 HELLO / IDENTIFY / READY / MESSAGE_CREATE
//   - Heartbeat loop with ACK bookkeeping
//   - REST sendMessage / editMessage / getMe
//   - DM-only message routing with allowlist enforcement
//   - onMessage(ctx, streamer) signature mirroring TelegramBot so the
//     shared slash-command dispatcher routes the same way
//
// NOT implemented in this first cut (v1 scope):
//   - Resume (we reconnect fresh on disconnect — loses message ordering
//     guarantees around a disconnect, which matters for a high-volume
//     bot but is acceptable for a single-operator assistant)
//   - Sharding (one connection is fine for a single operator)
//   - Guild channel routing (DM-only for v1 — guild channels add
//     permission matrix work we don't need yet)
//   - Attachments (P3 wiring — hand off URL → content block there)
//   - Slash-command interaction route (/commands API) — we use the
//     "Bot" gateway path, same as zed + our Telegram impl

import { markdownToTelegramHtml as _unusedMarkdownFn } from './telegram-format.js'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { debug } from './debug/log.js';
import { getUserConfig } from './user-config.js';
import { deliverSeatAnswers } from './seat-dispatch/seat-ask.js';
import { handleDiscordSeatWork, type DiscordSeatWorkDeps } from './intake-plane/discord-seat-work.js';
import { parseSeatAddress } from './seat-address/seat-address.js';

// Telegram's HTML markdown isn't directly useful for Discord (Discord
// uses CommonMark + its own subset). Import kept as a reminder that
// P5b will hook in src/discord-format.ts for Discord-specific
// markdown rendering. For P5a, we send LLM replies as plain text +
// rely on Discord's default parser, which handles `**bold**` and
// backtick code blocks natively — no conversion needed.
void _unusedMarkdownFn;

// ── Gateway opcodes ──────────────────────────────────────────────
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;       // defined for future; not used in v1
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// ── Intents (docs: https://discord.com/developers/docs/topics/gateway#gateway-intents) ──
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_GUILD_MESSAGE_REACTIONS = 1 << 10;     // Sprint 21 wiring (M1.4)
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_DIRECT_MESSAGE_REACTIONS = 1 << 13;    // Sprint 21 wiring (M1.4)
const INTENT_MESSAGE_CONTENT = 1 << 15;             // privileged — must enable in Developer Portal
const INTENT_GUILD_VOICE_STATES = 1 << 7;
// Reactions intents are non-privileged — included by default so
// ApprovalGate (M1.4) routing works without per-bot intent
// configuration. Voice intent is added at runtime when a voice tap
// is configured. INTERACTION_CREATE is delivered automatically (no
// intent flag) once the application has registered slash commands.
const BOT_INTENTS_BASE =
  INTENT_DIRECT_MESSAGES
  | INTENT_DIRECT_MESSAGE_REACTIONS
  | INTENT_MESSAGE_CONTENT
  | INTENT_GUILDS
  | INTENT_GUILD_MESSAGES
  | INTENT_GUILD_MESSAGE_REACTIONS;
const BOT_INTENTS_WITH_VOICE = BOT_INTENTS_BASE | INTENT_GUILD_VOICE_STATES;

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const REST_BASE = 'https://discord.com/api/v10';
const DEFAULT_MAX_CHARS = 2000;  // Discord hard cap per message

// ── Public types ─────────────────────────────────────────────────

/** Discord attachment shape from the Gateway payload. Discord
 *  delivers attachments as URL references hosted on their CDN;
 *  consumers download via fetch(url) rather than a two-step getFile
 *  handshake (unlike Telegram). */
export interface DcAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  contentType?: string;
  width?: number;
  height?: number;
  /** Voice message duration in seconds (Discord voice notes). */
  durationSecs?: number;
}

export interface DcIncoming {
  channelId: string;
  userId: string;
  userName?: string;
  text: string;
  messageId: string;
  /** Whether this is a DM channel (guild_id absent). v1 bot only
   *  responds when this is true. */
  isDm: boolean;
  /** Parsed attachment list from the Gateway payload. */
  attachments: DcAttachment[];
  /** Raw gateway message for future extensions (embeds, etc.). */
  raw: Record<string, unknown>;
}

export interface DcMessageStreamer {
  edit(partialText: string): void;
}

export type DcMessageHandler = (
  ctx: DcIncoming,
  streamer?: DcMessageStreamer,
) => Promise<string | void>;

/** Voice gateway dispatch tap — receives VOICE_STATE_UPDATE /
 *  VOICE_SERVER_UPDATE / READY events from the main gateway, allowing
 *  an external `@discordjs/voice` adapter to be wired without duplicating
 *  the gateway connection. The bot stays dependency-free; the voice
 *  module composes against this tap. */
export interface DiscordVoiceDispatchTap {
  onReady?(sessionId: string, userId: string): void;
  onVoiceStateUpdate?(d: Record<string, unknown>): void;
  onVoiceServerUpdate?(d: Record<string, unknown>): void;
}

export interface DiscordBotOpts {
  /** Bot token (with `Bot ` prefix stripped — we add it). */
  token: string;
  /** Allowlisted user IDs (snowflake strings). Empty = refuse all. */
  allowedUsers: string[];
  /** Message handler. Return a string to reply, or void to stay silent. */
  onMessage: DcMessageHandler;
  /** PLAN-multi-surface-pty-shell M4a-0 — guild TEXT channels where
   *  messages flow the full chat path (onMessage + trigger tap) despite
   *  the DM-only v1 gate. The `discord-test` runner scopes itself to
   *  `discord.testChannel.channelId` through this; production omits it
   *  (unchanged — guild traffic stays gated to /voice-* only). */
  guildTextChannels?: string[];
  /** Chunk size for outbound messages. Discord caps at 2000 chars. */
  maxMessageChars?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Dependency injection for tests — override fetch + WebSocket. */
  fetchImpl?: typeof fetch;
  wsImpl?: typeof WebSocket;
  /** Voice channel adapter — receives raw VOICE_STATE_UPDATE /
   *  VOICE_SERVER_UPDATE / READY dispatches. The voice subsystem
   *  registers a tap during boot when ELANOUS_DISCORD_VOICE_CHANNEL=1. */
  voiceTap?: DiscordVoiceDispatchTap;
  /** Override gateway intents — tests use this to verify GUILD_VOICE_STATES
   *  is included when a voice tap is configured. */
  intents?: number;
  /** Sprint 21 wiring (M3) · INTERACTION_CREATE dispatch. Receives
   *  the raw payload — caller normalizes via slash-router's
   *  `normalizeInteractionPayload` then dispatches via SlashRouter. */
  onInteraction?: (raw: Record<string, unknown>) => void | Promise<void>;
  /** Sprint 21 wiring (M1.4) · MESSAGE_REACTION_ADD/REMOVE dispatch.
   *  `removed` distinguishes ADD vs REMOVE. Caller routes to
   *  `ApprovalGate.handleReaction`. */
  onReaction?: (event: DcReactionEvent) => void | Promise<void>;
  /** Surface-unification v2 (2026-05-11 · FU-1) — workflow-runtime
   *  Discord trigger tap. Receives a normalized event for EVERY DM
   *  message + mention (after allowlist) so the workflow daemon can
   *  match discordTrigger nodes and dispatch independently of the
   *  primary `onMessage` LLM chat path. Errors are swallowed by the
   *  caller — this is a best-effort fan-out. */
  onTriggerTap?: (event: DcTriggerEvent) => void | Promise<void>;
  /** Override the intake door's dependencies for isolated Discord seat-work tests. */
  seatWorkDeps?: DiscordSeatWorkDeps;
}

/** Surface-unification v2 — minimal trigger-side event shape. Maps
 *  one-to-one onto `triggers/discord-source.ts` DiscordEvent so the
 *  NEXUS wire can pass it through unchanged. */
export interface DcTriggerEvent {
  kind: 'message' | 'mention' | 'reaction';
  channel: string;
  user: string;
  /** Message body (kind=message|mention) or emoji name (kind=reaction). */
  body: string;
  messageId: string;
  isDm: boolean;
}

/** Normalized inbound reaction event — gateway MESSAGE_REACTION_ADD
 *  or MESSAGE_REACTION_REMOVE. Field names match what
 *  `src/discord/reaction-handler.ts` `ReactionEvent` expects. */
export interface DcReactionEvent {
  channelId: string;
  messageId: string;
  userId: string;
  emoji: { name: string; id?: string; animated?: boolean };
  removed?: boolean;
  guildId?: string;
  ts?: number;
}

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

// ── Bot class ────────────────────────────────────────────────────

export class DiscordBot {
  private readonly token: string;
  private readonly allowedUsers: Set<string>;
  private readonly guildTextChannels: Set<string>;
  /** The bot's own user id (from READY) — EV12c lets an allowlisted @mention open any guild channel. */
  private selfUserId: string | undefined;
  private readonly onMessage: DcMessageHandler;
  private readonly maxChars: number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly wsImpl: typeof WebSocket;
  private readonly voiceTap: DiscordVoiceDispatchTap | null;
  private readonly intents: number;
  /** Sprint 21 wiring (M3 + M1.4) — optional callbacks. */
  private readonly onInteraction: ((raw: Record<string, unknown>) => void | Promise<void>) | null;
  private readonly onReaction: ((event: DcReactionEvent) => void | Promise<void>) | null;
  /** Surface-unification v2 (FU-1) — workflow-runtime tap. */
  private readonly onTriggerTap: ((event: DcTriggerEvent) => void | Promise<void>) | null;
  private readonly seatWorkDeps: DiscordSeatWorkDeps;
  private ws: WebSocket | null = null;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seatAskTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAck = true;
  private lastSeq: number | null = null;

  constructor(opts: DiscordBotOpts) {
    if (!opts.token) throw new Error('DiscordBot: token required');
    this.token = opts.token;
    this.allowedUsers = new Set(opts.allowedUsers);
    this.guildTextChannels = new Set(opts.guildTextChannels ?? []);
    this.onMessage = opts.onMessage;
    this.maxChars = opts.maxMessageChars ?? DEFAULT_MAX_CHARS;
    // LF2(2026-07-13) — 기본 no-op → debug.log 브릿지(telegram.ts 동형).
    this.log = opts.log ?? ((m: string) => debug.log('discord.core', m));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsImpl = opts.wsImpl ?? WebSocket;
    this.voiceTap = opts.voiceTap ?? null;
    this.intents = opts.intents
      ?? (opts.voiceTap ? BOT_INTENTS_WITH_VOICE : BOT_INTENTS_BASE);
    this.onInteraction = opts.onInteraction ?? null;
    this.onReaction = opts.onReaction ?? null;
    this.onTriggerTap = opts.onTriggerTap ?? null;
    this.seatWorkDeps = { ...opts.seatWorkDeps, askDeps: {
      ...opts.seatWorkDeps?.askDeps,
      channel: 'discord',
      send: opts.seatWorkDeps?.askDeps?.send ?? (async (origin, text) => {
        if (origin.channel !== 'discord') throw new Error('seat ask belongs to another surface');
        const posted = await this.sendMessage(origin.threadId ?? origin.channelId, text);
        if (!posted) throw new Error('Discord seat ask reply was not posted');
      }),
    } };
  }

  /** Send a raw payload on the gateway WebSocket. Voice adapter uses
   *  this to issue VOICE_STATE_UPDATE (op 4) when joining/leaving a
   *  voice channel. Returns false when the socket is not open. */
  sendGatewayPayload(payload: { op: number; d?: unknown }): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(payload)); return true; }
    catch (err: any) {
      this.log(`gateway voice payload failed: ${err?.message ?? err}`);
      return false;
    }
  }

  // ── REST API ────────────────────────────────────────────────

  private async restCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${REST_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`discord ${method} ${path} failed: ${res.status} ${text}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    // Some endpoints return 204 No Content.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** `/users/@me` — verifies the token + returns the bot's identity.
   *  Use from the pair wizard and `elanous discord status`. */
  async getMe(): Promise<{ id: string; username: string; discriminator?: string }> {
    return this.restCall('GET', '/users/@me');
  }

  /** Send a new message to a channel. Splits oversized text into
   *  multiple messages (2000-char cap). Returns the LAST posted
   *  message's id so callers can edit-in-place for streaming. */
  async sendMessage(
    channelId: string,
    text: string,
    opts: { suppressEmbeds?: boolean } = {},
  ): Promise<{ id: string } | null> {
    if (!text) return null;
    // §C5-enh — SUPPRESS_EMBEDS(1<<2=4) 로 링크 unfurl 소음 억제(스트리밍 프리뷰). 편집은
    // flags 를 유지하므로 create 에만 설정하면 이후 edit 도 suppressed(§6-9).
    const flags = opts.suppressEmbeds ? 4 : undefined;
    const chunks = splitForDiscord(text, this.maxChars);
    let lastId: string | null = null;
    for (const chunk of chunks) {
      const r = await this.restCall<{ id: string }>(
        'POST', `/channels/${channelId}/messages`,
        { content: chunk, ...(flags != null ? { flags } : {}) },
      );
      lastId = r.id;
    }
    return lastId ? { id: lastId } : null;
  }

  /** Upload a binary attachment (audio · image · text spill) to a
   *  channel via the multipart message endpoint. The generic primitive
   *  behind sendAudioAttachment and fileSinkForChannel
   *  (PLAN-multi-surface-pty-shell M2). */
  async sendFileAttachment(
    channelId: string,
    data: Buffer,
    opts: {
      filename?: string;
      contentType?: string;
      content?: string;
    } = {},
  ): Promise<{ id: string } | null> {
    if (data.byteLength === 0) return null;
    const fd = new FormData();
    if (opts.content) {
      fd.set('payload_json', JSON.stringify({ content: opts.content }));
    }
    const blobBytes = new ArrayBuffer(data.byteLength);
    new Uint8Array(blobBytes).set(data);
    fd.set(
      'files[0]',
      new Blob([blobBytes], { type: opts.contentType ?? 'application/octet-stream' }),
      opts.filename ?? 'attachment.bin',
    );
    const res = await this.fetchImpl(`${REST_BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.token}`,
      },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`discord POST /channels/${channelId}/messages (multipart) failed: ${res.status} ${text}`);
    }
    const payload = await res.json().catch(() => null) as { id?: string } | null;
    return payload?.id ? { id: payload.id } : null;
  }

  /** Upload an audio attachment to a channel. Discord text-channel
   *  voice replies use this to post a `.ogg` attachment while keeping
   *  transcript text as normal messages. */
  async sendAudioAttachment(
    channelId: string,
    audio: Buffer,
    opts: {
      filename?: string;
      contentType?: string;
      content?: string;
    } = {},
  ): Promise<{ id: string } | null> {
    return this.sendFileAttachment(channelId, audio, {
      filename: opts.filename ?? 'voice.ogg',
      contentType: opts.contentType ?? 'audio/ogg',
      ...(opts.content ? { content: opts.content } : {}),
    });
  }

  /** Channel-agnostic FileSink for a channel — the Discord flavor of
   *  telegram's `fileSinkForChat` (PLAN-multi-surface-pty-shell M2).
   *  `sendFile` spills a large tool body as a text/diff attachment;
   *  `sendImage` posts a PNG (e.g. a PtyShellScreenshot frame) inline.
   *  Both fire-and-forget: errors are logged, never thrown — a failed
   *  spill must not wedge a running turn. */
  fileSinkForChannel(channelId: string): import('./channel/file-sink.js').FileSink {
    return {
      sendFile: (body: string, o: { ext: string; caption?: string; name?: string }): void => {
        const filename = o.name ?? `tool-output.${o.ext === 'diff' ? 'diff' : 'txt'}`;
        void this.sendFileAttachment(channelId, Buffer.from(body, 'utf-8'), {
          filename,
          contentType: 'text/plain',
          ...(o.caption ? { content: o.caption } : {}),
        }).catch((err: unknown) => {
          this.log(`fileSink spill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      sendImage: (png: Buffer, o?: { caption?: string }): void => {
        void this.sendFileAttachment(channelId, png, {
          filename: 'screen.png',
          contentType: 'image/png',
          ...(o?.caption ? { content: o.caption } : {}),
        }).catch((err: unknown) => {
          this.log(`fileSink image spill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
    };
  }

  /** Download an attachment from Discord's CDN. Returns a local
   *  temp-file path the ACP content-blocks layer can ingest. Discord
   *  attachment URLs are public with an expiring token baked in —
   *  plain fetch() works, no Authorization header needed. */
  async downloadAttachment(attachment: DcAttachment, destDir?: string): Promise<{
    localPath: string;
    fileName: string;
  }> {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const dir = destDir ?? join(tmpdir(), 'elanous-discord-downloads');
    mkdirSync(dir, { recursive: true });
    const res = await this.fetchImpl(attachment.url);
    if (!res.ok) {
      throw new Error(`attachment fetch failed: ${res.status} ${attachment.url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const safeName = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const localPath = join(dir, `${randomUUID()}-${safeName}`);
    writeFileSync(localPath, buf);
    return { localPath, fileName: attachment.filename };
  }

  /** Sprint 21 wiring (M3) · Respond to an INTERACTION_CREATE.
   *  Discord requires a callback POST within 3s — caller normalizes
   *  the interaction (slash-router.normalizeInteractionPayload),
   *  builds the response body (slash-router.dispatchToBody), and
   *  passes (id, token, body) here. The webhook-style callback
   *  endpoint takes the token in the URL — no Bot Authorization header. */
  async respondToInteraction(
    interactionId: string,
    interactionToken: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const url = `${REST_BASE}/interactions/${interactionId}/${interactionToken}/callback`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`discord respondToInteraction ${interactionId} failed: ${res.status} ${text}`);
    }
  }

  /** Edit an existing message. Discord silently caps the payload at
   *  2000 chars and 429s on excessive edits — we truncate up front
   *  with an ellipsis to keep the edit-in-place streamer predictable. */
  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (!text) return;
    const content = text.length > this.maxChars
      ? text.slice(0, this.maxChars - 4) + ' …'
      : text;
    await this.restCall(
      'PATCH', `/channels/${channelId}/messages/${messageId}`, { content },
    );
  }

  /** §C5-enh reactions-as-status — 사용자 메시지에 이모지 리액션(👀 큐 → ✅/❌). 저비용 상태채널
   *  (편집 rate 안 소모). unicode emoji 는 URL 인코딩. fail-soft(리액션 실패가 배달 안 막음). */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.restCall(
        'PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      );
    } catch (err: any) {
      this.log(`addReaction failed: ${err?.message ?? String(err)}`);
    }
  }

  /** Post a fresh message with attached components (action rows /
   *  buttons / selects). Mirrors `sendMessage` but accepts the
   *  `components` field, used by HITL Discord channel (β-1c) to
   *  render Approve/Reject buttons. Discord caps components at 5
   *  action rows × 5 buttons each — caller's responsibility. Text
   *  is allowed to be empty when components carry the meaning
   *  (e.g. button-only menu); we forbid the fully-empty payload. */
  async sendMessageWithComponents(
    channelId: string,
    text: string,
    components: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{ id: string } | null> {
    if (!text && components.length === 0) return null;
    const body: Record<string, unknown> = {};
    if (text) body.content = text.length > this.maxChars ? text.slice(0, this.maxChars) : text;
    if (components.length > 0) body.components = components;
    const r = await this.restCall<{ id: string }>(
      'POST', `/channels/${channelId}/messages`, body,
    );
    return r?.id ? { id: r.id } : null;
  }

  /** DEC-TG — edit a message's text AND components (an empty list removes the buttons). */
  async editMessageWithComponents(
    channelId: string,
    messageId: string,
    text: string,
    components: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    const content = text.length > this.maxChars ? text.slice(0, this.maxChars - 4) + ' …' : text;
    await this.restCall('PATCH', `/channels/${channelId}/messages/${messageId}`, { content, components });
  }

  /** DEC-TG — the DM channel id with one user (Discord returns the existing one when it already exists). */
  async openDmChannel(userId: string): Promise<string | null> {
    const r = await this.restCall<{ id?: string }>('POST', '/users/@me/channels', { recipient_id: userId });
    return r?.id ?? null;
  }

  // ── Gateway: connect + run forever ──────────────────────────

  /** Connect to the Gateway, identify, and process events until
   *  stop() is called. Reconnects on transient failures with a 5s
   *  backoff (no exponential for v1 — Discord prefers fast reconnect). */
  async start(): Promise<void> {
    this.running = true;
    this.log(`discord bot starting (allowlist size ${this.allowedUsers.size})`);
    this.seatAskTimer = setInterval(() => {
      void deliverSeatAnswers(this.seatWorkDeps.askDeps!).catch((error) => this.log(`seat ask delivery failed: ${String(error)}`));
    }, 10_000);
    while (this.running) {
      try {
        await deliverSeatAnswers(this.seatWorkDeps.askDeps!);
        await this.runConnection();
      } catch (err: any) {
        this.log(`gateway error: ${err?.message ?? String(err)}`);
      }
      if (!this.running) break;
      this.log('gateway disconnected — reconnecting in 5s');
      await sleep(5000);
    }
    this.log('discord bot stopped');
  }

  stop(): void {
    this.running = false;
    if (this.seatAskTimer) clearInterval(this.seatAskTimer);
    this.seatAskTimer = null;
    if (this.ws) {
      try { this.ws.close(1000, 'client stop'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.clearHeartbeat();
  }

  private async runConnection(): Promise<void> {
    const ws = new this.wsImpl(GATEWAY_URL);
    this.ws = ws;
    this.lastHeartbeatAck = true;

    // Promise resolves when the connection closes. Gateway activity
    // (heartbeat, message dispatch, reconnect) all happens via
    // event handlers attached below; we just await the close.
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => this.log('gateway connected');
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as GatewayPayload;
          this.handleGatewayMessage(ws, msg).catch(err =>
            this.log(`handler error: ${err?.message ?? err}`));
        } catch (err: any) {
          this.log(`non-json gateway frame: ${err?.message ?? err}`);
        }
      };
      ws.onerror = () => { /* onclose fires next; use that for the real resolve */ };
      ws.onclose = (event) => {
        this.clearHeartbeat();
        this.ws = null;
        if (event.code === 4004) {
          // Authentication failed — don't reconnect, propagate.
          this.running = false;
          reject(new Error('discord: authentication failed (4004 — bad token?)'));
          return;
        }
        if (event.code === 4014) {
          this.running = false;
          reject(new Error('discord: disallowed intent(s) (4014 — enable MESSAGE_CONTENT in Developer Portal)'));
          return;
        }
        this.log(`gateway closed (code=${event.code}${event.reason ? ` ${event.reason}` : ''})`);
        resolve();
      };
    });
  }

  private async handleGatewayMessage(ws: WebSocket, msg: GatewayPayload): Promise<void> {
    if (typeof msg.s === 'number') this.lastSeq = msg.s;
    switch (msg.op) {
      case OP_HELLO: {
        const d = msg.d as { heartbeat_interval: number };
        this.startHeartbeat(ws, d.heartbeat_interval);
        // Send IDENTIFY immediately — Discord gives us ~45s before
        // force-disconnect, well more than needed.
        this.sendGateway(ws, {
          op: OP_IDENTIFY,
          d: {
            token: this.token,
            intents: this.intents,
            properties: {
              os: process.platform,
              browser: 'monad-agent',
              device: 'monad-agent',
            },
          },
        });
        break;
      }
      case OP_HEARTBEAT_ACK: {
        this.lastHeartbeatAck = true;
        break;
      }
      case OP_HEARTBEAT: {
        // Discord requested an immediate heartbeat.
        this.sendGateway(ws, { op: OP_HEARTBEAT, d: this.lastSeq });
        break;
      }
      case OP_RECONNECT:
      case OP_INVALID_SESSION: {
        this.log(`gateway asked us to reconnect (op ${msg.op})`);
        try { ws.close(4000, 'reconnect'); } catch { /* ignore */ }
        break;
      }
      case OP_DISPATCH: {
        if (msg.t === 'READY') {
          const d = msg.d as {
            user?: { username?: string; id?: string };
            session_id?: string;
          };
          this.log(`READY — logged in as @${d.user?.username ?? '?'} (${d.user?.id ?? '?'})`);
          if (d.user?.id) this.selfUserId = d.user.id;
          if (this.voiceTap?.onReady && d.session_id && d.user?.id) {
            try { this.voiceTap.onReady(d.session_id, d.user.id); }
            catch (err: any) { this.log(`voice tap onReady failed: ${err?.message ?? err}`); }
          }
        } else if (msg.t === 'MESSAGE_CREATE') {
          await this.handleMessageCreate(msg.d as Record<string, unknown>);
        } else if (msg.t === 'INTERACTION_CREATE') {
          if (this.onInteraction) {
            try { await this.onInteraction(msg.d as Record<string, unknown>); }
            catch (err: any) { this.log(`onInteraction failed: ${err?.message ?? err}`); }
          }
        } else if (msg.t === 'MESSAGE_REACTION_ADD' || msg.t === 'MESSAGE_REACTION_REMOVE') {
          if (this.onReaction) {
            const ev = normalizeGatewayReaction(msg.d as Record<string, unknown>, msg.t === 'MESSAGE_REACTION_REMOVE');
            if (ev) {
              try { await this.onReaction(ev); }
              catch (err: any) { this.log(`onReaction failed: ${err?.message ?? err}`); }
            }
          }
        } else if (msg.t === 'VOICE_STATE_UPDATE') {
          if (this.voiceTap?.onVoiceStateUpdate) {
            try { this.voiceTap.onVoiceStateUpdate(msg.d as Record<string, unknown>); }
            catch (err: any) { this.log(`voice tap onVoiceStateUpdate failed: ${err?.message ?? err}`); }
          }
        } else if (msg.t === 'VOICE_SERVER_UPDATE') {
          if (this.voiceTap?.onVoiceServerUpdate) {
            try { this.voiceTap.onVoiceServerUpdate(msg.d as Record<string, unknown>); }
            catch (err: any) { this.log(`voice tap onVoiceServerUpdate failed: ${err?.message ?? err}`); }
          }
        }
        break;
      }
      default:
        // Ignore unknown opcodes — forward-compat with new gateway
        // features that don't affect DM routing.
        break;
    }
  }

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.clearHeartbeat();
    // Send first heartbeat after a jittered delay per the spec
    // (0..intervalMs). Then at the documented interval.
    const firstDelay = Math.floor(Math.random() * intervalMs);
    const kick = () => {
      if (!this.lastHeartbeatAck) {
        // No ACK in time — connection is zombied. Close + reconnect.
        this.log('heartbeat ack missed — closing connection');
        try { ws.close(4000, 'zombied'); } catch { /* ignore */ }
        return;
      }
      this.lastHeartbeatAck = false;
      this.sendGateway(ws, { op: OP_HEARTBEAT, d: this.lastSeq });
    };
    setTimeout(() => {
      if (ws.readyState !== 1 /* OPEN */) return;
      kick();
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState !== 1) { this.clearHeartbeat(); return; }
        kick();
      }, intervalMs);
    }, firstDelay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendGateway(ws: WebSocket, payload: GatewayPayload): void {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(payload)); } catch (err: any) {
      this.log(`gateway send failed: ${err?.message ?? err}`);
    }
  }

  // ── Message routing ────────────────────────────────────────

  /** EV12c — true when this message @mentions the bot itself (mentions array or the raw `<@id>` token). */
  private mentionsSelf(m: Record<string, unknown>, text: string): boolean {
    const self = this.selfUserId;
    if (!self) return false;
    if (Array.isArray(m.mentions) && (m.mentions as Array<{ id?: unknown }>).some(u => String(u?.id) === self)) return true;
    return text.includes(`<@${self}>`) || text.includes(`<@!${self}>`);
  }

  private stripSelfMention(text: string): string {
    const self = this.selfUserId;
    if (!self) return text;
    return text.split(`<@!${self}>`).join('').split(`<@${self}>`).join('').replace(/\s+/g, ' ').trim();
  }

  private async handleMessageCreate(m: Record<string, unknown>): Promise<void> {
    // Ignore bot's own messages (DM reply from our own send would
    // re-enter here).
    const author = m.author as { id?: string; bot?: boolean; username?: string } | undefined;
    if (!author?.id || author.bot) return;

    // DM-only v1 scope: guild_id is absent for DM channels.
    // Voice channel commands (`/voice-join`, `/voice-leave`,
    // `/voice-status`) and allowlisted, seat-addressed work bypass
    // DM-only. All other guild traffic stays gated unless explicitly
    // configured as a guild text channel.
    const isDm = !m.guild_id;
    const rawText = typeof m.content === 'string' ? m.content : '';
    const mentionsSelf = this.mentionsSelf(m, rawText);
    if (!isDm && !this.guildTextChannels.has(String(m.channel_id))) {
      if (!/^\/voice-(join|leave|status)\b/.test(rawText.trim())
          && !(this.allowedUsers.has(author.id) && (parseSeatAddress(rawText) || mentionsSelf))) {
        debug.log('discord.trigger', 'dropped', { reason: 'guild-not-chat', channelId: String(m.channel_id) });
        return;
      }
    }

    // Allowlist enforcement. An empty allowlist refuses everyone —
    // safer default than "open to the world" when the bot runs
    // with no user config.
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(author.id)) {
      debug.log('discord.trigger', 'dropped', { reason: 'not-allowed', isDm });
      this.log(`discord: refusing unknown user ${author.id}`);
      try {
        await this.sendMessage(
          String(m.channel_id),
          'This bot is private. Your user ID is not on the allowlist.',
        );
      } catch { /* swallow — already logged */ }
      return;
    }

    // Parse attachment list — Discord sends { id, filename, size,
    // url, content_type, width, height, duration_secs } per file.
    const attachments: DcAttachment[] = [];
    if (Array.isArray(m.attachments)) {
      for (const raw of m.attachments as Array<Record<string, unknown>>) {
        if (typeof raw?.url !== 'string' || typeof raw?.filename !== 'string') continue;
        attachments.push({
          id: String(raw.id ?? ''),
          filename: raw.filename,
          size: typeof raw.size === 'number' ? raw.size : 0,
          url: raw.url,
          contentType: typeof raw.content_type === 'string' ? raw.content_type : undefined,
          width: typeof raw.width === 'number' ? raw.width : undefined,
          height: typeof raw.height === 'number' ? raw.height : undefined,
          durationSecs: typeof raw.duration_secs === 'number' ? raw.duration_secs : undefined,
        });
      }
    }

    const ctx: DcIncoming = {
      channelId: String(m.channel_id),
      userId: author.id,
      userName: author.username,
      text: mentionsSelf ? this.stripSelfMention(rawText) : rawText,
      messageId: String(m.id),
      isDm,
      attachments,
      raw: m,
    };

    // Cascade-zyu U2 — capture utterance intent at message ingress.
    try {
      const { userIntentLogger } = await import('./user-intent/index.js');
      userIntentLogger().emit({
        surface: 'discord',
        intent: {
          layer: 'utterance',
          kind: ctx.isDm ? 'discord.utterance.dm_text' : 'discord.utterance.channel_text',
          target: { kind: 'message', id: ctx.messageId, label: ctx.channelId },
          value: ctx.text,
        },
      });
    } catch { /* logging must never break the chat path */ }

    // Surface-unification v2 FU-1 (2026-05-11) — workflow-runtime tap.
    // Fires for every allowed message; the daemon's discord-source
    // matches against subscribed discordTrigger nodes and dispatches
    // independently of the chat LLM path. Best-effort: any tap throw
    // is logged + swallowed so the chat reply still flows. The mention
    // / message split mirrors the discordTrigger schema's `kind` enum.
    if (this.onTriggerTap) {
      const triggerEvent: DcTriggerEvent = {
        kind: 'message',
        channel: ctx.channelId,
        user: ctx.userId,
        body: ctx.text,
        messageId: ctx.messageId,
        isDm: ctx.isDm,
      };
      // Don't await — message tap should not block the chat reply.
      // Wrap in try/catch so a synchronous tap throw doesn't escape.
      try {
        const maybePromise = this.onTriggerTap(triggerEvent);
        if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
          (maybePromise as Promise<void>).catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            this.log(`discord trigger tap failed: ${reason}`);
          });
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log(`discord trigger tap failed: ${reason}`);
      }
    }

    // Addressed work is submitted only by configured owners; ordinary chat keeps its existing path.
    if (this.allowedUsers.has(author.id) && (parseSeatAddress(ctx.text) || (ctx.isDm && ctx.text && !ctx.text.startsWith('/')))) {
      const threadId = typeof m.thread_id === 'string' && m.thread_id ? m.thread_id : undefined;
      const replyChannelId = threadId ?? ctx.channelId;
      try {
        const seatReply = await handleDiscordSeatWork(ctx.text, {
          channelId: replyChannelId,
          messageId: ctx.messageId,
          userId: ctx.userId, isDm: ctx.isDm,
          ...(threadId ? { threadId } : {}),
        }, this.seatWorkDeps);
        if (seatReply !== null) {
          await this.sendMessage(replyChannelId, seatReply);
          return;
        }
      } catch (err: unknown) {
        this.log(`discord seat work failed: ${err instanceof Error ? err.message : String(err)}`);
        await this.sendMessage(replyChannelId, '좌석 요청을 접수하지 못했습니다. 잠시 후 다시 보내 주세요.');
        return;
      }
    }

    // §C5 스트리밍 flip — streaming.discord ON 이면 옛 경로(placeholder+streamer+delivery) 억제,
    // 청크 fan-out sink 가 담당(handler chunkProducer 가 primarySurfaces=['discord']). 텔레그램 동형.
    const dcStreamingFlip = getUserConfig().sessionFabric?.streaming?.discord === true;
    debug.log('discord.deliver', 'route', { channelId: ctx.channelId, path: dcStreamingFlip ? 'flip-fanout' : 'legacy' });
    // §C5-enh reactions-as-status — 턴 시작 👀. 완료 ✅ / 실패 ❌ 는 아래. fail-soft.
    const dcReactionsOn = true;
    debug.log('discord.deliver', 'reaction', { channelId: ctx.channelId, phase: 'start', emoji: '👀', on: dcReactionsOn });
    if (dcReactionsOn && ctx.messageId) void this.addReaction(ctx.channelId, ctx.messageId, '👀');

    // Post a `⏳ Working…` placeholder immediately (mirrors the
    // Telegram flow) so the user sees ack before the LLM answers.
    let placeholderId: string | null = null;
    if (!dcStreamingFlip) {
      try {
        const posted = await this.sendMessage(ctx.channelId, '⏳ Working…');
        placeholderId = posted?.id ?? null;
      } catch (err: any) {
        this.log(`placeholder send failed: ${err?.message ?? err}`);
      }
    }

    const streamer = (!dcStreamingFlip && placeholderId)
      ? this.makeStreamer(ctx.channelId, placeholderId)
      : undefined;

    try {
      const reply = await this.onMessage(ctx, streamer);
      streamer?.flushCancel();
      if (!reply) {
        if (placeholderId && streamer && !streamer.didEdit()) {
          try { await this.editMessage(ctx.channelId, placeholderId, '(no response)'); }
          catch { /* ignore */ }
        }
        return;
      }
      // Final: first chunk replaces the placeholder, remaining chunks
      // post as new messages. Discord has no deleteMessage-required
      // path; single-chunk fits overwrite cleanly.
      //
      // Multi-chunk continuation markers (2026-07-12): a long reply
      // splits into several discord messages, and a MIDDLE chunk can
      // end on anything (a relay marker, mid-code-block) — reading as
      // a finished-but-unsigned reply. Annotate every chunk with
      // `(i/N)` (middle ones get a ⏬ "continues" cue) so the reply's
      // extent is self-describing; only the last chunk carries the
      // execution footer as before.
      // §C5 flip — 옛 배달 억제(청크 fan-out sink.onFinal 이 담당). 비-flip 은 종전대로.
      if (dcStreamingFlip) {
        debug.log('discord.deliver', 'flip-suppress-legacy', { channelId: ctx.channelId, chars: reply.length });
      } else {
        let chunks = splitForDiscord(reply, this.maxChars);
        if (chunks.length > 1) {
          chunks = splitForDiscord(reply, this.maxChars - 16); // reserve marker room
          const n = chunks.length;
          chunks = chunks.map((c, i) => (i < n - 1 ? `${c}\n(${i + 1}/${n}) ⏬` : `${c}\n(${n}/${n})`));
        }
        // §C5 관측 — 디스코드 발화 사실 기록(제1원칙). category discord.deliver.
        debug.log('discord.deliver', 'send', { channelId: ctx.channelId, chars: reply.length, chunks: chunks.length });
        if (placeholderId) {
          await this.editMessage(ctx.channelId, placeholderId, chunks[0] ?? '');
          for (let i = 1; i < chunks.length; i++) {
            await this.sendMessage(ctx.channelId, chunks[i]!);
          }
        } else {
          for (const chunk of chunks) {
            await this.sendMessage(ctx.channelId, chunk);
          }
        }
      }
      // §C5-enh reactions — 완료 ✅. fail-soft.
      debug.log('discord.deliver', 'reaction', { channelId: ctx.channelId, phase: 'done', emoji: '✅', on: dcReactionsOn });
      if (dcReactionsOn && ctx.messageId) void this.addReaction(ctx.channelId, ctx.messageId, '✅');
    } catch (err: any) {
      streamer?.flushCancel();
      // §C5-enh reactions — 실패 ❌.
      debug.log('discord.deliver', 'reaction', { channelId: ctx.channelId, phase: 'fail', emoji: '❌', on: dcReactionsOn });
      if (dcReactionsOn && ctx.messageId) void this.addReaction(ctx.channelId, ctx.messageId, '❌');
      const line = `Error: ${err?.message ?? 'handler failed'}`;
      try {
        if (placeholderId) {
          await this.editMessage(ctx.channelId, placeholderId, line);
        } else {
          await this.sendMessage(ctx.channelId, line);
        }
      } catch { /* give up */ }
    }
  }

  private makeStreamer(
    channelId: string,
    messageId: string,
  ): DcMessageStreamer & { flushCancel: () => void; didEdit: () => boolean } {
    // Discord's docs cap edit rate at 5/sec per channel. We gap at
    // 1100ms which matches the Telegram streamer; keeps messages
    // readable (less flicker) and well under Discord's rate limits
    // even if bursty LLM output fires onUpdate dozens of times/sec.
    const MIN_EDIT_GAP_MS = 1100;
    const PARTIAL_CAP = Math.min(this.maxChars - 10, 1980);

    let pending: string | null = null;
    let inFlight = false;
    let lastSentAt = 0;
    let hasEdited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tryFlush = async (): Promise<void> => {
      if (cancelled || inFlight || pending === null) return;
      const now = Date.now();
      const waitMs = Math.max(0, lastSentAt + MIN_EDIT_GAP_MS - now);
      if (waitMs > 0) {
        if (!timer) {
          timer = setTimeout(() => { timer = null; void tryFlush(); }, waitMs);
        }
        return;
      }
      const toSend = pending;
      pending = null;
      inFlight = true;
      try {
        await this.editMessage(channelId, messageId, toSend);
        hasEdited = true;
        lastSentAt = Date.now();
      } catch (err: any) {
        this.log(`stream edit failed: ${err?.message ?? err}`);
      } finally {
        inFlight = false;
      }
      if (!cancelled && pending !== null) void tryFlush();
    };

    return {
      edit: (partialText: string) => {
        if (cancelled || !partialText) return;
        const clipped = partialText.length > PARTIAL_CAP
          ? partialText.slice(0, PARTIAL_CAP - 2) + ' …'
          : partialText;
        pending = clipped;
        void tryFlush();
      },
      flushCancel: () => {
        cancelled = true;
        pending = null;
        if (timer) { clearTimeout(timer); timer = null; }
      },
      didEdit: () => hasEdited,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Split a string into ≤ maxChars chunks at paragraph / line
 *  boundaries where possible; hard-cut as last resort. */
export function splitForDiscord(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    // Prefer the last paragraph break that fits.
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Sprint 21 wiring (M1.4) · Convert a Discord
 *  MESSAGE_REACTION_ADD/REMOVE gateway payload to our normalized
 *  DcReactionEvent. Returns null if any required field is missing. */
function normalizeGatewayReaction(d: Record<string, unknown>, removed: boolean): DcReactionEvent | null {
  const channelId = d['channel_id'];
  const messageId = d['message_id'];
  const userId = d['user_id'];
  const emojiRaw = d['emoji'] as Record<string, unknown> | undefined;
  if (typeof channelId !== 'string' || typeof messageId !== 'string'
      || typeof userId !== 'string' || !emojiRaw) return null;
  const name = emojiRaw['name'];
  if (typeof name !== 'string') return null;
  const ev: DcReactionEvent = {
    channelId, messageId, userId,
    emoji: { name },
    ts: Date.now(),
  };
  if (typeof emojiRaw['id'] === 'string') ev.emoji.id = emojiRaw['id'];
  if (typeof emojiRaw['animated'] === 'boolean') ev.emoji.animated = emojiRaw['animated'];
  if (removed) ev.removed = true;
  if (typeof d['guild_id'] === 'string') ev.guildId = d['guild_id'];
  return ev;
}
