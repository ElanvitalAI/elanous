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
 * - 상한: 같은 머리는 재게이트·리뷰 각 한 번 · 카드·PR 당 재게이트한 머리 `REJUDGE_HEAD_CAP` 개까지 — 넘으면 사유 줄을 남기고 멈춘다.
 * - 대상: 카드에 묶인 PR(URL 로 저장소 확인) ⊕ 그 PR 로 TA 가 이미 리뷰를 요청한 카드(= 런이 멈춰 TA 판단이 시작됐다).
 * - 사람의 hold(draft PR)는 뒤집지 않는다 — 재게이트(`noMerge`)와 land 관문이 draft 를 거부한다.
 * - 허용: 설정 `taskAgent.liveMoves` 그대로 — 재게이트·land 는 `propose-land`, 리뷰 재요청은 `review` 가 있을 때만(없으면 «했을 수»).
 * - 관측: `task-agent` · `rejudge-on-head {card, pr, fromHead, toHead, step, decision, reason}` — 수가 난 판단은 카드 history 에도
 *   한 줄(`event:'rejudge-on-head'` · 같은 머리·같은 단계·같은 판단은 한 번).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import type { DetachedSpawn } from '../cli/tasks-cli.js';
import { recordLiveMoveHistory } from './live-move-history.js';
import { defaultPrHead, defaultReviewRepoCandidates, executeLiveLand, executeLiveReview, type LiveMoveDeps, type LiveMoveResult, type PrHeadView, type ReviewRepoCandidate, type TaskAgentLiveMove } from './live-moves.js';
import { capturedLandReview, captureReviewResults, pendingReviewResults } from './review-result-capture.js';
import { cardPrNumber, readTaskCard, taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';

export const REJUDGE_ON_HEAD_EVENT = 'rejudge-on-head';
/** 카드·PR 당 재게이트하는 머리 수 상한(머리가 바뀔 때마다 하나) — 넘으면 멈추고 사람에게 넘긴다. */
export const REJUDGE_HEAD_CAP = 3;
/** 떼어 띄운 재게이트 결과를 기다리는 상한 — 지나도 파일이 없으면 «결과 없음»으로 적는다(같은 머리는 다시 안 돌린다). */
export const REGATE_RESULT_WAIT_MS = 90 * 60_000;

export type RejudgeStep = 'regate' | 'review' | 'land' | 'target';
export interface RejudgeOutcome { card: string; pr: number | null; fromHead: string | null; toHead: string | null; step: RejudgeStep; decision: string; reason: string }

export interface RegateRequest { card: string; pr: number; head: string; repoRoot: string; resultPath: string }
export interface RejudgeDeps {
  live?: LiveMoveDeps;
  liveMoves: ReadonlySet<TaskAgentLiveMove>;
  /** 재게이트를 떼어 띄운다 — 시험은 주입한다. 기본은 `tasks regate-run` 자식(stdio ignore · 결과는 파일). */
  requestRegate?: (request: RegateRequest) => Promise<void>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 시험 seam — 결과 파일 읽기(없으면 ENOENT). */
  readFile?: (path: string) => string;
}

const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
export function regateResultPath(statePath: string, cardId: string, pr: number, head: string): string {
  return join(dirname(statePath), 'regate-results', `${safe(cardId)}-${pr}-${safe(head.slice(0, 12))}.json`);
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
  // 런이 멈춰 TA 가 이 PR 을 리뷰한 적이 있어야 재판정한다 — 도는 런의 PR 에 끼어들지 않는다.
  if (!reviews.length) return target('not-started', 'no task-agent review on this PR yet (run not stopped/judged)', pr);
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
  if (view.state !== 'OPEN') return target('pr-not-open', `PR #${pr} is ${view.state}`, pr, fromHead, toHead);
  const step = (s: RejudgeStep, decision: string, reason: string, record: boolean) => emit({ card: card!.id, pr, fromHead, toHead, step: s, decision, reason }, record);

  // 머리가 런 멈춤 때 그대로면 재판정하지 않는다 — 그 머리의 재게이트·리뷰·land 판단은 멈춤 때의 판단(슈퍼바이저 틱)이 이미 했다.
  if (!regates.length && judgedHead && sameHead(toHead, judgedHead)) return target('head-unchanged', `PR #${pr} head is still the judged head`, pr, fromHead, toHead);

  // ① 재게이트 — 지금 머리의 기록.
  const regate = regates.find((entry) => sameHead(entry.head, toHead));
  if (!regate) {
    if (regates.length >= REJUDGE_HEAD_CAP) {
      step('regate', 'cap-reached', `re-gated ${regates.length} heads already (cap ${REJUDGE_HEAD_CAP}) — no more rejudge; needs owner`, true);
      return outcomes;
    }
    if (!deps.liveMoves.has('propose-land')) step('regate', 'would-regate', 'propose-land not enabled in taskAgent.liveMoves — shadow', false);
    else {
      const at = now().toISOString();
      const resultPath = regateResultPath(statePath, card.id, pr, toHead);
      let claimed = false;
      let capped = false;
      updateTaskCard(statePath, card.id, (current) => {
        const held = (current?.regates ?? []).filter((entry) => entry.pr === pr);
        if (!current || held.some((entry) => sameHead(entry.head, toHead))) return undefined;
        // 상한은 잠금 안의 «지금» 카드로 다시 잰다 — 다른 머리를 본 두 틱이 겹쳐도 상한을 넘지 않게.
        if (held.length >= REJUDGE_HEAD_CAP) { capped = true; return undefined; }
        claimed = true;
        return { ...current, regates: [...(current.regates ?? []), { pr, head: toHead, at, resultPath }] };
      });
      if (capped) {
        step('regate', 'cap-reached', `re-gated ${REJUDGE_HEAD_CAP} heads already (cap ${REJUDGE_HEAD_CAP} · claim-time recheck) — no more rejudge; needs owner`, true);
        return outcomes;
      }
      if (claimed) {
        try {
          mkdirSync(dirname(resultPath), { recursive: true });
          await (deps.requestRegate ?? defaultRequestRegate)({ card: card.id, pr, head: toHead, repoRoot: cwd, resultPath });
          step('regate', 'regate-requested', `host regate (noMerge) launched detached → ${resultPath}`, true);
        } catch (error) {
          const detail = `regate launch failed: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`;
          updateTaskCard(statePath, card.id, (current) => current?.regates?.some((entry) => entry.pr === pr && entry.head === toHead && entry.at === at)
            ? { ...current, regates: current.regates.map((entry) => entry.pr === pr && entry.head === toHead && entry.at === at ? { ...entry, passed: false, status: 'unmeasured', detail } : entry) }
            : undefined);
          step('regate', 'regate-failed', detail, true);
        }
      }
    }
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
  if (!deps.liveMoves.has('propose-land')) { step('land', 'would-land', 'propose-land not enabled in taskAgent.liveMoves — shadow', false); return outcomes; }

  // ③ land — 겹침 증거(#26023 꼴)를 «완전히» 쓴 뒤에만 executeLiveLand 를 그대로 부른다. 증거를 못 갖추면 land 하지 않는다(fail-closed).
  const reviewResult = latest.reviewRequests?.find((entry) => entry.pr === pr && sameHead(entry.head, toHead))?.resultPath;
  if (!reviewResult || !regate.baseCommit || !/^[0-9a-f]{40}$/i.test(regate.baseCommit)) {
    step('land', 'not-landing', `overlap evidence incomplete — ${!reviewResult ? 'review result path missing' : 'regate baseCommit missing'}`, true);
    return outcomes;
  }
  const overlapEvidence = overlapEvidencePath(statePath, card.id, pr, toHead);
  try {
    mkdirSync(dirname(overlapEvidence), { recursive: true });
    // 임시 파일에 쓰고 바꿔 끼운다 — 겹친 틱이 같은 경로를 다시 써도 land 가 반쯤 쓴 JSON 을 읽지 않게.
    const tmp = `${overlapEvidence}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pr, head: toHead, gate: { head: toHead, baseCommit: regate.baseCommit, passed: true }, reviewResult }, null, 2));
    renameSync(tmp, overlapEvidence);
  } catch (error) {
    step('land', 'not-landing', `overlap evidence write failed: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`, true);
    return outcomes;
  }
  const before = { reviewRequests: latest.reviewRequests, landAttempts: latest.landAttempts };
  const landed = await executeLiveLand(latest, pr, { runId: card.runId ?? null, cycleId: `rejudge:${card.id}:${toHead}`, cwd, review, overlapEvidence },
    { ...live, ...(deps.log ? { log: deps.log } : {}) });
  recordMove(statePath, card.id, card.runId, 'propose-land', landed, pr, before, now, deps.log);
  step('land', landed.executed && landed.ok ? 'landed' : 'land-rejected', `${landed.detail} · overlap-evidence ${overlapEvidence}`, true);
  return outcomes;
}

function recordMove(statePath: string, cardId: string, runId: string | undefined, kind: TaskAgentLiveMove, result: LiveMoveResult, pr: number, before: Pick<TaskCard, 'reviewRequests' | 'landAttempts'>, now: () => Date, log?: RejudgeDeps['log']): void {
  try {
    recordLiveMoveHistory(statePath, cardId, { at: now().toISOString(), kind, executorResult: 'live', result, runId: runId ?? null, pr, before },
      log ? (c, e, d) => log(c, e, d) : undefined);
  } catch { /* recordLiveMoveHistory 는 스스로 관측한다 */ }
}

/** 재판정 대상 카드 — 묶인 PR ⊕ 그 PR 로 TA 리뷰를 요청한 적이 있는 카드. */
export function rejudgeCandidates(tasks: Readonly<Record<string, TaskCard>>): string[] {
  return Object.values(tasks).filter((card) => {
    const pr = cardPrNumber(card);
    return pr !== undefined && (card.reviewRequests ?? []).some((entry) => entry.pr === pr);
  }).map((card) => card.id);
}
