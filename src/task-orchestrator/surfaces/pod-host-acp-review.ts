// REVIEW-ACP-POD (0.2.25 · REVIEW-ACP-DEFAULT ② 조각) — Pod 런이 낸 merge-ready PR 을 «호스트»가 Claude ACP(구독)로 다시 본다.
//
// S  Pod 안 하니스 리뷰는 api 리뷰어(codex 기본 gpt-6-sol · OR Pod 는 glm 고정)로 돈다 — Pod 엔 Claude 구독도 정책 파일도 없어
//    `roleLlm.reviewer = claude-acp`(운영에 이미 켜져 있다)가 Pod 안에선 «안 닿는다». 호스트 레인 런만 ACP 로 리뷰받는다.
// C  Pod 가 호스트로 돌려보내는 유일한 문은 merge-ready → 호스트 재게이트 → 병합이다. 여기에 리뷰가 없다.
// Q  Pod 런의 리뷰를 구독(ACP)으로 옮기려면 어디서 하나?
// A  호스트 병합 직전 한 자리에서, 하니스 레인과 «같은» 정책 행(`resolveSubscriptionReviewer`)·같은 가용성 검사
//    (`subscriptionReviewerAvailability` — 구독 확인 · 상한 · 프록시)·같은 ACP 리뷰어(`makeAcpReviewLLM`)로 PR 을 본다.
//    ⛔ 못 쓰면(설정 없음·구독 확인 실패·상한·프록시 없음·리뷰 미완) «refused» 로 돌려주고 호출자는 종전 길(Pod 리뷰 결과로 재게이트)을 그대로 간다.
//       조용히 다른 공급자로 새지 않는다 — 이 함수 안엔 api 폴백이 «없다».
//    ⛔ 기본 꺼짐(opt-in): 옵션 → env `ELANOUS_POD_HOST_ACP_REVIEW` → config `llm.podHostAcpReview` 순.
//    📌 남은 조각(②-b): 이 문이 켜진 런에서 Pod 안 api 리뷰를 «끄는» 것은 Pod 이미지 쪽 변경이라 따로 간다.
import { spawnSync } from 'node:child_process';
import { debug } from '../../debug/log.js';
import type { ReviewResult } from '../../agent-substrate/pr-reviewer.js';
import type { SubscriptionReviewerSpec } from '../../user-config.js';
import type { SubscriptionReviewerDeps, subscriptionReviewerSpawn } from '../../self-dev/review-provider-fallback.js';

export const POD_HOST_ACP_REVIEW_ENV = 'ELANOUS_POD_HOST_ACP_REVIEW';

export type PodHostAcpReviewEnable = { enabled: boolean; source: 'option' | 'env' | 'config' | 'default' };

/** 켜는 순서: 옵션 → env(`1`/`true` 켬 · `0`/`false` 끔) → config `llm.podHostAcpReview === true` → 꺼짐. 읽기 실패는 꺼짐(종전). */
export function resolvePodHostAcpReview(
  option: boolean | undefined,
  env: NodeJS.ProcessEnv,
  readConfig: () => unknown,
): PodHostAcpReviewEnable {
  if (typeof option === 'boolean') return { enabled: option, source: 'option' };
  const raw = env[POD_HOST_ACP_REVIEW_ENV]?.trim().toLowerCase();
  if (raw === '1' || raw === 'true') return { enabled: true, source: 'env' };
  if (raw === '0' || raw === 'false') return { enabled: false, source: 'env' };
  try {
    const cfg = readConfig() as { llm?: { podHostAcpReview?: unknown } } | undefined;
    if (cfg?.llm?.podHostAcpReview === true) return { enabled: true, source: 'config' };
  } catch { /* 읽기 실패 = 꺼짐(종전 길) */ }
  return { enabled: false, source: 'default' };
}

export type PodHostAcpReviewOutcome =
  | { status: 'clean'; mustFix: 0; shouldFix: number }
  | { status: 'must-fix'; mustFix: number; findings: string[]; verdict: ReviewResult['verdict'] }
  | { status: 'refused'; reason: string };

export interface PodHostAcpReviewDeps {
  /** `{ spec, cap }` — 기본은 하니스 레인과 같은 정책 행(`resolveSubscriptionReviewer`). */
  resolveReviewer?: () => { spec: SubscriptionReviewerSpec; cap: number } | undefined;
  /** 구독·상한·프록시 확인 — 기본은 `subscriptionReviewerAvailability`. */
  availability?: (spec: SubscriptionReviewerSpec, cap: number) => { spawn?: ReturnType<typeof subscriptionReviewerSpawn>; reason?: string };
  subscriptionReviewerDeps?: SubscriptionReviewerDeps;
  /** PR 머리 sha·제목·본문·diff. 기본은 `gh`. */
  readPr?: (prNumber: number, repoRoot: string) => { headRefOid: string; title: string; body: string; diff: string } | undefined;
  /** ACP 리뷰어(prompt→text). 기본은 `makeAcpReviewLLM({ backend: 'claude', backendSpec, env })`. */
  makeAcpReviewLLM?: (spawn: ReturnType<typeof subscriptionReviewerSpawn>, repoRoot: string) => (prompt: string) => Promise<string>;
  reviewPullRequest?: (input: { prDiff: string; phaseIntent: string }, llm: (prompt: string) => Promise<string>) => Promise<ReviewResult>;
  env?: NodeJS.ProcessEnv;
}

function defaultReadPr(prNumber: number, repoRoot: string): { headRefOid: string; title: string; body: string; diff: string } | undefined {
  const view = spawnSync('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid,title,body'], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
  if (view.status !== 0) return undefined;
  const diff = spawnSync('gh', ['pr', 'diff', String(prNumber)], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(view.stdout) as { headRefOid?: unknown; title?: unknown; body?: unknown };
    if (typeof parsed.headRefOid !== 'string') return undefined;
    return { headRefOid: parsed.headRefOid, title: typeof parsed.title === 'string' ? parsed.title : '', body: typeof parsed.body === 'string' ? parsed.body : '', diff: diff.stdout };
  } catch { return undefined; }
}

function refused(reason: string, data: Record<string, unknown>): PodHostAcpReviewOutcome {
  try { debug.log('self-implement.pod', 'acp-review-refused', { ...data, reason }, { level: 'warn' }); } catch { /* 관측은 결과를 안 바꾼다 */ }
  return { status: 'refused', reason };
}

/** Pod merge-ready PR 을 호스트 Claude ACP 로 리뷰한다. ⛔ 던지지 않는다 — 모든 실패는 `refused`(호출자는 종전 길). */
export async function runPodHostAcpReview(
  input: { prNumber: number; headCommit: string; repoRoot: string; job?: string },
  deps: PodHostAcpReviewDeps = {},
): Promise<PodHostAcpReviewOutcome> {
  const obs = { job: input.job ?? null, pr: input.prNumber, head: input.headCommit };
  try {
    const env = deps.env ?? process.env;
    // 지연 import — 이 문이 꺼진 런은 정책·설정을 안 읽는다.
    const picked = deps.resolveReviewer ? deps.resolveReviewer() : await (async () => {
      const { loadLlmPolicy, resolveSubscriptionReviewer } = await import('../../policy/llm-policy.js');
      const { getUserConfig } = await import('../../user-config.js');
      return resolveSubscriptionReviewer(loadLlmPolicy(), getUserConfig().roleLlm);
    })();
    if (!picked) return refused('no-subscription-reviewer', obs);
    const avail = deps.availability
      ? deps.availability(picked.spec, picked.cap)
      : (await import('../../self-dev/review-provider-fallback.js')).subscriptionReviewerAvailability(picked.spec, picked.cap, env, deps.subscriptionReviewerDeps);
    if (!avail.spawn) return refused(`unavailable: ${avail.reason ?? 'unknown'}`, { ...obs, cap: picked.cap });
    const pr = (deps.readPr ?? defaultReadPr)(input.prNumber, input.repoRoot);
    if (!pr) return refused('pr-unreadable', obs);
    if (pr.headRefOid.toLowerCase() !== input.headCommit.toLowerCase()) return refused('head-moved', { ...obs, prHead: pr.headRefOid });
    if (!pr.diff.trim()) return refused('empty-diff', obs);
    const llm = deps.makeAcpReviewLLM
      ? deps.makeAcpReviewLLM(avail.spawn, input.repoRoot)
      : await (async () => {
        const { makeAcpReviewLLM } = await import('../../agent-substrate/acp-reviewer.js');
        const spawn = avail.spawn!;
        return makeAcpReviewLLM({ cwd: input.repoRoot, backend: 'claude', backendSpec: spawn.backendSpec, env: spawn.env });
      })();
    const review = deps.reviewPullRequest ?? (await import('../../agent-substrate/pr-reviewer.js')).reviewPullRequest;
    const phaseIntent = [`Pod 런 PR #${input.prNumber} 의 호스트 Claude ACP 리뷰(병합 전 관문).`, pr.title, pr.body.slice(0, 4000)].filter((s) => s.trim()).join('\n\n');
    const rr = await review({ prDiff: pr.diff, phaseIntent }, llm);
    // ⛔ reviewed=false(파싱 실패·ACP 오류를 리뷰어가 흡수) 는 «리뷰 완료»가 아니다 — 통과로 읽지 않는다.
    if (!rr.reviewed) return refused('acp-review-not-completed', obs);
    const mustFix = rr.mustFix.length;
    if (rr.verdict === 'fail' || mustFix > 0) {
      debug.log('self-implement.pod', 'host-acp-review', { ...obs, status: 'must-fix', verdict: rr.verdict, mustFix, shouldFix: rr.shouldFix.length });
      return { status: 'must-fix', mustFix, findings: rr.mustFix.slice(0, 10), verdict: rr.verdict };
    }
    debug.log('self-implement.pod', 'host-acp-review', { ...obs, status: 'clean', verdict: rr.verdict, mustFix: 0, shouldFix: rr.shouldFix.length });
    return { status: 'clean', mustFix: 0, shouldFix: rr.shouldFix.length };
  } catch (error) {
    // 원문은 싣지 않는다 — 계정·프록시 문면이 섞일 수 있다(하니스 레인과 같은 규율).
    return refused(/handshake timeout/i.test(error instanceof Error ? error.message : String(error)) ? 'acp-handshake-timeout' : 'acp-error', obs);
  }
}
