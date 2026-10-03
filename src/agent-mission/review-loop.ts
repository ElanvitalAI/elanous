// ── 리뷰 반응 완결 루프 (L1: 수동트리거 폐루프) ──
//
// PLAN-review-reactive-completion-loop-2026-07-23 · P1.
// PR 에 리뷰(OK/보강/거절)가 달리면: gh 로 최신 리뷰 수집 → verdict 분류(streamLLM) →
//   - 보강 → rework 미션(agent-mission·backend 선택 가능·기본 codex)으로 지적 반영+제1원칙 렌즈 → re-push + 코멘트
//   - OK   → 승인 보고(선택 auto-merge)
//   - 거절 → park + HITL 결정 표면화(자동 rework 안 함)
// 재사용: runAgentMission(#5151)·streamLLM(brain 동형)·gh CLI·debug.log.
import { execFileSync } from 'node:child_process';
import { runGitCommand } from '../git-fs/runner.js';
import * as llm from '../llm.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { releasePathHold, releasePathHoldShouldPost, releasePathHoldComment, releasePathHoldCommentsArgs, releasePrFilePaths, RELEASE_PATH_LABEL } from '../self-dev/release-path-guard.js';
import { runAgentMission, resolveBackend, type AgentMissionResult, type EvidenceMode } from './driver.js';
import { judgeWithAcp, prepareJudgeDiff } from './acp-judge.js';
import { verifyMergeAndMaybeRevert } from './merge-safety.js';
import { assessReviewDepth, parseReviewDepthFromFilesJson, type ReviewDepth, type ReviewDepthConfig } from './review-depth.js';
import { openReviewOutcomeDb, recordMerge, updateOutcome, queryReviewStats } from './review-outcomes.js';
import { isBotSignal } from './pr-review-watch.js';
import { budgetReviewerContext } from '../agent-substrate/pr-reviewer.js';
import { DEFAULT_REVIEW_BACKEND } from '../agent-substrate/acp-reviewer.js';
import { loadReviewerContext } from '../agent-substrate/self-review-cli.js';
import { createRepositoryReferencedFileReader, type ReferencedFileReader } from '../self-implement/goal-file-reader.js';
import { parse as parsePrCommentMeta } from '../agent-substrate/pr-comment-meta.js';

export type ReviewVerdict = 'ok' | 'reinforce' | 'reject' | 'ambiguous';
export type ReviewClassificationSource = 'llm' | 'llm-call-failure' | 'empty-review' | 'injected';
export interface ReviewClassification {
  verdict: ReviewVerdict;
  asks: string[];
  reason: string;
  classificationSource: ReviewClassificationSource;
}

export interface ReviewLoopOpts {
  /** 증거 게이트(rework 미션용). 기본 tsc. */
  evidence?: EvidenceMode;
  /** rework worktree 브랜치명(기본 <pr-branch>-rework). */
  reworkBranch?: string;
  maxRounds?: number;
  /** OK 판정 시 자동 squash-merge(1a 게이트 통과 전제). 기본 false. */
  autoMergeOnOk?: boolean;
  screensDir?: string;
  /** ⭐ 최종 완결 판정을 ACP Claude Code 독립 심판으로 (L2). 기본 false=L1(1회 rework 후 재리뷰 대기). */
  finalJudge?: boolean;
  /** 심판이 merge 판정 시 자동 squash-merge. 기본 false=머지 준비됨만 표시(사람 최종클릭). */
  autoMerge?: boolean;
  /** 심판 rework 최대 라운드(finalJudge 루프). 기본 3. */
  judgeRounds?: number;
  /** 심판 백엔드. Absent defers to DEFAULT_REVIEW_BACKEND. */
  judgeBackend?: string;
  /** Configured ACP review backend, used when the CLI did not select one. */
  configuredJudgeBackend?: string;
  /** ⭐ rework 에이전트 백엔드(codex|claude|gemini|grok). `judgeBackend` 의 짝 — 안 주면 지금까지와 같은
   *  driver 기본값(codex). claude 는 PTY 구독으로 돌아 API 과금이 없다. 미등록 이름은 `resolveBackend` 가
   *  명시 에러(조용한 codex 폴백 없음·애그노스틱 계약). */
  reworkBackend?: string;
  /** Configured rework agent backend, used when the caller did not select one. */
  configuredReworkBackend?: string;
  /** ⭐ rework 미션이 워크트리를 만들 때, 그 브랜치를 이미 쥔 «소유» 워크트리를 지우지 말고 재사용하라고
   *  요청한다. 수리 라운드를 같은 브랜치에 이어 붙이는 무인 경로가 이 자리에서 막혀 왔다(실측 2026-08-11).
   *  ⛔ 기본은 미지정 = 종전 그대로. 여기서 안전 조건을 판정하지 않는다 — 판정은 `createWorktree` 의
   *     `gateWorktreeReuse` 가 하고(소유 표시·더티 검사), 이 필드는 「호출자가 명시했다」만 나른다. */
  reuseOwnedWorktree?: boolean;
  /** 심판 모델 tier 별칭 (opus|sonnet|haiku). 지정 시 ACP session/set_model 로 고정(백엔드 기본 위임 아님). */
  judgeModel?: string;
  /** ★ G10 안전봉투(2026-07-23·[[ROADMAP-elanous-is-all §2b]]) — 자율머지 후 머지 커밋의 변경파일을
   *  최신 main 격리 worktree 에서 tsc 재검, 통합 회귀면 revert PR 자동 생성+알림(자동 push 아님·사람 원클릭). */
  verifyMerge?: boolean;
  /** ★ 2계층 리뷰(2026-07-23·§2b) — 1차 리뷰 결과를 gh 대신 주입(자동 초기리뷰어). classifyReview 우회. */
  injectedReview?: { verdict: ReviewVerdict; asks: string[] };
  /** 무게 판정(assessReviewDepth) 임계 override(config autoReview.depth). heavy→2차 심판 강제. */
  depthConfig?: ReviewDepthConfig;
  /** 사람이 제공한 저장소 내부 참고 자료 경로. */
  context?: string[];
  /** 사람이 제공한 인라인 참고 자료. */
  contextText?: string[];
  /** CLI argv 순서를 보존한 참고 자료. */
  contextOrder?: Array<{ kind: 'file' | 'text'; value: string }>;
  /** 테스트용 저장소 경계 파일 리더. */
  readReferencedFile?: ReferencedFileReader;
  /** ⭐ 최종 심판 심(테스트 전용 주입). ⛔ 이 심이 있어야 「사람 자료가 «심판까지» 갔나」를
   *  구조적으로 물 수 있다 — 없으면 판정 호출부에서 컨텍스트를 지워도 테스트가 통과한다
   *  (리뷰 should-fix ② · 2026-08-06). 기본값은 실제 `judgeWithAcp`. */
  judge?: typeof judgeWithAcp;
  /** 분류 심(테스트 전용 주입). 기본값은 실제 LLM 분류이며 실패 원인을 관측 경로까지 검증한다. */
  classify?: typeof classifyReview;
  /** ⭐ `gh` 심(테스트 전용 주입). ⛔ 없으면 위 `judge` 심을 쓴 테스트가 «진짜» `gh pr diff` 를
   *  친다 — 네트워크·로컬 GitHub 상태에 매달린다(리뷰 should-fix ① · 2026-08-06). */
  runGh?: (args: string[]) => string;
  /** 자동 승인 외부 쓰기 심(테스트 전용 주입). 기본값은 실제 `approvePr`. */
  approve?: (pr: string, note: string) => void;
  /** 자동 머지 결과 영속화 심(테스트 전용 주입). 기본값은 실제 `recordOutcome`. */
  recordReviewOutcome?: (pr: string, depth: ReviewDepth, kind: 'merged' | 'reverted', files?: readonly string[]) => void;
  /** ⭐ rework 미션 심(테스트 전용 주입). ⛔ 이 심이 있어야 「고른 backend 가 «미션까지» 갔나」를
   *  구조적으로 물 수 있다 — 없으면 실제 PTY 에이전트를 띄우게 되어 테스트가 불가능하다
   *  (`judge` 심과 같은 결). 기본값은 실제 `runAgentMission`. */
  runMission?: typeof runAgentMission;
}
export interface ReviewLoopResult {
  pr: string;
  branch: string;
  verdict: ReviewVerdict;
  asks: string[];
  action: 'reworked' | 'merged' | 'ready-to-merge' | 'approved' | 'parked' | 'clarify' | 'noop';
  reworkOk?: boolean;
  pushed?: boolean;
  rounds?: number;
  detail: string;
}

function gh(args: string[]): string {
  // env: process.env — 최소 PATH(cron)에서도 ensure-bin-path 보강 PATH 로 gh 를 찾도록 명시 전달.
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024, env: process.env });
}

/** Check every page of the PR file list immediately before an unattended review-loop merge. */
function holdReleasePathBeforeReviewMerge(pr: string, runGh: (args: string[]) => string): boolean {
  let paths: string[];
  try {
    paths = releasePrFilePaths(JSON.parse(runGh(['api', '--paginate', '--slurp', '--method', 'GET', '-f', 'per_page=100', `repos/{owner}/{repo}/pulls/${pr}/files`])));
  } catch (error) {
    debug.log('self-dev.merge', 'release-path-inspection-failed', { pr, error: String(error) });
    return true;
  }
  const path = releasePathHold(paths);
  if (!path) return false;
  debug.log('self-dev.merge', 'release-path-hold', { pr, path, label: RELEASE_PATH_LABEL, surface: 'review-loop' });
  try {
    const names: unknown = JSON.parse(runGh(['label', 'list', '--search', RELEASE_PATH_LABEL, '--json', 'name']));
    if (!Array.isArray(names)) throw new Error('invalid label list');
    if (!names.some((item: unknown) => !!item && typeof item === 'object' && 'name' in item && item.name === RELEASE_PATH_LABEL)) {
      runGh(['label', 'create', RELEASE_PATH_LABEL, '--color', 'D93F0B', '--description', 'Release path requires OP approval']);
    }
    runGh(['pr', 'edit', pr, '--add-label', RELEASE_PATH_LABEL]);
  } catch (error) { debug.log('self-dev.merge', 'release-path-annotation-failed', { pr, action: 'label', error: String(error) }); }
  try { if (releasePathHoldShouldPost(() => JSON.parse(runGh(releasePathHoldCommentsArgs(pr))))) runGh(['pr', 'comment', pr, '--body', releasePathHoldComment(path)]); }
  catch (error) { debug.log('self-dev.merge', 'release-path-annotation-failed', { pr, action: 'comment', error: String(error) }); }
  return true;
}

/** ★ G10 안전봉투 — 자율머지 직후 회귀검증(verifyMerge 시). 회귀면 revert PR 이 이미 생성됨(알림 포함) →
 *  원 PR 에 링크 코멘트만. fail-open(검증 오류는 머지를 막지 않음). */
async function runMergeSafety(pr: string, opts: ReviewLoopOpts, depth: ReviewDepth): Promise<void> {
  if (!opts.verifyMerge) return;
  try {
    const s = await verifyMergeAndMaybeRevert(pr, process.cwd());
    if (s.verified && !s.passed && s.revertPr) {
      recordOutcome(pr, depth, 'reverted'); // G9 — 회귀=나쁜 결정 기록
      try { gh(['pr', 'comment', pr, '--body', `⚠️ G10 안전봉투: 무인 머지 후 tsc 통합 회귀 감지 → revert PR 자동 생성 ${s.revertPr} (검토 후 머지 결정).`]); } catch { /* noop */ }
    }
  } catch (e) { debug.log('review-loop', 'merge-safety-outer-error', { pr, error: (e as Error).message }, { level: 'error' }); }
}

/** G9 학습루프 — 무인 자율 머지/회귀를 결과 store 에 기록(fail-soft·관측 실패가 머지를 막지 않게).
 *  merged 는 변경 파일도 저장(FU followup-fixed 감지용). */
function recordOutcome(pr: string, depth: ReviewDepth, kind: 'merged' | 'reverted', files: readonly string[] = []): void {
  try {
    const db = openReviewOutcomeDb();
    const now = new Date().toISOString();
    if (kind === 'merged') recordMerge(db, pr, depth, now, files);
    else updateOutcome(db, pr, 'reverted', now);
    db.close();
    debug.log('review-loop', 'outcome-recorded', { pr, depth, kind, files: files.length });
  } catch (e) { debug.log('review-loop', 'outcome-record-fail', { pr, error: (e as Error).message }, { level: 'error' }); }
}

/** 1차 리뷰 승인(LGTM) — gh pr review --approve. approve check(사람 0 파이프라인 신뢰 신호). fail-soft. */
function approvePr(pr: string, note: string): void {
  try { gh(['pr', 'review', pr, '--approve', '--body', `✅ 자동 리뷰 승인(LGTM): ${note}`]); debug.log('review-loop', 'approved', { pr, note: note.slice(0, 80) }); }
  catch (e) { debug.log('review-loop', 'approve-fail', { pr, error: (e as Error).message }, { level: 'error' }); }
}

/** G9 안전보정 임계 — light 결정의 회귀율이 이 값 초과(+최소 샘플)면 heavy 승격(더 신중히·안전 방향만). */
const G9_REGRESSION_THRESHOLD = 0.3;
const G9_MIN_SAMPLES = 5;

/** 무게 판정 — gh pr view files → light/heavy. heavy=2차 심판 머스트. 미상/오류=보수적 heavy.
 *  ★ G9 학습루프(안전 방향만): light 판정이라도 최근 light 회귀율이 높으면 heavy 로 자동 승격(더 신중히).
 *  위험 방향(heavy→light 완화)은 절대 자동 안 함 — 그건 제안(HITL·elanous codex review-stats). */
function resolveReviewDepth(pr: string, cfg?: ReviewDepthConfig, runGh: (args: string[]) => string = gh): { depth: ReviewDepth; changedFiles: string[] } {
  let input: ReturnType<typeof parseReviewDepthFromFilesJson>;
  try { input = parseReviewDepthFromFilesJson(runGh(['pr', 'view', pr, '--json', 'files'])); }
  catch { return { depth: 'heavy', changedFiles: [] }; }
  const changedFiles = [...input.changedFiles];
  let depth = assessReviewDepth(input, cfg ?? {}).depth;
  if (depth === 'light') {
    try {
      const db = openReviewOutcomeDb();
      const s = queryReviewStats(db); db.close();
      const samples = s.light.merged + s.light.bad;
      if (samples >= G9_MIN_SAMPLES && s.light.regressionRate > G9_REGRESSION_THRESHOLD) {
        debug.log('review-loop', 'depth-upgraded-g9', { pr, from: 'light', to: 'heavy', rate: s.light.regressionRate, samples });
        depth = 'heavy'; // 학습: light 가 회귀를 자주 냄 → 이 작업은 2차 심판까지.
      }
    } catch { /* fail-open — 보정 실패가 판정을 막지 않음 */ }
  }
  return { depth, changedFiles };
}

/** 백엔드 선택의 출처 — 인자(cli) · 설정(config) · 기본값(default). 관측에 그대로 실린다. */
export type BackendChoiceSource = 'cli' | 'config' | 'default';
export interface BackendChoice { backend: string; source: BackendChoiceSource; }

/** 인자 → 설정 → 기본값 순으로 백엔드를 고르고 «그 출처»를 같이 돌려준다.
 *  ⛔ 심판(judgeBackend)과 rework(reworkBackend)가 각자 이 순서를 재구현하면 한쪽만 바뀌어도
 *     로그가 조용히 어긋난다 — 「같은 결」을 코드 한 곳으로 못 박는다. */
function resolveBackendChoice(cli: string | undefined, configured: string | undefined, fallback: string): BackendChoice {
  if (cli) return { backend: cli, source: 'cli' };
  if (configured) return { backend: configured, source: 'config' };
  return { backend: fallback, source: 'default' };
}

/** rework 백엔드 기본값 — driver 의 「미지정」 해석과 «같은 값»을 쓴다(이름 하드코딩 재발명 금지). */
function defaultReworkBackend(): string { return resolveBackend().name; }

/** 기존 CLI > config > default 선택 규칙으로 watch 사이클의 rework 관측도 결정한다. */
export function resolveReworkBackendChoice(opts: Pick<ReviewLoopOpts, 'reworkBackend' | 'configuredReworkBackend'>): BackendChoice {
  return resolveBackendChoice(opts.reworkBackend, opts.configuredReworkBackend, defaultReworkBackend());
}

/** rework 미션 한 라운드 — 고른 backend 로 외부 에이전트를 띄워 리뷰 지적을 반영시킨다.
 *  ⭐ 무엇이 골라졌고 그 출처가 인자/설정/기본값 중 무엇인지를 `rework-start` 에 남긴다(심판 `judge-start` 와 같은 결).
 *  ⛔ 백엔드 해석은 `resolveBackend` 재사용 — 미등록 이름은 여기서 명시 에러로 터진다(조용한 codex 폴백 없음). */
export async function runReworkMission(
  pr: string, branch: string, reworkBranch: string, asks: string[], opts: ReviewLoopOpts, reviewerContext: string, round: number,
): Promise<AgentMissionResult> {
  const choice = resolveReworkBackendChoice(opts);
  const reuseOwnedWorktree = opts.reuseOwnedWorktree === true;
  debug.log('review-loop', 'rework-start', { pr, reworkBranch, round, asks: asks.length, reworkBackend: choice.backend, reworkBackendSource: choice.source, reuseOwnedWorktree });
  const runMission = opts.runMission ?? runAgentMission;
  return runMission({
    mission: buildReworkMission(asks, branch, reviewerContext), branch: reworkBranch, base: branch,
    evidence: opts.evidence ?? { kind: 'tsc' },
    maxRounds: opts.maxRounds ?? 14, commit: true,
    agent: resolveBackend(choice.backend),
    ...(opts.screensDir ? { screensDir: opts.screensDir } : {}),
    // ⛔ 켜라고 «명시»했을 때만 spec 에 실린다 — 안 켜면 키 자체가 없어 미션 spec 이 종전과 «같다».
    ...(reuseOwnedWorktree ? { reuseOwnedWorktree: true } : {}),
  });
}

/** 2차 리뷰어 — ACP Opus 최종심판(현재 diff) + 판정 처리(merge→approve+머지·reject→park·rework→새 asks).
 *  ReviewLoopResult 반환=종결 · {rework} 반환=다음 라운드 asks. reinforce 루프와 ok+heavy 양쪽서 재사용. */
export async function judgeAndFinalize(
  pr: string, branch: string, asks: string[], opts: ReviewLoopOpts, reviewerContext: string, cwd: string, round: number, lastPushed: boolean, depth: ReviewDepth, changedFiles: readonly string[],
): Promise<ReviewLoopResult | { rework: string[] }> {
  const runGh = opts.runGh ?? gh;
  let diff = '';
  try { diff = runGh(['pr', 'diff', pr]); } catch { /* noop */ }
  const judgeBackendResolution = resolveBackendChoice(opts.judgeBackend, opts.configuredJudgeBackend, DEFAULT_REVIEW_BACKEND);
  const preparedDiff = prepareJudgeDiff(diff);
  debug.log('review-loop', 'judge-start', { pr, round, diffChars: preparedDiff.totalChars, judgeBackend: judgeBackendResolution.backend, judgeBackendSource: judgeBackendResolution.source });
  const judge = opts.judge ?? judgeWithAcp;
  const j = await judge({ diff, context: `반영한 지적:\n${asks.join('\n')}${reviewerContext}`, gatePassed: true, cwd, backend: judgeBackendResolution.backend, ...(opts.judgeModel ? { model: opts.judgeModel } : {}) });
  debug.log('review-loop', 'judge-verdict', { pr, round, verdict: j.verdict, asks: j.asks.length });
  const diffScope = `심판 diff 범위: 본 ${preparedDiff.judgeChars}자 / 전체 ${preparedDiff.totalChars}자`;

  if (j.verdict === 'merge') {
    if (opts.autoMerge) {
      if (holdReleasePathBeforeReviewMerge(pr, runGh)) return { pr, branch, verdict: 'reinforce', asks, action: 'parked', reworkOk: true, pushed: lastPushed, rounds: round, detail: 'OP approval required: release-path hold or PR file inspection unavailable' };
      const approve = opts.approve ?? approvePr;
      const recordReviewOutcome = opts.recordReviewOutcome ?? recordOutcome;
      approve(pr, `2차 ACP 최종심판 MERGE (round ${round})`);
      try {
        // TODO: This separate auto-merge path also lacks the self-implement docs-deletion guard; keep it unchanged so #6022 prevention remains independently provable.
        runGh(['pr', 'merge', pr, '--squash']); debug.log('review-loop', 'auto-merged', { pr, round });
        recordReviewOutcome(pr, depth, 'merged', changedFiles); // G9 학습루프(+FU 파일)
        await runMergeSafety(pr, opts, depth); // G10 안전봉투
      } catch (e) { debug.log('review-loop', 'auto-merge-fail', { pr, error: (e as Error).message }, { level: 'error' }); }
      try { runGh(['pr', 'comment', pr, '--body', `✅ ACP Claude Code 2차 최종심판: **MERGE** (라운드 ${round}·tsc/test 통과·독립 심판). 자동 squash-merge.\n${diffScope}\n사유: ${j.reason}`]); } catch { /* noop */ }
      return { pr, branch, verdict: 'reinforce', asks, action: 'merged', reworkOk: true, pushed: lastPushed, rounds: round, detail: `2차 심판 MERGE → 자동머지: ${j.reason}` };
    }
    try { runGh(['pr', 'comment', pr, '--body', `✅ ACP Claude Code 2차 최종심판: **MERGE 준비됨** (라운드 ${round}·독립 심판). 대표 최종 클릭만 남음.\n${diffScope}\n사유: ${j.reason}`]); } catch { /* noop */ }
    return { pr, branch, verdict: 'reinforce', asks, action: 'ready-to-merge', reworkOk: true, pushed: lastPushed, rounds: round, detail: `2차 심판 MERGE(사람 최종클릭): ${j.reason}` };
  }
  if (j.verdict === 'reject' || j.verdict === 'ambiguous') {
    try { runGh(['pr', 'comment', pr, '--body', `🛑 ACP Claude Code 2차 최종심판: **${j.verdict.toUpperCase()}** (라운드 ${round}) → 대표 결정 필요.\n${diffScope}\n사유: ${j.reason}`]); } catch { /* noop */ }
    return { pr, branch, verdict: 'reinforce', asks, action: 'parked', reworkOk: true, pushed: lastPushed, rounds: round, detail: `2차 심판 ${j.verdict} → HITL: ${j.reason}` };
  }
  return { rework: j.asks.length > 0 ? j.asks : asks };
}

export interface LatestReviewSource {
  headRefName: string;
  reviews?: Array<{ body?: string; state?: string; author?: { login?: string }; submittedAt?: string }>;
  comments?: Array<{ body?: string; author?: { login?: string }; createdAt?: string }>;
}

interface FilteredReviewSignals {
  reviews: NonNullable<LatestReviewSource['reviews']>;
  externalReviews: NonNullable<LatestReviewSource['reviews']>;
  comments: NonNullable<LatestReviewSource['comments']>;
  externalComments: NonNullable<LatestReviewSource['comments']>;
  selfAuthoredComments: NonNullable<LatestReviewSource['comments']>;
}

interface AppliedReviewItems {
  readonly basePrLocated: boolean;
  readonly items: readonly string[];
  readonly headlineComments: number;
}

const REVIEW_REINFORCEMENT_HEADLINE = '✅ 리뷰 보강 자동 반영(codex-in-elanous·제1원칙 렌즈):';
const ACP_REWORK_HEADLINE = '🔁 ACP Claude Code 2차 심판: **REWORK**';
const MAX_CARRIED_APPLIED_ITEMS = 12;

function analyzeAppliedReviewItems(comments: readonly NonNullable<LatestReviewSource['comments']>[number][]): Pick<AppliedReviewItems, 'items' | 'headlineComments'> {
  const items: string[] = [];
  const seen = new Set<string>();
  let headlineComments = 0;
  const newestFirst = [...comments].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  for (const comment of newestFirst) {
    const lines = (comment.body ?? '').split('\n');
    const headlineIndex = parsePrCommentMeta(lines[0] ?? '') ? 1 : 0;
    const headline = lines[headlineIndex]?.trim() ?? '';
    if (!headline.startsWith(REVIEW_REINFORCEMENT_HEADLINE) && !headline.startsWith(ACP_REWORK_HEADLINE)) continue;
    headlineComments += 1;
    for (const line of lines.slice(headlineIndex + 1)) {
      const match = /^\s*-\s+(.+?)\s*$/.exec(line);
      if (!match) {
        if (items.length && line.trim()) break;
        continue;
      }
      const item = match[1]!.trim();
      if (item && !seen.has(item) && items.length < MAX_CARRIED_APPLIED_ITEMS) {
        seen.add(item);
        items.push(item);
      }
    }
  }
  return { items, headlineComments };
}

/** 이미 봇 신호로 필터된 코멘트에서 루프가 반영했다고 보고한 bullet을 최신순으로 복원한다. */
export function extractAppliedReviewItems(comments: readonly NonNullable<LatestReviewSource['comments']>[number][]): string[] {
  return [...analyzeAppliedReviewItems(comments).items];
}

/** 브랜치의 열린 PR 코멘트에서 이전 self-dev 반영분을 fail-soft로 읽는다. */
export function fetchAppliedReviewItemsForBranch(branch: string, runGh: (args: string[]) => string = gh): AppliedReviewItems {
  try {
    const raw = runGh(['pr', 'view', branch, '--json', 'comments']);
    const source = JSON.parse(raw) as LatestReviewSource;
    const signals = filterReviewSignals(source);
    return { basePrLocated: true, ...analyzeAppliedReviewItems(signals.selfAuthoredComments) };
  } catch {
    return { basePrLocated: false, items: [], headlineComments: 0 };
  }
}

/** ⭐ 본문 있는 신호를 한 번만 거른다 — 관측과 선택이 **같은 결과**를 쓰게 하는 단일 지점.
 *  두 경로가 각자 거르면 한쪽만 바뀔 때 로그가 조용히 거짓이 된다(리뷰 should-fix·2회 재발).
 *  ⚠️ `isBotSignal` 의 mode 는 기본값이 있어 인자를 빠뜨려도 타입이 잡아주지 않는다 —
 *  reviews/comments 판정을 여기 한 곳에만 두어 그 실수가 날 자리를 없앤다. */
function filterReviewSignals(j: LatestReviewSource): FilteredReviewSignals {
  const reviews = (j.reviews ?? []).filter(r => (r.body ?? '').trim());
  const comments = (j.comments ?? []).filter(c => (c.body ?? '').trim());
  return {
    reviews,
    externalReviews: reviews.filter(r => !isBotSignal(r.author?.login ?? 'unknown', r.body ?? '', 'review')),
    comments,
    externalComments: comments.filter(c => !isBotSignal(c.author?.login ?? 'unknown', c.body ?? '')),
    selfAuthoredComments: comments.filter(c => isBotSignal(c.author?.login ?? 'unknown', c.body ?? '')),
  };
}

/** 최신 본문 리뷰를 우선하고, 없으면 자동 상태 신호를 제외한 최신 issue comment를 고른다.
 *  ⚠️ 비-export — 소비자는 `fetchLatestReview` 하나다(dead export 금지 규율). */
function selectLatestReview(branch: string, signals: FilteredReviewSignals): { branch: string; body: string; author: string } {
  const { externalReviews, externalComments } = signals;
  const pick = externalReviews[externalReviews.length - 1] ?? externalComments[externalComments.length - 1];
  return { branch, body: pick?.body ?? '', author: pick?.author?.login ?? 'unknown' };
}

/** PR 의 브랜치 + 최신 리뷰/코멘트 본문을 수집. reviews 우선, 없으면 외부 issue comment. */
export function fetchLatestReview(pr: string, runGh: (args: string[]) => string = gh): { branch: string; body: string; author: string } {
  const raw = runGh(['pr', 'view', pr, '--json', 'reviews,comments,headRefName,title,body']);
  const j = JSON.parse(raw) as LatestReviewSource;
  const signals = filterReviewSignals(j);
  debug.log('review-loop', 'comment-signals-filtered', {
    pr,
    commentCount: signals.comments.length,
    skippedBotComments: signals.comments.length - signals.externalComments.length,
    reviewCount: signals.reviews.length,
    skippedBotReviews: signals.reviews.length - signals.externalReviews.length,
    hasExternalSignal: signals.externalReviews.length > 0 || signals.externalComments.length > 0,
  });
  return selectLatestReview(j.headRefName, signals);
}

function describeThrownValue(value: unknown): string {
  try {
    if (value instanceof Error) {
      const message = value.message;
      return typeof message === 'string' ? message : String(message);
    }
    if (typeof value === 'string') return value;
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === 'string') return serialized;
    } catch { /* fall through to String for circular values */ }
    return String(value);
  } catch {
    return '[unprintable thrown value]';
  }
}

/** 리뷰 본문 → verdict + 구조화된 지적(asks). */
export async function classifyReview(body: string): Promise<ReviewClassification> {
  if (!body.trim()) return { verdict: 'ambiguous', asks: [], reason: '리뷰 본문 없음', classificationSource: 'empty-review' };
  const sys = `너는 elanous 다. PR 리뷰 본문을 읽고 판정과 구체 지적을 JSON 으로만 반환하라.
verdict:
- "ok": 승인/LGTM/머지해도 좋음.
- "reinforce": 보강/수정 요청(request-changes)·must-fix·"관측성 없음" 등 고칠 것을 지적.
- "reject": 방향이 틀림/폐기/재설계 필요(단순 수정으로 안 됨).
- "ambiguous": 판정 불확실.
asks: reinforce 일 때 codex 가 반영할 **구체 지적 목록**(각 한 줄·실행가능하게). ok/reject/ambiguous 면 [].
JSON 만: {"verdict":"...","asks":["..."],"reason":"..."}`;
  const messages: LLMMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: body.slice(0, 6000) }];
  let raw = '';
  try { raw = await llm.streamLLM(messages, () => {}, { maxTokens: 700, temperature: 0.1 }); }
  catch (e) { return { verdict: 'ambiguous', asks: [], reason: `분류 오류: ${describeThrownValue(e)}`, classificationSource: 'llm-call-failure' }; }
  const jm = raw.match(/\{[\s\S]*\}/);
  if (!jm) return { verdict: 'ambiguous', asks: [], reason: 'JSON 파싱 실패', classificationSource: 'llm' };
  try {
    const d = JSON.parse(jm[0]) as { verdict?: string; asks?: unknown; reason?: string };
    const verdict = (['ok', 'reinforce', 'reject', 'ambiguous'] as const).includes(d.verdict as ReviewVerdict) ? (d.verdict as ReviewVerdict) : 'ambiguous';
    const asks = Array.isArray(d.asks) ? d.asks.filter((x): x is string => typeof x === 'string') : [];
    return { verdict, asks, reason: typeof d.reason === 'string' ? d.reason : '', classificationSource: 'llm' };
  } catch { return { verdict: 'ambiguous', asks: [], reason: 'JSON 파싱 실패', classificationSource: 'llm' }; }
}

export function prepareReviewLoopContext(opts: Pick<ReviewLoopOpts, 'context' | 'contextText' | 'contextOrder' | 'readReferencedFile'>): {
  text: string;
  observation: Record<string, unknown>;
} {
  const loaded = loadReviewerContext(opts, opts.readReferencedFile ?? createRepositoryReferencedFileReader(process.cwd()));
  const budget = budgetReviewerContext(loaded.items);
  return {
    text: budget.text ? `\n\n사람이 제공한 참고 자료(기존 리뷰 지적·PR diff·본문에 추가):\n${budget.text}` : '',
    observation: {
      reviewerContextLoaded: loaded.items.length,
      reviewerContextFailed: loaded.failed.length,
      reviewerContextFailures: loaded.failed,
      reviewerContextSourcePaths: loaded.sourcePaths,
      // ⛔ 절단 카운트를 «절단됐을 때만» 실으면 「안 잘렸다」와 「관측이 아예 없다」가 같은 모양이 된다.
      //    무인 경로는 그 자리를 볼 사람이 없으므로 «항상» 싣는다 — 「0」과 「못 셌음」을 다른 값으로
      //    두는 규율(git-control 불변식 ③)과 같은 축이다. (리뷰 should-fix ① · 2026-08-06)
      reviewerContextTruncated: budget.truncated,
      reviewerContextShownChars: budget.shownChars,
      reviewerContextTotalChars: budget.totalChars,
      reviewerContextFullyIncluded: budget.fullyIncludedItems,
      reviewerContextPartiallyIncluded: budget.truncatedItems,
      reviewerContextOmitted: budget.omittedItems,
    },
  };
}

/** rework 미션 프롬프트 — 리뷰 지적 + ⭐제1원칙 렌즈(관측성·자기인지·셀프힐링) 상시 주입. */
export function buildReworkMission(asks: string[], prBranch: string, reviewerContext = ''): string {
  const askList = asks.map((a, i) => `${i + 1}. ${a}`).join('\n');
  return `Mission (리뷰 보강): 이 워크트리는 PR 브랜치 '${prBranch}' 다. 아래 리뷰 지적을 실제로 반영하라.

리뷰 지적:
${askList}${reviewerContext}

⭐제1원칙 렌즈(반영 시 반드시 준수):
- 관측성: self-heal/상태전이 로직엔 debug.log('<comp>.<sub>', event, data) 를 남긴다(관측 없으면 완료 아님).
- 자기인지: 변경의 의도를 코드/주석으로 명확히(elanous 가 자기 변경을 인지하도록).
- 셀프힐링: 실패/엣지 케이스에 방어적 처리, 안 되는 건 명확히 표시.

제약: 기존 코드 스타일 준수. bunx tsc --noEmit 0 유지. 관련 테스트 통과. 변경은 이 워크트리 안에서만. git commit/push/PR 은 하지 마라(내가 한다). 자율 수행. 완성+tsc0 이면 마지막 줄에 정확히 MISSION-COMPLETE.`;
}

// ══════════════════ 메인 ══════════════════
export async function runReviewLoop(pr: string, opts: ReviewLoopOpts = {}): Promise<ReviewLoopResult> {
  const runGh = opts.runGh ?? gh;
  const approve = opts.approve ?? approvePr;
  const recordReviewOutcome = opts.recordReviewOutcome ?? recordOutcome;
  const reviewerContext = prepareReviewLoopContext(opts);
  debug.log('review-loop', 'start', { pr, ...reviewerContext.observation });
  const { branch, body, author } = fetchLatestReview(pr, opts.runGh);
  debug.log('review-loop', 'review-fetched', { pr, branch, author, bodyChars: body.length });

  // ★ 2계층 라우팅(§2b) — 작업 무게로 2차 심판 강제. heavy=반드시 ACP Opus(2차)까지. light=1차+tsc 충분.
  const { depth, changedFiles } = resolveReviewDepth(pr, opts.depthConfig, opts.runGh);
  const effectiveFinalJudge = depth === 'heavy' || !!opts.finalJudge;
  debug.log('review-loop', 'depth', { pr, depth, effectiveFinalJudge, injected: !!opts.injectedReview });

  // ★ 1차 리뷰 — 자동 초기리뷰어가 주입(injectedReview)했으면 그것, 아니면 gh 리뷰 분류.
  const cls: ReviewClassification = opts.injectedReview
    ? { verdict: opts.injectedReview.verdict, asks: opts.injectedReview.asks, reason: '자동 초기리뷰(1차·주입)', classificationSource: 'injected' }
    : await (opts.classify ?? classifyReview)(body);
  debug.log('review-loop', 'classified', {
    pr,
    verdict: cls.verdict,
    asks: cls.asks.length,
    source: opts.injectedReview ? 'injected' : 'gh',
    reason: cls.reason,
    classificationSource: cls.classificationSource,
  });

  let asks = cls.asks;

  if (cls.verdict === 'ok') {
    // light: 1차 clean 으로 충분 → approve + 머지. heavy: 1차 ok 여도 2차 심판 머스트.
    if (!effectiveFinalJudge) {
      if ((opts.autoMergeOnOk || opts.autoMerge) && holdReleasePathBeforeReviewMerge(pr, runGh)) {
        return { pr, branch, verdict: 'ok', asks: [], action: 'parked', detail: 'OP approval required: release-path hold or PR file inspection unavailable' };
      }
      approve(pr, `소작업(light)·1차 리뷰 clean`);
      let merged = false;
      if (opts.autoMergeOnOk || opts.autoMerge) {
        try {
          // TODO: This separate auto-merge path also lacks the self-implement docs-deletion guard; keep it unchanged so #6022 prevention remains independently provable.
          runGh(['pr', 'merge', pr, '--squash']); debug.log('review-loop', 'auto-merged', { pr, depth });
          recordReviewOutcome(pr, depth, 'merged', changedFiles); // G9 학습루프(+FU 파일)
          await runMergeSafety(pr, opts, depth); merged = true; // G10 안전봉투
        } catch (e) { debug.log('review-loop', 'auto-merge-fail', { pr, error: (e as Error).message }, { level: 'error' }); }
      }
      return { pr, branch, verdict: 'ok', asks: [], action: merged ? 'merged' : 'approved', detail: `light·1차 clean → approve${merged ? '+자동머지' : '(머지 대기)'}` };
    }
    // heavy + ok → rework 없이 2차 심판(현재 diff)으로.
    const res = await judgeAndFinalize(pr, branch, [], opts, reviewerContext.text, process.cwd(), 0, false, depth, changedFiles);
    if (!('rework' in res)) return res;
    asks = res.rework; // 심판이 rework 요구 → reinforce 루프로(아래).
  } else
  if (cls.verdict === 'reject') {
    // 자동 rework 안 함 — HITL 결정 표면화(코멘트).
    try { runGh(['pr', 'comment', pr, '--body', `🛑 리뷰=거절 판정. 자동 rework 하지 않음(설계 결정). 사유: ${cls.reason}\n→ 대표 결정 필요(재설계/폐기/방향 재논의).`]); } catch { /* noop */ }
    debug.log('review-loop', 'parked-reject', { pr, reason: cls.reason.slice(0, 120) });
    return { pr, branch, verdict: 'reject', asks: [], action: 'parked', detail: `거절 → HITL: ${cls.reason}` };
  }
  if (cls.classificationSource === 'llm-call-failure') {
    try { runGh(['pr', 'comment', pr, '--body', `⚠️ 리뷰 분류 호출이 실패했다(${cls.reason}). 인프라 장애이므로 우리 쪽을 고치고 다시 돌려야 한다.`]); } catch { /* noop */ }
    return { pr, branch, verdict: cls.verdict, asks, action: 'parked', detail: `분류 호출 실패 → 재실행: ${cls.reason}` };
  }
  // ok+heavy 에서 2차 심판이 rework 요구하면 asks 가 채워져(verdict 여전히 ok) 여기 통과. 그 외 ambiguous/무지적은 clarify.
  if (cls.verdict === 'ambiguous' || asks.length === 0) {
    try { runGh(['pr', 'comment', pr, '--body', `❓ 리뷰 판정이 모호하다(${cls.reason}). 명확한 지적(보강/거절)을 남겨주면 자동 반영하겠다.`]); } catch { /* noop */ }
    return { pr, branch, verdict: 'ambiguous', asks, action: 'clarify', detail: '모호 → 명확화 요청' };
  }

  // ── 보강: rework(+2차 심판 루프·effectiveFinalJudge=heavy||finalJudge) ──
  const reworkBranch = opts.reworkBranch ?? branch; // 기본 in-place(PR 브랜치)
  const maxJudgeRounds = effectiveFinalJudge ? (opts.judgeRounds ?? 3) : 1;
  let round = 0;
  let lastPushed = false;

  while (round < maxJudgeRounds) {
    round++;
    // 1) rework (기본 codex · opts.reworkBackend 로 선택) + 객관 게이트(tsc/test)
    const r = await runReworkMission(pr, branch, reworkBranch, asks, opts, reviewerContext.text, round);
    debug.log('review-loop', 'rework-done', { pr, round, ok: r.ok });
    if (!r.ok) {
      try { gh(['pr', 'comment', pr, '--body', `⚠️ 보강 rework 미완(라운드 ${round}·증거 미충족: ${r.detail}) → 대표 확인 필요.`]); } catch { /* noop */ }
      return { pr, branch, verdict: 'reinforce', asks, action: 'parked', reworkOk: false, pushed: lastPushed, rounds: round, detail: `rework 미완: ${r.detail}` };
    }
    // 2) push
    try {
      const push = runGitCommand(r.worktree, ['push', 'origin', `HEAD:${branch}`], { encoding: 'utf8', timeout: 60000 });
      if (push.status !== 0) throw new Error(push.stderr || 'git push failed');
      lastPushed = true;
    } catch (e) { debug.log('review-loop', 'push-fail', { pr, error: (e as Error).message }, { level: 'error' }); }

    // 3) L1(2차 심판 없음·light): 반영+push 후 재리뷰 대기
    if (!effectiveFinalJudge) {
      try { gh(['pr', 'comment', pr, '--body', `✅ 리뷰 보강 자동 반영(codex-in-elanous·제1원칙 렌즈):\n${asks.map(a => `- ${a}`).join('\n')}\n\n(tsc/test 통과·push·소작업 light). 재리뷰 부탁.`]); } catch { /* noop */ }
      return { pr, branch, verdict: 'reinforce', asks, action: 'reworked', reworkOk: true, pushed: lastPushed, rounds: round, detail: '보강 반영+push(light·재리뷰 대기)' };
    }

    // 4) ⭐ 2차 최종심판(heavy·ACP Opus) — judgeAndFinalize 재사용(merge→approve+머지·reject→park·rework→새 asks)
    const res = await judgeAndFinalize(pr, branch, asks, opts, reviewerContext.text, r.worktree, round, lastPushed, depth, changedFiles);
    if (!('rework' in res)) return res;
    asks = res.rework; // 심판이 준 새 지적으로 다음 라운드
    try { gh(['pr', 'comment', pr, '--body', `🔁 ACP Claude Code 2차 심판: **REWORK** (라운드 ${round}). 추가 지적 반영 재시도:\n${asks.map(a => `- ${a}`).join('\n')}`]); } catch { /* noop */ }
  }

  // max judge rounds 초과 — 수렴 실패 → HITL
  try { gh(['pr', 'comment', pr, '--body', `⚠️ 2차 심판 루프 ${maxJudgeRounds}라운드 내 수렴 실패 → 대표 결정 필요.`]); } catch { /* noop */ }
  return { pr, branch, verdict: 'reinforce', asks, action: 'parked', reworkOk: true, pushed: lastPushed, rounds: round, detail: `심판 ${maxJudgeRounds}라운드 수렴실패 → HITL` };
}
