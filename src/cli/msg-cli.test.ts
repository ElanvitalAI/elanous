import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { registerMsgCommands } from './msg-cli.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(stdin = '') {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  const signal = new AbortController();
  let sleeps = 0;
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => stdout.push(line), error: line => stderr.push(line) },
    readStdin: async () => stdin,
    sleep: async () => { sleeps++; signal.abort(); }, signal: signal.signal,
    setExitCode: code => exits.push(code),
  });
  return {
    run: async (...args: string[]) => { await program.parseAsync(['msg', ...args], { from: 'user' }); },
    store: () => new MsgStore(path), stdout, stderr, exits, signal,
    get sleeps() { return sleeps; },
  };
}

test('post reads piped stdin, accepts literal body and kind; human and JSON outputs preserve envelope', async () => {
  const f = fixture('  stdin with\nnew line  ');
  await f.run('post', '--from', 's', '--to', 't', '--kind', 'memo');
  expect(f.stderr).toEqual([]);
  expect(f.stdout[0]).toContain('OP → MK [memo]:   stdin with\nnew line  ');
  const store = f.store();
  try { expect(store.list('MK')[0]).toMatchObject({ id: 1, from: 'OP', to: 'MK', body: '  stdin with\nnew line  ', kind: 'memo' }); }
  finally { store.close(); }
  f.stdout.length = 0;
  await f.run('post', 'explicit', '--from', 'ux', '--to', 'mk', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ id: 2, from: 'UX', to: 'MK', body: 'explicit' });
  f.stdout.length = 0;
  await f.run('post', '--body', 'from flag', '--from', 'OP', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout[0]!).body).toBe('from flag');
});

test('list pages by recipient and cursor; unread and watch are read-only until explicit ack', async () => {
  const f = fixture();
  const store = f.store();
  try {
    store.post({ from: 'OP', to: 'MK', body: 'first' });
    store.post({ from: 'MK', to: 'UX', body: 'other' });
    store.post({ from: 'OP', to: 'MK', body: 'second' });
  } finally { store.close(); }
  await f.run('list', '--to', 't', '--limit', '1', '--json');
  expect(JSON.parse(f.stdout.pop()!).map((row: { id: number }) => row.id)).toEqual([1]);
  await f.run('list', '--to', 'MK', '--after', '1');
  expect(f.stdout.pop()).toContain('#3 ');
  await f.run('unread', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual([{ recipient: 'MK', count: 2 }, { recipient: 'UX', count: 1 }]);
  await f.run('watch', '--to', 'CMO', '--once', '--json');
  expect(f.stdout.splice(0).map(line => JSON.parse(line).id)).toEqual([1, 3]);
  await f.run('watch', '--to', 'MK', '--after', '1', '--json');
  expect(f.stdout.splice(0).map(line => JSON.parse(line).id)).toEqual([3]);
  expect(f.sleeps).toBe(1);
  const before = f.store();
  try { expect(before.getCursor('MK')).toBe(0); } finally { before.close(); }
  await f.run('ack', '1', '--to', 't', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual({ recipient: 'MK', cursor: 1 });
  await f.run('list', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!).map((row: { id: number }) => row.id)).toEqual([3]);
  await f.run('ack', '3', '--to', 'MK');
  expect(f.stdout.pop()).toBe('MK acknowledged through #3');
  await f.run('unread', '--to', 't');
  expect(f.stdout.pop()).toBe('No unread messages.');
  await f.run('unread');
  expect(f.stdout.pop()).toBe('UX: 1 unread');
  const reopened = f.store();
  try { expect(reopened.getCursor('MK')).toBe(3); } finally { reopened.close(); }
});

test('real stdin piping and validation failure use process exit 2 without a stack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-child-'));
  dirs.push(dir);
  const script = `import { Command } from 'commander'; import { registerMsgCommands } from './src/cli/msg-cli.ts';\nconst cli = new Command(); registerMsgCommands(cli); await cli.parseAsync(process.argv.slice(1), { from: 'user' });`;
  const env = { ...process.env, ELANOUS_STATE_DIR: dir };
  const post = spawnSync('bun', ['-e', script, 'msg', 'post', '--from', 'OP', '--to', 'MK', '--json'],
    { cwd: process.cwd(), env, input: 'actual piped stdin', encoding: 'utf8' });
  expect(post.status, post.stderr).toBe(0);
  expect(JSON.parse(post.stdout).body).toBe('actual piped stdin');
  const invalid = spawnSync('bun', ['-e', script, 'msg', 'ack', '1.2', '--to', 'MK'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(invalid.status).toBe(2);
  expect(invalid.stdout).toBe('');
  expect(invalid.stderr.trim()).toMatch(/^msg: message ID must be an integer/);
  expect(invalid.stderr).not.toContain('    at ');
  for (const args of [
    ['list', '--to'],
    ['post', 'body', '--from', 'OP', '--to', 'MK', '--unexpected'],
  ]) {
    const parsed = spawnSync('bun', ['-e', script, 'msg', ...args],
      { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(parsed.status, `${args.join(' ')}: ${parsed.stderr}`).toBe(2);
    expect(parsed.stdout).toBe('');
    expect(parsed.stderr.trim()).toMatch(/^error: (option '--to <seat>' argument missing|unknown option '--unexpected')$/);
    expect(parsed.stderr).not.toContain('    at ');
  }
  const help = spawnSync('bun', ['-e', script, 'msg', 'list', '--help'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain('--to <seat>');
  expect(help.stderr).toBe('');
});

test('bad seats, body, kind, cursor, limit and future ack exit 2 with one-line error, no stack or mutation', async () => {
  const f = fixture('');
  for (const args of [
    ['post', '--from', 'OP', '--to', 'MK'],
    ['post', 'body', '--to', 'MK'],
    ['list'],
    ['watch', '--once'],
    ['unread', '--to', '../MK'],
    ['post', 'body', '--from', '../bad', '--to', 'MK'],
    ['post', 'body', '--from', 'OP', '--to', 'MK', '--kind', 'BAD!'],
    ['post', 'body', '--body', 'duplicate', '--from', 'OP', '--to', 'MK'],
    ['list', '--to', 'MK', '--after', '-1'],
    ['list', '--to', 'MK', '--limit', '1.5'],
    ['watch', '--to', 'MK', '--interval', '0', '--once'],
    ['ack', '1', '--to', 'MK'],
    ['ack', '1.2', '--to', 'MK'],
    ['ack', '--to', 'MK'],
  ]) {
    const before = f.stderr.length;
    await f.run(...args);
    expect(f.exits.at(-1)).toBe(2);
    expect(f.stderr.length).toBe(before + 1);
    expect(f.stderr.at(-1)).toMatch(/^msg: [^\n]+$/);
    expect(f.stderr.at(-1)).not.toContain('    at ');
  }
  expect(f.stdout).toEqual([]);
  const store = f.store();
  try { expect(store.unread()).toEqual([]); expect(store.getCursor('MK')).toBe(0); }
  finally { store.close(); }
});
