import { afterAll, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, create } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { NexusClient } from '@/nexus/client';
import { WorkflowHistoryPanel } from './WorkflowHistoryPanel';
import { WorkflowsPanel } from './WorkflowsPanel';

const name = 'my-flow';
const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; window?: unknown };
const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
const previousWindow = globals.window;
globals.IS_REACT_ACT_ENVIRONMENT = true;

async function mount(client: NexusClient, onLoad = mock((_yaml: string) => {})) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = mock(() => {});
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <NexusProvider client={client} queryClient={queryClient}>
        <WorkflowHistoryPanel name={name} onLoad={onLoad} onClose={onClose} />
      </NexusProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const close = async () => {
    await act(async () => renderer.unmount());
    queryClient.clear();
  };
  const select = async (selected: string) => {
    await act(async () => renderer.update(
      <NexusProvider client={client} queryClient={queryClient}>
        <WorkflowHistoryPanel name={selected} onLoad={onLoad} onClose={onClose} />
      </NexusProvider>,
    ));
  };
  return { renderer, onLoad, onClose, close, select, text: () => JSON.stringify(renderer.toJSON()) };
}

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
  else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test('lists localized times and sizes, loads selected YAML into draft only, and closes', async () => {
  const versions = [
    { id: 'new', createdAt: '2026-10-01T12:30:00.000Z', size: 1536 },
    { id: 'old', createdAt: '2026-09-30T09:00:00.000Z', size: 12 },
  ];
  const getWorkflowHistory = mock(async (_name: string) => ({ versions }));
  const getWorkflowHistoryVersion = mock(async (_name: string, id: string) => ({ yaml: `name: ${id}\n` }));
  const saveWorkflow = mock(async () => ({ ok: true as const, path: '', scope: 'project' }));
  const panel = await mount({ getWorkflowHistory, getWorkflowHistoryVersion, saveWorkflow } as unknown as NexusClient);
  expect(getWorkflowHistory).toHaveBeenCalledWith(name);
  const rows = panel.renderer.root.findAllByType('li');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.findByType('time').props.dateTime).toBe(versions[0]!.createdAt);
  expect(rows[0]!.findByType('time').children.join('')).toBe(new Date(versions[0]!.createdAt).toLocaleString());
  expect(rows[0]!.findByType('button').children).toContain('불러오기');
  expect(rows[0]!.findAllByType('span')[0]!.children.join('')).toBe(`${versions[0]!.size.toLocaleString()} B`);
  expect(rows[1]!.findAllByType('span')[0]!.children.join('')).toBe('12 B');
  expect(panel.text()).not.toContain('초안에 불러왔습니다');
  await act(async () => rows[1]!.findByType('button').props.onClick());
  expect(getWorkflowHistoryVersion).toHaveBeenCalledWith(name, 'old');
  expect(panel.onLoad).toHaveBeenCalledWith('name: old\n');
  expect(saveWorkflow).not.toHaveBeenCalled();
  expect(panel.text()).toContain('이전 판을 초안에 불러왔습니다. 저장하려면 Save를 누르세요.');
  await act(async () => panel.renderer.root.findByProps({ 'aria-label': '이전 판 닫기' }).props.onClick());
  expect(panel.onClose).toHaveBeenCalledTimes(1);
  await panel.close();
});

test('workflow history entry stays in the selected workflow bottom action row and loads draft only', () => {
  const source = readFileSync(new URL('./WorkflowsPanel.tsx', import.meta.url), 'utf8');
  const historyView = source.match(/showHistory && selectedName && !creatingNew \? \([\s\S]*?<WorkflowHistoryPanel[\s\S]*?\/>/);
  const bottomActions = source.match(/<footer className="flex items-center justify-end[\s\S]*?<\/footer>/);

  expect(historyView?.[0]).toMatch(/onLoad=\{\(yaml\) => \{\s*setDraftYaml\(yaml\);\s*setEditorMode\('yaml'\);\s*\}\}/);
  expect(historyView?.[0]).not.toContain('handleSave');
  expect(bottomActions?.[0]).toMatch(/\{selectedName && !creatingNew && \([\s\S]*?onClick=\{\(\) => setShowHistory\(true\)\}[\s\S]*?이전 판/);
  expect(bottomActions?.[0].indexOf('이전 판')).toBeLessThan(bottomActions?.[0].indexOf('Delete') ?? 0);
});

test('workflow editor entry loads a previous version into its draft without saving', async () => {
  globals.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const restored = 'name: demo\nnodes: []\n';
  const getWorkflowHistory = mock(async (_name: string) => ({
    versions: [{ id: 'v1', createdAt: '2026-10-01T12:30:00.000Z', size: 21 }],
  }));
  const getWorkflowHistoryVersion = mock(async (_name: string, _id: string) => ({ yaml: restored }));
  const saveWorkflow = mock(async () => ({ ok: true as const, path: 'demo.yaml', scope: 'project' }));
  const client = {
    baseUrl: 'http://localhost:9999',
    workflowsEventsUrl: () => null,
    getWorkflows: async () => ({ workflows: [{ name: 'demo', path: 'demo.yaml', source: 'project', nodeCount: 0 }] }),
    getWorkflow: async () => ({ name: 'demo', yaml: 'name: demo\nnodes: []\n# current', source: 'project' }),
    getWorkflowRuns: async () => ({ runs: [] }),
    getPendingApprovals: async () => ({ pending: [] }),
    getWorkflowHistory,
    getWorkflowHistoryVersion,
    saveWorkflow,
  } as unknown as NexusClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={client} queryClient={queryClient}><WorkflowsPanel /></NexusProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => renderer.root.findByProps({ title: 'demo.yaml' }).props.onClick());
  const findButton = (label: string) => renderer.root.findAllByType('button').find((button) => button.children.includes(label))!;
  await act(async () => findButton('이전 판').props.onClick());
  expect(getWorkflowHistory).toHaveBeenCalledWith('demo');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => findButton('불러오기').props.onClick());
  expect(getWorkflowHistoryVersion).toHaveBeenCalledWith('demo', 'v1');
  expect(JSON.stringify(renderer.toJSON())).toContain('이전 판을 초안에 불러왔습니다');
  await act(async () => renderer.root.findByProps({ 'aria-label': '이전 판 닫기' }).props.onClick());
  expect(renderer.root.findByType('textarea').props.value).toBe(restored);
  expect(saveWorkflow).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  queryClient.clear();
});

test('late version response after closing does not overwrite the draft', async () => {
  let resolveVersion!: (value: { yaml: string }) => void;
  const version = new Promise<{ yaml: string }>((resolve) => { resolveVersion = resolve; });
  const panel = await mount({
    getWorkflowHistory: async () => ({ versions: [{ id: 'v1', createdAt: '2026-10-01T12:30:00.000Z', size: 5 }] }),
    getWorkflowHistoryVersion: async () => version,
  } as unknown as NexusClient);
  await act(async () => { panel.renderer.root.findByType('li').findByType('button').props.onClick(); });
  await act(async () => panel.renderer.root.findByProps({ 'aria-label': '이전 판 닫기' }).props.onClick());
  await act(async () => resolveVersion({ yaml: 'stale draft' }));
  expect(panel.onLoad).not.toHaveBeenCalled();
  expect(panel.text()).not.toContain('초안에 불러왔습니다');
  await panel.close();
});

test('late version response after changing selected workflow does not load stale YAML', async () => {
  let resolveVersion!: (value: { yaml: string }) => void;
  const version = new Promise<{ yaml: string }>((resolve) => { resolveVersion = resolve; });
  const panel = await mount({
    getWorkflowHistory: async () => ({ versions: [{ id: 'v1', createdAt: '2026-10-01T12:30:00.000Z', size: 5 }] }),
    getWorkflowHistoryVersion: async () => version,
  } as unknown as NexusClient);
  await act(async () => { panel.renderer.root.findByType('li').findByType('button').props.onClick(); });
  await panel.select('other-flow');
  await act(async () => resolveVersion({ yaml: 'stale draft' }));
  expect(panel.onLoad).not.toHaveBeenCalled();
  expect(panel.text()).not.toContain('초안에 불러왔습니다');
  await panel.close();
});

test('empty history shows the requested empty state without a load action', async () => {
  const getWorkflowHistory = mock(async () => ({ versions: [] }));
  const panel = await mount({ getWorkflowHistory } as unknown as NexusClient);
  expect(panel.text()).toContain('아직 이전 판이 없습니다');
  expect(panel.renderer.root.findAllByType('li')).toHaveLength(0);
  await panel.close();
});

test('failed version fetch does not load or confirm a draft, and can be retried', async () => {
  const getWorkflowHistoryVersion = mock(async () => { throw new Error('missing'); });
  const panel = await mount({
    getWorkflowHistory: async () => ({ versions: [{ id: 'v1', createdAt: '2026-10-01T12:30:00.000Z', size: 5 }] }),
    getWorkflowHistoryVersion,
  } as unknown as NexusClient);
  await act(async () => panel.renderer.root.findByType('li').findByType('button').props.onClick());
  expect(panel.onLoad).not.toHaveBeenCalled();
  expect(panel.text()).toContain('이전 판을 불러오지 못했습니다');
  expect(panel.text()).not.toContain('초안에 불러왔습니다');
  expect(panel.renderer.root.findByType('li').findByType('button').props.disabled).toBe(false);
  await panel.close();
});
