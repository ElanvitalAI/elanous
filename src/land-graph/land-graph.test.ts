import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLandExit, decide, replayAttempt, security4Hits, tickLand, type Facts, type LandDeps } from './land-graph.js';

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
  test('shadow posts no card unless a card seat is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-')); const posts: string[] = [];
    await tickLand(deps(root, { mode: 'shadow', receipt: () => null, post: to => { posts.push(to); } }));
    expect(posts).toEqual([]);
    await tickLand(deps(mkdtempSync(join(tmpdir(), 'lg-')), { mode: 'shadow', cardSeat: 'TEST-LAND', receipt: () => null, post: to => { posts.push(to); } }));
    expect(posts).toEqual(['TEST-LAND']);
  });
});
