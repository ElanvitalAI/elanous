// Telegram slash-command dispatcher.
//
// These commands live server-side (in our bot code, dispatched on
// incoming `/` messages) AND on Telegram's servers (the autocomplete
// menu, published once via setMyCommands at bot.start()). Tests cover
// the dispatcher path — the menu publish is covered by the existing
// telegram.test.ts "bot posts on start" suite via a stubbed fetch.

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../src/task-cards/card-store.js';
import { FEATURE_MATURITY } from '../src/maturity/feature-maturity.js';

const originalStateDir = process.env.ELANOUS_STATE_DIR;
const wishRoots: string[] = [];
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of wishRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
import {
  dispatchTelegramSlash,
  parseTelegramSlash,
  buildUnknownSlashReply,
  defaultTelegramCommands,
  toTelegramBotCommands,
  type TgSlashCommand,
} from '../src/telegram-commands.js';
import type { UserConfig } from '../src/user-config.js';
import type { TgIncoming } from '../src/telegram.js';

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
    raw: {},
  };
}

describe('dispatchTelegramSlash', () => {
  it('returns handled:false for plain text', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('hello'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    expect(out.handled).toBe(false);
  });

  it('dispatches /help to a rendered command list', async () => {
    const cmds = defaultTelegramCommands();
    const out = await dispatchTelegramSlash(fakeCtx('/help'), {
      userConfig: baseConfig(), allCommands: cmds,
    });
    expect(out.handled).toBe(true);
    if (!out.handled) return;
    expect(typeof out.reply).toBe('string');
    for (const c of cmds) {
      expect(out.reply).toContain(`/${c.name}`);
      expect(out.reply).toContain(c.description);
    }
  });

  it('dispatches /status with current provider + model', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/status'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain('grok');
    expect(out.reply).toContain('grok-beta');
  });

  it('dispatches /ping to a pong + timestamp', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/ping'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain('pong');
  });

  it('registers /clear and /reset as /new aliases (session reset)', async () => {
    const cmds = defaultTelegramCommands();
    for (const name of ['new', 'clear', 'reset']) {
      expect(cmds.some((c) => c.name === name)).toBe(true);
    }
    // No active session in the test ctx → the shared reset handler returns the
    // "no active session" note, proving the aliases are wired to /new's logic.
    for (const name of ['clear', 'reset']) {
      const out = await dispatchTelegramSlash(fakeCtx(`/${name}`), {
        userConfig: baseConfig(), allCommands: cmds,
      });
      if (!out.handled || !out.reply) throw new Error(`expected reply for /${name}`);
      expect(out.reply).toMatch(/session/i);
    }
  });

  it('strips the @botusername suffix from /help@mybot', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/help@mybot'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    expect(out.handled).toBe(true);
  });

  it('parses arguments after the command name', async () => {
    let gotArgs: string[] = [];
    const cmd: TgSlashCommand = {
      name: 'echo',
      description: 'echo args back',
      handler: async (args) => { gotArgs = args; return args.join(' '); },
    };
    const out = await dispatchTelegramSlash(fakeCtx('/echo one two three'), {
      userConfig: baseConfig(), allCommands: [cmd],
    });
    expect(gotArgs).toEqual(['one', 'two', 'three']);
    if (out.handled) expect(out.reply).toBe('one two three');
  });

  it('replies "Unknown command: …" for an unregistered /foo', async () => {
    const out = await dispatchTelegramSlash(fakeCtx('/foo bar'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain('Unknown command: /foo');
    // Includes the available list for self-correction.
    expect(out.reply).toContain('/help');
  });

  it('wraps a thrown handler error as "Error running …"', async () => {
    const cmd: TgSlashCommand = {
      name: 'explode',
      description: '',
      handler: async () => { throw new Error('boom'); },
    };
    const out = await dispatchTelegramSlash(fakeCtx('/explode'), {
      userConfig: baseConfig(), allCommands: [cmd],
    });
    if (!out.handled || !out.reply) throw new Error('expected reply');
    expect(out.reply).toContain('Error running /explode');
    expect(out.reply).toContain('boom');
  });

  it('rejects invalid command names (non-alphanumeric)', async () => {
    // `/🎉` is not a valid Telegram command name. The dispatcher
    // should fall through to handled:false rather than try to match.
    const out = await dispatchTelegramSlash(fakeCtx('/🎉 party'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    expect(out.handled).toBe(false);
  });
});

describe('/wish', () => {
  it('owner private chat creates one card, retry replies with same id; others and empty args do not write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-wish-'));
    wishRoots.push(root);
    process.env.ELANOUS_STATE_DIR = root;
    const commands = defaultTelegramCommands();
    expect(FEATURE_MATURITY.telegramCommand.wish).toBe('beta');
    expect(commands.find(c => c.name === 'wish')?.description).toBe('소원을 카드로 남기기');
    const opts = { userConfig: baseConfig(), allCommands: commands };
    const send = (text: string, overrides: Partial<TgIncoming> = {}) =>
      dispatchTelegramSlash(fakeCtx(text, overrides), opts);
    const first = await send('/wish 저장할 소원', { messageId: 73 });
    expect(first).toMatchObject({ handled: true, reply: expect.stringMatching(/^소원 카드로 남겼습니다 — 저장할 소원 \(카드 [a-f0-9]{8}\)$/) });
    const second = await send('/wish 저장할 소원', { messageId: 73 });
    expect(second).toEqual(first);
    expect(await send('/wish')).toEqual({ handled: true, reply: '/wish <소원 한 줄>' });
    expect(await send('/wish 안 됨', { userId: 19 })).toEqual({ handled: true, reply: '대표만 쓸 수 있습니다' });
    expect(await send('/wish 안 됨', { chatId: -42, isDm: false, isGroup: true }))
      .toEqual({ handled: true, reply: '대표만 쓸 수 있습니다' });
    const store = new CardStore(root);
    try {
      expect(store.listCards()).toHaveLength(1);
      expect(store.listCards()[0]).toMatchObject({ goalId: 'wish:telegram:42:73', title: '저장할 소원' });
    } finally { store.close(); }
  });
});

describe('parseTelegramSlash', () => {
  it('returns kind:none for plain text', () => {
    const out = parseTelegramSlash('hi there', defaultTelegramCommands());
    expect(out.kind).toBe('none');
  });

  it('returns kind:match + parsed args for a registered command', () => {
    const out = parseTelegramSlash('/ping one two', defaultTelegramCommands());
    expect(out.kind).toBe('match');
    if (out.kind !== 'match') throw new Error();
    expect(out.cmd.name).toBe('ping');
    expect(out.args).toEqual(['one', 'two']);
  });

  it('returns kind:unknown for slash-shaped but unregistered names', () => {
    const out = parseTelegramSlash('/nope', defaultTelegramCommands());
    expect(out.kind).toBe('unknown');
    if (out.kind !== 'unknown') throw new Error();
    expect(out.name).toBe('nope');
  });

  it('flags streaming commands via cmd.streaming', () => {
    const out = parseTelegramSlash('/skill foo bar', defaultTelegramCommands());
    if (out.kind !== 'match') throw new Error('expected match');
    expect(out.cmd.streaming).toBe(true);
  });

  it('instant commands have no streaming flag', () => {
    const out = parseTelegramSlash('/help', defaultTelegramCommands());
    if (out.kind !== 'match') throw new Error('expected match');
    expect(out.cmd.streaming).toBeFalsy();
  });
});

describe('default skill commands', () => {
  it('exposes /skill, /skills, /digest', () => {
    const names = defaultTelegramCommands().map(c => c.name);
    expect(names).toContain('intake');
    expect(names).toContain('skill');
    expect(names).toContain('skills');
    expect(names).toContain('digest');
  });

  it('/intake captures inline text into the task sketchbook plane', async () => {
    const cmds = defaultTelegramCommands();
    const intake = cmds.find(c => c.name === 'intake')!;
    const reply = await intake.handler(
      ['compare', 'two', 'repos'],
      fakeCtx('/intake compare two repos'),
      { userConfig: baseConfig(), allCommands: cmds },
    );
    expect(reply).toContain('Intake:');
    expect(reply).toContain('/intake decide apply-now');
  });

  it('/intake answer accepts latest clarify shorthand with no ids', async () => {
    const cmds = defaultTelegramCommands();
    const intake = cmds.find(c => c.name === 'intake')!;
    const openReply = await intake.handler(
      ['===='],
      fakeCtx('/intake ===='),
      { userConfig: baseConfig(), allCommands: cmds },
    );
    expect(openReply).toContain('/intake answer <answer...>');
    const reply = await intake.handler(
      ['answer', 'keep', 'this', 'in', 'backlog'],
      fakeCtx('/intake answer keep this in backlog'),
      { userConfig: baseConfig(), allCommands: cmds },
    );
    expect(reply).toContain('backlog-only');
  });

  it('/skill and /digest are streaming; /skills is instant', () => {
    const cmds = defaultTelegramCommands();
    expect(cmds.find(c => c.name === 'skill')!.streaming).toBe(true);
    expect(cmds.find(c => c.name === 'digest')!.streaming).toBe(true);
    expect(cmds.find(c => c.name === 'skills')!.streaming).toBeFalsy();
  });

  it('/skill with no args returns a usage hint', async () => {
    const cmds = defaultTelegramCommands();
    const skillCmd = cmds.find(c => c.name === 'skill')!;
    const reply = await skillCmd.handler([], fakeCtx('/skill'), {
      userConfig: baseConfig(), allCommands: cmds,
    });
    expect(typeof reply).toBe('string');
    expect(reply as string).toMatch(/usage|list/i);
  });

  it('/skill with unknown name returns "Unknown skill" message', async () => {
    const cmds = defaultTelegramCommands();
    const skillCmd = cmds.find(c => c.name === 'skill')!;
    const reply = await skillCmd.handler(
      ['no-such-skill-exists-xyz'],
      fakeCtx('/skill no-such-skill-exists-xyz'),
      { userConfig: baseConfig(), allCommands: cmds },
    );
    expect(reply).toContain('Unknown skill');
    expect(reply).toContain('no-such-skill-exists-xyz');
  });
});

describe('bot commands', () => {
  it('registers and dispatches the three shared bot commands', async () => {
    const commands = defaultTelegramCommands();
    expect(commands.filter((command) => ['bots', 'bot', 'botsay'].includes(command.name)))
      .toHaveLength(3);
    const bots = commands.find((command) => command.name === 'bots')!;
    const reply = await bots.handler([], fakeCtx('/bots'), {
      userConfig: baseConfig(), allCommands: commands,
    });
    expect(typeof reply).toBe('string');
  });
});

describe('ACP commands (/cc, /cancel, /cc_clear)', () => {
  it('exposes /cc as a streaming command', () => {
    const cc = defaultTelegramCommands().find(c => c.name === 'cc');
    expect(cc).toBeDefined();
    expect(cc!.streaming).toBe(true);
  });

  it('/cc with no args returns a usage hint (no agent spawn)', async () => {
    // Without args the handler must bail BEFORE calling the agent
    // manager — otherwise running the test would spawn a real
    // claude-code-acp subprocess. The assertion proves the guard
    // short-circuits via the usage string.
    const cc = defaultTelegramCommands().find(c => c.name === 'cc')!;
    const reply = await cc.handler([], fakeCtx('/cc'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    expect(typeof reply).toBe('string');
    expect(reply as string).toMatch(/usage/i);
  });

  it('/cancel with no in-flight turn returns idle message', async () => {
    const cancel = defaultTelegramCommands().find(c => c.name === 'cancel')!;
    const reply = await cancel.handler([], fakeCtx('/cancel'), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    expect(reply).toContain('No ACP turn');
  });

  it('/cc_clear on a fresh chat reports no session', async () => {
    const clear = defaultTelegramCommands().find(c => c.name === 'cc_clear')!;
    // Use a chatId that's virtually certain not to exist in any
    // real session-store file the test runner might inherit.
    const reply = await clear.handler([], fakeCtx('/cc_clear', { chatId: -99999999 }), {
      userConfig: baseConfig(), allCommands: defaultTelegramCommands(),
    });
    expect(reply).toMatch(/No ACP sessions/);
  });
});

describe('buildUnknownSlashReply', () => {
  it('lists every command name prefixed with /', () => {
    const cmds = defaultTelegramCommands();
    const reply = buildUnknownSlashReply('zzz', cmds);
    expect(reply).toContain('/zzz');
    for (const c of cmds) expect(reply).toContain(`/${c.name}`);
  });
});

describe('toTelegramBotCommands', () => {
  it('maps name → command and passes description through', () => {
    const cmds = defaultTelegramCommands();
    const out = toTelegramBotCommands(cmds);
    for (let i = 0; i < cmds.length; i++) {
      expect(out[i]!.command).toBe(cmds[i]!.name);
      expect(out[i]!.description).toBe(cmds[i]!.description);
    }
  });

  it('truncates descriptions over 256 chars (telegram limit)', () => {
    const long = 'x'.repeat(300);
    const [out] = toTelegramBotCommands([{ name: 'a', description: long, handler: async () => '' }]);
    expect(out!.description.length).toBeLessThanOrEqual(256);
    expect(out!.description.endsWith('…')).toBe(true);
  });
});
