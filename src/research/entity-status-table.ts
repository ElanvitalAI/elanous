import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { debug } from '../debug/log.js';

export type ResearchEntityMilestone =
  | 'announcement'
  | 'sampling'
  | 'customer-validation'
  | 'mass-production'
  | 'shipment'
  | 'unknown';

export type ResearchEntityStatusDisposition = 'supported' | 'held' | 'conflicting';

export interface ResearchEntityStatusClaim {
  id: string;
  entity: string;
  component: string;
  milestone: ResearchEntityMilestone;
  /** Date or window stated by the source; this is distinct from when we fetched it. */
  reportedAt?: string;
  /** Exact excerpt copied from the attached source capture; required to support this cell. */
  evidenceExcerpt: string;
  /** Caller must explicitly attest that the excerpt supports the structured claim. */
  evidenceAssessment: 'supports-claim' | 'unverified';
  /** Set only when an extractor has established a mutually exclusive claim pair. */
  contradictsClaimIds?: readonly string[];
  evidence: ResearchEvidenceEnvelope;
}

export interface ResearchSupplyChainClaim {
  id: string;
  supplier: string;
  recipient: string;
  component: string;
  /** Date or window stated by the source; this is distinct from when we fetched it. */
  reportedAt?: string;
  /** Exact excerpt copied from the attached source capture; required to support this edge. */
  evidenceExcerpt: string;
  /** Caller must explicitly attest that the excerpt supports the structured supply-chain edge. */
  evidenceAssessment: 'supports-claim' | 'unverified';
  evidence: ResearchEvidenceEnvelope;
}

export interface ResearchEntityEvidenceReference {
  id: string;
  questionId: string;
  sourceKind: string;
  /** Raw source locator is retained even when it is not a valid HTTP URL. */
  source: string;
  url?: string;
  /** When the evidence was collected; never substitute this for the source's claim date. */
  referenceTime: string;
  /** Date/window stated by the source, when available. */
  observedWindow: string;
  excerpt: string;
  outcome: ResearchEvidenceEnvelope['outcome'];
  truncated: boolean;
}

export interface ResearchEntityStatusRow {
  claimId: string;
  entity: string;
  component: string;
  milestone: ResearchEntityMilestone;
  reportedAt: string;
  disposition: ResearchEntityStatusDisposition;
  displayStatus: string;
  /** Exact source quote used for the caller's support assessment. */
  evidenceExcerpt: string;
  /** Explicit extractor-declared contradiction links, retained for auditability. */
  contradictsClaimIds: string[];
  evidenceUrls: string[];
  evidenceReferenceIds: string[];
  sourceKinds: string[];
}

export interface ResearchSupplyChainRow {
  claimId: string;
  supplier: string;
  recipient: string;
  component: string;
  reportedAt: string;
  disposition: ResearchEntityStatusDisposition;
  displayStatus: string;
  /** Exact source quote used for the caller's support assessment. */
  evidenceExcerpt: string;
  evidenceUrls: string[];
  evidenceReferenceIds: string[];
  sourceKinds: string[];
}

export interface ResearchEntityStatusTable {
  title: string;
  columns: readonly ['업체', '제품/부품', '단계', '출처 기준일', '판정', '근거 URL'];
  supplyChainColumns: readonly ['공급자', '수요자', '부품', '출처 기준일', '판정', '근거 URL'];
  rows: ResearchEntityStatusRow[];
  supplyChain: ResearchSupplyChainRow[];
  evidenceReferences: ResearchEntityEvidenceReference[];
}

/** Renderer dependency seam: renderers receive structured, already evidence-bound rows. */
export type ResearchEntityStatusTableRenderer = (table: ResearchEntityStatusTable) => string;

const COLUMNS = ['업체', '제품/부품', '단계', '출처 기준일', '판정', '근거 URL'] as const;
const SUPPLY_CHAIN_COLUMNS = ['공급자', '수요자', '부품', '출처 기준일', '판정', '근거 URL'] as const;
const HELD_LABEL = '보류(근거 부족)';
const CONFLICT_LABEL = '보류(상태 충돌)';

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function sourceUrl(evidence: ResearchEvidenceEnvelope): string | undefined {
  try {
    const url = new URL(evidence.source);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function evidenceUrl(evidence: ResearchEvidenceEnvelope): string | undefined {
  return evidence.outcome === 'complete' && !evidence.truncated ? sourceUrl(evidence) : undefined;
}

function reportedAt(value: string | undefined): string {
  return value?.trim() || '기준일 미확인';
}

function rowDisposition(disposition: ResearchEntityStatusDisposition): string {
  if (disposition === 'conflicting') return CONFLICT_LABEL;
  if (disposition === 'held') return HELD_LABEL;
  return '근거 확인';
}

function excerptSupports(evidence: ResearchEvidenceEnvelope, excerpt: string): boolean {
  // The quoted text must occur exactly as captured. Normalizing case or
  // whitespace could approve a quote that the source never contained.
  return excerpt.length > 0 && evidence.content.includes(excerpt);
}

/** Build a renderer-neutral status matrix; unsupported claims remain visible only as held rows. */
export function buildResearchEntityStatusTable(input: {
  title: string;
  runId?: string;
  statusClaims: readonly ResearchEntityStatusClaim[];
  supplyChainClaims: readonly ResearchSupplyChainClaim[];
}): ResearchEntityStatusTable {
  const ids = input.statusClaims.map(({ id }) => id);
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('status claim IDs must be non-empty and unique');
  }
  const edgeIds = input.supplyChainClaims.map(({ id }) => id);
  if (edgeIds.some((id) => !id.trim()) || new Set(edgeIds).size !== edgeIds.length) {
    throw new Error('supply-chain claim IDs must be non-empty and unique');
  }
  const references: ResearchEntityEvidenceReference[] = [];
  const addReference = (evidence: ResearchEvidenceEnvelope): ResearchEntityEvidenceReference => {
    const reference: ResearchEntityEvidenceReference = {
      id: `evidence-${references.length + 1}`,
      questionId: evidence.questionId,
      sourceKind: evidence.sourceKind,
      source: evidence.source,
      ...(sourceUrl(evidence) ? { url: sourceUrl(evidence) } : {}),
      referenceTime: evidence.observedAt?.trim() || '관측 시각 미보존',
      observedWindow: evidence.observedWindow?.trim() || '원문 기간 미보존',
      excerpt: evidence.content,
      outcome: evidence.outcome,
      truncated: evidence.truncated,
    };
    references.push(reference);
    return reference;
  };
  const statusRows: ResearchEntityStatusRow[] = input.statusClaims.map((claim) => {
    const url = evidenceUrl(claim.evidence);
    const entity = normalized(claim.entity) || '업체 미확인';
    const component = normalized(claim.component) || '제품/부품 미확인';
    const date = reportedAt(claim.reportedAt);
    const reference = addReference(claim.evidence);
    const disposition: ResearchEntityStatusDisposition = url && entity !== '업체 미확인'
      && component !== '제품/부품 미확인' && claim.milestone !== 'unknown'
      && excerptSupports(claim.evidence, claim.evidenceExcerpt)
      && claim.evidenceAssessment === 'supports-claim'
      ? 'supported' : 'held';
    return {
      claimId: claim.id,
      entity,
      component,
      milestone: claim.milestone,
      reportedAt: date,
      disposition,
      displayStatus: rowDisposition(disposition),
      evidenceExcerpt: claim.evidenceExcerpt,
      contradictsClaimIds: [...(claim.contradictsClaimIds ?? [])],
      evidenceUrls: url ? [url] : [],
      evidenceReferenceIds: [reference.id],
      sourceKinds: [claim.evidence.sourceKind],
    };
  });

  const rowByClaimId = new Map(input.statusClaims.map((claim, index) => [claim.id, statusRows[index]! ]));
  const conflictingIds = new Set<string>();
  for (const claim of input.statusClaims) {
    for (const otherId of claim.contradictsClaimIds ?? []) {
      if (otherId === claim.id) continue;
      const row = rowByClaimId.get(claim.id);
      const contradicted = rowByClaimId.get(otherId);
      if (!row || !contradicted || row.disposition !== 'supported' || contradicted.disposition !== 'supported') continue;
      conflictingIds.add(claim.id);
      conflictingIds.add(otherId);
    }
  }
  for (const id of conflictingIds) {
    const row = rowByClaimId.get(id)!;
    row.disposition = 'conflicting';
    row.displayStatus = rowDisposition('conflicting');
  }

  const supplyChain: ResearchSupplyChainRow[] = input.supplyChainClaims.map((claim) => {
    const url = evidenceUrl(claim.evidence);
    const supplier = normalized(claim.supplier) || '공급자 미확인';
    const recipient = normalized(claim.recipient) || '수요자 미확인';
    const component = normalized(claim.component) || '부품 미확인';
    const reference = addReference(claim.evidence);
    const disposition: ResearchEntityStatusDisposition = url && supplier !== '공급자 미확인'
      && recipient !== '수요자 미확인' && component !== '부품 미확인'
      && excerptSupports(claim.evidence, claim.evidenceExcerpt)
      && claim.evidenceAssessment === 'supports-claim' ? 'supported' : 'held';
    return {
      claimId: claim.id,
      supplier,
      recipient,
      component,
      reportedAt: reportedAt(claim.reportedAt),
      disposition,
      displayStatus: rowDisposition(disposition),
      evidenceExcerpt: claim.evidenceExcerpt,
      evidenceUrls: url ? [url] : [],
      evidenceReferenceIds: [reference.id],
      sourceKinds: [claim.evidence.sourceKind],
    };
  });

  const table: ResearchEntityStatusTable = {
    title: normalized(input.title) || '업체별 상태표',
    columns: COLUMNS,
    supplyChainColumns: SUPPLY_CHAIN_COLUMNS,
    rows: statusRows,
    supplyChain,
    evidenceReferences: references,
  };
  debug.log('research.entity-status-table', 'built', {
    ...(input.runId ? { runId: input.runId } : {}),
    rowCount: statusRows.length,
    supportedRows: statusRows.filter(({ disposition }) => disposition === 'supported').length,
    heldRows: statusRows.filter(({ disposition }) => disposition === 'held').length,
    conflictingRows: statusRows.filter(({ disposition }) => disposition === 'conflicting').length,
    supplyChainCount: supplyChain.length,
    heldSupplyChainCount: supplyChain.filter(({ disposition }) => disposition === 'held').length,
    sourceReferenceCount: references.length,
  });
  return table;
}

/** Keep renderer selection outside this module so UX renderer work can land independently. */
export function renderResearchEntityStatusTable(
  table: ResearchEntityStatusTable,
  renderer: ResearchEntityStatusTableRenderer,
): string {
  return renderer(table);
}

/** Stable renderer fallback; callers may inject the UX renderer without coupling the builder to it. */
export function renderResearchEntityStatusTableMarkdown(table: ResearchEntityStatusTable): string {
  const cell = (value: string): string => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const references = new Map(table.evidenceReferences.map((reference) => [reference.id, reference]));
  const rowEvidence = (ids: string[], excerpt: string, contradictsClaimIds: string[] = []): string => `${ids.map((id) => {
    const reference = references.get(id);
    return reference ? `[#${id}] ${reference.url ?? reference.source}` : `[#${id}] (참조 누락)`;
  }).join(', ')} · 발췌 “${excerpt}”${contradictsClaimIds.length
    ? ` · 충돌 주장 ${contradictsClaimIds.map((id) => `#${id}`).join(', ')}` : ''}`;
  const lines = [
    `### ${cell(table.title)}`,
    `| ${table.columns.join(' | ')} |`,
    `| ${table.columns.map(() => '---').join(' | ')} |`,
    ...table.rows.map((row) => `| ${[
      row.entity, row.component, row.milestone, row.reportedAt, row.displayStatus,
      rowEvidence(row.evidenceReferenceIds, row.evidenceExcerpt, row.contradictsClaimIds),
    ].map(cell).join(' | ')} |`),
    '',
    `| ${table.supplyChainColumns.join(' | ')} |`,
    `| ${table.supplyChainColumns.map(() => '---').join(' | ')} |`,
    ...table.supplyChain.map((row) => `| ${[
      row.supplier, row.recipient, row.component, row.reportedAt, row.displayStatus,
      rowEvidence(row.evidenceReferenceIds, row.evidenceExcerpt),
    ].map(cell).join(' | ')} |`),
    '',
    '#### Evidence captures',
    ...table.evidenceReferences.map((reference) =>
      `- [#${cell(reference.id)}] ${cell(reference.sourceKind)} · ${cell(reference.url ?? reference.source)} · `
      + `수집 ${cell(reference.referenceTime)} · 출처 기간 ${cell(reference.observedWindow)} · `
      + `${reference.outcome}${reference.truncated ? ' · truncated' : ''} — ${cell(reference.excerpt)}`),
  ];
  return lines.join('\n');
}
