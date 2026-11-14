import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerMemberConnectCommands } from './member-connect-cli.js';
import { registerMemberKeyTokenCommands } from './member-key-token-cli.js';
import { simCli } from '../ux-sim/in-process-cli.js';

for (const connectFirst of [false, true]) {
  test(`member key and connect share one parent when connectFirst=${connectFirst}`, () => {
    const program = new Command();
    const token = program.command('token');
    const connect = () => registerMemberConnectCommands(program);
    const keys = () => registerMemberKeyTokenCommands(program, token);
    if (connectFirst) { connect(); keys(); } else { keys(); connect(); }
    const parents = program.commands.filter(command => command.name() === 'member');
    expect(parents.map(command => command.name())).toEqual(['member']);
    expect(parents[0]!.commands.map(command => command.name()).sort()).toEqual(['connect', 'key']);
    expect(token.commands.map(command => command.name())).toContain('mint');
  });
}

test('actual CLI starts and member help exposes key and connect without duplicate registration', async () => {
  const result = await simCli(['member', '--help'], {
    mode: 'spawn', allowPaths: [['member']], env: { NODE_ENV: 'test' },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('key');
  expect(result.stdout).toContain('connect');
  expect(result.stderr).not.toContain('duplicate');
});
