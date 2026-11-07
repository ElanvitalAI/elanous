import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMachineProfile } from './machine-capture.js';
import { buildMachineSetupPlan, type MachineSetupOperation } from './machine-setup-plan.js';
import { applyMachineSetupPlan } from './machine-setup-apply.js';

test('setup apply defaults to dry-run and starts no package-manager commands', () => {
  const calls: string[] = [];
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'linux' });
  const result = applyMachineSetupPlan({ plan, confirmed: false, run: command => { calls.push(command); return { status: 0 }; } });
  expect(calls).toEqual([]);
  expect(result).toMatchObject({ applied: false, attempted: 0, succeeded: 0, failures: [] });
});

test('setup apply runs Linux packages one at a time, continues after errors, and aggregates only sanitized failures', () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'linux' });
  const result = applyMachineSetupPlan({
    plan,
    confirmed: true,
    root: true,
    run: (command, args) => {
      calls.push({ command, args });
      return args.includes('ripgrep') ? { status: 100, errorCode: 'SIMULATED' } : { status: 0 };
    },
  });
  expect(calls[0]).toEqual({ command: 'apt-get', args: ['update'] });
  expect(calls.filter(item => item.args[0] === 'install').every(item => item.args.length === 4)).toBe(true);
  expect(calls.findIndex(item => item.args.includes('ripgrep'))).toBeLessThan(calls.findIndex(item => item.args.includes('fd-find')));
  expect(result).toMatchObject({ applied: true, attempted: calls.length, succeeded: calls.length - 1 });
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toMatchObject({ target: 'ripgrep', reason: 'exit 100' });
  expect(JSON.stringify(result)).not.toContain('stderr');
});

test('setup apply registers every captured tap before installing any Homebrew package', () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const capture = {
    kind: 'machine-capture', platform: 'darwin',
    packages: { formulaeStatus: 'captured', casksStatus: 'captured', tapsStatus: 'captured', formulae: [{ name: 'neovim' }], casks: [], taps: ['zeta/custom', 'alpha/tools'] },
  };
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture });
  const result = applyMachineSetupPlan({ plan, confirmed: true,
    run: (command, args) => { calls.push({ command, args }); return args[0] === 'tap' && args[1] === 'alpha/tools' ? { status: 1 } : { status: 0 }; } });
  const firstInstall = calls.findIndex(item => item.args[0] === 'install');
  const registered = calls.filter(item => item.args[0] === 'tap').map(item => item.args[1]);
  expect(calls[0]).toEqual({ command: 'brew', args: ['--version'] });
  expect(registered).toEqual(['alpha/tools', 'zeta/custom']);
  expect(calls.findIndex(item => item.args[0] === 'tap')).toBeLessThan(firstInstall);
  expect(calls.some(item => item.args.at(-1) === 'neovim')).toBe(false);
  expect(result.failures).toMatchObject([{ target: 'alpha/tools', reason: 'exit 1' }]);
});

test('setup apply refuses an incomplete capture before executing anything', () => {
  const calls: string[] = [];
  const capture = {
    kind: 'machine-capture', platform: 'darwin',
    packages: { formulaeStatus: 'failed', casksStatus: 'captured', tapsStatus: 'failed', formulae: [], casks: [], taps: [] },
  };
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture });
  const result = applyMachineSetupPlan({ plan, confirmed: true, run: command => { calls.push(command); return { status: 0 }; } });
  expect(calls).toEqual([]);
  expect(result).toMatchObject({ applied: false, attempted: 0, failures: [{ operation: 'inventory-check' }] });
});

test('setup apply refuses unknown package inventory and never installs packages already present', () => {
  const unknownCapture = {
    kind: 'machine-capture', platform: 'darwin',
    packages: { formulaeStatus: 'failed', casksStatus: 'captured', tapsStatus: 'captured', formulae: [], casks: [], taps: [] },
  };
  const blockedPlan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: unknownCapture });
  const blockedCalls: string[] = [];
  const blocked = applyMachineSetupPlan({ plan: blockedPlan, confirmed: true,
    run: command => { blockedCalls.push(command); return { status: 0 }; } });
  expect(blockedCalls).toEqual([]);
  expect(blocked).toMatchObject({ applied: false, attempted: 0, failures: [{ operation: 'inventory-check' }] });

  const knownCapture = {
    kind: 'machine-capture', platform: 'darwin',
    packages: { formulaeStatus: 'captured', casksStatus: 'captured', tapsStatus: 'captured', formulae: [{ name: 'neovim' }], casks: [], taps: [] },
  };
  const knownPlan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: knownCapture });
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  applyMachineSetupPlan({ plan: knownPlan, confirmed: true,
    run: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
  expect(calls.some(call => call.args.at(-1) === 'neovim')).toBe(false);
});

test('setup apply executes cargo install operations from the approved plan', () => {
  const base = buildMachineSetupPlan({ profile: 'default', platform: 'linux' });
  const operation: MachineSetupOperation = {
    id: 'linux-cargo-sample', phase: 'local', kind: 'install', manager: 'cargo', packageKind: 'cargo',
    packages: ['sample-tool'], privilege: 'user', consent: 'none', reason: 'test operation',
  };
  const plan = { ...base,
    packages: [{ name: 'sample-tool', manager: 'cargo' as const, presence: 'would-install' as const, reason: 'test' }],
    operations: [operation],
  };
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const result = applyMachineSetupPlan({ plan, confirmed: true,
    run: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
  expect(calls).toEqual([{ command: 'cargo', args: ['install', '--locked', 'sample-tool'] }]);
  expect(result).toMatchObject({ applied: true, attempted: 1, succeeded: 1, failures: [] });
});

test('setup apply accepts exact tap-qualified Homebrew package identities', () => {
  const base = buildMachineSetupPlan({ profile: 'default', platform: 'macos' });
  const operation: MachineSetupOperation = {
    id: 'macos-brew-steipete-tap-camsnap', phase: 'local', kind: 'install', manager: 'brew', packageKind: 'formula',
    packages: ['steipete/tap/camsnap'], privilege: 'user', consent: 'none', reason: 'tap-qualified inventory identity',
  };
  const plan = { ...base,
    packages: [{ name: 'steipete/tap/camsnap', manager: 'brew' as const, presence: 'would-install' as const, reason: 'test' }],
    operations: [operation],
  };
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const result = applyMachineSetupPlan({ plan, confirmed: true,
    run: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
  expect(calls).toEqual([{ command: 'brew', args: ['install', 'steipete/tap/camsnap'] }]);
  expect(result).toMatchObject({ applied: true, attempted: 1, succeeded: 1, failures: [] });
});

test('real capture-to-plan-to-apply preserves exact tap identities for present and missing selected formulae', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-tap-roundtrip-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const brew = join(bin, 'brew');
  writeFileSync(brew, '#!/bin/sh\ncase "$*" in\n  "list --formula --full-name --versions") if [ -f "$HOME/include-packer" ]; then printf "hashicorp/tap/packer 1.14.0\\n"; fi; exit 0 ;;\n  "list --cask --full-name --versions") exit 0 ;;\n  tap) printf "hashicorp/tap\\n" ;;\nesac\n');
  chmodSync(brew, 0o755);
  try {
    writeFileSync(join(home, 'include-packer'), 'yes');
    const presentCapture = captureMachineProfile({ platform: 'darwin', architecture: 'arm64', home, path: bin });
    expect(presentCapture.packages.formulae).toContainEqual({ name: 'hashicorp/tap/packer', version: '1.14.0' });
    const presentPlan = buildMachineSetupPlan({ profile: 'headquarters', platform: 'macos', capture: presentCapture });
    expect(presentPlan.packages.find(item => item.name === 'hashicorp/tap/packer')?.presence).toBe('present');
    const presentCalls: Array<{ command: string; args: readonly string[] }> = [];
    applyMachineSetupPlan({ plan: presentPlan, confirmed: true,
      run: (command, args) => { presentCalls.push({ command, args }); return { status: 0 }; } });
    expect(presentCalls.some(call => call.args[0] === 'install' && call.args.at(-1)?.endsWith('/packer'))).toBe(false);

    rmSync(join(home, 'include-packer'));
    const missingCapture = captureMachineProfile({ platform: 'darwin', architecture: 'arm64', home, path: bin });
    const missingPlan = buildMachineSetupPlan({ profile: 'headquarters', platform: 'macos', capture: missingCapture });
    expect(missingPlan.packages.find(item => item.name === 'hashicorp/tap/packer')?.presence).toBe('would-install');
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = applyMachineSetupPlan({ plan: missingPlan, confirmed: true,
      run: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
    const tap = calls.findIndex(call => call.command === 'brew' && call.args[0] === 'tap' && call.args[1] === 'hashicorp/tap');
    const install = calls.findIndex(call => call.command === 'brew' && call.args[0] === 'install' && call.args.at(-1) === 'hashicorp/tap/packer');
    expect(tap).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(tap);
    expect(result.failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup apply validates sudo through the terminal and permits reauthentication for apt commands', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'linux' });
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const result = applyMachineSetupPlan({ plan, confirmed: true, root: false,
    run: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
  expect(calls[0]).toEqual({ command: 'sudo', args: ['-v'] });
  expect(calls.slice(1).every(call => call.command !== 'sudo' || call.args[0] === 'apt-get')).toBe(true);
  expect(result).toMatchObject({ applied: true, attempted: plan.operations.filter(op => op.id.endsWith('-apt-refresh') || op.kind === 'install' && op.manager === 'apt-get').length, failures: [] });
});


test.skipIf(process.env.ELANOUS_MACHINE_ZERO_UBUNTU !== '1')('zero Ubuntu container applies the default profile and passes its installed-tool health check', () => {
  const name = 'zero-machine-setup-' + randomUUID().replaceAll('-', '').slice(0, 16);
  const repo = process.cwd();
  const modules = realpathSync(join(repo, 'node_modules'));
  const bun = realpathSync(process.execPath);
  const run = (args: string[], timeout = 60_000) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
    if (result.error || result.status !== 0) {
      const status = result.status === null ? 'unknown' : String(result.status);
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const detail = result.error ? result.error.message : (result.stderr.trim() || 'no stderr');
      throw new Error('zero Ubuntu simulation command failed (exit ' + status + ', timeout=' + timedOut + '): '
        + args.slice(0, 4).join(' ') + ' · ' + detail.slice(0, 500));
    }
    return result.stdout.trim();
  };
  let primaryFailure: unknown;
  try {
    run(['run', '--detach', '--name', name, '--mount', 'type=bind,src=' + repo + ',dst=/repo,readonly',
      '--mount', 'type=bind,src=' + modules + ',dst=/repo/node_modules,readonly',
      '--mount', 'type=bind,src=' + bun + ',dst=/usr/local/bin/bun,readonly',
      '--workdir', '/repo', 'ubuntu:24.04', 'sleep', 'infinity']);
    const output = run(['exec', name, 'bun', 'bin/elanous.mjs', 'machine', 'setup', 'apply',
      '--profile', 'default', '--platform', 'linux', '--yes', '--json'], 15 * 60_000);
    const result = JSON.parse(output) as { applied: boolean; attempted: number; succeeded: number; failures: unknown[]; manual: string[] };
    expect(result.applied).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.succeeded).toBe(result.attempted);
    expect(result.attempted).toBeGreaterThan(0);
    expect(result.manual).toContain('linux-manual-yazi');
    expect(result.manual).toContain('linux-manual-eza');
    run(['exec', name, 'sh', '-c', 'for bin in zsh nvim rg fdfind fzf zoxide batcat git; do command -v "$bin" >/dev/null || exit 1; done']);
  } catch (error) {
    primaryFailure = error;
  }
  const cleanup = spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 30_000 });
  if (cleanup.error || cleanup.status !== 0) {
    const detail = cleanup.error ? cleanup.error.message : (cleanup.stderr.trim() || 'no stderr');
    const cleanupFailure = new Error('zero Ubuntu container cleanup failed (exit '
      + (cleanup.status === null ? 'unknown' : cleanup.status) + ', timeout='
      + ((cleanup.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') + '): ' + detail.slice(0, 500));
    if (primaryFailure) throw new AggregateError([primaryFailure, cleanupFailure], 'zero Ubuntu simulation and cleanup failed');
    throw cleanupFailure;
  }
  if (primaryFailure) throw primaryFailure;
}, 20 * 60_000);
