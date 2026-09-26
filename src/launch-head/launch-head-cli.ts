import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { checkCapability, readTargetPaths, type CapabilityCheckResult } from './capability-check.js';
import { rankMachines, type RankMachinesResult } from './load-balance.js';
import type { ResourceView } from '../control-plane/ledger.js';

export interface CapabilityCliIo {
  readFile: (path: string) => string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface CapabilityCliOutcome {
  code: number;
  result?: CapabilityCheckResult;
  error?: string;
}

const GRAPH_CONTEXT_ENV = 'ELANOUS_GRAPH_CONTEXT';

function defaultIo(): CapabilityCliIo {
  return {
    readFile: (path) => readFileSync(path, 'utf8'),
    env: process.env,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

function goalPathFromContext(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const input = (parsed as { input?: unknown }).input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const goalPath = (input as { goal_path?: unknown }).goal_path;
  return typeof goalPath === 'string' && goalPath.trim() ? goalPath : undefined;
}

/** 사람용 한 줄. JSON 은 호출자가 마지막 줄에 따로 찍는다. */
export function formatCapabilityLine(result: CapabilityCheckResult): string {
  const why = result.reasons.length > 0 ? result.reasons.join(' · ') : '(이유 없음)';
  return `capability: ${result.outcome} (required: ${result.required.join(', ') || '없음'}) — ${why}`;
}

/**
 * `elanous launch-head capability [--goal <경로>]`.
 * `--goal` 이 없으면 `ELANOUS_GRAPH_CONTEXT` 파일의 `input.goal_path` 를 읽는다.
 * 골 파일을 못 읽으면 rc 2 이고 `any` 를 내지 않는다.
 */
export function runCapabilityCheck(args: readonly string[], io: CapabilityCliIo = defaultIo()): CapabilityCliOutcome {
  let goalFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--goal') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        const error = 'launch-head capability: --goal 뒤에 골 경로가 없다';
        io.error(error);
        return { code: 2, error };
      }
      goalFlag = value;
      i++;
    } else if (arg.startsWith('--goal=')) {
      const value = arg.slice('--goal='.length).trim();
      if (!value) {
        const error = 'launch-head capability: --goal 뒤에 골 경로가 없다';
        io.error(error);
        return { code: 2, error };
      }
      goalFlag = value;
    }
  }

  let goalPath = goalFlag;
  if (!goalPath) {
    const contextPath = io.env[GRAPH_CONTEXT_ENV];
    if (!contextPath || !contextPath.trim()) {
      const error = `launch-head capability: --goal 이 없고 ${GRAPH_CONTEXT_ENV} 도 없다`;
      io.error(error);
      return { code: 2, error };
    }
    let contextRaw: string;
    try {
      contextRaw = io.readFile(contextPath);
    } catch (error) {
      const message = `launch-head capability: ${GRAPH_CONTEXT_ENV} 파일을 못 읽음 (${contextPath}): ${error instanceof Error ? error.message : String(error)}`;
      io.error(message);
      return { code: 2, error: message };
    }
    goalPath = goalPathFromContext(contextRaw);
    if (!goalPath) {
      const error = `launch-head capability: ${GRAPH_CONTEXT_ENV} 에 input.goal_path 가 없다`;
      io.error(error);
      return { code: 2, error };
    }
  }

  let goalText: string;
  try {
    goalText = io.readFile(goalPath);
  } catch (error) {
    const message = `launch-head capability: 골 파일을 못 읽음 (${goalPath}): ${error instanceof Error ? error.message : String(error)}`;
    io.error(message);
    return { code: 2, error: message };
  }

  const result = checkCapability({ goalText, targetPaths: readTargetPaths(goalText) });
  io.log(formatCapabilityLine(result));
  io.log(JSON.stringify({ outcome: result.outcome, required: result.required, reasons: result.reasons }));
  return { code: 0, result };
}

export interface BalanceCliIo extends CapabilityCliIo {
  instanceRoot: () => string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

export interface BalanceCliOutcome {
  code: number;
  result: RankMachinesResult;
}

function defaultBalanceIo(): BalanceCliIo {
  return { ...defaultIo(), instanceRoot: effectiveInstanceRoot, fetch: globalThis.fetch, now: Date.now };
}

function requiredFromContext(raw: string): string[] {
  const context: unknown = JSON.parse(raw);
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('outputs.capability.required 없음');
  const outputs = (context as Record<string, unknown>).outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) throw new Error('outputs.capability.required 없음');
  const capability = (outputs as Record<string, unknown>).capability;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) throw new Error('outputs.capability.required 없음');
  const required = (capability as Record<string, unknown>).required;
  if (!Array.isArray(required) || !required.every((value) => typeof value === 'string')) {
    throw new Error('outputs.capability.required 없음 또는 잘못된 형식');
  }
  return required as string[];
}

/** `elanous launch-head balance [--json]`: the control ledger is the only machine source. */
export async function runLoadBalance(_args: readonly string[], io: BalanceCliIo = defaultBalanceIo()): Promise<BalanceCliOutcome> {
  const emit = (result: RankMachinesResult, code: number): BalanceCliOutcome => {
    io.log(`balance: ${result.outcome} — ${result.reasons.join(' · ') || `후보 ${result.candidates.length}대`}`);
    io.log(JSON.stringify(result));
    return { code, result };
  };
  let required: string[];
  try {
    const contextPath = io.env[GRAPH_CONTEXT_ENV];
    if (!contextPath) throw new Error(`${GRAPH_CONTEXT_ENV} 없음`);
    required = requiredFromContext(io.readFile(contextPath));
  } catch (error) {
    const reason = `그래프 문맥 오류: ${error instanceof Error ? error.message : String(error)}`;
    io.error(`launch-head balance: ${reason}`);
    return emit({ outcome: 'skipped', candidates: [], reasons: [reason] }, 2);
  }

  let query: string;
  let port: number;
  try {
    const tokens: unknown = JSON.parse(io.readFile(join(io.instanceRoot(), 'control', 'tokens.json')));
    const value = tokens && typeof tokens === 'object' && !Array.isArray(tokens)
      ? (tokens as Record<string, unknown>).query : undefined;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('query token unavailable');
    query = value;
    port = Number(io.env.ELANOUS_CONTROL_PORT ?? 31413);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid control port');
  } catch {
    const reason = '관제부 조회 설정 오류';
    io.error(`launch-head balance: ${reason}`);
    return emit({ outcome: 'skipped', candidates: [], reasons: [reason] }, 2);
  }

  const fail = (reason: string): BalanceCliOutcome => {
    io.error(`launch-head balance: ${reason}`);
    return emit({ outcome: 'skipped', candidates: [], reasons: [reason] }, 2);
  };
  let response: Response;
  try {
    response = await io.fetch(`http://127.0.0.1:${port}/v1/resources?kind=machine`, {
      headers: { authorization: `Bearer ${query}` }, signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return emit({ outcome: 'skipped', candidates: [], reasons: ['관제부에 닿지 못함'] }, 0);
  }
  if (!response.ok) return fail(`관제부 HTTP 오류: ${response.status}`);

  let text: string;
  try {
    text = await response.text();
  } catch {
    return emit({ outcome: 'skipped', candidates: [], reasons: ['관제부에 닿지 못함'] }, 0);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('관제부 응답 형식 오류: JSON 파싱 실패');
  }
  if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).resources) ||
    !(body as { resources: unknown[] }).resources.every((row) =>
      row && typeof row === 'object' && !Array.isArray(row) &&
      (row as ResourceView).kind === 'machine' && typeof (row as ResourceView).machine === 'string' &&
      typeof (row as ResourceView).observedAt === 'number' && typeof (row as ResourceView).ttlMs === 'number' &&
      (row as ResourceView).attrs && typeof (row as ResourceView).attrs === 'object' && !Array.isArray((row as ResourceView).attrs))) {
    return fail('관제부 응답 형식 오류: resources');
  }
  try {
    return emit(rankMachines({ machines: (body as { resources: ResourceView[] }).resources, required, nowMs: io.now() }), 0);
  } catch (error) {
    return fail(`기계 순위 판정 오류: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerLaunchHeadCommands(program: Command): void {
  const launchHead = program.command('launch-head').description('발사 앞 머리 — 골이 Pod 로 가도 되는지 판정');
  launchHead.command('capability')
    .description('골 문서만 보고 any | local-only 를 정한다. 마지막 줄은 JSON.')
    .option('--goal <path>', '골 문서 경로. 없으면 ELANOUS_GRAPH_CONTEXT 의 input.goal_path')
    .action((opts: { goal?: string }) => {
      const args = opts.goal ? ['--goal', opts.goal] : [];
      const outcome = runCapabilityCheck(args);
      if (outcome.code !== 0) process.exitCode = outcome.code;
    });
  launchHead.command('balance')
    .description('관제부의 살아 있는 기계 둘 이상일 때 부하가 낮은 후보부터 정렬한다. 마지막 줄은 JSON.')
    .option('--json', 'JSON 결과 (마지막 줄에 항상 출력)')
    .action(async (_opts: { json?: boolean }) => {
      const outcome = await runLoadBalance([]);
      if (outcome.code !== 0) process.exitCode = outcome.code;
    });
}
