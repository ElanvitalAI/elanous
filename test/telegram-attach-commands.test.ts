// Telegram /attach /detach /sessions — the mobile-side counterpart
// to the TUI /telegram attach|detach handoff.
//
// Each test gets isolated session and active-pointer roots via
// ELANOUS_SESSION_ROOT and ELANOUS_STATE_DIR, so bindings and the active
// marker cannot leak between cases. We exercise the command
// handlers the same way the real dispatcher does (parseTelegramSlash
// → cmd.handler) so a regression in parsing or routing is visible
// from here.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchTelegramSlash,
  defaultTelegramCommands,
} from '../src/telegram-commands.js';
import {
  createSession,
  setActiveSessionId,
  attachTelegramBinding,
  findSessionByTelegramChat,
} from '../src/session/index.js';
import type { UserConfig } from '../src/user-config.js';
import type { TgIncoming } from '../src/telegram.js';

let tmp: string;
let previousStateDir: string | undefined;
let previousSessionRoot: string | undefined;
let previousXdgStateHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tg-attach-'));
  // The session store roots at ~/.elanous/sessions (homedir, NOT XDG), so
  // the stale XDG_DATA_HOME redirect no longer isolates it — these
  // commands run through the dispatcher (default root) and would
  // otherwise read/write the REAL store. ELANOUS_SESSION_ROOT points the
  // whole store at the temp dir. The active-session pointer follows
  // ELANOUS_STATE_DIR when the deterministic test runner sets it.
  previousStateDir = process.env.ELANOUS_STATE_DIR;
  previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.ELANOUS_SESSION_ROOT = join(tmp, 'sessions');
  process.env.ELANOUS_STATE_DIR = join(tmp, 'state');
  process.env.XDG_STATE_HOME = join(tmp, 'state');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousXdgStateHome;
});

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
  };
}

function cfg(): UserConfig {
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
    raw: {},
  } as UserConfig;
}

describe('/attach', () => {
  test('binds this chat to the TUI-active session when no arg passed', async () => {
    const s = createSession({ source: 'cli', title: 'laptop-work' });
    setActiveSessionId(s.id);

    const out = await dispatchTelegramSlash(fakeCtx('/attach'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain(s.id.slice(0, 8));
    expect(out.reply).toContain('Attached');

    // Verify the binding actually landed on the session
    const hit = findSessionByTelegramChat(42);
    expect(hit?.id).toBe(s.id);
  });

  test('binds to a specific session when prefix passed', async () => {
    const a = createSession({ source: 'cli', title: 'other' });
    const b = createSession({ source: 'cli', title: 'target' });
    setActiveSessionId(a.id);  // active is `a`, but we explicitly ask for `b`

    const prefix = b.id.slice(0, 8);
    const out = await dispatchTelegramSlash(fakeCtx(`/attach ${prefix}`), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain(prefix);

    const hit = findSessionByTelegramChat(42);
    expect(hit?.id).toBe(b.id);
  });

  test('graceful message when no active session and no prefix', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/attach'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain('No active TUI session');
  });

  test('graceful message for unknown prefix', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/attach deadbeef'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain('No session matches');
  });

  test('conflict — chat already attached to another session', async () => {
    const a = createSession({ source: 'cli' });
    const b = createSession({ source: 'cli' });
    attachTelegramBinding(a.id, 42);
    setActiveSessionId(b.id);

    const out = await dispatchTelegramSlash(fakeCtx('/attach'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toMatch(/Attach failed/i);
    expect(out.reply).toContain('already attached');
  });
});

describe('/detach', () => {
  test('drops the bindings entry, leaves the session file alive', async () => {
    const s = createSession({ source: 'cli' });
    attachTelegramBinding(s.id, 42);

    const out = await dispatchTelegramSlash(fakeCtx('/detach'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain(s.id.slice(0, 8));
    expect(out.reply).toContain('Detached');

    // Binding cleared but the session row is still there
    const hit = findSessionByTelegramChat(42);
    expect(hit).toBeNull();
  });

  test('no-op message when nothing attached', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/detach'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toMatch(/No explicit attachment/i);
  });
});

describe('/sessions', () => {
  test('lists all telegram-bound sessions with marker on this chat', async () => {
    const mine = createSession({ source: 'cli', title: 'my-laptop' });
    const other = createSession({ source: 'cli', title: 'other-laptop' });
    attachTelegramBinding(mine.id, 42);
    attachTelegramBinding(other.id, 77);

    const out = await dispatchTelegramSlash(fakeCtx('/sessions'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain(mine.id.slice(0, 8));
    expect(out.reply).toContain(other.id.slice(0, 8));
    // ▸ marker on the chat-matching row only
    const lines = out.reply.split('\n');
    const mineLine = lines.find(l => l.includes(mine.id.slice(0, 8)))!;
    const otherLine = lines.find(l => l.includes(other.id.slice(0, 8)))!;
    expect(mineLine.trim().startsWith('▸')).toBe(true);
    expect(otherLine.trim().startsWith('▸')).toBe(false);
  });

  test('empty message when no sessions are bound', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/sessions'), {
      userConfig: cfg(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toMatch(/No Telegram-attached sessions/i);
  });
});
