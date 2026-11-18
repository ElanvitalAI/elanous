import { describe, expect, test } from 'bun:test';
import { requestDashboardGraphConfirmation, requestDashboardGraphDecision } from './plugin-route-adapter.js';
import type { InlineChoiceBroker } from '../tui/inline-choice.js';

const brokerAnswering = (answer: unknown): InlineChoiceBroker => ({ ask: async () => answer }) as unknown as InlineChoiceBroker;

describe('classic dashboard graph approval', () => {
  test('only an explicit N is a refusal; dismissing the question means nobody decided', async () => {
    expect(await requestDashboardGraphDecision(brokerAnswering({ selected: ['y'] }), 'q')).toEqual({ approved: true });
    expect(await requestDashboardGraphDecision(brokerAnswering({ selected: ['N'] }), 'q'))
      .toEqual({ approved: false, reason: 'declined' });
    expect(await requestDashboardGraphDecision(brokerAnswering({ cancelled: true }), 'q'))
      .toEqual({ approved: false, reason: 'turn-cancelled' });
  });

  test('the boolean form keeps answering false for both (callers that cannot hold are unchanged)', async () => {
    expect(await requestDashboardGraphConfirmation(brokerAnswering({ cancelled: true }), 'q')).toBe(false);
    expect(await requestDashboardGraphConfirmation(brokerAnswering({ selected: ['N'] }), 'q')).toBe(false);
    expect(await requestDashboardGraphConfirmation(brokerAnswering({ selected: ['y'] }), 'q')).toBe(true);
  });
});
