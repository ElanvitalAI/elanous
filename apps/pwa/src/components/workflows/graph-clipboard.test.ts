import { describe, expect, it } from 'bun:test';
import { copyNodes, pasteNodes } from './graph-clipboard';
import type { WorkflowDefinitionLike } from './workflow-graph-layout';

const seed: WorkflowDefinitionLike = {
  name: 'demo',
  nodes: [
    { id: 'a', bash: 'echo a', config: { nested: ['original'] } },
    { id: 'b', bash: 'echo b', depends_on: ['a'] },
    { id: 'c', prompt: 'inspect', depends_on: ['a', 'b'] },
    { id: 'bash-1', bash: 'reserved' },
  ],
  _meta: {
    owner: 'team',
    layout: {
      a: { x: 100, y: 200 },
      b: { x: 300, y: 400 },
      c: { x: 500, y: 600 },
      'bash-1': { x: 700, y: 800 },
    },
  },
};

describe('copyNodes', () => {
  it('returns null for empty or unknown selection', () => {
    expect(copyNodes(seed, [])).toBeNull();
    expect(copyNodes(seed, ['missing'])).toBeNull();
  });

  it('copies only selected nodes and edges with both ends selected', () => {
    const before = structuredClone(seed);
    const clipboard = copyNodes(seed, ['b', 'c', 'missing'])!;
    expect(clipboard.nodes).toEqual([
      { id: 'b', bash: 'echo b' },
      { id: 'c', prompt: 'inspect', depends_on: ['b'] },
    ]);
    expect(clipboard.layout).toEqual({ b: { x: 300, y: 400 }, c: { x: 500, y: 600 } });
    expect(seed).toEqual(before);
  });

  it('detaches node payload and position snapshots from the source', () => {
    const clipboard = copyNodes(seed, ['a'])!;
    (clipboard.nodes[0]!.config as { nested: string[] }).nested.push('copy');
    clipboard.layout.a!.x = -1;
    expect(seed.nodes[0]!.config).toEqual({ nested: ['original'] });
    expect((seed._meta as { layout: Record<string, { x: number }> }).layout.a!.x).toBe(100);
  });
});

describe('pasteNodes', () => {
  it('uses next free ids, remaps only copied internal edges, and offsets positions', () => {
    const clipboard = copyNodes(seed, ['a', 'b', 'c'])!;
    const before = structuredClone(seed);
    const pasted = pasteNodes(seed, clipboard);
    expect(pasted.nodes.slice(4)).toEqual([
      { id: 'bash-2', bash: 'echo a', config: { nested: ['original'] } },
      { id: 'bash-3', bash: 'echo b', depends_on: ['bash-2'] },
      { id: 'prompt-1', prompt: 'inspect', depends_on: ['bash-2', 'bash-3'] },
    ]);
    expect(pasted.nodes.slice(0, 4)).toEqual(seed.nodes);
    expect(pasted._meta).toEqual({
      owner: 'team',
      layout: {
        ...(seed._meta as { layout: object }).layout,
        'bash-2': { x: 140, y: 240 },
        'bash-3': { x: 340, y: 440 },
        'prompt-1': { x: 540, y: 640 },
      },
    });
    expect(seed).toEqual(before);
    expect(clipboard.nodes[1]!.depends_on).toEqual(['a']);
  });

  it('repeated paste avoids collisions and never reconnects to original nodes', () => {
    const clipboard = copyNodes(seed, ['b', 'c'])!;
    const first = pasteNodes(seed, clipboard);
    const second = pasteNodes(first, clipboard);
    expect(first.nodes.slice(4).map(({ id, depends_on }) => ({ id, depends_on }))).toEqual([
      { id: 'bash-2', depends_on: undefined },
      { id: 'prompt-1', depends_on: ['bash-2'] },
    ]);
    expect(second.nodes.slice(6).map(({ id, depends_on }) => ({ id, depends_on }))).toEqual([
      { id: 'bash-3', depends_on: undefined },
      { id: 'prompt-2', depends_on: ['bash-3'] },
    ]);
    expect(first.nodes[1]!.depends_on).toEqual(['a']);
    expect(first.nodes[2]!.depends_on).toEqual(['a', 'b']);
  });

  it('does not introduce empty metadata on empty paste', () => {
    const bare: WorkflowDefinitionLike = { name: 'bare', nodes: [] };
    expect(pasteNodes(bare, { nodes: [], layout: {} })).toBe(bare);
  });
});
