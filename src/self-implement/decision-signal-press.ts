import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkWorktreeDependencies } from '../git-fs/worktree.js';
import { runGitCommand } from '../git-fs/runner.js';
import { extractGateTestFailures } from './gate-baseline.js';
import { defaultBranchRef } from './seams.js';

export type DecisionSignalPress<Classification, Result> = (
  classifications: Classification,
) => Result | Promise<Result>;

/**
 * Delivers already-classified decision-signal output to an execution policy.
 *
 * Classification belongs to the producer: this executor intentionally neither
 * accepts source text nor derives a verdict from the supplied measurements.
 */
export function pressDecisionSignal<Classification, Result>(
  classifications: Classification,
  press: DecisionSignalPress<Classification, Result>,
): Result | Promise<Result> {
  return press(classifications);
}

export type DecisionSignalCommand = {
  readonly signal: string;
  readonly command?: string;
  readonly kind: 'unit-test' | 'real' | 'unresolved';
};

export type DecisionSignalPressInput<Kind = unknown, Observation = unknown> = {
  /** Existing classifier/parser output. This executor does not reclassify source text. */
  readonly kinds: Kind;
  readonly observations: Observation;
  readonly signals: readonly DecisionSignalCommand[];
};

export type DecisionSignalNotPressed = DecisionSignalCommand & {
  readonly reason: 'unresolved' | 'unsafe-command' | 'timed-out' | 'start-failed';
  readonly error?: string;
};

export type DecisionSignalPressResult<Kind = unknown, Observation = unknown> = {
  /** The supplied classification is ledger-safe context for the observations below. */
  readonly classification: { readonly kinds: Kind; readonly observations: Observation };
  readonly pressedGreen: readonly DecisionSignalPressed[];
  readonly pressedRed: readonly DecisionSignalPressedRed[];
  /** Non-zero presses whose every extracted failure name also failed on the baseline. Does not block merge. */
  readonly pressedBaselineOnly: readonly DecisionSignalPressedBaselineOnly[];
  readonly unpressed: readonly DecisionSignalNotPressed[];
  readonly pressedCount: number;
};

export type DecisionSignalPressed = Required<Omit<DecisionSignalCommand, 'kind'>> & {
  readonly exitCode: number;
  readonly stdout: string;
  readonly durationMs: number;
};

export type DecisionSignalPressedRed = DecisionSignalPressed & {
  /** Total matches from a pathless re-press, when an `rg -c` zero-match can be counted. */
  readonly widerMatchCount?: number;
  /** Why a non-zero press stayed red instead of moving to the baseline-only bucket. */
  readonly baselineReason?: string;
};

export type DecisionSignalPressedBaselineOnly = DecisionSignalPressed & {
  readonly baselineFailedNames: readonly string[];
};

/** Same command, run against a baseline tree. Throw or time out to keep the signal red. */
export type DecisionSignalBaselineRun = (
  command: SafeCommand,
  cwd: string,
) => { readonly stdout: string; readonly stderr?: string };

export type DecisionSignalPressOptions = {
  readonly baselineRun?: DecisionSignalBaselineRun;
  /** Resolves the merge-base commit. Default reads the repo's default branch. */
  readonly mergeBaseRef?: (cwd: string) => string | undefined;
};

export type SafeCommand = { readonly executable: 'bun' | 'rg'; readonly args: readonly string[] };

export type DecisionSignalCommandRejection = {
  readonly reason: 'shell-syntax-mixed' | 'ambiguous-rg-c-arguments' | 'not-allowlisted';
};

type ParsedDecisionSignalCommand = SafeCommand | DecisionSignalCommandRejection | undefined;

const MAX_STDOUT_CHARS = 16_000;
const SHELL_SYNTAX = /[|&;<>`$(){}\\\n\r]/;

function parseArgv(command: string): readonly string[] | undefined {
  const args: string[] = [];
  let cursor = 0;

  while (cursor < command.length) {
    while (/\s/.test(command[cursor] ?? '')) cursor++;
    if (cursor === command.length) break;

    const quote = command[cursor];
    if (quote === "'" || quote === '"') {
      const closing = command.indexOf(quote, cursor + 1);
      if (closing < 0 || /['"]/.test(command.slice(cursor + 1, closing)) || !(/\s/.test(command[closing + 1] ?? '') || closing + 1 === command.length)) {
        return undefined;
      }
      const quoted = command.slice(cursor + 1, closing);
      args.push(quoted);
      cursor = closing + 1;
      continue;
    }

    const nextWhitespace = command.slice(cursor).search(/\s/);
    const end = nextWhitespace < 0 ? command.length : cursor + nextWhitespace;
    const arg = command.slice(cursor, end);
    if (/['"]/.test(arg)) return undefined;
    args.push(arg);
    cursor = end;
  }

  return args;
}

/** Parses only declared read-only command forms into argv; no shell is ever invoked. */
export function parseSafeDecisionSignalCommand(command: string): ParsedDecisionSignalCommand {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (SHELL_SYNTAX.test(trimmed)) return { reason: 'shell-syntax-mixed' };

  const argv = parseArgv(trimmed);
  if (argv === undefined) return { reason: 'shell-syntax-mixed' };
  const [executable, ...args] = argv;

  if (executable === 'bun' && args[0] === 'test' && args.length > 1) {
    return { executable, args };
  }

  if (
    executable === 'bun' &&
    args[0] === 'scripts/ask-marker-check.ts' &&
    args.length > 1
  ) {
    return { executable, args };
  }

  if (executable === 'rg' && args[0] === '-c') {
    if (args.length > 3) return { reason: 'ambiguous-rg-c-arguments' };
    if (args.length > 2) return { executable, args };
  }

  if (executable === 'bun' && args[0] === 'bin/elanous.mjs') {
    const elanousArgs = args.slice(1);
    const [command, subcommand, reference, output] = elanousArgs;
    // METHOD v116(🅢 · 2026-09-26): 그래프 원장 값 신호(`pipeline-node-entry`·`graph.heal` 등)는 `--event` 로 읽는다 — v115 가 권한 모양.
    const logsObservation =
      command === 'logs' &&
      (elanousArgs.includes('--category') || elanousArgs.includes('--event')) &&
      (elanousArgs.includes('--json') || elanousArgs.includes('--json-data'));
    // 그래프 판 상태 «읽기»만 — `graph run` 은 dry-run 이어도 실행 상태 파일을 쓰므로 받지 않는다.
    const graphStatus = command === 'graph' && subcommand === 'status' && reference !== undefined && output === '--json' && elanousArgs.length === 4;
    const ptySnapshot = command === 'pty' && subcommand === 'snapshot' && reference !== undefined && elanousArgs.length === 3;
    const ptyLineage =
      command === 'pty' &&
      subcommand === 'lineage' &&
      reference !== undefined &&
      output === '--json' &&
      elanousArgs.length === 4;
    const selfObservation =
      command === 'self' &&
      (subcommand === 'entrances' || subcommand === 'running-runs') &&
      reference === '--json' &&
      elanousArgs.length === 3;

    if (logsObservation || graphStatus || ptySnapshot || ptyLineage || selfObservation) {
      return { executable, args };
    }
  }

  return { reason: 'not-allowlisted' };
}

function isSafeDecisionSignalCommand(command: ParsedDecisionSignalCommand): command is SafeCommand {
  return command !== undefined && !('reason' in command);
}

function widerRgMatchCount(command: SafeCommand, exitCode: number, cwd: string): number | undefined {
  if (command.executable !== 'rg' || command.args[0] !== '-c' || command.args.length !== 3 || exitCode !== 1) return undefined;

  const result = spawnSync('rg', ['-c', command.args[1]!], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: MAX_STDOUT_CHARS,
  });
  if (result.error || result.status === null || (result.status !== 0 && result.status !== 1)) return undefined;

  const stdout = result.stdout ?? '';
  if (stdout.length > MAX_STDOUT_CHARS) return undefined;
  if (result.status === 1) return stdout === '' ? 0 : undefined;

  const matchingFiles = stdout.trimEnd().split('\n');
  for (const line of matchingFiles) {
    const count = Number(line.slice(line.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(count) || count < 1) return undefined;
  }
  return matchingFiles.length;
}

const BUN_FAIL_LINE_RE = /^\s*\(fail\)\s+(.+?)\s*$/u;

function failureNames(output: string): readonly string[] {
  // Reuse gate-baseline's extractor, then keep Bun `(fail)` lines only (not ✗/×).
  const bunFailNames = new Set(
    output.split('\n').flatMap((line) => {
      const match = line.match(BUN_FAIL_LINE_RE);
      return match?.[1] ? [match[1].replace(/\s+\[[\d.]+m?s\]$/, '').trim()] : [];
    }),
  );
  // ⛔ 실제 `bun test` 출력엔 파일 머리줄(`src/x.test.ts:`)이 있어 추출기가 이름 앞에 `<파일> > ` 를 붙인다 —
  //   `(fail)` 줄 이름엔 그 접두가 없다. 접두를 벗겨 대조한다(🩸 #20114 착지 직후 실물: 교집합이 늘 0 이었다).
  return extractGateTestFailures(output)
    .filter((failure) => {
      const bare = failure.file && failure.name.startsWith(`${failure.file} > `)
        ? failure.name.slice(`${failure.file} > `.length)
        : failure.name;
      return bunFailNames.has(failure.name) || bunFailNames.has(bare);
    })
    .map((failure) => failure.name);
}

function resolveMergeBaseRef(cwd: string): string | undefined {
  const base = defaultBranchRef(cwd);
  if (!base) return undefined;
  const result = runGitCommand(cwd, ['merge-base', 'HEAD', base], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) return undefined;
  const ref = (result.stdout ?? '').trim().split('\n')[0]?.trim();
  return ref || undefined;
}

function runCommandOnMergeBaseWorktree(
  command: SafeCommand,
  cwd: string,
  mergeBaseRef: (cwd: string) => string | undefined,
): { readonly stdout: string; readonly stderr?: string } {
  const ref = mergeBaseRef(cwd);
  if (!ref) throw new Error('merge-base ref unavailable');
  const baselineDir = mkdtempSync(join(tmpdir(), 'elanous-decision-signal-baseline-'));
  let attached = false;
  try {
    const add = runGitCommand(cwd, ['worktree', 'add', '--detach', baselineDir, ref], { encoding: 'utf8', timeout: 60_000 });
    if (add.status !== 0) {
      throw new Error((add.stderr ?? add.stdout ?? 'baseline worktree add failed').trim() || 'baseline worktree add failed');
    }
    attached = true;
    linkWorktreeDependencies(cwd, baselineDir, ['node_modules']);
    const result = spawnSync(command.executable, command.args, {
      cwd: baselineDir,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.status === null) {
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      throw new Error(timedOut ? `baseline timed out: ${result.error?.message ?? 'ETIMEDOUT'}` : (result.error?.message ?? String(result.signal ?? 'baseline process did not start')));
    }
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    if (attached) runGitCommand(cwd, ['worktree', 'remove', '--force', baselineDir], { encoding: 'utf8', timeout: 60_000 });
    rmSync(baselineDir, { recursive: true, force: true });
  }
}

function classifyNonZeroPress(
  pressed: DecisionSignalPressed,
  safe: SafeCommand,
  cwd: string,
  options: DecisionSignalPressOptions | undefined,
  postOutput: string,
): { readonly bucket: 'red'; readonly entry: DecisionSignalPressedRed } | { readonly bucket: 'baseline-only'; readonly entry: DecisionSignalPressedBaselineOnly } {
  // ⛔ `bun test` 는 `(fail)` 줄을 «stderr» 로 찍는다 — 잘린 stdout(pressed.stdout)만 읽으면 이름을 «한 번도» 못 뽑아
  //   기존 실패뿐인 신호도 늘 빨강이었다(#20114 착지 직후 실물: dev-cli.test.ts 의 기존 3 fail → 「names could not be extracted」).
  //   기준선 쪽(아래)과 «같은» 모양으로 stdout ⊕ stderr 전체를 읽는다.
  const postNames = failureNames(postOutput);
  if (postNames.length === 0) {
    return { bucket: 'red', entry: { ...pressed, baselineReason: 'failed-test names could not be extracted' } };
  }
  const baselineRun = options?.baselineRun ?? ((command, baselineCwd) => runCommandOnMergeBaseWorktree(command, baselineCwd, options?.mergeBaseRef ?? resolveMergeBaseRef));
  let baseline: { readonly stdout: string; readonly stderr?: string };
  try {
    baseline = baselineRun(safe, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { bucket: 'red', entry: { ...pressed, baselineReason: message || 'baseline run failed' } };
  }
  const baselineNames = new Set(failureNames(`${baseline.stdout ?? ''}\n${baseline.stderr ?? ''}`));
  const introduced = postNames.filter((name) => !baselineNames.has(name));
  if (introduced.length > 0 || baselineNames.size === 0) {
    return {
      bucket: 'red',
      entry: {
        ...pressed,
        baselineReason: introduced.length > 0
          ? `baseline passed: ${introduced.join(', ')}`
          : 'failed-test names could not be extracted from baseline',
      },
    };
  }
  return { bucket: 'baseline-only', entry: { ...pressed, baselineFailedNames: postNames } };
}

/** Executes only parser-classified, argv-safe observations without reclassifying source text. */
export function pressDecisionSignals<Kind, Observation>(
  input: DecisionSignalPressInput<Kind, Observation>,
  cwd: string,
  options?: DecisionSignalPressOptions,
): DecisionSignalPressResult<Kind, Observation> {
  const pressedGreen: DecisionSignalPressed[] = [];
  const pressedRed: DecisionSignalPressedRed[] = [];
  const pressedBaselineOnly: DecisionSignalPressedBaselineOnly[] = [];
  const unpressed: DecisionSignalNotPressed[] = [];

  for (const signal of input.signals) {
    if (!signal.command || signal.kind === 'unresolved') {
      unpressed.push({ ...signal, reason: 'unresolved' });
      continue;
    }

    const safe = parseSafeDecisionSignalCommand(signal.command);
    if (!isSafeDecisionSignalCommand(safe)) {
      unpressed.push({ ...signal, reason: 'unsafe-command' });
      continue;
    }

    const startedAt = Date.now();
    const result = spawnSync(safe.executable, safe.args, {
      cwd,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    if (result.error || result.status === null) {
      unpressed.push({
        ...signal,
        reason: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'timed-out' : 'start-failed',
        error: String(
          result.error?.message ?? result.signal ?? 'process did not start',
        ),
      });
      continue;
    }

    const pressed: DecisionSignalPressed = {
      signal: signal.signal,
      command: signal.command,
      exitCode: result.status,
      stdout: (result.stdout ?? '').slice(-MAX_STDOUT_CHARS),
      durationMs: Date.now() - startedAt,
    };

    if (result.status === 0) {
      pressedGreen.push(pressed);
    } else {
      const widerMatchCount = widerRgMatchCount(safe, result.status, cwd);
      const withWider = { ...pressed, ...(widerMatchCount === undefined ? {} : { widerMatchCount }) };
      if (safe.executable === 'bun' && safe.args[0] === 'test') {
        const classified = classifyNonZeroPress(pressed, safe, cwd, options, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        if (classified.bucket === 'baseline-only') pressedBaselineOnly.push(classified.entry);
        else pressedRed.push({ ...classified.entry, ...(widerMatchCount === undefined ? {} : { widerMatchCount }) });
      } else {
        pressedRed.push(withWider);
      }
    }
  }

  return {
    classification: { kinds: input.kinds, observations: input.observations },
    pressedGreen,
    pressedRed,
    pressedBaselineOnly,
    unpressed,
    pressedCount: pressedGreen.length + pressedRed.length + pressedBaselineOnly.length,
  };
}
