#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { listSchedules } from '../../src/release-loop/release-schedule.js';
import { listChecklist } from '../../src/release-loop/checklist.js';

export type MonthlyDeps = {
  now?: () => Date;
  root?: string;
  landings?: (window: { from: Date; to: Date }) => Promise<unknown[]>;
  decisions?: () => Promise<unknown[]>;
  schedules?: () => unknown[];
  weeklyDir?: string;
};

export async function runMonthly(deps: MonthlyDeps = {}) {
  if (process.env.NODE_ENV === 'test' && (!deps.root || !deps.landings || !deps.decisions || !deps.schedules)) {
    throw new Error('시험에서 월간 원장 수집에는 root·landings·decisions·schedules 주입 필요');
  }
  const now = (deps.now ?? (() => new Date()))();
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  const from = new Date(Date.UTC(year, month - 1, 1) - 9 * 3_600_000);
  const to = new Date(Date.UTC(year, month, 1) - 9 * 3_600_000);
  const key = new Date(from.getTime() + 9 * 3_600_000).toISOString().slice(0, 7);
  const root = deps.root ?? effectiveInstanceRoot();
  const file = join(root, 'rhythm', 'monthly', `${key}.md`);
  if (existsSync(file)) return { file, status: '이미 있음' as const };

  const safe = async <T>(read: () => T | Promise<T>): Promise<{ value: T; error?: never } | { error: string; value?: never }> => {
    try { return { value: await read() }; }
    catch (error) { return { error: (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]!.slice(0, 200) }; }
  };
  const landings = await safe(async () => (await (deps.landings ?? (async window => (await import('./daily.js')).collectLandings(now, window)))({ from, to })).length);
  const releases = await safe(() => {
    const schedules = deps.schedules ? deps.schedules() : listSchedules(root);
    return schedules.map(value => {
      if (!value || typeof value !== 'object' || !('cutAt' in value) || typeof value.cutAt !== 'string'
        || !('version' in value) || typeof value.version !== 'string' || !Number.isFinite(Date.parse(value.cutAt))) {
        throw new Error('판 일정 형식 오류');
      }
      return { version: value.version as string, cutAt: value.cutAt as string };
    }).filter(schedule => Date.parse(schedule.cutAt) >= from.getTime() && Date.parse(schedule.cutAt) < to.getTime());
  });
  const checklist = await safe(() => {
    if (deps.schedules || releases.error !== undefined) return [];
    return releases.value.map(schedule => ({ version: schedule.version, items: listChecklist(schedule.version, root).items }));
  });
  const decisions = await safe(async () => (await (deps.decisions ?? (async () => (await import('./daily.js')).collectDecisions()))()).length);
  const weeks = await safe(() => readdirSync(deps.weeklyDir ?? join(root, 'rhythm', 'weekly'), { withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => entry.name).filter(name => {
    const match = /^(\d{4})-W(\d{2})\.md$/.exec(name);
    if (!match) return false;
    const jan4 = Date.UTC(Number(match[1]), 0, 4);
    const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000 + (Number(match[2]) - 1) * 7 * 86_400_000;
    const start = Date.UTC(year, month - 1, 1);
    const end = Date.UTC(year, month, 1);
    return Number(match[2]) >= 1 && Number(match[2]) <= 53 && monday < end && monday + 7 * 86_400_000 > start;
  }).map(name => name.slice(0, -3)).sort());
  const show = <T>(section: { value: T; error?: never } | { error: string; value?: never }, format: (value: T) => string) =>
    section.error !== undefined ? `못 읽음 · ${section.error}` : format(section.value as T);
  const releaseText = show(releases, values => values.length ? `판 ${values.length}건\n${values.map(schedule => {
    const items = checklist.error === undefined ? checklist.value.find(row => row.version === schedule.version)?.items : undefined;
    const progress = items ? ` · green ${items.filter(item => item.status === 'green').length}/${items.length}` : '';
    return `- ${schedule.version} · ${new Date(Date.parse(schedule.cutAt) + 9 * 3_600_000).toISOString().slice(0, 10)}${progress}`;
  }).join('\n')}${checklist.error !== undefined ? `\n체크리스트 못 읽음 · ${checklist.error}` : ''}` : '판 0건');
  const landingText = show(landings, count => `착지 ${count}건`);
  const decisionText = show(decisions, count => `결정 대기 ${count}건`);
  const weekText = show(weeks, keys => keys.length ? keys.map(week => `- ${week}`).join('\n') : '주간 리뷰 0건');
  const questions = [
    landings.error !== undefined || releases.error !== undefined
      ? '착지와 판 이력을 확인하면 다음 달에 점검할 거리는 얼마인가?'
      : `착지 ${landings.value}건과 판 ${releases.value.length}건을 바탕으로 다음 달에 점검할 거리는 얼마인가?`,
    decisions.error !== undefined || weeks.error !== undefined
      ? '결정 대기와 주간 리뷰를 확인하면 다음 달 첫 우선순위는 무엇인가?'
      : `결정 대기 ${decisions.value}건과 주간 리뷰 ${weeks.value.length}개의 신호로 다음 달 첫 우선순위는 무엇인가?`,
  ];
  const markdown = [
    `# 월간 미팅 — ${key} (KST)`,
    `## S 지난달\n${landingText}\n${decisionText}\n주간 리뷰\n${weekText}`,
    `## C 로드맵 거리\n기존 로드맵 기준(현행 목표 여부 미확인): 10-28 출시 · 11월 기업용\n판 이력\n${releaseText}`,
    `## Q 다음 달 방향\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`,
    '## A 다음 달 첫 주\n- 판 이력과 주간 리뷰를 대조해 다음 달에 확인할 첫 칸을 고른다.\n- 열린 결정을 확인해 첫 주의 방향을 정한다.',
  ].join('\n\n') + '\n';
  mkdirSync(dirname(file), { recursive: true });
  try { writeFileSync(file, markdown, { flag: 'wx' }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return { file, status: '이미 있음' as const };
    throw error;
  }
  return { file, status: 'created' as const, markdown };
}

if (import.meta.main) runMonthly().then(result => console.log(`${result.status}: ${result.file}`))
  .catch(error => { console.error(`rhythm-monthly: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
