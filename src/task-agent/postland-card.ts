import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { listChecklist, setItemIfSnapshot, type Checklist } from '../release-loop/checklist.js';
import { judgeLandedCell, parseJudgeSignals, type GreenVerdict } from '../release-loop/landed-to-green.js';
import { HAND_MOVE_HISTORY_EVENT, LIVE_MOVE_HISTORY_EVENT, LIVE_MOVE_RESULT_EVENT, cardPrNumber, readTaskAgentState, taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';
import { isGoalOnlyPr } from './judge.js';

export interface LandedTaskPr { number: number; url: string; headRefOid: string; state: string; baseRefName: string; mergedAt: string; files?: Array<{ path: string }> }
export interface PostlandDeps {
  statePath?: string;
  versions: readonly string[];
  checklist?: (version: string) => Checklist;
  setStatus?: typeof setItemIfSnapshot;
  updateCard?: typeof updateTaskCard;
  judge?: typeof judgeLandedCell;
  log?: typeof debug.log;
}

/** Read-only PR binding for the legacy completion guard, including when judgment or ledger I/O fails. */
export function boundMergedTaskCells(pr: Pick<LandedTaskPr, 'number' | 'url'>, statePath = taskAgentStatePath()): string[] {
  const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
  const cards = Object.values(tasks).filter((card) => card.taLand && card.checklistId && cardPrNumber(card) === pr.number
    && typeof card.pr === 'object' && card.pr.url?.replace(/\/+$/, '') === pr.url.replace(/\/+$/, ''));
  return [...new Set(cards.map((card) => card.checklistId!))];
}

/** When the PR API omits URL/head, keep candidate TA cells out of the prose-only green path. */
export function candidateMergedTaskCells(number: number, statePath = taskAgentStatePath()): string[] {
  const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
  return [...new Set(Object.values(tasks).filter((card) => card.taLand && card.checklistId && cardPrNumber(card) === number).map((card) => card.checklistId!))];
}

/** A bound TA card closes only after its exact PR and a unique release cell are confirmed. */
export function closeMergedTaskCard(pr: LandedTaskPr, cwd: string, deps: PostlandDeps): string | null {
  const log = deps.log ?? debug.log.bind(debug);
  if (pr.state !== 'MERGED' || pr.baseRefName !== 'main' || !/^[a-f0-9]{40}$/i.test(pr.headRefOid) || !pr.url) return null;
  if (isGoalOnlyPr(pr.files?.map((file) => file.path))) {
    log('task-agent', 'postland-card-skipped', { pr: pr.number, reason: 'goal-only-pr', targetDiff: 0 });
    return null;
  }
  const path = deps.statePath ?? taskAgentStatePath();
  const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(path).tasks ?? {};
  const cards = Object.values(tasks).filter((card) => card.taLand && card.checklistId && cardPrNumber(card) === pr.number
    && typeof card.pr === 'object' && card.pr.url?.replace(/\/+$/, '') === pr.url.replace(/\/+$/, ''));
  if (cards.length !== 1) {
    log('task-agent', 'postland-card-skipped', { pr: pr.number, reason: cards.length ? 'ambiguous-card' : 'no-bound-card' });
    return null;
  }
  const card = cards[0]!;
  if (!(card.landAttempts ?? []).some((attempt) => attempt.pr === pr.number && attempt.head.toLowerCase() === pr.headRefOid.toLowerCase())) {
    log('task-agent', 'postland-card-skipped', { pr: pr.number, card: card.id, reason: 'land-head-not-bound' });
    return null;
  }
  const candidateVersions = card.checklistVersion ? [card.checklistVersion] : deps.versions;
  const cells = candidateVersions.flatMap((version) => {
    const snapshot = (deps.checklist ?? listChecklist)(version);
    const item = snapshot.items.find((row) => row.id === card.checklistId);
    return item ? [{ version, snapshot, item }] : [];
  });
  if (cells.length !== 1) {
    log('task-agent', 'postland-card-skipped', { pr: pr.number, card: card.id, reason: cells.length ? 'ambiguous-cell-version' : 'cell-not-found' });
    return null;
  }
  const { version, item } = cells[0]!;
  const expected = { title: item.title, status: item.status, evidence: item.evidence };
  const expectedTitle = expected.title;
  const prior = (card as TaskCard & { postLand?: { pr: number; head: string; outcome: 'complete' | 'partial'; evidence: string[] } }).postLand;
  const marker = `TA postland #${pr.number}/${pr.headRefOid.slice(0, 12)}:`;
  const currentEvidenceLine = item.evidence?.split('\n').find((line) => line.startsWith(marker));
  const terminalBound = card.status === 'done' && card.prTerminal?.pr === pr.number
    && card.prTerminal.head.toLowerCase() === pr.headRefOid.toLowerCase()
    && card.prTerminal.url.replace(/\/+$/, '') === pr.url.replace(/\/+$/, '');
  if (prior?.pr === pr.number && prior.head.toLowerCase() === pr.headRefOid.toLowerCase()
    && prior.outcome === 'complete' && terminalBound && item.status === 'green' && currentEvidenceLine
    && prior.evidence?.length && prior.evidence.every((part) => currentEvidenceLine.includes(part))) return item.id;
  const alreadyGreen = item.status === 'green';
  let verdict: GreenVerdict | undefined = alreadyGreen ? 'proposed' : undefined;
  let judgeError: string | undefined;
  if (!alreadyGreen) {
    try { verdict = (deps.judge ?? judgeLandedCell)({ version, id: item.id, title: expectedTitle, pr: pr.number }, { cwd }); }
    catch (error) { judgeError = String(error).slice(0, 240); }
  }
  const complete = verdict === 'proposed';
  const criterion = expectedTitle.split(/\r?\n/).filter((line) => /^\s*판정(?: 신호)?:/.test(line)).map((line) => line.trim());
  const remaining = complete ? [] : criterion.length ? criterion : ['판정 줄 없음 — 칸 주인의 판정 필요'];
  const allPaths = (pr.files ?? []).map((file) => file.path).filter(Boolean);
  const paths = allPaths.slice(0, 20);
  const omitted = allPaths.length - paths.length;
  const observations = parseJudgeSignals(expectedTitle).map((signal) => signal.observe).filter((value): value is string => !!value);
  const judgeEvidence = alreadyGreen ? '기존 green 상태 확인(새 측정 0)' : judgeError
    ? `판정 실행 오류: ${judgeError}`
    : `판정 ${verdict ?? 'error'}: ${observations.length ? observations.join(' · ') : '측정 명령 없음'}${verdict === 'proposed' ? ' → exit 0' : ''}`;
  const changed = paths.length ? `changed: ${paths.join(' · ')}${omitted ? ` · 외 ${omitted}개(${pr.url}에서 전체 확인)` : ''}`
    : `changed: 경로 목록 미제공(${pr.url} 참조)`;
  const filled = [`PR #${pr.number} merged, head ${pr.headRefOid}`, `카드 land head 대조 일치`, changed, judgeEvidence];
  const note = complete
    ? `${marker} ${filled.join(' | ')}; ${alreadyGreen ? '기존 green 유지' : '판정 신호 통과 → green'}.`
    : `${marker} 이 조각이 채운 것: ${filled.join(' | ')}; 남은 것: ${remaining.join(' | ')}; 다음 조각 retitle 후보: ${remaining[0]}`;
  const priorLines = item.evidence?.split('\n').filter((line) => !line.startsWith(marker)) ?? [];
  const evidence = [...priorLines, note].join('\n');
  const desiredStatus = complete ? 'green' : item.status === 'red' ? 'red' : 'yellow';
  if (prior?.pr === pr.number && prior.head.toLowerCase() === pr.headRefOid.toLowerCase()
    && prior.outcome === (complete ? 'complete' : 'partial') && terminalBound
    && item.status === desiredStatus && item.evidence === evidence) return item.id;
  const at = new Date().toISOString();
  let wrote = false;
  // The card lock protects the binding through the ledger write. A failed ledger write
  // throws before the card changes, so the next pass can retry both records.
  (deps.updateCard ?? updateTaskCard)(path, card.id, (current, currentTasks) => {
    const matching = Object.values(currentTasks).filter((candidate) => candidate.taLand && cardPrNumber(candidate) === pr.number
      && typeof candidate.pr === 'object' && candidate.pr.url?.replace(/\/+$/, '') === pr.url.replace(/\/+$/, ''));
    if (matching.length !== 1 || matching[0]?.id !== card.id) return undefined;
    if (!current || cardPrNumber(current) !== pr.number || current.checklistId !== item.id
      || current.checklistVersion !== card.checklistVersion || typeof current.pr !== 'object'
      || current.pr.url?.replace(/\/+$/, '') !== pr.url.replace(/\/+$/, '')
      || !(current.landAttempts ?? []).some((attempt) => attempt.pr === pr.number && attempt.head.toLowerCase() === pr.headRefOid.toLowerCase())) return undefined;
    const existing = (current as TaskCard & { postLand?: { pr: number; head: string; outcome: 'complete' | 'partial' } }).postLand;
    const currentTerminalBound = current.status === 'done' && current.prTerminal?.pr === pr.number
      && current.prTerminal.head.toLowerCase() === pr.headRefOid.toLowerCase()
      && current.prTerminal.url.replace(/\/+$/, '') === pr.url.replace(/\/+$/, '');
    if (existing?.pr === pr.number && existing.head.toLowerCase() === pr.headRefOid.toLowerCase()
      && existing.outcome === (complete ? 'complete' : 'partial') && currentTerminalBound
      && item.status === desiredStatus && item.evidence === evidence) return undefined;
    const currentVersions = current.checklistVersion ? [current.checklistVersion] : deps.versions;
    const currentCells = currentVersions.flatMap((candidateVersion) =>
      (deps.checklist ?? listChecklist)(candidateVersion).items.some((row) => row.id === item.id) ? [candidateVersion] : []);
    if (currentCells.length !== 1 || currentCells[0] !== version) return undefined;
    (deps.setStatus ?? setItemIfSnapshot)(version, item.id, { evidence, status: desiredStatus }, 'task-agent', expected);
    wrote = true;
    const sameOutcome = existing?.pr === pr.number && existing.head.toLowerCase() === pr.headRefOid.toLowerCase()
      && existing.outcome === (complete ? 'complete' : 'partial');
    return { ...current,
      status: 'done' as const,
      prTerminal: { pr: pr.number, url: pr.url, head: pr.headRefOid, state: 'MERGED' as const, at },
      postLand: { pr: pr.number, head: pr.headRefOid, at, outcome: complete ? 'complete' as const : 'partial' as const, evidence: filled, remaining },
      history: sameOutcome ? current.history : [...current.history, { at, event: 'postland-card', pr: pr.number, head: pr.headRefOid, detail: complete ? `green ${version}/${item.id}` : `${desiredStatus} ${version}/${item.id}; ${remaining.join(' | ')}` }],
    };
  });
  if (!wrote) {
    log('task-agent', 'postland-card-pending', { pr: pr.number, card: card.id, version, id: item.id, reason: 'card-binding-changed-before-write' });
    return item.id;
  }
  log('task-agent', 'postland-card-closed', { pr: pr.number, card: card.id, version, id: item.id, outcome: complete ? 'complete' : 'partial', verdict });
  return item.id;
}

const defaultGit = (cwd: string, args: string[]): { status: number; stdout: string; stderr: string } => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

export type HandMergeReconcileOutcome =
  | { outcome: 'reconciled'; card: string; status: 'landed-by-hand' | 'landed'; pr: number; head: string; mergeSha: string; mergedAt: string }
  | { outcome: 'not-reconciled'; reason: 'pr-not-merged' | 'no-merge-sha' | 'no-bound-card' | 'ambiguous-card' | 'card-not-failed' | 'not-ancestor-of-main' | 'card-binding-changed-before-write' };

export interface HandMergeReconcileDeps {
  statePath?: string;
  mainRef?: string;
  updateCard?: typeof updateTaskCard;
  git?: (cwd: string, args: string[]) => { status: number; stdout: string; stderr: string };
  log?: typeof debug.log;
}

/**
 * TA-CARD-MERGE-RECONCILE — 실패 카드에 묶인 PR을 사람이 손수 병합했을 때만 카드를 정산한다.
 * MERGED + merge SHA가 `${mainRef}`(기본 `origin/main`) 조상일 때 status=landed-by-hand(또는 merge 커밋이
 * land attempt head와 일치하면 landed)로 `updateTaskCard` 파일-락 트랜잭션 하나로 갱신하고,
 * 이전 status·사유는 history `hand-move` 줄에 보존한다. OPEN·비조상·묶임 없음은 카드를 그대로 둔다.
 */
export function reconcileHandMergedCard(pr: LandedTaskPr & { mergeCommit?: string }, cwd: string, deps: HandMergeReconcileDeps = {}): HandMergeReconcileOutcome {
  const log = deps.log ?? debug.log.bind(debug);
  if (pr.state !== 'MERGED' || !pr.url) return { outcome: 'not-reconciled', reason: 'pr-not-merged' };
  const mergeSha = pr.mergeCommit ?? '';
  if (!/^[a-f0-9]{40}$/i.test(mergeSha)) return { outcome: 'not-reconciled', reason: 'no-merge-sha' };
  const path = deps.statePath ?? taskAgentStatePath();
  const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(path).tasks ?? {};
  const cards = Object.values(tasks).filter((card) => card.taLand && cardPrNumber(card) === pr.number
    && typeof card.pr === 'object' && card.pr.url?.replace(/\/+$/, '') === pr.url.replace(/\/+$/, ''));
  if (cards.length !== 1) {
    log('task-agent', 'postland-card-hand-skipped', { pr: pr.number, reason: cards.length ? 'ambiguous-card' : 'no-bound-card' });
    return { outcome: 'not-reconciled', reason: cards.length ? 'ambiguous-card' : 'no-bound-card' };
  }
  const card = cards[0]!;
  if (card.status !== 'failed') {
    log('task-agent', 'postland-card-hand-skipped', { pr: pr.number, card: card.id, reason: 'card-not-failed', status: card.status });
    return { outcome: 'not-reconciled', reason: 'card-not-failed' };
  }
  const mainRef = deps.mainRef ?? 'origin/main';
  if ((deps.git ?? defaultGit)(cwd, ['merge-base', '--is-ancestor', mergeSha, mainRef]).status !== 0) {
    log('task-agent', 'postland-card-hand-skipped', { pr: pr.number, card: card.id, reason: 'not-ancestor-of-main', mainRef });
    return { outcome: 'not-reconciled', reason: 'not-ancestor-of-main' };
  }
  const at = new Date().toISOString();
  let reconciled: { status: 'landed-by-hand' | 'landed' } | undefined;
  // The card lock keeps the settlement atomic with its binding checks: a card that flipped off
  // `failed` mid-flight is left untouched for its owning path to finish.
  (deps.updateCard ?? updateTaskCard)(path, card.id, (current, currentTasks) => {
    const matching = Object.values(currentTasks).filter((candidate) => candidate.taLand && cardPrNumber(candidate) === pr.number
      && typeof candidate.pr === 'object' && candidate.pr.url?.replace(/\/+$/, '') === pr.url.replace(/\/+$/, ''));
    if (matching.length !== 1 || matching[0]?.id !== card.id) return undefined;
    if (!current || current.status !== 'failed' || cardPrNumber(current) !== pr.number || typeof current.pr !== 'object'
      || current.pr.url?.replace(/\/+$/, '') !== pr.url.replace(/\/+$/, '')) return undefined;
    const status = (current.landAttempts ?? []).some((attempt) => attempt.pr === pr.number
      && attempt.head.toLowerCase() === mergeSha.toLowerCase()) ? 'landed' : 'landed-by-hand';
    const priorReason = [...current.history].reverse().find((event) => event.event !== LIVE_MOVE_HISTORY_EVENT
      && event.event !== LIVE_MOVE_RESULT_EVENT && event.event !== HAND_MOVE_HISTORY_EVENT)?.detail ?? '사유 기록 없음';
    const detail = status === 'landed'
      ? `PR #${pr.number} 병합 정산: merge ${mergeSha}가 land attempt head와 일치 — status landed; 이전 status: failed; 이전 사유: ${priorReason}`
      : `PR #${pr.number} 손 병합 정산: merge ${mergeSha}가 ${mainRef} 조상 — status landed-by-hand; 이전 status: failed; 이전 사유: ${priorReason}`;
    reconciled = { status };
    return { ...current,
      status,
      prTerminal: { pr: pr.number, url: pr.url, head: mergeSha, state: 'MERGED' as const, at },
      history: [...current.history, { at, event: HAND_MOVE_HISTORY_EVENT, pr: pr.number, head: mergeSha, detail }],
    };
  });
  if (!reconciled) {
    log('task-agent', 'postland-card-hand-pending', { pr: pr.number, card: card.id, reason: 'card-binding-changed-before-write' });
    return { outcome: 'not-reconciled', reason: 'card-binding-changed-before-write' };
  }
  log('task-agent', 'postland-card-hand-reconciled', { pr: pr.number, card: card.id, status: reconciled.status, mergeSha, mainRef });
  return { outcome: 'reconciled', card: card.id, status: reconciled.status, pr: pr.number, head: pr.headRefOid, mergeSha, mergedAt: pr.mergedAt };
}
