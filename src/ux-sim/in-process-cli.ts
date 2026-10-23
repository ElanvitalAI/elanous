// S1 CLI simulation: invoke the registered Commander action in this process.
// The caller chooses a narrow command path; this is deliberately not a general
// replacement for the CLI process boundary (signals, startup, and PTY need S2).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';

export interface InProcessCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stateRoot: string;
}

export interface InProcessCliOptions {
  /** Exact command paths allowed by the caller. Default: the read-only `where` command. */
  readonly allowPaths?: readonly (readonly string[])[];
  /**
   * Caller-owned isolated state root reused across turns (a device that needs the
   * same config store and audit ledger for a set → history → revert round trip).
   * The caller owns cleanup; without this option each turn gets its own temp root.
   */
  readonly stateRoot?: string;
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

// process.argv, stdio and Commander are singletons. Only one simulated turn
// may own them; callers never have to coordinate this themselves.
let previous: Promise<void> = Promise.resolve();

export async function simInProcessCli(args: readonly string[], options: InProcessCliOptions = {}): Promise<InProcessCliResult> {
  const allowed = options.allowPaths ?? [['where']];
  // Reject unmatched prefixes before touching singleton process state. The
  // registered tree below resolves the exact command, leaving positionals out.
  if (!allowed.some((entry) => entry.length > 0 && entry.every((part, index) => part === args[index]))) {
    throw new Error(`in-process CLI command not allowed: ${args.join(' ') || '(empty)'}`);
  }
  if (args.some((arg) => arg === '--test' || arg.startsWith('--test=') || arg === '--config-dir' || arg.startsWith('--config-dir=') || arg === '--test-state-dir' || arg.startsWith('--test-state-dir='))) {
    throw new Error('in-process CLI owns its isolated state root; do not pass root flags');
  }

  const turn = previous;
  let release!: () => void;
  previous = new Promise<void>((resolve) => { release = resolve; });
  await turn;
  try {
    const ownsStateRoot = options.stateRoot === undefined;
    const stateRoot = options.stateRoot ?? mkdtempSync(join(tmpdir(), 'ux-sim-cli-'));
    const oldStateEnv = process.env.ELANOUS_STATE_DIR;
    const oldConfigRoot = getElanousConfigDirOverride();
    const oldTestRoot = getTestStateRoot();
    const oldArgv = process.argv;
    const oldExitCode = process.exitCode;
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
    try {
      process.env.ELANOUS_STATE_DIR = stateRoot;
      setTestStateRoot(stateRoot);
      setElanousConfigDir(stateRoot);
      process.argv = ['bun', 'elanous', ...args];
      process.exitCode = 0;
      // Import after selecting the test universe: some CLI modules resolve
      // paths at module initialization. This is the real registered CLI tree.
      const { program } = await import('../index.js');
      const command = program as unknown as MutableCommand & {
        exitOverride: () => void;
        _exitCallback?: (error: unknown) => void;
      };
      const path = registeredCommandPath(command, args);
      if (path.length === 0 || !allowed.some((entry) => entry.length === path.length && entry.every((part, index) => part === path[index]))) {
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
        await program.parseAsync(['bun', 'elanous', ...args]);
        exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      } catch (error) {
        if (error instanceof SimulatedExit) exitCode = error.code;
        else if (error && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number') exitCode = error.exitCode;
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
      process.exitCode = oldExitCode;
      if (oldStateEnv === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateEnv;
      setTestStateRoot(oldTestRoot ?? null);
      if (oldConfigRoot === undefined) resetElanousConfigDir();
      else setElanousConfigDir(oldConfigRoot);
      if (ownsStateRoot) rmSync(stateRoot, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}
