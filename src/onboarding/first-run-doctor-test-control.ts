import { runFirstRunDoctor } from './first-run-doctor.js';

/**
 * Safe control for production-entry UX probes. The CLI gates this behind NODE_ENV=test
 * and ELANOUS_TEST_FIRSTRUN_DOCTOR_PROBE=1; all filesystem and install edges are inert.
 */
export function runFirstRunDoctorTestControl(): void {
  if (process.env.NODE_ENV !== 'test' || process.env.ELANOUS_TEST_FIRSTRUN_DOCTOR_PROBE !== '1') {
    throw new Error('first-run Doctor control requires the explicit test environment');
  }
  const bin = process.env.PATH ?? '';
  runFirstRunDoctor({
    home: process.env.HOME ?? '',
    configDir: process.env.HOME ?? '',
    cacheDir: process.env.HOME ?? '',
    env: process.env,
    readiness: {
      platform: 'linux',
      installPrefix: bin,
      pathEntries: bin.split(':'),
      tmpdirSameFsAsBunCache: true,
      distro: 'amzn2',
      rgOnPath: true,
      pythonEnv: { status: 'ok', evidence: 'fixture' },
    },
    exists: () => true,
    lstat: () => ({ mode: 0o700, isFile: () => false, isSymbolicLink: () => false }),
    readdir: () => [],
    readFile: () => '',
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    chmod: () => {},
    rename: () => {},
    remove: () => {},
    removeTree: () => {},
    installStaticTool: () => ({ ok: true, detail: 'fixture' }),
    smokeCheck: () => true,
    pythonSetup: () => 0,
    installManagedPython: () => ({ python: null, detail: 'fixture' }),
  });
}
