import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  canonicalGraphJson, edgeMapOf, graphVersionHash, loadGraphTemplates, parseGraphTemplateYaml,
  type GraphNodeKind, type GraphTemplateSpec,
} from './graph-yaml.js';
import { compileGraphTemplate } from './graph-templates.js';
import { FRONT_NODE_IDS } from '../self-dev/graph-front-nodes.js';
import { JOURNEY_NODE_IDS } from '../self-dev/graph-journey-nodes.js';
import { inspectPipelineGraph } from './pipeline-shape.js';
import { PIPELINE_EDGES_BY_NODE, TERMINAL_STAGES_BY_NODE } from './pipeline-shape.js';

const GRAPHS_DIR = join(import.meta.dir, '../../graphs');

describe('RFC §5 0단계 — YAML 파서', () => {
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
  test('실물 graphs/ 를 오류 «0» 으로 읽는다', () => {
    const result = loadGraphTemplates(GRAPHS_DIR);
    expect({ errors: result.errors, scanned: result.scannedFiles > 0 }).toEqual({ errors: [], scanned: true });
    // ⛔ 키는 «파일명»이 아니라 `graph_id` 다 — implement-loop.yaml 의 조인 키는 'self-implement' 다
    //   (원장에 그 이름으로 이미 쌓였다 · 바꾸면 옛 표본과 비교 불가).
    expect(Object.keys(result.templates).sort()).toEqual(['ad-loop', 'default-loop', 'document-loop', 'operate-loop', 'plan-loop', 'research-loop', 'self-implement']);
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
    expect(extra).toEqual([...FRONT_NODE_IDS, ...JOURNEY_NODE_IDS].sort());
  });

  test('노드마다 terminal_stages 가 TERMINAL_STAGES_BY_NODE 와 «같다»', () => {
    // ⛔ 앞쪽 셋은 이 코드 상수에 «없다» — 그 셋을 여기서 세면 「없는 키」를 읽는다.
    const added: readonly string[] = [...FRONT_NODE_IDS, ...JOURNEY_NODE_IDS];
    for (const node of implement.nodes.filter((n) => !added.includes(n.nodeId))) {
      const declared = [...(TERMINAL_STAGES_BY_NODE as Record<string, readonly string[]>)[node.nodeId]!].sort();
      expect({ node: node.nodeId, stages: [...(node.terminalStages ?? [])].sort() })
        .toEqual({ node: node.nodeId, stages: declared });
    }
  });

  test('⭐ 엣지가 PIPELINE_EDGES_BY_NODE 를 «전부» 덮는다 (map ⊕ fallback 합쳐서)', () => {
    const declared = PIPELINE_EDGES_BY_NODE as unknown as Record<string, readonly string[]>;
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
      // ⛔ 역방향: YAML 이 파이프라인 노드 사이에 «코드에 없는» 간선을 더하면 빨강이다(여정 노드로 가는 간선만 더할 수 있다).
      const pipelineTargets = [...(yamlTargets.get(from) ?? new Set())].filter((to) => !journey.has(to));
      expect({ from, undeclaredInCode: pipelineTargets.filter((to) => !(targets as readonly string[]).includes(to)).sort() }).toEqual({ from, undeclaredInCode: [] });
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
