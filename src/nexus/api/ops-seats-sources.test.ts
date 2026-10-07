import { expect, test } from 'bun:test';
import { checklistDevVersion, devVersion } from '../../release-loop/checklist.js';
import { liveSeatsSources } from './ops-seats-sources.js';

// 10-07 live check: /app/ceo «릴리스 판 진행» stayed «못 읽음» — once package.json became `0.2.18-dev.0`,
// the seat board passed that raw string to listChecklist, which rejects it, so every seat's checklist was null.
test('checklistDevVersion strips only a -dev.N tail', () => {
  expect(checklistDevVersion('0.2.18-dev.0')).toBe('0.2.18');
  expect(checklistDevVersion('0.2.18-dev.12')).toBe('0.2.18');
  expect(checklistDevVersion('0.2.18')).toBe('0.2.18');
  expect(checklistDevVersion('0.2.18-rc.1')).toBe('0.2.18-rc.1');
});

test('the live seat board reads the checklist for the tree’s own package version', () => {
  // Whatever package.json says right now (a release tree or a -dev.N tree), the source must not throw.
  expect(() => liveSeatsSources().checklist()).not.toThrow();
  expect(liveSeatsSources().checklist()).toMatchObject({ current: expect.any(Array), all: expect.any(Array) });
  expect(checklistDevVersion()).toBe(devVersion().replace(/-dev\.\d+$/, ''));
});
