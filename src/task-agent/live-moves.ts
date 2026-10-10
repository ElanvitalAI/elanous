/**
 * TA-JUDGE-LIVE-SAFE — 설정에서 명시한 review · propose-green · propose-land 만 실제로 한다.
 *
 * - `review`: 수확 가능 런의 PR 에 elanous 리뷰를 «한 번» 요청한다 — PR 머리(sha)마다 한 번(카드 `reviewRequests` 이력).
 *   요청만 한다: 결과로 착지·재발사로 잇지 않는다(실행부 `executeNextAction` 의 review→land 사슬을 타지 않는다).
 *   TA-REVIEW-RESULT-CAPTURE — 자식 stdout(`--json`)은 결과 파일로 받고, 회수(`review-result-capture.ts`)는 «다음» 판단 틱이 한다 —
 *   회수한 pass 는 그 틱의 판단부·land 관문 입력(`selfReview`)이 될 뿐 land 판정 로직은 그대로다.
 * - `propose-green`: 카드에 green «제안»(`greenProposal`)만 적는다 — 체크리스트는 손대지 않는다.
 * - `propose-land`: 카드·현재 머리의 self review 통과(pass «또는» warn ⊕ must-fix 0 · TA-LAND-WARN-MUSTFIX0)·non-draft 를 확인하고 기존 `pr land` 를 머리 고정으로 한 번 부른다.
 * - 설정 `taskAgent.liveMoves`(config > env `ELANOUS_TASK_AGENT_LIVE_MOVES` > 없음). 모르는 항목은 경고하고 버린다.
 * - 관측: 실행한 수마다 `debug.log('task-agent', 'live-move', {kind, card, ok, detail, live:true})`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { findGitDir } from '../git-fs/locate.js';
import { getUserConfig } from '../user-config.js';
import type { DetachedSpawn } from '../cli/tasks-cli.js';
import { taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';
import { reviewResultPath } from './review-result-capture.js';
import { createLandWorktree, localHead, observeLandWorktree, type LandWorktree, type LandWorktreeFailure, type LandWorktreeInput, type LandWorktreeRemoval } from './land-worktree.js';

export const TASK_AGENT_LIVE_MOVES = ['review', 'propose-green', 'propose-land'] as const;
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
  /**
   * 리뷰 요청(떼어 띄운다) — 시험은 반드시 주입한다.
   * TA-REVIEW-RESULT-CAPTURE — `capture.resultPath` 가 오면 자식 `--json` stdout 을 그 파일로 받는다(회수 = `review-result-capture.ts`).
   */
  requestReview?: (pr: number, intent: string, cwd?: string, capture?: { resultPath: string }) => Promise<void>;
  /** Fresh PR head and draft flag for landing; separate from the unchanged review lookup. */
  landPrHead?: (pr: number, cwd: string) => Promise<(PrHeadView & { isDraft: boolean }) | null>;
  /** One existing pr land operation; inject in tests instead of invoking the CLI. */
  /** TA-REJUDGE-ON-HEAD — `opts.overlapEvidence` 가 있으면 `pr land --overlap-evidence <file>` 로 넘긴다(없으면 종전 인자). */
  land?: (pr: number, head: string, cwd: string, opts?: { overlapEvidence?: string }) => Promise<{ status: number; stdout: string; stderr?: string }>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** TA-LAND-WORKTREE — cwd HEAD 읽기 · PR 머리 임시 워크트리 만들기(시험 주입 · 기본 = git). */
  landWorktree?: { localHead?: (cwd: string) => string | null; create?: (input: LandWorktreeInput) => Promise<LandWorktree | LandWorktreeFailure> };
}

/** `executed` = 부작용을 실제로 냈다(리뷰를 띄웠다 · 제안을 적었다). ok 이지만 이미 한 수(같은 머리·이미 제안)면 false. */
export interface LiveMoveResult {
  kind: TaskAgentLiveMove | 'land'; card: string | null; ok: boolean; executed: boolean; detail: string;
  /** TA-LIVE-REVIEW-POD — 작업 트리 없이 리뷰 저장소를 찾았을 때(또는 못 찾았을 때)의 근거 한 줄. */
  reviewRepo?: { resolved: boolean; source?: ReviewRepoCandidate['source']; cwd?: string; proof?: 'head-sha' | 'branch'; reason: string };
  /** TA-REVIEW-RESULT-CAPTURE — 띄운 review 의 결과 파일(자식 stdout) — 실행한 review 에만 실린다. */
  resultPath?: string;
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
 * TA-REVIEW-RESULT-CAPTURE — `resultPath` 가 있으면 자식 stdout(`--json` 결과)만 그 파일로 받는다(stdin·stderr 는 종전대로 버린다 ·
 * 파이프가 아니라 파일 — 부모가 먼저 끝나도 자식이 EPIPE 로 죽지 않는다). 없으면 종전과 같다(stdio ignore).
 * `opts` 는 시험 몫(spawn·진입점·우주) — 기본은 실물.
 */
export async function defaultRequestReview(pr: number, intent: string, cwd?: string, opts: { spawn?: DetachedSpawn; entry?: string; configDir?: string; resultPath?: string } = {}): Promise<void> {
  const { spawnDetachedConfirmed, ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const configDir = opts.configDir ?? getElanousConfigDirOverride() ?? effectiveInstanceRoot();
  const base = opts.spawn ?? (spawn as unknown as DetachedSpawn);
  const args = liveReviewArgs(opts.entry ?? ELANOUS_CLI_ENTRY, configDir, pr, intent);
  if (!opts.resultPath) { await spawnDetachedConfirmed(base, process.execPath, args, undefined, cwd); return; }
  let fd: number;
  try {
    mkdirSync(dirname(opts.resultPath), { recursive: true });
    fd = openSync(opts.resultPath, 'w');
  } catch (error) {
    // 결과 파일을 못 열어도 리뷰는 막지 않는다(종전처럼 stdio ignore) — 회수는 상한 뒤 «no result» 줄로 드러난다.
    try { debug.log('task-agent', 'review-result-file-open-failed', { pr, resultPath: opts.resultPath, reason: (error instanceof Error ? error.message : String(error)).slice(-300) }, { level: 'warn' }); } catch { /* fail-soft */ }
    await spawnDetachedConfirmed(base, process.execPath, args, undefined, cwd);
    return;
  }
  const toFile: DetachedSpawn = (command, spawnArgs, options) =>
    (base as unknown as (c: string, a: string[], o: unknown) => ReturnType<DetachedSpawn>)(command, spawnArgs, { ...options, stdio: ['ignore', fd, 'ignore'] });
  try {
    await spawnDetachedConfirmed(toFile, process.execPath, args, undefined, cwd);
  } finally {
    try { closeSync(fd); } catch { /* the child keeps its own copy */ }
  }
}

export function liveLandArgs(entry: string, configDir: string, pr: number, head: string, cwd: string, overlapEvidence?: string): string[] {
  return [resolve(entry), '--config-dir', configDir, 'pr', 'land', '--cwd', cwd, '--pr', String(pr), '--expected-head', head,
    // TA-REJUDGE-ON-HEAD — 겹침 관문의 비대화형 증거(#26023) · 없으면 종전 인자 그대로.
    ...(overlapEvidence ? ['--overlap-evidence', overlapEvidence] : [])];
}

/** The CLI owns the freeze, gate and merge checks; no direct gh merge or bypass flags. */
export async function defaultLand(pr: number, head: string, cwd: string, opts: { overlapEvidence?: string } = {}): Promise<{ status: number; stdout: string; stderr?: string }> {
  const { ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const args = liveLandArgs(ELANOUS_CLI_ENTRY, getElanousConfigDirOverride() ?? effectiveInstanceRoot(), pr, head, cwd, opts.overlapEvidence);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-300); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-300); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) { resolveResult({ status: code ?? 1, stdout, stderr }); return; }
      void defaultLandPrHead(pr, cwd).then((view) => {
        resolveResult(view?.state === 'MERGED'
          ? { status: 0, stdout, stderr }
          : { status: 1, stdout, stderr: (stderr || stdout || 'landing completed without confirmed merge').slice(-300) });
      }).catch((error) => resolveResult({ status: 1, stdout, stderr: String(error).slice(-300) }));
    });
  });
}

export async function defaultLandPrHead(pr: number, cwd: string): Promise<(PrHeadView & { isDraft: boolean }) | null> {
  const view = (env: NodeJS.ProcessEnv) => runGh(['pr', 'view', String(pr), '--json', 'headRefOid,headRefName,state,url,isDraft'], { env, cwd });
  let out = view(process.env);
  if (out.status !== 0) {
    const noProxy = { ...process.env };
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete noProxy[key];
    out = view(noProxy);
  }
  if (out.status !== 0) return null;
  try {
    const value = JSON.parse(out.stdout) as { headRefOid?: unknown; headRefName?: unknown; state?: unknown; url?: unknown; isDraft?: unknown };
    if (typeof value.headRefOid !== 'string' || !/^[a-f0-9]{40}$/i.test(value.headRefOid) || typeof value.state !== 'string' || typeof value.isDraft !== 'boolean') return null;
    return { head: value.headRefOid, state: value.state, isDraft: value.isDraft,
      ...(typeof value.headRefName === 'string' ? { branch: value.headRefName } : {}),
      ...(typeof value.url === 'string' ? { url: value.url } : {}) };
  } catch { return null; }
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
  // TA-REVIEW-RESULT-CAPTURE — 머리마다 한 번이라 경로도 머리마다 하나다. 요청 칸에 먼저 적는다(회수가 이 칸을 본다).
  const resultPath = reviewResultPath(path, card.id, pr, head.head);
  const claim = { claimed: false, missing: false };
  updateTaskCard(path, card.id, (current) => {
    if (!current) { claim.missing = true; return undefined; }
    // 머리 «이력»으로 본다 — A→B→A 로 돌아와도 A 는 다시 요청하지 않는다.
    if ((current.reviewRequests ?? []).some((entry) => entry.pr === pr && entry.head === head!.head)) return undefined;
    claim.claimed = true;
    return { ...current, reviewRequests: [...(current.reviewRequests ?? []), { pr, head: head!.head, at, resultPath }] };
  });
  if (claim.missing) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: 'task card not in state file' }));
  if (!claim.claimed) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: true, detail: `already requested for #${pr} head ${head.head.slice(0, 12)}` }));
  try {
    const intent = liveReviewIntent(card, ctx.runId, ctx.stopReason);
    await (deps.requestReview ? deps.requestReview(pr, intent, cwd, { resultPath }) : defaultRequestReview(pr, intent, cwd, { resultPath }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateTaskCard(path, card.id, (current) => current?.reviewRequests?.some((entry) => entry.pr === pr && entry.head === head!.head && entry.at === at)
      ? { ...current, reviewRequests: current.reviewRequests.map((entry) => entry.pr === pr && entry.head === head!.head && entry.at === at ? { ...entry, error: reason } : entry) }
      : undefined);
    return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: `review request failed for #${pr} head ${head.head.slice(0, 12)}: ${reason}` }));
  }
  return observe(deps, withRepo({ kind, executed: true, card: card.id, ok: true, detail: `review requested for #${pr} head ${head.head.slice(0, 12)}`, resultPath }));
}

const landedCycles = new Set<string>();

/** `propose-land` — only a passing self review (pass or warn, with must-fix 0) of this exact OPEN, non-draft head may invoke pr land. */
export async function executeLiveLand(
  card: TaskCard | undefined, pr: number | undefined,
  ctx: { runId?: string | null; cycleId?: string; cwd?: string; produced?: { headCommit?: string; branch?: string; prUrl?: string }; review?: { verdict: 'pass' | 'warn' | 'fail'; head: string; /** TA-LAND-WARN-MUSTFIX0 — `false` 면 리뷰가 실제로 안 돌았다 → land 거부. 슈퍼바이저 입력은 reviewed 리뷰로만 만들어져 칸이 없다. */ reviewed?: boolean };
    /** TA-REJUDGE-ON-HEAD — 겹침 증거 파일(있으면 land 에 넘길 뿐 · 판정은 그대로). */ overlapEvidence?: string },
  deps: LiveMoveDeps = {},
): Promise<LiveMoveResult> {
  const kind = 'land' as const;
  const reject = (cardId: string | null, detail: string, reviewRepo?: LiveMoveResult['reviewRepo']) =>
    observe(deps, { kind, card: cardId, ok: false, executed: false, detail, ...(reviewRepo ? { reviewRepo } : {}) });
  if (!card) return reject(null, 'no task card — stays shadow');
  if (!pr || !Number.isSafeInteger(pr) || pr < 1) return reject(card.id, 'no PR — stays shadow');
  let cwd = ctx.cwd;
  let reviewRepo: LiveMoveResult['reviewRepo'];
  if (!cwd) {
    const found = await resolveReviewRepo(card, pr, ctx.produced, deps);
    if (!found.resolved) return reject(card.id, `PR #${pr} worktree unknown — stays shadow`, { resolved: false, reason: found.reason });
    cwd = found.cwd;
    reviewRepo = { resolved: true, source: found.source, cwd, proof: found.proof, reason: found.reason };
  }
  const withRepo = (result: LiveMoveResult): LiveMoveResult => reviewRepo ? { ...result, reviewRepo } : result;
  let view: (PrHeadView & { isDraft: boolean }) | null;
  try { view = await (deps.landPrHead ?? defaultLandPrHead)(pr, cwd); } catch { view = null; }
  if (!view || !/^[0-9a-f]{40}$/i.test(view.head)) return reject(card.id, `PR #${pr} head unknown`, reviewRepo);
  if (view.state !== 'OPEN') return reject(card.id, `PR #${pr} is ${view.state}`, reviewRepo);
  if (view.isDraft !== false) return reject(card.id, `PR #${pr} is draft or draft status unknown`, reviewRepo);
  if (ctx.produced?.prUrl && (!view.url || view.url.trim().replace(/\/+$/, '').toLowerCase() !== ctx.produced.prUrl.trim().replace(/\/+$/, '').toLowerCase())) {
    return reject(card.id, `PR #${pr} URL mismatches run evidence`, reviewRepo);
  }
  // TA-LAND-WARN-MUSTFIX0 — 정본 규칙(#25941 canAuto · #25962): pass «또는» warn 이 통과 후보 · must-fix 0 은 바로 아래 검사가 본다.
  if (ctx.review?.verdict !== 'pass' && ctx.review?.verdict !== 'warn') return reject(card.id, `PR #${pr} self review pass missing`, reviewRepo);
  if (ctx.review.reviewed === false) return reject(card.id, `PR #${pr} self review not reviewed (reviewed:false)`, reviewRepo);
  if (!/^[0-9a-f]{40}$/i.test(ctx.review.head) || ctx.review.head.toLowerCase() !== view.head.toLowerCase()) {
    return reject(card.id, `PR #${pr} review head mismatch: ${ctx.review.head.slice(0, 12)} ≠ ${view.head.slice(0, 12)}`, reviewRepo);
  }
  // TA-LAND-MUSTFIX-ZERO — «pass ⊕ must-fix» 는 land 로 가지 않는다(#25941 `canAuto` 와 같은 축) · 수를 못 읽었으면 «0» 이 아니라 «모름»(fail-closed).
  //   (`mustFixCount` 는 `SupervisorJobResult.selfReview` 가 나른다 — 시그니처는 그대로 두고 여기서만 읽는다.)
  const mustFixCount = (ctx.review as { mustFixCount?: unknown }).mustFixCount;
  if (typeof mustFixCount !== 'number' || !Number.isSafeInteger(mustFixCount) || mustFixCount < 0) return reject(card.id, `PR #${pr} review-must-fix-unknown`, reviewRepo);
  if (mustFixCount > 0) return reject(card.id, `PR #${pr} review-warn-with-must-fix: pass carries ${mustFixCount} must-fix`, reviewRepo);
  const cycle = ctx.cycleId ?? ctx.runId;
  if (cycle && landedCycles.has(cycle)) return reject(card.id, `cycle ${cycle} already landed — stays shadow`, reviewRepo);
  const path = deps.statePath ?? taskAgentStatePath();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  let claimed = false;
  let missing = false;
  try {
    updateTaskCard(path, card.id, (current) => {
      if (!current) { missing = true; return undefined; }
      if ((current.landAttempts ?? []).some(entry => entry.pr === pr && entry.head.toLowerCase() === view!.head.toLowerCase())) return undefined;
      claimed = true;
      return { ...current, landAttempts: [...(current.landAttempts ?? []), { pr, head: view!.head, at }] };
    });
  } catch (error) {
    return reject(card.id, `land attempt could not be recorded: ${String(error).slice(-250)}`, reviewRepo);
  }
  if (missing) return reject(card.id, 'task card not in state file', reviewRepo);
  if (!claimed) return observe(deps, withRepo({ kind, card: card.id, ok: true, executed: false, detail: `already attempted land for #${pr} head ${view.head.slice(0, 12)}` }));
  if (cycle) landedCycles.add(cycle);
  // TA-LAND-WORKTREE — `pr land --expected-head` 는 «로컬 HEAD = 고정 머리»를 요구한다. cwd 가 다른 머리면(Pod 런 PR · 호스트 checkout)
  //   PR 머리의 임시 워크트리에서 부르고 끝나면 걷는다. 같은 머리(로컬 런 작업 트리)거나 HEAD 를 못 읽으면 종전 그대로 cwd 에서.
  let landCwd = cwd;
  let worktree: LandWorktree | undefined;
  const local = (deps.landWorktree?.localHead ?? localHead)(cwd);
  if (local && local.toLowerCase() !== view.head.toLowerCase()) {
    let made: LandWorktree | LandWorktreeFailure;
    try {
      made = await (deps.landWorktree?.create ?? createLandWorktree)({ card: card.id, pr, head: view.head, branch: view.branch, repoCwd: cwd, statePath: path });
    } catch (error) { made = { reason: (error instanceof Error ? error.message : String(error)).slice(-250), created: null, removed: null }; }
    if ('reason' in made) {
      const reason = made.reason;
      observeLandWorktree({ card: card.id, pr, head: view.head, created: made.created, removed: made.removed, reason }, deps.log);
      // land 를 부르지 않았다 — 이 머리의 시도 기록과 주기 표시를 되돌려 다음 틱이 다시 시도할 수 있게 한다.
      if (cycle) landedCycles.delete(cycle);
      try {
        updateTaskCard(path, card.id, (current) => current?.landAttempts?.some(entry => entry.pr === pr && entry.head === view!.head && entry.at === at)
          ? { ...current, landAttempts: current.landAttempts.filter(entry => !(entry.pr === pr && entry.head === view!.head && entry.at === at)) }
          : undefined);
      } catch (error) {
        // 되돌리기 실패 — 이 머리는 «시도함»으로 남아 다음 틱이 막힌다. 조용히 넘기지 않고 사유를 남긴다.
        observeLandWorktree({ card: card.id, pr, head: view.head, created: made.created, removed: made.removed, reason: `land attempt release failed: ${String(error).slice(-200)}` }, deps.log);
        return reject(card.id, `PR #${pr} land worktree unavailable: ${reason} · attempt release failed (head stays attempted)`, reviewRepo);
      }
      return reject(card.id, `PR #${pr} land worktree unavailable: ${reason}`, reviewRepo);
    }
    worktree = made;
    landCwd = made.cwd;
    observeLandWorktree({ card: card.id, pr, head: view.head, created: true, removed: false, reason: `cwd HEAD ${local.slice(0, 12)} ≠ PR head ${view.head.slice(0, 12)}` }, deps.log);
  }
  // 증거 경로는 «원래» cwd 기준으로 고정한다 — 임시 트리로 cwd 를 바꿔도 상대경로가 다른 파일을 가리키지 않게(같은 cwd 면 그대로).
  const overlapEvidence = ctx.overlapEvidence && worktree ? resolve(cwd, ctx.overlapEvidence) : ctx.overlapEvidence;
  let ok = false;
  let detail: string;
  try {
    // The CLI rechecks the pinned PR/head immediately before merge, after its own gates and freeze admission.
    const outcome = overlapEvidence
      ? await (deps.land ?? defaultLand)(pr, view.head, landCwd, { overlapEvidence })
      : await (deps.land ?? defaultLand)(pr, view.head, landCwd);
    ok = outcome.status === 0;
    detail = (ok ? outcome.stdout || `land merged #${pr} head ${view.head.slice(0, 12)}` : outcome.stderr || outcome.stdout || `exit ${outcome.status}`).slice(-300);
  } catch (error) { detail = (error instanceof Error ? error.message : String(error)).slice(-300); }
  if (worktree) {
    // 성공이든 실패든 걷는다.
    let removal: LandWorktreeRemoval;
    try { removal = worktree.cleanup(); } catch (error) { removal = { removed: false, reason: String(error).slice(-200) }; }
    observeLandWorktree({ card: card.id, pr, head: view.head, created: true, removed: removal.removed, ...(removal.branchRemoved !== undefined ? { branchRemoved: removal.branchRemoved } : {}),
      reason: removal.reason ?? `land ${ok ? 'ok' : 'failed'} — removed` }, deps.log);
  }
  try {
    updateTaskCard(path, card.id, (current) => current?.landAttempts?.some(entry => entry.pr === pr && entry.head === view!.head && entry.at === at)
      ? { ...current, landAttempts: current.landAttempts.map(entry => entry.pr === pr && entry.head === view!.head && entry.at === at ? { ...entry, ok, detail } : entry) }
      : undefined);
  } catch (error) {
    return observe(deps, withRepo({ kind, card: card.id, ok: false, executed: true,
      detail: `land ${ok ? 'succeeded' : 'failed'} but card update failed: ${String(error).slice(-230)}` }));
  }
  return observe(deps, withRepo({ kind, card: card.id, ok, executed: true, detail }));
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
