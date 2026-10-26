import type { Message, MessageEnvelope } from '../../msg/msg-store.js';
import type { TgSlashCommand } from '../../telegram-commands.js';
import { ASK_OP_COMMAND, formatAskOpQuestionEnvelope } from '../../session/channel-ask-op-envelope.js';

export interface AskOpTelegramOptions {
  allowedUserIds: readonly number[];
  append: (message: MessageEnvelope, provenanceKey: string) => Message;
}

export interface AskOpDiscordOptions {
  allowedUserIds: readonly string[];
  allowedChannelIds: readonly string[];
  resolveBotId: () => Promise<string>;
  append: (message: MessageEnvelope, provenanceKey: string) => Message;
}

export interface AskOpDiscordContext {
  userId: string;
  channelId: string;
  messageId: string;
  text: string;
}

function appendAskOpQuestion(
  options: { append: AskOpTelegramOptions['append'] },
  input: { from: 'TELEGRAM' | 'DISCORD'; surface: string; correlation: string[]; question: string; provenanceKey: string },
): Message {
  return options.append({
    from: input.from,
    to: 'COORDINATOR',
    kind: 'question',
    body: [`${input.surface} /${ASK_OP_COMMAND}`, ...input.correlation, `question: ${input.question}`].join('\n'),
  }, input.provenanceKey);
}

function extractQuestion(text: string): string | null {
  const match = new RegExp(`^/(?:${ASK_OP_COMMAND}|ask-op)(?:@[-_a-z0-9]+)?(?:\\s+([\\s\\S]*))?$`, 'i').exec(text.trim());
  const question = match?.[1]?.trim();
  return question || null;
}

export function createAskOpTelegramSlashCommand(options: AskOpTelegramOptions): TgSlashCommand {
  return {
    name: ASK_OP_COMMAND,
    description: '운영 책임자에게 질문을 보냅니다',
    handler: async (_args, ctx) => {
      if (!options.allowedUserIds.includes(ctx.userId)) return '허용된 사용자만 OP에게 질문할 수 있습니다.';
      const question = extractQuestion(ctx.text);
      if (!question) return `사용법: /${ASK_OP_COMMAND} <질문>`;
      if (!Number.isSafeInteger(ctx.updateId) || ctx.updateId < 0) return 'Telegram update 식별값을 확인할 수 없어 질문을 저장하지 못했습니다.';

      const botId = (ctx.botId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const message = options.append({
        from: 'TELEGRAM',
        to: 'COORDINATOR',
        kind: 'question',
        body: formatAskOpQuestionEnvelope({
          surface: 'telegram', botId, chatId: ctx.chatId, threadId: ctx.threadId,
          messageId: ctx.messageId, updateId: ctx.updateId, question,
        }),
      }, `coord:tg-${botId}-${ctx.updateId}:COORDINATOR`);

      return `OP에게 질문 #${message.id}로 접수했습니다.`;
    },
  };
}

/** Handle a Discord text command from an already-routed message. Returning
 * undefined leaves every non-/askop message on its existing chat path. */
export function createAskOpDiscordIngress(options: AskOpDiscordOptions) {
  return async (ctx: AskOpDiscordContext): Promise<string | undefined> => {
    const match = new RegExp(`^/${ASK_OP_COMMAND}(?:\\s+([\\s\\S]*))?$`, 'i').exec(ctx.text.trim());
    if (!match) return undefined;
    if (!options.allowedUserIds.includes(ctx.userId)) return '허용된 사용자만 OP에게 질문할 수 있습니다.';
    if (!options.allowedChannelIds.includes(ctx.channelId)) return '허용된 Discord 채널에서만 OP에게 질문할 수 있습니다.';
    const question = match[1]?.trim();
    if (!question) return `사용법: /${ASK_OP_COMMAND} <질문>`;
    if (!/^\d+$/.test(ctx.messageId)) return 'Discord 메시지 식별값을 확인할 수 없어 질문을 저장하지 못했습니다.';

    let botId: string;
    try { botId = await options.resolveBotId(); }
    catch { return 'Discord 봇 식별값을 확인할 수 없어 질문을 저장하지 못했습니다.'; }
    if (!/^[A-Za-z0-9_-]+$/.test(botId)) return 'Discord 봇 식별값이 올바르지 않아 질문을 저장하지 못했습니다.';

    const message = appendAskOpQuestion(options, {
      from: 'DISCORD', surface: 'Discord',
      correlation: [
        `botId=${botId}`, `channelId=${ctx.channelId}`,
        `messageId=${ctx.messageId}`, `updateId=${ctx.messageId}`,
      ],
      question,
      provenanceKey: `coord:dc-${botId}-${ctx.messageId}:COORDINATOR`,
    });
    return `OP에게 질문 #${message.id}로 접수했습니다.`;
  };
}
