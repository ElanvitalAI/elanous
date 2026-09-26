// 힐 표준 템플릿(graphs/heal/heal-loop.yaml)이 «선언으로서» 온전한가 — 파싱 · 카탈로그 역할 · 결과 간선 · 도달성.
// 설계 = 내부 문서 `RFC-the-heal-loop-is-a-graph-that-raises-its-own-resolution-2026-09-26` §3.1 · 우산 RFC one-loop-engine §3
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { edgeMapOf, parseGraphTemplateYaml } from '../src/self-implement/graph-yaml.js';
import { inspectRecipesAgainstCatalog, loadNodeCatalog } from '../src/self-implement/graph-catalog.js';

const ROOT = join(import.meta.dir, '..');
const parsed = parseGraphTemplateYaml(readFileSync(join(ROOT, 'graphs/heal/heal-loop.yaml'), 'utf8'), 'heal-loop.yaml');
const catalog = loadNodeCatalog();

describe('heal-loop standard template', () => {
  test('파싱 오류가 없고 종결은 done·failed 둘이다(③ runner 어휘)', () => {
    expect(parsed.errors).toEqual([]);
    expect([...parsed.template!.terminalNodes].sort()).toEqual(['done', 'failed']);
  });

  test('모든 노드 recipe 가 카탈로그 역할이고 종류가 맞는다', () => {
    expect(inspectRecipesAgainstCatalog(parsed.template!, catalog)).toEqual([]);
  });

  test('관측·인지·힐링 3구조가 다 있다 — observe 노드 · triage(judge) · 힐링 노드', () => {
    const kinds = new Map(parsed.template!.nodes.map((n) => [n.nodeId, n.kind]));
    expect(kinds.get('collect')).toBe('observe');
    expect(kinds.get('observe-deeper')).toBe('observe');
    expect(kinds.get('ground-external')).toBe('observe');
    expect(kinds.get('triage')).toBe('judge');
    for (const heal of ['heal-harness', 'acknowledge', 'rework-note', 'replan', 'verify-evidence']) expect(kinds.has(heal)).toBe(true);
  });

  test('간선의 결과 키는 그 노드 역할이 낼 수 있는 결과다', () => {
    const recipeOf = new Map(parsed.template!.nodes.map((n) => [n.nodeId, n.recipe]));
    const bad: string[] = [];
    for (const edge of parsed.template!.edges) {
      if (!edge.map) continue;
      const role = catalog.roles.get(recipeOf.get(edge.from) ?? '');
      for (const key of Object.keys(edge.map)) if (!role?.outcomes.includes(key)) bad.push(`${edge.from}:${key}`);
    }
    expect(bad).toEqual([]);
  });

  test('triage 는 역할의 결과를 전부 갈래로 받는다(빠진 갈래 = 조용히 막힌 판)', () => {
    const triageEdge = parsed.template!.edges.find((e) => e.from === 'triage')!;
    expect(Object.keys(triageEdge.map!).sort()).toEqual([...catalog.roles.get('triage')!.outcomes].sort());
  });

  test('모든 노드가 entry 에서 닿고, 모든 비종결 노드가 종결에 닿는다', () => {
    const edges = edgeMapOf(parsed.template!);
    const reach = (from: string): Set<string> => {
      const seen = new Set<string>([from]);
      const stack = [from];
      while (stack.length) for (const t of edges[stack.pop()!] ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t); }
      return seen;
    };
    const fromEntry = reach(parsed.template!.entryNode);
    expect(parsed.template!.nodes.map((n) => n.nodeId).filter((id) => !fromEntry.has(id))).toEqual([]);
    const terminals = new Set(parsed.template!.terminalNodes);
    const stuck = parsed.template!.nodes.map((n) => n.nodeId)
      .filter((id) => !terminals.has(id) && ![...reach(id)].some((t) => terminals.has(t)));
    expect(stuck).toEqual([]);
  });

  test('사람(failed)으로 가는 길은 사다리 끝(exhausted)과 골 개정 실패뿐이다', () => {
    const toFailed = parsed.template!.edges.flatMap((e) => Object.entries(e.map ?? {}).filter(([, t]) => t === 'failed').map(([k]) => `${e.from}:${k}`));
    expect(toFailed.sort()).toEqual(['replan:fail', 'triage:exhausted']);
  });
});

describe('launch-head standard subgraph', () => {
  const head = parseGraphTemplateYaml(readFileSync(join(ROOT, 'graphs/launch/launch-head.yaml'), 'utf8'), 'launch-head.yaml');
  test('파싱 · 카탈로그 역할·종류 일치 · 결과 키 ⊆ 역할 결과 · 모든 노드가 종결에 닿는다', () => {
    expect(head.errors).toEqual([]);
    expect(inspectRecipesAgainstCatalog(head.template!, catalog)).toEqual([]);
    const recipeOf = new Map(head.template!.nodes.map((n) => [n.nodeId, n.recipe]));
    const bad: string[] = [];
    for (const e of head.template!.edges) for (const k of Object.keys(e.map ?? {})) {
      if (!catalog.roles.get(recipeOf.get(e.from) ?? '')?.outcomes.includes(k)) bad.push(`${e.from}:${k}`);
    }
    expect(bad).toEqual([]);
    const edges = edgeMapOf(head.template!);
    const terminals = new Set(head.template!.terminalNodes);
    const reach = (from: string) => { const seen = new Set([from]); const st = [from]; while (st.length) for (const t of edges[st.pop()!] ?? []) if (!seen.has(t)) { seen.add(t); st.push(t); } return seen; };
    expect(head.template!.nodes.map((n) => n.nodeId).filter((id) => !terminals.has(id) && ![...reach(id)].some((t) => terminals.has(t)))).toEqual([]);
  });
  test('예산 게이트의 네 판정을 전부 갈래로 받는다', () => {
    const e = head.template!.edges.find((x) => x.from === 'budget')!;
    expect(Object.keys(e.map!).sort()).toEqual([...catalog.roles.get('budget-gate')!.outcomes].sort());
  });
});
