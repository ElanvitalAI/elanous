import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { GraphKindEntry, NexusClient, RunGraphDetail } from '@/nexus/client';
import { RunGraphView } from '@/components/workflows/RunGraphView';
import { CORE_GRAPH_KINDS, CORE_WORKFLOW_KINDS } from '@/lib/run-graph-yaml-edit';
import { GraphEditorScene } from './GraphEditorScene';

let graphMounts = 0;
let workflowMounts = 0;

function GraphStandIn({ palette, initialGraphId }: { palette?: GraphKindEntry[]; initialGraphId?: string }) {
  const [draft, setDraft] = useState(() => { graphMounts++; return ''; });
  return <input aria-label="graph draft" value={draft} onChange={(event) => setDraft(event.target.value)} data-initial-graph={initialGraphId} data-palette={palette?.map((item) => `${item.graph}:${item.kind}`).join(',')} />;
}

function WorkflowStandIn({ palette }: { palette?: GraphKindEntry[] }) {
  const [draft, setDraft] = useState(() => { workflowMounts++; return ''; });
  return <input aria-label="workflow draft" value={draft} onChange={(event) => setDraft(event.target.value)} data-palette={palette?.map((item) => `${item.graph}:${item.kind}`).join(',')} />;
}

describe('GraphEditorScene', () => {
  afterEach(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

  test('keeps both editor drafts mounted and hidden panels inert without changing the address', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    graphMounts = 0;
    workflowMounts = 0;
    const originalWindow = globalThis.window;
    const replaceState = mock(() => {});
    const pushState = mock(() => {});
    globalThis.window = { location: { href: 'https://example.test/inside?scene=4' }, history: { replaceState, pushState } } as unknown as Window & typeof globalThis;
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<GraphEditorScene GraphEditor={GraphStandIn} WorkflowEditor={WorkflowStandIn} />); });
      const tabs = root!.root.findAllByProps({ role: 'tab' });
      const panels = root!.root.findAllByProps({ role: 'tabpanel' });
      expect(tabs.map((tab) => tab.props.children)).toEqual(['실행 그래프', '워크플로']);
      expect(tabs.map((tab) => tab.props['aria-selected'])).toEqual([true, false]);
      expect(panels.map((panel) => panel.props.hidden)).toEqual([false, true]);
      expect(panels[1].props.className).toBe('hidden');
      expect(root!.root.findByType('section').props.className).toContain('min-h-[640px]');
      expect(tabs[0].props.className).toContain('min-[1440px]:text-[22px]');
      expect(root!.root.findByProps({ 'aria-label': 'graph draft' }).props['data-palette']).toBe(CORE_GRAPH_KINDS.map((kind) => `harness:${kind}`).join(','));
      expect(root!.root.findByProps({ 'aria-label': 'graph draft' }).props['data-initial-graph']).toBe('self-implement');
      expect(root!.root.findByProps({ 'aria-label': 'workflow draft' }).props['data-palette']).toBe(CORE_WORKFLOW_KINDS.map((kind) => `workflow:${kind}`).join(','));
      expect(graphMounts).toBe(1);
      expect(workflowMounts).toBe(1);

      act(() => { root!.root.findByProps({ 'aria-label': 'graph draft' }).props.onChange({ target: { value: 'unsaved graph' } }); });
      act(() => { tabs[1].props.onClick(); });
      expect(tabs.map((tab) => tab.props['aria-selected'])).toEqual([false, true]);
      expect(panels.map((panel) => panel.props.hidden)).toEqual([true, false]);
      expect(panels[0].props.className).toBe('hidden');
      act(() => { root!.root.findByProps({ 'aria-label': 'workflow draft' }).props.onChange({ target: { value: 'unsaved workflow' } }); });
      act(() => { tabs[0].props.onClick(); });
      expect(root!.root.findByProps({ 'aria-label': 'graph draft' }).props.value).toBe('unsaved graph');
      act(() => { tabs[1].props.onClick(); });
      expect(root!.root.findByProps({ 'aria-label': 'workflow draft' }).props.value).toBe('unsaved workflow');
      expect(graphMounts).toBe(1);
      expect(workflowMounts).toBe(1);
      expect(globalThis.window.location.href).toBe('https://example.test/inside?scene=4');
      expect(replaceState).not.toHaveBeenCalled();
      expect(pushState).not.toHaveBeenCalled();
    } finally {
      if (root) act(() => { root!.unmount(); });
      globalThis.window = originalWindow;
    }
  });

  test('initial graph prefers self-implement, falls back to the first entry, and a clicked choice survives a list refresh', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = globalThis.window;
    globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window & typeof globalThis;
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ids = ['ad-loop', 'self-implement', 'research-loop'];
    const graphs = (entries: string[]) => ({ graphs: entries.map((id) => ({ id, source: 'core' as const, editable: false, nodeCount: 0 })) });
    const requested: string[] = [];
    const client = {
      getRunGraphs: async () => graphs(ids),
      getRunGraph: (id: string) => { requested.push(id); return new Promise<RunGraphDetail>(() => {}); },
      getGraphKinds: async () => ({ kinds: [] }),
    } as unknown as NexusClient;
    let root: ReturnType<typeof create> | undefined;
    const selected = () => root!.root.findAllByType('button').find((button) => button.props['aria-current'] === 'true')?.findAllByType('span')[0].children[0];
    try {
      await act(async () => { root = create(<NexusProvider client={client} queryClient={queries}><RunGraphView initialGraphId="self-implement" /></NexusProvider>); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(selected()).toBe('self-implement');
      expect(requested).toContain('self-implement');
      await act(async () => { queries.setQueryData(['run-graphs'], graphs(['ad-loop', 'research-loop'])); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(selected()).toBe('ad-loop');
      const research = root!.root.findAllByType('button').find((button) => button.findAllByType('span').some((span) => span.children.includes('research-loop')))!;
      await act(async () => research.props.onClick());
      expect(selected()).toBe('research-loop');
      await act(async () => { queries.setQueryData(['run-graphs'], graphs(ids)); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(selected()).toBe('research-loop');
      expect(requested.at(-1)).toBe('research-loop');
    } finally {
      if (root) await act(async () => root!.unmount());
      queries.clear();
      globalThis.window = originalWindow;
    }
  });
});
