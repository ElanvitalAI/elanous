// ☸️ self-implement 자식을 k8s Job(Pod)으로 — 슈퍼바이저(`self orchestrate`)의 세 번째 실행 칸.
//
// 계약은 로컬 spawn(`defaultSelfImplementSpawn`)과 «같다»: 입력 → { address, done }. 그래서 분해·동시 실행 상한·
// 감독 루프·원장이 수정 없이 따라온다(RFC-elanous-on-docker-and-kubernetes-isolation-ladder · ROADMAP C2).
// Pod 안에서는 일반 골은 `self implement`, 전달된 ask 골 문서는 `harness ask` 로 실행하고 마지막 줄 JSON 을 Job 로그로 읽는다.
//
// 📏 2026-09-25 실측 근거(docker/harness · docker/runner):
//   · 자격 = 호스트 계정의 «refresh 없는» 사본(1회용 refresh 보호) — Secret(읽기 전용) → 쓰기 가능한 홈으로 복사.
//   · 격리 관문(initContainer) 필수 — kube-router 는 새 Pod 에 정책을 늦게 건다(첫 ~0.5초 운영 31415 에 닿음 3/3).
//   · 이미지는 `docker/harness/Dockerfile`(elanous 설치 ⊕ 정적 codex·짝·rg·gh) — 이 모듈은 이미지를 «만들지» 않는다.
// ⛔ worktreePath 는 Pod 안 경로라 호스트에서 쓸 수 없다 → disposition 에서 지운다.
// 부작용(kubectl·파일)은 주입받는다 — 시험은 가짜 kubectl 로 누른다.

import { podSkillsDigest, readSkillEnvFiles, resolvePodSkills } from './pod-skills.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';
import { GROUNDING_TOKEN_ENV, GROUNDING_URL_ENV, mintGroundingToken, revokeGroundingRun, type GroundingTokenScope } from '../../grounding/token.js';
import { POD_CREDENTIAL_GROK_PATH, POD_CREDENTIAL_GITHUB_PATH, POD_GITHUB_CREDENTIAL_TOKEN_ENV, POD_GITHUB_CREDENTIAL_URL_ENV, installationRepositories } from '../../nexus/api/pod-credential-api.js';
import { coalescedInstallationCredential } from '../../auth/github-app-token.js';
import { POD_CREDENTIAL_TOKEN_ENV, POD_CREDENTIAL_URL_ENV } from '../../grok/credential.js';
import { collectPodLedgers, createPodLedgerFollower } from './pod-ledger-collect.js';
import { collectPodArtifacts, podNoResultDiagnostic } from './pod-artifact-return.js';
import { isValidAccountName, resolveCodexAccount } from '../../oauth/codex-account.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { controlInboxEnv } from '../../harness/control-inbox.js';
import { finishPodFragment, writePodFragment } from '../../harness/self-send-target.js';
import { mintRunId, normalizeRunId } from '../../harness/harness-space.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import type { GoalExecutionRecord } from '../../self-implement/orchestrator.js';
import { runHostRegate, type HostRegateResult } from '../../self-implement/host-regate.js';

export const POD_CONTROL_INBOX_DIR = '/tmp/elanous-control.inbox';
/** Pod Job 수명 상한(`activeDeadlineSeconds`) — 대표 2026-09-26 90분 → 180분(90분에 `DeadlineExceeded` 로 죽은 런 둘). */
/** Newest pod log bytes returned when the export passes the 5MB artifact limit (headroom under it). */
export const POD_LOGS_KEEP_BYTES = 4_500_000;

/** Re-emit the child's `{kind:"self", ok, result}` line as one flat `{...result, ok}` line at the end of /tmp/si.out.
 *  POD-NORESULT ⓑ (10-07 · 28 failed rc=2 Jobs read back): every child printed its result line, but one
 *  (si-task-71f68d57f6b7, image 0.2.15) had stderr lines (`[graph] collect fail`) after it, so the old
 *  «last line only» check skipped the flatten and the host kept `ok:false` with no stage or PR number.
 *  Scan back to the newest child result line instead; still append exactly one line. */
const POD_RESULT_FLATTEN = `bun -e 'const fs=require("fs");const p="/tmp/si.out";const lines=fs.readFileSync(p,"utf8").trimEnd().split("\\n");for(let i=lines.length-1;i>=0;i--){const l=lines[i].trim();if(!l.startsWith("{"))continue;let o;try{o=JSON.parse(l)}catch{continue}if(!o||o.kind!=="self")continue;if(o.result&&typeof o.result==="object"&&!Array.isArray(o.result))fs.appendFileSync(p,"\\n"+JSON.stringify({...o.result,...(typeof o.ok==="boolean"?{ok:o.ok}:{})})+"\\n");break}'`;

export const POD_JOB_DEADLINE_SECONDS = 10_800;

/** 자식 컨테이너 «요청» — 🩸 2026-09-27: limits 만 두면 k8s 가 requests=limits(cpu 4)로 잡아, 32코어 노드에
 *  «자리 요청»이 88% 차서 잡이 Pending 인데 실사용은 14%였다(풀 25 자리 중 ~8 만 떴다). 상한(limits)은 그대로 두고
 *  예약만 실사용에 맞춘다. */
// POD-DIET (10-06 03:47~05:18 · node-b goal Pods · 89 one-minute samples · 42 Pods): per-Pod observed max median 4.6Gi ·
// p75 6.2Gi · p90 11.7Gi — 23/42 went above the old 4Gi request, so the scheduler over-packed. 6Gi ≈ p75; limits stay.
// Node allocatable ≈ 343Gi ≫ 25 × 6Gi. One-minute samples can miss the true peak (lower bound).
export const POD_CHILD_REQUESTS = { cpu: '1', memory: '6Gi' } as const;
import type { PodPoolMember, PodPoolScheduler } from './pod-pool.js';
import { measurePoolLease, recommendConcurrency, POD_HOST_LEASE_ANNOTATION, LEASE_KUBECTL_MAX_BUFFER, memoryQuantityBytes } from './pod-lease.js';
import { ACTUAL_SUBSTRATE_ENV, RUN_CONTRACT_ENV, carryRunContract, completionFloorFor } from '../../self-implement/graph-run-contract.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { findGitDir } from '../../git-fs/locate.js';
import { debug } from '../../debug/log.js';
import { selectLiveDetail } from '../../live/detail-switch.js';
import { authStorePath } from '../../oauth/store.js';
import { grokAuthFilePath, isGrokSubscriptionExpiring, refreshGrokSubscriptionToken, resolveGrokCredential } from '../../grok/credential.js';
import { defaultGrokModel } from '../../grok/models.js';
import { resolveHostId } from '../../platform/host-id.js';
import { envLiteral } from '../../platform/env-literal.js';
import { LLM_TIER_MAP_BY_PROVIDER, lookupLlmTierSpec, type LlmTierProvider } from '../../model-tier/llm-tier-map.js';
import { parseSelfImplementJson, type SelfImplementJobDone, type SelfImplementJobSpawn } from './self-implement.js';
import { codexQuotaPolicyFromConfig } from '../../oauth/codex-account-store.js';
import { goalTypeOf, type GoalType } from '../../../scripts/measure-pod-memory-by-goal.js';
import { declaredGoalType, type GoalType as DeclaredGoalType } from '../../self-implement/goal-author.js';
import { readPodMemoryAdvice, type PodMemoryAdvice } from '../../cli/pod-memory-advice.js';
import { getUserConfig } from '../../user-config.js';
import { extractPodFailureReason, podTerminalRow } from './pod-failure-reason.js';
import { OLD_DOOR_STAMP_ENV } from '../../self-dev/old-door.js';

export type Kubectl = (args: readonly string[], input?: string) => { status: number | null; stdout: string; stderr: string };

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
  /** 이미지 판(라벨 elanous.commit) — 주입(시험·감독기가 이미 잰 값). 없으면 docker 로 잰다. */
  imageCommit?: string | null;
  /** codex 계정 이름(`~/.elanous/auth.json` 의 `openai-codex:<이름>`). 기본 team. */
  account?: string;
  /** Job 마다 계정을 고른다(pod-account-broker) — 있으면 `account` 보다 먼저. */
  accountBroker?: () => string;
  /** Usable codex accounts from the broker; the allocated account is moved to the front per Job. */
  rotationAccounts?: readonly string[];
  /** 미지정이면 종전 Codex Job. */
  provider?: 'openai-codex' | 'grok';
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
  /** 설정 읽기(시험 주입). kubectl 주입 시험에서는 기본 사용자 설정을 읽지 않는다. */
  configHostMirror?: () => string | undefined;
  /** 원천 — 없으면 종전 `git clone --depth 50`. bundle 이면 apply 뒤 kubectl cp 로 싣는다. */
  source?: PodSource;
  /** 호스트 환경에서 읽어 Pod env 로 넣을 키 이름(예: OPENROUTER_API_KEY · ANTHROPIC_API_KEY) — 벤치마크 과금 경로. */
  passEnv?: readonly string[];
  /** 호스트가 재발사를 소유하면 Pod 자식의 자체 감독을 끈다. 독립 호출 기본 true; 실제 CLI 호스트는 자기 감독 상태를 명시한다. */
  hostSupervised?: boolean;
  /** 자식 `self implement` 에 덧붙일 인자. */
  extraArgs?: readonly string[];
  /** Pod 에 그대로 넣을 «비밀 아닌» env — 벤치 팔의 `ELANOUS_LLM_PROVIDER`·`ELANOUS_LLM_MODEL`·`ELANOUS_ARM_ID`. */
  armEnv?: Readonly<Record<string, string>>;
  /** Job 수명 상한(초). */
  deadlineSeconds?: number;
  pollMs?: number;
  /** LAUNCH-STALL: ms a launch may wait in one stage before `launch-stalled` (test seam; default harness.launchStallMinutes · 15 min). */
  launchStallMs?: number;
  kubectl?: Kubectl;
  /** Host-side regate (injected for Pod tests). */
  hostRegate?: (input: { prNumber: number; headCommit: string; repoRoot: string; goalFile?: string }) => Promise<HostRegateResult>;
  /** PR comment for host-regate failures that never reached runHostRegate (injectable for tests). */
  ghComment?: (prNumber: number, body: string) => void;
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

export function defaultKubectl(args: readonly string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  // 셸 프록시가 kubectl 의 로컬 API 요청을 가로챈다(2026-09-25 실측) — 자식 env 에서 뺀다.
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const r = spawnSync('kubectl', [...args], { encoding: 'utf8', input, env, timeout: 120_000, maxBuffer: LEASE_KUBECTL_MAX_BUFFER });
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
  const { hqFenceDecision } = await import('../../hq/hq.js');
  return hqFenceDecision('ledger-cli').run;
}

/** 호스트 계정 → refresh 없는 사본(elanous 저장소 ⊕ codex auth.json) ⊕ gh 토큰. */
export function hostCredentials(account: string, storePath: string = authStorePath(), ghToken: () => string = defaultGhToken): { elanousAuth: string; codexAuth: string; ghToken: string } {
  // 경로는 해석기로(격리 게이트 · 2026-09-25) — 손으로 `~/.elanous/auth.json` 을 조립하면 test↔prod 격리가 새는 자리가 된다.
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { version?: number; providers: Record<string, Record<string, unknown>> };
  // ⭐ 기본 계정은 정본 키가 `openai-codex`(이름 없음)이고 홈을 안 적는다 — 기본 위치로 푼다(회전 후보와 같은 해석).
  const storeKey = account === 'default' ? 'openai-codex' : `openai-codex:${account}`;
  const entry = store.providers[storeKey] as { tokens: Record<string, unknown>; lastRefresh?: string; authMode?: string; codexHome?: string } | undefined;
  const codexHome = entry?.codexHome ?? (entry && account === 'default' ? resolveCodexAccount(envLiteral({ CODEX_HOME: process.env.CODEX_HOME })).home : undefined);
  if (!entry || !codexHome) throw new Error(`${storeKey} 계정이 없거나 codexHome 을 모른다`);
  const codex = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')) as { tokens: Record<string, unknown> };
  const access = String(codex.tokens.access_token ?? '');
  const exp = Number(JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}').exp ?? 0);
  if (exp * 1000 - Date.now() < 3 * 3600_000) throw new PodCodexExpiringError(account, Math.round(((exp * 1000 - Date.now()) / 3_600_000) * 10) / 10);
  const elanousAuth = JSON.stringify({
    version: store.version ?? 1,
    // ⭐ P4(2026-09-26): elanous 사본도 «방금 검사한» codex 홈의 토큰으로 싣는다 — 두 저장소는 따로 갱신된다.
    //   🩸 실측: third 는 elanous 쪽 토큰이 4시간 전에 만료됐고 codex 홈 쪽은 235시간 남아 있었다 → Pod 가 갱신 400 으로 첫 호출 전에 죽었다(할당량 소진으로 오분류).
    providers: { 'openai-codex': { tokens: { ...entry.tokens, accessToken: access, expiresAt: exp * 1000, refreshToken: '' }, lastRefresh: entry.lastRefresh, authMode: entry.authMode, chatGPT: { accountId: codex.tokens.account_id } } },
  });
  const codexAuth = JSON.stringify({ ...codex, tokens: { ...codex.tokens, refresh_token: '' } });
  return { elanousAuth, codexAuth, ghToken: ghToken() };
}

/** A Pod gets a refresh-less access copy, so the copy must outlive the Job: same rule as the Codex path (3 h). */
export const POD_GROK_MIN_VALIDITY_MS = 3 * 3600_000;
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
} = {}): { grokAuth?: string; grokApiKey?: string; ghToken: string } {
  let credential = resolveGrokCredential({ home: opts.home, env: opts.env });
  if (credential?.kind === 'subscription') {
    const expiring = opts.isExpiring ?? (() => isGrokSubscriptionExpiring({ home: opts.home, bufferMs: POD_GROK_MIN_VALIDITY_MS }));
    if (expiring()) {
      try { (opts.refresh ?? (() => { refreshGrokSubscriptionToken({ home: opts.home }); }))(); } catch { /* judged below */ }
      if (expiring()) throw new Error('grok: 구독 access 토큰이 3시간 안에 만료 — 호스트 갱신(grok models)도 못 늘렸다 · 호스트에서 grok login 후 다시');
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
 *  refresh is «not available» here: the plan drops grok and goes on with codex instead of failing every launch. */
export function podGrokSubscriptionUsable(opts: {
  home?: string; env?: NodeJS.ProcessEnv;
  refresh?: () => void; isExpiring?: () => boolean; expiresAt?: () => string | null;
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
  const skip = (reason: PodGrokSkipReason) => {
    const at = expiresAt();
    try { log('pod.grok-credentials', 'skipped', { reason, expiresAt: at }); } catch { /* observation is fail-soft */ }
    return { usable: false as const, reason, expiresAt: at };
  };
  const credential = resolveGrokCredential({ home: opts.home, env: opts.env });
  if (credential?.kind !== 'subscription') return skip('missing');
  const expiring = opts.isExpiring ?? (() => isGrokSubscriptionExpiring({ home: opts.home, bufferMs: POD_GROK_MIN_VALIDITY_MS }));
  if (!expiring()) return { usable: true };
  let refreshed = true;
  try { (opts.refresh ?? (() => { refreshGrokSubscriptionToken({ home: opts.home }); }))(); } catch { refreshed = false; }
  if (!expiring()) return { usable: true };
  return skip(refreshed ? 'expiring' : 'refresh-failed');
}

/** The one launch line for a skipped grok copy — the reader sees why grok left this run's chain. */
export function podGrokSkippedLine(skip: { reason: PodGrokSkipReason; expiresAt: string | null }): string {
  const why = skip.reason === 'missing' ? '구독 자격 없음' : skip.reason === 'expiring' ? '만료 임박' : '만료 임박 · 호스트 갱신 실패';
  return `⚠️ grok 자격 없음(${why}${skip.expiresAt ? ` · 만료 ${skip.expiresAt}` : ''}) — 이 런의 폴백 체인에서 grok 을 뺐다`;
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
  return { ...(run ? { 'elanous.run': run } : {}), ...(child && child !== run ? { 'elanous.child-run': child } : {}) };
}

/** Pod 메모리 «등급» — 대표 09-27: PWA Pod 골이 16Gi 에서 OOM 으로 죽는다 ⇒ «high» 등급을 옵션으로 고른다.
 *  등급 = `standard`(`ELANOUS_POD_MEMORY` 또는 16Gi) · `high`(`ELANOUS_POD_MEMORY_HIGH` 또는 32Gi · standard 보다 작아지지 않는다).
 *  고르는 순서(앞이 이긴다): ① 발사 옵션 `--pod-memory <등급>`(→ `ELANOUS_POD_MEMORY_TIER`) ② 조각 문면 `Pod 메모리: lite|standard|high` ③ 조각의 `apps/pwa/` ④ 부모의 명시 메모리 줄·PWA 경로 ⑤ 실측 권고 ⑥ 권고 없는 research/document 는 lite ⑦ standard.
 *  node-b 노드 할당 가능 약 251Gi. */
export const POD_MEMORY_DEFAULT = '16Gi';
export const POD_MEMORY_HIGH_DEFAULT = '32Gi';
/** POD7 — `lite`(`ELANOUS_POD_MEMORY_LITE` 또는 2Gi): research/document 기본값; OOM 시 standard 로 한 단계 승급한다. */
export const POD_MEMORY_LITE_DEFAULT = '2Gi';

/** Reserve from measured per-run peaks, never from the advisory limit tier. Sparse or missing measurements keep the old reservation. */
export function podMemoryRequestFor(kind: GoalType | null, advice?: PodMemoryAdvice): string {
  const evidence = advice?.byGoalType.find((entry) => entry.goalType === kind)?.evidence;
  const peak = evidence?.peakMiB.p95;
  const reason = !kind ? 'unknown-kind' : !evidence ? 'no-advice'
    : evidence.measured < 3 || evidence.runs < 3 || evidence.measured * 2 < evidence.runs ? 'insufficient-sample'
      : peak === null || peak === undefined || !Number.isFinite(peak) || peak < 0 ? 'no-peak' : null;
  if (reason) {
    debug.log('pod.memory', 'request-default', { kind, reason });
    return POD_CHILD_REQUESTS.memory;
  }
  return `${Math.max(1, Math.ceil(peak! * 1.25 / 1024))}Gi`;
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

/** A named child provider decides the Pod provider (10-05 PODPROVIDER) — grok needs a usable credential, other names are refused. */
export function podNamedChildProvider(named: string | undefined, credential: { grokSubscription: boolean; grokApiKey: boolean }): { provider?: 'openai-codex' | 'grok'; refuse?: string } {
  if (!named) return {};
  if (named === 'openai-codex' || named === 'codex') return { provider: 'openai-codex' };
  if (named === 'grok') return credential.grokSubscription || credential.grokApiKey ? { provider: 'grok' } : { refuse: 'pod: Pod 에 grok 자격 없음 — 구독 자격이 쓸 수 없거나(만료 임박·갱신 불가) API 키 과금 동의(harness.pod.grokApiKeyOptIn)가 없다 · codex 로 조용히 돌리지 않는다' };
  return { refuse: `pod: Pod 자식 provider 는 openai-codex|grok 만 — 받음 ${named}` };
}

/** Fallback credentials for the codex plan — a launch that named openai-codex never falls back to grok (post-review must-fix). */
export function podFallbackCredentials(named: 'openai-codex' | 'grok' | undefined, fallback: { grokSubscription: boolean; grokApiKey: boolean }): { grokSubscription: boolean; grokApiKey: boolean } {
  return named === 'openai-codex' ? { grokSubscription: false, grokApiKey: false } : fallback;
}

/** Child LLM flags for the Pod child — grok always names its model; codex only when the launch named it (10-05 PODPROVIDER). */
export function podChildLlmArgs(options: Pick<PodSpawnOptions, 'provider' | 'childModel' | 'childEffort' | 'childProviderExplicit'>): string[] {
  const provider = options.provider === 'grok' ? 'grok' : options.childProviderExplicit ? 'openai-codex' : undefined;
  if (!provider) return [];
  const model = options.childModel?.trim() || (provider === 'grok' ? defaultGrokModel().id : undefined);
  // `self implement` registers no --child-llm-effort — passing it kills the Pod at argument parsing, so effort stays host-only.
  return ['--child-llm-provider', provider, ...(model ? ['--child-llm-model', model] : [])];
}

export function podJobManifest(o: { name: string; namespace: string; image: string; /** 레지스트리 이미지면 IfNotPresent(노드가 pull) · 반입 이미지면 Never. */ imagePullPolicy?: 'Never' | 'IfNotPresent'; repoUrl: string; source?: PodSource; hostMirror?: string; args: readonly string[]; passEnv: readonly string[]; deadlineSeconds: number; runId?: string; parentRunId?: string; armEnv?: Readonly<Record<string, string>>; hostId?: string; imageCommit?: string | null; skillEnvs?: readonly string[]; memoryLimit?: string; memoryRequest?: string; goalDoc?: string; /** AUTHOR-POD2 — run `harness say` on /creds/feature inside the Pod (authoring happens off the host). */ authorSentence?: boolean; authorGrade?: 'full' | 'lite'; grokCredential?: 'subscription' | 'api_key'; codexAccounts?: readonly string[]; appCredential?: boolean; /** Test seam — default POD_GH_STALE_SECONDS. */ githubStaleSeconds?: number; /** Which goal execution and attempt this Job is — a resumed host verifies it before following the Job (POD9). */ execution?: { key: string; attempt: number }; hostLeaseAdmitted?: boolean }): Record<string, unknown> {
  const quoted = o.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const goalPath = o.goalDoc ? `'${(o.goalDoc.startsWith('-') ? `./${o.goalDoc}` : o.goalDoc).replace(/'/g, `'\\''`)}'` : undefined;
  const delegated = Boolean(o.goalDoc) || o.authorSentence === true;
  const askBaseIndex = delegated ? o.args.indexOf('--base') : -1;
  const quotedAsk = (askBaseIndex >= 0 && o.args[askBaseIndex + 1]
    ? ` '--base' '${o.args[askBaseIndex + 1]!.replace(/'/g, `'\\''`)}'`
    : '') + (delegated && o.args.includes('--merge-by-host') ? ' --merge-by-host' : delegated && o.args.includes('--open-pr') && !o.args.includes('--auto-merge') ? ' --no-auto-merge' : '')
    + (delegated && o.args.includes('--no-supervise') ? ' --no-supervise' : '');
  const script = [
    'set -u',
    o.grokCredential === 'subscription'
      ? 'mkdir -p ~/.grok && install -m 600 /creds/grok-auth.json ~/.grok/auth.json && export ELANOUS_LLM_PROVIDER=grok'
      : o.grokCredential === 'api_key'
        ? 'mkdir -p ~/.grok && install -m 600 /creds/grok-api-key ~/.grok/api-key && export XAI_API_KEY="$(cat ~/.grok/api-key)" && export ELANOUS_LLM_PROVIDER=grok'
        : o.codexAccounts ? podCodexAccountScript(o.codexAccounts) : `mkdir -p ~/.elanous ~/.codex && cp /creds/elanous-auth.json ~/.elanous/auth.json && cp /creds/codex-auth.json ~/.codex/auth.json && chmod 600 ~/.elanous/auth.json ~/.codex/auth.json\n${podQuotaPolicyExport()}`,
    o.appCredential ? `unset GH_TOKEN GITHUB_TOKEN; export GH_CONFIG_DIR="${APP_GH_CONFIG_PATH}"; mkdir -p "$GH_CONFIG_DIR" && chmod 700 "$GH_CONFIG_DIR" && { (umask 077; gh auth login --with-token < /creds/gh-token >"$HOME/.gh-login.log" 2>&1) || ${APP_GH_AUTH_COMMAND} < /creds/gh-token; } && chmod 600 "$GH_CONFIG_DIR/hosts.yml" && chmod 700 "$GH_CONFIG_DIR" || { echo "[pod] gh-login-failed: $(head -c 300 "$HOME/.gh-login.log" 2>/dev/null | tr '\\n' ' ' | sed -E 's/(gh[a-z]_|github_pat_)[A-Za-z0-9_.-]+/\\1***/g')"; exit 7; }` : 'export GH_TOKEN="$(cat /creds/gh-token)"',
    // 🔑 스킬 키(.env) — 이미지엔 없다. 이 런의 Secret 에서 각 스킬 폴더로 0600 복사(값은 로그에 안 나온다).
    ...(o.skillEnvs?.length ? [`for n in ${o.skillEnvs.join(' ')}; do [ -d ~/.claude/skills/$n ] && install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env; done; echo "[pod] skill env: ${o.skillEnvs.join(',')}"`] : []),
    'git config --global user.name "elanous pod child" && git config --global user.email "noreply@anthropic.com" && gh auth setup-git',
    'curl -s -m 3 -o /dev/null http://host.orb.internal:31415/health && { echo "[pod] ISOLATION FAIL"; exit 3; }',
    podSourceScript(o.source ?? { kind: 'default' }, o.repoUrl),
    ...(goalPath ? [
      `mkdir -p -- "$(dirname -- ${goalPath})" && cp -- /creds/goal-doc ${goalPath} || exit 6`,
    ] : []),
    // Only fixed command shapes leave the Pod; arbitrary argv (including shell -c text) is never emitted.
    `(while :; do { mem=$(if [ -r /sys/fs/cgroup/memory.current ]; then cat /sys/fs/cgroup/memory.current; elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then cat /sys/fs/cgroup/memory/memory.usage_in_bytes; else printf -- -; fi); top=$(ps -eo rss=,comm=,args= --sort=-rss | head -5 | awk 'function encode(s) { gsub(/%/, "%25", s); gsub(/:/, "%3A", s); gsub(/ /, "%20", s); gsub(/\\t/, "%09", s); return s } { rss=$1; name=$2; sub(/^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]*/, ""); n=split($0, a, /[[:space:]]+/); cmd="<redacted>"; if (name=="sleep" && a[2]=="30") cmd="sleep 30" (n>2 ? " <redacted>" : ""); else if (name=="bun") { cmd="bun <redacted>"; if (a[2]=="test") cmd="bun test <redacted>"; else if (a[2]=="run") cmd="bun run <redacted>"; else if ((a[2]=="x" || a[2]=="exec") && a[3]=="tsc") cmd="bun x tsc <redacted>" } else if (name=="tsc") cmd="tsc <redacted>"; else if (name=="elanous") { cmd="elanous <redacted>"; if (a[2]=="self") cmd="elanous self <redacted>"; else if (a[2]=="harness") cmd="elanous harness <redacted>" } else if (name=="node") cmd="node <redacted>"; if (name=="sleep" && cmd=="<redacted>") cmd="sleep <redacted>"; else if (cmd=="<redacted>" && name!="bash" && name!="sh") name="other"; printf " %s:%s:%s", rss, encode(name), encode(substr(cmd,1,120)) }'); printf "ELANOUS_MEM %s %s%s\\n" "$(date +%s)" "$mem" "$top"; } || true; sleep 15 || break; done) & mem_sampler_pid=$!`,
    ...(o.appCredential ? [podGithubWatchdogScript(o.githubStaleSeconds ?? POD_GH_STALE_SECONDS)] : []),
    // 마지막 줄 JSON 이 «맨 끝»이어야 한다(parseSelfImplementJson) — rollup 은 그 앞에.
    // ⛔ `--author-grade` 는 Pod 안 `elanous`(이미지에 깔린 판)가 모를 수 있어 넘기지 않는다 — 10-06 «unknown option» 즉사(#24445 되돌림).
    // AUTHOR-LITE2-POD — 등급은 환경변수 `ELANOUS_AUTHOR_GRADE` 로 싣는다(옛 Pod elanous 는 모르는 환경변수를 무시하고 full 로 돈다).
    o.authorSentence
      ? `echo "ELANOUS_AUTHOR_ON_POD started host=$(hostname) at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; author_t0=$(date +%s); ${o.authorGrade === 'lite' || o.authorGrade === 'full' ? `ELANOUS_AUTHOR_GRADE=${o.authorGrade} ` : ''}elanous harness say --substrate local --json${quotedAsk} -- "$(cat /creds/feature)" > /tmp/si.out 2>&1; rc=$?; echo "ELANOUS_AUTHOR_ON_POD finished host=$(hostname) rc=$rc seconds=$(( $(date +%s) - author_t0 ))"; ${POD_RESULT_FLATTEN}`
      : goalPath
      ? `elanous harness ask ${goalPath} --json${quotedAsk} > /tmp/si.out 2>&1; rc=$?; ${POD_RESULT_FLATTEN}`
      : `export ${OLD_DOOR_STAMP_ENV}=self-implement; elanous self implement "$(cat /creds/feature)" --json ${quoted} > /tmp/si.out 2>&1; rc=$?`,
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
  done < <(find "$HOME/outbox" -type f -print0)
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
    ...(o.appCredential ? ['kill "$gh_watch_pid" 2>/dev/null || true'] : []),
    'wait "$mem_sampler_pid" 2>/dev/null || true',
    'tail -n 1 /tmp/si.out',
    podSalvageScript(),
    'exit $rc',
  ].join('\n');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: o.namespace, labels: { 'elanous.substrate': 'pod', 'elanous.job': o.name, ...podRunLabels(o) },
      ...((o.execution || o.hostLeaseAdmitted) ? { annotations: { ...(o.execution ? { [POD_EXECUTION_KEY_ANNOTATION]: o.execution.key, [POD_ATTEMPT_ANNOTATION]: String(o.execution.attempt) } : {}), ...(o.hostLeaseAdmitted ? { [POD_HOST_LEASE_ANNOTATION]: 'true' } : {}) } } : {}) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 7200,
      activeDeadlineSeconds: o.deadlineSeconds,
      template: {
        // ⭐ Pod 라벨 — local 팔만 `elanous.egress/local-llm` 을 단다. docker/h1/policy-local-llm.yaml 이 그 라벨에만 호스트 LLM 포트 «하나»를 연다.
        metadata: { labels: { 'elanous.job': o.name, ...podRunLabels(o), ...(o.armEnv?.ELANOUS_LLM_PROVIDER === 'local' ? { 'elanous.egress/local-llm': 'true' } : {}) } },
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
              { name: 'ELANOUS_SUBSTRATE', value: 'pod' },
              ...Object.entries(controlInboxEnv(POD_CONTROL_INBOX_DIR)).map(([name, value]) => ({ name, value })),
              // ⭐ 런 출처(🅣 RFC run-origin §A3 · #20457/#20468 칸 이름) — Pod 는 자기 elanous_id 를 쓰지 않고 «띄운 감독기»의 hostId 를 물려받는다.
              { name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
              { name: 'ELANOUS_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              { name: 'ELANOUS_POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
              ...(o.hostId ? [{ name: 'ELANOUS_HOST_ID', value: o.hostId }] : []),
              ...(o.imageCommit ? [{ name: 'ELANOUS_IMAGE_COMMIT', value: o.imageCommit }] : []),
              // ⭐ 런 계약(graph-run-contract.ts) — 이 칸이 «실제로» Pod 이고, 부모가 정한 계약도 Pod 다. 안의 그래프가 노드마다 대조한다.
              { name: ACTUAL_SUBSTRATE_ENV, value: 'pod' }, { name: RUN_CONTRACT_ENV, value: carryRunContract({ substrate: 'pod' }) },
              ...Object.entries(o.armEnv ?? {}).map(([name, value]) => ({ name, value })),
              ...o.passEnv.map((key) => ({ name: key, valueFrom: { secretKeyRef: { name: `${o.name}-creds`, key: `env-${key}` } } })),
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

export function podSelfImplementSpawn(options: PodSpawnOptions = {}): SelfImplementJobSpawn {
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
  return (input) => {
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
      ...(input.openPr || (!input.autoMerge && completionFloorFor({ substrate: 'pod' }) === 'pr') ? ['--open-pr'] : []),
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
      const watchStall = (stage: 'admission' | 'pool-slot'): (() => void) => {
        const started = Date.now();
        const timer = setTimeout(() => {
          if (stalledStages.has(stage)) return;
          stalledStages.add(stage);
          const pool = options.pool as { waitReason?: () => string | null } | undefined;
          debug.log('harness.launch', 'launch-stalled', { spaceId: input.spaceId, runId: childRunId, stage, waitedSec: Math.round((Date.now() - started) / 1000),
            reason: (stage === 'pool-slot' ? stageReason['pool-slot'] : (typeof pool?.waitReason === 'function' ? pool.waitReason() : null)) ?? 'not-measured-yet' }, { level: 'warn' });
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
            const acquired = await options.pool.tryAcquire(unfitContexts, (reason) => { stageReason['pool-slot'] = reason; });
            if (acquired) {
              debug.log('self-implement.pod', 'pool-slot', { spaceId: input.spaceId, context: acquired.context, inflight: options.pool.snapshot() });
              return acquired;
            }
            await sleep(options.pollMs ?? 15_000);
          }
        } finally { stop(); }
      };
      const acquireAdmission = async (): Promise<boolean> => {
        if (!options.pool || typeof options.pool.acquireAdmission !== 'function') return true;
        const stop = watchStall('admission');
        try { releaseAdmission = await options.pool.acquireAdmission(input.signal, after); return true; }
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
      if (!await acquireAdmission()) return admissionFailure();
      let member: PodPoolMember | null = await acquireSlot();
      if (options.pool && !member) return { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before a pool slot opened' } };
      const currentContext = member ? null : baseKubectl(['config', 'current-context']);
      let context = member?.context ?? (currentContext?.status === 0 ? currentContext.stdout.trim() : '');
      const kubectl: Kubectl = (args, stdin) => baseKubectl(['--context', context, ...args], stdin);
      let recorded = false;
      let groundingMinted: string | null = null;
      try {
      if (!context) return { exitCode: 1, output: '', error: { code: 'pod-context', message: 'Pod Job context를 확인할 수 없다' } };
      const cleanupSecret = () => { kubectl(['-n', namespace, 'delete', 'secret', `${name}-creds`, '--ignore-not-found']); };
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
        const via = /^ELANOUS_POD_SOURCE_VIA (mirror|github)\r?$/m.exec(full.stdout)?.[1];
        if (via) debug.log('self-implement.pod', 'source-via', { job: name, via });
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
        return { status: ledgerIncomplete || artifactIncomplete ? 'incomplete' : 'ok', childLedgerIncomplete, samples: parseMemSamples(full.stdout) };
      };
      let retryAccount: string | undefined;
      let retrySamples: ReturnType<typeof parseMemSamples> = [];
      let failedAccount: string | undefined;
      let usageLimitRetried = false;
      let ghLoginRetried = false;
      for (;;) {
      try {
        const grok = options.provider === 'grok';
        const plannedAccount = retryAccount ?? (grok ? 'grok' : options.accountBroker?.() ?? options.account ?? 'team');
        debug.log('self-implement.pod', 'account', { spaceId: input.spaceId, account: plannedAccount, brokered: Boolean(options.accountBroker) });
        const plannedCodexAccounts = grok || !options.accountBroker || !options.rotationAccounts ? undefined : [plannedAccount, ...options.rotationAccounts.filter((candidate) => candidate !== plannedAccount && candidate !== failedAccount)];
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
        const candidates = grok ? [] : plannedCodexAccounts ?? [plannedAccount];
        const usable: Array<{ name: string; credential: ReturnType<typeof accountCredentials> }> = [];
        for (const candidate of candidates) {
          const credential = await podCodexCredentialWithPrerefresh(candidate, prerefreshDeps);
          if (credential) usable.push({ name: candidate, credential });
        }
        if (!grok && usable.length === 0) throw new Error(`openai-codex 후보(${candidates.join(', ')}) access token 이 전부 3시간 안에 만료 — 선갱신도 못 했다(본부 임대 없음 또는 갱신 실패 · pod.credential-prerefresh 를 보라)`);
        const account = grok ? plannedAccount : usable[0]!.name;
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
        const creds = grok
          ? (options.grokCredentials ?? (() => hostGrokCredentials({ env, apiKeyOptIn: options.grokApiKeyOptIn })))()
          : codexCredentials?.[0] ?? usable[0]!.credential;
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
        const passKeys = (options.passEnv ?? []).filter((key) => key !== 'ELANOUS_LIVE_DETAIL_UNTIL'
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
        const secret = {
          apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
          metadata: { name: `${name}-creds`, namespace, labels: { 'elanous.job': name } },
          stringData: {
            ...(grok
              ? ('grokAuth' in creds && creds.grokAuth
                ? { 'grok-auth.json': creds.grokAuth }
                : { 'grok-api-key': (creds as { grokApiKey: string }).grokApiKey })
              : codexCredentials
                ? Object.fromEntries(codexCredentials.map((candidate, i) => [`codex-${i}.json`, JSON.stringify({ elanousAuth: candidate.elanousAuth, codexAuth: candidate.codexAuth })]))
                : { 'elanous-auth.json': (creds as ReturnType<typeof hostCredentials>).elanousAuth, 'codex-auth.json': (creds as ReturnType<typeof hostCredentials>).codexAuth }),
            'gh-token': podGhToken, feature: input.feature,
            ...(goalDocument !== undefined ? { 'goal-doc': goalDocument } : {}),
            ...Object.fromEntries(Object.entries(skillEnvs).map(([n, text]) => [`skillenv-${n}`, text])),
            ...(grounding ? { [`env-${GROUNDING_TOKEN_ENV}`]: grounding.token } : {}),
            ...(credentialRelay ? { [`env-${POD_CREDENTIAL_TOKEN_ENV}`]: credentialRelay.token } : {}),
            ...(githubRelay ? { [`env-${POD_GITHUB_CREDENTIAL_TOKEN_ENV}`]: githubRelay.token } : {}),
            ...Object.fromEntries(githubPassKeys.map((k) => [k, env[k] ?? (options.readKeyCache ?? defaultReadKeyCache)(k)] as const).filter(([, v]) => v).map(([k, v]) => [`env-${k}`, v!])),
          },
        };
        const hostKey = (k: string): string | undefined => env[k] ?? (options.readKeyCache ?? defaultReadKeyCache)(k);
        const passEnv = githubPassKeys.filter((k) => hostKey(k));
        const missing = githubPassKeys.filter((k) => !hostKey(k));
        if (missing.length) debug.log('self-implement.pod', 'pass-env-missing', { job: name, missing }, { level: 'warn' });
        // ☸️ 재개(P3 · 2026-09-26): 같은 이름의 Job 이 이미 있으면 «지우지 않고» 붙는다 — 호스트가 끊긴 동안에도 원격은 계속 돌았다.
        //   🩸 종전엔 여기서 delete 부터 해서, 재개가 원격에서 멀쩡히 돌던 Job 을 죽였다. 실패로 끝난 Job 만 지우고 다시 만든다.
        // ☸️ 노드 레지스트리에 이 판이 있으면 그것을 pull 한다(델타 · 대표 2026-09-26) — 라벨 판정은 로컬 이미지 이름으로 한다.
        const jobImage = member?.imageRef ?? image;
        const launchRunId = retryAccount || oomRetried || ghLoginRetried ? mintRunId() : childRunId;
        let liveChildRunId = launchRunId;
        let reattachedMemoryLimit: string | undefined;
        let existingExecutionKey: string | undefined;
        let existingAttempt = NaN;
        const existing = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.metadata.uid} {.status.conditions[*].type}']);
        const [existingUid = '', ...existingConditions] = existing.status === 0 ? existing.stdout.trim().split(/\s+/u) : [];
        const hasExistingJob = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(existingUid);
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
        const s = kubectl(['apply', '-f', '-'], JSON.stringify(secret));
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
        const armEnv = Object.fromEntries(Object.entries(options.armEnv ?? {}).filter(([key]) => key !== 'ELANOUS_LIVE_DETAIL_UNTIL' && key !== POD_GITHUB_CREDENTIAL_TOKEN_ENV && key !== POD_GITHUB_CREDENTIAL_URL_ENV && (!hostRefresh || !['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR'].includes(key))));
        const seat = env.ELANOUS_HARNESS_SEAT;
        const jobArmEnv = grounding || credentialRelay || githubRelay || env.ELANOUS_DISPATCH_RECORDED === '1' || options.armEnv || detailUntil || seat || env.ELANOUS_POD_AUTHOR_ON_POD === '1'
          ? {
              ...armEnv,
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
        const measuredRequest = podMemoryRequestFor(requestKind, advice);
        const requestGi = memoryGi(measuredRequest);
        const limitGi = memoryGi(memoryLimit);
        const documentDefaultLite = !oomRetried && selectedGoalType === 'document' && memoryTier === 'lite'
          && (memorySource === 'goal-type-auto' || memoryReason === 'goal-type-default');
        const memoryRequest = documentDefaultLite ? memoryLimit
          : requestGi !== null && limitGi !== null && requestGi > limitGi ? memoryLimit : measuredRequest;
        appliedMemoryRequest = memoryRequest;
        debug.log('self-implement.pod', 'memory-request', { spaceId: input.spaceId, job: name,
          tier: oomRetried ? retryTier : memoryTier, reason: oomRetried ? 'OOMKilled' : memoryReason,
          memoryLimit, memoryRequest });
        const job = podJobManifest({ name, namespace, image: jobImage, ...(member?.imageRef ? { imagePullPolicy: 'IfNotPresent' as const } : {}), repoUrl, ...(options.source ? { source: options.source } : {}), ...(hostMirror ? { hostMirror } : {}), args, passEnv: jobPassEnv, deadlineSeconds: options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS, ...(goalDoc ? { goalDoc } : env.ELANOUS_POD_AUTHOR_ON_POD === '1' && !shard ? { authorSentence: true, ...(env.ELANOUS_POD_AUTHOR_GRADE === 'lite' || env.ELANOUS_POD_AUTHOR_GRADE === 'full' ? { authorGrade: env.ELANOUS_POD_AUTHOR_GRADE } : {}) } : {}), runId: launchRunId, ...(parentRunId ? { parentRunId } : {}), ...(jobArmEnv ? { armEnv: jobArmEnv } : {}), hostId: resolveHostId(env), skillEnvs: Object.keys(skillEnvs), memoryLimit, memoryRequest, imageCommit: options.imageCommit !== undefined ? options.imageCommit : options.kubectl ? null : podImageFreshness({ image }).imageCommit, ...(grok ? { grokCredential: 'grokAuth' in creds && creds.grokAuth ? 'subscription' as const : 'api_key' as const } : {}), ...(codexAccounts ? { codexAccounts } : {}), ...(hostRefresh ? { appCredential: true } : {}), execution: { key: executionKey, attempt: oomRetried ? 2 : 1 }, hostLeaseAdmitted: !!releaseAdmission });   // kubectl 주입(=시험)이면 docker 를 부르지 않는다
        const a = kubectl(['apply', '-f', '-'], JSON.stringify(job));
        if (a.status !== 0) { cleanupSecret(); return { exitCode: 1, output: a.stderr, error: { code: 'pod-apply', message: a.stderr.trim() } }; }
        releaseAdmission?.applied?.(name, context, namespace);
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
        if (uid) {
          const owned = kubectl(['-n', namespace, 'patch', 'secret', `${name}-creds`, '--type=merge', '-p', JSON.stringify({ metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name, uid }] } })]);
          if (owned.status !== 0) debug.log('self-implement.pod', 'secret-owner-failed', { job: name, stderr: owned.stderr.trim() }, { level: 'warn' });
        }
        }
        try {
          appendRunLedgerEntry({ runId: ledgerRunId, event: 'pod-child-run', data: { childRunId: liveChildRunId, job: name, attempt: oomRetried ? 2 : 1, ...(goalFile ? { goalFile } : {}) } }, ledgerDir);
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
        debug.log('self-implement.pod', 'job-applied', { job: name, namespace, ...(member ? { context: member.context } : {}), image: jobImage, spaceId: input.spaceId, passEnv, extraArgs: options.extraArgs ?? [], ...(options.armEnv?.ELANOUS_ARM_ID ? { armId: options.armEnv.ELANOUS_ARM_ID } : {}) });
        let state: 'complete' | 'failed' | 'aborted' = 'failed';
        let failedReason = '';
        let containerReason: string | null = null;
        let containerExitCode: number | null = null;
        // ⭐ 런 «도중» 원장 증분 회수 — 호스트 슈퍼바이저가 Pod 걸음을 실시간으로 본다(🅣 요청 · 힐 루프 runtime 성형의 전제).
        const follower = createPodLedgerFollower({ runId: liveChildRunId, dir: ledgerDir, exec: (script) => kubectl(['-n', namespace, 'exec', `job/${name}`, '-c', 'child', '--', 'sh', '-c', script]) });
        for (;;) {
          if (input.signal?.aborted) {
            kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=false']);
            state = 'aborted';
            break;
          }
          const g = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[*].type}']);
          const types = g.stdout;
          if (/Complete|SuccessCriteriaMet/.test(types)) { releaseAdmission?.observed?.(); state = 'complete'; break; }
          if (/Failed|FailureTarget/.test(types)) {
            releaseAdmission?.observed?.();
            state = 'failed';
            const reason = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[?(@.type=="Failed")].reason}']);
            failedReason = reason.status === 0 ? reason.stdout.trim() : '';
            try {
              const pods = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${name}`, '-o', 'jsonpath={range .items[*]}{.metadata.creationTimestamp}{"\\t"}{range .status.containerStatuses[?(@.name=="child")]}{.state.terminated.reason}{"\\t"}{.state.terminated.exitCode}{end}{"\\n"}{end}']);
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
            break;
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
          await sleep(options.pollMs ?? 15_000);
        }
        let logs = '';
        let logTailReason: string | undefined;
        try {
          const fetched = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', '--tail=400']);
          if (fetched.status !== 0) logTailReason = fetched.stderr.trim() || `kubectl logs exited ${fetched.status}`;
          else if (!fetched.stdout) logTailReason = 'empty child logs';
          else logs = fetched.stdout;
        } catch (error) { logTailReason = error instanceof Error ? error.message : String(error); }
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
        reemitPodUsage(logs, name, undefined, (u) => estimateLlmCost(u) as { kind: string; usd?: number });
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
        if (input.autoMerge && state === 'complete' && disposition?.stage === 'merge-ready') {
          const prNumber = disposition.prNumber;
          const headCommit = disposition.checkedHeadCommit;
          let regate: HostRegateResult;
          if (!Number.isSafeInteger(prNumber) || !prNumber || !headCommit || !/^[0-9a-f]{40}$/i.test(headCommit)) {
            debug.log('harness.host-regate', 'unmeasured', { pr: prNumber ?? null, files: [], os: process.platform, failedStep: 'pod-result' });
            regate = { passed: false, failures: [{ step: 'pod-result', detail: 'missing PR number or checked head commit' }], os: process.platform };
          } else {
            try {
              const hostRoot = findGitDir(process.cwd())?.root;
              if (!hostRoot) throw new Error('host repository unavailable');
              regate = await (options.hostRegate ?? runHostRegate)({ prNumber, headCommit, repoRoot: hostRoot, ...(goalFile ? { goalFile } : {}) });
            } catch (error) {
              debug.log('harness.host-regate', 'unmeasured', { pr: prNumber, files: [], os: process.platform, failedStep: 'host-regate' });
              regate = { passed: false, failures: [{ step: 'host-regate', detail: error instanceof Error ? error.message : String(error) }], os: process.platform };
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
          disposition = { ...disposition, stage: frozen || releaseHold ? 'pr-opened' : regate.passed ? 'merged' : 'host-regate-failed', merged: regate.passed && !frozen, hostRegate: regate, ok: regate.passed || releaseHold || frozen };
        }
        const childFailure = state === 'failed' && !oomKilled && failedReason !== 'DeadlineExceeded'
          ? lastPodChildFailure(logs) : null;
        let noResultDiagnostic: string | null = null;
        // POD-NORESULT: the Job runs with backoffLimit 0, so any non-zero child exit is «BackoffLimitExceeded» — not a reason to skip the ledger.
        if (state === 'failed' && containerExitCode !== null && containerExitCode !== 0 && !disposition && !oomKilled && failedReason !== 'DeadlineExceeded') {
          try { noResultDiagnostic = podNoResultDiagnostic(readFileSync(runLedgerPath(liveChildRunId, ledgerDir), 'utf8')); }
          catch { /* ledger not returned: do not invent a stage */ }
          noResultDiagnostic ??= 'child terminal result missing; last ledger stage=unknown; round=unknown; mustFix=unknown';
        }
        if (childFailure) debug.log('self-implement.pod', 'child-error', { job: name, stage: childFailure.stage, error: childFailure.error }, { compact: { stringMax: 500 } });
        if (noResultDiagnostic && !noResultDiagnostic.includes('stage=unknown')) {
          debug.log('self-implement.pod', 'no-result-ledger-diagnostic', { job: name, childRunId: liveChildRunId, diagnostic: noResultDiagnostic }, { compact: { stringMax: 500 } });
        }
        debug.log('self-implement.pod', 'job-finished', { job: name, ...(member ? { context: member.context } : {}), state, containerReason, stage: disposition?.stage ?? null, prUrl: disposition?.prUrl ?? null, childRunId: liveChildRunId, ledgerCompleteness,
          ...(state === 'failed' && !oomKilled && failedReason !== 'DeadlineExceeded'
            ? { ...(childFailure ? { childStage: childFailure.stage } : disposition?.stage ? { childStage: disposition.stage } : {}),
              // POD-NORESULT: a parsed result row without error text is not a missing result line (UX 10-07 01:01: 28 of 28 exit-2 Jobs printed one).
              childError: childFailure?.error ?? (disposition?.stage ? 'result-without-error' : 'no-result-line') } : {}) },
          state === 'failed' && !oomKilled && failedReason !== 'DeadlineExceeded' ? { compact: { stringMax: 500 } } : undefined);
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
          const record: GoalExecutionRecord = {
            runId: liveChildRunId,
            stage: (state === 'aborted' || !disposition ? 'aborted' : disposition.stage) as GoalExecutionRecord['stage'],
            outcome: (!disposition ? noResultDiagnostic ? 'abandoned' : 'pod-no-result' : state === 'complete' && disposition.merged ? 'merged' : state === 'complete' && disposition.ok ? 'completed' : 'abandoned') as GoalExecutionRecord['outcome'],
            ok: state === 'complete' && (disposition?.ok ?? false),
            ...(disposition?.prNumber !== undefined ? { prNumber: disposition.prNumber } : {}),
            completedAt: new Date().toISOString(),
          };
          try { const { appendGoalExecutionRecord } = await import('../../self-implement/orchestrator.js'); appendGoalExecutionRecord(goalFile, record); }
          catch (error) { debug.log('self-implement.pod', 'goal-record-unavailable', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }); }
        }
        const tail = podRunResultLine(logs, salvage);
        if (state === 'aborted') return { exitCode: null, output: tail, error: { code: 'aborted', message: 'aborted — Job deleted' }, ...(disposition ? { disposition } : {}) };
        const deadlineExceeded = state === 'failed' && failedReason === 'DeadlineExceeded';
        const deadlineSeconds = options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS;
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
        const podExitCode = state === 'complete' && disposition?.stage !== 'host-regate-failed' && disposition?.ok !== false ? 0 : 1;
        // SCHED-CONTRACT: a failed child must say why outside the Pod, not «no error diagnostic».
        const podReason = podExitCode === 1 ? extractPodFailureReason({ logs, logTailReason, containerReason, jobReason: failedReason || undefined, deadlineSeconds, result: disposition ? { stage: disposition.stage, prUrl: disposition.prUrl ?? null, prNumber: disposition.prNumber ?? null } : null }) : undefined;
        if (podReason) debug.log('self-implement.pod', 'failure-reason', { job: name, reason: podReason });
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
                : { error: { code: 'pod-job-failed', message: `Job ${name} failed${failedReason || containerReason ? ` (${[failedReason, containerReason ? `container=${containerReason}/${containerExitCode ?? 'unknown'}` : ''].filter(Boolean).join(', ')})` : ''}${childFailure ? ` — childStage=${childFailure.stage} · childError=${childFailure.error}` : disposition?.stage ? ` — childStage=${disposition.stage} · reason=${podReason}` : ` — childError=no-result-line · reason=${podReason}`}${noResultDiagnostic ? ` · ${noResultDiagnostic}` : ''}` } }
              : podReason && !childFailure?.error ? { error: { code: 'pod-child-failed', message: podReason } } : {}),
          ...(finishedDisposition ? { disposition: finishedDisposition } : {}),
        };
      } catch (err) {
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
export type PodRowReprice = (u: { model: string; inputTokens: number; outputTokens: number; cacheReadInputTokens: number }) => { kind: string; usd?: number } | null;
export function podRowCost(r: Record<string, unknown>, reprice?: PodRowReprice): Record<string, unknown> {
  const calls = Number(r.calls ?? 0);
  const unknown = Number(r.unknownCostCalls ?? 0);
  const usdKnown = typeof r.usdKnown === 'number' ? r.usdKnown : 0;
  const included = Number(r.includedCalls ?? 0);
  // ⭐ 전부 구독·local(C6) — 청구 0 · API 환산가는 따로.
  if (calls > 0 && included >= calls) return { kind: 'included', usd: 0, includedCalls: included, ...(typeof r.apiEquivalentUsd === 'number' ? { apiEquivalentUsd: r.apiEquivalentUsd } : {}) };
  if (unknown === 0) return { kind: 'known', usd: usdKnown, unknownCostCalls: 0, ...(included ? { includedCalls: included } : {}) };
  const host = reprice?.({ model: String(r.model ?? ''), inputTokens: Number(r.inputTokens ?? 0), outputTokens: Number(r.outputTokens ?? 0), cacheReadInputTokens: Number(r.cacheReadInputTokens ?? 0) });
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

function lastPodChildFailure(logs: string): { stage: string; error: string } | null {
  for (const line of logs.split('\n').reverse()) {
    if (!line.trimStart().startsWith('{')) continue;
    let result: unknown;
    try { result = JSON.parse(line); } catch { continue; }
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    const row = result as Record<string, unknown>;
    const terminal = podTerminalRow(row);
    if (!terminal) continue;
    if (terminal.ok !== false || typeof terminal.error !== 'string') return null;
    const lines = terminal.error.replace(/\/home\/[^/\s]+\//g, '~/').split(/\r\n|\n|\r/);
    const first = lines[0]!.slice(0, 240);
    const last = lines.at(-1)!.slice(0, 240);
    return { stage: terminal.stage, error: first === last ? first : `${first}\n${last}` };
  }
  return null;
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

export function reemitPodUsage(logs: string, job: string, log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d), reprice?: PodRowReprice): number {
  const line = logs.split('\n').reverse().find((l) => l.startsWith('ELANOUS_USAGE_ROLLUP '));
  if (!line) { log('self-implement.pod', 'usage-rollup-missing', { job }); return 0; }
  let parsed: { measured?: boolean; truncated?: boolean; runId?: string | null; armId?: string | null; podName?: string | null; nodeName?: string | null; hostId?: string | null; rows?: Array<Record<string, unknown>> };
  try { parsed = JSON.parse(line.slice('ELANOUS_USAGE_ROLLUP '.length)); } catch { log('self-implement.pod', 'usage-rollup-unparsable', { job }); return 0; }
  const rows = parsed.rows ?? [];
  for (const r of rows) {
    const cost = podRowCost(r, reprice);
    log('llm.usage', 'llm-usage', {
      site: `pod-rollup:${String(r.site)}`, provider: r.provider, model: r.model, calls: r.calls,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadInputTokens: r.cacheReadInputTokens,
      cost,
      substrate: 'pod', job, ...(parsed.runId ? { podRunId: parsed.runId } : {}), ...(parsed.armId ? { armId: parsed.armId } : {}),
      ...(parsed.podName ? { podName: parsed.podName } : {}), ...(parsed.nodeName ? { nodeName: parsed.nodeName } : {}), ...(parsed.hostId ? { podHostId: parsed.hostId } : {}),
    });
  }
  log('self-implement.pod', 'usage-rollup', { job, rows: rows.length, measured: parsed.measured ?? null, truncated: parsed.truncated ?? null });
  return rows.length;
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
    if (have !== want) return { imageCommit, headCommit, fresh: false, reason: `Pod 스킬 세트가 바뀌었다(이미지 ${have && have !== '<no value>' ? have : '없음'} ≠ 지금 ${want})` };
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
