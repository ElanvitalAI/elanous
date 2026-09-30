import { describe, expect, it } from 'bun:test';
import { cardMetaParts, relativeTime } from './card-meta';

const now = Date.parse('2026-09-30T00:00:00Z');

describe('board card meta (teaser S02 · raw ISO and «Incidents 0 · —» are not for people)', () => {
  it('relative time reads as people talk', () => {
    expect(relativeTime(now - 20_000, now)).toBe('방금');
    expect(relativeTime(now - 7 * 60_000, now)).toBe('7분 전');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3시간 전');
    expect(relativeTime(Date.parse('2026-09-28T01:05:00Z'), now, 'Asia/Seoul')).toBe('9/28 10:05');
  });
  it('zero incidents and missing run are omitted; the raw ISO string never appears', () => {
    const parts = cardMetaParts({ runId: null, updatedAt: now - 5 * 60_000 }, 0, now);
    expect(parts).toEqual(['5분 전']);
    expect(parts.join(' · ')).not.toContain('Incidents');
    expect(parts.join(' · ')).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  it('open incidents and a run id are shown briefly', () => {
    expect(cardMetaParts({ runId: 'run-12345678-aaaa', updatedAt: now }, 2, now)).toEqual(['사고 2', '런 12345678', '방금']);
  });
});
