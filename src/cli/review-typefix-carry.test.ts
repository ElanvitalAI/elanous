import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  proveTypefixCarry,
  TYPEFIX_CARRY_MAX_FILES,
  TYPEFIX_CARRY_MAX_LINES,
  writeTypefixCarryReceipt,
  type ProveTypefixCarryInput,
  type TypefixCarryDeps,
  type TypefixCarryMeasurement,
} from './review-typefix-carry.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fromHead = '1'.repeat(40);
const newHead = '2'.repeat(40);
const base = '3'.repeat(40);
const merge = '4'.repeat(40);
const repair = newHead;
const reviewText = JSON.stringify({ pr: 37, headCommit: fromHead, reviewed: true, verdict: 'pass', mustFix: [] });
const sourceBefore = 'export const answer: number = 42;\n';
const sourceAfter = 'export const answer: string = 42 as unknown as string;\n';

function input(overrides: Partial<ProveTypefixCarryInput> = {}): ProveTypefixCarryInput {
  return {
    pr: 37, fromHead, newHead, fromReview: '/review-results/card-37-111111111111.json', fromReviewSha256: sha(reviewText),
    fromReviewVerdict: 'pass', fromReviewMustFix: [], driftReceipt: { pr: 37, head: fromHead, verdict: 'drift' },
    repairRun: { runId: 'run-9', fromHead, newHead, baseSha: base }, ...overrides,
  };
}
function measured(overrides: Partial<TypefixCarryMeasurement> = {}): TypefixCarryMeasurement {
  return {
    commits: [{ sha: repair, parents: [fromHead], kind: 'repair' }], mergeCommit: null,
    mergeParent2IsOriginMainAncestor: null, repairCommit: repair,
    delta: [{ path: 'src/value.ts', status: 'modified', binary: false, added: 1, removed: 1, assertionChanged: false }],
    originalPrFiles: ['src/value.ts'], virtualSources: { 'src/value.ts': sourceBefore }, newSources: { 'src/value.ts': sourceAfter },
    gateReceipt: { headCommit: newHead, baseCommit: base, key: 'gate-abc', typecheck: 'PASS', prTests: 'PASS' }, requiredBase: base,
    ...overrides,
  };
}
function deps(overrides: Partial<TypefixCarryDeps> = {}, measurement = measured()): TypefixCarryDeps {
  return {
    readReview: () => reviewText,
    validatePriorVerdict: () => true,
    measure: () => measurement,
    transpile: (_source, file) => file.endsWith('.tsx') || file.endsWith('.ts') ? 'export const answer = 42; // removed type' : null,
    ...overrides,
  };
}

describe('proveTypefixCarry', () => {
  test('accepts a type-erasure-only delta, returns hashes and writes the canonical receipt', () => {
    const result = proveTypefixCarry(input(), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({
      pr: 37, headCommit: newHead, reviewed: true, verdict: 'pass', mustFix: [], reviewer: 'typefix-carry',
      carry: { fromHead, fromReview: 'card-37-111111111111.json', fromReviewSha256: sha(reviewText), driftReceipt: { pr: 37, head: fromHead, verdict: 'drift' }, repairRunId: 'run-9',
        mergeCommit: null, gateReceipt: { headCommit: newHead, baseCommit: base, key: 'gate-abc' },
        delta: { files: ['src/value.ts'], added: 1, removed: 1 } },
    });
    expect(result.receipt.carry.erasedJsSha256['src/value.ts']).toMatch(/^[a-f0-9]{64}$/u);
    const dir = mkdtempSync(join(tmpdir(), 'typefix-carry-test-'));
    try {
      const path = writeTypefixCarryReceipt(dir, result.receipt);
      expect(path).toEndWith(`typefix-carry-37-${newHead.slice(0, 12)}.json`);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(result.receipt);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.each([
    ['missing drift', input({ driftReceipt: null }), measured(), 'carry-no-drift-receipt'],
    ['drift bound to another PR', input({ driftReceipt: { pr: 38, head: fromHead, verdict: 'drift' } }), measured(), 'carry-no-drift-receipt'],
    ['prior review rejected', input(), measured(), 'carry-prior-verdict-invalid'],
    ['review changed after hashing', input({ fromReviewSha256: '0'.repeat(64) }), measured(), 'carry-prior-verdict-invalid'],
    ['review cannot be read', input(), measured(), 'carry-unmeasured'],
    ['repair run mismatch', input({ repairRun: { runId: 'run-9', fromHead, newHead: '6'.repeat(40), baseSha: base } }), measured(), 'carry-head-chain-broken'],
    ['merge parent is not origin/main ancestor', input({ repairRun: { runId: 'run-9', fromHead, newHead, baseSha: '6'.repeat(40) } }), measured({ commits: [{ sha: merge, parents: [fromHead, '6'.repeat(40)], kind: 'main-merge' }, { sha: repair, parents: [merge], kind: 'repair' }], mergeCommit: merge, mergeParent2IsOriginMainAncestor: false }), 'carry-head-chain-broken'],
    ['unrelated commit in chain', input(), measured({ commits: [{ sha: '7'.repeat(40), parents: [], kind: 'other' }, { sha: repair, parents: [], kind: 'repair' }] }), 'carry-head-chain-broken'],
    ['value change alters emitted JavaScript', input(), measured(), 'carry-not-type-erasure-equivalent'],
    ['non-TypeScript delta', input(), measured({ delta: [{ path: 'src/value.json', status: 'modified', binary: false, added: 1, removed: 0, assertionChanged: false }], originalPrFiles: ['src/value.json'] }), 'carry-not-type-erasure-equivalent'],
    ['file count over limit', input(), measured({ delta: Array.from({ length: TYPEFIX_CARRY_MAX_FILES + 1 }, (_, i) => ({ path: `src/${i}.ts`, status: 'modified' as const, binary: false, added: 0, removed: 0, assertionChanged: false })), originalPrFiles: Array.from({ length: 6 }, (_, i) => `src/${i}.ts`) }), 'carry-shape-outside-bounds'],
    ['line count over limit', input(), measured({ delta: [{ path: 'src/value.ts', status: 'modified', binary: false, added: TYPEFIX_CARRY_MAX_LINES, removed: 1, assertionChanged: false }] }), 'carry-shape-outside-bounds'],
    ['new file', input(), measured({ delta: [{ path: 'src/value.ts', status: 'added', binary: false, added: 1, removed: 0, assertionChanged: false }] }), 'carry-shape-outside-bounds'],
    ['binary delta', input(), measured({ delta: [{ path: 'src/value.ts', status: 'modified', binary: true, added: 1, removed: 0, assertionChanged: false }] }), 'carry-shape-outside-bounds'],
    ['test assertion changed', input(), measured({ delta: [{ path: 'src/value.test.ts', status: 'modified', binary: false, added: 1, removed: 1, assertionChanged: true }], originalPrFiles: ['src/value.test.ts'], virtualSources: { 'src/value.test.ts': sourceBefore }, newSources: { 'src/value.test.ts': sourceAfter } }), 'carry-test-expectation-changed'],
    ['wrong gate head', input(), measured({ gateReceipt: { headCommit: fromHead, baseCommit: base, key: 'gate-abc', typecheck: 'PASS', prTests: 'PASS' } }), 'carry-gate-head-or-base-mismatch'],
    ['failed typecheck', input(), measured({ gateReceipt: { headCommit: newHead, baseCommit: base, key: 'gate-abc', typecheck: 'FAIL', prTests: 'PASS' } }), 'carry-gate-head-or-base-mismatch'],
    ['delta unavailable', input(), measured({ newSources: {} }), 'carry-unmeasured'],
    ['test assertion measurement missing', input(), measured({ delta: [{ path: 'src/value.test.ts', status: 'modified', binary: false, added: 1, removed: 0, assertionChanged: undefined as unknown as boolean }], originalPrFiles: ['src/value.test.ts'] }), 'carry-unmeasured'],
  ])('%s refuses fail-closed', (name, proofInput, proofMeasurement, reason) => {
    const testDeps: Partial<TypefixCarryDeps> = name === 'prior review rejected' ? { validatePriorVerdict: () => false }
      : name === 'review cannot be read' ? { readReview: () => null }
        : name === 'value change alters emitted JavaScript' ? { transpile: (source: string) => source === sourceBefore ? 'export const answer = 42;' : 'export const answer = 43;' } : {};
    const result = proveTypefixCarry(proofInput, deps(testDeps, proofMeasurement));
    expect(result).toEqual({ ok: false, reason });
  });

  test('preserves emitted comments and regular-expression literal whitespace', () => {
    const formattingOnly = proveTypefixCarry(input(), deps({
      transpile: (source) => source === sourceBefore ? 'export const answer = 42; // comment' : 'export const answer=42;',
    }));
    expect(formattingOnly).toEqual({ ok: false, reason: 'carry-not-type-erasure-equivalent' });
    const operatorChange = proveTypefixCarry(input(), deps({
      transpile: (source) => source === sourceBefore ? 'const x = a + +b;' : 'const x = a++ + b;',
    }));
    expect(operatorChange).toEqual({ ok: false, reason: 'carry-not-type-erasure-equivalent' });
    const regexpWhitespaceChange = proveTypefixCarry(input(), deps({
      transpile: (source) => source === sourceBefore ? 'const matcher = /a b/;' : 'const matcher = /a  b/;',
    }));
    expect(regexpWhitespaceChange).toEqual({ ok: false, reason: 'carry-not-type-erasure-equivalent' });
    const semanticCommentChange = proveTypefixCarry(input(), deps({
      transpile: (source) => source === sourceBefore
        ? '/* @__PURE__ */ export const answer = 42;'
        : 'export const answer = 42;',
    }));
    expect(semanticCommentChange).toEqual({ ok: false, reason: 'carry-not-type-erasure-equivalent' });
    const unparsableOutput = proveTypefixCarry(input(), deps({
      transpile: (source) => source === sourceBefore ? 'const matcher = /a b/;' : 'const = ;',
    }));
    expect(unparsableOutput).toEqual({ ok: false, reason: 'carry-unmeasured' });
  });

  test('allows one verified main merge before the repair and uses its second parent as gate base', () => {
    const repairBase = '6'.repeat(40);
    const result = proveTypefixCarry(input({ repairRun: { runId: 'run-9', fromHead, newHead, baseSha: repairBase } }), deps({}, measured({
      commits: [{ sha: merge, parents: [fromHead, repairBase], kind: 'main-merge' }, { sha: repair, parents: [merge], kind: 'repair' }],
      mergeCommit: merge, mergeParent2IsOriginMainAncestor: true, gateReceipt: { headCommit: newHead, baseCommit: repairBase, key: 'gate-abc', typecheck: 'PASS', prTests: 'PASS' }, requiredBase: repairBase,
    })));
    expect(result.ok).toBe(true);
  });

  test('accepts the exact file and added-plus-removed line limits', () => {
    const result = proveTypefixCarry(input(), deps({}, measured({
      delta: [{ path: 'src/value.ts', status: 'modified', binary: false, added: TYPEFIX_CARRY_MAX_LINES, removed: 0, assertionChanged: false }],
    })));
    expect(result.ok).toBe(true);
  });

  test('exports the agreed measurement bounds', () => {
    expect(TYPEFIX_CARRY_MAX_FILES).toBe(5);
    expect(TYPEFIX_CARRY_MAX_LINES).toBe(40);
  });
});
