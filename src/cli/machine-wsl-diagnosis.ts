import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';

export interface MachineWslDistribution {
  readonly name: string;
  readonly state: string;
  readonly version: 1 | 2;
  readonly isDefault: boolean;
}

export type MachineWslDiagnosisId =
  | 'wsl-no-distribution'
  | 'systemd-disabled'
  | 'docker-desktop-is-default'
  | 'docker-desktop-coexists'
  | 'engine-partial-install'
  | 'eln-path-not-reflected'
  | 'bun-tmpdir-exdev'
  | 'reboot-resume-pending';

export interface MachineWslDiagnosis {
  readonly id: MachineWslDiagnosisId;
  readonly severity: 'action' | 'info' | 'pending';
  readonly detected: string;
  readonly detectCommand: string;
  readonly expectedResponse: string;
  readonly nextAction: string;
  readonly source: 'seat-state/MVP-C/FRICTION-AINUC-1109.md';
}

export interface MachineWslDiagnosisFacts {
  readonly distributions: readonly MachineWslDistribution[];
  readonly requestedDistribution: string;
  readonly requestedUser: string;
  readonly systemdEnabled?: boolean;
  readonly dockerCommandPresent?: boolean;
  readonly dockerEngineReady?: boolean;
  readonly dockerCePackagePresent?: boolean;
  readonly dockerBinaryOwnedByCe?: boolean;
  readonly elnInstalled?: boolean;
  readonly elnOnPath?: boolean;
  readonly bunTmpdirSameFilesystem?: boolean | null;
  readonly resumeTaskPresent?: boolean;
}

const source = 'seat-state/MVP-C/FRICTION-AINUC-1109.md' as const;

function normalizeDistributionName(name: string): string {
  return name.trim().toLocaleLowerCase('en-US');
}

export function parseMachineWslDistributionList(output: string): MachineWslDistribution[] {
  const rows: MachineWslDistribution[] = [];
  for (const rawLine of output.replaceAll('\0', '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^NAME\s+STATE\s+VERSION$/i.test(line)) continue;
    const isDefault = /^\*/.test(line);
    const row = line.replace(/^\*\s*/, '');
    const fields = row.split(/\s+/);
    const version = fields.at(-1);
    if (!version || !/^[12]$/.test(version) || fields.length < 3) continue;
    const body = row.slice(0, row.lastIndexOf(version)).trimEnd();
    const stateMatch = body.match(/^(.*)\s+(Running|Stopped|Installing(?:,\s*please wait)?|Stopping|Terminating|Unknown|Wird ausgeführt|Wird beendet)$/i);
    const state = stateMatch?.[2] ?? fields.at(-2);
    const name = stateMatch?.[1] ?? fields.slice(0, -2).join(' ');
    if (!state || !name) continue;
    rows.push({ name, state, version: Number(version) as 1 | 2, isDefault });
  }
  return rows;
}

export function parseMachineWslDockerBinaryOwnership(output: string): boolean {
  return /^(?:docker-ce-cli|docker-ce):\s+\//m.test(output);
}

function diagnostic(id: MachineWslDiagnosisId, severity: MachineWslDiagnosis['severity'], detected: string,
  detectCommand: string, expectedResponse: string, nextAction: string): MachineWslDiagnosis {
  return { id, severity, detected, detectCommand, expectedResponse, nextAction, source };
}

/** Deterministic WSL state rules. The command and expected response come from the MVP-C friction record. */
export function diagnoseMachineWslState(facts: MachineWslDiagnosisFacts): MachineWslDiagnosis[] {
  const rows = facts.distributions;
  const target = rows.find(row => normalizeDistributionName(row.name) === normalizeDistributionName(facts.requestedDistribution));
  const desktop = rows.find(row => normalizeDistributionName(row.name) === 'docker-desktop');
  const findings: MachineWslDiagnosis[] = [];

  if (rows.length === 0 || !target) {
    findings.push(diagnostic('wsl-no-distribution', 'action', rows.length === 0
      ? 'WSL is available but no Linux distribution is registered.'
      : `The requested product distribution ${facts.requestedDistribution} is not registered.`,
      'wsl.exe --list --verbose',
      'Create the selected Linux distribution and retain the automatic resume checkpoint.',
      `Run eln machine apply --from capture.json --profile developer --platform wsl --distribution ${facts.requestedDistribution} --wsl-user ${facts.requestedUser} --yes (replace capture.json with the captured file path); it schedules automatic resume after reboot.`));
  }

  if (target && facts.systemdEnabled === false) {
    findings.push(diagnostic('systemd-disabled', 'action', `${target.name} does not have systemd running.`,
      `wsl.exe --distribution ${facts.requestedDistribution} --user ${facts.requestedUser} --exec /bin/sh -lc 'test -d /run/systemd/system'`,
      'Enable systemd in the selected distribution, restart that distribution, then verify systemctl.',
      `Run eln machine apply --from capture.json --profile developer --platform wsl --distribution ${facts.requestedDistribution} --wsl-user ${facts.requestedUser} --resume --yes (replace capture.json with the captured file path); it writes wsl.conf and restarts only that distribution.`));
  }

  if (rows.some(row => row.isDefault && normalizeDistributionName(row.name) === 'docker-desktop')) {
    findings.push(diagnostic('docker-desktop-is-default', 'info', 'The default WSL distribution is Docker Desktop managed state.',
      'wsl.exe --list --verbose',
      'Keep docker-desktop separate from the product Linux distribution.',
      `Pass --distribution ${facts.requestedDistribution} explicitly; do not change or repair docker-desktop as the product distro.`));
  }

  if (desktop && target) {
    const healthy = facts.dockerEngineReady === true;
    findings.push(diagnostic('docker-desktop-coexists', healthy ? 'info' : 'action', `docker-desktop exists${healthy ? ' and the selected distribution has a working Docker API' : ''}.`,
      `wsl.exe --list --verbose; wsl.exe --distribution ${facts.requestedDistribution} --user ${facts.requestedUser} --exec docker info`,
      'Leave the Docker Desktop managed distribution untouched; a working Docker API in the selected distribution is reusable.',
      healthy
        ? 'Reuse the working Docker API and skip Docker CE installation in the selected distribution.'
        : facts.dockerEngineReady === false
          ? 'Keep using the selected product distribution. If its Docker CLI is a Desktop shim, repair WSL integration; install Docker CE only when no Docker command exists.'
          : 'Run docker info in the selected product distribution to verify integration before choosing a repair; leave docker-desktop untouched.'));
  }

  if (target && facts.dockerEngineReady === false && (facts.dockerCommandPresent === true || facts.dockerCePackagePresent === true)) {
    const ownedByDockerCe = facts.dockerBinaryOwnedByCe === true;
    findings.push(diagnostic('engine-partial-install', 'action', 'Docker components exist in the selected distribution, but docker info cannot reach an engine.',
      `wsl.exe --distribution ${facts.requestedDistribution} --user ${facts.requestedUser} --exec /bin/bash -lc 'command -v docker; docker info; dpkg-query -W docker-ce docker-ce-cli containerd.io docker-buildx-plugin'`,
      'Distinguish Docker CE owned packages from a Docker Desktop integration shim before repair; never overwrite a foreign shim.',
      ownedByDockerCe
        ? `Run wsl.exe --distribution ${facts.requestedDistribution} --user root --exec /bin/bash -lc "apt-get update && apt-get install --yes docker-ce docker-ce-cli containerd.io docker-buildx-plugin && systemctl enable --now docker && usermod --append --groups docker ${facts.requestedUser}"; then open a new WSL shell and verify docker info.`
        : 'If this is a Docker Desktop shim, start Docker Desktop and enable WSL integration for the selected distribution; if it is not, inspect its package owner before installing Docker CE.'));
  }

  if (target && facts.elnInstalled === true && facts.elnOnPath === false) {
    findings.push(diagnostic('eln-path-not-reflected', 'action', 'Elanous is installed in the selected distribution, but a login shell cannot resolve eln from PATH.',
      `wsl.exe --distribution ${facts.requestedDistribution} --user ${facts.requestedUser} --exec /bin/bash -lc 'command -v eln; eln doctor --json'`,
      'Separate a missing install from a PATH block that is below the non-interactive .bashrc early return; a new shell must resolve eln.',
      'Move the existing Elanous PATH block above the non-interactive early return in .bashrc, open a new WSL login shell, then verify command -v eln and eln doctor --json.'));
  }

  if (target && facts.bunTmpdirSameFilesystem === false) {
    findings.push(diagnostic('bun-tmpdir-exdev', 'action', 'TMPDIR and the Bun install cache are on different filesystems; EXDEV can omit optional dependencies.',
      `wsl.exe --distribution ${facts.requestedDistribution} --user ${facts.requestedUser} --exec eln doctor --json (check bun-tmpdir)`,
      'Set TMPDIR on the same filesystem as the Bun install cache, then rerun the install and doctor check.',
      'Run eln doctor --fix --yes; reinstall the affected package and verify bun-tmpdir reports the same filesystem.'));
  }

  if (facts.resumeTaskPresent === true) {
    findings.push(diagnostic('reboot-resume-pending', 'pending', 'The unattended machine setup resume task is still registered.',
      'schtasks.exe /Query /TN ElanousMachineSetupResume',
      'A registered resume task means setup is waiting for its Windows startup or sign-in trigger.',
      'If WSL installation requested a reboot, reboot once or sign in as configured; let the registered task resume setup.'));
  }

  return findings;
}

export interface MachineWslDiagnosisCommandResult {
  readonly status: number | null;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
  readonly errorCode?: string;
}

export interface MachineWslDiagnosisDeps {
  readonly platform?: string;
  readonly run?: (command: string, args: readonly string[]) => MachineWslDiagnosisCommandResult;
  readonly out?: { readonly log: (value: string) => void };
  readonly err?: { readonly error: (value: string) => void };
  readonly setExitCode?: (code: number) => void;
}

export interface MachineWslDiagnosisReport {
  readonly kind: 'machine-wsl-diagnosis';
  readonly distribution: string;
  readonly status: 'action-needed' | 'no-known-friction' | 'partially-measured';
  readonly findings: readonly MachineWslDiagnosis[];
  readonly unmeasured: readonly string[];
}

function decodeWindowsOutput(value: string | Buffer | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value.replaceAll('\0', '').replace(/^\uFEFF/, '');
  if (value.length >= 2) {
    const evenNulls = value.filter((byte, index) => index % 2 === 0 && byte === 0).length;
    const oddNulls = value.filter((byte, index) => index % 2 === 1 && byte === 0).length;
    if (value[0] === 0xff && value[1] === 0xfe) return value.subarray(2).toString('utf16le').replaceAll('\0', '');
    if (oddNulls > value.length / 8 && evenNulls < oddNulls) return value.toString('utf16le').replaceAll('\0', '');
  }
  return value.toString('utf8').replace(/^\uFEFF/, '');
}

function guestProbeScript(): string {
  return [
    'set -u',
    'systemd=0; [ -d /run/systemd/system ] && systemd=1',
    'eln_path=0; command -v eln >/dev/null 2>&1 && eln_path=1',
    'install_prefix="${ELANOUS_INSTALL_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/elanous}"',
    'eln_installed=0; [ -x "$install_prefix/bin/eln" ] && eln_installed=1',
    'docker_command=0; docker_api=0; docker_ce_package=0; docker_owner=',
    'docker_path=$(command -v docker 2>/dev/null || true)',
    '[ -n "$docker_path" ] && docker_command=1',
    'if [ "$docker_command" -eq 1 ] && docker info >/dev/null 2>&1; then docker_api=1; fi',
    "if command -v dpkg-query >/dev/null 2>&1; then for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin; do dpkg-query -W -f='${db:Status-Abbrev}' \"$package\" 2>/dev/null | grep -q '^ii' && docker_ce_package=1; done; fi",
    'if [ -n "$docker_path" ] && command -v dpkg-query >/dev/null 2>&1; then docker_owner=$(dpkg-query -S "$docker_path" 2>/dev/null || true); fi',
    'tmp_dir="${TMPDIR:-/tmp}"',
    'bun_cache="${BUN_INSTALL_CACHE_DIR:-${BUN_INSTALL:-$HOME/.bun}/install/cache}"',
    'tmp_device=$(stat -c %d "$tmp_dir" 2>/dev/null || true)',
    'cache_device=$(stat -c %d "$bun_cache" 2>/dev/null || true)',
    'bun_tmpdir_same=unknown; if [ -n "$tmp_device" ] && [ -n "$cache_device" ]; then bun_tmpdir_same=0; [ "$tmp_device" = "$cache_device" ] && bun_tmpdir_same=1; fi',
    'printf "systemd=%s\\n" "$systemd"',
    'printf "eln_path=%s\\n" "$eln_path"',
    'printf "eln_installed=%s\\n" "$eln_installed"',
    'printf "docker_command=%s\\n" "$docker_command"',
    'printf "docker_api=%s\\n" "$docker_api"',
    'printf "docker_ce_package=%s\\n" "$docker_ce_package"',
    'printf "docker_owner=%s\\n" "$docker_owner"',
    'printf "bun_tmpdir_same=%s\\n" "$bun_tmpdir_same"',
  ].join('\n');
}

function parseGuestFacts(output: string): Pick<MachineWslDiagnosisFacts,
  'systemdEnabled' | 'dockerCommandPresent' | 'dockerEngineReady' | 'dockerCePackagePresent' | 'dockerBinaryOwnedByCe' | 'elnInstalled' | 'elnOnPath' | 'bunTmpdirSameFilesystem'> {
  const values = new Map(output.split(/\r?\n/).flatMap(line => {
    const index = line.indexOf('=');
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)] as const] : [];
  }));
  const boolean = (key: string): boolean | undefined => values.get(key) === '1' ? true : values.get(key) === '0' ? false : undefined;
  const tmp = values.get('bun_tmpdir_same');
  return {
    ...(boolean('systemd') !== undefined ? { systemdEnabled: boolean('systemd') } : {}),
    ...(boolean('docker_command') !== undefined ? { dockerCommandPresent: boolean('docker_command') } : {}),
    ...(boolean('docker_api') !== undefined ? { dockerEngineReady: boolean('docker_api') } : {}),
    ...(boolean('docker_ce_package') !== undefined ? { dockerCePackagePresent: boolean('docker_ce_package') } : {}),
    ...(values.has('docker_owner') ? { dockerBinaryOwnedByCe: parseMachineWslDockerBinaryOwnership(values.get('docker_owner') ?? '') } : {}),
    ...(boolean('eln_installed') !== undefined ? { elnInstalled: boolean('eln_installed') } : {}),
    ...(boolean('eln_path') !== undefined ? { elnOnPath: boolean('eln_path') } : {}),
    ...(tmp === '1' ? { bunTmpdirSameFilesystem: true } : tmp === '0' ? { bunTmpdirSameFilesystem: false } : tmp === 'unknown' ? { bunTmpdirSameFilesystem: null } : {}),
  };
}

function reportsNoDistributions(output: string): boolean {
  return /no distributions? (?:are )?installed|no installed distributions|there are no distributions installed|no hay distribuciones instaladas|설치된 배포판이 없습니다/i.test(output);
}

function defaultRun(command: string, args: readonly string[]): MachineWslDiagnosisCommandResult {
  // Source: src/cli/machine-wsl-setup.ts run() — bound short setup probes so a stuck WSL launch returns a measurable failure.
  const result = spawnSync(command, [...args], { encoding: null, windowsHide: true, timeout: 30_000 });
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    return { status: null, stderr: Buffer.from(String(result.error)), ...(errorCode ? { errorCode } : {}) };
  }
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}

export function runMachineWslDiagnosis(input: {
  readonly distribution: string;
  readonly user: string;
  readonly deps?: MachineWslDiagnosisDeps;
}): MachineWslDiagnosisReport {
  const platform = input.deps?.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('machine diagnose for WSL must run from Windows');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.distribution)) throw new Error('invalid WSL distribution name');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user)) throw new Error('invalid WSL user name');
  const run = input.deps?.run ?? defaultRun;
  const list = run('wsl.exe', ['--list', '--verbose']);
  const listOutput = `${decodeWindowsOutput(list.stdout)}\n${decodeWindowsOutput(list.stderr)}`;
  const distributions = parseMachineWslDistributionList(listOutput);
  const unmeasured: string[] = [];
  const hasListHeader = /^\s*NAME\s+STATE\s+VERSION\s*$/im.test(listOutput);
  const explicitEmpty = reportsNoDistributions(listOutput);
  if (list.status === 0 && distributions.length === 0 && !hasListHeader && !explicitEmpty) {
    throw new Error('wsl.exe --list --verbose returned no parseable distribution table');
  }
  if (list.status !== 0 && !explicitEmpty) {
    if (list.status === null) throw new Error(`wsl.exe --list --verbose unavailable${list.errorCode ? ` (${list.errorCode})` : ''}`);
    throw new Error(`wsl.exe --list --verbose failed with exit ${list.status}`);
  }
  const target = distributions.find(row => normalizeDistributionName(row.name) === normalizeDistributionName(input.distribution));
  const resume = run('schtasks.exe', ['/Query', '/TN', 'ElanousMachineSetupResume']);
  const resumeText = `${decodeWindowsOutput(resume.stdout)} ${decodeWindowsOutput(resume.stderr)}`;
  const resumeTaskPresent = resume.status === 0 ? true
    : resume.status !== null && /cannot find|cannot locate|not found|does not exist/i.test(resumeText) ? false : undefined;
  if (resumeTaskPresent === undefined) unmeasured.push('scheduled resume task');

  let guestFacts: ReturnType<typeof parseGuestFacts> = {};
  if (target) {
    const guest = run('wsl.exe', ['--distribution', input.distribution, '--user', input.user, '--exec', '/bin/bash', '-lc', guestProbeScript()]);
    if (guest.status === 0) guestFacts = parseGuestFacts(decodeWindowsOutput(guest.stdout));
    else unmeasured.push('selected distribution guest probes');
  }
  if (target && guestFacts.systemdEnabled === undefined) unmeasured.push('systemd state');
  if (target && guestFacts.dockerEngineReady === undefined) unmeasured.push('Docker CLI and engine state');
  if (target && guestFacts.elnOnPath === undefined) unmeasured.push('Elanous install and PATH state');
  if (target && (guestFacts.bunTmpdirSameFilesystem === undefined || guestFacts.bunTmpdirSameFilesystem === null)) {
    unmeasured.push('TMPDIR/Bun-cache filesystem relationship');
  }

  const findings = diagnoseMachineWslState({
    distributions,
    requestedDistribution: input.distribution,
    requestedUser: input.user,
    resumeTaskPresent,
    ...guestFacts,
  });
  return { kind: 'machine-wsl-diagnosis', distribution: input.distribution,
    status: unmeasured.length ? 'partially-measured' : findings.some(finding => finding.severity !== 'info') ? 'action-needed' : 'no-known-friction',
    findings, unmeasured };
}

export function formatMachineWslDiagnosis(report: MachineWslDiagnosisReport): string {
  if (!report.findings.length && !report.unmeasured.length) return `WSL ${report.distribution}: no known friction detected.`;
  const lines = [`WSL ${report.distribution}: ${report.status}`];
  for (const finding of report.findings) lines.push(
    `- ${finding.id} (${finding.severity}): ${finding.detected}`,
    `  Detect: ${finding.detectCommand}`,
    `  Expected: ${finding.expectedResponse}`,
    `  Next: ${finding.nextAction}`,
  );
  if (report.unmeasured.length) lines.push(`- Not measured: ${report.unmeasured.join(', ')}`);
  return lines.join('\n');
}

export function registerMachineWslDiagnosisCommand(command: Command, deps: MachineWslDiagnosisDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  command
    .description('Diagnose known WSL setup states without calling an LLM or changing the machine')
    .option('--distribution <name>', 'product Linux distribution to inspect', 'Ubuntu')
    .option('--wsl-user <name>', 'Linux account to inspect', 'elanous')
    .option('--json', 'structured output')
    .action((options: { distribution: string; wslUser: string; json?: boolean }) => {
      try {
        const report = runMachineWslDiagnosis({ distribution: options.distribution, user: options.wslUser, deps });
        out.log(options.json ? JSON.stringify(report, null, 2) : formatMachineWslDiagnosis(report));
        if (report.status === 'partially-measured') setExitCode(2);
      } catch (error) {
        err.error(error instanceof Error ? error.message : 'machine diagnose failed');
        setExitCode(1);
      }
    });
}
