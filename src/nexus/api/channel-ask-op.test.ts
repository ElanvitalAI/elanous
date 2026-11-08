import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { startMsgSseServer } from '../../msg/msg-sse-server.js';
import { registerMsgCommands } from '../../cli/msg-cli.js';
import type { TgIncoming } from '../../telegram.js';
import { createAskOpDiscordIngress, createAskOpTelegramSlashCommand } from './channel-ask-op.js';
import { createTelegramChannelOpReplyTransport, deliverChannelOpReply } from '../../session/channel-op-reply-route.js';

function incoming(overrides: Partial<TgIncoming> = {}): TgIncoming {
  return {
    updateId: 501,
    chatId: -100123,
    userId: 42,
    text: '/ask-op can we move the release cut?',
    messageId: 73,
    threadId: 8,
    isDm: false,
    isGroup: true,
    attachments: [],
    botId: '987654',
    ...overrides,
  };
}

test('Telegram /ask-op posts a question with chat and thread correlation', async () => {
  const store = new MsgStore(':memory:');
  try {
    const command = createAskOpTelegramSlashCommand({
      allowedUserIds: [42],
      append: (message, key) => store.appendWithProvenance(message, key),
    });

    const reply = await command.handler([], incoming(), { userConfig: {} as never, allCommands: [command] });
    const [posted] = store.listByRecipient('COORDINATOR');

    expect(reply).toContain('OP');
    expect(posted).toMatchObject({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question' });
    expect(posted?.body).toContain('botId=987654');
    expect(posted?.body).toContain('chatId=-100123');
    expect(posted?.body).toContain('threadId=8');
    expect(posted?.body).toContain('messageId=73');
    expect(posted?.body).toContain('can we move the release cut?');
  } finally {
    store.close();
  }
});

test('the same Telegram update is idempotent and preserves its first question', async () => {
  const store = new MsgStore(':memory:');
  try {
    const command = createAskOpTelegramSlashCommand({
      allowedUserIds: [42],
      append: (message, key) => store.appendWithProvenance(message, key),
    });

    await command.handler([], incoming(), { userConfig: {} as never, allCommands: [command] });
    await command.handler([], incoming({ text: '/ask-op duplicate delivery changed' }), { userConfig: {} as never, allCommands: [command] });

    const posted = store.listByRecipient('COORDINATOR');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain('can we move the release cut?');
    expect(posted[0]?.body).not.toContain('duplicate delivery changed');
  } finally {
    store.close();
  }
});

test('ten simulated Telegram questions complete received → forwarded → OP answer → Telegram send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-ask-op-sim-'));
  const ledgerPath = join(dir, 'messages.db');
  const store = new MsgStore(ledgerPath);
  const sent: Array<{ chatId: number; body: string; options?: unknown }> = [];
  const coordinatorReadStore = new MsgStore(ledgerPath, { readOnly: true });
  const messageServer = startMsgSseServer({ store: coordinatorReadStore, token: 'fake-op-mailbox-token', port: 0, pollMs: 5 });
  const opCli = new Command();
  const opCliOut: string[] = [];
  registerMsgCommands(opCli, {
    openStore: () => new MsgStore(join(dir, 'messages.db')),
    out: { log: (line) => opCliOut.push(line), error: (line) => { throw new Error(line); } },
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'cron', source: 'loop-table', address, msgId, result: 'wake-deferred' }),
  });
  try {
    const command = createAskOpTelegramSlashCommand({
      allowedUserIds: [42],
      append: (message, key) => store.appendWithProvenance(message, key),
    });
    const transport = createTelegramChannelOpReplyTransport({
      botId: '987654', instance: 'test-instance',
      bot: { async sendMessage(chatId: number, body: string, options?: unknown) {
        sent.push({ chatId, body, options });
        return { messageId: 900 + sent.length };
      } } as never,
    });

    const scenarios = Array.from({ length: 10 }, (_, index) => ({
      index,
      chatId: -100123 - index,
      threadId: 8 + index,
      question: index === 1 || index === 7
        ? `long fake question ${index}: ${'release readiness detail '.repeat(120).trimEnd()}`
        : `short fake question ${index}?`,
    }));
    let opBusy = true;
    expect(scenarios[1]!.question.length).toBeGreaterThan(2_000);
    expect(scenarios[0]!.question.length).toBeLessThan(80);

    // All ten Telegram updates arrive while the simulated OP worker is busy.
    // Short and long questions queue while the OP worker is simulated as busy.
    for (const scenario of scenarios) {
      const { index, chatId, threadId, question: body } = scenario;
      const updateId = 700 + index;
      const ctx = incoming({ updateId, chatId, threadId, text: `/askop ${body}`, messageId: 80 + index });
      const received = await command.handler([], ctx, { userConfig: {} as never, allCommands: [command] });
      expect(received).toContain('전달했습니다');
      expect(opBusy).toBe(true);
      // No answer can leave Telegram while the simulated OP is busy.
      expect(opBusy).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // Read the actual coordinator mailbox SSE endpoint after the backlog forms;
    // its replay output is the evidence that each question reached the recipient.
    const response = await fetch(`http://127.0.0.1:${messageServer.port}/stream?to=COORDINATOR&since=0`, {
      headers: { authorization: 'Bearer fake-op-mailbox-token' },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const opInbox: Array<{ id: number; body: string }> = [];
    const deadline = Date.now() + 5_000;
    try {
      while (opInbox.length < 10 && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('coordinator SSE replay timed out before ten questions arrived')),
            Math.max(1, deadline - Date.now()));
        });
        const { value, done } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
        if (done) break;
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = event.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
          if (data) opInbox.push(JSON.parse(data) as { id: number; body: string });
        }
      }
    } finally { await reader.cancel().catch(() => undefined); }
    expect(opInbox).toHaveLength(10);
    const queued = scenarios.map(({ index, chatId, question }) => {
      const envelope = opInbox.find((message) => message.body.includes(`updateId=${700 + index}`));
      expect(envelope).toBeDefined();
      expect(envelope!.body).toContain(question);
      return { questionId: envelope!.id, index, chatId };
    });

    opBusy = false;
    expect(opBusy).toBe(false);
    // OP works through the backlog out of order; two replies are delayed to
    // model long handling. Each answer must still route to its own question.
    for (const { questionId, index, chatId } of [...queued].reverse()) {
      if (index === 2 || index === 6) await new Promise((resolve) => setTimeout(resolve, 10));
      // Simulate OP answering through the actual message CLI posting path.
      await opCli.parseAsync(['msg', 'post', `fake answer ${index}`, '--from', 'OP', '--to', 'TELEGRAM', '--reply-to', String(questionId), '--json'], { from: 'user' });
      const answer = JSON.parse(opCliOut.pop()!) as { id: number };
      expect(await deliverChannelOpReply(store, answer.id, transport, { instance: 'test-instance' }))
        .toMatchObject({ status: 'delivered' });
      expect(store.getMessage(answer.id)).toMatchObject({ from: 'OP', to: 'TELEGRAM', replyTo: questionId });
      expect(store.db.query('SELECT status FROM channel_op_reply_receipts WHERE question_id = ?').get(questionId))
        .toEqual({ status: 'delivered' });
      expect(chatId).toBe(-100123 - index);
    }

    expect(store.listByRecipient('COORDINATOR')).toHaveLength(10);
    expect(sent).toHaveLength(10);
    expect(sent.map(({ body, chatId }) => [body, chatId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual(scenarios.map(({ index, chatId }) => [`fake answer ${index}`, chatId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  } finally {
    messageServer.stop();
    coordinatorReadStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a forwarding failure tells the Telegram user which stage failed', async () => {
  const command = createAskOpTelegramSlashCommand({
    allowedUserIds: [42],
    append: () => { throw new Error('store unavailable'); },
  });
  const reply = await command.handler([], incoming(), { userConfig: {} as never, allCommands: [command] });
  expect(reply).toContain('OP에게 전달하지 못했습니다');
  expect(reply).toContain('다시 보내');
});

test('non-allowlisted users and empty questions never reach the OP inbox', async () => {
  const store = new MsgStore(':memory:');
  try {
    const command = createAskOpTelegramSlashCommand({
      allowedUserIds: [42],
      append: (message, key) => store.appendWithProvenance(message, key),
    });

    const denied = await command.handler([], incoming({ userId: 7 }), { userConfig: {} as never, allCommands: [command] });
    const empty = await command.handler([], incoming({ text: '/ask-op   ' }), { userConfig: {} as never, allCommands: [command] });

    expect(denied).toMatch(/허용|권한/);
    expect(empty).toMatch(/질문|사용법/);
    expect(store.listByRecipient('COORDINATOR')).toHaveLength(0);
  } finally {
    store.close();
  }
});

test('Discord /askop stores channel correlation and deduplicates a replay', async () => {
  const store = new MsgStore(':memory:');
  try {
    const ingress = createAskOpDiscordIngress({
      allowedUserIds: ['42'],
      allowedChannelIds: ['channel-9'],
      resolveBotId: async () => 'bot-1',
      append: (message, key) => store.appendWithProvenance(message, key),
    });
    const ctx = {
      userId: '42', channelId: 'channel-9', messageId: '730000000000000001',
      text: '/askop can we move the release cut?',
    };

    const reply = await ingress(ctx);
    await ingress({ ...ctx, text: '/askop replay changed' });
    const posted = store.listByRecipient('COORDINATOR');

    expect(reply).toContain('OP');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ from: 'DISCORD', to: 'COORDINATOR', kind: 'question' });
    expect(posted[0]?.body).toContain('channelId=channel-9');
    expect(posted[0]?.body).toContain('botId=bot-1');
    expect(posted[0]?.body).toContain('messageId=730000000000000001');
    expect(posted[0]?.body).toContain('updateId=730000000000000001');
    expect(posted[0]?.body).toContain('can we move the release cut?');
    expect(posted[0]?.body).not.toContain('replay changed');
  } finally {
    store.close();
  }
});

test('Discord /askop rejects users or channels outside their allowlists', async () => {
  const store = new MsgStore(':memory:');
  try {
    const ingress = createAskOpDiscordIngress({
      allowedUserIds: ['42'],
      allowedChannelIds: ['channel-9'],
      resolveBotId: async () => 'bot-1',
      append: (message, key) => store.appendWithProvenance(message, key),
    });

    const deniedUser = await ingress({ userId: '7', channelId: 'channel-9', messageId: '710000000000000001', text: '/askop denied' });
    const deniedChannel = await ingress({ userId: '42', channelId: 'channel-else', messageId: '720000000000000001', text: '/askop denied' });

    expect(deniedUser).toMatch(/허용|권한/);
    expect(deniedChannel).toMatch(/채널|허용/);
    expect(store.listByRecipient('COORDINATOR')).toHaveLength(0);
  } finally {
    store.close();
  }
});

test('Discord /askop helper leaves other messages on the existing chat path', async () => {
  const store = new MsgStore(':memory:');
  try {
    const ingress = createAskOpDiscordIngress({
      allowedUserIds: ['42'],
      allowedChannelIds: ['channel-9'],
      resolveBotId: async () => 'bot-1',
      append: (message, key) => store.appendWithProvenance(message, key),
    });

    expect(await ingress({ userId: '42', channelId: 'channel-9', messageId: '740000000000000001', text: 'hello OP' })).toBeUndefined();
    expect(await ingress({ userId: '42', channelId: 'channel-9', messageId: '750000000000000001', text: '/askop' })).toContain('사용법');
    expect(store.listByRecipient('COORDINATOR')).toHaveLength(0);
  } finally {
    store.close();
  }
});
