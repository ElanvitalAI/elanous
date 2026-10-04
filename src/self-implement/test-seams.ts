// ⭐ 단위 테스트용 공용 seam 헬퍼 — ⛔ 재발명 방지로 «한 곳»에만 둔다.
//   📍 왜 파일로 뺐나(2026-08-19): runSelfImplement 를 돌리는 회귀가 한 파일에 누적되면
//     «다른» 테스트가 자기 타임아웃(5s)에 걸린다(실측). 무거운 회귀를 파일로 가르려면
//     이 헬퍼가 여러 파일에서 보여야 한다.
//   기본 무동작: quota 신호 갱신은 빈 계정 결과만 돌려주고, run ledger 기록은 하지 않는다.
//   이것을 채우지 않으면 테스트가 실제 계정 스토어를 읽어 codex 자식을 띄우고
//   `~/.elanous/budget`에 신호를 쓰며, 운영 쿼터를 소모할 수 있다.
import type { SelfImplementSeams } from './orchestrator.js';

export function seams(over: Partial<SelfImplementSeams> & { gateResults?: boolean[]; features?: string[] }): SelfImplementSeams {
  const gateResults = over.gateResults ?? [true];
  let gateCall = 0;
  const features = over.features ?? [];
  return {
    // ⭐ 테스트는 «환경(실제 stdin)»이 아니라 계약을 검사한다 — 기본은 「사람이 있다」로 둔다.
    //    비-TTY 게이트 자체는 아래 전용 테스트가 «명시»로 확인한다.
    stdinIsInteractive: () => true,
    // ⛔⭐⭐⭐⭐ 기본을 «무동작»으로 둔다(리뷰 must-fix). 안 채우면 이 헬퍼를 쓰는 «모든» 단위
    //   테스트가 실제 경로를 탄다 — 정본 계정 스토어를 읽고, ***codex 자식을 실제로 띄우고***,
    //   `~/.elanous/budget` 에 신호를 쓴다. 즉 테스트가 «운영 쿼터를 소모»한다.
    //   ⭐ 실제 경로는 그것을 «의도한» 전용 테스트에서만 탄다(그 테스트가 심을 명시로 준다).
    refreshCodexQuotaSignals: async () => ({ accounts: [] }),
    writeRunLedger: () => {},
    emitContextEvent: () => {},
    registerLoopAgent: () => {},
    createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    implement: async ({ feature }) => { features.push(feature); return { ok: true, summary: 'impl' }; },
    gate: async () => {
      const passed = gateResults[Math.min(gateCall, gateResults.length - 1)]!;
      gateCall++;
      return { passed, log: passed ? 'ok' : `[tsc: 변경 파일 컴파일 에러 1건]\nfoo.ts(1,1): error TS2304: Cannot find name 'refFacts'.` };
    },
    defaultBranchRef: () => 'origin/main',
    mergeMain: async () => ({ status: 'up-to-date' }),
    openPr: async ({ head }) => ({ url: `https://pr/${head}`, number: 7 }),
    readPrFiles: async () => ['src/ordinary.ts'],
    readPrDiff: async () => '',
    readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }),
    approvePr: async () => true,
    judgmentCallLLM: async ({ prompt }) => prompt.match(/BUDGET:\s*(EXTEND|SUFFICIENT|UNCONVERGEABLE)/)?.[1] ?? 'EXTEND',
    decomposeShadowGoals: async () => ({ goals: [], decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } }),
    ...over,
  };
}
