// SIDETAB-POLISH-1126 (대표 11-26 11:2x, screenshot): the space's coordinator seat heads its list in its own colour, the
// unread «✉N» trails the name, the model name is dim, the loop rows carry no heartbeat bars. Expectations are literals.
import { describe, expect, test } from 'bun:test';
import { isSpaceCoordinatorRow, layoutSpaceList, type SpaceTabRow } from './space-tabs-view.js';

const pane = (id: string, ws: string, title: string, extra: Partial<SpaceTabRow> = {}): SpaceTabRow =>
  ({ pane: id, wsId: ws, workspace: ws, tabId: id, title, state: 'idle', cwd: '/x', ...extra } as SpaceTabRow);
const strip = (line: string): string => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd();
const draw = (rows: readonly SpaceTabRow[], width: number, facts = new Map()) =>
  layoutSpaceList(rows, 'none', width, 40, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map(), false, undefined, facts).lines;

// TC as in the screenshot: two working hands rank above the idle TC seat today.
const tcRows = [
  pane('h1', 'TC', 'TC-H-CX-1 · TC · CELL-A · terra', { seat: 'TC-H-CX-1', state: 'working', model: 'gpt-6.1-terra' }),
  pane('h2', 'TC', 'TC-H-CX-2 · TC · CELL-B · terra', { seat: 'TC-H-CX-2', state: 'working', model: 'gpt-6.1-terra' }),
  pane('tc', 'TC', 'TC', { seat: 'TC', state: 'idle', model: 'gpt-6.1-terra', unread: 42 } as Partial<SpaceTabRow>),
];

describe('coordinator first and styled', () => {
  test('who is the coordinator: same name, JUD in JUDGE, server flag; never a hand or a worker child', () => {
    expect(isSpaceCoordinatorRow(pane('a', 'OP', 'OP', { seat: 'OP' }), 'OP')).toBe(true);
    expect(isSpaceCoordinatorRow(pane('a', 'JUDGE', 'JUD', { seat: 'JUD' }), 'JUDGE')).toBe(true);
    expect(isSpaceCoordinatorRow(pane('a', 'jud', 'JUDGE', { seat: 'JUDGE' }), 'jud')).toBe(true);
    expect(isSpaceCoordinatorRow(pane('a', 'hq', 'HQ-LEAD', { seat: 'HQ-LEAD', spaceCoordinator: true }), 'hq')).toBe(true);
    expect(isSpaceCoordinatorRow(pane('a', 'TC', 'TC-H-CX-1', { seat: 'TC-H-CX-1' }), 'TC')).toBe(false);
    expect(isSpaceCoordinatorRow(pane('a', 'TC', 'TC', { seat: 'TC', parentPane: 'p0' }), 'TC')).toBe(false);
    expect(isSpaceCoordinatorRow(pane('a', 'UX', 'MK', { seat: 'MK' }), 'UX')).toBe(false);
  });

  for (const width of [38, 60]) test(`TC heads TC above the working hands, cyan + bold; hands plain (${width} cols)`, () => {
    const lines = draw(tcRows, width);
    const head = lines.findIndex((line) => strip(line).includes('⌄ TC'));
    const seatRows = lines.slice(head + 1).filter((line) => /\bTC(-H-CX-[12])?\b/.test(strip(line)) && !strip(line).startsWith('    '));
    expect(strip(seatRows[0]!)).toMatch(/^ ⚪ TC terra ✉42$/);
    expect(seatRows[0]!.startsWith('\u001b[36m\u001b[1m')).toBe(true);
    expect(seatRows[0]!.endsWith('\u001b[22m\u001b[39m')).toBe(true);
    expect(strip(seatRows[1]!)).toContain('TC-H-CX-1');
    expect(seatRows[1]!).not.toContain('\u001b[36m');
    for (const line of lines) expect(Bun.stringWidth(strip(line))).toBeLessThanOrEqual(width);
  });

  test('JUD seat heads the JUDGE space', () => {
    const rows = [pane('j1', 'JUDGE', 'JUD-B', { seat: 'JUD-B', state: 'working' }), pane('j0', 'JUDGE', 'JUD', { seat: 'JUD' })];
    const shown = draw(rows, 38).map(strip);
    expect(shown.findIndex((line) => /^ ⚪ JUD$/.test(line))).toBeLessThan(shown.findIndex((line) => line.includes('JUD-B')));
  });
});

describe('unread after the name · dim model', () => {
  test('«🟢 OP terra ✉123», never «🟢✉123 OP»; the count survives a narrow cut', () => {
    const rows = [pane('op', 'OP', 'OP', { seat: 'OP', state: 'working', model: 'gpt-6.1-terra', unread: 123 } as Partial<SpaceTabRow>)];
    const line = draw(rows, 38).map(strip).find((one) => one.includes(' OP terra'))!;
    expect(line).toMatch(/^ \S+ OP terra ✉123$/);
    expect(line).not.toMatch(/✉123 OP/);
    const narrow = draw([pane('op', 'OP', 'OP', { seat: 'OP-WITH-A-VERY-LONG-SEAT-NAME', model: 'gpt-6.1-terra', unread: 123 } as Partial<SpaceTabRow>)], 24).map(strip);
    expect(narrow.some((one) => one.endsWith('✉123'))).toBe(true);
  });
  test('the model name is wrapped in SGR 2 / 22; the seat name is not', () => {
    const line = draw(tcRows, 60).find((one) => strip(one).includes('TC-H-CX-1'))!;
    expect(line).toContain(' \u001b[2mterra\u001b[22m');
    expect(line).not.toContain('\u001b[2mTC');
  });
});

describe('loop rows: no heartbeat bars', () => {
  test('name + age only; exception = red dot; no spark glyphs, no blink', () => {
    const rows = [pane('s', 'TC', 'TC', { seat: 'TC' }), pane('l1', 'TC', '↻ space-advisor-tc'), pane('l2', 'TC', '↻ land-graph')];
    const facts = new Map([
      ['space-advisor-tc', { buckets: [1, 2, 3, 4, 5, 6], lastAt: null, tone: 'ok' as const, firing: true }],
      ['land-graph', { buckets: [0, 0, 0, 0, 0, 1], lastAt: null, tone: 'error' as const, firing: false }],
    ]);
    const lines = draw(rows, 38, facts);
    expect(lines.some((line) => /[▁▂▃▄▅▆▇]/.test(line) || line.includes('\u001b[5m'))).toBe(false);
    expect(lines.map(strip)).toContain('  ↻ advisor' + ' '.repeat(23) + ' now');
    expect(lines.find((line) => strip(line).includes('land-graph'))).toContain('\u001b[31m●\u001b[39m');
  });
});

test('the side list writes no terminal mode sequence (no ?1000/?1002/?1006 — clicks stay alive)', () => {
  const lines = draw(tcRows, 60);
  expect(lines.some((line) => line.includes('\u001b[?'))).toBe(false);
});
