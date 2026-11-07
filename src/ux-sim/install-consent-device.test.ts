import { expect, test } from 'bun:test';
import { runInstallConsentSimulation } from './install-consent-device.js';

test('install consent device runs the real installer refusal, e2e helper, and verify flow', async () => {
  const result = await runInstallConsentSimulation();
  expect(result).toMatchObject({ pass: true, refusal: { status: 1, consentRequired: true, prefixCreated: false }, e2e: { passed: true }, verify: { passed: true } });
  expect(result.e2e.installerArgs).toContain('--yes');
  expect(result.verify.installerArgs).toContain('--yes');
  expect(result.e2e.installerArgs).toContain('--no-setup');
  expect(result.verify.installerArgs).toContain('--no-setup');
});
