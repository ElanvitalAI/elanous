// self-implement 실 seam 어댑터 (2026-07-19 · P1) — 오케스트레이터의 각 단계를 실제
// 재사용 함수에 연결한다. 미션 plan/build 코드 무접촉(함수만 호출·조사 실측).
//
//   fork      → forkSessionById            (session/index.ts)
//   worktree  → createWorktree             (git-fs/worktree.ts)
//   implement → 헤드리스 `chat --tools --goal-loop` 서브프로세스 (자식 elanous·canonical goal-loop·PTY 無)
//   gate      → runIntegrityGate           (autopilot/build/integrity-gate.ts · standalone)
//   openPr    → git commit+push + dispatchOpenPullRequest (tool-runtime/git-pr-runtime.ts)
//
// 층 B "elanous 이 elanous 을 부린다"(2026-07-20 S1) — 구현 seam 이 취약한 PTY 드라이버
// (driveHeadlessElanous·stale)에서 검증된 헤드리스 서브프로세스로 이관. 대표 지시: 구현물(artifact)이
// 목적이라 메커니즘(하니스/중첩/ACP)은 fungible — 되는 방법을 쓴다. driveHeadlessElanous 는 파일 존치
// (S2/S3 화면 I/O 서피스용). canonical goal-loop = [[PLAN-unified-autonomous-agent-substrate-2026-07-20]].

import { fileURLToPath } from 'node:url';
import { judgePredictionAccuracy, mustFixTrendFromHistory, renderJudgeOwnSignals, renderJudgePredictionAccuracy } from './judge-prediction-accuracy.js';
import { isElanousRuntimeArtifactPath } from './gate-scope.js';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createArtifactStore } from '../artifact/index.js';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { forkSessionById, HARNESS_SESSION_ORIGIN, isHarnessSessionOrigin } from '../session/index.js';
import { configuredWorktreeRoot, getUserConfig, resolveRoleLlm } from '../user-config.js';
import { getProviderForConfig } from '../llm.js';
import { createWorktree, DEFAULT_BRANCH_WORKTREE_BASE, removeWorktree, resolveDefaultBranchBase, resolveMainRepoRoot } from '../git-fs/worktree.js';
import { isWorktreeInUse, listActiveTerminalDirectories } from '../harness/harness-clean.js';
import { readWorktreePorcelain } from './abandoned-classification.js';
import { recordHarnessWorktreeGoalMetadata, recordHarnessWorktreeProvenance, type HarnessWorktreeGoalMetadata } from '../harness/harness-worktree-add.js';
import { runGitCommand } from '../git-fs/runner.js';
import { provisionDerivedUniverse } from '../instance/provision.js';
import { DEFAULT_GATE_STEPS, runIntegrityGate, type GateResult, type GateStepName } from '../autopilot/build/integrity-gate.js';
import { androidFilesIn, runAndroidUnitTestGate } from '../../scripts/ci-android-unit-tests.js';
import { iosFilesIn, runIosUnitTestGate } from '../../scripts/ci-ios-unit-tests.js';
import { detectGateCommand } from './detect-gate.js';
// ⭐ 게이트 스코프 근본 수리(2026-07-26) — 풀 `bun test` 폴백 제거 + 연관 테스트 유도(순수).
import { resolveGateScope } from './gate-scope.js';
import { buildImporterTestIndex, isTestPath } from './importer-test-index.js';
import { countTestDeclarations } from './test-declarations.js';
import {
  allowsBaselineOnlyFailure,
  buildGateBaselineReport,
  extractGateTestFailures,
  runGateBaseline,
  rerunBunTimeoutFailures,
  runVerifyByBreaking,
  runReverseVerifyByBreaking,
  formatVerifyByBreakingNote,
  isTestAssetPath,
  formatVerifyByBreakingSkipNote,
  formatVerifyByBreakingScopeSkipNote,
  type BaselineProcessResult, gateBaselineLogLevel, formatGateBaselineNote } from './gate-baseline.js';
import { runConfigSyntaxGate } from './config-gate.js';
import { stageNonGitDir, stageFile, applyShadowToTarget, applyFileToTarget } from './shadow-stage.js';
import type { TargetKind } from './target-kind.js';
import { basename } from 'node:path';
import { makePrManager, type PrManager } from '../autopilot/pr-manager.js';
import { defaultSpawnGh, lookupOpenDraftPrs } from '../cli/logs-abandoned-draft-prs.js';
import { loadRunLedger, runLedgerDir } from './run-ledger.js';
import { readdirSync } from 'node:fs';
import { budgetReviewerContext, reviewDiffBudgetObservation, reviewPullRequest, renderReview, type ReviewerContextItem } from '../agent-substrate/pr-reviewer.js';
import { buildReviewIntent, type ReviewIntentInput } from '../agent-substrate/review-intent.js';
import { OFF_DIFF_EVIDENCE_PROMPT, requiredEvidenceFromGoal, renderRequiredEvidencePrompt, tailWithOmissionMarker } from './off-diff-evidence.js';
import { fetchAppliedReviewItemsForBranch } from '../agent-mission/review-loop.js';
import { GoalRunStore, type GoalPriorRuns } from './goal-run-store.js';
import { CLEAN_BUILD_ANCHOR } from './build-discipline.js';
import { addedExportedFunctionParameters, removedExportedSymbols, requiredExportFieldsAdded } from '../../scripts/ci-typecheck-changed.js';
import { tscEnv, assessTypecheckExecution, classifyTypecheckErrors, readTestTypecheckBaseline, resolveTypecheckConfig, type MissingTypecheckGateConfig, type ResolvedTypecheckConfig, type TypecheckExecutionResult, type TypecheckNoInspectionReason } from '../typecheck-ratchet.js';
import { nestCapReached, childNestEnv, nestInfo } from '../agent/nest-depth.js';
import { harnessBoundaryEnv, harnessBoundaryRequestsEnv, harnessBoundaryResponsesEnv, harnessSpaceEnv, getHarnessSpace, normalizeSpaceId, getHarnessRunId, resolveRunIdentity } from '../harness/harness-space.js';
import { debug } from '../debug/log.js';
import { LogStore } from '../mss/logging/log-store.js';
import { instanceNameForStateDir } from '../instance-identity.js';
import { queryStructuredChildProviderErrors } from './orchestrator.js';
import { buildImplementReport } from './off-diff-evidence.js';
import { countReflectFactConflicts, type MustFixRefutation, type ReflectEvidenceFacts, type ReflectGateFacts } from './reflect-mustfix.js';
import { isSupervisorDecisionSection, splitGoalSections, supervisorGoalDigest } from './goal-digest.js';
import type { SupervisionReworkSource } from './supervision-vocabulary.js';
import type { ReworkBudgetVerdict } from './run-outcome.js';
import { runHeadlessGoalLoopPty } from './headless-elanous-driver.js';
import { buildLlmHitlRelay, SIDE_EFFECT_RE } from '../harness/llm-hitl-relay.js';
import { dispatchAskUserQuestion } from '../ask-user-question/tool.js';
import { parseQuestionRequest } from '../ask-user-question/types.js';
import type { DocumentReferenceStatus } from './self-implement-runtime.js';

declare module './headless-elanous-driver.js' {
  interface HeadlessGoalLoopPtyOptions {
    /** Runtime-resolved document reference statuses; child policy remains outside this seam. */
    documentReferences?: readonly DocumentReferenceStatus[];
  }
}

// ⛔ orchestrator.ts 는 이 조각에서 고치지 않는다(배선은 조각 ②).
//    기존 seam 들이 하던 대로 — 선언 병합으로 SelfImplementSeams 에 자리를 연다.
declare module './orchestrator.js' {
  interface SelfImplementSeams {
    /** PR close(+브랜치 삭제). 기본 구성은 PrManager.closePr 위임(같은 인자·같은 반환).
     *  오케스트레이터는 아직 부르지 않는다 — 그 배선은 조각 ②다. */
    closePr?: (prUrl: string, comment?: string) => boolean;
  }
}
import { harnessPolicyEnv } from './harness-policy.js';
import { createLlmControlBrain, type LlmControlBrainOpts } from '../autopilot/llm-control-brain.js';
import { ptyAvailable } from '../pty-shell/registry.js';
import type { SelfImplementSeams, ReviewDiffContext } from './orchestrator.js';
import { evaluateTermination } from '../auto-research/termination-dsl.js';
import { withIndependentChecker } from '../conductor/termination-checker.js';

const GIT_TIMEOUT = 20_000;

type GitCallContext = {
  repositoryRoot: string | null;
  isWorktree: boolean | null;
};

// ⛔ **캐시하지 않는다**(무인 리뷰 must-fix 2026-08-02). 이 관측의 계약은 *"**그때의** 뿌리·
//    worktree 여부"* 인데, cwd 로 캐시하면 같은 경로가 지워졌다 다른 저장소로 되살아나거나
//    worktree 가 주 저장소로 바뀌었을 때 **틀린 값을 계속 남긴다**. 관측이 틀리면 이 PR 의
//    존재 이유가 사라지므로, 호출당 git 두 번을 더 쓰는 쪽을 택한다.
function gitCallContext(cwd: string): GitCallContext {
  const rootResult = runGitCommand(cwd, ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: GIT_TIMEOUT });
  const repositoryRoot = rootResult.status === 0 ? `${rootResult.stdout ?? ''}`.trim() || null : null;
  const metadataResult = repositoryRoot
    ? runGitCommand(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { encoding: 'utf8', timeout: GIT_TIMEOUT })
    : null;
  const metadata = metadataResult?.status === 0 ? `${metadataResult.stdout ?? ''}`.trim().split(/\r?\n/) : [];
  const [gitDir, commonGitDir] = metadata;
  const context = {
    repositoryRoot,
    isWorktree: gitDir && commonGitDir ? resolve(gitDir) !== resolve(commonGitDir) : null,
  };
  return context;
}

/** ⛔ **부재와 미지를 같은 값으로 적지 않는다**(무인 리뷰 · 교차 세션 must-fix 2026-08-02).
 *  종전엔 detached HEAD 와 git 실패가 **둘 다 `null`** 이었다. 그런데 이 트랙이 잡으려는 사고가
 *  바로 *"자동 교정이 사람 트리를 detach 한다"* 라서, 사고가 나면 계측이 그 서명을 지운다.
 *  실측(`git symbolic-ref --quiet --short HEAD`): 브랜치 위 `0` · detached `1` · 저장소 아님 `128`. */
type GitBranchObservation = { branch: string | null; branchState: 'named' | 'detached' | 'unknown' };

function gitBranch(cwd: string): GitBranchObservation {
  try {
    const branchResult = runGitCommand(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', timeout: GIT_TIMEOUT });
    if (branchResult.status === 0) {
      const name = `${branchResult.stdout ?? ''}`.trim();
      return name ? { branch: name, branchState: 'named' } : { branch: null, branchState: 'unknown' };
    }
    // exit 1 = HEAD 는 읽혔는데 심볼릭 ref 가 아니다 ⇒ detached.
    // 그 밖(128 등) = 저장소가 아니거나 git 이 실패했다 ⇒ 모른다.
    return branchResult.status === 1
      ? { branch: null, branchState: 'detached' }
      : { branch: null, branchState: 'unknown' };
  } catch {
    return { branch: null, branchState: 'unknown' };
  }
}

/** gate.baseline 관측용 — 브랜치/작업 디렉토리를 못 얻어도 키는 남기고 값은 null. 예외는 삼킨다. */
export function observeGateBaselineLocation(cwd: string): { branch: string | null; workdir: string | null } {
  let branch: string | null = null;
  let workdir: string | null = null;
  try {
    branch = gitBranch(cwd).branch;
  } catch {
    branch = null;
  }
  try {
    workdir = cwd || null;
  } catch {
    workdir = null;
  }
  return { branch, workdir };
}

/** self-implement 자식만의 종료 보고 보존 규칙. 범용 control brain 기본 프롬프트에는 넣지 않는다. */
export const SELF_IMPLEMENT_COMPLETION_REPORT_HINT = '자식이 최종 요약 또는 GOAL-COMPLETE 완료 마커를 출력 중이면 목표가 달성돼 보여도 done이 아니라 wait을 선택하라. 완료 보고가 끝날 때까지 기다려야 한다.';

/** self-implement 실행 경계가 범용 brain에 전용 종료-보고 규칙을 주입한다. */
export function createSelfImplementControlBrain(opts: Omit<LlmControlBrainOpts, 'systemHint'>) {
  return createLlmControlBrain({ ...opts, systemHint: SELF_IMPLEMENT_COMPLETION_REPORT_HINT });
}

function git(cwd: string, argv: string[]): { ok: boolean; out: string; stdout: string } {
  const context = gitCallContext(cwd);
  const { branch, branchState } = gitBranch(cwd);
  const r = runGitCommand(cwd, argv, { encoding: 'utf8', timeout: GIT_TIMEOUT });
  const ok = r.status === 0;
  debug.log('self-implement.git', 'call', {
    repositoryRoot: context.repositoryRoot,
    branch,
    branchState,
    isWorktree: context.isWorktree,
    // ⛔ 첫 토큰만 남긴다 — 두 번째 토큰은 브랜치·경로 같은 값일 수 있다(무인 리뷰 must-fix).
    // ⚠️ 계약: 이 러너는 argv[0] 이 **서브커맨드**인 호출만 받는다. `-c`·`-C` 같은 git 전역
    //    옵션을 앞에 붙이는 호출이 생기면 이 값은 서브커맨드가 아니게 되므로, 그때는 옵션을
    //    건너뛰는 규칙을 함께 넣어야 한다(지금은 그런 호출이 없다 — 호출부 전수 확인).
    subcommand: argv[0] ?? '',
    ok,
  });
  return { ok, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: `${r.stdout ?? ''}` };
}

/** 로컬 origin/main ref만으로 gate worktree의 뒤처짐을 센다. fetch하지 않으며 판정 불가면 undefined다. */
/** `rev-list --count` 출력 → 뒤처짐 수. ⛔ **부분 파싱 금지**(리뷰 should-fix · 2026-07-30) —
 *  `Number.parseInt` 는 `3garbage` 를 3 으로 받는다. 그것은 **조용한 거짓**이고 이 seam 의
 *  **미지 불변식**(조회 불가는 `0` 과 다른 값)을 깨뜨린다. ⇒ 출력 전체가 십진 정수일 때만 수를 낸다.
 *  순수 함수라 git 없이 직접 테스트한다. */
export function parseBehindCount(out: string): number | undefined {
  const raw = out.trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const behind = Number.parseInt(raw, 10);
  return Number.isSafeInteger(behind) ? behind : undefined;
}

export function readReworkSalvageEvidence(cwd: string): { clean: boolean; aheadCommits: number } {
  const porcelain = git(cwd, ['status', '--porcelain']);
  const ahead = git(cwd, ['rev-list', '--count', 'origin/main..HEAD']);
  if (!porcelain.ok || !ahead.ok) throw new Error('git evidence query failed');
  const rawAhead = ahead.out.trim();
  if (!/^\d+$/.test(rawAhead)) throw new Error('git ahead count was not an integer');
  return { clean: porcelain.out.trim() === '', aheadCommits: Number.parseInt(rawAhead, 10) };
}

/** ⭐ 골 «파일»로 런을 띄우는 «한 자리» — 표면이 둘 이상이라 여기서 만든다(2026-08-11 72차).
 *  ⛔ 표면(TUI 슬래시·rework salvage)마다 spawn 을 새로 쓰면 인자·env 가 조용히 갈린다.
 *  ⛔ detached ⊕ unref — 띄운 표면이 죽어도 런은 산다(TUI 를 닫아도 계속 돈다). */
/** 이 패키지의 CLI 진입 스크립트(절대 경로) — 체크아웃이든 설치본(`node_modules/elanous`)이든 같은 자리다. */
export const ELANOUS_ENTRY_SCRIPT = fileURLToPath(new URL('../../bin/elanous.mjs', import.meta.url));

export function launchDevGoalFileDetached(
  input: { goalFile: string; base?: string; target?: string; correlation?: string; env?: Readonly<Record<string, string>> },
  spawnChild: typeof spawn = spawn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // ⛔ 상대 경로 `bin/elanous.mjs` 금지 — cwd 는 «사용자 프로젝트»다. 2026-09-26 베어 Ubuntu 26.04 실측:
    //   TUI `/harness ask` 가 «런을 띄웠다»고 말했는데 자식이 `bin/elanous.mjs` 를 못 찾고 즉사했다(stdio ignore 라 조용히).
    //   elanous 체크아웃 밖에서는 이 문이 한 번도 돈 적이 없었다 ⇒ 실행 중인 패키지 기준의 절대 경로로 부른다.
    const child = spawnChild(process.execPath, [
      ELANOUS_ENTRY_SCRIPT, 'dev', '--file', input.goalFile,
      ...(input.base ? ['--base', input.base] : []),
      ...(input.target ? ['--target', input.target] : []),
      ...(input.correlation !== undefined ? ['--correlation', input.correlation] : []),
    ], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(input.env ?? {}) },
    });
    const onSpawn = (): void => {
      child.off('error', onError);
      child.unref();
      resolve();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** rework salvage — ⛔ 위 «한 자리»를 쓴다(인자·env 가 갈리지 않게). */
export function launchReworkSalvage(
  input: { goalFile: string; base: string; salvageAttempt: number },
  spawnChild: typeof spawn = spawn,
): Promise<void> {
  return launchDevGoalFileDetached(
    { goalFile: input.goalFile, base: input.base, env: { ELANOUS_REWORK_SALVAGE_ATTEMPT: String(input.salvageAttempt) } },
    spawnChild,
  );
}

export function gateWorktreeBehindMain(cwd: string): number | undefined {
  const result = git(cwd, ['rev-list', '--count', 'HEAD..origin/main']);
  if (!result.ok) return undefined;
  return parseBehindCount(result.out);
}

const execFileAsync = promisify(execFile);

/** git 의 **비동기** 변형 — spawnSync 와 동일 계약({ok,out=stdout+stderr})이나 이벤트루프를 양보한다.
 *  #24: 대형 worktree 의 `git diff` 가 동기(spawnSync)면 리뷰 스테이지가 인프로세스로 돌 때 데몬
 *  메인루프를 그 시간만큼 국소 굶긴다(watchdog 마커 `harness:review:worktreeDiff`). 비동기 git 은
 *  그 국소 stall 을 제거한다(초대형 diff 방어). maxBuffer 는 diff 절단 방지로 넉넉히. */
async function gitAsync(cwd: string, argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', argv, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out: `${stdout ?? ''}${stderr ?? ''}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}` };
  }
}

/** 기본 브랜치 ref 해석(origin/HEAD → origin/main 등·폴백 main/master). 없으면 null. */
export function defaultBranchRef(cwd: string): string | null {
  const sym = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).out.trim();
  if (sym.startsWith('refs/remotes/')) return sym.slice('refs/remotes/'.length);
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', b]).out.trim()) return b;
  }
  return null;
}

function branchName(ref: string): string {
  return ref.replace(/^origin\//, '');
}

/** PR base가 기본 브랜치가 아닌 경우 origin에 존재하는지 fail-closed로 검증한다.
 *
 *  ⛔ 반환은 **브랜치 이름**이지 remote-tracking ref 가 아니다. `resolveDefaultBranchBase` 는
 *  git 연산용으로 `origin/main` 을 내는데, 이 값의 (비-테스트) 소비처는 `openPr` 하나뿐이고
 *  거기서 곧장 `gh` 의 PR base 로 간다. GitHub 에는 `origin/main` 이라는 브랜치가 없어
 *  `Proposed base branch 'origin/main' was not found (updatePullRequest)` 로 **PR 개설이 죽었다**
 *  (2026-08-02 · 양 트랙 · 산출은 푸시된 뒤라 잃지 않았고 무인 완결만 끊겼다).
 *  ⚠️ `branchName` 은 위 비교에만 쓰이고 **반환값에는 안 쓰이고 있었다** — 자가 있었고 안 댔다. */
export function assertBaseBranchOnOrigin(cwd: string, base: string | undefined): string | undefined {
  const resolvedBase = base === DEFAULT_BRANCH_WORKTREE_BASE ? resolveDefaultBranchBase(cwd) ?? base : base;
  if (!resolvedBase) return resolvedBase;
  if (branchName(defaultBranchRef(cwd) ?? '') === branchName(resolvedBase)) return branchName(resolvedBase);
  const remote = git(cwd, ['ls-remote', '--exit-code', '--heads', 'origin', branchName(resolvedBase)]);
  if (!remote.ok) {
    throw new Error(`base 브랜치 ${branchName(resolvedBase)} 가 origin 에 없다 — 먼저 push 하거나 origin 브랜치를 base 로 지정하라`);
  }
  return branchName(resolvedBase);
}

/** ★ 우리가 흘린 것은 자식의 산출물이 아니다(2026-07-27) — 파생 우주 물질화가 워크트리 안에
 *  `.elanous-test/` 를 만든다. self-build 의 성공 판정은 **artifact-first**(`changed && !timedOut`)라,
 *  이걸 빼지 않으면 *"자식이 아무것도 안 했는데 우리가 깐 config 때문에 ok:true"* 가 된다.
 *  elanous 레포는 `.gitignore` 에 `/.elanous-test/` 가 있어 우연히 가려지지만, **외부 repo 개발**
 *  (elanousBinRoot 경로)에는 그 줄이 없다 — 거기서 실제로 터진다. 실측: 이 PR 의 배선 테스트가
 *  합성 repo 에서 `변경: yes · 툴콜 0` 을 성공으로 돌려주는 것을 잡았다.
 *  `.elanous-skill-artifacts/`도 executor가 워크트리 안에서 승격 증거로 스냅샷하되 Git 변경은 아니므로,
 *  이 공유 pathspec을 쓰는 worktreeHasChanges·preservationHasChanges·changedFiles 모두에서 제외한다. */
const NOT_OUR_OWN_LEAVINGS = ['--', '.', ':(exclude).elanous-test', ':(exclude).elanous-skill-artifacts'] as const;

/** worktree 에 self-build 산출물이 있나. 미커밋(untracked 포함) OR 기본 branch와의 fork 지점 이후 커밋 변경을 본다.
 *  `excludePaths`(워크트리 상대) = 하니스가 «깔아 둔» 경로 — 두 검사 모두에서 뺀다. 2026-09-24: 오케스트레이터가
 *  복사한 골 문서가 «변경»으로 세어져, 아무것도 못 한 자식(사용량 소진)이 `ok: true` 로 리뷰까지 갔다. */
export function worktreeHasChanges(cwd: string, excludePaths: readonly string[] = []): boolean {
  const excluded = excludePaths.filter(Boolean).map((path) => `:(exclude)${path}`);
  if (git(cwd, ['status', '--porcelain', ...NOT_OUR_OWN_LEAVINGS, ...excluded]).out.trim().length > 0) return true;
  const comparisonBase = defaultBranchRef(cwd);
  if (!comparisonBase) return false;
  const fork = git(cwd, ['merge-base', 'HEAD', comparisonBase]).out.trim().split('\n')[0];
  if (!fork) return false;
  return excluded.length
    ? !git(cwd, ['diff', '--quiet', fork, 'HEAD', '--', '.', ...excluded]).ok
    : !git(cwd, ['diff', '--quiet', fork, 'HEAD']).ok;
}

/** 실패 산출물 보존 전용 판별. 현재 대상 base 자체와 비교해 main-sync로 유입된 변경만 PR로 보존하지 않는다. */
export function preservationHasChanges(cwd: string, base?: string): boolean {
  if (git(cwd, ['status', '--porcelain', ...NOT_OUR_OWN_LEAVINGS]).out.trim().length > 0) return true;
  if (!base) return false;
  return !git(cwd, ['diff', '--quiet', base, 'HEAD']).ok;
}

/** worktreeHasChanges 의 **리스트** 버전 — 미커밋(status --porcelain·untracked 포함) ∪ 커밋된 diff
 *  (fork 지점 대비 --name-only). ⚠️ dogfood 2026-07-20 버그A(harness): execute seam 이 changes 를
 *  하드코딩 `[]` 로 반환해 Reviewer 가 빈 changeset 을 검토(리뷰 무의미)·"deployed" 공수표였다.
 *  하니스가 실 변경 목록을 받도록 이 헬퍼로 산출한다(자식이 untracked 로 남긴 신규파일도 포함). */
export function changedFiles(cwd: string): string[] {
  const files = new Set<string>();
  // ① 미커밋 + untracked — porcelain 라인 'XY <path>'(rename 은 'orig -> new').
  //   물질화·비코드 산출물(.elanous-test, .elanous-skill-artifacts)은 제외 — 리뷰어·게이트가 자식 변경으로 오인하면 안 된다.
  for (const line of git(cwd, ['status', '--porcelain', ...NOT_OUR_OWN_LEAVINGS]).out.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const path = s.slice(2).trim().split(' -> ').pop();
    if (path) files.add(path);
  }
  // ② 커밋된 변경 — fork 지점(merge-base) 대비 diff.
  const base = defaultBranchRef(cwd);
  if (base) {
    const fork = git(cwd, ['merge-base', 'HEAD', base]).out.trim().split('\n')[0] ?? '';
    if (fork) {
      for (const line of git(cwd, ['diff', '--name-only', fork, 'HEAD']).out.split('\n')) {
        const s = line.trim();
        if (s) files.add(s);
      }
    }
  }
  return [...files];
}

/** fork 지점 이후 커밋 제목 원문. 조회 실패면 빈 목록으로 fail-soft 한다. */
export function commitTitles(cwd: string): string[] {
  const base = defaultBranchRef(cwd);
  if (!base) return [];
  const mergeBase = git(cwd, ['merge-base', 'HEAD', base]);
  const fork = mergeBase.ok ? mergeBase.out.trim().split('\n')[0] ?? '' : '';
  if (!fork) return [];
  const log = git(cwd, ['log', '--format=%s', `${fork}..HEAD`]);
  return log.ok
    ? log.out.split('\n').map((title) => title.trim()).filter(Boolean)
    : [];
}

/** worktree 의 미커밋 변경 diff(untracked 포함) — 하니스 Review critique(PR 개설 前)·품질 리뷰용.
 *  intent-to-add(`git add -N`)로 untracked 신규파일을 diff 에 포함시킨다(작업트리 내용 무변경·이후
 *  commitWorktree 정상). diff 없으면 ''(빈 changeset). */
export async function worktreeDiff(cwd: string): Promise<string> {
  await gitAsync(cwd, ['add', '-N', '.']);   // untracked → intent-to-add(내용 스테이지 X·diff 노출용)
  return (await gitAsync(cwd, ['diff', '--no-color'])).out;
}

/** ★ JDG-T2 수리(2026-07-31) — **리뷰어에게 주는 것은 "PR diff" 다**(워크트리 diff 가 아니다).
 *
 *  평시엔 둘이 같다: `commitWork` 는 rework 루프 **뒤**에 있으므로 한 런의 산출은 리뷰 시점까지 미커밋으로
 *  누적된다. ⛔ 그러나 런이 죽으면 `preserveBlockedArtifacts` 가 **커밋해서** 브랜치를 보존하고, §6b
 *  **인수 발사**(`--base <그 브랜치>`)는 그 커밋 위에서 시작한다 ⇒ `git diff`(미커밋분)에는 인수하려던
 *  산출이 **통째로 빠진다.** 실측 `run-e252c392`/`#6138`: 1차 산출(`bf8c2ff0a` · wiring ⊕ 테스트 5건)이
 *  안 보여 리뷰가 *"핵심 wiring 이 없다"* 를 **정당하게** 판정했고 런이 `UNCONVERGEABLE` 로 죽었다.
 *
 *  ⇒ merge-base 기준으로 잡아 **커밋분 ⊕ 미커밋분을 한 diff 로** 준다(`git diff <merge-base>` 는 인덱스가
 *  아니라 작업트리를 비교하므로 둘이 자연히 합쳐진다 — 두 diff 를 이어 붙이면 같은 파일이 두 번 나와
 *  `splitDiffByFile` 예산 분할이 어긋난다).
 *
 *  ⚠️ 기준은 `opts.base` 가 **아니라** PR 이 향하는 곳이다 — 인수 발사에서는 `opts.base` 가 작업 브랜치
 *  자신이라 merge-base 가 HEAD 가 되어 **결함이 그대로 재현**된다. 스택 PR 에서는 부모 브랜치 변경까지
 *  보이지만(과다), 그것은 **리뷰가 못 보는 것보다 안전한 방향**이고 스코프 경계는 intent 블록이 나른다.
   *  ⛔ 요청한 `prBase`(기본 `origin/main`)의 merge-base 를 못 구하면 미커밋 diff 로 접지 않는다.
   *  `defaultBranchRef`(origin 다음 main/master — `worktreeHasChanges`/`changedFiles` 와 같은 해석기)로
   *  한 번 더 구한다. 그래도 못 구하면 빈 문자열이 아니라 `REVIEW_SCOPE_UNMEASURABLE` 을 돌려
   *  «변경 없음»과 구분한다. full diff 명령 자체 실패는 종전처럼 미커밋 diff 로 폴백한다. */
export const REVIEW_SCOPE_UNMEASURABLE = 'REVIEW_SCOPE_UNMEASURABLE';

export async function reviewScopeDiff(cwd: string, prBase = 'origin/main', runId?: string, baseOrigin: 'resolved-base' | 'default-origin-main' = 'default-origin-main'): Promise<string> {
  await gitAsync(cwd, ['add', '-N', '.']);
  // ⚠️ 이것은 `worktreeDiff` 와 **같은 명령**이어야 한다 — full diff 실패 폴백 시 그대로 반환하므로 종전 동작의 정본이다.
  //    ⇒ `git diff`(인덱스 대비)라 **staged 변경은 빠진다**. 이 경로에는 그런 상태가 없다(자식은 파일만
  //    남기고 `commitWorktree` 는 `add -A` 후 커밋한다) — 스테이징하는 호출자가 생기면 `uncommittedChars`
  //    의 이름과 측정 범위를 다시 본다(리뷰 3R should-fix).
  const uncommitted = (await gitAsync(cwd, ['diff', '--no-color'])).out;
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).out.trim() !== 'true') return uncommitted;
  const measured = await measureReviewScope(cwd, prBase);
  let ref = measured.ref;
  let usedBase = prBase;
  let scopeBase: 'origin/main' | 'local-default' = 'local-default';
  if (ref && prBase === 'origin/main') scopeBase = 'origin/main';
  if (!ref) {
    const localBase = defaultBranchRef(cwd);
    if (localBase && localBase !== prBase) {
      const retried = await measureReviewScope(cwd, localBase);
      if (retried.ref) {
        ref = retried.ref;
        usedBase = localBase;
        scopeBase = 'local-default';
      }
    }
  }
  // ⚠️ 상한은 40 이 아니라 64 — SHA-256 저장소의 정상 OID 는 64자다. 40 으로 잡으면 그런 저장소에서
  //    **정상 merge-base 를 실패로 오인해 조용히 종전(결함) 동작으로 폴백**한다.
  if (!ref) {
    // ⛔ 기준을 못 구해도 «볼 변경»(미커밋분)이 있으면 그것을 리뷰한다 — 🩸 2026-09-23(#20027 직후):
    //   커밋 없는 저장소의 미커밋 변경까지 «못 쟀다»로 접어 리뷰가 통째로 빠졌다(orchestrator.test.ts 회귀).
    //   ⇒ «못 쟀다»는 기준도 없고 미커밋분도 «비었을» 때만이다 — 그때 빈 diff 를 「변경 없음·pass」로 읽으면 안 된다.
    const unmeasurable = !uncommitted.trim();
    debug.log('self-implement', 'review.diff-scope', {
      scope: 'worktree', reason: 'no-merge-base', prBase, baseOrigin, scopeBase: unmeasurable ? 'unmeasurable' : 'uncommitted-only',
      chars: uncommitted.length, ...(runId ? { runId } : {}),
    }, { level: 'warn' });
    return unmeasurable ? REVIEW_SCOPE_UNMEASURABLE : uncommitted;
  }
  const full = await gitAsync(cwd, ['diff', '--no-color', ref]);
  if (!full.ok) {
    debug.log('self-implement', 'review.diff-scope', { scope: 'worktree', reason: 'diff-failed', prBase, baseOrigin, scopeBase, chars: uncommitted.length, ...(runId ? { runId } : {}) }, { level: 'warn' });
    return uncommitted;
  }
  // ⭐ committedChars = **종전 구현이 리뷰어에게 숨기고 있던 양**(JDG-T2 재발 감시).
  // ⛔ 뺄셈(full − uncommitted)으로 구하지 않는다 — 같은 파일이 커밋·미커밋 양쪽에서 바뀌면 둘이
  //    **한 patch 로 합쳐져** 헤더가 한 번만 나오므로 차이가 커밋분 크기가 아니다(관측이 거짓이 된다).
  //    실제로 커밋분 diff 를 따로 잰다(git diff <merge-base> HEAD · 작업트리 미포함).
  const committedOnly = await gitAsync(cwd, ['diff', '--no-color', ref, 'HEAD']);
  debug.log('self-implement', 'review.diff-scope', {
    scope: 'pr', prBase: usedBase, baseOrigin, scopeBase, chars: full.out.length, uncommittedChars: uncommitted.length,
    ...(committedOnly.ok ? { committedChars: committedOnly.out.length } : { committedChars: null }),
    ...(runId ? { runId } : {}),
  });
  return full.out;
}

async function measureReviewScope(cwd: string, base: string): Promise<{ ref: string }> {
  const mergeBase = await gitAsync(cwd, ['merge-base', base, 'HEAD']);
  const ref = mergeBase.ok ? mergeBase.out.trim() : '';
  return { ref: /^[0-9a-f]{7,64}$/.test(ref) ? ref : '' };
}

/** 스테이징된 «새 파일» 중 elanous 런타임 산출물만 다시 내린다(사후 조건 — 경합 없음). */
export function unstageElanousRuntimeArtifacts(cwd: string): string[] {
  const staged = git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z']).out
    .split('\0')
    .filter((path) => path.length > 0)
    .filter(isElanousRuntimeArtifactPath);
  if (staged.length > 0) git(cwd, ['reset', '-q', '--', ...staged]);
  return staged;
}

/** worktree 변경을 브랜치에 커밋(add -A + commit). 커밋/PR 은 하니스 Deployer 가 소유(#4815 버그B) —
 *  자식(goal-loop)은 파일만 남기므로, 이 커밋이 브랜치를 실제로 '준비'시킨다. PR-open(원격 push)은
 *  별개의 HITL 게이트. 'nothing to commit' 은 무해(경고만). */
export function commitWorktree(cwd: string, message: string): { ok: boolean; out: string } {
  const untrackedRuntimeArtifacts = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).out
    .split('\0')
    .filter(Boolean)
    .filter(isElanousRuntimeArtifactPath)
    .filter((path) => !git(cwd, ['check-ignore', '-q', path]).ok);
  const exclude = untrackedRuntimeArtifacts.map((path) => `:(exclude,literal)${path}`);
  git(cwd, ['add', '-A', '--', ...exclude]);
  // ⛔ 위 목록은 «스냅샷»이라 경합에 진다 — `.elanous-child-liveness.hb` 는 ***5초마다*** 쓰이므로
  //    `ls-files` 와 `add -A` «사이»에 생기면 그대로 담힌다.
  //    📏 2026-09-21: 그래서 #19300·#19302 를 넣고도 빈 저장소 PR 에 또 들어갔다.
  //    ⇒ 사전 제외가 아니라 ***사후 조건***으로 막는다 — 경합이 구조적으로 없어진다.
  //    ⭐ `--diff-filter=A` 라 «새로 들어온 것»만 문다 — 이미 추적 중이던 경로는 그대로 남는다.
  unstageElanousRuntimeArtifacts(cwd);
  const commit = git(cwd, ['commit', '-m', message]);
  if (!commit.ok && !/nothing to commit/.test(commit.out)) {
    debug.log('self-implement', 'commit.warn', { out: commit.out.slice(0, 300) }, { level: 'warn' });
  }
  return commit;
}

/** worktree 의 변경 파일 목록(tracked HEAD diff + untracked·exclude-standard). gate 와 `elanous self typecheck`
 *  CLI 가 공유 — 모델의 자가 타입검사가 gate 와 **동일 파일집합**을 보게(B2 선제↔A 게이트 수렴 보장). */
export function gitChangedFiles(cwd: string): string[] {
  const tracked = git(cwd, ['diff', '--name-only', 'HEAD']).out;
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).out;
  return `${tracked}\n${untracked}`.split('\n').map((s) => s.trim()).filter(Boolean);
}

type ChangedFileTypecheckRunner = (cmd: string, args: string[]) => TypecheckExecutionResult;

/** ★ #2 변경파일 스코프 tsc 게이트(2026-07-21) — 스코프 bun test 가 놓칠 수 있는 tsc-깨짐(F1: 변경 소스에
 *  대응 테스트가 안 바뀌면 그 파일이 컴파일 안 됨·"0 tests" 거짓 green)을 결정론 차단한다. `bunx tsc --noEmit`
 *  을 돌려 **변경 파일 경로**의 에러만 센다(레포 baseline 에러는 무시=false-positive 방지). 변경 .ts 없으면 skip. */
export function changedFileTypecheck(
  cwd: string,
  changedTsFiles: readonly string[],
  run: ChangedFileTypecheckRunner = Object.assign((cmd: string, args: string[]) => {
    const startedAt = Date.now();
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, env: tscEnv() });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status, signal: r.signal, error: r.error, durationMs: Date.now() - startedAt };
  }),
  gateConfig: ResolvedTypecheckConfig | MissingTypecheckGateConfig | null = resolveTypecheckConfig(cwd),
): { passed: boolean; executed: boolean; checked: number; errors: number; exempted: number; noInspectionReason: TypecheckNoInspectionReason | null; log: string } {
  const norm = (f: string): string => f.replace(/^\.\//, '').trim();
  const changed = new Set(changedTsFiles.map(norm).filter((f) => /\.[cm]?tsx?$/.test(f) && !/\.d\.ts$/.test(f)));
  if (changed.size === 0) {
    const noInspectionReason = 'no-typecheckable-changed-files' as const;
    try {
      debug.log('typecheck.gate', 'ratchet', {
        changedFiles: [], checked: 0, passed: true, errors: 0, exempted: 0,
        executed: false, noInspectionReason,
      });
    } catch { /* observation must not change the gate result */ }
    return { passed: true, executed: false, checked: 0, errors: 0, exempted: 0, noInspectionReason, log: '' };
  }
  if (gateConfig === null) {
    const noInspectionReason = 'no-typescript-config' as const;
    debug.log('typecheck.gate', 'ratchet', {
      changedFiles: [...changed], checked: changed.size, passed: true, errors: 0, exempted: 0,
      executed: false, noInspectionReason,
    });
    return { passed: true, executed: false, checked: changed.size, errors: 0, exempted: 0, noInspectionReason, log: '' };
  }
  let selectedConfig: string;
  try {
    readFileSync(gateConfig.path, 'utf8');
    selectedConfig = gateConfig.config;
  } catch {
    const noInspectionReason = 'missing-typecheck-gate-config' as const;
    const log = `[tsc: 변경 파일 타입 검사 설정 없음 (${gateConfig.config} at ${gateConfig.path}) — 이 작업 트리에는 이 저장소의 게이트 설정이 없으므로 컴파일러를 실행하지 않았다.]`;
    debug.log('typecheck.gate', 'ratchet', {
      changedFiles: [...changed], checked: changed.size, passed: false, errors: 0, exempted: 0,
      executed: false, noInspectionReason, missingConfig: gateConfig.config,
    }, { level: 'warn' });
    return { passed: false, executed: false, checked: changed.size, errors: 0, exempted: 0, noInspectionReason, log };
  }
  // `assessTypecheckExecution` is shared with scripts/ci-typecheck-changed.ts so both callers fail closed on an unmeasured run.
  // Each changed source is owned by the most-specific configured project that can compile it.
  // PWA owns `apps/pwa/**`; the root compiler still runs for its execution health, but its
  // diagnostics cannot be attributed to PWA files it does not configure.
  const pwaChanged = new Set([...changed].filter((file) => file.startsWith('apps/pwa/')));
  const rootChanged = new Set([...changed].filter((file) => !pwaChanged.has(file)));
  const promotedRootConsumers = new Set<string>();
  const promotedPwaConsumers = new Set<string>();
  const requiredExportFieldPromotions: Array<{ file: string; typeName: string; fieldName: string }> = [];
  const removedExportedSymbolPromotions: Array<{ file: string; name: string }> = [];
  const addedFunctionParameterPromotions: Array<{ file: string; name: string; from: number; to: number }> = [];
  for (const file of changed) {
    const baseFile = git(cwd, ['show', `HEAD:${file}`]);
    if (!baseFile.ok) continue;
    try {
      const headSource = readFileSync(join(cwd, file), 'utf8');
      requiredExportFieldPromotions.push(...requiredExportFieldsAdded(baseFile.stdout, headSource, file).map((addition) => ({ file, ...addition })));
      removedExportedSymbolPromotions.push(...removedExportedSymbols(baseFile.stdout, headSource, file).map((symbol) => ({ file, ...symbol })));
      addedFunctionParameterPromotions.push(...addedExportedFunctionParameters(baseFile.stdout, headSource, file).map((increase) => ({ file, ...increase })));
    } catch { /* export promotion detection must not change the gate result */ }
  }
  const promotionTriggers = [
    ...(requiredExportFieldPromotions.length > 0 ? ['required-export-field'] : []),
    ...(removedExportedSymbolPromotions.length > 0 ? ['removed-exported-symbol'] : []),
    ...(addedFunctionParameterPromotions.length > 0 ? ['added-function-parameter'] : []),
  ];
  const rootPromotions = [...requiredExportFieldPromotions, ...removedExportedSymbolPromotions, ...addedFunctionParameterPromotions]
    .filter((promotion) => !promotion.file.startsWith('apps/pwa/'));
  const pwaPromotions = [...requiredExportFieldPromotions, ...removedExportedSymbolPromotions, ...addedFunctionParameterPromotions]
    .filter((promotion) => promotion.file.startsWith('apps/pwa/'));
  const execution = assessTypecheckExecution(run('bunx', ['tsc', '--noEmit', '-p', selectedConfig]));
  const pwaExecution = pwaChanged.size > 0 || rootPromotions.length > 0
    ? assessTypecheckExecution(run('bunx', ['tsc', '--noEmit', '-p', 'apps/pwa/tsconfig.json']))
    : undefined;
  if (rootPromotions.length > 0) {
    for (const diagnostic of execution.diagnostics) {
      if (!changed.has(diagnostic.file) && !diagnostic.file.startsWith('apps/pwa/')) promotedRootConsumers.add(diagnostic.file);
    }
    if (pwaExecution) {
      for (const diagnostic of pwaExecution.diagnostics) {
        if (!changed.has(diagnostic.file) && diagnostic.file.startsWith('apps/pwa/')) promotedPwaConsumers.add(diagnostic.file);
      }
    }
  }
  if (pwaPromotions.length > 0 && pwaExecution) {
    for (const diagnostic of pwaExecution.diagnostics) {
      if (!changed.has(diagnostic.file) && diagnostic.file.startsWith('apps/pwa/')) promotedPwaConsumers.add(diagnostic.file);
    }
  }
  const rootScope = new Set([...rootChanged, ...promotedRootConsumers]);
  const pwaScope = new Set([...pwaChanged, ...promotedPwaConsumers]);
  const baseline = readTestTypecheckBaseline(cwd);
  const result = classifyTypecheckErrors(execution.diagnostics, rootScope, baseline);
  const pwaResult = pwaExecution
    ? classifyTypecheckErrors(pwaExecution.diagnostics, pwaScope, baseline)
    : { failing: [], exempted: [], outsideChanged: [] };
  const executions = pwaExecution ? [execution, pwaExecution] : [execution];
  const failing = [...result.failing, ...pwaResult.failing];
  const exemptedErrors = [...result.exempted, ...pwaResult.exempted];
  const outsideChanged = [...result.outsideChanged, ...pwaResult.outsideChanged];
  const passed = executions.every((candidate) => candidate.executed) && failing.length === 0;
  // ⛔ baseline 전량(수백 항목)을 매 게이트마다 싣지 않는다 — 로그 부피가 크고, `elanous logs` 기본
  //    출력이 페이로드를 200자에서 자르므로 **자기 페이로드가 절단돼** 정작 failing/exempted 를
  //    못 읽게 된다(실측 2026-07-30).
  //    ⚠️ **이 자리는 `scripts/ci-typecheck-changed.ts` 와 같은 판정의 두 번째 호출부**다 —
  //       그쪽만 고치고 여기를 빼먹으면 게이트 경로에 따라 로그가 갈린다.
  const checkedFiles = new Set([...rootScope, ...pwaScope]);
  const touchedBaseline = Object.fromEntries(
    [...checkedFiles].filter((file) => baseline.has(file)).map((file) => [file, baseline.get(file)]),
  );
  debug.log('typecheck.gate', 'ratchet', {
    changedFiles: [...changed],
    executions: [
      { config: selectedConfig, checkedFiles: [...rootScope], executed: execution.executed },
      ...(pwaExecution ? [{ config: 'apps/pwa/tsconfig.json', checkedFiles: [...pwaScope], executed: pwaExecution.executed }] : []),
    ],
    promotionTriggers,
    requiredExportFieldPromotions,
    removedExportedSymbolPromotions,
    addedFunctionParameterPromotions,
    failing: failing.map((error) => error.line),
    exempted: exemptedErrors.map((error) => error.line),
    outsideChanged,
    touchedBaseline,
    baselineFileCount: baseline.size,
    baselineErrorTotal: [...baseline.values()].reduce((sum, count) => sum + count, 0),
    executed: executions.every((candidate) => candidate.executed),
    status: execution.status,
    signal: execution.signal,
    error: execution.error === undefined ? null : String((execution.error as { message?: string })?.message ?? execution.error),
    durationMs: execution.durationMs,
    pwaExecuted: pwaExecution?.executed ?? null,
    pwaStatus: pwaExecution?.status ?? null,
    pwaSignal: pwaExecution?.signal ?? null,
    pwaError: pwaExecution?.error === undefined ? null : String((pwaExecution.error as { message?: string })?.message ?? pwaExecution.error),
    pwaDurationMs: pwaExecution?.durationMs ?? null,
    noInspectionReason: null,
  }, { level: passed ? 'info' : 'warn' });
  const exempted = exemptedErrors.length;
  const executed = executions.every((candidate) => candidate.executed);
  return {
    passed, executed, checked: checkedFiles.size, errors: failing.length, exempted, noInspectionReason: null,
    log: [
      ...executions.map((candidate) => candidate.failureLog),
      exempted > 0 ? `[tsc: 기존 test 타입 부채 ${exempted}건 baseline 면제 — 부채를 고치면 목록 재생성으로 제거하라]` : '',
      executed && failing.length > 0 ? `[tsc: 변경 파일 컴파일 에러 ${failing.length}건 — 참조 심볼/필드 미정의 등, 통과까지 고쳐라]\n${failing.slice(0, 20).map((error) => error.line).join('\n')}` : '',
    ].filter(Boolean).join('\n'),
  };
}

/** 헤드리스 elanous 가 이 feature 를 구현하도록 주입하는 프롬프트. goal-loop 계약 + 검증된 클린-빌드
 *  앵커(측정→운영·[[REPORT-gemma-goalloop-lever-2026-07-20]])를 명시. 앵커가 gemma 를 99 로 끌어올렸고
 *  강한 모델엔 무해 — self-run 어느 provider 든 동일 규율. */
export function buildPrBody(cwd: string, body: string): string {
  const templatePath = join(cwd, '.github', 'pull_request_template.md');
  if (!existsSync(templatePath)) return body;
  const template = readFileSync(templatePath, 'utf8').trim();
  return template ? `${template}\n\n${body}` : body;
}

export function featurePrompt(feature: string, cwd?: string, reviewerContext?: readonly ReviewerContextItem[]): string {
  const worktreeNotice = cwd?.trim()
    ? `작업 디렉토리는 \`${cwd}\`다. 이 트리 안에서만 편집하고, 경로가 필요하면 추측하지 말고 이 경로를 기준으로 삼아라.`
    : '';
  const context = reviewerContext?.length ? budgetReviewerContext(reviewerContext) : undefined;
  const referenceFacts = context ? ['## 참고 사실', context.text, ''] : [];
  const planStepsInstruction = /^## STEPS\s*$/m.test(feature)
    ? [
      '[계획 진행] 골 문서에 스텝 목록이 있으니 작업을 시작할 때 Plan 도구로 그 목록을 그대로 선언하라.',
      '각 스텝의 실제 작업이 끝날 때마다 그 스텝의 0 기준 인덱스로 MarkStepDone을 불러라. 끝나기 전에 미리 부르지 마라.',
      '스텝을 새로 지어내지 말고 골 문서의 목록을 그대로 써라.',
      '',
    ]
    : [];
  return [
    feature.trim(),
    '',
    '[self-implement] 이 작업을 끝까지 구현하라. 필요한 파일을 편집하고 테스트도 추가/수정하라.',
    worktreeNotice,
    '',
    ...referenceFacts,
    ...planStepsInstruction,
    CLEAN_BUILD_ANCHOR,
    '- 완료를 선언하기 전에 **네가 바꾼/추가한 테스트 파일 경로만** 지정해 `bun test <파일>`(또는 `run_tests` 툴)로 통과를 확인하라(실패하면 통과까지 고쳐라). ⚠️ **경로 없는 전체 `bun test` 스위트는 돌리지 마라** — 통합/네트워크 테스트를 포함해 격리 worktree 에서 매우 느려 시간초과로 미완 처리된다(게이트도 변경 파일만 스코프하니 전체 불요·self typecheck 스코프와 대칭).',
    // ★ #2 tsc 수렴(2026-07-21) — F1 dogfood: refFacts 를 소비만 하고 정의 안 한 tsc-깨진 코드가 gate 까지
    //   갔다. + 잘못된 경로 `bun test` 의 "Ran 0 tests"(=0 fail)를 거짓 통과로 오인. 이를 명시 차단.
    // ⛔⛔ #3 상한 미달로 완주가 죽었다(2026-07-30 실측): 자식이 이 명령에 `timeoutMs: 120000` 을 골랐고
    //   실제 소요는 **146,518ms** 였다 ⇒ **27초 부족**. 검증은 **통과했는데**(출력에 `✅ … 통과`)
    //   그 타임아웃이 `stage=aborted` 로 런 전체를 버렸다. ⇒ 걸리는 시간을 **안내문에 수로** 적는다.
    //   ⚠️ 바로 위 `bun test` 줄은 같은 실패 모드를 이미 경고하는데 **여기엔 대칭이 없었다.**
    '- 완료 前 타입 검사(중요): `bun bin/elanous.mjs self typecheck` 를 돌려라 — **네가 바꾼 파일의 타입에러만** 보여준다(레포 baseline 노이즈 0·gate 와 동일 로직). **0건이 될 때까지 고쳐라.** 참조한 심볼/필드는 정의·선언까지 완성하라(소비만 하고 미정의 금지). (이 명령이 없는 레포면 프로젝트 타입체크로.) ⛔ **이 명령은 이 레포에서 약 150초 걸린다**(실측 146,518ms · 변경 5파일) — 셸 툴로 부를 때 **`timeoutMs` 를 240000 이상** 주어라. 기본값이나 120000 으로는 **검증이 통과해도 시간초과로 런이 버려진다**(실측 2026-07-30).',
    '- ⚠️ `bun test` 가 "Ran 0 tests" 또는 "0 pass 0 fail" 이면 **통과가 아니다** — 파일 경로가 틀린 것이니 올바른 테스트 경로로 다시 실행해 실제 테스트가 돌게 하라.',
    // ⛔⛔ #4 가드가 막는데 나아갈 길이 없었다(실측 2026-07-30): 깊은 위임 **2/2** 가 여기서 죽었다.
    //   자식이 `elanous <cmd>` 를 중첩으로 띄우면 `instance-root-coherence.ts:107` 이 stderr 로
    //   *"prod 인스턴스를 nested 인터랙티브로 띄웠습니다 … 격리하려면 `--test` 를 붙이세요"* 를 내고,
    //   자식은 **어떻게 하라는 것인지 몰라 3~4번의 툴 호출 뒤 조용히 죽었다**(`soft-timeout`).
    //   ⇒ 가드는 옳다(prod 스토어 보호). **없던 것은 "이렇게 하라" 다.** `#6014`(타임아웃 안내문)와 같은 계열.
    '- ⛔ **elanous 명령을 중첩으로 띄울 때는 반드시 `--test` 를 붙여라** — `bun bin/elanous.mjs --test <cmd>`. 안 붙이면 `[instance] ⚠️ prod 인스턴스를 nested 인터랙티브로 띄웠습니다` 가드가 걸려 **운영 스토어 오염을 막느라 네 런이 멈춘다**(실측: 그 상태로 조용히 죽은 런 2건). `--test` 는 config-dir·state-dir 두 축을 cwd 트리의 `.elanous-test` 로 자동 격리한다. ⚠️ 관측을 조회할 때도 같다 — 격리 로그는 `bun bin/elanous.mjs --test logs …` 로 봐야 보인다.',
    // ⚠️ 버그B(dogfood 2026-07-20): 위 목표에 "PR 올려라·하니스 실행" 같은 지시가 있어도 무시하라.
    // 너의 역할은 **파일 구현+테스트만**이다. git commit·push·PR·브랜치 조작을 하지 마라 —
    // 커밋/리뷰/PR 은 상위 하니스(Deployer)가 승인 게이트(HITL)를 거쳐 처리한다. 워킹트리에 변경만 남겨라.
    '',
    '⚠️ 범위 제한: 파일 구현+테스트만. git commit/push/PR/브랜치 조작 금지 — 커밋·PR 은 상위 하니스가 승인 게이트로 처리한다. 워킹트리에 변경만 남기고 GOAL-COMPLETE.',
    // ⭐ S3(2026-07-29) — 리뷰어의 증거 채널이 워크트리 diff 하나라, diff 에 안 남는 확인은
    //   증명할 길이 없어 같은 지적이 반복되고 런이 수렴 불가로 죽는다(실측 2건).
    //   ⛔ 위 범위 제한과 충돌하지 않게 **보고만** 부른다 — 행위를 부르면 자식이 멈춘다.
    OFF_DIFF_EVIDENCE_PROMPT,
    // ★ I-24 — 골이 **이름으로** 요구한 증거를 자식에게 그대로 넘긴다. RUN-T6 은 자식이 증거를
    //   안 써서가 아니라 **골이 요구한 것에 대해 안 써서** 죽었다.
    ...renderRequiredEvidencePrompt(requiredEvidenceFromGoal(feature)),
    '',
    '완료되면(모든 요구사항이 증거로 충족) 마지막 줄에 GOAL-COMPLETE 를 단독으로 써라.',
  ].join('\n');
}

const PTY_DEGRADED_CAPABILITIES = ['live-progress', 'registry', 'non-blocking-parent', 'pty-identity'] as const;
type PtyDegradedReason = 'unavailable' | 'cap' | 'error';

/**
 * 자식이 **부팅 단계에서** 죽었을 때 그 이유를 자식 전사에서 뽑는다.
 *
 * ⛔ **왜 필요한가**(실측 2026-07-30): 새 워크트리에서 자식 우주가 물질화되지 않으면 자식은
 *    온보딩 거부로 13초에 죽는데, 파이프라인 층에는 `stage=aborted` · `screen-only` 만 남는다.
 *    S 가 그 표면만 보고 **세 번 헛짚었다**(골 결함 · base 해석 · 프롬프트 argv 파싱 — 셋 다 틀렸다).
 *    원인은 처음부터 자식 화면에 있었다(`elanous self screen`).
 *
 * ⚠️ **exit code 를 조건으로 쓰지 않는다**(리뷰 must-fix): 진단을 남기고 **정상 코드로 종료**하는
 *    자식이 있으면 그 사유가 다시 뭉개진다. 판정은 **진단 신호의 존재**로 한다.
 */
/** 자식이 던진 **거부 메시지 원문**. 이 문구는 `onboarding.ts` 가 throw 하는 것이라 변별적이다. */
const ONBOARDING_REFUSAL_RE = /온보딩 마법사는 자율 컨텍스트/;
/** 러너/노드가 낸 오류 줄만. ⛔ 본문 아무 데나 낱말이 있는 것으로는 진단이 아니다. */
const ERROR_LINE_RE = /^error:\s/i;
/** ⚠️ 휴리스틱 — 거부 메시지 없이 위저드 배너만 보이는 경우. 진단보다 약하다. */
const BOOT_WIZARD_MARKER_RE = /No config yet/;

/** **확정 진단**(자식이 실제로 거부를 던졌다)만 뽑는다. 없으면 `undefined`. */
function explicitBootDiagnostic(lines: readonly string[]): string | undefined {
  // ⛔ `provisionDerivedUniverse` 라는 **낱말만** 있는 평범한 문장은 진단이 아니다(리뷰 must-fix).
  //    거부 원문이거나, **오류 줄 머리**에서 그 낱말이 나올 때만 진단으로 본다.
  return lines.find((line) => ONBOARDING_REFUSAL_RE.test(line)
    || (ERROR_LINE_RE.test(line) && /provisionDerivedUniverse/.test(line)));
}

function bootFailureReason(transcript: string): string | undefined {
  const lines = transcript.split('\n').map((line) => line.trim()).filter(Boolean);
  // 가장 구체적인 것부터: 확정 진단 → 위저드 마커. ⛔ 마지막 줄로 폴백하지 않는다 —
  //   아무 줄이나 "부팅 실패 사유" 로 올리면 **모름을 특정 원인으로 뭉개는 것**이다.
  return (explicitBootDiagnostic(lines) ?? lines.find((line) => BOOT_WIZARD_MARKER_RE.test(line)))?.slice(0, 1000);
}

/**
 * 부팅 실패 사유를 올릴까 — ⭐ **확정 진단과 휴리스틱을 가른다**(리뷰 should-fix).
 *
 * ⭐ **확정 진단이 있으면 무조건 올린다** — 자식이 거부를 던졌다는 사실은 `changed`·`toolCalls` 와
 *    무관하게 참이고, 그것을 휴리스틱 뒤에 숨기면 정작 필요한 경우를 놓친다.
 * ⚠️ **위저드 마커만 있을 때는** 변경 0 · 툴콜 0 이라는 정황이 함께 서야 한다(약한 신호이므로).
 * ⛔ **exit code 는 어느 쪽에서도 조건이 아니다** — 진단을 남기고 정상 종료하는 자식이 있으면
 *    사유가 다시 뭉개진다.
 */
export function resolveBootFailureReason(transcript: string, changed: boolean, toolCalls: number): string | undefined {
  const lines = transcript.split('\n').map((line) => line.trim()).filter(Boolean);
  const explicit = explicitBootDiagnostic(lines);
  if (explicit) return explicit.slice(0, 1000);
  if (changed || toolCalls > 0) return undefined;
  return lines.find((line) => BOOT_WIZARD_MARKER_RE.test(line))?.slice(0, 1000);
}

export type SelfImplementCompletionDisposition = 'completed-without-changes';

/** 완료 마커와 실제 작업을 확인했지만 artifact가 없는 경우를 부팅 실패와 구분한다. */
export function resolveCompletionDisposition(input: {
  timedOut: boolean;
  reachedCompletion: boolean;
  toolCalls: number;
  changed: boolean;
}): SelfImplementCompletionDisposition | undefined {
  return !input.timedOut && input.reachedCompletion && input.toolCalls > 0 && !input.changed
    ? 'completed-without-changes'
    : undefined;
}

function ptyFallbackReason(error: unknown): PtyDegradedReason {
  const message = String((error as { message?: string } | undefined)?.message ?? error);
  return /max \d+ concurrent PTY shells reached/.test(message) ? 'cap' : 'error';
}

export interface DefaultSeamsOptions {
  /** PR 생성/재사용 매니저. 테스트에서 주입하며 기본은 실제 gh/git 매니저다. */
  prManager?: PrManager;
  /** ★ 리뷰 대상 diff 조회. 기본은 실제 git 이고 **테스트 주입용**이다 — 이게 없으면 프로덕션
   *  `reviewDiff` 어댑터를 git 없이 통과시킬 수 없어 **매핑 누락을 회귀로 못 잡는다**
   *  (원장 `JDG-S4`·`JDG-S5` · 무인 리뷰 4R 이 요구). */
  reviewScopeDiff?: typeof reviewScopeDiff;
  /** 자식 elanous 격리 config/state(goal-loop·codexInspectExempt 아밍 config 위치). */
  configDir?: string;
  stateDir?: string;
  /** ⭐ 위 `stateDir` 이 «파생»이면 자식에게 그 사실을 «값으로» 준다(`OBS-T121`). */
  stateDirSource?: 'derived';
  /** ③ 구현 최대 대기(초). */
  implementMaxWaitSec?: number;
  /** soft 초과 후 무출력 허용 구간(초). 미지정이면 driver 기본값을 사용한다. */
  implementActivityGraceSec?: number;
  /** ★ 턴 abort 신호(#21) — /cancel 시 자식 goal-loop(PTY 호스팅/spawnSync 폴백)을 즉시 종료(고아 방지). */
  signal?: AbortSignal;
  /** Parent-surface progress receiver supplied by the dev pipeline. */
  onProgress?: SelfImplementSeams['onProgress'];
  /** ⑤ HITL — PR 승인 게이트. ★fail-closed: 생략 시 PR 안 열림(자동 승인 없음). 실전 필수. */
  approvePr?: SelfImplementSeams['approvePr'];
  /** gate 스텝(기본 ['test']). */
  gateSteps?: GateStepName[];
  /** 무결성 게이트 실행 seam. 테스트에서 gate 옵션을 관찰하며 기본은 실제 게이트다. */
  // ⚠️ 유니온 유지(리뷰 should-fix) — 동기 seam 구현을 깨지 않는다. 소비부는 `await` 라 양쪽 동작 동일.
  //    선례: `harness/review-adapter.ts` 의 `runGate: (cwd) => GateLike | Promise<GateLike>`.
  runIntegrityGate?: (cwd: string, opts: { steps?: GateStepName[]; testArgs?: string[] }) => GateResult | Promise<GateResult>;
  /** Existing platform gate runners; injected only by focused seam tests. */
  runAndroidUnitTestGate?: (io: { args: readonly string[]; cwd: string }) => number;
  runIosUnitTestGate?: (io: { args: readonly string[]; cwd: string }) => number;
  /** 워크트리 시험 묶음(없으면 실패 파일)을 base에서 재실행하는 seam. 실패 경로에서만 호출된다. */
  runGateBaseline?: (cwd: string, failedFiles: readonly string[], baseRef?: string) => BaselineProcessResult;
  /** Timeout failure별로 검증된 단일-test 재실행 관측을 수집하는 seam. */
  rerunBunTimeoutFailures?: (
    cwd: string,
    failures: Parameters<typeof rerunBunTimeoutFailures>[1],
    timeout?: number,
    baselineLog?: string,
    missingAtBase?: readonly string[],
  ) => ReturnType<typeof rerunBunTimeoutFailures> | Map<string, Array<'pass' | 'timeout' | 'failure'>>;
  /** 통과한 자식 테스트를 base 코드에 얹어 음성 대조하는 seam. */
  runVerifyByBreaking?: typeof runVerifyByBreaking;
  /** 기존 대조가 정보를 못 낸 편집 테스트를 base 판으로 현재 소스에서 재실행하는 seam. */
  runReverseVerifyByBreaking?: typeof runReverseVerifyByBreaking;
  /** P1(dev-harness) — worktree 를 뜰 **대상 repo 루트**. 생략 시 데몬 cwd 의 repo(=elanous 자신).
   *  elanous 자신 개발이면 생략, 외부 repo 개발이면 그 repo 루트. */
  repoRoot?: string;
  /** P2(#25) — 타겟 종류(resolveTargetKind). 'non-git-dir' 이면 createWorktree 대신 그림자 스테이징
   *  (targetPath 필수) + gate 는 manifest 감지. 생략/그 외는 현행(elanous·외부 git). */
  targetKind?: TargetKind;
  /** P2(#25) — 비-git dir 타겟의 실제 경로(targetKind==='non-git-dir' 일 때 그림자로 감쌀 원본). */
  targetPath?: string;
  /** P3(dev-harness) — elanous 코딩에이전트 바이너리(`bin/elanous.mjs`) 위치. 생략 시 worktree repo 에서
   *  찾음(elanous 자신 개발엔 정상). **외부 repo 개발** 시엔 elanous repo 루트를 줘야 외부 worktree 에도
   *  elanous 에이전트가 붙는다(외부 repo 엔 elanous 바이너리 없음). */
  elanousBinRoot?: string;
  /** ★ 내부 리뷰어 seam(2026-07-21·review-gated merge) — 주입 시 reviewDiff(worktree diff → reviewPullRequest·
   *  agent-substrate·staged 하니스와 동일 엔진) 배선. 미주입 시 reviewDiff 미노출(gate 통과=바로 병합결정·
   *  리뷰 스킵). dev-harness 의 llmReview 와 동일 형태(streamLLM 래퍼). */
  llmReview?: (prompt: string) => Promise<string>;
  /**
   * 이 리뷰 심이 파일을 스스로 읽을 수 있나. **선택 선언** — 안 주면 reviewDiff 가 칸을 만들지 않고
   * 오케스트레이터 관측은 `'unknown'` 이다(`false` 와 같은 값으로 접지 않는다).
   * ⛔ llmReview 시그니처는 그대로(prompt-in/text-out · 도구 채널 없음).
   */
  reviewerCanSelfRead?: boolean;
  /** CLI가 적재한 리뷰어 컨텍스트. 비어 있으면 기존 ReviewInput 형태를 유지한다. */
  reviewerContext?: ReviewerContextItem[];
  /** 기존 LLM HITL relay builder의 테스트 seam. 생성 실패 시 기본 dispatch를 그대로 유지한다. */
  buildLlmHitlRelay?: typeof buildLlmHitlRelay;
  /** 테스트용 PTY executor 주입. */
  runHeadlessGoalLoopPty?: typeof runHeadlessGoalLoopPty;
  /** 테스트용 PTY 가용성 주입. */
  ptyAvailable?: () => boolean;
  /** Tests may inject the shared provenance writer to exercise the self-implement failure contract. */
  recordWorktreeProvenance?: typeof recordHarnessWorktreeProvenance;
  /** Tests may inject the optional goal-metadata writer independently from strict provenance. */
  recordWorktreeGoalMetadata?: typeof recordHarnessWorktreeGoalMetadata;
  /** Test seam for the low-cost role-resolved one-sentence goal summary. */
  summarizeGoal?: (prompt: string, model: { provider: string; model: string }, signal: AbortSignal) => Promise<string>;
  /** Bounded wait for optional goal summarization; expiry falls back to the title. */
  goalSummaryTimeoutMs?: number;
  /** 테스트용 spawnSync 주입. */
  spawnSync?: typeof spawnSync;
  /** Post-merge cleanup adapters are injectable to prove external-worktree root wiring. */
  resolveMainRepoRoot?: typeof resolveMainRepoRoot;
  removeWorktree?: typeof removeWorktree;
  runGitCommand?: typeof runGitCommand;
}

/** Remove only an identical, untracked launch-tree goal copy after refreshing the merged remote branch. */
export function removeMatchingGoalCopy(repoRoot: string, goalFile: string, remoteBranch: string): { outcome: 'removed' | 'kept'; reason: string } {
  const kept = (reason: string) => ({ outcome: 'kept' as const, reason });
  let path: string;
  let root: string;
  try {
    root = realpathSync(repoRoot);
    path = realpathSync(resolve(goalFile));
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      || !/^docs\/goals\/GOAL-[^/]+\.md$/.test(rel.split(sep).join('/'))
      || !lstatSync(resolve(goalFile)).isFile()) return kept('outside-repository');
    const relativePath = rel.split(sep).join('/');
    if (!/^origin\/[A-Za-z0-9._/-]+$/.test(remoteBranch) || remoteBranch.includes('..') || remoteBranch.endsWith('/')) return kept('remote-unreadable');
    const tracked = runGitCommand(root, ['ls-files', '--cached', '-z', '--', relativePath], { encoding: 'utf8', timeout: GIT_TIMEOUT });
    if (tracked.status !== 0) return kept('tracking-unreadable');
    if (tracked.stdout.length) return kept('tracked');
    const untracked = runGitCommand(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', relativePath], { encoding: 'utf8', timeout: GIT_TIMEOUT });
    if (untracked.status !== 0) return kept('tracking-unreadable');
    if (untracked.stdout !== `${relativePath}\0`) return kept('not-untracked');
    const branchName = remoteBranch.slice('origin/'.length);
    const fetched = runGitCommand(root, ['fetch', '--no-tags', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`], { encoding: 'utf8', timeout: GIT_TIMEOUT });
    if (fetched.status !== 0) return kept('remote-unreadable');
    const remote = spawnSync('git', ['show', `${remoteBranch}:${relativePath}`], { cwd: root, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
    if (remote.status !== 0 || !Buffer.isBuffer(remote.stdout)) return kept('remote-unreadable');
    const local = readFileSync(path);
    if (local.length !== remote.stdout.length || !timingSafeEqual(local, remote.stdout)) return kept('content-differs');
    // Recheck the index and path just before unlink; inspection failure always preserves the copy.
    const stillUntracked = runGitCommand(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', relativePath], { encoding: 'utf8', timeout: GIT_TIMEOUT });
    const stillTracked = runGitCommand(root, ['ls-files', '--cached', '-z', '--', relativePath], { encoding: 'utf8', timeout: GIT_TIMEOUT });
    if (stillUntracked.status !== 0 || stillTracked.status !== 0 || stillUntracked.stdout !== `${relativePath}\0` || stillTracked.stdout.length) return kept('tracking-unreadable');
    if (realpathSync(resolve(goalFile)) !== path || !lstatSync(resolve(goalFile)).isFile()) return kept('outside-repository');
    const latest = readFileSync(path);
    if (latest.length !== remote.stdout.length || !timingSafeEqual(latest, remote.stdout)) return kept('content-differs');
    unlinkSync(resolve(goalFile));
    return { outcome: 'removed', reason: 'identical-untracked-copy' };
  } catch {
    return kept('inspection-failed');
  }
}

/** 실 함수에 연결된 seam 세트. 오케스트레이터에 주입. */
/**
 * ★ `ReviewDiffContext` → `ReviewIntentInput` 매핑. **순수**하게 뽑아 둔 이유가 있다:
 *
 * ⛔⭐⭐⭐ 이 매핑은 **필드별 명시**라 **한 줄을 안 적으면 값이 조용히 안 간다.** 실제로
 * `evidenceCoverage` 가 여기 없어서 하니스가 센 증거 충족도가 `ReviewDiffContext` 까지만 오고
 * **리뷰어 프롬프트에는 안 갔다**(원장 `JDG-S4`·`JDG-S5` · 무인 리뷰 3R 이 잡았다).
 * ⇒ 어댑터 안에 인라인으로 두면 **git·네트워크 없이 테스트할 수 없어** 그 누락을 못 잡는다.
 *
 * ⚠️ 수용기준·의도적 스코프 경계는 **골 텍스트에서** `buildReviewIntent` 가 직접 추출한다
 * (결정론·LLM 0). 그래서 여기서 따로 나르지 않는다 — 두 경로로 나르면 갈라진다.
 */
const REVIEW_DIFF_CONTEXT_KEYS = [
  'runId', 'commits', 'changedFiles', 'goal', 'goalFile', 'goalDocumentPath', 'round', 'appliedLastRound',
  'shardSiblings', 'diffOutsideClaims', 'gateEvidenceNote', 'preexistingTestFailures', 'importerTestsNotRun',
  'evidenceCoverage', 'designCheck',
] as const satisfies readonly (keyof ReviewDiffContext)[];

type UnmappedReviewDiffContextKey = Exclude<keyof ReviewDiffContext, typeof REVIEW_DIFF_CONTEXT_KEYS[number]>;
type AssertNoUnmappedReviewDiffContextKeys<T extends never> = T;
type ReviewDiffContextMappingIsExhaustive = AssertNoUnmappedReviewDiffContextKeys<UnmappedReviewDiffContextKey>;
const REVIEW_DIFF_CONTEXT_MAPPING_IS_EXHAUSTIVE: ReviewDiffContextMappingIsExhaustive = undefined as never;
void REVIEW_DIFF_CONTEXT_MAPPING_IS_EXHAUSTIVE;

function assertDeclaredReviewDiffContextKeys(ctx: ReviewDiffContext): void {
  const declared = new Set<string>(REVIEW_DIFF_CONTEXT_KEYS);
  const undeclared = Object.keys(ctx).filter((key) => !declared.has(key));
  if (undeclared.length) throw new Error(`ReviewDiffContext keys missing forwarding declaration: ${undeclared.join(', ')}`);
}

export function toReviewIntentInput(ctx?: ReviewDiffContext): ReviewIntentInput | undefined {
  if (!ctx?.goal?.trim()) return undefined;
  assertDeclaredReviewDiffContextKeys(ctx);
  return {
    goal: ctx.goal,
    ...(ctx.runId?.trim() ? { runId: ctx.runId } : {}),
    ...(ctx.commits?.length ? { commits: ctx.commits } : {}),
    ...(ctx.changedFiles?.length ? { changedFiles: ctx.changedFiles } : {}),
    ...(ctx.goalFile?.trim() ? { goalFile: ctx.goalFile } : {}),
    ...(ctx.round !== undefined ? { round: ctx.round } : {}),
    ...(ctx.appliedLastRound?.length ? { appliedLastRound: ctx.appliedLastRound } : {}),
    ...(ctx.shardSiblings?.items.length ? { shardSiblings: ctx.shardSiblings } : {}),
    ...(ctx.diffOutsideClaims?.length ? { diffOutsideClaims: ctx.diffOutsideClaims } : {}),
    ...(ctx.gateEvidenceNote?.trim() ? { gateEvidenceNote: ctx.gateEvidenceNote } : {}),
    ...(ctx.preexistingTestFailures?.length ? { preexistingTestFailures: ctx.preexistingTestFailures } : {}),
    ...(ctx.importerTestsNotRun !== undefined ? { importerTestsNotRun: ctx.importerTestsNotRun } : {}),
    ...(ctx.evidenceCoverage ? { evidenceCoverage: ctx.evidenceCoverage } : {}),
    ...(ctx.designCheck ? { designCheck: ctx.designCheck } : {}),
  };
}

/** Returns the same fork-point ref that makes committed and uncommitted changes visible to the gate. */
function gateComparisonBase(cwd: string): string | null {
  const base = defaultBranchRef(cwd);
  if (!base) return null;
  const fork = git(cwd, ['merge-base', 'HEAD', base]);
  const ref = fork.ok ? fork.out.trim().split('\n')[0] ?? '' : '';
  return /^[0-9a-f]{7,64}$/.test(ref) ? ref : null;
}

type GateComparisonBaseStatus = 'unavailable' | 'comparison-failed' | 'no-tracked-changes' | 'tracked-changes';

/** Merge-base tracked changes plus the existing untracked list, preserving gate-scope path semantics. */
export function gateChangedFiles(cwd: string, baseRef: string | null): { files: string[]; comparisonBaseStatus: GateComparisonBaseStatus } {
  const comparison = baseRef ? git(cwd, ['diff', '--name-only', baseRef]) : null;
  const trackedFiles = comparison?.ok
    ? comparison.stdout.split('\n').map((file) => file.trim()).filter(Boolean)
    : [];
  const files = [...new Set([...trackedFiles, ...gitChangedFiles(cwd)])]
    .map((file) => file.trim())
    .filter(Boolean);
  return {
    files,
    comparisonBaseStatus: !baseRef
      ? 'unavailable'
      : !comparison?.ok
        ? 'comparison-failed'
        : files.length === 0
          ? 'no-tracked-changes'
          : 'tracked-changes',
  };
}

/** Returns null when the comparison base or any base/current file cannot be read; unknown must not become zero. */
function testDeclarationDecline(cwd: string, baseRef: string | null, files: readonly string[]): number | null {
  if (!baseRef) return null;
  let decline = 0;
  for (const file of files) {
    try {
      const base = git(cwd, ['show', `${baseRef}:${file}`]);
      if (!base.ok) return null;
      const current = readFileSync(join(cwd, file), 'utf8');
      decline += Math.max(0, countTestDeclarations(base.out) - countTestDeclarations(current));
    } catch {
      return null;
    }
  }
  return decline;
}

type DefaultSeamsDiagnoseInput = Omit<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0], 'kind'> & {
  kind: SupervisionReworkSource;
};

type DefaultSeamsResult = Omit<SelfImplementSeams, 'diagnose'> & {
  diagnose: (ctx: DefaultSeamsDiagnoseInput) => Promise<string>;
  closePr: (prUrl: string, comment?: string) => boolean;
};

const GOAL_DESCRIPTION_MAX_CHARS = 250;
const DEFAULT_GOAL_SUMMARY_TIMEOUT_MS = 10_000;

const NON_GOAL_DOCUMENT_HEADINGS = new Set([
  'PROBLEM',
  'WHAT TO BUILD',
  'STEPS',
  'ACCEPTANCE CRITERIA',
  'REQUIRED EVIDENCE',
  'TRACED PATHS',
  'SCOPE BOUNDARY',
  '답하지 못하는 것',
  '수용 구별 관측',
  '불변식',
  '판정 신호',
  '실행 기록',
]);

async function withGoalSummaryTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`goal summary timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** ⛔⭐⭐⭐ 문서의 «제목»은 ***머리에 오는 H1*** 뿐이다 — 「denylist 에 안 걸리는 첫 제목」이 «아니다».
 *
 *  🪞 이 함수는 같은 자리에서 «세 번» 샜다. 종전 판은 「첫 제목 ⊕ 예외 목록」이었고,
 *  그 형태는 ***새 절이 위에 생길 때마다 조용히 틀린다*** — 예외 목록은 언제나 한 발 뒤에 있다.
 *
 *  📏 전수 실측 (2026-08-20 · `docs/goals/GOAL-*` **2,563**개):
 *  ```
 *  머리 H1 이 있는 문서            1 / 2,563 = 0.04%
 *  제목은 있지만 머리 H1 이 아니다  2,435      = 95.0%
 *  종전 판이 뽑던 값 상위          RULES 30.0% · 왜 이 골인가 5.2% · (최근 200) 발사 전 분해 권고 13%
 *  ```
 *  ⇒ 🔑 ***뽑힌 「제목」이 사실상 «전부» 절 제목이었다.*** 골 문서엔 애초에 제목 줄이 «없다».
 *
 *  🩹 그래서 이 판은 «못 뽑으면 안 뽑는다». 값이 차 있는데 무의미한 칸은 비어 있는 칸보다 나쁘다
 *  (`OBS-T164`) — 비어 있으면 사람이 「모른다」를 알지만, 차 있으면 그것을 «목적으로 믿는다».
 *  ⊕ 목적은 이미 `goalDescription`(`source: generated`)이 «제대로» 담고 있다 — 이 칸이 비어도 안 잃는다. */
export function goalTitleFromDocument(document: string): string | undefined {
  const body = document.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // ⛔ CommonMark + goal-title boundary — 앞 공백은 «0~3칸»까지지만 제목 후보는 «머리 H1» 하나뿐이다.
    //   4칸 이상(또는 탭)은 들여쓴 코드이고 H2~H6 절 제목은 골 목적 제목으로 쓰지 않는다.
    const heading = /^ {0,3}#[ \t]+(.+)$/.exec(line);
    if (!heading) return undefined;
    // ⛔ CommonMark — `# 제목 ###` 의 «닫는 ATX 시퀀스»는 제목의 일부가 아니다(공백 뒤 `#` 만 남은 꼬리).
    //   ⚠️ `C#` 처럼 «공백 없이» 붙은 `#` 는 제목의 «내용»이므로 벗기지 않는다.
    //   ⊕ `# ###` 처럼 «전부» `#` 인 것은 «내용이 빈» 제목이라 남는 것이 없다.
    const raw = heading[1]!;
    const withoutClosing = /^#+[ \t]*$/.test(raw) ? '' : raw.replace(/[ \t]+#+[ \t]*$/, '');
    const title = withoutClosing.replace(/\s+/g, ' ').trim();
    // ⛔ 머리 H1 이라도 표지 낱말이면 제목이 아니다 — 「# 불변식」 같은 문서를 걸러 둔다.
    if (title && !NON_GOAL_DOCUMENT_HEADINGS.has(title)) return title;
  }
  return undefined;
}

function boundedGoalDescription(value: string): string | undefined {
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, GOAL_DESCRIPTION_MAX_CHARS);
  return trimmed || undefined;
}

/**
 * Open drafts joined to the run that recorded `pr-opened` for that PR. No ledger match stays runId ''.
 * ⛔ Join by the PR «URL» (owner/repo/number), not the number alone — the run ledger holds runs from
 *   every repository this machine drove, and askFile is repo-relative, so a number-only join can pair
 *   another repository's ledger row with this repository's PR of the same number and close the wrong PR.
 */
export function listOpenDraftsForLineage(
  lookup: typeof lookupOpenDraftPrs = lookupOpenDraftPrs,
  listLedgerFiles: (dir: string) => string[] = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  dir: string = runLedgerDir(),
): { number: number; runId: string; openedAt: string }[] {
  const open = lookup(defaultSpawnGh);
  const byUrl = new Map<string, { runId: string; openedAt: string }>();
  for (const file of listLedgerFiles(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const runId = file.slice(0, -'.jsonl'.length);
    let entries: ReturnType<typeof loadRunLedger>;
    try {
      entries = loadRunLedger(runId, dir);
    } catch {
      continue;
    }
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.event !== 'pr-opened') continue;
      const url = entry.data.url;
      if (typeof url !== 'string' || url.length === 0) continue;
      const openedAt = typeof entry.timestamp === 'string' ? entry.timestamp : '';
      const previous = byUrl.get(url);
      if (!previous || (openedAt && openedAt < previous.openedAt)) byUrl.set(url, { runId, openedAt });
    }
  }
  return open.map((draft) => {
    const known = byUrl.get(draft.url);
    return known
      ? { number: draft.number, runId: known.runId, openedAt: known.openedAt }
      : { number: draft.number, runId: '', openedAt: '' };
  });
}

export function defaultSeams(o?: DefaultSeamsOptions): DefaultSeamsResult;
export function defaultSeams(o: DefaultSeamsOptions = {}): SelfImplementSeams {
  const runSpawnSync = o.spawnSync ?? spawnSync;
  const resolveCleanupRepoRoot = o.resolveMainRepoRoot ?? resolveMainRepoRoot;
  const removeCleanupWorktree = o.removeWorktree ?? removeWorktree;
  const runCleanupGitCommand = o.runGitCommand ?? runGitCommand;
  const baselineRefs = new Map<string, string>();
  const gateVerifyOrdinals = new Map<string, number>();
  const gateVerifyIdentity = (runId: string | undefined) => {
    if (!runId?.trim()) return { runId: runId === undefined ? null : runId, ordinal: null };
    const ordinal = (gateVerifyOrdinals.get(runId) ?? 0) + 1;
    gateVerifyOrdinals.set(runId, ordinal);
    return { runId, ordinal };
  };
  const escalateGoalClarifications = o.llmReview ? (() => {
    try {
      const relay = (o.buildLlmHitlRelay ?? buildLlmHitlRelay)({ ask: o.llmReview });
      return async (request: Record<string, unknown>, dispatchContext?: Parameters<typeof dispatchAskUserQuestion>[1]) => {
        const parsed = parseQuestionRequest(request);
        const questionText = parsed.ok
          ? parsed.req.questions.map((question) => [
            question.question,
            ...question.options.flatMap((option) => [option.label, option.description]),
          ].join('\n')).join('\n')
          : '';
        let reason: 'relay-no-answer' | 'relay-not-agent' | 'side-effect-declined' | 'request-unparsed';
        let questionIds: readonly string[] = [];
        if (parsed.ok) {
          questionIds = parsed.req.questions.map(({ id }) => id);
          const sideEffect = SIDE_EFFECT_RE.test(questionText);
          if (sideEffect && !await relay.confirm({ prompt: questionText })) {
            reason = 'side-effect-declined';
          } else {
            const result = await relay.question(parsed.req);
            if (result?.answeredBy === 'agent') return { output: JSON.stringify(result), result };
            reason = result === null ? 'relay-no-answer' : 'relay-not-agent';
          }
        } else {
          reason = 'request-unparsed';
        }
        debug.log('self-implement', 'clarification-relay-fell-through', { reason, questionIds });
        return dispatchAskUserQuestion(request, dispatchContext);
      };
    } catch (error) {
      debug.log('self-implement', 'clarification-relay-unavailable', {
        error: String((error as { message?: string })?.message ?? error).slice(0, 200),
      }, { level: 'warn' });
      return undefined;
    }
  })() : undefined;
  const queryChildProviderErrors: NonNullable<SelfImplementSeams['queryChildProviderErrors']> = async ({ sinceMs, untilMs }) => {
    if (!o.stateDir) return { status: 'unavailable', reason: 'child-state-dir-unavailable' };
    const path = join(o.stateDir, 'logs', 'logs.db');
    if (!existsSync(path)) return { status: 'unavailable', reason: 'child-log-store-unavailable' };
    let store: LogStore | undefined;
    try {
      store = LogStore.openReadOnly(path);
      return queryStructuredChildProviderErrors(
        [instanceNameForStateDir(o.stateDir)],
        sinceMs,
        untilMs,
        (query) => store!.queryAll(query),
      );
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      store?.close();
    }
  };
  return {
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    ...(escalateGoalClarifications ? { escalateGoalClarifications } : {}),
    queryChildProviderErrors,
    persistPrBodyArtifact: (input) => createArtifactStore().put('block', input.body, {
      origin: input.origin,
      producer: 'pr-body-boundary',
      tags: ['pr-body', 'full-output'],
      description: `full PR body (${input.originalChars} chars)`,
    }),
    postMergeCleanup: {
      enabled: true,
      listActiveTerminalDirectories,
      isWorktreeInUse,
      readWorktreePorcelain,
      resolveMainRepoRoot: resolveCleanupRepoRoot,
      removeWorktree: (repoRoot, worktreePath) => {
        removeCleanupWorktree(repoRoot, worktreePath);
      },
      // `mergePr` uses squash, so the worktree branch tip is not normally an ancestor of main.
      // This adapter is only reached after a confirmed merge and both preservation checks pass.
      removeBranch: (repoRoot, branch) => {
        const result = runCleanupGitCommand(repoRoot, ['branch', '--delete', '--force', branch], { encoding: 'utf8', timeout: GIT_TIMEOUT });
        if (result.status !== 0) throw new Error(`post-merge cleanup branch removal failed: ${(result.stderr ?? result.stdout ?? '').trim() || `git exited ${result.status}`}`);
      },
      removeMatchingGoalCopy,
    },
    lineageSupersede: {
      listOpenDrafts: () => listOpenDraftsForLineage(),
      readRunLedger: (runId) => {
        try {
          return loadRunLedger(runId);
        } catch {
          return null;
        }
      },
      closeDraft: ({ number, comment }) => {
        const closed = makePrManager().closePr(`https://github.com/placeholder/placeholder/pull/${number}`, comment);
        if (!closed) throw new Error(`lineage supersede close failed for #${number}`);
      },
    },

    synthesizeGoalContext: async ({ goalFile }) => {
      if (!goalFile?.trim()) return {};
      let title: string | undefined;
      let document: string;
      try {
        document = readFileSync(goalFile, 'utf8');
        title = goalTitleFromDocument(document);
      } catch (error) {
        debug.log('self-implement', 'goal-context-read-failed', { goalFile, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        return {};
      }
      if (!title) return {};
      try {
        const resolved = resolveRoleLlm('classify');
        const prompt = `Summarize this goal in one concise sentence. Return only the sentence.\n\n${document}`;
        const summary = await withGoalSummaryTimeout(async (signal) => o.summarizeGoal
          ? o.summarizeGoal(prompt, resolved, signal)
          : await (async () => {
              const { streamLLM } = await import('../llm.js');
              const config = getUserConfig();
              const provider = getProviderForConfig(
                { ...config, llm: { ...config.llm, provider: resolved.provider, model: resolved.model } },
              );
              return streamLLM([{ role: 'user', content: prompt }], () => {}, { model: resolved.model, provider, reasoningEffort: 'low', signal, usageRole: 'classify' });
            })(), o.goalSummaryTimeoutMs ?? DEFAULT_GOAL_SUMMARY_TIMEOUT_MS);
        const goalDescription = boundedGoalDescription(summary);
        if (goalDescription) return { goalTitle: title, goalDescription, goalDescriptionSource: 'generated' as const };
        debug.log('self-implement', 'goal-context-summary-empty', { goalFile }, { level: 'warn' });
      } catch (error) {
        debug.log('self-implement', 'goal-context-summary-failed', { goalFile, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
      }
      const goalDescription = boundedGoalDescription(title);
      return {
        goalTitle: title,
        ...(goalDescription ? { goalDescription, goalDescriptionSource: 'title-fallback' as const } : {}),
      };
    },

    forkSession: async (parentSessionId) => {
      const forked = forkSessionById(parentSessionId, { origin: HARNESS_SESSION_ORIGIN });
      if (!forked) throw new Error(`self-implement fork: source session not found — ${parentSessionId}`);
      if (!isHarnessSessionOrigin(forked.meta.origin)) {
        throw new Error(`self-implement fork: child origin is not harness — ${parentSessionId}`);
      }
      return forked.meta.id;
    },

    defaultBranchRef,
    // ★ G2(2026-07-21) — 호출부가 해석한 대상만 PR 직전에 정합한다.
    mergeMain: async (worktreePath, mergeTarget) => {
      const { mergeMainIntoWorktreeWithLlm } = await import('../autopilot/build/llm-conflict-merge.js');
      return mergeMainIntoWorktreeWithLlm(worktreePath, mergeTarget);
    },
    // ★ G2 — mergeMain 전 impl 변경 커밋(merge 는 clean tree 요구). commitWorktree 재사용(nothing-to-commit 무해).
    commitWork: (cwd, message) => { commitWorktree(cwd, message); },
    gateWorktreeBehindMain: async (cwd) => gateWorktreeBehindMain(cwd),

    createWorktree: async ({ branch, base, runId, goalId, goalFile, goalTitle, goalDescription, goalDescriptionSource }) => {
      // ⛔ 실패/빈 출력을 `''` 로 흘리지 마라 — `'' !== resolvedBase` 라서 관측이
      //    `invokedHeadDiffers: true` 로 **오판**한다(무인 리뷰 must-fix). 모르면 undefined ⇒ 관측은 null.
      const revParseHead = (cwd: string): string | undefined => {
        const r = runGitCommand(cwd, ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: GIT_TIMEOUT });
        if (r.status !== 0) return undefined;
        const sha = (r.stdout ?? '').trim();
        return sha.length > 0 ? sha : undefined;
      };
      const invokedHead = revParseHead(process.cwd());
      const baseIsIntegration = (cwd: string, resolvedBase: string | undefined): boolean | undefined => {
        if (!resolvedBase) return undefined;
        const r = runGitCommand(cwd, ['merge-base', '--is-ancestor', resolvedBase, 'origin/main'], { encoding: 'utf8', timeout: GIT_TIMEOUT });
        if (r.status === 0) return true;
        return r.status === 1 ? false : undefined;
      };
      // ★ #25 P2(2026-07-21) — 비-git dir 타겟은 worktree 대신 git-init 그림자 스테이징(그림자=진짜
      //   git repo → 이후 implement/gate/commit/diff seam 무변경). front door 는 아직 비-git refuse(P2)
      //   → 이 분기는 seam 주입(테스트)로만 도달. 라우팅 결정 관측(자기인지). [[DESIGN-harness-target-generalization-2026-07-21]].
      if (o.targetKind === 'non-git-dir' && o.targetPath) {
        debug.log('harness.target', 'stage.route', { kind: o.targetKind, target: o.targetPath.slice(-48), branch });
        const s = stageNonGitDir({ target: o.targetPath, branch });
        const resolvedBase = revParseHead(s.path);
        return { path: s.path, branch: s.branch, base, resolvedBase, invokedHead };
      }
      // ★ #25 P3 — config/dotfile(단일 파일) 타겟은 파일 하나를 그림자로 감싼다(파일 단위 apply).
      if (o.targetKind === 'file' && o.targetPath) {
        debug.log('harness.target', 'stage.route', { kind: o.targetKind, target: o.targetPath.slice(-48), branch });
        const s = stageFile({ target: o.targetPath, branch });
        const resolvedBase = revParseHead(s.path);
        return { path: s.path, branch: s.branch, base, resolvedBase, invokedHead };
      }
      // P1 — 대상 repo: 명시 repoRoot(외부 개발) 우선, 없으면 데몬 cwd 의 repo(=elanous 자신·현행).
      const repoRoot = o.repoRoot ?? resolveMainRepoRoot(process.cwd()) ?? process.cwd();
      const r = createWorktree({
        repoRoot,
        branch,
        worktreeRoot: configuredWorktreeRoot(),
        resetExisting: true,
        reuseOwnedWorktree: true,
        ...(base ? { base } : {}),
        ...(runId ? { currentOwner: `dev:${runId}` } : {}),
      });
      if (r.resolvedBase) baselineRefs.set(r.path, r.resolvedBase);
      const provenance = runId ? {
        owner: `dev:${runId}`,
        command: 'elanous dev',
        createdAt: new Date().toISOString(),
      } : undefined;
      const recordProvenance = o.recordWorktreeProvenance ?? recordHarnessWorktreeProvenance;
      try {
        if (!provenance) throw new Error('worktree ownership was not recorded because runId is unavailable');
        recordProvenance(r.path, provenance);
        debug.log('self-implement', 'worktree-provenance-recorded', {
          path: r.path,
          baseFreshness: r.baseFreshness,
          reused: r.reused === true,
          ...provenance,
        });
        const created = {
          path: r.path,
          branch: r.branch,
          base: r.base,
          resolvedBase: r.resolvedBase,
          invokedHead,
          baseIsIntegration: baseIsIntegration(r.path, r.resolvedBase),
          baseFreshness: r.baseFreshness,
          ...(r.reused ? { reused: true } : {}),
          ...provenance,
        };
        const goalMetadata: HarnessWorktreeGoalMetadata = {
          ...(goalId?.trim() ? { goalId } : {}),
          ...(goalFile?.trim() ? { goalFile } : {}),
          ...(goalTitle?.trim() ? { goalTitle } : {}),
          ...(goalDescription?.trim() ? { goalDescription } : {}),
          ...(goalDescription?.trim() && goalDescriptionSource ? { goalDescriptionSource } : {}),
        };
        try {
          (o.recordWorktreeGoalMetadata ?? recordHarnessWorktreeGoalMetadata)(r.path, goalMetadata);
          debug.log('self-implement', 'worktree-goal-metadata-recorded', { path: r.path, ...goalMetadata });
        } catch (error) {
          debug.log('self-implement', 'worktree-goal-metadata-failed', { path: r.path, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        }
        return created;
      } catch (error) {
        const provenanceError = error instanceof Error ? error.message : String(error);
        // Manual creation rolls back on a metadata failure; self-implement retains its workspace and continues.
        debug.log('self-implement', 'worktree-provenance-failed', { path: r.path, ...(provenance ?? {}), reason: provenanceError }, { level: 'warn' });
        return {
          path: r.path,
          branch: r.branch,
          base: r.base,
          resolvedBase: r.resolvedBase,
          invokedHead,
          baseIsIntegration: baseIsIntegration(r.path, r.resolvedBase),
          baseFreshness: r.baseFreshness,
          ...(r.reused ? { reused: true } : {}),
          provenanceError,
        };
      }
    },

    implement: async ({ cwd, feature, documentReferences, escalateTier, childLlm, signal, runId, shardIdentity, onProgress, onSurfaceProgress, onLifecycleScreenClassification, onSupervisorInput, roundContext, harnessSeededPaths }) => {
      const executionSignal = signal && o.signal ? AbortSignal.any([signal, o.signal]) : signal ?? o.signal;
      // ★ #2 모델 escalation 이중 티어(2026-07-22 대표 결론) — base(terra) 소진 시 sol, sol 도 못 풀면 opus.
      //   프롬프트 rigor 힌트는 buildReworkFeature 가 이미 주입(feature 에 "sol/opus·근본부터"). 모델 티어
      //   실전환은 driver 가 tier→타깃(resolveEscalateTarget)을 자식 goal-loop 의 ELANOUS_ESCALATE_* env 로 주입.
      if (escalateTier && escalateTier !== 'none') { try { debug.log('self-implement', 'implement.escalate', { cwd, tier: escalateTier }); } catch { /* fail-soft */ } }
      // ⑩ nest-cap — CLI 직접호출(elanous self implement) 경로 가드(툴-제외가 안 걸리는 경로). 상한 도달 시
      // 자식 spawn 거부(액자 폭주 방지). 툴 서피스 경로는 daemon-tools 에서 이미 제외됨(defense-in-depth).
      if (nestCapReached()) {
        const info = nestInfo();
        debug.log('substrate.nest', 'implement-refused', info, { level: 'warn' });
        return { ok: false, summary: `nest-cap: 재귀 상한(${info.max}중·현재 ${info.depth}) 도달 — self-build 중단(액자 폭주 방지)` };
      }
      // 자식 elanous 을 헤드리스 `chat --tools --goal-loop` 서브프로세스로 spawn(canonical goal-loop
      // 아밍·PTY 無). cwd=worktree → Edit/Write 가 워크트리에 쓰고, config-dir 격리로 provider/goal-loop
      // config 적용. --goal-loop 플래그가 아밍(config 없어도)이지만 configDir 도 함께 켜 이중아밍.
      // childNestEnv() 로 ELANOUS_NEST_DEPTH+1 전파 → 자식의 자식-spawn 이 상한에 걸리게.
      // elanous 코딩에이전트 바이너리 위치 — 외부 repo 개발이면 worktree(cwd)엔 elanous 바이너리가 없으므로
      // elanousBinRoot(=elanous repo)를 써야 한다. elanous 자신 개발이면 cwd repo=elanous 라 현행과 동일.
      const binRoot = o.elanousBinRoot ?? resolveMainRepoRoot(cwd) ?? resolve(import.meta.dir, '../..');
      // ★ 파생 우주 물질화(2026-07-27) — 3층 스위치가 켜진 뒤 자식은 `<worktree>/.elanous-test`
      //   로 파생되는데 갓 만든 워크트리의 그 우주는 **비어 있다**. 그러면 자식이
      //   needsOnboarding 에 걸려 **대화형 마법사**를 띄우고 툴콜 0 으로 타임아웃한다
      //   (실측: 자율 잡 2건이 각각 1200초를 태우고 aborted). spawn 전에 config 를 깐다.
      //   fail-open — 실패해도 스폰은 계속하고 관측만 남는다.
      //   ⚠️ 스포너가 우주를 명시(configDir/stateDir)했으면 자식은 파생하지 않으므로 건드리지
      //      않는다 — 리졸버의 층 우선순위와 같은 판정(안 쓸 곳에 자격을 뿌리지 않는다).
      provisionDerivedUniverse(cwd, { explicitRoot: o.configDir ?? o.stateDir });
      const maxWaitSec = o.implementMaxWaitSec ?? 600;
      const activityGraceSec = o.implementActivityGraceSec;
      const reviewerContext = budgetReviewerContext(o.reviewerContext);
      debug.log('self-implement', 'implement.context', {
        itemCount: reviewerContext.itemCount,
        shownChars: reviewerContext.shownChars,
        totalChars: reviewerContext.totalChars,
        truncated: reviewerContext.truncated,
        fullyIncludedItems: reviewerContext.fullyIncludedItems,
        truncatedItems: reviewerContext.truncatedItems,
        omittedItems: reviewerContext.omittedItems,
        ...(runId ? { runId } : {}),
      });
      const prompt = featurePrompt(feature, cwd, o.reviewerContext);
      // S4 P2b/P3: input은 관측만 하며, done만 config와 stall 확증을 모두 만족할 때 부모 대기를 끝낸다.
      // 이 종료-보고 규칙은 self-implement child에만 적용한다. 범용 brain의 기본 프롬프트를 바꾸지 않는다.
      const brain = createSelfImplementControlBrain({ goal: feature });

      // ★ PTY 호스팅(2026-07-21·task#22) — 자식 goal-loop 을 startPty 로 띄운다. spawnSync 대비:
      //   ① 부모 비블로킹(이벤트루프 살아있음 → telegram 반응·로그 flush 유지·웨지-침묵 해소)
      //   ② registry 등록(PWA /v1/terminals 스크롤백 무배선 노출·snapshot/screenshot)
      //   ③ 라이브 진행 관측(headless.progress). PTY 불가/cap 초과/에러는 아래 spawnSync 폴백.
      let ptyDegradedReason: PtyDegradedReason | undefined;
      const notePtyFallback = (reason: PtyDegradedReason, error?: unknown): void => {
        ptyDegradedReason = reason;
        debug.log('self-implement', 'headless.pty-fallback', {
          reason,
          degraded: PTY_DEGRADED_CAPABILITIES,
          ...(error === undefined ? {} : { error: String((error as { message?: string })?.message ?? error).slice(0, 200) }),
        }, { level: 'warn' });
      };
      if ((o.ptyAvailable ?? ptyAvailable)()) {
        try {
          const res = await (o.runHeadlessGoalLoopPty ?? runHeadlessGoalLoopPty)({
            binRoot, cwd, featurePrompt: prompt, maxWaitSec, brain,
            ...(activityGraceSec !== undefined ? { activityGraceSec, activityGraceSource: 'caller' as const } : {}),
            autoStop: getUserConfig().tools.selfImplement.autoStop,
            autoAssist: getUserConfig().tools.selfImplement.autoAssist,
            screenStallTermination: getUserConfig().tools.selfImplement.screenStallTermination,
            canReceiveInput: false,
            ...(runId ? { runId } : {}),   // ★ K run-identity — 라운드 전부가 호출 1개의 runId 를 공유
            ...(shardIdentity ? { shardIdentity } : {}),
            ...(o.configDir ? { configDir: o.configDir } : {}),
            ...(o.stateDir ? { stateDir: o.stateDir } : {}),
            // ⛔⭐ 뿌리를 넘길 땐 «출처»도 같이 — 한 홉이라도 빠지면 자식이 「명시」로 읽는다(`OBS-T121`)
            ...(o.stateDirSource ? { stateDirSource: o.stateDirSource } : {}),
            ...(executionSignal ? { signal: executionSignal } : {}),   // /cancel 또는 구현 timeout → PTY 즉시 kill
            ...(escalateTier && escalateTier !== 'none' ? { escalateTier } : {}),   // #2 — 이중티어(sol/opus)로 자식 스폰
            ...(childLlm ? { childLlm } : {}),
            ...(documentReferences ? { documentReferences } : {}),
            ...(onProgress ? { onProgress } : {}), // part2-B — execute judge 로 라이브 델타 전달(PTY 경로만).
            ...(onSurfaceProgress ? { onSurfaceProgress } : {}), // Sparse parent-surface lines; raw execute-judge delta remains onProgress only.
            ...(onSupervisorInput ? { onSupervisorInput } : {}),
            ...(onLifecycleScreenClassification ? { onLifecycleScreenClassification } : {}),
            ...(roundContext ? { roundContext } : {}),
          });
          if (res.ok) {
            const changed = worktreeHasChanges(cwd, harnessSeededPaths ?? []);
            debug.log('self-implement', 'implement.result', { reached: res.reachedCompletion, changed, toolCalls: res.toolCalls, timedOut: res.timedOut, exit: res.exitCode, transport: 'pty', pty: res.ptyId, ...(runId ? { runId } : {}) });
            // ⭐ 부팅 단계에서 죽었으면 **그 사유를 이름으로** 올린다 — 상위 층이 `aborted` 하나로
            //   뭉개면 사람이 다른 원인을 만들어 낸다(실측: 오진 3회).
            const bootReason = resolveBootFailureReason(res.transcript, changed, res.toolCalls);
            const completionDisposition = resolveCompletionDisposition({
              timedOut: res.timedOut, reachedCompletion: res.reachedCompletion, toolCalls: res.toolCalls, changed,
            });
            if (bootReason) {
              debug.log('self-implement', 'boot-failure', {
                reason: bootReason, exit: res.exitCode, toolCalls: res.toolCalls, changed,
                transport: 'pty', pty: res.ptyId, ...(runId ? { runId } : {}),
              }, { level: 'warn' });
            }
            return {
              ok: changed && !res.timedOut,
              ...(completionDisposition ? { completionDisposition } : {}),
              // ★ I-9 — 두 갈래가 **같은 조립기**를 쓴다(갈래마다 짜면 한쪽만 정직해진다).
              ...buildImplementReport(res.transcript, { ...(bootReason ? { bootReason } : {}), changed, toolCalls: res.toolCalls, reached: res.reachedCompletion, timedOut: res.timedOut, ...(res.ptyId ? { ptyId: res.ptyId } : {}) }),
              toolCalls: res.toolCalls,
              terminalStatus: { reached: res.reachedCompletion, changed, toolCalls: res.toolCalls, timedOut: res.timedOut },
            };
          }
          notePtyFallback('error', new Error('PTY runner returned no usable result'));
        } catch (e) {
          notePtyFallback(ptyFallbackReason(e), e);
        }
      } else {
        notePtyFallback('unavailable');
      }

      // 폴백 — PTY 불가/cap 초과/에러. 기존 헤드리스 spawnSync 경로 보존(블로킹이지만 견고).
      const args = [`${binRoot}/bin/elanous.mjs`, 'dev', '--implement'];
      const executionId = randomUUID();
      if (o.configDir) args.push('--config-dir', o.configDir);
      args.push(prompt);
      const r = runSpawnSync('bun', args, {
        cwd, encoding: 'utf8', timeout: maxWaitSec * 1000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(executionSignal ? { signal: executionSignal } : {}),   // /cancel 또는 구현 timeout → 자식 SIGTERM(고아 방지)
        // ★ #4 명시 쓰기 경계 + 공간 자기인지(2026-07-25) — PTY 경로(runHeadlessGoalLoopPty)와 **대칭**으로,
        //   space env 를 명시 합성해 전파한다. spawnSync 는 ...process.env 를 상속하지만 그것만 믿으면 부모가
        //   공간 밖(진입점이 SPACE 를 안 심은 경우)일 때 자식이 SPACE 없이 부팅 → activateHarnessWriteBoundary/
        //   harnessMainTreeReject 가 즉시 no-op(무보호)이 된다(리뷰 must-fix). getHarnessSpace() ?? synthesize
        //   (worktree 이름·PTY 경로와 동형)로 SPACE 를 보장 + boundary(worktree=cwd) 전파.
        env: {
          ...process.env,
          ...(o.stateDir ? { ELANOUS_STATE_DIR: o.stateDir } : {}),
          // ⛔⭐⭐⭐ **뿌리와 «한 벌»로 간다** — 안 주면 자식이 「파생」을 「사람이 말한 격리」로 읽는다.
          //   ⇒ 실물: 쿼터 신호가 갱신 안 되는 우주를 봐서 전 계정 unknown ⇒ 회전이 100% 계정 선택 ⇒ 429(4회).
          ...(o.stateDir && o.stateDirSource ? { ELANOUS_STATE_DIR_SOURCE: o.stateDirSource } : {}),
          ...childNestEnv(),
          ...((): Record<string, string> => {
            const sp = getHarnessSpace() ?? { inHarness: true as const, kind: 'self-implement' as const, id: normalizeSpaceId(basename(cwd)), runId: getHarnessRunId() };
            // ★ K run-identity 공백 방어 — driver 와 동일 계약(호출자 > 상속 > canonical mint). 빈 runId 는
            //   `elanous self run <runId>` 조인을 불가능하게 만든다(2026-07-26 실측 갭).
            return harnessSpaceEnv(sp.kind, sp.id, resolveRunIdentity({ explicit: runId, inherited: sp.runId }).runId);
          })(),
          ...harnessBoundaryEnv(cwd),
          ...harnessBoundaryRequestsEnv(executionId),
          ...harnessBoundaryResponsesEnv(executionId),
          ...harnessPolicyEnv(),
        },
      });
      const transcript = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const errCode = (r.error as { code?: string } | undefined)?.code;
      const timedOut = errCode === 'ETIMEDOUT' || r.signal === 'SIGTERM';
      const reached = /^\s*GOAL-COMPLETE\s*$/m.test(transcript) || (r.status === 0 && !timedOut);
      const toolCalls = (transcript.match(/⏺\s+\w+\(/g) || []).length;
      const changed = worktreeHasChanges(cwd, harnessSeededPaths ?? []);
      debug.log('self-implement', 'implement.result', {
        reached, changed, toolCalls, timedOut, exit: r.status, transport: 'spawnSync',
        ...(runId ? { runId } : {}),
        ...(ptyDegradedReason ? { ptyDegraded: true, ptyDegradedReason } : {}),
      });
      // ⭐ PTY 경로와 **같은 규칙**으로 부팅 실패 사유를 올린다(두 갈래가 갈리면 한쪽만 정직해진다).
      const bootReason = resolveBootFailureReason(transcript, changed, toolCalls);
      const completionDisposition = resolveCompletionDisposition({ timedOut, reachedCompletion: reached, toolCalls, changed });
      if (bootReason) {
        debug.log('self-implement', 'boot-failure', {
          reason: bootReason, exit: r.status, toolCalls, changed,
          transport: 'spawnSync', ...(runId ? { runId } : {}),
        }, { level: 'warn' });
      }
      return {
        // artifact-first(대표 지시): 파일이 실제 변경됐고 타임아웃 아니면 성공 — 품질은 다음 gate 가 검증.
        ok: changed && !timedOut,
        ...(completionDisposition ? { completionDisposition } : {}),
        ...buildImplementReport(transcript, { ...(bootReason ? { bootReason } : {}), changed, toolCalls, reached, timedOut }),
        toolCalls,
        terminalStatus: { reached, changed, toolCalls, timedOut },
      };
    },

    gate: async (cwd, ctx) => {
      // ★ #25 P3(2026-07-21) — config/dotfile(file) 타겟은 manifest 테스트가 없다 → syntax gate.
      //   그림자(cwd) 안 파일(=basename(targetPath))의 문법을 검사(zsh -n·JSON.parse 등). fail=적용 차단.
      if (o.targetKind === 'file' && o.targetPath) {
        const fileName = basename(o.targetPath);
        const g = runConfigSyntaxGate(`${cwd}/${fileName}`);
        debug.log('self-implement', 'gate.syntax', { passed: g.passed, checked: g.checked, label: g.label, file: fileName }, { level: g.passed ? 'info' : 'warn' });
        return { passed: g.passed, log: `[syntax gate: ${g.label}]\n${g.log}` };
      }
      // ★ #25 P1/P2(2026-07-21) — 외부 target 이면 target(그림자 포함)의 manifest 로 gate 명령 감지
      //   (elanous bun test 부적합). P1=외부 git repo(o.repoRoot), P2=비-git dir 그림자(o.targetKind).
      //   감지 실패=skip-with-warn(검증은 리뷰/diff). elanous 자신(둘 다 미설정)은 아래 종전 integrity-gate
      //   유지(회귀 0). cwd=그림자 git repo 라 detectGateCommand 가 그림자 manifest 를 검사. [[DESIGN-harness-target-generalization-2026-07-21]].
      if (o.repoRoot || o.targetKind === 'non-git-dir') {
        const detected = detectGateCommand(cwd);
        if (!detected) {
          debug.log('self-implement', 'gate.skipped', { reason: 'no-manifest', target: cwd.slice(-40) });
          return { passed: true, log: '외부 target: manifest 미감지 → gate skip(검증은 diff/리뷰 HITL 로).' };
        }
        debug.log('self-implement', 'gate.detected', { cmd: detected.label, target: cwd.slice(-40) });
        const gr = spawnSync(detected.cmd, detected.args, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
        const passed = gr.status === 0;
        debug.log('self-implement', 'gate.result', { passed, cmd: detected.label, exit: gr.status }, { level: passed ? 'info' : 'warn' });
        return { passed, log: tailWithOmissionMarker(`[gate: ${detected.label}]\n${gr.stdout ?? ''}${gr.stderr ?? ''}`, 4000) };
      }
      // ⑤ gate 스코프(2026-07-20 → **2026-07-26 근본 재작성**) — 풀 `bun test` 는 느리고(10분+)
      // 통합/네트워크 테스트가 불안정하다. 종전엔 "변경에 테스트 파일이 없으면 풀 폴백"이었는데
      // 그것이 **시스템 오류**였다: base 가 깨끗하지 않으면(실측: `test/telegram-acp-bridge.test.ts`
      // 가 hang) 그 폴백은 **항상 실패 = 정보량 0** 이고, 무관한 실패를 이 변경에 **오귀속**한다.
      // ⇒ 이제 **연관 테스트를 유도**한다(`gate-scope.ts` · 순수 · 근거·트레이드오프는 그 헤더가 SSOT).
      //   풀 폴백 경로는 **제거**했다. 유도 실패 시엔 test 스텝을 건너뛰고 tsc 게이트만 남는다.
      const comparisonBase = gateComparisonBase(cwd);
      const observationChanges = gateChangedFiles(cwd, comparisonBase);
      const observationChangedFiles = observationChanges.files;
      const postsync = ctx?.mode === 'postsync';
      // 정합 전 일반 게이트는 worktree-only. 정합 후 재게이트만 이미 계산된 merge-base 목록을 실행 범위로 쓴다.
      const changedAll = postsync ? observationChangedFiles : gitChangedFiles(cwd);
      // ⚠️ **regular-file 판정**(리뷰 should-fix 5R) — `existsSync` 는 **디렉터리도 true** 다.
      //   계약은 "실존 테스트 **파일**"이므로 파일 여부까지 확인한다(디렉터리를 testArgs 로 넘기면
      //   필터 무매치 → "0 files ran" 부당 실패).
      const isFile = (p: string): boolean => {
        try { return statSync(join(cwd, p)).isFile(); } catch { return false; }
      };
      const trackedFiles = git(cwd, ['ls-files']).out.split('\n').map((file) => file.trim()).filter(Boolean);
      const importerTestIndex = buildImporterTestIndex(
        cwd,
        trackedFiles.filter(isTestPath),
        [...new Set([...trackedFiles, ...changedAll, ...observationChangedFiles])].filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file)),
      );
      // 워크트리에 없는 변경 경로 = 지운 파일 — 미검증으로 세지 않는다(gate-scope `isDeleted` · 2026-09-26 run-7dd4cce6).
      const isDeleted = (path: string): boolean => !isFile(path);
      const scope = resolveGateScope(changedAll, isFile, importerTestIndex ?? undefined, postsync ? { mode: 'postsync', isDeleted } : { isDeleted });
      const comparisonFailureReason = observationChanges.comparisonBaseStatus === 'unavailable'
        ? 'comparison-base-unavailable'
        : observationChanges.comparisonBaseStatus === 'comparison-failed'
          ? 'comparison-base-failed'
          : undefined;
      const unmeasuredPostsync = postsync && !comparisonFailureReason && scope.reason === 'unmeasured';
      const scopeReason = comparisonFailureReason ?? scope.reason;
      const observationScope = resolveGateScope(observationChangedFiles, isFile, importerTestIndex ?? undefined);
      const observedChangedTestFiles = observationScope.reason === 'changed-tests'
        ? (observationScope.testArgs ?? []).filter((file) => !observationScope.pulledInRelatedTests.includes(file))
        : [];
      // This reads the merge-base without executing base tests. Its static declaration count is
      // observational: dynamic generation and renamed helpers can make it incomplete.
      const declarationDecline = testDeclarationDecline(cwd, comparisonBase, observedChangedTestFiles);
      const gateOpts: { steps?: GateStepName[]; testArgs?: string[] } = {};
      let testStepSkipped = false;
      if (o.gateSteps) gateOpts.steps = o.gateSteps;
      if (comparisonFailureReason) {
        gateOpts.steps = (o.gateSteps ?? DEFAULT_GATE_STEPS).filter((step) => step !== 'test');
        testStepSkipped = true;
      } else if (scope.skipTestStep) {
        // ⭐ **무조건** test 스텝을 뺀다(리뷰 must-fix 2026-07-26). #5490 은 "뺀 결과가 비면 건너뛰지
        //   않는다"는 fail-safe 를 두었는데, `gateSteps === ['test']` 인 호출자에서는 그 가드가
        //   `steps=['test']` + `testArgs` 없음 = **풀 `bun test`** 를 되살렸다 — 이 PR 이 없애려는
        //   바로 그 경로다. 빈 steps 는 안전하다: `runIntegrityGate` 는 `steps=[]` 에서 루프를 돌지
        //   않고 `passed=true` 를 낸다(`integrity-gate.ts:65·69`).
        // ⚠️ "검증 0" 우려의 답 — test 스텝을 빼도 **아래 `changedFileTypecheck`(변경파일 tsc)는 항상
        //   돈다.** 그게 이 게이트의 바닥이다. docs-only(#5490)가 이미 같은 계약으로 출하돼 있다.
        gateOpts.steps = (o.gateSteps ?? DEFAULT_GATE_STEPS).filter((step) => step !== 'test');
        testStepSkipped = true;
      } else if (scope.testArgs && scope.testArgs.length > 0) {
        // ⚠️ 빈 배열은 integrity-gate 에서 **필터 미적용=풀 실행**이라 절대 넣지 않는다.
        gateOpts.testArgs = [...scope.testArgs];
      }
      // ⭐ 관측(제1원칙) — "왜 이 범위로 돌았나"를 로그만으로 답할 수 있게. `no-related-tests` 는
      //    "검증 못 한 소스가 있다"는 뜻이라 warn 으로 올린다(조용한 스킵 은폐 금지).
      debug.log('self-implement', 'gate.scope', {
        ...(ctx?.runId ? { runId: ctx.runId } : {}),
        targeted: gateOpts.testArgs?.length ?? 0, files: (gateOpts.testArgs ?? []).slice(0, 8),
        changedTests: observedChangedTestFiles.slice(0, 8), changedTestCount: observedChangedTestFiles.length,
        srcChanged: scope.sourceFiles.length, testStepSkipped,
        scopeReason, derived: scope.derived.length, ignoredOutsideSrc: scope.ignoredOutsideSrc,
        comparisonBaseStatus: observationChanges.comparisonBaseStatus,
        // ⚠️ 변경 목록엔 있으나 실존하지 않는 테스트 경로(삭제·rename 前) — 0 이 아니면 그 사실이 보여야
        //   한다. 이걸 걸러내지 않으면 필터 무매치로 게이트가 **부당 실패**한다(must-fix 4R).
        missingTestFiles: scope.missingTestFiles,
        testDeclarationDecline: declarationDecline,
        // ⭐ **개수가 아니라 목록**(리뷰 must-fix) — "무엇이 검증 안 됐나"는 개수로 답이 안 된다.
        //   상한 8건(로그 비대 방지) + 총수는 unverifiedCount 로 별도(생략 은폐 금지).
        unverified: scope.unverified.slice(0, 8), unverifiedCount: scope.unverified.length,
        documentPaths: scope.documentPaths.slice(0, 8), documentPathCount: scope.documentPaths.length,
        documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests.slice(0, 8),
        documentsWithoutDerivedTestCount: scope.documentsWithoutDerivedTests.length,
        pulledInRelatedTests: scope.pulledInRelatedTests.slice(0, 8),
        pulledInRelatedTestCount: scope.pulledInRelatedTests.length,
        importerTestIndexAvailable: importerTestIndex !== null,
        importerTestsNotRun: scope.importerTestsNotRun?.files ?? null,
        importerTestsNotRunCount: scope.importerTestsNotRun?.total ?? null,
        importerTestsNotRunTruncated: scope.importerTestsNotRun?.truncated ?? null,
        unresolvedRelativeImportSpecifiers: scope.importerTestsNotRun?.unresolvedRelativeSpecifiers ?? null,
      // ⚠️ 커버 안 된 변경이 있으면 **테스트가 돌았어도** warn — debug 는 운영 로그에서 필터링된다(리뷰 should-fix).
      }, { level: scope.reason === 'no-related-tests' || scope.missingTestFiles > 0 || scope.unverified.length > 0 ? 'warn' : 'debug' });
      // `defaultSeams.gate` owns the changed-file list and runs before the test-step skip,
      // so platform-only changes remain measured even when gate-scope has no Bun filters.
      const androidChanged = androidFilesIn(changedAll);
      const iosChanged = iosFilesIn(changedAll);
      const androidExit = androidChanged.length === 0
        ? 0
        : (o.runAndroidUnitTestGate ?? runAndroidUnitTestGate)({ args: ['--changed-files', ...changedAll], cwd });
      const iosExit = iosChanged.length === 0
        ? 0
        : (o.runIosUnitTestGate ?? runIosUnitTestGate)({ args: ['--changed-files', ...changedAll], cwd });
      const platformPassed = androidExit === 0 && iosExit === 0;
      const r = await (o.runIntegrityGate
        ? o.runIntegrityGate(cwd, gateOpts)
        : runIntegrityGate(cwd, gateOpts));
      const testStep = r.steps.find((step) => step.name === 'test');
      const failedTest = r.steps.find((step) => step.name === 'test' && !step.ok);
      const comparisonFailureLog = comparisonFailureReason
        ? `\n\n[gate-scope] ${comparisonFailureReason} — comparison status=${observationChanges.comparisonBaseStatus}; test 스텝을 실행하지 않고 gate를 실패 처리했다.`
        : unmeasuredPostsync
          ? `\n\n[gate-scope] unmeasured — postsync 실행 범위가 비어 측정하지 못했다. 「깨끗하다」가 아니라 「못 쟀다」이므로 passed를 참으로 내지 않는다.`
          : '';
      let baselineNote = '';
      let verifyByBreakingNote = '';
      let verifyByBreaking: (
        | {
          ran: true;
          distinguishes: number;
          'does-not-distinguish': number;
          unknown: number;
          missingAtBase: number;
          files?: readonly { file: string; classification: 'distinguishes' | 'does-not-distinguish' | 'unknown' | 'missing-at-base' }[];
        }
        | {
          ran: false;
          distinguishes: number;
          'does-not-distinguish': number;
          unknown: number;
          skippedReason?: string;
        }
      ) | undefined;
      let baselineReport: ReturnType<typeof buildGateBaselineReport> | undefined;
      let baselineFailures: ReturnType<typeof buildGateBaselineReport>['failures'] | undefined;
      let reflectGateFacts: ReflectGateFacts | undefined;
      let integrityPassed = r.passed && platformPassed;
      const emptyVerifyCounts = {
        distinguishes: 0,
        doesNotDistinguish: 0,
        unknown: 0,
        baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 },
      };
      const countUnknownReasons = (files: ReturnType<typeof runVerifyByBreaking>['files']): Record<string, number> | undefined => {
        try {
          return files.reduce<Record<string, number>>((counts, entry) => {
            if (entry.classification !== 'unknown') return counts;
            const reason = entry.base.unknownReason ?? 'unspecified';
            counts[reason] = (counts[reason] ?? 0) + 1;
            return counts;
          }, {});
        } catch {
          return undefined;
        }
      };
      if (failedTest) {
        const worktreeLog = failedTest.output ?? '';
        const failedFiles = [...new Set(extractGateTestFailures(worktreeLog)
          .flatMap((failure) => failure.file ? [failure.file] : []))];
        // 워크트리와 같은 묶음으로 베이스라인을 돌려 파일 간 간섭을 재현한다. 스코프가 없으면 실패 파일로 폴백.
        const testArgs = gateOpts.testArgs;
        const useWorktreeBundle = !!testArgs && testArgs.length > 0;
        const baselineFiles = [...new Set(useWorktreeBundle ? testArgs : failedFiles)];
        const baselineScope = useWorktreeBundle ? 'worktree-bundle' : 'failed-files-fallback';
        const baseline = (o.runGateBaseline ?? runGateBaseline)(cwd, baselineFiles, baselineRefs.get(cwd));
        const rerun = (o.rerunBunTimeoutFailures ?? rerunBunTimeoutFailures)(
          cwd,
          extractGateTestFailures(worktreeLog),
          undefined,
          baseline.status === 'unknown' ? undefined : (baseline.output ?? ''),
          baseline.missingAtBase ?? [],
        );
        const rerunObservations = rerun instanceof Map ? rerun : rerun.observations;
        const rerunNotRun = rerun instanceof Map ? 0 : rerun.rerunNotRun;
        const report = buildGateBaselineReport(worktreeLog, baseline, rerunObservations, rerunNotRun);
        baselineReport = report;
        baselineFailures = report.failures;
        const unknownReason = baseline.unknownReason;
        reflectGateFacts = {
          introduced: report.introduced,
          preexisting: report.preexisting,
          unknown: report.unknown,
          timedOut: report.timedOut,
          ...(report.flakyRerun > 0 ? { flakyRerun: report.flakyRerun } : {}),
          ...(report.rerunNotRun > 0 ? { rerunNotRun: report.rerunNotRun } : {}),
          ...(report.timeoutPassedAtBase > 0 ? { timeoutPassedAtBase: report.timeoutPassedAtBase } : {}),
          ...(report.mayVaryNonTimeout > 0 ? { mayVaryNonTimeout: report.mayVaryNonTimeout } : {}),
          ...(report.rerunAttempted > 0 ? { rerunAttempted: report.rerunAttempted } : {}),
          ...(report.rerunRecovered > 0 ? { rerunRecovered: report.rerunRecovered } : {}),
          ...(unknownReason ? { unknownReason } : {}),
          ...(baseline.baselineBudgetMs !== undefined ? { baselineBudgetMs: baseline.baselineBudgetMs } : {}),
          ...(baseline.baselineFileCount !== undefined ? { baselineFileCount: baseline.baselineFileCount } : {}),
          ...(report.childResponsibility ? { childResponsibility: report.childResponsibility } : {}),
        };
        const nonTestStepsPassed = r.steps.every((step) => step.name === 'test' || step.ok);
        integrityPassed = nonTestStepsPassed && allowsBaselineOnlyFailure(report);
        const location = observeGateBaselineLocation(cwd);
        debug.log('self-implement', 'gate.baseline', {
          introduced: report.introduced,
          preexisting: report.preexisting,
          unknown: report.unknown,
          preconditionUnmet: report.preconditionUnmet,
          failures: report.failures.slice(0, 20),
          baselineFiles: report.files,
          baselineStatus: report.baselineStatus,
          timedOut: report.timedOut,
          timeoutPassedAtBase: report.timeoutPassedAtBase,
          baselineScope,
          branch: location.branch,
          workdir: location.workdir,
        }, {
          // ⭐ 심각도 판정은 **술어가 사는 곳**(gate-baseline)에 있다 — 여기서 조건을 다시 계산하면
          //   차단 조건과 갈라진다(리뷰 must-fix · #6064 R2).
          level: gateBaselineLogLevel(report, nonTestStepsPassed),
        });
        baselineNote = `\n\n${formatGateBaselineNote(report, scope.importerTestsNotRun?.total ?? 0, ctx?.runId)}`;
      } else {
        // 영은 값이다. 실패가 없어 줄이 없으면 「일어나지 않았다」와 구분되지 않는다.
        const location = observeGateBaselineLocation(cwd);
        debug.log('self-implement', 'gate.baseline', {
          introduced: 0,
          preexisting: 0,
          unknown: 0,
          preconditionUnmet: 0,
          timedOut: 0,
          timeoutPassedAtBase: 0,
          branch: location.branch,
          workdir: location.workdir,
        });
      }
      // ★ #2(2026-07-21) — 변경파일 스코프 tsc 를 gate 에 편입. 스코프 bun test 가 컴파일 안 한 변경 소스의
      //   tsc-깨짐(F1 refFacts 미정의)을 결정론 차단. 변경 전체(.ts·테스트 포함)를 tsc 로 검사(변경 경로만 카운트).
      const tc = changedFileTypecheck(cwd, changedAll);
      debug.log('self-implement', 'gate.tsc', { checked: tc.checked, passed: tc.passed, errors: tc.errors, exempted: tc.exempted, noInspectionReason: tc.noInspectionReason }, { level: tc.passed ? 'info' : 'warn' });
      // ⛔⭐⭐ **최종 게이트가 통과할 때만** 돈다(리뷰 2R) — 종전엔 `r.passed`(스텝 결과)만 보고
      //   `tc`(변경파일 tsc) **전에** 실행해서, tsc 가 깨져 **최종 게이트가 실패한 런에도**
      //   base 를 다시 돌리고 `gate.log` 를 바꿨다 ⇒ *"게이트 실패 경로 무변경"* 경계 위반.
      //   ⇒ 조건을 **최종 판정과 같은 식**(`integrityPassed && tc.passed`)으로 묶는다.
      const gatePassed = !comparisonFailureReason && !unmeasuredPostsync && integrityPassed && tc.passed;
      const verifyIdentity = gateVerifyIdentity(ctx?.runId);
      if (gatePassed && scope.skipTestStep) {
        verifyByBreaking = { ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: scope.reason };
        verifyByBreakingNote = `\n\n${formatVerifyByBreakingScopeSkipNote(scope.reason, changedAll)}`;
        debug.log('self-implement', 'gate.verify-by-breaking', {
          skipped: true,
          reason: scope.reason,
          testStep: 'scope-skipped',
          ...verifyIdentity,
          ...emptyVerifyCounts,
        }, { level: 'info' });
      } else if (gatePassed && testStep?.ok && !testStep.skipped && (!scope.testArgs || scope.testArgs.length === 0)) {
        verifyByBreaking = { ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: 'empty-test-args' };
        verifyByBreakingNote = '\n\nVerify-by-breaking: skipped; reason=empty-test-args';
        debug.log('self-implement', 'gate.verify-by-breaking', {
          skipped: true,
          reason: 'empty-test-args',
          testStep: 'passed',
          ...verifyIdentity,
          ...emptyVerifyCounts,
        }, { level: 'warn' });
      } else if (gatePassed && testStep?.ok && !testStep.skipped && scope.reason !== 'changed-tests') {
        verifyByBreaking = { ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: 'no-edited-tests' };
        // ⛔⭐⭐ **`derived` 는 자식이 테스트를 하나도 안 건드린 경우다**(리뷰 6R) — 그때 `testArgs` 는
        //   전부 **유도된 기존 연관 테스트**이고 `pulledInRelatedTests` 는 빈 배열이라, 집합 차로는
        //   구분되지 않는다. 그대로 base 에 돌리면 당연히 통과해 **`does-not-distinguish` 라는
        //   거짓 증거**가 난다 — *"이 테스트가 아무것도 안 가른다"* 가 아니라 ***"자식이 테스트를
        //   안 썼다"*** 인데 말이다. ⇒ 사유를 갈라 남긴다.
        //   ⚠️ 2R 에서 이 분기를 **집합 차로 판정**했다가 도달 불가라 지웠는데, **조건이 틀렸던 것**이다.
        verifyByBreakingNote = `\n\nVerify-by-breaking: skipped; reason=no-edited-tests; scope=${scope.reason}; derived=${scope.testArgs?.length ?? 0}`;
        debug.log('self-implement', 'gate.verify-by-breaking', {
          skipped: true, reason: 'no-edited-tests', scope: scope.reason,
          derived: scope.testArgs?.length ?? 0, ...verifyIdentity, ...emptyVerifyCounts,
        }, { level: 'warn' });
      } else if (gatePassed && testStep?.ok && !testStep.skipped) {
        // ⭐ **불변식**(`gate-scope.test.ts` 가 고정한다): `editedTests` 는 여기서 **절대 비지 않는다**.
        //   `changed-tests` 분기에선 `testFiles` 가 `testArgs` 에 들어가고 `pulledInRelatedTests` 에는
        //   **정의상 안 들어가며**, `derived` 분기에선 `pulledInRelatedTests` 가 **빈 배열**이다.
        //   ⇒ *"편집한 테스트 0개"* 스킵 분기를 두지 않는다 — **도달 불가한 분기는 죽은 표면**이고,
        //     그것을 검사하는 테스트는 아무것도 증명하지 못한다(리뷰 2R 이 그 Goodhart 를 잡았다).
        const editedTests = scope.testArgs!.filter((file) => !scope.pulledInRelatedTests.includes(file));
        const verify = (o.runVerifyByBreaking ?? runVerifyByBreaking)(cwd, editedTests, baselineRefs.get(cwd));
        // ⛔⭐⭐⭐ **조건은 테스트 전용 변경이나 특정 정방향 분류가 아니라, 편집 테스트의 네 정방향 분류 전체다.**
        //   (리뷰 R3 must-fix — 내가 PR 경계에 *"혼합 변경에서는 조건상 안 돈다"* 고 «틀리게» 적었다).
        //   ⇒ 소스와 테스트가 «함께» 바뀐 PR 에서도 그 분류가 나오면 «돈다». 그리고 그게 맞다:
        //     그 경우 「옛 테스트 × 현 소스」는 ***소스 변경이 옛 계약을 깼는지***를 답하므로 정보가 있다.
        //   ⛔ 안 주장하는 것: 혼합 변경에서 이 대조가 «무엇을 주로 내는지»는 미측정이다(분포를 안 쟀다).
        // ⛔⭐⭐⭐ 「바뀐 소스」의 «정의»(리뷰 R9 must-fix — 종전엔 `.test/.spec` «만» 뺐다):
        //   ***픽스처·스냅샷은 「소스」가 아니라 「테스트 자산」이다.*** 그것을 현재 판으로 얹으면
        //   재는 것이 「옛 테스트 × 현 소스」가 아니라 ***「옛 테스트 × «현» 테스트 자산 × 현 소스」***가
        //   되고, ⛔ 이 대조가 «겨냥한» 픽스처 수리에서 판정이 무의미해진다.
        //   ⇒ 판정 가능한 규칙 하나로 못 박는다(⛔ 「적절히」 금지):
        //     ⓐ `.test`/`.spec` 확장자이거나
        //     ⓑ 경로 «세그먼트»가 test · tests · __tests__ · __snapshots__ · fixtures 중 하나면
        //     그 파일은 «테스트 자산»이고 얹지 않는다.
        //   📏 실측: 이 저장소에 그런 경로가 있다 — `test/fixtures/…` ⊕ ⭐ `src/autopilot/build/fixtures/…`
        //     (`src/` 아래에도 있으므로 「test/ 로 시작하나」만으로는 못 가른다).
        //   ⭐ 테스트 전용 변경이면 이 목록이 «빈 목록»이고, 그때는 base 소스가 곧 현 소스라
        //     판정이 그대로 성립한다(그 경우가 이 대조를 만든 이유다).
        const changedNonTestFiles = changedAll.filter((f) => !isTestAssetPath(f));
        const reverseFiles = verify.files.map((entry) => entry.file);
        const reverse = reverseFiles.length > 0
          // ⛔⭐⭐ 격리 워크트리(base ref)에 «바뀐 소스»를 얹어 base 판 테스트를 그 안에서 돌린다.
          //   ⇒ 넘기는 것은 「편집 테스트」 ⊕ 「바뀐 소스(테스트 제외)」다(리뷰 R4 설계 정정).
          ? (o.runReverseVerifyByBreaking ?? runReverseVerifyByBreaking)(cwd, reverseFiles, changedNonTestFiles, baselineRefs.get(cwd))
          : undefined;
        verifyByBreakingNote = `\n\n${formatVerifyByBreakingNote(verify, reverse)}`;
        // ⛔⭐ 오염 차단이 «없어졌다» — 격리 워크트리에서 돌아 작업 트리를 안 건드리므로,
        //   R1·R2 가 만들게 한 `restoreFailed` 게이트 차단이 «필요 없다»(리뷰 R4 설계 정정으로 제거).
        const classifications = verify.files.reduce<Record<'distinguishes' | 'doesNotDistinguish' | 'unknown' | 'missingAtBase', number>>((counts, entry) => {
          const key = entry.classification === 'does-not-distinguish'
            ? 'doesNotDistinguish'
            : entry.classification === 'missing-at-base'
              ? 'missingAtBase'
              : entry.classification;
          return { ...counts, [key]: counts[key] + 1 };
        }, { distinguishes: 0, doesNotDistinguish: 0, unknown: 0, missingAtBase: 0 });
        verifyByBreaking = {
          ran: true,
          distinguishes: classifications.distinguishes,
          'does-not-distinguish': classifications.doesNotDistinguish,
          unknown: classifications.unknown,
          missingAtBase: classifications.missingAtBase,
          ...(reverseFiles.length > 0
            ? { files: verify.files.map(({ file, classification }) => ({ file, classification })) }
            : {}),
        };
        debug.log('self-implement', 'gate.verify-by-breaking', {
          skipped: false,
          ...verifyIdentity,
          ...classifications,
          baseStatuses: verify.baseStatuses,
          unknownReasons: countUnknownReasons(verify.files),
          reverse: reverse
            ? { status: reverse.ran ? 'ran' : 'not-run', headStatuses: reverse.headStatuses, files: reverse.files.map((entry) => ({ file: entry.file, head: entry.head.status })) }
            : { status: 'not-requested' },
          tested: verify.files.length,
          // ⛔⭐ 역방향 `unknown` 도 심각도에 «반영»한다(리뷰 R7 should-fix) — forward 만 보면
          //   ***역방향 관측 실패가 `info` 로 축소돼 아무도 안 본다***(관측이 스스로 조용해지는 형태).
        }, { level: (verify.baseStatuses.unknown > 0 || (reverse?.headStatuses.unknown ?? 0) > 0) ? 'warn' : 'info' });
      } else {
        // ⛔⭐ **조용한 스킵 0**(리뷰 2R) — 음성 대조를 실행하지 않은 이유를 원문으로 남긴다.
        const why = gatePassed
          ? !testStep ? 'no-test-step' : testStep.skipped ? 'test-step-skipped' : 'test-step-not-ok'
          : 'gate-not-passed';
        if (gatePassed) {
          verifyByBreaking = { ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: why };
          verifyByBreakingNote = `\n\n${formatVerifyByBreakingSkipNote(why, baselineReport)}`;
        }
        debug.log('self-implement', 'gate.verify-by-breaking', {
          skipped: true, reason: why, testStep: why, ...verifyIdentity, ...emptyVerifyCounts,
        }, { level: 'warn' });
      }
      // ⭐ 거짓통과 방지 표기(제1원칙 관측 · 2026-07-26) — test 스텝을 건너뛰면 `passed:true` 가
      //   **"검증됨"으로 오독**될 수 있다. 그건 integrity-gate 의 `ranNothing` 가드가 막으려던
      //   거짓통과를 스코프 축소가 우회로 되살리는 것이다 ⇒ 게이트 로그에 **명시**한다.
      //
      // ⚠️⚠️ **범위 정직 표기(리뷰 must-fix 2026-07-26)** — 초안 주석은 이것을 "셀프힐링 배선"이라
      //   불렀는데 **과장이었다.** 실측: `orchestrator.ts:415` 는 **`!gate.passed` 일 때만**
      //   `gate.log` 를 rework 노트로 읽는다. 스킵은 보통 **통과**로 끝나므로 이 문구는 그 경로에서
      //   **자식에게 되먹임되지 않는다.** 지금 닿는 곳은:
      //     ✅ `gate.scope` warn 로그(`elanous logs --category self-implement`) — 사람·회고
      //     ✅ 다른 이유로 게이트가 실패한 라운드의 rework 노트
      //     ❌ **통과 라운드의 자식** — 미배선(자기인지까지이고 힐링은 아니다)
      //   ⇒ 이 세션 관통 발견("관측은 두껍고 판단·개입은 얇다")이 **내 수정에서도 재현**됐다.
      //   되먹임 배선(리뷰 컨텍스트 주입 등)은 이 PR 범위를 넘으므로 **별건**으로 남긴다 —
      //   숨기지 않고 갭으로 명명하는 것이 제1원칙에 맞다.
      // ⭐ 테스트가 **돌았어도** 커버 안 된 비문서 변경이 있으면 알린다(리뷰 must-fix) — 종전엔
      //   skip 일 때만 note 가 나가 `derived`/`changed-tests` 에서 config 위험이 은폐됐다.
      const uncoveredNote = !testStepSkipped && scope.unverified.length > 0
        ? `\n\n[gate-scope] ${scope.reason} — 테스트는 돌았으나 **다음 변경은 커버되지 않았다**: `
          + `${scope.unverified.slice(0, 8).join(', ')}`
          + `\n⚠️ "게이트 통과=전부 검증됨"으로 결론내지 말 것.`
        : '';
      const pulledInRelatedTestsNote = !testStepSkipped && scope.pulledInRelatedTests.length > 0
        ? `\n\n[gate-scope] ${scope.reason} — 편집되지 않았으나 함께 실행한 연관 테스트: `
          + `${scope.pulledInRelatedTests.slice(0, 8).join(', ')}`
          + `\n(편집된 테스트만 돌렸다면 이것들이 빠졌다)`
        : '';
      const scopeNote = testStepSkipped
        ? `\n\n[gate-scope] ${scope.reason} — test 스텝을 건너뛰었다(변경파일 tsc 만 검증). `
          + (scope.reason === 'no-related-tests'
            // ⭐ **미검증 파일 목록**(2026-07-27 사후 리뷰 수리) — 종전엔 `sourceFiles` 를 실어
            //   `package.json`·설정·스크립트 변경 시 **빈 목록**이 나갔다(그 파일들은 소스 확장자가 아니다).
            ? `동작 검증을 못 한 변경: ${scope.unverified.slice(0, 8).join(', ')}`
              + `\n⚠️ 이 라운드는 **동작 검증이 되지 않았다**(변경파일 tsc 만 통과) — "게이트 통과=검증됨"으로 결론내지 말 것.`
              // ⚠️ 안내를 일반화(리뷰 should-fix) — `package.json`·lockfile·설정·스크립트에는
              //   "해당 소스의 테스트"라는 표현이 부정확하다(그 변경엔 대응 테스트 관례가 없다).
              + ` **해당 변경을 검증할 테스트/타깃**을 추가하면 다음 라운드에서 실제로 검증된다`
              + `(소스라면 co-located \`<src>.test.ts\` 또는 \`test/<경로-평탄화>.test.ts\`).`
            : scope.reason === 'unmeasured'
              ? '정합 후 재게이트 실행 범위가 비어 측정하지 못했다. 「깨끗하다」가 아니라 「못 쟀다」.'
            : scope.reason === 'no-changes'
              ? '이 스코프가 관측한 변경이 없어 동작 테스트 대상이 없다.'
              // ⚠️ 설정 변경은 이제 이 분기로 오지 않는다(#5500 docs-only allowlist) → "문서만".
              : '문서만 변경돼 동작 테스트 대상이 없다(정상).')
        : '';
      const baseLog = tc.passed ? r.log : `${r.log}\n\n${tc.log}`;
      return {
        passed: gatePassed,
        log: `${baseLog}${comparisonFailureLog}${baselineNote}${verifyByBreakingNote}${scopeNote}${uncoveredNote}${pulledInRelatedTestsNote}`,
        testStepExecuted: !testStepSkipped && testStep !== undefined && !testStep.skipped,
        scopeReason,
        comparisonBaseStatus: observationChanges.comparisonBaseStatus,
        measuredFileCount: changedAll.length,
        comparisonBase,
        unverified: scope.unverified,
        documentPaths: scope.documentPaths,
        documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests,
        missingTestFiles: scope.missingTestFiles,
        importerTestsNotRun: scope.importerTestsNotRun,
        testDeclarationDecline: declarationDecline,
        ...(verifyByBreaking ? { verifyByBreaking } : {}),
        ...(baselineFailures ? { baselineFailures } : {}),
        ...(reflectGateFacts ? { reflectGateFacts } : {}),
      };
    },

    findAppliedReviewItems: async (branch: string, goalId?: string) => {
      if (goalId) {
        try {
          const store = new GoalRunStore();
          try {
            const items = store.latestByGoalId(goalId)?.record.lastReviewFindings?.items ?? [];
            if (items.length) return { basePrLocated: false, items: items.slice(0, 12), headlineComments: 0, source: 'ledger' as const };
          } finally {
            store.close();
          }
        } catch { /* The PR path remains the fail-soft fallback when the ledger is unavailable. */ }
      }
      const fallback = fetchAppliedReviewItemsForBranch(branch.replace(/^origin\//, ''));
      return { ...fallback, source: fallback.basePrLocated ? 'pr-comment' as const : 'unavailable' as const };
    },

    // ⛔⭐ **선언만 되고 생산 번들에 안 얹혀 있었다**(`OBS-S10`). 오케스트레이터가
    //   `if (s.reviewScopeDiff)` 로 가드하는데 이 키가 없어 **가드가 영영 거짓**이었고,
    //   그래서 `diffEvidenceStatus` 가 오늘 런 **9/9 `unavailable`** 이었다.
    //   ⇒ 증거 출처가 둘(자식 전사 ⊕ diff)로 설계됐는데 **실제로는 하나**였고,
    //     `reports/` 처럼 **diff 에만 있는 증거는 구조적으로 안 보였다**.
    reviewScopeDiff: (cwd: string, prBase?: string, runId?: string, baseOrigin?: 'resolved-base' | 'default-origin-main') => (o.reviewScopeDiff ?? reviewScopeDiff)(cwd, prBase, runId, baseOrigin),

    // A separate Bun process checks the persisted candidate; it never imports the writer/parser module.
    independentlyCheckGoalSlots: async (document, evidence) => {
      const root = mkdtempSync(join(tmpdir(), 'supervisor-goal-slot-check-'));
      const candidatePath = join(root, 'candidate.goal');
      writeFileSync(candidatePath, document);
      // 원천(게이트 로그)을 같이 넘긴다 — 검사기가 **직접** 읽어야 독립이다.
      writeFileSync(join(root, 'gate.log'), evidence.gateLog ?? '');
      // ⛔⭐ **템플릿을 대조하지 않는다.** 종전 판은 writer 가 만든 문자열이 문서에 있는지만 봤다 —
      //   같은 손이 쓴 것을 같은 기대값으로 다시 읽는 것이라 **독립이 아니다**(리뷰 must-fix: Goodhart).
      // ⇒ 이 프로세스는 **게이트 로그를 스스로 다시 파싱**해서, 문서가 주장하는 수치가 로그와 맞는지 본다.
      //   writer 와 **다른 파서**가 **같은 원천**을 읽고 일치를 요구하는 것이 독립이다.
      const checker = [
        "const fs = require('fs'); const d = fs.readFileSync('candidate.goal', 'utf8'); const e = JSON.parse(fs.readFileSync('evidence.json', 'utf8'));",
        "const log = fs.readFileSync('gate.log', 'utf8');",
        "const body = (h) => { const i = d.indexOf(h); if (i < 0) return ''; const s = i + h.length; const n = d.indexOf('\\n## ', s); return d.slice(s, n < 0 ? d.length : n); };",
        // 로그를 **독립적으로** 재파싱한다 — writer 의 정규식과 별개다.
        "const testLine = log.split('\\n').find((l) => l.indexOf('[test] PASS') === 0);",
        "if (!testLine) process.exit(1);",
        "const m = testLine.match(/(\\d+)\\s+fail/); if (!m) process.exit(1);",
        "const failFromLog = Number(m[1]); if (failFromLog !== 0) process.exit(1);",
        "if (log.indexOf('[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0') < 0) process.exit(1);",
        // 문서가 적은 관측값이 **로그에서 읽은 값과 같아야** 한다.
        "const sections = [body('## 불변식'), body('## 판정 신호')];",
        "if (sections.some((p) => p.indexOf('UNVERIFIABLE') >= 0)) process.exit(1);",
        "if (sections.some((p) => p.indexOf('filled-by: supervisor@round-' + e.round) < 0)) process.exit(1);",
                // ⛔ writer 가 넘긴 command 를 믿지 않는다 — **로그에서 직접** 뽑아 문서와 대조한다(리뷰 must-fix).
        "const cm = testLine.match(/^\\[test\\]\\s+PASS\\s+(.+?)\\s*(?:—|$)/); if (!cm) process.exit(1);",
        "const cmdFromLog = cm[1].trim();",
        "if (sections.some((p) => p.indexOf(cmdFromLog) < 0)) process.exit(1);",
        // 문서가 baseline 문면도 담고 있어야 한다 — 근거가 문서 안에서 재검증 가능해야 한다.
                // ⛔ 부분 문자열이 아니라 **로그의 baseline 줄 전체**와 대조한다 — `preexisting=9` 같은
        //   불일치가 통과하면 근거가 근거가 아니다(리뷰 must-fix).
        "const bl = log.split('\\n').find((l) => l.indexOf('[gate-baseline]') === 0); if (!bl) process.exit(1);",
        "if (body('## 불변식').indexOf(bl.trim()) < 0) process.exit(1);",
        // ② 조건 줄의 명령을 **그 필드에서** 파싱해 대조한다 — 절 어딘가에 있으면 통과하던 것을 막는다.
        "const condLine = body('## 불변식').split('\\n').find((l) => l.indexOf('조건 —') >= 0); if (!condLine) process.exit(1);",
        "if (condLine.indexOf(cmdFromLog) < 0) process.exit(1);",
        // ⭐ 핵심 — 문서의 관측값이 로그의 값과 다르면 거부한다.
        "if (String(e.observedFail) !== String(failFromLog)) process.exit(1);",
        "if (body('## 판정 신호').indexOf('fail ' + failFromLog) < 0) process.exit(1);",
        // ⛔ 불변식 쪽 관측값도 대조한다 — 한쪽만 보면 다른 쪽에 거짓 수치가 들어간다(리뷰 must-fix).
        "if (body('## 불변식').indexOf('관측됨 — fail ' + failFromLog) < 0) process.exit(1);",
        // 문서 어디에도 로그와 **다른** fail 수치가 있으면 안 된다(정규식은 런타임에 만든다).
        "const other = new RegExp('fail (?!' + failFromLog + '\\\\b)\\\\d+');",
        "if (other.test(body('## 불변식') + body('## 판정 신호'))) process.exit(1);",
        "process.exit(0);",
      ].join(' ');
      try {
        // ⛔⭐ **증거를 셸 문자열로 보간하지 않는다.** 종전 판은 `evidence` 를 argv 에 끼워 넣었는데
        //   그 안에 게이트 로그가 통째로 들어 있어 `$(...)`·백틱이 **셸에서 실행**될 수 있었다(리뷰 must-fix).
        //   ⇒ 파일로 넘기고 검사기가 읽는다. 명령 문자열에는 **고정 리터럴만** 남는다.
        writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence));
        const rule = withIndependentChecker({ kind: 'and', rules: [] }, {
          command: `bun -e ${JSON.stringify(checker)}`,
          timeoutMs: 5_000,
        });
        const outcome = await evaluateTermination(rule, { vault: {} as never, budget: {} as never, goalRoot: root });
        return outcome.shouldTerminate;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },

    preservationHasChanges: ({ cwd, base }) => preservationHasChanges(cwd, base),

    goalDocumentPathByGoalId: (goalId) => {
      let store: GoalRunStore | undefined;
      try {
        store = new GoalRunStore();
        return store.query({ goalId, limit: 0 })?.goalDocumentPath ?? undefined;
      } catch {
        return undefined;
      } finally {
        store?.close();
      }
    },

    readReworkSalvageEvidence: async (cwd) => readReworkSalvageEvidence(cwd),
    // ⛔ await 한다 — spawn 실패를 삼키면 발사 실패도 `salvage:'launched'` 로 거짓 관측된다(3차 M4).
    launchReworkSalvage: async (input) => { await launchReworkSalvage(input); },

    openPr: async ({ title, body, head, base, draft, labels, cwd }) => {
      const resolvedBase = assertBaseBranchOnOrigin(cwd, base);
      const outcome = (o.prManager ?? makePrManager()).upsertPr({
        branch: head,
        worktreePath: cwd,
        title,
        body: buildPrBody(cwd, body),
        commitMessage: title,
        ...(resolvedBase ? { base: resolvedBase } : {}),
        ...(draft !== undefined ? { draft } : {}),
        ...(labels?.length ? { labels } : {}),
      });
      if (!outcome.ok) throw new Error(`self-implement PR ${outcome.reason} 실패: ${outcome.detail}`);
      const number = Number.parseInt(outcome.url.match(/\/pull\/(\d+)/)?.[1] ?? '', 10);
      return { url: outcome.url, number: Number.isFinite(number) ? number : 0 };
    },

    // 재발명 0 — PrManager.closePr 시그니처·동작을 그대로 위임한다(mission-lifecycle 이 이미 쓴다).
    closePr: (prUrl, comment) => (o.prManager ?? makePrManager()).closePr(prUrl, comment),

    postPrComment: async ({ number, body, cwd }) => {
      await execFileAsync('gh', ['pr', 'comment', String(number), '--body', body], {
        cwd, encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024,
      });
    },

    ...(o.approvePr ? { approvePr: o.approvePr } : {}),

    // ★ 내부 리뷰(2026-07-21·review-gated merge) — worktree diff → reviewPullRequest(agent-substrate·미션/
    //   하니스/CLI 와 동일 리뷰 엔진) → SelfImplementReview 매핑. **reviewed** 로 실제 리뷰 여부 전달(auto-merge
    //   안전 불변식: fail-soft pass 엔 자동병합 금지). llmReview 미주입 시 미노출(리뷰 스킵). 관측=review.done.
    ...(o.llmReview ? {
      // ⭐ ctx 타입은 `ReviewDiffContext` **한 곳에서만** 선언된다 — 종전엔 여기서 같은 모양을 다시 적었고
      //    그래서 `diffOutsideClaims[].result`(*"깨뜨려서 검증"* 의 출력을 나르는 셋째 칸)가 **한쪽에서만
      //    빠져도 컴파일이 통과**했다(런타임은 흐르는데 타입이 모르는 상태).
      reviewDiff: async (cwd: string, ctx?: ReviewDiffContext) => {
        const diff = await (o.reviewScopeDiff ?? reviewScopeDiff)(cwd, 'origin/main', ctx?.runId);   // ★ JDG-T2 — 미커밋분만이 아니라 PR 이 담을 전부
        if (diff === REVIEW_SCOPE_UNMEASURABLE) {
          debug.log('self-implement', 'review.done', {
            verdict: 'fail', reviewed: false, reason: 'unmeasurable-scope',
            ...(ctx?.round !== undefined ? { round: ctx.round } : {}),
          });
          return {
            verdict: 'fail' as const, mustFix: [], shouldFix: [], summary: '(리뷰 범위를 못 쟀다)', reviewed: false,
            failureReason: 'unmeasurable-scope',
            ...(o.reviewerCanSelfRead !== undefined ? { canSelfRead: o.reviewerCanSelfRead } : {}),
          };
        }
        if (!diff.trim()) {
          debug.log('self-implement', 'review.done', {
            verdict: 'pass', reviewed: false, reason: 'no-diff',
            ...(ctx?.round !== undefined ? { round: ctx.round } : {}),
          });
          return {
            verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: '(변경 없음)', reviewed: false,
            failureReason: 'no-diff',
            ...(o.reviewerCanSelfRead !== undefined ? { canSelfRead: o.reviewerCanSelfRead } : {}),
          };
        }
        const intentInput = toReviewIntentInput(ctx);
        const phaseIntent = intentInput ? buildReviewIntent(intentInput) : 'self-implement 변경 리뷰';
        const evidenceNote = [
          ctx?.gateEvidenceNote,
          ...(ctx?.goalDocumentPath ? [`Harness-authored goal document path (not child-authored): ${ctx.goalDocumentPath}`] : []),
        ].filter((note): note is string => Boolean(note?.trim())).join('\n') || undefined;
        const goal = ctx?.goal?.trim();
        const acceptance = goal
          ? splitGoalSections(supervisorGoalDigest(goal, 3000).text)
            .find((section) => isSupervisorDecisionSection(section.title) && section.title.includes('판정 신호'))
            ?.body.trim()
          : undefined;
        const rr = await reviewPullRequest({
          prDiff: diff,
          phaseIntent,
          ...(acceptance ? { acceptance } : {}),
          ...(evidenceNote ? { evidenceNote } : {}),
          ...(o.reviewerContext?.length ? { reviewerContext: o.reviewerContext } : {}),
          ...(ctx?.runId !== undefined || ctx?.round !== undefined ? {
            reviewContext: {
              ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
              ...(ctx.round !== undefined ? { round: ctx.round } : {}),
            },
          } : {}),
        }, o.llmReview!);
        debug.log('self-implement', 'review.done', {
          verdict: rr.verdict, reviewed: rr.reviewed ?? false, mustFix: rr.mustFix.length, shouldFix: rr.shouldFix.length,
          gateEvidenceLines: evidenceNote?.split(/\r?\n/).length ?? 0,
          reviewerContextLoaded: o.reviewerContext?.length ?? 0,
          goalLoaded: Boolean(goal),
          acceptanceChars: acceptance?.length ?? 0,
          ...(ctx?.round !== undefined ? { round: ctx.round } : {}),
          // ⛔⭐ `reviewed=false` 의 «왜»는 여기서만 남는다 — 빠뜨리면 화면의 「리뷰 미실행」에
          //   괄호가 «영영» 안 붙고(orchestrator.ts 가 `review.failureReason` 을 기다린다),
          //   사람은 재발사만 보며 원인을 못 찾는다. 📏 실측 대가: PR 5개·이틀·재발사 3회(OBS-T366).
          ...(rr.failureReason !== undefined ? { failureReason: rr.failureReason } : {}),
          ...reviewDiffBudgetObservation(rr),
        });
        return {
          verdict: rr.verdict,
          mustFix: rr.mustFix,
          shouldFix: rr.shouldFix,
          summary: renderReview(rr).slice(0, 2000),
          reviewed: rr.reviewed ?? false,
          // ⛔⭐ 이 한 줄이 `orchestrator.ts` 의 「찍는 줄」에 값을 «흘린다». 빼면 그 줄은 살아 있는데 값이 안 온다.
          ...(rr.failureReason !== undefined ? { failureReason: rr.failureReason } : {}),
          ...reviewDiffBudgetObservation(rr),
          ...(rr.contextBudget ? {
            contextItemCount: rr.contextBudget.itemCount,
            contextShownChars: rr.contextBudget.shownChars,
            contextTotalChars: rr.contextBudget.totalChars,
            contextTruncated: rr.contextBudget.truncated,
            contextFullyIncludedItems: rr.contextBudget.fullyIncludedItems,
            contextTruncatedItems: rr.contextBudget.truncatedItems,
            contextOmittedItems: rr.contextBudget.omittedItems,
          } : {}),
          ...(o.reviewerCanSelfRead !== undefined ? { canSelfRead: o.reviewerCanSelfRead } : {}),
        };
      },
      // ★ 진단 합성 seam(#1·2026-07-22 대표 PLAN) — 재투입 전 raw 실패/리뷰 지적을 "왜 실패했나(근본)+어떻게
      //   고칠지(방향)"로 1스텝 진단. 사람이 하던 외부 진단을 내부화 → fixing agent 가 raw 재시도 아닌 근본
      //   소화(C1 Bug2 "replace it with" 자기모순류를 스스로 진단). llmReview(동일 LLM 래퍼) 재사용·fail-soft.
      judgmentCallLLM: async ({ prompt }) => o.llmReview!(prompt),
      classifyCallLLM: async ({ prompt }) => o.llmReview!(prompt),
      diagnose: async ({ runId, note, kind, round, goal, history, supervisorDecisionHistory = [], judgePredictionAccuracy: predictionAccuracy, effectiveMax, priorRuns, reviewFindingTelemetry, refutations = [], refutationRound, purpose = 'budget' }: DefaultSeamsDiagnoseInput): Promise<string> => {
        const goalDigest = supervisorGoalDigest(goal, 3000);
        const predictionAccuracyForPrompt = predictionAccuracy
          ?? (supervisorDecisionHistory.length ? judgePredictionAccuracy(supervisorDecisionHistory) : undefined);
        const supervisorDecisionHistoryPromptBudgetChars = 3000;
        const normalizedSupervisorDecisionHistory = supervisorDecisionHistory
          .filter((decision) => Number.isInteger(decision.round) && decision.round > 0 && typeof decision.verdict === 'string')
          .map((decision) => ({
            round: decision.round,
            verdict: decision.verdict,
            reason: String(decision.reason ?? '').replace(/\s+/g, ' ').trim(),
          }));
        type SupervisorDecisionHistoryItem = typeof normalizedSupervisorDecisionHistory[number] & { reasonTruncated: boolean };
        const renderSupervisorDecisionHistory = (items: readonly SupervisorDecisionHistoryItem[], truncated: boolean) => {
          const truncatedReasons = items.filter((decision) => decision.reasonTruncated).length;
          // ⭐⭐ 「내 지난 예측이 맞았나」를 «같이» 준다(🅣 관측 2026-08-20 · 대표 이 이 축을 맡겼다).
          //   ⛔ 종전엔 이력이 「라운드·판정·사유」 셋뿐이라 ***판사가 자기 낙관이 «틀렸다»는 사실을 못 봤다***
          //     — 한 런에서 EXTEND 를 네 번 내고 사유가 전부 "한 라운드 안에 해결 가능하다"였다.
          //   ⛔ 막지 «않는다» — 사실 한 줄일 뿐이고 판정 규칙은 그대로다.
          //   ⛔ 예측 결과가 하나도 «확정 안 됐으면» 줄을 안 낸다(0/0 을 신호로 읽지 않게).
          const predictionLine = predictionAccuracyForPrompt
            ? renderJudgePredictionAccuracy(predictionAccuracyForPrompt)
            : undefined;
          // ⭐⭐ 🅕 발견 ①·② — 판사가 «자기가 쓰는 수»와 «추세»를 보게 한다.
          //   📏 실물: EXTEND 사유에 "반복이 아니라"라 쓰면서 같은 봉투에 반복 1·2 를 싣고 있었다.
          //   ⛔ 임계를 박지 않는다 — 두 값을 «보여 주고» 판사가 쓰게 한다(🅕 제안 그대로).
          const ownSignalsLine = renderJudgeOwnSignals({
            ...(typeof reviewFindingTelemetry?.symbolKeyedReviewFindingCount === 'number'
              ? { citedReviewSymbolRepeatCount: reviewFindingTelemetry.citedReviewSymbolOccurrences.filter((o) => o.occurrence > 1).length }
              : {}),
            mustFixTrend: mustFixTrendFromHistory(history),
          });
          return [
            '감독 자기판정 이력(이전 라운드의 결과와 사유; 판정 규칙은 그대로 적용):',
            ...(predictionLine ? [predictionLine] : []),
            ...(ownSignalsLine ? [ownSignalsLine] : []),
            ...(items.length ? items.map((decision) => `[라운드 ${decision.round}] BUDGET: ${decision.verdict}\nREASON: ${decision.reason}`) : ['(이전 감독 판정 없음)']),
            ...(truncated ? [`감독 자기판정 이력 프롬프트 예산 절단: ${normalizedSupervisorDecisionHistory.length}/${items.length}`] : []),
            ...(truncatedReasons ? [`감독 자기판정 이력 사유 길이 절단: ${truncatedReasons}`] : []),
          ].join('\n');
        };
        const includedSupervisorDecisions: SupervisorDecisionHistoryItem[] = [];
        for (const decision of [...normalizedSupervisorDecisionHistory].reverse()) {
          const reasonTruncated = decision.reason.length > 1200;
          const normalized = { ...decision, reason: decision.reason.slice(0, 1200), reasonTruncated };
          const candidate = [...includedSupervisorDecisions, normalized];
          const candidateTruncated = candidate.length < normalizedSupervisorDecisionHistory.length || candidate.some((item) => item.reasonTruncated);
          while (renderSupervisorDecisionHistory(candidate, candidateTruncated).length > supervisorDecisionHistoryPromptBudgetChars && normalized.reason.length > 0) {
            const overflow = renderSupervisorDecisionHistory(candidate, candidateTruncated).length - supervisorDecisionHistoryPromptBudgetChars;
            normalized.reason = normalized.reason.slice(0, Math.max(0, normalized.reason.length - overflow));
            normalized.reasonTruncated = true;
          }
          if (renderSupervisorDecisionHistory(candidate, candidateTruncated).length > supervisorDecisionHistoryPromptBudgetChars) break;
          includedSupervisorDecisions.push(normalized);
        }
        const supervisorDecisionHistoryPromptReasonTruncatedItems = includedSupervisorDecisions.filter((decision) => decision.reasonTruncated).length;
        const supervisorDecisionHistoryPromptTruncated = includedSupervisorDecisions.length < normalizedSupervisorDecisionHistory.length || supervisorDecisionHistoryPromptReasonTruncatedItems > 0;
        const supervisorDecisionHistorySection = renderSupervisorDecisionHistory(includedSupervisorDecisions, supervisorDecisionHistoryPromptTruncated);
        const refutationPromptBudgetChars = 3000;
        const normalizeRefutation = (refutation: MustFixRefutation): MustFixRefutation => ({
          ...refutation,
          findingId: refutation.findingId.slice(0, 128),
          finding: refutation.finding.slice(0, 500),
          quote: refutation.quote.slice(0, 1000),
          reason: refutation.reason.replace(/\s+/g, ' ').trim().slice(0, 500),
        });
        const renderRefutationSection = (items: readonly MustFixRefutation[], truncated: boolean) => `자식 REFUTE 제출(라운드 ${refutationRound ?? round - 1}; 아래 현장 불일치를 재판정에 사용):\n${items.map((refutation, index) => `${index + 1}. [${refutation.kind}] findingId=${refutation.findingId}\nmust-fix 원문: ${refutation.finding}\n인용: ${refutation.quote}\n근거: ${refutation.reason}`).join('\n')}${truncated ? `\nREFUTE 제출 프롬프트 예산 절단: ${refutations.length}/${items.length}` : ''}`;
        const includedRefutations: MustFixRefutation[] = [];
        let refutationsTruncated = false;
        for (const refutation of refutations) {
          const normalized = normalizeRefutation(refutation);
          const candidate = [...includedRefutations, normalized];
          if (renderRefutationSection(candidate, candidate.length < refutations.length).length <= refutationPromptBudgetChars) {
            includedRefutations.push(normalized);
            continue;
          }
          const partial = { ...normalized };
          while (renderRefutationSection([...includedRefutations, partial], true).length > refutationPromptBudgetChars) {
            const field = (['reason', 'quote', 'finding'] as const).find((name) => partial[name].length > 0);
            if (!field) break;
            const overflow = renderRefutationSection([...includedRefutations, partial], true).length - refutationPromptBudgetChars;
            partial[field] = partial[field].slice(0, Math.max(0, partial[field].length - overflow));
          }
          if (renderRefutationSection([...includedRefutations, partial], true).length <= refutationPromptBudgetChars) includedRefutations.push(partial);
          refutationsTruncated = true;
          break;
        }
        refutationsTruncated ||= includedRefutations.length < refutations.length;
        const refutationSection = includedRefutations.length
          ? renderRefutationSection(includedRefutations, refutationsTruncated)
          : '';
        const reviewFindingTelemetryPromptBudgetChars = 3000;
        let reviewFindingTelemetryPromptOriginalCitedItems = 0;
        let reviewFindingTelemetryPromptIncludedCitedItems = 0;
        let reviewFindingTelemetryPromptIncludedRepeatedCitedItems: number | undefined;
        let reviewFindingTelemetryPromptOriginalRepeatItems = 0;
        let reviewFindingTelemetryPromptIncludedRepeatItems = 0;
        let reviewFindingTelemetryPromptOriginalPriorRunItems = priorRuns?.total ?? 0;
        let reviewFindingTelemetryPromptIncludedPriorRunItems = 0;
        let reviewFindingTelemetryPromptTruncated = false;
        let machineCountedReviewEvidence: string;
        try {
          const cited = reviewFindingTelemetry?.citedReviewSymbolOccurrences ?? [];
          const repeats = reviewFindingTelemetry?.normalizedReviewFindingRepeatCounts ?? [];
          reviewFindingTelemetryPromptOriginalCitedItems = cited.length;
          reviewFindingTelemetryPromptOriginalRepeatItems = repeats.length;
          const includedCited: (typeof cited)[number][] = [];
          const includedRepeats: (typeof repeats)[number][] = [];
          const includedPriorRuns: GoalPriorRuns['priorRuns'] = [];
          const renderEvidence = () => JSON.stringify({
            priorRuns: priorRuns == null ? null : { priorRuns: includedPriorRuns, total: priorRuns.total, truncated: priorRuns.truncated },
            reviewFindingTelemetry: reviewFindingTelemetry === undefined ? undefined : {
              ...reviewFindingTelemetry,
              citedReviewSymbolOccurrences: includedCited,
              normalizedReviewFindingRepeatCounts: includedRepeats,
            },
          });
          const truncationMarker = () => `기계 집계 근거 프롬프트 예산 절단: priorRuns ${reviewFindingTelemetryPromptOriginalPriorRunItems}/${includedPriorRuns.length}, repeat ${repeats.length}/${includedRepeats.length}, cited ${cited.length}/${includedCited.length}`;
          const includeWithinBudget = <T>(items: readonly T[], included: T[]) => {
            for (const item of items) {
              included.push(item);
              if (`${renderEvidence()}\n${truncationMarker()}`.length > reviewFindingTelemetryPromptBudgetChars) {
                included.pop();
                break;
              }
            }
          };
          includeWithinBudget(repeats, includedRepeats);
          includeWithinBudget(priorRuns?.priorRuns ?? [], includedPriorRuns);
          includeWithinBudget(cited, includedCited);
          reviewFindingTelemetryPromptIncludedCitedItems = includedCited.length;
          reviewFindingTelemetryPromptIncludedRepeatedCitedItems = includedCited.length > 0
            ? includedCited.filter(({ occurrence }) => occurrence > 0).length
            : undefined;
          reviewFindingTelemetryPromptIncludedRepeatItems = includedRepeats.length;
          reviewFindingTelemetryPromptIncludedPriorRunItems = includedPriorRuns.length;
          reviewFindingTelemetryPromptTruncated = includedCited.length < cited.length || includedRepeats.length < repeats.length || includedPriorRuns.length < reviewFindingTelemetryPromptOriginalPriorRunItems;
          const serializedEvidence = renderEvidence();
          machineCountedReviewEvidence = `기계 집계 근거(산문 이력을 보강; 판정 규칙은 그대로 적용):\n${serializedEvidence}${reviewFindingTelemetryPromptTruncated ? `\n${truncationMarker()}` : ''}`;
        } catch {
          machineCountedReviewEvidence = '기계 집계 근거: 직렬화하지 못함(반복 0·지난 런 0과 읽기 실패를 구분; 산문 이력으로 판단).';
        }
        if (purpose === 'escalation-triage') {
          const prompt = [
            '너는 승급 재작업의 트리아지 판정자다. 예산 BUDGET 판정을 내리거나 기존 budget 진단을 반복하지 마라.',
            '첫 줄은 정확히 `TRIAGE: <다음 구현 시도가 먼저 검증·수정할 실패의 뿌리>`로 쓴다. 판단할 수 없으면 빈 문자열을 반환한다.',
            `현재 승급 라운드는 ${round}/${effectiveMax}, 재작업 종류는 ${kind}이다.`,
            '골(수용기준·스코프 경계):', goalDigest.text,
            '현재 실패/리뷰 지적:', tailWithOmissionMarker(note, 3000),
            '이전 라운드 이력:', tailWithOmissionMarker(history.map((item, index) => `[${index + 1}] ${item}`).join('\n'), 2400),
          ].join('\n');
          try {
            const out = await o.llmReview!(prompt);
            const judgement = out.trim().startsWith('TRIAGE:') ? out.slice(0, 2500) : '';
            debug.log('self-implement', 'diagnose.done', { runId, kind, round, purpose, chars: judgement.length, goalChars: goal.length, digestChars: goalDigest.text.length });
            return judgement;
          } catch (e) {
            debug.log('self-implement', 'diagnose.error', { kind, round, purpose, error: e instanceof Error ? e.message : String(e) }, { level: 'error' });
            throw e;
          }
        }
        const prompt = [
          `첫 줄은 정확히 하나: BUDGET: EXTEND | BUDGET: SUFFICIENT | BUDGET: UNCONVERGEABLE | BUDGET: CONTRACT-CONFLICT`,
          `둘째 줄: REASON: <한 문장>. 이후에만 진단을 쓴다.`,
          `EXTEND는 새 지적이 좁아져 한 라운드 더로 풀릴 때만, SUFFICIENT는 리뷰만 실패했고 gate는 통과했으며 남은 지적이 비블로커·스코프 밖일 때만, UNCONVERGEABLE은 같은 지적 반복·스코프 밖 요구·근거 없는 반복 리뷰일 때다.`,
          `CONTRACT-CONFLICT는 현장과 골의 수용·보존 계약 또는 리뷰 지적이 정면으로 충돌하여, 검증된 수용 기준 완화 뒤 다음 라운드가 수정된 골 기준으로 계속해야 할 때 쓴다. 타당한 자식 REFUTE는 이 판단의 근거가 될 수 있지만 제출이 없어도 구현과 계약만으로 동시에 만족시킬 수 없는 충돌이면 이 값을 선택한다. 이 경우 REASON에는 반드시 어떤 계획 줄이 현장과 어긋나는지 쓴다. 골의 ## ACCEPTANCE CRITERIA 안에서 정확히 한 수용 기준 행을 식별할 수 있으면 이어서 반드시 TARGET: <## ACCEPTANCE CRITERIA 안의 전체 원문 한 줄>, EXPECTED: <그 TARGET 행의 현재 한 줄>, REPLACEMENT: <그 TARGET 행에서 완화한 한 줄>을 각각 개행 없는 한 줄로 출력한다. TARGET은 첫 콜론 앞 접두·식별값이나 설명문이 아니라 수용 기준 행 전체와 정확히 일치해야 하며, EXPECTED와 REPLACEMENT도 같은 TARGET 행에서 유래한 단일 수용 기준 행이어야 한다. 셋 중 하나라도 확정할 수 없거나 대상·원문이 다중 일치하면 세 줄을 쓰지 말고 REASON에 적용 불가 사유만 기록한다.`,
          `REFUTE 제출이 있으면 각 항목을 실제로 판정한 경우에만 이후 줄에 정확히 \`REFUTE [findingId]: ACCEPT\` 또는 \`REFUTE [findingId]: REJECT\`로 남겨라. BUDGET verdict는 개별 REFUTE 판정이 아니며, REFUTE 줄이 없으면 개별 수락·기각은 기록되지 않는다.`,
          `너는 자율 구현 rework 진단가다. 현재 라운드 ${round}/${effectiveMax}, 종류는 ${kind}이다.`,
          // ⛔⭐ 맹목적 prefix 자름 금지 — 저작기 골은 **앞이 grounding 후보 목록**이고
          //   이 라벨이 약속한 **수용 기준·스코프 경계는 뒤쪽**에 있다. 2026-07-28 실측:
          //   9,602자 골이 3000 에서 `src/auto` 로 끊겨 감독자가 *"원문이 잘려 범위를 확정할 수
          //   없다"* 며 UNCONVERGEABLE 을 냈다 — **일하던 런이 자름 때문에 버려졌다.**
          `골(수용기준·스코프 경계):`, goalDigest.text,
          `라운드 이력(기계 집계 근거와 함께 같은 지적 반복 여부를 판단):`, tailWithOmissionMarker(history.map((item, index) => `[${index + 1}] ${item}`).join('\n'), 4800),
          supervisorDecisionHistorySection,
          machineCountedReviewEvidence,
          ...(refutationSection ? [refutationSection] : []),
          `현재 지적:`, tailWithOmissionMarker(note, 3000),
          `이후 진단은 다음 구현 에이전트가 근본부터 고치도록 각 항목에 1)왜 실패했나 2)어떻게 고칠까를 간결히 5개 이내로 쓴다.`,
        ].join('\n');
        try {
          const out = await o.llmReview!(prompt);
          try {
            debug.log('self-implement', 'diagnose.done', {
              runId,
              kind,
              round,
              chars: out.length,
              goalChars: goal.length,
              digestChars: goalDigest.text.length,
              droppedSections: goalDigest.droppedSections,
              truncatedSections: goalDigest.truncatedSections,
              droppedNoiseLines: goalDigest.droppedNoiseLines,
              reviewFindingTelemetryPromptBudgetChars,
              reviewFindingTelemetryPromptTruncated,
              reviewFindingTelemetryPromptOriginalCitedItems,
              reviewFindingTelemetryPromptIncludedCitedItems,
              ...(reviewFindingTelemetryPromptIncludedRepeatedCitedItems !== undefined ? { reviewFindingTelemetryPromptIncludedRepeatedCitedItems } : {}),
              reviewFindingTelemetryPromptOriginalRepeatItems,
              reviewFindingTelemetryPromptIncludedRepeatItems,
              reviewFindingTelemetryPromptOriginalPriorRunItems,
              reviewFindingTelemetryPromptIncludedPriorRunItems,
              supervisorDecisionHistoryPromptBudgetChars,
              supervisorDecisionHistoryPromptOriginalItems: normalizedSupervisorDecisionHistory.length,
              supervisorDecisionHistoryPromptIncludedItems: includedSupervisorDecisions.length,
              supervisorDecisionHistoryPromptReasonTruncatedItems,
              supervisorDecisionHistoryPromptTruncated,
              refutationPromptBudgetChars,
              refutationPromptOriginalItems: refutations.length,
              refutationPromptIncludedItems: includedRefutations.length,
              refutationPromptTruncated: refutationsTruncated,
            });
          } catch { /* observation must not change a completed diagnosis */ }
          return out.slice(0, 2500);
        } catch (e) { debug.log('self-implement', 'diagnose.error', { kind, round, error: e instanceof Error ? e.message : String(e) }, { level: 'error' }); return ''; }
      },
      // ★ 반사-기각 seam(RFC-selfdev-judgment-context-substrate Facet C) — must-fix 재주입 前 각 항목을
      //   등가계약(goal)+worktree diff 대비 반사해 accepted(실버그)/rejected(계약 밖) 로 가른다. judge=
      //   llmReview(코더와 분리·동일 래퍼 재사용). 보수 default-accept·judge 실패 시 전체 accept(무회귀).
      reflectMustFix: async ({ mustFix, goal, cwd, evidenceFacts, gateFacts, refutations, recurrenceHistory, runId, round }: { mustFix: string[]; goal: string; cwd: string; evidenceFacts?: ReflectEvidenceFacts; gateFacts?: ReflectGateFacts; refutations?: readonly MustFixRefutation[]; recurrenceHistory?: readonly import('./reflect-mustfix.js').MustFixRecurrenceHistory[]; runId?: string; round?: number }) => {
        const { reflectMustFix: runReflect } = await import('./reflect-mustfix.js');
        // ★ JDG-T2 — 반사-기각은 "이 지적이 diff 안의 실버그인가" 를 판정한다. 리뷰가 본 것과 **같은
        //   범위**를 봐야 하고, 안 그러면 이미 구현된 것을 "계약 밖" 으로 기각한다.
        const diff = await reviewScopeDiff(cwd, 'origin/main', runId);
        const result = await runReflect(mustFix, { goal, diff, evidenceFacts, gateFacts, refutations, recurrenceHistory }, { judge: o.llmReview! });
        debug.log('self-implement', 'reflect.done', {
          accepted: result.accepted.length,
          rejected: result.rejected.length,
          factConflicts: countReflectFactConflicts(mustFix, { evidenceFacts, gateFacts }),
          ...(runId ? { runId } : {}),
          ...(round !== undefined ? { round } : {}),
        });
        return result;
      },
    } : {}),

    readPrCommitShas: async ({ number, cwd }: { number: number; cwd: string }) => {
      const view = runSpawnSync('gh', ['pr', 'view', String(number), '--json', 'baseRefOid,headRefOid,baseRefName'], { cwd, encoding: 'utf8', timeout: 30_000 });
      if (view.status !== 0) throw new Error(`gh pr view commits failed: ${`${view.stdout ?? ''}${view.stderr ?? ''}`.slice(-240)}`);
      let parsed: { baseRefOid?: unknown; headRefOid?: unknown; baseRefName?: unknown };
      try { parsed = JSON.parse(view.stdout ?? ''); }
      catch { throw new Error('gh pr view commits returned invalid JSON'); }
      const baseCommit = typeof parsed.baseRefOid === 'string' ? parsed.baseRefOid.trim() : '';
      const headCommit = typeof parsed.headRefOid === 'string' ? parsed.headRefOid.trim() : '';
      const baseRefName = typeof parsed.baseRefName === 'string' && parsed.baseRefName.trim() ? parsed.baseRefName.trim() : undefined;
      if (!baseCommit || !headCommit) throw new Error('gh pr view commits returned an empty base or head SHA');
      return { baseCommit, headCommit, ...(baseRefName ? { baseRefName } : {}) };
    },
    readPrDiff: async ({ cwd, baseCommit, headCommit }: { number: number; cwd: string; baseCommit: string; headCommit: string }) => {
      // The SHA pair is immutable input: unlike `gh pr diff`, this cannot return a transient B diff
      // while the PR head moves A→B→A around the inspection.
      const diff = runSpawnSync('git', ['diff', '--no-ext-diff', '--unified', `${baseCommit}...${headCommit}`], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      if (diff.status === 0) return diff.stdout ?? '';

      const localFailure = `${diff.stdout ?? ''}${diff.stderr ?? ''}`;
      // Git emits these forms when either immutable SHA has not reached this worktree yet. Other
      // local failures retain their original error instead of silently changing the guard's meaning.
      if (!/(?:bad object|unknown revision|ambiguous argument|invalid object name|invalid symmetric difference expression)/i.test(localFailure)) {
        throw new Error(`git diff fixed commits failed: ${localFailure.slice(-240)}`);
      }

      const repo = runSpawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd, encoding: 'utf8', timeout: 30_000 });
      const nameWithOwner = (repo.stdout ?? '').trim();
      if (repo.status !== 0 || !/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) {
        throw new Error(`git diff fixed commits unavailable locally; gh repo view failed: ${`${repo.stdout ?? ''}${repo.stderr ?? ''}`.slice(-240)}`);
      }

      // The GitHub compare endpoint has the same three-dot (merge-base) semantics as git diff,
      // while resolving both fixed SHAs in the remote repository rather than this stale worktree.
      const remoteDiff = runSpawnSync('gh', ['api', `repos/${nameWithOwner}/compare/${baseCommit}...${headCommit}`, '-H', 'Accept: application/vnd.github.diff'], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      if (remoteDiff.status === 0) return remoteDiff.stdout ?? '';

      const remoteFailure = `${remoteDiff.stdout ?? ''}${remoteDiff.stderr ?? ''}`;
      if (/\bHTTP\s+404\b/i.test(remoteFailure)) {
        for (const [label, sha] of [['base', baseCommit], ['head', headCommit]] as const) {
          const commit = runSpawnSync('gh', ['api', `repos/${nameWithOwner}/commits/${sha}`], { cwd, encoding: 'utf8', timeout: 30_000 });
          if (commit.status !== 0 && /\bHTTP\s+404\b/i.test(`${commit.stdout ?? ''}${commit.stderr ?? ''}`)) {
            throw new Error(`git diff fixed commits failed: ${label} SHA ${sha} is missing from remote repository (HTTP 404)`);
          }
        }
      }
      throw new Error(`git diff fixed commits failed remotely: ${remoteFailure.slice(-240)}`);
    },

    // ★ 병합(2026-07-21·auto-merge·outward-facing) — orchestrator 가 리뷰 clean + --auto-merge 일 때만 호출.
    // `--match-head-commit`으로 검증한 head를 고정한 요청은 한 번의 즉시 병합만 허용한다.
    // `--auto` 큐는 이후 head 변경을 다시 검증하지 않으므로 pinned 요청의 실패를 큐잉하면 안 된다.
    // 비고정 요청만 기존 큐잉 폴백을 유지한다. 관측=merge.gh.
    mergePr: async ({ number, cwd, matchHeadCommit }: { number: number; cwd: string; matchHeadCommit?: string }) => {
      const matchHeadArgs = matchHeadCommit ? ['--match-head-commit', matchHeadCommit] : [];
      let m = runSpawnSync('gh', ['pr', 'merge', String(number), '--squash', ...matchHeadArgs], { cwd, encoding: 'utf8', timeout: 60_000 });
      if (m.status !== 0 && !matchHeadCommit) m = runSpawnSync('gh', ['pr', 'merge', String(number), '--squash', '--auto'], { cwd, encoding: 'utf8', timeout: 60_000 });
      const mergeOutput = `${m.stdout ?? ''}${m.stderr ?? ''}`;
      if (m.status !== 0 && matchHeadCommit) {
        debug.log('self-implement', 'merge.gh', { number, mergeExit: m.status, stateExit: null, prState: null, merged: false });
        return { merged: false, detail: mergeOutput.slice(-240) };
      }
      const state = runSpawnSync('gh', ['pr', 'view', String(number), '--json', 'state,baseRefName'], { cwd, encoding: 'utf8', timeout: 30_000 });
      let parsed: { state?: unknown; baseRefName?: unknown } = {};
      if (state.status === 0) {
        try { parsed = JSON.parse(state.stdout ?? '') as { state?: unknown; baseRefName?: unknown }; }
        catch { parsed = {}; }
      }
      const prState = typeof parsed.state === 'string' ? parsed.state.trim().toUpperCase() : '';
      const baseRefName = typeof parsed.baseRefName === 'string' && parsed.baseRefName.trim() ? parsed.baseRefName.trim() : undefined;
      const merged = prState === 'MERGED';
      debug.log('self-implement', 'merge.gh', { number, mergeExit: m.status, stateExit: state.status, prState: prState || null, merged, ...(baseRefName ? { baseRefName } : {}) });
      if (merged) {
        let mergeCommit: string | undefined;
        try {
          const commit = runSpawnSync('gh', ['pr', 'view', String(number), '--json', 'mergeCommit'], { cwd, encoding: 'utf8', timeout: 30_000 });
          if (commit.status === 0) {
            const parsedCommit = JSON.parse(commit.stdout ?? '') as { mergeCommit?: { oid?: unknown } | null };
            if (typeof parsedCommit?.mergeCommit?.oid === 'string') mergeCommit = parsedCommit.mergeCommit.oid.trim() || undefined;
          }
        } catch { /* Optional commit lookup must not change the confirmed merge result. */ }
        return { merged: true, ...(baseRefName ? { baseRefName } : {}), ...(mergeCommit ? { mergeCommit } : {}) };
      }
      const detail = state.status === 0
        ? `PR state is ${prState || 'unknown'} after merge command`
        : `${mergeOutput}${state.stdout ?? ''}${state.stderr ?? ''}`;
      return { merged: false, detail: detail.slice(-240) };
    },

    // ★ #25 P2/P3 apply-in-place — 비-git dir/config 타겟만 노출(git 타겟은 undefined → deploy 가 PR 경로).
    //   deploy 가 HITL diff 확인을 통과시킨 뒤에만 호출한다(auto 금지·실 FS 쓰기). 백업 필수(shadow-stage).
    ...((o.targetKind === 'non-git-dir' || o.targetKind === 'file') && o.targetPath
      ? {
          apply: ({ cwd }: { cwd: string }) => {
            const target = o.targetPath as string;
            if (o.targetKind === 'file') {
              const r = applyFileToTarget({ shadowPath: cwd, fileName: basename(target), target });
              return { applied: r.applied, backup: r.backup, target, log: r.log };
            }
            const r = applyShadowToTarget({ shadowPath: cwd, target });
            return { applied: r.applied, backup: r.backup, target, log: r.log };
          },
        }
      : {}),
  };
}
