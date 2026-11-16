import { dispatchGraphContract, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry, type GraphContractId } from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';

/** This catalog describes the existing graph's units without changing their implementations or edges. */
export const APP_BUILD_CATALOG_NODES = [
  { node: 'source-reserve', phase: 'diagnose', contract: 'app-build-node.source-reserve@1', delegate: 'source-build.reserve@1', stage: 'reserve' },
  { node: 'grounding', phase: 'diagnose', contract: 'app-build-node.grounding@1', delegate: 'source-build.grounding@1', stage: 'grounding' },
  { node: 'assumptions', phase: 'plan', contract: 'app-build-node.assumptions@1', delegate: 'source-planning.assumptions@1', stage: 'assumptions' },
  { node: 'architecture', phase: 'plan', contract: 'app-build-node.architecture@1', delegate: 'source-planning.architecture@1', stage: 'architecture' },
  { node: 'file-plan', phase: 'plan', contract: 'app-build-node.file-plan@1', delegate: 'source-planning.file-plan@1', stage: 'file-plan' },
  { node: 'files', phase: 'generate', contract: 'app-build-node.files@1', delegate: 'source-build.files@1', stage: 'files' },
  { node: 'verify-repair', phase: 'test', contract: 'app-build-node.verify-repair@1', delegate: 'source-build.verify@1', stage: 'verify' },
  { node: 'materialize', phase: 'publish', contract: 'app-build-node.materialize@1', delegate: 'source-build.materialize@1', stage: 'materialize' },
  { node: 'publish', phase: 'publish', contract: 'app-build-node.publish@1', delegate: 'source-build.publish@1', stage: 'publish' },
] as const;

export type AppBuildCatalogNode = typeof APP_BUILD_CATALOG_NODES[number];
export type AppBuildRedeclarationCandidate = 'file-plan' | 'test-contract';

export interface AppBuildNodeFailureSignal {
  readonly node: AppBuildCatalogNode['node'];
  readonly phase: AppBuildCatalogNode['phase'];
  readonly reason: string;
  /** A supervisor must inspect the diagnostic before choosing a repair. */
  readonly redeclareCandidate?: AppBuildRedeclarationCandidate;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeFailureReason(value: unknown): string {
  if (typeof value !== 'string') return 'provider-failed';
  if (value === 'FILE_OUTPUT_INVALID' || value === 'BUILD_TESTS_EXHAUSTED') return value;
  if (['unprovided', 'contract-exhausted', 'contract-violation', 'latency-exceeded', 'provider-error', 'provider-failed'].includes(value)) return value;
  return 'provider-failed';
}

function failureReason(result: InProcessHandlerResult): string {
  const attempts = record(result.evidence).attempts;
  if (Array.isArray(attempts)) {
    let fallback: string | undefined;
    for (const attempt of attempts) {
      const reason = record(attempt).reason;
      const safe = safeFailureReason(reason);
      if (safe === 'FILE_OUTPUT_INVALID' || safe === 'BUILD_TESTS_EXHAUSTED') return safe;
      if (safe !== 'provider-failed') fallback ??= safe;
    }
    if (attempts.length > 0) return fallback ?? 'provider-failed';
  }
  return safeFailureReason(result.error);
}

/** Read a run's failure without treating a redeclaration hint as proof of a root cause. */
export function appBuildNodeFailureSignal(node: AppBuildCatalogNode['node'], result: InProcessHandlerResult): AppBuildNodeFailureSignal | undefined {
  if (result.ok) return undefined;
  const declaration = APP_BUILD_CATALOG_NODES.find(item => item.node === node);
  if (!declaration) return undefined;
  const reason = failureReason(result);
  const redeclareCandidate = (node === 'files' || node === 'verify-repair') && reason === 'FILE_OUTPUT_INVALID' ? 'file-plan'
    : node === 'verify-repair' && reason === 'BUILD_TESTS_EXHAUSTED' ? 'test-contract' : undefined;
  return { node, phase: declaration.phase, reason, ...(redeclareCandidate ? { redeclareCandidate } : {}) };
}

/** Opt-in registry extension. Callers keep the original registry instance and its run-scoped state. */
export function registerAppBuildCatalogNodeWrappers(base: GraphCapabilityRegistry): GraphCapabilityRegistry {
  let registry = base;
  for (const item of APP_BUILD_CATALOG_NODES) {
    if (!base.contracts[item.delegate]) throw new Error(`missing app-build delegate contract: ${item.delegate}`);
    registry = registerGraphCapabilityContract(registry, {
      id: item.contract as GraphContractId,
      input: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: [item.stage] } } },
      output: base.contracts[item.delegate].output,
    });
  }
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'app-build-catalog-node-wrapper', provides: APP_BUILD_CATALOG_NODES.map(item => item.contract as GraphContractId), tier: 'byok',
    invoke: async (context: InProcessHandlerContext): Promise<InProcessHandlerResult> => {
      const item = APP_BUILD_CATALOG_NODES.find(candidate => candidate.contract === context.requires);
      if (!item || record(context.input).stage !== item.stage) return { ok: false, outcome: 'failed', error: 'APP_BUILD_NODE_MISMATCH' };
      if (!context.verifiedOwnerId) return { ok: false, outcome: 'failed', error: 'VERIFIED_OWNER_REQUIRED' };
      // The delegate sees the original stage contract and run context. No model, host, or repair logic lives here.
      const delegated = await dispatchGraphContract(item.delegate, {
        ...context, requires: item.delegate as GraphContractId, input: { stage: item.stage }, nodeInput: undefined,
      }, base);
      const signal = appBuildNodeFailureSignal(item.node, delegated);
      return { ...delegated,
        // Graph contract dispatch records a failed provider's error, not its evidence.
        // Carry the specific failure reason through its attempt ledger for the supervisor.
        ...(!delegated.ok && signal && signal.reason !== 'provider-failed' ? { error: signal.reason } : {}),
        evidence: {
          ...delegated.evidence, catalogNode: { node: item.node, phase: item.phase, delegate: item.delegate },
          ...(signal ? { failureSignal: signal } : {}),
        },
      };
    },
  });
}
