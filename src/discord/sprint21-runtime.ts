// Sprint 21 wiring runtime — single init function that wires the
// M1-M3 substrate (PersonaRegistry · WebhookPersonaAdapter ·
// SlashRouter · ApprovalGate) into a DiscordBot instance.
//
// PLAN: 내부 문서 `PLAN-discord-rich-light-persona-2026-05-01` §3
// FEATURE: 내부 문서 `FEATURE-discord-rich-light-persona-2026-05-01` §5
//
// Caller (src/index.ts or similar) creates the DiscordBot, then
// calls `wireSprint21Runtime({ bot, ... })` once at startup. The
// returned handle exposes the wired components for further use
// (lane orchestrator wiring lands sprint 22).
//
// v1 scope (sprint 21):
//   ✅ Persona registry load + fs.watch hot-reload
//   ✅ Slash command bulkOverwrite (guild scope optional)
//   ✅ INTERACTION_CREATE → SlashRouter.dispatchToBody → respondToInteraction
//   ✅ MESSAGE_REACTION_ADD/REMOVE → ApprovalGate.handleReaction
//   ✅ WebhookPool + WebhookPersonaAdapter ready for spawnLanes
// v2 (sprint 22):
//   ⏳ Lane orchestrator → webhook adapter wire (LLM call execution)
//   ⏳ Mention parser → persona LLM dispatch wire

import { debug } from '../debug/log.js';
import { botAudienceFor, gateDiscordSchemas } from '../maturity/bot-command-maturity.js';
import { buildBotSlashCatalog } from '../maturity/bot-slash-catalog.js';
import { FEATURE_MATURITY } from '../maturity/feature-maturity.js';
import { SLASH_COMMANDS } from '../chat/index.js';
import type { DiscordBot } from '../discord.js';
import {
  loadLayeredPersonaDirs,
  resolveRepositoryPersonaDir,
  resolveStatePersonaDir,
  watchLayeredPersonaDirs,
} from '../persona/global-registry.js';
import { PersonaRegistry } from '../persona/registry.js';
import { join } from 'node:path';
import { ApprovalGate } from './reaction-handler.js';
import { WebhookPool, makeWebhookRest } from './webhook-pool.js';
import { WebhookPersonaAdapter } from './webhook-persona-adapter.js';
import { makeCommandRest } from './slash-registry.js';
import {
  normalizeInteractionPayload, SlashRouter,
} from './slash-router.js';
import {
  RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
  type SlashCtxBase, type SlashInteraction,
} from './slash-types.js';
import { personaCommand, type PersonaCtx } from './slash-commands/persona.js';
import { pollCommand, type PollCtx } from './slash-commands/poll.js';
import { relayCommand, type RelayCtx } from './slash-commands/relay.js';
import { showroomCommand, type ShowroomCtx, type ShowroomSpawnRequest } from './slash-commands/showroom.js';
import { statusCommand, type StatusCtx, type ElanousStatusSnapshot } from './slash-commands/status.js';
import { botCommands } from './slash-commands/bots.js';

/** Composed slash context — all 5 commands' Ctx merged. */
export interface Sprint21SlashCtx extends SlashCtxBase, ShowroomCtx, PersonaCtx, RelayCtx, StatusCtx, PollCtx {}

export interface WireSprint21Opts {
  bot: DiscordBot;
  /** Bot token — needed for webhook + slash registration REST calls.
   *  Same value passed to DiscordBot. */
  token: string;
  /** Application ID — needed for slash command registration. */
  appId: string;
  /** Explicit persona directory. When omitted, state and repository layers load. */
  personasDir?: string;
  /** When set, slash commands register to this guild (immediate
   *  propagation). When unset, registers globally (~5 min propagation). */
  devGuildId?: string;
  /** Whether to enable fs.watch on personasDir. Default true. */
  watchPersonas?: boolean;
  /** Optional override for the spawnLanes callback used by /showroom.
   *  v1 default = ack-only ("would spawn N lanes"). Sprint 22+ wiring
   *  swaps in the lane orchestrator. */
  spawnLanes?: (req: ShowroomSpawnRequest) => Promise<{ message: string }>;
  /** Override the snapshot reported by /status. Default reports
   *  uptime + persona count + activeLaneCount=0 + version env. */
  snapshot?: () => ElanousStatusSnapshot | Promise<ElanousStatusSnapshot>;
  /** Bind a callback for /persona use (channel → personaId). */
  setActivePersona?: (channelId: string, personaId: string) => Promise<void>;
  /** Bind a callback for /relay (channel → strategy). */
  setChannelStrategy?: PersonaCtx extends infer _ ? RelayCtx['setChannelStrategy'] : never;
  /** Optional log function. */
  log?: (msg: string) => void;
  /** Dependency injection for tests. */
  fetchImpl?: typeof fetch;
}

export interface Sprint21Runtime {
  readonly registry: PersonaRegistry;
  readonly webhookPool: WebhookPool;
  readonly webhookAdapter: WebhookPersonaAdapter;
  readonly approvalGate: ApprovalGate;
  readonly router: SlashRouter<Sprint21SlashCtx>;
  /** Re-register slash commands (e.g., after persona dynamic
   *  command additions). Idempotent. */
  registerSlashCommands(): Promise<number>;
  /** Stop fs.watch on personas dir. */
  shutdown(): void;
}

/** One-shot wiring of the Sprint 21 Discord substrate into a bot.
 *  Call once at bot startup, after `new DiscordBot({...})` but
 *  before `bot.start()`. */
export async function wireSprint21Runtime(opts: WireSprint21Opts): Promise<Sprint21Runtime> {
  const log = opts.log ?? (() => {});
  // ⛔⭐ 디스코드가 «자기 손으로» 뿌리를 계산하면 전역 레지스트리와 «갈린다»
  //    (그리고 --test 우주가 운영 페르소나를 읽는다). 같은 해석을 «한 곳»에서 받는다.
  const stateDir = resolveStatePersonaDir();
  const personasDirs = opts.personasDir ? [opts.personasDir] : [stateDir, resolveRepositoryPersonaDir()];
  const startTime = Date.now();

  // 1. Persona registry — load + (optional) hot-reload
  const registry = new PersonaRegistry();
  const loadResult = opts.personasDir
    ? await registry.loadDir(opts.personasDir)
    : await loadLayeredPersonaDirs(registry, personasDirs);
  log(`[sprint21-wire] loaded ${loadResult.profiles.size} personas from ${personasDirs.join(', ')}`
    + (loadResult.errors.length ? ` (${loadResult.errors.length} errors)` : ''));
  for (const e of loadResult.errors) {
    log(`[sprint21-wire]   error in ${e.path}: ${e.message}`);
  }
  const stopLayeredWatch = opts.personasDir
    ? undefined
    : watchLayeredPersonaDirs(registry, personasDirs);
  if (opts.watchPersonas !== false) {
    registry.startWatch();
    log('[sprint21-wire] persona fs.watch started');
  }

  // 2. Webhook pool + adapter
  const webhookRest = makeWebhookRest({ token: opts.token, fetchImpl: opts.fetchImpl });
  const pool = new WebhookPool(webhookRest);
  const webhookAdapter = new WebhookPersonaAdapter({ pool, fetchImpl: opts.fetchImpl });

  // 3. ApprovalGate (M1.4 reaction HITL)
  const approvalGate = new ApprovalGate();

  // 4. Slash router + 5 commands
  const ctx: Sprint21SlashCtx = {
    // showroom
    spawnLanes: opts.spawnLanes
      ?? (async (req) => {
        // v1 default — webhook 만 spawn, LLM call orchestrator 는 sprint 22.
        try {
          for (let i = 0; i < req.tokens.length; i++) {
            const personaId = `lane-${i + 1}`;
            await pool.ensure(req.channelId, personaId);
          }
          return {
            message: `🎭 Spawned ${req.tokens.length} webhook(s) in <#${req.channelId}>` +
              (req.autoRelay ? ' · auto-relay flagged (LLM dispatch wires sprint 22)' : '') +
              '\n_(LLM lane execution wires sprint 22 — this PR provisions the webhook channel only)_',
          };
        } catch (err: unknown) {
          return { message: `⚠️ webhook spawn failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }),
    // persona
    listPersonas: () => registry.list(),
    getPersona: (id) => registry.get(id),
    ...(opts.setActivePersona ? { setActivePersona: opts.setActivePersona } : {}),
    // relay
    ...(opts.setChannelStrategy ? { setChannelStrategy: opts.setChannelStrategy } : {}),
    // status
    snapshot: opts.snapshot
      ?? (() => ({
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        personaCount: registry.size(),
        activeLaneCount: 0,  // sprint 22 — wire to lane orchestrator
        version: process.env['ELANOUS_VERSION'] ?? 'dev',
      } as ElanousStatusSnapshot)),
    // poll
    postPoll: async (channelId, pollBody) => {
      // POST /channels/{id}/messages with poll: {...}
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const res = await (opts.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${opts.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ poll: pollBody }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`postPoll ${channelId} failed: ${res.status} ${text}`);
      }
      const json = await res.json() as { id: string };
      return { messageId: json.id };
    },
  };

  const router = new SlashRouter<Sprint21SlashCtx>(ctx);
  router.bind(showroomCommand);
  router.bind(personaCommand);
  router.bind(relayCommand);
  router.bind(statusCommand);
  router.bind(pollCommand);
  for (const command of botCommands) router.bind(command);
  const catalog = buildBotSlashCatalog({
    surface: 'discord', coreCommands: SLASH_COMMANDS, maturity: FEATURE_MATURITY,
    handledCommands: router.schemas(),
  });
  for (const entry of catalog.commands) {
    if (entry.supported) continue;
    const { name, description } = entry;
    router.bind({ schema: { name, description }, handler: async () => ({
      type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
      content: catalog.unsupportedReply(entry.name)!,
      ephemeral: true,
    }) });
  }

  // 5. Wire bot callbacks — INTERACTION_CREATE + reactions
  // (Bot must be created with onInteraction/onReaction in opts;
  // this function ASSUMES the bot was created with our wired
  // callbacks. We provide the callback factories below for caller
  // composition.)

  // 6. Slash command registration
  const cmdRest = makeCommandRest({ token: opts.token, fetchImpl: opts.fetchImpl });
  async function registerSlashCommands(): Promise<number> {
    const allSchemas = router.schemas();
    const audience = botAudienceFor('discord');
    const { schemas, hidden } = gateDiscordSchemas(allSchemas, audience);
    debug.log('discord.command', 'menu-filtered', { total: allSchemas.length, shown: schemas.length - hidden, ...audience });
    if (opts.devGuildId) {
      const out = await cmdRest.bulkOverwriteGuild(opts.appId, opts.devGuildId, schemas);
      log(`[sprint21-wire] registered ${out.length} slash commands to guild ${opts.devGuildId}`);
      return out.length;
    } else {
      const out = await cmdRest.bulkOverwriteGlobal(opts.appId, schemas);
      log(`[sprint21-wire] registered ${out.length} slash commands globally (~5 min propagation)`);
      return out.length;
    }
  }

  if (debug.enabled) {
    debug.log('discord.sprint21.init', `personas=${registry.size()}`, {
      personasDirs, devGuildId: opts.devGuildId ?? null,
    });
  }

  return {
    registry,
    webhookPool: pool,
    webhookAdapter,
    approvalGate,
    router,
    registerSlashCommands,
    shutdown() {
      stopLayeredWatch?.();
      registry.stopWatch();
    },
  };
}

/** Build the `onInteraction` callback for a DiscordBot — given a
 *  wired runtime + bot, dispatches INTERACTION_CREATE through the
 *  slash router and POSTs the response. */
export function makeInteractionHandler(
  runtime: { router: SlashRouter<Sprint21SlashCtx> },
  bot: DiscordBot,
  log?: (msg: string) => void,
): (raw: Record<string, unknown>) => Promise<void> {
  const lg = log ?? (() => {});
  return async (raw: Record<string, unknown>) => {
    const intr: SlashInteraction | null = normalizeInteractionPayload(raw);
    if (!intr) {
      // Not a slash command — could be component (button/select)
      // interaction; that's sprint 22+ wiring.
      return;
    }
    try {
      const body = await runtime.router.dispatchToBody(intr);
      await bot.respondToInteraction(intr.id, intr.token, body);
    } catch (err: unknown) {
      lg(`[sprint21-wire] interaction handler failed: ${err instanceof Error ? err.message : String(err)}`);
      // Best-effort error response — Discord may have already
      // timed out (3s cap), so swallow if respondToInteraction
      // also fails.
      try {
        await bot.respondToInteraction(intr.id, intr.token, {
          type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '⚠️ command handler failed', flags: 64 },
        });
      } catch { /* swallow */ }
    }
  };
}

/** Build the `onReaction` callback — routes reactions through the
 *  ApprovalGate. */
export function makeReactionHandler(
  runtime: { approvalGate: ApprovalGate },
): (event: import('../discord.js').DcReactionEvent) => void {
  return (event) => {
    runtime.approvalGate.handleReaction({
      channelId: event.channelId,
      messageId: event.messageId,
      userId: event.userId,
      emoji: event.emoji,
      ...(event.removed !== undefined ? { removed: event.removed } : {}),
      ...(event.guildId !== undefined ? { guildId: event.guildId } : {}),
      ...(event.ts !== undefined ? { ts: event.ts } : {}),
    });
  };
}
