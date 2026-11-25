import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAnnounceMemory } from '../msg/announce.js';
import { MsgStore } from '../msg/msg-store.js';
import { announceTierOf, registerAnnounceCommands } from './announce-cli.js';
import { registerMsgCommands } from './msg-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SEATS = [{ id: 'OP', title: 'op', role: 'coordinator' }, { id: 'JUD', title: 'judge', role: 'coordinator' }, { id: 'S1', title: 'hand one' }, { id: 'S2', title: 'hand two' }, { id: 'S3', title: 'hand three' }];

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'announce-cli-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const out = { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) };
  const run = async (args: string[]) => {
    const program = new Command();
    registerMsgCommands(program, {
      openStore: () => new MsgStore(path), out, setExitCode: code => exits.push(code),
      registerLogSink: async () => undefined,
      wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
      now: () => new Date('2026-11-25T09:00:00.000Z'),
    });
    registerAnnounceCommands(program, { openStore: () => new MsgStore(path), seats: () => SEATS, out, setExitCode: code => exits.push(code) });
    await program.parseAsync(args, { from: 'user' });
  };
  return { path, stdout, stderr, exits, run };
}

test('tier comes from federation roles', () => {
  expect(announceTierOf('OP', SEATS)).toBe('OP');
  expect(announceTierOf('JUD', SEATS)).toBe('coordinators');
  expect(announceTierOf('S1', SEATS)).toBe('hands');
  expect(announceTierOf('UNKNOWN', SEATS)).toBe('hands');
});

test('post --announce → ack-only L2 · apply L3 · apply+memory L4, grouped by tier', async () => {
  const w = world();
  const ids: number[] = [];
  for (const seat of ['JUD', 'S1', 'S2', 'S3']) {
    await w.run(['msg', 'post', '--from', 'OP', '--to', seat, '--announce', 'ann-t1', '--body', 'DocsSearch before RunShell', '--no-dedupe', '--json']);
    ids.push((JSON.parse(w.stdout.pop()!) as { id: number; kind: string; refs: string[] }).id);
  }
  const store = new MsgStore(w.path);
  try {
    const posted = store.getMessage(ids[0]!)!;
    expect(posted.kind).toBe('announce');
    expect(posted.refs).toEqual(['announce:ann-t1', 'announce-scope:federation']);
    for (const [index, seat] of ['JUD', 'S1', 'S2'].entries()) store.recordReceipt({ messageId: ids[index]!, recipient: seat, state: 'delivered', source: 'plan' });
  } finally { store.close(); }
  await w.run(['msg', 'ack', String(ids[1]), '--to', 'S1']);
  await w.run(['msg', 'ack', String(ids[2]), '--to', 'S2', '--apply', '적용: grep 전에 DocsSearch']);
  await w.run(['msg', 'post', '--from', 'JUD', '--to', 'OP', '--reply-to', String(ids[0]), '--apply', 'search docs first', '--body', 'ok', '--kind', 'status', '--no-dedupe']);
  const memory = new MsgStore(w.path);
  try { expect(recordAnnounceMemory(memory.db, { seat: 'JUD', file: 'docs-first.md' })).toEqual(['ann-t1']); } finally { memory.close(); }
  w.stdout.length = 0;
  await w.run(['announce', 'status', 'latest']);
  expect(w.exits).toEqual([]);
  expect(w.stdout[0]).toMatch(/^announce ann-t1 · scope federation · from OP · posted \S+ · 4 seats$/);
  expect(w.stdout).toEqual([
    w.stdout[0]!,
    'coordinators (1): L0=0 L1=0 L2=0 L3=0 L4=1 L5=0',
    '  JUD      L4 applied+memory · 적용: search docs first · memory=docs-first.md',
    'hands (3): L0=1 L1=0 L2=1 L3=1 L4=0 L5=0',
    '  S2       L3 applied · turn=seen · 적용: grep 전에 DocsSearch',
    '  S1       L2 turn/ack only · turn=seen',
    '  S3       L0 not delivered',
    'total: L0=1 L1=0 L2=1 L3=1 L4=1 L5=0',
    'L5: needs behavior metric (not measured)',
  ]);
  w.stdout.length = 0;
  await w.run(['announce', 'status', 'ann-t1', '--scope', 'coordinators', '--json']);
  const json = JSON.parse(w.stdout.join('\n')) as { scope: string; seats: Array<{ seat: string; level: string }>; byTier: Record<string, Record<string, number>> };
  expect(json.scope).toBe('coordinators');
  expect(json.seats.map(seat => [seat.seat, seat.level])).toEqual([['JUD', 'L4']]);
  expect(json.byTier.coordinators!.L4).toBe(1);
  expect(json.byTier.hands!.L0).toBe(0);
});

test('unknown announce exits 1; --apply without a reply target is refused', async () => {
  const w = world();
  await w.run(['announce', 'status', 'ann-none']);
  expect(w.exits).toEqual([1]);
  expect(w.stderr).toEqual(['announce ann-none: not found in the message ledger']);
  await w.run(['msg', 'post', '--from', 'S1', '--to', 'OP', '--apply', 'x', '--body', 'ok', '--kind', 'status']);
  expect(w.stderr.at(-1)).toContain('--apply needs --reply-to <announce message id>');
});
