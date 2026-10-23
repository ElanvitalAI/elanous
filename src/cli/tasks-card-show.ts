import { debug } from '../debug/log.js';
import { cardPrNumber, LIVE_MOVE_HISTORY_EVENT, LIVE_MOVE_RESULT_EVENT, nextMoveFor, readTaskAgentState, readTaskCard, shellQuote, taskAgentStatePath as taskStatePathDefault, taskCardLabelContext, type TaskCard } from '../task-agent/task-hand.js';
import { RUN_TAG_KEYS, runIdentityFieldText, runPriorityClass } from '../task-agent/run-identity.js';
import { readCardSalvageBranch, refreshCardRunBinding } from '../task-agent/card-evidence.js';
import { captureReviewResults } from '../task-agent/review-result-capture.js';
import type { TasksCliDeps } from './tasks-cli.js';
import { registerTaskAgentSink } from './tasks-read-cli.js';

/**
 * CLI-ENTRY-LAZY — `tasks show ta-…`(TASK-AGENT 과제 카드) 상세. `tasks-read-cli.ts` 가 카드 id 일 때만 싣는다.
 */

/** HARNESS-PARENT-ON-MSB1 — 카드가 원격 부모면 그 런 원장(⊕ Pod 자식)을 HQ 거울로 당긴다. 실패는 관측만(«없음»으로 읽히지 않게). */
export async function mirrorRemoteCardLedger(cardId: string, deps: TasksCliDeps): Promise<void> {
  let card: TaskCard | undefined;
  try { card = readTaskCard(cardId, deps.taskStatePath); } catch { return; }
  if (!card?.parentHost || !card.runId) return;
  try {
    if (deps.remoteLedgerMirror) { deps.remoteLedgerMirror(card); return; }
    const { mirrorRemoteRunLedgers } = await import('../task-agent/parent-host.js');
    const { effectiveInstanceRoot } = await import('../instance/resolve.js');
    mirrorRemoteRunLedgers(card.parentHost, card.runId, effectiveInstanceRoot(), deps.cardRunEvidence?.ssh);
  } catch (error) {
    try { debug.log('task-agent', 'remote-ledger-mirror-failed', { card: cardId, host: card.parentHost.host, runId: card.runId, error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
  }
}

function moveLine(card: TaskCard): string {
  const move = nextMoveFor(card);
  return `${move.kind}${move.command ? ` — elanous ${move.command.map(shellQuote).join(' ')}` : ''} (${move.reason})`;
}

export function headLine(text: string): string {
  const first = text.split('\n')[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

/** 런 연결 한 줄 — 런 id 가 없으면 없다(옛 카드 · shadow). */
function runLinkLine(card: TaskCard): string[] {
  if (!card.runId) return [];
  const number = cardPrNumber(card);
  const url = typeof card.pr === 'object' ? card.pr.url : undefined;
  const pr = number !== undefined ? `#${number}${url ? ` ${url}` : ''}` : '-';
  return [`런: ${card.runId} · 골: ${card.goalId ?? '-'} · PR: ${pr}${card.runChildId ? ` · 자식 런: ${card.runChildId}` : ''}`];
}

/** RUN-IDENTITY-TAGS — 신분 한 줄 + Pod 라벨 한 줄(원장 정본 2줄 렌더 · 신분 없는 카드는 «미기록»으로 적고 기본값 정책을 밝힌다). */
export function cardIdentityLines(card: TaskCard): string[] {
  const identity = card.identity;
  const { labels } = taskCardLabelContext({ id: card.id });
  // 경계: Pod 에 실제로 붙는 라벨은 카드 id 하나뿐이다 — 신분 값은 Pod 라벨에 아직 안 실린다(RUN-IDENTITY-ADMIT 몫). 화면도 그렇게 말한다.
  const podLine = `Pod 라벨 ${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(' ')} (신분 값은 Pod 라벨 미탑재 — RUN-IDENTITY-ADMIT)`;
  if (!identity) return [`신분 미기록 — 원장에 identity 없음 · 승인·선점은 기본 class=${runPriorityClass(identity)} 로 읽는다`, podLine];
  // ⛔ 모르는 칸을 기본값으로 보이지 않는다 — 원장에 없는 칸은 «미기록»으로 적는다(확인된 칸만 값으로).
  const identityText = RUN_TAG_KEYS.map((key) => `${key}=${runIdentityFieldText(identity, key)}`).join(' · ');
  const originParts = [identity.origin?.checklistId, identity.origin?.version, identity.origin?.seat, identity.origin?.launcher].filter((part) => part !== undefined);
  return [
    `신분 ${identityText}${originParts.length > 0 ? ` — 출생 ${originParts.join(' · ')}` : ''}`,
    podLine,
  ];
}

function taskCardLines(card: TaskCard): string[] {
  return [
    [card.id, card.status, card.seat ?? '-', card.checklistId ?? '-', card.createdAt, card.text].join('\t'),
    ...cardIdentityLines(card),
    ...(card.targetPaths !== undefined ? [`대상 경로: ${card.targetPaths.length ? card.targetPaths.join(' · ') : '(유효한 경로 없음)'}`] : []),
    ...(card.mission ? [`미션: ${card.mission} · after: ${card.after?.length ? card.after.join(', ') : '-'}`] : []),
    ...runLinkLine(card),
    ...liveMoveLines(card),
    `다음 수: ${moveLine(card)}`,
  ];
}

/** TA-LIVE-MOVE-CARD-HISTORY — 카드 history 의 live-move 줄(실행·그림자)을 한 줄씩. 없으면 없다(옛 카드 그대로). */
function liveMoveLines(card: TaskCard): string[] {
  return (card.history ?? []).filter((item) => item.event === LIVE_MOVE_HISTORY_EVENT || item.event === LIVE_MOVE_RESULT_EVENT).map((item) => item.event === LIVE_MOVE_RESULT_EVENT ? [
    // TA-REVIEW-RESULT-CAPTURE — 회수한 리뷰 결과(또는 «결과 없음») 줄.
    `결과: ${item.at}`, `${item.kind ?? '?'}`, `PR ${item.pr !== undefined ? `#${item.pr}` : '-'}${item.head ? ` head ${item.head.slice(0, 12)}` : ''}`,
    `verdict=${item.verdict ?? '—'} reviewed=${item.reviewed ?? '—'} must-fix=${item.mustFix ?? '—'} route=${item.reviewRoute ?? '—'}`,
    `효과: ${item.effect ?? 'unknown'}`, (item.detail ?? '').replace(/\r\n|\r|\n/g, (match) => (match === '\r' ? '\\r' : '\\n')),
  ].join(' · ') : [
    `수: ${item.at}`, `${item.kind ?? '?'} ${item.executorResult ?? '?'}`, `executed=${item.executed === true} ok=${item.ok === undefined ? '—' : item.ok}`,
    `PR ${item.pr !== undefined ? `#${item.pr}` : '-'}${item.head ? ` head ${item.head.slice(0, 12)}` : ''}`,
    `효과: ${item.effect ?? 'unknown'}`, (item.detail ?? '').replace(/\r\n|\r|\n/g, (match) => (match === '\r' ? '\\r' : '\\n')),
  ].join(' · '));
}

/** 미션 카드 — 머리 한 줄 ⊕ 조각 한 줄씩(상태·다음 수·선행) ⊕ 간선 한 줄씩. */
function missionLines(mission: TaskCard, pieces: TaskCard[]): string[] {
  const edges = pieces.flatMap((piece) => (piece.after ?? []).map((before) => `간선: ${before} -> ${piece.id}`));
  return [
    [mission.id, 'mission', mission.seat ?? '-', mission.checklistId ?? '-', mission.createdAt, `조각 ${pieces.length} · 간선 ${edges.length} · 출처 ${mission.splitSource ?? '-'}`, headLine(mission.text)].join('\t'),
    ...pieces.map((piece) => [`조각: ${piece.id}`, piece.status, nextMoveFor(piece).kind, `after: ${piece.after?.length ? piece.after.join(',') : '-'}`, headLine(piece.text),
      ...(piece.runId ? [`런: ${piece.runId}${cardPrNumber(piece) !== undefined ? ` · PR #${cardPrNumber(piece)}` : ''}`] : [])].join('\t')),
    ...edges,
    ...(mission.greenProposal ? [`green 제안: ${mission.greenProposal.at} · 칸 ${mission.greenProposal.checklistId ?? '-'} · 근거 ${Object.entries(mission.greenProposal.evidence).map(([id, ref]) => `${id}=${ref}`).join(', ')}`] : []),
  ];
}

/** `tasks show <ta-…>` — 카드 ⊕ 런 근거 묶기 ⊕ 다음 수. 출력·종료 코드는 `out`·`process.exitCode` 로만 낸다. */
export async function showTaskCard(id: string, opts: { json?: boolean }, deps: TasksCliDeps, out: (line: string) => void): Promise<void> {
  await registerTaskAgentSink(deps.registerSink);
  let card: TaskCard | undefined;
  try {
    card = readTaskCard(id, deps.taskStatePath);
    // 런 id 가 있으면 원장에서 골 id · PR 을 묶는다(찾았을 때만 적는다 · 실패는 그대로 보인다).
    const bindable = card?.pieces ? card.pieces : card ? [card.id] : [];
    for (const cardId of bindable) {
      // HARNESS-PARENT-ON-MSB1: 원격 부모 런은 원장이 그 호스트에 있다 — HQ 거울로 먼저 당긴다(읽기 전용).
      await mirrorRemoteCardLedger(cardId, deps);
      // shadow 는 묶을 카드가 있을 때만 싣는다 — 없는 카드·TOX 상세 조회는 이 클러스터를 안 싣는다(CLI-ENTRY-LAZY).
      const { replayRemoteCardMoves } = await import('../task-agent/shadow.js');
      try { await replayRemoteCardMoves(cardId, deps.taskStatePath ?? taskStatePathDefault(), deps.cardRunEvidence ?? {}); } catch (error) {
        try { debug.log('task-agent', 'card-binding-replay-failed', { card: cardId, reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
      }
      try { await refreshCardRunBinding(cardId, deps.taskStatePath ?? taskStatePathDefault(), deps.cardRunEvidence ?? {}); } catch (error) {
        // 근거 없음으로 보인다 — 원장 부재와 갈리게 실패는 남긴다.
        try { debug.log('task-agent', 'card-bind-failed', { card: cardId, via: 'show', error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
      }
      // TA-REVIEW-RESULT-CAPTURE — 떼어 띄운 live review 의 결과 파일을 이 카드 history 로 회수한다(대기 중인 요청이 있을 때만 쓴다 · 던지지 않는다).
      captureReviewResults(deps.taskStatePath ?? taskStatePathDefault(), { cardIds: [cardId], ...(deps.reviewResultNow ? { now: deps.reviewResultNow } : {}) });
    }
    if (card) card = readTaskCard(id, deps.taskStatePath);
  } catch (error) {
    out(error instanceof Error ? error.message : '과제 카드 읽기 실패');
    process.exitCode = 1;
    return;
  }
  if (!card) { out(`과제 카드 없음: ${id}`); process.exitCode = 1; return; }
  if (card.pieces) {
    let all: Record<string, TaskCard>;
    try { all = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {}; } catch (error) {
      out(error instanceof Error ? error.message : '과제 카드 읽기 실패');
      process.exitCode = 1;
      return;
    }
    const pieces = card.pieces.map((pieceId) => all[pieceId]).filter((piece): piece is TaskCard => piece !== undefined);
    const missingPieces = card.pieces.filter((pieceId) => !all[pieceId]);
    if (opts.json) {
      out(JSON.stringify({ card, nextMove: nextMoveFor(card), pieces: pieces.map((piece) => ({ card: piece, nextMove: nextMoveFor(piece) })), missingPieces }));
      if (missingPieces.length) process.exitCode = 1;
    }
    else {
      for (const line of missionLines(card, pieces)) out(line);
      for (const missing of missingPieces) { out(`조각 카드 없음: ${missing} — 선후 기록이 불완전하다`); process.exitCode = 1; }
    }
    return;
  }
  // DRAFT-NOT-ARCHIVE: 멈춘 런이 draft PR 대신 남긴 수확 가지(원장 `salvaged`). 못 읽었으면 «못 읽음»(⛔ 없음 아님).
  let salvage: Awaited<ReturnType<typeof readCardSalvageBranch>> = { salvageBranch: null };
  try { salvage = await readCardSalvageBranch(card, deps.cardRunEvidence ?? {}); }
  catch (error) { salvage = { salvageBranch: null, readErrors: [error instanceof Error ? error.message : String(error)] }; }
  const salvageUnread = !salvage.salvageBranch && !!salvage.readErrors?.length;
  if (opts.json) out(JSON.stringify({ card, nextMove: nextMoveFor(card), salvageBranch: salvage.salvageBranch, ...(salvageUnread ? { salvageBranchUnread: true } : {}) }));
  else {
    for (const line of taskCardLines(card)) out(line);
    if (card.parentHost) out(`부모 호스트: ${card.parentHost.host}${card.parentHost.pid ? ` (pid ${card.parentHost.pid})` : ''} · PR 까지만 — 병합은 HQ${card.parentHost.log ? ` · 로그 ${card.parentHost.host}:${card.parentHost.log}` : ''}`);
    if (salvage.salvageBranch) out(`수확 가지: ${salvage.salvageBranch} (draft PR 대신)`);
    else if (salvageUnread) out('수확 가지: 못 읽음(원장 읽기 실패)');
  }
}
