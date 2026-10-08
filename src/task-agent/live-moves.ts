/**
 * TA-JUDGE-LIVE-SAFE — 판단부의 «안전한 수» 둘만 실제로 한다(10-07 승인 · 그 밖의 수는 그림자 그대로).
 *
 * - `review`: 수확 가능 런의 PR 에 elanous 리뷰를 «한 번» 요청한다 — PR 머리(sha)마다 한 번(카드 `reviewRequests` 이력).
 *   요청만 한다: 결과로 착지·재발사로 잇지 않는다(실행부 `executeNextAction` 의 review→land 사슬을 타지 않는다).
 * - `propose-green`: 카드에 green «제안»(`greenProposal`)만 적는다 — 체크리스트는 손대지 않는다.
 * - 설정 `taskAgent.liveMoves`(config > env `ELANOUS_TASK_AGENT_LIVE_MOVES` > 없음). 모르는 항목은 경고하고 버린다.
 * - 관측: 실행한 수마다 `debug.log('task-agent', 'live-move', {kind, card, ok, detail, live:true})`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { findGitDir } from '../git-fs/locate.js';
import { getUserConfig } from '../user-config.js';
import type { DetachedSpawn } from '../cli/tasks-cli.js';
import { taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';

export const TASK_AGENT_LIVE_MOVES = ['review', 'propose-green'] as const;
export type TaskAgentLiveMove = typeof TASK_AGENT_LIVE_MOVES[number];
export const TASK_AGENT_LIVE_MOVES_ENV = 'ELANOUS_TASK_AGENT_LIVE_MOVES';

export interface LiveMovesResolution { moves: ReadonlySet<TaskAgentLiveMove>; source: 'config' | 'env' | 'default'; ignored: string[] }

/** 설정 > 환경 > 없음. 모르는 항목은 허용으로 읽지 않는다 — 경고 관측만 남기고 버린다. */
export function resolveTaskAgentLiveMoves(
  configured: unknown,
  env: Record<string, string | undefined> = process.env,
  log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d, { level: 'warn' }),
): LiveMovesResolution {
  let raw: unknown[];
  let source: LiveMovesResolution['source'];
  if (configured !== undefined) { raw = Array.isArray(configured) ? configured : [configured]; source = 'config'; }
  else if (env[TASK_AGENT_LIVE_MOVES_ENV]?.trim()) { raw = env[TASK_AGENT_LIVE_MOVES_ENV]!.split(',').map((entry) => entry.trim()).filter(Boolean); source = 'env'; }
  else return { moves: new Set(), source: 'default', ignored: [] };
  const moves = new Set<TaskAgentLiveMove>();
  const ignored: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && (TASK_AGENT_LIVE_MOVES as readonly string[]).includes(entry)) moves.add(entry as TaskAgentLiveMove);
    else ignored.push(typeof entry === 'string' ? entry : JSON.stringify(entry));
  }
  if (ignored.length) {
    try { log('task-agent', 'live-moves-ignored', { ignored, source, allowed: [...TASK_AGENT_LIVE_MOVES] }); } catch { /* fail-soft */ }
  }
  return { moves, source, ignored };
}

/** 운영 설정에서 읽는다 — 읽기 실패는 «없음»(순수 그림자)이다. */
export async function configuredTaskAgentLiveMoves(): Promise<ReadonlySet<TaskAgentLiveMove>> {
  try {
    const { getUserConfig } = await import('../user-config.js');
    return resolveTaskAgentLiveMoves(getUserConfig().taskAgent?.liveMoves).moves;
  } catch { return new Set(); }
}

export interface LiveMoveDeps {
  statePath?: string;
  now?: () => Date;
  /** PR 머리 sha·상태(·브랜치·URL) — 시험은 주입한다. 기본은 `gh pr view`(작업 트리 cwd). */
  prHead?: (pr: number, cwd?: string) => Promise<PrHeadView | null>;
  /** TA-LIVE-REVIEW-POD — 작업 트리가 없는 런(Pod)의 리뷰 저장소 후보. 기본은 카드 project.target → harness.defaultRepo → 호스트 checkout. */
  repoCandidates?: (card: TaskCard) => readonly ReviewRepoCandidate[];
  /** 리뷰 요청(떼어 띄운다) — 시험은 반드시 주입한다. */
  requestReview?: (pr: number, intent: string, cwd?: string) => Promise<void>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

/** `executed` = 부작용을 실제로 냈다(리뷰를 띄웠다 · 제안을 적었다). ok 이지만 이미 한 수(같은 머리·이미 제안)면 false. */
export interface LiveMoveResult {
  kind: TaskAgentLiveMove; card: string | null; ok: boolean; executed: boolean; detail: string;
  /** TA-LIVE-REVIEW-POD — 작업 트리 없이 리뷰 저장소를 찾았을 때(또는 못 찾았을 때)의 근거 한 줄. */
  reviewRepo?: { resolved: boolean; source?: ReviewRepoCandidate['source']; cwd?: string; proof?: 'head-sha' | 'branch'; reason: string };
}

export interface PrHeadView { head: string; state: string; branch?: string; url?: string }

/** 리뷰 저장소 후보 — 과제를 넘길 때 카드가 안 대상 · 하니스 기본 저장소(harness.defaultRepo · harness.repo 의 로컬 뿌리) · 호스트 checkout. */
export interface ReviewRepoCandidate { source: 'card.project' | 'harness.defaultRepo' | 'host'; cwd: string }

/** 기본 후보 — 존재하는 디렉터리만 · 같은 경로는 한 번. 읽기 실패는 그 후보를 뺀다(없음 ≠ 통과). */
export function defaultReviewRepoCandidates(card: TaskCard, opts: { defaultRepo?: () => string | undefined; hostRoot?: () => string | undefined } = {}): ReviewRepoCandidate[] {
  const raw: ReviewRepoCandidate[] = [];
  if (card.project?.target && isAbsolute(card.project.target)) raw.push({ source: 'card.project', cwd: card.project.target });
  try {
    const configured = opts.defaultRepo ? opts.defaultRepo() : getUserConfig().harness?.defaultRepo;
    if (configured && isAbsolute(configured)) raw.push({ source: 'harness.defaultRepo', cwd: configured });
  } catch { /* 후보에서 뺀다 */ }
  try {
    const host = opts.hostRoot ? opts.hostRoot() : findGitDir(process.cwd())?.root;
    if (host) raw.push({ source: 'host', cwd: host });
  } catch { /* 후보에서 뺀다 */ }
  const seen = new Set<string>();
  const out: ReviewRepoCandidate[] = [];
  for (const candidate of raw) {
    if (!isAbsolute(candidate.cwd)) continue;
    const cwd = resolve(candidate.cwd);
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    try { if (statSync(cwd).isDirectory()) out.push({ source: candidate.source, cwd }); } catch { /* 없는 디렉터리는 뺀다 */ }
  }
  return out;
}

/**
 * TA-LIVE-REVIEW-POD — 작업 트리가 없을 때(Pod 런) 리뷰 cwd 를 정한다.
 * 후보 저장소에서 `gh pr view <pr>` 가 «런이 낸 머리»(기록된 sha · 없으면 런의 브랜치)를 돌려줄 때만 그 저장소를 쓴다 —
 * «다른 저장소에서 gh·self review 를 돌리지 않는다»(TA-JUDGE-LIVE-SAFE)는 계약을 지킨다. 못 정하면 이유 한 줄.
 */
export async function resolveReviewRepo(
  card: TaskCard, pr: number,
  produced: { headCommit?: string; branch?: string; prUrl?: string } | undefined,
  deps: LiveMoveDeps = {},
): Promise<{ resolved: true; cwd: string; source: ReviewRepoCandidate['source']; proof: 'head-sha' | 'branch'; view: PrHeadView; reason: string } | { resolved: false; reason: string }> {
  // 호출자가 런 근거를 «안 넘긴» 것과 런이 «기록하지 않은» 것은 다른 사실이다 — 섞어 적지 않는다.
  if (produced === undefined) return { resolved: false, reason: 'caller passed no run evidence (produced) — head/branch not checked' };
  // 기록된 머리가 «있으면» 그것만 근거다 — 모양이 틀린 sha 를 브랜치로 대체하지 않는다(확인 못 한 머리로 리뷰하지 않게).
  if (produced?.headCommit !== undefined && !/^[0-9a-f]{40}$/i.test(produced.headCommit)) {
    return { resolved: false, reason: `run head ${JSON.stringify(produced.headCommit.slice(0, 40))} is not a full commit sha` };
  }
  const expectedHead = produced?.headCommit?.toLowerCase();
  const expectedBranch = produced?.branch?.trim() || undefined;
  if (!expectedHead && !expectedBranch) return { resolved: false, reason: 'run result carries no PR head or branch to confirm against' };
  let candidates: readonly ReviewRepoCandidate[];
  try { candidates = (deps.repoCandidates ?? defaultReviewRepoCandidates)(card); } catch { candidates = []; }
  if (!candidates.length) return { resolved: false, reason: 'no target repository (card project · harness.defaultRepo · host checkout)' };
  const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
  const misses: string[] = [];
  for (const candidate of candidates) {
    let view: PrHeadView | null;
    try { view = await (deps.prHead ?? defaultPrHead)(pr, candidate.cwd); } catch { view = null; }
    if (!view) { misses.push(`${candidate.source}: PR #${pr} unreadable`); continue; }
    if (produced?.prUrl && view.url && !sameUrl(view.url, produced.prUrl)) { misses.push(`${candidate.source}: PR url ${view.url} ≠ run ${produced.prUrl}`); continue; }
    if (expectedHead) {
      if (view.head.toLowerCase() !== expectedHead) { misses.push(`${candidate.source}: head ${view.head.slice(0, 12)} ≠ run ${expectedHead.slice(0, 12)}`); continue; }
      return { resolved: true, cwd: candidate.cwd, source: candidate.source, proof: 'head-sha', view, reason: `${candidate.source} PR #${pr} head matches run` };
    }
    if (view.branch !== expectedBranch) { misses.push(`${candidate.source}: branch ${view.branch ?? '?'} ≠ run ${expectedBranch}`); continue; }
    // 브랜치 근거는 sha 보다 약하다 — 같은 PR(저장소 · 번호)임을 URL 로 «양쪽 다» 확인할 때만 쓴다.
    if (!produced?.prUrl || !view.url) { misses.push(`${candidate.source}: branch matches but PR url unconfirmed (run ${produced?.prUrl ?? 'none'} · repo ${view.url ?? 'none'})`); continue; }
    return { resolved: true, cwd: candidate.cwd, source: candidate.source, proof: 'branch', view, reason: `${candidate.source} PR #${pr} head branch matches run` };
  }
  return { resolved: false, reason: misses.join(' · ') };
}

/** 받은 환경 그대로 먼저 묻고, 실패하면 프록시만 뺀 환경으로 한 번 더(이 저장소의 gh 운영 관행 — 프록시 경유가 gh 를 깨는 호스트). */
export type GhRun = (args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => { status: number | null; stdout: string };
const runGh: GhRun = (args, options) => spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) });

export async function defaultPrHead(pr: number, cwd?: string, gh: GhRun = runGh): Promise<PrHeadView | null> {
  const view = (env: NodeJS.ProcessEnv) => gh(['pr', 'view', String(pr), '--json', 'headRefOid,headRefName,state,url'], { env, ...(cwd ? { cwd } : {}) });
  let out = view(process.env);
  if (out.status !== 0) {
    const noProxy = { ...process.env };
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete noProxy[key];
    out = view(noProxy);
  }
  if (out.status !== 0) return null;
  try {
    const value = JSON.parse(out.stdout) as { headRefOid?: unknown; headRefName?: unknown; state?: unknown; url?: unknown };
    return typeof value.headRefOid === 'string' && /^[a-f0-9]{40}$/i.test(value.headRefOid) && typeof value.state === 'string'
      ? {
        head: value.headRefOid, state: value.state,
        ...(typeof value.headRefName === 'string' && value.headRefName ? { branch: value.headRefName } : {}),
        ...(typeof value.url === 'string' && value.url ? { url: value.url } : {}),
      } : null;
  } catch { return null; }
}

/** 리뷰 요청 argv — 진입점 · 같은 우주(`--config-dir`) · `self review <PR> --json --intent`. */
export function liveReviewArgs(entry: string, configDir: string, pr: number, intent: string): string[] {
  return [resolve(entry), '--config-dir', configDir, 'self', 'review', String(pr), '--json', '--intent', intent];
}

/**
 * 지금 도는 진입점으로 같은 우주의 리뷰를 떼어 띄운다 — 기다리지 않는다(결과는 self review 자기 관측에 남는다).
 * `opts` 는 시험 몫(spawn·진입점·우주) — 기본은 실물.
 */
export async function defaultRequestReview(pr: number, intent: string, cwd?: string, opts: { spawn?: DetachedSpawn; entry?: string; configDir?: string } = {}): Promise<void> {
  const { spawnDetachedConfirmed, ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const configDir = opts.configDir ?? getElanousConfigDirOverride() ?? effectiveInstanceRoot();
  await spawnDetachedConfirmed(opts.spawn ?? (spawn as unknown as DetachedSpawn), process.execPath, liveReviewArgs(opts.entry ?? ELANOUS_CLI_ENTRY, configDir, pr, intent), undefined, cwd);
}

export function liveReviewIntent(card: TaskCard, runId: string | null, stopReason: string): string {
  const goal = card.text.split('\n')[0]!.trim().slice(0, 300);
  return [
    `목표: ${goal}`,
    `수용기준: 과제 카드 ${card.id} 원문 —\n${card.text.trim().slice(0, 4000)}`,
    `직전 반영분: 런 ${runId ?? '-'} 이 ${stopReason} 로 멈춤 — 수확 가능`,
    '의도적 범위 경계: task-agent live review 요청(TA-JUDGE-LIVE-SAFE) — 리뷰만 한다 · 착지·재발사는 이 요청의 결정이 아니다',
  ].join('\n');
}

/** 실행한 수를 관측에 남긴다(`live-move`). */
function observe(deps: LiveMoveDeps, result: LiveMoveResult): LiveMoveResult {
  try { (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', 'live-move', { ...result, live: true }); } catch { /* fail-soft */ }
  return result;
}

/**
 * 단위는 «관측한 머리»다 — `self review` 에 머리 고정 인자가 없어, 관측~리뷰 시작 사이에 머리가 바뀌면 새 머리가
 * 다음 틱에 한 번 더 요청될 수 있다(초과는 많아야 한 번 · 리뷰는 읽기 전용이라 착지·재발사로 번지지 않는다).
 */
/** `review` — PR 머리마다 한 번. 카드에 먼저 적고(잠금 안) 그다음 띄운다 · 띄우기 실패는 카드에 오류로 남기고 같은 머리는 다시 안 띄운다. */
export async function executeLiveReview(
  card: TaskCard | undefined, pr: number | undefined,
  ctx: { runId: string | null; stopReason: string; cwd?: string; produced?: { headCommit?: string; branch?: string; prUrl?: string } },
  deps: LiveMoveDeps = {},
): Promise<LiveMoveResult> {
  const kind = 'review' as const;
  if (!card) return observe(deps, { kind, executed: false, card: null, ok: false, detail: 'no task card — stays shadow' });
  if (!pr || !Number.isSafeInteger(pr) || pr < 1) return observe(deps, { kind, executed: false, card: card.id, ok: false, detail: 'no PR — stays shadow' });
  // PR 의 저장소를 모르면 보류한다 — 다른 저장소에서 gh·self review 를 돌리지 않게. 작업 트리가 없으면(Pod 런 ·
  // TA-LIVE-REVIEW-POD) 후보 저장소 중 «런이 낸 PR 머리»가 확인되는 곳만 쓰고, 못 정하면 이유 한 줄을 관측에 싣는다.
  let cwd = ctx.cwd;
  let head: PrHeadView | null = null;
  let reviewRepo: LiveMoveResult['reviewRepo'];
  if (!cwd) {
    const found = await resolveReviewRepo(card, pr, ctx.produced, deps);
    if (!found.resolved) {
      return observe(deps, { kind, executed: false, card: card.id, ok: false, detail: `PR #${pr} worktree unknown — stays shadow`, reviewRepo: { resolved: false, reason: found.reason } });
    }
    cwd = found.cwd;
    head = found.view;
    reviewRepo = { resolved: true, source: found.source, cwd: found.cwd, proof: found.proof, reason: found.reason };
  } else {
    try { head = await (deps.prHead ?? defaultPrHead)(pr, cwd); } catch { head = null; }
  }
  const withRepo = (result: LiveMoveResult): LiveMoveResult => reviewRepo ? { ...result, reviewRepo } : result;
  if (!head) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: `PR #${pr} head unknown` }));
  if (head.state !== 'OPEN') return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: `PR #${pr} is ${head.state}` }));
  const path = deps.statePath ?? taskAgentStatePath();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const claim = { claimed: false, missing: false };
  updateTaskCard(path, card.id, (current) => {
    if (!current) { claim.missing = true; return undefined; }
    // 머리 «이력»으로 본다 — A→B→A 로 돌아와도 A 는 다시 요청하지 않는다.
    if ((current.reviewRequests ?? []).some((entry) => entry.pr === pr && entry.head === head!.head)) return undefined;
    claim.claimed = true;
    return { ...current, reviewRequests: [...(current.reviewRequests ?? []), { pr, head: head!.head, at }] };
  });
  if (claim.missing) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: 'task card not in state file' }));
  if (!claim.claimed) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: true, detail: `already requested for #${pr} head ${head.head.slice(0, 12)}` }));
  try {
    await (deps.requestReview ?? defaultRequestReview)(pr, liveReviewIntent(card, ctx.runId, ctx.stopReason), cwd);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateTaskCard(path, card.id, (current) => current?.reviewRequests?.some((entry) => entry.pr === pr && entry.head === head!.head && entry.at === at)
      ? { ...current, reviewRequests: current.reviewRequests.map((entry) => entry.pr === pr && entry.head === head!.head && entry.at === at ? { ...entry, error: reason } : entry) }
      : undefined);
    return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: `review request failed for #${pr} head ${head.head.slice(0, 12)}: ${reason}` }));
  }
  return observe(deps, withRepo({ kind, executed: true, card: card.id, ok: true, detail: `review requested for #${pr} head ${head.head.slice(0, 12)}` }));
}

/** `propose-green` — 비지 않은 근거가 있을 때만 카드에 제안을 적는다(한 번). 체크리스트는 쓰지 않는다. */
export function executeLiveGreenProposal(card: TaskCard | undefined, evidence: Record<string, string>, deps: LiveMoveDeps = {}): LiveMoveResult {
  const kind = 'propose-green' as const;
  if (!card) return observe(deps, { kind, executed: false, card: null, ok: false, detail: 'no task card — stays shadow' });
  const refs = Object.fromEntries(Object.entries(evidence).filter(([, ref]) => typeof ref === 'string' && ref.trim()));
  if (!Object.keys(refs).length) return observe(deps, { kind, executed: false, card: card.id, ok: false, detail: 'no evidence ref — not proposed' });
  const path = deps.statePath ?? taskAgentStatePath();
  const proposal = { at: (deps.now ?? (() => new Date()))().toISOString(), checklistId: card.checklistId ?? null, evidence: refs };
  const wrote = { proposed: false, missing: false };
  updateTaskCard(path, card.id, (current) => {
    if (!current) { wrote.missing = true; return undefined; }
    if (current.greenProposal) return undefined;
    wrote.proposed = true;
    return { ...current, greenProposal: proposal };
  });
  if (wrote.missing) return observe(deps, { kind, executed: false, card: card.id, ok: false, detail: 'task card not in state file' });
  if (!wrote.proposed) return observe(deps, { kind, executed: false, card: card.id, ok: true, detail: 'already proposed' });
  return observe(deps, { kind, executed: true, card: card.id, ok: true, detail: `green proposed (${Object.values(refs).join(', ')}) · checklist untouched` });
}
