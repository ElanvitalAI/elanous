import { afterEach, expect, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { _setEventSourceFactoryForTest } from '@/lib/shared-event-source';
import type { WizardStepEvent } from '@/lib/inside-events';
import { leaksInternal } from './public-text';
import { mergeWizardEvents, WizardMarketScene, WizardMarketView } from './WizardMarketScene';

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event };
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  _setEventSourceFactoryForTest(null);
  Object.assign(globalThis, originals);
});

function mount() {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.getElementById('root')!;
  root = createRoot(host);
  return host;
}

const event = (step: WizardStepEvent['step'], text: string = step): WizardStepEvent => ({ ts: '2026-10-03T09:00:00Z', wizardId: 'wizard-1', step, text });

test('empty view gives the exact start command and populated view renders six colored responsive steps with public text', async () => {
  const host = mount();
  await act(async () => root!.render(<WizardMarketView events={[]} />));
  expect(host.textContent).toBe('마법사가 아직 돌지 않았습니다 — elanous plugin make "<한 줄>" 로 시작');
  expect(host.querySelectorAll('[data-wizard-step]')).toHaveLength(0);
  await act(async () => root!.render(<WizardMarketView events={[event('request', 'OP node-b user@example.com'), event('research', '조사')] } />));
  const section = host.querySelector('section')!;
  expect(section.getAttribute('class')).toContain('min-[1440px]:text-[22px]');
  expect(host.querySelector('ol')?.getAttribute('class')).toContain('grid-cols-1');
  expect(host.querySelector('ol')?.getAttribute('class')).toContain('min-[900px]:grid-cols-6');
  const cells = [...host.querySelectorAll('[data-wizard-step]')];
  expect(cells).toHaveLength(6);
  expect(cells.map(cell => cell.getAttribute('data-state'))).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
  expect(cells[0].textContent).toContain('요청 · 완료');
  expect(cells[1].textContent).toContain('조사 · 진행 중');
  expect(cells[0].getAttribute('class')).toContain('green');
  expect(cells[1].getAttribute('class')).toContain('sky');
  expect(cells[2].getAttribute('class')).toContain('slate');
  expect(cells[0].textContent).toContain('COO remote-1');
  expect(cells[0].querySelector('p')?.getAttribute('class')).toContain('whitespace-nowrap');
  expect(leaksInternal(host.textContent ?? '')).toEqual([]);
  await act(async () => root!.render(<WizardMarketView events={[event('validate', '검증'), { ...event('validate'), detail: { ok: false } }] } />));
  expect(host.querySelector('[data-wizard-step="validate"]')?.getAttribute('data-state')).toBe('failed');
  expect(host.querySelector('[data-wizard-step="validate"]')?.getAttribute('class')).toContain('red');
});

test('live wizard stream keeps 50 recent events, switches client cleanly and unsubscribes without a real daemon or EventSource', async () => {
  const host = mount();
  const streams = new Map<string, { listeners: Set<(message: { data: string }) => void>; closed: boolean }>();
  _setEventSourceFactoryForTest(url => {
    const stream = { listeners: new Set<(message: { data: string }) => void>(), closed: false };
    streams.set(url, stream);
    return { addEventListener: (name: string, listener: (message: { data: string }) => void) => { if (name === 'log') stream.listeners.add(listener); },
      removeEventListener: (name: string, listener: (message: { data: string }) => void) => { if (name === 'log') stream.listeners.delete(listener); },
      close: () => { stream.closed = true; } } as unknown as EventSource;
  });
  type Context = NonNullable<ComponentProps<typeof DaemonContext.Provider>['value']>;
  const client = (url: string) => ({ logsStreamUrl: (params: Record<string, string>) => {
    expect(params).toEqual({ exactCategory: 'wizard.step' });
    return url;
  } });
  const show = async (url: string) => {
    const context = { client: client(url) as unknown as Context['client'], config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
    await act(async () => root!.render(<DaemonContext.Provider value={context}><WizardMarketScene /></DaemonContext.Provider>));
  };
  const emit = async (url: string, step: WizardStepEvent['step'], text: string) => {
    await act(async () => {
      for (const listener of streams.get(url)!.listeners) listener({ data: JSON.stringify({ category: 'wizard.step', event: 'wizard.step', data: { ...event(step, text) } }) });
    });
  };
  await show('/a');
  expect(host.textContent).toContain('마법사가 아직 돌지 않았습니다');
  await emit('/a', 'request', '첫 요청');
  for (let i = 0; i < 50; i++) await emit('/a', 'research', `조사 ${i}`);
  expect(host.textContent).not.toContain('첫 요청');
  expect(host.textContent).toContain('조사 49');
  await show('/b');
  expect(streams.get('/a')?.closed).toBe(true);
  expect(streams.get('/a')?.listeners.size).toBe(0);
  expect(host.textContent).toContain('마법사가 아직 돌지 않았습니다');
  await emit('/b', 'draft', '새 초안');
  expect(host.textContent).toContain('새 초안');
  await act(async () => root!.unmount());
  root = undefined;
  expect(streams.get('/b')?.closed).toBe(true);
  expect(streams.get('/b')?.listeners.size).toBe(0);
});

test('a finished wizard run is restored from the log query on open, and merged with live events without duplicates', async () => {
  const host = mount();
  _setEventSourceFactoryForTest(() => ({ addEventListener: () => {}, removeEventListener: () => {}, close: () => {} }) as unknown as EventSource);
  const rows = (['request', 'research', 'draft', 'validate', 'install', 'done'] as const).map((step, index) => ({
    category: 'wizard.step', event: 'wizard.step', ts: `2026-10-04T00:0${index}:00Z`,
    data: { ts: `2026-10-04T00:0${index}:00Z`, wizardId: 'w1', step, text: `단계 ${step}` },
  }));
  const paths: string[] = [];
  type Context = NonNullable<ComponentProps<typeof DaemonContext.Provider>['value']>;
  const client = { logsStreamUrl: () => '/s', fetchJson: async (path: string) => { paths.push(path); return { ok: true, logs: [...rows].reverse() }; } };
  const context = { client: client as unknown as Context['client'], config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
  await act(async () => root!.render(<DaemonContext.Provider value={context}><WizardMarketScene /></DaemonContext.Provider>));
  await act(async () => {});
  expect(paths).toEqual(['/v1/logs?exactCategory=wizard.step&limit=50']);
  expect(host.textContent).toContain('단계 done');
  expect(host.textContent).not.toContain('마법사가 아직 돌지 않았습니다');
  const one = rows.map((row) => ({ ...row.data })) as WizardStepEvent[];
  expect(mergeWizardEvents(one, one)).toHaveLength(6);
  expect(mergeWizardEvents([], [one[5]!, one[0]!]).map((e) => e.step)).toEqual(['request', 'done']);
});
