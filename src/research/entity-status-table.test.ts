import { expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import {
  buildResearchEntityStatusTable,
  renderResearchEntityStatusTable,
  renderResearchEntityStatusTableMarkdown,
  type ResearchEntityStatusClaim,
  type ResearchSupplyChainClaim,
} from './entity-status-table.js';

function evidence(input: Partial<ResearchEvidenceEnvelope> = {}): ResearchEvidenceEnvelope {
  return {
    questionId: 'q2', sourceKind: 'web-search:fixture', source: 'https://example.org/source',
    observedAt: '2026-11-01T01:00:00Z', observedWindow: '2026-10-31',
    content: 'Fixture source evidence.', outcome: 'complete', truncated: false, ...input,
  };
}

function statusClaim(
  entity: string,
  component: string,
  milestone: ResearchEntityStatusClaim['milestone'],
  reportedAt: string,
  source: string,
): ResearchEntityStatusClaim {
  const evidenceExcerpt = `${entity} ${component} ${milestone}`;
  return {
    id: `${entity}-${milestone}-${reportedAt}`,
    entity, component, milestone, reportedAt, evidenceExcerpt, evidenceAssessment: 'supports-claim',
    evidence: evidence({ source, content: `Source says ${evidenceExcerpt}.` }),
  };
}

test('builds a sourced HBM4 status table that keeps sampling, validation, production, and shipment distinct', () => {
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [
      statusClaim('Samsung', 'HBM4', 'sampling', '2026-10-31', 'https://samsung.example/sample'),
      statusClaim('SK hynix', 'HBM4', 'customer-validation', '2026-10-30', 'https://skhynix.example/validation'),
      statusClaim('Micron', 'HBM4', 'mass-production', '2026-10-29', 'https://micron.example/production'),
      statusClaim('Samsung', 'HBM4', 'shipment', '2026-10-28', 'https://samsung.example/shipment'),
    ],
    supplyChainClaims: [],
  });

  expect(table.rows.map(({ entity, milestone, disposition }) => [entity, milestone, disposition])).toEqual([
    ['Samsung', 'sampling', 'supported'],
    ['SK hynix', 'customer-validation', 'supported'],
    ['Micron', 'mass-production', 'supported'],
    ['Samsung', 'shipment', 'supported'],
  ]);
  expect(table.evidenceReferences.map(({ url, observedWindow, referenceTime }) => [url, observedWindow, referenceTime])).toEqual([
    ['https://samsung.example/sample', '2026-10-31', '2026-11-01T01:00:00Z'],
    ['https://skhynix.example/validation', '2026-10-31', '2026-11-01T01:00:00Z'],
    ['https://micron.example/production', '2026-10-31', '2026-11-01T01:00:00Z'],
    ['https://samsung.example/shipment', '2026-10-31', '2026-11-01T01:00:00Z'],
  ]);
});

test('marks only an explicitly established mutually exclusive claim pair as conflicting', () => {
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [
      { ...statusClaim('Samsung', 'HBM4', 'customer-validation', '2026-10-31', 'https://one.example/status'),
        contradictsClaimIds: ['claim-b'], id: 'claim-a' },
      { ...statusClaim('Samsung', 'HBM4', 'mass-production', '2026-10-31', 'https://two.example/status'),
        id: 'claim-b', contradictsClaimIds: ['claim-c'] },
      { ...statusClaim('Samsung', 'HBM4', 'shipment', '2026-10-31', 'https://three.example/status'),
        id: 'claim-c' },
    ],
    supplyChainClaims: [],
  });

  expect(table.rows.map(({ disposition }) => disposition)).toEqual(['conflicting', 'conflicting', 'conflicting']);
  expect(table.rows.map(({ claimId, contradictsClaimIds }) => [claimId, contradictsClaimIds])).toEqual([
    ['claim-a', ['claim-b']], ['claim-b', ['claim-c']], ['claim-c', []],
  ]);
  const markdown = renderResearchEntityStatusTableMarkdown(table);
  expect(markdown).toContain('충돌 주장 #claim-b');
  expect(markdown).toContain('충돌 주장 #claim-c');
  expect(table.evidenceReferences.map(({ url }) => url)).toEqual([
    'https://one.example/status', 'https://two.example/status', 'https://three.example/status',
  ]);
});

test('ignores self-referential contradiction declarations', () => {
  const claim = statusClaim('Samsung', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/status');
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [{ ...claim, contradictsClaimIds: [claim.id] }],
    supplyChainClaims: [],
  });
  expect(table.rows[0]?.disposition).toBe('supported');
});

test('allows milestones that can coexist for the same entity on the same date', () => {
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [
      statusClaim('Samsung', 'HBM4', 'sampling', '2026-10-31', 'https://one.example/status'),
      statusClaim('Samsung', 'HBM4', 'shipment', '2026-10-31', 'https://two.example/status'),
    ],
    supplyChainClaims: [],
  });

  expect(table.rows.map(({ disposition, reportedAt }) => [disposition, reportedAt])).toEqual([
    ['supported', '2026-10-31'], ['supported', '2026-10-31'],
  ]);
});

test('holds an unknown milestone while accepting the same evidence with a specified milestone', () => {
  const known = statusClaim('Vendor A', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/status');
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [known, { ...known, id: 'unknown-phase', milestone: 'unknown' }],
    supplyChainClaims: [],
  });

  expect(table.rows.map(({ milestone, disposition, displayStatus }) => [milestone, disposition, displayStatus])).toEqual([
    ['sampling', 'supported', '근거 확인'], ['unknown', 'held', '보류(근거 부족)'],
  ]);
});

test('holds unsupported status cells and supply-chain links without losing independently sourced rows', () => {
  const supplyChainClaims: ResearchSupplyChainClaim[] = [
    { supplier: 'HBM stack supplier', recipient: 'GPU package assembler', component: 'HBM4 stack',
      id: 'edge-1', reportedAt: '2026-10-31', evidenceExcerpt: 'HBM stack supplier supplies the GPU package assembler.',
      evidenceAssessment: 'supports-claim',
      evidence: evidence({ source: 'not-a|url', content: 'HBM stack supplier supplies the GPU package assembler.' }) },
  ];
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [
      statusClaim('Samsung', 'HBM4', 'sampling', '2026-10-31', 'https://samsung.example/sample'),
      { id: 'held-claim', entity: 'Unverified vendor', component: 'HBM4', milestone: 'shipment', reportedAt: '2026-10-31',
        evidenceExcerpt: 'partial source excerpt', evidenceAssessment: 'supports-claim',
        evidence: evidence({ outcome: 'partial', source: 'not-a|url', content: 'partial source excerpt' }) },
    ],
    supplyChainClaims,
  });

  expect(table.rows.map(({ disposition }) => disposition)).toEqual(['supported', 'held']);
  expect(table.rows[1]?.displayStatus).toBe('보류(근거 부족)');
  expect(table.supplyChain[0]).toMatchObject({ disposition: 'held', displayStatus: '보류(근거 부족)' });
  expect(table.evidenceReferences.map(({ url, source, excerpt }) => [url, source, excerpt])).toEqual([
    ['https://samsung.example/sample', 'https://samsung.example/sample', 'Source says Samsung HBM4 sampling.'],
    [undefined, 'not-a|url', 'partial source excerpt'],
    [undefined, 'not-a|url', 'HBM stack supplier supplies the GPU package assembler.'],
  ]);
});

test('hands structured table data to the renderer through an injected seam', () => {
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [statusClaim('SK hynix', 'HBM4', 'customer-validation', '2026-10-31', 'https://skhynix.example/status')],
    supplyChainClaims: [
      { id: 'edge-1', supplier: 'SK hynix', recipient: 'Package assembler', component: 'HBM4 stack',
        reportedAt: '2026-10-31', evidenceExcerpt: 'SK hynix supplies HBM4 stack to Package assembler.', evidenceAssessment: 'supports-claim',
        evidence: evidence({ source: 'https://supply.example/link', content: 'SK hynix supplies HBM4 stack to Package assembler.' }) },
      { id: 'edge-2', supplier: 'Package assembler', recipient: 'Accelerator vendor', component: 'Packaged HBM4',
        reportedAt: '2026-10-31', evidenceExcerpt: 'Package assembler supplies Packaged HBM4 to Accelerator vendor.', evidenceAssessment: 'supports-claim',
        evidence: evidence({ source: 'https://packaging.example/link', content: 'Package assembler supplies Packaged HBM4 to Accelerator vendor.' }) },
    ],
  });
  const calls: unknown[] = [];

  const output = renderResearchEntityStatusTable(table, (input) => {
    calls.push(input);
    return 'rendered status table';
  });

  expect(output).toBe('rendered status table');
  expect(calls).toEqual([table]);
  expect(table.rows[0]?.evidenceUrls).toEqual(['https://skhynix.example/status']);
  expect(table.supplyChain.map(({ supplier, recipient }) => [supplier, recipient])).toEqual([
    ['SK hynix', 'Package assembler'], ['Package assembler', 'Accelerator vendor'],
  ]);
  expect(table.supplyChain.map(({ evidenceUrls }) => evidenceUrls)).toEqual([
    ['https://supply.example/link'], ['https://packaging.example/link'],
  ]);
  const markdown = renderResearchEntityStatusTableMarkdown(table);
  expect(markdown).toContain('[#evidence-1] https://skhynix.example/status');
  expect(markdown).toContain('Evidence captures');
  expect(markdown).toContain('SK hynix HBM4 customer-validation');
  expect(markdown).toContain('2026-11-01T01:00:00Z');
});

test('logs row and hold counts with the caller runId', () => {
  const runId = `run-entity-status-${crypto.randomUUID()}`;
  let eventData: unknown;
  const unregister = debug.registerSink({ name: 'entity-status-table-test', emit: (item) => {
    if (item.category === 'research.entity-status-table' && item.event === 'built'
      && (item.data as { runId?: string } | undefined)?.runId === runId) eventData = item.data;
  } });
  try {
    buildResearchEntityStatusTable({
      title: 'HBM4 vendor status',
      runId,
      statusClaims: [
        statusClaim('Supported vendor', 'HBM4', 'sampling', '2026-10-31', 'https://vendor.example/status'),
        { id: 'held', entity: 'Held vendor', component: 'HBM4', milestone: 'shipment', reportedAt: '2026-10-31',
          evidenceExcerpt: 'partial', evidenceAssessment: 'supports-claim', evidence: evidence({ outcome: 'partial', source: 'invalid-url', content: 'partial' }) },
      ],
      supplyChainClaims: [],
    });
  } finally {
    unregister();
  }
  expect(eventData).toMatchObject({ rowCount: 2, supportedRows: 1, heldRows: 1, sourceReferenceCount: 2 });
});

test('holds empty or unrelated excerpts and preserves each partial capture with a row reference', () => {
  const partial = evidence({ source: 'https://same.example/source', content: 'Captured but truncated claim text', outcome: 'partial', truncated: true });
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [
      { ...statusClaim('Vendor A', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/source'),
        evidenceExcerpt: 'A claim absent from this capture' },
      { ...statusClaim('Vendor C', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/source'),
        id: 'empty-excerpt', evidenceExcerpt: '   ', evidenceAssessment: 'supports-claim' },
      { id: 'partial', entity: 'Vendor B', component: 'HBM4', milestone: 'shipment', evidenceExcerpt: 'Captured but truncated claim text',
        evidenceAssessment: 'supports-claim', evidence: partial },
    ],
    supplyChainClaims: [],
  });

  expect(table.rows.map((row) => [row.disposition, row.displayStatus])).toEqual([
    ['held', '보류(근거 부족)'], ['held', '보류(근거 부족)'], ['held', '보류(근거 부족)'],
  ]);
  expect(table.evidenceReferences).toHaveLength(3);
  expect(table.evidenceReferences[0]?.excerpt).toBe('Source says Vendor A HBM4 sampling.');
  expect(table.evidenceReferences[2]).toMatchObject({ url: 'https://same.example/source', outcome: 'partial', truncated: true });
  expect(table.rows.map((row) => row.evidenceReferenceIds)).toEqual([['evidence-1'], ['evidence-2'], ['evidence-3']]);
});

test('requires an exact case- and whitespace-sensitive source substring for supporting excerpts', () => {
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [
      { ...statusClaim('Vendor A', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/source'),
        evidenceExcerpt: 'vendor a HBM4 sampling' },
      { ...statusClaim('Vendor B', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/source'),
        evidenceExcerpt: 'Vendor B  HBM4 sampling',
        evidence: evidence({ content: 'Source says Vendor B HBM4 sampling.' }) },
    ],
    supplyChainClaims: [],
  });

  expect(table.rows.map(({ disposition }) => disposition)).toEqual(['held', 'held']);
});

test('holds excerpt matches unless the caller explicitly attests they support the claim', () => {
  const claim = statusClaim('Vendor A', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/status');
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [{ ...claim, evidenceAssessment: 'unverified' }],
    supplyChainClaims: [],
  });
  expect(table.rows[0]).toMatchObject({ disposition: 'held', displayStatus: '보류(근거 부족)' });
});

test('rejects duplicate claim identifiers before creating ambiguous row references', () => {
  const claim = statusClaim('Vendor A', 'HBM4', 'sampling', '2026-10-31', 'https://same.example/status');
  expect(() => buildResearchEntityStatusTable({
    title: 'HBM4 vendor status', statusClaims: [claim, claim], supplyChainClaims: [],
  })).toThrow('status claim IDs must be non-empty and unique');
});

test('keeps the exact supporting excerpt and escapes an invalid locator pipe once in Markdown', () => {
  const quote = 'Vendor A | began sampling HBM4.';
  const claim = statusClaim('Vendor A', 'HBM4', 'sampling', '2026-10-31', 'https://unused.example');
  const table = buildResearchEntityStatusTable({
    title: 'HBM4 vendor status',
    statusClaims: [{
      ...claim,
      evidenceExcerpt: quote,
      evidence: evidence({ source: 'not-a|url', content: `Long capture prefix. ${quote} Additional source text.` }),
    }],
    supplyChainClaims: [],
  });
  const markdown = renderResearchEntityStatusTableMarkdown(table);
  const row = markdown.split('\n').find((line) => line.includes('Vendor A'));
  const escapedQuote = quote.replace('|', '\\|');

  expect(table.rows[0]?.evidenceExcerpt).toBe(quote);
  expect(markdown).toContain('not-a\\|url');
  expect(markdown).toContain(`발췌 “${escapedQuote}”`);
  expect(row?.match(/(?<!\\)\|/g)).toHaveLength(7);
});
