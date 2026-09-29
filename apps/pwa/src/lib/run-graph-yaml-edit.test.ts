import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addRunGraphEdge,
  addRunGraphNode,
  readRunGraphYaml,
  removeRunGraphEdge,
  removeRunGraphNode,
  setRunGraphNodeKind,
  setRunGraphNodeRecipe,
  writeRunGraphYaml,
} from './run-graph-yaml-edit';

const source = readFileSync(join(import.meta.dir, '../../../../graphs/research-loop.yaml'), 'utf8');

test('reading research-loop and writing it back is byte identical, and an added node keeps comment lines', () => {
  const untouched = readRunGraphYaml(source);
  expect(writeRunGraphYaml(untouched)).toBe(source);

  const edited = readRunGraphYaml(source);
  addRunGraphNode(edited, { nodeId: 'note', kind: 'observe', recipe: 'read-only', maxVisits: 1 });
  const text = writeRunGraphYaml(edited);
  expect(text).toContain('node_id: note');
  expect(text).toContain('# 📏 실측 2026-09-08 (원장 30일 · 전 우주 · 걸음 191개 소급): 이 노드의 «관측 최대»가 ***7*** 이었다.');
  expect(text).toContain('max_visits: 7');
  const commentLines = source.split('\n').filter((line) => line.trimStart().startsWith('#'));
  for (const line of commentLines) expect(text.split('\n')).toContain(line);
});

test('kind, recipe, and map entries change in the document tree without dropping sibling comments', () => {
  const doc = readRunGraphYaml(source);
  setRunGraphNodeKind(doc, 'judge', 'observe');
  setRunGraphNodeRecipe(doc, 'judge', 'read-only');
  addRunGraphEdge(doc, { from: 'judge', outcome: 'again', to: 'investigate' });
  removeRunGraphEdge(doc, 'judge', 'again');
  removeRunGraphNode(doc, 'note');
  const text = writeRunGraphYaml(doc);
  expect(text).toContain('kind: observe');
  expect(text).toContain('recipe: read-only');
  expect(text).not.toContain('again: investigate');
  expect(text).toContain('# 📏 아래 둘은 «실측이 요구했다» — 오늘 첫 런이 실제로 밟았다.');
});
