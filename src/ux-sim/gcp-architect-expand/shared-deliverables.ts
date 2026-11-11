import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runArchitectureDeliverables } from '../../graph-runner/architecture-deliverables.js';

export interface SharedDeliverablesInput {
  designHtmlPath: string;
  diagramSourcePath: string;
  outDir: string;
  stateRoot: string;
  resourceRoot: string;
  attachmentUrlBase?: string;
}

/** Consume the common architecture graph; GCPX owns no rendering or PDF template. */
export async function runSharedDeliverables(input: SharedDeliverablesInput) {
  for (const [key, value] of Object.entries(input)) {
    if (key === 'attachmentUrlBase') continue;
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  }
  const state = await runArchitectureDeliverables({
    pluginRoot: resolve(import.meta.dir, '../../../plugins/architecture-deliverables'),
    designHtmlPath: input.designHtmlPath, diagramSourcePath: input.diagramSourcePath,
    outDir: input.outDir, resourceRoot: input.resourceRoot, stateRoot: input.stateRoot,
  });
  const receipt = state.receipt;
  const specs = [
    ['architecture.excalidraw', 'diagram-source', '편집 가능한 아키텍처 도면', 'application/json', 'diagram'],
    ['architecture.png', 'diagram', 'GCP 확장 구성도', 'image/png', 'diagram'],
    ['architecture.pdf', 'pdf', '시스템 아키텍처 설계 문서', 'application/pdf', 'pdf'],
    ['architecture.html', 'html', '설계 문서 HTML 원본', 'text/html', 'pdf'],
  ] as const;
  const base = input.attachmentUrlBase?.replace(/\/$/u, '') ?? input.outDir;
  const attachments = specs.map(([name, kind, title, mime, producedBy]) => ({
    kind, title, url: `${base}/${receipt.immutableDirectory}/${name}`, mime,
    sha256: createHash('sha256').update(readFileSync(join(state.bundleDir, name))).digest('hex'), producedBy,
  }));
  return { graphId: state.graphId, runId: state.runId, receipt, attachments };
}
