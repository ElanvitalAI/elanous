import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify } from 'yaml';
import { canonicalGraphJson, graphVersionHash, parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { evaluateGraphV2LoopStopWhen, lowerGraphV2 } from '../graph-v2/lower.js';
import { resolveGraphUnit } from '../self-implement/graph-unit-resolver.js';
import { withGraphProviderContextExtensions } from '../graph-runner/provider-context.js';
import { bindGraphV2StaticMapItem, decideGraphApproval, runGraph } from '../graph-runner/runner.js';
import { fanOutGraphSource } from '../graph-runner/runner-routing.js';
import { createGraphVariant } from '../self-implement/graph-variant.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const kaistGraph = `apiVersion: elanous.dev/graph/v2
graph: { id: absorb-brief, version: 1.0.0, layer: flow, purpose: brief, ext: { acme.graph: { experiment: 3 } } }
entry: collect
loop:
  root: coordinator
  parent: intake-daily
  stage: shadow
  trigger: { events: [scrap.shared], cron: '0 7 * * *' }
  ext: { acme.schedule: { timezone: Asia/Seoul } }
nodes:
  - id: collect
    type: store
    requires: store.read@1
    with: { op: list, collection: scraps, context: { request: keep, ext: { caller: { trace: yes } } } }
    ext: { acme.card: { color: blue } }
  - id: extract
    type: extract
    map: { over: '$collect.result.items', as: scrap, max_parallel: 4 }
    post: [result.text]
  - id: brief
    type: decide
    skill: absorb/brief
    uses: [llm-judge, store]
  - id: build
    call: absorb-dev-build@^1
    budget: { inner_steps: 20 }
    call_entry: start
edges:
  - { from: collect, to: extract, ext: { acme.edge: { weight: 2 } } }
  - { from: extract, on: outcome, map: { ok: brief, fail: failed } }
  - { from: brief, on: outcome, map: { done: build, rework: brief, needs-human: failed, failed: failed } }
  - { from: build, on: outcome, map: { done: done, failed: failed } }
terminal: [done, failed]
sims: [sims/absorb-demo-world.yaml]
`

test('GRAPH-V2-LOWER sim: KAIST document lowers through v1 GraphTemplateSpec and keeps ext at every layer', () => {
  const result = lowerGraphV2(kaistGraph, { label: 'absorb-brief.yaml', bundleExt: { 'acme.bundle': { revision: 2 } } });
  expect(result.errors).toEqual([]);
  expect(result.template).toBeDefined();
  const template = result.template!;
  expect(template).toMatchObject({ graphId: 'absorb-brief', version: 1, entryNode: 'collect',
    terminalNodes: ['done', 'failed'], loop: { root: 'coordinator', parent: 'intake-daily', stage: 'shadow',
      trigger: { cron: '0 7 * * *', events: ['scrap.shared'] }, ext: { 'acme.schedule': { timezone: 'Asia/Seoul' } } },
    ext: { 'acme.graph': { experiment: 3 } },
    v2: {},
  });
  expect(template.nodes.find(node => node.nodeId === 'collect')?.requires).toBe('store.read@1');
  expect(template.nodes.find(node => node.nodeId === 'collect')).toMatchObject({
    ext: { 'acme.card': { color: 'blue' } }, input: { context: { request: 'keep', ext: { caller: { trace: 'yes' }, bundle: { 'acme.bundle': { revision: 2 } }, graph: { 'acme.graph': { experiment: 3 } }, node: { 'acme.card': { color: 'blue' } } } } },
  });
  expect(template.edges[0]).toMatchObject({ ext: { 'acme.edge': { weight: 2 } } });
  expect(template.maxParallelNodes).toBe(4);
  expect(template.nodes.find(node => node.nodeId === 'extract')).toMatchObject({ kind: 'gate', recipe: 'none' });
  expect(template.edges.find(edge => edge.from === 'extract__map_fork')).toMatchObject({
    branches: { ok: ['extract__map_0', 'extract__map_1', 'extract__map_2', 'extract__map_3'] }, join: 'extract',
  });
  expect(template.nodes.find(node => node.nodeId === 'extract__map_0')).toMatchObject({
    kind: 'capability', recipe: 'none', requires: 'extract.item@1', contract: { outputs: ['result', 'evidence'] }, input: { __graphV2MapItem: {
      over: '$collect.result.items', as: 'scrap', index: 0, maxParallel: 4, // 출처: .rules/30-harness/testing-gates.md R-TST36 · src/graph-v2/lower.ts 정적 map 상한.
    } },
  });
  const revisitable = lowerGraphV2(kaistGraph.replace('id: extract\n    type: extract', 'id: extract\n    type: extract\n    max_visits: 3'));
  expect(revisitable.template?.nodes.filter(node => ['extract', 'extract__map_fork', 'extract__map_0'].includes(node.nodeId))
    .map(node => [node.nodeId, node.maxVisits])).toEqual([['extract', 3], ['extract__map_fork', 3], ['extract__map_0', 3]]);
  const mapChain = kaistGraph.replace('  - id: brief\n    type: decide',
    "  - id: summarize\n    type: extract\n    requires: extract.item@1\n    map: { over: '$extract.result.items', as: item, max_parallel: 4 }\n  - id: brief\n    type: decide");
  expect(lowerGraphV2(mapChain).errors).toEqual([]);
  expect(template.nodes.find(node => node.nodeId === 'brief')).toMatchObject({
    call: 'verb-decide@^1', contract: { outputs: ['result', 'evidence'] },
  });
  expect(template.nodes.find(node => node.nodeId === 'collect')?.requires).toBe('store.read@1');
  const brief = template.nodes.find(node => node.nodeId === 'brief')!;
  const briefUnit = resolveGraphUnit(brief.call!, join(process.cwd(), 'graph-v2-lower.yaml'));
  const briefInnerSteps = briefUnit.template.nodes.reduce((total, node) => total + (node.maxVisits ?? 0), 0);
  expect(brief.budget?.innerSteps).toBe(briefInnerSteps);
  const missingVerbExit = kaistGraph.replace('rework: brief, needs-human: failed, ', '');
  expect(lowerGraphV2(missingVerbExit).errors.some(issue => issue.path.endsWith('/exit-map'))).toBe(true);
  expect(template.nodes.find(node => node.nodeId === 'build')?.call).toBe('absorb-dev-build@^1');
  expect(result.bundleExt).toEqual({ 'acme.bundle': { revision: 2 } });
  expect(result.ledgerExtensions).toMatchObject({
    graphHash: graphVersionHash(template),
    ext: { graph: template.ext, nodes: { collect: { 'acme.card': { color: 'blue' } } },
      loop: template.loop?.ext,
      bundle: { 'acme.bundle': { revision: 2 } } },
  });
  expect(result.ledgerExtensions?.ext.edges).toHaveLength(4);
  expect(result.ledgerExtensions?.ext.edges[0]).toEqual({ index: 0, from: 'collect', ext: { 'acme.edge': { weight: 2 } } });
  expect(result.ledgerExtensions?.ext.edges[1]).toEqual({ index: 1, from: 'extract' });
  expect(canonicalGraphJson(template)).toContain('acme.graph');

  const legacy = parseGraphTemplateYaml(stringify({
    graph_id: template.graphId, version: template.version, entry_node: template.entryNode, terminal_nodes: template.terminalNodes,
    max_parallel_nodes: template.maxParallelNodes,
    nodes: template.nodes.map(node => ({ node_id: node.nodeId, kind: node.kind, recipe: node.recipe, max_visits: node.maxVisits,
      ...(node.call ? { call: node.call, call_entry: node.callEntry, budget: { inner_steps: node.budget?.innerSteps } } : {}),
      ...(node.contract ? { contract: node.contract } : {}),
      ...(node.hitl ? { hitl: node.hitl } : {}), ...(node.input === undefined ? {} : { input: node.input }) })),
    edges: template.edges.map(edge => ({ from: edge.from, ...(edge.to ? { to: edge.to } : {}),
      ...(edge.on ? { on: edge.on } : {}), ...(edge.map ? { map: edge.map } : {}),
      ...(edge.branches ? { branches: edge.branches, join: edge.join } : {}) })),
  }));
  expect(legacy.errors).toEqual([]);
  expect(legacy.template?.entryNode).toBe(template.entryNode);
  expect(legacy.template?.nodes.map(node => [node.nodeId, node.kind, node.recipe])).toEqual(template.nodes.map(node => [node.nodeId, node.kind, node.recipe]));
  expect(legacy.template?.edges.map(edge => [edge.from, edge.to, edge.on, edge.map, edge.branches, edge.join]))
    .toEqual(template.edges.map(edge => [edge.from, edge.to, edge.on, edge.map, edge.branches, edge.join]));

  const dir = mkdtempSync(join(tmpdir(), 'graph-v2-lower-check-'));
  try {
    const file = join(dir, 'lowered.yaml');
    writeFileSync(file, stringify({ graph_id: template.graphId, version: template.version, entry_node: template.entryNode,
      terminal_nodes: template.terminalNodes, max_parallel_nodes: template.maxParallelNodes, nodes: template.nodes.map(node => ({ node_id: node.nodeId, kind: node.kind,
        recipe: node.recipe, max_visits: node.maxVisits, ...(node.call ? { call: node.call, budget: { inner_steps: node.budget?.innerSteps } } : {}),
        ...(node.contract ? { contract: node.contract } : {}),
        ...(node.hitl ? { hitl: node.hitl } : {}), ...(node.input === undefined ? {} : { input: node.input }) })),
      edges: template.edges.map(edge => ({ from: edge.from, ...(edge.to ? { to: edge.to } : {}),
        ...(edge.on ? { on: edge.on } : {}), ...(edge.map ? { map: edge.map } : {}),
        ...(edge.branches ? { branches: edge.branches, join: edge.join } : {}) })),
    }));
    const checked = spawnSync('bun', ['scripts/check-graph-declaration.ts', file], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' });
    if (checked.status !== 0) throw new Error(`${checked.stdout}${checked.stderr}`);
    expect(checked.stdout).toContain('✅ 파싱됨');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GRAPH-V2-LOWER sim: capability lowering requires a declared contract and never emits legacy cap recipes', () => {
  const valid = lowerGraphV2(`apiVersion: elanous.dev/graph/v2
graph: { id: capability-requires-lowering, version: 1.0.0, layer: flow, purpose: contract lowering }
entry: read
nodes:
  - { id: read, type: store, requires: store.read@1, with: { op: list } }
edges:
  - { from: read, to: done }
terminal: [done]
`);
  expect(valid.errors).toEqual([]);
  expect(valid.template?.nodes.find(node => node.nodeId === 'read')).toMatchObject({
    kind: 'capability', recipe: 'none', requires: 'store.read@1',
  });

  const inferred = lowerGraphV2(`apiVersion: elanous.dev/graph/v2
graph: { id: capability-requires-inference, version: 1.0.0, layer: flow, purpose: infer store read contract }
entry: lookup-suggestion
nodes:
  - { id: lookup-suggestion, type: store, with: { op: get } }
edges:
  - { from: lookup-suggestion, to: done }
terminal: [done]
`);
  expect(inferred.errors).toEqual([]);
  expect(inferred.template?.nodes.find(node => node.nodeId === 'lookup-suggestion')).toMatchObject({
    kind: 'capability', recipe: 'none', requires: 'store.read@1',
  });

  const missing = lowerGraphV2(`apiVersion: elanous.dev/graph/v2
graph: { id: capability-requires-missing, version: 1.0.0, layer: flow, purpose: reject legacy fallback }
entry: read
nodes:
  - { id: read, type: cloud-resource, with: { action: provision } }
edges:
  - { from: read, to: done }
terminal: [done]
`);
  expect(missing.errors.some(issue => issue.path.endsWith('/nodes/0/requires') && /계약 id requires/.test(issue.message))).toBe(true);
  expect(missing.template).toBeUndefined();
});

test('GRAPH-V2-LOWER sim: extension lint blocks safety overrides and executable payload keys', () => {
  const unsafe = kaistGraph.replace('acme.graph: { experiment: 3 }', 'acme.cap: { value: L3 }');
  expect(lowerGraphV2(unsafe).errors.some(issue => issue.path.includes('/ext') && /cap|허용|금지/.test(issue.message))).toBe(true);
  const code = kaistGraph.replace('acme.graph: { experiment: 3 }', 'acme.scriptBody: echo unsafe');
  expect(lowerGraphV2(code).errors.some(issue => issue.path.includes('/ext') && /코드|실행|금지/.test(issue.message))).toBe(true);
  const bypass = kaistGraph.replace('acme.graph: { experiment: 3 }', 'acme.skip_gate: true');
  expect(lowerGraphV2(bypass).errors.some(issue => issue.path.includes('/ext'))).toBe(true);
  const nestedBypass = kaistGraph.replace('experiment: 3', 'cap_override: true');
  expect(lowerGraphV2(nestedBypass).errors.some(issue => issue.path.includes('/ext'))).toBe(true);
  const unsupportedPolicy = kaistGraph.replace('sims: [sims/absorb-demo-world.yaml]', 'policy: { require_review: true }\nsims: [sims/absorb-demo-world.yaml]');
  expect(lowerGraphV2(unsupportedPolicy).errors.some(issue => issue.path.endsWith('/policy') && /안전 거부/.test(issue.message))).toBe(true);
  const malformedPolicy = kaistGraph.replace('sims: [sims/absorb-demo-world.yaml]', 'policy: true\nsims: [sims/absorb-demo-world.yaml]');
  expect(lowerGraphV2(malformedPolicy).errors.some(issue => issue.path.endsWith('/policy') && /맵/.test(issue.message))).toBe(true);
  const unsupportedAuthority = kaistGraph.replace('stage: shadow', 'stage: shadow\n  authority: { hitl: true }');
  expect(lowerGraphV2(unsupportedAuthority).errors.some(issue => issue.path.endsWith('/loop/authority') && /안전 거부/.test(issue.message))).toBe(true);
  const mapReservedCollision = kaistGraph.replace('    type: extract\n    map:',
    '    type: extract\n    with: { __graphV2MapItem: { forged: true } }\n    map:');
  expect(lowerGraphV2(mapReservedCollision).errors.some(issue => issue.path.endsWith('/with/__graphV2MapItem'))).toBe(true);
  const capCall = kaistGraph.replace('type: store', 'type: store\n    call: verb-decide@^1');
  expect(lowerGraphV2(capCall).errors.some(issue => issue.path.endsWith('/call') && /capability/.test(issue.message))).toBe(true);
  const forcedAllow = kaistGraph.replace('experiment: 3', 'force_allow: true');
  expect(lowerGraphV2(forcedAllow).errors.some(issue => issue.path.includes('/ext'))).toBe(true);
  const executableString = kaistGraph.replace('experiment: 3', "payload: 'console.log(1)'");
  expect(lowerGraphV2(executableString).errors.some(issue => issue.path.includes('/ext'))).toBe(true);
  const unsupportedMap = kaistGraph.replace('max_parallel: 4', 'max_parallel: 4, future: true');
  expect(lowerGraphV2(unsupportedMap).errors.some(issue => issue.path.endsWith('/map'))).toBe(true);
  const defaultYes = `apiVersion: elanous.dev/graph/v2\ngraph: { id: unsafe-hitl-default, version: 1.0.0, layer: flow, purpose: choices }\nentry: gate\nnodes:\n  - id: gate\n    type: hitl\n    hitl:\n      options:\n        - { key: y, exit: ok, default: true }\n        - { key: N, exit: dismiss }\nedges:\n  - { from: gate, on: outcome, map: { ok: done, dismiss: failed } }\nterminal: [done, failed]\n`;
  expect(lowerGraphV2(defaultYes).errors.some(issue => /기본 N 거절/.test(issue.message))).toBe(true);
});

test('GRAPH-V2-LOWER sim: static branches bind actual items, skip empty slots, and reject overflow', () => {
  const sourceOutput = { result: { items: [{ id: 'a' }, { id: 'b' }] }, evidence: { source: 'fake-world' }, outcome: 'done' };
  const input = { request: 'kept', __graphV2MapItem: { over: '$collect.result.items', as: 'scrap', index: 1, maxParallel: 4 } }; // 출처: .rules/30-harness/testing-gates.md R-TST36 · src/graph-v2/lower.ts 정적 map 상한.
  expect(bindGraphV2StaticMapItem(input, { collect: sourceOutput })).toEqual({
    nodeInput: { request: 'kept', scrap: { id: 'b' }, mapIndex: 1, mapCount: 2 },
  });
  expect(bindGraphV2StaticMapItem({ ...input, __graphV2MapItem: { ...input.__graphV2MapItem, index: 3 } }, { collect: sourceOutput }))
    .toMatchObject({ skipped: { index: 3, count: 2 } });
  const overflowOutput = { result: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] } };
  expect(() => bindGraphV2StaticMapItem(input, { collect: overflowOutput })).toThrow(/bounded to 4/);
});

test('GRAPH-V2-LOWER sim: generated map branch excludes unrelated unit calls before exit-map validation', () => {
  const template = lowerGraphV2(kaistGraph).template!;
  const branch = fanOutGraphSource(kaistGraph, template, 'extract__map_0');
  expect(branch).toContain('id: extract__map_0');
  expect(branch).not.toContain('id: brief');
  expect(branch).not.toContain('id: build');
  expect(branch).not.toContain('call: absorb-dev-build@^1');
  const child = parseYaml(branch) as { edges: Array<{ from: string }> };
  expect(child.edges.map((edge) => edge.from)).toEqual(['extract__map_0']);
});

const capabilityRuntimePresent = existsSync(join(import.meta.dir, '../graph-runner/capabilities.ts'));
const graphV2RunnerIntegrationTest = capabilityRuntimePresent ? test : test.skip;
graphV2RunnerIntegrationTest('GRAPH-V2-LOWER sim: lowered KAIST §3c executes through #36131 CAP-KIND-MIN runGraph branches + join', async () => {
  const modulePath = '../graph-runner/' + 'capabilities.js';
  const capabilityRuntime = await import(modulePath) as {
    emptyGraphCapabilityRegistry: () => any;
    registerGraphCapabilityContract: (registry: any, contract: any) => any;
    registerGraphCapabilityProviderDeclaration: (registry: any, provider: any) => any;
  };
  for (const verb of ['decide', 'make', 'watch']) {
    const unit = resolveGraphUnit(`verb-${verb}@^1`, join(import.meta.dir, 'graph-v2-lower-sim.test.ts'));
    expect(unit.template.graphId).toBe(`verb-${verb}`);
    expect(unit.template.version).toBe(1);
  }
  const root = mkdtempSync(join(tmpdir(), 'graph-v2-capability-map-'));
  roots.push(root);
  const graphPath = join(root, 'graph.yaml');
  const graphSource = [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: absorb-brief-map-sim, version: 1.0.0, layer: flow, purpose: KAIST §3c static-map execution }',
    'entry: collect',
    'nodes:',
    '  - { id: collect, type: store, requires: store.read@1, with: { op: list, collection: scraps } }',
    "  - id: extract\n    type: extract\n    requires: extract.item@1\n    map: { over: '$collect.result.items', as: scrap, max_parallel: 4, partial: accept-with-gaps }", // 출처: .rules/30-harness/testing-gates.md R-TST36 · src/graph-v2/lower.ts 정적 map 상한.
    "  - id: summarize\n    type: extract\n    requires: extract.item@1\n    map: { over: '$extract.result.items', as: item, max_parallel: 4, partial: accept-with-gaps }",
    'edges:',
    '  - { from: collect, to: extract }',
    '  - { from: extract, on: outcome, map: { ok: summarize, fail: failed } }',
    '  - { from: summarize, on: outcome, map: { ok: done, fail: failed } }',
    'terminal: [done, failed]',
  ].join('\n') + '\n';
  writeFileSync(graphPath, graphSource);
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  let storedItems = [{ id: 'a' }, { id: 'b' }];
  let storeRequires: string | undefined;
  const observed: string[] = [];
  const observedIndices: number[] = [];
  const observedCounts: number[] = [];
  let providers = capabilityRuntime.emptyGraphCapabilityRegistry();
  providers = capabilityRuntime.registerGraphCapabilityContract(providers, { id: 'store.read@1', input: { type: 'object' },
    output: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } });
  providers = capabilityRuntime.registerGraphCapabilityContract(providers, { id: 'extract.item@1', input: { type: 'object' },
    output: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, items: { type: 'array' } } } });
  providers = capabilityRuntime.registerGraphCapabilityProviderDeclaration(providers, {
    id: 'fake-store', provides: ['store.read@1'], tier: 'free',
    invoke: (context: { requires?: string }) => {
      storeRequires = context.requires;
      return { ok: true, outcome: 'ok', result: { items: storedItems }, evidence: { count: storedItems.length } };
    },
  });
  providers = capabilityRuntime.registerGraphCapabilityProviderDeclaration(providers, {
    id: 'fake-extract', provides: ['extract.item@1'], tier: 'free',
    invoke: (context: { nodeInput?: unknown }) => {
      const input = context.nodeInput as { scrap?: { id: string }; item?: { id: string }; mapIndex?: number; mapCount?: number };
      const item = input.scrap ?? input.item;
      if (!item) throw new Error('runGraph did not bind the declared map item');
      const mappedId = input.scrap ? item.id : `${item.id}-x`;
      observed.push(mappedId);
      observedIndices.push(input.mapIndex!);
      observedCounts.push(input.mapCount!);
      return { ok: true, outcome: 'ok', result: { id: mappedId }, evidence: { source: 'fake-world' } };
    },
  });
  const state = await runGraph(graphPath, { quiet: true, input: {}, deps: { root: join(root, 'state'), capabilityProviders: providers } } as unknown as NonNullable<Parameters<typeof runGraph>[1]>);
  expect(state.status).toBe('done');
  expect(storeRequires).toBe('store.read@1');
  expect(JSON.parse(state.nodes.find(node => node.nodeId === 'collect')!.output as string)).toEqual({
    result: { items: storedItems }, evidence: { count: storedItems.length }, outcome: 'ok',
  });
  expect(JSON.parse(state.nodes.find(node => node.nodeId === 'extract')!.output as string).result.items)
    .toEqual([{ id: 'a' }, { id: 'b' }]);
  expect(JSON.parse(state.nodes.find(node => node.nodeId === 'summarize')!.output as string).result.items)
    .toEqual([{ id: 'a-x' }, { id: 'b-x' }]);
  expect(Object.values(state.fanOuts ?? {}).flatMap(fanout => Object.values(fanout.branches)).map(branch => branch.status))
    .toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done']);
  expect(observed.sort()).toEqual(['a', 'a-x', 'b', 'b-x']);
  expect(observedIndices.sort()).toEqual([0, 0, 1, 1]);
  expect(observedCounts).toEqual([2, 2, 2, 2]);
  const skippedOutputs = Object.values(state.fanOuts ?? {}).flatMap(fanout => Object.values(fanout.branches))
    .map(branch => typeof branch.output === 'string' ? JSON.parse(branch.output) : undefined)
    .filter(output => output?.evidence?.mapItemSkipped === true)
    .map(output => output.evidence.index).sort();
  expect(skippedOutputs).toEqual([2, 2, 3, 3]);
  storedItems = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const overflow = await runGraph(graphPath, { runId: 'map-overflow', quiet: true, input: {}, deps: { root: join(root, 'state'), capabilityProviders: providers } } as unknown as NonNullable<Parameters<typeof runGraph>[1]>);
  expect(overflow.status).toBe('failed');
  expect(observed).toHaveLength(4);
});

graphV2RunnerIntegrationTest('GRAPH-V2-LOWER sim: map join preserves declared unit exit outcomes for the parent route', async () => {
  const modulePath = '../graph-runner/' + 'capabilities.js';
  const capabilityRuntime = await import(modulePath) as {
    emptyGraphCapabilityRegistry: () => any;
    registerGraphCapabilityContract: (registry: any, contract: any) => any;
    registerGraphCapabilityProviderDeclaration: (registry: any, provider: any) => any;
  };
  const root = mkdtempSync(join(tmpdir(), 'graph-v2-map-join-exit-'));
  roots.push(root);
  const graphPath = join(root, 'graph.yaml');
  const graphSource = [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: map-join-exit-path-sim, version: 1.0.0, layer: flow, purpose: parent exit route }',
    'entry: collect',
    'nodes:',
    '  - { id: collect, type: store, requires: store.read@1 }',
    "  - id: card\n    type: extract\n    requires: extract.item@1\n    map: { over: '$collect.result.items', as: item, max_parallel: 2 }", // 출처: .rules/30-harness/testing-gates.md R-TST36 · src/graph-v2/lower.ts 정적 map 상한.
    'edges:',
    '  - { from: collect, to: card }',
    '  - { from: card, on: outcome, map: { done: done, rework: rework, needs-human: needs-human, failed: failed } }',
    'terminal: [done, rework, needs-human, failed]',
  ].join('\n') + '\n';
  writeFileSync(graphPath, graphSource);
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  let providers = capabilityRuntime.emptyGraphCapabilityRegistry();
  providers = capabilityRuntime.registerGraphCapabilityContract(providers, { id: 'store.read@1', input: { type: 'object' },
    output: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } });
  providers = capabilityRuntime.registerGraphCapabilityContract(providers, { id: 'extract.item@1', input: { type: 'object' },
    output: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } });
  providers = capabilityRuntime.registerGraphCapabilityProviderDeclaration(providers, {
    id: 'map-exit-store', provides: ['store.read@1'], tier: 'free',
    invoke: () => ({ ok: true, outcome: 'ok', result: { items: [{ id: 'a' }, { id: 'b' }] }, evidence: {} }),
  });
  providers = capabilityRuntime.registerGraphCapabilityProviderDeclaration(providers, {
    id: 'map-exit-card', provides: ['extract.item@1'], tier: 'free',
    invoke: (context: { nodeInput?: unknown }) => {
      const input = context.nodeInput as { item?: { id: string } };
      return { ok: true, outcome: 'done', result: { id: input.item?.id }, evidence: {} };
    },
  });
  const state = await runGraph(graphPath, { quiet: true, input: {}, deps: { root: join(root, 'state'), capabilityProviders: providers } } as unknown as NonNullable<Parameters<typeof runGraph>[1]>);
  expect(state.status).toBe('done');
  expect(state.path.at(-1)).toBe('done');
  const joinOutput = JSON.parse(state.nodes.find(node => node.nodeId === 'card')!.output as string);
  expect(joinOutput.outcome).toBe('done');
  expect(joinOutput.result.items).toEqual([{ id: 'a' }, { id: 'b' }]);
});

test('GRAPH-V2-LOWER sim: verb-make parent maps every unit exit and keeps an adequate inner-step budget', () => {
  const source = `apiVersion: elanous.dev/graph/v2
graph: { id: card-make-exit-map, version: 1.0.0, layer: flow, purpose: card stage }
entry: card
nodes:
  - { id: card, type: make }
edges:
  - { from: card, on: outcome, map: { done: done, rework: rework, needs-human: needs-human, failed: failed } }
terminal: [done, rework, needs-human, failed]
`;
  const lowered = lowerGraphV2(source);
  expect(lowered.errors).toEqual([]);
  const card = lowered.template!.nodes.find(node => node.nodeId === 'card')!;
  const makeUnit = resolveGraphUnit(card.call!, join(process.cwd(), 'graph-v2-lower.yaml'));
  expect(card.call).toBe('verb-make@^1');
  const declaredInnerSteps = makeUnit.template.nodes.reduce((total, node) => total + (node.maxVisits ?? 0), 0);
  expect(card.budget?.innerSteps).toBe(declaredInnerSteps);
  expect([...makeUnit.template.unit!.exits].sort()).toEqual(['done', 'failed', 'needs-human', 'rework']);
  expect(Object.keys(lowered.template!.edges.find(edge => edge.from === 'card')!.map!).sort())
    .toEqual([...makeUnit.template.unit!.exits].sort());
  const missingExit = lowerGraphV2(source.replace(', failed: failed', ''));
  expect(missingExit.errors.some(issue => issue.path.endsWith('/exit-map'))).toBe(true);
});

test('GRAPH-V2-LOWER sim: HITL choices lower declaratively to outcome exits', () => {
  const source = `apiVersion: elanous.dev/graph/v2
graph: { id: hitl-choice-contract, version: 1.0.0, layer: flow, purpose: human choice }
entry: approve
nodes:
  - id: approve
    type: hitl
    hitl:
      options:
        - { key: y, exit: ok }
        - { key: N, exit: dismiss, default: true }
edges:
  - { from: approve, on: outcome, map: { ok: done, dismiss: failed } }
terminal: [done, failed]
`;
  const withPolicy = source.replace('terminal: [done, failed]', 'terminal: [done, failed]\npolicy:\n  hitl: [approve]');
  const result = lowerGraphV2(withPolicy);
  expect(result.errors).toEqual([]);
  expect(result.template?.nodes.find(node => node.nodeId === 'approve')?.hitl).toEqual({
    options: [{ key: 'y', exit: 'ok' }, { key: 'N', exit: 'dismiss', default: true }],
  });
  const mismatchPolicy = withPolicy.replace('hitl: [approve]', 'hitl: [other]');
  expect(lowerGraphV2(mismatchPolicy).errors.some(issue => /policy.hitl/.test(issue.message))).toBe(true);
  const mismatch = withPolicy.replace('dismiss: failed', 'nope: failed');
  expect(lowerGraphV2(mismatch).errors.some(issue => /HITL 선택지 exit/.test(issue.message))).toBe(true);
});

test('GRAPH-V2-LOWER sim: HITL approve and default choice select their declared graph exits', async () => {
  const lowered = lowerGraphV2(`apiVersion: elanous.dev/graph/v2
graph: { id: hitl-choice-runner, version: 1.0.0, layer: flow, purpose: choice mapping }
entry: approve
nodes:
  - id: approve
    type: hitl
    hitl:
      options:
        - { key: y, exit: ok }
        - { key: N, exit: dismiss, default: true }
edges:
  - { from: approve, on: outcome, map: { ok: done, dismiss: failed } }
terminal: [done, failed]
`);
  expect(lowered.errors).toEqual([]);
  const template = lowered.template!;
  const root = mkdtempSync(join(tmpdir(), 'graph-v2-hitl-choice-'));
  try {
    const graphPath = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graphPath, stringify({ graph_id: template.graphId, version: template.version, entry_node: template.entryNode,
      terminal_nodes: template.terminalNodes, nodes: template.nodes.map(node => ({ node_id: node.nodeId, kind: node.kind,
        recipe: node.recipe, max_visits: node.maxVisits, ...(node.hitl ? { hitl: node.hitl } : {}) })),
      edges: template.edges.map(edge => ({ from: edge.from, ...(edge.on ? { on: edge.on } : {}), ...(edge.map ? { map: edge.map } : {}) })) }));
    for (const [runId, decision, expectedPath, expectedOutcome, expectedChoice] of [
      ['choice-approve', 'approved', ['approve', 'done'], 'ok', 'y'],
      ['choice-dismiss', 'rejected', ['approve', 'failed'], 'dismiss', 'N'],
    ] as const) {
      const pending = await runGraph(graphPath, { runId, quiet: true, deps: { root } });
      expect(pending.status).toBe('awaiting-approval');
      decideGraphApproval(template.graphId, runId, decision, 'sim', root);
      const resumed = await runGraph(graphPath, { resumeRunId: runId, quiet: true, deps: { root } });
      expect([...resumed.path]).toEqual([...expectedPath]);
      expect(JSON.parse(resumed.nodes[0]!.output as string)).toMatchObject({ outcome: expectedOutcome, choice: expectedChoice });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GRAPH-V2-LOWER sim: loop stop_when evaluates the completed result and loop ledger only', () => {
  const source = `apiVersion: elanous.dev/graph/v2
graph: { id: loop-stop-condition, version: 1.0.0, layer: flow, purpose: stop condition }
entry: work
loop:
  trigger: { tick: 30m }
  stop_when: ["result.verdict.confidence >= 0.8", "budget.runs_exhausted"]
  budget: { runs_per_day: 20, wall: 2h }
nodes:
  - { id: work, type: gate }
edges:
  - { from: work, to: done }
terminal: [done]
`;
  const lowered = lowerGraphV2(source);
  expect(lowered.errors).toEqual([]);
  expect(lowered.template?.v2?.loop).toEqual({
    stopWhen: ['result.verdict.confidence >= 0.8', 'budget.runs_exhausted'],
    budget: { runs_per_day: 20, wall: '2h' },
  });
  expect(lowered.template?.loop?.stopWhen).toBeUndefined();
  expect(lowered.template?.allowance).toBeUndefined();
  expect(evaluateGraphV2LoopStopWhen(lowered.template!.v2!.loop!.stopWhen!, {
    verdict: { confidence: 0.85 },
  }, { runs_exhausted: false })).toBe('stop');
  expect(evaluateGraphV2LoopStopWhen(lowered.template!.v2!.loop!.stopWhen!, {
    verdict: { confidence: 0.4 },
  }, { runs_exhausted: false })).toBe('continue');
  expect(evaluateGraphV2LoopStopWhen(lowered.template!.v2!.loop!.stopWhen!, {
    verdict: {},
  }, {})).toBe('unknown');
  const oldUnitBudget = source.replace('runs_per_day: 20, wall: 2h', 'inner_steps: 2');
  expect(lowerGraphV2(oldUnitBudget).errors.some(issue => issue.path.endsWith('/loop/budget'))).toBe(true);
});

test('GRAPH-V2-LOWER sim: unsupported execution restrictions fail closed', () => {
  const restricted = [
    kaistGraph.replace('entry: collect', 'cap: L1\nentry: collect'),
    kaistGraph.replace('    type: store', '    type: store\n    cap: L0'),
    kaistGraph.replace('sims: [sims/absorb-demo-world.yaml]', 'allow: { skills: [absorb/*] }\nsims: [sims/absorb-demo-world.yaml]'),
    kaistGraph.replace('sims: [sims/absorb-demo-world.yaml]', 'policy:\n  hitl: [approve-suggestion]\nsims: [sims/absorb-demo-world.yaml]'),
    kaistGraph.replace('sims: [sims/absorb-demo-world.yaml]', 'policy:\n  forbid_recipes: [hq-repo-write]\nsims: [sims/absorb-demo-world.yaml]'),
  ];
  expect(lowerGraphV2(restricted[0]!).errors.some(issue => /강제되지 않아 안전 거부/.test(issue.message))).toBe(true);
  expect(lowerGraphV2(restricted[1]!).errors.some(issue => /강제되지 않아 안전 거부/.test(issue.message))).toBe(true);
  expect(lowerGraphV2(restricted[2]!).errors.some(issue => /강제되지 않아 안전 거부/.test(issue.message))).toBe(true);
  expect(lowerGraphV2(restricted[3]!).errors.some(issue => /policy.hitl/.test(issue.message))).toBe(true);
  expect(lowerGraphV2(restricted[4]!).errors.some(issue => /강제되지 않아 안전 거부/.test(issue.message))).toBe(true);
  const collision = kaistGraph.replace('with: { op: list', 'with: { type: overwritten, op: list');
  expect(lowerGraphV2(collision).errors.some(issue => issue.path.endsWith('/with/type'))).toBe(true);
});
test('GRAPH-V2-LOWER sim: unmapped source fields survive inside a source namespace', () => {
  const imported = kaistGraph.replace('purpose: brief, ext:', 'purpose: brief, futureHeadField: { kept: true }, ext:')
    .replace('type: store\n    requires:', 'type: store\n    futureNodeField: [a, b]\n    requires:')
    .replace('sims: [sims/absorb-demo-world.yaml]', 'sims: [sims/absorb-demo-world.yaml]\nadaptive: { revision: run-local }\norigin: { format: n8n }\nfutureRootField: { raw: 9 }');
  const result = lowerGraphV2(imported, { sourceNamespace: 'n8n' });
  expect(result.errors).toEqual([]);
  expect(result.bundleExt?.['n8n.unmapped']).toEqual({ adaptive: { revision: 'run-local' }, origin: { format: 'n8n' }, futureRootField: { raw: 9 } });
  expect(result.template?.ext?.['n8n.unmapped']).toEqual({ futureHeadField: { kept: true } });
  expect(result.template?.nodes.find(node => node.nodeId === 'collect')?.ext?.['n8n.unmapped'])
    .toEqual({ futureNodeField: ['a', 'b'] });
});



test('GRAPH-V2-LOWER sim: provider ext forwarding preserves caller context and all scoped maps', () => {
  const context = { request: 'keep', ext: { caller: { trace: 'yes' } } };
  const forwarded = withGraphProviderContextExtensions(context, {
    bundle: { 'acme.bundle': { revision: 2 } }, graph: { 'acme.graph': { experiment: 3 } },
    node: { 'acme.card': { color: 'blue' } }, edges: { 'edge-0': { 'acme.edge': { weight: 2 } } },
    loop: { 'acme.schedule': { timezone: 'Asia/Seoul' } }, policy: { 'acme.policy': { audit: true } },
  });
  expect(context).toEqual({ request: 'keep', ext: { caller: { trace: 'yes' } } });
  expect(() => withGraphProviderContextExtensions({ ext: { graph: { 'acme.graph': { left: 1, right: 2 } } } },
    { graph: { 'acme.graph': { right: 2, left: 1 } } })).not.toThrow();
  expect(forwarded).toEqual({ request: 'keep', ext: {
    caller: { trace: 'yes' }, bundle: { 'acme.bundle': { revision: 2 } }, graph: { 'acme.graph': { experiment: 3 } },
    node: { 'acme.card': { color: 'blue' } }, edges: { 'edge-0': { 'acme.edge': { weight: 2 } } },
    loop: { 'acme.schedule': { timezone: 'Asia/Seoul' } }, policy: { 'acme.policy': { audit: true } },
  } });
  expect(withGraphProviderContextExtensions('plain-context', { graph: { 'acme.graph': { version: 1 } } }))
    .toEqual({ value: 'plain-context', ext: { graph: { 'acme.graph': { version: 1 } } } });
  expect(() => withGraphProviderContextExtensions({ ext: { graph: { 'acme.graph': { version: 0 } } } },
    { graph: { 'acme.graph': { version: 1 } } })).toThrow('graph provider extension conflict: graph.acme.graph');
});



test('GRAPH-V2-LOWER sim: runGraph forwards ext to repeated unit calls without scope leakage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-v2-provider-call-'));
  try {
    const graphPath = join(root, 'graph.yaml');
    const units = join(root, 'units');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(units);
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(join(units, 'recipes.yaml'), '{}\n');
    writeFileSync(join(units, 'probe.yaml'), `graph_id: ext-probe
version: 1
entry_node: probe
terminal_nodes: [done, failed]
unit: { inputs: [context], outputs: [result, evidence], exits: [done, failed] }
nodes:
  - node_id: probe
    kind: agent
    recipe: handler:probe
    max_visits: 1
    contract: { inputs: [context], tools: read-only, outputs: [result, evidence] }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: observe, recipe: none, max_visits: 1 }
edges:
  - { from: probe, on: outcome, map: { done: done, failed: failed } }
`);
    const source = `apiVersion: elanous.dev/graph/v2
graph: { id: provider-ext-parent, version: 1.0.0, layer: flow, purpose: provider ext, ext: { acme.graph: { version: 1 } } }
ext: { acme.bundle: { version: 2 } }
entry: start
loop: { root: coordinator, trigger: { events: [probe] }, ext: { acme.loop: { retained: true } } }
policy: { ext: { acme.policy: { retained: true } } }
nodes:
  - { id: start, type: gate }
  - id: call
    type: decide
    call: ext-probe@^1
    budget: { inner_steps: 2 }
    contract: { inputs: [context], tools: read-only, outputs: [result, evidence] }
    ext: { acme.first: { retained: true } }
  - id: call-two
    type: decide
    call: ext-probe@^1
    budget: { inner_steps: 2 }
    contract: { inputs: [context], tools: read-only, outputs: [result, evidence] }
    ext: { acme.second: { retained: true } }
edges:
  - { from: start, to: call, ext: { acme.edge: { first: true } } }
  - { from: call, on: outcome, map: { done: call-two, failed: failed }, ext: { acme.edge: { second: true } } }
  - { from: call-two, on: outcome, map: { done: done, failed: failed } }
terminal: [done, failed]
`;
    writeFileSync(graphPath, source);
    const seen: unknown[] = [];
    const run = await runGraph(graphPath, { input: { context: { request: 'keep', ext: { caller: { trace: 'yes' } } } }, deps: {
      root,
      inProcessHandlers: { probe: async (context) => {
        seen.push(context.input);
        return { ok: true, outcome: 'done', result: { value: 'sim' }, evidence: { source: 'sim' } };
      } },
    } });
    expect(run.status).toBe('done');
    expect(seen).toHaveLength(2);
    for (const nodeId of ['call', 'call-two']) {
      const output = JSON.parse(run.nodes.find(node => node.nodeId === nodeId)!.output as string);
      expect(output).toMatchObject({ outcome: 'done', result: { value: 'sim' }, evidence: { source: 'sim' } });
      expect(['result', 'evidence']).toEqual(expect.arrayContaining(Object.keys(output).filter(key => key !== 'outcome')));
    }
    expect(seen[0]).toEqual({ context: { request: 'keep', graphNode: { type: 'decide' }, ext: {
      caller: { trace: 'yes' }, bundle: { 'acme.bundle': { version: 2 } }, graph: { 'acme.graph': { version: 1 } },
      node: { 'acme.first': { retained: true } }, edges: { 'edge-0': { 'acme.edge': { first: true } } },
      loop: { 'acme.loop': { retained: true } }, policy: { 'acme.policy': { retained: true } },
    } } });
    expect(seen[1]).toEqual({ context: { request: 'keep', graphNode: { type: 'decide' }, ext: {
      caller: { trace: 'yes' }, bundle: { 'acme.bundle': { version: 2 } }, graph: { 'acme.graph': { version: 1 } },
      node: { 'acme.second': { retained: true } }, edges: { 'edge-1': { 'acme.edge': { second: true } } },
      loop: { 'acme.loop': { retained: true } }, policy: { 'acme.policy': { retained: true } },
    } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GRAPH-V2-LOWER sim: existing runGraph accepts v2 through lowered IR and binds ext ledger to the variant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-v2-runner-lower-'));
  try {
    const graphPath = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const source = `apiVersion: elanous.dev/graph/v2
graph: { id: lower-runner-smoke, version: 1.0.0, layer: flow, purpose: sim, ext: { acme.graph: { retained: true } } }
entry: start
nodes: [{ id: start, type: gate }]
edges: [{ from: start, to: done }]
terminal: [done]
`;
    writeFileSync(graphPath, source);
    const plan = { maxVisits: { start: 2 } };
    const expected = createGraphVariant({ template: lowerGraphV2(source).template!, goal: 'g_abc123', plan });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const run = await runGraph(graphPath, { variant: { goal: 'g_abc123', plan }, deps: { root } });
    expect(run.status).toBe('done');
    expect(run.graphId).toBe('lower-runner-smoke');
    expect(run.path).toEqual(['start', 'done']);
    expect(run.graphExtensionLedger?.ext.graph).toEqual({ 'acme.graph': { retained: true } });
    expect(run.graphExtensionLedger?.graphHash).toBe(graphVersionHash(expected.template));
    expect(run.graphExtensionLedger?.graphHash).not.toBe(graphVersionHash(lowerGraphV2(source).template!));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
