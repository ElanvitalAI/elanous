// DEMO-INVEST-SCENE-WIRE — dashboard.json (invest-orch.dashboard/1) → the scene: rows per panel node with the real
// runtime · model, six steps, the end card with evidence and «Not investment advice». Literal strings (rule 11).
import { expect, test } from 'bun:test';
import { fromInvestRun, investRunLive, panelName, shortModel } from './invest-run.js';
import { renderInvestResearchFrame } from './invest-research.js';

const DASH = {
  schema: 'invest-orch.dashboard/1', ticker: '005930.KO', mode: 'fixtures', durationMs: 5300,
  sources: { 'conatus-research': 'fixture', 'conatus-ops': 'fixture', market: 'fixture', flows: 'fixture', score: 'fixture', news: 'fixture', 'x-pulse': 'fixture', 'event-shock': 'fixture' },
  panel: [
    { id: 'panel-hbm-ai', runtime: 'codex', model: 'gpt-6.2-sol', status: 'ok', action: 'BUY', confidence: 7, durationMs: 3000 },
    { id: 'panel-fx-sensitivity', runtime: 'eln', model: 'openrouter/qwen/qwen3-235b-a22b-2507', status: 'failed', durationMs: 4000 },
  ],
  mentors: [{ id: 'mentor-1', runtime: 'claude', model: 'haiku', status: 'ok', action: 'HOLD', confidence: 5, durationMs: 2000 }],
  consensus: { panel: { score: 0.7, action: 'BUY', n: 1, of: 2, votes: { BUY: 1, HOLD: 0, SELL: 0 } }, mentors: { score: 0, action: 'HOLD' }, overall: { score: 0.35, action: 'HOLD' } },
  framework: { total: 55.56, signal: 'HOLD' },
  decisions: [{ id: 'a', mode: 'auto' }, { id: 'b', mode: 'auto' }, { id: 'c', mode: 'human' }],
  events: [{ title: 'Board reinstates CEO', url: 'https://www.example.com/a/b' }, { title: 'Stock jumps', url: 'https://news.example.org/x' }, { title: 'Third', url: 'https://c.example' }],
};

test('names and models: persona stage names, provider prefix dropped, «default» is unknown', () => {
  expect([panelName('panel-hbm-ai'), panelName('panel-new-fx-angle'), panelName('mentor-2')]).toEqual(['HBM / AI', 'New FX angle', 'Mentor 2']);
  expect([shortModel('openrouter/z-ai/glm-4.6'), shortModel('default'), shortModel(undefined), shortModel('haiku')]).toEqual(['glm-4.6', undefined, undefined, 'haiku']);
});

test('end card from dashboard.json at 80 columns (the whole scene fits 40 rows)', () => {
  expect(renderInvestResearchFrame(fromInvestRun(DASH), 80, 40)).toEqual([
    'Investment research · 005930.KO · 3 agents across eln, codex and claude',
    '✓ Graph run · elanous graph runner — 3 agents · 2 done · 1 failed',
    '├─ ✓ HBM / AI  codex gpt-6.2-sol   ██████████ 100%     3s  BUY 7/10',
    '├─ ✗ FX        eln qwen3-235b-a2…  ░░░░░░░░░░    —     4s  no answer',
    '└─ ✓ Mentor 1  claude haiku        ██████████ 100%     2s  HOLD 5/10',
    '',
    '✓ Plan · recorded data (rehearsal)',
    '✓ Data · 8 of 8 sources · 8 recorded',
    '✓ Panel · 2 of 3 answered in parallel',
    '✓ Consensus · HOLD (0.35)',
    '✓ Decisions · 3 → 2 auto · 1 for you',
    '✓ Report · 5.3s',
    '',
    '╭─ 005930.KO · consensus HOLD ─────────────────────────────────────────────────╮',
    '│ Panel BUY (0.7) × mentors HOLD (0) → HOLD (0.35)                             │',
    '│                                                                              │',
    '│ Panel                                                                        │',
    '│   1 of 2 panelists answered · BUY 1 · HOLD 0 · SELL 0                        │',
    '│   Framework score 55.56/100 · HOLD                                           │',
    '│                                                                              │',
    '│ Decisions                                                                    │',
    '│   3 → 2 auto · 1 for you · no order placed                                   │',
    '│                                                                              │',
    '│ Evidence                                                                     │',
    '│   [1] Board reinstates CEO — example.com                                     │',
    '│   [2] Stock jumps — news.example.org                                         │',
    '│                                                                              │',
    '│ Research demo. Not investment advice. No order is placed.                    │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ]);
});

test('80×24 and 40×12: never taller or wider; the disclaimer and bottom border survive', () => {
  for (const [w, h] of [[80, 24], [80, 20], [40, 12], [120, 36]] as const) {
    const lines = renderInvestResearchFrame(fromInvestRun(DASH), w, h);
    expect(lines.length).toBeLessThanOrEqual(h);
    expect(Math.max(...lines.map((l) => Bun.stringWidth(l)))).toBeLessThanOrEqual(w);
    expect(lines.at(-1)!.startsWith('╰')).toBe(true);
    expect(lines.join(' ').replace(/[│\s]+/gu, ' ')).toContain('Not investment advice. No order is placed.');
  }
});

test('live: waiting rows from the start, running row shows its model, steps follow node states', () => {
  const m = investRunLive({ ticker: 'T', nowMs: 5000, nodes: [
    { id: 'plan', state: 'done' }, { id: 'news', state: 'done' }, { id: 'market', state: 'running' },
    { id: 'panel-hbm-ai', state: 'running', runtime: 'codex', model: 'gpt-6.2-sol', startedAt: 1000 }, { id: 'mentor-3', state: 'waiting', runtime: 'eln' },
  ] });
  expect(renderInvestResearchFrame(m, 80, 24)).toEqual([
    'Investment research · T · 2 agents across eln, codex and claude',
    '● Graph run · elanous graph runner — 2 agents · 1 running · 1 waiting',
    '├─ ● HBM / AI  codex gpt-6.2-sol  ░░░░░░░░░░    —     4s',
    '└─ ◌ Mentor 3  eln                ░░░░░░░░░░    —     0s',
    '',
    '✓ Plan',
    '▸ Data · 1 of 8 sources in parallel',
    '▸ Panel · 0 of 2 answered in parallel',
    '○ Consensus',
    '○ Decisions',
    '○ Report',
  ]);
});

test('demo P0 11-25: every agent failed → the parent row is ✗, never «✓ Graph run»', () => {
  const failed = { ...DASH, panel: DASH.panel.map((a) => ({ ...a, status: 'failed' })), mentors: DASH.mentors.map((a) => ({ ...a, status: 'failed' })) };
  const frame = renderInvestResearchFrame(fromInvestRun(failed), 80, 40);
  expect(frame[1]).toBe('✗ Graph run · elanous graph runner — 3 agents · 3 failed');
  const live = investRunLive({ ticker: '005930.KO', nowMs: 10, nodes: [
    { id: 'report', state: 'done' }, { id: 'panel-hbm-ai', state: 'failed' }, { id: 'mentor-1', state: 'failed' }] });
  expect(live.fanout.parent.state).toBe('failed');
});
