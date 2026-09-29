// U4 — 통합 self-dev CLI 빌더 골격: runDevPipeline(spec) 단일 진입점.
//
// PLAN-unified-selfdev-cli-runDevPipeline §1/§2 — 스캐터드된 6+ CLI(chat·self implement·orchestrate·
// agent-mission[codex] mission …)를 단일 spec 축으로 수렴한다. 본 페이즈(U4)는 골격:
//   • planDevPipeline(spec) — 순수 정규화/검증/디스패치 선택(전 축 모델링·전수 테스트). = 계약 SSOT.
//   • runDevPipeline(spec, deps) — 얇은 디스패처. 성숙한 단일-미션 경로 2종만 실배선(재발명 0):
//       self+mission        → runSelfImplement(elanous-chat 자체구현·(c) 자체개발)
//       external+pty+mission → runAgentMission(codex/claude/gemini/grok PTY·(b) 외부 에이전트)
//     나머지(parallel·interactive·acp)는 계약엔 모델링하되 명시 NotYetUnified(후속 페이즈 배선).
//   • `elanous dev` 실험 CLI 로 노출(도그푸드 창구·관측 dev-pipeline) — 기존 명령(chat/self implement/
//     orchestrate/agent-mission)은 무접촉. 기존 명령을 runDevPipeline 로 재라우팅(각 명령의 evidence/
//     screens 등 옵션을 spec 이 전부 모델링해야 무회귀)하는 통합은 U4b 별도 페이즈(고위험·mature 4명령 touch).
//
// executor 2단 모델(§2b): self(transport-free·in-process) | { backend × transport(pty 디폴트) }.
//   self 는 backend 리스트 항목이 아니라 transport 축을 붕괴시키는 특수 갈래. 감독 축도 self=turn 레벨.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendEvidenceLocationRequirement, extractVerbatimOriginalAsk, formatGoalFileLintFinding, inspectAskDecisionSignalMarker, leadingGoalMetadata, lintGoalFile, parseGoalId, parseGoalType, SUPERSEDED_BY_LINE, type GoalFileLintFinding, type GoalFileLintResult } from '../self-implement/goal-author.js';
import { createRepositoryReferencedFileReader, type ReferencedFileReader } from '../self-implement/goal-file-reader.js';
import { parseGoalDocumentClarifications } from '../self-implement/goal-author-clarification.js';
import { requiredEvidenceFromGoal } from '../self-implement/off-diff-evidence.js';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import type { GitRunResult } from '../git-fs/retry.js';
import { DEFAULT_BRANCH_WORKTREE_BASE, observeGitResidue, type GitResidueObservation } from '../git-fs/worktree.js';
import type { AgentBackend, AgentMissionSpec, AgentMissionResult, EvidenceMode } from '../agent-mission/driver.js';
import type { SelfImplementOptions, SelfImplementResult, SelfImplementSeams, SelfImplementStage } from '../self-implement/orchestrator.js';
import type { DocumentReferenceStatus } from '../self-implement/self-implement-runtime.js';
import type { SelfDevGoal, OrchestrateSelfDevOptions, SelfDevJobResult } from './orchestrate.js';
import { launchCapabilityObservation, resolveLaunchCapabilities } from './launch-capabilities.js';
import { lookupEntrance, type EntranceId } from './entrance-registry.js';
import type { IngestionEntry } from '../agent-substrate/execution/ingestion-policy.js';
import type { ReviewerContextItem } from '../agent-substrate/pr-reviewer.js';
import { resolveRunIdentity, type RunIdSource } from '../harness/harness-space.js';
import { addSelfDevRunParticipant, saveSelfDevRun } from './run-store.js';
import { getUserConfig, resolveRoleLlm } from '../user-config.js';
import { reviewReasoningEffort } from '../model-tier/review-effort.js';
import { getProvider, inferProviderFromModel } from '../llm.js';
import { buildReviewProviderAttempts, runReviewWithFallback, reviewFallbackModelsFromConfig } from './review-provider-fallback.js';
import type { DefaultSeamsOptions } from '../self-implement/seams.js';
import { harnessTargetOptions, resolveHarnessTarget, revalidateHarnessTarget, type HarnessTargetResolution } from '../self-implement/harness-target-options.js';
import { provisionRepository, type RepoProvisionResult } from '../self-implement/repo-provision.js';
import { decideNonGitInit } from '../self-implement/non-git-consent.js';
import { createInterface } from 'node:readline/promises';
import type { ChildLlmSelection } from '../agent/run-context.js';
import type { SurfaceUx } from '../agent/surface-ux/types.js';

/** parallel dispatch 실행 시 orchestrateSelfDev 에 넘길 런타임 서플라이(goals/concurrency 제외 — 그건 spec.parallel).
 *  spawn·checkpoint·onSnapshot·onEvent·resumeFrom·teardown 등 감독/영속 콜백. CLI seam 이 구성해 주입. */
export type OrchestrateRuntime = Omit<OrchestrateSelfDevOptions, 'goals' | 'concurrency'>;

/** external+pty(agent-mission) 실행 옵션 — 통일 축 밖의 backend-특정 미션 실행 파라미터(무손실 재라우팅용).
 *  agent-mission-pty dispatch 에만 유효(그 외 dispatch 에 지정 시 planDevPipeline 이 거부·수락 후 무시 금지). */
export interface DevMissionOpts {
  chain?: readonly ('codex' | 'claude' | 'elanous')[];
  plugin?: { plugin: string; marketplace: string };
  headless?: boolean;
  evidence?: EvidenceMode;
  maxRounds?: number;
  commit?: boolean;
  screensDir?: string;
  deliverableHint?: string;
  entry?: IngestionEntry;
  memory?: boolean;
  nickname?: string;
}

/** self(elanous-chat 자체구현) 실행 옵션 — 통일 축(executor/context/completion/autoReview/enhance/base) 밖의
 *  self-특정 미션 실행 파라미터(무손실 재라우팅용). self-mission dispatch 에만 유효(그 외 지정 시 planDevPipeline
 *  이 거부·수락 후 무시 금지). autoMerge 는 completion:'auto-merge'·autoReview 는 spec.autoReview 로 표현(중복 축 아님). */
export interface DevSelfOpts {
  mergeByHost?: boolean;
  /** PR draft 여부(기본 true·안전). PR 개설 시에만 의미. */
  draft?: boolean;
  /** 진입 클래스(enhance mode-gating). CLI self implement=external-verbatim. 미지정 시 orchestrator 기본. */
  entry?: IngestionEntry;
  /** 구현(goal-loop) wall-clock 상한(초) → seams implementMaxWaitSec. */
  maxWaitSec?: number;
  /** soft 초과 후 출력 무활동 허용 구간(초) → seams implementActivityGraceSec. */
  activityGraceSec?: number;
  deliverableHint?: string;
  memory?: boolean;
  /** --ground: round-0 goal-loop objective에 codebase grounding을 prepend. */
  ground?: boolean;
  parentSessionId?: string;
  /** Natural-language dispatch preserves its synthesized goal document without introducing a second input vocabulary. */
  goalFile?: string;
  /** Repository-bounded references resolved before entering the pipeline. */
  documentReferences?: readonly DocumentReferenceStatus[];
  /** Caller-supplied marker for a run dispatched from natural-language input. */
  naturalLanguageDispatch?: boolean;
  /** 호출 단위 구현 자식 두뇌(provider/model 원자 선택). 미지정 시 orchestrator 기본·승격 티어를 보존한다. */
  childLlm?: ChildLlmSelection;
  /** Optional opaque ID for joining this request with correlated execution records. */
  correlationId?: string;
  /** Optional opaque ID for the parent correlation in a nested request. */
  parentCorrelationId?: string;
  branchName?: string;
  maxReworkRounds?: number;
}

/** chat(interactive·단일 턴) 실행 옵션 — 통일 축 밖의 chat-특정 대화 파라미터(무손실 재라우팅용). interactive
 *  dispatch 에만 유효. ⚠️ chat 엔진(runChatTurnCli)은 CLI 레이어(index.ts) 소유라 dev-pipeline 이 직접 import
 *  불가(순환) → interactive dispatch 는 deps.runChatTurn 주입 필수(자체 default 없음·설계상 CLI-레이어 소유). */
export interface DevElanousTuiOpts {
  /** child TUI에 제출할 목표(hold에서는 지정 불가). */
  goal?: string;
  /** brain 없이 child TUI를 띄워 외부 `elanous pty` 제어면에 넘긴다. */
  hold?: boolean;
  /** hold PTY readiness 대기 상한(ms). 생략 시 PTY drive의 30초 기본값. */
  readyTimeoutMs?: number;
  /** hold 결과를 사람이 읽는 줄 대신 한 줄 JSON으로 출력한다. */
  json?: boolean;
  maxSteps?: number;
  pollMs?: number;
  model?: string;
  /** Enable the child SelfImplement observation-only override at boot. */
  observeOnly?: boolean;
  isolatedRoot?: string;
  cwd?: string;
}

/** 셸 PTY 제어 루프 실행 옵션 — shell-drive dispatch 에만 유효. */
export interface DevShellDriveOpts {
  command: string;
  goal: string;
  maxSteps?: number;
  pollMs?: number;
  model?: string;
  cwd?: string;
}

/** staged harness(plan-staged) 실행 옵션 — `harness run` front door의 무손실 재라우팅용.
 *  plan-staged dispatch 에만 유효하며, 다른 dispatch와 함께 지정하면 planDevPipeline 이 거부한다. */
export interface DevHarnessOpts {
  target?: string;
  autoDrive?: 'off' | 'safe' | 'on';
  autoReview?: boolean;
  redTeam?: boolean;
  multiAngle?: boolean;
  domain?: string;
  carryCapsule?: boolean;
  sizingMode?: 'off' | 'observe';
  ledgerMode?: 'off' | 'observe';
}

/** chat(interactive·단일 턴) 실행 옵션 — 통일 축 밖의 chat-특정 대화 파라미터(무손실 재라우팅용). interactive
 *  dispatch 에만 유효. ⚠️ chat 엔진(runChatTurnCli)은 CLI 레이어(index.ts) 소유라 dev-pipeline 이 직접 import
 *  불가(순환) → interactive dispatch 는 deps.runChatTurn 주입 필수(자체 default 없음·설계상 CLI-레이어 소유). */
export interface DevChatOpts {
  /** 이어갈 세션 id/prefix(explicitSessionId). */
  session?: string;
  /** 새 세션 강제(reuseActive=!forceNew 로 파생). */
  forceNew?: boolean;
  /** 단일 JSON 라인 출력. */
  json?: boolean;
  /** tool-loop(Read/Grep/…/Bash) 활성(elanous agent 가 켬). */
  enableTools?: boolean;
  /** across-turn goal-loop 아밍(enableTools 필요). */
  goalLoop?: boolean;
}

// ── spec 축 (PLAN §2) ──
export type DevInput = { text: string } | { file: string };
/** ⛔⭐ `aside` 는 2026-08-24 `#12488` 로 agent-mission 백엔드에 «등록»됐는데 이 합집합에는 안 들어왔다.
 *  ⇒ `mission-cli.ts:82` 가 `agentBackend.name` 을 그대로 넘겨 저장소 «전역» tsc 빨강이 났고,
 *    그 빨강이 대상 경로와 «무관한» 런의 게이트를 막았다(130차 실물: run-a3862983 이 그것으로 중단).
 *  📌 등록과 합집합은 «같이» 움직여야 한다 — 한쪽만 늘리면 조용히 빨강이 된다. */
export type DevBackend = 'codex' | 'claude' | 'gemini' | 'grok' | 'aside';
export type DevTransport = 'pty' | 'acp';
/** executor 2단 모델 — self(특수 갈래) | external(backend×transport). */
export type DevExecutor =
  | { kind: 'self' }
  | { kind: 'external'; backend: DevBackend; transport: DevTransport };
export type DevDispatchMode = 'interactive' | 'mission';
export type DevCompletion = 'worktree-only' | 'pr' | 'auto-merge' | 'unmanned';
type DevBaseSelectionRule = 'explicit' | 'default' | 'no-goal-id' | 'no-pr' | 'no-open-pr' | 'missing-pr-head' | 'pr-lookup-failed' | 'single-pr' | 'latest-pr' | 'relaunch-skip-open-pr';
interface DevBaseSelection {
  rule: DevBaseSelectionRule;
  evidence: string;
}

export interface DevPipelineSpec {
  /** 텍스트 직접 또는 파일(verbatim 바이트). */
  input: DevInput;
  /** 프롬프트 인핸싱(undefined = entry 정책 위임). */
  enhance?: boolean;
  /** CLI가 repository-bounded reader로 적재한 리뷰어 컨텍스트(명령줄 순서 보존). */
  reviewerContext?: ReviewerContextItem[];
  /** `--file` 골에 REQUIRED EVIDENCE 태그가 없어도 명시적으로 발사한다. */
  allowNoEvidence?: boolean;
  /** `--file` 골이 후속 골로 대체됐어도 명시적으로 발사한다. */
  allowSupersededGoal?: boolean;
  /** `--file` 골의 lint ERROR가 있어도 명시적으로 발사한다. */
  allowGoalLintErrors?: boolean;
  /** 디폴트 self(§2c/§2d). external 이면 transport 기본 pty(§2b). */
  executor?: { kind: 'self' } | { kind: 'external'; backend: DevBackend; transport?: DevTransport };
  /** 대화형(chat) vs worktree 격리 완주(self implement/agent-mission). 디폴트 mission. */
  context?: DevDispatchMode;
  /** 앞단 staged 플래너(현재 계약 모델링만·U4 미배선). */
  plan?: boolean;
  /** N 동종 self-dev fan-out(현재 계약 모델링만·U4 미배선). */
  /** N 동종 self-dev fan-out(orchestrateSelfDev). goals=per-goal 데이터(feature+autoMerge/openPr/dependsOn 등·무손실). */
  parallel?: { goals: SelfDevGoal[]; concurrency?: number };
  review?: boolean;
  autoReview?: boolean;
  /** autoReview 값을 상위 설정 경계에서 해석했을 때의 출처. */
  autoReviewSource?: DevSelectionSource;
  completion?: DevCompletion;
  /** completion 값을 상위 설정 경계에서 해석했을 때의 출처. */
  completionSource?: DevSelectionSource;
  /** mission worktree 브랜치명(external+pty+mission 필수). */
  branch?: string;
  base?: string;
  /** Supervisor가 이전 실행 종료 뒤 새로 건 재발사인지. 미지정은 기존 호출과 동일하다. */
  relaunch?: boolean;
  /** external+pty(agent-mission) 실행 옵션(무손실 재라우팅용·agent-mission-pty dispatch 에만 유효). */
  mission?: DevMissionOpts;
  /** self(elanous-chat 자체구현) 실행 옵션(무손실 재라우팅용·self-mission dispatch 에만 유효). */
  self?: DevSelfOpts;
  /** self-mission이 개발할 대상. 생략하면 현재 elanous 기본 대상 동작을 보존한다. */
  target?: string;
  /** 격리 bare elanous TUI child 실행 옵션(self+mission 전용). */
  elanous?: DevElanousTuiOpts;
  /** 셸 PTY 제어 루프 실행 옵션. */
  drive?: DevShellDriveOpts;
  /** chat(interactive 단일 턴) 실행 옵션(무손실 재라우팅용·interactive dispatch 에만 유효). */
  chat?: DevChatOpts;
  /** staged harness 실행 옵션(무손실 재라우팅용·plan-staged dispatch 에만 유효). */
  harness?: DevHarnessOpts;
  /** 호출자가 이미 만든 실행 식별자(self-mission·plan-staged 하니스에 전달). */
  runId?: string;
  /** 최외곽 진입점이 runId와 함께 확정한 출처. 없으면 pipeline이 기존 resolver 계약으로 구한다. */
  runIdSource?: RunIdSource;
  /** 발사 입구 식별자(ENTRANCE_REGISTRY). 수집 경로(entryRoute)와 다른 축. 없으면 관측에 칸을 안 싣는다. */
  entrance?: EntranceId;
  /** 현재 입구 대신 같은 표면에서 권장하는 입구를 안내하는 사람용 경고. */
  notice?: string;
  /** 등기된 entrance 없이 시작한 내부 디스패치의 출발 경로. */
  entranceUnstamped?: 'interactive-dispatch';
  /** JSON CLI 출력에서는 사람이 읽는 진행 안내를 stdout에 섞지 않는다. */
  humanReadableOutput?: boolean;
  /** Explicit authorization for Git initialization of a non-git project. */
  assumeYes?: boolean;
  /** CLI 경계에서 한 번 읽은 Git 중단 상태 스냅샷. 같은 런의 plan 관측은 이 값만 기록한다. */
  /** ⛔⭐ **관측과 그 경로는 하나다**(무인 리뷰 must-fix) — 종전엔 `gitResidue` 와
   *  `gitResiduePath` 가 **독립 optional** 이라, 스냅샷만 넘기면 경로가 `process.cwd()` 로
   *  떨어져 ***어느 트리를 봤는지가 거짓으로 기록***됐다. 둘을 원자로 묶어 그 조합 자체를
   *  만들 수 없게 한다. ⊕ 경로만 주는 것(관측은 파이프라인이)은 아래 `gitResiduePath` 로. */
  gitResidueSnapshot?: { path: string; observation: GitResidueObservation };
  /** 관측을 파이프라인에 맡기되 **어느 트리를 볼지**만 정할 때. 스냅샷과 함께 주면 스냅샷이 이긴다. */
  gitResiduePath?: string;
}

/** 디스패치 갈래 — wired=현재 실행배선, 그 외=NotYetUnified(후속). */
export type DevDispatch = 'self-mission' | 'elanous-tui' | 'shell-drive' | 'agent-mission-pty' | 'parallel' | 'interactive' | 'acp' | 'plan-staged';

/** 실행 축을 결정한 입력의 출처 — runtime decomposer 관측과 같은 request/config/default 어휘를 쓴다. */
export type DevSelectionSource = 'request' | 'config' | 'default';

export interface ResolvedDevPlan {
  input: DevInput;
  enhance: boolean | undefined;
  reviewerContext: ReviewerContextItem[] | undefined;
  executor: DevExecutor;
  context: DevDispatchMode;
  plan: boolean;
  parallel: { goals: SelfDevGoal[]; concurrency: number | undefined } | null;
  review: boolean;
  autoReview: boolean;
  autoReviewSource: DevSelectionSource;
  completion: DevCompletion;
  completionSource: DevSelectionSource;
  /** mission worktree 브랜치(agent-mission-pty 필수·planDevPipeline 이 검증). */
  branch: string | undefined;
  base: string | undefined;
  /** Supervisor가 이전 실행 종료 뒤 새로 건 재발사인지. 미지정이면 필드도 만들지 않는다. */
  relaunch?: boolean;
  baseSelection: DevBaseSelection | undefined;
  /** external+pty 실행 옵션(정규화·agent-mission-pty 만). */
  mission: DevMissionOpts | undefined;
  /** self 실행 옵션(정규화·self-mission 만). */
  self: DevSelfOpts | undefined;
  /** 요청 대상을 기존 resolver가 정규화한 결과. 생략하면 기본 elanous 대상이다. */
  target: HarnessTargetResolution | undefined;
  /** 격리 bare elanous TUI child 실행 옵션(정규화·elanous-tui 만). */
  elanous: DevElanousTuiOpts | undefined;
  /** 셸 PTY 제어 루프 실행 옵션(정규화·shell-drive 만). */
  drive: DevShellDriveOpts | undefined;
  /** chat 실행 옵션(정규화·interactive 만). */
  chat: DevChatOpts | undefined;
  /** staged harness 실행 옵션(정규화·plan-staged 만). */
  harness: DevHarnessOpts | undefined;
  /** JSON CLI 출력에서는 사람이 읽는 진행 안내를 stdout에 섞지 않는다. */
  humanReadableOutput: boolean;
  dispatch: DevDispatch;
  /** dispatch 가 U4 골격에서 실행배선됐는지(아니면 runDevPipeline 이 NotYetUnified throw). */
  wired: boolean;
  /** 검증된 발사 입구. 없으면 관측 payload 에 칸을 안 싣는다. */
  entrance: EntranceId | undefined;
  /** 등기된 entrance 없이 시작한 내부 디스패치의 출발 경로. */
  entranceUnstamped: 'interactive-dispatch' | undefined;
}

export class DevPipelineError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'DevPipelineError'; }
}

/** 사람이 읽는 계획 출력에 이미 결정된 base 선택을 그대로 드러낸다. */
export function formatDevBaseSelectionAnnouncement(plan: Pick<ResolvedDevPlan, 'base' | 'baseSelection'>): string {
  const base = plan.base ?? 'unspecified';
  const selection = plan.baseSelection;
  const rule = selection?.rule ?? 'unspecified';
  const evidence = selection?.evidence ?? 'not applicable';
  return `[dev] base=${base} · base-selection=${rule} · evidence=${evidence}`;
}

/** 비기본 base 위에 쌓이는 실행에서만 사람이 다음 행동을 알 수 있게 경고한다. */
export function formatDevNonDefaultBaseWarning(plan: Pick<ResolvedDevPlan, 'base'>): string | undefined {
  if (!plan.base || plan.base === DEFAULT_BRANCH_WORKTREE_BASE) return undefined;
  return `⚠️ NON-DEFAULT BASE: this run stacks on ${plan.base}, not ${DEFAULT_BRANCH_WORKTREE_BASE}. Review the base before treating this run as complete.`;
}

/** 실행배선된 디스패치 — U4b 로 5종 + T1 plan-staged(self implement --plan→dispatchRunDevHarness). interactive 는
 *  chat 엔진(CLI 레이어 소유)이라 deps.runChatTurn 주입 필수(자체 default 없음). */
export const WIRED_DISPATCHES: readonly DevDispatch[] = ['self-mission', 'elanous-tui', 'shell-drive', 'agent-mission-pty', 'acp', 'parallel', 'interactive', 'plan-staged'] as const;

// ── 순수 계약: spec → 정규화/검증된 실행 계획 ──
export function planDevPipeline(spec: DevPipelineSpec): ResolvedDevPlan {
  if (!spec.input || (!('text' in spec.input) && !('file' in spec.input))) {
    throw new DevPipelineError('input 필요 — { text } 또는 { file }');
  }
  // executor 정규화 — 디폴트 self(§2c). external 이면 transport 기본 pty(§2b).
  const executor: DevExecutor =
    !spec.executor || spec.executor.kind === 'self'
      ? { kind: 'self' }
      : { kind: 'external', backend: spec.executor.backend, transport: spec.executor.transport ?? 'pty' };

  const context: DevDispatchMode = spec.context ?? 'mission'; // 개발 파이프라인 기본 mission
  // concurrency 는 executor(orchestrateSelfDev)의 관심사 — 여기서 기본값을 발명하지 않는다(undefined 보존 →
  //   orchestrate 가 자기 surface cap 2 를 씀). ??4 로 강제하면 orchestrate CLI 의 기본 동시성 2 를 깨뜨림(회귀).
  const parallel = spec.parallel
    ? { goals: spec.parallel.goals, concurrency: spec.parallel.concurrency }
    : null;
  // ⭐⭐ 능력의 «결정 자리»는 한 곳이다(RFC-one-door-many-entrances P3).
  //   ⛔ 종전엔 이 네 줄이 결정 «그 자체»였고, 같은 규칙이 다른 입구에도 «따로» 살아 있었다.
  //     그러면 고칠 때 한 곳만 고치게 되고, 그 형태로 2026-08-20 하루에 사고가 셋 났다.
  //   ⛔ 산출은 «바이트 동일»이다 — 아래는 옮긴 것이지 바꾼 것이 아니다.
  // `elanous dev`, natural-language, and goal-file self-implement launches retain the
  // no-flag autonomous policy. Other self-implement and declared-only entrances stay
  // fail-closed unless their caller supplies a capability explicitly.
  const isAutonomousMissionEntrance = executor.kind === 'self' && context === 'mission' && !parallel && !spec.elanous
    && (spec.entrance === 'cli-dev-ask'
      || spec.entrance === 'nl-self-implement'
      // ⭐⭐ 대표 결정 2026-08-22 — 「a 로 해도 큰 문제 없을 것 같은데요. ***기본적으로 자율 주행을 원합니다***」
      //   ⛔⭐ 이 두 줄은 «회복»이 아니라 «부여»다. 이력을 남긴다:
      //     `harness ask`·`say` 는 그날까지 원장에 ***'cli-dev-ask' 라는 «남의 이름»을 적고 있었고***,
      //     그 이름 덕에 이 명단에 «걸려» 무인으로 돌았다. 각인을 정직하게 고치자(#11462→#11470→#11474)
      //     명단 밖으로 나가 fail-closed 가 됐다 — 📏 그날 11발 중 앞 9발 auto-merge / 뒤 2발 worktree-only.
      //   ⇒ 📌 즉 그때까지의 무인 권한은 ***사칭된 것***이었고, 이 두 줄이 그것을 «정식화»한다.
      //   ⚠️ 슬래시 `plan`·`goal`은 2026-08-22 같은 대표 결정으로 각인을 바로잡으며 이 자율 권한을 받는다.
      //     이는 «회복»이 아니라 새 «부여»다: 이전 무인 동작은 'cli-dev-ask'라는 남의 이름으로 명단을 통과했다.
      // `cli-drive` 는 각인을 정직하게 고치는 것이지 새 권한이 아니다 — 종전엔 'cli-dev-ask' 사칭으로 이 명단에 걸려 있었다.
      || spec.entrance === 'cli-drive'
      || spec.entrance === 'cli-harness-ask'
      || spec.entrance === 'cli-harness-say'
      || spec.entrance === 'tui-slash-dev'
      || spec.self?.naturalLanguageDispatch === true
      || spec.self?.goalFile !== undefined);
  const defaultProfile = isAutonomousMissionEntrance
    ? spec.plan ? 'plan-staged' : 'self-mission'
    : 'safe';
  const capabilities = resolveLaunchCapabilities({
    defaultProfile,
    ...(spec.completion === undefined ? {} : { completion: spec.completion }),
    ...(spec.autoReview === undefined ? {} : { autoReview: spec.autoReview }),
    ...(spec.completionSource === undefined ? {} : { completionSource: spec.completionSource }),
    ...(spec.autoReviewSource === undefined ? {} : { autoReviewSource: spec.autoReviewSource }),
  });
  const completion: DevCompletion = capabilities.completion.value;
  const completionSource: DevSelectionSource = capabilities.completion.source;
  const autoReview = capabilities.autoReview.value;
  const autoReviewSource: DevSelectionSource = capabilities.autoReview.source;
  // 발사 입구는 ENTRANCE_REGISTRY 가 권위 — 없으면 칸 자체를 안 만들고, 모르면 레지스트리 거부를 그대로 쓴다.
  if (spec.entrance !== undefined) lookupEntrance(spec.entrance);
  const entrance = spec.entrance;

  // ── 검증(불가 조합 hard-error) ──
  if (spec.self?.mergeByHost === true && (process.env.ELANOUS_SUBSTRATE !== 'pod' || !process.env.ELANOUS_POD_NAME || !process.env.ELANOUS_POD_NAMESPACE)) {
    throw new DevPipelineError('--merge-by-host 는 Pod 자식 전용입니다 (호스트 재게이트 인계가 없는 로컬 실행 거부)');
  }
  if (context === 'interactive' && completion !== 'worktree-only') {
    throw new DevPipelineError('interactive(chat) 는 PR 산출이 없어 completion 은 worktree-only 만 유효');
  }
  if (parallel) {
    if (parallel.goals.length === 0) throw new DevPipelineError('parallel.goals 가 비었다');
    if (executor.kind === 'external') throw new DevPipelineError('parallel 팬아웃은 self executor 만(동종 self-dev 잡)');
    if (context !== 'mission') throw new DevPipelineError('parallel 은 mission context 만');
  }

  // ── 디스패치 선택 ──
  let dispatch: DevDispatch;
  if (parallel) dispatch = 'parallel';
  else if (context === 'interactive') dispatch = 'interactive';
  // ★ T1 — plan(staged 플래너)은 self+mission 에서 별도 파이프라인(dispatchRunDevHarness). external/parallel/
  //   interactive + plan 은 plan-staged 조건 미충족 → 각자 dispatch 로 가고 assertDispatchHonorsOptions 가 거부.
  else if (spec.plan && executor.kind === 'self') dispatch = 'plan-staged';
  else if (spec.elanous && executor.kind === 'self' && context === 'mission') dispatch = 'elanous-tui';
  else if (spec.drive && executor.kind === 'self' && context === 'mission') dispatch = 'shell-drive';
  else if (executor.kind === 'self') dispatch = 'self-mission';
  else if (executor.transport === 'acp') dispatch = 'acp';
  else dispatch = 'agent-mission-pty';

  // agent-mission-pty 는 worktree 브랜치 필수(spawn 전 격리 브랜치).
  if (dispatch === 'agent-mission-pty' && !spec.branch?.trim()) {
    throw new DevPipelineError('external+pty+mission 은 --branch(worktree 브랜치) 필수');
  }
  // acp 는 cwd 세션 실행(worktree 없음) → branch/base 는 무의미 → 지정 시 거부(수락 후 무시 금지).
  if (dispatch === 'acp' && (spec.branch?.trim() || spec.base?.trim())) {
    throw new DevPipelineError('acp 는 cwd 세션 실행(worktree 없음) — branch/base 는 지원 안 함(pty 전용)');
  }
  if (spec.mission?.headless === true && (dispatch !== 'agent-mission-pty' || executor.kind !== 'external' || executor.backend !== 'claude')) {
    throw new DevPipelineError('--headless 는 external Claude mission 전용입니다');
  }
  // mission 실행 옵션은 agent-mission-pty 에만 유효 — 그 외 dispatch 에 지정 시 거부(수락 후 무시 금지).
  const hasMissionOpts = !!spec.mission && Object.values(spec.mission).some((v) => v !== undefined);
  if (hasMissionOpts && dispatch !== 'agent-mission-pty') {
    throw new DevPipelineError(`mission 실행 옵션은 agent-mission-pty dispatch 에만 유효(현재 ${dispatch})`);
  }
  // self 실행 옵션은 self-mission 에만 유효 — 그 외 dispatch 에 지정 시 거부(수락 후 무시 금지·mission 옵션과 대칭).
  const hasSelfOpts = !!spec.self && Object.values(spec.self).some((v) => v !== undefined);
  if (hasSelfOpts && dispatch !== 'self-mission') {
    throw new DevPipelineError(`self 실행 옵션은 self-mission dispatch 에만 유효(현재 ${dispatch})`);
  }
  // elanous TUI 실행 옵션은 elanous-tui 에만 유효 — 그 외 dispatch 에 지정 시 거부(수락 후 무시 금지).
  const hasElanousOpts = !!spec.elanous && Object.values(spec.elanous).some((v) => v !== undefined);
  if (hasElanousOpts && dispatch !== 'elanous-tui') {
    throw new DevPipelineError(`elanous TUI 실행 옵션은 elanous-tui dispatch 에만 유효(현재 ${dispatch})`);
  }
  // ⛔ 하위 계층(pty-drive-cli)과 같은 계약 — goal 의 **존재 자체**를 거부한다(리뷰 must-fix).
  // ⛔ hold 는 brain 을 만들지 않으므로 brain 전용 옵션을 받으면 거부한다(수락 후 무시 금지).
  if (dispatch === 'elanous-tui' && spec.elanous?.hold) {
    const brainOnly = (['maxSteps', 'pollMs', 'model'] as const).filter((k) => spec.elanous?.[k] !== undefined);
    if (brainOnly.length) throw new DevPipelineError(`hold 는 brain 전용 옵션과 동시 사용 불가: ${brainOnly.join(', ')}`);
  }
  if (dispatch === 'elanous-tui' && spec.elanous?.hold && spec.elanous.goal !== undefined) {
    throw new DevPipelineError('elanous TUI hold 는 goal과 동시 사용 불가');
  }
  if (dispatch === 'elanous-tui' && !spec.elanous?.hold && (typeof spec.elanous?.goal !== 'string' || !spec.elanous.goal.trim())) {
    throw new DevPipelineError('elanous TUI dispatch 는 비어 있지 않은 goal 필요');
  }
  const hasDriveOpts = !!spec.drive && Object.values(spec.drive).some((v) => v !== undefined);
  if (hasDriveOpts && dispatch !== 'shell-drive') {
    throw new DevPipelineError(`shell drive 실행 옵션은 shell-drive dispatch 에만 유효(현재 ${dispatch})`);
  }
  if (dispatch === 'shell-drive' && (!spec.drive?.command.trim() || !spec.drive.goal.trim())) {
    throw new DevPipelineError('shell drive dispatch 는 비어 있지 않은 command와 goal 필요');
  }
  // chat 실행 옵션은 interactive 에만 유효 — 그 외 dispatch 에 지정 시 거부(수락 후 무시 금지·self/mission 대칭).
  const hasChatOpts = !!spec.chat && Object.values(spec.chat).some((v) => v !== undefined);
  if (hasChatOpts && dispatch !== 'interactive') {
    throw new DevPipelineError(`chat 실행 옵션은 interactive dispatch 에만 유효(현재 ${dispatch})`);
  }
  // staged harness 실행 옵션은 plan-staged 에만 유효 — 그 외 dispatch 에 지정 시 거부(수락 후 무시 금지).
  const hasHarnessOpts = !!spec.harness && Object.values(spec.harness).some((v) => v !== undefined);
  if (hasHarnessOpts && dispatch !== 'plan-staged') {
    throw new DevPipelineError(`staged harness 실행 옵션은 plan-staged dispatch 에만 유효(현재 ${dispatch})`);
  }

  // target 은 self-mission seam에만 배선된다. 다른 dispatch에서 수락하면 사용자가 고른
  // 대상을 조용히 버리고 기본 elanous 대상으로 수렴하므로 계획 단계에서 거부한다.
  if (spec.target !== undefined && dispatch !== 'self-mission') {
    throw new DevPipelineError(`target은 self-mission dispatch 에만 유효(현재 ${dispatch})`);
  }

  const baseExplicit = (spec as DevPipelineSpec & { baseExplicit?: boolean }).baseExplicit === true;
  const target = spec.target === undefined ? undefined : resolveHarnessTarget(spec.target);
  if (target && target.status !== 'git-repo' && target.status !== 'non-git-dir' && target.status !== 'file' && target.status !== 'outside-home') {
    throw new DevPipelineError(`target 거부: ${target.reason ?? target.status}`);
  }

  return {
    input: spec.input,
    enhance: spec.enhance,
    reviewerContext: spec.reviewerContext,
    executor,
    context,
    plan: spec.plan ?? false,
    parallel,
    review: spec.review ?? false,
    autoReview,
    autoReviewSource,
    completion,
    completionSource,
    // branch/base 정규화(trim) — 공유 플래너의 기존 계약 유지(모든 호출자 동일). git 브랜치명은 주변 공백이
    //   무의미/무효라 trim 이 올바른 정규화(빈/공백-only → undefined). agent-mission 등가성은 현실 브랜치명에서 exact.
    branch: spec.branch?.trim() || undefined,
    base: spec.base?.trim() || undefined,
    ...(spec.relaunch === undefined ? {} : { relaunch: spec.relaunch }),
    baseSelection: spec.base?.trim()
      ? {
          rule: baseExplicit || spec.base.trim() !== DEFAULT_BRANCH_WORKTREE_BASE ? 'explicit' : 'default',
          evidence: baseExplicit || spec.base.trim() !== DEFAULT_BRANCH_WORKTREE_BASE ? 'caller --base' : 'DEFAULT_BRANCH_WORKTREE_BASE',
        }
      : undefined,
    mission: spec.mission,
    self: spec.self,
    target,
    elanous: spec.elanous,
    drive: spec.drive,
    chat: spec.chat,
    harness: spec.harness,
    humanReadableOutput: spec.humanReadableOutput !== false,
    dispatch,
    wired: WIRED_DISPATCHES.includes(dispatch),
    entrance,
    entranceUnstamped: spec.entranceUnstamped,
  };
}

/** DevBackend → ACP delegate backend 이름 — ACP 에서 codex 는 codex-app-server(그 외 동일). */
export function acpBackendName(b: DevBackend): string {
  return b === 'codex' ? 'codex-app-server' : b;
}

/** external+acp → dispatchDelegateAgent args. ACP 는 worktree 없이 cwd 에서 세션 실행(PTY 와 다른 계열).
 *  ⚠️ capability(어떤 태스크까지 소화)는 미검증 — 배선 ≠ 능력(PLAN §5 별도 트랙). 여기선 실행 배선만. */
export function toAcpAgentArgs(text: string, plan: ResolvedDevPlan, cwd: string): { backend: string; task: string; cwd: string } {
  if (plan.executor.kind !== 'external') throw new DevPipelineError('acp 어댑터는 external executor 만');
  return { backend: acpBackendName(plan.executor.backend), task: text, cwd };
}

/** ACP 실행 결과(정규화) — dispatchDelegateAgent 의 성공obj/{error}/{cancelled} 를 공통 {ok} 계약으로.
 *  CLI 의 result.ok===true 성공판정과 호환(실패·취소를 성공으로 오판하지 않게 전파). */
export interface AcpRunResult { ok: boolean; error?: string; cancelled?: boolean; output?: string; backend?: string; sessionId?: string }
export function normalizeAcpResult(raw: unknown): AcpRunResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const output = typeof r.output === 'string' ? r.output : typeof r.partialOutput === 'string' ? r.partialOutput : undefined;
  // ── 실패 판별자 **우선** — 어떤 형태의 실패 마커라도 있으면 성공 아님(fail-CLOSED) ──
  //   dispatchDelegateAgent 실패=  {error} · 취소=  {cancelled:true} · 방어적으로 {ok:false}/{success:false}도.
  if ('error' in r && r.error != null) return { ok: false, error: String(r.error), ...(output !== undefined ? { output } : {}) };
  if (r.cancelled === true) return { ok: false, cancelled: true, ...(output !== undefined ? { output } : {}) };
  if (r.ok === false || r.success === false) return { ok: false, error: '비정상 ACP 응답(명시 실패 마커)', ...(output !== undefined ? { output } : {}) };
  // 성공은 **유효 성공 shape**(output: string)일 때만 — dispatchDelegateAgent 성공={backend,sessionId,stopReason,
  //   output}. null·빈객체·미인식(output 없음)은 성공 오판 금지(비정상 응답이 CLI exit 0 로 새는 것 차단).
  if (typeof r.output === 'string') {
    return {
      ok: true, output: r.output,
      ...(typeof r.backend === 'string' ? { backend: r.backend } : {}),
      ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
    };
  }
  return { ok: false, error: '비정상 ACP 응답 — 성공 shape(output) 없음' };
}

/** 기본 ACP 디스패치 — dispatchDelegateAgent(args, {cwd,signal}) 로 위임. ctx 구성(2번째 인자)을 테스트하려
 *  dispatchDelegateAgent 를 주입 가능하게 분리(기본은 실 daemon-tool import). */
export async function defaultDispatchAcp(
  args: { backend: string; task: string; cwd: string },
  signal: AbortSignal,
  deps?: { dispatchDelegateAgent?: (a: unknown, ctx: { cwd: string; signal: AbortSignal }) => Promise<unknown> },
): Promise<unknown> {
  const dispatch = deps?.dispatchDelegateAgent ?? (await import('../boot/daemon-tools/delegate-agent.js')).dispatchDelegateAgent;
  return dispatch(args, { cwd: args.cwd, signal });
}

// ── 순수 어댑터: 계획 → 기존 성숙 함수 옵션(재발명 0) ──
/** self-mission → SelfImplementOptions(elanous-chat 자체구현). seams=DI 배선(defaultSeams 재사용·주입).
 *  self implement CLI 무손실 재라우팅: autoMerge=completion:'auto-merge'·autoReview=spec.autoReview·draft/entry/
 *  기타=plan.self. maxWaitSec 는 seams(implementMaxWaitSec) 몫이라 여기서 제외(buildDefaultSelfImplementSeams). */
export function toSelfImplementOptions(text: string, plan: ResolvedDevPlan, seams: SelfImplementSeams): SelfImplementOptions {
  const s = plan.self ?? {};
  const goalId = 'file' in plan.input ? parseGoalId(text) : null;
  return {
    feature: text,
    seams,
    ...(plan.enhance !== undefined ? { enhance: plan.enhance } : {}),
    ...(plan.base ? {
      base: plan.base,
      baseSource: plan.baseSelection?.rule === 'explicit' ? 'human' : 'automatic' as const,
      ...(plan.baseSelection ? { baseSelectionRule: plan.baseSelection.rule } : {}),
    } : {}),
    ...('file' in plan.input ? { goalFile: plan.input.file } : s.goalFile ? { goalFile: s.goalFile } : {}),
    ...(goalId ? { goalId } : {}),
    ...(process.env.ELANOUS_REWORK_SALVAGE_ATTEMPT ? { salvageAttempt: Number.parseInt(process.env.ELANOUS_REWORK_SALVAGE_ATTEMPT, 10) || 0 } : {}),
    ...(s.entry ? { entry: s.entry } : {}),
    ...(s.draft !== undefined ? { draft: s.draft } : {}),
    completion: plan.completion,
    ...(plan.completion === 'auto-merge' ? { autoMerge: true } : {}),
    ...(s.mergeByHost === true ? { mergeByHost: true } : {}),
    ...(plan.autoReview ? { autoReview: true } : {}),
    ...(s.deliverableHint ? { deliverableHint: s.deliverableHint } : {}),
    ...(s.memory !== undefined ? { memory: s.memory } : {}),
    ...(s.ground !== undefined ? { ground: s.ground } : {}),
    ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
    ...(s.documentReferences ? { documentReferences: s.documentReferences } : {}),
    ...(s.naturalLanguageDispatch ? { naturalLanguageDispatch: true } : {}),
    ...(s.childLlm ? { childLlm: s.childLlm } : {}),
    ...(s.correlationId !== undefined ? { correlationId: s.correlationId } : {}),
    ...(s.branchName ? { branchName: s.branchName } : {}),
    ...(s.maxReworkRounds !== undefined ? { maxReworkRounds: s.maxReworkRounds } : {}),
  };
}

/** external+pty+mission → AgentMissionSpec. backend 는 이름으로 resolveBackend(호출부 주입 가능). */
export function toAgentMissionSpec(
  text: string,
  plan: ResolvedDevPlan,
  resolveBackend: (name?: string) => AgentBackend,
): AgentMissionSpec {
  if (plan.executor.kind !== 'external') throw new DevPipelineError('agent-mission 어댑터는 external executor 만');
  const m = plan.mission ?? {};
  return {
    mission: text,
    branch: plan.branch!,
    evidence: m.evidence ?? { kind: 'tsc' }, // 기본 tsc(mission 옵션 미지정 시)
    agent: resolveBackend(plan.executor.backend),
    ...(m.headless === true ? { headless: true } : {}),
    ...(m.chain ? { chain: m.chain } : {}),
    ...(m.plugin ? { plugin: m.plugin } : {}),
    ...(plan.base ? { base: plan.base } : {}),
    ...(plan.enhance !== undefined ? { enhance: plan.enhance } : {}),
    ...(m.maxRounds !== undefined ? { maxRounds: m.maxRounds } : {}),
    ...(m.commit !== undefined ? { commit: m.commit } : {}),
    ...(m.screensDir ? { screensDir: m.screensDir } : {}),
    ...(m.deliverableHint ? { deliverableHint: m.deliverableHint } : {}),
    ...(m.entry ? { entry: m.entry } : {}),
    ...(m.memory !== undefined ? { memory: m.memory } : {}),
    ...(m.nickname ? { nickname: m.nickname } : {}),
  };
}

// ── U4b: agent-mission mission 재라우팅 seam(테스트 가능) ──
//   CLI 액션이 이 두 함수를 쓰므로 단위 테스트가 "모든 옵션 전달 + runDevPipeline 호출 + exit-code 등가"를
//   실검증한다(source-grep Goodhart 회피). 기존 명령 → spec 어댑터의 실배선 실현.

/** agent-mission mission CLI 인자 → DevPipelineSpec(external+pty+mission·entry=elanous-apparatus). */
export function buildAgentMissionDevSpec(o: {
  mission: string;
  backend: DevBackend;
  branch: string;
  base?: string;
  headless?: boolean;
  chain?: readonly ('codex' | 'claude' | 'elanous')[];
  plugin?: { plugin: string; marketplace: string };
  /** --no-enhance 시 false(그 외 미지정 → driver 가 entry 로 구동). */
  enhanceOff?: boolean;
  evidence: EvidenceMode;
  maxRounds: number;
  commit: boolean;
  deliverableHint?: string;
  screensDir?: string;
}): DevPipelineSpec {
  return {
    input: { text: o.mission },
    executor: { kind: 'external', backend: o.backend },
    branch: o.branch,
    ...(o.base ? { base: o.base } : {}),
    ...(o.enhanceOff ? { enhance: false } : {}),
    mission: {
      evidence: o.evidence,
      ...(o.headless === true ? { headless: true } : {}),
      ...(o.chain ? { chain: o.chain } : {}),
      ...(o.plugin ? { plugin: o.plugin } : {}),
      maxRounds: o.maxRounds,
      commit: o.commit,
      entry: 'elanous-apparatus',
      ...(o.deliverableHint ? { deliverableHint: o.deliverableHint } : {}),
      ...(o.screensDir ? { screensDir: o.screensDir } : {}),
    },
  };
}

/** 재라우팅 실행 seam — 검증된 backend 를 주입해 runDevPipeline 구동, 결과+exit-code(ok→0·else→2) 반환.
 *  process.exit 은 호출부(액션) 몫 — 이 함수는 순수하게 테스트 가능(runDevPipeline 주입). */
export async function executeAgentMissionReroute(
  spec: DevPipelineSpec,
  agentBackend: AgentBackend,
  deps?: { runDevPipeline?: typeof runDevPipeline },
): Promise<{ result: AgentMissionResult; exitCode: number }> {
  const run = deps?.runDevPipeline ?? runDevPipeline;
  const r = await run(spec, { resolveBackend: () => agentBackend });
  // ★ 잘못된 라우팅 즉시 표면화 — spec 이 external+pty 가 아니면 kind 불일치(무조건 캐스팅 금지).
  if (r.kind !== 'agent-mission') {
    throw new DevPipelineError(`executeAgentMissionReroute: 예상 밖 dispatch(kind=${r.kind}) — external+pty spec 이어야`);
  }
  const result = r.result;
  return { result, exitCode: result.ok ? 0 : 2 };
}

// ── U4b: self implement 재라우팅 seam(테스트 가능) ──
//   agent-mission 대칭. self implement CLI 는 exit-code 규약이 다르다(stage-list→1·pr-declined/성공→0) — ok?0:2
//   아님. 셋업 substrate(harness-space/run-identity/log-sink)와 autoReview config 해석은 CLI seam(self-implement-cli)
//   몫이고, 여기선 spec 빌드 + reroute + exit-code 매핑만(순수·주입 실행 테스트).

/** self implement CLI 인자 → DevPipelineSpec(executor:self·completion=autoMerge?auto-merge:openPr?pr:worktree-only). */
export function buildSelfImplementDevSpec(o: {
  feature: string;
  base?: string;
  /** elanous 내부 인핸싱(--enhance). 미지정 → orchestrator entry 정책(external-verbatim=OFF). */
  enhance?: boolean;
  /** codebase-only grounding(--ground). 미지정/false=off. */
  ground?: boolean;
  draft: boolean;
  autoMerge?: boolean;
  openPr?: boolean;
  autoReview?: boolean;
  autoReviewSource?: DevSelectionSource;
  maxWaitSec?: number;
  /** 진입 클래스(CLI self implement = external-verbatim). */
  entry?: IngestionEntry;
  parentSessionId?: string;
  goalFile?: string;
  documentReferences?: readonly DocumentReferenceStatus[];
  naturalLanguageDispatch?: boolean;
  runId?: string;
  /** --child-llm-provider/--child-llm-model: the Pod grok fallback pins its implementation child here. */
  childLlm?: ChildLlmSelection;
}): DevPipelineSpec {
  // planDevPipeline() is the runtime caller of resolveLaunchCapabilities(); preserve omission
  // until that resolver applies the shared launch default.
  const completion = o.openPr === false
    ? 'worktree-only'
    : o.autoMerge === true
      ? 'auto-merge'
      : o.autoMerge === false || o.openPr === true
        ? 'pr'
        : undefined;
  return {
    input: { text: o.feature },
    executor: { kind: 'self' },
    ...(completion === undefined ? {} : { completion, completionSource: 'request' as const }),
    ...(o.base ? { base: o.base } : {}),
    ...(o.enhance !== undefined ? { enhance: o.enhance } : {}),
    ...(o.autoReview !== undefined ? { autoReview: o.autoReview } : {}),
    ...(o.autoReviewSource !== undefined ? { autoReviewSource: o.autoReviewSource } : {}),
    ...(o.runId ? { runId: o.runId } : {}),
    self: {
      draft: o.draft,
      ...(o.childLlm ? { childLlm: o.childLlm } : {}),
      ...(o.maxWaitSec !== undefined ? { maxWaitSec: o.maxWaitSec } : {}),
      ...(o.ground ? { ground: true } : {}),
      ...(o.entry ? { entry: o.entry } : {}),
      ...(o.parentSessionId ? { parentSessionId: o.parentSessionId } : {}),
      ...(o.goalFile ? { goalFile: o.goalFile } : {}),
      ...(o.documentReferences ? { documentReferences: o.documentReferences } : {}),
      ...(o.naturalLanguageDispatch ? { naturalLanguageDispatch: true } : {}),
    },
  };
}

/** self implement stage → exit-code(CLI 규약 보존): 실패 stage→1 · pr-declined/성공(merged·pr-opened)→0. */
export function selfImplementExitCode(stage: SelfImplementStage): number {
  return ['gate-failed', 'review-blocked', 'aborted', 'merge-conflict', 'timed-out'].includes(stage) ? 1 : 0;
}

/** harness run CLI 인자 → plan-staged DevPipelineSpec(executor:self·plan:true·harness namespace). */
export function buildHarnessRunDevSpec(o: {
  objective: string;
  target?: string;
  autoDrive?: 'off' | 'safe' | 'on';
  autoReview?: boolean;
  base?: string;
  redTeam?: boolean;
  multiAngle?: boolean;
  domain?: string;
  carryCapsule?: boolean;
  sizingMode?: 'off' | 'observe';
  ledgerMode?: 'off' | 'observe';
}): DevPipelineSpec {
  return {
    input: { text: o.objective },
    executor: { kind: 'self' },
    plan: true,
    ...(o.base ? { base: o.base } : {}),
    harness: {
      ...(o.target ? { target: o.target } : {}),
      ...(o.autoDrive ? { autoDrive: o.autoDrive } : {}),
      ...(o.autoReview !== undefined ? { autoReview: o.autoReview } : {}),
      ...(o.redTeam !== undefined ? { redTeam: o.redTeam } : {}),
      ...(o.multiAngle !== undefined ? { multiAngle: o.multiAngle } : {}),
      ...(o.domain ? { domain: o.domain } : {}),
      ...(o.carryCapsule !== undefined ? { carryCapsule: o.carryCapsule } : {}),
      ...(o.sizingMode ? { sizingMode: o.sizingMode } : {}),
      ...(o.ledgerMode ? { ledgerMode: o.ledgerMode } : {}),
    },
  };
}

/** T1: self implement --plan → plan-staged DevPipelineSpec(executor:self·plan:true·completion=autoDrive 파생용).
 *  self? 옵션은 넣지 않는다 — staged 하니스(dispatchRunDevHarness) 소관이라 self-mission 전용 self? 는 무의미
 *  (넣으면 planDevPipeline 이 "self 옵션은 self-mission 만" 거부). PR 개설 의도는 completion 으로만. */
export function buildSelfImplementPlanDevSpec(o: {
  feature: string;
  base?: string;
  openPr?: boolean;
  autoMerge?: boolean;
}): DevPipelineSpec {
  const completion = o.openPr === false
    ? 'worktree-only'
    : o.autoMerge === true
      ? 'auto-merge'
      : o.autoMerge === false || o.openPr === true
        ? 'pr'
        : undefined;
  return {
    input: { text: o.feature },
    executor: { kind: 'self' },
    plan: true,
    ...(completion === undefined ? {} : { completion, completionSource: 'request' as const }),
    ...(o.base ? { base: o.base } : {}),
  };
}

/** 재라우팅 실행 seam — runDevPipeline 구동, self 결과 + self 규약 exit-code 반환. process.exit 은 호출부(액션) 몫.
 *  pipelineDeps 로 runSelfImplement/seams 주입(테스트). kind 불일치는 즉시 표면화(잘못된 라우팅 캐스팅 금지). */
export async function executeSelfImplementReroute(
  spec: DevPipelineSpec,
  deps?: { runDevPipeline?: typeof runDevPipeline; pipelineDeps?: DevPipelineDeps },
): Promise<{ result: SelfImplementResult; exitCode: number }> {
  const run = deps?.runDevPipeline ?? runDevPipeline;
  const r = await run(spec, deps?.pipelineDeps ?? {});
  if (r.kind !== 'self') {
    throw new DevPipelineError(`executeSelfImplementReroute: 예상 밖 dispatch(kind=${r.kind}) — self spec 이어야`);
  }
  return { result: r.result, exitCode: selfImplementExitCode(r.result.stage) };
}

/** T1: plan-staged 재라우팅 실행 seam — runDevPipeline 구동, staged 하니스 output + exit-code 반환. staged 하니스는
 *  성공/실패 구조화 결과가 없어 exit 0 고정(원 --plan 액션도 return·exit 0). kind 불일치는 즉시 표면화. */
export async function executeSelfImplementPlanReroute(
  spec: DevPipelineSpec,
  deps?: { runDevPipeline?: typeof runDevPipeline; pipelineDeps?: DevPipelineDeps },
): Promise<{ output: string; exitCode: number }> {
  const run = deps?.runDevPipeline ?? runDevPipeline;
  const r = await run(spec, deps?.pipelineDeps ?? {});
  if (r.kind !== 'plan-staged') {
    throw new DevPipelineError(`executeSelfImplementPlanReroute: 예상 밖 dispatch(kind=${r.kind}) — plan-staged spec 이어야`);
  }
  return { output: r.result.output, exitCode: 0 };
}

// ── U4b: self orchestrate(parallel) 재라우팅 seam(테스트 가능) ──
//   orchestrateSelfDev 는 coordinator(TOX 엔진)라 CLI 액션이 goals(분해/promote)·run-identity·checkpoint·board 를
//   해석해 주입한다. 이 seam 은 그 결과(goals+concurrency+runtime 콜백)를 받아 runDevPipeline parallel dispatch 로
//   실행하고 orchestrate 규약 exit-code(done<total→1)를 매핑한다. exit-code 규약은 self·agent-mission 과 또 다르다.

/** goals(+concurrency) → parallel DevPipelineSpec. input 은 parallel 에서 무의미하나 계약상 필요 → goals 요약. */
export function buildSelfOrchestrateDevSpec(goals: SelfDevGoal[], concurrency?: number): DevPipelineSpec {
  return {
    input: { text: goals.map((g) => g.feature).join(' ;; ') },
    executor: { kind: 'self' },
    parallel: { goals, ...(concurrency !== undefined ? { concurrency } : {}) },
  };
}

/** parallel 계획 + 런타임 → OrchestrateSelfDevOptions(goals/concurrency=spec·나머지 콜백=runtime). */
export function toOrchestrateOptions(plan: ResolvedDevPlan, runtime: OrchestrateRuntime): OrchestrateSelfDevOptions {
  if (!plan.parallel) throw new DevPipelineError('toOrchestrateOptions: parallel 계획이 없다');
  return {
    goals: plan.parallel.goals,
    ...(plan.parallel.concurrency !== undefined ? { concurrency: plan.parallel.concurrency } : {}),
    ...runtime,
  };
}

/** orchestrate 규약 exit-code: 하나라도 미완(done<total)이면 1 · 전부 done 이면 0(원 CLI 규약 보존). */
export function orchestrateExitCode(results: SelfDevJobResult[]): number {
  const done = results.filter((r) => r.status === 'done').length;
  return done < results.length ? 1 : 0;
}

/** 재라우팅 실행 seam — runDevPipeline parallel dispatch 구동, 잡 결과 + orchestrate 규약 exit-code 반환.
 *  runtime(감독/영속 콜백)은 orchestrateRuntime dep 으로 주입. kind 불일치는 즉시 표면화(캐스팅 금지). */
export async function executeOrchestrateReroute(
  spec: DevPipelineSpec,
  runtime: OrchestrateRuntime,
  deps?: { runDevPipeline?: typeof runDevPipeline; pipelineDeps?: DevPipelineDeps },
): Promise<{ results: SelfDevJobResult[]; exitCode: number }> {
  const run = deps?.runDevPipeline ?? runDevPipeline;
  const r = await run(spec, { ...(deps?.pipelineDeps ?? {}), orchestrateRuntime: runtime });
  if (r.kind !== 'parallel') {
    throw new DevPipelineError(`executeOrchestrateReroute: 예상 밖 dispatch(kind=${r.kind}) — parallel spec 이어야`);
  }
  return { results: r.result, exitCode: orchestrateExitCode(r.result) };
}

// ── U4b: chat(interactive) 재라우팅 seam(테스트 가능) ──
//   chat 은 exit-code 매핑이 없다(runChatTurnCli 가 자체 I/O·성공 exit 0·bad-session 은 내부 exit 1). 이 seam 은
//   opts→spec 매핑 + runDevPipeline 라우팅만. chat 엔진(runChatTurnCli)은 CLI 레이어 소유라 deps.runChatTurn 주입.

/** chat CLI 옵션 → interactive DevPipelineSpec(executor:self·context:interactive·completion:worktree-only 강제). */
export function buildChatDevSpec(text: string, chat: DevChatOpts): DevPipelineSpec {
  return {
    input: { text },
    executor: { kind: 'self' },
    context: 'interactive',
    chat,
  };
}

// ── 디스패처(실행) ──
/** plan-staged executor seam. harness run에서 생략한 target/auto_drive는 자연어 추론을 위해 생략 상태로 보존한다. */
export interface DevHarnessDispatchArgs extends Record<string, unknown> {
  objective: string;
  target?: string;
  auto_drive?: 'off' | 'safe' | 'on';
  base?: string;
  auto_review?: boolean;
  red_team?: boolean;
  multi_angle?: boolean;
  domain?: string;
  carry_capsule?: boolean;
  sizing_mode?: 'off' | 'observe';
  ledger_mode?: 'off' | 'observe';
  runId?: string;
}

export interface DevPipelineDeps {
  /** Caller-managed human progress sink (for example SurfaceUx.progress). Absent callers retain byte-for-byte CLI stdout. */
  progress?: SurfaceUx['progress'];
  runSelfImplement?: (o: SelfImplementOptions) => Promise<SelfImplementResult>;
  runAgentMission?: (s: AgentMissionSpec) => Promise<AgentMissionResult>;
  resolveBackend?: (name?: string) => AgentBackend;
  /** self-mission seams 빌더(테스트 주입). 기본=defaultSeams(CLI 패턴 미러·재발명 0). */
  buildSelfImplementSeams?: (plan: ResolvedDevPlan) => SelfImplementSeams | Promise<SelfImplementSeams>;
  /** Natural-language HITL PR approver; transient seam input, deliberately absent from the persisted plan. */
  approver?: SelfImplementSeams['approvePr'];
  /** In-place repository promotion after target revalidation and before child execution. */
  provisionRepository?: (target: HarnessTargetResolution) => RepoProvisionResult;
  /** Consent prompt seam; defaults to readline on a TTY. */
  askNonGitInit?: (prompt: string) => Promise<string | undefined>;
  /** Interactive detection seam; defaults to stdin TTY state (prompts go to stderr). */
  nonGitInteractive?: boolean;
  /** elanous 도구 소스의 git 최상위(시험 seam). null = 체크아웃 아님(npm 설치). 미지정이면 실제로 잰다. */
  toolRepositoryRoot?: string | null;
  /** ACP 위임 실행(테스트 주입). signal 을 함께 받아 기본 경로와 취소 동작 일치(DI 계약 정합). */
  dispatchAcpAgent?: (args: { backend: string; task: string; cwd: string }, signal: AbortSignal) => Promise<unknown>;
  /** ACP 실행 cwd(기본 process.cwd()). */
  cwd?: string;
  /** 상위 취소 신호 — 기본 ACP ctx 에 전달(미제공 시 non-abort). */
  signal?: AbortSignal;
  /** input {file} 읽기(테스트 주입). 기본 node:fs. */
  readFile?: (path: string) => string;
  /** Read-only GitHub CLI seam for deriving a rework base from a GoalId. */
  runGh?: (args: string[]) => string;
  /** Current branch lookup for goal-file lint (tests). Default is git in cwd. */
  branch?: (cwd: string) => string;
  /** Repository-bounded traced-file reader for goal-file lint (tests). */
  readReferencedFile?: ReferencedFileReader;
  /** Git 중단 상태 관측(테스트 주입). 기본 observeGitResidue. */
  observeGitResidue?: (repoPath: string) => Promise<GitResidueObservation>;
  /** Target repository remote query seam. Its structured result keeps unreadable distinct from an empty remote list. */
  runGit?: (cwd: string, args: string[]) => GitRunResult;
  /** parallel dispatch — orchestrateSelfDev 엔진(테스트 주입). 기본 self-dev/orchestrate. */
  orchestrateSelfDev?: (o: OrchestrateSelfDevOptions) => Promise<SelfDevJobResult[]>;
  /** parallel dispatch — 감독/영속 콜백(spawn·checkpoint·onSnapshot·onEvent·resumeFrom·teardown). CLI seam 이 구성. */
  orchestrateRuntime?: OrchestrateRuntime;
  /** interactive dispatch — chat 단일 턴 실행(주입 필수·default 없음). cfg 바인딩된 runChatTurnCli 클로저를
   *  CLI 레이어(index.ts)가 주입(runChatTurnCli 가 index.ts 소유라 dev-pipeline 이 직접 import 불가·순환 회피). */
  runChatTurn?: (text: string, chat: DevChatOpts) => Promise<void>;
  /** plan-staged dispatch — staged 하니스(Clarify→Plan→Execute→Review→Deploy). 기본 dispatchRunDevHarness(재발명 0). */
  dispatchRunDevHarness?: (args: DevHarnessDispatchArgs) => Promise<{ output: string }>;
  /** elanous-tui dispatch — 기존 PTY 제어 루프. 기본 runPtyDrive(재발명 0). */
  runPtyDrive?: typeof import('../cli/pty-drive-cli.js').runPtyDrive;
}

/** Conservative default — open a little so some unmanned runs pick a tool reviewer. 0 turns it off. */
export const DEFAULT_UNMANNED_TOOL_REVIEWER_RATE = 0.1;

export interface UnmannedToolReviewerSelection {
  readonly picked: boolean;
  readonly rate: number;
  readonly sample: number;
}

export type UnmannedToolReviewLLM = (prompt: string) => Promise<string>;

/** Clamp a configured rate into `[0, 1]`. Non-numbers are absent, not 0. */
export function parseUnmannedToolReviewerRate(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}

/**
 * Deterministic pick: `sample < rate`. `sample` is in `[0, 1)` (Math.random shape).
 * Rate 0 never picks. Tests inject both values — no uncontrolled random on this path.
 */
export function selectUnmannedToolReviewer(rate: number, sample: number): UnmannedToolReviewerSelection {
  const resolvedRate = parseUnmannedToolReviewerRate(rate) ?? 0;
  const resolvedSample = typeof sample === 'number' && Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 1)
    : 1;
  return {
    picked: resolvedSample < resolvedRate,
    rate: resolvedRate,
    sample: resolvedSample,
  };
}

/**
 * 📌 노브 = `llm.toolReviewerRate` (0..1 · 기본 `DEFAULT_UNMANNED_TOOL_REVIEWER_RATE`).
 * 환경변수 `ELANOUS_TOOL_REVIEWER_RATE` 가 그 다음. 읽기 실패는 기본값(fail-soft).
 */
export function unmannedToolReviewerRateFromConfig(
  readConfig: () => { llm?: { toolReviewerRate?: unknown } } = () => getUserConfig() as { llm?: { toolReviewerRate?: unknown } },
): number {
  try {
    const parsed = parseUnmannedToolReviewerRate(readConfig().llm?.toolReviewerRate);
    if (parsed !== undefined) return parsed;
  } catch { /* fail-soft */ }
  const envRaw = process.env.ELANOUS_TOOL_REVIEWER_RATE;
  if (envRaw !== undefined && envRaw !== '') {
    const parsed = parseUnmannedToolReviewerRate(Number(envRaw));
    if (parsed !== undefined) return parsed;
  }
  return DEFAULT_UNMANNED_TOOL_REVIEWER_RATE;
}

function observeUnmannedToolReviewerSelection(selection: UnmannedToolReviewerSelection): void {
  try {
    debug.log('self-dev.reviewer', 'tool-reviewer.select', {
      picked: selection.picked,
      rate: selection.rate,
      sample: selection.sample,
    });
  } catch { /* fail-soft */ }
}

async function defaultMakeUnmannedToolReviewLLM(): Promise<UnmannedToolReviewLLM> {
  const { makeLazyAcpReviewLLM } = await import('../agent-substrate/acp-reviewer.js');
  return makeLazyAcpReviewLLM({ cwd: process.cwd() });
}

/** self-mission 기본 seams — self implement CLI 와 동일 패턴(defaultSeams·configDir/stateDir/llmReview·재발명 0).
 *  completion≠worktree-only 면 approvePr 통과(PR 개설·리뷰 clean 시 완결). */
export async function buildDefaultSelfImplementSeams(
  plan: ResolvedDevPlan,
  deps: {
    llmReview?: (prompt: string) => Promise<string>;
    streamLLM?: typeof import('../llm.js').streamLLM;
    reviewScopeDiff?: DefaultSeamsOptions['reviewScopeDiff'];
    progress?: SurfaceUx['progress'];
    /** Unmanned tool-reviewer rate override (`[0, 1]`). Tests pin this; production reads config/env. */
    toolReviewerRate?: number;
    /** Deterministic `[0, 1)` sample. Tests inject this instead of rolling. */
    toolReviewerSample?: number;
    /** Production roll when sample is omitted. Tests may inject; default is Math.random. */
    toolReviewerRoll?: () => number;
    /** Tool-reviewer factory (same prompt→text shape as llmReview). Tests stub this; default is ACP. */
    makeToolReviewLLM?: () => UnmannedToolReviewLLM | Promise<UnmannedToolReviewLLM>;
  } = {},
): Promise<SelfImplementSeams> {
  const { defaultSeams } = await import('../self-implement/seams.js');
  const { childInstanceScope } = await import('../instance/child-scope.js');
  const { streamLLM: defaultStreamLLM } = await import('../llm.js');
  const childScope = childInstanceScope();
  const reviewRole = resolveRoleLlm('review');
  const reviewModel = reviewRole.model;
  const reviewEffort = reviewReasoningEffort(reviewRole);
  const streamLLM = deps.streamLLM ?? defaultStreamLLM;
  // ⛔⭐⭐⭐ **리뷰 프로바이더 폴백**(대표 2026-08-19 · `#10069` 실물).
  //   🚨 종전엔 리뷰 모델이 «고정»이라 제공자가 과부하면 리뷰가 «안 돌고»,
  //     `reviewed=false` ⇒ `reason="no-real-review"` ⇒ PR 이 draft 로 «조용히» 남았다.
  //     (그 런은 `coveredEvidence=3/3` 이었다 — 자식 잘못이 아니었다)
  //   ⛔ 쿼터 폴백(`DEFAULT_FALLBACK_CHAIN`)과 «다른 축»이다 — 그 자는 「계정이 남았나」를 본다.
  //   ⭐ 첫 시도 성공이면 종전과 «완전히 동일»하다(관측 한 줄만 는다).
  const reviewFallbackModels = reviewFallbackModelsFromConfig();
  const reviewAttemptForModel = (model: string, label: string) => ({
    model,
    provider: inferProviderFromModel(model) ? getProvider(model) : undefined,
    label,
  });
  const reviewAttempts = buildReviewProviderAttempts(
    reviewAttemptForModel(reviewModel, 'primary'),
    reviewFallbackModels.map((model) => reviewAttemptForModel(model, model)),
  );
  const defaultApiReview = async (prompt: string): Promise<string> => {
    const r = await runReviewWithFallback(
      reviewAttempts,
      (attempt, observeResolvedProvider) => streamLLM([{ role: 'user', content: prompt }], () => {}, {
        model: attempt.model,
        provider: attempt.provider,
        // ⛔⭐ 하드코딩 금지 — 모델을 고른 «같은 티어»에서 effort 도 온다(`reviewReasoningEffort`).
        //   🩸 2026-09-23 실측: 여기 `'medium'` 이 박혀 있어, 티어를 best(sol·high)로 올린 뒤에도
        //   ***wire 에는 `effort:"medium"` 이 나갔다***(per-call override 가 티어를 이긴다).
        ...(reviewEffort ? { reasoningEffort: reviewEffort } : {}),
        onResolvedProvider: (provider) => observeResolvedProvider(provider),
      }),
      (event, data) => { try { debug.log('self-dev.review-fallback', event, { ...data }); } catch { /* fail-soft */ } },
    );
    return r.text;
  };
  // ⛔⭐ 「이 리뷰어가 파일을 스스로 읽을 수 있나」는 ***만든 쪽만*** 안다.
  //   ⑴ 기본 구현은 streamLLM 한 번이다 — 도구 채널이 «없다» ⇒ 사실로 `false` 를 선언한다
  //   ⑵ 무인 고르기가 도구 리뷰어를 뽑으면 그 공장은 파일을 읽는다 ⇒ `true`
  //   ⑶ 호출자가 자기 llmReview 를 «주입»하면 그 안에서 무엇을 하는지 우리는 «모른다»
  //      ⇒ 그때는 «선언하지 않는다». 관측이 `'unknown'` 으로 남고, 그것이 `'no'` 와 «다른 값»이다
  const reviewerIsDefaultApiCall = deps.llmReview === undefined;
  let llmReview = deps.llmReview ?? defaultApiReview;
  let reviewerCanSelfRead: boolean | undefined;
  if (reviewerIsDefaultApiCall) {
    const rate = parseUnmannedToolReviewerRate(deps.toolReviewerRate) ?? unmannedToolReviewerRateFromConfig();
    const sample = typeof deps.toolReviewerSample === 'number' && Number.isFinite(deps.toolReviewerSample)
      ? deps.toolReviewerSample
      : (deps.toolReviewerRoll ?? Math.random)();
    const selection = selectUnmannedToolReviewer(rate, sample);
    observeUnmannedToolReviewerSelection(selection);
    if (selection.picked) {
      llmReview = await (deps.makeToolReviewLLM ?? defaultMakeUnmannedToolReviewLLM)();
      reviewerCanSelfRead = true;
    } else {
      reviewerCanSelfRead = false;
    }
  }
  const opensPr = plan.completion !== 'worktree-only';
  const target = plan.target === undefined ? undefined : revalidateHarnessTarget(plan.target);
  if (target?.status === 'outside-home') {
    throw new DevPipelineError(`target 확인 필요: ${target.reason ?? target.canonicalTarget ?? target.target}`);
  }
  if (target && target.status !== 'git-repo' && target.status !== 'non-git-dir' && target.status !== 'file') {
    throw new DevPipelineError(`target 거부: ${target.reason ?? target.status}`);
  }
  const targetOptions = target ? harnessTargetOptions(target, childScope.elanousBinRoot) : undefined;
  if (target && !targetOptions) throw new DevPipelineError(`target 거부: seam 옵션을 만들 수 없음 (${target.target})`);
  return defaultSeams({
    ...childScope,
    ...(targetOptions ?? {}),
    ...(plan.self?.maxWaitSec !== undefined ? { implementMaxWaitSec: plan.self.maxWaitSec } : {}),
    ...(plan.self?.activityGraceSec !== undefined ? { implementActivityGraceSec: plan.self.activityGraceSec } : {}),
    llmReview,
    ...(reviewerCanSelfRead !== undefined ? { reviewerCanSelfRead } : {}),
    ...(deps.reviewScopeDiff ? { reviewScopeDiff: deps.reviewScopeDiff } : {}),
    onProgress: ({ stage, message }) => {
      emitHumanProgress(`[self-implement:${stage}] ${message}`, plan.humanReadableOutput, deps.progress);
    },
    ...(plan.reviewerContext?.length ? { reviewerContext: plan.reviewerContext } : {}),
    ...(opensPr ? { approvePr: async () => true } : {}),
  });
}

export type DevPipelineRunResult =
  | { plan: ResolvedDevPlan; kind: 'self'; result: SelfImplementResult }
  // ⛔ `exitCode: null` = 자식이 종료했으나 코드를 알 수 없음. 0 으로 접지 마라 —
  //    접는 순간 실패가 '정상 완료' 가 된다(이 PR 이 없애려는 그 거짓말).
  | { plan: ResolvedDevPlan; kind: 'elanous-tui'; result: { exitCode: number | null } }
  | { plan: ResolvedDevPlan; kind: 'shell-drive'; result: { exitCode: number | null } }
  | { plan: ResolvedDevPlan; kind: 'agent-mission'; result: AgentMissionResult }
  | { plan: ResolvedDevPlan; kind: 'acp'; result: AcpRunResult } // 정규화된 ACP 결과({ok}·실패/취소 전파)
  | { plan: ResolvedDevPlan; kind: 'parallel'; result: SelfDevJobResult[] } // orchestrateSelfDev 잡 결과 배열
  | { plan: ResolvedDevPlan; kind: 'interactive'; result: null } // chat 턴은 자체 I/O·구조화 결과 없음(runChatTurnCli void)
  | { plan: ResolvedDevPlan; kind: 'plan-staged'; result: { output: string } }; // staged 하니스(dispatchRunDevHarness) 출력

/** dispatch kind 별 성공 판정 — `.result.ok` 는 self/agent-mission/acp 만 유효. parallel(배열)·interactive(null)·
 *  plan-staged({output})는 ok 필드가 없어 순진한 `.ok===true` 는 항상 false(잘못된 실패). kind 별 정직 판정. */
export function devResultOk(r: DevPipelineRunResult): boolean {
  switch (r.kind) {
    case 'self': return r.result.ok === true;
    case 'elanous-tui': return r.result.exitCode === 0;
    case 'shell-drive': return r.result.exitCode === 0;
    case 'agent-mission': return r.result.ok === true;
    case 'acp': return r.result.ok === true;
    case 'parallel': return r.result.length > 0 && r.result.every((j) => j.status === 'done'); // 전 잡 done
    case 'interactive': return true; // chat 턴 완료=성공(자체 I/O·성공/실패 구조 없음)
    case 'plan-staged': return true; // staged 하니스 output 반환=완료(원 --plan exit 0)
  }
}

/** input {text}|{file} → 실제 텍스트(verbatim 바이트·멀티라인 보존). */
export function resolveDevInputText(input: DevInput, readFile: (p: string) => string): string {
  if ('text' in input) return input.text;
  return readFile(input.file);
}

/**
 * Hand-authored goal files bypass `elanous self author`, so attach its evidence-location
 * contract at the execution boundary without rewriting the source document. A quoted
 * occurrence in the ask is not itself an attached requirement; only a standalone
 * requirement line prevents appending the shared contract.
 */
export function applyManualGoalEvidenceRequirement(input: DevInput, text: string): string {
  if ('text' in input) return text;
  const supplemented = appendEvidenceLocationRequirement(text);
  debug.log('dev-pipeline', 'manual-goal-evidence-requirement', { file: input.file, appended: supplemented !== text });
  return supplemented;
}

interface GoalPullRequest {
  number: number;
  updatedAt: string;
  state: string;
}

/** Same-GoalId OPEN PR count at which launch still proceeds but a human must decide close-or-continue. */
export const LINEAGE_OPEN_PR_THRESHOLD = 2;

function noticeLineageThresholdIfNeeded(goalId: string, openCandidates: GoalPullRequest[]): string | undefined {
  const openCount = openCandidates.length;
  if (openCount < LINEAGE_OPEN_PR_THRESHOLD) return undefined;
  const prNumbers = openCandidates.map((candidate) => candidate.number);
  debug.log('dev-pipeline', 'lineage-threshold-needs-human', {
    goalId,
    openCount,
    threshold: LINEAGE_OPEN_PR_THRESHOLD,
    prNumbers,
  });
  const numbers = prNumbers.map((number) => `#${number}`).join(', ');
  return `[dev] lineage-threshold-needs-human: ${openCount} open PRs (${numbers})`;
}

interface GoalPullRequestHead {
  headRefName?: string;
}

function defaultRunGh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024, env: process.env });
}

/** Resolve a file goal's rework base without overriding an explicit human choice or stacking a supervisor relaunch on an open PR. */
function resolveGoalFileBase(plan: ResolvedDevPlan, goalId: string | null, runGh: (args: string[]) => string = defaultRunGh): string | undefined {
  if ('text' in plan.input || plan.baseSelection?.rule === 'explicit') return undefined;
  if (!plan.base) plan.base = DEFAULT_BRANCH_WORKTREE_BASE;
  if (!goalId) {
    plan.baseSelection = { rule: 'no-goal-id', evidence: 'goal file has no GoalId; DEFAULT_BRANCH_WORKTREE_BASE' };
    return undefined;
  }
  try {
    const candidates = JSON.parse(runGh(['pr', 'list', '--state', 'all', '--search', goalId, '--limit', '100', '--json', 'number,updatedAt,state'])) as GoalPullRequest[];
    const openCandidates = candidates.filter((candidate) => candidate.state === 'OPEN');
    const excludedByState = candidates.length - openCandidates.length;
    const candidateEvidence = `candidates=${candidates.length}; excluded-by-state=${excludedByState}`;
    const countedOpen = openCandidates.slice();
    if (openCandidates.length === 0) {
      plan.baseSelection = {
        rule: candidates.length === 0 ? 'no-pr' : 'no-open-pr',
        evidence: `GoalId ${goalId}; ${candidateEvidence}; no open PR; DEFAULT_BRANCH_WORKTREE_BASE`,
      };
      return noticeLineageThresholdIfNeeded(goalId, countedOpen);
    }
    if (plan.relaunch === true) {
      plan.base = DEFAULT_BRANCH_WORKTREE_BASE;
      plan.baseSelection = {
        rule: 'relaunch-skip-open-pr',
        evidence: `GoalId ${goalId}; ${candidateEvidence}; relaunch after previous run; skip OPEN PR as base; DEFAULT_BRANCH_WORKTREE_BASE`,
      };
      return noticeLineageThresholdIfNeeded(goalId, countedOpen);
    }
    openCandidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const selected = openCandidates[0]!;
    const view = JSON.parse(runGh(['pr', 'view', String(selected.number), '--json', 'headRefName'])) as GoalPullRequestHead;
    if (!view.headRefName?.trim()) {
      plan.baseSelection = {
        rule: 'missing-pr-head',
        evidence: `GoalId ${goalId}; ${candidateEvidence}; PR #${selected.number} has no headRefName; DEFAULT_BRANCH_WORKTREE_BASE`,
      };
      return noticeLineageThresholdIfNeeded(goalId, countedOpen);
    }
    plan.base = view.headRefName;
    plan.baseSelection = {
      rule: openCandidates.length === 1 ? 'single-pr' : 'latest-pr',
      evidence: openCandidates.length === 1
        ? `GoalId ${goalId}; ${candidateEvidence}; OPEN PR #${selected.number}`
        : `GoalId ${goalId}; ${candidateEvidence}; latest updatedAt OPEN PR #${selected.number}`,
    };
    return noticeLineageThresholdIfNeeded(goalId, countedOpen);
  } catch (error) {
    plan.baseSelection = {
      rule: 'pr-lookup-failed',
      evidence: `GoalId ${goalId}; PR lookup failed; DEFAULT_BRANCH_WORKTREE_BASE (${error instanceof Error ? error.message : String(error)})`,
    };
    return undefined;
  }
}

/** `--file` 골은 자식 발사 전에 채울 수 있는 REQUIRED EVIDENCE 태그를 하나 이상 선언해야 한다. */
export function preflightGoalFileEvidence(input: DevInput, text: string, allowNoEvidence = false): void {
  if ('text' in input) return;
  const requiredCount = requiredEvidenceFromGoal(text).length;
  if (requiredCount > 0) return;
  if (allowNoEvidence) {
    debug.log('dev-pipeline', 'goal-file-evidence-bypassed', { file: input.file, requiredCount });
    return;
  }
  debug.log('dev-pipeline', 'goal-file-evidence-rejected', { file: input.file, requiredCount });
  throw new DevPipelineError(
    `골 파일에 요구 증거가 없습니다 (Evidence unavailable — grounding found ${requiredCount} categorized evidence items, but no persistent evidence; only the persistent channel is empty. Strengthening the ask's prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md; ## REQUIRED EVIDENCE 절에 채울 수 있는 - [태그] 설명 항목이 없습니다): ## REQUIRED EVIDENCE 절에 - [태그] 설명 형식의 줄을 하나 이상 추가하세요 (우회: --allow-no-evidence)`,
  );
}

/** `--file` 골의 연속된 머리말 메타데이터에서 폐기 backlink를 찾아 발사 직전에 막는다. */
export function preflightSupersededGoalFile(input: DevInput, text: string, allowSupersededGoal = false): void {
  if ('text' in input) return;
  const successor = leadingGoalMetadata(text)
    .map((line) => SUPERSEDED_BY_LINE.exec(line)?.[1])
    .find((value): value is string => value !== undefined);
  if (!successor) return;
  if (allowSupersededGoal) {
    debug.log('dev-pipeline', 'superseded-goal-file-bypassed', { file: input.file, successor });
    return;
  }
  debug.log('dev-pipeline', 'superseded-goal-file-rejected', { file: input.file, successor });
  throw new DevPipelineError(`골 파일은 후속 골로 대체되었습니다: ${successor} (우회: --allow-superseded-goal)`);
}

type DecisionSignalPreflightStatus = 'extracted' | 'marker-present-unextracted' | 'no-marker';

interface GoalFileMarkerCounts {
  recognizedInvariantCount: number;
  headingFormMarkerLabels: readonly string[];
  unverifiableInvariantCandidates: number;
  unverifiableInvariantCandidateReasons: Map<string, number>;
  groundingFilesNotMentionedInAsk: number;
  unansweredClarifications: number;
  decisionSignalStatus: DecisionSignalPreflightStatus;
}

function goalFileMarkerCounts(text: string, recognizedInvariantCount: number, headingFormMarkerLabels: readonly string[]): GoalFileMarkerCounts {
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  let unverifiableInvariantCandidates = 0;
  const unverifiableInvariantCandidateReasons = new Map<string, number>();
  let inInvariantCandidate = false;
  let groundingFilesNotMentionedInAsk = 0;

  for (const line of lines) {
    if (line.startsWith('- Invariant candidate:')) {
      inInvariantCandidate = true;
    } else if (line.startsWith('- ') && !line.startsWith('  - ')) {
      inInvariantCandidate = false;
    }
    const unverifiable = inInvariantCandidate
      ? /^\s*- UNVERIFIABLE:\s*(.*?)\s*$/u.exec(line)
      : undefined;
    if (unverifiable) {
      unverifiableInvariantCandidates += 1;
      const reason = unverifiable[1];
      if (reason) {
        unverifiableInvariantCandidateReasons.set(reason, (unverifiableInvariantCandidateReasons.get(reason) ?? 0) + 1);
      }
      inInvariantCandidate = false;
    }
    const groundingFiles = /^\s*- Grounding files not mentioned in ask \((\d+)\):/u.exec(line);
    if (groundingFiles) groundingFilesNotMentionedInAsk += Number(groundingFiles[1]);
  }

  const unansweredClarifications = parseGoalDocumentClarifications(text)
    .filter((clarification) => !clarification.answered)
    .length;
  const decisionSignal = inspectAskDecisionSignalMarker(text);
  const decisionSignalStatus: DecisionSignalPreflightStatus = decisionSignal.extracted
    ? 'extracted'
    : decisionSignal.marker
      ? 'marker-present-unextracted'
      : 'no-marker';
  return { recognizedInvariantCount, headingFormMarkerLabels, unverifiableInvariantCandidates, unverifiableInvariantCandidateReasons, groundingFilesNotMentionedInAsk, unansweredClarifications, decisionSignalStatus };
}

function looksLikeInvariantLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^(?:[-*+]\s*)?(?:불변식|Invariant)\s*:/iu.test(trimmed);
}

interface ApparentInvariantLineSummary {
  total: number;
  outsideOriginalAskBlock: number;
}

function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    offsets.push(match.index + match[0].length);
  }
  return offsets;
}

function apparentInvariantLineSummary(text: string): ApparentInvariantLineSummary {
  const originalAsk = extractVerbatimOriginalAsk(text);
  const askRange = originalAsk?.range;
  let total = 0;
  let outsideOriginalAskBlock = 0;
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  const offsets = lineStartOffsets(text);
  lines.forEach((line, index) => {
    if (!looksLikeInvariantLine(line)) return;
    total += 1;
    const lineStart = offsets[index] ?? 0;
    const lineEnd = lineStart + line.length;
    if (!askRange || lineStart < askRange.start || lineEnd > askRange.end) {
      outsideOriginalAskBlock += 1;
    }
  });
  return { total, outsideOriginalAskBlock };
}

function zeroContractWarningReason(text: string, apparent: ApparentInvariantLineSummary): string | null {
  const originalAsk = extractVerbatimOriginalAsk(text);
  if (!originalAsk) return 'recognized invariant candidates are counted only inside the Original ask block, but this goal file has no Original ask block';
  const insideOriginalAskBlock = apparent.total - apparent.outsideOriginalAskBlock;
  const reasons: string[] = [];
  if (apparent.outsideOriginalAskBlock > 0) {
    reasons.push(`${apparent.outsideOriginalAskBlock} invariant-looking line(s) are outside the Original ask block, so they are not counted as judgment candidates`);
  }
  if (insideOriginalAskBlock > 0) {
    reasons.push(`${insideOriginalAskBlock} invariant-looking line(s) are inside the Original ask block but did not match the parser-recognized invariant syntax`);
  }
  return reasons.length ? reasons.join('; ') : null;
}

function writeGoalFileMarkerCounts(file: string, text: string, recognizedInvariantCount: number, headingFormMarkerLabels: readonly string[]): void {
  const counts = goalFileMarkerCounts(text, recognizedInvariantCount, headingFormMarkerLabels);
  const reasonBreakdown = counts.unverifiableInvariantCandidateReasons.size === 0
    ? ''
    : ` (${[...counts.unverifiableInvariantCandidateReasons].map(([reason, count]) => `${reason}: ${count}`).join(', ')})`;
  const headingFormLabels = counts.headingFormMarkerLabels.length
    ? `, heading-form marker label(s): ${counts.headingFormMarkerLabels.join(', ')}`
    : '';
  process.stderr.write(
    `[dev] goal-file-markers: ${counts.recognizedInvariantCount} recognized invariant(s)${headingFormLabels}, ${counts.unverifiableInvariantCandidates} UNVERIFIABLE invariant candidate(s)${reasonBreakdown}, ${counts.groundingFilesNotMentionedInAsk} grounding file(s) not mentioned in ask, ${counts.unansweredClarifications} UNANSWERED clarification(s), decision signal: ${counts.decisionSignalStatus} for ${file}\n`,
  );
  const apparentInvariant = apparentInvariantLineSummary(text);
  const zeroContractReason = counts.recognizedInvariantCount === 0 && apparentInvariant.total > 0
    ? zeroContractWarningReason(text, apparentInvariant)
    : null;
  if (zeroContractReason) {
    process.stderr.write(`[dev] goal-file-markers: warning: 0 recognized invariant(s), but ${apparentInvariant.total} invariant-looking line(s) appear in the goal file; not counted because ${zeroContractReason}. Launch continues.\n`);
  }
  if (counts.decisionSignalStatus === 'marker-present-unextracted') {
    process.stderr.write('[dev] goal-file-markers: decision signal repair: write Condition, Observation, and Expected result as three structured slots\n');
  }
  debug.log('dev-pipeline', 'goal-file-marker-counts', {
    file,
    recognizedInvariantCount: counts.recognizedInvariantCount,
    headingFormMarkerLabels: counts.headingFormMarkerLabels,
    unverifiableInvariantCandidates: counts.unverifiableInvariantCandidates,
    unverifiableInvariantCandidateReasons: Object.fromEntries(counts.unverifiableInvariantCandidateReasons),
    groundingFilesNotMentionedInAsk: counts.groundingFilesNotMentionedInAsk,
    unansweredClarifications: counts.unansweredClarifications,
    decisionSignalStatus: counts.decisionSignalStatus,
  });
}

function writeGoalFileTypeDispatch(file: string, text: string, dispatch: DevDispatch): void {
  const goalType = parseGoalType(text);
  process.stderr.write(
    `[dev] goal-file-type: ${goalType ?? 'unreadable'}; dispatch: ${dispatch} for ${file}\n`,
  );
  debug.log('dev-pipeline', 'goal-file-type-dispatch', { file, goalType: goalType ?? 'unreadable', dispatch });
}

/** Run the same six-axis goal-file lint used by ElanousAutopilotLaunch before dispatch. */
function preflightGoalFileLint(
  input: DevInput,
  text: string,
  dispatch: DevDispatch,
  cwd: string,
  allowGoalLintErrors = false,
  deps: Pick<DevPipelineDeps, 'branch' | 'readReferencedFile'> = {},
): void {
  if ('text' in input) return;
  let findings: GoalFileLintResult;
  // ⛔⭐⭐ 브랜치를 못 읽는 것으로 **관문 전체를 죽이지 않는다**(2026-08-03 회귀 · 저자 자수).
  //   `cwd` 가 git 트리가 아니면 `git rev-parse` 가 던지는데, 그 값은 린트 **여섯 축 중
  //   `launch-branch` 하나의 입력**일 뿐이고 그 축은 `ERROR` 도 아닌 `WARN` 이다.
  //   ⇒ ***WARN 하나를 위해 발사 관문 전체가 죽는*** 구조였다. 전 스위트에서 다른 테스트가
  //      cwd 를 임시 디렉터리로 바꾸자 이 경로가 무더기로 터졌다(단독 실행은 통과 — 그래서 착지 때 못 봤다).
  //   ⇒ 브랜치는 **fail-open**(빈 문자열 = 판정 불가)으로 두고, 린트 자체의 실패만 거부한다.
  //   ⚠️ 빈 문자열은 `lintGoalFile` 에서 `'(detached)'` 로 표기되어 **「main 이 아님」 WARN** 이 난다 —
  //      「못 쟀다」가 「알 수 없음」으로 남고 조용히 통과하지 않는다.
  let branch = '';
  try {
    branch = (deps.branch ?? ((directory: string) => {
      const result = runGitCommand(directory, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    }))(cwd);
  } catch { /* fail-open — 브랜치 미상은 린트 한 축의 입력 결손이지 관문 실패가 아니다 */ }
  try {
    findings = lintGoalFile(text, branch, {
      readReferencedFile: deps.readReferencedFile ?? createRepositoryReferencedFileReader(cwd),
    });
  } catch (error) {
    throw new DevPipelineError(`goal lint failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const warnings = findings.filter((finding) => finding.level === 'WARN');
  const checksFor = (items: readonly GoalFileLintFinding[]) => items.flatMap((finding) => finding.check ? [finding.check] : []);
  process.stderr.write(`[dev] goal-file-lint: ${warnings.length} WARN finding(s) for ${input.file}\n`);
  for (const warning of warnings) {
    process.stderr.write(`[dev] goal-file-lint: ${formatGoalFileLintFinding(warning)}\n`);
  }
  if (warnings.length) {
    debug.log('dev-pipeline', 'goal-file-lint-warned', {
      file: input.file,
      warningCount: warnings.length,
      tags: warnings.map((finding) => finding.tag),
      checks: checksFor(warnings),
      branchKnown: branch.length > 0,
      recognizedInvariantCount: findings.recognizedInvariantCount,
    });
  }
  debug.log('dev-pipeline', 'goal-file-lint-observed', {
    file: input.file,
    warningCount: warnings.length,
    recognizedInvariantCount: findings.recognizedInvariantCount,
    prohibitionSymbolStartingLineCount: findings.prohibitionSymbolStartingLineCount,
    permissionSymbolStartingLineCount: findings.permissionSymbolStartingLineCount,
    mixedSymbolLineCount: findings.mixedSymbolLineCount,
    exhaustiveRequestWordingCount: findings.exhaustiveRequestWordingCount,
    blanketBehaviorPreservationCount: findings.blanketBehaviorPreservationCount,
    namedPreservationTargetCount: findings.namedPreservationTargetCount,
    removalFormDecisionConditionCount: findings.removalFormDecisionConditionCount,
    checks: checksFor(findings),
    branchKnown: branch.length > 0,
  });
  writeGoalFileMarkerCounts(input.file, text, findings.recognizedInvariantCount, findings.headingFormMarkerLabels);
  writeGoalFileTypeDispatch(input.file, text, dispatch);
  const errors = findings.filter((finding) => finding.level === 'ERROR');
  if (errors.length === 0) return;
  if (allowGoalLintErrors) {
    debug.log('dev-pipeline', 'goal-file-lint-bypassed', { file: input.file, errorCount: errors.length, tags: errors.map((finding) => finding.tag), checks: checksFor(errors) });
    return;
  }
  const blockingErrors = errors.filter((finding) => finding.tag !== 'grounding-evidence');
  if (blockingErrors.length === 0) {
    debug.log('dev-pipeline', 'goal-file-lint-non-blocking', { file: input.file, errorCount: errors.length, tags: errors.map((finding) => finding.tag), checks: checksFor(errors) });
    return;
  }
  debug.log('dev-pipeline', 'goal-file-lint-rejected', { file: input.file, errorCount: errors.length, tags: errors.map((finding) => finding.tag), checks: checksFor(errors) });
  throw new DevPipelineError(`${errors.map(formatGoalFileLintFinding).join('\n')}\n(우회: --allow-goal-lint-errors)`);
}

/**
 * dispatch 가 요청 옵션을 실제로 이행하는지 검증 — 미이행 옵션은 "수락 후 무시"(요청과 다른 파이프라인을
 * 성공으로 실행) 대신 NotYetUnified 로 거부한다. 배선된 옵션만 통과.
 *   • plan/review: 어느 wired 경로도 spec-제어 미배선 → 요청 시 거부.
 *   • autoReview: self-mission 만 배선(runSelfImplement autoReview→L3 라벨). 그 외 dispatch 는 미배선 → 거부.
 *   • completion: self-mission=worktree-only|pr|auto-merge(runSelfImplement autoMerge·approvePr 개폐, unmanned
 *     만 미배선) · agent-mission-pty/acp=worktree-only 만(PR 완결 미배선). 그 밖은 거부(축약 금지·계약 정직).
 */
/**
 * All five human-guidance stdout paths in this module route here: completion, base selection,
 * self-implement progress, and both repo-provision notices. Goal-file marker/type/lint output
 * remains stderr because it is diagnostic machine-facing reporting, not managed-surface guidance.
 */
function emitHumanProgress(message: string, humanReadableOutput: boolean | undefined, progress?: SurfaceUx['progress']): void {
  if (!humanReadableOutput) return;
  if (progress) {
    progress(message);
    return;
  }
  console.log(message);
}

function completionAnnouncement(completion: DevCompletion): string {
  switch (completion) {
    case 'auto-merge':
      return '[dev] completion: auto-merge — PR review clean 시 자동 병합합니다 (끄기: --no-auto-merge)';
    case 'pr':
      return '[dev] completion: pr — PR 개설로 끝납니다';
    case 'worktree-only':
      return '[dev] completion: worktree-only — worktree 작업으로 끝납니다';
    case 'unmanned':
      return '[dev] completion: unmanned';
  }
}

export function observeDevSelection(
  axis: 'completion' | 'autoReview',
  effectiveValue: DevCompletion | boolean,
  source: DevSelectionSource,
  requestedValue: DevCompletion | boolean | undefined,
  entryRoute: IngestionEntry,
  runId?: string,
  entrance?: EntranceId,
  entranceUnstamped?: 'interactive-dispatch',
): void {
  // ⭐ 관측 payload 의 «축·값·출처» 칸은 결정 자리(launch-capabilities)가 만든다 —
  //   판정과 관측이 «같은 모양»을 쓰게 해서, 축이 늘 때 한 곳만 고치면 되게 한다.
  //   ⛔ effectiveValue 키 이름은 «그대로 둔다» — 이 이름으로 읽는 소비자가 이미 있다.
  //   ⛔ entrance 는 수집 경로(entryRoute)와 다른 축. 있을 때만 별도 키로 싣고, 없으면 종전 payload 그대로.
  debug.log('dev-pipeline', 'selection', {
    ...launchCapabilityObservation(axis, { value: effectiveValue, source }),
    requestedValue,
    entryRoute,
    ...(runId ? { runId } : {}),
    ...(entrance ? { entrance } : {}),
    ...(entranceUnstamped ? { entranceUnstamped } : {}),
  });
}

export type TargetRemoteState = 'remote-present' | 'remote-absent' | 'remote-unreadable';

export interface TargetRemoteObservation {
  state: TargetRemoteState;
  repoRoot: string;
  reason?: string;
}

/** Query a revalidated target repository without collapsing a failed git invocation into an empty remote list. */
export function observeTargetRemote(
  repoRoot: string,
  runGit: (cwd: string, args: string[]) => GitRunResult = (cwd, args) => runGitCommand(cwd, args, { encoding: 'utf8', timeout: 30_000 }),
): TargetRemoteObservation {
  const result = runGit(repoRoot, ['remote']);
  if (result.status !== 0) {
    return { state: 'remote-unreadable', repoRoot, reason: result.stderr.trim() || `git remote exited ${result.status ?? 'unknown'}` };
  }
  return result.stdout.trim()
    ? { state: 'remote-present', repoRoot }
    : { state: 'remote-absent', repoRoot };
}

/**
 * A confirmed remote-less target cannot complete through a PR. Explicit human PR requests fail closed;
 * automatic capability defaults are reduced to worktree-only before the child is dispatched.
 */
export function resolveTargetRemoteCompletion(
  completion: DevCompletion,
  completionSource: DevSelectionSource,
  remote: TargetRemoteObservation,
  options: { naturalLanguageDispatch?: boolean } = {},
): { completion: DevCompletion; reason?: string } {
  if (remote.state !== 'remote-absent' || completion === 'worktree-only') return { completion };
  // 🩸 2026-09-26 베어 Ubuntu 26.04 실측(UX 15): TUI 자연어 경로에서 «모델이» 도구 인자(open_pr 등)를 채워
  //   출처가 `request` 로 찍혔고, 원격 없는 저장소라 79초 뒤에 실패했다 — 사람은 PR 을 청한 적이 없다.
  //   ⇒ 자연어 경로는 사람이 친 플래그가 아니므로 기본과 같이 워크트리로 내리고 «그렇게 했다»고 한 줄 말한다.
  if (completionSource !== 'default' && options.naturalLanguageDispatch === true) {
    return {
      completion: 'worktree-only',
      reason: `target has no git remote; the natural-language request asked for completion:${completion}, ran worktree-only instead (commits stay on a local branch — add a remote to get a PR)`,
    };
  }
  if (completionSource !== 'default') {
    // ⛔ 2026-09-23 (Phase 4 실측) — 막는 것은 옳지만 «무엇을 하면 되나»를 말해야 한다.
    //   `--no-auto-merge` 같은 완료 인자는 «PR 을 명시한 것»으로 읽힌다 — 로컬 프로젝트 사용자는 그걸 모른다.
    throw new DevPipelineError(
      `target has no git remote, so requested completion:${completion} cannot open a PR`
      + ' — to work locally, drop the completion flags (e.g. --no-auto-merge): a remote-less target then runs worktree-only'
      + ' (commits stay on a local branch); to get a PR, add a remote first (git remote add origin <url>)',
    );
  }
  return {
    completion: 'worktree-only',
    reason: 'target has no git remote; selected worktree-only instead of PR completion',
  };
}

export function assertDispatchHonorsOptions(plan: ResolvedDevPlan): void {
  const unsupported: string[] = [];
  // plan(staged)은 plan-staged dispatch(self+mission)만 이행 — external/parallel/interactive + plan 은 거부.
  if (plan.plan && plan.dispatch !== 'plan-staged') unsupported.push('plan(staged 플래너는 self+mission 만·현 dispatch 미배선)');
  if (plan.review) unsupported.push('review(spec 제어 미배선·self 는 내부 리뷰 고정)');
  if (plan.autoReview && plan.dispatch !== 'self-mission') unsupported.push('autoReview(self-mission 외 dispatch 미배선)');
  if (plan.dispatch === 'self-mission' && !['worktree-only', 'pr', 'auto-merge'].includes(plan.completion)) {
    unsupported.push(`completion:${plan.completion}(self 는 worktree-only|pr|auto-merge 만 · unmanned 미배선)`);
  }
  if (plan.dispatch === 'agent-mission-pty' && plan.completion !== 'worktree-only') {
    unsupported.push(`completion:${plan.completion}(agent-mission-pty 는 worktree-only 만 · PR 완결 미배선)`);
  }
  if (plan.dispatch === 'elanous-tui' && plan.completion !== 'worktree-only') {
    unsupported.push(`completion:${plan.completion}(elanous-tui 는 worktree-only 만 · 격리 child TUI 실행)`);
  }
  if (plan.dispatch === 'shell-drive' && plan.completion !== 'worktree-only') {
    unsupported.push(`completion:${plan.completion}(shell-drive 는 worktree-only 만 · 셸 PTY 제어 루프 실행)`);
  }
  if (plan.dispatch === 'acp' && plan.completion !== 'worktree-only') {
    unsupported.push(`completion:${plan.completion}(acp 는 worktree-only 만 · cwd 세션 실행·PR 완결 미배선)`);
  }
  if (plan.dispatch === 'parallel' && plan.completion !== 'worktree-only') {
    // parallel 의 PR 제어는 per-goal(goals[].openPr/autoMerge)이라 top-level completion 은 무의미 → 거부(정직).
    unsupported.push(`completion:${plan.completion}(parallel 은 per-goal openPr/autoMerge 로 제어 · top-level completion 미배선)`);
  }
  if (plan.dispatch === 'plan-staged' && !['worktree-only', 'pr', 'auto-merge'].includes(plan.completion)) {
    // plan-staged 는 completion 으로 autoDrive 파생(worktree-only=safe·pr/auto-merge=on). unmanned 는 staged
    //   하니스에 없음 → 조용히 on 으로 변환 금지(수락 후 무시 금지·타 dispatch 대칭).
    unsupported.push(`completion:${plan.completion}(plan-staged 는 worktree-only|pr|auto-merge 만 · unmanned 미배선)`);
  }
  if (unsupported.length > 0) {
    throw new DevPipelineError(`runDevPipeline: 요청 옵션 미배선(NotYetUnified) — ${unsupported.join(' · ')}`);
  }
}

/** 최상단 관측이 `plan`·`goalId` 를 나중에 받아 적기 위한 통. 디스패치가 채운다. */
type PlanObservationSink = { plan?: ReturnType<typeof planDevPipeline>; goalId?: string | null };

/**
 * ⛔⭐⭐⭐ **관측이 무엇보다 앞이어야 한다**(무인 리뷰 must-fix 3회 · 매번 다른 자리에서).
 *  종전엔 관측이 ⑴ 골 읽기·preflight 뒤 ⑵ `parallel` 조기 반환 뒤 ⑶ `planDevPipeline` 뒤에
 *  있었고, 그 각각이 던지거나 먼저 반환하면 **잔여가 있어도 행이 안 남았다.** 그것은 이 PR 이
 *  없애려는 실패 형태 그 자체다(*"사람이 막혀서야 안다"*).
 *  ⇒ ⭐ 자리를 하나씩 옮기지 않고 **구조로 끝낸다**: 잔여를 **함수 최상단**에서 관측하고
 *    본문 전체를 `try/finally` 로 감싼다. 계획이 던지든 `parallel` 이 일찍 반환하든
 *    **행은 정확히 하나** 남고, 오류는 그대로 전파된다.
 *    `plan`·`goalId` 는 **알게 된 만큼만** 실린다(부재 ≠ 실패).
 */
export async function runDevPipeline(spec: DevPipelineSpec, deps: DevPipelineDeps = {}): Promise<DevPipelineRunResult> {
  if (spec.runId) {
    const runIdSource = spec.runIdSource ?? resolveRunIdentity({ explicit: spec.runId }).source;
    const now = Date.now();
    saveSelfDevRun({ runId: spec.runId, createdAt: now, updatedAt: now, results: [], pid: process.pid });
    addSelfDevRunParticipant(spec.runId, {
      id: `process:${process.pid}`,
      kind: 'process',
      transports: [],
      registeredAt: now,
      runIdSource,
    });
  }
  // ⭐ 스냅샷이 있으면 **그 경로가 곧 관측 경로**다 — 둘이 갈릴 수 없다(위 타입 주석).
  const gitResiduePath = spec.gitResidueSnapshot?.path ?? spec.gitResiduePath ?? deps.cwd ?? process.cwd();
  const seen: PlanObservationSink = {};
  let gitResidue: GitResidueObservation = { state: 'unreadable' };
  let emitted = false;

  // ⭐ **정상 경로에서는 디스패치 前에 한 번 찍고**(run-start 의미 보존 — 긴 런 중에도 사전에
  //   보인다), 그 앞 단계가 던진 경우에만 `finally` 의 단회 fallback 이 찍는다.
  //   ⛔ `finally` 에서만 찍으면 **런이 끝나야 보이므로** *"막히기 전에"* 를 어긴다(무인 리뷰).
  const emitPlanRow = async (): Promise<void> => {
    if (emitted) return;
    let nestDepth = 0;
    let originFields: Record<string, unknown> = {};
    // ⚠️ 동적 import 실패가 **행을 통째로 삼키면 안 된다** — 부가 필드는 없어도 행은 남는다.
    try {
      const { nestInfo } = await import('../agent/nest-depth.js');
      nestDepth = nestInfo().depth;
      const { originObservationFields } = await import('../agent/origin-observation.js');
      originFields = originObservationFields() as Record<string, unknown>;
    } catch { /* fail-soft */ }
    // ⛔ 중복 관측을 없앨 때 **필드까지 없애면 회귀다**(선행 리뷰 must-fix). CLI 가 내던
    //   `runId·executor·wired·completion·nestDepth·origin*` 이 통째로 사라져 있었다.
    // ⛔ 로거 예외를 **양쪽으로 대칭**하게 다룬다(무인 리뷰 should-fix 2회):
    //   ⑴ 가드를 먼저 세우면 로거가 던졌을 때 행도 없고 재시도도 막힌다.
    //   ⑵ 가드를 뒤에만 세우면 **찍은 뒤 던진 경우** `finally` 가 다시 찍어 행이 둘이 된다.
    //   ⇒ **시도는 한 번**으로 못 박고(아래 `emitted = true` 는 무조건 실행), 로거 오류는
    //     삼킨다 — 관측 실패가 런의 진짜 오류를 가리면 안 된다(저장소 fail-soft 규약).
    const planObservation = {
      ...(spec.runId ? { runId: spec.runId } : {}),
      ...(seen.plan
        ? {
            dispatch: seen.plan.dispatch,
            executor: seen.plan.executor.kind,
            wired: seen.plan.wired,
            completion: seen.plan.completion,
            input: 'file' in seen.plan.input ? 'file' : 'text',
          }
        : {}),
      ...(seen.goalId ? { goalId: seen.goalId } : {}),
      ...(seen.plan?.base ? { base: seen.plan.base } : {}),
      ...(seen.plan?.relaunch !== undefined ? { relaunch: seen.plan.relaunch } : {}),
      ...(seen.plan?.baseSelection ? { baseSelectionRule: seen.plan.baseSelection.rule, baseSelectionEvidence: seen.plan.baseSelection.evidence } : {}),
      ...(seen.plan?.entranceUnstamped ? { entranceUnstamped: seen.plan.entranceUnstamped } : {}),
      gitResiduePath,
      gitResidueState: gitResidue.state,
      ...(gitResidue.state === 'observed' ? { gitResidues: gitResidue.residues, gitResidueCount: gitResidue.residues.length } : {}),
      nestDepth,
      ...originFields,
    };
    try { debug.log('dev-pipeline', 'plan', planObservation); } catch { /* fail-soft — 관측 실패가 런의 오류를 가리지 않는다 */ }
    try {
      debug.log('dev-pipeline', 'harness.launch', {
        ...planObservation,
        legacyEvent: 'plan',
        ...(seen.plan?.entrance ? { entrance: seen.plan.entrance } : {}),
      });
    } catch { /* fail-soft — 관측 실패가 런의 오류를 가리지 않는다 */ }
    emitted = true;   // 시도는 한 번(성공·실패 무관) ⇒ 중복도 없고 원래 오류도 안 가린다
  };

  try {
    // ⛔ 조회도 `try` **안**이다 — 주입된 관측기가 던져도 행은 남아야 한다(무인 리뷰).
    gitResidue = spec.gitResidueSnapshot?.observation ?? await (deps.observeGitResidue ?? observeGitResidue)(gitResiduePath);
    return await runDevPipelineDispatch(spec, deps, seen, emitPlanRow);
  } finally {
    await emitPlanRow();   // 앞 단계가 던졌을 때만 실제로 찍힌다(단회 가드)
  }
}

async function runDevPipelineDispatch(
  spec: DevPipelineSpec,
  deps: DevPipelineDeps,
  seen: PlanObservationSink,
  emitPlanRow: () => Promise<void>,
): Promise<DevPipelineRunResult> {
  const plan = planDevPipeline(spec);
  seen.plan = plan;
  if (!plan.wired) {
    throw new DevPipelineError(
      `runDevPipeline: '${plan.dispatch}' 경로는 U4 골격에서 미배선(NotYetUnified). ` +
      `배선됨=${WIRED_DISPATCHES.join('/')} · 후속: interactive→chat·parallel→orchestrateSelfDev.`,
    );
  }
  const entryRoute = plan.self?.entry ?? plan.mission?.entry ?? 'elanous-apparatus';
  observeDevSelection('completion', plan.completion, plan.completionSource, plan.completionSource === 'request' ? spec.completion : undefined, entryRoute, spec.runId, plan.entrance, plan.entranceUnstamped);
  observeDevSelection('autoReview', plan.autoReview, plan.autoReviewSource, plan.autoReviewSource === 'request' ? spec.autoReview : undefined, entryRoute, spec.runId, plan.entrance, plan.entranceUnstamped);
  assertDispatchHonorsOptions(plan); // 미이행 옵션 거부(수락 후 무시 금지)
  emitHumanProgress(completionAnnouncement(plan.completion), spec.humanReadableOutput !== false, deps.progress);
  if (spec.notice) emitHumanProgress(spec.notice, spec.humanReadableOutput !== false, deps.progress);

  if (plan.dispatch === 'parallel') {
    // ★ U4b — parallel → orchestrateSelfDev(TOX coordinator). goals/concurrency=spec·감독 콜백=orchestrateRuntime.
    //   input 텍스트는 parallel 에 무의미(goals 가 작업) → text 해석 前에 분기(빈 input 요구 회피).
    await emitPlanRow();   // ⭐ 이 경로는 골을 안 읽으므로 **디스패치 직전**이 사전 관측 자리다.
    const run = deps.orchestrateSelfDev ?? (await import('./orchestrate.js')).orchestrateSelfDev;
    return { plan, kind: 'parallel', result: await run(toOrchestrateOptions(plan, deps.orchestrateRuntime ?? {})) };
  }

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const inputText = resolveDevInputText(plan.input, readFile);
  preflightGoalFileEvidence(plan.input, inputText, spec.allowNoEvidence === true);
  preflightSupersededGoalFile(plan.input, inputText, spec.allowSupersededGoal === true);
  preflightGoalFileLint(plan.input, inputText, plan.dispatch, deps.cwd ?? process.cwd(), spec.allowGoalLintErrors === true, deps);
  const text = applyManualGoalEvidenceRequirement(plan.input, inputText);
  const goalId = 'file' in plan.input ? parseGoalId(text) : null;
  seen.goalId = goalId;
  const lineageNotice = resolveGoalFileBase(plan, goalId, deps.runGh);
  debug.log('dev-pipeline', 'base-selection', {
    ...(plan.relaunch !== undefined ? { relaunch: plan.relaunch } : {}),
    ...(spec.runId ? { runId: spec.runId } : {}),
    ...(goalId ? { goalId } : {}),
    base: plan.base,
    rule: plan.baseSelection?.rule ?? 'unspecified',
    evidence: plan.baseSelection?.evidence ?? 'not applicable',
  });
  emitHumanProgress(formatDevBaseSelectionAnnouncement(plan), spec.humanReadableOutput !== false, deps.progress);
  const nonDefaultBaseWarning = formatDevNonDefaultBaseWarning(plan);
  if (nonDefaultBaseWarning) {
    emitHumanProgress(nonDefaultBaseWarning, spec.humanReadableOutput !== false, deps.progress);
  }
  if (lineageNotice) {
    emitHumanProgress(lineageNotice, spec.humanReadableOutput !== false, deps.progress);
  }
  // ⭐ 사전 관측 — 골을 읽어 `goalId` 까지 알게 된 **지금**, 실제 디스패치 **전에** 찍는다.
  //   긴 런 중에도 잔여가 보인다. 앞 단계가 던졌다면 겉면의 `finally` 가 이미 찍었고
  //   단회 가드가 중복을 막는다.
  await emitPlanRow();

  if (plan.dispatch === 'interactive') {
    // ★ U4b — interactive → chat 단일 턴. chat 엔진(runChatTurnCli)은 CLI 레이어(index.ts) 소유라 default 없이
    //   주입 필수(순환 회피). 결과는 자체 I/O(구조화 결과 없음·runChatTurnCli void). empty-text 거부 안 함(chat 원
    //   동작 보존 — build dispatch 만 비-empty 요구).
    if (!deps.runChatTurn) {
      throw new DevPipelineError('interactive dispatch 는 runChatTurn 주입 필요(chat 엔진은 CLI 레이어 소유·index.ts)');
    }
    await deps.runChatTurn(text, plan.chat ?? {});
    return { plan, kind: 'interactive', result: null };
  }

  if (!text.trim() && !(plan.dispatch === 'elanous-tui' && plan.elanous?.hold)) {
    throw new DevPipelineError('input 텍스트가 비었다'); // build dispatch(self/acp/agent-mission) 만
  }

  if (plan.dispatch === 'plan-staged') {
    // ★ T1 — self implement --plan → staged 하니스(Clarify→Plan→Execute→Review→Deploy). 기존 dispatchRunDevHarness
    //   위임(재발명 0). autoDrive 는 completion 에서 파생(pr/auto-merge=on·worktree-only=safe·원 액션 openPr||autoMerge 등가).
    const harness = plan.harness;
    const dispatch = deps.dispatchRunDevHarness ?? (await import('../skills/tools/dev-harness.js')).dispatchRunDevHarness;
    const args: DevHarnessDispatchArgs = harness
      ? {
          objective: text,
          ...(harness.target !== undefined ? { target: harness.target } : {}),
          ...(harness.autoDrive !== undefined ? { auto_drive: harness.autoDrive } : {}),
          ...(plan.base ? { base: plan.base } : {}),
          ...(harness.autoReview !== undefined ? { auto_review: harness.autoReview } : {}),
          ...(harness.redTeam !== undefined ? { red_team: harness.redTeam } : {}),
          ...(harness.multiAngle !== undefined ? { multi_angle: harness.multiAngle } : {}),
          ...(harness.domain ? { domain: harness.domain } : {}),
          ...(harness.carryCapsule !== undefined ? { carry_capsule: harness.carryCapsule } : {}),
          ...(harness.sizingMode ? { sizing_mode: harness.sizingMode } : {}),
          ...(harness.ledgerMode ? { ledger_mode: harness.ledgerMode } : {}),
          ...(spec.runId ? { runId: spec.runId } : {}),
        }
      : {
          objective: text,
          target: 'self',
          auto_drive: plan.completion !== 'worktree-only' ? 'on' : 'safe',
          ...(plan.base ? { base: plan.base } : {}),
          ...(spec.runId ? { runId: spec.runId } : {}),
        };
    const res = await dispatch(args);
    return { plan, kind: 'plan-staged', result: { output: res.output } };
  }

  if (plan.dispatch === 'elanous-tui') {
    const run = deps.runPtyDrive ?? (await import('../cli/pty-drive-cli.js')).runPtyDrive;
    return { plan, kind: 'elanous-tui', result: await run({ elanous: true, ...plan.elanous! }) };
  }
  if (plan.dispatch === 'shell-drive') {
    const run = deps.runPtyDrive ?? (await import('../cli/pty-drive-cli.js')).runPtyDrive;
    return { plan, kind: 'shell-drive', result: await run(plan.drive!) };
  }
  const confirmNonGit = async (target: string): Promise<void> => {
    const ask = deps.askNonGitInit ?? (async (prompt: string) => {
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      try { return await reader.question(prompt); }
      finally { reader.close(); }
    });
    const decision = await decideNonGitInit({
      target,
      interactive: deps.nonGitInteractive ?? (process.stdin.isTTY === true),
      assumeYes: spec.assumeYes === true,
      ask,
    });
    if (decision !== 'init') {
      throw new DevPipelineError('git 저장소가 필요합니다 — `git init` 하거나 `--yes` 로 다시 · (다음 판: 그림자 저장소 — RFC P19)', 2);
    }
  };
  const provisionForeignWorkingRepository = (cwd: string): void => {
    const topLevel = (dir: string): string | null => {
      const r = runGitCommand(dir, ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000 });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    };
    const cwdTop = topLevel(cwd);
    if (!cwdTop) return;
    // 도구 뿌리 = elanous 소스의 git 최상위(npm 설치면 null ⇒ 작업 디렉토리는 늘 남의 저장소).
    const toolTop = deps.toolRepositoryRoot !== undefined ? deps.toolRepositoryRoot : topLevel(import.meta.dir);
    if (toolTop !== null && toolTop === cwdTop) return;
    try {
      const target = revalidateHarnessTarget(resolveHarnessTarget(cwdTop));
      if (target.status !== 'git-repo') return;
      const provision = (deps.provisionRepository ?? provisionRepository)(target);
      debug.log('dev-pipeline', 'cwd-provision', { cwd: cwdTop, status: provision.status });
      emitHumanProgress(`[repo-provision] ${provision.status} ${provision.target} (작업 디렉토리)`, spec.humanReadableOutput !== false, deps.progress);
    } catch (error) {
      debug.log('dev-pipeline', 'cwd-provision-failed', { cwd: cwdTop, reason: String(error) }, { level: 'warn' });
    }
  };
  const applyRemoteLessCompletion = (repoRoot: string): void => {
    const remote = observeTargetRemote(repoRoot, deps.runGit);
    debug.log('dev-pipeline', 'target-remote', remote);
    const resolved = resolveTargetRemoteCompletion(plan.completion, plan.completionSource, remote, { naturalLanguageDispatch: spec.self?.naturalLanguageDispatch === true });
    if (resolved.reason) {
      plan.completion = resolved.completion;
      debug.log('dev-pipeline', 'target-remote-completion', {
        remoteState: remote.state,
        completion: plan.completion,
        reason: resolved.reason,
      });
      emitHumanProgress(`[dev] completion: ${plan.completion} — ${resolved.reason}`, spec.humanReadableOutput !== false, deps.progress);
      assertDispatchHonorsOptions(plan);
    }
  };
  if (plan.dispatch === 'self-mission') {
    if (plan.target) {
      const target = revalidateHarnessTarget(plan.target);
      if (target.status === 'outside-home') {
        throw new DevPipelineError(`target 확인 필요: ${target.reason ?? target.canonicalTarget ?? target.target}`);
      }
      if (target.status !== 'git-repo' && target.status !== 'non-git-dir' && target.status !== 'file') {
        throw new DevPipelineError(`target 거부: ${target.reason ?? target.status}`);
      }
      let provisionTarget = target;
      if (target.status === 'non-git-dir') {
        await confirmNonGit(target.canonicalTarget ?? target.target);
        provisionTarget = revalidateHarnessTarget(target);
        if (provisionTarget.status !== 'non-git-dir') throw new DevPipelineError(`target 거부: ${provisionTarget.reason ?? provisionTarget.status}`);
      }
      const provision = (deps.provisionRepository ?? provisionRepository)(provisionTarget);
      if (provision.status === 'provisioned') {
        plan.target = provision.resolution;
        emitHumanProgress(`[repo-provision] promoted ${provision.target}`, spec.humanReadableOutput !== false, deps.progress);
        if (provision.ignoreFile.created) emitHumanProgress(`[repo-provision] .gitignore created ${provision.target}`, spec.humanReadableOutput !== false, deps.progress);
      } else {
        emitHumanProgress(`[repo-provision] ${provision.status} ${provision.target}`, spec.humanReadableOutput !== false, deps.progress);
      }
      if (plan.target.repoRoot) applyRemoteLessCompletion(plan.target.repoRoot);
    } else {
      // ⛔ 2026-09-23 (Phase 4 실측) — 사용자는 `--target` 없이 «자기 프로젝트 안에서» 친다. 종전엔 원격 판정이
      //   `--target` 블록에만 있어, 원격 없는 로컬 프로젝트가 `auto-merge` 로 떠서 끝에서야 PR 을 못 열고 멎었다
      //   (`gh pr list` 가 「no git remotes found」). 같은 판정을 작업 디렉토리 저장소에도 건다.
      //   원격이 있거나 못 읽으면 종전과 «동일»(elanous 자기 개발 경로 무영향).
      const cwd = deps.cwd ?? process.cwd();
      const workingTarget = resolveHarnessTarget(cwd);
      if (workingTarget.status === 'non-git-dir') {
        await confirmNonGit(workingTarget.canonicalTarget ?? workingTarget.target);
        const checked = revalidateHarnessTarget(workingTarget);
        if (checked.status !== 'non-git-dir') throw new DevPipelineError(`target 거부: ${checked.reason ?? checked.status}`);
        const provision = (deps.provisionRepository ?? provisionRepository)(checked);
        if (provision.status !== 'provisioned') throw new DevPipelineError(`git 저장소 준비 실패: ${provision.status}`);
        emitHumanProgress(`[repo-provision] promoted ${provision.target}`, spec.humanReadableOutput !== false, deps.progress);
        if (provision.ignoreFile.created) emitHumanProgress(`[repo-provision] .gitignore created ${provision.target}`, spec.humanReadableOutput !== false, deps.progress);
      }
      applyRemoteLessCompletion(cwd);
      // ⛔ 2026-09-23 (벤더 A/B 실측) — 대상 저장소 준비(.gitignore 에 elanous 실행 산출물)가 `--target` 에만 걸려 있어,
      //   사용자 경로(`cd <프로젝트> && elanous harness say`)에선 `.elanous/debug/*.log`·`latest` 링크·liveness 하트비트가
      //   사용자 저장소 커밋에 섞였다 ⇒ 리뷰 must-fix(범위 이탈·diff 가 로그에 끊김·역방향 검증 실패) 로 kimi·glm 이 abandoned.
      //   ⇒ 작업 디렉토리가 «elanous 도구 자신의 저장소가 아닐 때만» 같은 준비를 건다(elanous 자기 개발 경로 무영향).
      provisionForeignWorkingRepository(cwd);
    }
    const run = deps.runSelfImplement ?? (await import('../self-implement/orchestrator.js')).runSelfImplement;
    const defaultSeams = deps.buildSelfImplementSeams
      ? await deps.buildSelfImplementSeams(plan)
      : await buildDefaultSelfImplementSeams(plan, { progress: deps.progress });
    const seams = deps.approver ? { ...defaultSeams, approvePr: deps.approver } : defaultSeams;
    // ⭐ 대표 지시(2026-09-08) — ***걸음을 「위」로 흘린다.***
    //   🩸 그 전까지 런 슈퍼바이저가 받는 것은 «시도의 요약 판정»뿐이었고(stage·stopReason·분류 …)
    //     「어느 노드를 몇 번 밟았나」는 ***런 안에서 끝났다***(`onNodeEntry` 는 있는데 호출부 0).
    //   ⛔ 새 관을 만들지 않는다 — 이미 있는 이음매에 «소비자»를 붙인다.
    //   ⛔ 관측용이다 — 흐름을 바꾸지 않는다.
    const walk: { node: string; round: number }[] = [];
    const result = await run({
      ...toSelfImplementOptions(text, plan, seams),
      ...(spec.runId ? { runId: spec.runId } : {}),
      onNodeEntry: (node, round) => { walk.push({ node, round }); },
    });
    // ⛔ 「걸음이 비었다」와 「안 걸었다」를 가른다 — 빈 배열은 «싣지 않는다».
    return { plan, kind: 'self', result: walk.length === 0 ? result : { ...result, walk } };
  }
  if (plan.dispatch === 'acp') {
    // ★ U6 — external+acp → 기존 ACP executor(dispatchDelegateAgent)에 최소 ctx {cwd,signal}로 위임(재발명 0).
    //   PTY 와 다른 계열(JSON-RPC 세션·cwd 실행). capability 미검증(배선 ≠ 능력·PLAN §5 별도 트랙).
    const cwd = deps.cwd ?? process.cwd();
    const signal = deps.signal ?? new AbortController().signal; // 상위 취소 신호 전달(미제공 시 non-abort)
    const args = toAcpAgentArgs(text, plan, cwd);
    const raw = deps.dispatchAcpAgent ? await deps.dispatchAcpAgent(args, signal) : await defaultDispatchAcp(args, signal);
    // 결과 정규화 — {error}/{cancelled}를 성공으로 오판하지 않게 {ok} 계약으로(CLI exit-code 호환·fail-closed).
    return { plan, kind: 'acp', result: normalizeAcpResult(raw) };
  }
  // agent-mission-pty
  const run = deps.runAgentMission ?? (await import('../agent-mission/driver.js')).runAgentMission;
  const resolveBackend = deps.resolveBackend ?? (await import('../agent-mission/driver.js')).resolveBackend;
  return { plan, kind: 'agent-mission', result: await run(toAgentMissionSpec(text, plan, resolveBackend)) };
}
