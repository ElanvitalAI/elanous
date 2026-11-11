// Fake executables on PATH for tests whose code under test spawns an external CLI
// (grok · magick · tesseract · …) that a gate Pod does not have.
//
// The industry-standard shape is a «PATH shim»: a tiny executable with the real
// name, placed first on PATH. This module only makes that shape shared, so tests
// stop hand-writing `writeFileSync + chmodSync` (MOCK-REVIEW R6 · MOCK-DEVICES-2 ⓑ).
//
// Bun resolves a child's executable from the PATH the process STARTED with when the
// call passes no `env`; `test/preload-child-env.ts` makes a later PATH change visible
// to such calls. Code that passes its own `env` must receive `fakeBins.env` (or a
// PATH built from `fakeBins.path()`).
//
// ⛔ This is not a simulator of the real tool: a spec only selects declared stdout ·
// stderr · exit code · lifetime by argv prefix and optionally records allowlisted
// environment values. Behaviour of the real tool stays with
// tests that run where the tool exists.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export interface FakeBinSpec {
  readonly stdout?: string;
  readonly stderr?: string;
  /** Exit code (default 0). */
  readonly exitCode?: number;
  /** Stay alive this long before exiting — for long-running daemons a test kills, or a fractional
   *  per-call latency (e.g. 0.2) for a test that measures fan-out. */
  readonly sleepSeconds?: number;
  /** Select a fixed response by argv prefix. The first matching response wins; unmatched calls use the top-level defaults. */
  readonly responses?: readonly FakeBinResponse[];
  /** Environment variable names to record beside each invocation (unset values are recorded as null). */
  readonly recordEnv?: readonly string[];
  /**
   * Fake only the calls whose argv starts with these words (e.g. `['worktree', 'add']`);
   * every other call runs `otherwise` with the same argv. Needs `otherwise`.
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
  /** Simulate package-manager output under one exact prefix using only declared files. */
  readonly installArtifacts?: {
    readonly prefixEnv: string;
    readonly prefix: string;
    readonly argv: readonly string[];
    readonly files: readonly { readonly path: string; readonly contents: string; readonly mode?: number }[];
    readonly testBarrier?: true;
  };
}

export interface FakeBinResponse {
  readonly argsStartWith: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  /** Exit code (default 0). */
  readonly exitCode?: number;
}

export interface FakeBinCall {
  readonly name: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string | null>>;
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

let utilLinuxScriptCache: string | null | undefined;

function fakeShimRuntime(): string {
  const perl = findExecutable('perl');
  if (!perl) throw new Error('fake-bin: Perl is required for lossless argv, environment, output, and delegation semantics');
  return perl;
}

function findExecutable(name: string): string | null {
  if (typeof Bun !== 'undefined' && typeof Bun.which === 'function') return Bun.which(name);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue on PATH */ }
  }
  return null;
}

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
  const perlPath = fakeShimRuntime();
  const config = JSON.stringify({ name, spec, logPath, dataDir, ptyPath: spec.pty ? utilLinuxScript() : null,
    nodePath: process.execPath, perlPath, restorePrefix: `ELANOUS_FAKE_BIN_RESTORE_${randomUUID().replace(/-/g, '')}_` });
  const perl = perlPath.replace(/(["\\$])/g, '\\$1');
  return [
    // Perl taint mode ignores PERL5OPT at startup but keeps the original env for recording and delegation.
    `#!/usr/bin/env -S "${perl}" -T`,
    'use strict;',
    'use JSON::PP qw(decode_json);',
    'use Encode qw(decode FB_CROAK LEAVE_SRC);',
    'use Fcntl qw(O_WRONLY O_APPEND);',
    'use IO::Handle;',
    'my $config = decode_json(<<\'FAKE_BIN_CONFIG\');',
    config,
    'FAKE_BIN_CONFIG',
    'if (defined $ENV{PATH}) { $ENV{PATH} =~ /\\A(.*)\\z/s; $ENV{PATH} = $1; }',
    // Delegation uses the list form of exec, so argv is never shell-evaluated.
    'my @argv = map { my $value = decode("UTF-8", $_, FB_CROAK | LEAVE_SRC); $value =~ /\\A(.*)\\z/s; $1 } @ARGV;',
    'my %env = map { $_ => (exists $ENV{$_} ? decode("UTF-8", $ENV{$_}, FB_CROAK | LEAVE_SRC) : undef) } @{$config->{spec}{recordEnv} // []};',
    'my %call = (name => $config->{name}, argv => \\@argv);',
    '$call{env} = \\%env if keys %env;',
    'my $record = JSON::PP->new->utf8->encode(\\%call) . "\\n";',
    'sysopen(my $log, $config->{logPath}, O_WRONLY | O_APPEND) or die "fake-bin: open call log: $!\\n";',
    'my $written = syswrite($log, $record);',
    'close($log);',
    'die "fake-bin: short append write\\n" unless defined($written) && $written == length($record);',
    'my $matches = sub { my ($prefix) = @_; return 0 unless defined $prefix; for my $i (0 .. $#$prefix) { return 0 if !defined($argv[$i]) || $argv[$i] ne $prefix->[$i]; } return 1; };',
    // The tainted shim starts a clean Perl helper, which restores the exact caller environment
    // before an argv-preserving exec. Unlike env(1), it cannot interpret '=' in the target path.
    'my $delegate = sub {',
    '  my ($path) = @_; my $prefix = $config->{restorePrefix};',
    '  $prefix .= "_" while grep { index($_, $prefix) == 0 } keys %ENV;',
    '  for my $key (qw(PATH IFS CDPATH ENV BASH_ENV PERL5OPT)) {',
    '    $ENV{"${prefix}${key}"} = $ENV{$key} if exists $ENV{$key}; delete $ENV{$key};',
    '  }',
    '  $ENV{PATH} = "/usr/bin:/bin";',
    '  my $code = q{my $prefix = shift @ARGV; for my $key (qw(PATH IFS CDPATH ENV BASH_ENV PERL5OPT)) { my $stage = "${prefix}${key}"; if (exists $ENV{$stage}) { $ENV{$key} = delete $ENV{$stage}; } else { delete $ENV{$key}; } } my $path = shift @ARGV; exec { $path } $path, @ARGV; die "fake-bin: exec $path: $!\\n";};',
    '  exec { $config->{perlPath} } $config->{perlPath}, "-e", $code, $prefix, $path, @argv;',
    '  die "fake-bin: exec helper: $!\\n";',
    '};',
    'my $spec = $config->{spec};',
    'if (my $install = $spec->{installArtifacts}) {',
    '  exit(78) unless defined($ENV{$install->{prefixEnv}}) && $ENV{$install->{prefixEnv}} eq $install->{prefix};',
    '  my $expected = $install->{argv}; exit(64) unless @$expected == @argv;',
    '  for my $i (0 .. $#$expected) { exit(64) if $argv[$i] ne $expected->[$i]; }',
    '  my $status = system { $config->{nodePath} } $config->{nodePath}, $config->{dataDir} . "/install-artifacts.mjs", $config->{dataDir} . "/" . $config->{name} . ".install-artifacts.json", @$expected;',
    '  if ($status != 0) { exit($status == -1 ? 127 : ($status & 127 ? 128 + ($status & 127) : $status >> 8)); }',
    '}',
    '$delegate->($config->{ptyPath}) if $spec->{pty};',
    'my $response;',
    'if (ref($spec->{responses}) eq "ARRAY") { for my $candidate (@{$spec->{responses}}) { if ($matches->($candidate->{argsStartWith})) { $response = $candidate; last; } } }',
    'if (ref($spec->{responses}) eq "ARRAY" && !$response && $spec->{otherwise}) { $delegate->($spec->{otherwise}); }',
    'if (!defined($spec->{responses}) && $spec->{whenArgsStartWith} && $spec->{otherwise} && !$matches->($spec->{whenArgsStartWith})) { $delegate->($spec->{otherwise}); }',
    'my $selected = $response // $spec;',
    'binmode(STDOUT, ":encoding(UTF-8)"); binmode(STDERR, ":encoding(UTF-8)");',
    'STDOUT->autoflush(1); STDERR->autoflush(1);',
    'print STDOUT $selected->{stdout} if exists $selected->{stdout};',
    'print STDERR $selected->{stderr} if exists $selected->{stderr};',
    'select undef, undef, undef, $spec->{sleepSeconds} if defined($spec->{sleepSeconds}) && $spec->{sleepSeconds} > 0;',
    'if ($spec->{killSignal}) { kill $spec->{killSignal}, $$; select undef, undef, undef, 1; }',
    'exit($selected->{exitCode} // 0);',
  ].join('\n') + '\n';
}

export function createFakeBins(specs: Readonly<Record<string, FakeBinSpec>>): FakeBins {
  for (const name of Object.keys(specs)) {
    if (!NAME.test(name) || name === '.' || name === '..') throw new Error(`fake-bin: invalid executable name ${JSON.stringify(name)}`);
    const spec = specs[name]!;
    if (spec.killSignal !== undefined && !KILL_SIGNALS.has(spec.killSignal)) throw new Error(`fake-bin: ${name}: killSignal must be one of ${[...KILL_SIGNALS].join(', ')}`);
    if (spec.recordEnv !== undefined) {
      const seen = new Set<string>();
      for (const key of spec.recordEnv) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`fake-bin: ${name}: invalid recordEnv variable name ${JSON.stringify(key)}`);
        if (seen.has(key)) throw new Error(`fake-bin: ${name}: duplicate recordEnv variable ${JSON.stringify(key)}`);
        seen.add(key);
      }
    }
    if (spec.responses !== undefined) {
      if (spec.responses.length === 0) throw new Error(`fake-bin: ${name}: responses needs at least one argv rule`);
      if (spec.whenArgsStartWith !== undefined) throw new Error(`fake-bin: ${name}: responses and whenArgsStartWith cannot be combined`);
      for (const response of spec.responses) {
        if (response.argsStartWith.length === 0) throw new Error(`fake-bin: ${name}: response argsStartWith needs at least one word`);
      }
    }
    if (spec.whenArgsStartWith !== undefined) {
      if (spec.whenArgsStartWith.length === 0) throw new Error(`fake-bin: ${name}: whenArgsStartWith needs at least one word`);
      if (spec.otherwise === undefined) throw new Error(`fake-bin: ${name}: whenArgsStartWith needs otherwise (the real executable)`);
      if (!isAbsolute(spec.otherwise)) throw new Error(`fake-bin: ${name}: otherwise must be an absolute path, got ${JSON.stringify(spec.otherwise)}`);
    } else if (spec.otherwise !== undefined && spec.responses === undefined) {
      throw new Error(`fake-bin: ${name}: otherwise needs whenArgsStartWith or responses`);
    } else if (spec.otherwise !== undefined && !isAbsolute(spec.otherwise)) {
      throw new Error(`fake-bin: ${name}: otherwise must be an absolute path, got ${JSON.stringify(spec.otherwise)}`);
    }
    if (spec.pty === true) {
      if (spec.stdout !== undefined || spec.stderr !== undefined || spec.exitCode !== undefined
        || spec.sleepSeconds !== undefined || spec.killSignal !== undefined
        || spec.whenArgsStartWith !== undefined || spec.otherwise !== undefined || spec.responses !== undefined || spec.installArtifacts !== undefined) {
        throw new Error(`fake-bin: ${name}: pty is a pass-through PTY allocator and takes no output/fake fields`);
      }
      if (utilLinuxScript() === null) throw new Error(`fake-bin: ${name}: pty needs the util-linux \`script\` on PATH (this host has none)`);
    }
    if (spec.installArtifacts !== undefined) {
      const { prefixEnv, prefix, argv, files } = spec.installArtifacts;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefixEnv)) throw new Error(`fake-bin: ${name}: invalid install prefix environment name`);
      if (prefix.includes('\0')) throw new Error(`fake-bin: ${name}: install prefix must not contain NUL`);
      if (!isAbsolute(prefix) || resolve(prefix) !== prefix) throw new Error(`fake-bin: ${name}: install prefix must be absolute and normalized`);
      if (argv.length === 0 || files.length === 0) throw new Error(`fake-bin: ${name}: installArtifacts needs exact argv and at least one file`);
      const paths = new Set<string>();
      for (const artifact of files) {
        if (!artifact.path || artifact.path.includes('\0') || isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).some((part) => part === '..' || part === '')) throw new Error(`fake-bin: ${name}: install artifact path must stay relative to its prefix`);
        if (paths.has(artifact.path)) throw new Error(`fake-bin: ${name}: duplicate install artifact path ${artifact.path}`);
        paths.add(artifact.path);
        if (artifact.mode !== undefined && (!Number.isInteger(artifact.mode) || artifact.mode < 0 || artifact.mode > 0o777)) throw new Error(`fake-bin: ${name}: invalid install artifact mode`);
      }
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-fake-bin-'));
  const dir = join(root, 'bin');
  const dataDir = join(root, 'data');
  const logPath = join(root, 'calls.log');
  try {
    mkdirSync(dir);
    mkdirSync(dataDir);
    writeFileSync(logPath, '', { mode: 0o600 });
    const hasInstallArtifacts = Object.values(specs).some((spec) => spec.installArtifacts !== undefined);
    if (hasInstallArtifacts) writeFileSync(join(dataDir, 'install-artifacts.mjs'), readFileSync(new URL('./fake-bin-install-helper.mjs', import.meta.url)));
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.installArtifacts !== undefined) writeFileSync(join(dataDir, `${name}.install-artifacts.json`), JSON.stringify({ ...spec.installArtifacts, exitCode: spec.exitCode ?? 0 }));
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
      const contents = readFileSync(logPath, 'utf8');
      const lines = contents.split('\n');
      if (lines.at(-1) === '') lines.pop();
      else lines.pop(); // An incomplete append is not a call record.
      return lines.map((line) => JSON.parse(line) as FakeBinCall);
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

/** Result receipt for a fake executable run, including the process result seen by the caller. */
export interface FakeExecutableRun {
  readonly name: string;
  readonly argv: readonly string[];
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export interface FakeExecutableDevice extends FakeBins {
  /** Invocation argv captured by the executable shims. */
  calls(): FakeBinCall[];
  /** Results captured by run(), in invocation order. */
  runs(): FakeExecutableRun[];
  /** Spawn the registered fake by absolute shim path and capture its result without PATH fallback. */
  run(
    name: string,
    argv?: readonly string[],
    options?: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'env' | 'shell'> & { env?: NodeJS.ProcessEnv },
  ): SpawnSyncReturns<string>;
}

/** Create isolated PATH shims and a result recorder for external executable boundaries. */
export function createFakeExecutableDevice(specs: Readonly<Record<string, FakeBinSpec>>): FakeExecutableDevice {
  const bins = createFakeBins(specs);
  const registeredNames = new Set(Object.keys(specs));
  const observations: FakeExecutableRun[] = [];

  return {
    ...bins,
    runs: () => observations.map((run) => ({ ...run, argv: [...run.argv] })),
    run(name, argv = [], options = {}) {
      if (!registeredNames.has(name)) throw new Error(`fake-bin: run requires a registered executable name: ${JSON.stringify(name)}`);
      // This seam must preserve argv boundaries. Node's shell mode joins argv into a command string,
      // so metacharacters can run outside the registered fake executable.
      if (Object.hasOwn(options, 'shell')) throw new Error('fake-bin: run does not support shell; argv must remain literal');
      if (options.stdio !== undefined && options.stdio !== 'pipe') {
        throw new Error('fake-bin: run only supports stdio=pipe so output receipts remain observable');
      }
      const basePath = options.env?.PATH ?? process.env.PATH ?? '';
      const env = { ...process.env, ...options.env, PATH: bins.path(basePath) };
      const result = spawnSync(bins.bin(name), [...argv], { ...options, encoding: 'utf8', env });
      observations.push({
        name,
        argv: [...argv],
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        signal: result.signal,
        ...(result.error ? { error: result.error.message } : {}),
      });
      return result;
    },
  };
}

/** Create the device for one scoped callback and always remove its temporary PATH tree. */
export async function withFakeExecutableDevice<T>(
  specs: Readonly<Record<string, FakeBinSpec>>,
  run: (device: FakeExecutableDevice) => T | Promise<T>,
): Promise<T> {
  const device = createFakeExecutableDevice(specs);
  try {
    return await run(device);
  } finally {
    device.cleanup();
  }
}
