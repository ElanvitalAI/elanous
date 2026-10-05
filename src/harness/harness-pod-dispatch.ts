/** ⭐ `harness say/ask --substrate pod` — 호스트는 그래프를 돌리지 않고 Pod 로 보낸다(대표 2026-09-26).
 *
 *  대표: «pod 원격 실행은 실행 공간만 다르고 똑같이 그래프 엔지니어링 그래프를 써야» ·
 *      «harness ask/say --substrate pod 만 써도 알아서 분배».
 *  ⭐ 풀 해석·이미지 판 동기화(레지스트리 델타)·계정 배분·Job 수명은 이미 `self orchestrate --substrate pod` 에 있다 —
 *    ⛔ 두 벌로 짓지 않고 그 경로로 넘긴다. Pod 안에서는 골 문서가 있으면 `harness ask`, 아니면 `self implement` 가 돌고,
 *    매니페스트가 실은 런 계약(`ELANOUS_RUN_CONTRACT`)으로 자기가 Pod 인 줄 안다(graph-run-contract.ts).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { selfDevRunsDir } from '../self-dev/run-store.js';
import { findGitDir } from '../git-fs/locate.js';
import { debug } from '../debug/log.js';
import { ELANOUS_ENTRY_SCRIPT } from '../self-implement/seams.js';
import { parsePodSourceSpec } from '../task-orchestrator/surfaces/pod-source-spec.js';
import { declaredGoalType, type GoalType } from '../self-implement/goal-author.js';
import { appendRunLedgerEntry } from '../self-implement/run-ledger.js';
import { HARNESS_RUN_ID_ENV } from './harness-space.js';
import { podMemoryLimitFor, type PodMemoryTier } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { selectPodMemoryTier } from './pod-memory-policy.js';

export interface HarnessPodDispatchInput {
  readonly entrance: 'cli-harness-ask' | 'cli-harness-say';
  /** say 의 문장, 또는 ask 의 골 문서 경로. */
  readonly input: string;
  readonly podPool?: string;
  readonly seat?: 'OP' | 'TC' | 'MK' | 'UX';
  /** Host already recorded the observe-only dispatch; suppress a second decision in the Pod. */
  readonly dispatchRecorded?: boolean;
  /** Pod 메모리 등급(lite|standard|high) — 오케스트레이터 환경 `ELANOUS_POD_MEMORY_TIER` 로 Job 까지 간다. */
  readonly podMemory?: PodMemoryTier;
  readonly goalType?: GoalType;
  /** L7c — Pod queue predecessor (goal ID or PR) — `ELANOUS_POD_AFTER` carries it to every Pod Job admission. */
  readonly after?: string;
  readonly autoMerge?: boolean;
  readonly base?: string;
  readonly json?: boolean;
  /** 사람이 고른 원천 spec — `commit:` · `pr:` · `worktree:` · `files:`. 검증은 발사 전. */
  readonly source?: string;
  /** `--child-llm-provider/--child-llm-model/--child-llm-effort` — carried to `self orchestrate` so the Pod child uses them (10-05 PODPROVIDER). */
  readonly childLlmProvider?: string;
  readonly childLlmModel?: string;
  readonly childLlmEffort?: string;
  /** `harness.authorOnPod` — say 문장을 Pod 안에서 저작부터 돌린다. 호스트는 영수증만 남긴다. */
  readonly authorOnPod?: boolean;
}

/** 골 본문에 넣을 문장 — 코드 펜스가 문장을 삼키지 않게 백틱 런을 늘린다. */
export function fenceVerbatimSentence(sentence: string): { fence: string; body: string } {
  const body = sentence.replace(/\r\n/g, '\n');
  const longest = body.match(/`+/g)?.reduce((n, run) => Math.max(n, run.length), 0) ?? 0;
  return { fence: '`'.repeat(Math.max(3, longest + 1)), body };
}

/** Pod 가 문장 그대로 `harness say` 를 돌리게 하는 골. 자격·풀은 기존 Pod 주입을 그대로 쓴다. */
export function authorOnPodGoal(sentence: string): string {
  const { fence, body } = fenceVerbatimSentence(sentence);
  return [
    '# 골: Pod 안에서 harness say 저작',
    '',
    '- GoalType: implement',
    '- 대상 경로: src/harness/harness-pod-dispatch.ts',
    '',
    '## 할 일',
    '',
    '이 Pod 안에서, 그리고 이 Pod 안에서만, 아래 펜스의 문장을 한 글자도 바꾸지 않고',
    '`elanous harness say --substrate local` 의 인자로 실행한다.',
    '그 한 발이 골 저작·리뷰·게이트·구현·PR 까지 이 Pod 안에서 끝낸다.',
    '호스트에는 발사 영수증과 원장만 남는다. 호스트에서 저작·리뷰·게이트를 지휘하지 않는다.',
    '저작 자격은 이 Job 에 이미 주입된 Pod 자격 규칙을 그대로 쓴다.',
    '',
    '## 문장 (verbatim)',
    '',
    fence,
    body,
    fence,
    '',
    '## 수용 기준',
    '',
    '- 위 펜스 문장만으로 `elanous harness say --substrate local` 한 발이 이 Pod 에서 저작부터 PR 까지 간다.',
    '- 그 명령의 종료 코드가 0 이 아니면 이 골은 실패다.',
    '',
  ].join('\n');
}

export function podOrchestrateArgs(input: HarnessPodDispatchInput, goalFile: string): string[] {
  return [
    ELANOUS_ENTRY_SCRIPT, 'self', 'orchestrate', '--goal-file', goalFile,
    '--substrate', 'pod',
    ...(input.podPool ? ['--pod-pool', input.podPool] : []),
    // 하니스 기본(자동 병합)을 따른다 · 끄면 PR 까지 — 어느 쪽이든 Pod 가 사라져도 결과가 남는다.
    ...(input.autoMerge === false ? ['--open-pr'] : ['--auto-merge']),
    ...(input.base ? ['--base', input.base] : []),
    ...(input.json ? ['--json'] : []),
    ...(input.source ? ['--pod-source', input.source] : []),
    ...(input.childLlmProvider?.trim() ? ['--child-llm-provider', input.childLlmProvider.trim()] : []),
    ...(input.childLlmModel?.trim() ? ['--child-llm-model', input.childLlmModel.trim()] : []),
    ...(input.childLlmEffort?.trim() ? ['--child-llm-effort', input.childLlmEffort.trim()] : []),
    '--concurrency', '1',
  ];
}

type PodDispatchDeps = { run?: (cmd: string, args: readonly string[], env: NodeJS.ProcessEnv) => number | null; readFile?: (path: string) => string; cwd?: string; spawnChild?: typeof spawn; onOutput?: (text: string) => void };

export function dispatchHarnessOnPod(input: HarnessPodDispatchInput, deps: PodDispatchDeps & { run: NonNullable<PodDispatchDeps['run']> }): number;
export function dispatchHarnessOnPod(input: HarnessPodDispatchInput, deps?: PodDispatchDeps): number | Promise<number>;
export function dispatchHarnessOnPod(input: HarnessPodDispatchInput, deps: PodDispatchDeps = {}): number | Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  if (input.source !== undefined) {
    try {
      parsePodSourceSpec(input.source);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debug.log('harness.substrate', 'source-refused', { entrance: input.entrance, source: input.source, reason });
      return 2;
    }
  }
  const env = { ...process.env };
  let tempDir: string | undefined;
  let goalFile = '';
  let goalText: string;
  if (input.entrance === 'cli-harness-ask') {
    goalFile = resolve(cwd, input.input);
    goalText = (deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(goalFile);
  } else if (input.authorOnPod) {
    const goal = authorOnPodGoal(input.input);
    goalText = goal;
    const root = findGitDir(cwd)?.root ?? cwd;
    const runsDir = join(root, 'docs', 'goals');
    mkdirSync(runsDir, { recursive: true });
    tempDir = mkdtempSync(join(runsDir, '.pod-author-'));
    goalFile = join(tempDir, 'GOAL-pod-author-2026-10-05.md');
    writeFileSync(goalFile, goal, { mode: 0o600 });
    const runId = env[HARNESS_RUN_ID_ENV]?.trim();
    const receipt = { entrance: input.entrance, host: 'receipt-only', authorOnPod: true, goalFile };
    debug.log('harness.substrate', 'author-on-pod-receipt', receipt);
    if (runId) {
      try { appendRunLedgerEntry({ runId, event: 'author-on-pod-receipt', data: receipt }); }
      catch (error) { debug.log('harness.substrate', 'author-on-pod-receipt-unwritten', { reason: error instanceof Error ? error.message : String(error) }); }
    }
  } else {
    const goal = input.input;
    goalText = goal;
    const runsDir = selfDevRunsDir();
    mkdirSync(runsDir, { recursive: true });
    tempDir = mkdtempSync(join(runsDir, 'pod-goal-'));
    goalFile = join(tempDir, 'goal.txt');
    writeFileSync(goalFile, goal, { mode: 0o600 });
  }
  const goalChars = goalText.length;
  const args = podOrchestrateArgs(input, goalFile);
  debug.log('harness.substrate', 'goal-file', { entrance: input.entrance, mode: tempDir ? 'temp' : 'path' });
  const goalType = input.goalType ?? declaredGoalType(goalText);
  // A process-level memory tier is already an explicit selection; do not replace it with a goal-type default.
  const existing = podMemoryLimitFor(goalText, env);
  const selection = !input.podMemory && ['option', 'goal-line', 'pwa-auto', 'advise'].includes(existing.source)
    ? { tier: existing.tier, reason: 'existing-tier' as const }
    : goalType || input.podMemory ? selectPodMemoryTier(goalType ?? 'implement', input.podMemory, existing.tier) : undefined;
  if (selection) {
    env.ELANOUS_POD_MEMORY_TIER = selection.tier;
    env.ELANOUS_POD_MEMORY_REASON = selection.reason;
  } else {
    delete env.ELANOUS_POD_MEMORY_REASON;
  }
  if (goalType) env.ELANOUS_POD_GOAL_TYPE = goalType;
  else delete env.ELANOUS_POD_GOAL_TYPE;
  if (input.seat) env.ELANOUS_HARNESS_SEAT = input.seat;
  delete env.ELANOUS_POD_GOAL_DOC;
  delete env.ELANOUS_DISPATCH_RECORDED;
  if (input.dispatchRecorded) env.ELANOUS_DISPATCH_RECORDED = '1';
  debug.log('harness.substrate', 'memory-selected', { entrance: input.entrance, goalType,
    tier: selection?.tier ?? existing.tier, reason: selection?.reason ?? existing.source,
    memoryLimit: podMemoryLimitFor(goalText, env).limit });
  delete env.ELANOUS_POD_AFTER;
  if (input.after) env.ELANOUS_POD_AFTER = input.after;
  if (input.authorOnPod) env.ELANOUS_POD_AUTHOR_ON_POD = '1';
  else delete env.ELANOUS_POD_AUTHOR_ON_POD;
  if (input.entrance === 'cli-harness-ask' || input.authorOnPod) {
    const root = findGitDir(cwd)?.root;
    const path = input.authorOnPod ? goalFile : resolve(cwd, input.input);
    const relativePath = root ? relative(realpathSync(root), realpathSync(path)) : '';
    if (relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
      env.ELANOUS_POD_GOAL_DOC = relativePath;
    } else {
      debug.log('harness.substrate', 'goal-doc-outside-repo', { path: input.input });
    }
  }
  debug.log('harness.substrate', 'dispatch-pod', {
    entrance: input.entrance, podPool: input.podPool ?? null, podMemory: input.podMemory ?? null, after: input.after ?? null, autoMerge: input.autoMerge !== false,
    childLlmProvider: input.childLlmProvider ?? null, childLlmModel: input.childLlmModel ?? null,
    goalChars, ...(input.entrance === 'cli-harness-ask' ? { goalPath: input.input } : {}),
  });
  const run = deps.run ?? ((cmd: string, a: readonly string[], childEnv: NodeJS.ProcessEnv) => new Promise<number>((resolveStatus) => {
    const child = (deps.spawnChild ?? spawn)(cmd, [...a], { stdio: deps.onOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit', env: childEnv });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { process.stdout.write(chunk); deps.onOutput?.(chunk); });
    let forwarded: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals) => {
      forwarded = signal;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onTerm = () => forward('SIGTERM');
    const onInt = () => forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const cleanup = () => { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); };
    child.once('error', () => { cleanup(); resolveStatus(1); });
    child.once('close', (code, signal) => { cleanup(); resolveStatus(code ?? ((signal ?? forwarded) === 'SIGINT' ? 130 : 143)); });
  }));
  const cleanup = () => { if (tempDir && !input.authorOnPod) rmSync(tempDir, { recursive: true, force: true }); };
  try {
    const status = run(process.execPath, args, env);
    if (typeof status === 'number' || status === null) {
      cleanup();
      debug.log('harness.substrate', 'dispatch-pod-exit', { entrance: input.entrance, status });
      return status ?? 1;
    }
    return status.then((code) => {
      debug.log('harness.substrate', 'dispatch-pod-exit', { entrance: input.entrance, status: code });
      return code;
    }).finally(cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}
