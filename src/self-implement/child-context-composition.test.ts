import { describe, expect, test } from 'bun:test';
import {
  CHILD_CONTEXT_COMPONENT_NAMES,
  SMALL_CHILD_CONTEXT_TOKEN_BUDGET,
  composeChildContext,
} from './child-context-composition.js';

describe('composeChildContext', () => {
  test('default profile joins the components in the existing first-turn order without truncating', () => {
    const components = {
      systemPrompt: 'system',
      agentsMd: 'agents',
      claudeMd: 'claude',
      toolSchemas: 'tools',
      goal: 'goal',
      ledger: 'ledger',
    };
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];

    const result = composeChildContext(components, {
      log: (event, data) => events.push({ event, data }),
    });

    expect(result.text).toBe('system\n\nagents\n\nclaude\n\ntools\n\ngoal\n\nledger');
    expect(result.profile).toBe('default');
    expect(result.budgetTokens).toBeNull();
    expect(CHILD_CONTEXT_COMPONENT_NAMES.every((name) => !result.components[name].truncated)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('child.context-composition');
    expect(events[0]?.data.profile).toBe('default');
  });

  test('small profile caps the first-turn input and reports each component size', () => {
    const log: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = composeChildContext({
      systemPrompt: 'S'.repeat(4_000),
      agentsMd: 'A'.repeat(24_000),
      claudeMd: 'C'.repeat(24_000),
      toolSchemas: 'T'.repeat(3_000),
      goal: 'G'.repeat(3_000),
      ledger: 'L'.repeat(3_000),
    }, {
      profile: 'small',
      log: (event, data) => log.push({ event, data }),
    });

    expect(result.budgetTokens).toBe(32_000);
    expect(result.tokenUpperBound).toBeLessThanOrEqual(SMALL_CHILD_CONTEXT_TOKEN_BUDGET);
    expect(result.components.systemPrompt.includedBytes).toBe(4_000);
    expect(result.components.toolSchemas.includedBytes).toBe(3_000);
    expect(result.components.goal.includedBytes).toBe(3_000);
    expect(result.components.ledger.includedBytes).toBe(3_000);
    expect(result.components.agentsMd.truncated).toBe(true);
    expect(result.components.claudeMd.truncated).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0]?.event).toBe('child.context-composition');
    expect(log[0]?.data.tokenUpperBound).toBe(result.tokenUpperBound);
    expect(log[0]?.data.components).toEqual(result.components);
  });

  test('small profile truncates only at complete Unicode characters and sink failure is fail-open', () => {
    const result = composeChildContext({
      systemPrompt: '🙂'.repeat(9_000),
      goal: '요청'.repeat(9_000),
    }, {
      profile: 'small',
      log: () => { throw new Error('sink unavailable'); },
    });

    expect(result.tokenUpperBound).toBeLessThanOrEqual(SMALL_CHILD_CONTEXT_TOKEN_BUDGET);
    expect(result.text).not.toContain('\uFFFD');
    expect(result.components.goal.truncated).toBe(true);
    expect(result.components.goal.includedBytes % Buffer.byteLength('요', 'utf8')).toBe(0);
  });
});
