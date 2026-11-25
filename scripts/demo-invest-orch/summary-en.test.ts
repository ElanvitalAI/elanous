// DEMO-ENGLISH: what a demo viewer reads from the invest run — tab titles and the CLI summary. Independent literals.
import { expect, test } from 'bun:test';
import { investDecisionSummaryEn, investRunSummaryLines, investTabTitle } from './handlers.js';

test('panel tabs are titled in English', () => {
  expect(investTabTitle('panel-global-macro', 'eln')).toBe('Global macro · eln');
  expect(investTabTitle('panel-hbm-ai-retry', 'codex')).toBe('HBM / AI · codex · retry');
  expect(investTabTitle('mentor-2', 'claude')).toBe('Mentor 2 · claude');
});

test('the run summary is English', () => {
  expect(investDecisionSummaryEn(25, 1)).toBe('25 decisions → 24 automatic · 1 for you');
  expect(investDecisionSummaryEn(1, 0)).toBe('1 decision → 1 automatic · 0 for you');
  expect(investRunSummaryLines({ panel: { action: 'HOLD', score: 0.06 }, mentors: { action: 'HOLD', score: 0 }, overall: { action: 'HOLD', score: 0.03 } }, 25, 0)).toEqual([
    'Research demo · not investment advice · no order is placed',
    'Panel HOLD (0.06) · mentors HOLD (0) · overall HOLD (0.03)',
    '25 decisions → 25 automatic · 0 for you',
  ]);
});
