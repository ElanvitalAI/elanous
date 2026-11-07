import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runReleaseInstaller, verifyRelease, type Runner, type RunResult } from '../cli/release-cli.js';

export interface InstallConsentSimulation {
  pass: boolean;
  refusal: { status: number | null; consentRequired: boolean; prefixCreated: boolean };
  e2e: { passed: boolean; installerArgs: readonly string[] };
  verify: { passed: boolean; installerArgs: readonly string[] };
}

export async function runInstallConsentSimulation(): Promise<InstallConsentSimulation> {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-install-consent-'));
  try {
    const home = join(root, 'home');
    const prefix = join(root, 'prefix');
    const installer = join(import.meta.dir, '../../scripts/install.sh');
    const refusalEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: home, ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_ANSWER: 'n', ELANOUS_INSTALL_LANG: 'en' };
    const refused = spawnSync('/bin/bash', [installer, '--prefix', prefix, '--no-modify-path'], {
      encoding: 'utf8', env: refusalEnv,
    });
    const refusal = { status: refused.status, consentRequired: refused.stderr.includes('consent required'), prefixCreated: existsSync(prefix) };
    const runBashScript: Runner = (command, args, cwd, opts) => {
      const env: NodeJS.ProcessEnv = opts?.env ?? { NODE_ENV: 'test', PATH: '/usr/bin:/bin' };
      const result = spawnSync(command, [...args], { cwd, env, input: opts?.input, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const e2eRun: Runner = (command, args, cwd, opts) => runBashScript(command, args, cwd, { ...opts, input: 'printf \"%s\\n\" \"$@\"\n' });
    const e2e = runReleaseInstaller('ignored by runner', root, { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: home }, e2eRun);
    const e2eArgs = e2e.stdout.trim().split('\n');

    let verifyArgs: readonly string[] = [];
    const verifyRun: Runner = (command, args, cwd, opts): RunResult => {
      if (command === 'curl' && args[0] === '-fsSL') return { status: 0, stdout: 'printf \"%s\\n\" \"$@\"\n', stderr: '' };
      if (command === 'bash' && args[0] === '-s') {
        const result = runBashScript(command, args, cwd, opts);
        verifyArgs = result.stdout.trim().split('\n');
        return result;
      }
      if (args[0] === '--version') return { status: 0, stdout: '0.3.5 abcdef0123456789\n', stderr: '' };
      if (args[0] === 'memory' && args[1] === 'search') return { status: 0, stdout: `${args[2]}\n`, stderr: '' };
      if (args[0] === 'logs') return { status: 0, stdout: `${JSON.stringify({ ts_ms: Date.now() })}\n`, stderr: '' };
      if (args[0] === 'nexus' && args[1] === '--status') return { status: 0, stdout: 'status not running\n', stderr: '' };
      if (command === 'curl') return { status: 0, stdout: '200', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const verified = await verifyRelease({ version: '0.3.5', log: () => {} }, verifyRun);
    const e2ePassed = e2e.status === 0 && JSON.stringify(e2eArgs) === JSON.stringify(['--yes', '--no-modify-path', '--no-setup']);
    const verifyPassed = verified.ok && JSON.stringify(verifyArgs) === JSON.stringify(['--yes', '--no-modify-path', '--no-setup']);
    return { pass: refusal.status === 1 && refusal.consentRequired && !refusal.prefixCreated && e2ePassed && verifyPassed,
      refusal, e2e: { passed: e2ePassed, installerArgs: e2eArgs }, verify: { passed: verifyPassed, installerArgs: verifyArgs } };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
