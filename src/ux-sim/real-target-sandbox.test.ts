import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Command } from 'commander';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createWorldRegressionTargetRunner, type SuiteCase } from './world.js';
import { linuxSocketDenyFilter, macRealTargetSandboxProfile, runRealTargetSandbox } from './real-target-sandbox.js';
import { registerSimCommands } from '../cli/sim-cli.js';

const roots: string[] = [];
const priorRoot = getTestStateRoot();
const priorEnv = {
  adapter: process.env.ELANOUS_SIM_REAL_TARGET_ADAPTER,
  allowlist: process.env.ELANOUS_SIM_REAL_TARGET_WRITE_ALLOWLIST,
  timeout: process.env.ELANOUS_SIM_REAL_TARGET_TIMEOUT_MS,
  stop: process.env.ELANOUS_SIM_REAL_TARGET_STOP_FILE,
};
const linuxBwrapAvailable = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) && spawnSync('bwrap',
  ['--unshare-net', '--unshare-pid', '--as-pid-1', '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib', '--chdir', '/', '/usr/bin/true'], { timeout: 1_000 }).status === 0; // Source: 내부 문서 `sim-scenario-regression-load` §S; CI may lack user namespaces.
const runtimeAvailable = linuxBwrapAvailable || (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'real-target-sandbox-'));
  roots.push(root);
  setTestStateRoot(root);
  const allowed = join(root, 'allowed');
  mkdirSync(allowed);
  const adapterPath = join(root, 'adapter.mjs');
  const item: SuiteCase = { id: 'hostile', worldFile: join(root, 'world.yaml'),
    scenarioFile: join(root, 'scenario.yaml'), baselineFile: join(root, 'baseline.real.json') };
  writeFileSync(item.worldFile, 'world: hostile\n');
  writeFileSync(item.scenarioFile, 'steps: []\n');
  return { root, allowed, adapterPath, item };
};

afterEach(() => {
  setTestStateRoot(priorRoot ?? null);
  const mapping = { ELANOUS_SIM_REAL_TARGET_ADAPTER: priorEnv.adapter,
    ELANOUS_SIM_REAL_TARGET_WRITE_ALLOWLIST: priorEnv.allowlist,
    ELANOUS_SIM_REAL_TARGET_TIMEOUT_MS: priorEnv.timeout,
    ELANOUS_SIM_REAL_TARGET_STOP_FILE: priorEnv.stop };
  for (const [key, value] of Object.entries(mapping)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!runtimeAvailable)('real target worker blocks an uncooperative adapter write and network call while allowing one declared path', async () => {
  const { root, allowed, adapterPath, item } = fixture();
  const outside = join(root, 'outside.txt');
  const inside = join(allowed, 'inside.txt');
  writeFileSync(join(root, 'adjacent.mjs'), `export const marker = 'adjacent-ok';`);
  writeFileSync(adapterPath, `import { readFileSync, writeFileSync } from 'node:fs';
import { marker } from './adjacent.mjs';
export async function run() {
  const inputsVisible = readFileSync(${JSON.stringify(item.worldFile)}, 'utf8').includes('hostile')
    && readFileSync(${JSON.stringify(item.scenarioFile)}, 'utf8').includes('steps') && marker === 'adjacent-ok';
  let outsideBlocked = false;
  try { writeFileSync(${JSON.stringify(outside)}, 'escape'); } catch { outsideBlocked = true; }
  writeFileSync(${JSON.stringify(inside)}, 'allowed');
  let networkBlocked = false;
  try { await fetch('https://example.com'); } catch { networkBlocked = true; }
  return { pass: inputsVisible && outsideBlocked && networkBlocked, steps: [{ id: 'bounds', outcome: String(inputsVisible) + '/' + String(outsideBlocked) + '/' + String(networkBlocked), invariant: 'pass', durationMs: null }], eventKinds: ['bounds'] };
}`);
  setTestStateRoot(root);
  process.env.ELANOUS_SIM_REAL_TARGET_ADAPTER = adapterPath;
  process.env.ELANOUS_SIM_REAL_TARGET_WRITE_ALLOWLIST = JSON.stringify([allowed]);
  process.env.ELANOUS_SIM_REAL_TARGET_TIMEOUT_MS = '5000'; // Source: 내부 문서 `sim-scenario-regression-load` §S; bounded fixed-response fixture.
  const receipt = await createWorldRegressionTargetRunner().run(item, 'real');
  expect(receipt).toMatchObject({ pass: true, steps: [{ id: 'bounds', outcome: 'true/true/true' }] });
  expect(existsSync(outside)).toBe(false);
  expect(readFileSync(inside, 'utf8')).toBe('allowed');
});

test.skipIf(!runtimeAvailable)('parent time limit kills an adapter that never cooperates', async () => {
  const { root, adapterPath, item } = fixture();
  writeFileSync(adapterPath, 'export async function run() { while (true) {} }');
  await expect(runRealTargetSandbox(item, { testRoot: root, adapterPath, writeAllowlist: [], timeoutMs: 150 })) // Source: 내부 문서 `sim-scenario-regression-load` §S; short fixture deadline.
    .rejects.toThrow('time limit');
});

test.skipIf(!linuxBwrapAvailable)('parent stop switch kills an adapter and its child even when neither cooperates', async () => {
  const { root, allowed, adapterPath, item } = fixture();
  const stopFile = join(root, 'stop');
  const marker = join(allowed, 'late-child.txt');
  writeFileSync(adapterPath, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`) }], { detached: true, stdio: 'ignore' }).unref();
export async function run() { while (true) {} }`);
  setTimeout(() => writeFileSync(stopFile, 'stop'), 100); // Source: 내부 문서 `sim-scenario-regression-load` §S; fixed stop-switch trigger.
  await expect(runRealTargetSandbox(item, { testRoot: root, adapterPath, writeAllowlist: [allowed], timeoutMs: 2_000, stopFile })) // Source: 내부 문서 `sim-scenario-regression-load` §S; bounded fallback deadline.
    .rejects.toThrow('stop switch');
  await new Promise((resolve) => setTimeout(resolve, 650)); // Source: 내부 문서 `sim-scenario-regression-load` §S; wait past the child's fixed late-write point.
  expect(existsSync(marker)).toBe(false);
});

test.skipIf(process.platform !== 'darwin')('macOS stop switch kills a non-cooperating adapter inside sandbox-exec', async () => {
  const { root, adapterPath, item } = fixture();
  const stopFile = join(root, 'stop');
  writeFileSync(adapterPath, 'export async function run() { while (true) {} }');
  setTimeout(() => writeFileSync(stopFile, 'stop'), 100); // Source: 내부 문서 `sim-scenario-regression-load` §S; fixed macOS stop trigger.
  await expect(runRealTargetSandbox(item, { testRoot: root, adapterPath, writeAllowlist: [], timeoutMs: 2_000, stopFile })) // Source: 내부 문서 `sim-scenario-regression-load` §S; bounded macOS fallback deadline.
    .rejects.toThrow('stop switch');
});

test.skipIf(process.platform !== 'darwin')('macOS sandbox-exec blocks credential reads outside the test universe', async () => {
  const { adapterPath, item } = fixture();
  const secretRoot = mkdtempSync(join(tmpdir(), 'real-target-host-secret-'));
  roots.push(secretRoot);
  const secretPath = join(secretRoot, 'credential');
  writeFileSync(secretPath, 'HOST-CREDENTIAL-SENTINEL');
  writeFileSync(adapterPath, `import { readFileSync } from 'node:fs';
export async function run() {
  let blocked = false;
  try { readFileSync(${JSON.stringify(secretPath)}, 'utf8'); } catch { blocked = true; }
  return { pass: blocked, steps: [{ id: 'credential', outcome: String(blocked), invariant: 'pass', durationMs: null }], eventKinds: ['credential'] };
}`);
  const receipt = await runRealTargetSandbox(item, { adapterPath, writeAllowlist: [] });
  expect(receipt).toMatchObject({ pass: true, steps: [{ outcome: 'true' }] });
  expect(JSON.stringify(receipt)).not.toContain('HOST-CREDENTIAL-SENTINEL');
});

test('missing adapter or unsupported sandbox remains unmeasured before execution', async () => {
  const { root, adapterPath, item } = fixture();
  setTestStateRoot(root);
  await expect(createWorldRegressionTargetRunner().run(item, 'real')).rejects.toThrow('isolated worker is unavailable');
  await expect(runRealTargetSandbox(item, { adapterPath, writeAllowlist: [] }))
    .rejects.toThrow('isolated worker is unavailable');
  writeFileSync(adapterPath, 'export async function run() { throw new Error("must not run"); }');
  const foreignRoot = mkdtempSync(join(tmpdir(), 'real-target-foreign-'));
  roots.push(foreignRoot);
  await expect(runRealTargetSandbox(item, { testRoot: foreignRoot, adapterPath, writeAllowlist: [], timeoutMs: 500 })) // Source: 내부 문서 `sim-scenario-regression-load` §S; mismatched test universe refuses before execution.
    .rejects.toThrow('isolated worker is unavailable');
  await expect(runRealTargetSandbox(item, { testRoot: root, adapterPath, writeAllowlist: [], timeoutMs: 500, // Source: 내부 문서 `sim-scenario-regression-load` §S; bounded refusal fixture.
    platform: 'unsupported' })).rejects.toThrow('isolated worker is unavailable'); // Source: 내부 문서 `sim-scenario-regression-load` §S; unsupported OS refuses before the adapter.
});

test.skipIf(!linuxBwrapAvailable)('host Unix socket inside an allowed writable directory cannot delegate a forbidden write', async () => {
  const { root, allowed, adapterPath, item } = fixture();
  const socket = join(allowed, 'host-daemon.sock');
  const outside = join(root, 'daemon-wrote.txt');
  const server = createServer(() => writeFileSync(outside, 'escape'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  try {
    writeFileSync(adapterPath, `import { connect } from 'node:net';
export async function run() {
  const blocked = await new Promise(resolve => {
    const client = connect(${JSON.stringify(socket)}, () => { client.end(); resolve(false); });
    client.on('error', () => resolve(true));
  });
  return { pass: blocked, steps: [{ id: 'socket', outcome: String(blocked), invariant: 'pass', durationMs: null }], eventKinds: ['socket'] };
}`);
    const receipt = await runRealTargetSandbox(item, { adapterPath, writeAllowlist: [allowed] });
    expect(receipt.pass).toBe(true);
    expect(existsSync(outside)).toBe(false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test.skipIf(process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))('seccomp kills compat and x32 ABI calls before native socket matching', () => {
  const program = linuxSocketDenyFilter();
  const verdict = (arch: number, syscall: number): number => {
    let accumulator = 0;
    for (let pc = 0; pc < program.length / 8;) { // Source: Linux classic BPF uses 8-byte instructions.
      const offset = pc * 8;
      const code = program.readUInt16LE(offset);
      const value = program.readUInt32LE(offset + 4);
      if (code === 0x20) { accumulator = value === 4 ? arch : syscall; pc++; }
      else if (code === 0x15) pc += 1 + (accumulator === value ? program[offset + 2]! : program[offset + 3]!);
      else if (code === 0x35) pc += 1 + (accumulator >= value ? program[offset + 2]! : program[offset + 3]!);
      else if (code === 0x06) return value;
      else throw new Error(`unsupported BPF instruction ${code}`);
    }
    throw new Error('seccomp filter has no verdict');
  };
  const nativeArch = process.arch === 'x64' ? 0xc000003e : 0xc00000b7; // Source: Linux native audit architecture IDs.
  const nativeSocket = process.arch === 'x64' ? 41 : 198; // Source: Linux native socket syscall IDs.
  expect(verdict(nativeArch, nativeSocket)).toBe(0x00050001); // Source: SECCOMP_RET_ERRNO | EPERM.
  for (const ioUringSyscall of [425, 426, 427]) // Source: Linux io_uring_setup/enter/register syscall IDs.
    expect(verdict(nativeArch, ioUringSyscall)).toBe(0x00050001); // Source: io_uring socket bypass is denied.
  expect(verdict(nativeArch, nativeSocket + 1)).toBe(0x7fff0000); // Source: SECCOMP_RET_ALLOW.
  expect(verdict(nativeArch, nativeSocket | 0x40000000)).toBe(0x80000000); // Source: x32 syscall bit must kill.
  expect(verdict(0x40000003, 102)).toBe(0x80000000); // Source: i386 audit arch and socketcall ID must kill.
});

test.skipIf(!linuxBwrapAvailable || !existsSync('/usr/bin/python3'))('OS worker denies an io_uring setup syscall from an uncooperative adapter', async () => {
  const { adapterPath, item } = fixture();
  writeFileSync(adapterPath, `import { spawnSync } from 'node:child_process';
export async function run() {
  const probe = spawnSync('/usr/bin/python3', ['-c',
    'import ctypes; c=ctypes.CDLL(None,use_errno=True); c.syscall(425,1,0); print(ctypes.get_errno())'], { encoding: 'utf8' });
  const denied = probe.status === 0 && probe.stdout.trim() === '1';
  return { pass: denied, steps: [{ id: 'io-uring', outcome: String(denied), invariant: 'pass', durationMs: null }], eventKinds: ['io-uring'] };
}`);
  const receipt = await runRealTargetSandbox(item, { adapterPath, writeAllowlist: [] });
  expect(receipt).toMatchObject({ pass: true, steps: [{ outcome: 'true' }] });
});

test('sim suite CLI validates target guards and fails closed before world wiring', async () => {
  const root = mkdtempSync(join(tmpdir(), 'real-target-suite-cli-'));
  roots.push(root);
  setTestStateRoot(null);
  const adapterPath = join(root, 'adapter.mjs');
  const suite = join(root, 'suite');
  const caseDir = join(suite, 'incident');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(suite, 'suite.json'), JSON.stringify({ durationTolerancePercent: 10 })); // Source: regression suite fixture requires explicit tolerance.
  writeFileSync(join(caseDir, 'world.yaml'), 'world: incident\nseed: 1\ndevices: [fake-clock]\nevents: []\n');
  writeFileSync(join(caseDir, 'scenario.yaml'), 'world: incident\ntarget: real\nreal:\n  allowWrites: []\n  budget: { llmCalls: 0, wallClockMs: 0, externalWrites: 0 } # Source: fail-closed pre-wiring fixture.\n  syntheticMarker: true\n  stopFile: /test/stop\n  targets: []\nsteps: []\n');
  writeFileSync(adapterPath, `export async function run() { return { pass: true,
    steps: [{ id: 'real-worker', outcome: 'ran', invariant: 'pass', durationMs: null }], eventKinds: ['real-worker'] }; }`);
  process.env.ELANOUS_SIM_REAL_TARGET_ADAPTER = adapterPath;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const output: string[] = [];
  try {
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const omittedTargetProgram = new Command();
    registerSimCommands(omittedTargetProgram);
    await omittedTargetProgram.parseAsync(['node', 'test', 'sim', 'suite', suite]);
    expect(process.exitCode).toBe(2);
    expect(output.join('\n')).toContain('real scenario target requires an explicit --test universe');
    expect(existsSync(join(caseDir, 'baseline.real.json'))).toBe(false);
    setTestStateRoot(join(root, 'explicit-test-universe'));
    output.length = 0;
    process.exitCode = 0;
    const explicitTestProgram = new Command();
    registerSimCommands(explicitTestProgram);
    await explicitTestProgram.parseAsync(['node', 'test', 'sim', 'suite', suite]);
    expect(process.exitCode).toBe(2);
    expect(output.join('\n')).toContain('real scenario execution requires R-FRAG-2 world runner wiring');
    expect(existsSync(join(caseDir, 'baseline.real.json'))).toBe(false);
    setTestStateRoot(null);
    output.length = 0;
    process.exitCode = 0;
    const explicitSimProgram = new Command();
    registerSimCommands(explicitSimProgram);
    await explicitSimProgram.parseAsync(['node', 'test', 'sim', 'suite', suite, '--target', 'sim']);
    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toContain('"field":"baseline"');
    expect(output.join('\n')).not.toContain('real scenario execution requires R-FRAG-2 world runner wiring');
    expect(existsSync(join(caseDir, 'baseline.sim.json'))).toBe(false);
  } finally { console.log = originalLog; console.error = originalError; process.exitCode = originalExitCode ?? 0; }
});

test('macOS worker profile denies network, arbitrary writes, and detached children while allowing declared writes', () => {
  const profile = macRealTargetSandboxProfile(['/private/tmp/allowed'], ['/private/tmp/test-root']);
  expect(profile).toContain('(deny network*)');
  expect(profile).toContain('(deny file-read*)');
  expect(profile).toContain('(deny file-write*)');
  expect(profile).toContain('(deny process-fork)');
  expect(profile).toContain('(allow file-write* (subpath "/private/tmp/allowed"))');
  expect(profile).toContain('(allow file-read* (subpath "/private/tmp/test-root"))');
  expect(profile).not.toContain('(allow file-read* (subpath "/Users"))');
});

test.skipIf(process.platform !== 'linux')('network-only unshare cannot stand in for the write-enforcing bwrap worker', async () => {
  const { root, adapterPath, item } = fixture();
  const emptyPath = join(root, 'no-bwrap');
  mkdirSync(emptyPath);
  writeFileSync(adapterPath, 'export async function run() { throw new Error("must not run"); }');
  const priorPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    await expect(runRealTargetSandbox(item, { testRoot: root, adapterPath, writeAllowlist: [], timeoutMs: 500 })) // Source: 내부 문서 `sim-scenario-regression-load` §S; bounded no-bwrap refusal fixture.
      .rejects.toThrow('isolated worker is unavailable');
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  }
});
