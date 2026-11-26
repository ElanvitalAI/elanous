// Invest Research Board — expectations are hand-written literals (rule 11), never built from the product's constants.
import { describe, expect, test } from 'bun:test';
import { boardResultFromDashboard, reduceInvestBoard, renderInvestBoard, type BoardEvent, type BoardMeta } from './invest-board.js';
import { loadPin, pinDurationMs, pinFrame, variantPin } from './invest-board-pin.js';
import { drawInvestBoard } from './invest-board-view.js';

const meta: BoardMeta = { ticker: '005930.KS', name: 'Samsung Electronics', question: 'What is the 2027 outlook?', mode: 'replay',
  nodes: [{ id: 'plan' }, { id: 'news' }, { id: 'x-pulse' }, { id: 'market' }, { id: 'panel-hbm-ai', runtime: 'codex' }, { id: 'mentor-1', runtime: 'claude', model: 'haiku' }, { id: 'report' }] };
const ev: BoardEvent[] = [
  { t: 0, kind: 'run', phase: 'start' },
  { t: 0, kind: 'node', id: 'plan', phase: 'start' }, { t: 100, kind: 'node', id: 'plan', phase: 'end', outcome: 'ok' },
  { t: 100, kind: 'node', id: 'news', phase: 'start' }, { t: 100, kind: 'node', id: 'x-pulse', phase: 'start' },
  { t: 900, kind: 'node', id: 'news', phase: 'end', outcome: 'ok' },
  { t: 900, kind: 'evidence', source: 'news', title: 'Memory prices rise', url: 'https://www.example.com/a/b' },
  { t: 1500, kind: 'node', id: 'x-pulse', phase: 'end', outcome: 'fail' },
  { t: 1600, kind: 'node', id: 'panel-hbm-ai', phase: 'start' },
  { t: 2600, kind: 'note', id: 'panel-hbm-ai', verdict: 'BUY 7/10' },
  { t: 2600, kind: 'node', id: 'panel-hbm-ai', phase: 'end', outcome: 'ok' },
];
const widest = (lines: string[]) => Math.max(...lines.map((l) => Bun.stringWidth(l)));

describe('invest board reduce', () => {
  test('nothing after t is applied', () => {
    const s = reduceInvestBoard(meta, ev, 950);
    expect(s.status).toBe('running');
    expect(s.nodes.get('news')?.state).toBe('done');
    expect(s.nodes.get('x-pulse')?.state).toBe('running');
    expect(s.evidence.length).toBe(1);
  });
  test('failed node and verdict', () => {
    const s = reduceInvestBoard(meta, ev, 5000);
    expect(s.nodes.get('x-pulse')?.state).toBe('failed');
    expect(s.nodes.get('panel-hbm-ai')?.verdict).toBe('BUY 7/10');
  });
  test('same events → same frame (deterministic)', () => {
    expect(renderInvestBoard(reduceInvestBoard(meta, ev, 1234), 80, 24)).toEqual(renderInvestBoard(reduceInvestBoard(meta, ev, 1234), 80, 24));
  });
});

describe('invest board render', () => {
  test('80×24 mid-run literal rows', () => {
    const [w, h] = [80, 24] as const;
    const lines = renderInvestBoard(reduceInvestBoard(meta, ev, 2000), w, h);
    expect(lines[0]).toBe(' ◆ Invest Research  Samsung Electronics                                  ● LIVE');
    expect(lines[1]).toBe(' Q  What is the 2027 outlook?');
    expect(lines.some((l) => l.includes('├─ ✗ X / social    apify · grok-x'))).toBe(true);
    expect(lines.some((l) => l.includes(' NEWS  Memory prices rise — example.com'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(h);
    expect(widest(lines)).toBeLessThanOrEqual(w);
  });
  test('empty evidence says so', () => {
    const lines = renderInvestBoard(reduceInvestBoard(meta, ev.filter((e) => e.kind !== 'evidence'), 2000), 160, 50);
    expect(lines.some((l) => l.includes('No sources yet — collectors are running'))).toBe(true);
  });
  test('fresh evidence slides in, then sits still', () => {
    const at = (t: number) => renderInvestBoard(reduceInvestBoard(meta, ev, t), 160, 50).find((l) => l.includes('Memory prices rise')) ?? '';
    expect(at(900).includes('│  NEWS  Memory')).toBe(false);
    expect(at(1950).includes('│  NEWS  Memory prices rise — example.com')).toBe(true);
  });
  test('160×50 and 200×60 fill the frame exactly', () => {
    for (const [w, h] of [[160, 50], [200, 60], [140, 50]] as const) {
      const lines = renderInvestBoard(reduceInvestBoard(meta, ev, 2000), w, h);
      expect(lines.length).toBe(h);
      expect(widest(lines)).toBeLessThanOrEqual(w);
    }
  });
});

describe('dashboard → card (English, structured fields only)', () => {
  test('literal bull / bear / numbers', () => {
    const r = boardResultFromDashboard({
      consensus: { panel: { action: 'HOLD', score: 0.06, n: 12, of: 12, confidencePct: 56, votes: { BUY: 1, HOLD: 11, SELL: 0 } }, mentors: { action: 'HOLD', score: 0 }, overall: { action: 'HOLD', score: 0.04 } },
      panel: [{ id: 'panel-dart-fundamentals', status: 'ok', action: 'BUY', confidence: 6 }],
      framework: { total: 55.56, signal: 'HOLD', tiers: { valuation: { score: 75.94 }, macro: { score: 50 } } },
      market: { KOSPI: { last: 5046.37, chg3m: -25.16 }, USDKRW: { last: 1343.2, chg1m: 0.5 }, US10Y: { last: 4.929 } },
      flows: { foreign20dMillion: -14197220 },
      events: [{ title: 'Headline', url: 'https://biz.example.com/x' }],
    });
    expect(r.action).toBe('HOLD');
    expect(r.bull).toEqual(['BUY from Fundamentals', 'Valuation tier 76/100']);
    expect(r.bear).toEqual(['KOSPI −25.2% over 3 months', 'Foreign investors net sold ₩14.2T in 20 days']);
    expect(r.confidence).toBe(0.56);
    expect(r.numbers).toEqual([{ label: 'KOSPI', value: '5,046' }, { label: 'USD/KRW', value: '1,343' }, { label: 'US10Y', value: '4.93%' }, { label: 'Framework', value: '56/100' }, { label: 'Votes', value: '1/11/0' }]);
  });
});

describe('pinned run sim — seeds ≥ 3, every frame fits', () => {
  const pin = loadPin();
  const variants = ['slow-child', 'failed-child', 'empty-evidence', 'long-name'] as const;
  for (const seed of [1, 2, 3]) for (const v of variants) {
    test(`${v} seed ${seed}: 120×36 and 80×24 never overflow; end card keeps the disclaimer`, () => {
      const p = variantPin(pin, v, seed);
      const end = pinDurationMs(p) + 1500;
      for (let t = 0; t <= end; t += Math.max(250, Math.floor(end / 60))) {
        for (const [w, h] of [[160, 50], [140, 50], [200, 60], [120, 36], [80, 24]] as const) {
          const f = pinFrame(p, t, w, h);
          expect(f.length).toBeLessThanOrEqual(h);
          expect(widest(f)).toBeLessThanOrEqual(w);
        }
      }
      for (const [w, h] of [[120, 36], [80, 24]] as const) expect(pinFrame(p, end, w, h).join('\n')).toContain('투자 권유가 아니며');
    });
  }
  test('failed child shows ✗ on X / social at the end', () => {
    expect(pinFrame(variantPin(pin, 'failed-child', 1), pinDurationMs(pin) + 1500, 80, 24).some((l) => l.includes('✗ X / social'))).toBe(true);
  });
  test('slow child: X / social still running when the others are done', () => {
    const p = variantPin(pin, 'slow-child', 1);
    const xEnd = p.events.find((e) => e.kind === 'node' && e.id === 'x-pulse' && e.phase === 'end')!.t;
    expect(pinFrame(p, xEnd - 1000, 80, 24).some((l) => l.includes('● X / social'))).toBe(true);
  });
  test('replay is deterministic across 3 reads', () => {
    const a = pinFrame(loadPin(), 3000, 120, 36), b = pinFrame(loadPin(), 3000, 120, 36), c = pinFrame(loadPin(), 3000, 120, 36);
    expect(a).toEqual(b); expect(b).toEqual(c);
  });
});

describe('invest board — CJK · emoji · ellipsis never break the frame', () => {
  const cjk: BoardEvent[] = [
    ...ev,
    { t: 2700, kind: 'evidence', source: 'x-pulse', title: '🚨 코스피 급락 🇰🇷 삼성전자·SK하이닉스 — 외국인 매도 지속… ▼5.5% ₩17.4T', url: 'https://x.com/a/status/1' },
    { t: 2800, kind: 'evidence', source: 'news', title: '못믿을 증권사들…"하이닉스 350만 간다더니 200만원으로 뚝" [분석+]', url: 'https://www.hankyung.com/article/1' },
    { t: 2900, kind: 'market', market: { kospi: { last: 5006, chg1m: -9.8, chg3m: -25.8 }, foreignDaily: [-1, 2, -3], foreign20dMillion: -17351955 } },
    { t: 3000, kind: 'result', result: { action: 'HOLD', thesis: '보유 — 외국인 수급 전환 확인 전까지 · ▲▼ ₩ …', bull: ['밸류에이션 76/100 · 저평가'], bear: ['외국인 20일 −₩17.4T 🚨'], confidence: 0.53, numbers: [],
      sources: [{ label: '🚨 코스피 9000 찍고 4000선 후퇴…', url: 'https://www.pinpointnews.co.kr/x' }], risk: { expert: 'Jang Woo-jin (per CEO) · Risk', pending: false, verdict: 'REDUCE', maxPositionPct: 25, stop: '4,600–4,800 · 4,300대 · ≈3,200', hedge: '현금 확보 · 1분기 대기' } } },
  ];
  for (const [w, h] of [[140, 50], [160, 50], [200, 60], [120, 36], [80, 24]] as const) {
    test(`${w}×${h}: every row is exactly ${w} cells and every right border sits in its box column`, () => {
      const c = drawInvestBoard(reduceInvestBoard(meta, cjk, 3500), w, h);
      const rows = c.cells.map((row) => row.filter((x) => !x.skip).map((x) => x.ch).join(''));
      expect(rows.length).toBe(h);
      for (const r of rows) expect(Bun.stringWidth(r)).toBe(w);
      // a box's right border: every «│» that closes a row sits at the same column as its «╮» above
      const col = (r: string, i: number) => Bun.stringWidth([...r].slice(0, i).join(''));
      for (let y = 0; y < rows.length; y++) {
        const chars = [...rows[y]!];
        chars.forEach((ch, i) => {
          if (ch !== '╮') return;
          const x = col(rows[y]!, i);
          for (let yy = y + 1; yy < rows.length; yy++) {
            const cs = [...rows[yy]!]; let at = -1; let acc = 0;
            for (const k of cs) { if (acc === x) { at = 1; expect(['│', '╯']).toContain(k); break; } acc += Bun.stringWidth(k); }
            expect(at).toBe(1);
            if ([...rows[yy]!].some((k, j) => k === '╯' && col(rows[yy]!, j) === x)) break;
          }
        });
      }
    });
  }
});
