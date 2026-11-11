import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { runGraph } from './runner.js';
import { createArchitectureDeliverablesRegistry } from './capability-providers/architecture-deliverables.js';

export interface ArchitectureDeliverablesInput {
  pluginRoot: string;
  structuredDesignPath?: string;
  designHtmlPath?: string;
  diagramSourcePath?: string;
  outDir: string;
  resourceRoot: string;
  stateRoot: string;
}

/** Common Graph v2 consumer seam for GCP expansion and other architecture producers. */
export async function runArchitectureDeliverables(input: ArchitectureDeliverablesInput) {
  for (const [key, path] of Object.entries(input)) if (path !== undefined && !isAbsolute(path)) throw new Error(`${key} must be absolute`);
  const structured = Boolean(input.structuredDesignPath);
  const finished = Boolean(input.designHtmlPath && input.diagramSourcePath);
  if (structured === finished || (!structured && Boolean(input.designHtmlPath) !== Boolean(input.diagramSourcePath)))
    throw new Error('choose structuredDesignPath or both finished architecture inputs');
  const graphPath = join(input.pluginRoot, 'graphs/architecture-deliverables.yaml');
  const state = await runGraph(graphPath, { input: { ...(structured ? { structuredDesignPath: input.structuredDesignPath }
    : { designHtmlPath: input.designHtmlPath, diagramSourcePath: input.diagramSourcePath }),
    outDir: input.outDir, resourceRoot: input.resourceRoot }, quiet: true,
    deps: { root: input.stateRoot, capabilityProviders: createArchitectureDeliverablesRegistry(input.pluginRoot) } });
  if (state.status !== 'done') throw new Error(`architecture deliverables graph ${state.status}`);
  const receipt = JSON.parse(readFileSync(join(input.outDir, 'verification.json'), 'utf8')) as {
    status?: string; contract?: string; generation?: string; immutableDirectory?: string; sha256?: Record<string, string> };
  if (receipt.status !== 'verified' || !['system-architecture@2', 'system-architecture/cloud-expansion@2'].includes(receipt.contract ?? ''))
    throw new Error('architecture deliverables verification missing');
  if (!/^\.architecture-stage-[\w-]+$/u.test(receipt.generation ?? '') ||
      receipt.immutableDirectory !== `.architecture-bundles/${receipt.generation}`)
    throw new Error('architecture deliverables generation missing');
  const bundleDir = join(input.outDir, receipt.immutableDirectory);
  for (const name of ['architecture.excalidraw', 'architecture.png', 'architecture.html', 'architecture.pdf']) {
    const digest = createHash('sha256').update(readFileSync(join(bundleDir, name))).digest('hex');
    if (digest !== receipt.sha256?.[name]) throw new Error(`architecture deliverables digest mismatch: ${name}`);
  }
  return { graphId: state.graphId, runId: state.runId, receipt, outDir: input.outDir, bundleDir };
}
