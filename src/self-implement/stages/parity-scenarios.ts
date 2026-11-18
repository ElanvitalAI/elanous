/**
 * TA-GRAPH-1124 H4 — parity 시나리오 12 (+ 보조 2: Pod worktree-completed · 재작업 자식 재바인딩). 기대 걸음은 «손으로 쓴 리터럴»이다(규칙 11):
 * pipeline-shape 상수·엔진 출력·렌더 함수로 만들지 않았고, 각 줄은 아래 «왜» 주석의 단계 의미에서 도출했다.
 * 노드 표기 `이름@라운드`: 라운드 0 = 첫 시도, rework 진입부터 라운드가 1씩 오른다.
 * legacy 엔진(`runSelfImplement`)이 이 표와 일치하는 것이 11-19 기준선이고, 11-21 에는 graph 엔진이 같은 표를 맞춘다.
 */
import type { SiScenarioPlan, SiWalk } from './parity.js';

export interface SiScenario {
  readonly id: string;
  readonly title: string;
  readonly plan: SiScenarioPlan;
  readonly expected: SiWalk;
}

export const SI_PARITY_SCENARIOS: readonly SiScenario[] = [
  {
    id: 'normal-merge',
    title: '정상 병합 — 한 번에 gate·review 통과 → PR → 자동 병합',
    plan: { options: { autoMerge: true } },
    // 왜: implement → gate → review(pass) → open-pr → merge. 되돌아감 없음, 병합 seam 한 번.
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'open-pr@0', 'merge@0'], stage: 'merged', node: 'merge', ok: true, merged: true,
      seamCalls: ['implement', 'gate', 'review', 'openPr', 'mergePr'] },
  },
  {
    id: 'gate-fail-rework-pass',
    title: 'gate 실패 → rework → implement → gate 통과 → 병합',
    plan: { gateResults: [false, true], options: { autoMerge: true } },
    // 왜: 첫 gate 실패는 review 를 건너뛰고 rework(라운드 1)로 간다. 다시 implement·gate 후 통과하면 review → 병합(라운드 1 로 계속).
    expected: { walk: ['implement@0', 'gate@0', 'rework@1', 'implement@1', 'gate@1', 'review@1', 'open-pr@1', 'merge@1'], stage: 'merged', node: 'merge', ok: true, merged: true,
      seamCalls: ['implement', 'gate', 'implement', 'gate', 'review', 'openPr', 'mergePr'] },
  },
  {
    id: 'must-fix-twice',
    title: 'review must-fix 2회 → rework 2번 → 3번째 review 통과 → 병합',
    plan: { reviews: [{ verdict: 'fail' }, { verdict: 'fail' }, { verdict: 'pass' }], options: { autoMerge: true } },
    // 왜: review 가 fail+must-fix 면 rework. 상한(기본 2라운드) 안에서 두 번 돌고 세 번째 review 에서 통과한다.
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'rework@1', 'implement@1', 'gate@1', 'review@1', 'rework@2', 'implement@2', 'gate@2', 'review@2', 'open-pr@2', 'merge@2'],
      stage: 'merged', node: 'merge', ok: true, merged: true,
      seamCalls: ['implement', 'gate', 'review', 'implement', 'gate', 'review', 'implement', 'gate', 'review', 'openPr', 'mergePr'] },
  },
  {
    id: 'empty-change',
    title: '빈 변경 — Pod 안, 변경 없이 review 가 막음 → no-changes',
    plan: { substrate: 'pod', reviews: [{ verdict: 'fail' }], noChanges: true, options: { maxReworkRounds: 0 } },
    // 왜: 라운드 상한 0 이라 review fail 이 곧 rework 종단이고, 보존할 변경이 없으면(Pod) 종단 stage 는 review-blocked 가 아니라 no-changes 다.
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'rework@1'], stage: 'no-changes', node: 'rework', ok: false, merged: false,
      seamCalls: ['implement', 'gate', 'review'] },
  },
  {
    id: 'merge-conflict',
    title: 'main 정합 충돌 — conflict-unresolved → main-sync 종단 merge-conflict',
    plan: { mainSync: 'conflict-unresolved', options: { autoMerge: true } },
    // 왜: review 통과 뒤 main 을 합치다 충돌이 풀리지 않으면 PR 을 열지 않고 main-sync 에서 멈춘다(commitWork 후 mergeMain).
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'main-sync@0'], stage: 'merge-conflict', node: 'main-sync', ok: false, merged: false,
      seamCalls: ['implement', 'gate', 'review', 'commitWork', 'mergeMain'] },
  },
  {
    id: 'regate-fail',
    title: 'main 정합은 됐는데 합친 결과의 재-gate 실패 → gate-failed(regate)',
    plan: { mainSync: 'merged', regateResults: [false], options: { autoMerge: true, maxReworkRounds: 0 } },
    // 왜: 정합 성공 뒤 postsync gate 가 실패하면 regate 가 종단(gate-failed). 보존용 draft PR 은 열린다(openPr 호출) — 병합은 없다.
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'main-sync@0', 'regate@0'], stage: 'gate-failed', node: 'regate', ok: false, merged: false,
      seamCalls: ['implement', 'gate', 'review', 'commitWork', 'mergeMain', 'gate:postsync', 'openPr'] },
  },
  {
    id: 'pr-open-failure',
    title: 'PR 열기 실패 — openPr seam 이 던짐 → 결과가 아니라 예외',
    plan: { openPr: 'throw', options: { autoMerge: true } },
    // 왜: PR 생성이 던지면 run 은 결과를 못 내고 «draft PR 생성 실패» 로 던진다(worktree 보존). 던짐도 기준선이다.
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'open-pr@0'], stage: 'threw:draft PR 생성 실패', node: '-', ok: false, merged: false,
      seamCalls: ['implement', 'gate', 'review', 'openPr'] },
  },
  {
    id: 'pr-declined',
    title: '사전승인 없음 → PR 을 열지 않고 pr-declined',
    plan: { approve: false },
    // 왜: autoMerge 가 아니면 사람 승인(approvePr)이 필요하다. 거절하면 PR 호출 없이 open-pr 노드에서 pr-declined.
    expected: { walk: ['implement@0', 'gate@0', 'review@0'], stage: 'pr-declined', node: 'open-pr', ok: false, merged: false,
      seamCalls: ['implement', 'gate', 'review', 'approvePr'] },
  },
  {
    id: 'freeze-hold',
    title: '착지 동결 중 — PR 은 열되 병합은 보류(pr-opened)',
    plan: { freeze: true, options: { autoMerge: true } },
    // 왜: autoMerge 조건을 다 갖췄어도 landing-freeze 가 켜져 있으면 병합 seam 을 부르지 않고 PR 열린 채 둔다.
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'open-pr@0'], stage: 'pr-opened', node: 'open-pr', ok: true, merged: false,
      seamCalls: ['implement', 'gate', 'review', 'openPr'] },
  },
  {
    id: 'pod-merge-ready',
    title: 'Pod — 호스트가 병합(mergeByHost) → merge-ready 에서 멈춤',
    plan: { options: { autoMerge: true, mergeByHost: true } },
    // 왜: Pod 자식은 같은 병합 가드를 통과한 뒤 병합하지 않고 merge-ready 로 돌려준다. 병합 seam 은 부르지 않는다(호스트가 재게이트 뒤 병합).
    expected: { walk: ['implement@0', 'gate@0', 'review@0', 'open-pr@0'], stage: 'merge-ready', node: 'open-pr', ok: true, merged: false,
      seamCalls: ['implement', 'gate', 'review', 'openPr'] },
  },
  {
    id: 'soft-stop',
    title: '부모 soft-stop 요청 → 다음 노드(gate) 진입 전에 soft-stopped',
    plan: { softStop: true },
    // 왜: implement 가 끝난 뒤 gate 에 들어가기 전에 부모의 정지 요청을 확인해 soft-stopped 로 멈춘다. gate 는 호출되지 않는다.
    expected: { walk: ['implement@0'], stage: 'soft-stopped', node: 'gate', ok: false, merged: false, seamCalls: ['implement'] },
  },
  {
    id: 'timeout',
    title: 'implement 단계 시간초과 → timed-out',
    plan: { implement: 'hang', options: { stepTimeouts: { implement: 100 } } },
    // 왜: implement 가 한도(100ms)를 넘기면 timed-out. gate 로 가지 않는다.
    expected: { walk: ['implement@0'], stage: 'timed-out', node: 'implement', ok: false, merged: false, seamCalls: ['implement'] },
  },
  {
    id: 'pod-worktree-completed',
    title: '(보조) Pod — --no-open-pr(worktree-only) → worktree-completed',
    plan: { options: { completion: 'worktree-only' } },
    // 왜: Pod 자식은 PR 을 열지 않고 worktree 로 끝낸다(착지는 호스트 harness say 프로세스 몫). review 까지만 걷고 open-pr 노드에서 종단.
    expected: { walk: ['implement@0', 'gate@0', 'review@0'], stage: 'worktree-completed', node: 'open-pr', ok: true, merged: false,
      seamCalls: ['implement', 'gate', 'review'] },
  },
  {
    id: 'rework-child-rebind',
    title: '(보조) rework 중 자식 재바인딩 — grok 잔량 소진 → 다음 라운드부터 codex',
    plan: { gateResults: [false, true], grokExhausted: true, options: { autoMerge: true, childLlm: { provider: 'grok', model: 'parity-grok', source: 'flag' } } },
    // 왜: 첫 gate 실패 뒤 rework 라운드(1)에서 자식이 grok 이면 잔량·자격을 다시 보고, grok 이 소진이고 codex 계정이 있으면 codex 로 갈아탄다.
    // 첫 시도(라운드 0)는 지정한 grok 그대로다. 걸음은 gate-fail-rework-pass 와 같고 달라지는 것은 자식 공급자 칸뿐이다.
    expected: { walk: ['implement@0', 'gate@0', 'rework@1', 'implement@1', 'gate@1', 'review@1', 'open-pr@1', 'merge@1'], stage: 'merged', node: 'merge', ok: true, merged: true,
      seamCalls: ['implement', 'gate', 'implement', 'gate', 'review', 'openPr', 'mergePr'], childProviders: ['grok', 'openai-codex'] },
  },
];
