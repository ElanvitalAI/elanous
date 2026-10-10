/**
 * TASK-AGENT-SHADOW — 슈퍼바이저가 런의 멈춤을 확정한 자리에서 판단부를 «그림자»로 부른다.
 *
 * RFC-task-agent-any-task-to-completion-2026-10-06 §A9 «판단부 호출부 0»을 메운다.
 * - 입력은 슈퍼바이저 결과에 «이미 실려 있는» 값만 쓴다(네트워크 호출 0): 종료 어휘 ·
 *   PR 번호/병합 여부(`prNumber`·`merged`). 리뷰 판정·must-fix 는 결과에 없으므로 비운다
 *   («통과»로 읽지 않는다 — 판단부가 review 수를 고른다).
 * - 슈퍼바이저의 기본 호출은 shadow: «했을 수»만 기록하고 명령·복사는 하나도 돌리지 않는다.
 *   전달 과제의 명시적 live 호출만 파일을 복사한다. 설정 `taskAgent.mode=live` 는 기본 호출에 먹지 않는다.
 * - 관측: `debug.log('task-agent', 'shadow-move', …)` → `elanous logs --category task-agent`.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { readTaskAgentState, readTaskCard, taskAgentStatePath, type CompletionKind, type TaskCard } from './task-hand.js';
import type { SupervisorJobResult, SupervisorStopReason } from '../self-dev/run-supervisor.js';
import { executeNextAction, type DeliveryKind, type NextAction } from './actions.js';
import { judgeNextMove, type TaskJudgeInput, type TaskJudgement } from './judge.js';
import { HARNESS_RUN_ID_ENV } from '../harness/harness-space.js';
import { recordLiveMoveHistory } from './live-move-history.js';
import { capturedSelfReview, captureReviewResults, hasCapturedPass } from './review-result-capture.js';
import { configuredTaskAgentLiveMoves, defaultPrHead, executeLiveGreenProposal, executeLiveLand, executeLiveReview, type LiveMoveDeps, type LiveMoveResult, type TaskAgentLiveMove } from './live-moves.js';

export interface TaskAgentShadowInput {
  runId: string | null;
  stopReason: SupervisorStopReason;
  results: readonly SupervisorJobResult[];
  /** One judgement cycle can attempt at most one land, even across PRs. */
  cycleId?: string;
  /** Reviewed SHA is mandatory for land; a bare pass cannot authorize merging. */
  selfReview?: { verdict: 'pass' | 'fail'; head: string; mustFixCount?: number };
}

export interface TaskAgentShadowMove {
  runId: string | null;
  stopReason: SupervisorStopReason;
  move: TaskJudgement['move'];
  executorKind: TaskJudgement['executorKind'] | null;
  variant: TaskJudgement['executorVariant'] | null;
  reason: string;
  /** 실행부 결과 — 기본 shadow 경로에서는 'shadow'(실행부 밖의 수면 null). */
  executorResult: string | null;
  /** 실행부가 남긴 «했을 수» 문면. */
  wouldDo: string | null;
  pr: number | null;
  /** TA-JUDGE-LIVE-SAFE — `taskAgent.liveMoves` 가 이 수를 실제로 했을 때만 실린다(없으면 종전 그대로 그림자). */
  liveMove?: LiveMoveResult;
}

export interface TaskAgentShadowDeps {
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 시험용 — shadow 실행부가 명령을 부르면 여기로 온다(정상이면 0회). */
  command?: (args: string[]) => Promise<{ status: number; stdout: string; stderr?: string }>;
  readCard?: (taskId: string) => TaskCard | undefined;
  /** Explicit live invocation only; supervisor's default hook always uses shadow. */
  mode?: 'shadow' | 'live';
  /** TA-JUDGE-LIVE-SAFE — 실제로 할 수(`review`·`propose-green`·`propose-land`). 없으면 설정 `taskAgent.liveMoves` 를 읽는다. */
  liveMoves?: ReadonlySet<TaskAgentLiveMove>;
  /** live 수의 부작용(리뷰 띄우기·PR 머리 조회·상태 파일) — 시험은 주입한다. */
  live?: LiveMoveDeps;
  /** Process env for the launched-run id (`ELANOUS_RUN_ID`) — test seam; default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** 파일 산출물로 전달(elanous-out)하는 종결 종류 — 그 밖의 code-pr 밖 종류는 확인 증거를 판단부에서 기다린다. */
const DELIVERY_KINDS: ReadonlySet<CompletionKind> = new Set<CompletionKind>(['research-report', 'artifact', 'content']);
function isDeliveryKind(kind: CompletionKind | undefined): kind is DeliveryKind {
  return kind !== undefined && DELIVERY_KINDS.has(kind);
}

/**
 * 슈퍼바이저 결과에서 판단부 입력을 만든다 — 추가 조회 없이 이미 실린 값만.
 * `completion` 은 카드의 종결 종류(§A4b③) — 있으면 판단부 입력에 싣는다(비면 종전 입력 그대로).
 */
export function shadowJudgeInput(stopReason: SupervisorStopReason, results: readonly SupervisorJobResult[], completion?: CompletionKind): TaskJudgeInput {
  const withPr = results.filter((result) => typeof result.prNumber === 'number' && result.prNumber > 0);
  const input: TaskJudgeInput = { stopReason };
  if (completion !== undefined) input.completion = completion;
  if (withPr.length > 0) {
    input.pr = withPr[0]!.prNumber!;
    // 병합 여부만 결과에 실린다 — 닫힘(CLOSED)은 여기서 모른다. 병합이 아니면 OPEN 으로 둔다(판단부는 MERGED 만 본다).
    input.prState = withPr.every((result) => result.merged === true) ? 'MERGED' : 'OPEN';
  }
  return input;
}

export function selectDeliveryCandidates(worktreePath: string, kind: DeliveryKind): string[] {
  const allowed = kind === 'research-report' ? new Set(['.md']) : new Set(['.md', '.html', '.pdf', '.png', '.pptx']);
  try {
    const root = realpathSync(worktreePath);
    const gitMarker = join(root, '.git');
    let gitPointer = '';
    try { if (lstatSync(gitMarker).isFile()) gitPointer = readFileSync(gitMarker, 'utf8').trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const gitDir = gitPointer.startsWith('gitdir: ') ? resolve(root, gitPointer.slice(8)) : gitMarker;
    const commonPointer = join(gitDir, 'commondir');
    const sharedDir = (() => { try { return resolve(gitDir, readFileSync(commonPointer, 'utf8').trim()); } catch { return gitDir; } })();
    let index: Buffer;
    try { index = readFileSync(join(gitDir, 'index')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      index = Buffer.alloc(12);
      index.write('DIRC');
      index.writeUInt32BE(2, 4);
    }
    const tracked = new Set<string>();
    if (index.toString('ascii', 0, 4) !== 'DIRC' || ![2, 3].includes(index.readUInt32BE(4))) return [];
    let offset = 12;
    const count = index.readUInt32BE(8);
    for (let i = 0; i < count; i++) {
      const start = offset;
      const flags = index.readUInt16BE(start + 60);
      offset = start + 62;
      if (flags & 0x4000) offset += 2;
      const end = index.indexOf(0, offset);
      if (end < 0) return [];
      tracked.add(index.toString('utf8', offset, end));
      offset = start + Math.ceil((end + 1 - start) / 8) * 8;
    }
    const ignored = (() => {
      try { return readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')); }
      catch { return [] as string[]; }
    })();
    const excluded = (() => {
      try { return readFileSync(join(sharedDir, 'info', 'exclude'), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')); }
      catch { return [] as string[]; }
    })();
    const isIgnored = (name: string): boolean => [...ignored, ...excluded].some(pattern => {
      const rule = pattern.replace(/^\//, '').replace(/\/$/, '');
      if (rule.includes('*')) return new RegExp(`^${rule.split('*').map(part => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*')}$`).test(name);
      return name === rule || name.startsWith(rule + '/') || name.split('/').includes(rule);
    });
    const candidates: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const file = join(dir, entry.name);
        const name = relative(root, file);
        if (isIgnored(name)) continue;
        if (entry.isDirectory()) { walk(file); continue; }
        if (!entry.isFile()) continue;
        if (allowed.has(extname(name).toLowerCase()) && !tracked.has(name) && lstatSync(file).isFile() && realpathSync(file) === file) candidates.push(name);
      }
    };
    walk(root);
    return candidates.sort();
  } catch { return []; }
}

/** shadow-move 관측의 종결 종류 — 읽은 카드만 «비면 code-pr» 로 풀고, 조회 실패는 'unmeasured', 카드를 안 봤으면 null. */
function shadowCompletion(card: TaskCard | undefined, lookupFailed: boolean): CompletionKind | 'unmeasured' | null {
  if (card) return card.completion ?? 'code-pr';
  return lookupFailed ? 'unmeasured' : null;
}

export async function recordTaskAgentShadowMove(input: TaskAgentShadowInput, deps: TaskAgentShadowDeps = {}): Promise<TaskAgentShadowMove> {
  // TA-REVIEW-RESULT-CAPTURE — 판단 «전»에 지난 live review 의 결과 파일을 회수한다(카드 원장을 아는 때만 · 던지지 않는다).
  //   대기 중인 요청이 없으면 아무것도 쓰지 않는다(결과 파일 없는 카드의 동작은 종전과 같다).
  const reviewLedger = deps.live?.statePath ?? (deps.readCard ? undefined : taskAgentStatePath());
  if (reviewLedger) {
    try { captureReviewResults(reviewLedger, { ...(deps.live?.now ? { now: deps.live.now } : {}), ...(deps.log ? { log: deps.log } : {}) }); } catch (error) {
      // fail-soft — 판단은 계속하되 원인은 남긴다.
      try { (deps.log ?? ((c, e, d) => debug.log(c, e, d, { level: 'warn' })))('task-agent', 'review-result-capture-failed', { statePath: reviewLedger, reason: (error instanceof Error ? error.message : String(error)).slice(-300) }); } catch { /* fail-soft */ }
    }
  }
  const successful = input.results.find(result => result.ok === true && result.worktreePath);
  let card: TaskCard | undefined;
  let cardLookupFailed = false;
  try {
    card = successful ? (deps.readCard ?? readTaskCard)(successful.taskId) : undefined;
    if (!card && successful && !deps.readCard) {
      const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(taskAgentStatePath()).tasks ?? {};
      const matches = Object.values(tasks).filter(candidate => candidate.status === 'launched' && candidate.text === successful.feature);
      if (matches.length === 1) card = matches[0];
    }
  } catch {
    // Card lookup is optional; preserve the original PR judgement when unavailable — but mark the completion kind as unmeasured.
    cardLookupFailed = true;
  }
  const kind = card?.completion;
  const judgeInput = shadowJudgeInput(input.stopReason, input.results, kind);
  // 슈퍼바이저가 나른 리뷰가 없으면 그 PR 카드에 회수된 리뷰 결과(pass · 실제로 돈 리뷰 · 머리 sha)를 같은 입력 칸으로 쓴다.
  let selfReview = input.selfReview;
  let reviewFromCapture = false;
  if (!selfReview && reviewLedger && typeof judgeInput.pr === 'number') {
    try {
      const reviewedPr = judgeInput.pr;
      const prRun = input.results.find((result) => result.prNumber === reviewedPr);
      const prCard = prRun ? (card && successful?.taskId === prRun.taskId ? card : liveCardFor([prRun], deps, input.runId)) : undefined;
      // 회수한 판정은 «리뷰한 머리»의 것이다 — 지금 PR 머리의 결과만 입력으로 쓴다(A 의 pass 로 B 를 land 쪽으로 보내지 않게 ·
      //   여러 머리 결과가 역순으로 회수돼도 지금 머리 것을 고른다). 지금 머리 = 그 런 작업 트리에서 PR 머리 조회 ·
      //   작업 트리가 없으면(Pod) 런이 낸 머리. 못 정하면 쓰지 않는다(종전처럼 review 수 → 새 머리면 새 리뷰).
      if (prRun && hasCapturedPass(prCard, reviewedPr)) {
        let currentHead: string | undefined;
        if (prRun.worktreePath) {
          const view = await (deps.live?.prHead ?? defaultPrHead)(reviewedPr, prRun.worktreePath).catch(() => null);
          currentHead = view?.state === 'OPEN' ? view.head : undefined;
        } else if (prRun.checkedHeadCommit && /^[0-9a-f]{40}$/i.test(prRun.checkedHeadCommit)) {
          currentHead = prRun.checkedHeadCommit;
        }
        if (currentHead) selfReview = capturedSelfReview(prCard, reviewedPr, currentHead);
      }
      reviewFromCapture = selfReview !== undefined;
    } catch (error) {
      selfReview = undefined;
      try { (deps.log ?? ((c, e, d) => debug.log(c, e, d, { level: 'warn' })))('task-agent', 'review-result-capture-failed', { pr: judgeInput.pr, reason: (error instanceof Error ? error.message : String(error)).slice(-300) }); } catch { /* fail-soft */ }
    }
  }
  if (selfReview) judgeInput.review = selfReview.verdict;
  const delivery = successful?.worktreePath && card?.project?.target && isDeliveryKind(kind)
    ? { kind, worktreePath: successful.worktreePath, projectTarget: card.project.target, files: selectDeliveryCandidates(successful.worktreePath, kind) }
    : undefined;
  const judgement: TaskJudgement = delivery
    ? delivery.files.length
      ? { move: 'wait', stage: 'observing', reason: '전달 후보 확인 — 산출물 판독 대기', executorKind: 'deliver' }
      : { move: 'wait', stage: 'waiting', reason: '전달 후보 없음' }
    : judgeNextMove(judgeInput);
  if (cardLookupFailed) judgement.reason = `${judgement.reason} · 종결 종류 미확인(카드 조회 실패)`;
  let executorResult: string | null = null;
  let wouldDo: string | null = null;
  if (judgement.executorKind) {
    const action: NextAction = {
      kind: judgement.executorKind,
      ...(judgement.executorVariant ? { variant: judgement.executorVariant } : {}),
      taskId: delivery ? card!.id : input.runId ?? 'run-unknown',
      rationale: judgement.reason,
      pr: delivery ? 0 : typeof judgeInput.pr === 'number' ? judgeInput.pr : 0,
      runId: input.runId ?? '',
      original: [...new Set(input.results.map((result) => result.feature))].join(' · '),
      checklistId: delivery ? card?.checklistId ?? '' : '',
      ...(delivery ? { delivery } : {}),
    };
    executorResult = await executeNextAction(action, {
      mode: delivery ? (deps.mode ?? 'shadow') : 'shadow',
      command: deps.command ?? (async () => { throw new Error('task-agent shadow path must not run commands'); }),
      observe: (_event, data) => { wouldDo = data.reason; },
    });
  }
  const move: TaskAgentShadowMove = {
    runId: input.runId,
    stopReason: input.stopReason,
    move: judgement.move,
    executorKind: judgement.executorKind ?? null,
    variant: judgement.executorVariant ?? null,
    reason: judgement.reason,
    executorResult,
    wouldDo,
    pr: delivery ? null : typeof judgeInput.pr === 'number' ? judgeInput.pr : null,
  };
  if (delivery && deps.mode !== 'live') {
    move.wouldDo = `${move.wouldDo ?? 'would wait'} → ${join(delivery.projectTarget, 'elanous-out', card!.id)} (${delivery.files.join(', ')})`;
  }
  if (delivery && deps.mode === 'live') {
    move.move = executorResult === 'done' ? 'propose-green' : 'wait';
    move.reason = wouldDo ?? judgement.reason;
    move.wouldDo = null;
  }
  const liveKind: TaskAgentLiveMove | null = move.move === 'review' || move.move === 'propose-green' || move.move === 'propose-land' ? move.move : null;
  // 판단마다 해석한다 — 허용되지 않은 수를 판단할 때도 모르는 항목 경고가 남게.
  const liveMoves = deps.liveMoves ?? await configuredTaskAgentLiveMoves();
  const live = liveKind !== null && liveMoves.has(liveKind);
  // 카드 id 는 모든 판단 관측에 싣는다(그림자 일치율을 카드로 잇는다) — 읽기 전용 조회.
  // live 수는 «근거 결과»에 묶는다 — PR 수는 그 PR 을 낸 결과의 카드·작업 트리, 전달은 전달한 카드(다중 결과에서 남의 카드에 쓰지 않게).
  const prResult = typeof judgeInput.pr === 'number' ? input.results.find((result) => result.prNumber === judgeInput.pr) : undefined;
  const boundCard = delivery
    ? card
    : prResult
      ? (card && successful?.taskId === prResult.taskId ? card : liveCardFor([prResult], deps, input.runId))
      : undefined;
  // PR 에 묶인 수는 그 PR 의 카드만 관측에 싣는다(못 찾으면 null — 다른 결과의 카드로 대체하지 않는다).
  const liveCard = prResult || delivery ? boundCard : card ?? (cardLookupFailed ? undefined : liveCardFor(input.results, deps, input.runId));
  let liveMove: LiveMoveResult | undefined;
  if (live) {
    if (liveKind === 'review') {
      liveMove = await executeLiveReview(boundCard, prResult?.prNumber,
        {
          runId: input.runId, stopReason: input.stopReason,
          ...(prResult?.worktreePath ? { cwd: prResult.worktreePath } : {}),
          // TA-LIVE-REVIEW-POD — 작업 트리가 없는 런(Pod)은 «런이 낸 머리»로 리뷰 저장소를 확인한다.
          ...(prResult && !prResult.worktreePath ? { produced: {
            ...(prResult.checkedHeadCommit !== undefined ? { headCommit: prResult.checkedHeadCommit } : {}),
            ...(prResult.branch ? { branch: prResult.branch } : {}),
            ...(prResult.prUrl ? { prUrl: prResult.prUrl } : {}),
          } } : {}),
        }, { ...(deps.log ? { log: deps.log } : {}), ...deps.live });
    } else if (liveKind === 'propose-land') {
      liveMove = await executeLiveLand(boundCard, prResult?.prNumber,
        { runId: input.runId, cycleId: input.cycleId, review: selfReview,
          ...(prResult?.worktreePath ? { cwd: prResult.worktreePath } : {}),
          ...(prResult && !prResult.worktreePath ? { produced: {
            ...(prResult.checkedHeadCommit !== undefined ? { headCommit: prResult.checkedHeadCommit } : {}),
            ...(prResult.branch ? { branch: prResult.branch } : {}),
            ...(prResult.prUrl ? { prUrl: prResult.prUrl } : {}),
          } } : {}),
        }, { ...(deps.log ? { log: deps.log } : {}), ...deps.live });
    } else {
      const evidence: Record<string, string> = {};
      if (boundCard && !delivery && judgeInput.prState === 'MERGED' && prResult) evidence[boundCard.id] = `#${prResult.prNumber}`;
      else if (boundCard && delivery && deps.mode === 'live' && executorResult === 'done') evidence[boundCard.id] = join(delivery.projectTarget, 'elanous-out', boundCard.id);
      liveMove = executeLiveGreenProposal(boundCard, evidence, { ...(deps.log ? { log: deps.log } : {}), ...deps.live });
    }
  }
  // 판단한 수마다 live/shadow 를 남긴다 — OP 가 «오판 건수»·«그림자 일치율»을 카드·수 종류로 잰다.
  (deps.log ?? ((category, event, data) => debug.log(category, event, data)))('task-agent', 'shadow-move', {
    ...move, completion: shadowCompletion(card, cardLookupFailed), card: liveCard?.id ?? null, live, liveExecuted: liveMove?.executed ?? false, ...(liveMove ? { liveOk: liveMove.ok } : {}),
    ...(reviewFromCapture ? { reviewSource: 'captured-review-result' } : {}),
  });
  // TA-LIVE-MOVE-CARD-HISTORY — live-move 수(review·propose-green·propose-land)는 실행이든 그림자든 그 카드 history 에 한 줄.
  // 결정·실행이 끝난 «뒤»에 덧붙이기만 한다(반환값·관측 무변경) · 실패는 관측만(live-move 를 막지 않는다).
  if (liveKind !== null) recordLiveMoveOnCard({
    liveKind, live, liveMove, card: live ? boundCard : liveCard, runId: input.runId,
    pr: prResult?.prNumber ?? (typeof judgeInput.pr === 'number' ? judgeInput.pr : undefined),
    shadowDetail: move.wouldDo ?? move.reason,
  }, deps);
  return liveMove ? { ...move, liveMove } : move;
}

/**
 * 카드 history 에 live-move 한 줄 — 상태 파일은 카드를 읽은 곳과 같아야 한다: 주입한 경로(`live.statePath`) 또는
 * 기본 리더를 썼을 때의 기본 경로. 주입한 카드 리더(`readCard`)만 있고 경로가 없으면 그 카드의 원장을 모른다 — 적지 않는다.
 */
function recordLiveMoveOnCard(
  move: { liveKind: TaskAgentLiveMove; live: boolean; liveMove: LiveMoveResult | undefined; card: TaskCard | undefined; runId: string | null; pr: number | undefined; shadowDetail: string },
  deps: TaskAgentShadowDeps,
): void {
  const log = deps.log ?? ((c: string, e: string, d: Record<string, unknown>) => debug.log(c, e, d, { level: 'warn' }));
  // 모든 기록 실패(경로 해석 · 시각 · 쓰기 · 카드 없음)는 이유 한 줄로 남기고, live-move 의 반환은 막지 않는다.
  const fail = (reason: string) => {
    try {
      log('task-agent', 'live-move-history-failed', {
        card: move.card?.id ?? null, kind: move.liveKind, executorResult: move.live ? 'live' : 'shadow', executed: move.liveMove?.executed ?? false, reason,
      });
    } catch { /* fail-soft — 관측 seam 자체가 던져도 live-move 는 계속 */ }
  };
  try {
    if (!move.card) { fail('no task card bound to this move'); return; }
    const statePath = deps.live?.statePath ?? (deps.readCard ? undefined : taskAgentStatePath());
    if (!statePath) { fail('card ledger unknown (injected readCard without live.statePath)'); return; }
    const card = move.card;
    // live 인데 실행부 결과가 없으면 «무엇이 일어났는지» 모른다 — 줄을 지어내지 않고 이유를 남긴다.
    if (move.live && !move.liveMove) { fail('live move returned no executor result'); return; }
    // recordLiveMoveHistory 는 쓰기 실패를 스스로 관측하고 던지지 않는다.
    recordLiveMoveHistory(statePath, card.id, {
      at: (deps.live?.now ?? (() => new Date()))().toISOString(),
      kind: move.liveKind,
      ...(move.live ? { executorResult: 'live' as const, result: move.liveMove! } : { executorResult: 'shadow' as const, shadowDetail: move.shadowDetail }),
      runId: move.runId,
      ...(move.pr !== undefined ? { pr: move.pr } : {}),
      // 실행부가 받은 카드(수 «전» 읽음) — 이번 수가 새로 적은 기록만 머리로 읽는다.
      before: { reviewRequests: card.reviewRequests, landAttempts: card.landAttempts },
    }, deps.log ? (c, e, d) => deps.log!(c, e, d) : undefined);
  } catch (error) {
    fail(`record preparation failed: ${(error instanceof Error ? error.message : String(error)).slice(-250)}`);
  }
}

/** live 수의 카드 — 성공한 결과가 없어도(수확 가능 런은 ok 가 아닐 수 있다) 결과의 taskId · 유일한 발사 문장으로 찾는다. */
function liveCardFor(results: readonly SupervisorJobResult[], deps: TaskAgentShadowDeps, runId?: string | null): TaskCard | undefined {
  try {
    for (const result of results) {
      const found = deps.readCard ? deps.readCard(result.taskId) : readTaskCard(result.taskId, deps.live?.statePath);
      if (found) return found;
    }
    if (deps.readCard) return undefined;
    const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.live?.statePath ?? taskAgentStatePath()).tasks ?? {};
    // TA-LIVE-LAND-2 — a Pod run's results carry the orchestrator task id, not the card id, and its feature may be the
    // authored goal rather than the handed sentence. `tasks hand --live` launched this process with ELANOUS_RUN_ID = the
    // card's runId (TA-CARD-RUN-LINK); the supervisor's runId may be the Pod child's. Either id bound to exactly one card is the match.
    const inherited = (deps.env ?? process.env)[HARNESS_RUN_ID_ENV]?.trim();
    for (const id of new Set([runId?.trim(), inherited].filter((value): value is string => !!value))) {
      const bound = Object.values(tasks).filter((candidate) => candidate.runId === id);
      if (bound.length === 1) return bound[0];
    }
    const features = new Set(results.map((result) => result.feature));
    const matches = Object.values(tasks).filter(candidate => candidate.status === 'launched' && features.has(candidate.text));
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return undefined; }
}
