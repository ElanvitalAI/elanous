import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import { main, measureGraphContractFlow, renderGraphContractFlow } from './graph-contract-flow.js';
import { defaultGraphsDir } from '../src/self-implement/graph-templates.js';

const graph = (nodes: string, edges: string, declarations = '') => `
graph_id: fixture
version: 1
entry_node: source
terminal_nodes: [sink]
${declarations}nodes:
${nodes}
edges:
${edges}
`;

const options = (files: Record<string, string>) => ({
  graphsDirectory: '/graphs',
  list: (path: string) => path === '/graphs' ? Object.keys(files).map((file) => file.replace('/graphs/', '')) : [],
  read: (path: string) => files[path]!,
});

type ParsedGraph = {
  graph_id: string;
  runner_inputs?: unknown;
  nodes: Array<{ call?: string; contract?: { inputs?: string[]; outputs?: string[] } }>;
};

function declaredRunnerInputs(graph: ParsedGraph, graphName: string): string[] {
  if (!Object.hasOwn(graph, 'runner_inputs')) throw new Error(`${graphName} must declare runner_inputs`);
  if (!Array.isArray(graph.runner_inputs)) throw new Error(`${graphName} runner_inputs must be an array`);
  return graph.runner_inputs.filter((input): input is string => typeof input === 'string');
}

const source = `  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [artifact] }`;

const sink = `  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [artifact], tools: read-only, outputs: [result] }`;

/** 계약 흐름 단언의 «기준» 그래프 — 자기 자신과 견주는 것은 공허하므로 대상에서 뺀다. */
const REFERENCE_GRAPH = 'implement-loop.yaml';

/**
 * ⛔ 「계약이 하나도 없는」 그래프 — 이름과 «이유»를 같이 둔다.
 * ⚠️ 이것은 면죄부가 아니라 «빚 목록»이다. 아래 시험이 이 목록을 실물과 대조하므로,
 *    계약이 붙는 순간 «빨강»이 되어 여기서 지우라고 말한다(스스로 은퇴하는 면제).
 */
const CONTRACTLESS_EXEMPT: Record<string, string> = {
  'plan-loop.yaml': '노드 4개 «전부» contract 가 없다 — 계약이 서면 이 줄을 지운다',
};

describe('graph-contract-flow', () => {
  test('measures a reachable producer as a satisfied input while retaining the external entry input', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`${source}\n${sink}`, '  - from: source\n    to: sink'),
    }));

    expect(measurement).toMatchObject({
      scannedFiles: 1, graphs: 1, nodes: 2, contractNodes: 2, nodesWithoutContract: 0,
      emptyToolContracts: 0, declaredInputs: 2, declaredOutputs: 2, satisfiedInputs: 1,
      externalInputs: 1, disconnectedProducerInputs: 0, unreadableFiles: 0,
    });
    expect(measurement.gaps).toEqual([{ graphId: 'fixture', nodeId: 'source', input: 'request', kind: 'external-input' }]);
    expect(measurement.contractNodesByGraph).toEqual({ fixture: 2 });
    expect(renderGraphContractFlow(measurement)).toContain('satisfied inputs 1');
  });

  test('breaks external inputs down by cross-graph producer availability without changing their total', () => {
    const producer = (graphId: string, output: string) => graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [${output}] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink').replace('graph_id: fixture', `graph_id: ${graphId}`);
    const consumer = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [exact-artifact, changed-files, runtime-value], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink');
    const measurement = measureGraphContractFlow(options({
      '/graphs/consumer.yaml': consumer,
      '/graphs/exact-producer.yaml': producer('exact-producer', 'exact-artifact'),
      '/graphs/normalized-producer.yaml': producer('normalized-producer', 'changed_files'),
    }));

    expect(measurement).toMatchObject({
      declaredInputs: 3, satisfiedInputs: 0, externalInputs: 3,
      externalInputsWithExactNameProducer: 1,
      externalInputsWithNormalizedNameProducer: 1,
      externalInputsWithNoProducer: 1,
      disconnectedProducerInputs: 0, firstRoundUndefinedInputs: 0,
      pathDependentInputs: 0, unmeasuredInputs: 0,
    });
    expect(
      measurement.externalInputsWithExactNameProducer
      + measurement.externalInputsWithNormalizedNameProducer
      + measurement.externalInputsWithNoProducer,
    ).toBe(measurement.externalInputs);
    expect(measurement.gaps).toEqual([
      { graphId: 'fixture', nodeId: 'source', input: 'changed-files', kind: 'external-input' },
      { graphId: 'fixture', nodeId: 'source', input: 'exact-artifact', kind: 'external-input' },
      { graphId: 'fixture', nodeId: 'source', input: 'runtime-value', kind: 'external-input' },
    ]);
    expect(renderGraphContractFlow(measurement)).toContain('external inputs 3 · external inputs with exact-name producer 1 · external inputs with normalized-spelling producer 1 · external inputs with no producer 1');
  });

  test('breaks no-producer external inputs down by each graph state declaration', () => {
    const stateful = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [declared-state, undeclared-state], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink', 'state: [declared-state]\n').replace('graph_id: fixture', 'graph_id: stateful');
    const control = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [control-input], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink').replace('graph_id: fixture', 'graph_id: control');
    const measurement = measureGraphContractFlow(options({
      '/graphs/stateful.yaml': stateful,
      '/graphs/control.yaml': control,
    }));

    expect(measurement).toMatchObject({
      graphs: 2,
      graphsWithDeclaredState: 1,
      externalInputs: 3,
      externalInputsWithExactNameProducer: 0,
      externalInputsWithNormalizedNameProducer: 0,
      externalInputsWithNoProducer: 3,
      externalInputsWithNoProducerDeclaredByGraphState: 1,
    });
    expect(measurement.externalInputsWithNoProducerDeclaredByGraphState)
      .toBeLessThanOrEqual(measurement.externalInputsWithNoProducer);
    expect(
      measurement.externalInputsWithExactNameProducer
      + measurement.externalInputsWithNormalizedNameProducer
      + measurement.externalInputsWithNoProducer,
    ).toBe(measurement.externalInputs);
    expect(renderGraphContractFlow(measurement)).toContain('graphs with declared state 1');
    expect(renderGraphContractFlow(measurement)).toContain('no-producer external inputs declared by graph state 1');
  });

  test('reports no declared-state graphs and no state matches for a graph without state', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/control.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [control-input], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink').replace('graph_id: fixture', 'graph_id: control'),
    }));

    expect(measurement).toMatchObject({
      graphs: 1,
      graphsWithDeclaredState: 0,
      externalInputsWithNoProducer: 1,
      externalInputsWithNoProducerDeclaredByGraphState: 0,
    });
  });

  test('counts an empty state declaration separately from state input matches', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/empty-state.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [undeclared-input], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink', 'state: []\n').replace('graph_id: fixture', 'graph_id: empty-state'),
    }));

    expect(measurement).toMatchObject({
      graphs: 1,
      graphsWithDeclaredState: 1,
      externalInputsWithNoProducer: 1,
      externalInputsWithNoProducerDeclaredByGraphState: 0,
    });
  });

  test('breaks no-producer external inputs down by runner declarations without changing existing totals', () => {
    const runnerDeclared = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [runner-value, undeclared-value], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink', 'runner_inputs: [runner-value]\n').replace('graph_id: fixture', 'graph_id: runner-declared');
    const control = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [control-value], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink').replace('graph_id: fixture', 'graph_id: control');
    const measurement = measureGraphContractFlow(options({
      '/graphs/runner-declared.yaml': runnerDeclared,
      '/graphs/control.yaml': control,
    }));

    expect(measurement).toMatchObject({
      graphs: 2,
      graphsWithDeclaredRunnerInputs: 1,
      externalInputs: 3,
      externalInputsWithNoProducer: 3,
      externalInputsWithNoProducerDeclaredByRunner: 1,
      externalInputsWithNoProducerUndeclaredByRunner: 2,
      runnerInputsProducedBySameGraph: 0,
    });
    expect(
      measurement.externalInputsWithNoProducerDeclaredByRunner
      + measurement.externalInputsWithNoProducerUndeclaredByRunner,
    ).toBe(measurement.externalInputsWithNoProducer);
    expect(renderGraphContractFlow(measurement)).toContain('graphs with declared runner inputs 1');
    expect(renderGraphContractFlow(measurement)).toContain('no-producer external inputs declared by runner 1 · no-producer external inputs undeclared by runner 2');
  });

  test('reports an empty runner declaration and a runner declaration that the same graph produces', () => {
    const empty = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [external-value], tools: read-only, outputs: [self-produced] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink', 'runner_inputs: [self-produced]\n').replace('graph_id: fixture', 'graph_id: self-producer');
    const emptyDeclaration = graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [undeclared-value], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink', 'runner_inputs: []\n').replace('graph_id: fixture', 'graph_id: empty-runner');
    const measurement = measureGraphContractFlow(options({
      '/graphs/self-producer.yaml': empty,
      '/graphs/empty-runner.yaml': emptyDeclaration,
    }));

    expect(measurement).toMatchObject({
      graphsWithDeclaredRunnerInputs: 2,
      externalInputsWithNoProducer: 2,
      externalInputsWithNoProducerDeclaredByRunner: 0,
      externalInputsWithNoProducerUndeclaredByRunner: 2,
      runnerInputsProducedBySameGraph: 1,
    });
    expect(renderGraphContractFlow(measurement)).toContain('runner inputs produced by same graph 1');
  });

  test('differentially classifies a declared producer outside the consumer flow as disconnected', () => {
    const baseline = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`${source}\n${sink}`, '  - from: source\n    to: sink'),
    }));
    const changed = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`${source}\n${sink}`, '  - from: sink\n    to: source'),
    }));

    expect(baseline.disconnectedProducerInputs).toBe(0);
    expect(changed).toMatchObject({ satisfiedInputs: 0, externalInputs: 1, disconnectedProducerInputs: 1 });
    expect(changed.gapsByGraph).toEqual({ fixture: 2 });
    expect(changed.gapsByInput).toEqual({ artifact: 1, request: 1 });
    expect(changed.gaps).toContainEqual({ graphId: 'fixture', nodeId: 'sink', input: 'artifact', kind: 'disconnected-producer' });
  });

  test('keeps parser-invalid and unreadable graph files distinct from zero contract flow', () => {
    const invalid = measureGraphContractFlow(options({ '/graphs/invalid.yaml': 'graph_id: invalid' }));
    const unreadable = measureGraphContractFlow({
      graphsDirectory: '/graphs',
      list: (path) => path === '/graphs' ? ['missing.yaml'] : [],
      read: () => { throw new Error('missing'); },
    });

    expect(invalid).toMatchObject({ scannedFiles: 1, graphs: 0, contractNodes: 0, unreadableFiles: 1 });
    expect(unreadable).toMatchObject({ scannedFiles: 1, graphs: 0, contractNodes: 0, unreadableFiles: 1 });
  });

  test('keeps a normally empty graph directory distinct from a directory listing failure', () => {
    const empty = measureGraphContractFlow({ graphsDirectory: '/graphs', list: () => [], read: () => '' });

    expect(empty).toMatchObject({ scannedFiles: 0, graphs: 0, unreadableFiles: 0 });
    expect(() => measureGraphContractFlow({
      graphsDirectory: '/graphs',
      list: () => { throw new Error('cannot list graphs'); },
      read: () => '',
    })).toThrow('cannot list graphs');
  });

  test('rejects a missing runner declaration instead of treating it as an empty declaration', () => {
    expect(() => declaredRunnerInputs({ graph_id: 'ad-loop', nodes: [] }, 'ad-loop.yaml'))
      .toThrow('ad-loop.yaml must declare runner_inputs');
  });

  test('keeps every target runner declaration equal to shared or called-unit entry inputs', async () => {
    const sources = new Map<string, string>();
    for (const graphName of await Array.fromAsync(new Bun.Glob('*.yaml').scan({ cwd: defaultGraphsDir() }))) {
      sources.set(graphName, await Bun.file(`${defaultGraphsDir()}/${graphName}`).text());
    }
    // ⛔ 대상을 «박아 두지» 않는다 — 읽기는 glob 인데 단언만 손목록이면
    //    새 그래프가 «조용히» 단언을 빠져나간다(2026-09-22 실측: plan-loop 이 그렇게 빠져 있었다).
    //    ⇒ 읽은 것에서 «이름 있는 면제»만 뺀다.
    const targetGraphs = [...sources.keys()]
      .filter((name) => name !== REFERENCE_GRAPH && !Object.hasOwn(CONTRACTLESS_EXEMPT, name))
      .sort();
    const parsed = new Map([...sources].map(([graphName, source]) => [
      graphName,
      parseDocument(source).toJS() as ParsedGraph,
    ]));
    const implementInputs = new Set(declaredRunnerInputs(parsed.get('implement-loop.yaml')!, 'implement-loop.yaml'));
    for (const graphName of targetGraphs) {
      const graph = parsed.get(graphName)!;
      const actual = declaredRunnerInputs(graph, graphName);
      const otherOutputs = new Set([...parsed]
        .filter(([, other]) => other.graph_id !== graph.graph_id)
        .flatMap(([, other]) => other.nodes.flatMap(node => node.contract?.outputs ?? [])));
      const normalizedOtherOutputs = new Set([...otherOutputs].map(name => name.replace(/[-_]/g, '').toLowerCase()));
      const consumedInputs = new Set(graph.nodes.flatMap(node => node.contract?.inputs ?? []));
      const consumedNoProducerInputs = new Set([...consumedInputs]
        .filter(input => !otherOutputs.has(input) && !normalizedOtherOutputs.has(input.replace(/[-_]/g, '').toLowerCase())));
      // The common runner surface comes from implement-loop. A called unit may
      // also require graph-specific entry inputs (recover@1: ask/context/prior).
      // Keep unrelated no-producer ad-loop inputs outside this runner contract.
      const calledUnitInputs = new Set(graph.nodes
        .filter(node => node.call)
        .flatMap(node => node.contract?.inputs ?? []));
      // A value produced by another graph can still be part of the shared runner
      // contract (for example, `worktree`). Preserve those common inputs while
      // keeping graph-specific called-unit inputs limited to true entry inputs.
      const expected = [...consumedInputs]
        .filter(input => implementInputs.has(input) || (consumedNoProducerInputs.has(input) && calledUnitInputs.has(input)))
        .sort();
      expect([...actual].sort(), graphName).toEqual(expected);
    }

    const measurement = measureGraphContractFlow({ graphsDirectory: defaultGraphsDir() });
    const runnerOutputOverlaps = [...parsed].flatMap(([graphName, graph]) => {
      if (!Object.hasOwn(graph, 'runner_inputs')) return [];
      const outputs = new Set(graph.nodes.flatMap(node => node.contract?.outputs ?? []));
      return declaredRunnerInputs(graph, graphName)
        .filter(input => outputs.has(input))
        .map(input => `${graph.graph_id}:${input}`);
    });
    // `worktree` enters research-loop from the shared runner, then cleanup and
    // pr-head-checkout return its updated value. Keep that intentional overlap
    // explicit so unrelated runner/output collisions still fail this contract.
    expect(runnerOutputOverlaps).toEqual(['research-loop:worktree']);
    expect(measurement.runnerInputsProducedBySameGraph).toBe(runnerOutputOverlaps.length);
  });


  test('measures the repository graphs through the wired CLI without failing on warnings', () => {
    const measurement = measureGraphContractFlow({ graphsDirectory: defaultGraphsDir() });
    const warn = console.warn;
    const log = console.log;
    const output: string[] = [];
    console.warn = (line: string) => output.push(line);
    console.log = (line: string) => output.push(line);
    try {
      expect(main()).toBe(0);
    } finally {
      console.warn = warn;
      console.log = log;
    }

    for (const value of [
      measurement.scannedFiles,
      measurement.graphs,
      measurement.nodes,
      measurement.contractNodes,
      measurement.declaredInputs,
      measurement.declaredOutputs,
    ]) expect(value).toBeGreaterThan(0);
    expect(measurement.externalInputs + measurement.disconnectedProducerInputs).toBeGreaterThan(0);
    expect(output).toContain(renderGraphContractFlow(measurement));
  });

  test('counts and renders graph IDs and inputs that shadow object prototype names', () => {
    const special = (graphId: string, input: string) => graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [${input}] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [${input}], tools: read-only, outputs: [] }`, '  - from: sink\n    to: source').replace('graph_id: fixture', `graph_id: ${graphId}`);
    const measurement = measureGraphContractFlow(options({
      '/graphs/constructor.yaml': special('constructor', 'constructor'),
      '/graphs/to-string.yaml': special('toString', 'toString'),
      '/graphs/proto.yaml': special('__proto__', '__proto__'),
    }));

    for (const graphId of ['constructor', 'toString', '__proto__']) {
      expect(measurement.contractNodesByGraph[graphId]).toBe(2);
      expect(measurement.gapsByGraph[graphId]).toBe(1);
      expect(measurement.gapsByInput[graphId]).toBe(1);
    }
    expect(renderGraphContractFlow(measurement)).toContain('contract nodes by graph __proto__ 2, constructor 2, toString 2');
    expect(renderGraphContractFlow(measurement)).toContain('gaps by input __proto__ 1, constructor 1, toString 1');
  });

  test('classifies a producer absent from one branch-to-merge path as path dependent', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: left
    kind: agent
    recipe: left
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [artifact] }
  - node_id: right
    kind: agent
    recipe: right
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [artifact], tools: read-only, outputs: [] }`, '  - from: source\n    to: left\n  - from: source\n    to: right\n  - from: left\n    to: sink\n  - from: right\n    to: sink'),
    }));

    expect(measurement).toMatchObject({ satisfiedInputs: 0, pathDependentInputs: 1, firstRoundUndefinedInputs: 0, unmeasuredInputs: 0 });
    expect(measurement.gaps).toEqual([{ graphId: 'fixture', nodeId: 'source', input: 'request', kind: 'external-input' }]);
    expect(renderGraphContractFlow(measurement)).toContain('path dependent inputs 1');
  });

  test('does not classify an entry-unreachable producer as first-round undefined without a returning edge', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: producer
    kind: agent
    recipe: producer
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [artifact] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [artifact], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink\n  - from: producer\n    to: sink'),
    }));

    expect(measurement).toMatchObject({ satisfiedInputs: 0, firstRoundUndefinedInputs: 0, pathDependentInputs: 0, unmeasuredInputs: 0, disconnectedProducerInputs: 1 });
    expect(measurement.gaps).toContainEqual({ graphId: 'fixture', nodeId: 'sink', input: 'artifact', kind: 'disconnected-producer' });
  });

  test('classifies a producer reachable only through a returning edge as first-round undefined', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: implement
    kind: agent
    recipe: implement
    max_visits: 1
    contract: { inputs: [artifact], tools: read-only, outputs: [] }
  - node_id: rework
    kind: agent
    recipe: rework
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [artifact] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: implement\n  - from: implement\n    to: rework\n  - from: rework\n    to: implement\n  - from: rework\n    to: sink'),
    }));

    expect(measurement).toMatchObject({ satisfiedInputs: 0, firstRoundUndefinedInputs: 1, pathDependentInputs: 0, unmeasuredInputs: 0 });
    expect(measurement.gaps).toEqual([{ graphId: 'fixture', nodeId: 'source', input: 'request', kind: 'external-input' }]);
    expect(renderGraphContractFlow(measurement)).toContain('first round undefined inputs 1');
  });

  test('classifies self output supplied only after a returning edge as first-round undefined', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: worker
    kind: agent
    recipe: worker
    max_visits: 2
    contract: { inputs: [artifact], tools: read-only, outputs: [artifact] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: worker\n  - from: worker\n    to: worker\n  - from: worker\n    to: sink'),
    }));

    expect(measurement).toMatchObject({
      satisfiedInputs: 0, firstRoundUndefinedInputs: 1, pathDependentInputs: 0,
      unmeasuredInputs: 0, disconnectedProducerInputs: 0,
    });
    expect(measurement.gaps).toEqual([{ graphId: 'fixture', nodeId: 'source', input: 'request', kind: 'external-input' }]);
  });

  test('classifies a producer that can reach the consumer only through a returning edge as first-round undefined', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: a
    kind: agent
    recipe: a
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }
  - node_id: producer
    kind: agent
    recipe: producer
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [artifact] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [artifact], tools: read-only, outputs: [] }`, '  - from: source\n    to: a\n  - from: a\n    to: sink\n  - from: a\n    to: producer\n  - from: producer\n    to: a'),
    }));

    expect(measurement).toMatchObject({
      satisfiedInputs: 0, firstRoundUndefinedInputs: 1, pathDependentInputs: 0,
      unmeasuredInputs: 0, disconnectedProducerInputs: 0,
    });
    expect(measurement.gaps).toEqual([{ graphId: 'fixture', nodeId: 'source', input: 'request', kind: 'external-input' }]);
  });

  test('keeps a self-producing worker disconnected when only an upstream node loops', () => {
    const measurement = measureGraphContractFlow(options({
      '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: a
    kind: agent
    recipe: a
    max_visits: 2
    contract: { inputs: [], tools: read-only, outputs: [] }
  - node_id: worker
    kind: agent
    recipe: worker
    max_visits: 2
    contract: { inputs: [artifact], tools: read-only, outputs: [artifact] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }`, '  - from: source\n    to: a\n  - from: a\n    to: a\n  - from: a\n    to: worker\n  - from: worker\n    to: sink'),
    }));

    expect(measurement).toMatchObject({
      satisfiedInputs: 0, firstRoundUndefinedInputs: 0, pathDependentInputs: 0,
      unmeasuredInputs: 0, disconnectedProducerInputs: 1,
    });
    expect(measurement.gaps).toContainEqual({ graphId: 'fixture', nodeId: 'worker', input: 'artifact', kind: 'disconnected-producer' });
  });

  test('classifies inputs beyond the static path limit as unmeasured', () => {
    const measurement = measureGraphContractFlow({
      ...options({
        '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [] }
  - node_id: left
    kind: agent
    recipe: left
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [artifact] }
  - node_id: right
    kind: agent
    recipe: right
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [artifact] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [artifact], tools: read-only, outputs: [] }`, '  - from: source\n    to: left\n  - from: source\n    to: right\n  - from: left\n    to: sink\n  - from: right\n    to: sink'),
      }),
      pathLimit: 1,
    });

    expect(measurement).toMatchObject({ satisfiedInputs: 0, firstRoundUndefinedInputs: 0, pathDependentInputs: 0, unmeasuredInputs: 1 });
    expect(measurement.gaps).toEqual([{ graphId: 'fixture', nodeId: 'source', input: 'request', kind: 'external-input' }]);
    expect(renderGraphContractFlow(measurement)).toContain('unmeasured inputs 1');
  });

  test('bounds off-target exploration and reports the consumer node once for multiple inputs', () => {
    const measurement = measureGraphContractFlow({
      ...options({
        '/graphs/fixture.yaml': graph(`  - node_id: source
    kind: agent
    recipe: source
    max_visits: 1
    contract: { inputs: [request], tools: read-only, outputs: [artifact, summary] }
  - node_id: branch-left
    kind: agent
    recipe: branch-left
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }
  - node_id: branch-right
    kind: agent
    recipe: branch-right
    max_visits: 1
    contract: { inputs: [], tools: read-only, outputs: [] }
  - node_id: sink
    kind: gate
    recipe: sink
    max_visits: 1
    contract: { inputs: [artifact, summary], tools: read-only, outputs: [] }`, '  - from: source\n    to: sink\n  - from: source\n    to: branch-left\n  - from: source\n    to: branch-right\n  - from: branch-left\n    to: branch-right\n  - from: branch-right\n    to: branch-left'),
      }),
      pathLimit: 1,
    });

    expect(measurement).toMatchObject({ satisfiedInputs: 0, unmeasuredInputs: 2, unmeasuredNodes: 1 });
    expect(renderGraphContractFlow(measurement)).toContain('unmeasured nodes 1');
  });

  test('계약 없는 그래프 목록이 «실물과 같다» — 빚이 늘거나 갚아지면 여기서 빨강이 난다', async () => {
    const measured: Record<string, number> = {};
    for (const graphName of await Array.fromAsync(new Bun.Glob('*.yaml').scan({ cwd: defaultGraphsDir() }))) {
      const graph = parseDocument(await Bun.file(`${defaultGraphsDir()}/${graphName}`).text()).toJS() as ParsedGraph;
      const withContract = graph.nodes.filter((node) => node.contract).length;
      if (withContract === 0) measured[graphName] = graph.nodes.length;
    }
    // ⛔ 수가 아니라 «이름 집합»으로 견준다 — 수만 맞고 대상이 바뀌는 것을 잡는다
    expect(Object.keys(measured).sort()).toEqual(Object.keys(CONTRACTLESS_EXEMPT).sort());
  });
});
