/**
 * SIM — COMMITMENT-EXPIRY (CEO 11-27 · `eln fed snapshot --anomalies` on build 261127_0004: «OP has 169 overdue commitments
 * · open 197» after #40313's mail-reply sweep). What stayed open (`eln commitment list --seat OP --status open`, 199): COND-
 * WATCH «Watch cell-status:X=green (message #N to …)» and «Watch mail-from:SEAT …» (same condition up to 17×), and
 * pr-merged follow-ups from 11-24. Seeds 1–5 rebuild that mix plus young, unique watches that must stay. Expect: every
 * absorbed / loop-agent / > 12 h / duplicate one closes with its reason and one audit line; the young unique ones stay;
 * the digest stays bounded and honest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from '../commitment/ledger.js';
import { armWaker, type SelfTimerDeps } from '../msg/self-timer-watch.js';
import { readPulseDigest } from './pulse-digest.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const NOW = Date.parse('2026-11-26T15:20:00.000Z');

describe('SIM commitment expiry — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: watches / pr follow-ups close by rule; young unique watches stay`, () => {
      const r = rng(seed); const root = mkdtempSync(join(tmpdir(), 'commit-expiry-')); roots.push(root);
      let t = NOW; let cid = 0; let wid = 0;
      const ledger = new CommitmentLedger({ root: join(root, 'l'), now: () => new Date(t), newId: () => `c-${++cid}`, emit: () => {} });
      const timer: SelfTimerDeps = { root: join(root, 'l', 'wakers'), ledger, now: () => new Date(t), newId: () => `w-${++wid}`, emit: () => {},
        probes: { prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false, cellStatus: async () => ({ status: 'yellow' }) },
        postNotice: async () => 1, isPidAlive: () => false, waitContract: null, trigger: null };
      const add = (ageMin: number, cond: string, to: string, msg: number) => {
        t = NOW - ageMin * 60_000;
        const e = ledger.add({ seat: 'OP', sessionId: `msg:${msg}`, text: `Watch ${cond} (message #${msg} to ${to})`, evidence: `MsgPost #${msg}`, source: 'explicit', assignee: to }).entry;
        armWaker({ seat: 'OP', commitmentId: e.id, condition: cond, withinMs: 2 * 3_600_000, autoClose: true }, timer);
        return e.id;
      };
      const expect_: Record<string, string[]> = { absorbed: [], 'older-than-12h': [], duplicate: [], stay: [] };
      let msg = 180000;
      // A condition watched many times (the newest copy stays if young; older copies are duplicates).
      const dupN = 3 + Math.floor(r() * 10);
      for (let i = 0; i < dupN; i++) expect_[i === dupN - 1 ? 'stay' : 'duplicate']!.push(add(300 - i * 20, 'cell-status:BURST-DEMO-LIVE=green', 'TC-H-CX-1', ++msg));
      // Watches on a loop agent's mail / an absorbed seat.
      for (let i = 0; i < 2 + Math.floor(r() * 5); i++) expect_.absorbed!.push(add(60 + i, `mail-from:${i % 2 ? 'BOARD-STEWARD' : 'ORCHESTRATOR'}`, 'OP', ++msg));
      expect_.absorbed!.push(add(30, 'mail-from:RES', 'RES', ++msg));
      // pr-merged follow-ups from 11-24 (> 12 h).
      for (let i = 0; i < 2 + Math.floor(r() * 6); i++) expect_['older-than-12h']!.push(add(2 * 24 * 60 + i, `pr-merged:${39900 + i}`, 'JUD-C', ++msg));
      // Young unique watches — real, they stay.
      for (let i = 0; i < 2 + Math.floor(r() * 4); i++) expect_.stay!.push(add(20 + i, `cell-status:FRESH-${seed}-${i}=green`, 'TC', ++msg));
      t = NOW;
      const audits: Record<string, unknown>[] = [];
      const text = readPulseDigest('OP', NOW - 3_600_000, 0, { ledger, timer, now: () => NOW, acked: () => false, audit: (row) => audits.push(row) });
      const dropped = ledger.list('OP', { status: 'dropped' });
      const why = new Map(dropped.map(c => [c.id, c.reason ?? '']));
      for (const [reason, ids] of Object.entries(expect_)) {
        for (const id of ids) {
          if (reason === 'stay') expect(why.has(id)).toBe(false);
          else expect(why.get(id)).toEndWith(`— ${reason}`);
        }
      }
      expect(ledger.list('OP', { status: 'open' }).map(c => c.id).sort()).toEqual([...expect_.stay!].sort());
      expect(audits.length).toBe(1);
      expect(audits[0]).toMatchObject({ closed: dropped.length });
      expect(why.get(expect_.duplicate![0]!) ?? '').toStartWith('auto-expired: cell-status:BURST-DEMO-LIVE=green (to TC-H-CX-1)');
      expect(text === null || text.length <= 2_000).toBe(true); // 출처: #40313 — DIGEST_MAX_CHARS
    });
  }
});
