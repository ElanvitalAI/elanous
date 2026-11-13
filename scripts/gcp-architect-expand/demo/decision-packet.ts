/** Scene 5 approval input: only graph outputs bound to verified design and artifacts. */
export function scene5DecisionPacket(input: {
  graphId: string; runId: string; pendingNode: string | undefined;
  designSha256: string; proposal: {
    id: string; inputSha256: string; shortageAxes: string[]; signalSource: string;
    architecture: string; region: string;
    estimate: { formula: string; skuSource: string; price: 'unpriced' };
    savings: string[]; security: { grade: string; controls: string[] };
    realGcpCalls: 0;
  };
  designOutput: unknown;
  artifactDirectory: string; verifiedSha256: Record<string, string>;
  attachments: Array<{ kind: string; title: string; url: string; mime: string; sha256: string }>;
  verified: boolean;
}) {
  const { proposal, designOutput } = input;
  if (input.pendingNode !== 'approve' || !input.verified || input.attachments.length !== 4
    || proposal.inputSha256 !== input.designSha256 || proposal.realGcpCalls !== 0)
    throw new Error('Scene 5 approval packet requires a verified pending graph and matching design');
  if (!designOutput || typeof designOutput !== 'object') throw new Error('Scene 5 design graph output missing');
  const result = designOutput as { outcome?: unknown; result?: {
    proposalId?: unknown; architectureSpec?: Record<string, unknown>;
    estimate?: unknown; savings?: unknown; security?: unknown;
  } };
  if (result.outcome !== 'proposed' || result.result?.proposalId !== proposal.id
    || result.result.architectureSpec?.inputSha256 !== input.designSha256
    || (['architecture', 'region', 'shortageAxes', 'signalSource', 'estimate', 'savings', 'security'] as const)
      .some(key => JSON.stringify(result.result?.architectureSpec?.[key]) !== JSON.stringify(proposal[key]))
    || JSON.stringify(result.result.estimate) !== JSON.stringify(proposal.estimate)
    || JSON.stringify(result.result.savings) !== JSON.stringify(proposal.savings)
    || JSON.stringify(result.result.security) !== JSON.stringify(proposal.security))
    throw new Error('Scene 5 proposal does not match graph design node');
  const expected = [
    { kind: 'diagram-source', file: 'architecture.excalidraw', mime: 'application/json' },
    { kind: 'diagram', file: 'architecture.png', mime: 'image/png' },
    { kind: 'pdf', file: 'architecture.pdf', mime: 'application/pdf' },
    { kind: 'html', file: 'architecture.html', mime: 'text/html' },
  ];
  for (const item of expected) {
    const matching = input.attachments.filter(attachment => attachment.kind === item.kind);
    const attachment = matching[0];
    if (matching.length !== 1 || attachment.url !== `${input.artifactDirectory}/${item.file}`
      || attachment.mime !== item.mime || attachment.sha256 !== input.verifiedSha256[item.file])
      throw new Error('Scene 5 attachment does not match verified architecture bundle');
  }
  return {
    schemaVersion: 1, graphId: input.graphId, runId: input.runId,
    pendingNode: 'approve' as const, approvalRequired: true as const,
    designSha256: input.designSha256, proposalId: proposal.id,
    shortageAxes: proposal.shortageAxes, signalSource: proposal.signalSource,
    architecture: proposal.architecture, region: proposal.region,
    estimate: proposal.estimate, savings: proposal.savings, security: proposal.security,
    attachments: input.attachments, realGcpCalls: 0 as const,
  };
}
