// ── Session-aware chat helper tests ──
//
// Provider is mocked — we inject a fake LLMProvider that yields a
// scripted set of text deltas. No network, no real API. Session store
// is redirected to a tmp XDG_DATA_HOME.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunTurnSession, runTurn, ensureCliSession, sessionBudget } from '../src/session/chat';
import { loadSession } from '../src/session/index';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import type { UserConfig } from '../src/user-config';
import { buildTerminalCapableTurn, PTY_BUDGET_GRANT, TERMINAL_MISSION_DISCIPLINE } from '../src/agent/terminal-surface';
import { _resetUserIntentLogger } from '../src/user-intent/logger';
import { resetPauseFlag } from '../src/turn-checkpoint/index';
import type { UserIntentEvent } from '../src/user-intent/types';

let root: string;
let intentEvents: UserIntentEvent[];

function baseConfig(): UserConfig {
  return {
    skillRouter: {
      autoRoute: false, autoRouteCountdownMs: 1000, llmFallback: false,
      keywordScoreThreshold: 2, llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1, autoRouteRequireAutoTrigger: true,
    },
    llm: { provider: 'auto' },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: { enabled: false, allowedUsers: [] },
    onboarding: { completed: true, version: 1 },
    raw: {},
  };
}

function fakeProvider(replyParts: string[]): LLMProvider {
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async *chat(_messages, _opts) {
      for (const p of replyParts) yield p;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async *streamChat(_messages, _opts) {
      for (const p of replyParts) yield { type: 'text', delta: p };
    },
  };
}

beforeEach(() => {
  // runTurn pauses at a checkpoint when the process-wide `/pause` flag is set; a file that ran earlier in
  // the same bun process may have left it on (train #30519 shard-3: dashboard-slash-registry census).
  resetPauseFlag();
  root = mkdtempSync(join(tmpdir(), 'session-chat-'));
  process.env.XDG_DATA_HOME = root;
  process.env.XDG_STATE_HOME = join(root, '_state');
  // 메모리 스토어(surface_events·knowledge)는 XDG 가 아니라 ELANOUS_STATE_DIR 로 스코프됨
  //   (memory-db-path.ts). 격리 안 하면 runTurn 의 self-log 크로스 회상이 운영
  //   ~/.elanous/memory/surface_events.db 를 읽어 systemPrompt 에 실제 self-log 가 새어 든다.
  process.env.ELANOUS_STATE_DIR = join(root, '_elanous');
  intentEvents = [];
  _resetUserIntentLogger().setSinks([{
    name: 'capture',
    write: (event) => { intentEvents.push(event); },
  }]);
});
afterEach(() => {
  _resetUserIntentLogger();
  rmSync(root, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.ELANOUS_STATE_DIR;
});

describe('runTurn', () => {
  test('persists user + assistant, accumulates streamed deltas', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);
    const deltas: string[] = [];

    const result = await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'hello',
      provider: fakeProvider(['Hi ', 'there', '!']),
      onDelta: d => deltas.push(d),
    });

    expect(result.text).toBe('Hi there!');
    expect(deltas).toEqual(['Hi ', 'there', '!']);
    expect(result.meta.messageCount).toBe(2);

    const loaded = loadSession(session.id)!;
    expect(loaded.messages.length).toBe(2);
    expect(loaded.messages[0].role).toBe('user');
    expect(loaded.messages[0].content).toBe('hello');
    expect(loaded.messages[1].role).toBe('assistant');
    expect(loaded.messages[1].content).toBe('Hi there!');
  });

  test('emits the caller-provided utterance surface and preserves the intent payload', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);

    await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'from telegram',
      utteranceSurface: 'telegram',
      provider: fakeProvider(['ok']),
    });

    expect(intentEvents).toHaveLength(1);
    expect(intentEvents[0]).toMatchObject({
      surface: 'telegram',
      session_id: session.id,
      intent: {
        layer: 'utterance',
        kind: 'tui.utterance.chat_submit',
      },
    });
  });

  test('emits unknown when the caller does not declare an utterance surface', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);

    await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'unidentified origin',
      provider: fakeProvider(['ok']),
    });

    expect(intentEvents).toHaveLength(1);
    expect(intentEvents[0]).toMatchObject({
      surface: 'unknown',
      session_id: session.id,
      intent: {
        layer: 'utterance',
        kind: 'tui.utterance.chat_submit',
      },
    });
  });

  test('title auto-fills from first user turn', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);
    const result = await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'what is the weather today?',
      provider: fakeProvider(['Sunny.']),
    });
    expect(result.meta.title).toBe('what is the weather today?');
  });

  test('system prompt injected when session has none', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);
    let capturedSystem = '';
    const prov: LLMProvider = {
      name: 'fake', defaultModel: 'f', available: () => true,
      async *streamChat(messages) {
        const sys = messages.find(m => m.role === 'system');
        capturedSystem = typeof sys?.content === 'string' ? sys.content : '';
        yield { type: 'text', delta: 'ok' };
      },
      async *chat(messages) {
        const sys = messages.find(m => m.role === 'system');
        capturedSystem = typeof sys?.content === 'string' ? sys.content : '';
        yield 'ok';
      },
    };
    await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'x',
      systemPrompt: 'You are a helpful elanous.',
      provider: prov,
    });
    expect(capturedSystem).toBe('You are a helpful elanous.');
  });

  test('session missing → throws', async () => {
    const cfg = baseConfig();
    await expect(runTurn({
      userConfig: cfg,
      sessionId: 'nope-not-a-real-id',
      userText: 'x',
      provider: fakeProvider(['y']),
    })).rejects.toThrow(/session not found/);
  });

  test('userImages prepends image ContentBlocks to the latest user turn', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);
    let capturedLast: any = null;
    const prov: any = {
      name: 'fake', defaultModel: 'f', available: () => true,
      async *streamChat(messages: any[]) {
        capturedLast = messages[messages.length - 1];
        yield { type: 'text', delta: 'ok' };
      },
      async *chat(messages: any[]) {
        capturedLast = messages[messages.length - 1];
        yield 'ok';
      },
    };
    await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'describe this',
      userImages: [{ type: 'image', mediaType: 'image/png', base64: 'AAAA' }],
      provider: prov,
    });
    expect(capturedLast.role).toBe('user');
    expect(Array.isArray(capturedLast.content)).toBe(true);
    const blocks = capturedLast.content as any[];
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].mediaType).toBe('image/png');
    expect(blocks[blocks.length - 1]).toMatchObject({ type: 'text', text: 'describe this' });

    // JSONL persists a text summary only (no base64 bloat)
    const { loadSession } = await import('../src/session/index');
    const loaded = loadSession(session.id)!;
    const userEntry = loaded.messages[0];
    expect(userEntry.content).toMatch(/\[\+1 image\]/);
    expect(userEntry.content).toContain('describe this');
    expect(userEntry.content).not.toContain('AAAA');
  });

  test('multi-turn conversation persists full history', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);
    await runTurn({ userConfig: cfg, sessionId: session.id, userText: 'one', provider: fakeProvider(['first']) });
    await runTurn({ userConfig: cfg, sessionId: session.id, userText: 'two', provider: fakeProvider(['second']) });
    const loaded = loadSession(session.id)!;
    expect(loaded.messages.map(m => m.content)).toEqual(['one', 'first', 'two', 'second']);
  });

  test('applies terminal-capable turn wiring only when the runTurn tool list exposes PtyShell', async () => {
    const cfg = baseConfig();
    const terminalSession = ensureCliSession(cfg);
    let terminalDispatches = 0;
    let terminalSystem = '';
    const terminalProvider: LLMProvider = {
      name: 'terminal-scripted', defaultModel: 'd', available: () => true,
      async *streamChat(messages) {
        const sys = messages.find(m => m.role === 'system');
        terminalSystem = typeof sys?.content === 'string' ? sys.content : '';
        if (terminalDispatches === 0) {
          yield { type: 'tool_call', id: 'terminal-call', name: 'PtyShellStart', args: { command: 'pwd' } } as LLMStreamEvent;
        } else {
          yield { type: 'text', delta: 'terminal done' };
        }
      },
      async *chat() {},
    };

    const terminalResult = await runTurn({
      userConfig: cfg,
      sessionId: terminalSession.id,
      userText: 'use terminal',
      systemPrompt: 'base prompt',
      provider: terminalProvider,
      llmOpts: { maxTurns: 1 },
      tools: [{ name: 'PtyShellStart', description: 'start pty', parameters: { type: 'object' } }],
      dispatchTool: async () => { terminalDispatches++; return { output: 'ok' }; },
      skipMemoryInjection: true,
    });

    expect(terminalResult.text).toBe('terminal done');
    expect(terminalDispatches).toBe(1);
    expect(terminalSystem).toContain('base prompt');
    expect(terminalSystem).toContain(TERMINAL_MISSION_DISCIPLINE);
    expect(PTY_BUDGET_GRANT.tools).toContain('PtyShellStart');

    const plainToolSession = ensureCliSession(cfg);
    let plainDispatches = 0;
    let plainSystem = '';
    const plainProvider: LLMProvider = {
      name: 'plain-tool-scripted', defaultModel: 'd', available: () => true,
      async *streamChat(messages) {
        const sys = messages.find(m => m.role === 'system');
        plainSystem = typeof sys?.content === 'string' ? sys.content : '';
        if (plainDispatches === 0) {
          yield { type: 'tool_call', id: 'plain-call', name: 'PlainTool', args: {} } as LLMStreamEvent;
        } else {
          yield { type: 'text', delta: 'plain done' };
        }
      },
      async *chat() {},
    };

    await runTurn({
      userConfig: cfg,
      sessionId: plainToolSession.id,
      userText: 'use plain tool',
      systemPrompt: 'base prompt',
      provider: plainProvider,
      llmOpts: { maxTurns: 2 },
      tools: [{ name: 'PlainTool', description: 'plain', parameters: { type: 'object' } }],
      dispatchTool: async () => { plainDispatches++; return { output: 'ok' }; },
      skipMemoryInjection: true,
    });

    expect(plainDispatches).toBe(1);
    expect(plainSystem).toBe('base prompt');
    expect(plainSystem).not.toContain(TERMINAL_MISSION_DISCIPLINE);
  });

  test('does not re-wrap an already terminal-capable continuation turn', async () => {
    const cfg = baseConfig();
    const session = ensureCliSession(cfg);
    let dispatches = 0;
    let capturedSystem = '';
    const provider: LLMProvider = {
      name: 'terminal-prewired-scripted', defaultModel: 'd', available: () => true,
      async *streamChat(messages) {
        const sys = messages.find(m => m.role === 'system');
        capturedSystem = typeof sys?.content === 'string' ? sys.content : '';
        if (dispatches === 0) {
          yield { type: 'tool_call', id: 'prewired-call', name: 'PtyShellStart', args: { command: 'pwd' } } as LLMStreamEvent;
        } else {
          yield { type: 'text', delta: 'prewired done' };
        }
      },
      async *chat() {},
    };

    const tools = [{ name: 'PtyShellStart', description: 'start pty', parameters: { type: 'object' } }];
    const terminal = buildTerminalCapableTurn({
      specs: tools,
      dispatch: async () => {
        dispatches++;
        return { output: 'ok' };
      },
      systemPromptParts: ['base prompt'],
      llmOpts: { maxTurns: 1 },
    });
    const result = await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: 'use prewired terminal',
      systemPrompt: terminal.systemPromptParts.join('\n\n'),
      provider,
      llmOpts: terminal.llmOpts,
      tools: terminal.specs,
      dispatchTool: terminal.dispatch,
      skipMemoryInjection: true,
    });

    expect(result.text).toBe('prewired done');
    expect(dispatches).toBe(1);
    expect(capturedSystem).toBe(terminal.systemPromptParts.join('\n\n'));
    expect(capturedSystem.match(/\[터미널 미션 규율\]/g)?.length).toBe(1);
  });
});

describe('ensureCliSession', () => {
  test('reuses existing id when valid', () => {
    const cfg = baseConfig();
    const a = ensureCliSession(cfg);
    const b = ensureCliSession(cfg, a.id);
    expect(b.id).toBe(a.id);
  });

  test('creates new when id is unknown', () => {
    const cfg = baseConfig();
    const a = ensureCliSession(cfg, 'nonexistent-id');
    expect(a.id).not.toBe('nonexistent-id');
    expect(a.source).toBe('cli');
  });
});

describe('createRunTurnSession', () => {
  test('creates a fresh one-shot session with explicit source kind', () => {
    const cfg = baseConfig();
    const meta = createRunTurnSession(cfg, {
      sourceKind: 'scheduled',
      title: 'scheduler:test',
    });
    expect(meta.source).toBe('cli');
    expect(meta.sourceKind).toBe('scheduled');
    expect(meta.title).toBe('scheduler:test');
    const loaded = loadSession(meta.id)!;
    expect(loaded.meta.sourceKind).toBe('scheduled');
  });
});

describe('sessionBudget', () => {
  test('returns formatted "tok X/Y" string', async () => {
    const cfg = baseConfig();
    const s = ensureCliSession(cfg);
    await runTurn({ userConfig: cfg, sessionId: s.id, userText: 'hi', provider: fakeProvider(['ok']) });
    const b = sessionBudget(s.id);
    expect(b).toMatch(/^tok \d/);
  });

  test('unknown session → empty string', () => {
    expect(sessionBudget('missing')).toBe('');
  });
});
