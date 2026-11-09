import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { NexusClient } from '@/nexus/client';
import type { NexusEvent } from '@/nexus/types';
import AppsPage from './page';

const app = { slug: 'voice-notes', name: '음성 메모', description: '회의를 기록합니다.',
  simulation: { status: 'passed', receipt: 'receipt-demo-1114',
    events: [{ kind: 'app.sim.step', appId: 'voice-notes', runId: 'run-demo', ts: 1_794_600_000_000,
      data: { step: 'recording-and-transcription', message: '녹음과 받아쓰기 확인', receiptId: 'receipt-demo-1114' } }],
    receipts: [{ id: 'receipt-demo-1114', appId: 'voice-notes', runId: 'run-demo', createdAt: '2026-11-08T12:00:00.000Z', outcome: 'passed', summary: 'SIM-CHAIN-APP voice-notes · 완료' }] },
  production: { status: 'not-created' } };
const liveApp = { slug: 'published-notes', name: '운영 중인 메모', simulation: { status: 'ready' },
  production: { status: 'not-created' }, lifecycle: { status: 'live', latestReceiptId: null } };
const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node, Event: globalThis.Event, actEnvironment: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
let root: import('react-dom/client').Root;
let host: HTMLElement;
let onNexusEvent: ((event: NexusEvent) => void) | undefined;

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  Object.assign(globalThis, originals);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originals.actEnvironment;
});

async function mount(fetchJson: (path?: string, init?: RequestInit) => Promise<unknown>) {
  const daemonClient = { fetchJson } as unknown as DaemonClient;
  const daemon = { client: daemonClient, config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
  const nexusClient = { subscribeEvents: ({ onEvent: listener }: { onEvent: (event: NexusEvent) => void }) => { onNexusEvent = listener; return () => { onNexusEvent = undefined; }; } } as unknown as NexusClient;
  await act(async () => root.render(createElement(NexusProvider, { client: nexusClient,
    children: createElement(DaemonContext.Provider, { value: daemon }, createElement(AppsPage)) })));
}

test('shows app, simulation and real-operation states, then opens an app-scoped event and receipt view', async () => {
  await mount(async () => ({ apps: [app, liveApp] }));
  expect(host.textContent).toContain('음성 메모');
  expect(host.textContent).toContain('시뮬레이션');
  expect(host.textContent).toContain('통과');
  expect(host.textContent).toContain('실제 운영');
  expect(host.textContent).toContain('준비 전');
  expect(host.textContent).toContain('운영 중인 메모');
  expect(host.textContent).toContain('정식 운영');
  await act(async () => { host.querySelector('button')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(host.textContent).toContain('receipt-demo-1114');
  expect(host.textContent).toContain('녹음과 받아쓰기 확인');
  expect(host.textContent).toContain('SIM-CHAIN-APP voice-notes · 완료');
  expect(host.textContent).toContain('시뮬레이션 실행');
  await act(async () => onNexusEvent?.({ kind: 'app.sim.step-completed', ts: Date.now(), appId: 'voice-notes', data: { step: 'share', message: '공유 링크 생성 완료' } } as unknown as NexusEvent));
  expect(host.textContent).toContain('공유 링크 생성 완료');
});

test('shows connection guidance rather than an apps-list error when the daemon is offline', async () => {
  await mount(async () => { throw new Error('offline'); });
  expect(host.textContent).toContain('데몬에 연결되지 않았습니다');
  expect(host.textContent).toContain('연결 설정을 확인');
  expect(host.textContent).not.toContain('앱 목록을 불러오지 못했습니다');
});

test('operator action runs the registered simulation and refreshes the event and receipt view', async () => {
  const calls: Array<{ path?: string; method?: string }> = [];
  await mount(async (path, init) => {
    calls.push({ path, method: init?.method });
    if (path?.endsWith('/simulations/run')) return { simulation: app.simulation };
    return { apps: [{ ...app, simulation: { status: 'not-created' } }] };
  });
  await act(async () => { host.querySelector('button')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
  const runButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('시뮬레이션 실행'));
  expect(runButton).toBeDefined();
  await act(async () => { runButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(calls).toContainEqual({ path: '/v1/apps/voice-notes/simulations/run', method: 'POST' });
  expect(host.textContent).toContain('녹음과 받아쓰기 확인');
  expect(host.textContent).toContain('receipt-demo-1114');
  await act(async () => { host.querySelector('button[aria-label="앱 목록으로"]')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(host.textContent).toContain('통과');
  expect(host.textContent).toContain('receipt-demo-1114');
  await act(async () => {
    [...host.querySelectorAll('button')].find(button => button.textContent?.includes('시뮬레이션 보기'))!
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(host.textContent).toContain('녹음과 받아쓰기 확인');
  expect(host.textContent).toContain('SIM-CHAIN-APP voice-notes · 완료');
});

test('late simulation results update the list without navigating away from the newly selected app', async () => {
  let resolveRun!: (value: unknown) => void;
  const pendingRun = new Promise<unknown>((resolve) => { resolveRun = resolve; });
  await mount(async (path) => {
    if (path?.endsWith('/simulations/run')) return pendingRun;
    return { apps: [{ ...app, simulation: { status: 'not-created' } }, liveApp] };
  });
  const click = async (button: HTMLButtonElement) => act(async () => {
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await click([...host.querySelectorAll('button')].find(button => button.textContent?.includes('시뮬레이션 보기'))!);
  await click([...host.querySelectorAll('button')].find(button => button.textContent?.includes('시뮬레이션 실행'))!);
  await click(host.querySelector('button[aria-label="앱 목록으로"]')!);
  const liveTile = [...host.querySelectorAll('li')].find(item => item.textContent?.includes('운영 중인 메모'))!;
  await click(liveTile.querySelector('button')!);
  expect(host.textContent).toContain('운영 중인 메모');
  await act(async () => { resolveRun({ simulation: app.simulation }); await pendingRun; });
  expect(host.textContent).toContain('운영 중인 메모');
  expect(host.textContent).not.toContain('음성 메모');
});
