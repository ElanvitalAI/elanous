import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
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
