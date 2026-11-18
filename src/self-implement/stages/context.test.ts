import { describe, expect, test } from 'bun:test';
import {
  StatePatchError,
  applyPatch,
  type RunSink,
  type RunState,
  type StatePatch,
} from './context.js';

// ⛔ 규칙 11 — 기대값은 아래 리터럴이다. applyPatch 로 기대값을 만들지 않는다.

/** 픽스처 PR 번호 — 상한이 아니다(NUMGUARD 오탐 «cap…: 숫자» 회피용 이름). */
const FIXTURE_PR = 38412;

/** 빈 상태 리터럴(생산 함수와 독립). */
function emptyLiteral(): RunState {
  return {
    impl: { round: 0, ok: null, summary: null, toolCalls: null, goalOnlyReworkUsed: false, childLlm: null, childLlmReselections: [] },
    gate: { passed: null, deferredToLand: false, testStepExecuted: null, unverified: [], measuredFileCount: null, envDeficitKind: null, lastUnverifiedKey: null },
    review: { verdict: null, reviewed: null, mustFix: [], shouldFix: [], summary: null, reviewedHeadCommit: null },
    rework: { note: '', judgeNote: '', kind: 'gate', history: [], failCounts: [], measured: null, consecutiveUnresolvedBudget: 0 },
    supervisor: { lastVerdict: null, lastReason: null, lastReworkVerdict: null, judgedEffectiveMax: null, lastParsedVerdict: null, lastParsedReason: null },
    findings: {
      roundCount: 0, lastReviewFindings: null, symbolKeyedCount: 0, proseFallbackCount: 0,
      verbatimOccurrences: {}, normalizedFirstSeenRounds: {}, normalizedObservedRoundCounts: {}, normalizedRepeatCounts: {},
      normalizedRepeatedOccurrences: [], citedSymbolOccurrences: {},
    },
    providerErrors: {
      providerErrorCount: 0, credentialFailureCount: 0, failureSequence: 0, lastProviderErrorSeq: 0, lastCredentialFailureSeq: 0,
      lastFailedGateSeq: 0, lastMustFixReviewSeq: 0, providerErrorAtLastGate: null, childQueryStatus: 'not-configured',
      queriedProviderErrorCount: 0, queriedCredentialFailureCount: 0,
    },
    land: {
      resolvedBase: null, mergeApprovalReceived: false, autoMergeAuthorizedBeforeSync: false, finishedImplementationAtMainSync: false,
      preSyncCommit: null, capturedPrNumber: null, prAttributionMismatch: false, openPrInvoked: false,
    },
  };
}

/** 채운 상태 리터럴 — 모든 칸에 null 이 아닌 값. 부를 때마다 새 객체. */
function populatedLiteral(): RunState {
  return {
    impl: {
      round: 3, ok: true, summary: 'implemented parser', toolCalls: 41, goalOnlyReworkUsed: true,
      childLlm: { provider: 'openai-codex', model: 'gpt-5.5-codex', source: 'config', codexQuotaPolicy: 'credits' },
      childLlmReselections: [{
        round: 1,
        previous: { provider: 'grok', model: 'grok-code-fast', source: 'flag', effort: 'high' },
        selected: { provider: 'openai-codex', model: 'gpt-5.5-codex', source: 'config', codexQuotaPolicy: 'credits' },
        reason: 'grok-quota-exhausted',
      }],
    },
    gate: { passed: false, deferredToLand: false, testStepExecuted: true, unverified: ['src/a.ts'], measuredFileCount: 7, envDeficitKind: 'missing-deps', lastUnverifiedKey: 'src/a.ts' },
    review: { verdict: 'warn', reviewed: true, mustFix: ['fix A'], shouldFix: ['tidy B'], summary: 'two issues', reviewedHeadCommit: 'abc1234' },
    rework: {
      note: 'gate failed', judgeNote: 'judge says retry', kind: 'review', history: ['r1 gate', 'r2 review'], failCounts: [2, 1],
      measured: { trend: 'improving', signature: 'F1,F2', rounds: 2 }, consecutiveUnresolvedBudget: 1,
    },
    supervisor: { lastVerdict: 'EXTEND', lastReason: 'progress seen', lastReworkVerdict: 'SUFFICIENT', judgedEffectiveMax: 5, lastParsedVerdict: 'EXTEND', lastParsedReason: 'parsed reason' },
    findings: {
      roundCount: 2, lastReviewFindings: ['fix A'], symbolKeyedCount: 1, proseFallbackCount: 3,
      verbatimOccurrences: { 'fix A': 2 }, normalizedFirstSeenRounds: { k1: 1 }, normalizedObservedRoundCounts: { k1: 2 }, normalizedRepeatCounts: { k1: 1 },
      normalizedRepeatedOccurrences: [{ hash: 'h1', firstSeenRound: 1, repeatedAtRound: 2, occurrence: 1, observedRoundCount: 2 }],
      citedSymbolOccurrences: { s1: { hash: 's1', symbol: 'foo()', firstSeenRound: 1, lastSeenRound: 2, occurrence: 1 } },
    },
    providerErrors: {
      providerErrorCount: 2, credentialFailureCount: 1, failureSequence: 6, lastProviderErrorSeq: 5, lastCredentialFailureSeq: 4,
      lastFailedGateSeq: 3, lastMustFixReviewSeq: 2, providerErrorAtLastGate: 'rate-limit', childQueryStatus: 'found',
      queriedProviderErrorCount: 2, queriedCredentialFailureCount: 1,
    },
    land: {
      resolvedBase: 'origin/main', mergeApprovalReceived: true, autoMergeAuthorizedBeforeSync: true, finishedImplementationAtMainSync: true,
      preSyncCommit: 'def5678', capturedPrNumber: FIXTURE_PR, prAttributionMismatch: true, openPrInvoked: true,
    },
  };
}

function refusal(state: RunState, patch: StatePatch): string {
  try {
    applyPatch(state, patch);
  } catch (error) {
    expect(error).toBeInstanceOf(StatePatchError);
    return (error as StatePatchError).code;
  }
  return 'accepted';
}

describe('RunState JSON round-trip', () => {
  test('populated literal survives JSON.parse(JSON.stringify(s)) unchanged', () => {
    const s = populatedLiteral();
    expect(JSON.parse(JSON.stringify(s))).toEqual(populatedLiteral());
  });
  test('empty literal survives JSON round-trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(emptyLiteral()))).toEqual(emptyLiteral());
  });
});

/*
 * 결정표 — 축: 패치 꼴(set · append · merge · unset) × 상태(empty · populated) × 유효성(valid · unknown key · wrong type) = 24칸.
 * 정직한 기대: unknown key 는 «거부»(조용히 버리지 않는다).
 * unset 의 «wrong type» = null 을 허용하지 않는 칸을 비우려 함 → not-nullable.
 */
describe('applyPatch case table', () => {
  // ── set ──
  test('set · empty · valid → field replaced', () => {
    const out = applyPatch(emptyLiteral(), [{ op: 'set', path: ['review', 'verdict'], value: 'fail' }]);
    expect(out).toEqual({ ...emptyLiteral(), review: { verdict: 'fail', reviewed: null, mustFix: [], shouldFix: [], summary: null, reviewedHeadCommit: null } });
  });
  test('set · populated · valid → field replaced, rest kept', () => {
    const out = applyPatch(populatedLiteral(), [{ op: 'set', path: ['impl', 'round'], value: 4 }]);
    expect(out.impl.round).toBe(4);
    expect({ ...out, impl: { ...out.impl, round: 3 } }).toEqual(populatedLiteral());
  });
  test('set · empty · unknown key → unknown-field', () => {
    expect(refusal(emptyLiteral(), [{ op: 'set', path: ['review', 'score'], value: 1 }])).toBe('unknown-field');
  });
  test('set · populated · unknown key → unknown-field', () => {
    expect(refusal(populatedLiteral(), [{ op: 'set', path: ['land', 'mergedAt'], value: 'x' }])).toBe('unknown-field');
  });
  test('set · empty · wrong type → wrong-type', () => {
    expect(refusal(emptyLiteral(), [{ op: 'set', path: ['impl', 'round'], value: '1' }])).toBe('wrong-type');
  });
  test('set · populated · wrong type → wrong-type', () => {
    expect(refusal(populatedLiteral(), [{ op: 'set', path: ['review', 'verdict'], value: 'maybe' }])).toBe('wrong-type');
  });

  // ── append ──
  test('append · empty · valid → list grows from []', () => {
    const out = applyPatch(emptyLiteral(), [{ op: 'append', path: ['rework', 'history'], values: ['r1 gate'] }]);
    expect(out.rework.history).toEqual(['r1 gate']);
    expect({ ...out, rework: null }).toEqual({ ...emptyLiteral(), rework: null });
  });
  test('append · populated · valid → appended after existing', () => {
    const out = applyPatch(populatedLiteral(), [{ op: 'append', path: ['gate', 'unverified'], values: ['src/b.ts', 'src/c.ts'] }]);
    expect(out.gate.unverified).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect({ ...out, gate: null }).toEqual({ ...populatedLiteral(), gate: null });
  });
  test('append · empty · unknown key → unknown-field', () => {
    expect(refusal(emptyLiteral(), [{ op: 'append', path: ['rework', 'notes'], values: ['x'] }])).toBe('unknown-field');
  });
  test('append · populated · unknown key → unknown-field', () => {
    expect(refusal(populatedLiteral(), [{ op: 'append', path: ['findings', 'extra'], values: [] }])).toBe('unknown-field');
  });
  test('append · empty · wrong type → wrong-type', () => {
    expect(refusal(emptyLiteral(), [{ op: 'append', path: ['rework', 'failCounts'], values: ['two'] }])).toBe('wrong-type');
  });
  test('append · populated · wrong type → wrong-type', () => {
    expect(refusal(populatedLiteral(), [{
      op: 'append', path: ['findings', 'normalizedRepeatedOccurrences'], values: [{ hash: 'h2', firstSeenRound: 1 }],
    }])).toBe('wrong-type');
  });

  // ── merge (nested Record) ──
  test('merge · empty · valid → record gains entries', () => {
    const out = applyPatch(emptyLiteral(), [{ op: 'merge', path: ['findings', 'verbatimOccurrences'], value: { 'fix A': 1 } }]);
    expect(out.findings.verbatimOccurrences).toEqual({ 'fix A': 1 });
    expect({ ...out, findings: null }).toEqual({ ...emptyLiteral(), findings: null });
  });
  test('merge · populated · valid → existing key overwritten, new key added', () => {
    const out = applyPatch(populatedLiteral(), [{ op: 'merge', path: ['findings', 'verbatimOccurrences'], value: { 'fix A': 3, 'fix C': 1 } }]);
    expect(out.findings.verbatimOccurrences).toEqual({ 'fix A': 3, 'fix C': 1 });
    expect(out.findings.normalizedRepeatCounts).toEqual({ k1: 1 });
  });
  test('merge · empty · unknown key → unknown-field', () => {
    expect(refusal(emptyLiteral(), [{ op: 'merge', path: ['findings', 'byFile'], value: { a: 1 } }])).toBe('unknown-field');
  });
  test('merge · populated · unknown key → unknown-field (section merge with a stray field)', () => {
    expect(refusal(populatedLiteral(), [{ op: 'merge', path: ['land'], value: { capturedPrNumber: FIXTURE_PR, landedAt: 'now' } }])).toBe('unknown-field');
  });
  test('merge · empty · wrong type → wrong-type', () => {
    expect(refusal(emptyLiteral(), [{ op: 'merge', path: ['findings', 'normalizedRepeatCounts'], value: { k1: 'one' } }])).toBe('wrong-type');
  });
  test('merge · populated · wrong type → wrong-type', () => {
    expect(refusal(populatedLiteral(), [{
      op: 'merge', path: ['findings', 'citedSymbolOccurrences'], value: { s2: { hash: 's2', symbol: 'bar()' } },
    }])).toBe('wrong-type');
  });

  // ── unset ──
  test('unset · empty · valid → nullable field stays null', () => {
    const out = applyPatch(emptyLiteral(), [{ op: 'unset', path: ['land', 'preSyncCommit'] }]);
    expect(out).toEqual(emptyLiteral());
  });
  test('unset · populated · valid → nullable field becomes null; record key removed', () => {
    const out = applyPatch(populatedLiteral(), [
      { op: 'unset', path: ['review', 'reviewedHeadCommit'] },
      { op: 'unset', path: ['findings', 'citedSymbolOccurrences', 's1'] },
    ]);
    expect(out.review.reviewedHeadCommit).toBe(null);
    expect(out.findings.citedSymbolOccurrences).toEqual({});
    expect({ ...out, review: null, findings: null }).toEqual({ ...populatedLiteral(), review: null, findings: null });
  });
  test('unset · empty · unknown key → unknown-field', () => {
    expect(refusal(emptyLiteral(), [{ op: 'unset', path: ['gate', 'log'] }])).toBe('unknown-field');
  });
  test('unset · populated · unknown key → unknown-field', () => {
    expect(refusal(populatedLiteral(), [{ op: 'unset', path: ['supervisor', 'history'] }])).toBe('unknown-field');
  });
  test('unset · empty · wrong type (non-nullable field) → not-nullable', () => {
    expect(refusal(emptyLiteral(), [{ op: 'unset', path: ['impl', 'round'] }])).toBe('not-nullable');
  });
  test('unset · populated · wrong type (non-nullable field) → not-nullable', () => {
    expect(refusal(populatedLiteral(), [{ op: 'unset', path: ['land', 'openPrInvoked'] }])).toBe('not-nullable');
  });
});

describe('applyPatch purity and refusals outside the table', () => {
  test('input state is not mutated on success', () => {
    const input = populatedLiteral();
    applyPatch(input, [
      { op: 'set', path: ['impl', 'round'], value: 9 },
      { op: 'append', path: ['gate', 'unverified'], values: ['x'] },
      { op: 'merge', path: ['findings', 'verbatimOccurrences'], value: { z: 1 } },
      { op: 'unset', path: ['review', 'summary'] },
    ]);
    expect(input).toEqual(populatedLiteral());
  });
  test('a refused op anywhere refuses the whole patch and leaves input unchanged', () => {
    const input = populatedLiteral();
    expect(refusal(input, [
      { op: 'set', path: ['impl', 'round'], value: 9 },
      { op: 'set', path: ['impl', 'nope'], value: 1 },
    ])).toBe('unknown-field');
    expect(input).toEqual(populatedLiteral());
  });
  test('returned state does not alias patch values', () => {
    const values = ['a'];
    const out = applyPatch(emptyLiteral(), [{ op: 'set', path: ['review', 'mustFix'], value: values }]);
    values.push('b');
    expect(out.review.mustFix).toEqual(['a']);
  });
  test('empty patch returns an equal but distinct object', () => {
    const input = populatedLiteral();
    const out = applyPatch(input, []);
    expect(out).toEqual(populatedLiteral());
    expect(out).not.toBe(input);
  });
  test('unknown section → unknown-section', () => {
    expect(refusal(emptyLiteral(), [{ op: 'set', path: ['budget' as 'impl', 'x'], value: 1 }])).toBe('unknown-section');
  });
  test('unknown op → unknown-op', () => {
    expect(refusal(emptyLiteral(), [{ op: 'delete', path: ['impl', 'round'] } as never])).toBe('unknown-op');
  });
  test('append onto a scalar field → not-a-list', () => {
    expect(refusal(emptyLiteral(), [{ op: 'append', path: ['impl', 'summary'], values: ['x'] }])).toBe('not-a-list');
  });
  test('field-level merge onto a non-record field → not-a-record', () => {
    expect(refusal(emptyLiteral(), [{ op: 'merge', path: ['gate', 'unverified'], value: { a: 1 } }])).toBe('not-a-record');
  });
  test('__proto__ key in merge → forbidden-key', () => {
    const value = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
    expect(refusal(emptyLiteral(), [{ op: 'merge', path: ['findings', 'verbatimOccurrences'], value }])).toBe('forbidden-key');
  });
  test('set null on a non-nullable field → wrong-type', () => {
    expect(refusal(emptyLiteral(), [{ op: 'set', path: ['land', 'openPrInvoked'], value: null }])).toBe('wrong-type');
  });
});

describe('child model re-binding during rework (HARNESS-DOCS-DRIFT-1118 N16)', () => {
  test('grok → codex re-selection is carried: current binding replaced, history appended', () => {
    const start = applyPatch(emptyLiteral(), [
      { op: 'set', path: ['impl', 'childLlm'], value: { provider: 'grok', model: 'grok-code-fast', source: 'flag' } },
    ]);
    const out = applyPatch(start, [
      { op: 'set', path: ['impl', 'childLlm'], value: { provider: 'openai-codex', model: 'gpt-5.5-codex', source: 'config' } },
      { op: 'append', path: ['impl', 'childLlmReselections'], values: [{
        round: 1,
        previous: { provider: 'grok', model: 'grok-code-fast', source: 'flag' },
        selected: { provider: 'openai-codex', model: 'gpt-5.5-codex', source: 'config' },
        reason: 'grok-credential-missing',
      }] },
    ]);
    expect(out.impl.childLlm).toEqual({ provider: 'openai-codex', model: 'gpt-5.5-codex', source: 'config' });
    expect(out.impl.childLlmReselections).toEqual([{
      round: 1,
      previous: { provider: 'grok', model: 'grok-code-fast', source: 'flag' },
      selected: { provider: 'openai-codex', model: 'gpt-5.5-codex', source: 'config' },
      reason: 'grok-credential-missing',
    }]);
    expect(start.impl.childLlm).toEqual({ provider: 'grok', model: 'grok-code-fast', source: 'flag' });
  });
  test('a child model with an unknown source is refused → wrong-type', () => {
    expect(refusal(emptyLiteral(), [{ op: 'set', path: ['impl', 'childLlm'], value: { provider: 'grok', model: 'm', source: 'env' } }])).toBe('wrong-type');
  });
  test('a re-selection with a keep-reason is refused → wrong-type', () => {
    expect(refusal(emptyLiteral(), [{ op: 'append', path: ['impl', 'childLlmReselections'], values: [{
      round: 1, previous: { provider: 'grok', model: 'a', source: 'flag' }, selected: { provider: 'grok', model: 'a', source: 'flag' }, reason: 'quota-usable',
    }] }])).toBe('wrong-type');
  });
});

/*
 * 값 유효성 축(Terra MF1) — 패치 «값»이 JSON 왕복을 깨면 어느 꼴·어느 필드로 가든 거부한다. 입력은 그대로.
 *   규칙: undefined 는 배열 원소·객체 값 모두 거부 · `__proto__`·`constructor`·`prototype` 키 = forbidden-key ·
 *   그 밖 키는 자기 키만 본다(상속 키 무시) — shape 필드의 낯선 키(`toString`)는 wrong-type.
 */
describe('applyPatch case table · value validity axis', () => {
  const unchanged = (input: RunState): void => expect(input).toEqual(populatedLiteral());

  test('reviewer case: constructor: { x: 1n } inside rework.measured → forbidden-key, input unchanged', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'set', path: ['rework', 'measured'], value: { trend: 'stable', signature: 's', rounds: 1, constructor: { x: 1n } } }])).toBe('forbidden-key');
    unchanged(input);
  });
  test('constructor key alone (no bigint) inside a shape → forbidden-key', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'set', path: ['rework', 'measured'], value: { trend: 'stable', signature: 's', rounds: 1, constructor: 1 } }])).toBe('forbidden-key');
    unchanged(input);
  });
  test('own __proto__ key at depth → forbidden-key', () => {
    const input = populatedLiteral();
    const value = JSON.parse('{"hash":"s9","symbol":"x","firstSeenRound":1,"lastSeenRound":1,"occurrence":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(refusal(input, [{ op: 'merge', path: ['findings', 'citedSymbolOccurrences'], value: { s9: value } }])).toBe('forbidden-key');
    unchanged(input);
  });
  test('toString key on a shape-typed value → wrong-type (own key not in the shape)', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'set', path: ['rework', 'measured'], value: { trend: 'stable', signature: 's', rounds: 1, toString: 'x' } }])).toBe('wrong-type');
    unchanged(input);
  });
  test('inherited keys do not satisfy a shape (object missing own required fields) → wrong-type', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'set', path: ['rework', 'measured'], value: { signature: 's', rounds: 1 } }])).toBe('wrong-type');
    unchanged(input);
  });
  test('cyclic object → not-serializable', () => {
    const input = populatedLiteral();
    const cyclic: Record<string, unknown> = { trend: 'stable', signature: 's', rounds: 1 };
    cyclic.self = cyclic;
    expect(refusal(input, [{ op: 'set', path: ['rework', 'measured'], value: cyclic }])).toBe('not-serializable');
    unchanged(input);
  });
  test('function value → not-serializable', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'set', path: ['review', 'summary'], value: () => 'x' }])).toBe('not-serializable');
    unchanged(input);
  });
  test('bigint at depth (append item field) → not-serializable', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'append', path: ['findings', 'normalizedRepeatedOccurrences'], values: [
      { hash: 'h2', firstSeenRound: 1, repeatedAtRound: 2, occurrence: 1, observedRoundCount: 2n },
    ] }])).toBe('not-serializable');
    unchanged(input);
  });
  test('undefined inside an array → not-serializable', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'append', path: ['gate', 'unverified'], values: ['a', undefined] }])).toBe('not-serializable');
    unchanged(input);
  });
  test('Date / Map / class instance → not-serializable', () => {
    const input = populatedLiteral();
    class Box { v = 1; }
    expect(refusal(input, [{ op: 'set', path: ['review', 'summary'], value: new Date(0) }])).toBe('not-serializable');
    expect(refusal(input, [{ op: 'merge', path: ['findings', 'verbatimOccurrences'], value: { a: new Map() } }])).toBe('not-serializable');
    expect(refusal(input, [{ op: 'set', path: ['rework', 'measured'], value: new Box() }])).toBe('not-serializable');
    unchanged(input);
  });
  test('symbol and NaN → not-serializable', () => {
    const input = populatedLiteral();
    expect(refusal(input, [{ op: 'set', path: ['review', 'summary'], value: Symbol('s') }])).toBe('not-serializable');
    expect(refusal(input, [{ op: 'set', path: ['impl', 'round'], value: Number.NaN }])).toBe('not-serializable');
    unchanged(input);
  });
  test('a bad value in a later op refuses the whole patch', () => {
    const input = populatedLiteral();
    expect(refusal(input, [
      { op: 'set', path: ['impl', 'round'], value: 9 },
      { op: 'set', path: ['review', 'summary'], value: 1n },
    ])).toBe('not-serializable');
    unchanged(input);
  });
  test('toString as an own Record key is ordinary data → accepted and round-trips', () => {
    const out = applyPatch(emptyLiteral(), [{ op: 'merge', path: ['findings', 'verbatimOccurrences'], value: { toString: 2 } }]);
    expect(JSON.parse(JSON.stringify(out.findings.verbatimOccurrences))).toEqual({ toString: 2 });
  });
});

describe('RunSink keys (type-level, both directions)', () => {
  // 리터럴 34 키 — RunSink 에 키가 늘거나 줄면 아래 두 형 검사 중 하나가 tsc 에서 깨진다.
  const keys = [
    'onNodeEntry', 'onRoundClassification', 'onWorktreeCreated', 'onRoundExecution', 'onReviewFindings', 'onReworkMeasured',
    'onGraphResolved', 'onGraphTemplateResolved', 'onEvidenceCoverage', 'reviewFindingTelemetry', 'reworkBudgetReviewFindingRecurrence',
    'onMergeApprovalReceived', 'onAutoMergeAuthorizedBeforeSync', 'onSupervisorVerdictParsed', 'onSupervisorReasonParsed',
    'onResolvedBase', 'onObservationMeasurementBasis', 'onClarificationTimeout', 'hasCurrentProviderError', 'hasCurrentCredentialFailure',
    'providerErrorCategory', 'onReviewReflectRejected', 'observe', 'onActiveProvider', 'onSessionCreated', 'onRunContractResolved',
    'onFailureVerdict', 'providerErrorAtLastGate', 'hasObservedProviderError', 'hasObservedCredentialFailure', 'onMainSyncStarted',
    'preserveMergeHarvest', 'onPrAttributed', 'onPrAttributionMismatch',
  ] as const satisfies readonly (keyof RunSink)[];
  const noneMissing: [Exclude<keyof RunSink, (typeof keys)[number]>] extends [never] ? true : false = true;
  test('34 distinct keys, none missing from RunSink', () => {
    expect(new Set(keys).size).toBe(34);
    expect(noneMissing).toBe(true);
  });
});
