import { maybeHandleAmbientTextIntake } from '../ambient.js';
import type { IntakeAmbientCaptureMode } from '../../user-config/types.js';

export interface DiscordAmbientMessageContext {
  text: string;
  channelId: string;
  userId: string;
  userName?: string;
  guildId?: string;
  ambientCapture?: IntakeAmbientCaptureMode;
}

export async function maybeHandleDiscordAmbientMessage(
  ctx: DiscordAmbientMessageContext,
): Promise<string | null> {
  if (!ctx.text || ctx.text.startsWith('/') || ctx.text.startsWith('!')) return null;
  return maybeHandleAmbientTextIntake({
    surface: 'discord',
    source: 'discord',
    text: ctx.text,
    actor: {
      id: ctx.userId,
      ...(ctx.userName ? { display: ctx.userName } : {}),
    },
    channelContext: {
      chatId: ctx.channelId,
      ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
    },
    mode: ctx.ambientCapture ?? 'off',
  });
}
