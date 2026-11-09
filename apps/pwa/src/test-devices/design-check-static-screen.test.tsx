import { afterEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { createFakeFetchDevice } from '../../../../src/ux-sim/fake-fetch.js';
import { createNexusClient, type DesignCheckOk } from '../nexus/client';
import { NexusProvider } from '../nexus/hooks/use-nexus-context';
import { DesignCheckPanel } from '../components/design/DesignCheckPanel';

const RESPONSE: DesignCheckOk = {
  ok: true,
  repoRoot: '/fixture/kaist-demo-console',
  repoSource: 'config',
  documentPath: '/fixture/kaist-demo-console/DESIGN.md',
  craftDirectory: '/fixture/kaist-demo-console/docs/design/craft',
  availableRulebooks: ['accessible-controls'],
  declaredRulebooks: ['accessible-controls'],
  unavailableRulebooks: [],
  exitCode: 0,
};

const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
  if (originalActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}

async function settle(): Promise<void> {
  await act(async () => { await Bun.sleep(100); });
}

describe.serial('design-check static screen contract', () => {
  test('server-rendered static markup contains the connect state', () => {
    const html = renderToStaticMarkup(<DesignCheckPanel />);
    expect(html).toContain('Connect to a NEXUS daemon');
    expect(html).not.toContain('Loading…');
  });
  test('SSG without a Nexus provider renders a stable connect state, not a loading screen', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let root!: ReturnType<typeof create>;
    act(() => { root = create(<DesignCheckPanel />); });
    try {
      const frame = text(root.root);
      expect(frame).toContain('Connect to a NEXUS daemon');
      expect(frame).not.toContain('Loading…');
    } finally {
      act(() => root.unmount());
    }
  });

  test('the production panel renders the design-check API fixture through the real Nexus client', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const device = createFakeFetchDevice([
      { url: '/v1/design-check', response: Response.json(RESPONSE) },
      { url: '/v1/design-previews', response: Response.json({ previews: [] }) },
    ]);
    const client = createNexusClient({ baseUrl: 'http://design-check-fixture' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(<NexusProvider client={client} queryClient={queryClient}><DesignCheckPanel /></NexusProvider>);
        await Bun.sleep(0);
      });
      await settle();
      const frame = text(root.root);
      expect(frame).toContain('All 1 declared rulebook resolve.');
      expect(frame).toContain('accessible-controls');
      expect(frame).toContain('Declared');
      expect(frame).not.toContain('Loading…');
      expect(device.calls()).toMatchObject([
        { method: 'GET', url: 'http://design-check-fixture/v1/design-check', status: 200 },
        { method: 'GET', url: 'http://design-check-fixture/v1/design-previews', status: 200 },
      ]);
      expect(device.calls().every((call) => call.error === undefined)).toBe(true);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
      device.restore();
    }
  });

  test('a refused daemon connection is shown as an error instead of loading', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const device = createFakeFetchDevice([
      { url: '/v1/design-check', response: () => { throw new TypeError('connection refused'); } },
    ]);
    const client = createNexusClient({ baseUrl: 'http://design-check-fixture' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: true } } });
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(<NexusProvider client={client} queryClient={queryClient}><DesignCheckPanel /></NexusProvider>);
        await Bun.sleep(0);
      });
      await settle();
      const frame = text(root.root);
      expect(frame).toContain('Could not reach the daemon:');
      expect(frame).toContain('connection refused');
      expect(frame).not.toContain('Loading…');
      expect(device.calls()).toHaveLength(1);
      expect(device.calls()[0]?.error).toBe('connection refused');
    } finally {
      act(() => root.unmount());
      queryClient.clear();
      device.restore();
    }
  });

  test('an unavailable daemon exposes the connection error after one failed request', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const device = createFakeFetchDevice([
      { url: '/v1/design-check', response: Response.json({ error: 'offline' }, { status: 503 }) },
    ]);
    const client = createNexusClient({ baseUrl: 'http://design-check-fixture' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: true } } });
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(<NexusProvider client={client} queryClient={queryClient}><DesignCheckPanel /></NexusProvider>);
        await Bun.sleep(0);
      });
      await settle();
      const frame = text(root.root);
      expect(frame).toContain('Could not reach the daemon:');
      expect(frame).not.toContain('Loading…');
      expect(device.calls()).toMatchObject([
        { method: 'GET', url: 'http://design-check-fixture/v1/design-check', status: 503 },
      ]);
      expect(device.calls()).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
      device.restore();
    }
  });
});
