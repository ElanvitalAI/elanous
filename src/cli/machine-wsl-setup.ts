import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, win32 as pathWin32 } from 'node:path';
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
  readonly resumeTrigger?: MachineWslResumeTrigger;
  readonly detail: string;
  readonly attempted: number;
  readonly failures: readonly { readonly operation: string; readonly reason: string; readonly target?: string }[];
  readonly profileResult?: MachineSetupApplyResult;
}

export type MachineWslResumeTrigger = 'onstart' | 'onlogon';

export const WSL_RESUME_FAILURE_GUIDANCE = 'Sign in to Windows and run eln machine apply --resume to finish WSL setup.';

export interface MachineWslSetupDeps {
  readonly run?: (command: string, args: readonly string[], captureOutput?: boolean) => MachineWslCommandResult;
  readonly platform?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinIsTTY?: boolean;
  readonly executable?: string;
  readonly entry?: string;
  readonly scheduleResume?: (commandLine: string) => MachineWslCommandResult;
  readonly resumeTaskDefinitionPath?: string;
  readonly resumeTaskWrapperPath?: string;
  readonly writeResumeTaskDefinition?: (path: string, xml: string) => void;
  readonly writeResumeTaskWrapper?: (path: string, script: string) => void;
  readonly allowCloudVm?: boolean;
}

const RESUME_TASK_NAME = 'ElanousMachineSetupResume';

function resumeTriggerDetail(trigger: MachineWslResumeTrigger): string {
  if (trigger !== 'onlogon') throw new Error('WSL resume requires an ONLOGON trigger');
  return `After reboot, sign in to the installing Windows account to resume setup. If the task fails, ${WSL_RESUME_FAILURE_GUIDANCE} Complete Codex identity login on Windows.`;
}

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
  readonly resumeTrigger?: MachineWslResumeTrigger;
}): string {
  return [input.executable, ...buildMachineWslResumeArguments(input)]
    .map(quoteWindowsArgument).join(' ');
}

function buildMachineWslResumeArguments(input: {
  readonly entry: string;
  readonly capture: string;
  readonly profile: string;
  readonly distribution: string;
  readonly user: string;
  readonly resumeTrigger?: MachineWslResumeTrigger;
  readonly resumeTaskWrapperPath?: string;
}): string[] {
  const args = [currentMachineWslEntry(input.entry), 'machine', 'apply', '--from', input.capture, '--profile', input.profile,
    '--platform', 'wsl', '--distribution', input.distribution, '--wsl-user', input.user,
    '--resume-trigger', input.resumeTrigger ?? 'onlogon', '--resume', '--yes'];
  if (input.resumeTaskWrapperPath) args.push('--resume-task-wrapper', input.resumeTaskWrapperPath);
  return args;
}

/** Resume through install.ps1's stable current junction so an update before reboot is picked up. */
export function currentMachineWslEntry(entry: string): string {
  return entry.replace(/\\versions\\[^\\]+(?=\\node_modules\\elanous\\bin\\elanous\.mjs$)/i, '\\current');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isLocalSystemAccount(windowsUser: string, computerName?: string): boolean {
  const machineAccount = computerName?.trim();
  return /^(?:NT AUTHORITY\\)?SYSTEM$/i.test(windowsUser)
    || Boolean(machineAccount && windowsUser.toUpperCase() === `${machineAccount.toUpperCase()}$`);
}

// Source: Microsoft Task Scheduler XML schema version 1.2 supports a user-scoped LogonTrigger.
const MACHINE_WSL_TASK_XML_VERSION = '1.2';

export function buildMachineWslStartupTaskXml(input: {
  readonly executable: string;
  readonly arguments: string;
  readonly windowsUser: string;
  readonly computerName?: string;
  readonly trigger?: MachineWslResumeTrigger;
}): string {
  const windowsUser = input.windowsUser.trim();
  const trigger = input.trigger ?? 'onlogon';
  if (!windowsUser || /[\r\n\0]/.test(windowsUser)) throw new Error('Windows account name is required for startup resume');
  if (!input.executable || /[\r\n\0]/.test(input.executable)) throw new Error('startup resume executable is invalid');
  if (/\0/.test(input.arguments)) throw new Error('startup resume arguments are invalid');
  // WSL distributions belong to the installing Windows user. LocalSystem cannot resume them.
  const localSystem = isLocalSystemAccount(windowsUser, input.computerName);
  if (localSystem) throw new Error('WSL resume requires the installing Windows account, not LocalSystem');
  if (trigger !== 'onlogon') throw new Error('WSL resume requires an ONLOGON trigger');
  const triggerXml = `<LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(windowsUser)}</UserId></LogonTrigger>`;
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="${MACHINE_WSL_TASK_XML_VERSION}" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `<Triggers>${triggerXml}</Triggers>`,
    `<Principals><Principal id="Author"><UserId>${xmlEscape(windowsUser)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>`,
    '<Settings><Enabled>true</Enabled><StartWhenAvailable>true</StartWhenAvailable></Settings>',
    `<Actions Context="Author"><Exec><Command>${xmlEscape(input.executable)}</Command><Arguments>${xmlEscape(input.arguments)}</Arguments></Exec></Actions>`,
    '</Task>',
  ].join('');
}

export function buildMachineWslStartupTaskArgs(input: { readonly taskXmlPath: string; readonly windowsUser: string }): string[] {
  const windowsUser = input.windowsUser.trim();
  if (!windowsUser || /[\r\n\0]/.test(windowsUser)) throw new Error('Windows account name is required for startup resume');
  if (!input.taskXmlPath || /[\r\n\0]/.test(input.taskXmlPath)) throw new Error('startup resume task XML path is invalid');
  return ['/Create', '/TN', RESUME_TASK_NAME, '/XML', input.taskXmlPath, '/F'];
}

export function machineWslResumeTaskDefinitionPath(env: NodeJS.ProcessEnv, override?: string): string | undefined {
  if (override) return override;
  const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? pathWin32.join(env.USERPROFILE, 'AppData', 'Local') : undefined);
  if (!localAppData) return undefined;
  return pathWin32.join(localAppData, 'Elanous', 'machine-setup-resume.xml');
}

function machineWslResumeTaskWrapperPath(taskDefinitionPath: string): string {
  return taskDefinitionPath.replace(/\.xml$/i, `-${randomUUID()}.ps1`);
}

function machineWslResumeTaskAction(taskDefinitionPath: string, env: NodeJS.ProcessEnv): { readonly executable: string; readonly arguments: string; readonly wrapperPath: string } {
  const wrapperPath = machineWslResumeTaskWrapperPath(taskDefinitionPath);
  const executable = pathWin32.join(env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const arguments_ = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath]
    .map(quoteWindowsArgument).join(' ');
  return { executable, arguments: arguments_, wrapperPath };
}

function buildMachineWslResumeTaskWrapper(input: {
  readonly executable: string;
  readonly entry: string;
  readonly capture: string;
  readonly profile: string;
  readonly distribution: string;
  readonly user: string;
  readonly resumeTrigger?: MachineWslResumeTrigger;
}, wrapperPath: string): string {
  const payload = Buffer.from(JSON.stringify({ executable: input.executable,
    arguments: buildMachineWslResumeArguments({ ...input, resumeTaskWrapperPath: wrapperPath }) }), 'utf8').toString('base64');
  return [
    '$ErrorActionPreference = "Stop"',
    `$resume = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    '$resumeArgs = @($resume.arguments)',
    '& $resume.executable @resumeArgs',
    '$resumeExit = $LASTEXITCODE',
    `if ($resumeExit -ne 0) { $guidance = '${WSL_RESUME_FAILURE_GUIDANCE}'; Write-Host $guidance; & eventcreate.exe /L APPLICATION /T ERROR /ID 100 /SO ElanousMachineSetupResume /D $guidance 2>$null | Out-Null; Add-Content -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'machine-setup-resume.log') -Value $guidance -ErrorAction SilentlyContinue }`,
    'if ($resumeExit -eq 0 -and (Test-Path -LiteralPath $MyInvocation.MyCommand.Path)) { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force }',
    'exit $resumeExit',
    '',
  ].join('\r\n');
}

function writeResumeTaskDefinition(filePath: string, xml: string, writer = (target: string, contents: string) => {
  mkdirSync(dirname(filePath), { recursive: true });
  // Source: A blank Hyper-V Windows 11 guest rejects UTF-8 schtasks /XML input; UTF-16LE with BOM registers successfully.
  writeFileSync(filePath, Buffer.from(`\uFEFF${contents}`, 'utf16le'));
}): void {
  writer(filePath, xml);
}

function writeResumeTaskWrapper(filePath: string, script: string, writer = (target: string, contents: string) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}): void {
  writer(filePath, script);
}

function registerMachineWslResumeTask(input: {
  readonly executable: string;
  readonly entry: string;
  readonly capture: string;
  readonly profile: string;
  readonly distribution: string;
  readonly user: string;
  readonly resumeTrigger?: MachineWslResumeTrigger;
}, deps: MachineWslSetupDeps, windowsUser: string,
invoke: (name: string, args: readonly string[], captureOutput?: boolean) => MachineWslCommandResult,
markAttempt: () => void): {
  readonly result: MachineWslCommandResult;
  readonly taskDefinitionPath?: string;
  readonly wrapperPath?: string;
} {
  const commandLine = buildMachineWslResumeCommand(input);
  if (deps.scheduleResume) {
    markAttempt();
    return { result: deps.scheduleResume(commandLine) };
  }
  const env = deps.env ?? process.env;
  const taskDefinitionPath = machineWslResumeTaskDefinitionPath(env, deps.resumeTaskDefinitionPath);
  if (!taskDefinitionPath) return { result: { status: null, errorCode: 'LOCALAPPDATA_REQUIRED' } };
  const action = machineWslResumeTaskAction(taskDefinitionPath, env);
  const taskXml = buildMachineWslStartupTaskXml({ executable: action.executable, arguments: action.arguments,
    windowsUser, computerName: env.COMPUTERNAME, trigger: input.resumeTrigger });
  const wrapper = buildMachineWslResumeTaskWrapper(input, action.wrapperPath);
  try {
    writeResumeTaskWrapper(action.wrapperPath, wrapper, deps.writeResumeTaskWrapper);
    writeResumeTaskDefinition(taskDefinitionPath, taskXml, deps.writeResumeTaskDefinition);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    const cleanupError = removeResumeTaskArtifacts(taskDefinitionPath, action.wrapperPath);
    return { result: { status: null, errorCode: errorCode ?? 'RESUME_TASK_FILES_WRITE_FAILED',
      ...(cleanupError ? { stderr: `resume task file cleanup failed (${cleanupError})` } : {}) }, taskDefinitionPath,
      wrapperPath: action.wrapperPath };
  }
  return { result: invoke('schtasks.exe', buildMachineWslStartupTaskArgs({ taskXmlPath: taskDefinitionPath,
    windowsUser })), taskDefinitionPath, wrapperPath: action.wrapperPath };
}

function removeResumeTaskArtifacts(taskDefinitionPath: string | undefined, wrapperPath?: string): string | undefined {
  if (!taskDefinitionPath) return undefined;
  // A user can resume setup manually while the registered task still exists. In that path
  // the CLI has no wrapper argument, so recover the exact wrapper from the task XML before deleting it.
  const registeredWrapperPath = wrapperPath ?? readResumeTaskWrapperPath(taskDefinitionPath);
  wrapperPath = registeredWrapperPath;
  if (wrapperPath) {
    const taskStem = pathWin32.basename(taskDefinitionPath).replace(/\.xml$/i, '');
    const wrapperName = pathWin32.basename(wrapperPath);
    const sameDirectory = pathWin32.normalize(pathWin32.dirname(taskDefinitionPath)).toLowerCase()
      === pathWin32.normalize(pathWin32.dirname(wrapperPath)).toLowerCase();
    if (!sameDirectory || !wrapperName.startsWith(`${taskStem}-`) || !/^[0-9a-f-]+\.ps1$/i.test(wrapperName.slice(taskStem.length + 1))) {
      return 'INVALID_RESUME_TASK_WRAPPER_PATH';
    }
  }
  for (const path of [taskDefinitionPath, ...(wrapperPath ? [wrapperPath] : [])]) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code ?? 'RESUME_TASK_FILE_REMOVE_FAILED';
    }
  }
  return undefined;
}

function readResumeTaskWrapperPath(taskDefinitionPath: string): string | undefined {
  let xml: string;
  try {
    xml = readFileSync(taskDefinitionPath, 'utf16le').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
  const encodedArguments = /<Arguments>([\s\S]*?)<\/Arguments>/i.exec(xml)?.[1];
  if (!encodedArguments) return undefined;
  const arguments_ = encodedArguments.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const match = /(?:^|\s)-File\s+(?:"([^"]+)"|([^\s]+))/i.exec(arguments_);
  return match?.[1] ?? match?.[2];
}

function validDistribution(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function validWslUser(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
}

function registryString(result: MachineWslCommandResult): string | undefined {
  return /\bREG_SZ\s+([^\r\n]+)/i.exec(result.stdout ?? '')?.[1]?.trim();
}

function detectedCloudVm(systemInfo: string, manufacturer: string, product: string): 'gce' | 'aws-nitro' | 'azure-compatible' | undefined {
  const identity = `${manufacturer}\n${product}\n${systemInfo}`;
  if (/google compute engine|google/i.test(identity)) return 'gce';
  if (/amazon ec2|amazon|\bnitro\b/i.test(identity)) return 'aws-nitro';
  // Azure and Hyper-V guests share this SMBIOS signature; describe the ambiguity rather than claiming certainty.
  const systemInfoManufacturer = /^\s*System Manufacturer\s*:\s*([^\r\n]+)/im.exec(systemInfo)?.[1] ?? '';
  const systemInfoModel = /^\s*System Model\s*:\s*([^\r\n]+)/im.exec(systemInfo)?.[1] ?? '';
  if ((/microsoft corporation/i.test(manufacturer) && /virtual machine/i.test(product))
    || (/microsoft corporation/i.test(systemInfoManufacturer) && /virtual machine/i.test(systemInfoModel))
    || (/microsoft corporation/i.test(systemInfo) && /virtual machine/i.test(systemInfo))) return 'azure-compatible';
  return undefined;
}

function cloudVmWarning(provider: 'gce' | 'aws-nitro' | 'azure-compatible'): string {
  if (provider === 'gce') return 'Google Cloud Windows VM detected: enabling WSL2 may make this VM fail to boot. Nested virtualization is not established by this probe.';
  if (provider === 'aws-nitro') return 'AWS/EC2 Nitro VM detected: nested virtualization support depends on the instance family and configuration; verify support before enabling WSL2.';
  return 'Microsoft virtual-machine signature detected (Azure or Hyper-V): Azure nested virtualization varies by VM size (for example, Dv5/Ev5 families); verify this VM size supports it before enabling WSL2.';
}

function reportsNoInstalledDistributions(result: MachineWslCommandResult): boolean {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replaceAll('\0', '');
  if (/HCS_E_HYPERV_NOT_INSTALLED|CreateInstance\/HCS_/i.test(output)) return false;
  if (/\bno hay distribuciones instaladas\b|\bno distributions? (?:are )?installed\b|\bthere are no distributions installed\b/i.test(output)) return true;
  if (!/\bNAME\b.*\bSTATE\b.*\bVERSION\b/i.test(output)) return false;
  return !output.split(/\r?\n/).some(line => {
    const fields = line.trim().replace(/^\*\s*/, '').split(/\s+/);
    return fields.length >= 3 && /^[12]$/.test(fields.at(-1) ?? '');
  });
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

function failResumeRegistration(distribution: string, user: string, result: MachineWslCommandResult, attempted: number,
  taskDefinitionPath?: string, wrapperPath?: string): MachineWslSetupResult {
  const registrationFailure = fail(distribution, user, 'register-resume', result, attempted);
  const cleanupError = removeResumeTaskArtifacts(taskDefinitionPath, wrapperPath);
  if (!cleanupError) return registrationFailure;
  return { ...registrationFailure, failures: [...registrationFailure.failures, {
    operation: 'remove-resume-task-definition', target: taskDefinitionPath ?? 'LocalAppData task XML',
    reason: `file cleanup failed (${cleanupError})`,
  }] };
}

export function buildWslDockerPrerequisiteScript(): string {
  return [
    'set -eu',
    'if ! command -v curl >/dev/null 2>&1 || ! dpkg-query -W -f=\'${Status}\' ca-certificates 2>/dev/null | grep -q \'install ok installed\'; then',
    '  apt-get update',
    '  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates curl',
    'fi',
  ].join('\n');
}

export function buildWslDockerRepositoryScript(etcRoot = '/etc'): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(etcRoot)) throw new Error('WSL Docker configuration root is invalid');
  return [
    'set -eu',
    `. "${etcRoot}/os-release"`,
    'case "${ID:-}" in ubuntu|debian) docker_distro="$ID" ;; *) echo "Docker CE is supported only for Ubuntu or Debian WSL distributions" >&2; exit 64 ;; esac',
    'docker_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"',
    'test -n "$docker_codename"',
    `install -m 0755 -d "${etcRoot}/apt/keyrings"`,
    `curl -fsSL "https://download.docker.com/linux/$docker_distro/gpg" -o "${etcRoot}/apt/keyrings/docker.asc"`,
    `chmod a+r "${etcRoot}/apt/keyrings/docker.asc"`,
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=${etcRoot}/apt/keyrings/docker.asc] https://download.docker.com/linux/$docker_distro $docker_codename stable" > "${etcRoot}/apt/sources.list.d/docker.list"`,
  ].join(' && ');
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
  readonly resumeTrigger?: MachineWslResumeTrigger;
  readonly deps?: MachineWslSetupDeps;
}): MachineWslSetupResult {
  const { distribution, user } = input;
  if (!validDistribution(distribution)) throw new Error('WSL distribution name is invalid');
  if (!validWslUser(user)) throw new Error('WSL username must match [a-z_][a-z0-9_-]{0,31}');
  const deps = input.deps ?? {};
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('WSL bootstrap must run from Windows; run machine apply inside WSL to apply a profile');
  if (input.resumeTrigger === 'onstart') return fail(distribution, user, 'register-resume', { status: null }, 0,
    `WSL resume requires the installing Windows account at sign-in. ${WSL_RESUME_FAILURE_GUIDANCE}`);
  const command = deps.run ?? run;
  let attempted = 0;
  const invoke = (name: string, args: readonly string[], captureOutput = false) => {
    attempted += 1;
    return command(name, args, captureOutput);
  };
  if (!input.resume) {
    let preflightWarning: string | undefined;
    const system = invoke('systeminfo.exe', [], true);
    const manufacturerResult = invoke('reg.exe', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS', '/v', 'SystemManufacturer'], true);
    const productResult = invoke('reg.exe', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS', '/v', 'SystemProductName'], true);
    const manufacturer = registryString(manufacturerResult) ?? '';
    const product = registryString(productResult) ?? '';
    const systemHasIdentity = /system manufacturer\s*:/i.test(system.stdout ?? '') && /system model\s*:/i.test(system.stdout ?? '');
    const registryHasIdentity = manufacturer.length > 0 && product.length > 0;
    const inspected = registryHasIdentity || systemHasIdentity;
    if (!inspected) {
      preflightWarning = 'Could not identify the Windows host; explicit cloud-VM confirmation was supplied. Verify nested virtualization support and boot recovery before continuing.';
      if (deps.allowCloudVm !== true) return fail(distribution, user, 'cloud-vm-preflight', system, attempted,
        'could not identify the Windows host before enabling WSL2. No changes were made; inspect the cloud VM type and rerun with --allow-cloud-vm only after confirming virtualization and boot recovery support.');
    }
    const cloud = detectedCloudVm(system.stdout ?? '', manufacturer, product);
    if (cloud) {
      preflightWarning = cloudVmWarning(cloud);
      if (deps.allowCloudVm !== true) return fail(distribution, user, 'cloud-vm-confirmation-required', system, attempted,
        `${preflightWarning} No changes were made. Re-run with --allow-cloud-vm only if this VM is disposable or boot recovery is available.`);
    }
    const executable = deps.executable ?? process.execPath;
    const entry = deps.entry ?? process.argv[1];
    if (!entry) throw new Error('cannot register WSL resume because the Elanous entry path is unavailable');
    const windowsEnv = deps.env ?? process.env;
    const windowsUser = windowsEnv.USERNAME?.trim();
    if (!deps.scheduleResume && (!windowsUser || isLocalSystemAccount(windowsUser, windowsEnv.COMPUTERNAME)))
      return fail(distribution, user, 'register-resume', { status: null }, attempted,
        `Run setup from the installing Windows account; LocalSystem cannot access that user's WSL distribution. ${WSL_RESUME_FAILURE_GUIDANCE}`);
    const registration = registerMachineWslResumeTask({ executable, entry, capture: input.capture,
      profile: input.profile, distribution, user, resumeTrigger: 'onlogon' }, deps, windowsUser ?? '', invoke, () => { attempted += 1; });
    if (registration.result.status !== 0) {
      return failResumeRegistration(distribution, user, registration.result, attempted,
        registration.taskDefinitionPath, registration.wrapperPath);
    }
    const installed = invoke('wsl.exe', ['--install', '--distribution', distribution, '--no-launch'], true);
    if (installed.status !== 0) return fail(distribution, user, 'wsl-install', installed, attempted);
    const resumeTrigger = 'onlogon';
    return { kind: 'machine-wsl-setup-result', status: 'resume-pending', distribution, user, resumeTrigger,
      detail: `${preflightWarning ? `${preflightWarning} ` : ''}WSL install requested. ${resumeTriggerDetail(resumeTrigger)}`,
      attempted, failures: [] };
  }

  const rows = invoke('wsl.exe', ['--list', '--verbose'], true);
  const noDistributions = reportsNoInstalledDistributions(rows);
  if (rows.status !== 0 && !noDistributions) return fail(distribution, user, 'list-distributions', rows, attempted);
  const wslVersion = parseWslVersionList(rows.stdout ?? '', distribution);
  if (wslVersion === null || noDistributions) {
    const resumeTrigger: MachineWslResumeTrigger = 'onlogon';
    const executable = deps.executable ?? process.execPath;
    const entry = deps.entry ?? process.argv[1];
    if (!entry) throw new Error('cannot register WSL resume because the Elanous entry path is unavailable');
    const windowsEnv = deps.env ?? process.env;
    const windowsUser = windowsEnv.USERNAME?.trim();
    if (!deps.scheduleResume && (!windowsUser || isLocalSystemAccount(windowsUser, windowsEnv.COMPUTERNAME)))
      return fail(distribution, user, 'register-resume', { status: null }, attempted,
        `Run setup from the installing Windows account; LocalSystem cannot access that user's WSL distribution. ${WSL_RESUME_FAILURE_GUIDANCE}`);
    const registration = registerMachineWslResumeTask({ executable, entry, capture: input.capture,
      profile: input.profile, distribution, user, resumeTrigger }, deps, windowsUser ?? '', invoke, () => { attempted += 1; });
    if (registration.result.status !== 0) {
      return failResumeRegistration(distribution, user, registration.result, attempted,
        registration.taskDefinitionPath, registration.wrapperPath);
    }
    const installed = invoke('wsl.exe', ['--install', '--distribution', distribution, '--no-launch'], true);
    if (installed.status !== 0) return fail(distribution, user, 'wsl-install', installed, attempted);
    return { kind: 'machine-wsl-setup-result', status: 'resume-pending', distribution, user, resumeTrigger,
      detail: `WSL distribution ${distribution} was missing; installation and automatic resume after reboot were scheduled. ${resumeTriggerDetail(resumeTrigger)}`, attempted, failures: [] };
  }
  if (wslVersion !== 2) return fail(distribution, user, 'verify-wsl2', rows, attempted,
    `WSL 2 is required for systemd; ${distribution} is WSL ${wslVersion}. Enable virtualization and install/convert this distribution to WSL 2 before resuming`);

  const guest = (args: readonly string[], captureOutput = false) => invoke('wsl.exe', ['--distribution', distribution, '--user', 'root', '--exec', ...args], captureOutput);
  const account = guest(['/usr/bin/id', '-u', user], true);
  if (account.status !== 0) {
    if (!confirmsMissingWslUser(account, user)) return fail(distribution, user, 'start-distribution', account, attempted);
    const created = guest(['/usr/sbin/useradd', '--create-home', '--shell', '/bin/bash', user], true);
    if (created.status !== 0) return fail(distribution, user, 'create-user', created, attempted);
  }
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
  readonly resumeTaskDefinitionPath?: string;
  readonly resumeTaskWrapperPath?: string;
}): MachineSetupApplyResult {
  const command = input.run ?? run;
  const runGuest = (name: string, args: readonly string[]) => command('wsl.exe', [
    '--distribution', input.distribution, '--user', input.user, '--exec', name, ...args,
  ]);
  const wslOnly = ['wsl-install', 'wsl-reboot-checkpoint', 'wsl-systemd', 'wsl-eln-install', 'wsl-eln-version-check',
    'wsl-docker-engine', 'wsl-k3d-install'];
  const operations = input.plan.operations.filter(operation => !wslOnly.includes(operation.id));
  const aptOperations = operations.filter(operation => operation.manager === 'apt-get');
  const profilePlan = { ...input.plan, operations: operations.filter(operation => operation.manager !== 'apt-get') };
  const validation = applyMachineSetupPlan({ plan: profilePlan, confirmed: false, root: false });
  if (validation.failures.length) return validation;
  let dockerEngineReady = false;
  const hasDockerEngineStep = input.plan.operations.some(operation => operation.id === 'wsl-docker-engine');
  let attempted = 0;
  let succeeded = 0;
  const failures: MachineSetupApplyResult['failures'][number][] = [];
  const fail = (operation: string, target: string, result: { readonly status: number | null; readonly errorCode?: string }): MachineSetupApplyResult => {
    failures.push({ operation, target, reason: result.status === null && result.errorCode
      ? `command unavailable (${result.errorCode})` : `exit ${result.status ?? 'unknown'}` });
    return { ...validation, applied: false, attempted, succeeded, failures };
  };
  const runRoot = (name: string, args: readonly string[]) => command('wsl.exe', [
    '--distribution', input.distribution, '--user', 'root', '--exec', name, ...args,
  ]);
  const dockerProbe = hasDockerEngineStep
    ? runGuest('/bin/bash', ['-lc', 'if ! command -v docker >/dev/null 2>&1; then exit 44; elif docker info >/dev/null 2>&1; then exit 0; else exit 45; fi'])
    : undefined;
  if (dockerProbe?.status === 0) dockerEngineReady = true;
  else if (dockerProbe?.status === 45) {
    const context = runGuest('/bin/bash', ['-lc', `if [ -z "\${DOCKER_HOST:-}" ] && [ "$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" = 'unix:///var/run/docker.sock' ]; then printf '%s' docker-context-local-socket; fi`]);
    const serviceSocket = context.status === 0 && context.stdout?.trim() === 'docker-context-local-socket'
      ? runRoot('/bin/bash', ['-lc', `pid=$(/usr/bin/systemctl show docker --property MainPID --value); if /usr/bin/systemctl is-active --quiet docker && /usr/bin/getent group docker >/dev/null 2>&1 && /usr/bin/ss -xlpn 2>/dev/null | /usr/bin/grep -F '/run/docker.sock' | /usr/bin/grep -F "pid=$pid," >/dev/null && ! /usr/bin/id -nG "$1" | /usr/bin/tr ' ' '\n' | /usr/bin/grep -Fxq docker; then printf '%s' linux-docker-group-missing; fi`, 'bash', input.user])
      : undefined;
    if (serviceSocket?.status === 0 && serviceSocket.stdout?.trim() === 'linux-docker-group-missing') {
      attempted += 1;
      const repaired = runRoot('/usr/sbin/usermod', ['--append', '--groups', 'docker', input.user]);
      if (repaired.status !== 0) return fail('wsl-docker-group-repair', input.user, repaired);
      succeeded += 1;
      const restarted = command('wsl.exe', ['--terminate', input.distribution]);
      if (restarted.status !== 0) return fail('wsl-docker-group-restart', input.distribution, restarted);
      // Source: existing WSL Docker probe exit contract immediately above; success means reachable and 45 means unreachable.
      const refreshedProbe = runGuest('/bin/bash', ['-lc', 'if docker info >/dev/null 2>&1; then exit 0; else exit 45; fi']);
      if (refreshedProbe.status === 0) dockerEngineReady = true;
      else {
        failures.push({ operation: 'wsl-docker-engine-probe', target: 'docker',
          reason: 'Docker remains unreachable after repairing the Linux docker-group membership; inspect the WSL Docker service and retry.' });
        return { ...validation, applied: false, attempted: attempted + 1, succeeded, failures };
      }
    } else {
      failures.push({ operation: 'wsl-docker-engine-probe', target: 'docker',
        reason: 'an existing Docker command is present but its engine is unreachable; leaving the existing Docker Desktop integration untouched. Start it or repair its WSL integration, then retry.' });
      return { ...validation, applied: false, attempted: 1, succeeded, failures };
    }
  } else if (dockerProbe && dockerProbe.status !== 44) {
    attempted += 1;
    return fail('wsl-docker-engine-probe', 'docker', dockerProbe);
  }
  const aptPackages = aptOperations.filter(operation => operation.kind === 'install')
    .flatMap(operation => operation.packages ?? []);
  const installPackages = aptPackages.filter(name => !dockerEngineReady || !['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin'].includes(name))
    .filter(name => !hasDockerEngineStep || dockerEngineReady || name !== 'curl');
  if (installPackages.some(name => !/^[A-Za-z0-9@+._-]+$/.test(name))) throw new Error('WSL apt package name is invalid');
  const elnSteps = input.plan.operations.filter(operation => operation.id === 'wsl-eln-install' || operation.id === 'wsl-eln-version-check');
  if (elnSteps.length !== 2 || elnSteps[0]?.id !== 'wsl-eln-install' || elnSteps[1]?.id !== 'wsl-eln-version-check') {
    const missing = elnSteps[0]?.id === 'wsl-eln-install' ? 'wsl-eln-version-check' : 'wsl-eln-install';
    failures.push({ operation: missing, target: 'eln', reason: 'required WSL install and verification stages are missing or out of order' });
    return { ...validation, applied: false, attempted, succeeded, failures };
  }
  if (hasDockerEngineStep && !dockerEngineReady) {
    attempted += 1;
    const tools = runRoot('/bin/bash', ['-lc', buildWslDockerPrerequisiteScript()]);
    if (tools.status !== 0) return fail('wsl-docker-ce-prerequisites', 'ca-certificates, curl', tools);
    succeeded += 1;
    const configured = runRoot('/bin/bash', ['-lc', buildWslDockerRepositoryScript()]);
    if (configured.status !== 0) return fail('wsl-docker-ce-repository', 'download.docker.com', configured);
    succeeded += 1;
  }
  if (aptOperations.length) {
    const needsAptRefresh = aptOperations.some(operation => operation.id.endsWith('-apt-refresh')) || installPackages.some(name => ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin'].includes(name));
    if (!needsAptRefresh && !installPackages.length) {
      // A healthy Docker Desktop integration satisfies the engine without replacing its WSL shim.
    } else {
      attempted += 1;
      const aptScript = [
        'set -eu',
        'export DEBIAN_FRONTEND=noninteractive',
        ...(needsAptRefresh ? ['apt-get update'] : []),
        ...(installPackages.length ? [`apt-get install --yes --no-install-recommends ${installPackages.join(' ')}`] : []),
      ].join(' && ');
      const apt = runRoot('/bin/bash', ['-lc', aptScript]);
      if (apt.status !== 0) return fail('wsl-apt-batch', installPackages.join(', ') || 'apt metadata', apt);
      succeeded += 1;
    }
  }
  if (hasDockerEngineStep) {
    if (!dockerEngineReady) {
      attempted += 1;
      const enabled = runRoot('/usr/bin/systemctl', ['enable', '--now', 'docker']);
      if (enabled.status !== 0) return fail('wsl-docker-service', 'docker.service', enabled);
      succeeded += 1;
      attempted += 1;
      const membership = runRoot('/usr/sbin/usermod', ['--append', '--groups', 'docker', input.user]);
      if (membership.status !== 0) return fail('wsl-docker-group', input.user, membership);
      succeeded += 1;
    }
    attempted += 1;
    const ready = runGuest('docker', ['info']);
    if (ready.status !== 0) return fail('wsl-docker-engine-verify', 'docker info', ready);
    succeeded += 1;
  }
  if (input.plan.operations.some(operation => operation.id === 'wsl-k3d-install')) {
    attempted += 1;
    const current = runGuest('/bin/bash', ['-lc', 'if command -v k3d >/dev/null 2>&1; then k3d version; else exit 44; fi']);
    if (current.status === 44) {
      attempted += 1;
      const installed = runRoot('/bin/bash', ['-lc', 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash']);
      if (installed.status !== 0) return fail('wsl-k3d-install', 'k3d', installed);
      succeeded += 1;
      attempted += 1;
      const verify = runGuest('/bin/bash', ['-lc', 'k3d version']);
      if (verify.status !== 0) return fail('wsl-k3d-verify', 'k3d version', verify);
      succeeded += 1;
    } else if (current.status === 0) succeeded += 1;
    else return fail('wsl-k3d-probe', 'k3d version', current);
  }

  for (const operation of elnSteps) {
    const [name, ...args] = operation.command ?? [];
    if (!name || args.length === 0) {
      failures.push({ operation: operation.id, target: 'eln', reason: 'missing WSL install or verification command' });
      return { ...validation, applied: false, attempted, succeeded, failures };
    }
    attempted += 1;
    const result = runGuest(name, args);
    if (result.status !== 0) return fail(operation.id, 'eln', result);
    succeeded += 1;
  }

  const profileResult = applyMachineSetupPlan({
    plan: profilePlan,
    confirmed: true,
    root: false,
    run: (name, args) => {
      const result = runGuest(name, args);
      return { status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
    },
  });
  attempted += profileResult.attempted;
  succeeded += profileResult.succeeded;
  failures.push(...profileResult.failures);
  if (!failures.length) {
    const query = command('schtasks.exe', ['/Query', '/TN', RESUME_TASK_NAME], true);
    if (query.status === 0) {
      attempted += 1;
      const removed = command('schtasks.exe', ['/Delete', '/TN', RESUME_TASK_NAME, '/F'], true);
      if (removed.status === 0) {
        succeeded += 1;
        const cleanupError = removeResumeTaskArtifacts(input.resumeTaskDefinitionPath, input.resumeTaskWrapperPath);
        if (cleanupError) failures.push({ operation: 'remove-resume-task-definition', target: 'LocalAppData task XML', reason: `file cleanup failed (${cleanupError})` });
      }
      else failures.push({ operation: 'remove-startup-resume', target: RESUME_TASK_NAME,
        reason: removed.status === null && removed.errorCode ? `command unavailable (${removed.errorCode})` : `exit ${removed.status ?? 'unknown'}` });
    } else if (!/cannot find|cannot locate|not found/i.test(`${query.stdout ?? ''} ${query.stderr ?? ''}`)) {
      failures.push({ operation: 'query-startup-resume', target: RESUME_TASK_NAME,
        reason: query.status === null && query.errorCode ? `command unavailable (${query.errorCode})` : `exit ${query.status ?? 'unknown'}` });
    } else {
      const cleanupError = removeResumeTaskArtifacts(input.resumeTaskDefinitionPath, input.resumeTaskWrapperPath);
      if (cleanupError) failures.push({ operation: 'remove-resume-task-definition', target: 'LocalAppData task XML', reason: `file cleanup failed (${cleanupError})` });
    }
  }
  return { ...profileResult, applied: failures.length === 0, attempted, succeeded, failures };
}
