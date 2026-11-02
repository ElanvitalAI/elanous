import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../debug/log.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { assertIsolatedEventRoot } from './event-monkey.js';
import { runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';

export const THINK_LENS_MOCK_COMMAND = 'bun test src/ux-sim/research-decision-chain.test.ts';

export interface ThinkLensMockObservation {
  readonly decisionRunId: string;
  readonly controlRunId: string;
  readonly stateRoot: string;
  readonly decisionOutput: string;
  readonly decision: { readonly ok: boolean; readonly hasThreeStages: boolean; readonly hasOrderedLinks: boolean; readonly passed: boolean; readonly appliedEvents: number; readonly skippedEvents: number };
  readonly control: { readonly ok: boolean; readonly hasNoChain: boolean; readonly appliedEvents: number; readonly skippedEvents: number };
  readonly mockOnly: true;
  readonly liveBenchmarkMeasured: false;
  readonly passed: boolean;
}

export interface ResearchDecisionOutputShape {
  readonly hasThreeStages: boolean;
  readonly hasOrderedLinks: boolean;
  readonly passed: boolean;
}

/** Validate nonempty same-line stage contents plus the production evidence ancestry markers. */
export function inspectResearchDecisionOutput(output: string): ResearchDecisionOutputShape {
  const primary = /^- 1차 결과 \(30일\):[ \t]*([^\r\n]*)$/m.exec(output);
  const secondary = /^- 2차 결과 \(180일\):[ \t]*([^\r\n]*)$/m.exec(output);
  const tertiary = /^- 3차 결과 \(540일\):[ \t]*([^\r\n]*)$/m.exec(output);
  const hasThreeStages = Boolean(primary?.[1]?.trim() && secondary?.[1]?.trim() && tertiary?.[1]?.trim());
  const lines = output.split(/\r?\n/);
  const lineIndex = (match: RegExpExecArray | null): number => match ? output.slice(0, match.index).split(/\r?\n/).length - 1 : -1;
  const primaryLine = lineIndex(primary);
  const secondaryLine = lineIndex(secondary);
  const tertiaryLine = lineIndex(tertiary);
  const hasOrderedLinks = primaryLine >= 0 && primaryLine < secondaryLine && secondaryLine < tertiaryLine
    && lines[secondaryLine + 1]?.trim() === '근거 관계: primary-1'
    && lines[tertiaryLine + 1]?.trim() === '근거 관계: secondary-1';
  return { hasThreeStages, hasOrderedLinks, passed: hasThreeStages && hasOrderedLinks };
}

const stages = [
  { id: 'causes', title: '원인', purpose: '근거가 지지하는 직접 효과를 적는다.' },
  { id: 'uncertainty', title: '불확실성', purpose: '남은 불확실성을 적는다.' },
];

function fixtureOptions(): ResearchQuestionLadderRunOptions {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`,
    level: index + 1,
    prompt: `고정 시뮬 질문 ${index + 1}`,
    searchTerms: [`mock-${index + 1}-a`, `mock-${index + 1}-b`],
    sectionId: index % 2 === 0 ? 'causes' : 'uncertainty',
  }));
  return {
    generateContract: async () => JSON.stringify({
      deliverable: '고정 시뮬 메모', format: '두 섹션', sections: stages,
      completionCriteria: ['각 섹션은 근거를 담거나 불확실성으로 표시한다.'],
    }),
    generate: async () => JSON.stringify({ questions }),
    planGapFollowup: () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [] }),
    invokeAxes: async (axes: readonly { id: string }[]) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['publisher-a.test', 'publisher-b.test'].map((host) => ({
        questionId: axis.id,
        sourceKind: 'web-search:mock',
        source: `https://${host}/${axis.id}`,
        content: `고정 fake evidence: ${axis.id}의 시뮬 결과 근거.`,
        outcome: 'complete' as const,
        truncated: false,
      })) })),
    }),
    allowOutputSkill: false,
    enableResearchFanout: false,
    researchFanoutWorker: null,
  };
}

/** Run the mock in a child process so its debug sinks and test config cannot touch the caller's process. */
export async function runThinkLensDecisionChainMock(stateRootInput: string): Promise<ThinkLensMockObservation> {
  const stateRoot = resolve(stateRootInput);
  // Validate the requested root before the worker can create any path beneath it.
  assertIsolatedEventRoot(stateRoot);
  const worker = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, ['run', worker, stateRoot], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELANOUS_STATE_DIR: stateRoot, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(stateRoot, process.env), ELANOUS_THINK_LENS_DEVICE_WORKER: '1' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputFailure: Error | undefined;
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, 60_000);
    child.once('error', (error) => { clearTimeout(timeout); if (forceKill) clearTimeout(forceKill); reject(error); });
    const collectOutput = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        outputFailure = new Error('think-lens device worker output exceeded 8 MiB total');
        child.kill('SIGTERM');
        if (!forceKill) forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      } else target.push(chunk);
    };
    child.stdout.on('data', collectOutput(stdout));
    child.stderr.on('data', collectOutput(stderr));
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (outputFailure) reject(outputFailure);
      else if (timedOut) reject(new Error('think-lens device worker timed out after 60 seconds'));
      else resolveResult({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  if (result.status !== 0) throw new Error(`think-lens device worker failed (${result.status ?? result.signal ?? 'unknown'}): ${result.stderr.slice(-2000)}`);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith('MOCKDEV_THINK_LENS_RESULT='));
  if (!marker) throw new Error('think-lens device worker did not return its observation');
  return JSON.parse(marker.slice('MOCKDEV_THINK_LENS_RESULT='.length)) as ThinkLensMockObservation;
}

async function runThinkLensDecisionChainMockExclusive(stateRootInput: string): Promise<ThinkLensMockObservation> {
  const stateRoot = resolve(stateRootInput);
  const decisionRunId = `run-think-lens-decision-${randomUUID()}`;
  const controlRunId = `run-think-lens-control-${randomUUID()}`;
  assertIsolatedEventRoot(stateRoot, decisionRunId);
  assertIsolatedEventRoot(stateRoot, controlRunId);
  mkdirSync(stateRoot, { recursive: true });

  const savedStateDir = process.env.ELANOUS_STATE_DIR;
  const savedRunId = process.env.ELANOUS_RUN_ID;
  const savedKeepEnvKeys = process.env.ELANOUS_KEEP_ENV_KEYS;
  const savedConfigOverride = getElanousConfigDirOverride();
  let store: LogStore | undefined;
  let sink: StoreSink | undefined;
  let unregister: (() => void) | undefined;
  try {
    process.env.ELANOUS_STATE_DIR = stateRoot;
    process.env.ELANOUS_KEEP_ENV_KEYS = '1';
    setElanousConfigDir(stateRoot);
    store = new LogStore(join(stateRoot, 'logs', 'logs.db'), { instance: `test:think-lens:${decisionRunId}` });
    sink = new StoreSink(store, `test:think-lens:${decisionRunId}`, { installExitHandlers: false });
    unregister = debug.registerSink(sink);

    process.env.ELANOUS_RUN_ID = decisionRunId;
    const decision = await runResearchQuestionLadder('우리 팀이 다음 분기에 세일즈포스로 전환해야 할까?', fixtureOptions());
    process.env.ELANOUS_RUN_ID = controlRunId;
    const control = await runResearchQuestionLadder('세일즈포스는 어떤 제품인가?', fixtureOptions());
    sink.flush();
    const rows = store.query({ exactCategories: ['research.lens'], events: ['second-order-applied', 'second-order-skipped'], limit: 1000 });
    const rowsForRun = (runId: string) => rows.filter((row) => {
        const data = typeof row.data === 'string'
          ? JSON.parse(row.data) as Record<string, unknown>
          : row.data && typeof row.data === 'object' && !Array.isArray(row.data)
            ? row.data as Record<string, unknown>
            : {};
        return data.runId === runId;
      });
    const decisionRows = rowsForRun(decisionRunId);
    const controlRows = rowsForRun(controlRunId);
    const appliedEvents = decisionRows.filter((row) => row.event === 'second-order-applied').length;
    const decisionSkippedEvents = decisionRows.filter((row) => row.event === 'second-order-skipped').length;
    const controlAppliedEvents = controlRows.filter((row) => row.event === 'second-order-applied').length;
    const skippedEvents = controlRows.filter((row) => row.event === 'second-order-skipped').length;
    const decisionShape = inspectResearchDecisionOutput(decision.output);
    const controlHasNoChain = !control.output.includes('1차 결과 (30일):')
      && !control.output.includes('2차 결과 (180일):') && !control.output.includes('3차 결과 (540일):');
    const decisionEvidence = { ok: decision.ok, ...decisionShape, appliedEvents, skippedEvents: decisionSkippedEvents };
    const controlEvidence = { ok: control.ok, hasNoChain: controlHasNoChain, appliedEvents: controlAppliedEvents, skippedEvents };
    return {
      decisionRunId,
      controlRunId,
      stateRoot,
      decisionOutput: decision.output,
      decision: decisionEvidence,
      control: controlEvidence,
      mockOnly: true,
      liveBenchmarkMeasured: false,
      passed: decisionRunId !== controlRunId && decision.ok && decisionShape.passed
        && appliedEvents === 1 && decisionSkippedEvents === 0
        && control.ok && controlHasNoChain && controlAppliedEvents === 0 && skippedEvents === 1,
    };
  } finally {
    unregister?.();
    sink?.close();
    store?.close();
    if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = savedStateDir;
    if (savedRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = savedRunId;
    if (savedKeepEnvKeys === undefined) delete process.env.ELANOUS_KEEP_ENV_KEYS;
    else process.env.ELANOUS_KEEP_ENV_KEYS = savedKeepEnvKeys;
    if (savedConfigOverride === undefined) resetElanousConfigDir();
    else setElanousConfigDir(savedConfigOverride);
  }
}

if (process.env.ELANOUS_THINK_LENS_DEVICE_WORKER === '1') {
  const stateRoot = process.argv[2];
  if (!stateRoot || resolve(stateRoot) !== process.env.ELANOUS_STATE_DIR) {
    throw new Error('think-lens device worker requires a matching isolated state root');
  }
  debug.setFileEnabled(false);
  debug.setDiagEnabled(true);
  const observation = await runThinkLensDecisionChainMockExclusive(stateRoot);
  console.log(`MOCKDEV_THINK_LENS_RESULT=${JSON.stringify(observation)}`);
}
