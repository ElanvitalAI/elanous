// M4-5 (2026-05-12 · Phase 4 N5-5) — node catalog tests.
//
// Lock the 20-node catalog · search ranking · spec rendering · list
// grouping. Any new node kind added to the catalog needs to surface
// here (catalog 정합성 + render 깔끔).

import { describe, expect, it } from 'bun:test';
import {
  NODE_CATALOG,
  getNodeSpec,
  searchNodes,
  renderCatalogList,
  renderNodeSpec,
  type NodeCategory,
} from '../src/workflow-runtime/node-catalog';

describe('NODE_CATALOG · invariants', () => {
  it('covers all 21 expected node kinds (v1 ⊕ task)', () => {
    const expectedKinds = [
      'prompt', 'bash', 'skill', 'cft', 'approval',
      'if', 'switch', 'iteration',
      'classify', 'extract', 'set', 'filter', 'template',
      'http', 'task',
      'scheduleTrigger', 'webhookTrigger', 'discordTrigger', 'telegramTrigger', 'manualTrigger', 'chatTrigger',
    ];
    const actualKinds = NODE_CATALOG.map(s => s.kind).sort();
    expect(actualKinds).toEqual(expectedKinds.sort());
  });

  it('every spec has non-empty summary + yamlKey + example', () => {
    for (const spec of NODE_CATALOG) {
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.yamlKey.length).toBeGreaterThan(0);
      expect(spec.example.length).toBeGreaterThan(0);
    }
  });

  it('kind ids are unique', () => {
    const seen = new Set<string>();
    for (const spec of NODE_CATALOG) {
      expect(seen.has(spec.kind)).toBe(false);
      seen.add(spec.kind);
    }
  });

  it('related-kinds point to valid catalog entries', () => {
    const knownKinds = new Set(NODE_CATALOG.map(s => s.kind));
    for (const spec of NODE_CATALOG) {
      for (const r of spec.related ?? []) {
        expect(knownKinds.has(r)).toBe(true);
      }
    }
  });
});

describe('getNodeSpec', () => {
  it('returns the spec for a known kind', () => {
    expect(getNodeSpec('prompt')?.category).toBe('core');
    expect(getNodeSpec('chatTrigger')?.category).toBe('trigger');
  });

  it('is case-insensitive', () => {
    expect(getNodeSpec('PROMPT')?.kind).toBe('prompt');
    expect(getNodeSpec('Bash')?.kind).toBe('bash');
  });

  it('returns undefined for unknown kinds', () => {
    expect(getNodeSpec('does-not-exist')).toBeUndefined();
    expect(getNodeSpec('')).toBeUndefined();
  });
});

describe('searchNodes', () => {
  it('exact kind match wins (score 100)', () => {
    const r = searchNodes('prompt');
    expect(r[0]!.spec.kind).toBe('prompt');
    expect(r[0]!.matched).toBe('kind');
    expect(r[0]!.score).toBe(100);
  });

  it('kind substring match (score 80)', () => {
    const r = searchNodes('trigger');
    // All trigger* kinds should match
    expect(r.length).toBeGreaterThan(3);
    expect(r.every(x => x.spec.kind.toLowerCase().includes('trigger'))).toBe(true);
  });

  it('summary substring match (score 50)', () => {
    const r = searchNodes('Handlebars');
    expect(r.length).toBe(1);
    expect(r[0]!.spec.kind).toBe('template');
    expect(r[0]!.matched).toBe('summary');
  });

  it('category filter narrows results', () => {
    const all = searchNodes('trigger');
    const triggers = searchNodes('trigger', { category: 'trigger' });
    expect(triggers.length).toBeLessThanOrEqual(all.length);
    expect(triggers.every(r => r.spec.category === 'trigger')).toBe(true);
  });

  it('empty query returns []', () => {
    expect(searchNodes('')).toEqual([]);
    expect(searchNodes('   ')).toEqual([]);
  });

  it('case-insensitive', () => {
    const lower = searchNodes('prompt');
    const upper = searchNodes('PROMPT');
    expect(lower).toEqual(upper);
  });

  it('returns [] for no match', () => {
    expect(searchNodes('zxcvbnm')).toEqual([]);
  });
});

describe('renderNodeSpec', () => {
  it('contains kind heading + category + summary + yaml key + example', () => {
    const spec = getNodeSpec('chatTrigger')!;
    const md = renderNodeSpec(spec);
    expect(md).toContain('# chatTrigger');
    expect(md).toContain('**Category**: trigger');
    expect(md).toContain('**YAML key**: `chatTrigger`');
    expect(md).toContain('```yaml');
    expect(md).toContain('chatTrigger:');
    expect(md).toContain(spec.summary);
  });

  it('shows required + optional field lists when present', () => {
    const md = renderNodeSpec(getNodeSpec('classify')!);
    expect(md).toContain('**Required fields**');
    expect(md).toContain('`input`');
    expect(md).toContain('`classes`');
    expect(md).toContain('**Optional fields**');
    expect(md).toContain('`hint`');
  });

  it('shows related-kinds line when present', () => {
    const md = renderNodeSpec(getNodeSpec('if')!);
    expect(md).toContain('**Related**');
    expect(md).toContain('`switch`');
  });
});

describe('renderCatalogList', () => {
  it('groups nodes by category in a stable order', () => {
    const out = renderCatalogList();
    const triggerIdx = out.indexOf('## trigger');
    const coreIdx = out.indexOf('## core');
    expect(triggerIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThanOrEqual(0);
    // 'trigger' appears before 'core' in the canonical order
    expect(triggerIdx).toBeLessThan(coreIdx);
  });

  it('filters to a single category', () => {
    const out = renderCatalogList({ category: 'transform' });
    expect(out).toContain('## transform');
    expect(out).not.toContain('## trigger');
    expect(out).not.toContain('## core');
  });

  it('mentions every node kind in some category section', () => {
    const out = renderCatalogList();
    for (const spec of NODE_CATALOG) {
      expect(out).toContain(spec.kind);
    }
  });
});

describe('category coverage', () => {
  const categories: NodeCategory[] = ['core', 'hitl', 'branch', 'iteration', 'transform', 'integration', 'trigger'];
  for (const cat of categories) {
    it(`has at least one node in category '${cat}'`, () => {
      expect(NODE_CATALOG.filter(s => s.category === cat).length).toBeGreaterThan(0);
    });
  }
});
