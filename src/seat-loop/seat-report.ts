import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig, type SeatLoopConfig } from '../user-config.js';
import { collectDraftMetrics, collectOverlapMetrics, countSalvagedToday, type DraftMetrics, type OverlapMetrics } from '../self-dev/draft-sweep.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';
import { readTaskAgentCover } from '../cli/tasks-cli.js';
import { formatTaskAgentCover } from '../task-agent/cover.js';
import type { TasksCliDeps } from '../cli/tasks-cli.js';
import { seatDay, seatLedgerPath, type OpCandidate, type SeatEntry } from './seat-loop.js';

export type SeatReportDeps = {
  root?: string;
  repo?: string;
  now?: () => Date;
  read?: (path: string) => string;
  config?: SeatLoopConfig;
  post?: boolean;
  send?: (body: string, seat: string, pr: number) => Promise<void> | void;
  draftMetrics?: (now: Date) => Promise<DraftMetrics>;
  overlapMetrics?: (now: Date) => Promise<OverlapMetrics>;
  coverLogs?: TasksCliDeps['coverLogs'];
  /** DRAFT-NOT-ARCHIVE salvage branches since the KST day start; null = unreadable. */
  salvagedToday?: (dayStart: Date, now: Date) => Promise<number | null>;
  runningRuns?: (runIds: readonly string[]) => { running: number; unknown: number } | null;
};
export type SeatReportResult = { seat: string; date: string; body: string; posted: boolean };
const repoRoot = resolve(import.meta.dir, '../..');
const exec = promisify(execFile);

function opJudgment(candidate: OpCandidate): { kind: 'card' | 'todo'; text: string } | null {
  if (candidate.kind === 'release-readiness') {
    if (candidate.verdict === 'no-open-release') return null;
    return { kind: 'todo', text: `판올림 준비 ${candidate.version} · ${candidate.verdict} · 빨강 ${candidate.red.join(', ') || '없음'} · 미결 ${candidate.undecided.join(', ') || '없음'} · 차단 ${candidate.blocked.join(', ') || '없음'}` };
  }
  if (candidate.kind === 'unassigned-cell') {
    if (candidate.verdict === 'none' || !candidate.id) return null;
    return { kind: 'todo', text: `빈 칸 분배 ${candidate.version} ${candidate.id} ${candidate.title ?? ''}`.trim() };
  }
  if (candidate.verdict === 'none' || !candidate.id) return null;
  const text = `결정 대리 ${candidate.id} ${candidate.title ?? ''}`.trim();
  return { kind: candidate.category && ['irreversible', 'money', 'security', 'secret', 'publish'].includes(candidate.category) ? 'card' : 'todo',
    text: `${text} (${candidate.category ?? '범주 없음'})` };
}

/** OVERLAP-METRIC line; ⛔ an unmeasured value says so instead of printing 0. */
function overlapLine(metrics: OverlapMetrics): string {
  if (metrics.sourceIncomplete || metrics.launches24h === null) return ' · 겹침 발사 24h 못 잼(원천 불완전)';
  const launched = metrics.launched === null ? '' : metrics.unmeasured
    ? ` 이상 (발사 ${metrics.launched} 중 ${metrics.unmeasured} 못 잼)` : ` (발사 ${metrics.launched})`;
  const rate = metrics.autoRate === null || metrics.linked === null || metrics.autoLanded === null
    ? (metrics.linked === 0 ? '표본 없음' : '못 잼')
    : `${(metrics.autoRate * 100).toFixed(1)}% (${metrics.autoLanded}/${metrics.linked})`;
  const median = metrics.secondSiblingMedianHours === null ? (metrics.linked === null ? '못 잼' : '표본 없음')
    : `${metrics.secondSiblingMedianHours.toFixed(1)}h`;
  const salvage = (metrics.salvaged ? ` · 수확 가지 형제 ${metrics.salvaged}(미착지)` : '')
    + (metrics.salvageUnmeasured ? ` · 수확 가지 ${metrics.salvageUnmeasured} 못 잼` : '');
  return ` · 겹침 발사 24h ${metrics.launches24h}${launched} · 겹침 자동 착지 ${rate} · 둘째 형제 착지 중앙값 ${median}${salvage}`;
}

async function defaultSend(body: string, seat: string, pr: number, repo: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    await exec('bash', [join(repo, 'scripts', 'coord-post.sh'), file], {
      cwd: repo, env: { ...process.env, COORD_ID: seat, CH_PR: String(pr) }, timeout: 30_000,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function seatReport(seat: string, deps: SeatReportDeps = {}): Promise<SeatReportResult> {
  if (!/^(?:MK|OP|TC|UX)$/.test(seat)) throw new Error(`unknown seat: ${seat}`);
  const now = (deps.now ?? (() => new Date()))();
  const date = seatDay(now);
  let raw = '';
  try { raw = (deps.read ?? ((path) => readFileSync(path, 'utf8')))(seatLedgerPath(seat, deps.root ?? effectiveInstanceRoot(), now)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const entries = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SeatEntry);
  // One line per item, its last state wins: an `attempting` row followed by `launched` is not «unconfirmed».
  const latest = new Map<string, SeatEntry>();
  const judgments = new Map<string, OpCandidate>();
  const filtered = { auto: 0, route: 0 };
  for (const entry of entries) {
    if (entry.candidate?.kind === 'decision-filter') {
      filtered[entry.candidate.verdict] += 1;
      continue;
    }
    if (seat === 'OP' && entry.candidate && 'verdict' in entry.candidate) {
      if (entry.candidate.verdict === 'none') {
        if (entry.candidate.id) {
          const key = entry.candidate.kind === 'unassigned-cell'
            ? `unassigned-cell:${JSON.stringify([entry.candidate.version, entry.candidate.id])}`
            : `decision-delegation:${entry.candidate.id}`;
          judgments.delete(key);
        } else for (const key of judgments.keys()) if (key.startsWith(`${entry.candidate.kind}:`)) judgments.delete(key);
        continue;
      }
      const key = entry.candidate.kind === 'unassigned-cell'
        ? `unassigned-cell:${JSON.stringify([entry.candidate.version, entry.candidate.id])}`
        : entry.candidate.kind === 'decision-delegation' && entry.candidate.id
          ? `${entry.candidate.kind}:${entry.candidate.id}` : entry.candidate.kind;
      judgments.set(key, entry.candidate);
      continue;
    }
    const key = entry.item ? `${entry.item.source}:${entry.item.version ?? ''}:${entry.item.id}` : `none:${entry.status}`;
    latest.delete(key);
    latest.set(key, entry);
  }
  const detail = [...latest.values()].map((entry) => {
    const label = entry.item ? `${entry.item.version ? `${entry.item.version} ` : ''}${entry.item.id} ${entry.item.title}`.replace(/\s+/g, ' ').trim() : '배정 없음';
    if (entry.status === 'launched') return `발사 ${label} (${entry.runId ?? 'runId 없음'})`;
    if (entry.status === 'hitl') return `결정 상정 ${label}`;
    if (entry.status === 'shadow') return `shadow ${label}`;
    if (entry.status === 'attempting' || entry.status === 'outcome-unknown') return `결과 확인 필요 ${entry.status} ${label}`;
    return `건너뜀 ${entry.status} ${label}`;
  });
  const classified = [...judgments.values()].map(opJudgment).filter((row): row is NonNullable<typeof row> => row !== null);
  const opDetail = (classified.length ? ` · 결정 카드 후보: ${classified.filter((row) => row.kind === 'card').map((row) => row.text).join(' / ') || '없음'} · OP 가 할 일: ${classified.filter((row) => row.kind === 'todo').map((row) => row.text).join(' / ') || '없음'}` : '')
    + (filtered.auto + filtered.route ? ` · 카드 거르기: 자동 ${filtered.auto} · 넘김 ${filtered.route}` : '');
  let draftDetail = '';
  if (seat === 'OP') {
    try {
      const metrics = await (deps.draftMetrics ?? (async (clock: Date) => {
        const [{ resolveRepositoryName }, { githubDraftSweepAdapters }] = await Promise.all([
          import('../harness/repository-name.js'), import('../harness/harness-cli-command.js'),
        ]);
        return collectDraftMetrics(resolveRepositoryName({}), githubDraftSweepAdapters(), clock);
      }))(now);
      draftDetail = ` · draft 재고 ${metrics.inventory} · 최장 나이 ${metrics.oldestAgeHours === null ? '해당 없음' : `${metrics.oldestAgeHours.toFixed(1)}h`} · needs-owner ${metrics.needsOwner} · 48h 전환율 ${metrics.conversion48h === null ? '표본 없음' : `${(metrics.conversion48h * 100).toFixed(1)}% (${metrics.converted48h}/${metrics.cohort48h})`}`;
    } catch { draftDetail = ' · draft 지표 못 읽음'; }
    try {
      const overlap = await (deps.overlapMetrics ?? (async (clock: Date) => {
        const [{ resolveRepositoryName }, { githubDraftSweepAdapters }, { readAskPreflightRowsSince, readSalvagedRowsSince }] = await Promise.all([
          import('../harness/repository-name.js'), import('../harness/harness-cli-command.js'), import('../self-dev/ask-launch-io.js'),
        ]);
        return collectOverlapMetrics(resolveRepositoryName({}), { ...githubDraftSweepAdapters(), listPreflightRows: readAskPreflightRowsSince, listSalvagedRows: readSalvagedRowsSince }, clock);
      }))(now);
      draftDetail += overlapLine(overlap);
    } catch { draftDetail += ' · 겹침 지표 못 읽음'; }
    let salvagedToday: number | null = null;
    try {
      salvagedToday = await (deps.salvagedToday ?? (async (dayStart: Date, clock: Date) => {
        const { readSalvagedRowsSince } = await import('../self-dev/ask-launch-io.js');
        return countSalvagedToday(await readSalvagedRowsSince(dayStart), dayStart, clock);
      }))(new Date(`${date}T00:00:00+09:00`), now);
    } catch { salvagedToday = null; }
    draftDetail += ` · 수확 가지 오늘 ${salvagedToday === null ? '못 잼' : salvagedToday}`;
    try {
      const cover = readTaskAgentCover({}, deps.coverLogs);
      draftDetail += ` · TASK-AGENT cover ${formatTaskAgentCover(cover.rows[0]!)}${cover.unreadableStores ? ` (logs.db ${cover.unreadableStores}개 못 읽음)` : ''}`;
    } catch {
      draftDetail += ` · TASK-AGENT cover ${formatTaskAgentCover({ verb: 'land', byTaskAgent: null, total: null, observedActions: null, ratio: null, state: 'unreadable', liveActions: null, shadowActions: null, stewardTransition: 'unmeasured' })}`;
    }
  }
  const runIds = [...new Set(entries.filter((entry) => entry.status === 'launched' && entry.runId).map((entry) => entry.runId!))];
  let runningDetail = ' · 도는 런 0';
  if (runIds.length) {
    try {
      const counts = (deps.runningRuns ?? ((ids: readonly string[]) => {
        const observed = queryRunningRuns({ runIds: ids, caller: 'seat-report' });
        if (observed.completeness !== 'complete') return null;
        return {
          running: observed.entries.filter((entry) => ids.includes(entry.runId) && entry.status === 'running').length,
          unknown: observed.entries.filter((entry) => ids.includes(entry.runId) && (entry.status === 'probable-running' || entry.status === 'unknown')).length,
        };
      }))(runIds);
      runningDetail = counts === null ? ' · 도는 런 못 잼'
        : ` · 도는 런 ${counts.running}(불확실 ${counts.unknown})`;
    } catch { runningDetail = ' · 도는 런 못 잼'; }
  }
  const body = `**[${seat}]** {{TS}} → 보고 ${date}: ${detail.join(' · ') || (classified.length ? 'OP 그림자 판단' : '원장 기록 없음')}${opDetail}${draftDetail}${runningDetail}`;
  const pr = (deps.config ?? getUserConfig().loops?.seat)?.reportPr;
  const posted = deps.post === true && pr !== undefined;
  if (posted) await (deps.send ?? ((text, id, number) => defaultSend(text, id, number, deps.repo ?? repoRoot)))(body, seat, pr);
  try { debug.log('seat.loop', 'reported', { seat, date, entries: entries.length, posted }); } catch { /* observation is fail-soft */ }
  return { seat, date, body, posted };
}
