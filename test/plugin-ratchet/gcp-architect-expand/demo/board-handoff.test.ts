import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('scene 6 handoff uses exact board.card attachment fields and verified diagram, PDF, HTML bytes', () => {
  const root = join(import.meta.dir, '../../../../plugins/gcp-architect-expand/sim/sample-output');
  const board = JSON.parse(readFileSync(join(root, 'board-attachments.json'), 'utf8'));
  const result = JSON.parse(readFileSync(join(root, 'demo-result.json'), 'utf8'));
  expect(board.proposalId).toBe(result.proposalId);
  expect(board.status).toBe('artifacts-ready');
  expect(board.deploymentStatus).toBe('unverified');
  expect(board.attachments.map((item: { kind: string }) => item.kind)).toEqual([
    'diagram-source', 'diagram', 'pdf', 'html',
  ]);
  expect(board.attachments.map((item: { producedBy: string }) => item.producedBy)).toEqual([
    'diagram', 'diagram', 'pdf', 'pdf',
  ]);
  for (const item of board.attachments) {
    expect(Object.keys(item).sort()).toEqual(['kind', 'title', 'url', 'mime', 'sha256', 'producedBy'].sort());
    expect(['diagram', 'pdf']).toContain(item.producedBy);
    expect(item.title.trim()).toBeTruthy();
    expect(item.url).toMatch(/^\.\/[a-zA-Z0-9.-]+$/);
    const data = readFileSync(join(root, item.url));
    expect(createHash('sha256').update(data).digest('hex')).toBe(item.sha256);
  }
});
