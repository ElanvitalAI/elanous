import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyGraphCapabilityRegistry, dispatchGraphContract,
  registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../capabilities.js';
import { lowerGraphV2 } from '../../graph-v2/lower.js';
import { runGraph } from '../runner.js';
import { generatePlannedFiles } from '../app-build/file-generation.js';
import { createSourceBuildRegistry } from './source-build.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { APP_BUILD_RICH_CONTRACTS, bindRichPlanningContext, preserveBuildFailureReasons,
  registerAppBuildRichTraversal } from './app-build-rich-traversal.js';

const ASK = 'Build a restaurant reservation app with synthetic tables and publish it.';
const OWNER = 'verified-owner';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const context = (input: Record<string, unknown>, outputs: Record<string, unknown> = {}, nodeId = 'source-items'):
  InProcessHandlerContext => ({ graphId: 'app-build', runId: 'blind-restaurant', nodeId,
    verifiedOwnerId: OWNER, graphInput: { ask: ASK, seedRequested: true },
    input: { ask: ASK, seedRequested: true }, nodeInput: input, outputs });
const output = (result: unknown) => ({ outcome: 'done', result });
const done = (result: Record<string, unknown>) => ({ ok: true as const, outcome: 'done' as const, result });

test('real source-item producer exposes web, document and Aside lanes without inventing absent evidence', async () => {
  const called: string[] = [];
  const registry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry(), {
    research: async item => { called.push(item.kind); return { kind: item.kind, status: 'verified', excerpt: item.kind,
      ...(item.kind === 'aside' ? {} : { url: 'https://example.org/source' }), sha256: sha256(item.kind) }; },
  });
  const requested = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceList,
    context({}, {}, 'source-items'), registry);
  expect(requested).toMatchObject({ ok: true, outcome: 'done' });
  const items = (requested.result as { items: Array<{ kind: string; requested: boolean }> }).items;
  expect(items.map(item => [item.kind, item.requested])).toEqual([
    ['web', true], ['document', false], ['aside', false],
  ]);
  const reads = await Promise.all(items.map((source, index) => dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceRead,
    context({ source }, { 'source-items': output({ items }) }, `source-read__map_${index}`), registry)));
  expect(reads.every(item => item.ok && item.outcome === 'done')).toBe(true);
  expect(reads.map(item => (item.result as { kind: string }).kind)).toEqual(['web', 'document', 'aside']);
  expect(reads.map(item => (item.result as { status: string }).status)).toEqual(['verified', 'unavailable', 'unavailable']);
  expect(called).toEqual(['web']);
  expect(await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceRead,
    context({ source: { kind: 'unknown', requested: true } }), registry)).toMatchObject({ ok: false });
});

test('source collectors can run concurrently, and an unavailable source is not promoted to a verified citation', async () => {
  let started = 0; let concurrent = 0; let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const registry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry(), { research: async item => {
    started++; concurrent++; peak = Math.max(peak, concurrent);
    if (started === 3) release();
    await barrier;
    concurrent--;
    return item.kind === 'aside' ? { kind: item.kind, status: 'unavailable', reason: 'aside-unavailable' }
      : { kind: item.kind, status: 'verified', url: 'https://example.org/source',
        excerpt: 'bounded source', sha256: sha256('bounded source') };
  } });
  const items = [
    { kind: 'web', requested: true, query: 'restaurant' },
    { kind: 'document', requested: true, url: 'https://example.org/brief.pdf' },
    { kind: 'aside', requested: true, query: 'restaurant' },
  ];
  const reads = await Promise.all(items.map((source, index) => dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceRead,
    context({ source }, {}, `source-read__map_${index}`), registry)));
  expect(peak).toBe(3);
  expect(reads.map(item => (item.result as { status: string }).status)).toEqual(['verified', 'verified', 'unavailable']);
});

test('a source collector cannot promote a mismatched lane or private URL into planning evidence', async () => {
  const registry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry(), { research: async () => ({
    kind: 'document', status: 'verified', url: 'https://example.org/source',
    excerpt: 'untrusted text', sha256: 'd'.repeat(64),
  }) });
  const read = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceRead,
    context({ source: { kind: 'web', requested: true } }, {}, 'source-read__map_0'), registry);
  expect(read).toMatchObject({ ok: false, outcome: 'failed' });
  const privateRegistry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry(), { research: async () => ({
    kind: 'document', status: 'verified', url: 'https://127.0.0.1/private',
    excerpt: 'untrusted text', sha256: 'd'.repeat(64),
  }) });
  const privateRead = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceRead,
    context({ source: { kind: 'document', requested: true, url: 'https://127.0.0.1/private' } }, {}, 'source-read__map_1'), privateRegistry);
  expect(privateRead).toMatchObject({ ok: true, outcome: 'done', result: {
    status: 'unavailable', reason: 'document-url-not-public' } });
  const tamperedRegistry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry(), { research: async () => ({
    kind: 'web', status: 'verified', url: 'https://example.org/source', excerpt: 'altered evidence',
    sha256: sha256('original evidence'),
  }) });
  const tampered = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.sourceRead,
    context({ source: { kind: 'web', requested: true } }, {}, 'source-read__map_0'), tamperedRegistry);
  expect(tampered).toMatchObject({ ok: false, outcome: 'failed' });
});

test('architecture reflection returns a bounded rework outcome for missing synthetic seed coverage', async () => {
  const registry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry());
  const sections = Object.fromEntries(['context', 'dataModel', 'api', 'sequences', 'deployment', 'security', 'tradeOffs', 'operations']
    .map(name => [name, 'Concrete ' + name]));
  const diagrams: Record<string, string> = { context: 'graph TD\nA-->B',
    dataModel: 'erDiagram\nA {\n string id PK\n}', sequences: 'sequenceDiagram\nA->>B: call' };
  const markdown = Object.keys(sections).map(name => `## ${name}\nConcrete ${name}\n`
    + (diagrams[name] ? '```mermaid\n' + diagrams[name] + '\n```\n' : '')
    + (name === 'api' ? '[API](backend/main.ts)' : '')).join('\n');
  const architecture = { markdown, sections, testStrategy: [{ kind: 'unit' }] };
  const reflected = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.reflection,
    context({}, { architecture: output({ architecture }) }, 'architecture-reflection'), registry);
  expect(reflected).toMatchObject({ ok: true, outcome: 'rework' });
  expect((reflected.result as { reasons: string[] }).reasons).toContain('seed-test-missing');
  const accepted = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.reflection,
    context({}, { architecture: output({ architecture: { ...architecture, testStrategy: [{ kind: 'seed' }] } }) }, 'architecture-reflection'), registry);
  expect(accepted.outcome).toBe('done');
});

test('failure causes remain distinct and repair notes carry only diagnostic hashes', async () => {
  const registry = registerAppBuildRichTraversal(emptyGraphCapabilityRegistry());
  const plan = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'files' }, { files: { outcome: 'failed', error: 'BUILD_PLAN_RUNTIME_MISMATCH' } }, 'classify-files'), registry);
  expect(plan.outcome).toBe('plan');
  const generation = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'files' }, { files: { outcome: 'failed', error: 'BUILD_IMPORTS_UNAVAILABLE' } }, 'classify-files'), registry);
  expect(generation.outcome).toBe('generation');
  const spentVerification = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'verify-repair' }, { 'verify-repair': { outcome: 'failed', error: 'BUILD_TESTS_EXHAUSTED',
      evidence: { repairUsed: 2 } } }, 'classify-verify'), registry);
  expect(spentVerification.outcome).toBe('verification');
  const graphRepairSpent = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'verify-repair' }, { 'verify-repair': { outcome: 'failed', error: 'BUILD_TESTS_EXHAUSTED',
      evidence: { repairUsed: 2 } }, 'repair-verification': output({ instruction: 'replan once' }) }, 'classify-verify'), registry);
  expect(graphRepairSpent.outcome).toBe('fatal');
  const acceptance = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'acceptance' }, { acceptance: { outcome: 'failed', error: 'BUILD_ACCEPTANCE_FAILED',
      evidence: { reason: 'SEED_NOT_STARTED', repairUsed: 1 } } }, 'classify-acceptance'), registry);
  expect(acceptance.outcome).toBe('seed_missing');
  const exhausted = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'acceptance' }, { acceptance: { outcome: 'failed', error: 'BUILD_ACCEPTANCE_FAILED',
      evidence: { reason: 'SEED_NOT_STARTED', repairUsed: 2 } } }, 'classify-acceptance'), registry);
  expect(exhausted.outcome).toBe('fatal');
  const unauthorized = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'acceptance' }, { acceptance: output({ failed: true, errorCode: 'BUILD_ACCEPTANCE_FAILED',
      reason: 'VISITOR_WRITE_UNAUTHORIZED', repairUsed: 0 }) }, 'classify-acceptance'), registry);
  expect(unauthorized.outcome).toBe('fatal');
  const seedRepair = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.repairNote,
    context({ cause: 'seed_missing' }, { 'classify-acceptance': output(acceptance.result) }, 'repair-seed'), registry);
  expect(seedRepair).toMatchObject({ ok: true, outcome: 'done' });
  expect((seedRepair.result as { instruction: string }).instruction).toContain('shared database path');
  const note = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.repairNote,
    context({ cause: 'generation' }, { 'classify-files': output(generation.result) }, 'repair-generation'), registry);
  expect(note).toMatchObject({ ok: true, outcome: 'done' });
  expect(JSON.stringify(note)).not.toContain('BUILD_IMPORTS_UNAVAILABLE');
  expect((note.result as { diagnosticSha256: string }).diagnosticSha256).toMatch(/^[a-f0-9]{64}$/u);
});

test('build failure adapter preserves a bounded cause through contract dispatch for a graph repair edge', async () => {
  let base = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'source-build.files@1', input: { type: 'object' }, output: { type: 'object' },
  });
  base = registerGraphCapabilityProviderDeclaration(base, { id: 'source-build',
    provides: ['source-build.files@1'], tier: 'free', invoke: async () => ({ ok: false,
      outcome: 'failed', error: 'BUILD_PLAN_RUNTIME_MISMATCH', evidence: { diagnostic: 'private raw source' } }) });
  const registry = registerAppBuildRichTraversal(preserveBuildFailureReasons(base));
  const failed = await dispatchGraphContract('source-build.files@1', context({ stage: 'files' }, {}, 'files'), registry);
  expect(failed).toMatchObject({ ok: true, outcome: 'failed', result: {
    failed: true, errorCode: 'BUILD_PLAN_RUNTIME_MISMATCH' } });
  expect(JSON.stringify(failed)).not.toContain('private raw source');
  const classified = await dispatchGraphContract(APP_BUILD_RICH_CONTRACTS.failureCause,
    context({ phase: 'files' }, { files: output(failed.result) }, 'classify-files'), registry);
  expect(classified.outcome).toBe('plan');
});

test('planner context consumes only verified bounded references and diagnosed repair feedback', async () => {
  let seen: unknown;
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'source-planning.architecture@1', input: { type: 'object' }, output: { type: 'object' },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'source-planning',
    provides: ['source-planning.architecture@1'], tier: 'free', invoke: request => {
      seen = request.graphInput; return { ok: true, outcome: 'done', result: {} };
    } });
  registry = bindRichPlanningContext(registry);
  const outputs = {
    'source-read__map_0': output({ kind: 'web', status: 'verified', url: 'https://example.org',
      excerpt: 'source text', sha256: 'c'.repeat(64) }),
    'source-read__map_1': output({ kind: 'document', status: 'unavailable', reason: 'no-document-url' }),
    'architecture-reflection': output({ reasons: ['seed-test-missing'] }),
  };
  await dispatchGraphContract('source-planning.architecture@1', context({ stage: 'architecture' }, outputs), registry);
  const ask = (seen as { ask: string }).ask;
  expect(ask).toContain('https://example.org');
  expect(ask).toContain('seed-test-missing');
  expect(ask).not.toContain('no-document-url');
  expect(ask.startsWith(ASK)).toBe(true);
});

test.each(['restaurant reservations', 'library lending'])(
  'real rich graph reaches owner HITL after reflection and cause-specific rejoin for blind %s', async domain => {
    const graphFile = join(import.meta.dir, '../../../plugins/elanous-app-build/graph/app-build.yaml');
    expect(lowerGraphV2(readFileSync(graphFile, 'utf8')).errors).toEqual([]);
    let registry = emptyGraphCapabilityRegistry();
    const contracts = ['source-build.reserve@1', 'source-build.grounding@1',
      'source-planning.assumptions@1', 'source-planning.architecture@1', 'source-planning.file-plan@1',
      'source-build.files@1', 'source-build.verify@1', 'source-build.materialize@1',
      'app-build.publish-approval@1', 'source-build.publish@1'] as const;
    for (const id of contracts) registry = registerGraphCapabilityContract(registry,
      { id, input: { type: 'object' }, output: { type: 'object' } });
    const sections = Object.fromEntries(['context', 'dataModel', 'api', 'sequences', 'deployment', 'security',
      'tradeOffs', 'operations'].map(name => [name, 'Concrete ' + name]));
    const diagrams: Record<string, string> = { context: 'graph TD\nA-->B',
      dataModel: 'erDiagram\nA {\n string id PK\n}', sequences: 'sequenceDiagram\nA->>B: call' };
    const markdown = Object.keys(sections).map(name => `## ${name}\nConcrete ${name}\n`
      + (diagrams[name] ? '```mermaid\n' + diagrams[name] + '\n```\n' : '')
      + (name === 'api' ? '[API](backend/main.ts)' : '')).join('\n');
    let architectureCalls = 0;
    const fileInvocations: string[] = [];
    let publishes = 0;
    registry = registerGraphCapabilityProviderDeclaration(registry, {
      id: 'source-planning', provides: contracts.filter(id => id.startsWith('source-planning.')),
      tier: 'free', invoke: async request => {
        const stage = (request.input as { stage: string }).stage;
        if (stage === 'assumptions') return done({ assumptions: [{ statement: domain, source: 'user' }] });
        if (stage === 'architecture') {
          architectureCalls++;
          return done({ architecture: { markdown, sections,
            testStrategy: [{ kind: architectureCalls === 1 ? 'unit' : 'seed' }] } });
        }
        return done({ plan: [{ path: 'backend/main.ts', role: 'backend', dependsOn: [] }] });
      },
    });
    registry = registerGraphCapabilityProviderDeclaration(registry, {
      id: 'source-build', provides: contracts.filter(id => id.startsWith('source-build.')),
      tier: 'free', invoke: async request => {
        const stage = (request.input as { stage: string }).stage;
        if (stage === 'files') {
          fileInvocations.push(request.nodeId);
          if (fileInvocations.length === 1)
            return { ok: false, outcome: 'failed', error: 'BUILD_PLAN_RUNTIME_MISMATCH' };
        }
        if (stage === 'publish') publishes++;
        return done({ passed: true });
      },
    });
    registry = registerGraphCapabilityProviderDeclaration(registry, {
      id: 'approval', provides: ['app-build.publish-approval@1'], tier: 'free',
      invoke: async () => done({ status: 'approved' }),
    });
    registry = bindRichPlanningContext(registerAppBuildRichTraversal(preserveBuildFailureReasons(registry), {
      research: async item => item.kind === 'web' ? {
        kind: 'web', status: 'verified', url: 'https://example.org/source',
        excerpt: domain, sha256: sha256(domain),
      } : { kind: item.kind, status: 'unavailable', reason: 'not-requested' },
    }));
    const root = mkdtempSync(join(tmpdir(), 'app-build-rich-blind-'));
    try {
      const state = await runGraph(graphFile, { input: { ask: `Build ${domain} with synthetic data`,
        seedRequested: true, appSlug: domain.startsWith('restaurant') ? 'restaurant' : 'library',
        artifactMetadata: { runtime: { startCommand: ['bun', 'backend/main.ts'], healthPath: '/health' } } },
      verifiedOwnerId: OWNER, quiet: true, deps: { root, capabilityProviders: registry } });
      expect(state.status).toBe('awaiting-approval');
      expect(state.pending?.nodeId).toBe('review-publish');
      expect(architectureCalls).toBe(2);
      expect(fileInvocations).toHaveLength(2);
      expect(state.path).toContain('source-read__map_fork');
      expect(state.path).toContain('classify-files');
      expect(state.path).toContain('repair-plan');
      expect(state.path).toContain('materialize');
      expect(state.path).not.toContain('publish-approval');
      expect(publishes).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test('real source-build B2 exhaustion with repairUsed two reaches graph verification repair then rejoin', async () => {
  const sections = Object.fromEntries(['context', 'dataModel', 'api', 'sequences', 'deployment', 'security',
    'tradeOffs', 'operations'].map(name => [name, 'Concrete ' + name]));
  const diagrams: Record<string, string> = { context: '```mermaid\ngraph TD\n Browser-->API\n API-->Store\n```',
    dataModel: '```mermaid\nerDiagram\n RECORD {\n string id PK\n }\n```',
    sequences: '```mermaid\nsequenceDiagram\n Browser->>API: create record\n API-->>Browser: record\n```' };
  const architecture = { testStrategyTitle: 'Test strategy',
    testStrategy: [{ id: 'roundtrip', kind: 'api', target: 'Validate storage round trip',
      testFile: 'tests/main.test.ts', device: 'bun-test-sandbox', command: ['bun', 'test', './tests/main.test.ts'] }],
    sections, markdown: Object.keys(sections).map(name => '## ' + name + '\nConcrete ' + name + '\n'
      + (diagrams[name] ?? '') + (name === 'api' ? '\n[API](backend/main.ts)' : '')).join('\n') };
  const plan = [{ path: 'ARCHITECTURE.md', role: 'architecture' }, { path: 'database/schema.ts', role: 'database' },
    { path: 'backend/main.ts', role: 'backend' }, { path: 'frontend/index.html', role: 'frontend' },
    { path: 'tests/main.test.ts', role: 'test' }].map(file => ({ ...file, purpose: 'Complete ' + file.role,
    dependsOn: file.role === 'architecture' ? [] : ['ARCHITECTURE.md'] }));
  const assumptions = [{ statement: 'assumed: Use built-in storage', source: 'assumed' as const }];
  const generated = await generatePlannedFiles({ assumptions, architecture, plan, seedRequested: false }, {
    callLLM: async prompt => JSON.stringify({ path: JSON.parse(prompt).file.path, content: 'export const source = 1;' }),
  });
  expect(generated.ok).toBe(true);
  if (!generated.ok) throw new Error(generated.code);
  let checkpoint = generated.resume;
  const verifiedCalls: string[] = [];
  let passAfterGraphRepair = true;
  const grant = { ownerId: OWNER, runId: 'unused-until-run', appSlug: 'library', userSlug: 'owner',
    sourceRoot: '/synthetic', issuerExpiresAt: '2099-01-01T00:00:00Z', sourceHead: 'a'.repeat(40) };
  const measuredEnvironment = { runtime: { command: 'bun', version: '1.4.2', platform: 'darwin' },
    builtinModules: ['bun:sqlite'], testModules: ['bun:test'], storageModules: ['bun:sqlite'], apiSurfaces: [],
    nodeModulesPresent: false, installedPackages: [], packageInstallAvailable: false, network: 'off',
    writableArtifactRoot: true, writableTempRoot: true, portBindingAvailable: false,
    sandbox: 'darwin-private-netoff-envempty' };
  const host = { reserve: async () => grant, load: async () => checkpoint,
    save: async (_grant: unknown, planDigest: string, files: typeof generated.files) => {
      checkpoint = { planDigest, files }; return { planDigest, fileDigest: sha256(JSON.stringify(files)), files: files.length };
    },
    verify: async () => {
      verifiedCalls.push('verify');
      const passed = passAfterGraphRepair && verifiedCalls.length > 3;
      return { passed, diagnostic: 'synthetic test failure', testStrategySha256: sha256('strategy'),
        testReceipts: [], fileDigest: sha256('files'), sandbox: 'darwin-private-netoff-envempty', truncated: false };
    },
    materialize: async () => ({ sourceRoot: '/synthetic', fileDigest: sha256('files') }),
    publish: async () => ({ status: 'published' }),
  };
  const realRegistry = createSourceBuildRegistry({ host: host as any,
    callLLM: async prompt => ({ text: JSON.stringify({
      path: JSON.parse(prompt.split('\nDeployment contract:')[0]!).file.path, content: 'export const source = 2;' }),
    provider: 'fixture', model: 'fixture' }),
    readEnvironment: () => measuredEnvironment as any });
  const sourceBuild = realRegistry.providers.find(provider => provider.id === 'source-build');
  if (!sourceBuild) throw new Error('source-build provider missing');
  const environmentReceipt = { path: '/synthetic/environment.json', sha256: sha256('environment') };
  const hybrid = { ...realRegistry, providers: realRegistry.providers.map(provider => provider.id === 'source-planning'
    ? { ...provider, invoke: async (request: InProcessHandlerContext) => {
      const stage = (request.input as { stage: string }).stage;
      return done(stage === 'assumptions' ? { assumptions }
        : stage === 'architecture' ? { architecture } : { assumptions, architecture, plan });
    } } : provider.id === 'source-build' ? { ...provider, invoke: async (request: InProcessHandlerContext) => {
      if (request.nodeId === 'verify-repair') return sourceBuild.invoke(request);
      if (request.nodeId === 'source-reserve') return done({ grant: { ...grant, runId: request.runId }, environmentReceipt });
      return done({ passed: true });
    } } : provider) };
  const registry = bindRichPlanningContext(registerAppBuildRichTraversal(preserveBuildFailureReasons(hybrid), {
    research: async item => ({ kind: item.kind, status: 'unavailable', reason: 'fixture-source-offline' }),
  }));
  const root = mkdtempSync(join(tmpdir(), 'app-build-real-verify-'));
  try {
    const graphFile = join(import.meta.dir, '../../../plugins/elanous-app-build/graph/app-build.yaml');
    const state = await runGraph(graphFile, { input: { ask: 'Build library lending application', seedRequested: false,
      appSlug: 'library', artifactMetadata: { runtime: {
        startCommand: ['bun', 'backend/main.ts'], healthPath: '/health' } } },
    verifiedOwnerId: OWNER, quiet: true, deps: { root, capabilityProviders: registry } });
    expect(state.status).toBe('awaiting-approval');
    expect(state.pending?.nodeId).toBe('review-publish');
    expect(state.path.filter(node => node === 'verify-repair')).toHaveLength(2);
    expect(state.path).toContain('classify-verify');
    expect(state.path).toContain('repair-verification');
    expect(verifiedCalls).toHaveLength(4);
    const firstVerify = state.nodes.find(node => node.nodeId === 'verify-repair');
    expect(firstVerify?.output).toContain('BUILD_TESTS_EXHAUSTED');
    const failedOutput = JSON.parse(String(firstVerify?.output));
    expect(failedOutput.result.repairUsed).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
  passAfterGraphRepair = false;
  verifiedCalls.length = 0;
  const failedRoot = mkdtempSync(join(tmpdir(), 'app-build-real-verify-exhausted-'));
  try {
    const graphFile = join(import.meta.dir, '../../../plugins/elanous-app-build/graph/app-build.yaml');
    const state = await runGraph(graphFile, { input: { ask: 'Build library lending application', seedRequested: false,
      appSlug: 'library', artifactMetadata: { runtime: {
        startCommand: ['bun', 'backend/main.ts'], healthPath: '/health' } } },
    verifiedOwnerId: OWNER, quiet: true, deps: { root: failedRoot, capabilityProviders: registry } });
    expect(state.status).toBe('failed');
    expect(state.path.filter(node => node === 'verify-repair')).toHaveLength(2);
    expect(state.path.filter(node => node === 'classify-verify')).toHaveLength(2);
    expect(state.path).toContain('repair-verification');
    expect(state.path).not.toContain('materialize');
    expect(verifiedCalls).toHaveLength(6);
  } finally { rmSync(failedRoot, { recursive: true, force: true }); }
});
