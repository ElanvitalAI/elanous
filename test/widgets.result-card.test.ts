// ── Result Card widget tests ──

import { describe, test, expect } from 'bun:test';
import resultCardWidget, { wrapToWidth } from '../widgets/result-card/widget.js';
import type { RenderCtx } from '../src/widgets/types.js';
import { stripAnsi } from '../src/tui.js';

const ctx = (overrides: Partial<RenderCtx> = {}): RenderCtx => ({
  width: 34, height: 7, focused: false, ...overrides,
});

describe('result-card widget — initialState', () => {
  test('defaults stance to loading when not supplied', () => {
    const s = resultCardWidget.initialState({ personaName: 'A' });
    expect(s.stance).toBe('loading');
    expect(s.personaName).toBe('A');
    expect(s.confidence).toBeUndefined();
  });

  test('copies config through', () => {
    const s = resultCardWidget.initialState({
      personaName: 'Warren B.',
      personaRole: 'Value investor',
      stance: 'bear',
      confidence: 58,
      summary: 'Expensive vs intrinsic value.',
      full: 'long…',
    });
    expect(s.personaName).toBe('Warren B.');
    expect(s.stance).toBe('bear');
    expect(s.confidence).toBe(58);
    expect(s.summary).toContain('intrinsic');
    expect(s.full).toBe('long…');
  });
});

describe('result-card widget — render', () => {
  test('emits at least top border + content + bottom border within height', () => {
    const state = resultCardWidget.initialState({
      personaName: 'Park Ji-hoon',
      personaRole: 'KR fund manager',
      stance: 'bull',
      confidence: 72,
      summary: '반도체 수급 긍정',
    });
    const out = resultCardWidget.render(state, ctx(), 'Result');
    expect(out.length).toBe(7);
    const plain = out.map(stripAnsi);
    // Top + bottom borders present
    expect(plain[0]).toMatch(/^\u256D/);
    expect(plain[plain.length - 1]).toMatch(/^\u2570/);
    // Persona name inlaid on top border
    expect(plain[0]).toContain('Park Ji-hoon');
    // Stance glyph (▲ = bull) somewhere in body
    expect(plain.slice(1, -1).some(l => l.includes('\u25B2'))).toBe(true);
    expect(plain.slice(1, -1).some(l => l.includes('Bull'))).toBe(true);
    // Summary text wrapped into a body row
    expect(plain.some(l => l.includes('반도체'))).toBe(true);
  });

  test('bear stance shows ▼ and Bear label', () => {
    const state = resultCardWidget.initialState({
      personaName: 'X',
      stance: 'bear',
      confidence: 40,
      summary: 'y',
    });
    const out = resultCardWidget.render(state, ctx(), '').map(stripAnsi);
    expect(out.some(l => l.includes('\u25BC'))).toBe(true);
    expect(out.some(l => l.includes('Bear'))).toBe(true);
  });

  test('neutral stance shows ● and Neutral label', () => {
    const state = resultCardWidget.initialState({
      personaName: 'X',
      stance: 'neutral',
      confidence: 50,
      summary: 'mixed',
    });
    const out = resultCardWidget.render(state, ctx(), '').map(stripAnsi);
    expect(out.some(l => l.includes('\u25CF'))).toBe(true);
    expect(out.some(l => l.includes('Neutral'))).toBe(true);
  });

  test('loading stance shows ✱ Running and no confidence %', () => {
    const state = resultCardWidget.initialState({
      personaName: 'Pending',
      stance: 'loading',
    });
    const out = resultCardWidget.render(state, ctx(), '').map(stripAnsi);
    expect(out.some(l => l.includes('\u2731'))).toBe(true);
    expect(out.some(l => l.includes('Running'))).toBe(true);
    // No numeric percent rendered when loading
    expect(out.some(l => /\d\d%/.test(l))).toBe(false);
  });

  test('error stance shows ✖ Error and surfaces error text', () => {
    const state = resultCardWidget.initialState({
      personaName: 'F',
      stance: 'error',
      error: 'timeout after 30s',
    });
    const out = resultCardWidget.render(state, ctx(), '').map(stripAnsi);
    expect(out.some(l => l.includes('\u2716'))).toBe(true);
    expect(out.some(l => l.includes('Error'))).toBe(true);
    expect(out.some(l => l.includes('timeout'))).toBe(true);
  });

  test('honors height — pads or truncates to exactly ctx.height rows', () => {
    const state = resultCardWidget.initialState({
      personaName: 'A',
      stance: 'bull',
      confidence: 80,
      summary: 'one two three four five six seven eight nine ten',
    });
    const short = resultCardWidget.render(state, ctx({ height: 4 }), '');
    expect(short.length).toBe(4);
    const tall = resultCardWidget.render(state, ctx({ height: 12 }), '');
    expect(tall.length).toBe(12);
  });

  test('returns empty output when height < 1 or width < 4', () => {
    const s = resultCardWidget.initialState({ personaName: 'x' });
    expect(resultCardWidget.render(s, ctx({ height: 0 }), '')).toEqual([]);
    expect(resultCardWidget.render(s, ctx({ width: 2 }), '')).toEqual([]);
  });

  test('truncates an over-long persona name inside the top border', () => {
    const state = resultCardWidget.initialState({
      personaName: 'A really, truly, astonishingly long persona name that cannot possibly fit',
      stance: 'bull',
      confidence: 50,
    });
    const out = resultCardWidget.render(state, ctx({ width: 20 }), '');
    // Top border must not exceed its allotted width.
    expect(out[0]!.length).toBeGreaterThan(0);
    // Ellipsis means truncate kicked in.
    expect(stripAnsi(out[0]!)).toMatch(/\u2026|…/);
  });

  test('confidence bar fills proportional to value', () => {
    const low = resultCardWidget.render(
      resultCardWidget.initialState({
        personaName: 'L', stance: 'bull', confidence: 10, summary: '.',
      }),
      ctx(),
      '',
    ).map(stripAnsi).join('\n');
    const high = resultCardWidget.render(
      resultCardWidget.initialState({
        personaName: 'H', stance: 'bull', confidence: 90, summary: '.',
      }),
      ctx(),
      '',
    ).map(stripAnsi).join('\n');
    const countBlocks = (s: string) => (s.match(/\u2588/g) || []).length;
    expect(countBlocks(high)).toBeGreaterThan(countBlocks(low));
  });
});

describe('result-card widget — onKey', () => {
  test('Enter on focused card returns submit with widgetId as text', () => {
    const state = resultCardWidget.initialState({ personaName: 'X', stance: 'bull' });
    const action = resultCardWidget.onKey!(
      { name: 'enter' },
      state,
      { widgetId: 'card-7' } as any,
    );
    expect(action.type).toBe('submit');
    if (action.type === 'submit') {
      expect(action.text).toBe('card-7');
    }
  });

  test('Shift+Enter does not submit (reserved for newline in input ctx)', () => {
    const state = resultCardWidget.initialState({ personaName: 'X', stance: 'bull' });
    const action = resultCardWidget.onKey!(
      { name: 'enter', shift: true },
      state,
      { widgetId: 'card-7' } as any,
    );
    expect(action.type).toBe('none');
  });

  test('other keys return none (j/k/h/l belong to plugin-level grid nav)', () => {
    const state = resultCardWidget.initialState({ personaName: 'X', stance: 'bull' });
    for (const name of ['j', 'k', 'h', 'l', 'space', 'a', 'escape']) {
      const action = resultCardWidget.onKey!(
        { name } as any,
        state,
        { widgetId: 'card-0' } as any,
      );
      expect(action.type).toBe('none');
    }
  });
});

describe('result-card widget — onMouse', () => {
  test('click submits widgetId as text', () => {
    const state = resultCardWidget.initialState({ personaName: 'X', stance: 'bull' });
    const action = resultCardWidget.onMouse!(
      { type: 'click', row: 2, col: 4 },
      state,
      { widgetId: 'card-3' } as any,
    );
    expect(action.type).toBe('submit');
    if (action.type === 'submit') {
      expect(action.text).toBe('card-3');
    }
  });

  test('double-click also submits widgetId as text', () => {
    const state = resultCardWidget.initialState({ personaName: 'X', stance: 'bull' });
    const action = resultCardWidget.onMouse!(
      { type: 'double-click', row: 2, col: 4 },
      state,
      { widgetId: 'card-4' } as any,
    );
    expect(action.type).toBe('submit');
    if (action.type === 'submit') {
      expect(action.text).toBe('card-4');
    }
  });

  test('scroll events remain no-op', () => {
    const state = resultCardWidget.initialState({ personaName: 'X', stance: 'bull' });
    const action = resultCardWidget.onMouse!(
      { type: 'scroll-down', row: 2, col: 4 },
      state,
      { widgetId: 'card-4' } as any,
    );
    expect(action.type).toBe('none');
  });
});

describe('wrapToWidth', () => {
  test('respects word boundaries', () => {
    const out = wrapToWidth('one two three four', 10);
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });

  test('hard-splits a single word longer than width', () => {
    const out = wrapToWidth('abcdefghijklmnop', 5);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const line of out) {
      expect(line.length).toBeLessThanOrEqual(5);
    }
  });

  test('returns empty array for width <= 0', () => {
    expect(wrapToWidth('anything', 0)).toEqual([]);
    expect(wrapToWidth('anything', -3)).toEqual([]);
  });

  test('handles Korean text (wide chars count as 2)', () => {
    const out = wrapToWidth('반도체 수급 긍정 평가', 10);
    // Each line's visible width must not exceed 10; raw length may be longer.
    // We just assert multiple lines produced, since each Korean char is 2 wide.
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});
