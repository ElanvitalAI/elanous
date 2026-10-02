import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnboarding, runOnboardingNonInteractive, type WizardIO } from '../src/onboarding.js';
import type { ChoiceOption } from '../src/onboarding/io-extended.js';
import { nonInteractiveIO } from '../src/onboarding/non-interactive.js';
import { pickCodexAuthMode } from '../src/codex/setup.js';
import { saveTokens } from '../src/oauth/store.js';

const providerChoices: ChoiceOption<{ key: string }>[] = [
  { key: 'first', label: '첫 번째', value: { key: 'openai' } },
  { key: 'second', label: '두 번째', value: { key: 'grok' } },
];

const skillChoices: ChoiceOption<{ kind: 'preset'; preset: { key: string } }>[] = [
  { key: 'first', label: 'カスタム', value: { kind: 'preset', preset: { key: 'opencode' } } },
  { key: 'second', label: '任意の技能', value: { kind: 'preset', preset: { key: 'codex' } } },
];

describe('onboarding/non-interactive · scripted answer resolution', () => {
  test('provider selects the matching key from the actual presented choices', async () => {
    const io = nonInteractiveIO({
      answers: { llm: { provider: 'grok', apiKey: 'xai-foo' } },
      env: {},
    });
    io.showStep!({ index: 1, total: 5, title: '任意の翻訳済みタイトル' });

    const choice = await io.choose!('任意の翻訳済みプロンプト', providerChoices, {}, 'llm', 'provider');
    expect(choice).toEqual({ key: 'grok' });
    expect(await io.askSecret!('unrelated localized secret prompt', 'apiKey')).toBe('xai-foo');
    io.close();
  });

  test('skills selects the matching key from the actual presented choices', async () => {
    const io = nonInteractiveIO({
      answers: { skills: { activeSet: 'codex' } },
      env: {},
    });
    io.showStep!({ index: 2, total: 5, title: '任意の翻訳済みタイトル' });

    const choice = await io.choose!('任意の翻訳済みプロンプト', skillChoices, {}, 'skills', 'preset');
    expect(choice).toEqual({ kind: 'preset', preset: { key: 'codex' } });
    io.close();
  });

  test('obsidian step resolves its plain response from structured step context', async () => {
    const io = nonInteractiveIO({
      answers: { obsidian: { vault: '/Users/me/notes' } },
      env: {},
    });
    io.showStep!({ index: 3, total: 5, title: '任意の翻訳済みタイトル' });
    expect(await io.ask('任意の翻訳済みプロンプト', 'vault')).toBe('/Users/me/notes');
    io.close();
  });

  test('telegram enable selects the matching presented boolean choice', async () => {
    const io = nonInteractiveIO({
      answers: { telegram: { enabled: true, botToken: '12:abc' } },
      env: {},
    });
    io.showStep!({ index: 4, total: 5, title: '任意の翻訳済みタイトル' });
    const enabled = await io.choose!('任意の翻訳済みプロンプト', [
      { key: 'n', label: 'いいえ', value: false },
      { key: 'y', label: 'はい', value: true },
    ]);
    expect(enabled).toBe(true);
    expect(await io.askSecret!('unrelated localized secret prompt', 'botToken')).toBe('12:abc');
    io.close();
  });

  test('env bridge layered above answer file', async () => {
    const io = nonInteractiveIO({
      answers: { llm: { apiKey: 'k1' } },
      env: { ELANOUS_LLM_API_KEY: 'k2' },
    });
    io.showStep!({ index: 1, total: 5, title: '任意の翻訳済みタイトル' });
    expect(await io.askSecret!('unrelated localized secret prompt', 'apiKey')).toBe('k2');
    io.close();
  });

  test('missing answer accepts defaultIndex for string and unsupported choices', async () => {
    const io = nonInteractiveIO({ answers: {}, env: {} });
    io.showStep!({ index: 1, total: 5, title: '任意の翻訳済みタイトル' });
    const stringChoice = await io.choose!('任意の翻訳済みプロンプト', [
      { key: 'first', label: '첫 번째', value: 'first' },
      { key: 'second', label: '두 번째', value: 'second' },
    ], { defaultIndex: 1 }, 'llm', 'provider');
    const unsupportedChoice = await io.choose!('任意の翻訳済みプロンプト', [
      { key: 'first', label: '첫 번째', value: 1 },
      { key: 'second', label: '두 번째', value: 2 },
    ], { defaultIndex: 1 }, 'llm', 'provider');
    expect(stringChoice).toBe('second');
    expect(unsupportedChoice).toBe(2);
    io.close();
  });

  test('plain answers resolve by field context despite skipped or repeated questions', async () => {
    const io = nonInteractiveIO({
      answers: { llm: { model: 'gpt-5.4', baseUrl: 'https://example.test/v1' } },
      env: {},
    });
    io.showStep!({ index: 1, total: 5, title: '任意の翻訳済みタイトル' });
    expect(await io.ask('localized base URL prompt', 'baseUrl')).toBe('https://example.test/v1');
    expect(await io.ask('localized model prompt', 'model')).toBe('gpt-5.4');
    expect(await io.ask('localized model retry prompt', 'model')).toBe('gpt-5.4');
    io.close();
  });

  test('wizard integration preserves model and baseUrl across skipped API-key branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-non-interactive-'));
    try {
      const io = nonInteractiveIO({
        answers: {
          llm: { provider: 'local', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
          skills: { activeSet: 'claudecode' },
          obsidian: { vault: root },
          telegram: { enabled: false },
          discord: { enabled: false },
        },
        env: {},
      });
      const cfg = await runOnboarding({
        io,
        path: join(root, 'config.json'),
        localProbeDeps: { probe: async () => [] },
      });
      expect(cfg.llm.provider).toBe('local');
      expect(cfg.llm.model).toBe('llama3');
      expect(cfg.llm.baseUrl).toBe('http://localhost:11434/v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-interactive post-save prints browser/phone commands but never issues a token or QR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-continue-headless-'));
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    let issueCalls = 0;
    let qrCalls = 0;
    try {
      const config = await runOnboarding({
        io: nonInteractiveIO({ answers: {
          llm: { provider: 'auto' }, skills: { activeSet: 'claudecode' },
          obsidian: { vault: root }, telegram: { enabled: false }, discord: { enabled: false },
        }, env: {} }),
        path: join(root, 'config.json'),
        continueHereDeps: {
          probeTailscale: async () => ({ installed: true, alive: true, magicDnsHost: 'mbp.tailnet-example.ts.net' }),
          showNexus: async () => ({ status: 'unregistered', urls: {
            pwa: { loopback: 'http://127.0.0.1:31415/app/' },
            rest: { loopback: 'http://127.0.0.1:31415/v1/' },
            sse: { loopback: 'http://127.0.0.1:31415/v1/events' },
          } }),
          issueToken: () => { issueCalls++; return { token: 'elt_must-not-appear' }; },
          renderQr: () => { qrCalls++; return 'QR IMAGE'; },
        },
      });
      expect(config.onboarding.completed).toBe(true);
      const printed = stdout.mock.calls.flat().join('');
      expect(printed).toContain('브라우저: `elanous nexus show`');
      expect(printed).toContain('폰: `elanous phone link --temp --ttl 24h`');
      expect(printed).toContain('  어디서든(Tailscale): `elanous nexus pwa share enable`\n');
      expect(printed).not.toContain('https://');
      expect(printed).not.toContain('mbp.tailnet-example.ts.net');
      expect(printed).not.toContain('http://127.0.0.1');
      expect(printed).not.toContain('elt_must-not-appear');
      expect(printed).not.toContain('QR IMAGE');
      expect(issueCalls).toBe(0);
      expect(qrCalls).toBe(0);
    } finally {
      stdout.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runOnboardingNonInteractive completes IO after saving English skills and Korean Gemini answers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-non-interactive-complete-'));
    const configPath = join(root, 'config.json');
    const answerFilePath = join(root, 'answers.json');
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previousLanguage = process.env.ELANOUS_LANG;
    try {
      writeFileSync(configPath, JSON.stringify({ obsidian: { vault: join(root, 'existing-vault') } }));
      writeFileSync(answerFilePath, JSON.stringify({
        llm: { provider: 'gemini', apiKey: 'AIzaSyDUMMYKEY012345678901234567890123456', model: 'gemini-test' },
        skills: { activeSet: 'codex' },
        telegram: { enabled: false },
        discord: { enabled: false },
      }));
      process.env.ELANOUS_LANG = 'ko';

      const cfg = await runOnboardingNonInteractive({ path: configPath, answerFilePath, env: {} });

      expect(cfg.llm.provider).toBe('gemini');
      expect(cfg.skills.activeSet).toBe('codex');
      expect(cfg.obsidian.vault).toBe(join(root, 'existing-vault'));
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('obsidian.vault'));
    } finally {
      stderr.mockRestore();
      if (previousLanguage === undefined) delete process.env.ELANOUS_LANG;
      else process.env.ELANOUS_LANG = previousLanguage;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runOnboardingNonInteractive completion reports configured answers that no wizard question consumed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-unused-answer-'));
    const answerFilePath = join(root, 'answers.json');
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(answerFilePath, JSON.stringify({
        llm: { provider: 'local', apiKey: 'unused-key', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
        skills: { activeSet: 'claudecode' },
        obsidian: { vault: root },
        telegram: { enabled: false },
        discord: { enabled: false },
      }));

      await runOnboardingNonInteractive({
        path: join(root, 'config.json'),
        answerFilePath,
        env: {},
        localProbeDeps: { probe: async () => [] },
      });

      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith('non-interactive: 쓰이지 않은 답 — llm.apiKey\n');
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const unusedAnswerCases: Array<{
    answer: (root: string) => Record<string, unknown>;
    label: string;
  }> = [
    {
      label: 'llm.provider',
      answer: (root) => ({
        llm: { provider: 'unsupported-provider' },
        skills: { activeSet: 'claudecode' },
        obsidian: { vault: root },
        telegram: { enabled: false },
        discord: { enabled: false },
      }),
    },
    {
      label: 'llm.apiKey',
      answer: (root) => ({
        llm: { provider: 'local', apiKey: 'unused-key', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
        skills: { activeSet: 'claudecode' },
        obsidian: { vault: root },
        telegram: { enabled: false },
        discord: { enabled: false },
      }),
    },
    {
      label: 'skills.activeSet',
      answer: (root) => ({
        llm: { provider: 'auto' },
        skills: { activeSet: 'unsupported-preset' },
        obsidian: { vault: root },
        telegram: { enabled: false },
        discord: { enabled: false },
      }),
    },
    {
      label: 'obsidian.vault',
      answer: (root) => ({
        llm: { provider: 'auto' },
        skills: { activeSet: 'claudecode' },
        obsidian: { vault: null },
        telegram: { enabled: false },
        discord: { enabled: false },
      }),
    },
    {
      label: 'telegram.enabled',
      answer: (root) => ({
        llm: { provider: 'auto' },
        skills: { activeSet: 'claudecode' },
        obsidian: { vault: root },
        telegram: { enabled: 'unsupported-choice' },
        discord: { enabled: false },
      }),
    },
    {
      label: 'discord.enabled',
      answer: (root) => ({
        llm: { provider: 'auto' },
        skills: { activeSet: 'claudecode' },
        obsidian: { vault: root },
        telegram: { enabled: false },
        discord: { enabled: 'unsupported-choice' },
      }),
    },
  ];

  for (const { answer, label } of unusedAnswerCases) {
    test(`runOnboardingNonInteractive reports exactly ${label} when that answer is unused`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'onboarding-unused-answer-table-'));
      const answerFilePath = join(root, 'answers.json');
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        writeFileSync(answerFilePath, JSON.stringify(answer(root)));

        await runOnboardingNonInteractive({
          path: join(root, 'config.json'),
          answerFilePath,
          env: {},
          localProbeDeps: { probe: async () => [] },
        });

        expect(stderr).toHaveBeenCalledTimes(1);
        expect(stderr).toHaveBeenCalledWith(`non-interactive: 쓰이지 않은 답 — ${label}\n`);
      } finally {
        stderr.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('runOnboarding direct non-interactive IO completes and reports unused answers once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-direct-unused-answer-'));
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runOnboarding({
        io: nonInteractiveIO({
          answers: {
            llm: { provider: 'local', apiKey: 'unused-key', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
            skills: { activeSet: 'claudecode' },
            obsidian: { vault: root },
            telegram: { enabled: false },
            discord: { enabled: false },
          },
          env: {},
        }),
        path: join(root, 'config.json'),
        localProbeDeps: { probe: async () => [] },
      });

      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith('non-interactive: 쓰이지 않은 답 — llm.apiKey\n');
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex auth mode follows llm.apiKey independently from the provider picker', async () => {
    const authChoices: ChoiceOption<'oauth' | 'apikey' | 'skip'>[] = [
      { key: 'oauth', label: 'OAuth', value: 'oauth' },
      { key: 'apikey', label: 'API key', value: 'apikey' },
      { key: 'skip', label: 'Skip', value: 'skip' },
    ];
    const io = nonInteractiveIO({
      answers: { llm: { provider: 'openai-codex', apiKey: 'sk-test' } },
      env: {},
    });
    io.showStep!({ index: 1, total: 5, title: 'LLM' });

    expect(await io.choose!('provider', providerChoices, {}, 'llm', 'provider')).toEqual({ key: 'openai' });
    expect(await io.choose!('auth mode', authChoices, {}, 'llm', 'codex-auth-mode')).toBe('apikey');
    io.close();
  });

  test('Codex auth mode skips without llm.apiKey while keeping both output streams quiet', async () => {
    const authChoices: ChoiceOption<'oauth' | 'apikey' | 'skip'>[] = [
      { key: 'oauth', label: 'OAuth', value: 'oauth' },
      { key: 'apikey', label: 'API key', value: 'apikey' },
      { key: 'skip', label: 'Skip', value: 'skip' },
    ];
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const io = nonInteractiveIO({ answers: { llm: { provider: 'openai-codex' } }, env: {} });
      io.showStep!({ index: 1, total: 5, title: 'LLM' });

      expect(await io.choose!('auth mode', authChoices, {}, 'llm', 'codex-auth-mode')).toBe('skip');
      expect(await io.choose!('auth mode retry', authChoices, {}, 'llm', 'codex-auth-mode')).toBe('skip');
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(stdout.mock.calls.flat().join('')).not.toContain('  → skipped.');
      expect(stderr.mock.calls.flat().join('')).not.toContain('  → skipped.');
      io.close();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  test('onboarding keeps Codex skip guidance out of both output streams', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-non-interactive-codex-'));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const cfg = await runOnboarding({
        io: nonInteractiveIO({
          answers: {
            llm: { provider: 'openai-codex' },
            skills: { activeSet: 'claudecode' },
            obsidian: { vault: root },
            telegram: { enabled: false },
            discord: { enabled: false },
          },
          env: {},
        }),
        path: join(root, 'config.json'),
        localProbeDeps: { probe: async () => [] },
      });

      expect(cfg.llm.provider).toBe('openai-codex');
      expect(stdout.mock.calls.flat().join('')).toContain('폰: `elanous phone link --temp --ttl 24h`');
      expect(stderr).not.toHaveBeenCalled();
      expect(stdout.mock.calls.flat().join('')).not.toContain('  → skipped.');
      expect(stderr.mock.calls.flat().join('')).not.toContain('  → skipped.');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex auth pickers pass stable picker IDs without changing their choices', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-codex-picker-id-'));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
    try {
      const pickerIds: string[] = [];
      const io: WizardIO = {
        ask: async () => '',
        print: () => {},
        close: () => {},
        choose: async (_prompt, choices, _opts, _stepId, pickerId) => {
          pickerIds.push(pickerId!);
          return choices[0]!.value;
        },
      };

      expect(await pickCodexAuthMode(io, { hasCodexCliLogin: () => false })).toBe('oauth');
      saveTokens('openai-codex', {
        accessToken: 'existing-access-token',
        refreshToken: 'existing-refresh-token',
        expiresAt: Date.now() + 60_000,
      }, { authMode: 'chatgpt', mirrorCodex: false });
      expect(await pickCodexAuthMode(io, { hasCodexCliLogin: () => false })).toBe('oauth-keep');

      expect(pickerIds).toEqual(['codex-auth-mode', 'codex-keep-tokens']);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('print() suppresses output (CI-quiet)', () => {
    const io = nonInteractiveIO({ answers: {}, env: {} });
    expect(() => {
      io.print('this should not crash');
      io.print('');
    }).not.toThrow();
    io.close();
  });
});
