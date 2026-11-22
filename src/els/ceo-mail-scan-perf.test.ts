// OP #127509 완료선 — 13만 행 ledger 에서 scan 1회 <5ms · 새 CEO 글만 읽음 (OP #127483 수리 검증).
// A real bun:sqlite ledger (the msg-store schema incl. the reply-thread index) seeded with 130,000
// CEO→OP rows. The pre-fix daemon re-queried cursor:0 EVERY second — this file pins the steady scan:
// only the rows past the open window are read, and the whole scan stays under 5 ms.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCeoMail, openCeoMailDb, ceoMessageRef, ceoChatRef, type CeoMailDb } from './ceo-channel-mail-watch.js';
import type { CeoChannel } from './ceo-channel.js';

const ROWS = 130_000;
const OPEN = 5; // the newest 5 rows are correlatable (telegram refs) and still unanswered

describe('OP #127483/#127509 — 13만 행 ledger scan 성능 · 새 CEO 글만 읽음', () => {
  test('정상 상태 scan: 열린 창 이후 5행만 읽고 5ms 미만 · 부팅 scan은 13만 행(구동작이 매초 하던 일)', async () => {
    const dir = join(tmpdir(), `ceo-perf-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'messages.db');
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(path);
    try {
      db.exec(`CREATE TABLE msg_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL, kind TEXT,
        reply_to INTEGER, created_at TEXT NOT NULL, provenance_json TEXT, refs_json TEXT
      );
      CREATE INDEX idx_msg_messages_recipient_id ON msg_messages(recipient, id);
      CREATE INDEX idx_msg_messages_created_at_id ON msg_messages(created_at, id);
      CREATE INDEX idx_msg_messages_reply_sender_id ON msg_messages(reply_to, sender, id);`);
      const ins = db.prepare('INSERT INTO msg_messages (sender, recipient, body, created_at, refs_json) VALUES (?, ?, ?, ?, ?)');
      const base = Date.UTC(2026, 10, 22, 0, 0, 0);
      const openRef = (id: number): string => JSON.stringify([ceoMessageRef(`m${id}`), ceoChatRef('100')]);
      db.transaction((): void => {
        for (let id = 1; id <= ROWS; id += 1) {
          const correlatable = id > ROWS - OPEN;
          ins.run('CEO', 'OP', `행 ${id}`, new Date(base + id * 1000).toISOString(), correlatable ? openRef(id) : null);
        }
      })();
      expect((db.query('SELECT COUNT(*) AS n FROM msg_messages').get() as { n: number }).n).toBe(ROWS);

      const opened = openCeoMailDb(path);
      expect(opened).not.toBeNull();
      const mail = opened!;
      const reads: Array<{ after: number; rows: number }> = [];
      const counted: CeoMailDb = {
        ...mail,
        ceoRows: (after: number) => { const rows = mail.ceoRows(after); reads.push({ after, rows: rows.length }); return rows; },
      };
      const channel = {} as unknown as CeoChannel;
      const noLog = (): void => {};

      // 부팅 1회 — downtime catch-up: 13만 행 전부 (구동작 cursor:0 이 매초 하던 읽기량을 이 스캔이 증명)
      const boot = await scanCeoMail({ cursor: 0, mail: counted, channel, log: noLog });
      expect(reads[0]).toEqual({ after: 0, rows: ROWS });
      expect(boot.cursor).toBe(ROWS);
      expect(boot.openSince).toBe(ROWS - OPEN + 1);

      // 정상 상태 — 데몬이 유지하는 커서(열린 창 −1): 새 CEO 글(열린 5행)만 읽는다
      await scanCeoMail({ cursor: ROWS - OPEN, mail: counted, channel, log: noLog }); // warm (statement cache)
      const t0 = performance.now();
      const steady = await scanCeoMail({ cursor: ROWS - OPEN, mail: counted, channel, log: noLog });
      const ms = performance.now() - t0;
      expect(reads.at(-1)).toEqual({ after: ROWS - OPEN, rows: OPEN }); // 새 CEO 글만
      expect(steady.openSince).toBe(ROWS - OPEN + 1);
      expect(ms).toBeLessThan(5); // OP #127509 완료선 — scan 1회 <5ms
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
