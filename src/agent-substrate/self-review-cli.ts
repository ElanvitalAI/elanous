// ── `elanous self review` 액션 seam (2026-07-27) ────────────────────────────────
//
// ⚠️ **왜 뽑았나** — 이 트랙이 고친 결함이 payload 가 아니라 **배선**이었다:
// `registerStandaloneLogSink('self-review')` 가 `if (useAcp) { … }` 블록 **안**에 있어
// 기본(API 리뷰어) 경로에서는 sink 조차 등록되지 않았고, 그래서 잘 만든 payload 가
// logs.db 에 닿지 못했다(`--category self-review` 0건).
//
// 그 배선을 처음엔 **소스 문자열 검사**로 잠갔는데, 리뷰가 정확히 지적했듯 그건 행위가
// 아니다 — 구조가 조금만 바뀌어도(변수명·분기 형태) 가드가 무력해지거나 반대로 정상
// 구현을 오탐한다. 액션이 `src/index.ts` 대형 파일의 클로저 안에 있어 in-process 호출이
// 불가능한 것이 원인이었으므로, **원인을 없앤다** — `runSelfImplementCliCommand` 선례대로
// 액션 본문을 주입 가능한 seam 으로 추출한다. 이제 배선은 **런타임으로** 검증된다:
// 테스트가 sink 등록 횟수·발화 3지점·레벨 정책을 실제 호출로 단정한다.
//
// index.ts 의 액션은 옵션 파싱과 실제 의존 배선만 남는다(얇은 껍데기).

import { tierModel } from '../llm/model-defaults.js';
import { buildReviewObservation, safeLogText } from './review-observation.js';
import { DEFAULT_REVIEW_BACKEND } from './acp-reviewer.js';
import { ACP_BACKENDS, canonicalizeBackendId } from '../acp/backend-registry.js';
import { buildManualReviewIntent, intentFromPr, prIntentSectionCoverage, reviewIntentTruncationFromPr, reviewIntentTruncationObservation } from './review-intent.js';
import { budgetReviewerContext, reviewDiffBudgetObservation, splitDiffByFile, type ReviewImage, type ReviewInput, type ReviewerContextItem, type ReviewResult } from './pr-reviewer.js';
import type { ReferencedFileReader } from '../self-implement/goal-file-reader.js';
import type { SubscriptionReviewerSpec } from '../user-config.js';
import { listRunLedgers, lookupPrGoalAcceptance, lookupRunLedger, type PrGoalAcceptanceLookup, type RunLedgerEntry, type RunLedgerLookup } from '../self-implement/run-ledger.js';

export interface SelfReviewCliOpts {
  intent?: string | undefined;
  model?: string | undefined;
  acp?: boolean | undefined;
  acpModel?: string | undefined;
  acpBackend?: string | undefined;
  configuredAcpBackend?: string | undefined;
  /** `roleLlm.reviewer` (same resolution as the harness). Used only when no explicit reviewer flag is given. */
  roleReviewer?: SubscriptionReviewerSpec | undefined;
  acpTimeout?: string | undefined;
  context?: string[] | undefined;
  contextText?: string[] | undefined;
  contextOrder?: Array<{ kind: 'file' | 'text'; value: string }> | undefined;
  json?: boolean | undefined;
}

/** 셸/네트워크/로그 경계 — 테스트는 전부 대역으로 채운다. */
export interface SelfReviewCliDeps {
  /** `gh` 호출. 실패도 예외 없이 `{status, stdout, stderr}` 로 돌려준다(spawnSync 동형). */
  gh(args: string[], timeoutMs: number): { status: number | null; stdout: string; stderr: string };
  /** ⭐ `git` 호출(선택). 주입되면 리뷰 증거를 **이 PR 이 저작한 변경**으로 좁힌다(아래 참조).
   *  미주입이면 종전대로 `gh pr diff`(three-dot) 전체를 쓴다 — 기존 호출부·테스트 무변경. */
  git?(args: string[], timeoutMs: number): { status: number | null; stdout: string; stderr: string };
  /** Repository-bounded file reader used only to complete truncated diff context. */
  readReferencedFile?: ReferencedFileReader;
  /** ⛔⭐ `llm` 은 **이항**이다 — 여기서 단항으로 두면 이미지 계약이 «이 경계에서 소거»된다.
   *  런타임은 JS 라 남는 인자를 그냥 나르지만, 타입이 「없다」고 말하면 다음 변경이 조용히 떨어뜨린다
   *  (`#7486` 리뷰 must-fix · 실제로 `index.ts` 래퍼가 그렇게 한 번 떨어뜨렸다). */
  reviewPullRequest(input: ReviewInput, llm: (prompt: string, images?: readonly ReviewImage[]) => Promise<string>): Promise<ReviewResult>;
  renderReview(review: ReviewResult): string;
  /** 기본 경로 리뷰어 LLM(API). */
  makeApiLlm(model: string): (prompt: string) => Promise<string>;
  /** `--acp` 경로 리뷰어 LLM(독립 프로세스). */
  /**
   * ⭐ `P4b` — 두 번째 인자가 **멀티미디어 통로**다.
   *
   * ⛔ 종전 모양은 `(prompt: string) => Promise<string>` 이었고, ***그것이 멀티미디어 리뷰의
   * 유일한 병목이었다*** — 백엔드도(`claude`·`codex-app-server` 둘 다 `image: true`) 전송층도
   * (`agent.prompt(sid, ContentBlock[])`) 이미 이미지를 나르는데, 이 심이 문자열 하나로 좁혀
   * 그 위로는 이미지가 «올라갈 칸이 없었다**(2026-08-07 실측).
   *
   * ⚠️ API 백엔드(`makeApiLlm`)는 이 인자를 안 받는다 — ACP 경로만 이미지를 나른다.
   */
  makeAcpLlm(o: { backend: string; model?: string; timeoutMs: number }): (prompt: string, images?: readonly ReviewImage[]) => Promise<string>;
  /**
   * Reviewer ACP lane selected by `roleLlm.reviewer` (no explicit flag). Returns the LLM when the
   * subscription is usable, or a reason code when it is not — the caller then reviews on the API
   * exactly as before. Absent seam = the lane is unavailable (`role-reviewer-seam-missing`).
   */
  makeRoleReviewerLlm?(spec: SubscriptionReviewerSpec, o: { timeoutMs: number }):
    | { llm: (prompt: string, images?: readonly ReviewImage[]) => Promise<string>; backend: string }
    | { reason: string };
  /** 관측 sink 등록 — ⭐ 이 호출이 분기 밖에 있는지가 이 트랙의 계약이다. */
  registerSink(surface: string): Promise<void>;
  /** `data` 는 payload 객체 — 순수 헬퍼가 만든 관측 타입도 그대로 받는다(인덱스 시그니처 강요 금지). */
  log(event: string, data: object, opts?: { level?: 'info' | 'warn' | 'error' }): void;
  info(text: string): void;
  error(text: string): void;
  print(text: string): void;
  now(): number;
  envModel(): string | undefined;
  /** Optional fail-soft run-ledger lookup seam for shard decomposition context. */
  lookupRunLedger?: (runId: string) => RunLedgerLookup;
  /** Optional fail-soft run-ledger enumeration seam for sibling shard context. */
  listRunLedgers?: () => RunLedgerLookup;
  /** Optional fail-soft PR-goal 판정 신호 lookup. Default = `lookupPrGoalAcceptance`. */
  lookupPrGoalAcceptance?: (prNumber: number) => PrGoalAcceptanceLookup;
}

export interface SelfReviewCliOutcome {
  results: Array<Record<string, unknown>>;
}

interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type CommitIdentityState = 'known' | 'absent' | 'malformed';

interface CommitIdentity {
  value: string;
  state: CommitIdentityState;
}

/** diff 를 어느 방식으로 얻었나. ⭐ **판정 증거의 결속 강도**이므로 provenance 에 함께 찍는다.
 *  - `sha-pinned`  : `compare/<baseOid>...<headOid>` — **정확한 두 SHA 에 결속**된 diff. ABA 안전.
 *  - `head-sandwich`: `gh pr diff` 를 찍고 전·후로 head 를 읽어 비교하는 종전 방식.
 *    ⛔ **`A→B→A` 를 못 잡는다** — 전·후가 같은 A 라도 그 사이에 B 의 diff 를 받았을 수 있다
 *    (형제 세션 `[S·round6]` 의 `#6046` 리뷰 R3 must-fix 가 자기 병합 경로에서 같은 형태를
 *    지적했고, 그 지적이 이 코드의 미발견 결함까지 가리켰다 · PR #5730 채널). */
type DiffSource = 'sha-pinned' | 'head-sandwich';

interface DiffRead {
  diff: GhResult;
  headCommit: string;
  headCommitState: CommitIdentityState;
  currentHeadCommit: string;
  currentHeadCommitState: CommitIdentityState;
  stale: boolean;
  refetched: boolean;
  source: DiffSource;
  /** `sha-pinned` 를 못 쓴 이유. 폴백했을 때만 채운다. ⛔ 부재와 미지를 같은 값으로 두지 않는다. */
  pinFallbackReason?: 'head-unknown' | 'base-oid-unknown' | 'repo-unknown' | 'compare-failed';
  baseCommit?: string;
}

type LocalHeadComparison =
  | { state: 'match'; localHead: string; prHead: string }
  | { state: 'mismatch'; localHead: string; prHead: string; relation: 'local-ahead' | 'remote-ahead' | 'diverged' }
  | {
    state: 'unavailable';
    reason: 'no-git-seam' | 'pr-branch-unknown' | 'detached-head' | 'different-branch' | 'local-head-unknown' | 'pr-head-unknown' | 'relation-unknown' | 'local-head-moved' | 'foreign-host' | 'foreign-head-repo' | 'head-repo-unverified';
    localHead?: string;
    prHead?: string;
  };

const COMMIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function prHeadCommit(pr: string, deps: SelfReviewCliDeps): CommitIdentity {
  const view = deps.gh(['pr', 'view', pr, '--json', 'headRefOid'], 15_000);
  if (view.status !== 0) return { value: 'unknown', state: 'absent' };
  try {
    const parsed: unknown = JSON.parse(view.stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('headRefOid' in parsed)) {
      return { value: 'unknown', state: 'malformed' };
    }
    const head = (parsed as { headRefOid: unknown }).headRefOid;
    return typeof head === 'string' && COMMIT_OID.test(head)
      ? { value: head, state: 'known' }
      : { value: 'unknown', state: 'malformed' };
  } catch {
    return { value: 'unknown', state: 'malformed' };
  }
}

/** PR head 의 브랜치 ⊕ **소유 저장소**. ⛔ 브랜치명만 보면 **포크·타인 PR 이 같은 이름일 때 오탐**한다
 *  (리뷰 must-fix · 2026-07-30 — `main`·`feature/x` 같은 이름은 흔하다).
 *  ⇒ `headRepositoryOwner` 를 함께 읽고, 그것을 **확인할 수 없으면 대조 자체를 포기**한다(조용). */
function prHeadRef(pr: string, deps: SelfReviewCliDeps): { branch: string; host: RemoteAuthority | null; nameWithOwner: string | null } | null {
  // ⛔⭐ `url` 을 함께 읽어 **PR 이 어느 호스트의 것인지**까지 확인한다(리뷰 6R must-fix · 2026-07-30).
  //    ⚠️ `gh` 는 `GH_HOST`/`GH_REPO` 로 **GitHub Enterprise 등 다른 호스트**를 조회할 수 있다.
  //      호스트를 안 보면 `github.com` 의 `OWNER/NAME` 과 사내 GHE 의 같은 `OWNER/NAME` 이 같아 보인다.
  const view = deps.gh(['pr', 'view', pr, '--json', 'headRefName,headRepositoryOwner,headRepository,url'], 15_000);
  if (view.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(view.stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('headRefName' in parsed)) return null;
    const branch = (parsed as { headRefName: unknown }).headRefName;
    if (typeof branch !== 'string' || branch.length === 0) return null;
    // ⛔⭐ `owner` 만으로는 부족하다(리뷰 must-fix · 2026-07-30) — **같은 소유자의 다른 저장소**
    //    PR 이면 브랜치명이 같을 때 오탐한다. ⇒ **저장소 전체 식별자**(owner/name)로 비교한다.
    const ownerRaw = (parsed as { headRepositoryOwner?: unknown }).headRepositoryOwner;
    const owner = ownerRaw !== null && typeof ownerRaw === 'object' && 'login' in ownerRaw
      && typeof (ownerRaw as { login: unknown }).login === 'string'
      ? (ownerRaw as { login: string }).login
      : null;
    const repoRaw = (parsed as { headRepository?: unknown }).headRepository;
    const repoName = repoRaw !== null && typeof repoRaw === 'object' && 'name' in repoRaw
      && typeof (repoRaw as { name: unknown }).name === 'string'
      ? (repoRaw as { name: string }).name
      : null;
    // ⭐ GitHub 식별자는 대소문자 무구분 ⇒ 양쪽을 같은 규칙으로 정규화한다(리뷰 must-fix).
    const nameWithOwner = owner && repoName ? `${owner}/${repoName}`.toLowerCase() : null;
    const urlRaw = (parsed as { url?: unknown }).url;
    return { branch, host: typeof urlRaw === 'string' ? hostOf(urlRaw) : null, nameWithOwner };
  } catch {
    return null;
  }
}

/** 로컬 `origin` 의 **저장소 전체 식별자**(`{host, OWNER/NAME}`). 못 읽으면 null.
 *  ⛔ owner 만 보면 **같은 소유자의 다른 저장소** PR 을 내 것으로 착각한다(리뷰 must-fix).
 *  ⛔⭐ **호스트도 식별자의 일부다**(리뷰 6R must-fix) — `gh` 가 `GH_HOST` 로 GHE 를 볼 수 있으므로
 *     `github.com` 을 상수로 가정하지 않고 **PR 쪽 호스트와 실제로 비교**한다. */
function localRemoteIdentity(deps: SelfReviewCliDeps): { host: RemoteAuthority; nameWithOwner: string } | null {
  const git = deps.git;
  if (!git) return null;
  const url = git(['remote', 'get-url', 'origin'], 10_000);
  if (url.status !== 0) return null;
  const raw = url.stdout.trim();
  // ⛔⭐ **실제 호스트(authority)를 파싱해서** 검증한다(리뷰 must-fix ×2 · 2026-07-30).
  //    ⚠️ 초판은 전체 문자열 정규식이라 **경로 안의 github.com** 이 통과했다:
  //       https://gitlab.com/github.com/OWNER/REPO.git  ⇒ 비-GitHub 인데 GitHub 로 오인
  const parsedRemote = parseGitRemote(raw);
  if (!parsedRemote) return null;
  // ⭐ GitHub 의 owner/repo 는 **대소문자를 구분하지 않는다** ⇒ 정규화 후 비교한다.
  return { host: parsedRemote.host, nameWithOwner: `${parsedRemote.owner}/${parsedRemote.name}`.toLowerCase() };
}

/** 저장소가 사는 **서버 신원**. `webPort` 는 **웹(http/https) 엔드포인트일 때만** 채운다. */
interface RemoteAuthority { hostname: string; webPort: string | null }

/** URL → `{hostname, webPort}`.
 *  ⛔⭐ 포트를 통째로 버리면 **같은 도메인의 다른 GHE 인스턴스**(`h:8443` ↔ `h:9443`)를 같은 서버로
 *     오인한다(리뷰 8R should-fix). ⚠️ 그렇다고 **스킴을 넘어 포트를 비교하면 안 된다**(리뷰 9R
 *     should-fix) — 같은 GHE 가 웹 `443` · SSH `2222` 를 쓰는 것은 **정상 구성**이고, 그것을
 *     불일치로 읽으면 오탐이다. ⇒ 포트 비교는 **양쪽이 웹일 때만** 성립한다.
 *  ⭐ 웹이면 기본 포트를 **명시적으로 채워** 넣는다(`https://h` == `https://h:443`). */
function authorityOfUrl(u: URL): RemoteAuthority {
  const hostname = u.hostname.toLowerCase();
  if (u.protocol === 'https:') return { hostname, webPort: u.port || '443' };
  if (u.protocol === 'http:') return { hostname, webPort: u.port || '80' };
  return { hostname, webPort: null };   // ssh:·git:· 그 밖 — 웹 포트와 비교 불가
}

/** 두 서버 신원이 같은가. **호스트명은 항상** 비교하고, 포트는 **양쪽이 웹일 때만** 비교한다. */
function sameAuthority(a: RemoteAuthority, b: RemoteAuthority): boolean {
  if (a.hostname !== b.hostname) return false;
  if (a.webPort === null || b.webPort === null) return true;
  return a.webPort === b.webPort;
}

/** URL 문자열 → 서버 신원. 못 읽으면 null. ⛔ 전체 문자열 정규식으로 호스트를 판정하지 않는다. */
function hostOf(raw: string): RemoteAuthority | null {
  try {
    const a = authorityOfUrl(new URL(raw));
    return a.hostname ? a : null;
  } catch {
    return null;
  }
}

/** git remote URL → `{host, owner, name}`. URL 형식과 SCP 형식을 모두 다룬다. 못 읽으면 null.
 *  ⛔ 전체 문자열 정규식으로 호스트를 판정하면 **경로에 섞인 호스트명**에 속는다(리뷰 must-fix). */
function parseGitRemote(raw: string): { host: RemoteAuthority; owner: string; name: string } | null {
  const strip = (n: string) => n.replace(/\.git$/i, '');
  // SCP 형식: [user@]host:owner/repo(.git) — `://` 가 없을 때만.
  if (!raw.includes('://')) {
    const scp = /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)\/*$/.exec(raw);
    if (scp?.[1] && scp[2] && scp[3]) {
      // ⭐ SCP 형식엔 포트가 없다 ⇒ webPort=null(포트 비교 대상 아님).
      return { host: { hostname: scp[1].toLowerCase(), webPort: null }, owner: scp[2], name: strip(scp[3]) };
    }
    return null;
  }
  // URL 형식: scheme://[user@]host[:port]/owner/repo(.git)
  try {
    const u = new URL(raw);
    const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    // ⛔ 경로가 owner/repo **정확히 둘**이 아니면 GitHub 원격 형태가 아니다(경로 우회 차단).
    if (seg.length !== 2 || !seg[0] || !seg[1]) return null;
    // ⭐ 양쪽을 **같은 규칙**(authority = 호스트 ⊕ 비-기본 포트)으로 만든다 — PR 쪽과 비교되므로.
    return { host: authorityOfUrl(u), owner: seg[0], name: strip(seg[1]) };
  } catch {
    return null;
  }
}

function compareLocalHead(pr: string, prHead: CommitIdentity, deps: SelfReviewCliDeps): LocalHeadComparison {
  const git = deps.git;
  const observedPrHead = prHead.state === 'known' ? prHead.value : undefined;
  if (!git) return { state: 'unavailable', reason: 'no-git-seam', prHead: observedPrHead };
  const local = git(['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
  // ⛔⭐ **종료 상태를 먼저 본다**(리뷰 7R should-fix) — 실패한 실행의 stdout 이 커밋처럼 생겼다고
  //    로컬 HEAD 로 인정하면, 못 잰 것을 **쟀다고 착각**한다(판정층이 저지를 수 있는 최악의 형태).
  const localHead = local.status === 0 && COMMIT_OID.test(local.stdout.trim()) ? local.stdout.trim() : undefined;
  const observed = { ...(localHead ? { localHead } : {}), ...(observedPrHead ? { prHead: observedPrHead } : {}) };
  const prRef = prHeadRef(pr, deps);
  if (!prRef) return { state: 'unavailable', reason: 'pr-branch-unknown', ...observed };
  const prBranch = prRef.branch;
  // ⛔⭐ 포크·타인 PR 오탐 차단(리뷰 must-fix) — 브랜치명이 같아도 **다른 저장소**면 남의 PR 이다.
  //    ⚠️ 소유자를 확인할 수 없으면(둘 중 하나라도 null) **대조를 포기**한다 — 오탐보다 침묵이 낫다.
  const localRepo = localRemoteIdentity(deps);
  // ⭐ 세 경우를 **다른 이름으로** 갈라 적는다(이름이 정직해야 다음 사람이 안 헷갈린다):
  //   · 호스트·소유자를 못 읽었다 ⇒ `head-repo-unverified` (확인 불가 — 오탐보다 침묵이 낫다)
  //   · 호스트가 다르다           ⇒ `foreign-host`         (GHE ↔ github.com · 다른 인스턴스)
  //   · 호스트는 같고 저장소가 다르다 ⇒ `foreign-head-repo`  (남의 PR · 포크)
  if (!prRef.nameWithOwner || !prRef.host || !localRepo) {
    return { state: 'unavailable', reason: 'head-repo-unverified', ...observed };
  }
  if (!sameAuthority(prRef.host, localRepo.host)) {
    return { state: 'unavailable', reason: 'foreign-host', ...observed };
  }
  if (prRef.nameWithOwner !== localRepo.nameWithOwner) {
    return { state: 'unavailable', reason: 'foreign-head-repo', ...observed };
  }
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 10_000);
  if (branch.status !== 0 || !branch.stdout.trim()) return { state: 'unavailable', reason: 'detached-head', ...observed };
  // ⛔⭐ **스냅샷이 일관한지 확인한다**(리뷰 10R should-fix) — `rev-parse` 와 `symbolic-ref` 사이에
  //    `gh pr view`(네트워크)가 있어 **수 초가 흐른다**. 그 사이 누가 checkout/rebase 하면
  //    *"옛 브랜치의 SHA"* 와 *"새 브랜치의 이름"* 을 짝지어 **엉뚱한 판정**을 낸다.
  //    ⚠️ 가정이 아니다 — 오늘 이 저장소에서 **작업 중 트리가 리베이스된 사건**이 실제로 있었고
  //      worktree 들이 `.git` 을 공유하므로 남의 명령이 내 HEAD 를 옮길 수 있다.
  //    ⇒ 다시 읽어 **움직였으면 판정하지 않는다**(오탐보다 침묵이 낫다).
  const localHeadAfter = git(['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
  const localHeadNow = localHeadAfter.status === 0 && COMMIT_OID.test(localHeadAfter.stdout.trim())
    ? localHeadAfter.stdout.trim() : undefined;
  if (localHeadNow !== localHead) return { state: 'unavailable', reason: 'local-head-moved', ...observed };
  if (branch.stdout.trim() !== prBranch) return { state: 'unavailable', reason: 'different-branch', ...observed };
  if (!localHead) return { state: 'unavailable', reason: 'local-head-unknown', ...observed };
  if (prHead.state !== 'known') return { state: 'unavailable', reason: 'pr-head-unknown', ...observed };
  if (localHead === prHead.value) return { state: 'match', localHead, prHead: prHead.value };
  const localContainsRemote = git(['merge-base', '--is-ancestor', prHead.value, localHead], 10_000).status;
  const remoteContainsLocal = git(['merge-base', '--is-ancestor', localHead, prHead.value], 10_000).status;
  if (localContainsRemote === 0) return { state: 'mismatch', localHead, prHead: prHead.value, relation: 'local-ahead' };
  if (remoteContainsLocal === 0) return { state: 'mismatch', localHead, prHead: prHead.value, relation: 'remote-ahead' };
  if (localContainsRemote === 1 && remoteContainsLocal === 1) {
    return { state: 'mismatch', localHead, prHead: prHead.value, relation: 'diverged' };
  }
  return { state: 'unavailable', reason: 'relation-unknown', localHead, prHead: prHead.value };
}

// ⭐ 원인을 단정하지 않는 정직한 행동 문구 — 커밋 부재가 가장 흔한 원인이지만 유일하지 않다.
const UNRELATED_ACTION = 'Could not relate the two commits (git merge-base failed). Try `git fetch origin`, then review again.';

// ⛔⭐ `relation-unknown` 도 경고 대상이다(인수 판단 · 2026-07-30).
//    골이 *"판정 못 하는 경우는 조용히 넘기되 관측에 남긴다"* 라 적었고 자식은 그것을 따랐다.
//    ⇒ 그런데 리뷰가 두 라운드 반복해 지적한 대로 **그 침묵이 위험하다**: `relation-unknown` 은
//      `merge-base --is-ancestor` 가 0/1 이 아닌 값(예: **128** — PR head 커밋이 로컬에 없다)이고,
//      그때 사용자는 **`git fetch` 로 행동할 수 있다**. 정보 부족을 아는 것이 정보다.
//    ⚠️ 다른 `unavailable` 은 여전히 조용하다 — `different-branch`·`detached-head`·`no-git-seam` 은
//      **정상 사용**이고(사후 리뷰·타인 PR), 경고하면 오탐이 된다.
//    ⛔⭐ 인자는 **판정 전체**를 받고 경고 여부를 **여기서** 정한다(리뷰 6R must-fix 수반 · tsc).
//      ⚠️ 종전 시그니처는 `Extract<…, { state:'unavailable'; reason:'relation-unknown' }>` 였는데
//        그 멤버의 `reason` 은 **더 넓은 유니온**이라 Extract 가 `never` 로 접혔다 ⇒ 호출부 tsc 에러
//        (⭐ **런타임은 멀쩡해 테스트는 통과했다** — 테스트 초록 · tsc 빨강의 전형).
function localHeadWarningDetails(comparison: LocalHeadComparison): { warning: string; action: string } | undefined {
  if (comparison.state === 'match') return undefined;
  if (comparison.state === 'unavailable') {
    if (comparison.reason !== 'relation-unknown') return undefined;
    const short = (sha?: string) => (sha ? sha.slice(0, 12) : 'unknown');
    return {
      // ⚠️ `warning` 에 action 을 **포함**한다 — legacy 경고와 같은 형상이어야 출력부가 하나로 산다
      //    (리뷰 must-fix: 출력부에서 action 을 또 붙여 문구가 중복됐다).
      // ⭐ 두 SHA 가 **다르다는 것은 확실**하고 **관계만 unknown** 이다(리뷰 must-fix) —
      //    `merge-base` 실행 실패의 원인은 커밋 부재일 수도, 다른 실행 오류일 수도 있다.
      //    ⛔ 원인을 단정하지 말고 **불일치는 경고 · 관계는 unknown** 으로 적는다.
      warning: `⚠️ LOCAL/PR HEAD DIFFER (relation unknown): local=${short(comparison.localHead)}; PR=${short(comparison.prHead)}. ${UNRELATED_ACTION}`,
      action: UNRELATED_ACTION,
    };
  }
  return legacyLocalHeadWarningDetails(comparison);
}

function legacyLocalHeadWarningDetails(comparison: Extract<LocalHeadComparison, { state: 'mismatch' }>): { warning: string; action: string } {
  const short = (sha: string) => sha.slice(0, 12);
  const action = comparison.relation === 'local-ahead'
    ? 'Push your local commits, then run this review again.'
    : comparison.relation === 'remote-ahead'
      ? 'Update your local branch, then run this review again.'
      : 'Reconcile the local and remote branch heads, then run this review again.';
  return {
    warning: `⚠️ LOCAL/PR HEAD MISMATCH: local=${short(comparison.localHead)}; PR=${short(comparison.prHead)}; ${comparison.relation}. ${action}`,
    action,
  };
}

function comparisonObservation(comparison: LocalHeadComparison): Record<string, unknown> {
  return {
    localHeadComparison: comparison.state,
    ...(comparison.localHead ? { localHead: comparison.localHead } : {}),
    ...(comparison.prHead ? { prHead: comparison.prHead } : {}),
    ...(comparison.state === 'mismatch' ? { localHeadRelation: comparison.relation } : {}),
    ...(comparison.state === 'unavailable' ? { localHeadComparisonReason: comparison.reason } : {}),
  };
}

/** PR 의 base OID 와 `owner/repo` 를 한 번에 읽는다(SHA 고정 diff 에 둘 다 필요하다). */
function prCompareAnchors(pr: string, deps: SelfReviewCliDeps): { baseOid?: string; repo?: string } {
  const view = deps.gh(['pr', 'view', pr, '--json', 'baseRefOid,headRepository,headRepositoryOwner'], 15_000);
  if (view.status !== 0) return {};
  try {
    const parsed: unknown = JSON.parse(view.stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const row = parsed as { baseRefOid?: unknown; headRepository?: unknown; headRepositoryOwner?: unknown };
    const baseOid = typeof row.baseRefOid === 'string' && COMMIT_OID.test(row.baseRefOid) ? row.baseRefOid : undefined;
    const owner = row.headRepositoryOwner !== null && typeof row.headRepositoryOwner === 'object'
      ? (row.headRepositoryOwner as { login?: unknown }).login : undefined;
    const name = row.headRepository !== null && typeof row.headRepository === 'object'
      ? (row.headRepository as { name?: unknown }).name : undefined;
    const repo = typeof owner === 'string' && typeof name === 'string' && /^[\w.-]{1,100}$/.test(owner) && /^[\w.-]{1,100}$/.test(name)
      ? `${owner}/${name}` : undefined;
    return { ...(baseOid ? { baseOid } : {}), ...(repo ? { repo } : {}) };
  } catch { return {}; }
}

/** ⭐ diff 를 **두 SHA 에 결속해서** 산출한다 — `A→B→A` 에도 안전하다.
 *  못 하면 `null` 을 내고 호출부가 종전 sandwich 로 폴백한다(이유를 함께 기록한다). */
function readDiffPinnedToSha(pr: string, head: CommitIdentity, deps: SelfReviewCliDeps):
  { read: DiffRead } | { fallback: NonNullable<DiffRead['pinFallbackReason']> } {
  if (head.state !== 'known') return { fallback: 'head-unknown' };
  const { baseOid, repo } = prCompareAnchors(pr, deps);
  if (!baseOid) return { fallback: 'base-oid-unknown' };
  if (!repo) return { fallback: 'repo-unknown' };
  // ⭐ `compare/<base>...<head>` 는 **삼점**이다(merge-base 기준) — `gh pr diff` 와 같은 의미이고,
  //    다만 **양쪽이 SHA 로 못 박혀** 있어 그 사이 head 가 움직여도 같은 diff 가 나온다.
  const diff = deps.gh(
    ['api', `repos/${repo}/compare/${baseOid}...${head.value}`, '-H', 'Accept: application/vnd.github.diff'],
    25_000,
  );
  if (diff.status !== 0) return { fallback: 'compare-failed' };
  // ⛔⭐ **결속과 최신성은 다른 것이다.** SHA 고정은 *"이 diff 가 이 SHA 의 것"* 을 보장하지만
  //    *"이 SHA 가 지금 PR 의 head"* 는 보장하지 않는다. `gh pr view` 는 push 직후 **낡은
  //    `headRefOid`** 를 줄 수 있고(실측 2026-07-30: PR head `8d4569221` 인데 조회가
  //    `2b01e4ef9` 를 줬다), 그러면 리뷰가 **한 커밋 전을 판정하고도 아무 신호가 없다.**
  //    ⇒ 고정 뒤에도 head 를 **다시 읽어 움직임을 알린다.** 종전 sandwich 가 우연히 하던 일이다.
  //    ⚠️ 다만 diff 를 다시 받지는 않는다(`refetched: false`) — 증거는 이미 그 SHA 에 결속돼 있고,
  //      해야 할 일은 **재조회가 아니라 판정 거부**다.
  // ⛔ 두 번째 조회 결과를 **그대로** 전파한다. 실패했는데 이전 SHA 를 현재 head 로 적으면
  //    **미지를 부재와 같은 값으로 두는 것**이고, 그러면 최신성을 **거짓으로 보고**한다.
  //    ⇒ 정책: 확인 못 하면 `stale` 을 세우지 않되(움직였다는 근거도 없다) **상태를 그대로 남긴다**
  //      (`currentHeadCommitState: 'absent'|'malformed'`). 폴백 sandwich 경로도 같은 정책이다
  //      (`stale: after.state === 'known' && …`) — 두 경로가 같은 값을 내야 소비자가 안 갈린다.
  const after = prHeadCommit(pr, deps);
  return {
    read: {
      diff,
      headCommit: head.value,
      headCommitState: 'known',
      currentHeadCommit: after.value,
      currentHeadCommitState: after.state,
      stale: after.state === 'known' && after.value !== head.value,
      refetched: false,
      source: 'sha-pinned',
      baseCommit: baseOid,
    },
  };
}

function readDiffAtHead(pr: string, deps: SelfReviewCliDeps): DiffRead {
  const pinnedHead = prHeadCommit(pr, deps);
  const pinned = readDiffPinnedToSha(pr, pinnedHead, deps);
  if ('read' in pinned) return pinned.read;
  const pinFallbackReason = pinned.fallback;

  const before = pinnedHead;
  let diff = deps.gh(['pr', 'diff', pr], 25_000);
  let after = prHeadCommit(pr, deps);
  if (before.state === 'known' && after.state === 'known' && before.value !== after.value) {
    const refetchHead = after;
    diff = deps.gh(['pr', 'diff', pr], 25_000);
    after = prHeadCommit(pr, deps);
    return {
      diff,
      headCommit: refetchHead.value,
      headCommitState: refetchHead.state,
      currentHeadCommit: after.value,
      currentHeadCommitState: after.state,
      stale: after.state === 'known' && after.value !== refetchHead.value,
      refetched: true,
      source: 'head-sandwich',
      pinFallbackReason,
    };
  }
  return {
    diff,
    headCommit: before.value,
    headCommitState: before.state,
    currentHeadCommit: after.value,
    currentHeadCommitState: after.state,
    stale: false,
    refetched: false,
    source: 'head-sandwich',
    pinFallbackReason,
  };
}

/**
 * git 의 C-스타일 인용 경로를 되돌린다. 순수.
 *
 * 왜: `core.quotePath` 기본값이라 git 은 비-ASCII·탭·개행이 든 경로를 따옴표로 감싸고 8진
 * 이스케이프한다. 실물(이 저장소):
 * `"docs/goals/GOAL-tui-\353\214\200\354\213\234\353\263\264\353\223\234-...txt"`.
 * 안 풀면 `diff --git` 헤더 경로와 `--name-only` 경로가 서로 다른 문자열이 되어, 교집합이
 * 그 파일을 놓치고 **실제 변경이 증거에서 조용히 사라진다**(리뷰 must-fix).
 */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const n = body[i + 1];
    if (n === undefined) break;
    const oct = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    const code = simple[n];
    if (code !== undefined) { bytes.push(code); i += 1; continue; }
    bytes.push(...Buffer.from(n, 'utf8')); i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * `diff --git` 헤더의 **두 토큰을 독립으로** 판다. 각 토큰은 인용될 수도 평문일 수도 있고
 * **섞일 수도 있다** — rename 은 한쪽만 비-ASCII 일 수 있어 `diff --git "a/한글.txt" b/plain.txt`
 * 가 **합법**이다(리뷰 must-fix: 양쪽이 같은 형태라 가정하면 그 파일이 증거에서 사라진다).
 * 반환 = [a-side, b-side](접두 `a/`·`b/` 제거·인용 해제). 못 읽으면 null. 순수.
 */
export function diffHeaderPaths(headerLine: string): [string, string] | null {
  if (!headerLine.startsWith('diff --git ')) return null;
  const rest = headerLine.slice('diff --git '.length).trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    if (rest[i] === ' ') { i++; continue; }
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === '\\') { j += 2; continue; }
        if (rest[j] === '"') break;
        j++;
      }
      if (j >= rest.length) return null;            // 닫히지 않은 인용 — 모르면 null 이다
      tokens.push(unquoteGitPath(rest.slice(i, j + 1)));
      i = j + 1;
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== ' ') j++;
      tokens.push(rest.slice(i, j));
      i = j;
    }
  }
  if (tokens.length !== 2) return null;
  const strip = (t: string): string => (t.startsWith('a/') || t.startsWith('b/')) ? t.slice(2) : t;
  return [strip(tokens[0]!), strip(tokens[1]!)];
}

/** 헤더에서 b-side 경로(변경 후). rename 이면 **새 이름**이다. 없으면 null. 순수. */
export function diffHeaderPath(headerLine: string): string | null {
  const pair = diffHeaderPaths(headerLine);
  return pair ? pair[1] : null;
}

/** diff 텍스트의 파일 경로 집합 — 인용된 경로도 정확히 푼다. 순수. */
export function diffFilePaths(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const p = diffHeaderPath(line);
    if (p !== null) out.push(p);
  }
  return out;
}

/** ⛔ export 하지 않는다 — 외부 소비자가 없다(dead surface 금지·리뷰 must-fix).
 *  `narrowEvidenceToAuthored` 의 반환 타입으로만 쓰이며 소비자는 추론으로 받는다. */
interface AuthoredEvidence {
  /** 리뷰 증거로 쓸 diff. */
  diff: string;
  /** 좁혔나. `full` = 종전 three-dot 그대로. */
  evidence: 'full' | 'authored-only';
  prDiffFiles: number;
  /** 좁힌 뒤 파일 수. 안 좁혔으면 **잰 적 없음**을 뜻하는 undefined 가 아니라, 잰 경우에만 채운다. */
  authoredFiles?: number;
  /** 선택한 저작 범위의 시작 커밋. 측정하지 못했으면 부재로 남긴다. */
  authoredBase?: string;
  /** 저작 범위 시작점의 출처. */
  authoredBaseKind?: 'merge-base' | 'pr-first-parent';
  /** 안 좁힌 이유(좁혔으면 undefined). 부재와 미지를 가른다. */
  skipped?: 'no-git-seam' | 'base-unknown' | 'fetch-failed' | 'head-missing' | 'merge-base-unknown' | 'merged-range-unknown' | 'diff-failed' | 'nothing-to-narrow';
}

/**
 * ⭐⭐ 리뷰 증거를 **이 PR 이 저작한 변경**으로 좁힌다.
 *
 * 규칙: `evidence = (three-dot 파일) ∩ (authored-base..head 파일)`.
 * 보통 `authored-base`는 `git merge-base <current base tip> <head>`다. head가 현재 base의 조상이면
 * 그 값은 head가 되어 빈 범위가 되므로, PR의 첫 커밋 부모를 복원해 그 범위를 쓴다.
 * 어느 기준도 정할 수 없으면 full PR diff를 보존해 미지를 빈 변경으로 말하지 않는다.
 */
export function narrowEvidenceToAuthored(pr: string, headSha: string, prDiff: string, deps: SelfReviewCliDeps): AuthoredEvidence {
  const paths3 = diffFilePaths(prDiff);
  const full = { diff: prDiff, evidence: 'full' as const, prDiffFiles: paths3.length };
  const git = deps.git;
  if (!git) return { ...full, skipped: 'no-git-seam' };
  if (!COMMIT_OID.test(headSha)) return { ...full, skipped: 'head-missing' };

  // ⛔ **base 조회와 commits 조회를 합치지 않는다**(무인 리뷰 should-fix 2026-08-02).
  //    합치면 커밋 목록 조회의 지연·실패가 **일반 비병합 PR 까지** `base-unknown` 으로 퇴행시킨다.
  //    commits 는 아래에서 `mergeBase === headSha` 인 **드문 경로에서만** 필요하다.
  const view = deps.gh(['pr', 'view', pr, '--json', 'baseRefName'], 15_000);
  let baseRef = '';
  if (view.status === 0) {
    try {
      const parsed: unknown = JSON.parse(view.stdout);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as { baseRefName?: unknown };
        if (typeof record.baseRefName === 'string' && /^[\w./-]{1,255}$/.test(record.baseRefName)) baseRef = record.baseRefName;
      }
    } catch { /* baseRef 는 빈 채로 남는다 */ }
  }
  if (!baseRef) return { ...full, skipped: 'base-unknown' };

  /** PR 첫 커밋 oid — **필요할 때만** 조회한다(위 주석). 못 얻으면 빈 문자열. */
  const readFirstPrCommit = (): string => {
    const r = deps.gh(['pr', 'view', pr, '--json', 'commits'], 15_000);
    if (r.status !== 0) return '';
    try {
      const parsed: unknown = JSON.parse(r.stdout);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
      const commits = (parsed as { commits?: unknown }).commits;
      if (!Array.isArray(commits)) return '';
      const first = commits[0];
      if (first === null || typeof first !== 'object' || Array.isArray(first)) return '';
      const oid = (first as { oid?: unknown }).oid;
      return typeof oid === 'string' && COMMIT_OID.test(oid) ? oid : '';
    } catch { return ''; }
  };

  // ⛔ `git fetch origin <branch>` 는 remote-tracking 갱신을 보장하지 않는다 — **FETCH_HEAD** 로 판정한다.
  if (git(['fetch', 'origin', `refs/heads/${baseRef}`], 30_000).status !== 0) return { ...full, skipped: 'fetch-failed' };
  const baseSha = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], 10_000);
  if (baseSha.status !== 0 || !baseSha.stdout.trim()) return { ...full, skipped: 'fetch-failed' };
  const baseCommit = baseSha.stdout.trim();

  if (git(['rev-parse', '--verify', `${headSha}^{commit}`], 10_000).status !== 0) {
    git(['fetch', 'origin', headSha], 30_000);
    if (git(['rev-parse', '--verify', `${headSha}^{commit}`], 10_000).status !== 0) return { ...full, skipped: 'head-missing' };
  }

  const mergeBase = git(['merge-base', baseCommit, headSha], 10_000);
  if (mergeBase.status !== 0 || !COMMIT_OID.test(mergeBase.stdout.trim())) {
    return { ...full, skipped: 'merge-base-unknown' };
  }
  const mergeBaseCommit = mergeBase.stdout.trim();
  let authoredBase = mergeBaseCommit;
  let authoredBaseKind: AuthoredEvidence['authoredBaseKind'] = 'merge-base';
  if (mergeBaseCommit === headSha) {
    // The parent of the PR head only covers its final commit. Recover the first PR
    // commit from GitHub, then use its local first parent to cover the whole PR.
    // ⛔ 실패 경로에서 `authoredBase` 를 **보고하지 않는다**(무인 리뷰 should-fix). 그 필드의 뜻은
    //    *"실제로 쓴 저작 범위의 시작점"* 인데, 여기서는 **아무 범위도 안 썼다.** 후보를 결과로
    //    적으면 읽는 쪽이 그것을 적용된 기준으로 읽는다(부재와 미지를 같은 값으로 적지 않는다).
    const firstPrCommit = readFirstPrCommit();
    if (!firstPrCommit) return { ...full, skipped: 'merged-range-unknown' };
    const firstParents = git(['rev-list', '--parents', '-n', '1', firstPrCommit], 10_000);
    const [commit, parent] = firstParents.stdout.trim().split(/\s+/, 2);
    if (firstParents.status !== 0 || commit !== firstPrCommit || !COMMIT_OID.test(parent) || parent === firstPrCommit) {
      return { ...full, skipped: 'merged-range-unknown' };
    }
    authoredBase = parent;
    authoredBaseKind = 'pr-first-parent';
  }

  // -z 로 받는다(리뷰 must-fix) — 기본 출력은 특수 경로를 **인용**하고 개행조차 담을 수 있어
  //   줄 단위 + trim() 파싱이 합법 경로를 손상시킨다. NUL 구분이면 인용도 손상도 없다.
  const authoredDiff = git(['diff', '--name-only', '-z', `${authoredBase}..${headSha}`], 30_000);
  if (authoredDiff.status !== 0) return { ...full, authoredBase, authoredBaseKind, skipped: 'diff-failed' };
  const authored = new Set(authoredDiff.stdout.split('\0').filter((x) => x.length > 0));
  const keep = paths3.filter((p) => authored.has(p));
  if (keep.length === paths3.length) return { ...full, authoredBase, authoredBaseKind, authoredFiles: keep.length, skipped: 'nothing-to-narrow' };

  const kept = new Set(keep);
  const chunks = splitDiffByFile(prDiff).filter((c) => {
    const header = c.split('\n', 1)[0] ?? '';
    if (!header.startsWith('diff --git ')) return false;   // 프리앰블 청크는 뺀다
    const p = diffHeaderPath(header);
    return p !== null && kept.has(p);
  });
  return { diff: chunks.join(''), evidence: 'authored-only', prDiffFiles: paths3.length, authoredFiles: keep.length, authoredBase, authoredBaseKind };
}

/** 리뷰 입력 머리에 붙는 증거 출처 한 줄 — 리뷰어가 **무엇을 보고 있는지** 알아야 한다. */
export function renderEvidenceProvenance(e: AuthoredEvidence): string {
  const basis = e.authoredBase
    ? ` (authored base: ${e.authoredBase}; kind: ${e.authoredBaseKind ?? 'unknown'})`
    : '';
  if (e.evidence === 'authored-only') {
    return `Review evidence: AUTHORED CHANGES ONLY — ${e.authoredFiles} of ${e.prDiffFiles} file(s) in the PR's displayed diff${basis}. `
      + `The other ${e.prDiffFiles - (e.authoredFiles ?? 0)} file(s) are not included in the selected authored range. `
      + `Judge scope on these ${e.authoredFiles} file(s).`;
  }
  return `Review evidence: full PR diff — ${e.prDiffFiles} file(s)${basis}${e.skipped && e.skipped !== 'nothing-to-narrow' ? ` (narrowing unavailable: ${e.skipped})` : ''}.`;
}

function renderProvenance(diffRead: DiffRead): string {
  // ⭐ **증거의 결속 강도**를 함께 찍는다 — 읽는 사람이 *"이 diff 가 이 SHA 의 것인가"* 를
  //    추정하지 않게 한다. ⛔ `head-sandwich` 는 `A→B→A` 를 못 잡으므로 그 사실을 숨기지 않는다.
  // ⭐ 결속과 **최신성**은 다른 것이다 — 둘째를 확인 못 했으면 그것도 적는다(실측 근거로 추가).
  const currency = diffRead.currentHeadCommitState === 'known' ? '' : '; currency unverified';
  const binding = diffRead.source === 'sha-pinned'
    ? `diff pinned to ${diffRead.baseCommit ?? 'unknown-base'}...${diffRead.headCommit} (ABA-safe${currency})`
    : `diff read by head sandwich (not SHA-bound${diffRead.pinFallbackReason ? `; pin unavailable: ${diffRead.pinFallbackReason}` : ''})`;
  return `Review provenance: diff head=${diffRead.headCommit}; current PR head=${diffRead.currentHeadCommit}; ${binding}.`;
}

function renderStaleRefusal(diffRead: DiffRead): string {
  return `${renderProvenance(diffRead)}\n⛔ REVIEW REFUSED: PR head moved again after the single diff re-fetch (${diffRead.headCommit} → ${diffRead.currentHeadCommit}). No verdict was produced for this stale diff.`;
}

export function reviewerContextArgs(argv: readonly string[]): Array<{ kind: 'file' | 'text'; value: string }> {
  const ordered: Array<{ kind: 'file' | 'text'; value: string }> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--context' || arg === '--context-text') {
      const value = argv[index + 1];
      if (value !== undefined) {
        ordered.push({ kind: arg === '--context' ? 'file' : 'text', value });
        index += 1;
      }
      continue;
    }
    const match = /^--(context|context-text)=(.*)$/.exec(arg ?? '');
    if (match) ordered.push({ kind: match[1] === 'context' ? 'file' : 'text', value: match[2]! });
  }
  return ordered;
}

interface LoadedReviewerContext {
  items: ReviewerContextItem[];
  failed: Array<{ path: string; kind: 'missing' | 'directory' | 'outside-repository' | 'read-error' | 'not-text' }>;
  source: 'provided' | 'pr-diff-files';
  sourcePaths: string[];
}

type DecompositionLookupStatus = 'not-sharded' | 'absent' | 'found' | 'incomplete' | 'failed';

interface DecompositionLookupResult {
  status: DecompositionLookupStatus;
  runId?: string;
  item?: ReviewerContextItem;
  reason?: string;
}

type DecompositionScope = { kind: 'orchestrationId'; value: string };

const DECOMPOSITION_CONTEXT_MAX_SIBLINGS = 16;
const DECOMPOSITION_CONTEXT_MAX_TEXT_CHARS = 6000;
const DECOMPOSITION_CONTEXT_ID_MAX_CHARS = 160;

function boundDecompositionText(value: string, max = DECOMPOSITION_CONTEXT_ID_MAX_CHARS): string {
  const text = safeLogText(value.trim(), max);
  return text || '(unknown)';
}

function finalShardEntry(entries: readonly RunLedgerEntry[]): RunLedgerEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.pieceTotal !== undefined || entry.shardId !== undefined || entry.siblingShardIds !== undefined || entry.pieceIndex !== undefined) return entry;
  }
  return undefined;
}

function runIdsFromReviewText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\b(?:runId:\s*|elanous\s+self\s+run-ledger\s+)([A-Za-z0-9._:-]{3,160})/g)) {
    const id = match[1]?.replace(/[),.;]+$/g, '');
    if (id) ids.add(id);
  }
  return [...ids];
}

function entryShardId(entry: RunLedgerEntry): string | undefined {
  const shardId = entry.shardId?.trim();
  return shardId || undefined;
}

function entryPieceIndex(entry: RunLedgerEntry): number | undefined {
  return entry.pieceIndex !== undefined ? entry.pieceIndex : undefined;
}

function siblingResponsibility(entry: RunLedgerEntry): string | undefined {
  const data = entry.data as Record<string, unknown> | undefined;
  for (const key of ['wiringResponsibility', 'wiring', 'responsibility', 'feature', 'summary']) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) return boundDecompositionText(value, 220);
  }
  return undefined;
}

function decompositionScope(entry: RunLedgerEntry): DecompositionScope | undefined {
  const orchestrationId = entry.orchestrationId?.trim();
  return orchestrationId ? { kind: 'orchestrationId', value: orchestrationId } : undefined;
}

function sameDecompositionScope(entry: RunLedgerEntry, scope: DecompositionScope): boolean {
  return entry.orchestrationId?.trim() === scope.value;
}

function normalizedDeclaredSiblingShardIds(entry: RunLedgerEntry): string[] {
  return entry.siblingShardIds?.map((id) => id.trim()).filter(Boolean) ?? [];
}

function uniqueSiblingShardIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function duplicateSiblingShardIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates].sort();
}

interface DecompositionSiblingProjection {
  runId: string;
  shardId?: string;
  pieceIndex?: number;
  wiringResponsibility?: string;
}

type DecompositionProjectionSkipReason = 'not-sharded' | 'piece-total-not-recorded' | 'piece-total-invalid';

interface DecompositionContextProjection {
  current: {
    runId: string;
    shardId?: string;
    pieceIndex?: number;
    pieceTotal: number;
    siblingShardIds: readonly string[];
  };
  siblings: readonly DecompositionSiblingProjection[];
  shownSiblings: number;
  totalSiblings: number;
  omittedSiblings: number;
  truncated: boolean;
}

type DecompositionContextProjectionResult =
  | { status: 'projected'; projection: DecompositionContextProjection }
  | { status: 'skipped'; reason: DecompositionProjectionSkipReason };

function validPieceTotal(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function projectDecompositionContext(
  currentRunId: string,
  currentEntry: RunLedgerEntry,
  siblingEntries: readonly { runId: string; entry: RunLedgerEntry }[],
): DecompositionContextProjectionResult {
  if (currentEntry.pieceTotal === undefined) return { status: 'skipped', reason: 'piece-total-not-recorded' };
  if (!validPieceTotal(currentEntry.pieceTotal)) return { status: 'skipped', reason: 'piece-total-invalid' };
  const pieceTotal = currentEntry.pieceTotal;
  if (pieceTotal <= 1) return { status: 'skipped', reason: 'not-sharded' };
  const currentShardId = entryShardId(currentEntry);
  const declaredSiblingIds = uniqueSiblingShardIds(normalizedDeclaredSiblingShardIds(currentEntry));
  const declaredOrder = new Map(declaredSiblingIds.map((id, index) => [id, index]));
  const siblings = siblingEntries
    .filter(({ runId }) => runId !== currentRunId)
    .map(({ runId, entry }) => ({
      runId: boundDecompositionText(runId),
      ...(entryShardId(entry) ? { shardId: boundDecompositionText(entryShardId(entry)!) } : {}),
      ...(entryPieceIndex(entry) !== undefined ? { pieceIndex: entryPieceIndex(entry) } : {}),
      ...(siblingResponsibility(entry) ? { wiringResponsibility: siblingResponsibility(entry) } : {}),
    }))
    .sort((a, b) => {
      const ai = a.shardId ? declaredOrder.get(a.shardId) : undefined;
      const bi = b.shardId ? declaredOrder.get(b.shardId) : undefined;
      if (ai !== undefined || bi !== undefined) return (ai ?? Number.MAX_SAFE_INTEGER) - (bi ?? Number.MAX_SAFE_INTEGER);
      return (a.pieceIndex ?? Number.MAX_SAFE_INTEGER) - (b.pieceIndex ?? Number.MAX_SAFE_INTEGER) || a.runId.localeCompare(b.runId);
    });
  const shown = siblings.slice(0, DECOMPOSITION_CONTEXT_MAX_SIBLINGS);
  return {
    status: 'projected',
    projection: {
      current: {
        runId: boundDecompositionText(currentRunId),
        ...(currentShardId ? { shardId: boundDecompositionText(currentShardId) } : {}),
        ...(currentEntry.pieceIndex !== undefined ? { pieceIndex: currentEntry.pieceIndex } : {}),
        pieceTotal,
        siblingShardIds: declaredSiblingIds.map((id) => boundDecompositionText(id)),
      },
      siblings: shown,
      shownSiblings: shown.length,
      totalSiblings: siblings.length,
      omittedSiblings: siblings.length - shown.length,
      truncated: shown.length < siblings.length,
    },
  };
}

function renderDecompositionContextProjection(projection: DecompositionContextProjection): string {
  const current = projection.current;
  const siblingLines = projection.siblings.map((sibling) => `- sibling: runId=${sibling.runId}${sibling.shardId ? ` shardId=${sibling.shardId}` : ''}${sibling.pieceIndex !== undefined ? ` pieceIndex=${sibling.pieceIndex}` : ''}${sibling.wiringResponsibility ? ` wiringResponsibility=${sibling.wiringResponsibility}` : ''}`);
  const metadataPrefix = [
    'Shard decomposition context',
    `- current: runId=${current.runId}${current.shardId ? ` shardId=${current.shardId}` : ''}${current.pieceIndex !== undefined ? ` pieceIndex=${current.pieceIndex}` : ''} pieceTotal=${current.pieceTotal}`,
    `- declared sibling shard ids: ${current.siblingShardIds.length ? current.siblingShardIds.join(', ') : '(none recorded)'}`,
  ];
  const fullTotal = [...metadataPrefix, `- siblings shown/total: ${projection.shownSiblings}/${projection.totalSiblings}; omitted=${projection.omittedSiblings}; truncated=${projection.truncated}`, ...siblingLines].join('\n');
  if (fullTotal.length <= DECOMPOSITION_CONTEXT_MAX_TEXT_CHARS) return fullTotal;

  const truncationMarker = `... [decomposition context truncated to ${DECOMPOSITION_CONTEXT_MAX_TEXT_CHARS} chars]`;
  const metadataReserve = truncationMarker.length + 1;
  const siblingBudget = Math.max(0, DECOMPOSITION_CONTEXT_MAX_TEXT_CHARS - metadataReserve);
  const keptSiblingLines: string[] = [];
  let shownChars = [...metadataPrefix, `- siblings shown/total: 0/${projection.totalSiblings}; omitted=${projection.totalSiblings}; truncated=true`, truncationMarker].join('\n').length;
  for (const line of siblingLines) {
    const candidateShownChars = shownChars + line.length + 1;
    if (candidateShownChars > siblingBudget) break;
    keptSiblingLines.push(line);
    shownChars = candidateShownChars;
  }
  const renderedOmitted = Math.max(0, projection.totalSiblings - keptSiblingLines.length);
  const lines = [
    ...metadataPrefix,
    `- siblings shown/total: ${keptSiblingLines.length}/${projection.totalSiblings}; omitted=${renderedOmitted}; truncated=true`,
    ...keptSiblingLines,
    truncationMarker,
  ];
  const text = lines.join('\n');
  return text.length <= DECOMPOSITION_CONTEXT_MAX_TEXT_CHARS
    ? text
    : `${text.slice(0, DECOMPOSITION_CONTEXT_MAX_TEXT_CHARS - truncationMarker.length - 1).trimEnd()}\n${truncationMarker}`;
}

function lookupDecompositionContextForReview(text: string, deps: SelfReviewCliDeps): DecompositionLookupResult {
  const runIds = runIdsFromReviewText(text);
  if (runIds.length === 0) return { status: 'absent', reason: 'run-id-not-found-in-review-text' };
  const lookup = deps.lookupRunLedger ?? ((runId: string) => lookupRunLedger(runId, { all: true, includeTest: true }));
  const list = deps.listRunLedgers ?? (() => listRunLedgers({ all: true, includeTest: true }));
  try {
    for (const runId of runIds) {
      const matches = lookup(runId).matches;
      const match = matches[0];
      const current = match ? finalShardEntry(match.entries) : undefined;
      if (!current) continue;
      const projectionBase = projectDecompositionContext(match.runId, current, []);
      if (projectionBase.status === 'skipped') {
        return projectionBase.reason === 'not-sharded'
          ? { status: 'not-sharded', runId: match.runId }
          : { status: 'incomplete', runId: match.runId, reason: projectionBase.reason };
      }
      const declaredSiblingIds = normalizedDeclaredSiblingShardIds(current);
      const duplicateDeclaredSiblingIds = duplicateSiblingShardIds(declaredSiblingIds);
      if (duplicateDeclaredSiblingIds.length > 0) return { status: 'incomplete', runId: match.runId, reason: `duplicate-declared-sibling-shard-id:${duplicateDeclaredSiblingIds.join(',')}` };
      const uniqueDeclaredSiblingIds = uniqueSiblingShardIds(declaredSiblingIds);
      if (uniqueDeclaredSiblingIds.length === 0) return { status: 'incomplete', runId: match.runId, reason: 'sibling-shard-ids-not-recorded' };
      const expectedSiblingCount = Math.max(0, projectionBase.projection.current.pieceTotal - 1);
      if (uniqueDeclaredSiblingIds.length !== expectedSiblingCount) return { status: 'incomplete', runId: match.runId, reason: `declared-sibling-shard-count-mismatch:expected=${expectedSiblingCount},actual=${uniqueDeclaredSiblingIds.length}` };
      const siblingShardIds = new Set(uniqueDeclaredSiblingIds);
      const scope = decompositionScope(current);
      if (!scope) return { status: 'incomplete', runId: match.runId, reason: 'decomposition-scope-not-recorded' };
      const siblingsByShardId = new Map<string, { runId: string; entry: RunLedgerEntry }>();
      const duplicateShardIds = new Set<string>();
      for (const candidate of list().matches) {
        const entry = finalShardEntry(candidate.entries);
        const shardId = entry ? entryShardId(entry) : undefined;
        if (!entry || !shardId || !siblingShardIds.has(shardId) || !sameDecompositionScope(entry, scope)) continue;
        if (siblingsByShardId.has(shardId)) duplicateShardIds.add(shardId);
        else siblingsByShardId.set(shardId, { runId: candidate.runId, entry });
      }
      if (duplicateShardIds.size > 0) return { status: 'incomplete', runId: match.runId, reason: `duplicate-sibling-shard-id:${[...duplicateShardIds].sort().join(',')}` };
      const missingShardIds = [...siblingShardIds].filter((shardId) => !siblingsByShardId.has(shardId));
      if (missingShardIds.length > 0) return { status: 'incomplete', runId: match.runId, reason: `sibling-ledger-entry-not-found-in-scope:${missingShardIds.join(',')}` };
      const siblings = projectionBase.projection.current.siblingShardIds.flatMap((shardId) => {
        const sibling = siblingsByShardId.get(shardId);
        return sibling ? [sibling] : [];
      });
      const projection = projectDecompositionContext(match.runId, current, siblings);
      if (projection.status === 'skipped') {
        return projection.reason === 'not-sharded'
          ? { status: 'not-sharded', runId: match.runId }
          : { status: 'incomplete', runId: match.runId, reason: projection.reason };
      }
      return { status: 'found', runId: match.runId, item: { label: 'shard decomposition context', body: renderDecompositionContextProjection(projection.projection) } };
    }
    return { status: 'absent', reason: 'run-ledger-entry-not-found' };
  } catch (error) {
    return { status: 'failed', reason: safeLogText(error instanceof Error ? error.message : String(error), 400) };
  }
}

function appendDecompositionContext(loaded: LoadedReviewerContext, lookup: DecompositionLookupResult): LoadedReviewerContext {
  if (!lookup.item) return loaded;
  return { ...loaded, items: [...loaded.items, lookup.item] };
}

/** base64 → 원본 바이트 수. ⛔ 패딩(`=`)을 빼야 한다 — 안 빼면 7바이트가 9바이트로 «보고»된다
 *  (`#7486` 리뷰 should-fix). 안 잰 값을 잰 것처럼 적지 않는다. */
function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

export function loadReviewerContext(opts: Pick<SelfReviewCliOpts, 'context' | 'contextText' | 'contextOrder'>, readReferencedFile?: ReferencedFileReader): LoadedReviewerContext {
  const ordered = opts.contextOrder ?? [
    ...(opts.context ?? []).map((value) => ({ kind: 'file' as const, value })),
    ...(opts.contextText ?? []).map((value) => ({ kind: 'text' as const, value })),
  ];
  const items: ReviewerContextItem[] = [];
  const failed: Array<{ path: string; kind: 'missing' | 'directory' | 'outside-repository' | 'read-error' | 'not-text' }> = [];
  for (const item of ordered) {
    if (item.kind === 'text') {
      items.push({ label: 'provided text', body: item.value });
      continue;
    }
    const result = readReferencedFile?.(item.value) ?? { kind: 'read-error' as const };
    if (result.kind === 'ok') items.push({ label: item.value, body: result.contents });
    // ⭐ `P4b` — 이미지는 «실패가 아니다». 종전엔 리더가 not-text 로 돌려줘 여기서 failed 로 갔다.
    //   `body` 에는 짧은 표지만 두고 픽셀은 image 로 따로 실어 ContentBlock 으로 보낸다.
    else if (result.kind === 'image') items.push({
      label: item.value,
      // ⛔⭐⭐ 「보냈다」고 «쓰지 않는다» — 이 표지는 «로드 시점»에 만들어지고, 실제 전송은
      //   백엔드가 image 를 광고할 때만 일어난다(`acp-reviewer`). 종전 문면(*"아래 이미지 블록으로
      //   함께 보냈다"*)은 미지원 백엔드에서 ***안 보낸 것을 보냈다고 말해***, 모델이 「봤다」를
      //   전제한 리뷰를 완료로 내게 만든다(`#7486` 리뷰 must-fix — 오늘 이 창이 반복해 만난 형태).
      //   ⇒ 사실만 적는다: 이것은 이미지이고, 받는 백엔드에서만 실린다.
      body: `[image ${result.mimeType} · ${base64ByteLength(result.data)} bytes — 이미지 참조다. 이미지를 받는 백엔드에서만 함께 실린다]`,
      image: { mimeType: result.mimeType, data: result.data },
    });
    else failed.push({ path: item.value, kind: result.kind });
  }
  return { items, failed, source: 'provided', sourcePaths: ordered.filter((item) => item.kind === 'file').map((item) => item.value) };
}

function repositoryRelativeApiPath(path: string): string | null {
  if (!path || path.startsWith('/')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.map(encodeURIComponent).join('/');
}

function isRemoteMissing(result: GhResult): boolean {
  return /\bHTTP\s+404\b/i.test(`${result.stderr}\n${result.stdout}`);
}

function loadPrDiffReviewerContext(pr: string, headCommit: string, paths: readonly string[], deps: SelfReviewCliDeps): LoadedReviewerContext {
  const items: ReviewerContextItem[] = [];
  const failed: LoadedReviewerContext['failed'] = [];
  const repo = prHeadRef(pr, deps)?.nameWithOwner;
  for (const path of paths) {
    // `gh api` reads the selected path at the reviewed PR's immutable head, including
    // heads which this worktree has never fetched. Provided --context remains local.
    const remotePath = repositoryRelativeApiPath(path);
    if (!remotePath) {
      failed.push({ path, kind: 'outside-repository' });
      continue;
    }
    const result = repo && COMMIT_OID.test(headCommit)
      ? deps.gh(['api', `repos/${repo}/contents/${remotePath}?ref=${encodeURIComponent(headCommit)}`, '-H', 'Accept: application/vnd.github.raw'], 15_000)
      : undefined;
    if (result?.status === 0) items.push({ label: path, body: result.stdout });
    else failed.push({ path, kind: result && isRemoteMissing(result) ? 'missing' : 'read-error' });
  }
  return { items, failed, source: 'pr-diff-files', sourcePaths: [...paths] };
}

function reviewerContextOutput(loaded: LoadedReviewerContext, decomposition?: DecompositionLookupResult) {
  const budget = budgetReviewerContext(loaded.items);
  return {
    reviewerContextLoaded: loaded.items.length,
    reviewerContextFailed: loaded.failed.length,
    reviewerContextFailures: loaded.failed,
    reviewerContextSource: loaded.source,
    reviewerContextSourcePaths: loaded.sourcePaths,
    ...(decomposition ? {
      decompositionContextStatus: decomposition.status,
      ...(decomposition.runId ? { decompositionContextRunId: decomposition.runId } : {}),
      ...(decomposition.reason ? { decompositionContextReason: decomposition.reason } : {}),
    } : {}),
    ...(budget.truncated ? {
      reviewerContextTruncated: true,
      reviewerContextShownChars: budget.shownChars,
      reviewerContextTotalChars: budget.totalChars,
      reviewerContextFullyIncluded: budget.fullyIncludedItems,
      reviewerContextPartiallyIncluded: budget.truncatedItems,
      reviewerContextOmitted: budget.omittedItems,
    } : {}),
  };
}

const MAX_ACP_REVIEW_FALLBACK_CANDIDATES = 4;

/** Same reason codes as the harness lane (`runSubscriptionReviewer`) — a raw message may carry account or proxy details. */
function roleAcpErrorReason(error: unknown): 'acp-handshake-timeout' | 'acp-error' {
  const message = error instanceof Error ? error.message : String(error);
  return /handshake timeout/i.test(message) ? 'acp-handshake-timeout' : 'acp-error';
}

type AcpFallbackSkip = { backend: string; reason: string };

function orderedAcpReviewFallbackBackends(configuredBackend: string | undefined): {
  backends: string[];
  skipped: AcpFallbackSkip[];
} {
  const candidates = [configuredBackend, ...Object.keys(ACP_BACKENDS)]
    .map((backend) => backend?.trim())
    .filter((backend): backend is string => Boolean(backend));
  const seen = new Set<string>();
  const backends: string[] = [];
  const skipped: AcpFallbackSkip[] = [];
  for (const candidate of candidates) {
    const backend = canonicalizeBackendId(candidate);
    const spec = ACP_BACKENDS[backend];
    if (!spec || seen.has(backend)) continue;
    seen.add(backend);
    if (spec.unsupportedReason) {
      skipped.push({ backend, reason: spec.unsupportedReason });
      continue;
    }
    backends.push(backend);
    if (backends.length === MAX_ACP_REVIEW_FALLBACK_CANDIDATES) break;
  }
  return { backends, skipped };
}

function renderDecompositionContextStatus(lookup: DecompositionLookupResult): string {
  if (lookup.status === 'found') return ` Decomposition context: loaded from run ledger${lookup.runId ? ` for ${lookup.runId}` : ''}.`;
  if (lookup.status === 'not-sharded') return ` Decomposition context: not sharded${lookup.runId ? ` (${lookup.runId})` : ''}; review unchanged.`;
  if (lookup.status === 'incomplete') return ` Decomposition context: incomplete (${lookup.reason ?? 'missing shard decomposition data'}); review continues without shard context.`;
  if (lookup.status === 'failed') return ` Decomposition context: unavailable (${lookup.reason ?? 'read failure'}); review continues without shard context.`;
  return ` Decomposition context: absent (${lookup.reason ?? 'no decomposition data'}); review continues without shard context.`;
}

export function renderReviewerContextStatus(loaded: LoadedReviewerContext, decomposition?: DecompositionLookupResult): string {
  const failures = loaded.failed.map(({ path, kind }) => `- ${path}: ${kind}`).join('\n');
  const budget = budgetReviewerContext(loaded.items);
  const truncation = budget.truncated
    ? ` Context budget-truncated: ${budget.shownChars}/${budget.totalChars} chars shown; ${budget.fullyIncludedItems} fully included, ${budget.truncatedItems} truncated, ${budget.omittedItems} omitted.`
    : '';
  const source = loaded.source === 'pr-diff-files'
    ? ` Source: ${loaded.sourcePaths.length} PR diff file(s) selected because no --context or --context-text was provided: ${loaded.sourcePaths.join(', ') || '(none)'}.`
    : '';
  const decompositionStatus = decomposition ? renderDecompositionContextStatus(decomposition) : '';
  const labels = loaded.items.map(({ label }) => `- ${label}`).join('\n');
  return `Reviewer context: ${loaded.items.length} loaded, ${loaded.failed.length} not loaded.${source}${truncation}${decompositionStatus}${labels ? `\n${labels}` : ''}${failures ? `\n${failures}` : ''}`;
}

/** `elanous self review <pr...>` 본문. read-only — 머지하지 않는다. */
/**
 * `self review --json` stdout 한 줄 — 결과가 하나면 객체, 여럿이면 배열. index.ts 액션이 이것을 그대로 쓴다.
 * TA-REVIEW-RESULT-CAPTURE — task agent 는 떼어 띄운 리뷰의 stdout 을 파일로 받아 이 줄을 읽는다(형식 계약 = 이 함수).
 */
export function selfReviewJsonLine(results: readonly unknown[]): string {
  return JSON.stringify(results.length === 1 ? results[0] : results) + '\n';
}

export async function runSelfReviewCliCommand(
  prArgs: string[],
  opts: SelfReviewCliOpts,
  deps: SelfReviewCliDeps,
): Promise<SelfReviewCliOutcome> {
  // 관측 sink는 모든 종료 경로보다 먼저 등록해 거부도 운영 로그에 남긴다.
  await deps.registerSink('self-review');

  const invalidPrArgs = prArgs.filter((pr) => !/^\d+$/.test(pr));
  if (invalidPrArgs.length > 0) {
    const safeInvalidPrArgs = invalidPrArgs.map((pr) => JSON.stringify(safeLogText(pr)));
    deps.log('invalid-pr-args', {
      prArgsCount: prArgs.length,
      invalidPrArgsCount: invalidPrArgs.length,
      invalidPrArgs: safeInvalidPrArgs,
    }, { level: 'warn' });
    deps.error(`PR 인자가 올바르지 않습니다: ${safeInvalidPrArgs.join(', ')}. PR 번호는 숫자 형식이어야 합니다 (예: elanous self review 5502).`);
    return { results: [] };
  }

  const useAcp = opts.acp === true;
  const acpModel = opts.acpModel?.trim() || undefined;
  const acpBackendResolution = opts.acpBackend
    ? { backend: opts.acpBackend, source: 'cli' as const }
    : opts.configuredAcpBackend
      ? { backend: opts.configuredAcpBackend, source: 'config' as const }
      : { backend: DEFAULT_REVIEW_BACKEND, source: 'default' as const };
  const acpBackend = acpBackendResolution.backend;
  const automaticFallbacks = orderedAcpReviewFallbackBackends(opts.configuredAcpBackend);
  const fallbackAcpBackends = opts.acpBackend
    ? [canonicalizeBackendId(opts.acpBackend)]
    : automaticFallbacks.backends;
  const skippedAcpFallbackBackends = opts.acpBackend ? [] : automaticFallbacks.skipped;
  const acpTimeoutSec = Number.isFinite(Number(opts.acpTimeout)) && Number(opts.acpTimeout) > 0
    ? Number(opts.acpTimeout) : 300;
  let acpReviewLLM: ((prompt: string, images?: readonly ReviewImage[]) => Promise<string>) | null = null;
  if (useAcp) {
    acpReviewLLM = deps.makeAcpLlm({ backend: acpBackend, ...(acpModel ? { model: acpModel } : {}), timeoutMs: acpTimeoutSec * 1000 });
  }
  const model = useAcp ? `acp:${acpBackend}${acpModel ? `/${acpModel}` : ''}` : (opts.model || deps.envModel() || tierModel('better'));
  // ⭐ Reviewer selection source. An explicit flag always wins byte-for-byte; only without one does
  //    `roleLlm.reviewer` (the harness's reviewer row) pick the ACP lane. Worst case = today's API review.
  const explicitReviewerFlag = opts.acp === true || Boolean(opts.acpBackend) || Boolean(opts.acpModel?.trim()) || Boolean(opts.model?.trim());
  const reviewerSource: 'cli' | 'role-config' | 'default' = explicitReviewerFlag ? 'cli' : opts.roleReviewer ? 'role-config' : 'default';
  let roleReviewer: { llm: (prompt: string, images?: readonly ReviewImage[]) => Promise<string>; model: string } | undefined;
  let roleReviewerUnavailableReason: string | undefined;
  let roleReviewerAvailabilityMs: number | undefined;
  // ⚠️ Availability (subscription ⊕ usage cap ⊕ proxy URL) is checked once per command, not per PR —
  //    a mid-run change is caught by the per-PR review attempt failing and falling back to the API.
  if (reviewerSource === 'role-config' && opts.roleReviewer) {
    const availabilityStartedAt = deps.now();
    try {
      const made = deps.makeRoleReviewerLlm
        ? deps.makeRoleReviewerLlm(opts.roleReviewer, { timeoutMs: acpTimeoutSec * 1000 })
        : { reason: 'role-reviewer-seam-missing' };
      if ('llm' in made) roleReviewer = { llm: made.llm, model: `acp:${made.backend}` };
      else roleReviewerUnavailableReason = safeLogText(made.reason, 400);
    } catch (error) {
      roleReviewerUnavailableReason = roleAcpErrorReason(error);
    }
    roleReviewerAvailabilityMs = deps.now() - availabilityStartedAt;
    if (roleReviewerUnavailableReason) {
      deps.log('role-reviewer-fallback', {
        reviewerSource, roleReviewerProvider: opts.roleReviewer.provider, roleReviewerAvailabilityMs,
        stage: 'availability', reason: roleReviewerUnavailableReason, fallbackModel: safeLogText(model),
      }, { level: 'warn' });
    }
  }
  const primaryModel = roleReviewer?.model ?? model;
  const reviewerSourceObservation = (): Record<string, unknown> => ({
    reviewerSource,
    ...(reviewerSource === 'role-config' && opts.roleReviewer ? { roleReviewerProvider: opts.roleReviewer.provider } : {}),
    ...(roleReviewerAvailabilityMs !== undefined ? { roleReviewerAvailabilityMs } : {}),
    ...(roleReviewerUnavailableReason ? { roleReviewerFallbackReason: roleReviewerUnavailableReason } : {}),
  });
  const results: Array<Record<string, unknown>> = [];
  const providedReviewerContext = loadReviewerContext(opts, deps.readReferencedFile);
  const hasProvidedReviewerContext = (opts.contextOrder?.length ?? 0) > 0 || (opts.context?.length ?? 0) > 0 || (opts.contextText?.length ?? 0) > 0;
  for (const pr of prArgs) {
    const diffRead = readDiffAtHead(pr, deps);
    const localHeadComparison = compareLocalHead(pr, { value: diffRead.headCommit, state: diffRead.headCommitState }, deps);
    const { diff } = diffRead;
    const baseReviewerContext = hasProvidedReviewerContext
      ? providedReviewerContext
      : loadPrDiffReviewerContext(pr, diffRead.headCommit, diffFilePaths(diff.stdout), deps);
    const comparisonData = comparisonObservation(localHeadComparison);
    // ⛔ `relation-unknown` 도 경고한다(위 주석 · 리뷰가 두 라운드 반복 지적) — 그 밖 unavailable 은 조용하다.
    //    ⭐ 경고 여부 판정은 `localHeadWarningDetails` 한 곳에 있다(호출부에서 같은 함수를 두 번 부르지 않는다).
    const mismatchWarning = localHeadWarningDetails(localHeadComparison);
    const view = deps.gh(['pr', 'view', pr, '--json', 'title,body'], 15_000);
    let prView: { title?: string; body?: string } | undefined;
    if (view.status === 0) {
      try { prView = JSON.parse(view.stdout) as { title?: string; body?: string }; } catch { /* fallback below */ }
    }
    const title = prView?.title ?? '';
    const body = prView?.body;
    const decompositionContext = lookupDecompositionContextForReview(`${title}\n${body ?? ''}`, deps);
    const reviewerContext = appendDecompositionContext(baseReviewerContext, decompositionContext);
    const reviewerContextStatus = renderReviewerContextStatus(reviewerContext, decompositionContext);
    let intent: string;
    let intentSource: 'flag' | 'flag+pr-body' | 'pr-body' | 'pr-title' | 'fallback';
    let intentTruncation: ReturnType<typeof reviewIntentTruncationObservation>;
    if (opts.intent !== undefined) {
      if (body?.trim()) {
        const intentText = `## 명시 intent\n${opts.intent}\n\n## PR 본문\n${body.trim()}`;
        intent = buildManualReviewIntent(opts.intent, body.trim());
        intentTruncation = reviewIntentTruncationObservation(intentText);
        intentSource = 'flag+pr-body';
      } else {
        intent = opts.intent;
        intentTruncation = {};
        intentSource = 'flag';
      }
    } else {
      intent = intentFromPr({ title, body });
      // ⭐ 절 단위 생존을 같이 남긴다 — 종전엔 `intentChars` 만 있어 **판정 기준이 잘렸는지**를
      //    조회로 못 갈랐다(실측: 하니스 PR 6/8 이 `## 리뷰 intent` 를 22k 뒤에 두고 있었다).
      intentTruncation = { ...reviewIntentTruncationFromPr({ title, body }), ...prIntentSectionCoverage({ title, body }) };
      intentSource = body?.trim() ? 'pr-body' : title.trim() ? 'pr-title' : 'fallback';
      if (!intent) intent = `PR ${pr}`;
    }
    const startObservation = (extra: Record<string, unknown> = {}) => deps.log('start', {
      pr: safeLogText(pr), model: safeLogText(primaryModel),
      ...reviewerSourceObservation(),
      ...(roleReviewer ? { roleReviewerModel: safeLogText(roleReviewer.model) } : {}),
      backend: safeLogText(useAcp ? `acp:${acpBackend}` : roleReviewer ? roleReviewer.model : 'api'),
      ...(useAcp ? { acpBackend: safeLogText(acpBackend), acpBackendSource: acpBackendResolution.source } : {}),
      intentChars: intent.length, intentGiven: opts.intent !== undefined, intentSource,
      reviewerContextLoaded: reviewerContext.items.length, reviewerContextFailed: reviewerContext.failed.length,
      decompositionContextStatus: decompositionContext.status,
      ...(decompositionContext.runId ? { decompositionContextRunId: safeLogText(decompositionContext.runId) } : {}),
      ...(decompositionContext.reason ? { decompositionContextReason: safeLogText(decompositionContext.reason, 400) } : {}),
      ...intentTruncation,
      diffChars: diff.stdout.length,
      headCommit: safeLogText(diffRead.headCommit), headCommitState: diffRead.headCommitState,
      currentHeadCommit: safeLogText(diffRead.currentHeadCommit), currentHeadCommitState: diffRead.currentHeadCommitState,
      stale: diffRead.stale, refetched: diffRead.refetched,
      ...comparisonData,
      ...extra,
    });
    if (diff.status !== 0 || !diff.stdout.trim()) {
      // ⭐ diff를 못 읽어도 시작 판정은 남긴다.
      startObservation();
      // ⭐ `warning` 이 이미 행동 문구를 품는다(두 생성기가 같은 형상) — ⛔ 여기서 action 을 또 붙이면
      //    같은 문장이 두 번 나온다(리뷰 must-fix).
      if (mismatchWarning) deps.error(mismatchWarning.warning);
      const err = `gh pr diff 실패: ${(diff.stderr || '').slice(0, 140)}`;
      deps.log('diff-fail',
        { pr: safeLogText(pr), exit: diff.status, error: safeLogText(diff.stderr || err, 160) },
        { level: 'warn' });
      const contextOutput = reviewerContextOutput(reviewerContext, decompositionContext);
      if (opts.json) results.push({ pr, error: err, ...contextOutput, ...comparisonData, ...(mismatchWarning ?? {}) });
      else deps.error(`PR ${pr}: ${err}\n${reviewerContextStatus}`);
      continue;
    }
    // ⭐ S2(2026-07-30) — 리뷰 증거를 **이 PR 이 저작한 변경**으로 좁힌다. 실측 7건에서 1건만
    //   좁히고(49→6) 나머지는 그대로다. ⚠️ 새 이벤트를 만들지 않는다 — 증거는 **입력의 성질**이므로
    //   `start` payload 에 싣는다(발화 순서 계약 보존).
    const evidence = narrowEvidenceToAuthored(pr, diffRead.headCommit, diff.stdout, deps);
    const evidenceLine = renderEvidenceProvenance(evidence);
    // ⭐ 골 판정 신호는 reviewInput 조립 전에 PR당 한 번만 조회한다. ACP 폴백이 같은 객체를
    //    재사용하므로 리뷰 루프 안에서 queryRunChain 을 반복하지 않는다.
    const lookupGoalAcceptance = deps.lookupPrGoalAcceptance ?? lookupPrGoalAcceptance;
    let goalAcceptance: PrGoalAcceptanceLookup = { goalLoaded: false, acceptanceChars: 0 };
    try {
      goalAcceptance = lookupGoalAcceptance(Number(pr));
    } catch {
      goalAcceptance = { goalLoaded: false, acceptanceChars: 0 };
    }
    startObservation({
      evidence: evidence.evidence, prDiffFiles: evidence.prDiffFiles,
      ...(evidence.authoredFiles !== undefined ? { authoredFiles: evidence.authoredFiles } : {}),
      ...(evidence.authoredBase ? { evidenceAuthoredBase: evidence.authoredBase } : {}),
      ...(evidence.authoredBaseKind ? { evidenceAuthoredBaseKind: evidence.authoredBaseKind } : {}),
      ...(evidence.skipped ? { evidenceSkipped: evidence.skipped } : {}),
      goalLoaded: goalAcceptance.goalLoaded,
      acceptanceChars: goalAcceptance.acceptanceChars,
    });
    // ⭐ `warning` 이 이미 행동 문구를 품는다(두 생성기가 같은 형상) — ⛔ 여기서 action 을 또 붙이면
    //    같은 문장이 두 번 나온다(리뷰 must-fix).
    if (mismatchWarning) deps.error(mismatchWarning.warning);
    // ⚠️ 「1차」라고 못 박는다 — 폴백은 이 줄 «뒤»에 일어난다. 그냥 model= 로 두면
    //    사용자가 이 줄에서 «최종» 리뷰 주체를 읽으려다 오해한다(리뷰 should-fix).
    if (!opts.json) deps.info(`[self-review] PR ${pr} · 1차 model=${primaryModel} · 리뷰 중…`);
    const provenance = {
      headCommit: diffRead.headCommit,
      currentHeadCommit: diffRead.currentHeadCommit,
      stale: diffRead.stale,
      refetched: diffRead.refetched,
      // ⭐ **증거의 결속 강도를 기계가 읽을 수 있게** 낸다 — 텍스트 provenance 와 같은 사실이지만
      //    `--json` 소비자(스크립트·상위 판정층)가 문자열을 파싱하지 않아도 되게 한다.
      //    ⛔ 폴백 사유는 **폴백했을 때만** 실린다(부재와 미지를 같은 값으로 두지 않는다).
      diffSource: diffRead.source,
      ...(diffRead.baseCommit ? { diffBaseCommit: diffRead.baseCommit } : {}),
      ...(diffRead.pinFallbackReason ? { diffPinFallbackReason: diffRead.pinFallbackReason } : {}),
      ...comparisonData,
      ...(mismatchWarning ?? {}),
    };
    if (diffRead.stale) {
      deps.log('done', { ...buildReviewObservation({
        pr, model: primaryModel, intent, review: null, durationMs: 0,
        ...intentTruncation,
        headCommit: diffRead.headCommit, headCommitState: diffRead.headCommitState,
        currentHeadCommit: diffRead.currentHeadCommit, currentHeadCommitState: diffRead.currentHeadCommitState,
        stale: true, refetched: diffRead.refetched,
      }), ...reviewerSourceObservation() }, { level: 'warn' });
      const contextOutput = reviewerContextOutput(reviewerContext, decompositionContext);
      const refused = {
        pr, model: primaryModel, verdict: null, mustFix: [], shouldFix: [], reviewed: false,
        refusal: 'stale-head', ...provenance, ...reviewerSourceObservation(), ...contextOutput,
      };
      if (opts.json) results.push(refused);
      else deps.print(`\n━━ PR ${pr} (${primaryModel}) ━━\n${renderStaleRefusal(diffRead)}\n${reviewerContextStatus}`);
      continue;
    }
    const startedAt = deps.now();
    // Role-config lane builds the API reviewer only when it falls back (`made().api` stays 0 on ACP success).
    const llmReview = roleReviewer ? undefined : (acpReviewLLM ?? deps.makeApiLlm(model));
    // ⛔ evidenceNote 는 **별도 채널**이다 — phaseIntent 에 섞으면 의도 채널이 오염된다(실측: 그렇게
    //   했다가 intent 배선 테스트 3개가 즉시 깨졌다).
    // ⛔ 사람 `--intent`(phaseIntent) 와 골 acceptance 는 다른 인자 — 충돌하지 않고, 충돌해도 intent 가 이긴다.
    const reviewInput = {
      prDiff: evidence.diff,
      phaseIntent: intent,
      evidenceNote: evidenceLine,
      ...(reviewerContext.items.length ? { reviewerContext: reviewerContext.items } : {}),
      ...(decompositionContext.runId ? { reviewContext: { runId: decompositionContext.runId } } : {}),
      ...(deps.readReferencedFile ? { readReferencedFile: deps.readReferencedFile } : {}),
      ...(goalAcceptance.acceptance ? { acceptance: goalAcceptance.acceptance } : {}),
    };
    // ⭐ Role-config ACP lane: a completed ACP review is used as-is; anything else (throw, reviewed≠true)
    //    falls to the same API review this command ran before the lane existed — and is observed.
    // ⚠️ Stricter than the harness lane on purpose: `runSubscriptionReviewer` accepts any non-empty text;
    //    here only a parsed, completed review (`reviewed === true`) is adopted, else the API review runs.
    let roleReview: ReviewResult | undefined;
    let roleReviewerFallbackReason = roleReviewerUnavailableReason;
    let roleReviewMs: number | undefined;
    if (roleReviewer) {
      const roleStartedAt = deps.now();
      try {
        const attempt = await deps.reviewPullRequest(reviewInput, roleReviewer.llm);
        if (attempt.reviewed === true) roleReview = attempt;
        // Code, not the reviewer's raw failure text (same rule as the throw path above).
        else roleReviewerFallbackReason = 'acp-review-not-completed';
      } catch (error) {
        roleReviewerFallbackReason = roleAcpErrorReason(error);
      }
      roleReviewMs = deps.now() - roleStartedAt;
      if (!roleReview) {
        deps.log('role-reviewer-fallback', {
          roleReviewMs,
          pr: safeLogText(pr), reviewerSource, roleReviewerProvider: opts.roleReviewer?.provider,
          stage: 'review', reason: roleReviewerFallbackReason ?? 'acp-review-not-completed', fallbackModel: safeLogText(model),
        }, { level: 'warn' });
      }
    }
    let review = roleReview ?? await deps.reviewPullRequest(reviewInput, llmReview ?? acpReviewLLM ?? deps.makeApiLlm(model));
    let selectedModel = roleReview && roleReviewer ? roleReviewer.model : model;
    let reviewRoute: 'api' | 'acp' | 'acp-fallback' = useAcp || roleReview ? 'acp' : 'api';
    let fallbackAttempted = false;
    let fallbackBackend: string | undefined;
    let fallbackTriggerReason: string | undefined;
    let fallbackNotAttemptedReason: 'explicit-acp' | 'primary-review-succeeded' | undefined;
    const fallbackFailures: Array<{ backend: string; reason: string }> = [];
    if (!useAcp && !roleReview && review.reviewed !== true) {
      fallbackAttempted = true;
      fallbackTriggerReason = safeLogText(review.failureReason || 'reviewed=false', 400);
      for (const backend of fallbackAcpBackends) {
        fallbackBackend = backend;
        deps.log('fallback-to-acp', {
          pr: safeLogText(pr),
          failureReason: fallbackTriggerReason,
          fallbackBackend: safeLogText(backend),
        }, { level: 'warn' });
        try {
          const fallbackReview = await deps.reviewPullRequest(
            reviewInput,
            deps.makeAcpLlm({ backend, timeoutMs: acpTimeoutSec * 1000 }),
          );
          if (fallbackReview.reviewed === true) {
            review = fallbackReview;
            selectedModel = `acp:${backend}`;
            reviewRoute = 'acp-fallback';
            break;
          }
          const reason = safeLogText(fallbackReview.failureReason || 'reviewed=false', 400);
          fallbackFailures.push({ backend, reason });
        } catch (error) {
          const reason = safeLogText(error instanceof Error ? error.message : String(error), 400);
          fallbackFailures.push({ backend, reason });
        }
      }
    }
    if (!fallbackAttempted) {
      fallbackNotAttemptedReason = useAcp ? 'explicit-acp' : 'primary-review-succeeded';
    }
    const reviewProvenance = {
      reviewRoute,
      fallbackAttempted,
      ...(fallbackBackend ? { fallbackBackend } : {}),
      ...(fallbackNotAttemptedReason ? { fallbackNotAttemptedReason } : {}),
      ...(fallbackTriggerReason ? { fallbackTriggerReason } : {}),
      ...(fallbackFailures.length ? { fallbackFailures } : {}),
      ...(skippedAcpFallbackBackends.length ? { skippedAcpFallbackBackends } : {}),
    };
    // ⚠️ `buildReviewObservation` drops unknown keys — the selection rides next to it, not inside it.
    const reviewerSelection = {
      ...reviewerSourceObservation(),
      ...(roleReviewerFallbackReason !== undefined ? { roleReviewerFallbackReason } : {}),
    };
    // ⚠️ verdict=fail 은 **정상 동작**(리뷰가 일한 것)이라 warn 으로 올리지 않는다. 대신 `reviewed:false`
    //    (fail-soft pass·리뷰 미실행)는 조용히 통과로 읽히면 위험하므로 warn 이다.
    deps.log('done',
      {
        ...buildReviewObservation({
          pr, model: selectedModel, intent, review, durationMs: deps.now() - startedAt,
          ...reviewProvenance,
          ...intentTruncation,
          ...reviewDiffBudgetObservation(review),
          ...(review.referencedFilesOpened !== undefined ? { referencedFilesOpened: review.referencedFilesOpened } : {}),
          ...(review.referencedFilesRead !== undefined ? { referencedFilesRead: review.referencedFilesRead } : {}),
          headCommit: diffRead.headCommit, headCommitState: diffRead.headCommitState,
          currentHeadCommit: diffRead.currentHeadCommit, currentHeadCommitState: diffRead.currentHeadCommitState,
          stale: diffRead.stale, refetched: diffRead.refetched,
        }),
        goalLoaded: goalAcceptance.goalLoaded,
        acceptanceChars: goalAcceptance.acceptanceChars,
        ...reviewerSelection,
      },
      { level: review.reviewed === false ? 'warn' : 'info' });
    // --acp 는 대표가 명시 요청한 리뷰 — fail-soft(reviewed=false)면 조용히 pass 하지 말고 표면화(관측=acp-review).
    if (useAcp && review.reviewed === false) {
      const err = 'ACP 리뷰 실행 실패(reviewed=false) — 관측: elanous logs --category acp-review';
      const contextOutput = reviewerContextOutput(reviewerContext, decompositionContext);
      if (opts.json) results.push({ pr, error: err, ...review, verdict: null, ...reviewProvenance, ...reviewerSelection, ...provenance, ...contextOutput });
      else deps.error(`PR ${pr}: ${err}\n${renderProvenance(diffRead)}\n${reviewerContextStatus}`);
      continue;
    }
    const contextOutput = reviewerContextOutput(reviewerContext, decompositionContext);
    const jsonReview = review.reviewed === true ? review : { ...review, verdict: null };
    if (opts.json) results.push({ pr, model: selectedModel, ...jsonReview, ...reviewProvenance, ...reviewerSelection, ...provenance, ...contextOutput, evidence: evidence.evidence, prDiffFiles: evidence.prDiffFiles, ...(evidence.authoredFiles !== undefined ? { authoredFiles: evidence.authoredFiles } : {}) });
    else deps.print(`\n━━ PR ${pr} (${selectedModel}) ━━\n${renderProvenance(diffRead)}\n${evidenceLine}\n${reviewerContextStatus}\n${deps.renderReview(review)}`);
  }
  return { results };
}
