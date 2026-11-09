// S1 CLI simulation: invoke the registered Commander action in this process.
// The caller chooses a narrow command path; this is deliberately not a general
// replacement for the CLI process boundary (signals, startup, and PTY need S2).
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { format } from 'node:util';
import { spawnElanous } from '../instance/spawn-elanous.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { recordCliChildEvent } from './in-process-cli-539-file-adoption-sim.js';

export interface InProcessCliResult {
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stateRoot: string;
}

export interface InProcessCliOptions {
  /** Explicit process boundary for the one entrypoint-wiring E2E. Default is in-process. */
  readonly mode?: 'in-process' | 'spawn';
  /** Spawn mode only: a bootstrap wrapper that imports the real CLI entrypoint. */
  readonly entrypoint?: string;
  /** Spawn mode only: allow isolated ELANOUS_* roots to select a light route without a leading --test flag. */
  readonly injectTestFlag?: boolean;
  /** Optional exact command paths allowed by the caller; omitted paths use the safe read-only defaults. */
  readonly allowPaths?: readonly (readonly string[])[];
  /**
   * Caller-owned isolated state root reused across turns (a device that needs the
   * same config store and audit ledger for a set → history → revert round trip).
   * The caller owns cleanup; without this option each turn gets its own temp root.
   */
  readonly stateRoot?: string;
  /** Isolated process cwd. Defaults to the repository root containing this helper. */
  readonly cwd?: string;
  /** Explicit environment overrides; inherited ELANOUS_* values are cleared first. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Selected config root when it differs from the isolated state root. */
  readonly configRoot?: string;
  /** Spawn mode only. */
  readonly timeoutMs?: number;
  /** Spawn mode only: let a process-boundary E2E observe and stop a long-running CLI. */
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string) => void;
  /** Spawn mode only: direct stdout to a file for an independent byte baseline. */
  readonly stdoutFile?: string;
  /** Test seam run inside the isolated turn before CLI parsing, for observing environment boundaries. */
  readonly beforeParse?: () => void;
  /** Test seam run after the registered command returns, to exercise restoration after command side effects. */
  readonly afterDispatch?: () => void;
  /** Spawn mode only; mirrors the process-tree timeout used by Bun's E2E runner. */
  readonly killSignal?: NodeJS.Signals;
  /** Spawn mode only. Disable detachment when the CLI contract observes its parent process group. */
  readonly detached?: boolean;
}

const REPO_ROOT = resolve(import.meta.dir, '../..');
const DEFAULT_ALLOWED_PATHS: readonly (readonly string[])[] = [[], ['where'], ['help']];

interface RootFlags { readonly args: readonly string[]; readonly selectorArgs: readonly string[]; readonly stateRoot?: string; readonly configRoot?: string; readonly hasStateFlag: boolean }

function rootFlags(args: readonly string[]): RootFlags {
  const commandArgs: string[] = [];
  const selectorArgs: string[] = [];
  let stateRoot: string | undefined;
  let configRoot: string | undefined;
  let hasStateFlag = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--test') {
      hasStateFlag = true;
      const value = args[index + 1];
      if (value && !value.startsWith('-') && (value.startsWith('/') || value.startsWith('./') || value.startsWith('../'))) {
        stateRoot = value;
        index += 1;
      }
      continue;
    }
    if (arg === '--test-state-dir' || arg.startsWith('--test=') || arg.startsWith('--test-state-dir=')) {
      hasStateFlag = true;
      const [, inline] = arg.split('=', 2);
      const value = inline ?? (arg === '--test-state-dir' ? args[index + 1] : undefined);
      if (inline === undefined && arg === '--test-state-dir' && value !== undefined && !value.startsWith('-')) index += 1;
      if (value && !value.startsWith('-')) stateRoot = value;
      commandArgs.push(arg);
      if (inline === undefined && value && !value.startsWith('-')) commandArgs.push(value);
      continue;
    }
    if (arg === '--config-dir' || arg.startsWith('--config-dir=')) {
      const [, inline] = arg.split('=', 2);
      const value = inline ?? args[index + 1];
      if (inline === undefined && value !== undefined && !value.startsWith('-')) index += 1;
      if (value && !value.startsWith('-')) configRoot = value;
      commandArgs.push(arg);
      if (inline === undefined && value && !value.startsWith('-')) commandArgs.push(value);
      continue;
    }
    commandArgs.push(arg);
    selectorArgs.push(arg);
  }
  return { args: commandArgs, selectorArgs, stateRoot, configRoot, hasStateFlag };
}

/** The single test-facing CLI entry: in-process by default, process boundary only by opt-in. */
export async function simCli(args: readonly string[], options: InProcessCliOptions = {}): Promise<InProcessCliResult> {
  const requested = options.allowPaths ?? DEFAULT_ALLOWED_PATHS;
  const selector = rootFlags(args).selectorArgs.filter((arg) => !arg.startsWith('-'));
  const requestedPath = selector[0] === 'help' && selector[1] ? selector.slice(1, 2) : selector.slice(0, 3);
  if (!requested.some((entry) => entry.length === 0
    ? requestedPath.length === 0
    : entry.every((part, index) => part === requestedPath[index]))) {
    throw new Error(`CLI command not allowed: ${args.join(' ') || '(empty)'}`);
  }
  if (options.mode !== 'spawn') {
    if (options.timeoutMs !== undefined || options.signal !== undefined || options.killSignal !== undefined || options.detached !== undefined || options.onStdout !== undefined || options.stdoutFile !== undefined || options.entrypoint !== undefined || options.injectTestFlag !== undefined) {
      throw new Error('timeout, abort, output callbacks and entrypoint overrides require mode: spawn');
    }
    return runInProcessCli(args, options);
  }
  const roots = rootFlags(args);
  const ownsStateRoot = options.stateRoot === undefined && roots.stateRoot === undefined;
  const stateRoot = options.stateRoot ?? roots.stateRoot ?? mkdtempSync(join(tmpdir(), 'ux-sim-cli-spawn-'));
  const configRoot = options.configRoot ?? roots.configRoot ?? stateRoot;
  const cwd = options.cwd ?? REPO_ROOT;
  const env = isolatedEnvironment(stateRoot, options.env);
  if (options.stdoutFile !== undefined && options.onStdout !== undefined) throw new Error('stdoutFile and onStdout are mutually exclusive');
  try {
    const entry = options.entrypoint ?? join(REPO_ROOT, 'bin/elanous.mjs');
  const normalizedArgs = roots.hasStateFlag ? normalizeTestArgs(args)
    : options.injectTestFlag === false ? [...args] : [`--test=${stateRoot}`, ...args];
  const needsConfigFlag = roots.configRoot === undefined && configRoot !== stateRoot;
  const cliArgs = needsConfigFlag ? ['--config-dir', configRoot, ...normalizedArgs] : normalizedArgs;
    return await new Promise<InProcessCliResult>((resolveResult) => {
      const outputFd = options.stdoutFile === undefined ? undefined : openSync(options.stdoutFile, 'w');
      let outputClosed = false;
      const closeOutput = () => {
        if (outputFd === undefined || outputClosed) return;
        outputClosed = true;
        closeSync(outputFd);
      };
      const child = spawnElanous(cliArgs, {
        bin: entry, stateDir: stateRoot, cwd, env, stdio: ['ignore', outputFd ?? 'pipe', 'pipe'],
        detached: options.detached ?? process.platform !== 'win32',
      });
      recordCliChildEvent('child-started', child.pid);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let childFinished = false;
      const recordChildFinished = (detail: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean }) => {
        if (childFinished) return;
        childFinished = true;
        recordCliChildEvent('child-closed', child.pid, detail);
      };
      let timeoutKillTimer: ReturnType<typeof setTimeout> | undefined;
      const killChild = () => {
        const signal = options.killSignal ?? 'SIGTERM';
        try {
          if (process.platform !== 'win32' && child.pid && options.detached !== false) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* the process may have exited between the check and signal */ }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
        timeoutKillTimer = setTimeout(() => {
          try {
            if (process.platform !== 'win32' && child.pid && options.detached !== false) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch { /* process already exited */ }
        }, 250);
        timeoutKillTimer.unref();
      }, options.timeoutMs ?? 30_000);
      timer.unref();
      const abort = killChild;
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        options.onStdout?.(chunk.toString('utf8'));
      });
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
        options.signal?.removeEventListener('abort', abort);
        closeOutput();
        resolveResult({ exitCode: 1, signal: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `${Buffer.concat(stderr).toString('utf8')}${String(error)}`, stateRoot });
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
        options.signal?.removeEventListener('abort', abort);
        closeOutput();
        recordChildFinished({ exitCode: code, signal, timedOut });
        const diagnostic = timedOut ? `\nCLI spawn timed out after ${options.timeoutMs ?? 30_000}ms` : '';
        resolveResult({ exitCode: code ?? 1, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `${Buffer.concat(stderr).toString('utf8')}${diagnostic}`, stateRoot });
      });
    });
  } finally {
    if (ownsStateRoot) rmSync(stateRoot, { recursive: true, force: true });
  }
}

function normalizeTestArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === '--test' && value && !value.startsWith('-') && (value.startsWith('/') || value.startsWith('./') || value.startsWith('../'))) {
      normalized.push(`--test=${value}`);
      index += 1;
    } else normalized.push(arg);
  }
  return normalized;
}

function isolatedEnvironment(
  stateRoot: string,
  overrides: InProcessCliOptions['env'] = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ELANOUS_')) delete env[key];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  env.ELANOUS_STATE_DIR = stateRoot;
  env.ELANOUS_STATE_DIR_SOURCE = 'derived';
  return env;
}

type MutableCommand = {
  commands: MutableCommand[];
  name(): string;
  aliases(): string[];
  _optionValues?: Record<string, unknown>;
  _optionValueSources?: Record<string, string>;
  args: string[];
  rawArgs?: string[];
  processedArgs?: unknown[];
};

function registeredCommandPath(root: MutableCommand, args: readonly string[]): string[] {
  const path: string[] = [];
  let command = root;
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    const child = command.commands.find((candidate) => candidate.name() === arg || candidate.aliases().includes(arg));
    if (!child) break;
    path.push(arg);
    command = child;
  }
  return path;
}

function snapshotCommands(root: MutableCommand): () => void {
  const snapshots: Array<{ command: MutableCommand; values: Record<string, unknown> | undefined; sources: Record<string, string> | undefined; args: string[]; rawArgs: string[] | undefined; processedArgs: unknown[] | undefined }> = [];
  const visit = (command: MutableCommand): void => {
    snapshots.push({
      command,
      values: command._optionValues ? { ...command._optionValues } : undefined,
      sources: command._optionValueSources ? { ...command._optionValueSources } : undefined,
      args: [...command.args],
      rawArgs: command.rawArgs ? [...command.rawArgs] : undefined,
      processedArgs: command.processedArgs ? [...command.processedArgs] : undefined,
    });
    command.commands.forEach(visit);
  };
  visit(root);
  return () => {
    for (const item of snapshots) {
      item.command._optionValues = item.values;
      item.command._optionValueSources = item.sources;
      item.command.args = item.args;
      item.command.rawArgs = item.rawArgs;
      item.command.processedArgs = item.processedArgs;
    }
  };
}

class SimulatedExit extends Error {
  constructor(readonly code: number) { super(`CLI exit ${code}`); }
}

// process.argv, stdio and Commander are singletons. Calls through simCli are
// serialized; tests that mutate these globals outside simCli must not run
// concurrently with a simulated turn.
let previous: Promise<void> = Promise.resolve();

async function runInProcessCli(args: readonly string[], options: InProcessCliOptions = {}): Promise<InProcessCliResult> {
  const roots = rootFlags(args);
  if (roots.configRoot && options.configRoot === undefined) {
    const fromTemp = relative(tmpdir(), resolve(roots.configRoot));
    if (fromTemp === '..' || fromTemp.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromTemp)) {
      throw new Error(`in-process CLI config directory must stay under the temporary test root: ${roots.configRoot}`);
    }
  }
  const commandArgs: string[] = [];
  for (let index = 0; index < roots.args.length; index += 1) {
    const arg = roots.args[index]!;
    if (arg === '--test') continue;
    if (arg === '--test-state-dir' || arg === '--config-dir') {
      if (roots.args[index + 1] && !roots.args[index + 1]!.startsWith('-')) index += 1;
      continue;
    }
    if (arg.startsWith('--test=') || arg.startsWith('--test-state-dir=') || arg.startsWith('--config-dir=')) continue;
    commandArgs.push(arg);
  }
  const allowed = options.allowPaths ?? DEFAULT_ALLOWED_PATHS;
  // Reject unmatched prefixes before touching singleton process state. The
  // registered tree below resolves the exact command, leaving positionals out.
  if (allowed && !allowed.some((entry) => entry.every((part, index) => part === commandArgs[index]))) {
    throw new Error(`in-process CLI command not allowed: ${args.join(' ') || '(empty)'}`);
  }
  const turn = previous;
  let release!: () => void;
  previous = new Promise<void>((resolve) => { release = resolve; });
  await turn;
  try {
    const ownsStateRoot = options.stateRoot === undefined && roots.stateRoot === undefined;
    const stateRoot = options.stateRoot ?? roots.stateRoot ?? mkdtempSync(join(tmpdir(), 'ux-sim-cli-'));
    const configRoot = options.configRoot ?? roots.configRoot ?? stateRoot;
    const oldEnv = { ...process.env };
    const oldConfigRoot = getElanousConfigDirOverride();
    const oldTestRoot = getTestStateRoot();
    const oldArgv = process.argv;
    const oldExitCode = process.exitCode;
    const oldCwd = process.cwd();
    const oldExit = process.exit;
    const oldStdout = process.stdout.write;
    const oldStderr = process.stderr.write;
    const oldConsoleLog = console.log;
    const oldConsoleInfo = console.info;
    const oldConsoleWarn = console.warn;
    const oldConsoleError = console.error;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let restoreCommand: (() => void) | undefined;
    let exitCode = 0;
    const isolatedEnv = isolatedEnvironment(stateRoot, options.env);
    try {
      for (const key of Object.keys(process.env)) if (key.startsWith('ELANOUS_')) delete process.env[key];
      for (const [key, value] of Object.entries(options.env ?? {})) if (value === undefined) delete process.env[key];
      Object.assign(process.env, isolatedEnv);
      setTestStateRoot(stateRoot);
      setElanousConfigDir(configRoot);
      process.chdir(options.cwd ?? REPO_ROOT);
      process.argv = [process.execPath, join(REPO_ROOT, 'bin/elanous.mjs'), ...commandArgs];
      process.exitCode = 0;
      options.beforeParse?.();
      // Import after selecting the test universe: some CLI modules resolve
      // paths at module initialization. This is the real registered CLI tree.
      const { program } = await import('../index.js');
      const command = program as unknown as MutableCommand & {
        exitOverride: () => void;
        _exitCallback?: (error: unknown) => void;
      };
      const path = registeredCommandPath(command, commandArgs);
      if (allowed && !allowed.some((entry) => entry.length === path.length && entry.every((part, index) => part === path[index]))) {
        throw new Error(`in-process CLI command not allowed: ${path.join(' ') || '(empty)'}`);
      }
      restoreCommand = snapshotCommands(command);
      const oldExitCallback = command._exitCallback;
      command.exitOverride();
      // A real stream eventually calls every write callback; writeStdoutJson and
      // writeStdoutFully await it. The simulated stream completes callbacks
      // synchronously so those CLI actions return and release the serialized
      // turn queue.
      type WriteCallback = (error?: Error | null) => void;
      const capture = (parts: string[], chunk: string | Uint8Array, callbacks: readonly WriteCallback[]): boolean => {
        parts.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        for (const callback of callbacks) callback();
        return true;
      };
      const simulateWrite = (parts: string[]) => (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
        const callbacks = [encodingOrCallback, callback].filter((candidate): candidate is WriteCallback => typeof candidate === 'function');
        return capture(parts, chunk, callbacks);
      };
      process.stdout.write = simulateWrite(stdout) as typeof process.stdout.write;
      process.stderr.write = simulateWrite(stderr) as typeof process.stderr.write;
      console.log = (...items: unknown[]) => { stdout.push(format(...items) + '\n'); };
      console.info = (...items: unknown[]) => { stdout.push(format(...items) + '\n'); };
      console.warn = (...items: unknown[]) => { stderr.push(format(...items) + '\n'); };
      console.error = (...items: unknown[]) => { stderr.push(format(...items) + '\n'); };
      process.exit = ((code?: number) => { throw new SimulatedExit(code ?? 0); }) as typeof process.exit;
      try {
        await program.parseAsync(['bun', 'elanous', ...commandArgs]);
        options.afterDispatch?.();
        exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      } catch (error) {
        if (error instanceof SimulatedExit) exitCode = error.code;
        else if (error && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number') exitCode = error.exitCode;
        else if (error instanceof Error) { stderr.push(`${error.message}\n`); exitCode = 1; }
        else throw error;
      } finally {
        command._exitCallback = oldExitCallback;
      }
      return { exitCode, stdout: stdout.join(''), stderr: stderr.join(''), stateRoot };
    } finally {
      process.exit = oldExit;
      process.stdout.write = oldStdout;
      process.stderr.write = oldStderr;
      console.log = oldConsoleLog;
      console.info = oldConsoleInfo;
      console.warn = oldConsoleWarn;
      console.error = oldConsoleError;
      restoreCommand?.();
      process.argv = oldArgv;
      process.exitCode = oldExitCode ?? 0;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, oldEnv);
      process.chdir(oldCwd);
      setTestStateRoot(oldTestRoot ?? null);
      if (oldConfigRoot === undefined) resetElanousConfigDir();
      else setElanousConfigDir(oldConfigRoot);
      if (ownsStateRoot) rmSync(stateRoot, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}
