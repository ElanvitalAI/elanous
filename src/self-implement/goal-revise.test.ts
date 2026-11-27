import { expect, test } from 'bun:test';
import { correctAfterReview, recordGoalRevision, recordRoundCorrections, reviseJudgmentAfterImpl } from './goal-revise.js';
import { judgeTddEvidence, parseOffDiffEvidence } from './off-diff-evidence.js';

const PLAN = '대상 경로: src/a.ts · src/a.test.ts\n\n### 검증 계획(TDD)\n- RED: 시험 먼저\n- GREEN: `bun test src/a.test.ts`\n';
const GREEN = 'EVIDENCE: [tdd-green] 피처 시험 통과 || bun test src/a.test.ts\nRESULT: 4 pass 0 fail\n';
const RED = 'EVIDENCE: [tdd-red] 구현 전 실패 || bun test src/a.test.ts\nRESULT: 1 fail\n';

test('GREEN observed and only RED missing → RED becomes recommended, the diff is recorded', () => {
  const judgment = judgeTddEvidence(PLAN, parseOffDiffEvidence(GREEN));
  expect(judgment.missing).toEqual(['tdd-red']);
  const revision = reviseJudgmentAfterImpl({ goal: PLAN, judgment, implementationOk: true });
  expect(revision.revised).toBe(true);
  expect(revision.judgment.needsRepair).toBe(false);
  expect(revision.judgment.missing).toEqual([]);
  expect(revision.changes[0]).toBe('TDD RED 기록: 필수 → 권장 (정책 초록 정의 = 같은 변경 영수 ⊕ 집중 시험 exit 0 · RED 기록은 정책 요구가 아니다)');
  expect(revision.changes[1]).toBe('유지: 같은 명령 GREEN 기록 «bun test src/a.test.ts» · 착지 줄의 같은 head 영수 ⊕ focused exit 0');
  const recorded = recordGoalRevision(PLAN, revision, 1);
  expect(recorded.startsWith(PLAN.trimEnd())).toBe(true);
  expect(recorded).toContain('## 판정값 재조정(GOAL-REVISE-AFTER-FIRST-IMPL · 라운드 1)\n- TDD RED 기록: 필수 → 권장');
  expect(recorded.trimEnd().endsWith('- 보안 4종 기준: 변경 없음')).toBe(true);
});

test('an E4 evidence cell: judgeTddEvidence already exempts RED (POLICY-AWARE-GOAL-AUTHORING), so there is nothing to revise', () => {
  const goal = `JUD-BUTLER-E4 — 증거 시험\n${PLAN}`;
  const judgment = judgeTddEvidence(goal, parseOffDiffEvidence(GREEN));
  expect(judgment.needsRepair).toBe(false);
  expect(reviseJudgmentAfterImpl({ goal, judgment, implementationOk: true }).revised).toBe(false);
});

test('an evidence reason is named when a judgment still carries the RED gap for an E4 goal', () => {
  const goal = `JUD-BUTLER-E4 — 증거 시험\n${PLAN}`;
  const implementJudgment = judgeTddEvidence(PLAN, parseOffDiffEvidence(GREEN));
  const revision = reviseJudgmentAfterImpl({ goal, judgment: implementJudgment, implementationOk: true });
  expect(revision.changes[0]).toBe('TDD RED 기록: 필수 → 권장 (evidence 칸(증거 시험만 더함) — RED 가 원리상 없다)');
});

test('nothing is relaxed without GREEN, after a failed implementation, or when nothing is missing', () => {
  const none = judgeTddEvidence(PLAN, parseOffDiffEvidence(''));
  expect(none.missing).toEqual(['tdd-red', 'tdd-green']);
  expect(reviseJudgmentAfterImpl({ goal: PLAN, judgment: none, implementationOk: true }).revised).toBe(false);
  const greenOnly = judgeTddEvidence(PLAN, parseOffDiffEvidence(GREEN));
  expect(reviseJudgmentAfterImpl({ goal: PLAN, judgment: greenOnly, implementationOk: false }).revised).toBe(false);
  const complete = judgeTddEvidence(PLAN, parseOffDiffEvidence(`${RED}${GREEN}`));
  expect(complete.needsRepair).toBe(false);
  const untouched = reviseJudgmentAfterImpl({ goal: PLAN, judgment: complete, implementationOk: true });
  expect(untouched.revised).toBe(false);
  expect(recordGoalRevision(PLAN, untouched, 1)).toBe(PLAN);
});

test('a rework round inherits the same-command pair this run already proved (TDD-PROVEN-CARRY · 11-27 canary)', () => {
  const none = judgeTddEvidence(PLAN, parseOffDiffEvidence(''));
  expect(none.missing).toEqual(['tdd-red', 'tdd-green']);
  const carried = reviseJudgmentAfterImpl({ goal: PLAN, judgment: none, implementationOk: true, provenCommand: 'bun test src/a.test.ts' });
  expect(carried.revised).toBe(true);
  expect(carried.judgment.needsRepair).toBe(false);
  expect(carried.changes[0]).toBe('TDD 재작업 라운드: 이 런 앞 라운드가 «bun test src/a.test.ts» RED→GREEN 을 증명 — RED·GREEN 기록 재요구 → 이월');
  expect(reviseJudgmentAfterImpl({ goal: PLAN, judgment: none, implementationOk: false, provenCommand: 'bun test src/a.test.ts' }).revised).toBe(false);
  expect(reviseJudgmentAfterImpl({ goal: PLAN, judgment: none, implementationOk: true }).revised).toBe(false);
});

test('a proven pair for another command does not carry when the planned command changed', () => {
  // The authored plan's GREEN line (goal-author «검증 계획(TDD)» ④) names the planned command.
  const authored = '대상 경로: src/a.ts · src/a.test.ts\n\n### 검증 계획(TDD)\n- ③ 먼저 쓸 시험(RED): src/a.test.ts\n- ④ GREEN 뒤 같은 명령: `bun test src/a.test.ts`\n';
  const none = judgeTddEvidence(authored, parseOffDiffEvidence(''));
  expect(reviseJudgmentAfterImpl({ goal: authored, judgment: none, implementationOk: true, provenCommand: 'bun test src/old.test.ts' }).revised).toBe(false);
  expect(reviseJudgmentAfterImpl({ goal: authored, judgment: none, implementationOk: true, provenCommand: 'bun test src/a.test.ts' }).revised).toBe(true);
});

test('round corrections (a)(b)(c): security-path widening relaxed · repeated finding tightened · out-of-scope recorded as FU (kept) — same rubric', () => {
  const sec4Finding = '`docs/` 밖의 비실행 문서가 보안 경로로 분류된다';
  const repeated = '실패 경로의 관측 한 줄이 없다';
  const edge = '원격 호스트 경로는 이 칸 범위 밖이다 — 후속 칸';
  const r = correctAfterReview({ mustFix: [sec4Finding, repeated, edge, '진짜 결함 하나'], previousMustFix: [`앞 지적(직전 head must #1): ${repeated}`], targetPaths: ['src/judge-butler/done-when.ts'] });
  expect(r.mustFix).toEqual([repeated, edge, '진짜 결함 하나']);
  expect(r.corrections.map((c) => c.kind)).toEqual(['over-spec', 'under-spec', 'edge-to-fu']);
  expect(r.fu).toEqual([edge]);
  expect(r.tighten).toEqual([repeated]);
  const doc = recordRoundCorrections('대상 경로: src/a.ts\n\n완료선:\n- 기능 — 시험\n', r.corrections, r.tighten, 2);
  expect(doc).toContain('완료선:\n- 정정(라운드 2): 실패 경로의 관측 한 줄이 없다\n- 기능 — 시험');
  expect(doc).toContain('## 판정값 재조정(GOAL-REVISE-AFTER-FIRST-IMPL · 라운드 2)\n- [over-spec] 보안 경로 확대 요구 완화');
  // security-4 path: the same hardening finding stays
  expect(correctAfterReview({ mustFix: ['승인 게이트 가 없다'], previousMustFix: [], targetPaths: ['src/oauth/refresh.ts'] }).mustFix).toEqual(['승인 게이트 가 없다']);
});

test('round corrections never drop a real defect: a security-4 risk outside the paths stays · «추가로» alone is not an edge', () => {
  const leak = '실패 경로에서 토큰 이 로그로 유출된다 — 추가 확인 필요';
  const core = '추가로, 빈 입력에서 함수가 깨진다';
  const r = correctAfterReview({ mustFix: [leak, core], previousMustFix: [], targetPaths: ['src/loops/a.ts'] });
  expect(r.mustFix).toEqual([leak, core]);
  expect(r.corrections).toEqual([]);
  const authz = '추가 확인이 없어 누구나 관리자 기능을 실행할 수 있다';
  const edgeLeak = '범위 밖 재시도 경로에서 토큰 이 유출된다';
  const edgeRegression = '엣지 케이스에서 빈 배열의 결과가 누락된다';
  const payment = '추가 확인이 없어 중복 결제가 발생한다';
  expect(correctAfterReview({ mustFix: [payment], previousMustFix: [], targetPaths: ['src/loops/a.ts'] }).mustFix).toEqual([payment]);
  expect(correctAfterReview({ mustFix: [authz, edgeLeak, edgeRegression], previousMustFix: [], targetPaths: ['src/loops/a.ts'] }).mustFix).toEqual([authz, edgeLeak, edgeRegression]);
  // Terra r5: no word list proves «not a defect» — only the security-path widening demand is ever removed
  const twice = '추가 확인이 없어 결제가 두 번 처리된다';
  const outOfScope = '범위 밖 파일까지 변경해 기존 동작을 깨뜨린다';
  const r2 = correctAfterReview({ mustFix: [twice, outOfScope, '승인 게이트 를 하나 더 둬야 한다'], previousMustFix: [], targetPaths: ['src/loops/a.ts'] });
  expect(r2.mustFix).toEqual([twice, outOfScope, '승인 게이트 를 하나 더 둬야 한다']);
  expect(r2.corrections.map((c) => c.kind)).toEqual(['over-spec-candidate', 'edge-to-fu', 'over-spec-candidate']);
});
