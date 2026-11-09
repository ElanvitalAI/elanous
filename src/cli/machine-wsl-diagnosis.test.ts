import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  diagnoseMachineWslState,
  parseMachineWslDockerBinaryOwnership,
  parseMachineWslDistributionList,
  registerMachineWslDiagnosisCommand,
  runMachineWslDiagnosis,
  type MachineWslDiagnosisFacts,
} from './machine-wsl-diagnosis.js';

const baseFacts = (overrides: Partial<MachineWslDiagnosisFacts> = {}): MachineWslDiagnosisFacts => ({
  distributions: [{ name: 'Ubuntu', state: 'Running', version: 2, isDefault: true }],
  requestedDistribution: 'Ubuntu',
  requestedUser: 'elanous',
  systemdEnabled: true,
  dockerCommandPresent: false,
  dockerEngineReady: false,
  dockerCePackagePresent: false,
  dockerBinaryOwnedByCe: false,
  elnInstalled: false,
  elnOnPath: false,
  bunTmpdirSameFilesystem: true,
  resumeTaskPresent: false,
  ...overrides,
});

test('simulates WSL present with no Linux distribution and returns the automatic-install action', () => {
  const finding = diagnoseMachineWslState(baseFacts({ distributions: [] }));
  expect(finding.map(item => item.id)).toEqual(['wsl-no-distribution']);
  expect(finding[0]?.detectCommand).toBe('wsl.exe --list --verbose');
  expect(finding[0]?.nextAction).toContain('automatic resume');
});

test('simulates an installed distribution with systemd disabled and recommends the existing resume flow', () => {
  const finding = diagnoseMachineWslState(baseFacts({ systemdEnabled: false }));
  expect(finding.map(item => item.id)).toEqual(['systemd-disabled']);
  expect(finding[0]?.nextAction).toContain('--resume --yes');
});

test('simulates docker-desktop as default and keeps it separate from the selected product distro', () => {
  const finding = diagnoseMachineWslState(baseFacts({
    distributions: [
      { name: 'docker-desktop', state: 'Stopped', version: 2, isDefault: true },
      { name: 'Ubuntu', state: 'Running', version: 2, isDefault: false },
    ],
  }));
  expect(finding.map(item => item.id)).toContain('docker-desktop-is-default');
  expect(finding.find(item => item.id === 'docker-desktop-is-default')?.nextAction).toContain('--distribution Ubuntu');
});

test('simulates Docker Desktop coexistence and reuses only a working selected-distro API', () => {
  const finding = diagnoseMachineWslState(baseFacts({
    distributions: [
      { name: 'docker-desktop', state: 'Running', version: 2, isDefault: false },
      { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
    ],
    dockerCommandPresent: true,
    dockerEngineReady: true,
  }));
  expect(finding.map(item => item.id)).toEqual(['docker-desktop-coexists']);
  expect(finding[0]?.nextAction).toContain('skip Docker CE');
});

test('simulates a partially installed Docker CE engine without suggesting that a foreign shim be replaced', () => {
  const finding = diagnoseMachineWslState(baseFacts({ dockerCommandPresent: true, dockerCePackagePresent: true, dockerBinaryOwnedByCe: true }));
  expect(finding.map(item => item.id)).toEqual(['engine-partial-install']);
  expect(finding[0]?.nextAction).toContain('apt-get install --yes docker-ce');
});

test('does not recommend Docker CE install when packages exist but the docker binary is foreign', () => {
  const finding = diagnoseMachineWslState(baseFacts({ dockerCommandPresent: true, dockerCePackagePresent: true, dockerBinaryOwnedByCe: false }));
  expect(finding[0]?.nextAction).not.toContain('apt-get install');
  expect(finding[0]?.nextAction).toContain('inspect its package owner');
});

test('parses dpkg-query ownership output in package-colon-path order', () => {
  expect(parseMachineWslDockerBinaryOwnership('docker-ce-cli: /usr/bin/docker')).toBe(true);
  expect(parseMachineWslDockerBinaryOwnership('docker.io: /usr/bin/docker')).toBe(false);
});

test('simulates installed eln missing from the noninteractive shell PATH', () => {
  const finding = diagnoseMachineWslState(baseFacts({ elnInstalled: true, elnOnPath: false }));
  expect(finding.map(item => item.id)).toEqual(['eln-path-not-reflected']);
  expect(finding[0]?.detectCommand).toContain('command -v eln');
  expect(finding[0]?.nextAction).toContain('new WSL login shell');
});

test('simulates TMPDIR and Bun cache on different filesystems and uses the doctor remedy', () => {
  const finding = diagnoseMachineWslState(baseFacts({ bunTmpdirSameFilesystem: false }));
  expect(finding.map(item => item.id)).toEqual(['bun-tmpdir-exdev']);
  expect(finding[0]?.detectCommand).toContain('bun-tmpdir');
  expect(finding[0]?.nextAction).toContain('reinstall');
});

test('simulates a scheduled reboot resume and does not ask the user to rerun setup', () => {
  const finding = diagnoseMachineWslState(baseFacts({ resumeTaskPresent: true }));
  expect(finding.map(item => item.id)).toEqual(['reboot-resume-pending']);
  expect(finding[0]?.detectCommand).toContain('schtasks.exe /Query');
  expect(finding[0]?.nextAction).toContain('reboot once');
});

test('decodes UTF-16LE WSL output and runs the Windows-hosted diagnostic read-only', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const report = runMachineWslDiagnosis({ distribution: 'Ubuntu', user: 'elanous', deps: {
    platform: 'win32',
    run: (command, args) => {
      calls.push({ command, args });
      if (command === 'wsl.exe' && args[0] === '--list') return { status: 0, stdout: Buffer.from('NAME STATE VERSION\n* docker-desktop Running 2\n  Ubuntu Running 2\n', 'utf16le') };
      if (command === 'schtasks.exe') return { status: 1, stdout: 'ERROR: cannot find task' };
      if (command === 'wsl.exe') return { status: 0, stdout: Buffer.from([
        'systemd=1', 'eln_path=1', 'eln_installed=1', 'docker_command=1', 'docker_api=1',
        'docker_ce_package=0', 'docker_owner=docker.io: /usr/bin/docker', 'bun_tmpdir_same=1', '',
      ].join('\n')) };
      return { status: 1 };
    },
  } });

  const rows = parseMachineWslDistributionList('NAME STATE VERSION\n* docker-desktop Running 2\n Ubuntu Stopped 2\n My Linux Distro Running 2\n Ubuntu Wird ausgeführt 2');
  expect(rows).toHaveLength(4);
  expect(rows[3]).toMatchObject({ name: 'Ubuntu', state: 'Wird ausgeführt' });
  expect(report.findings.map(item => item.id)).toEqual(['docker-desktop-is-default', 'docker-desktop-coexists']);
  expect(report.status).toBe('no-known-friction');
  expect(calls.some(call => call.command === 'schtasks.exe')).toBe(true);
  expect(calls.some(call => call.command === 'wsl.exe' && call.args.includes('/bin/bash'))).toBe(true);
});

test('runs the real guest probe with stubbed commands and repairs a Docker CE-owned binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsl-diagnosis-probe-'));
  const stubs = join(root, 'bin');
  const home = join(root, 'home');
  const writeCommand = (name: string, script: string) => {
    const path = join(stubs, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    // Source: executable PATH stubs are required for the shell guest probe integration simulation.
    chmodSync(path, 0o755);
  };
  try {
    mkdirSync(stubs);
    mkdirSync(home);
    writeCommand('docker', 'exit 1');
    writeCommand('dpkg-query', 'if [ "$1" = "-S" ]; then printf "docker-ce-cli: /usr/bin/docker\\n"; exit 0; fi; exit 1');
    writeCommand('stat', 'if [ "$1" = "-c" ]; then case "$3" in /tmp) echo 11 ;; *) echo 22 ;; esac; exit 0; fi; exit 1');

    const report = runMachineWslDiagnosis({ distribution: 'Ubuntu', user: 'elanous', deps: {
      platform: 'win32',
      run: (command, args) => {
        if (command === 'wsl.exe' && args[0] === '--list') return { status: 0, stdout: 'NAME STATE VERSION\n Ubuntu Running 2\n' };
        if (command === 'schtasks.exe') return { status: 1, stderr: 'ERROR: cannot find task' };
        const probe = spawnSync('/bin/bash', ['-c', args.at(-1) ?? ''], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home, TMPDIR: '/tmp', PATH: `${stubs}:/usr/bin:/bin` },
        });
        return { status: probe.status, stdout: probe.stdout, stderr: probe.stderr };
      },
    } });

    const engine = report.findings.find(item => item.id === 'engine-partial-install');
    expect(engine?.nextAction).toContain('apt-get install --yes docker-ce');
    expect(report.unmeasured).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('machine diagnose CLI returns a structured read-only report', async () => {
  let output = '';
  let exitCode = 0;
  const program = new Command();
  registerMachineWslDiagnosisCommand(program.command('diagnose'), {
    platform: 'win32',
    run: (command, args) => command === 'wsl.exe' && args[0] === '--list'
      ? { status: 0, stdout: Buffer.from('NAME STATE VERSION\n* Ubuntu Running 2\n') }
      : command === 'schtasks.exe' ? { status: 1, stdout: 'ERROR: cannot find task' }
        : { status: 0, stdout: Buffer.from(['systemd=0', 'eln_path=1', 'eln_installed=1', 'docker_command=0', 'docker_api=0', 'docker_ce_package=0', 'docker_owner=', 'bun_tmpdir_same=unknown', ''].join('\n')) },
    out: { log: (value: string) => { output = value; } },
    setExitCode: (code: number) => { exitCode = code; },
  });
  await program.parseAsync(['node', 'test', 'diagnose', '--json']);
  expect(JSON.parse(output)).toMatchObject({
    kind: 'machine-wsl-diagnosis', status: 'partially-measured',
    findings: [expect.objectContaining({ id: 'systemd-disabled' })],
    unmeasured: ['TMPDIR/Bun-cache filesystem relationship'],
  });
  expect(exitCode).toBe(2);
});
