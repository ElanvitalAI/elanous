// Live 판 — 진짜 집계를 그리고, 런을 누르면 그 id 로 한 번 알린다.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import { buildLiveBoard } from '@/lib/live-signals';
import type { LogRow } from '@/nexus/client';

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
afterEach(async () => { await act(async () => { root.unmount(); }); Object.assign(globalThis, originals); });

const now = Date.parse('2026-09-28T01:00:00.000Z');
const r = (min: number, category: string, event: string, data: Record<string, unknown>): LogRow => ({ ts: new Date(now - min * 60_000).toISOString(), category, event, data });
const board = buildLiveBoard([
  r(10, 'dev-pipeline', 'plan', { runId: 'run-aaaa1111' }),
  r(8, 'review-loop', 'judge-verdict', { runId: 'run-aaaa1111', pr: '9', verdict: 'rework', round: 2 }),
  r(5, 'oauth.codex-account', 'rotation', { account: 'team', reason: 'default 95%' }),
], [], { now, windowMinutes: 60 });

test('renders gauges, a run bar with its round, and decision lines with why/target', async () => {
  const { LiveBoard } = await import('./LiveBoard');
  const picked: string[] = [];
  await act(async () => { root.render(<LiveBoard board={board} lines={['a']} mode="practical" onSelectRun={(id) => picked.push(id)} />); });
  expect(host.querySelector('[data-live-gauge="DECISIONS/MIN"]')?.textContent).toBe(String(board.gauges.decisionsPerMin));
  const run = host.querySelector('[data-live-run="run-aaaa1111"]') as HTMLButtonElement;
  expect(run.textContent).toContain('R 2/3');
  expect(host.querySelector('[data-live-stream]')?.textContent).toContain('[ROUTE]');
  expect(host.querySelector('[data-live-stream]')?.textContent).toContain('왜: default 95%');
  await act(async () => { run.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(picked).toEqual(['run-aaaa1111']);
  expect(host.querySelector('[data-live-mode]')?.getAttribute('data-live-mode')).toBe('practical');
});

test('MAX stage: a new decision shows a three-cell card, then folds; replay queues this window', async () => {
  const { LiveMaxStage, CARD_MS } = await import('./LiveMaxStage');
  // 캔버스·굴러가는 숫자는 한 프레임만(시험은 카드만 본다).
  const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
  try {
  await act(async () => { root.render(<LiveMaxStage board={board} autoReplay={false} />); });
  // 첫 로드는 카드를 띄우지 않는다(쌓인 과거가 한꺼번에 터지지 않게).
  expect(host.querySelector('[data-live-decision-card]')).toBeNull();
  const next = buildLiveBoard([
    r(10, 'dev-pipeline', 'plan', { runId: 'run-aaaa1111' }),
    r(8, 'review-loop', 'judge-verdict', { runId: 'run-aaaa1111', pr: '9', verdict: 'rework', round: 2 }),
    r(5, 'oauth.codex-account', 'rotation', { account: 'team', reason: 'default 95%' }),
    r(1, 'harness.decision', 'decision', { kind: 'route', what: 'Pod node-b 로 보낸다', reason: '로컬 부하 9.1', target: 'pool-node-b', runId: 'run-aaaa1111' }),
  ], [], { now, windowMinutes: 60 });
  await act(async () => { root.render(<LiveMaxStage board={next} autoReplay={false} />); });
  const card = host.querySelector('[data-live-decision-card]');
  expect(card?.textContent).toContain('Pod node-b 로 보낸다');
  expect(card?.textContent).toContain('로컬 부하 9.1');
  expect(card?.textContent).toContain('pool-node-b');
  await act(async () => { await new Promise((res) => setTimeout(res, CARD_MS + 50)); });
  expect(host.querySelector('[data-live-decision-card]')?.getAttribute('style')).toContain('opacity:0');
  await act(async () => { await new Promise((res) => setTimeout(res, 300)); });
  expect(host.querySelector('[data-live-decision-card]')).toBeNull();
  const replay = host.querySelector('[data-elanous-action="live-replay"]') as HTMLButtonElement;
  await act(async () => { replay.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(host.querySelector('[data-live-decision-card]')).not.toBeNull();
  } finally {
    await act(async () => { root.render(<></>); });
    g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf;
  }
}, 10_000);

test('only decisions with a why or a target become cards (empty cards stay in the stream)', async () => {
  const { cardWorthy } = await import('./LiveMaxStage');
  expect(cardWorthy({ why: null, purpose: null, target: null })).toBe(false);
  expect(cardWorthy({ why: 'x', purpose: null, target: null })).toBe(true);
  expect(cardWorthy({ why: null, purpose: null, target: 'pool-node-b' })).toBe(true);
});
