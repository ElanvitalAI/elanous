import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { MsgStore } from '../msg/msg-store.js';
import { loadRhythm, renderPulseBrief } from './op-pulse.js';
import { verifyBeats } from './op-pulse-run.js';

test('the actual suggested post is accepted and verifies only its original marked window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pulse-mail-contract-'));
  const db = join(root, 'messages.db');
  const ledger = join(root, 'pulse.jsonl');
  const window = '2026-11-27T02:00:00.000Z';
  const now = new Date('2026-11-27T02:05:00.000Z');
  const brief = renderPulseBrief({ window, phase: { phase: 'build', evidence: 'test' },
    row: loadRhythm(join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml')).rows.get('build')!,
    gaps: [{ metric: 'landed/h', space: 'TC', value: 3, target: '≥ 10' }], table: 't', phaseChanged: null, tablePath: '/test' });
  const suggested = /`(eln msg post [^`]+)`/.exec(brief)?.[1];
  expect(suggested).toBeDefined();
  // Substitute only the documented leader/body placeholders; preserve all actual flags and the window tag.
  const command = suggested!.replace('<리더>', 'TC').replace('…', 'next window');
  const tokens = command.match(/(?:[^\s"]+|"[^"]*")+/g)!.map(s => s.replace(/^"|"$/g, ''));
  expect(tokens.slice(0, 3)).toEqual(['eln', 'msg', 'post']);
  const errors: string[] = [];
  const exits: number[] = [];
  const cli = new Command();
  cli.exitOverride();
  registerMsgCommands(cli, {
    openStore: () => new MsgStore(db),
    out: { log: () => {}, error: line => errors.push(line) },
    setExitCode: code => exits.push(code), callerSeat: () => null,
    registerLogSink: async () => undefined, saveAckDigest: async () => {},
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    wakeDeps: { seatStateRoot: root, stateRoot: root, live: false },
  });
  try {
    // The negative is also a real parsed, stored post, not a fabricated mail object.
    await cli.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'TC', '--kind', 'beat', '--body', 'unmarked'], { from: 'user' });
    let store = new MsgStore(db);
    let mails;
    try { mails = store.list('TC'); } finally { store.close(); }
    expect(mails).toHaveLength(1);
    expect(verifyBeats({ ledger, window, mails, now }).ok).toBe(false);
    expect(existsSync(ledger)).toBe(false);
    await cli.parseAsync(tokens.slice(1), { from: 'user' });
    expect(exits).toEqual([]);
    expect(errors.filter(e => /refused|unknown --kind/i.test(e))).toEqual([]);
    store = new MsgStore(db);
    try { mails = store.list('TC'); } finally { store.close(); }
    expect(mails).toHaveLength(2);
    const marked = mails.find(m => m.body.includes(`[pulse ${window}]`));
    expect(marked).toMatchObject({ from: 'OP', to: 'TC', kind: 'beat', body: `[pulse ${window}] next window` });
    const result = verifyBeats({ ledger, window, mails, now });
    expect(result).toEqual({ ok: true, beats: [{ id: marked!.id, to: 'TC' }] });
    const entries = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toEqual([{ goal: 'met', window, beats: [`#${marked!.id}→TC`], at: now.toISOString() }]);
    expect(verifyBeats({ ledger, window: '2026-11-27T03:00:00.000Z', mails, now }).ok).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
