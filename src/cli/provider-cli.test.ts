import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { _setRotationConfigReaderForTesting } from '../oauth/codex-account-store.js';
import { saveTokens } from '../oauth/store.js';
import {
  registerProviderCommands,
  buildCodexAccountImportGuidance as directGuidance,
  setCodexAccountLogSinkModuleForTesting as directSinkSeam,
  supportedProviderNames, defaultModelIdFor, apiKeyEnvFor,
} from './provider-cli.js';

const names = (root: Command) => root.commands.map(command => command.name());

describe('provider CLI registration', () => {
  test('index calls the registrar at the original provider boundary before status-bar', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('registerProviderCommands(program);');
    const statusBar = source.indexOf(".command('status-bar')", start);
    expect(start).toBeGreaterThan(0);
    expect(statusBar).toBeGreaterThan(start);
    expect(source.slice(start, statusBar)).not.toContain(".command('provider');");
  });

  test('the entry wires all provider commands into the root, leaving status-bar outside', async () => {
    const { program } = await import('../index.js');
    const expected = ['provider', 'provider:set', 'provider:restore', 'provider:rotate', 'provider:use'];
    const isolated = new Command('elanous');
    registerProviderCommands(isolated);
    for (const name of expected) {
      expect(names(isolated)).toContain(name);
      expect(names(program)).toContain(name);
      expect(isolated.commands.find(command => command.name() === name)?.helpInformation())
        .toBe(program.commands.find(command => command.name() === name)?.helpInformation());
    }
    const isolatedProvider = isolated.commands.find(command => command.name() === 'provider')!;
    const entryProvider = program.commands.find(command => command.name() === 'provider')!;
    expect(isolatedProvider.aliases()).toEqual(['providers']);
    expect(names(isolatedProvider)).toEqual(['codex']);
    // src/index.ts calls registerProviderCommands(program); its codex status action is the live CLI caller.
    expect(names(entryProvider.commands.find(command => command.name() === 'codex')!)).toContain('status');
    const compareChildren = (left: Command, right: Command): void => {
      expect(left.helpInformation()).toBe(right.helpInformation());
      expect(names(left)).toEqual(names(right));
      for (const child of left.commands) {
        compareChildren(child, right.commands.find(command => command.name() === child.name())!);
      }
    };
    compareChildren(isolatedProvider, entryProvider);
    expect(names(isolated)).not.toContain('status-bar');
    expect(names(program)).toContain('status-bar');
    expect(names(program)).toContain('schedule');
  });

  test('preserves both public index exports as the moved implementations', async () => {
    const { buildCodexAccountImportGuidance, setCodexAccountLogSinkModuleForTesting } = await import('../index.js');
    expect(buildCodexAccountImportGuidance).toBe(directGuidance);
    expect(setCodexAccountLogSinkModuleForTesting).toBe(directSinkSeam);
    expect(directGuidance('b', '/tmp/codex home')[1]).toContain("ELANOUS_CODEX_ACCOUNT_HOME='/tmp/codex home'");
  });

  test('rotation catalog helpers remain connected to the registry', () => {
    expect(supportedProviderNames()).toContain('openai-codex');
    expect(defaultModelIdFor('openai-codex')).toBe(defaultModelIdFor('openai'));
    expect(apiKeyEnvFor('openai-codex')).toBe(apiKeyEnvFor('openai'));
    expect(apiKeyEnvFor('local')).toBeUndefined();
  });
});

const priorEnv = { xdg: process.env.XDG_CONFIG_HOME, state: process.env.ELANOUS_STATE_DIR,
  source: process.env.ELANOUS_STATE_DIR_SOURCE, home: process.env.CODEX_HOME,
  account: process.env.ELANOUS_CODEX_ACCOUNT, accountHome: process.env.ELANOUS_CODEX_ACCOUNT_HOME };
const fixtureDirs: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries({ XDG_CONFIG_HOME: priorEnv.xdg,
    ELANOUS_STATE_DIR: priorEnv.state, ELANOUS_STATE_DIR_SOURCE: priorEnv.source,
    CODEX_HOME: priorEnv.home, ELANOUS_CODEX_ACCOUNT: priorEnv.account,
    ELANOUS_CODEX_ACCOUNT_HOME: priorEnv.accountHome })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _setRotationConfigReaderForTesting(null);
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function statusFixture(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'provider-codex-status-'));
  fixtureDirs.push(root);
  process.env.XDG_CONFIG_HOME = root;
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  delete process.env.ELANOUS_STATE_DIR_SOURCE;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_CODEX_ACCOUNT_HOME;
  const homes = ['default', 'team', 'third'].map(name => join(root, `${name}-home`));
  for (const home of homes) mkdirSync(home, { recursive: true });
  process.env.CODEX_HOME = homes[0]!;
  const store = join(root, 'elanous', 'auth.json');
  for (const [index, name] of ['default', 'team', 'third'].entries()) {
    saveTokens(index === 0 ? 'openai-codex' : `openai-codex:${name}`,
      { accessToken: 'fixture', refreshToken: 'fixture', expiresAt: null },
      { mirrorCodex: false, ...(index === 0 ? {} : { codexHome: homes[index] }) }, store);
  }
  return homes;
}

async function runCodexStatus(json = false): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { lines.push(values.join(' ')); });
  const stdout = spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => {
    lines.push(chunk);
    callback?.(null);
    return true;
  }) as typeof process.stdout.write);
  try {
    const program = new Command('elanous');
    registerProviderCommands(program);
    await program.parseAsync(['provider', 'codex', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
    return lines.join('\n');
  } finally {
    stdout.mockRestore();
    log.mockRestore();
  }
}

describe('provider codex status — local policy and credit signals', () => {
  test('shows three balances and credit policy after rotation; JSON carries raw balances and source', async () => {
    const homes = statusFixture();
    for (const [index, balance] of [19787, 29998, 25000].entries()) {
      writeQuotaSignal('rate_limit_reached', 100, homes[index], undefined, { balance, hasCredits: true });
    }
    _setRotationConfigReaderForTesting(() => ({ llm: { codexQuotaPolicy: 'credits' } }));
    const text = await runCodexStatus();
    expect(text).toMatch(/회전 +rotated → team[^\n]*\n정책      credits \(크레딧까지 · llm\.codexQuotaPolicy\)/);
    expect(text).toMatch(/지금 계정 default[^\n]*\n[^\n]*크레딧=19787/);
    expect(text).toMatch(/team[^\n]*크레딧=29998/);
    expect(text).toMatch(/third[^\n]*크레딧=25000/);
    writeQuotaSignal('rate_limit_reached', 100, homes[2], undefined, { balance: 25000.6, hasCredits: true });
    expect(await runCodexStatus()).toMatch(/third[^\n]*크레딧=25001/);
    const data = JSON.parse(await runCodexStatus(true));
    expect(data.policy).toEqual({ value: 'credits', source: 'config' });
    expect(data.rotation.to).toBe('team');
    expect([data.current, ...data.candidates].map(({ creditBalance, hasCredits }: { creditBalance: number; hasCredits: boolean }) => [creditBalance, hasCredits]))
      .toEqual([[19787, true], [29998, true], [25000.6, true]]);
  });

  test('named account reads its effective stored home rather than a conflicting declared home', async () => {
    const homes = statusFixture();
    process.env.ELANOUS_CODEX_ACCOUNT = 'team';
    process.env.ELANOUS_CODEX_ACCOUNT_HOME = join(homes[1]!, 'declared-other-home');
    writeQuotaSignal(undefined, 50, homes[1], undefined, { balance: 29998, hasCredits: true });
    const text = await runCodexStatus();
    expect(text).toMatch(/지금 계정 team[^\n]*\n[^\n]*크레딧=29998/);
    expect(JSON.parse(await runCodexStatus(true)).current).toMatchObject({ creditBalance: 29998, hasCredits: true });
  });

  test('missing balance is unknown, explicit no-credits is 없음; legacy and default policy sources', async () => {
    const homes = statusFixture();
    writeQuotaSignal(undefined, 50, homes[0]);
    writeQuotaSignal(undefined, 50, homes[1], undefined, { hasCredits: false });
    const text = await runCodexStatus();
    expect(text).toMatch(/회전[^\n]*\n정책      fallback \(한도 안 ⊕ 자동 폴백 · llm\.codexQuotaPolicy\) · 기본값/);
    expect(text).toMatch(/지금 계정 default[^\n]*\n[^\n]*크레딧=\?/);
    expect(text).toMatch(/team[^\n]*크레딧=없음/);
    expect(text).toMatch(/third[^\n]*크레딧=\?/);
    const missing = JSON.parse(await runCodexStatus(true));
    expect(missing.policy).toEqual({ value: 'fallback', source: 'default' });
    expect(missing.current).toMatchObject({ creditBalance: null, hasCredits: null });
    expect(missing.candidates[0]).toMatchObject({ creditBalance: null, hasCredits: false });
    _setRotationConfigReaderForTesting(() => ({ llm: { codexCreditsAllowed: true } }));
    expect(await runCodexStatus()).toContain('정책      credits (크레딧까지 · llm.codexQuotaPolicy) · 옛 codexCreditsAllowed 에서');
    expect(JSON.parse(await runCodexStatus(true)).policy).toEqual({ value: 'credits', source: 'legacy-credits' });
  });
});
