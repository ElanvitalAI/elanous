// BUTLER-SIGN-MERGED-PATCHID (11-27 · live: green-triage 26 «merged + receipt», butler signed 0 refused 0).
// Literal expectations (independent of the product's renderers): the receipt rules shared with the land graph, the patch-id
// reuse of #40358 on a real squash-merged repo, the goal.yaml green_rules, and the one-line reason when the butler still refuses.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeCell, type PrFacts, type ReceiptFacts } from './done-when.js';
import { collectPrFacts } from './collector.js';
import { DEFAULT_GREEN_RULES, loadGreenRules, parseGreenRules } from './cards.js';
import { runTick, type ButlerPorts } from './body.js';
import { fileMemory } from './memory.js';
import { isDocOnly, noFocusedStage, preexistingOnly } from '../land-graph/receipt-rules.js';
import { patchIdOf, reuseByPatchId } from '../cli/land-graph-cli.js';
import type { Receipt } from '../land-graph/land-graph.js';

const H = 'a'.repeat(40);
const cell = (pr: number, id = 'C-1') => ({ id, status: 'yellow', evidence: `#${pr}` });
const facts = (receipt: ReceiptFacts | null, over: Partial<PrFacts> = {}) =>
  new Map([[40494, { pr: 40494, merged: true, landedHead: H, files: ['src/x.ts', 'src/x.test.ts'], securityFindings: [], receipt, ...over } satisfies PrFacts]]);
const dir = `PREGATE-GREEN/40494-${H.slice(0, 12)}-minim5`;

describe('receipt rules — one definition with the land graph', () => {
  test('doc-only · no focused stage · preexisting-only', () => {
    expect(isDocOnly(['docs/conductor/CTO-ORG-DESIGN.md'])).toBe(true);
    expect(isDocOnly(['docs/a.md', 'src/a.ts'])).toBe(false);
    expect(isDocOnly([])).toBe(false);
    expect(noFocusedStage({ focusedCount: 1, grade: 'L0', focusedExit: null })).toBe(true); // live 40494: L0 lists one file, runs none
    expect(noFocusedStage({ focusedCount: 0 })).toBe(true);
    expect(noFocusedStage({ focusedCount: 1, grade: 'L0', focusedExit: 0 })).toBe(false);
    expect(noFocusedStage({ focusedCount: 4, grade: 'L3', focusedExit: 1 })).toBe(false);
    expect(preexistingOnly({ mine: 1, newFailures: [] })).toBe(true); // live 40412 · 40401 · 40448: {mine 1 · onMain 1 · new []}
    expect(preexistingOnly({ mine: 2, newFailures: ['t > x'] })).toBe(false);
    expect(preexistingOnly({ mine: 0, newFailures: [] })).toBe(false);
    expect(preexistingOnly(undefined)).toBe(false);
  });
});

describe('judgeCell — the 11-27 live refusals', () => {
  test('doc-only PR with an L0 receipt (focused stage skipped) → sign «doc-only»', () => {
    const v = judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 1, focused: null, grade: 'L0', focusedExit: null }, { files: ['docs/conductor/CTO-ORG-DESIGN.md'] }));
    expect(v).toMatchObject({ kind: 'sign', e4: null });
    expect(v.why).toBe(`#40494@${H.slice(0, 12)} 40494-${H.slice(0, 12)}-minim5 doc-only · E4 없음 → FU`);
  });
  test('L0 receipt on a code PR → refused with the reason', () => {
    expect(judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 1, focused: null, grade: 'L0', focusedExit: null })).why)
      .toBe('#40494 focused stage (empty focused set on a code PR)');
  });
  test('one focused failure that also fails on main → sign · a head-only failure → refused naming it', () => {
    const fx = { focused: { pass: 87, fail: 1 }, grade: 'L3', focusedExit: 1 } as const;
    expect(judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 5, ...fx, focusedBaseline: { mine: 1, onMain: 1, newFailures: [] } })).why)
      .toBe(`#40494@${H.slice(0, 12)} 40494-${H.slice(0, 12)}-minim5 focused 87/1 preexisting-only (new 0 · 1 also red on main) · E4 없음 → FU`);
    expect(judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 5, ...fx, focusedBaseline: { mine: 1, onMain: 0, newFailures: ['router > picks tier'] } })).why)
      .toBe('#40494 focused exit 0 (87 pass 1 fail · baseline new 1 (router > picks tier))');
    expect(judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 5, ...fx })).why).toBe('#40494 focused exit 0 (87 pass 1 fail)');
  });
  test('raw swept: step exit 1 with preexisting-only baseline → sign', () => {
    expect(judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 3, focused: { exit: 1 }, focusedExit: 1, focusedBaseline: { mine: 2, onMain: 2, newFailures: [] } })))
      .toMatchObject({ kind: 'sign', why: expect.stringContaining('focused preexisting-only (2 also red on main)') });
  });
  test('receipt reused by patch-id → sign, the why names the earlier head; the evidence ref (veto fingerprint) does not', () => {
    const old = 'b'.repeat(40);
    const v = judgeCell(cell(40494), facts({ head: H, reusedFrom: old, dir: `PREGATE-GREEN/40494-${old.slice(0, 12)}-minim5`, focusedFiles: 2, focused: { pass: 9, fail: 0 } }));
    expect(v.kind).toBe('sign');
    expect(v.why).toContain(`(receipt of ${old.slice(0, 12)} · PR-own patch-id equal)`);
    expect(v.kind === 'sign' && v.evidence).toEqual([`#40494@${H.slice(0, 12)} 40494-${old.slice(0, 12)}-minim5 focused 9/0`]);
  });
  test('only an older-head receipt (no patch-id match) → refused «PR-own delta differs»', () => {
    expect(judgeCell(cell(40494), facts(null, { olderReceiptHead: 'c'.repeat(40) })).why)
      .toBe(`#40494 receipt cccccccccccc ≠ landed ${H.slice(0, 12)}: PR-own delta differs (patch-id) — re-run pregate --light on ${H.slice(0, 12)}`);
    expect(judgeCell(cell(40494), facts(null)).why).toBe(`#40494 same-head receipt (pregate --light on ${H.slice(0, 12)})`);
  });
});

describe('green_rules — policy in goal.yaml', () => {
  test('the shipped goal.yaml carries the default rules', () => {
    expect(loadGreenRules()).toEqual({ sameHead: ['exact', 'patch-id'], focusedOk: ['pass', 'step-exit-0', 'preexisting-on-main', 'doc-only-L0'] });
  });
  test('parse: lists narrow the rules · unknown names dropped · missing/malformed → default', () => {
    expect(parseGreenRules('green_rules:\n  same_head: [exact]\n  focused_ok: [pass, bogus]\n')).toEqual({ sameHead: ['exact'], focusedOk: ['pass'] });
    expect(parseGreenRules('kpi: {}\n')).toEqual(DEFAULT_GREEN_RULES);
    expect(parseGreenRules(': : [')).toEqual(DEFAULT_GREEN_RULES);
  });
  test('without patch-id in same_head a reused receipt is refused · without preexisting-on-main a baseline red is refused', () => {
    const rules = parseGreenRules('green_rules:\n  same_head: [exact]\n  focused_ok: [pass, step-exit-0]\n');
    expect(judgeCell(cell(40494), facts({ head: H, reusedFrom: 'b'.repeat(40), dir, focusedFiles: 2, focused: { pass: 9, fail: 0 } }), rules).why)
      .toBe(`#40494 receipt reused by patch-id from bbbbbbbbbbbb — green_rules.same_head has no patch-id (re-run pregate on ${H.slice(0, 12)})`);
    expect(judgeCell(cell(40494), facts({ head: H, dir, focusedFiles: 5, focused: { pass: 87, fail: 1 }, focusedBaseline: { mine: 1, onMain: 1, newFailures: [] } }), rules).kind).toBe('missing');
  });
});

/** A real repo: PR head h1 (receipt) → merge main (h2, same PR-own change) → squash-merged into main · or author edit (h3). */
function squashRepo() {
  const d = mkdtempSync(join(tmpdir(), 'butler-pid-'));
  const g = (...a: string[]) => { const r = spawnSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main');
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n'); writeFileSync(join(d, 'b.ts'), 'export const b = 1;\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'pr');
  writeFileSync(join(d, 'a.ts'), 'export const a = 2;\n'); g('commit', '-qam', 'pr change');
  const h1 = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main'); writeFileSync(join(d, 'b.ts'), 'export const b = 2;\n'); g('commit', '-qam', 'main moves');
  g('checkout', '-q', 'pr'); g('merge', '-q', '--no-edit', 'main');
  const h2 = g('rev-parse', 'HEAD');
  g('checkout', '-qb', 'pr-edit'); writeFileSync(join(d, 'a.ts'), 'export const a = 3;\n'); g('commit', '-qam', 'author edit');
  const h3 = g('rev-parse', 'HEAD');
  // squash-land h2 on main (gh pr merge --squash), then main moves on — origin/main is past the merge
  g('checkout', '-q', 'main'); g('merge', '-q', '--squash', 'pr'); g('commit', '-qm', 'squash #9');
  writeFileSync(join(d, 'c.ts'), 'export const c = 1;\n'); g('add', 'c.ts'); g('commit', '-qm', 'later main');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  return { d, h1, h2, h3 };
}

describe('merged-after-squash — #40358 patch-id reuse through the collector', () => {
  const { d, h1, h2, h3 } = squashRepo();
  const r1: Receipt = { dir: `/r/PREGATE-GREEN/40009-${h1.slice(0, 12)}-node-b`, head: h1, host: 'node-b', focused: ['a.test.ts'], rawDir: '', focusedExit: 0, grade: 'L2' };
  const run = (landed: string) => collectPrFacts([40009], {
    merged: new Map([[40009, 'f'.repeat(40)]]), landedHead: () => landed,
    prMeta: () => ({ head: landed, files: ['a.ts'] }),
    receipt: (_pr, head) => {
      const r = r1.head === head ? r1 : reuseByPatchId([r1], head, s => patchIdOf(d, s));
      return r ? { head: r.head, dir: r.dir, focusedFiles: r.focused.length, focused: { pass: 4, fail: 0 }, focusedExit: r.focusedExit ?? null, ...(r.grade ? { grade: r.grade } : {}), ...(r.reusedFrom ? { reusedFrom: r.reusedFrom } : {}) } : null;
    },
    olderReceiptHead: (_pr, head) => (r1.head !== head ? r1.head : null),
    security: () => [],
  });
  test('squash-merged head that only merged main since the receipt → signed', () => {
    expect(patchIdOf(d, h2)).toBe(patchIdOf(d, h1)); // still equal after the squash landed and main moved on
    const v = judgeCell({ id: 'SQ-1', status: 'yellow', evidence: '#40009' }, run(h2));
    expect(v.kind).toBe('sign');
    expect(v.why).toBe(`#40009@${h2.slice(0, 12)} 40009-${h1.slice(0, 12)}-node-b focused 4/0 (receipt of ${h1.slice(0, 12)} · PR-own patch-id equal) · E4 없음 → FU`);
  });
  test('genuinely different PR-own delta → refused with the reason', () => {
    const v = judgeCell({ id: 'SQ-2', status: 'yellow', evidence: '#40009' }, run(h3));
    expect(v).toMatchObject({ kind: 'missing' });
    expect(v.why).toBe(`#40009 receipt ${h1.slice(0, 12)} ≠ landed ${h3.slice(0, 12)}: PR-own delta differs (patch-id) — re-run pregate --light on ${h3.slice(0, 12)}`);
  });
});

describe('runTick — a refusal is never silent', () => {
  test('not-signed: reason in the tick report every tick · one case per reason change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-ns-'));
    const memory = fileMemory(root);
    let receipt: ReceiptFacts | null = null;
    const c = { id: 'NS-1', title: 'NS-1', status: 'yellow', evidence: '#40494', updatedAt: '2026-11-27T08:00:00.000Z', updatedBy: 'land-graph' };
    const ports: ButlerPorts = { memory, merged: new Set([40494]), sign: () => { throw new Error('no sign expected'); }, readCell: () => c, freshFacts: () => facts(receipt),
      expireHolds: () => [], post: () => null, answerHand: () => null, escalateHand: () => null };
    const view = (min: number) => ({ now: new Date(Date.parse('2026-11-27T08:10:00.000Z') + min * 60_000), version: '0.3.38', cells: [c], prFacts: facts(receipt), holds: [], blocks: [], hands: [] });
    const t1 = await runTick(view(0), ports);
    expect(t1.signed).toEqual([]);
    expect(t1.notSigned).toEqual([{ cell: 'NS-1', why: `missing — #40494 same-head receipt (pregate --light on ${H.slice(0, 12)})` }]);
    const t2 = await runTick(view(10), ports);
    expect(t2.notSigned.length).toBe(1);
    receipt = { head: H, dir, focusedFiles: 4, focused: { pass: 40, fail: 2 }, focusedBaseline: { mine: 2, onMain: 1, newFailures: ['x > y'] } };
    const t3 = await runTick(view(20), ports);
    expect(t3.notSigned).toEqual([{ cell: 'NS-1', why: 'missing — #40494 focused exit 0 (40 pass 2 fail · baseline new 1 (x > y))' }]);
    expect(memory.cases().filter(k => k.kind === 'not-signed').map(k => k.why)).toEqual([
      `missing — #40494 same-head receipt (pregate --light on ${H.slice(0, 12)})`,
      'missing — #40494 focused exit 0 (40 pass 2 fail · baseline new 1 (x > y))']);
  });
});
