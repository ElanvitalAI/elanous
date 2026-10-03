import { expect, test } from 'bun:test';
import { isPhoneWidth, phonePaneFor } from './phone-pane';

test('phone width ends at 639px; 640px is wide', () => {
  expect(isPhoneWidth(639)).toBe(true);
  expect(isPhoneWidth(640)).toBe(false);
});

test('phone pane defaults to list before selection and canvas after selection', () => {
  expect(phonePaneFor(null, null)).toBe('list');
  expect(phonePaneFor(null, 'my-workflow')).toBe('canvas');
});

test('requested pane takes precedence over the selection default', () => {
  expect(phonePaneFor('run', null)).toBe('run');
  expect(phonePaneFor('list', 'my-workflow')).toBe('list');
  expect(phonePaneFor('canvas', null)).toBe('canvas');
});
