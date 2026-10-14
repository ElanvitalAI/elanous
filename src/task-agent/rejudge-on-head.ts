/**
 * TA-REJUDGE-ON-HEAD — 런이 멈춘 «뒤» PR 머리가 바뀌면 task agent 가 재게이트 · 리뷰 · land 를 다시 판단한다.
 *
 * - 왜: live 판단은 «런 멈춤 순간» 한 번뿐이다(run-supervisor → `recordTaskAgentShadowMove`). 그 뒤 사람이(또는 다른 런이)
 *   must-fix 를 고쳐 push 해도 카드의 다음 수는 `wait` 로 남고, 새 머리를 재게이트·리뷰·착지하는 길이 없었다(2026-10-11 #26030:
 *   호스트 재게이트 기록은 Pod 산출 머리 것뿐이고 손으로 고친 새 머리엔 없었다).
 * - 한 틱(카드 하나 · `tasks rejudge`) — land 는 셋이 «모두» 지금 머리에 대해 참일 때만:
 *   ① 재게이트: 지금 머리의 재게이트 기록(`card.regates[]`)이 없으면 기존 호스트 재게이트(`runHostRegate` · `noMerge` — 병합 없음 ·
 *      ta-land-owner 와 같은 함수)를 «떼어 띄운» 자식(`tasks regate-run`)으로 한 번 돌린다 — 판단 틱을 막지 않는다. 결과
 *      (`<state>/regate-results/<card>-<pr>-<head12>.json` · head · baseCommit · passed)는 다음 틱이 회수해 카드에 적는다.
 *   ② 리뷰: 지금 머리로 리뷰를 요청한 적이 없으면 다시 요청한다(#25980 `executeLiveReview` 그대로 · 결과 회수도 그대로).
 *   ③ land: 재게이트 통과 ⊕ 회수한 리뷰가 지금 머리의 pass «또는» warn ⊕ reviewed ⊕ must-fix 0(TA-LAND-WARN-MUSTFIX0)이면 겹침 증거 파일
 *      (`<state>/overlap-evidence/<card>-<pr>-<head12>.json` = {pr, head, gate:{head, baseCommit, passed}, reviewResult} · #26023 꼴)을
 *      쓰고 `executeLiveLand` 를 «다시 부른다»(판정 로직 무변경 · 증거를 완전히 못 갖추면 land 하지 않는다 — fail-closed).
 *      LAND-ORDER-LEDGER — executeLiveLand 직후 겹침 쌍·착지 순서 원장(`land-order-ledger.ts` · `<state>/land-order-ledger.jsonl`)에
 *      한 줄을 붙인다(같은 pr+head 한 줄 · 쓰기 실패는 삼킨다 — land 결과 무변 · 관측 `task-agent.land-order` appended|append-failed).
 * - 상한: 같은 머리는 재게이트·리뷰 각 한 번 · 카드·PR 당 재게이트 `REJUDGE_HEAD_CAP` 번까지 — 넘으면 사유 줄을 남기고 멈춘다.
 * - REJUDGE base-stale(OVERLAP-EVIDENCE-BASE-WINDOW 짝 · #26060): land 가 `base-stale-overlap`(재게이트 base 뒤 착지가 PR 파일을 건드렸다)으로
 *   거절되면 그 시도는 `base-stale` 갈래로 적히고(judgement 1회 규칙과 섞이지 않는다), 다음 틱이 «같은 머리»를 새 base 위에서 한 번 더
 *   재게이트한다(`staleBase` = 낡은 base · 멱등 키 = 머리 ⊕ staleBase · 상한에 포함). 그 재게이트가 통과하고 base 가 실제로 바뀌었을 때만
 *   새 baseCommit 으로 증거를 다시 써 land 한다(`gateAt` 으로 앞 base-stale 시도를 소비) — 관측 `rejudge-on-head {step:'regate', reason:'base-stale-overlap …'}`.
 * - TA-REJUDGE-REBASE-LOOP: 그 1회가 «같은 base» 로 돌아오거나 stale 재게이트에 `baseCommit` 이 없으면 needs-owner 로 멈추지 않는다. origin/main 을
 *   fetch 한 뒤 PR 가지에 3-way merge(rerere 켬 · ⛔ rebase/force-push/reset/파일째 checkout) 하고 일반 push 로 새 머리를 만든 다음, 그 머리는 기존
 *   ①②③ 사슬을 탄다. 머리마다 1회 · 카드당 `CATCH_UP_CAP`(기본 2)회. 충돌이면 `merge --abort` ⊕ needs-owner(`main 따라잡기 충돌 · 파일 …`).
 *   관측 `rejudge-on-head {step:'catch-up', decision: pushed|conflict|cap-reached, fromBase, toBase, newHead}`.
 * - 대상: 카드에 묶인 PR(URL 로 저장소 확인) ⊕ 기존 TA 리뷰 또는 원격 부모→자식 간선·같은 PR·자식 run-status 종결 증거.
 * - 사람의 hold(draft PR)는 뒤집지 않는다 — 재게이트(`noMerge`)와 land 관문이 draft 를 거부한다.
 * - 허용: 설정 `taskAgent.liveMoves` 그대로 — 재게이트·land 는 `propose-land`, 리뷰 재요청은 `review` 가 있을 때만(없으면 «했을 수»).
 * - 관측: `task-agent` · `rejudge-on-head {card, pr, fromHead, toHead, step, decision, reason}` — 수가 난 판단은 카드 history 에도
 *   한 줄(`event:'rejudge-on-head'` · 같은 머리·같은 단계·같은 판단은 한 번).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { loadRunLedger, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import type { DetachedSpawn } from '../cli/tasks-cli.js';
import { remoteLedgerMirrorDir } from './parent-host.js';
import { appendLandOrderRow, joinLandOrderRow } from './land-order-ledger.js';
import { recordLiveMoveHistory } from './live-move-history.js';
import { runRepairCycle, type RepairLaunchRequest } from './repair-cycle.js';
import { repairMustFixFromReview, repairReviewDigest } from './repair-review.js';
import type { RepairCasOutcome, RepairCasRequest } from './repair-branch-cas.js';
import { defaultLandPrHead, defaultPrHead, defaultReviewRepoCandidates, executeLiveLand, executeLiveReview, landRetryPending, type LiveMoveDeps, type LiveMoveResult, type PrHeadView, type ReviewRepoCandidate, type TaskAgentLiveMove } from './live-moves.js';
import { capturedLandReview, captureReviewResults, parseReviewResultOutput, pendingReviewResults, reviewResultPath, type ParsedReviewResult } from './review-result-capture.js';
import { boundPrTerminal, cardPrNumber, LIVE_MOVE_RESULT_EVENT, readTaskCard, taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';

export const REJUDGE_ON_HEAD_EVENT = 'rejudge-on-head';
/** 카드·PR 당 재게이트하는 머리 수 상한(머리가 바뀔 때마다 하나) — 넘으면 멈추고 사람에게 넘긴다. */
export const REJUDGE_HEAD_CAP = 3;
/** 카드당 origin/main 따라잡기(merge⊕push) 상한 — 넘으면 멈추고 사람에게 넘긴다. 머리마다 1회. */
export const CATCH_UP_CAP = 2;
/** 떼어 띄운 재게이트 결과를 기다리는 상한 — 지나도 파일이 없으면 «결과 없음»으로 적는다(같은 머리는 다시 안 돌린다). */
export const REGATE_RESULT_WAIT_MS = 90 * 60_000;

export type RejudgeStep = 'regate' | 'review' | 'ready' | 'land' | 'target' | 'catch-up' | 'repair';
export type CatchUpDecision = 'pushed' | 'conflict' | 'cap-reached' | 'failed';
export interface RejudgeOutcome {
  card: string; pr: number | null; fromHead: string | null; toHead: string | null; step: RejudgeStep; decision: string; reason: string;
  fromBase?: string; toBase?: string; newHead?: string;
}

export interface RegateRequest { card: string; pr: number; head: string; repoRoot: string; resultPath: string }
export interface CatchUpRequest { cwd: string; pr: number; head: string; branch?: string; fromBase?: string; worktreePath?: string }
export interface CatchUpResult {
  decision: Exclude<CatchUpDecision, 'cap-reached'>;
  reason: string;
  fromBase?: string;
  toBase?: string;
  newHead?: string;
  files?: string[];
  pushArgs?: string[];
}
export type CatchUpGit = (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
export interface RejudgeDeps {
  live?: LiveMoveDeps;
  liveMoves: ReadonlySet<TaskAgentLiveMove>;
  /** Only phase ① shadow callbacks may inspect a previously judged head without a regate. */
  shadowSameHead?: boolean;
  /** HQ mirror proof that the bound remote child has stopped. Test seam; absence fails closed. */
  remoteRunTerminal?: (card: TaskCard) => boolean;
  /** Make a reviewed draft PR ready; tests inject this instead of calling gh. */
  readyPr?: (pr: number, cwd: string) => Promise<{ ok: boolean; reason: string }>;
  /** 재게이트를 떼어 띄운다 — 시험은 주입한다. 기본은 `tasks regate-run` 자식(stdio ignore · 결과는 파일). */
  requestRegate?: (request: RegateRequest) => Promise<void>;
  /** Source PR/head repair worker; absent uses the detached HQ local parent. */
  requestRepair?: (request: RepairLaunchRequest) => Promise<void>;
  applyRepair?: (request: RepairCasRequest) => RepairCasOutcome;
  notifyRepair?: (seat: string, body: string) => void;
  /** TA-REJUDGE-REBASE-LOOP — origin/main 을 PR 가지에 3-way merge 하고 일반 push. 시험은 주입한다. */
  catchUpMain?: (request: CatchUpRequest) => Promise<CatchUpResult>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 시험 seam — 결과 파일 읽기(없으면 ENOENT). */
  readFile?: (path: string) => string;
}

/** PR binding alone does not mean a remote parent has stopped. Require its child edge and terminal ledger row. */
export function remoteBoundRunTerminal(card: TaskCard, load: (runId: string, dir: string) => RunLedgerEntry[] | null = loadRunLedger): boolean {
  const pr = cardPrNumber(card);
  const url = typeof card.pr === 'object' ? card.pr.url : undefined;
  if (card.status !== 'launched' || card.taLand !== true || !card.parentHost || !card.runId || !card.runChildId || !pr || !url) return false;
  try {
    const dir = remoteLedgerMirrorDir(prodInstanceRoot(), card.parentHost.host);
    const parent = load(card.runId, dir);
    if (!parent?.some((entry) => entry.event === 'pod-child-run' && entry.data?.childRunId === card.runChildId)) return false;
    const child = load(card.runChildId, dir);
    return !!child?.some((entry) => entry.event === 'pr-opened' && entry.data?.number === pr && entry.data.url === url)
      && child.some((entry) => entry.event === 'run-status' && ['completed', 'failed', 'cancelled'].includes(String(entry.data?.runStatus)));
  } catch { return false; }
}

/** Shared completion callback for detached review and regate workers. */
type CompletedWorker = { pr: number; head: string; kind?: 'review' | 'regate'; resultPath?: string };

export async function rejudgeAsyncResultCard(
  cardId: string, statePath: string,
  external: Pick<LiveMoveDeps, 'repoCandidates' | 'prHead' | 'landPrHead' | 'land' | 'landWorktree' | 'requestReview'>
    & Pick<RejudgeDeps, 'requestRegate'> = {},
  completed?: CompletedWorker,
): Promise<RejudgeOutcome[]> {
  const { requestRegate, ...live } = external;
  return rejudgeShadowCard(cardId, statePath, { live, requestRegate }, completed);
}

export async function rejudgeShadowCard(cardId: string, statePath: string, deps: Partial<RejudgeDeps> = {}, completed?: CompletedWorker): Promise<RejudgeOutcome[]> {
  // TA-LAND-AFTER-REVIEW phase ①: completion paths observe the decision but execute no
  // regate/review/land move. A post-landing canary will gate the separate live switch.
  const outcomes = await rejudgeCardOnHead(cardId, { ...deps, liveMoves: new Set(), shadowSameHead: true, live: { ...deps.live, statePath } });
  requireSuccessfulRejudge(outcomes);
  if (completed) requireCompletedHeadRejudge(outcomes, completed.pr, completed.head);
  const last = outcomes.at(-1);
  if (last) {
    const decision = last.decision === 'would-land' ? 'land' : last.decision;
    let claimed = false;
    try {
      updateTaskCard(statePath, cardId, (current) => {
        if (!current || current.status !== 'launched' || current.taLand !== true || last.pr === null
          || cardPrNumber(current) !== last.pr || !last.toHead || !/^[0-9a-f]{40}$/i.test(last.toHead)
          || (completed?.kind && (!completed.resultPath || !(completed.kind === 'review' ? current.reviewRequests : current.regates)
            ?.some((entry) => entry.pr === completed.pr && sameHead(entry.head, completed.head) && entry.resultPath === completed.resultPath)))
          || (decision === 'land' && (!capturedLandReview(current, last.pr, last.toHead)
            || !(current.regates ?? []).some((entry) => entry.pr === last.pr && sameHead(entry.head, last.toHead!) && entry.passed === true && entry.resultPath)))
          || (current.history ?? []).some((item) => item.event === 'rejudge-shadow' && item.pr === last.pr && item.head === last.toHead && item.effect === decision)) return undefined;
        claimed = true;
        return { ...current, history: [...(current.history ?? []), { at: new Date().toISOString(), event: 'rejudge-shadow', pr: last.pr, head: last.toHead ?? undefined, effect: decision, detail: last.reason }] };
      });
      if (claimed) debug.log('task-agent', 'rejudge-shadow', {
        card: cardId, head12: last.toHead?.slice(0, 12) ?? null, decision, reason: last.reason,
      });
    } catch { /* observation must not change completion */ }
  }
  return outcomes;
}

/** A completed callback must not claim success when the rejudge returned a failed move. */
export function requireSuccessfulRejudge(result: unknown): void {
  if (result == null || (Array.isArray(result) && result.length === 0)) throw new Error('task-agent rejudge returned no decision');
  if (result === false || (result && typeof result === 'object' && !Array.isArray(result)
    && ('ok' in result && result.ok === false || 'success' in result && result.success === false))) {
    throw new Error('task-agent rejudge returned failure');
  }
  if (!Array.isArray(result)) throw new Error('task-agent rejudge returned no decision array');
  const failed = result.find((item) => {
    if (item && typeof item === 'object' && 'ok' in item && item.ok === false) return true;
    const decision = item && typeof item === 'object' && 'decision' in item ? item.decision : undefined;
    return typeof decision === 'string' && (decision.endsWith('-failed') || decision.endsWith('-rejected')
      || ['no-pr', 'card-unreadable', 'conflict', 'cap-reached'].includes(decision));
  });
  if (failed) throw new Error(`task-agent rejudge returned failure: ${String(failed.decision ?? 'ok:false')}`);
}

/** A completion marker belongs to the exact PR head whose worker result triggered it. */
export function requireCompletedHeadRejudge(result: unknown, pr: number, head: string): void {
  requireSuccessfulRejudge(result);
  const last = Array.isArray(result) ? result.at(-1) : undefined;
  if (!last || typeof last !== 'object' || last.pr !== pr || typeof last.toHead !== 'string'
    || !/^[0-9a-f]{40}$/i.test(last.toHead) || !sameHead(last.toHead, head)) {
    throw new Error('task-agent rejudge result head does not match completed worker head');
  }
}

const regateRejudgeInFlight = new Set<string>();

/** Regate worker has written the exact result file; claim one callback for its card/head/result. */
export async function rejudgeCompletedTaskRegate(
  cardId: string, pr: number, head: string, resultPath: string, statePath: string,
  rejudge: (cardId: string, statePath: string) => Promise<unknown> = rejudgeAsyncResultCard,
  rejudgeDeps?: Partial<RejudgeDeps>,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/i.test(head)) return false;
  const key = `${statePath}\0${cardId}\0${pr}\0${head}\0${resultPath}`;
  if (regateRejudgeInFlight.has(key)) return false;
  const card = readTaskCard(cardId, statePath);
  if (card?.status !== 'launched' || card.taLand !== true || cardPrNumber(card) !== pr
    || !(card.regates ?? []).some((entry) => entry.pr === pr && sameHead(entry.head, head) && entry.resultPath === resultPath && entry.passed === undefined)
    || (card.history ?? []).some((entry) => entry.event === 'async-result-rejudge' && entry.pr === pr && sameHead(entry.head ?? '', head) && entry.resultPath === resultPath)) return false;
  let text: string;
  try { text = readFileSync(resultPath, 'utf8'); } catch { return false; }
  const parsed = parseRegateResult(text, pr, head);
  if (!parsed) return false;
  regateRejudgeInFlight.add(key);
  try {
    const run = () => rejudgeDeps
      ? rejudgeShadowCard(cardId, statePath, rejudgeDeps, { pr, head, kind: 'regate', resultPath })
      : rejudge === rejudgeAsyncResultCard ? rejudgeAsyncResultCard(cardId, statePath, {}, { pr, head, kind: 'regate', resultPath }) : rejudge(cardId, statePath);
    try { requireCompletedHeadRejudge(await run(), pr, head); } catch { requireCompletedHeadRejudge(await run(), pr, head); } // Bounded retry; no marker on failed outcomes.
    updateTaskCard(statePath, cardId, (current) => parsed.passed === true && current?.status === 'launched' && current.taLand === true && cardPrNumber(current) === pr
      && (current.regates ?? []).some((entry) => entry.pr === pr && sameHead(entry.head, head) && entry.resultPath === resultPath
        && (entry.passed === undefined || entry.passed === parsed.passed))
      && !(current.history ?? []).some((entry) => entry.event === 'async-result-rejudge' && entry.pr === pr && sameHead(entry.head ?? '', head) && entry.resultPath === resultPath)
      ? { ...current, history: [...(current.history ?? []), { at: new Date().toISOString(), event: 'async-result-rejudge', kind: 'regate', pr, head, resultPath, effect: 'completion callback succeeded' }] }
      : undefined);
  } finally {
    regateRejudgeInFlight.delete(key);
  }
  return true;
}

const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
export function regateResultPath(statePath: string, cardId: string, pr: number, head: string, staleBase?: string): string {
  const suffix = staleBase ? `-from-${safe(staleBase.slice(0, 12))}` : '';
  return join(dirname(statePath), 'regate-results', `${safe(cardId)}-${pr}-${safe(head.slice(0, 12))}${suffix}.json`);
}

function readyRegateResultPath(statePath: string, cardId: string, pr: number, head: string): string {
  return regateResultPath(statePath, cardId, pr, head).replace(/\.json$/, '-after-ready.json');
}

export async function defaultReadyPr(pr: number, cwd: string): Promise<{ ok: boolean; reason: string }> {
  const run = (env: NodeJS.ProcessEnv) => spawnSync('gh', ['pr', 'ready', String(pr)], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  let result = run(process.env);
  if (result.status !== 0) {
    const noProxy = { ...process.env };
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete noProxy[key];
    result = run(noProxy);
  }
  return { ok: result.status === 0, reason: (result.stderr || result.stdout || `gh pr ready exit ${result.status ?? 'unknown'}`).trim().slice(-200) };
}

/** REJUDGE base-stale — 이 재게이트(요청 시각 `since`) «뒤»에 같은 머리 land 가 base-stale 로 거절된 마지막 시도. */
export function baseStaleAttemptAfter(card: Pick<TaskCard, 'landAttempts'>, pr: number, head: string, since: string): NonNullable<TaskCard['landAttempts']>[number] | undefined {
  const from = Date.parse(since);
  return (card.landAttempts ?? []).filter((entry) => entry.pr === pr && entry.head.toLowerCase() === head.toLowerCase() && entry.ok === false
    && entry.class === 'base-stale' && Number.isFinite(from) && Date.parse(entry.at) >= from).at(-1);
}
export function overlapEvidencePath(statePath: string, cardId: string, pr: number, head: string): string {
  return join(dirname(statePath), 'overlap-evidence', `${safe(cardId)}-${pr}-${safe(head.slice(0, 12))}.json`);
}

/** `tasks regate-run` 자식 argv — 같은 우주 · 같은 진입점. */
export function regateRunArgs(entry: string, configDir: string, request: RegateRequest): string[] {
  return [entry, '--config-dir', configDir, 'tasks', 'regate-run', '--card', request.card, '--pr', String(request.pr), '--head', request.head, '--repo', request.repoRoot, '--out', request.resultPath];
}

export async function defaultRequestRegate(request: RegateRequest, opts: { spawn?: DetachedSpawn; entry?: string; configDir?: string } = {}): Promise<void> {
  const { spawnDetachedConfirmed, ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const configDir = opts.configDir ?? getElanousConfigDirOverride() ?? effectiveInstanceRoot();
  await spawnDetachedConfirmed(opts.spawn ?? (spawn as unknown as DetachedSpawn), process.execPath, regateRunArgs(opts.entry ?? ELANOUS_CLI_ENTRY, configDir, request), undefined, request.repoRoot);
}

/** 재게이트 결과 파일 — `tasks regate-run` 이 쓴다. */
export interface RegateResultFile { pr: number; head: string; passed: boolean; status?: string; baseCommit?: string; failures?: Array<{ step: string; detail: string }> }

export function parseRegateResult(text: string, pr: number, head: string): RegateResultFile | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<RegateResultFile>;
  if (v.pr !== pr || typeof v.head !== 'string' || v.head.toLowerCase() !== head.toLowerCase() || typeof v.passed !== 'boolean') return null;
  // 모양이 틀린 칸은 결과로 받지 않는다(회수 중 예외로 다른 카드 판단까지 멈추지 않게) — 상한 뒤 «결과 없음»으로 적힌다.
  if (v.baseCommit !== undefined && (typeof v.baseCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(v.baseCommit))) return null;
  if (v.status !== undefined && typeof v.status !== 'string') return null;
  if (v.failures !== undefined && (!Array.isArray(v.failures) || !v.failures.every((f) => f && typeof f.step === 'string' && typeof f.detail === 'string'))) return null;
  return v as RegateResultFile;
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
const sameHead = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const defaultCatchUpGit: CatchUpGit = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};

export function catchUpWorktreePath(statePath: string, cardId: string, pr: number, head: string): string {
  return join(dirname(statePath), 'catch-up-worktrees', `${safe(cardId)}-${pr}-${safe(head.slice(0, 12))}`);
}

const gitSha = (text: string): string | null => {
  const value = text.trim();
  return /^[0-9a-f]{40}$/i.test(value) ? value : null;
};

const catchUpFail = (reason: string, extra: Partial<CatchUpResult> = {}): CatchUpResult => ({ decision: 'failed', reason, ...extra });

/**
 * origin/main 을 PR 머리에 3-way merge(rerere 켬) 하고 일반 push 한다.
 * ⛔ rebase · force-push · reset · 남의 가지 파일째 checkout — 충돌이면 merge --abort.
 */
export async function defaultCatchUpMain(request: CatchUpRequest, git: CatchUpGit = defaultCatchUpGit): Promise<CatchUpResult> {
  const repo = request.cwd;
  const work = request.worktreePath ?? join(tmpdir(), `ta-catch-up-${request.pr}-${safe(request.head.slice(0, 12))}-${process.pid}`);
  const gitRepo = (args: string[]) => git(repo, args);
  const gitWork = (args: string[]) => git(work, args);
  const fromBase = request.fromBase;
  if (!request.branch) return catchUpFail('PR head branch name unknown', { fromBase });

  const fetchMain = gitRepo(['fetch', 'origin', 'refs/heads/main']);
  if (fetchMain.status !== 0) return catchUpFail(`origin/main fetch failed: ${(fetchMain.stderr || fetchMain.stdout).trim().slice(-200)}`, { fromBase });
  const toBase = gitSha(gitRepo(['rev-parse', 'FETCH_HEAD']).stdout);
  if (!toBase) return catchUpFail('origin/main sha unreadable', { fromBase });

  const fetchPr = gitRepo(['fetch', 'origin', `pull/${request.pr}/head`]);
  if (fetchPr.status !== 0) return catchUpFail(`fetch pull/${request.pr}/head failed: ${(fetchPr.stderr || fetchPr.stdout).trim().slice(-200)}`, { fromBase, toBase });
  const fetchedHead = gitSha(gitRepo(['rev-parse', 'FETCH_HEAD']).stdout);
  if (!fetchedHead || !sameHead(fetchedHead, request.head)) {
    return catchUpFail(`fetched PR head ${(fetchedHead ?? '?').slice(0, 12)} ≠ ${request.head.slice(0, 12)}`, { fromBase, toBase });
  }

  const added = gitRepo(['worktree', 'add', '--detach', work, request.head]);
  if (added.status !== 0) return catchUpFail(`worktree add failed: ${(added.stderr || added.stdout).trim().slice(-200)}`, { fromBase, toBase });
  const cleanup = () => { gitRepo(['worktree', 'remove', '--force', work]); };

  gitWork(['config', 'rerere.enabled', 'true']);
  const merge = gitWork(['merge', '--no-ff', toBase, '-m', `catch-up: merge origin/main into PR #${request.pr}`]);
  if (merge.status !== 0) {
    const files = gitWork(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    gitWork(['merge', '--abort']);
    cleanup();
    return {
      decision: 'conflict',
      reason: `main 따라잡기 충돌 · 파일 ${files.join(', ') || '(unknown)'}`,
      fromBase, toBase, files,
    };
  }
  const newHead = gitSha(gitWork(['rev-parse', 'HEAD']).stdout);
  if (!newHead) { cleanup(); return catchUpFail('merge produced no head sha', { fromBase, toBase }); }
  const pushArgs = ['push', 'origin', `HEAD:${request.branch}`];
  const push = gitWork(pushArgs);
  cleanup();
  if (push.status !== 0) return catchUpFail(`push failed: ${(push.stderr || push.stdout).trim().slice(-200)}`, { fromBase, toBase, newHead, pushArgs });
  return {
    decision: 'pushed',
    reason: `merged origin/main ${toBase.slice(0, 12)} → head ${newHead.slice(0, 12)}`,
    fromBase, toBase, newHead, pushArgs,
  };
}

/** 실제로 «시도한» 따라잡기 기록(pushed·conflict·failed) — `cap-reached`·`would-catch-up` 표지는 시도가 아니다. */
const CATCH_UP_ATTEMPT_EFFECTS: ReadonlySet<string> = new Set(['pushed', 'conflict', 'failed']);

function catchUpHistory(card: Pick<TaskCard, 'history'>, pr: number) {
  return (card.history ?? []).filter((item) => item.event === REJUDGE_ON_HEAD_EVENT && item.kind === 'catch-up' && item.pr === pr
    && typeof item.effect === 'string' && CATCH_UP_ATTEMPT_EFFECTS.has(item.effect));
}

/** 카드의 PR URL 과 같은 PR 을 돌려주는 후보 저장소 — 못 찾으면 이유. */
async function resolveCardPr(card: TaskCard, pr: number, url: string, deps: LiveMoveDeps): Promise<{ cwd: string; view: PrHeadView } | { reason: string }> {
  let candidates: readonly ReviewRepoCandidate[];
  try { candidates = (deps.repoCandidates ?? defaultReviewRepoCandidates)(card); } catch { candidates = []; }
  const misses: string[] = [];
  for (const candidate of candidates) {
    let view: PrHeadView | null;
    try { view = await (deps.prHead ?? defaultPrHead)(pr, candidate.cwd); } catch { view = null; }
    if (!view) { misses.push(`${candidate.source}: unreadable`); continue; }
    if (!view.url || !sameUrl(view.url, url)) { misses.push(`${candidate.source}: url ${view.url ?? 'none'}`); continue; }
    return { cwd: candidate.cwd, view };
  }
  return { reason: candidates.length ? misses.join(' · ') : 'no target repository (card project · harness.defaultRepo · host checkout)' };
}

/** 카드 하나를 다시 판단한다 — 던지지 않는다. 돌려주는 것은 이번 틱에 난 판단들(단계 순). */
export async function rejudgeCardOnHead(cardId: string, deps: RejudgeDeps): Promise<RejudgeOutcome[]> {
  const live = deps.live ?? {};
  const statePath = live.statePath ?? taskAgentStatePath();
  const now = () => (live.now ?? (() => new Date()))();
  const log = deps.log ?? ((c: string, e: string, d: Record<string, unknown>) => debug.log(c, e, d));
  const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const outcomes: RejudgeOutcome[] = [];
  const emit = (o: RejudgeOutcome, record: boolean): void => {
    outcomes.push(o);
    try { log('task-agent', REJUDGE_ON_HEAD_EVENT, { ...o }); } catch { /* fail-soft */ }
    if (!record || o.pr === null) return;
    try {
      updateTaskCard(statePath, o.card, (current) => {
        if (!current) return undefined;
        const detail = `${o.fromHead ? o.fromHead.slice(0, 12) : '-'} → ${o.toHead ? o.toHead.slice(0, 12) : '-'} · ${o.reason}`;
        // 같은 머리·같은 단계·같은 판단·같은 사유는 한 줄만 — 틱마다 쌓지 않되, 사유가 바뀌면 새 줄로 남긴다.
        if ((current.history ?? []).some((item) => item.event === REJUDGE_ON_HEAD_EVENT && item.pr === o.pr && item.head === (o.toHead ?? undefined) && item.kind === o.step && item.effect === o.decision && item.detail === detail)) return undefined;
        return { ...current, history: [...(current.history ?? []), {
          at: now().toISOString(), event: REJUDGE_ON_HEAD_EVENT, kind: o.step, pr: o.pr!, ...(o.toHead ? { head: o.toHead } : {}), effect: o.decision, detail,
        }] };
      });
    } catch (error) {
      try { log('task-agent', 'rejudge-on-head-history-failed', { card: o.card, reason: (error instanceof Error ? error.message : String(error)).slice(-300) }); } catch { /* fail-soft */ }
    }
  };
  const target = (decision: string, reason: string, pr: number | null = null, fromHead: string | null = null, toHead: string | null = null, record = false) => {
    emit({ card: cardId, pr, fromHead, toHead, step: 'target', decision, reason }, record);
    return outcomes;
  };

  // 지난 리뷰 결과부터 회수한다 — 같은 틱의 판단이 그 결과를 본다.
  try { captureReviewResults(statePath, { cardIds: [cardId], ...(live.now ? { now: live.now } : {}), log }); } catch { /* 회수는 스스로 관측한다 */ }
  let card: TaskCard | undefined;
  try { card = readTaskCard(cardId, statePath); } catch (error) { return target('card-unreadable', String(error).slice(-200)); }
  const pr = card ? cardPrNumber(card) : undefined;
  if (!card || pr === undefined) return target('no-pr', 'card has no bound PR');
  const reviews = (card.reviewRequests ?? []).filter((entry) => entry.pr === pr);
  // 원격 부모는 node-b 의 liveMoves 가 꺼져 리뷰 이력이 0일 수 있다. HQ 거울의 종결 증거가 있을 때만 시작한다.
  const adopted = card.adoptedPr?.pr === pr && typeof card.pr === 'object'
    && !!card.pr.url && sameUrl(card.adoptedPr.url, card.pr.url) && /^[a-f0-9]{40}$/i.test(card.adoptedPr.head);
  if (!reviews.length && !adopted && (!card.parentHost || !(deps.remoteRunTerminal ?? remoteBoundRunTerminal)(card)))
    return target('not-started', 'no task-agent review on this PR yet (remote terminal unproven or run not stopped/judged)', pr);
  // 떼어 띄운 재게이트 결과를 «머리와 무관하게» 먼저 회수한다 — 결과가 나오기 전에 머리가 또 바뀌어도 그 머리의 결과는 카드에 남는다.
  for (const pending of (card.regates ?? []).filter((entry) => entry.pr === pr && entry.passed === undefined && entry.resultPath)) {
    let text: string | null = null;
    try { text = read(pending.resultPath!); } catch { text = null; }
    const result = text !== null ? parseRegateResult(text, pr, pending.head) : null;
    const waited = now().getTime() - Date.parse(pending.at);
    if (!result && !(waited >= REGATE_RESULT_WAIT_MS)) continue;
    const patch = result
      ? { passed: result.passed, ...(result.status ? { status: result.status } : {}), ...(result.baseCommit ? { baseCommit: result.baseCommit } : {}),
        detail: result.passed ? 'passed' : `${result.failures?.[0]?.step ?? 'unknown'}: ${(result.failures?.[0]?.detail ?? '').replace(/\s+/g, ' ').slice(0, 200)}` }
      : { passed: false, status: 'no-result', detail: `regate process produced no result after ${Math.round(waited / 60_000)}m` };
    let wrote = false;
    updateTaskCard(statePath, card.id, (current) => {
      if (!current?.regates?.some((entry) => entry.pr === pr && entry.head === pending.head && entry.at === pending.at && entry.passed === undefined)) return undefined;
      wrote = true;
      return { ...current, regates: current.regates.map((entry) => entry.pr === pr && entry.head === pending.head && entry.at === pending.at ? { ...entry, ...patch } : entry) };
    });
    if (wrote) emit({ card: card.id, pr, fromHead: null, toHead: pending.head, step: 'regate', decision: patch.passed ? 'regate-passed' : 'regate-failed',
      reason: `head ${pending.head.slice(0, 12)} · base ${(patch as { baseCommit?: string }).baseCommit?.slice(0, 12) ?? '-'} · ${patch.detail}` }, true);
  }
  card = readTaskCard(card.id, statePath) ?? card;
  const regates = (card.regates ?? []).filter((entry) => entry.pr === pr);
  // 런 멈춤 때 판단한 머리 — 리뷰 요청 중 «재판정이 낸 것»(history `rejudge-on-head` review-requested)을 뺀 마지막(Pod 재게이트가 잰 머리).
  //   재판정이 낸 리뷰만 있는 머리는 아직 재게이트하지 않은 «새» 머리다(허용이 나중에 켜져도 재게이트·land 로 간다).
  const rejudgeReviewed = new Set((card.history ?? []).filter((item) => item.event === REJUDGE_ON_HEAD_EVENT && item.kind === 'review' && item.effect === 'review-requested' && item.pr === pr && item.head)
    .map((item) => item.head!.toLowerCase()));
  const judgedHead = reviews.filter((entry) => !rejudgeReviewed.has(entry.head.toLowerCase())).at(-1)?.head ?? null;
  // «마지막으로 재게이트한 머리» — 카드에 재게이트 기록이 없으면 런 멈춤 때 판단한 머리.
  const fromHead = regates.at(-1)?.head ?? judgedHead;
  const url = typeof card.pr === 'object' ? card.pr.url : undefined;
  if (!url) return target('pr-url-unknown', 'card PR has no URL — repository unconfirmed, no gh/regate/review/land', pr, fromHead, null, true);
  const found = await resolveCardPr(card, pr, url, live);
  if ('reason' in found) return target('pr-unreadable', found.reason, pr, fromHead);
  const { cwd, view } = found;
  const toHead = view.head;
  if (view.state === 'MERGED' || view.state === 'CLOSED') {
    const at = now().toISOString();
    updateTaskCard(statePath, card.id, (current) => {
      if (!current || cardPrNumber(current) !== pr || typeof current.pr !== 'object' || current.pr.url !== url) return undefined;
      const previous = boundPrTerminal(current);
      if (previous?.state === view.state && previous.head === toHead) return undefined;
      return { ...current, prTerminal: { pr, url, head: toHead, state: view.state as 'MERGED' | 'CLOSED', at } };
    });
    return target('pr-not-open', `PR #${pr} is ${view.state}`, pr, fromHead, toHead);
  }
  if (view.state !== 'OPEN') return target('pr-not-open', `PR #${pr} is ${view.state}`, pr, fromHead, toHead);
  // An explicitly rejudged PR can be reopened. Clear the old marker before normal head judgement.
  if (boundPrTerminal(card)) {
    updateTaskCard(statePath, card.id, (current) => current && cardPrNumber(current) === pr && typeof current.pr === 'object' && current.pr.url === url
      ? { ...current, prTerminal: undefined } : undefined);
    card = readTaskCard(card.id, statePath) ?? card;
  }
  const step = (s: RejudgeStep, decision: string, reason: string, record: boolean, extra: Partial<RejudgeOutcome> = {}) =>
    emit({ card: card!.id, pr, fromHead, toHead, step: s, decision, reason, ...extra }, record);

  // Adoption is a first judgement for the current head, even when the implementation run
  // already asked for a review. A captured failure needs repair; an accepted result must
  // reach the host regate instead of stopping at the old same-head shortcut below.
  const adoptedReview = adopted ? (card.history ?? []).filter((item) => item.event === LIVE_MOVE_RESULT_EVENT
    && item.kind === 'review' && item.pr === pr && item.head && sameHead(item.head, toHead)
    && item.reviewed === true && ['pass', 'warn', 'fail'].includes(item.verdict ?? '')).at(-1) : undefined;
  if (adopted && !adoptedReview) {
    if (reviews.some((entry) => sameHead(entry.head, toHead))) {
      step('review', 'review-pending', `PR #${pr} head ${toHead.slice(0, 12)} already has a review request; await its result`, false);
    } else if (!deps.liveMoves.has('review')) {
      step('review', 'would-review', 'adopted PR first judgement · review not enabled in HQ taskAgent.liveMoves — shadow', false);
    } else {
      const before = { reviewRequests: card.reviewRequests, landAttempts: card.landAttempts };
      const result = await executeLiveReview(card, pr, { runId: card.runId ?? null, stopReason: 'adopted-pr-first-judgement', cwd }, { ...live, ...(deps.log ? { log: deps.log } : {}) });
      recordMove(statePath, card.id, card.runId, 'review', result, pr, before, now, deps.log);
      step('review', result.executed ? 'review-requested' : 'review-request-failed', result.detail, true);
    }
    return outcomes;
  }
  const capturedForHead = (card.history ?? []).filter((item) => item.event === LIVE_MOVE_RESULT_EVENT
    && item.kind === 'review' && item.pr === pr && item.head && sameHead(item.head, toHead)
    && item.reviewed === true && ['pass', 'warn', 'fail'].includes(item.verdict ?? '')).at(-1);
  if (capturedForHead && (capturedForHead.verdict === 'fail' || (capturedForHead.mustFix ?? 0) > 0)) {
    const capturedPath = capturedForHead.resultPath;
    const requestMatches = !!capturedPath && (card.reviewRequests ?? []).some((entry) => entry.pr === pr
      && sameHead(entry.head, toHead) && entry.resultPath === capturedPath);
    let mustFix: string[] | null = null;
    try {
      if (requestMatches && /^[0-9a-f]{64}$/.test(capturedForHead.reviewSha256 ?? '')) {
        const text = read(capturedPath!);
        if (repairReviewDigest(text) === capturedForHead.reviewSha256) mustFix = repairMustFixFromReview(text, pr, toHead);
      }
    } catch { /* fail closed below */ }
    if (!mustFix && (deps.liveMoves.has('narrow-relaunch') || deps.liveMoves.has('salvage-relaunch') || deps.liveMoves.has('alternative'))
      && !(card.repairs ?? []).some((entry) => entry.pr === pr && (entry.status === 'requested' || entry.status === 'unconfirmed'))) {
      if (pendingReviewResults(card).some((entry) => entry.pr === pr && sameHead(entry.head, toHead))) {
        step('review', 'review-pending', 'replacement exact-head review pending before repair', false);
        return outcomes;
      }
      const originalPath = reviewResultPath(statePath, card.id, pr, toHead);
      const retried = (card.reviewRequests ?? []).some((entry) => entry.pr === pr && sameHead(entry.head, toHead)
        && entry.resultPath && entry.resultPath !== originalPath);
      if (deps.liveMoves.has('review') && !retried) {
        const before = { reviewRequests: card.reviewRequests, landAttempts: card.landAttempts };
        const result = await executeLiveReview(card, pr, { runId: card.runId ?? null, stopReason: 'captured-review-identity-unavailable', cwd, forceNewReview: true },
          { ...live, ...(deps.log ? { log: deps.log } : {}) });
        recordMove(statePath, card.id, card.runId, 'review', result, pr, before, now, deps.log);
        step('review', result.executed ? 'review-requested' : 'review-request-failed', result.detail, true);
        return outcomes;
      }
      step('repair', 'repair-stopped', 'captured review result identity missing or changed; request a new review', true);
      return outcomes;
    }
    if (mustFix?.length || (card.repairs ?? []).some((entry) => entry.pr === pr && (entry.status === 'requested' || entry.status === 'unconfirmed'))) {
      if (!view.branch) {
        step('repair', 'repair-stopped', 'PR branch name unavailable', true);
        return outcomes;
      }
      const result = await runRepairCycle({ card, statePath, repo: cwd, pr, head: toHead, branch: view.branch,
        mustFix: mustFix ?? [], liveMoves: deps.liveMoves, now: now(), readFile: read,
        ...(deps.requestRepair ? { request: deps.requestRepair } : {}),
        ...(deps.applyRepair ? { apply: deps.applyRepair } : {}),
        ...(deps.notifyRepair ? { notify: deps.notifyRepair } : {}) });
      step('repair', result.decision, result.reason, true);
      return outcomes;
    }
  }
  if (adopted && (adoptedReview?.verdict === 'fail' || !capturedLandReview(card, pr, toHead)
    || capturedLandReview(card, pr, toHead)?.mustFixCount !== 0)) {
    step('review', 'repair-needed', `PR #${pr} head ${toHead.slice(0, 12)} review ${adoptedReview?.verdict ?? 'unknown'} · must-fix ${adoptedReview?.mustFix ?? 'unknown'} — owner repair`, true);
    return outcomes;
  }

  // A remote --ta-land parent leaves its PR draft. Only a captured review for this exact
  // head may let HQ make it ready; the regate runner deliberately rejects draft PRs.
  let readyConfirmed = false;
  const readyReview = card.taLand ? capturedLandReview(card, pr, toHead) : undefined;
  if (readyReview?.mustFixCount === 0 && deps.liveMoves.has('propose-land')) {
    let fresh: Awaited<ReturnType<NonNullable<LiveMoveDeps['landPrHead']>>>;
    try { fresh = await (live.landPrHead ?? defaultLandPrHead)(pr, cwd); } catch { fresh = null; }
    if (!fresh || fresh.state !== 'OPEN' || !sameHead(fresh.head, toHead) || !fresh.url || !sameUrl(fresh.url, url)) {
      step('ready', 'ready-unconfirmed', 'fresh PR head, URL or draft state unavailable — no regate', false);
      return outcomes;
    }
    if (fresh.isDraft) {
      const result = await (deps.readyPr ?? defaultReadyPr)(pr, cwd);
      if (!result.ok) {
        step('ready', 'ready-failed', result.reason, true);
        return outcomes;
      }
      try { fresh = await (live.landPrHead ?? defaultLandPrHead)(pr, cwd); } catch { fresh = null; }
      if (!fresh || fresh.isDraft || fresh.state !== 'OPEN' || !sameHead(fresh.head, toHead) || !fresh.url || !sameUrl(fresh.url, url)) {
        step('ready', 'ready-unconfirmed', 'gh pr ready returned success but the same PR/head is not confirmed ready', true);
        return outcomes;
      }
      step('ready', 'ready-confirmed', `PR #${pr} head ${toHead.slice(0, 12)} is ready after captured review`, true);
    }
    readyConfirmed = true;
  }

  if (!reviews.length) {
    if (!deps.liveMoves.has('review')) step('review', 'would-review', 'remote run terminal proven · review not enabled in HQ taskAgent.liveMoves — shadow', false);
    else {
      const before = { reviewRequests: card.reviewRequests, landAttempts: card.landAttempts };
      const result = await executeLiveReview(card, pr, { runId: card.runId ?? null, stopReason: 'remote-run-terminal', cwd }, { ...live, ...(deps.log ? { log: deps.log } : {}) });
      recordMove(statePath, card.id, card.runId, 'review', result, pr, before, now, deps.log);
      step('review', result.executed ? 'review-requested' : 'review-request-failed', result.detail, true);
    }
    return outcomes;
  }

  const tryCatchUp = async (fromBase: string | undefined, why: string): Promise<boolean> => {
    const prior = catchUpHistory(card!, pr);
    // 상한은 «실제 push» 만 센다 — 충돌·실패 뒤 사람이 새 머리를 올리면 다시 시도할 수 있어야 한다.
    const pushed = prior.filter((item) => item.effect === 'pushed').length;
    if (pushed >= CATCH_UP_CAP) {
      step('catch-up', 'cap-reached', `${why} · catch-up pushed ${pushed} times already (cap ${CATCH_UP_CAP}) — needs owner`, true, { fromBase });
      return true;
    }
    if (prior.some((item) => item.head && sameHead(item.head, toHead))) {
      step('catch-up', 'cap-reached', `${why} · already catch-up on this head — needs owner`, true, { fromBase });
      return true;
    }
    if (!deps.liveMoves.has('propose-land')) {
      step('catch-up', 'would-catch-up', `${why} · propose-land not enabled in taskAgent.liveMoves — shadow`, false, { fromBase });
      return true;
    }
    let result: CatchUpResult;
    try {
      result = await (deps.catchUpMain ?? defaultCatchUpMain)({
        cwd, pr, head: toHead, branch: view.branch, fromBase,
        worktreePath: catchUpWorktreePath(statePath, card!.id, pr, toHead),
      });
    } catch (error) {
      result = { decision: 'failed', reason: `catch-up threw: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`, fromBase };
    }
    const extra: Partial<RejudgeOutcome> = {
      ...(result.fromBase ? { fromBase: result.fromBase } : fromBase ? { fromBase } : {}),
      ...(result.toBase ? { toBase: result.toBase } : {}),
      ...(result.newHead ? { newHead: result.newHead } : {}),
    };
    if (result.decision === 'pushed') {
      step('catch-up', 'pushed', result.reason, true, extra);
      return true;
    }
    if (result.decision === 'conflict') {
      step('catch-up', 'conflict', result.reason, true, extra);
      return true;
    }
    step('catch-up', result.decision, `${why} · ${result.reason} — needs owner`, true, extra);
    return true;
  };

  // 기존 live 경로의 같은 머리 조기 반환은 유지한다. 완료 훅의 그림자 판단만 통과 리뷰를 다시 본다.
  if (!adopted && !regates.length && judgedHead && sameHead(toHead, judgedHead) && !landRetryPending(card, pr, toHead)) {
    const unchangedReview = capturedLandReview(card, pr, toHead);
    if (!deps.shadowSameHead || deps.liveMoves.size !== 0 || !unchangedReview || !['pass', 'warn'].includes(unchangedReview.verdict) || unchangedReview.mustFixCount !== 0) {
      return target('head-unchanged', `PR #${pr} head is still the judged head`, pr, fromHead, toHead);
    }
  }
  // `regates` 는 PR 전체 기록이다. 현재 머리의 결과만 재사용하고, 없으면 재게이트한다.
  const currentHeadRegate = regates.filter((entry) => sameHead(entry.head, toHead)).at(-1);

  // ① 재게이트 — 지금 머리의 «마지막» 기록(REJUDGE base-stale 로 같은 머리를 다시 잰 기록이 뒤에 붙는다).
  const regate = currentHeadRegate;
  // A draft rejection is a stale input after the same PR becomes ready, not a permanent
  // judgement about the code. Retry this exact head once with a separate result path.
  const retryDraft = readyConfirmed && regate?.passed === false && /^pr-head:.*\bisDraft=true\b/.test(regate.detail ?? '')
    && !regates.some((entry) => sameHead(entry.head, toHead) && entry.readyRetry === true);
  // REJUDGE base-stale — 이 머리의 통과한 재게이트로 land 했더니 base-stale-overlap 으로 거절됐다 → 새 base 위에서 한 번 더 잰다.
  const stale = regate?.passed === true ? baseStaleAttemptAfter(card, pr, toHead, regate.at) : undefined;
  const staleBase = stale ? regate?.baseCommit : undefined;
  if (stale && !staleBase) {
    await tryCatchUp(undefined, `base-stale-overlap on head ${toHead.slice(0, 12)} but the stale regate has no baseCommit`);
    return outcomes;
  }
  if (!regate || staleBase || retryDraft) {
    const why = staleBase ? `base-stale-overlap — gate base ${staleBase.slice(0, 12)} went stale (${(stale!.reason ?? '').replace(/^base-stale-overlap:\s*/, '').slice(0, 160)})`
      : retryDraft ? 'draft rejection became stale after PR ready' : '';
    if (regates.length >= REJUDGE_HEAD_CAP) {
      step('regate', 'cap-reached', `${why ? `${why} · ` : ''}re-gated ${regates.length} times already (cap ${REJUDGE_HEAD_CAP}) — no more rejudge; needs owner`, true);
      return outcomes;
    }
    if (!deps.liveMoves.has('propose-land')) step('regate', 'would-regate', `${why ? `${why} · ` : ''}propose-land not enabled in taskAgent.liveMoves — shadow`, false);
    else {
      const at = now().toISOString();
      const resultPath = retryDraft ? readyRegateResultPath(statePath, card.id, pr, toHead)
        : regateResultPath(statePath, card.id, pr, toHead, staleBase);
      let claimed = false;
      let capped = false;
      updateTaskCard(statePath, card.id, (current) => {
        const held = (current?.regates ?? []).filter((entry) => entry.pr === pr);
        // 멱등 — 처음 재게이트는 «머리», base-stale 재게이트는 «머리 ⊕ 낡은 base» 가 키다(같은 머리·같은 base 로 두 번 안 잰다).
        if (!current || held.some((entry) => sameHead(entry.head, toHead) && (staleBase ? entry.staleBase !== undefined && sameHead(entry.staleBase, staleBase)
          : retryDraft ? entry.readyRetry === true : true))) return undefined;
        // 상한은 잠금 안의 «지금» 카드로 다시 잰다 — 다른 머리를 본 두 틱이 겹쳐도 상한을 넘지 않게.
        if (held.length >= REJUDGE_HEAD_CAP) { capped = true; return undefined; }
        claimed = true;
        return { ...current, regates: [...(current.regates ?? []), { pr, head: toHead, at, resultPath, ...(staleBase ? { staleBase } : {}), ...(retryDraft ? { readyRetry: true as const } : {}) }] };
      });
      if (capped) {
        step('regate', 'cap-reached', `${why ? `${why} · ` : ''}re-gated ${REJUDGE_HEAD_CAP} times already (cap ${REJUDGE_HEAD_CAP} · claim-time recheck) — no more rejudge; needs owner`, true);
        return outcomes;
      }
      if (claimed) {
        try {
          mkdirSync(dirname(resultPath), { recursive: true });
          await (deps.requestRegate ?? defaultRequestRegate)({ card: card.id, pr, head: toHead, repoRoot: cwd, resultPath });
          step('regate', 'regate-requested', `${why ? `${why} · re-gate on a new base · ` : ''}host regate (noMerge) launched detached → ${resultPath}`, true);
        } catch (error) {
          const detail = `regate launch failed: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`;
          updateTaskCard(statePath, card.id, (current) => current?.regates?.some((entry) => entry.pr === pr && entry.head === toHead && entry.at === at)
            ? { ...current, regates: current.regates.map((entry) => entry.pr === pr && entry.head === toHead && entry.at === at ? { ...entry, passed: false, status: 'unmeasured', detail } : entry) }
            : undefined);
          step('regate', 'regate-failed', `${why ? `${why} · ` : ''}${detail}`, true);
        }
      }
    }
    // base-stale 재게이트는 그 결과가 나와야 land 한다 — 낡은 base 의 증거로 이번 틱에 다시 land 하지 않는다.
    if (staleBase || retryDraft) return outcomes;
  } else if (regate.passed === undefined) {
    step('regate', 'awaiting-regate-result', 'host regate still running', false);
  }

  // ② 리뷰 — 지금 머리로 요청한 적이 없으면 다시(같은 머리는 한 번 · 상한은 ① 의 머리 수가 이미 막았다).
  if (!reviews.some((entry) => sameHead(entry.head, toHead))) {
    if (!deps.liveMoves.has('review')) step('review', 'would-review', 'review not enabled in taskAgent.liveMoves — shadow', false);
    else {
      const before = { reviewRequests: card.reviewRequests, landAttempts: card.landAttempts };
      const result = await executeLiveReview(card, pr, { runId: card.runId ?? null, stopReason: 'rejudge-on-head', cwd }, { ...live, ...(deps.log ? { log: deps.log } : {}) });
      recordMove(statePath, card.id, card.runId, 'review', result, pr, before, now, deps.log);
      step('review', result.executed ? 'review-requested' : 'review-request-failed', result.detail, true);
    }
    return outcomes;
  }
  const latest = readTaskCard(card.id, statePath) ?? card;
  if (pendingReviewResults(latest).some((entry) => entry.pr === pr && sameHead(entry.head, toHead))) {
    step('review', 'awaiting-review-result', 'review result not captured yet', false);
    return outcomes;
  }
  // TA-LAND-WARN-MUSTFIX0 — 정본 규칙: verdict ∈ {pass, warn} ⊕ reviewed ⊕ must-fix 가 «숫자 0» ⊕ 그 머리(모르면 통과 아님).
  const review = capturedLandReview(latest, pr, toHead);
  if (!review || review.mustFixCount !== 0) {
    step('land', 'not-landing', review ? `review ${review.verdict} carries must-fix ${review.mustFixCount ?? 'unknown'}` : 'no captured review pass/warn for this head', true);
    return outcomes;
  }
  if (!regate || regate.passed !== true) {
    step('land', 'not-landing', regate ? (regate.passed === false ? `host regate not passed: ${regate.detail ?? regate.status ?? 'unknown'}` : 'host regate still running') : 'no host regate for this head', regate?.passed === false);
    return outcomes;
  }
  // REJUDGE base-stale — 새 base 위 재게이트가 «같은» base 로 돌아왔다 → origin/main 따라잡기(merge⊕push) 후 새 머리 재게이트.
  if (regate.staleBase && regate.baseCommit && sameHead(regate.baseCommit, regate.staleBase)) {
    await tryCatchUp(regate.staleBase, `base-stale-overlap — re-gate on head ${toHead.slice(0, 12)} returned the same base ${regate.staleBase.slice(0, 12)} (did not advance)`);
    return outcomes;
  }
  if (!deps.liveMoves.has('propose-land')) { step('land', 'would-land', 'propose-land not enabled in taskAgent.liveMoves — shadow', false); return outcomes; }

  // ③ land — 겹침 증거(#26023 꼴)를 «완전히» 쓴 뒤에만 executeLiveLand 를 그대로 부른다. 증거를 못 갖추면 land 하지 않는다(fail-closed).
  const reviewResult = latest.reviewRequests?.find((entry) => entry.pr === pr && sameHead(entry.head, toHead))?.resultPath;
  if (!reviewResult || !regate.baseCommit || !/^[0-9a-f]{40}$/i.test(regate.baseCommit)) {
    step('land', 'not-landing', `overlap evidence incomplete — ${!reviewResult ? 'review result path missing' : 'regate baseCommit missing'}`, true);
    return outcomes;
  }
  const overlapEvidence = overlapEvidencePath(statePath, card.id, pr, toHead);
  // #26023 꼴 그대로 — 증거 «파일» 내용은 무변 · 아래 원장 조인이 같은 모양을 쓴다(cardId 는 메모리에서만 싣는다).
  const overlapEvidenceContent = { pr, head: toHead, gate: { head: toHead, baseCommit: regate.baseCommit, passed: true }, reviewResult };
  try {
    mkdirSync(dirname(overlapEvidence), { recursive: true });
    // 임시 파일에 쓰고 바꿔 끼운다 — 겹친 틱이 같은 경로를 다시 써도 land 가 반쯤 쓴 JSON 을 읽지 않게.
    const tmp = `${overlapEvidence}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(overlapEvidenceContent, null, 2));
    renameSync(tmp, overlapEvidence);
  } catch (error) {
    step('land', 'not-landing', `overlap evidence write failed: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`, true);
    return outcomes;
  }
  const before = { reviewRequests: latest.reviewRequests, landAttempts: latest.landAttempts };
  // 주기 id — base-stale 재게이트 뒤의 land 는 새 base 를 붙여 앞 land 의 주기 표시(모듈 전역)와 갈린다 · gateAt 이 앞 base-stale 시도를 소비한다.
  const cycleId = `rejudge:${card.id}:${toHead}${regate.staleBase ? `:${regate.baseCommit.slice(0, 12)}` : ''}`;
  const landed = await executeLiveLand(latest, pr, { runId: card.runId ?? null, cycleId, cwd, review, overlapEvidence, gateAt: regate.at },
    { ...live, ...(deps.log ? { log: deps.log } : {}) });
  // LAND-ORDER-LEDGER — executeLiveLand 직후 원장 한 줄(같은 pr+head 는 한 줄만). 쓰기가 실패해도 land 결과는 그대로(삼킨다).
  const landOrderLog = (event: 'appended' | 'append-failed') => { try { log('task-agent.land-order', event, { pr, head: toHead }); } catch { /* fail-soft */ } };
  try {
    // review-results 파일을 못 읽으면 reviewVerdict 'missing' — 0 으로 쓰지 않는다(land 판정의 회수 결과와는 별개 파일).
    let reviewForLedger: ParsedReviewResult | null = null;
    try { reviewForLedger = parseReviewResultOutput(read(reviewResult)); } catch { reviewForLedger = null; }
    appendLandOrderRow(statePath, joinLandOrderRow({ overlapEvidence: { ...overlapEvidenceContent, cardId: card.id }, reviewResult: reviewForLedger, landed, at: now().toISOString() }));
    landOrderLog('appended');
  } catch {
    landOrderLog('append-failed');
  }
  recordMove(statePath, card.id, card.runId, 'propose-land', landed, pr, before, now, deps.log);
  // TA-LAND-RETRY-ON-INFRA — 실패한 시도는 갈래·사유·재시도 여부를 사유 줄에 싣는다(다음 틱이 왜 다시 하는지/안 하는지).
  const attempt = landed.landAttempt?.class
    ? ` · land-class ${landed.landAttempt.class} (${landed.landAttempt.reason}) · attempt ${landed.landAttempt.attempt} · ${landed.landAttempt.class === 'base-stale' ? 'base-stale → re-gate on a new base next tick (cap counts)' : landed.landAttempt.retryAllowed ? 'retry allowed on this head' : 'no retry on this head'}`
    : '';
  step('land', landed.executed && landed.ok ? 'landed'
    : !landed.executed && landed.ok ? 'land-skipped' : 'land-rejected',
  `${landed.detail}${attempt} · overlap-evidence ${overlapEvidence}`, true);
  return outcomes;
}

function recordMove(statePath: string, cardId: string, runId: string | undefined, kind: TaskAgentLiveMove, result: LiveMoveResult, pr: number, before: Pick<TaskCard, 'reviewRequests' | 'landAttempts'>, now: () => Date, log?: RejudgeDeps['log']): void {
  try {
    recordLiveMoveHistory(statePath, cardId, { at: now().toISOString(), kind, executorResult: 'live', result, runId: runId ?? null, pr, before },
      log ? (c, e, d) => log(c, e, d) : undefined);
  } catch { /* recordLiveMoveHistory 는 스스로 관측한다 */ }
}

/** 재판정 대상 카드 — 기존 리뷰 또는 HQ 가 종결 원장을 검증할 원격 부모 카드. */
export function rejudgeCandidates(tasks: Readonly<Record<string, TaskCard>>): string[] {
  return Object.values(tasks).filter((card) => {
    const pr = cardPrNumber(card);
    return pr !== undefined && !boundPrTerminal(card) && ((card.reviewRequests ?? []).some((entry) => entry.pr === pr)
      || (card.status === 'launched' && card.taLand === true && ((!!card.parentHost && !!card.runId && !!card.runChildId)
        || (card.adoptedPr?.pr === pr && typeof card.pr === 'object' && !!card.pr.url && sameUrl(card.adoptedPr.url, card.pr.url)))));
  }).map((card) => card.id);
}
