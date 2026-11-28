import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedger, classifyLandExit, decide, readLedger, refusalContext, replayAttempt, security4Hits, tickLand, type Facts, type LandDeps } from './land-graph.js';

const pr = { number: 40001, head: 'a'.repeat(40), base: 'main', draft: false, state: 'OPEN' as const, title: 't', author: 'TC', files: ['src/x.ts'] };
const receipt = { dir: '/r/40001-aaaaaaaaaaaa-minim5', head: 'a'.repeat(40), host: 'minim5', focused: ['src/x.test.ts'], rawDir: '/raw' };
const ORG = join(mkdtempSync(join(tmpdir(), 'lg-org-')), 'federation.yaml');
writeFileSync(ORG, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
const facts = (o: Partial<Facts> = {}): Facts => ({ org: { path: ORG }, pr, receipt, olderReceiptHead: null, focused: { pass: 9, fail: 0 }, hold: null, security: [], landedBefore: false, ...o });

describe('decide', () => {
  test('same-head receipt + focused 0 fail → land', () => { expect(decide(facts()).action).toBe('land'); });
  test('receipt of an older head → stale-head card to the author', () => {
    const d = decide(facts({ receipt: null, olderReceiptHead: 'b'.repeat(40) }));
    expect([d.action, d.cls, d.card?.to]).toEqual(['refuse', 'stale-head', ['TC']]);
    expect(d.card?.body).toContain('bbbbbbbbbbbb');
  });
  test('doc-only with empty focused → L0 land; code with empty focused → refuse', () => {
    expect(decide(facts({ pr: { ...pr, files: ['docs/a.md'] }, receipt: { ...receipt, focused: [] }, focused: null })).lane).toBe('L0-doc-only');
    expect(decide(facts({ receipt: { ...receipt, focused: [] }, focused: null })).cls).toBe('no-focused-stage');
  });
  test('only security-4 findings bind', () => { expect(decide(facts({ security: ['auth:x'] })).cls).toBe('security-finding'); });
  test('cardSeat overrides every recipient', () => { expect(decide(facts({ hold: 'x', cardSeat: 'TEST-LAND' })).card?.to).toEqual(['TEST-LAND']); });
});

describe('decide · JUD-RELAX land rule (CEO 11-26)', () => {
  test('swept raw + receipt focused step exit 0 → land (bun exit 0 ⇔ 0 fail)', () => {
    const d = decide(facts({ focused: { swept: true, exit: 0 } }));
    expect([d.action, d.why.includes('focused step exit 0')]).toEqual(['land', true]);
  });
  test('swept raw exit 1 → refuse; with a baseline-name-diff introduced 0 → land', () => {
    expect(decide(facts({ focused: { swept: true, exit: 1 } })).cls).toBe('baseline-failing-focused');
    const nd = { receipt: '/nd.json', command: 'bun test a', headPass: 30, headFail: 2 };
    expect(decide(facts({ focused: { swept: true, exit: 1 }, baselineDiff: nd })).action).toBe('land');
    expect(decide(facts({ focused: { pass: 30, fail: 2 }, baselineDiff: nd })).action).toBe('land');
  });
  test('L0 receipt (focused stage skipped, list recorded) on doc-only files → L0 land · on code → refuse', () => {
    const l0 = { ...receipt, focused: ['test/rules-contract.test.ts'], grade: 'L0', focusedExit: null };
    const doc = decide(facts({ pr: { ...pr, files: ['docs/conductor/A.md'] }, receipt: l0, focused: 'unreadable' }));
    expect([doc.action, doc.lane]).toEqual(['land', 'L0-doc-only']);
    expect(decide(facts({ receipt: l0, focused: 'unreadable' })).cls).toBe('no-focused-stage');
  });
  test('hot file is no longer a JUD review wait', () => {
    expect(decide(facts({ pr: { ...pr, files: ['src/index.ts', 'package.json'] } })).action).toBe('land');
  });
  test('security-4 path: no Terra → wait review-required (card author) · PASS/WARN → land · FAIL → wait · security finding → refuse', () => {
    const sec = { ...pr, files: ['src/oauth/refresh.ts'] };
    const none = decide(facts({ pr: sec }));
    expect([none.action, none.cls, none.card?.to]).toEqual(['wait', 'review-required', ['TC']]);
    expect(none.card?.body).toContain('--model gpt-6.1-terra');
    expect(decide(facts({ pr: sec, terra: { verdict: 'pass', securityFindings: [] } })).action).toBe('land');
    expect(decide(facts({ pr: sec, terra: { verdict: 'WARN', securityFindings: [] } })).action).toBe('land');
    expect(decide(facts({ pr: sec, terra: { verdict: 'fail', securityFindings: [] } })).cls).toBe('review-required');
    expect(decide(facts({ pr: sec, terra: { verdict: 'pass', securityFindings: ['secret-leak:x'] } })).cls).toBe('security-finding');
  });
  test('non-security path ignores Terra entirely', () => {
    expect(decide(facts({ terra: { verdict: 'fail', securityFindings: [] } })).action).toBe('land');
  });
  test('security-4 path classes', () => {
    expect(security4Hits(['src/oauth/a.ts', 'src/secret/b.ts', 'src/pty/c.ts', 'src/disk-steward/d.ts', 'src/els/server-auth.ts', 'scripts/vm-deploy.sh'])
      .map(x => x.split(':')[0])).toEqual(['auth', 'secret', 'remote-exec', 'destroy', 'auth', 'remote-exec']);
    // One shared table with the judge-butler (GREEN-DEFINITION-ONE): the land path's authority boundary only · tests/patches never.
    expect(security4Hits(['src/cli/land-graph-cli.ts', 'src/org/land-authority.ts', 'src/org/org-map.ts', 'seat-state/OP/tools/op-waiver.sh'])
      .map(x => x.split(':')[0])).toEqual(['auth', 'auth', 'auth']);
    expect(security4Hits(['src/land-graph/land-graph.ts', 'seat-state/OP/patches/JUD-RELAX-op-waiver-security-only.patch', 'src/pty/spawn.test.ts'])).toEqual([]);
    expect(security4Hits(['src/org/seat-roles.ts', 'src/user-config-codex-credits.ts', 'docs/a.md', 'src/llm/token-count.ts'])).toEqual([]);
  });
});

describe('classifyLandExit (11-25 STOP lines)', () => {
  const rows: Array<[number, string, string]> = [
    [9, 'STOP isolation-gate rc=1 (전체 트리 검사 — pr land 와 같은 검사)', 'isolation-gate'],
    [6, 'STOP preflight rc=1', 'test-interference'],
    [8, 'STOP baseline failure-name diff', 'baseline-failing-focused'],
    [7, 'STOP merge rc=1', 'merge-conflict'],
    [10, 'STOP tsc-preflight rc=1', 'tsc'],
    [10, 'STOP verdict-hold-at-merge(/x/jud-1-a.json)', 'held'],
    [4, 'STOP focused 원문 불명/실패:  64 pass  4 fail ', 'baseline-failing-focused'],
    [4, 'STOP focused 원문 불명/실패: ', 'no-focused-stage'],
    [4, 'REFUSE base=feat/x', 'base-not-main'],
    [3, 'STOP 같은 head(abc) pregate 영수 없음 — 먼저 pregate.py 1 --light', 'no-receipt'],
    [5, 'STOP waiver rc=6', 'review-disposition'],
  ];
  for (const [rc, text, cls] of rows) test(`rc ${rc} «${text}» → ${cls}`, () => { expect(classifyLandExit(rc, `OK baseline-name-diff\n${text}`) as string | null).toBe(cls); });
  test('rc 0 → null', () => { expect(classifyLandExit(0, 'STOP x')).toBeNull(); });
});

describe('replayAttempt', () => {
  test('doc-only STOP is an intended divergence', () => {
    expect(replayAttempt(40130, 'a', 4, 'OPEN', 'STOP focused 원문 불명/실패: \n', true)).toMatchObject({ graph: 'land', match: false, note: 'intended: L0 doc-only lane lands with receipt' });
  });
  test('rc≠0 but MERGED = landed', () => { expect(replayAttempt(1, 'a', 1, 'MERGED', '', false)).toMatchObject({ graph: 'land', match: true }); });
});

describe('tickLand', () => {
  test('independent literal: overlapping files wait even with four available slots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-serial-'));
    const a = { ...pr, number: 41001, files: ['src/shared.ts'] };
    const b = { ...pr, number: 41002, files: ['src/shared.ts'] };
    const c = { ...pr, number: 41003, files: ['src/other.ts'] };
    const landed: number[] = [];
    const result = await tickLand({
      now: () => new Date('2026-11-25T21:00:00Z'), stateRoot: root, mode: 'live', synthetic: true, slots: 4,
      listPrs: async () => [a, b, c], prNow: async n => [a, b, c].find(p => p.number === n)!,
      receipt: () => receipt, olderReceiptHead: () => null, focused: () => ({ pass: 9, fail: 0 }), security: () => [],
      land: async p => { landed.push(p.number); return { rc: 0, text: '' }; }, post: () => {}, record: () => {},
    });
    expect(landed).toEqual([41001, 41003]);
    expect(result.landed).toEqual([41001, 41003]);
    expect(result.decisions.map(d => [d.pr, d.action, d.cls ?? null])).toEqual([
      [41001, 'land', null], [41002, 'wait', 'main-moved-overlap'], [41003, 'land', null],
    ]);
  });

  const deps = (stateRoot: string, over: Partial<LandDeps> = {}): LandDeps => ({
    now: () => new Date('2026-11-25T21:00:00Z'), stateRoot, mode: 'live', slots: 2,
    listPrs: async () => [pr], prNow: async () => pr, receipt: () => receipt, olderReceiptHead: () => null,
    focused: () => ({ pass: 9, fail: 0 }), security: () => [], land: async () => ({ rc: 0, text: '' }), post: () => {}, record: () => {}, ...over,
  });
  test('a refused gate on the same head is not re-run next tick', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-')); let lands = 0; const state = 'OPEN' as const;
    const d = deps(root, { land: async () => { lands++; return { rc: 9, text: 'STOP isolation-gate rc=1' }; }, prNow: async () => ({ ...pr, state }) });
    await tickLand(d); await tickLand(d);
    expect(lands).toBe(1);
  });
  test('a JUD HOLD verdict on file vetoes like a hold (re-checked before the merge)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-')); let lands = 0;
    const res = await tickLand(deps(root, { org: { path: ORG }, judHold: () => ({ reason: 'HOLD verdict hold-40001', by: 'JUD' }), land: async () => { lands++; return { rc: 0, text: '' }; } }));
    expect([lands, res.decisions[0]?.action]).toEqual([0, 'hold']);
  });
  // LAND10-RESTICKY-REFUSAL — the #40516 shape (11-27): refused stale-base-revert, then the author added the
  // «의도된 삭제» lines to the PR body at the SAME head. The refusal used to stick until a new head.
  describe('same-head refusal re-judged when its context changes (#40516 shape)', () => {
    const DECLARED = '의도된 삭제: graphs/triggers/a.yaml (moved to agent.yaml)';
    const world = (root: string, over: Partial<LandDeps> = {}) => {
      const st = { body: 'feat: move triggers', guard: 0, lands: 0, hold: null as null | { reason: string; by: string } };
      const cur = () => ({ ...pr, body: st.body });
      const d = deps(root, {
        org: { path: ORG }, listPrs: async () => [cur()], prNow: async () => cur(), judHold: () => st.hold,
        staleRevert: p => { st.guard++; return (p.body ?? '').includes('의도된 삭제') ? { ok: true } : { ok: false, why: 'graphs/triggers/a.yaml←30ee342ce9 (not own)' }; },
        land: async () => { st.lands++; return { rc: 0, text: '' }; }, ...over,
      });
      return { st, d };
    };
    test('body unchanged → the refusal sticks (guard runs once) · body gains «의도된 삭제» → same head re-judged and lands', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lg-')); const { st, d } = world(root);
      await tickLand(d); await tickLand(d);
      expect([st.guard, st.lands]).toEqual([1, 0]);
      const refused = readLedger(root).filter(r => r.event === 'refused');
      expect(refused.map(r => r.cls)).toEqual(['stale-base-revert']);
      expect(refused[0]!.ctx).toMatch(/^[0-9a-f]{16}$/);
      st.body = `feat: move triggers\n\n${DECLARED}`;
      const t3 = await tickLand(d);
      expect([st.guard, st.lands, t3.landed]).toEqual([2, 1, [40001]]);
      expect(t3.decisions[0]!.why).toContain('re-judge: context changed since refusal stale-base-revert');
    });
    test('a new receipt dir at the same head re-judges; the same context after a second refusal sticks again', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lg-')); let dir = receipt.dir;
      const { st, d } = world(root, { receipt: () => ({ ...receipt, dir }) });
      await tickLand(d);
      dir = '/r/40001-aaaaaaaaaaaa-node-b';
      await tickLand(d); await tickLand(d);
      expect([st.guard, st.lands]).toEqual([2, 0]);
    });
    test('a HOLD set and cleared after the refusal re-judges the same head', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lg-')); const { st, d } = world(root);
      await tickLand(d);
      st.hold = { reason: 'HOLD verdict hold-40001', by: 'JUD' };
      const held = await tickLand({ ...d, now: () => new Date('2026-11-25T21:05:00Z') });
      expect(held.decisions[0]!.action).toBe('hold');
      st.hold = null;
      await tickLand({ ...d, now: () => new Date('2026-11-25T21:10:00Z') });
      expect(st.guard).toBe(2);
    });
    test('a legacy refusal row without a context keeps sticking (no mass re-run on deploy)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lg-')); const { st, d } = world(root);
      appendLedger(root, { at: '2026-11-25T20:00:00.000Z', mode: 'live', pr: pr.number, head: pr.head, event: 'refused', cls: 'stale-base-revert', why: 'graphs/triggers/a.yaml←30ee342ce9' });
      st.body = DECLARED;
      await tickLand(d);
      expect([st.guard, st.lands]).toEqual([0, 0]);
    });
    test('context = body (CRLF/whitespace-normalized) ⊕ sorted labels ⊕ receipt dir ⊕ baseline-diff receipt', () => {
      const base = refusalContext({ body: 'a\nb' }, receipt);
      expect(refusalContext({ body: ' a\r\nb \n' }, receipt)).toBe(base);
      expect(refusalContext({ body: 'a\nb', labels: [] }, receipt)).toBe(base);
      expect(refusalContext({ body: 'a\nb', labels: ['x', 'y'] }, receipt)).toBe(refusalContext({ body: 'a\nb', labels: ['y', 'x'] }, receipt));
      expect(new Set([base, refusalContext({ body: 'a\nb', labels: ['x'] }, receipt), refusalContext({ body: 'a\nb' }, null),
        refusalContext({ body: 'a\nb' }, receipt, { receipt: '/nd.json' }), refusalContext({ body: 'a\nc' }, receipt)]).size).toBe(5);
    });
  });
  test('shadow posts no card unless a card seat is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-')); const posts: string[] = [];
    await tickLand(deps(root, { mode: 'shadow', receipt: () => null, post: to => { posts.push(to); } }));
    expect(posts).toEqual([]);
    await tickLand(deps(mkdtempSync(join(tmpdir(), 'lg-')), { mode: 'shadow', cardSeat: 'TEST-LAND', receipt: () => null, post: to => { posts.push(to); } }));
    expect(posts).toEqual(['TEST-LAND']);
  });
});
