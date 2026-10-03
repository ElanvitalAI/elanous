import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import { buildLiveBoard } from '@/lib/live-signals';
import { seatLineIsPublicSafe } from '@/lib/seat-public';
import { publicAccountLabel } from '@/lib/stage-public';
import type { LogRow } from '@/nexus/client';

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event };
const animation = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const originalAnimation = { raf: animation.requestAnimationFrame, caf: animation.cancelAnimationFrame };
let root: import('react-dom/client').Root;
let host: HTMLElement;
let canvasLabels: string[];
let canvasFonts: string[];
let frames: FrameRequestCallback[];
const flushCanvas = () => { for (const cb of frames.splice(0)) cb(performance.now() + 1000); };

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  canvasLabels = [];
  canvasFonts = [];
  const canvas = window.document.createElement('canvas');
  const proto = Object.getPrototypeOf(canvas);
  proto.getContext = () => ({
    set font(value: string) { canvasFonts.push(value); },
    createRadialGradient: () => ({ addColorStop: () => {} }), setTransform: () => {}, clearRect: () => {},
    drawImage: () => {}, fillRect: () => {}, beginPath: () => {}, stroke: () => {}, fill: () => {}, moveTo: () => {},
    lineTo: () => {}, arc: () => {}, setLineDash: () => {},
    fillText: (value: string) => { canvasLabels.push(value); },
  });
  frames = [];
  animation.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(cb); return 0; };
  animation.cancelAnimationFrame = () => {};
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  Object.assign(globalThis, originals);
  animation.requestAnimationFrame = originalAnimation.raf;
  animation.cancelAnimationFrame = originalAnimation.caf;
});

const now = Date.parse('2026-10-02T03:45:00Z');
const id = 'run-f22cea41-2868-48d5-a426-5c3a9efab5b4';
const row = (seconds: number, category: string, event: string, data: Record<string, unknown>, instance = 'ELANOUS HARNESS:HARVEST'): LogRow =>
  ({ ts: new Date(now - seconds * 1000).toISOString(), category, event, data, instance });
const rows: LogRow[] = [
  row(25, 'dev-pipeline', 'plan', { runId: id }),
  row(20, 'harness.substrate', 'dispatch-pod', { runId: id, podPool: 'remote-1' }),
  row(15, 'harness.substrate', 'dispatch-pod-exit', { runId: id, target: 'account-2' }),
  row(10, 'self-dev.supervisor', 'decompose-proposal.backfill', { runId: id, target: 'HARVEST' }),
  row(5, 'oauth.codex-account', 'reset-credit-available', { account: 'account-2', runId: id }),
  row(1, 'llm.usage', 'request', { model: 'gpt-5', billingProvider: 'account-2', site: 'headquarters', inputTokens: 42, outputTokens: 9 }),
];
const board = buildLiveBoard(rows, [], { now, windowMinutes: 60 });

test('publicCapture folds stage text and canvas labels while private mode retains originals and numeric/model data', async () => {
  const { LiveMaxStage } = await import('./LiveMaxStage');
  await act(async () => { root.render(<LiveMaxStage board={board} rows={rows} sourceLabel="HARVEST" publicCapture autoReplay={false} />); });
  flushCanvas();
  const text = [host.textContent ?? '', ...canvasLabels].join('\n');
  for (const marker of [id, 'HARVEST', 'account-2', 'remote-1', 'harness.substrate dispatch-pod-exit', 'reset-credit-available']) {
    expect(text).not.toContain(marker);
  }
  expect(host.querySelector('[data-live-v5-best]')?.textContent).toContain('런 1');
  expect(host.querySelector('[data-live-max-stream]')?.textContent).toContain('경로 정하기');
  expect(host.textContent).toContain('GPT');
  expect(host.textContent).not.toContain('gpt-5');
  expect(host.textContent).toContain('51');
  expect(canvasLabels).toContain(publicAccountLabel('account-2'));
  expect(canvasLabels).toContain('본부');
  for (const line of text.split('\n')) expect(seatLineIsPublicSafe(line)).toBe(true);

  const nextRows = [row(0, 'harness.decision', 'decision', {
    kind: 'route', runId: id, what: 'run-f22cea41-2868-48d5-a426-5c3a9efab5b4 → HARVEST',
    why: 'account-2', target: 'remote-1',
  }), ...rows];
  const nextBoard = buildLiveBoard(nextRows, [], { now, windowMinutes: 60 });
  await act(async () => { root.render(<LiveMaxStage board={nextBoard} rows={nextRows} sourceLabel="HARVEST" publicCapture autoReplay={false} />); });
  const card = host.querySelector('[data-live-decision-card]')?.textContent ?? '';
  expect(card).toContain('경로 정하기');
  expect(card).toContain('런 1');
  for (const marker of [id, 'HARVEST', 'account-2', 'remote-1']) expect(card).not.toContain(marker);
  expect(seatLineIsPublicSafe(card)).toBe(true);

  await act(async () => { root.render(<></>); });
  canvasLabels = [];
  frames = [];
  await act(async () => { root.render(<LiveMaxStage board={board} rows={rows} sourceLabel="HARVEST" publicCapture={false} autoReplay={false} />); });
  flushCanvas();
  expect(host.textContent).toContain(id);
  expect(host.textContent).toContain('harness.substrate dispatch-pod-exit');
  expect(host.textContent).toContain('HARVEST');
  expect(canvasLabels).toContain('ACCOUNT-2');
  expect(canvasLabels).toContain('REMOTE-1');
});

test('public graph aliases distinct known, high-numbered and unknown accounts; outside-snapshot card run has its own number', async () => {
  const { LiveMaxStage } = await import('./LiveMaxStage');
  const outside = 'run-12345678-1234-1234-1234-123456789abc';
  const extraRows = [
    row(0, 'harness.decision', 'decision', { kind: 'route', runId: outside, what: 'new route', why: 'account-27', target: 'private' }),
    row(1, 'harness.substrate', 'dispatch-pod', { runId: id, podPool: 'account-27' }),
    row(2, 'llm.usage', 'request', { model: 'gpt-5', billingProvider: 'unknown-private-account', site: 'headquarters', inputTokens: 4, outputTokens: 2 }),
    ...rows,
  ];
  const extraBoard = buildLiveBoard(extraRows, [], { now, windowMinutes: 60 });
  extraBoard.snapshot.runs = extraBoard.snapshot.runs.filter((run) => run.runId !== outside);
  await act(async () => { root.render(<LiveMaxStage board={board} rows={rows} publicCapture autoReplay={false} />); });
  await act(async () => { root.render(<LiveMaxStage board={extraBoard} rows={extraRows} publicCapture autoReplay={false} />); });
  flushCanvas();
  const aliases = ['account-2', 'account-27', 'unknown-private-account'].map(publicAccountLabel);
  expect(new Set(aliases).size).toBe(3);
  for (const alias of aliases) expect(canvasLabels).toContain(alias);
  expect(host.querySelector('[data-live-v5-best]')?.textContent).toContain('런 1');
  const card = host.querySelector('[data-live-decision-card]')?.textContent ?? '';
  expect(card).toContain('런 2');
  expect(card).not.toContain('런 1');
  expect([host.textContent, ...canvasLabels].join(' ')).not.toContain('account-27');
  expect([host.textContent, ...canvasLabels].join(' ')).not.toContain('unknown-private-account');
});

test('heat headings hide raw sites and model versions; public stage has no sub-14px text while private retains its classes', async () => {
  const { LiveMaxStage } = await import('./LiveMaxStage');
  const heatRows = [
    row(0, 'llm.usage', 'request', { model: 'gpt-5.6-terra', site: 'stream-llm', inputTokens: 7, outputTokens: 3 }),
    row(1, 'llm.usage', 'request', { model: 'claude-4.5-sonnet', site: 'pod-rollup', inputTokens: 2, outputTokens: 2 }),
    row(2, 'llm.usage', 'request', { model: 'grok-4.6', site: 'agent-turn', inputTokens: 1, outputTokens: 1 }),
    row(3, 'llm.usage', 'request', { model: 'secret-model-v10', site: 'secret.site-unique', inputTokens: 1, outputTokens: 1 }),
    row(4, 'llm.usage', 'request', { model: 'secret-model-v10', site: 'other.secret.site', inputTokens: 1, outputTokens: 1 }),
  ];
  const heatBoard = buildLiveBoard(heatRows, [], { now, windowMinutes: 60 });
  heatBoard.convergence = [{ pr: '123', points: [{ round: 1, asks: 2 }, { round: 2, asks: 0 }] }];
  await act(async () => { root.render(<LiveMaxStage board={heatBoard} rows={heatRows} publicCapture autoReplay={false} />); });
  const heat = host.querySelector('[data-live-v5-heat]')!;
  const headings = [...heat.querySelectorAll('th')].map((th) => th.textContent);
  const models = [...heat.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent);
  expect(headings).toEqual(expect.arrayContaining(['대화', '파드 작업', '자리 턴']));
  expect(headings.filter((h) => /^작업 \d+$/.test(h ?? ''))).toHaveLength(1);
  expect(models).toEqual(expect.arrayContaining(['GPT', 'Claude', 'Grok']));
  expect(models).toContain('모델 1');
  expect([...heat.querySelectorAll('thead th:not(:first-child), tbody tr td:first-child')].every((cell) => cell.className.includes('break-words') && !cell.className.includes('truncate'))).toBe(true);
  expect(host.querySelector('[data-live-v5-book]')?.className).toContain('overflow-visible');
  expect(host.querySelector('[data-live-max-stream]')?.className).toContain('overflow-visible');
  expect(heat.textContent).not.toMatch(/stream-llm|pod-rollup|agent-turn|secret\.site|gpt-5\.6-terra|claude-4\.5-sonnet|grok-4\.6|secret-model-v10/);
  flushCanvas();
  expect(canvasFonts.length).toBeGreaterThan(0);
  expect(canvasFonts.every((font) => Number(font.match(/(\d+)px/)?.[1]) >= 14)).toBe(true);
  expect([host.textContent, ...canvasLabels].join(' ')).not.toMatch(/gpt-5\.6-terra|claude-4\.5-sonnet|grok-4\.6|secret-model-v10/);
  for (const element of host.querySelectorAll('*')) {
    expect(element.className?.toString() ?? '').not.toMatch(/(?:^|\s)(?:text-\[(?:9|9\.5|10|10\.5|11)px\]|text-xs|lg:text-\[(?:9|9\.5|10|10\.5|11)px\])(?:\s|$)/);
  }
  const convergence = host.querySelector('[data-live-convergence]')!;
  const candles = host.querySelector('[data-live-v5-candles]')!;
  expect(convergence.querySelector('svg')?.getAttribute('class')).toContain('h-24');
  expect(candles.getAttribute('class')).toContain('h-28');
  expect(14 * (96 / Number(convergence.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[3]))).toBeLessThan(14);
  expect(14 * (112 / Number(candles.getAttribute('viewBox')!.split(' ')[3]))).toBeLessThan(14);
  expect(host.querySelectorAll('svg text')).toHaveLength(0);
  expect(convergence.querySelector('[data-live-convergence-labels]')?.className).toContain('text-sm');
  expect(convergence.querySelector('[data-live-convergence-labels]')?.textContent).toContain('R1');
  expect(convergence.querySelector('[data-live-convergence-labels]')?.textContent).toContain('#123 0');
  expect(candles.nextElementSibling?.className).toContain('text-sm');
  expect(candles.nextElementSibling?.textContent).toMatch(/^\d+\/\d+M$/);
  const publicCounts = [...heat.querySelectorAll('tbody tr td:not(:first-child)')].map((cell) => cell.textContent);

  await act(async () => { root.render(<LiveMaxStage board={heatBoard} rows={heatRows} publicCapture={false} autoReplay={false} />); });
  const privateHeat = host.querySelector('[data-live-v5-heat]')!;
  expect([...privateHeat.querySelectorAll('th')].map((th) => th.textContent)).toEqual(expect.arrayContaining(['stream-llm', 'pod-rollup', 'agent-turn', 'secret.site-unique']));
  expect([...privateHeat.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent)).toEqual(expect.arrayContaining(['gpt-5.6-terra', 'claude-4.5-sonnet', 'grok-4.6', 'secret-model-v10']));
  expect([...privateHeat.querySelectorAll('tbody tr td:not(:first-child)')].map((cell) => cell.textContent)).toEqual(publicCounts);
  expect(privateHeat.className).toContain('text-[11px]');
  expect(privateHeat.className).toContain('lg:text-[10px]');
  expect(host.querySelector('[data-live-v5-book]')?.className).toContain('text-[11px]');
  expect(host.querySelector('[data-live-convergence] svg text')).not.toBeNull();
  expect(host.querySelector('[data-live-v5-candles] text')).not.toBeNull();
  expect(host.querySelector('[data-live-convergence-labels]')).toBeNull();
});

test('same timestamp and run PLAN and ROUTE from buildLiveBoard retain distinct public labels in log and ticker', async () => {
  const { LiveMaxStage } = await import('./LiveMaxStage');
  const simultaneous = [
    row(0, 'dev-pipeline', 'plan', { runId: id }),
    row(0, 'harness.substrate', 'dispatch-pod-exit', { runId: id, target: 'account-2' }),
  ];
  const simultaneousBoard = buildLiveBoard(simultaneous, [], { now, windowMinutes: 60 });
  expect(simultaneousBoard.stream.map((line) => line.kind)).toEqual(['ROUTE', 'PLAN']);
  await act(async () => { root.render(<LiveMaxStage board={simultaneousBoard} rows={simultaneous} publicCapture autoReplay={false} />); });
  const logLines = [...host.querySelectorAll('[data-live-max-stream] li')].map((line) => line.textContent ?? '');
  expect(logLines).toHaveLength(2);
  expect(logLines[0]).toContain('경로 정하기');
  expect(logLines[1]).toContain('계획');
  const ticker = host.querySelector('[aria-label="판단 띠"]')?.textContent ?? '';
  expect(ticker.indexOf('경로 정하기')).toBeLessThan(ticker.indexOf('계획'));
  expect(ticker).toContain('계획');
  expect(ticker).toContain('경로 정하기');
  expect([ticker, ...logLines].join(' ')).not.toContain('harness.substrate dispatch-pod-exit');
  await act(async () => { root.render(<LiveMaxStage board={simultaneousBoard} rows={simultaneous} publicCapture={false} autoReplay={false} />); });
  expect(host.querySelector('[data-live-max-stream]')?.textContent).toContain('harness.substrate dispatch-pod-exit');
  expect(host.querySelector('[aria-label="판단 띠"]')?.textContent).toContain('dev-pipeline plan');
});
