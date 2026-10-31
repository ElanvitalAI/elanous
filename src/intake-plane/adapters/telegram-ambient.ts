import { maybeHandleAmbientTextIntake } from '../ambient.js';
import type { IntakeAmbientCaptureMode } from '../../user-config.js';

const LINEAR_SECRETARY_INTENT = /(?:리니어|linear)(?:로|에|에다)?\s*(?:등록해(?:줘요?|주세요)?|정리해(?:줘요?|주세요)|쪼개(?:줘요?|주세요)|맡겨(?:줘요?|주세요)|만들어(?:줘요?|주세요))(?!\s*(?:라고|하던데|했는데|하라던데|해달라고|하라며))/i;

export interface TelegramAmbientMessageContext {
  text: string;
  chatId: number | string;
  userId: number | string;
  userName?: string;
  threadId?: number | string;
  ambientCapture?: IntakeAmbientCaptureMode;
}

export function createTelegramAmbientMessageHandler(deps: {
  runSecretary?: (request: string) => Promise<{ replyCard: string }>;
} = {}) {
  return async function maybeHandleTelegramAmbientMessage(ctx: TelegramAmbientMessageContext): Promise<string | null> {
    if (!ctx.text || ctx.text.startsWith('/')) return null;
    if (LINEAR_SECRETARY_INTENT.test(ctx.text)) {
      const runSecretary = deps.runSecretary ?? (async (request: string) =>
        (await import('../linear-secretary-runtime.js')).runLinearSecretaryRequest(request));
      try {
        const result = await runSecretary(ctx.text);
        return result.replyCard;
      } catch {
        return 'Linear 등록을 보류했습니다. 요청 날짜와 근거를 확인한 뒤 다시 시도해 주세요.';
      }
    }
    return maybeHandleAmbientTextIntake({
      surface: 'telegram',
      source: 'telegram',
      text: ctx.text,
      actor: {
        id: String(ctx.userId),
        ...(ctx.userName ? { display: ctx.userName } : {}),
      },
      channelContext: {
        chatId: String(ctx.chatId),
        ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
      },
      mode: ctx.ambientCapture ?? 'off',
    });
  };
}

export const maybeHandleTelegramAmbientMessage = createTelegramAmbientMessageHandler();
