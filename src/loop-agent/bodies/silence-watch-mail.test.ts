import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { MsgStore } from '../../msg/msg-store.js';
import { withPolicies } from '../policy-context.js';
import { liveDeps } from './silence-watch.js';

const policies = (): Record<string, number> =>
  (parse(readFileSync(join(import.meta.dir, '../../../graphs/loop-agents/silence-watch/agent.yaml'), 'utf8')) as { policies: Record<string, number> }).policies;
// created_at is the wall clock: read the ledger one hour after it (past the 30-min SLA · inside the 24 h window)
const later = (): Date => new Date(Date.now() + 60 * 60_000);

test('live overdue reader applies the notice policy to 10 notices and 5 requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silence-mail-'));
  const db = join(dir, 'messages.db');
  const store = new MsgStore(db);
  const requests = Array.from({ length: 5 }, (_, i) => store.post({ from: 'OP', to: 'TC', body: `request ${i}`, intent: 'request', kind: 'request', needsAck: true }).id);
  for (let i = 0; i < 10; i++) store.post({ from: 'OP', to: 'TC', body: `notice ${i}`, intent: 'request', kind: i % 2 ? 'coord' : 'info', needsAck: true });
  store.close();
  const rows = await withPolicies(policies(), async () => liveDeps(dir, 'SILENCE-WATCH', db).overdue(later(), 30));
  expect(rows).not.toBeNull();
  expect(rows!.map(row => row.id).sort((a, b) => a - b)).toEqual(requests);
});

test('SILENCE-NOTICE-NOT-REQUEST: the reader walks every page, and a work-block card is a notice, not a request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silence-pages-'));
  const db = join(dir, 'messages.db');
  const store = new MsgStore(db);
  const requests = Array.from({ length: 7 }, (_, i) => store.post({ from: 'OP', to: 'TC', body: `request ${i}`, intent: 'request', kind: 'request', needsAck: true }).id);
  const block = store.append({ from: 'ORCHESTRATOR', to: 'TC', body: 'card', kind: 'steward-exception', intent: 'request', needsAck: true, refs: ['cell:X-1', 'blocked-on:TC-H-1'] }).id;
  const exception = store.append({ from: 'ORCHESTRATOR', to: 'TC', body: 'exception card', kind: 'steward-exception', intent: 'request', needsAck: true, refs: ['steward:TC', 'run:r1'] }).id;
  store.close();
  const small = { ...policies(), page_rows: 2, pages_max: 20 };
  const got = await withPolicies(small, async () => {
    const d = liveDeps(dir, 'SILENCE-WATCH', db);
    return { overdue: d.overdue(later(), 30), notices: d.notices!(later(), 30), cut: d.truncated!() };
  });
  expect(got.overdue!.map(r => r.id).sort((a, b) => a - b)).toEqual([...requests, exception]);
  expect(got.notices!.map(n => [n.id, n.to, n.reason])).toEqual([[block, 'TC', 'steward-exception+blocked-on:']]);
  expect(got.cut).toBe(false);
  const cut = await withPolicies({ ...small, pages_max: 2 }, async () => { const d = liveDeps(dir, 'SILENCE-WATCH', db); const r = d.overdue(later(), 30); return { n: r!.length, cut: d.truncated!() }; });
  expect(cut).toEqual({ n: 3, cut: true }); // 2 pages × 2 rows = 4 read · the work-block card is not a request
});

test('close-notice writes the ack done and reopen-notice restores the exact prior ack row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silence-close-'));
  const db = join(dir, 'messages.db');
  const store = new MsgStore(db);
  const bare = store.post({ from: 'OP', to: 'TC', body: 'fyi a', intent: 'request', kind: 'info', needsAck: true }).id;
  const acked = store.post({ from: 'OP', to: 'TC', body: 'fyi b', intent: 'request', kind: 'info', needsAck: true }).id;
  store.ackMessage('TC', acked, 'acked');
  store.close();
  await withPolicies(policies(), async () => {
    const d = liveDeps(dir, 'SILENCE-WATCH', db);
    expect(d.closeNotice!('TC', bare)).toBe('none');
    expect(d.closeNotice!('TC', acked)).toBe('acked');
    expect(d.closeNotice!('TC', acked)).toBeNull();
    expect(d.notices!(later(), 30)).toEqual([]);
    expect(d.reopenNotice!('TC', bare, 'none')).toBe(true);
    expect(d.reopenNotice!('TC', acked, 'acked')).toBe(true);
  });
  const check = new MsgStore(db);
  expect([check.explicitAck('TC', bare), check.explicitAck('TC', acked)]).toEqual([null, 'acked']);
  check.close();
});
