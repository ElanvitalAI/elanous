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
import { classifyBoardRequirements } from '../kit/requirement-judge/index.js';
import { isDocOnly, noFocusedStage, preexistingOnly } from '../land-graph/receipt-rules.js';
import { patchIdOf, reuseByPatchId } from '../cli/land-graph-cli.js';
import type { Receipt } from '../land-graph/land-graph.js';

const H = 'a'.repeat(40);
const cell = (pr: number, id = 'C-1') => ({ id, status: 'yellow', evidence: `#${pr}` });
const facts = (receipt: ReceiptFacts | null, over: Partial<PrFacts> = {}) =>
  new Map([[40494, { pr: 40494, merged: true, landedHead: H, files: ['src/x.ts', 'src/x.test.ts'], securityFindings: [], receipt, binding: { declared: ['C-1', 'NS-1', 'CR-1', 'CR-2', 'CR-STALE'], title: [], branch: [], pipeline: [], selfDeclared: true, evidence: [] }, ...over } satisfies PrFacts]]);
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
    expect(loadGreenRules()).toEqual({ sameHead: ['exact', 'patch-id'], focusedOk: ['pass', 'step-exit-0', 'preexisting-on-main', 'doc-only-L0'], prBinding: ['cell-line', 'title', 'branch', 'pipeline', 'own-evidence'], prMetaFetchPerTick: 40 });
  });
  test('parse: lists narrow the rules · unknown names dropped · missing/malformed → default', () => {
    expect(parseGreenRules('green_rules:\n  same_head: [exact]\n  focused_ok: [pass, bogus]\n')).toEqual({ sameHead: ['exact'], focusedOk: ['pass'], prBinding: ['cell-line', 'title', 'branch', 'pipeline', 'own-evidence'], prMetaFetchPerTick: 40 });
    expect(parseGreenRules('green_rules:\n  pr_binding: [cell-line, bogus]\n  pr_meta_fetch_per_tick: 3\n')).toMatchObject({ prBinding: ['cell-line'], prMetaFetchPerTick: 3 });
    expect(parseGreenRules('green_rules:\n  pr_meta_fetch_per_tick: -1\n')).toMatchObject({ prMetaFetchPerTick: 40 });
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
    prMeta: () => ({ head: landed, files: ['a.ts'], title: 'fix(sq): squash', body: '칸: SQ-1 · SQ-2', headRef: 'sq' }), cells: [{ id: 'SQ-1' }, { id: 'SQ-2' }],
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

describe('doneCriterion at the signing boundary', () => {
  test('structured classifier, completeness, edges and restart', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'criterion-'));
    let c: any = { ...cell(40494, 'CR-1'), title: 'criterion', doneCriterion: '[must] core works\n[edge] retry\n[edge] display', updatedAt: '2026-11-27T08:00:00Z' };
    const pf = facts({ head: H, dir, focusedFiles: 1, focused: { pass: 3, fail: 0 }, focusedExit: 0 });
    const fu = new Set<string>(); const mail: string[] = []; let mode = 'pass';
    const ports: ButlerPorts = { memory: fileMemory(memoryDir), merged: new Set([40494]), freshFacts: () => pf, readCell: id => (id === 'CR-1' ? c : null),
      sign: (_id, evidence, expected) => { expect(expected.doneCriterion).toBe(c.doneCriterion); c = { ...c, status: 'green', evidence, updatedBy: 'JUDGE-BUTLER' }; },
      decomposeCriterion: async () => ({ trusted: true, policyVersion: '1', requirements: [{ id: 'R1', text: 'core works', classification: 'must' }, { id: 'R2', text: 'retry', classification: 'edge' }, { id: 'R3', text: 'display', classification: 'edge' }] }),
      // JUDGE-NOT-OVERSTRICT: «must-fail» = a cited contradiction (verbatim clause ⊕ the contradicting evidence id) — the one refusal
      judgeCriterion: input => classifyBoardRequirements(input, { callLLM: async () => JSON.stringify({ requirements: input.requirements.map((r, i) => ({ id: r.id, classification: r.classification, fulfilled: i === 0 && mode !== 'must-fail',
        evidenceIds: i === 0 ? [input.evidence[0]!.id] : [], reason: i === 0 && mode === 'must-fail' ? 'PR files never touch the core path' : 'fixture',
        gap: i === 0 && mode === 'must-fail' ? 'contradicted' : i === 0 ? 'none' : 'not-shown', clause: i === 0 && mode === 'must-fail' ? 'core works' : '' })) }) }),
      addFollowUp: id => { fu.add(id); return true; }, expireHolds: () => [], post: (_k, _to, body) => { mail.push(body); return 1; }, answerHand: () => null, escalateHand: () => null };
    const tick = (tickPorts: ButlerPorts = ports) => runTick({ now: new Date('2026-11-27T08:10:00Z'), version: '0.3.38', cells: [c], prFacts: pf, holds: [], blocks: [], hands: [] }, tickPorts);
    mode = 'must-fail'; const refused = await tick(); expect(refused.signed).toEqual([]); expect(c.status).toBe('yellow');
    expect(refused.signRefused).toEqual([{ cell: 'CR-1', why: '필수 미충족 — «core works» · 반대 근거 PR-40494: PR files never touch the core path' }]);
    expect(mail).toEqual(['[판정 집사 → JUD] CR-1: 필수 미충족 — «core works» · 반대 근거 PR-40494: PR files never touch the core path. 서명하지 않음.']);
    expect(fu.size).toBe(0);
    mode = 'pass'; expect((await tick()).signed).toEqual(['CR-1']); expect(fu.size).toBe(3); // 2 independent edges plus E4
    const edgeIds = [...fu].filter(id => id.startsWith('CR-1-FU-')); expect(edgeIds).toHaveLength(2);
    await tick({ ...ports, memory: fileMemory(memoryDir) }); expect([...fu].filter(id => id.startsWith('CR-1-FU-'))).toEqual(edgeIds);
  });
  test('changed criterion during judgment creates no follow-up and does not sign', async () => {
    const memory = fileMemory(mkdtempSync(join(tmpdir(), 'criterion-stale-')));
    let c = { ...cell(40494, 'CR-STALE'), title: 'criterion', doneCriterion: '[must] core\n[edge] retry' };
    const original = c;
    const pf = facts({ head: H, dir, focusedFiles: 1, focused: { pass: 3, fail: 0 }, focusedExit: 0 });
    const followUps: string[] = [];
    const ports: ButlerPorts = { memory, merged: new Set([40494]), freshFacts: () => pf, readCell: () => c,
      sign: () => { throw Error('unexpected sign'); },
      decomposeCriterion: async () => ({ trusted: true, policyVersion: '1', requirements: [{ id: 'R1', text: 'core', classification: 'must' }, { id: 'R2', text: 'retry', classification: 'edge' }] }),
      judgeCriterion: async input => {
        c = { ...c, doneCriterion: '[must] changed' };
        return { trusted: true, policyVersion: '1', requirements: input.requirements.map((r, i) => ({ id: r.id, classification: i === 0 ? 'must' : 'edge', fulfilled: i === 0, evidenceIds: i === 0 ? [input.evidence[0]!.id] : [], reason: 'fixture' })) };
      },
      addFollowUp: id => { followUps.push(id); return true; }, expireHolds: () => [], post: () => 1, answerHand: () => null, escalateHand: () => null };
    const result = await runTick({ now: new Date('2026-11-27T08:10:00Z'), version: '0.3.38', cells: [original], prFacts: pf, holds: [], blocks: [], hands: [] }, ports);
    expect(result.signed).toEqual([]);
    expect(followUps).toEqual([]);
  });
  // JUDGE-NOT-OVERSTRICT (대표 §판정·증거 11-22 · §33·§35 11-21): an empty criterion · an uncertain/unavailable LLM layer · an
  // uncited «unmet» signs on the baseline (same-head receipt ⊕ focused exit 0) with ONE «<cell>-FU»; a FU that cannot be filed refuses.
  const baselineWorld = (id: string, over: Partial<ButlerPorts>, criterion: string | null = '[must] core works') => {
    let c: any = { ...cell(40494, id), title: id, ...(criterion !== null ? { doneCriterion: criterion } : {}) };
    const pf = facts({ head: H, dir, focusedFiles: 1, focused: { pass: 3, fail: 0 }, focusedExit: 0 }, { binding: { declared: [id], title: [], branch: [], pipeline: [], selfDeclared: true, evidence: [] } });
    const fu = new Map<string, string>(); const lines = new Map<string, string[]>(); const mail: string[] = [];
    const ports: ButlerPorts = { memory: fileMemory(mkdtempSync(join(tmpdir(), `criterion-${id}-`))), merged: new Set([40494]), freshFacts: () => pf,
      readCell: rid => (rid === id ? c : fu.has(rid) ? { id: rid, title: fu.get(rid)!, status: 'yellow', evidence: (lines.get(rid) ?? []).join('\n') } : null),
      sign: (_id, evidence) => { c = { ...c, status: 'green', evidence, updatedBy: 'JUDGE-BUTLER' }; },
      judgeCriterion: async () => { throw Error('judge not reached in this case'); },
      appendEvidence: (fid, line) => { if (!fu.has(fid)) return false; const l = lines.get(fid) ?? []; if (!l.includes(line)) l.push(line); lines.set(fid, l); return true; },
      addFollowUp: (fid, title) => { if (!fu.has(fid)) fu.set(fid, title); return true; }, expireHolds: () => [], post: (_k, _to, body) => { mail.push(body); return 1; }, answerHand: () => null, escalateHand: () => null, ...over };
    const run = () => runTick({ now: new Date('2026-11-27T08:10:00Z'), version: '0.3.38', cells: [c], prFacts: pf, holds: [], blocks: [], hands: [] }, ports);
    return { run, fu, lines, mail, get cell() { return c; } };
  };
  test('empty criterion → green on the baseline + «<cell>-FU» doneCriterion 채우기 (no LLM call)', async () => {
    let calls = 0;
    const w = baselineWorld('CR-2', { decomposeCriterion: async () => { calls++; throw Error('must not be called'); } }, null);
    const r = await w.run();
    expect(r.signed).toEqual(['CR-2']); expect(calls).toBe(0); expect(w.mail.filter(b => b.startsWith('[판정 집사 → JUD'))).toEqual([]); // only the OP digest
    expect(w.fu.get('CR-2-FU')).toBe('CR-2 — doneCriterion 채우기 (판정 집사가 같은 head 영수 + focused exit 0 으로 서명 · 기준이 비어 있었다)');
    expect(w.cell.evidence).toContain('doneCriterion policy 1: baseline (same-head receipt + focused exit 0) · doneCriterion 비어 있음 → FU CR-2-FU');
  });
  test('LLM down · decomposition uncertain · untrusted · uncited «unmet» → green + «<cell>-FU» naming the reason', async () => {
    const decompose = async () => ({ trusted: true as const, requirements: [{ id: 'R1', text: 'core works', classification: 'must' as const }] });
    const cases: Array<[string, Partial<ButlerPorts>, string]> = [
      ['CR-DOWN', { decomposeCriterion: async () => { throw Error('codex 429 quota'); } }, '판정 LLM 불가 (codex 429 quota)'],
      ['CR-NOPORT', { decomposeCriterion: decompose, judgeCriterion: undefined }, '판정 LLM 불가 (no judgment port)'],
      ['CR-UNSURE', { decomposeCriterion: async () => ({ trusted: false, status: 'yellow', card: { to: 'JUD', reason: 'decomposition review rejected or uncertain' } }) }, 'doneCriterion 분해 불확실 (decomposition review rejected or uncertain)'],
      ['CR-BADROW', { decomposeCriterion: decompose, judgeCriterion: input => classifyBoardRequirements(input, { callLLM: async () => JSON.stringify({ requirements: [] }) }) }, '판정 불확실 (invalid judgment shape)'],
      ['CR-UNCITED', { decomposeCriterion: decompose, judgeCriterion: input => classifyBoardRequirements(input, { callLLM: async () => JSON.stringify({ requirements: [{ id: 'R1', classification: 'must', fulfilled: false, evidenceIds: [], reason: 'evidence does not establish it', gap: 'not-shown', clause: '' }] }) }) },
        '필수 미충족 주장에 기준 구절·반대 근거 인용 없음 («core works»: evidence does not establish it)'],
      ['CR-FAKECITE', { decomposeCriterion: decompose, judgeCriterion: input => classifyBoardRequirements(input, { callLLM: async () => JSON.stringify({ requirements: [{ id: 'R1', classification: 'must', fulfilled: false, evidenceIds: [input.evidence[0]!.id], reason: 'not in PR', gap: 'contradicted', clause: 'retry is idempotent' }] }) }) },
        '필수 미충족 주장에 기준 구절·반대 근거 인용 없음 («core works»: not in PR)'],
    ];
    // FU-FLOOD: uncertain split · uncited «unmet» → one line on «<cell>-E4» · LLM down · untrusted → «<cell>-FU»
    const folded = new Set(['CR-UNSURE', 'CR-UNCITED', 'CR-FAKECITE']);
    for (const [id, over, why] of cases) {
      const w = baselineWorld(id, over);
      const r = await w.run();
      expect({ id, signed: r.signed, refused: r.signRefused }).toEqual({ id, signed: [id], refused: [] });
      if (folded.has(id)) {
        expect({ id, fu: [...w.fu.keys()], lines: w.lines.get(`${id}-E4`) }).toEqual({ id, fu: [`${id}-E4`],
          lines: [`판정 미확인 — ${why} (서명 근거 = same-head receipt + focused exit 0 · 미재현 추론 = FU)`] });
        expect(w.cell.evidence).toContain(`doneCriterion policy 1: baseline (same-head receipt + focused exit 0) · ${why} → E4 칸 ${id}-E4 근거 한 줄`);
        const again = await w.run(); // the cell is green now · nothing more is filed
        expect({ id, signed: again.signed, fu: w.fu.size, lines: w.lines.get(`${id}-E4`)!.length }).toEqual({ id, signed: [], fu: 1, lines: 1 });
      } else {
        expect({ id, fu: w.fu.get(`${id}-FU`) }).toEqual({ id, fu: `${id} — 판정 미확인 부분 검증: ${why} (서명 근거 = 같은 head 영수 + focused exit 0 · 미재현 추론 = FU)` });
        expect(w.cell.evidence).toContain(`doneCriterion policy 1: baseline (same-head receipt + focused exit 0) · ${why} → FU ${id}-FU`);
      }
    }
  });
  test('a FU that cannot be filed refuses the sign (nothing unverified is lost)', async () => {
    const w = baselineWorld('CR-NOFU', { addFollowUp: () => false }, null);
    const r = await w.run();
    expect(r.signed).toEqual([]); expect(r.signRefused).toEqual([{ cell: 'CR-NOFU', why: '판정 FU 생성 실패: CR-NOFU-FU' }]);
  });
  test('an E4 line that cannot be written rides on the sign line (SUPERVISORS-EXECUTE-NOT-PROPOSE · never a refused sign)', async () => {
    const decompose = async () => ({ trusted: true as const, requirements: [{ id: 'R1', text: 'core works', classification: 'must' as const }] });
    const w = baselineWorld('CR-NOLINE', { decomposeCriterion: decompose, appendEvidence: () => false,
      judgeCriterion: input => classifyBoardRequirements(input, { callLLM: async () => JSON.stringify({ requirements: [{ id: 'R1', classification: 'must', fulfilled: false, evidenceIds: [], reason: 'not shown', gap: 'not-shown', clause: '' }] }) }) });
    const r = await w.run();
    expect(r.signed).toEqual(['CR-NOLINE']); expect(r.signRefused).toEqual([]);
    expect(w.cell.evidence).toContain('FU CR-NOLINE-E4: 판정 미확인 — ');
  });
});
