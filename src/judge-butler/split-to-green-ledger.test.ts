import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist, setItem, setItemIfSnapshot } from '../release-loop/checklist.js';
import { runTick, type ButlerPorts } from './body.js';
import { fileMemory } from './memory.js';
import type { PrFacts } from './done-when.js';

const version = '9.9.9';
const head = 'a'.repeat(40);
const prFacts = new Map<number, PrFacts>([[123, { pr: 123, merged: true, landedHead: head, files: ['src/a.ts'], securityFindings: [], binding: { declared: ['SPLIT-1'], title: [], branch: [], pipeline: [], selfDeclared: true, evidence: [] }, receipt: { head, dir: `PREGATE-GREEN/123-${head.slice(0, 12)}-minim5`, focusedFiles: 1, focused: { pass: 4, fail: 0 }, focusedExit: 0 } }]]);
afterEach(() => resetElanousConfigDir());

test('runTick persists independent FU before signature; retry after restart uses ledger and does not duplicate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'split-ledger-'));
  setElanousConfigDir(root);
  addItem(version, { id: 'SPLIT-1', title: 'feature', doneCriterion: 'core works; retry works' });
  setItem(version, 'SPLIT-1', { evidence: '#123' }, 'TC');
  const readCell = (id: string) => listChecklist(version).items.find(i => i.id === id) ?? null;
  let mode: 'must-fail' | 'pass' = 'must-fail';
  let failSign = false;
  let failEdge = false;
  const ports: ButlerPorts = {
    memory: fileMemory(join(root, 'butler')), merged: new Set([123]), readCell,
    freshFacts: () => prFacts,
    sign: (id, evidence, expected, attribution) => {
      if (failSign) throw new Error('synthetic sign failure');
      setItemIfSnapshot(version, id, { status: 'green', evidence }, 'JUDGE-BUTLER', expected as Parameters<typeof setItemIfSnapshot>[4], attribution);
    },
    decomposeCriterion: async () => ({ trusted: true, policyVersion: '1', requirements: [
      { id: 'R1', text: 'core works', classification: 'must' }, { id: 'R2', text: 'retry works', classification: 'edge' },
    ] }),
    judgeCriterion: async ({ requirements }) => ({ trusted: true, policyVersion: '1', requirements: requirements.map(r => ({
      id: r.id, classification: r.classification ?? 'must', fulfilled: r.id === 'R1' && mode === 'pass', evidenceIds: r.id === 'R1' ? ['PR-123'] : [], reason: 'fixture',
      // JUDGE-NOT-OVERSTRICT: a must refuses only as a cited contradiction (verbatim clause ⊕ the contradicting evidence id)
      ...(r.id === 'R1' && mode === 'must-fail' ? { gap: 'contradicted' as const, clause: 'core works' } : {}),
    })) }),
    addFollowUp: (id, title) => {
      if (failEdge && id.startsWith('SPLIT-1-FU-')) return false;
      if (readCell(id)) return true;
      try { addItem(version, { id, title, priority: 'P2', source: 'judge-butler · GREEN-DEFINITION-ONE (E4 = FU)' }); return true; } catch { return false; }
    },
    expireHolds: () => [], post: () => 1, answerHand: () => null, escalateHand: () => null,
  };
  const tick = (tickPorts: ButlerPorts = ports) => runTick({ now: new Date('2026-11-27T08:10:00Z'), version, cells: listChecklist(version).items, prFacts, holds: [], blocks: [], hands: [] }, tickPorts);
  expect((await tick()).signed).toEqual([]);
  expect(listChecklist(version).items.map(i => i.id)).toEqual(['SPLIT-1']);
  mode = 'pass'; failEdge = true;
  const edgeFailure = await tick();
  expect(edgeFailure.signed).toEqual([]);
  expect(edgeFailure.signRefused.some(x => x.why.includes('독립 엣지 FU 생성 실패'))).toBe(true);
  expect(readCell('SPLIT-1')?.status).toBe('yellow');
  expect(listChecklist(version).items.filter(i => i.id.startsWith('SPLIT-1-FU-'))).toHaveLength(0);
  failEdge = false; failSign = true;
  const failed = await tick();
  expect(failed.signed).toEqual([]);
  expect(failed.signRefused.some(x => x.why.includes('synthetic sign failure'))).toBe(true);
  let items = listChecklist(version).items;
  expect(items.find(i => i.id === 'SPLIT-1')?.status).toBe('yellow');
  const edge = items.find(i => i.id.startsWith('SPLIT-1-FU-'));
  expect(edge).toMatchObject({ status: 'yellow', priority: 'P2' });
  expect(edge?.owner).toBeUndefined();
  // Continue from the same on-disk ledger and memory in a fresh OS process.
  const base = import.meta.dir;
  const child = spawnSync(process.execPath, ['-e', `
    import { setElanousConfigDir } from ${JSON.stringify(join(base, '../elanous-config-dir.js'))};
    import { addItem, listChecklist, setItemIfSnapshot } from ${JSON.stringify(join(base, '../release-loop/checklist.js'))};
    import { runTick } from ${JSON.stringify(join(base, 'body.js'))};
    import { fileMemory } from ${JSON.stringify(join(base, 'memory.js'))};
    import { join } from 'node:path';
    const root = process.env.FIXTURE_ROOT; setElanousConfigDir(root);
    const head = 'a'.repeat(40), version = '9.9.9';
    const pf = new Map([[123, { pr: 123, merged: true, landedHead: head, files: ['src/a.ts'], securityFindings: [], binding: { declared: ['SPLIT-1'], title: [], branch: [], pipeline: [], selfDeclared: true, evidence: [] }, receipt: { head, dir: 'PREGATE-GREEN/123-aaaaaaaaaaaa-minim5', focusedFiles: 1, focused: {pass: 4, fail: 0}, focusedExit: 0 } }]]);
    const readCell = id => listChecklist(version).items.find(i => i.id === id) ?? null;
    const ports = { memory: fileMemory(join(root, 'butler')), merged: new Set([123]), readCell, freshFacts: () => pf,
      sign: (id, evidence, expected, attribution) => setItemIfSnapshot(version, id, {status:'green', evidence}, 'JUDGE-BUTLER', expected, attribution),
      decomposeCriterion: async () => ({trusted:true, policyVersion:'1', requirements:[{id:'R1',text:'core works',classification:'must'},{id:'R2',text:'retry works',classification:'edge'}]}),
      judgeCriterion: async ({requirements}) => ({trusted:true, policyVersion:'1', requirements:requirements.map(r => ({id:r.id, classification:r.classification, fulfilled:r.id === 'R1', evidenceIds:r.id === 'R1' ? ['PR-123'] : [], reason:'fixture'}))}),
      addFollowUp: (id,title) => { if (readCell(id)) return true; try { addItem(version,{id,title,priority:'P2',source:'judge-butler · GREEN-DEFINITION-ONE (E4 = FU)'}); return true; } catch { return false; } },
      expireHolds: () => [], post: () => 1, answerHand: () => null, escalateHand: () => null };
    const result = await runTick({now:new Date('2026-11-27T08:10:00Z'),version,cells:listChecklist(version).items,prFacts:pf,holds:[],blocks:[],hands:[]}, ports);
    console.log(JSON.stringify(result.signed));
  `], { env: { ...process.env, FIXTURE_ROOT: root }, encoding: 'utf8' });
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual(['SPLIT-1']);
  items = listChecklist(version).items;
  expect(items.filter(i => i.id.startsWith('SPLIT-1-FU-')).map(i => i.id)).toEqual([edge!.id]);
  expect(items.find(i => i.id === 'SPLIT-1')).toMatchObject({ status: 'green', updatedBy: 'JUDGE-BUTLER' });
  expect((await tick({ ...ports, memory: fileMemory(join(root, 'butler')) })).signed).toEqual([]);
  expect(listChecklist(version).items.filter(i => i.id.startsWith('SPLIT-1-FU-'))).toHaveLength(1);
});
