// PR #39547 — JUD-B #127641·#127659 / OP #127668 회귀: MsgStore 열기(신설·레거시·재개방).
// ① 신설 DB 생성이 스키마 SQL 안 `//` 주석으로 SQLiteError near "/" 로 죽던 결함(OP 재현)
// ② reply_to 없는 레거시 ledger에서 신규 reply_to 인덱스가 열 추가 마이그레이션보다 먼저 실패하던 결함
// ③ 현행 ledger에서 인덱스만 없으면 재개방이 채운다(needsMigration 인덱스 목록)
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';

const dir = mkdtempSync(join(tmpdir(), 'msg-store-open-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const indexNames = (path: string): string[] => {
  const probe = new Database(path, { readonly: true });
  try {
    return (probe.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'msg_messages' ORDER BY name")
      .all() as { name: string }[]).map((row) => row.name);
  } finally { probe.close(); }
};

describe('MsgStore 열기 회귀 — JUD-B #127641·#127659 / OP #127668 (PR #39547)', () => {
  test('① 새 :memory: 생성이 SQL 구문 오류로 죽지 않는다 — 스키마 SQL에 // 주석 없음', () => {
    const store = new MsgStore(':memory:');
    store.close();
  });

  test('①-b 새 파일 생성·재개방 — idx_msg_messages_reply_sender_id 존재', () => {
    const path = join(dir, 'fresh.db');
    new MsgStore(path).close();
    expect(indexNames(path)).toContain('idx_msg_messages_reply_sender_id');
    new MsgStore(path).close(); // 재개방
    expect(indexNames(path)).toContain('idx_msg_messages_reply_sender_id');
  });

  test('② reply_to 없는 레거시 ledger — 열 추가가 인덱스보다 먼저 · 기존 행 보존', () => {
    const path = join(dir, 'legacy.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE msg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT,
      created_at TEXT NOT NULL
    )`);
    raw.exec("INSERT INTO msg_messages (sender, recipient, body, kind, created_at) VALUES ('OP', 'TC-H-CC-1', '옛 판본 행', 'request', '2026-01-01T00:00:00.000Z')");
    raw.close();
    new MsgStore(path).close(); // 수리 전: no such column: reply_to
    const probe = new Database(path, { readonly: true });
    try {
      const columns = (probe.query('PRAGMA table_info(msg_messages)').all() as { name: string }[]).map((row) => row.name);
      expect(columns).toContain('reply_to');
      expect(columns).toContain('refs_json');
      expect(probe.query('SELECT sender, recipient, body FROM msg_messages').get())
        .toEqual({ sender: 'OP', recipient: 'TC-H-CC-1', body: '옛 판본 행' });
    } finally { probe.close(); }
    expect(indexNames(path)).toContain('idx_msg_messages_reply_sender_id');
  });

  test('③ 현행 ledger에서 인덱스만 없으면 재개방이 다시 채운다', () => {
    const path = join(dir, 'current.db');
    new MsgStore(path).close();
    const raw = new Database(path);
    raw.exec('DROP INDEX idx_msg_messages_reply_sender_id');
    raw.close();
    new MsgStore(path).close();
    expect(indexNames(path)).toContain('idx_msg_messages_reply_sender_id');
  });
});