export const INSTALL_DETERMINISTIC_SMOKE_TESTS = [
  'installs a working elanous and records nonempty metadata without leaving its isolated home',
  'preserves the first installation startup file across a real reinstallation',
  'does not shadow a foreign eln earlier on PATH',
] as const;

export type InstallTestTier = 'deterministic' | 'nightly';

export function shouldRunInstallTest(name: string, tier: InstallTestTier): boolean {
  return tier === 'nightly' || INSTALL_DETERMINISTIC_SMOKE_TESTS.includes(name as typeof INSTALL_DETERMINISTIC_SMOKE_TESTS[number]);
}
