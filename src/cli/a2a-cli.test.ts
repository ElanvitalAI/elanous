import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerA2ACommands } from './a2a-cli.js';

function commands() {
  const program = new Command();
  registerA2ACommands(program);
  const a2a = program.commands.find(command => command.name() === 'a2a')!;
  return { program, serve: a2a.commands.find(command => command.name() === 'serve')!, card: a2a.commands.find(command => command.name() === 'card')! };
}

describe('a2a CLI commands', () => {
  test('elanous entry dispatches card and serves a mandatory --tool-cwd error', () => {
    const entry = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
    const card = spawnSync(process.execPath, [entry, '--test', 'a2a', 'card'], { encoding: 'utf8', timeout: 20000 });
    expect(card.status).toBe(0);
    expect(card.stdout).toContain('"url": "http://127.0.0.1:31490/a2a"');
    expect(card.stdout).toContain('"kind": "remote"');
    expect(card.stdout).toContain('"agent_card_url": "http://127.0.0.1:31490/.well-known/agent-card.json"');
    const serve = spawnSync(process.execPath, [entry, '--test', 'a2a', 'serve'], { encoding: 'utf8', timeout: 20000 });
    expect(serve.status).not.toBe(0);
    expect(serve.stderr).toContain("required option '--tool-cwd <directory>' not specified");
  }, 30_000);   // two real CLI starts (~2.5s each) exceed the 5s default

  test('serve requires --tool-cwd and defaults to loopback port 31490', async () => {
    const { program, serve } = commands();
    expect(serve.opts()).toEqual({ host: '127.0.0.1', port: '31490' });
    serve.exitOverride();
    serve.configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(['a2a', 'serve'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
  });

  test('serve rejects invalid port and working directory without binding', async () => {
    for (const port of ['0', '65536', '3.5', 'not-a-port']) {
      const { program } = commands();
      await expect(program.parseAsync(['a2a', 'serve', '--port', port, '--tool-cwd', import.meta.dir], { from: 'user' })).rejects.toThrow('invalid A2A port');
    }
    const { program } = commands();
    const oldToken = process.env.ELANOUS_A2A_TOKEN;
    try {
      process.env.ELANOUS_A2A_TOKEN = 'test-only-a2a-secret';
      await expect(program.parseAsync(['a2a', 'serve', '--tool-cwd', 'relative'], { from: 'user' })).rejects.toThrow('--tool-cwd');
    } finally {
      if (oldToken === undefined) delete process.env.ELANOUS_A2A_TOKEN;
      else process.env.ELANOUS_A2A_TOKEN = oldToken;
    }
  });

  test('card prints a real card and Gemini remote agent_card_url example', async () => {
    const { program, card } = commands();
    expect(card.opts()).toEqual({ host: '127.0.0.1', port: '31490' });
    const output: string[] = [];
    const original = console.log;
    try {
      console.log = (value: string) => { output.push(value); };
      await program.parseAsync(['a2a', 'card'], { from: 'user' });
      const agentCard = JSON.parse(output[0]!);
      expect(agentCard.url).toBe('http://127.0.0.1:31490/a2a');
      expect(agentCard.security).toEqual([{ bearerAuth: [] }]);
      expect(JSON.parse(output[1]!.slice('gemini:\n'.length))).toEqual({
        kind: 'remote', agent_card_url: 'http://127.0.0.1:31490/.well-known/agent-card.json',
      });
      output.length = 0;
      await program.parseAsync(['a2a', 'card', '--host', '0.0.0.0', '--public-url', 'https://agent.example.com/delegation/a2a'], { from: 'user' });
      expect(JSON.parse(output[0]!).url).toBe('https://agent.example.com/delegation/a2a');
      expect(JSON.parse(output[1]!.slice('gemini:\n'.length)).agent_card_url).toBe('https://agent.example.com/.well-known/agent-card.json');
    } finally {
      console.log = original;
    }
  });

  test('card rejects wildcard bind without a public URL and invalid ports', async () => {
    const { program } = commands();
    await expect(program.parseAsync(['a2a', 'card', '--host', '0.0.0.0'], { from: 'user' })).rejects.toThrow('publicUrl');
    await expect(program.parseAsync(['a2a', 'card', '--port', '65536'], { from: 'user' })).rejects.toThrow('invalid A2A port');
  });
});

test('the CLI start path does not load @a2a-js/sdk — a2a-cli imports the server lazily', () => {
  const source = require('node:fs').readFileSync(new URL('./a2a-cli.ts', import.meta.url), 'utf8') as string;
  expect(source).not.toMatch(/^import[^\n]*'\.\.\/a2a\/server\.js'/m);
});
