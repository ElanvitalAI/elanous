// DEMO-1126-INVEST-ORCH: the recorded (--dry-run) run of the invest demo graph completes end to end through the real
// graph runner, with the 15 panel/mentor nodes running in parallel, and the report/dashboard carry the demo contract.
// Expectations are literals (independent of the handlers' own constants).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGraphTemplateYaml } from '../../../src/self-implement/graph-yaml.js';
import { parentRunSources } from '../../../scripts/demo-invest-orch/parent-run-sources.js';
import { graphBindings, parsePanelNote } from '../../../scripts/demo-invest-orch/scene-feed.js';

const root = mkdtempSync(join(tmpdir(), 'invest-orch-'));
const saved = { state: process.env.ELANOUS_STATE_DIR, skills: process.env.INVEST_DEMO_SKILLS_DIR };
type Handlers = typeof import('../../../scripts/demo-invest-orch/handlers.js');
let h: Handlers;
let runGraph: typeof import('../../../src/graph-runner/runner.js').runGraph;
beforeAll(async () => {
  process.env.ELANOUS_STATE_DIR = join(root, 'universe');
  process.env.INVEST_DEMO_SKILLS_DIR = join(root, 'no-skills'); // the panel comes from the committed fixture copy
  h = await import('../../../scripts/demo-invest-orch/handlers.js');
  ({ runGraph } = await import('../../../src/graph-runner/runner.js'));
}, 60_000);
afterAll(() => {
  if (saved.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved.state;
  if (saved.skills === undefined) delete process.env.INVEST_DEMO_SKILLS_DIR; else process.env.INVEST_DEMO_SKILLS_DIR = saved.skills;
  rmSync(root, { recursive: true, force: true });
});

const graphPath = resolve(import.meta.dir, 'invest-orch.yaml');
const PANEL_NODES = ['panel-global-macro', 'panel-us-china-tech-geopol', 'panel-fx-sensitivity', 'panel-korean-flow', 'panel-ai-ethics-sentiment',
  'panel-climate-power', 'panel-memory-cycle', 'panel-hbm-ai', 'panel-cross-asset-rotator', 'panel-dart-fundamentals', 'panel-soxx-flow', 'panel-tsmc-comparative'];

test('graph file parses: 12 panel + 3 mentor branches, runtime split eln 7 · codex 4 · claude 4, joins named', () => {
  const parsed = parseGraphTemplateYaml(readFileSync(graphPath, 'utf8'), 'invest-orch.yaml');
  expect(parsed.errors).toEqual([]);
  const t = parsed.template!;
  expect(t.graphId).toBe('invest-orch-demo');
  const fan = t.edges.find((e) => e.from === 'factsheet')!;
  expect(fan.join).toBe('panel-join');
  expect([...fan.branches!.ok!]).toEqual([...PANEL_NODES, 'mentor-1', 'mentor-2', 'mentor-3']);
  const runtimes = t.nodes.filter((n) => n.recipe === 'handler:panelist').map((n) => (n.input as { runtime: string }).runtime);
  expect(['eln', 'codex', 'claude'].map((r) => runtimes.filter((x) => x === r).length)).toEqual([7, 4, 4]);
  expect(t.nodes.map((n) => n.nodeId)).toContain('consensus');
  expect(t.nodes.map((n) => n.nodeId).filter((id) => id.startsWith('conatus-'))).toEqual(['conatus-research', 'conatus-ops', 'conatus-judge']);
});

test('dry-run (fixtures) completes ≤ 5 min with 15 panel nodes in parallel; report + dashboard carry the contract', async () => {
  const outDir = join(root, 'out');
  const started = Date.now();
  const state = await runGraph(graphPath, { input: { fixtures: true, simDelayMs: 1500, outDir }, quiet: true,
    deps: { root: join(root, 'universe'), inProcessHandlers: h.createInvestDemoHandlers() } });
  const elapsed = Date.now() - started;
  expect(state.status).toBe('done');
  expect(elapsed).toBeLessThan(300_000);
  const fan = state.fanOuts!['factsheet:ok']!;
  const branches = Object.entries(fan.branches);
  expect(branches.length).toBe(15);
  expect(branches.every(([, b]) => b.status === 'done')).toBe(true);
  // Parallel: every branch was running at one common instant (latest start < earliest end).
  const latestStart = Math.max(...branches.map(([, b]) => Date.parse(b.startedAt!)));
  const earliestEnd = Math.min(...branches.map(([, b]) => Date.parse(b.endedAt!)));
  expect(latestStart).toBeLessThan(earliestEnd);
  expect(state.path).toContain('consensus');
  expect(state.path.slice(-4)).toEqual(['conatus-judge', 'decision-triage', 'report', 'done']);

  const report = readFileSync(join(outDir, 'report.md'), 'utf8');
  expect(report.split('\n')[0]).toBe('# 리서치 시연 · 투자 권유 아님');
  expect(report).toContain('집행: 비활성(mandate disarmed)');
  const d = JSON.parse(readFileSync(join(outDir, 'dashboard.json'), 'utf8'));
  expect([d.schema, d.disclaimer, d.question, d.mode]).toEqual(['invest-orch.dashboard/1', '리서치 시연 · 투자 권유 아님', '2027 한국 증시 전망', 'fixtures']);
  expect(d.panel.length).toBe(12);
  expect(d.panel.every((p: { status: string }) => p.status === 'ok')).toBe(true);
  expect(d.mentors.map((m: { name: string }) => m.name)).toEqual(['멘토 A', '멘토 B', '멘토 C']);
  expect(d.mentors.every((m: { verification: unknown[]; scenario: unknown; changeSince1121: unknown }) => m.verification.length >= 4 && m.scenario && m.changeSince1121)).toBe(true);
  expect(d.orchestration.runtimes.map((r: { runtime: string; nodes: string[] }) => [r.runtime, r.nodes.length])).toEqual([['eln', 7], ['codex', 4], ['claude', 4]]);
  expect(d.conatus.judge.execution).toBe('집행: 비활성(mandate disarmed)');
  expect(d.conatus.judge.mandate.armed).toBe(false);
  expect(d.decisionSummary).toMatch(/^결정 대기 \d+건 → 기준 자동 처리 \d+건 · 사람 결정 \d+건$/u);
  expect(d.decisions.length).toBeGreaterThan(0);
  expect(d.decisions.every((x: { mode: string; criterion: string }) => ['auto', 'human'].includes(x.mode) && x.criterion.length > 0)).toBe(true);
  // Private mentor frames never reach the dashboard.
  expect(JSON.stringify(d)).not.toContain('관점:');
  expect(Object.values(d.sources).every((s) => s === 'fixture')).toBe(true);
  // DEMO-SOURCES-VIA-SECRET: every panel prompt carries the source rule and source-tagged factsheet lines.
  const prompts = readdirSync(join(outDir, 'panes')).filter((f) => f.endsWith('.prompt.md')).map((f) => readFileSync(join(outDir, 'panes', f), 'utf8'));
  expect(prompts.length).toBeGreaterThanOrEqual(15);
  expect(prompts.every((t) => t.includes('출처 규칙:') && t.includes('«(페르소나 의견)»') && t.includes('[출처: EODHD (omni-market) · fixture]'))).toBe(true);
}, 120_000);

test('weighted consensus follows the attractiveness-panel formula (literal case)', () => {
  const a = (id: string, action: 'BUY' | 'HOLD' | 'SELL', confidence: number, weight: number, tier: string, divergence = 'align') =>
    ({ id, role: 'panel' as const, label: id, runtime: 'eln' as const, model: 'm', account: 'a', pane: 'p', status: 'ok' as const, durationMs: 1, source: 'fixture', action, confidence, weight, tier, divergence });
  // 0.5·0.8·(+1) + 0.3·0.6·(−1) + 0.2·1.0·0 = 0.4 − 0.18 = 0.22 → HOLD; conf = 0.4 + 0.18 + 0.2 = 0.78 → 78
  const c = h.panelConsensus([a('x', 'BUY', 8, 0.5, 'macro'), a('y', 'SELL', 6, 0.3, 'cycle', 'framework 과열'), a('z', 'HOLD', 10, 0.2, 'macro')], 'HOLD');
  expect([c.score, c.action, c.confidencePct, c.votes, c.divergenceRatePct, c.alignment]).toEqual([0.22, 'HOLD', 78, { BUY: 1, HOLD: 1, SELL: 1 }, 33, 'aligned']);
  // A failed panelist is dropped and the rest renormalise: 0.5/0.8·0.8 = 0.5 → BUY
  const failed = { ...a('y', 'SELL', 6, 0.3, 'cycle'), status: 'failed' as const };
  expect(h.panelConsensus([a('x', 'BUY', 8, 0.5, 'macro'), failed], 'BUY')).toMatchObject({ n: 1, of: 2, score: 0.8, action: 'BUY' });
});

test('mentor hooks judge literal data ✓/✗/?', () => {
  const series = (last: number, chg1m: number | null = 0) => ({ symbol: 's', date: '2026-11-23', last, chg1m, chg3m: 0, high1y: 9385, low1y: 2500 });
  const market = { asOf: '2026-11-23', source: 'fixture', series: { US10Y: series(5.14), DXY: series(103.5), USDKRW: series(1333, 1.2), KOSPI: series(5100), WTI: series(88) } };
  const flows = { source: 'fixture', kospi: { foreign5dMillion: -2_000_000, foreign20dMillion: -9_000_000, inst5dMillion: 100, days: [] }, samsungForeign5dShares: -1 };
  expect(h.verifyMentor(2, market, flows).map((r) => [r.id, r.status])).toEqual([['us10y-below-5', '✗'], ['dxy-below-100', '✗'], ['usdkrw-falling', '✗'], ['foreign-turn', '✗'], ['fomc-hold', '?']]);
  expect(h.verifyMentor(3, market, flows).map((r) => [r.id, r.status])).toEqual([['kospi-floor', '?'], ['us10y-stress', '✓'], ['dxy-104', '✓'], ['wti-below-50', '✗'], ['tga', '?']]);
  expect(h.verifyMentor(1, undefined, flows)[0]!.status).toBe('✓');
});

test('mentor pack parse keeps name + gist + frame (no quotes) and the decision triage line is honest', () => {
  const pack = h.parseMentorPack('## 갑 (설명)\n- 관점: v1\n- 근거: e1\n- 인용: 「비밀」\n- 검증: k1\n\n## 종합\n| 멘토 | 한 줄 | 방향 | 확신 | 검증 |\n|---|---|---|---|---|\n| 갑 | 한 줄 요지 | 강세 | 중 | k |\n');
  expect(pack).toEqual([{ slot: 1, name: '갑', gist: '한 줄 요지', direction: '강세', frame: '관점: v1\n근거: e1\n검증: k1' }]);
  const items = h.triageDecisions({ sources: [{ node: 'news', source: 'fixture-fallback', reason: 'x' }, { node: 'market', source: 'live' }], answers: [], panelOk: 12, panelOf: 12,
    mentorDirections: [{ name: 'A', action: 'BUY' }, { name: 'B', action: 'SELL' }], contradicted: [], mandateArmed: false, fixtures: false });
  expect(items.map((i) => [i.id, i.mode])).toEqual([['source-substitution:news', 'auto'], ['panel-quorum', 'auto'], ['mentor-conflict:1-2', 'human'],
    ['conatus-execution', 'auto'], ['publish-dashboard', 'human'], ['disclaimer', 'auto']]);
});

test('els tab sources: branch child runs are re-addressed to the parent run; child terminals and run-ends are dropped', () => {
  type L = (e: never) => void;
  const fire: { life?: L; prog?: L; end?: L } = {};
  const sources = parentRunSources('invest-orch-demo', 'plan', {
    onLifecycle: (l) => { fire.life = l as L; return () => {}; },
    onProgress: (l) => { fire.prog = l as L; return () => {}; },
    onRunEnd: (l) => { fire.end = l as L; return () => {}; },
  });
  const seen: string[] = [];
  sources.onLifecycle((e) => seen.push(`life ${e.runId} ${e.nodeId} ${e.phase}`));
  sources.onProgress((n) => seen.push(`prog ${n.runId} ${n.nodeId} ${n.progress.note}`));
  sources.onRunEnd((w) => seen.push(`end ${w.runId} ${w.status}`));
  const life = (runId: string, nodeId: string, phase: string, graphId = 'invest-orch-demo') => fire.life!({ graphId, runId, nodeId, phase } as never);
  life('P', 'plan', 'start');
  life('C1', 'panel-hbm-ai', 'start');
  fire.prog!({ graphId: 'invest-orch-demo', runId: 'C1', nodeId: 'panel-hbm-ai', progress: { phase: 'generate', note: 'runtime=codex model=gpt-6.2-sol · HOLD 6/10' } } as never);
  life('C1', 'panel-hbm-ai', 'end');
  life('C1', 'done', 'start');
  fire.end!({ graphId: 'invest-orch-demo', runId: 'C1', status: 'done' } as never);
  life('X', 'cut', 'start', 'release-loop');
  fire.end!({ graphId: 'invest-orch-demo', runId: 'P', status: 'done' } as never);
  expect(seen).toEqual(['life P plan start', 'life P panel-hbm-ai start', 'prog P panel-hbm-ai runtime=codex model=gpt-6.2-sol · HOLD 6/10',
    'life P panel-hbm-ai end', 'life X cut start', 'end P done']);
});

// DEMO-INVEST-ORCH-PIN: the same fixture with --raise-decisions gives the stage count 25 → 24 auto · 1 human every run,
// and no panel row says «default» (fixture mode shows the recorded live model names).
test('pinned rehearsal: 3 fixture runs with raiseDecisions → 25 · 24 auto · 1 human (publish), identical ids, real model names', async () => {
  const runs: Array<{ summary: string; ids: string[]; human: string[]; models: string[] }> = [];
  for (let i = 0; i < 3; i++) {
    const outDir = join(root, `pin-${i}`);
    const state = await runGraph(graphPath, { input: { fixtures: true, raiseDecisions: true, simDelayMs: 10, outDir }, quiet: true,
      deps: { root: join(root, 'universe'), inProcessHandlers: h.createInvestDemoHandlers() } });
    expect(state.status).toBe('done');
    const d = JSON.parse(readFileSync(join(outDir, 'dashboard.json'), 'utf8'));
    runs.push({ summary: d.decisionSummary, ids: d.decisions.map((x: { id: string }) => x.id),
      human: d.decisions.filter((x: { mode: string }) => x.mode === 'human').map((x: { id: string }) => x.id),
      models: [...d.panel, ...d.mentors].map((a: { model: string }) => a.model) });
  }
  expect(runs[0]!.summary).toBe('결정 대기 25건 → 기준 자동 처리 24건 · 사람 결정 1건');
  expect(runs[0]!.human).toEqual(['publish-dashboard']);
  expect(runs[0]!.ids.filter((id) => id.startsWith('answer-accepted:')).length).toBe(15);
  expect(runs[1]).toEqual(runs[0]!);
  expect(runs[2]).toEqual(runs[0]!);
  expect(runs[0]!.models.includes('default')).toBe(false);
  expect(new Set(runs[0]!.models)).toEqual(new Set(['z-ai/glm-4.6', 'deepseek/deepseek-chat-v3.1', 'qwen/qwen3-235b-a22b-2507', 'moonshotai/kimi-k2', 'grok/grok-4.7', 'gpt-6.2-sol', 'haiku']));
}, 120_000);

test('without raiseDecisions a rehearsal publishes nothing by hand: 25 → 25 auto · 0 human', () => {
  const ok = (id: string) => ({ id, role: 'panel' as const, label: id, runtime: 'eln' as const, model: 'm', account: 'a', pane: 'p', status: 'ok' as const, durationMs: 1, source: 'fixture', action: 'HOLD' as const, confidence: 5 });
  const base = { sources: [], answers: [ok('a'), { ...ok('b'), status: 'failed' as const }], panelOk: 1, panelOf: 1, mentorDirections: [], contradicted: [], mandateArmed: false, fixtures: true };
  expect(h.triageDecisions(base).map((i) => [i.id, i.mode])).toEqual([['answer-accepted:a', 'auto'], ['panelist-failed:b', 'auto'], ['panel-quorum', 'auto'],
    ['conatus-execution', 'auto'], ['publish-dashboard', 'auto'], ['disclaimer', 'auto']]);
  expect(h.triageDecisions({ ...base, raiseDecisions: true }).find((i) => i.id === 'publish-dashboard')!.mode).toBe('human');
});

test('scene feed reads the panelist note: runtime · model · verdict (and «failed» as no answer)', () => {
  expect(parsePanelNote('runtime=codex model=gpt-6.2-sol · BUY 7/10 · 메모리 · view')).toEqual({ runtime: 'codex', model: 'gpt-6.2-sol', verdict: 'BUY 7/10' });
  expect(parsePanelNote('runtime=eln model=z-ai/glm-4.6 · failed · 라벨')).toEqual({ runtime: 'eln', model: 'z-ai/glm-4.6', verdict: 'no answer' });
  expect(parsePanelNote('plan · fixtures')).toEqual({});
  const b = graphBindings(graphPath);
  expect([b.get('panel-hbm-ai'), b.get('panel-korean-flow'), b.get('plan')]).toEqual([{ runtime: 'codex' }, { runtime: 'eln', model: 'moonshotai/kimi-k2' }, {}]);
});
