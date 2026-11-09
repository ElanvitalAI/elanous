import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAppendReceiptCostsFromLedger, planPartialRegate, selectGateAppendRecheckEdge } from './gate-partial';

const simple = {
  changedFiles: ['src/changed.test.ts'],
  radiusFiles: ['src/changed.test.ts'],
  closureOpaque: false,
};

test('GATE-APPEND-RADIUS-RECHECK sim: one changed test file takes append-recheck without a numeric radius cap', () => {
  expect(selectGateAppendRecheckEdge(simple)).toMatchObject({ edge: 'append-recheck', promoted: [] });
  const plan = planPartialRegate({ version: '0.3.8', priorCommit: 'a'.repeat(40), forCommit: 'b'.repeat(40),
    changedFiles: simple.changedFiles, priorFailures: [], priorErrors: [] });
  expect(plan).toMatchObject({ ok: true, plan: { files: ['src/changed.test.ts'] } });
});

test('GATE-APPEND-RADIUS-RECHECK sim: dependency-layer, verdict-file, opaque-closure and cost-crossover promote to full', () => {
  expect(selectGateAppendRecheckEdge({ ...simple, changedFiles: ['bun.lock'] }))
    .toMatchObject({ edge: 'full-recheck', promoted: ['dep-layer'] });
  expect(selectGateAppendRecheckEdge({ ...simple, changedFiles: ['scripts/release-loop/gate-node.ts'] }))
    .toMatchObject({ edge: 'full-recheck', promoted: ['verdict-files'] });
  expect(selectGateAppendRecheckEdge({ ...simple, closureOpaque: true }))
    .toMatchObject({ edge: 'full-recheck', promoted: ['opaque-closure'] });
  expect(selectGateAppendRecheckEdge({ ...simple, receiptCosts: { partialMs: 5, fullMs: 5, source: 'same-ledger-receipts' } }))
    .toMatchObject({ edge: 'full-recheck', promoted: ['cost-crossover'] });
});

test('GATE-APPEND-RADIUS-RECHECK sim: invalid policy/cost evidence fails closed; docs-only carry remains eligible', () => {
  expect(selectGateAppendRecheckEdge({ ...simple, promoteToFull: ['unmeasured-count'] }))
    .toMatchObject({ edge: 'full-recheck', reason: 'invalid gate.plan.promoteToFull policy' });
  expect(selectGateAppendRecheckEdge({ ...simple, receiptCosts: { partialMs: -1, fullMs: 5, source: 'same-ledger-receipts' } as never }))
    .toMatchObject({ edge: 'full-recheck' });
  expect(selectGateAppendRecheckEdge({ changedFiles: ['docs/notes.md'], radiusFiles: [] }))
    .toMatchObject({ edge: 'append-recheck' });
});

test('GATE-APPEND-RADIUS-RECHECK execution: structural cost crossover reaches the full-gate fallback', () => {
  const result = planPartialRegate({ version: '0.3.8', priorCommit: 'a'.repeat(40), forCommit: 'b'.repeat(40),
    changedFiles: ['src/changed.test.ts'], priorFailures: [], priorErrors: [],
    receiptCosts: { partialMs: 12, fullMs: 12, source: 'same-ledger-receipts' } });
  expect(result).toMatchObject({ ok: false, reason: 'structural promotion: cost-crossover' });
});

test('GATE-APPEND-RADIUS-RECHECK sim: planner reads same-commit cut and cut-partial durations from one ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-append-cost-ledger-'));
  const version = '0.3.8', commit = 'a'.repeat(40);
  const full = join(root, 'release', version, 'gate-logs', 'cut');
  const partial = join(root, 'release', version, 'gate-logs', 'cut-partial');
  mkdirSync(full, { recursive: true });
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(full, 'pod-0.json'), JSON.stringify({ commit, durationMs: 900 }));
  writeFileSync(join(full, 'pod-1.json'), JSON.stringify({ commit, durationMs: 1100 }));
  writeFileSync(join(partial, 'pod-0.json'), JSON.stringify({ commit, durationMs: 2000 }));
  try {
    const costs = gateAppendReceiptCostsFromLedger(root, version, commit);
    expect(costs).toEqual({ fullMs: 2000, partialMs: 2000, source: 'same-ledger-receipts' });
    const plan = planPartialRegate({ version, priorCommit: commit, forCommit: 'b'.repeat(40),
      changedFiles: ['src/changed.test.ts'], priorFailures: [], priorErrors: [], receiptCosts: costs });
    expect(plan).toMatchObject({ ok: false, reason: 'structural promotion: cost-crossover' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-APPEND-RADIUS-RECHECK sim: mixed-commit or incomplete duration evidence cannot claim a crossover', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-append-cost-incomplete-'));
  const version = '0.3.8', commit = 'a'.repeat(40);
  const full = join(root, 'release', version, 'gate-logs', 'cut');
  const partial = join(root, 'release', version, 'gate-logs', 'cut-partial');
  mkdirSync(full, { recursive: true });
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(full, 'pod-0.json'), JSON.stringify({ commit, durationMs: 900 }));
  writeFileSync(join(partial, 'pod-0.json'), JSON.stringify({ commit: 'b'.repeat(40), durationMs: 2000 }));
  try {
    expect(gateAppendReceiptCostsFromLedger(root, version, commit)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
