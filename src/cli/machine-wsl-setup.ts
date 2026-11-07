import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { applyMachineSetupPlan, type MachineSetupApplyResult } from './machine-setup-apply.js';
import { buildMachineSetupPlan, type MachineSetupPlan } from './machine-setup-plan.js';

export interface MachineWslCommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly errorCode?: string;
}

export interface MachineWslSetupResult {
  readonly kind: 'machine-wsl-setup-result';
  readonly status: 'resume-pending' | 'complete' | 'failed';
  readonly distribution: string;
  readonly user: string;
  readonly detail: string;
  readonly attempted: number;
  readonly failures: readonly { readonly operation: string; readonly reason: string }[];
  readonly profileResult?: MachineSetupApplyResult;
}

export interface MachineWslSetupDeps {
  readonly run?: (command: string, args: readonly string[], captureOutput?: boolean) => MachineWslCommandResult;
  readonly platform?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly entry?: string;
  readonly scheduleResume?: (commandLine: string) => MachineWslCommandResult;
}

const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const RUN_ONCE_VALUE = 'ElanousMachineSetup';

function run(command: string, args: readonly string[], captureOutput = false): MachineWslCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8', timeout: 15 * 60_000, windowsHide: true,
    stdio: captureOutput ? ['inherit', 'pipe', 'inherit'] : ['inherit', 'ignore', 'inherit'],
  });
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    return { status: null, ...(errorCode ? { errorCode } : {}) };
  }
  return { status: result.status, ...(captureOutput ? { stdout: result.stdout ?? '' } : {}) };
}

export function runMachineWslCommand(command: string, args: readonly string[], captureOutput = false): MachineWslCommandResult {
  return run(command, args, captureOutput);
}

export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function buildMachineWslResumeCommand(input: {
  readonly executable: string;
  readonly entry: string;
  readonly capture: string;
  readonly profile: string;
  readonly distribution: string;
  readonly user: string;
}): string {
  return [input.executable, input.entry, 'machine', 'apply', '--from', input.capture, '--profile', input.profile,
    '--platform', 'wsl', '--distribution', input.distribution, '--wsl-user', input.user, '--resume', '--yes']
    .map(quoteWindowsArgument).join(' ');
}

export function registerMachineWslRunOnce(commandLine: string): MachineWslCommandResult {
  return run('reg.exe', ['add', RUN_ONCE_KEY, '/v', RUN_ONCE_VALUE, '/t', 'REG_SZ', '/d', commandLine, '/f']);
}

function validDistribution(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function validWslUser(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
}

function fail(distribution: string, user: string, operation: string, result: MachineWslCommandResult): MachineWslSetupResult {
  const reason = result.status === null && result.errorCode ? `command unavailable (${result.errorCode})` : `exit ${result.status ?? 'unknown'}`;
  return { kind: 'machine-wsl-setup-result', status: 'failed', distribution, user, detail: operation,
    attempted: 1, failures: [{ operation, reason }] };
}

export function setWslConfiguration(original: string, user: string): string {
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  const cleaned: string[] = [];
  let section = '';
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) section = heading[1]!.trim().toLowerCase();
    if ((section === 'boot' && /^\s*systemd\s*=/i.test(line))
      || (section === 'user' && /^\s*default\s*=/i.test(line))) continue;
    cleaned.push(line);
  }
  while (cleaned.at(-1) === '') cleaned.pop();
  const hasSection = (name: string) => cleaned.some(line => new RegExp(`^\\s*\\[${name}\\]\\s*$`, 'i').test(line));
  if (hasSection('boot')) {
    let index = cleaned.findIndex(line => /^\s*\[boot\]\s*$/i.test(line)) + 1;
    while (index < cleaned.length && !/^\s*\[[^\]]+\]\s*$/.test(cleaned[index]!)) index += 1;
    cleaned.splice(index, 0, 'systemd=true');
  } else cleaned.push('', '[boot]', 'systemd=true');
  if (hasSection('user')) {
    let index = cleaned.findIndex(line => /^\s*\[user\]\s*$/i.test(line)) + 1;
    while (index < cleaned.length && !/^\s*\[[^\]]+\]\s*$/.test(cleaned[index]!)) index += 1;
    cleaned.splice(index, 0, `default=${user}`);
  } else cleaned.push('', '[user]', `default=${user}`);
  return `${cleaned.join('\n')}\n`;
}

export function applyMachineWslBootstrap(input: {
  readonly capture: string;
  readonly profile: string;
  readonly distribution: string;
  readonly user: string;
  readonly resume: boolean;
  readonly deps?: MachineWslSetupDeps;
}): MachineWslSetupResult {
  const { distribution, user } = input;
  if (!validDistribution(distribution)) throw new Error('WSL distribution name is invalid');
  if (!validWslUser(user)) throw new Error('WSL username must match [a-z_][a-z0-9_-]{0,31}');
  const deps = input.deps ?? {};
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('WSL bootstrap must run from Windows; run machine apply inside WSL to apply a profile');
  const command = deps.run ?? run;
  let attempted = 0;
  const invoke = (name: string, args: readonly string[], captureOutput = false) => {
    attempted += 1;
    return command(name, args, captureOutput);
  };
  if (!input.resume) {
    const executable = deps.executable ?? process.execPath;
    const entry = deps.entry ?? process.argv[1];
    if (!entry) throw new Error('cannot register WSL resume because the Elanous entry path is unavailable');
    const resumeCommand = buildMachineWslResumeCommand({ executable, entry, capture: input.capture,
      profile: input.profile, distribution, user });
    const scheduled = (deps.scheduleResume ?? registerMachineWslRunOnce)(resumeCommand);
    if (scheduled.status !== 0) return fail(distribution, user, 'register-resume', scheduled);
    const installed = invoke('wsl.exe', ['--install', '--distribution', distribution, '--no-launch']);
    if (installed.status !== 0) return fail(distribution, user, 'wsl-install', installed);
    return { kind: 'machine-wsl-setup-result', status: 'resume-pending', distribution, user,
      detail: 'WSL install requested; sign in after reboot to resume systemd and profile setup', attempted: 1, failures: [] };
  }

  const rows = invoke('wsl.exe', ['--list', '--quiet'], true);
  const installedDistributions = (rows.stdout ?? '').replaceAll('\0', '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (rows.status !== 0 || !installedDistributions.some(value => value.toLowerCase() === distribution.toLowerCase())) {
    const executable = deps.executable ?? process.execPath;
    const entry = deps.entry ?? process.argv[1];
    if (!entry) throw new Error('cannot re-register WSL resume because the Elanous entry path is unavailable');
    const resumeCommand = buildMachineWslResumeCommand({ executable, entry, capture: input.capture,
      profile: input.profile, distribution, user });
    const scheduled = (deps.scheduleResume ?? registerMachineWslRunOnce)(resumeCommand);
    if (scheduled.status !== 0) return fail(distribution, user, 'register-resume', scheduled);
    const installed = invoke('wsl.exe', ['--install', '--distribution', distribution, '--no-launch']);
    if (installed.status !== 0) return fail(distribution, user, 'wsl-install', installed);
    return { kind: 'machine-wsl-setup-result', status: 'resume-pending', distribution, user,
      detail: 'distribution is not initialized yet; install requested and resume re-registered', attempted: 1, failures: [] };
  }

  const guest = (args: readonly string[], captureOutput = false) => invoke('wsl.exe', ['--distribution', distribution, '--user', 'root', '--exec', ...args], captureOutput);
  const account = guest(['/usr/bin/id', '-u', user], true);
  if (account.status !== 0) {
    const created = guest(['/usr/sbin/useradd', '--create-home', '--shell', '/bin/bash', user]);
    if (created.status !== 0) return fail(distribution, user, 'create-user', created);
  }
  const passwordState = guest(['/usr/bin/passwd', '-S', user], true);
  const passwordIsSet = /(?:^|\s)P(?:\s|$)/.test(passwordState.stdout ?? '');
  if (passwordState.status !== 0 || !passwordIsSet) {
    const passwd = guest(['/usr/bin/passwd', user]);
    if (passwd.status !== 0) return fail(distribution, user, 'set-user-password', passwd);
  }
  const sudo = guest(['/usr/sbin/usermod', '--append', '--groups', 'sudo', user]);
  if (sudo.status !== 0) return fail(distribution, user, 'grant-sudo-group', sudo);
  const original = guest(['/bin/sh', '-lc', 'if [ ! -e /etc/wsl.conf ]; then printf "__ELANOUS_WSL_CONF_MISSING__"; else cat /etc/wsl.conf; fi'], true);
  if (original.status !== 0) return fail(distribution, user, 'read-wsl-configuration', original);
  const existingConfig = original.stdout === '__ELANOUS_WSL_CONF_MISSING__' ? '' : original.stdout ?? '';
  const config = setWslConfiguration(existingConfig, user);
  const encoded = Buffer.from(config, 'utf8').toString('base64');
  const wrote = guest(['/bin/sh', '-lc', `printf '%s' '${encoded}' | /usr/bin/base64 --decode > /etc/wsl.conf`]);
  if (wrote.status !== 0) return fail(distribution, user, 'configure-systemd', wrote);
  const stopped = invoke('wsl.exe', ['--terminate', distribution]);
  if (stopped.status !== 0) return fail(distribution, user, 'restart-wsl-for-systemd', stopped);
  const ready = invoke('wsl.exe', ['--distribution', distribution, '--user', user, '--exec', '/usr/bin/systemctl', 'is-system-running'], true);
  const systemdState = (ready.stdout ?? '').trim();
  if (ready.status !== 0 && !['degraded', 'starting'].includes(systemdState)) return fail(distribution, user, 'verify-systemd', ready);
  return { kind: 'machine-wsl-setup-result', status: 'complete', distribution, user,
    detail: `WSL account and systemd are ready after ${attempted} commands; selected profile follows`, attempted, failures: [] };
}

export function applyMachineWslProfile(input: {
  readonly plan: MachineSetupPlan;
  readonly distribution: string;
  readonly user: string;
  readonly run?: MachineWslSetupDeps['run'];
}): MachineSetupApplyResult {
  const operations = input.plan.operations.filter(operation => !['wsl-install', 'wsl-reboot-checkpoint', 'wsl-systemd'].includes(operation.id));
  const plan = { ...input.plan, operations };
  const command = input.run ?? run;
  return applyMachineSetupPlan({
    plan,
    confirmed: true,
    root: false,
    run: (name, args) => {
      const result = command('wsl.exe', ['--distribution', input.distribution, '--user', input.user, '--exec', name, ...args]);
      return { status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
    },
  });
}
