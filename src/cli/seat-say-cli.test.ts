// ELN-SEAT-SAY · A217 — `eln seat say` = 같은 `msg post`(원장 · 깨움) · 요청은 due·done 필수 · 마감 표기 해석.
// 임시 원장 · 고정 시계 · 깨움은 가짜(실제 pty/herdr 0).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { parseDue, registerMsgCommands } from './msg-cli.js';
import { registerSeatSayCommand, seatSayPostArgv } from './seat-say-cli.js';

const NOW = new Date(2026, 10, 17, 21, 50, 0); // local 21:50 — fixed clock
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'seat-say-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const woke: Array<{ address: string; msgId: number }> = [];
  const post = async (argv: string[]): Promise<number> => {
    const before = exits.length;
    const msg = new Command();
    registerMsgCommands(msg, {
      openStore: () => new MsgStore(path), now: () => NOW,
      out: { log: line => stdout.push(line), error: line => stderr.push(line) },
      setExitCode: code => exits.push(code), registerLogSink: async () => undefined,
      wake: async (address, msgId) => { woke.push({ address, msgId }); return { wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }; },
    });
    await msg.parseAsync(['msg', 'post', ...argv], { from: 'user' });
    return exits.length > before ? exits.at(-1)! : 0;
  };
  const program = new Command();
  const seat = program.command('seat');
  registerSeatSayCommand(seat, { post, out: { log: line => stdout.push(line), error: line => stderr.push(line) } });
  return { run: (...args: string[]) => program.parseAsync(['seat', 'say', ...args], { from: 'user' }), path, stdout, stderr, exits, woke };
}

test('seat say → one ledger row from an agent seat · request · due · done, woken once', async () => {
  const w = world();
  await w.run('TC', 'B1-C 에 요청 계약 반영', '--from', 'OP', '--due', '+30m', '--done', '15분 미확인 요청이 기다림 원장에 뜸');
  expect(w.exits).toEqual([]);
  const store = new MsgStore(w.path);
  try {
    const [row] = store.listByRecipient('TC');
    expect(row).toMatchObject({ from: 'OP', to: 'TC', body: 'B1-C 에 요청 계약 반영', intent: 'request', needsAck: true,
      deadlineAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(), doneWhen: '15분 미확인 요청이 기다림 원장에 뜸',
      origin: { kind: 'agent', seat: 'OP' } });
    expect(w.woke).toEqual([{ address: 'TC', msgId: row!.id }]);
  } finally { store.close(); }
  expect(w.stdout.at(-1)).toBe('follow: eln msg receipts --from OP --follow --until seen');
});

test('A217 · MSG-FILTERS-RELAX: a request without due or done is stored and woken, with a warning', async () => {
  const w = world();
  await w.run('TC', '마감 없는 요청', '--from', 'OP');
  expect(w.exits).toEqual([]);
  expect(w.stderr.join('\n')).toContain('msg post 경고: --intent request 에 --deadline <due> 와 --done <condition> 이 없다 (A217 요청 계약) — 그대로 저장한다');
  expect(w.woke).toHaveLength(1);
  const store = new MsgStore(w.path);
  try { expect(store.listByRecipient('TC').map(row => [row.body, row.intent])).toEqual([['마감 없는 요청', 'request']]); } finally { store.close(); }
  // info 는 계약 밖 — due 없이도 간다.
  await w.run('TC', '참고', '--from', 'OP', '--intent', 'info');
  expect(w.woke).toHaveLength(2);
});

test('parseDue — ISO · HH:MM (next occurrence) · +n m|h · anything else refused', () => {
  expect(parseDue('+15m', NOW)).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString());
  expect(parseDue('+2h', NOW)).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  expect(parseDue('23:00', NOW)).toBe(new Date(2026, 10, 17, 23, 0, 0).toISOString());
  expect(parseDue('09:30', NOW)).toBe(new Date(2026, 10, 18, 9, 30, 0).toISOString()); // already past → tomorrow
  // 옛 --deadline 이 받던 값은 그대로(회귀 0 · #38198 REVIEW-2 ④): ISO · 날짜만 · T 없는 꼴.
  for (const old of ['2026-11-18T03:00:00Z', '2026-11-18', '2026-11-18 03:00']) expect(parseDue(old, NOW)).toBe(old);
  for (const bad of ['soon', '25:00', '+5d', '']) expect(() => parseDue(bad, NOW)).toThrow('--deadline must be');
});

test('seatSayPostArgv is the whole contract — the same msg post words', () => {
  expect(seatSayPostArgv('JUD', '판정 부탁', { from: 'OP', due: '14:00', done: 'JUD 서명' }))
    .toEqual(['--from', 'OP', '--to', 'JUD', '--intent', 'request', '--deadline', '14:00', '--done', 'JUD 서명', '--body', '판정 부탁']);
});
