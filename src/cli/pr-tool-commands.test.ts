import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerPrCommands } from './pr-cli.js';

test('pr command list snapshot keeps queue, land, and granularity beside the new thin entrypoints', () => {
  const root = new Command();
  registerPrCommands(root);
  const pr = root.commands.find(command => command.name() === 'pr');
  expect(pr?.commands.map(command => command.name())).toEqual(['census', 'open-guard', 'queue', 'land', 'granularity']);
  expect(pr?.commands.find(command => command.name() === 'queue')?.commands.map(command => command.name()))
    .toEqual(['status', 'enqueue', 'run']);
});

test('read-only open-guard reports unknown without spending the new-PR allowance', async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  const root = new Command();
  registerPrCommands(root, {
    run: (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args.includes('--name-only')) return { ok: true, out: 'src/example.ts\0' };
      if (command === 'git' && args.includes('--unified=0')) return { ok: true, out: '' };
      return { ok: false, out: '', err: 'GitHub unavailable' };
    },
    out: { log: line => lines.push(line), error: line => lines.push(line) },
    setExitCode: code => exits.push(code),
  });
  await root.parseAsync(['pr', 'open-guard', '--seat', 'UX'], { from: 'user' });
  expect(JSON.parse(lines[0]!)).toMatchObject({ status: 'unknown', reasons: [{ code: 'inventory-unknown' }] });
  expect(exits).toEqual([1]);
  expect(calls.some(call => call.startsWith('eln msg post'))).toBe(false);
  expect(lines[0]).not.toContain('allowCreation');
});
