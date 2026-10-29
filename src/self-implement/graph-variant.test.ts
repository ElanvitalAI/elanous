import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { GRAPH_SPECS } from './graph-templates.js';
import { createGraphVariant, hashUnitDeclarationContent, initialGraphVariantSelection, type GraphVariantPlan } from './graph-variant.js';
import { edgeMapOf, type GraphTemplateSpec } from './graph-yaml.js';
import { selectOverlays } from './graph-overlay-yaml.js';
import { loadRunGraphVariant, runGraphVariantPath, runLedgerPath, saveRunGraphVariant } from './run-ledger.js';
import { stringify } from 'yaml';

const template = GRAPH_SPECS['self-implement'] as GraphTemplateSpec;
const plan: GraphVariantPlan = { maxVisits: { rework: 5 }, routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }] };

function generate(changes: GraphVariantPlan, source = template) {
  return createGraphVariant({ template: source, goal: 'g_abc123', plan: changes });
}

describe('harness graph variant', () => {
  test('injected plan changes only allowed visits and conditional route; is reproducible and goal-scoped', () => {
    const result = generate(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const again = generate(plan);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(result.overlay).toEqual(again.overlay);
    expect(result.template).toEqual(again.template);
    expect(result.patches).toEqual([
      { op: 'replace', path: `/nodes/${template.nodes.findIndex((node) => node.nodeId === 'rework')}/maxVisits`, value: 5 },
      { op: 'replace', path: `/edges/${template.edges.findIndex((edge) => edge.from === 'review' && edge.map?.pass)}/map/pass`, value: 'open-pr' },
    ]);
    expect(result.template.nodes.find((node) => node.nodeId === 'rework')?.maxVisits).toBe(5);
    expect(edgeMapOf(result.template).review).toContain('open-pr');
    expect(template.nodes.find((node) => node.nodeId === 'rework')?.maxVisits).not.toBe(5);
    expect(template.edges.find((edge) => edge.from === 'review' && edge.map)?.map?.pass).toBe('main-sync');
    expect(result.template.nodes.map((node) => node.nodeId)).toEqual(template.nodes.map((node) => node.nodeId));
    expect(selectOverlays([result.overlay], { graphId: template.graphId, stage: 'launch', state: { goal_key: 'g_abc123' } }).applied).toHaveLength(1);
    expect(selectOverlays([result.overlay], { graphId: template.graphId, stage: 'launch', state: { goal_key: 'g_other' } }).applied).toHaveLength(0);
  });

  test('sorting visit and route proposals yields the same variant', () => {
    const a = generate({ maxVisits: { review: 6, rework: 5 }, routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }, { from: 'gate', outcome: 'pass', to: 'open-pr' }] });
    const b = generate({ routes: [{ from: 'gate', outcome: 'pass', to: 'open-pr' }, { from: 'review', outcome: 'pass', to: 'open-pr' }], maxVisits: { rework: 5, review: 6 } });
    expect(a).toEqual(b);
  });

  test('unknown source, destination and visit nodes reject the whole proposal', () => {
    const result = generate({ maxVisits: { missing: 2, rework: 5 }, routes: [{ from: 'review', outcome: 'pass', to: 'missing' }, { from: 'missing', outcome: 'pass', to: 'merge' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections).toEqual([
      { kind: 'unknown-node', node: 'missing' },
      { kind: 'unknown-node', node: 'missing' },
      { kind: 'unknown-node', node: 'missing' },
    ]);
    expect('template' in result).toBe(false);
  });

  test('protects unconditional and fallback edges and rejects invented outcomes', () => {
    for (const proposal of [
      { from: 'open-pr', outcome: 'pass', to: 'review' },
      { from: 'review', outcome: 'fallback', to: 'merge' },
      { from: 'gate', outcome: 'invented', to: 'review' },
    ]) {
      const result = generate({ routes: [proposal] });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.rejections[0]?.kind).toBe('protected-edge');
    }
  });

  test('unknown outcome on a conditional-only edge is distinct from a protected edge', () => {
    const compact: GraphTemplateSpec = {
      graphId: 'compact', version: 1, entryNode: 'start', terminalNodes: ['end'],
      nodes: ['start', 'end'].map((nodeId) => ({ nodeId, kind: 'agent', recipe: 'unit', maxVisits: 1, contract: { inputs: [], tools: 'read-only', outputs: [] } })),
      edges: [{ from: 'start', on: 'outcome', map: { pass: 'end' } }],
    };
    const result = generate({ routes: [{ from: 'start', outcome: 'invented', to: 'end' }] }, compact);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual([{ kind: 'unknown-outcome', from: 'start', outcome: 'invented' }]);
  });

  test('invalid budgets fail closed including zero, fractional and non-finite values', () => {
    for (const value of [0, -1, 1.25, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = generate({ maxVisits: { rework: value } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejections[0]).toEqual({ kind: 'invalid-budget', node: 'rework', value });
    }
  });

  test('a route that cuts off the declared terminal cannot be accepted', () => {
    const compact: GraphTemplateSpec = {
      graphId: 'compact', version: 1, entryNode: 'start', terminalNodes: ['end'],
      nodes: ['start', 'end'].map((nodeId) => ({ nodeId, kind: 'agent', recipe: 'unit', maxVisits: 1, contract: { inputs: [], tools: 'read-only', outputs: [] } })),
      edges: [{ from: 'start', on: 'outcome', map: { pass: 'end' } }],
    };
    const result = generate({ routes: [{ from: 'start', outcome: 'pass', to: 'start' }] }, compact);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections.some((rejection) => rejection.kind === 'unreachable-terminal' && rejection.node === 'end')).toBe(true);
  });

  test('duplicate routes and invalid goal identity reject rather than silently winning', () => {
    const duplicated = generate({ routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }, { from: 'review', outcome: 'pass', to: 'merge' }] });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.rejections[0]?.kind).toBe('duplicate-route');
    const invalid = createGraphVariant({ template, goal: 'a b', plan: {} });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.rejections[0]?.kind).toBe('invalid-goal');
  });

  test('growth rejects invalid goal analysis along with invalid node, and never accepts it with a valid node', () => {
    const goalAnalysis = { goalType: 'implement' as const, targetPathCount: -1 };
    const noGrowth = createGraphVariant({ template, goal: 'g_abc123', goalAnalysis, plan: {} });
    expect(noGrowth.ok).toBe(false);
    if (!noGrowth.ok) expect(noGrowth.rejections.map((rejection) => rejection.kind)).toEqual(['invalid-goal-analysis']);
    const invalidNode = createGraphVariant({ template, goal: 'g_abc123', goalAnalysis,
      plan: { growth: { node: null as never, from: 'review', outcome: 'other', returnTo: 'review' } } });
    expect(invalidNode.ok).toBe(false);
    if (!invalidNode.ok) expect(invalidNode.rejections.map((rejection) => rejection.kind)).toEqual(['invalid-goal-analysis', 'invalid-growth']);
    const existingNode = template.nodes[0]!;
    const validNode = createGraphVariant({ template, goal: 'g_abc123', goalAnalysis,
      plan: { growth: { node: { ...existingNode, nodeId: 'new-growth-node' }, from: 'review', outcome: 'other', returnTo: 'review' } } });
    expect(validNode.ok).toBe(false);
    if (!validNode.ok) expect(validNode.rejections.some((rejection) => rejection.kind === 'invalid-goal-analysis')).toBe(true);
  });

  test('an outcome declared on two conditional edges of one node is rejected, not half-patched', () => {
    const reviewEdge = template.edges.find((edge) => edge.from === 'review' && edge.map?.pass);
    expect(reviewEdge).toBeDefined();
    const doubled: GraphTemplateSpec = { ...template, edges: [...template.edges, { ...reviewEdge!, map: { pass: reviewEdge!.map!.pass! } }] };
    const result = generate({ routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }] }, doubled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual([{ kind: 'ambiguous-outcome', from: 'review', outcome: 'pass' }]);
  });

  test('L2 발사 때 상황별 최초 설계 — 골 종류·대상 경로 수를 주면 최초 graph variant id·선택 이유가 결정론적으로 나온다', () => {
    // 격리 골 한 건의 기록된 실제 입력 — 이 런의 골 문서(종류 implement · 대상 경로 5).
    const goalAnalysis = { goalType: 'implement' as const, targetPathCount: 5 };
    // ① 최초 variant id·선택 이유 산출 — 결정론: 같은 두 입력이면 같은 값, 어느 하나라도 다르면 다른 id.
    const first = initialGraphVariantSelection(goalAnalysis);
    expect(initialGraphVariantSelection(goalAnalysis)).toEqual(first);
    expect(initialGraphVariantSelection({ goalType: 'document', targetPathCount: 5 }).variantId).not.toBe(first.variantId);
    expect(initialGraphVariantSelection({ goalType: 'implement', targetPathCount: 1 }).variantId).not.toBe(first.variantId);
    expect(first.reason).toContain('implement');
    expect(first.reason).toContain('5');

    // 생산 검증 경로 — createGraphVariant 결과에 그 선택이 그대로 실리고, 계획이 달라져도 선택은 두 입력만 따른다.
    const variant = createGraphVariant({ template, goal: 'g_variant_slice', plan, goalAnalysis });
    expect(variant.ok).toBe(true);
    if (!variant.ok) return;
    expect(variant.selection).toEqual(first);
    const otherPlan = createGraphVariant({ template, goal: 'g_variant_slice', plan: { maxVisits: { review: 6 } }, goalAnalysis });
    expect(otherPlan.ok).toBe(true);
    if (otherPlan.ok) expect(otherPlan.selection).toEqual(first);
  });

  test('최초 graph variant id·선택 이유가 런 원장 옆 .graph.yaml 에 저장되고 loadRunGraphVariant 재조회가 같다', () => {
    const selection = initialGraphVariantSelection({ goalType: 'implement', targetPathCount: 5 });

    // ② 런 원장 옆 저장 경로 확보 + 저장(.graph.yaml) — ③ 재조회 동일성(id·reason·경로).
    const dir = mkdtempSync(join(tmpdir(), 'graph-variant-ledger-'));
    try {
      const runId = 'run-0a0b0c0d-1111-4222-8333-444455556666';
      const graphFile = runGraphVariantPath(runId, dir);
      expect(graphFile).toBe(`${runLedgerPath(runId, dir)}.graph.yaml`);
      expect(loadRunGraphVariant(runId, dir)).toBe(null);
      expect(saveRunGraphVariant(runId, stringify({
        graph_id: 'self-implement', variant_id: selection.variantId, reason: selection.reason,
        nodes: [], edges: [],
      }), dir)).toBe(graphFile);
      expect(loadRunGraphVariant(runId, dir)).toEqual({ variantId: selection.variantId, reason: selection.reason });
      expect(runGraphVariantPath(runId, dir)).toBe(graphFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// GRAPH-UNIT-DECLARED-HASH — 한 런이 «어느 unit 선언 버전»을 읽었는지 내용 해시만 남겨 시험 fixture 와 정본 선언을 가른다.
// ⛔ 선언 본문은 근거에 복제하지 않는다 — 경로·해시만.
describe('GRAPH-UNIT-DECLARED-HASH: unit 선언 경로·내용 해시 근거', () => {
  const goalAnalysis = { goalType: 'implement' as const, targetPathCount: 1 };
  const declarationPath = 'graphs/self-implement.yaml';
  // 같은 fixture 의 두 원문 — 정확히 «한 줄»만 다르다(recipe 값).
  const originalUnit = 'unit: self-implement\nstep: review\nrecipe: unit\n';
  const editedUnit = 'unit: self-implement\nstep: review\nrecipe: rework\n';

  function variantOf(content: string, declarations?: readonly { readonly path: string; readonly content: string }[]) {
    return createGraphVariant({ template, goal: 'g_unit_hash', plan, goalAnalysis,
      unitDeclarations: declarations ?? [{ path: declarationPath, content }] });
  }

  test('unit 파일 한 줄만 바꾸면 변형 근거 해시가 달라지고 variantId·overlay 는 그대로다', () => {
    const before = variantOf(originalUnit);
    const after = variantOf(editedUnit);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    // ① 경로는 그대로, 내용 해시는 갈린다 — 두 원문을 가르는 유일한 근거.
    const beforeEvidence = before.selection?.unitDeclarations;
    const afterEvidence = after.selection?.unitDeclarations;
    expect(beforeEvidence).toHaveLength(1);
    expect(afterEvidence).toHaveLength(1);
    expect(beforeEvidence?.[0]?.path).toBe(declarationPath);
    expect(afterEvidence?.[0]?.path).toBe(declarationPath);
    expect(beforeEvidence?.[0]?.contentHash).not.toBe(afterEvidence?.[0]?.contentHash);
    expect(beforeEvidence?.[0]?.contentHash).toBe(hashUnitDeclarationContent(originalUnit));
    expect(beforeEvidence?.[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // ② 변형 «신원» 은 unit 선언에 흔들리지 않는다 — id·선택 이유·overlay·patches 는 두 입력에서 같다.
    expect(after.selection?.variantId).toBe(before.selection?.variantId);
    expect(after.selection?.reason).toBe(before.selection?.reason);
    expect(after.overlay).toEqual(before.overlay);
    expect(after.patches).toEqual(before.patches);
  });

  test('근거에는 경로·해시만 실리고 unit 선언 본문은 결과 어디에도 복제되지 않는다', () => {
    const result = variantOf(`unit_body_sentinel_7f3a: true\n${originalUnit}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('unit_body_sentinel_7f3a');
    expect(serialized).not.toContain('recipe: unit');
    expect(Object.keys(result.selection ?? {}).sort()).toEqual(['reason', 'unitDeclarations', 'variantId']);
  });

  test('선언이 없으면 근거 키 자체가 없고, 정렬·중복은 결정론적이다', () => {
    const withoutDeclarations = initialGraphVariantSelection(goalAnalysis);
    expect(Object.keys(withoutDeclarations).sort()).toEqual(['reason', 'variantId']);

    const ordered = initialGraphVariantSelection(goalAnalysis, [
      { path: 'src/b.ts', content: 'b\n' },
      { path: 'src/a.ts', content: 'a\n' },
    ]);
    const reversed = initialGraphVariantSelection(goalAnalysis, [
      { path: 'src/a.ts', content: 'a\n' },
      { path: 'src/b.ts', content: 'b\n' },
    ]);
    expect(ordered).toEqual(reversed);
    expect(ordered.unitDeclarations?.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);

    // 같은 경로를 두 번 선언하면 마지막 해시 하나만 남는다 — 경로당 근거 한 줄.
    const duplicated = initialGraphVariantSelection(goalAnalysis, [
      { path: 'src/a.ts', content: 'a\n' },
      { path: 'src/a.ts', content: 'a changed\n' },
    ]);
    expect(duplicated.unitDeclarations).toEqual([{ path: 'src/a.ts', contentHash: hashUnitDeclarationContent('a changed\n') }]);
  });

  test('원장 옆 .graph.yaml 이 unit 선언 경로·해시를 추가 키로 저장하고 재조회가 같은 값을 돌려준다', () => {
    const variant = variantOf(originalUnit);
    expect(variant.ok).toBe(true);
    if (!variant.ok) return;
    expect(variant.selection).toBeDefined();
    if (variant.selection === undefined) return;
    const { variantId, reason, unitDeclarations } = variant.selection;
    expect(unitDeclarations).toBeDefined();
    if (unitDeclarations === undefined) return;

    const dir = mkdtempSync(join(tmpdir(), 'graph-unit-declared-hash-'));
    try {
      const runId = 'run-9f9f9f9f-2222-4333-8444-555566667777';
      saveRunGraphVariant(runId, stringify({
        graph_id: 'self-implement', variant_id: variantId, reason,
        unit_declarations: unitDeclarations.map((entry) => ({ path: entry.path, content_hash: entry.contentHash })),
        nodes: [], edges: [],
      }), dir);
      const loaded = loadRunGraphVariant(runId, dir);
      // 보존 계약: 기존 두 키의 재조회는 «문자 그대로» 그대로다.
      expect(loaded?.variantId).toBe(variantId);
      expect(loaded?.reason).toBe(reason);
      // 추가 키: 경로·해시가 원장에서 돌아온다.
      expect(loaded?.unitDeclarations).toEqual(unitDeclarations);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
