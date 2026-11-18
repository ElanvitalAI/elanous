// ChatInput — seat requests, local commands, skills, and the minimal composer (WEB-CHAT-MINIMAL-SURFACE).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { dispatchMeta, META_COMMANDS } from '@/lib/chat-runtime';
import { ChatInput } from './ChatInput';
import { DaemonClient, SeatRequestError } from '@/lib/daemon-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_INPUT_SRC = readFileSync(join(HERE, 'ChatInput.tsx'), 'utf8');

describe('ChatInput · seat requests', () => {
  test('storage failure still displays replies and recovers the same browser id after remount', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    let cookie = '';
    let nextId = 0;
    const ids: string[] = [];
    const acked: string[] = [];
    const storage = { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('disabled'); } };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      sessionStorage: storage, addEventListener() {}, removeEventListener() {},
    } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      get cookie() { return cookie; }, set cookie(value: string) { cookie = value; },
    } });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      randomUUID: () => `a0000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    } });
    const client = {
      listSeatRequests: async () => ({ items: [], seats: [] }),
      listSeatAskAnswers: async (id: string) => {
        ids.push(id);
        return { items: [{ id: 'answer-1', text: 'CTO 답변: 완료' }] };
      },
      acknowledgeSeatAskAnswers: async (id: string) => { acked.push(id); },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    const mount = async () => { await act(async () => {
      tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={() => {}} /></DaemonContext.Provider>);
    }); };
    try {
      await mount();
      expect(tree!.root.findAllByProps({ role: 'status' }).some((node) => node.children.join('').includes('CTO 답변: 완료'))).toBe(true);
      await act(async () => { tree!.unmount(); });
      tree = undefined;
      await mount();
      expect(ids).toEqual([ids[0], ids[0]]);
      expect(acked).toEqual([]);
      expect(tree!.root.findAllByProps({ role: 'status' }).some((node) => node.children.join('').includes('CTO 답변: 완료'))).toBe(true);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: Window }).window;
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: Document }).document;
      if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else delete (globalThis as { crypto?: Crypto }).crypto;
    }
  });
  test('CTO ask obeys disabled and in-flight submit gates', async () => {
    const calls: string[] = [];
    let finish!: (reply: { reply: string }) => void;
    const client = {
      listSeatRequests: async () => ({ items: [], seats: [] }),
      submitSeatAsk: (text: string) => { calls.push(text); return new Promise<{ reply: string }>((resolve) => { finish = resolve; }); },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    const view = (disabled: boolean) => <DaemonContext.Provider value={daemon}>
      <ChatInput onSubmit={() => {}} disabled={disabled} />
    </DaemonContext.Provider>;
    await act(async () => { tree = create(view(true)); });
    try {
      await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: 'CTO에게 물어봐 상태?' } }); });
      const enter = async () => { await act(async () => { tree.root.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); }); };
      await enter();
      expect(calls).toHaveLength(0);
      await act(async () => { tree.update(view(false)); });
      await enter();
      expect(calls).toEqual(['CTO에게 물어봐 상태?']);
      await enter();
      expect(calls).toHaveLength(1);
      await act(async () => { finish({ reply: '기다립니다' }); });
    } finally { await act(async () => { tree.unmount(); }); }
  });
  test('daemon client sends authenticated GET/POST with the request key and surfaces server errors', async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 202;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(init.method === 'POST'
        ? status === 202 ? { receiptId: 'R-1', seat: 'MK', queuedAt: 'now' } : { error: 'unknown-seat', seats: [{ id: 'MK', title: 'CMO' }] }
        : { items: [], seats: [{ id: 'MK', title: 'CMO' }] }),
      { status: init.method === 'POST' ? status : 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const client = new DaemonClient({ baseUrl: 'http://daemon', token: 'secret', provider: '' });
      expect((await client.listSeatRequests({ seat: 'MK', limit: 4 })).seats).toEqual([{ id: 'MK', title: 'CMO' }]);
      expect(calls[0]!.url).toBe('http://daemon/v1/seat-requests?seat=MK&limit=4');
      expect((await client.submitSeatRequest({ seat: 'MK', text: 'draft' }, 'key-1')).receiptId).toBe('R-1');
      expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ seat: 'MK', text: 'draft' });
      expect(calls[1]!.init.headers).toMatchObject({ 'Idempotency-Key': 'key-1', authorization: 'Bearer secret' });
      status = 400;
      try { await client.submitSeatRequest({ text: '@cfo draft' }, 'key-2'); throw new Error('expected rejection'); }
      catch (error) { expect(error).toBeInstanceOf(SeatRequestError); expect((error as SeatRequestError).seats[0]!.title).toBe('CMO'); }
    } finally { globalThis.fetch = original; }
  });

  test('routes an addressed message with trailing newline to seat requests without a chip', async () => {
    const chats: string[] = [];
    const calls: Array<{ seat?: string; text: string }> = [];
    const client = {
      listSeatRequests: async () => ({ items: [], seats: [{ id: 'MK', title: 'CMO' }] }),
      submitSeatRequest: async (request: { seat?: string; text: string }) => {
        calls.push(request);
        return { receiptId: 'R-1', seat: 'MK', queuedAt: 'now' };
      },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={(text) => chats.push(text)} /></DaemonContext.Provider>); });
    try {
      expect(tree.root.findAllByType('button').filter((button) => button.props['aria-pressed'] === true)).toHaveLength(0);
      await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: '@cmo 작업\n' } }); });
      await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); });
      expect(calls).toEqual([{ text: '@cmo 작업' }]);
      expect(chats).toEqual([]);
    } finally { await act(async () => { tree.unmount(); }); }
  });

});

describe('ChatInput · local command menu', () => {
  test('uses the runtime handler catalog instead of a separate slash list', () => {
    expect(CHAT_INPUT_SRC).not.toContain('SLASH_COMMANDS');
    expect(CHAT_INPUT_SRC).toContain('META_COMMANDS');
    expect(CHAT_INPUT_SRC).toContain('return META_COMMANDS.filter');
    expect(CHAT_INPUT_SRC).toContain('setValue(`:${cmd.name} `)');
  });

  test('accepts new prefill after mount and drains the shared handoff', () => {
    expect(CHAT_INPUT_SRC).toContain('takeSharePrefill()');
    expect(CHAT_INPUT_SRC).toContain('setValue(prefill.text)');
  });

  test('mounted menu offers runtime commands and selecting one enters a local meta command', async () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
    const daemon = {
      client: { listSeatRequests: async () => ({ items: [], seats: [] }) } as never,
      config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {},
    };
    let mounted: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        mounted = create(<DaemonContext.Provider value={daemon}>
          <ChatInput onSubmit={() => {}} />
        </DaemonContext.Provider>);
      });
      await act(async () => {
        mounted!.root.findByType('textarea').props.onChange({ target: { value: '/' } });
      });
      const entries = mounted!.root.findAll((node) => node.type === 'li'
        && typeof node.props.onMouseDown === 'function');
      expect(entries).toHaveLength(META_COMMANDS.length);
      for (const cmd of META_COMMANDS) {
        expect(entries.some((entry) => entry.findAll((node) => node.type === 'span'
          && node.children.join('') === `:${cmd.name}`).length === 1)).toBe(true);
      }
      await act(async () => { entries[0]!.props.onMouseDown({ preventDefault() {} }); });
      expect(mounted!.root.findByType('textarea').props.value).toBe(`:${META_COMMANDS[0]!.name} `);
    } finally {
      if (mounted) {
        const tree = mounted;
        await act(async () => { tree.unmount(); });
      }
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('ChatInput · PCH-12 skill confirmation', () => {
  test('selecting a $ skill sends the explicit /run-skill command with the typed task, not a plain prompt', async () => {
    const originalFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
    const sent: string[] = [];
    const queries: string[] = [];
    const originalFetch = globalThis.fetch;
    const requests: Array<{ skill: string; task: string }> = [];
    const urls: string[] = [];
    const id = '123e4567-e89b-12d3-a456-426614174000';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // This test asserts the skill-execution contract. Background PWA
      // telemetry shares global fetch in the browser, so accept its batch
      // posts without mixing them into the skill request expectations.
      if (url === '/v1/debug-logs/batch') return new Response(null, { status: 204 });
      urls.push(url);
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
      if (init?.body) requests.push(JSON.parse(String(init.body)));
      return Response.json(init?.body ? { id } : { status: 'done', ok: true, output: '수집 완료' }, { status: init?.body ? 202 : 200 });
    }) as typeof fetch;
    const daemon = {
      client: { listSeatRequests: async () => ({ items: [], seats: [] }) } as never,
      config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {},
    };
    let tree: ReturnType<typeof create> | undefined;
    let executed: ReturnType<typeof dispatchMeta> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput
        onSubmit={(text) => {
          sent.push(text);
          if (text.includes('오늘 뉴스')) executed = dispatchMeta(text, {
            client: daemon.client, sessionId: 'test', provider: '', setSessionId: () => {},
            daemon: { baseUrl: 'http://fake', token: 'secret' },
          });
        }}
        onListSkills={async (query) => { queries.push(query); return { entries: [{ name: 'omni-crawl', description: '웹 수집' }] }; }}
      /></DaemonContext.Provider>); });
      await act(async () => { tree!.root.findByType('textarea').props.onChange({ target: { value: '$omni' } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); });
      expect(queries).toEqual(['omni']);
      if (!tree) throw new Error('ChatInput did not mount');
      const mounted = tree;
      const entry = mounted.root.findAllByType('li').find((node) => node.findAllByType('span').some((span) => span.children.join('') === 'omni-crawl'))!;
      await act(async () => { entry.props.onMouseDown({ preventDefault() {} }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(mounted.root.findByType('textarea').props.value).toBe('/run-skill omni-crawl ');
      await act(async () => { mounted.root.findByType('textarea').props.onChange({ target: { value: '/run-skill omni-crawl 오늘 뉴스' } }); });
      await act(async () => { mounted.root.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      expect(sent).toEqual(['/run-skill omni-crawl 오늘 뉴스']);
      expect(mounted.root.findByType('textarea').props.value).toBe('');
      await act(async () => { mounted.root.findByType('textarea').props.onChange({ target: { value: '오늘 뉴스 $omni' } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); });
      await act(async () => { mounted.root.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      expect(mounted.root.findByType('textarea').props.value).toBe('/run-skill omni-crawl 오늘 뉴스 ');
      await act(async () => { mounted.root.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      expect(sent).toEqual(['/run-skill omni-crawl 오늘 뉴스', '/run-skill omni-crawl 오늘 뉴스']);
      await act(async () => { mounted.root.findByType('textarea').props.onChange({ target: { value: '오늘 뉴스 $omni' } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); });
      await act(async () => { mounted.root.findByType('textarea').props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() {} }); });
      expect(mounted.root.findByType('textarea').props.value).toBe('오늘 뉴스 $omni-crawl');
      await act(async () => { mounted.root.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      expect(mounted.root.findByType('textarea').props.value).toBe('/run-skill omni-crawl 오늘 뉴스 ');
      await act(async () => { mounted.root.findByType('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      expect(sent).toEqual(Array(3).fill('/run-skill omni-crawl 오늘 뉴스'));
      expect(await executed).toEqual({ text: '수집 완료' });
      expect(requests).toEqual(Array(3).fill({ skill: 'omni-crawl', task: '오늘 뉴스' }));
      expect(urls).toEqual(Array(3).fill(['http://fake/v1/skills/exec', `http://fake/v1/skills/exec/${id}`]).flat());
    } finally {
      if (tree) {
        const mounted = tree;
        await act(async () => { mounted.unmount(); });
      }
      globalThis.fetch = originalFetch;
      if (originalFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', originalFrame);
      else delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
    }
  });
});

describe('WEB-CHAT-MINIMAL-SURFACE · composer', () => {
  test('the tools row is one attach button: no camera, note, voice, provider or seat chips; no inline mic', () => {
    const tools = CHAT_INPUT_SRC.slice(CHAT_INPUT_SRC.indexOf('data-elanous-composer-tools'));
    const row = tools.slice(0, tools.indexOf('</div>'));
    expect(row.match(/<[A-Z][A-Za-z]*/g)).toEqual(['<FileAttachButton']);
    // No route-prediction label next to the attach button either (self-review #38183).
    for (const removed of ['CameraAttachButton', 'SaveAsNoteButton', 'ShowroomVoiceIntake', 'ElanousProviderChip', 'SeatPicker', 'chat-voice-toggle-inline', 'prediction.mission', 'useMissionRouter']) {
      expect(CHAT_INPUT_SRC).not.toContain(removed);
    }
  });
});
