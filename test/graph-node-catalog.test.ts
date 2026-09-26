// 그래프 노드 카탈로그(graphs/catalog/catalog.yaml)가 «늙지 않게» — 칸 모양 · 종류 어휘 · 몸의 파일 실재 · 이름 중복.
// 설계 = 내부 문서 `RFC-the-heal-loop-is-a-graph-that-raises-its-own-resolution-2026-09-26` §7
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
    const yamlSource = readFileSync(join(ROOT, 'src/self-implement/graph-yaml.ts'), 'utf8');
    const declared = /const KINDS = new Set<GraphNodeKind>\(\[([^\]]+)\]\)/.exec(yamlSource)?.[1];
    expect(declared).toBeDefined();
    const parserKinds = [...declared!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect([...kinds].sort()).toEqual(parserKinds);
    expect(catalog.kinds.proposed).toEqual({});
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
