import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Stage, StageExit, StageNode, StageOutput } from './envelope.js';
import type { RunState, StageContext } from './context.js';

const repoFile = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

// 형 동치 — tsc 가 잰다(런타임 상수 없이).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exitsAreTheFourUnitExits: Equal<StageExit, 'done' | 'rework' | 'needs-human' | 'failed'> = true;
const nodesAreTheEightPipelineNodes: Equal<StageNode, 'implement' | 'gate' | 'review' | 'rework' | 'main-sync' | 'regate' | 'open-pr' | 'merge'> = true;

/** 빈 런 상태 리터럴(규칙 11 — 생산 함수 없이). */
const EMPTY: RunState = {
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

describe('stage envelope ↔ unit contract', () => {
  test('type equalities hold (checked by tsc)', () => {
    expect([exitsAreTheFourUnitExits, nodesAreTheEightPipelineNodes]).toEqual([true, true]);
  });

  test('verb-make unit declares inputs [ask, context, prior], outputs [result, evidence] and the four exits', () => {
    const yaml = readFileSync(repoFile('graphs/units/verbs/make.yaml'), 'utf8');
    expect(yaml).toContain('  inputs: [ask, context, prior]\n');
    expect(yaml).toContain('  outputs: [result, evidence]\n');
    expect(yaml).toContain('  exits: [done, rework, needs-human, failed]\n');
    // 노드 contract 의 outcome 이 edge map 레이블로 간다 → StageOutput.outcome
    expect(yaml).toContain('outputs: [outcome, result, evidence]');
    expect(yaml).toContain('on: outcome');
  });

  test('pipeline-shape declares exactly the 8 executing nodes (StageNode)', () => {
    const src = readFileSync(repoFile('src/self-implement/pipeline-shape.ts'), 'utf8');
    const union = /export type PipelineNodeId =([^;]*);/.exec(src)?.[1] ?? '';
    expect([...union.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['implement', 'gate', 'review', 'rework', 'main-sync', 'regate', 'open-pr', 'merge']);
  });

  test('a Stage receives ask·context·prior and returns exit·outcome·result·evidence·patch', async () => {
    const stage: Stage<{ n: number }, { doubled: number }> = async ({ ask, prior }) => ({
      exit: 'done',
      outcome: 'ok',
      result: { doubled: ask.n * 2 },
      evidence: { round: prior.impl.round },
      patch: [{ op: 'set', path: ['impl', 'round'], value: prior.impl.round + 1 }],
    });
    const out: StageOutput<{ doubled: number }> = await stage({ ask: { n: 21 }, context: {} as StageContext, prior: EMPTY });
    expect(out).toEqual({
      exit: 'done',
      outcome: 'ok',
      result: { doubled: 42 },
      evidence: { round: 0 },
      patch: [{ op: 'set', path: ['impl', 'round'], value: 1 }],
    });
  });
});
