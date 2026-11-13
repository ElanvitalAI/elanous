import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GraphRunState } from '../graph-runner/runner.js';

type Attachment = { kind: string; title: string; url: string; mime: string; sha256: string };
export type Scene5DecisionPacket = {
  schemaVersion: 1; graphId: string; runId: string;
  pendingNode: 'approve'; approvalRequired: true; designSha256: string;
  proposalId: string; shortageAxes: string[]; signalSource: string;
  architecture: string; region: string;
  estimate: { formula: string; skuSource: string; price: 'unpriced' };
  savings: string[]; security: { grade: string; controls: string[] };
  attachments: Attachment[]; realGcpCalls: 0;
};

/** Consume the graph's verified packet at its spending gate, never an LLM summary. */
export function scene5DecisionPrompt(raw: Uint8Array, expected: { graphId: string; runId: string; designSha256: string; packetSha256: string }): string {
  if (createHash('sha256').update(raw).digest('hex') !== expected.packetSha256) {
    throw new Error('Scene 5 decision packet bytes do not match the pending graph');
  }
  let packet: Partial<Scene5DecisionPacket> | null;
  try { packet = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<Scene5DecisionPacket> | null; }
  catch { throw new Error('Scene 5 decision packet is malformed'); }
  if (!packet || packet.schemaVersion !== 1 || packet.graphId !== expected.graphId
    || packet.runId !== expected.runId || packet.designSha256 !== expected.designSha256
    || packet.pendingNode !== 'approve' || packet.approvalRequired !== true || packet.realGcpCalls !== 0
    || packet.estimate?.price !== 'unpriced' || !Array.isArray(packet.savings)
    || !Array.isArray(packet.security?.controls) || !Array.isArray(packet.attachments)) {
    throw new Error('Scene 5 decision packet does not match the pending graph and design');
  }
  const expectedKinds = new Set(['diagram-source', 'diagram', 'pdf', 'html']);
  if (packet.attachments.length !== 4 || new Set(packet.attachments.map(a => a.kind)).size !== 4
    || packet.attachments.some(a => !expectedKinds.has(a.kind) || !a.url || !/^[a-f0-9]{64}$/u.test(a.sha256))) {
    throw new Error('Scene 5 decision packet attachments are incomplete');
  }
  for (const attachment of packet.attachments) {
    const hash = createHash('sha256').update(readFileSync(attachment.url)).digest('hex');
    if (hash !== attachment.sha256) throw new Error('Scene 5 decision packet attachment changed');
  }
  return [
    `GCP 확장 비용 승인 · ${packet.proposalId} · run ${packet.runId}`,
    `용량: ${packet.shortageAxes?.join(', ') || '미기재'} · ${packet.architecture} · ${packet.region}`,
    `비용: ${packet.estimate.formula} · ${packet.estimate.price} · ${packet.estimate.skuSource}`,
    `절감: ${packet.savings.join(', ') || '미기재'}`,
    `보안: ${packet.security.grade} · ${packet.security.controls.join(', ') || '미기재'}`,
    `검증된 첨부: ${packet.attachments.map(a => a.title).join(', ')}`,
    '이 그래프 실행의 클라우드 지출 단계를 승인할까요? (y/N)',
  ].join('\n');
}

/** Build the approval card only from the graph visit that actually stopped at approve. */
export function scene5DecisionPromptFromGraph(state: GraphRunState, expectedGraphId: string, designPath: unknown): string {
  if (state.graphId !== expectedGraphId || state.status !== 'awaiting-approval'
    || !state.pending || state.path.at(-1) !== state.pending.nodeId
    || typeof designPath !== 'string') throw new Error('Scene 5 graph has no bound spending gate');
  const output = (nodeId: string): Record<string, unknown> => {
    const node = [...state.nodes].reverse().find(item => item.nodeId === nodeId);
    if (!node?.ok || !node.executed || typeof node.output !== 'string')
      throw new Error(`Scene 5 graph has no verified ${nodeId} output`);
    try {
      const parsed = JSON.parse(node.output) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Fail closed below. */ }
    throw new Error(`Scene 5 graph has malformed ${nodeId} output`);
  };
  const designResult = output('design').result as Record<string, unknown> | undefined;
  const proposal = designResult?.architectureSpec as Record<string, unknown> | undefined;
  const deliverables = output('deliverables').result as Record<string, unknown> | undefined;
  const attachments = deliverables?.attachments;
  const designSha256 = createHash('sha256').update(readFileSync(designPath)).digest('hex');
  if (!proposal || proposal.inputSha256 !== designSha256 || proposal.realGcpCalls !== 0
    || typeof proposal.id !== 'string' || typeof proposal.architecture !== 'string'
    || typeof proposal.region !== 'string' || !Array.isArray(proposal.shortageAxes)
    || typeof proposal.signalSource !== 'string' || !Array.isArray(proposal.savings)
    || !proposal.security || !proposal.estimate || !Array.isArray(attachments))
    throw new Error('Scene 5 pending graph does not match the submitted design');
  const packet = Buffer.from(JSON.stringify({
    schemaVersion: 1, graphId: state.graphId, runId: state.runId,
    pendingNode: state.pending.nodeId, approvalRequired: true, designSha256,
    proposalId: proposal.id, shortageAxes: proposal.shortageAxes,
    signalSource: proposal.signalSource, architecture: proposal.architecture,
    region: proposal.region, estimate: proposal.estimate,
    savings: proposal.savings, security: proposal.security,
    attachments, realGcpCalls: 0,
  }));
  return scene5DecisionPrompt(packet, { graphId: state.graphId, runId: state.runId,
    designSha256, packetSha256: createHash('sha256').update(packet).digest('hex') });
}
