import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('classic dashboard no longer registers or dispatches the plugin wizard', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('StartPluginWizard');
  expect(source).not.toContain('plugin-wizard-runtime');
  expect(source).not.toContain('plugin-wizard-tool');
});
