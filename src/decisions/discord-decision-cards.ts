// DEC-TG — 디스코드 운반(운영 봇 · 대표 DM). 판단은 decision-cards.ts. 버튼 = MESSAGE_COMPONENT · 메모 = 모달.
import type { DiscordBot } from '../discord.js';
import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { DECISION_DATA_PREFIX, DecisionCardService, ghPrReplier, type CardTransport, type CardView } from './decision-cards.js';

const TICK_MS = 20_000;
const MEMO_PREFIX = 'decmemo:';
const EPHEMERAL = 64;
let current: DecisionCardService | null = null;

export function discordDecisionService(): DecisionCardService | null { return current; }

export function discordDecisionOwner(cfg: UserConfig): string | null {
  const raw = (cfg.raw?.decisions as { discordOwnerId?: unknown } | undefined)?.discordOwnerId;
  if (typeof raw === 'string' && /^\d{5,}$/.test(raw)) {
    debug.log('decisions.telegram', 'owner-source', { platform: 'discord', source: 'config' });
    return raw;
  }
  debug.log('decisions.telegram', 'owner-source', { platform: 'discord', source: 'default-first', allowlist: cfg.discord.allowedUsers.length }, cfg.discord.allowedUsers.length > 1 ? { level: 'warn' } : undefined);
  return cfg.discord.allowedUsers[0] ?? null;
}

/** `/decisions` typed in Discord — owner only, and only in a DM (a guild channel would show the cards to everyone). */
export async function discordDecisionsCommand(service: DecisionCardService, ctx: { userId: string; channelId: string; isDm: boolean }): Promise<string> {
  if (!service.isOwner(ctx.userId)) return '결정은 소유자만 볼 수 있습니다.';
  if (!ctx.isDm) return '결정은 개인 대화(DM)에서만 볼 수 있습니다.';
  return service.listOpen(ctx.channelId);
}

/** Card buttons → Discord action rows (choices primary · memo secondary · confirm success). */
export function discordComponents(view: CardView): Array<Record<string, unknown>> {
  return view.buttons.map((row) => ({
    type: 1,
    components: row.map((b) => ({
      type: 2,
      style: b.data.endsWith(':ok') ? 3 : b.data.endsWith(':memo') || b.data.endsWith(':-') ? 2 : 1,
      label: Array.from(b.label).slice(0, 80).join(''),
      custom_id: b.data.slice(0, 100),
    })),
  }));
}

type Bot = Pick<DiscordBot, 'openDmChannel' | 'sendMessageWithComponents' | 'editMessageWithComponents' | 'sendMessage' | 'respondToInteraction'>;

export function discordTransport(bot: Bot, owner: string): CardTransport {
  let dm: string | null = null;
  return {
    platform: 'discord',
    ownerChats: async () => {
      dm ??= await bot.openDmChannel(owner);
      return dm ? [dm] : [];
    },
    send: async (chat, view) => {
      const sent = await bot.sendMessageWithComponents(chat, view.text, discordComponents(view));
      return sent ? { chat, message: sent.id } : null;
    },
    edit: async (ref, view) => { await bot.editMessageWithComponents(ref.chat, ref.message, view.text, discordComponents(view)); },
    notify: async (chat, text) => { await bot.sendMessage(chat, text); },
  };
}

function userOf(raw: Record<string, unknown>): string {
  const member = raw.member as { user?: { id?: string } } | undefined;
  const user = raw.user as { id?: string } | undefined;
  return member?.user?.id ?? user?.id ?? '';
}

/** Handle a decision button or memo modal. Returns true when the interaction was ours (so nothing else answers it). */
export async function handleDiscordDecisionInteraction(bot: Bot, service: DecisionCardService, raw: Record<string, unknown>): Promise<boolean> {
  const data = raw.data as { custom_id?: string; components?: Array<{ components?: Array<{ value?: string }> }> } | undefined;
  const customId = data?.custom_id ?? '';
  const id = String(raw.id ?? '');
  const token = String(raw.token ?? '');
  const reply = (content: string) => bot.respondToInteraction(id, token, { type: 4, data: { content, flags: EPHEMERAL } });
  if (raw.type === 5 && customId.startsWith(MEMO_PREFIX)) {
    const value = data?.components?.[0]?.components?.[0]?.value ?? '';
    const view = await service.setNote(userOf(raw), customId.slice(MEMO_PREFIX.length), value);
    await reply(view ? '메모를 달았습니다 — 카드에서 선택지를 누르면 함께 기록됩니다.' : '메모를 달지 못했습니다(권한 또는 이미 정해진 결정).');
    return true;
  }
  if (raw.type !== 3 || !customId.startsWith(DECISION_DATA_PREFIX)) return false;
  const outcome = await service.tap(userOf(raw), customId);
  switch (outcome.kind) {
    case 'refused': await reply('권한이 없습니다.'); return true;
    case 'ignored': case 'unknown': await reply('알 수 없는 결정입니다.'); return true;
    case 'memo-requested': {
      const decisionId = /^dec:([^:]+):memo$/.exec(customId)?.[1] ?? '';
      await bot.respondToInteraction(id, token, { type: 9, data: {
        custom_id: `${MEMO_PREFIX}${decisionId}`.slice(0, 100), title: Array.from(`메모 달기 · ${decisionId}`).slice(0, 45).join(''),
        components: [{ type: 1, components: [{ type: 4, custom_id: 'note', style: 2, label: '메모', max_length: 300, required: true }] }],
      } });
      return true;
    }
    default:
      // UPDATE_MESSAGE on the tapped card (decided: the service already edited every card it sent — same content).
      await bot.respondToInteraction(id, token, { type: 7, data: { content: outcome.view.text, components: discordComponents(outcome.view) } });
      return true;
  }
}

export interface DiscordDecisionWire {
  service: DecisionCardService;
  onInteraction: (raw: Record<string, unknown>) => Promise<boolean>;
  stop: () => void;
}

export function attachDiscordDecisionCards(bot: Bot, cfg: UserConfig, opts: { tickMs?: number } = {}): DiscordDecisionWire | null {
  const owner = discordDecisionOwner(cfg);
  if (!owner) {
    debug.log('decisions.telegram', 'not-attached', { platform: 'discord', reason: 'no-owner' });
    return null;
  }
  const replyTarget = (cfg.raw?.decisions as { replyGhPr?: unknown } | undefined)?.replyGhPr;
  const service = new DecisionCardService({
    transport: discordTransport(bot, owner),
    ownerIds: [owner],
    ...(typeof replyTarget === 'string' && replyTarget ? { replyToRaiser: ghPrReplier(replyTarget) } : {}),
  });
  current = service;
  const timer = setInterval(() => {
    void service.tick().catch((error: unknown) => {
      debug.log('decisions.telegram', 'tick-failed', { platform: 'discord', reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
    });
  }, opts.tickMs ?? TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  debug.log('decisions.telegram', 'attached', { platform: 'discord', reply: typeof replyTarget === 'string' && Boolean(replyTarget) });
  return {
    service,
    onInteraction: (raw) => handleDiscordDecisionInteraction(bot, service, raw),
    stop: () => { clearInterval(timer); if (current === service) current = null; },
  };
}
