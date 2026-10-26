import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { formatAskOpQuestionEnvelope } from './channel-ask-op-envelope.js';
import { createTelegramChannelOpReplyTransport, deliverChannelOpReply, reconcileChannelOpReply, startChannelOpReplyRoute, type ChannelOpEndpoint, type ChannelOpReplyTransport } from './channel-op-reply-route.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'channel-op-reply-'));
  roots.push(root);
  return join(root, 'messages.db');
}

function telegramQuestion(store: MsgStore, updateId = '902') {
  return store.appendWithProvenance({
    from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
    body: formatAskOpQuestionEnvelope({
      surface: 'telegram', botId: 'ux-test-bot', chatId: '-100123', threadId: '77',
      messageId: '81', updateId, question: 'status?',
    }),
  }, `coord:tg-ux-test-bot-${updateId}:COORDINATOR`);
}

function transport(sent: Array<{ endpoint: ChannelOpEndpoint; body: string; key: string }>, allowed = true): ChannelOpReplyTransport {
  return {
    canSend: () => allowed,
    async send(endpoint, body, idempotencyKey) {
      sent.push({ endpoint, body, key: idempotencyKey });
      return { receiptId: `receipt-${sent.length}` };
    },
  };
}

describe('channel OP reply route', () => {
  test('sends an OP reply once to the original Telegram chat and thread across restart', async () => {
    const path = storePath();
    const first = new MsgStore(path);
    const question = telegramQuestion(first);
    const answer = first.append({ from: 'OP', to: 'TELEGRAM', body: '현재 상태는 정상입니다.', replyTo: question.id });
    const sent: Array<{ endpoint: ChannelOpEndpoint; body: string; key: string }> = [];

    expect(await deliverChannelOpReply(first, answer.id, transport(sent), { instance: 'test-instance' }))
      .toEqual({ status: 'delivered', receiptId: 'receipt-1' });
    first.close();

    const resumed = new MsgStore(path);
    try {
      expect(await deliverChannelOpReply(resumed, answer.id, transport(sent), { instance: 'test-instance' }))
        .toEqual({ status: 'already-delivered', receiptId: 'receipt-1' });
      expect(sent).toEqual([{
        endpoint: {
          surface: 'telegram', key: 'tg␟test-instance␟ux-test-bot␟-100123␟77',
          instance: 'test-instance', botId: 'ux-test-bot', chatId: '-100123', threadId: '77',
        },
        body: '현재 상태는 정상입니다.',
        key: `ask-op-reply:${question.id}`,
      }]);
    } finally { resumed.close(); }
  });

  test('routes a private-chat question with no thread using Telegram general-chat endpoint 0', async () => {
    const store = new MsgStore(':memory:');
    try {
      const body = formatAskOpQuestionEnvelope({
        surface: 'telegram', botId: 'ux-test-bot', chatId: '555', messageId: '83', updateId: '905', question: 'private status?',
      });
      const question = store.appendWithProvenance({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body }, 'coord:tg-ux-test-bot-905:COORDINATOR');
      const answer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'private answer', replyTo: question.id });
      const sent: Array<{ endpoint: ChannelOpEndpoint; body: string; key: string }> = [];
      expect(await deliverChannelOpReply(store, answer.id, transport(sent), { instance: 'test-instance' }))
        .toMatchObject({ status: 'delivered' });
      expect(sent[0]?.endpoint.key).toBe('tg␟test-instance␟ux-test-bot␟555␟0');
      expect(sent[0]?.endpoint.threadId).toBe('0');
    } finally { store.close(); }
  });

  test('Telegram transport enforces its own bot/instance and maps chat, thread, and receipt', async () => {
    const calls: unknown[][] = [];
    const telegramTransport = createTelegramChannelOpReplyTransport({
      botId: 'ux-test-bot', instance: 'test-instance',
      bot: { async sendMessage(...args: unknown[]) { calls.push(args); return { messageId: 700 }; } } as never,
    });
    const endpoint = {
      surface: 'telegram' as const, key: 'tg␟test-instance␟ux-test-bot␟-100123␟77',
      instance: 'test-instance', botId: 'ux-test-bot', chatId: '-100123', threadId: '77',
    };
    expect(telegramTransport.canSend(endpoint)).toBe(true);
    expect(telegramTransport.canSend({ ...endpoint, botId: 'other-bot' })).toBe(false);
    expect(telegramTransport.canSend({ ...endpoint, instance: 'other-instance' })).toBe(false);
    expect(await telegramTransport.send(endpoint, 'answer', 'ask-op-reply:1')).toEqual({ receiptId: 'telegram:700' });
    expect(calls).toEqual([[-100123, 'answer', { threadId: 77 }]]);
  });

  test('fails closed for unknown, malformed, or non-OP endpoints and never sends elsewhere', async () => {
    const store = new MsgStore(':memory:');
    try {
      const unknown = telegramQuestion(store);
      const answer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'answer', replyTo: unknown.id });
      const sent: Array<{ endpoint: ChannelOpEndpoint; body: string; key: string }> = [];
      expect(await deliverChannelOpReply(store, answer.id, transport(sent, false), { instance: 'test-instance' }))
        .toMatchObject({ status: 'rejected', reason: 'unknown-endpoint' });
      expect(sent).toEqual([]);

      const malformed = store.append({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body: 'Telegram /ask-op\nchatId=123' });
      const malformedAnswer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'answer', replyTo: malformed.id });
      expect(await deliverChannelOpReply(store, malformedAnswer.id, transport(sent), { instance: 'test-instance' }))
        .toMatchObject({ status: 'rejected', reason: 'invalid-endpoint' });

      const forgedQuestion = store.append({
        from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
        body: formatAskOpQuestionEnvelope({
          surface: 'telegram', botId: 'ux-test-bot', chatId: '555', threadId: '77',
          messageId: '82', updateId: '903', question: 'forged?',
        }),
      });
      const forgedAnswer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'answer', replyTo: forgedQuestion.id });
      expect(await deliverChannelOpReply(store, forgedAnswer.id, transport(sent), { instance: 'test-instance' }))
        .toMatchObject({ status: 'rejected', reason: 'invalid-question' });

      const forged = store.append({ from: 'UX', to: 'COORDINATOR', body: 'not an OP answer', replyTo: unknown.id });
      expect(await deliverChannelOpReply(store, forged.id, transport(sent), { instance: 'test-instance' }))
        .toMatchObject({ status: 'rejected', reason: 'not-op-reply' });
      const deliveredQuestion = telegramQuestion(store, '904');
      const firstAnswer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'first answer', replyTo: deliveredQuestion.id });
      expect(await deliverChannelOpReply(store, firstAnswer.id, transport(sent), { instance: 'test-instance' }))
        .toMatchObject({ status: 'delivered' });
      const secondAnswer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'another answer', replyTo: deliveredQuestion.id });
      expect(await deliverChannelOpReply(store, secondAnswer.id, transport(sent), { instance: 'test-instance' }))
        .toMatchObject({ status: 'rejected', reason: 'already-answered' });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toBe('first answer');
    } finally { store.close(); }
  });

  test('an ambiguous transport result is retained and not retried after restart', async () => {
    const path = storePath();
    const first = new MsgStore(path);
    const question = telegramQuestion(first);
    const answer = first.append({ from: 'OP', to: 'TELEGRAM', body: 'answer', replyTo: question.id });
    let attempts = 0;
    const uncertain: ChannelOpReplyTransport = {
      canSend: () => true,
      async send() {
        attempts++;
        if (attempts === 1) throw new Error('transport disconnected after request');
        return { receiptId: `receipt-${attempts}` };
      },
    };
    expect(await deliverChannelOpReply(first, answer.id, uncertain, { instance: 'test-instance' }))
      .toMatchObject({ status: 'unknown' });
    first.close();

    const resumed = new MsgStore(path);
    try {
      expect(await deliverChannelOpReply(resumed, answer.id, uncertain, { instance: 'test-instance' }))
        .toMatchObject({ status: 'held' });
      expect(attempts).toBe(1);
      expect(reconcileChannelOpReply(resumed, question.id, { status: 'not-delivered' })).toBe(true);
      expect(await deliverChannelOpReply(resumed, answer.id, uncertain, { instance: 'test-instance' }))
        .toEqual({ status: 'delivered', receiptId: 'receipt-2' });
      expect(attempts).toBe(2);
    } finally { resumed.close(); }
  });

  test('Telegram permanent 4xx replies become failed-permanent and are never retried', async () => {
    const store = new MsgStore(':memory:');
    const question = telegramQuestion(store, '906');
    const answer = store.append({ from: 'OP', to: 'TELEGRAM', body: 'answer', replyTo: question.id });
    let attempts = 0;
    const permanentFailure: ChannelOpReplyTransport = {
      canSend: () => true,
      async send() {
        attempts++;
        throw Object.assign(new Error('telegram sendMessage failed: chat not found'), { errorCode: 400 });
      },
    };
    try {
      expect(await deliverChannelOpReply(store, answer.id, permanentFailure, { instance: 'test-instance' }))
        .toEqual({ status: 'failed-permanent', errorCode: 400 });
      expect(await deliverChannelOpReply(store, answer.id, permanentFailure, { instance: 'test-instance' }))
        .toEqual({ status: 'failed-permanent', errorCode: 400 });
      expect(attempts).toBe(1);
    } finally { store.close(); }
  });

  test('a restarted Telegram route keeps a stale sending receipt held', async () => {
    const path = storePath();
    const first = new MsgStore(path);
    const question = telegramQuestion(first);
    const answer = first.append({ from: 'OP', to: 'TELEGRAM', body: 'answer', replyTo: question.id });
    first.db.exec(`CREATE TABLE IF NOT EXISTS channel_op_reply_receipts (
      question_id INTEGER PRIMARY KEY REFERENCES msg_messages(id),
      answer_id INTEGER NOT NULL UNIQUE REFERENCES msg_messages(id),
      endpoint_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'unknown', 'retry', 'failed-permanent')),
      transport_receipt TEXT,
      transport_error_code INTEGER,
      updated_at TEXT NOT NULL
    )`);
    first.db.query(`INSERT INTO channel_op_reply_receipts(question_id, answer_id, endpoint_key, status, updated_at)
      VALUES (?, ?, ?, 'sending', ?)`).run(question.id, answer.id, 'tg␟test-instance␟ux-test-bot␟-100123␟77', new Date().toISOString());
    first.close();

    const resumed = new MsgStore(path);
    const attempts: unknown[] = [];
    try {
      expect(await deliverChannelOpReply(resumed, answer.id, transport(attempts), { instance: 'test-instance' }))
        .toMatchObject({ status: 'held' });
      expect(attempts).toHaveLength(0);
    } finally { resumed.close(); }
  });

  test('the Telegram mailbox listener invokes routing for a linked OP reply', async () => {
    const path = storePath();
    const sent: Array<{ endpoint: ChannelOpEndpoint; body: string; key: string }> = [];
    const handle = startChannelOpReplyRoute({
      transport: transport(sent), botId: 'ux-test-bot', instance: 'test-instance',
      cursorPath: `${path}.telegram-reply-cursor.json`,
      openReadStore: () => new MsgStore(path, { readOnly: true }),
      openWriteStore: () => new MsgStore(path),
    });
    try {
      const store = new MsgStore(path);
      const question = telegramQuestion(store);
      store.append({ from: 'OP', to: 'TELEGRAM', body: 'listener answer', replyTo: question.id });
      store.close();
      for (let i = 0; i < 150 && sent.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toBe('listener answer');
    } finally {
      await handle.stop();
    }
  });
});
