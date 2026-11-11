/** GCP-specific data adapter for the shared architecture-deliverables producer. */
type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];

export function toArchitectureInput(raw: unknown) {
  const proposal = object(raw);
  const ticket = object(proposal.ticketDesign);
  const estimate = object(proposal.estimate);
  const security = object(proposal.security);
  const diagram = object(proposal.diagram);
  const id = string(proposal.id);
  const title = string(ticket.title);
  const region = string(proposal.region);
  const formula = string(estimate.formula);
  if (!id || !title || !region || !formula || !string(security.grade)) throw new Error('GCP proposal lacks architecture input fields');
  if (estimate.price !== 'unpriced') throw new Error('architecture input requires an unpriced official-SKU formula');
  return {
    schemaVersion: 1,
    source: { kind: 'gcp-expansion-proposal', proposalId: id, inputSha256: string(proposal.inputSha256) },
    title,
    summary: string(ticket.summary),
    requirements: strings(ticket.requirements),
    workload: {
      localComponents: strings(ticket.localComponents),
      offload: string(ticket.offloadWorkload),
      kind: string(ticket.offloadKind),
      exportData: string(ticket.exportData),
      assumptions: Array.isArray(ticket.assumptions) ? ticket.assumptions : [],
      assumptionStatus: string(proposal.assumptionStatus) || 'unknown',
    },
    deployment: { provider: 'gcp', region, comparisonRegion: string(proposal.comparisonRegion),
      architecture: string(proposal.architecture), credentials: 'user-device-only' },
    diagram: { layers: ['users', 'edge', 'application', 'data', 'observability', 'security'],
      boundaries: ['local-device', 'project', 'region', 'VPC'],
      flows: strings(diagram.flows), flowStatus: Array.isArray(diagram.flows) ? 'provided' : 'unconfirmed' },
    security: { grade: string(security.grade), controls: strings(security.controls),
      exportData: string(security.exportData) },
    cost: { status: string(estimate.status), formula, source: string(estimate.skuSource),
      usage: object(estimate.usage), savings: strings(proposal.savings) },
    alternatives: strings(proposal.alternatives),
    decisions: strings(proposal.decisions),
  };
}
