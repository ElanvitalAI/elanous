// ☸️ self-implement 자식을 k8s Job(Pod)으로 — 슈퍼바이저(`self orchestrate`)의 세 번째 실행 칸.
//
// 계약은 로컬 spawn(`defaultSelfImplementSpawn`)과 «같다»: 입력 → { address, done }. 그래서 분해·동시 실행 상한·
// 감독 루프·원장이 수정 없이 따라온다(RFC-elanous-on-docker-and-kubernetes-isolation-ladder · ROADMAP C2).
// Pod 안에서는 일반 골은 `self implement`, 전달된 ask 골 문서는 `harness ask` 로 실행하고 마지막 줄 JSON 을 Job 로그로 읽는다.
//
// 📏 2026-09-25 실측 근거(docker/harness · docker/runner):
//   · 자격 = 호스트 계정의 «refresh 없는» 사본(1회용 refresh 보호) — Secret(읽기 전용) → 쓰기 가능한 홈으로 복사.
//   · 격리 관문(initContainer) 필수 — kube-router 는 새 Pod 에 정책을 늦게 건다(첫 ~0.5초 운영 31415 에 닿음 3/3).
//   · 이미지는 `docker/harness/Dockerfile`(elanous 설치 ⊕ 정적 codex·짝·rg·gh) — 로컬 굽기는 호스트 잠금 아래 한 번만 한다.
// ⛔ worktreePath 는 Pod 안 경로라 호스트에서 쓸 수 없다 → disposition 에서 지운다.
// 부작용(kubectl·파일)은 주입받는다 — 시험은 가짜 kubectl 로 누른다.

import { podSkillsDigest, readSkillEnvFiles, resolvePodSkills } from './pod-skills.js';
import { emitPodLifecycle, parseSiTaskDepsSkipped, parseSiTaskPodStages, siTaskPodK8sTiming, siTaskPodLifecycleEvent, siTaskPodStageShell } from './pod-lifecycle-stages.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';
import { GROUNDING_TOKEN_ENV, GROUNDING_URL_ENV, mintGroundingToken, revokeGroundingRun, type GroundingTokenScope } from '../../grounding/token.js';
import { POD_CREDENTIAL_GROK_PATH, POD_CREDENTIAL_GITHUB_PATH, POD_GITHUB_CREDENTIAL_TOKEN_ENV, POD_GITHUB_CREDENTIAL_URL_ENV, installationRepositories } from '../../nexus/api/pod-credential-api.js';
import { coalescedInstallationCredential } from '../../auth/github-app-token.js';
import { POD_CREDENTIAL_TOKEN_ENV, POD_CREDENTIAL_URL_ENV } from '../../grok/credential.js';
import { isVerifiedOpenGatewayModel } from '../../llm/opengateway-models.js';
import { configuredOpenGatewayKeys } from '../../llm/provider-credentials.js';
import { collectPodLedgers, createPodLedgerFollower } from './pod-ledger-collect.js';
import { collectPodArtifacts, podNoResultDiagnostic } from './pod-artifact-return.js';
import { readPodRepairArtifact } from './pod-repair-commit.js';
import { isValidAccountName, resolveCodexAccount } from '../../oauth/codex-account.js';
import { createCodexAccessMirror } from '../../oauth/codex-access-mirror.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { controlInboxEnv } from '../../harness/control-inbox.js';
import { finishPodFragment, writePodFragment } from '../../harness/self-send-target.js';
import { mintRunId, normalizeRunId } from '../../harness/harness-space.js';
import { TA_LAND_ENV } from '../../task-agent/task-hand.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir, runLedgerPath, type RunLedgerEntry } from '../../self-implement/run-ledger.js';
import { runSuffixKey } from '../../self-implement/salvage-branches.js';
import type { GoalExecutionRecord } from '../../self-implement/orchestrator.js';
import { hostRepositoryUnavailable, runHostRegate, type HostRegateResult } from '../../self-implement/host-regate.js';
import { resolvePodHostAcpReview, runPodHostAcpReview, type PodHostAcpReviewOutcome } from './pod-host-acp-review.js';
import { REVIEW_DEFERRED_TO_HOST_ENV, REVIEW_DEFERRED_TO_HOST_MERGE_REASON } from '../../self-implement/review-deferred-to-host.js';
import { classifyPodTerminal, applyPodTerminal, podTerminalPrBody, type PrTerminalRecord, type DraftResidueContext } from '../../self-dev/draft-residue.js';
import { assessSiWarmReply, decideSiWarmNextStep, type SiWarmCommand, type SiWarmReply,
  type SiWarmReturnedBytes } from './pod-si-warm-protocol.js';
import { cleanAndReturnChildPod, type ChildPodReuseOperations } from './pod-child-reuse.js';
import { executeSiWarmTransport, type SiWarmFixedRunner,
  type SiWarmPodIdentity } from './pod-si-warm-transport.js';

export const POD_CONTROL_INBOX_DIR = '/tmp/elanous-control.inbox';
/** Pod Job 수명 상한(`activeDeadlineSeconds`) — 대표 2026-09-26 90분 → 180분(90분에 `DeadlineExceeded` 로 죽은 런 둘). */
/** Newest pod log bytes returned when the export passes the 5MB artifact limit (headroom under it). */
export const POD_LOGS_KEEP_BYTES = 4_500_000;

/** Re-emit the child's `{kind:"self", ok, result}` line as one flat `{...result, ok}` line at the end of /tmp/si.out.
 *  POD-NORESULT ⓑ (10-07 · 28 failed rc=2 Jobs read back): every child printed its result line, but one
 *  (si-task-71f68d57f6b7, image 0.2.15) had stderr lines (`[graph] collect fail`) after it, so the old
 *  «last line only» check skipped the flatten and the host kept `ok:false` with no stage or PR number.
 *  Scan back to a terminal child result; an interim JSON row or successful row on rc≠0 cannot hide a later failure.
 *  Keep this shell command on one physical line: Job command extraction consumes it as one line. */
export const POD_RESULT_FLATTEN = `ELANOUS_CHILD_RC="$rc" bun -e ' const fs=require("fs"); const p="/tmp/si.out"; const lines=fs.readFileSync(p,"utf8").trimEnd().split("\\n"); const failed=Number(process.env.ELANOUS_CHILD_RC)!==0; let terminal=null; let appendTerminal=false; let successIndex=-1; for(let i=lines.length-1;i>=0;i--){ const l=lines[i].trim(); if(!l.startsWith("{"))continue; let o; try{o=JSON.parse(l)}catch{continue} if(!o||typeof o!=="object"||Array.isArray(o))continue; const nested=o.kind==="self"&&o.result&&typeof o.result==="object"&&!Array.isArray(o.result); const flat=nested ? {...o.result,...(typeof o.ok==="boolean"?{ok:o.ok}:{})} : o.kind===undefined?o:null; if(!flat||typeof flat.ok!=="boolean"||typeof flat.stage!=="string"||!flat.stage||flat.stage==="running")continue; if(failed&&flat.ok===true){successIndex=i;break;} terminal=flat; appendTerminal=i!==lines.length-1||flat!==o; break; } let reason=""; let reasonIndex=-1; if(failed){ for(let i=successIndex>=0?successIndex+1:0;i<lines.length;i++){ const l=lines[i].trim(); if(/골 완료 경계 누락|self-implement PR guard 실패|draft PR 생성 실패/u.test(l)){ reason=l;reasonIndex=i; }else if(/^(Error:|❌)/u.test(l)&&(!reason||lines.slice(reasonIndex+1,i).some(x=>x.trim().startsWith("[retry]")||x.trim().startsWith("재시도:")))){ reason=l;reasonIndex=i; } } } if(terminal){ if(appendTerminal)fs.appendFileSync(p,"\\n"+JSON.stringify(terminal)+"\\n"); }else if(failed){ if(reason)fs.appendFileSync(p,"\\n"+JSON.stringify({stage:reason.includes("골 완료 경계 누락")?"preflight-blocked":"error",ok:false,error:lines.slice(reasonIndex).join("\\n").trim().slice(0,4000)})+"\\n"); else if(successIndex>=0)fs.appendFileSync(p,"\\n"+JSON.stringify({stage:"error",ok:false,error:"child exited rc="+process.env.ELANOUS_CHILD_RC+" after a success result without a terminal failure result"})+"\\n"); }'`;

export const POD_JOB_DEADLINE_SECONDS = 10_800;

/** 자식 컨테이너 «요청» — 🩸 2026-09-27: limits 만 두면 k8s 가 requests=limits(cpu 4)로 잡아, 32코어 노드에
 *  «자리 요청»이 88% 차서 잡이 Pending 인데 실사용은 14%였다(풀 25 자리 중 ~8 만 떴다). 상한(limits)은 그대로 두고
 *  예약만 실사용에 맞춘다. */
// POD-DIET (10-06 03:47~05:18 · node-b goal Pods · 89 one-minute samples · 42 Pods): per-Pod observed max median 4.6Gi ·
// p75 6.2Gi · p90 11.7Gi — 23/42 went above the old 4Gi request, so the scheduler over-packed. 6Gi ≈ p75; limits stay.
// Node allocatable ≈ 343Gi ≫ 25 × 6Gi. One-minute samples can miss the true peak (lower bound).
import { POD_LAUNCH_FINISHED_EVENT, POD_LAUNCH_STARTED_EVENT, provenanceRowFromAnnotations, siTaskPodProvenance } from './pod-launch-history.js';
import { podProvenanceMetadata, type PodProvenanceMetadata } from './pod-provenance.js';
import { packageVersion } from '../../version/code-revision.js';
import { podWorkLabels, type PodWorkIdentity, type PodPlacement, type PodPlacementKind, type PodPoolMember, type PodPoolScheduler } from './pod-pool.js';
export { POD_CHILD_REQUESTS } from './pod-lease.js';
import { measurePoolLease, recommendConcurrency, POD_CHILD_REQUESTS, POD_SI_ADMISSION_CAP_BYTES, POD_HOST_LEASE_ANNOTATION, POD_JOB_TTL_AFTER_FINISHED_SECONDS, LEASE_KUBECTL_MAX_BUFFER, memoryQuantityBytes } from './pod-lease.js';
import { ACTUAL_SUBSTRATE_ENV, RUN_CONTRACT_ENV, carryRunContract, completionFloorFor } from '../../self-implement/graph-run-contract.js';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { findGitDir } from '../../git-fs/locate.js';
import { hostLeaseBaseDir } from '../../pod-lease/host-lease.js';
import { acquireLockAsync } from '../../storage/file-lock.js';
import { debug, redactSecretText } from '../../debug/log.js';
import { enterJourneyNode, exitJourneyNode, passJourneyNode } from '../../self-dev/graph-journey-nodes.js';
import { routeJourneyEdge } from '../../self-dev/graph-journey-route.js';
import { selectLiveDetail } from '../../live/detail-switch.js';
import { authStorePath } from '../../oauth/store.js';
import { grokAuthFilePath, isGrokSubscriptionExpiring, refreshGrokSubscriptionToken, resolveGrokCredential, type GrokRefreshOutcome } from '../../grok/credential.js';
import { defaultGrokModel } from '../../grok/models.js';
import { resolveHostId } from '../../platform/host-id.js';
import { BUDGET_SNAPSHOT_ENV, encodeBudgetSnapshot, harnessLaunchBudgetDecision, type BudgetSnapshot } from '../../execution-loop/launch-gate.js';
import type { ReadBudgetInputsDeps } from '../../self-implement/budget-gate.js';
import { envLiteral } from '../../platform/env-literal.js';
import { LLM_TIER_MAP_BY_PROVIDER, lookupLlmTierSpec, type LlmTierProvider } from '../../model-tier/llm-tier-map.js';
import { parseSelfImplementJson, type SelfImplementJobDone, type SelfImplementJobSpawn } from './self-implement.js';
import { codexQuotaPolicyFromConfig } from '../../oauth/codex-account-store.js';
import { normalizeFallbackChain, type FallbackStep } from '../../oauth/fallback-chain.js';
import { goalTypeOf, type GoalType } from '../../../scripts/measure-pod-memory-by-goal.js';
import { declaredGoalType, type GoalType as DeclaredGoalType } from '../../self-implement/goal-author.js';
import { readPodMemoryAdvice, type PodMemoryAdvice } from '../../cli/pod-memory-advice.js';
import { DEFAULT_BUDGET_GATE_MAX_USED_PERCENT, getUserConfig, roleLlmEnvName, type UserConfig } from '../../user-config.js';
import { podChildProviderOf, podChildProviderRefusal, type PodChildProvider } from './pod-child-providers.js';
import { BEDROCK_POD_EGRESS_LABEL, bedrockPodEnv, checkBedrockPodSecret, type BedrockPodSpec } from './pod-bedrock-child.js';
import { resolveBedrockRegion, validBedrockRegion } from '../../llm/bedrock.js';
import { ZAI_POD_EGRESS_LABEL, checkZaiPodSecret, countActiveZaiJobs, decideZaiPodSlot, zaiOverflowChildArgs, zaiPodEnv, type ZaiPodSpec } from './pod-zai-child.js';
import { ZAI_CODING_DEFAULT_MODEL, ZAI_OPENROUTER_FALLBACK_MODEL, zaiSettingsFromConfig, type ZaiCodingPlanSettings } from '../../llm/zai-coding-plan.js';
import { normalizePlanningFallbackReason, selectEnhanceLlm } from '../../prompt-enhance/enhance.js';
import { inferProviderFromModel } from '../../llm.js';
import { classifyPodExit, extractPodFailureReason, podChildFailureAttribution, podTerminalRow, POD_TERMINATION_JOB_JSONPATH, POD_TERMINATION_PODS_JSONPATH, readPodTermination, type PodExitClass, type PodTermination } from './pod-failure-reason.js';
import { kubectlTransientReason, retryKubectlTransient } from './kubectl-transient-retry.js';
import { OLD_DOOR_STAMP_ENV } from '../../self-dev/old-door.js';
import { resolveDefaultSourceHead, seedMirrorOnce, type MirrorSeedResult } from './pod-mirror-seed.js';
import { decideWarmReuse, type WarmReuseEvidenceByConsumer, type WarmReuseSwitchConfig } from './pod-warm-switch.js';
import type { WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import type { WarmPodTransportResult } from './pod-warm-worker-pod.js';

export type Kubectl = (args: readonly string[], input?: string, timeoutMs?: number) => { status: number | null; stdout: string; stderr: string };

/** TC's si-v1 transport supplies this receipt. No lease is considered reusable from a Job exit alone. */
export interface SiWarmChildAttempt {
  leaseFenced: boolean;
  command: SiWarmCommand | null;
  /** The consumer executes this fenced transport. A provider cannot assert its own reply verdict. */
  transport: { pod: SiWarmPodIdentity; runner: SiWarmFixedRunner; now?: () => number };
  payload: Uint8Array;
  credentialBundle: Uint8Array;
  /** Collect verified ledger/artifact bytes into the existing host stores. */
  adopt: (command: SiWarmCommand, reply: SiWarmReply, bytes: SiWarmReturnedBytes) => Promise<void>;
  cleanup: ChildPodReuseOperations;
  /** The provider fences a worker even when a transport failure hides its command receipt. */
  quarantineUnknown: (reason: string) => Promise<void>;
}
type OpenPrByBranch = { status: 'found'; prNumber: number; prUrl: string }
  | { status: 'not-found' | 'failed'; reason: string };

/** TC supplies the validated candidate/lease transport. UX only forwards its request command. */
export type WarmPodRequestHook = (request: { command: WarmWorkerCommand }) => Promise<WarmPodTransportResult> | WarmPodTransportResult;

// gh auth login may reject installation tokens when validating /user. Its config is
// still the credential source for gh and setup-git's helper. Install it privately
// on that failure; rename keeps concurrent readers from seeing a partial token.
const APP_GH_CONFIG_PATH = '$HOME/.config/gh';
// PODCRED2 (10-05) — GitHub App installation tokens now carry `.` and `-` (390 chars on node-b); the old
// `[A-Za-z0-9_]+` check rejected every real token, so any transient `gh auth login` failure became exit 7.
export const APP_GH_AUTH_SCRIPT = 'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");const token=fs.readFileSync(0,"utf8").replace(/\\r?\\n$/,"");if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(token))process.exit(1);const dir=process.env.GH_CONFIG_DIR||path.join(process.env.HOME,".config/gh");fs.mkdirSync(dir,{recursive:true,mode:0o700});const dest=path.join(dir,"hosts.yml"),temp=path.join(dir,".hosts.yml."+crypto.randomUUID());try{fs.writeFileSync(temp,"github.com:\\n    oauth_token: "+token+"\\n    git_protocol: https\\n",{mode:0o600,flag:"wx"});fs.renameSync(temp,dest);fs.chmodSync(dest,0o600)}finally{try{fs.unlinkSync(temp)}catch{}}';
const APP_GH_AUTH_COMMAND = `bun -e '${APP_GH_AUTH_SCRIPT}'`;
const APP_GH_EXEC = `unset GH_TOKEN GITHUB_TOKEN; GH_CONFIG_DIR="${APP_GH_CONFIG_PATH}" exec "$@"`;

export interface PodSpawnOptions {
  /** si-v1 living worker consumer. Absent means the existing one-shot Job path. */
  siWarmAttempt?: (input: Parameters<SelfImplementJobSpawn>[0]) => Promise<SiWarmChildAttempt | null>;
  /** POD-REUSE-SI-PROVIDER-WIRE: must apply cold-path host regate, ACP, terminal and repair checks before warm adoption. */
  siWarmHostPostprocess?: (result: SelfImplementJobDone, attempt: SiWarmChildAttempt,
    input: Parameters<SelfImplementJobSpawn>[0]) => Promise<SelfImplementJobDone>;
  /** Injected test ledger; production writes to the existing run ledger. */
  siWarmLedger?: (entry: RunLedgerEntry) => void;
  /** 이미지 판(라벨 elanous.commit) — 주입(시험·감독기가 이미 잰 값). 없으면 docker 로 잰다. */
  imageCommit?: string | null;
  /** codex 계정 이름(`~/.elanous/auth.json` 의 `openai-codex:<이름>`). 기본 team. */
  account?: string;
  /** Job 마다 계정을 고른다(pod-account-broker) — 있으면 `account` 보다 먼저. */
  accountBroker?: () => string;
  /** Usable codex accounts from the broker; the allocated account is moved to the front per Job. */
  rotationAccounts?: readonly string[];
  /** 미지정이면 종전 Codex Job. */
  provider?: PodChildProvider;
  /** Host launch-gate verdict for this Job's child LLM (test seam) — the Pod gate follows it instead of judging again. Default: the host's own `harness` launch-gate decision (chain ⊕ user caps). */
  budgetSnapshot?: (childLlm: PodBudgetChildLlm) => Promise<BudgetSnapshot | undefined> | BudgetSnapshot | undefined;
  /** Input reader seam; the host still runs its normal budget decision and Job propagation. */
  budgetInputDeps?: ReadBudgetInputsDeps & { readLiveGrok?: () => Promise<number | undefined> };
  /** Test seam for the planning Codex quota check; production reads the existing budget-gate candidates. */
  planningCodexQuota?: (account: string) => { usable: boolean; reason?: string };
  /** Child model/effort chosen at launch (`--child-llm-model/--child-llm-effort`) — carried into the Pod child. */
  childModel?: string;
  childEffort?: string;
  /** True when the child provider was named at launch — the child gets explicit flags even for codex. */
  childProviderExplicit?: boolean;
  /** 🔐 API 키 과금 허용은 명시 true 뿐. */
  grokApiKeyOptIn?: boolean;
  namespace?: string;
  /** 클러스터 안 이미지(`docker/harness/run.sh` 가 만드는 `elanous-harness:local`). */
  image?: string;
  repoUrl?: string;
  /** 호스트 Git 미러 디렉터리 — 명시 옵션 > 환경변수 > pod.hostMirror. */
  hostMirror?: string;
  /** TA-POD-WARMBOOT-PARITY — the child prints this launch's result marker last and the host ends its wait on it when the
   *  Job condition lags (pod-result-marker-wait.ts). Default: on, off with an injected kubectl (tests) unless set. */
  resultMarker?: boolean;
  /** TA-POD-WARMBOOT-PARITY — seeds a commit-pinned source into the pool host mirror before the Job (test seam · default
   *  {@link seedMirrorOnce}; none with an injected kubectl unless given). */
  seedMirror?: (o: { host: string; commit: string; cwd: string }) => Promise<MirrorSeedResult | undefined>;
  /** Git tree that has the pinned commit for the mirror seed (default: process.cwd()). */
  mirrorSeedCwd?: string;
  /** TA warm-reuse shadow evidence/config seams. Missing evidence must stay off; no warm candidate is consumed here. */
  warmReuseConfig?: () => WarmReuseSwitchConfig | undefined;
  warmReuseEvidence?: () => WarmReuseEvidenceByConsumer | undefined;
  /** Optional warm-pool observation/preparation hook. It never replaces the feature implementation Job. */
  warmPodRequest?: WarmPodRequestHook;
  /** SI-SEED-DEFAULT — resolves a default source's branch tip for the mirror seed (test seam · default
   *  {@link resolveDefaultSourceHead}; none with an injected kubectl unless given). */
  resolveSourceHead?: (o: { repoUrl: string; base?: string; cwd: string }) => Promise<{ sha?: string; reason?: string }>;
  /** 설정 읽기(시험 주입). kubectl 주입 시험에서는 기본 사용자 설정을 읽지 않는다. */
  configHostMirror?: () => string | undefined;
  /** AUTHOR-POD2 host config seam; Pod itself has no host config. */
  authorConfig?: () => UserConfig;
  /** Host fallback chain seam; a Pod has no access to the host config. */
  fallbackConfig?: () => UserConfig;
  /** Host OpenGateway key config seam; unit tests inject isolated config without bypassing production reads. */
  openGatewayConfig?: () => UserConfig;
  /** 원천 — 없으면 종전 `git clone --depth 50`. bundle 이면 apply 뒤 kubectl cp 로 싣는다. */
  source?: PodSource;
  /** Existing PR repair: pin the source head and export a commit bundle instead of opening a PR. */
  repairCommitOnly?: { pr: number; baseHead: string };
  /** 호스트 환경에서 읽어 Pod env 로 넣을 키 이름(예: OPENROUTER_API_KEY · ANTHROPIC_API_KEY) — 벤치마크 과금 경로. */
  passEnv?: readonly string[];
  /** 호스트가 재발사를 소유하면 Pod 자식의 자체 감독을 끈다. 독립 호출 기본 true; 실제 CLI 호스트는 자기 감독 상태를 명시한다. */
  hostSupervised?: boolean;
  /** 자식 `self implement` 에 덧붙일 인자. */
  extraArgs?: readonly string[];
  /** Pod 에 그대로 넣을 «비밀 아닌» env — 벤치 팔의 `ELANOUS_LLM_PROVIDER`·`ELANOUS_LLM_MODEL`·`ELANOUS_ARM_ID`. */
  armEnv?: Readonly<Record<string, string>>;
  /** POD-ROLE-LLM — OpenRouter 자식 Pod 의 리뷰어 고정(기본 `glm` · env `ELANOUS_POD_OR_REVIEWER`). 다른 provider Pod 에선 무시. */
  openrouterReviewer?: PodOpenRouterReviewer;
  /** Job 수명 상한(초). */
  deadlineSeconds?: number;
  pollMs?: number;
  /** METER-POD-ROLLUP-GAP-3 — 런 도중 PARTIAL 표본을 거두는 폴 간격 수(시험 seam · 기본 POD_USAGE_PARTIAL_CAPTURE_MS ÷ pollMs). */
  usagePartialCapturePolls?: number;
  /** LAUNCH-STALL: ms a launch may wait in one stage before `launch-stalled` (test seam; default harness.launchStallMinutes · 15 min). */
  launchStallMs?: number;
  kubectl?: Kubectl;
  /** Host-side regate (injected for Pod tests). */
  hostRegate?: (input: { prNumber: number; headCommit: string; repoRoot: string; goalFile?: string; noMerge?: true }) => Promise<HostRegateResult>;
  /** REVIEW-ACP-POD — Pod merge-ready PR 을 호스트 Claude ACP 로 리뷰한 뒤 재게이트(opt-in · 옵션 → env `ELANOUS_POD_HOST_ACP_REVIEW` → config `llm.podHostAcpReview`). */
  hostAcpReview?: boolean;
  /** REVIEW-ACP-POD — 호스트 ACP 리뷰 seam(시험 주입 · 기본 `runPodHostAcpReview`). */
  podHostAcpReview?: (input: { prNumber: number; headCommit: string; repoRoot: string; job?: string }) => Promise<PodHostAcpReviewOutcome>;
  /**
   * TA-LIVE-LAND-2 — `taskAgent.liveMoves` (test seam; default reads the user config). Consulted only when the run carries
   * the `ELANOUS_TA_LAND=1` marker (`tasks hand --ta-land`): with `propose-land` the host re-gates but leaves the merge to
   * the task agent's `executeLiveLand` → `pr land --expected-head`.
   */
  taskAgentLiveMoves?: () => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** PR comment for host-regate failures that never reached runHostRegate (injectable for tests). */
  ghComment?: (prNumber: number, body: string) => void;
  /** Read-only host gh lookup; injected fixtures can stand in for gh without creating or closing a PR. */
  lookupOpenPrByBranch?: (branch: string, repoUrl: string) => Promise<OpenPrByBranch> | OpenPrByBranch;
  draftResidue?: (record: PrTerminalRecord, ctx: DraftResidueContext) => Promise<void> | void;
  /** 🔑 Pod 필수 스킬의 키(.env)를 이 런의 Secret 으로 넘긴다 — 명시 opt-in(유료 크레딧을 쓴다). */
  skillEnv?: boolean;
  /** 스킬 키 읽기(시험 주입) — `{ <스킬>: <.env 내용> }`. */
  readSkillEnv?: () => Record<string, string>;
  /** ☸️ 여러 클러스터 풀(pod-pool.ts) — Job 마다 우선순위 순 첫 빈 자리로. 없으면 현재 컨텍스트 하나. */
  pool?: PodPoolScheduler;
  /** ☸️ 원격 그라운딩 주소(P13) — 없으면 호스트 env ELANOUS_GROUNDING_URL → 설정 pod.groundingUrl. 셋 다 없으면 토큰을 안 만든다. */
  groundingUrl?: string;
  /** 시험 심 — 토큰 발급·회수. GitHub credential 토큰에는 호스트가 검증한 저장소를 서명한다. */
  mintGrounding?: (claims: { runId: string; job: string; ttlMs: number; scope?: GroundingTokenScope; repository?: string }) => Promise<{ token: string; exp: number }>;
  revokeGrounding?: (runId: string) => void;
  /** Test seam for the host's repository-scoped GitHub App installation token. */
  /** `fresh` = do not reuse a coalesced token (the exit-7 retry must not get the token that just failed back). */
  githubInstallation?: (repository: string, opts?: { fresh?: boolean }) => { token: string; expires_at?: string; expiresAt?: string | number } | null;
  /** GitHub installation repository lookup; required to prove the scoped token matches owner/name. */
  githubRepositories?: (token: string) => Promise<readonly string[] | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  credentials?: (account: string) => { elanousAuth: string; codexAuth: string; ghToken: string };
  /** POD-TOKEN-PREREFRESH 시험 심 — «3시간 안 만료» 계정의 호스트 선갱신(기본 refreshCodexAccountHome). */
  codexPrerefresh?: (account: string) => Promise<{ ok: true; beforeH: number | null; afterH: number | null } | { ok: false; kind: string; message: string }>;
  /** PREREFRESH-LOCK 시험 심 — 계정별 갱신 잠금 파일 경로(기본 = 그 계정 codexHome 옆). */
  codexPrerefreshLockPath?: (account: string) => string | null;
  /** 시험 심 — 이 호스트가 본부 임대 보유자인가(기본 HQ 펜스 · kubectl 주입 시험이면 false). */
  hqLeaseHolder?: () => boolean | Promise<boolean>;
  grokCredentials?: () => { grokAuth?: string; grokApiKey?: string; ghToken: string };
  /** API 키 자식(openrouter · anthropic)의 gh 토큰 — 시험 주입. */
  openrouterGhToken?: () => string;
  /** POD-ANTHROPIC-PROVIDER — anthropic 자식의 API 키(시험 주입). 기본 = 제품 자격 해석 `getAnthropicApiKey()`(키 캐시 → env).
   *  ⛔ kubectl 주입(=시험)이면 실 캐시를 안 읽는다 — env ⊕ readKeyCache 만 본다. */
  anthropicKey?: () => string | undefined;
  /** BEDROCK-PROVIDER ② — 호스트 리전(시험 주입). 기본 = `resolveBedrockRegion`(env → ~/.aws/config 의 region 한 칸).
   *  ⛔ kubectl 주입(=시험)이면 실 ~/.aws 를 안 읽는다 — env 의 AWS_REGION/AWS_DEFAULT_REGION 만 본다. */
  bedrockRegion?: () => string | undefined;
  /** ZAI-POD-CHILD — glm(ZAI) Pod 의 동시 상한·넘침 정책(시험 주입). 기본 = `llm.zaiCodingPlan`(`zaiSettingsFromConfig`). */
  zaiSettings?: () => ZaiCodingPlanSettings;
  /** 호스트 키 캐시(`~/.cache/<소문자 이름>`)에서 키를 읽는다(시험 주입) — env 에 없을 때. */
  readKeyCache?: (name: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Detail switch file (test injection; defaults to the host's local/production selection). */
  liveDetailFile?: string;
  /** Test seam for the opt-in user configuration; otherwise read the active user config. */
  adviseDefaults?: boolean;
  /** Test seam for the read-only measured advice. */
  memoryAdvice?: () => PodMemoryAdvice;
}

export function defaultKubectl(args: readonly string[], input?: string, timeoutMs = 120_000): { status: number | null; stdout: string; stderr: string } {
  // 셸 프록시가 kubectl 의 로컬 API 요청을 가로챈다(2026-09-25 실측) — 자식 env 에서 뺀다.
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const r = spawnSync('kubectl', [...args], { encoding: 'utf8', input, env, timeout: timeoutMs, maxBuffer: LEASE_KUBECTL_MAX_BUFFER });
  const error = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS'
    ? `kubectl 출력 너무 큼 (ENOBUFS; maxBuffer=${LEASE_KUBECTL_MAX_BUFFER} bytes)`
    : r.error ? String(r.error) : '';
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + error };
}

/** Job·Secret 이름 — 런마다 다르게(병렬) · k8s 이름 규칙(소문자·숫자·하이픈 · 63자 이하). */
export function podJobName(spaceId: string): string {
  const slug = spaceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hash = createHash('sha256').update(spaceId).digest('hex').slice(0, 8);
  return `si-${slug || 'job'}-${hash}`.replace(/-+/g, '-').slice(0, 58);
}

/** The child LLM the Pod's delegated `harness say/ask` will be launched with — the question the host verdict answers. */
export interface PodBudgetChildLlm { provider?: string; model?: string }

/** The one host-side budget verdict a Pod Job carries (BUDGET-SNAPSHOT-TO-POD). Fail-soft: no snapshot means the Pod marks the budget unmeasured. */
function hostBudgetSnapshot(childLlm: PodBudgetChildLlm, options: PodSpawnOptions, env: NodeJS.ProcessEnv, job: string): Promise<BudgetSnapshot | undefined> | BudgetSnapshot | undefined {
  const unavailable = (error: unknown): undefined => {
    try { debug.log('self-implement.pod', 'budget-snapshot-unavailable', { job, provider: childLlm.provider ?? null, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); } catch { /* observation is fail-soft */ }
    return undefined;
  };
  let measurement: Promise<BudgetSnapshot | undefined> | BudgetSnapshot | undefined;
  try {
    measurement = options.budgetSnapshot ? options.budgetSnapshot(childLlm) : measureHostBudgetSnapshot(childLlm, env, options.budgetInputDeps);
  } catch (error) { return unavailable(error); }
  if (!(measurement instanceof Promise)) return measurement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(unavailable(new Error('host budget snapshot timed out after 10s'))), 10_000);
  });
  return Promise.race([measurement, deadline]).catch(unavailable).finally(() => { if (timer) clearTimeout(timer); });
}

/** The host runs the same launch-gate judgement the Pod would (chain ⊕ the user's caps) and ships the verdict, not raw usage to re-judge. */
async function measureHostBudgetSnapshot(childLlm: PodBudgetChildLlm, env: NodeJS.ProcessEnv, inputDeps?: ReadBudgetInputsDeps & { readLiveGrok?: () => Promise<number | undefined> }): Promise<BudgetSnapshot | undefined> {
  const host = resolveHostId(env);
  const measuredAt = Date.now();
  const { readBudgetInputsLive, CODEX_PROVIDER, GROK_PROVIDER } = await import('../../self-implement/budget-gate.js');
  const inputs = await readBudgetInputsLive(inputDeps);
  const { decision } = harnessLaunchBudgetDecision(inputs, { ...(childLlm.provider ? { childLlmProvider: childLlm.provider } : {}), ...(childLlm.model ? { childLlmModel: childLlm.model } : {}) });
  const provider = decision.provider ?? childLlm.provider ?? 'chain';
  const used = provider === GROK_PROVIDER
    ? inputs.grokUsedPercent
    : provider === CODEX_PROVIDER
      ? (() => {
          const percents = inputs.codexCandidates
            .map((candidate) => candidate.reached === true ? 100 : candidate.usedPercent)
            .filter((percent): percent is number => typeof percent === 'number' && Number.isFinite(percent));
          return percents.length === 0 ? undefined : Math.min(...percents);
        })()
      : undefined;
  return {
    provider, ...(used !== undefined ? { remaining: Math.min(100, Math.max(0, 100 - used)) } : {}), window: 'weekly', measuredAt, host,
    ...(childLlm.provider ? { requested: childLlm.provider } : {}),
    decision: { action: decision.action, ...(decision.provider ? { provider: decision.provider } : {}), ...(decision.model ? { model: decision.model } : {}) },
  };
}

/** Planning uses a subscription account inside an OpenRouter Pod. Credits are not a silent fallback for this role. */
async function hostPlanningCodexQuota(account: string, deps?: ReadBudgetInputsDeps): Promise<{ usable: boolean; reason?: string }> {
  try {
    const { readBudgetInputs } = await import('../../self-implement/budget-gate.js');
    const inputs = readBudgetInputs(deps);
    const candidate = inputs.codexCandidates.find((item) => item.name === account);
    const configuredCap = inputs.maxUsedPercent['openai-codex'];
    const cap = typeof configuredCap === 'number' && Number.isFinite(configuredCap) ? configuredCap : DEFAULT_BUDGET_GATE_MAX_USED_PERCENT['openai-codex']!;
    if (!candidate || typeof candidate.usedPercent !== 'number' || !Number.isFinite(candidate.usedPercent)) return { usable: false, reason: 'quota-unmeasured' };
    if (candidate.reached === true || candidate.usedPercent >= cap) return { usable: false, reason: 'quota-exhausted' };
    return { usable: true };
  } catch { return { usable: false, reason: 'quota-unavailable' }; }
}

/** «3시간 안 만료» — 선갱신 대상이라는 표지(다른 자격 오류와 구분한다). */
export class PodCodexExpiringError extends Error {
  constructor(readonly account: string, readonly hoursLeft: number) {
    super(`openai-codex:${account} access token 이 3시간 안에 만료 — 호스트에서 먼저 갱신(컨테이너는 갱신 못 한다)`);
  }
}

export type PodCredentialPrerefreshOutcome =
  | 'refreshed' | 'still-expiring' | 'refresh-failed' | 'no-lease'
  // PREREFRESH-LOCK (10-06): a peer refreshed it while we waited for the lock · a failed refresh's one re-check.
  | 'refresh-skipped-already-fresh' | 'refresh-failed-recheck-ok' | 'refresh-failed-recheck-failed'
  // 갱신을 «시도하지 않았다» — 잠금 자리를 못 구했거나 잠금을 못 잡았다(갱신 실패와 가른다 · reason = no-lock-path|lock-timeout|lock-error).
  | 'lock-unavailable';

/** POD-TOKEN-PREREFRESH (10-06) — «3시간 안 만료» 계정은 거부만 하지 말고 선갱신을 한 번 시도한다.
 *  🩸 05:3x team · 09:47 third: 거부만 하고 다음 계정으로 안 넘어가 그 계정으로 뽑힌 Pod 런이 전부 pod-error.
 *  ⛔ 갱신은 본부(HQ) 임대 보유자 한 곳에서만 — refresh 토큰은 갱신마다 회전해 두 곳이 갱신하면 로그아웃된다.
 *  ⭐ PREREFRESH-LOCK (10-06 · #24449 사후 리뷰): 같은 호스트의 두 런이 같은 계정을 «동시에» 고르면 갱신이 둘이 돌아
 *     뒤엣것이 회전된 refresh 토큰으로 실패하고 그 계정을 버렸다. ⇒ 계정별 파일 잠금 안에서 ⑴ 먼저 다시 읽어
 *     이미 신선하면 갱신하지 않고 ⑵ 갱신이 실패해도 한 번 다시 읽어(동료가 갱신했을 수 있다) 신선하면 쓴다.
 *  null = 이 계정은 후보에서 뺀다(호출자가 다음 계정으로). 만료 아닌 다른 자격 오류는 그대로 던진다. */
export async function podCodexCredentialWithPrerefresh(account: string, deps: {
  credentials: (account: string) => { elanousAuth: string; codexAuth: string; ghToken: string };
  refresh: (account: string) => Promise<{ ok: true; beforeH: number | null; afterH: number | null } | { ok: false; kind: string; message: string }>;
  isLeaseHolder: () => boolean | Promise<boolean>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 계정별 갱신 잠금 파일(기본 = 그 계정 codexHome 옆 · `codexAccountRefreshLockPath`). null = 잠금 없음. */
  lockPath?: (account: string) => string | null;
  /** 잠금 대기 조정(시험 심) — 기본 CODEX_REFRESH_LOCK_OPTS. */
  lockOpts?: { staleMs?: number; retryBusyMs?: number; maxTries?: number };
}): Promise<{ elanousAuth: string; codexAuth: string; ghToken: string } | null> {
  const log = deps.log ?? ((category, event, data) => debug.log(category, event, data));
  try { return deps.credentials(account); }
  catch (error) {
    if (!(error instanceof PodCodexExpiringError)) throw error;
    const beforeH = error.hoursLeft;
    const observe = (outcome: PodCredentialPrerefreshOutcome, afterH: number | null, reason?: string) => {
      try { log('pod.credential-prerefresh', outcome, { account, beforeH, afterH, outcome, ...(reason ? { reason } : {}) }); } catch { /* observation is fail-soft */ }
    };
    let holder = false;
    try { holder = await deps.isLeaseHolder(); } catch { holder = false; }
    if (!holder) { observe('no-lease', null); return null; }
    /** One re-read: fresh credential, null when still expiring. Other credential errors throw. */
    const reread = (): { elanousAuth: string; codexAuth: string; ghToken: string } | { expiringH: number } => {
      try { return deps.credentials(account); }
      catch (again) {
        if (!(again instanceof PodCodexExpiringError)) throw again;
        return { expiringH: again.hoursLeft };
      }
    };
    const codex = await import('../../oauth/codex.js');
    let lockPath: string | null = null;
    let lockUnknown = false;
    try { lockPath = (deps.lockPath ?? ((name: string) => codex.codexAccountRefreshLockPath(name)))(account); } catch { lockUnknown = true; }
    // 이름 있는 계정인데 잠금 자리를 못 구하면 잠금 없이 갱신하지 않는다 — 막으려던 중복 갱신이 그 자리에서 재발한다.
    // 갱신은 건너뛰고 한 번만 다시 읽는다(동료가 이미 갱신했으면 그대로 쓴다).
    if (lockUnknown || (lockPath === null && account !== (await import('../../oauth/codex-account.js')).DEFAULT_CODEX_ACCOUNT)) {
      const late = reread();
      if (!('expiringH' in late)) { observe('refresh-skipped-already-fresh', null, 'no-lock-path'); return late; }
      observe('lock-unavailable', null, 'no-lock-path');
      return null;
    }
    const critical = async () => {
      // ⑴ 잠금을 기다리는 사이 동료 런이 갱신했으면 그대로 쓴다 — 두 번째 갱신이 회전된 토큰으로 실패하는 자리.
      const first = reread();
      if (!('expiringH' in first)) { observe('refresh-skipped-already-fresh', null); return first; }
      // The lease can transfer while an account lock is queued. Recheck inside the
      // critical section, immediately before the only refresh-token operation.
      let stillHolder = false;
      try { stillHolder = await deps.isLeaseHolder(); } catch { stillHolder = false; }
      if (!stillHolder) { observe('no-lease', null, 'lease-lost-before-refresh'); return null; }
      let refreshed: Awaited<ReturnType<typeof deps.refresh>> | null = null;
      let failReason = 'threw';
      try { refreshed = await deps.refresh(account); }
      catch { refreshed = null; }
      if (refreshed && !refreshed.ok) failReason = refreshed.kind;
      if (!refreshed || !refreshed.ok) {
        observe('refresh-failed', null, failReason);
        // ⑵ 버리기 전에 한 번 다시 읽는다 — 다른 호스트 경로(사람 `account refresh`)가 방금 갱신했을 수 있다.
        let recheck: ReturnType<typeof reread>;
        try { recheck = reread(); } catch { observe('refresh-failed-recheck-failed', null, 'recheck-error'); return null; }
        if (!('expiringH' in recheck)) { observe('refresh-failed-recheck-ok', null); return recheck; }
        observe('refresh-failed-recheck-failed', recheck.expiringH);
        return null;
      }
      const after = reread();
      if ('expiringH' in after) { observe('still-expiring', after.expiringH); return null; }
      observe('refreshed', refreshed.afterH);
      return after;
    };
    try { return await codex.withCodexAccountRefreshLock(lockPath, critical, deps.lockOpts ?? codex.CODEX_REFRESH_LOCK_OPTS); }
    catch (lockError) {
      if (!(lockError instanceof codex.CodexRefreshLockUnavailableError)) throw lockError;
      // 잠금을 못 잡았다(대기 초과 · 잠금 파일 생성 실패) — 갱신은 하지 않고 한 번만 다시 읽는다.
      const late = reread();
      if (!('expiringH' in late)) { observe('refresh-skipped-already-fresh', null, lockError.reason); return late; }
      observe('lock-unavailable', null, lockError.reason);
      return null;
    }
  }
}

/** 기본 임대 판정 — 기존 HQ 펜스(`ledger-cli` 역할 · fail-open 없음)를 그대로 쓴다. */
async function defaultHqLeaseHolder(): Promise<boolean> {
  if (process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY === '1') return false;
  const { hqFenceDecision } = await import('../../hq/hq.js');
  return hqFenceDecision('ledger-cli').run;
}

/** 호스트 계정 → refresh 없는 사본(elanous 저장소 ⊕ codex auth.json) ⊕ gh 토큰. */
export function hostCredentials(account: string, storePath: string = authStorePath(), ghToken: () => string = defaultGhToken, options: { requireExplicitChatgptAuthMode?: boolean } = {}): { elanousAuth: string; codexAuth: string; ghToken: string } {
  // 경로는 해석기로(격리 게이트 · 2026-09-25) — 손으로 `~/.elanous/auth.json` 을 조립하면 test↔prod 격리가 새는 자리가 된다.
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { version?: number; providers: Record<string, Record<string, unknown>> };
  // ⭐ 기본 계정은 정본 키가 `openai-codex`(이름 없음)이고 홈을 안 적는다 — 기본 위치로 푼다(회전 후보와 같은 해석).
  const storeKey = account === 'default' ? 'openai-codex' : `openai-codex:${account}`;
  const entry = store.providers[storeKey] as { tokens: Record<string, unknown>; lastRefresh?: string; authMode?: string; codexHome?: string } | undefined;
  const codexHome = entry?.codexHome ?? (entry && account === 'default' ? resolveCodexAccount(envLiteral({ CODEX_HOME: process.env.CODEX_HOME })).home : undefined);
  if (!entry || !codexHome) throw new Error(`${storeKey} 계정이 없거나 codexHome 을 모른다`);
  const codex = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')) as { auth_mode?: string; tokens: Record<string, unknown> };
  // Remote parents must not infer this from store metadata; ordinary Pod callers retain the legacy fallback.
  if (options.requireExplicitChatgptAuthMode && codex.auth_mode !== 'chatgpt') throw new Error(`${storeKey} Codex CLI auth_mode must be explicitly chatgpt for remote parent`);
  const mirror = createCodexAccessMirror({ account, store, codexAuth: codex });
  const hoursLeft = (mirror.expiresAt - Date.now()) / 3_600_000;
  if (hoursLeft < 3) throw new PodCodexExpiringError(account, Math.round(hoursLeft * 10) / 10);
  // ⭐ P4(2026-09-26): both stores use the just-checked Codex access token; the stores refresh independently.
  return { elanousAuth: mirror.elanousAuth, codexAuth: mirror.codexAuth, ghToken: ghToken() };
}

/** POD-GROK-VALIDITY-FIT (10-17) — the Pod gets a refresh-less grok access copy, so the copy must outlive the Job.
 *  It used to require 3 h (= the full POD_JOB_DEADLINE_SECONDS), but the token lives only 6 h and the grok CLI renews it
 *  only right before expiry (`grok models`/`grok -p` leave `expires_at` unchanged — node-b refreshOutcome:"unchanged"), and
 *  the CLI has no forced-refresh command (`grok --help`/`grok login --help` 10-17: login·logout only). So half of every
 *  day refused grok Pod launches (10-17 node-b·node-c·mbp 9 no-launch · 3 hand re-logins).
 *  ⇒ The Job is fitted to the token instead: a launch is allowed when the token has at least a minimum Job
 *  (POD_GROK_MIN_JOB_SECONDS) plus a margin left, and that launch's `activeDeadlineSeconds` is cut to the token's
 *  remaining life minus the margin (`fitPodDeadlineToGrok`) — so a long run ends as a classified DeadlineExceeded
 *  instead of a silent mid-run 401. With the host credential relay (pod.groundingUrl) the Pod renews mid-run and
 *  nothing is cut. 90 min = the Job cap before 대표 09-26 raised it (only two runs had reached it). */
export const POD_GROK_MIN_JOB_SECONDS = 90 * 60;
/** Slack between the fitted Job end and the token expiry (clock skew · Pod scheduling). */
export const POD_GROK_EXPIRY_MARGIN_MS = 15 * 60_000;
/** Minimum remaining token life for a grok Pod launch = minimum Job + margin (1 h 45 m). */
export const POD_GROK_MIN_VALIDITY_MS = POD_GROK_MIN_JOB_SECONDS * 1000 + POD_GROK_EXPIRY_MARGIN_MS;

/** «1h45m» · «20m» · «만료» — remaining-time text for refusal lines (no token value). */
export function formatGrokRemaining(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '알 수 없음';
  if (ms <= 0) return '만료됨';
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/** Latest `expires_at` among scopes that carry an access key (the token the Pod would get). */
function grokSubscriptionExpiresAtMs(home?: string): number | null {
  try {
    const scopes = JSON.parse(readFileSync(grokAuthFilePath(home), 'utf8')) as Record<string, { key?: unknown; expires_at?: unknown }>;
    const all = Object.values(scopes).flatMap((s) => (s && typeof s.key === 'string' && s.key && typeof s.expires_at === 'string' && Number.isFinite(Date.parse(s.expires_at)) ? [Date.parse(s.expires_at)] : []));
    return all.length ? Math.max(...all) : null;
  } catch { return null; }
}

/** POD-GROK-VALIDITY-FIT — this launch's Job deadline for a refresh-less grok subscription copy.
 *  · relay (the Pod can renew from the host) or unknown expiry → the requested deadline as is.
 *  · otherwise → min(requested, remaining − margin); below the minimum Job (time passed since the credential check)
 *    the launch is refused — the deadline never outlives the token. */
export function fitPodDeadlineToGrok(o: { requestedSeconds: number; expiresAtMs: number | null; nowMs: number; relay: boolean }):
  { refused: false; deadlineSeconds: number; fitted: boolean; availableSeconds: number | null } | { refused: true; availableSeconds: number } {
  if (o.relay || o.expiresAtMs === null || !Number.isFinite(o.expiresAtMs)) return { refused: false, deadlineSeconds: o.requestedSeconds, fitted: false, availableSeconds: null };
  const availableSeconds = Math.floor((o.expiresAtMs - o.nowMs - POD_GROK_EXPIRY_MARGIN_MS) / 1000);
  if (availableSeconds < POD_GROK_MIN_JOB_SECONDS) return { refused: true, availableSeconds };
  if (availableSeconds >= o.requestedSeconds) return { refused: false, deadlineSeconds: o.requestedSeconds, fitted: false, availableSeconds };
  return { refused: false, deadlineSeconds: availableSeconds, fitted: true, availableSeconds };
}

/** Expiry of the access the Pod will actually use — only scopes with a key, latest wins (same rule as the Pod reader). */
export function shippedGrokExpiresAtMs(grokAuth: string): number | null {
  try {
    const scopes = JSON.parse(grokAuth) as Record<string, { key?: unknown; expires_at?: unknown }>;
    const all = Object.values(scopes).flatMap((sc) => (sc && typeof sc.key === 'string' && sc.key && typeof sc.expires_at === 'string' && Number.isFinite(Date.parse(sc.expires_at)) ? [Date.parse(sc.expires_at)] : []));
    return all.length ? Math.max(...all) : null;
  } catch { return null; }
}
/** PODCRED1 (10-05): an App installation token lives ~60 min and the host renews it in the Pod at the ten-minute
 *  boundary; below this remaining life at launch the token is observed (`github-app-short-lived`). */
export const POD_APP_TOKEN_MIN_START_MS = 20 * 60_000;
/** Exit 7 (in-Pod GitHub login failed) is retried once after this spread backoff — bursts were simultaneous launches. */
export const POD_GH_LOGIN_RETRY_BACKOFF_MS = 60_000;
/** Base backoff plus a 0-59 s spread derived from the job name, so jobs that failed together retry apart. */
export function podGhLoginRetryBackoffMs(job: string): number {
  let spread = 0;
  for (const ch of job) spread = (spread * 31 + ch.charCodeAt(0)) % 60;
  return POD_GH_LOGIN_RETRY_BACKOFF_MS + spread * 1000;
}

/** resolveGrokCredential 과 동일한 출처를 읽되 Pod 로는 refresh 없는 access 사본만 보낸다.
 *  POD4 (10-01): the copy used to ship whatever the host had — an AUTH1 shard copied a token that had expired
 *  4 minutes earlier and died at `grok-credential-preflight status=expired`. Refresh on the host first. */
export function hostGrokCredentials(opts: {
  home?: string; env?: NodeJS.ProcessEnv; apiKeyOptIn?: boolean; ghToken?: () => string;
  /** Test seams — the host refresh (read-only `grok models`) and the expiry probe. */
  refresh?: () => void; isExpiring?: () => boolean;
  /** Required remaining token life (default POD_GROK_MIN_VALIDITY_MS) — a caller whose Job is not fitted passes its own deadline. */
  minValidityMs?: number; now?: () => number;
} = {}): { grokAuth?: string; grokApiKey?: string; ghToken: string } {
  let credential = resolveGrokCredential({ home: opts.home, env: opts.env });
  if (credential?.kind === 'subscription') {
    const minValidityMs = opts.minValidityMs ?? POD_GROK_MIN_VALIDITY_MS;
    const expiring = opts.isExpiring ?? (() => isGrokSubscriptionExpiring({ home: opts.home, bufferMs: minValidityMs, ...(opts.now ? { now: opts.now } : {}) }));
    if (expiring()) {
      try { (opts.refresh ?? (() => { refreshGrokSubscriptionToken({ home: opts.home }); }))(); } catch { /* judged below */ }
      if (expiring()) {
        const at = grokSubscriptionExpiresAtMs(opts.home);
        const remainingMs = at === null ? null : at - (opts.now ?? Date.now)();
        try { debug.log('pod.grok-credentials', 'refused', { remainingMs, minValidityMs, expiresAt: at === null ? null : new Date(at).toISOString() }); } catch { /* fail-soft */ }
        throw new Error(`grok: 구독 access 토큰 남은 시간 ${formatGrokRemaining(remainingMs)} < Pod 발사 기준 ${formatGrokRemaining(minValidityMs)} — 호스트 갱신(grok models)도 못 늘렸다 · 다음: 호스트에서 grok login --device-auth 후 다시`);
      }
      credential = resolveGrokCredential({ home: opts.home, env: opts.env });
      if (credential?.kind !== 'subscription') throw new Error('grok: 갱신 뒤 구독 자격을 다시 읽지 못했다');
    }
    const scopes = JSON.parse(readFileSync(grokAuthFilePath(opts.home), 'utf8')) as Record<string, unknown>;
    const redacted: Record<string, { key: string; expires_at?: string; user_id?: string }> = {};
    for (const [name, value] of Object.entries(scopes)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const scope = value as Record<string, unknown>;
      if (scope.key !== credential.token) continue;
      redacted[name] = {
        key: scope.key,
        ...(typeof scope.expires_at === 'string' ? { expires_at: scope.expires_at } : {}),
        ...(typeof scope.user_id === 'string' ? { user_id: scope.user_id } : {}),
      };
    }
    if (!Object.keys(redacted).length) throw new Error('grok: 구독 access 토큰 없음');
    return { grokAuth: JSON.stringify(redacted), ghToken: (opts.ghToken ?? defaultGhToken)() };
  }
  if (credential?.kind === 'api_key' && opts.apiKeyOptIn === true) {
    return { grokApiKey: credential.token, ghToken: (opts.ghToken ?? defaultGhToken)() };
  }
  throw new Error('grok: 구독 자격 없음 · API 키 opt-in 꺼짐 또는 키 없음');
}

export type PodGrokSkipReason = 'missing' | 'expiring' | 'refresh-failed';

/** GROK-OPTIONAL (10-05) — may this launch plan put grok in the Pod's chain at all?
 *  The Pod copy must outlive the Job (POD_GROK_MIN_VALIDITY_MS), so an expiring subscription that the host cannot
 *  refresh is «not available» here: the plan drops grok and goes on with codex instead of failing every launch.
 *  AUT-GROK-CRED-EXPIRY-NO-LAUNCH (10-12): the refresh is already attempted once (`grok models`), but
 *  `refreshGrokSubscriptionToken` reports failure as a «value», never a throw — so a missing/broken CLI used to be
 *  read as `expiring`. The outcome is now classified (`failed`/`no-credential` → `refresh-failed`, `unchanged` →
 *  `expiring`) and every unusable verdict also lands as `harness.pod`/`grok-credential-unusable` so the autopsy and
 *  the dispatcher can group same-cause no-launches. ⛔ Never switches the provider here (billing path unchanged). */
export function podGrokSubscriptionUsable(opts: {
  home?: string; env?: NodeJS.ProcessEnv;
  /** Test seam — the host refresh. A returned outcome is classified; `void` counts as an attempt that did not fail. */
  refresh?: () => GrokRefreshOutcome | void; isExpiring?: () => boolean; expiresAt?: () => string | null;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
} = {}): { usable: true } | { usable: false; reason: PodGrokSkipReason; expiresAt: string | null } {
  const log = opts.log ?? ((category, event, data) => debug.log(category, event, data));
  const expiresAt = () => {
    if (opts.expiresAt) return opts.expiresAt();
    try {
      const scopes = JSON.parse(readFileSync(grokAuthFilePath(opts.home), 'utf8')) as Record<string, { expires_at?: unknown }>;
      const all = Object.values(scopes).flatMap((s) => (s && typeof s.expires_at === 'string' ? [s.expires_at] : []));
      return all.sort().at(-1) ?? null;
    } catch { return null; }
  };
  const skip = (reason: PodGrokSkipReason, refreshOutcome: GrokRefreshOutcome | 'threw' | 'not-attempted') => {
    const at = expiresAt();
    try { log('pod.grok-credentials', 'skipped', { reason, expiresAt: at, refreshOutcome }); } catch { /* observation is fail-soft */ }
    try { log('harness.pod', 'grok-credential-unusable', { reason, expiresAt: at, refreshOutcome, minValidityMs: POD_GROK_MIN_VALIDITY_MS }); } catch { /* fail-soft */ }
    return { usable: false as const, reason, expiresAt: at };
  };
  const credential = resolveGrokCredential({ home: opts.home, env: opts.env });
  if (credential?.kind !== 'subscription') return skip('missing', 'not-attempted');
  const expiring = opts.isExpiring ?? (() => isGrokSubscriptionExpiring({ home: opts.home, bufferMs: POD_GROK_MIN_VALIDITY_MS }));
  if (!expiring()) return { usable: true };
  let outcome: GrokRefreshOutcome | 'threw' = 'unchanged';
  try { outcome = (opts.refresh ?? (() => refreshGrokSubscriptionToken({ home: opts.home })))() ?? 'unchanged'; } catch { outcome = 'threw'; }
  if (!expiring()) return { usable: true };
  return skip(outcome === 'failed' || outcome === 'no-credential' || outcome === 'threw' ? 'refresh-failed' : 'expiring', outcome);
}

/** AUT-GROK-CRED-EXPIRY-NO-LAUNCH — read-only launch check for dispatchers: no refresh, no CLI spawn, no log.
 *  `ready:false` means a Pod launch that names grok will be refused (or drop grok) unless a refresh extends the token. */
export function grokLaunchReadiness(opts: { home?: string; env?: NodeJS.ProcessEnv; now?: () => number } = {}):
  { ready: true; expiresAt: string | null } | { ready: false; reason: 'missing' | 'expiring'; expiresAt: string | null } {
  const credential = resolveGrokCredential({ home: opts.home, env: opts.env });
  let at: string | null = null;
  try {
    const scopes = JSON.parse(readFileSync(grokAuthFilePath(opts.home), 'utf8')) as Record<string, { expires_at?: unknown }>;
    at = Object.values(scopes).flatMap((s) => (s && typeof s.expires_at === 'string' ? [s.expires_at] : [])).sort().at(-1) ?? null;
  } catch { /* no auth file */ }
  if (credential?.kind !== 'subscription') return { ready: false, reason: 'missing', expiresAt: at };
  const expiring = isGrokSubscriptionExpiring({ home: opts.home, bufferMs: POD_GROK_MIN_VALIDITY_MS, ...(opts.now ? { now: opts.now } : {}) });
  return expiring ? { ready: false, reason: 'expiring', expiresAt: at } : { ready: true, expiresAt: at };
}

/** The one launch line for a skipped grok copy — the reader sees why grok left this run's chain. */
export function podGrokSkippedLine(skip: { reason: PodGrokSkipReason; expiresAt: string | null }, now?: () => number): string {
  const why = skip.reason === 'missing' ? '구독 자격 없음' : skip.reason === 'expiring' ? '만료 임박' : '만료 임박 · 호스트 갱신 실패';
  const at = skip.expiresAt ? Date.parse(skip.expiresAt) : NaN;
  const left = skip.reason !== 'missing' && Number.isFinite(at) ? ` · 남은 ${formatGrokRemaining(at - (now ?? Date.now)())} < 기준 ${formatGrokRemaining(POD_GROK_MIN_VALIDITY_MS)}` : '';
  const next = skip.reason === 'missing' ? '' : ' · 다음: 호스트에서 grok login --device-auth';
  return `⚠️ grok 자격 없음(${why}${skip.expiresAt ? ` · 만료 ${skip.expiresAt}` : ''}${left}) — 이 런의 폴백 체인에서 grok 을 뺐다${next}`;
}

/** 키 캐시 관례: `~/.cache/<env 이름 소문자>`(예: OPENROUTER_API_KEY → ~/.cache/openrouter_api_key · src/config.ts 와 같다). */
function defaultReadKeyCache(name: string): string | undefined {
  try { const v = readFileSync(join(homedir(), '.cache', name.toLowerCase()), 'utf8').trim(); return v || undefined; } catch { return undefined; }
}

export function defaultGhToken(): string {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('gh auth token 실패 — 호스트에서 gh auth login');
  return r.stdout.trim();
}

/** Bind credential issuance to the repository the host actually supplied to the Pod. */
function githubRepositoryFromUrl(repoUrl: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(repoUrl);
  const owner = match?.[1];
  const name = match?.[2];
  return owner && name && ![owner, name].some((part) => part === '.' || part === '..') ? `${owner}/${name}` : null;
}

/** GROK-CHILD-GIT-GUARD — the Pod holds a GitHub write token and our repo cannot protect main (private free plan · API 403).
 *  The global hook refuses main/tags/unknown refs and most deletes. With a runId, self-impl refs use the same six-hex
 *  run suffix as planned branch names; only that suffix and this run's disposable PR scratch create/delete pass.
 *  A same-card PR reuse push is the one exception: per-command Git config binds its ref, old head and card;
 *  the hook compares the Pod card and proves fast-forward ancestry before accepting it.
 *  salvage/* and bench arm refs keep their existing broader rules. A six-hex collision remains possible, so this is
 *  an accidental overwrite guard, not a security isolation boundary; child credential isolation is a separate slice. */
export const POD_GIT_HOOKS_DIR = '$HOME/.elanous-git-hooks';
export function podGitPushGuardScript(runId?: string): string {
  const runKey = runId ? runSuffixKey(runId) : null;
  const zeroSha = '0'.repeat(40);
  return [
    `mkdir -p "${POD_GIT_HOOKS_DIR}" && cat > "${POD_GIT_HOOKS_DIR}/pre-push" <<'ELANOUS_PRE_PUSH'`,
    '#!/bin/sh',
    'while read -r lref lsha rref rsha; do',
    '  case "$lsha" in *[!0]*) ;; *)',
    ...(runKey ? [
      `    case "$rref" in refs/heads/self-impl/pr-create-r${runKey}-*) ;; *) echo "[pod] git-guard: refused remote delete $rref" >&2; exit 1 ;; esac ;;`,
    ] : ['    echo "[pod] git-guard: refused remote delete $rref" >&2; exit 1 ;;']),
    '  esac',
    '  case "$rref" in',
    ...(runKey ? [
      `    refs/heads/self-impl/pr-create-r${runKey}-*)`,
      `      case "$lsha:$rsha" in ${zeroSha}:*|*:${zeroSha}) ;; *) echo "[pod] git-guard: refused scratch ref update $rref" >&2; exit 1 ;; esac ;;`,
      `    refs/heads/self-impl/*-r${runKey}|refs/heads/self-impl/*-r${runKey}-early) ;;`,
      '    refs/heads/self-impl/*)',
      '      reuse_ref=$(git config --get elanous.sameCellReuseRef 2>/dev/null || true)',
      '      reuse_head=$(git config --get elanous.sameCellReuseHead 2>/dev/null || true)',
      '      reuse_card=$(git config --get elanous.sameCellReuseCard 2>/dev/null || true)',
      '      if [ -z "$reuse_ref" ]; then echo "[pod] git-guard: refused push to $rref (another run)" >&2; exit 1; fi',
      '      if [ "$rref" != "$reuse_ref" ]; then echo "[pod] git-guard: refused same-cell ref-mismatch $rref" >&2; exit 1; fi',
      '      if [ -z "${ELANOUS_TASK_CARD_ID:-}" ] || [ "$reuse_card" != "$ELANOUS_TASK_CARD_ID" ]; then echo "[pod] git-guard: refused same-cell card-mismatch $rref" >&2; exit 1; fi',
      '      if [ -z "$reuse_head" ] || [ "$rsha" != "$reuse_head" ]; then echo "[pod] git-guard: refused same-cell remote-head-mismatch $rref" >&2; exit 1; fi',
      '      if ! git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null; then echo "[pod] git-guard: refused same-cell non-fast-forward $rref" >&2; exit 1; fi',
      '      echo "[pod] git-guard: allowed same-cell fast-forward $rref" >&2 ;;',
    ] : [
      ...(runId ? ['    refs/heads/self-impl/*) echo "[pod] git-guard: refused push to $rref (invalid run id)" >&2; exit 1 ;;'] : ['    refs/heads/self-impl/*) ;;']),
    ]),
    '    refs/heads/salvage/*) ;;',
    '    refs/heads/bench/*/base) echo "[pod] git-guard: refused push to shared bench base $rref" >&2; exit 1 ;;',
    '    refs/heads/bench/*/*) ;;',
    '    *) echo "[pod] git-guard: refused push to $rref (only this run\'s branches)" >&2; exit 1 ;;',
    '  esac',
    'done',
    'exit 0',
    'ELANOUS_PRE_PUSH',
    `chmod 755 "${POD_GIT_HOOKS_DIR}/pre-push" && git config --global core.hooksPath "${POD_GIT_HOOKS_DIR}"`,
  ].join('\n');
}

/** Job 스크립트의 salvage 단계 — 자식 rc 가 0 이 아닐 때만, 변경·미푸시 커밋이 있는 격리 워크트리를 `salvage/<job>/<worktree>` 로 push.
 *  main·self-impl/ 로는 절대 안 민다. 실패해도 제어 흐름을 바꾸지 않는다(호출자는 이 뒤에 `exit $rc`). */
/**
 * App installation tokens live one hour and only the host process renews them (at 10 minutes left).
 * If that process dies (host reboot), nothing renews the Pod's token. hosts.yml unchanged for this long
 * means the host is gone. Push a snapshot while the token still works.
 */
export const POD_GH_STALE_SECONDS = 53 * 60;

/** Snapshot every worktree to salvage/<job>/<wt>-early without touching the child's index, worktree or HEAD. */
export function podEarlySalvageScript(): string {
  return [
    'job_name="${ELANOUS_POD_NAME:-unknown-job}"',
    'while IFS= read -r wt; do',
    '  [ -n "$wt" ] || continue',
    '  case "$wt" in /*) ;; *) continue ;; esac',
    '  wt_name=$(basename -- "$wt")',
    "  case \"$wt_name\" in ''|.*|*/*|*'..'*) continue ;; esac",
    '  branch="salvage/${job_name}/${wt_name}-early"',
    '  (',
    '    set +e',
    '    cd -- "$wt" || exit 0',
    '    head=$(git rev-parse --verify -q HEAD) || { printf \'ELANOUS_POD_SALVAGE_NONE early-no-head\\n\'; exit 0; }',
    '    idx=$(mktemp) || exit 0',
    '    cp -- "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || :',
    '    GIT_INDEX_FILE="$idx" git add -A -- . >/dev/null 2>&1',
    '    tree=$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)',
    '    rm -f -- "$idx"',
    '    [ -n "$tree" ] || { printf \'ELANOUS_POD_SALVAGE_NONE early-write-tree-failed\\n\'; exit 0; }',
    '    base=$(git rev-parse --verify -q origin/HEAD || git rev-parse --verify -q origin/main || true)',
    '    if [ "$tree" = "$(git rev-parse "${head}^{tree}")" ]; then',
    '      if [ -z "$base" ] || [ "$(git rev-list --count "${base}..${head}" 2>/dev/null || echo 1)" = 0 ]; then printf \'ELANOUS_POD_SALVAGE_NONE clean\\n\'; exit 0; fi',
    '      commit=$head',
    '    else',
    '      commit=$(git commit-tree "$tree" -p "$head" -m "salvage(early): ${job_name} host token refresh stopped") || { printf \'ELANOUS_POD_SALVAGE_NONE commit-failed\\n\'; exit 0; }',
    '    fi',
    '    git push --force origin "${commit}:refs/heads/${branch}" || { printf \'ELANOUS_POD_SALVAGE_NONE push-failed\\n\'; exit 0; }',
    "    printf 'ELANOUS_POD_SALVAGE %s %s\\n' \"$branch\" \"$commit\"",
    '  )',
    "done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { sub(/^worktree /, \"\"); print }')",
  ].join('\n');
}

/** Background watchdog: fires the early snapshot once when hosts.yml has not been rewritten for staleSeconds. */
export function podGithubWatchdogScript(staleSeconds: number, intervalSeconds = 30): string {
  return [
    '(',
    `  while sleep ${intervalSeconds}; do`,
    '    f="$GH_CONFIG_DIR/hosts.yml"',
    '    m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || continue',
    '    age=$(( $(date +%s) - m ))',
    `    [ "$age" -ge ${staleSeconds} ] || continue`,
    "    printf 'ELANOUS_POD_GH_STALE %s\\n' \"$age\"",
    `    ${podEarlySalvageScript().split('\n').join('\n    ')}`,
    '    break',
    '  done',
    ') & gh_watch_pid=$!',
  ].join('\n');
}

export function podSalvageScript(): string {
  return [
    'if [ "${rc:-0}" -ne 0 ]; then',
    '  job_name="${ELANOUS_POD_NAME:-unknown-job}"',
    '  salvage_any=0',
    '  while IFS= read -r wt; do',
    '    [ -n "$wt" ] || continue',
    '    case "$wt" in',
    '      /*) ;;',
    "      *) printf 'ELANOUS_POD_SALVAGE_NONE bad-worktree-path\\n'; continue ;;",
    '    esac',
    '    wt_name=$(basename -- "$wt")',
    '    case "$wt_name" in',
    "      ''|.*|*/*|*'..'*) printf 'ELANOUS_POD_SALVAGE_NONE bad-worktree-name\\n'; continue ;;",
    '    esac',
    '    branch="salvage/${job_name}/${wt_name}"',
    '    case "$branch" in',
    '      salvage/*) ;;',
    "      *) printf 'ELANOUS_POD_SALVAGE_NONE refused-prefix\\n'; continue ;;",
    '    esac',
    '    case "$branch" in',
    "      main|self-impl|self-impl/*) printf 'ELANOUS_POD_SALVAGE_NONE refused-prefix\\n'; continue ;;",
    '    esac',
    '    (',
    '      set +e',
    '      cd -- "$wt" || { printf \'ELANOUS_POD_SALVAGE_NONE cd-failed\\n\'; exit 0; }',
    '      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf \'ELANOUS_POD_SALVAGE_NONE not-a-worktree\\n\'; exit 0; }',
    '      dirty=0',
    '      git diff --quiet || dirty=1',
    '      git diff --cached --quiet || dirty=1',
    '      if [ -n "$(git ls-files --others --exclude-standard)" ]; then dirty=1; fi',
    '      ahead=0',
    '      if git rev-parse --verify HEAD >/dev/null 2>&1; then',
    "        if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then",
    "          if [ \"$(git rev-list --count '@{u}..HEAD' 2>/dev/null || true)\" != 0 ]; then ahead=1; fi",
    '        else',
    '          if git rev-parse --verify origin/HEAD >/dev/null 2>&1; then',
    '            base=$(git rev-parse origin/HEAD)',
    '          elif git rev-parse --verify origin/main >/dev/null 2>&1; then',
    '            base=$(git rev-parse origin/main)',
    '          else',
    '            base=$(git rev-list --max-parents=0 HEAD 2>/dev/null | head -n 1)',
    '          fi',
    '          if [ -n "$base" ] && [ "$(git rev-list --count "${base}..HEAD" 2>/dev/null || true)" != 0 ]; then ahead=1; fi',
    '        fi',
    '      fi',
    '      if [ "$dirty" -eq 0 ] && [ "$ahead" -eq 0 ]; then',
    "        printf 'ELANOUS_POD_SALVAGE_NONE clean\\n'",
    '        exit 0',
    '      fi',
    '      if [ "$dirty" -eq 1 ]; then',
    "        git add -A -- . || { printf 'ELANOUS_POD_SALVAGE_NONE add-failed\\n'; exit 0; }",
    '        git commit -m "salvage: ${job_name} rc=${rc}" || { printf \'ELANOUS_POD_SALVAGE_NONE commit-failed\\n\'; exit 0; }',
    '      fi',
    '      git push origin "HEAD:refs/heads/${branch}" || { printf \'ELANOUS_POD_SALVAGE_NONE push-failed\\n\'; exit 0; }',
    '      commit=$(git rev-parse HEAD) || { printf \'ELANOUS_POD_SALVAGE_NONE rev-parse-failed\\n\'; exit 0; }',
    "      printf 'ELANOUS_POD_SALVAGE %s %s\\n' \"$branch\" \"$commit\"",
    '    )',
    '    salvage_any=1',
    "  done < <(git worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, \"\"); print }')",
    "  if [ \"$salvage_any\" -eq 0 ]; then printf 'ELANOUS_POD_SALVAGE_NONE no-worktree\\n'; fi",
    'fi',
  ].join('\n');
}
const GATE = `ok=0
for i in $(seq 1 60); do
  if curl -s -m 1 -o /dev/null http://host.orb.internal:31415/health || curl -s -m 1 -o /dev/null http://core.elanous-prod:8080/; then ok=0; else ok=$((ok+1)); fi
  [ "$ok" -ge 3 ] && { echo "[gate] isolation enforced after \${i} probes"; exit 0; }
  sleep 0.5
done
echo "[gate] ISOLATION NOT ENFORCED within 30s"; exit 1`;

/** Only the allocated account is active; each candidate has its own read-only Secret files and writable Codex home. */
/** The host's codex quota policy, exported into the Pod so the child rotates onto credits like the host does. */
function podQuotaPolicyExport(policy: string = codexQuotaPolicyFromConfig()): string {
  return `export ELANOUS_CODEX_QUOTA_POLICY='${policy.replace(/[^a-z-]/g, '')}'`;
}

function podCodexAccountScript(accounts: readonly string[]): string {
  if (!accounts.length || new Set(accounts).size !== accounts.length || accounts.some((name) => !isValidAccountName(name))) throw new Error('pod: 유효하고 서로 다른 codex 계정이 필요하다');
  return [
    'mkdir -p "$HOME/.elanous" "$HOME/.codex"',
    // Names travel as JSON data, never as shell syntax. Reconstruct the account-store keys that elanous resolves at runtime.
    `POD_CODEX_ACCOUNTS='${JSON.stringify(accounts)}' bun -e 'const fs=require("node:fs"),path=require("node:path");const names=JSON.parse(process.env.POD_CODEX_ACCOUNTS),home=process.env.HOME;const providers={};let version;for(let i=0;i<names.length;i++){const payload=JSON.parse(fs.readFileSync("/creds/codex-"+i+".json","utf8"));const row=JSON.parse(payload.elanousAuth);if(i===0)version=row.version;const entry=row.providers["openai-codex"];if(!entry)throw Error("missing codex account credential "+i);const codexHome=path.join(home,".elanous/codex-accounts",String(i));fs.mkdirSync(codexHome,{recursive:true});fs.writeFileSync(path.join(codexHome,"auth.json"),payload.codexAuth,{mode:0o600});fs.chmodSync(path.join(codexHome,"auth.json"),0o600);providers[names[i]==="default"?"openai-codex":"openai-codex:"+names[i]]={...entry,codexHome}}if(!providers["openai-codex"])providers["openai-codex"]=providers["openai-codex:"+names[0]];fs.writeFileSync(path.join(home,".elanous/auth.json"),JSON.stringify({version,providers}),{mode:0o600});fs.chmodSync(path.join(home,".elanous/auth.json"),0o600);fs.copyFileSync(path.join(home,".elanous/codex-accounts/0/auth.json"),path.join(home,".codex/auth.json"));fs.chmodSync(path.join(home,".codex/auth.json"),0o600)' || exit 5`,
    `export ELANOUS_CODEX_ACCOUNT='${accounts[0]!.replace(/'/g, `'\\''`)}'`,
    'export ELANOUS_CODEX_ACCOUNT_HOME="$HOME/.elanous/codex-accounts/0" CODEX_HOME="$HOME/.elanous/codex-accounts/0"',
    podQuotaPolicyExport(),
  ].join('\n');
}

/** Job 매니페스트(JSON) — docker/harness/job.yaml 과 같은 격리(관문 ⊕ 읽기 전용 Secret ⊕ 한도). */
/** k8s 라벨 값 규칙(63자 이하 · 영숫자로 시작·끝 · 가운데 `-_.`) 밖은 정리한다. 비면 undefined. */
export function k8sLabelValue(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return cleaned || undefined;
}

/** POD9 — Job identity for OOM-retry recovery: which goal execution (hash of the request) and which attempt (1 = first · 2 = high retry). */
export const POD_EXECUTION_KEY_ANNOTATION = 'elanous.dev/execution-key';
export const POD_ATTEMPT_ANNOTATION = 'elanous.dev/attempt';

/** `elanous.run` = 사람이 보는 하니스 런(오케스트레이터 · `ELANOUS_RUN_ID`) — `harness stop <runId>` 와 오케스트레이터의 신호 정리(#21171)가
 *  이 라벨로 Job 을 고른다. 자식 런 id 는 `elanous.child-run`. */
export function podRunLabels(o: { runId?: string; parentRunId?: string }): Record<string, string> {
  const run = k8sLabelValue(o.parentRunId ?? o.runId);
  const child = k8sLabelValue(o.runId);
  return { ...(run ? { 'elanous.run': run } : {}), ...(child ? { 'elanous.child-run': child } : {}) };
}

/** Pod 메모리 «등급» — 대표 09-27: PWA Pod 골이 16Gi 에서 OOM 으로 죽는다 ⇒ «high» 등급을 옵션으로 고른다.
 *  등급 = `standard`(`ELANOUS_POD_MEMORY` 또는 16Gi) · `high`(`ELANOUS_POD_MEMORY_HIGH` 또는 32Gi · standard 보다 작아지지 않는다).
 *  고르는 순서(앞이 이긴다): ① 발사 옵션 `--pod-memory <등급>`(→ `ELANOUS_POD_MEMORY_TIER`) ② 조각 문면 `Pod 메모리: lite|standard|high` ③ 조각의 `apps/pwa/` ④ 부모의 명시 메모리 줄·PWA 경로 ⑤ 실측 권고 ⑥ 권고 없는 research/document 는 lite ⑦ standard.
 *  node-b 노드 할당 가능 약 251Gi. */
export const POD_MEMORY_DEFAULT = '16Gi';
export const POD_MEMORY_HIGH_DEFAULT = '32Gi';
/** POD7 — `lite`(`ELANOUS_POD_MEMORY_LITE` 또는 2Gi): research/document 기본값; OOM 시 standard 로 한 단계 승급한다. */
export const POD_MEMORY_LITE_DEFAULT = '2Gi';

/** Standard si-task request follows measured peaks up to its admission cap; OOM retries reserve their explicit tier separately. */
export function podMemoryRequestFor(kind: GoalType | null, advice?: PodMemoryAdvice): string {
  return podMemoryRequestForWithCap(kind, advice, true);
}

function podMemoryRequestForWithCap(kind: GoalType | null, advice: PodMemoryAdvice | undefined, capToAdmission: boolean): string {
  const evidence = advice?.byGoalType.find((entry) => entry.goalType === kind)?.evidence;
  const peak = evidence?.peakMiB.p95;
  const reason = !kind ? 'unknown-kind' : !evidence ? 'no-advice'
    : evidence.measured < 3 || evidence.runs < 3 || evidence.measured * 2 < evidence.runs ? 'insufficient-sample'
      : peak === null || peak === undefined || !Number.isFinite(peak) || peak < 0 ? 'no-peak' : null;
  if (reason) {
    debug.log('pod.memory', 'request-default', { kind, reason });
    return POD_CHILD_REQUESTS.memory;
  }
  const measuredGi = Math.max(1, Math.ceil(peak! * 1.25 / 1024));
  const capGi = capToAdmission && POD_SI_ADMISSION_CAP_BYTES !== null ? Math.floor(POD_SI_ADMISSION_CAP_BYTES / 1024 ** 3) : null;
  const requestGi = capGi !== null ? Math.min(measuredGi, capGi) : measuredGi;
  return `${requestGi}Gi`;
}
export const POD_MEMORY_TIERS = ['lite', 'standard', 'high'] as const;
export type PodMemoryTier = (typeof POD_MEMORY_TIERS)[number];
export type PodMemorySource = 'option' | 'goal-line' | 'pwa-auto' | 'default' | 'parent-goal-line' | 'parent-pwa-auto' | 'advise' | 'goal-type-auto';
const PWA_PATH = /(?:^|[\s`'"(,·])apps\/pwa\//m;
const GOAL_LINE = /^[ \t]*(?:Pod 메모리|pod-memory)[ \t]*:[ \t]*(lite|standard|high)[ \t]*\r?$/im;

/** L7c — Pod queue predecessor («선행 = 결과 위에 짓는 경우만»; sharing target files is not a predecessor).
 *  Order (first wins): spawn input `after` · launch option `--after` (→ `ELANOUS_POD_AFTER`) · piece line `선행: #N|<goal id>` · parent goal line. */
const AFTER_LINE = /^[ \t]*(?:선행|after)[ \t]*:[ \t]*(#?[1-9]\d*|[a-f0-9]{16})[ \t]*\r?$/im;

export function parsePodPredecessor(v: string | undefined): string | number | null {
  const t = v?.trim();
  if (!t) return null;
  if (/^[a-f0-9]{16}$/.test(t)) return t;
  if (/^#?[1-9]\d*$/.test(t)) { const n = Number(t.replace(/^#/, '')); return Number.isSafeInteger(n) ? n : null; }
  return null;
}

export function podPredecessorFor(feature: string, env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>, parentGoal?: string): string | number | undefined {
  return parsePodPredecessor(env.ELANOUS_POD_AFTER) ?? parsePodPredecessor(AFTER_LINE.exec(feature)?.[1])
    ?? parsePodPredecessor(AFTER_LINE.exec(parentGoal ?? '')?.[1]) ?? undefined;
}

export function goalTouchesPwa(feature: string): boolean {
  return PWA_PATH.test(feature);
}

/** A launch-time warning, not a memory-tier override or a test-command parser. */
export function broadPodTestWarning(goal: string): string | null {
  const broad = /(?:전체\s*(?:시험|테스트)|(?:full|whole|entire|all)\s+(?:test|suite)|(?:전체|모든)\s*(?:test|suite)|\bbun\s+test\s+(?:[\w./-]+\/|[\w./-]+(?<!\.[cm]?[jt]sx?))(?:\s|$)|\bbun\s+test\s*(?:$|[;&|]))/imu.test(goal);
  return broad ? '[pod] 넓은 시험 골 경고: 10-04 W10b 32Gi OOM — 넓은 bun test 한 프로세스가 16GB+ 사용; 바꾼 시험 파일만 지정해 실행하세요.' : null;
}

export function parsePodMemoryTier(v: string | undefined): PodMemoryTier | null {
  const t = v?.trim().toLowerCase();
  return t && (POD_MEMORY_TIERS as readonly string[]).includes(t) ? (t as PodMemoryTier) : null;
}

/**
 * POOL-LITE (10-07): which pool member a Job prefers. Lite tier, or a docs/measurement goal not raised to `high`,
 * goes small-first (node-c); everything else is an implementation Job and goes big-first (node-b).
 */
export function podPlacementKind(tier: PodMemoryTier, declared: DeclaredGoalType | null, requestKind: string | null): PodPlacementKind {
  if (tier === 'lite') return 'lite';
  if (tier !== 'high' && (declared === 'document' || declared === 'research' || requestKind === 'docs')) return 'lite';
  return 'standard';
}

function parsePodGoalType(value: string | undefined): DeclaredGoalType | null {
  return value === 'implement' || value === 'research' || value === 'document' || value === 'operate' ? value : null;
}

function memoryGi(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Gi|Mi)$/.exec(v);
  if (!m) return null;
  return m[2] === 'Gi' ? Number(m[1]) : Number(m[1]) / 1024;
}

export function podMemoryLimitFor(feature: string, env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>, parentGoal?: string, advice?: PodMemoryAdvice): { limit: string; tier: PodMemoryTier; source: PodMemorySource } {
  const option = parsePodMemoryTier(env.ELANOUS_POD_MEMORY_TIER);
  const line = parsePodMemoryTier(GOAL_LINE.exec(feature)?.[1]);
  const parentLine = !option && !line ? parsePodMemoryTier(GOAL_LINE.exec(parentGoal ?? '')?.[1]) : null;
  const declared = parsePodGoalType(env.ELANOUS_POD_GOAL_TYPE)
    ?? declaredGoalType(feature) ?? declaredGoalType(parentGoal ?? '');
  // 선언 «document» 는 실측 분류의 «docs» 다 — 낱말 판정(goalTypeOf)이 «document» 를 못 읽어 권고가 안 이어지던 구멍
  const goalType = advice && !option && !line && !parentLine
    ? (broadPodTestWarning(feature) ? 'test' : goalTypeOf(feature))
      ?? (parentGoal ? (broadPodTestWarning(parentGoal) ? 'test' : goalTypeOf(parentGoal)) : null)
      ?? (declared === 'document' ? 'docs' : null)
    : null;
  const recommendation = advice?.byGoalType.find((entry) => entry.goalType === goalType && entry.evidence.runs > 0)?.recommended;
  const [tier, source]: [PodMemoryTier, PodMemorySource] = option ? [option, 'option']
    : line ? [line, 'goal-line']
    // 조각 자신의 PWA 경로가 부모 줄·실측 권고보다 먼저다 — 부모 «standard» 가 PWA 조각을 16Gi 로 내리면 OOM(POD7 · #23569 순서 회귀)
    : goalTouchesPwa(feature) ? ['high', 'pwa-auto']
    : parentLine ? [parentLine, 'parent-goal-line']
    : parentGoal && goalTouchesPwa(parentGoal) ? ['high', 'parent-pwa-auto']
    // 실측이 high(OOM 증거)를 권하면 선언 종류의 자동 lite 보다 먼저다 — 문서 골도 OOM 이 났으면 다시 2Gi 로 띄우지 않는다
    : recommendation === 'high' ? ['high', 'advise']
    : declared === 'research' || declared === 'document' ? ['lite', 'goal-type-auto']
    : recommendation ? [recommendation, 'advise']
    : ['standard', 'default'];
  if (tier === 'lite') return { limit: env.ELANOUS_POD_MEMORY_LITE?.trim() || POD_MEMORY_LITE_DEFAULT, tier, source };
  const base = env.ELANOUS_POD_MEMORY?.trim() || POD_MEMORY_DEFAULT;
  if (tier === 'standard') return { limit: base, tier, source };
  const high = env.ELANOUS_POD_MEMORY_HIGH?.trim() || POD_MEMORY_HIGH_DEFAULT;
  const a = memoryGi(base), b = memoryGi(high);
  return { limit: a !== null && b !== null && a > b ? base : high, tier, source };
}

/** A named child provider decides the Pod provider; paid OpenRouter requires an explicit key and model. */
export function podNamedChildProvider(named: string | undefined, credential: { grokSubscription: boolean; grokApiKey: boolean; openrouterKey?: boolean; openGatewayKey?: boolean; anthropicKey?: boolean }, childModel?: string): { provider?: PodChildProvider; refuse?: string } {
  // 공백·빈 이름 = «미지정»(종전 기본 경로) — 유료 provider 로 흘러가지 않는다(codex 재리뷰 must-fix).
  if (!named?.trim()) return {};
  // ⭐ 목록은 한 곳(pod-child-providers.ts) — 발사 관문도 같은 상수·같은 문면으로 거부한다.
  const refusal = podChildProviderRefusal(named);
  if (refusal) return { refuse: refusal };
  const provider = podChildProviderOf(named);
  if (provider === 'openai-codex') return { provider: 'openai-codex' };
  named = provider;
  if (named === 'grok') return credential.grokSubscription || credential.grokApiKey ? { provider: 'grok' } : { refuse: 'pod: Pod 에 grok 자격 없음 — 구독 자격이 쓸 수 없거나(만료 임박·갱신 불가) API 키 과금 동의(harness.pod.grokApiKeyOptIn)가 없다 · codex 로 조용히 돌리지 않는다' };
  if (named === 'openrouter') {
    if (!credential.openrouterKey) return { refuse: 'pod: Pod 에 openrouter 키 없음 — 호스트 키 캐시 또는 OPENROUTER_API_KEY 필요' };
    if (!childModel?.trim()) return { refuse: 'pod: openrouter 자식 모델 없음 — --child-llm-model 필요' };
    return { provider: 'openrouter' };
  }
  if (named === 'opengateway') {
    if (!credential.openGatewayKey) return { refuse: 'pod: Pod 에 opengateway 키 없음 — 호스트 키 캐시 또는 OPENGATEWAY_API_KEY 필요' };
    if (!childModel?.trim()) return { refuse: 'pod: opengateway 자식 모델 없음 — --child-llm-model 필요' };
    if (!isVerifiedOpenGatewayModel(childModel.trim())) return { refuse: `pod: opengateway model not verified: ${childModel.trim()}` };
    return { provider: 'opengateway' };
  }
  // BEDROCK-PROVIDER ② — 자격은 클러스터의 이름 있는 Secret 에서 온다. 있나·키가 갖춰졌나는 Pod 발사 «전»(apply 0)에 판정한다(checkBedrockPodSecret).
  if (named === 'bedrock') return { provider: 'bedrock' };
  // ZAI-POD-CHILD — glm 도 같은 결: 자격은 클러스터의 이름 있는 ZAI Secret · 있나·동시 상한은 Pod 발사 «전»(apply 0)에 판정한다(pod-zai-child.ts).
  if (named === 'glm') return { provider: 'glm' };
  // anthropic — API 과금(구독 아님). «명시적으로 anthropic» 일 때만 탄다 · 키 없이 띄우지 않는다(fail-closed).
  if (named !== 'anthropic') return { refuse: podChildProviderRefusal(named) ?? `pod: Pod 자식 provider 판정 불가 — 받음 ${String(named)}` };
  if (!credential.anthropicKey) return { refuse: 'pod: Pod 에 anthropic 키 없음 — 호스트 키 캐시 또는 ANTHROPIC_API_KEY 필요' };
  return { provider: 'anthropic' };
}

/** Fallback credentials for the codex plan — a launch that named openai-codex never falls back to grok (post-review must-fix). */
export function podFallbackCredentials(named: PodChildProvider | undefined, fallback: { grokSubscription: boolean; grokApiKey: boolean }): { grokSubscription: boolean; grokApiKey: boolean } {
  return named === 'openai-codex' ? { grokSubscription: false, grokApiKey: false } : fallback;
}

/** ZAI-POD-CHILD — 이 프로세스가 «ZAI 로 정했지만 아직 apply 안 한» Job 이름(같은 프로세스의 동시 결정이 상한을 넘지 않게). apply·오류 뒤 바로 지운다. */
const zaiPendingApply = new Set<string>();

/** Child LLM flags for the Pod child — grok always names its model; codex only when the launch named it (10-05 PODPROVIDER). */
export function podChildLlmArgs(options: Pick<PodSpawnOptions, 'provider' | 'childModel' | 'childEffort' | 'childProviderExplicit'>): string[] {
  // BEDROCK-POD-PROVIDER-DROP (10-11) — 명시 발사는 provider 를 «이름으로» 받는다. 이름이 비었거나 목록 밖이면 조용히 codex 로 풀지 않고 거부한다
  //   (🩸 bedrock 명시가 podBase 에서 떨어져 이 줄이 openai-codex 로 풀었다 — Pod 자식이 codex(team)로 돌았다). throw = Job apply 전.
  const refusal = options.provider && !podChildProviderOf(options.provider)
    ? podChildProviderRefusal(options.provider)
    : options.childProviderExplicit && !options.provider
      ? 'pod: --child-llm-provider 가 명시됐는데 Pod 옵션에 provider 가 없다 — openai-codex 로 조용히 풀지 않는다'
      : undefined;
  if (refusal) {
    debug.log('self-implement.pod', 'child-provider-refused', { provider: options.provider ?? null, childProviderExplicit: options.childProviderExplicit === true, reason: refusal }, { level: 'warn' });
    throw new Error(refusal);
  }
  const provider = options.provider === 'openai-codex' && !options.childProviderExplicit ? undefined : options.provider;
  if (!provider) return [];
  const model = options.childModel?.trim() || (provider === 'grok' ? defaultGrokModel().id : provider === 'glm' ? ZAI_CODING_DEFAULT_MODEL : undefined);
  if ((provider === 'openrouter' || provider === 'opengateway') && !model) throw new Error(`pod: ${provider} 자식 모델 없음 — --child-llm-model 필요`);
  if (provider === 'opengateway' && !isVerifiedOpenGatewayModel(model!)) throw new Error(`pod: opengateway model not verified: ${model}`);
  // `self implement` registers no --child-llm-effort — passing it kills the Pod at argument parsing, so effort stays host-only.
  return ['--child-llm-provider', provider, ...(model ? ['--child-llm-model', model] : [])];
}

/** POD-ROLE-LLM (0.2.24 · OP 범위) — OpenRouter 자식 Pod 의 리뷰어를 kimi-k3 기본값에서 떼어 고정한다.
 *  🩸 Pod 스크립트가 `ELANOUS_LLM_PROVIDER=openrouter` 를 export 하면 Pod 안 `resolveRoleLlm('review')` 가 기본 사다리
 *    (review=best)를 openrouter 표에서 읽어 `openrouter/moonshotai/kimi-k3` 가 됐다 — `--role-llm` 은 부모 메모리 값이라 Pod 로 갈 길이 없었다.
 *  ⛔ OpenRouter 자식에만 싣는다 — 다른 provider Pod 의 매니페스트는 바이트 그대로다.
 *  ⭐ 기본 = glm-5.3(OpenRouter · 새 자격 0). sol 고정은 codex 자격 이동이 필요해 OP 승인 전까지 기본 꺼짐. */
export type PodOpenRouterReviewer = 'glm' | 'codex-sol' | 'off';
export const POD_OPENROUTER_REVIEWER_PINS: Readonly<Record<Exclude<PodOpenRouterReviewer, 'off'>, string>> = {
  /** 기본 — 리뷰 정책 1차 폴백 · OR Pod 에 이미 있는 OpenRouter 키로 돈다(새 자격 0). */
  glm: JSON.stringify({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' }),
  /** 선택(기본 꺼짐) — sol 팔과 같은 리뷰어. ⛔ codex 자격을 OR Pod Secret 에 «새로» 싣는다 → OP 승인 사안. 자격을 못 얻으면 고정을 건너뛴다. */
  'codex-sol': JSON.stringify({ provider: 'openai-codex', tier: 'best', model: 'gpt-6-sol' }),
};

/** 고르는 순서: 옵션 → env `ELANOUS_POD_OR_REVIEWER` → 기본 `glm`. 모르는 값은 기본으로(관측은 호출자가). */
export function resolvePodOpenRouterReviewer(option: PodOpenRouterReviewer | undefined, env: NodeJS.ProcessEnv): { choice: PodOpenRouterReviewer; source: 'option' | 'env' | 'default'; rejected?: string } {
  if (option) return { choice: option, source: 'option' };
  const raw = env.ELANOUS_POD_OR_REVIEWER?.trim();
  if (raw === 'glm' || raw === 'codex-sol' || raw === 'off') return { choice: raw, source: 'env' };
  return { choice: 'glm', source: 'default', ...(raw ? { rejected: raw } : {}) };
}

/** CHILD-LLM-PIN-POD (0.2.24) — the child LLM pair from Pod args, for the delegated `harness say`/`harness ask` lines.
 *  🩸 Those lines are built from `quotedAsk` (only --base/merge flags), so `--child-llm-*` never reached the Pod child and an
 *    openrouter Pod fell back to the provider default model (10-11: runs labelled Luna/Sonnet all ran GLM-5.3).
 *  ⛔ Effort is not carried — `podChildLlmArgs` never puts it in args (host-only by design). */
export function podDelegatedChildLlm(args: readonly string[]): { provider: string; model?: string } | undefined {
  const providerIndex = args.indexOf('--child-llm-provider');
  const provider = providerIndex >= 0 ? args[providerIndex + 1] : undefined;
  if (!provider || provider.startsWith('--')) return undefined;
  const modelIndex = args.indexOf('--child-llm-model');
  const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
  return { provider, ...(model && !model.startsWith('--') ? { model } : {}) };
}

/** ⭐ MF-d3b5a70f — Pod 스크립트의 SIGTERM trap 한 줄. 두 겹을 고친다:
 *  🩸 (a) bash 는 foreground 명령(`elanous self implement`, 수시간) 실행 중 받은 trap 을 그 명령이 끝날 때까지
 *    미룬다 ⇒ ~30s grace 안에 발화하지 못하고 SIGKILL 로 넘어갔다. 그래서 메인 명령은 podJobManifest 안에서
 *    `… & si_pid=$!` 로 띄우고 `wait "$si_pid"` 로 기다린다 — `wait` 는 trap 에 즉시 끊긴다(grace 내 발화).
 *  🩸 (b) trap 이 TERM 기본 종료를 삼키면 컨테이너 rc 가 143→137(SIGKILL) 로 바뀐다 ⇒ trap 은 PARTIAL 롤업을
 *    짧게(≤8s) 백그라운드로 쏘고 `exit 143` 으로 원래 rc 를 보존한다 — podUsageMissingReason 의 `sigterm-143`
 *    분기가 실물 경로로 도달한다(시험은 합성 exitCode:143 이 아니라 실물 신호로 잰다).
 *  ⛔ 롤업 실패는 rc 를 바꾸지 않는다(각 단계 `|| true`). trap 몸통은 짧게 유지한다(골 ①). */
/** METER-POD-ROLLUP-GAP-2 — 부분 롤업 표본기가 «방금 낸 seq» 를 적는 파일. trap 은 여기에 +1 해 마지막 PARTIAL 이 가장 큰 seq 를 갖게 한다
 *  (표본기는 서브셸이라 변수가 trap 에 안 보인다 · 없거나 숫자가 아니면 0 으로 보고 1 을 쓴다). */
export const POD_USAGE_PARTIAL_SEQ_FILE = '/tmp/si.usage-partial-seq';

export function podSigtermTrapScript(seqFile: string = POD_USAGE_PARTIAL_SEQ_FILE): string {
  // ⭐ METER-POD-ROLLUP-GAP-2 — trap PARTIAL 은 `--seq <표본기 seq + 1>` 로 낸다(전엔 seq 가 늘 1 이라 dedup 에서 앞선 표본에 졌다) ·
  //   표본기를 먼저 끊어 trap 뒤에 옛 표본이 «마지막 줄»로 끼어들지 않게 한다.
  return `trap '{ [ -n "$si_pid" ] && kill "$si_pid" 2>/dev/null || true; [ -n "\${usage_partial_pid:-}" ] && kill "$usage_partial_pid" 2>/dev/null || true; si_seq=$(cat ${seqFile} 2>/dev/null || true); case "$si_seq" in ""|*[!0-9]*) si_seq=0;; esac; si_seq=$((10#$si_seq + 1)); { [ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h --partial --seq "$si_seq"; } & si_rollup_pid=$!; for si_i in 1 2 3 4 5 6 7 8; do kill -0 "$si_rollup_pid" 2>/dev/null || break; sleep 1; done; kill "$si_rollup_pid" 2>/dev/null || true; wait "$si_rollup_pid" 2>/dev/null || true; exit 143; }' TERM`;
}

export function podJobManifest(o: { name: string; namespace: string; image: string; workIdentity?: PodWorkIdentity; boundPrNumber?: number; /** 레지스트리 이미지면 IfNotPresent(노드가 pull) · 반입 이미지면 Never. */ imagePullPolicy?: 'Never' | 'IfNotPresent'; repoUrl: string; source?: PodSource; repairCommitOnly?: { pr: number; baseHead: string }; hostMirror?: string; args: readonly string[]; passEnv: readonly string[]; deadlineSeconds: number; runId?: string; parentRunId?: string; armEnv?: Readonly<Record<string, string>>; hostId?: string; imageCommit?: string | null; skillEnvs?: readonly string[]; memoryLimit?: string; memoryRequest?: string; goalDoc?: string; /** AUTHOR-POD2 — run `harness say` on /creds/feature inside the Pod (authoring happens off the host). */ authorSentence?: boolean; authorGrade?: 'full' | 'lite'; grokCredential?: 'subscription' | 'api_key'; codexAccounts?: readonly string[]; appCredential?: boolean; /** Test seam — default POD_GH_STALE_SECONDS. */ githubStaleSeconds?: number; /** Which goal execution and attempt this Job is — a resumed host verifies it before following the Job (POD9). */ execution?: { key: string; attempt: number }; hostLeaseAdmitted?: boolean; /** POD-ROLE-LLM — OpenRouter 자식 Pod 에 리뷰어용 codex 자격을 깐다. */ reviewerCodexAuth?: boolean; /** BEDROCK-PROVIDER ② — bedrock 자식만: 이름 있는 AWS Secret 의 키(secretKeyRef) ⊕ 리전 ⊕ 이그레스 라벨. */ bedrock?: BedrockPodSpec; /** ZAI-POD-CHILD — glm(ZAI) 자식만: 이름 있는 ZAI Secret 의 키(secretKeyRef) ⊕ 이그레스·동시 상한 라벨(Pod ⊕ Job). */ zai?: ZaiPodSpec; /** Codex Job may use the same named Secret only for an explicitly admitted ZAI fallback. */ zaiFallback?: ZaiPodSpec; fallbackChain?: { steps: readonly FallbackStep[]; source: 'host' | 'default' }; /** TA-POD-WARMBOOT-PARITY — the child's final line (podResultMarkerShellLine), just before `exit $rc`. */ resultMarkerLine?: string; /** POD-LAUNCH-PROVENANCE — the shared provenance set (labels ⊕ annotations ⊕ child env) for this si-task Job. */ provenance?: PodProvenanceMetadata }): Record<string, unknown> {
  if (o.repairCommitOnly && (o.source?.kind !== 'pr' || o.source.number !== o.repairCommitOnly.pr || !/^[0-9a-f]{40}$/.test(o.repairCommitOnly.baseHead) || o.args.includes('--open-pr') || o.args.includes('--merge-by-host') || o.args.includes('--auto-merge'))) {
    throw new Error('repair commit-only requires matching PR source and no PR/merge flags');
  }
  const quoted = o.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const childProviderIndex = o.args.indexOf('--child-llm-provider');
  const childModelIndex = o.args.indexOf('--child-llm-model');
  const openrouterModel = childProviderIndex >= 0 && o.args[childProviderIndex + 1] === 'openrouter' && childModelIndex >= 0
    ? o.args[childModelIndex + 1] : undefined;
  const openGatewayModel = childProviderIndex >= 0 && o.args[childProviderIndex + 1] === 'opengateway' && childModelIndex >= 0
    ? o.args[childModelIndex + 1] : undefined;
  // POD-ANTHROPIC-PROVIDER — anthropic 자식은 키(env · secretKeyRef)만 쓴다. codex·grok 자격 파일을 깔지 않는다.
  const anthropicChild = childProviderIndex >= 0 && o.args[childProviderIndex + 1] === 'anthropic';
  const goalPath = o.goalDoc ? `'${(o.goalDoc.startsWith('-') ? `./${o.goalDoc}` : o.goalDoc).replace(/'/g, `'\\''`)}'` : undefined;
  const delegated = !o.repairCommitOnly && (Boolean(o.goalDoc) || o.authorSentence === true);
  const askBaseIndex = delegated ? o.args.indexOf('--base') : -1;
  const quotedAsk = (askBaseIndex >= 0 && o.args[askBaseIndex + 1]
    ? ` '--base' '${o.args[askBaseIndex + 1]!.replace(/'/g, `'\\''`)}'`
    : '') + (delegated && o.args.includes('--merge-by-host') ? " '--merge-by-host'" : delegated && o.args.includes('--open-pr') && !o.args.includes('--auto-merge') ? ' --no-auto-merge' : '')
    + (delegated && o.args.includes('--no-supervise') ? ' --no-supervise' : '');
  const delegatedChildLlm = delegated ? podDelegatedChildLlm(o.args) : undefined;
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const quotedChildLlm = delegatedChildLlm
    ? ` '--child-llm-provider' ${shellQuote(delegatedChildLlm.provider)}${delegatedChildLlm.model ? ` '--child-llm-model' ${shellQuote(delegatedChildLlm.model)}` : ''}`
    : '';
  // SI-POD-STAGE-MARKERS — `run end` 는 본체 `wait` 가 돌아온 «바로 다음»(`rc=$?` 직후)에 찍는다: 결과 평탄화·repair 내보내기·
  //   AUTHOR finished 줄 같은 후처리는 run 에 넣지 않는다(리뷰 mf). 표지 줄은 rc 값을 건드리지 않는다.
  const RUN_END = siTaskPodStageShell('run', 'end');
  const script = [
    'set -u',
    ...(o.fallbackChain ? [
      'mkdir -p "$HOME/.elanous" && install -m 600 /creds/llm-fallback-config.json "$HOME/.elanous/config.json" || exit 6',
      `echo "ELANOUS_POD_FALLBACK_CHAIN source=${o.fallbackChain.source} steps=${o.fallbackChain.steps.join(',')}"`,
    ] : []),
    openGatewayModel
      ? 'mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=opengateway'
      : openrouterModel
      ? o.reviewerCodexAuth
        ? 'mkdir -p ~/.elanous ~/.codex && cp /creds/elanous-auth.json ~/.elanous/auth.json && cp /creds/codex-auth.json ~/.codex/auth.json && chmod 600 ~/.elanous/auth.json ~/.codex/auth.json && export ELANOUS_LLM_PROVIDER=openrouter'
        : 'mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=openrouter'
      : anthropicChild
      ? 'mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=anthropic'
      : o.bedrock
      ? 'mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=bedrock'
      : o.zai
      ? 'mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=glm'
      : o.grokCredential === 'subscription'
      ? 'mkdir -p ~/.grok && install -m 600 /creds/grok-auth.json ~/.grok/auth.json && export ELANOUS_LLM_PROVIDER=grok'
      : o.grokCredential === 'api_key'
        ? 'mkdir -p ~/.grok && install -m 600 /creds/grok-api-key ~/.grok/api-key && export XAI_API_KEY="$(cat ~/.grok/api-key)" && export ELANOUS_LLM_PROVIDER=grok'
        : o.codexAccounts ? podCodexAccountScript(o.codexAccounts) : `mkdir -p ~/.elanous ~/.codex && cp /creds/elanous-auth.json ~/.elanous/auth.json && cp /creds/codex-auth.json ~/.codex/auth.json && chmod 600 ~/.elanous/auth.json ~/.codex/auth.json\n${podQuotaPolicyExport()}`,
    o.appCredential ? `unset GH_TOKEN GITHUB_TOKEN; export GH_CONFIG_DIR="${APP_GH_CONFIG_PATH}"; mkdir -p "$GH_CONFIG_DIR" && chmod 700 "$GH_CONFIG_DIR" && { (umask 077; gh auth login --with-token < /creds/gh-token >"$HOME/.gh-login.log" 2>&1) || ${APP_GH_AUTH_COMMAND} < /creds/gh-token; } && chmod 600 "$GH_CONFIG_DIR/hosts.yml" && chmod 700 "$GH_CONFIG_DIR" || { echo "[pod] gh-login-failed: $(head -c 300 "$HOME/.gh-login.log" 2>/dev/null | tr '\\n' ' ' | sed -E 's/(gh[a-z]_|github_pat_)[A-Za-z0-9_.-]+/\\1***/g')"; exit 7; }` : 'export GH_TOKEN="$(cat /creds/gh-token)"',
    // 🔑 스킬 키(.env) — 이미지엔 없다. 이 런의 Secret 에서 각 스킬 폴더로 0600 복사(값은 로그에 안 나온다).
    ...(o.skillEnvs?.length ? [`for n in ${o.skillEnvs.join(' ')}; do [ -d ~/.claude/skills/$n ] && install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env; done; echo "[pod] skill env: ${o.skillEnvs.join(',')}"`] : []),
    'git config --global user.name "elanous pod child" && git config --global user.email "noreply@anthropic.com" && gh auth setup-git',
    podGitPushGuardScript(o.runId),
    'curl -s -m 3 -o /dev/null http://host.orb.internal:31415/health && { echo "[pod] ISOLATION FAIL"; exit 3; }',
    // SI-POD-STAGE-MARKERS — Pod 시계 단계 표지(`ELANOUS_POD_STAGE <stage> <start|end> <epoch초>`): 호스트가 Job 로그에서 읽어
    //   pod.lifecycle stages 의 clone · mirror · run 을 채운다. 실패한 단계는 끝 표지가 없다(→ missing · 지어내지 않는다).
    //   clone 끝 = podSourceScript 전체가 끝난 뒤(갈래마다 마지막 줄이 `ELANOUS_POD_SOURCE` 또는 `cd repo` — 둘 다 소스 받기의 일부).
    siTaskPodStageShell('clone', 'start'),
    podSourceScript(o.source ?? { kind: 'default' }, o.repoUrl, undefined, { stageMarkers: true }),
    siTaskPodStageShell('clone', 'end'),
    // This image already contains runtime dependencies; there is no child install command.
    // Record that fact before the main command, without treating clone completion as install completion.
    `printf 'ELANOUS_POD_DEPS skipped %s image-prepared-no-install\\n' "$(date +%s)" || true`,
    ...(o.repairCommitOnly ? [`[ "$(git rev-parse HEAD)" = '${o.repairCommitOnly.baseHead}' ] || { echo 'ELANOUS_POD_REPAIR_FAILED source-head-mismatch'; exit 8; }`] : []),
    // PR checkout and, when requested, the repair HEAD pin have passed before this child starts.
    // A supervisor input may continue the repair, but cannot launch its source again.
    ...(o.source?.kind === 'pr' ? ['export ELANOUS_POD_VERIFIED_PR_SOURCE=1'] : []),
    ...(goalPath ? [
      `mkdir -p -- "$(dirname -- ${goalPath})" && cp -- /creds/goal-doc ${goalPath} || exit 6`,
    ] : []),
    // Only fixed command shapes leave the Pod; arbitrary argv (including shell -c text) is never emitted.
    `(while :; do { mem=$(if [ -r /sys/fs/cgroup/memory.current ]; then cat /sys/fs/cgroup/memory.current; elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then cat /sys/fs/cgroup/memory/memory.usage_in_bytes; else printf -- -; fi); top=$(ps -eo rss=,comm=,args= --sort=-rss | head -5 | awk 'function encode(s) { gsub(/%/, "%25", s); gsub(/:/, "%3A", s); gsub(/ /, "%20", s); gsub(/\\t/, "%09", s); return s } { rss=$1; name=$2; sub(/^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]*/, ""); n=split($0, a, /[[:space:]]+/); cmd="<redacted>"; if (name=="sleep" && a[2]=="30") cmd="sleep 30" (n>2 ? " <redacted>" : ""); else if (name=="bun") { cmd="bun <redacted>"; if (a[2]=="test") cmd="bun test <redacted>"; else if (a[2]=="run") cmd="bun run <redacted>"; else if ((a[2]=="x" || a[2]=="exec") && a[3]=="tsc") cmd="bun x tsc <redacted>" } else if (name=="tsc") cmd="tsc <redacted>"; else if (name=="elanous") { cmd="elanous <redacted>"; if (a[2]=="self") cmd="elanous self <redacted>"; else if (a[2]=="harness") cmd="elanous harness <redacted>" } else if (name=="node") cmd="node <redacted>"; if (name=="sleep" && cmd=="<redacted>") cmd="sleep <redacted>"; else if (cmd=="<redacted>" && name!="bash" && name!="sh") name="other"; printf " %s:%s:%s", rss, encode(name), encode(substr(cmd,1,120)) }'); printf "ELANOUS_MEM %s %s%s\\n" "$(date +%s)" "$mem" "$top"; } || true; sleep 15 || break; done) & mem_sampler_pid=$!`,
    ...(o.appCredential && !o.repairCommitOnly ? [podGithubWatchdogScript(o.githubStaleSeconds ?? POD_GH_STALE_SECONDS)] : []),
    // METER-POD-ROLLUP-GAP — 부분 롤업 표본기: 최종 줄까지 못 사는 Pod 도 N 분마다(기본 5 · ELANOUS_USAGE_PARTIAL_MINUTES) PARTIAL 줄을 하나씩 남긴다.
    `(usage_partial_seq=0; while :; do { usage_partial_seq=$((usage_partial_seq+1)); printf '%s\\n' "$usage_partial_seq" > ${POD_USAGE_PARTIAL_SEQ_FILE} 2>/dev/null || true; [ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h --partial --seq "$usage_partial_seq" || true; } || true; usage_partial_sleep=$(( \${ELANOUS_USAGE_PARTIAL_MINUTES:-5} * 60 )); sleep "$usage_partial_sleep" || break; done) & usage_partial_pid=$!`,
    // ⭐ MF-d3b5a70f — si_pid 초기화 + trap: 메인 명령을 아래에서 `& si_pid=$!` 로 띄우고 `wait "$si_pid"` 로
    //    기다려야 trap 이 grace 안에 발화한다(bash 는 foreground 명령 실행 중 trap 을 미룬다). trap 은
    //    podSigtermTrapScript() 가 내놓는다(수신 측 reemitPodUsage 포맷과 계약을 같은 파일 안에서 공유).
    'si_pid=""',
    podSigtermTrapScript(),
    // 마지막 줄 JSON 이 «맨 끝»이어야 한다(parseSelfImplementJson) — rollup 은 그 앞에.
    // ⛔ `--author-grade` 는 Pod 안 `elanous`(이미지에 깔린 판)가 모를 수 있어 넘기지 않는다 — 10-06 «unknown option» 즉사(#24445 되돌림).
    // AUTHOR-LITE2-POD — 등급은 환경변수 `ELANOUS_AUTHOR_GRADE` 로 싣는다(옛 Pod elanous 는 모르는 환경변수를 무시하고 full 로 돈다).
    siTaskPodStageShell('run', 'start'),
    o.repairCommitOnly
      ? `export ${OLD_DOOR_STAMP_ENV}=self-implement; elanous self implement "$(cat /creds/feature)" --json --no-open-pr ${quoted} > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?; ${RUN_END}; if elanous self repair-commit-export '${o.repairCommitOnly.pr}' '${o.repairCommitOnly.baseHead}' /tmp/si.out "$PWD" "$HOME/outbox"; then rc=0; elif [ "$rc" -eq 0 ]; then rc=8; fi`
      : o.authorSentence
      ? `echo "ELANOUS_AUTHOR_ON_POD started host=$(hostname) at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; author_t0=$(date +%s); ${o.authorGrade === 'lite' || o.authorGrade === 'full' ? `ELANOUS_AUTHOR_GRADE=${o.authorGrade} ` : ''}elanous harness say --substrate local --json${quotedAsk}${quotedChildLlm} -- "$(cat /creds/feature)" > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?; ${RUN_END}; echo "ELANOUS_AUTHOR_ON_POD finished host=$(hostname) rc=$rc seconds=$(( $(date +%s) - author_t0 ))"; ${POD_RESULT_FLATTEN}`
      : goalPath
      ? `elanous harness ask ${goalPath} --json${quotedAsk}${quotedChildLlm} > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?; ${RUN_END}; ${POD_RESULT_FLATTEN}`
      : `export ${OLD_DOOR_STAMP_ENV}=self-implement; elanous self implement "$(cat /creds/feature)" --json ${quoted} > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?; ${RUN_END}; ${POD_RESULT_FLATTEN}`,
    'cat /tmp/si.out',
    '[ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h || echo "ELANOUS_USAGE_ROLLUP {\"measured\":false,\"reason\":\"no rollup script\"}"',
    // A long run's log export can pass the 5MB artifact limit; skipping it whole left no window into why a
    // 2h+ child failed (🅢 09-27). Keep the newest lines under the limit instead, and say so.
    `if mkdir -p "$HOME/outbox/pod-logs" && elanous logs --all --include-test --since 12h --limit 20000 --json > "$HOME/outbox/pod-logs/logs.jsonl"; then
  logs_size=$(( $(wc -c < "$HOME/outbox/pod-logs/logs.jsonl") ))
  if [ "$logs_size" -gt ${POD_LOGS_KEEP_BYTES} ]; then
    tail -c ${POD_LOGS_KEEP_BYTES} "$HOME/outbox/pod-logs/logs.jsonl" | tail -n +2 > "$HOME/outbox/pod-logs/logs.jsonl.tail" && mv -f "$HOME/outbox/pod-logs/logs.jsonl.tail" "$HOME/outbox/pod-logs/logs.jsonl"
    printf 'ELANOUS_POD_LOGS_TRUNCATED %s %s\\n' "$logs_size" "$(( $(wc -c < "$HOME/outbox/pod-logs/logs.jsonl") ))"
  fi
else
  logs_rc=$?
  rm -f "$HOME/outbox/pod-logs/logs.jsonl"
  printf 'ELANOUS_POD_LOGS_UNAVAILABLE export-exit-%s\\n' "$logs_rc"
fi`,
    `set -o pipefail
artifact_bytes=0
if [ -d "$HOME/outbox" ]; then
  while IFS= read -r -d '' file; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    relative=\${file#"$HOME/outbox/"}
    size=$(( $(wc -c < "$file") ))
    if [ "$size" -gt 5242880 ] || [ $((artifact_bytes + size)) -gt 20971520 ]; then
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
      continue
    fi
    path_token=$(printf '%s' "$relative" | base64 | tr -d '\\n' | tr '+/' '-_' | tr -d '=')
    if encoded=$(gzip -c "$file" | base64 | tr -d '\\n'); then
      artifact_bytes=$((artifact_bytes + size))
      total=$(( (\${#encoded} + 7999) / 8000 ))
      for ((n=1; n<=total; n++)); do
        chunk=\${encoded:$(( (n-1)*8000 )):8000}
        printf 'ELANOUS_POD_ARTIFACT %s %s/%s %s\\n' "$path_token" "$n" "$total" "$chunk"
      done
    else
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
    fi
  done < <(find "$HOME/outbox" -type f -print0 | while IFS= read -r -d '' f; do printf '%s\\t%s\\0' "$(( $(wc -c < "$f") ))" "$f"; done | sort -z -n -k1,1 | while IFS= read -r -d '' row; do printf '%s\\0' "\${row#*$'\\t'}"; done)
fi
found=0
for ledger in "\${ELANOUS_STATE_DIR:-$HOME/.elanous}"/run-ledger/*.jsonl; do
  [ -f "$ledger" ] || continue
  found=1
  run_id=\${ledger##*/}; run_id=\${run_id%.jsonl}
  if encoded=$(gzip -c "$ledger" | base64 | tr -d '\\n'); then
    total=$(( (\${#encoded} + 7999) / 8000 ))
    for ((n=1; n<=total; n++)); do
      chunk=\${encoded:$(( (n-1)*8000 )):8000}
      printf 'ELANOUS_RUN_LEDGER %s %s/%s %s\\n' "$run_id" "$n" "$total" "$chunk"
    done
  else
    echo "[pod] ledger transfer failed: $run_id" >&2
  fi
done
if [ "$found" -eq 0 ]; then echo ELANOUS_RUN_LEDGER_NONE; fi`,
    'kill "$mem_sampler_pid" 2>/dev/null || true',
    ...(o.appCredential && !o.repairCommitOnly ? ['kill "$gh_watch_pid" 2>/dev/null || true'] : []),
    '[ -n "${usage_partial_pid:-}" ] && kill "$usage_partial_pid" 2>/dev/null || true',
    'wait "$mem_sampler_pid" 2>/dev/null || true',
    '[ -n "${usage_partial_pid:-}" ] && wait "$usage_partial_pid" 2>/dev/null || true',
    'tail -n 1 /tmp/si.out',
    ...(o.repairCommitOnly ? [] : [podSalvageScript()]),
    // TA-POD-WARMBOOT-PARITY: the last line says «the child is done» so the host need not wait for the Job condition.
    ...(o.resultMarkerLine ? [o.resultMarkerLine] : []),
    'exit $rc',
  ].join('\n');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: o.namespace, labels: { 'elanous.substrate': 'pod', 'elanous.job': o.name, ...podRunLabels(o), ...(o.workIdentity ? podWorkLabels(o.workIdentity) : {}), ...(o.zai || o.zaiFallback ? { [ZAI_POD_EGRESS_LABEL]: 'true' } : {}), ...o.provenance?.labels },
      ...((o.execution || o.hostLeaseAdmitted || o.provenance) ? { annotations: { ...o.provenance?.annotations, ...(o.execution ? { [POD_EXECUTION_KEY_ANNOTATION]: o.execution.key, [POD_ATTEMPT_ANNOTATION]: String(o.execution.attempt) } : {}), ...(o.hostLeaseAdmitted ? { [POD_HOST_LEASE_ANNOTATION]: 'true' } : {}) } } : {}) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: POD_JOB_TTL_AFTER_FINISHED_SECONDS,
      activeDeadlineSeconds: o.deadlineSeconds,
      template: {
        // ⭐ Pod 라벨 — local 팔만 `elanous.egress/local-llm` 을 단다. docker/h1/policy-local-llm.yaml 이 그 라벨에만 호스트 LLM 포트 «하나»를 연다.
        metadata: { labels: { 'elanous.job': o.name, ...podRunLabels(o), ...(o.workIdentity ? podWorkLabels(o.workIdentity) : {}), ...(o.armEnv?.ELANOUS_LLM_PROVIDER === 'local' ? { 'elanous.egress/local-llm': 'true' } : {}), ...(o.bedrock ? { [BEDROCK_POD_EGRESS_LABEL]: 'true' } : {}), ...(o.zai || o.zaiFallback ? { [ZAI_POD_EGRESS_LABEL]: 'true' } : {}), ...o.provenance?.labels }, ...(o.provenance ? { annotations: o.provenance.annotations } : {}) },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsUser: 1000, fsGroup: 1000 },
          initContainers: [{ name: 'isolation-gate', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never', command: ['bash', '-c'], args: [GATE] }],
          containers: [{
            name: 'child', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never',
            // 📏 09-25: 6Gi 는 빠듯했다 — 자식이 6,127Mi 에 붙어 OOMKilled(137) → 12Gi.
            // 📏 09-27: 12Gi 에서도 OOMKilled 셋(구현 노드 도중) — 같은 골을 16Gi 로 다시 쏘니 끝까지 갔다(#20930) → 기본 16Gi.
            //   요청은 실측 피크별로 고르고 상한은 독립적으로 유지한다. ELANOUS_POD_MEMORY 로 상한 조정.
            resources: { requests: { ...POD_CHILD_REQUESTS, memory: o.memoryRequest ?? POD_CHILD_REQUESTS.memory }, limits: { memory: o.memoryLimit ?? POD_MEMORY_DEFAULT, cpu: '4' } },
            command: ['bash', '-c'], args: [script],
            env: [
              ...(o.runId ? [{ name: 'ELANOUS_RUN_ID', value: o.runId }] : []),
              ...(o.parentRunId ? [{ name: 'ELANOUS_PARENT_RUN_ID', value: o.parentRunId }] : []),
              ...(o.workIdentity?.taskCard ? [{ name: 'ELANOUS_TASK_CARD_ID', value: o.workIdentity.taskCard }] : []),
              ...(o.boundPrNumber && Number.isSafeInteger(o.boundPrNumber) && o.boundPrNumber > 0
                ? [{ name: 'ELANOUS_TASK_BOUND_PR', value: String(o.boundPrNumber) }] : []),
              ...(o.workIdentity?.slotId ? [{ name: 'ELANOUS_POD_SLOT_ID', value: o.workIdentity.slotId }] : []),
              { name: 'ELANOUS_SUBSTRATE', value: 'pod' },
              ...Object.entries(controlInboxEnv(POD_CONTROL_INBOX_DIR)).map(([name, value]) => ({ name, value })),
              // ⭐ 런 출처(🅣 RFC run-origin §A3 · #20457/#20468 칸 이름) — Pod 는 자기 elanous_id 를 쓰지 않고 «띄운 감독기»의 hostId 를 물려받는다.
              { name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
              { name: 'ELANOUS_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              { name: 'ELANOUS_POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
              ...(o.hostId ? [{ name: 'ELANOUS_HOST_ID', value: o.hostId }] : []),
              ...(o.imageCommit ? [{ name: 'ELANOUS_IMAGE_COMMIT', value: o.imageCommit }] : []),
              // POD-LAUNCH-PROVENANCE — the child knows who launched it, why and when (ELANOUS_POD_<key> · no secrets).
              ...(o.provenance?.env ?? []),
              // ⭐ 런 계약(graph-run-contract.ts) — 이 칸이 «실제로» Pod 이고, 부모가 정한 계약도 Pod 다. 안의 그래프가 노드마다 대조한다.
              { name: ACTUAL_SUBSTRATE_ENV, value: 'pod' }, { name: RUN_CONTRACT_ENV, value: carryRunContract({ substrate: 'pod' }) },
              ...Object.entries(o.armEnv ?? {}).map(([name, value]) => ({ name, value })),
              ...o.passEnv.map((key) => ({ name: key, valueFrom: { secretKeyRef: { name: `${o.name}-creds`, key: `env-${key}` } } })),
              ...(o.bedrock ? bedrockPodEnv(o.bedrock) : []),
              ...(o.zai || o.zaiFallback ? zaiPodEnv(o.zai ?? o.zaiFallback!) : []),
            ],
            volumeMounts: [{ name: 'creds', mountPath: '/creds', readOnly: true }, ...(o.hostMirror ? [{ name: 'host-mirror', mountPath: '/host-mirror', readOnly: true }] : [])],
          }],
          volumes: [{ name: 'creds', secret: { secretName: `${o.name}-creds`, defaultMode: 0o400 } }, ...(o.hostMirror ? [{ name: 'host-mirror', hostPath: { path: o.hostMirror, type: 'Directory' } }] : [])],
        },
      },
    },
  };
}

async function waitForRunningPod(kubectl: Kubectl, namespace: string, job: string, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  for (let i = 0; i < 60; i++) {
    const listed = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${job}`, '-o', 'jsonpath={range .items[*]}{.metadata.name} {.status.phase}{"\\n"}{end}']);
    const running = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === 'Running');
    if (running?.[0]) return running[0];
    await sleep(250);
  }
  return null;
}

function defaultGhComment(prNumber: number, body: string): void {
  const r = spawnSync('gh', ['pr', 'comment', String(prNumber), '--body', body], { cwd: findGitDir(process.cwd())?.root ?? process.cwd(), encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `gh exited ${r.status}`).trim().slice(0, 200));
}

function defaultLookupOpenPrByBranch(branch: string, repoUrl: string): OpenPrByBranch {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(repoUrl)?.[1];
  if (!repo) return { status: 'failed', reason: 'repository-unrecognized' };
  if (!branch || !/^[A-Za-z0-9._/-]+$/u.test(branch) || branch.includes('..')) return { status: 'failed', reason: 'branch-invalid' };
  const result = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--head', branch,
    '--json', 'number,url,headRefName,isCrossRepository', '--limit', '100'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_048_576 });
  if (result.status !== 0) return { status: 'failed', reason: result.error ? 'gh-list-unavailable' : `gh-list-rc-${result.status ?? 'null'}` };
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); } catch { return { status: 'failed', reason: 'gh-json-invalid' }; }
  if (!Array.isArray(rows)) return { status: 'failed', reason: 'gh-json-invalid' };
  if (rows.some((row) => row === null || typeof row !== 'object'
    || typeof (row as { number?: unknown }).number !== 'number'
    || !Number.isSafeInteger((row as { number: number }).number)
    || typeof (row as { url?: unknown }).url !== 'string'
    || typeof (row as { headRefName?: unknown }).headRefName !== 'string'
    || typeof (row as { isCrossRepository?: unknown }).isCrossRepository !== 'boolean'))
    return { status: 'failed', reason: 'gh-json-invalid' };
  if (rows.length >= 100) return { status: 'failed', reason: 'gh-result-limit-reached' };
  const matching = rows.filter((row): row is { number: number; url: string; headRefName: string; isCrossRepository: false } => {
    if (row === null || typeof row !== 'object') return false;
    const candidate = row as { number?: unknown; url?: unknown; headRefName?: unknown; isCrossRepository?: unknown };
    return candidate.headRefName === branch && candidate.isCrossRepository === false && typeof candidate.number === 'number'
      && Number.isSafeInteger(candidate.number) && candidate.number > 0 && typeof candidate.url === 'string';
  });
  if (matching.length === 0) return { status: 'not-found', reason: rows.some((row) =>
    (row as { headRefName: string }).headRefName === branch && (row as { isCrossRepository: boolean }).isCrossRepository)
    ? 'cross-repository-only' : 'no-open-pr-for-branch' };
  if (matching.length !== 1) return { status: 'failed', reason: 'ambiguous-open-pr-for-branch' };
  const row = matching[0]!;
  if (row.url.replace(/\/$/u, '').toLowerCase() !== `https://github.com/${repo}/pull/${row.number}`.toLowerCase())
    return { status: 'failed', reason: 'pr-url-mismatch' };
  return { status: 'found', prNumber: row.number, prUrl: row.url };
}

type PodImageObservation = { podName: string | null; podUid: string | null; podCreatedAt: string | null;
  imageID: string | null; digest: string | null; digestUnavailable: string | null };

/** Read the newest Pod owned by this Job. A stale replacement must never be named as the final Pod. */
function readJobPodImage(kubectl: Kubectl, namespace: string, job: string, jobUid?: string): PodImageObservation {
  const unavailable = (reason: string, podName: string | null = null, imageID: string | null = null,
    podUid: string | null = null, podCreatedAt: string | null = null): PodImageObservation =>
    ({ podName, podUid, podCreatedAt, imageID, digest: null, digestUnavailable: reason });
  let result: ReturnType<Kubectl>;
  try { result = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${job}`, '-o', 'json', '--request-timeout=5s']); }
  catch { return unavailable('pod-status-threw'); }
  if (result.status !== 0) return unavailable(`pod-status-rc-${result.status ?? 'null'}`);
  let rows: unknown;
  try { rows = (JSON.parse(result.stdout) as { items?: unknown }).items; }
  catch { return unavailable('pod-status-invalid-json'); }
  if (!Array.isArray(rows)) return unavailable('pod-status-invalid-items');
  const owned = rows.filter((row): row is {
    metadata: { name: string; uid?: string; creationTimestamp?: string; ownerReferences: Array<{ kind: string; name: string; uid?: string }> };
    status?: { containerStatuses?: Array<{ name?: string; imageID?: string }> };
  } => {
    if (!row || typeof row !== 'object') return false;
    const meta = (row as { metadata?: unknown }).metadata;
    if (!meta || typeof meta !== 'object') return false;
    const m = meta as { name?: unknown; ownerReferences?: unknown };
    if (typeof m.name !== 'string' || !Array.isArray(m.ownerReferences)) return false;
    return m.ownerReferences.some((owner: unknown) => !!owner && typeof owner === 'object'
      && (owner as { kind?: unknown }).kind === 'Job' && (owner as { name?: unknown }).name === job
      && (!jobUid || (owner as { uid?: unknown }).uid === jobUid));
  }).sort((a, b) => {
    const at = Date.parse(a.metadata.creationTimestamp ?? '') || 0;
    const bt = Date.parse(b.metadata.creationTimestamp ?? '') || 0;
    return bt - at || b.metadata.name.localeCompare(a.metadata.name);
  });
  const pod = owned[0];
  if (!pod) return unavailable(rows.length ? 'no-job-owned-pod' : 'pod-not-created');
  const podUid = typeof pod.metadata.uid === 'string' ? pod.metadata.uid : null;
  const podCreatedAt = typeof pod.metadata.creationTimestamp === 'string' ? pod.metadata.creationTimestamp : null;
  const child = pod.status?.containerStatuses?.find((entry) => entry.name === 'child');
  if (!child) return unavailable('child-container-not-started', pod.metadata.name, null, podUid, podCreatedAt);
  const imageID = typeof child.imageID === 'string' ? child.imageID : null;
  if (!imageID?.trim()) return unavailable('image-id-missing', pod.metadata.name, imageID, podUid, podCreatedAt);
  const digest = /(?:^|[@/])(sha256:[0-9a-f]{64})$/iu.exec(imageID.trim())?.[1]?.toLowerCase() ?? null;
  return { podName: pod.metadata.name, podUid, podCreatedAt, imageID, digest, digestUnavailable: digest ? null : 'nonstandard-image-id' };
}

/** A repair Pod succeeds only with a verified result/bundle, even if its child gate exited 1. */
export function repairPodExitCode(input: { state: string; repairCommitOnly: boolean; repairArtifactReady: boolean;
  disposition?: { stage?: string; ok?: boolean } }): 0 | 1 {
  if (input.state !== 'complete') return 1;
  if (input.repairCommitOnly) return input.repairArtifactReady ? 0 : 1;
  return input.disposition?.stage !== 'host-regate-failed' && input.disposition?.ok !== false ? 0 : 1;
}

export function podSelfImplementSpawn(options: PodSpawnOptions = {}): SelfImplementJobSpawn {
  if (options.repairCommitOnly && (options.source?.kind !== 'pr' || options.source.number !== options.repairCommitOnly.pr || !/^[0-9a-f]{40}$/.test(options.repairCommitOnly.baseHead))) {
    throw new Error('repair commit-only requires a matching PR source and exact head');
  }
  const baseKubectl = options.kubectl ?? defaultKubectl;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const namespace = options.namespace ?? 'elanous-test';
  const image = options.image ?? 'elanous-harness:local';
  const repoUrl = options.repoUrl ?? 'https://github.com/ElanvitalAI/elanous';
  const repository = githubRepositoryFromUrl(repoUrl);
  const env = options.env ?? process.env;
  const hostMirror = (options.hostMirror ?? env.ELANOUS_POD_HOST_MIRROR ?? (options.configHostMirror ?? (options.kubectl ? () => undefined : configHostMirror))())?.trim() || undefined;
  if (hostMirror && !isAbsolute(hostMirror)) throw new Error('pod.hostMirror must be an absolute directory path');
  const hostSupervised = options.hostSupervised ?? true;
  const resultMarkerOn = options.resultMarker ?? !options.kubectl;
  const writeWarmLedger = options.siWarmLedger
    ?? ((entry: RunLedgerEntry) => appendRunLedgerEntry(entry, runLedgerDir(env.ELANOUS_STATE_DIR)));
  return (input) => {
    if (options.repairCommitOnly && (input.autoMerge || input.openPr || input.base !== `pr-${options.repairCommitOnly.pr}`)) {
      throw new Error('repair commit-only refuses auto merge, new PR, or a different base');
    }
    if (options.siWarmAttempt && !options.siWarmHostPostprocess) {
      throw new Error('si-v1 warm execution requires cold-path host postprocess parity');
    }
    if (options.siWarmAttempt) {
      const done = (async (): Promise<SelfImplementJobDone> => {
        let attempt: SiWarmChildAttempt;
        try {
          const acquired = await options.siWarmAttempt!(input);
          if (!acquired) {
            // No lease was fenced: use the existing one-shot Job path.
            const { siWarmAttempt: _unused, siWarmHostPostprocess: _postprocess, ...coldOptions } = options;
            return podSelfImplementSpawn(coldOptions)(input).done;
          }
          attempt = acquired;
        }
        catch (error) {
          // A lost exec reply may conceal an already opened PR. Never start another child here.
          const message = error instanceof Error ? error.message : String(error);
          debug.log('pod.reuse', 'attempt-unavailable', { spaceId: input.spaceId, reason: message }, { level: 'warn' });
          return { exitCode: 1, output: '', error: { code: 'si-warm-reconcile-only', message } };
        }
        let transport: Awaited<ReturnType<typeof executeSiWarmTransport>>;
        try {
          transport = await executeSiWarmTransport({ command: attempt.command,
            pod: attempt.transport.pod, runner: attempt.transport.runner,
            leaseFenced: attempt.leaseFenced, payload: attempt.payload,
            credentialBundle: attempt.credentialBundle, now: attempt.transport.now });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try { await attempt.quarantineUnknown('transport-exception'); }
          catch (quarantineError) {
            // Both failures must survive: the first transport error names the cause, the
            // quarantine error names the unfinished disposition. Record the judgement.
            const quarantineMessage = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
            const combined = `transport:${message}; quarantine:${quarantineMessage}`;
            try { writeWarmLedger({ runId: attempt.command?.runId ?? input.spaceId,
              event: 'pod-reuse-quarantine-failed',
              data: { spaceId: input.spaceId, workerId: attempt.command?.workerId ?? null,
                leaseId: attempt.command?.leaseId ?? null, reason: combined } }); }
            catch (ledgerError) { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId,
              event: 'pod-reuse-quarantine-failed', reason: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) }, { level: 'warn' }); }
            debug.log('pod.reuse', 'quarantine-failed', { spaceId: input.spaceId, reason: combined }, { level: 'error' });
            return { exitCode: 1, output: '', error: { code: 'si-warm-worker-state-unknown', message: combined } };
          }
          // The quarantine is confirmed: record the settled disposal (fail-soft — the
          // disposition survives a ledger write failure) before the reconcile-only return.
          try { writeWarmLedger({ runId: attempt.command?.runId ?? input.spaceId,
            event: 'pod-reuse-quarantined',
            data: { spaceId: input.spaceId, workerId: attempt.command?.workerId ?? null,
              leaseId: attempt.command?.leaseId ?? null, reason: 'transport-exception' } }); }
          catch (ledgerError) { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId,
            event: 'pod-reuse-quarantined', reason: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) }, { level: 'warn' }); }
          return { exitCode: 1, output: '', error: { code: 'si-warm-reconcile-only', message } };
        }
        const validation = transport.boundary === 'exec-attempted'
          ? assessSiWarmReply(attempt.command, transport.reply, transport.bytes,
            attempt.payload, attempt.credentialBundle)
          : undefined;
        const next = decideSiWarmNextStep({ boundary: transport.boundary,
          leaseFenced: attempt.leaseFenced, ...(validation ? { validation } : {}) });
        debug.log('pod.reuse', 'admission-decision', { spaceId: input.spaceId, boundary: transport.boundary,
          next: next.next, reason: transport.reason, validationReason: transport.validationReason ?? null });
        if (next.next === 'cold-job' && transport.boundary === 'not-entered' && attempt.leaseFenced) {
          const { siWarmAttempt: _unused, ...coldOptions } = options;
          // The acquired lease must not silently ride along into a cold Job: dispose it first,
          // record the disposition, and refuse to start the cold Job when disposal fails.
          const coldLease = attempt.command ? { workerId: attempt.command.workerId,
            podUid: attempt.command.podUid, leaseId: attempt.command.leaseId,
            generation: attempt.command.generation, key: attempt.command.key,
            sourceSha: attempt.command.sourceSha } : null;
          if (coldLease) {
            const recordColdDisposition = (event: string, action: string, residue: Record<string, unknown> = {}) => {
              debug.log('pod.reuse', event, { spaceId: input.spaceId, workerId: coldLease.workerId,
                leaseId: coldLease.leaseId, action, reason: transport.reason, ...residue });
              try { writeWarmLedger({ runId: attempt.command?.runId ?? input.spaceId, event,
                data: { spaceId: input.spaceId, workerId: coldLease.workerId, leaseId: coldLease.leaseId,
                  action, reason: transport.reason, ...residue } }); }
              catch (error) { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId, event,
                reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
            };
            try {
              // The acquired lease is disposed by the same eligibility standard as the
              // entered path: process count zero, pinned-source git reset/clean/status,
              // credential count zero, and an observable return decision — before the
              // lease can go back into the warm pool or a cold Job starts.
              const returned = await cleanAndReturnChildPod(coldLease, { ...attempt.cleanup,
                observe: (event, data) => {
                  debug.log('pod.reuse', event, { spaceId: input.spaceId, ...data },
                    { level: event === 'return-decision'
                      && ((data as { outcome?: string }).outcome === 'eligible'
                        || (data as { outcome?: string }).outcome === 'returned') ? 'info' : 'warn' });
                  attempt.cleanup.observe(event, data);
                  // A ledger write failure is an observation failure: the settled return
                  // or quarantine disposition must survive it (fail-soft after the decision).
                  try { writeWarmLedger({ runId: attempt.command?.runId ?? input.spaceId,
                    event: `pod-reuse-${event}`,
                    data: { spaceId: input.spaceId, ...data } }); }
                  catch (ledgerError) { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId,
                    runId: attempt.command?.runId ?? input.spaceId, event: `pod-reuse-${event}`,
                    reason: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) },
                    { level: 'warn' }); }
                } });
              recordColdDisposition('pod-reuse-cold-fallback-dispose', returned.outcome,
                { dispositionReason: returned.reason });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              try { await attempt.cleanup.quarantine(coldLease, { clean: false, reason: 'cold-fallback-dispose-failed', observedResidue: null }); }
              catch (quarantineError) {
                const quarantineMessage = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
                recordColdDisposition('pod-reuse-cold-fallback-dispose-failed', 'quarantine-failed',
                  { error: `disposal:${message}; quarantine:${quarantineMessage}` });
                return { exitCode: 1, output: '', error: { code: 'si-warm-worker-state-unknown',
                  message: `disposal:${message}; quarantine:${quarantineMessage}` } };
              }
              recordColdDisposition('pod-reuse-cold-fallback-dispose-failed', 'quarantined', { error: message });
              return { exitCode: 1, output: '', error: { code: 'si-warm-worker-state-unknown', message } };
            }
          }
          return podSelfImplementSpawn(coldOptions)(input).done;
        }
        const command = attempt.command;
        const lease = command && { workerId: command.workerId, podUid: command.podUid,
          leaseId: command.leaseId, generation: command.generation, key: command.key,
          sourceSha: command.sourceSha };
        const recordQuarantine = (event: string, reason: string, residue: Record<string, unknown> = {}) => {
          debug.log('pod.reuse', event, { spaceId: input.spaceId, workerId: command?.workerId ?? null,
            leaseId: command?.leaseId ?? null, reason, ...residue }, { level: 'warn' });
          try { writeWarmLedger({ runId: command?.runId ?? input.spaceId, event,
            data: { spaceId: input.spaceId, workerId: command?.workerId ?? null,
              leaseId: command?.leaseId ?? null, reason, ...residue } }); }
          catch (error) { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId,
            event, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        };
        const retireLease = async (reason: string) => {
          recordQuarantine('pod-reuse-quarantine-intent', reason);
          if (!lease) {
            try { await attempt.quarantineUnknown(reason); }
            catch (error) {
              // The unsettled quarantine is an account of its own: keep both the
              // primary path reason and the quarantine cause in the run ledger,
              // then let the caller surface the unknown worker state.
              const message = error instanceof Error ? error.message : String(error);
              recordQuarantine('pod-reuse-quarantine-failed', `${reason}; quarantine:${message}`);
              throw error;
            }
            recordQuarantine('pod-reuse-quarantined', reason);
            return;
          }
          // An uncertain exec may still be running. Keep it fenced and revoke its run credentials.
          let processRemaining: number | null = null;
          let credentialRemaining: number | null = null;
          try { processRemaining = (await attempt.cleanup.stopChildProcesses(lease)).remaining; }
          catch (error) { debug.log('pod.reuse', 'process-stop-failed', { spaceId: input.spaceId,
            reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
          try { credentialRemaining = (await attempt.cleanup.removeRunCredentials(lease)).remaining; }
          catch (error) { debug.log('pod.reuse', 'credential-revoke-failed', { spaceId: input.spaceId,
            reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
          const observedResidue = [processRemaining, credentialRemaining]
            .filter((value): value is number => typeof value === 'number'
              && Number.isSafeInteger(value) && value >= 0)
            .reduce((sum, value) => sum + value, 0);
          try {
            await attempt.cleanup.quarantine(lease, { clean: false, reason,
              observedResidue: observedResidue > 0 ? observedResidue : null });
          } catch (error) {
            // The lease stays unfenced and the worker state unknown: record the
            // unsettled disposal (primary reason plus the quarantine cause)
            // before the caller reports the unknown worker state.
            const message = error instanceof Error ? error.message : String(error);
            recordQuarantine('pod-reuse-quarantine-failed', `${reason}; quarantine:${message}`);
            throw error;
          }
          recordQuarantine('pod-reuse-quarantined', reason, { processRemaining, credentialRemaining });
        };
        if (next.next !== 'adopt-warm' || !transport.measured || !command
          || !transport.reply || !transport.bytes) {
          const reconcileDisposition = transport.verifiedBytesForReconcile
            ? parseSelfImplementJson(new TextDecoder().decode(transport.verifiedBytesForReconcile.terminal))
            : null;
          const hostDisposition = reconcileDisposition ? (({ worktreePath: _podOnly, ...host }) => host)(reconcileDisposition) : null;
          let quarantineError: string | undefined;
          try { await retireLease(validation?.reason ?? 'response-unknown'); }
          catch (error) { debug.log('pod.reuse', 'quarantine-failed', { spaceId: input.spaceId,
            reason: error instanceof Error ? error.message : String(error) }, { level: 'error' });
            quarantineError = error instanceof Error ? error.message : String(error); }
          return { exitCode: 1, output: '',
            ...(hostDisposition ? { disposition: hostDisposition } : {}),
            error: { code: quarantineError
            || (transport.quarantineWorker && !transport.quarantineRecorded)
            ? 'si-warm-worker-state-unknown' : 'si-warm-reconcile-only',
            message: `si-v1 exec may have run; reconcile before retry (${transport.reason})${transport.quarantineError ? `; transport quarantine: ${transport.quarantineError}` : ''}${quarantineError ? `; worker-state-unknown: ${quarantineError}` : ''}` } };
        }
        const terminal = new TextDecoder().decode(transport.bytes.terminal);
        const disposition = parseSelfImplementJson(terminal);
        if (!disposition) {
          let quarantineError: string | undefined;
          try { await retireLease('terminal-disposition-unreadable'); }
          catch (error) { debug.log('pod.reuse', 'quarantine-failed', { spaceId: input.spaceId,
            reason: error instanceof Error ? error.message : String(error) }, { level: 'error' });
            quarantineError = error instanceof Error ? error.message : String(error); }
          return { exitCode: 1, output: '', error: { code: quarantineError
            ? 'si-warm-worker-state-unknown' : 'si-warm-terminal-unreadable',
            message: quarantineError ?? 'validated si-v1 terminal was not a self-implement disposition' } };
        }
        try { await attempt.adopt(command, transport.reply, transport.bytes); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          let quarantineError: string | undefined;
          try { await retireLease('adopt-failed'); }
          catch (quarantineFailure) { debug.log('pod.reuse', 'quarantine-failed', { spaceId: input.spaceId,
            reason: quarantineFailure instanceof Error ? quarantineFailure.message : String(quarantineFailure) }, { level: 'error' });
            quarantineError = quarantineFailure instanceof Error ? quarantineFailure.message : String(quarantineFailure); }
          debug.log('pod.reuse', 'adopt-failed', { spaceId: input.spaceId, reason: message }, { level: 'warn' });
          return { exitCode: 1, output: '', disposition, error: { code: quarantineError
            ? 'si-warm-worker-state-unknown' : 'si-warm-reconcile-only', message: quarantineError ?? message } };
        }
        let returnOutcome: 'returned' | 'quarantined' = 'quarantined';
        let workerStateUnknown: string | undefined;
        try {
          const returned = await cleanAndReturnChildPod(lease!, { ...attempt.cleanup,
            observe: (event, data) => {
              debug.log('pod.reuse', event, { spaceId: input.spaceId, ...data },
                { level: event === 'return-decision' && (data.outcome === 'eligible' || data.outcome === 'returned') ? 'info' : 'warn' });
              attempt.cleanup.observe(event, data);
              // The lease disposition is already settled by the time this callback runs; the warm
              // ledger is an observation of it. A ledger write failure must stay an observation
              // failure — escaping here would quarantine a lease that was already returned.
              try { writeWarmLedger({ runId: command.runId, event: `pod-reuse-${event}`,
                data: { spaceId: input.spaceId, ...data } }); }
              catch (error) { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId, runId: command.runId,
                event: `pod-reuse-${event}`, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
            } });
          returnOutcome = returned.outcome;
        } catch (error) {
          workerStateUnknown = error instanceof Error ? error.message : String(error);
          debug.log('pod.reuse', 'return-unavailable', { spaceId: input.spaceId,
            reason: workerStateUnknown }, { level: 'error' });
          // The inner return/quarantine result is unclear: quarantine the lease explicitly,
          // and only a second quarantine failure leaves the worker state unknown.
          try {
            await attempt.quarantineUnknown(`return-quarantine-unavailable:${workerStateUnknown}`);
            try { writeWarmLedger({ runId: command!.runId, event: 'pod-reuse-quarantined',
              data: { spaceId: input.spaceId, workerId: command!.workerId, leaseId: command!.leaseId,
                reason: `return-quarantine-unavailable:${workerStateUnknown}` } }); }
            catch { /* ledger loss must not mask the quarantine outcome */ }
            // The explicit quarantine settled the disposal: the caller result must
            // account for it as quarantined instead of claiming an unknown state.
            workerStateUnknown = undefined;
          } catch (quarantineError) {
            const quarantineMessage = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
            workerStateUnknown = `return:${workerStateUnknown}; quarantine:${quarantineMessage}`;
            try { writeWarmLedger({ runId: command!.runId, event: 'pod-reuse-quarantine-failed',
              data: { spaceId: input.spaceId, workerId: command!.workerId, leaseId: command!.leaseId,
                reason: workerStateUnknown } }); }
            catch { debug.log('pod.reuse', 'ledger-unavailable', { spaceId: input.spaceId,
              event: 'pod-reuse-quarantine-failed', reason: workerStateUnknown }, { level: 'warn' }); }
          }
        }
        const log = new TextDecoder().decode(transport.bytes.log);
        // Pod checkout paths cannot be used by the host supervisor.
        const { worktreePath: _podOnly, ...hostDisposition } = disposition;
        if (workerStateUnknown) return { exitCode: 1, output: log.slice(-4096), disposition: hostDisposition,
          error: { code: 'si-warm-worker-state-unknown', message: workerStateUnknown } };
        debug.log('pod.reuse', 'child-result', { spaceId: input.spaceId, workerId: command.workerId,
          leaseId: command.leaseId, returnOutcome, stage: disposition.stage ?? null });
        try {
          return await options.siWarmHostPostprocess!({ exitCode: transport.reply.exitCode,
            output: log.slice(-4096), disposition: hostDisposition }, attempt, input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          debug.log('pod.reuse', 'host-postprocess-failed', { spaceId: input.spaceId,
            reason: message }, { level: 'error' });
          return { exitCode: 1, output: log.slice(-4096), disposition: hostDisposition,
            error: { code: 'si-warm-host-postprocess-failed', message } };
        }
      })();
      return { address: `self-impl:${input.spaceId}`, done };
    }
    const name = podJobName(input.spaceId);
    let parentGoal: string | undefined;
    let parentGoalUnreadable = false;
    let inheritedFrom: string | undefined;
    if (env.ELANOUS_POD_GOAL_DOC) {
      try {
        const requestedPath = normalize(env.ELANOUS_POD_GOAL_DOC);
        if (isAbsolute(requestedPath) || requestedPath === '..' || requestedPath.startsWith(`..${sep}`) || requestedPath === '.') throw new Error('invalid goal path');
        const root = findGitDir(process.cwd())?.root;
        if (!root) throw new Error('no repository');
        const realRoot = realpathSync(root);
        const goalFile = realpathSync(resolve(realRoot, requestedPath));
        const withinRoot = relative(realRoot, goalFile);
        if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) throw new Error('outside repository');
        parentGoal = readFileSync(goalFile, 'utf8').replace(/\r\n/g, '\n').split(/^## 실행 기록(?:\n|$)/m, 1)[0];
        inheritedFrom = withinRoot;
      } catch { parentGoalUnreadable = true; }
    }
    let advice: PodMemoryAdvice | undefined;
    const explicitMemory = Boolean(parsePodMemoryTier(env.ELANOUS_POD_MEMORY_TIER) || GOAL_LINE.test(input.feature) || GOAL_LINE.test(parentGoal ?? ''));
    const useAdvice = options.adviseDefaults ?? getUserConfig().pod?.memory?.adviseDefaults === true;
    try { advice = (options.memoryAdvice ?? readPodMemoryAdvice)(); }
    catch (error) { debug.log('self-implement.pod', 'memory-advice-unavailable', { spaceId: input.spaceId, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
    const { limit: selectedMemoryLimit, tier: memoryTier, source: memorySource } = podMemoryLimitFor(input.feature, env, parentGoal, useAdvice && !explicitMemory ? advice : undefined);
    const requestKind = broadPodTestWarning(input.feature) ? 'test' : goalTypeOf(input.feature)
      ?? (parentGoal ? (broadPodTestWarning(parentGoal) ? 'test' : goalTypeOf(parentGoal)) : null)
      ?? ((parsePodGoalType(env.ELANOUS_POD_GOAL_TYPE) ?? declaredGoalType(input.feature) ?? declaredGoalType(parentGoal ?? '')) === 'document' ? 'docs' : null);
    for (const [where, text] of [['feature', input.feature], ['parent-goal', parentGoal]] as const) {
      if (text && text.split(/\r?\n/u).some((line) => /Pod 메모리/u.test(line) && !GOAL_LINE.test(line))) {
        const reason = '한 줄 단독 `Pod 메모리: high|standard` 형식이 아님';
        console.warn(`[pod] Pod 메모리 지시 무시됨 · 이유: ${reason} (${where})`);
        debug.log('self-implement.pod', 'memory-directive-ignored', { spaceId: input.spaceId, where, reason }, { level: 'warn' });
      }
    }
    const broadTestWarning = broadPodTestWarning(`${input.feature}\n${parentGoal ?? ''}`);
    if (broadTestWarning) console.warn(broadTestWarning);
    let memoryLimit = selectedMemoryLimit;
    const after = input.after ?? podPredecessorFor(input.feature, env, parentGoal);
    if (after !== undefined) debug.log('self-implement.pod', 'predecessor', { spaceId: input.spaceId, after, source: input.after !== undefined ? 'input' : 'goal-or-option' });
    let oomRetried = false;
    let retryTier: PodMemoryTier = memoryTier === 'lite' ? 'standard' : 'high';
    let retryFromChildRunId: string | undefined;
    let retryFromMemoryLimit: string | undefined;
    const selectedGoalType = parsePodGoalType(env.ELANOUS_POD_GOAL_TYPE) ?? declaredGoalType(input.feature) ?? declaredGoalType(parentGoal ?? '');
    const memoryReason = memorySource === 'option' && ['explicit-option', 'goal-type-default', 'existing-tier'].includes(env.ELANOUS_POD_MEMORY_REASON ?? '')
      ? env.ELANOUS_POD_MEMORY_REASON!
      : memorySource === 'goal-type-auto' ? `declared goal type ${selectedGoalType}` : memorySource;
    debug.log('self-implement.pod', 'memory-limit', { spaceId: input.spaceId, goalType: requestKind, declaredGoalType: selectedGoalType, memoryLimit, tier: memoryTier, source: memorySource, reason: memoryReason,
      ...(memorySource.startsWith('parent-') ? { inheritedFrom } : {}), ...(parentGoalUnreadable ? { parentGoal: 'unreadable' } : {}) });
    const childRunId = mintRunId();
    const executionKey = createHash('sha256').update(JSON.stringify({ spaceId: input.spaceId, feature: input.feature, base: input.base, autoMerge: input.autoMerge, autoReview: input.autoReview, openPr: input.openPr, draft: input.draft })).digest('hex');
    const parentRunId = env.ELANOUS_RUN_ID?.trim();
    if (options.repairCommitOnly && !parentRunId) throw new Error('repair commit-only requires a parent run id');
    // Standalone callers journal retries without altering the existing Pod manifest.
    const ledgerRunId = parentRunId || `run-${executionKey.slice(0, 8)}-${executionKey.slice(8, 12)}-${executionKey.slice(12, 16)}-${executionKey.slice(16, 20)}-${executionKey.slice(20, 32)}`;
    const address = `self-impl:${input.spaceId}`;
    const ledgerDir = runLedgerDir(env.ELANOUS_STATE_DIR);
    let recoveryError: string | undefined;
    try {
      const entries = loadRunLedger(ledgerRunId, ledgerDir) ?? [];
      const intents = entries.filter((entry) => entry.event === 'pod-oom-retry-intent' && entry.data.job === name && entry.data.executionKey === executionKey && entry.data.attempt === 2);
      const intent = intents.at(-1);
      if (intent && !entries.slice(entries.indexOf(intent) + 1).some((entry) => entry.event === 'pod-oom-retry-finished' && entry.data.job === name && entry.data.executionKey === executionKey && entry.data.fromChildRunId === intent.data.fromChildRunId)) {
        if (typeof intent.data.to !== 'string' || memoryGi(intent.data.to) === null) throw new Error('invalid OOM retry memory limit');
        oomRetried = true;
        memoryLimit = intent.data.to;
        retryTier = parsePodMemoryTier(typeof intent.data.tier === 'string' ? intent.data.tier : undefined)
          ?? ((memoryGi(intent.data.to) ?? 0) >= (memoryGi(podMemoryLimitFor(input.feature, { ...env, ELANOUS_POD_MEMORY_TIER: 'high' }).limit) ?? Infinity) ? 'high' : 'standard');
        retryFromChildRunId = typeof intent.data.fromChildRunId === 'string' ? intent.data.fromChildRunId : undefined;
        retryFromMemoryLimit = typeof intent.data.from === 'string' ? intent.data.from : undefined;
      }
    } catch (error) { recoveryError = `OOM 재시도 원장 판독 실패: ${error instanceof Error ? error.message : String(error)}`; }
    const args = [
      ...(input.base ? ['--base', input.base] : []),
      ...(input.autoMerge ? ['--merge-by-host'] : []),
      ...(input.autoReview ? ['--auto-review'] : []),
      // ⭐ 계약이 미래 노드를 바꾼다(첫 규칙): Pod 는 끝나면 사라지므로 완료 하한 = PR. 작업 트리로만 끝나면 결과가 Pod 와 함께 없어진다.
      //   ⚠️ 임시 안전망(🅢 2026-09-26) — 🅣 의 «종결 하한 오버레이»(그래프 쪽)가 서면 이 줄을 지우고 그것으로 바꾼다(채널 합의).
      ...(!options.repairCommitOnly && (input.openPr || (!input.autoMerge && completionFloorFor({ substrate: 'pod' }) === 'pr')) ? ['--open-pr'] : []),
      ...(input.draft === false ? ['--no-draft'] : []),
      ...(hostSupervised ? ['--no-supervise'] : []),
      ...(options.extraArgs ?? []),
      ...podChildLlmArgs(options),
    ];
    debug.log('pod.self-implement', 'child-supervise', { hostSupervised, childSupervise: !hostSupervised });
    const done = (async (): Promise<SelfImplementJobDone> => {
      if (after !== undefined && (!options.pool || typeof options.pool.acquireAdmission !== 'function')) {
        return { exitCode: 1, output: '', error: { code: 'pod-lease', message: 'Pod predecessor requires pool dependency admission' } };
      }
      if (recoveryError) return { exitCode: 1, output: '', error: { code: 'pod-oom-recovery', message: recoveryError } };
      // Each Job attempt has its own host lease; releasing the first after OOM lets the retry
      // compete with other processes for the newly measured capacity before applying another Job.
      let releaseAdmission: ((() => void) & { applied?: (job: string, context: string, namespace: string) => void; observed?: () => void }) | undefined;
      try {
      // Every attempt, including an OOM retry, must acquire a pool slot before applying a Job.
      const stallMs = options.launchStallMs ?? (getUserConfig().harness?.launchStallMinutes ?? 15) * 60_000;
      // LAUNCH-STALL (10-06): a stage that waits past the cap says so once — today Pods sat 22 min to 5 h with no event.
      const stalledStages = new Set<string>();
      // pool-slot reason = what THIS launch saw on its last empty tryAcquire; admission reason = the pool-wide lease measurement (one pool, one reading).
      const stageReason: { 'pool-slot'?: string | null } = {};
      const unfitContexts = new Set<string>();
      // POOL-LITE (10-07): the last placement of this launch — printed at launch and journaled with the Job.
      let lastPlacement = null as PodPlacement | null;
      const watchStall = (stage: 'admission' | 'pool-slot'): (() => void) => {
        const started = Date.now();
        const timer = setTimeout(() => {
          if (stalledStages.has(stage)) return;
          stalledStages.add(stage);
          const pool = options.pool as { waitReason?: (memoryLimit?: string) => string | null } | undefined;
          debug.log('harness.launch', 'launch-stalled', { spaceId: input.spaceId, runId: childRunId, stage, waitedSec: Math.round((Date.now() - started) / 1000),
            reason: (stage === 'pool-slot' ? stageReason['pool-slot'] : (typeof pool?.waitReason === 'function' ? pool.waitReason(memoryLimit) : null)) ?? 'not-measured-yet' }, { level: 'warn' });
        }, stallMs);
        (timer as { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
      };
      // Members that can never hold this Job's memory limit are skipped with a reason; all unfit → fail fast instead of waiting forever.
      const unfitFailure = async (): Promise<SelfImplementJobDone | null> => {
        const pool = options.pool as { unfitMembers?: (b: number) => Promise<Array<{ context: string; allocatableMemoryBytes: number }>>; members?: readonly PodPoolMember[] } | undefined;
        if (!pool || typeof pool.unfitMembers !== 'function' || !Array.isArray(pool.members)) return null;
        const limitBytes = memoryQuantityBytes(memoryLimit);
        if (limitBytes === null) return null;
        const unfit = await pool.unfitMembers(limitBytes);
        for (const u of unfit) {
          debug.log('harness.launch', 'launch-member-skipped', { spaceId: input.spaceId, runId: childRunId, member: u.context, reason: 'memory-never-fits', allocatableMemoryBytes: u.allocatableMemoryBytes, memoryLimit }, { level: 'warn' });
        }
        unfitContexts.clear();
        for (const u of unfit) unfitContexts.add(u.context);
        if (!unfit.length || !pool.members.every((m) => unfitContexts.has(m.context))) return null;
        const detail = unfit.map((u) => `${u.context} ${Math.round(u.allocatableMemoryBytes / 2 ** 30 * 10) / 10}GiB`).join(' · ');
        return { exitCode: 1, output: '', error: { code: 'pod-pool-unfit', message: `모든 풀 멤버의 할당 가능 메모리가 이 Job 의 한도 ${memoryLimit} 보다 작다 — 영원히 배치될 수 없다(${detail}) · --pod-memory 를 낮추거나 다른 풀로` } };
      };
      const acquireSlot = async (): Promise<PodPoolMember | null> => {
        if (!options.pool) return null;
        const stop = watchStall('pool-slot');
        try {
          for (;;) {
            if (input.signal?.aborted) return null;
            // The reason comes back inside this call, so a concurrent launch cannot overwrite it.
            const kind = podPlacementKind(oomRetried ? retryTier : memoryTier, selectedGoalType, requestKind);
            const acquired = await options.pool.tryAcquire(unfitContexts, (reason) => { stageReason['pool-slot'] = reason; },
              { kind, onPlacement: (placement) => { lastPlacement = placement; } });
            if (acquired) {
              debug.log('self-implement.pod', 'pool-slot', { spaceId: input.spaceId, context: acquired.context, inflight: options.pool.snapshot(), ...(lastPlacement ? { placement: lastPlacement } : {}) });
              if (lastPlacement) console.warn(`[pod] 배치: ${lastPlacement.reason}`);
              return acquired;
            }
            await sleep(options.pollMs ?? 15_000);
          }
        } finally { stop(); }
      };
      const acquireAdmission = async (): Promise<boolean> => {
        if (!options.pool || typeof options.pool.acquireAdmission !== 'function') return true;
        const stop = watchStall('admission');
        try { releaseAdmission = await options.pool.acquireAdmission(input.signal, after, { memoryLimit }); return true; }
        catch (error) {
          // A predecessor closed without merging is not a cancellation: surface it so the queue owner is notified.
          if (error instanceof Error && error.message.startsWith('pod lease predecessor blocked')) admissionBlocked = error.message;
          return false;
        } finally { stop(); }
      };
      let admissionBlocked: string | undefined;
      const admissionFailure = (): SelfImplementJobDone => admissionBlocked
        ? { exitCode: 1, output: '', error: { code: 'pod-predecessor-blocked', message: admissionBlocked } }
        : { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before a pool slot opened' } };
      const unfitDone = await unfitFailure();
      if (unfitDone) return unfitDone;
      // HARNESS-FULL-GRAPH — Pod 입장(입장 관문 ⊕ 멤버 슬롯)은 그래프 노드 pool-admit 이다.
      // 2판: decompose →(substrate=pod) pool-admit 간선은 «여기»(Pod 입장 직전 · 실제 단계 경계)에서 남긴다.
      if (options.repairCommitOnly) routeJourneyEdge('dispatch', 'pr-source', { source: 'pr', substrate: 'pod' });
      else routeJourneyEdge('decompose', 'pod', { substrate: 'pod' });
      enterJourneyNode('pool-admit', { provenance: 'self-implement-pod', data: { spaceId: input.spaceId } });
      // ⛔ 감싸는 함수(async 래퍼)를 쓰지 않는다 — 마이크로태스크가 늘면 Job apply 순서가 밀린다(시험이 잡았다). 같은 자리 try/catch 로.
      const podAdmitError = (error: unknown): void => {
        exitJourneyNode('pool-admit', { provenance: 'self-implement-pod', outcome: 'error', data: { spaceId: input.spaceId, error: error instanceof Error ? error.message : String(error) } });
      };
      let admitted: boolean;
      try { admitted = await acquireAdmission(); } catch (error) { podAdmitError(error); throw error; }
      if (!admitted) {
        exitJourneyNode('pool-admit', { provenance: 'self-implement-pod', outcome: 'refused', data: { spaceId: input.spaceId, reason: 'admission' } });
        return admissionFailure();
      }
      let member: PodPoolMember | null;
      try { member = await acquireSlot(); } catch (error) { podAdmitError(error); throw error; }
      if (options.pool && !member) {
        exitJourneyNode('pool-admit', { provenance: 'self-implement-pod', outcome: 'refused', data: { spaceId: input.spaceId, reason: 'no-slot' } });
        return { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before a pool slot opened' } };
      }
      exitJourneyNode('pool-admit', { provenance: 'self-implement-pod', outcome: 'admitted', data: { spaceId: input.spaceId, ...(member ? { context: member.context } : {}) } });
      const currentContext = member ? null : baseKubectl(['config', 'current-context']);
      let context = member?.context ?? (currentContext?.status === 0 ? currentContext.stdout.trim() : '');
      const kubectl: Kubectl = (args, stdin) => baseKubectl(['--context', context, ...args], stdin);
      let recorded = false;
      let groundingMinted: string | null = null;
      try {
      if (!context) return { exitCode: 1, output: '', error: { code: 'pod-context', message: 'Pod Job context를 확인할 수 없다' } };
      const cleanupSecret = () => { kubectl(['-n', namespace, 'delete', 'secret', `${name}-creds`, '--ignore-not-found']); };
      let repairResultAnnounced = false;
      let repairArtifactReady = false;
      const collectFullLogs = (unavailableEvent: string, replace?: ReadonlySet<string>, onEvent?: (event: string, data: Record<string, unknown>) => void, childId?: string): { status: 'ok' | 'unavailable' | 'incomplete'; childLedgerIncomplete: boolean; samples: ReturnType<typeof parseMemSamples> } => {
        let full: ReturnType<Kubectl>;
        try {
          full = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child']);
          if (full.status !== 0) throw new Error(full.stderr || `kubectl logs exited ${full.status}`);
          if (!full.stdout && unavailableEvent === 'failed-job-logs-unavailable') throw new Error('empty child logs');
        } catch (error) {
          debug.log('self-implement.pod', unavailableEvent, { job: name, reason: error instanceof Error ? error.message : String(error) });
          return { status: 'unavailable', childLedgerIncomplete: false, samples: [] };
        }
        const via = /^ELANOUS_POD_SOURCE_VIA (image|mirror|github)\r?$/m.exec(full.stdout)?.[1];
        // #28246 names why the mirror was skipped on the line before `VIA github`; carry it on the same event.
        const mirrorSkip = /^ELANOUS_POD_SOURCE_MIRROR_SKIP (no-mount|rev-parse-failed|clone-failed)\r?$/m.exec(full.stdout)?.[1];
        const imageSkip = /^ELANOUS_POD_SOURCE_IMAGE_SKIP ([^\r\n]+)\r?$/m.exec(full.stdout)?.[1];
        const delta = /^ELANOUS_POD_SOURCE_DELTA (mirror|origin)\r?$/m.exec(full.stdout)?.[1];
        if (via) debug.log('self-implement.pod', 'source-via', { job: name, via, ...(mirrorSkip ? { mirrorSkip } : {}), ...(imageSkip ? { imageSkip } : {}), ...(delta ? { delta } : {}) });
        let ledgerIncomplete = false;
        let childLedgerIncomplete = false;
        let artifactIncomplete = false;
        const record = (category: string, event: string, data: Record<string, unknown>) => {
          if (event === 'ledger-collect-incomplete' || event === 'ledger-collect-skipped') {
            ledgerIncomplete = true;
            if (childId && (data.runId === childId || !data.runId)) childLedgerIncomplete = true;
          }
          if (event === 'artifact-collect-incomplete' || event === 'artifact-collect-skipped') artifactIncomplete = true;
          debug.log(category, event, data);
          onEvent?.(event, data);
        };
        try { collectPodLedgers(full.stdout, { dir: ledgerDir, ...(replace ? { replace } : {}), log: record }); }
        catch (error) { record('self-implement.pod', 'ledger-collect-incomplete', { job: name, reason: error instanceof Error ? error.message : String(error) }); }
        try {
          collectPodArtifacts(full.stdout, { dir: join(effectiveInstanceRoot(), 'pod-artifacts'), job: name, log: record });
        }
        catch (error) { record('self-implement.pod', 'artifact-collect-incomplete', { job: name, reason: error instanceof Error ? error.message : String(error) }); }
        if (options.repairCommitOnly) {
          const artifactDir = join(effectiveInstanceRoot(), 'pod-artifacts', name, 'repair');
          try {
            const result = readPodRepairArtifact(artifactDir, { ...options.repairCommitOnly, runId: parentRunId });
            repairArtifactReady = true;
            if (!repairResultAnnounced) {
              console.log(`ELANOUS_POD_REPAIR_RESULT ${JSON.stringify({ job: name, artifactDir, pr: result.pr, baseHead: result.baseHead, runId: result.runId, commit: result.commit, bundleSha256: result.bundleSha256 })}`);
              repairResultAnnounced = true;
            }
          } catch (error) {
            repairArtifactReady = false;
            record('self-implement.pod', 'repair-artifact-incomplete', { job: name, reason: error instanceof Error ? error.message : String(error) });
          }
        }
        return { status: ledgerIncomplete || artifactIncomplete ? 'incomplete' : 'ok', childLedgerIncomplete, samples: parseMemSamples(full.stdout) };
      };
      let retryAccount: string | undefined;
      let retrySamples: ReturnType<typeof parseMemSamples> = [];
      let failedAccount: string | undefined;
      let usageLimitRetried = false;
      let ghLoginRetried = false;
      for (;;) {
      try {
        // ZAI-POD-CHILD — glm(ZAI) 자식은 apply «전»에 동시 상한을 본다: 풀 멤버들의 끝나지 않은 ZAI Job ⊕ 이 프로세스가 정했지만 아직 apply 안 한 수.
        //   상한 안 → ZAI(이름 있는 Secret · 없으면 거부) · 넘침 → 정책대로(openrouter·balance = 기존 OpenRouter GLM · stop = 거부 · apply 0).
        let zaiRoute: 'zai' | 'openrouter' | undefined;
        let zaiSpec: ZaiPodSpec | undefined;
        zaiPendingApply.delete(name);
        if (options.provider === 'glm') {
          const settings = (options.zaiSettings ?? (() => zaiSettingsFromConfig(getUserConfig().llm)))();
          const poolMembers = (options.pool as { members?: readonly PodPoolMember[] } | undefined)?.members;
          const contexts = Array.isArray(poolMembers) && poolMembers.length > 0 ? poolMembers.map((m) => m.context) : [context];
          let active: number | null = 0;
          for (const c of contexts) {
            const n = c === context ? countActiveZaiJobs(kubectl, namespace) : countActiveZaiJobs((a, i) => baseKubectl(['--context', c, ...a], i), namespace);
            if (n === null) { active = null; break; }
            active += n;
          }
          const pending = zaiPendingApply.size;
          const slot = decideZaiPodSlot({ active, pending, maxConcurrent: settings.maxConcurrent, overage: settings.overage });
          debug.log('self-implement.pod', 'zai-pod-slot', { job: name, route: slot.route, active: slot.active, pending, maxConcurrent: slot.maxConcurrent, overage: settings.overage, contexts: contexts.length, ...(slot.route !== 'zai' ? { reason: slot.route === 'refuse' ? 'refused' : slot.reason } : {}) }, { level: slot.route === 'zai' ? 'info' : 'warn' });
          if (slot.route === 'refuse') throw new Error(slot.reason);
          zaiRoute = slot.route;
          if (zaiRoute === 'zai') {
            const checked = checkZaiPodSecret(kubectl, namespace);
            if (!checked.ok) {
              debug.log('self-implement.pod', 'zai-secret-refused', { job: name, namespace, reason: checked.reason }, { level: 'warn' });
              throw new Error(checked.reason);
            }
            zaiSpec = checked.spec;
            zaiPendingApply.add(name);
          }
        }
        /** 넘친 glm Pod 는 자식 인자도 OpenRouter GLM 으로 — Job 스크립트·리뷰어 고정·키 전달이 openrouter 갈래를 그대로 탄다. */
        const jobArgs = zaiRoute === 'openrouter' ? zaiOverflowChildArgs(args, ZAI_OPENROUTER_FALLBACK_MODEL) : args;
        const grok = options.provider === 'grok';
        const openrouter = options.provider === 'openrouter' || zaiRoute === 'openrouter';
        const openGateway = options.provider === 'opengateway';
        const anthropic = options.provider === 'anthropic';
        const bedrockChild = options.provider === 'bedrock';
        const zaiChild = zaiRoute === 'zai';
        /** API 키 자식 — codex 계정·자격 파일을 안 쓴다(키는 작업별 creds Secret 의 `env-<KEY>` · bedrock·glm 은 이름 있는 Secret 으로만). */
        const apiKeyChild = openrouter || openGateway || anthropic || bedrockChild || zaiChild;
        const plannedAccount = retryAccount ?? (grok ? 'grok' : openrouter ? 'openrouter' : openGateway ? 'opengateway' : anthropic ? 'anthropic' : bedrockChild ? 'bedrock' : zaiChild ? 'glm' : options.accountBroker?.() ?? options.account ?? 'team');
        debug.log('self-implement.pod', 'account', { spaceId: input.spaceId, account: plannedAccount, brokered: Boolean(options.accountBroker) });
        const plannedCodexAccounts = grok || apiKeyChild || !options.accountBroker || !options.rotationAccounts ? undefined : [plannedAccount, ...options.rotationAccounts.filter((candidate) => candidate !== plannedAccount && candidate !== failedAccount)];
        if (plannedCodexAccounts && !options.rotationAccounts!.includes(plannedAccount)) throw new Error(`pod: 배분 계정 ${plannedAccount} 이 회전 계획에 없다`);
        if (plannedCodexAccounts && new Set(options.rotationAccounts).size !== options.rotationAccounts!.length) throw new Error('pod: 유효하고 서로 다른 codex 계정이 필요하다');
        const accountCredentials = options.credentials ?? hostCredentials;
        if (plannedCodexAccounts) podCodexAccountScript(plannedCodexAccounts);
        // POD-TOKEN-PREREFRESH: «3시간 안 만료» 후보는 선갱신 → 실패면 후보에서 빼고 다음 계정으로.
        const prerefreshDeps = {
          credentials: accountCredentials,
          refresh: options.codexPrerefresh ?? (async (name: string) => (await import('../../oauth/codex.js')).refreshCodexAccountHome(name)),
          isLeaseHolder: options.hqLeaseHolder ?? (options.kubectl ? () => false : defaultHqLeaseHolder),   // kubectl 주입(=시험)이면 본부 임대를 묻지 않는다
          // PREREFRESH-LOCK: 시험(kubectl 주입)은 정본 스토어를 읽어 잠금 경로를 풀지 않는다 — 임시 디렉터리의 계정별 잠금.
          // 잠금 자리는 주입 여부와 무관하게 계정 홈 옆 하나 — 시험은 codexPrerefreshLockPath 로 명시한다(같은 계정이 서로 다른 잠금을 쓰지 않게).
          ...(options.codexPrerefreshLockPath ? { lockPath: options.codexPrerefreshLockPath } : {}),
        };
        const candidates = grok || apiKeyChild ? [] : plannedCodexAccounts ?? [plannedAccount];
        const usable: Array<{ name: string; credential: ReturnType<typeof accountCredentials> }> = [];
        enterJourneyNode('credential-refresh', { provenance: 'self-implement-pod', data: { spaceId: input.spaceId, candidates: candidates.length } });
        try {
          for (const candidate of candidates) {
            const credential = await podCodexCredentialWithPrerefresh(candidate, prerefreshDeps);
            if (credential) usable.push({ name: candidate, credential });
          }
        } catch (error) {
          exitJourneyNode('credential-refresh', { provenance: 'self-implement-pod', outcome: 'error', data: { spaceId: input.spaceId, error: error instanceof Error ? error.message : String(error) } });
          throw error;
        }
        exitJourneyNode('credential-refresh', { provenance: 'self-implement-pod', outcome: grok || apiKeyChild || usable.length > 0 ? 'usable' : 'exhausted', data: { spaceId: input.spaceId, usable: usable.length } });
        if (!grok && !apiKeyChild && usable.length === 0) throw new Error(`openai-codex 후보(${candidates.join(', ')}) access token 이 전부 3시간 안에 만료 — 선갱신도 못 했다(본부 임대 없음 또는 갱신 실패 · pod.credential-prerefresh 를 보라)`);
        const account = grok || apiKeyChild ? plannedAccount : usable[0]!.name;
        if (account !== plannedAccount) debug.log('self-implement.pod', 'account-skipped-expiring', { spaceId: input.spaceId, from: plannedAccount, to: account });
        const codexAccounts = plannedCodexAccounts ? usable.map((entry) => entry.name) : undefined;
        const codexCredentials = codexAccounts ? usable.map(({ name: candidate, credential }) => {
          const elanous = JSON.parse(credential.elanousAuth) as { providers?: Record<string, { tokens?: { refreshToken?: unknown } }> };
          const codex = JSON.parse(credential.codexAuth) as { tokens?: { refresh_token?: unknown } };
          if (!elanous.providers?.['openai-codex']?.tokens || elanous.providers['openai-codex'].tokens.refreshToken || !codex.tokens || codex.tokens.refresh_token) {
            throw new Error(`pod: ${candidate} 자격에 refresh 토큰이 있거나 인증 파일이 없다`);
          }
          return credential;
        }) : undefined;
        const openrouterKey = openrouter ? env.OPENROUTER_API_KEY?.trim() || (options.readKeyCache ?? defaultReadKeyCache)('OPENROUTER_API_KEY')?.trim() : undefined;
        if (openrouter && !openrouterKey) throw new Error('pod: Pod 에 openrouter 키 없음 — 호스트 키 캐시 또는 OPENROUTER_API_KEY 필요');
        const openGatewayEnvKey = openGateway ? env.OPENGATEWAY_API_KEY?.trim() : undefined;
        const openGatewayCachedKey = openGateway ? (options.readKeyCache ?? defaultReadKeyCache)('OPENGATEWAY_API_KEY')?.trim() : undefined;
        if (openGatewayEnvKey && openGatewayCachedKey && openGatewayEnvKey !== openGatewayCachedKey)
          throw new Error('pod: opengateway env와 키 캐시가 충돌 — Pod 발사 거부');
        const openGatewayHostConfig = openGateway ? (options.openGatewayConfig ?? getUserConfig)() : undefined;
        const openGatewayConfiguredKeys = openGatewayHostConfig ? configuredOpenGatewayKeys(openGatewayHostConfig.llm) : [];
        if (openGatewayConfiguredKeys.length > 1 || openGatewayConfiguredKeys.some((key) =>
          (openGatewayEnvKey && openGatewayEnvKey !== key) || (openGatewayCachedKey && openGatewayCachedKey !== key)))
          throw new Error('pod: opengateway 호스트 설정과 env/키 캐시가 충돌 — Pod 발사 거부');
        const openGatewayKey = openGatewayEnvKey || openGatewayCachedKey || openGatewayConfiguredKeys[0];
        if (openGateway && !openGatewayKey) throw new Error('pod: Pod 에 opengateway 키 없음 — 호스트 키 캐시 또는 OPENGATEWAY_API_KEY 필요');
        // POD-ANTHROPIC-PROVIDER — 제품 자격 해석(`getAnthropicApiKey` · 키 캐시 → env)으로 읽는다. 못 읽으면 Pod 를 안 띄운다(fail-closed).
        //   ⛔ 값은 로그·오류 문면에 안 싣는다 — «있었다» 만.
        const anthropicKey = anthropic
          ? (options.anthropicKey ?? (options.kubectl
            ? () => env.ANTHROPIC_API_KEY?.trim() || options.readKeyCache?.('ANTHROPIC_API_KEY')
            : (await import('../../config.js')).getAnthropicApiKey))()?.trim() || undefined
          : undefined;
        if (anthropic && !anthropicKey) throw new Error('pod: Pod 에 anthropic 키 없음 — 호스트 키 캐시 또는 ANTHROPIC_API_KEY 필요');
        // BEDROCK-PROVIDER ② — 이름 있는 AWS Secret 의 «키 이름»만 본다(값은 kubectl 밖으로 안 나온다). 없거나 모자라면 apply 0 으로 거부(fail-closed).
        let bedrockSpec: BedrockPodSpec | undefined;
        if (bedrockChild) {
          const hostRegion = (options.bedrockRegion ?? (options.kubectl
            ? () => validBedrockRegion(env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim())
            : () => resolveBedrockRegion({ env })))();
          const checked = checkBedrockPodSecret(kubectl, namespace, hostRegion);
          if (!checked.ok) {
            debug.log('self-implement.pod', 'bedrock-secret-refused', { job: name, namespace, reason: checked.reason }, { level: 'warn' });
            throw new Error(checked.reason);
          }
          bedrockSpec = checked.spec;
        }
        let jobDeadlineSeconds = options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS;
        const creds = grok
          ? (options.grokCredentials ?? (() => hostGrokCredentials({ env, apiKeyOptIn: options.grokApiKeyOptIn })))()
          : apiKeyChild ? { ghToken: (options.openrouterGhToken ?? defaultGhToken)() }
          : codexCredentials?.[0] ?? usable[0]!.credential;
        // POD-ROLE-LLM — OpenRouter 자식의 Codex 역할(리뷰·저작 grounding)은 별도 access 자격을 검증해 싣는다.
        //   ⛔ kubectl 주입(=시험)이면 호스트 자격 스토어를 읽지 않는다 — 시험은 credentials 를 명시한다.
        const roleCodexAccount = options.account ?? 'team';
        const loadRoleCodexCredential = async (): Promise<{ credential?: { elanousAuth: string; codexAuth: string }; skipped?: string }> => {
          const credentialSource = options.credentials ?? (options.kubectl ? undefined : (account: string) => hostCredentials(account, authStorePath(), () => ''));
          if (!credentialSource) return { skipped: 'no-credential-source' };
          try {
            const got = await podCodexCredentialWithPrerefresh(roleCodexAccount, { ...prerefreshDeps, credentials: credentialSource });
            if (!got) return { skipped: 'expiring' };
            const elanous = JSON.parse(got.elanousAuth) as { providers?: Record<string, { tokens?: { accessToken?: unknown; refreshToken?: unknown } }> };
            const codex = JSON.parse(got.codexAuth) as { tokens?: { access_token?: unknown; refresh_token?: unknown } };
            const elanousTokens = elanous.providers?.['openai-codex']?.tokens;
            const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
            if (!elanousTokens || !nonEmpty(elanousTokens.accessToken) || elanousTokens.refreshToken || !codex.tokens || !nonEmpty(codex.tokens.access_token) || codex.tokens.refresh_token) return { skipped: 'credential-shape' };
            return { credential: { elanousAuth: got.elanousAuth, codexAuth: got.codexAuth } };
          } catch { return { skipped: 'credential-error' }; }   // 자격 오류 원문에는 토큰이 섞일 수 있다.
        };
        let reviewerCredential: { elanousAuth: string; codexAuth: string } | undefined;
        let reviewerPin: string | undefined;
        const reviewerPick = openrouter ? resolvePodOpenRouterReviewer(options.openrouterReviewer, env) : undefined;
        if (reviewerPick?.choice === 'glm') {
          reviewerPin = POD_OPENROUTER_REVIEWER_PINS.glm;
          debug.log('self-implement.pod', 'role-llm-armed', { job: name, role: 'review', env: roleLlmEnvName('review'), value: reviewerPin, choice: 'glm', source: reviewerPick.source, ...(reviewerPick.rejected ? { rejectedEnvValue: true } : {}) });   // ⛔ 모르는 env 값은 «있었다»만 남긴다(원문 0)
        } else if (reviewerPick?.choice === 'off') {
          debug.log('self-implement.pod', 'role-llm-skipped', { job: name, role: 'review', choice: 'off', source: reviewerPick.source, reason: 'off' });
        } else if (reviewerPick?.choice === 'codex-sol') {
          const { credential, skipped } = await loadRoleCodexCredential();
          reviewerCredential = credential;
          if (reviewerCredential) {
            reviewerPin = POD_OPENROUTER_REVIEWER_PINS['codex-sol'];
            debug.log('self-implement.pod', 'role-llm-armed', { job: name, role: 'review', env: roleLlmEnvName('review'), value: reviewerPin, choice: 'codex-sol', source: reviewerPick.source, account: roleCodexAccount });
          } else debug.log('self-implement.pod', 'role-llm-skipped', { job: name, role: 'review', choice: 'codex-sol', source: reviewerPick.source, account: roleCodexAccount, reason: skipped });
        }
        if (grok && !('grokAuth' in creds && creds.grokAuth) && !('grokApiKey' in creds && creds.grokApiKey && options.grokApiKeyOptIn === true)) {
          throw new Error('grok: 구독 자격 없음 · API 키 opt-in 꺼짐 또는 키 없음');
        }
        if (grok && 'grokAuth' in creds && creds.grokAuth) {
          let parsed: unknown;
          try { parsed = JSON.parse(creds.grokAuth); } catch { throw new Error('grok: Pod 구독 자격 JSON 이 아니다'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).some((scope) => scope && typeof scope === 'object' && typeof (scope as { key?: unknown }).key === 'string') || /"[^\"]*refresh[^\"]*"\s*:/i.test(creds.grokAuth)) {
            throw new Error('grok: Pod 구독 자격에 access 토큰이 없거나 refresh 필드가 있다');
          }
        }
        // Grok 자격은 전용 Secret 키 하나로만 보낸다 — passEnv 의 API 키 중복 전달은 막는다.
        const passKeys = [...new Set([...(options.passEnv ?? []), ...(openrouter ? ['OPENROUTER_API_KEY'] : []), ...(openGateway ? ['OPENGATEWAY_API_KEY'] : []), ...(anthropic ? ['ANTHROPIC_API_KEY'] : [])])].filter((key) => key !== 'ELANOUS_LIVE_DETAIL_UNTIL'
          && key !== POD_GITHUB_CREDENTIAL_TOKEN_ENV && key !== POD_GITHUB_CREDENTIAL_URL_ENV
          && (!grok || !['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'].includes(key)));
        const skillEnvs: Record<string, string> = options.skillEnv
          ? (options.readSkillEnv ?? (() => readSkillEnvFiles(resolvePodSkills(env).skills)))()
          : {};
        if (options.skillEnv) debug.log('self-implement.pod', 'skill-env', { job: name, skills: Object.keys(skillEnvs) });   // ⛔ 이름만 — 값은 안 싣는다
        // ⭐ 원격 그라운딩(P13): 주소가 설정돼 있으면 이 런 전용·짧은 수명 토큰을 발급해 Secret 으로만 싣는다(값은 로그에 안 싣는다).
        const groundingUrl = (options.groundingUrl ?? env[GROUNDING_URL_ENV] ?? (options.kubectl ? undefined : configGroundingUrl()))?.trim() || undefined;   // kubectl 주입(=시험)이면 사용자 설정을 읽지 않는다
        const groundingRunId = env.ELANOUS_RUN_ID?.trim() || input.spaceId;
        const groundingTtlMs = (options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS) * 1000;
        const mint = options.mintGrounding ?? mintGroundingToken;
        const grounding = groundingUrl
          ? await mint({ runId: groundingRunId, job: name, ttlMs: groundingTtlMs })
          : null;
        groundingMinted = grounding ? groundingRunId : null;
        debug.log('self-implement.pod', grounding ? 'grounding-token-issued' : 'grounding-token-skipped', { job: name, ...(grounding ? { runId: groundingRunId, exp: grounding.exp } : { reason: 'no-grounding-url' }) });
        // grok 구독 access(~2시간) < Job 수명. 중계 토큰은 그라운딩과 같은 runId 로만 발급하고, 회수는 아래 finally 의 revokeGroundingRun 한 경로가 닫는다.
        const grokSubscription = grok && 'grokAuth' in creds && Boolean(creds.grokAuth);
        const credentialRelay = grokSubscription && groundingUrl
          ? await mint({ runId: groundingRunId, job: name, ttlMs: groundingTtlMs, scope: 'llm-credential' })
          : null;
        if (credentialRelay) {
          groundingMinted = groundingRunId;
          debug.log('self-implement.pod', 'credential-relay', { job: name, runId: groundingRunId, exp: credentialRelay.exp });
        } else if (grokSubscription && !groundingUrl) {
          debug.log('self-implement.pod', 'credential-relay-skipped', { reason: 'no-host-url' });
        }
        const now = options.now ?? Date.now;
        const issueVerifiedAppCredential = async (fresh = false): Promise<{ token: string; expiresAt: number } | null> => {
          if (!repository) return null;
          // This is the same repository-scoped, contents+pull_requests installation request on launch and refresh.
          const candidate = (options.githubInstallation ?? ((repo, o) => coalescedInstallationCredential({ repository: repo.split('/')[1]! }, { fresh: o?.fresh })))(repository, { fresh });
          if (!candidate?.token) return null;
          const expiry = candidate.expires_at ?? ('expiresAt' in candidate ? candidate.expiresAt : undefined);
          const expiresAt = typeof expiry === 'number' ? expiry : Date.parse(expiry ?? '');
          if (!Number.isFinite(expiresAt) || expiresAt <= now()) return null;
          const available = await (options.githubRepositories ?? installationRepositories)(candidate.token);
          return available?.length === 1 && available[0]?.toLowerCase() === repository.toLowerCase()
            ? { token: candidate.token, expiresAt } : null;
        };
        let appCredential: Awaited<ReturnType<typeof issueVerifiedAppCredential>> = null;
        try { appCredential = await issueVerifiedAppCredential(ghLoginRetried); }
        catch { debug.log('self-implement.pod', 'github-app-unavailable', { job: name, reason: 'mint-or-verification-failed' }); }
        // PODCRED1: a short token is still shipped — the host renews it in the Pod on the first live poll — but it is
        // observed, so an exit-7 burst can be checked against the remaining life the Pods actually started with.
        if (appCredential && appCredential.expiresAt - now() < POD_APP_TOKEN_MIN_START_MS) {
          debug.log('self-implement.pod', 'github-app-short-lived', { job: name, expiresAt: new Date(appCredential.expiresAt).toISOString(), requiredSeconds: POD_APP_TOKEN_MIN_START_MS / 1000 });
        }
        const githubRelay = appCredential && groundingUrl && repository
          ? await mint({ runId: groundingRunId, job: name, ttlMs: groundingTtlMs, scope: 'gh-credential', repository })
          : null;
        if (githubRelay) {
          groundingMinted = groundingRunId;
          debug.log('self-implement.pod', 'github-credential-relay', { job: name, runId: groundingRunId, exp: githubRelay.exp });
        }
        // The host polling loop is a refresh path even when the Pod cannot reach the relay.
        const hostRefresh = Boolean(appCredential);
        const podGhToken = hostRefresh ? appCredential!.token : creds.ghToken;
        const githubPassKeys = hostRefresh ? passKeys.filter((key) => !['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR'].includes(key)) : passKeys;
        let ghTokenExpiresAt = hostRefresh ? appCredential!.expiresAt : null;
        const requestedGoalDoc = env.ELANOUS_POD_GOAL_DOC;
        const requestedPath = requestedGoalDoc ? normalize(requestedGoalDoc) : undefined;
        if (requestedPath && (isAbsolute(requestedPath) || requestedPath === '..' || requestedPath.startsWith(`..${sep}`) || requestedPath === '.')) {
          throw new Error(`ELANOUS_POD_GOAL_DOC must be a repository-relative file: ${requestedGoalDoc}`);
        }
        const repoRoot = requestedPath ? findGitDir(process.cwd())?.root : undefined;
        if (requestedPath && !repoRoot) throw new Error('ELANOUS_POD_GOAL_DOC requires a Git repository');
        const goalFile = requestedPath ? realpathSync(resolve(repoRoot!, requestedPath)) : undefined;
        const relativeGoalFile = goalFile ? relative(realpathSync(repoRoot!), goalFile) : undefined;
        if (relativeGoalFile && (relativeGoalFile === '..' || relativeGoalFile.startsWith(`..${sep}`) || isAbsolute(relativeGoalFile))) throw new Error('ELANOUS_POD_GOAL_DOC outside repository');
        const originalGoal = goalFile ? readFileSync(goalFile, 'utf8') : undefined;
        // The orchestrator appends its identity after the executable feature, before
        // dependency handoffs. A quoted heading or pieceIndex example is not a stamp.
        // The stamp is the LAST identity heading followed only by the end or by the
        // handoffs the orchestrator appends after it. The shard body itself may quote
        // those handoff headings, so splitting at the first one would hide the stamp.
        const normalizedFeature = input.feature.replace(/\r\n/g, '\n');
        const stampPattern = /\n\n## Shard identity\n(\{[^\n]*\})(?=$|\n\n## (?:Dependency outputs|Dependency handoff|Working-memory handoff)\n)/g;
        let stamp: RegExpExecArray | null = null;
        for (const match of normalizedFeature.matchAll(stampPattern)) stamp = match as RegExpExecArray;
        const executableFeature = stamp
          ? normalizedFeature.slice(0, stamp.index + stamp[0].length)
          : normalizedFeature.split(/\n\n## (?:Dependency outputs|Dependency handoff|Working-memory handoff)\n/, 1)[0]!;
        const goalBody = originalGoal?.replace(/\r\n/g, '\n').split(/^## 실행 기록(?:\n|$)/m, 1)[0]?.trim();
        // A stamp already present in the goal document is an example, not a new
        // orchestration identity. Compare the entire input, not the unstamped body:
        // a real shard can have precisely the same body as the parent goal.
        const isOriginalDocument = [originalGoal?.replace(/\r\n/g, '\n').trim(), goalBody]
          .some((text) => text !== undefined && (executableFeature.trim() === text || executableFeature.trim() === text.replace(/;;/gu, '; ;')));
        let shard = false;
        if (originalGoal !== undefined && stamp && !isOriginalDocument) {
          try {
            const parsed: unknown = JSON.parse(stamp[1]!);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const id = parsed as Record<string, unknown>;
              const count = id.totalShards;
              const prefix = executableFeature.slice(0, stamp.index);
              const summary = prefix.trim().replace(/\s+/g, ' ');
              const expectedSummary = !summary ? '(empty shard)' : summary.length <= 240 ? summary : `${summary.slice(0, 239)}…`;
              shard = Number.isInteger(count) && (count as number) >= 1
                && typeof id.orchestrationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.orchestrationId)
                && typeof id.shardId === 'string' && /^task:[0-9a-f-]+$/i.test(id.shardId)
                && Number.isInteger(id.position) && (id.position as number) >= 1 && (id.position as number) <= (count as number)
                && id.summary === expectedSummary && Array.isArray(id.siblings)
                && id.siblings.length === (count as number) - 1
                && id.siblings.every((sibling: unknown) => sibling && typeof sibling === 'object' && !Array.isArray(sibling)
                  && typeof (sibling as { shardId?: unknown }).shardId === 'string'
                  && /^task:[0-9a-f-]+$/i.test((sibling as { shardId: string }).shardId)
                  && (sibling as { shardId: string }).shardId !== id.shardId
                  && typeof (sibling as { summary?: unknown }).summary === 'string');
            }
          } catch { /* Invalid stamp: preserve the goal-document route. */ }
        }
        const mode = shard ? 'shard-feature' : requestedPath ? 'goal-doc' : 'feature';
        debug.log('self-implement.pod', 'goal-doc-mode', { spaceId: input.spaceId, mode, reason: shard ? 'shard-identity' : requestedPath ? 'goal-doc-env' : 'no-goal-doc' });
        const goalDoc = shard ? undefined : requestedPath;
        const goalDocument = goalDoc ? originalGoal : undefined;
        const authorOnPod = env.ELANOUS_POD_AUTHOR_ON_POD === '1' && !goalDoc && !shard;
        // Relay provenance is set by this host after selection; caller env cannot assert it.
        const hostAuthorEnv = { ...env };
        for (const key of Object.keys(hostAuthorEnv)) {
          if (key.startsWith('ELANOUS_PROMPT_ENHANCE_') && key !== 'ELANOUS_PROMPT_ENHANCE_MODEL' && key !== 'ELANOUS_PROMPT_ENHANCE_EFFORT') delete hostAuthorEnv[key];
        }
        let authorChoice = authorOnPod ? selectEnhanceLlm({ config: (options.authorConfig ?? getUserConfig)() }, hostAuthorEnv) : undefined;
        let authorFallbackReason: string | undefined;
        let authorRequestedModel: string | undefined;
        let authorRequestedSource: string | undefined;
        let roleCodexCredential = reviewerCredential;
        if (openrouter && authorChoice && inferProviderFromModel(authorChoice.model) === 'openai-codex') {
          const quota = options.planningCodexQuota?.(roleCodexAccount) ?? await hostPlanningCodexQuota(roleCodexAccount, options.budgetInputDeps);
          if (!quota.usable) authorFallbackReason = normalizePlanningFallbackReason(quota.reason ?? 'quota-unavailable');
          else if (!roleCodexCredential) {
            const { credential, skipped } = await loadRoleCodexCredential();
            if (credential) roleCodexCredential = credential;
            else authorFallbackReason = normalizePlanningFallbackReason(skipped ?? 'credential-unavailable');
          }
          if (authorFallbackReason) {
            const childModel = podDelegatedChildLlm(jobArgs)?.model;
            if (!childModel || inferProviderFromModel(childModel) !== 'openrouter') throw new Error(`pod: planning sol·자식 모델 모두 불가 (${authorFallbackReason})`);
            authorRequestedModel = authorChoice.model;
            authorRequestedSource = authorChoice.modelSource;
            debug.log('self-implement.pod', 'planning-model-fallback', { job: name, provider: 'openrouter', model: childModel, reason: authorFallbackReason, requestedModel: authorChoice.model, account: roleCodexAccount });
            authorChoice = { ...authorChoice, model: childModel, modelSource: 'fallback-child' };
          } else debug.log('self-implement.pod', 'role-llm-armed', { job: name, role: 'planning', model: authorChoice.model, source: authorChoice.modelSource, account: roleCodexAccount });
        }
        const hostKey = (k: string): string | undefined => k === 'OPENROUTER_API_KEY' && openrouter ? openrouterKey : k === 'OPENGATEWAY_API_KEY' && openGateway ? openGatewayKey : k === 'ANTHROPIC_API_KEY' && anthropic ? anthropicKey : env[k] ?? (options.readKeyCache ?? defaultReadKeyCache)(k);
        const hostFallbackNames = (options.fallbackConfig ?? getUserConfig)().llm.fallbackChain;
        const normalizedFallback = normalizeFallbackChain(hostFallbackNames);
        let fallbackSteps = normalizedFallback.chain;
        let zaiFallbackSpec: ZaiPodSpec | undefined;
        const codexChild = options.provider === undefined || options.provider === 'openai-codex';
        if (!codexChild && fallbackSteps.includes('zai')) {
          fallbackSteps = fallbackSteps.filter(step => step !== 'zai');
          debug.log('self-implement.pod', 'zai-fallback-unavailable', {
            job: name, reason: 'non-codex-child',
          }, { level: 'warn' });
        }
        if (codexChild && fallbackSteps.includes('zai')) {
          const settings = (options.zaiSettings ?? (() => zaiSettingsFromConfig(getUserConfig().llm)))();
          const poolMembers = (options.pool as { members?: readonly PodPoolMember[] } | undefined)?.members;
          const contexts = Array.isArray(poolMembers) && poolMembers.length > 0 ? poolMembers.map((m) => m.context) : [context];
          let active: number | null = 0;
          for (const c of contexts) {
            const n = c === context ? countActiveZaiJobs(kubectl, namespace)
              : countActiveZaiJobs((a, i) => baseKubectl(['--context', c, ...a], i), namespace);
            if (n === null) { active = null; break; }
            active += n;
          }
          const slot = decideZaiPodSlot({ active, pending: zaiPendingApply.size,
            maxConcurrent: settings.maxConcurrent, overage: 'stop' });
          if (slot.route === 'zai') {
            const checked = checkZaiPodSecret(kubectl, namespace);
            if (checked.ok) { zaiFallbackSpec = checked.spec; zaiPendingApply.add(name); }
            else debug.log('self-implement.pod', 'zai-fallback-unavailable', { job: name, reason: 'secret-unavailable' }, { level: 'warn' });
          } else debug.log('self-implement.pod', 'zai-fallback-unavailable', {
            job: name, reason: slot.route === 'refuse' ? 'slot-refused' : 'slot-unavailable', active,
          }, { level: 'warn' });
          if (!zaiFallbackSpec) fallbackSteps = fallbackSteps.filter(step => step !== 'zai');
        }
        const fallbackChain = { steps: fallbackSteps, source: normalizedFallback.usedDefault ? 'default' as const : 'host' as const };
        debug.log('self-implement.pod', 'fallback-chain-carried', {
          job: name, source: fallbackChain.source, steps: fallbackChain.steps,
          ...(normalizedFallback.dropped.length ? { droppedCount: normalizedFallback.dropped.length } : {}),
        });
        const secret = {
          apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
          metadata: { name: `${name}-creds`, namespace, labels: { 'elanous.job': name } },
          stringData: {
            ...(anthropic || bedrockChild || zaiChild ? {}
              : openrouter ? (roleCodexCredential ? { 'elanous-auth.json': roleCodexCredential.elanousAuth, 'codex-auth.json': roleCodexCredential.codexAuth } : {})
              : grok
              ? ('grokAuth' in creds && creds.grokAuth
                ? { 'grok-auth.json': creds.grokAuth }
                : { 'grok-api-key': (creds as { grokApiKey: string }).grokApiKey })
              : codexCredentials
                ? Object.fromEntries(codexCredentials.map((candidate, i) => [`codex-${i}.json`, JSON.stringify({ elanousAuth: candidate.elanousAuth, codexAuth: candidate.codexAuth })]))
                : { 'elanous-auth.json': (creds as ReturnType<typeof hostCredentials>).elanousAuth, 'codex-auth.json': (creds as ReturnType<typeof hostCredentials>).codexAuth }),
            'gh-token': podGhToken, feature: input.feature,
            'llm-fallback-config.json': JSON.stringify({ llm: { fallbackChain: fallbackChain.steps } }),
            ...(goalDocument !== undefined ? { 'goal-doc': goalDocument } : {}),
            ...Object.fromEntries(Object.entries(skillEnvs).map(([n, text]) => [`skillenv-${n}`, text])),
            ...(grounding ? { [`env-${GROUNDING_TOKEN_ENV}`]: grounding.token } : {}),
            ...(credentialRelay ? { [`env-${POD_CREDENTIAL_TOKEN_ENV}`]: credentialRelay.token } : {}),
            ...(githubRelay ? { [`env-${POD_GITHUB_CREDENTIAL_TOKEN_ENV}`]: githubRelay.token } : {}),
            ...Object.fromEntries(githubPassKeys.map((k) => [k, hostKey(k)] as const).filter(([, v]) => v).map(([k, v]) => [`env-${k}`, v!])),
          },
        };
        const passEnv = githubPassKeys.filter((k) => hostKey(k));
        const missing = githubPassKeys.filter((k) => !hostKey(k));
        if (missing.length) debug.log('self-implement.pod', 'pass-env-missing', { job: name, missing }, { level: 'warn' });
        // ☸️ 재개(P3 · 2026-09-26): 같은 이름의 Job 이 이미 있으면 «지우지 않고» 붙는다 — 호스트가 끊긴 동안에도 원격은 계속 돌았다.
        //   🩸 종전엔 여기서 delete 부터 해서, 재개가 원격에서 멀쩡히 돌던 Job 을 죽였다. 실패로 끝난 Job 만 지우고 다시 만든다.
        // ☸️ 노드 레지스트리에 이 판이 있으면 그것을 pull 한다(델타 · 대표 2026-09-26) — 라벨 판정은 로컬 이미지 이름으로 한다.
        const jobImage = member?.imageRef ?? image;
        // A pool member may pull a different image than the host's local one.
        // The local Docker label cannot prove that member image's commit.
        const localImageCommit = options.imageCommit !== undefined ? options.imageCommit : options.kubectl ? null : podImageFreshness({ image }).imageCommit;
        const jobImageCommit = jobImage === image ? localImageCommit : null;
        const launchRunId = retryAccount || oomRetried || ghLoginRetried ? mintRunId() : childRunId;
        let liveChildRunId = launchRunId;
        // TA-POD-WARMBOOT-PARITY — the id the followed Job prints in its result marker (null = wait on the condition only).
        let markerToken: string | null = null;
        let reattachedMemoryLimit: string | undefined;
        let existingExecutionKey: string | undefined;
        let existingAttempt = NaN;
        let existingChildScript = '';
        let jobApplyStartedAt: number | undefined;
        let lifecycleJobUid: string | undefined;
        const existing = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.metadata.uid} {.status.conditions[*].type}']);
        const [existingUid = '', ...existingConditions] = existing.status === 0 ? existing.stdout.trim().split(/\s+/u) : [];
        const hasExistingJob = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(existingUid);
        if (hasExistingJob) lifecycleJobUid = existingUid;
        let reattach = hasExistingJob && !/Failed|FailureTarget/.test(existingConditions.join(' '));
        const failedExisting = hasExistingJob && /Failed|FailureTarget/.test(existingConditions.join(' '));
        if (hasExistingJob) {
          const existingJob = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'json']);
          if (existingJob.status === 0) {
            try {
              const job = JSON.parse(existingJob.stdout) as { metadata?: { annotations?: Record<string, string> }; spec?: { template?: { spec?: { containers?: Array<{ name?: string; args?: string[]; env?: Array<{ name: string; value?: string }>; resources?: { limits?: { memory?: string } } }> } } } };
              existingExecutionKey = job.metadata?.annotations?.[POD_EXECUTION_KEY_ANNOTATION];
              existingAttempt = Number(job.metadata?.annotations?.[POD_ATTEMPT_ANNOTATION] ?? NaN);
              const child = job.spec?.template?.spec?.containers?.find((c) => c.name === 'child');
              reattachedMemoryLimit = child?.resources?.limits?.memory;
              existingChildScript = (child?.args ?? []).join('\n');
              const inherited = child?.env?.find((e) => e.name === 'ELANOUS_RUN_ID')?.value;
              if (inherited && inherited !== parentRunId && inherited === normalizeRunId(inherited)) liveChildRunId = inherited;
              if (oomRetried && reattach && reattachedMemoryLimit && (memoryGi(reattachedMemoryLimit) ?? 0) < (memoryGi(memoryLimit) ?? Infinity)) reattach = false;
              // A resumed App Job has an unknown remaining lifetime; refresh its gh config on the first live poll.
              ghTokenExpiresAt = child?.args?.[0]?.includes('gh auth login --with-token < /creds/gh-token') ? now() : null;
            } catch { /* The existing Job's identity must be verified before following it. */ }
          }
          // POD9 must-fix: an OOM-retry resume follows only this execution's attempt-2 Job — a high Job another goal made
          // under the same space name must not be read as this goal's retry result.
          // Same execution's attempt 1 (the lower-memory OOM Job) still goes through the existing replace path below.
          if (oomRetried && (existingExecutionKey !== executionKey || (existingAttempt !== 1 && existingAttempt !== 2))) {
            debug.log('self-implement.pod', 'oom-retry-job-mismatch', { job: name, expectedAttempt: 2, attempt: Number.isNaN(existingAttempt) ? null : existingAttempt, sameExecution: existingExecutionKey === executionKey });
            return { exitCode: 1, output: '', error: { code: 'pod-oom-retry-mismatch', message: `Job ${name} 은 이 골의 OOM 재시도(attempt 2)가 아니다 — 따라가지 않는다` } };
          }
          if (!reattach && !failedExisting) liveChildRunId = launchRunId;
          if (reattach && liveChildRunId === launchRunId && !failedExisting) {
            debug.log('self-implement.pod', 'job-reattach-id-unavailable', { job: name });
            return { exitCode: 1, output: '', error: { code: 'pod-child-run-id', message: `Job ${name} child runId를 확인할 수 없다` } };
          }
        }
        if (failedExisting) {
          const pods = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${name}`, '-o', 'jsonpath={range .items[*]}{.metadata.creationTimestamp}{"\\t"}{range .status.containerStatuses[?(@.name=="child")]}{.state.terminated.reason}{"\\t"}{.state.terminated.exitCode}{end}{"\\n"}{end}']);
          const latestPod = pods.status === 0 ? pods.stdout.trimEnd().split('\n').map((line) => line.split('\t'))
            .filter(([created]) => created && !Number.isNaN(Date.parse(created)))
            .sort((a, b) => Date.parse(b[0]!) - Date.parse(a[0]!))[0] : undefined;
          const failedOom = latestPod?.[1]?.trim() === 'OOMKilled' && latestPod[2]?.trim() === '137';
          // Once attempt 2 exists, consume its terminal result even if it failed for a non-OOM reason.
          // Only the old, lower-memory attempt may be removed to make room for high.
          if (failedOom || oomRetried) reattach = !oomRetried || (memoryGi(reattachedMemoryLimit ?? '') ?? 0) >= (memoryGi(memoryLimit) ?? Infinity);
          if ((failedOom || reattach) && (memoryGi(reattachedMemoryLimit ?? '') === null || liveChildRunId === launchRunId)) {
            return { exitCode: 1, output: '', error: { code: 'pod-memory-unavailable', message: `Job ${name} 실제 메모리 한도 또는 child runId를 확인할 수 없다` } };
          }
        }
        if (reattach) {
          if (reattachedMemoryLimit) memoryLimit = reattachedMemoryLimit;
          debug.log('self-implement.pod', 'job-reattach', { job: name, conditions: existingConditions.join(' ') || 'running', spaceId: input.spaceId });
          // A Job made before the marker existed never prints one — its wait stays on the condition (review mf: verify
          // the existing Job's own script carries this run's marker line before arming the tail read).
          if (resultMarkerOn) {
            const line = (await import('./pod-result-marker-wait.js')).podResultMarkerShellLine(liveChildRunId);
            if (line && existingChildScript.includes(line)) markerToken = liveChildRunId;
            else debug.log('self-implement.pod', 'result-marker-skipped', { job: name, reason: 'reattached-job-without-marker' });
          }
        }
        if (!hostRefresh && ghTokenExpiresAt === null && !githubRelay) debug.log('self-implement.pod', 'gh-token-app-skipped', { job: name, reason: 'no-verified-app-or-refresh-path' });
        let appliedMemoryRequest: string | undefined;
        if (!reattach) {
        if (oomRetried && hasExistingJob && !failedExisting && memoryGi(reattachedMemoryLimit ?? '') === null) {
          return { exitCode: 1, output: '', error: { code: 'pod-memory-unavailable', message: `Job ${name} 실제 메모리 한도를 확인할 수 없다` } };
        }
        if (oomRetried && !retryAccount) {
          const retryLimit = podMemoryLimitFor(input.feature, { ...env, ELANOUS_POD_MEMORY_TIER: retryTier }).limit;
          if ((memoryGi(memoryLimit) ?? 0) < (memoryGi(retryLimit) ?? Infinity)) throw new Error(`pod: OOM 재시도 한도가 ${retryTier} 와 다름: ${memoryLimit}`);
          const leaseMembers = member ? [member] : [{ context, capacity: 1, k3dCluster: '' }];
          const lease = recommendConcurrency(measurePoolLease(leaseMembers, { kubectl: (args) => baseKubectl(args) }), {
            capacity: leaseMembers.reduce((sum, item) => sum + item.capacity, 0), perGoalMemory: retryLimit, accounts: 0, perAccount: 0,
          });
          if (lease.recommended === null || lease.placeableSlots === null || lease.placeableSlots < 1 || lease.memorySlots === null || lease.memorySlots < 1) {
            return { exitCode: 1, output: '', error: { code: 'pod-lease', message: `OOM 재시도 ${retryTier} 자리 판정 실패: ${lease.reason ?? lease.limitedBy ?? 'no capacity'}\n${formatLastMemSample(retrySamples.at(-1))}` } };
          }
          debug.log('self-implement.pod', 'oom-retry-lease', { job: name, context, memoryLimit: retryLimit, tier: retryTier, recommended: lease.recommended });
        }
        if (failedExisting && !reattach && !oomRetried && collectFullLogs('failed-job-logs-unavailable').status === 'incomplete') {
          return { exitCode: 1, output: '', error: { code: 'pod-collection-incomplete', message: `Job ${name} recovery incomplete — old Job retained` } };
        }
        if (hasExistingJob) {
          const removed = kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=true']);
          if (removed.status !== 0) return { exitCode: 1, output: removed.stderr, error: { code: 'pod-delete', message: removed.stderr.trim() } };
        }
        const applySecret = () => kubectl(['apply', '-f', '-'], JSON.stringify(secret));
        let s = applySecret();
        // K3S-SECRET-DB-LOCK-RETRY — k3s sqlite «database is locked» 는 백오프 재시도 · 소진 시에만 아래 pod-secret 실패.
        if (kubectlTransientReason(s)) s = await retryKubectlTransient(applySecret, s, { sleep, category: 'pod.secret', data: { job: name, namespace, context } });
        if (s.status !== 0) return { exitCode: 1, output: s.stderr, error: { code: 'pod-secret', message: s.stderr.trim() } };
        const jobPassEnv = [
          ...passEnv,
          ...(grounding ? [GROUNDING_TOKEN_ENV] : []),
          ...(credentialRelay ? [POD_CREDENTIAL_TOKEN_ENV] : []),
          ...(githubRelay ? [POD_GITHUB_CREDENTIAL_TOKEN_ENV] : []),
        ];
        const detail = selectLiveDetail(options.liveDetailFile ? { path: options.liveDetailFile } : {}).state;
        const detailUntil = detail && (detail.scope === 'all' || detail.scope === parentRunId || detail.scope === launchRunId) && detail.until > Date.now()
          ? String(detail.until) : undefined;
        const armEnv = Object.fromEntries(Object.entries(options.armEnv ?? {}).filter(([key]) => key !== 'ELANOUS_LIVE_DETAIL_UNTIL' && !key.startsWith('ELANOUS_PROMPT_ENHANCE_') && key !== POD_GITHUB_CREDENTIAL_TOKEN_ENV && key !== POD_GITHUB_CREDENTIAL_URL_ENV && (!hostRefresh || !['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR'].includes(key))));
        const seat = env.ELANOUS_HARNESS_SEAT;
        const authorEnv = authorChoice ? {
          ...(authorChoice.modelSource !== 'default' || inferProviderFromModel(authorChoice.model) === 'openai-codex' ? {
            ELANOUS_PROMPT_ENHANCE_MODEL: authorChoice.model,
            ELANOUS_PROMPT_ENHANCE_MODEL_RELAY: 'pod',
            ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE: authorChoice.modelSource,
            ...(authorFallbackReason ? { ELANOUS_PROMPT_ENHANCE_MODEL_FALLBACK_REASON: authorFallbackReason } : {}),
            ...(authorRequestedModel ? { ELANOUS_PROMPT_ENHANCE_REQUESTED_MODEL: authorRequestedModel, ELANOUS_PROMPT_ENHANCE_REQUESTED_SOURCE: authorRequestedSource! } : {}),
          } : {}),
          ...(authorChoice.effortSource !== 'default' ? { ELANOUS_PROMPT_ENHANCE_EFFORT: authorChoice.effort } : {}),
        } : {};
        const budgetRead = hostBudgetSnapshot(podDelegatedChildLlm(jobArgs) ?? {}, options, env, name);
        const budgetSnapshot = budgetRead instanceof Promise ? await budgetRead : budgetRead;
        // REVIEW-ACP-POD ②-b — 호스트가 병합 전에 Claude ACP 로 리뷰할 런이면 Pod 안 api 리뷰를 «호스트로 미룬다»(리뷰 둘 = 돈 두 번 방지).
        //   ⛔ 자동 병합(merge-by-host) 런만 — 호스트 리뷰 문은 merge-ready 에서만 열린다. kubectl 주입(=시험)이면 사용자 설정을 읽지 않는다.
        const reviewDeferredToHost = input.autoMerge === true
          && resolvePodHostAcpReview(options.hostAcpReview, env, options.kubectl ? () => undefined : getUserConfig).enabled;
        if (reviewDeferredToHost) debug.log('self-implement.pod', 'review-deferred-armed', { job: name, env: REVIEW_DEFERRED_TO_HOST_ENV, ...(reviewerPin ? { reviewerPinUnused: reviewerPin } : {}) });
        const jobArmEnv = grounding || credentialRelay || githubRelay || env.ELANOUS_DISPATCH_RECORDED === '1' || options.armEnv || detailUntil || seat || env.ELANOUS_POD_AUTHOR_ON_POD === '1' || reviewerPin || reviewDeferredToHost || budgetSnapshot
          ? {
              ...armEnv,
              ...(budgetSnapshot ? { [BUDGET_SNAPSHOT_ENV]: encodeBudgetSnapshot(budgetSnapshot) } : {}),
              ...authorEnv,
              ...(reviewerPin ? { [roleLlmEnvName('review')]: reviewerPin } : {}),
              ...(reviewDeferredToHost ? { [REVIEW_DEFERRED_TO_HOST_ENV]: '1' } : {}),
              ...(detailUntil ? { ELANOUS_LIVE_DETAIL_UNTIL: detailUntil } : {}),
              ...(env.ELANOUS_DISPATCH_RECORDED === '1' ? { ELANOUS_DISPATCH_RECORDED: '1' } : {}),
              ...(seat === 'OP' || seat === 'TC' || seat === 'MK' || seat === 'UX' ? { ELANOUS_HARNESS_SEAT: seat } : {}),
              ...(env.ELANOUS_POD_AUTHOR_ON_POD === '1'
                ? { ELANOUS_POD_AUTHOR_ON_POD: '1', ...(env.ELANOUS_POD_AUTHOR_GRADE_SOURCE === 'flag' || env.ELANOUS_POD_AUTHOR_GRADE_SOURCE === 'config' || env.ELANOUS_POD_AUTHOR_GRADE_SOURCE === 'default'
                  ? { ELANOUS_POD_AUTHOR_GRADE_SOURCE: env.ELANOUS_POD_AUTHOR_GRADE_SOURCE, ...(env.ELANOUS_POD_AUTHOR_GRADE === 'lite' || env.ELANOUS_POD_AUTHOR_GRADE === 'full' ? { ELANOUS_POD_AUTHOR_GRADE: env.ELANOUS_POD_AUTHOR_GRADE } : {}) } : {}) } : {}),
              ...(grounding ? { [GROUNDING_URL_ENV]: groundingUrl! } : {}),
              ...(credentialRelay ? { [POD_CREDENTIAL_URL_ENV]: `${new URL(groundingUrl!).origin}${POD_CREDENTIAL_GROK_PATH}` } : {}),
              ...(githubRelay ? { [POD_GITHUB_CREDENTIAL_URL_ENV]: `${new URL(groundingUrl!).origin}${POD_CREDENTIAL_GITHUB_PATH}` } : {}),
            }
          : undefined;
        // OOM retry has its own explicit full-tier admission, so preserve the measured request there.
        const measuredRequest = podMemoryRequestForWithCap(requestKind, advice, !oomRetried);
        const requestGi = memoryGi(measuredRequest);
        const limitGi = memoryGi(memoryLimit);
        const documentDefaultLite = !oomRetried && selectedGoalType === 'document' && memoryTier === 'lite'
          && (memorySource === 'goal-type-auto' || memoryReason === 'goal-type-default');
        const memoryRequest = documentDefaultLite ? memoryLimit
          : requestGi !== null && limitGi !== null && requestGi > limitGi ? memoryLimit : measuredRequest;
        const peakMiB = advice?.byGoalType.find((entry) => entry.goalType === requestKind)?.evidence.peakMiB.p95;
        const rawMeasuredGi = typeof peakMiB === 'number' && Number.isFinite(peakMiB) && peakMiB >= 0
          ? Math.max(1, Math.ceil(peakMiB * 1.25 / 1024)) : null;
        const appliedGi = memoryGi(memoryRequest);
        if (rawMeasuredGi !== null && appliedGi !== null && appliedGi < rawMeasuredGi) {
          debug.log('pod.memory', 'request-adjusted', { spaceId: input.spaceId, kind: requestKind, measuredGi: rawMeasuredGi,
            requestGi: appliedGi, memoryLimit, reason: limitGi === appliedGi ? 'memory-limit' : 'admission-cap' });
        }
        appliedMemoryRequest = memoryRequest;
        debug.log('self-implement.pod', 'memory-request', { spaceId: input.spaceId, job: name,
          tier: oomRetried ? retryTier : memoryTier, reason: oomRetried ? 'OOMKilled' : memoryReason,
          memoryLimit, memoryRequest });
        const ownerKind = env.ELANOUS_POD_OWNER_KIND;
        const workIdentity: PodWorkIdentity = {
          ...(ownerKind === 'seat' || ownerKind === 'steward' || ownerKind === 'orchestrator' || ownerKind === 'external'
            ? { ownerKind, ownerId: env.ELANOUS_POD_OWNER_ID } : seat === 'OP' || seat === 'TC' || seat === 'MK' || seat === 'UX'
              ? { ownerKind: 'seat', ownerId: seat } : {}),
          taskCard: env.ELANOUS_POD_TASK_CARD ?? env.ELANOUS_TASK_CARD_ID,
          slotId: env.ELANOUS_POD_SLOT_ID,
          work: !goalDoc && env.ELANOUS_POD_AUTHOR_ON_POD === '1' && !shard ? 'authoring' : (oomRetried ? retryTier : memoryTier) === 'lite' ? 'lite' : 'harness',
        };
        // TA-POD-WARMBOOT-PARITY shadow only: record the decision on the existing fresh-Job path.
        // Until a shared warm-candidate contract exists, evidence stays unmeasured and this never changes execution.
        if (workIdentity.taskCard) {
          const warmReuseConfig = options.warmReuseConfig?.() ?? (options.kubectl ? undefined : getUserConfig().pod?.warmReuse);
          const decision = decideWarmReuse('ta', warmReuseConfig, options.warmReuseEvidence?.());
          debug.log('pod.warm', 'ta-shadow-observation', { ...decision, execution: 'fresh-job' });
        }
        // TA-POD-WARMBOOT-PARITY (GATE-WARM-BOOT parity · #27805): a commit-pinned source on a pool host — put that commit into
        // the host mirror first (once per host·commit in this process) so podSourceScript finds it instead of fetching
        // from GitHub. Best effort: a failed seed only logs; the Job is applied either way.
        // SI-SEED-DEFAULT: a default source (TA's main HEAD Jobs) seeds too — the host resolves the branch tip once and seeds
        // that sha. When a condition is false the skip is one `mirror-seed-skipped` line naming it (no silent fallback).
        const seedMirror = options.seedMirror ?? (options.kubectl ? undefined : seedMirrorOnce);
        const seedSource: PodSource = options.source ?? { kind: 'default' };
        const seedCwd = options.mirrorSeedCwd ?? process.cwd();
        let seedCommit: string | undefined;
        let seedSkip: string | undefined;
        if (!seedMirror) seedSkip = 'no-seeder';
        else if (!hostMirror) seedSkip = 'no-host-mirror';
        else if (!member?.sshHost) seedSkip = 'no-ssh-host';
        else if (seedSource.kind === 'commit') seedCommit = seedSource.sha;
        else if (seedSource.kind !== 'default') seedSkip = `source-${seedSource.kind}`;
        else {
          const resolveHead = options.resolveSourceHead ?? (options.kubectl ? undefined : resolveDefaultSourceHead);
          let head: { sha?: string; reason?: string } | undefined;
          try { head = resolveHead ? await resolveHead({ repoUrl, ...(seedSource.base ? { base: seedSource.base } : {}), cwd: seedCwd }) : undefined; }
          catch { head = { reason: 'resolve-threw' }; }
          if (!resolveHead) seedSkip = 'no-head-resolver';
          else if (head?.sha && /^[0-9a-f]{40}$/.test(head.sha)) seedCommit = head.sha;
          else seedSkip = `default-head-${head?.reason ?? 'unresolved'}`;
        }
        if (seedMirror && seedCommit && member?.sshHost) {
          const seedHost = member.sshHost;
          // try/catch as well as .catch (review mf): an injected seed that throws synchronously must not stop the Job.
          let seed: MirrorSeedResult | undefined;
          try {
            seed = await seedMirror({ host: seedHost, commit: seedCommit, cwd: seedCwd });
          } catch (error) {
            seed = { host: seedHost, ok: false, ms: 0, detail: String(error).slice(0, 300) };
          }
          debug.log('self-implement.pod', 'mirror-seed', { job: name, host: seedHost, commit: seedCommit, sourceKind: seedSource.kind, ok: seed?.ok ?? false, ms: seed?.ms ?? 0, ...(seed?.detail ? { detail: seed.detail } : {}) }, seed?.ok ? undefined : { level: 'warn' });
        } else {
          debug.log('self-implement.pod', 'mirror-seed-skipped', { job: name, reason: seedSkip ?? 'unknown', sourceKind: seedSource.kind, ...(member?.sshHost ? { host: member.sshHost } : {}) });
        }
        // TA-POD-WARMBOOT-PARITY (GATE-POD-RESULT-MARKER parity · #27815): this launch's marker is the child's last line.
        const resultMarkerLine = resultMarkerOn ? (await import('./pod-result-marker-wait.js')).podResultMarkerShellLine(launchRunId) ?? undefined : undefined;
        if (resultMarkerLine) markerToken = launchRunId;
        // POD-GROK-VALIDITY-FIT — without a relay the Pod cannot renew the copy, so the Job ends before the token does.
        // Measured right before the Job is applied (review r2): setup between the credential check and here takes time.
        if (grokSubscription) {
          const shippedExpiresAtMs = shippedGrokExpiresAtMs((creds as { grokAuth: string }).grokAuth);
          const fit = fitPodDeadlineToGrok({ requestedSeconds: jobDeadlineSeconds, expiresAtMs: shippedExpiresAtMs, nowMs: (options.now ?? Date.now)(), relay: Boolean(credentialRelay) });
          if (fit.refused) {
            debug.log('self-implement.pod', 'grok-deadline-refused', { job: name, requestedSeconds: jobDeadlineSeconds, availableSeconds: fit.availableSeconds, minJobSeconds: POD_GROK_MIN_JOB_SECONDS, marginMs: POD_GROK_EXPIRY_MARGIN_MS });
            cleanupSecret();
            return { exitCode: 1, output: '', error: { code: 'pod-grok-expiring', message: `grok: 구독 access 토큰 남은 시간 ${formatGrokRemaining(fit.availableSeconds * 1000 + POD_GROK_EXPIRY_MARGIN_MS)} < Pod 발사 기준 ${formatGrokRemaining(POD_GROK_MIN_VALIDITY_MS)} — 발사 직전 재검증 · 다음: 호스트에서 grok login --device-auth 후 다시` } };
          }
          debug.log('self-implement.pod', fit.fitted ? 'grok-deadline-fitted' : 'grok-deadline-kept', { job: name, requestedSeconds: jobDeadlineSeconds, deadlineSeconds: fit.deadlineSeconds, availableSeconds: fit.availableSeconds, relay: Boolean(credentialRelay), marginMs: POD_GROK_EXPIRY_MARGIN_MS });
          jobDeadlineSeconds = fit.deadlineSeconds;
        }
        // POD-LAUNCH-PROVENANCE — fail-closed: a si-task Job without its ★ identity is never applied.
        let provenance: PodProvenanceMetadata;
        try {
          let version: string | undefined;
          try { version = packageVersion(); } catch { version = undefined; }
          provenance = podProvenanceMetadata(siTaskPodProvenance({ env, runId: launchRunId, ...(parentRunId ? { parentRunId } : {}), workIdentity,
            requestedAt: new Date((options.now ?? Date.now)()).toISOString(), feature: input.feature, launchHost: resolveHostId(env),
            commit: seedSource.kind === 'commit' ? seedSource.sha : seedCommit ?? jobImageCommit, ...(version ? { version } : {}),
            ...(memoryRequest ? { memReq: memoryRequest } : {}) }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          debug.log('pod.provenance', 'si-task-refused', { job: name, reason: message }, { level: 'warn' });
          cleanupSecret();
          return { exitCode: 1, output: '', error: { code: 'pod-provenance', message } };
        }
        const job = podJobManifest({ provenance, name, namespace, fallbackChain, ...(resultMarkerLine ? { resultMarkerLine } : {}), image: jobImage, workIdentity, ...(env.ELANOUS_TASK_BOUND_PR && /^[1-9]\d*$/.test(env.ELANOUS_TASK_BOUND_PR) && Number.isSafeInteger(Number(env.ELANOUS_TASK_BOUND_PR)) ? { boundPrNumber: Number(env.ELANOUS_TASK_BOUND_PR) } : {}), ...(member?.imageRef ? { imagePullPolicy: 'IfNotPresent' as const } : {}), repoUrl, ...(options.source ? { source: options.source } : {}), ...(options.repairCommitOnly ? { repairCommitOnly: options.repairCommitOnly } : {}), ...(hostMirror ? { hostMirror } : {}), args: jobArgs, passEnv: jobPassEnv, deadlineSeconds: jobDeadlineSeconds, ...(goalDoc ? { goalDoc } : env.ELANOUS_POD_AUTHOR_ON_POD === '1' && !shard ? { authorSentence: true, ...(env.ELANOUS_POD_AUTHOR_GRADE === 'lite' || env.ELANOUS_POD_AUTHOR_GRADE === 'full' ? { authorGrade: env.ELANOUS_POD_AUTHOR_GRADE } : {}) } : {}), runId: launchRunId, ...(parentRunId ? { parentRunId } : {}), ...(jobArmEnv ? { armEnv: jobArmEnv } : {}), hostId: resolveHostId(env), skillEnvs: Object.keys(skillEnvs), memoryLimit, memoryRequest, imageCommit: jobImageCommit, ...(grok ? { grokCredential: 'grokAuth' in creds && creds.grokAuth ? 'subscription' as const : 'api_key' as const } : {}), ...(codexAccounts ? { codexAccounts } : {}), ...(hostRefresh ? { appCredential: true } : {}), execution: { key: executionKey, attempt: oomRetried ? 2 : 1 }, hostLeaseAdmitted: !!releaseAdmission, ...(roleCodexCredential ? { reviewerCodexAuth: true } : {}), ...(bedrockSpec ? { bedrock: bedrockSpec } : {}), ...(zaiSpec ? { zai: zaiSpec } : {}), ...(zaiFallbackSpec ? { zaiFallback: zaiFallbackSpec } : {}) });   // kubectl 주입(=시험)이면 docker 를 부르지 않는다
        const carriedBranch = goalDoc ? 'goal-doc' as const : env.ELANOUS_POD_AUTHOR_ON_POD === '1' && !shard ? 'author' as const : undefined;
        const carriedChildLlm = carriedBranch ? podDelegatedChildLlm(jobArgs) : undefined;
        jobApplyStartedAt = Date.now();
        const a = kubectl(['apply', '-f', '-'], JSON.stringify(job));
        zaiPendingApply.delete(name);   // apply 뒤엔 Job 라벨이 센다(성공) · 실패면 셀 것이 없다
        if (a.status !== 0) { cleanupSecret(); return { exitCode: 1, output: a.stderr, error: { code: 'pod-apply', message: a.stderr.trim() } }; }
        releaseAdmission?.applied?.(name, context, namespace);
        const imageFacts = { job: name, childRunId: liveChildRunId, image: jobImage, imageCommit: jobImageCommit, context };
        // POD-LAUNCH-PROVENANCE — append-only «started» row: who · why · when, on the parent's existing run ledger.
        const startedRow = { job: name, run: launchRunId, attempt: oomRetried ? 2 : 1, provenance: provenanceRowFromAnnotations(provenance.annotations) };
        try { appendRunLedgerEntry({ runId: ledgerRunId, event: POD_LAUNCH_STARTED_EVENT, timestamp: new Date((options.now ?? Date.now)()).toISOString(), data: startedRow }, ledgerDir); }
        catch (error) { debug.log('pod.provenance', 'history-unavailable', { job: name, row: 'started', reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        debug.log('pod.provenance', 'job-started', startedRow);
        try { appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-job-image', data: imageFacts }, ledgerDir); }
        catch (error) { debug.log('self-implement.pod', 'job-image-ledger-unavailable', { job: name, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        debug.log('self-implement.pod', 'job-image', imageFacts);
        // The injected observer does not acquire a production lease. The gate consumer
        // must compare the Job result and explicitly finalize before enabling replay.
        if (!oomRetried && input.warmWorkerCommand && options.warmPodRequest) {
          setImmediate(() => {
            try {
              const request = options.warmPodRequest!({ command: input.warmWorkerCommand! });
              void Promise.resolve(request)
                .then((result) => debug.log('pod.warm', 'request-observation', {
                  spaceId: input.spaceId, status: result.status, reason: result.reason, execution: 'fresh-job',
                }))
                .catch((error) => debug.log('pod.warm', 'request-unavailable', {
                  spaceId: input.spaceId, reason: error instanceof Error ? error.message : String(error), execution: 'fresh-job',
                }, { level: 'warn' }));
            } catch (error) {
              debug.log('pod.warm', 'request-unavailable', {
                spaceId: input.spaceId, reason: error instanceof Error ? error.message : String(error), execution: 'fresh-job',
              }, { level: 'warn' });
            }
          });
        }
        // Logged only once the Job is applied — a failed apply carried nothing.
        if (carriedBranch && carriedChildLlm) debug.log('self-implement.pod', 'child-llm-carried', { spaceId: input.spaceId, job: name, branch: carriedBranch, provider: carriedChildLlm.provider, model: carriedChildLlm.model ?? null });
        if (options.source?.kind === 'bundle') {
          const podName = await waitForRunningPod(kubectl, namespace, name, sleep);
          if (!podName) {
            debug.log('self-implement.pod', 'source-mismatch', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
            cleanupSecret();
            return { exitCode: 1, output: '', error: { code: 'pod-source', message: `Pod for ${name} did not become Running` } };
          }
          releaseAdmission?.observed?.();
          if (releaseAdmission) delete releaseAdmission.observed;
          const copied = kubectl(['cp', options.source.bundlePath, `${podName}:/tmp/source.bundle`, '-c', 'child', '-n', namespace]);
          if (copied.status !== 0) {
            debug.log('self-implement.pod', 'source-mismatch', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
            cleanupSecret();
            return { exitCode: 1, output: copied.stderr, error: { code: 'pod-source', message: copied.stderr.trim() || 'kubectl cp failed' } };
          }
          const ready = kubectl(['-n', namespace, 'exec', podName, '-c', 'child', '--', 'touch', '/tmp/source.ready']);
          if (ready.status !== 0) {
            debug.log('self-implement.pod', 'source-mismatch', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
            cleanupSecret();
            return { exitCode: 1, output: ready.stderr, error: { code: 'pod-source', message: ready.stderr.trim() || 'kubectl exec touch failed' } };
          }
          debug.log('self-implement.pod', 'source-delivered', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
        }
        // ☸️ P2: 비밀의 소유자 = Job — 호스트가 죽어도 Job 의 TTL 삭제와 함께 k8s 가 비밀을 거둔다(자격 사본이 클러스터에 남지 않는다).
        const uid = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.metadata.uid}']).stdout.trim();
        lifecycleJobUid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(uid) ? uid : undefined;
        if (uid) {
          const owned = kubectl(['-n', namespace, 'patch', 'secret', `${name}-creds`, '--type=merge', '-p', JSON.stringify({ metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name, uid }] } })]);
          if (owned.status !== 0) debug.log('self-implement.pod', 'secret-owner-failed', { job: name, stderr: owned.stderr.trim() }, { level: 'warn' });
        }
        }
        try {
          appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-child-run', data: { childRunId: liveChildRunId, job: name, attempt: oomRetried ? 2 : 1, ...(goalFile ? { goalFile } : {}) } }, ledgerDir);
          if (lastPlacement) appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-placement', data: { job: name, childRunId: liveChildRunId, attempt: oomRetried ? 2 : 1, member: lastPlacement.member, kind: lastPlacement.kind, outcome: lastPlacement.outcome, preferred: lastPlacement.preferred, reason: lastPlacement.reason } }, ledgerDir);
          appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-memory-selected', data: { job: name, childRunId: liveChildRunId, attempt: oomRetried ? 2 : 1, limit: memoryLimit, ...(appliedMemoryRequest ? { request: appliedMemoryRequest } : {}), tier: oomRetried ? retryTier : memoryTier, source: oomRetried ? 'oom-retry' : memorySource, reason: oomRetried ? 'OOMKilled' : memoryReason, declaredGoalType: selectedGoalType } }, ledgerDir);
          if (oomRetried && retryFromChildRunId) appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-oom-retry', data: { attempt: 2, from: retryFromMemoryLimit ?? selectedMemoryLimit, to: memoryLimit, tier: retryTier, reason: 'OOMKilled', job: name, childRunId: liveChildRunId, fromChildRunId: retryFromChildRunId } }, ledgerDir);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          debug.log('self-implement.pod', 'parent-ledger-unavailable', { job: name, reason, attempt: oomRetried ? 2 : 1 });
          // POD9 must-fix: attempt 2 without its ledger record must not end as a success — the ledger would show a retry-less pass.
          if (oomRetried) return { exitCode: 1, output: '', error: { code: 'pod-oom-retry-ledger', message: `OOM 재시도 원장 기록 실패: ${reason}` } };
        }
        writePodFragment({ spaceId: input.spaceId, context, namespace, job: name, inboxDir: POD_CONTROL_INBOX_DIR, ...(liveChildRunId === normalizeRunId(liveChildRunId) ? { runId: liveChildRunId } : {}), ...(parentRunId && normalizeRunId(parentRunId) === parentRunId ? { parentRunId } : {}) }, env);
        recorded = true;
        debug.log('self-implement.pod', 'job-applied', { job: name, namespace, ...(member ? { context: member.context } : {}), image: jobImage, spaceId: input.spaceId, passEnv, ...(openrouter ? { openrouterKeyPresent: passEnv.includes('OPENROUTER_API_KEY') } : {}), ...(openGateway ? { openGatewayKeyPresent: passEnv.includes('OPENGATEWAY_API_KEY') } : {}), ...(anthropic ? { anthropicKeyPresent: passEnv.includes('ANTHROPIC_API_KEY') } : {}), ...(bedrockSpec ? { bedrockSecret: bedrockSpec.secretName, bedrockSecretKeys: bedrockSpec.keys, bedrockRegionFrom: bedrockSpec.region.from } : {}), ...(zaiRoute ? { zaiRoute, ...(zaiSpec ? { zaiSecret: zaiSpec.secretName } : {}) } : {}), extraArgs: options.extraArgs ?? [], ...(options.armEnv?.ELANOUS_ARM_ID ? { armId: options.armEnv.ELANOUS_ARM_ID } : {}) });
        let state: 'complete' | 'failed' | 'aborted' = 'failed';
        let failedReason = '';
        let containerReason: string | null = null;
        let containerExitCode: number | null = null;
        // JOB-FAILURE-TERMINATION-CAPTURE — this Job's Kubernetes facts, read once at the failure verdict (before GC).
        //   Observation only: failedReason · containerReason · containerExitCode keep driving the classification.
        let podTermination: PodTermination | null = null;
        // METER-POD-ROLLUP-GAP — abort 때 Job 삭제 «전»에 거둔 로그 사본(삭제 뒤엔 PARTIAL 줄도 못 읽는다).
        let abortLogs = '';
        // ⭐ 런 «도중» 원장 증분 회수 — 호스트 슈퍼바이저가 Pod 걸음을 실시간으로 본다(🅣 요청 · 힐 루프 runtime 성형의 전제).
        const follower = createPodLedgerFollower({ runId: liveChildRunId, dir: ledgerDir, exec: (script) => kubectl(['-n', namespace, 'exec', `job/${name}`, '-c', 'child', '--', 'sh', '-c', script]) });
        // ⭐ METER-POD-ROLLUP-GAP-3 — 런 «도중» 마지막 PARTIAL 줄을 호스트가 쥔다: Pod 가 지워지면(SIGTERM 등) 종료 로그에서 PARTIAL 이 사라진다.
        let livePartialLine: string | null = null;
        let pollsSinceCapture = 0;
        let imageSnapshotRecorded = false;
        let terminalImageRecorded = false;
        const recordPodImage = (final: boolean): void => {
          if (final ? terminalImageRecorded : imageSnapshotRecorded) return;
          const observed = readJobPodImage(kubectl, namespace, name, lifecycleJobUid);
          if (!final && !observed.podName) return;
          const append = (isFinal: boolean): void => {
            const data = { job: name, childRunId: liveChildRunId, attempt: oomRetried ? 2 : 1,
              image: jobImage, imageCommit: jobImageCommit, context, ...observed, final: isFinal };
            try {
              appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-image-digest', data }, ledgerDir);
              if (isFinal) terminalImageRecorded = true;
              else imageSnapshotRecorded = true;
            } catch (error) {
              debug.log('self-implement.pod', 'pod-image-digest-ledger-unavailable', {
                job: name, final: isFinal, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
            }
            debug.log('self-implement.pod', 'pod-image-digest', data);
          };
          if (final && !imageSnapshotRecorded && observed.podName) append(false);
          append(final);
        };
        const capturePolls = Math.max(1, options.usagePartialCapturePolls ?? Math.round(POD_USAGE_PARTIAL_CAPTURE_MS / Math.max(1, options.pollMs ?? 15_000)));
        const markerWait = markerToken ? await import('./pod-result-marker-wait.js') : null;
        const waitStartedAt = Date.now();
        for (;;) {
          if (input.signal?.aborted) {
            recordPodImage(true);
            // METER-POD-ROLLUP-GAP — Job 삭제 «전»에 로그를 한 번 거둔다: PARTIAL 줄이 삭제와 함께 사라지면 사용량이 0 처럼 보인다.
            try {
              const captured = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', '--tail=400']);
              if (captured.status === 0 && captured.stdout) abortLogs = captured.stdout;
            } catch { /* 수거 실패가 abort 자체를 막아선 안 된다 */ }
            kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=false']);
            state = 'aborted';
            break;
          }
          if (!imageSnapshotRecorded) recordPodImage(false);
          const g = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[*].type}']);
          const types = g.stdout;
          if (/Complete|SuccessCriteriaMet/.test(types)) { releaseAdmission?.observed?.(); state = 'complete'; break; }
          if (/Failed|FailureTarget/.test(types)) {
            releaseAdmission?.observed?.();
            state = 'failed';
            // One Job read serves both: column one is the classification reason, all three the capture (no re-read a GC could empty).
            let jobRead: { status: number | null; stdout: string } | null = null;
            let jobReadError: unknown;
            try { jobRead = kubectl(['-n', namespace, 'get', 'job', name, '-o', `jsonpath=${POD_TERMINATION_JOB_JSONPATH}`]); }
            catch (error) { jobReadError = error; }
            failedReason = jobRead?.status === 0 ? (jobRead.stdout.split('\t')[0] ?? '').trim() : '';
            // One Pods read serves both: its first three columns are the classification layout, the rest the termination capture.
            let podsRead: { status: number | null; stdout: string } | null = null;
            try {
              const pods = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${name}`, '-o', `jsonpath=${POD_TERMINATION_PODS_JSONPATH}`]);
              podsRead = pods;
              if (pods.status === 0 && pods.stdout) {
                const rows = pods.stdout.trimEnd().split('\n').map((line) => line.split('\t'));
                const latest = rows.filter(([created]) => created && !Number.isNaN(Date.parse(created)))
                  .sort((a, b) => Date.parse(b[0]!) - Date.parse(a[0]!))[0];
                if (latest) {
                  const [, reasonText, exitText] = latest;
                  containerReason = reasonText?.trim() || null;
                  containerExitCode = exitText?.trim() && /^\d+$/.test(exitText.trim()) ? Number(exitText.trim()) : null;
                }
              }
            } catch { /* Pod 가 사라졌거나 조회 불가 — 종료 사유는 미상. */ }
            debug.log('self-implement.pod', 'container-terminated', { job: name, container: 'child', reason: containerReason, exitCode: containerExitCode, jobReason: failedReason || null, memoryLimit });
            podTermination = readPodTermination({ kubectl, namespace, job: name, path: 'job-failed-condition', jobRead, podsRead, jobUid: lifecycleJobUid });
            if (jobReadError !== undefined) {
              // Today's outcome stays (the throw ends the spawn as pod-error); the capture is in the ledger first.
              try { appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: liveChildRunId, job: name, podTermination } }, ledgerDir); }
              catch (error) { debug.log('self-implement.pod', 'child-evidence-write-failed', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
              debug.log('self-implement.pod', 'pod-termination-captured', { job: name, podTermination, jobReadThrew: true }, { level: 'warn' });
              throw jobReadError;
            }
            break;
          }
          // TA-POD-WARMBOOT-PARITY: the condition is not there yet — the child may already be done (k3d condition lag).
          // A tail read that fails (Pod pending · init container) or lacks this launch's marker changes nothing.
          if (markerWait && markerToken) {
            const seen = markerWait.podResultMarkerRc(kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', '--tail=2']), markerToken);
            if (seen !== null) {
              releaseAdmission?.observed?.();
              state = seen === 0 ? 'complete' : 'failed';
              // The child's own rc (the Pod's terminated state may lag like the condition) — exit-code paths read it as before.
              if (seen !== 0) containerExitCode = seen;
              if (seen !== 0) podTermination = readPodTermination({ kubectl, namespace, job: name, path: 'result-marker', jobUid: lifecycleJobUid });
              debug.log('self-implement.pod', 'result-marker-early', { job: name, waitedMs: Date.now() - waitStartedAt, rc: seen });
              break;
            }
          }
          if (releaseAdmission?.observed) {
            const podPhase = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${name}`, '-o', 'jsonpath={.items[*].status.phase}']);
            if (podPhase.status === 0 && /\b(?:Running|Succeeded|Failed)\b/.test(podPhase.stdout)) {
              releaseAdmission.observed();
              delete releaseAdmission.observed;
            }
          }
          if (ghTokenExpiresAt !== null && ghTokenExpiresAt - now() <= 10 * 60_000) {
            try {
              const fresh = await issueVerifiedAppCredential();
              if (!fresh) throw new Error('mint-or-verification-failed');
              // No bearer in argv, stdout, stderr, or the run ledger. kubectl receives it only over stdin.
              const installed = kubectl(['-n', namespace, 'exec', '-i', `job/${name}`, '-c', 'child', '--', 'sh', '-c', APP_GH_EXEC, 'sh', 'gh', 'auth', 'login', '--with-token'], `${fresh.token}\n`);
              if (installed.status !== 0) {
                const fallback = kubectl(['-n', namespace, 'exec', '-i', `job/${name}`, '-c', 'child', '--', 'sh', '-c', APP_GH_EXEC, 'sh', 'bun', '-e', APP_GH_AUTH_SCRIPT], `${fresh.token}\n`);
                if (fallback.status !== 0) throw new Error('exec-failed');
              }
              ghTokenExpiresAt = fresh.expiresAt;
              debug.log('self-implement.pod', 'gh-token-refreshed', { job: name, expiresAt: new Date(fresh.expiresAt).toISOString() });
            } catch {
              debug.log('self-implement.pod', 'gh-token-refresh-failed', { job: name, reason: 'mint-verification-or-exec-failed' });
            }
          }
          try { follower?.poll(); } catch (e) { debug.log('self-implement.pod', 'ledger-live-unavailable', { job: name, reason: e instanceof Error ? e.message : String(e) }); }
          if (++pollsSinceCapture >= capturePolls) {
            pollsSinceCapture = 0;
            try {
              const sampled = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', `--since=${POD_USAGE_PARTIAL_CAPTURE_SINCE}`]);
              const seen = sampled.status === 0 ? lastPodUsagePartialLine(sampled.stdout) : null;
              // 창 안에 새 줄이 없으면 앞서 쥔 줄을 지킨다(덮어 지우지 않는다).
              if (seen) {
                livePartialLine = seen;
                debug.log('self-implement.pod', 'usage-partial-captured', { job: name, bytes: seen.length });
              }
            } catch (e) { debug.log('self-implement.pod', 'usage-partial-capture-failed', { job: name, reason: e instanceof Error ? e.message : String(e) }); }
          }
          await sleep(options.pollMs ?? 15_000);
        }
        if (!terminalImageRecorded) recordPodImage(true);
        let logs = '';
        let logTailReason: string | undefined;
        try {
          const fetched = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', '--tail=400']);
          if (fetched.status !== 0) logTailReason = fetched.stderr.trim() || `kubectl logs exited ${fetched.status}`;
          else if (!fetched.stdout) logTailReason = 'empty child logs';
          else logs = fetched.stdout;
        } catch (error) { logTailReason = error instanceof Error ? error.message : String(error); }
        // METER-POD-ROLLUP-GAP — 삭제된 abort Job 의 로그는 이후 못 읽는다: abort 때 거둔 사본으로 대신한다.
        if (!logs && abortLogs) logs = abortLogs;
        // TA-POD-WARMBOOT-PARITY: the marker line is not child output — remove it so the last-line result parse sees the same bytes.
        if (markerWait && markerToken && logs) logs = markerWait.stripPodResultMarker(logs, markerToken);
        let ledgerReason = '';
        let ledgerCollected = false;
        const collection = collectFullLogs('ledger-collect-incomplete', follower.owned ? new Set([liveChildRunId]) : undefined, (event, data) => {
          if ((event === 'ledger-collect-incomplete' || event === 'ledger-collect-skipped') && (data.runId === liveChildRunId || !data.runId)) ledgerReason = String(data.reason);
          if ((event === 'ledger-collected' || event === 'ledger-collect-already-complete') && data.runId === liveChildRunId) ledgerCollected = true;
        }, liveChildRunId);
        const samples = collection.status === 'unavailable' ? parseMemSamples(logs) : collection.samples;
        const oomKilled = state === 'failed' && containerReason === 'OOMKilled' && containerExitCode === 137;
        if (oomKilled) {
          // 자식 stdout 원문은 싣지 않는다 — 임의 출력에 든 비밀이 진단 경로로 새지 않도록 «모양»(줄·바이트)만 남긴다.
          const childLines = logs ? logs.replace(/\n$/, '').split('\n').filter((line) => !line.startsWith('ELANOUS_MEM ')) : [];
          const logShape = logs ? { lines: childLines.length, bytes: Buffer.byteLength(childLines.join('\n')) } : null;
          debug.log('self-implement.pod', 'oom-evidence', { job: name, memoryLimit, samples: samples.slice(-3), logShape, ...(logShape === null ? { logTailReason: logTailReason ?? 'empty child logs' } : {}) }, { compact: { maxDepth: 6 } });
        } else if (state === 'complete') {
          debug.log('self-implement.pod', 'memory-last', { job: name, sample: samples.at(-1) ?? null }, { compact: { maxDepth: 6 } });
        }
        const ledgerExists = existsSync(runLedgerPath(liveChildRunId, ledgerDir));
        const ledgerCompleteness = collection.childLedgerIncomplete || (follower.owned && !ledgerCollected) ? 'incomplete' : ledgerCollected ? 'complete' : 'missing';
        if (ledgerCompleteness === 'incomplete' || (state !== 'complete' && !ledgerExists)) {
          try { appendRunLedgerEntry({ runId: liveChildRunId, event: 'pod-ledger-incomplete', data: { job: name, reason: ledgerReason || (collection.status === 'unavailable' ? 'logs-unavailable' : ledgerExists ? 'collection-incomplete' : 'child-ledger-missing') } }, ledgerDir); }
          catch (error) { debug.log('self-implement.pod', 'ledger-marker-unavailable', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }); }
        }
        const salvage = recordPodSalvage(logs, name);
        cleanupSecret();
        // ⭐ 호스트 단가로 다시 매긴다(BACKLOG C1b) — Pod 엔 레지스트리 스냅숏이 없다.
        const { estimateLlmCost } = await import('../../budget/llm-cost.js');
        // METER-POD-ROLLUP-GAP — 최종 줄 → 마지막 PARTIAL 폴백 → 결손 행(measured:false · 종료 사유): 사용량이 0 처럼 보이는 침묵을 남기지 않는다.
        // METER-POD-ROLLUP-GAP-3 — 판정은 kubectl 없는 순수 함수(podUsageReemitPlan)가 하고 여기선 행을 내보내기만 한다(ux-sim 심이 같은 함수를 부른다).
        const usagePlan = podUsageReemitPlan({ job: name, runId: liveChildRunId, logs, livePartialLine, exit: { state, failedReason, containerReason, containerExitCode } }, (u) => estimateLlmCost(u) as { kind: string; usd?: number });
        for (const row of usagePlan.rows) debug.log(row.category, row.event, row.data);
        const parsed = parseSelfImplementJson(logs);
        const terminal = parseSelfImplementJson(logs.trimEnd().split('\n').at(-1) ?? '');
        const nextAccount = codexAccounts?.find((candidate) => candidate !== account);
        if (state === 'failed' && containerExitCode === 7 && !input.signal?.aborted) {
          debug.log('self-implement.pod', 'gh-login-failed', { job: name, attempt: ghLoginRetried ? 2 : 1, tokenExpiresInSec: ghTokenExpiresAt === null ? null : Math.floor((ghTokenExpiresAt - now()) / 1000) });
          if (!ghLoginRetried) {
            const deleted = kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=true']);
            if (deleted.status !== 0) throw new Error(`pod: GitHub 로그인 실패 Job 삭제 실패: ${deleted.stderr.trim()}`);
            // Bursts came from simultaneous launches (10-05 12:49Z · 5 deaths in 2 s) — wait, spread by job name, then
            // retry once with a newly issued token so the retries do not collide again.
            const backoffMs = podGhLoginRetryBackoffMs(name);
            debug.log('self-implement.pod', 'gh-login-retry-backoff', { job: name, backoffMs });
            await sleep(backoffMs);
            if (input.signal?.aborted) return { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before GitHub login retry' } };
            ghLoginRetried = true;
            continue;
          }
        }
        if (!usageLimitRetried && !input.signal?.aborted && state !== 'aborted' && terminal?.ok === false
          && /\b429\b/.test(terminal.error ?? '') && /\busage_limit_reached\b/.test(terminal.error ?? '') && nextAccount) {
          debug.log('self-implement.pod', 'usage-limit-retry', { job: name, spaceId: input.spaceId, from: account, to: nextAccount });
          const deleted = kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=true']);
          if (deleted.status !== 0) throw new Error(`pod: 사용량 초과 Job 삭제 실패: ${deleted.stderr.trim()}`);
          failedAccount = account;
          retryAccount = nextAccount;
          usageLimitRetried = true;
          continue;
        }
        // Pod 안 경로는 호스트에서 쓸 수 없다.
        let disposition = parsed ? { ...parsed, worktreePath: undefined } : undefined;
        if (options.repairCommitOnly && state === 'complete' && !repairArtifactReady) {
          disposition = { ...disposition, worktreePath: undefined, ok: false, stage: 'repair-artifact-missing', detail: 'Pod repair result or bundle was not collected' };
        }
        if (input.autoMerge && state === 'complete' && disposition?.stage === 'merge-ready') {
          const prNumber = disposition.prNumber;
          const headCommit = disposition.checkedHeadCommit;
          // TA-LIVE-LAND-2 — opt-in per run: the marker hands the merge to the task agent only when propose-land is live.
          let taLandOwner = false;
          if (env[TA_LAND_ENV] === '1') {
            let moves: ReadonlySet<string> = new Set();
            let unreadable: string | null = null;
            try { moves = await (options.taskAgentLiveMoves ?? (async () => (await import('../../task-agent/live-moves.js')).configuredTaskAgentLiveMoves()))(); }
            catch (error) { unreadable = (error instanceof Error ? error.message : String(error)).slice(0, 200); }   // unreadable = not enabled: merge as today
            taLandOwner = unreadable === null && moves.has('propose-land');
            if (!taLandOwner) debug.log('self-implement.pod', 'ta-land-marker-ignored', { job: name, pr: prNumber ?? null,
              reason: unreadable !== null ? 'live-moves-unreadable' : 'propose-land-not-enabled', ...(unreadable !== null ? { error: unreadable } : {}) });
          }
          // REVIEW-ACP-POD — opt-in: 재게이트 «전»에 호스트 Claude ACP(구독) 리뷰. must-fix 면 병합하지 않고 PR 을 연 채 둔다.
          //   ⛔ 못 쓰면(refused) 종전 길 그대로 — Pod 리뷰 결과로 재게이트한다(다른 공급자로 새지 않는다 · 관측 `acp-review-refused`).
          //   ⛔ kubectl 주입(=시험)이면 사용자 설정을 읽지 않는다.
          let hostAcpMustFix: Extract<PodHostAcpReviewOutcome, { status: 'must-fix' }> | undefined;
          // REVIEW-ACP-POD ②-b — Pod 가 리뷰를 «미뤘다»면(mergeReason) 호스트 ACP 리뷰가 «유일한» 리뷰다:
          //   스위치가 그 사이 꺼졌어도 리뷰한다 · 못 하면(refused) 병합하지 않는다(fail-closed — 리뷰 없이 병합 0).
          const podReviewDeferred = disposition.mergeReason === REVIEW_DEFERRED_TO_HOST_MERGE_REASON;
          let hostAcpUnavailable: string | undefined;
          const hostAcpSwitch = resolvePodHostAcpReview(options.hostAcpReview, env, options.kubectl ? () => undefined : getUserConfig);
          if ((hostAcpSwitch.enabled || podReviewDeferred) && Number.isSafeInteger(prNumber) && prNumber && headCommit && /^[0-9a-f]{40}$/i.test(headCommit)) {
            const hostRoot = findGitDir(process.cwd())?.root;
            const outcome: PodHostAcpReviewOutcome = hostRoot
              ? await (options.podHostAcpReview ?? ((i) => runPodHostAcpReview(i, { env })))({ prNumber, headCommit, repoRoot: hostRoot, job: name })
              : { status: 'refused', reason: 'host repository unavailable' };
            if (outcome.status === 'refused' && !hostRoot) debug.log('self-implement.pod', 'acp-review-refused', { job: name, pr: prNumber, reason: outcome.reason }, { level: 'warn' });
            debug.log('self-implement.pod', 'host-acp-review-gate', { job: name, pr: prNumber, source: hostAcpSwitch.enabled ? hostAcpSwitch.source : 'pod-deferred', podReviewDeferred, status: outcome.status, ...(outcome.status === 'refused' ? { reason: outcome.reason, path: podReviewDeferred ? 'hold-pr' : 'pod-review' } : { mustFix: outcome.mustFix }) });
            if (outcome.status === 'must-fix') hostAcpMustFix = outcome;
            if (outcome.status === 'refused' && podReviewDeferred) hostAcpUnavailable = outcome.reason;
          }
          let regate: HostRegateResult;
          if (hostAcpUnavailable !== undefined) {
            // ⛔ Pod 안 리뷰가 없다 — 재게이트·병합으로 가면 «리뷰 없이 병합»이다. PR 을 연 채 둔다.
            debug.log('self-implement.pod', 'host-acp-review-unavailable', { job: name, pr: prNumber ?? null, head: headCommit ?? null, reason: hostAcpUnavailable }, { level: 'warn' });
            try { (options.ghComment ?? defaultGhComment)(prNumber!, `호스트 Claude ACP 리뷰를 못 했다(${hostAcpUnavailable.replace(/\s+/g, ' ').slice(0, 200)}) — Pod 안 리뷰는 호스트로 미뤄져 없으므로 자동 병합하지 않는다(REVIEW-ACP-POD ②-b).`); }
            catch (error) { debug.log('self-implement.pod', 'host-acp-review-comment-failed', { job: name, pr: prNumber ?? null, detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) }); }
            disposition = { ...disposition, stage: 'pr-opened', merged: false, ok: false, mergeReason: 'host-acp-review-unavailable' };
          } else if (hostAcpMustFix) {
            const body = [`호스트 Claude ACP 리뷰: must-fix ${hostAcpMustFix.mustFix}건 — 자동 병합하지 않는다(REVIEW-ACP-POD).`, ...hostAcpMustFix.findings.map((f, i) => `${i + 1}. ${f.replace(/\s+/g, ' ').slice(0, 400)}`)].join('\n');
            try { (options.ghComment ?? defaultGhComment)(prNumber!, body); }
            catch (error) { debug.log('self-implement.pod', 'host-acp-review-comment-failed', { job: name, pr: prNumber ?? null, detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) }); }
            disposition = { ...disposition, stage: 'pr-opened', merged: false, ok: false, mergeReason: 'host-acp-review-must-fix' };
          } else {
          if (!Number.isSafeInteger(prNumber) || !prNumber || !headCommit || !/^[0-9a-f]{40}$/i.test(headCommit)) {
            debug.log('harness.host-regate', 'unmeasured', { pr: prNumber ?? null, files: [], os: process.platform, failedStep: 'pod-result' });
            regate = { passed: false, failures: [{ step: 'pod-result', detail: 'missing PR number or checked head commit' }], os: process.platform };
          } else {
            let hostRoot: string | undefined;
            let hostCwd: string | undefined;
            try {
              hostCwd = process.cwd();
              hostRoot = findGitDir(hostCwd)?.root;
              if (!hostRoot) throw new Error('host repository unavailable');
              regate = await (options.hostRegate ?? runHostRegate)({ prNumber, headCommit, repoRoot: hostRoot, ...(goalFile ? { goalFile } : {}), ...(taLandOwner ? { noMerge: true as const } : {}) });
            } catch (error) {
              debug.log('harness.host-regate', 'unmeasured', { pr: prNumber, files: [], os: process.platform, failedStep: 'host-regate' });
              regate = { passed: false, ...(taLandOwner ? { status: 'unmeasured' as const } : {}), failures: [{ step: 'host-regate', detail: error instanceof Error ? error.message : String(error) }], os: process.platform };
            }
            if (taLandOwner && !hostRoot && hostRepositoryUnavailable(regate)) {
              let recordedRoot: string | undefined;
              try {
                const recorded = loadRunLedger(ledgerRunId, ledgerDir)?.find((entry) => entry.event === 'start')?.data.targetRoot;
                if (typeof recorded === 'string' && isAbsolute(recorded)) {
                  const foundRoot = findGitDir(recorded)?.root;
                  // The recorded path must itself name the repository root, including symlink aliases.
                  if (foundRoot && realpathSync(foundRoot) === realpathSync(recorded)) recordedRoot = foundRoot;
                }
              } catch { /* unreadable ledger or path leaves the original unmeasured result intact */ }
              if (recordedRoot) {
                try {
                  regate = await (options.hostRegate ?? runHostRegate)({ prNumber, headCommit, repoRoot: recordedRoot, ...(goalFile ? { goalFile } : {}), noMerge: true });
                } catch (error) {
                  regate = { passed: false, status: 'unmeasured', failures: [{ step: 'host-regate', detail: error instanceof Error ? error.message : String(error) }], os: process.platform };
                }
                debug.log('harness.host-regate', 'regate-retry', { pr: prNumber, from: hostCwd, to: recordedRoot, result: regate.status ?? (regate.passed ? 'passed' : 'failed') });
              }
            }
          }
          // runHostRegate comments on its own failures; these two paths never reached it.
          const failedStep = regate.failures[0]?.step;
          if (!regate.passed && (failedStep === 'pod-result' || failedStep === 'host-regate') && Number.isSafeInteger(prNumber) && prNumber) {
            const detail = (regate.failures[0]?.detail ?? 'unknown').replace(/\s+/g, ' ').slice(0, 180);
            try { (options.ghComment ?? defaultGhComment)(prNumber, `호스트 재게이트 실패(${process.platform}): ${failedStep} — ${detail}`); }
            catch (error) { debug.log('harness.host-regate', 'unmeasured', { pr: prNumber, files: [], os: process.platform, failedStep: 'comment', detail: error instanceof Error ? error.message : String(error) }); }
          }
          const releaseHold = regate.failures[0]?.step === 'release-path-hold';
          const frozen = regate.status === 'frozen';
          // FREEZE-POD: the host is the only merger of a Pod run, so its freeze check here is the one that holds it.
          if (frozen) debug.log('self-implement.pod', 'merge-blocked-by-freeze', { job: name, runId: liveChildRunId, pr: prNumber ?? null, reason: 'landing-freeze' });
          if (taLandOwner && regate.passed && !frozen) {
            // The host gates passed but did not merge: the PR stays OPEN and ready for the task agent's propose-land.
            debug.log('self-implement.pod', 'ta-land-owner', { job: name, pr: prNumber ?? null, head: headCommit ?? null, regatePassed: true });
            disposition = { ...disposition, stage: 'pr-opened', merged: false, hostRegate: regate, ok: true, mergeReason: 'ta-land-owner' };
          } else {
            if (taLandOwner) debug.log('self-implement.pod', 'ta-land-owner', { job: name, pr: prNumber ?? null, head: headCommit ?? null, regatePassed: false });
            disposition = { ...disposition, stage: frozen || releaseHold ? 'pr-opened' : regate.passed ? 'merged' : 'host-regate-failed', merged: regate.passed && !frozen, hostRegate: regate, ok: regate.passed || releaseHold || frozen };
          }
          }
        }
        const childFailure = state === 'failed' && !oomKilled && failedReason !== 'DeadlineExceeded'
          ? lastPodChildFailure(logs) : null;
        let childPrFailure: ReturnType<typeof podPrOpenFailure> = null;
        if (childFailure) {
          try {
            const entries = loadRunLedger(liveChildRunId, ledgerDir);
            const entry = entries?.slice().reverse().find((row) => row.event === 'pr-open-failed');
            childPrFailure = podPrOpenFailure(entry?.data, childFailure.rawError);
          } catch { /* child ledger is optional; terminal result remains available */ }
          childPrFailure ??= podPrOpenFailure(null, childFailure.rawError);
        }
        if (childPrFailure && disposition) {
          disposition.childEvidence = {
            ...(disposition.childEvidence ?? {}),
            prFailure: {
              stage: childPrFailure.prFailureStage,
              source: childPrFailure.prFailureSource,
              errorTail: childPrFailure.childErrorTail,
              ...(childPrFailure.blockingPrNumber ? { blockingPrNumber: childPrFailure.blockingPrNumber } : {}),
              ...(childPrFailure.candidateCardId ? { candidateCardId: childPrFailure.candidateCardId } : {}),
              ...(childPrFailure.blockingCardId ? { blockingCardId: childPrFailure.blockingCardId } : {}),
            },
          };
        }
        let noResultDiagnostic: string | null = null;
        // POD-NORESULT: a terminal Job without a parsed disposition is incomplete even when the Job condition says Complete.
        const noResultCandidate = !disposition && !oomKilled && failedReason !== 'DeadlineExceeded' &&
          (state === 'complete' || (state === 'failed' && containerExitCode !== 0));
        if (noResultCandidate) {
          try { noResultDiagnostic = podNoResultDiagnostic(readFileSync(runLedgerPath(liveChildRunId, ledgerDir), 'utf8')); }
          catch { /* ledger not returned: do not invent a stage */ }
          noResultDiagnostic ??= 'child terminal result missing; last ledger stage=unknown; round=unknown; mustFix=unknown';
        }
        // POD-NORESULT-LOG-TAIL: the Job runs with backoffLimit 0, so the failed Pod — and its container log —
        //   is collected right after this. When the child ledger cannot even name the stage, read the tail here,
        //   before deletion, so the parent keeps a maskable reason instead of `childEvidence=null`.
        let noResultLogEvidence: Record<string, unknown> | null = null;
        if (noResultDiagnostic?.includes('stage=unknown')) {
          const logRead = readPodNoResultLogTail({ run: kubectl, namespace, job: name, maxLines: POD_NO_RESULT_LOG_TAIL_LINES });
          if ('tail' in logRead) {
            noResultLogEvidence = { stderr: logRead.tail.join('\n'), logTail: logRead.tail, logTailLines: logRead.tail.length };
            debug.log('self-implement.pod', 'no-result-log-tail', { job: name, childRunId: liveChildRunId, diagnostic: noResultDiagnostic, lines: logRead.tail.length, logTail: logRead.tail }, { compact: { stringMax: 500 } });
          } else {
            noResultLogEvidence = { stderr: `log-unavailable: ${logRead.unavailable}` };
            debug.log('self-implement.pod', 'no-result-log-tail', { job: name, childRunId: liveChildRunId, diagnostic: noResultDiagnostic, logUnavailable: logRead.unavailable }, { level: 'warn' });
          }
        }
        if (childFailure) debug.log('self-implement.pod', 'child-error', { job: name, stage: childFailure.stage, error: childFailure.error, ...(childPrFailure ?? {}) }, { compact: { stringMax: 500 } });
        if (noResultDiagnostic && !noResultDiagnostic.includes('stage=unknown')) {
          debug.log('self-implement.pod', 'no-result-ledger-diagnostic', { job: name, childRunId: liveChildRunId, diagnostic: noResultDiagnostic }, { compact: { stringMax: 500 } });
        }
        // POD-LAUNCH-PROVENANCE — append-only «finished» row paired with its started row on job·run.
        // Keyed on launchRunId like the started row; a reattached Job's inherited child run rides along as childRun.
        // exitCode stays null when the container's code was not read (never filled in as 0).
        const finishedRow = { job: name, run: launchRunId, ...(liveChildRunId !== launchRunId ? { childRun: liveChildRunId } : {}),
          attempt: oomRetried ? 2 : 1, phase: state, exitCode: containerExitCode,
          reason: failedReason || containerReason || (state === 'complete' ? 'complete' : 'unknown') };
        try { appendRunLedgerEntry({ runId: ledgerRunId, event: POD_LAUNCH_FINISHED_EVENT, timestamp: new Date((options.now ?? Date.now)()).toISOString(), data: finishedRow }, ledgerDir); }
        catch (error) { debug.log('pod.provenance', 'history-unavailable', { job: name, row: 'finished', reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        debug.log('pod.provenance', 'job-finished', finishedRow);
        debug.log('self-implement.pod', 'job-finished', { job: name, ...(member ? { context: member.context } : {}), state, containerReason, stage: disposition?.stage ?? null, prUrl: disposition?.prUrl ?? null, childRunId: liveChildRunId, ledgerCompleteness,
          ...(podTermination ? { podTermination } : {}),
          ...(state === 'failed' && !oomKilled && failedReason !== 'DeadlineExceeded'
            ? { ...(childFailure ? { childStage: childFailure.stage } : disposition?.stage ? { childStage: disposition.stage } : {}),
              // POD-NORESULT: a parsed result row without error text is not a missing result line (UX 10-07 01:01: 28 of 28 exit-2 Jobs printed one).
              childError: childFailure?.error ?? (disposition?.stage ? 'result-without-error' : 'no-result-line'),
              ...(childPrFailure ?? {}) } : {}) },
          (state === 'failed' && !oomKilled && failedReason !== 'DeadlineExceeded') ? { compact: { stringMax: 500 } } : undefined);
        // POD-LIFECYCLE-STAGES: one `pod.lifecycle stages` line — clone · mirror · run come from the Pod's own
        //   `ELANOUS_POD_STAGE` markers (SI-POD-STAGE-MARKERS), read from that Pod's full named log. ⛔ No `--tail=400` fallback:
        //   a tail can lose the real `run start` and pair a child-printed look-alike with the real `run end` (review mf) —
        //   when the full log cannot be read, every stage stays «missing».
        let k8sTiming: ReturnType<typeof siTaskPodK8sTiming> = {};
        try {
          const childRunLabel = k8sLabelValue(liveChildRunId);
          if (childRunLabel) {
            const pods = kubectl(['-n', namespace, 'get', 'pods', '-l', `elanous.child-run=${childRunLabel}`, '-o', 'json']);
            if (pods.status === 0) k8sTiming = siTaskPodK8sTiming(pods.stdout, childRunLabel, name, lifecycleJobUid);
          }
        } catch { /* observation only: keep each unavailable timestamp missing */ }
        let lifecyclePodStages: Record<string, number> = {};
        let lifecycleDepsSkipped: { at: number; reason: string } | undefined;
        if (k8sTiming.podName && k8sTiming.podUid) {
          try {
            // The stage markers and UID must come from exactly the same Pod. `logs job/<name>`
            // can choose another Pod when a Job has more than one attempt.
            const podLogs = kubectl(['-n', namespace, 'logs', k8sTiming.podName, '-c', 'child']);
            if (podLogs.status === 0) {
              lifecyclePodStages = parseSiTaskPodStages(podLogs.stdout);
              lifecycleDepsSkipped = parseSiTaskDepsSkipped(podLogs.stdout);
            }
          } catch { /* only this Pod's markers may fill lifecycle stages */ }
        }
        emitPodLifecycle(siTaskPodLifecycleEvent({ runId: liveChildRunId, podJob: name, host: member?.context ?? null, watchStart: waitStartedAt, watchEnd: Date.now(),
          createStart: jobApplyStartedAt,
          ...k8sTiming, podStages: lifecyclePodStages, depsSkipped: lifecycleDepsSkipped, outcome: oomKilled ? 'oom' : state }));
        if (oomKilled && reattach && !oomRetried && (!reattachedMemoryLimit || memoryGi(reattachedMemoryLimit) === null)) {
          return { exitCode: 1, output: '', error: { code: 'pod-memory-unavailable', message: `Job ${name} 실제 메모리 한도를 확인할 수 없다` } };
        }
        if (oomKilled && failedReason !== 'DeadlineExceeded' && !input.signal?.aborted && !oomRetried) {
          const actual = memoryGi(reattachedMemoryLimit ?? memoryLimit);
          const standardLimit = podMemoryLimitFor(input.feature, { ...env, ELANOUS_POD_MEMORY_TIER: 'standard' }).limit;
          const nextTier: PodMemoryTier = actual !== null && actual < (memoryGi(standardLimit) ?? 0) ? 'standard' : 'high';
          const nextLimit = podMemoryLimitFor(input.feature, { ...env, ELANOUS_POD_MEMORY_TIER: nextTier }).limit;
          if (actual === null) {
            return { exitCode: 1, output: '', error: { code: 'pod-memory-unavailable', message: `Job ${name} 실제 메모리 한도를 판정할 수 없다: ${memoryLimit}` } };
          }
          if (actual < (memoryGi(nextLimit) ?? actual)) {
            const from = reattachedMemoryLimit ?? memoryLimit;
            appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-oom-retry-intent', data: { attempt: 2, from, to: nextLimit, tier: nextTier, reason: 'OOMKilled', job: name, executionKey, fromChildRunId: liveChildRunId } }, ledgerDir);
            debug.log('self-implement.pod', 'oom-retry', { from, to: nextLimit, tier: nextTier, reason: 'OOMKilled', job: name });
            const deleted = kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=true']);
            if (deleted.status !== 0) throw new Error(`pod: OOM Job 삭제 실패: ${deleted.stderr.trim()}`);
            oomRetried = true;
            retryFromChildRunId = liveChildRunId;
            retryFromMemoryLimit = from;
            retrySamples = samples;
            memoryLimit = nextLimit;
            retryTier = nextTier;
            if (member) { options.pool!.release(member); member = null; }
            releaseAdmission?.();
            releaseAdmission = undefined;
            const unfitRetry = await unfitFailure();
            if (unfitRetry) return unfitRetry;
            if (!await acquireAdmission()) return admissionFailure();
            member = await acquireSlot();
            if (options.pool && !member) return { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before a pool slot opened' } };
            if (member) context = member.context;
            if (input.signal?.aborted) return { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before OOM retry' } };
            continue;
          }
        }
        if (oomRetried && retryFromChildRunId) {
          appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-oom-retry-finished', data: { job: name, executionKey, fromChildRunId: retryFromChildRunId, childRunId: liveChildRunId, state } }, ledgerDir);
        }
        if (goalFile) {
          const noResultOutcome = state === 'failed' && containerExitCode !== null && noResultDiagnostic ? 'abandoned' : 'pod-no-result';
          const record: GoalExecutionRecord = {
            runId: liveChildRunId,
            stage: (state === 'aborted' || !disposition ? 'aborted' : disposition.stage) as GoalExecutionRecord['stage'],
            outcome: (!disposition ? noResultOutcome : state === 'complete' && disposition.merged ? 'merged' : state === 'complete' && disposition.ok ? 'completed' : 'abandoned') as GoalExecutionRecord['outcome'],
            ok: state === 'complete' && (disposition?.ok ?? false),
            ...(disposition?.prNumber !== undefined ? { prNumber: disposition.prNumber } : {}),
            completedAt: new Date().toISOString(),
          };
          try { const { appendGoalExecutionRecord } = await import('../../self-implement/orchestrator.js'); appendGoalExecutionRecord(goalFile, record); }
          catch (error) { debug.log('self-implement.pod', 'goal-record-unavailable', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }); }
        }
        // The host still has the complete Pod log here. The CLI only retains a short stdout tail,
        // so preserve the parsed child facts in the parent ledger before that tail is returned.
        if (state === 'failed' || state === 'aborted' || noResultLogEvidence || (state === 'complete' && noResultDiagnostic !== null)) {
          // Every terminal attempt writes a marker, including one with no parseable child facts.
          // The next attempt must never inherit an earlier Pod's classification.
          const childEvidence = noResultLogEvidence ?? disposition?.childEvidence ?? null;
          try { appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-child-evidence', data: { childEvidence, childRunId: liveChildRunId, job: name, ...(podTermination ? { podTermination } : {}) } }, ledgerDir); }
          catch (error) { debug.log('self-implement.pod', 'child-evidence-write-failed', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        }
        let prLookup: OpenPrByBranch | undefined;
        const terminalBranch = typeof disposition?.branch === 'string' ? disposition.branch.trim() : '';
        if (disposition && (state === 'failed' || state === 'aborted' || disposition.ok === false)
          && (!Number.isSafeInteger(disposition.prNumber) || (disposition.prNumber ?? 0) <= 0) && terminalBranch) {
          try { prLookup = await (options.lookupOpenPrByBranch ?? defaultLookupOpenPrByBranch)(terminalBranch, repoUrl); }
          catch { prLookup = { status: 'failed', reason: 'pr-lookup-threw' }; }
        }
        const terminalDisposition = prLookup?.status === 'found' && disposition
          ? { ...disposition, prNumber: prLookup.prNumber, prUrl: prLookup.prUrl } : disposition;
        if (prLookup?.status === 'found') debug.log('self-implement.pod', 'pr-terminal-bound-by-branch', {
          branch: terminalBranch, prNumber: prLookup.prNumber, prUrl: prLookup.prUrl, status: 'found', job: name });
        else if (prLookup) debug.log('self-implement.pod', 'pr-terminal-branch-lookup', {
          branch: terminalBranch, status: prLookup.status, reason: prLookup.reason, job: name });
        const terminalRecord = { ...classifyPodTerminal({ childRunId: liveChildRunId, state, disposition: terminalDisposition, env,
          prBody: options.draftResidue || prLookup?.status === 'found' ? undefined : podTerminalPrBody(terminalDisposition),
          goalText: parentGoal ?? input.feature, at: new Date().toISOString() }),
          ...(prLookup ? { prLookup: prLookup.status === 'found' ? { status: 'found', source: 'branch-lookup' }
            : { status: prLookup.status, reason: prLookup.reason } } : {}),
          ...(prLookup?.status === 'found' ? { prNumberSource: 'branch-lookup' } : {}) };
        try {
          if (options.draftResidue) await options.draftResidue(terminalRecord, { ledgerRunId, ledgerDir });
          else if (prLookup?.status === 'found') {
            // This lookup only repairs the host ledger's PR identity. The draft sweeper owns PR writes.
            const alreadyRecorded = loadRunLedger(ledgerRunId, ledgerDir)?.some((entry) =>
              entry.event === 'pr-terminal' && entry.data.childRunId === liveChildRunId);
            if (!alreadyRecorded) appendRunLedgerEntry({ runId: ledgerRunId, event: 'pr-terminal', data: terminalRecord }, ledgerDir);
          } else await applyPodTerminal(terminalRecord, { ledgerRunId, ledgerDir });
        }
        catch (error) { debug.log('draft.residue', 'failed', { childRunId: liveChildRunId, prNumber: terminalRecord.prNumber,
          terminalClass: terminalRecord.terminalClass, owner: terminalRecord.owner, ownerSource: terminalRecord.ownerSource,
          step: 'apply', reason: error instanceof Error ? error.message : String(error) }); }
        const tail = podRunResultLine(logs, salvage);
        if (state === 'aborted') return { exitCode: null, output: tail, error: { code: 'aborted', message: 'aborted — Job deleted' }, ...(disposition ? { disposition } : {}) };
        const deadlineExceeded = state === 'failed' && failedReason === 'DeadlineExceeded';
        const deadlineSeconds = jobDeadlineSeconds;
        if (deadlineExceeded) {
          debug.log('self-implement.pod', 'deadline-exceeded', {
            job: name,
            deadlineSeconds,
            childClassification: disposition?.failureClassification ?? null,
            prUrl: disposition?.prUrl ?? null,
            branch: disposition?.branch ?? null,
          });
        }
        const finishedDisposition = deadlineExceeded && disposition
          ? { ...disposition, failureClassification: 'run-deadline-exceeded' as const }
          : disposition;
        // A gate environment deficit can exit the child with 1 while still yielding a
        // verified repair bundle. The host rejudges the new PR head after CAS apply.
        const podExitCode = repairPodExitCode({ state, repairCommitOnly: !!options.repairCommitOnly,
          repairArtifactReady, disposition });
        // SCHED-CONTRACT: a failed child must say why outside the Pod, not «no error diagnostic».
        const rawPodReason = podExitCode === 1 ? extractPodFailureReason({ logs, logTailReason, containerReason, jobReason: failedReason || undefined, deadlineSeconds, result: disposition ? { stage: disposition.stage, prUrl: disposition.prUrl ?? null, prNumber: disposition.prNumber ?? null } : null }) : undefined;
        const podReason = rawPodReason
          ? redactSecretText(noResultLogEvidence ? boundedPodLogText(rawPodReason, POD_NO_RESULT_LOG_REASON_MAX_CHARS) : rawPodReason)
          : undefined;
        if (podReason) debug.log('self-implement.pod', 'failure-reason', { job: name, reason: podReason });
        if (podExitCode === 1) {
          // HARNESS-FULL-GRAPH — 실패 쪽 두 노드: 결과 해석(result-parse) → 수확(salvage, Pod Job 이 push 한 줄로 판정).
          passJourneyNode('result-parse', { provenance: 'self-implement-pod', outcome: podReason ? 'parsed' : 'no-reason', data: { job: name } });
          const salvageOutcome = /^ELANOUS_POD_SALVAGE \S+ \S+$/m.test(logs) ? 'pushed' : logs.includes('ELANOUS_POD_SALVAGE_NONE') ? 'none' : 'unknown';
          passJourneyNode('salvage', { provenance: 'self-implement-pod', outcome: salvageOutcome, data: { job: name } });
        }
        return {
          exitCode: podExitCode,
          output: tail,
          ...(deadlineExceeded
            ? { error: { code: 'pod-deadline-exceeded', message: `Job ${name} 이 수명 상한 ${deadlineSeconds}초에 닿았다` } }
            : state === 'failed'
              ? containerExitCode === 7
                ? { error: { code: 'pod-gh-login-failed', message: `Job ${name} GitHub 앱 로그인 실패 (container=${containerReason ?? 'unknown'}/7, attempt=${ghLoginRetried ? 2 : 1}) — 새 토큰으로 ${ghLoginRetried ? '1회 재시도했으나 다시 실패' : '재시도 불가'}` } }
              : oomKilled
                ? { error: { code: 'pod-oom-killed', message: `Job ${name} failed (OOMKilled/${containerExitCode ?? 'unknown'}, memoryLimit=${memoryLimit})${oomRetried || (memoryGi(reattachedMemoryLimit ?? memoryLimit) ?? 0) >= (memoryGi(podMemoryLimitFor(input.feature, { ...env, ELANOUS_POD_MEMORY_TIER: 'high' }).limit) ?? Infinity) ? ` — OOM · ${oomRetried ? retryTier : 'high'} 에서도` : ''}\n${formatLastMemSample(samples.at(-1))}` } }
              : { error: { code: 'pod-job-failed', message: `Job ${name} failed${failedReason || containerReason ? ` (${[failedReason, containerReason ? `container=${containerReason}/${containerExitCode ?? 'unknown'}` : ''].filter(Boolean).join(', ')})` : ''}${childFailure ? ` — childStage=${childFailure.stage} · childError=${childFailure.error}` : disposition?.stage ? ` — childStage=${disposition.stage} · reason=${podReason}` : ` — childError=no-result-line · reason=${podReason}`}${noResultDiagnostic && containerExitCode !== null ? ` · ${noResultDiagnostic}` : ''}` } }
              : podReason && !childFailure?.error ? { error: { code: 'pod-child-failed', message: podReason } } : {}),
          ...(finishedDisposition ? { disposition: finishedDisposition } : {}),
        };
      } catch (err) {
        zaiPendingApply.delete(name);
        cleanupSecret();
        const message = err instanceof Error ? err.message : String(err);
        debug.log('self-implement.pod', 'job-error', { job: name, message }, { level: 'error' });
        return { exitCode: 1, output: message, error: { code: 'pod-error', message } };
      }
      }
      } finally {
        if (recorded) finishPodFragment(input.spaceId, env);
        if (groundingMinted) { try { (options.revokeGrounding ?? revokeGroundingRun)(groundingMinted); } catch (e) { debug.log('self-implement.pod', 'grounding-revoke-failed', { job: name, reason: e instanceof Error ? e.message : String(e) }, { level: 'warn' }); } }
        if (member) options.pool!.release(member);
      }
      } finally {
        releaseAdmission?.();
      }
    })();
    return { address, done };
  };
}

/** Pod 가 낸 `ELANOUS_USAGE_ROLLUP` 한 줄 → 호스트 logs.db 에 `llm-usage`(site=`pod-rollup:<site>`)로 재방출(RFC F2).
 *  Pod 의 logs.db 는 Pod 와 함께 사라지므로 이것이 그 칸의 토큰·비용이 남는 유일한 자리다. */
/** Pod 롤업 한 행의 비용 칸 (BACKLOG C5 · C1b).
 *  ⛔ «모름»을 0 으로 보이지 않는다 — 전부 모르면 `kind:'unknown', usd:null`.
 *  ⭐ Pod 엔 단가 스냅숏이 없어 «모름»이 나기 쉽다. 호스트는 레지스트리(OpenRouter `/models` 폴드)를 알므로
 *    «토큰 합계»로 다시 매긴다(단가는 선형이라 합계로 매겨도 같다) → `source:'host-reprice'`. */
export type PodRowReprice = (u: { model: string; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) => { kind: string; usd?: number } | null;
export function podRowCost(r: Record<string, unknown>, reprice?: PodRowReprice): Record<string, unknown> {
  const calls = Number(r.calls ?? 0);
  const unknown = Number(r.unknownCostCalls ?? 0);
  const usdKnown = typeof r.usdKnown === 'number' ? r.usdKnown : 0;
  const included = Number(r.includedCalls ?? 0);
  // ⭐ 전부 구독·local(C6) — 청구 0 · API 환산가는 따로.
  if (calls > 0 && included >= calls) return { kind: 'included', usd: 0, includedCalls: included, ...(typeof r.apiEquivalentUsd === 'number' ? { apiEquivalentUsd: r.apiEquivalentUsd } : {}) };
  if (unknown === 0) return { kind: 'known', usd: usdKnown, unknownCostCalls: 0, ...(included ? { includedCalls: included } : {}) };
  // ⛔ 캐시 쓰기량을 «모르는» 행 — 칸이 없거나(옛 Pod rollup) 쓰기 칸 없는 호출이 섞였다 — 은 0 으로 가정해 `known` 으로 매기지 않는다(재매김 생략 → 미상 유지).
  const host = r.cacheCreationInputTokens === undefined || Number(r.cacheCreationUnmeasuredCalls ?? 0) > 0 ? undefined
    : reprice?.({ model: String(r.model ?? ''), inputTokens: Number(r.inputTokens ?? 0), outputTokens: Number(r.outputTokens ?? 0), cacheReadInputTokens: Number(r.cacheReadInputTokens ?? 0), cacheCreationInputTokens: Number(r.cacheCreationInputTokens) });
  if (host && host.kind === 'known' && typeof host.usd === 'number') return { kind: 'known', usd: host.usd, source: 'host-reprice', podUnknownCostCalls: unknown };
  if (calls > 0 && unknown >= calls) return { kind: 'unknown', usd: null, unknownCostCalls: unknown };
  return { kind: 'partial', usd: usdKnown, unknownCostCalls: unknown };
}

const SALVAGE_LINE = /^ELANOUS_POD_SALVAGE (\S+) (\S+)$/;

/** Job 로그의 `ELANOUS_POD_SALVAGE <branch> <commit>` — 호스트가 거둘 브랜치. 접두가 salvage/ 가 아니면 버린다. */
export function parsePodSalvageLines(logs: string): Array<{ branch: string; commit: string }> {
  const out: Array<{ branch: string; commit: string }> = [];
  for (const line of logs.split('\n')) {
    const m = SALVAGE_LINE.exec(line.trim());
    if (!m || !m[1]!.startsWith('salvage/')) continue;
    out.push({ branch: m[1]!, commit: m[2]! });
  }
  return out;
}

/** 기존 Job 로그 소비 경로가 부르는 salvage 기록. 사람용 런 결과 줄에 붙일 브랜치 목록을 돌려준다. */
export function recordPodSalvage(logs: string, job: string, log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d)): string[] {
  const rows = parsePodSalvageLines(logs);
  for (const row of rows) log('self-implement.pod', 'salvage-pushed', { job, branch: row.branch, commit: row.commit });
  return rows.map((row) => row.branch);
}

type PodPrOpenFailure = {
  childErrorTail: string;
  prFailureStage: 'pr-open-failed';
  prFailureSource: 'child-ledger' | 'terminal-result';
  blockingPrNumber?: number;
  candidateCardId?: string;
  blockingCardId?: string;
};

/** Preserve the actionable tail independently of the bounded human error. Never infer a card from a PR number. */
function podPrOpenFailure(ledger: Record<string, unknown> | undefined | null, terminalError: string): PodPrOpenFailure | null {
  const ledgerError = typeof ledger?.error === 'string' ? ledger.error : '';
  // A previous rework round can leave a pr-open-failed row behind. Only a terminal PR failure may consume it.
  if (!/draft PR 생성 실패|PR (?:gh|guard) 실패|same-cell reuse:/u.test(terminalError)) return null;
  // The terminal must contain the complete ledger error. A shared prefix such as "same-cell"
  // cannot distinguish an earlier rework round from the current failed attempt.
  const matchingLedger = ledgerError.length >= 20 && terminalError.includes(ledgerError);
  const source = terminalError || ledgerError;
  const sanitized = redactSecretText(source).replace(/\/home\/[^/\s]+\//gu, '~/');
  const tail = sanitized.split(/\r\n|\n|\r/u).filter(Boolean).at(-1) ?? sanitized;
  const terminalHasIds = /(?:blockers=|blockingPr=|candidateCardId=)/u.test(terminalError);
  const detail = `${terminalError}\n${matchingLedger ? ledgerError : ''}`;
  const blocker = /(?:blockers=|blockingPr=)\s*#?(\d+)(?::([A-Za-z0-9_-]{1,128}))?/u.exec(detail);
  const prNumber = blocker ? Number(blocker[1]) : null;
  const candidate = /candidateCardId=([A-Za-z0-9_-]{1,128})/u.exec(detail)?.[1];
  const card = blocker?.[2];
  return {
    childErrorTail: tail.slice(-240),
    prFailureStage: 'pr-open-failed',
    prFailureSource: terminalHasIds || !matchingLedger ? 'terminal-result' : 'child-ledger',
    ...(prNumber && Number.isSafeInteger(prNumber) ? { blockingPrNumber: prNumber } : {}),
    ...(candidate && candidate !== 'unknown' ? { candidateCardId: candidate } : {}),
    ...(card && card !== 'unknown' ? { blockingCardId: card } : {}),
  };
}

function lastPodChildFailure(logs: string): { stage: string; error: string; rawError: string } | null {
  // Keep canonical duplicate-cap attribution while preserving the raw terminal error
  // used by PR-open failure diagnosis below.
  const attribution = podChildFailureAttribution(logs);
  if (!attribution) return null;
  for (const line of logs.split('\n').reverse()) {
    if (!line.trimStart().startsWith('{')) continue;
    let result: unknown;
    try { result = JSON.parse(line); } catch { continue; }
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    const row = result as Record<string, unknown>;
    const terminal = podTerminalRow(row);
    if (!terminal) continue;
    if (terminal.ok !== false || typeof terminal.error !== 'string') return null;
    if (terminal.stage !== attribution.stage) return null;
    return { ...attribution, error: redactSecretText(attribution.error), rawError: terminal.error };
  }
  return null;
}

/** POD-NORESULT-LOG-TAIL: how many container-log lines a failed Pod leaves behind for the parent. */
export const POD_NO_RESULT_LOG_TAIL_LINES = 80;
const POD_NO_RESULT_LOG_TAIL_LINE_CHARS = 512;
const POD_NO_RESULT_LOG_TAIL_MAX_CHARS = 8_192;
const POD_NO_RESULT_LOG_REASON_MAX_CHARS = 512;

function boundedPodLogText(source: string, maxChars: number): string {
  const redacted = redactSecretText(source).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…[truncated]` : redacted;
}

/** 로그 꼬리 — 마지막 N줄만, 한 줄씩 비밀값 마스킹. */
export function podNoResultLogTailLines(source: string, maxLines: number = POD_NO_RESULT_LOG_TAIL_LINES): string[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const result: string[] = [];
  let chars = 0;
  for (const line of lines.slice(-Math.max(0, maxLines)).reverse()) {
    if (chars >= POD_NO_RESULT_LOG_TAIL_MAX_CHARS) break;
    const bounded = boundedPodLogText(line, Math.min(POD_NO_RESULT_LOG_TAIL_LINE_CHARS, POD_NO_RESULT_LOG_TAIL_MAX_CHARS - chars));
    if (!bounded) continue;
    result.push(bounded);
    chars += bounded.length;
  }
  return result.reverse();
}

export type PodNoResultLogRead = { tail: string[] } | { unavailable: string };

/**
 * POD-NORESULT-LOG-TAIL: the terminal Job (`backoffLimit 0`) is collected right after it fails, so the
 * container log has to be read while the Pod still exists. Never throws — an unreadable log becomes a reason.
 */
export function readPodNoResultLogTail(args: {
  run: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  namespace: string;
  job: string;
  maxLines?: number;
}): PodNoResultLogRead {
  const maxLines = args.maxLines ?? POD_NO_RESULT_LOG_TAIL_LINES;
  try {
    const result = args.run(['-n', args.namespace, 'logs', `job/${args.job}`, `--tail=${maxLines}`]);
    if (result.status !== 0) {
      const reason = boundedPodLogText(result.stderr || result.stdout || '', POD_NO_RESULT_LOG_REASON_MAX_CHARS);
      return { unavailable: reason || `kubectl logs exit ${result.status}` };
    }
    const tail = podNoResultLogTailLines(result.stdout, maxLines);
    return tail.length ? { tail } : { unavailable: 'empty log output' };
  } catch (error) {
    return { unavailable: boundedPodLogText(error instanceof Error ? error.message : String(error), POD_NO_RESULT_LOG_REASON_MAX_CHARS) || 'unknown error' };
  }
}

/** 사람용 런 결과 한 줄 — 수확 브랜치가 있으면 «수확할 브랜치: …» 를 붙인다. */
export function podRunResultLine(logs: string, branches: readonly string[]): string {
  const result = logs.split('\n').filter((line) => !line.startsWith('ELANOUS_MEM ')).join('\n').slice(-4000);
  if (!branches.length) return result;
  const note = branches.map((branch) => `수확할 브랜치: ${branch}`).join('\n');
  return result ? `${result}\n${note}` : note;
}

export function parseMemSamples(logs: string): Array<{ at: number; cgroupBytes: number | null; top: Array<{ rssKb: number; name: string; cmd?: string }> }> {
  const samples: Array<{ at: number; cgroupBytes: number | null; top: Array<{ rssKb: number; name: string; cmd?: string }> }> = [];
  for (const line of logs.split('\n')) {
    const match = /^ELANOUS_MEM (\d+) (\d+|-)(?: (.*))?\r?$/.exec(line);
    if (!match) continue;
    const at = Number(match[1]);
    const cgroupBytes = match[2] === '-' ? null : Number(match[2]);
    if (!Number.isSafeInteger(at) || (cgroupBytes !== null && !Number.isSafeInteger(cgroupBytes))) continue;
    const top: Array<{ rssKb: number; name: string; cmd?: string }> = [];
    let valid = true;
    for (const token of (match[3] ?? '').split(' ').filter(Boolean)) {
      const entry = /^(\d+):([^\s:]+)(?::([^\s:]+))?$/.exec(token);
      if (!entry || !Number.isSafeInteger(Number(entry[1])) || top.length >= 5) { valid = false; break; }
      let name: string;
      let cmd: string | undefined;
      try { name = decodeURIComponent(entry[2]!); if (entry[3] !== undefined) cmd = decodeURIComponent(entry[3]); }
      catch { valid = false; break; }
      top.push({ rssKb: Number(entry[1]), name, ...(cmd !== undefined ? { cmd } : {}) });
    }
    if (valid) samples.push({ at, cgroupBytes, top });
  }
  return samples;
}

function formatLastMemSample(sample: ReturnType<typeof parseMemSamples>[number] | undefined): string {
  if (!sample) return '마지막 샘플: 샘플 없음';
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)}GiB`;
  return `마지막 샘플: cgroup ${sample.cgroupBytes === null ? '-' : gib(sample.cgroupBytes)} · 상위 ${sample.top.length ? sample.top.map((p) => `${p.name} ${gib(p.rssKb * 1024)}`).join(' · ') : '없음'}`;
}

/** METER-POD-ROLLUP-GAP — 결손 칸의 종료 사유 토큰: 최종도 부분도 없는 사용량을 0 이 아니 «측정 불가» 로 남긴다. */
export type PodUsageMissingReason = 'stopped' | 'sigterm-143' | 'backoff-limit' | 'deadline' | 'oom' | 'logs-unavailable';

/** 종료 사유 분류 — 로그를 못 읽으면 그것부터, 그다음 SIGTERM 143 → Backoff → Deadline → OOM, 나머지는 stopped. */
export function podUsageMissingReason(input: { logsAvailable: boolean; exitCode?: number | null; failedReason?: string }): PodUsageMissingReason {
  if (!input.logsAvailable) return 'logs-unavailable';
  if (input.exitCode === 143) return 'sigterm-143';
  if (input.failedReason === 'BackoffLimitExceeded') return 'backoff-limit';
  if (input.failedReason === 'DeadlineExceeded') return 'deadline';
  if (input.failedReason === 'OOMKilled' || input.exitCode === 137) return 'oom';
  return 'stopped';
}

const POD_USAGE_PARTIAL_PREFIX = 'ELANOUS_USAGE_ROLLUP_PARTIAL ';

/** METER-POD-ROLLUP-GAP-3 — 로그 덩어리에서 «마지막» PARTIAL 줄(없으면 null). 런 도중 표본과 종료 로그가 같은 판정을 쓴다. */
export function lastPodUsagePartialLine(logs: string): string | null {
  return logs.split('\n').reverse().find((l) => l.startsWith(POD_USAGE_PARTIAL_PREFIX)) ?? null;
}

/** METER-POD-ROLLUP-GAP-3 — 호스트가 런 «도중» 거두는 PARTIAL 표본 간격(Pod 표본기 기본 5분과 맞춘다) ⊕ 그때 읽는 로그 창(표본 간격 둘 ⊕ 여유). */
export const POD_USAGE_PARTIAL_CAPTURE_MS = 5 * 60_000;
export const POD_USAGE_PARTIAL_CAPTURE_SINCE = '11m';

export function reemitPodUsage(logs: string, job: string, log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d), reprice?: PodRowReprice, missing?: { reason: PodUsageMissingReason; runId?: string | null; podExitClass?: PodExitClass | null; livePartialLine?: string | null }): number {
  const lines = logs.split('\n').reverse();
  const line = lines.find((l) => l.startsWith('ELANOUS_USAGE_ROLLUP '));
  // ⭐ METER-POD-ROLLUP-GAP — 최종 줄이 없으면 마지막 PARTIAL 줄로 폴백한다(부분 롤업 표본기가 남긴 줄).
  // ⭐ METER-POD-ROLLUP-GAP-3 — 종료 로그에도 PARTIAL 이 없으면(Pod 가 지워져 로그가 사라졌다) 런 «도중» 호스트가 거둔 마지막 PARTIAL 로.
  const logPartial = line ? null : lastPodUsagePartialLine(logs);
  const livePartial = line || logPartial || !missing?.livePartialLine?.startsWith(POD_USAGE_PARTIAL_PREFIX) ? null : missing.livePartialLine;
  const partialLine = logPartial ?? livePartial;
  if (!line && !partialLine) {
    // ⭐ METER-POD-ROLLUP-GAP-3 — 결손 이벤트에도 종료 사유를 싣는다(옛 줄은 {job} 뿐이라 «왜 없나» 를 못 물었다).
    const why = missing ? { reason: missing.reason, ...(missing.podExitClass ? { podExitClass: missing.podExitClass } : {}), ...(missing.runId ? { runId: missing.runId } : {}) } : {};
    log('self-implement.pod', 'usage-rollup-missing', { job, ...why });
    // ⭐ 결손 행 — «측정 불가» 를 한 줄로 남긴다: 0 처럼 보이지 않게.
    if (missing) log('llm.usage', 'llm-usage', { site: 'pod-rollup:missing', measured: false, ...why, job, substrate: 'pod', podRollupKey: `${missing.runId ?? job}|missing` });
    return 0;
  }
  const prefix = line ? 'ELANOUS_USAGE_ROLLUP ' : POD_USAGE_PARTIAL_PREFIX;
  let parsed: { measured?: boolean; truncated?: boolean; runId?: string | null; armId?: string | null; podName?: string | null; nodeName?: string | null; hostId?: string | null; seq?: number; at?: string; rows?: Array<Record<string, unknown>> };
  try { parsed = JSON.parse((line ?? partialLine)!.slice(prefix.length)); } catch { log('self-implement.pod', 'usage-rollup-unparsable', { job }); return 0; }
  const rows = parsed.rows ?? [];
  for (const r of rows) {
    const cost = podRowCost(r, reprice);
    const role = typeof r.role === 'string' && r.role.trim() ? r.role : undefined;
    const stage = typeof r.stage === 'string' && r.stage.trim() ? r.stage : undefined;
    const account = typeof r.account === 'string' && r.account.trim() ? r.account : undefined;
    log('llm.usage', 'llm-usage', {
      site: `pod-rollup:${String(r.site)}`, provider: r.provider, model: r.model, calls: r.calls,
      // Preserve only source-observed dimensions. A Pod bucket can contain the
      // same model under several roles, so these also distinguish dedup keys.
      ...(role !== undefined ? { role } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(account !== undefined ? { account } : {}),
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadInputTokens: r.cacheReadInputTokens,
      // ⭐ 캐시 쓰기 — 옛 Pod 이미지 rollup 엔 칸이 없다 ⇒ 없으면 «잰 0» 으로 꾸미지 않고 뺀다.
      ...(r.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: r.cacheCreationInputTokens } : {}),
      ...(Number(r.cacheCreationUnmeasuredCalls ?? 0) > 0 ? { cacheCreationUnmeasuredCalls: r.cacheCreationUnmeasuredCalls } : {}),
      // OR-BYOK-COST — BYOK 출처 칸(비용 자체는 usdKnown/unknownCostCalls 에 이미 있다). 옛 Pod rollup·비-BYOK 행엔 없다 ⇒ 안 싣는다.
      ...(Number(r.byokCalls ?? 0) > 0 ? { byokCalls: r.byokCalls, ...(typeof r.byokUpstreamUsd === 'number' ? { byokUpstreamUsd: r.byokUpstreamUsd } : {}), ...(Number(r.byokUpstreamUnknownCalls ?? 0) > 0 ? { byokUpstreamUnknownCalls: r.byokUpstreamUnknownCalls } : {}) } : {}),
      cost,
      substrate: 'pod', job, ...(parsed.runId ? { podRunId: parsed.runId } : {}), ...(parsed.armId ? { armId: parsed.armId } : {}),
      // ⭐ MF-3c0d253e — 재방출 행의 downstream dedup 키: 같은 Pod(job·runId)의 같은 버킷(site·provider·model)은
      //   부분(seq 달라도)·최종·abort⊕resume 재방출이 몇 번 만나도 집계(rollup)에서 한 번만 센다. 키 없는 기존 행은 종전대로.
      //   ⭐ METER-POD-ROLLUP-GAP-2 — podName 을 키에 넣는다: gh-login·usage-limit 재시도는 «같은 job 이름·runId» 로 새 Pod 를 띄우므로
      //   (podJobName 은 spaceId 결정적) 그것 없이는 서로 다른 시도의 사용량이 한 번으로 접혀 앞 시도분이 사라진다.
      podRollupKey: `${job}|${parsed.podName ?? ''}|${parsed.runId ?? ''}|pod-rollup:${String(r.site)}|${String(r.provider)}|${String(r.model)}${role !== undefined || stage !== undefined || account !== undefined ? `|${JSON.stringify([role ?? null, stage ?? null, account ?? null])}` : ''}`,
      ...(parsed.podName ? { podName: parsed.podName } : {}), ...(parsed.nodeName ? { nodeName: parsed.nodeName } : {}), ...(parsed.hostId ? { podHostId: parsed.hostId } : {}),
      // ⭐ PARTIAL 폴백 재방출 꼬리표 — 최종 줄 행은 그대로(부분이 아님을 꾸미지 않는다).
      ...(partialLine ? { partial: true, ...(parsed.seq !== undefined ? { partialSeq: parsed.seq } : {}), ...(parsed.at !== undefined ? { partialAt: parsed.at } : {}), ...(livePartial ? { partialSource: 'live-capture' } : {}) } : {}),
    });
  }
  log('self-implement.pod', 'usage-rollup', { job, rows: rows.length, measured: parsed.measured ?? null, truncated: parsed.truncated ?? null, ...(partialLine ? { partial: true, ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}), ...(parsed.at !== undefined ? { at: parsed.at } : {}), ...(livePartial ? { partialSource: 'live-capture' } : {}) } : {}) });
  return rows.length;
}

/** METER-POD-ROLLUP-GAP-3 — 호스트 사용량 재방출 판정의 «순수» 입력·출력(kubectl·debug 없음). */
export interface PodUsageReemitInput {
  job: string;
  runId?: string | null;
  /** Job 이 끝난 뒤 거둔 로그(Pod 가 사라졌으면 ''). */
  logs: string;
  /** 런 «도중» 호스트가 본 마지막 `ELANOUS_USAGE_ROLLUP_PARTIAL` 줄(없으면 null). */
  livePartialLine?: string | null;
  /** 종료 정보 — state 가 'failed' 일 때만 classifyPodExit 분류를 싣는다. */
  exit: { state: 'complete' | 'failed' | 'aborted'; failedReason?: string | null; containerReason?: string | null; containerExitCode?: number | null };
}
export interface PodUsageReemitPlan {
  /** 어느 줄로 재방출했나 — final(최종 줄) · partial-log(끝 로그의 PARTIAL) · partial-live(런 도중 본 PARTIAL) · missing(결손 행) · unparsable. */
  source: 'final' | 'partial-log' | 'partial-live' | 'missing' | 'unparsable';
  /** 그대로 debug.log(category, event, data) 로 내보낼 행들(llm-usage 행 ⊕ self-implement.pod 요약/결손 이벤트). */
  rows: Array<{ category: string; event: string; data: Record<string, unknown> }>;
}

/** METER-POD-ROLLUP-GAP-3 — 끝 로그 ⊕ 런 도중 PARTIAL ⊕ 종료 정보 → 재방출할 행/결손 행. 호스트 Job 경로와 ux-sim 심이 «같은» 함수를 부른다. */
export function podUsageReemitPlan(input: PodUsageReemitInput, reprice?: PodRowReprice): PodUsageReemitPlan {
  const { job, logs, exit } = input;
  const reason = podUsageMissingReason({ failedReason: exit.failedReason ?? undefined, exitCode: exit.containerExitCode ?? null, logsAvailable: Boolean(logs) });
  const podExitClass = exit.state === 'failed' ? classifyPodExit({ containerReason: exit.containerReason ?? null, containerExitCode: exit.containerExitCode ?? null, jobReason: exit.failedReason || null, logs }).class : null;
  const rows: PodUsageReemitPlan['rows'] = [];
  reemitPodUsage(logs, job, (category, event, data) => rows.push({ category, event, data }), reprice, { reason, runId: input.runId ?? null, podExitClass, livePartialLine: input.livePartialLine ?? null });
  const usage = rows.find((r) => r.category === 'llm.usage');
  const source: PodUsageReemitPlan['source'] = rows.some((r) => r.event === 'usage-rollup-missing') ? 'missing'
    : rows.some((r) => r.event === 'usage-rollup-unparsable') ? 'unparsable'
      : rows.find((r) => r.event === 'usage-rollup')?.data.partialSource === 'live-capture' ? 'partial-live'
        : rows.find((r) => r.event === 'usage-rollup')?.data.partial === true || usage?.data.partial === true ? 'partial-log' : 'final';
  return { source, rows };
}

/** 이 기계가 Pod 칸을 쓸 수 있나(클러스터 · 이미지) — 발사 전 한 번. */
export function podSubstrateReady(kubectl: Kubectl = defaultKubectl, image = 'elanous-harness:local'): { ok: boolean; reason: string } {
  const ctx = kubectl(['config', 'current-context']);
  if (ctx.status !== 0) return { ok: false, reason: 'kubectl context 없음 — k3d cluster create elanous-h1 --no-lb (이미 있는 k3d 클러스터면 kubectl config use-context k3d-<이름>)' };
  const ns = kubectl(['get', 'ns', 'elanous-test']);
  if (ns.status !== 0) return { ok: false, reason: 'elanous-test 네임스페이스 없음 — kubectl apply -f docker/h1/base.yaml -f docker/h1/policy-internet.yaml' };
  void image;
  return { ok: true, reason: `context ${ctx.stdout.trim()}` };
}


// ── 벤치 팔 (RFC fleet 슈퍼바이저 §A3·F4) ─────────────────────────────────────────────
export interface BenchArm {
  id: string; provider: string; model?: string; passEnv: string[];
  /** 모델을 누가 정했나 — `explicit`(스펙에 적었다) · `ladder`(그 provider 사다리 `better` 칸에서 채웠다). */
  modelSource?: 'explicit' | 'ladder';
}

/** ⛔ 벤치 팔의 모델은 «비워 두지 않는다» — 비우면 provider 마다 옛 상수로 떨어진다.
 *  🩸 09-25 실측: codex 팔이 `gpt-4o-mini`(400 · #20425) · claude 팔이 `claude-haiku-4-5` 로 돌았다.
 *  ⇒ 사다리가 있는 provider 는 `better` 칸으로 채우고 그 사실을 `modelSource` 로 남긴다. */
function ladderModelFor(provider: string): string | undefined {
  if (!(provider in LLM_TIER_MAP_BY_PROVIDER)) return undefined;
  return lookupLlmTierSpec(provider as LlmTierProvider, 'better').model;
}

/** `id=provider[:model][@KEY+KEY]` 를 `;` 로 잇는다 — 예 `codex=openai-codex; or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY`. */
export function parseBenchArms(spec: string): BenchArm[] {
  const arms = spec.split(';').map((x) => x.trim()).filter(Boolean).map((part) => {
    const m = /^([a-z0-9][a-z0-9-]*)=([a-z0-9-]+)(?::([^@]+))?(?:@([A-Z0-9_+]+))?$/i.exec(part);
    if (!m) throw new Error(`--bench-arms: 못 읽는 팔 「${part}」 — 형식 id=provider[:model][@KEY+KEY]`);
    const provider = m[2]!;
    const explicit = m[3]?.trim();
    const model = explicit || ladderModelFor(provider);
    return {
      id: m[1]!.toLowerCase(), provider,
      ...(model ? { model, modelSource: explicit ? 'explicit' as const : 'ladder' as const } : {}),
      passEnv: m[4] ? m[4].split('+') : [],
    };
  });
  const ids = new Set(arms.map((a) => a.id));
  if (ids.size !== arms.length) throw new Error('--bench-arms: 팔 id 가 겹친다');
  if (arms.length < 2) throw new Error('--bench-arms: 팔은 둘 이상');
  return arms;
}

export const BENCH_ARM_LABEL = /\[bench-arm: ([a-z0-9-]+)\]/;

/** 골 하나 → 팔마다 «라벨 한 줄만» 다른 골(A/B 매뉴얼 규칙 ②). */
export function benchGoals(goal: string, arms: readonly BenchArm[]): string[] {
  return arms.map((a) => `${goal.trim()}\n[bench-arm: ${a.id}]`);
}

/** 라벨로 팔을 찾아 그 팔의 provider·model·과금 키로 Pod 를 띄운다. */
export function benchPodSpawn(arms: readonly BenchArm[], base: PodSpawnOptions = {}): SelfImplementJobSpawn {
  const byId = new Map(arms.map((a) => [a.id, a]));
  return (input) => {
    const id = BENCH_ARM_LABEL.exec(input.feature)?.[1];
    const arm = id ? byId.get(id) : undefined;
    if (!arm) return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 1, output: 'no bench arm label', error: { code: 'bench-arm-missing', message: `골에 [bench-arm: <id>] 라벨이 없다(팔: ${[...byId.keys()].join(', ')})` } }) };
    return podSelfImplementSpawn({ ...base, armEnv: benchArmEnv(arm), passEnv: [...(base.passEnv ?? []), ...arm.passEnv] })(input);
  };
}

/** 팔 하나의 Pod env. ⛔⭐ 재작업 «승급»도 팔 안에 가둔다.
 *  🩸 09-25 실측: anthropic 팔의 호출 40건 중 22건(입력 123만 토큰)이 codex `gpt-6-sol` 이었다 —
 *    gate/감독 재작업 라운드가 명시 자식 LLM 이 없으면 `resolveEscalateTarget`(codex sol · anthropic opus)으로
 *    승급하고, 그 env 가 `ELANOUS_LLM_PROVIDER` 를 이긴다(`user-config.ts` escalate → runtime → config).
 *  ⇒ 두 승급 칸(`sol`·`opus`)의 provider·model 을 팔의 값으로 덮는다. 팔 = «한 모델»이 벤치의 불변식이다. */
export function benchArmEnv(arm: BenchArm): Record<string, string> {
  const env: Record<string, string> = { ELANOUS_ARM_ID: `pod/${arm.id}`, ELANOUS_LLM_PROVIDER: arm.provider };
  if (arm.model) env.ELANOUS_LLM_MODEL = arm.model;
  // 🖥️ local 팔 — 호스트의 OpenAI 호환 서버(LM Studio 기본 1234). Pod 에서 호스트는 `host.orb.internal`(OrbStack).
  //   ⛔ 사설망 차단 정책이 기본이라 라벨(`elanous.egress/local-llm`) ⊕ policy-local-llm.yaml 이 그 포트 하나만 연다.
  if (arm.provider === 'local') env.LOCAL_LLM_URL = process.env.ELANOUS_BENCH_LOCAL_LLM_URL?.trim() || 'http://host.orb.internal:1234/v1';
  for (const tier of ['SOL', 'OPUS']) {
    env[`ELANOUS_SELFDEV_${tier}_PROVIDER`] = arm.provider;
    if (arm.model) env[`ELANOUS_SELFDEV_${tier}_MODEL`] = arm.model;
  }
  return env;
}

// ── 이미지 판 (BACKLOG E6) ────────────────────────────────────────────────────────────
/** Pod 안의 `elanous` 는 이미지에 구운 설치본이다 — clone 한 main 이 아니다.
 *  🩸 09-25: 11:08 이미지가 그 뒤 착지한 수리 넷(#20425·#20428·#20429·#20433)을 몰라, anthropic 팔이
 *    main 에서 고쳐진 400 으로 세 판 연속 죽었다. 벤치가 «main» 이 아니라 «이미지 판»을 쟀다.
 *  ⇒ 라벨 `elanous.commit`(docker/harness/build.sh)과 이 트리 HEAD 를 대조한다. */
export interface PodImageFreshness { imageCommit: string | null; headCommit: string | null; fresh: boolean; reason: string }

type LocalImageBuild = { status: number | null; stdout: string; stderr: string; error?: Error };

export async function rebuildLocalPodImageOnce(deps: {
  initialImage?: PodImageFreshness;
  freshness?: () => PodImageFreshness;
  build?: (script: string) => Promise<LocalImageBuild>;
  lockDir?: string;
  onBuild?: (reason: string) => void;
  onWait?: () => void;
} = {}): Promise<{ image: PodImageFreshness; action: 'fresh' | 'built' | 'skipped-after-wait' | 'failed'; error?: string }> {
  const freshness = deps.freshness ?? podImageFreshness;
  let image = deps.initialImage ?? freshness();
  if (image.fresh) return { image, action: 'fresh' };

  const t0 = Date.now();
  const retryMs = 2_000;
  const staleMs = 900_000 + 120_000;
  const lockDir = deps.lockDir ?? join(hostLeaseBaseDir(), 'image-ship');
  let waited = false;
  let waitedMs = 0;
  let action: 'built' | 'skipped-after-wait' | 'failed' = 'failed';
  let release: Awaited<ReturnType<typeof acquireLockAsync>> | undefined;
  try {
    mkdirSync(lockDir, { recursive: true });
    release = await acquireLockAsync(join(lockDir, 'local.build'), {
      staleMs, retryBusyMs: retryMs, maxTries: Math.ceil(staleMs / retryMs) + 10,
      onWait: () => { waited = true; deps.onWait?.(); },
    });
    waitedMs = waited ? Date.now() - t0 : 0;
    // An earlier holder may have finished between our first check and lock acquisition.
    image = freshness();
    if (image.fresh) {
      action = 'skipped-after-wait';
      debug.log('self-implement.pod', 'image-build-skipped-after-wait', { headCommit: image.headCommit, imageCommit: image.imageCommit, waitedMs });
      return { image, action };
    }
    if (!release.stillHeld()) throw new Error('image build lock lost before build');
    deps.onBuild?.(image.reason);
    const build = deps.build ?? (async (script: string) => {
      const top = (await import('../../git-fs/runner.js')).runGitCommand(process.cwd(), ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() || process.cwd();
      return new Promise<LocalImageBuild>((resolveBuild) => {
        execFile('bash', [`${top}/${script}`], { encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolveBuild({ status: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr, ...(error ? { error } : {}) });
        });
      });
    });
    const result = await build('docker/harness/build.sh');
    if (result.status !== 0) {
      return { image, action: 'failed', error: `--substrate pod: 이미지 굽기 실패 rc=${result.status}${result.error ? ` (${(result.error as NodeJS.ErrnoException).code ?? result.error.message})` : ''}: ${(result.stdout + result.stderr).slice(-400)}` };
    }
    if (!release.stillHeld()) throw new Error('image build lock lost after build');
    image = freshness();
    action = 'built';
    return { image, action };
  } catch (error) {
    return { image, action: 'failed', error: `--substrate pod: 이미지 굽기 실패: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    release?.release();
    debug.log('self-implement.pod', 'image-build-local', { action, waitedMs, ms: Date.now() - t0 });
  }
}

export function podImageFreshness(deps: {
  run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string };
  image?: string;
  cwd?: string;
  /** 지금 설정의 Pod 스킬 세트 해시(pod-skills.ts). 생략 시 — run 을 주입한 시험이면 대조하지 않고, 아니면 실제로 잰다. */
  skillsDigest?: () => string;
} = {}): PodImageFreshness {
  const run = deps.run ?? ((cmd, args) => { const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 20_000, ...(deps.cwd ? { cwd: deps.cwd } : {}) }); return { status: r.status, stdout: r.stdout ?? '' }; });
  const image = deps.image ?? 'elanous-harness:local';
  const head = run('git', ['rev-parse', 'HEAD']);
  const headCommit = head.status === 0 ? head.stdout.trim() || null : null;
  const img = run('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "elanous.commit"}}']);
  const label = img.status === 0 ? img.stdout.trim() : '';
  const imageCommit = label && label !== '<no value>' ? label : null;
  if (!headCommit) return { imageCommit, headCommit, fresh: false, reason: 'HEAD 를 못 읽었다 — 판정 불가(낡음으로 본다)' };
  if (img.status !== 0) return { imageCommit, headCommit, fresh: false, reason: `이미지 ${image} 없음` };
  if (!imageCommit) return { imageCommit, headCommit, fresh: false, reason: '이미지에 elanous.commit 라벨이 없다(build.sh 전 판)' };
  // ☸️ 스킬 세트가 바뀌었으면(설정 목록·스킬 내용) 코드가 같아도 낡았다.
  const digestOf = deps.skillsDigest ?? (deps.run ? undefined : () => podSkillsDigest(resolvePodSkills().skills).digest);
  if (digestOf && imageCommit === headCommit) {
    const want = digestOf();
    const lab = run('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "elanous.pod-skills"}}']);
    const have = lab.status === 0 ? lab.stdout.trim() : '';
    if (!want || want === 'none') debug.log('self-implement.pod', 'pod-skills-unread', { have });
    else if (have !== want) return { imageCommit, headCommit, fresh: false, reason: `Pod 스킬 세트가 바뀌었다(이미지 ${have && have !== '<no value>' ? have : '없음'} ≠ 지금 ${want})` };
  }
  return imageCommit === headCommit
    ? { imageCommit, headCommit, fresh: true, reason: 'HEAD 와 같다' }
    : { imageCommit, headCommit, fresh: false, reason: `이미지 ${imageCommit.slice(0, 12)} ≠ HEAD ${headCommit.slice(0, 12)}` };
}

function configHostMirror(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
    return getUserConfig().pod?.hostMirror;
  } catch { return undefined; }
}

function configGroundingUrl(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
    return getUserConfig().pod?.groundingUrl;
  } catch { return undefined; }
}
