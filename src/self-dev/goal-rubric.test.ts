import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCoreSplit, behaviorGroups, loadGoalRubric, moduleOf, parseGoalRubric, relaxSecurityOverSpec, renderRubricLines, rubricSplitLine, rubricVerificationFu, scoreGoalRubric } from './goal-rubric.js';

const FIX = join(import.meta.dir, 'fixtures', 'goal-rubric');
const ask = (name: string): string => readFileSync(join(FIX, name), 'utf8');

// The pre-launch decomposer's pieces recorded in today's canary goal docs (11-27 · node-c) — the LLM judgment node's evidence.
const HARD_PIECES = [
  '정보성 notice에만 «할 일 없으면 조용히 종결» 안내를 추가한다.\n대상 경로: src/chat/interjection.ts',
  '정보성 notice 턴에서만 notify=false 신호를 판정하고 한 줄 영수만 남긴다.\n대상 경로: src/core-turn/run-core-turn.ts · src/tui/core/queue.ts · src/core-turn/notice-quiet-close.test.ts',
];
const MEDIUM_PIECES = [
  'Define and unit-test the pure zombieSeat predicate.\n대상 경로: src/steward/space/work-next-cli.ts · src/steward/space/work-next.ts · src/steward/space/zombie-claim.test.ts',
  'Wire zombieSeat into work-next-cli.ts lastActiveMs.\n대상 경로: src/steward/space/work-next-cli.ts · src/steward/space/zombie-claim.test.ts',
];
const EASY_PIECES = ['opt-out 경로에서도 사전 검토.\n대상 경로: src/self-dev/ask-launch-flow.ts · src/self-dev/ask-launch-flow-precheck-optout.test.ts · src/self-dev/ask-launch-flow.test.ts'];
const SEC4_PIECES = ['security4Hits 가 시험·fixture·문서를 건너뛴다.\n대상 경로: src/judge-butler/done-when.ts · src/judge-butler/judge-butler-sim.test.ts'];

test('the rubric YAML parses and a malformed one is loud', () => {
  const rubric = loadGoalRubric();
  expect(rubric.behaviors.maxCore).toBe(1);
  expect(rubric.verdictOrder).toEqual(['hand', 'probe-first', 'split', 'launch']);
  expect(() => parseGoalRubric('version: 1\naxes: {}\nverdict_order: [launch]\n')).toThrow('goal rubric');
});

test('calibration on the 11-27 canaries and BUTLER-SEC4-SCOPE: hard → split (CORE = the supervisor\'s piece 1) · easy/medium/sec4 → launch', () => {
  const hard = scoreGoalRubric({ document: ask('hard-notice-turn-quiet-close.md'), targetPaths: ['src/core-turn/run-core-turn.ts', 'src/chat/interjection.ts', 'src/tui/core/queue.ts', 'src/core-turn/notice-quiet-close.test.ts'], pieces: HARD_PIECES });
  expect(hard.verdict).toBe('split');
  expect(hard.core).toBe('정보성 notice에만 «할 일 없으면 조용히 종결» 안내를 추가한다.');
  expect(hard.fu[0]).toBe('정보성 notice 턴에서만 notify=false 신호를 판정하고 한 줄 영수만 남긴다.');
  const easy = scoreGoalRubric({ document: ask('easy-goal-precheck-optout-path.md'), targetPaths: ['src/self-dev/ask-launch-flow.ts', 'src/self-dev/ask-launch-flow-precheck-optout.test.ts'], pieces: EASY_PIECES });
  expect(easy.verdict).toBe('launch');
  expect(easy.tier).toBe('luna');
  const medium = scoreGoalRubric({ document: ask('medium-zombie-claim-reap.md'), targetPaths: ['src/steward/space/work-next-cli.ts', 'src/steward/space/work-next.ts', 'src/steward/space/zombie-claim.test.ts'], pieces: MEDIUM_PIECES });
  expect(medium.verdict).toBe('launch');
  expect(medium.axes.find((a) => a.id === 'behaviors')!.evidence).toBe('분해기 조각 2 → 행동 묶음 1(같은 모듈 안 조각 = 한 행동)');
  const sec4 = scoreGoalRubric({ document: ask('butler-sec4-scope.md'), targetPaths: ['src/judge-butler/done-when.ts', 'src/judge-butler/judge-butler-sim.test.ts'], pieces: SEC4_PIECES });
  expect(sec4.verdict).toBe('launch');
});

test('without a decomposition the behaviors axis counts done-when lines minus non-behavior lines', () => {
  const doc = '대상 경로: src/a/x.ts\n\n완료선:\n- 기능 A 가 된다 — 시험\n- 기능 B 가 된다 — 시험\n- 기존 시험 회귀 0\n';
  const r = scoreGoalRubric({ document: doc, targetPaths: ['src/a/x.ts'] });
  expect(r.axes[0]!.evidence).toBe('분해기 미측정 · 완료선 행동 줄 2(비행동 표지 제외)');
  expect(r.verdict).toBe('split');
  expect(r.core).toBe('기능 A 가 된다 — 시험');
  expect(r.fu).toEqual(['기능 B 가 된다 — 시험']);
});

test('a split with no buildable CORE carries no core (the launch flow stops on it) · dependency evidence names unmeasured refs', () => {
  const wide = scoreGoalRubric({ document: '대상 경로: src/a/x.ts\n', targetPaths: ['src/a/x.ts', 'src/b/y.ts', 'scripts/z.ts'], pieces: ['하나\n대상 경로: src/a/x.ts · src/b/y.ts · scripts/z.ts'] });
  expect(wide.verdict).toBe('split');
  expect(wide.core).toBeUndefined();
  const dep = scoreGoalRubric({ document: '대상 경로: src/a/x.ts\n선행: #7 · 선행 칸 FOO-BAR\n', targetPaths: ['src/a/x.ts'], dependencyOpen: (r) => (r === '#7' ? false : undefined) });
  expect(dep.axes.find((a) => a.id === 'dependencies')!.evidence).toBe('선행 #7 · FOO-BAR · 미측정 FOO-BAR');
  expect(dep.verdict).toBe('launch');
});

test('hand on a security-4 path or an open dependency · probe-first on an unknown cause', () => {
  expect(scoreGoalRubric({ document: '대상 경로: src/oauth/refresh.ts\n', targetPaths: ['src/oauth/refresh.ts'] }).verdict).toBe('hand');
  expect(scoreGoalRubric({ document: '대상 경로: src/a/x.ts\n선행: #123\n', targetPaths: ['src/a/x.ts'], dependencyOpen: (r) => r === '#123' }).verdict).toBe('hand');
  expect(scoreGoalRubric({ document: '대상 경로: src/a/x.ts\n원인 후보: 잠금 경합\n', targetPaths: ['src/a/x.ts'] }).verdict).toBe('probe-first');
});

test('security over-spec: an approval gate outside security-4 is relaxed in place · on a security-4 path it stays', () => {
  const doc = '대상 경로: src/loops/a.ts\n\nA(답): 발사 전에 승인 게이트 를 하나 더 둔다.\n';
  const r = scoreGoalRubric({ document: doc, targetPaths: ['src/loops/a.ts'] });
  expect(r.relaxedSecurity).toEqual(['A(답): 발사 전에 승인 게이트 를 하나 더 둔다.']);
  expect(relaxSecurityOverSpec(doc, r)).toContain('승인 게이트 를 하나 더 둔다. (완화 — 보안 4종 경로 밖 보안 강화 요구는 정책상 하지 않는다 · PRECHECK-CORE-SIZE)');
  const kept = scoreGoalRubric({ document: '대상 경로: src/secret/vault.ts\n\nA(답): 승인 게이트 를 둔다.\n', targetPaths: ['src/secret/vault.ts'] });
  expect(kept.relaxedSecurity).toEqual([]);
  // calibration: the BUTLER-SEC4-SCOPE reviewer's repeated finding is over-spec (src/judge-butler is not a security-4 path)
  const finding = '`docs/` 밖의 비실행 문서가 보안 경로로 분류된다';
  expect(scoreGoalRubric({ document: finding, targetPaths: ['src/judge-butler/done-when.ts'] }).relaxedSecurity).toEqual([finding]);
});

test('split writes a CORE block; the record lines carry every axis; supervisor and revise reuse the same module', () => {
  const r = scoreGoalRubric({ document: ask('hard-notice-turn-quiet-close.md'), targetPaths: ['src/core-turn/run-core-turn.ts', 'src/chat/interjection.ts', 'src/tui/core/queue.ts'], pieces: HARD_PIECES });
  const doc = applyCoreSplit('대상 경로: src/chat/interjection.ts\n\n## PROBLEM\n- x\n', r);
  expect(doc).toContain('## CORE 분할(PRECHECK-CORE-SIZE)\n- 이 런은 아래 CORE 하나만 구현한다.');
  expect(doc.indexOf('## CORE 분할')).toBeLessThan(doc.indexOf('## PROBLEM'));
  const lines = renderRubricLines(r);
  expect(lines[0]!.startsWith('- 루브릭 판정: split — ')).toBe(true);
  expect(lines.filter((l) => l.startsWith('- 축 ')).length).toBe(8);
  expect(rubricSplitLine(HARD_PIECES)).toBe('CORE(루브릭 행동 묶음 1): 정보성 notice에만 «할 일 없으면 조용히 종결» 안내를 추가한다. · FU: 정보성 notice 턴에서만 notify=false 신호를 판정하고 한 줄 영수만 남긴다.');
  expect(rubricVerificationFu('완료선: 실 PTY 회귀 0')).toBe('E4 증거 칸 FU — 실 PTY(루브릭 verification_cost)');
  expect(moduleOf('src/tui/core/queue.ts')).toBe('src/tui');
  expect(behaviorGroups(MEDIUM_PIECES)).toHaveLength(1);
});

test('YAML 정의 가능 (YAML-FIRST-RATCHET): a new policy value without a YAML home scores 1 and says where · with a home 0 · never a blocker', () => {
  const bare = scoreGoalRubric({ document: '대상 경로: src/loops/a.ts\n\n완료선:\n- 리뷰 대기 타임아웃 30분을 넘으면 우편 한 통\n', targetPaths: ['src/loops/a.ts'] });
  const axis = bare.axes.find((a) => a.id === 'yaml_definable')!;
  expect(axis.score).toBe(1);
  expect(axis.evidence).toBe('정책 값(타임아웃)의 YAML 집이 없다 → graphs/policies/<영역>.yaml · agent.yaml policies: · plugin.json 에 둔다(TS 상수는 pregate 래칫 RED)');
  expect(bare.verdict).toBe('launch');
  const homed = scoreGoalRubric({ document: '대상 경로: src/loops/a.ts\n\n완료선:\n- 리뷰 대기 타임아웃(graphs/policies/review-wait.yaml wait_min)을 넘으면 우편 한 통\n', targetPaths: ['src/loops/a.ts'] });
  expect(homed.axes.find((a) => a.id === 'yaml_definable')).toEqual({ id: 'yaml_definable', score: 0, evidence: '정책 값(타임아웃) → YAML 집 graphs/policies/' });
  expect(scoreGoalRubric({ document: '대상 경로: src/loops/a.ts\n', targetPaths: ['src/loops/a.ts'] }).axes.find((a) => a.id === 'yaml_definable')!.evidence).toBe('새 정책 값 표지 없음');
  expect(loadGoalRubric().yamlDefinable.homeMarkers).toContain('agent.yaml');
});
