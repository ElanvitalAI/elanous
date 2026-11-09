import { rankByTrigramFts, type RankedDoc } from '../../src/session/search-index.js';
import {
  ingestText,
  openKnowledgeDb,
  queryKnowledge,
  type EmbedFn,
} from '../../src/domains/knowledge.js';
import { createKnowledgeCard } from '../../src/knowledge/kgs/intake.js';
import { KgsSqliteStore } from '../../src/knowledge/kgs/sqlite-store.js';
import type { NumericCandidateProvenance } from '../test-census.js';

export interface CensusCase {
  id?: string;
  file: string;
  name: string;
  assertions: string;
  targetSummary: string;
  contractId?: string;
  /** Explicit KGS edge override; null models a known contract without a stored ontology relation. */
  ontologyContractId?: string | null;
  contractSummary?: string;
  module?: string;
  owner?: string;
  recentPrs?: number[];
  numericCandidateProvenance?: NumericCandidateProvenance[] | null;
}

export interface GoldPair {
  left: string;
  right: string;
  sameContract: boolean;
  adjudication: string;
}

export interface SimilarityComparison {
  queryId: string;
  bm25: string[];
  vector: string[];
  ontology: string[];
  ontologyPrs: number[];
  rrf: string[];
  bm25VectorOntology: string[];
  disagreements: {
    bm25Only: string[];
    vectorOnly: string[];
    ontologyOnly: string[];
  };
}

export type SearchStrategy = 'bm25' | 'vector' | 'ontology' | 'rrf' | 'bm25VectorOntology';
export interface GoldPairEvaluation {
  pairs: Array<{ pair: GoldPair; retrieved: Record<SearchStrategy, boolean>; comparison: SimilarityComparison }>;
  metrics: Record<SearchStrategy, { truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number; samplePrecision: number | null; sampleRecall: number | null }>;
}

const VECTOR_KIND = 'memory' as const;
const VECTOR_DOMAIN = 'test-census';
const RRF_K = 60;

function stableId(value: string): string {
  return `census:${encodeURIComponent(value)}`;
}

function caseId(row: CensusCase): string {
  return row.id ?? `${row.file}#${row.name}`;
}

export function searchableText(row: CensusCase): string {
  const numericEvidence = row.numericCandidateProvenance?.map((candidate) => [
    `numeric literal ${candidate.literal} at line ${candidate.line}`,
    `blame commit ${candidate.blameCommit ?? 'unknown'}`,
    `commit reason ${candidate.reason ?? 'unknown'}`,
  ].join('; ')).join('\n');
  return [row.file, row.name, row.assertions, row.targetSummary, row.contractSummary, numericEvidence]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n');
}

function ontologyNode(
  id: string,
  title: string,
  body: string,
  relatedIds: string[],
  tags: string[],
) {
  return createKnowledgeCard({
    id,
    title,
    body,
    nature: 'fact',
    kind: 'case',
    source: { kind: 'manual', author: 'test-census-adapter' },
    author: 'test-census-adapter',
    domain: 'test-census',
    relatedIds,
    tags: ['test-census', ...tags],
    now: 0,
  });
}

/** Build all three real indexes over one census snapshot. Embeddings are injected so tests stay keyless. */
export async function createCensusSearchAdapter(
  rows: CensusCase[],
  embed: EmbedFn,
): Promise<{
  caseIds: readonly string[];
  ontologyModuleIds: readonly string[];
  compare(queryId: string, candidateLimit?: number): Promise<SimilarityComparison>;
  close(): void;
}> {
  const byId = new Map<string, CensusCase>();
  for (const row of rows) {
    const id = caseId(row);
    if (byId.has(id)) throw new Error(`duplicate census case id: ${id}`);
    byId.set(id, row);
  }

  const vectorDb = openKnowledgeDb(':memory:');
  const ontologyStore = new KgsSqliteStore(':memory:');
  const bm25Docs: RankedDoc[] = [];
  const contractCases = new Map<string, string[]>();
  const moduleCases = new Map<string, string[]>();
  const moduleContracts = new Map<string, Set<string>>();
  const contractModules = new Map<string, Set<string>>();
  const allModules = new Set<string>();
  const ownerCases = new Map<string, string[]>();
  const prCases = new Map<number, string[]>();
  const caseByOntologyNode = new Map<string, string>();

  try {
    for (const [id, row] of byId) {
      const text = searchableText(row);
      bm25Docs.push({ sessionId: id, content: text });
      await ingestText(vectorDb, {
        id: `test-case:${id}`,
        ts: '2026-11-06T00:00:00.000Z',
        kind: VECTOR_KIND,
        domain: VECTOR_DOMAIN,
        text,
        source_ref: `${row.file}#${row.name}`,
      }, embed);

      const links: string[] = [];
      if (row.module) {
        allModules.add(row.module);
        const ids = moduleCases.get(row.module) ?? [];
        ids.push(id);
        moduleCases.set(row.module, ids);
      }
      const relationContractId = row.ontologyContractId === undefined ? row.contractId : row.ontologyContractId ?? undefined;
      if (relationContractId) {
        const contractNodeId = stableId(`contract:${relationContractId}`);
        links.push(contractNodeId);
        const ids = contractCases.get(relationContractId) ?? [];
        ids.push(id);
        contractCases.set(relationContractId, ids);
        if (row.module) {
          const contracts = moduleContracts.get(row.module) ?? new Set<string>();
          contracts.add(relationContractId);
          moduleContracts.set(row.module, contracts);
          const modules = contractModules.get(relationContractId) ?? new Set<string>();
          modules.add(row.module);
          contractModules.set(relationContractId, modules);
        }
      }
      if (row.module) links.push(stableId(`module:${row.module}`));
      if (row.owner) {
        links.push(stableId(`owner:${row.owner}`));
        const ids = ownerCases.get(row.owner) ?? [];
        ids.push(id);
        ownerCases.set(row.owner, ids);
      }
      for (const pr of row.recentPrs ?? []) {
        links.push(stableId(`pr:${pr}`));
        const ids = prCases.get(pr) ?? [];
        ids.push(id);
        prCases.set(pr, ids);
      }
      const testNodeId = stableId(`test:${id}`);
      caseByOntologyNode.set(testNodeId, id);
      ontologyStore.writeCard(ontologyNode(testNodeId, row.name, text, links, ['test']));
    }

    for (const [contractId, testIds] of contractCases) {
      const sample = byId.get(testIds[0]!);
      ontologyStore.writeCard(ontologyNode(
        stableId(`contract:${contractId}`),
        contractId,
        sample?.contractSummary ?? contractId,
        [
          ...testIds.map((id) => stableId(`test:${id}`)),
          ...[...(contractModules.get(contractId) ?? [])].map((module) => stableId(`module:${module}`)),
        ],
        ['contract'],
      ));
    }
    for (const module of allModules) {
      const contractIds = moduleContracts.get(module) ?? new Set<string>();
      ontologyStore.writeCard(ontologyNode(
        stableId(`module:${module}`),
        module,
        `Module ${module}`,
        [
          ...[...contractIds].map((id) => stableId(`contract:${id}`)),
          ...(moduleCases.get(module) ?? []).map((id) => stableId(`test:${id}`)),
        ],
        ['module'],
      ));
    }
    for (const [owner, testIds] of ownerCases) {
      ontologyStore.writeCard(ontologyNode(
        stableId(`owner:${owner}`),
        owner,
        `Owner ${owner}`,
        testIds.map((id) => stableId(`test:${id}`)),
        ['owner'],
      ));
    }
    for (const [pr, testIds] of prCases) {
      ontologyStore.writeCard(ontologyNode(
        stableId(`pr:${pr}`),
        `PR #${pr}`,
        `Recent change attribution for PR #${pr}`,
        testIds.map((id) => stableId(`test:${id}`)),
        ['pr'],
      ));
    }

    const caseIds = [...byId.keys()];
    const ontologyModuleIds = [...allModules]
      .filter((module) => ontologyStore.readCard(stableId(`module:${module}`)) !== null);
    const compare = async (queryId: string, candidateLimit = 20): Promise<SimilarityComparison> => {
      const query = byId.get(queryId);
      if (!query) throw new Error(`unknown census case id: ${queryId}`);
      if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 20) {
        throw new Error('candidateLimit must be between 1 and 20; queryKnowledge caps vector results at 20');
      }
      const text = searchableText(query);
      const bm25 = (rankByTrigramFts(query.name, bm25Docs, 'trigram-overlap')?.map((hit) => hit.sessionId) ?? [])
        .filter((id) => id !== queryId);
      const vector = (await queryKnowledge(vectorDb, text, {
        kind: VECTOR_KIND,
        domain: VECTOR_DOMAIN,
        embed,
        k: candidateLimit,
        excludeId: `test-case:${queryId}`,
      })).map((hit) => hit.id.replace(/^test-case:/, ''))
        .filter((id) => id !== queryId);
      const queryCard = ontologyStore.readCard(stableId(`test:${queryId}`));
      const contractRelation = queryCard?.relatedIds
        ?.map((id) => decodeURIComponent(id.slice('census:'.length)))
        .find((id) => id.startsWith('contract:'));
      const contractCard = contractRelation
        ? ontologyStore.readCard(stableId(contractRelation))
        : null;
      const contractNeighbors = (contractCard?.relatedIds ?? [])
        .map((id) => caseByOntologyNode.get(id))
        .filter((id): id is string => Boolean(id) && id !== queryId);
      const moduleRelation = queryCard?.relatedIds
        ?.map((id) => decodeURIComponent(id.slice('census:'.length)))
        .find((id) => id.startsWith('module:'));
      const moduleCard = moduleRelation ? ontologyStore.readCard(stableId(moduleRelation)) : null;
      const moduleNeighbors = (moduleCard?.relatedIds ?? [])
        .map((id) => caseByOntologyNode.get(id))
        .filter((id): id is string => Boolean(id) && id !== queryId);
      const ontology = [...new Set([...contractNeighbors, ...moduleNeighbors])];
      const ontologySet = new Set(ontology);
      const ontologyPrs = [...new Set(ontology.flatMap((id) => {
        const caseCard = ontologyStore.readCard(stableId(`test:${id}`));
        return (caseCard?.relatedIds ?? [])
          .map((relatedId) => decodeURIComponent(relatedId.slice('census:'.length)))
          .filter((relatedId) => relatedId.startsWith('pr:'))
          .map((relatedId) => Number(relatedId.slice('pr:'.length)))
          .filter(Number.isSafeInteger);
      }))].sort((a, b) => a - b);

      const scores = new Map<string, number>();
      for (const ranking of [bm25, vector, ontology].map((items) => items.slice(0, candidateLimit))) {
        ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
      }
      const rrf = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const bm25Limited = bm25.slice(0, candidateLimit);
      const vectorLimited = vector.slice(0, candidateLimit);
      const ontologyLimited = ontology.slice(0, candidateLimit);
      const bm25Set = new Set(bm25Limited);
      const vectorSet = new Set(vectorLimited);
      const ontologyLimitedSet = new Set(ontologyLimited);
      const bm25Candidates = bm25Limited;
      const vectorReranked = (await queryKnowledge(vectorDb, text, {
        kind: VECTOR_KIND,
        domain: VECTOR_DOMAIN,
        embed,
        k: Math.max(bm25Candidates.length, 1),
        candidateIds: bm25Candidates.map((id) => `test-case:${id}`),
        excludeId: `test-case:${queryId}`,
      })).map((hit) => hit.id.replace(/^test-case:/, ''));
      const bm25VectorOntology = vectorReranked.filter((id) => ontologySet.has(id));
      return {
        queryId,
        bm25,
        vector,
        ontology,
        ontologyPrs,
        rrf,
        bm25VectorOntology,
        disagreements: {
          bm25Only: bm25Limited.filter((id) => !vectorSet.has(id) && !ontologyLimitedSet.has(id)),
          vectorOnly: vectorLimited.filter((id) => !bm25Set.has(id) && !ontologyLimitedSet.has(id)),
          ontologyOnly: ontologyLimited.filter((id) => !bm25Set.has(id) && !vectorSet.has(id)),
        },
      };
    };

    return { caseIds, ontologyModuleIds, compare, close: () => { vectorDb.close(); ontologyStore.close(); } };
  } catch (error) {
    vectorDb.close();
    ontologyStore.close();
    throw error;
  }
}

/** Gold comparisons are human-adjudicated; reject incomplete or fabricated-size samples. */
export function assertThirtyGoldPairs(pairs: GoldPair[]): void {
  if (pairs.length !== 30) throw new Error(`expected 30 adjudicated gold pairs, got ${pairs.length}`);
  if (pairs.some((pair) => !pair.adjudication.trim())) {
    throw new Error('every gold pair needs a human adjudication note');
  }
  const keys = pairs.map(({ left, right }) => [left, right].sort().join('\0'));
  if (new Set(keys).size !== pairs.length) throw new Error('gold pairs must be unique');
  if (pairs.some(({ left, right }) => !left || !right || left === right)) {
    throw new Error('gold pair endpoints must be distinct non-empty case ids');
  }
}

/** Score each ranker and fusion plan against the same 30 human-adjudicated pairs. */
export async function evaluateGoldPairs(
  adapter: { caseIds: readonly string[]; compare(queryId: string, candidateLimit?: number): Promise<SimilarityComparison> },
  pairs: GoldPair[],
  candidateLimit: number,
): Promise<GoldPairEvaluation> {
  assertThirtyGoldPairs(pairs);
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 20) {
    throw new Error('candidateLimit must be explicit and between 1 and 20; queryKnowledge caps vector results at 20');
  }
  const indexedIds = new Set(adapter.caseIds);
  const missingIds = [...new Set(pairs.flatMap(({ left, right }) => [left, right]).filter((id) => !indexedIds.has(id)))];
  if (missingIds.length > 0) throw new Error(`gold pair references unknown census case id: ${missingIds.join(', ')}`);
  const strategies: SearchStrategy[] = ['bm25', 'vector', 'ontology', 'rrf', 'bm25VectorOntology'];
  const counts = Object.fromEntries(strategies.map((strategy) => [strategy, {
    truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0,
  }])) as Record<SearchStrategy, { truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number }>;
  const evaluations: GoldPairEvaluation['pairs'] = [];
  for (const pair of pairs) {
    const comparison = await adapter.compare(pair.left, candidateLimit);
    const retrieved: Record<SearchStrategy, boolean> = {
      bm25: comparison.bm25.slice(0, candidateLimit).includes(pair.right),
      vector: comparison.vector.slice(0, candidateLimit).includes(pair.right),
      ontology: comparison.ontology.slice(0, candidateLimit).includes(pair.right),
      rrf: comparison.rrf.slice(0, candidateLimit).includes(pair.right),
      bm25VectorOntology: comparison.bm25VectorOntology.slice(0, candidateLimit).includes(pair.right),
    };
    for (const strategy of strategies) {
      const c = counts[strategy];
      if (pair.sameContract && retrieved[strategy]) c.truePositive++;
      else if (!pair.sameContract && retrieved[strategy]) c.falsePositive++;
      else if (pair.sameContract) c.falseNegative++;
      else c.trueNegative++;
    }
    evaluations.push({ pair, retrieved, comparison });
  }
  const metrics = Object.fromEntries(strategies.map((strategy) => {
    const c = counts[strategy];
    const predictedPositive = c.truePositive + c.falsePositive;
    const actualPositive = c.truePositive + c.falseNegative;
    return [strategy, {
      ...c,
      samplePrecision: predictedPositive === 0 ? null : c.truePositive / predictedPositive,
      sampleRecall: actualPositive === 0 ? null : c.truePositive / actualPositive,
    }];
  })) as GoldPairEvaluation['metrics'];
  return { pairs: evaluations, metrics };
}
