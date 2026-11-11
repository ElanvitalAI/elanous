import { constants as fsConstants, accessSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

type Probe = (command: string, args: readonly string[], environment: NodeJS.ProcessEnv) => boolean;
// Source: src/ux-sim/world.ts uses a bounded host probe before selecting the OS sandbox.
const SANDBOX_PROBE_TIMEOUT_MS = 10_000;

function defaultProbe(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, [...args], { stdio: 'ignore', env: environment, timeout: SANDBOX_PROBE_TIMEOUT_MS });
  return !result.error && result.status === 0;
}

/** Check that this host can start the same network isolated worlds used by sim world run. */
export function assertNetworkZeroSandboxAvailable(environment: NodeJS.ProcessEnv = process.env, probe: Probe = defaultProbe): void {
  if (process.platform === 'darwin') {
    try { accessSync('/usr/bin/sandbox-exec', fsConstants.X_OK); return; }
    catch { throw new Error('sim app requires the macOS network sandbox'); }
  }
  if (process.platform !== 'linux') throw new Error(`sim app has no network sandbox for ${process.platform}`);

  const unshare = environment.PATH?.split(':').map((directory) => `${directory}/unshare`).find((path) => {
    try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; }
  });
  if (unshare && probe(unshare, ['-rn', process.execPath, '-e', 'process.exit(0)'], environment)) return;

  const bwrap = environment.PATH?.split(':').map((directory) => `${directory}/bwrap`).find((path) => {
    try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; }
  });
  if (bwrap && probe(bwrap, ['--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--chdir', process.cwd(), process.execPath, '-e', 'process.exit(0)'], environment)) return;
  throw new Error('sim app requires a usable Linux unshare -rn or bwrap --unshare-net network sandbox');
}
