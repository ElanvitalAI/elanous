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
import { configuredTaskAgentLiveMoves, executeLiveGreenProposal, executeLiveLand, executeLiveReview, type LiveMoveDeps, type LiveMoveResult, type TaskAgentLiveMove } from './live-moves.js';

export interface TaskAgentShadowInput {
  runId: string | null;
  stopReason: SupervisorStopReason;
  results: readonly SupervisorJobResult[];
  /** One judgement cycle can attempt at most one land, even across PRs. */
  cycleId?: string;
  /** Reviewed SHA is mandatory for land; a bare pass cannot authorize merging. */
  selfReview?: { verdict: 'pass' | 'fail'; head: string };
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
  if (input.selfReview) judgeInput.review = input.selfReview.verdict;
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
      ? (card && successful?.taskId === prResult.taskId ? card : liveCardFor([prResult], deps))
      : undefined;
  // PR 에 묶인 수는 그 PR 의 카드만 관측에 싣는다(못 찾으면 null — 다른 결과의 카드로 대체하지 않는다).
  const liveCard = prResult || delivery ? boundCard : card ?? (cardLookupFailed ? undefined : liveCardFor(input.results, deps));
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
        { runId: input.runId, cycleId: input.cycleId, review: input.selfReview,
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
  });
  return liveMove ? { ...move, liveMove } : move;
}

/** live 수의 카드 — 성공한 결과가 없어도(수확 가능 런은 ok 가 아닐 수 있다) 결과의 taskId · 유일한 발사 문장으로 찾는다. */
function liveCardFor(results: readonly SupervisorJobResult[], deps: TaskAgentShadowDeps): TaskCard | undefined {
  try {
    for (const result of results) {
      const found = deps.readCard ? deps.readCard(result.taskId) : readTaskCard(result.taskId, deps.live?.statePath);
      if (found) return found;
    }
    if (deps.readCard) return undefined;
    const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.live?.statePath ?? taskAgentStatePath()).tasks ?? {};
    const features = new Set(results.map((result) => result.feature));
    const matches = Object.values(tasks).filter(candidate => candidate.status === 'launched' && features.has(candidate.text));
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return undefined; }
}
