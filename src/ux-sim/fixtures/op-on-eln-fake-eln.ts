#!/usr/bin/env bun
// #39377 종단 회귀용 가짜 eln — agent 경계만 목킹한다(op-on-eln-run.ts 의 spawn 대상).
// 판단(선택·처분)은 캔처스: 선택형 사례는 저장소 내장 기대 처분(op-world-replay.js)을
// 그대로 대답하고 ELANOUS_OP_FAKE_MODE=wrong 이면 전보기를 뒤집어 오답을 낸다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opWorldAnswerCases } from '../op-world-replay.js';

interface FakeSnapshot {
  sceneId: string;
  actionResults: Array<{ status: string }>;
}

const input = process.argv.at(-1) ?? '';
const snapshot = JSON.parse(input.trim().split('\n').at(-1) ?? '{}') as FakeSnapshot;
// #39377 terra r4 mustFix ① 회귀 진단: 받은 프롬프트 원문을 지정 디렉터리에만 남긴다.
// 환경변수가 없으면 아무 부작용도 없다(운영 경로 그대로).
const promptCaptureDir = process.env.ELANOUS_OP_FAKE_PROMPT_CAPTURE;
if (promptCaptureDir) {
  mkdirSync(promptCaptureDir, { recursive: true });
  writeFileSync(join(promptCaptureDir, `${snapshot.sceneId}.txt`), input);
}
// 재시도 후속 질문 판별: 러너(op-on-eln-run.ts)의 후속 프롬프트는 actionResults 가
// 현 장면 결과만 담고 그 첫 항목이 주입된 retry다. 초기 프롬프트의 actionResults 는
// 장면 누적 장부라 이전 장면의 retry가 섞이므로 전체 some() 탐색으로는 오판한다.
const followup = snapshot.actionResults[0]?.status === 'retry';
const wrongMode = process.env.ELANOUS_OP_FAKE_MODE === 'wrong';
// JUD-C #128898: silent 모드는 «선택형 미응답» 주입 — 선택형 재현 장면에서
// 에이전트가 정기 보고는 내지만 choice 를 아예 제출하지 않는 실제 응답을 낸다.
// 비선택형 장면은 correct 경로 그대로라 실패 원인이 오직 미응답에서만 온다.
const silentMode = process.env.ELANOUS_OP_FAKE_MODE === 'silent';
const answer = (expected: string): string => wrongMode ? (expected === 'A' ? 'B' : 'A') : expected;

function action(type: string, target: string, reason: string, evidence: readonly string[], extra: Record<string, unknown> = {}) {
  return { type, target, reason, evidence, ...extra };
}

function reply(): string {
  if (followup) {
    return JSON.stringify([
      action('recover', 'sim-runtime', '죽은 레인의 배정을 대체 레인으로 이관한다', ['sim-runtime'], { worker: 'sim-spare' }),
    ]);
  }
  switch (snapshot.sceneId) {
    case 'planning-flood':
      return JSON.stringify([
        action('assign', 'export-check', 'P0 원격 경로 검증을 배정한다', ['crown-1'], { worker: 'sim-release' }),
        action('assign', 'ffmpeg-build', 'P0 공유 빌드 막힘 조사를 배정한다', ['crown-2'], { worker: 'sim-platform' }),
        action('land', 'sim-pr-ready', '현 head pregate·리뷰 통과 착지', ['sim-pr-ready']),
        action('land', 'sim-pr-warn', 'WARN must-fix 0 착지', ['sim-pr-warn']),
        action('report', 'export-check', '착지 2건 완료, 나머지는 대기다', ['crown-1']),
      ]);
    case 'corrected-order':
      return JSON.stringify([
        action('assign', 'export-check', '정정 지시를 따라 원격 기본 경로를 재배정한다', ['crown-9'], { worker: 'sim-release' }),
        action('hold', 'sim-pr-stale', '리뷰 근거가 옛 head라 보류한다', ['sim-pr-stale']),
        action('report', 'export-check', '대기: 정정 반영 상태 보고다', ['crown-9']),
      ]);
    case 'failed-lane':
      return JSON.stringify([
        action('recover', 'sim-runtime', '죽은 레인의 배정을 대체 레인으로 이관한다', ['sim-runtime'], { worker: 'sim-spare' }),
        action('report', 'recover-lane', '막힘: 실패 레인 복구를 진행한다', ['crown-17']),
      ]);
    case 'hourly-convergence':
      return JSON.stringify([
        action('hold', 'sim-pr-build', '빌드 실패로 착지를 보류한다', ['sim-pr-build']),
        action('report', 'hourly-report', '대기: 어제 약속한 빌드 순서를 지킨다', ['mem-build-order']),
      ]);
    case 'replay-gate-stop':
      return JSON.stringify([
        action('hold', 'sim-pr-replay-gate', '현 head의 재검 대조가 필요하다', ['replay-order-gate'],
          { disposition: 'hold-and-recheck-exact-head' }),
        action('report', 'sim-pr-replay-gate', '대기: 게이트 중단 상태를 기록한다', ['replay-order-gate']),
      ]);
    case 'replay-scoped-repair':
      return JSON.stringify([
        action('assign', 'sim-replay-scoped-repair', '최소 한 곳만 고치고 인접 회귀 스윕은 그대로 둔다', ['replay-order-scoped'],
          { worker: 'sim-release', disposition: 'small-fix-with-untouched-regression-sweep' }),
        action('report', 'sim-replay-scoped-repair', '대기: 배정 후 범위 확인을 기록한다', ['replay-order-scoped']),
      ]);
    case 'replay-direct-edit':
      return JSON.stringify([
        action('assign', 'sim-replay-direct-edit', '격리 worktree에서 구현 손이 직접 수정한다 — TA 신규 발사는 없다', ['replay-order-direct'],
          { worker: 'sim-ux', disposition: 'assign-isolated-hand-without-ta' }),
        action('report', 'sim-replay-direct-edit', '대기: 실행 경로 지정을 기록한다', ['replay-order-direct']),
      ]);
    default: {
      // 선택형 재현(replay-answer-key-N): 사례별로 독립 판단해 choice 필드로 기록한다.
      const cases = opWorldAnswerCases(snapshot.sceneId);
      if (!cases.length) throw new Error(`fake eln has no reply for scene: ${snapshot.sceneId}`);
      // JUD-C #128898: silent — 각 사례에 report 는 제출하되 choice 필드 없이
      // 미응답을 낸다(디코더는 choice 없는 report 를 그대로 통과시킨다).
      if (silentMode) {
        return JSON.stringify(cases.map(({ order }) =>
          action('report', order.task, '사례 판단: 이번 사례에는 선택을 제출하지 않는다', [order.id])));
      }
      return JSON.stringify(cases.map(({ order, expectedDisposition }) =>
        action('report', order.task, `사례 판단: ${expectedDisposition} 보기를 선택한다`, [order.id],
          { choice: { choice: answer(expectedDisposition), evidenceId: order.id } })));
    }
  }
}

console.log(JSON.stringify({ sessionId: 'fake-session-1', provider: 'fake', model: 'fake-model', reply: reply() }));
