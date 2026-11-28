// kit/fleet-audit — pure judgment with literal expectations (OPS-RULES 11: numbers below are independent literals, not the kit's).
import { expect, test } from 'bun:test';
import { withListed, healPlan, judgeFleet, redStep, emptyAuditMemory, noteRung, summaryLines, ledgerTable, type FleetPolicy, type FleetReading } from './index.js';

const P: FleetPolicy = { windowMin: 60, staleTickMin: 45, staleCadenceX: 2, watchOnlyBreachMin: 120, falseGreenUnactedMin: 3, rungWaitMin: 60, healMaxPerTick: 3, redWatchOnlyMin: 2, redAfterMin: 180,
  partial: 0.5, summaryLinesMax: 6, weights: { outcome: 30, response: 20, proactive: 15, robust: 15, judgment: 10, sustain: 10 } };
const NOW = new Date('2026-11-28T08:00:00Z');
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const base = (id: string, o: Partial<FleetReading> = {}): FleetReading => ({ id, l0: 'TC', trigger: null, cadenceMin: 15, level: 'live', tickAt: ago(5), tickError: null, kpiState: 'ok', kpi: 0, breachSince: null,
  acted: 1, failed: 0, refused: 0, topRefusal: null, escalated: false, lessons: 1, ...o });

test('flags: tick-stale · watch-only · false-green · kpi-missing · healthy', () => {
  const v = judgeFleet([
    base('a'), base('stale', { tickAt: ago(46) }), base('watch', { kpiState: 'breach', breachSince: ago(120), acted: 0, refused: 2 }),
    base('acting', { kpiState: 'breach', breachSince: ago(200), acted: 1 }), base('young', { kpiState: 'breach', breachSince: ago(119), acted: 0 }),
    base('err', { tickError: 'boom' }), base('idle', { acted: 0, refused: 3 }), base('none', { kpiState: 'missing' }),
  ], P, NOW);
  expect(v.map(x => [x.id, x.flags])).toEqual([['a', []], ['stale', ['tick-stale', 'false-green']], ['watch', ['watch-only']], ['acting', []], ['young', []],
    ['err', ['false-green']], ['idle', ['false-green']], ['none', ['kpi-missing']]]);
  expect(v.map(x => x.score.total)).toEqual([100, 85, 40, 75, 68, 93, 75, 85]);
});

test('a slow agent is stale only past 2× its own cadence · a level-off agent is never flagged', () => {
  const v = judgeFleet([base('daily', { cadenceMin: 1440, tickAt: ago(600) }), base('daily-dead', { cadenceMin: 1440, tickAt: ago(2881) }),
    base('off', { level: 'off', tickAt: ago(600), kpiState: 'breach', breachSince: ago(600), acted: 0 })], P, NOW);
  expect(v.map(x => [x.id, x.flags])).toEqual([['daily', []], ['daily-dead', ['tick-stale', 'false-green']], ['off', []]]);
});

test('ladder: refire → owner card → ✋, one rung per episode, rung_wait_min apart, cap per tick', () => {
  const m = emptyAuditMemory();
  const v = judgeFleet([base('s', { tickAt: ago(60), trigger: 's-agent' }), base('w', { kpiState: 'breach', breachSince: ago(130), acted: 0 })], P, NOW);
  const s1 = healPlan(v, m, P, NOW);
  expect(s1.map(s => `${s.action}:${s.target}`)).toEqual(['owner-card:w', 'refire:s']);
  for (const s of s1) noteRung(m, s, NOW);
  expect(healPlan(v, m, P, new Date(NOW.getTime() + 59 * 60_000)).map(s => s.action)).toEqual([]);
  expect(healPlan(v, m, P, new Date(NOW.getTime() + 60 * 60_000)).map(s => `${s.action}:${s.target}`)).toEqual(['l0-hand:w', 'owner-card:s']);
  expect(healPlan(v, m, { ...P, healMaxPerTick: 1 }, new Date(NOW.getTime() + 60 * 60_000)).length).toBe(1);
  // the episode ended (healthy again) → the ladder forgets it
  healPlan(judgeFleet([base('s'), base('w')], P, NOW), m, P, NOW);
  expect(Object.keys(m.ladder)).toEqual([]);
});

test('red: ≥2 watch-only for ≥180 min → due once per episode', () => {
  const m = emptyAuditMemory();
  expect(redStep(m, 2, P, NOW)).toEqual({ red: false, due: false, sinceMin: 0 });
  const later = new Date(NOW.getTime() + 180 * 60_000);
  expect(redStep(m, 2, P, later)).toEqual({ red: true, due: true, sinceMin: 180 });
  m.redNotified = m.redSince;
  expect(redStep(m, 3, P, later).due).toBe(false);
  expect(redStep(m, 1, P, later)).toEqual({ red: false, due: false, sinceMin: null });
  expect(m.redSince).toBe(null);
});

test('ledger and summary text', () => {
  const v = judgeFleet([base('a'), base('w', { kpiState: 'breach', breachSince: ago(130), acted: 0, refused: 3, topRefusal: 'open-cell: 권한 밖 ×3' })], P, NOW);
  expect(ledgerTable(v, { a: 90 }, '2026-11-28T08:00:00.000Z').split('\n').slice(4)).toEqual([
    '| a | 5분 | 충족 | 1/0/0 | 1 | 100 ↑10 | 정상 |', '| w | 5분 | 위반 2h10m | 0/0/3 | 1 | 39 · | 보기만 함 |', '']);
  const lines = summaryLines(v, { a: 90 }, { hour: '2026-11-28T08', red: false, redSinceMin: null, ledger: 'L.md', actsLastHour: 'owner-card:w' }, P);
  expect(lines).toEqual([
    '[감독 감사 08시 UTC] 루프 에이전트 2 · 보기만 함 1 · 거짓 초록 0 · 틱 정지 0 · KPI 없음 0',
    '6축 평균 70 (↓20) · 최저 w 39',
    '보기만 함: w 위반 2h10m («open-cell: 권한 밖 ×3»)',
    '조치(지난 창): owner-card:w', '빨강 아님', '원장: L.md']);
});

test('an agent with no v2 card reads tick and KPI from its tick file (listed) · never watch-only on a guessed breach start', () => {
  const empty = base('jb', { tickAt: null, kpiState: 'missing', acted: 0 });
  expect(withListed(empty, { lastTickAt: ago(3), kpiOk: false, kpisRead: 2 })).toMatchObject({ tickAt: ago(3), kpiState: 'breach', breachSince: null });
  expect(withListed(empty, { lastTickAt: null, kpiOk: null, kpisRead: 2 }).kpiState).toBe('unknown');
  expect(withListed(empty, { lastTickAt: null, kpiOk: null, kpisRead: 0 }).kpiState).toBe('missing');
  expect(withListed(base('v2', { kpiState: 'ok' }), { lastTickAt: ago(1), kpiOk: false, kpisRead: 1 }).kpiState).toBe('ok');
  // GUARDIAN-KPI-FROM: shell history without a verdict (guardian state.json kpiOk null) → the tick file's verdict · none → still unknown
  expect(withListed(base('g', { kpiState: 'unknown' }), { lastTickAt: ago(1), kpiOk: false, kpisRead: 1 }).kpiState).toBe('breach');
  expect(withListed(base('g', { kpiState: 'unknown' }), { lastTickAt: ago(1), kpiOk: true, kpisRead: 1 }).kpiState).toBe('ok');
  expect(withListed(base('g', { kpiState: 'unknown' }), { lastTickAt: ago(1), kpiOk: null, kpisRead: 1 }).kpiState).toBe('unknown');
  const [v] = judgeFleet([withListed(empty, { lastTickAt: ago(3), kpiOk: false, kpisRead: 1 })], P, NOW);
  expect(v!.flags).toEqual([]);
});
