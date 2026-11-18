// SEAT-INBOX B1-C §4c — `eln msg receipts [--follow]` · `eln msg receipt`. in-process commander(직접 spawn 0 · R-LIVE10)
// ⊕ 임시 원장 ⊕ 포트 0 우체국 SSE. 폴링 타이머 없이 SSE `event: receipt` 만으로 따라간다.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { receiptReaches } from '../msg/msg-receipts.js';
import { startMsgSseServer } from '../msg/msg-sse-server.js';
import { parseReceiptFrames, registerMsgReceiptsCommands, RECEIPTS_EXIT_NO_POST_OFFICE } from './msg-receipts-cli.js';

const TOKEN = 'inbox-b1c-token';
const FIXED = new Date('2026-11-17T09:00:00.000Z');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

function fixture(options: { withServer?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'msg-inbox-b1c-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'messages.db');
  const writer = new MsgStore(path, { now: () => FIXED });
  cleanups.push(() => writer.close());
  let url: string | null = null;
  if (options.withServer) {
    const serverStore = new MsgStore(path);
    // 서버 원장 스캔 주기는 원래 서버 계약(1–500ms)의 하한 — 시험 시간을 줄이려는 값일 뿐 판정값이 아니다.
    const server = startMsgSseServer({ store: serverStore, token: TOKEN, port: 0, pollMs: 1 });
    cleanups.push(() => { server.stop(); serverStore.close(); });
    url = `http://127.0.0.1:${server.port}`;
  }
  const lines: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const waiters: Array<{ match: (line: string) => boolean; resolve: () => void }> = [];
  const signal = new AbortController();
  const deps = {
    openStore: () => new MsgStore(path, { now: () => FIXED }),
    out: {
      log: (line: string) => {
        lines.push(line);
        for (const waiter of waiters.splice(0)) { if (waiter.match(line)) waiter.resolve(); else waiters.push(waiter); }
      },
      error: (line: string) => { errors.push(line); },
    },
    setExitCode: (code: number) => { exits.push(code); },
    signal: signal.signal,
    authToken: () => TOKEN,
    handleSignals: false,
    reconnectMs: 1,
    discoverUrl: async () => url,
    // A217 overdue clock — 20분 뒤(원장 created_at 은 실제 시각이라 상대값으로 둔다).
    now: () => new Date(Date.now() + 20 * 60_000),
  };
  // 매 호출마다 새 commander — 앞 호출의 옵션 값이 다음 호출로 새지 않게.
  const run = (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerMsgReceiptsCommands(program.command('msg'), deps);
    return program.parseAsync(['node', 'eln', 'msg', ...args]);
  };
  const nextLine = (match: (line: string) => boolean) => new Promise<void>(resolve => {
    if (lines.some(match)) resolve(); else waiters.push({ match, resolve });
  });
  return { writer, path, url, lines, errors, exits, signal, run, nextLine };
}

test('receipts <id> — 원장의 영수증을 덧붙인 순서대로(본문 없음)', async () => {
  const f = fixture();
  const posted = f.writer.post({ from: 'OP', to: 'TC', body: 'inbox-b1c 본문' });
  f.writer.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'delivered', source: 'tui-queue', queueItemId: 'q1' });
  await f.run('receipts', String(posted.id), '--json');
  expect(f.lines.map(line => JSON.parse(line).state)).toEqual(['posted', 'delivered']);
  for (const line of f.lines) expect(line).not.toContain('inbox-b1c 본문');
  expect(f.exits).toEqual([]);
});

test('--follow --until seen — 우체국 SSE 로 delivered → seen 이 순서대로 오고 seen 에서 끝난다', async () => {
  const f = fixture({ withServer: true });
  const posted = f.writer.post({ from: 'OP', to: 'TC', body: 'inbox-b1c 본문' });
  const done = f.run('receipts', String(posted.id), '--follow', '--until', 'seen', '--json');
  await f.nextLine(line => JSON.parse(line).state === 'posted');
  f.writer.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'delivered', source: 'tui-queue', queueItemId: 'q1' });
  f.writer.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'seen', source: 'tui-queue', queueItemId: 'q1' });
  await done;
  expect(f.lines.map(line => JSON.parse(line).state)).toEqual(['posted', 'delivered', 'seen']);
  expect(f.exits).toEqual([]);
});

test('--follow --from OP — 신호(abort)로 깨끗이 끝난다 · 다른 자리가 보낸 우편의 영수증은 안 온다', async () => {
  const f = fixture({ withServer: true });
  const mine = f.writer.post({ from: 'OP', to: 'TC', body: 'a' });
  const done = f.run('receipts', '--from', 'OP', '--follow');
  await f.nextLine(line => line.includes(`msg:${mine.id} `) && line.includes(' posted '));
  const theirs = f.writer.post({ from: 'MK', to: 'TC', body: 'b' });
  f.writer.recordReceipt({ messageId: theirs.id, recipient: 'TC', state: 'delivered', source: 'tui-queue' });
  f.writer.recordReceipt({ messageId: mine.id, recipient: 'TC', state: 'delivered', source: 'tui-queue' });
  await f.nextLine(line => line.includes(`msg:${mine.id} `) && line.includes(' delivered '));
  f.signal.abort();
  await done;
  expect(f.lines.every(line => !line.includes(`msg:${theirs.id} `))).toBe(true);
  expect(f.exits).toEqual([]);
});

test('--follow 인데 우체국이 없으면 원장 폴링으로 대신하지 않고 종료 코드 3', async () => {
  const f = fixture();
  const posted = f.writer.post({ from: 'OP', to: 'TC', body: 'x' });
  await f.run('receipts', String(posted.id), '--follow');
  expect(f.exits).toEqual([RECEIPTS_EXIT_NO_POST_OFFICE]);
  expect(f.lines).toHaveLength(1);
});

test('receipt <id> accepted|rejected|done — 명시 구조 행동 · 근거 없는 done 은 거부', async () => {
  const f = fixture();
  const posted = f.writer.post({ from: 'OP', to: 'TC', body: 'x', kind: 'question' });
  await f.run('receipt', String(posted.id), 'accepted', '--to', 'TC', '--plan-item', 'p1', '--json');
  expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({ state: 'accepted', planItemId: 'p1', source: 'cli' });
  await f.run('receipt', String(posted.id), 'done', '--to', 'TC');
  expect(f.exits).toEqual([2]);
  expect(f.errors.at(-1)).toContain('done needs --evidence <text>');
  await f.run('receipt', String(posted.id), 'seen', '--to', 'TC');
  expect(f.errors.at(-1)).toContain('state must be accepted, rejected or done');
});

test('SSE 틀 해석 — event: receipt 만 · keepalive·다른 사건은 건너뛴다', () => {
  const frame = (state: string, id: number) => `event: receipt\nid: ${id}\ndata: ${JSON.stringify({ id, state })}\n\n`;
  const parsed = parseReceiptFrames(`: keepalive\n\n${frame('posted', 1)}data: {"id":9}\n\n${frame('seen', 2)}event: rec`);
  expect(parsed.receipts.map(r => r.state)).toEqual(['posted', 'seen']);
  expect(parsed.rest).toBe('event: rec');
});

test('#38194 REVIEW-1 ⑥ — /receipts?msg=0 is a bad request, not an empty stream', async () => {
  const f = fixture({ withServer: true });
  for (const bad of ['0', '-1', 'abc']) {
    const response = await fetch(`${f.url}/receipts?msg=${bad}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(400);
    await response.text();
  }
});

test('#38216 REVIEW-1 ① — a 1000-receipt replay streams under backpressure without the slow-subscriber cut', async () => {
  const f = fixture({ withServer: true });
  const REPLAY = 1000; // Source: #38216 REVIEW-1 ① — OP: «영수증 1000건 replay 끊김 없음»
  for (let i = 0; i < REPLAY; i++) f.writer.post({ from: 'OP', to: 'TC', body: `b${i}` });
  const response = await fetch(`${f.url}/receipts?from=OP&since=0`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const ids: number[] = [];
  while (ids.length < REPLAY) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const parsed = parseReceiptFrames(pending + decoder.decode(chunk.value, { stream: true }));
    pending = parsed.rest;
    for (const receipt of parsed.receipts) ids.push(receipt.id);
  }
  await reader.cancel();
  expect(ids).toHaveLength(REPLAY);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(REPLAY);
}, 30_000);

test('#38244 REVIEW-1 ② — --until seen ends when the receipt skips past seen (delivered → done), live and from the ledger', async () => {
  const f = fixture({ withServer: true });
  const posted = f.writer.post({ from: 'OP', to: 'TC', body: 'skip seen' });
  const done = f.run('receipts', String(posted.id), '--follow', '--until', 'seen', '--json');
  await f.nextLine(line => JSON.parse(line).state === 'posted');
  f.writer.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'delivered', source: 'tui-queue', queueItemId: 'q1' });
  f.writer.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'done', source: 'cli', evidence: 'PR merged' });
  await done; // without the ordered rule this never ends
  expect(f.lines.map(line => JSON.parse(line).state)).toEqual(['posted', 'delivered', 'done']);
  // Already past `until` in the ledger: no subscription at all.
  const g = fixture();
  const old = g.writer.post({ from: 'OP', to: 'TC', body: 'rejected already' });
  g.writer.recordReceipt({ messageId: old.id, recipient: 'TC', state: 'rejected', source: 'cli', reason: 'dup' });
  await g.run('receipts', String(old.id), '--follow', '--until', 'seen', '--json');
  expect(g.lines.map(line => JSON.parse(line).state)).toEqual(['posted', 'rejected']);
  expect(g.exits).toEqual([]);
});

test('receiptReaches — order posted<delivered<seen<accepted<terminal · terminal always ends · overdue matches only itself', () => {
  expect(receiptReaches('done', 'seen')).toBe(true);
  expect(receiptReaches('expired', 'seen')).toBe(true);
  expect(receiptReaches('accepted', 'seen')).toBe(true);
  expect(receiptReaches('delivered', 'seen')).toBe(false);
  expect(receiptReaches('rejected', 'accepted')).toBe(true);
  expect(receiptReaches('overdue', 'seen')).toBe(false);
  expect(receiptReaches('overdue', 'overdue')).toBe(true);
  expect(receiptReaches('done', 'overdue')).toBe(false);
});

test('A217 overdue — unseen requests after 15m in the A216 register shape · seen/acked/info excluded · --mark once', async () => {
  const f = fixture();
  const unseen = f.writer.post({ from: 'OP', to: 'TC', body: '본문-비밀', intent: 'request', deadlineAt: '2026-11-18T03:00:00.000Z', doneWhen: 'receipt' });
  const delivered = f.writer.post({ from: 'OP', to: 'JUD', body: 'x', intent: 'request' });
  f.writer.recordReceipt({ messageId: delivered.id, recipient: 'JUD', state: 'delivered', source: 'tui-queue', queueItemId: 'q1' });
  const seen = f.writer.post({ from: 'OP', to: 'RES', body: 'x', intent: 'request' });
  f.writer.recordReceipt({ messageId: seen.id, recipient: 'RES', state: 'seen', source: 'tui-queue', queueItemId: 'q2' });
  const acked = f.writer.post({ from: 'OP', to: 'MK', body: 'x', intent: 'request' });
  f.writer.ackMessage('MK', acked.id);
  f.writer.post({ from: 'OP', to: 'TC', body: 'x', intent: 'info' });
  f.writer.post({ from: 'OP', to: 'ALL', body: 'x', intent: 'request' });
  await f.run('overdue', '--json', '--mark');
  const rows = f.lines.map(line => JSON.parse(line) as Record<string, unknown>);
  // 최근 초과 먼저(#38198 REVIEW-2 ①).
  expect(rows.map(r => r.id)).toEqual([`MSG${delivered.id}-JUD`, `MSG${unseen.id}-TC`]);
  expect(rows[1]).toMatchObject({ kind: 'seat-request', owner: 'TC', deadline: '2026-11-18T03:00:00.000Z', source: `msg#${unseen.id}`, done: 'receipt' });
  expect(rows[0]!.reason).toContain('receipt delivered');
  for (const row of rows) for (const key of ['id', 'kind', 'owner', 'deadline', 'reason', 'next-action', 'source']) expect(typeof row[key]).toBe('string');
  expect(f.lines.join('\n')).not.toContain('본문-비밀');
  expect(f.writer.listReceipts({ messageId: unseen.id }).map(r => r.state)).toEqual(['posted', 'overdue']);
  await f.run('overdue', '--mark');
  expect(f.writer.listReceipts({ messageId: unseen.id }).map(r => r.state)).toEqual(['posted', 'overdue']); // once
  expect(f.exits).toEqual([]);
});

test('#38198 REVIEW-2 ① — old requests to a retired seat (outside --within) never crowd out a fresh unseen one', async () => {
  const f = fixture();
  const stale = f.writer.post({ from: 'OP', to: 'RETIRED', body: 'x', intent: 'request' });
  // 이틀 전 우편 — 퇴역 자리 앞 미확인 요청(창 밖).
  f.writer.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86_400_000).toISOString(), stale.id);
  const fresh = f.writer.post({ from: 'OP', to: 'TC', body: 'x', intent: 'request' });
  await f.run('overdue', '--json');
  expect(f.lines.map(line => (JSON.parse(line) as { id: string }).id)).toEqual([`MSG${fresh.id}-TC`]);
  f.lines.length = 0;
  await f.run('overdue', '--json', '--within', '4320');
  expect(f.lines.map(line => (JSON.parse(line) as { id: string }).id)).toEqual([`MSG${fresh.id}-TC`, `MSG${stale.id}-RETIRED`]);
  await f.run('overdue', '--within', '10');
  expect(f.exits).toEqual([2]); // --within 은 --after 보다 커야 한다
});

test('#38219 REVIEW-2 ④ — a failed overdue --mark is reported, never swallowed; the listing still stands', async () => {
  const f = fixture();
  const unseen = f.writer.post({ from: 'OP', to: 'TC', body: 'x', intent: 'request' });
  f.writer.db.exec(`CREATE TRIGGER fail_overdue BEFORE INSERT ON msg_receipts WHEN NEW.state = 'overdue' BEGIN SELECT RAISE(ABORT, 'overdue write failed'); END;`);
  await f.run('overdue', '--json', '--mark');
  expect(f.lines.map(line => (JSON.parse(line) as { id: string }).id)).toEqual([`MSG${unseen.id}-TC`]);
  expect(f.errors.join('\n')).toContain('overdue 영수증 기록 실패');
  expect(f.errors.join('\n')).toContain('overdue write failed');
});

describe('MSG-RECEIPTS-FOLLOWUP (#84659 A · TC)', () => {
  const rig = (fetchImpl: () => Promise<Response>) => {
    const dir = mkdtempSync(join(tmpdir(), 'msg-receipts-fu-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'messages.db');
    const writer = new MsgStore(path);
    cleanups.push(() => writer.close());
    const errors: string[] = [];
    const exits: number[] = [];
    const signal = new AbortController();
    const program = new Command();
    program.exitOverride();
    registerMsgReceiptsCommands(program.command('msg'), {
      openStore: () => new MsgStore(path), out: { log: () => {}, error: (line: string) => { errors.push(line); } },
      setExitCode: (code: number) => { exits.push(code); }, signal: signal.signal, authToken: () => TOKEN, handleSignals: false,
      reconnectMs: 1, discoverUrl: async () => 'http://127.0.0.1:1', fetch: fetchImpl as unknown as typeof fetch,
    });
    return { writer, errors, exits, signal, run: (...args: string[]) => program.parseAsync(['node', 'eln', 'msg', ...args]) };
  };

  test('② 401 is judged by its class (fail at once); a different error that merely mentions «401» reconnects', async () => {
    const unauthorized = rig(async () => new Response(null, { status: 401 }));
    const posted = unauthorized.writer.post({ from: 'OP', to: 'TC', body: 'x' });
    await unauthorized.run('receipts', String(posted.id), '--follow');
    expect(unauthorized.exits).toEqual([2]);
    expect(unauthorized.errors.join('\n')).toContain('SSE unauthorized (401)');
    let calls = 0;
    const lookalike = rig(async () => { calls += 1; if (calls >= 2) lookalike.signal.abort(); throw new Error('connect ECONNREFUSED 127.0.0.1:4010'); });
    const other = lookalike.writer.post({ from: 'OP', to: 'TC', body: 'y' });
    await lookalike.run('receipts', String(other.id), '--follow');
    expect(lookalike.exits).toEqual([]); // reconnected, then ended by the signal — not an unauthorized failure
    expect(lookalike.errors.some(line => line.includes('스트림 끊김'))).toBe(true);
  });

  test('TC ① rejected / done name the missing flag and an example before anything is stored', async () => {
    const f = fixture();
    const posted = f.writer.post({ from: 'OP', to: 'TC', body: 'x' });
    await f.run('receipt', String(posted.id), 'rejected', '--to', 'TC');
    expect(f.errors.at(-1)).toContain('rejected needs --reason <text>');
    expect(f.writer.listReceipts({ messageId: posted.id }).map(r => r.state)).toEqual(['posted']);
  });
});

test('SEAT-MAIL-ACK-SLA — --stage ack keeps a seen-but-undecided request · accepted/rejected/done leave the list', async () => {
  const f = fixture();
  const seenOnly = f.writer.post({ from: 'OP', to: 'TC', body: 'x', intent: 'request' });
  f.writer.recordReceipt({ messageId: seenOnly.id, recipient: 'TC', state: 'seen', source: 'tui-queue', queueItemId: 'q1' });
  const handAcked = f.writer.post({ from: 'OP', to: 'RES', body: 'x', intent: 'request' });
  f.writer.ackMessage('RES', handAcked.id);
  const accepted = f.writer.post({ from: 'OP', to: 'JUD', body: 'x', intent: 'request' });
  f.writer.recordReceipt({ messageId: accepted.id, recipient: 'JUD', state: 'accepted', source: 'cli' });
  const rejected = f.writer.post({ from: 'OP', to: 'MK', body: 'x', intent: 'request' });
  f.writer.recordReceipt({ messageId: rejected.id, recipient: 'MK', state: 'rejected', source: 'cli', reason: 'dup' });
  await f.run('overdue', '--json');
  expect(f.lines).toEqual([]); // stage seen: all of them were seen (or acked)
  await f.run('overdue', '--json', '--stage', 'ack');
  const ids = f.lines.map(line => (JSON.parse(line) as { id: string }).id).sort();
  expect(ids).toEqual([`MSG${handAcked.id}-RES`, `MSG${seenOnly.id}-TC`].sort());
  expect(f.lines.join('\n')).toContain('undecided 15m');
  await f.run('overdue', '--stage', 'later');
  expect(f.exits).toEqual([2]);
});

test('SEAT-MAIL-ACK-SLA — --mark --notify alerts the sender and OP once per overdue request · never the body · rerun alerts nobody', async () => {
  const f = fixture();
  const fromRes = f.writer.post({ from: 'RES', to: 'TC', body: '본문-비밀', intent: 'request' });
  const fromOp = f.writer.post({ from: 'OP', to: 'UX', body: '본문-비밀', intent: 'request' });
  await f.run('overdue', '--mark', '--notify', '--stage', 'ack');
  const alerts = (to: string) => f.writer.listByRecipient(to).filter(m => m.from === 'MSG-SLA');
  expect(alerts('RES').map(m => m.refs)).toEqual([[`msg#${fromRes.id}`]]);
  expect(alerts('OP').map(m => m.refs).sort()).toEqual([[`msg#${fromOp.id}`], [`msg#${fromRes.id}`]].sort());
  expect(alerts('TC')).toEqual([]); // the late seat itself is not mailed again
  for (const m of [...alerts('RES'), ...alerts('OP')]) {
    expect(m.body).not.toContain('본문-비밀');
    expect(m).toMatchObject({ kind: 'alert', intent: 'alert', origin: { kind: 'system', seat: 'MSG-SLA' } });
  }
  await f.run('overdue', '--mark', '--notify', '--stage', 'ack');
  expect(alerts('OP')).toHaveLength(2); // once-only
});

test('#38361 Terra ① — a plain --mark run or the seen stage never uses up the ack-stage alert (separate per stage)', async () => {
  const f = fixture();
  const req = f.writer.post({ from: 'RES', to: 'TC', body: 'x', intent: 'request' });
  await f.run('overdue', '--mark'); // stage seen, no alert: the overdue receipt is recorded
  await f.run('overdue', '--mark', '--stage', 'ack'); // same receipt, still no alert
  const alerts = (to: string) => f.writer.listByRecipient(to).filter(m => m.from === 'MSG-SLA');
  expect(alerts('OP')).toEqual([]);
  await f.run('overdue', '--mark', '--notify', '--stage', 'ack');
  expect(alerts('OP').map(m => m.refs)).toEqual([[`msg#${req.id}`]]);
  await f.run('overdue', '--notify'); // the seen stage alerts on its own, once
  await f.run('overdue', '--notify');
  expect(alerts('OP')).toHaveLength(2);
  expect(alerts('RES')).toHaveLength(2);
  expect(f.exits).toEqual([]);
});

test('#38361 Terra ② — a failed alert target is retried on the next run, the delivered one never twice · the run fails loudly', async () => {
  const f = fixture();
  f.writer.post({ from: 'RES', to: 'TC', body: 'x', intent: 'request' });
  const original = MsgStore.prototype.post;
  let failOp = true;
  const spy = spyOn(MsgStore.prototype, 'post').mockImplementation(function (this: MsgStore, input) {
    if (failOp && input.from === 'MSG-SLA' && input.to === 'OP') throw new Error('SQLITE_BUSY');
    return original.call(this, input);
  });
  try {
    const alerts = (to: string) => f.writer.listByRecipient(to).filter(m => m.from === 'MSG-SLA');
    await f.run('overdue', '--notify', '--stage', 'ack');
    expect([alerts('RES').length, alerts('OP').length]).toEqual([1, 0]);
    expect(f.exits).toEqual([2]);
    expect(f.errors.at(-1)).toContain('경보 1건 발송 실패');
    failOp = false;
    await f.run('overdue', '--notify', '--stage', 'ack');
    expect([alerts('RES').length, alerts('OP').length]).toEqual([1, 1]);
    expect(f.exits).toEqual([2]); // the second run succeeded
  } finally { spy.mockRestore(); }
});

test('#38361 Terra ③ — more than one page of open requests: every one is listed and alerted (alerted ones do not crowd older ones out)', async () => {
  const f = fixture();
  // Source: #38361 Terra ③ — one page is 100; 130 needs a second page.
  const posted = Array.from({ length: 130 }, () => f.writer.post({ from: 'RES', to: 'TC', body: 'x', intent: 'request' }).id);
  await f.run('overdue', '--json', '--notify', '--stage', 'ack');
  expect(f.lines).toHaveLength(posted.length);
  const alerted = f.writer.listByRecipient('OP', 0, 1000).filter(m => m.from === 'MSG-SLA').map(m => m.refs![0]);
  expect(new Set(alerted)).toEqual(new Set(posted.map(id => `msg#${id}`)));
});

test('#38361 follow-up ② — the alert mail is written but the alert-ledger INSERT fails: both roll back · no lost alert, no duplicate on rerun', async () => {
  const f = fixture();
  // Rule 11: no product constant — the product creates its own alert ledger through one real alert first.
  const warmup = f.writer.post({ from: 'JUD', to: 'UX', body: 'x', intent: 'request' });
  await f.run('overdue', '--notify', '--stage', 'ack');
  f.writer.recordReceipt({ messageId: warmup.id, recipient: 'UX', state: 'accepted', source: 'cli' }); // leaves the list
  const req = f.writer.post({ from: 'RES', to: 'TC', body: 'x', intent: 'request' });
  const raw = new Database(f.path);
  try {
    raw.exec("CREATE TRIGGER sla_insert_fails BEFORE INSERT ON msg_sla_alerts BEGIN SELECT RAISE(ABORT, 'ledger insert failed'); END;");
  } finally { raw.close(); }
  const alerts = (to: string) => f.writer.listByRecipient(to).filter(m => m.from === 'MSG-SLA');
  const ledgerRows = () => { const db = new Database(f.path, { readonly: true }); try { return (db.query('SELECT COUNT(*) AS n FROM msg_sla_alerts').get() as { n: number }).n; } finally { db.close(); } };
  await f.run('overdue', '--notify', '--stage', 'ack');
  // The post ran before the ledger INSERT inside one transaction — the failed INSERT took the alert mail back with it.
  expect([alerts('RES').length, alerts('OP').map(m => m.refs![0]), ledgerRows()]).toEqual([0, [`msg#${warmup.id}`], 2]); // only the warm-up's two
  expect(f.exits).toEqual([2]); // not silent: the run fails and names the count
  expect(f.errors.at(-1)).toContain('경보 2건 발송 실패');
  const drop = new Database(f.path);
  try { drop.exec('DROP TRIGGER sla_insert_fails'); } finally { drop.close(); }
  await f.run('overdue', '--notify', '--stage', 'ack');
  await f.run('overdue', '--notify', '--stage', 'ack');
  expect(alerts('RES').map(m => m.refs)).toEqual([[`msg#${req.id}`]]); // exactly once after recovery
  expect(alerts('OP').map(m => m.refs![0])).toEqual([`msg#${warmup.id}`, `msg#${req.id}`]);
  expect(ledgerRows()).toBe(4);
  expect(f.exits).toEqual([2]);
});

test('#38361 follow-up ① — help never claims the age alert runs by itself (no periodic consumer is wired)', () => {
  const program = new Command();
  registerMsgReceiptsCommands(program.command('msg'), { out: { log: () => {}, error: () => {} } } as never);
  const overdue = program.commands[0]!.commands.find(c => c.name() === 'overdue')!;
  const help = overdue.helpInformation().replace(/\s+/g, ' '); // commander wraps lines
  expect(help).toContain('one-shot');
  expect(help).toContain('nothing runs it on a schedule');
});
