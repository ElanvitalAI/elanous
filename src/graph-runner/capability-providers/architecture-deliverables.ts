import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry, type GraphContractId,
} from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';

const stages = ['design', 'diagram', 'pdf', 'verify'] as const;
type Stage = typeof stages[number];
const contractFor = (stage: Stage): GraphContractId => `architecture.${stage}@1`;

/** The one renderer behind the v2 graph. The plugin root is explicit so installed copies work. */
export function createArchitectureDeliverablesRegistry(pluginRoot: string): GraphCapabilityRegistry {
  if (!isAbsolute(pluginRoot)) throw new Error('architecture plugin root must be absolute');
  let registry = emptyGraphCapabilityRegistry();
  for (const stage of stages) registry = registerGraphCapabilityContract(registry, {
    id: contractFor(stage),
    input: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: [stage] } } },
    output: { type: 'object' },
  });
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'architecture-deliverables', provides: stages.map(contractFor), tier: 'free',
    invoke: (context) => runArchitectureStage(pluginRoot, context),
  });
}

function runArchitectureStage(pluginRoot: string, context: InProcessHandlerContext): InProcessHandlerResult {
  const stage = (context.input as { stage?: unknown } | null)?.stage;
  if (typeof stage !== 'string' || !stages.includes(stage as Stage) || context.requires !== contractFor(stage as Stage))
    return { ok: false, outcome: 'fail', error: 'architecture stage contract mismatch' };
  const input = context.graphInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, outcome: 'fail', error: 'architecture graph input missing' };
  const work = mkdtempSync(join(tmpdir(), 'architecture-capability-'));
  try {
    const contextPath = join(work, 'context.json');
    writeFileSync(contextPath, JSON.stringify({ input }));
    const script = join(import.meta.dir, '../architecture-output/run-step.ts');
    const run = spawnSync('bun', [script, stage], { encoding: 'utf8', timeout: stage === 'diagram' || stage === 'pdf' ? 120_000 : 30_000,
      env: { ...process.env, ELANOUS_GRAPH_CONTEXT: contextPath, ELANOUS_ARCHITECTURE_PLUGIN_ROOT: pluginRoot } });
    if (run.error || run.status !== 0) return { ok: false, outcome: 'fail', error: run.error?.message ?? run.stderr.slice(0, 300) };
    const result = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    if (result.outcome !== 'ok') return { ok: false, outcome: 'fail', error: String(result.error ?? `${stage} failed`) };
    return { ok: true, outcome: 'ok', result, evidence: { stage, pluginRoot,
      ...(stage === 'verify' ? { verificationPath: join(String((input as Record<string, unknown>).outDir), 'verification.json') } : {}) } };
  } catch (error) {
    return { ok: false, outcome: 'fail', error: error instanceof Error ? error.message : String(error) };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
