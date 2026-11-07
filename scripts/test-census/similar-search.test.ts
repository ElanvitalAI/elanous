import { afterEach, describe, expect, test } from 'bun:test';
import {
  assertThirtyGoldPairs,
  createCensusSearchAdapter,
  evaluateGoldPairs,
  type CensusCase,
  type GoldPair,
} from './similar-search.js';
import type { EmbedFn } from '../../src/domains/knowledge.js';
import { rankByTrigramFts } from '../../src/session/search-index.js';

const cases: CensusCase[] = [
  {
    id: 'auth-refresh-a',
    file: 'src/session/refresh.test.ts',
    name: 'session token renewal after expiry',
    assertions: 'keeps the caller context while refreshing credentials',
    targetSummary: 'expired auth preserves the signed-in session',
    contractId: 'session-auth-refresh',
    contractSummary: 'refreshing an expired token preserves the authenticated session',
    module: 'src/session',
    owner: 'SEC',
  },
  {
    id: 'auth-refresh-b',
    file: 'src/auth/token-rotation.test.ts',
    name: 'credential renewal retains caller state',
    assertions: 'session token renewal after expiry must keep caller context',
    targetSummary: 'refreshing credentials does not sign out an active user',
    contractId: 'session-auth-refresh',
    contractSummary: 'refreshing an expired token preserves the authenticated session',
    module: 'src/auth',
    owner: 'SEC',
    recentPrs: [35300],
  },
  {
    id: 'auth-refresh-missing-ontology-edge',
    file: 'src/auth/token-expiry-fallback.test.ts',
    name: 'session token renewal after expiry fallback',
    assertions: 'session token renewal after expiry must retain the active user',
    targetSummary: 'expired credential fallback retains the active session',
    contractId: 'session-auth-refresh',
    ontologyContractId: null,
    module: 'src/auth',
    owner: 'SEC',
  },
  {
    id: 'auth-refresh-zero-vector-score',
    file: 'src/auth/token-zero-score.test.ts',
    name: 'session token renewal after expiry zero-score fixture',
    assertions: 'session token renewal after expiry retains caller context',
    targetSummary: 'zero-score lexical neighbor retains the authenticated session',
    contractId: 'session-auth-refresh',
    contractSummary: 'refreshing an expired token preserves the authenticated session',
    module: 'src/auth',
    owner: 'SEC',
  },
  {
    id: 'receipt-write',
    file: 'src/ledger/receipt.test.ts',
    name: 'session token renewal after expiry records a receipt',
    assertions: 'session token renewal after expiry persists a ledger receipt',
    targetSummary: 'ledger receipt is durable after commit',
    contractId: 'ledger-commit-receipt',
    contractSummary: 'successful commits persist their receipt',
    module: 'src/ledger',
    owner: 'NT-3',
  },
  {
    id: 'module-without-contract',
    file: 'src/orphan/module.test.ts',
    name: 'records an owner-only module node',
    assertions: 'the module node remains addressable without contract edges',
    targetSummary: 'owner-only census row has no contract summary',
    module: 'src/orphan',
    owner: 'SEC',
  },
];

const fakeEmbed: EmbedFn = async (text) => {
  const vector = new Float32Array(4);
  if (/zero-score fixture/i.test(text)) {
    vector[3] = 1;
    return { vector, model: 'test-census-fixture-v1' };
  }
  if (/session|caller|signed-in/i.test(text)) vector[0] = 1;
  if (/token|credential|auth|refresh/i.test(text)) vector[1] = 1;
  if (/receipt|ledger|commit/i.test(text)) vector[2] = 1;
  if (vector.every((value) => value === 0)) vector[3] = 1;
  return { vector, model: 'test-census-fixture-v1' };
};

let close: (() => void) | undefined;
afterEach(() => { close?.(); close = undefined; });

describe('test census similar-search adapters', () => {
  test('BM25 finds lexical neighbors when test titles differ but share trigrams', async () => {
    const adapter = await createCensusSearchAdapter([
      { id: 'repository-query', file: 'scripts/scan.test.ts', name: 'repository default scan is clean and uses package.json devDependency keys',
        assertions: 'default scan uses package metadata', targetSummary: 'package scan is clean' },
      { id: 'repository-neighbor', file: 'scripts/defaults.test.ts', name: 'uses package.json devDependency keys when scanning clean repository defaults',
        assertions: 'default scan uses package metadata', targetSummary: 'package scan is clean' },
      { id: 'unrelated', file: 'src/ledger.test.ts', name: 'persists a transaction receipt after commit',
        assertions: 'ledger transaction remains durable', targetSummary: 'receipt persists after commit' },
    ], fakeEmbed);
    close = adapter.close;

    const result = await adapter.compare('repository-query');
    expect(result.bm25).toContain('repository-neighbor');
    expect(result.bm25).not.toContain('repository-query');
  });

  test('BM25 overlap includes punctuation trigrams and normalizes both query and documents', () => {
    const punctuation = rankByTrigramFts('a-b', [
      { sessionId: 'punctuation-neighbor', content: 'a-b test case' },
      { sessionId: 'punctuation-unrelated', content: 'a b test case' },
    ], 'trigram-overlap');
    expect(punctuation?.map((hit) => hit.sessionId)).toEqual(['punctuation-neighbor']);

    const whitespace = rankByTrigramFts('a b', [
      { sessionId: 'whitespace-neighbor', content: 'a b test case' },
      { sessionId: 'whitespace-unrelated', content: 'a  b test case' },
    ], 'trigram-overlap');
    expect(whitespace?.map((hit) => hit.sessionId)).toEqual(['whitespace-neighbor']);

    const normalized = rankByTrigramFts('ａｂｃ', [
      { sessionId: 'normalized-neighbor', content: 'ａｂｃ test case' },
      { sessionId: 'normalized-unrelated', content: 'xyz test case' },
    ], 'trigram-overlap');
    expect(normalized?.map((hit) => hit.sessionId)).toEqual(['normalized-neighbor']);
  });

  test('default BM25 ranker keeps exact phrase matching', () => {
    const result = rankByTrigramFts('shared phrase', [
      { sessionId: 'exact', content: 'a shared phrase appears here' },
      { sessionId: 'separate', content: 'shared tokens phrase appear separately' },
    ]);
    expect(result?.map((hit) => hit.sessionId)).toEqual(['exact']);
  });

  test('compares lexical, vector, and KGS relation retrieval without external embedding calls', async () => {
    const adapter = await createCensusSearchAdapter(cases, fakeEmbed);
    close = adapter.close;
    expect(adapter.ontologyModuleIds).toContain('src/orphan');
    const result = await adapter.compare('auth-refresh-a');

    expect(result.bm25).toContain('auth-refresh-b');
    expect(result.bm25).toContain('receipt-write');
    expect(result.bm25.slice(0, 20)).toContain('auth-refresh-missing-ontology-edge');
    expect(result.bm25.slice(0, 20)).toContain('auth-refresh-zero-vector-score');
    expect(result.vector).toContain('auth-refresh-b');
    expect(result.vector).toContain('auth-refresh-missing-ontology-edge');
    expect(result.vector).toContain('receipt-write');
    expect(result.vector).toContain('auth-refresh-zero-vector-score');
    expect(result.ontology).toEqual(['auth-refresh-b', 'auth-refresh-zero-vector-score']);
    expect(result.ontologyPrs).toEqual([35300]);
    expect(result.bm25VectorOntology).toContain('auth-refresh-b');
    expect(result.bm25VectorOntology).not.toContain('auth-refresh-missing-ontology-edge');
    expect(result.bm25VectorOntology).not.toContain('receipt-write');
    expect(result.bm25VectorOntology).toContain('auth-refresh-zero-vector-score');
    const missingRelationQuery = await adapter.compare('auth-refresh-missing-ontology-edge');
    expect(missingRelationQuery.ontology).toContain('auth-refresh-b');
    expect(missingRelationQuery.ontology).toContain('auth-refresh-zero-vector-score');
    expect(missingRelationQuery.ontology).not.toContain('receipt-write');
    expect(missingRelationQuery.bm25VectorOntology).toEqual(['auth-refresh-b', 'auth-refresh-zero-vector-score']);
    expect(result.disagreements.ontologyOnly).not.toContain('receipt-write');
    expect(result.rrf).toContain('auth-refresh-b');
    const limited = await adapter.compare('auth-refresh-a', 1);
    const expectedScores = new Map<string, number>();
    for (const ranking of [limited.bm25, limited.vector, limited.ontology]) {
      ranking.slice(0, 1).forEach((id, rank) => expectedScores.set(id, (expectedScores.get(id) ?? 0) + 1 / (60 + rank + 1)));
    }
    const expectedRrf = [...expectedScores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(limited.rrf).toEqual(expectedRrf);
    const boundary = await adapter.compare('auth-refresh-a', 20);
    expect(boundary.vector).not.toContain('auth-refresh-a');
    expect(boundary.vector).toHaveLength(cases.length - 1);
  });


  test('limits every fusion input and returns 20 of 25 neighbors without the query', async () => {
    const crowdedCases: CensusCase[] = [
      ...cases,
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `crowded-auth-neighbor-${index}`,
        file: `src/auth/crowded-${index}.test.ts`,
        name: `session token renewal after expiry crowded ${index}`,
        assertions: 'session token renewal after expiry keeps caller context',
        targetSummary: `crowded auth neighbor ${index} retains the authenticated session`,
        contractId: 'session-auth-refresh',
        contractSummary: 'refreshing an expired token preserves the authenticated session',
        module: 'src/auth',
        owner: 'SEC',
      })),
    ];
    const adapter = await createCensusSearchAdapter(crowdedCases, fakeEmbed);
    close = adapter.close;
    const comparison = await adapter.compare('auth-refresh-a', 1);
    const expectedScores = new Map<string, number>();
    for (const ranking of [comparison.bm25, comparison.vector, comparison.ontology]) {
      ranking.slice(0, 1).forEach((id, rank) => expectedScores.set(id, (expectedScores.get(id) ?? 0) + 1 / (60 + rank + 1)));
    }
    const expectedRrf = [...expectedScores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(comparison.rrf).toEqual(expectedRrf);
    expect(comparison.disagreements.bm25Only.every((id) => comparison.bm25.slice(0, 1).includes(id))).toBe(true);
    expect(comparison.disagreements.vectorOnly.every((id) => comparison.vector.slice(0, 1).includes(id))).toBe(true);
    expect(comparison.disagreements.ontologyOnly.every((id) => comparison.ontology.slice(0, 1).includes(id))).toBe(true);

    const boundary = await adapter.compare('auth-refresh-a', 20);
    expect(boundary.vector).toHaveLength(20);
    expect(boundary.vector).not.toContain('auth-refresh-a');
    expect(boundary.bm25VectorOntology.length).toBeGreaterThan(0);
    expect(boundary.bm25VectorOntology.length).toBeLessThanOrEqual(20);
    expect(boundary.bm25VectorOntology).not.toContain('auth-refresh-a');
  });

  test('requires 30 unique, human-adjudicated gold pairs for quality comparison', () => {
    const gold: GoldPair[] = Array.from({ length: 30 }, (_, index) => ({
      left: `left-${index}`,
      right: `right-${index}`,
      sameContract: index % 2 === 0,
      adjudication: 'reviewed against the test assertion and target contract',
    }));
    expect(() => assertThirtyGoldPairs(gold)).not.toThrow();
    expect(() => assertThirtyGoldPairs(gold.slice(1))).toThrow('expected 30');
    expect(() => assertThirtyGoldPairs([...gold.slice(0, 29), gold[0]!])).toThrow('unique');
  });

  test('reports precision and recall at an explicitly chosen candidate limit', async () => {
    const gold: GoldPair[] = Array.from({ length: 30 }, (_, index) => ({
      left: `left-${index}`,
      right: `right-${index}`,
      sameContract: index % 2 === 0,
      adjudication: 'reviewed pair',
    }));
    const result = await evaluateGoldPairs({
      caseIds: gold.flatMap(({ left, right }) => [left, right]),
      async compare(queryId) {
        const other = `right-${queryId.slice('left-'.length)}`;
        return {
          queryId,
          bm25: [`not-${other}`, other],
          vector: [other],
          ontology: [],
          ontologyPrs: [],
          rrf: [other],
          bm25VectorOntology: [],
          disagreements: { bm25Only: [], vectorOnly: [], ontologyOnly: [] },
        };
      },
    }, gold, 1);

    expect(result.metrics.vector.samplePrecision).toBe(0.5);
    expect(result.metrics.vector.sampleRecall).toBe(1);
    expect(result.metrics.bm25.falseNegative).toBe(15);
    expect(result.metrics.bm25.trueNegative).toBe(15);
    await expect(evaluateGoldPairs({ caseIds: [], async compare() { throw new Error('unused'); } }, gold, 0))
      .rejects.toThrow('candidateLimit');
    await expect(evaluateGoldPairs({ caseIds: [], async compare() { throw new Error('unused'); } }, gold, 1))
      .rejects.toThrow('unknown census case id');
  });
});
