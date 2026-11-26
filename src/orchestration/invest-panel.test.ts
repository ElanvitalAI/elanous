// INVEST-PANEL-NL — parse («<회사> <연도> 전망 전문가 패널로 분석해줘» with/without /orch, /invest), preset selection in the
// Orchestrate tool before any orchestration/v1 template, the argv of the live board, and the 최종 결론 read from the pin.
// Expected values are literals (rule 11), not built from the module's tables.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { investBoardArgv, investConclusion, parseInvestPanelGoal } from './invest-panel.js';
import { dispatchOrchestrate } from './tool.js';

describe('parseInvestPanelGoal', () => {
  test.each([
    ['삼성전자 2027 전망 전문가 패널로 분석해줘', '005930.KS', '2027'],
    ['/orch 삼성전자 2027 전망 전문가 패널로 분석해줘', '005930.KS', '2027'],
    ['SK하이닉스 2027년 전망 전문가 패널로 분석해줘', '000660.KS', '2027'],
    ['sk 하이닉스 내년 전망 전문가 패널로 분석해줘', '000660.KS', undefined],
    ['현대차 2026 전망 전문가 패널로 분석해줘', '005380.KS', '2026'],
    ['네이버 2027 전망 전문가 패널로 분석해줘', '035420.KS', '2027'],
    ['NAVER 2027 전망 전문가 패널로 분석해줘', '035420.KS', '2027'],
    ['카카오 2027 전망 전문가 패널로 분석해줘', '035720.KS', '2027'],
    ['/invest 카카오', '035720.KS', undefined],
    ['/invest 카카오 2027 사도 될까?', '035720.KS', '2027'],
    ['068270 2027 전망 전문가 패널로 분석해줘', '068270.KS', '2027'],
    ['NVDA 2027 outlook expert panel analysis', 'NVDA', '2027'],
    ['셀트리온 2027 전망 전문가 패널로 분석해줘', '셀트리온', '2027'],
  ])('%s → %s', (text, ticker, year) => {
    const g = parseInvestPanelGoal(text);
    expect(g?.ticker).toBe(ticker);
    expect(g?.year).toBe(year);
    expect(g?.question.startsWith('/')).toBe(false);
  });

  test('the question is the person\'s own words without the slash', () => {
    expect(parseInvestPanelGoal('/orch 삼성전자 2027 전망 전문가 패널로 분석해줘')?.question).toBe('삼성전자 2027 전망 전문가 패널로 분석해줘');
    expect(parseInvestPanelGoal('SK하이닉스 2027 전망 전문가 패널로 분석해줘')?.company).toBe('SK하이닉스');
  });

  test.each([
    'Compare 3 note-taking apps and recommend one',
    '삼성전자 2027 전망 알려줘',
    '시장 브리핑 만들어줘',
    '계약서 검토해줘',
    '/invest',
  ])('not an invest-panel request: %s', (text) => {
    expect(parseInvestPanelGoal(text)).toBeUndefined();
  });
});

describe('investBoardArgv', () => {
  test('live board with child tabs, closed at the end, recorded', () => {
    const g = parseInvestPanelGoal('SK하이닉스 2027 전망 전문가 패널로 분석해줘')!;
    expect(investBoardArgv(g, '/r/pin.json')).toEqual(['demo', 'invest', 'board', '--ticker', '000660.KS', '--question', 'SK하이닉스 2027 전망 전문가 패널로 분석해줘', '--els', '--close-tabs', '--record', '/r/pin.json']);
  });
});

describe('investConclusion', () => {
  test('running → undefined · ended with result → 최종 결론 text · ended without → says so', () => {
    expect(investConclusion(JSON.stringify({ events: [{ kind: 'run', phase: 'start' }] }))).toBeUndefined();
    expect(investConclusion('not json')).toBeUndefined();
    const done = investConclusion(JSON.stringify({ events: [
      { kind: 'run', phase: 'start' },
      { kind: 'result', result: { action: 'HOLD', thesis: 'Memory upcycle priced in.', confidence: 0.62, consensus: { action: 'HOLD', score: 0.08, confidencePct: 61, answered: 14, of: 15 }, bull: ['BUY from Vincent'], bear: ['SELL from FX'], sources: [{ label: 'DART', url: 'https://dart.fss.or.kr/x' }] } },
      { kind: 'run', phase: 'end', status: 'done' },
    ] }))!;
    expect(done.status).toBe('done');
    expect(done.text).toContain('최종 결론: HOLD · confidence 62%');
    expect(done.text).toContain('Panel consensus: HOLD (score 0.08 · 14/15 answered · 61%)');
    expect(done.text).toContain('출처: DART https://dart.fss.or.kr/x');
    const empty = investConclusion(JSON.stringify({ events: [{ kind: 'run', phase: 'end', status: 'failed' }] }))!;
    expect(empty).toEqual({ status: 'failed', text: 'The run ended without a conclusion (no report).' });
  });
});

describe('Orchestrate tool · invest-panel preset', () => {
  test('plan picks invest-panel (no model call) → run spawns the live board → status reports 최종 결론', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-invest-'));
    try {
      const env = { ELANOUS_STATE_DIR: dir, ELANOUS_ELS_SOCKET: '/tmp/x.sock', PATH: process.env.PATH };
      const plan = await dispatchOrchestrate({ action: 'plan', goal: '/orch 삼성전자 2027 전망 전문가 패널로 분석해줘' }, { env, llm: async () => { throw new Error('model must not be asked'); } });
      expect(plan.ok).toBe(true);
      expect(plan.preset).toBe('invest-panel');
      expect(plan.ticker).toBe('005930.KS');
      expect(String(plan.file).endsWith('.invest.json')).toBe(true);
      const spawned: Array<{ argv: string[]; inEls: boolean }> = [];
      const run = await dispatchOrchestrate({ action: 'run', file: plan.file }, { env, spawnInvest: (argv, o) => spawned.push({ argv, inEls: o.inEls }) });
      expect(run.ok).toBe(true);
      expect(run.backend).toBe('els');
      expect(spawned[0]!.inEls).toBe(true);
      expect(spawned[0]!.argv.slice(0, 5)).toEqual(['demo', 'invest', 'board', '--ticker', '005930.KS']);
      expect(spawned[0]!.argv).toContain('--els');
      expect(spawned[0]!.argv).toContain('--close-tabs');
      const pin = spawned[0]!.argv.at(-1)!;
      const running = await dispatchOrchestrate({ action: 'status', runId: run.runId }, { env });
      expect(running.done).toBe(false);
      writeFileSync(pin, JSON.stringify({ events: [{ kind: 'result', result: { action: 'BUY', thesis: 'HBM share gains.' } }, { kind: 'run', phase: 'end', status: 'done' }] }));
      const done = await dispatchOrchestrate({ action: 'status', runId: run.runId }, { env });
      expect(done.done).toBe(true);
      expect(String(done.conclusion)).toContain('최종 결론: BUY');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a non-OP seat runs the board headless', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-invest-'));
    try {
      const env = { ELANOUS_STATE_DIR: dir, ELANOUS_ELS_SOCKET: '/tmp/x.sock', ELANOUS_SEAT: 'TC', PATH: process.env.PATH };
      const plan = await dispatchOrchestrate({ action: 'plan', goal: '카카오 2027 전망 전문가 패널로 분석해줘' }, { env });
      const spawned: boolean[] = [];
      const run = await dispatchOrchestrate({ action: 'run', file: plan.file }, { env, spawnInvest: (_a, o) => spawned.push(o.inEls) });
      expect(run.backend).toBe('headless');
      expect(spawned).toEqual([false]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('other goals still plan as orchestration/v1 (market brief preset unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-invest-'));
    try {
      const plan = await dispatchOrchestrate({ action: 'plan', goal: '내일 시장 브리핑 만들어줘' }, { env: { ELANOUS_STATE_DIR: dir, PATH: process.env.PATH } });
      expect(plan.preset).toBeUndefined();
      expect(plan.pattern).toBe('map-reduce');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
