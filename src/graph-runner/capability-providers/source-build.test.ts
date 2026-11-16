import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraph } from '../runner.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { defaultCapabilityRegistryForGraph } from '../plugin-graph-providers.js';
import { createSourceBuildRegistry, seedRuntimePlanMatches } from './source-build.js';
import { registerAppBuildPublishApprovalProvider } from './app-build-publish-approval.js';
import type { createBuildExecution } from '../app-build/build-execution.js';
import { ARCHITECTURE_SECTIONS, APP_BUILD_MAX_FILES, APP_BUILD_MAX_REPAIRS } from '../app-build/contracts.js';
import { apiSurfaceLines, readEnvironmentReceipt, writeEnvironmentReceipt, type DeploymentEnvironment } from '../app-build/deployment-environment.js';
import { readGroundingReceipt, writeGroundingReceipt } from '../app-build/grounding.js';

const graph = fileURLToPath(new URL('../../../plugins/elanous-app-build/graph/app-build.yaml', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const assumptions = [{ statement: 'assumed: Use local built-in storage.', source: 'assumed' as const }];
const diagrams: Record<string, string> = {
  context: '```mermaid\ngraph TD\n Browser-->API\n API-->Store\n```',
  dataModel: '```mermaid\nerDiagram\n RECORD {\n string id PK\n }\n```',
  sequences: '```mermaid\nsequenceDiagram\n Browser->>API: create record\n API-->>Browser: record\n```',
};
const testStrategy = [{ id: 'roundtrip', kind: 'api', target: 'Validate storage round trip', testFile: 'tests/main.test.ts', device: 'bun-test-sandbox', command: ['bun', 'test', './tests/main.test.ts'] }];
const architecture = { testStrategyTitle: 'Test strategy', testStrategy, sections: Object.fromEntries(ARCHITECTURE_SECTIONS.map(key => [key, 'Concrete ' + key])),
  markdown: ARCHITECTURE_SECTIONS.map(key => '## ' + key + '\nConcrete ' + key + '\n' + (diagrams[key] ?? '')
    + (key === 'api' ? '\n[API](backend/main.ts)' : '')).join('\n') };
const plan = [
  { path: 'ARCHITECTURE.md', role: 'architecture' }, { path: 'database/schema.ts', role: 'database' },
  { path: 'backend/main.ts', role: 'backend' }, { path: 'frontend/index.html', role: 'frontend' }, { path: 'tests/main.test.ts', role: 'test' },
].map(file => ({ ...file, purpose: 'Complete ' + file.role, dependsOn: file.role === 'architecture' ? [] : ['ARCHITECTURE.md'] }));

test('seeded plan binds the runtime entry, database, and seed test', () => {
  const seeded = [
    { path: 'database/schema.ts', role: 'database', dependsOn: [] },
    { path: 'backend/seed.ts', role: 'seed', dependsOn: ['database/schema.ts'] },
    { path: 'backend/main.ts', role: 'backend', dependsOn: ['backend/seed.ts'] },
    { path: 'tests/seed.test.ts', role: 'test', dependsOn: ['backend/main.ts', 'backend/seed.ts'] },
  ];
  const strategy = [{ id: 'startup-seed', kind: 'seed', target: 'Fresh list has items and restart has no duplicates',
    testFile: 'tests/seed.test.ts', device: 'bun-test-sandbox', command: ['bun', 'test', './tests/seed.test.ts'] }];
  expect(seedRuntimePlanMatches(seeded, 'backend/main.ts', strategy)).toBe(true);
  expect(seedRuntimePlanMatches(seeded, 'backend/other.ts', strategy)).toBe(false);
  expect(seedRuntimePlanMatches(seeded.map(file => file.path === 'backend/main.ts'
    ? { ...file, dependsOn: [] } : file), 'backend/main.ts', strategy)).toBe(false);
  expect(seedRuntimePlanMatches(seeded.map(file => file.path === 'backend/seed.ts'
    ? { ...file, dependsOn: [] } : file), 'backend/main.ts', strategy)).toBe(false);
  expect(seedRuntimePlanMatches([...seeded, { path: 'database/other.ts', role: 'database', dependsOn: [] }],
    'backend/main.ts', strategy)).toBe(false);
  expect(seedRuntimePlanMatches(seeded, 'backend/main.ts', [{ ...strategy[0], kind: 'api' }])).toBe(false);
  expect(seedRuntimePlanMatches(seeded.map(file => file.path === 'tests/seed.test.ts'
    ? { ...file, dependsOn: ['backend/seed.ts'] } : file), 'backend/main.ts', strategy)).toBe(false);
});
const input = { ask: 'Create an application with frontend backend and storage.', seedRequested: false, appSlug: 'synthetic-app',
  context: { memberId: 'synthetic-owner' },
  artifactMetadata: { runtime: { startCommand: ['bun', 'backend/main.ts'], healthPath: '/health' }, frontendRoot: 'frontend', apiPrefix: '/api' } };
const measuredEnvironment: DeploymentEnvironment = { runtime: { command: 'bun', version: '1.4.2', platform: 'darwin' },
  builtinModules: ['bun:sqlite', 'node:fs'], testModules: ['bun:test'], storageModules: ['bun:sqlite'],
  apiSurfaces: [{ module: 'bun:sqlite', exports: ['Database'], classes: [{ name: 'Database', methods: ['exec', 'query', 'run'] }] }],
  nodeModulesPresent: false, installedPackages: [],
  packageInstallAvailable: false, network: 'off', writableArtifactRoot: true, writableTempRoot: true,
  portBindingAvailable: false, sandbox: 'darwin-private-netoff-envempty' };
type Host = ReturnType<typeof createBuildExecution>;
function environment(options: { failTests?: boolean; authFails?: boolean; foreignOwner?: boolean; publishFails?: boolean;
  retryEveryFile?: boolean; failedVerifications?: number; unavailableImport?: 'once' | 'always'; fencedFile?: boolean;
  methodFailure?: boolean } = {}) {
  const receiptRoot = root();
  const calls: string[] = []; const prompts: string[] = []; const rawOutputs: string[] = [];
  let checkpoint: Awaited<ReturnType<Host['load']>>;
  let verifies = 0;
  const attempts = new Map<string, number>();
  const activePlan = options.retryEveryFile ? [...plan, ...Array.from({ length: APP_BUILD_MAX_FILES - plan.length }, (_, index) => ({
    path: 'backend/module-' + index + '.ts', role: 'backend', purpose: 'Independent local module', dependsOn: ['ARCHITECTURE.md'],
  }))] : plan;
  const host: Host = {
    reserve: async (ownerId, runId, appSlug) => {
      calls.push('reserve'); if (options.authFails) throw new Error('synthetic-private-diagnostic');
      return { ownerId: options.foreignOwner ? 'foreign' : ownerId, runId, appSlug, userSlug: 'syntheticowner',
        sourceRoot: '/synthetic/private-root', issuerExpiresAt: '2099-01-01T00:00:00Z', sourceHead: 'a'.repeat(40) };
    },
    load: async () => checkpoint,
    save: async (_grant, planDigest, files) => { checkpoint = { planDigest, files: files.map(file => ({ ...file })) };
      return { planDigest, fileDigest: sha(JSON.stringify(files)), files: files.length }; },
    verify: async (_grant, _files, _signal, strategy) => { calls.push('verify'); verifies++; return { testStrategySha256: sha(JSON.stringify(strategy)), testReceipts: (strategy ?? []).map(item => ({ strategyId: item.id, device: item.device, testFile: item.testFile, command: item.command, selection: 'isolated-test-entry' as const, passed: !options.failTests && verifies > (options.failedVerifications ?? 1), exitCode: !options.failTests && verifies > (options.failedVerifications ?? 1) ? 0 : 1, fileSha256: sha('fixture') })), passed: !options.failTests && verifies > (options.failedVerifications ?? 1),
      fileDigest: sha('files'), diagnostic: options.methodFailure ? 'TypeError: db.pragma is not a function' : 'synthetic test failed',
      sandbox: 'darwin-private-netoff-envempty', truncated: false }; },
    materialize: async grant => { calls.push('materialize'); return { sourceRoot: grant.sourceRoot, fileDigest: sha('files'), artifact: {} }; },
    publish: async () => { calls.push('publish'); if (options.publishFails) throw new Error('BUILD_APPROVAL_REQUIRED');
      return { status: 'published', deploymentId: 'synthetic-deployment', publicUrl: 'https://synthetic-app--syntheticowner.elanous.app', artifactDigest: sha('artifact') }; },
  };
  const callLLM = async (prompt: string) => {
    prompts.push(prompt);
    let value: unknown;
    if (prompt.includes('Stage: assumptions.')) value = { assumptions };
    else if (prompt.includes('Stage: architecture.')) value = architecture;
    else if (prompt.includes('Stage: file-plan.')) value = { plan: activePlan };
    else { const request = JSON.parse(prompt.split('\nDeployment contract:')[0]!);
      const attempt = (attempts.get(request.file.path) ?? 0) + 1; attempts.set(request.file.path, attempt);
      if (options.retryEveryFile && attempt % (APP_BUILD_MAX_REPAIRS + 1) !== 0) return {
        text: 'invalid synthetic source reply', provider: 'fixture-provider', model: 'fixture-model',
      };
      value = { path: request.file.path, content: request.file.path === 'backend/main.ts' && options.unavailableImport
        && (options.unavailableImport === 'always' || attempt === 1)
        ? "import Database from 'better-sqlite3'; export const source = Database;"
        : 'export const source = "SYNTHETIC_FILE_BYTES_NOT_INLINE";' }; }
    const plain = JSON.stringify(value);
    return { text: options.fencedFile && value && typeof value === 'object' && 'path' in value
      ? '```json\n' + plain + '\n```' : plain, provider: 'fixture-provider', model: 'fixture-model' };
  };
  return { host, callLLM, calls, prompts, rawOutputs,
    diagnoseEnvironment: async () => measuredEnvironment,
    recordEnvironment: () => ({ path: '/synthetic/environment.json', sha256: sha('synthetic environment') }),
    readEnvironment: () => measuredEnvironment,
    collectGrounding: async () => ({ runtime: measuredEnvironment.runtime, internalApi: apiSurfaceLines(measuredEnvironment),
      external: [], externalStatus: 'source-unverified' as const, neededDevices: ['firecrawl-key', 'grok-search'] }),
    recordGrounding: (_root: string, runId: string, value: Parameters<typeof writeGroundingReceipt>[2]) =>
      writeGroundingReceipt(join(receiptRoot, 'grounding'), runId, value),
    readGrounding: (_root: string, runId: string, receipt: Parameters<typeof readGroundingReceipt>[2]) =>
      readGroundingReceipt(join(receiptRoot, 'grounding'), runId, receipt),
    recordModelRaw: (_root: string, _runId: string, text: string) => { rawOutputs.push(text);
      return { path: '/synthetic/model-raw.raw', sha256: sha(text) }; } };
}
function root() { const path = mkdtempSync(join(tmpdir(), 'build-graph-')); roots.push(path); return path; }
function approvalRegistry(e: Parameters<typeof createSourceBuildRegistry>[0], outcome: 'approved' | 'pending' | 'denied' = 'approved') {
  const signal = AbortSignal.timeout(10_000);
  const deadlineAtMs = Date.now() + 10_000;
  const approvalUrl = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';
  let pendingExpiresAt = '';
  let presented = false;
  const registry = registerAppBuildPublishApprovalProvider(createSourceBuildRegistry(e), {
    transport: async action => {
      if (outcome === 'denied') return { status: 'approval-denied' };
      if (action === 'approval-start') pendingExpiresAt = new Date(Date.now() + (outcome === 'pending' ? 60 : 5_000)).toISOString();
      return action === 'approval-poll' && outcome === 'approved' && presented
        ? { status: 'approval-approved' }
        : { status: 'approval-pending', approvalUrl, pendingExpiresAt };
    },
    presentApprovalUrl: async ownerId => { expect(ownerId).toBe('synthetic-owner'); presented = true; },
    trustedWindow: () => ({ signal, deadlineAtMs }),
    pollIntervalMsForTesting: 10,
  });
  // Direct runGraph fixtures lack the TUI context adapter. Bind its trusted
  // signal exactly as the production child route does, without bypassing poll.
  return { ...registry, providers: registry.providers.map(provider =>
    provider.id === 'app-build-owner-publish-approval'
      ? { ...provider, invoke: (context: InProcessHandlerContext) => provider.invoke({ ...context, signal }) } : provider) };
}
const result = (value: unknown): Record<string, unknown> => {
  const object = typeof value === 'string' ? JSON.parse(value) : value;
  return object && typeof object === 'object' ? (object as { result?: Record<string, unknown> }).result ?? {} : {};
};

test('manifest default factory provides actual planning and build capabilities without a missing-host injection requirement', async () => {
  const registry = await defaultCapabilityRegistryForGraph(graph);
  expect(registry.contracts['source-planning.architecture@1']).toBeDefined();
  expect(registry.contracts['source-build.materialize@1']).toBeDefined();
  expect(registry.contracts['source-build.grounding@1']).toBeDefined();
  expect(registry.providers.map(provider => provider.id)).toContain('source-build');
});

test('default graph grounding node consumes a measured receipt and feeds B1 and B2', async () => {
  const e = environment({ methodFailure: true });
  const graphRoot = root();
  const sourceText = 'Bun v1.4.2 official source';
  const collected = { runtime: { command: 'bun', version: '1.4.2' },
    internalApi: ['bun:sqlite exports: Database', 'bun:sqlite Database.prototype methods: exec, query, run'],
    external: [{ collector: 'official-direct' as const, url: 'https://bun.sh/blog/bun-v1.4.2',
      collectedAt: '2026-11-15T00:00:00Z', sha256: sha(sourceText), runtimeVersion: '1.4.2', excerpt: sourceText }],
    externalStatus: 'verified' as const, neededDevices: ['firecrawl-key'] };
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: graphRoot, capabilityProviders: approvalRegistry({ ...e,
      collectGrounding: async () => collected,
      recordEnvironment: (_root, runId, value) => writeEnvironmentReceipt(join(graphRoot, 'environment'), runId, value),
      readEnvironment: (_root, runId, receipt) => readEnvironmentReceipt(join(graphRoot, 'environment'), runId, receipt),
      recordGrounding: (_root, runId, value) => writeGroundingReceipt(join(graphRoot, 'grounding'), runId, value),
      readGrounding: (_root, runId, receipt) => readGroundingReceipt(join(graphRoot, 'grounding'), runId, receipt) }) } });
  expect(state.status).toBe('done');
  expect(state.path[1]).toBe('grounding');
  expect(e.prompts.some(prompt => prompt.includes('Official 1.4.2 source https://bun.sh/blog/bun-v1.4.2'))).toBe(true);
  expect(e.prompts.some(prompt => prompt.includes('testFailure') && prompt.includes('Official 1.4.2 source'))).toBe(true);
});

test('default graph continues with an unavailable-source grounding receipt', async () => {
  const e = environment();
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  expect(state.path[1]).toBe('grounding');
  const grounding = result(state.nodes.find(node => node.nodeId === 'grounding')?.output);
  expect(grounding.externalStatus).toBe('source-unverified');
  expect(grounding.neededDevices).toEqual(['firecrawl-key', 'grok-search']);
  expect(e.prompts.some(prompt => prompt.includes('Measured runtime API surface'))).toBe(true);
  expect(e.prompts.some(prompt => prompt.includes('Official 1.4.2 source'))).toBe(false);
});

test('actual graph repairs a failed sandbox then materializes and publishes only after a passing test, with code bytes kept out of the ledger', async () => {
  const e = environment();
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['source-reserve', 'grounding', 'assumptions', 'architecture', 'file-plan', 'files', 'verify-repair', 'materialize', 'publish-approval', 'publish', 'done']);
  expect(e.calls).toEqual(['reserve', 'verify', 'verify', 'materialize', 'publish']);
  expect(result(state.nodes.find(node => node.nodeId === 'verify-repair')?.output).repairUsed).toBe(1);
  expect(result(state.nodes.find(node => node.nodeId === 'publish')?.output).buildComplete).toBe(true);
  expect(e.prompts.some(prompt => prompt.includes('testFailure'))).toBe(true);
  expect(JSON.stringify(state)).not.toContain('SYNTHETIC_FILE_BYTES_NOT_INLINE');
});

test('missing runtime method gets measured API alternatives in B2 repair prompt', async () => {
  const e = environment({ methodFailure: true });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  expect(e.prompts.some(prompt => prompt.includes('absent from measured storage API surfaces: pragma'))).toBe(true);
  expect(e.prompts.some(prompt => prompt.includes('Database.prototype methods: exec, query, run'))).toBe(true);
});

test('sandbox failure exhausts two repairs without creating or publishing an app', async () => {
  const e = environment({ failTests: true });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('failed'); expect(e.calls.filter(call => call === 'verify')).toHaveLength(APP_BUILD_MAX_REPAIRS + 1);
  expect(e.calls).not.toContain('materialize'); expect(e.calls).not.toContain('publish');
});

test('unavailable package import is identified before sandbox and repaired using measured built-ins', async () => {
  const e = environment({ unavailableImport: 'once' });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  expect(e.prompts.some(prompt => prompt.includes('backend/main.ts:1 imports better-sqlite3'))).toBe(true);
  expect(e.prompts.some(prompt => prompt.includes('available storage modules: bun:sqlite'))).toBe(true);
  expect(e.prompts.some(prompt => prompt.includes('encode source line breaks and quotes as JSON string escapes'))).toBe(true);
  expect(e.prompts.filter(prompt => prompt.startsWith('{')
    && JSON.parse(prompt.split('\nDeployment contract:')[0]!).file.path === 'database/schema.ts')).toHaveLength(2);
  expect(e.calls.filter(call => call === 'verify')).toHaveLength(2);
});

test('file response normalization retains untouched provider raw digest in graph evidence', async () => {
  const e = environment({ fencedFile: true });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  expect(e.rawOutputs[0]?.startsWith('```json')).toBe(true);
  const files = state.nodes.find(node => node.nodeId === 'files');
  const output = JSON.parse(String(files?.output));
  expect(output.evidence.modelRawReceipts[0].sha256).toBe(sha(e.rawOutputs[0]!));
});

test('repeated unavailable import fails before the sandbox and publication', async () => {
  const e = environment({ unavailableImport: 'always' });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('failed');
  expect(e.calls).toEqual(['reserve']);
  expect(JSON.stringify(state)).toContain('BUILD_IMPORTS_UNAVAILABLE');
});

test('full per-file retries cannot consume either whole-program repair round budget', async () => {
  const e = environment({ retryEveryFile: true, failedVerifications: APP_BUILD_MAX_REPAIRS });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  expect(e.calls.filter(call => call === 'verify')).toHaveLength(APP_BUILD_MAX_REPAIRS + 1);
  const generatedCalls = (APP_BUILD_MAX_FILES - 1) * (APP_BUILD_MAX_REPAIRS + 1) * (APP_BUILD_MAX_REPAIRS + 1);
  expect(e.prompts.filter(prompt => !prompt.includes('Stage: '))).toHaveLength(generatedCalls);
  expect(e.calls.slice(-2)).toEqual(['materialize', 'publish']);
  expect(result(state.nodes.find(node => node.nodeId === 'verify-repair')?.output).repairUsed).toBe(APP_BUILD_MAX_REPAIRS);
});

test('authority failure or a foreign grant stops before any model call and hides raw dependency errors', async () => {
  for (const options of [{ authFails: true }, { foreignOwner: true }]) {
    const e = environment(options);
    const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
      deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
    expect(state.status).toBe('failed'); expect(e.prompts).toHaveLength(0); expect(e.calls).toEqual(['reserve']);
    expect(JSON.stringify(state)).not.toContain('synthetic-private-diagnostic');
  }
});

test('publication refusal never turns an inspected/materialized source into buildComplete', async () => {
  const e = environment({ publishFails: true });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('failed'); expect(JSON.stringify(result(state.nodes.find(node => node.nodeId === 'publish')?.output))).not.toContain('"buildComplete":true');
});

test('pending or denied owner approval cannot reach the fake publisher', async () => {
  for (const outcome of ['pending', 'denied'] as const) {
    const e = environment({ failedVerifications: 0 });
    const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
      deps: { root: root(), capabilityProviders: approvalRegistry(e, outcome) } });
    expect(state.status).toBe('failed');
    expect(state.path).toContain('publish-approval');
    expect(state.path).not.toContain('publish');
    expect(e.calls).toContain('materialize');
    expect(e.calls).not.toContain('publish');
  }
});

 test('fake provider graph consumes strategy files and emits B2 strategy execution receipts', async () => {
  const e = environment({ failedVerifications: 0 });
  const state = await runGraph(graph, { input, verifiedOwnerId: 'synthetic-owner', quiet: true,
    deps: { root: root(), capabilityProviders: approvalRegistry(e) } });
  expect(state.status).toBe('done');
  const checked = result(state.nodes.find(node => node.nodeId === 'verify-repair')?.output);
  expect(checked.testReceipts).toEqual([expect.objectContaining({ strategyId: 'roundtrip',
    device: 'bun-test-sandbox', testFile: 'tests/main.test.ts', command: ['bun', 'test', './tests/main.test.ts'], passed: true })]);
  expect(e.prompts.some(prompt => prompt.includes('testStrategy'))).toBe(true);
});
