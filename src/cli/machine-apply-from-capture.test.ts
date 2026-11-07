import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { applyMachineCapture, currentMachineSetupPlatform } from './machine-apply-from-capture.js';
import { registerMachineApplyFromCaptureCommand } from './machine-apply-from-capture.js';

const sourceCapture = {
  schemaVersion: 1,
  kind: 'machine-capture',
  platform: 'darwin',
  packages: {
    status: 'captured',
    formulaeStatus: 'captured',
    casksStatus: 'captured',
    tapsStatus: 'captured',
    formulae: [{ name: 'ripgrep' }],
    casks: [],
    taps: ['homebrew/cask', 'owner/tools'],
  },
};

test('machine apply treats capture as source and leaves curated packages in the target plan', () => {
  const calls: string[][] = [];
  const dryRun = applyMachineCapture({ capture: sourceCapture, profile: 'default', platform: 'macos', confirmed: false });
  expect(dryRun).toMatchObject({ applied: false, attempted: 0, platform: 'macos' });

  const result = applyMachineCapture({
    capture: sourceCapture,
    profile: 'default',
    platform: 'macos',
    confirmed: true,
    run: (command, args) => { calls.push([command, ...args]); return { status: 0 }; },
    root: false,
  });
  expect(result.applied).toBe(true);
  expect(calls).toContainEqual(['brew', 'tap', 'owner/tools']);
  expect(calls).toContainEqual(['brew', 'install', 'ripgrep']);
  expect(calls.findIndex(call => call[1] === 'tap')).toBeLessThan(calls.findIndex(call => call[1] === 'install'));
});

test('machine apply blocks incomplete source tap inventory before executing commands', () => {
  const calls: string[][] = [];
  const result = applyMachineCapture({
    capture: { ...sourceCapture, packages: { ...sourceCapture.packages, tapsStatus: 'failed', taps: [] } },
    profile: 'default',
    platform: 'macos',
    confirmed: true,
    run: (command, args) => { calls.push([command, ...args]); return { status: 0 }; },
  });
  expect(result.applied).toBe(false);
  expect(result.failures[0]?.operation).toBe('inventory-check');
  expect(calls).toEqual([]);
});

test('platform inference distinguishes WSL from ordinary Linux', () => {
  expect(currentMachineSetupPlatform({}, 'darwin')).toBe('macos');
  expect(currentMachineSetupPlatform({}, 'linux')).toBe('linux');
  expect(currentMachineSetupPlatform({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux')).toBe('wsl');
  expect(currentMachineSetupPlatform({}, 'win32')).toBe('wsl');
});

test('machine apply CLI prints reviewable dry-run plan and aggregates package failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-apply-cli-'));
  const capturePath = join(root, 'capture.json');
  writeFileSync(capturePath, JSON.stringify(sourceCapture));
  const output: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  let calls = 0;
  const run = async (yes: boolean): Promise<void> => {
    const program = new Command();
    registerMachineApplyFromCaptureCommand(program.command('apply'), {
      platform: () => 'macos',
      root: false,
      run: () => { calls += 1; return { status: 7 }; },
      out: { log: value => output.push(value) },
      err: { error: value => errors.push(value) },
      setExitCode: code => exits.push(code),
    });
    await program.parseAsync(['node', 'eln', 'apply', '--from', capturePath, ...(yes ? ['--yes'] : [])]);
  };
  try {
    await run(false);
    expect(output[0]).toContain('brew tap homebrew/cask');
    expect(output[0]).toContain('brew install ripgrep');
    expect(output[0]).toContain('No commands executed. Add --yes to apply.');
    expect(calls).toBe(0);

    output.length = 0;
    await run(true);
    expect(output[0]).toContain('failures');
    expect(output[1]).toContain('ripgrep');
    expect(calls).toBeGreaterThan(1);
    expect(exits).toEqual([1]);
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
