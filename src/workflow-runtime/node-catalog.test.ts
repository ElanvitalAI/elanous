// GRAPH-UNIFY-KINDS (0.2.40 · 2026-10-27) — catalog-as-registry-view tests.
//
// The catalog must expose the registry's full 24-kind workflow vocabulary
// (showroom · subworkflow included) through every consumer surface:
// getNodeSpec · searchNodes · renderNodeSpec · renderCatalogList — read by
// the CLI (`elanous wf node spec/search/list` via src/cli/wf-node.ts), the
// PWA node vocabulary, and workflow-synth (suggest-next-nodes).

import { describe, expect, it } from 'bun:test';
import { WORKFLOW_CORE_KINDS } from '../graph-kinds/registry.js';
import {
  NODE_CATALOG,
  getNodeSpec,
  renderCatalogList,
  renderNodeSpec,
  searchNodes,
} from './node-catalog.js';

describe('GRAPH-UNIFY-KINDS · catalog view over the registry vocabulary', () => {
  it('exposes the registry 24-kind vocabulary (showroom · subworkflow included)', () => {
    expect(WORKFLOW_CORE_KINDS).toHaveLength(24);
    expect(NODE_CATALOG).toHaveLength(24);
    expect([...NODE_CATALOG.map((spec) => spec.kind)].sort()).toEqual([...WORKFLOW_CORE_KINDS].sort());
    expect(new Set(NODE_CATALOG.map((spec) => spec.kind)).size).toBe(24);
  });

  it('getNodeSpec resolves showroom and subworkflow like any core kind', () => {
    expect(getNodeSpec('showroom')).toMatchObject({ kind: 'showroom', category: 'iteration', yamlKey: 'showroom' });
    expect(getNodeSpec('subworkflow')).toMatchObject({ kind: 'subworkflow', category: 'integration', yamlKey: 'subworkflow' });
    expect(getNodeSpec('SUBWORKFLOW')?.kind).toBe('subworkflow');
  });

  it('searchNodes finds showroom and subworkflow', () => {
    expect(searchNodes('showroom')[0]).toMatchObject({ spec: { kind: 'showroom' }, matched: 'kind', score: 100 });
    expect(searchNodes('subworkflow')[0]?.spec.kind).toBe('subworkflow');
  });

  it('renderCatalogList surfaces showroom and subworkflow in their category sections', () => {
    const list = renderCatalogList();
    expect(list).toContain('showroom');
    expect(list).toContain('subworkflow');
    const iteration = renderCatalogList({ category: 'iteration' });
    expect(iteration).toContain('showroom');
    expect(iteration).not.toContain('subworkflow');
    const integration = renderCatalogList({ category: 'integration' });
    expect(integration).toContain('subworkflow');
    expect(integration).not.toContain('showroom');
  });

  it('renderNodeSpec renders the folded kinds', () => {
    const md = renderNodeSpec(getNodeSpec('showroom')!);
    expect(md).toContain('# showroom');
    expect(md).toContain('**Category**: iteration');
    expect(md).toContain('**YAML key**: `showroom`');
    expect(md).toContain('```yaml');
  });

  it('every spec stays well-formed and related kinds stay inside the vocabulary', () => {
    const kinds = new Set(NODE_CATALOG.map((spec) => spec.kind));
    for (const spec of NODE_CATALOG) {
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.yamlKey.length).toBeGreaterThan(0);
      expect(spec.example.length).toBeGreaterThan(0);
      for (const related of spec.related ?? []) expect(kinds.has(related)).toBe(true);
    }
  });
});

describe('consumer behavior preserved (CLI · PWA · synth contract)', () => {
  it('getNodeSpec stays case-insensitive and undefined for unknown kinds', () => {
    expect(getNodeSpec('prompt')?.kind).toBe('prompt');
    expect(getNodeSpec('PROMPT')?.kind).toBe('prompt');
    expect(getNodeSpec('does-not-exist')).toBeUndefined();
    expect(getNodeSpec('')).toBeUndefined();
  });

  it('searchNodes keeps its ranking contract', () => {
    expect(searchNodes('')).toEqual([]);
    expect(searchNodes('   ')).toEqual([]);
    expect(searchNodes('prompt')[0]).toMatchObject({ spec: { kind: 'prompt' }, matched: 'kind', score: 100 });
    expect(searchNodes('trigger').every((r) => r.spec.kind.toLowerCase().includes('trigger'))).toBe(true);
    expect(searchNodes('zxcvbnm')).toEqual([]);
  });

  it('renderCatalogList keeps the canonical category order and category filter', () => {
    const out = renderCatalogList();
    expect(out.indexOf('## trigger')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('## trigger')).toBeLessThan(out.indexOf('## core'));
    const transform = renderCatalogList({ category: 'transform' });
    expect(transform).toContain('## transform');
    expect(transform).not.toContain('## core');
  });
});
