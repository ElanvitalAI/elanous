import { describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { registerDoctorCommand } from '../cli/doctor-cli.js';
import {
  HOST_DOCTOR_CHECKS,
  detectHostDoctorArch,
  hostDoctorRunFromSpawn,
  detectHostDoctorPlatform,
  normalizeArch,
  parseWslKeepaliveObservation,
  formatHostDoctorLines,
  runHostDoctor,
  checkHostMembership,
  type HostDoctorExpected,
  type HostDoctorReport,
  type HostDoctorRemote,
} from './host-doctor.js';
import { loadMachineLedger, validateMachineLedger } from '../machines/machine-ledger.js';
import type { ResourceView } from '../control-plane/ledger.js';
import { debug } from '../debug/log.js';
import type { UserConfig } from '../user-config/types.js';

const PLATFORM_PROBES: Record<string, string> = {
  'uname -s': 'Linux',
  'cat /proc/version 2>/dev/null || true': 'Linux version 6.1.0 (gcc) #1 SMP',
  'uname -m': 'arm64',
};

/** probe 문자열 → stdout 매핑으로 주입 원격을 만든다. 매핑에 없는 probe 는 실패(status 1). */
function remoteFrom(map: Record<string, string>): HostDoctorRemote {
  return (_host: string, probe: string) => {
    const stdout = map[probe];
    return stdout === undefined ? { status: 1, stdout: '', stderr: 'command failed' } : { status: 0, stdout, stderr: '' };
  };
}

/** 점검 id → 그 점검의 probe 문자열(탐침 문면이 바뀌어도 시험 키가 같이 따라간다). */
function probeOf(id: string): string {
  const spec = HOST_DOCTOR_CHECKS.find((check) => check.id === id);
  if (!spec) throw new Error(`unknown check ${id}`);
  return spec.probe;
}


/** 세 묶음 전부 통과하는 원격 응답 — HQ 실측값과 함께 쓴다. */
const HEALTHY: Record<string, string> = {
  ...PLATFORM_PROBES,
  'cat /proc/version 2>/dev/null || true': 'Linux version 6.1.0 (gcc) #1 SMP',
  [probeOf('ssh.batch')]: 'ok',
  [probeOf('tailnet.online')]: 'online',
  'command -v bun; command -v codex': '/usr/local/bin/bun\n/usr/local/bin/codex',
  "docker info --format '{{.ServerVersion}}' 2>/dev/null": '27.0.1',
  [probeOf('k3d.cluster')]: 'present',
  [probeOf('registry.local')]: 'reachable:5050',
  'elanous --version 2>/dev/null || echo none': '0.2.25',
  "docker ps --format '{{.Image}}' 2>/dev/null | grep -m1 elanous || true": 'ghcr.io/elanous/elanous:0.2.25',
  "uname -m; docker version --format '{{.Server.Arch}}' 2>/dev/null": 'arm64\narm64',
  'command -v node || echo none': '/usr/bin/node',
};

const HQ: HostDoctorExpected = { installVersion: '0.2.25', imagePin: 'ghcr.io/elanous/elanous:0.2.25' };

const intent = validateMachineLedger({
  title: 'Fleet', policy: ['intent'], devices: [], rules: [], changes: [],
  machines: [{ id: 'node-c', name: 'node-c', specs: 'M4', locationStatus: 'active', role: 'worker', duties: 'tasks',
    fleet: { sshName: 'node-c', role: 'worker', platform: 'linux', podPool: 'pool-node-c:8', cap: 8 } }],
});
const liveMachine = (attrs: Record<string, unknown> = { role: 'worker' }): ResourceView => ({
  id: 'machine:node-c', kind: 'machine', machine: 'node-c', name: 'node-c', owner: 'node-c', attrs,
  observedAt: 1, ttlMs: 600_000, ageMs: 1, expired: false,
});
const parentHosts = [{ host: 'node-c', podPool: 'pool-node-c:8', approvalCapacity: 8 }];

describe('fleet membership: live registry is source, YAML is intent', async () => {
  test('repository node-c intent exposes operating parent-host 8/8 as drift', async () => {
    const ledger = loadMachineLedger(join(import.meta.dir, '../..'));
    const parentHosts = [{ host: 'node-c', podPool: 'k3d-elanous-pool:8', approvalCapacity: 8 }];
    const checks = checkHostMembership('node-c', 'darwin', { intent: ledger, machines: null, parentHosts });
    expect(checks.map(({ id, status }) => [id, status])).toEqual([
      ['registry.member', 'unmeasured'], ['parentHost.member', 'fail'],
    ]);
    expect(checks[1]?.expected).toContain('pool-node-c@node-c:6');
    const report = await runHostDoctor({ host: 'node-c', remote: remoteFrom({ ...HEALTHY, 'uname -s': 'Darwin' }),
      expected: HQ, membership: { intent: ledger, machines: null, parentHosts } });
    expect(formatHostDoctorLines(report)).toContainEqual(expect.stringContaining('✗ parentHost.member'));
  });

  test('cap zero means intentionally disabled and rejects a configured parent entry', async () => {
    const disabled = validateMachineLedger({ ...intent,
      machines: intent.machines.map((machine) => ({ ...machine, fleet: { ...machine.fleet!, cap: 0 } })) });
    expect(checkHostMembership('node-c', 'linux', { intent: disabled, machines: [], parentHosts: [] })[1]?.status).toBe('pass');
    expect(checkHostMembership('node-c', 'linux', { intent: disabled, machines: [], parentHosts })[1]?.status).toBe('fail');
  });
  test('live machine, matching role and configured parent pass and appear in doctor output', async () => {
    const membership = { intent, machines: [liveMachine()], parentHosts };
    const checks = checkHostMembership('node-c', 'linux', membership);
    expect(checks.map(({ id, status }) => [id, status])).toEqual([['registry.member', 'pass'], ['parentHost.member', 'pass']]);
    const report = await runHostDoctor({ host: 'node-c', remote: remoteFrom(HEALTHY), expected: HQ, membership });
    expect(report.ok).toBe(true);
    expect(formatHostDoctorLines(report)).toContainEqual(expect.stringContaining('✓ registry.member'));
    expect(report.checks).toHaveLength(12);
  });

  test('missing, expired and role-mismatched machine are fail, not an empty successful registry', async () => {
    for (const machines of [[], [{ ...liveMachine(), expired: true }], [liveMachine({ role: 'hq' })]]) {
      const [registry] = checkHostMembership('node-c', 'linux', { intent, machines, parentHosts });
      expect(registry?.status).toBe('fail');
    }
    expect(checkHostMembership('node-c', 'linux', { intent, machines: [liveMachine()], parentHosts: [] })[1]?.status).toBe('fail');
    expect(checkHostMembership('node-c', 'linux', { intent, machines: [liveMachine()], parentHosts: [{ ...parentHosts[0]!, podPool: 'wrong' }] })[1]?.status).toBe('fail');
  });

  test('Nexus machine identity uses machine field even when display name differs', async () => {
    const renamed = { ...liveMachine(), name: 'display-label' };
    expect(checkHostMembership('node-c', 'linux', { intent, machines: [renamed], parentHosts })[0]?.status).toBe('pass');
  });

  test('unreachable registry and absent role are unmeasured; parent mismatch remains fail', async () => {
    const checks = checkHostMembership('node-c', 'linux', { intent, machines: null, parentHosts: [] });
    expect(checks.map(({ status }) => status)).toEqual(['unmeasured', 'fail']);
    expect(checkHostMembership('node-c', 'linux', { intent, machines: [liveMachine({})], parentHosts })[0]?.status).toBe('unmeasured');
    expect(checkHostMembership('node-c', null, { intent, machines: [liveMachine()], parentHosts })[0]?.status).toBe('unmeasured');
    expect(checkHostMembership('node-c', 'linux', { intent: null, machines: [], parentHosts })[0]?.status).toBe('unmeasured');
    const errors = checkHostMembership('node-c', 'linux', {
      intent, machines: null, machinesError: 'control HTTP 500', parentHosts: null, parentHostsError: 'config unreadable',
    });
    expect(errors[0]?.observed).toContain('control HTTP 500');
    expect(errors[1]?.observed).toContain('config unreadable');
    const noCheckout = checkHostMembership('node-c', 'linux', {
      intent: null, intentError: 'ENOENT', machines: [], parentHosts,
    });
    expect(noCheckout[0]?.observed).toContain('repository checkout required');
    expect(noCheckout[0]?.observed).toContain('ENOENT');
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event) => { if (category === 'fleet.doctor') events.push(event); });
    try {
      const report = await runHostDoctor({ host: 'node-c', remote: remoteFrom(HEALTHY), expected: HQ,
        membership: { intent, machines: [liveMachine({})], parentHosts } });
      expect(formatHostDoctorLines(report)).toContain('⚠ registry.member unmeasured: machine attrs.role unavailable');
      expect(events).toContain('membership-unmeasured');
    } finally { log.mockRestore(); }
  });
});

describe('host doctor platform detection', async () => {
  test('darwin — uname -s Darwin', async () => {
    const remote = remoteFrom({ 'uname -s': 'Darwin', 'uname -m': 'arm64' });
    expect(await detectHostDoctorPlatform(remote, 'mbp')).toBe('darwin');
  });

  test('linux — /proc/version without microsoft', async () => {
    expect(await detectHostDoctorPlatform(remoteFrom(PLATFORM_PROBES), 'node-c')).toBe('linux');
  });

  test('wsl — /proc/version contains microsoft', async () => {
    const remote = remoteFrom({
      ...PLATFORM_PROBES,
      'cat /proc/version 2>/dev/null || true': 'Linux version 5.15.153.1-microsoft-standard-WSL2',
    });
    expect(await detectHostDoctorPlatform(remote, 'host-e-wsl')).toBe('wsl');
  });

  test('arch from uname -m', async () => {
    expect(await detectHostDoctorArch(remoteFrom({ 'uname -m': 'x86_64' }), 'h')).toBe('x86_64');
  });
});

describe('host doctor bundles', async () => {
  test('all three bundles pass with injected healthy remote and HQ expectations', async () => {
    const report = await runHostDoctor({ host: 'node-c', remote: remoteFrom(HEALTHY), expected: HQ, now: () => new Date('2026-10-11T12:00:00Z') });
    expect(report.platform).toBe('linux');
    expect(report.checks.map((check) => check.id).sort()).toEqual([
      'docker.engine', 'image.arch', 'image.pin', 'install.version', 'k3d.cluster', 'node.present',
      'path.noninteractive', 'registry.local', 'ssh.batch', 'tailnet.online',
    ].sort());
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(report.ok).toBe(true);
  });

  test('failing probes produce fail lines and ok=false', async () => {
    const map: Record<string, string> = { ...HEALTHY, 'command -v node || echo none': 'none' };
    delete map["docker info --format '{{.ServerVersion}}' 2>/dev/null"];
    const report = await runHostDoctor({ host: 'node-c', remote: remoteFrom(map), expected: HQ });
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get('docker.engine')?.status).toBe('fail');
    expect(byId.get('node.present')?.status).toBe('fail');
    expect(report.ok).toBe(false);
    const lines = formatHostDoctorLines(report);
    expect(lines.some((entry) => entry.startsWith('✗ docker.engine '))).toBe(true);
    expect(lines.some((entry) => entry.startsWith('✓ ssh.batch '))).toBe(true);
  });

  test('install.version and image.pin are unmeasured when HQ expectations are not supplied', async () => {
    const report = await runHostDoctor({ host: 'node-c', remote: remoteFrom(HEALTHY) });
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get('install.version')?.status).toBe('unmeasured');
    expect(byId.get('image.pin')?.status).toBe('unmeasured');
    expect(report.ok).toBe(false);
  });
});

describe('WSL keepalive logon registration probe', async () => {
  test('detects a registered enabled per-user logon task by exact known task name', () => {
    expect(parseWslKeepaliveObservation('task|ElangramWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity').status).toBe('pass');
    expect(parseWslKeepaliveObservation('task|ElanainucWslKeepalive|Running|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|1|C:\\Windows\\System32\\wsl.exe|-d host-e-wsl --exec /usr/bin/sleep infinity').status).toBe('pass');
    expect(parseWslKeepaliveObservation('task|ElangramWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|P1D|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElangramWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|<unknown>|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity').status).toBe('unmeasured');
  });

  test('unknown trigger identity is unmeasured and both execution limits are checked', () => {
    const base = 'task|ElangramWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|';
    const tail = '|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity';
    expect(parseWslKeepaliveObservation(base + '<unknown>' + tail).status).toBe('unmeasured');
    expect(parseWslKeepaliveObservation(base + '<not-set>' + tail).status).toBe('pass');
    expect(parseWslKeepaliveObservation(base + 'S-1-5-21-1000' + tail.replace('|PT0S|PT0S|1|', '|PT0S|P1D|1|')).status).toBe('fail');
    expect(parseWslKeepaliveObservation(base + 'S-1-5-21-1000' + tail.replace('|PT0S|PT0S|1|', '|PT0S|<not-set>|1|')).status).toBe('pass');
    expect(parseWslKeepaliveObservation(base + 'S-1-5-21-1000' + tail.replace('|PT0S|PT0S|1|', '|PT0S|<unknown>|1|')).status).toBe('unmeasured');
  });

  test('missing, disabled, or non-logon task fails and keeps the manual action visible', async () => {
    expect(parseWslKeepaliveObservation('missing').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElangramWslKeepalive|Disabled|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElanainucWslKeepalive|Ready|MSFT_TaskBootTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d host-e-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElangramWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|True|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElanainucWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|True|False|PT0S|PT0S|1|wsl.exe|-d host-e-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElanainucWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d elangram-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    expect(parseWslKeepaliveObservation('task|ElanainucWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|False|00:10:00|False|False|PT0S|PT0S|2|wsl.exe|-d host-e-wsl --exec /usr/bin/sleep infinity').status).toBe('fail');
    const map: Record<string, string> = { ...HEALTHY, 'uname -s': 'Linux', 'cat /proc/version 2>/dev/null || true': 'Linux version 6.1.0-microsoft-standard-WSL2' };
    map[probeOf('wsl.keepalive-logon-task')] = 'missing';
    const report = await runHostDoctor({ host: 'host-e-wsl', remote: remoteFrom(map), expected: HQ });
    const check = report.checks.find((entry) => entry.id === 'wsl.keepalive-logon-task');
    expect(report.platform).toBe('wsl');
    expect(check?.status).toBe('fail');
    expect(formatHostDoctorLines(report).find((entry) => entry.includes('wsl.keepalive-logon-task'))).toContain('수동 조치:');
    map[probeOf('wsl.keepalive-logon-task')] = 'task|ElanainucWslKeepalive|Ready|MSFT_TaskLogonTrigger|True|S-1-5-21-1000|S-1-5-21-1000|S-1-5-21-1000|InteractiveToken|True|00:10:00|False|False|PT0S|PT0S|1|wsl.exe|-d host-e-wsl --exec /usr/bin/sleep infinity';
    const idleLimited = await runHostDoctor({ host: 'host-e-wsl', remote: remoteFrom(map), expected: HQ });
    const idleCheck = idleLimited.checks.find((entry) => entry.id === 'wsl.keepalive-logon-task');
    expect(idleCheck?.status).toBe('fail');
    expect(idleCheck?.observed).toContain('idleDuration=00:10:00');
    expect(formatHostDoctorLines(idleLimited).find((entry) => entry.includes('wsl.keepalive-logon-task'))).toContain('작업과 로그온 트리거');
    const warning = formatHostDoctorLines(idleLimited).find((entry) => entry.includes('wsl.keepalive-logon-task')) ?? '';
    expect(warning).toContain('ElanainucWslKeepalive');
    expect(warning).toContain('wsl.exe -d host-e-wsl --exec /usr/bin/sleep infinity');
    expect(warning).toContain('InteractiveToken 로그온 트리거');
    expect(probeOf('wsl.keepalive-logon-task')).not.toContain('wsl.exe --shutdown');
    expect(probeOf('wsl.keepalive-logon-task')).not.toContain('DockerDesktop.exe');
  });

  test('missing WSL Windows interop is unmeasured, and non-WSL hosts do not run this probe', async () => {
    expect(parseWslKeepaliveObservation('no-windows-interop').status).toBe('unmeasured');
    let wslProbeCalls = 0;
    const remote: HostDoctorRemote = (host, probe) => {
      if (probe === probeOf('wsl.keepalive-logon-task')) wslProbeCalls += 1;
      return remoteFrom(HEALTHY)(host, probe);
    };
    const report = await runHostDoctor({ host: 'node-c', remote });
    expect(report.platform).toBe('linux');
    expect(report.checks.some((entry) => entry.id === 'wsl.keepalive-logon-task')).toBe(false);
    expect(report.checks.map((entry) => entry.id)).toEqual(HOST_DOCTOR_CHECKS.filter((spec) => spec.roles.includes('worker') && spec.id !== 'wsl.keepalive-logon-task').map((spec) => spec.id));
    expect(wslProbeCalls).toBe(0);
  });
});

describe('host doctor remote failure', async () => {
  test('remote that never runs yields unmeasured everywhere and ok=false', async () => {
    const dead: HostDoctorRemote = () => null;
    const report = await runHostDoctor({ host: 'down-host', remote: dead, now: () => new Date('2026-10-11T12:00:00Z') });
    expect(report.platform).toBeNull();
    expect(report.arch).toBeNull();
    expect(report.checks.every((check) => check.status === 'unmeasured')).toBe(true);
    expect(report.ok).toBe(false);
    expect(formatHostDoctorLines(report).every((line) => line.startsWith('→ '))).toBe(true);
  });
});

describe('host doctor setup-status shape', async () => {
  test('--json report carries setup-status {id, ok, missing[], fixHref} plus extension fields', async () => {
    const report = await runHostDoctor({ host: 'node-c', role: 'hq', remote: remoteFrom(HEALTHY), expected: HQ, now: () => new Date('2026-10-11T12:00:00Z') });
    expect(report.id).toBe('node-c');
    expect(report.missing).toEqual([]);
    expect(report.fixHref).toBeNull();
    expect('schema' in report).toBe(false);
    expect(report.platform).toBe('linux');
    expect(report.arch).toBe('arm64');
    expect(report.role).toBe('hq');
    expect(report.measuredAt).toBe('2026-10-11T12:00:00.000Z');
    expect(report.ok).toBe(true);
    for (const check of report.checks) {
      expect(['pass', 'fail', 'unmeasured']).toContain(check.status);
      expect(typeof check.observed).toBe('string');
      expect(typeof check.expected).toBe('string');
      expect(['auto', 'sudo', 'approval', 'human']).toContain(check.fixKind);
    }
  });

  test('wired as doctor host subcommand with injected remote', async () => {
    const outputs: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      out: { log: (line) => outputs.push(line) },
      setExitCode: () => {},
      hostDoctorRemote: remoteFrom(HEALTHY),
      hostDoctorExpected: HQ,
      hostDoctorMembership: async () => ({ intent, machines: [liveMachine()], parentHosts }),
    });
    await program.parseAsync(['node', 'elanous', 'doctor', 'host', 'node-c', '--json']);
    const parsed = JSON.parse(outputs.join('\n')) as HostDoctorReport;
    expect(parsed.id).toBe('node-c');
    expect(parsed.missing).toEqual([]);
    expect(parsed.fixHref).toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.length).toBe(12);
  });

  test('doctor host CLI includes injected Nexus and parent-host membership readings', async () => {
    const outputs: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      out: { log: (line) => outputs.push(line) }, setExitCode: () => {},
      hostDoctorRemote: remoteFrom(HEALTHY), hostDoctorExpected: HQ,
      hostDoctorMembership: async () => ({ intent, machines: [liveMachine()], parentHosts }),
    });
    await program.parseAsync(['node', 'elanous', 'doctor', 'host', 'node-c', '--json']);
    const report = JSON.parse(outputs.join('\n')) as HostDoctorReport;
    expect(report.checks.at(-2)?.id).toBe('registry.member');
    expect(report.checks.at(-1)?.id).toBe('parentHost.member');
    expect(report.ok).toBe(true);
  });

  test('doctor host assembles default membership sources when no membership stub is supplied', async () => {
    const outputs: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      out: { log: (line) => outputs.push(line) }, setExitCode: () => {},
      hostDoctorRemote: remoteFrom(HEALTHY), hostDoctorExpected: HQ,
      userConfig: { taskAgent: { parentHost: parentHosts } } as UserConfig,
      hostDoctorMachineResources: async () => [],
    });
    await program.parseAsync(['node', 'elanous', 'doctor', 'host', 'node-c', '--json']);
    const report = JSON.parse(outputs.join('\n')) as HostDoctorReport;
    expect(report.checks.map((check) => check.id)).toContain('registry.member');
    expect(report.checks.map((check) => check.id)).toContain('parentHost.member');
    expect(report.checks.find((check) => check.id === 'parentHost.member')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'parentHost.member')?.expected).toContain('pool-node-c@node-c:6');
  });

  test('doctor host reports missing checkout and parent config read errors as unmeasured causes', async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'host-doctor-no-ledger-'));
    try {
      const outputs: string[] = [];
      const program = new Command();
      registerDoctorCommand(program, {
        repositoryRoot,
        out: { log: (line) => outputs.push(line) }, setExitCode: () => {},
        hostDoctorRemote: remoteFrom(HEALTHY), hostDoctorExpected: HQ,
        getUserConfig: () => { throw new Error('config unreadable'); },
        hostDoctorMachineResources: async () => { throw new Error('control HTTP 500'); },
      });
      await program.parseAsync(['node', 'elanous', 'doctor', 'host', 'node-c', '--json']);
      const report = JSON.parse(outputs.join('\n')) as HostDoctorReport;
      expect(report.checks.find((check) => check.id === 'registry.member')?.observed).toContain('repository checkout required');
      expect(report.checks.find((check) => check.id === 'parentHost.member')?.observed).toContain('repository checkout required');
      const configuredOutputs: string[] = [];
      const configuredProgram = new Command();
      registerDoctorCommand(configuredProgram, {
        repositoryRoot: join(import.meta.dir, '../..'),
        out: { log: (line) => configuredOutputs.push(line) }, setExitCode: () => {},
        hostDoctorRemote: remoteFrom(HEALTHY), hostDoctorExpected: HQ,
        getUserConfig: () => { throw new Error('config unreadable'); },
        hostDoctorMachineResources: async () => { throw new Error('control HTTP 500'); },
      });
      await configuredProgram.parseAsync(['node', 'elanous', 'doctor', 'host', 'node-c', '--json']);
      const configuredReport = JSON.parse(configuredOutputs.join('\n')) as HostDoctorReport;
      expect(configuredReport.checks.find((check) => check.id === 'parentHost.member')?.observed).toContain('config unreadable');
      expect(configuredReport.checks.find((check) => check.id === 'registry.member')?.observed).toContain('control HTTP 500');
    } finally { rmSync(repositoryRoot, { recursive: true, force: true }); }
  });

  test('doctor host treats a null parentHost setting as unmeasured rather than crashing', async () => {
    const outputs: string[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      repositoryRoot: join(import.meta.dir, '../..'),
      out: { log: (line) => outputs.push(line) }, setExitCode: () => {},
      hostDoctorRemote: remoteFrom(HEALTHY), hostDoctorExpected: HQ,
      userConfig: { taskAgent: { parentHost: null } } as unknown as UserConfig,
      hostDoctorMachineResources: async () => [],
    });
    await program.parseAsync(['node', 'elanous', 'doctor', 'host', 'node-c', '--json']);
    const report = JSON.parse(outputs.join('\n')) as HostDoctorReport;
    expect(report.checks.find((check) => check.id === 'parentHost.member')?.status).toBe('unmeasured');
    expect(report.checks.find((check) => check.id === 'parentHost.member')?.observed).toContain('taskAgent.parentHost is null');
  });
});

// 10-11 실물(mbp·node-c·host-e-wsl) 수확 때 드러난 거짓 ✗ 넷 — 주입 시험만으로는 안 보였다.
describe('host doctor honest readings (10-11 harvest real-run fixes)', () => {
  const check = (id: string, stdout: string) => {
    const spec = HOST_DOCTOR_CHECKS.find((entry) => entry.id === id)!;
    return spec.expect({ status: 0, stdout, stderr: '' }, { platform: 'linux', arch: 'x86_64', expected: HQ });
  };

  test('ssh.batch does not nest another ssh — the remote shot itself is the evidence', async () => {
    expect(probeOf('ssh.batch')).not.toContain('ssh ');
    expect(check('ssh.batch', 'ok').status).toBe('pass');
  });

  test('image.arch treats x86_64≡amd64 and aarch64≡arm64', async () => {
    expect(normalizeArch('x86_64')).toBe(normalizeArch('amd64'));
    expect(normalizeArch('aarch64')).toBe(normalizeArch('arm64'));
    expect(check('image.arch', 'x86_64\namd64').status).toBe('pass');
    expect(check('image.arch', 'x86_64\narm64').status).toBe('fail');
  });

  test('k3d / tailscale missing from the non-interactive PATH is unmeasured, not fail', async () => {
    expect(check('k3d.cluster', 'no-cli').status).toBe('unmeasured');
    expect(check('k3d.cluster', 'none').status).toBe('fail');
    expect(check('k3d.cluster', 'present').status).toBe('pass');
    expect(check('k3d.cluster', 'error').status).toBe('unmeasured');
    expect(probeOf('k3d.cluster')).not.toContain('--no-header');
    expect(check('tailnet.online', 'no-cli').status).toBe('unmeasured');
    expect(check('tailnet.online', 'offline').status).toBe('fail');
  });

  test('registry.local accepts the pool registry port 5050 and says which port answered', async () => {
    const verdict = check('registry.local', 'reachable:5050');
    expect(verdict.status).toBe('pass');
    expect(verdict.observed).toContain('5050');
    expect(check('registry.local', 'unreachable').status).toBe('fail');
  });
});

describe('host doctor remote failure is unmeasured, not fail (10-11 review must-fix)', async () => {
  test('ssh exit 255 (connection refused / unresolved host) maps to «did not run»', async () => {
    expect(hostDoctorRunFromSpawn({ status: 255, stdout: '', stderr: 'ssh: Could not resolve hostname x' }, true)).toBeNull();
    // a local shell exiting 255 is a real answer, not a transport failure
    expect(hostDoctorRunFromSpawn({ status: 255, stdout: '', stderr: '' }, false)).toEqual({ status: 255, stdout: '', stderr: '' });
    expect(hostDoctorRunFromSpawn({ status: 1, stdout: '', stderr: '' }, true)).toEqual({ status: 1, stdout: '', stderr: '' });
  });

  test('an unreachable host yields every check unmeasured, ok false, missing = all ids, fixHref set', async () => {
    // the transport layer as it really behaves for an unreachable host: every shot comes back as exit 255
    const unreachable: HostDoctorRemote = () => hostDoctorRunFromSpawn({ status: 255, stdout: '', stderr: 'ssh: connect to host x port 22: Connection refused' }, true);
    const report = await runHostDoctor({ host: 'down-host', remote: unreachable, expected: HQ });
    expect(report.checks.every((check) => check.status === 'unmeasured')).toBe(true);
    expect(formatHostDoctorLines(report).some((line) => line.startsWith('✗'))).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(report.checks.length);
    expect(report.fixHref).not.toBeNull();
  });

  test('image.arch with no docker answer is unmeasured', async () => {
    const spec = HOST_DOCTOR_CHECKS.find((entry) => entry.id === 'image.arch')!;
    expect(spec.expect({ status: 0, stdout: 'x86_64\n', stderr: '' }, { platform: 'linux', arch: 'x86_64', expected: HQ }).status).toBe('unmeasured');
  });
});

describe('host doctor unreachable host is short-circuited (review should-fix)', async () => {
  test('a host whose first shot does not run gets one shot, not twelve', async () => {
    let shots = 0;
    const report = await runHostDoctor({ host: 'down', remote: () => { shots += 1; return null; }, expected: HQ });
    expect(shots).toBe(1);
    expect(report.checks.every((check) => check.status === 'unmeasured')).toBe(true);
    expect(report.checks.every((check) => !check.expected.includes('2>/dev/null'))).toBe(true);
  });
});
