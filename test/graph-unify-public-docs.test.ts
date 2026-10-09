import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const publicDoc = readFileSync(resolve(repo, 'release/public/docs/graph-engineering.md'), 'utf8');
const termManual = readFileSync(resolve(repo, 'docs/manual/MANUAL-graph-term-disambiguation-2026-09-22.md'), 'utf8');

test('public graph guide defines workflows as graphs, not single-node bodies', () => {
  expect(publicDoc).toContain('In the unified model, a **workflow** is one form of a graph: a graph that starts from a schedule or trigger and runs task nodes.');
  expect(publicDoc).toContain('Existing `elanous wf` YAML workflows still run without a required schedule or trigger; when conversion is unsupported, they fall back to the original workflow runner.');
  expect(publicDoc).not.toContain('body of a single node');
});

test('public status table separates the shipped canvas from in-progress engine unification', () => {
  const table = publicDoc.split('## What ships today, what is in progress\n')[1]!.split('\n### ')[0]!;
  const rows = table.split('\n').filter((line) => line.startsWith('|'));
  const canvas = rows.find((row) => row.startsWith('| Workflows as one form of graph, drawn in the same editor and canvas |'));
  const engine = rows.find((row) => row.startsWith('| One execution engine for workflows and graphs |'));
  expect(canvas).toContain('✅ ships');
  expect(canvas).toContain('`elanous wf` remains available');
  expect(engine).toContain('🔄 in progress');
  expect(engine).toContain('unsupported workflows fall back to the original workflow runner');
  expect(engine).not.toContain('✅');
  expect(rows.some((row) => row.includes('Workflows as graph nodes (`wf:`) · graphs as workflow nodes'))).toBe(false);
});

test('term SSOT §1 decision table has exactly one post-unification RFC row', () => {
  const section = termManual.split('## §1 🧭 결정표')[1]!.split('\n---\n')[0]!;
  const rows = section.split('\n').filter((line) => line.startsWith('|'));
  const rfcRows = rows.filter((row) => row.includes('](../RFC-graph-workflow-unification-2026-10-08.md)'));
  expect(rfcRows).toHaveLength(1);
  expect(rfcRows[0]).toContain('통합 뒤');
  expect(rfcRows[0]).toContain('③ 실행 그래프의 한 형태인 워크플로');
  expect(rfcRows[0]).toContain('① 이름·캔버스 통합 ✅ / ③ 실행기 통합 🔄');
  expect(rfcRows[0]).toContain('`elanous wf` 호환 유지');
});
