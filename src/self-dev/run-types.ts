import type { TaskStatus } from '../task-orchestrator/types.js';

type WorkingMemoryEntry = {
  phaseId: string;
  phaseTitle: string;
  kind: 'investigation' | 'implementation' | 'operational';
  at: string;
  summary: string;
  reusables: string[];
  decisions: string[];
  artifacts: string[];
  provenance?: 'self' | 'external' | 'reconcile' | 'decision' | 'build';
  arcId?: string;
  deviation?: { kind: 'scope_reduction' | 'deferred' | 'asked_user' | 'env_improved' | 'regrounded' | 'other' | 'satisfied_skip' | 'blocked_dependency' | 'arc_surgery' | 'phase_failed' | 'self_heal' | 'deadlock' | 'review_fail'; note: string };
  scope?: 'agent' | 'subteam' | 'global';
};

type AbandonedClassification = 'report-deficit' | 'implementation-deficit' | 'artifact-deficit' | 'contract-conflict' | 'goal-unconvergeable-candidate' | 'pr-declined' | 'merge-approved-abandoned' | 'run-deadline-exceeded' | 'quota-exhausted' | 'credential-failure' | 'provider-error' | 'already-satisfied';

type ResumeDisposition = 'skip' | 'rerun' | 'rerun-duplicate-risk';

export type JobKind = 'dev' | 'search' | 'deploy' | 'media';
export type SelfDevGoalType = 'implement' | 'research' | 'document' | 'operate';

export interface SelfDevGoal {
  /** F1 job kind. Omitted remains the legacy `dev` self-implement job. */
  kind?: JobKind;
  /** Decomposition intent; deliberately distinct from executable `kind`. */
  goalType?: SelfDevGoalType;
  /** Feature/goal text → `elanous self implement <feature>` for dev jobs. */
  feature: string;
  /** Pod lease predecessor goal ID or PR number. */
  after?: string | number;
  base?: string;
  autoMerge?: boolean;
  /** G8 — attach `auto-review` opt-in label on PR (subject to eligibility self-assessment). */
  autoReview?: boolean;
  /** S3 — open a draft PR via the job's own merge-decision node (HITL).
   *  Promotion flows through the review node → disposition recorded
   *  internally (no external hand-merge). */
  openPr?: boolean;
  draft?: boolean;
  /** Optional short title (≤ 80 chars). Default = feature head. */
  title?: string;
  /** 계획 브랜치가 알려지면 같은 워크트리의 실행을 직렬화한다. */
  planBranch?: string;
  /** 계획 브랜치가 없는 저작 골의 안정 식별자. */
  goalId?: string;
  /** S2 — goal-local id for dependency wiring (default = array index). */
  id?: string;
  /** S2 — goal-local ids this goal depends on (must complete first).
   *  The task becomes `ready` only after every dependency is `done`
   *  (topological parallel via the graph). Unknown/self ids are dropped. */
  dependsOn?: string[];
  /** Read-only handoff memory emitted by this shard for dependent child input.
   *  `[]` is a completed shard with no entries; null/undefined is unreadable. */
  workingMemory?: readonly WorkingMemoryEntry[] | null;
  /** 그 기억을 남긴 이 조각이 «착지했나». ⛔ 생략은 「모른다」이지 「착지」가 아니다. */
  workingMemoryOutcome?: 'landed' | 'blocked' | 'unknown';
  /** S2 — repo paths this job will touch. Two goals sharing a hot path
   *  are serialized (an implicit dependency edge is added, earlier-first)
   *  so their worktrees never merge concurrently. Cf. PLAN §8 risk 2. */
  hotPaths?: string[];
}

export interface SelfDevJobResult {
  taskId: string;
  feature: string;
  /** Run outcome — done | failed | cancelled | blocked (awaiting parent landing). */
  status: TaskStatus;
  error?: { code: string; message: string };
  durationMs?: number;
  /** S3 — real pipeline disposition from the child `--json`
   *  (merged / pr-opened / gate-failed / review-blocked / pr-declined). */
  stage?: string;
  branch?: string;
  /** Child confirmed the finished implementation was pushed for manual harvest. */
  harvestable?: true;
  worktreePath?: string;
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  /** Child commit SHA, when observed by the Pod/host. */
  checkedHeadCommit?: string;
  /**
   * This run's own `--base` (not main). A non-main completion mode
   * (worktree-only, draft, `--base` other than main) lands commits here.
   */
  base?: string;
  /** Child finished with GOAL-COMPLETE (`ok=true`). Distinct from a main merge. */
  ok?: boolean;
  /** Commits this child added against its own `--base`. 0 is not completion progress. */
  commitsAheadOfBase?: number;
  /** A dependency is done but its result is not on main; no child was launched. */
  blockReason?: 'parent-unlanded';
  parentPrNumber?: number;
  /** The upstream completed in a worktree without opening a PR. */
  parentNoPr?: true;
  // ⭐⭐⭐ `A1`(2026-08-19 · 대표 *"R3 가 서브 프로세스여도 잘 도는 안"*) — ***판정 3종***.
  //   🚨 이 셋이 트리아지의 입력 전부인데 종전엔 자식 → 부모 경계에서 «전부» 사라졌다.
  //     값은 전선에 «실려 있었고»(자식이 `r.result` 를 통째로 낸다) 파서가 버렸다.
  //   ⇒ 📌 서브프로세스에서 «먼저» 옳아야 한다 — 실행 방식을 바꾸지 않고 고치는 자리다.
  /** auto-merge 를 «왜» 건너뛰었나 — 「도구 한계」와 「자식이 못 함」을 가르는 근거. */
  mergeReason?: string;
  /** 런이 «왜» 멈췄나. 없으면 「부모가 잘랐다」다. */
  stopReason?: string;
  /** 자식이 스스로 낸 완료 성격. */
  completionDisposition?: string;
  /** Abandoned-run classification from the child. Independent of completionDisposition. */
  failureClassification?: AbandonedClassification;
  /** Provider failure evidence from the child result; absent when unobserved. */
  providerErrors?: { count: number; provider: string; category: 'quota' | 'credential' | 'request' | 'other' };
  /** Stable child run identity used to join its run-ledger proposal. */
  runId?: string;
  /** Self review verdict bound to the PR head observed by the child; absent if either observation is missing. */
  /** TA-LAND-MUSTFIX-ZERO — `mustFixCount` is the review's must-fix list length; absent = unknown (the land gate fails closed). */
  selfReview?: { verdict: 'pass' | 'fail'; head: string; mustFixCount?: number };
  /** Whether the child review actually ran; omitted preserves legacy producers. */
  reviewed?: boolean;
  /** Why the child did not run review; omitted preserves legacy review-unobserved handling. */
  reviewReason?: string;
  /** The abandoned-run classifier observed a goal-side cause for this failed convergence. */
  goalCauseObserved?: true;
  /** Resume selection that decided whether this shard was carried forward or retried. */
  resumeDisposition?: ResumeDisposition;
  /**
   * ⭐ 하니스가 이 조각에 대해 낸 「이렇게 쪼개라」(2026-08-19).
   *
   * ⛔ 이 값은 자식 결과로 «안 온다» — 전선 타입(SelfImplementDisposition)에 칸이 없다.
   *   그래서 «중앙»이 원장에서 읽어 채운다(decompose-proposal.ts). 트리아지는 그것을 그냥 본다.
   *   ⇒ 📌 출구 모듈은 ***「이 값이 어디서 왔는지 몰라야」*** 한다 — 알면 실행 방식마다 갈래가 는다.
   * ⚠️ undefined = 「제안이 없다」와 「아직 안 읽었다」가 «같은 값»이다. 채우는 자가 그것을 구분해 관측한다.
   */
  decomposeProposal?: { pieces: Array<{ id: string; feature: string; dependsOn: readonly string[]; goalType?: string }> };
  /**
   * Parent-side observation of CONTRACT-CONFLICT goal-plan revision application attempts.
   * undefined = the parent has not read the run ledger yet; it is not the same as attempted=0.
   */
  goalPlanRevision?:
    | { status: 'read'; attempted: number; applied: number; failureReasons: string[] }
    | { status: 'read-failed'; reason: 'directory-missing' | 'unreadable-directory' | 'unreadable-files'; scannedFiles: number; unreadableFiles: number; ledgerDirectory: string };
  /** ⭐ 관측(2026-07-21 대표 co-design·"재현 없이 진단") — 자식 goal-loop 화면 버퍼 tail
   *  (ANSI 제거·"docker logs <id>" 등가물). detached PTY goal-loop 은 스폰 프로세스 stdout 이
   *  아니라 file-based 화면 버퍼에만 남으므로, 실패 진단의 유일한 cross-process 진실원. */
  screenTail?: string;
  /** 화면 버퍼에서 판정한 goal-loop 종결 상태(complete=성공 마커·incomplete·null=불명). */
  screenOutcome?: 'complete' | 'incomplete' | null;
  /** 화면 버퍼 공간 id — `elanous self screen --space <id>` 로 전체 전사 재생 가능. */
  screenSpace?: string;
  /** ⚠️ exit-code 실패인데 화면은 GOAL-COMPLETE = 스폰-신호 단절(false-failure). 조정 플래그. */
  reconcileMismatch?: boolean;
  /** ⭐ 이 시도의 «걸음» — 노드 진입 순서(2026-09-08 · 대표 지시).
   *  🩸 그 전까지 이 배열엔 「요약 판정」만 있었고 걸음은 런 «안»에서 끝났다.
   *  ⛔ 관측용이다 — 슈퍼바이저가 이것으로 «무엇을 할지»는 별개 결정이다. */
  walk?: readonly { node: string; round: number }[];
}

export type SupervisorStopReason =
  | 'converged'
  /** 사람이 명시적으로 이 런을 중단했다. */
  | 'human-stopped'
  /** 승격 분해는 끝났지만 부모 결정 신호가 적색이라 완주를 승인할 수 없다. */
  | 'parent-signals-red'
  | 'needs-human'
  | 'no-actionable-work'
  | 'harvestable-awaiting-human'
  | 'handed-off-to-salvage'
  | 'max-rounds'
  | 'no-progress'
  | 'provider-exhausted'
  /** 제자리인데 이번 라운드 재시도 후보가 전부 단계 시간 초과(`timed-out`) — 판정을 못 내고 다시 걸었다. */
  | 'step-timeout'
  | 'decomposable-no-progress'
  | 'review-unobserved'
  | 'deliverable-unobserved'
  | 'deliverable-merged';

export type SupervisorNext = 'harvest' | 'scope-decompose' | 'self-review' | 'human-gate' | 'proposal';
