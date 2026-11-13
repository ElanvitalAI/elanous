import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scene5DecisionPrompt } from './scene5-decision-consumer.js';

test('Scene 5 packet binds the pending run and immutable attachment bytes before prompting', () => {
  const root = mkdtempSync(join(tmpdir(), 'scene5-packet-consumer-'));
  try {
    const attachments = ['diagram-source', 'diagram', 'pdf', 'html'].map((kind, index) => {
      const url = join(root, `artifact-${index}`);
      writeFileSync(url, kind);
      return { kind, title: kind, mime: 'application/octet-stream', url,
        sha256: createHash('sha256').update(kind).digest('hex') };
    });
    const packet = { schemaVersion: 1, graphId: 'gcp-architect-expand', runId: 'run-1', pendingNode: 'approve',
      approvalRequired: true, designSha256: 'a'.repeat(64), proposalId: 'p1', shortageAxes: ['CPU'],
      signalSource: 'fixture', architecture: 'batch', region: 'asia-northeast3',
      estimate: { formula: 'usage × SKU', skuSource: 'list', price: 'unpriced' },
      savings: ['idle TTL'], security: { grade: 'internal', controls: ['least privilege'] }, attachments, realGcpCalls: 0 };
    const raw = Buffer.from(JSON.stringify(packet));
    const expected = { graphId: packet.graphId, runId: 'run-1', designSha256: 'a'.repeat(64),
      packetSha256: createHash('sha256').update(raw).digest('hex') };
    expect(scene5DecisionPrompt(raw, expected)).toContain('비용: usage × SKU');
    expect(() => scene5DecisionPrompt(raw, { ...expected, runId: 'run-2' })).toThrow();
    expect(() => scene5DecisionPrompt(raw, { ...expected, graphId: 'other-plugin-graph' })).toThrow();
    const tampered = Buffer.from(JSON.stringify({ ...packet, proposalId: 'substituted',
      estimate: { ...packet.estimate, formula: 'free' }, security: { ...packet.security, grade: 'public' } }));
    expect(() => scene5DecisionPrompt(tampered, expected)).toThrow('packet bytes do not match');
    writeFileSync(attachments[2].url, 'substituted PDF');
    expect(() => scene5DecisionPrompt(raw, expected)).toThrow('attachment changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
