/**
 * SIM — DIGEST-CAP ⊕ MAIL-REPLY EXPIRY (CEO 11-26 22:5x). Today's shape on build 2226 at 22:45: the OP batch turn carried
 * 10 seat mails plus the pulse digest «Overdue (1039) · needs action 1176 · … c-18825332 Follow up on message #138605 to
 * REL · mail-reply:138605 · not met by 06:33 …» — the digest alone blew the context budget. Seeds 1–5 vary the mix of
 * recipients (REL/RES absorbed · TC/UX live), ages (0–20 h) and acks. Expect: stale follow-ups are closed with an audit
 * line, the digest stays ≤ 2 000 chars with exact counts and «… N more», nothing silently dropped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from '../commitment/ledger.js';
import { armWaker, type SelfTimerDeps } from '../msg/self-timer-watch.js';
import { DIGEST_MAX_CHARS, readPulseDigest, staleMailReplies, sweepMailReplies } from './pulse-digest.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const NOW = Date.parse('2026-11-26T13:45:00.000Z'); // 22:45 KST

function world(seed: number, n: number) {
  const r = rng(seed); const root = mkdtempSync(join(tmpdir(), 'digest-cap-')); roots.push(root);
  let t = NOW - 20 * 3_600_000; let cid = 0; let wid = 0;
  const ledger = new CommitmentLedger({ root: join(root, 'l'), now: () => new Date(t), newId: () => `c-${++cid}`, emit: () => {} });
  const timer: SelfTimerDeps = { root: join(root, 'l', 'wakers'), ledger, now: () => new Date(t), newId: () => `w-${++wid}`, emit: () => {},
    probes: { prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false, cellStatus: async () => ({ status: 'red' }) },
    postNotice: async () => 1, isPidAlive: () => false, waitContract: null, trigger: null };
  const acked = new Set<number>(); const expect = { absorbed: 0, old: 0, acked: 0, live: 0 };
  for (let i = 0; i < n; i++) {
    const to = ['REL', 'RES', 'TC', 'UX', 'TC'][Math.floor(r() * 5)]!;
    const ageH = r() * 20;
    t = NOW - ageH * 3_600_000;
    const msgId = 138000 + i;
    const e = ledger.add({ seat: 'OP', sessionId: `msg:${msgId}`, text: `Follow up on message #${msgId} to ${to}`, evidence: `MsgPost #${msgId}`, source: 'explicit', assignee: to }).entry;
    armWaker({ seat: 'OP', commitmentId: e.id, condition: `mail-reply:${msgId}`, withinMs: 30 * 60_000 }, timer);
    const isAcked = r() < 0.3; if (isAcked) acked.add(msgId);
    if (to === 'REL' || to === 'RES') expect.absorbed++; else if (ageH > 12) expect.old++; else if (isAcked) expect.acked++; else expect.live++;
  }
  t = NOW;
  return { ledger, timer, acked, expect, root };
}

describe('SIM digest cap ⊕ mail-reply expiry — seeds 1–5 (1 039 follow-ups)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: stale follow-ups close with one audit line; the digest fits and names every count`, () => {
      const w = world(seed, 1039);
      const audits: Record<string, unknown>[] = [];
      const text = readPulseDigest('OP', NOW - 3_600_000, 1, { ledger: w.ledger, timer: w.timer, now: () => NOW, acked: (id) => w.acked.has(id), audit: (row) => audits.push(row) })!;
      // Closed with reasons, one audit line, nothing open left that should have closed.
      expect(audits.length).toBe(1);
      expect(audits[0]).toMatchObject({ seat: 'OP', sweep: 'mail-reply-expiry', closed: w.expect.absorbed + w.expect.old + w.expect.acked,
        byReason: { ...(w.expect.absorbed ? { absorbed: w.expect.absorbed } : {}), ...(w.expect.old ? { 'older-than-12h': w.expect.old } : {}), ...(w.expect.acked ? { acked: w.expect.acked } : {}) } });
      const open = w.ledger.list('OP', { status: 'open' });
      expect(open.length).toBe(w.expect.live);
      expect(w.ledger.list('OP', { status: 'dropped' }).every(c => (c.reason ?? '').startsWith('auto-expired: mail-reply #'))).toBe(true);
      // The digest is bounded and still honest: the head carries the real counts; a cut section says how many more.
      expect(text.length <= DIGEST_MAX_CHARS).toBe(true);
      const head = text.split('\n')[0]!;
      expect(head).toStartWith('[Pulse digest · done 0 · overdue ');
      const shown = text.split('\n').filter(l => l.startsWith('  - ')).length;
      const more = [...text.matchAll(/… (\d+) more — eln commitment list --seat OP/g)].reduce((a, m) => a + Number(m[1]), 0);
      const counted = Number(/overdue (\d+)/.exec(head)![1]) + Number(/needs action (\d+)/.exec(head)![1]);
      expect(shown + more).toBe(counted);
      // A second read closes nothing more (idempotent) and writes no new audit line.
      readPulseDigest('OP', NOW - 3_600_000, 1, { ledger: w.ledger, timer: w.timer, now: () => NOW, acked: (id) => w.acked.has(id), audit: (row) => audits.push(row) });
      expect(audits.length).toBe(1);
    });
  }
  test('staleMailReplies is pure: absorbed first, then age, then ack; a live, young, unacked one stays', () => {
    const c = (id: string, to: string, ageH: number) => ({ id, layer: 'commitment' as const, seat: 'OP', sessionId: 's', text: 't', evidence: 'e', status: 'open' as const, source: 'explicit' as const,
      wakers: [], createdAt: new Date(NOW - ageH * 3_600_000).toISOString(), updatedAt: new Date(NOW).toISOString(), assignee: to });
    const wk = (cid: string, msg: number) => ({ id: `w-${cid}`, seat: 'OP', commitmentId: cid, condition: `mail-reply:${msg}`, armedAt: '', deadlineAt: '', status: 'armed' as const, checks: 0 });
    const out = staleMailReplies([c('a', 'REL', 1), c('b', 'TC', 13), c('d', 'TC', 1), c('e', 'UX', 1)], [wk('a', 1), wk('b', 2), wk('d', 3), wk('e', 4)],
      { nowMs: NOW, acked: (id) => id === 3 });
    expect(out.map(x => [x.commitmentId, x.reason])).toEqual([['a', 'absorbed'], ['b', 'older-than-12h'], ['d', 'acked']]);
  });
  test('sweepMailReplies writes no audit line when nothing closes', () => {
    const w = world(9, 0);
    const audits: unknown[] = [];
    expect(sweepMailReplies('OP', { ledger: w.ledger, timer: w.timer, nowMs: NOW, acked: () => false, audit: (r) => audits.push(r) })).toEqual([]);
    expect(audits).toEqual([]);
  });
});
