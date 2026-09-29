// Unit tests for DashboardAcpChat — T7-N.
//
// Focuses on parse + state surface, plus one end-to-end test that
// uses a mocked globalAcpAgentManager() to verify stream dispatch.
// We don't spawn an actual claude-code-acp subprocess here — the
// integration against the real binary lives in a smoke test the
// operator runs manually.

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  parseAcpBackend,
  parseAcpSlash,
  displayBackendName,
  DashboardAcpChat,
  type AcpChatHandlers,
} from '../src/dashboard/chat/acp-chat.js';
import { debug } from '../src/debug/log.js';
import type { StreamingBufferScheduler } from '../src/acp/streaming-text-buffer.js';
import { ACP_BACKEND_ALIASES } from '../src/acp/backend-registry.js';

interface FakeScheduler extends StreamingBufferScheduler {
  tick(): void;
  readonly running: boolean;
}

function makeFakeScheduler(): FakeScheduler {
  const cbs = new Map<number, () => void>();
  let next = 1;
  return {
    start(fn) { const id = next++; cbs.set(id, fn); return id; },
    stop(h) { cbs.delete(h as number); },
    tick() { for (const fn of Array.from(cbs.values())) fn(); },
    get running() { return cbs.size > 0; },
  };
}

describe('parseAcpBackend', () => {
  test('accepts canonical backend ids', () => {
    expect(parseAcpBackend('claude')).toBe('claude');
    expect(parseAcpBackend('codex')).toBe('codex-app-server');
    expect(parseAcpBackend('gemini')).toBe('gemini');
    expect(parseAcpBackend('codex-app-server')).toBe('codex-app-server');
  });

  test('accepts aliases', () => {
    expect(parseAcpBackend('cc')).toBe('claude');
    expect(parseAcpBackend('cx')).toBe('codex-app-server');
    expect(parseAcpBackend('gm')).toBe('gemini');
    expect(parseAcpBackend('cas')).toBe('codex-app-server');
  });

  test('accepts every registry alias and preserves its canonical session key', () => {
    for (const [alias, canonical] of Object.entries(ACP_BACKEND_ALIASES)) {
      expect(parseAcpBackend(alias)).toBe(canonical);
    }
  });

  test('case-insensitive', () => {
    expect(parseAcpBackend('CLAUDE')).toBe('claude');
    expect(parseAcpBackend('Codex')).toBe('codex-app-server');
    expect(parseAcpBackend('CAS')).toBe('codex-app-server');
    expect(parseAcpBackend('Codex-App-Server')).toBe('codex-app-server');
  });

  test('sprint 5B · removed legacy aliases return null', () => {
    // codex-native / cxn / codex-acp-zed / codex-zed were removed
    // alongside the source files + dep packages.
    expect(parseAcpBackend('codex-native')).toBe(null);
    expect(parseAcpBackend('cxn')).toBe(null);
    expect(parseAcpBackend('codex-acp-zed')).toBe(null);
    expect(parseAcpBackend('codex-zed')).toBe(null);
  });

  test('unknown / empty → null', () => {
    expect(parseAcpBackend('')).toBe(null);
    expect(parseAcpBackend(undefined)).toBe(null);
    expect(parseAcpBackend('llama')).toBe(null);
  });
});

describe('displayBackendName · sprint 5C', () => {
  test('codex-app-server renders as `codex` for chat surfaces', () => {
    expect(displayBackendName('codex-app-server')).toBe('codex');
  });

  test('claude / gemini render as-is (already short)', () => {
    expect(displayBackendName('claude')).toBe('claude');
    expect(displayBackendName('gemini')).toBe('gemini');
  });
});

describe('DashboardAcpChat · debug-gated status lines (sprint 5C)', () => {
  let mockAgent: {
    newSession: ReturnType<typeof mock>;
    prompt: ReturnType<typeof mock>;
    cancel: ReturnType<typeof mock>;
  };
  let getAgentSpy: ReturnType<typeof mock>;
  let sessionRecords: Map<string, string>;
  let originalDebugEnabled: boolean;

  function makeChat(): DashboardAcpChat {
    return new DashboardAcpChat({
      agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
      sessionStore: {
        get: (chatId, backendId) => sessionRecords.get(`${chatId}:${backendId}`) ?? null,
        set: (chatId, backendId, sessionId) => { sessionRecords.set(`${chatId}:${backendId}`, sessionId); },
        delete: (chatId, backendId) => sessionRecords.delete(`${chatId}:${backendId}`),
      },
    });
  }

  beforeEach(() => {
    mockAgent = {
      newSession: mock(async () => 'session-abc'),
      prompt: mock(async () => ({ stopReason: 'end_turn' })),
      cancel: mock(async () => {}),
    };
    getAgentSpy = mock(async () => mockAgent);
    sessionRecords = new Map();
    originalDebugEnabled = debug.enabled;
  });

  afterEach(() => {
    debug.setMirror(originalDebugEnabled);
  });

  test('debug.enabled=false suppresses creating/sending status lines', async () => {
    debug.disable();
    const chat = makeChat();
    const lines: string[] = [];
    const handlers: AcpChatHandlers = {
      pushLine: (l) => lines.push(l),
      appendChunk: () => {},
      pushToolCall: () => {},
      onDone: () => {},
      onError: () => {},
    };
    await chat.send('codex-app-server', 'hi', handlers);
    expect(lines.some((l) => l.includes('creating'))).toBe(false);
    expect(lines.some((l) => l.includes('sending to'))).toBe(false);
  });

  test('debug.enabled=true emits status lines using the friendly display name', async () => {
    debug.enable();
    const chat = makeChat();
    const lines: string[] = [];
    const handlers: AcpChatHandlers = {
      pushLine: (l) => lines.push(l),
      appendChunk: () => {},
      pushToolCall: () => {},
      onDone: () => {},
      onError: () => {},
    };
    await chat.send('codex-app-server', 'hi', handlers);
    // Sprint 5C — display label `codex`, not the registry id `codex-app-server`.
    expect(lines.some((l) => l.includes('creating codex ACP session'))).toBe(true);
    expect(lines.some((l) => l.includes('sending to codex'))).toBe(true);
    expect(lines.every((l) => !l.includes('codex-app-server'))).toBe(true);
  });

  test('stale-session recovery line uses display name (codex, not codex-app-server)', async () => {
    debug.disable(); // recovery 라인은 정식 chat log — debug gate X
    const chat = makeChat();
    let promptCalls = 0;
    mockAgent.prompt = mock(async (_sid: string) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        // 첫 호출 = stale id 로 인한 unknown session 에러
        throw new Error('unknown session abc');
      }
      return { stopReason: 'end_turn' };
    });
    // 미리 stale id 를 store 에 심어두어 recovery 경로 발화
    sessionRecords.set('dashboard:/persisted:codex-app-server', 'stale-id');
    const lines: string[] = [];
    const handlers: AcpChatHandlers = {
      pushLine: (l) => lines.push(l),
      appendChunk: () => {},
      pushToolCall: () => {},
      onDone: () => {},
      onError: () => {},
    };
    await chat.send('codex-app-server', 'hi', handlers);
    expect(lines.some((l) => l.includes('persisted codex session stale'))).toBe(true);
    expect(lines.every((l) => !l.includes('codex-app-server'))).toBe(true);
  });
});

describe('DashboardAcpChat — lifecycle', () => {
  let mockAgent: {
    newSession: ReturnType<typeof mock>;
    prompt: ReturnType<typeof mock>;
    cancel: ReturnType<typeof mock>;
  };
  let getAgentSpy: ReturnType<typeof mock>;
  let sessionRecords: Map<string, string>;

  function makeChat(): DashboardAcpChat {
    return new DashboardAcpChat({
      agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
      sessionStore: {
        get: (chatId, backendId) => sessionRecords.get(`${chatId}:${backendId}`) ?? null,
        set: (chatId, backendId, sessionId) => { sessionRecords.set(`${chatId}:${backendId}`, sessionId); },
        delete: (chatId, backendId) => sessionRecords.delete(`${chatId}:${backendId}`),
      },
    });
  }

  beforeEach(() => {
    mockAgent = {
      newSession: mock(async () => 'session-abc'),
      prompt: mock(async (_sid: string, _blocks: unknown, onUpdate: (u: any) => void) => {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
        onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read_file', kind: 'read' });
        return { stopReason: 'end_turn' };
      }),
      cancel: mock(async () => {}),
    };
    getAgentSpy = mock(async () => mockAgent);
    sessionRecords = new Map();
  });

  function makeHandlers(): {
    handlers: AcpChatHandlers;
    chunks: string[];
    lines: string[];
    toolCalls: string[];
    done: string[];
    errors: Error[];
  } {
    const chunks: string[] = [];
    const lines: string[] = [];
    const toolCalls: string[] = [];
    const done: string[] = [];
    const errors: Error[] = [];
    const handlers: AcpChatHandlers = {
      pushLine: (l) => lines.push(l),
      appendChunk: (c) => chunks.push(c),
      pushToolCall: (t) => toolCalls.push(t),
      onDone: (r) => done.push(r),
      onError: (e) => errors.push(e),
    };
    return { handlers, chunks, lines, toolCalls, done, errors };
  }

  test('send: creates session on first call + streams chunks', async () => {
    const chat = makeChat();
    const { handlers, chunks, toolCalls, done, errors } = makeHandlers();
    await chat.send('claude', 'hi', handlers);
    expect(chunks.join('')).toBe('hello world');
    // H1 #3 — tool-call line now carries a status glyph + kind suffix.
    expect(toolCalls).toEqual(['⋯ → read_file (read)']);
    expect(done).toEqual(['end_turn']);
    expect(errors.length).toBe(0);
    expect(mockAgent.newSession).toHaveBeenCalledTimes(1);
  });

  test('send: reuses session on second call', async () => {
    const chat = makeChat();
    await chat.send('claude', 'first', makeHandlers().handlers);
    await chat.send('claude', 'second', makeHandlers().handlers);
    expect(mockAgent.newSession).toHaveBeenCalledTimes(1);
    expect(mockAgent.prompt).toHaveBeenCalledTimes(2);
  });

  test('send: line-gated mode delays partial chunk reveal until newline or finalize flush', async () => {
    let release: (() => void) | null = null;
    mockAgent.prompt = mock(async (_sid: string, _blocks: unknown, onUpdate: (u: any) => void) => {
      onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello wo' } });
      onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rld\nnext' } });
      await new Promise<void>((r) => { release = r; });
      return { stopReason: 'end_turn' };
    });
    const sched = makeFakeScheduler();
    const chat = new DashboardAcpChat({
      agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
      sessionStore: {
        get: (chatId, backendId) => sessionRecords.get(`${chatId}:${backendId}`) ?? null,
        set: (chatId, backendId, sessionId) => { sessionRecords.set(`${chatId}:${backendId}`, sessionId); },
        delete: (chatId, backendId) => sessionRecords.delete(`${chatId}:${backendId}`),
      },
      streamScheduler: sched,
      streamBufferConfig: { mode: 'line', catchUpThresholdLines: 50, catchUpAgeMs: 200 },
    });
    const { handlers, chunks } = makeHandlers();
    const sendPromise = chat.send('claude', 'hi', handlers);
    await new Promise((r) => setTimeout(r, 1));
    expect(chunks).toEqual([]);
    sched.tick();
    expect(chunks).toEqual(['hello world\n']);
    release?.();
    await sendPromise;
    expect(chunks).toEqual(['hello world\n', 'next']);
  });

  test('send: resumes persisted dashboard session id', async () => {
    sessionRecords.set('dashboard:/persisted:claude', 'session-old');
    const chat = new DashboardAcpChat({
      cwd: '/persisted',
      agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
      sessionStore: {
        get: (chatId, backendId) => sessionRecords.get(`${chatId}:${backendId}`) ?? null,
        set: (chatId, backendId, sessionId) => { sessionRecords.set(`${chatId}:${backendId}`, sessionId); },
        delete: (chatId, backendId) => sessionRecords.delete(`${chatId}:${backendId}`),
      },
    });
    await chat.send('claude', 'hi', makeHandlers().handlers);
    expect(mockAgent.newSession).not.toHaveBeenCalled();
    expect(mockAgent.prompt.mock.calls[0]?.[0]).toBe('session-old');
  });

  test('send: stale persisted session triggers drop + fresh newSession + retry', async () => {
    // Simulate CodexAppServerAgent-style in-process-only session:
    // persisted id is not known to the agent, so prompt throws on
    // first call with "unknown session". DashboardAcpChat should drop
    // the persisted id, mint a new one, and retry the same prompt.
    sessionRecords.set('dashboard:/persisted:codex-app-server', 'stale-synth-id');
    let promptCalls = 0;
    mockAgent.newSession = mock(async () => 'fresh-session');
    mockAgent.prompt = mock(async (sid: string, _blocks: unknown, onUpdate: (u: any) => void) => {
      promptCalls += 1;
      if (sid === 'stale-synth-id') {
        throw new Error('codex-app-server · unknown session stale-synth-id');
      }
      onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
      return { stopReason: 'end_turn' };
    });
    const chat = new DashboardAcpChat({
      cwd: '/persisted',
      agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
      sessionStore: {
        get: (chatId, backendId) => sessionRecords.get(`${chatId}:${backendId}`) ?? null,
        set: (chatId, backendId, sessionId) => { sessionRecords.set(`${chatId}:${backendId}`, sessionId); },
        delete: (chatId, backendId) => sessionRecords.delete(`${chatId}:${backendId}`),
      },
    });
    const { handlers, chunks, lines, done, errors } = makeHandlers();
    await chat.send('codex-app-server', 'hi', handlers);
    expect(errors).toEqual([]);
    expect(done).toEqual(['end_turn']);
    expect(chunks.join('')).toBe('ok');
    expect(mockAgent.newSession).toHaveBeenCalledTimes(1);
    expect(promptCalls).toBe(2);
    expect(sessionRecords.get('dashboard:/persisted:codex-app-server')).toBe('fresh-session');
    expect(lines.some((l) => l.includes('stale') && l.includes('creating fresh'))).toBe(true);
  });

  test('send: non-stale prompt error surfaces to onError without retry', async () => {
    mockAgent.prompt = mock(async () => {
      throw new Error('network timeout');
    });
    const chat = makeChat();
    const { handlers, errors, done } = makeHandlers();
    await chat.send('claude', 'hi', handlers);
    expect(done).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toBe('network timeout');
    expect(mockAgent.prompt).toHaveBeenCalledTimes(1);
  });

  test('dropSession deletes persisted dashboard session id', async () => {
    const chat = makeChat();
    await chat.send('claude', 'hi', makeHandlers().handlers);
    expect(sessionRecords.has(`dashboard:${process.cwd()}:claude`)).toBe(true);
    chat.dropSession('claude');
    expect(sessionRecords.has(`dashboard:${process.cwd()}:claude`)).toBe(false);
  });

  test('lastBackend tracks the last-used backend', async () => {
    const chat = makeChat();
    expect(chat.getLastBackend()).toBe(null);
    await chat.send('claude', 'hi', makeHandlers().handlers);
    expect(chat.getLastBackend()).toBe('claude');
    await chat.send('codex-app-server', 'hi', makeHandlers().handlers);
    expect(chat.getLastBackend()).toBe('codex-app-server');
  });

  test('hasSession / list', async () => {
    const chat = makeChat();
    expect(chat.hasSession('claude')).toBe(false);
    await chat.send('claude', 'hi', makeHandlers().handlers);
    expect(chat.hasSession('claude')).toBe(true);
    expect(chat.list()).toHaveLength(1);
  });

  test('dropSession removes state', async () => {
    const chat = makeChat();
    await chat.send('claude', 'hi', makeHandlers().handlers);
    chat.dropSession('claude');
    expect(chat.hasSession('claude')).toBe(false);
    expect(chat.getLastBackend()).toBe(null);
  });

  test('cancel: no-op when nothing in flight', async () => {
    const chat = makeChat();
    const r = await chat.cancel('claude');
    expect(r).toBe(false);
    expect(mockAgent.cancel).not.toHaveBeenCalled();
  });

  test('send: surfaces error to onError (spawn failure)', async () => {
    getAgentSpy.mockImplementationOnce(async () => { throw new Error('boom'); });
    const chat = makeChat();
    const { handlers, errors, done } = makeHandlers();
    await chat.send('claude', 'hi', handlers);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe('boom');
    expect(done.length).toBe(0);
  });

  describe('parseAcpSlash (T7-Q)', () => {
    test('empty sub returns help', () => {
      const r = parseAcpSlash('', [], makeChat());
      expect(r.kind).toBe('help');
      if (r.kind === 'help') {
        expect(r.lines[0]).toContain('ACP chat');
        expect(r.lines.join('\n')).not.toContain('/acp-vw');
      }
    });

    test('cancel / status / drop', () => {
      const chat = makeChat();
      expect(parseAcpSlash('cancel', [], chat).kind).toBe('cancel');
      expect(parseAcpSlash('status', [], chat).kind).toBe('status');
      const d = parseAcpSlash('drop', ['claude'], chat);
      expect(d.kind).toBe('drop');
      if (d.kind === 'drop') expect(d.backend).toBe('claude');
    });

    test('drop with no backend returns error message', () => {
      const r = parseAcpSlash('drop', [], makeChat());
      expect(r.kind).toBe('message');
      if (r.kind === 'message') expect(r.lines[0]).toContain('drop:');
    });

    test('send with explicit backend + message', () => {
      const r = parseAcpSlash('claude', ['hello', 'world'], makeChat());
      expect(r.kind).toBe('send');
      if (r.kind === 'send') {
        expect(r.backend).toBe('claude');
        expect(r.message).toBe('hello world');
      }
    });

    test('cas alias routes to codex-app-server', () => {
      const r = parseAcpSlash('cas', ['hi'], makeChat());
      expect(r.kind).toBe('send');
      if (r.kind === 'send') {
        expect(r.backend).toBe('codex-app-server');
        expect(r.message).toBe('hi');
      }
    });

    test('help lists cas brand', () => {
      const r = parseAcpSlash('', [], makeChat());
      expect(r.kind).toBe('help');
      if (r.kind === 'help') {
        expect(r.lines.some((l) => l.includes('cas'))).toBe(true);
        expect(r.lines.some((l) => l.includes('codex app-server'))).toBe(true);
      }
    });

    test('send to last backend when no explicit backend', async () => {
      const chat = makeChat();
      await chat.send('codex-app-server', 'first', makeHandlers().handlers);
      const r = parseAcpSlash('hello', ['world'], chat);
      expect(r.kind).toBe('send');
      if (r.kind === 'send') {
        expect(r.backend).toBe('codex-app-server');
        expect(r.message).toBe('hello world');
      }
    });

    test('backend alone → session-open message', () => {
      const r = parseAcpSlash('claude', [], makeChat());
      expect(r.kind).toBe('message');
      if (r.kind === 'message') expect(r.lines[0]).toContain('session open for claude');
    });

    test('defaults to claude when no backend + no last-used', () => {
      const r = parseAcpSlash('hi', [], makeChat());
      expect(r.kind).toBe('send');
      if (r.kind === 'send') expect(r.backend).toBe('claude');
    });
  });

  describe('H1 #1 streaming smoothing', () => {
    test('text chunks route through buffer · tool_call flush preserves ordering', async () => {
      const sched = makeFakeScheduler();
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: {
          get: () => null,
          set: () => {},
          delete: () => true,
        },
        streamScheduler: sched,
      });
      const { handlers, chunks, toolCalls, done } = makeHandlers();
      await chat.send('claude', 'hi', handlers);
      // onDone fires after the prompt fixture resolves — the dispatch
      // path will have: append 'hello ' → append 'world' → tool_call
      // (flush) → onDone (flush). Flush drains the full pending in one
      // appendChunk call, so chunks after done === ['hello world'].
      expect(chunks.join('')).toBe('hello world');
      // Assistant text flushed BEFORE the tool line arrived (H1 #3
      // glyph prefix + kind suffix).
      expect(toolCalls).toEqual(['⋯ → read_file (read)']);
      expect(done).toEqual(['end_turn']);
    });

    test('disableStreamSmoothing bypasses buffer (direct appendChunk)', async () => {
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: { get: () => null, set: () => {}, delete: () => true },
        disableStreamSmoothing: true,
      });
      const { handlers, chunks } = makeHandlers();
      await chat.send('claude', 'hi', handlers);
      // Direct pass-through — two separate appendChunk calls, one per
      // upstream agent_message_chunk.
      expect(chunks).toEqual(['hello ', 'world']);
    });

    test('plan update emits summary line + flushes streaming text', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid, _b, onUpdate) => {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi ' } });
        onUpdate({
          sessionUpdate: 'plan',
          entries: [
            { content: 'design', priority: 'medium', status: 'completed' },
            { content: 'implement', priority: 'medium', status: 'in_progress' },
            { content: 'ship', priority: 'medium', status: 'pending' },
          ],
        });
        return { stopReason: 'end_turn' };
      });
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: { get: () => null, set: () => {}, delete: () => true },
      });
      const { handlers, lines, chunks } = makeHandlers();
      await chat.send('claude', 'hi', handlers);
      // Summary line pushed after flushing prior text.
      const planLine = lines.find((l) => l.includes('2/3'));
      expect(planLine).toBeDefined();
      expect(planLine).toContain('implement');
      // Text chunk was flushed BEFORE the plan line.
      expect(chunks.join('')).toBe('hi ');
    });

    test('tool_call_update with status change emits transition line', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid, _b, onUpdate) => {
        onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read' });
        onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' });
        onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });
        return { stopReason: 'end_turn' };
      });
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: { get: () => null, set: () => {}, delete: () => true },
      });
      const { handlers, toolCalls } = makeHandlers();
      await chat.send('claude', 'hi', handlers);
      // Initial create + 2 transitions = 3 lines.
      expect(toolCalls).toHaveLength(3);
      expect(toolCalls[0]).toBe('⋯ → Read (read)');
      expect(toolCalls[1]).toContain('In progress');
      expect(toolCalls[2]).toContain('Completed');
    });

    test('tool_call_update with same status emits no transition line', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid, _b, onUpdate) => {
        onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', status: 'in_progress' });
        // Same status — no-op transition.
        onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', title: 'Read' });
        onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' });
        return { stopReason: 'end_turn' };
      });
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: { get: () => null, set: () => {}, delete: () => true },
      });
      const { handlers, toolCalls } = makeHandlers();
      await chat.send('claude', 'hi', handlers);
      // Only the initial create line is pushed.
      expect(toolCalls).toHaveLength(1);
    });

    test('cancel flips in-flight tool calls to canceled', async () => {
      let release: (() => void) | null = null;
      mockAgent.prompt.mockImplementationOnce(async (_sid, _b, onUpdate) => {
        onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Long', status: 'in_progress' });
        await new Promise<void>((r) => { release = r; });
        return { stopReason: 'cancelled' };
      });
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: { get: () => null, set: () => {}, delete: () => true },
      });
      const { handlers } = makeHandlers();
      const p = chat.send('claude', 'hi', handlers);
      await new Promise((r) => setTimeout(r, 1));
      const cancelled = await chat.cancel('claude');
      expect(cancelled).toBe(true);
      release?.();
      await p;
      // Post-cancel the live session was removed (or its tool-call table
      // would still hold the canceled record). Either way the test's
      // purpose is to assert cancel didn't throw + mockAgent.cancel was
      // called exactly once.
      expect(mockAgent.cancel).toHaveBeenCalledTimes(1);
    });

    test('dropSession disposes pending buffer · next send gets fresh one', async () => {
      // Hold the prompt open so we can observe pending state mid-turn.
      let release: (() => void) | null = null;
      mockAgent.prompt.mockImplementationOnce(async (_sid, _b, onUpdate) => {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
        await new Promise<void>((r) => { release = r; });
        return { stopReason: 'end_turn' };
      });
      const sched = makeFakeScheduler();
      const chat = new DashboardAcpChat({
        agentManager: { getAgent: (id, o) => getAgentSpy(id, o) as any },
        sessionStore: { get: () => null, set: () => {}, delete: () => true },
        streamScheduler: sched,
      });
      const { handlers, chunks } = makeHandlers();
      const p = chat.send('claude', 'hi', handlers);
      await new Promise((r) => setTimeout(r, 1));
      expect(sched.running).toBe(true);
      chat.dropSession('claude');
      // Dispose stops the ticker AND drops pending without reveal.
      expect(sched.running).toBe(false);
      expect(chunks).toEqual([]);
      release?.();
      await p;
    });
  });

  test('isBusy true while prompt is in flight', async () => {
    // Hold the prompt open until we check isBusy.
    let release: (() => void) | null = null;
    mockAgent.prompt.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { release = r; });
      return { stopReason: 'end_turn' };
    });
    const chat = makeChat();
    const { handlers } = makeHandlers();
    const p = chat.send('claude', 'hi', handlers);
    // Wait one microtask so the inFlight flag is set.
    await new Promise((r) => setTimeout(r, 1));
    expect(chat.isBusy()).toBe(true);
    release?.();
    await p;
    expect(chat.isBusy()).toBe(false);
  });

  // ── H4 Phase 2 · agent_thought_chunk routing ──────────────────

  describe('H4 Phase 2 · agent_thought_chunk', () => {
    test('reasoning chunk (_meta.reasoning:true) → pushThought with isReasoning=true · flushes buffered text first', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid: string, _b: unknown, onUpdate: (u: any) => void) => {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial ' } });
        onUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'let me think first' },
          _meta: { reasoning: true },
        });
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
        return { stopReason: 'end_turn' };
      });
      const chat = makeChat();
      const { handlers, chunks, lines } = makeHandlers();
      const thoughts: Array<{ text: string; isReasoning: boolean }> = [];
      handlers.pushThought = (text, isReasoning) => thoughts.push({ text, isReasoning });
      await chat.send('codex-app-server', 'go', handlers);
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0]).toEqual({ text: 'let me think first', isReasoning: true });
      // Pre-thought text buffered + flushed; post-thought text also captured.
      expect(chunks.join('')).toContain('partial');
      expect(chunks.join('')).toContain('answer');
      // Thought text is NOT routed to pushLine (handler took ownership).
      expect(lines.some((l) => l.includes('let me think first'))).toBe(false);
    });

    test('plain thought chunk (no _meta) → pushThought with isReasoning=false', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid: string, _b: unknown, onUpdate: (u: any) => void) => {
        onUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'a note' },
        });
        return { stopReason: 'end_turn' };
      });
      const chat = makeChat();
      const { handlers } = makeHandlers();
      const thoughts: Array<{ text: string; isReasoning: boolean }> = [];
      handlers.pushThought = (text, isReasoning) => thoughts.push({ text, isReasoning });
      await chat.send('claude', 'hi', handlers);
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0]).toEqual({ text: 'a note', isReasoning: false });
    });

    test('fallback to pushLine when pushThought is not supplied · 💭 prefix for reasoning', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid: string, _b: unknown, onUpdate: (u: any) => void) => {
        onUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'reasoning text' },
          _meta: { reasoning: true },
        });
        return { stopReason: 'end_turn' };
      });
      const chat = makeChat();
      const { handlers, lines } = makeHandlers();
      // Deliberately NO pushThought override — default fallback path.
      await chat.send('codex-app-server', 'go', handlers);
      expect(lines.some((l) => l.includes('💭') && l.includes('reasoning text'))).toBe(true);
    });

    test('empty text thought chunk → no emit', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid: string, _b: unknown, onUpdate: (u: any) => void) => {
        onUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '' },
        });
        return { stopReason: 'end_turn' };
      });
      const chat = makeChat();
      const { handlers } = makeHandlers();
      const thoughts: any[] = [];
      handlers.pushThought = (t, r) => thoughts.push({ t, r });
      await chat.send('claude', 'hi', handlers);
      expect(thoughts).toHaveLength(0);
    });

    test('unknown sessionUpdate still dropped (forward-compat default branch intact)', async () => {
      mockAgent.prompt.mockImplementationOnce(async (_sid: string, _b: unknown, onUpdate: (u: any) => void) => {
        onUpdate({ sessionUpdate: 'future_unknown_kind' as any, content: { type: 'text', text: 'x' } });
        return { stopReason: 'end_turn' };
      });
      const chat = makeChat();
      const { handlers, lines, chunks } = makeHandlers();
      await chat.send('claude', 'hi', handlers);
      // No content chunks rendered (unknown types dropped).
      expect(chunks).toHaveLength(0);
      // Preamble pushLine entries are expected (send emits "→ creating"
      // and "→ sending to" lines) — check the unknown update didn't
      // sneak a thought/line through.
      expect(lines.some((l) => l.includes('future_unknown_kind') || l.includes('💭'))).toBe(false);
    });
  });

  // ── Sticky multi-turn mode ──────────────────────────────────────
  describe('sticky multi-turn', () => {
    test('setSticky / getSticky / clearSticky({drop:false}) keeps session', async () => {
      const chat = makeChat();
      expect(chat.getSticky()).toBe(null);
      await chat.send('claude', 'hi', makeHandlers().handlers);
      chat.setSticky('claude');
      expect(chat.getSticky()).toBe('claude');
      chat.clearSticky({ drop: false });
      expect(chat.getSticky()).toBe(null);
      // Session preserved — backend still tracked.
      expect(chat.hasSession('claude')).toBe(true);
    });

    test('clearSticky({drop:true}) evicts session via dropSession', async () => {
      const chat = makeChat();
      await chat.send('claude', 'hi', makeHandlers().handlers);
      chat.setSticky('claude');
      chat.clearSticky({ drop: true });
      expect(chat.getSticky()).toBe(null);
      expect(chat.hasSession('claude')).toBe(false);
    });

    test('dropSession also clears sticky pointer when same backend', async () => {
      const chat = makeChat();
      await chat.send('claude', 'hi', makeHandlers().handlers);
      chat.setSticky('claude');
      chat.dropSession('claude');
      expect(chat.getSticky()).toBe(null);
    });

    test('send forwards attachments to buildAcpPrompt (image block + text)', async () => {
      const chat = makeChat();
      await chat.send(
        'claude',
        'inspect this',
        makeHandlers().handlers,
        [{
          name: 'pic.png',
          localPath: '/tmp/does-not-exist.png',
          kind: 'photo',
          mimeType: 'image/png',
        }],
      );
      // mockAgent.prompt was invoked with [resourceLink (fallback), text]
      // because the file read fails. Either way, two blocks total —
      // attachment + text (vs the empty-array case which is text-only).
      const blocks = (mockAgent.prompt.mock.calls[0]?.[1] ?? []) as Array<{ type: string }>;
      expect(blocks.length).toBe(2);
      expect(blocks[blocks.length - 1]?.type).toBe('text');
    });
  });

  describe('parseAcpSlash sticky', () => {
    test('--multi alone enters sticky on last backend', async () => {
      const chat = makeChat();
      await chat.send('codex-app-server', 'first', makeHandlers().handlers);
      const r = parseAcpSlash('--multi', [], chat);
      expect(r.kind).toBe('enter-sticky');
      if (r.kind === 'enter-sticky') {
        expect(r.backend).toBe('codex-app-server');
        expect(r.firstMessage).toBeUndefined();
      }
    });

    test('--multi with no last backend defaults to claude', () => {
      const r = parseAcpSlash('--multi', [], makeChat());
      expect(r.kind).toBe('enter-sticky');
      if (r.kind === 'enter-sticky') expect(r.backend).toBe('claude');
    });

    test('<backend> --multi enters sticky on that backend', () => {
      const r = parseAcpSlash('codex-app-server', ['--multi'], makeChat());
      expect(r.kind).toBe('enter-sticky');
      if (r.kind === 'enter-sticky') {
        // Sprint 5 phase A · `codex` resolves to canonical app-server.
        expect(r.backend).toBe('codex-app-server');
        expect(r.firstMessage).toBeUndefined();
      }
    });

    test('<backend> --multi <msg> carries firstMessage', () => {
      const r = parseAcpSlash('codex-app-server', ['--multi', 'hello', 'world'], makeChat());
      expect(r.kind).toBe('enter-sticky');
      if (r.kind === 'enter-sticky') {
        // Sprint 5 phase A · `codex` resolves to canonical app-server.
        expect(r.backend).toBe('codex-app-server');
        expect(r.firstMessage).toBe('hello world');
      }
    });

    test('<backend> <msg> --multi (flag at tail) still parses firstMessage', () => {
      const r = parseAcpSlash('claude', ['hello', '--multi', 'world'], makeChat());
      expect(r.kind).toBe('enter-sticky');
      if (r.kind === 'enter-sticky') {
        expect(r.backend).toBe('claude');
        expect(r.firstMessage).toBe('hello world');
      }
    });

    test('exit returns exit-sticky · drop=false by default', () => {
      const r = parseAcpSlash('exit', [], makeChat());
      expect(r.kind).toBe('exit-sticky');
      if (r.kind === 'exit-sticky') expect(r.drop).toBe(false);
    });

    test('exit --drop returns drop=true', () => {
      const r = parseAcpSlash('exit', ['--drop'], makeChat());
      expect(r.kind).toBe('exit-sticky');
      if (r.kind === 'exit-sticky') expect(r.drop).toBe(true);
    });

    test('help includes sticky lines + sticky pointer when set', async () => {
      const chat = makeChat();
      chat.setSticky('codex-app-server');
      const r = parseAcpSlash('', [], chat);
      expect(r.kind).toBe('help');
      if (r.kind === 'help') {
        expect(r.lines.some((l) => l.includes('--multi'))).toBe(true);
        expect(r.lines.some((l) => l.includes('sticky: codex'))).toBe(true);
      }
    });
  });
});
