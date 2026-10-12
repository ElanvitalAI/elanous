import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSeatBootCommands } from './seat-cli.js';
import { MsgStore } from '../msg/msg-store.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-'));
  const root = join(home, 'elanous-hq', 'seat-state', 'MK');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'HANDOFF.md'), '# Handoff title access_token=plainsecretvalue12345\nUpdated: 2026-10-12\n\naccess_token=ghp_0123456789abcdef0123456789abcdef0123\nrun `cat secret`\n');
  writeFileSync(join(root, 'inbox.md'), '# Inbox heading\nFrom: OP refresh_token: plainsecretvalue12345\nat: refresh_token: plainsecretvalue12345\n\nBearer abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(join(root, 'harvest-claims.tsv'), 'pr\tclaimer\tat\tstatus\tnote\n#123\tTC\t2026-10-12\topen\taccess_token=ghp_0123456789abcdef0123456789abcdef0123\n');
  writeFileSync(join(root, 'scheduled.tsv'), 'at\twhat\tthen\thow\n09:00\tcheck\treport\tBearer abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(join(root, 'claims.jsonl'), '{"claim":"decoy","access_token":"ghp_0123456789abcdef0123456789abcdef0123"}\n');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'memory'), { recursive: true });
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'memory', 'MEMORY.md'), '# Memory index\n\nSensitive body\n');
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({ facts: [{ kind: 'cell', id: 'cell-1', status: 'ready', owner: 'OP', version: 'v1', source: 'fixture', secret: 'access_token=ghp_0123456789abcdef0123456789abcdef0123' }], events: [{ at: 'now', kind: 'tick', source: 'events', summary: 'password=plainsecretvalue12345 Bearer abcdefghijklmnopqrstuvwxyz0123456789', body: 'do not show' }] }) });
  return { home, root, output, run: (...args: string[]) => cli.parseAsync(['seat', 'boot', ...args], { from: 'user' }), cleanup: () => { log.mockRestore(); error.mockRestore(); rmSync(home, { recursive: true, force: true }); } };
}

test('seat boot renders allowlisted context and file metadata without secret or body text', async () => {
  const f = fixture();
  try {
    await f.run('MK');
    const text = f.output.at(-1)!;
    expect(text).toContain('cell-1');
    expect(text).toContain('Handoff title');
    expect(text).toContain('From: OP');
    expect(text).not.toContain('From: OP refresh_token');
    expect(text).toContain('pr=#123');
    expect(text).toContain('what=check');
    expect(text).toContain('Memory index');
    expect(text).not.toContain('Sensitive body');
    expect(text).not.toContain('run `cat secret`');
    expect(text).not.toContain('access_token=ghp_0123456789abcdef0123456789abcdef0123');
    expect(text).not.toContain('plainsecretvalue12345');
    expect(text).toContain('access_token=***');
    expect(text).toContain('refresh_token: ***');
    expect(text).toContain('password=***');
    expect(text).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).toContain('출처:');
    expect(text).toContain('갱신:');
    expect(text).not.toContain('decoy');
    expect(readFileSync(join(f.root, 'HANDOFF.md'), 'utf8')).toContain('access_token=');
  } finally { f.cleanup(); }
});

test('seat boot reads DM and ALL unread counts without creating or acknowledging messages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-msg-'));
  const msgPath = join(home, 'state', 'msg', 'messages.db');
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}), msgPath: () => msgPath });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).toContain('안 읽은 msg 미관측 (MK)');
    expect(existsSync(msgPath)).toBe(false);
    const store = new MsgStore(msgPath);
    try {
      store.post({ from: 'OP', to: 'MK', body: 'private-direct-body' });
      const broadcast = store.post({ from: 'OP', to: 'ALL', body: 'private-broadcast-body' });
      store.post({ from: 'MK', to: 'ALL', body: 'own-broadcast-body' });
      await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
      expect(output.at(-1)).toContain('안 읽은 msg 2 (MK)');
      expect(output.at(-1)).not.toContain('private-direct-body');
      expect(output.at(-1)).not.toContain('private-broadcast-body');
      expect(store.getCursor('MK')).toBe(0);
      store.ack('MK', broadcast.id);
      await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
      expect(output.at(-1)).toContain('안 읽은 msg 0 (MK)');
      expect(store.getCursor('MK')).toBe(broadcast.id);
    } finally { store.close(); }
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});

test('seat boot does not follow a linked seat directory outside the seat-state root', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-linked-'));
  const root = join(home, 'elanous-hq', 'seat-state');
  const outside = mkdtempSync(join(tmpdir(), 'seat-boot-outside-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(outside, 'HANDOFF.md'), '# Outside private heading\n');
  symlinkSync(outside, join(root, 'MK'));
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}) });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).not.toContain('Outside private heading');
    expect(output.at(-1)).toContain('미관측: 일반 경로가 아님');
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('seat boot does not follow a linked HQ ancestor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-linked-hq-'));
  const outside = mkdtempSync(join(tmpdir(), 'seat-boot-outside-hq-'));
  const outsideSeat = join(outside, 'seat-state', 'MK');
  mkdirSync(outsideSeat, { recursive: true });
  writeFileSync(join(outsideSeat, 'HANDOFF.md'), '# Outside HQ heading\n');
  symlinkSync(outside, join(home, 'elanous-hq'));
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}) });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).not.toContain('Outside HQ heading');
    expect(output.at(-1)).toContain('미관측: 일반 경로가 아님');
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('CLI entry writes the local boot card to stdout only', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-entry-'));
  const seatDir = join(home, 'elanous-hq', 'seat-state', 'MK');
  mkdirSync(seatDir, { recursive: true });
  writeFileSync(join(seatDir, 'HANDOFF.md'), '# Local handoff heading\n');
  try {
    const run = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'seat', 'boot', 'MK'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new TextDecoder().decode(run.stdout);
    const stderr = new TextDecoder().decode(run.stderr);
    expect(run.exitCode).toBe(0);
    expect(stdout).toContain('Local handoff heading');
    expect(stderr).toBe('');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('seat boot marks absent sources as unobserved and rejects non-seat values', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-empty-'));
  const output: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const error = spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
  const prior = process.exitCode;
  process.exitCode = 0;
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}) });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).toContain('미관측: 파일 없음');
    await cli.parseAsync(['seat', 'boot', 'NOPE'], { from: 'user' });
    expect(errors.at(-1)).toContain('unknown seat');
    expect(process.exitCode).toBe(2);
  } finally { process.exitCode = prior ?? 0; log.mockRestore(); error.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});
