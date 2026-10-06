import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { releasePathHold, releasePrFilePaths } from '../self-dev/release-path-guard.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import type { QueueItem, QueueSeat } from './harness-queue.js';
import type { RunGh, ScannedStoppedPr, StoppedPrCategory } from './helper-scan.js';

export interface RepairGoalInput {
  pr: number;
  category: StoppedPrCategory;
  /** The original user's request, not the supervisor's stop report or a paraphrase. */
  originalRequest: string;
  /** Remaining reviewer must-fix items, in their original wording and order. */
  mustFix: readonly string[];
}

/** Author a single follow-up goal without changing the original ask or reviewer findings. */
export function authorRepairGoal({ pr, category, originalRequest, mustFix }: RepairGoalInput): string | null {
  if ((category !== 'review-budget' && category !== 'review-oscillation') || !originalRequest.trim() || !mustFix.length || mustFix.some((item) => !item.trim())) {
    return null;
  }

  const guidance = category === 'review-oscillation'
    ? '기존 시험 설계를 보존하고 리뷰 진동·설계 역행을 확인한 뒤 남은 must-fix를 수리하라.'
    : '남은 must-fix를 수리하라. 원래 요청의 범위와 기존 시험 설계를 보존하라.';
  return `${originalRequest}${originalRequest.endsWith('\n') ? '' : '\n'}\n## PR #${pr} 수리\n${guidance}\n\n## 남은 must-fix (원문)\n${mustFix.join('\n')}`;
}

/** PR 본문에서 원 요청(## 요청 절)과 남은 must-fix(## 마지막 리뷰 must-fix · ## Follow-up must-fix 의 «- » 항목)를 원문 그대로 뽑는다. */
export function repairInputsFromBody(body: string): { originalRequest: string; mustFix: string[] } {
  const section = (title: RegExp) => {
    const lines = body.split('\n');
    const start = lines.findIndex((line) => title.test(line));
    if (start < 0) return [] as string[];
    const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const requestLines = section(/^## 요청\s*$/);
  while (requestLines[0] === '') requestLines.shift();
  while (requestLines.length > 1 && requestLines.at(-1) === '' && requestLines.at(-2) === '') requestLines.pop();
  if (requestLines.length === 2 && requestLines[1] === '') requestLines.pop();
  const originalRequest = requestLines.join('\n');
  const mustFix: string[] = [];
  for (const lines of [section(/^## 마지막 리뷰 must-fix/), section(/^## Follow-up must-fix/)]) {
    let item: string[] = [];
    const flush = () => {
      while (item.at(-1) === '') item.pop();
      if (item.length) mustFix.push(item.join('\n'));
      item = [];
    };
    for (const line of lines) {
      if (/^- /.test(line)) {
        flush();
        item.push(line);
      } else if (item.length) {
        item.push(line);
      }
    }
    flush();
  }
  return { originalRequest, mustFix };
}

export type RepairShadowRow = { pr: number; category: StoppedPrCategory; goalHash: string; at: string };

type RepairLedgerResult = 'shadow' | 'launched' | 'cap' | 'needs-human' | 'launch-failed';

type RepairLedgerLine = {
  pr: number; category: StoppedPrCategory; goalHash: string; at: string;
  mode: 'shadow' | 'live'; goal: string; result: RepairLedgerResult;
  /** Harness queue item id — the run itself starts on a later queue tick. */ queueId?: string; reason?: string;
};

const RELEASE_FILE_PAGE = 100;

/** Changed files of the original PR. A failed read is a reason to hold, never a reason to launch. */
async function changedFiles(pr: number, runGh: RunGh): Promise<string[]> {
  const pages: unknown[] = [];
  for (let page = 1; ; page++) {
    const raw = await runGh(['api', '--method', 'GET', '--raw-field', `per_page=${RELEASE_FILE_PAGE}`, '--raw-field', `page=${page}`, `repos/{owner}/{repo}/pulls/${pr}/files`]);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('gh api PR files returned an invalid file list');
    pages.push(parsed);
    if (parsed.length < RELEASE_FILE_PAGE) break;
  }
  return releasePrFilePaths(pages);
}

const QUEUE_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;

/** 원 PR 의 자리 라벨(elanous:seat-<자리> 또는 자리 이름 라벨). 없거나 둘 이상이면 MK. */
function seatOf(labels: readonly { name?: string }[] | undefined): QueueSeat {
  const found = new Set<QueueSeat>();
  for (const label of labels ?? []) {
    const name = label.name ?? '';
    const prefixed = /^elanous:seat-(OP|TC|MK|UX)$/.exec(name)?.[1];
    const bare = (QUEUE_SEATS as readonly string[]).includes(name) ? name : undefined;
    const seat = prefixed ?? bare;
    if (seat) found.add(seat as QueueSeat);
  }
  return found.size === 1 ? [...found][0]! : 'MK';
}

function helperSettings(config: UserConfig | undefined): { mode: 'shadow' | 'live'; perDay: number } {
  const helper = config?.harness?.helper;
  return {
    mode: helper?.repair === 'live' ? 'live' : 'shadow',
    perDay: typeof helper?.repairPerDay === 'number' && Number.isSafeInteger(helper.repairPerDay) && helper.repairPerDay >= 0
      ? helper.repairPerDay : 3,
  };
}

/** 그림자(기본): 수리 골을 원장에만 남긴다. live: 같은 함수로 대기열에 넣고 원 PR 을 superseded 로 표시한다. 같은 PR 은 평생 한 번. */
export async function recordRepairShadows(rows: readonly ScannedStoppedPr[], deps: {
  runGh: RunGh; root: string; now?: Date;
  config?: UserConfig;
  /** 대기열 추가. 생략하면 addHarnessQueue — 실제 발사는 기존 대기열 틱이 한다. */
  enqueue?: (input: { seat: QueueSeat; say: string; idempotencyKey: string }) => Promise<Pick<QueueItem, 'id'>>;
}): Promise<RepairShadowRow[]> {
  const ledger = join(deps.root, 'helper', 'repairs.jsonl');
  const prior: RepairLedgerLine[] = [];
  if (existsSync(ledger)) for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { prior.push(JSON.parse(line) as RepairLedgerLine); } catch { /* malformed line is skipped */ }
  }
  const { mode, perDay } = helperSettings(deps.config ?? getUserConfig());
  const day = (deps.now ?? new Date()).toISOString().slice(0, 10);
  // Terminal results end a PR for good. A shadow line blocks only while still in shadow (live must still launch it),
  // and a cap or failed launch blocks only for the same UTC day so the PR is retried tomorrow (ACP must-fix).
  // Ledger lines written before results existed have no `result`; they were shadow records.
  for (const line of prior) if (!line.result) line.result = 'shadow';
  const seen = new Set(prior.filter((line) => line.result === 'launched' || line.result === 'needs-human'
    || (line.result === 'shadow' && mode === 'shadow')
    || ((line.result === 'cap' || line.result === 'launch-failed') && line.at.slice(0, 10) === day)).map((line) => line.pr));
  // Distinct PRs: a follow-up repair line for an already launched PR is not a second launch.
  let launchedToday = new Set(prior.filter((line) => line.result === 'launched' && line.at.slice(0, 10) === day).map((line) => line.pr)).size;
  // A launched line whose label/comment failed is repaired here — the follow-up only, never a second enqueue.
  if (mode === 'live') {
    const latest = new Map<number, RepairLedgerLine>();
    for (const line of prior) latest.set(line.pr, line);
    for (const line of latest.values()) {
      if (line.result !== 'launched' || !line.reason?.startsWith('후속 실패') || !line.queueId) continue;
      const followups: string[] = [];
      if (line.reason.includes('label ·')) {
        try { await deps.runGh(['pr', 'edit', String(line.pr), '--add-label', 'elanous:superseded']); }
        catch (error) { followups.push(`label · ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (line.reason.includes('comment ·')) {
        try { await deps.runGh(['pr', 'comment', String(line.pr), '--body', `수리 대기열 항목 ${line.queueId} 로 대체(런은 대기열 틱에서 시작)`]); }
        catch (error) { followups.push(`comment · ${error instanceof Error ? error.message : String(error)}`); }
      }
      const repaired: RepairLedgerLine = { ...line, at: (deps.now ?? new Date()).toISOString(), ...(followups.length ? { reason: `후속 실패 · ${followups.join(' · ')}` } : { reason: '후속 복구' }) };
      appendFileSync(ledger, JSON.stringify(repaired) + '\n');
      debug.log('harness.helper', 'repair-followup-retried', { pr: line.pr, queueId: line.queueId, remaining: followups.length });
    }
  }
  const enqueue = deps.enqueue ?? (async (input) => {
    const { addHarnessQueue } = await import('./harness-queue.js');
    return addHarnessQueue(input, { root: deps.root });
  });
  const written: RepairShadowRow[] = [];
  for (const row of rows) {
    if ((row.category !== 'review-budget' && row.category !== 'review-oscillation') || seen.has(row.pr)) continue;
    const view = JSON.parse(await deps.runGh(['pr', 'view', String(row.pr), '--json', 'body'])) as { body: string };
    // 자리 라벨은 본문 조회와 분리한다 — 기존 본문 조회 계약(--json body)을 그대로 둔다. 못 읽으면 MK.
    let labels: { name?: string }[] | undefined;
    if (mode === 'live') {
      try { labels = (JSON.parse(await deps.runGh(['pr', 'view', String(row.pr), '--json', 'labels'])) as { labels?: { name?: string }[] }).labels; }
      catch { labels = undefined; }
    }
    const goal = authorRepairGoal({ pr: row.pr, category: row.category, ...repairInputsFromBody(view.body) });
    if (!goal) continue;
    const at = (deps.now ?? new Date()).toISOString();
    const base = { pr: row.pr, category: row.category, goalHash: createHash('sha256').update(goal).digest('hex').slice(0, 16), at, goal };
    let record: RepairLedgerLine = { ...base, mode: 'shadow', result: 'shadow' };
    if (mode === 'live') {
      let files: string[] | undefined;
      try { files = await changedFiles(row.pr, deps.runGh); }
      catch (error) { files = undefined; debug.log('harness.helper', 'repair-files-unreadable', { pr: row.pr, reason: String(error) }); }
      const release = files && releasePathHold(files);
      // 상한은 «발사한 수»의 상한이다. 사람 승인이 필요한 PR 은 그 수를 쓰지 않으므로 상한보다 먼저 가른다.
      if (files && !release && launchedToday >= perDay) {
        record = { ...base, mode: 'live', result: 'cap', reason: '상한' };
      } else if (!files) {
        // An unreadable file list is transient: hold today, retry on a later day (never a permanent needs-human) (ACP must-fix).
        record = { ...base, mode: 'live', result: 'launch-failed', reason: '변경 파일 조회 실패 · 다음 날 재시도' };
      } else if (release) {
        record = { ...base, mode: 'live', result: 'needs-human', reason: '사람 승인 필요' };
      } else {
        let item: Pick<QueueItem, 'id'> | undefined;
        try {
          item = await enqueue({ seat: seatOf(labels), say: goal, idempotencyKey: `helper-repair-${row.pr}` });
          // The queue item exists from here on: a later label/comment failure is recorded on the launched line,
          // never as launch-failed (which would let the next scan enqueue a second repair) (ACP must-fix).
          const followups: string[] = [];
          try { await deps.runGh(['pr', 'edit', String(row.pr), '--add-label', 'elanous:superseded']); }
          catch (error) { followups.push(`label · ${error instanceof Error ? error.message : String(error)}`); }
          try { await deps.runGh(['pr', 'comment', String(row.pr), '--body', `수리 대기열 항목 ${item.id} 로 대체(런은 대기열 틱에서 시작)`]); }
          catch (error) { followups.push(`comment · ${error instanceof Error ? error.message : String(error)}`); }
          record = { ...base, mode: 'live', result: 'launched', queueId: item.id, ...(followups.length ? { reason: `후속 실패 · ${followups.join(' · ')}` } : {}) };
          launchedToday += 1;
          debug.log('harness.helper', 'repair-launched', { pr: row.pr, queueId: item.id, mode: 'live', followupFailures: followups.length });
        } catch (error) {
          record = { ...base, mode: 'live', result: 'launch-failed', reason: `발사 실패 · ${error instanceof Error ? error.message : String(error)}` };
          debug.log('harness.helper', 'repair-launch-failed', { pr: row.pr, reason: record.reason });
        }
      }
    }
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, JSON.stringify(record) + '\n');
    if (record.result === 'shadow') debug.log('harness.helper', 'repair-authored', { pr: row.pr, category: row.category, mode: 'shadow' });
    seen.add(row.pr);
    written.push({ pr: base.pr, category: base.category, goalHash: base.goalHash, at: base.at });
  }
  return written;
}
