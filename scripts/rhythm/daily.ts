#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { listSchedules } from '../../src/release-loop/release-schedule.js';
import { devVersion, listChecklist } from '../../src/release-loop/checklist.js';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';
import { trafficTick, seatOfTree } from '../../src/loops/orchestrator/traffic.js';
import { defaultListHarnessProcesses } from '../../src/harness/harness-cli-command.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS } from '../../src/user-config.js';
import { loopEvent } from '../../src/loops/observe.js';
import { sendOutbound } from '../../src/domains/outbound-alert.js';
import { listSelfDevRuns, runSummaryLine, selfDevRunsDir } from '../../src/self-dev/run-store.js';

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
const unreadable = <T>(reason: string): Section<T> => ({ status: 'unreadable', reason });
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
export async function collectLandings(now: Date, window?: { from: Date; to: Date }): Promise<Landing[]> {
  const yesterday = kstDay(new Date(now.getTime() - 86_400_000));
  const from = window?.from ?? new Date(`${yesterday}T00:00:00+09:00`);
  const to = window?.to ?? new Date(from.getTime() + 86_400_000);
  // GitHub's merged: date search is UTC; include the UTC date containing KST midnight, then filter precisely below.
  const searchDay = window ? from.toISOString().slice(0, 10) : yesterday;
  const data = cli('gh', 'pr', 'list', '--state', 'merged', '--search', `merged:>=${searchDay}`, '--limit', '500', '--json', 'number,title,mergedAt');
  if (!Array.isArray(data)) throw new Error('병합 목록 형식 오류');
  // 주간 창은 잘린 목록을 정확한 합계로 취급할 수 없다. 데일리 기본 경로는 그대로 둔다.
  if (window && data.length >= 500) throw new Error('병합 목록 500건 조회 상한 도달 · 주간 착지 집계 불완전');
  return rows(data).filter(r => typeof r.title === 'string' && typeof r.mergedAt === 'string' && Number.isFinite(Date.parse(r.mergedAt as string)) && Date.parse(r.mergedAt as string) >= from.getTime() && Date.parse(r.mergedAt as string) < to.getTime())
    .map(r => ({ title: string(r.title), mergedAt: string(r.mergedAt), seat: /^\[(OP|TC|MK|UX)\]/.exec(string(r.title))?.[1] ?? '미분류',
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
  const unread = <T>(section: Section<T>) => section.status === 'unreadable' ? `못 읽음 · ${section.reason}` : '';
  const land = parts.landings.status === 'ok' ? `어제 착지 ${parts.landings.value.length}건` : `어제 착지 ${unread(parts.landings)}`;
  const rel = parts.release.status === 'ok' ? `판 ${parts.release.value.version} ${parts.release.value.green}/${parts.release.value.total}` : `판 ${unread(parts.release)}`;
  const action = top.length ? `${top[0]!.name} (${top[0]!.reason}) 확인` : '못 읽은 절을 확인하고 오늘 첫 착지를 고른다';
  const header = [`S: ${land} · ${rel}`, `C: ${top[0] ? `${top[0].name} (${top[0].score}점 · ${top[0].reason})` : '확인된 위험 없음(못 읽은 절은 별도 확인)'}`, 'Q: 오늘 무엇을 먼저 할 것인가?', `A: ${action}`].join('\n');
  const section = <T>(key: keyof DailyParts, value: Section<T>, text: () => string) => `## ${labels[key]}\n${value.status === 'unreadable' ? unread(value) : text()}`;
  const runs = parts.landings.runSummaries ?? [];
  const landingText = (() => {
    if (parts.landings.status === 'unreadable') {
      const yesterdayRuns = runs.filter(run => run.updatedYesterday);
      return `${unread(parts.landings)}${yesterdayRuns.length ? `\n하니스 런\n${yesterdayRuns.map(run => run.line).join('\n')}` : ''}`;
    }
    const list = parts.landings.value;
    const counts = [...new Set(list.map(i => i.seat))].sort(sortNames).map(seat => `${seat} ${list.filter(i => i.seat === seat).length}`).join(' · ');
    const byPr = new Map(runs.flatMap(run => run.prNumbers.map(number => [number, run.line] as const)));
    const shown = list.slice(0, 5);
    const listed = shown.map(i => i.prNumber !== undefined && byPr.has(i.prNumber) ? byPr.get(i.prNumber)! : `- ${i.title}`).join('\n') || '착지 없음';
    const withoutLanding = runs.filter(run => run.updatedYesterday && !shown.some(i => i.prNumber !== undefined && run.prNumbers.includes(i.prNumber)));
    return `총 ${list.length}건 · 자리별 ${counts || '없음'}\n${listed}${withoutLanding.length ? `\n하니스 런\n${withoutLanding.map(run => run.line).join('\n')}` : ''}`;
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

type DeliveryReceipt = 'sent' | 'not-sent' | 'unknown';

/** An outbound success is the only evidence for 'sent'. The sender has no durable
 * idempotency API; an interrupted attempt is never silently treated as success
 * or automatically retried without an authoritative negative receipt. */
function outboundReceipt(file: string, key: string): DeliveryReceipt {
  const root = dirname(dirname(dirname(file)));
  const path = join(root, ...(root === prodInstanceRoot() ? ['memory'] : []), 'surface_events.db');
  if (!existsSync(path)) return 'unknown';
  try {
    const db = new Database(path, { readonly: true, create: false });
    try {
      const row = db.prepare("SELECT 1 FROM events WHERE direction='outbound' AND kind='ops-report' AND instr(text, ?) > 0 LIMIT 1").get(`RHYTHM-DAILY:${key}`);
      return row ? 'sent' : 'unknown'; // Absence in a fail-soft memory store is NOT a negative receipt.
    } finally { db.close(); }
  } catch { return 'unknown'; }
}

function sendReview(file: string, text: string, send: (text: string, kind: string) => boolean,
  receipt: (key: string) => DeliveryReceipt = key => outboundReceipt(file, key)): { sent: boolean; sendError: string | null } {
  const key = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, ''); // KST date, not changing content
  const db = new Database(join(dirname(file), 'delivery.sqlite'));
  try {
    db.run("CREATE TABLE IF NOT EXISTS deliveries (day TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','unknown','sent')))");
    db.run("INSERT OR IGNORE INTO deliveries(day, state) VALUES (?, 'pending')", [key]);
    const state = (db.prepare('SELECT state FROM deliveries WHERE day = ?').get(key) as { state: string }).state;
    if (state === 'sent') return { sent: false, sendError: null };
    if (state === 'unknown') {
      const verdict = receipt(key);
      if (verdict === 'sent') {
        db.run("UPDATE deliveries SET state = 'sent' WHERE day = ?", [key]);
        return { sent: false, sendError: null };
      }
      if (verdict !== 'not-sent') return { sent: false, sendError: `발송 결과 불명 · RHYTHM-DAILY:${key} 영수증 확인 필요` };
      db.run("UPDATE deliveries SET state = 'pending' WHERE day = ? AND state = 'unknown'", [key]);
    }
    // Atomic claim across concurrent runs. A process dying before this write made no send.
    if (!db.prepare("UPDATE deliveries SET state = 'unknown' WHERE day = ? AND state = 'pending'").run(key).changes)
      return { sent: false, sendError: `발송 결과 불명 · RHYTHM-DAILY:${key} 영수증 확인 필요` };
    try {
      if (!send(`${text}\nRHYTHM-DAILY:${key}`, 'ops-report')) return { sent: false, sendError: '발송 실패 · 결과 불명 (영수증 확인 필요)' };
      db.run("UPDATE deliveries SET state = 'sent' WHERE day = ?", [key]);
      return { sent: true, sendError: null };
    } catch (error) { return { sent: false, sendError: `발송 결과 불명 · ${reasonOf(error)}` }; }
  } catch (error) { return { sent: false, sendError: `발송 상태 못 읽음 · ${reasonOf(error)}` }; }
  finally { db.close(); }
}

export type DailyDeps = { now?: () => Date; root?: string; vaultRoot?: string | null; sendEnabled?: boolean;
  landings?: (now: Date) => Promise<Landing[]>; release?: () => Promise<Release>; loops?: () => Promise<Loop[]>;
  grid?: () => Promise<Seat[]>; decisions?: () => Promise<Pending[]>; news?: () => Promise<News[]>;
  send?: (text: string, kind: string) => boolean; receipt?: (key: string) => DeliveryReceipt;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  print?: (line: string) => void };

// 볼트 사본은 필수 산출물이다 — 쓰기 실패·설정 못 읽음은 vaultFatal 로 올려 그래프가 done 으로 가지 않게 한다.
// 볼트 미설정·격리 인스턴스 건너뜀은 «의도»라 fatal 이 아니다.
function copyToVault(markdown: string, now: Date, deps: DailyDeps): { vaultError: string | null; vaultFatal: boolean } {
  let vaultRoot: string | null | undefined = deps.vaultRoot;
  if (vaultRoot === undefined) try {
    vaultRoot = string(record(getUserConfig().raw.obsidian).vaultRoot) || null;
    if (vaultRoot && effectiveInstanceRoot() !== prodInstanceRoot()) return { vaultError: '격리 인스턴스 — 운영 볼트 사본 건너뜀', vaultFatal: false };
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
  if (options.stage === 'compose' || options.stage === 'deliver') {
    const file = join(deps.root ?? effectiveInstanceRoot(), 'rhythm', 'daily', `${kstDay(now)}.md`);
    if (!existsSync(file)) throw new Error(`수집 파일 없음: ${file}`);
    const markdown = readFileSync(file, 'utf8');
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
    const tick = { sections, risks: risks.length, sent: false };
    const vault = options.stage === 'compose' && !options.dryRun ? copyToVault(markdown, now, deps) : { vaultError: null, vaultFatal: false };
    let sent = false;
    let sendError: string | null = null;
    let enabled = deps.sendEnabled === true;
    if (deps.sendEnabled === undefined && options.stage === 'deliver' && !options.dryRun) {
      try { enabled = record(record(record(getUserConfig().raw.loops).rhythm).daily).send === true; }
      catch (error) { sendError = `발송 설정 못 읽음 · ${reasonOf(error)}`; }
    }
    if (options.stage === 'deliver' && !options.dryRun && enabled) {
      const delivery = sendReview(file, `${header}\n\n## 위험 톱 5\n${riskBlock}\n\n${file}`, deps.send ?? sendOutbound, deps.receipt);
      sent = delivery.sent;
      sendError = delivery.sendError;
    }
    tick.sent = sent;
    if (options.stage === 'deliver') {
      if (deps.log) deps.log('loop.rhythm-daily', 'tick', tick);
      else loopEvent('rhythm-daily', 'tick', tick);
    }
    return { file, markdown, header, risks, sections, sent, ...vault, sendError };
  }
  const safe = async <T>(fetch: () => Promise<T>): Promise<Section<T>> => {
    try { return { status: 'ok', value: await fetch() }; } catch (e) { return unreadable(reasonOf(e)); }
  };
  const landings = await safe(() => (deps.landings ?? collectLandings)(now));
  const parts: DailyParts = {
    landings: { ...landings, runSummaries: collectRunSummaries(now, deps.root ?? effectiveInstanceRoot(),
      landings.status === 'ok' ? landings.value.flatMap(item => item.prNumber === undefined ? [] : [item.prNumber]) : []) },
    release: await safe(deps.release ?? collectRelease),
    loops: await safe(deps.loops ?? collectLoops),
    grid: await safe(deps.grid ?? collectGrid),
    decisions: await safe(deps.decisions ?? collectDecisions),
    news: options.noNews ? unreadable('건너뜀 (--no-news)') : await safe(deps.news ?? collectNews),
  };
  const review = composeDaily(parts, now);
  const file = join(deps.root ?? effectiveInstanceRoot(), 'rhythm', 'daily', `${kstDay(now)}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, review.markdown);
  const { vaultError, vaultFatal } = copyToVault(review.markdown, now, deps);
  let enabled = deps.sendEnabled === true;
  let sendError: string | null = null;
  if (deps.sendEnabled === undefined && !options.dryRun && options.stage !== 'collect') {
    try { enabled = record(record(record(getUserConfig().raw.loops).rhythm).daily).send === true; }
    catch (error) { sendError = `발송 설정 못 읽음 · ${reasonOf(error)}`; }
  }
  let sent = false;
  if (!options.dryRun && options.stage !== 'collect' && enabled) {
    const delivery = sendReview(file, `${review.header}\n\n## 위험 톱 5\n${review.risks.map((r, i) => `${i + 1}. ${r.name} — ${r.score}점 · ${r.reason}`).join('\n') || '확인된 위험 없음'}\n\n${file}`, deps.send ?? sendOutbound, deps.receipt);
    sent = delivery.sent;
    sendError = delivery.sendError;
  }
  if (options.stage !== 'collect') {
    const tick = { sections: review.sections, risks: review.risks.length, sent };
    if (deps.log) deps.log('loop.rhythm-daily', 'tick', tick);
    else loopEvent('rhythm-daily', 'tick', tick);
  }
  return { file, ...review, sent, vaultError, vaultFatal, sendError };
}

export async function main(args: string[] = process.argv.slice(2), deps: DailyDeps = {}): Promise<Awaited<ReturnType<typeof runDaily>>> {
  const stage = process.env.ELANOUS_GRAPH_DIR && ['collect', 'compose', 'deliver'].includes(args[0] ?? '') ? args.shift() as 'collect' | 'compose' | 'deliver' : undefined;
  for (const arg of args) if (!['--dry-run', '--no-news', '--json'].includes(arg)) throw new Error(`알 수 없는 옵션: ${arg}`);
  const result = await runDaily({ dryRun: args.includes('--dry-run'), noNews: args.includes('--no-news'), stage }, deps);
  (deps.print ?? console.log)(args.includes('--json') ? JSON.stringify(result) : `${result.markdown}\n파일: ${result.file} · sent=${result.sent}`);
  // 그래프 노드는 종료 코드로만 갈린다 — 미발송·볼트 사본 실패를 성공으로 내보내면 그래프가 done 으로 간다.
  if (stage === 'compose' && result.vaultFatal) throw new Error(`볼트 사본 실패 · ${result.vaultError}`);
  if (stage === 'deliver' && result.sendError) throw new Error(`발송 실패 · ${result.sendError}`);
  return result;
}

if (import.meta.main) main().catch(error => { console.error(`rhythm-daily: ${reasonOf(error)}`); process.exitCode = 1; });
