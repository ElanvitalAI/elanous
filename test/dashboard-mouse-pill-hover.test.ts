import { describe, expect, test } from 'bun:test';
import { pillHoverTarget } from '../src/dashboard/input/mouse-pill-hover.js';
import type { PillBound } from '../src/status/pills.js';

describe('pillHoverTarget', () => {
  const pills: PillBound[] = [
    { name: 'workingDir', startCol: 0,  endCol: 10 },
    { name: 'model',      startCol: 12, endCol: 22 },
  ];

  test('returns null when statusRow is null', () => {
    expect(pillHoverTarget(pills, null, 5, 5)).toBeNull();
  });

  test('returns null when row is neither statusRow nor statusRow-1', () => {
    expect(pillHoverTarget(pills, 23, 10, 5)).toBeNull();
  });

  test('returns null for a column between pills', () => {
    expect(pillHoverTarget(pills, 23, 23, 12)).toBeNull();  // col=12 → col0=11 gap
  });

  test('returns target with default tooltip for a pill hit', () => {
    const t = pillHoverTarget(pills, 23, 23, 6);  // col0=5 falls inside workingDir
    expect(t).not.toBeNull();
    expect(t!.id).toBe('pill:workingDir');
    expect(t!.kind).toBe('status-bar-pill');
    expect(t!.tooltipText).toContain('Working directory');
  });

  test('accepts statusRow-1 with one-row tolerance', () => {
    const t = pillHoverTarget(pills, 23, 22, 6);  // row=22 == statusRow-1
    expect(t).not.toBeNull();
  });

  test('custom tooltipFor can hide a pill via returning null', () => {
    const t = pillHoverTarget(pills, 23, 23, 6, () => null);
    expect(t).not.toBeNull();
    expect(t!.tooltipText).toBeUndefined();
  });
});

