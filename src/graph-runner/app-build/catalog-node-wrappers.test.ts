import { describe, expect, test } from 'bun:test';
import { dispatchGraphContract, emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration, type GraphCapabilityRegistry, type GraphContractId } from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';
import { APP_BUILD_CATALOG_NODES, appBuildNodeFailureSignal, registerAppBuildCatalogNodeWrappers } from './catalog-node-wrappers.js';

function delegateRegistry(invoke: (context: InProcessHandlerContext) => InProcessHandlerResult): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const item of APP_BUILD_CATALOG_NODES) {
    if (registry.contracts[item.delegate]) continue;
    registry = registerGraphCapabilityContract(registry, {
      id: item.delegate as GraphContractId,
      input: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: [item.stage] } } },
      output: { type: 'object' },
    });
  }
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'existing-app-build-provider', provides: APP_BUILD_CATALOG_NODES.map(item => item.delegate as GraphContractId),
    tier: 'byok', invoke,
  });
}

const context = (item: typeof APP_BUILD_CATALOG_NODES[number]): InProcessHandlerContext => ({
  graphId: 'app-build', runId: 'run-1', nodeId: item.node, verifiedOwnerId: 'owner-1',
  requires: item.contract as GraphContractId, input: { stage: item.stage }, graphInput: { ask: 'build an app' },
  outputs: { grounding: { result: { receipt: 'measured' } } },
});
const runnerContext = (item: typeof APP_BUILD_CATALOG_NODES[number]): InProcessHandlerContext => ({
  ...context(item), input: { ask: 'build an app' }, nodeInput: { stage: item.stage }, graphInput: undefined,
});

describe('app-build catalog node wrappers', () => {
  test('all declared nodes delegate one time with the original run context and result', async () => {
    const received: InProcessHandlerContext[] = [];
    const base = delegateRegistry(candidate => {
      received.push(candidate);
      return { ok: true, outcome: 'done', result: { stage: (candidate.input as { stage: string }).stage }, evidence: { receipt: 'raw-1' } };
    });
    const registry = registerAppBuildCatalogNodeWrappers(base);
    for (const item of APP_BUILD_CATALOG_NODES) {
      const runContext = runnerContext(item);
      const result = await dispatchGraphContract(item.contract, runContext, registry);
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('done');
      expect(result.result).toEqual({ stage: item.stage });
      expect(result.evidence?.catalogNode).toEqual({ node: item.node, phase: item.phase, delegate: item.delegate });
      expect(received.at(-1)?.requires).toBe(item.delegate);
      expect(received.at(-1)?.verifiedOwnerId).toBe('owner-1');
      expect(received.at(-1)?.graphInput).toEqual({ ask: 'build an app' });
      expect(received.at(-1)?.outputs).toBe(runContext.outputs);
    }
    expect(received).toHaveLength(APP_BUILD_CATALOG_NODES.length);
  });

  test('failed B1/B2 results expose bounded redeclaration candidates, not repair verdicts', async () => {
    const base = delegateRegistry(candidate => ({ ok: false, outcome: 'failed',
      error: candidate.requires === 'source-build.files@1' ? 'FILE_OUTPUT_INVALID' : 'BUILD_TESTS_EXHAUSTED' }));
    const wrapper = registerAppBuildCatalogNodeWrappers(base).providers.find(item => item.id === 'app-build-catalog-node-wrapper');
    expect(wrapper).toBeDefined();
    const files = await wrapper!.invoke(context(APP_BUILD_CATALOG_NODES[5]));
    const verify = await wrapper!.invoke(context(APP_BUILD_CATALOG_NODES[6]));
    expect(files.evidence?.failureSignal).toEqual({ node: 'files', phase: 'generate', reason: 'FILE_OUTPUT_INVALID', redeclareCandidate: 'file-plan' });
    expect(verify.evidence?.failureSignal).toEqual({ node: 'verify-repair', phase: 'test', reason: 'BUILD_TESTS_EXHAUSTED', redeclareCandidate: 'test-contract' });
    expect(files.error).toBe('FILE_OUTPUT_INVALID');
    expect(verify.error).toBe('BUILD_TESTS_EXHAUSTED');
    const runnerResult = await dispatchGraphContract(APP_BUILD_CATALOG_NODES[5].contract, runnerContext(APP_BUILD_CATALOG_NODES[5]),
      registerAppBuildCatalogNodeWrappers(base));
    expect(runnerResult.error).toBe('contract-exhausted');
    expect(appBuildNodeFailureSignal('files', runnerResult)).toEqual({
      node: 'files', phase: 'generate', reason: 'FILE_OUTPUT_INVALID', redeclareCandidate: 'file-plan',
    });
    expect(appBuildNodeFailureSignal('verify-repair', { ok: false, outcome: 'failed', error: 'FILE_OUTPUT_INVALID' })).toEqual({
      node: 'verify-repair', phase: 'test', reason: 'FILE_OUTPUT_INVALID', redeclareCandidate: 'file-plan',
    });
    expect(appBuildNodeFailureSignal('publish', { ok: false, outcome: 'failed', error: 'unprovided' })).toEqual({
      node: 'publish', phase: 'publish', reason: 'unprovided',
    });
    expect(appBuildNodeFailureSignal('publish', { ok: false, outcome: 'failed', error: 'token=private-value' })).toEqual({
      node: 'publish', phase: 'publish', reason: 'provider-failed',
    });
    expect(appBuildNodeFailureSignal('files', { ok: false, outcome: 'failed', error: 'API_KEY_PRIVATE_VALUE' })).toEqual({
      node: 'files', phase: 'generate', reason: 'provider-failed',
    });
    expect(appBuildNodeFailureSignal('verify-repair', { ok: false, outcome: 'failed', error: 'contract-exhausted',
      evidence: { attempts: [{ provider: 'source-build', reason: 'SECRET_TOKEN_PRIVATE_VALUE' }] } })).toEqual({
      node: 'verify-repair', phase: 'test', reason: 'provider-failed',
    });
    expect(appBuildNodeFailureSignal('verify-repair', { ok: false, outcome: 'failed', error: 'contract-exhausted',
      evidence: { attempts: [
        { provider: 'first', reason: 'provider-error' },
        { provider: 'second', reason: 'BUILD_TESTS_EXHAUSTED' },
      ] } })).toEqual({
      node: 'verify-repair', phase: 'test', reason: 'BUILD_TESTS_EXHAUSTED', redeclareCandidate: 'test-contract',
    });
  });

  test('missing delegate and stage mismatch fail before any underlying effect', async () => {
    expect(() => registerAppBuildCatalogNodeWrappers(emptyGraphCapabilityRegistry())).toThrow('missing app-build delegate contract');
    let calls = 0;
    const registry = registerAppBuildCatalogNodeWrappers(delegateRegistry(() => {
      calls++;
      return { ok: true, outcome: 'done', result: {} };
    }));
    const wrapper = registry.providers.find(item => item.id === 'app-build-catalog-node-wrapper')!;
    const result = await wrapper.invoke({ ...context(APP_BUILD_CATALOG_NODES[5]), input: { stage: 'publish' } });
    expect(result).toEqual({ ok: false, outcome: 'failed', error: 'APP_BUILD_NODE_MISMATCH' });
    const noOwner = await wrapper.invoke({ ...context(APP_BUILD_CATALOG_NODES[5]), verifiedOwnerId: undefined });
    expect(noOwner).toEqual({ ok: false, outcome: 'failed', error: 'VERIFIED_OWNER_REQUIRED' });
    expect(calls).toBe(0);
  });
});
