import { expect, test } from 'bun:test';
import { debug, type DebugEvent } from '../../debug/log.js';
import type { LogSink } from '../../mss/logging/sink.js';
import { receiveChannelEvent, registerOutboundAdapter, type ChannelAdapter } from './router.js';

const capabilities = {
  send: true, receive: true, thread: true, topic: true, persona: true,
  channelLifecycle: false, permissions: false, commands: false, attachments: true,
  buttons: true, choices: true, deliveryConfirmation: false, rateLimit: false,
};

const normalizeFirst = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as Record<string, unknown>;
  if (typeof event.event_id !== 'string' || typeof event.body !== 'string' || typeof event.room !== 'string') return null;
  return {
    text: event.body, kind: 'message', channel: event.room,
    senderId: 'opaque-sender-1', messageId: event.event_id, threadId: 'thread-9', topicId: 'topic-4',
    persona: { name: 'assistant' }, attachments: [{ url: 'https://example.test/file', name: 'brief.txt' }],
    buttons: [{ label: 'Open', value: 'open' }], choices: [{ label: 'Continue', value: 'yes' }],
  };
};

const normalizeSecond = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return null;
  const event = (payload as { event?: unknown }).event;
  if (!event || typeof event !== 'object') return null;
  const message = event as Record<string, unknown>;
  if (typeof message.id !== 'string' || typeof message.content !== 'string' || typeof message.roomId !== 'string') return null;
  return {
    text: message.content, kind: 'message', channel: message.roomId,
    senderId: 'opaque-sender-1', messageId: message.id, threadId: 'thread-9', topicId: 'topic-4',
    persona: { name: 'assistant' }, attachments: [{ url: 'https://example.test/file', name: 'brief.txt' }],
    buttons: [{ label: 'Open', value: 'open' }], choices: [{ label: 'Continue', value: 'yes' }],
  };
};

const expected = {
  text: 'ready', kind: 'message', channel: 'demo-room', senderId: 'opaque-sender-1', messageId: '00042',
  threadId: 'thread-9', topicId: 'topic-4', persona: { name: 'assistant' },
  attachments: [{ url: 'https://example.test/file', name: 'brief.txt' }],
  buttons: [{ label: 'Open', value: 'open' }], choices: [{ label: 'Continue', value: 'yes' }],
};

type MockAdapters = {
  first: string;
  second: string;
  unsupported: string;
  unregistered: string;
  unsupportedCalls: () => number;
};

let fixtureSequence = 0;
const mockAdapter = (type: string, receive: ChannelAdapter['receive'], canReceive = true): ChannelAdapter => ({
  type,
  capabilities: { ...capabilities, receive: canReceive },
  send: async () => ({ type, ok: true }),
  parseConfig: raw => raw.type === type ? { type } : undefined,
  receive,
});

async function withMockAdapters(run: (mock: MockAdapters) => Promise<void>): Promise<void> {
  const suffix = String(++fixtureSequence);
  const first = `mock-provider-a-${suffix}`;
  const second = `mock-provider-b-${suffix}`;
  const unsupported = `mock-provider-no-receive-${suffix}`;
  const unregistered = `mock-provider-unregistered-${suffix}`;
  let unsupportedCalls = 0;
  const adapters = [
    mockAdapter(first, normalizeFirst),
    mockAdapter(second, normalizeSecond),
    mockAdapter(unsupported, payload => {
      unsupportedCalls++;
      return normalizeFirst(payload);
    }, false),
  ];
  const disposers: Array<() => void> = [];
  try {
    for (const adapter of adapters) disposers.push(registerOutboundAdapter(adapter));
    await run({ first, second, unsupported, unregistered, unsupportedCalls: () => unsupportedCalls });
  } finally {
    for (const dispose of disposers) dispose();
  }
}

test('different receive payload shapes normalize to the same envelope without copying raw data', async () => {
  await withMockAdapters(async ({ first, second }) => {
    expect(await receiveChannelEvent(first, {
      event_id: '00042', body: 'ready', room: 'demo-room', raw: { secret: 'must-not-copy' },
    })).toEqual(expected);
    expect(await receiveChannelEvent(second, {
      event: { id: '00042', content: 'ready', roomId: 'demo-room', raw: { secret: 'must-not-copy' } },
    })).toEqual(expected);
  });
});

test('accepted receives emit run-attributed conformance events without payload data', async () => {
  const previousRunId = process.env.ELANOUS_RUN_ID;
  const runId = 'channel-receive-conformance-test-run';
  const events: DebugEvent[] = [];
  const sink: LogSink = { name: 'receive-conformance-test', emit: event => events.push(event) };
  const unregister = debug.registerSink(sink);
  process.env.ELANOUS_RUN_ID = runId;
  let provider = '';
  try {
    await withMockAdapters(async ({ first }) => {
      provider = first;
      expect(await receiveChannelEvent(first, {
        event_id: '00042', body: 'ready', room: 'demo-room', raw: { secret: 'must-not-be-logged' },
      })).toEqual(expected);
    });
    const event = events.find(record => record.category === 'nexus.outbound' && record.event === 'receive-conformance');
    expect(event?.data).toEqual({ runId, provider, outcome: 'accepted' });
    expect(JSON.stringify(event?.data)).not.toContain('must-not-be-logged');
  } finally {
    unregister();
    if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = previousRunId;
  }
});

test('malformed payloads and unregistered provider types fail closed', async () => {
  await withMockAdapters(async ({ first, second, unregistered }) => {
    expect(await receiveChannelEvent(first, { event_id: 42, body: 'ready', room: 'demo-room' })).toBeNull();
    expect(await receiveChannelEvent(second, { event: null })).toBeNull();
    expect(await receiveChannelEvent(unregistered, { event_id: '00042', body: 'ready', room: 'demo-room' })).toBeNull();
  });
});

test('receive-disabled adapter fails closed without calling its receive implementation', async () => {
  await withMockAdapters(async ({ unsupported, unsupportedCalls }) => {
    expect(await receiveChannelEvent(unsupported, {
      event_id: '00042', body: 'ready', room: 'demo-room',
    })).toBeNull();
    expect(unsupportedCalls()).toBe(0);
  });
});
