import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMachineProfile, writeMachineProfile } from '../roles/machine-profile.js';
import { registerMachineMembershipCommands } from './machine-membership.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'machine-membership-'));
  const output: string[] = [];
  const errors: string[] = [];
  let exitCode = -1;
  const getExitCode = () => exitCode;
  const program = new Command();
  const machine = program.command('machine');
  return { root, output, errors, program, machine,
    deps: { root, machine: () => 'demo-node', platform: () => 'linux' as const,
      output: { log: (line: string) => output.push(line), error: (line: string) => errors.push(line) },
      setExitCode: (code: number) => { exitCode = code; },
    },
    getExitCode,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('join plan prints OP-only cloud and admission commands without invoking them', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    registerMachineMembershipCommands(f.machine, { ...f.deps, run: command => { calls.push(command); return { status: 0 }; },
      setup: () => { calls.push('setup'); return { applied: true, failures: [] }; } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'pod', '--platform', 'linux', '--cloud', '--capacity', '4', '--json']);
    const plan = JSON.parse(f.output[0]!);
    expect(plan).toMatchObject({ kind: 'machine-join-plan', machine: 'demo-node', role: 'pod', dryRun: true });
    expect(plan.operatorActions[0]).toContain('External registration = OP executes');
    expect(plan.operatorActions).toContain('OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-join.sh demo-node --caps 4');
    expect(plan.operatorActions).toContain('OP only: add demo-node to the reviewed harness.podPool value');
    expect(calls).toEqual([]);
    expect(f.getExitCode()).toBe(0);
  } finally { f.cleanup(); }
});

test('join --yes applies local setup and checks, then declares the role without running OP tools', async () => {
  const f = fixture();
  const calls: Array<{ command: string; args: readonly string[]; interactive?: boolean }> = [];
  try {
    registerMachineMembershipCommands(f.machine, { ...f.deps,
      setup: (profile, platform) => { calls.push({ command: 'setup', args: [profile, platform] }); return { applied: true, failures: [] }; },
      run: (command, args, interactive) => {
        calls.push({ command, args, ...(interactive ? { interactive } : {}) });
        if (command === 'tailscale') return { status: 0, stdout: JSON.stringify({ BackendState: 'Running' }) };
        if (command === 'bash') return { status: 0 };
        return { status: 99 };
      } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'worker', '--profile', 'developer', '--capacity', '12', '--yes']);
    expect(calls[0]).toEqual({ command: 'setup', args: ['developer', 'linux'] });
    expect(calls.some(call => call.command === 'bash' && call.args.at(-1) === '--check')).toBe(true);
    expect(calls.some(call => call.command.includes('cloud-join') || call.command.includes('cloud-leave'))).toBe(false);
    expect(readMachineProfile(f.root)).toEqual({ id: 'demo-node', duties: ['worker'], seats: {}, membership: { role: 'worker', resourceCapGiB: 12, joinedAt: expect.any(String) } });
    expect(f.getExitCode()).toBe(0);
  } finally { f.cleanup(); }
});

test('join does not declare a role until user-approved Tailscale login completes', async () => {
  const f = fixture();
  const calls: Array<{ command: string; interactive?: boolean }> = [];
  try {
    registerMachineMembershipCommands(f.machine, { ...f.deps,
      setup: () => ({ applied: true, failures: [] }),
      run: (command, _args, interactive) => {
        calls.push({ command, ...(interactive ? { interactive } : {}) });
        return command === 'tailscale' ? { status: 0, stdout: '{"BackendState":"NeedsLogin"}' } : { status: 0 };
      } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'pod', '--capacity', '8', '--yes']);
    expect(calls).toEqual([{ command: 'tailscale' }, { command: 'tailscale', interactive: true }, { command: 'tailscale' }]);
    expect(readMachineProfile(f.root)).toBeUndefined();
    expect(f.errors[0]).toContain('Tailscale login needs user approval');
    expect(f.getExitCode()).toBe(1);
  } finally { f.cleanup(); }
});

test('headquarters role is not declared if the required local node check fails', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    writeMachineProfile({ id: 'demo-node', duties: ['worker', 'build'], seats: {} }, f.root);
    const before = readMachineProfile(f.root);
    registerMachineMembershipCommands(f.machine, { ...f.deps,
      setup: () => ({ applied: true, failures: [] }),
      run: (command, args) => {
        calls.push(command);
        if (command === 'tailscale') return { status: 0, stdout: '{"BackendState":"Running"}' };
        if (command === 'bash' && args.at(-1) === '--check') return { status: 2 };
        return { status: 0 };
      } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'headquarters', '--capacity', '24', '--yes']);
    expect(calls).toContain('bash');
    expect(readMachineProfile(f.root)).toEqual(before);
    expect(f.errors[0]).toContain('node-setup --check failed');
    expect(f.getExitCode()).toBe(1);
  } finally { f.cleanup(); }
});

test('setup failure preserves an existing local role and does not run Tailscale or node checks', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    writeMachineProfile({ id: 'demo-node', duties: ['worker', 'build'], seats: {} }, f.root);
    const before = readMachineProfile(f.root);
    registerMachineMembershipCommands(f.machine, { ...f.deps,
      setup: () => ({ applied: false, failures: ['setup failed'] }),
      run: command => { calls.push(command); return { status: 0, stdout: '{"BackendState":"Running"}' }; } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'headquarters', '--capacity', '24', '--yes']);
    expect(calls).toEqual([]);
    expect(readMachineProfile(f.root)).toEqual(before);
    expect(f.getExitCode()).toBe(1);
  } finally { f.cleanup(); }
});

test('empty successful wslpath output is a failed node check, not a joined role', async () => {
  const f = fixture();
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  try {
    registerMachineMembershipCommands(f.machine, { ...f.deps, platform: () => 'wsl', hostPlatform: 'win32',
      setup: () => ({ applied: true, failures: [] }),
      run: (command, args) => {
        calls.push({ command, args });
        if (command === 'tailscale.exe') return { status: 0, stdout: '{"BackendState":"Running"}' };
        if (command === 'wsl.exe' && args[0] === 'wslpath') return { status: 0, stdout: '' };
        return { status: 0 };
      } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'pod', '--platform', 'wsl', '--capacity', '8', '--yes']);
    expect(calls.some(call => call.command === 'wsl.exe' && call.args[0] === 'bash')).toBe(false);
    expect(readMachineProfile(f.root)).toBeUndefined();
    expect(f.errors[0]).toContain('node-setup --check failed');
    expect(f.getExitCode()).toBe(1);
  } finally { f.cleanup(); }
});

test('leave --yes checks locally but leaves role, capacity, pool, and cluster untouched', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    writeMachineProfile({ id: 'demo-node', duties: ['pod', 'build'], seats: { control: { rank: 1 } } }, f.root);
    const before = readMachineProfile(f.root);
    registerMachineMembershipCommands(f.machine, { ...f.deps,
      run: command => { calls.push(command); return command === 'tailscale' ? { status: 0, stdout: '{"BackendState":"Running"}' } : { status: 0 }; } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'leave', '--cloud', '--yes', '--json']);
    const result = JSON.parse(f.output[0]!);
    expect(result).toMatchObject({ kind: 'machine-leave-plan', roles: ['pod'], changed: { productMembership: false, hostCaps: false, podPool: false, cluster: false }, checked: { tailscale: true, nodeSetup: true }, membershipRemoved: false });
    expect(result.operatorActions).toContain('OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-leave.sh demo-node (drain → stop; never terminate)');
    expect(calls).toContain('tailscale');
    expect(calls.some(command => command.includes('cloud-leave'))).toBe(false);
    expect(readMachineProfile(f.root)).toEqual(before);
    expect(f.getExitCode()).toBe(0);
  } finally { f.cleanup(); }
});

test('join plans expose the ordered local and OP registration steps for every role', async () => {
  const expected: Array<{ role: string; operator: string[] }> = [
    { role: 'headquarters', operator: ['OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-join.sh demo-node'] },
    { role: 'gate', operator: [
      'OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-join.sh demo-node',
      'OP only: review host-caps capacity for demo-node',
    ] },
    { role: 'pod', operator: [
      'OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-join.sh demo-node',
      'OP only: review host-caps capacity for demo-node',
      'OP only: add demo-node to the reviewed harness.podPool value',
    ] },
    { role: 'worker', operator: [
      'OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-join.sh demo-node',
      'OP only: review host-caps capacity for demo-node',
    ] },
  ];
  for (const scenario of expected) {
    const f = fixture();
    const calls: string[] = [];
    try {
      registerMachineMembershipCommands(f.machine, { ...f.deps,
        run: command => { calls.push(command); return { status: 0 }; },
        setup: () => { calls.push('setup'); return { applied: true, failures: [] }; },
      });
      await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', scenario.role, '--cloud', '--json']);
      const plan = JSON.parse(f.output[0]!);
      expect(plan.localActions).toEqual([
        'machine setup apply --profile default --platform linux --yes',
        'install Tailscale from its approved platform source if missing; tailscale up requires user-approved login',
        'tailscale status',
        'bash scripts/fleet/node-setup.sh demo-node --check (no persistent changes; may create and remove a temporary DNS probe Pod)',
        'record local machine duty, resource ceiling (--capacity required by --yes), and join timestamp in the product ledger',
      ]);
      expect(plan.operatorActions).toEqual([
        'External registration = OP executes these steps; this command never runs or edits OP tools or ledgers.',
        ...scenario.operator,
      ]);
      expect(calls).toEqual([]);
    } finally { f.cleanup(); }
  }
});

test('leave plan prints drain, stop, cloud leave, then pod-pool removal without executing them', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    registerMachineMembershipCommands(f.machine, { ...f.deps,
      run: command => { calls.push(command); return { status: 0 }; } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'leave', '--role', 'pod', '--cloud']);
    expect(f.output).toEqual([[
      'machine leave · plan · demo-node · roles=pod · read only',
      'local --yes: tailscale status (read only)',
      'local --yes: bash scripts/fleet/node-setup.sh demo-node --check (no persistent changes; may create and remove a temporary DNS probe Pod)',
      'local --yes: remove this machine membership record from the product ledger',
      'External registration = OP executes these steps; this command never runs or edits OP tools or ledgers.',
      'OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-leave.sh demo-node (drain → stop; never terminate)',
      'OP only: after drain/stop, remove demo-node from host-caps.tsv',
      'OP only: remove demo-node from the reviewed harness.podPool value',
    ].join('\n')]);
    expect(calls).toEqual([]);
  } finally { f.cleanup(); }
});


test('join --yes applies local declaration for every role and never runs OP registration commands', async () => {
  for (const role of ['headquarters', 'gate', 'pod', 'worker'] as const) {
    const f = fixture();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      registerMachineMembershipCommands(f.machine, { ...f.deps,
        setup: () => ({ applied: true, failures: [] }),
        run: (command, args) => {
          calls.push({ command, args });
          if (command === 'tailscale') return { status: 0, stdout: '{"BackendState":"Running"}' };
          return { status: 0 };
        } });
      await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', role, '--cloud', '--capacity', '24', '--yes']);
      expect(readMachineProfile(f.root)).toEqual({ id: 'demo-node', duties: [role], seats: {}, membership: { role, resourceCapGiB: 24, joinedAt: expect.any(String) } });
      expect(calls.some(call => call.command === 'bash' && call.args.at(-1) === '--check')).toBe(true);
      expect(calls.every(call => !call.command.includes('cloud-join') && !call.command.includes('host-caps') && !call.command.includes('podPool'))).toBe(true);
      expect(f.getExitCode()).toBe(0);
    } finally { f.cleanup(); }
  }
});

test('join requires a resource ceiling before any side effect and persists its timestamp in the product ledger', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    registerMachineMembershipCommands(f.machine, { ...f.deps, now: () => new Date('2026-11-07T12:00:00.000Z'),
      setup: () => { calls.push('setup'); return { applied: true, failures: [] }; },
      run: command => { calls.push(command); return command === 'tailscale' ? { status: 0, stdout: '{"BackendState":"Running"}' } : { status: 0 }; } });
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'gate', '--yes']);
    expect(f.errors[0]).toContain('--capacity <GiB> is required');
    expect(calls).toEqual([]);
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'gate', '--capacity', '16', '--yes']);
    expect(readMachineProfile(f.root)?.membership).toEqual({ role: 'gate', resourceCapGiB: 16, joinedAt: '2026-11-07T12:00:00.000Z' });
  } finally { f.cleanup(); }
});

test('leave removes only the local membership after checks and emits OP registration scripts without running them', async () => {
  const f = fixture();
  const calls: string[] = [];
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const outDir = mkdtempSync(join(tmpdir(), 'machine-op-script-'));
  try {
    writeMachineProfile({ id: 'demo-node', duties: ['worker', 'pod'], seats: {}, membership: { role: 'worker', resourceCapGiB: 12, joinedAt: '2026-11-07T12:00:00.000Z' } }, f.root);
    registerMachineMembershipCommands(f.machine, { ...f.deps, run: command => { calls.push(command); return command === 'tailscale' ? { status: 0, stdout: '{"BackendState":"Running"}' } : { status: 0 }; } });
    const scriptPath = join(outDir, 'join-op.sh');
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'worker', '--cloud', '--capacity', '12', '--emit-script', scriptPath]);
    const combinedJoinPath = join(outDir, 'combined-join.sh');
    await f.program.parseAsync(['node', 'eln', 'machine', 'join', '--role', 'worker', '--cloud', '--capacity', '12', '--yes', '--emit-script', combinedJoinPath]);
    expect(f.errors.at(-1)).toContain('--emit-script and --yes are separate operations');
    expect(existsSync(combinedJoinPath)).toBe(false);
    await f.program.parseAsync(['node', 'eln', 'machine', 'leave', '--cloud', '--json']);
    expect(JSON.parse(f.output.at(-1)!).roles).toEqual(['worker']);
    const joinScript = readFileSync(scriptPath, 'utf8');
    expect(joinScript).toContain('rollback)');
    expect(joinScript).toContain('ELANOUS_OP_APPROVED');
    expect(joinScript.indexOf('host-caps.tsv')).toBeLessThan(joinScript.indexOf('cloud-join.sh'));
    expect(spawnSync('bash', ['-n', scriptPath]).status).toBe(0);
    expect(calls).toEqual([]);
    await f.program.parseAsync(['node', 'eln', 'machine', 'leave', '--role', 'worker', '--cloud', '--emit-script', join(outDir, 'leave-op.sh')]);
    const combinedLeavePath = join(outDir, 'combined-leave.sh');
    await f.program.parseAsync(['node', 'eln', 'machine', 'leave', '--role', 'worker', '--cloud', '--yes', '--emit-script', combinedLeavePath]);
    expect(f.errors.at(-1)).toContain('--emit-script and --yes are separate operations');
    expect(existsSync(combinedLeavePath)).toBe(false);
    const leaveScript = readFileSync(join(outDir, 'leave-op.sh'), 'utf8');
    expect(leaveScript).toContain('assignment drain then host stop');
    expect(leaveScript).toContain('cloud-leave.sh');
    expect(leaveScript.indexOf('cloud-leave.sh')).toBeLessThan(leaveScript.indexOf('OP removes host-caps.tsv'));
    expect(leaveScript).toContain('cloud-join.sh');
    expect(spawnSync('bash', ['-n', join(outDir, 'leave-op.sh')]).status).toBe(0);
    const fakeBin = join(outDir, 'bin');
    mkdirSync(fakeBin);
    const opLog = join(outDir, 'op.log');
    writeFileSync(join(fakeBin, 'zsh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OP_LOG"\n', { mode: 0o700 });
    writeFileSync(opLog, '');
    const runEmitted = (path: string, mode: string, input = 'y\n') => spawnSync('bash', [path, mode], { encoding: 'utf8', input,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, OP_LOG: opLog, ELANOUS_OP_APPROVED: '1' } });
    const refused = spawnSync('bash', [scriptPath, 'apply'], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, OP_LOG: opLog, ELANOUS_OP_APPROVED: '0' } });
    expect(refused.status).toBe(2);
    expect(readFileSync(opLog, 'utf8').length).toBe(0);
    expect(runEmitted(scriptPath, 'apply', 'n\n').status).toBe(2);
    expect(readFileSync(opLog, 'utf8').length).toBe(0);
    expect(runEmitted(scriptPath, 'apply', 'JOIN-READY:demo-node:worker:12\n').status).toBe(0);
    expect(readFileSync(opLog, 'utf8')).toContain('cloud-join.sh demo-node --caps 12');
    writeFileSync(opLog, '');
    expect(runEmitted(scriptPath, 'rollback', 'no\n').status).toBe(2);
    expect(readFileSync(opLog, 'utf8').length).toBe(0);
    expect(runEmitted(scriptPath, 'rollback', 'ROLLBACK-READY:demo-node\n').status).toBe(0);
    expect(readFileSync(opLog, 'utf8')).toContain('cloud-leave.sh demo-node');
    writeFileSync(opLog, '');
    expect(runEmitted(join(outDir, 'leave-op.sh'), 'apply', 'no\n').status).toBe(2);
    expect(readFileSync(opLog, 'utf8')).toContain('cloud-leave.sh demo-node');
    writeFileSync(opLog, '');
    expect(runEmitted(join(outDir, 'leave-op.sh'), 'apply', 'UNLISTED:demo-node\n').status).toBe(0);
    expect(readFileSync(opLog, 'utf8')).toContain('cloud-leave.sh demo-node');
    writeFileSync(opLog, '');
    expect(runEmitted(join(outDir, 'leave-op.sh'), 'rollback', 'no\n').status).toBe(2);
    expect(readFileSync(opLog, 'utf8').length).toBe(0);
    expect(runEmitted(join(outDir, 'leave-op.sh'), 'rollback', 'RESTORED:demo-node:worker:12\n').status).toBe(0);
    expect(readFileSync(opLog, 'utf8')).toContain('cloud-join.sh demo-node --caps 12');
    expect(calls).toEqual([]);
    await f.program.parseAsync(['node', 'eln', 'machine', 'leave', '--role', 'worker', '--cloud', '--yes']);
    expect(readMachineProfile(f.root)).toEqual({ id: 'demo-node', duties: ['worker', 'pod'], seats: {} });
    expect(calls.some(command => command.includes('cloud-leave') || command.includes('host-caps') || command.includes('podPool'))).toBe(false);
  } finally { rmSync(outDir, { recursive: true, force: true }); f.cleanup(); }
});
