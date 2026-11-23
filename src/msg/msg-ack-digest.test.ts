// MSG-FILTERS-RELAX · bulk-ack digest — a bulk ack leaves compressed meaning (one memory entry), not silence.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from './msg-store.js';
import { ackDigestInputs, recordAckDigest, saveAckDigestMemory, type AckDigestMemory } from './msg-ack-digest.js';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { dispatchMsgAck } from '../skills/tools/ops-ledger.js';
import { listMemories, memoryRoot } from '../memory.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date(2026, 10, 24, 1, 15, 0);

/** 3 approval requests of one class · 1 alert · 2 routine info lines. */
function seedSix(store: MsgStore, seat: string): number[] {
  const approval = (command: string) => `[승인 요청 · TC] Bash · 이유 destructive: recursive rm\n명령(비밀 가림): ${command}\n명령 이름: rm`;
  return [
    store.post({ from: 'TC', to: seat, body: approval('rm -rf /tmp/a'), intent: 'request' }).id,
    store.post({ from: 'TC', to: seat, body: approval('rm -rf /tmp/b'), intent: 'request' }).id,
    store.post({ from: 'TC', to: seat, body: approval('rm -rf /tmp/c'), intent: 'request' }).id,
    store.post({ from: 'JUD', to: seat, body: 'pregate RED on head abc', intent: 'alert' }).id,
    store.post({ from: 'UX', to: seat, body: 'ok' }).id,
    store.post({ from: 'UX', to: seat, body: '확인했습니다' }).id,
  ];
}

test('6 mails → 1 grouped approval line · 1 alert line · 0 routine lines · one memory entry', async () => {
  const store = new MsgStore(':memory:');
  try {
    const ids = seedSix(store, 'OP');
    const saved: AckDigestMemory[] = [];
    const recorded = await recordAckDigest('OP', ackDigestInputs(store, 'OP', ids), { save: entry => { saved.push(entry); }, now: () => NOW });
    expect(recorded!.digest.lines).toEqual([
      '- 1× JUD · alert → acked (#4)',
      '- 3× TC · request [approval Bash: destructive: recursive rm] → acked (#1 #2 #3)',
    ]);
    expect(recorded!.digest.summary).toBe('OP acked 6 mails: 0 decisions · 1 alerts · 3 requests · 2 info (2 routine · 0 duplicate dropped)');
    expect(saved).toEqual([{
      type: 'project', name: 'mail-digest-OP-20261124-0115',
      description: 'OP acked 6 mails: 0 decisions · 1 alerts · 3 requests · 2 info (2 routine · 0 duplicate dropped)',
      body: 'OP acked 6 mails: 0 decisions · 1 alerts · 3 requests · 2 info (2 routine · 0 duplicate dropped)\n'
        + '- 1× JUD · alert → acked (#4)\n'
        + '- 3× TC · request [approval Bash: destructive: recursive rm] → acked (#1 #2 #3)',
    }]);
  } finally { store.close(); }
});

test('receipt outcome splits a group; info naming a PR/cell/host is kept; duplicates count once; one mail = no digest', async () => {
  const store = new MsgStore(':memory:');
  try {
    const a = store.post({ from: 'OP', to: 'TC', body: '[승인 요청 · OP] Bash · 이유 op-only (merge · kill)\nx', intent: 'request' }).id;
    const b = store.post({ from: 'OP', to: 'TC', body: '[승인 요청 · OP] Bash · 이유 op-only (merge · kill)\ny', intent: 'request' }).id;
    store.recordReceipt({ messageId: a, recipient: 'TC', state: 'rejected', reason: 'no', source: 'cli' });
    const c = store.post({ from: 'UX', to: 'TC', body: 'landed #39816 on minim5' }).id;
    const d = store.post({ from: 'UX', to: 'TC', body: 'landed #39816 on minim5', kind: 'note' }).id;
    const saved: AckDigestMemory[] = [];
    const recorded = await recordAckDigest('TC', ackDigestInputs(store, 'TC', [a, b, c, d]), { save: entry => { saved.push(entry); }, now: () => NOW });
    expect(recorded!.digest.lines).toEqual([
      `- 1× OP · request [approval Bash: op-only (merge · kill)] → rejected (#${a})`,
      `- 1× OP · request [approval Bash: op-only (merge · kill)] → acked (#${b})`,
      `- 1× UX · info → acked (#${c}) · #39816 minim5`,
    ]);
    expect(recorded!.digest.duplicatesDropped).toBe(1);
    expect(saved).toHaveLength(1);
    expect(await recordAckDigest('TC', ackDigestInputs(store, 'TC', [a]), { save: () => { throw new Error('must not save'); } })).toBeNull();
  } finally { store.close(); }
});

test('eln msg ack --through prints the digest and saves one memory entry; a routine-only batch saves none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-ack-digest-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  try { seedSix(seed, 'OP'); } finally { seed.close(); }
  const stdout: string[] = [];
  const saved: AckDigestMemory[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path), out: { log: line => stdout.push(line), error: () => {} }, setExitCode: () => {},
    registerLogSink: async () => undefined, now: () => NOW, saveAckDigest: entry => { saved.push(entry); },
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
  });
  await program.parseAsync(['msg', 'ack', '--through', '6', '--to', 'OP'], { from: 'user' });
  expect(stdout).toEqual([
    'OP acknowledged through #6',
    'digest (memory mail-digest-OP-20261124-0115): OP acked 6 mails: 0 decisions · 1 alerts · 3 requests · 2 info (2 routine · 0 duplicate dropped)',
    '- 1× JUD · alert → acked (#4)',
    '- 3× TC · request [approval Bash: destructive: recursive rm] → acked (#1 #2 #3)',
  ]);
  expect(saved.map(entry => entry.name)).toEqual(['mail-digest-OP-20261124-0115']);
  // MsgAck ids[] on routine-only mail: digest summary, no memory entry.
  const store = new MsgStore(path);
  let routine: number[];
  try { routine = [store.post({ from: 'UX', to: 'MK', body: 'ok' }).id, store.post({ from: 'UX', to: 'MK', body: 'thanks' }).id]; }
  finally { store.close(); }
  const result = await dispatchMsgAck({ to: 'MK', ids: routine! }, { openStore: () => new MsgStore(path), saveAckDigest: entry => { saved.push(entry); } });
  expect(result.digest).toEqual({ summary: 'MK acked 2 mails: 0 decisions · 0 alerts · 0 requests · 2 info (2 routine · 0 duplicate dropped)', lines: [] });
  expect(saved).toHaveLength(1);
});

test('the default saver writes ONE entry into the `eln memory add` store', async () => {
  const seat = `DIGEST${Date.now() % 1_000_000}`;
  const store = new MsgStore(':memory:');
  try {
    const recorded = await recordAckDigest(seat, ackDigestInputs(store, seat, seedSix(store, seat)), { save: saveAckDigestMemory, now: () => NOW });
    expect(recorded!.saved).toBe(true);
    const name = `mail-digest-${seat}-20261124-0115`;
    const entries = listMemories({}, memoryRoot()).filter(entry => entry.name === name);
    expect(entries.map(entry => [entry.type, entry.description])).toEqual([['project', `${seat} acked 6 mails: 0 decisions · 1 alerts · 3 requests · 2 info (2 routine · 0 duplicate dropped)`]]);
  } finally { store.close(); }
});
