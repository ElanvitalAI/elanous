import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { registerMsgClearCommand, registerMsgResetCommand } from './msg-clear-cli.js';

setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Federation ladder literal: TC coordinates TC-A and TC-B; everyone else reports to OP.
const PARENT: Record<string, string> = { 'TC-A': 'TC', 'TC-B': 'TC', TC: 'OP', UX: 'OP', OP: 'CEO' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'msg-clear-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  // 184 escalation copies (the 11-25 flood shape) + 2 crown mails + 1 alert + 1 original ✋ + 3 ordinary mails.
  for (let i = 0; i < 184; i++) {
    seed.post({ from: i % 2 ? 'TC' : 'UX', to: 'OP', kind: 'request', intent: 'decision',
      refs: ['block:b1', 'reason:stuck', `hand-of:${i + 1}`, `hand-escalated-from:${1000 + i}`],
      body: `[✋ ESCALATED · ${i % 2 ? 'TC' : 'UX'} → OP] no outcome #${i}` }, { dedupe: false });
  }
  seed.post({ from: 'CLAUDE-OP', to: 'OP', kind: 'request', crownDirective: 'keep this', body: 'crown one' }, { dedupe: false });
  seed.post({ from: 'CLAUDE-OP', to: 'OP', kind: 'request', crownDirective: 'keep this too', body: 'crown two' }, { dedupe: false });
  seed.post({ from: 'RES', to: 'OP', kind: 'alert', body: 'disk full' }, { dedupe: false });
  seed.post({ from: 'TC-A', to: 'OP', kind: 'request', refs: ['block:b9', 'reason:need-key'], body: 'original hand' }, { dedupe: false });
  seed.post({ from: 'UX', to: 'TC-A', kind: 'info', body: 'tc-a one' }, { dedupe: false });
  seed.post({ from: 'UX', to: 'TC-B', kind: 'info', body: 'tc-b one' }, { dedupe: false });
  seed.post({ from: 'OP', to: 'UX', kind: 'info', body: 'ux one' }, { dedupe: false });
  seed.close();
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command();
  const msg = program.command('msg');
  const deps = { openStore: () => new MsgStore(path), out: { log: (l: string) => stdout.push(l), error: (l: string) => stderr.push(l) },
    setExitCode: (c: number) => exits.push(c), now: () => new Date('2026-11-25T13:00:00Z'),
    ladder: () => ({ parentOf: (s: string) => PARENT[s] ?? 'OP' }), storePath: () => path };
  registerMsgClearCommand(msg, deps);
  registerMsgResetCommand(msg, deps);
  return { path, dir, stdout, stderr, exits,
    run: async (...a: string[]) => { stdout.length = 0; stderr.length = 0; await program.parseAsync(['msg', ...a], { from: 'user' }); },
    json: () => JSON.parse(stdout.at(-1)!), store: () => new MsgStore(path) };
}

function unreadBodies(path: string, seat: string): string[] {
  const s = new MsgStore(path);
  try { return s.listByRecipient(seat, s.getCursor(seat), 1000).map(m => m.body); } finally { s.close(); }
}

test('clear dry-run counts the flood and touches nothing', async () => {
  const f = fixture();
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--ref', 'hand-escalated-from:', '--json');
  const j = f.json();
  expect(j.dryRun).toBe(true);
  expect(j.count).toBe(184);
  expect(j.protectedSkipped).toBe(0);
  expect(j.groups.length).toBe(10);
  expect(j.sampleIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(unreadBodies(f.path, 'OP').length).toBe(188);
});

test('clear without filters skips crown · alert · original hand', async () => {
  const f = fixture();
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--json');
  expect(f.json().count).toBe(184);
  expect(f.json().protectedSkipped).toBe(4);
});

test('clear --yes acks 184, leaves crown untouched, writes receipt + one notice; undo restores', async () => {
  const f = fixture();
  await f.run('clear', '--to', 'OP', '--by', 'CLAUDE-OP', '--yes', '--json');
  const j = f.json();
  expect(j.cleared).toBe(184);
  expect(existsSync(j.receipt)).toBe(true);
  const receipt = JSON.parse(readFileSync(j.receipt, 'utf8'));
  expect(receipt.ids.length).toBe(184);
  expect(receipt.by).toBe('CLAUDE-OP');
  const left = unreadBodies(f.path, 'OP');
  expect(left).toContain('crown one');
  expect(left).toContain('crown two');
  expect(left).toContain('disk full');
  expect(left).toContain('original hand');
  expect(left.length).toBe(5);
  expect(left.at(-1)).toStartWith('[cleared 184 mails · all-unprotected · receipt ');
  await f.run('clear', '--undo', j.receipt, '--by', 'OP', '--json');
  expect(f.json().restored).toBe(184);
  expect(unreadBodies(f.path, 'OP').length).toBe(189);
});

test('clear --include-protected without --yes is still a dry-run; with --yes it logs loudly', async () => {
  const f = fixture();
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--include-protected', '--json');
  expect(f.json().dryRun).toBe(true);
  expect(f.json().count).toBe(188);
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--include-protected', '--yes', '--json');
  expect(f.json().cleared).toBe(188);
  expect(f.stderr.join('\n')).toContain('4 protected mails');
});

test('clear filters: --from · --match · --ids-file · --until id · --fold-into-card', async () => {
  const f = fixture();
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--from', 'TC', '--json');
  expect(f.json().count).toBe(92);
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--match', '^\\[✋ ESCALATED · UX', '--json');
  expect(f.json().count).toBe(92);
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--until', '5', '--json');
  expect(f.json().count).toBe(5);
  const ids = join(f.dir, 'ids.txt');
  writeFileSync(ids, '1, 2\n3 185');
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--ids-file', ids, '--json');
  expect(f.json().count).toBe(3);
  await f.run('clear', '--to', 'OP', '--by', 'OP', '--from', 'UX', '--fold-into-card', '--yes', '--json');
  expect(f.json().cleared).toBe(92);
  const left = unreadBodies(f.path, 'OP');
  expect(left.some(b => b.startsWith('[msg clear · folded 92 mails into this card]'))).toBe(true);
});

test('clear authority: another hand may not clear OP; the coordinator may clear its hand', async () => {
  const f = fixture();
  await f.run('clear', '--to', 'OP', '--by', 'UX');
  expect(f.exits).toEqual([1]);
  await f.run('clear', '--to', 'TC-A', '--by', 'TC', '--json');
  expect(f.json().count).toBe(1);
});

test('reset seat: dry-run counts, --yes snapshots, deletes unprotected, posts notice; restore brings all back', async () => {
  const f = fixture();
  await f.run('reset', '--to', 'OP', '--by', 'OP', '--json');
  expect(f.json()).toMatchObject({ dryRun: true, scope: 'seat-OP', deletable: 184, protectedKept: 4 });
  await f.run('reset', '--to', 'OP', '--by', 'OP', '--yes', '--json');
  const j = f.json();
  expect(j.deleted).toBe(184);
  expect(existsSync(j.backup)).toBe(true);
  const s = f.store();
  const ops = (s.db.query("SELECT body FROM msg_messages WHERE recipient='OP' ORDER BY id").all() as Array<{ body: string }>).map(r => r.body);
  expect(s.db.query('SELECT COUNT(*) AS n FROM msg_message_acks').get()).toEqual({ n: 0 });
  s.close();
  expect(ops.slice(0, 4)).toEqual(['crown one', 'crown two', 'disk full', 'original hand']);
  expect(ops[4]).toStartWith('[mailbox reset · 184 deleted · scope seat-OP · by OP · backup ');
  await f.run('reset', '--restore', j.backup, '--by', 'OP', '--yes', '--json');
  const r = f.store();
  expect(r.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient='OP'").get()).toEqual({ n: 188 });
  r.close();
});

test('reset space TC covers TC, TC-A, TC-B only; federation needs --include-protected', async () => {
  const f = fixture();
  await f.run('reset', '--space', 'TC', '--by', 'TC', '--json');
  expect(f.json().seats.map((s: { seat: string }) => s.seat).sort()).toEqual(['TC-A', 'TC-B']);
  await f.run('reset', '--space', 'TC', '--by', 'TC', '--yes', '--json');
  expect(f.json().deleted).toBe(2);
  expect(unreadBodies(f.path, 'UX')).toEqual(['ux one']);
  await f.run('reset', '--federation', '--by', 'OP', '--yes');
  expect(f.exits).toEqual([1]);
  await f.run('reset', '--federation', '--by', 'OP', '--yes', '--include-protected', '--json');
  expect(f.json().deleted).toBe(191); // OP 188 + UX 1 + the two space-reset notices
  await f.run('reset', '--space', 'TC', '--by', 'UX');
  expect(f.exits).toEqual([1, 1]);
});
