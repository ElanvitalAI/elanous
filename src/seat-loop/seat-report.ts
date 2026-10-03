import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig, type SeatLoopConfig } from '../user-config.js';
import { seatDay, seatLedgerPath, type OpCandidate, type SeatEntry } from './seat-loop.js';

export type SeatReportDeps = {
  root?: string;
  repo?: string;
  now?: () => Date;
  read?: (path: string) => string;
  config?: SeatLoopConfig;
  post?: boolean;
  send?: (body: string, seat: string, pr: number) => Promise<void> | void;
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
  for (const entry of entries) {
    if (seat === 'OP' && entry.candidate) {
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
  const opDetail = classified.length ? ` · 결정 카드 후보: ${classified.filter((row) => row.kind === 'card').map((row) => row.text).join(' / ') || '없음'} · OP 가 할 일: ${classified.filter((row) => row.kind === 'todo').map((row) => row.text).join(' / ') || '없음'}` : '';
  const body = `**[${seat}]** {{TS}} → 보고 ${date}: ${detail.join(' · ') || (classified.length ? 'OP 그림자 판단' : '원장 기록 없음')}${opDetail}`;
  const pr = (deps.config ?? getUserConfig().loops?.seat)?.reportPr;
  const posted = deps.post === true && pr !== undefined;
  if (posted) await (deps.send ?? ((text, id, number) => defaultSend(text, id, number, deps.repo ?? repoRoot)))(body, seat, pr);
  try { debug.log('seat.loop', 'reported', { seat, date, entries: entries.length, posted }); } catch { /* observation is fail-soft */ }
  return { seat, date, body, posted };
}
