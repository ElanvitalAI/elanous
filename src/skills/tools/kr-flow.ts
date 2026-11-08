import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: kr_flow_snapshot
//
// Skill-essence extraction of ~/.claude/skills/kr-flow/. The kr-flow
// skill is a Python CLI backed by the 한국투자증권 (Korea Investment)
// API; it prints formatted markdown reports. Rather than re-implement
// the auth + endpoint shapes in TS, this native tool shells out to
// the existing main.py with a few common subcommands exposed.
//
// Probe: KIS_APP_KEY + KIS_APP_SECRET env vars + python3 on PATH +
// the script file at the expected location.
//
// Common commands wrapped:
//   foreign-net  — 외국인 일별 순매수
//   investor     — 5/10/20일 매매동향
//   price        — 현재가 + PER/PBR + 외국인 보유비중
//   ohlcv        — 일별 OHLCV
//   short-sale   — 공매도 일별추이

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';



/** Per-stock commands — require a 6-digit KRX symbol. */
export type KrFlowSymbolCommand = 'foreign-net' | 'investor' | 'price' | 'ohlcv' | 'short-sale' | 'member' | 'estimate';
/** Market-wide commands — no symbol (market-flow takes an optional KSP|KSQ).
 *  Includes derivatives (krx-futures/krx-options — KOSPI200 미결제·풋콜) and
 *  indices (krx-index/krx-deriv-index) for leverage-decision digging. */
export type KrFlowMarketCommand =
  | 'investor-time' | 'market-flow' | 'frgn-institution'
  | 'krx-market' | 'krx-kosdaq' | 'krx-etf'
  | 'krx-futures' | 'krx-options' | 'krx-index' | 'krx-deriv-index';
export type KrFlowCommand = KrFlowSymbolCommand | KrFlowMarketCommand;

export interface KrFlowArgs {
  command?: KrFlowCommand;
  /** 6-digit KRX code — required for per-stock commands. */
  symbol?: string;
  /** Free target for market commands (e.g. KSP|KSQ for market-flow, an
   *  optional stock code for krx-market). Ignored by per-stock commands. */
  target?: string;
  /** Single-date filter for KRX date-scoped commands (derivatives/indices).
   *  YYYYMMDD or omni-market relative (e.g. "-1d"). Passed as `--date`. */
  date?: string;
  /** Emit the skill's structured JSON (`--json`) instead of markdown. For
   *  commands that support it (foreign-net/investor/price/short-sale/member/
   *  investor-time/estimate); others fall back to markdown regardless. */
  json?: boolean;
  timeout_ms?: number;
}

export interface KrFlowResult {
  output: string;
  metadata: {
    symbol: string;
    command: string;
    durationMs: number;
    exitCode: number | null;
  };
  isError?: true;
}

const SYMBOL_COMMANDS: ReadonlyArray<KrFlowSymbolCommand> = [
  'foreign-net', 'investor', 'price', 'ohlcv', 'short-sale', 'member', 'estimate',
];
const MARKET_COMMANDS: ReadonlyArray<KrFlowMarketCommand> = [
  'market-flow', 'frgn-institution', 'investor-time', 'krx-market', 'krx-kosdaq', 'krx-etf',
  'krx-futures', 'krx-options', 'krx-index', 'krx-deriv-index',
];
/** Date-scoped KRX commands accept a `--date` (derivatives + indices). */
const DATE_COMMANDS: ReadonlyArray<KrFlowCommand> = [
  'krx-futures', 'krx-options', 'krx-index', 'krx-deriv-index', 'krx-market', 'krx-kosdaq', 'krx-etf',
];
const VALID_COMMANDS: ReadonlyArray<KrFlowCommand> = [...SYMBOL_COMMANDS, ...MARKET_COMMANDS];
const DEFAULT_COMMAND: KrFlowCommand = 'investor';
const DEFAULT_TIMEOUT_MS = 20_000;
// ★ KRX(date) 명령 기본 타임아웃(2026-07-22) — main.py KRXClient.get 은 timeout=90s(느린 KRX
//   OpenAPI). 종전 elanous 캡 60s 가 그보다 짧아 파생/거래소 명령(krx-*)이 KRX 응답 전 SIGKILL 될
//   수 있었다(자기 관측성상 "python 죽음"으로만 보임). date 명령엔 KRX 90s + 여유를 준다.
const KRX_DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 95_000;

function isSymbolCommand(c: KrFlowCommand): c is KrFlowSymbolCommand {
  return (SYMBOL_COMMANDS as ReadonlyArray<string>).includes(c);
}

function isDateCommand(c: KrFlowCommand): boolean {
  return (DATE_COMMANDS as ReadonlyArray<string>).includes(c);
}

export function buildKrFlowTool(): LLMToolSpec {
  return {
    name: 'KrFlowSnapshot',
    description:
      'Korean stock market investor-flow + derivatives snapshot via 한국투자증권/KRX API. Wraps the ' +
      'kr-flow skill\'s Python CLI. Per-stock (needs 6-digit `symbol`): foreign-net (외국인 일별 순매수), ' +
      'investor (5/10/20일 매매동향), price (현재가+PER/PBR+외국인보유비중), ohlcv (일별 OHLCV), ' +
      'short-sale (공매도 일별추이), member (거래원/외국계 추정), estimate (외인/기관 차수별 장중 추정 09:30~14:30). ' +
      'Market-wide (no symbol): market-flow (시장별 투자자매매동향, `target` KSP|KSQ), frgn-institution ' +
      '(외국인/기관 매매종목 장중 가집계), investor-time (KOSPI 12주체 세분류 장중), krx-market/krx-kosdaq/krx-etf ' +
      '(거래소 일별매매 TOP20). DERIVATIVES (leverage digging): krx-futures (KOSPI200 선물 미결제약정), ' +
      'krx-options (옵션 미결제 + 풋콜레이쇼 심리지표), krx-index (KOSPI 시리즈 지수), krx-deriv-index (파생지수). ' +
      'For a leverage decision: cross-read spot flow (frgn-institution/estimate) vs derivatives (krx-futures OI + ' +
      'krx-options put/call) — spot foreign flow alone can mislead (a futures-driven program sell shows in ' +
      'derivatives, not spot investor tables). Symbol is the 6-digit KRX code (e.g. 005930 for 삼성전자).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: [...VALID_COMMANDS],
          description: `Subcommand. Default ${DEFAULT_COMMAND}. Per-stock: ${SYMBOL_COMMANDS.join('|')}. Market-wide: ${MARKET_COMMANDS.join('|')}.`,
        },
        symbol: { type: 'string', description: '6-digit KRX symbol code (e.g. "005930"). Required for per-stock commands.' },
        target: { type: 'string', description: 'Market command target (e.g. "KSP" or "KSQ" for market-flow). Optional.' },
        date: { type: 'string', description: 'Single-date filter for KRX date-scoped commands (krx-futures/krx-options/krx-index/krx-deriv-index/krx-market). YYYYMMDD or relative (e.g. "-1d"). Optional — omit for latest.' },
        json: { type: 'boolean', description: 'Return the skill\'s structured JSON instead of markdown (for commands that support it: foreign-net/investor/price/short-sale/member/investor-time/estimate). Default false (markdown).' },
        timeout_ms: {
          type: 'integer',
          description: `Timeout for the python subprocess (ms). Default ${DEFAULT_TIMEOUT_MS} (KRX/derivative 'krx-*' commands ${KRX_DEFAULT_TIMEOUT_MS} — slow KRX OpenAPI), capped ${MAX_TIMEOUT_MS}.`,
        },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

export async function dispatchKrFlow(rawArgs: Record<string, unknown>): Promise<KrFlowResult> {
  const args = validate(rawArgs);
  const command = args.command ?? DEFAULT_COMMAND;
  // KRX(date) 명령은 느린 KRX OpenAPI(90s)라 기본 타임아웃을 높인다(그 외 20s). 명시 timeout_ms 우선.
  const defaultTimeout = isDateCommand(command) ? KRX_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(args.timeout_ms ?? defaultTimeout, MAX_TIMEOUT_MS);
  const label = args.symbol ?? args.target ?? '';
  const start = Date.now();

  if (!krFlowAvailable()) {
    return {
      output: 'kr_flow_snapshot unavailable: requires KIS_APP_KEY + KIS_APP_SECRET (env or ' +
              '~/.claude/skills/kr-flow/.env) + python3 + ~/.claude/skills/kr-flow/scripts/main.py present.',
      metadata: { symbol: label, command, durationMs: 0, exitCode: null },
      isError: true,
    };
  }

  // Per-stock → [command, symbol]; market-wide → [command] or [command, target].
  const cliArgs = isSymbolCommand(command)
    ? [command, args.symbol as string]
    : args.target ? [command, args.target] : [command];
  // Date filter (KRX date-scoped commands only) + structured JSON output.
  if (args.date && isDateCommand(command)) cliArgs.push('--date', args.date);
  if (args.json) cliArgs.push('--json');

  const scriptPath = krFlowScriptPath();
  const result = await runPython(scriptPath, cliArgs, timeoutMs);

  const isError = result.exitCode !== 0;
  return {
    output: isError
      ? `kr_flow_snapshot ${command} ${label} failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`
      : result.stdout,
    metadata: {
      symbol: label,
      command,
      durationMs: Date.now() - start,
      exitCode: result.exitCode,
    },
    ...(isError ? { isError: true } as const : {}),
  };
}

/** kr-flow skill's `.env` (KIS/KRX creds). The daemon process does NOT carry
 *  these vars, so we load the skill's own .env and merge it into the python
 *  subprocess env — mirrors the toss `conatusEnv()` pattern. Fail-soft: an
 *  unreadable file yields {} (probe/dispatch then report unavailable). */
export function krFlowEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(krFlowEnvPath(), 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* fail-soft */ }
  return env;
}

/** Probe-compatible check — creds may come from the process env OR the
 *  skill's own .env (which the daemon does not inherit). */
export function krFlowAvailable(): boolean {
  if (!existsSync(krFlowScriptPath())) return false;
  if (process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) return true;
  const e = krFlowEnv();
  return !!(e.KIS_APP_KEY && e.KIS_APP_SECRET);
}

function krFlowScriptPath(): string {
  return process.env.KR_FLOW_SCRIPT
    ?? joinPath(homedir(), '.claude', 'skills', 'kr-flow', 'scripts', 'main.py');
}

function krFlowEnvPath(): string {
  return process.env.KR_FLOW_ENV
    ?? joinPath(homedir(), '.claude', 'skills', 'kr-flow', '.env');
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runPython(script: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn('python3', [script, ...args], {
      // Do NOT inject the skill's .env here: main.py self-loads SKILL_DIR/.env
      // (cwd-independent) AND manages its own KIS token lifecycle (reads the
      // cached token, refreshes on expiry, rewrites .env). Injecting KIS_TOKEN
      // would pin a possibly-rotated/stale token (KIS = 1 token per client),
      // which main.py — preferring os.environ over the file — would then use,
      // yielding a 500. Pass only the ambient env; creds come from the file.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        exitCode: code,
      });
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: String(e instanceof Error ? e.message : e),
        exitCode: null,
      });
    });
  });
}

function validate(raw: Record<string, unknown>): KrFlowArgs {
  const rawCmd = raw.command;
  if (rawCmd !== undefined && !VALID_COMMANDS.includes(rawCmd as KrFlowCommand)) {
    throw new Error(`'command' must be one of ${VALID_COMMANDS.join('|')}`);
  }
  const command = (rawCmd as KrFlowCommand | undefined) ?? DEFAULT_COMMAND;

  const timeoutMs = raw.timeout_ms;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
    throw new Error(`'timeout_ms' must be a positive number`);
  }

  const date = typeof raw.date === 'string' && raw.date.trim() ? raw.date.trim() : undefined;
  const json = raw.json === true;

  if (isSymbolCommand(command)) {
    const symbol = raw.symbol;
    if (typeof symbol !== 'string' || !/^[0-9]{6}$/.test(symbol)) {
      throw new Error(`'${command}' requires 'symbol' as a 6-digit KRX code (e.g. "005930")`);
    }
    return { command, symbol, date, json, timeout_ms: timeoutMs as number | undefined };
  }

  // Market-wide command: optional free target (accept `target`, or fall back
  // to `symbol` if the model put it there). Not validated as 6-digit.
  const target = typeof raw.target === 'string' ? raw.target
    : typeof raw.symbol === 'string' ? raw.symbol : undefined;
  return { command, target, date, json, timeout_ms: timeoutMs as number | undefined };
}
