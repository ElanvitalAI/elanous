import { openMsgStore, openMsgStoreReadOnly, type Message, type MsgStore } from '../msg/msg-store.js';
import { subscribeMsgStream, type MsgStreamHandle } from '../msg/msg-sse-client.js';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { isOwnInstanceEndpoint, parseTelegramEndpoint, telegramEndpointKey } from './session-endpoint-key.js';
import type { TelegramBot } from '../telegram.js';
import { parseAskOpQuestionEnvelope } from './channel-ask-op-envelope.js';

export type ChannelOpEndpoint = { surface: 'telegram'; key: string } & NonNullable<ReturnType<typeof parseTelegramEndpoint>>;

export interface ChannelOpReplyTransport {
  /** Must reject endpoint keys whose instance or bot is not served by this transport. */
  canSend(endpoint: ChannelOpEndpoint): boolean;
  /** The stable idempotency key lets a transport suppress retries if it supports them. */
  send(endpoint: ChannelOpEndpoint, body: string, idempotencyKey: string): Promise<{ receiptId: string }>;
}

export function createTelegramChannelOpReplyTransport(input: {
  bot: Pick<TelegramBot, 'sendMessage'>;
  botId: string;
  instance: string;
}): ChannelOpReplyTransport {
  return {
    canSend(endpoint) {
      return endpoint.surface === 'telegram'
        && isOwnInstanceEndpoint(endpoint.instance, input.instance)
        && endpoint.botId === input.botId;
    },
    async send(endpoint, body, idempotencyKey) {
      if (endpoint.surface !== 'telegram') throw new Error('Telegram transport cannot send to Discord');
      const sent = await input.bot.sendMessage(Number(endpoint.chatId), body, {
        ...(endpoint.threadId !== '0' ? { threadId: Number(endpoint.threadId) } : {}),
      });
      return { receiptId: sent && 'messageId' in sent ? `telegram:${sent.messageId}` : `telegram:${idempotencyKey}` };
    },
  };
}

export type ChannelOpReplyResult =
  | { status: 'delivered'; receiptId: string }
  | { status: 'already-delivered'; receiptId: string }
  | { status: 'held' }
  | { status: 'unknown' }
  | { status: 'failed-permanent'; errorCode: number }
  | { status: 'rejected'; reason: 'not-op-reply' | 'missing-question' | 'invalid-question' | 'invalid-endpoint' | 'unknown-endpoint' | 'already-answered' };

const CREATE_RECEIPTS = `CREATE TABLE IF NOT EXISTS channel_op_reply_receipts (
  question_id INTEGER PRIMARY KEY REFERENCES msg_messages(id),
  answer_id INTEGER NOT NULL UNIQUE REFERENCES msg_messages(id),
  endpoint_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'unknown', 'retry', 'failed-permanent')),
  transport_receipt TEXT,
  transport_error_code INTEGER,
  updated_at TEXT NOT NULL
)`;

function telegramEndpoint(questionBody: string, instance: string): ChannelOpEndpoint | null {
  const source = parseAskOpQuestionEnvelope(questionBody);
  if (!source) return null;
  const threadId = source.threadId ?? '0';
  if (!Number.isSafeInteger(Number(source.chatId)) || !Number.isSafeInteger(Number(threadId))) return null;
  const key = telegramEndpointKey({ instance, botId: source.botId, chatId: source.chatId, threadId });
  const parsed = parseTelegramEndpoint(key);
  return parsed ? { surface: 'telegram', key, ...parsed } : null;
}

function parseQuestionEndpoint(questionBody: string, instance: string): ChannelOpEndpoint | null {
  return telegramEndpoint(questionBody, instance);
}

/**
 * Resolve an OP reply through its durable replyTo link, claim one channel receipt,
 * and send only to the endpoint captured in that question's stored envelope.
 * An interrupted/ambiguous attempt is held rather than resent. Telegram 4xx
 * responses other than rate limiting are terminal because the request cannot succeed unchanged.
 */
export async function deliverChannelOpReply(
  store: MsgStore,
  answerId: number,
  transport: ChannelOpReplyTransport,
  options: { instance: string },
): Promise<ChannelOpReplyResult> {
  store.db.exec(CREATE_RECEIPTS);
  const answer = store.getMessage(answerId);
  if (!answer || answer.from !== 'OP' || answer.replyTo === undefined) return { status: 'rejected', reason: 'not-op-reply' };
  const question = store.getMessage(answer.replyTo);
  if (!question) return { status: 'rejected', reason: 'missing-question' };
  if (question.to !== 'COORDINATOR' || question.kind !== 'question' || question.from !== 'TELEGRAM') {
    return { status: 'rejected', reason: 'invalid-question' };
  }
  const source = parseAskOpQuestionEnvelope(question.body);
  if (!source) return { status: 'rejected', reason: 'invalid-endpoint' };
  const provenanceKey = `coord:tg-${source.botId}-${source.updateId}:COORDINATOR`;
  const provenance = store.db.query(`SELECT 1 FROM msg_provenance WHERE provenance_key = ? AND message_id = ?`)
    .get(provenanceKey, question.id);
  if (!provenance) return { status: 'rejected', reason: 'invalid-question' };
  const endpoint = parseQuestionEndpoint(question.body, options.instance);
  if (!endpoint) return { status: 'rejected', reason: 'invalid-endpoint' };
  if (!transport.canSend(endpoint)) return { status: 'rejected', reason: 'unknown-endpoint' };

  const claim = store.db.transaction(() => {
    const existing = store.db.query(`SELECT answer_id, endpoint_key, status, transport_receipt, transport_error_code
      FROM channel_op_reply_receipts WHERE question_id = ?`).get(question.id) as {
        answer_id: number; endpoint_key: string; status: 'sending' | 'delivered' | 'unknown' | 'retry' | 'failed-permanent'; transport_receipt: string | null; transport_error_code: number | null;
      } | null;
    if (existing) {
      if (existing.answer_id !== answer.id || existing.endpoint_key !== endpoint.key) return { kind: 'already-answered' as const };
      if (existing.status === 'delivered') return { kind: 'delivered' as const, receiptId: existing.transport_receipt ?? '' };
      if (existing.status === 'failed-permanent') return { kind: 'failed-permanent' as const, errorCode: existing.transport_error_code ?? 400 };
      if (existing.status !== 'retry') return { kind: 'held' as const };
      store.db.query(`UPDATE channel_op_reply_receipts SET status = 'sending', updated_at = ?
        WHERE question_id = ? AND answer_id = ? AND status = 'retry'`)
        .run(new Date().toISOString(), question.id, answer.id);
      return { kind: 'claimed' as const };
    }
    store.db.query(`INSERT INTO channel_op_reply_receipts(question_id, answer_id, endpoint_key, status, updated_at)
      VALUES (?, ?, ?, 'sending', ?)`).run(question.id, answer.id, endpoint.key, new Date().toISOString());
    return { kind: 'claimed' as const };
  }).immediate();
  if (claim.kind === 'already-answered') return { status: 'rejected', reason: 'already-answered' };
  if (claim.kind === 'delivered') return { status: 'already-delivered', receiptId: claim.receiptId };
  if (claim.kind === 'failed-permanent') return { status: 'failed-permanent', errorCode: claim.errorCode };
  if (claim.kind === 'held') return { status: 'held' };

  try {
    const receipt = await transport.send(endpoint, answer.body, `ask-op-reply:${question.id}`);
    store.db.transaction(() => {
      store.db.query(`UPDATE channel_op_reply_receipts SET status = 'delivered', transport_receipt = ?, updated_at = ?
        WHERE question_id = ? AND answer_id = ? AND status = 'sending'`)
        .run(receipt.receiptId, new Date().toISOString(), question.id, answer.id);
    }).immediate();
    return { status: 'delivered', receiptId: receipt.receiptId };
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'errorCode' in error
      ? (error as { errorCode?: unknown }).errorCode
      : undefined;
    const permanent4xx = typeof errorCode === 'number' && Number.isInteger(errorCode)
      && errorCode >= 400 && errorCode < 500 && errorCode !== 429;
    const permanentErrorCode = permanent4xx ? errorCode as number : null;
    store.db.transaction(() => {
      store.db.query(`UPDATE channel_op_reply_receipts SET status = ?, transport_error_code = ?, updated_at = ?
        WHERE question_id = ? AND answer_id = ? AND status = 'sending'`)
        .run(permanent4xx ? 'failed-permanent' : 'unknown', permanentErrorCode, new Date().toISOString(), question.id, answer.id);
    }).immediate();
    if (permanentErrorCode !== null) return { status: 'failed-permanent', errorCode: permanentErrorCode };
    return { status: 'unknown' };
  }
}

/** Explicit operator reconciliation for an ambiguous Telegram send. */
export function reconcileChannelOpReply(
  store: MsgStore,
  questionId: number,
  decision: { status: 'delivered'; receiptId: string } | { status: 'not-delivered' },
): boolean {
  store.db.exec(CREATE_RECEIPTS);
  if (decision.status === 'delivered' && !decision.receiptId.trim()) throw new Error('receiptId is required for delivered reconciliation');
  const status = decision.status === 'delivered' ? 'delivered' : 'retry';
  const receiptId = decision.status === 'delivered' ? decision.receiptId : null;
  return store.db.transaction(() => store.db.query(`UPDATE channel_op_reply_receipts
    SET status = ?, transport_receipt = ?, updated_at = ? WHERE question_id = ? AND status IN ('sending', 'unknown')`)
    .run(status, receiptId, new Date().toISOString(), questionId).changes === 1).immediate();
}

export interface StartChannelOpReplyRouteOptions {
  transport: ChannelOpReplyTransport;
  instance: string;
  botId: string;
  cursorPath?: string;
  openReadStore?: () => MsgStore;
  openWriteStore?: () => MsgStore;
}

/** Listen to the Telegram seat mailbox and route only linked OP replies. */
export function startChannelOpReplyRoute(options: StartChannelOpReplyRouteOptions): MsgStreamHandle {
  const cursorPath = options.cursorPath ?? join(
    elanousStateRoot(), 'msg', 'sse-cursor', `TELEGRAM-channel-op-replies-${options.botId}.json`,
  );
  return subscribeMsgStream({
    address: 'TELEGRAM',
    cursorPath,
    pollMs: 500,
    openStore: options.openReadStore ?? (() => openMsgStoreReadOnly()),
    onMessage: async (message: Message) => {
      if (message.to !== 'TELEGRAM' || message.from !== 'OP' || message.replyTo === undefined) return;
      const store = (options.openWriteStore ?? (() => openMsgStore()))();
      try {
        const result = await deliverChannelOpReply(store, message.id, options.transport, { instance: options.instance });
        if (result.status === 'unknown' || result.status === 'rejected' || result.status === 'held' || result.status === 'failed-permanent') {
          debug.log('channel-op-reply-route', result.status, {
            answerId: message.id,
            reason: result.status === 'rejected' ? result.reason : undefined,
            errorCode: result.status === 'failed-permanent' ? result.errorCode : undefined,
          });
        }
      } finally { store.close(); }
    },
  });
}
