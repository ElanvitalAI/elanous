import { accessSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const launcher: any = require('../bin/elanous.cjs');
// Keep this CommonJS boundary dynamic: the changed-file typecheck resolver does not model .cjs imports.
const postinstallPath = './npm-postinstall.cjs';
const postinstall: any = require(postinstallPath);

function zipEntry(name: string, input: Buffer, method: 0 | 8): Buffer {
  const data = method === 8 ? deflateRawSync(input) : input;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(input.length, 22);
  local.writeUInt16LE(Buffer.byteLength(name), 26);
  const encodedName = Buffer.from(name);
  const localPart = Buffer.concat([local, encodedName, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(input.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, encodedName]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

test('Bun ZIP reader extracts the exact official archive member with stored and deflated data', () => {
  const contents = Buffer.from('verified bun executable');
  for (const method of [0, 8] as const) {
    const archive = zipEntry('bun-linux-x64/bun', contents, method);
    expect(launcher.archiveEntry(archive, 'bun-linux-x64/bun')).toEqual(contents);
    expect(() => launcher.archiveEntry(archive, '../bun')).toThrow('missing ../bun');
  }
});

test('launcher selects supported Bun targets and rejects unsupported versions', () => {
  expect(launcher.bunTarget('linux', 'x64')).toBe('linux-x64');
  expect(launcher.bunTarget('darwin', 'arm64')).toBe('darwin-aarch64');
  expect(launcher.bunTarget('win32', 'x64')).toBe('windows-x64');
  expect(launcher.compareVersions('1.3.5', '1.3.5')).toBe(0);
  expect(launcher.compareVersions('1.4.0', '1.3.5')).toBeGreaterThan(0);
  expect(launcher.compareVersions('1.2.9', '1.3.5')).toBeLessThan(0);
});

test('launcher installs only from a real Bun executable and honors first-run controls', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-npm-launcher-'));
  try {
    const fake = join(root, 'bun');
    const managed = join(root, '.local', 'share', 'elanous', 'bin', 'bun');
    writeFileSync(fake, '#!/bin/sh\nprintf "1.4.2\\n"\n');
    mkdirSync(join(root, '.local', 'share', 'elanous', 'bin'), { recursive: true });
    writeFileSync(managed, '#!/bin/sh\nprintf "1.4.2\\n"\n');
    chmodSync(fake, 0o755);
    chmodSync(managed, 0o755);
    const env = { HOME: root, PATH: root };
    expect(launcher.findBun(env)).toBe(managed);
    expect(launcher.findBun({ ...env, ELANOUS_INSTALL_PREFIX: join(root, '.local', 'share', 'elanous'), ELANOUS_BUN: fake })).toBe(fake);
    expect(launcher.findBun({ HOME: join(root, 'empty-home'), PATH: '' }, () => fake)).toBe(fake);
    expect(launcher.findBun({ HOME: root, PATH: process.env.PATH })).not.toBe(process.execPath);
    const defaultMarker = launcher.markerPath({ HOME: root });
    expect(launcher.markerPath({ HOME: root, ELANOUS_INSTALL_PREFIX: join(root, 'custom-tools'), XDG_DATA_HOME: join(root, 'custom-xdg') })).toBe(defaultMarker);
    const customPrefix = { ...env, ELANOUS_INSTALL_PREFIX: join(root, 'custom-tools') };
    const prefixMarker = launcher.prefixMarkerPath(customPrefix);
    mkdirSync(join(root, 'custom-tools'), { recursive: true });
    writeFileSync(prefixMarker, 'ready');
    launcher.invalidatePrefixReadiness(customPrefix);
    expect(() => accessSync(prefixMarker)).toThrow();
    expect(prefixMarker).toContain(join(root, 'custom-tools', 'bootstrap-ready-'));
    expect(defaultMarker.startsWith(join(root, '.local', 'share', 'elanous', 'doctor-ok-'))).toBe(true);
    expect(launcher.shouldAutoBootstrap(['status'], customPrefix, (path: string) => path === defaultMarker)).toBe(true);
    expect(launcher.shouldAutoBootstrap(['status'], customPrefix, (path: string) => path === defaultMarker || path === prefixMarker)).toBe(false);
    expect(launcher.shouldAutoBootstrap(['status'], { ...env, XDG_DATA_HOME: join(root, 'data') }, () => false)).toBe(true);
    expect(launcher.shouldAutoBootstrap(['bootstrap'], env, () => false)).toBe(false);
    expect(launcher.shouldInvalidatePrefixReadiness(['bootstrap'], env)).toBe(true);
    expect(launcher.shouldAutoBootstrap(['--version'], env, () => false)).toBe(false);
    expect(launcher.shouldAutoBootstrap(['status'], { ...env, ELANOUS_NO_AUTO_DOCTOR: '1' }, () => false)).toBe(false);
    expect(launcher.shouldAutoBootstrap(['status'], env, () => true)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm postinstall is silent best-effort and respects skip conditions', () => {
  for (const env of [
    { ELANOUS_SKIP_POSTINSTALL: '1' },
    { CI: 'true' },
    { npm_config_offline: 'true' },
    { npm_config_online: 'false' },
  ]) {
    let called = false;
    expect(postinstall.runPostinstall(env, () => { called = true; return { status: 1 } as never; })).toBe(0);
    expect(called).toBe(false);
  }
  let called = false;
  expect(postinstall.runPostinstall({}, () => { called = true; return { status: 0 } as never; })).toBe(0);
  expect(called).toBe(false);
  let call: { file: string; args: string[]; options: { stdio: string; env: NodeJS.ProcessEnv; detached: boolean } } | undefined;
  expect(postinstall.runPostinstall({ npm_config_global: 'true' }, ((file: string, args: string[], options: { stdio: string; env: NodeJS.ProcessEnv; detached: boolean }) => {
    call = { file, args, options };
    throw new Error('simulated offline install');
  }) as any)).toBe(0);
  expect(call?.args.at(-1)).toBe('bootstrap');
  expect(call?.options.stdio).toBe('ignore');
  expect(call?.options.env.ELANOUS_INSTALL_YES).toBe('1');
  expect(call?.options.detached).toBe(process.platform !== 'win32');
});

test('npm postinstall timeout kills the detached process group', () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  postinstall.killProcessTree({ pid: 1234, kill: () => { throw new Error('child-only kill used'); } }, 'linux', ((pid: number, signal: NodeJS.Signals) => {
    signals.push([pid, signal]);
  }) as typeof process.kill);
  expect(signals).toEqual([[-1234, 'SIGKILL']]);
  let windowsCall: string[] = [];
  postinstall.killProcessTree({ pid: 4321, kill: () => { throw new Error('child-only kill used'); } }, 'win32', process.kill, ((file: string, args: string[]) => {
    windowsCall = [file, ...args];
    return { status: 0 };
  }) as any);
  expect(windowsCall).toEqual(['taskkill', '/pid', '4321', '/t', '/f']);
  const fallbackCommands: string[] = [];
  postinstall.killProcessTree({ pid: 4322, kill: () => { throw new Error('unexpected fallback'); } }, 'win32', process.kill, ((file: string) => {
    fallbackCommands.push(file);
    return { status: file === 'taskkill' ? 1 : 0 };
  }) as any);
  expect(fallbackCommands).toEqual(['taskkill', 'powershell.exe']);
  let lastResort = '';
  postinstall.killProcessTree({ pid: 4323, kill: (signal: string) => { lastResort = signal; } }, 'win32', process.kill, (() => ({ status: 1 })) as any);
  expect(lastResort).toBe('SIGKILL');
});

test('npm postinstall gives up waiting after a failed tree termination attempt', async () => {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = 9876;
  let unrefed = false;
  child.unref = () => { unrefed = true; };
  let terminationAttempts = 0;
  postinstall.runPostinstall({ npm_config_global: 'true' }, (() => child) as any, 5, (() => { terminationAttempts += 1; throw new Error('simulated OS failure'); }) as any);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(terminationAttempts).toBe(1);
  expect(unrefed).toBe(true);
});

test('launcher timeout kills the bootstrap process tree', async () => {
  const calls: string[] = [];
  launcher.killChildTree({ pid: 123, kill: (signal: string) => { calls.push(`fallback:${signal}`); } }, 'win32', ((file: string, args: string[]) => {
    calls.push(`${file}:${args.join(' ')}`);
    return { status: 0 };
  }) as any);
  launcher.killChildTree({ pid: 124, kill: () => { throw new Error('unexpected fallback'); } }, 'win32', ((file: string) => {
    calls.push(file);
    return { status: file === 'taskkill' ? 1 : 0 };
  }) as any);
  expect(calls).toEqual(['taskkill:/pid 123 /t /f', 'taskkill', 'powershell.exe']);
  let lastResort = '';
  launcher.killChildTree({ pid: 125, kill: (signal: string) => { lastResort = signal; } }, 'win32', (() => ({ status: 1 })) as any);
  expect(lastResort).toBe('SIGKILL');
  const root = mkdtempSync(join(tmpdir(), 'elanous-npm-tree-'));
  const marker = join(root, 'grandchild-survived');
  try {
    const script = 'const {spawn}=require("node:child_process"); const fs=require("node:fs"); spawn(process.execPath,["-e",`setTimeout(()=>require("node:fs").writeFileSync(process.env.MARKER,"alive"),2000);setInterval(()=>{},1000)`],{stdio:"ignore",env:process.env}); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)';
    const result = await launcher.spawnWithTimeout(process.execPath, ['-e', script], { stdio: 'ignore', env: { ...process.env, MARKER: marker } }, 1_000);
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(() => accessSync(marker)).toThrow();
    const bounded = await launcher.spawnWithTimeout(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }, 1_000);
    expect(bounded.timedOut).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
