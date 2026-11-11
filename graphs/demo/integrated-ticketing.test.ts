import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';

test('integrated ticketing storyboard is a valid six-scene graph source for the generated demo diagram', () => {
  const parsed = parseGraphTemplateYaml(readFileSync(new URL('./integrated-ticketing.yaml', import.meta.url), 'utf8'), 'integrated-ticketing.yaml');
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.graphId).toBe('integrated-ticketing-demo');
  const ids = parsed.template?.nodes.map(node => node.nodeId) ?? [];
  expect(ids).toContain('scene-1-scrap');
  expect(ids).toContain('scene-2-absorb-brief');
  expect(ids).toContain('scene-3-proposal');
  expect(ids).toContain('scene-4-requirements');
  expect(ids).toContain('scene-5-gcp-expansion');
  expect(ids).toContain('scene-6-build-test-publish');
  expect(ids.filter(id => /^scene-[1-6]-/.test(id))).toHaveLength(10);
  expect(parsed.template?.nodes.filter(node => node.kind === 'hitl')).toHaveLength(2);
});
