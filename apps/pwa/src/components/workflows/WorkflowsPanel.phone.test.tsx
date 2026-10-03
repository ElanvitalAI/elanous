import { afterAll, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { NexusClient } from '@/nexus/client';
import { WorkflowsPanel } from './WorkflowsPanel';

const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousWindow = globals.window;
const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
globals.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
  else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test('server rendering without window keeps the configured editor in wide layout', () => {
  delete globals.window;
  const client = { baseUrl: 'http://localhost:9999', workflowsEventsUrl: () => null } as unknown as NexusClient;
  const queryClient = new QueryClient();
  const markup = renderToStaticMarkup(<NexusProvider client={client} queryClient={queryClient}><WorkflowsPanel /></NexusProvider>);
  expect(markup).not.toContain('편집기 칸');
  expect(markup).toContain('Resize workflow list');
  expect(markup).toContain('Resize run panel');
  queryClient.clear();
});

test('phone tabs show one full-width pane, selection opens canvas, and resizing restores wide panes', async () => {
  let phone = true;
  const mediaListeners = new Set<() => void>();
  globals.window = {
    matchMedia: (query: string) => ({
      matches: phone && query === '(max-width: 639px)',
      addEventListener: (_event: string, callback: () => void) => mediaListeners.add(callback),
      removeEventListener: (_event: string, callback: () => void) => mediaListeners.delete(callback),
    }),
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const client = {
    baseUrl: 'http://localhost:9999',
    workflowsEventsUrl: () => null,
    getWorkflows: async () => ({ workflows: [{ name: 'demo', path: 'demo.yaml', source: 'project', nodeCount: 0 }] }),
    getWorkflow: async () => ({ name: 'demo', yaml: '', source: 'project' }),
    getWorkflowRuns: async () => ({ runs: [] }),
    getPendingApprovals: async () => ({ pending: [] }),
  } as unknown as NexusClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={client} queryClient={queryClient}><WorkflowsPanel /></NexusProvider>);
  });
  const nav = () => renderer.root.findByProps({ 'aria-label': '편집기 칸' });
  const panes = () => renderer.root.findAllByType('aside');
  const tab = (label: string) => nav().findAllByType('button').find((button) => button.children.includes(label))!;
  expect(nav().findAllByType('button')).toHaveLength(3);
  expect(tab('목록').props['aria-selected']).toBe(true);
  expect(panes()).toHaveLength(1);
  expect(panes()[0]!.props.className).toContain('w-full');
  expect(renderer.root.findAllByType('section')).toHaveLength(0);

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    renderer.root.findAllByType('button').find((button) => button.props.title === 'demo.yaml')!.props.onClick();
  });
  expect(tab('캔버스').props['aria-selected']).toBe(true);
  expect(renderer.root.findAllByType('section')).toHaveLength(1);
  expect(panes()).toHaveLength(0);

  await act(async () => tab('실행').props.onClick());
  expect(tab('실행').props['aria-selected']).toBe(true);
  expect(renderer.root.findAllByType('section')).toHaveLength(0);
  expect(panes()).toHaveLength(1);
  expect(panes()[0]!.props.className).toContain('w-full');
  expect(panes()[0]!.findAllByType('input')).toHaveLength(1);

  await act(async () => tab('목록').props.onClick());
  expect(tab('목록').props['aria-selected']).toBe(true);
  expect(panes()).toHaveLength(1);
  await act(async () => tab('실행').props.onClick());

  await act(async () => { phone = false; for (const notify of mediaListeners) notify(); });
  expect(renderer.root.findAllByProps({ 'aria-label': '편집기 칸' })).toHaveLength(0);
  expect(renderer.root.findAllByType('section')).toHaveLength(1);
  expect(panes()).toHaveLength(2);
  expect(panes()[0]!.props.style.width).toBe(240);
  expect(panes()[1]!.props.style.width).toBe(320);
  await act(async () => {
    renderer.root.findByProps({ title: 'Collapse workflow list' }).props.onClick();
  });
  expect(panes()[0]!.props.style.width).toBe(40);

  await act(async () => { phone = true; for (const notify of mediaListeners) notify(); });
  expect(tab('실행').props['aria-selected']).toBe(true);
  expect(panes()).toHaveLength(1);
  await act(async () => tab('목록').props.onClick());
  expect(panes()[0]!.props.className).toContain('w-full');
  expect(panes()[0]!.findAllByType('button').some((button) => button.props.title === 'demo.yaml')).toBe(true);
  await act(async () => { phone = false; for (const notify of mediaListeners) notify(); });
  expect(panes()[0]!.props.style.width).toBe(40);
  await act(async () => renderer.unmount());
  expect(mediaListeners.size).toBe(0);
  queryClient.clear();
});
