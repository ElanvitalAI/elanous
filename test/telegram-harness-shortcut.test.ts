import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { TgIncoming } from '../src/telegram.js';
import type { UserConfig } from '../src/user-config.js';
import * as channelCommandModule from '../src/intake-plane/channel-command.js';

const intakeCalls: Array<{ args: string[]; text: string }> = [];

// ⛔ R-TST23 — mock.module() 은 프로세스 전역이라 mock.restore() 로 «안 돌아온다».
// 원본을 네임스페이스로 담아 두고 afterAll 에서 그 «식별자»로 되돌린다.
// ⚠️ 형태가 계약이다 — 게이트(scripts/ci-mock-module-restore-gate.ts)는 «import * as + 스프레드»
//    또는 createRequire 로 담은 것만 원본으로 인정한다(`await import` 는 «안» 센다).
const originalChannelCommand = { ...channelCommandModule };

mock.module('../src/intake-plane/channel-command.js', () => ({
  handleTextChannelIntakeCommand: async (args: string[], ctx: { text: string }) => {
    intakeCalls.push({ args, text: ctx.text });
    return args[0] === 'implement' ? 'harness launched' : 'captured';
  },
}));

const { defaultTelegramCommands, dispatchTelegramSlash } = await import('../src/telegram-commands.js');

function fakeCtx(text: string): TgIncoming {
  return {
    updateId: 1,
    chatId: 42,
    userId: 42,
    userName: 'alice',
    text,
    messageId: 1,
    isDm: true,
    isGroup: false,
    attachments: [],
  };
}

function config(): UserConfig {
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
  } as unknown as UserConfig;
}

describe('Telegram /harness shortcut', () => {
  test('registers the valid autocomplete command without removing intake', () => {
    const names = defaultTelegramCommands().map((command) => command.name);
    expect(names).toContain('harness');
    expect(names).toContain('intake');
    expect(names).toContain('ad');
    expect(new Set(names).size).toBe(names.length);
    const harness = defaultTelegramCommands().find((command) => command.name === 'harness')!;
    expect(harness.name).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(harness.description.length).toBeGreaterThanOrEqual(1);
    expect(harness.description.length).toBeLessThanOrEqual(256);
  });

  test('uses the existing intake entrypoint for capture then implement', async () => {
    intakeCalls.length = 0;
    const out = await dispatchTelegramSlash(fakeCtx('/harness fix this'), {
      userConfig: config(),
      allCommands: defaultTelegramCommands(),
    });
    expect(out).toEqual({ handled: true, reply: 'harness launched' });
    expect(intakeCalls).toEqual([
      { args: ['capture', 'fix', 'this'], text: '/harness fix this' },
      { args: ['implement'], text: '/harness fix this' },
    ]);
  });

  test('replies with one-line usage and does not dispatch without a task', async () => {
    intakeCalls.length = 0;
    const out = await dispatchTelegramSlash(fakeCtx('/harness'), {
      userConfig: config(),
      allCommands: defaultTelegramCommands(),
    });
    expect(out).toEqual({ handled: true, reply: 'Usage: /harness <task...>' });
    expect(intakeCalls).toEqual([]);
  });
});

afterAll(() => {
  mock.module('../src/intake-plane/channel-command.js', () => originalChannelCommand);
});
