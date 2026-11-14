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

const verifiedArtifacts = ['architecture.excalidraw', 'architecture.drawio', 'architecture.svg', 'architecture.png', 'architecture.html', 'architecture.pdf'] as const;

/** Recheck the immutable generation, including both editable exports, before reporting success. */
export function verifyArchitectureBundleArtifacts(bundleDir: string, sha256: Record<string, string> | undefined): void {
  for (const name of verifiedArtifacts) {
    const expected = sha256?.[name];
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error(`architecture deliverables receipt digest missing: ${name}`);
    let bytes: Buffer;
    try { bytes = readFileSync(join(bundleDir, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`architecture deliverables bundle artifact missing: ${name}`);
      throw error;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error(`architecture deliverables digest mismatch: ${name}`);
  }
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
  if (receipt.status !== 'verified' || !['system-architecture@2', 'system-architecture/cloud-expansion@2', 'system-architecture/aws@1'].includes(receipt.contract ?? ''))
    throw new Error('architecture deliverables verification missing');
  if (!/^\.architecture-stage-[\w-]+$/u.test(receipt.generation ?? '') ||
      receipt.immutableDirectory !== `.architecture-bundles/${receipt.generation}`)
    throw new Error('architecture deliverables generation missing');
  const bundleDir = join(input.outDir, receipt.immutableDirectory);
  verifyArchitectureBundleArtifacts(bundleDir, receipt.sha256);
  return { graphId: state.graphId, runId: state.runId, receipt, outDir: input.outDir, bundleDir };
}
