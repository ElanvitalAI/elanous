import type { OpWorldOrder, OpWorldPullRequest, OpWorldReport } from './op-on-eln-world.js';
import { OP_WORLD_LEDGER_CASES, OP_WORLD_MAIL_CASES } from './op-world-decision-fixtures.js';

interface OpWorldReplayScene {
  id: string;
  independentCases?: true;
  orders: readonly OpWorldOrder[];
  pullRequests: readonly OpWorldPullRequest[];
  reports: readonly OpWorldReport[];
}

/** Sanitized facts reconstructed for replay. Dispositions are held by the evaluator. */
const ACTION_REPLAY_SCENES = [
  {
    id: 'replay-gate-stop',
    orders: [{
      id: 'replay-order-gate',
      task: 'sim-pr-replay-gate',
      priority: 'P0',
      instruction: '이번 직권 착지 후보를 분류하라. 지도 인용 범위를 확인하는 래칫이 깨졌고, 리뷰는 현재 커밋 PASS다.',
    }],
    pullRequests: [{
      id: 'sim-pr-replay-gate',
      head: 'sim-gate-head',
      gate: { head: 'sim-gate-head', status: 'fail' },
      review: { head: 'sim-gate-head', verdict: 'pass', mustFix: 0, roundsRemaining: 2 },
      state: 'open',
    }],
    reports: [{
      id: 'replay-report-gate',
      from: 'sim-review',
      body: '현 head의 지도 줄 범위 검사가 실패했다. 참조 대상은 그대로이며 앞쪽 코드 이동으로 줄 번호만 바뀌었다.',
    }],
  },
  {
    id: 'replay-scoped-repair',
    orders: [{
      id: 'replay-order-scoped',
      task: 'sim-replay-scoped-repair',
      priority: 'P0',
      instruction: '시험 provider 선택 충돌을 조사하고 구현·검증 범위를 배정하라.',
    }],
    pullRequests: [],
    reports: [{
      id: 'replay-report-scoped',
      from: 'sim-platform',
      body: '전역 fake 선택기가 한 공용 분기에서 명시 주입 provider보다 먼저 평가된다. 직접 회귀는 4건, 같은 전역 값을 읽는 인접 시험은 48파일이다.',
    }],
  },
  {
    id: 'replay-direct-edit',
    orders: [{
      id: 'replay-order-direct',
      task: 'sim-replay-direct-edit',
      priority: 'P0',
      instruction: '여러 파일 수리의 손과 실행 경로를 정하라. 이 칸은 소규모 TA 시범 등록 명부에 없다.',
    }],
    pullRequests: [],
    reports: [{
      id: 'replay-report-direct',
      from: 'sim-runtime',
      body: '수리에는 여러 파일이 필요하다. 구현 손의 격리 worktree가 준비돼 있고 관문은 기존 경로를 따른다.',
    }],
  },
] as const satisfies readonly OpWorldReplayScene[];

const CASES_PER_TURN = 8;
const privateCases = [
  ...OP_WORLD_LEDGER_CASES.map(([source, ...scenario]) => [`decision-ledger:${source}`, ...scenario] as const),
  ...OP_WORLD_MAIL_CASES.map(([source, ...scenario]) => [`op-mail:${source}`, ...scenario] as const),
].map(([decisionId, situation, chosen, alternative], index) => {
  const key = index + 1;
  const swap = Math.imul(key ** 2 + 4621, 0x45d9f3b) >>> 29 & 1;
  const id = `answer-order-${key}`;
  const task = `answer-case-${key}`;
  const sceneId = `replay-answer-key-${Math.floor(index / CASES_PER_TURN) + 1}`;
  const optionA = swap ? alternative : chosen;
  const optionB = swap ? chosen : alternative;
  const order: OpWorldOrder = {
    id, task, priority: 'P0',
    instruction: `${situation} A: ${optionA} B: ${optionB}`,
  };
  return { sceneId, decisionId, order, expectedDisposition: swap ? 'B' : 'A' };
});

export function opWorldAnswerCases(sceneId: string) {
  return privateCases.filter(item => item.sceneId === sceneId);
}

const answerScenes: OpWorldReplayScene[] = Array.from(
  { length: Math.ceil(privateCases.length / CASES_PER_TURN) },
  (_, index) => {
    const id = `replay-answer-key-${index + 1}`;
    return {
      id, independentCases: true,
      orders: opWorldAnswerCases(id).map(item => item.order),
      pullRequests: [], reports: [],
    };
  },
);

export const OP_WORLD_REPLAY_SCENES: readonly OpWorldReplayScene[] = [...ACTION_REPLAY_SCENES, ...answerScenes];
