// TUI-FOOTER-BREATHING-ROOM ④: the decision table behind the breathing bottom — expected values literal.
import { expect, test } from 'bun:test';
import { keepBottomStatus } from './bottom-status.js';
import { FOOTER_BREATHING_MIN_ROWS, footerBreathingRoom } from './footer-breathing-room.js';

const SCREEN = { headerRows: 2, footerRows: 2, compactHeight: 24, bottomStatus: true } as const;

test('a roomy screen breathes; the compact height and the footer budget fold the spare rows first', () => {
  // ③ margin · ② blank · the separator over the input (the old rule stays, 대표 r2) · the input · ① the separator under it · the status line · one conversation row.
  expect(FOOTER_BREATHING_MIN_ROWS).toBe(7);
  // 24줄 이하 folds the spare rows first; today's tight layout stays (the #38392 separator keeps its row).
  expect(footerBreathingRoom({ ...SCREEN, rows: 24 })).toBe(false);
  expect(footerBreathingRoom({ ...SCREEN, rows: 8 })).toBe(false);
  // One row over the compact height already breathes.
  expect(footerBreathingRoom({ ...SCREEN, rows: 25 })).toBe(true);
  expect(footerBreathingRoom({ ...SCREEN, rows: 40 })).toBe(true);
  // A footer (an approval, a panel) that leaves no room for every bottom row plus one conversation row folds them.
  expect(footerBreathingRoom({ ...SCREEN, rows: 25, footerRows: 18 })).toBe(false); // 25 − 2 − 18 = 5
  expect(footerBreathingRoom({ ...SCREEN, rows: 25, footerRows: 17 })).toBe(false); // 25 − 2 − 17 = 6
  expect(footerBreathingRoom({ ...SCREEN, rows: 25, footerRows: 16 })).toBe(true); // 25 − 2 − 16 = 7
  // Without the bottom status line there is nothing to separate; the tight layout stays.
  expect(footerBreathingRoom({ ...SCREEN, rows: 40, bottomStatus: false })).toBe(false);
  // A configured compact height moves the fold line with it.
  expect(footerBreathingRoom({ ...SCREEN, rows: 28, compactHeight: 30 })).toBe(false);
  expect(footerBreathingRoom({ ...SCREEN, rows: 31, compactHeight: 30 })).toBe(true);
});

test('keepBottomStatus reserves the breathing separator as a second status-block row', () => {
  // #38392 r2 keeps its lock: the default status block stays one row.
  expect(keepBottomStatus({ rows: 5, headerRows: 2, footerRows: 0 })).toBe(true); // 5 − 2 − 1 − 1 = 1
  expect(keepBottomStatus({ rows: 4, headerRows: 2, footerRows: 0 })).toBe(false); // 4 − 2 − 1 − 1 = 0
  // With the separator under the input the status block is two rows.
  expect(keepBottomStatus({ rows: 6, headerRows: 2, footerRows: 0, statusRows: 2 })).toBe(true); // 6 − 2 − 1 − 2 = 1
  expect(keepBottomStatus({ rows: 5, headerRows: 2, footerRows: 0, statusRows: 2 })).toBe(false); // 5 − 2 − 1 − 2 = 0
});
