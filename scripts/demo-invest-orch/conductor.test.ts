import { tierModel } from '../../src/llm/model-defaults.js';
// Stage feed — literal expectations (rule 11): real board events in, els stage snapshots out.
import { expect, test } from 'bun:test';
import { stageFeed } from './conductor.js';

test('stage feed walks prompt → spawn → votes → spotlight → verdict → receipt from board events', () => {
  const out: Array<Record<string, unknown>> = [];
  const feed = stageFeed((e) => out.push(e), { board: 'pBOARD', byTitle: (n) => (n === 'Jang' ? 'pJANG' : undefined) });
  feed({ t: 0, kind: 'run', phase: 'start' });
  feed({ t: 10, kind: 'tab', id: 'news', title: 'INV·News · omni-crawl' });
  feed({ t: 20, kind: 'node', id: 'mentor-3', phase: 'start' });
  feed({ t: 30, kind: 'note', id: 'mentor-3', model: tierModel('balanced', 'openai-codex'), verdict: 'HOLD 4/10' });
  feed({ t: 35, kind: 'call', id: 'news', tool: 'omni-crawl', n: 4, ok: true, items: 12, startT: 0, endT: 35, live: true });
  feed({ t: 38, kind: 'market', market: { kospi: { last: 5006.03 } } });
  feed({ t: 40, kind: 'evidence', source: 'news', title: 'a', url: 'https://a.example/x' });
  feed({ t: 50, kind: 'result', result: { action: 'HOLD', thesis: '', bull: [], bear: [], confidence: 0.58, numbers: [], sources: [], consensus: { score: 0, action: 'HOLD', confidencePct: 58, answered: 12, of: 12 },
    risk: { expert: 'Jang Woo-jin (per CEO) · Risk', pending: false, verdict: 'HOLD SIZE', maxPositionPct: null }, ko: { thesis: '', bull: [], bear: [], divergences: [], riskExpert: '장우진' } } });
  feed({ t: 201000, kind: 'run', phase: 'end', status: 'done' });
  expect(out.map((o) => o.phase)).toEqual(['prompt', 'spawn', 'spawn', 'votes', 'spotlight', 'verdict', 'receipt']);
  expect(out[4]).toMatchObject({ spotlightPane: 'pJANG', spotlightMs: 3000, spotlightCaption: '장우진 · 리스크 / 비중 유지 · KOSPI 5,006' });
  // the caption and the board's Risk box read the same field: REDUCE renders «비중 축소» in both
  const out2: Array<Record<string, unknown>> = [];
  const f2 = stageFeed((e) => out2.push(e), {});
  const posPct = 25;
  f2({ t: 0, kind: 'run', phase: 'start' });
  f2({ t: 5, kind: 'result', result: { action: 'HOLD', thesis: '', bull: [], bear: [], confidence: 0.5, numbers: [], sources: [], risk: { expert: 'x', pending: false, verdict: 'REDUCE', maxPositionPct: posPct } } });
  expect(out2.find((o) => o.phase === 'spotlight')!.spotlightCaption).toBe('장우진 · 리스크 / 비중 축소 · 최대 비중 25%');
  expect(out[6]!.counters).toEqual({ toolCalls: 4, cited: 1, agents: 1, models: 1, elapsedMs: 201000 });
  expect(out[5]).toMatchObject({ consensus: { label: '보유', value: 0 }, verdictPane: 'pBOARD' });
  expect(out[6]!.receipt).toBe('1 agents · 1 models · 201s · 1 sources');
  expect(out[3]!.votes).toEqual([{ id: 'mentor-3', vote: 'HOLD 4/10' }]);
});
