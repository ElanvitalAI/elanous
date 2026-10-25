import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { validateGoalDoneEvidenceCommand } from '../../src/self-implement/goal-author.js';
import { listChecklist, setItemIfSnapshot } from '../../src/release-loop/checklist.js';

const execFile = promisify(nodeExecFile);
const OUTPUT_TAIL_CHARS = 8_000;
export interface CommandResult { command: string; rc: number | null; timedOut: boolean; outputTail: string; startedAt: string; endedAt: string }
export interface GreenLegInput { version: string; cellId: string; mergeSha: string; tree: string; timeoutMs?: number }
export interface GreenLegDeps {
  run: (command: string, cwd: string, timeoutMs: number) => Promise<CommandResult>;
  record: (input: GreenLegInput, evidence: string) => Promise<void>;
  propose: (body: string) => Promise<void>;
  now: () => string;
  resolveLandedMerge?: (tree: string, mergeSha: string) => string;
  getCell?: (version: string, cellId: string) => { title: string; status: string } | undefined;
}

/** Parse the train lane's required proof command and optional isolated E4 command. */
export function completionBoundaryCommands(title: string): { evidence?: string; real?: string; errors: string[] } {
  const errors: string[] = [];
  const read = (label: string, optional: boolean): string | undefined => {
    const prefix = `- 완료 경계 ${label}:`;
    const lines = title.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
    if (lines.length > 1) { errors.push(`${label}: 중복 선언`); return; }
    const value = lines[0]?.slice(prefix.length).trim();
    if (!value) {
      if (!optional) errors.push(`${label}: 선언 없음`);
      return;
    }
    const parsed = validateGoalDoneEvidenceCommand(value);
    if (!parsed.command) { errors.push(`${label}: ${parsed.error ?? '잘못된 명령'}`); return; }
    return parsed.command;
  };
  return { evidence: read('증거 명령', false), real: read('실물 명령', true), errors };
}

function tokenize(command: string): string[] | null {
  const args: string[] = [];
  let current = '', quote: '"' | "'" | undefined, escaped = false, active = false;
  for (const char of command) {
    if (escaped) { current += char; escaped = false; active = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; active = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; active = true; continue; }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (/\s/u.test(char)) { if (active) args.push(current); current = ''; active = false; continue; }
    current += char; active = true;
  }
  if (escaped || quote) return null;
  if (active) args.push(current);
  return args;
}

export function validateIsolatedTestCommand(command: string): { args?: string[]; error?: string } {
  const args = tokenize(command);
  if (!args) return { error: '인용부호가 닫히지 않은 명령' };
  if (args[0] !== 'bun' || args[1] !== 'test' || args.length < 3) return { error: '격리 레인에서는 bun test <시험 경로>만 실행 가능' };
  if (args.slice(2).some((arg) => arg.startsWith('-'))) return { error: '시험 경로 외 추가 옵션은 허용하지 않음' };
  if (args.slice(2).some((arg) => arg.split('/').includes('..') || arg.startsWith('/') || arg.includes('\\'))) return { error: '시험 경로는 트리 내부 상대 경로여야 함' };
  return { args };
}

export function runIsolatedTestCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const parsed = validateIsolatedTestCommand(command);
  const startedAt = new Date().toISOString();
  if (!parsed.args) return Promise.resolve({ command, rc: null, timedOut: false, outputTail: `REJECTED: ${parsed.error}`, startedAt, endedAt: new Date().toISOString() });
  return new Promise((resolveResult) => {
    const dir = join(tmpdir(), `eln-green-leg-${process.pid}-${Date.now()}`);
    const child = spawn(parsed.args![0]!, parsed.args!.slice(1), {
      cwd, shell: false, detached: true, env: { ...process.env, ELANOUS_STATE_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timedOut = false, done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already exited */ } }
      else child.kill(signal);
    };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); forceTimer = setTimeout(() => killGroup('SIGKILL'), 2_000); forceTimer.unref(); }, timeoutMs);
    const finish = (rc: number | null): void => {
      if (done) return; done = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
      void rm(dir, { recursive: true, force: true }).finally(() => resolveResult({ command, rc, timedOut, outputTail: output, startedAt, endedAt: new Date().toISOString() }));
    };
    child.on('error', (error) => { append(Buffer.from(`\nSPAWN ERROR: ${error.message}`)); finish(null); });
    child.on('close', (code) => finish(code));
  });
}

export async function runGreenLeg(input: GreenLegInput, deps: GreenLegDeps): Promise<{ passed: boolean; results: CommandResult[]; evidence: string }> {
  const tree = resolve(input.tree);
  let mergeSha: string;
  try {
    mergeSha = deps.resolveLandedMerge?.(tree, input.mergeSha) ?? resolveLandedMerge(tree, input.mergeSha);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const now = deps.now();
    const evidence = [
      `TRAIN-GREEN-LEG ${now}`,
      `우주 표기(test:${tree})`,
      `착지 merge SHA 검증 실패: ${input.mergeSha}`,
      `검증 오류: ${reason}`,
      '결과=미측정 · green 금지',
    ].join('\n');
    await deps.record(input, evidence);
    await deps.propose(`evidence-only: ${input.version}/${input.cellId}; 착지 merge SHA 사전 검증 실패로 시험 미실행; 우주 test:${tree}; 입력 SHA ${input.mergeSha}; 체크리스트 상태는 변경하지 않았습니다.`);
    return { passed: false, results: [], evidence };
  }
  const snapshot = deps.getCell?.(input.version, input.cellId) ?? listChecklist(input.version).items.find((item) => item.id === input.cellId);
  if (!snapshot) throw new Error(`체크리스트 칸 없음: ${input.cellId}`);
  if (snapshot.status !== 'yellow') throw new Error(`yellow가 아닌 칸에는 TRAIN-GREEN-LEG 실행 불가: ${snapshot.status}`);
  const declarations = completionBoundaryCommands(snapshot.title);
  const commands = [declarations.evidence, declarations.real].filter((value): value is string => Boolean(value));
  const results: CommandResult[] = declarations.errors.length
    ? [{ command: '', rc: null, timedOut: false, outputTail: `REJECTED: ${declarations.errors.join('; ')}`, startedAt: deps.now(), endedAt: deps.now() }]
    : await runInOrder(commands, (command) => deps.run(command, tree, input.timeoutMs ?? 120_000));
  const passed = declarations.errors.length === 0 && results.length > 0 && results.every((result) => result.rc === 0 && !result.timedOut);
  const proposalReady = passed && Boolean(declarations.real);
  const evidence = [
    `TRAIN-GREEN-LEG ${deps.now()}`,
    `우주 표기(test:${tree})`,
    `착지 merge SHA ${mergeSha}`,
    ...results.map((result) => `${result.command || '(선언 검증)'} | rc=${result.rc ?? 'spawn-error'} | timeout=${result.timedOut} | ${result.startedAt}..${result.endedAt}\n${result.outputTail}`),
    `결과=${proposalReady ? '격리 E4 통과 · OP/OPT 판정 대기' : passed ? '증거 시험 통과 · 실물 E4 미선언 · human-collected 대기' : '미통과 또는 미측정 · green 금지'}`,
  ].join('\n');
  await deps.record(input, evidence);
  await deps.propose(`${proposalReady ? 'propose-green' : 'evidence-only'}: ${input.version}/${input.cellId}; ${proposalReady ? '격리 E4 시험 명령 통과' : passed ? '증거 시험만 통과, 실물 E4는 human-collected 대기' : '명령 실패·시간초과·선언 거부 기록'}; 우주 test:${tree}; 착지 merge SHA ${mergeSha}. 체크리스트 상태는 변경하지 않았습니다.`);
  return { passed, results, evidence };
}

function resolveLandedMerge(tree: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error('착지 merge SHA는 전체 40자리여야 합니다');
  const full = execFileSync('git', ['-C', tree, 'rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', tree, 'merge-base', '--is-ancestor', full, 'HEAD']);
  return full;
}

async function runInOrder<T>(items: readonly T[], run: (item: T) => Promise<CommandResult>): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

export const defaultGreenLegDeps: GreenLegDeps = {
  run: runIsolatedTestCommand,
  now: () => new Date().toISOString(),
  async record(input, evidence) {
    const current = listChecklist(input.version).items.find((item) => item.id === input.cellId);
    if (!current) throw new Error(`체크리스트 칸 없음: ${input.cellId}`);
    if (current.status !== 'yellow') throw new Error(`yellow가 아닌 칸에는 TRAIN-GREEN-LEG 기록 불가: ${current.status}`);
    setItemIfSnapshot(input.version, input.cellId, { evidence: [current.evidence, evidence].filter(Boolean).join('\n\n') }, 'MK', current);
  },
  async propose(body) { await execFile('eln', ['msg', 'post', '--from', 'MK', '--to', 'OPT', '--kind', 'report', '--body', body]); },
};

if (import.meta.main) {
  const [version, cellId, mergeSha, tree] = process.argv.slice(2);
  if (!version || !cellId || !mergeSha || !tree) {
    console.error('usage: bun scripts/train/green-leg.ts <version> <cell-id> <landed-merge-sha> <test-tree>');
    process.exitCode = 2;
  } else {
    try {
      const result = await runGreenLeg({ version, cellId, mergeSha, tree }, defaultGreenLegDeps);
      console.log(JSON.stringify({ passed: result.passed, results: result.results }, null, 2));
      if (!result.passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
