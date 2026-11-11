import { accessSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getTestStateRoot } from '../nexus/paths.js';
import type { SuiteCase, SuiteReceipt } from './world.js';

const UNAVAILABLE = 'real target is unmeasured: isolated worker is unavailable';
const DEFAULT_TIMEOUT_MS = 30_000; // Source: 내부 문서 `sim-scenario-regression-load` §S; real-target worker must have a finite parent deadline.
const MAX_TIMEOUT_MS = 120_000; // Source: 내부 문서 `sim-scenario-regression-load` §S; cap configured real-target wall time.
const MAX_OUTPUT_BYTES = 1_000_000; // Source: 내부 문서 `sim-scenario-regression-load` §S; bound untrusted adapter output at the parent.
const STOP_POLL_MS = 25; // Source: 내부 문서 `sim-scenario-regression-load` §S; parent-side stop switch polling interval.

export interface RealTargetSandboxOptions {
  readonly testRoot?: string;
  readonly adapterPath?: string;
  readonly writeAllowlist?: readonly string[];
  readonly timeoutMs?: number;
  readonly stopFile?: string;
  readonly platform?: NodeJS.Platform | 'unsupported';
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink()) throw new Error('real target write allowlist needs owned directories');
  const physical = realpathSync(path);
  if (!lstatSync(physical).isDirectory() || physical === '/')
    throw new Error('real target write allowlist needs owned directories');
  return physical;
}

function executableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      const physical = realpathSync(candidate);
      const stat = statSync(physical);
      if (stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0) return physical; // Source: OS sandbox launcher must be root-owned and not writable by group/others.
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

function macPath(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The macOS policy limits reads to system runtime and declared test inputs. */
export function macRealTargetSandboxProfile(writePaths: readonly string[], readPaths: readonly string[] = []): string {
  return `(version 1)(allow default)(deny network*)(deny file-read*)(deny file-write*)(deny process-fork)`
    + [...readPaths, ...writePaths].map((path) => `(allow file-read* (subpath ${macPath(path)}))`).join('')
    + writePaths.map((path) => `(allow file-write* (subpath ${macPath(path)}))`).join('');
}

export function linuxSocketDenyFilter(): Buffer {
  const syscall = process.arch === 'x64' ? 41 : process.arch === 'arm64' ? 198 : undefined; // Source: Linux x86_64/aarch64 socket syscall numbers.
  const auditArch = process.arch === 'x64' ? 0xc000003e : process.arch === 'arm64' ? 0xc00000b7 : undefined; // Source: Linux AUDIT_ARCH_X86_64/AARCH64 constants.
  if (syscall === undefined || auditArch === undefined) throw new Error(UNAVAILABLE);
  const bytes = Buffer.alloc(96); // Source: twelve 8-byte Linux sock_filter instructions.
  const instruction = (index: number, code: number, jumpTrue: number, jumpFalse: number, value: number) => {
    const offset = index * 8;
    bytes.writeUInt16LE(code, offset); bytes.writeUInt8(jumpTrue, offset + 2);
    bytes.writeUInt8(jumpFalse, offset + 3); bytes.writeUInt32LE(value, offset + 4);
  };
  instruction(0, 0x20, 0, 0, 4); // Source: seccomp_data.arch is at offset 4.
  instruction(1, 0x15, 1, 0, auditArch); // Source: native ABI skips the kill instruction.
  instruction(2, 0x06, 0, 0, 0x80000000); // Source: SECCOMP_RET_KILL_PROCESS refuses compat architectures.
  instruction(3, 0x20, 0, 0, 0); // Source: seccomp_data.nr is at offset 0.
  instruction(4, 0x35, 0, 1, 0x40000000); // Source: x32 syscalls carry __X32_SYSCALL_BIT.
  instruction(5, 0x06, 0, 0, 0x80000000); // Source: x32 ABI cannot bypass native socket denial.
  instruction(6, 0x15, 4, 0, syscall); // Source: native socket syscall jumps to EPERM.
  instruction(7, 0x15, 3, 0, 425); // Source: Linux io_uring_setup can create socket operations.
  instruction(8, 0x15, 2, 0, 426); // Source: Linux io_uring_enter can submit socket operations.
  instruction(9, 0x15, 1, 0, 427); // Source: Linux io_uring_register can supply file descriptors.
  instruction(10, 0x06, 0, 0, 0x7fff0000); // Source: SECCOMP_RET_ALLOW permits other native syscalls.
  instruction(11, 0x06, 0, 0, 0x00050001); // Source: SECCOMP_RET_ERRNO | EPERM blocks socket and io_uring.
  return bytes;
}

function osCommand(input: { platform: NodeJS.Platform | 'unsupported'; root: string; scratch: string; writes: readonly string[]; worker: string }):
  { command: string; args: string[]; cwd: string; seccomp: boolean } {
  if (input.platform === 'darwin') {
    const command = '/usr/bin/sandbox-exec';
    try { accessSync(command, fsConstants.X_OK); } catch { throw new Error(UNAVAILABLE); }
    return { command, args: ['-p', macRealTargetSandboxProfile([input.scratch, ...input.writes],
      ['/System', '/usr/lib', '/usr/bin', process.execPath, input.worker, input.root]),
      process.execPath, input.worker], cwd: process.cwd(), seccomp: false };
  }
  if (input.platform !== 'linux') throw new Error(UNAVAILABLE);
  // `unshare -rn` from SIM-NETZERO-LINUX protects the network only. Real targets require the
  // same bwrap network namespace plus a read-only root and explicit writable bind mounts.
  const bwrap = executableOnPath('bwrap');
  if (!bwrap) throw new Error(UNAVAILABLE);
  // Source: bwrap mounts a fresh root; seccomp denies sockets even inside declared writable mounts.
  // Only the runtime, worker and declared test root are readable; no host root is mounted.
  const rootView = ['--unshare-net', '--unshare-pid', '--as-pid-1', '--tmpfs', '/', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--ro-bind', process.execPath, process.execPath, '--ro-bind', input.worker, input.worker,
    '--ro-bind', input.root, input.root, '--dev', '/dev', '--proc', '/proc'];
  return { command: bwrap, args: ['--die-with-parent', ...rootView,
    '--bind', input.scratch, input.scratch,
    ...input.writes.flatMap((path) => ['--bind', path, path]),
    '--remount-ro', '/', '--seccomp', '3',
    '--chdir', '/', process.execPath, input.worker], cwd: '/', seccomp: true };
}

function validatedReceipt(value: unknown): SuiteReceipt {
  const row = value as Partial<SuiteReceipt> | null;
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.pass !== 'boolean'
    || !Array.isArray(row.steps) || !Array.isArray(row.eventKinds)
    || row.eventKinds.some((kind) => typeof kind !== 'string' || !kind.trim())
    || row.steps.some((step) => !step || typeof step.id !== 'string' || !step.id.trim()
      || typeof step.outcome !== 'string' || typeof step.invariant !== 'string'
      || (step.durationMs !== null && (typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs)
        || step.durationMs < 0)))) throw new Error('real target worker returned invalid receipt');
  return row as SuiteReceipt;
}

function envAllowlist(): readonly string[] {
  const raw = process.env.ELANOUS_SIM_REAL_TARGET_WRITE_ALLOWLIST;
  if (raw === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('real target write allowlist is invalid'); }
  if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== 'string'))
    throw new Error('real target write allowlist is invalid');
  return parsed;
}

/** Parent-owned OS worker boundary. Adapter code receives no control handle for deadline, stop, or mounts. */
export async function runRealTargetSandbox(item: SuiteCase, options: RealTargetSandboxOptions = {}): Promise<SuiteReceipt> {
  const declaredRoot = getTestStateRoot();
  const rootInput = options.testRoot ?? declaredRoot;
  const adapterInput = options.adapterPath ?? process.env.ELANOUS_SIM_REAL_TARGET_ADAPTER;
  if (!declaredRoot || !rootInput || !adapterInput) throw new Error(UNAVAILABLE);
  const root = canonicalDirectory(rootInput);
  if (root !== canonicalDirectory(declaredRoot)) throw new Error(UNAVAILABLE);
  let adapterPath: string;
  try {
    if (!isAbsolute(adapterInput) || lstatSync(adapterInput).isSymbolicLink()) throw new Error(UNAVAILABLE);
    adapterPath = realpathSync(adapterInput);
    if (!lstatSync(adapterPath).isFile() || !contained(root, adapterPath)) throw new Error(UNAVAILABLE);
  } catch { throw new Error(UNAVAILABLE); }
  for (const inputPath of [item.worldFile, item.scenarioFile]) {
    try {
      if (!isAbsolute(inputPath) || lstatSync(inputPath).isSymbolicLink() || !contained(root, realpathSync(inputPath))
        || !lstatSync(inputPath).isFile()) throw new Error(UNAVAILABLE);
    } catch { throw new Error(UNAVAILABLE); }
  }
  const writes = [...new Set((options.writeAllowlist ?? envAllowlist()).map(canonicalDirectory))];
  const stopInput = options.stopFile ?? process.env.ELANOUS_SIM_REAL_TARGET_STOP_FILE;
  if (stopInput && !isAbsolute(stopInput)) throw new Error('real target stop switch path is invalid');
  const stopFile = stopInput ? join(realpathSync(dirname(stopInput)), basename(stopInput)) : undefined;
  if (stopFile && !contained(root, stopFile)) throw new Error('real target stop switch path is invalid');
  if (stopFile && writes.some((path) => contained(path, stopFile))) throw new Error('real target stop switch must stay outside writable mounts');
  if (stopFile && existsSync(stopFile)) throw new Error('real target stop switch active');
  const timeoutMs = options.timeoutMs ?? (process.env.ELANOUS_SIM_REAL_TARGET_TIMEOUT_MS === undefined
    ? DEFAULT_TIMEOUT_MS : Number(process.env.ELANOUS_SIM_REAL_TARGET_TIMEOUT_MS));
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
    throw new Error('real target time limit is invalid');
  const scratch = mkdtempSync(join(root, '.real-target-worker-'));
  const worker = resolve(import.meta.dir, '../../scripts/sim-real-target-worker.ts');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    ELANOUS_SIM_REAL_TARGET_OS_SANDBOXED: '1', ELANOUS_SIM_REAL_TARGET_ADAPTER: adapterPath,
    ELANOUS_SIM_REAL_TARGET_ITEM: JSON.stringify(item) };
  try {
    const { command, args, cwd, seccomp } = osCommand({ platform: options.platform ?? process.platform, root, scratch, writes, worker });
    const filterPath = join(scratch, 'socket-deny.bpf');
    if (seccomp) writeFileSync(filterPath, linuxSocketDenyFilter(), { mode: 0o600 });
    return await new Promise<SuiteReceipt>((resolveResult, rejectResult) => {
      const filterFd = seccomp ? openSync(filterPath, 'r') : undefined;
      let child;
      try { child = spawn(command, args, { cwd, env, detached: true,
        stdio: seccomp ? ['ignore', 'pipe', 'pipe', filterFd!] : ['ignore', 'pipe', 'pipe'] }); }
      finally { if (filterFd !== undefined) closeSync(filterFd); }
      let output = '';
      let abortReason: string | undefined;
      let settled = false;
      const kill = (reason: string) => {
        if (abortReason || settled) return;
        abortReason = reason;
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill('real target time limit exceeded'), timeoutMs);
      const stopPoll = stopFile ? setInterval(() => { if (existsSync(stopFile)) kill('real target stop switch active'); }, STOP_POLL_MS) : undefined;
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) kill('real target output limit exceeded');
      });
      child.stderr?.on('data', () => { /* Never relay untrusted adapter output or secret-like errors. */ });
      child.on('error', () => kill(UNAVAILABLE));
      child.on('close', (status) => {
        settled = true;
        clearTimeout(timer);
        if (stopPoll) clearInterval(stopPoll);
        if (abortReason) { rejectResult(new Error(abortReason)); return; }
        if (status !== 0) { rejectResult(new Error(UNAVAILABLE)); return; }
        try { resolveResult(validatedReceipt(JSON.parse(output))); }
        catch { rejectResult(new Error('real target worker returned invalid receipt')); }
      });
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
