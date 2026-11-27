// SIM-WORLD ta · goal policy (대표 11-27 12:2x «골 저작 시 현재 정책들을 알고 만들어야» · 상시 규칙 «시뮬레이션 월드에서 다 충분히 검증»).
// The three goal-authoring changes (#40390 POLICY-AWARE-GOAL-AUTHORING · #40391 GOAL-PRECHECK-BEFORE-IMPL ·
// #40393 GOAL-REVISE-AFTER-FIRST-IMPL ⊕ #40400 follow-ups) replayed on the REAL code: the real authorer (authorGoal with a
// faked ground/enhance — LLM 0), the real precheck, the real TDD judgment and the real revise step. Every scenario sweeps
// ≥ 5 seeded variants (cell id · paths · test file names) derived from ctx.seed — same seed ⇒ same inputs.
// Nothing outside ctx.universeRoot is opened.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorGoal, wiringCriterionApplies, type GoalAuthorDeps } from '../../../self-implement/goal-author.js';
import { judgeTddEvidence, parseOffDiffEvidence } from '../../../self-implement/off-diff-evidence.js';
import { correctAfterReview, recordGoalRevision, recordRoundCorrections, reviseJudgmentAfterImpl } from '../../../self-implement/goal-revise.js';
import { applyCoreSplit, relaxSecurityOverSpec, scoreGoalRubric } from '../../../self-dev/goal-rubric.js';
import { decideNextRun } from '../../../self-dev/run-supervisor.js';
import { precheckGoalDocument, recordGoalPrecheck } from '../../../self-dev/goal-precheck.js';
import { createWorktree, syncBaseWithRemote } from '../../../git-fs/worktree.js';
import { changedFiles } from '../../../self-implement/seams.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const SEEDS_PER_SCENARIO = 6;
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const AREAS = ['loops', 'judge-butler', 'harness', 'release-loop', 'steward', 'msg', 'els', 'fed-state'] as const;

/** Seeded variant: a cell id, a target source and its focused test — no Math.random. */
function variant(ctx: SimWorldScenarioContext, i: number): { cell: string; area: string; source: string; test: string } {
  const pick = Math.floor(ctx.random() * 1_000_000) + i;
  const area = AREAS[pick % AREAS.length]!;
  const name = `sim-${(pick % 97).toString(36)}-${i}`;
  return { cell: `SIM-${area.toUpperCase().replace(/[^A-Z]/gu, '')}-${pick % 89}`, area, source: `src/${area}/${name}.ts`, test: `src/${area}/${name}.test.ts` };
}

function authorDeps(root: string, source: string): GoalAuthorDeps {
  return {
    repositoryRoot: root,
    ground: async () => ({ grounded: true, context: '', files: [source], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
    enhance: async (original) => ({ original, checklist: ['the requested behaviour holds'], verbatimPreserved: true }),
    slugFn: async () => 'sim-goal-policy',
  };
}

const PLAN = (test: string): string => `### 검증 계획(TDD)\n- RED: 시험 먼저\n- GREEN: \`bun test ${test}\`\n`;
const GREEN = (test: string): string => `EVIDENCE: [tdd-green] 피처 시험 통과 || bun test ${test}\nRESULT: 3 pass 0 fail\n`;

/** TA-GP1 · an evidence-only (E4) cell: CellKind evidence · no production-wiring check · GREEN alone is enough (no TDD RED). */
const gp1: SimWorldScenario = {
  id: 'TA-GP1',
  title: 'evidence-only E4 cell: authored CellKind evidence · no wiring criterion · GREEN alone passes the TDD judgment',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const root = join(ctx.universeRoot, `gp1-${i}`);
      mkdirSync(join(root, 'src', v.area), { recursive: true });
      writeFileSync(join(root, v.source), 'export const shipped = 1;\n');
      const ask = `대상 경로: ${v.test} · ${v.source}\n- GoalType: implement\n\n${v.cell}-E4 — 착지한 기능의 시험 우주 증거 시험만 더한다`;
      const goal = await authorGoal(ask, authorDeps(root, v.source));
      const facts = { files: [v.source] } as unknown as Parameters<typeof wiringCriterionApplies>[1];
      const judged = judgeTddEvidence(`${goal.document}\n${PLAN(v.test)}`, parseOffDiffEvidence(GREEN(v.test)));
      if (!goal.document.includes('- CellKind: evidence')) misses.push(`${v.cell}: no CellKind evidence header`);
      if (!goal.document.includes('- 칸 종류: evidence (증거 시험만 — TDD RED 면제)')) misses.push(`${v.cell}: policy pack lacks evidence kind`);
      if (wiringCriterionApplies(ask, facts)) misses.push(`${v.cell}: wiring criterion applied to an evidence cell`);
      if (judged.needsRepair) misses.push(`${v.cell}: TDD judgment still needs repair (${judged.missing.join(',')})`);
    }
    ctx.recorder.event('ta-gp1', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('evidence cell still treated as implement', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP2 · CORE first: a goal over 8 target paths is stopped with a «split CORE first · rest to FU» reason; ≤ 8 passes. */
const gp2: SimWorldScenario = {
  id: 'TA-GP2',
  title: 'over-wide goal (> 8 target paths) is stopped with «CORE 먼저 · 나머지 FU»; the CORE-only split passes',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const extra = 9 + (i % 4);
      const wide = Array.from({ length: extra }, (_, k) => `src/${v.area}/part-${k}.ts`).join(' · ');
      const doc = (targets: string) => `대상 경로: ${targets}\n- GoalType: implement\n\n${v.cell} — 기능\n\n완료선:\n- bun test ${v.test}\n\n범위 밖=FU: ${v.cell}-EDGE\n\n## PROBLEM\n- x\n`;
      const wideResult = precheckGoalDocument(doc(wide));
      const coreResult = precheckGoalDocument(doc(`${v.source} · ${v.test}`));
      if (wideResult.verdict !== 'needs-rewrite' || wideResult.reasons[0] !== `대상 경로 ${extra}개 > 8 — CORE 먼저 한 골로 쪼개고 나머지는 FU 칸으로`) misses.push(`${v.cell}: wide → ${wideResult.verdict} ${JSON.stringify(wideResult.reasons)}`);
      if (coreResult.verdict !== 'pass') misses.push(`${v.cell}: core split → ${coreResult.verdict} ${JSON.stringify(coreResult.reasons)}`);
    }
    ctx.recorder.event('ta-gp2', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('over-wide goal not split', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP3 · conflicting instructions are caught before launch: catalog-registration duty · budget read as a waiver · E4 kind. */
const gp3: SimWorldScenario = {
  id: 'TA-GP3',
  title: 'conflicting instructions caught before launch: catalog duty marked reference-only · budget never waives evidence · E4 header added',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const base = `대상 경로: ${v.test} · ${v.source}\n- GoalType: implement\n\n${v.cell}-E4 — 증거 시험\n- 자식은 카탈로그 API 형식에 맞춰 시나리오를 등록한다.\n\n완료선:\n- bun test ${v.test}\n\n범위 밖=FU: 없음\n\n## PROBLEM\n- x\n\n### 검증 예산\n- 원격 1 · pregate 1\n`;
      const result = precheckGoalDocument(base);
      const recorded = recordGoalPrecheck(result.document, result);
      if (result.verdict !== 'fixed' || result.fixes.length !== 3) misses.push(`${v.cell}: ${result.verdict} fixes=${result.fixes.length}`);
      if (!recorded.includes('시나리오를 등록한다. (참고 — GOAL-PRECHECK: 칸 완료선 밖 의무라 요구가 아니다)')) misses.push(`${v.cell}: catalog duty not marked`);
      if (!recorded.includes('### 검증 예산\n- (예산은 실행 순서·호스트 안내일 뿐 — 완료선·증거 명령은 모두 실행한다 · 미실행은 완료가 아니다)')) misses.push(`${v.cell}: budget not noted`);
      if (!recorded.includes('- GoalType: implement\n- CellKind: evidence')) misses.push(`${v.cell}: no CellKind header`);
      if (!recorded.includes('## 사전 검토(GOAL-PRECHECK)\n- 판정: fixed')) misses.push(`${v.cell}: no precheck record`);
      if (precheckGoalDocument(result.document).verdict !== 'pass') misses.push(`${v.cell}: fixed document does not pass a second precheck`);
    }
    ctx.recorder.event('ta-gp3', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('conflicting instruction slipped through', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP4 · over-specified judgment revised after the first implementation: GREEN + only RED missing → RED recommended; no GREEN → nothing relaxed. */
const gp4: SimWorldScenario = {
  id: 'TA-GP4',
  title: 'over-spec revised after the first implementation: GREEN present → RED recommended (recorded) · GREEN absent → nothing relaxed',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const goal = `대상 경로: ${v.source} · ${v.test}\n\n${v.cell} — 기능\n\n${PLAN(v.test)}`;
      const withGreen = reviseJudgmentAfterImpl({ goal, judgment: judgeTddEvidence(goal, parseOffDiffEvidence(GREEN(v.test))), implementationOk: true });
      const noGreen = reviseJudgmentAfterImpl({ goal, judgment: judgeTddEvidence(goal, parseOffDiffEvidence('')), implementationOk: true });
      const failedImpl = reviseJudgmentAfterImpl({ goal, judgment: judgeTddEvidence(goal, parseOffDiffEvidence(GREEN(v.test))), implementationOk: false });
      const recorded = recordGoalRevision(goal, withGreen, 1 + (i % 3));
      if (!withGreen.revised || withGreen.judgment.needsRepair) misses.push(`${v.cell}: GREEN present but not revised`);
      if (!recorded.includes(`## 판정값 재조정(GOAL-REVISE-AFTER-FIRST-IMPL · 라운드 ${1 + (i % 3)})`) || !recorded.includes('- 보안 4종 기준: 변경 없음')) misses.push(`${v.cell}: revision not recorded`);
      if (noGreen.revised || !noGreen.judgment.needsRepair) misses.push(`${v.cell}: relaxed without GREEN`);
      if (failedImpl.revised) misses.push(`${v.cell}: relaxed after a failed implementation`);
    }
    ctx.recorder.event('ta-gp4', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('judgment revision wrong', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP5 · an implement cell keeps its contract: no CellKind header · policy pack present · RED still required without revision · no catalog duty. */
const gp5: SimWorldScenario = {
  id: 'TA-GP5',
  title: 'implement cell keeps its contract: policy pack present · no CellKind header · RED still required · scenario draft is reference-only',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const root = join(ctx.universeRoot, `gp5-${i}`);
      mkdirSync(join(root, 'src', v.area), { recursive: true });
      writeFileSync(join(root, v.source), 'export const x = 1;\n');
      const goal = await authorGoal(`대상 경로: ${v.source} · ${v.test}\n- GoalType: implement\n\n${v.cell} — 기능 구현`, authorDeps(root, v.source));
      const judged = judgeTddEvidence(`${goal.document}\n${PLAN(v.test)}`, parseOffDiffEvidence(GREEN(v.test)));
      if (goal.document.includes('- CellKind:')) misses.push(`${v.cell}: implement cell got a CellKind header`);
      if (!goal.document.includes('### 정책 팩') || !goal.document.includes('- 칸 종류: implement')) misses.push(`${v.cell}: no policy pack`);
      if (goal.document.includes('형식에 맞춰 요청 대상의 사건·기대를 구체화해 등록한다')) misses.push(`${v.cell}: catalog registration duty authored`);
      if (!judged.needsRepair || judged.missing.join(',') !== 'tdd-red') misses.push(`${v.cell}: implement RED requirement lost (${judged.missing.join(',')})`);
    }
    ctx.recorder.event('ta-gp5', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('implement contract changed', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP6 · HARNESS-BARE-REPO-BASE-REF on real git: a bare clone whose local main is N commits stale. Base sync records the fetched tip
 *  on refs/remotes/origin/main (local main untouched) and changedFiles reports only the child's file — not the N stale commits. */
const gp6: SimWorldScenario = {
  id: 'TA-GP6',
  title: 'bare clone with a stale local main: base sync records origin/main = fetched tip · local main untouched · changedFiles = the child change only',
  async run(ctx) {
    const misses: string[] = [];
    const git = (cwd: string, args: string[]): string => {
      const r = spawnSync('git', ['-c', 'user.email=sim@sim', '-c', 'user.name=sim', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} — ${r.stderr || r.stdout}`);
      return (r.stdout ?? '').trim();
    };
    for (let i = 0; i < 3; i += 1) {
      const v = variant(ctx, i);
      const ahead = 2 + Math.floor(ctx.random() * 5);
      const root = join(ctx.universeRoot, `gp6-${i}`);
      const origin = join(root, 'origin.git'); const seed = join(root, 'seed'); const bare = join(root, 'bare.git');
      mkdirSync(root, { recursive: true });
      git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['init', '-q', '-b', 'main', seed]);
      writeFileSync(join(seed, 'AGENTS.md'), 'agents\n');
      git(seed, ['add', '.']); git(seed, ['commit', '-q', '-m', 'stale main']);
      const stale = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['remote', 'add', 'origin', origin]); git(seed, ['push', '-q', 'origin', 'main']);
      git(root, ['clone', '-q', '--bare', origin, bare]);
      for (let k = 0; k < ahead; k += 1) { writeFileSync(join(seed, `other-${k}.md`), `${k}\n`); git(seed, ['add', '.']); git(seed, ['commit', '-q', '-m', `remote ${k}`]); }
      git(seed, ['push', '-q', 'origin', 'main']);
      const tip = git(seed, ['rev-parse', 'HEAD']);
      const synced = syncBaseWithRemote(bare, 'main', false);
      const created = createWorktree({ repoRoot: bare, branch: `se/sim-${i}`, worktreeRoot: join(root, 'wts'), base: 'main' });
      writeFileSync(join(created.path, `${v.area}-child.ts`), 'export const child = 1;\n');
      git(created.path, ['add', '.']); git(created.path, ['commit', '-q', '-m', 'child change']);
      const remoteRef = git(bare, ['rev-parse', 'refs/remotes/origin/main']);
      const localMain = git(bare, ['rev-parse', 'refs/heads/main']);
      const changed = changedFiles(created.path);
      if (synced.checkout !== tip) misses.push(`${v.cell}: synced checkout ${synced.checkout} ≠ tip`);
      if (remoteRef !== tip) misses.push(`${v.cell}: origin/main not recorded at the fetched tip`);
      if (localMain !== stale) misses.push(`${v.cell}: local main was moved`);
      if (JSON.stringify(changed) !== JSON.stringify([`${v.area}-child.ts`])) misses.push(`${v.cell}: changedFiles ${JSON.stringify(changed)} (stale +${ahead})`);
    }
    ctx.recorder.event('ta-gp6', { variants: 3, misses: misses.length });
    return misses.length ? fail('bare clone compared against a stale base', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP7 · TDD-SAME-COMMAND-PAIR: a proven same-command RED→GREEN pair passes even when a broader GREEN of another command comes first
 *  (rework-round shape from the 11-27 canary); a different-command GREEN alone still fails. */
const gp7: SimWorldScenario = {
  id: 'TA-GP7',
  title: 'TDD judgment takes the same-command RED→GREEN pair over an earlier broader GREEN; a different-command GREEN alone still needs repair',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const goal = `대상 경로: ${v.source} · ${v.test}\n\n${PLAN(v.test)}`;
      const other = `src/${v.area}/neighbour-${i}.test.ts`;
      const red = `EVIDENCE: [tdd-red] 구현 전 실패 || bun test ${v.test}\nRESULT: 0 pass · ${2 + i} fail\n`;
      const broad = `EVIDENCE: [tdd-green] 이웃 파일 통과 || bun test ${other}\nRESULT: ${50 + i} pass, 0 fail\n`;
      const same = `EVIDENCE: [tdd-green] 구현 뒤 통과 || bun test ${v.test}\nRESULT: ${2 + i} pass · 0 fail\n`;
      const paired = judgeTddEvidence(goal, parseOffDiffEvidence(`${red}${broad}${same}`));
      const unpaired = judgeTddEvidence(goal, parseOffDiffEvidence(`${red}${broad}`));
      if (paired.needsRepair || paired.green.verify !== `bun test ${v.test}`) misses.push(`${v.cell}: proven pair judged ${paired.missing.join(',')}`);
      if (!unpaired.needsRepair || unpaired.missing.join(',') !== 'tdd-green') misses.push(`${v.cell}: different-command GREEN accepted`);
    }
    ctx.recorder.event('ta-gp7', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('same-command pair misjudged', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP8 · TDD-PROVEN-CARRY: a rework round inherits the same-command pair the run already proved; without a proven pair nothing is relaxed. */
const gp8: SimWorldScenario = {
  id: 'TA-GP8',
  title: 'rework round inherits the run\'s proven same-command TDD pair; without one (or after a failed implementation) nothing is relaxed',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const goal = `대상 경로: ${v.source} · ${v.test}\n\n${PLAN(v.test)}`;
      const round0 = judgeTddEvidence(goal, parseOffDiffEvidence(`EVIDENCE: [tdd-red] 구현 전 실패 || bun test ${v.test}\nRESULT: 0 pass · 1 fail\n${GREEN(v.test)}`));
      const proven = round0.red.observed && round0.green.observed && round0.sameCommand ? round0.green.verify : undefined;
      const rework = judgeTddEvidence(goal, parseOffDiffEvidence(''));
      const carried = reviseJudgmentAfterImpl({ goal, judgment: rework, implementationOk: true, provenCommand: proven });
      const unproven = reviseJudgmentAfterImpl({ goal, judgment: rework, implementationOk: true });
      const failed = reviseJudgmentAfterImpl({ goal, judgment: rework, implementationOk: false, provenCommand: proven });
      if (proven !== `bun test ${v.test}`) misses.push(`${v.cell}: round 0 pair not proven`);
      if (!carried.revised || carried.judgment.needsRepair) misses.push(`${v.cell}: proven pair not carried`);
      if (unproven.revised) misses.push(`${v.cell}: relaxed without a proven pair`);
      if (failed.revised) misses.push(`${v.cell}: relaxed after a failed implementation`);
    }
    ctx.recorder.event('ta-gp8', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('proven pair carry wrong', misses.join(' · ')) : { ok: true };
  },
};

// ── PRECHECK-CORE-SIZE · GOAL-REVISE broadened — the one goal rubric, calibrated on the 11-27 canaries (fixtures = their asks
//    and the decomposer pieces recorded in their goal docs).
const RUBRIC_FIX = join(import.meta.dir, '..', '..', '..', 'self-dev', 'fixtures', 'goal-rubric');
const fixtureAsk = (name: string): string => readFileSync(join(RUBRIC_FIX, name), 'utf8');
const HARD_PIECES = [
  '정보성 notice에만 «할 일 없으면 조용히 종결» 안내를 추가한다.\n대상 경로: src/chat/interjection.ts',
  '정보성 notice 턴에서만 notify=false 신호를 판정하고 한 줄 영수만 남긴다.\n대상 경로: src/core-turn/run-core-turn.ts · src/tui/core/queue.ts',
];
const CANARIES = [
  { file: 'hard-notice-turn-quiet-close.md', paths: ['src/core-turn/run-core-turn.ts', 'src/chat/interjection.ts', 'src/tui/core/queue.ts'], pieces: HARD_PIECES, expect: 'split' },
  { file: 'easy-goal-precheck-optout-path.md', paths: ['src/self-dev/ask-launch-flow.ts', 'src/self-dev/ask-launch-flow-precheck-optout.test.ts'], pieces: ['opt-out 사전 검토\n대상 경로: src/self-dev/ask-launch-flow.ts'], expect: 'launch' },
  { file: 'medium-zombie-claim-reap.md', paths: ['src/steward/space/work-next-cli.ts', 'src/steward/space/work-next.ts'], pieces: ['predicate\n대상 경로: src/steward/space/work-next.ts', 'wiring\n대상 경로: src/steward/space/work-next-cli.ts'], expect: 'launch' },
  { file: 'butler-sec4-scope.md', paths: ['src/judge-butler/done-when.ts', 'src/judge-butler/judge-butler-sim.test.ts'], pieces: ['security4Hits 시험 제외\n대상 경로: src/judge-butler/done-when.ts'], expect: 'launch' },
] as const;

/** TA-GP9 · pre-launch rubric calibration: the hard canary is split (CORE = the supervisor's later piece 1) · the others launch. Seeds shuffle piece order inside a module. */
const gp9: SimWorldScenario = {
  id: 'TA-GP9',
  title: 'goal rubric pre-launch: hard canary NOTICE-TURN-QUIET-CLOSE → split with CORE = informational-notice branch · easy/medium/BUTLER-SEC4-SCOPE → launch',
  async run(ctx) {
    const misses: string[] = [];
    for (const c of CANARIES) {
      const pieces = ctx.random() < 0.5 || c.file !== 'medium-zombie-claim-reap.md' ? [...c.pieces] : [...c.pieces].reverse();
      const r = scoreGoalRubric({ document: fixtureAsk(c.file), targetPaths: c.paths, pieces });
      if (r.verdict !== c.expect) misses.push(`${c.file}: ${r.verdict} (${r.reason})`);
      if (c.expect === 'split') {
        const doc = applyCoreSplit(fixtureAsk(c.file), r);
        if (!doc.includes('- CORE: 정보성 notice에만 «할 일 없으면 조용히 종결» 안내를 추가한다.')) misses.push(`${c.file}: CORE block missing`);
      }
    }
    ctx.recorder.event('ta-gp9', { canaries: CANARIES.length, misses: misses.length });
    return misses.length ? fail('rubric calibration off', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP10 · security over-spec: an unnecessary approval gate outside security-4 is stripped pre-launch; on a security-4 path it is kept. */
const gp10: SimWorldScenario = {
  id: 'TA-GP10',
  title: 'security over-spec: an approval gate demanded outside security-4 is relaxed pre-launch · the same demand on a security-4 path is kept',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const ask = `대상 경로: ${v.source}\n\nA(답): 발사 전에 승인 게이트 를 둔다.\n`;
      const r = scoreGoalRubric({ document: ask, targetPaths: [v.source] });
      if (!relaxSecurityOverSpec(ask, r).includes('(완화 — 보안 4종 경로 밖 보안 강화 요구는 정책상 하지 않는다')) misses.push(`${v.cell}: not relaxed`);
      const kept = scoreGoalRubric({ document: ask.replace(v.source, 'src/secret/vault.ts'), targetPaths: ['src/secret/vault.ts'] });
      if (kept.relaxedSecurity.length !== 0 || kept.verdict !== 'hand') misses.push(`${v.cell}: security-4 demand dropped (${kept.verdict})`);
    }
    ctx.recorder.event('ta-gp10', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('security over-spec misjudged', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP11 · round corrections (a)(b)(c)(d)(e) with the same rubric. */
const gp11: SimWorldScenario = {
  id: 'TA-GP11',
  title: 'after a round: (a) a demand to widen the security-4 paths relaxed (other hardening = kept candidate) · (b) repeated finding written into done-when · (c) out-of-scope finding recorded as FU (kept) · (d) open «선행: #N» PR holds the goal at the launch door (hand) · real defects never dropped',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS_PER_SCENARIO; i += 1) {
      const v = variant(ctx, i);
      const sec = '`docs/` 밖의 비실행 문서가 보안 경로로 분류된다';
      const rep = `${v.cell} 실패 경로 관측 줄이 없다`;
      const edge = `${v.area} 원격 경로는 이 칸 범위 밖이다 — 후속 칸`;
      const r = correctAfterReview({ mustFix: [sec, rep, edge], previousMustFix: [rep], targetPaths: [v.source] });
      if (r.corrections.map((c) => c.kind).join(',') !== 'over-spec,under-spec,edge-to-fu') misses.push(`${v.cell}: kinds ${r.corrections.map((c) => c.kind).join(',')}`);
      if (r.mustFix.join('|') !== [rep, edge].join('|')) misses.push(`${v.cell}: rework carries ${JSON.stringify(r.mustFix)}`);
      const doc = recordRoundCorrections(`대상 경로: ${v.source}\n\n완료선:\n- 기능\n`, r.corrections, r.tighten, 1 + (i % 2));
      if (!doc.includes(`- 정정(라운드 ${1 + (i % 2)}): ${rep}`)) misses.push(`${v.cell}: done-when not tightened`);
      const held = scoreGoalRubric({ document: `대상 경로: ${v.source}\n선행: #${100 + i}\n`, targetPaths: [v.source], dependencyOpen: (r) => r === `#${100 + i}` });
      if (held.verdict !== 'hand') misses.push(`${v.cell}: open dependency launched (${held.verdict})`);
      const regression = '엣지 케이스에서 빈 배열의 결과가 누락된다';
      const consequence = `추가 확인이 없어 ${v.area} 중복 결제가 발생한다`;
      const kept = correctAfterReview({ mustFix: [regression, consequence], previousMustFix: [], targetPaths: [v.source] }).mustFix;
      if (kept.length !== 2) misses.push(`${v.cell}: real defect dropped (${2 - kept.length})`);
    }
    ctx.recorder.event('ta-gp11', { seeds: SEEDS_PER_SCENARIO, misses: misses.length });
    return misses.length ? fail('round correction wrong', misses.join(' · ')) : { ok: true };
  },
};

/** TA-GP12 · canary replay: medium keeps its round-0 proven pair in the rework round · hard is split after round 1 by the same rubric the supervisor uses. */
const gp12: SimWorldScenario = {
  id: 'TA-GP12',
  title: 'canary replay: ZOMBIE-CLAIM-REAP rework round keeps the proven pair (no abandon) · NOTICE-TURN-QUIET-CLOSE supervisor stop names the rubric CORE/FU split',
  async run(ctx) {
    const misses: string[] = [];
    const cmd = 'bun test src/steward/space/zombie-claim.test.ts';
    const goal = `대상 경로: src/steward/space/work-next.ts\n\n### 검증 계획(TDD)\n- RED: 시험 먼저\n- GREEN: \`${cmd}\`\n`;
    const round0 = judgeTddEvidence(goal, parseOffDiffEvidence(`EVIDENCE: [tdd-red] 전 || ${cmd}\nRESULT: 0 pass · 1 fail\nEVIDENCE: [tdd-green] 후 || ${cmd}\nRESULT: 6 pass · 0 fail\n`));
    const rework = reviseJudgmentAfterImpl({ goal, judgment: judgeTddEvidence(goal, parseOffDiffEvidence('')), implementationOk: true, provenCommand: round0.sameCommand ? round0.green.verify : undefined });
    if (!rework.revised || rework.judgment.needsRepair) misses.push('medium: rework round would still abandon');
    // hard: drive the real supervisor entry (decideNextRun) into decomposable-no-progress and read its stop line.
    const pieces = HARD_PIECES.map((p, i) => ({ id: `piece-${i + 1}`, feature: p.split('\n')[0]!, dependsOn: i ? ['piece-1'] : [] }));
    const stall = 2 + Math.floor(ctx.random() * 2);
    const d = decideNextRun({
      results: [{ taskId: 'notice-quiet', feature: 'NOTICE-TURN-QUIET-CLOSE', status: 'done', stage: 'pr-opened', decomposeProposal: { pieces } } as never],
      history: Array.from({ length: stall }, (_, round) => ({ round, landed: 0, actionable: 1 })),
      limits: { maxRounds: 9, stallRounds: stall },
    });
    if (d.action !== 'stop' || d.stopReason !== 'decomposable-no-progress') misses.push(`hard: supervisor ${d.action}/${String(d.stopReason)}`);
    if (!String(d.why).includes('CORE(루브릭 행동 묶음 1): 정보성 notice에만')) misses.push(`hard: stop line ${String(d.why).slice(0, 160)}`);
    ctx.recorder.event('ta-gp12', { misses: misses.length });
    return misses.length ? fail('canary replay wrong', misses.join(' · ')) : { ok: true };
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [gp1, gp2, gp3, gp4, gp5, gp6, gp7, gp8, gp9, gp10, gp11, gp12];
