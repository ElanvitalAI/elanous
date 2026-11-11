import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSharedDeliverables } from '../../../src/ux-sim/gcp-architect-expand/shared-deliverables.js';

test('GCP consumer invokes the shared architecture output graph and hashes its artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gcpx-shared-output-'));
  const repo = resolve(import.meta.dir, '../../..');
  const sample = join(repo, 'docs/samples/architecture-deliverables/solar-ticketing-gcp');
  try {
    const result = await runSharedDeliverables({ designHtmlPath: join(sample, 'architecture.html'),
      diagramSourcePath: join(sample, 'architecture.excalidraw'), outDir: join(root, 'out'),
      stateRoot: join(root, 'state'), resourceRoot: repo });
    expect(result.receipt.status).toBe('verified');
    expect(result.attachments.map(item => item.kind)).toEqual(['diagram-source', 'diagram', 'pdf', 'html']);
    expect(result.attachments.every(item => item.sha256.length === 64)).toBe(true);
    expect(readFileSync(join(root, 'out/architecture.pdf')).subarray(0, 4).toString()).toBe('%PDF');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
