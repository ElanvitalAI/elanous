import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore, type MsgStore } from './msg-store.js';
import { triageMailbox, triageTotals } from './inbox-triage.js';

const NOW = new Date('2026-11-24T09:00:00.000Z');
let dir: string;
let store: MsgStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'triage-test-'));
  store = openMsgStore(join(dir, 'messages.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('msg inbox triage', () => {
  test('a recipient with no cursor row is an orphan mailbox and its unread lands in unsupervised', () => {
    store.post({ from: 'OP', to: 'RES-INFRA', body: '인프라 요청 1' });
    store.post({ from: 'RES-SCHEDULER', to: 'RES-INFRA', body: '인프라 요청 2', kind: 'request' });
    const rows = triageMailbox(store, { now: NOW });
    const infra = rows.find(r => r.recipient === 'RES-INFRA');
    expect(infra).toBeDefined();
    expect(infra!.unread).toBe(2);
    expect(infra!.orphan).toBe(true);
    expect(infra!.counts.unsupervised).toBe(2);
  });

  test('superseded and expired unread messages are classified, not lumped as unsupervised', () => {
    const first = store.post({ from: 'OP', to: 'TC', body: '구판 지시' });
    store.post({ from: 'OP', to: 'TC', body: '새 지시로 대체', supersedes: first.id });
    store.post({ from: 'MK', to: 'TC', body: '오래된 알림', expiresAt: '2026-11-01T00:00:00.000Z' });
    const rows = triageMailbox(store, { now: NOW });
    const tc = rows.find(r => r.recipient === 'TC')!;
    expect(tc.counts.superseded).toBe(1);   // first 지시
    expect(tc.counts.expired).toBe(1);      // 만료 알림
    expect(tc.counts.unsupervised).toBe(1);  // 대체 메시지 자체
  });

  test('a consumed mailbox is neither orphan nor unsupervised', () => {
    const m = store.post({ from: 'OP', to: 'MK', body: '요청', kind: 'request' });
    store.ack('MK', m.id);
    const m2 = store.post({ from: 'OP', to: 'MK', body: '후속 요청', kind: 'request' });
    void m2;
    const rows = triageMailbox(store, { now: NOW });
    const mk = rows.find(r => r.recipient === 'MK')!;
    expect(mk.orphan).toBe(false);
    expect(mk.counts.request).toBe(1);
    expect(mk.unread).toBe(1);
  });

  test('dashboard totals aggregate across recipients', () => {
    store.post({ from: 'OP', to: 'TC', body: 'a', kind: 'request' });
    store.post({ from: 'OP', to: 'TC', body: 'b', kind: 'decision' });
    const { rows, totals } = triageMailbox(store, { now: NOW, withTotals: true });
    expect(rows.length).toBeGreaterThan(0); // 출처: #39991 — 시드 게시물 3건으로 대시보드 집계가 0이 아니라는 최소 확인
    expect(totals.unread).toBe(2);
    expect(totals.recipients).toBe(rows.length);
  });
});
