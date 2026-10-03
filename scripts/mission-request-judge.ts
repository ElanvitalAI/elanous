#!/usr/bin/env bun
// ── 미션 요청 판정기 (RFC-composite-loop-agent-and-mission-blueprint · S12) ──
// 사용: bun scripts/mission-request-judge.ts [--tick] [--root <절대경로>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCompositeCycle, type CompositeCycleResult, type HarnessGoal } from '../src/mission-loop/composite-cycle.js';
import { judgeMissionRequests } from '../src/mission-loop/judge.js';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';
import { ensureCronNodePath } from '../src/domains/cron-path.js';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';
import { debug } from '../src/debug/log.js';

export type CreateHarnessGoal = (goal: HarnessGoal) => Promise<void> | void;

function logJudge(event: string, data: Record<string, unknown>): void {
  try { debug.log('mission-fabric.judge', event, data); } catch { /* observation must not change a judgment */ }
}

/**
 * ⛔ 실패해도 «여기까지 본 것」을 잃지 않는다.
 * 📏 회귀(리뷰 2R must-fix): 카탈로그가 없을 때 옛 CLI 는 「📍 권위 트리 / 📍 요청 카탈로그」 두 줄을
 *   stdout 에 «찍고» 나서 exit 1 했는데, 중간 판에서 그 두 줄이 사라지고 stderr 오류만 남았다.
 *   ⇒ RFC 가 「그 두 줄이 없는 판정 산출은 읽지 않는다」고 못 박은 «자리» 정보다. 오류에 실어 보낸다.
 */
export class MissionRequestJudgeError extends Error {
  constructor(message: string, readonly lines: readonly string[]) { super(message); this.name = 'MissionRequestJudgeError'; }
}

interface HarnessGoalDependencies {
  mkdtempSync(prefix: string): string;
  writeFileSync(file: string, content: string, encoding: 'utf8'): void;
  rmSync(path: string, options: { recursive: true; force: true }): void;
  spawnSync(command: string, args: readonly string[]): { error?: Error; status: number | null; stderr: string | Buffer };
}

const harnessGoalDependencies: HarnessGoalDependencies = {
  mkdtempSync,
  writeFileSync,
  rmSync,
  spawnSync: (command, args) => spawnSync(command, args, { encoding: 'utf8' }),
};

export function createHarnessGoal(goal: HarnessGoal, dependencies: HarnessGoalDependencies = harnessGoalDependencies): void {
  const configuredCommand = process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
  const prefix = configuredCommand
    ? configuredCommand.split(' ').filter(part => part.length > 0)
    : ['bun', resolve(dirname(new URL(import.meta.url).pathname), '..', 'bin', 'elanous.mjs'), 'harness', 'ask'];
  if (prefix.length === 0) throw new Error('ELANOUS_MISSION_REQUEST_HARNESS_COMMAND 가 비어 있다 — 「설정 없음」이 아니라 «잘못된 설정»이다. 지우거나 명령 접두를 주라.');

  const askDirectory = dependencies.mkdtempSync(join(tmpdir(), 'mission-request-ask-'));
  const askFile = join(askDirectory, 'ask.md');
  try {
    dependencies.writeFileSync(askFile, goal.ask, 'utf8');
    const [command, ...args] = [...prefix, askFile];
    const run = dependencies.spawnSync(command!, args);
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(String(run.stderr).trim() || `harness goal failed with status ${run.status}`);
  } finally {
    dependencies.rmSync(askDirectory, { recursive: true, force: true });
  }
}

export function unknownMissionRequestJudgeFlag(argv: readonly string[]): string | undefined {
  return unknownCronFlag(argv, { boolean: ['--tick'], valued: ['--root'] });
}

export async function runMissionRequestJudge(argv: readonly string[], dependencies: { createHarnessGoal?: CreateHarnessGoal; runCompositeCycle?(authorityRoot: string): Promise<CompositeCycleResult> } = {}): Promise<string[]> {
  const unknownFlag = unknownMissionRequestJudgeFlag(argv);
  if (unknownFlag) {
    const message = `⛔ 모르는 플래그: ${unknownFlag}`;
    throw new MissionRequestJudgeError(message, [message]);
  }
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const authorityRoot = resolve(flag('--root') ?? join(dirname(new URL(import.meta.url).pathname), '..'));
  const result = judgeMissionRequests(authorityRoot);
  logJudge('requests-judged', {
    authorityRoot: result.authorityRoot, requestCatalog: result.requestCatalog,
    catalogStatus: result.catalogStatus, requestsScanned: result.requestsScanned,
    candidateCount: result.judgments.filter(judgment => judgment.status === 'blueprint-candidate').length,
    invalidCount: result.invalidCount,
  });
  for (const judgment of result.judgments) {
    logJudge('request-decision', {
      file: judgment.file, status: judgment.status,
      ...(judgment.status === 'invalid-request' ? { reasons: judgment.reasons } : {}),
      ...(judgment.status === 'missing-capability' ? { missingCapabilities: judgment.missingCapabilities.map(capability => capability.id) } : {}),
      ...(judgment.status === 'missing-blueprint' ? { reason: 'missing-blueprint' } : {}),
    });
  }
  const lines = [`📍 권위 트리: ${result.authorityRoot}`, `📍 요청 카탈로그: ${result.requestCatalog}`];
  if (result.catalogStatus === 'missing') {
    logJudge('skipped', { reason: 'request-catalog-missing', requestCatalog: result.requestCatalog });
    const message = '⛔ 요청 카탈로그가 «없다» — 「요청 0건」이 아니라 ***디렉토리 부재***다. root 를 확인하라.';
    throw new MissionRequestJudgeError(message, [...lines, message]);
  }
  lines.push(`📏 훑은 요청 ${result.requestsScanned}건`);
  for (const judgment of result.judgments) {
    if (judgment.status === 'invalid-request') {
      if (judgment.reasons.length === 1 && judgment.reasons[0] === '프론트매터 없음') lines.push(`⛔ ${judgment.file}: 프론트매터 없음 ⇒ invalid-request`);
      else if (judgment.reasons.length === 1 && judgment.reasons[0]!.startsWith('키 없음 ')) lines.push(`⛔ ${judgment.file}: ${judgment.reasons[0]} ⇒ invalid-request`);
      else { lines.push(`⛔ ${judgment.file} ⇒ invalid-request`); for (const reason of judgment.reasons) lines.push(`     · ${reason}`); }
    } else if (judgment.status === 'missing-capability') {
      lines.push(`✅ ${judgment.file} ⇒ 스키마 통과 · 능력 ${judgment.capabilityCount}개`, `   🔴 missing-capability ${judgment.missingCapabilities.length}/${judgment.capabilityCount}`);
      for (const missing of judgment.missingCapabilities) lines.push(`      · ${missing.id} → ${missing.path.replace(result.authorityRoot + '/', '')}`);
    } else if (judgment.status === 'missing-blueprint') lines.push(`✅ ${judgment.file} ⇒ 스키마 통과 · 능력 ${judgment.capabilityCount}개`, '   🟡 missing-blueprint');
    else lines.push(`✅ ${judgment.file} ⇒ 스키마 통과 · 능력 ${judgment.capabilityCount}개`, '   🟢 블루프린트 «후보» 있음 → 검증 ⑴~⑷');
  }
  lines.push(`📏 훑은 ${result.requestsScanned} · invalid ${result.invalidCount}`);
  if (!argv.includes('--tick')) {
    logJudge('skipped', { reason: 'tick-not-requested' });
    return lines;
  }

  const cycle = dependencies.runCompositeCycle
    ? await dependencies.runCompositeCycle(authorityRoot)
    : await runCompositeCycle(authorityRoot, { createHarnessGoal: dependencies.createHarnessGoal ?? createHarnessGoal });
  lines.push(`🔁 복합 회차 ${cycle.actions.length}건`);
  if (cycle.actions.length === 0) logJudge('skipped', { reason: 'no-cycle-actions' });
  for (const action of cycle.actions) {
    logJudge('cycle-decision', {
      requestId: action.requestId, action: action.action,
      ...(action.action === 'escalated' || action.action === 'ignored' ? { reason: action.reason } : {}),
      ...(action.action === 'goal-created' ? { paths: action.goal.paths } : {}),
      ...(action.action === 'executed' ? { fileDelivery: action.fileDelivery.status } : {}),
    });
    if (action.action === 'executed') {
      const delivery = action.fileDelivery.status === 'persisted'
        ? `file-delivery persisted · ${action.fileDelivery.path} · ${action.fileDelivery.bytes} bytes`
        : `file-delivery failed · ${action.fileDelivery.reason}`;
      lines.push(`   🟢 ${action.requestId} ⇒ executed · ${delivery}`);
    }
    else if (action.action === 'goal-created') lines.push(`   🟡 ${action.requestId} ⇒ goal-created · ${action.goal.paths.join(', ')}`);
    else if (action.action === 'escalated') lines.push(`   🔴 ${action.requestId} ⇒ escalated · ${action.reason}`);
    else lines.push(`   ⚪ ${action.requestId} ⇒ ${action.action}`);
  }
  return lines;
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: {
    ensureCronNodePath?: () => void;
    registerStandaloneLogSink?: (surface: string) => Promise<boolean>;
    runMissionRequestJudge?: (argv: readonly string[]) => Promise<string[]>;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {},
): Promise<void> {
  const log = dependencies.log ?? console.log;
  const error = dependencies.error ?? console.error;
  (dependencies.ensureCronNodePath ?? ensureCronNodePath)();
  try {
    if (!await (dependencies.registerStandaloneLogSink ?? registerStandaloneLogSink)('scheduler')) {
      error('⚠️ registerStandaloneLogSink(scheduler) failed; continuing mission request judgment');
    }
  } catch (sinkError) {
    error(`⚠️ registerStandaloneLogSink(scheduler) failed; continuing mission request judgment: ${sinkError instanceof Error ? sinkError.message : String(sinkError)}`);
  }
  try {
    for (const line of await (dependencies.runMissionRequestJudge ?? runMissionRequestJudge)(argv)) log(line);
  } catch (judgeError) {
    // ⛔ 「자리」 줄을 잃지 않는다 — 실패해도 여기까지 본 것을 stdout 에 그대로 낸다.
    if (judgeError instanceof MissionRequestJudgeError) for (const line of judgeError.lines) log(line);
    error(judgeError instanceof Error ? judgeError.message : String(judgeError));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
