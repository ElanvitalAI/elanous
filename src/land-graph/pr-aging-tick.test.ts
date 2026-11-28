// PR-ZOMBIE-AGING in the land tick (tickLand · the land steward's body): live drafts the 7-day conflicting PR and cards its
// author once · the 14-day one gets one close proposal (author ⊕ landing owner) and is never closed · shadow only reports ·
// the per-tick cap defers · a failed draft is retried next tick. Expected values are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrAgingPolicy, prAgingPolicyPath } from '../kit/pr-aging/index.js';
import { appendLedger, readLedger, tickLand, type LandDeps, type PrInfo } from './land-graph.js';

const NOW = new Date('2026-11-29T02:30:00.000Z');
const daysAgo = (d: number) => NOW.getTime() - d * 86_400_000;
const H = (n: number) => n.toString(16).padStart(40, '0');
const ORG = join(mkdtempSync(join(tmpdir(), 'pa-org-')), 'federation.yaml');
writeFileSync(ORG, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
const policyText = readFileSync(prAgingPolicyPath(), 'utf8');
const pr = (n: number, o: Partial<PrInfo> = {}): PrInfo => ({ number: n, head: H(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files: [`src/f${n}.ts`], ...o });

function world(over: Partial<LandDeps> = {}, text = policyText) {
  const root = mkdtempSync(join(tmpdir(), 'pa-tick-'));
  const st = { drafted: [] as number[], posts: [] as Array<[string, string]>, closed: [] as number[], failNext: false };
  const prs = new Map<number, PrInfo>([
    [36101, pr(36101, { author: 'MK' })],                 // 8 d · RED merge-main → to-draft
    [36102, pr(36102, { draft: true })],                  // 15 d · land refused merge-conflict → close proposal
    [40103, pr(40103)],                                   // 1 d · RED merge-main → fresh, untouched
    [36104, pr(36104)],                                   // 30 d · no conflict signal → untouched
    [36105, pr(36105, { updatedAt: '2026-11-20T02:30:00.000Z' })], // no local commit · updatedAt 9 d · RED merge-main → to-draft
  ]);
  const commit = new Map([[H(36101), daysAgo(8)], [H(36102), daysAgo(15)], [H(40103), daysAgo(1)], [H(36104), daysAgo(30)]]);
  appendLedger(root, { at: '2026-11-20T00:00:00.000Z', mode: 'live', pr: 36102, head: H(36102), event: 'refused', cls: 'merge-conflict', why: 'STOP merge rc=1' });
  const d: LandDeps = {
    now: () => NOW, stateRoot: root, mode: 'live', slots: 1, org: { path: ORG },
    listPrs: async () => [...prs.values()], prNow: async n => prs.get(n) ?? null,
    receipt: () => null, olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
    land: async () => ({ rc: 0, text: '' }), post: (to, body) => { if (body.includes('PR 노화')) st.posts.push([to, body]); }, record: () => {},
    closePr: p => { st.closed.push(p.number); return { ok: true }; },
    prAging: parsePrAgingPolicy(text),
    headTimes: heads => new Map(heads.flatMap(h => commit.has(h) ? [[h, commit.get(h)!] as const] : [])),
    redSteps: (n) => (n === 36101 || n === 40103 || n === 36105 ? ['merge-main'] : ['focused']),
    toDraft: p => {
      if (st.failNext) { st.failNext = false; return { ok: false, why: 'HTTP 502' }; }
      st.drafted.push(p.number); prs.set(p.number, { ...p, draft: true }); return { ok: true };
    },
    ...over,
  };
  return { root, st, d };
}

describe('PR-ZOMBIE-AGING · land tick', () => {
  test('live: two drafts with one author card each · one close proposal to author ⊕ landing owner · nothing closed', async () => {
    const { root, st, d } = world();
    const t1 = await tickLand(d);
    expect(t1.aging!.map(a => [a.pr, a.stage, a.action, a.ageDays, a.basis])).toEqual([
      [36102, 'close-proposal', 'proposed', 15, 'commit'],
      [36105, 'to-draft', 'drafted', 9, 'pr-updated'],
      [36101, 'to-draft', 'drafted', 8, 'commit'],
    ]);
    expect(st.drafted).toEqual([36105, 36101]);
    expect(st.posts.map(([to]) => to)).toEqual(['UX', 'TC', 'UX', 'MK']);
    expect(st.closed).toEqual([]);
    const tick = JSON.parse(readFileSync(join(root, 'land-graph', 'last-tick.json'), 'utf8')) as { aging: Record<string, number[]> };
    expect(tick.aging).toEqual({ drafted: [36105, 36101], wouldDraft: [], draftFailed: [], deferred: [], closeProposals: [36102] });
    // second tick: the drafts are drafts now (under 14 d → no stage) · the proposal is not re-sent
    const t2 = await tickLand(d);
    expect(t2.aging!.map(a => [a.pr, a.action])).toEqual([[36102, 'proposed-before']]);
    expect(st.posts.length).toBe(4);
    expect(readLedger(root).filter(r => r.event === 'aging').map(r => [r.pr, r.stage])).toEqual([[36102, 'close-proposal'], [36105, 'to-draft'], [36101, 'to-draft']]);
  });

  test('shadow: would-draft / would-propose · no gh write · no card · no ledger row', async () => {
    const { root, st, d } = world({ mode: 'shadow' });
    const t = await tickLand(d);
    expect(t.aging!.map(a => [a.pr, a.action])).toEqual([[36102, 'would-propose'], [36105, 'would-draft'], [36101, 'would-draft']]);
    expect([st.drafted, st.posts, readLedger(root).filter(r => r.event === 'aging')]).toEqual([[], [], []]);
  });

  test('per-tick cap from the YAML defers the rest · a failed draft is retried next tick with its card', async () => {
    const { st, d } = world({}, policyText.replace('max_per_tick: 20', 'max_per_tick: 1'));
    st.failNext = true;
    const t1 = await tickLand(d);
    expect(t1.aging!.filter(a => a.stage === 'to-draft').map(a => [a.pr, a.action])).toEqual([[36105, 'draft-failed'], [36101, 'drafted']]);
    const t2 = await tickLand(d);
    expect(t2.aging!.filter(a => a.stage === 'to-draft').map(a => [a.pr, a.action])).toEqual([[36105, 'drafted']]);
    expect(st.posts.filter(([, b]) => b.includes('draft 로 돌림')).map(([to]) => to)).toEqual(['MK', 'UX']);
  });

  test('no policy on the deps → no aging at all (the land body is unchanged)', async () => {
    const { st, d } = world({ prAging: null });
    const t = await tickLand(d);
    expect([t.aging, st.drafted]).toEqual([undefined, []]);
  });
});
