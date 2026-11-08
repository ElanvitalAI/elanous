import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { applyMachineSetupPlan, type MachineSetupApplyResult } from './machine-setup-apply.js';
import { buildMachineSetupPlan, type MachineSetupPlan } from './machine-setup-plan.js';

export interface MachineWslCommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
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
  readonly stdinIsTTY?: boolean;
  readonly executable?: string;
  readonly entry?: string;
  readonly scheduleResume?: (commandLine: string) => MachineWslCommandResult;
}

const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const RUN_ONCE_VALUE = 'ElanousMachineSetup';

function run(command: string, args: readonly string[], captureOutput = false): MachineWslCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8', timeout: 15 * 60_000, windowsHide: true,
    stdio: captureOutput ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
  });
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    return { status: null, ...(captureOutput ? { stdout: result.stdout ?? '', stderr: result.stderr ?? '' } : {}), ...(errorCode ? { errorCode } : {}) };
  }
  return { status: result.status, ...(captureOutput ? { stdout: result.stdout ?? '', stderr: result.stderr ?? '' } : {}) };
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

function fail(distribution: string, user: string, operation: string, result: MachineWslCommandResult, attempted: number,
  reasonOverride?: string): MachineWslSetupResult {
  const diagnostic = [result.stderr, result.stdout].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  const reason = reasonOverride ?? (diagnostic.includes('HCS_E_HYPERV_NOT_INSTALLED')
    ? `WSL2 virtualization unavailable: ${diagnostic}`
    : result.status === null && result.errorCode
      ? `command unavailable (${result.errorCode})${diagnostic ? `: ${diagnostic}` : ''}`
      : `exit ${result.status ?? 'unknown'}${diagnostic ? `: ${diagnostic}` : ''}`);
  return { kind: 'machine-wsl-setup-result', status: 'failed', distribution, user, detail: operation,
    attempted, failures: [{ operation, reason }] };
}

function confirmsMissingWslUser(result: MachineWslCommandResult, user: string): boolean {
  const escapedUser = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const diagnostic = new RegExp(`^\\s*id:\\s*['"]?${escapedUser}['"]?:\\s*(?:no such user|unknown user)\\b`, 'i');
  return [result.stderr, result.stdout].some(value => value?.split(/\r?\n/)
    .some(line => diagnostic.test(line.replace(/[‘’]/g, "'"))));
}

function parseWslVersionList(output: string, distribution: string): number | null {
  for (const row of output.replaceAll('\0', '').split(/\r?\n/)) {
    const line = row.trim().replace(/^\*\s*/, '');
    const fields = line.split(/\s+/);
    if (fields.length < 3 || !/^[12]$/.test(fields.at(-1) ?? '')) continue;
    const name = fields.slice(0, -2).join(' ');
    if (name.toLowerCase() === distribution.toLowerCase()) return Number(fields.at(-1));
  }
  return null;
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
    attempted += 1;
    const scheduled = (deps.scheduleResume ?? registerMachineWslRunOnce)(resumeCommand);
    if (scheduled.status !== 0) return fail(distribution, user, 'register-resume', scheduled, attempted);
    const installed = invoke('wsl.exe', ['--install', '--distribution', distribution, '--no-launch'], true);
    if (installed.status !== 0) return fail(distribution, user, 'wsl-install', installed, attempted);
    return { kind: 'machine-wsl-setup-result', status: 'resume-pending', distribution, user,
      detail: `WSL install requested; reboot, then sign in or run this resume command over SSH: ${resumeCommand}`,
      attempted, failures: [] };
  }

  const rows = invoke('wsl.exe', ['--list', '--verbose'], true);
  if (rows.status !== 0) return fail(distribution, user, 'list-distributions', rows, attempted);
  const wslVersion = parseWslVersionList(rows.stdout ?? '', distribution);
  if (wslVersion === null) return fail(distribution, user, 'verify-wsl2', rows, attempted,
    `WSL distribution ${distribution} is absent or its version is unknown; automatic reinstall is stopped to avoid a resume loop`);
  if (wslVersion !== 2) return fail(distribution, user, 'verify-wsl2', rows, attempted,
    `WSL 2 is required for systemd; ${distribution} is WSL ${wslVersion}. Enable virtualization and install/convert this distribution to WSL 2 before resuming`);

  const guest = (args: readonly string[], captureOutput = false) => invoke('wsl.exe', ['--distribution', distribution, '--user', 'root', '--exec', ...args], captureOutput);
  const account = guest(['/usr/bin/id', '-u', user], true);
  if (account.status !== 0) {
    if (!confirmsMissingWslUser(account, user)) return fail(distribution, user, 'start-distribution', account, attempted);
    const created = guest(['/usr/sbin/useradd', '--create-home', '--shell', '/bin/bash', user], true);
    if (created.status !== 0) return fail(distribution, user, 'create-user', created, attempted);
  }
  const passwordState = guest(['/usr/bin/passwd', '-S', user], true);
  const passwordIsSet = /(?:^|\s)P(?:\s|$)/.test(passwordState.stdout ?? '');
  if (passwordState.status !== 0) return fail(distribution, user, 'check-user-password', passwordState, attempted);
  if (!passwordIsSet) {
    if (!(deps.stdinIsTTY ?? Boolean(process.stdin.isTTY))) {
      return fail(distribution, user, 'set-user-password', { status: null, errorCode: 'INTERACTIVE_TERMINAL_REQUIRED' }, attempted,
        'password is not set and this session has no interactive terminal; sign in locally and rerun resume to set it');
    }
    const passwd = guest(['/usr/bin/passwd', user]);
    if (passwd.status !== 0) return fail(distribution, user, 'set-user-password', passwd, attempted);
  }
  const sudo = guest(['/usr/sbin/usermod', '--append', '--groups', 'sudo', user]);
  if (sudo.status !== 0) return fail(distribution, user, 'grant-sudo-group', sudo, attempted);
  const original = guest(['/bin/sh', '-lc', 'if [ ! -e /etc/wsl.conf ]; then printf "__ELANOUS_WSL_CONF_MISSING__"; else cat /etc/wsl.conf; fi'], true);
  if (original.status !== 0) return fail(distribution, user, 'read-wsl-configuration', original, attempted);
  const existingConfig = original.stdout === '__ELANOUS_WSL_CONF_MISSING__' ? '' : original.stdout ?? '';
  const config = setWslConfiguration(existingConfig, user);
  const encoded = Buffer.from(config, 'utf8').toString('base64');
  const wrote = guest(['/bin/sh', '-lc', `printf '%s' '${encoded}' | /usr/bin/base64 --decode > /etc/wsl.conf`]);
  if (wrote.status !== 0) return fail(distribution, user, 'configure-systemd', wrote, attempted);
  const stopped = invoke('wsl.exe', ['--terminate', distribution]);
  if (stopped.status !== 0) return fail(distribution, user, 'restart-wsl-for-systemd', stopped, attempted);
  const ready = invoke('wsl.exe', ['--distribution', distribution, '--user', user, '--exec', '/usr/bin/systemctl', 'is-system-running'], true);
  const systemdState = (ready.stdout ?? '').trim();
  if (ready.status !== 0 && !['degraded', 'starting'].includes(systemdState)) return fail(distribution, user, 'verify-systemd', ready, attempted);
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
