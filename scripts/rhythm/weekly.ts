#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { getUserConfig } from '../../src/user-config.js';
import { loopEvent } from '../../src/loops/observe.js';
import { sendOutbound } from '../../src/domains/outbound-alert.js';
import { collectLandings, collectRelease, collectDecisions, type Landing, type Release, type Pending, type Section } from './daily.js';

type Issue = { id: string; title: string; owner: string; due: string; status: 'open' | 'done'; at: string; by: string };
type WeeklyParts = { landings: Section<Landing[]>; release: Section<Release>; issues: Section<Issue[]>;
  followThrough: Section<{ issue: Issue; outcome: 'done' | '기한 뒤 완료' | '기한 넘김' | '진행'; doneAt?: string }[]>;
  decisions: Section<Pending[]>; news: Section<{ title: string; url: string }[]> };
export type WeeklyDeps = { now?: () => Date; root?: string; vaultRoot?: string | null; sendEnabled?: boolean;
  landings?: (now: Date, window: { from: Date; to: Date }) => Promise<Landing[]>; release?: () => Promise<Release>;
  decisions?: () => Promise<Pending[]>; send?: (text: string, kind: string) => boolean;
  receipt?: (key: string) => 'sent' | 'not-sent' | 'unknown';
  log?: (category: string, event: string, data: Record<string, unknown>) => void; print?: (line: string) => void };
const reasonOf = (e: unknown) => e instanceof Error ? e.message : String(e);
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const sortNames = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const kstDate = (date: Date) => new Date(date.getTime() + KST).toISOString().slice(0, 10);
function weekOf(now: Date) {
  const local = new Date(now.getTime() + KST);
  const day = local.getUTCDay();
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - ((day + 6) % 7));
  const current = new Date(monday - KST);
  const from = new Date(current.getTime() - 7 * DAY);
  const to = current;
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstMonday = firstThursday - ((new Date(firstThursday).getUTCDay() + 6) % 7) * DAY;
  const week = Math.floor((monday - firstMonday) / (7 * DAY)) + 1;
  return { from, to, key: `${year}-W${String(week).padStart(2, '0')}` };
}
const issuePath = (root: string) => join(root, 'rhythm', 'weekly', 'issues.jsonl');
function issueHistory(root: string): Issue[] {
  const file = issuePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(line)); } catch { throw new Error(`현안 원장 ${index + 1}줄 JSON 오류`); }
    if (!['id', 'title', 'owner', 'due', 'at', 'by'].every(k => typeof row[k] === 'string' && row[k]) || !['open', 'done'].includes(String(row.status)) ||
        !Number.isFinite(Date.parse(String(row.at))) || !Number.isFinite(Date.parse(String(row.due)))) throw new Error(`현안 원장 ${index + 1}줄 형식 오류`);
    return row as Issue;
  });
}
function latest(rows: Issue[], before = Infinity): Map<string, Issue> {
  const map = new Map<string, Issue>();
  for (const row of rows) if (Date.parse(row.at) < before) map.set(row.id, row);
  return map;
}
function appendIssue(root: string, row: Issue) {
  const file = issuePath(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}
function readDailyNews(root: string, from: Date, to: Date): Section<{ title: string; url: string }[]> {
  const found = new Map<string, { title: string; url: string }>();
  const failures: string[] = [];
  let files = 0;
  for (let at = from.getTime(); at < to.getTime(); at += DAY) {
    const day = kstDate(new Date(at));
    const file = join(root, 'rhythm', 'daily', `${day}.md`);
    if (!existsSync(file)) { failures.push(`${day} 데일리 없음`); continue; }
    files++;
    try {
      const text = readFileSync(file, 'utf8');
      const block = text.split('## ⑦ 외부 동향\n')[1]?.split(/\n\n## /)[0]?.trim();
      if (!block) throw new Error('외부 동향 절 없음');
      if (block.startsWith('못 읽음 ·')) throw new Error(block.split('\n')[0]!);
      for (const line of block.split('\n')) {
        if (line === '수집된 기사 0건' || /^  시사점: /.test(line)) continue;
        const match = /^- (.+) — (https?:\/\/\S+)$/.exec(line);
        if (!match) throw new Error(`외부 동향 기사 형식 오류: ${line}`);
        if (!found.has(match[2]!)) found.set(match[2]!, { title: match[1]!, url: match[2]! });
      }
    } catch (e) { failures.push(`${day} ${reasonOf(e)}`); }
  }
  const news = [...found.values()].slice(0, 10);
  if (failures.length) return { status: 'unreadable', reason: `${files ? failures.join('; ') : '데일리 없음'}${news.length ? `\n부분 수집 (완전한 주간 집계 아님):\n${news.map(n => `- ${n.title} — ${n.url}`).join('\n')}` : ''}` };
  return { status: 'ok', value: news };
}
const labels: Record<keyof WeeklyParts, string> = {
  landings: '① 지난주 성과', release: '② 이번 주 판 계획', issues: '③ 주간 현안',
  followThrough: '④ 지난주 현안 이행 대조', decisions: '⑤ 결정 필요', news: '⑥ 주간 외부 동향',
};
function publishedVersions(root: string, from: Date, to: Date): string[] {
  const directory = join(root, 'release');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(version => /^\d+\.\d+\.\d+$/.test(version)).filter(version => {
    const file = join(directory, version, 'release.json');
    if (!existsSync(file)) return false;
    const record = object(JSON.parse(readFileSync(file, 'utf8')));
    const publishedAt = record.publishedAt;
    return record.version === version && typeof publishedAt === 'string' && Number.isFinite(Date.parse(publishedAt)) && Date.parse(publishedAt) >= from.getTime() && Date.parse(publishedAt) < to.getTime();
  }).sort(sortNames);
}
function compose(parts: WeeklyParts, key: string, now: Date, versions: Section<string[]>) {
  const open = parts.issues.status === 'ok' ? parts.issues.value : [];
  const overdue = open.filter(i => Date.parse(i.due) < now.getTime());
  const red = parts.release.status === 'ok' ? parts.release.value.red : [];
  const risk = overdue[0] ? `${overdue[0].title} 기한 넘김 (${overdue[0].owner})` : red[0] ? `${red[0].name} red 칸` : '확인된 위험 없음(못 읽은 절은 별도 확인)';
  const old = parts.decisions.status === 'ok' ? parts.decisions.value.filter(d => now.getTime() - Date.parse(d.openedAt) > 3 * DAY) : [];
  const header = [
    `S: 지난주 착지 ${parts.landings.status === 'ok' ? `${parts.landings.value.length}건` : `못 읽음 · ${parts.landings.reason}`} · 판 ${parts.release.status === 'ok' ? `${parts.release.value.green}/${parts.release.value.total}` : `못 읽음 · ${parts.release.reason}`}`,
    `C: ${risk}`, `Q: 이번 주 ${old.length ? old[0]!.name : '어떤 현안을'} 정할 것인가?`,
    `A: ${overdue[0] ? `${overdue[0].owner}가 ${overdue[0].title} 이행 기한을 확인` : red[0] ? `${red[0].name} 해소를 결정` : '열린 현안의 담당과 기한을 확인'}`,
  ].join('\n');
  const section = <T>(name: keyof WeeklyParts, value: Section<T>, format: (v: T) => string) =>
    `## ${labels[name]}\n${value.status === 'ok' ? format(value.value) : `못 읽음 · ${value.reason}`}`;
  const markdown = [
    `# 주간 미팅 — ${key} (KST)`, header,
    section('landings', parts.landings, list => {
      const seats = [...new Set(list.map(i => i.seat))].sort(sortNames).map(s => `${s} ${list.filter(i => i.seat === s).length}`).join(' · ');
      return `총 ${list.length}건 · 자리별 ${seats || '없음'}\n발행된 판: ${versions.status === 'ok' ? versions.value.join(', ') || '없음' : `못 읽음 · ${versions.reason}`}`;
    }),
    section('release', parts.release, r => `${r.version}: green ${r.green}/${r.total} · 다음 판 ${r.nextVersion ?? '미정'} ${r.nextGreen ?? '못 읽음'}/${r.nextTotal ?? '못 읽음'} · 다음 컷 ${r.cutAt ?? '미정'}\nred 칸: ${r.red.map(i => i.name).join(', ') || '없음'}`),
    section('issues', parts.issues, list => list.map(i => `- ${i.id} ${i.title} · ${i.owner} · 기한 ${i.due}`).join('\n') || '열린 현안 없음'),
    section('followThrough', parts.followThrough, list => list.map(({ issue, outcome, doneAt }) => `- ${issue.id} ${issue.title} · ${issue.owner} · 기한 ${issue.due} — ${outcome}${doneAt ? ` (완료 ${doneAt})` : ''}`).join('\n') || '지난주 열린 현안 없음'),
    section('decisions', parts.decisions, list => list.filter(d => now.getTime() - Date.parse(d.openedAt) > 3 * DAY).map(d => `- ${d.name} (${d.openedAt})`).join('\n') || '3일 넘은 결정 없음'),
    section('news', parts.news, list => list.map(n => `- ${n.title} — ${n.url}`).join('\n') || '수집된 기사 0건'),
  ].join('\n\n') + '\n';
  const sections = Object.fromEntries(Object.keys(labels).map(k => [k, parts[k as keyof WeeklyParts].status])) as Record<keyof WeeklyParts, 'ok' | 'unreadable'>;
  return { markdown, header, sections, issuesOpen: open.length, issuesOverdue: overdue.length };
}
function vaultCopy(markdown: string, key: string, deps: WeeklyDeps) {
  let root = deps.vaultRoot;
  if (root === undefined) {
    try {
      root = String(object(getUserConfig().raw.obsidian).vaultRoot || '') || null;
      if (root && effectiveInstanceRoot() !== prodInstanceRoot()) return { vaultError: '격리 인스턴스 — 운영 볼트 사본 건너뜀', vaultFatal: false };
    } catch (e) { return { vaultError: reasonOf(e), vaultFatal: true }; }
  }
  if (!root) return { vaultError: null, vaultFatal: false };
  try {
    const file = join(root, '00. Inbox', 'Weekly Review', `${key}.md`);
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, markdown);
    return { vaultError: null, vaultFatal: false };
  } catch (e) { return { vaultError: reasonOf(e), vaultFatal: true }; }
}
function sendReview(file: string, text: string, send: (text: string, kind: string) => boolean, receipt: (key: string) => 'sent' | 'not-sent' | 'unknown') {
  const key = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const db = new Database(join(dirname(file), 'delivery.sqlite'));
  try {
    db.run("CREATE TABLE IF NOT EXISTS deliveries (week TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','unknown','sent')))");
    db.run("INSERT OR IGNORE INTO deliveries(week, state) VALUES (?, 'pending')", [key]);
    const state = (db.prepare('SELECT state FROM deliveries WHERE week = ?').get(key) as { state: string }).state;
    if (state === 'sent') return { sent: false, sendError: null };
    if (state === 'unknown') {
      const verdict = receipt(key);
      if (verdict === 'sent') { db.run("UPDATE deliveries SET state = 'sent' WHERE week = ?", [key]); return { sent: false, sendError: null }; }
      if (verdict !== 'not-sent') return { sent: false, sendError: `발송 결과 불명 · RHYTHM-WEEKLY:${key} 영수증 확인 필요` };
      db.run("UPDATE deliveries SET state = 'pending' WHERE week = ?", [key]);
    }
    if (!db.prepare("UPDATE deliveries SET state = 'unknown' WHERE week = ? AND state = 'pending'").run(key).changes)
      return { sent: false, sendError: `발송 결과 불명 · RHYTHM-WEEKLY:${key} 영수증 확인 필요` };
    try {
      if (!send(`${text}\nRHYTHM-WEEKLY:${key}`, 'ops-report')) return { sent: false, sendError: '발송 실패 · 결과 불명 (영수증 확인 필요)' };
      db.run("UPDATE deliveries SET state = 'sent' WHERE week = ?", [key]);
      return { sent: true, sendError: null };
    } catch (e) { return { sent: false, sendError: `발송 결과 불명 · ${reasonOf(e)}` }; }
  } catch (e) { return { sent: false, sendError: `발송 상태 못 읽음 · ${reasonOf(e)}` }; }
  finally { db.close(); }
}
function outboundReceipt(root: string, key: string): 'sent' | 'unknown' {
  const file = join(root, ...(root === prodInstanceRoot() ? ['memory'] : []), 'surface_events.db');
  if (!existsSync(file)) return 'unknown';
  try {
    const db = new Database(file, { readonly: true, create: false });
    try { return db.prepare("SELECT 1 FROM events WHERE direction='outbound' AND kind='ops-report' AND instr(text, ?) > 0 LIMIT 1").get(`RHYTHM-WEEKLY:${key}`) ? 'sent' : 'unknown'; }
    finally { db.close(); }
  } catch { return 'unknown'; }
}
export async function runWeekly(options: { dryRun?: boolean; stage?: 'collect' | 'compose' | 'deliver' } = {}, deps: WeeklyDeps = {}) {
  const now = (deps.now ?? (() => new Date()))();
  const root = deps.root ?? effectiveInstanceRoot();
  const { from, to, key } = weekOf(now);
  const file = join(root, 'rhythm', 'weekly', `${key}.md`);
  let markdown: string;
  let header: string;
  let sections: Record<keyof WeeklyParts, 'ok' | 'unreadable'>;
  let issuesOpen: number;
  let issuesOverdue: number;
  if (options.stage === 'compose' || options.stage === 'deliver') {
    if (!existsSync(file)) throw new Error(`수집 파일 없음: ${file}`);
    markdown = readFileSync(file, 'utf8');
    header = markdown.split('\n').slice(2, 6).join('\n');
    if (!header.startsWith('S: ') || Object.values(labels).some(label => !markdown.includes(`## ${label}\n`))) throw new Error(`리뷰 파일 형식 오류: ${file}`);
    sections = Object.fromEntries(Object.entries(labels).map(([k, label]) => [k, markdown.split(`## ${label}\n`)[1]?.startsWith('못 읽음 ·') ? 'unreadable' : 'ok'])) as typeof sections;
    if (sections.issues === 'unreadable') { issuesOpen = 0; issuesOverdue = 0; }
    else {
      const open = [...latest(issueHistory(root)).values()].filter(i => i.status === 'open');
      issuesOpen = open.length;
      issuesOverdue = open.filter(i => Date.parse(i.due) < now.getTime()).length;
    }
  } else {
    const safe = async <T>(fn: () => Promise<T>): Promise<Section<T>> => {
      try { return { status: 'ok', value: await fn() }; } catch (e) { return { status: 'unreadable', reason: reasonOf(e) }; }
    };
    const issues = await safe(async () => issueHistory(root));
    const parts: WeeklyParts = {
      landings: await safe(() => (deps.landings ?? collectLandings)(now, { from, to })),
      release: await safe(deps.release ?? collectRelease),
      issues: issues.status === 'ok' ? { status: 'ok', value: [...latest(issues.value).values()].filter(i => i.status === 'open') } : issues,
      followThrough: issues.status === 'ok' ? { status: 'ok', value: [...new Set([
        ...[...latest(issues.value, from.getTime()).values()].filter(i => i.status === 'open').map(i => i.id),
        ...issues.value.filter(i => Date.parse(i.at) >= from.getTime() && Date.parse(i.at) < to.getTime()).map(i => i.id),
      ])].map(id => {
        const issue = issues.value.filter(i => i.id === id && Date.parse(i.at) < to.getTime()).at(-1)!;
        const current = latest(issues.value).get(id);
        // A completion after the due date is a missed deadline, not a plain «done» (review round 3).
        if (current?.status === 'done') return { issue, outcome: Date.parse(current.at) > Date.parse(issue.due) ? '기한 뒤 완료' as const : 'done' as const, doneAt: current.at };
        return { issue, outcome: Date.parse(issue.due) < now.getTime() ? '기한 넘김' as const : '진행' as const };
      }) } : issues,
      decisions: await safe(deps.decisions ?? collectDecisions),
      news: readDailyNews(root, from, to),
    };
    const versions = await safe(async () => publishedVersions(root, from, to));
    if (versions.status === 'unreadable') {
      parts.landings = { status: 'unreadable', reason: `${parts.landings.status === 'unreadable' ? `${parts.landings.reason}; ` : ''}발행된 판 목록 못 읽음 · ${versions.reason}` };
    }
    const review = compose(parts, key, now, versions);
    ({ markdown, header, sections, issuesOpen, issuesOverdue } = review);
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, markdown);
  }
  const vault = options.stage === 'deliver' ? { vaultError: null, vaultFatal: false } : vaultCopy(markdown, key, deps);
  let sent = false;
  let sendError: string | null = null;
  let enabled = deps.sendEnabled === true;
  if (deps.sendEnabled === undefined && !options.dryRun && options.stage !== 'collect') {
    try { enabled = object(object(object(getUserConfig().raw.loops).rhythm).weekly).send === true; }
    catch (e) { sendError = `발송 설정 못 읽음 · ${reasonOf(e)}`; }
  }
  if (!vault.vaultFatal && !options.dryRun && options.stage !== 'collect' && options.stage !== 'compose' && enabled) {
    const delivery = sendReview(file, `${header}\n\n${file}`, deps.send ?? sendOutbound, deps.receipt ?? (key => outboundReceipt(root, key)));
    sent = delivery.sent; sendError = delivery.sendError;
  }
  if (options.stage !== 'collect' && options.stage !== 'compose') {
    const tick = { sections, issuesOpen, issuesOverdue, sent };
    if (deps.log) deps.log('loop.rhythm-weekly', 'tick', tick); else loopEvent('rhythm-weekly', 'tick', tick);
  }
  return { file, markdown, header, sections, issuesOpen, issuesOverdue, sent, ...vault, sendError };
}
export async function main(args: string[] = process.argv.slice(2), deps: WeeklyDeps = {}) {
  const print = deps.print ?? console.log;
  const root = deps.root ?? effectiveInstanceRoot();
  if (args[0] === '--help') {
    print('bun scripts/rhythm/weekly.ts [--dry-run] [--json]\nbun scripts/rhythm/weekly.ts issue add --title <t> --owner <자리> --due <ISO> [--by <이름>]\nbun scripts/rhythm/weekly.ts issue done <id> [--by <이름>]\nbun scripts/rhythm/weekly.ts issue list [--json]');
    return;
  }
  if (args[0] === 'issue') {
    const [action, ...rest] = args.slice(1);
    const flag = (name: string) => { const index = rest.indexOf(name); return index < 0 ? undefined : rest[index + 1]; };
    const now = (deps.now ?? (() => new Date()))().toISOString();
    if (action === 'list') {
      if (rest.some(arg => arg !== '--json')) throw new Error('알 수 없는 옵션');
      const rows = [...latest(issueHistory(root)).values()];
      print(rest.includes('--json') ? JSON.stringify(rows) : rows.map(i => `${i.id} · ${i.title} · ${i.owner} · ${i.due} · ${i.status}`).join('\n') || '현안 없음');
      return rows;
    }
    const by = rest.includes('--by') ? flag('--by') : process.env.AI_AGENT;
    if (!by) throw new Error('--by 또는 AI_AGENT 필요');
    if (action === 'add') {
      const title = flag('--title'), owner = flag('--owner'), due = flag('--due');
      if (!title || !owner || !due || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(due) || !Number.isFinite(Date.parse(due)) || rest.length % 2 ||
          rest.some((arg, i) => i % 2 === 0 ? !['--title', '--owner', '--due', '--by'].includes(arg) : !arg || arg.startsWith('--'))) throw new Error('issue add: --title --owner --due <ISO> 필요');
      const row: Issue = { id: randomUUID(), title, owner, due, status: 'open', at: now, by };
      appendIssue(root, row); print(JSON.stringify(row)); return row;
    }
    if (action === 'done') {
      const id = rest[0];
      if (!id || (rest.length !== 1 && (rest.length !== 3 || rest[1] !== '--by' || !rest[2]))) throw new Error('issue done <id> [--by <이름>]');
      const issue = latest(issueHistory(root)).get(id);
      if (!issue) throw new Error(`현안 없음: ${id}`);
      const row: Issue = { ...issue, status: 'done', at: now, by };
      appendIssue(root, row); print(JSON.stringify(row)); return row;
    }
    throw new Error(`알 수 없는 issue 명령: ${action}`);
  }
  const stage = process.env.ELANOUS_GRAPH_DIR && ['collect', 'compose', 'deliver'].includes(args[0] ?? '') ? args.shift() as 'collect' | 'compose' | 'deliver' : undefined;
  for (const arg of args) if (!['--dry-run', '--json'].includes(arg)) throw new Error(`알 수 없는 옵션: ${arg}`);
  const result = await runWeekly({ dryRun: args.includes('--dry-run'), stage }, deps);
  print(args.includes('--json') ? JSON.stringify(result) : `${result.markdown}\n파일: ${result.file} · sent=${result.sent}`);
  if ((stage === 'compose' || !stage) && result.vaultFatal) throw new Error(`볼트 사본 실패 · ${result.vaultError}`);
  if ((stage === 'deliver' || !stage) && result.sendError) throw new Error(`발송 실패 · ${result.sendError}`);
  return result;
}
if (import.meta.main) main().catch(e => { console.error(`rhythm-weekly: ${reasonOf(e)}`); process.exitCode = 1; });
