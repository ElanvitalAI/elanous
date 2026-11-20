// 관측 저장소 시험 — 0600 원자 쓰기 · real/synthetic · 행 상태 변환 · 되돌림(synthetic 만) · 기본 observer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSpendObservation, createObservationObserver, observationsToRowStates, readSpendObservations, revokeSyntheticObservations,
  spendObservationsFile, type SpendObservation,
} from './observations.js';

let dir: string;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'llm-obs-test-')), 'llm-spend-policy'); });
afterEach(() => { rmSync(join(dir, '..'), { recursive: true, force: true }); });

const T = '2026-11-20T03:00:00.000Z';
const win = (over: Partial<SpendObservation> = {}): SpendObservation => ({
  id: 'o1', row: 'codex-team', provider: 'openai-codex', kind: 'window', source: 'real', observedAt: T, usedPct: 100, resetAt: '2026-11-20T08:00:00.000Z', ...over,
});

describe('관측 저장소', () => {
  test('원장 폴더의 부모에 llm-spend-observations.json 을 0600 으로 쓴다', async () => {
    await appendSpendObservation(win(), dir);
    const file = await spendObservationsFile(dir);
    expect(file).toBe(join(dir, '..', 'llm-spend-observations.json'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(1);
  });
  test('같은 (행·종류·source) 는 대체되고 다른 source 는 공존한다', async () => {
    await appendSpendObservation(win({ id: 'a' }), dir);
    await appendSpendObservation(win({ id: 'b', usedPct: 50 }), dir);
    await appendSpendObservation(win({ id: 'c', source: 'synthetic' }), dir);
    expect((await readSpendObservations(dir)).map((r) => r.id)).toEqual(['b', 'c']);
  });
  test('행 상태 변환 — 창 소진(real) · 잔액 0 · 지출 · 자동충전, 늦은 관측이 이긴다', () => {
    const states = observationsToRowStates([
      win(),
      win({ id: 'x', source: 'synthetic', observedAt: '2026-11-20T04:00:00.000Z', usedPct: 0, resetAt: undefined }),
      { id: 'b', row: 'openrouter', provider: 'openrouter', kind: 'balance', source: 'real', observedAt: T, usd: 0 },
      { id: 's', row: 'openrouter', provider: 'openrouter', kind: 'spend', source: 'synthetic', observedAt: T, todayUsd: 300, monthUsd: 300 },
      { id: 't', row: 'openrouter', provider: 'openrouter', kind: 'autoTopUp', source: 'synthetic', observedAt: T, enabled: true, amountUsd: 20 },
    ]);
    const team = states.find((s) => s.row === 'codex-team')!;
    expect(team.window).toEqual({ status: 'measured', usedPct: 0, source: 'synthetic', observedAt: '2026-11-20T04:00:00.000Z' });
    const or = states.find((s) => s.row === 'openrouter')!;
    expect(or.balance).toMatchObject({ status: 'measured', usd: 0, source: 'real' });
    expect(or.spend).toMatchObject({ todayUsd: 300, monthUsd: 300, source: 'synthetic' });
    expect(or.autoTopUp).toMatchObject({ enabled: true, amountUsd: 20 });
  });
  test('되돌림은 synthetic 만 — id 하나 · all · real 은 남는다', async () => {
    await appendSpendObservation(win({ id: 'r' }), dir);
    await appendSpendObservation(win({ id: 's1', source: 'synthetic' }), dir);
    await appendSpendObservation(win({ id: 's2', row: 'codex-default', source: 'synthetic' }), dir);
    expect(await revokeSyntheticObservations('r', dir)).toEqual([]);
    expect(await revokeSyntheticObservations('s1', dir)).toEqual(['s1']);
    expect(await revokeSyntheticObservations('all', dir)).toEqual(['s2']);
    expect((await readSpendObservations(dir)).map((r) => r.id)).toEqual(['r']);
  });
  test('파일 없음·깨짐 = 빈 관측 · 기본 observer 가 이 저장소를 읽는다', async () => {
    expect(await readSpendObservations(dir)).toEqual([]);
    await appendSpendObservation(win(), dir);
    const states = await createObservationObserver(dir)();
    expect(states.map((s) => [s.row, s.window?.status === 'measured' ? s.window.usedPct : null])).toEqual([['codex-team', 100]]);
  });
  test('실 관문 observer 는 synthetic 을 «기본 무시» — 같은 행의 늦은 synthetic 이 real 을 덮지 못한다 · includeSynthetic 일 때만 읽는다', async () => {
    await appendSpendObservation(win({ id: 'r', usedPct: 100 }), dir);
    await appendSpendObservation(win({ id: 's', source: 'synthetic', observedAt: '2026-11-20T04:00:00.000Z', usedPct: 0, resetAt: undefined }), dir);
    const dflt = await createObservationObserver(dir)();
    expect(dflt.find((s) => s.row === 'codex-team')!.window).toMatchObject({ usedPct: 100, source: 'real' });
    const test = await createObservationObserver(dir, { includeSynthetic: () => true })();
    expect(test.find((s) => s.row === 'codex-team')!.window).toMatchObject({ usedPct: 0, source: 'synthetic' });
  });
});
