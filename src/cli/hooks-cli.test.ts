import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { asanaEnabled, registerHooksCommands } from './hooks-cli.js';

test('hooks serve exposes defaults and status reports empty isolated queue', async () => {
  const program = new Command();
  registerHooksCommands(program);
  const hooks = program.commands.find(command => command.name() === 'hooks');
  expect(hooks?.commands.map(command => command.name())).toEqual(['serve', 'status']);
  expect(hooks?.commands[0]?.opts()).toEqual({ host: '127.0.0.1', port: '31480' });
  const root = mkdtempSync(join(tmpdir(), 'hooks-cli-'));
  const original = console.log;
  const output: string[] = [];
  try {
    setElanousConfigDir(root);
    console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
    await program.parseAsync(['hooks', 'status'], { from: 'user' });
    expect(JSON.parse(output[0]!)).toEqual({ queued: 0, lastDelivered: null });
  } finally { console.log = original; resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('Asana handshake saving is armed only by tox.external.asana.enabled === true', () => {
  expect(asanaEnabled({ tox: { external: { asana: { enabled: true } } } })).toBe(true);
  expect(asanaEnabled({ tox: { external: { asana: { enabled: 'yes' } } } })).toBe(false);
  expect(asanaEnabled({})).toBe(false);
  expect(asanaEnabled(undefined)).toBe(false);
});
