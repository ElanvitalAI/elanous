import { describe, expect, test } from 'bun:test';

import type { ViewportSample } from './responsive-layout.js';
import { siteQaTable } from './qa-table.js';

const sample = (width: number): ViewportSample => ({
  width,
  report: {
    url: 'https://example.test/',
    viewport: { w: width, h: 900 },
    spacing: [{ px: 16, count: 4, kinds: ['padding'] }],
    baseUnit: null,
    baseUnitReason: '',
    containers: [{ px: Math.min(width - 32, 720), count: 4, ratio: Math.min(width - 32, 720) / width }],
    verticalRhythm: [],
    sampled: 10,
    blindSpots: [],
  },
});

describe('siteQaTable', () => {
  test('siteQaTable renders the three widths from the existing responsive report and marks real device as unverified', () => {
    const result = siteQaTable([sample(390), sample(768), sample(1280)]);
    expect(result.widths).toEqual([390, 768, 1280]);
    expect(result.lines[0]).toBe('폭 390 · 768 · 1280');
    expect(result.lines.join('\n')).toContain('### 반응형 — 폭이 바뀌면 무엇이 «따라 변하나»');
    expect(result.lines.join('\n')).toContain('| 390px |');
    expect(result.lines.join('\n')).toContain('| 768px |');
    expect(result.lines.join('\n')).toContain('| 1280px |');
    expect(result.realDevice).toBe('미확인');
    expect(result.lines).toContain('실기기: 미확인');
  });

  test('missing viewport width is marked as not measured, not zero', () => {
    const result = siteQaTable([sample(390), sample(1280)]);
    expect(result.lines).toContain('768 못 잼');
    expect(result.lines.join('\n')).not.toContain('| 768px |');
  });

  test('ignores extra widths and reflects measured content at a QA width', () => {
    const changed = sample(768);
    const measured: ViewportSample = {
      ...changed,
      report: {
        ...changed.report,
        containers: [{ px: 512, count: 4, ratio: 512 / 768 }],
      },
    };
    const result = siteQaTable([sample(390), measured, sample(1280), sample(1440)]);
    expect(result.lines.join('\n')).toContain('| 768px | 512px | 67% |');
    expect(result.lines.join('\n')).not.toContain('| 1440px |');
  });
});
