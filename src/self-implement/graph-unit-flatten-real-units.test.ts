import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flattenGraphTemplate, resolveGraphUnit } from './graph-unit-resolver.js';
import { parseGraphTemplateYaml } from './graph-yaml.js';

const repoRoot = join(import.meta.dir, '..', '..');
const journeyPath = join(repoRoot, 'graphs', 'journey', 'ta-journey.yaml');

type JourneySpec = NonNullable<ReturnType<typeof parseGraphTemplateYaml>['template']>;

function loadJourney(): JourneySpec {
  const parsed = parseGraphTemplateYaml(readFileSync(journeyPath, 'utf8'), journeyPath);
  expect(parsed.errors).toEqual([]);
  return parsed.template!;
}

describe('real graph unit completion boundary (graphs/journey/ta-journey.yaml + graphs/units)', () => {
  test('the five cell-named unit declarations resolve with their declared enter/exit contracts', () => {
    const five = [
      { call: 'entry@1', file: 'entry/entry.yaml', entryNode: 'intake', exits: ['done', 'rework', 'needs-human', 'failed'] },
      { call: 'land@1', file: 'land/land.yaml', entryNode: 'enqueue', exits: ['done', 'rework', 'needs-human', 'failed'] },
      { call: 'dispatch-pod@1', file: 'dispatch-pod/dispatch-pod.yaml', entryNode: 'pool-admit', exits: ['done', 'rework', 'needs-human', 'failed'] },
      { call: 'verb-harvest@1', file: 'harvest/harvest.yaml', entryNode: 'review', exits: ['done', 'rework', 'needs-human', 'failed'] },
      { call: 'reflect@1', file: 'reflect/reflect.yaml', entryNode: 'reflect', exits: ['done', 'wait', 'needs-human'] },
    ] as const;
    for (const wanted of five) {
      const resolved = resolveGraphUnit(wanted.call, journeyPath);
      expect(resolved.path).toBe(join(repoRoot, 'graphs', 'units', wanted.file));
      const parsed = parseGraphTemplateYaml(readFileSync(resolved.path, 'utf8'), resolved.path);
      expect(parsed.errors).toEqual([]);
      expect(parsed.template?.unit?.exits).toEqual([...wanted.exits]);
      expect(parsed.template?.terminalNodes).toEqual([...wanted.exits]);
      expect(parsed.template?.entryNode).toBe(wanted.entryNode);
    }
  });

  test('the real production journey graph flattens every unit call through flattenGraphTemplate', () => {
    const flat = flattenGraphTemplate(loadJourney(), journeyPath);
    expect(flat.unit).toBeUndefined();
    expect(flat.entryNode).toBe('entry__intake');
    expect(flat.terminalNodes).toEqual(['done', 'failed', 'needs-human', 'rework']);
    expect([...flat.nodes.map((node) => node.nodeId)].sort()).toEqual([
      'author-dialogue__author',
      'author-dialogue__implement',
      'author-dialogue__judge',
      'author__observe',
      'dispatch-pod__credential-refresh',
      'dispatch-pod__image-sync',
      'dispatch-pod__pool-admit',
      'done',
      'entry__intake',
      'entry__launch-gate',
      'entry__queue',
      'failed',
      'green__stage',
      'harvest__review',
      'land__enqueue',
      'needs-human',
      'pr__observe',
      'reflect__reflect',
      'remember__stage',
      'rework',
    ]);
    expect(flat.nodes.some((node) => node.call !== undefined)).toBe(false);
    const edgeOf = (from: string) => flat.edges.find((edge) => edge.from === from);
    expect(edgeOf('entry__intake')).toEqual({
      from: 'entry__intake',
      on: 'outcome',
      map: { done: 'entry__queue', rework: 'rework', 'needs-human': 'needs-human', failed: 'failed' },
    });
    expect(edgeOf('entry__launch-gate')).toEqual(
      expect.objectContaining({ map: expect.objectContaining({ done: 'author__observe' }) }),
    );
    // RFC-progressive-goal-elaboration §7 — author → author-dialogue(대화 고리) → dispatch-pod.
    expect(edgeOf('author__observe')).toEqual(
      expect.objectContaining({ map: expect.objectContaining({ done: 'author-dialogue__author' }) }),
    );
    expect(edgeOf('author-dialogue__judge')).toEqual(
      expect.objectContaining({ map: expect.objectContaining({ done: 'dispatch-pod__pool-admit', findings: 'author-dialogue__author' }) }),
    );
    expect(edgeOf('land__enqueue')).toEqual(
      expect.objectContaining({ map: expect.objectContaining({ done: 'reflect__reflect' }) }),
    );
    expect(edgeOf('remember__stage')).toEqual(
      expect.objectContaining({ map: expect.objectContaining({ done: 'done', failed: 'failed' }) }),
    );
  });

  test('a unit exit mapped back into its own call re-enters the flattened unit instead of dangling', () => {
    const flat = flattenGraphTemplate(loadJourney(), journeyPath);
    const reflectEdge = flat.edges.find((edge) => edge.from === 'reflect__reflect');
    expect(reflectEdge).toEqual({
      from: 'reflect__reflect',
      on: 'outcome',
      map: { done: 'green__stage', wait: 'reflect__reflect', 'needs-human': 'needs-human' },
    });
  });

  test('the real graph enforces the unit entry and exit contract at the flatten boundary', () => {
    const journey = loadJourney();
    const reflectRow = journey.edges.find((edge) => edge.from === 'reflect' && edge.on === 'outcome');
    expect(reflectRow?.map).toBeDefined();
    const brokenExit: JourneySpec = {
      ...journey,
      edges: journey.edges.map((edge) =>
        edge.from === 'reflect' && edge.on === 'outcome' && edge.map
          ? { ...edge, map: Object.fromEntries(Object.entries(edge.map).filter(([outcome]) => outcome !== 'wait')) }
          : edge,
      ),
    };
    expect(() => flattenGraphTemplate(brokenExit, journeyPath)).toThrow('unit contract mismatch: reflect -> reflect@1');
    const ghostEntry: JourneySpec = {
      ...journey,
      nodes: journey.nodes.map((node) => (node.call ? { ...node, callEntry: 'ghost' } : node)),
    };
    expect(() => flattenGraphTemplate(ghostEntry, journeyPath)).toThrow('unit entry mismatch');
  });
});
