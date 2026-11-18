// #38305 REVIEW ① — the core claim of MSG-RECEIPTS-FOLLOWUP ③: a MIXED unread batch reads no message bodies at all;
// bodies are read only once the batch is known to be one agent seat. Counted on the real SQLite query calls.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, readUnreadSource } from './msg-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const originalQuery = Database.prototype.query;
const bodyQueries = (run: () => unknown): number => {
  const seen: string[] = [];
  const spy = spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql: string) {
    seen.push(sql);
    return originalQuery.call(this, sql);
  } as typeof Database.prototype.query);
  try { run(); } finally { spy.mockRestore(); }
  return seen.filter(sql => /\bbody\b/.test(sql)).length;
};

test('mixed senders → 0 body SELECTs · one agent seat → the body SELECT runs (control)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-source-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  try {
    store.post({ from: 'OP', to: 'TC', body: 'a' });
    store.post({ from: 'RES', to: 'TC', body: 'b' });
    store.post({ from: 'OP', to: 'JUD', body: 'c' });
  } finally { store.close(); }
  let mixed: unknown = 'unset';
  expect(bodyQueries(() => { mixed = readUnreadSource('TC', path); })).toBe(0);
  expect(mixed).toBeNull();
  let single: unknown = 'unset';
  expect(bodyQueries(() => { single = readUnreadSource('JUD', path); })).toBe(1);
  expect(single).toMatchObject({ seat: 'OP', messages: [{ body: 'c' }] });
});
