import { expect, test } from 'bun:test';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './c3-mail.js';

test('C3 shares one mail owner and reports the remaining unmeasured routes', async () => {
  const events: Array<{ name: string; data: unknown }> = [];
  const ctx = { universeRoot: '/isolated', recorder: { event: (name: string, data: unknown) => { events.push({ name, data }); } } } as unknown as SimWorldScenarioContext;
  const result = await simWorldScenarios[0]!.run(ctx);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected partial measurement');
  expect(result.reason).toBe('C3 remaining mail routes unmeasured');
  expect(events).toEqual([{ name: 'c3-mail-race', data: { msgId: 1, before: [1], after: [1] } }]);
});
