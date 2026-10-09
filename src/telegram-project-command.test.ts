import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { debug } from './debug/log.js';
import type { Project } from './project/project-store.js';
import type { SessionMeta } from './session/index.js';
import { TelegramBot, type TgIncoming, type TgCallbackQuery } from './telegram.js';
import type { UserConfig } from './user-config.js';
import { defaultTelegramCommands } from './telegram-commands.js';
import { attachTelegramProjectButtons, projectCommand, type TelegramProjectCommandDeps } from './telegram-project-command.js';

const project = (id: string, name: string): Project => ({ id, name, createdAt: '2026-10-01T00:00:00Z' });
const research = project('prj_research', 'Research');
const projects = [project('prj_z', 'Zoo'), research, project('prj_r2', 'Research Lab'), project('prj_a', 'Alpha')];
const ctx: TgIncoming = {
  chatId: 42, threadId: 7, botId: 'bot-a', userId: 42, text: '/project', messageId: 1, updateId: 1,
  isDm: true, isGroup: false, attachments: [],
};
const meta = (projectId?: string): SessionMeta => ({
  id: 'current-session', createdAt: '', updatedAt: '', title: '', provider: '', model: '',
  messageCount: 1, source: 'telegram', ...(projectId ? { projectId } : {}),
});

const config = { telegram: { allowedUsers: [42] } } as UserConfig;

function fixture(initialProjectId?: string, available = projects) {
  const current = meta(initialProjectId);
  const other = meta('prj_z');
  other.id = 'other-session';
  const updates: string[] = [];
  const lookup: Array<[number, number | undefined, string | undefined]> = [];
  const deps: TelegramProjectCommandDeps = {
    list: () => [...available],
    find: (id) => available.find(p => p.id === id) ?? null,
    findSession: (chatId, threadId, botId) => {
      lookup.push([chatId, threadId, botId]);
      return current;
    },
    update: (id, mutate) => {
      updates.push(id);
      if (id !== current.id) throw new Error('wrong session');
      mutate(current);
      return current;
    },
  };
  const run = (args: string[], incoming = ctx, sendButtons?: (text: string, buttons: Array<Array<{ text: string; data: string }>>) => Promise<void>) =>
    projectCommand(deps).handler(args, incoming, { userConfig: config, allCommands: [], ...(sendButtons ? { sendButtons } : {}) });
  return { current, other, updates, lookup, run, deps };
}

let logSpy: ReturnType<typeof spyOn<typeof debug, 'log'>>;
beforeEach(() => { logSpy = spyOn(debug, 'log').mockImplementation(() => {}); });
afterEach(() => { logSpy.mockRestore(); });

const events = () => logSpy.mock.calls.filter(call => call[0] === 'telegram.project');

describe('/project', () => {
  it('lists the current project, sorted names (at most 20), and the move hint', async () => {
    const f = fixture(research.id, [...projects, ...Array.from({ length: 21 }, (_, i) => project(`prj_extra_${i}`, `Beta ${String(i).padStart(2, '0')}`))]);
    const reply = await f.run([]);
    expect(reply).toContain('지금 대화의 프로젝트: Research');
    const names = String(reply).split('\n').filter(line => line.startsWith('• ')).map(line => line.slice(2));
    expect(names).toHaveLength(20);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(reply).toContain('옮기려면 /project <이름>');
    expect(f.updates).toEqual([]);
    expect(f.lookup).toEqual([[42, 7, 'bot-a']]);
    expect(events().map(call => call[1])).toEqual(['listed']);
    expect(events()[0]?.[2]).toMatchObject({ projects: expect.arrayContaining([{ id: 'prj_a', name: 'Alpha' }]) });
  });

  it('sends only a sorted, two-per-row keyboard (at most eight buttons) for an owner DM', async () => {
    const available = [...projects, ...Array.from({ length: 12 }, (_, i) => project(`prj_extra_${i}`, `Beta ${String(i).padStart(2, '0')}`))];
    const f = fixture(research.id, available);
    const sent: Array<{ text: string; buttons: Array<Array<{ text: string; data: string }>> }> = [];
    const reply = await f.run([], ctx, async (text, buttons) => { sent.push({ text, buttons }); });
    expect(reply).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.buttons.map(row => row.length)).toEqual([2, 2, 2, 2]);
    expect(sent[0]?.buttons.flat()).toEqual([
      ...available.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6).map(p => ({ text: p.name, data: `prj:${p.id}` })),
      { text: '✓ Research', data: `prj:${research.id}` },
      { text: '받은 대화로', data: 'prj:-' },
    ]);
    expect(f.updates).toEqual([]);
  });

  it('keeps the current project visible and checked when it sorts after the first seven', async () => {
    const available = [...Array.from({ length: 9 }, (_, i) => project(`prj_${i}`, `Alpha ${i}`)), research];
    const f = fixture(research.id, available);
    const sent: Array<Array<{ text: string; data: string }>>[] = [];
    expect(await f.run([], ctx, async (_text, buttons) => { sent.push(buttons); })).toBeUndefined();
    expect(sent[0]?.flat()).toHaveLength(8);
    expect(sent[0]?.flat().at(-2)).toEqual({ text: '✓ Research', data: `prj:${research.id}` });
    expect(f.updates).toEqual([]);
  });

  it('does not send buttons without sendButtons, outside an owner private chat, or with args', async () => {
    const f = fixture();
    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };
    expect(await f.run([])).toContain('프로젝트 목록:');
    expect(await f.run([], { ...ctx, userId: 43 }, send)).toContain('프로젝트 목록:');
    expect(await f.run([], { ...ctx, isDm: false }, send)).toContain('프로젝트 목록:');
    expect(await f.run([], { ...ctx, chatId: -42 }, send)).toContain('프로젝트 목록:');
    expect(await f.run(['Research'], ctx, send)).toContain('옮겼습니다');
    expect(sent).toEqual([]);
  });

  it('omits callback payloads over 64 UTF-8 bytes and observes the omission', async () => {
    const long = project('가'.repeat(21), 'B00');
    const extra = Array.from({ length: 20 }, (_, i) => project(`prj_extra_${i}`, `B${String(i + 1).padStart(2, '0')}`));
    const f = fixture(undefined, [long, ...extra, ...projects]);
    const sent: Array<Array<{ text: string; data: string }>>[] = [];
    await f.run([], ctx, async (_text, buttons) => { sent.push(buttons); });
    expect(sent[0]?.flat().map(b => b.data)).toEqual([
      'prj:prj_a', ...extra.slice(0, 6).map(p => `prj:${p.id}`), 'prj:-',
    ]);
    expect(events().find(call => call[1] === 'button-rejected')?.[2]).toMatchObject({ reason: 'callback-data-too-long', projectId: long.id, bytes: 67 });
  });

  it('preserves the written list if the button transport fails', async () => {
    const f = fixture(research.id);
    const reply = await f.run([], ctx, async () => { throw new Error('telegram unavailable'); });
    expect(reply).toContain('지금 대화의 프로젝트: Research');
    expect(reply).toContain('옮기려면 /project <이름>');
    expect(events().find(call => call[1] === 'button-rejected')?.[2]).toMatchObject({ reason: 'send-failed', error: 'telegram unavailable' });
  });

  it('keeps the written list when there is no current conversation and never sends buttons', async () => {
    const sent: string[] = [];
    const deps: TelegramProjectCommandDeps = {
      list: () => { throw new Error('should not list'); },
      find: () => { throw new Error('should not find'); },
      update: () => { throw new Error('should not update'); },
      findSession: () => null,
    };
    expect(await projectCommand(deps).handler([], ctx, {
      userConfig: config, allCommands: [], sendButtons: async text => { sent.push(text); },
    })).toBe('아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시');
    expect(sent).toEqual([]);
  });

  it('allows exactly 64-byte callback data without truncation', async () => {
    const boundary = project('가'.repeat(20), 'Boundary');
    const f = fixture(undefined, [boundary]);
    const sent: Array<Array<{ text: string; data: string }>>[] = [];
    await f.run([], ctx, async (_text, buttons) => { sent.push(buttons); });
    expect(sent[0]?.flat()).toEqual([{ text: 'Boundary', data: `prj:${boundary.id}` }, { text: '✓ 받은 대화로', data: 'prj:-' }]);
    expect(Buffer.byteLength(sent[0]![0]![0]!.data, 'utf8')).toBe(64);
  });

  it('shows the inbox when no project is assigned', async () => {
    const reply = await fixture().run([]);
    expect(reply).toContain('받은 대화(프로젝트 없음)');
  });

  it('chooses a case-insensitive exact match before a matching prefix and updates only this conversation', async () => {
    const f = fixture();
    expect(await f.run(['rEsEaRcH'])).toBe('이 대화를 Research 프로젝트로 옮겼습니다');
    expect(f.updates).toEqual(['current-session']);
    expect(f.current.projectId).toBe(research.id);
    expect(f.other.projectId).toBe('prj_z');
    expect(events().map(call => call[1])).toEqual(['moved']);
    expect(events()[0]?.[2]).toMatchObject({ projects: [{ id: research.id, name: research.name }] });
  });

  it('moves on a unique name prefix', async () => {
    const f = fixture();
    expect(await f.run(['resEarch', 'l'])).toBe('이 대화를 Research Lab 프로젝트로 옮겼습니다');
    expect(f.current.projectId).toBe('prj_r2');
    expect(f.updates).toEqual(['current-session']);
  });

  it('rejects ambiguous prefixes with candidate names and no update', async () => {
    const f = fixture();
    const reply = await f.run(['res']);
    expect(reply).toContain('Research');
    expect(reply).toContain('Research Lab');
    expect(f.updates).toEqual([]);
    expect(events().map(call => call[1])).toEqual(['rejected']);
    expect(events()[0]?.[2]).toMatchObject({ reason: 'ambiguous', projects: expect.arrayContaining([{ id: research.id, name: research.name }]) });
  });

  it('rejects unknown names with the list hint and no update', async () => {
    const f = fixture();
    expect(await f.run(['missing'])).toBe('그 이름의 프로젝트가 없습니다 — /project 로 목록 보기');
    expect(f.updates).toEqual([]);
    expect(events()[0]?.[2]).toMatchObject({ reason: 'not-found' });
  });

  it('clears projectId from only the current conversation', async () => {
    const f = fixture(research.id);
    expect(await f.run(['-'])).toBe('받은 대화로 옮겼습니다');
    expect(f.current).not.toHaveProperty('projectId');
    expect(f.other.projectId).toBe('prj_z');
    expect(f.updates).toEqual(['current-session']);
    expect(events().map(call => call[1])).toEqual(['cleared']);
  });

  it('requires an existing conversation without touching a project or session store', async () => {
    const f = fixture();
    const deps: TelegramProjectCommandDeps = {
      list: () => { throw new Error('should not list'); },
      find: () => { throw new Error('should not find'); },
      update: () => { throw new Error('should not update'); },
      findSession: () => null,
    };
    expect(await projectCommand(deps).handler(['Research'], ctx, { userConfig: config, allCommands: [] }))
      .toBe('아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시');
    expect(f.updates).toEqual([]);
    expect(events()[0]?.[2]).toMatchObject({ reason: 'no-session' });
  });

  it('registers /project immediately after /sessions in the default Telegram commands', () => {
    const commands = defaultTelegramCommands();
    const index = commands.findIndex(command => command.name === 'sessions');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(commands[index + 1]?.name).toBe('project');
    expect(commands[index + 1]?.description).toBe('이 대화의 프로젝트 보기·옮기기');
  });
});

describe('project callback buttons', () => {
  function callbackFixture(initialProjectId?: string, available = projects) {
    const f = fixture(initialProjectId, available);
    const messages: Array<[number, string]> = [];
    const acks: string[] = [];
    let handler: ((q: TgCallbackQuery) => Promise<void> | void) | undefined;
    const bot = {
      botId: 'bot-a',
      onCallbackQuery: (fn: typeof handler) => { handler = fn; return () => { handler = undefined; }; },
      sendMessage: async (chatId: number, text: string) => { messages.push([chatId, text]); },
      answerCallbackQuery: async (id: string) => { acks.push(id); },
    } as Pick<TelegramBot, 'botId' | 'onCallbackQuery' | 'sendMessage' | 'answerCallbackQuery'>;
    const unsubscribe = attachTelegramProjectButtons(bot, config, f.deps);
    const tap = async (data: string, overrides: Partial<TgCallbackQuery> = {}) => {
      await handler?.({ id: 'tap', userId: 42, chatId: 42, data, ...overrides });
    };
    return { ...f, messages, acks, tap, unsubscribe };
  }

  it('moves the current chat session once by exact id and acknowledges the callback', async () => {
    const f = callbackFixture();
    await f.tap(`prj:${research.id}`);
    expect(f.lookup).toEqual([[42, undefined, 'bot-a']]);
    expect(f.updates).toEqual(['current-session']);
    expect(f.current.projectId).toBe(research.id);
    expect(f.other.projectId).toBe('prj_z');
    expect(f.messages).toEqual([[42, '지금 프로젝트: Research']]);
    expect(f.acks).toEqual(['tap']);
    expect(events().map(call => call[1])).toContain('button-moved');
    f.unsubscribe();
  });

  it('switches from an assigned project to a different one and replies with one current-project line', async () => {
    const f = callbackFixture(research.id);
    await f.tap('prj:prj_a');
    expect(f.updates).toEqual(['current-session']);
    expect(f.current.projectId).toBe('prj_a');
    expect(f.other.projectId).toBe('prj_z');
    expect(f.messages).toEqual([[42, '지금 프로젝트: Alpha']]);
    expect(f.acks).toEqual(['tap']);
    f.unsubscribe();
  });

  it('clears only the current session on prj:-', async () => {
    const f = callbackFixture(research.id);
    await f.tap('prj:-');
    expect(f.updates).toEqual(['current-session']);
    expect(f.current).not.toHaveProperty('projectId');
    expect(f.other.projectId).toBe('prj_z');
    expect(f.messages).toEqual([[42, '받은 대화로 옮겼습니다']]);
    expect(events().map(call => call[1])).toContain('button-cleared');
    f.unsubscribe();
  });

  it('rejects empty or oversized project callback ids before session lookup', async () => {
    const f = callbackFixture(research.id);
    await f.tap('prj:');
    await f.tap(`prj:${'가'.repeat(21)}`);
    expect(f.lookup).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(f.current.projectId).toBe(research.id);
    expect(f.messages).toEqual([]);
    expect(f.acks).toEqual(['tap', 'tap']);
    expect(events().filter(call => call[1] === 'button-rejected').map(call => (call[2] as { reason: string }).reason))
      .toEqual(['invalid-callback-data', 'invalid-callback-data']);
    f.unsubscribe();
  });

  it('rejects non-owner or non-private taps before looking up a session or updating it', async () => {
    const f = callbackFixture();
    await f.tap(`prj:${research.id}`, { userId: 43 });
    await f.tap('prj:-', { userId: 43 });
    await f.tap(`prj:${research.id}`, { chatId: -42 });
    await f.tap(`prj:${research.id}`, { chatId: undefined });
    await f.tap(`prj:${research.id}`, { threadId: 7 });
    expect(f.lookup).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(f.messages).toEqual([]);
    expect(events().filter(call => call[1] === 'button-rejected')).toHaveLength(5);
    f.unsubscribe();
  });

  it('informs the owner of a missing project or missing conversation without updating', async () => {
    const f = callbackFixture();
    await f.tap('prj:missing');
    expect(f.messages).toEqual([[42, '그 이름의 프로젝트가 없습니다 — /project 로 목록 보기']]);
    expect(f.updates).toEqual([]);
    f.unsubscribe();
    const missing = fixture();
    let handler: ((q: TgCallbackQuery) => Promise<void> | void) | undefined;
    const bot = {
      botId: 'bot-a',
      onCallbackQuery: (fn: typeof handler) => { handler = fn; return () => {}; },
      sendMessage: async (chatId: number, text: string) => { f.messages.push([chatId, text]); },
      answerCallbackQuery: async () => {},
    } as Pick<TelegramBot, 'botId' | 'onCallbackQuery' | 'sendMessage' | 'answerCallbackQuery'>;
    attachTelegramProjectButtons(bot, config, { ...missing.deps, findSession: () => null });
    await handler?.({ id: 'tap', userId: 42, chatId: 42, data: `prj:${research.id}` });
    expect(f.messages.at(-1)).toEqual([42, '아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시']);
    expect(missing.updates).toEqual([]);
    expect(events().filter(call => call[1] === 'button-rejected').map(call => (call[2] as { reason: string }).reason))
      .toEqual(['not-found', 'no-session']);
  });

  it('wires a keyboard into the same private chat with the reply target and callback updates it', async () => {
    const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
    const available = [research];
    const f = fixture(research.id, available);
    const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = String(input).split('/').at(-1)!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push({ method, body });
      if (method === 'getUpdates') {
        const updates = sent.filter(call => call.method === 'getUpdates').length === 1
          ? [{ update_id: 1, message: { message_id: 9, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/project' } }]
          : [{ update_id: 2, callback_query: { id: 'tap', from: { id: 42 }, message: { message_id: 10, chat: { id: 42 } }, data: `prj:${research.id}` } }];
        if (sent.filter(call => call.method === 'getUpdates').length === 2) bot.stop();
        return Response.json({ ok: true, result: updates });
      }
      return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 10 } : true });
    };
    const bot = new TelegramBot({
      token: 'bot-a:fake', allowedUsers: [42], onMessage: async () => { throw new Error('unexpected LLM'); },
      fetchImpl: transport as typeof fetch, perChatGapMs: 0, slashCommands: [projectCommand(f.deps)],
      slashContext: { userConfig: config },
    });
    const unsubscribe = attachTelegramProjectButtons(bot, config, f.deps);
    await bot.start();
    unsubscribe();
    const keyboard = sent.find(call => call.method === 'sendMessage' && call.body.reply_markup);
    expect(keyboard?.body).toMatchObject({
      chat_id: 42, reply_to_message_id: 9, text: '프로젝트를 선택하세요',
      reply_markup: { inline_keyboard: [[{ text: '✓ Research', callback_data: `prj:${research.id}` }, { text: '받은 대화로', callback_data: 'prj:-' }]] },
    });
    expect(sent.some(call => call.method === 'sendMessage' && String(call.body.text).includes('프로젝트 목록:'))).toBe(false);
    expect(f.updates).toEqual(['current-session']);
    expect(f.current.projectId).toBe(research.id);
    expect(sent.filter(call => call.method === 'sendMessage' && !call.body.reply_markup).map(call => call.body.text)).toEqual(['지금 프로젝트: Research']);
  });

  it('does not change affiliation if the configured owner differs from the allowlist', async () => {
    const f = fixture(research.id);
    let handler: ((q: TgCallbackQuery) => Promise<void> | void) | undefined;
    const bot = {
      botId: 'bot-a',
      onCallbackQuery: (fn: typeof handler) => { handler = fn; return () => {}; },
      sendMessage: async () => {},
      answerCallbackQuery: async () => {},
    } as Pick<TelegramBot, 'botId' | 'onCallbackQuery' | 'sendMessage' | 'answerCallbackQuery'>;
    attachTelegramProjectButtons(bot, { telegram: { allowedUsers: [42, 43] }, raw: { decisions: { telegramOwnerId: 43 } } } as unknown as UserConfig, f.deps);
    await handler?.({ id: 'tap', userId: 42, chatId: 42, data: 'prj:-' });
    expect(f.lookup).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(f.current.projectId).toBe(research.id);
    expect(events().filter(call => call[1] === 'button-rejected')).toHaveLength(1);
  });

  it('ignores unrelated callback data', async () => {
    const f = callbackFixture();
    await f.tap('dec:other:yes');
    expect(f.lookup).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(f.messages).toEqual([]);
    expect(f.acks).toEqual([]);
    expect(events()).toEqual([]);
    f.unsubscribe();
  });
});
