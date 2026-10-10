/**
 * TA-REVIEW-RESULT-CAPTURE — live `review` 수가 떼어 띄운 `self review --json` 의 결과를 «파일로» 받아 카드에 되돌린다.
 *
 * - 왜: `defaultRequestReview` 는 리뷰를 떼어 띄우고(stdio ignore) spawn 만 확인했다 — `self review` 는 PR 코멘트를 안 달고
 *   결과를 `--json` stdout ⊕ logs 에만 낸다. stdout 을 버리니 TA 는 판정을 영영 못 받았다(카드 줄 «result not received»).
 * - 무엇을: 띄울 때 자식 stdout 을 `<상태 파일 디렉터리>/review-results/<card>-<pr>-<head12>.json` 로 받는다(떼어 띄움 유지 ·
 *   TA 루프는 안 막는다). 경로는 `reviewRequests[]` 항목 ⊕ live-move 줄에 `resultPath` 로 싣는다.
 * - 회수: 다음 TA 판단 틱(`recordTaskAgentShadowMove`) · `tasks show <card>` 가 그 파일을 읽어 같은 카드 history 에
 *   `live-move-result` 줄을 «한 번» 덧붙인다. 파일이 «대기 상한» 지나도 결과가 없으면 `review process produced no result` 줄.
 *   지어내지 않는다 — 읽은 JSON 의 칸만 옮긴다.
 * - 관측: `task-agent` · `review-result-captured` / `review-result-missing`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { LIVE_MOVE_RESULT_EVENT, readTaskAgentState, updateTaskCard, type TaskCard, type TaskCardEvent } from './task-hand.js';

export const REVIEW_RESULT_MISSING_EFFECT = 'review process produced no result';
/** 결과 파일은 있는데 읽지 못했다(EACCES 등) — «결과 없음»과 가른다(결과가 있었을 수 있다). */
export const REVIEW_RESULT_UNREADABLE_EFFECT = 'review result file unreadable';
/** 리뷰 한 판(1차 ⊕ 폴백 · ACP 300s 상한 여러 번)을 넉넉히 덮는 대기 상한 — 이 안에는 «아직»으로 본다. */
export const REVIEW_RESULT_WAIT_MS = 90 * 60_000;

const SHA40 = /^[0-9a-f]{40}$/i;

/** 결과 파일 경로 — 카드 상태 파일 옆 `review-results/` · 카드 id 는 파일 이름에 안전한 글자만. */
export function reviewResultPath(statePath: string, cardId: string, pr: number, head: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(dirname(statePath), 'review-results', `${safe(cardId)}-${pr}-${safe(head.slice(0, 12))}.json`);
}

export interface ParsedReviewResult {
  pr?: number;
  verdict: string | null;
  reviewed: boolean | null;
  /** must-fix 목록이 문자열 배열일 때만 수 — 아니면 null(«0» 이 아니라 «모름»). */
  mustFix: number | null;
  reviewRoute: string | null;
  /** 리뷰가 읽은 머리(`headCommit`) — 40자 sha 일 때만. */
  head: string | null;
  error: string | null;
}

/**
 * `self review --json` stdout 을 해석한다 — 그 stdout 에는 다른 줄이 섞일 수 있어 «뒤에서부터» 첫 JSON 객체 줄을 쓴다.
 * 못 읽으면 null(쓰는 중이거나 자식이 죽었다 — 판단은 호출자가 시각으로 한다).
 */
export function parseReviewResultOutput(text: string): ParsedReviewResult | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    // 결과 «모양»일 때만 확정한다 — `self review --json` 의 결과는 PR 번호 ⊕ (판정 칸 ⊕ must-fix 목록 | 오류 문자열)이다.
    //   다른 JSON 줄(중간 로그)을 결과로 확정하면 뒤에 나온 진짜 판정을 중복 방지가 영영 막는다.
    const isResult = v.pr !== undefined && (('verdict' in v && Array.isArray(v.mustFix)) || typeof v.error === 'string');
    if (!isResult) continue;
    const prRaw = typeof v.pr === 'number' ? v.pr : typeof v.pr === 'string' ? Number(String(v.pr).replace(/^#/, '')) : NaN;
    return {
      ...(Number.isSafeInteger(prRaw) && prRaw > 0 ? { pr: prRaw } : {}),
      verdict: typeof v.verdict === 'string' ? v.verdict : null,
      reviewed: typeof v.reviewed === 'boolean' ? v.reviewed : null,
      mustFix: Array.isArray(v.mustFix) && v.mustFix.every((fix) => typeof fix === 'string') ? v.mustFix.length : null,
      reviewRoute: typeof v.reviewRoute === 'string' ? v.reviewRoute : null,
      head: typeof v.headCommit === 'string' && SHA40.test(v.headCommit) ? v.headCommit : null,
      error: typeof v.error === 'string' ? v.error : null,
    };
  }
  return null;
}

type ReviewRequest = NonNullable<TaskCard['reviewRequests']>[number];

function alreadyCaptured(card: TaskCard, resultPath: string): boolean {
  return (card.history ?? []).some((item) => item.event === LIVE_MOVE_RESULT_EVENT && item.resultPath === resultPath);
}

/** 회수 대기 중인 요청 — 결과 경로가 있고 · 띄우기 오류가 없고 · 아직 결과 줄이 없는 것. */
export function pendingReviewResults(card: TaskCard): ReviewRequest[] {
  return (card.reviewRequests ?? []).filter((entry) => typeof entry.resultPath === 'string' && entry.resultPath && !entry.error && !alreadyCaptured(card, entry.resultPath));
}

export interface CaptureReviewResultsOptions {
  /** 이 카드들만 본다 — 없으면 상태 파일의 모든 카드. */
  cardIds?: readonly string[];
  now?: () => Date;
  /** 시험 seam — 결과 파일 읽기(없으면 ENOENT 를 던진다). */
  readFile?: (path: string) => string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export type ReviewResultCapture =
  | { card: string; pr: number; resultPath: string; status: 'captured'; entry: TaskCardEvent }
  | { card: string; pr: number; resultPath: string; status: 'missing'; entry: TaskCardEvent }
  | { card: string; pr: number; resultPath: string; status: 'pending' };

/**
 * 대기 중인 리뷰 결과를 회수한다 — 던지지 않는다(상태 파일 읽기 실패는 빈 결과 · 관측만).
 * 결과 줄은 카드 잠금 안에서 «아직 없을 때만» 덧붙인다(두 틱이 겹쳐도 한 줄).
 */
export function captureReviewResults(statePath: string, opts: CaptureReviewResultsOptions = {}): ReviewResultCapture[] {
  const log = opts.log ?? ((c: string, e: string, d: Record<string, unknown>) => debug.log(c, e, d));
  const emit = (event: string, data: Record<string, unknown>) => { try { log('task-agent', event, data); } catch { /* fail-soft */ } };
  let tasks: Record<string, TaskCard>;
  try { tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {}; } catch (error) {
    emit('review-result-capture-failed', { statePath, reason: (error instanceof Error ? error.message : String(error)).slice(-300) });
    return [];
  }
  const ids = opts.cardIds ?? Object.keys(tasks);
  // 시각은 대기 중인 요청을 «처음 볼 때»만 읽는다 — 회수할 것이 없으면 시계도 안 건드린다(종전 틱과 같다).
  let nowValue: Date | undefined;
  const nowOf = () => (nowValue ??= (opts.now ?? (() => new Date()))());
  const waitMs = REVIEW_RESULT_WAIT_MS;
  const read = opts.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const out: ReviewResultCapture[] = [];
  for (const id of ids) {
    const card = tasks[id];
    if (!card) continue;
    for (const request of pendingReviewResults(card)) {
      const resultPath = request.resultPath!;
      let text: string | null = null;
      let readError: string | null = null;
      let unreadable = false;
      try { text = read(resultPath); } catch (error) {
        unreadable = (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
        readError = unreadable ? (error instanceof Error ? error.message : String(error)).slice(-200) : 'result file not created';
      }
      const output = text !== null ? parseReviewResultOutput(text) : null;
      // 요청한 PR 의 결과만 확정한다 — 다른 PR 번호(또는 번호 없음)의 결과는 이 카드 결과로 옮기지 않는다.
      const parsed = output && output.pr === request.pr ? output : null;
      const mismatch = output && !parsed ? `result PR ${output.pr ?? 'unknown'} does not match requested #${request.pr}` : null;
      const now = nowOf();
      const requestedAt = Date.parse(request.at);
      const waitedMs = Number.isFinite(requestedAt) ? now.getTime() - requestedAt : null;
      let entry: TaskCardEvent;
      let status: 'captured' | 'missing';
      if (parsed) {
        status = 'captured';
        entry = {
          at: now.toISOString(), event: LIVE_MOVE_RESULT_EVENT, kind: 'review', pr: request.pr,
          ...(parsed.head ? { head: parsed.head } : {}),
          verdict: parsed.verdict, reviewed: parsed.reviewed, mustFix: parsed.mustFix, reviewRoute: parsed.reviewRoute,
          resultPath,
          effect: `review result captured · verdict ${parsed.verdict ?? 'none'} · reviewed ${parsed.reviewed ?? 'unknown'} · must-fix ${parsed.mustFix ?? 'unknown'}`,
          ...(parsed.error ? { detail: parsed.error.slice(0, 300) } : {}),
        };
      } else if (waitedMs !== null && waitedMs >= waitMs) {
        status = 'missing';
        const reason = readError ?? mismatch ?? (text !== null && text.trim() ? 'output has no JSON result line' : 'result file empty');
        entry = {
          at: now.toISOString(), event: LIVE_MOVE_RESULT_EVENT, kind: 'review', pr: request.pr, head: request.head,
          resultPath, effect: unreadable ? REVIEW_RESULT_UNREADABLE_EFFECT : REVIEW_RESULT_MISSING_EFFECT, detail: `${reason} after ${Math.round(waitedMs / 60_000)}m (requested ${request.at})`,
        };
      } else {
        out.push({ card: id, pr: request.pr, resultPath, status: 'pending' });
        continue;
      }
      let wrote = false;
      try {
        updateTaskCard(statePath, id, (current) => {
          // 잠금 안에서 다시 본다 — 그 사이 요청이 오류로 바뀌었거나 없어졌거나 이미 회수됐으면 쓰지 않는다.
          if (!current || !pendingReviewResults(current).some((entry) => entry.resultPath === resultPath && entry.pr === request.pr)) return undefined;
          wrote = true;
          return { ...current, history: [...(current.history ?? []), entry] };
        });
      } catch (error) {
        emit('review-result-capture-failed', { card: id, pr: request.pr, resultPath, reason: (error instanceof Error ? error.message : String(error)).slice(-300) });
        continue;
      }
      if (!wrote) continue;
      if (status === 'captured') {
        emit('review-result-captured', { card: id, pr: request.pr, requestedHead: request.head, head: entry.head ?? null, verdict: entry.verdict, reviewed: entry.reviewed, mustFix: entry.mustFix, reviewRoute: entry.reviewRoute, resultPath });
      } else {
        emit('review-result-missing', { card: id, pr: request.pr, head: request.head, resultPath, waitedMs, reason: entry.detail });
      }
      out.push({ card: id, pr: request.pr, resultPath, status, entry });
    }
  }
  return out;
}

/**
 * 다음 수 판단의 입력 — 카드에 회수된 리뷰 결과 중 «그 머리(`head`)»의 «가장 최근» 결과가 실제로 돈(reviewed) pass 이고
 * 리뷰한 머리가 40자 sha 일 때만 `selfReview` 모양으로 돌려준다(슈퍼바이저가 나르는 `self-implement-cli` 의 규칙과 같다 ·
 * must-fix 수는 읽었을 때만). 머리마다 고르므로 여러 머리의 결과가 어떤 순서로 회수돼도 지금 머리의 판정만 본다.
 * 그 밖(fail·warn·미실행·없음·다른 머리)은 undefined — 판단부 입력을 비워 둔다(«통과»로 읽지 않는다).
 */
export function capturedSelfReview(card: TaskCard | undefined, pr: number, head: string): { verdict: 'pass'; head: string; mustFixCount?: number } | undefined {
  if (!SHA40.test(head)) return undefined;
  const latest = (card?.history ?? []).filter((item) => item.event === LIVE_MOVE_RESULT_EVENT && item.kind === 'review' && item.pr === pr
    && item.effect !== REVIEW_RESULT_MISSING_EFFECT && item.effect !== REVIEW_RESULT_UNREADABLE_EFFECT && typeof item.head === 'string' && item.head.toLowerCase() === head.toLowerCase()).at(-1);
  // 결과 줄의 detail 은 리뷰 오류(`error`)일 때만 실린다 — 오류가 섞인 결과는 pass 후보가 아니다.
  if (!latest || latest.detail || latest.reviewed !== true || latest.verdict !== 'pass' || !latest.head || !SHA40.test(latest.head)) return undefined;
  return { verdict: 'pass', head: latest.head, ...(typeof latest.mustFix === 'number' ? { mustFixCount: latest.mustFix } : {}) };
}

/**
 * TA-LAND-WARN-MUSTFIX0 — land 입력용: 그 머리의 «가장 최근» 회수 결과가 실제로 돈(reviewed) 리뷰이고 오류가 없으며
 * verdict 가 pass «또는» warn 이면 돌려준다(정본 규칙 «warn ⊕ must-fix 0 = 통과» · #25941 canAuto · #25962).
 * must-fix 수는 읽었을 때만 싣는다 — 0 인지는 호출부·land 관문이 본다(모르면 거부 · fail-closed).
 * `capturedSelfReview`(판단부 입력 · pass 만)는 그대로 둔다 — 멈춤 시점 판단부의 정합은 이 함수의 몫이 아니다.
 */
export function capturedLandReview(card: TaskCard | undefined, pr: number, head: string): { verdict: 'pass' | 'warn'; head: string; reviewed: true; mustFixCount?: number } | undefined {
  if (!SHA40.test(head)) return undefined;
  const latest = (card?.history ?? []).filter((item) => item.event === LIVE_MOVE_RESULT_EVENT && item.kind === 'review' && item.pr === pr
    && item.effect !== REVIEW_RESULT_MISSING_EFFECT && item.effect !== REVIEW_RESULT_UNREADABLE_EFFECT && typeof item.head === 'string' && item.head.toLowerCase() === head.toLowerCase()).at(-1);
  if (!latest || latest.detail || latest.reviewed !== true || (latest.verdict !== 'pass' && latest.verdict !== 'warn') || !latest.head || !SHA40.test(latest.head)) return undefined;
  return { verdict: latest.verdict, head: latest.head, reviewed: true, ...(typeof latest.mustFix === 'number' ? { mustFixCount: latest.mustFix } : {}) };
}

/** 그 PR 에 회수된 «돈 pass» 결과가 하나라도 있나 — 지금 머리를 조회(gh)할지 정하는 싼 검사. */
export function hasCapturedPass(card: TaskCard | undefined, pr: number): boolean {
  return (card?.history ?? []).some((item) => item.event === LIVE_MOVE_RESULT_EVENT && item.kind === 'review' && item.pr === pr
    && !item.detail && item.reviewed === true && item.verdict === 'pass' && typeof item.head === 'string' && SHA40.test(item.head));
}
