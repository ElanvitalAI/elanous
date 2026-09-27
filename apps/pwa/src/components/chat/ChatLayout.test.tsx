import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatLayout } from './ChatLayout';
import { ChatPanel } from './ChatPanel';
import { ChatHistory } from './ChatHistory';
import { ChatInput } from './ChatInput';
import { SHARE_PREFILL_KEY } from '@/lib/share-prefill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

async function mount(opts: { acp: boolean; prefill?: string }) {
  const sessionStorage = storage();
  const localStorage = storage();
  if (opts.prefill) sessionStorage.setItem(SHARE_PREFILL_KEY, opts.prefill);
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(events, { sessionStorage, localStorage, location: { search: '' } }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  const requests: Array<{ method: string; body: unknown }> = [];
  const streams: unknown[] = [];
  let inbound: ((payload: unknown) => Promise<unknown>) | undefined;
  const acp = {
    on: () => () => {},
    onAny: () => () => {},
    onRequest: (method: string, handler: (payload: unknown) => Promise<unknown>) => {
      if (method === 'elanous/ask/request') inbound = handler;
      return () => { inbound = undefined; };
    },
    close: () => {},
    send: async (method: string, body: unknown) => {
      requests.push({ method, body });
      return { stopReason: 'end_turn' };
    },
  };
  const client = {
    connectAcp: () => { if (!opts.acp) throw new Error('no ACP'); return acp; },
    voiceWsUrl: () => '',
    voiceCost: async () => ({}),
    fetchJson: async () => ({ messages: [] }),
    subscribeChatEvents: () => () => {},
    subscribeChatFeedbackEvents: () => () => {},
    promptStream: async (body: unknown) => {
      streams.push(body);
      return { sessionId: 'session-1', text: 'reply', stopReason: 'end_turn' };
    },
  };
  const daemon = {
    client: client as never,
    config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
    sessionId: 'session-1',
    setSessionId: () => {},
    setConfig: () => {},
  };
  await act(async () => {
    tree = create(<DaemonContext.Provider value={daemon}><ChatLayout /></DaemonContext.Provider>);
  });
  const input = tree!.root.findByType(ChatInput);
  return { requests, streams, input, sessionStorage, receiveAsk: (payload: unknown) => inbound!(payload) };
}

test('stale session adoption keeps the first question and streamed answer on the mounted chat', async () => {
  const sessionStorage = storage();
  const localStorage = storage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { sessionStorage, localStorage, location: { search: '' } }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  let failLoad!: (error: Error) => void;
  let issueSession!: (id: string) => void;
  let finishPrompt!: (result: unknown) => void;
  let selectSession!: (id: string) => void;
  let hostSessionId = '';
  const sent: Array<{ method: string; body: unknown }> = [];
  const chunkHandlers = new Set<(frame: unknown) => void>();
  const sessionHandlers = new Set<(id: string) => void>();
  let staleLeases = 0;
  let promptPending = false;
  let staleClosed = false;
  const ready = (async () => {
    sent.push({ method: 'session/load', body: { sessionId: 'stale' } });
    try { await new Promise<void>((_, reject) => { failLoad = reject; }); } catch { /* unknown session */ }
    sent.push({ method: 'session/new', body: {} });
    const issued = await new Promise<string>((resolve) => { issueSession = resolve; });
    for (const handler of sessionHandlers) handler(issued);
    return issued;
  })();
  const deliverChunk = (text: string) => {
    for (const cb of chunkHandlers) cb({ params: {
      sessionId: 'issued', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    } });
  };
  const client = {
    connectAcp: ({ sessionId, onSession }: { sessionId: string; onSession?: (id: string) => void }) => {
      if (sessionId === 'stale') {
        staleLeases += 1;
        if (onSession) sessionHandlers.add(onSession);
        const ownedHandlers = new Set<(frame: unknown) => void>();
        let released = false;
        return {
          ready,
          on: (kind: string, cb: (frame: unknown) => void) => {
            if (kind === 'sessionUpdate') { ownedHandlers.add(cb); chunkHandlers.add(cb); }
            return () => { ownedHandlers.delete(cb); chunkHandlers.delete(cb); };
          },
          onAny: () => () => {},
          onRequest: () => () => {},
          close: () => {
            if (released) return;
            released = true;
            staleLeases -= 1;
            if (onSession) sessionHandlers.delete(onSession);
            for (const cb of ownedHandlers) chunkHandlers.delete(cb);
            if (staleLeases === 0 && !promptPending) staleClosed = true;
          },
          send: async (method: string, body: unknown) => {
            sent.push({ method, body });
            if (method !== 'session/prompt') return {};
            promptPending = true;
            return new Promise((resolve) => {
              finishPrompt = (result) => {
                promptPending = false;
                resolve(result);
                if (staleLeases === 0) staleClosed = true;
              };
            });
          },
        };
      }
      return {
        ready: Promise.resolve(sessionId),
        on: () => () => {}, onAny: () => () => {}, onRequest: () => () => {},
        close: () => {}, send: async () => ({}),
      };
    },
    voiceWsUrl: () => '', voiceCost: async () => ({}),
    fetchJson: async () => ({ messages: [] }),
    subscribeChatEvents: () => () => {},
    subscribeChatFeedbackEvents: () => () => {},
  };
  function Host() {
    const [sessionId, setSessionId] = useState('stale');
    hostSessionId = sessionId;
    selectSession = setSessionId;
    return <DaemonContext.Provider value={{
      client: client as never,
      config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
      sessionId, setSessionId, setConfig: () => {},
    }}><ChatPanel /></DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  const question = 'Reply with only the number that is one more than 2378.';
  await act(async () => { tree!.root.findByType(ChatInput).findByType('textarea').props.onChange({ target: { value: question } }); });
  await act(async () => { tree!.root.findByType(ChatInput).findAllByType('button').at(-1)!.props.onClick(); });
  expect(hostSessionId).toBe('stale');
  await act(async () => { failLoad(new Error('unknown session')); });
  expect(sent.map(({ method }) => method)).toContain('session/new');
  await act(async () => { issueSession('issued'); });
  expect(hostSessionId).toBe('issued');
  expect(staleClosed).toBe(false);
  expect(sent).toContainEqual({ method: 'session/prompt', body: {
    sessionId: 'issued', prompt: [{ type: 'text', text: question }],
  } });
  await act(async () => { deliverChunk('23'); });
  expect(tree!.root.findByType(ChatHistory).props.messages.at(-1).text).toBe('23');
  await act(async () => { deliverChunk('79'); finishPrompt({ stopReason: 'end_turn' }); });
  expect(hostSessionId).toBe('issued');
  expect(staleClosed).toBe(true);
  const messages = tree!.root.findByType(ChatHistory).props.messages as Array<{ role: string; text: string }>;
  expect(messages.map(({ role, text }) => ({ role, text }))).toContainEqual({ role: 'user', text: question });
  expect(messages.map(({ role, text }) => ({ role, text }))).toContainEqual({ role: 'assistant', text: '2379' });
  expect(messages.some(({ text }) => text.startsWith('error:'))).toBe(false);
  await act(async () => { selectSession('other-session'); });
  expect(tree!.root.findByType(ChatHistory).props.messages).toEqual([]);
});

test('mounted chat sends ACP session/prompt with sessionId and prompt only', async () => {
  const { input, requests, streams } = await mount({ acp: true });
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: 'hello' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toContainEqual({ method: 'session/prompt', body: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } });
  expect(streams).toHaveLength(0);
});

test('mounted chat handles /help locally and leaves unknown slash text for ACP', async () => {
  const { input, requests, streams } = await mount({ acp: true });
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/help' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toHaveLength(0);
  expect(streams).toHaveLength(0);
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/run-skill test' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toContainEqual({ method: 'session/prompt', body: {
    sessionId: 'session-1', prompt: [{ type: 'text', text: '/run-skill test' }],
  } });
});

test('mounted chat falls back to SSE when ACP is unavailable', async () => {
  const { input, requests, streams } = await mount({ acp: false });
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: 'fallback' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toHaveLength(0);
  expect(streams).toEqual([{ sessionId: 'session-1', userText: 'fallback', provider: 'anthropic' }]);
});

test('share text is displayed in the mounted composer and consumed once', async () => {
  const { sessionStorage } = await mount({ acp: true, prefill: 'Shared question' });
  const textarea = tree!.root.findByType('textarea');
  expect(textarea.props.value).toBe('Shared question');
  expect(sessionStorage.getItem(SHARE_PREFILL_KEY)).toBeNull();
});

test('Chat about this fills the composer after mount', async () => {
  const { sessionStorage, receiveAsk } = await mount({ acp: true });
  const { AskQuestionSheet } = await import('@/components/ask-user-question/AskQuestionSheet');
  let result!: Promise<unknown>;
  await act(async () => {
    result = receiveAsk({ id: 'ask-1', request: { questions: [
      { id: 'q1', header: 'Question', question: 'What now?', options: [] },
    ] } });
  });
  const sheet = tree!.root.findByType(AskQuestionSheet);
  await act(async () => { sheet.props.onChatAboutThis(); });
  expect(await result).toEqual({ answers: {}, cancelled: true });
  expect(tree!.root.findByType('textarea').props.value).toBe('[ Q: What now? ]\n\n');
  expect(sessionStorage.getItem(SHARE_PREFILL_KEY)).toBeNull();
});
