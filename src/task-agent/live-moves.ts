/**
 * TA-JUDGE-LIVE-SAFE — 설정에서 명시한 review · propose-green · propose-land 만 실제로 한다.
 *
 * - `review`: 수확 가능 런의 PR 에 elanous 리뷰를 «한 번» 요청한다 — PR 머리(sha)마다 한 번(카드 `reviewRequests` 이력).
 *   요청만 한다: 결과로 착지·재발사로 잇지 않는다(실행부 `executeNextAction` 의 review→land 사슬을 타지 않는다).
 *   TA-REVIEW-RESULT-CAPTURE — 자식 stdout(`--json`)은 결과 파일로 받고, 자식 완료 뒤 해당 카드만 회수·재판정한다.
 *   회수한 pass 는 그 틱의 판단부·land 관문 입력(`selfReview`)이 될 뿐 land 판정 로직은 그대로다.
 * - `propose-green`: 카드에 green «제안»(`greenProposal`)만 적는다 — 체크리스트는 손대지 않는다.
 * - `propose-land`: 카드·현재 머리의 self review 통과(pass «또는» warn ⊕ must-fix 0 · TA-LAND-WARN-MUSTFIX0)·non-draft 를 확인한다. 큐 설정이 있으면 원격 changed gate 뒤 착지 줄에 등록하고, 없으면 기존 `pr land` 를 머리 고정으로 한 번 부른다.
 * - 사다리 R4: `narrow-relaunch` · `wait-retry` · `salvage-relaunch` · `alternative` 도 허용 목록 어휘다 — 실제 발사는 실행부
 *   `executeNextAction`(`actions.ts`)이 «목록 ⊕ 같은 수 2회 상한 ⊕ 회당 1건 ⊕ 부하 관문»을 모두 넘을 때만 한다.
 * - `decision-card`: 막힌 과제를 «근거(서명 · 화면 · must-fix)» 붙은 결정 카드로 올린다 — 근거가 하나도 없으면 카드를 올리지 않는다.
 *   카드는 종전 실행부와 같은 `decisions raise` 모양이라 OP 거르기(`seat-loop/op-decide.ts`)가 그대로 본다 · 같은 근거는 카드 history 로 한 번만.
 * - 설정 `taskAgent.liveMoves`(config > env `ELANOUS_TASK_AGENT_LIVE_MOVES` > 없음). 모르는 항목은 경고하고 버린다.
 * - 관측: 실행한 수마다 `debug.log('task-agent', 'live-move', {kind, card, ok, detail, live:true})`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { findGitDir } from '../git-fs/locate.js';
import { getUserConfig, userConfigPath } from '../user-config.js';
import type { DetachedSpawn } from '../cli/tasks-cli.js';
import { LIVE_MOVE_HISTORY_EVENT, taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';
import { LIVE_RETRY_MOVES } from './judge.js';
import { decisionCardGrounds, decisionRaiseArgs, type DecisionCardEvidence, type NextAction } from './actions.js';
import { pendingReviewResults, reviewResultPath, TA_REVIEW_COMPLETION_CARD_ENV, TA_REVIEW_COMPLETION_RESULT_ENV, TA_REVIEW_COMPLETION_STATE_ENV } from './review-result-capture.js';
import { buildPriorFixContext, PRIOR_FIX_SCOPE_LINE, priorFixBlock, priorFixObservation, type PriorDiffReader, type PriorFixContext } from './review-prior-fix.js';
import { createLandWorktree, localBranch, localHead, observeLandWorktree, type LandWorktree, type LandWorktreeFailure, type LandWorktreeInput, type LandWorktreeRemoval } from './land-worktree.js';
import { runQueuedLanding, type QueueLandingInput } from './land-queue.js';

export const TASK_AGENT_LIVE_MOVES = ['review', 'propose-green', 'propose-land', 'decision-card', ...LIVE_RETRY_MOVES] as const;
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
  /** REVIEW-CONVERGE-PRIOR-FIX — 같은 PR 재리뷰의 직전 머리 → 지금 머리 diff(시험 주입 · 기본 = `git diff --numstat`). */
  priorDiff?: PriorDiffReader;
  /** Fresh PR head and draft flag for landing; separate from the unchanged review lookup. */
  landPrHead?: (pr: number, cwd: string) => Promise<(PrHeadView & { isDraft: boolean }) | null>;
  /** One existing pr land operation; inject in tests instead of invoking the CLI. */
  /** TA-REJUDGE-ON-HEAD — `opts.overlapEvidence` 가 있으면 `pr land --overlap-evidence <file>` 로 넘긴다(없으면 종전 인자). */
  land?: (pr: number, head: string, cwd: string, opts?: { overlapEvidence?: string }) => Promise<{ status: number; stdout: string; stderr?: string }>;
  /** `decision-card` — `decisions raise` 한 번(시험 주입 · 기본 = 같은 우주의 CLI 자식). */
  raiseDecision?: (args: string[]) => Promise<{ status: number; stdout: string; stderr?: string }>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** TA-LAND-WORKTREE — cwd HEAD 읽기 · PR 머리 임시 워크트리 만들기(시험 주입 · 기본 = git). */
  landWorktree?: { localHead?: (cwd: string) => string | null; localBranch?: (cwd: string) => string | null; create?: (input: LandWorktreeInput) => Promise<LandWorktree | LandWorktreeFailure> };
  /** TA-LAND-AFTER-REVIEW — injected queue adapter; absent uses configured command after a remote changed gate. */
  queueLanding?: (input: QueueLandingInput) => Promise<{ status: number; stdout: string; stderr?: string }>;
  landQueueConfig?: { command: string; remote: string } | null;
}

/** `executed` = 부작용을 실제로 냈다(리뷰를 띄웠다 · 제안을 적었다). ok 이지만 이미 한 수(같은 머리·이미 제안)면 false. */
export interface LiveMoveResult {
  kind: TaskAgentLiveMove | 'land'; card: string | null; ok: boolean; executed: boolean; detail: string;
  /** TA-LIVE-REVIEW-POD — 작업 트리 없이 리뷰 저장소를 찾았을 때(또는 못 찾았을 때)의 근거 한 줄. */
  reviewRepo?: { resolved: boolean; source?: ReviewRepoCandidate['source']; cwd?: string; proof?: 'head-sha' | 'branch'; reason: string };
  /** TA-REVIEW-RESULT-CAPTURE — 띄운 review 의 결과 파일(자식 stdout) — 실행한 review 에만 실린다. */
  resultPath?: string;
  /** TA-LAND-RETRY-ON-INFRA — 실행한 land 의 그 머리 몇 번째 시도인가 · 실패면 갈래(infra|judgement|base-stale)·사유·재시도 가능 여부. */
  landAttempt?: { attempt: number; class?: LandFailureClass; reason?: string; retryAllowed?: boolean };
  /** A queue accepted this head. Merge confirmation belongs to the later train receipt. */
  queued?: boolean;
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
export async function defaultRequestReview(pr: number, intent: string, cwd?: string, opts: { spawn?: DetachedSpawn; entry?: string; configDir?: string; resultPath?: string; cardId?: string; statePath?: string } = {}): Promise<void> {
  const { spawnDetachedConfirmed, ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const configDir = opts.configDir ?? getElanousConfigDirOverride() ?? effectiveInstanceRoot();
  const base = opts.spawn ?? (spawn as unknown as DetachedSpawn);
  const args = liveReviewArgs(opts.entry ?? ELANOUS_CLI_ENTRY, configDir, pr, intent);
  const completionEnv = opts.resultPath && opts.cardId && opts.statePath ? {
    [TA_REVIEW_COMPLETION_CARD_ENV]: opts.cardId,
    [TA_REVIEW_COMPLETION_STATE_ENV]: opts.statePath,
    [TA_REVIEW_COMPLETION_RESULT_ENV]: opts.resultPath,
  } : undefined;
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
    await spawnDetachedConfirmed(toFile, process.execPath, args, undefined, cwd, completionEnv);
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
      // TA-LAND-RETRY-ON-INFRA — 왜 미확인인지 «마지막 줄»로 가른다(꼬리 300자에서도 남게): 못 읽음 = 인프라 · 읽었는데 MERGED 아님 = 판정.
      const unconfirmed = (line: string, before = stderr || stdout || 'landing completed without confirmed merge') => ({ status: 1, stdout, stderr: `${before.slice(-(299 - line.length))}\n${line}` });
      void defaultLandPrHead(pr, cwd).then((view) => {
        resolveResult(view?.state === 'MERGED'
          ? { status: 0, stdout, stderr }
          : unconfirmed(view ? `✗ ta-land: pr land exited 0 but PR is ${view.state}` : '✗ ta-land: merge state unreadable after pr land exit 0'));
      }).catch((error) => resolveResult(unconfirmed('✗ ta-land: merge state unreadable after pr land exit 0', String(error))));
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

/**
 * REVIEW-CONVERGE-PRIOR-FIX — `prior` 는 같은 PR 의 두 번째 이후 리뷰에만 온다: «직전 반영분»에 직전 머리 범위·diff·must-fix 를,
 * 범위 경계에 «바뀌지 않은 줄의 새 must-fix 는 근거 줄» 한 줄을 붙인다. 없으면(첫 리뷰) 종전 문면 바이트 그대로.
 */
export function liveReviewIntent(card: TaskCard, runId: string | null, stopReason: string, prior?: PriorFixContext | null): string {
  const goal = card.text.split('\n')[0]!.trim().slice(0, 300);
  return [
    `목표: ${goal}`,
    `수용기준: 과제 카드 ${card.id} 원문 —\n${card.text.trim().slice(0, 4000)}`,
    `직전 반영분: 런 ${runId ?? '-'} 이 ${stopReason} 로 멈춤 — 수확 가능${prior ? `\n${priorFixBlock(prior)}` : ''}`,
    `의도적 범위 경계: task-agent live review 요청(TA-JUDGE-LIVE-SAFE) — 리뷰만 한다 · 착지·재발사는 이 요청의 결정이 아니다${prior ? `\n${PRIOR_FIX_SCOPE_LINE}` : ''}`,
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
  ctx: { runId: string | null; stopReason: string; cwd?: string; forceNewReview?: boolean; produced?: { headCommit?: string; branch?: string; prUrl?: string } },
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
  const resultPath = ctx.forceNewReview
    ? reviewResultPath(path, card.id, pr, head.head).replace(/\.json$/, `-${randomUUID()}.json`)
    : reviewResultPath(path, card.id, pr, head.head);
  const claim: { claimed: boolean; missing: boolean; before?: TaskCard } = { claimed: false, missing: false };
  updateTaskCard(path, card.id, (current) => {
    if (!current) { claim.missing = true; return undefined; }
    // 머리 «이력»으로 본다 — A→B→A 로 돌아와도 A 는 다시 요청하지 않는다.
    if (ctx.forceNewReview) {
      if (pendingReviewResults(current).some((entry) => entry.pr === pr && entry.head === head!.head)) return undefined;
    } else if ((current.reviewRequests ?? []).some((entry) => entry.pr === pr && entry.head === head!.head)) return undefined;
    claim.claimed = true;
    claim.before = current;
    return { ...current, reviewRequests: [...(current.reviewRequests ?? []), { pr, head: head!.head, at, resultPath }] };
  });
  if (claim.missing) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: 'task card not in state file' }));
  if (!claim.claimed) return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: true, detail: `already requested for #${pr} head ${head.head.slice(0, 12)}` }));
  try {
    // REVIEW-CONVERGE-PRIOR-FIX — 같은 PR 의 직전 요청(잠금 안에서 본 이력)이 있으면 그 라운드를 intent 에 싣는다 · 맥락을 못 만들면 종전 문면.
    let prior: PriorFixContext | null = null;
    try { prior = claim.before ? buildPriorFixContext(claim.before, pr, head.head, { ...(cwd ? { cwd } : {}), ...(deps.priorDiff ? { priorDiff: deps.priorDiff } : {}) }) : null; } catch { prior = null; }
    if (prior) {
      try { (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', 'review-prior-fix-filled', priorFixObservation(card.id, pr, prior)); } catch { /* fail-soft */ }
    }
    const intent = liveReviewIntent(card, ctx.runId, ctx.stopReason, prior);
    await (deps.requestReview ? deps.requestReview(pr, intent, cwd, { resultPath }) : defaultRequestReview(pr, intent, cwd, { resultPath, cardId: card.id, statePath: path }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateTaskCard(path, card.id, (current) => current?.reviewRequests?.some((entry) => entry.pr === pr && entry.head === head!.head && entry.at === at)
      ? { ...current, reviewRequests: current.reviewRequests.map((entry) => entry.pr === pr && entry.head === head!.head && entry.at === at ? { ...entry, error: reason } : entry) }
      : undefined);
    return observe(deps, withRepo({ kind, executed: false, card: card.id, ok: false, detail: `review request failed for #${pr} head ${head.head.slice(0, 12)}: ${reason}` }));
  }
  return observe(deps, withRepo({ kind, executed: true, card: card.id, ok: true, detail: `review requested for #${pr} head ${head.head.slice(0, 12)}`, resultPath }));
}

/**
 * TA-LAND-RETRY-ON-INFRA — land 실패를 둘로 가른다.
 *
 * - 왜: «같은 머리에 land 한 번»이 TA 쪽 인프라 결손(호스트에 PR 머리 트리가 없어 `✗ expected-head: … matching local HEAD and clean
 *   worktree required`)에 그 한 번을 써 버렸고, 결손을 고친(#26037) 뒤에도 같은 머리는 `already attempted` 로 막혀 사람이 머리를
 *   흔들어야 했다(2026-10-11 #26030 · 카드 ta-20261010-c6b53b).
 * - `infra` — 아래 «명시적 허용 목록»에 있는 사유만. 같은 머리에 한 번 더(머리당 총 `LAND_ATTEMPTS_PER_HEAD_ON_INFRA`).
 * - `judgement` — 그 밖 전부(must-fix · 겹침 관문 · 머리 바뀜 · 동결 · 게이트 · 충돌 · 목록에 없는 ✗ 줄 · 기록 없는 옛 시도) — 종전대로 한 번 끝(fail-closed).
 * - 판독 근거: `pr land` 의 실제 출력 줄(`src/cli/pr-cli.ts` 의 `✗ <관문>:` 문면 그대로)과 `executeLiveLand` 의 사유.
 * - 임시 워크트리 «생성 실패»는 여기 오지 않는다 — #26037 이 land 를 부르지 않고 시도 기록을 «되돌린다»(시도를 안 쓴다).
 * - `base-stale` — REJUDGE base-stale(OVERLAP-EVIDENCE-BASE-WINDOW 짝 · #26060): 겹침 증거의 게이트 base 뒤에 main 이 «PR 파일을 건드리며»
 *   움직였다(`✗ overlap-evidence: base-stale-overlap: …` ⊕ 딸린 `✗ expected-head: overlap merge approval unavailable …` 줄 «만»).
 *   같은 머리 «즉시» 재시도는 없다(`retryAllowed:false`) — 재판정 틱이 새 base 위 재게이트를 청하고, 그 재게이트가 «통과한 뒤»
 *   (`executeLiveLand` ctx `gateAt` = 그 재게이트 요청 시각)에만 이 시도는 «소비됨»으로 빠진다. judgement·infra 와 섞이지 않는다.
 */
export const LAND_ATTEMPTS_PER_HEAD_ON_INFRA = 2;
export type LandFailureClass = 'infra' | 'judgement' | 'base-stale';

/** `pr land` 출력 줄 → 인프라 사유. ⛔ 줄 «전체»가 맞아야 한다 — 비슷한 문면을 넓게 받지 않는다. */
export const LAND_INFRA_OUTPUT_REASONS: ReadonlyArray<{ reason: string; line: RegExp }> = [
  // 머리 고정 사전 조건 — gh 로 본 PR(OPEN·non-draft·머리)은 executeLiveLand 가 «직전에» 확인했다 · 남는 원인은 로컬 HEAD·더러운 트리·gh 조회 실패.
  { reason: 'precondition-local-head-clean-tree', line: /^✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required$/ },
  { reason: 'precondition-branch', line: /^✗ branch: (?:PR head branch와 현재 브랜치가 다릅니다\.|현재 브랜치를 해석하지 못했습니다\.)$/ },
  { reason: 'base-unresolved', line: /^✗ base: 비교 base를 선택하지 못했습니다\.$/ },
  { reason: 'git-read-failed', line: /^✗ granularity: (?:비교 base를 해석하지 못했습니다\.|로컬 git log 를 읽지 못했습니다\.)$/ },
  { reason: 'gh-lookup-failed', line: /^✗ find: / },
  { reason: 'gh-merge-state-unknown', line: /^✗ merge: squash merge (?:결과를 모름 \(상태 미확정\)|상태 되읽기 실패)$/ },
  // defaultLand — `pr land` 가 0 으로 끝났는데 병합 상태를 gh 로 다시 못 읽었다(병합됐으면 다음 시도는 MERGED 로 관문 앞에서 멈춘다).
  { reason: 'gh-merge-state-unreadable', line: /^✗ ta-land: merge state unreadable after pr land exit 0$/ },
];
/** 인프라 사유에 «딸려 나오는» 줄 — 그 사유가 같이 있을 때만 판정 거절로 세지 않는다. */
const LAND_INFRA_CONSEQUENCE_LINES: ReadonlyArray<{ of: string; line: RegExp }> = [
  { of: 'gh-lookup-failed', line: /^✗ upsert-ready: gh: pinned PR is not the branch open PR$/ },
];
/** REJUDGE base-stale — 겹침 증거의 게이트 base 가 낡았고 그 사이 착지가 PR 파일을 건드렸다(`pr land` · #26060 문면). */
const LAND_BASE_STALE_LINE = /^✗ overlap-evidence: (base-stale-overlap: .*)$/;
/** base-stale 에 «딸려 나오는» 줄 — 증거가 거절되면 `pr land` 가 이어서 낸다(그 줄만 있으면 판정 거절로 세지 않는다). */
const LAND_BASE_STALE_CONSEQUENCE_LINES: readonly RegExp[] = [/^✗ expected-head: overlap merge approval unavailable for the reviewed head$/];
/** 실패가 아닌 ✗ 줄 — `pr land` 가 «계속합니다»로 넘어간다(판정에 쓰지 않는다). */
const LAND_NON_FATAL_LINES: readonly RegExp[] = [/^✗ active-run-files: .*계속합니다\.?$/];
const TSC_RUNTIME_MISSING = /(?:^|\n)(?:sh: )?(?:env: )?(?:[^\s]*\/)?(?:node|bun|tsc): (?:No such file or directory|command not found)/m;
const TSC_NOT_RUN = /(?:tsc 종료코드 127|tsc 실행 실패 \([^\n]*code=ENOENT)/;
const TSC_GATE_REFUSED = '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.';
function missingTscRuntime(text: string): boolean {
  return TSC_NOT_RUN.test(text) && TSC_RUNTIME_MISSING.test(text);
}
/** executeLiveLand 쪽 인프라 사유(출력 줄이 아니라 실행 사실). */
export const LAND_INFRA_EXECUTOR_REASONS = ['land-process-error', 'land-no-result-line'] as const;
const [LAND_PROCESS_ERROR, LAND_NO_RESULT_LINE] = LAND_INFRA_EXECUTOR_REASONS;

const RESULT_MARK = /^(?:\[dry-run\] )?[✓✗⚠⏳]/u;

export interface LandFailureClassification { class: LandFailureClass; reason: string }

/**
 * 실패한 land 의 출력(또는 던진 오류)을 가른다 — 목록에 없는 ✗ 줄이 «하나라도» 있으면 판정 거절이다.
 * `thrown` = land 를 띄우거나 기다리다 던졌다(프로세스 오류).
 */
export function classifyLandFailure(outcome: { status: number; stdout?: string; stderr?: string } | { thrown: string }): LandFailureClassification {
  if ('thrown' in outcome) return { class: 'infra', reason: LAND_PROCESS_ERROR };
  const lines = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marked = lines.filter((line) => RESULT_MARK.test(line));
  // 결과 줄이 «하나도» 없이 0 아닌 코드로 끝났다 — 관문까지 못 간 채 죽었다(크래시 · 신호).
  if (!marked.length) return outcome.status !== 0 ? { class: 'infra', reason: LAND_NO_RESULT_LINE } : { class: 'judgement', reason: 'no-failure-line' };
  const failures = marked.map((line) => line.replace(/^\[dry-run\] /, '')).filter((line) => line.startsWith('✗') && !LAND_NON_FATAL_LINES.some((re) => re.test(line)));
  // The gate did not measure TypeScript when its interpreter was absent. The
  // exact typecheck refusal alone remains judgement; require rc127/ENOENT and
  // the missing runtime line, with no second failing gate.
  if (failures.length === 1 && failures[0] === TSC_GATE_REFUSED && missingTscRuntime(lines.join('\n'))) {
    return { class: 'infra', reason: 'tsc-runtime-missing' };
  }
  const infra = new Set<string>();
  const unlisted: string[] = [];
  for (const line of failures) {
    const hit = LAND_INFRA_OUTPUT_REASONS.find((entry) => entry.line.test(line));
    if (hit) infra.add(hit.reason); else unlisted.push(line);
  }
  const judged = unlisted.filter((line) => !LAND_INFRA_CONSEQUENCE_LINES.some((entry) => infra.has(entry.of) && entry.line.test(line)));
  // REJUDGE base-stale — 거절 줄이 base-stale-overlap(⊕ 딸린 줄) «뿐»이고 인프라 사유가 없을 때만. 하나라도 다른 ✗ 줄이 섞이면 judgement(fail-closed).
  const stale = judged.map((line) => LAND_BASE_STALE_LINE.exec(line)?.[1]).find((reason): reason is string => !!reason);
  if (stale && !infra.size && judged.every((line) => LAND_BASE_STALE_LINE.test(line) || LAND_BASE_STALE_CONSEQUENCE_LINES.some((re) => re.test(line)))) {
    return { class: 'base-stale', reason: stale.slice(0, 160) };
  }
  if (judged.length) return { class: 'judgement', reason: judged[0]!.slice(0, 120) };
  if (infra.size) return { class: 'infra', reason: [...infra].join('+') };
  return { class: 'judgement', reason: 'no-failure-line' };
}

type LandAttempt = NonNullable<TaskCard['landAttempts']>[number];
type LandWorktreeCreateFailure = { pr: number; head: string; at: string; reason: string };
declare module './task-hand.js' {
  interface TaskCard { landWorktreeCreateFailures?: LandWorktreeCreateFailure[] }
}
const sameHeadOf = (pr: number, head: string) => (entry: LandAttempt) => entry.pr === pr && entry.head.toLowerCase() === head.toLowerCase();

function landWorktreeCreateCap(): number {
  try {
    const config = JSON.parse(readFileSync(userConfigPath(), 'utf8')) as { tasks?: { landWorktreeCreateCap?: unknown } };
    const configured = config.tasks?.landWorktreeCreateCap;
    return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
  } catch { return 3; }
}

function consecutiveLandWorktreeCreateFailures(card: TaskCard, pr: number, head: string): LandWorktreeCreateFailure[] {
  const entries = (card.landWorktreeCreateFailures ?? []).filter((entry) => entry.pr === pr);
  const last = entries.at(-1);
  return last?.head.toLowerCase() === head.toLowerCase()
    ? entries.filter((entry) => entry.head.toLowerCase() === head.toLowerCase())
    : [];
}

function recordLandWorktreeCreateFailure(card: TaskCard, failure: LandWorktreeCreateFailure): TaskCard {
  const samePr = (card.landWorktreeCreateFailures ?? []).filter((entry) => entry.pr !== failure.pr);
  const samePrHead = (card.landWorktreeCreateFailures ?? []).filter((entry) => entry.pr === failure.pr && entry.head.toLowerCase() === failure.head.toLowerCase());
  return { ...card, landWorktreeCreateFailures: [...samePr, ...samePrHead, failure] };
}

function clearLandWorktreeCreateFailures(card: TaskCard, pr: number): TaskCard {
  const remaining = (card.landWorktreeCreateFailures ?? []).filter((entry) => entry.pr !== pr);
  const { landWorktreeCreateFailures: _removed, ...rest } = card;
  return { ...rest, ...(remaining.length ? { landWorktreeCreateFailures: remaining } : {}) };
}

function cappedLandWorktreeReason(failures: readonly LandWorktreeCreateFailure[], cap: number): string {
  return `land worktree create capped (${failures.length}/${cap}): ${failures.at(-1)?.reason ?? 'unknown'}`;
}

function observeLandWorktreeCreateCapped(deps: LiveMoveDeps, data: { card: string; pr: number; head: string; failures: number; cap: number; reason: string }): void {
  try { (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', 'land-worktree-create-capped', data); } catch { /* fail-soft */ }
}

/** 같은 머리에 한 번 더 시도해도 되나 — 앞 시도가 «전부» 끝났고(ok:false) «전부» infra 이고 상한 밑일 때만. */
function landRetryAllowed(prior: readonly LandAttempt[]): boolean {
  return prior.length > 0 && prior.length < LAND_ATTEMPTS_PER_HEAD_ON_INFRA
    && prior.every((entry) => entry.ok === false && (entry.class === 'infra' || legacyMissingTscRuntime(entry)));
}

/** A previous release classified a missing node interpreter as judgement; only that exact recorded shape may be reopened. */
function legacyMissingTscRuntime(entry: LandAttempt): boolean {
  return entry.ok === false && entry.class === 'judgement' && entry.reason === TSC_GATE_REFUSED
    && typeof entry.detail === 'string'
    && classifyLandFailure({ status: 1, stderr: entry.detail }).reason === 'tsc-runtime-missing';
}

/**
 * REJUDGE base-stale — `gateAt`(새 base 위 재게이트를 «요청한» 시각) 앞의 base-stale 시도는 그 재게이트가 통과해 소비됐다 —
 * 같은 머리 land 판단에서 뺀다. 나머지(infra·judgement·그 뒤의 시도)는 종전 규칙 그대로.
 */
export function openLandAttempts<T extends Pick<LandAttempt, 'at' | 'class'>>(prior: readonly T[], gateAt?: string): T[] {
  if (!gateAt) return [...prior];
  const since = Date.parse(gateAt);
  return prior.filter((entry) => !(entry.class === 'base-stale' && Number.isFinite(since) && Date.parse(entry.at) < since));
}

/** 카드의 이 PR·머리에 인프라 재시도가 남았나(재판정 틱이 «머리 그대로»여도 land 단계까지 가게). */
export function landRetryPending(card: Pick<TaskCard, 'landAttempts'>, pr: number, head: string): boolean {
  return landRetryAllowed((card.landAttempts ?? []).filter(sameHeadOf(pr, head)));
}

export const LAND_RETRY_ON_INFRA_EVENT = 'land-retry-on-infra';

const landedCycles = new Set<string>();

/** `propose-land` — only a passing self review (pass or warn, with must-fix 0) of this exact OPEN, non-draft head may enqueue or invoke pr land. */
export async function executeLiveLand(
  card: TaskCard | undefined, pr: number | undefined,
  ctx: { runId?: string | null; cycleId?: string; cwd?: string; produced?: { headCommit?: string; branch?: string; prUrl?: string }; review?: { verdict: 'pass' | 'warn' | 'fail'; head: string; /** TA-LAND-WARN-MUSTFIX0 — `false` 면 리뷰가 실제로 안 돌았다 → land 거부. 슈퍼바이저 입력은 reviewed 리뷰로만 만들어져 칸이 없다. */ reviewed?: boolean };
    /** Exact bytes consumed by the queue's own review check; no path means queue mode cannot proceed. */ reviewResultPath?: string;
    /** TA-REJUDGE-ON-HEAD — 겹침 증거 파일(있으면 land 에 넘길 뿐 · 판정은 그대로). */ overlapEvidence?: string;
    /** REJUDGE base-stale — 증거의 재게이트를 요청한 시각 · 그 앞의 base-stale 시도는 소비됨(`openLandAttempts`). */ gateAt?: string },
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
  const queueConfig = deps.landQueueConfig === undefined ? getUserConfig().taskAgent?.landQueue : deps.landQueueConfig;
  if (queueConfig && (!isAbsolute(queueConfig.command) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(queueConfig.remote)))
    return reject(card.id, `PR #${pr} land queue command/remote invalid`, reviewRepo);
  if (queueConfig && !ctx.reviewResultPath) return reject(card.id, `PR #${pr} queue review result path missing`, reviewRepo);
  const cycle = ctx.cycleId ?? ctx.runId;
  if (cycle && landedCycles.has(cycle)) return reject(card.id, `cycle ${cycle} already landed — stays shadow`, reviewRepo);
  const path = deps.statePath ?? taskAgentStatePath();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const local = (deps.landWorktree?.localHead ?? localHead)(cwd);
  const landKey = `land:${card.id}:${view.head.slice(0, 12)}`;
  const branch = local?.toLowerCase() === view.head.toLowerCase() ? (deps.landWorktree?.localBranch ?? localBranch)(cwd) : null;
  const needsLandWorktree = !!local && (local.toLowerCase() !== view.head.toLowerCase() || branch !== view.branch);
  const createCap = landWorktreeCreateCap();
  let claimed = false;
  let missing = false;
  let cappedReason: string | undefined;
  // This state-file lock is the cross-process card/head land claim. Both completion workers
  // must pass it; an unfinished or successful attempt makes the second worker skip.
  // TA-LAND-RETRY-ON-INFRA — 같은 머리의 앞 시도들(잠금 안에서 읽은 «지금» 카드) · 재시도면 그 근거.
  let prior: LandAttempt[] = [];
  try {
    updateTaskCard(path, card.id, (current) => {
      if (!current) { missing = true; return undefined; }
      if (needsLandWorktree) {
        const failures = consecutiveLandWorktreeCreateFailures(current, pr, view!.head);
        if (failures.length >= createCap) {
          cappedReason = cappedLandWorktreeReason(failures, createCap);
          return undefined;
        }
      }
      prior = openLandAttempts((current.landAttempts ?? []).filter(sameHeadOf(pr, view!.head)), ctx.gateAt);
      if (prior.length && !landRetryAllowed(prior)) return undefined;
      claimed = true;
      return { ...current, landAttempts: [...(current.landAttempts ?? []), { pr, head: view!.head, at }] };
    });
  } catch (error) {
    return reject(card.id, `land attempt could not be recorded: ${String(error).slice(-250)}`, reviewRepo);
  }
  if (missing) return reject(card.id, 'task card not in state file', reviewRepo);
  if (cappedReason) return reject(card.id, cappedReason, reviewRepo);
  if (!claimed) {
    const last = prior.at(-1);
    const why = last ? ` (attempts ${prior.length} · last ${last.ok === false ? `class ${last.class ?? 'unclassified'}${last.reason ? ` ${last.reason}` : ''}` : last.ok === true ? 'ok' : 'unfinished'})` : '';
    return observe(deps, withRepo({ kind, card: card.id, ok: true, executed: false, detail: `already attempted land for #${pr} head ${view.head.slice(0, 12)} · ${landKey} claimed — skip${why}` }));
  }
  const attempt = prior.length + 1;
  if (attempt > 1) {
    const last = prior.at(-1)!;
    const legacy = legacyMissingTscRuntime(last);
    try { (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', LAND_RETRY_ON_INFRA_EVENT, { card: card.id, pr, head: view.head, attempt, reason: legacy ? 'tsc-runtime-missing-legacy' : last.reason ?? 'unknown', class: 'infra', decision: legacy ? 'legacy-reclassified-retrying' : 'retrying' }); } catch { /* fail-soft */ }
  }
  if (cycle) landedCycles.add(cycle);
  // TA-LAND-WORKTREE — `pr land --expected-head` 는 «로컬 HEAD = 고정 머리»를 요구한다. cwd 가 다른 머리면(Pod 런 PR · 호스트 checkout)
  //   PR 머리의 임시 워크트리에서 부르고 끝나면 걷는다. 같은 머리(로컬 런 작업 트리)거나 HEAD 를 못 읽으면 종전 그대로 cwd 에서.
  let landCwd = cwd;
  let worktree: LandWorktree | undefined;
  if (needsLandWorktree && local) {
    let made: LandWorktree | LandWorktreeFailure;
    try {
      made = await (deps.landWorktree?.create ?? createLandWorktree)({ card: card.id, pr, head: view.head, branch: view.branch, repoCwd: cwd, statePath: path });
    } catch (error) { made = { reason: (error instanceof Error ? error.message : String(error)).slice(-250), created: null, removed: null }; }
    if ('reason' in made) {
      const reason = made.reason;
      observeLandWorktree({ card: card.id, pr, head: view.head, created: made.created, removed: made.removed, reason }, deps.log);
      if (made.kind === 'worktree-conflict') {
        try { (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', 'worktree-conflict', {
          card: card.id, pr, head: view.head, branch: view.branch ?? null, ownerPath: made.ownerPath ?? 'unknown', reason,
        }); } catch { /* fail-soft */ }
      }
      let failures: LandWorktreeCreateFailure[] = [];
      let recordFailureError: unknown;
      try {
        updateTaskCard(path, card.id, (current) => {
          if (!current) return undefined;
          failures = [...consecutiveLandWorktreeCreateFailures(current, pr, view!.head), { pr, head: view!.head, at, reason }];
          return recordLandWorktreeCreateFailure(current, { pr, head: view!.head, at, reason });
        });
      } catch (error) { recordFailureError = error; }
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
      if (recordFailureError) return reject(card.id, `PR #${pr} land worktree unavailable: ${reason} · failure record failed: ${String(recordFailureError).slice(-200)}`, reviewRepo);
      if (failures.length >= createCap) {
        const capped = cappedLandWorktreeReason(failures, createCap);
        if (failures.length === createCap) observeLandWorktreeCreateCapped(deps, { card: card.id, pr, head: view.head, failures: failures.length, cap: createCap, reason });
        return reject(card.id, capped, reviewRepo);
      }
      return reject(card.id, `PR #${pr} land worktree unavailable: ${reason}`, reviewRepo);
    }
    worktree = made;
    landCwd = made.cwd;
    // 실패 장부 정리는 fail-soft — 정리 쓰기 실패로 정상 착지를 막지 않는다(막으면 잡아 둔 landAttempts 가 남아 그 head 가 영영 «already attempted»).
    try {
      updateTaskCard(path, card.id, (current) => current?.landWorktreeCreateFailures?.some((entry) => entry.pr === pr)
        ? clearLandWorktreeCreateFailures(current, pr) : undefined);
    } catch (error) {
      try { (deps.log ?? ((c, e, d) => debug.log(c, e, d, { level: 'warn' })))('task-agent', 'land-worktree-create-failures-clear-failed', { card: card.id, pr, head: view.head, error: String(error).slice(-200) }); } catch { /* fail-soft */ }
    }
    observeLandWorktree({ card: card.id, pr, head: view.head, created: made.created ?? null, removed: false, reason: `cwd HEAD ${local.slice(0, 12)} · branch ${branch ?? 'unknown'} differs from PR ${view.head.slice(0, 12)} · ${view.branch ?? 'unknown'}` }, deps.log);
  }
  // 증거 경로는 «원래» cwd 기준으로 고정한다 — 임시 트리로 cwd 를 바꿔도 상대경로가 다른 파일을 가리키지 않게(같은 cwd 면 그대로).
  const overlapEvidence = ctx.overlapEvidence && worktree ? resolve(cwd, ctx.overlapEvidence) : ctx.overlapEvidence;
  let ok = false;
  let detail: string;
  let failure: LandFailureClassification | undefined;
  try {
    // The CLI rechecks the pinned PR/head immediately before merge, after its own gates and freeze admission.
    const outcome = queueConfig
      ? await (deps.queueLanding ?? runQueuedLanding)({ card: card.id, pr, head: view.head, cwd: landCwd, statePath: path,
        reviewResult: ctx.reviewResultPath!, command: queueConfig.command, remote: queueConfig.remote,
        entry: (await import('../cli/tasks-cli.js')).ELANOUS_CLI_ENTRY,
        configDir: (await import('../elanous-config-dir.js')).getElanousConfigDirOverride() ?? (await import('../instance/resolve.js')).effectiveInstanceRoot() })
      : overlapEvidence
        ? await (deps.land ?? defaultLand)(pr, view.head, landCwd, { overlapEvidence })
        : await (deps.land ?? defaultLand)(pr, view.head, landCwd);
    ok = outcome.status === 0;
    detail = (ok ? outcome.stdout || `${queueConfig ? 'queued' : 'land merged'} #${pr} head ${view.head.slice(0, 12)}` : outcome.stderr || outcome.stdout || `exit ${outcome.status}`).slice(-300);
    if (!ok) failure = classifyLandFailure(outcome);
  } catch (error) {
    detail = (error instanceof Error ? error.message : String(error)).slice(-300);
    failure = classifyLandFailure({ thrown: detail });
  }
  const retryAllowed = failure?.class === 'infra' && attempt < LAND_ATTEMPTS_PER_HEAD_ON_INFRA;
  // 인프라 실패로 재시도가 남으면 주기 표시도 푼다 — 같은 주기 id(재판정 틱의 `rejudge:<card>:<head>`)가 그 한 번을 막지 않게.
  if (retryAllowed && cycle) landedCycles.delete(cycle);
  if (worktree && queueConfig && ok) {
    // The queue row pins this exact path until the train consumes it. Removing it here
    // would turn a successful enqueue into a guaranteed missing-tree landing failure.
    observeLandWorktree({ card: card.id, pr, head: view.head, created: worktree.created ?? null,
      removed: false, reason: 'queued — train owns this exact-head worktree until its receipt' }, deps.log);
  } else if (worktree) {
    // Direct land and rejected queue attempts no longer need the temporary checkout.
    let removal: LandWorktreeRemoval;
    try { removal = worktree.cleanup(); } catch (error) { removal = { removed: false, reason: String(error).slice(-200) }; }
    observeLandWorktree({ card: card.id, pr, head: view.head, created: worktree.created ?? null, removed: removal.removed, ...(removal.branchRemoved !== undefined ? { branchRemoved: removal.branchRemoved } : {}),
      reason: removal.reason ?? `land ${ok ? 'ok' : 'failed'} — removed` }, deps.log);
  }
  const landAttempt: LiveMoveResult['landAttempt'] = failure
    ? { attempt, class: failure.class, reason: failure.reason, retryAllowed }
    : { attempt };
  if (failure) {
    try {
      (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', LAND_RETRY_ON_INFRA_EVENT, {
        card: card.id, pr, head: view.head, attempt, reason: failure.reason, class: failure.class,
        decision: retryAllowed ? 'retry-allowed' : failure.class === 'infra' ? 'retry-exhausted' : failure.class === 'base-stale' ? 'base-stale-awaiting-regate' : 'no-retry',
      });
    } catch { /* fail-soft */ }
  }
  try {
    updateTaskCard(path, card.id, (current) => current?.landAttempts?.some(entry => entry.pr === pr && entry.head === view!.head && entry.at === at)
      ? {
        ...current,
        landAttempts: current.landAttempts.map(entry => entry.pr === pr && entry.head === view!.head && entry.at === at
          ? { ...entry, ok, detail, ...(failure ? { class: failure.class, reason: failure.reason } : {}) } : entry),
        // TA-LAND-RETRY-ON-INFRA — 실패한 시도마다 카드 history 한 줄(logs 창이 지나도 «왜 다시 했나/안 했나»가 남게).
        ...(failure ? { history: [...(current.history ?? []), {
          at, event: LAND_RETRY_ON_INFRA_EVENT, kind: failure.class, pr, head: view!.head,
          effect: retryAllowed ? 'retry-allowed' : failure.class === 'infra' ? 'retry-exhausted' : failure.class === 'base-stale' ? 'awaiting-regate' : 'no-retry',
          detail: failure.class === 'base-stale'
            ? `attempt ${attempt} · base-stale → 재게이트 대기 (land again only after a re-gate on a new base passes) · ${failure.reason}`
            : `attempt ${attempt}/${failure.class === 'infra' ? LAND_ATTEMPTS_PER_HEAD_ON_INFRA : attempt} · ${failure.reason}`,
        }] } : {}),
      }
      : undefined);
  } catch (error) {
    return observe(deps, withRepo({ kind, card: card.id, ok: false, executed: true, landAttempt,
      detail: `land ${ok ? 'succeeded' : 'failed'} but card update failed: ${String(error).slice(-230)}` }));
  }
  return observe(deps, withRepo({ kind, card: card.id, ok, executed: true, detail, landAttempt, ...(queueConfig && ok ? { queued: true } : {}) }));
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

export interface LiveDecisionCardContext {
  runId: string | null; stopReason: string; reason: string; pr?: number;
  risk?: NextAction['risk'];
  /** 서명 · 화면 · must-fix — 하나도 비지 않아야 카드가 올라간다. */
  evidence: DecisionCardEvidence;
}

const DECISION_SIGNATURE_KEEP = 300;
const DECISION_SCREEN_KEEP = 1500;

/** 같은 런 · 사유 · 근거면 같은 지문 — 카드 history 의 «이미 올렸다» 판정 키. */
export function decisionCardFingerprint(runId: string | null, reason: string, evidence: { signature?: string; screen?: string; mustFix: readonly string[] }): string {
  return createHash('sha1').update(JSON.stringify([runId, reason, evidence.signature ?? null, evidence.screen ?? null, evidence.mustFix])).digest('hex').slice(0, 12);
}

/** `decisions raise` 를 같은 우주의 CLI 자식으로 한 번 부른다 — 카드는 결정 원장에 들어가 OP 거르기가 읽는다. */
export async function defaultRaiseDecision(args: string[]): Promise<{ status: number; stdout: string; stderr?: string }> {
  const { ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const argv = [resolve(ELANOUS_CLI_ENTRY), '--config-dir', getElanousConfigDirOverride() ?? effectiveInstanceRoot(), ...args];
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-300); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-300); });
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ status: code ?? 1, stdout, stderr }));
  });
}

/**
 * `decision-card` — 막힌 과제를 근거 붙은 결정 카드로 올린다. 근거(서명 · 화면 · must-fix)가 하나도 없으면 «올리지 않는다».
 * 같은 지문의 카드는 한 번만(카드 history 의 `live-move` 줄 · 먼저 적고 올린다) · 올리기 실패는 줄을 걷어 다음 틱이 다시 시도한다.
 */
export async function executeLiveDecisionCard(card: TaskCard | undefined, ctx: LiveDecisionCardContext, deps: LiveMoveDeps = {}): Promise<LiveMoveResult> {
  const kind = 'decision-card' as const;
  if (!card) return observe(deps, { kind, executed: false, card: null, ok: false, detail: 'no task card — stays shadow' });
  const grounds = decisionCardGrounds(ctx.evidence);
  if (!grounds.length) return observe(deps, { kind, executed: false, card: card.id, ok: false, detail: 'no evidence (signature · screen · must-fix) — no card raised' });
  const signature = ctx.evidence.signature?.trim().slice(0, DECISION_SIGNATURE_KEEP) || undefined;
  const screen = ctx.evidence.screen?.trim().slice(-DECISION_SCREEN_KEEP) || undefined;
  const mustFix = (ctx.evidence.mustFix ?? []).filter((fix) => typeof fix === 'string' && fix.trim()).map((fix) => fix.trim());
  const mark = `fp:${decisionCardFingerprint(ctx.runId, ctx.reason, { ...(signature ? { signature } : {}), ...(screen ? { screen } : {}), mustFix })}`;
  const path = deps.statePath ?? taskAgentStatePath();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const ours = (entry: TaskCard['history'][number]) => entry.event === LIVE_MOVE_HISTORY_EVENT && entry.kind === kind && !!entry.detail?.includes(mark);
  const claim = { claimed: false, missing: false };
  updateTaskCard(path, card.id, (current) => {
    if (!current) { claim.missing = true; return undefined; }
    if ((current.history ?? []).some(ours)) return undefined;
    claim.claimed = true;
    return { ...current, history: [...(current.history ?? []), {
      at, event: LIVE_MOVE_HISTORY_EVENT, kind, executed: false, executorResult: 'live' as const,
      detail: `decision card claimed · ${mark}`, ...(ctx.runId ? { runId: ctx.runId } : {}), ...(ctx.pr !== undefined ? { pr: ctx.pr } : {}),
      effect: 'none — decision card claimed, not yet raised',
    }] };
  });
  if (claim.missing) return observe(deps, { kind, executed: false, card: card.id, ok: false, detail: 'task card not in state file' });
  if (!claim.claimed) return observe(deps, { kind, executed: false, card: card.id, ok: true, detail: `already raised for ${mark}` });
  const evidence = JSON.stringify({
    card: card.id, runId: ctx.runId, pr: ctx.pr ?? null, stopReason: ctx.stopReason, grounds,
    ...(signature ? { signature } : {}), ...(screen ? { screen } : {}), mustFix, selected: kind, reason: ctx.reason,
  });
  const args = decisionRaiseArgs({ taskId: card.id, reason: ctx.reason, ...(ctx.risk ? { risk: ctx.risk } : {}), evidence });
  let failure: string | undefined;
  try {
    const outcome = await (deps.raiseDecision ?? defaultRaiseDecision)(args);
    if (outcome.status !== 0) failure = (outcome.stderr || outcome.stdout || `exit ${outcome.status}`).slice(-250);
  } catch (error) { failure = (error instanceof Error ? error.message : String(error)).slice(-250); }
  const mine = (entry: TaskCard['history'][number]) => ours(entry) && entry.at === at;
  const detail = failure ? `decisions raise failed: ${failure}` : `decision card raised (${grounds.join(' · ')}) · ${mark}`;
  try {
    updateTaskCard(path, card.id, (current) => current?.history?.some(mine)
      ? { ...current, history: failure
        ? current.history.filter((entry) => !mine(entry))
        : current.history.map((entry) => mine(entry) ? { ...entry, executed: true, ok: true, detail, effect: `decision card raised · grounds ${grounds.join('+')} · decision ledger (OP filter reads it)` } : entry) }
      : undefined);
  } catch (error) {
    return observe(deps, { kind, executed: !failure, card: card.id, ok: false, detail: `${detail} but card update failed: ${String(error).slice(-200)}` });
  }
  return observe(deps, { kind, executed: !failure, card: card.id, ok: !failure, detail });
}
