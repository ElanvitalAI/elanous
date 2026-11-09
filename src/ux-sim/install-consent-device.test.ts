import { expect, test } from 'bun:test';
import { INSTALL_DETERMINISTIC_SMOKE_TESTS, shouldRunInstallTest } from '../../scripts/lib/install-test-tier.js';
import { runInstallConsentSimulation } from './install-consent-device.js';

test('install consent device runs the real installer refusal, e2e helper, and verify flow', async () => {
  const result = await runInstallConsentSimulation();
  expect(result).toMatchObject({ pass: true, refusal: { status: 1, consentRequired: true, prefixCreated: false }, e2e: { passed: true }, verify: { passed: true } });
  expect(result.e2e.installerArgs).toContain('--yes');
  expect(result.verify.installerArgs).toContain('--yes');
  expect(result.e2e.installerArgs).toContain('--no-setup');
  expect(result.verify.installerArgs).toContain('--no-setup');
  expect(INSTALL_DETERMINISTIC_SMOKE_TESTS).toEqual([
    'installs a working elanous and records nonempty metadata without leaving its isolated home',
    'preserves the first installation startup file across a real reinstallation',
    'does not shadow a foreign eln earlier on PATH',
  ]);
  expect(INSTALL_DETERMINISTIC_SMOKE_TESTS.every((name) => shouldRunInstallTest(name, 'deterministic'))).toBe(true);
  expect(shouldRunInstallTest('release installer uses the first-run bootstrap command', 'deterministic')).toBe(false);
  expect(shouldRunInstallTest('release installer uses the first-run bootstrap command', 'nightly')).toBe(true);
});
