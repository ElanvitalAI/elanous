import { expect, test } from 'bun:test';
import type { ChecklistItem } from './checklist.js';
import { dispatchReleaseStatus } from '../domains/release-tool.js';
import { evidencePrRefs, parseMergeLog, readGreenTriageSources, renderGreenTriage, triageGreen } from './green-triage.js';

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40), SHA_C = 'c'.repeat(40);
const FAKE_GIT_LOG = [
  `${SHA_A}\ttui: sticky scrollback (TUI-STICKY) (#39933)`,
  `${SHA_B}\tfeat: ledger fix (#39905)`,
  `${SHA_C}\tdocs: mentions (#11111) in the middle only`,
  'not-a-sha\tbroken (#39000)',
].join('\n');

function cell(id: string, evidence: string, status: ChecklistItem['status'] = 'yellow'): ChecklistItem {
  return { id, title: id, status, evidence, owner: 'TC', updatedAt: '2026-11-24T00:00:00Z', updatedBy: 'OP' };
}

const FIXTURE: ChecklistItem[] = [
  cell('JUDGE-BY-EVIDENCE', '#39933 f6feaa55f3b7 착지(merged) · receipt seat-state/RES/evidence/PREGATE-GREEN/39933-0123456789ab-node-b/receipt.json'),
  cell('JUDGE-BY-LANE', 'PR #39905 merged · 실측 영수증 따로'),
  cell('EVIDENCE-ONLY', '#39933 착지(merged) · 실측 영수증 따로 ⏎ RES #113009 우편'),
  cell('SUPPLY-OPEN-PR', '진행: PR #39999 · head 53e9139fc002'),
  cell('SUPPLY-NO-PR', ''),
  cell('SUPPLY-MID-SUBJECT', 'see #11111'),
  cell('ALREADY-GREEN', '#39933 receipt.json', 'green'),
];

test('merge log: only a trailing (#N) on a 40-hex sha line is a merged PR', () => {
  const merged = parseMergeLog(FAKE_GIT_LOG);
  expect([...merged.entries()]).toEqual([[39933, SHA_A], [39905, SHA_B]]);
});

test('evidence refs: #N · PR #N · (#N) · pull/N; html entities and path segments are not refs', () => {
  expect(evidencePrRefs('#38414 x · PR #38415 · (#38416) · https://github.com/o/r/pull/38417 · &#39000; · a/#39001')).toEqual([38414, 38415, 38416, 38417]);
});

test('fixture checklist + fake git log → three buckets', () => {
  const result = triageGreen('0.3.35', FIXTURE, { merged: parseMergeLog(FAKE_GIT_LOG), greenLanes: ['39905-fedcba987654-node-b', 'x-0123456789ab-node-b'] });
  expect(result.counts).toEqual({ judge: 2, evidence: 1, supply: 3 });
  expect(result.rows.judge.map((row) => [row.id, row.receipt])).toEqual([
    ['JUDGE-BY-EVIDENCE', 'seat-state/RES/evidence/PREGATE-GREEN/39933-0123456789ab-node-b/receipt.json'],
    ['JUDGE-BY-LANE', 'PREGATE-GREEN/39905-fedcba987654-node-b'],
  ]);
  expect(result.rows.evidence.map((row) => [row.id, row.mergedPrs])).toEqual([['EVIDENCE-ONLY', [39933]]]);
  expect(result.rows.supply.map((row) => [row.id, row.reason])).toEqual([
    ['SUPPLY-OPEN-PR', 'no merged PR (cited #39999)'],
    ['SUPPLY-NO-PR', 'no PR in evidence'],
    ['SUPPLY-MID-SUBJECT', 'no merged PR (cited #11111)'],
  ]);
  const text = renderGreenTriage(result, 1);
  expect(text.split('\n')).toEqual([
    '0.3.35 green-triage · judge 2 · evidence 1 · supply 3',
    '(a) judge now — merged + receipt: 2',
    '  JUDGE-BY-EVIDENCE · #39933 · #39933 merged aaaaaaaaaaaa · receipt seat-state/RES/evidence/PREGATE-GREEN/39933-0123456789ab-node-b/receipt.json · TC',
    '  … 1 more (--json for all)',
    '(b) produce evidence — merged, no receipt: 1',
    '  EVIDENCE-ONLY · #39933 · #39933 merged · no receipt — produce evidence (sim/test/ops world + synthetic events) · TC',
    '(c) supply — no merged PR: 3',
    '  SUPPLY-OPEN-PR · - · no merged PR (cited #39999) · TC',
    '  … 2 more (--json for all)',
  ]);
});

test('a receipt path bound to another PR does not count', () => {
  const result = triageGreen('0.3.35', [cell('OTHER', '#39933 merged · PREGATE-GREEN/39905-0123456789ab-node-b')], { merged: parseMergeLog(FAKE_GIT_LOG), greenLanes: [] });
  expect(result.counts).toEqual({ judge: 0, evidence: 1, supply: 0 });
});

test('readGreenTriageSources uses injected git log and lanes', () => {
  const sources = readGreenTriageSources({ gitLog: () => FAKE_GIT_LOG, greenLanes: () => ['39933-0123456789ab-minim5'] });
  expect(sources.merged.size).toBe(2);
  expect(sources.greenLanes).toEqual(['39933-0123456789ab-minim5']);
});

test('release_status action=green-triage answers from the checklist and injected sources', () => {
  const out = dispatchReleaseStatus({ action: 'green-triage', version: '0.3.35' }, {
    checklist: (version) => ({ version, released: '0.3.34', dev: '0.3.35-dev.0', items: FIXTURE, history: [] }),
    greenTriageSources: () => ({ merged: parseMergeLog(FAKE_GIT_LOG), greenLanes: [] }),
  });
  expect(out.text.split('\n')[0]).toBe('0.3.35 green-triage · judge 1 · evidence 2 · supply 3');
  expect((out.structured.greenTriage as { counts: unknown }).counts).toEqual({ judge: 1, evidence: 2, supply: 3 });
});

test('a shallow history is flagged in the result and the rendered head', () => {
  const result = triageGreen('0.3.35', [cell('OLD', '#100 merged')], { merged: new Map(), greenLanes: [], history: { repo: '/w', shallow: true } });
  expect(result.warnings).toEqual(['shallow git history (/w) — merges older than its first commit read as supply']);
  expect(renderGreenTriage(result).split('\n').slice(0, 2)).toEqual([
    '0.3.35 green-triage · judge 0 · evidence 0 · supply 1',
    '⚠ shallow git history (/w) — merges older than its first commit read as supply',
  ]);
});
