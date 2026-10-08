import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject, runGraph } from '../graph-runner/runner.js';
import { DEFAULT_FACTS, DEFAULT_KEY, RETRO_DAILY_GRAPH, runShadowComparison } from '../../scripts/retro/shadow-compare.js';
import {
  assertInsightsCite, buildInsights, clusterFacts, draftActions, findRecurrences, normalizeFacts, resolveRetroMode,
  readPriorDays, retroBriefingLines, retroDayFile, runRetroStage, summaryLines,
} from './daily.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'retro-daily-')); dirs.push(dir); return dir; };
const key = JSON.parse(readFileSync(DEFAULT_KEY, 'utf8'));

test('shadow comparison: the graph reproduces RFC §0 five recurring problems with draft backlog (re-broke after green) first', async () => {
  const result = await runShadowComparison();
  expect(result.missed).toEqual([]);
  expect(result.falsePositives).toEqual([]);
  expect(result.firstRank).toBe('draft-backlog');
  expect(new Set(result.detected)).toEqual(new Set(['draft-backlog', 'silent-failure', 'universe-confusion', 'serialization', 'unreadable-stop']));
  expect(result.actions).toBeLessThanOrEqual(3);
  expect(result.summary).toHaveLength(3);
  expect(result.wroteChecklist).toBe(false);
  expect(result.ok).toBe(true);
}, 60_000);

test('shadow run writes only the day file under the run universe — no checklist, no briefing flag, sent=false', async () => {
  const root = tmp();
  const run = await runGraph(RETRO_DAILY_GRAPH, { input: { factsFile: DEFAULT_FACTS, day: '2026-10-07', greenCells: key.greenCells }, deps: { root } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['collect', 'cluster', 'recur', 'insight', 'act', 'report', 'done']);
  const report = lastJsonObject(run.nodes.find(n => n.nodeId === 'report')?.output);
  expect(report).toMatchObject({ mode: 'shadow', sent: false, wroteChecklist: false });
  const day = JSON.parse(readFileSync(retroDayFile(root, '2026-10-07'), 'utf8'));
  expect(day.briefing).toBe(false);
  expect(existsSync(join(root, 'retro', 'daily', '2026-10-07.md'))).toBe(true);
  expect(readdirSync(root).sort()).toEqual(['graph-runs', 'retro']);
  // shadow 회고는 08:30 브리핑에 실리지 않는다.
  expect(retroBriefingLines(root, '2026-10-07')).toEqual([]);
  // 인사이트는 실제 사실 id 만 인용한다.
  const ids = new Set(day.clusters.flatMap((c: { factIds: string[] }) => c.factIds));
  for (const insight of day.insights) for (const id of insight.cites) expect(ids.has(id)).toBe(true);
}, 60_000);

test('dry-run writes nothing', async () => {
  const root = tmp();
  const run = await runGraph(RETRO_DAILY_GRAPH, { dryRun: true, input: { factsFile: DEFAULT_FACTS, day: '2026-10-07', greenCells: [] }, deps: { root } });
  expect(run.status).toBe('done');
  expect(existsSync(join(root, 'retro'))).toBe(false);
}, 60_000);

test('recur: a theme seen in a prior daily file ranks above a bigger one-day theme; prior action makes it re-broke', () => {
  const root = tmp();
  mkdirSync(join(root, 'retro', 'daily'), { recursive: true });
  writeFileSync(join(root, 'retro', 'daily', '2026-10-06.json'), JSON.stringify({ themes: [{ theme: 'serialization' }], clusters: [], actions: [{ theme: 'serialization' }] }));
  writeFileSync(join(root, 'retro', 'daily', '2026-09-20.json'), JSON.stringify({ themes: [{ theme: 'universe-confusion' }] })); // 창은 «최근 7개 회고 파일»이다(빈 날이 있어도 7판을 본다)
  writeFileSync(join(root, 'retro', 'daily', '2026-10-08.json'), JSON.stringify({ themes: [{ theme: 'unreadable-stop' }] })); // 미래 파일은 안 본다
  const { facts } = normalizeFacts(JSON.parse(readFileSync(DEFAULT_FACTS, 'utf8')));
  const clusters = clusterFacts(facts);
  const prior = readPriorDays(root, '2026-10-07');
  expect(prior.map(p => p.day)).toEqual(['2026-09-20', '2026-10-06']);
  const rec = findRecurrences(clusters, prior, []);
  expect(rec[0]).toMatchObject({ theme: 'serialization', reBrokeAfterGreen: false, recurAfterAction: true, actedBefore: ['2026-10-06'] });
  expect(rec[1]).toMatchObject({ theme: 'universe-confusion', daysSeen: ['2026-09-20'] });
  const insights = buildInsights(rec);
  assertInsightsCite(insights, facts);
  const actions = draftActions(insights, rec, '2026-10-07');
  expect(actions).toHaveLength(3);
  expect(actions.every(a => a.status === 'draft' && a.evidence.length > 0)).toBe(true);
  expect(summaryLines(rec, actions, facts.length, 'shadow')).toHaveLength(3);
});

test('insight without valid fact ids is rejected', () => {
  expect(() => assertInsightsCite([{ theme: 'x', title: 'x', text: '', rootCause: '', cites: ['F-deadbeef'] }], [])).toThrow(/cites/);
  expect(() => assertInsightsCite([{ theme: 'x', title: 'x', text: '', rootCause: '', cites: [] }], [])).toThrow(/cites/);
});

test('cluster signature: failing test beats stop reason; unknown signatures survive as sig: themes', () => {
  const { facts } = normalizeFacts([
    { at: '2026-10-07T01:00:00Z', kind: 'stop-reason', data: { stopReason: 'gate-red', failingTest: 'src/a.test.ts' } },
    { at: '2026-10-07T02:00:00Z', kind: 'stop-reason', data: { stopReason: 'gate-red', failingTest: 'src/a.test.ts' } },
    { at: '2026-10-07T03:00:00Z', kind: 'decision-card', data: { cardKind: 'repeat-stop' } },
  ]);
  const clusters = clusterFacts(facts);
  expect(clusters[0]).toMatchObject({ signature: 'test:src/a.test.ts', count: 2, theme: 'sig:test:src/a.test.ts' });
  expect(clusters[1]).toMatchObject({ signature: 'decision-card:repeat-stop' });
  expect(findRecurrences(clusters, [], [])[0]).toMatchObject({ theme: 'sig:test:src/a.test.ts', recurring: true });
});

test('mode: default shadow · live only from config · input can only force shadow', () => {
  expect(resolveRetroMode({}, () => ({}))).toBe('shadow');
  expect(resolveRetroMode({}, () => ({ retro: { daily: { mode: 'live' } } }))).toBe('live');
  expect(resolveRetroMode({ mode: 'live' }, () => ({}))).toBe('shadow');
  expect(resolveRetroMode({ mode: 'shadow' }, () => ({ retro: { daily: { mode: 'live' } } }))).toBe('shadow');
  expect(resolveRetroMode({}, () => { throw new Error('unreadable'); })).toBe('shadow');
});

test('live mode marks the day file for the 08:30 briefing (three lines)', async () => {
  const root = tmp();
  const ctx = (outputs: Record<string, Record<string, unknown> | null>) => ({ input: { factsFile: DEFAULT_FACTS, day: '2026-10-07', greenCells: key.greenCells }, outputs });
  const deps = { readConfig: () => ({ retro: { daily: { mode: 'live' } } }) };
  const outputs: Record<string, Record<string, unknown> | null> = {};
  for (const stage of ['collect', 'cluster', 'recur', 'insight', 'act', 'report'] as const) outputs[stage] = await runRetroStage(stage, ctx(outputs), root, false, deps);
  expect(outputs.report).toMatchObject({ mode: 'live', wroteChecklist: false });
  const lines = retroBriefingLines(root, '2026-10-07');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain('draft 적체');
});

test('two consecutive real runs without green cells never claim «re-broke after green»; day 2 sees day 1', async () => {
  const root = tmp();
  for (const day of ['2026-10-07', '2026-10-08']) {
    const run = await runGraph(RETRO_DAILY_GRAPH, { input: { factsFile: DEFAULT_FACTS, day, greenCells: [] }, deps: { root } });
    expect(run.status).toBe('done');
  }
  const second = JSON.parse(readFileSync(retroDayFile(root, '2026-10-08'), 'utf8'));
  expect(second.priorDays).toEqual(['2026-10-07']);
  expect(second.themes.every((t: { reBrokeAfterGreen: boolean }) => t.reBrokeAfterGreen === false)).toBe(true);
  expect(second.themes.find((t: { theme: string }) => t.theme === 'draft-backlog')).toMatchObject({ recurAfterAction: true });
  expect(second.summary.join('\n')).not.toContain('초록 뒤 재발');
}, 60_000);

test('a green cell that turned green only after the facts is not «re-broke after green»', () => {
  const { facts } = normalizeFacts(JSON.parse(readFileSync(DEFAULT_FACTS, 'utf8')));
  const clusters = clusterFacts(facts);
  const late = findRecurrences(clusters, [], [{ id: 'DRAFT3', status: 'done', greenAt: '2026-10-08T00:00:00.000Z' }]);
  expect(late.find(r => r.theme === 'draft-backlog')).toMatchObject({ reBrokeAfterGreen: false });
  const early = findRecurrences(clusters, [], [{ id: 'DRAFT3', status: 'done', greenAt: '2026-10-01T00:00:00.000Z' }]);
  expect(early.find(r => r.theme === 'draft-backlog')).toMatchObject({ reBrokeAfterGreen: true, rank: 1 });
});

test('task-agent outcome without a judgeable result is not folded into ok', () => {
  const { facts } = normalizeFacts([
    { at: '2026-10-07T01:00:00Z', kind: 'ta-outcome', data: { cardKind: 'docs' } },
    { at: '2026-10-07T01:00:00Z', kind: 'ta-outcome', data: { cardKind: 'docs', result: 'handed to MK' } },
    { at: '2026-10-07T01:00:00Z', kind: 'ta-outcome', data: { cardKind: 'docs', result: 'README updated' } },
  ]);
  expect(facts.map(f => f.signature)).toEqual(['card:docs:no-result', 'card:docs:unjudged', 'card:docs:ok']);
});

test('shadow comparison flags any recurring theme outside the answer key as a false positive', async () => {
  const dir = tmp();
  const raw = JSON.parse(readFileSync(DEFAULT_FACTS, 'utf8'));
  for (const at of ['2026-10-07T14:00:00.000Z', '2026-10-07T14:10:00.000Z']) raw.facts.push({ store: 'current', at, category: 'self-dev.supervisor', event: 'resolved', kind: 'stop-reason', data: { stopReason: 'budget-exceeded' } });
  const facts = join(dir, 'facts.json');
  writeFileSync(facts, JSON.stringify(raw));
  const result = await runShadowComparison(facts);
  expect(result.falsePositives).toContain('sig:stop:budget-exceeded');
  expect(result.ok).toBe(false);
}, 60_000);
