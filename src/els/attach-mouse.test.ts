import { describe, expect, test } from 'bun:test';
import { interpretMouse, splitMouse } from './attach-mouse.js';
import { createKeyRouter } from './attach-keys.js';

const WHEEL_SCROLL_STEP_LINES = 3;

const layout = { cols: 80, rows: 24, sidebarWidth: 28,
  sidebar: [{ y: 1, ws: 'w1', pane: 'p1' }, { y: 2, ws: 'w2', pane: 'p2' }],
  tabs: [{ from: 0, to: 6, pane: 'p1' }, { from: 6, to: 12, pane: 'p2' }] };

describe('splitMouse', () => {
  test('SGR press/release parse', () => {
    const { segments, pending } = splitMouse('\u001b[<0;12;3M\u001b[<0;12;3m');
    expect(pending).toBe('');
    expect(segments.length).toBe(2);
    const press = segments[0].kind === 'mouse' ? segments[0].report : undefined;
    const release = segments[1].kind === 'mouse' ? segments[1].report : undefined;
    expect(press).toEqual({ button: 0, x: 12, y: 3, release: false, bytes: '\u001b[<0;12;3M' });
    expect(release?.release).toBe(true);
  });
  test('분할 시퀀스는 pending에 보관', () => {
    const first = splitMouse('ab\u001b[<0;5');
    expect(first.pending).toBe('\u001b[<0;5');
    const second = splitMouse(first.pending + ';2M');
    expect(second.pending).toBe('');
    const rep = second.segments[0];
    expect(rep?.kind === 'mouse' && rep.report.x === 5 && rep.report.y === 2).toBe(true);
  });
});

describe('interpretMouse', () => {
  test('사이드바 행 클릭 → 첫 pane 선택', () => {
    expect(interpretMouse({ button: 0, x: 10, y: 2, release: false, bytes: '' }, layout))
      .toEqual({ kind: 'select', pane: 'p2' });
  });
  test('탭 클릭 → 탭 pane 선택', () => {
    expect(interpretMouse({ button: 0, x: 36, y: 1, release: false, bytes: 'B' }, layout))
      .toEqual({ kind: 'select', pane: 'p2' });
  });
  test('휠 → 스크롤', () => {
    expect(interpretMouse({ button: 64, x: 50, y: 10, release: false, bytes: '' }, layout)).toEqual({ kind: 'scroll', lines: WHEEL_SCROLL_STEP_LINES });
    expect(interpretMouse({ button: 65, x: 50, y: 10, release: false, bytes: '' }, layout)).toEqual({ kind: 'scroll', lines: -WHEEL_SCROLL_STEP_LINES });
  });
  test('pane 영역 클릭 → 원본 바이트 통과', () => {
    expect(interpretMouse({ button: 0, x: 50, y: 10, release: false, bytes: '\u001b[<0;50;10M' }, layout))
      .toEqual({ kind: 'passthrough', bytes: '\u001b[<0;50;10M' });
  });
});

describe('keys 라우터', () => {
  test('마우스 시퀀스가 text와 분리되어 나온다', () => {
    const events = createKeyRouter().feed('hi\u001b[<0;12;3M');
    expect(events[0]).toEqual({ kind: 'input', bytes: 'hi' });
    expect(events[1]?.kind).toBe('mouse');
  });
});
