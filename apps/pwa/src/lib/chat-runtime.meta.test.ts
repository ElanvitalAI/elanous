import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '../components/providers/DaemonProvider';
import { ChatLayout } from '../components/chat/ChatLayout';
import { ChatInput } from '../components/chat/ChatInput';
import { ChatHistory } from '../components/chat/ChatHistory';
import type { ChatMessage } from './chat-runtime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dispatchMeta, isMetaCommand, META_COMMANDS, META_HANDLERS, type ChatRuntimeContext } from './chat-runtime';
import { DaemonClient } from './daemon-client';

const ctx = {
  sessionId: 'test-session',
  provider: 'anthropic',
  setSessionId: () => {},
  client: new DaemonClient({ baseUrl: 'http://localhost:31415', token: 'tok', provider: 'anthropic' }),
} satisfies ChatRuntimeContext;

function captureMetaLog(): { seen: unknown[]; restore: () => void } {
  const seen: unknown[] = [];
  const original = console.debug;
  console.debug = ((line: string, payload: unknown) => {
    if (line.includes('webterm.chat.meta-command')) seen.push(payload);
  }) as typeof console.debug;
  return { seen, restore: () => { console.debug = original; } };
}

describe('PWA slash-command boundary', () => {
  it('answers TUI commands and aliases locally, without calling an LLM', async () => {
    const cap = captureMetaLog();
    try {
      for (const name of ['/run-skill test', '/rs test', '/status', '/resume-turn']) {
        expect(isMetaCommand(name)).toBe(true);
        expect((await dispatchMeta(name, ctx))?.text).toBe(`${name.split(' ')[0]} 은 PWA 채팅에서 아직 안 됩니다 — 지금 되는 명령: /help /session /fork /budget /history /clear`);
      }
      expect(cap.seen).toEqual([
        { cmd: ':run-skill', outcome: 'unsupported-tui' },
        { cmd: ':rs', outcome: 'unsupported-tui' },
        { cmd: ':status', outcome: 'unsupported-tui' },
        { cmd: ':resume-turn', outcome: 'unsupported-tui' },
      ]);
    } finally { cap.restore(); }
  });

  it('answers unknown slash commands locally and observes the outcome', async () => {
    const cap = captureMetaLog();
    try {
      expect(isMetaCommand('/zzz')).toBe(true);
      expect(await dispatchMeta('/zzz extra', ctx)).toEqual({ text: '모르는 명령입니다: /zzz — /help 로 목록 보기' });
      expect(cap.seen).toEqual([{ cmd: ':zzz', outcome: 'unknown' }]);
    } finally { cap.restore(); }
  });

  it('preserves prose and path prompts, including the second-slash invariant', async () => {
    for (const line of ['/ 안녕', '/Users/user/x', '/Users/a/b', '/tmp/x', '/']) {
      expect(isMetaCommand(line)).toBe(false);
      expect(await dispatchMeta(line, ctx)).toBeNull();
    }
    expect(await dispatchMeta('안녕', ctx)).toBeNull();
  });

  it('keeps the meta handlers, their slash equivalents and their outcomes', async () => {
    const cap = captureMetaLog();
    try {
      expect(META_COMMANDS.map(({ name }) => name)).toEqual(['help', 'session', 'fork', 'rewind', 'undo', 'budget', 'history', 'clear', 'sessions', 'resume', 'model', 'reasoning', 'provider']);
      expect(Object.keys(META_HANDLERS)).toEqual(META_COMMANDS.map(({ name }) => `:${name}`));
      for (const name of ['help', 'session', 'budget', 'history', 'clear']) {
        expect(await dispatchMeta(`/${name}`, ctx)).toEqual(await dispatchMeta(`:${name}`, ctx));
      }
      const forked = await dispatchMeta(':fork', ctx);
      expect(forked?.newSessionId).toBeTruthy();
      expect(forked?.text).toContain('forked → new session');
      expect(cap.seen).toHaveLength(11);
      expect(cap.seen.every((event) => (event as { outcome: string }).outcome === 'ok')).toBe(true);
    } finally { cap.restore(); }
  });

  it('forks the persisted session, truncates by user turns and only switches on success', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const original = console.debug;
    console.debug = ((line: string, data: unknown) => {
      const event = line.match(/webterm\.chat\.fork/);
      if (event) events.push({ event: event[0], data });
    }) as typeof console.debug;
    const messages = [
      { role: 'user' }, { role: 'assistant' }, { role: 'meta' },
      { role: 'user' }, { role: 'system' }, { role: 'user' },
    ] as ChatMessage[];
    const client = { fetchJson: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { ok: true, id: `branch-${calls.length}` };
    } } as unknown as DaemonClient;
    const forkCtx = { ...ctx, client, messages };
    try {
      expect(await dispatchMeta('/fork', forkCtx)).toEqual({ text: 'forked → new session branch-1', newSessionId: 'branch-1' });
      expect(await dispatchMeta('/rewind 2', forkCtx)).toEqual({ text: '2개 사용자 턴 이전으로 분기했습니다 → branch-2', newSessionId: 'branch-2' });
      expect(await dispatchMeta('/undo', forkCtx)).toEqual({ text: '1개 사용자 턴 이전으로 분기했습니다 → branch-3', newSessionId: 'branch-3' });
      expect(calls.map(({ init }) => init)).toEqual([
        { method: 'POST' },
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"beforeUser":2}' },
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"beforeUser":3}' },
      ]);
      expect(calls.map(({ path }) => path)).toEqual(Array(3).fill('/v1/sessions/store/test-session/fork'));
      expect(events.map(({ data }) => data)).toEqual([
        { command: 'fork', outcome: 'forked', sessionId: 'test-session', newSessionId: 'branch-1' },
        { command: 'rewind', outcome: 'forked', sessionId: 'test-session', newSessionId: 'branch-2', beforeUser: 2 },
        { command: 'undo', outcome: 'forked', sessionId: 'test-session', newSessionId: 'branch-3', beforeUser: 3 },
      ]);
    } finally { console.debug = original; }
  });

  it('rejects invalid counts and store failures without switching sessions', async () => {
    const events: Array<{ command: string; outcome: string; sessionId: string }> = [];
    const original = console.debug;
    console.debug = ((line: string, data: { command: string; outcome: string; sessionId: string }) => {
      if (line.includes('webterm.chat.fork')) events.push(data);
    }) as typeof console.debug;
    try {
      const calls: string[] = [];
      const client = { fetchJson: async (path: string) => {
        calls.push(path);
        throw new Error('HTTP 503: unavailable\nprivate details');
      } } as unknown as DaemonClient;
      const local = { ...ctx, client, messages: [{ role: 'user' }, { role: 'assistant' }] as ChatMessage[] };
      for (const line of ['/rewind', '/rewind 0', '/rewind -1', '/rewind 1.5', '/rewind x', '/rewind 1 2', '/rewind 9007199254740993']) {
        expect((await dispatchMeta(line, local))?.newSessionId).toBeUndefined();
      }
      expect((await dispatchMeta('/rewind 2', local))?.newSessionId).toBeUndefined();
      expect((await dispatchMeta('/undo extra', local))?.newSessionId).toBeUndefined();
      expect(calls).toEqual([]);
      expect(await dispatchMeta('/fork', local)).toEqual({ text: '대화 분기 실패 — HTTP 503: unavailable' });
      expect(await dispatchMeta('/undo', local)).toEqual({ text: '대화 분기 실패 — HTTP 503: unavailable' });
      expect(calls).toHaveLength(2);
      const missing = { ...local, client: { fetchJson: async () => { throw new Error('HTTP 404: missing'); } } as unknown as DaemonClient };
      expect((await dispatchMeta('/undo', missing))?.newSessionId).toBeUndefined();
      expect((await dispatchMeta('/undo', missing))?.text).toBe('저장된 대화가 없어 되돌릴 수 없습니다');
      const empty = { ...local, messages: [] };
      expect((await dispatchMeta('/undo', empty))?.newSessionId).toBeUndefined();
      const fresh = await dispatchMeta('/fork', missing);
      expect(fresh?.newSessionId).toBeTruthy();
      expect(fresh?.newSessionId).not.toBe(ctx.sessionId);
      expect(fresh?.text).toContain('forked → new session');
      expect(events.map(({ outcome }) => outcome)).toEqual([
        'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid',
        'out-of-range', 'out-of-range', 'invalid', 'error', 'error',
        'empty', 'empty', 'out-of-range', 'empty',
      ]);
      expect(events.every(({ sessionId }) => sessionId === 'test-session')).toBe(true);
    } finally { console.debug = original; }
  });

  it('shows Korean help for /help and :help while preserving release scenario C2a/C2b', async () => {
    const colon = (await dispatchMeta(':help', ctx))?.text;
    expect((await dispatchMeta('/help', ctx))?.text).toBe(colon);
    expect(colon?.split('\n')).toEqual([
      '메타 명령(:이름 또는 /이름) (Meta commands):',
      ...META_COMMANDS.map(({ name, description }) => `  ${['rewind', 'undo', 'sessions', 'resume', 'model', 'reasoning', 'provider'].includes(name) ? '/' : ':'}${name.padEnd(16)}${description}`),
    ]);
    for (const description of META_COMMANDS.map(({ description }) => description)) {
      expect(description).toMatch(/[가-힣]/);
    }
    const scenario = readFileSync(resolve(import.meta.dir, '../../../../scripts/lib/pwa-scenarios/scenarios.ts'), 'utf8');
    expect(scenario).toContain("id: 'C2a'");
    expect(scenario).toContain("id: 'C2b'");
    expect(scenario.match(/includes\('Meta commands'\)/g)).toHaveLength(2);
    expect(colon).toContain('Meta commands');
    for (const name of ['sessions', 'resume', 'model', 'reasoning', 'provider']) expect(colon).toContain(`/${name}`);
  });

  it('routes /resume locally and preserves unsupported /resume-turn and /status', async () => {
    const cap = captureMetaLog();
    try {
      const result = await dispatchMeta('/resume abc', ctx);
      expect(result).toEqual({ text: '쓰는 법: /resume <id 앞자리> (4자 이상)' });
      expect(result?.text).not.toContain('아직 안 됩니다');
      for (const name of ['/resume-turn', '/status']) {
        expect((await dispatchMeta(name, ctx))?.text).toContain('PWA 채팅에서 아직 안 됩니다');
      }
      expect(cap.seen).toEqual([
        { cmd: ':resume', outcome: 'ok' },
        { cmd: ':resume-turn', outcome: 'unsupported-tui' },
        { cmd: ':status', outcome: 'unsupported-tui' },
      ]);
    } finally { cap.restore(); }
  });

  it('keeps unknown colon provider actions unknown while slash provider actions show choices', async () => {
    expect((await dispatchMeta(':provider x', ctx))?.text).toBe('unknown meta command: :provider');
    expect((await dispatchMeta('/provider x', ctx))?.text).toBe('쓸 수 있는 값: next · use <이름>');
    expect((await dispatchMeta(':provider use', ctx))?.text).toBe('쓸 수 있는 값: next · use <이름>');
  });

  it('runs the colon-form commands emitted by the PWA slash picker', async () => {
    for (const name of ['model', 'reasoning', 'provider']) {
      const line = name === 'provider' ? ':provider use' : `:${name} unknown`;
      const result = await dispatchMeta(line, ctx);
      expect(result?.text).toContain('쓸 수 있는 값:');
      expect(result?.text).not.toContain('아직 안 됩니다');
    }
  });

  it('routes model, reasoning and provider aliases locally rather than to unsupported TUI', async () => {
    const cap = captureMetaLog();
    try {
      for (const command of ['/model unknown', '/m unknown', '/reasoning unknown', '/r unknown', '/think unknown', '/provider use', '/p use']) {
        const result = await dispatchMeta(command, ctx);
        expect(result?.text).toContain('쓸 수 있는 값:');
        expect(result?.text).not.toContain('아직 안 됩니다');
      }
      expect(cap.seen).toEqual(['model', 'm', 'reasoning', 'r', 'think', 'provider', 'p'].map((name) => ({ cmd: `:${name}`, outcome: 'ok' })));
    } finally { cap.restore(); }
  });

  it('submits local slash commands through mounted PWA chat input without an LLM request', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(new EventTarget(), { sessionStorage: storage, localStorage: storage, location: { search: '' } }),
    });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    const acpRequests: string[] = [];
    const sseRequests: unknown[] = [];
    const switchedSessions: string[] = [];
    const acp = {
      on: () => () => {}, onAny: () => () => {}, onRequest: () => () => {},
      close: () => {},
      send: async (method: string) => { acpRequests.push(method); return { stopReason: 'end_turn' }; },
    };
    const client = {
      connectAcp: () => acp,
      voiceWsUrl: () => '',
      voiceCost: async () => ({}),
      fetchJson: async (path: string) => path === '/v1/sessions/store'
        ? { ok: true, sessions: [{ id: 'abcd1111-other', messageCount: 2, updatedAt: '2026-10-03T02:00:00Z', preview: 'old' }] }
        : { messages: [] },
      subscribeChatEvents: () => () => {},
      subscribeChatFeedbackEvents: () => () => {},
      promptStream: async (body: unknown) => {
        sseRequests.push(body);
        return { sessionId: 'test-session', text: 'LLM reply', stopReason: 'end_turn' };
      },
    };
    const daemon = {
      client: client as never,
      config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
      sessionId: 'test-session', setSessionId: (id: string) => { switchedSessions.push(id); }, setConfig: () => {},
    };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        tree = create(createElement(DaemonContext.Provider, { value: daemon }, createElement(ChatLayout)));
      });
      const input = tree!.root.findByType(ChatInput);
      await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/model' } }); });
      await act(async () => { input.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => {} }); });
      await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/zzz' } }); });
      await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
      await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/model unknown' } }); });
      await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
      await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/reasoning high' } }); });
      await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
      await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/resume abcd1' } }); });
      await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
      expect(switchedSessions).toEqual(['abcd1111-other']);
      const messages = tree!.root.findByType(ChatHistory).props.messages as ChatMessage[];
      expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'user', text: ':model' },
        { role: 'meta', text: expect.stringContaining('현재 모델: 확인할 수 없음') },
        { role: 'user', text: '/zzz' },
        { role: 'meta', text: '모르는 명령입니다: /zzz — /help 로 목록 보기' },
        { role: 'user', text: '/model unknown' },
        { role: 'meta', text: expect.stringContaining('쓸 수 있는 값: budget') },
        { role: 'user', text: '/reasoning high' },
        { role: 'meta', text: '추론 강도는 설정 화면에서 바꾸세요' },
        { role: 'user', text: '/resume abcd1' },
        { role: 'meta', text: 'abcd1111 대화로 옮겼습니다' },
      ]);
      expect(acpRequests.filter((method) => method === 'session/prompt')).toHaveLength(0);
      expect(sseRequests).toHaveLength(0);
    } finally {
      if (tree) {
        const mounted = tree;
        await act(async () => { mounted.unmount(); });
      }
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: Window }).window;
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('keeps the local TUI-name snapshot in sync with names and aliases, without a runtime server import', () => {
    const tuiSource = readFileSync(resolve(import.meta.dir, '../../../../src/chat/index.ts'), 'utf8');
    const catalog = tuiSource.split('export const SLASH_COMMANDS: SlashCommand[] = [')[1]?.split('\n];')[0];
    expect(catalog).toBeDefined();
    const names = [...catalog!.matchAll(/\{ name: '([^']+)',\s*aliases: \[([^\]]*)\]/g)]
      .flatMap((match) => [match[1], ...[...match[2]!.matchAll(/'([^']+)'/g)].map((alias) => alias[1])]);
    const source = readFileSync(resolve(import.meta.dir, 'chat-runtime.ts'), 'utf8');
    const list = source.match(/const TUI_SLASH_NAMES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
    expect(list).toBeDefined();
    const snap = [...list!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(snap).toEqual(names.filter((name) => !['model', 'm', 'reasoning', 'r', 'think', 'provider', 'p'].includes(name)));
    expect(source).not.toContain("from '../../../../src/chat/index'");
  });
});
