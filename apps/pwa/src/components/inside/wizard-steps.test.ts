import { expect, test } from 'bun:test';
import type { WizardStepEvent } from '@/lib/inside-events';
import { wizardTimeline } from './wizard-steps';

const event = (step: WizardStepEvent['step'], wizardId = 'one', detail?: unknown): WizardStepEvent => ({
  ts: '2026-10-03T09:00:00Z', wizardId, step, text: `${step} message`, ...(detail === undefined ? {} : { detail }),
});
const steps: WizardStepEvent['step'][] = ['request', 'research', 'draft', 'validate', 'install', 'done'];
const labels = ['요청', '조사', '초안', '검증', '설치', '끝'];

test('no wizard events yields no timeline', () => {
  expect(wizardTimeline([])).toEqual([]);
});

test('request and research show six ordered steps, past done, latest now, future todo, and event text/time', () => {
  const rows = wizardTimeline([event('request'), event('research')]);
  expect(rows.map(row => row.step)).toEqual(steps);
  expect(rows.map(row => row.label)).toEqual(labels);
  expect(rows.map(row => row.state)).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[0]).toMatchObject({ text: 'request message', at: '2026-10-03T09:00:00Z' });
  expect(rows[1]).toMatchObject({ text: 'research message', at: '2026-10-03T09:00:00Z' });
  expect(rows[2]).not.toHaveProperty('text');
  expect(rows[2]).not.toHaveProperty('at');
});

test('done makes all six steps done, including a previous failed attempt', () => {
  expect(wizardTimeline([event('validate', 'one', { ok: false }), event('done')]).map(row => row.state)).toEqual(Array(6).fill('done'));
});

test('validate detail.ok false marks validation failed, including when it is the latest event', () => {
  expect(wizardTimeline([event('request'), event('validate', 'one', { ok: false })]).map(row => row.state))
    .toEqual(['done', 'done', 'done', 'failed', 'todo', 'todo']);
  expect(wizardTimeline([event('validate', 'one', { ok: true })])[3].state).toBe('now');
});

test('only the last wizard ID contributes events even if the earlier ID has more events', () => {
  const rows = wizardTimeline([event('request', 'one'), event('research', 'one'), event('done', 'one'), event('request', 'two')]);
  expect(rows.map(row => row.state)).toEqual(['now', 'todo', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[1]).not.toHaveProperty('text');
});

test('repeated events for one step use its latest text and timestamp', () => {
  const rows = wizardTimeline([event('request'), { ...event('request'), text: '새 요청', ts: '2026-10-03T09:01:00Z' }]);
  expect(rows[0]).toMatchObject({ state: 'now', text: '새 요청', at: '2026-10-03T09:01:00Z' });
});
