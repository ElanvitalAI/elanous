import { spawn, spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';

const LF = 0x0a;
const MAX_GH_RETRY_ATTEMPTS = 3;

function asBuffer(chunk: Buffer | string | null | undefined): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.alloc(0);
}

function commandLabel(args: string[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    parts.push(arg);
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '(none)';
}

function optionValue(args: string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    for (const name of names) {
      if (arg === name) return args[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function requestMethod(args: string[]): string | undefined {
  const separated = optionValue(args, ['--method', '-X']);
  if (separated !== undefined) return separated.toUpperCase();
  const combined = args.find((arg) => /^-X.+/.test(arg));
  return combined?.slice(2).toUpperCase();
}

function hasImplicitPostField(args: string[]): boolean {
  return args.some((arg) => (
    arg === '-f'
    || arg === '-F'
    || arg.startsWith('-f')
    || arg.startsWith('-F')
    || arg === '--raw-field'
    || arg.startsWith('--raw-field=')
    || arg === '--field'
    || arg.startsWith('--field=')
  ));
}

function isReadOnlyGhCall(args: string[]): boolean {
  const method = requestMethod(args);
  if (method !== undefined) return method === 'GET' || method === 'HEAD';
  if (hasImplicitPostField(args)) return false;
  return args[0] === 'api' || (args[0] === 'pr' && args[1] === 'list');
}

function isTransientGhError(output: Buffer): boolean {
  return /\b(?:408|429|500|502|503|504)\b|timeout|temporar(?:y|ily)|connection reset|network.*(?:error|unreachable)|rate limit/i.test(output.toString('utf8'));
}

function itemCount(stdout: Buffer): number | undefined {
  const text = stdout.toString('utf8').trim();
  if (!text) return 0;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length;
  } catch {
    // Non-JSON output is counted as non-empty lines below.
  }
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function limitValue(args: string[]): number | undefined {
  const separated = optionValue(args, ['--limit', '-L']);
  const raw = separated ?? args.find((arg) => /^-L\d+$/.test(arg))?.slice(2);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

type AuxiliaryFailureSignature = {
  label: string;
  /** Local branch deletion is separate from the remote pull-request merge operation. */
  pattern: RegExp;
};

const AUXILIARY_FAILURE_SIGNATURES: readonly AuxiliaryFailureSignature[] = [
  {
    label: 'local-branch-delete',
    // Local branch deletion is separate from the remote pull-request merge operation.
    pattern: /failed to delete local branch\b/i,
  },
];

function auxiliaryFailureSignature(stderr: Buffer): AuxiliaryFailureSignature | undefined {
  return AUXILIARY_FAILURE_SIGNATURES.find(({ pattern }) => pattern.test(stderr.toString('utf8')));
}

function outcomeName(result: GhCliResult): 'ok OUTPUT' | 'ok EMPTY' | 'ok MAYBE_TRUNCATED' | 'FAILED' {
  if (!result.ok) return 'FAILED';
  if (result.maybeTruncated) return 'ok MAYBE_TRUNCATED';
  return (result.itemCount ?? (result.stdout.length === 0 ? 0 : 1)) === 0 ? 'ok EMPTY' : 'ok OUTPUT';
}

function statusLine(label: string, result: GhCliResult, auxiliaryFailure?: AuxiliaryFailureSignature): string {
  const outcome = outcomeName(result);
  if (outcome === 'FAILED' && auxiliaryFailure) return `[gh] ${label} PARTIAL_OUTCOME primary-outcome=UNCONFIRMED auxiliary-failure=${auxiliaryFailure.label} rc=${result.exitCode}`;
  if (outcome === 'FAILED') return `[gh] ${label} FAILED rc=${result.exitCode}`;
  if (outcome === 'ok MAYBE_TRUNCATED') return `[gh] ${label} ok MAYBE_TRUNCATED limit=${result.limit} count=${result.itemCount} rc=0`;
  return `[gh] ${label} ${outcome} rc=0`;
}

export type GhCliResult = {
  ok: boolean;
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  maybeTruncated: boolean;
  itemCount?: number;
  limit?: number;
};

function ghResult(args: string[], stdout: Buffer, stderr: Buffer, status: number | null): GhCliResult {
  const exitCode = status ?? 1;
  const count = itemCount(stdout);
  const limit = limitValue(args);
  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    maybeTruncated: exitCode === 0 && limit !== undefined && count !== undefined && count === limit,
    ...(count === undefined ? {} : { itemCount: count }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** One retry decision for both the blocking and the async gateway. */
function shouldRetry(args: string[], attempt: number, stdout: Buffer, stderr: Buffer, status: number | null): boolean {
  const exitCode = status ?? 1;
  return !(exitCode === 0 || !isReadOnlyGhCall(args) || attempt === MAX_GH_RETRY_ATTEMPTS || !isTransientGhError(Buffer.concat([stderr, stdout])));
}

/** Executes gh through the retry gateway and returns its raw stdout with outcome metadata. */
export function runGhCliWithResult(args: string[]): GhCliResult {
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let status: number | null = null;
  for (let attempt = 1; attempt <= MAX_GH_RETRY_ATTEMPTS; attempt++) {
    const result = spawnSync('gh', args, { maxBuffer: Infinity });
    stdout = asBuffer(result.stdout);
    stderr = asBuffer(result.stderr);
    status = result.status;
    if (!shouldRetry(args, attempt, stdout, stderr, status)) break;
  }
  return ghResult(args, stdout, stderr, status);
}

function spawnGh(args: string[]): Promise<{ stdout: Buffer; stderr: Buffer; status: number | null }> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try { child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(String(e)), status: null }); return; }
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', (e) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat([...err, Buffer.from(String(e))]), status: null }));
    child.once('close', (code) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), status: code }));
  });
}

/** Same gateway without blocking the event loop — for daemon request handlers. */
export async function runGhCliWithResultAsync(args: string[]): Promise<GhCliResult> {
  let last: { stdout: Buffer; stderr: Buffer; status: number | null } = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null };
  for (let attempt = 1; attempt <= MAX_GH_RETRY_ATTEMPTS; attempt++) {
    last = await spawnGh(args);
    if (!shouldRetry(args, attempt, last.stdout, last.stderr, last.status)) break;
  }
  return ghResult(args, last.stdout, last.stderr, last.status);
}

/** Executes gh while preserving its byte streams and appending a pipe-visible outcome.
 *  ⛔⭐⭐ **재시도·절단 판정을 «다시 쓰지 않는다»** — `runGhCliWithResult` 를 그대로 탄다(2026-08-09).
 *    초판은 같은 spawn·재시도 루프를 «둘»로 복제해 뒀고, 그러면 한쪽만 고쳐질 때 조용히 갈린다. */
export function runGhCli(args: string[]): void {
  const startedAt = performance.now();
  const result = runGhCliWithResult(args);
  const { stdout, stderr, exitCode } = result;
  const label = commandLabel(args);
  const outcome = outcomeName(result);
  const auxiliaryFailure = exitCode === 0 ? undefined : auxiliaryFailureSignature(stderr);

  if (stdout.length) process.stdout.write(stdout);
  if (stderr.length) process.stderr.write(stderr);
  // ⛔⭐⭐⭐⭐⭐ **상태 줄은 `stderr` 로** — `git-cli.ts` 의 같은 주석이 canonical.
  //   `--json` 산출 뒤에 비-JSON 한 줄이 붙으면 ***모든 JSON 소비자가 죽는다***(`jq: parse error` 실측).
  //   stdout 은 ***원 바이트 그대로만*** 나간다.
  const endsWithoutLf = (buffer: Buffer): boolean => buffer.length > 0 && buffer[buffer.length - 1] !== LF;
  if (endsWithoutLf(stderr)) process.stderr.write('\n');

  process.stderr.write(`${statusLine(label, result, auxiliaryFailure)}\n`);
  process.exitCode = exitCode;
  if (auxiliaryFailure) {
    debug.log('gh.cli', 'partial-outcome', {
      subcommand: label,
      exitCode,
      auxiliaryFailure: auxiliaryFailure.label,
    });
  }
  debug.log('gh.cli', 'completed', {
    subcommand: label,
    exitCode,
    ok: result.ok,
    durationMs: Math.round(performance.now() - startedAt),
    outcome,
  });
}
