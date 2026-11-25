// ELS-MODEL-META-ALL-SEATS — every eln reports its live model to els, once per change (literals · OP rule 11).
import { expect, test } from 'bun:test';
import { createModelReporter } from './hand-tab-title.js';

test('sends on boot, skips an unchanged model, sends again after /model, never sends an empty or failed lookup', async () => {
  const sent: unknown[] = [];
  let model: string | undefined = 'gpt-6.1-terra';
  let fail = false;
  const reporter = createModelReporter({ model: () => { if (fail) throw new Error('config unreadable'); return model; }, emit: (meta) => sent.push(meta) });
  expect(await reporter.refresh()).toBe('gpt-6.1-terra');
  expect(await reporter.refresh()).toBeNull();
  model = 'claude-opus-5-5';
  expect(await reporter.refresh()).toBe('claude-opus-5-5');
  model = '  ';
  expect(await reporter.refresh()).toBeNull();
  fail = true;
  expect(await reporter.refresh()).toBeNull();
  expect(sent).toEqual([{ model: 'gpt-6.1-terra' }, { model: 'claude-opus-5-5' }]);
});
