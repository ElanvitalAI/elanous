import { afterEach, describe, expect, test } from 'bun:test';
import { TelegramBot } from '../src/telegram.js';
import { debug } from '../src/debug/log.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import type { UserConfig } from '../src/user-config/types.js';

const config = {} as UserConfig;
type Event = { category: string; event: string; data?: any };

async function observe(
  text: string,
  options: {
    commands?: any[];
    context?: boolean;
    setMyCommandsResult?: unknown;
    failSendMessageOnce?: boolean;
    failEditMessageTextOnce?: boolean;
  } = {},
): Promise<Event[]> {
  const seen: Event[] = [];
  const off = debug.registerSink({
    name: `telegram-slash-observability-${Math.random()}`,
    emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
  });
  let served = false;
  let remainingSendFailures = options.failSendMessageOnce ? 3 : 0;
  let remainingEditFailures = options.failEditMessageTextOnce ? 100 : 0;
  let bot: TelegramBot;
  const fetchImpl: any = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/getUpdates')) {
      if (!served) {
        served = true;
        return { json: async () => ({ ok: true, result: [{
          update_id: 1,
          message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text },
        }] }) };
      }
      bot.stop();
      return { json: async () => ({ ok: true, result: [] }) };
    }
    if (url.endsWith('/setMyCommands')) {
      return { json: async () => ({ ok: true, result: options.setMyCommandsResult ?? true }) };
    }
    if (url.endsWith('/editMessageText') && remainingEditFailures > 0) {
      remainingEditFailures -= 1;
      return { json: async () => ({ ok: false, description: 'edit failed' }) };
    }
    if (url.endsWith('/sendMessage')) {
      if (remainingSendFailures > 0) {
        remainingSendFailures -= 1;
        throw new Error('send failed');
      }
      return { json: async () => ({ ok: true, result: { message_id: 2 } }) };
    }
    return { json: async () => ({ ok: true, result: body }) };
  };
  bot = new TelegramBot({
    token: 't', allowedUsers: [42], onMessage: async () => 'plain reply', fetchImpl,
    errorBackoffMs: 0, pollTimeoutSec: 0, perChatGapMs: 0,
    slashCommands: options.commands,
    ...(options.context === false ? {} : { slashContext: { userConfig: config } }),
  });
  try {
    await bot.start();
    return seen.filter((record) => record.category === 'telegram.command');
  } finally {
    off();
  }
}

function command(streaming = false, handler = async () => 'pong') {
  return [{ name: 'ping', description: 'health', streaming, handler }];
}

function received(events: Event[]) {
  return events.find((event) => event.event === 'received');
}

function handled(events: Event[]) {
  return events.find((event) => event.event === 'handled');
}

describe('Telegram slash-command observability', () => {
  afterEach(() => setUserConfigOverlay(null));

  test('pairs known non-streaming dispatch with token, arguments, result, and duration', async () => {
    const events = await observe('/ping one two', { commands: command() });
    expect(received(events)?.data).toMatchObject({ token: '/ping', argumentCount: 2, branch: 'match' });
    expect(handled(events)?.data).toMatchObject({ token: '/ping', result: 'handler-completed' });
    expect(handled(events)?.data.durationMs).toEqual(expect.any(Number));
  });

  test('distinguishes streaming dispatch and records completion after finalization', async () => {
    const events = await observe('/ping arg', { commands: command(true) });
    expect(events.filter((event) => event.event === 'received').at(-1)?.data).toMatchObject({
      token: '/ping', argumentCount: 1, branch: 'streaming-match',
    });
    expect(handled(events)?.data).toMatchObject({ token: '/ping', result: 'completed' });
  });

  test('records streaming finalization failure without claiming a handler failure', async () => {
    setUserConfigOverlay((current) => ({
      ...current,
      sessionFabric: { ...current.sessionFabric, streaming: { ...current.sessionFabric?.streaming, telegram: false } },
    }));
    const events = await observe('/ping', {
      commands: command(true),
      failEditMessageTextOnce: true,
    });
    expect(received(events)?.data).toMatchObject({ token: '/ping', branch: 'streaming-match' });
    expect(handled(events)?.data).toMatchObject({ token: '/ping', result: 'post-processing-failed' });
  });

  test('records reply-send failure without claiming a completed handler failed', async () => {
    const events = await observe('/ping', { commands: command(), failSendMessageOnce: true });
    expect(received(events)?.data).toMatchObject({ token: '/ping', branch: 'match' });
    expect(handled(events)?.data).toMatchObject({ token: '/ping', result: 'reply-send-failed' });
  });

  test('names a missing command list and records its non-dispatch completion', async () => {
    const events = await observe('/ping', { commands: [] });
    expect(received(events)?.data.branch).toBe('no-command-list');
    expect(handled(events)?.data.result).toBe('not-dispatched:no-command-list');
  });

  test('names missing context and records its non-dispatch completion', async () => {
    const events = await observe('/ping', { commands: command(), context: false });
    expect(received(events)?.data.branch).toBe('no-context');
    expect(handled(events)?.data.result).toBe('not-dispatched:no-context');
  });

  test('distinguishes an unknown command from a matched command', async () => {
    const events = await observe('/nope', { commands: command() });
    expect(received(events)?.data).toMatchObject({ token: '/nope', branch: 'unknown' });
    expect(handled(events)?.data).toMatchObject({ token: '/nope', result: 'unknown' });
  });

  test('does not emit received or handled events for non-slash input', async () => {
    const events = await observe('hello', { commands: command() });
    expect(events.filter((event) => event.event === 'received' || event.event === 'handled')).toEqual([]);
  });

  test('reports the actual setMyCommands result rather than the local command count', async () => {
    const events = await observe('hello', { commands: command(), setMyCommandsResult: { registered: 31 } });
    expect(events.find((event) => event.event === 'published')?.data).toMatchObject({
      success: true, result: { registered: 31 },
    });
  });
});
