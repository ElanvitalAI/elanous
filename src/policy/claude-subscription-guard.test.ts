import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  assertClaudeSubscriptionAllowed,
  ClaudeSubscriptionNotAllowedError,
} from './claude-subscription-guard.js';

describe('Claude subscription boundary', () => {
  test('external-agent claude refuses and records exactly one event', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(() => assertClaudeSubscriptionAllowed({
        origin: 'external-agent', backendId: 'claude', surface: 'tui',
      })).toThrow(ClaudeSubscriptionNotAllowedError);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('policy.claude-subscription', 'refused', {
        origin: 'external-agent', backendId: 'claude', surface: 'tui',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('external-agent Claude ACP alias cannot bypass the subscription boundary', () => {
    expect(() => assertClaudeSubscriptionAllowed({
      origin: 'external-agent', backendId: 'cc', surface: 'tui',
    })).toThrow(ClaudeSubscriptionNotAllowedError);
  });

  test('external-agent grok and owner claude are not refused', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(() => assertClaudeSubscriptionAllowed({
        origin: 'external-agent', backendId: 'grok', surface: 'tui',
      })).not.toThrow();
      expect(() => assertClaudeSubscriptionAllowed({
        origin: 'owner', backendId: 'claude', surface: 'tui',
      })).not.toThrow();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
