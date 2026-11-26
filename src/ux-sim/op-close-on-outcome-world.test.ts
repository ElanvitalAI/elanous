// OP-CLOSE-ON-OUTCOME sim (대표 11-26 04:5x «request sent ≠ done · 기존 수행선 유지 is not completion») — synthetic OP
// delegations on a fake clock against the REAL MsgPost tool, commitment ledger, waker evaluation and CommitmentClose.
// Facts come from fake probes (checklist cell · PR · seat pane). Each seed draws a mix of delegations whose predicate
// holds, fails, or whose facts are missing; the fake OP model then tries to close EVERY one as done (tonight's habit).
// Expectations are literals.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from '../commitment/ledger.js';
import { dispatchCommitmentClose } from '../commitment/close.js';
import { armMessageFollowUp } from '../msg/msg-follow-up.js';
import { MsgStore } from '../msg/msg-store.js';
import { evaluateWaker, listWakers, type SelfTimerDeps, type WaitProbes } from '../msg/self-timer-watch.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

type Fate = 'holds' | 'fails' | 'missing';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'op-close-outcome-'));
  roots.push(root);
  let nowMs = Date.parse('2026-11-25T20:00:00.000Z');
  let cid = 0; let wid = 0;
  const now = () => new Date(nowMs);
  const ledger = new CommitmentLedger({ root: join(root, 'ledger'), now, newId: () => `c-${++cid}`, emit: () => {} });
  const cells = new Map<string, { status: string; owner?: string }>();
  const missing = new Set<string>();
  const notices: string[] = [];
  const probes: WaitProbes = {
    prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => true, fileExists: async () => false,
    cellStatus: async (cell) => { if (missing.has(cell)) throw new Error(`checklist unreadable for ${cell}`); return cells.get(cell) ?? null; },
    seatPane: async (seat) => `${seat} IDLE «waiting on review»`,
  };
  const timer: SelfTimerDeps = { root: join(root, 'ledger', 'wakers'), ledger, now, newId: () => `w-${++wid}`, emit: () => {}, probes,
    postNotice: async (_s, body) => { notices.push(body); return notices.length; }, isPidAlive: () => false, waitContract: null, trigger: null };
  const store = () => new MsgStore(join(root, 'messages.db'));
  const followUp = (m: Parameters<typeof armMessageFollowUp>[0], pr: number | undefined, _d: unknown, watch?: string) =>
    armMessageFollowUp(m, pr, { ledger, timer, launch: async () => {} }, watch);
  return { ledger, timer, cells, missing, notices, store, followUp, advance: (ms: number) => { nowMs += ms; } };
}

describe('OP-CLOSE-ON-OUTCOME sim (fake clock)', () => {
  test('edge: an OP request without a done-when is refused before storing; with watch it records done-when · check-at · assignee', async () => {
    const w = world();
    await expect(dispatchMsgPost({ from: 'OP', to: 'TC', body: 'please land A1', intent: 'request' }, { openStore: w.store, followUp: w.followUp }))
      .rejects.toThrow("OP request needs 'watch' (the done-when outcome: cell-status:<id>=<status> · pr-merged:<n> · pregate-receipt:<n> · seat-idle:<SEAT> · file-exists:<path>) — a sent request or a reply is not the outcome");
    const ok = await dispatchMsgPost({ from: 'OP', to: 'TC', body: 'please land A1', intent: 'request', watch: 'cell-status:A1=green' }, { openStore: w.store, followUp: w.followUp });
    expect(ok.output).toContain('watch cell-status:A1=green');
    const [entry] = w.ledger.list('OP');
    expect(entry?.doneWhen).toBe('cell-status:A1=green');
    expect(entry?.assignee).toBe('TC');
    expect(typeof entry?.checkAt).toBe('string');
  });

  for (const seed of [3, 11, 29]) {
    test(`seed ${seed}: done only where the predicate holds; fails → refused, then reassigned/blocked; missing → refused`, async () => {
      const w = world();
      const r = rng(seed);
      const fates: Fate[] = [];
      for (let i = 0; i < 12; i++) {
        const fate: Fate = (['holds', 'fails', 'missing'] as const)[Math.floor(r() * 3)]!;
        fates.push(fate);
        const cell = `C${i}`;
        w.cells.set(cell, { status: fate === 'holds' ? 'green' : 'yellow' });
        if (fate === 'missing') w.missing.add(cell);
        await dispatchMsgPost({ from: 'OP', to: i % 2 ? 'TC' : 'UX', body: `land ${cell}`, intent: 'request', watch: `cell-status:${cell}=green` }, { openStore: w.store, followUp: w.followUp });
      }
      const results: string[] = [];
      for (const [i, e] of w.ledger.list('OP').entries()) {
        // The fake OP: «기존 수행선 유지» — claims done on everything.
        const res = await dispatchCommitmentClose({ id: e.id, status: 'done', evidence: '기존 수행선 유지 · TC replied it is in progress' }, { ledger: w.ledger, timer: w.timer });
        results.push(`${fates[i]}:${res.ok ? 'done' : 'refused'}`);
        if (!res.ok) {
          const expected = fates[i] === 'missing'
            ? `CommitmentClose failed: done refused: done-when cell-status:C${i}=green = FACTS MISSING · checklist unreadable for C${i}. A sent request or a reply is not the outcome — close as reassigned or blocked with a reason, or wait for the predicate`
            : `CommitmentClose failed: done refused: done-when cell-status:C${i}=green = NOT MET · facts: cell C${i} status=yellow. A sent request or a reply is not the outcome — close as reassigned or blocked with a reason, or wait for the predicate`;
          expect(res.output).toBe(expected);
          const alt = await dispatchCommitmentClose({ id: e.id, status: i % 2 ? 'reassigned' : 'blocked', evidence: i % 2 ? 'moved to UX: TC on P0' : 'waiting on JUD hold #1' }, { ledger: w.ledger, timer: w.timer });
          expect(alt.ok).toBe(true);
          expect(w.ledger.get('OP', e.id)?.status).toBe(i % 2 ? 'reassigned' : 'blocked');
        } else {
          expect(w.ledger.get('OP', e.id)?.status).toBe('done');
        }
      }
      for (const one of results) {
        const [fate, verdict] = one.split(':');
        expect(verdict).toBe(fate === 'holds' ? 'done' : 'refused');
      }
    });
  }

  test('edge: check-at wake carries the predicate result from facts and the assignee pane', async () => {
    const w = world();
    w.cells.set('B7', { status: 'yellow', owner: 'TC' });
    await dispatchMsgPost({ from: 'OP', to: 'TC', body: 'land B7', intent: 'request', watch: 'cell-status:B7=green' }, { openStore: w.store, followUp: w.followUp });
    const [waker] = listWakers('OP', w.timer);
    w.advance(2 * 60 * 60_000 + 1);
    const tick = await evaluateWaker('OP', waker!.id, w.timer);
    expect(tick.outcome).toBe('expired');
    expect(w.notices.length).toBe(1);
    expect(w.notices[0]).toContain('\n  done-when cell-status:B7=green = NOT MET · facts: cell B7 status=yellow owner=TC');
    expect(w.notices[0]).toContain('\n  TC pane: TC IDLE «waiting on review»');
  });

  test('edge: a watch that fired satisfied lets done through even when the probe later flips', async () => {
    const w = world();
    w.cells.set('D1', { status: 'green' });
    await dispatchMsgPost({ from: 'OP', to: 'TC', body: 'land D1', intent: 'request', watch: 'cell-status:D1=green' }, { openStore: w.store, followUp: w.followUp });
    const [waker] = listWakers('OP', w.timer);
    const tick = await evaluateWaker('OP', waker!.id, w.timer);
    expect(tick.outcome).toBe('fired');
    expect(w.ledger.list('OP')[0]?.status).toBe('done');
    expect(w.notices[0]).toBe('✅ watch satisfied · cell-status:D1=green · cell D1 status=green · commitment c-1 «Watch cell-status:D1=green (message #1 to TC)» — closed done with this evidence; no reply was needed');
  });
});
