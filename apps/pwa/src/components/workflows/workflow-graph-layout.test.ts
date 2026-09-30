// Archon-port T2B (2026-05-08) — pure layout tests.

import { describe, expect, it } from 'bun:test';
import {
  buildGraphFromDefinition,
  classifyNodeVariant,
  nodeBadgeLabel,
  workflowToLayout,
  type WorkflowDefinitionLike,
} from './workflow-graph-layout';

describe('classifyNodeVariant', () => {
  it('detects each of the 5 variants', () => {
    expect(classifyNodeVariant({ prompt: 'go' })).toBe('prompt');
    expect(classifyNodeVariant({ bash: 'echo' })).toBe('bash');
    expect(classifyNodeVariant({ skill: 'omni-digest' })).toBe('skill');
    expect(classifyNodeVariant({ cft: 'pdca' })).toBe('cft');
    expect(classifyNodeVariant({ approval: { message: 'ok?' } })).toBe('approval');
  });

  it('returns "unknown" for nodes with no recognised payload', () => {
    expect(classifyNodeVariant({})).toBe('unknown');
    expect(classifyNodeVariant({ id: 'x' })).toBe('unknown');
    expect(classifyNodeVariant({ approval: 'string-not-object' })).toBe('unknown');
  });

  it('prefers prompt over later siblings', () => {
    expect(classifyNodeVariant({ prompt: 'a', bash: 'b' })).toBe('prompt');
  });
});

describe('buildGraphFromDefinition', () => {
  const wf: WorkflowDefinitionLike = {
    name: 'demo',
    nodes: [
      { id: 'first', bash: 'echo hello\nsecond line' },
      {
        id: 'second',
        prompt: '   \n  Analyze the diff\nLine 2',
        depends_on: ['first'],
        when: '$first.ok == true',
        trigger_rule: 'all_success',
        allowed_tools: ['Read'],
      },
      {
        id: 'gate',
        approval: { message: 'Continue?' },
        depends_on: ['second'],
      },
    ],
  };

  it('emits one GraphNode per source node, preserving order', () => {
    const { nodes } = buildGraphFromDefinition(wf);
    expect(nodes.map((n) => n.id)).toEqual(['first', 'second', 'gate']);
  });

  it('classifies variants and surfaces preview text from the first non-empty line', () => {
    const { nodes } = buildGraphFromDefinition(wf);
    expect(nodes[0]).toMatchObject({ variant: 'bash', preview: 'echo hello' });
    expect(nodes[1]).toMatchObject({ variant: 'prompt', preview: 'Analyze the diff' });
    expect(nodes[2]).toMatchObject({ variant: 'approval', preview: 'Continue?' });
  });

  it('flags `when` and `trigger_rule` and tool policy presence', () => {
    const { nodes } = buildGraphFromDefinition(wf);
    expect(nodes[1].hasWhen).toBe(true);
    expect(nodes[1].triggerRule).toBe('all_success');
    expect(nodes[1].hasToolPolicy).toBe(true);
    expect(nodes[0].hasWhen).toBe(false);
    expect(nodes[0].hasToolPolicy).toBe(false);
  });

  it('emits one edge per `depends_on` entry with stable ids', () => {
    const { edges } = buildGraphFromDefinition(wf);
    expect(edges).toEqual([
      { id: 'first->second', source: 'first', target: 'second' },
      { id: 'second->gate', source: 'second', target: 'gate' },
    ]);
  });

  it('skips empty / duplicate / malformed node entries', () => {
    const def: WorkflowDefinitionLike = {
      name: 'edge-cases',
      nodes: [
        { id: 'good', bash: 'echo' },
        { id: 'good', bash: 'dup' }, // duplicate id — silently dropped
        { id: '', bash: 'empty-id' },  // empty id — dropped
        { id: 'noop' } as { id: string }, // unknown variant kept (variant=unknown)
      ],
    };
    const { nodes } = buildGraphFromDefinition(def);
    expect(nodes.map((n) => n.id)).toEqual(['good', 'noop']);
    expect(nodes[1].variant).toBe('unknown');
  });

  it("attaches branches ['then','else'] to if nodes (v2 multi-handle)", () => {
    const def: WorkflowDefinitionLike = {
      name: 'demo',
      nodes: [{ id: 'route', if: { condition: '$ARGUMENTS' } }],
    };
    const { nodes } = buildGraphFromDefinition(def);
    expect(nodes[0].branches).toEqual(['then', 'else']);
  });

  it("attaches branches [...cases, 'default'] to switch nodes (v2 multi-handle)", () => {
    const def: WorkflowDefinitionLike = {
      name: 'demo',
      nodes: [{ id: 'route', switch: { value: '$ARGUMENTS', cases: ['a', 'b'] } }],
    };
    const { nodes } = buildGraphFromDefinition(def);
    expect(nodes[0].branches).toEqual(['a', 'b', 'default']);
  });

  it('leaves branches undefined for non-control-flow variants', () => {
    const def: WorkflowDefinitionLike = {
      name: 'demo',
      nodes: [{ id: 'echo', bash: 'echo x' }],
    };
    const { nodes } = buildGraphFromDefinition(def);
    expect(nodes[0].branches).toBeUndefined();
  });

  it('surfaces approval.delivery on the GraphNode when present (W4)', () => {
    const def: WorkflowDefinitionLike = {
      name: 'gate-channels',
      nodes: [
        { id: 'gate', approval: { message: 'go?', delivery: 'pushcut' } },
      ],
    };
    const { nodes } = buildGraphFromDefinition(def);
    expect(nodes[0].approvalDelivery).toBe('pushcut');
  });

  it('omits approvalDelivery when not specified (W4)', () => {
    const def: WorkflowDefinitionLike = {
      name: 'gate-no-channel',
      nodes: [{ id: 'gate', approval: { message: 'go?' } }],
    };
    const { nodes } = buildGraphFromDefinition(def);
    expect(nodes[0].approvalDelivery).toBeUndefined();
  });

  it('handles a node with multi-source depends_on (fan-in)', () => {
    const def: WorkflowDefinitionLike = {
      name: 'fan-in',
      nodes: [
        { id: 'a', bash: 'a' },
        { id: 'b', bash: 'b' },
        { id: 'merge', prompt: 'collate', depends_on: ['a', 'b'] },
      ],
    };
    const { edges } = buildGraphFromDefinition(def);
    expect(edges.map((e) => e.id)).toEqual(['a->merge', 'b->merge']);
  });
});

describe('layoutGraph', () => {
  const def: WorkflowDefinitionLike = {
    name: 'linear',
    nodes: [
      { id: 'a', bash: 'a' },
      { id: 'b', bash: 'b', depends_on: ['a'] },
      { id: 'c', bash: 'c', depends_on: ['b'] },
    ],
  };

  it('Tier E1.2 — LR is the default: x increases along the chain', () => {
    const layout = workflowToLayout(def);
    expect(layout.nodes).toHaveLength(3);
    const xs = layout.nodes.map((n) => n.position.x);
    // 'a' left of 'b' left of 'c' (LR by default after Tier E1.2).
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
  });

  it('Tier E1.2 — LR linear chain stays on a single row (constant y)', () => {
    const layout = workflowToLayout(def);
    const ys = new Set(layout.nodes.map((n) => n.position.y));
    expect(ys.size).toBe(1);
  });

  it('Tier E1.2 — fan-in puts both upstream nodes in the same column (LR default)', () => {
    const fanIn: WorkflowDefinitionLike = {
      name: 'fan-in',
      nodes: [
        { id: 'a', bash: 'a' },
        { id: 'b', bash: 'b' },
        { id: 'merge', prompt: 'm', depends_on: ['a', 'b'] },
      ],
    };
    const layout = workflowToLayout(fanIn);
    const a = layout.nodes.find((n) => n.id === 'a')!;
    const b = layout.nodes.find((n) => n.id === 'b')!;
    const merge = layout.nodes.find((n) => n.id === 'merge')!;
    // a/b share x (same column); merge to the right.
    expect(a.position.x).toBe(b.position.x);
    expect(merge.position.x).toBeGreaterThan(a.position.x);
  });

  it('explicit TB direction still puts y-increasing chain (legacy)', () => {
    const layout = workflowToLayout(def, { direction: 'TB' });
    const ys = layout.nodes.map((n) => n.position.y);
    expect(ys[1]).toBeGreaterThan(ys[0]);
    expect(ys[2]).toBeGreaterThan(ys[1]);
  });

  it('produces a sane bounds rectangle covering all nodes', () => {
    const layout = workflowToLayout(def);
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
    for (const n of layout.nodes) {
      expect(n.position.x + n.width).toBeLessThanOrEqual(layout.bounds.width + 0.01);
      expect(n.position.y + n.height).toBeLessThanOrEqual(layout.bounds.height + 0.01);
    }
  });

  it('returns an empty graph for an empty node list', () => {
    const empty: WorkflowDefinitionLike = { name: 'empty', nodes: [] };
    const layout = workflowToLayout(empty);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
  });
});

describe('workflowToLayout — _meta.layout overrides (ROADMAP W3)', () => {
  const base: WorkflowDefinitionLike = {
    name: 'demo',
    nodes: [
      { id: 'a', bash: 'echo a' },
      { id: 'b', bash: 'echo b', depends_on: ['a'] },
    ],
  };

  it('honors per-node positions from _meta.layout', () => {
    const def: WorkflowDefinitionLike = {
      ...base,
      _meta: { layout: { a: { x: 500, y: 200 }, b: { x: 700, y: 400 } } },
    };
    const layout = workflowToLayout(def);
    const a = layout.nodes.find((n) => n.id === 'a')!;
    const b = layout.nodes.find((n) => n.id === 'b')!;
    expect(a.position).toEqual({ x: 500, y: 200 });
    expect(b.position).toEqual({ x: 700, y: 400 });
  });

  it('falls back to dagre for nodes missing an override', () => {
    const def: WorkflowDefinitionLike = {
      ...base,
      _meta: { layout: { a: { x: 999, y: 999 } } },
    };
    const layout = workflowToLayout(def);
    const a = layout.nodes.find((n) => n.id === 'a')!;
    const b = layout.nodes.find((n) => n.id === 'b')!;
    expect(a.position).toEqual({ x: 999, y: 999 });
    // b uses dagre — not 999, and y should be below a's dagre row.
    expect(b.position.x).not.toBe(999);
  });

  it('skips malformed _meta.layout entries (silently)', () => {
    const def: WorkflowDefinitionLike = {
      ...base,
      _meta: { layout: { a: { x: 'no' as unknown as number, y: 0 }, b: null as unknown as { x: number; y: number } } },
    };
    const layout = workflowToLayout(def);
    // Both nodes fall through to dagre.
    expect(layout.nodes.every((n) => typeof n.position.x === 'number')).toBe(true);
  });

  it('ignores top-level _meta when layout key is absent', () => {
    const def: WorkflowDefinitionLike = {
      ...base,
      _meta: { somethingElse: 'preserved' },
    };
    const layout = workflowToLayout(def);
    expect(layout.nodes.length).toBe(2);
  });

  it('recomputes bounds when an override falls outside the dagre rect', () => {
    const def: WorkflowDefinitionLike = {
      ...base,
      _meta: { layout: { a: { x: 10_000, y: 10_000 } } },
    };
    const layout = workflowToLayout(def);
    expect(layout.bounds.width).toBeGreaterThan(10_000);
    expect(layout.bounds.height).toBeGreaterThan(10_000);
  });
});

describe('plugin node badge (K3 실물 2026-09-30 · plugin nodes showed «UNKNOWN»)', () => {
  it('a plugin kind node is labelled by its kind and previews its first input', () => {
    const graph = buildGraphFromDefinition({ name: 'w', nodes: [{ id: 'report', kind: 'elanous-hwp:from-md', inputs: { markdown: '# 주간 보고\n- 한 줄', template: 'report' } }] } as never);
    const node = graph.nodes.find((n) => n.id === 'report')!;
    expect(node.badge).toBe('elanous-hwp:from-md');
    expect(node.preview).toBe('# 주간 보고');
    expect(nodeBadgeLabel({ kind: 'elanous-hwp:to-md' }, 'unknown')).toBe('elanous-hwp:to-md');
  });
  it('core nodes keep their variant badge', () => {
    expect(nodeBadgeLabel({ bash: 'echo hi' }, 'bash')).toBe('bash');
    expect(nodeBadgeLabel({}, 'unknown')).toBe('unknown');
  });
});
