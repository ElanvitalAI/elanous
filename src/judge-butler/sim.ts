// 판정 집사 — seeded federation sim of the 00:44 picture (rail 73 · `eln fed snapshot --anomalies`): judge queue 50 (10 landed
// cells with same-head receipts unsigned), «TC HOLD freezes 16 hands», «OP HOLD freezes 5 hands» (unregistered broadcast).
// The SAME planner/executor as live (wakeButler) runs against an in-memory world; the HOLD ledger and the butler memory are the
// real file stores under a temp state root. LLM 0 (the voice port is absent → judgment ✋ go to JUD).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addHold, expireDue, narrowHold, readHolds, unregisteredCards, type HoldBlock } from '../hold-ledger/hold-ledger.js';
import type { PrCellBinding } from '../land-graph/cell-link.js';
import { judgeCell, type CellIn, type PrFacts } from './done-when.js';
import type { ButlerPorts, HandIn } from './body.js';
import { wakeButler, judgeQueue, type JudgeQueue } from './agent.js';
import { fileMemory } from './memory.js';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Each sim PR's body carries «칸: <its cell>» (JUDGE-GREEN-PR-BINDING). */
const declares = (id: string): PrCellBinding => ({ declared: [id], title: [], branch: [], pipeline: [], selfDeclared: true, evidence: [] });
const head = (n: number, salt = 0) => (n * 2654435761 + salt).toString(16).padStart(8, '0').repeat(5).slice(0, 40);

export type CellKind = 'eligible' | 'no-receipt' | 'stale-head' | 'no-e4' | 'focused-fail' | 'security'
  // BUTLER-SIGN-MERGED-PATCHID (live 11-27: 26 «merged + receipt» cells, 0 signed) — squash-merged with an earlier-head receipt
  // whose PR-own patch-id equals the landed head · the PR-own delta changed after the receipt · head failure also red on main ·
  // a head-only failure · doc-only PR with an L0 receipt (no focused stage)
  | 'patch-id-reuse' | 'different-delta' | 'baseline-preexisting' | 'new-failure' | 'doc-only-l0';
export interface SimCell extends CellIn { kind: CellKind; pr: number; status: string; owner: string; evidence: string; updatedAt: string; updatedBy: string; title: string }
export interface SimResult {
  seed: number; ticks: number;
  signedFirstTick: number; signedTotal: number; greensPerHour: number;
  frozenSeries: number[]; frozenZeroAtTick: number | null;
  queueStart: JudgeQueue; queueEnd: JudgeQueue;
  /** BUTLER-SIGN-MERGED-PATCHID cells: kind → signed count · and the first tick's not-signed reasons (cell → why). */
  equivalence: Record<string, { cells: number; signed: number }>; notSignedFirstTick: Record<string, string>;
  violations: string[]; securitySigned: string[]; securityEscalated: number; fuE4: number; vetoed: string | null; resignsAfterVeto: number;
  handsRaised: number; handsAnsweredWithinSla: number; handsEscalated: number;
  opCards: number; proposals: number; holdEscalations: number;
}

export async function runSim(seed: number, opts: { ticks?: number; tickMin?: number } = {}): Promise<SimResult> {
  const ticks = opts.ticks ?? 24; const tickMin = opts.tickMin ?? 10;
  const r = rng(seed);
  const root = mkdtempSync(join(tmpdir(), `butler-sim-${seed}-`));
  const T0 = Date.parse('2026-11-27T00:44:00.000Z');
  let nowMs = T0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const simDir = (pr: number, sha: string) => `PREGATE-GREEN/${pr}-${sha.slice(0, 12)}-minim5`; // one sim host literal (resource-facts ratchet)
  // ── cells: 50 in the judge queue (10 eligible) ⊕ hand cells
  const kinds: CellKind[] = [...Array(10).fill('eligible'), ...Array(18).fill('no-receipt'), ...Array(5).fill('stale-head'), ...Array(10).fill('no-e4'), ...Array(3).fill('focused-fail'), ...Array(4).fill('security')];
  const cells = new Map<string, SimCell>();
  const facts = new Map<number, PrFacts>();
  kinds.forEach((kind, i) => {
    const id = `JQ-${String(i + 1).padStart(2, '0')}`; const pr = 40100 + i; const h = head(pr);
    const waited = 20 + Math.floor(r() * 60);
    cells.set(id, { id, kind, pr, title: id, status: 'yellow', owner: `TC-H-${(i % 16) + 1}`, updatedBy: 'TC', updatedAt: iso(T0 - waited * 60_000),
      doneCriterion: 'Merged change with passing receipt', evidence: `#${pr} merged` }); // GREEN-DEFINITION-ONE: no E4 lines and no evidence commands anywhere
    facts.set(pr, { pr, merged: true, landedHead: h, files: kind === 'security' ? ['src/oauth/token-refresh.ts'] : [`src/feature-${i}.ts`, `src/feature-${i}.test.ts`], securityFindings: [], binding: declares(id),
      receipt: kind === 'no-receipt' ? null : { head: kind === 'stale-head' ? head(pr, 7) : h, dir: simDir(pr, h), focusedFiles: 1,
        focused: kind === 'focused-fail' ? { pass: 30, fail: 2 } : { pass: 12 + i, fail: 0 } } });
  });
  // ── BUTLER-SIGN-MERGED-PATCHID cells (after the seeded draws above: the 00:44 world and its random sequence are unchanged)
  const EQ: Array<[CellKind, number]> = [['patch-id-reuse', 3], ['different-delta', 2], ['baseline-preexisting', 3], ['new-failure', 1], ['doc-only-l0', 3]];
  let eqN = 0;
  for (const [kind, n] of EQ) for (let k = 0; k < n; k++) {
    const id = `EQ-${String(++eqN).padStart(2, '0')}`; const pr = 40400 + eqN; const landed = head(pr); const earlier = head(pr, 3);
    cells.set(id, { id, kind, pr, title: id, status: 'yellow', owner: 'OP', updatedBy: 'land-graph', updatedAt: iso(T0 - 30 * 60_000), doneCriterion: 'Merged change with passing receipt', evidence: `#${pr} merged` });
    const doc = kind === 'doc-only-l0';
    const receipt: PrFacts['receipt'] =
      kind === 'patch-id-reuse' ? { head: landed, reusedFrom: earlier, dir: simDir(pr, earlier), focusedFiles: 2, focused: { pass: 20, fail: 0 }, grade: 'L2', focusedExit: 0 }
      : kind === 'different-delta' ? null
      : kind === 'baseline-preexisting' ? { head: landed, dir: simDir(pr, landed), focusedFiles: 4, focused: { pass: 87, fail: 1 }, grade: 'L3', focusedExit: 1, focusedBaseline: { mine: 1, onMain: 1, newFailures: [] } }
      : kind === 'new-failure' ? { head: landed, dir: simDir(pr, landed), focusedFiles: 4, focused: { pass: 40, fail: 2 }, grade: 'L3', focusedExit: 1, focusedBaseline: { mine: 2, onMain: 1, newFailures: ['x > breaks on head'] } }
      : { head: landed, dir: simDir(pr, landed), focusedFiles: 1, focused: null, grade: 'L0', focusedExit: null };
    facts.set(pr, { pr, merged: true, landedHead: landed, files: doc ? ['docs/conductor/X.md'] : [`src/eq-${eqN}.ts`, `src/eq-${eqN}.test.ts`], securityFindings: [], receipt, binding: declares(id),
      ...(kind === 'different-delta' ? { olderReceiptHead: earlier } : {}) });
  }
  const EQ_KINDS = new Set<CellKind>(EQ.map(([k]) => k));
  // ── hands: 16 blocked on TC (registered wildcard HOLD H-1) · 5 blocked on OP (unregistered broadcast #9001)
  const blocks: Array<{ -readonly [K in keyof HoldBlock]: HoldBlock[K] }> = [];
  const hands16 = Array.from({ length: 16 }, (_, i) => `TC-H-${i + 1}`);
  const hands5 = Array.from({ length: 5 }, (_, i) => `OP-H-${i + 1}`);
  hands16.forEach((h, i) => blocks.push({ by: h, on: 'TC', cell: `TCW-${i + 1}`, reason: '시험·원격 HOLD 유지', at: iso(T0 - 5 * 60_000) }));
  hands5.forEach((h, i) => blocks.push({ by: h, on: 'OP', cell: `OPW-${i + 1}`, reason: 'OP 금지', at: iso(T0 - 5 * 60_000) }));
  addHold(root, { owner: 'TC', cells: ['*'], reason: '시험·원격 실행 HOLD (OS 격리 입증 전)', unlock: 'TC confirms isolation recipe', ttlMs: 2 * 3_600_000, by: 'TC' }, { now: new Date(T0 - 15 * 60_000), fact: null });
  const broadcast = { coordinator: 'OP', msgId: 9001, at: iso(T0 - 10 * 60_000), frozen: hands5, scoped: false, body: '시험 금지 — OS 격리 먼저' };
  // ── ✋ to JUD about queue cells (judge domain) and one without facts
  let nextMsg = 10_000;
  const open = new Map<number, HandIn>();
  const raise = (from: string, cell: string, receiver = 'JUD') => {
    const id = nextMsg++;
    open.set(id, { id, rootId: id, sender: from, receiver, blockedSeat: from, cell, reason: 'judge', refs: [`block:${cell}`, `reason:judge`], createdAtMs: nowMs, body: `✋ ${cell} 판정 언제?` });
  };
  // ── ports
  const violations: string[] = []; const securitySigned: string[] = [];
  const posts: Array<{ key: string; to: string; body: string; at: number }> = [];
  const sent = new Set<string>();
  const fu = new Set<string>();
  let vetoed: string | null = null; let resigns = 0;
  const answered = new Map<number, number>(); const escalatedHands = new Set<number>();
  const memory = fileMemory(root);
  const ports = (): ButlerPorts => ({
    memory,
    merged: new Set([...facts.values()].filter(f => f.merged).map(f => f.pr)),
    sign(id, evidence, expected, attribution) {
      const c = cells.get(id);
      if (!c) throw new Error(`no cell ${id}`);
      if (c.status !== expected.status || c.evidence !== expected.evidence) throw new Error('snapshot moved');
      if (!attribution.decidedBy.startsWith('JUD')) throw new Error('judge-only');
      const v = judgeCell(c, facts);
      if (v.kind !== 'sign') violations.push(`${id} signed without done-when (${v.why})`);
      if (c.kind === 'security') securitySigned.push(id);
      Object.assign(c, { status: 'green', evidence, updatedBy: attribution.decidedBy, updatedAt: iso(nowMs) });
      if (id === vetoed) resigns++;
    },
    readCell: id => cells.get(id) ?? null,
    freshFacts: () => facts,
    // The seeded world supplies deterministic model responses; the live provider is never called.
    decomposeCriterion: async (_id, text) => ({ trusted: true, requirements: [{ id: 'R1', text, classification: 'must' }] }),
    judgeCriterion: async input => ({ trusted: true, policyVersion: 'sim', requirements: input.requirements.map(req => ({ id: req.id, classification: 'must', fulfilled: true, evidenceIds: [input.evidence[0]!.id], reason: 'seeded receipt fixture' })) }),
    expireHolds: (by, unlockFacts) => expireDue(root, { by, unlockFacts }, { now: new Date(nowMs), fact: null }),
    post(key, to, body) { if (sent.has(key)) return null; sent.add(key); posts.push({ key, to, body, at: nowMs }); return nextMsg++; },
    addFollowUp(id) { fu.add(id); return true; },
    answerHand(hand) { if (!open.has(hand.id)) return null; open.delete(hand.id); answered.set(hand.id, nowMs - hand.createdAtMs); return nextMsg++; },
    escalateHand(hand) { if (!open.has(hand.id)) return null; open.delete(hand.id); escalatedHands.add(hand.id); return nextMsg++; },
  });
  const view = () => ({ now: new Date(nowMs), version: '0.3.38', cells: [...cells.values()], prFacts: facts, holds: readHolds(root, new Date(nowMs)), blocks: [...blocks], hands: [...open.values()] });
  const queueStart = judgeQueue(view(), new Map([...cells.values()].map(c => [c.id, judgeCell(c, facts)] as const)));
  // raise 6 ✋ at t0: 3 on queue cells, 1 on a security cell, 1 on a covered hand cell, 1 with no facts
  raise('TC-H-1', 'JQ-01'); raise('TC-H-2', 'JQ-15'); raise('TC-H-3', 'JQ-35'); raise('TC-H-4', 'JQ-48'); raise('TC-H-5', 'TCW-5', 'JUDGE-BUTLER'); raise('TC-H-6', 'NOPE-1');
  let handsRaised = open.size;
  const notSignedFirstTick: Record<string, string> = {};
  const frozenSeries: number[] = []; let signedFirstTick = 0; let opCards = 0; let opRegistered = false; let tcActed = false;
  const frozenNow = (): number => {
    const holds = readHolds(root, new Date(nowMs)).filter(h => h.state === 'active' && Date.parse(h.expiresAt) > nowMs);
    const covered = new Set<string>();
    for (const b of blocks) if (holds.some(h => h.owner === b.on && (h.cells.includes('*') || h.cells.includes(b.cell)))) covered.add(b.by);
    const unreg = opRegistered ? 0 : blocks.filter(b => b.on === 'OP').length;
    return covered.size + unreg;
  };
  for (let t = 0; t < ticks; t++) {
    // world → evidence appears for some queue cells (hands make receipts / E4 lines) — seeded
    if (t > 0) for (const c of cells.values()) {
      if (c.status !== 'yellow' || c.kind === 'security' || c.kind === 'focused-fail' || c.kind === 'eligible' || EQ_KINDS.has(c.kind)) continue;
      if (r() < 0.18) {
        const f = facts.get(c.pr)!;
        if (c.kind !== 'no-e4') facts.set(c.pr, { ...f, receipt: { head: f.landedHead!, dir: `PREGATE-GREEN/${c.pr}-${f.landedHead!.slice(0, 12)}-node-b`, focusedFiles: 1, focused: { pass: 9, fail: 0 } } });
        c.kind = 'eligible'; c.updatedAt = iso(nowMs);
      }
    }
    // OP card for the unregistered broadcast (board steward rule) → OP registers a scoped HOLD 1–2 ticks later
    const cards = opRegistered ? [] : unregisteredCards([broadcast], readHolds(root, new Date(nowMs)), nowMs);
    if (cards.length && !sent.has(cards[0]!.key)) { sent.add(cards[0]!.key); opCards++; }
    if (!opRegistered && sent.has('hold-unregistered:9001') && r() < 0.7) {
      addHold(root, { owner: 'OP', cells: ['OPW-1'], reason: 'OS 격리 입증 — OPW-1 만', unlock: 'merged:#40400', ttlMs: 60 * 60_000, sourceMsg: 9001, by: 'OP' }, { now: new Date(nowMs), fact: null });
      opRegistered = true;
    }
    // TC answers the narrowing proposal (seeded) — else JUD does after the butler escalates
    const proposal = posts.find(p => p.key.startsWith('propose:H-1:'));
    if (proposal && !tcActed && r() < 0.35) { try { narrowHold(root, 'H-1', { cells: ['TCW-1', 'TCW-2'], ttlMs: 30 * 60_000, by: 'TC' }, { now: new Date(nowMs), fact: null }); } catch { /* closed */ } tcActed = true; }
    const esc = posts.find(p => p.key.startsWith('propose:H-1:') && p.key.endsWith(':jud'));
    if (esc && !tcActed) { try { narrowHold(root, 'H-1', { cells: ['TCW-1'], ttlMs: 20 * 60_000, by: 'JUD' }, { now: new Date(nowMs), fact: null }); } catch { /* closed */ } tcActed = true; }
    // JUD vetoes one butler green at tick 1 (the revert arrives as by «cli», as live on 11-27 19:18Z) — it must never be re-signed
    if (t === 1) { const g = [...cells.values()].find(c => c.status === 'green'); if (g) { Object.assign(g, { status: 'yellow', updatedBy: 'cli', updatedAt: iso(nowMs) }); vetoed = g.id; } }
    // a second-hour ✋ wave (judge domain)
    if (t === 6) { raise('TC-H-7', 'JQ-20'); raise('TC-H-8', 'JQ-30'); handsRaised += 2; }
    const before = [...cells.values()].filter(c => c.status === 'green').length;
    const woke = await wakeButler({ view: view(), ports: ports() });
    if (t === 0) for (const x of woke.tick.notSigned) if (x.cell.startsWith('EQ-')) notSignedFirstTick[x.cell] = x.why;
    const after = [...cells.values()].filter(c => c.status === 'green').length;
    if (t === 0) signedFirstTick = after - before;
    // hands that were told «not covered / expired» move on (their block clears)
    for (const p of posts) if (p.key.startsWith('freed:') && p.at === nowMs) { const hand = p.to; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.by === hand) blocks.splice(i, 1); }
    frozenSeries.push(frozenNow());
    nowMs += tickMin * 60_000;
    // refresh block timestamps of still-blocked hands (they keep waiting)
    for (const b of blocks) b.at = iso(nowMs - 5 * 60_000);
  }
  const signed = [...cells.values()].filter(c => c.status === 'green');
  const hours = (ticks * tickMin) / 60;
  const zero = frozenSeries.findIndex(v => v === 0);
  return {
    seed, ticks, signedFirstTick, signedTotal: signed.length, greensPerHour: Math.round((signed.length / hours) * 10) / 10,
    frozenSeries, frozenZeroAtTick: zero < 0 ? null : zero,
    queueStart, queueEnd: judgeQueue(view(), new Map([...cells.values()].filter(c => c.status === 'yellow').map(c => [c.id, judgeCell(c, facts)] as const)), memory.readState().reversed),
    equivalence: Object.fromEntries(EQ.map(([k]) => { const of = [...cells.values()].filter(c => c.kind === k); return [k, { cells: of.length, signed: of.filter(c => c.status === 'green').length }]; })),
    notSignedFirstTick,
    fuE4: fu.size, vetoed, resignsAfterVeto: resigns, violations, securitySigned, securityEscalated: posts.filter(p => p.key.startsWith('security:')).length,
    handsRaised, handsAnsweredWithinSla: [...answered.values()].filter(ms => ms <= 10 * 60_000).length, handsEscalated: escalatedHands.size,
    opCards, proposals: posts.filter(p => p.key.startsWith('propose:') && !p.key.endsWith(':jud')).length, holdEscalations: posts.filter(p => p.key.endsWith(':jud')).length,
  };
}
