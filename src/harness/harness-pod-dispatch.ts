/** ⭐ `harness say/ask --substrate pod` — 호스트는 그래프를 돌리지 않고 Pod 로 보낸다(대표 2026-09-26).
 *
 *  대표: «pod 원격 실행은 실행 공간만 다르고 똑같이 그래프 엔지니어링 그래프를 써야» ·
 *      «harness ask/say --substrate pod 만 써도 알아서 분배».
 *  ⭐ 풀 해석·이미지 판 동기화(레지스트리 델타)·계정 배분·Job 수명은 이미 `self orchestrate --substrate pod` 에 있다 —
 *    ⛔ 두 벌로 짓지 않고 그 경로로 넘긴다. Pod 안에서는 골 문서가 있으면 `harness ask`, 아니면 `self implement` 가 돌고,
 *    매니페스트가 실은 런 계약(`ELANOUS_RUN_CONTRACT`)으로 자기가 Pod 인 줄 안다(graph-run-contract.ts).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findGitDir } from '../git-fs/locate.js';
import { debug } from '../debug/log.js';
import { ELANOUS_ENTRY_SCRIPT } from '../self-implement/seams.js';
import { parsePodSourceSpec } from '../task-orchestrator/surfaces/pod-source-spec.js';

export interface HarnessPodDispatchInput {
  readonly entrance: 'cli-harness-ask' | 'cli-harness-say';
  /** say 의 문장, 또는 ask 의 골 문서 경로. */
  readonly input: string;
  readonly podPool?: string;
  readonly autoMerge?: boolean;
  readonly base?: string;
  readonly json?: boolean;
  /** 사람이 고른 원천 spec — `commit:` · `pr:` · `worktree:` · `files:`. 검증은 발사 전. */
  readonly source?: string;
}

/** 오케스트레이터가 `;;` 로 골을 나누므로 한 골 안의 `;;` 는 풀어 둔다(한 발 = 한 골). */
export function podGoalText(input: HarnessPodDispatchInput, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): string {
  // 오케스트레이터에는 내용도 보내고, 저장소 안의 ask 는 별도로 Secret 을 통해 Pod 클론에 심는다.
  const text = input.entrance === 'cli-harness-ask' ? readFile(input.input) : input.input;
  return text.replace(/;;/gu, '; ;');
}

export function podOrchestrateArgs(input: HarnessPodDispatchInput, goal: string): string[] {
  return [
    ELANOUS_ENTRY_SCRIPT, 'self', 'orchestrate', goal,
    '--substrate', 'pod',
    ...(input.podPool ? ['--pod-pool', input.podPool] : []),
    // 하니스 기본(자동 병합)을 따른다 · 끄면 PR 까지 — 어느 쪽이든 Pod 가 사라져도 결과가 남는다.
    ...(input.autoMerge === false ? ['--open-pr'] : ['--auto-merge']),
    ...(input.base ? ['--base', input.base] : []),
    ...(input.json ? ['--json'] : []),
    ...(input.source ? ['--pod-source', input.source] : []),
    '--concurrency', '1',
  ];
}

export function dispatchHarnessOnPod(
  input: HarnessPodDispatchInput,
  deps: { run?: (cmd: string, args: readonly string[], env: NodeJS.ProcessEnv) => number | null; readFile?: (path: string) => string; cwd?: string } = {},
): number {
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
  const goal = podGoalText(input, deps.readFile ?? ((p) => readFileSync(resolve(cwd, p), 'utf8')));
  const args = podOrchestrateArgs(input, goal);
  const env = { ...process.env };
  delete env.ELANOUS_POD_GOAL_DOC;
  if (input.entrance === 'cli-harness-ask') {
    const root = findGitDir(cwd)?.root;
    const path = resolve(cwd, input.input);
    const relativePath = root ? relative(realpathSync(root), realpathSync(path)) : '';
    if (relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
      env.ELANOUS_POD_GOAL_DOC = relativePath;
    } else {
      debug.log('harness.substrate', 'goal-doc-outside-repo', { path: input.input });
    }
  }
  debug.log('harness.substrate', 'dispatch-pod', {
    entrance: input.entrance, podPool: input.podPool ?? null, autoMerge: input.autoMerge !== false,
    goalChars: goal.length, ...(input.entrance === 'cli-harness-ask' ? { goalPath: input.input } : {}),
  });
  const run = deps.run ?? ((cmd, a, childEnv) => spawnSync(cmd, [...a], { stdio: 'inherit', env: childEnv }).status);
  const status = run(process.execPath, args, env);
  debug.log('harness.substrate', 'dispatch-pod-exit', { entrance: input.entrance, status });
  return status ?? 1;
}
