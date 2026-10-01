// ChatInput voice-intake wire — pins the R2 mount so a refactor
// can't silently strip the import.
//
// Pattern mirror: `test/nexus-multi-llm-wire-smoke.test.ts` —
// source-level grep is the right tool for "did this stay imported?"
// guards. Render-level tests would need to spin up the full
// DaemonProvider tree which is overkill for a single-button mount.
//
// The component itself (ShowroomVoiceIntake — historical name; the
// PR-2 cleanup of the rename can fold here without touching this
// guard) is exercised in
// `showroom/ShowroomVoiceIntake.test.tsx`.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { META_COMMANDS } from '@/lib/chat-runtime';
import { ChatInput } from './ChatInput';
import { DaemonClient, SeatRequestError } from '@/lib/daemon-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_INPUT_SRC = readFileSync(join(HERE, 'ChatInput.tsx'), 'utf8');

describe('ChatInput · seat requests', () => {
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
  test('keeps the same request key after a lost response and seat deselection/reselection', async () => {
    const calls: Array<{ request: { seat?: string; text: string }; key: string }> = [];
    let loseResponse = true;
    let receiptNumber = 0;
    const client = {
      listSeatRequests: async () => ({ items: [], seats: [{ id: 'MK', title: 'CMO' }] }),
      submitSeatRequest: async (request: { seat?: string; text: string }, key: string) => {
        calls.push({ request, key });
        if (loseResponse) throw new Error('response lost after enqueue');
        return { receiptId: `R-${++receiptNumber}`, seat: 'MK', queuedAt: new Date().toISOString() };
      },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={() => {}} /></DaemonContext.Provider>); });
    const chip = () => tree.root.findAllByType('button').find((button) => button.props['aria-pressed'] !== undefined)!;
    const send = async () => { await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); }); };
    try {
      await act(async () => { chip().props.onClick(); });
      await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: 'draft' } }); });
      await send();
      expect(calls).toHaveLength(1);
      expect(tree.root.findByType('textarea').props.value).toBe('draft');
      await act(async () => { chip().props.onClick(); });
      expect(chip().props['aria-pressed']).toBe(false);
      await act(async () => { chip().props.onClick(); });
      expect(chip().props['aria-pressed']).toBe(true);
      loseResponse = false;
      await send();
      expect(calls[1]!.request).toEqual(calls[0]!.request);
      expect(calls[1]!.key).toBe(calls[0]!.key);
      await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: 'draft' } }); });
      await send();
      expect(calls[2]!.key).not.toBe(calls[1]!.key);
    } finally { await act(async () => { tree.unmount(); }); }
  });

  test('rejects an attachment-only send while a seat is selected without draining attachments or sending chat', async () => {
    const chats: string[] = [];
    const requests: string[] = [];
    const removed: string[] = [];
    const attachment = { id: 'file-1', filename: 'brief.pdf', mediaType: 'application/pdf', size: 20, downloadUrl: '/v1/attachments/file-1' };
    const client = {
      listSeatRequests: async () => ({ items: [], seats: [{ id: 'MK', title: 'CMO' }] }),
      submitSeatRequest: async ({ text }: { text: string }) => { requests.push(text); return { receiptId: 'R-1', seat: 'MK', queuedAt: 'now' }; },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput
      onSubmit={(text) => chats.push(text)} attachments={[attachment]} onRemoveAttachment={(id) => removed.push(id)}
    /></DaemonContext.Provider>); });
    const chip = () => tree.root.findAllByType('button').find((button) => button.props['aria-pressed'] !== undefined)!;
    const send = async () => { await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); }); };
    try {
      await act(async () => { chip().props.onClick(); });
      await send();
      expect(tree.root.findByProps({ role: 'alert' }).children.join('')).toBe('자리 요청에는 첨부파일을 보낼 수 없습니다');
      expect(tree.root.findAllByType('li').some((item) => item.findAllByType('span').some((span) => span.children.join('') === 'brief.pdf'))).toBe(true);
      expect(removed).toEqual([]);
      expect(chats).toEqual([]);
      expect(requests).toEqual([]);
      await act(async () => { chip().props.onClick(); });
      await send();
      expect(chats).toEqual(['']);
    } finally { await act(async () => { tree.unmount(); }); }
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

  test('addressed message with trailing whitespace overrides a different selected seat', async () => {
    const chats: string[] = [];
    const calls: Array<{ seat?: string; text: string }> = [];
    const client = {
      listSeatRequests: async () => ({ items: [], seats: [{ id: 'MK', title: 'CMO' }, { id: 'TC', title: 'CTO' }] }),
      submitSeatRequest: async (request: { seat?: string; text: string }) => {
        calls.push(request);
        return { receiptId: 'R-2', seat: 'MK', queuedAt: 'now' };
      },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={(text) => chats.push(text)} /></DaemonContext.Provider>); });
    try {
      await act(async () => { tree.root.findAllByType('button').find((button) => button.children.join('') === 'CTO')!.props.onClick(); });
      await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: '@cmo 작업 \n' } }); });
      await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); });
      expect(calls).toEqual([{ text: '@cmo 작업' }]);
      expect(chats).toEqual([]);
    } finally { await act(async () => { tree.unmount(); }); }
  });

  test('routes selected and addressed messages, reuses retry key, shows receipts/errors and keeps ordinary chat', async () => {
    const chats: string[] = [];
    const calls: Array<{ request: { seat?: string; text: string }; key: string }> = [];
    let outcome: 'ok' | 'unknown' | 'failed' = 'ok';
    let receiptNumber = 0;
    const seats = [{ id: 'MK', title: 'CMO' }];
    const client = {
      listSeatRequests: async () => ({ items: [], seats }),
      submitSeatRequest: async (request: { seat?: string; text: string }, key: string) => {
        calls.push({ request, key });
        if (outcome === 'unknown') throw new SeatRequestError(400, 'unknown-seat', seats);
        if (outcome === 'failed') throw new SeatRequestError(503, 'enqueue-failed');
        return { receiptId: `R-${++receiptNumber === 1 ? '123' : receiptNumber}`, seat: 'MK', queuedAt: new Date().toISOString() };
      },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={(text) => chats.push(text)} /></DaemonContext.Provider>); });
    const type = async (text: string) => { await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: text } }); }); };
    const send = async () => { await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); }); };
    const visible = () => tree.root.findAll((node) => node.props.role === 'alert' || node.props.role === 'status').map((node) => node.children.join(''));
    try {
      await type('ordinary @cmo text'); await send();
      await type('  @cmo not addressed'); await send();
      expect(chats).toEqual(['ordinary @cmo text', '@cmo not addressed']); expect(calls).toHaveLength(0);
      await act(async () => { tree.root.findAllByType('button').find((button) => button.props['aria-pressed'] === false)!.props.onClick(); });
      await type('draft'); await send();
      expect(calls[0]!.request).toEqual({ seat: 'MK', text: 'draft' });
      expect(visible().join(' ')).toContain('📨 CMO 접수 R-123 · 방금');
      await act(async () => { tree.root.findAllByType('button').find((button) => button.props['aria-pressed'] === true)!.props.onClick(); });
      await type('@cmo next task'); await send();
      expect(calls[1]!.request).toEqual({ text: '@cmo next task' });
      expect(calls[1]!.key).not.toBe(calls[0]!.key);
      await type('@cmo next task'); await send();
      expect(calls[2]!.key).not.toBe(calls[1]!.key);
      await type('ordinary again'); await send();
      expect(chats).toEqual(['ordinary @cmo text', '@cmo not addressed', 'ordinary again']);
      outcome = 'unknown'; await type('@cfo unknown'); await send();
      expect(visible().join(' ')).toContain('그 자리를 찾지 못했습니다 — CMO');
      outcome = 'failed'; await send();
      expect(calls.at(-1)!.key).toBe(calls.at(-2)!.key);
      expect(visible().join(' ')).toContain('접수하지 못했습니다 — 잠시 뒤 다시');
      outcome = 'ok'; await send();
      expect(calls.at(-1)!.key).toBe(calls.at(-2)!.key);
      expect(chats).toEqual(['ordinary @cmo text', '@cmo not addressed', 'ordinary again']);
    } finally { await act(async () => { tree.unmount(); }); }
  });
});

describe('ChatInput · selected seat removed by the server', () => {
  test('unknown-seat for the selected chip clears the hidden selection and returns to ordinary chat', async () => {
    const chats: string[] = [];
    const calls: Array<{ seat?: string; text: string }> = [];
    let serverSeats = [{ id: 'MK', title: 'CMO' }, { id: 'OP', title: 'COO' }];
    const client = {
      listSeatRequests: async () => ({ items: [], seats: serverSeats }),
      submitSeatRequest: async (request: { seat?: string; text: string }) => {
        calls.push(request);
        throw new SeatRequestError(400, 'unknown-seat', serverSeats);
      },
    };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {} };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={(text) => chats.push(text)} /></DaemonContext.Provider>); });
    const type = async (text: string) => { await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: text } }); }); };
    const send = async () => { await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); }); };
    try {
      await act(async () => { tree.root.findAllByType('button').find((button) => button.props['aria-pressed'] === false)!.props.onClick(); });
      serverSeats = [{ id: 'OP', title: 'COO' }];
      await type('for the removed seat'); await send();
      expect(calls).toEqual([{ seat: 'MK', text: 'for the removed seat' }]);
      expect(tree.root.findAllByType('button').some((button) => button.props['aria-pressed'] === true)).toBe(false);
      await type('ordinary after'); await send();
      expect(chats).toEqual(['ordinary after']);
      expect(calls).toHaveLength(1);
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

describe('ChatInput · R2 voice-intake wire', () => {
  test('imports ShowroomVoiceIntake from the showroom surface', () => {
    expect(CHAT_INPUT_SRC).toMatch(
      /import\s*\{\s*ShowroomVoiceIntake\s*\}\s*from\s*['"]@\/components\/showroom\/ShowroomVoiceIntake['"]/,
    );
  });

  test('mounts <ShowroomVoiceIntake /> inside the attach button row', () => {
    // Look for the mount in the attach-button cluster (next to
    // CameraAttachButton + FileAttachButton). The exact JSX is
    // self-closing without props.
    expect(CHAT_INPUT_SRC).toMatch(/<ShowroomVoiceIntake\s*\/>/);
  });

  test('voice-intake mount is co-located with camera/file attach buttons', () => {
    // Order: Camera, File, then voice intake — co-location guarantees
    // the intake mic shares the attach-affordance affordance group.
    const camIdx = CHAT_INPUT_SRC.indexOf('<CameraAttachButton');
    const fileIdx = CHAT_INPUT_SRC.indexOf('<FileAttachButton');
    const voiceIdx = CHAT_INPUT_SRC.indexOf('<ShowroomVoiceIntake');
    expect(camIdx).toBeGreaterThan(0);
    expect(fileIdx).toBeGreaterThan(camIdx);
    expect(voiceIdx).toBeGreaterThan(fileIdx);
  });
});

describe('ChatInput · R-OCR.2.1 SaveAsNoteButton wire', () => {
  test('imports SaveAsNoteButton from the notes surface', () => {
    expect(CHAT_INPUT_SRC).toMatch(
      /import\s*\{\s*SaveAsNoteButton\s*\}\s*from\s*['"]@\/components\/notes\/SaveAsNoteButton['"]/,
    );
  });

  test('mounts <SaveAsNoteButton /> inside the attach button row', () => {
    expect(CHAT_INPUT_SRC).toMatch(/<SaveAsNoteButton\s*\/>/);
  });

  test('SaveAsNoteButton is co-located with camera/file/voice cluster', () => {
    // Sits between the file attach button and the voice intake mic so
    // the four affordances form one visual cluster.
    const fileIdx = CHAT_INPUT_SRC.indexOf('<FileAttachButton');
    const noteIdx = CHAT_INPUT_SRC.indexOf('<SaveAsNoteButton');
    const voiceIdx = CHAT_INPUT_SRC.indexOf('<ShowroomVoiceIntake');
    expect(fileIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeGreaterThan(fileIdx);
    expect(voiceIdx).toBeGreaterThan(noteIdx);
  });
});
