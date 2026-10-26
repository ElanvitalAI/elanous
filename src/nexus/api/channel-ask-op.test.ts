import { expect, test } from 'bun:test';
import { MsgStore } from '../../msg/msg-store.js';
import type { TgIncoming } from '../../telegram.js';
import { createAskOpDiscordIngress, createAskOpTelegramSlashCommand } from './channel-ask-op.js';

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
