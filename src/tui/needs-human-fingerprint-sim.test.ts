/**
 * SIM — HAND-RAISE-FINGERPRINT-DEDUPE ⊕ WRITER-CHECK-INTENT-GATE (CEO cells · 11-26 23:xx). Tonight's shape: TC-H-POOL-2
 * sent 24 ✋ for ONE cause — its model reworded the block each turn (a mail-wake turn, resume, blocked again), and the
 * push deduped only on identical text; the space steward then answered DEPENDENCY_WAIT ✋ with the writer lookup's
 * generic «you are the writer; proceed» (28 wrong auto-answers). Seeds 1–5 vary the wording, the turns between and the
 * waited-on ref. Expect: one ✋ mail and at most one card per cause; a new cause (another ref) is a new ✋; a reply frees
 * the fingerprint; the resolver answers no DEPENDENCY_WAIT and never says «proceed» without a lookup.
 */
import { describe, expect, test } from 'bun:test';
import type { MessageEnvelope } from '../msg/msg-store.js';
import { createNeedsHumanPush, handFingerprint } from './needs-human-push.js';
import { handCauseOf, resolveWriterCheck, type WriterCheckPorts } from '../steward/space/writer-resolver.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDINGS = [
  'PR #40310 must land before I can continue ELS-SHELL-TABS',
  'waiting for #40310 (ELS-SHELL-TABS) to merge — cannot proceed',
  'ELS-SHELL-TABS blocked: dependency PR 40310 not landed yet',
  'still blocked on #40310 for ELS-SHELL-TABS; need a decision to continue or switch',
  'Cannot move ELS-SHELL-TABS until 40310 lands (PR #40310)',
];

function rig() {
  const posted: MessageEnvelope[] = []; const cards: string[] = []; const logs: string[] = [];
  let id = 1000;
  const push = createNeedsHumanPush({ seat: () => 'TC-H-POOL-2', paneId: () => 'p2', coordinatorOf: () => 'TC',
    postMail: (e) => { posted.push(e); return ++id; }, raiseDecision: (c) => { cards.push(c.title); }, resumeWith: () => {},
    setTimer: () => 0, clearTimer: () => {}, log: (_e, d) => { logs.push(String(d.phase)); } });
  return { push, posted, cards, logs };
}

describe('SIM ✋ fingerprint dedupe — seeds 1–5 (24 reworded ✋ for one cause)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: 24 reworded blocks across turns → 1 mail, 23 repeats; another ref → a new ✋; a reply frees it`, () => {
      const r = rng(seed); const w = rig();
      for (let i = 0; i < 24; i++) {
        w.push.blocked('DEPENDENCY_WAIT', WORDINGS[Math.floor(r() * WORDINGS.length)]!);
        if (r() < 0.6) w.push.resumed(); // a mail-wake / person turn in between, then blocked again
      }
      expect(w.posted.length).toBe(1);
      expect(w.posted[0]!.to).toBe('TC');
      expect(w.logs.filter((p) => p === 'repeat').length).toBe(23);
      expect(w.cards.length).toBe(0);
      // A different waited-on ref is a different cause → its own ✋.
      w.push.blocked('DEPENDENCY_WAIT', 'waiting for PR #40318 to land');
      expect(w.posted.length).toBe(2);
      // TC replies to the first ✋ → that cause is answered; the same cause later is a new ✋.
      w.push.resumed();
      w.push.noteArrivals([{ replyTo: 1001, text: 'resolved: rebase on main, #40310 merged' }]);
      w.push.blocked('DEPENDENCY_WAIT', WORDINGS[0]!);
      expect(w.posted.length).toBe(3);
    });
  }
  test('fingerprint ignores wording and the seat name, keeps reason/cause/refs', () => {
    expect(handFingerprint('TC-H-POOL-2', 'DEPENDENCY_WAIT', WORDINGS[1]!)).toBe(handFingerprint('TC-H-POOL-2', 'DEPENDENCY_WAIT', WORDINGS[3]!));
    expect(handFingerprint('TC-H-POOL-2', 'DEPENDENCY_WAIT', 'TC-H-POOL-2 waits on #40310 for ELS-SHELL-TABS')).toBe('TC-H-POOL-2|DEPENDENCY_WAIT||#40310,ELS-SHELL-TABS');
    expect(handFingerprint('TC-H-POOL-2', 'HUMAN_DECISION', WORDINGS[1]!)).not.toBe(handFingerprint('TC-H-POOL-2', 'DEPENDENCY_WAIT', WORDINGS[1]!));
  });
});

describe('SIM writer-check intent gate — seeds 1–5', () => {
  const ports = (o: Partial<WriterCheckPorts> = {}): WriterCheckPorts => ({ worktreeOf: () => '/wt/x', uncommitted: () => [], openPrs: () => [], recentCommits: () => [], ...o });
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: 28 DEPENDENCY_WAIT ✋ → 0 auto-answers; ownership ✋ without paths → climbs; with paths → answered`, () => {
      const r = rng(seed);
      let wrong = 0;
      for (let i = 0; i < 28; i++) {
        const refs = r() < 0.5 ? [`path:src/f${i}.ts`] : [];
        const v = resolveWriterCheck({ reason: 'DEPENDENCY_WAIT', refs, blockedSeat: `TC-H-${i % 4}` }, ports());
        if (v?.kind === 'resolve') wrong++;
      }
      expect(wrong).toBe(0);
      expect(handCauseOf({ reason: 'DEPENDENCY_WAIT', refs: [] })).toBe(null);
      expect(resolveWriterCheck({ reason: 'OWNER_UNKNOWN', refs: [], blockedSeat: 'TC-H-1' }, ports())?.kind).toBe('escalate');
      expect(resolveWriterCheck({ reason: 'OWNER_UNKNOWN', refs: ['path:src/a.ts'], blockedSeat: 'TC-H-1' }, ports())?.kind).toBe('resolve');
      // An explicit writer cause on a dependency block is still answered (structured intent wins over the block code).
      expect(resolveWriterCheck({ reason: 'DEPENDENCY_WAIT', refs: ['cause:writer-handover', 'path:src/a.ts'], blockedSeat: 'TC-H-1' }, ports())?.kind).toBe('resolve');
    });
  }
});
