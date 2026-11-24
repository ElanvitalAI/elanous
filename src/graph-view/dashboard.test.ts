// GRAPH-DASHBOARD: literal frame assertions. Pure render first, then the real els server (child requests → tab → `read`).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import type { ElsPty } from '../els/core.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import { cellWidth, renderGraphDashboard, type DashboardInput, type DashboardNode } from './dashboard.js';

const T0 = 1_000_000;
const fan = (n: number, state: (i: number) => DashboardNode['state']): DashboardNode[] => Array.from({ length: n }, (_, i) => {
  const s = state(i);
  return { id: `p${i + 1}`, label: `panel-${i + 1}`, state: s, startedAt: T0 + 5_000, ...(s === 'done' || s === 'failed' ? { endedAt: T0 + 9_000 + i * 100 } : {}),
    note: s === 'failed' ? 'model=glm-5 · timeout 30s' : `model=${i % 3 === 0 ? 'glm-5' : 'gpt-6-sol'} · round ${i}` };
});
const prep: DashboardNode = { id: 'ground', label: 'ground', state: 'done', startedAt: T0, endedAt: T0 + 4_000, note: 'ok' };
const input = (nodes: DashboardNode[], over: Partial<DashboardInput> = {}): DashboardInput =>
  ({ name: 'stock-panel', status: 'running', startedAt: T0, nowMs: T0 + 20_000, tick: 0, cols: 130, rows: 40, color: 'none', nodes, ...over });

test('12 parallel panelists render as 12 cards, header counts, models, running spinner, gauge on the join node', () => {
  const nodes = [prep, ...fan(12, (i) => (i < 5 ? 'done' : i === 11 ? 'failed' : 'running')),
    { id: 'j', label: 'consensus', state: 'running' as const, startedAt: T0 + 15_000, note: '' }];
  const frame = renderGraphDashboard(input(nodes))!;
  const text = frame.join('\n');
  expect(frame[0]!.startsWith('⠋ ⎇ stock-panel  ·  20s  ·  ✓6 ●7 ✕1  ·  glm-5×5 gpt-6-sol×7')).toBe(true);
  for (let i = 1; i <= 12; i++) expect(text).toContain(`panel-${i}`);
  expect(text.match(/┌─+┐/gu)!.length).toBeGreaterThanOrEqual(13); // 12 cards + the join and prep boxes
  expect(text).toContain('✕ timeout 30s');
  expect(text).toMatch(/█+[▓▒░]*░* 5\/12/u);
  expect(text).toContain('EVENTS');
  expect(text).toContain('NODES DONE / TIME');
  expect(text).toMatch(/[▁▂▃▅▇]{10,}/u);
  expect(frame.every((row) => cellWidth(row) <= 130)).toBe(true);
});

test('spinner glyph changes between ticks; a node that just finished pops ✔ then settles to ✓', () => {
  const running = [prep, ...fan(4, () => 'running')];
  const a = renderGraphDashboard(input(running, { tick: 0 }))!.join('\n');
  const b = renderGraphDashboard(input(running, { tick: 3 }))!.join('\n');
  expect(a).toContain('⠋ panel-1');
  expect(b).toContain('⠸ panel-1');
  expect(a).not.toBe(b);
  const popped = [{ ...prep, endedAt: T0 + 19_800 }, ...fan(4, () => 'running')];
  expect(renderGraphDashboard(input(popped))!.join('\n')).toContain('✔ ground');
  expect(renderGraphDashboard(input(popped, { nowMs: T0 + 21_500 }))!.join('\n')).toContain('✓ ground');
});

test('finished run: ✓ header, gauge full, failed run: ✕ header', () => {
  const nodes = [prep, ...fan(12, () => 'done'), { id: 'j', label: 'consensus', state: 'done' as const, startedAt: T0 + 15_000, endedAt: T0 + 16_000, note: 'ok' }];
  const done = renderGraphDashboard(input(nodes, { status: 'done', endedAt: T0 + 16_000, nowMs: T0 + 40_000 }))!.join('\n');
  expect(done.startsWith('✓ ⎇ stock-panel  ·  16s')).toBe(true);
  expect(done).toContain('████████████████████████ 12/12');
  const failed = renderGraphDashboard(input(nodes, { status: 'failed' }))!;
  expect(failed[0]!.startsWith('✕ ⎇ stock-panel')).toBe(true);
});

test('too small a pane (100x30) → null so the compact widget stays; 110x24 is the smallest dashboard', () => {
  const nodes = [prep, ...fan(12, () => 'running')];
  expect(renderGraphDashboard(input(nodes, { cols: 100, rows: 30 }))).toBeNull();
  expect(renderGraphDashboard(input(nodes, { cols: 130, rows: 20 }))).toBeNull();
  const small = renderGraphDashboard(input(nodes, { cols: 110, rows: 24 }))!;
  expect(small.length).toBeLessThanOrEqual(24);
  expect(small.join('\n')).toContain('panel-1');
});

test('colors: truecolor and 256 fallback paint ✓ green / ✕ red bold / spinner cyan; none has no escapes', () => {
  const nodes = [prep, ...fan(4, (i) => (i === 0 ? 'failed' : 'running'))];
  const tc = renderGraphDashboard(input(nodes, { color: 'truecolor' }))!.join('\n');
  const c256 = renderGraphDashboard(input(nodes, { color: '256' }))!.join('\n');
  const none = renderGraphDashboard(input(nodes, { color: 'none' }))!.join('\n');
  expect(tc).toContain('\x1b[38;2;46;160;67m✓\x1b[0m');
  expect(tc).toContain('\x1b[38;2;0;160;190m⠋\x1b[0m');
  expect(tc).toContain('\x1b[1;38;2;224;60;60m✕');
  expect(c256).toContain('\x1b[38;5;34m✓\x1b[0m');
  expect(c256).toContain('\x1b[1;38;5;160m✕');
  expect(none).not.toContain('\x1b');
  expect(tc.replace(/\x1b\[[0-9;]*m/gu, '').split('\n').map((l) => cellWidth(l))).toEqual(none.split('\n').map((l) => cellWidth(l)));
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

test('real els server: a 12-way fan-out graph in a maximized tab reads as the dashboard, changes between reads, small pane keeps compact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dash-els-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let size = { cols: 130, rows: 40 };
  const started = await startElsServer({ stateRoot: root, spawn: (): ElsPty => { throw new Error('no pty'); },
    childTabs: { tabAfterMs: 100, closeDelayMs: 60_000, tickMs: 120, paneSize: () => size, colorMode: 'none' } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  const child = (body: object) => requestEls(socket, { op: 'child', ws: 'OP', ...body } as never);
  await child({ action: 'start', id: 'g', source: 'graph', label: 'stock-panel' });
  await child({ action: 'start', id: 'n0', source: 'graph-node', parent: 'g', label: 'ground' });
  await child({ action: 'end', id: 'n0', ok: true, summary: 'ok' });
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 1; i <= 12; i++) await child({ action: 'start', id: `n${i}`, source: 'graph-node', parent: 'g', label: `panel-${i}` });
  for (let i = 1; i <= 12; i++) await child({ action: 'progress', id: `n${i}`, line: `model=${i % 2 ? 'glm-5' : 'gpt-6-sol'} · drafting` });
  await new Promise((r) => setTimeout(r, 250));
  const read = async (): Promise<string> => {
    const panes = (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; title: string }[] }).panes;
    return (await requestEls(socket, { op: 'read', pane: panes.find((p) => p.title.includes('stock-panel'))!.pane })).message;
  };
  const first = await read();
  expect(first).toContain('⎇ stock-panel');
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((i) => first.includes(`panel-${i}`))).toBe(true);
  expect(first).toContain('glm-5×6 gpt-6-sol×6');
  expect(first).toContain('⎇ stock-panel');
  await new Promise((r) => setTimeout(r, 300));
  expect(await read()).not.toBe(first); // spinner moved
  await child({ action: 'end', id: 'n3', ok: false, summary: 'rate limited' });
  await child({ action: 'end', id: 'n4', ok: true, summary: 'ok' });
  await new Promise((r) => setTimeout(r, 250));
  const mid = await read();
  expect(mid).toContain('✕ rate limited');
  expect(mid).toContain('✕1');
  expect(mid).toContain('glm-5×6 gpt-6-sol×6'); // the model survives the node's end
  size = { cols: 100, rows: 30 };
  await new Promise((r) => setTimeout(r, 250));
  const small = await read();
  expect(small).not.toContain('EVENTS');
  expect(small).toContain('Running graph');
});
