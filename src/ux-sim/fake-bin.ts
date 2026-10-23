// Fake executables on PATH for tests whose code under test spawns an external CLI
// (grok · magick · tesseract · …) that a gate Pod does not have.
//
// The industry-standard shape is a «PATH shim»: a tiny shell script with the real
// name, placed first on PATH. This module only makes that shape shared, so tests
// stop hand-writing `writeFileSync + chmodSync` (MOCK-REVIEW R6 · MOCK-DEVICES-2 ⓑ).
//
// Bun resolves a child's executable from the PATH the process STARTED with when the
// call passes no `env`; `test/preload-child-env.ts` makes a later PATH change visible
// to such calls. Code that passes its own `env` must receive `fakeBins.env` (or a
// PATH built from `fakeBins.path()`).
//
// ⛔ This is not a simulator of the real tool: a spec only fixes stdout · stderr ·
// exit code · lifetime, and records argv. Behaviour of the real tool stays with
// tests that run where the tool exists.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface FakeBinSpec {
  readonly stdout?: string;
  readonly stderr?: string;
  /** Exit code (default 0). */
  readonly exitCode?: number;
  /** Stay alive this long before exiting — for long-running daemons a test kills, or a fractional
   *  per-call latency (e.g. 0.2) for a test that measures fan-out. */
  readonly sleepSeconds?: number;
  /**
   * Fake only the calls whose argv starts with these words (e.g. `['worktree', 'add']`);
   * every other call `exec`s `otherwise` with the same argv. Needs `otherwise`.
   */
  readonly whenArgsStartWith?: readonly string[];
  /** Absolute path of the real executable that serves the calls `whenArgsStartWith` does not match. */
  readonly otherwise?: string;
  /**
   * After stdout/stderr (and any sleep), the fake kills itself with this signal instead of exiting —
   * a «died without a word» failure (`status` null · `signal` set). `exitCode` is then never reached.
   */
  readonly killSignal?: 'KILL' | 'TERM' | 'INT' | 'HUP' | 'ABRT' | 'SEGV';
  /**
   * Be the util-linux `script -q -e -c` PTY allocator itself: record the call, then `exec` the real
   * util-linux `script` with the same argv. A test that spawns `sh -c 'script -q -e -c "$1" …'`
   * then gets a real TTY (so `process.stdin.isTTY` is true inside the child) and the recording proves
   * the PTY came from util-linux, not from a hand-rolled shim. Requires util-linux on PATH
   * (`utilLinuxScript()`); incompatible with the output-faking fields below.
   */
  readonly pty?: boolean;
}

export interface FakeBinCall {
  readonly name: string;
  readonly argv: readonly string[];
}

export interface FakeBins {
  /** Directory holding the fake executables. */
  readonly dir: string;
  /** Absolute path of one fake executable. */
  bin(name: string): string;
  /** PATH with the fake directory first (default base: the current PATH). */
  path(base?: string): string;
  /** `process.env` with the fake PATH, for code that passes its own `env`. */
  readonly env: NodeJS.ProcessEnv;
  /** Every recorded invocation, in order. */
  calls(): FakeBinCall[];
  /** Resolve once at least `count` invocations are recorded (a spawned child records asynchronously). */
  waitForCalls(count: number, timeoutMs?: number): Promise<FakeBinCall[]>;
  cleanup(): void;
}

const NAME = /^[A-Za-z0-9._+-]+$/;
const KILL_SIGNALS: ReadonlySet<string> = new Set(['KILL', 'TERM', 'INT', 'HUP', 'ABRT', 'SEGV']);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let utilLinuxScriptCache: string | null | undefined;

/**
 * Absolute path of the util-linux `script` on PATH, or `null` when this host has none
 * (macOS ships BSD `script`, whose `-q -e -c` flags differ — see `firstRunPtySupport()`).
 * Probed once per process: `<path>/script --version` must answer `util-linux`.
 */
export function utilLinuxScript(): string | null {
  if (utilLinuxScriptCache !== undefined) return utilLinuxScriptCache;
  utilLinuxScriptCache = null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'script');
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    if (probe.status === 0 && `${probe.stdout ?? ''}${probe.stderr ?? ''}`.includes('util-linux')) {
      utilLinuxScriptCache = candidate;
      break;
    }
  }
  return utilLinuxScriptCache;
}

function script(name: string, spec: FakeBinSpec, dataDir: string, logPath: string): string {
  const lines = ['#!/bin/sh'];
  // One record per call: name and each argv entry NUL-terminated (one printf), then an ASCII record
  // separator \x1e (a second printf). `calls()` drops the unterminated tail, so a reader never sees half a record.
  // The record is staged in its own file and appended by one `cat` (one write), so concurrent calls never interleave.
  // The fake PATH may itself contain mktemp, cat, or rm. Use the shell's default utility path
  // for recorder and payload reads so a fake of one of those names cannot recursively call itself.
  lines.push(`rec=$(command -p mktemp ${shellQuote(join(dataDir, 'rec.XXXXXX'))})`);
  lines.push(`{ printf '%s\\0' ${shellQuote(name)} "$@"; printf '\\036'; } > "$rec"; command -p cat "$rec" >> ${shellQuote(logPath)}; command -p rm -f "$rec"`);
  if (spec.pty === true) {
    // Recorded already: exec the real util-linux script so the caller gets a genuine TTY.
    lines.push(`exec ${shellQuote(utilLinuxScript()!)} "$@"`);
    return `${lines.join('\n')}\n`;
  }
  if (spec.whenArgsStartWith !== undefined && spec.otherwise !== undefined) {
    const words = spec.whenArgsStartWith;
    const tests = [`[ "$#" -ge ${words.length} ]`, ...words.map((word, index) => `[ "$${index + 1}" = ${shellQuote(word)} ]`)];
    lines.push(`if ${tests.join(' && ')}; then :; else exec ${shellQuote(spec.otherwise)} "$@"; fi`);
  }
  if (spec.stdout !== undefined) {
    const file = join(dataDir, `${name}.stdout`);
    writeFileSync(file, spec.stdout);
    lines.push(`command -p cat ${shellQuote(file)}`);
  }
  if (spec.stderr !== undefined) {
    const file = join(dataDir, `${name}.stderr`);
    writeFileSync(file, spec.stderr);
    lines.push(`command -p cat ${shellQuote(file)} >&2`);
  }
  const exitCode = spec.exitCode ?? 0;
  if (spec.sleepSeconds !== undefined && spec.sleepSeconds > 0) {
    // Whole seconds stay as they were; a fraction keeps millisecond precision (`sleep 0.2` — BSD · GNU · busybox).
    const seconds = Number.isInteger(spec.sleepSeconds) ? spec.sleepSeconds : Math.ceil(spec.sleepSeconds * 1000) / 1000;
    // exit 0: `exec` so killing the fake kills the sleep itself. Any other code needs the shell to
    // outlive the sleep; a fake killed mid-sleep then leaves `sleep` until `sleepSeconds` ends.
    // killSignal must outlive the sleep too, or `exec` would replace the shell before the kill line.
    if (exitCode === 0 && spec.killSignal === undefined) lines.push(`exec sleep ${seconds}`);
    else lines.push(`sleep ${seconds}`);
  }
  if (spec.killSignal !== undefined) lines.push(`kill -s ${spec.killSignal} $$`);
  lines.push(`exit ${exitCode}`);
  return `${lines.join('\n')}\n`;
}

export function createFakeBins(specs: Readonly<Record<string, FakeBinSpec>>): FakeBins {
  for (const name of Object.keys(specs)) {
    if (!NAME.test(name) || name === '.' || name === '..') throw new Error(`fake-bin: invalid executable name ${JSON.stringify(name)}`);
    const spec = specs[name]!;
    if (spec.killSignal !== undefined && !KILL_SIGNALS.has(spec.killSignal)) throw new Error(`fake-bin: ${name}: killSignal must be one of ${[...KILL_SIGNALS].join(', ')}`);
    if (spec.whenArgsStartWith !== undefined) {
      if (spec.whenArgsStartWith.length === 0) throw new Error(`fake-bin: ${name}: whenArgsStartWith needs at least one word`);
      if (spec.otherwise === undefined) throw new Error(`fake-bin: ${name}: whenArgsStartWith needs otherwise (the real executable)`);
      if (!isAbsolute(spec.otherwise)) throw new Error(`fake-bin: ${name}: otherwise must be an absolute path, got ${JSON.stringify(spec.otherwise)}`);
    } else if (spec.otherwise !== undefined) {
      throw new Error(`fake-bin: ${name}: otherwise is only used with whenArgsStartWith`);
    }
    if (spec.pty === true) {
      if (spec.stdout !== undefined || spec.stderr !== undefined || spec.exitCode !== undefined
        || spec.sleepSeconds !== undefined || spec.killSignal !== undefined
        || spec.whenArgsStartWith !== undefined || spec.otherwise !== undefined) {
        throw new Error(`fake-bin: ${name}: pty is a pass-through PTY allocator and takes no output/fake fields`);
      }
      if (utilLinuxScript() === null) throw new Error(`fake-bin: ${name}: pty needs the util-linux \`script\` on PATH (this host has none)`);
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-fake-bin-'));
  const dir = join(root, 'bin');
  const dataDir = join(root, 'data');
  const logPath = join(root, 'calls.log');
  try {
    mkdirSync(dir);
    mkdirSync(dataDir);
    writeFileSync(logPath, '');
    for (const [name, spec] of Object.entries(specs)) {
      const file = join(dir, name);
      writeFileSync(file, script(name, spec, dataDir, logPath));
      chmodSync(file, 0o755);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const path = (base = process.env.PATH ?? '') => (base ? `${dir}${delimiter}${base}` : dir);
  return {
    dir,
    bin: (name) => join(dir, name),
    path,
    get env() {
      return { ...process.env, PATH: path() };
    },
    calls() {
      if (!existsSync(logPath)) return [];
      // The segment after the last separator is either empty or a record still being written — never count it.
      return readFileSync(logPath, 'utf8')
        .split('\x1e')
        .slice(0, -1)
        .map((record) => {
          const [name = '', ...argv] = record.split('\0').slice(0, -1);
          return { name, argv };
        });
    },
    async waitForCalls(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const recorded = this.calls();
        if (recorded.length >= count) return recorded;
        if (Date.now() >= deadline) throw new Error(`fake-bin: expected ${count} call(s) within ${timeoutMs}ms, saw ${recorded.length}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Put fake executables first on `process.env.PATH` for the duration of `run`,
 * then restore PATH and remove the files — also when `run` throws.
 */
export async function withFakeBins<T>(
  specs: Readonly<Record<string, FakeBinSpec>>,
  run: (fakeBins: FakeBins) => T | Promise<T>,
): Promise<T> {
  const fakeBins = createFakeBins(specs);
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBins.path(previousPath ?? '');
  try {
    return await run(fakeBins);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fakeBins.cleanup();
  }
}
