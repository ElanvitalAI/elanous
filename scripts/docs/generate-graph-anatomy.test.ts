import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderGraphAnatomy } from './generate-graph-anatomy.js';

const COMMIT = 'abc1234fixed';
const GENERATED_AT = '2026-10-05T00:00:00.000Z';

const TWO_NODE = `graph_id: sample-loop
version: 1
entry_node: alpha
terminal_nodes: [beta]
nodes:
  - node_id: alpha
    kind: agent
    recipe: cmd:alpha
    max_visits: 1
  - node_id: beta
    kind: gate
    recipe: cmd:beta
    max_visits: 1
edges:
  - from: alpha
    to: beta
`;

function withGraph(yaml: string, run: (root: string, markdown: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-'));
  try {
    writeFileSync(join(root, 'sample.yaml'), yaml);
    const markdown = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
    run(root, markdown);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('renderGraphAnatomy', () => {
  test('임시 YAML(노드 2 · 간선 1)의 graph_id · nodeId · from → to · 주입 커밋이 보인다', () => {
    withGraph(TWO_NODE, (_root, markdown) => {
      expect(markdown).toContain('sample-loop');
      expect(markdown).toContain('alpha');
      expect(markdown).toContain('beta');
      expect(markdown).toContain('alpha → beta');
      expect(markdown).toContain(COMMIT);
      expect(markdown).toContain(GENERATED_AT);
      expect(markdown).toContain('이 문서는 생성물이다 — 손으로 고치지 마라');
      expect(markdown).toContain('| harness | agent | core |');
      expect(markdown).toContain('| workflow | prompt | core |');
    });
  });

  test('같은 디렉터리에 노드를 하나 더 쓰면 그 nodeId 가 추가로 보인다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-'));
    try {
      writeFileSync(join(root, 'sample.yaml'), TWO_NODE);
      const before = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
      expect(before).not.toContain('gamma');
      const extra = TWO_NODE.replace(
        '  - node_id: beta\n    kind: gate\n    recipe: cmd:beta\n    max_visits: 1\n',
        '  - node_id: beta\n    kind: gate\n    recipe: cmd:beta\n    max_visits: 1\n  - node_id: gamma\n    kind: observe\n    recipe: cmd:gamma\n    max_visits: 1\n',
      ).replace('terminal_nodes: [beta]', 'terminal_nodes: [beta, gamma]').replace(
        '  - from: alpha\n    to: beta\n',
        '  - from: alpha\n    to: beta\n  - from: beta\n    to: gamma\n',
      );
      writeFileSync(join(root, 'sample.yaml'), extra);
      const after = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
      expect(after).toContain('gamma');
      expect(after).not.toBe(before);
      expect(after).toContain('| gamma | observe |');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('없는 디렉터리는 «0개 읽음»이 아니라 «디렉토리 없음»이다', () => {
    const missing = join(tmpdir(), `graph-anatomy-missing-${process.pid}-no-such`);
    const markdown = renderGraphAnatomy({ graphsRoot: missing, commit: COMMIT, generatedAt: GENERATED_AT });
    expect(markdown).toContain('디렉토리 없음');
    expect(markdown).toContain('scannedFiles: 0');
    expect(markdown).not.toContain('(0개 읽음)');
  });

  test('빈 디렉터리는 0개 읽음이고 디렉토리 없음이 아니다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-empty-'));
    try {
      const markdown = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
      expect(markdown).toContain('(0개 읽음)');
      expect(markdown).not.toContain('디렉토리 없음');
      expect(markdown).toContain('scannedFiles: 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('실제 저장소 graphs/ 에 implement-loop · orchestrator · rhythm 이 표로 나온다', () => {
    const graphsRoot = join(import.meta.dir, '..', '..', 'graphs');
    const markdown = renderGraphAnatomy({ graphsRoot, commit: COMMIT, generatedAt: GENERATED_AT });
    expect(markdown).toContain('self-implement');
    expect(markdown).toContain('implement-loop.yaml');
    expect(markdown).toContain('| implement-loop.yaml | self-implement |');
    expect(markdown).toContain('| orchestrator/orchestrator.yaml |');
    expect(markdown).toContain('| rhythm/daily.yaml |');
    expect(markdown).toContain('| rhythm/weekly.yaml |');
    expect(markdown).toContain(COMMIT);
    const committed = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'generated', 'graph-anatomy.md'), 'utf8');
    expect(committed).toContain('self-implement');
    expect(committed).toContain('orchestrator');
    expect(committed).toContain('implement-loop.yaml');
    expect(committed).toContain('orchestrator/orchestrator.yaml');
    expect(committed).toContain('rhythm/daily.yaml');
    expect(committed).toContain('이 문서는 생성물이다 — 손으로 고치지 마라');
  });
});

test('a workflow-graph directory (recipes.yaml beside it) reads recipe-less gate nodes as the runner does and skips recipes.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-runner-'));
  try {
    mkdirSync(join(root, 'announce'));
    writeFileSync(join(root, 'announce', 'recipes.yaml'), "gather:\n  command: 'echo hi'\n");
    writeFileSync(join(root, 'announce', 'announce-loop.yaml'), `graph_id: announce-loop
version: 1
entry_node: gather
terminal_nodes: [done, failed]
nodes:
  - { node_id: gather, kind: agent, recipe: 'cmd:gather', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: gather, on: outcome, map: { ok: done, fail: failed, error: failed } }
`);
    const markdown = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
    expect(markdown).toContain('announce-loop');
    expect(markdown).toContain('gather → failed (fail)');
    expect(markdown).not.toContain("'failed' 는 선언된 노드가 아니다");
    expect(markdown).not.toContain('recipe 가 없다');
    expect(markdown).not.toContain('recipes.yaml/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
