import { afterAll, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { type NexusClient, type RunGraphDetail } from '@/nexus/client';
import { RunGraphView } from './RunGraphView';
import { WorkflowGraph } from './WorkflowGraph';

// The test renderer has no DOM; the canvas only needs keyboard listener registration.
const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousWindow = globals.window;
const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
globals.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
globals.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
  else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const detail: RunGraphDetail = {
  id: 'research-loop', source: 'core', editable: false,
  entry_node: 'investigate', terminal_nodes: ['merge'],
  nodes: [
    { node_id: 'investigate', kind: 'agent', recipe: 'headless-goal-loop', max_visits: 7 },
    { node_id: 'judge', kind: 'judge', recipe: 'pr-reviewer', max_visits: 4 },
    { node_id: 'merge', kind: 'git', recipe: 'seams-gh-merge-squash', max_visits: 2 },
  ],
  edges: [
    { from: 'investigate', on: 'changed-files', map: { 'documents-only': 'judge' } },
    { from: 'judge', to: 'merge' },
  ],
};

function fixture() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = {
    baseUrl: 'http://localhost',
    workflowsEventsUrl: () => null,
    getWorkflows: async () => ({ workflows: [] }),
    getWorkflowRuns: async () => ({ runs: [] }),
    getPendingApprovals: async () => ({ pending: [] }),
    getRunGraphs: async () => ({ graphs: [{ id: 'research-loop', source: 'core' as const, editable: false, nodeCount: 3 }] }),
    getRunGraph: async () => detail,
    getRunGraphYaml: async () => ({ id: 'research-loop', source: 'core' as const, editable: false, yaml: '' }),
    getGraphKinds: async () => ({ kinds: [] }),
    validateGraph: async () => ({ ok: true, errors: [], ignoredKeys: [] }),
    putRunGraphYaml: async () => { throw new Error('core is read-only'); },
    cloneRunGraph: async (id: string, newId: string) => ({ id: newId, source: 'mine' as const, editable: true as const, clonedFrom: id }),
  } as unknown as NexusClient;
  return { queries, client };
}

test('RunGraphView renders a core list and non-interactive outcome-labelled canvas without write controls', async () => {
  const { queries, client } = fixture();
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={client} queryClient={queries}><RunGraphView /></NexusProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(queries.getQueryData(['run-graphs'])).toMatchObject({ graphs: [{ id: 'research-loop' }] });
  expect(queries.getQueryData(['run-graph', 'research-loop'])).toMatchObject({ id: 'research-loop' });
  const canvas = renderer.root.findByType(ReactFlow);
  expect(canvas.props.nodes.find((node: { id: string }) => node.id === 'investigate').data.entry).toBe(true);
  expect(canvas.props.edges).toContainEqual(expect.objectContaining({ source: 'investigate', target: 'judge', label: 'documents-only' }));
  expect(canvas.props.nodesDraggable).toBe(false);
  expect(canvas.props.nodesConnectable).toBe(false);
  expect(canvas.props.edgesReconnectable).toBe(false);
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('research-loop');
  expect(renderer.root.findAllByType('button').find((button) => button.props['aria-current'] === 'true')).toBeDefined();
  expect(text).toContain('읽기 전용');
  expect(text).toContain('복제해서 고치기');
  expect(text).not.toContain('저장');
  expect(text).not.toContain('Save');
  expect(text).not.toContain('Delete');
  await act(async () => renderer.unmount());
  queries.clear();
});

test('workflow canvas palette inserts a registered plugin kind using the existing workflow graph', async () => {
  let yaml = '';
  const { queries, client } = fixture();
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={client} queryClient={queries}>
      <WorkflowGraph yaml={'name: sample\nnodes: []\n'} definition={{ name: 'sample', nodes: [] }} editable
        palette={[{ graph: 'workflow', kind: 'demo:step', plugin: 'demo', core: false, description: 'step' }]}
        onChangeYaml={(text) => { yaml = text; }} />
    </NexusProvider>);
  });
  const add = renderer.root.findAllByType('button').find((button) => button.children.includes('+ demo:step'));
  expect(add).toBeDefined();
  add!.props.onClick();
  expect(yaml).toContain('kind: demo:step');
  expect(yaml).toContain('inputs: {}');
  await act(async () => renderer.unmount());
  queries.clear();
});

test('a mine graph validates before saving and warns about ignored keys without losing its draft', async () => {
  const { queries, client } = fixture();
  let writes = 0;
  let validations = 0;
  const mine = {
    ...client,
    getRunGraphs: async () => ({ graphs: [{ id: 'research-loop-mine', source: 'mine', editable: true, nodeCount: 3 }] }),
    getRunGraph: async () => ({ ...detail, id: 'research-loop-mine', source: 'mine', editable: true }),
    getRunGraphYaml: async () => ({ id: 'research-loop-mine', source: 'mine', editable: true, yaml: 'graph_id: research-loop-mine\nversion: 5\n' }),
    validateGraph: async (graph: string, yaml: string) => {
      validations++;
      expect(graph).toBe('harness');
      expect(yaml).toBe('graph_id: research-loop-mine\nversion: 5\n');
      return { ok: false, errors: [{ message: 'nodes 가 비었다' }], ignoredKeys: ['nodes[0].extra'] };
    },
    putRunGraphYaml: async () => { writes++; throw new Error('validation must block PUT'); },
  } as unknown as NexusClient;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={mine} queryClient={queries}><RunGraphView /></NexusProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('내 그래프');
  expect(text).toContain('agent');
  expect(text).toContain('subgraph');
  const save = renderer.root.findAllByType('button').find((button) => button.children.includes('저장'));
  expect(save).toBeDefined();
  await act(async () => save!.props.onClick());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(JSON.stringify(renderer.toJSON())).toContain('nodes 가 비었다');
  expect(JSON.stringify(renderer.toJSON())).toContain('nodes[0].extra');
  expect(validations).toBe(1);
  expect(writes).toBe(0);
  expect(queries.getQueryData(['run-graph-yaml', 'research-loop-mine'])).toMatchObject({ yaml: 'graph_id: research-loop-mine\nversion: 5\n' });
  await act(async () => renderer.unmount());
  queries.clear();
});

test('valid mine graph saves after validation and keeps ignored-key warning visible', async () => {
  const { queries, client } = fixture();
  const calls: string[] = [];
  const mine = {
    ...client,
    getRunGraphs: async () => ({ graphs: [{ id: 'mine', source: 'mine', editable: true, nodeCount: 3 }] }),
    getRunGraph: async () => ({ ...detail, id: 'mine', source: 'mine', editable: true }),
    getRunGraphYaml: async () => ({ id: 'mine', source: 'mine', editable: true, yaml: 'graph_id: mine\n' }),
    validateGraph: async (graph: string, yaml: string) => {
      calls.push(`validate:${graph}:${yaml}`);
      return { ok: true, errors: [], ignoredKeys: ['unused'] };
    },
    putRunGraphYaml: async (id: string, yaml: string) => {
      calls.push(`put:${id}:${yaml}`);
      return { id, source: 'mine', editable: true, saved: true };
    },
  } as unknown as NexusClient;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={mine} queryClient={queries}><RunGraphView /></NexusProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const save = renderer.root.findAllByType('button').find((button) => button.children.includes('저장'));
  await act(async () => save!.props.onClick());
  expect(calls).toEqual(['validate:harness:graph_id: mine\n', 'put:mine:graph_id: mine\n']);
  expect(renderer.root.findAllByProps({ role: 'status' }).some((item) => item.children.join('') === '무시되는 키: unused')).toBe(true);
  await act(async () => renderer.unmount());
  queries.clear();
});
