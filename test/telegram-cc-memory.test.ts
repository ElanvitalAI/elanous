// /cc·/cdx·/gem slash delegation must leave a breadcrumb in THIS chat's
// telegram session (transcript + self-awareness event) so elanous's brain
// — which reads the session transcript on a follow-up NL turn — can
// actually SEE the delegated job instead of hallucinating about
// unrelated state. Regression guard for the dogfood bug where a /cc job
// ran silently in a separate ACP subprocess session, so "진행되나요?"
// hit the brain with zero record and it answered about autopilot missions.
//
// Isolation: the real session store roots at `~/.elanous/sessions`
// (homedir — NOT XDG, and bun's os.homedir() ignores a runtime $HOME
// change), so we DON'T touch it. Instead we spy the session module's
// write functions + the self-event recorder and assert on the calls
// (AGENTS.md-endorsed "외부 호출 1점 args/count" pattern), and stub the
// ACP agent so runAcpTurn resolves without spawning a subprocess.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  dispatchTelegramSlash,
  defaultTelegramCommands,
} from '../src/telegram-commands.js';
import * as sessionMod from '../src/session/index.js';
import * as autonomyLog from '../src/domains/autonomy-log.js';
import * as surfaceEvents from '../src/domains/surface-events.js';
import {
  getActiveDelegation, delegationChatKey, _resetActiveDelegationForTests,
} from '../src/acp/active-delegation.js';
import { _resetTurnRunnerCachesForTests } from '../src/acp/turn-runner.js';
import { _resetAcpSessionStoreForTests } from '../src/acp/session-store.js';
import { _resetAcpAgentManagerForTests } from '../src/acp/agent-manager.js';
import type { UserConfig } from '../src/user-config/types.js';
import type { TgIncoming } from '../src/telegram.js';
import type { SessionMeta } from '../src/session/index.js';

/** Swap in a stub ACP agent so runAcpTurn resolves + "prompts" without
 *  spawning claude-code/codex. Mirrors slash-focus-budget's helper. */
function installPromptCapturingAgent(): void {
  _resetAcpAgentManagerForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/acp/agent-manager.js') as { globalAcpAgentManager: () => Record<string, unknown> };
  const live = mod.globalAcpAgentManager();
  const stub = {
    getCapabilities: () => ({ loadSession: false }),
    newSession: async () => 'sess-cc-mem',
    loadSession: async () => { /* unused (ephemeral) */ },
    async prompt(_sid: unknown, _blocks: unknown) { return { stopReason: 'end_turn' }; },
    cancel: async () => { /* noop */ },
  };
  live['getAgent'] = async () => stub as unknown;
  live['drop'] = () => { /* noop */ };
}

const FAKE_META = { id: 'sess-cc-test', messageCount: 0, title: 'tg:alice' } as unknown as SessionMeta;

function fakeCtx(text: string, overrides: Partial<TgIncoming> = {}): TgIncoming {
  return {
    chatId: 42,
    userId: 42,
    userName: 'alice',
    text,
    messageId: 1,
    threadId: undefined,
    isDm: true,
    isGroup: false,
    attachments: [],
    ...overrides,
  } as TgIncoming;
}

function baseConfig(): UserConfig {
  return {
    skillRouter: {
      autoRoute: false, autoRouteCountdownMs: 1000, llmFallback: false,
      keywordScoreThreshold: 2, llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1, autoRouteRequireAutoTrigger: true,
    },
    llm: { provider: 'grok', model: 'grok-beta' },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: { enabled: true, botToken: 'x', allowedUsers: [42] },
    onboarding: { completed: true, version: 1 },
    acp: {},
    raw: {},
  } as unknown as UserConfig;
}

let findSpy: ReturnType<typeof spyOn>;
let createSpy: ReturnType<typeof spyOn>;
let appendSpy: ReturnType<typeof spyOn>;
let recordSpy: ReturnType<typeof spyOn>;
let inboundSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  _resetTurnRunnerCachesForTests();
  _resetAcpSessionStoreForTests();
  installPromptCapturingAgent();
  // No chat is pre-bound → the create path runs. All session writes are
  // intercepted so the real ~/.elanous/sessions store is never touched.
  findSpy = spyOn(sessionMod, 'findSessionByTelegramChat').mockReturnValue(null);
  createSpy = spyOn(sessionMod, 'createSession').mockReturnValue(FAKE_META);
  appendSpy = spyOn(sessionMod, 'appendMessage').mockReturnValue(FAKE_META);
  recordSpy = spyOn(autonomyLog, 'recordAutonomousActionSafe').mockImplementation(() => 'evt-stub');
  inboundSpy = spyOn(surfaceEvents, 'recordInboundTurn').mockReturnValue('evt-inbound');
});

afterEach(() => {
  findSpy.mockRestore();
  createSpy.mockRestore();
  appendSpy.mockRestore();
  recordSpy.mockRestore();
  inboundSpy.mockRestore();
  _resetTurnRunnerCachesForTests();
  _resetAcpSessionStoreForTests();
  _resetActiveDelegationForTests();
});

function appendedContents(): string[] {
  return appendSpy.mock.calls.map((c: unknown[]) => (c[1] as { content?: string })?.content ?? '');
}

describe('/cc slash delegation — memory injection', () => {
  test('persists the /cc user turn AND the assistant reply to this chat session', async () => {
    const out = await dispatchTelegramSlash(
      fakeCtx('/cc add a date comment to README'),
      {
        userConfig: baseConfig(),
        allCommands: defaultTelegramCommands(),
        streamer: { edit: () => { /* noop */ } },
      } as never,
    );
    expect(out.handled).toBe(true);

    // Create-or-resolve happened against THIS chat.
    expect(createSpy).toHaveBeenCalledTimes(1);
    // Both the request breadcrumb and the outcome are written — a later
    // NL turn's priorConversation then carries the whole job.
    const roles = appendSpy.mock.calls.map((c: unknown[]) => (c[1] as { role: string }).role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(appendedContents().some(c => c.includes('/cc add a date comment to README'))).toBe(true);
  });

  // P2 — ACP memory parity: the delegate turn leaves a STRUCTURED tool row
  // (so a follow-up self turn's buildRecentToolObservations can surface it)
  // AND lands in surface_events via recordInboundTurn (like self turns do).
  test('leaves a structured acp tool-trace row + records into surface_events', async () => {
    await dispatchTelegramSlash(
      fakeCtx('/cc add a date comment to README'),
      { userConfig: baseConfig(), allCommands: defaultTelegramCommands(), streamer: { edit: () => {} } } as never,
    );
    // A role:'tool' row tagged acp:<backend> sits between user and assistant.
    const toolCalls = appendSpy.mock.calls.filter((c: unknown[]) => (c[1] as { role?: string })?.role === 'tool');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls.some((c: unknown[]) => String((c[1] as { toolName?: string })?.toolName ?? '').startsWith('acp:'))).toBe(true);
    // Ordering: user → tool → assistant.
    const roles = appendSpy.mock.calls.map((c: unknown[]) => (c[1] as { role: string }).role);
    expect(roles.indexOf('user')).toBeLessThan(roles.indexOf('tool'));
    expect(roles.indexOf('tool')).toBeLessThan(roles.indexOf('assistant'));
    // Cross-surface memory parity with the self path.
    expect(inboundSpy).toHaveBeenCalledTimes(1);
    expect((inboundSpy.mock.calls[0]![0] as { surface: string; userText: string }).surface).toBe('telegram');
    expect((inboundSpy.mock.calls[0]![0] as { userText: string }).userText).toContain('/cc');
  });

  // C — /new ends the bound ACP coding session too (not just the chat), so a
  // later /cc doesn't silently resume a stale coding context.
  test('/new drops the chat\'s bound ACP session', async () => {
    const { globalAcpSessionStore } = await import('../src/acp/session-store.js');
    const store = globalAcpSessionStore();
    // Seed a bound coding session for this chat (as a real /cc would).
    store.set(42, 'codex-app-server', 'sess-abc', undefined);
    expect(store.get(42, 'codex-app-server', undefined)).toBe('sess-abc');

    await dispatchTelegramSlash(
      fakeCtx('/new'),
      { userConfig: baseConfig(), allCommands: defaultTelegramCommands(), streamer: { edit: () => {} } } as never,
    );
    // /new ended the ACP coding session, not just the chat.
    expect(store.get(42, 'codex-app-server', undefined)).toBeNull();
  });

  // P1 — a completed /cc arms active delegation so plain NL follow-ups
  // continue the same ACP session; /brain exits back to the brain.
  test('/cc arms active delegation (backend=claude); /brain clears it', async () => {
    const ctx = fakeCtx('/cc do a thing');
    await dispatchTelegramSlash(
      ctx,
      { userConfig: baseConfig(), allCommands: defaultTelegramCommands(), streamer: { edit: () => {} } } as never,
    );
    const key = delegationChatKey(ctx.botId, ctx.chatId, ctx.threadId);
    expect(getActiveDelegation(key)).toBe('claude');

    await dispatchTelegramSlash(
      fakeCtx('/brain'),
      { userConfig: baseConfig(), allCommands: defaultTelegramCommands(), streamer: { edit: () => {} } } as never,
    );
    expect(getActiveDelegation(key)).toBeNull();
  });

  test('shows an immediate progress placeholder before the (slow) turn runs', async () => {
    const edits: string[] = [];
    await dispatchTelegramSlash(
      fakeCtx('/cc do the thing'),
      {
        userConfig: baseConfig(),
        allCommands: defaultTelegramCommands(),
        streamer: { edit: (s: string) => { edits.push(s); } },
      } as never,
    );
    // resolveSession/loadSession is otherwise silent for 60s+; the
    // "준비 중" placeholder is what tells the user the job is alive.
    expect(edits.some(e => e.includes('준비 중'))).toBe(true);
  });

  test('records a self-awareness breadcrumb (loop=delegate) with the backend label', async () => {
    await dispatchTelegramSlash(
      fakeCtx('/cdx refactor the parser'),
      {
        userConfig: baseConfig(),
        allCommands: defaultTelegramCommands(),
        streamer: { edit: () => { /* noop */ } },
      } as never,
    );
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const arg = recordSpy.mock.calls[0]![0] as { loop: string; action: string };
    expect(arg.loop).toBe('delegate');
    expect(arg.action).toContain('/cdx 위임:');
    expect(arg.action).toContain('refactor the parser');
  });

  test('empty /cc (no prompt, no attachments) writes nothing — no session, no breadcrumb', async () => {
    const out = await dispatchTelegramSlash(
      fakeCtx('/cc'),
      {
        userConfig: baseConfig(),
        allCommands: defaultTelegramCommands(),
        streamer: { edit: () => { /* noop */ } },
      } as never,
    );
    expect(out.handled).toBe(true);
    if (out.handled) expect(String(out.reply)).toContain('Usage:');
    expect(createSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
