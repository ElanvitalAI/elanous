import { expect, test } from 'bun:test';
import { KNOWN_LOG_EVENT_NAMES } from './log-event-names.js';

test('hold settlement and owner-child-watch observations are allowlisted', () => {
  expect(KNOWN_LOG_EVENT_NAMES).toEqual(expect.objectContaining(new Set([
    'hold-wait-settlement-failed',
    'hold-owner-child-died',
    'hold-owner-watch-timeout',
  ])));
});

test('POD-LIFECYCLE-STAGES: the pod.lifecycle «stages» line is allowlisted', () => {
  expect(KNOWN_LOG_EVENT_NAMES.has('stages')).toBe(true);
});

test('SI-SEED-DEFAULT: the mirror seed skip line is allowlisted', () => {
  expect(KNOWN_LOG_EVENT_NAMES.has('mirror-seed-skipped')).toBe(true);
});

test('capability tool tier split and task-agent tier split have distinct event names', () => {
  expect(KNOWN_LOG_EVENT_NAMES.has('tool-tier-split')).toBe(true);
  expect(KNOWN_LOG_EVENT_NAMES.has('tier-split')).toBe(true);
});
