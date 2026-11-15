import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { extractRootProviderFlags, rootValueOptionNames } from './root-provider-flags.js';

const registered = new Command()
  .option('--config-dir <dir>')
  .option('--tui <mode>')
  .option('--name <name>')
  .option('-r, --remote [name]')
  .option('--provider <name>')
  .option('--model <id>');
const rootValues = new Set(rootValueOptionNames(registered.options));
rootValues.add('--resume');
rootValues.add('--test-state-dir');
const extract = (args: string[]) => extractRootProviderFlags(args, rootValues);

test('root provider and model flags leave TUI launch flags intact', () => {
  expect(extract(['--tui', 'next', '--provider', 'grok', '--model=grok-4.7']))
    .toEqual({ args: ['--tui', 'next'], provider: 'grok', model: 'grok-4.7' });
  expect(extract(['--provider=openai-codex', '--resume', 'session-a']))
    .toEqual({ args: ['--resume', 'session-a'], provider: 'openai-codex' });
});

test('subcommand flags stay with their command and malformed root flags fail', () => {
  expect(extract(['pty', 'drive', '--provider', 'grok']).args)
    .toEqual(['pty', 'drive', '--provider', 'grok']);
  expect(extract(['--model', 'grok-4.7']).error).toContain('--provider');
  expect(extract(['--provider']).error).toContain('requires a value');
  expect(extract(['--provider', 'grok', '--provider', 'openai-codex']).error)
    .toContain('duplicate');
});

test('registered root value options may precede provider in the exact launch order', () => {
  expect(rootValues.has('--config-dir')).toBe(true);
  expect(extract(['--config-dir', '/tmp/isolated', '--tui', 'next', '--provider', 'grok']))
    .toEqual({ args: ['--config-dir', '/tmp/isolated', '--tui', 'next'], provider: 'grok' });
  expect(extract(['--name', 'seat', '--config-dir', '/tmp/isolated', '--provider', 'grok', '--model', 'grok-4.7']))
    .toEqual({ args: ['--name', 'seat', '--config-dir', '/tmp/isolated'], provider: 'grok', model: 'grok-4.7' });
});
