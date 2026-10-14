import { debug } from '../debug/log.js';
import { listChecklist, setItemIfSnapshot, type Checklist } from '../release-loop/checklist.js';
import { judgeLandedCell, parseJudgeSignals, type GreenVerdict } from '../release-loop/landed-to-green.js';
import { cardPrNumber, readTaskAgentState, taskAgentStatePath, updateTaskCard, type TaskCard } from './task-hand.js';

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
