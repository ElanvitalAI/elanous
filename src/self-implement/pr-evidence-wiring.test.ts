// PR 근거 아티팩트 «배선» 시험 — 작성기가 아니라 «그 작성기가 실행 경로에 있나»를 묻는다.
//
// ⛔⭐ 단위 시험(`pr-evidence-artifact.test.ts`)은 「작성기가 무는가」만 답하고
//   「그 작성기가 PR 준비 경로에 «꽂혀 있나»」는 구조적으로 못 답한다. 이 파일이 그것을 문다 —
//   실제 `runSelfImplement` 를 seam 으로 돌려 ⑴ 관측이 «나오나» ⑵ 본문에 «실리나» 를 본다.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSelfImplement, type SelfImplementSeams } from './orchestrator.js';

const isolatedStateDir = mkdtempSync(join(tmpdir(), 'elanous-pr-evidence-wiring-'));
const priorStateDir = process.env.ELANOUS_STATE_DIR;

beforeAll(() => { process.env.ELANOUS_STATE_DIR = isolatedStateDir; });
afterAll(() => {
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

/** 골 문서에서 네 축이 «실제로» 나오는 최소 문면. 마커는 실물과 같은 모양을 쓴다. */
const GOAL_DOCUMENT = [
  '대상 경로: src/self-implement/pr-evidence-artifact.ts',
  '- GoalType: implement',
  '',
  '# 근거를 싣는다',
  '',
  '## Complication',
  '',
  '⛔ `prBody` 를 직접 고친다 — blocked draft 경로가 부재를 정상으로 싣는 자리다',
  '',
  '## Answer',
  '',
  '⑴ 순수 작성기를 만든다',
  '⑵ PR 준비 경로에 배선한다',
  '',
  '## 불변식',
  '',
  '불변식: `prBody` 의 시그니처는 안 바뀐다',
  '',
  '## 경계',
  '',
  '경계: 기본을 차단으로 켜는 것은 이 골 밖이다',
].join('\n');

type Captured = {
  readonly ledger: Array<{ event: string; data: Record<string, unknown> }>;
  readonly bodies: string[];
};

function wiringSeams(captured: Captured): SelfImplementSeams {
  let openedHead = '';
  return {
    stdinIsInteractive: () => false,
    refreshCodexQuotaSignals: async () => ({ accounts: [] }),
    escalateGoalClarifications: async () => ({ output: '{}', result: { answers: {} } }),
    queryRunChain: () => ({ entries: [] }),
    writeRunLedger: (entry) => { captured.ledger.push({ event: entry.event, data: entry.data }); },
    enqueueControlMemo: () => {},
    createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    implement: async () => ({ ok: true, summary: '작성기를 만들고 배선했다' }),
    // 📏 게이트 로그 문면은 실측이다 — `gh pr view 18879` 의 게이트 절과 같은 모양.
    gate: async () => ({ passed: true, log: '[test] PASS bun test src/self-implement/pr-evidence-artifact.test.ts —  0 fail |  83 expect() calls' }),
    defaultBranchRef: () => 'origin/main',
    reviewDiff: async () => ({
      verdict: 'pass', mustFix: [], shouldFix: ['거절 이유에 축 제목을 같이 대라'], summary: '배선은 닿았다',
      reviewed: true, diffTruncated: false, diffShownChars: 10, diffTotalChars: 10, diffOmittedFiles: 0,
    }),
    openPr: async ({ head, body }) => { openedHead = head; captured.bodies.push(body); return { url: `https://pr/${head}`, number: 18899 }; },
    readPrAttribution: async () => ({ headRefName: openedHead, createdAt: new Date(Date.now() + 60_000).toISOString() }),
    readPrDiff: async () => '',
    readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'head-sha' }),
    approvePr: async () => true,
    judgmentCallLLM: async () => 'BUDGET: SUFFICIENT',
    decomposeShadowGoals: async () => ({ goals: [], decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } }),
  };
}

function evidenceEvents(captured: Captured): Array<Record<string, unknown>> {
  return captured.ledger.filter(({ event }) => event === 'pr-evidence-artifact').map(({ data }) => data);
}

describe('pr-evidence-artifact · 배선', () => {
  test('골 문서가 있으면 관문이 통과하고 근거 절이 PR 본문에 «실린다»', async () => {
    const captured: Captured = { ledger: [], bodies: [] };
    const goalFile = join(isolatedStateDir, 'GOAL-wired.md');
    writeFileSync(goalFile, GOAL_DOCUMENT, 'utf8');

    const result = await runSelfImplement({
      feature: '근거 아티팩트 배선',
      goalFile,
      maxReworkRounds: 1,
      seams: wiringSeams(captured),
    });

    expect(result.stage).toBe('pr-opened');

    // ⑴ 관측이 «나온다» — 이 이벤트가 0건이면 배선이 실행 경로에 없다.
    const events = evidenceEvents(captured);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accepted: true, missingCount: 0, axes: 7 });

    // ⑵ 본문에 «실린다» — 일곱 절이 전부 있다.
    expect(captured.bodies).toHaveLength(1);
    const body = captured.bodies[0]!;
    expect(body).toContain('# 근거 아티팩트 — 일곱 축');
    for (const title of ['골 —', '계획 —', '원장 —', '비판 —', '시험 —', '위험 —', '대안 —']) {
      expect(body).toContain(`## ${title}`);
    }
    // 원장 축은 이 런의 «실제» runId 를 댄다 — 지어낸 값이 아니다.
    expect(body).toContain(result.runId);
    expect(body).toContain('- rework 라운드:');
    // 골에서 옮겨 온 넷이 값으로 실렸다.
    expect(body).toContain('순수 작성기를 만든다');
    expect(body).toContain('`prBody` 의 시그니처는 안 바뀐다');
    expect(body).toContain('기본을 차단으로 켜는 것은 이 골 밖이다');
    // 게이트 로그에서 «명령»을 뽑아 실었다.
    expect(body).toContain('bun test src/self-implement/pr-evidence-artifact.test.ts');
    // 기존 본문 계약은 그대로다 — 근거 절이 «덧붙는» 것이지 «대체»가 아니다.
    expect(body).toContain('## 구현 요약');
    expect(body).toContain('🤖 self-implement 오케스트레이터');
  });

  test('골 문서가 없으면 비어 있는 축을 «이름으로» 내되 기본은 막지 않는다', async () => {
    const captured: Captured = { ledger: [], bodies: [] };

    const result = await runSelfImplement({
      feature: '골 문서 없이 발사',
      maxReworkRounds: 1,
      seams: wiringSeams(captured),
    });

    // ⛔ 기본은 안 막는다 — 착지는 그대로 난다.
    expect(result.stage).toBe('pr-opened');

    const events = evidenceEvents(captured);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accepted: false });
    expect(events[0]).not.toHaveProperty('blocked');
    // 계획·위험·대안이 골에서 안 왔다. ⛔ 「0개」가 아니라 «이름»이 나온다.
    expect(events[0]!.missing).toEqual(['risks', 'alternatives']);
    expect(String(events[0]!.reason)).toContain('위험');

    // 거절이면 근거 절을 «안 싣는다» — 빈 절을 만들지 않는다.
    expect(captured.bodies[0]!).not.toContain('# 근거 아티팩트 — 일곱 축');
    // 그러나 기존 본문은 온전하다.
    expect(captured.bodies[0]!).toContain('## 구현 요약');
  });

});
