import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGraphTemplateYaml } from './graph-yaml.js';

const graphPath = resolve(import.meta.dir, '../../graphs/release/release-loop.yaml');
const source = readFileSync(graphPath, 'utf8');
const original = 'authority: [reroute, add-node, repair, hitl]';
const extended = 'authority: [reroute, add-node, repair, hitl, skip-node, gate-waiver, regression-response, emergency-release]';

test('RLA full-verb authority parses as a declaration without changing the release graph', () => {
  expect(source.includes(original) || source.includes(extended)).toBe(true);
  const parsed = parseGraphTemplateYaml(source.replace(original, extended), graphPath);
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.supervisors?.[0]?.authority).toEqual([
    'reroute', 'add-node', 'repair', 'hitl', 'skip-node', 'gate-waiver', 'regression-response', 'emergency-release',
  ]);
});

test('unknown and duplicate authority still fail closed', () => {
  for (const authority of [extended.replace('emergency-release', 'publish'),
    extended.replace('emergency-release', 'skip-node')]) {
    expect(parseGraphTemplateYaml(source.replace(original, extended).replace(extended, authority), graphPath).errors
      .some(issue => issue.path.endsWith('/authority'))).toBe(true);
  }
});
