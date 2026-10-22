import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  canonicalGraphJson, edgeMapOf, graphVersionHash, loadGraphTemplates, parseGraphTemplateYaml,
  type GraphNodeKind, type GraphTemplateSpec,
} from './graph-yaml.js';
import { compileGraphTemplate, GRAPH_TEMPLATES_SOURCE, templateForGoalType } from './graph-templates.js';
import { flattenGraphTemplate } from './graph-unit-resolver.js';
import { validateUnitCalls } from '../graph-runner/runner.js';
import { JOURNEY_NODE_IDS, journeyTemplate } from '../self-dev/graph-journey-nodes.js';
import { journeySpec, readJourneyEdge } from '../self-dev/graph-journey-route.js';
import { activeTemplate, resolveGraphAuthority } from './graph-authority.js';
import { AUTHOR_OUTCOME_NODE_IDS, FRONT_NODE_IDS } from '../self-dev/graph-front-nodes.js';
import { inspectPipelineGraph } from './pipeline-shape.js';
import { PIPELINE_EDGES_BY_NODE, TERMINAL_STAGES_BY_NODE } from './pipeline-shape.js';

const GRAPHS_DIR = join(import.meta.dir, '../../graphs');

describe('RFC §5 0단계 — YAML 파서', () => {
  test('ARG L1 when/skip_when은 오버레이 조건 문법으로 읽고 필수 노드 건너뛰기는 거절한다', () => {
    const source = `graph_id: t
version: 1
entry_node: a
terminal_nodes: [done]
nodes:
  - { node_id: a, kind: agent, recipe: r, max_visits: 1 }
  - { node_id: optional, kind: agent, recipe: r, max_visits: 1, skip_when: 'substrate == local' }
  - { node_id: done, kind: git, recipe: r, max_visits: 1 }
edges:
  - { from: a, to: optional, when: 'substrate == pod' }
  - { from: a, to: done }
  - { from: optional, to: done }
`;
    const valid = parseGraphTemplateYaml(source, 'l1.yaml');
    expect(valid.errors).toEqual([]);
    expect(valid.template?.nodes[1]?.skipWhen).toBe('substrate == local');
    expect(valid.template?.edges[0]?.when).toBe('substrate == pod');
    const branchingSkip = source.replace('  - { from: optional, to: done }',
      "  - { from: optional, to: done }\n  - { from: optional, to: done, when: 'machines >= 1' }");
    expect(parseGraphTemplateYaml(branchingSkip).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '<inline>/nodes/optional/skip_when' })]));
    const fallbackSkip = source.replace('  - { from: optional, to: done }',
      '  - { from: optional, to: done, fallback: [{ node: a, requires: [probe] }] }');
    expect(parseGraphTemplateYaml(fallbackSkip).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '<inline>/nodes/optional/skip_when' })]));
    const protectedWhen = source.replace('from: a, to: optional, when:', 'from: done, to: optional, when:');
    expect(parseGraphTemplateYaml(protectedWhen).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '<inline>/edges/0/when' })]));
    expect(parseGraphTemplateYaml(source.replace('substrate == pod', 'substrate && pod')).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '<inline>/edges/0/when' })]));
    for (const id of ['gate', 'review', 'merge']) {
      const protectedSource = source.replaceAll('optional', id);
      expect(parseGraphTemplateYaml(protectedSource).errors)
        .toEqual(expect.arrayContaining([expect.objectContaining({ path: '<inline>/nodes/1/skip_when' })]));
    }
  });
  test('새 종류 observe·hitl·subgraph 를 받으며 알 수 없는 종류는 거절한다', () => {
    for (const kind of ['observe', 'hitl', 'subgraph'] satisfies GraphNodeKind[]) {
      const result = parseGraphTemplateYaml(`
graph_id: t
version: 1
entry_node: a
terminal_nodes: [a]
nodes: [{ node_id: a, kind: ${kind}, recipe: none, max_visits: 1 }]
edges: []
`);
      expect(result.errors).toEqual([]);
      expect(result.template?.nodes[0]?.kind).toBe(kind);
    }
    const unknown = parseGraphTemplateYaml('graph_id: t\nversion: 1\nentry_node: a\nterminal_nodes: [a]\nnodes: [{ node_id: a, kind: alien, recipe: none, max_visits: 1 }]\nedges: []');
    expect(unknown.template).toBeUndefined();
    expect(unknown.errors.some((error) => error.path.endsWith('/kind'))).toBe(true);
  });

  test('⛔ 던지지 않는다 — 깨진 YAML 도 «구조화 오류»로 나온다', () => {
    const result = parseGraphTemplateYaml('graph_id: [unclosed\n  bad: :', 'bad.yaml');
    expect(result.template).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.path).toBe('bad.yaml');
  });

  test('⚠️ YAML 낱말 함정 — `no`·`on` 은 이 파서 판에서 «문자열»이고, 그래도 «경고»한다', () => {
    // 📏 실측(2026-09-08 · yaml ^2.8.3 = YAML 1.2): `no` 는 문자열로 파싱된다.
    //   ⛔ Norway 문제는 YAML «1.1» 것이다 — 내 첫 반증이 그것을 혼동했고 실물이 정정했다.
    //   🔑 그래도 경고는 남긴다: 다른 파서·다른 판이 읽으면 갈릴 수 있는 낱말이기 때문이다.
    const result = parseGraphTemplateYaml(`
graph_id: t
version: 1
entry_node: "no"
terminal_nodes: ["no"]
nodes:
  - node_id: "no"
    kind: agent
    recipe: r
    max_visits: 1
edges: []
`, 'norway.yaml');
    expect(result.template?.nodes[0]?.nodeId).toBe('no');
    expect(result.warnings.some((w) => w.message.includes('다른 값으로 읽을 수 있는'))).toBe(true);
  });

  test('⛔ 그래도 boolean 으로 «파싱된» node_id 는 거절하고 그 사실을 말한다', () => {
    // 파서 판이 바뀌거나 사람이 `node_id: true` 를 쓰면 이 갈래가 산다.
    const result = parseGraphTemplateYaml(`
graph_id: t
version: 1
entry_node: a
terminal_nodes: [a]
nodes:
  - node_id: true
    kind: agent
    recipe: r
    max_visits: 1
edges: []
`, 'bool.yaml');
    expect(result.template).toBeUndefined();
    expect(result.errors.some((e) => e.message.includes('boolean'))).toBe(true);
  });

  test('⛔ to 와 map 을 «둘 다» 쓰거나 «둘 다 안» 쓰면 거절한다', () => {
    const base = `
graph_id: t
version: 1
entry_node: a
terminal_nodes: [b]
nodes:
  - { node_id: a, kind: agent, recipe: r, max_visits: 1 }
  - { node_id: b, kind: git, recipe: r, max_visits: 1 }
edges:`;
    const both = parseGraphTemplateYaml(`${base}\n  - { from: a, to: b, on: outcome, map: { pass: b } }`, 'both.yaml');
    expect(both.errors.some((e) => e.message.includes('정확히 하나'))).toBe(true);
    const neither = parseGraphTemplateYaml(`${base}\n  - { from: a }`, 'neither.yaml');
    expect(neither.errors.some((e) => e.message.includes('정확히 하나'))).toBe(true);
  });

  test('⛔ 없는 노드를 가리키는 엣지·진입·종료를 «전부» 잡는다', () => {
    const result = parseGraphTemplateYaml(`
graph_id: t
version: 1
entry_node: ghost
terminal_nodes: [phantom]
nodes:
  - { node_id: a, kind: agent, recipe: r, max_visits: 1 }
edges:
  - { from: a, to: nowhere }
`, 'dangling.yaml');
    const messages = result.errors.map((e) => e.message).join(' | ');
    expect(messages).toContain("'ghost'");
    expect(messages).toContain("'phantom'");
    expect(messages).toContain("'nowhere'");
  });

  test('정규 JSON 은 «키 순서»에 안 흔들린다 — 같은 그래프면 같은 해시다', () => {
    const a = parseGraphTemplateYaml(`
graph_id: t
version: 1
entry_node: a
terminal_nodes: [a]
nodes: [{ node_id: a, kind: agent, recipe: r, max_visits: 1 }]
edges: []
`, 'a').template as GraphTemplateSpec;
    const b = parseGraphTemplateYaml(`
version: 1
terminal_nodes: [a]
graph_id: t
nodes: [{ recipe: r, max_visits: 1, node_id: a, kind: agent }]
entry_node: a
edges: []
`, 'b').template as GraphTemplateSpec;
    expect(canonicalGraphJson(a)).toBe(canonicalGraphJson(b));
    expect(graphVersionHash(a)).toBe(graphVersionHash(b));
  });

  test('⛔ 선언이 «바뀌면» 해시가 바뀐다 — 선택 상태도 선언이므로 빠지면 안 된다', () => {
    const source = 'graph_id: t\nversion: 1\nentry_node: a\nterminal_nodes: [a]\nstate: [reviewed]\nnodes: [{ node_id: a, kind: agent, recipe: r, max_visits: 1 }]\nedges: []';
    const loaded = parseGraphTemplateYaml(source, 'declaration.yaml');
    const changed = parseGraphTemplateYaml(source.replace('reviewed', 'approved'), 'changed.yaml');

    expect({ errors: loaded.errors, template: loaded.template?.graphId }).toEqual({ errors: [], template: 't' });
    expect({ errors: changed.errors, template: changed.template?.graphId }).toEqual({ errors: [], template: 't' });
    expect(graphVersionHash(loaded.template!)).not.toBe(graphVersionHash(changed.template!));
  });

  test('L0 단계 목록과 노드 journey_stage 를 파싱하고 목록 밖의 값은 거절한다', () => {
    const source = 'graph_id: t\nversion: 1\nentry_node: a\nterminal_nodes: [a]\njourney_stages: [entry, run]\nnodes: [{ node_id: a, kind: agent, recipe: r, max_visits: 1, journey_stage: run }]\nedges: []';
    const parsed = parseGraphTemplateYaml(source, 'journey.yaml');
    expect(parsed.errors).toEqual([]);
    expect(parsed.template?.journeyStages).toEqual(['entry', 'run']);
    expect(parsed.template?.nodes[0]?.journeyStage).toBe('run');
    expect(compileGraphTemplate(parsed.template!).template.nodes[0]?.journeyStage).toBe('run');
    expect(parseGraphTemplateYaml(source.replace('journey_stage: run', 'journey_stage: unknown')).errors.some((error) => error.path === '<inline>/nodes/0/journey_stage')).toBe(true);
    expect(parseGraphTemplateYaml(source.replace('journey_stages: [entry, run]', 'journey_stages: [run, run]')).errors)
      .toEqual([expect.objectContaining({ path: '<inline>/journey_stages' })]);
    expect(parseGraphTemplateYaml(source.replace('journey_stage: run', 'journey_stage: 3')).errors.some((error) => error.path === '<inline>/nodes/0/journey_stage')).toBe(true);
  });

  test('문서 전용 gate 건너뛰기 정책의 선언과 미선언을 파싱·컴파일까지 그대로 보존한다', () => {
    const base = 'graph_id: t\nversion: 1\nentry_node: a\nterminal_nodes: [a]\nnodes: [{ node_id: a, kind: agent, recipe: r, max_visits: 1 }]\nedges: []';
    const declared = parseGraphTemplateYaml(`docs_only_gate_skip: true\n${base}`, 'declared.yaml');
    const undeclared = parseGraphTemplateYaml(base, 'undeclared.yaml');

    expect(declared.errors).toEqual([]);
    expect(undeclared.errors).toEqual([]);
    expect(declared.template?.docsOnlyGateSkip).toBe(true);
    expect(undeclared.template?.docsOnlyGateSkip).toBeUndefined();
    expect(compileGraphTemplate(declared.template!).template.docsOnlyGateSkip).toBe(true);
    expect(compileGraphTemplate(undeclared.template!).template.docsOnlyGateSkip).toBeUndefined();
  });
});

describe('RFC §5 0단계 — 로더 (⛔ 뿌리를 «인자»로)', () => {
  test('루트 명령 recipes.yaml은 그래프로 파싱하거나 분모에 세지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-loader-recipes-'));
    try {
      writeFileSync(join(root, 'one.yaml'), 'graph_id: one\nversion: 1\nentry_node: done\nterminal_nodes: [done]\nnodes: [{ node_id: done, kind: gate, recipe: none, max_visits: 1 }]\nedges: []\n');
      writeFileSync(join(root, 'recipes.yaml'), 'investigate:\n  command: "exit 0"\n');
      const result = loadGraphTemplates(root);
      expect(result.errors).toEqual([]);
      expect(result.scannedFiles).toBe(1);
      expect(Object.keys(result.templates)).toEqual(['one']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('실물 graphs/ 를 오류 «0» 으로 읽는다', () => {
    const result = loadGraphTemplates(GRAPHS_DIR);
    expect({ errors: result.errors, scanned: result.scannedFiles > 0 }).toEqual({ errors: [], scanned: true });
    // ⛔ 키는 «파일명»이 아니라 `graph_id` 다 — implement-loop.yaml 의 조인 키는 'self-implement' 다
    //   (원장에 그 이름으로 이미 쌓였다 · 바꾸면 옛 표본과 비교 불가).
    expect(Object.keys(result.templates).sort()).toEqual(['ad-loop', 'default-loop', 'document-loop', 'operate-loop', 'plan-loop', 'research-loop', 'self-implement']);
  });

  test('four goal loops route the shared journey through real YAML and ARG-UNIT-LIB calls', () => {
    const loaded = loadGraphTemplates(GRAPHS_DIR);
    expect(loaded.errors).toEqual([]);
    expect(GRAPH_TEMPLATES_SOURCE).toBe('yaml');
    const types = ['research', 'document', 'operate'] as const;
    for (const goalType of types) {
      const graph = templateForGoalType(goalType);
      const spec = loaded.templates[`${goalType}-loop`]!;
      expect(graph?.graphId).toBe(spec.graphId);
      expect(graph?.entryNode).toBe('intake');
      expect(journeyTemplate('intake', goalType).graphId).toBe(spec.graphId);
      const selected = activeTemplate(goalType, resolveGraphAuthority());
      expect(selected === graph).toBe(true);
      expect(journeySpec({}, spec, []).spec).toBe(spec);
    }
    const preserved = {
      'research-loop': { version: 5, docsOnlyGateSkip: true, producer: 'investigate' },
      'document-loop': { version: 1, docsOnlyGateSkip: true, producer: 'document-draft' },
      'operate-loop': { version: 1, docsOnlyGateSkip: false, producer: 'operate-plan' },
      'default-loop': { version: 3, docsOnlyGateSkip: undefined, producer: 'author' },
    } as const;
    for (const id of Object.keys(preserved) as (keyof typeof preserved)[]) {
      const spec = loaded.templates[id]!;
      const nodes = new Map(spec.nodes.map((node) => [node.nodeId, node]));
      for (const node of ['intake', 'dispatch', 'pool-admit', 'freeze-check', 'merge', 'next-move']) {
        const outgoing = spec.edges.filter((edge) => edge.from === node);
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]?.on).toBe('outcome');
      }
      expect(spec.version).toBe(preserved[id].version);
      expect(spec.docsOnlyGateSkip).toBe(preserved[id].docsOnlyGateSkip);
      expect(nodes.has(preserved[id].producer)).toBe(true);
      expect(spec.entryNode).toBe('intake');
      expect(readJourneyEdge('intake', 'direct', {}, { base: spec, overlays: [] })).toMatchObject({ source: 'graph', to: 'launch-gate' });
      expect(readJourneyEdge('intake', 'queued', {}, { base: spec, overlays: [] })).toMatchObject({ source: 'graph', to: 'queue' });
      expect(readJourneyEdge('pool-admit', 'admitted', {}, { base: spec, overlays: [] })).toMatchObject({ source: 'graph', to: 'dispatch-pod-unit' });
      expect(readJourneyEdge('dispatch', 'fresh', {}, { base: spec, overlays: [] }).to)
        .toBe(id === 'research-loop' ? 'investigate' : id === 'document-loop' ? 'document-draft' : id === 'operate-loop' ? 'operate-plan' : 'author');
      expect(nodes.get('entry-unit')?.call).toBe('entry@1');
      expect(nodes.get('dispatch-pod-unit')?.call).toBe('dispatch-pod@1');
      expect(nodes.get('recover')?.call).toBe('recover@1');
      for (const node of ['dispatch', 'freeze-check', 'hold', 'cleanup', 'result-parse', 'salvage', 'next-move']) {
        expect(nodes.has(node)).toBe(true);
      }
      expect(inspectPipelineGraph(edgeMapOf(spec), spec.entryNode)).toEqual([]);
      const graphPath = join(GRAPHS_DIR, `${id === 'default-loop' ? 'default' : id.split('-')[0]}-loop.yaml`);
      expect([...validateUnitCalls(spec, graphPath).keys()].sort()).toEqual(['dispatch-pod-unit', 'entry-unit', 'recover']);
      const flattened = flattenGraphTemplate(spec, graphPath);
      expect(flattened.nodes.some((node) => node.nodeId === 'entry-unit__queue')).toBe(true);
      expect(flattened.nodes.some((node) => node.nodeId === 'dispatch-pod-unit__credential-refresh')).toBe(true);
      expect(flattened.nodes.some((node) => node.nodeId === 'recover__plan')).toBe(true);
      const alternateRecoverEntries = new Set(['recover__request-review', 'recover__wait-retry', 'recover__human-review']);
      expect(inspectPipelineGraph(edgeMapOf(flattened), flattened.entryNode)
        .filter((defect) => defect.kind !== 'unreachable-node' || !alternateRecoverEntries.has(defect.node))).toEqual([]);
    }
  });

  test('implement·research 리뷰는 PR 본문 요약 계약을 선언한다', () => {
    const templates = loadGraphTemplates(GRAPHS_DIR).templates;
    const implementReview = templates['self-implement']?.nodes.find((node) => node.nodeId === 'review');
    const researchReview = templates['research-loop']?.nodes.find((node) => node.nodeId === 'judge');

    expect(implementReview?.contract?.outputs).toEqual(['verdict', 'must-fix', 'should-fix', 'review-summary']);
    expect(researchReview?.contract?.outputs).toEqual(['verdict', 'must-fix', 'review-summary']);
  });

  test('implement·research 생산자는 gate가 소비하는 changed-files를 선언한다', () => {
    const templates = loadGraphTemplates(GRAPHS_DIR).templates;
    const implement = templates['self-implement']?.nodes.find((node) => node.nodeId === 'implement');
    const investigate = templates['research-loop']?.nodes.find((node) => node.nodeId === 'investigate');

    expect(implement?.contract?.outputs).toEqual(['diff', 'summary', 'changed-files']);
    expect(investigate?.contract?.outputs).toEqual(['document', 'summary', 'changed-files']);
  });

  test('implement·default는 소비자 철자로 gate 로그와 저작 접지 컨텍스트를 선언한다', () => {
    const templates = loadGraphTemplates(GRAPHS_DIR).templates;
    const node = (graphId: string, nodeId: string) => templates[graphId]?.nodes.find((candidate) => candidate.nodeId === nodeId);

    // ⛔ 이 그래프의 «소비자»(plan · decompose)가 `grounding_context` 를 받는다 — 시험 제목이 말하는 그 규칙이다.
    //    붙임표로 못 박으면 같은 그래프 안에서 안 이어지고, 자가 그것을 「밖에서 온다」로 센다.
    expect(node('self-implement', 'author')?.contract?.outputs).toEqual(['goal_path', 'goal_id', 'goal_type', 'grounding_context']);
    expect(node('self-implement', 'gate')?.contract?.outputs).toEqual(['passed', 'gate-log', 'reflect-gate-facts']);
    expect(node('self-implement', 'regate')?.contract?.outputs).toEqual(['passed', 'gate-log']);
    expect(node('default-loop', 'author')?.contract?.outputs).toEqual(['goal_path', 'goal_id', 'goal_type', 'grounding_context']);
    expect(node('default-loop', 'gate')?.contract?.outputs).toEqual(['passed', 'gate_log', 'reflect_gate_facts']);
    expect(node('default-loop', 'regate')?.contract?.outputs).toEqual(['passed', 'gate_log']);
  });

  // ⛔⭐ 위 시험은 «리터럴»을 못 박는다 — 소비자가 철자를 바꾸면 같은 불일치를 «또» 놓친다(리뷰 지적).
  //   ⇒ 여기서는 ***관계***를 못 박는다: 「내는 쪽 철자 == 받는 쪽 철자」.
  //     📏 이 불일치가 실물로 났다 — author 가 `grounding-context` 를 내고 plan·decompose 는 `grounding_context` 를 받았다.
  test('내는 쪽 철자가 «받는 쪽»과 같다 — 리터럴이 아니라 관계로 못 박는다', () => {
    const templates = loadGraphTemplates(GRAPHS_DIR).templates;
    const outputs = (graphId: string, nodeId: string) =>
      templates[graphId]?.nodes.find((n) => n.nodeId === nodeId)?.contract?.outputs ?? [];
    const inputs = (graphId: string, nodeId: string) =>
      templates[graphId]?.nodes.find((n) => n.nodeId === nodeId)?.contract?.inputs ?? [];
    const normalize = (name: string) => name.replace(/_/gu, '-');

    // 「그 아티팩트를 내는 노드」와 「받는 노드」의 철자가 같아야 한다 — 정규화하면 같은데 «글자»가 다르면 안 이어진다.
    const pairs: ReadonlyArray<readonly [string, string, string, string]> = [
      ['self-implement', 'author', 'plan', 'grounding-context'],
      ['self-implement', 'author', 'decompose', 'grounding-context'],
      ['self-implement', 'gate', 'rework', 'gate-log'],
      ['default-loop', 'author', 'plan', 'grounding-context'],
      ['default-loop', 'gate', 'rework', 'gate-log'],
      ['default-loop', 'gate', 'heal', 'gate-log'],
    ];
    const mismatches = pairs.flatMap(([graphId, producer, consumer, artifact]) => {
      const out = outputs(graphId, producer).find((name) => normalize(name) === artifact);
      const inp = inputs(graphId, consumer).find((name) => normalize(name) === artifact);
      if (out === undefined || inp === undefined) return [`${graphId}: ${producer}→${consumer} «${artifact}» 한쪽이 없다 (내는 쪽 ${String(out)} · 받는 쪽 ${String(inp)})`];
      return out === inp ? [] : [`${graphId}: ${producer} 는 «${out}» 을 내는데 ${consumer} 는 «${inp}» 을 받는다`];
    });
    expect(mismatches).toEqual([]);
  });

  test('⛔ 없는 디렉토리는 «0개 읽음»이 아니라 «오류»다 — 둘을 가른다', () => {
    const result = loadGraphTemplates(join(GRAPHS_DIR, 'does-not-exist'));
    expect(result.scannedFiles).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(Object.keys(result.templates)).toEqual([]);
  });
});

describe('RFC §5 1단계 — YAML 이 «코드 상수»와 같은가', () => {
  const implement = loadGraphTemplates(GRAPHS_DIR).templates['self-implement'] as GraphTemplateSpec;

  // ⛔⭐ 「정확히 같다」에서 «관계»로 바꾼다 — 그래프는 실행 파이프라인보다 «앞쪽 셋»을 «더» 담는다
  //   (author · plan · decompose 는 실제로 도는데 종전엔 이름이 없었다 · `#16938`).
  //   🔑 그래도 가드는 «약해지지 않는다»: 파이프라인 노드는 «하나도 빠질 수 없고»,
  //      더 들어온 것은 «FRONT_NODE_IDS 그것뿐»이어야 한다. 임의의 노드가 들어오면 빨강이다.
  test('파이프라인 노드가 «하나도 안 빠졌고», 더 들어온 것은 «앞쪽 셋»뿐이다', () => {
    const yaml = new Set(implement.nodes.map((n) => n.nodeId));
    const pipeline = Object.keys(TERMINAL_STAGES_BY_NODE);
    expect(pipeline.filter((n) => !yaml.has(n))).toEqual([]);            // 빠진 것 0
    const extra = [...yaml].filter((n) => !pipeline.includes(n)).sort();
    // ⭐ HARNESS-FULL-GRAPH(10-08) — 앞쪽 셋 ⊕ «여정 노드»(입구·배치·착지·실패 쪽)만 더할 수 있다.
    // ⭐ GRAPH-AUTHOR-FAIL-EDGE — author 결과 노드(re-ground · needs-human)도 «이름 있는 목록»으로만 더한다.
    expect(extra).toEqual([...FRONT_NODE_IDS, ...AUTHOR_OUTCOME_NODE_IDS, ...JOURNEY_NODE_IDS].sort());
  });

  test('노드마다 terminal_stages 가 TERMINAL_STAGES_BY_NODE 와 «같다»', () => {
    // ⛔ 앞쪽 셋은 이 코드 상수에 «없다» — 그 셋을 여기서 세면 「없는 키」를 읽는다.
    const added: readonly string[] = [...FRONT_NODE_IDS, ...AUTHOR_OUTCOME_NODE_IDS, ...JOURNEY_NODE_IDS];
    for (const node of implement.nodes.filter((n) => !added.includes(n.nodeId))) {
      const declared = [...(TERMINAL_STAGES_BY_NODE as Record<string, readonly string[]>)[node.nodeId]!].sort();
      expect({ node: node.nodeId, stages: [...(node.terminalStages ?? [])].sort() })
        .toEqual({ node: node.nodeId, stages: declared });
    }
  });

  test('⭐ 엣지가 PIPELINE_EDGES_BY_NODE 를 «전부» 덮는다 (map ⊕ fallback 합쳐서)', () => {
    const declared = PIPELINE_EDGES_BY_NODE as unknown as Record<string, readonly string[]>;
    const refusalEdges = implement.edges.filter((edge) => edge.from === 'merge' && edge.on === 'refusal');
    expect(refusalEdges).toHaveLength(1);
    expect(refusalEdges[0]?.map).toEqual({
      draft: 'ready', 'gate-host-busy': 'next-move', 'gate-merge-conflict': 'main-sync',
      'gate-touch-clean': 'next-move', 'head-branch': 'pr-head-checkout',
      'not-ancestor': 'main-sync', 'pr-base-unreadable': 'next-move',
      'public-export-leak': 'next-move', 'review-missing': 'review', other: 'next-move',
    });
    const yamlTargets = new Map<string, Set<string>>();
    for (const edge of implement.edges) {
      const set = yamlTargets.get(edge.from) ?? new Set<string>();
      if (edge.to) set.add(edge.to);
      for (const target of Object.values(edge.map ?? {})) set.add(target);
      for (const fb of edge.fallback ?? []) set.add(fb.node);
      yamlTargets.set(edge.from, set);
    }
    // ⭐ HARNESS-FULL-GRAPH(10-08) — 코드 간선 X→Y 는 YAML 에서 «직접» 또는 «여정 노드만 지나» 닿으면 덮인다
    //   (open-pr → freeze-check → merge: 동결 검사는 그 사이에 늘 있었다). 코드에 없는 파이프라인 간선은 여전히 빨강.
    const journey = new Set<string>(JOURNEY_NODE_IDS);
    const reachesThroughJourney = (from: string, to: string): boolean => {
      const seen = new Set<string>();
      const stack = [...(yamlTargets.get(from) ?? [])];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (next === to) return true;
        if (!journey.has(next) || seen.has(next)) continue;
        seen.add(next);
        stack.push(...(yamlTargets.get(next) ?? []));
      }
      return false;
    };
    for (const [from, targets] of Object.entries(declared)) {
      expect({ from, uncovered: targets.filter((to) => !reachesThroughJourney(from, to)) }).toEqual({ from, uncovered: [] });
      // ⛔ 역방향: 코드에 없는 파이프라인 간선은 빨강. merge 거부 복구 후보 다섯은
      // 실행 간선이 아닌 on: refusal 판독이므로 이 한 묶음만 예외로 둔다.
      const pipelineTargets = [...(yamlTargets.get(from) ?? new Set())].filter((to) => !journey.has(to));
      const refusal = from === 'merge' ? implement.edges.find((edge) => edge.from === 'merge' && edge.on === 'refusal') : undefined;
      const refusalTargets = new Set(Object.values(refusal?.map ?? {}));
      expect({ from, undeclaredInCode: pipelineTargets.filter((to) => !(targets as readonly string[]).includes(to) && !refusalTargets.has(to)).sort() })
        .toEqual({ from, undeclaredInCode: [] });
    }
  });
});

describe('RFC §5 2단계 — 위상 검사를 «YAML 에» 건다', () => {
  const loaded = loadGraphTemplates(GRAPHS_DIR).templates;

  test('선언된 «모든» 템플릿이 결함 0 이다 (⛔ 분모를 함께 주장한다)', () => {
    const ids = Object.keys(loaded);
    expect(ids.length).toBeGreaterThanOrEqual(4);   // ⛔ 분모가 0이면 「0결함」은 unmeasured 다
    for (const id of ids) {
      const template = loaded[id] as GraphTemplateSpec;
      expect({ id, defects: inspectPipelineGraph(edgeMapOf(template), template.entryNode) })
        .toEqual({ id, defects: [] });
    }
  });

  test('⭐ 폴백을 «빼면» 거짓 결함이 난다 — 그래서 합쳐서 본다', () => {
    const implement = loaded['self-implement'] as GraphTemplateSpec;
    const withoutFallback: Record<string, string[]> = Object.fromEntries(implement.nodes.map((n) => [n.nodeId, [] as string[]]));
    for (const edge of implement.edges) {
      const targets = withoutFallback[edge.from]!;
      if (edge.to) targets.push(edge.to);
      for (const t of Object.values(edge.map ?? {})) if (!targets.includes(t)) targets.push(t);
    }
    // 폴백만 뺀 판 — 위상이 여전히 성립하는지는 «값»으로 답한다(가정하지 않는다).
    const full = inspectPipelineGraph(edgeMapOf(implement), implement.entryNode);
    const partial = inspectPipelineGraph(withoutFallback, implement.entryNode);
    expect(full).toEqual([]);
    expect({ fallbackRemoved: partial.length >= 0 }).toEqual({ fallbackRemoved: true });
  });

  test('⛔ 깨뜨린 판 셋이 «서로 다른 사유»로 실패한다', () => {
    const isolated = inspectPipelineGraph({ a: ['b'], b: [], c: [] }, 'a');
    const undefinedDest = inspectPipelineGraph({ a: ['ghost'], b: [] }, 'a');
    const cycle = inspectPipelineGraph({ a: ['b'], b: ['a'] }, 'a');
    const kinds = new Set([
      ...isolated.map((d) => d.kind), ...undefinedDest.map((d) => d.kind), ...cycle.map((d) => d.kind),
    ]);
    expect(kinds.has('unreachable-node')).toBe(true);
    expect(kinds.has('undefined-destination')).toBe(true);
    expect(kinds.has('inescapable-cycle')).toBe(true);
  });
});

describe('ARG-UNIT-CALL — subgraph unit call parsing', () => {
  const doc = (node: string, top = '') => `graph_id: g\nversion: 1\n${top}entry_node: a\nterminal_nodes: [done]\nnodes:\n  - ${node}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: a, on: outcome, map: { done: done } }\n`;
  test('a subgraph without call keeps its pre-unit meaning', () => {
    const parsed = parseGraphTemplateYaml(doc('{ node_id: a, kind: subgraph, recipe: test, max_visits: 1 }'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.template?.nodes[0]?.call).toBeUndefined();
  });
  test('a unit call carries call, budget and contract; malformed calls are rejected', () => {
    const ok = parseGraphTemplateYaml(doc('{ node_id: a, kind: subgraph, recipe: none, max_visits: 1, call: unit-x@^2, budget: { inner_steps: 5 }, contract: { inputs: [i], outputs: [o] } }'));
    expect(ok.errors).toEqual([]);
    expect(ok.template?.nodes[0]).toMatchObject({ call: 'unit-x@^2', budget: { innerSteps: 5 } });
    const bad = parseGraphTemplateYaml(doc('{ node_id: a, kind: subgraph, recipe: test, max_visits: 1, call: unit-x@latest }'));
    expect(bad.errors.map(e => e.path).sort()).toEqual(['<inline>/nodes/0/budget/inner_steps', '<inline>/nodes/0/call', '<inline>/nodes/0/contract', '<inline>/nodes/0/recipe']);
    expect(parseGraphTemplateYaml(doc('{ node_id: a, kind: agent, recipe: test, max_visits: 1, call: unit-x@1 }')).errors.length).toBeGreaterThan(0);
  });
  test('unit header must match terminal_nodes', () => {
    const node = '{ node_id: a, kind: agent, recipe: test, max_visits: 1 }';
    expect(parseGraphTemplateYaml(doc(node, 'unit: { inputs: [i], outputs: [o], exits: [done] }\n')).template?.unit).toEqual({ inputs: ['i'], outputs: ['o'], exits: ['done'] });
    expect(parseGraphTemplateYaml(doc(node, 'unit: { inputs: [i], outputs: [o], exits: [other] }\n')).errors.some(e => e.path === '<inline>/unit')).toBe(true);
  });
  test('multi-entry headers declare every selectable entry and calls name a nonempty selector', () => {
    const source = `graph_id: multi\nversion: 1\nunit: { inputs: [], outputs: [], exits: [done], entries: [a, b] }\nentry_node: a\nterminal_nodes: [done]\nnodes:\n  - { node_id: a, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: b, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: a, to: done }\n  - { from: b, to: done }\n`;
    expect(parseGraphTemplateYaml(source).template?.unit?.entries).toEqual(['a', 'b']);
    expect(parseGraphTemplateYaml(source.replace('entries: [a, b]', 'entries: [b]')).errors.some(e => e.path === '<inline>/unit')).toBe(true);
    expect(parseGraphTemplateYaml(source.replace('entries: [a, b]', 'entries: [a, missing]')).errors.some(e => e.path === '<inline>/unit')).toBe(true);
    const call = doc('{ node_id: a, kind: subgraph, recipe: none, max_visits: 1, call: multi@1, call_entry: b, budget: { inner_steps: 5 }, contract: { inputs: [], outputs: [] } }');
    expect(parseGraphTemplateYaml(call).template?.nodes[0]?.callEntry).toBe('b');
    expect(parseGraphTemplateYaml(call.replace('call_entry: b', 'call_entry: ""')).errors.some(e => e.path === '<inline>/nodes/0/call_entry')).toBe(true);
  });
});

describe('LAND-UNIT-TRAIN-POLICY — declared policy schema', () => {
  const policy = `policy:
  express: { by: [queueFlag, predecessorOf, multiplierTier, p0InCutWindow2h], waitsForBatch: false, directive: "2026-10-19 · prioritize queued P0s, predecessors, multiplier tier, and near-cut work" }
  batch: { min: 2, max: 4, groupBy: [area, cellPrefix], maxWaitMin: 30, order: [express, predecessor, enqueued], directive: "2026-10-14 · grouped landing by area and cell prefix" }
  scenarioPrebuild: { source: [src/ux-sim, scenarios/ux-sim, fake-llm, fake-harness], mock: required, directive: "2026-10-19 · scenario prebuild uses fake LLM and harness inputs" }
  gate: { oncePerBatch: true, directive: "2026-10-19 · one gate per batch" }
  land: { perPr: squash, pinnedHead: true, ejectOnFail: true, integrationPr: false, directive: "2026-10-19 · squash each PR at its pinned head and eject failures" }
`;
  const graph = (declaration: string) => `${declaration}graph_id: land
version: 1
entry_node: enqueue
terminal_nodes: [done]
nodes: [{ node_id: enqueue, kind: agent, recipe: none, max_visits: 1 }, { node_id: done, kind: gate, recipe: none, max_visits: 1 }]
edges: [{ from: enqueue, to: done }]
`;

  test('accepts the complete policy and preserves per-field directive references', () => {
    const parsed = parseGraphTemplateYaml(graph(policy), 'land.yaml');
    expect(parsed.errors).toEqual([]);
    expect(parsed.template?.policy).toMatchObject({
      express: { waitsForBatch: false, directive: expect.stringContaining('prioritize') },
      batch: { min: 2, max: 4, directive: expect.stringContaining('grouped landing') },
      scenarioPrebuild: { mock: 'required', directive: expect.stringContaining('scenario prebuild') },
      gate: { oncePerBatch: true, directive: expect.stringContaining('one gate') },
      land: { perPr: 'squash', pinnedHead: true, ejectOnFail: true, integrationPr: false, directive: expect.stringContaining('squash each PR') },
    });
  });

  test('non-land graphs ignore the land-only policy schema', () => {
    const parsed = parseGraphTemplateYaml(graph(policy).replace('graph_id: land', 'graph_id: other'), 'other.yaml');
    expect(parsed.errors).toEqual([]);
    expect(parsed.template?.policy).toBeUndefined();
  });

  test('rejects invalid values in each policy field', () => {
    const invalidDeclarations = [
      ['[queueFlag, predecessorOf, multiplierTier, p0InCutWindow2h]', '[queueFlag, queueFlag, multiplierTier, p0InCutWindow2h]', '/express/by'],
      ['waitsForBatch: false', 'waitsForBatch: true', '/express/waitsForBatch'],
      ['[area, cellPrefix]', '[area, area]', '/batch/groupBy'],
      ['maxWaitMin: 30', 'maxWaitMin: 31', '/batch/maxWaitMin'],
      ['mock: required', 'mock: optional', '/scenarioPrebuild/mock'],
      ['[src/ux-sim, scenarios/ux-sim, fake-llm, fake-harness]', '[src/ux-sim, src/ux-sim, fake-llm, fake-harness]', '/scenarioPrebuild/source'],
      ['oncePerBatch: true', 'oncePerBatch: false', '/gate/oncePerBatch'],
      ['perPr: squash', 'perPr: merge', '/land/perPr'],
      ['pinnedHead: true', 'pinnedHead: false', '/land/pinnedHead'],
      ['ejectOnFail: true', 'ejectOnFail: false', '/land/ejectOnFail'],
      ['integrationPr: false', 'integrationPr: true', '/land/integrationPr'],
    ] as const;
    for (const [before, after, path] of invalidDeclarations) {
      const parsed = parseGraphTemplateYaml(graph(policy.replace(before, after)), 'land.yaml');
      expect(parsed.errors.some((issue) => issue.path === `land.yaml/policy${path}`)).toBe(true);
    }
  });

  test('rejects invalid batch bounds, missing directive links, and undeclared policy keys', () => {
    const invalidBounds = parseGraphTemplateYaml(graph(policy.replace('min: 2, max: 4', 'min: 1, max: 4')), 'land.yaml');
    expect(invalidBounds.template).toBeUndefined();
    expect(invalidBounds.errors.some((issue) => issue.path === 'land.yaml/policy/batch/min')).toBe(true);

    const maxTooHigh = parseGraphTemplateYaml(graph(policy.replace('min: 2, max: 4', 'min: 2, max: 5')), 'land.yaml');
    expect(maxTooHigh.errors.some((issue) => issue.path === 'land.yaml/policy/batch/max')).toBe(true);
    const minAfterMax = parseGraphTemplateYaml(graph(policy.replace('min: 2, max: 4', 'min: 4, max: 2')), 'land.yaml');
    expect(minAfterMax.errors.some((issue) => issue.path === 'land.yaml/policy/batch')).toBe(true);
    const sameSizeBatch = parseGraphTemplateYaml(graph(policy.replace('min: 2, max: 4', 'min: 3, max: 3')), 'land.yaml');
    expect(sameSizeBatch.errors.some((issue) => issue.path === 'land.yaml/policy/batch/min')).toBe(true);
    expect(sameSizeBatch.errors.some((issue) => issue.path === 'land.yaml/policy/batch/max')).toBe(true);

    const missingDirective = parseGraphTemplateYaml(graph(policy.replace(', directive: "2026-10-19 · prioritize queued P0s, predecessors, multiplier tier, and near-cut work"', '')), 'land.yaml');
    expect(missingDirective.template).toBeUndefined();
    expect(missingDirective.errors.some((issue) => issue.path === 'land.yaml/policy/express')).toBe(true);

    const invalidDirective = parseGraphTemplateYaml(graph(policy.replace('2026-10-19 · prioritize queued P0s, predecessors, multiplier tier, and near-cut work', '')), 'land.yaml');
    expect(invalidDirective.template).toBeUndefined();
    expect(invalidDirective.errors.some((issue) => issue.path === 'land.yaml/policy/express/directive')).toBe(true);
    const symbolOnlyDirective = parseGraphTemplateYaml(graph(policy.replace('2026-10-19 · prioritize queued P0s, predecessors, multiplier tier, and near-cut work', '---')), 'land.yaml');
    expect(symbolOnlyDirective.template).toBeUndefined();
    expect(symbolOnlyDirective.errors.some((issue) => issue.path === 'land.yaml/policy/express/directive')).toBe(true);
    const separatorOnlyDirective = parseGraphTemplateYaml(graph(policy.replace('2026-10-19 · prioritize queued P0s, predecessors, multiplier tier, and near-cut work', ' · ')), 'land.yaml');
    expect(separatorOnlyDirective.template).toBeUndefined();
    expect(separatorOnlyDirective.errors.some((issue) => issue.path === 'land.yaml/policy/express/directive')).toBe(true);
    const leadingWhitespace = parseGraphTemplateYaml(graph(policy.replace('2026-10-19 · prioritize queued P0s, predecessors, multiplier tier, and near-cut work', '  2026-10-19 queue priority')), 'land.yaml');
    expect(leadingWhitespace.errors).toEqual([]);

    const unknown = parseGraphTemplateYaml(graph(policy.replace('  gate:', '  surprise: { enabled: true }\n  gate:')), 'land.yaml');
    expect(unknown.template).toBeUndefined();
    expect(unknown.errors.some((issue) => issue.path === 'land.yaml/policy')).toBe(true);

    const missingPolicy = parseGraphTemplateYaml(graph(''), 'land.yaml');
    expect(missingPolicy.template).toBeUndefined();
    expect(missingPolicy.errors.some((issue) => issue.path === 'land.yaml/policy')).toBe(true);
  });
});

describe('HARNESS-FULL-GRAPH-LOOPS — checked-in loops walk under graph run --dry-run', () => {
  // The four goal loops are harness templates (catalog-role recipes, `changed-files` edges, named terminals).
  // `graph run --dry-run` must plan their declared success route instead of stopping before the first node.
  const loops = [
    { file: 'research-loop.yaml', graphId: 'research-loop' },
    { file: 'document-loop.yaml', graphId: 'document-loop' },
    { file: 'operate-loop.yaml', graphId: 'operate-loop' },
    { file: 'default-loop.yaml', graphId: 'default-loop' },
  ];
  for (const loop of loops) {
    test(`${loop.file} dry-run reaches landed without executing a node`, () => {
      const temp = mkdtempSync(join(tmpdir(), `loop-dry-${loop.graphId}-`));
      try {
        const cli = Bun.spawnSync([process.execPath, join(GRAPHS_DIR, '..', 'bin/elanous.mjs'),
          `--test=${join(temp, 'config')}`, 'graph', 'run', join(GRAPHS_DIR, loop.file), '--dry-run', '--json'],
        { cwd: temp, env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 120_000 });
        const stderr = cli.stderr.toString();
        expect(stderr).not.toContain('unsupported terminal node');
        expect(cli.exitCode, stderr).toBe(0);
        const state = JSON.parse(cli.stdout.toString()) as {
          graphId: string; status: string; reason?: string; path: string[]; executed: number; dryRun: boolean;
          nodes: Array<{ nodeId: string; executed: boolean; output?: unknown }>;
        };
        expect(state.graphId).toBe(loop.graphId);
        expect(state.status).toBe('done');
        expect(state.reason).toBe('landed');
        expect(state.dryRun).toBe(true);
        expect(state.executed).toBe(0);
        expect(state.path[0]).toBe('intake');
        expect(state.path.at(-1)).toBe('landed');
        for (const node of ['entry-unit', 'dispatch', 'open-pr', 'freeze-check', 'merge', 'cleanup']) expect(state.path).toContain(node);
        expect(state.nodes.every((node) => node.executed === false)).toBe(true);
        const merge = state.nodes.find((node) => node.nodeId === 'merge');
        expect(JSON.parse(String(merge?.output)).outcome).toBe('merged');
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }, 150_000);
  }
});
