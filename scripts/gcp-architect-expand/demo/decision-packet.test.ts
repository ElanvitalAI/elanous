import { expect, test } from 'bun:test';
import { scene5DecisionPacket } from './decision-packet.js';

const designSha256 = 'a'.repeat(64);
const artifactDirectory = '/tmp/verified-bundle';
const expected = [
  { kind: 'diagram-source', file: 'architecture.excalidraw', mime: 'application/json' },
  { kind: 'diagram', file: 'architecture.png', mime: 'image/png' },
  { kind: 'pdf', file: 'architecture.pdf', mime: 'application/pdf' },
  { kind: 'html', file: 'architecture.html', mime: 'text/html' },
];
const verifiedSha256 = Object.fromEntries(expected.map((item, index) => [item.file, String(index + 1).repeat(64)]));
const proposal = { id: 'p1', inputSha256: designSha256, shortageAxes: ['capacity'], signalSource: 'fixture',
  architecture: 'batch-spot', region: 'asia-northeast3',
  estimate: { formula: 'usage × SKU', skuSource: 'https://cloud.google.com/compute/all-pricing', price: 'unpriced' as const },
  savings: ['idle TTL'], security: { grade: 'internal', controls: ['least privilege'] }, realGcpCalls: 0 as const };
const input = {
  graphId: 'gcp-architect-expand', runId: '11111111-1111-4111-8111-111111111111',
  pendingNode: 'approve', designSha256, proposal,
  designOutput: { outcome: 'proposed', result: { proposalId: 'p1', architectureSpec: proposal,
    estimate: proposal.estimate, savings: proposal.savings, security: proposal.security } },
  artifactDirectory, verifiedSha256,
  attachments: expected.map(item => ({ kind: item.kind, title: item.file,
    url: `${artifactDirectory}/${item.file}`, mime: item.mime, sha256: verifiedSha256[item.file] })),
  verified: true,
};

test('approval packet carries graph-bound cost, savings, security, and artifacts', () => {
  const packet = scene5DecisionPacket(input);
  expect(packet.pendingNode).toBe('approve');
  expect(packet.estimate.price).toBe('unpriced');
  expect(packet.security.grade).toBe('internal');
  expect(packet.attachments).toHaveLength(4);
});

test('approval packet rejects a different design or missing verification', () => {
  expect(() => scene5DecisionPacket({ ...input, designSha256: 'c'.repeat(64) })).toThrow();
  expect(() => scene5DecisionPacket({ ...input, verified: false })).toThrow();
  expect(() => scene5DecisionPacket({ ...input, designOutput: { ok: true, outcome: 'proposed', result: { proposalId: 'other' } } })).toThrow();
  expect(() => scene5DecisionPacket({ ...input, designOutput: { ...input.designOutput,
    result: { ...input.designOutput.result, savings: ['unverified saving'] } } })).toThrow();
  expect(() => scene5DecisionPacket({ ...input, designOutput: { ...input.designOutput,
    result: { ...input.designOutput.result, architectureSpec: { ...proposal, region: 'us-central1' } } } })).toThrow();
});

test('approval packet rejects duplicate and substituted attachments', () => {
  expect(() => scene5DecisionPacket({ ...input, attachments: [input.attachments[0], input.attachments[0],
    input.attachments[2], input.attachments[3]] })).toThrow();
  expect(() => scene5DecisionPacket({ ...input, attachments: input.attachments.map((item, index) => index === 2
    ? { ...item, url: `${artifactDirectory}/other.pdf` } : item) })).toThrow();
  expect(() => scene5DecisionPacket({ ...input, attachments: input.attachments.map((item, index) => index === 2
    ? { ...item, sha256: 'f'.repeat(64) } : item) })).toThrow();
});
