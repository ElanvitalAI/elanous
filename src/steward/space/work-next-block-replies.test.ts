import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { CellBlockRow } from './cell-block.js';
import { blockRepliesAtMs, firstBlockReplies, type BlockReplyQuery } from './work-next-cli.js';

// 출처: #40619 — LAND10-SUPPLY: `eln work next` read one msg-store query per open block (a table scan each); hands hit their 30 s tool
// limit. Guard: N open blocks cost ONE indexed read, and the reply rule (sender ⊕ id ⊕ reply_to/recipient) is unchanged.

function store(): { db: Database; sqls: string[]; counted: { query: (sql: string) => { all: (...p: Array<string | number>) => unknown[] } } } {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE msg_messages (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, reply_to INTEGER, created_at TEXT NOT NULL)`);
  db.run('CREATE INDEX idx_msg_messages_created_at_id ON msg_messages(created_at, id)');
  const sqls: string[] = [];
  return { db, sqls, counted: { query: (sql: string) => { sqls.push(sql); return db.query(sql); } } };
}

const put = (db: Database, id: number, sender: string, recipient: string, at: string, replyTo: number | null = null): void => {
  db.run('INSERT INTO msg_messages (id, sender, recipient, reply_to, created_at) VALUES (?, ?, ?, ?, ?)', [id, sender, recipient, replyTo, at]);
};

const block = (cell: string, by: string, on: string, at: string, mailId?: number): CellBlockRow =>
  ({ op: 'block', at, version: '9.9.9', cell, by, on, reason: 'waits', ...(mailId === undefined ? {} : { mailId }) });

describe('blockRepliesAtMs — one read for every open block', () => {
  test('200 open blocks on 5 awaited seats → exactly one query, each cell resolved', () => {
    const { db, sqls, counted } = store();
    const seats = ['RES', 'JUD', 'TC', 'UX', 'MK'];
    const queries: BlockReplyQuery[] = [];
    for (let i = 0; i < 200; i++) {
      const on = seats[i % 5]!;
      queries.push({ cell: `C${i}`, block: block(`C${i}`, `H${i}`, on, '2026-11-27T10:00:00.000Z', 1000 + i), board: 'TCB' });
    }
    // Only C3 (on UX, by H3) and C41 (on JUD, reply to its mail 1041) get answers.
    put(db, 5000, 'ux', 'h3', '2026-11-27T11:00:00.000Z');
    put(db, 5001, 'JUD', 'OP', '2026-11-27T12:00:00.000Z', 1041);
    put(db, 5002, 'OP', 'H1', '2026-11-27T12:30:00.000Z');
    const out = blockRepliesAtMs(counted, queries);
    expect(sqls.length).toBe(1);
    expect(out.size).toBe(200);
    expect(out.get('C3')).toBe(Date.parse('2026-11-27T11:00:00.000Z'));
    expect(out.get('C41')).toBe(Date.parse('2026-11-27T12:00:00.000Z'));
    expect(out.get('C1')).toBeUndefined();
    expect(out.get('C199')).toBeUndefined();
  });

  test('the read is an index search on created_at, not a table scan', () => {
    const { db, sqls, counted } = store();
    blockRepliesAtMs(counted, [{ cell: 'A', block: block('A', 'H1', 'RES', '2026-11-27T10:00:00.000Z', 1), board: 'TC' }]);
    const plan = db.query(`EXPLAIN QUERY PLAN ${sqls[0]}`).all('2026-11-27T10:00:00.000Z', 'RES') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' | ')).toContain('USING INDEX idx_msg_messages_created_at_id');
  });

  test('no open blocks → no query', () => {
    const { sqls, counted } = store();
    expect(blockRepliesAtMs(counted, []).size).toBe(0);
    expect(sqls.length).toBe(0);
  });
});

describe('firstBlockReplies — the reply rule', () => {
  const b = block('CELL', 'TC-H-1', 'RES', '2026-11-27T10:00:00.000Z', 100);
  const q = [{ cell: 'CELL', block: b, board: 'TC' }];
  const row = (id: number, sender: string, recipient: string, at: string, reply_to: number | null = null) => ({ id, sender, recipient, reply_to, created_at: at });

  test('a reply to the exception mail counts, whoever it is addressed to', () => {
    expect(firstBlockReplies(q, [row(101, 'RES', 'JUD', '2026-11-27T10:05:00.000Z', 100)]).get('CELL')).toBe(Date.parse('2026-11-27T10:05:00.000Z'));
  });
  test('a mail to the holder or to its board counts (case-insensitive)', () => {
    expect(firstBlockReplies(q, [row(101, 'res', 'tc-h-1', '2026-11-27T10:06:00.000Z')]).get('CELL')).toBe(Date.parse('2026-11-27T10:06:00.000Z'));
    expect(firstBlockReplies(q, [row(101, 'RES', 'tc', '2026-11-27T10:07:00.000Z')]).get('CELL')).toBe(Date.parse('2026-11-27T10:07:00.000Z'));
  });
  test('other senders, other recipients, mails before the block or at/below the mail id do not count', () => {
    const rows = [
      row(101, 'JUD', 'TC-H-1', '2026-11-27T10:05:00.000Z'),
      row(102, 'RES', 'UX', '2026-11-27T10:05:00.000Z'),
      row(103, 'RES', 'TC-H-1', '2026-11-27T09:59:00.000Z'),
      row(100, 'RES', 'TC-H-1', '2026-11-27T10:30:00.000Z'),
    ];
    expect(firstBlockReplies(q, rows).get('CELL')).toBeUndefined();
  });
  test('the first answer in id order wins, whatever order the rows came in', () => {
    const rows = [row(140, 'RES', 'TC', '2026-11-27T10:40:00.000Z'), row(120, 'RES', 'TC-H-1', '2026-11-27T10:20:00.000Z')];
    expect(firstBlockReplies(q, rows).get('CELL')).toBe(Date.parse('2026-11-27T10:20:00.000Z'));
  });
  test('a block without an exception mail (HQ ledger block) resolves on any later mail to the holder', () => {
    const hq = [{ cell: 'H', block: block('H', 'TC-H-2', 'OP', '2026-11-27T10:00:00.000Z'), board: 'TC' }];
    expect(firstBlockReplies(hq, [row(7, 'OP', 'TC-H-2', '2026-11-27T10:01:00.000Z')]).get('H')).toBe(Date.parse('2026-11-27T10:01:00.000Z'));
  });
});
