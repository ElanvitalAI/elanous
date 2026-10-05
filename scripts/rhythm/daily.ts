#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { listSchedules } from '../../src/release-loop/release-schedule.js';
import { devVersion, listChecklist } from '../../src/release-loop/checklist.js';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';
import { selectProact1Lite, type ProactSignals } from '../../src/decisions/proact1-lite.js';
import { trafficTick, seatOfTree } from '../../src/loops/orchestrator/traffic.js';
import { defaultListHarnessProcesses, githubDraftSweepAdapters } from '../../src/harness/harness-cli-command.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS } from '../../src/user-config.js';
import { loopEvent } from '../../src/loops/observe.js';
import { kindRouteTarget, mainHomeTarget } from '../../src/domains/telegram-kind-route.js';
import { recordOutbound } from '../../src/domains/outbound-alert.js';
import { listSelfDevRuns, runSummaryLine, selfDevRunsDir } from '../../src/self-dev/run-store.js';
import { runDraftSweep } from '../../src/self-dev/draft-sweep.js';

export type Section<T> = { status: 'ok'; value: T } | { status: 'unreadable'; reason: string };
export type Landing = { title: string; seat: string; mergedAt: string; prNumber?: number };
type RunSummary = { line: string; prNumbers: number[]; updatedYesterday: boolean };
export type Release = { version: string; green: number; total: number; nextVersion: string | null; nextGreen: number | null; nextTotal: number | null; cutAt: string | null; red: { name: string }[] };
export type Loop = { name: string; status: 'alive' | 'late' | 'failing' | 'off' | 'unknown'; scope?: string };
export type Seat = { name: string; running: number; cap: number; idle: boolean; nextCell?: string | null };
export type Pending = { name: string; openedAt: string };
export type News = { title: string; url: string; implication: string };
export type DailyParts = {
  landings: Section<Landing[]> & { runSummaries?: RunSummary[] }; release: Section<Release>; loops: Section<Loop[]>;
  grid: Section<Seat[]>; decisions: Section<Pending[]>; news: Section<News[]>;
};
export type Risk = { name: string; score: number; reason: string };
export type DailyReview = { markdown: string; header: string; risks: Risk[]; sections: Record<keyof DailyParts, 'ok' | 'unreadable'> };

const repo = join(import.meta.dir, '../..');
const kstDay = (date: Date) => new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortReason = (reason: string) => reason.split(/\r?\n/, 1)[0]!.trim().slice(0, 200);
const unreadable = <T>(reason: string): Section<T> => ({ status: 'unreadable', reason: shortReason(reason) });
const adArticle = (title: string, body: string) => /토토|카지노|배팅|베팅|입플|슬롯|도박|성인|바카라|스포츠.?토토|성인물|야동/i.test(`${title} ${body}`);
const cleanNews = (items: News[]) => items.filter(item => !adArticle(item.title, item.implication));
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';

function command(args: string[], timeout = 30_000): string {
  const result = spawnSync('bun', args, { cwd: repo, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error ? reasonOf(result.error) : result.stderr?.trim() || `exit ${result.status}`);
  return result.stdout;
}
function readJson(args: string[], timeout?: number): unknown {
  const output = command(args, timeout);
  try { return JSON.parse(output); } catch { throw new Error(`JSON 응답 아님: ${args.join(' ')}`); }
}
function cli(...args: string[]): unknown {
  const root = effectiveInstanceRoot();
  return readJson(['bin/elanous.mjs', ...(root === prodInstanceRoot() ? [] : [`--test=${root}`]), ...args]);
}

/** 어제 갱신한 런과 어제 병합된 PR에 연결된 런의 읽기 전용 한 줄 요약. */
export function collectRunSummaries(now: Date, root = effectiveInstanceRoot(), landedPrNumbers: readonly number[] = []): RunSummary[] {
  const yesterday = kstDay(new Date(now.getTime() - 86_400_000));
  const from = new Date(`${yesterday}T00:00:00+09:00`).getTime();
  const landed = new Set(landedPrNumbers);
  return listSelfDevRuns(selfDevRunsDir(root))
    .map(run => {
      const prNumbers = run.results.map(result => result.prNumber ?? Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(result.prUrl ?? '')?.[1]))
        .filter(number => Number.isSafeInteger(number) && number > 0);
      return { run, prNumbers: [...new Set(prNumbers)] };
    })
    .filter(({ run, prNumbers }) => (run.updatedAt >= from && run.updatedAt < from + 86_400_000)
      || prNumbers.some(number => landed.has(number)))
    .map(({ run, prNumbers }) => ({ line: runSummaryLine(run), updatedYesterday: run.updatedAt >= from && run.updatedAt < from + 86_400_000,
      prNumbers }));
}

/** 기본은 어제 KST 00:00–24:00, 창을 주면 그 안에 실제 병합된 PR만 센다. */
export async function collectLandings(now: Date, window?: { from: Date; to: Date }, source?: { repoRoot?: string; repoName?: string; stateRoot?: string }): Promise<Landing[]> {
  const configuredTree = source?.repoRoot ?? getUserConfig().ops?.cronRepoRoot;
  const tree = configuredTree || repo;
  const remote = source?.repoName ?? (() => {
    if (!existsSync(join(tree, '.git'))) return null;
    const result = spawnSync('git', ['-C', tree, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5_000 });
    const path = result.status === 0 ? /(?:github\.com[:/])([^/\s]+\/[^/\s]+)\s*$/.exec(result.stdout)?.[1] : null;
    return path?.replace(/\.git$/, '') ?? null;
  })();
  if (!remote) throw new Error('저장소 미지정');
  const yesterday = kstDay(new Date(now.getTime() - 86_400_000));
  const from = window?.from ?? new Date(`${yesterday}T00:00:00+09:00`);
  const to = window?.to ?? new Date(from.getTime() + 86_400_000);
  // GitHub's merged: date search is UTC; include the UTC date containing KST midnight, then filter precisely below.
  const searchDay = window ? from.toISOString().slice(0, 10) : yesterday;
  const data = cli('gh', 'pr', 'list', '--repo', remote, '--state', 'merged', '--search', `merged:>=${searchDay}`, '--limit', '500', '--json', 'number,title,mergedAt');
  if (!Array.isArray(data)) throw new Error('병합 목록 형식 오류');
  // 주간 창은 잘린 목록을 정확한 합계로 취급할 수 없다. 데일리 기본 경로는 그대로 둔다.
  if (window && data.length >= 500) throw new Error('병합 목록 500건 조회 상한 도달 · 주간 착지 집계 불완전');
  const seatByPr = new Map<number, string>();
  // A PR number is local to its repository. A bare prNumber cannot establish which repository it belongs to.
  const targetRepo = remote.replace(/\.git$/i, '').toLowerCase();
  // Newest checkpoint wins when a PR appears in more than one run; titles are not seat evidence.
  for (const run of listSelfDevRuns(selfDevRunsDir(source?.stateRoot ?? effectiveInstanceRoot()))) {
    if (!['OP', 'TC', 'MK', 'UX'].includes(run.seat ?? '')) continue;
    for (const result of run.results) {
      let url: URL;
      try { url = new URL(result.prUrl ?? ''); } catch { continue; }
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') continue;
      const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== targetRepo) continue;
      const number = Number(match[3]);
      if (result.prNumber !== undefined && result.prNumber !== number) continue;
      if (Number.isSafeInteger(number) && number > 0 && !seatByPr.has(number)) seatByPr.set(number, run.seat!);
    }
  }
  return rows(data).filter(r => typeof r.title === 'string' && typeof r.mergedAt === 'string' && Number.isFinite(Date.parse(r.mergedAt as string)) && Date.parse(r.mergedAt as string) >= from.getTime() && Date.parse(r.mergedAt as string) < to.getTime())
    .map(r => ({ title: string(r.title), mergedAt: string(r.mergedAt), seat: typeof r.number === 'number' ? seatByPr.get(r.number) ?? '미분류' : '미분류',
      ...(typeof r.number === 'number' ? { prNumber: r.number } : {}) }))
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || sortNames(a.title, b.title));
}

/** 체크리스트·일정은 읽기 API만 호출한다(상태 전이 없음). */
export async function collectRelease(): Promise<Release> {
  const root = effectiveInstanceRoot();
  if (!existsSync(join(root, 'release', 'features.sqlite'))) throw new Error('판 원장 없음');
  const schedules = listSchedules(root).sort((a, b) => a.cutAt.localeCompare(b.cutAt));
  const version = devVersion().replace(/-dev\.\d+$/, '');
  const index = schedules.findIndex(s => s.version === version);
  if (index < 0) throw new Error(`판 일정 없음: ${version}`);
  const current = listChecklist(version, root).items;
  const next = schedules[index + 1];
  const nextItems = next ? listChecklist(next.version, root).items : null;
  return { version, green: current.filter(i => i.status === 'green').length, total: current.length,
    nextVersion: next?.version ?? null, nextGreen: nextItems ? nextItems.filter(i => i.status === 'green').length : null,
    nextTotal: nextItems?.length ?? null, cutAt: schedules[index]!.cutAt,
    red: current.filter(i => i.status === 'red').map(i => ({ name: `${i.id} ${i.title}` })) };
}

export async function collectLoops(): Promise<Loop[]> {
  const data = cli('loop', 'status', '--all', '--json');
  const values = record(data).results;
  if (!Array.isArray(values)) throw new Error('루프 목록 형식 오류');
  return rows(values).map(r => {
    const status = string(r.state);
    if (!['alive', 'late', 'failing', 'off', 'unknown'].includes(status)) throw new Error(`루프 상태 형식 오류: ${status}`);
    const scope = string(r.scope) || string(record(data).scope);
    return { name: string(r.id), status: status as Loop['status'], scope };
  });
}

/** traffic.ts CLI의 live 모드는 요청 원장에 쓴다. 같은 입력을 읽어 trafficTick만 호출한다. */
export async function collectGrid(): Promise<Seat[]> {
  const cfg = getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
  const root = effectiveInstanceRoot();
  if (!existsSync(join(root, 'release', 'features.sqlite'))) throw new Error('판 원장 없음');
  const observation = defaultListHarnessProcesses();
  if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
  const version = devVersion().replace(/-dev\.\d+$/, '');
  const result = trafficTick({ now: new Date(), caps: cfg.seatCaps, openCells: listChecklist(version, root).items,
    processes: observation.records.map(p => ({ ...p, seat: seatOfTree(p.cwdStatus === 'unknown' ? undefined : p.cwd, cfg) })) });
  return result.seats.map(r => ({ name: r.seat, running: r.running, cap: r.cap, idle: r.idle,
    nextCell: r.nextCell ? `${r.nextCell.id} ${r.nextCell.title}` : null }));
}

export async function collectDecisions(): Promise<Pending[]> {
  const ledger = new DecisionLedger();
  if (!existsSync(ledger.path)) throw new Error('결정 원장 없음');
  return ledger.list({ status: 'open' }).map(d => {
    const openedAt = d.raisedAt ?? d.importedAt;
    if (!openedAt || !Number.isFinite(Date.parse(openedAt))) throw new Error(`결정 날짜 없음: ${d.id}`);
    return { name: d.title, openedAt };
  });
}

export const NEWS_QUERIES = ['에이전트 플랫폼', '코딩 에이전트', 'MCP', '로컬 LLM', '기업 AI 규제'] as const;
export async function collectNews(): Promise<News[]> {
  const script = join(repo, 'skills/omni-crawl/scripts/main.ts');
  const seen = new Set<string>();
  const found: News[] = [];
  const errors: string[] = [];
  for (const query of NEWS_QUERIES) {
    try {
      const output = command([script, query, '--engine', 'fc-news', '--time-range', 'day', '--limit', '5', '--no-save', '--json'], 60_000);
      const json = output.match(/---BEGIN_OMNI_CRAWL_JSON---\s*([\s\S]*?)\s*---END_OMNI_CRAWL_JSON---/)?.[1];
      if (!json) throw new Error('omni-crawl JSON 마커 없음');
      const data = record(JSON.parse(json));
      if (!Array.isArray(data.results)) throw new Error('omni-crawl 결과 형식 오류');
      for (const result of rows(data.results)) for (const item of rows(result.items)) {
        const url = string(item.url);
        if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
        if (adArticle(string(item.title), string(item.text))) continue;
        seen.add(url);
        found.push({ title: string(item.title) || string(item.text).slice(0, 100) || url, url,
          implication: `${query}: ${string(item.text).replace(/\s+/g, ' ').slice(0, 120) || '원문 확인 필요'}` });
      }
    } catch (error) { errors.push(`${query}: ${reasonOf(error)}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  if (found.length === 0) throw new Error('omni-crawl 5개 질의 모두 기사 없음');
  return found.slice(0, 5);
}

const labels: Record<keyof DailyParts, string> = {
  landings: '① 어제 착지', release: '② 판', loops: '③ 루프', grid: '④ 그리드', decisions: '⑤ 결정 대기', news: '⑦ 외부 동향',
};
const sortNames = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function composeDaily(parts: DailyParts, now: Date): DailyReview {
  const risks: Risk[] = [];
  if (parts.loops.status === 'ok') for (const loop of parts.loops.value) {
    if (loop.status === 'failing' || loop.status === 'late') risks.push({ name: loop.name, score: loop.status === 'failing' ? 3 : 1, reason: `${loop.status} 루프` });
  }
  if (parts.release.status === 'ok' && parts.release.value.cutAt && Date.parse(parts.release.value.cutAt) > now.getTime()) {
    for (const red of parts.release.value.red) risks.push({ name: red.name, score: 2, reason: '다음 컷까지 남은 red 칸' });
  }
  if (parts.decisions.status === 'ok') for (const d of parts.decisions.value) {
    const age = now.getTime() - Date.parse(d.openedAt);
    if (age > 3 * 86_400_000) risks.push({ name: d.name, score: 2, reason: '3일 넘은 결정 대기' });
  }
  if (parts.grid.status === 'ok') for (const seat of parts.grid.value) if (seat.idle) risks.push({ name: seat.name, score: 1, reason: '노는 자리' });
  risks.sort((a, b) => b.score - a.score || sortNames(a.name, b.name));
  const top = risks.slice(0, 5);
  const unread = <T>(section: Section<T>) => section.status === 'unreadable' ? `못 읽음 · ${shortReason(section.reason)}` : '';
  const seenPr = new Set<number>();
  const landings = parts.landings.status === 'ok' ? [...parts.landings.value]
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || sortNames(a.title, b.title))
    .filter(item => {
      if (item.prNumber === undefined) return true;
      if (seenPr.has(item.prNumber)) return false;
      seenPr.add(item.prNumber);
      return true;
    }) : [];
  const land = parts.landings.status === 'ok' ? `어제 착지 ${landings.length}건` : `어제 착지 ${unread(parts.landings)}`;
  const rel = parts.release.status === 'ok' ? `판 ${parts.release.value.version} ${parts.release.value.green}/${parts.release.value.total}` : `판 ${unread(parts.release)}`;
  const action = top.length ? `${top[0]!.name} (${top[0]!.reason}) 확인` : '못 읽은 절을 확인하고 오늘 첫 착지를 고른다';
  const header = [`S: ${land} · ${rel}`.slice(0, 200), `C: ${top[0] ? `${top[0].name} (${top[0].score}점 · ${top[0].reason})` : '확인된 위험 없음(못 읽은 절은 별도 확인)'}`, 'Q: 오늘 무엇을 먼저 할 것인가?', `A: ${action}`].join('\n');
  const section = <T>(key: keyof DailyParts, value: Section<T>, text: () => string) => `## ${labels[key]}\n${value.status === 'unreadable' ? unread(value) : text()}`;
  const runs = parts.landings.runSummaries ?? [];
  const landingText = (() => {
    if (parts.landings.status === 'unreadable') return `못 읽음 · ${shortReason(parts.landings.reason).slice(0, 200 - '못 읽음 · '.length)}`;
    const list = landings;
    const counts = [...new Set(list.map(i => i.seat))].sort(sortNames).map(seat => `${seat} ${list.filter(i => i.seat === seat).length}`).join(' · ');
    const byPr = new Map(runs.flatMap(run => run.prNumbers.map(number => [number, run.line] as const)));
    const shown = list.slice(0, 10);
    const listed = shown.map(i => i.prNumber !== undefined && byPr.has(i.prNumber) ? byPr.get(i.prNumber)! : `- ${i.title}`).join('\n') || '착지 없음';
    const omitted = list.length - shown.length;
    const withoutLanding = runs.filter(run => run.updatedYesterday && !list.some(i => i.prNumber !== undefined && run.prNumbers.includes(i.prNumber)));
    const shownRuns = withoutLanding.slice(0, 10);
    return `총 ${list.length}건 · 자리별 ${counts || '없음'}\n${listed}${omitted ? `\n외 ${omitted}건` : ''}${withoutLanding.length ? `\n하니스 런\n${shownRuns.map(run => run.line).join('\n')}${withoutLanding.length > 10 ? `\n외 ${withoutLanding.length - 10}개` : ''}` : ''}`;
  })();
  const markdown = [
    `# 데일리 리뷰 — ${kstDay(now)} (KST)`, header,
    `## ${labels.landings}\n${landingText}`,
    section('release', parts.release, () => { const r = (parts.release as { value: Release }).value;
      return `${r.version}: green ${r.green}/${r.total} · 다음 판 ${r.nextVersion ?? '미정'} ${r.nextGreen ?? '못 읽음'}/${r.nextTotal ?? '못 읽음'} · 다음 컷 ${r.cutAt ?? '미정'}`; }),
    section('loops', parts.loops, () => { const list = (parts.loops as { value: Loop[] }).value;
      return `alive ${list.filter(l => l.status === 'alive').length} · late ${list.filter(l => l.status === 'late').length} · failing ${list.filter(l => l.status === 'failing').length} · off ${list.filter(l => l.status === 'off').length} · unknown ${list.filter(l => l.status === 'unknown').length}\n${list.filter(l => l.status === 'failing' || l.status === 'late').map(l => `- ${l.name} (${l.status}${l.scope ? ` · ${l.scope}` : ''})`).join('\n') || '이상 없음'}`; }),
    section('grid', parts.grid, () => { const list = (parts.grid as { value: Seat[] }).value;
      return `${list.map(s => `${s.name} ${s.running}/${s.cap}`).join(' · ') || '자리 없음'}\n노는 자리: ${list.filter(s => s.idle).map(s => `${s.name}${s.nextCell ? ` → ${s.nextCell}` : ' (열린 칸 없음)'}`).join(', ') || '없음'}`; }),
    section('decisions', parts.decisions, () => { const list = (parts.decisions as { value: Pending[] }).value;
      return `${list.length}건\n${[...list].sort((a, b) => a.openedAt.localeCompare(b.openedAt) || sortNames(a.name, b.name)).slice(0, 3).map(d => `- ${d.name} (${d.openedAt})`).join('\n') || '대기 없음'}`; }),
    `## ⑥ 위험 톱 5\n${top.map((r, i) => `${i + 1}. ${r.name} — ${r.score}점 · ${r.reason}`).join('\n') || '확인된 위험 없음'}`,
    section('news', parts.news, () => (parts.news as { value: News[] }).value.slice(0, 5).map(n => `- ${n.title} — ${n.url}\n  시사점: ${n.implication}`).join('\n') || '수집된 기사 0건'),
  ].join('\n\n') + '\n';
  return { markdown, header, risks: top, sections: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.status])) as DailyReview['sections'] };
}

export type DailySendRequest = { channel: 'telegram'; chatId: number; botToken: string; kind: 'ops-report'; text: string };
export type DailySendConfirmation = { chatId: number; messageId: number };
type DeliveryReceipt = DailySendConfirmation | 'not-sent' | 'unknown';
type DeliveryResult = { sent: boolean; sendError: string | null; deliveryState: string; target: string; recordError?: string | null };

// The final transport checks Telegram's returned recipient and message, not sendOutbound's
// boolean (which can also mean "queued" or "accepted by daemon").
function sendTelegram(request: DailySendRequest): DailySendConfirmation | null {
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  const config = [
    `url = ${quote(`https://api.telegram.org/bot${request.botToken}/sendMessage`)}`,
    'request = "POST"',
    `data-urlencode = ${quote(`chat_id=${request.chatId}`)}`,
    `data-urlencode = ${quote(`text=${request.text}`)}`,
  ].join('\n') + '\n';
  const response = spawnSync('curl', ['-sS', '-m', '25', '--config', '-'],
    { input: config, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000 });
  if (response.error || response.status !== 0) return null;
  try {
    const body = record(JSON.parse(response.stdout));
    const message = record(body.result);
    const chat = record(message.chat);
    return body.ok === true && chat.id === request.chatId && Number.isSafeInteger(message.message_id) && (message.message_id as number) > 0
      ? { chatId: request.chatId, messageId: message.message_id as number } : null;
  } catch { return null; }
}

function recipient(deps: DailyDeps): { chatId: number; botToken: string } | null {
  const target = deps.target ?? (() => {
    const config = getUserConfig();
    return config.telegram.channels?.length ? kindRouteTarget(config, 'ops-report') : mainHomeTarget(config);
  })();
  return target && Number.isSafeInteger(target.chatId) && target.botToken.trim() ? target : null;
}

function sendReview(file: string, text: string, target: { chatId: number; botToken: string },
  send: (request: DailySendRequest) => DailySendConfirmation | null,
  receipt: (key: string) => DeliveryReceipt,
  recordDelivery?: (text: string, kind: 'ops-report') => void): DeliveryResult {
  const key = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const label = `telegram:${target.chatId}`;
  const db = new Database(join(dirname(file), 'delivery.sqlite'));
  try {
    db.run("CREATE TABLE IF NOT EXISTS deliveries (day TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','unknown','sent')), chat_id TEXT, message_id TEXT)");
    const cols = db.prepare('PRAGMA table_info(deliveries)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'chat_id')) db.run('ALTER TABLE deliveries ADD COLUMN chat_id TEXT');
    if (!cols.some(c => c.name === 'message_id')) db.run('ALTER TABLE deliveries ADD COLUMN message_id TEXT');
    db.run("INSERT OR IGNORE INTO deliveries(day, state) VALUES (?, 'pending')", [key]);
    const state = db.prepare('SELECT state, chat_id, message_id FROM deliveries WHERE day = ?').get(key) as { state: string; chat_id: string | null; message_id: string | null };
    if (state.state === 'sent') {
      if (state.chat_id === String(target.chatId) && state.message_id && Number(state.message_id) > 0)
        return { sent: false, sendError: null, deliveryState: 'already-sent', target: label };
      return { sent: false, sendError: '수신자 확인 불가 · 기존 발송 기록 확인 필요', deliveryState: 'unknown', target: 'unknown' };
    }
    if (state.state === 'unknown') {
      const verdict = receipt(key);
      if (typeof verdict === 'object' && verdict.chatId === target.chatId && Number.isSafeInteger(verdict.messageId) && verdict.messageId > 0) {
        db.run("UPDATE deliveries SET state = 'sent', chat_id = ?, message_id = ? WHERE day = ?", [String(target.chatId), String(verdict.messageId), key]);
        return { sent: false, sendError: null, deliveryState: 'receipt-sent', target: label };
      }
      if (verdict !== 'not-sent') return { sent: false, sendError: `발송 결과 불명 · RHYTHM-DAILY:${key} 영수증 확인 필요`, deliveryState: 'unknown', target: 'unknown' };
      db.run("UPDATE deliveries SET state = 'pending' WHERE day = ? AND state = 'unknown'", [key]);
    }
    if (!db.prepare("UPDATE deliveries SET state = 'unknown' WHERE day = ? AND state = 'pending'").run(key).changes)
      return { sent: false, sendError: `발송 결과 불명 · RHYTHM-DAILY:${key} 영수증 확인 필요`, deliveryState: 'unknown', target: 'unknown' };
    try {
      const request: DailySendRequest = { channel: 'telegram', chatId: target.chatId, botToken: target.botToken,
        kind: 'ops-report', text: `${text}\nRHYTHM-DAILY:${key}` };
      const confirmation = send(request);
      if (!confirmation || confirmation.chatId !== target.chatId || !Number.isSafeInteger(confirmation.messageId) || confirmation.messageId <= 0)
        return { sent: false, sendError: '발송 결과 불명 · 수신자/메시지 영수증 확인 필요', deliveryState: 'unknown', target: 'unknown' };
      db.run("UPDATE deliveries SET state = 'sent', chat_id = ?, message_id = ? WHERE day = ?", [String(confirmation.chatId), String(confirmation.messageId), key]);
      let recordError: string | null = null;
      try {
        if (recordDelivery) recordDelivery(request.text, request.kind);
        else if (send === sendTelegram && process.env.NODE_ENV !== 'test') recordOutbound(request.text, request.kind);
      } catch (error) { recordError = `보조 기록 실패 · ${shortReason(reasonOf(error))}`; }
      return { sent: true, sendError: null, deliveryState: 'sent', target: label, recordError };
    } catch (error) { return { sent: false, sendError: `발송 결과 불명 · ${shortReason(reasonOf(error))}`, deliveryState: 'unknown', target: 'unknown' }; }
  } catch (error) { return { sent: false, sendError: `발송 상태 못 읽음 · ${shortReason(reasonOf(error))}`, deliveryState: 'unknown', target: 'unknown' }; }
  finally { db.close(); }
}

export type DailyDeps = { now?: () => Date; root?: string; vaultRoot?: string | null; sendEnabled?: boolean; repoRoot?: string; repoName?: string;
  landings?: (now: Date) => Promise<Landing[]>; release?: () => Promise<Release>; loops?: () => Promise<Loop[]>;
  grid?: () => Promise<Seat[]>; decisions?: () => Promise<Pending[]>; news?: () => Promise<News[]>;
  target?: { chatId: number; botToken: string };
  send?: (request: DailySendRequest) => DailySendConfirmation | null; receipt?: (key: string) => DeliveryReceipt;
  recordDelivery?: (text: string, kind: 'ops-report') => void;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  proactSignals?: () => Promise<ProactSignals>;
  proactPreviouslySuggested?: ReadonlySet<string>;
  print?: (line: string) => void };

// 볼트 사본은 필수 산출물이다 — 쓰기 실패·설정 못 읽음은 vaultFatal 로 올려 그래프가 done 으로 가지 않게 한다.
// 볼트 미설정·격리 인스턴스의 외부 볼트 건너뜀은 «의도»라 fatal 이 아니다.
function copyToVault(markdown: string, now: Date, deps: DailyDeps): { vaultError: string | null; vaultFatal: boolean } {
  let vaultRoot: string | null | undefined = deps.vaultRoot;
  if (vaultRoot === undefined) try {
    const config = getUserConfig();
    const obsidian = record(config.raw.obsidian);
    vaultRoot = string(obsidian.vault) || string(obsidian.vaultRoot) || config.obsidian.vault || null;
    if (vaultRoot && effectiveInstanceRoot() !== prodInstanceRoot() && !vaultRoot.startsWith(`${effectiveInstanceRoot()}/`)) return { vaultError: '격리 인스턴스 — 운영 볼트 사본 건너뜀', vaultFatal: false };
  } catch (e) { return { vaultError: reasonOf(e), vaultFatal: true }; }
  if (!vaultRoot) return { vaultError: null, vaultFatal: false };
  try {
    const copy = join(vaultRoot, '00. Inbox', 'Daily Review', `${kstDay(now)}.md`);
    mkdirSync(dirname(copy), { recursive: true }); writeFileSync(copy, markdown);
    return { vaultError: null, vaultFatal: false };
  } catch (e) { return { vaultError: reasonOf(e), vaultFatal: true }; }
}

export async function runDaily(options: { dryRun?: boolean; noNews?: boolean; stage?: 'collect' | 'compose' | 'deliver' } = {}, deps: DailyDeps = {}) {
  const now = (deps.now ?? (() => new Date()))();
  const receiptKey = `RHYTHM-DAILY:${kstDay(now)}`;
  if (options.stage === 'compose' || options.stage === 'deliver') {
    const file = join(deps.root ?? effectiveInstanceRoot(), 'rhythm', 'daily', `${kstDay(now)}.md`);
    if (!existsSync(file)) throw new Error(`수집 파일 없음: ${file}`);
    const markdown = readFileSync(file, 'utf8');
    const suggestionBlock = markdown.split('## PROACT1-LITE 제안\n')[1]?.split('\n\n## ')[0]?.trim() ?? '';
    const header = markdown.split('\n').slice(2, 6).join('\n');
    if (!header.startsWith('S: ') || !markdown.includes('## ⑥ 위험 톱 5')) throw new Error(`리뷰 파일 형식 오류: ${file}`);
    const riskBlock = markdown.split('## ⑥ 위험 톱 5\n')[1]!.split('\n\n## ')[0]!;
    const risks = riskBlock.split('\n').filter(line => /^\d+\. /.test(line)).map(line => {
      const match = /^\d+\. (.+) — (\d+)점 · (.+)$/.exec(line);
      if (!match) throw new Error(`위험 목록 형식 오류: ${file}`);
      return { name: match[1]!, score: Number(match[2]), reason: match[3]! };
    });
    const sections = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key,
      markdown.split(`## ${label}\n`)[1]?.split('\n\n## ')[0]?.startsWith('못 읽음 ·') ? 'unreadable' : 'ok'])) as DailyReview['sections'];
    sections.news = markdown.split('## ⑦ 외부 동향\n')[1]?.startsWith('못 읽음 ·') ? 'unreadable' : 'ok';
    const tick: Record<string, unknown> = { sections, risks: risks.length, sent: false };
    const vault = options.stage === 'compose' && !options.dryRun ? copyToVault(markdown, now, deps) : { vaultError: null, vaultFatal: false };
    let sent = false;
    let deliveryState = options.stage === 'compose' ? 'pending' : options.dryRun ? 'dry-run' : 'send-disabled';
    let chars = 0;
    let target = 'unknown';
    let sendError: string | null = null;
    let recordError: string | null = null;
    let enabled = deps.sendEnabled === true;
    if (deps.sendEnabled === undefined && options.stage === 'deliver' && !options.dryRun) {
      try { enabled = record(record(record(getUserConfig().raw.loops).rhythm).daily).send === true; }
      catch (error) { sendError = `발송 설정 못 읽음 · ${shortReason(reasonOf(error))}`; deliveryState = 'unknown'; }
    }
    if (options.stage === 'deliver' && !options.dryRun && enabled) {
      const text = `${header}\n\n## 위험 톱 5\n${riskBlock}${suggestionBlock ? `\n\n## PROACT1-LITE 제안\n${suggestionBlock}` : ''}\n\n${file}`;
      chars = `${text}\n${receiptKey}`.length;
      let resolved: ReturnType<typeof recipient> = null;
      try { resolved = recipient(deps); }
      catch (error) { sendError = `수신자 설정 못 읽음 · ${shortReason(reasonOf(error))}`; }
      const delivery = resolved ? sendReview(file, text, resolved, deps.send ?? sendTelegram, deps.receipt ?? (() => 'unknown'), deps.recordDelivery)
        : { sent: false, sendError: '수신자 미설정', deliveryState: 'no-recipient', target: 'unknown' };
      target = delivery.target;
      sent = delivery.sent;
      sendError = sendError ?? delivery.sendError;
      recordError = delivery.recordError ?? null;
      deliveryState = delivery.deliveryState;
    }
    tick.sent = sent;
    const status = vault.vaultFatal || Object.values(sections).includes('unreadable') ? 'degraded'
      : deliveryState === 'pending' ? 'pending'
      : ['sent', 'already-sent', 'receipt-sent'].includes(deliveryState) ? 'ok' : 'degraded';
    const deliveryLine = `${options.stage} ${status} · target=${target} · ${deliveryState} · sent=${sent} · chars=${chars} · receipt=${receiptKey}${recordError ? ` · ${recordError}` : ''}`;
    if (options.stage === 'deliver') {
      Object.assign(tick, { status, deliveryState, target, chars, receiptKey, deliveryLine, recordError });
      if (!options.dryRun) {
        if (deps.log) deps.log('loop.rhythm-daily', 'tick', tick);
        else loopEvent('rhythm-daily', 'tick', tick);
      }
    }
    return { file, markdown, header, risks, sections, sent, ...vault, sendError, recordError, status, deliveryState, deliveryLine };
  }
  const safe = async <T>(fetch: () => Promise<T>): Promise<Section<T>> => {
    try { return { status: 'ok', value: await fetch() }; } catch (e) { return unreadable(reasonOf(e)); }
  };
  const landings = await safe(() => deps.landings ? deps.landings(now) : collectLandings(now, undefined, { repoRoot: deps.repoRoot, repoName: deps.repoName, stateRoot: deps.root }));
  const parts: DailyParts = {
    landings: { ...landings, runSummaries: collectRunSummaries(now, deps.root ?? effectiveInstanceRoot(),
      landings.status === 'ok' ? landings.value.flatMap(item => item.prNumber === undefined ? [] : [item.prNumber]) : []) },
    release: await safe(deps.release ?? collectRelease),
    loops: await safe(deps.loops ?? collectLoops),
    grid: await safe(deps.grid ?? collectGrid),
    decisions: await safe(deps.decisions ?? collectDecisions),
    news: options.noNews ? unreadable('건너뜀 (--no-news)') : await safe(async () => cleanNews(await (deps.news ?? collectNews)())),
  };
  const review = composeDaily(parts, now);
  const root = deps.root ?? effectiveInstanceRoot();
  const observed = await safe(async (): Promise<ProactSignals> => {
    if (deps.proactSignals) return deps.proactSignals();
    const signals: { -readonly [K in keyof ProactSignals]: ProactSignals[K] } = {};
    try {
      const schedules = listSchedules(root);
      const yellow = schedules.flatMap(schedule => {
        try { return listChecklist(schedule.version, root).items.filter(item => item.status === 'yellow')
          .map(item => ({ version: schedule.version, item })); }
        catch { return []; }
      });
      signals.schedules = schedules;
      signals.yellow = yellow;
    } catch { /* source unreadable */ }
    try { signals.decisions = new DecisionLedger({ stateDir: root }).list({ status: 'open' }); } catch { /* source unreadable */ }
    try {
      const remote = deps.repoName ?? (deps.root ? undefined : (() => {
        const tree = deps.repoRoot ?? getUserConfig().ops?.cronRepoRoot ?? repo;
        const result = spawnSync('git', ['-C', tree, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5_000 });
        return result.status === 0 ? /(?:github\.com[:/])([^/\s]+\/[^/\s]+)\s*$/.exec(result.stdout)?.[1]?.replace(/\.git$/, '') : undefined;
      })());
      if (remote) {
        const inventory = cli('gh', 'pr', 'list', '--repo', remote, '--state', 'open', '--limit', '500', '--json', 'number,title,isDraft');
        if (Array.isArray(inventory) && inventory.length < 500) {
          const drafts = rows(inventory).filter(pr => pr.isDraft === true && typeof pr.number === 'number' && typeof pr.title === 'string')
            .map(pr => ({ number: pr.number as number, title: pr.title as string }));
          // draft 정리 판정은 열린 draft 전수에 GitHub 호출을 돌려 10-05 운영에서 600초 넘게 끝나지 않았다(크론 수집 노드가 멎는다).
          // 그래서 기본은 끈다 — loops.rhythm.daily.draftSweep=true 일 때만 돈다. 오래된 draft 정리는 DRAFT-TRIAGE 몫.
          let sweepEnabled = false;
          try { sweepEnabled = record(record(record(getUserConfig().raw.loops).rhythm).daily).draftSweep === true; } catch { /* config unreadable → off */ }
          if (!sweepEnabled) loopEvent('rhythm-daily', 'draft-sweep-skipped', { drafts: drafts.length, reason: 'disabled-by-default' });
          if (drafts.length && sweepEnabled) {
            const sweep = await runDraftSweep({ repository: remote, apply: false, now, adapters: githubDraftSweepAdapters() });
            signals.draftAssessment = { drafts, sweep };
          }
        }
      }
    } catch { /* source unreadable */ }
    return signals;
  });
  const signals: ProactSignals = observed.status === 'ok' ? observed.value : {};
  const previousFile = join(root, 'rhythm', 'daily', `${kstDay(now)}.md`);
  const retained = existsSync(previousFile) ? readFileSync(previousFile, 'utf8').split('## PROACT1-LITE 제안\n')[1]?.split('\n\n## ')[0]?.trim() ?? '' : '';
  const previouslySuggested = new Set(deps.proactPreviouslySuggested ?? []);
  // 같은 제안은 하루 한 번이 아니라 «지난 7일 안에 한 번»: 오늘 ⊕ 앞선 6일 리뷰 파일의 제안 표지를 모두 읽는다.
  const history = [retained];
  for (let back = 1; back < 7; back++) {
    const file = join(root, 'rhythm', 'daily', `${kstDay(new Date(now.getTime() - back * 86_400_000))}.md`);
    if (!existsSync(file)) continue;
    try { history.push(readFileSync(file, 'utf8').split('## PROACT1-LITE 제안\n')[1]?.split('\n\n## ')[0] ?? ''); } catch { /* unreadable day is skipped, not treated as empty history */ }
  }
  for (const line of history.join('\n').split('\n')) {
    const key = /^- .* \[proact:([^\]]+)\]$/.exec(line)?.[1];
    if (key) previouslySuggested.add(key);
  }
  const suggestions = selectProact1Lite({ ...signals,
    ...(parts.loops.status === 'ok' ? { loops: parts.loops.value.map(loop => ({ name: loop.name, state: loop.status, scope: loop.scope })) } : {}),
  }, { now, previouslySuggested });
  const newSuggestions = suggestions.slice(0, Math.max(0, 3 - retained.split('\n').filter(line => line.startsWith('- ')).length))
    .map(suggestion => `- ${suggestion.title} — ${suggestion.reason} (${suggestion.source}) [proact:${suggestion.key}]`).join('\n');
  const recorded = [retained, newSuggestions].filter(Boolean).join('\n');
  if (recorded) review.markdown += `\n## PROACT1-LITE 제안\n${recorded}\n`;
  const file = join(deps.root ?? effectiveInstanceRoot(), 'rhythm', 'daily', `${kstDay(now)}.md`);
  if (!options.dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, review.markdown);
  }
  const { vaultError, vaultFatal } = options.dryRun ? { vaultError: null, vaultFatal: false } : copyToVault(review.markdown, now, deps);
  let enabled = deps.sendEnabled === true;
  let sendError: string | null = null;
  let deliveryState = options.stage === 'collect' ? 'pending' : options.dryRun ? 'dry-run' : 'send-disabled';
  if (deps.sendEnabled === undefined && !options.dryRun && options.stage !== 'collect') {
    try { enabled = record(record(record(getUserConfig().raw.loops).rhythm).daily).send === true; }
    catch (error) { sendError = `발송 설정 못 읽음 · ${shortReason(reasonOf(error))}`; deliveryState = 'unknown'; }
  }
  let sent = false;
  let recordError: string | null = null;
  let chars = 0;
  let target = 'unknown';
  if (!options.dryRun && options.stage !== 'collect' && enabled) {
    const text = `${review.header}\n\n## 위험 톱 5\n${review.risks.map((r, i) => `${i + 1}. ${r.name} — ${r.score}점 · ${r.reason}`).join('\n') || '확인된 위험 없음'}${recorded ? `\n\n## PROACT1-LITE 제안\n${recorded}` : ''}\n\n${file}`;
    chars = `${text}\n${receiptKey}`.length;
    let resolved: ReturnType<typeof recipient> = null;
    try { resolved = recipient(deps); }
    catch (error) { sendError = `수신자 설정 못 읽음 · ${shortReason(reasonOf(error))}`; }
    const delivery = resolved ? sendReview(file, text, resolved, deps.send ?? sendTelegram, deps.receipt ?? (() => 'unknown'), deps.recordDelivery)
      : { sent: false, sendError: '수신자 미설정', deliveryState: 'no-recipient', target: 'unknown' };
    target = delivery.target;
    sent = delivery.sent;
    sendError = sendError ?? delivery.sendError;
    recordError = delivery.recordError ?? null;
    deliveryState = delivery.deliveryState;
  }
  const status = vaultFatal || Object.values(review.sections).includes('unreadable') ? 'degraded'
    : deliveryState === 'pending' ? 'pending'
    : ['sent', 'already-sent', 'receipt-sent'].includes(deliveryState) ? 'ok' : 'degraded';
  const deliveryLine = `${options.stage === 'collect' ? 'collect' : 'deliver'} ${status} · target=${target} · ${deliveryState} · sent=${sent} · chars=${chars} · receipt=${receiptKey}${recordError ? ` · ${recordError}` : ''}`;
  if (options.stage !== 'collect') {
    const tick = { sections: review.sections, risks: review.risks.length, sent, status, deliveryState, target, chars, receiptKey, deliveryLine, recordError };
    if (!options.dryRun) {
      if (deps.log) deps.log('loop.rhythm-daily', 'tick', tick);
      else loopEvent('rhythm-daily', 'tick', tick);
    }
  }
  return { file, ...review, sent, vaultError, vaultFatal, sendError, recordError, status, deliveryState, deliveryLine };
}

export async function main(args: string[] = process.argv.slice(2), deps: DailyDeps = {}): Promise<Awaited<ReturnType<typeof runDaily>>> {
  const stage = process.env.ELANOUS_GRAPH_DIR && ['collect', 'compose', 'deliver'].includes(args[0] ?? '') ? args.shift() as 'collect' | 'compose' | 'deliver' : undefined;
  for (const arg of args) if (!['--dry-run', '--no-news', '--json'].includes(arg)) throw new Error(`알 수 없는 옵션: ${arg}`);
  const result = await runDaily({ dryRun: args.includes('--dry-run'), noNews: args.includes('--no-news'), stage }, deps);
  (deps.print ?? console.log)(args.includes('--json') ? JSON.stringify(result) : `${result.markdown}\n파일: ${result.file} · ${result.deliveryLine}`);
  // 발송 설정 OFF 는 degraded 로 기록하고 done 으로 진행한다. 실제 발송 실패·볼트 사본 실패는 그래프를 멈춘다.
  if ((stage === 'compose' || !stage) && result.vaultFatal) throw new Error(`볼트 사본 실패 · ${result.vaultError}`);
  if (stage === 'deliver' && result.sendError) throw new Error(`발송 실패 · ${result.sendError}`);
  return result;
}

if (import.meta.main) main().catch(error => { console.error(`rhythm-daily: ${reasonOf(error)}`); process.exitCode = 1; });
