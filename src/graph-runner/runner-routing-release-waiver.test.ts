import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { releaseRouteReachesKnownIssues } from './runner-routing.js';
import type { GraphEdgeSpec } from '../self-implement/graph-yaml.js';

test('release waiver guard follows both declared gate cutover success exits to known issues', () => {
  const graph = parse(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { edges: GraphEdgeSpec[] };
  expect(releaseRouteReachesKnownIssues(graph.edges, 'cloud-leave-ok')).toBe(true);
  const switchEdge = graph.edges.find(edge => edge.from === 'gate-cutover-switch')!;
  expect(switchEdge.map?.legacy).toBeDefined();
  expect(switchEdge.map?.audit).toBeDefined();
  const changed = (map: Record<string, string>) => graph.edges.map(edge => edge === switchEdge ? { ...edge, map } : edge);
  expect(releaseRouteReachesKnownIssues(changed({ ...switchEdge.map, audit: 'publish' }), 'cloud-leave-ok')).toBe(false);
  expect(releaseRouteReachesKnownIssues(changed({ legacy: switchEdge.map!.legacy! }), 'cloud-leave-ok')).toBe(false);
  expect(releaseRouteReachesKnownIssues(changed({ ...switchEdge.map, legacy: 'gate-cutover-switch' }), 'cloud-leave-ok')).toBe(false);
});
