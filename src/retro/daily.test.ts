import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { lastJsonObject, runGraph } from '../graph-runner/runner.js';
import { LogStore } from '../mss/logging/log-store.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { DEFAULT_FACTS, DEFAULT_KEY, RETRO_DAILY_GRAPH, runShadowComparison } from '../../scripts/retro/shadow-compare.js';
import {
  assertInsightsCite, buildInsights, clusterFacts, draftActions, findRecurrences, normalizeFacts, resolveRetroMode,
  readPriorDays, retroBriefingLines, retroDayFile, runRetroStage, summaryLines,
} from './daily.js';

const dirs: string[] = [];
afterEach(() => { resetElanousConfigDir(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
  const summary = summaryLines(rec, actions, facts.length, 'shadow');
  expect(summary).toHaveLength(3);
  expect(summary[1]).toContain(`사실 ${facts.length} · 반복 주제`);
  expect(summary[1]).not.toContain('측정 불가');
});

test('summaryLines treats omitted measurement status on zero facts as unknown, but explicit success as zero', () => {
  expect(summaryLines([], [], 0, 'shadow')).toEqual([
    '회고: 반복 판정 불가',
    '사실 측정 불가 · 반복 주제 측정 불가(판정 불가)',
    '조치 초안 0: 없음 · shadow',
  ]);
  expect(summaryLines([], [], 0, 'shadow', false)).toEqual([
    '회고: 반복 없음',
    '사실 0 · 반복 주제 0(없음)',
    '조치 초안 0: 없음 · shadow',
  ]);
});

test('report without a collect measurement source does not claim a successful zero', async () => {
  const root = tmp();
  const result = await runRetroStage('report', { input: { day: '2026-10-09' }, outputs: {} }, root, true);
  expect(result.summary).toContain('사실 측정 불가 · 반복 주제 측정 불가(판정 불가)');
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

test('collect passes the parent config-dir to retro facts and report retains facts and recurring topics', async () => {
  const root = tmp();
  const repo = tmp();
  const configDir = join(root, 'parent-config');
  setElanousConfigDir(configDir);
  mkdirSync(join(repo, 'bin'), { recursive: true });
  writeFileSync(join(repo, 'bin', 'elanous.mjs'), `
    const args = process.argv.slice(2);
    if (args.at(-2) !== '--config-dir' || args.at(-1) !== ${JSON.stringify(configDir)} ||
        !args.includes('--test=${root}') || !args.includes('retro') || !args.includes('facts')) process.exit(12);
    console.log(JSON.stringify({ facts: [
      { at: '2026-10-09T01:00:00Z', kind: 'draft-birth', data: { title: 'draft one' } },
      { at: '2026-10-09T02:00:00Z', kind: 'draft-birth', data: { title: 'draft two' } },
    ], unavailable: [] }));
  `);
  const outputs: Record<string, Record<string, unknown> | null> = {};
  const ctx = () => ({ input: { day: '2026-10-09', greenCells: [] }, outputs });
  for (const stage of ['collect', 'cluster', 'recur', 'insight', 'act', 'report'] as const) {
    outputs[stage] = await runRetroStage(stage, ctx(), root, false, { repo, now: new Date('2026-10-09T13:40:00Z') });
  }
  const day = JSON.parse(readFileSync(retroDayFile(root, '2026-10-09'), 'utf8'));
  expect(day.factCount).toBe(2);
  expect(day.themes).toContainEqual(expect.objectContaining({ theme: 'draft-backlog', recurring: true, count: 2 }));
  expect(day.summary[1]).toContain('사실 2 · 반복 주제 1(draft 적체)');
  expect(readFileSync(retroDayFile(root, '2026-10-09').replace('.json', '.md'), 'utf8')).toContain('draft 적체');
  expect(day.briefing).toBe(false);
});

test('production-shaped collect forwards the parent config-dir without adding a test flag', async () => {
  const repo = tmp();
  const configDir = join(repo, 'parent-config');
  setElanousConfigDir(configDir);
  mkdirSync(join(repo, 'bin'), { recursive: true });
  writeFileSync(join(repo, 'bin', 'elanous.mjs'), `
    const args = process.argv.slice(2);
    if (args.some(arg => arg.startsWith('--test')) || args.at(-2) !== '--config-dir' ||
        args.at(-1) !== ${JSON.stringify(configDir)}) process.exit(12);
    console.log(JSON.stringify({ facts: [], unavailable: [] }));
  `);
  const result = await runRetroStage('collect', { input: { greenCells: [] }, outputs: {} }, prodInstanceRoot(), true, { repo });
  expect(result.factCount).toBe(0);
  expect(result.sources).toMatchObject({ facts: 'retro facts --since 24h' });
}, 60_000);

test('relative parent config-dir is resolved before passing it to a child with another cwd', async () => {
  const parent = tmp();
  const repo = tmp();
  const configDir = join(parent, 'config');
  const relativeDir = relative(process.cwd(), configDir);
  setElanousConfigDir(relativeDir);
  mkdirSync(join(repo, 'bin'), { recursive: true });
  writeFileSync(join(repo, 'bin', 'elanous.mjs'), `
    const args = process.argv.slice(2);
    if (args.at(-2) !== '--config-dir' || args.at(-1) !== ${JSON.stringify(configDir)}) process.exit(12);
    console.log(JSON.stringify({ facts: [], unavailable: [] }));
  `);
  const result = await runRetroStage('collect', { input: { greenCells: [] }, outputs: {} }, parent, true, { repo });
  expect(result.sources).toMatchObject({ facts: 'retro facts --since 24h' });
}, 60_000);

test('real retro facts CLI agrees with a daily report on the explicitly selected config universe', async () => {
  const root = tmp();
  const configDir = join(root, 'parent-config');
  setElanousConfigDir(configDir);
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  const store = new LogStore(join(configDir, 'logs', 'logs.db'));
  store.insertBatch([1, 2].map(number => ({ rec: {
    ts: new Date(Date.now() - number * 1000).toISOString(), category: 'self-implement',
    event: 'rework-blocked-draft-pr', data: { number },
  }, surface: 'test' })));
  store.close();
  const args = ['bin/elanous.mjs', `--test=${root}`, 'retro', 'facts', '--since', '24h', '--json'];
  const withoutConfig = spawnSync('bun', args, { encoding: 'utf8', timeout: 60_000 });
  expect(withoutConfig.status).toBe(0);
  expect(JSON.parse(withoutConfig.stdout)).toMatchObject({ facts: [], unavailable: ['current'] });
  const direct = spawnSync('bun', [...args, '--config-dir', configDir], { encoding: 'utf8', timeout: 60_000 });
  expect(direct.status).toBe(0);
  const directFacts = JSON.parse(direct.stdout);
  expect(directFacts.unavailable).toEqual([]);
  expect(directFacts.facts).toHaveLength(2);
  const run = await runGraph(RETRO_DAILY_GRAPH, { input: { day: '2026-10-09', greenCells: [] }, deps: { root } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['collect', 'cluster', 'recur', 'insight', 'act', 'report', 'done']);
  const day = JSON.parse(readFileSync(retroDayFile(root, '2026-10-09'), 'utf8'));
  expect(Object.keys(day).sort()).toEqual([
    'day', 'mode', 'briefing', 'generatedAt', 'factCount', 'truncated', 'unavailable', 'sources',
    'priorDays', 'clusters', 'themes', 'insights', 'actions', 'summary',
  ].sort());
  expect(day).toMatchObject({ mode: 'shadow', briefing: false, unavailable: [], factCount: directFacts.facts.length });
  expect(day.sources.facts).toBe('retro facts --since 24h');
  expect(day.summary[1]).toContain('사실 2 · 반복 주제 1(draft 적체)');
  expect(day.themes).toContainEqual(expect.objectContaining({ theme: 'draft-backlog', recurring: true }));
}, 120_000);

test('graph CLI child collect reads the explicitly selected config universe', () => {
  const root = tmp();
  const configDir = join(root, 'parent-config');
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  const store = new LogStore(join(configDir, 'logs', 'logs.db'));
  store.insertBatch([1, 2].map(number => ({ rec: {
    ts: new Date(Date.now() - number * 1000).toISOString(), category: 'self-implement',
    event: 'rework-blocked-draft-pr', data: { number },
  }, surface: 'test' })));
  store.close();
  const child = spawnSync('bun', [
    'bin/elanous.mjs', `--test=${root}`, 'graph', 'run', RETRO_DAILY_GRAPH, '--json',
    '--input', JSON.stringify({ day: '2026-10-09', greenCells: [] }), '--config-dir', configDir,
  ], { encoding: 'utf8', timeout: 120_000 });
  expect(child.status).toBe(0);
  const run = JSON.parse(child.stdout);
  expect(run.status).toBe('done');
  const report = lastJsonObject(run.nodes.find((node: { nodeId: string }) => node.nodeId === 'report')?.output);
  expect(report?.file).toBe(retroDayFile(configDir, '2026-10-09'));
  const day = JSON.parse(readFileSync(retroDayFile(configDir, '2026-10-09'), 'utf8'));
  expect(day.factCount).toBe(2);
  expect(day.summary[1]).toContain('사실 2 · 반복 주제 1(draft 적체)');
}, 140_000);

test('nonzero retro facts child exit is reported as unmeasurable, not a successful zero', async () => {
  const root = tmp();
  const repo = tmp();
  mkdirSync(join(repo, 'bin'), { recursive: true });
  writeFileSync(join(repo, 'bin', 'elanous.mjs'), `console.error('facts lookup failed'); process.exit(12);`);
  const outputs: Record<string, Record<string, unknown> | null> = {};
  const ctx = () => ({ input: { day: '2026-10-09', greenCells: [] }, outputs });
  for (const stage of ['collect', 'cluster', 'recur', 'insight', 'act', 'report'] as const) {
    outputs[stage] = await runRetroStage(stage, ctx(), root, false, { repo });
  }
  const day = JSON.parse(readFileSync(retroDayFile(root, '2026-10-09'), 'utf8'));
  expect(day.sources.facts).toContain('retro facts failed: facts lookup failed');
  expect(day.summary[1]).toContain('사실 측정 불가 · 반복 주제 측정 불가');
  expect(day.factCount).toBe(0);
  writeFileSync(join(repo, 'bin', 'elanous.mjs'), `process.exit(12);`);
  const emptyStderr = await runRetroStage('collect', { input: { greenCells: [] }, outputs: {} }, root, true, { repo });
  expect((emptyStderr.sources as { facts: string }).facts).toContain('retro facts failed: exit 12');
}, 60_000);

test('real CLI missing store and healthy empty store produce different daily reports', async () => {
  const root = tmp();
  const configDir = join(root, 'parent-config');
  setElanousConfigDir(configDir);
  const run = async (day: string) => {
    const result = await runGraph(RETRO_DAILY_GRAPH, { input: { day, greenCells: [] }, deps: { root } });
    expect(result.status).toBe('done');
    return JSON.parse(readFileSync(retroDayFile(root, day), 'utf8'));
  };
  const missing = await run('2026-10-09');
  expect(missing.factCount).toBe(0);
  expect(missing.unavailable).toEqual(['current']);
  expect(missing.summary[1]).toContain('사실 측정 불가 · 반복 주제 측정 불가');
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  new LogStore(join(configDir, 'logs', 'logs.db')).close();
  const empty = await run('2026-10-10');
  expect(empty.factCount).toBe(0);
  expect(empty.unavailable).toEqual([]);
  expect(empty.summary[1]).toContain('사실 0 · 반복 주제 0(없음)');
}, 120_000);

test('a partially unavailable lookup retains observed facts and recurring topics', async () => {
  const root = tmp();
  const outputs: Record<string, Record<string, unknown> | null> = {};
  const ctx = () => ({ input: { day: '2026-10-09', greenCells: [] }, outputs });
  const readFacts = () => ({ facts: [
    { at: '2026-10-09T01:00:00Z', kind: 'draft-birth' },
    { at: '2026-10-09T02:00:00Z', kind: 'draft-birth' },
  ], unavailable: ['secondary'] });
  for (const stage of ['collect', 'cluster', 'recur', 'insight', 'act', 'report'] as const) {
    outputs[stage] = await runRetroStage(stage, ctx(), root, false, { readFacts });
  }
  const day = JSON.parse(readFileSync(retroDayFile(root, '2026-10-09'), 'utf8'));
  expect(day.unavailable).toEqual(['secondary']);
  expect(day.factCount).toBe(2);
  expect(day.themes).toContainEqual(expect.objectContaining({ theme: 'draft-backlog', recurring: true }));
  expect(day.summary[1]).toContain('사실 2 · 반복 주제 1(draft 적체)');
  expect(day.sources.facts).toBe('retro facts --since 24h');
});

test('empty successful lookup is 0; failed, malformed and unavailable lookups are unmeasurable in the day report', async () => {
  for (const [name, readFacts, expected] of [
    ['empty', () => ({ facts: [], unavailable: [] }), '사실 0'],
    ['failed', () => { throw new Error('lookup failed'); }, '사실 측정 불가'],
    ['malformed', () => ({}), '사실 측정 불가'],
    ['invalid entries', () => ({ facts: [{ kind: 'draft-birth' }] }), '사실 측정 불가'],
    ['unavailable', () => ({ facts: [], unavailable: ['store'] }), '사실 측정 불가'],
  ] as const) {
    const root = tmp();
    const outputs: Record<string, Record<string, unknown> | null> = {};
    const ctx = () => ({ input: { day: '2026-10-09', greenCells: [] }, outputs });
    for (const stage of ['collect', 'cluster', 'recur', 'insight', 'act', 'report'] as const) {
      outputs[stage] = await runRetroStage(stage, ctx(), root, false, { readFacts, now: new Date('2026-10-09T13:40:00Z') });
    }
    const day = JSON.parse(readFileSync(retroDayFile(root, '2026-10-09'), 'utf8'));
    expect(day.factCount).toBe(0);
    expect(day.summary[1]).toContain(expected);
    expect(day.summary[1]).toContain(name === 'empty' ? '반복 주제 0(없음)' : '반복 주제 측정 불가(판정 불가)');
    expect(day.summary[0]).toBe(name === 'empty' ? '회고: 반복 없음' : '회고: 반복 판정 불가');
    expect(day.sources.facts.startsWith('unreadable:')).toBe(name !== 'empty');
    expect(readFileSync(retroDayFile(root, '2026-10-09').replace('.json', '.md'), 'utf8')).toContain(expected);
  }
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
