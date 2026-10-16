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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface FakeBinSpec {
  readonly stdout?: string;
  readonly stderr?: string;
  /** Exit code (default 0). */
  readonly exitCode?: number;
  /** Stay alive this long before exiting — for long-running daemons a test kills. */
  readonly sleepSeconds?: number;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function script(name: string, spec: FakeBinSpec, dataDir: string, logPath: string): string {
  const lines = ['#!/bin/sh'];
  // One record per call: name and each argv entry NUL-terminated (one printf), then an ASCII record
  // separator \x1e (a second printf). `calls()` drops the unterminated tail, so a reader never sees half a record.
  lines.push(`{ printf '%s\\0' ${shellQuote(name)} "$@"; printf '\\036'; } >> ${shellQuote(logPath)}`);
  if (spec.stdout !== undefined) {
    const file = join(dataDir, `${name}.stdout`);
    writeFileSync(file, spec.stdout);
    lines.push(`cat ${shellQuote(file)}`);
  }
  if (spec.stderr !== undefined) {
    const file = join(dataDir, `${name}.stderr`);
    writeFileSync(file, spec.stderr);
    lines.push(`cat ${shellQuote(file)} >&2`);
  }
  const exitCode = spec.exitCode ?? 0;
  if (spec.sleepSeconds !== undefined && spec.sleepSeconds > 0) {
    const seconds = Math.ceil(spec.sleepSeconds);
    // exit 0: `exec` so killing the fake kills the sleep itself. Any other code needs the shell to
    // outlive the sleep; a fake killed mid-sleep then leaves `sleep` until `sleepSeconds` ends.
    if (exitCode === 0) lines.push(`exec sleep ${seconds}`);
    else lines.push(`sleep ${seconds}`);
  }
  lines.push(`exit ${exitCode}`);
  return `${lines.join('\n')}\n`;
}

export function createFakeBins(specs: Readonly<Record<string, FakeBinSpec>>): FakeBins {
  for (const name of Object.keys(specs)) {
    if (!NAME.test(name) || name === '.' || name === '..') throw new Error(`fake-bin: invalid executable name ${JSON.stringify(name)}`);
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
