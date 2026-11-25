// TUI-WIDGET-KIT-DEMO — each widget against hand-written literal lines (rule 11: no product constants in expectations).
import { describe, expect, test } from 'bun:test';
import { gaugeTone, renderFanoutBoard, renderGauge, renderResultCard, renderStat, renderStatRow, renderStepList, type GaugeProps } from './index.js';

/** Gauge props by position: label, value, top of scale, optional threshold mark, optional unit. */
const g = (label: string, value: number, top: number, mark?: number, unit?: string): GaugeProps =>
  ({ label, value, max: top, ...(mark === undefined ? {} : { threshold: mark }), ...(unit ? { unit } : {}) });

const fits = (lines: readonly string[], width: number) => {
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
};

const LONG = 'an extremely long line of agent output that keeps going well past any sane terminal width without stopping';

describe('FanoutBoard', () => {
  const props = {
    parent: { name: 'OP', modelTail: 'terra', state: 'running' as const },
    children: [
      { name: 'A', modelTail: 'terra', state: 'done' as const, progress: 1, elapsedMs: 5_000, lastLine: 'ok' },
      { name: 'B', modelTail: 'terra', state: 'failed' as const, progress: 0.3, elapsedMs: 65_000, lastLine: 'boom' },
    ],
  };

  test('80 columns: summary, tree rows, glyphs, bar, percent, elapsed', () => {
    expect(renderFanoutBoard(props, 80)).toEqual([
      '● OP · terra — 2 agents · 1 done · 1 failed',
      '├─ ✓ A     terra  ██████████ 100%     5s  ok',
      '└─ ✗ B     terra  ███░░░░░░░  30%  1m05s  boom',
    ]);
  });

  test('60 columns drops the model column; 40 also drops the bar', () => {
    expect(renderFanoutBoard(props, 60)[1]).toBe('├─ ✓ A     ██████████ 100%     5s  ok');
    expect(renderFanoutBoard(props, 40)[2]).toBe('└─ ✗ B      30%  1m05s  boom');
  });

  test('waiting with unknown progress shows a dash and an empty bar', () => {
    const lines = renderFanoutBoard({ parent: { name: 'P', state: 'waiting' }, children: [{ name: 'W', state: 'waiting', progress: null }] }, 80);
    expect(lines).toEqual(['◌ P — 1 agent · 1 waiting', '└─ ◌ W     ░░░░░░░░░░    —     0s']);
  });

  test('overflow at 40: long names, model and last line are cut with …', () => {
    const lines = renderFanoutBoard({
      parent: { name: LONG, modelTail: 'terra · codex CLI', state: 'running' },
      children: [{ name: 'Sentiment-and-more', modelTail: 'terra · codex CLI', state: 'running', progress: 0.5, elapsedMs: 9_999_000, lastLine: LONG }],
    }, 40);
    fits(lines, 40);
    expect(lines[0]!.endsWith('…')).toBe(true);
    expect(lines[1]).toBe('└─ ● Sentiment-a…   50%  2h46m  an extr…');
  });
});

describe('StepList', () => {
  test('glyphs and notes', () => {
    expect(renderStepList({ steps: [
      { label: 'Plan', state: 'done' }, { label: 'Collect', state: 'active', note: '2 of 3' }, { label: 'Panel', state: 'todo' },
    ] }, 80)).toEqual(['✓ Plan', '▸ Collect · 2 of 3', '○ Panel']);
  });

  test('overflow at 40', () => {
    const lines = renderStepList({ steps: [{ label: 'Step', state: 'active', note: LONG }] }, 40);
    expect(lines).toEqual(['▸ Step · an extremely long line of agen…']);
  });
});

describe('Stat / StatRow', () => {
  test('tile: value / target unit, delta arrow, tone mark', () => {
    expect(renderStat({ label: 'Landed', value: 18, target: 20, unit: 'per h', delta: -2, tone: 'warn' }, 80)).toEqual(['Landed', '18 / 20 per h ▼2 !']);
    expect(renderStat({ label: 'Cost', value: 3.25, unit: 'USD', delta: 0.5, tone: 'neutral' }, 80)).toEqual(['Cost', '3.3 USD ▲0.5']);
  });

  test('row wraps into bands that fit the width', () => {
    const stats = [
      { label: 'Alpha', value: 1 }, { label: 'Beta', value: 22 }, { label: 'Gamma', value: 333 }, { label: 'Delta', value: 4444 },
    ];
    expect(renderStatRow(stats, 80)).toEqual(['Alpha   Beta   Gamma   Delta', '1       22     333     4444']);
    expect(renderStatRow(stats, 15)).toEqual(['Alpha   Beta', '1       22', 'Gamma   Delta', '333     4444']);
  });

  test('overflow at 40: a tile wider than the row is cut', () => {
    const lines = renderStatRow([{ label: LONG, value: LONG }, { label: 'x', value: 1 }], 40);
    fits(lines, 40);
    expect(lines).toEqual([
      'an extremely long line of agent output…',
      'an extremely long line of agent output…',
      'x',
      '1',
    ]);
  });
});

describe('Gauge', () => {
  test('threshold marker and tone', () => {
    expect(renderGauge(g('Load', 50, 100, 75), 40)).toBe('Load █████████░░░░│░░░ 50/100 · under 75');
    expect(renderGauge(g('Load', 90, 100, 75, '%'), 80)).toBe('Load ██████████████████│███░░ 90/100 % · over 75');
    expect(gaugeTone(g('x', 1, 2))).toBe('none');
  });

  test('value above max clamps the bar; no threshold has no marker', () => {
    expect(renderGauge(g('Q', 12, 10), 30)).toBe('Q ██████████████████████ 12/10');
  });

  test('overflow at 40: no room for a bar → label and tail, cut', () => {
    const line = renderGauge(g(LONG, 1, 2, 1), 40);
    expect(line).toBe('an extremely long line of agent output…');
  });
});

describe('ResultCard', () => {
  test('box, sections, [n] evidence, disclaimer at 40', () => {
    expect(renderResultCard({
      title: 'Answer',
      subtitle: 'Short take',
      sections: [{ heading: 'Why', lines: ['Because of reason one [1]'] }],
      evidence: [{ n: 1, label: 'Source', url: 'example.com' }],
      disclaimer: 'Not advice.',
    }, 40)).toEqual([
      '╭─ Answer ─────────────────────────────╮',
      '│ Short take                           │',
      '│                                      │',
      '│ Why                                  │',
      '│   Because of reason one [1]          │',
      '│                                      │',
      '│ Evidence                             │',
      '│   [1] Source — example.com           │',
      '│                                      │',
      '│ Not advice.                          │',
      '╰──────────────────────────────────────╯',
    ]);
  });

  test('overflow at 40: long title, unbroken url, long lines all stay inside the box', () => {
    const lines = renderResultCard({
      title: LONG,
      sections: [{ heading: LONG, lines: [LONG] }],
      evidence: [{ n: 12, label: 'x', url: `https://example.com/${'a'.repeat(80)}` }],
    }, 40);
    fits(lines, 40);
    for (const line of lines.slice(1, -1)) expect(line.startsWith('│ ') && line.endsWith(' │')).toBe(true);
    expect(lines[0]).toBe('╭─ an extremely long line of agent o… ─╮');
  });
});
