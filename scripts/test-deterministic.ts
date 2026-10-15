// Deterministic full-suite entry point.
//
// `bun test` intentionally remains Bun's raw discovery command for focused
// work.  This wrapper is the repository-wide gate: it prevents a developer's
// HOME/configuration or credentials from silently turning a unit test into a
// live provider/CLI run.
//
// ⚠️ WHAT THIS DOES **NOT** DO — stated so nobody reads more guarantee into
// the name than it has:
//   - It does not remove `PATH`, so an installed CLI is still reachable. A
//     test that shells out to a real binary still shells out to it. Removing
//     PATH would take `bun` itself with it; containing CLI reach belongs to
//     per-test seams, not to this wrapper.
//   - It does not block network egress. A test that opens a non-loopback
//     socket still opens it. Egress control is a sandbox/CI concern.
//   - It removes ambient *configuration and credentials*, which is what makes
//     an accidental live call succeed. Without a key the call fails fast
//     instead of running up a bill — that is the boundary this buys, and the
//     tiering plan in PLAN-test-suite-diet is what closes the rest.
//   - It does not sweep leftover `elanous-deterministic-test-*` directories from
//     earlier runs. That remains out of scope on purpose.
//   - 2026-08-26 landed `child.kill` only and wrote that this wrapper "does not
//     chase grandchildren of the direct `bun test` child. Those are out of
//     scope on purpose." That boundary left interactive shells behind when the
//     full suite was interrupted (observed 2026-08-27: leftover bash --norc
//     --noprofile -i from test/pty-snapshot-resize.test.ts). The child is now
//     spawned as its own process-group leader (`detached: true`) and SIGINT /
//     SIGTERM signal that group so grandchildren die with it. This still does
//     not hunt processes by name, and it never signals this process's own
//     group. If group termination fails it falls back to the direct child and
//     reports the failure.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';
// The predicate lives in its own side-effect-free module so it can be tested:
// importing THIS file used to spawn the suite at load time. The runner is now
// behind `import.meta.main` / `runDeterministicTests()`, but the filter stays
// in the helper so an untested credential check cannot rot silently.
import { isCredentialKey } from './lib/deterministic-env.js';
import { envLiteral } from '../src/platform/env-literal.js';

export const TEMP_ROOT_PREFIX = 'elanous-deterministic-test-';
export const CHILD_EXIT_GRACE_MS = 2_000;

// A deterministic test child is not a harness executor: these inherited
// markers would activate write-boundary policy against each test's temp files.
const HARNESS_TEST_ENV_KEYS = [
  'ELANOUS_HARNESS_SPACE',
  'ELANOUS_HARNESS_SPACE_ID',
  'ELANOUS_HARNESS_BOUNDARY',
  'ELANOUS_HARNESS_ROLE',
  'ELANOUS_HARNESS_DETACHED',
] as const;

// Discovery: rg -n "process\.env\.ELANOUS_(HOST|RUN|ORIGIN|SUPERVISOR|PARENT)" src
// These are ambient execution identities, not inputs to a deterministic test.
// debug.log also attributes SUBSTRATE and ARM_ID to every plain-object record.
export const GIT_LOCATION_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

const EXECUTION_ORIGIN_ENV_KEYS = [
  'ELANOUS_HOST_ID',
  'ELANOUS_RUN_ID',
  'ELANOUS_RUN_CONTEXT',
  'ELANOUS_PARENT_RUN_ID',
  'ELANOUS_PARENT_PTY_ID',
  'ELANOUS_PARENT_SELF_DEV_RUNS_DIR',
  'ELANOUS_SUBSTRATE',
  'ELANOUS_ARM_ID',
  // Parent account selection changes CLI rotation assertions in the child.
  'ELANOUS_CODEX_ACCOUNT',
  // A parent's derived-root label must not reclassify a test's explicit state dir.
  'ELANOUS_STATE_DIR_SOURCE',
] as const;

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export type NamePatternEvidence = { nameMissDiagnostic: boolean; passSummary: boolean; runSummary: boolean };

export type DirectChild = {
  readonly pid?: number;
  readonly exited: Promise<number>;
  readonly stderrEvidence?: Promise<NamePatternEvidence>;
  kill(signal?: number | NodeJS.Signals): boolean | void;
};

export type SpawnDirectChild = (opts: {
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: 'inherit';
  stdout: 'inherit';
  stderr: 'inherit';
  detached: true;
  captureNoMatch?: boolean;
  namePatterns?: string[];
}) => DirectChild;

export type KillProcessGroup = (pid: number, signal: NodeJS.Signals) => void;
export type GetProcessGroupId = (pid: number) => number;

export type SignalTarget = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
};

export type ShutdownSignalGate = {
  readonly received: Promise<ShutdownSignal>;
  dispose(): void;
};

export type DeterministicRunnerDeps = {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  /** 시험이 파생을 갈아 끼울 자리 — 실물 rg 를 안 부르고 목록을 준다. */
  deriveCdpPatterns?: () => string[];
  deriveMockModuleFiles?: () => string[];
  deriveTestFiles?: () => string[];
  cwd?: string;
  tmpdir?: () => string;
  mkdtempSync?: (prefix: string) => string;
  rmSync?: (path: string, options: { recursive: true; force: true }) => void;
  spawn?: SpawnDirectChild;
  waitForSignal?: () => Promise<ShutdownSignal>;
  signalTarget?: SignalTarget;
  onAbsorbSignal?: (signal: ShutdownSignal) => void;
  report?: (message: string) => void;
  killSelf?: (signal: ShutdownSignal) => void;
  childGraceMs?: number;
  killProcessGroup?: KillProcessGroup;
  getProcessGroupId?: GetProcessGroupId;
  gitConfig?: (cwd: string, args: string[]) => string | undefined;
};

export function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    // EPERM means the process exists but this uid cannot signal it — not death.
    return code === 'EPERM';
  }
}

export function isLiveProcessGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'ESRCH') return false;
    // EPERM means the group exists but this uid cannot signal it — not death.
    return true;
  }
}

export async function waitUntilPidAndGroupDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLivePid(pid) && !isLiveProcessGroup(pid)) return true;
    await Bun.sleep(25);
  }
  return !isLivePid(pid) && !isLiveProcessGroup(pid);
}

function decodeSpawnOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}

export function getProcessGroupId(pid: number): number {
  const target = pid === 0 ? process.pid : pid;
  const result = Bun.spawnSync({
    cmd: ['ps', '-o', 'pgid=', '-p', String(target)],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const parsed = Number(decodeSpawnOutput(result.stdout).trim().split(/\s+/)[0]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`failed to read process group id for pid=${target}`);
  }
  return parsed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportVisible(message: string, report: (message: string) => void = console.error): void {
  report(message);
}

export function cleanupTemporaryRoot(
  testRoot: string,
  deps: { rmSync?: DeterministicRunnerDeps['rmSync']; report?: (message: string) => void } = {},
): void {
  const remove = deps.rmSync ?? rmSync;
  const report = deps.report ?? console.error;
  try {
    remove(testRoot, { recursive: true, force: true });
  } catch (error) {
    reportVisible(`failed to remove temporary root: ${testRoot}: ${formatError(error)}`, report);
  }
}

export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  deps: { getProcessGroupId?: GetProcessGroupId } = {},
): void {
  const getPgid = deps.getProcessGroupId ?? getProcessGroupId;
  const ownPgid = getPgid(0);
  if (pid === ownPgid) {
    throw new Error("refusing to signal this process's own group");
  }
  try {
    if (getPgid(pid) === ownPgid) {
      throw new Error("refusing to signal this process's own group");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("own group")) throw error;
    // getpgid failed — the detached leader pid still identifies the group.
  }
  process.kill(-pid, signal);
}

function signalDirectChild(
  child: DirectChild,
  pid: number,
  sig: NodeJS.Signals,
  report: (message: string) => void,
): void {
  try {
    child.kill(sig);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code !== 'ESRCH') {
      reportVisible(`failed to signal child pid=${pid} with ${sig}: ${formatError(error)}`, report);
    }
  }
}

export async function terminateDirectChild(
  child: DirectChild,
  signal: NodeJS.Signals,
  deps: {
    graceMs?: number;
    report?: (message: string) => void;
    killProcessGroup?: KillProcessGroup;
    getProcessGroupId?: GetProcessGroupId;
  } = {},
): Promise<void> {
  const report = deps.report ?? console.error;
  const graceMs = deps.graceMs ?? CHILD_EXIT_GRACE_MS;
  const killGroup = deps.killProcessGroup ?? ((pgid, sig) => killProcessGroup(pgid, sig, { getProcessGroupId: deps.getProcessGroupId }));
  const pid = child.pid;
  if (pid === undefined) {
    reportVisible('failed to terminate child: no pid', report);
    return;
  }

  const tryKill = (sig: NodeJS.Signals): void => {
    try {
      killGroup(pid, sig);
    } catch (error) {
      reportVisible(`failed to signal process group pgid=${pid} with ${sig}: ${formatError(error)}`, report);
      signalDirectChild(child, pid, sig, report);
    }
  };

  tryKill(signal);
  // Direct-child death is not group death: a SIGTERM-ignoring grandchild can
  // outlive the leader. Reap only when both the leader pid and the group are gone.
  if (await waitUntilPidAndGroupDead(pid, graceMs)) return;
  tryKill('SIGKILL');
  if (await waitUntilPidAndGroupDead(pid, graceMs)) return;
  reportVisible(`failed to terminate child pid=${pid}`, report);
}

function gitConfig(cwd: string, args: string[]): string | undefined {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV_KEYS) delete env[key];
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.error || (result.status !== 0 && !(result.status === 1 && args.includes('--get-all') && !result.stderr))) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
  if (result.status === 1) return undefined;
  // --null --get-all terminates each complete value with NUL, even when
  // a value itself contains newlines or is empty.
  return args.includes('--get-all') ? result.stdout : result.stdout.trim();
}

export function prepareIsolatedTestEnv(sourceEnv: NodeJS.ProcessEnv, testRoot: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => !isCredentialKey(key)
      && !HARNESS_TEST_ENV_KEYS.includes(key as typeof HARNESS_TEST_ENV_KEYS[number])
      && !EXECUTION_ORIGIN_ENV_KEYS.includes(key as typeof EXECUTION_ORIGIN_ENV_KEYS[number])
      && !GIT_LOCATION_ENV_KEYS.includes(key as typeof GIT_LOCATION_ENV_KEYS[number])),
  );
  env.HOME = testRoot;
  // userConfigPath() warns whenever XDG_CONFIG_HOME is set, including when
  // config.json is absent. Use its non-XDG path; migrateLegacyXdgUserConfig()
  // resolves the old path through ELANOUS_TEST_HOME rather than the real home.
  delete env.XDG_CONFIG_HOME;
  env.ELANOUS_TEST_HOME = testRoot;
  // HOME and ELANOUS_STATE_DIR isolate both the state and default config roots.
  // ELANOUS_CONFIG_DIR is not a config-dir override; discard an inherited value
  // rather than passing an ignored variable that appears to provide isolation.
  env.ELANOUS_STATE_DIR = join(testRoot, 'state');
  delete env.ELANOUS_CONFIG_DIR;
  // All ambient execution identities are removed by EXECUTION_ORIGIN_ENV_KEYS
  // above, before the child is spawned; logger API-shape tests need their absence.
  // ⚠️ No `ELANOUS_TEST_DETERMINISTIC` marker is exported. Nothing reads it yet,
  // and an env var with no consumer is a surface that looks like a contract
  // while guaranteeing nothing — a later test could branch on it believing it
  // means something. The tier work in PLAN-test-suite-diet introduces the
  // signal together with the code that honours it.
  return envLiteral(env);
}

/** Read every stderr line, retaining only Bun's verdict signals. A long test
 * log must not become a second in-memory copy of the full output. */
export async function scanNamePatternStderr(
  stream: AsyncIterable<Uint8Array>, patterns: string[], forward: (chunk: Uint8Array) => void = () => {},
): Promise<NamePatternEvidence> {
    const evidence = { nameMissDiagnostic: false, passSummary: false, runSummary: false };
    const decoder = new TextDecoder();
    let pending = '';
    let overflow = false;
    const inspect = (line: string) => {
      if (/^\s*[1-9]\d* pass$/.test(line)) evidence.passSummary = true;
      if (/^Ran [1-9]\d* tests? across \d+ files?\. \[\d+(?:\.\d+)?ms\]$/.test(line)) evidence.runSummary = true;
      for (const pattern of patterns) {
        const prefix = `error: regex ${JSON.stringify(pattern)} matched 0 tests. Searched `;
        if (line.startsWith(prefix)
          && /^\d+ files? \(skipping \d+ tests?\) \[\d+(?:\.\d+)?ms\]$/.test(line.slice(prefix.length))) {
          evidence.nameMissDiagnostic = true;
        }
      }
    };
    const feed = (text: string) => {
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const part = text.slice(start, newline < 0 ? undefined : newline);
        if (!overflow) {
          if (pending.length + part.length > 4096) { pending = ''; overflow = true; }
          else pending += part;
        }
        if (newline < 0) break;
        if (!overflow) inspect(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
        pending = '';
        overflow = false;
        start = newline + 1;
      }
    };
    for await (const chunk of stream) {
      forward(chunk);
      feed(decoder.decode(chunk, { stream: true }));
    }
    feed(decoder.decode());
    if (!overflow) inspect(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
    return evidence;
}

const defaultSpawn: SpawnDirectChild = (opts) => {
  const child = Bun.spawn({
    cmd: opts.cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: opts.captureNoMatch ? 'pipe' : 'inherit',
    detached: true,
  });
  if (!opts.captureNoMatch) return child;
  const stderrEvidence = scanNamePatternStderr(
    child.stderr as ReadableStream<Uint8Array>, opts.namePatterns ?? [],
    (chunk) => process.stderr.write(chunk),
  );
  return { pid: child.pid, exited: child.exited, kill: (signal) => child.kill(signal), stderrEvidence };
};

export function installShutdownSignalGate(
  target: SignalTarget = process,
  onAbsorb: (signal: ShutdownSignal) => void = () => {},
): ShutdownSignalGate {
  let first: ShutdownSignal | undefined;
  let resolveFirst: ((signal: ShutdownSignal) => void) | undefined;
  const received = new Promise<ShutdownSignal>((resolve) => {
    resolveFirst = resolve;
  });

  const handle = (signal: ShutdownSignal) => {
    if (first !== undefined) {
      onAbsorb(signal);
      return;
    }
    first = signal;
    resolveFirst?.(signal);
  };

  const onInt = () => handle('SIGINT');
  const onTerm = () => handle('SIGTERM');
  // Keep listeners until dispose() — a one-shot listener would restore the
  // default action mid-shutdown, so a second SIGINT/SIGTERM could kill us
  // before the direct child and temporary root are cleaned.
  target.on('SIGINT', onInt);
  target.on('SIGTERM', onTerm);

  return {
    received,
    dispose: () => {
      target.removeListener('SIGINT', onInt);
      target.removeListener('SIGTERM', onTerm);
    },
  };
}

export function resignalSelf(signal: ShutdownSignal, report: (message: string) => void = console.error): void {
  try {
    process.kill(process.pid, signal);
  } catch (error) {
    reportVisible(`failed to re-signal self with ${signal}: ${formatError(error)}`, report);
  }
}

/** CDP(실제 브라우저)를 타는 시험 파일을 ***목록으로 적지 않고 파생***한다.
 *
 *  🩸 왜 (🅕 실측 2026-09-24 · 브라우저가 «떠 있는» 상태에서):
 *    check-layout-landmark 137.6초/7건 = 19.7초/건 · check-layout 176.8초/15건 = 11.8초/건
 *    ↔ CDP 를 «안» 타는 nav-signature 는 0.9초/5건 = 0.2초/건.
 *    CDP 시험 123~199건 × 14초 ⇒ ***29~46분***. 기준선 전수 72분 중 큰 몫이었다.
 *  🔑 그리고 그 시험들은 ***브라우저 유무·부하에 따라 결과가 달라진다*** — 게이트 이름이
 *    `deterministic` 인데 결정적이지 않다(인계 §38-i: 로드 216 에서 「재서 틀린 값」을 냈다).
 *  ⛔ 목록을 손으로 적지 않는 이유: 새 CDP 시험이 생기면 ***자동으로*** 따라와야 한다.
 *  ⚠️ 판별이 덮는 것: `requireCdpBase` 직접 import ⊕ 전용 측정 포트 `9333` 직접 사용.
 *    ⛔ ***전이 호출은 못 잡는다*** — 실측: `loop/prepare-edition.test.ts` 는 자식으로
 *    `check-clone.ts` 를 spawn 한다. 그것은 «알려진 한계»이고, 그 파일들은 기본 레인에 남는다. */
export function deriveCdpTestPatterns(deps: { spawnSync?: typeof Bun.spawnSync; cwd?: string } = {}): string[] {
  const run = deps.spawnSync ?? Bun.spawnSync;
  const result = run({
    // ⛔ `requireCdpBase` «만» 으로는 못 잡는다 — 실측 2026-09-24: 여섯 파일이 포트 목록
    //    `[9333, 9222, …]` 을 ***직접 박아*** CDP 에 붙는다(test/webclone-check-layout-*).
    //    그래서 「전용 측정 포트 9333」도 같이 문다. ⚠️ 여전히 ***전이 호출은 못 잡는다***
    //    (loop/prepare-edition.test.ts 는 자식으로 check-clone.ts 를 spawn 한다) — 알려진 한계다.
    cmd: ['rg', '-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'],
    cwd: deps.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = result.stdout ? new TextDecoder().decode(result.stdout) : '';
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts'))
    .sort();
}

// Keep both scans aligned with Bun's default test discovery (four name forms,
// eight JavaScript/TypeScript extensions). A file absent from either list can
// be silently skipped when a positional filter matches multiple test files.
const BUN_TEST_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];
const BUN_TEST_GLOBS = BUN_TEST_EXTENSIONS.flatMap((ext) => [
  `*.test.${ext}`, `*_test.${ext}`, `*.spec.${ext}`, `*_spec.${ext}`,
]);
const BUN_TEST_FILE_PATTERN = /(?:\.|_)(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const BUN_EXPLICIT_TEST_FILE_PATTERN = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

const MOCK_SCAN_OPTIONS: ts.CompilerOptions = {
  allowJs: true, noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve,
};

function bunTestScriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS; // .ts, .mts, .cts
}

function sourceHasModuleMockCall(tree: ts.SourceFile): boolean {
  let found = false;
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return expression;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const receiver = unwrap(callee.expression);
        if (ts.isIdentifier(receiver) && receiver.text === 'mock' && callee.name.text === 'module') {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Use public syntactic diagnostics; TypeScript's parseDiagnostics field is
 * internal and absent from SourceFile's public type. */
function scanMockCallBatch(files: string[]): boolean[] {
  const roots = new Set(files.map((file) => resolve(file)));
  const host = ts.createCompilerHost(MOCK_SCAN_OPTIONS);
  host.getSourceFile = (file, languageVersion) => {
    if (!roots.has(resolve(file))) return undefined;
    try {
      return ts.createSourceFile(file, readFileSync(file, 'utf8'), languageVersion, true, bunTestScriptKind(file));
    } catch { return undefined; }
  };
  const program = ts.createProgram(files, MOCK_SCAN_OPTIONS, host);
  return files.map((file) => {
    const tree = program.getSourceFile(file);
    return !tree || program.getSyntacticDiagnostics(tree).length > 0 || sourceHasModuleMockCall(tree);
  });
}

function hasModuleMockCall(source: string, file: string): boolean {
  const host = ts.createCompilerHost(MOCK_SCAN_OPTIONS);
  host.getSourceFile = (name, languageVersion) => resolve(name) === resolve(file)
    ? ts.createSourceFile(name, source, languageVersion, true, bunTestScriptKind(file)) : undefined;
  const program = ts.createProgram([file], MOCK_SCAN_OPTIONS, host);
  const tree = program.getSourceFile(file);
  return !tree || program.getSyntacticDiagnostics(tree).length > 0 || sourceHasModuleMockCall(tree);
}

/** Parse every Bun-discovered test: text search misses valid calls with a
 * comment between `mock` and `.module`. An extra solo file costs time, while a
 * missed call can contaminate every later file in the Bun process. */
export function deriveMockModuleTestFiles(
  deps: { spawnSync?: typeof Bun.spawnSync; cwd?: string; files?: string[] } = {},
): string[] {
  const cwd = deps.cwd ?? process.cwd();
  // `files` narrows the parse to a caller-selected subset of discovered tests.
  const files = deps.files ?? deriveTestFiles({ spawnSync: deps.spawnSync, cwd });
  const mocks: string[] = [];
  // A bounded program keeps the public syntax check below 600 MB on the
  // current repository, rather than retaining all 5,836 ASTs at once.
  for (let index = 0; index < files.length; index += 100) {
    const batch = files.slice(index, index + 100);
    const matched = scanMockCallBatch(batch.map((file) => resolve(cwd, file)));
    for (let offset = 0; offset < batch.length; offset++) if (matched[offset]) mocks.push(batch[offset]!);
  }
  return mocks.sort();
}

export function deriveTestFiles(deps: { spawnSync?: typeof Bun.spawnSync; cwd?: string } = {}): string[] {
  const run = deps.spawnSync ?? Bun.spawnSync;
  const result = run({
    cmd: ['rg', '--files', ...BUN_TEST_GLOBS.flatMap((glob) => ['--glob', glob])],
    cwd: deps.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // rg --files exits 1 for a valid directory with no matching test files.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`test file scan failed (exit ${result.exitCode}): ${decodeSpawnOutput(result.stderr).trim()}`);
  }
  return decodeSpawnOutput(result.stdout).split('\n').map((line) => line.trim()).filter((line) => BUN_TEST_FILE_PATTERN.test(line));
}

// Bun accepts both `--flag=value` and `--flag value`. The value of a test
// option is never a file selector, even when it happens to match a file name.
// Audited against `bun --help` and `bun test --help` in Bun 1.4.2. Bun accepts
// these global value options after `test` too. Missing one makes its value look
// like a path selector, which disables the default CDP exclusion.
const BUN_TEST_VALUE_OPTIONS = new Set([
  '--elide-lines', '-F', '--filter', '--shell', '--watch-kill-signal',
  '--preload', '-r', '--require', '--import', '--inspect', '--inspect-wait', '--inspect-brk',
  '--cpu-prof-name', '--cpu-prof-dir', '--cpu-prof-interval',
  '--heap-prof-name', '--heap-prof-dir', '--heap-prof-interval',
  '--install', '--eval', '-e', '--print', '-p', '--port', '--conditions',
  '--fetch-preconnect', '--max-http-header-size', '--dns-result-order',
  '--redirect-warnings', '--disable-warning', '--title', '--unhandled-rejections',
  '--console-depth', '--user-agent', '--cron-title', '--cron-period', '--main-fields',
  '--extension-order', '--tsconfig-override', '--define', '-d', '--drop', '--feature',
  '--loader', '-l', '--jsx-factory', '--jsx-fragment', '--jsx-import-source',
  '--jsx-runtime', '--env-file', '--cwd', '--config', '-c',
  // `bun test --help` values:
  '--timeout', '--rerun-each', '--retry', '--seed', '--coverage-reporter',
  '--coverage-dir', '--test-name-pattern', '-t', '--reporter',
  '--reporter-outfile', '--max-concurrency', '--path-ignore-patterns',
  '--parallel-delay', '--shard',
  // `bun test --timings file.test.ts` reads file.test.ts as timing JSON and
  // errors if it contains test code; it does not treat the file as a selector.
  '--timings',
]);
export function partitionBunTestArguments(argv: string[]): { selectors: string[]; soloArgs: string[] } {
  const selectors: string[] = [];
  const soloArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      soloArgs.push(arg);
      selectors.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      selectors.push(arg);
      continue;
    }
    soloArgs.push(arg);
    if (arg.includes('=')) continue;
    const next = argv[index + 1];
    // Bun 1.4.2 reads `--bail 2`, `--parallel 2`, and `--changed HEAD` as
    // positional filters. Their optional values require `--flag=value`.
    if (next !== undefined && BUN_TEST_VALUE_OPTIONS.has(arg)) {
      soloArgs.push(next);
      index++;
    }
  }
  return { selectors, soloArgs };
}

function bunTestOptionTokens(argv: string[]): string[] {
  const options: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    options.push(arg);
    if (!arg.includes('=') && BUN_TEST_VALUE_OPTIONS.has(arg) && argv[index + 1] !== undefined) index++;
  }
  return options;
}

function bunTestOptionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') break;
    if (arg === name && argv[index + 1] !== undefined) values.push(argv[index + 1]!);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
    if (!arg.includes('=') && BUN_TEST_VALUE_OPTIONS.has(arg) && argv[index + 1] !== undefined) index++;
  }
  return values;
}

/** Bun applies the final --cwd against the process launch directory, not a
 * previous --cwd. Use the same root for discovery as the child test runner. */
export function effectiveTestCwd(argv: string[], launchCwd: string): string {
  let testCwd = launchCwd;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') break;
    if (arg.startsWith('--cwd=')) {
      testCwd = resolve(launchCwd, arg.slice('--cwd='.length));
    } else if (arg === '--cwd' && argv[index + 1] !== undefined) {
      testCwd = resolve(launchCwd, argv[++index]!);
    } else if (BUN_TEST_VALUE_OPTIONS.has(arg)) {
      index++;
    }
  }
  return testCwd;
}

/** rg intentionally honors ignore rules, but Bun can execute an explicit
 * ignored or outside-repository test file. Inspect those paths directly. */
export function classifyExplicitTestFiles(argv: string[], cwd: string): { files: string[]; mockFiles: string[] } {
  const files: string[] = [];
  const mockFiles: string[] = [];
  for (const selector of partitionBunTestArguments(argv).selectors) {
    const absolute = resolve(cwd, selector);
    // Bun treats an unsuffixed `test/custom.ts` as a name filter, while
    // `./test/custom.ts` and absolute paths explicitly select that file.
    const explicitFilePath = BUN_TEST_FILE_PATTERN.test(absolute)
      || selector.startsWith('./') || selector.startsWith('../') || isAbsolute(selector);
    let candidates: string[] = [];
    let isDirectory = false;
    try {
      const stats = statSync(absolute);
      isDirectory = stats.isDirectory();
      if (stats.isFile() && explicitFilePath && BUN_EXPLICIT_TEST_FILE_PATTERN.test(absolute)) candidates = [absolute];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // A file Bun may open but our classifier cannot read must run alone.
      candidates = explicitFilePath && BUN_EXPLICIT_TEST_FILE_PATTERN.test(absolute) ? [absolute] : [];
    }
    // A failed directory scan must stop planning; it cannot certify that a
    // selected directory contains no ordinary tests.
    if (isDirectory) candidates = deriveTestFiles({ cwd: absolute }).map((file) => resolve(absolute, file));
    for (const candidate of candidates) {
      const rel = relative(cwd, candidate);
      // Bun discovers a custom.ts passed by absolute path, but treats bare
      // `test/custom.ts` as a name filter rather than an explicit file path.
      const file = rel.startsWith('..') || isAbsolute(rel) || !BUN_TEST_FILE_PATTERN.test(candidate)
        ? candidate : rel;
      files.push(file);
      try {
        if (hasModuleMockCall(readFileSync(candidate, 'utf8'), candidate)) mockFiles.push(file);
      } catch {
        mockFiles.push(file);
      }
    }
  }
  return { files: [...new Set(files)], mockFiles: [...new Set(mockFiles)] };
}

function replaceBulkSelectors(argv: string[], replacement: (selector: string) => string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      result.push(arg, ...argv.slice(index + 1).flatMap(replacement));
      break;
    }
    if (arg.startsWith('-')) {
      result.push(arg);
      if (BUN_TEST_VALUE_OPTIONS.has(arg) && argv[index + 1] !== undefined) result.push(argv[++index]!);
    } else {
      result.push(...replacement(arg));
    }
  }
  return result;
}

/** How a positional selector picks discovered test files: a directory selects
 * the files under it, an exact discovered path selects itself, and anything
 * else is Bun's substring filter. */
function testSelectorMatcher(allTestFiles: string[], testCwd: string) {
  const directory = (selector: string): string | undefined => {
    const path = resolve(testCwd, selector);
    try { return statSync(path).isDirectory() ? path : undefined; } catch { return undefined; }
  };
  const insideDirectory = (file: string, path: string): boolean => {
    const absolute = resolve(testCwd, file);
    return absolute.startsWith(path + sep);
  };
  const discoveredPaths = new Set(allTestFiles.map((file) => resolve(testCwd, file)));
  const isExact = (selector: string): boolean => discoveredPaths.has(resolve(testCwd, selector));
  const matchesSelector = (file: string, selector: string): boolean => {
    const dir = directory(selector);
    if (dir) return insideDirectory(file, dir);
    return isExact(selector)
      ? resolve(testCwd, file) === resolve(testCwd, selector)
      : file.includes(selector.replace(/^\.\//, ''));
  };
  return { directory, insideDirectory, isExact, matchesSelector };
}

/** Discovered test files that a path-selected run can reach. With explicit
 * paths the planner only isolates mock files inside this set, so parsing the
 * rest of the repository (≈20 s per gate shard under load) cannot change it. */
export function selectedTestFiles(argv: string[], allTestFiles: string[], testCwd: string): string[] {
  const { selectors } = partitionBunTestArguments(argv);
  const { matchesSelector } = testSelectorMatcher(allTestFiles, testCwd);
  return allTestFiles.filter((file) => selectors.some((selector) => matchesSelector(file, selector)));
}

/** Return one bulk command and one command per selected global module mock. */
export function planDeterministicTestCommands(
  argv: string[], cdpPatterns: string[], mockFiles: string[], allTestFiles: string[] = [], testCwd = process.cwd(),
): string[][] {
  const { selectors: pathArgs, soloArgs } = partitionBunTestArguments(argv);
  const explicitPaths = pathArgs.length > 0;
  const { directory, insideDirectory, isExact, matchesSelector } = testSelectorMatcher(allTestFiles, testCwd);
  const callerIgnoreGlobs = bunTestOptionValues(argv, '--path-ignore-patterns').map((pattern) => new Bun.Glob(pattern));
  const selectedMocks = mockFiles.filter((file) => !cdpPatterns.includes(file)
    && !callerIgnoreGlobs.some((glob) => glob.match(file) || glob.match(resolve(testCwd, file)))
    && (!explicitPaths || pathArgs.some((selector) => matchesSelector(file, selector))));
  if (selectedMocks.length === 0) {
    return [['bun', 'test', ...cdpPatterns.flatMap((pattern) => ['--path-ignore-patterns', pattern]), ...argv]];
  }
  const globalBail = !explicitPaths && bunTestOptionTokens(argv).some((arg) =>
    arg === '--bail' || arg === '--bail=1');
  if ((explicitPaths && pathArgs.every((selector) =>
    allTestFiles.some((file) => matchesSelector(file, selector))))
    || (globalBail && allTestFiles.length > 0)) {
    // Bun runs selected files in path order, regardless of selector order.
    // Keep the ordinary files in contiguous bulk runs around solo mock files;
    // this also preserves which file a global --bail stops on.
    const files = allTestFiles.filter((file) => (explicitPaths
      ? pathArgs.some((selector) => matchesSelector(file, selector))
      : !cdpPatterns.includes(file))
      && !callerIgnoreGlobs.some((glob) => glob.match(file) || glob.match(resolve(testCwd, file))))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const commands: string[][] = [];
    let ordinary: string[] = [];
    const flushOrdinary = () => {
      if (ordinary.length > 0) commands.push(['bun', 'test', ...soloArgs, ...ordinary]);
      ordinary = [];
    };
    for (const file of files) {
      if (selectedMocks.includes(file)) {
        flushOrdinary();
        commands.push(['bun', 'test', ...soloArgs, file]);
      } else ordinary.push(file);
    }
    flushOrdinary();
    return commands;
  }
  const exactMockSelector = (selector: string): boolean => isExact(selector)
    && allTestFiles.some((file) => resolve(testCwd, file) === resolve(testCwd, selector))
    && selectedMocks.some((file) => resolve(testCwd, file) === resolve(testCwd, selector));
  // Remove selected exact mock arguments from bulk so each runs in its own
  // process. Caller ignore globs are applied above before this selection.
  const replacement = (selector: string): string[] => {
    const dir = directory(selector);
    if (dir) {
      const matched = allTestFiles.filter((file) => insideDirectory(file, dir));
      return matched.length === 0 ? [selector] : matched.filter((file) => !selectedMocks.includes(file));
    }
    if (exactMockSelector(selector)) return [];
    const matched = allTestFiles.filter((file) => matchesSelector(file, selector));
    // A partial path selector can select only mock files. In that case Bun's
    // bulk child has no tests after exclusion, so leave the selector to solo.
    // Unknown selectors stay in bulk to preserve Bun's no-tests failure.
    return matched.length > 0 && matched.every((file) => selectedMocks.includes(file)) ? [] : [selector];
  };
  const bulkSelectors = pathArgs.flatMap(replacement);
  const skipBulk = explicitPaths && bulkSelectors.length === 0;
  const bulkArgv = replaceBulkSelectors(argv, replacement);
  const bulk = skipBulk ? [] : [[
    'bun', 'test',
    ...[...new Set([...cdpPatterns, ...selectedMocks])].flatMap((pattern) => ['--path-ignore-patterns', pattern]),
    // With only a name pattern, ordinary tests may match zero names while a
    // solo mock child still matches. There is no path selector to validate.
    ...(!explicitPaths && selectedMocks.length > 0 && !bunTestOptionTokens(argv).some((arg) =>
      arg === '--test-name-pattern' || arg.startsWith('--test-name-pattern=') || arg === '-t' || arg.startsWith('-t='))
      ? ['--pass-with-no-tests'] : []),
    ...bulkArgv,
  ]];
  return [...bulk, ...selectedMocks.map((file) => ['bun', 'test', ...soloArgs, file])];
}

export async function runDeterministicTests(deps: DeterministicRunnerDeps = {}): Promise<number> {
  const makeTemp = deps.mkdtempSync ?? mkdtempSync;
  const tempBase = deps.tmpdir ?? tmpdir;
  const report = deps.report ?? console.error;
  const spawn = deps.spawn ?? defaultSpawn;
  const argv = deps.argv ?? process.argv.slice(2);
  const cwd = deps.cwd ?? process.cwd();
  const config = deps.gitConfig ?? gitConfig;
  const commonDir = config(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir === undefined) throw new Error('git common directory is unset');
  const configFile = join(resolve(cwd, commonDir), 'config');
  const configArgs = ['config', '--file', configFile];
  const watchedKeys = ['core.bare', 'user.name', 'user.email'] as const;
  // Legacy injected gitConfig fixtures supply newline-delimited results and
  // return '' for an absent key. Real Git uses NUL-delimited complete values.
  const readConfig = (key: string): string[] => {
    const value = config(cwd, [...configArgs, '--null', '--get-all', key]);
    if (value === undefined || (deps.gitConfig && value === '')) return [];
    if (deps.gitConfig && !value.includes('\0')) return value.split('\n');
    if (!value.endsWith('\0')) throw new Error(`unterminated git config value for ${key}`);
    return value.slice(0, -1).split('\0');
  };
  const before = new Map(watchedKeys.map((key) => [key, readConfig(key)]));
  let configChanged = false;
  let configChecked = false;
  const checkConfig = (): void => {
    configChecked = true;
    const visible = (values: string[]) => values.length === 0 ? '<unset>' : values.map((value) => value === '' ? '<empty>' : value.replaceAll('\n', ',')).join(',');
    for (const key of watchedKeys) {
      const original = before.get(key)!;
      let after: string[] = ['<unreadable>'];
      try {
        after = readConfig(key);
        if (JSON.stringify(after) === JSON.stringify(original)) continue;
        configChanged = true;
        if (original.length > 0) {
          config(cwd, [...configArgs, '--replace-all', key, original[0]!]);
          for (const value of original.slice(1)) config(cwd, [...configArgs, '--add', key, value]);
        } else {
          config(cwd, [...configArgs, '--unset-all', key]);
        }
        const restored = readConfig(key);
        if (JSON.stringify(restored) !== JSON.stringify(original)) throw new Error(`expected ${visible(original)}, got ${visible(restored)}`);
        report(`[test-deterministic] ${key} changed ${visible(original)} -> ${visible(after)}; restored ${visible(original)}; failing run`);
      } catch (error) {
        configChanged = true;
        report(`[test-deterministic] ${key} changed ${visible(original)} -> ${visible(after)}; restore failed: ${formatError(error)}`);
      }
    }
  };
  // ⛔ 사람이 «경로»를 직접 준 창에서는 아무것도 빼지 않는다 — 그 창은 「이것만 돌려라」다.
  const explicitPaths = partitionBunTestArguments(argv).selectors.length > 0;
  const fullBail = !explicitPaths && bunTestOptionTokens(argv).some((arg) =>
    arg === '--bail' || arg === '--bail=1');
  const testCwd = effectiveTestCwd(argv, cwd);
  const cdpPatterns = explicitPaths ? [] : (deps.deriveCdpPatterns ?? (() => deriveCdpTestPatterns({ cwd: testCwd })))();
  const explicitFiles = classifyExplicitTestFiles(argv, testCwd);
  let discovered: string[] | undefined;
  const discoverTestFiles = (): string[] => discovered ??=
    [...new Set([...(deps.deriveTestFiles ?? (() => deriveTestFiles({ cwd: testCwd })))(), ...explicitFiles.files])];
  // With explicit paths, parse only the files the selectors reach; files that
  // classifyExplicitTestFiles already parsed are not parsed twice.
  const scanMocks = (): string[] => {
    if (!explicitPaths) return deriveMockModuleTestFiles({ cwd: testCwd });
    const classified = new Set(explicitFiles.files);
    const files = selectedTestFiles(argv, discoverTestFiles(), testCwd).filter((file) => !classified.has(file));
    return files.length === 0 ? [] : deriveMockModuleTestFiles({ cwd: testCwd, files });
  };
  const mockFiles = [...new Set([...(deps.deriveMockModuleFiles ?? scanMocks)(), ...explicitFiles.mockFiles])];
  const allTestFiles = (explicitPaths || fullBail) && mockFiles.length > 0 ? discoverTestFiles() : [];
  let commands = planDeterministicTestCommands(argv, cdpPatterns, mockFiles, allTestFiles, testCwd);
  const optionTokens = bunTestOptionTokens(argv);
  // Bun writes these outputs to one caller-selected file. Separate children
  // would overwrite each other, so preserve the caller's single-process run.
  const sharedOutput = optionTokens.some((arg) => arg === '--reporter-outfile' || arg.startsWith('--reporter-outfile='))
    || bunTestOptionValues(argv, '--coverage-reporter').some((value) => value.split(',').includes('lcov'))
    || (optionTokens.includes('--update-timings') && bunTestOptionValues(argv, '--timings').length > 0);
  const sharedOutputFallback = commands.length > 1 && sharedOutput;
  if (sharedOutputFallback) {
    report('[test-deterministic] 공유 파일 출력 옵션: mock.module 분리를 끄고 단일 Bun 시험 프로세스로 실행한다.');
    commands = [['bun', 'test', ...cdpPatterns.flatMap((pattern) => ['--path-ignore-patterns', pattern]), ...argv]];
  }
  const namePatterns = [
    ...bunTestOptionValues(argv, '--test-name-pattern'),
    ...bunTestOptionValues(argv, '-t'),
  ];
  const captureNoMatch = commands.length > 1 && namePatterns.length > 0;
  if (captureNoMatch && explicitPaths && !optionTokens.includes('--pass-with-no-tests')) {
    // Internal --pass-with-no-tests may only neutralize a valid file whose
    // test name missed. It must not turn a nonexistent file filter into pass.
    const unmatched = partitionBunTestArguments(argv).selectors.find((selector) => {
      const path = resolve(testCwd, selector);
      let isDirectory = false;
      try { isDirectory = statSync(path).isDirectory(); } catch { /* a Bun substring filter may still match */ }
      return !allTestFiles.some((file) => {
        const absolute = resolve(testCwd, file);
        return isDirectory ? absolute.startsWith(path + sep)
          : absolute === path || file.includes(selector.replace(/^\.\//, ''));
      });
    });
    if (unmatched !== undefined) {
      report(`[test-deterministic] test selector matched no files: ${unmatched}`);
      return 1;
    }
  }
  const hasShard = optionTokens.some((arg) => arg === '--shard' || arg.startsWith('--shard='));
  const bailArgs = optionTokens.filter((arg) => arg === '--bail' || arg.startsWith('--bail='));
  const stopOnFirstFailure = bailArgs.length > 0 && bailArgs.every((arg) => arg === '--bail' || arg === '--bail=1');
  if (commands.length > 1 && (hasShard || (bailArgs.length > 0 && !stopOnFirstFailure))) {
    report('[test-deterministic] --shard 또는 --bail=1 이외의 실패 한도는 여러 시험 프로세스에서 전역 의미를 보존할 수 없다.');
    return 1;
  }
  if (cdpPatterns.length > 0) {
    report(`[test-deterministic] CDP 시험 ${cdpPatterns.length}개 파일을 뺐다 — bun run test:cdp 로 돈다 (파생: requireCdpBase 직접 import ⊕ 포트 9333 직접 사용).`);
  }
  if (!sharedOutputFallback && commands.some((cmd) => mockFiles.includes(cmd.at(-1) ?? ''))) {
    report('[test-deterministic] mock.module 시험 파일을 각자 단독 프로세스로 실행한다.');
  }

  let testRoot: string | undefined;
  let child: DirectChild | undefined;
  let gate: ShutdownSignalGate | undefined;
  let rootCleanupAttempted = false;

  const cleanupRoot = (): void => {
    if (!testRoot || rootCleanupAttempted) return;
    rootCleanupAttempted = true;
    cleanupTemporaryRoot(testRoot, { rmSync: deps.rmSync, report });
  };

  try {
    testRoot = makeTemp(join(tempBase(), TEMP_ROOT_PREFIX));
    const env = prepareIsolatedTestEnv(deps.env ?? process.env, testRoot);
    gate = deps.waitForSignal
      ? undefined
      : installShutdownSignalGate(deps.signalTarget ?? process, deps.onAbsorbSignal);
    const signalPromise = deps.waitForSignal ? deps.waitForSignal() : gate!.received;

    let exitCode = 0;
    let sawNameMatch = false;
    let sawNameMiss = false;
    for (const cmd of commands) {
      // With a name filter, Bun gives an unmatched child exit 0 only with this
      // flag. A real failed test still exits nonzero; aggregate matches below.
      const childCmd = captureNoMatch && !cmd.includes('--pass-with-no-tests')
        ? [cmd[0]!, cmd[1]!, '--pass-with-no-tests', ...cmd.slice(2)] : cmd;
      child = spawn({
        cmd: childCmd,
        cwd,
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        detached: true,
        captureNoMatch,
        namePatterns,
      });

      const childExit = child.exited.then(
        (code) => ({ kind: 'exit' as const, code }),
        (error) => ({ kind: 'error' as const, error }),
      );
      const outcome = await Promise.race([
        childExit,
        signalPromise.then((signal) => ({ kind: 'signal' as const, signal })),
      ]);

      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.kind === 'exit') {
        const evidence = await child.stderrEvidence;
        const passedTests = evidence?.passSummary && evidence.runSummary;
        if (captureNoMatch && evidence?.nameMissDiagnostic && !passedTests && outcome.code === 0) sawNameMiss = true;
        else if (outcome.code === 0) sawNameMatch = true;
        else exitCode = outcome.code ?? 1;
        child = undefined;
        if (exitCode !== 0 && stopOnFirstFailure) break;
        continue;
      }

      await terminateDirectChild(child, outcome.signal, {
        graceMs: deps.childGraceMs,
        report,
        killProcessGroup: deps.killProcessGroup,
        getProcessGroupId: deps.getProcessGroupId,
      });
      cleanupTemporaryRoot(testRoot, { rmSync: deps.rmSync, report });
      rootCleanupAttempted = true;
      checkConfig();
      gate?.dispose();
      gate = undefined;
      if (deps.killSelf) {
        deps.killSelf(outcome.signal);
        return 1;
      }
      if (!deps.waitForSignal) {
        resignalSelf(outcome.signal, report);
        await new Promise<never>(() => {});
      }
      return 1;
    }
    if (sawNameMiss && !sawNameMatch && exitCode === 0
      && !optionTokens.includes('--pass-with-no-tests')) exitCode = 1;

    cleanupRoot();
    checkConfig();
    return configChanged ? 1 : exitCode;
  } catch (error) {
    if (child) {
      try {
        await terminateDirectChild(child, 'SIGTERM', {
          graceMs: deps.childGraceMs,
          report,
          killProcessGroup: deps.killProcessGroup,
          getProcessGroupId: deps.getProcessGroupId,
        });
      } catch (terminateError) {
        reportVisible(`failed to terminate child after runner error: ${formatError(terminateError)}`, report);
      }
    }
    reportVisible(`deterministic runner failed: ${formatError(error)}`, report);
    throw error;
  } finally {
    gate?.dispose();
    cleanupRoot();
    if (!configChecked) checkConfig();
  }
}

if (import.meta.main) {
  process.exit(await runDeterministicTests());
}
