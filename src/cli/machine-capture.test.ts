import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { captureMachineProfile, registerMachineCaptureCommand } from './machine-capture.js';

test('machine capture records only allowlisted dotfile hashes and omits file contents', () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-capture-'));
  try {
    const content = 'TOKEN=must-not-appear';
    writeFileSync(join(home, '.zshrc'), content);
    mkdirSync(join(home, '.config', 'nvim'), { recursive: true });
    writeFileSync(join(home, '.config', 'nvim', 'init.lua'), 'vim.opt.number = true');

    const profile = captureMachineProfile({
      platform: 'freebsd',
      architecture: 'x64',
      home,
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(profile);

    expect(profile.kind).toBe('machine-capture');
    expect(profile.packages.manager).toBeNull();
    expect(profile.dotfiles.find(file => file.path === '.zshrc')).toEqual({
      path: '.zshrc',
      status: 'hashed',
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    expect(serialized).not.toContain(content);
    expect(profile.dotfiles.some(file => file.path.includes('init.lua'))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Linux machine capture reads Homebrew formulae when brew exists on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-capture-brew-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  try {
    const brew = join(bin, 'brew');
    writeFileSync(brew, '#!/bin/sh\ncase "$*" in tap) printf "custom/repo\\n" ;; *--cask*) printf "vendor/tools/sample-cask 1.2.3\\n" ;; *) printf "vendor/tools/sample-formula 1.2.3\\n" ;; esac\n');
    chmodSync(brew, 0o755);
    const profile = captureMachineProfile({ platform: 'linux', architecture: 'x64', home, path: bin });
    expect(profile.packages.manager).toBe('homebrew');
    expect(profile.packages.formulaeStatus).toBe('captured');
    expect(profile.packages.formulae).toEqual([{ name: 'vendor/tools/sample-formula', version: '1.2.3' }]);
    expect(profile.packages.casksStatus).toBe('captured');
    expect(profile.packages.casks).toEqual([{ name: 'vendor/tools/sample-cask', version: '1.2.3' }]);
    expect(profile.packages.tapsStatus).toBe('captured');
    expect(profile.packages.taps).toEqual(['custom/repo']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('machine capture command writes a private no-overwrite profile and protects the allowlist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-capture-cli-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const secret = 'TOKEN=must-not-appear';
  writeFileSync(join(home, '.zshrc'), secret);
  try {
    const program = new Command();
    const machine = program.command('machine');
    registerMachineCaptureCommand(machine.command('capture'), {
      capture: () => captureMachineProfile({ platform: 'linux', home }),
    });
    const output = join(root, 'profile.json');
    await program.parseAsync(['node', 'eln', 'machine', 'capture', '--out', output]);
    const json = readFileSync(output, 'utf8');
    expect(json).not.toContain(secret);
    expect(statSync(output).mode & 0o777).toBe(0o600);

    writeFileSync(join(home, '.zshrc'), 'replacement');
    const exits: number[] = [];
    const errors: string[] = [];
    const secondProgram = new Command();
    registerMachineCaptureCommand(secondProgram.command('machine').command('capture'), {
      capture: () => captureMachineProfile({ platform: 'linux', home }),
      err: { error: line => errors.push(line) },
      setExitCode: code => exits.push(code),
    });
    await secondProgram.parseAsync(['node', 'eln', 'machine', 'capture', '--out', output]);
    expect(readFileSync(output, 'utf8')).toBe(json);
    expect(exits).toEqual([1]);
    expect(errors[0]).toContain('existing files are never overwritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux machine capture rejects external symlinks, oversized dotfiles, and FIFOs', () => {
  if (process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'machine-capture-paths-'));
  const home = join(root, 'home');
  mkdirSync(home);
  try {
    const outside = join(root, 'outside');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(home, '.zshrc'));
    writeFileSync(join(home, '.zprofile'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const fifo = join(home, '.p10k.zsh');
    const madeFifo = Bun.spawnSync(['mkfifo', fifo]).exitCode === 0;
    const profile = captureMachineProfile({ platform: 'linux', home });
    expect(profile.dotfiles.find(file => file.path === '.zshrc')?.status).toBe('not-regular');
    expect(profile.dotfiles.find(file => file.path === '.zprofile')?.status).toBe('too-large');
    if (madeFifo) expect(profile.dotfiles.find(file => file.path === '.p10k.zsh')?.status).toBe('not-regular');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
