export interface AskOpQuestionEnvelope {
  surface: 'telegram';
  botId: string;
  chatId: number | string;
  threadId?: number | string;
  messageId: number | string;
  updateId: number | string;
  question: string;
}

export const ASK_OP_COMMAND = 'askop';

export function formatAskOpQuestionEnvelope(input: AskOpQuestionEnvelope): string {
  return [
    `Telegram /${ASK_OP_COMMAND}`,
    `botId=${input.botId}`,
    `chatId=${input.chatId}`,
    `threadId=${input.threadId ?? 'none'}`,
    `messageId=${input.messageId}`,
    `updateId=${input.updateId}`,
    `question: ${input.question.trim()}`,
  ].join('\n');
}

export function parseAskOpQuestionEnvelope(body: string): AskOpQuestionEnvelope | null {
  const telegram = /^Telegram \/(?:askop|ask-op)\nbotId=([A-Za-z0-9_-]+)\nchatId=(-?\d+)\nthreadId=(none|\d+)\nmessageId=(\d+)\nupdateId=(\d+)\nquestion: ([\s\S]+)$/.exec(body);
  if (telegram) {
    const [, botId, chatId, threadId, messageId, updateId, question] = telegram;
    return {
      surface: 'telegram', botId: botId!, chatId: chatId!,
      ...(threadId === 'none' ? {} : { threadId: threadId! }),
      messageId: messageId!, updateId: updateId!, question: question!,
    };
  }
  return null;
}
