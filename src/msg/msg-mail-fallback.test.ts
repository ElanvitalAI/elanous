// OP 11-17 21:5x — eln 자리 우편 60초 안전망: 받음(delivered↑ 영수증 · ack/커서)이 없을 때만 «우편 확인» 한 번.
// 임시 원장 · 가짜 잠(즉시) · 가짜 깨움(실제 herdr 0).
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { MsgStore, readUnreadSource, readUnreadSummary } from './msg-store.js';
import { mailFallbackSpawnArgv, mailReceived, runMailFallback, spawnMailFallback } from './msg-mail-fallback.js';
import { debug } from '../debug/log.js';
import { agentTurnBanner } from '../tui/chat/continue-banner.js';
import { agentMailTurnText, createNextMailWake, ledgerRecordDelivered, localDueHHMM, mailWakeSource } from '../tui-client/next-mail-wake.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-fallback-'));
  dirs.push(dir);
  return join(dir, 'messages.db');
}

test('nothing received in 60s → one knock; a second checker never knocks again', async () => {
  const path = ledger();
  const writer = new MsgStore(path);
  const posted = writer.post({ from: 'OP', to: 'HAND-X', body: 'b' });
  writer.close();
  const knocks: Array<[string, number, unknown]> = [];
  const slept: number[] = [];
  const deps = {
    openStore: () => new MsgStore(path), sleep: async (ms: number) => { slept.push(ms); },
    wake: async (address: string, msgId: number, message: unknown) => { knocks.push([address, msgId, message]); return { result: 'injected' }; },
  };
  expect(await runMailFallback({ messageId: posted.id, recipient: 'HAND-X', from: 'OP' }, deps)).toBe('knocked');
  expect(await runMailFallback({ messageId: posted.id, recipient: 'HAND-X', from: 'OP' }, deps)).toBe('already-knocked');
  expect(slept).toEqual([60_000, 60_000]);
  expect(knocks).toEqual([['HAND-X', posted.id, { from: 'OP', fallback: true }]]);
});

test('received = delivered receipt (mail-wake turn opened) or ack → no knock', async () => {
  const path = ledger();
  const writer = new MsgStore(path);
  const a = writer.post({ from: 'OP', to: 'HAND-X', body: 'a' });
  const b = writer.post({ from: 'OP', to: 'HAND-Y', body: 'b' });
  expect(mailReceived(writer, a.id, 'HAND-X')).toBe(false);
  writer.close();
  // 우편 깨움이 턴을 연 순간 = delivered(본문은 아직 맥락에 없으니 seen 아님 · ack 안 씀).
  ledgerRecordDelivered(path)('HAND-X', a.id, 'auto-1');
  const reader = new MsgStore(path);
  try {
    expect(reader.listReceipts({ messageId: a.id }).map(r => [r.state, r.source, r.queueItemId])).toEqual([['posted', 'ledger', undefined], ['delivered', 'tui-mail-wake', 'auto-1']]);
    expect(reader.messageStatus('HAND-X', a.id)).toBe('delivered'); // 아직 안 읽음 — list 에서 안 숨는다
    expect(mailReceived(reader, a.id, 'HAND-X')).toBe(true);
    reader.ackMessage('HAND-Y', b.id);
    expect(mailReceived(reader, b.id, 'HAND-Y')).toBe(true);
  } finally { reader.close(); }
  const knocks: number[] = [];
  const deps = { openStore: () => new MsgStore(path), sleep: async () => {}, wake: async (_a: string, id: number) => { knocks.push(id); return { result: 'injected' }; } };
  expect(await runMailFallback({ messageId: a.id, recipient: 'HAND-X', from: 'OP' }, deps)).toBe('received');
  expect(await runMailFallback({ messageId: b.id, recipient: 'HAND-Y', from: 'OP' }, deps)).toBe('received');
  expect(knocks).toEqual([]);
});

test('msg post: an eln-mail-watch wake starts the 60s checker once; any other wake result does not', async () => {
  const path = ledger();
  const spawned: unknown[] = [];
  let result = 'eln-mail-watch';
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path), out: { log: () => {}, error: () => {} }, setExitCode: () => {}, registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'herdr', source: 'seat-registry', address, msgId, result: result as never }),
    spawnMailFallback: input => { spawned.push(input); },
  });
  await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'HAND-X', '--body', 'b1'], { from: 'user' });
  result = 'injected';
  await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'HAND-X', '--body', 'b2'], { from: 'user' });
  expect(spawned).toEqual([{ messageId: 1, recipient: 'HAND-X', from: 'OP' }]);
});

test('eln msg mail-fallback runs the same check with the wake seam and prints the result', async () => {
  const path = ledger();
  const writer = new MsgStore(path);
  writer.post({ from: 'OP', to: 'HAND-X', body: 'b' });
  writer.close();
  const lines: string[] = [];
  const woke: unknown[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path), out: { log: line => lines.push(String(line)), error: () => {} }, setExitCode: () => {},
    fallbackSleep: async () => {},
    wake: async (address, msgId, message) => { woke.push([address, msgId, message]); return { wake: 'herdr', source: 'seat-registry', address, msgId, result: 'injected' }; },
  });
  await program.parseAsync(['msg', 'mail-fallback', '--msg', '1', '--to', 'HAND-X', '--from', 'OP'], { from: 'user' });
  expect(lines).toEqual(['knocked']);
  expect(woke).toEqual([['HAND-X', 1, { from: 'OP', fallback: true }]]);
});

test('#38285 REVIEW ① — the real spawn path: execPath + CLI entry + msg mail-fallback argv, detached, and it actually runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-fallback-spawn-'));
  dirs.push(dir);
  const out = join(dir, 'argv.json');
  const entry = join(dir, 'fake-eln.js');
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  const input = { messageId: 42, recipient: 'HAND-X', from: 'OP' };
  expect(mailFallbackSpawnArgv(input, { execPath: '/bin/bun', entry: '/x/eln' }))
    .toEqual(['/bin/bun', '/x/eln', 'msg', 'mail-fallback', '--msg', '42', '--to', 'HAND-X', '--from', 'OP']);
  expect(spawnMailFallback(input, { execPath: process.execPath, entry })).toBe(true);
  // Source: #38285 REVIEW ① — the detached child gets a few seconds to write its argv (no timer in the product path).
  for (let i = 0; i < 250 && !existsSync(out); i++) await Bun.sleep(20);
  expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['msg', 'mail-fallback', '--msg', '42', '--to', 'HAND-X', '--from', 'OP']);
});

test('#38285 REVIEW ① — no CLI entry: the safety net does not start and says so (spawn-skipped), never silent', () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((_category, event, data) => { events.push({ event, data }); });
  try {
    expect(spawnMailFallback({ messageId: 7, recipient: 'HAND-X', from: 'OP' }, { entry: undefined })).toBe(false);
  } finally { spy.mockRestore(); }
  expect(events).toContainEqual({ event: 'spawn-skipped', data: { msgId: 7, to: 'HAND-X', reason: 'no-cli-entry' } });
});

test('MAIL-SOURCE-AND-FALLBACK: one post starts the 60s checker, and the mail-wake turn on that ledger stops the knock', async () => {
  const path = ledger();
  const spawned: Array<{ messageId: number; recipient: string; from: string }> = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path), out: { log: () => {}, error: () => {} }, setExitCode: () => {}, registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'herdr', source: 'seat-registry', address, msgId, result: 'eln-mail-watch' }),
    spawnMailFallback: input => { spawned.push(input); },
  });
  await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'HAND-X', '--body', '같은 설치의 한 통', '--intent', 'request', '--deadline', '2026-11-18T05:00:00.000Z', '--done', 'the mail turn opened'], { from: 'user' });
  expect(spawned).toEqual([{ messageId: 1, recipient: 'HAND-X', from: 'OP' }]);

  const due = '05:00';
  const opened: Array<{ text: string; from?: { seat?: string; msgId?: string } }> = [];
  const wake = createNextMailWake({
    seat: 'HAND-X', enabled: true,
    readUnread: seat => readUnreadSummary(seat, path),
    readSource: seat => readUnreadSource(seat, path),
    recordDelivered: ledgerRecordDelivered(path),
    formatDue: () => due,
    startTurnIfIdle: (text, opts) => { opened.push({ text, from: opts.from }); return { opened: true, turnId: 'mail-1' }; },
  });
  wake.poll();
  wake.confirmDelivery();
  wake.dispose();
  const source = readUnreadSource('HAND-X', path);
  expect(source?.latestId).toBe(1);
  expect(opened).toEqual([{ text: agentMailTurnText(source!), from: mailWakeSource(source, () => due) }]);
  expect(agentTurnBanner(opened[0]!.from!)).toBe('⇢ OP · request · due 05:00 · #1');

  const knocks: number[] = [];
  expect(await runMailFallback(spawned[0]!, {
    openStore: () => new MsgStore(path), sleep: async () => {},
    wake: async (_address: string, id: number) => { knocks.push(id); return { result: 'injected' }; },
  })).toBe('received');
  expect(knocks).toEqual([]);
});

test('MAIL-SOURCE-AND-FALLBACK: one ledger draws the agent line, knocks once with no receipt, and the mail-wake turn carries the body', async () => {
  const path = ledger();
  const writer = new MsgStore(path);
  const posted = writer.post({
    from: 'OP', to: 'HAND-X', body: '세 줄을 같은 설치에서', intent: 'request',
    deadlineAt: '2026-11-18T05:00:00.000Z', origin: { kind: 'agent', seat: 'OP' },
  });
  writer.close();
  const due = localDueHHMM('2026-11-18T05:00:00.000Z');
  expect(due).toMatch(/^\d{2}:\d{2}$/);
  const source = readUnreadSource('HAND-X', path);
  expect(source?.latestId).toBe(posted.id);
  const from = mailWakeSource(source, () => due);
  expect(from && agentTurnBanner(from)).toBe(`⇢ OP · request · due ${due} · #${posted.id}`);

  const knocks: number[] = [];
  const silent = { openStore: () => new MsgStore(path), sleep: async () => {}, wake: async (_a: string, id: number) => { knocks.push(id); return { result: 'injected' }; } };
  expect(await runMailFallback({ messageId: posted.id, recipient: 'HAND-X', from: 'OP' }, silent)).toBe('knocked');
  expect(await runMailFallback({ messageId: posted.id, recipient: 'HAND-X', from: 'OP' }, silent)).toBe('already-knocked');
  expect(knocks).toEqual([posted.id]);

  const opened: Array<{ text: string; from?: { seat?: string; msgId?: string } }> = [];
  const wake = createNextMailWake({
    seat: 'HAND-X', enabled: true,
    readUnread: seat => readUnreadSummary(seat, path),
    readSource: seat => readUnreadSource(seat, path),
    recordDelivered: ledgerRecordDelivered(path),
    formatDue: () => due,
    startTurnIfIdle: (text, opts) => { opened.push({ text, from: opts.from }); return { opened: true, turnId: 'mail-1' }; },
  });
  wake.poll();
  wake.dispose();
  expect(opened).toEqual([{ text: agentMailTurnText(source!), from }]);
  const after = new MsgStore(path);
  try {
    expect(after.listReceipts({ messageId: posted.id }).some(row => row.state === 'delivered' && row.source === 'tui-mail-wake')).toBe(true);
    expect(mailReceived(after, posted.id, 'HAND-X')).toBe(true);
  } finally { after.close(); }
});
