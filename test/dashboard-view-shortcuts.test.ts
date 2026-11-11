import { describe, expect, test } from 'bun:test';
import { matchDashboardViewShortcut } from '../src/dashboard/input/dashboard-view-shortcuts.js';

describe('matchDashboardViewShortcut', () => {
  test('matches modified digit shortcuts directly', () => {
    expect(matchDashboardViewShortcut({ name: '7', ctrl: true, shift: false })).toBe('7');
    expect(matchDashboardViewShortcut({ name: '4', ctrl: true, shift: false })).toBe('4');
  });



  test('ignores plain slash and shifted or alt variants', () => {
    expect(matchDashboardViewShortcut({ name: '/', ctrl: false, shift: false })).toBeNull();
    expect(matchDashboardViewShortcut({ name: '/', ctrl: true, shift: true })).toBeNull();
    expect(matchDashboardViewShortcut({ name: '7', ctrl: true, shift: false, alt: true })).toBeNull();
  });
});
