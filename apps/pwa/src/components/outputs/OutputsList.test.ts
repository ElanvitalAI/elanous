import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createElement, act } from 'react';
import { parseHTML } from 'linkedom';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { OutputsList, OutputsListView } from './OutputsList';
import type { OutputItem } from '@/lib/outputs-api';

const rows: OutputItem[] = [
  { kind: 'report', kindLabel: '한 장 보고서', title: '최신 보고', seat: 'OP', fileName: 'latest.md', source: 'exec', at: '2026-10-03T08:45:00Z' },
  { kind: 'slides', kindLabel: '슬라이드', title: '중간 슬라이드', seat: 'MK', url: 'https://example.test/slides', source: 'exec', at: '2026-10-02T01:00:00Z' },
  { kind: 'report', kindLabel: '한 장 보고서', title: '이전 보고', seat: 'TC', fileName: 'previous.md', source: 'field-feed', at: '2026-10-01T00:00:00Z' },
  { kind: 'video', kindLabel: '영상', title: '현장 영상', seat: 'UX', url: 'https://example.test/video', source: 'field-reel', at: '2026-09-30T00:00:00Z' },
];
const render = (outputs = rows, selected = 'all', status: 'loading' | 'ready' | 'error' = 'ready') =>
  renderToStaticMarkup(createElement(OutputsListView, { outputs, selected, onSelect: () => {}, status }));

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event };
let root: import('react-dom/client').Root;
let host: HTMLElement;
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
});

async function mount(fetchJson: (path: string) => Promise<{ outputs: OutputItem[] }>) {
  const client = { fetchJson } as unknown as DaemonClient;
  const context = { client, config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
  await act(async () => { root.render(createElement(DaemonContext.Provider, { value: context }, createElement(OutputsList))); });
}

test('mounted screen fetches the ledger and chips switch the visible cards', async () => {
  const paths: string[] = [];
  await mount(async (path) => { paths.push(path); return { outputs: rows }; });
  expect(paths).toEqual(['/v1/outputs']);
  expect(host.textContent).toContain('최신 보고');
  const slides = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('슬라이드'))!;
  await act(async () => { slides.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(slides.getAttribute('aria-pressed')).toBe('true');
  expect(host.textContent).toContain('중간 슬라이드');
  expect(host.textContent).not.toContain('최신 보고');
});

test('mounted screen distinguishes empty ledger and fetch failure', async () => {
  await mount(async () => ({ outputs: [] }));
  expect(host.textContent).toContain('아직 만든 산출물이 없습니다 — 일을 맡기면 여기에 쌓입니다');
  await act(async () => { root.unmount(); });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
  await mount(async () => { throw new Error('offline'); });
  expect(host.textContent).toContain('산출물 목록을 읽지 못했습니다');
});

test('latest-first cards show kinds, counted chips, seats, KST time and source', () => {
  const html = render();
  expect(html).toContain('전부 4');
  expect(html).toContain('한 장 보고서 2');
  expect(html).toContain('슬라이드 1');
  expect(html).toContain('영상 1');
  expect(html.indexOf('최신 보고')).toBeLessThan(html.indexOf('중간 슬라이드'));
  expect(html.indexOf('중간 슬라이드')).toBeLessThan(html.indexOf('이전 보고'));
  expect(html).toContain('COO');
  expect(html).toContain('CMO');
  expect(html).toContain('CTO');
  expect(html).toContain('CXO');
  expect(html).toContain('10월 3일 17:45');
  expect(html).toContain('맡긴 일');
  expect(html).toContain('현장');
  expect(render(rows, 'report')).not.toContain('중간 슬라이드');
  expect(render(rows, 'report')).toContain('이전 보고');
});

test('URL opens safely in a new tab while file-only output shows muted basename', () => {
  const html = render();
  expect(html).toContain('href="https://example.test/slides" target="_blank" rel="noopener"');
  expect(html).toContain('text-muted-foreground">latest.md</p>');
  expect(html).not.toContain('/private/');
});

test('empty and failed reads have distinct human-facing messages', () => {
  expect(render([])).toContain('아직 만든 산출물이 없습니다 — 일을 맡기면 여기에 쌓입니다');
  expect(render([], 'all', 'error')).toContain('산출물 목록을 읽지 못했습니다');
  expect(render([], 'all', 'error')).not.toContain('아직 만든 산출물이 없습니다');
});
