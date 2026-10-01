// 그래프 노드 카탈로그(graphs/catalog/catalog.yaml)가 «늙지 않게» — 칸 모양 · 종류 어휘 · 몸의 파일 실재 · 이름 중복.
// 설계 = 내부 문서 `RFC-the-heal-loop-is-a-graph-that-raises-its-own-resolution-2026-09-26` §7
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HARNESS_CORE_KINDS, getNodeKindRegistration, registerNodeKind, unregisterPluginNodeKind } from '../src/graph-kinds/registry.js';
import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml.js';

const ROOT = join(import.meta.dir, '..');
const catalog = parseYaml(readFileSync(join(ROOT, 'graphs/catalog/catalog.yaml'), 'utf8')) as {
  kinds: { existing: string[]; proposed: Record<string, string> };
  roles: Array<{
    role: string; kind: string; grain: string; outcomes: string[]; effects: string; spawn: string;
    body: { ref: string }; names?: Record<string, string>; contract: { inputs: string[]; outputs: string[] };
  }>;
};

describe('graph node catalog', () => {
  const kinds = new Set([...catalog.kinds.existing, ...Object.keys(catalog.kinds.proposed)]);

  test('카탈로그 existing ⊕ proposed 는 그래프 파서 어휘와 같다', () => {
    expect([...kinds].sort()).toEqual([...HARNESS_CORE_KINDS].sort());
    expect(catalog.kinds.proposed).toEqual({});
    for (const kind of kinds) {
      const parsed = parseGraphTemplateYaml(`graph_id: catalog-kind\nversion: 1\nentry_node: node\nterminal_nodes: [node]\nnodes:\n  - node_id: node\n    kind: ${kind}\n    recipe: test\n    max_visits: 1\nedges: []\n`);
      expect(parsed.errors).toEqual([]);
      expect(parsed.template?.nodes[0]?.kind).toBe(kind);
    }
    expect(parseGraphTemplateYaml('graph_id: invalid\nversion: 1\nentry_node: node\nterminal_nodes: [node]\nnodes:\n  - node_id: node\n    kind: not-a-kind\n    recipe: test\n    max_visits: 1\nedges: []\n').errors.length).toBeGreaterThan(0);
    const plugin = { graph: 'harness' as const, kind: 'catalog-probe:custom', plugin: 'catalog-probe', description: 'catalog probe', core: false };
    expect(registerNodeKind(plugin)).toEqual({ ok: true });
    try {
      const parsed = parseGraphTemplateYaml('graph_id: plugin\nversion: 1\nentry_node: node\nterminal_nodes: [node]\nnodes:\n  - node_id: node\n    kind: catalog-probe:custom\n    recipe: test\n    max_visits: 1\nedges: []\n');
      expect(parsed.errors).toEqual([]);
      expect(parsed.template?.nodes[0]?.kind).toBe(plugin.kind);
    } finally {
      const registered = getNodeKindRegistration(plugin.graph, plugin.kind);
      if (registered) unregisterPluginNodeKind(plugin.graph, plugin.kind, plugin.plugin, registered);
    }
  });

  test('역할마다 칸이 다 있고 값이 어휘 안이다', () => {
    const roles = new Set<string>();
    for (const r of catalog.roles) {
      expect(roles.has(r.role)).toBe(false);
      roles.add(r.role);
      expect(kinds.has(r.kind)).toBe(true);
      expect(['atom', 'composite', 'subgraph']).toContain(r.grain);
      expect(['runtime', 'launch', 'never']).toContain(r.spawn);
      expect(r.outcomes.length).toBeGreaterThan(0);
      expect(new Set(r.outcomes).size).toBe(r.outcomes.length);
      expect(Array.isArray(r.contract.inputs) && Array.isArray(r.contract.outputs)).toBe(true);
    }
    expect(catalog.roles.length).toBeGreaterThanOrEqual(40);
  });

  test('부작용 있는 역할은 슈퍼바이저가 실행 중에 얹지 못한다(git·network 는 runtime 금지)', () => {
    const offenders = catalog.roles.filter((r) => ['git'].includes(r.kind) && r.spawn === 'runtime').map((r) => r.role);
    expect(offenders).toEqual([]);
  });

  test('몸이 «경로»로 적힌 역할은 그 파일이 실재한다(신설·코드 없음 표시는 예외)', () => {
    const missing = catalog.roles
      .filter((r) => !r.body.ref.startsWith('('))
      .map((r) => ({ role: r.role, path: r.body.ref.split(':')[0]! }))
      .filter(({ path }) => !existsSync(join(ROOT, path)));
    expect(missing).toEqual([]);
  });

  test('한 템플릿의 한 노드 이름은 한 역할에만 매핑된다', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const r of catalog.roles) {
      for (const [template, node] of Object.entries(r.names ?? {})) {
        const key = `${template}:${node}`;
        if (seen.has(key)) dupes.push(`${key} → ${seen.get(key)} · ${r.role}`);
        seen.set(key, r.role);
      }
    }
    expect(dupes).toEqual([]);
  });
});
