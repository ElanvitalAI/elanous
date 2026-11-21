import { test, expect } from 'bun:test';
import { applyMemoryDecay, openSurfaceEventsDb, recordEvent, stabilityDays, type DecayResult } from './surface-events.js';
import { runMemoryLifecycle } from './memory-lifecycle.js';
import {
  STABILITY_CALIBRATION_MAX_LAMBDA,
  STABILITY_CALIBRATION_MIN_LAMBDA,
  STABILITY_CALIBRATION_WINDOW_DAYS,
  calibrateStabilityDays,
  decayWithEffectCounts,
  effectCounts,
  measureStabilityAges,
  type DecayEffectCounts,
  type StabilityAgeSample,
} from './memory-stability-calibration.js';

// ── M1 stability 보정 시험 (MEM-STABILITY-DAYS-CALIBRATION · ROSTER-0332) ──────
// 완료 경계: 보정 근거 표 + 사이클 시험(승격·강등·보존 3경로). 실측 분포는 고정 시계
// fixture 로 결정론적으로 재현한다(실 원장·프로세스 시계 무관).

const NOW = Date.parse('2026-11-21T00:00:00Z');

function fixtureDb() {
  const db = openSurfaceEventsDb(':memory:');
  return {
    db,
    add: (daysAgo: number, importance = 5) => recordEvent(db, {
      surface: 'sim', direction: 'inbound', text: `event-${daysAgo}`, importance,
      ts: new Date(NOW - daysAgo * 86400000).toISOString(),
    }),
    bump: (id: string) => db.run('UPDATE events SET recall_count = recall_count + 1 WHERE id = ?', [id]),
    setTier: (id: string, tier: string) => db.run('UPDATE events SET tier = ? WHERE id = ?', [tier, id]),
    tier: (id: string) => (db.query('select tier from events where id=?').get(id) as { tier: string }).tier,
  };
}

test('measureStabilityAges — 이벤트 나이(일)·회상 여부를 원장에서 실측', () => {
  const { db, add, bump } = fixtureDb();
  const young = add(1);
  add(40);
  bump(young);
  const samples = measureStabilityAges(db, { nowMs: NOW }).sort((a, b) => a.ageDays - b.ageDays);
  expect(samples).toEqual([
    { ageDays: 1, recalled: true },
    { ageDays: 40, recalled: false },
  ]);
  db.close();
});

test('calibrateStabilityDays — 회상 p80 관측 → λ 보정 · 보정 근거 표 · 곡선 형상 유지', () => {
  const samples: StabilityAgeSample[] = [10, 20, 30, 40].map((ageDays) => ({ ageDays, recalled: true }));
  const cal = calibrateStabilityDays(samples);
  expect(cal.source).toBe('measured');
  expect(cal.measured).toEqual({ events: 4, recalledEvents: 4, agesDays: { p50: 25, p80: 34, p95: 38.5 } });
  expect(cal.lambda).toBeCloseTo(34 / STABILITY_CALIBRATION_WINDOW_DAYS, 6);
  // 보정된 기본 승격 기준(imp5·recall0) = λ×22 = 34 — 곡선 형상(importance·미엘린 항)은 유지
  expect(cal.stability(5, 0)).toBe(34);
  expect(cal.stability(5, 0) / stabilityDays(5, 0)).toBeCloseTo(cal.lambda, 6);
  // 보정 근거 표 — 관측→판정 행이 로그·보고에 그대로 붙는 형태로 존재
  expect(cal.rationale.length).toBeGreaterThanOrEqual(4);
  for (const row of cal.rationale) {
    expect(row.row.trim().length).toBeGreaterThan(0);
    expect(row.observed.trim().length).toBeGreaterThan(0);
    expect(row.decision.trim().length).toBeGreaterThan(0);
  }
  expect(cal.rationale.map((row) => row.row)).toContain('보정 후 기본 승격 기준(일)');
});

test('calibrateStabilityDays — 빈 표본 → 기본 곡선 · 극단 관측 → λ 상·하한 캡', () => {
  const empty = calibrateStabilityDays([]);
  expect(empty.source).toBe('default');
  expect(empty.lambda).toBe(1);
  expect(empty.stability(5, 0)).toBe(stabilityDays(5, 0));
  expect(empty.rationale[0]?.observed).toContain('빈 표본');
  const huge = calibrateStabilityDays([{ ageDays: 4000, recalled: true }]);
  expect(huge.lambda).toBe(STABILITY_CALIBRATION_MAX_LAMBDA);
  expect(huge.stability(5, 0)).toBe(STABILITY_CALIBRATION_MAX_LAMBDA * STABILITY_CALIBRATION_WINDOW_DAYS); // 44
  const tiny = calibrateStabilityDays([{ ageDays: 0.01, recalled: true }]);
  expect(tiny.lambda).toBe(STABILITY_CALIBRATION_MIN_LAMBDA);
  expect(tiny.stability(5, 0)).toBe(Math.round(STABILITY_CALIBRATION_MIN_LAMBDA * STABILITY_CALIBRATION_WINDOW_DAYS)); // 11
});

test('사이클 시험 — 보정 곡선으로 승격·강등·보존 3경로 + 효과 수치', () => {
  const { db, add, setTier, tier } = fixtureDb();
  const promote = add(1);   // 1일 된 기억 — cold 였다가 보정 곡선에서 hot 으로 승격
  const demote = add(300);  // 300일 된 기억 — hot 였다가 cold 로 강등
  const retain = add(1);    // 1일 된 hot 기억 — hot 유지(보존)
  setTier(promote, 'cold');
  setTier(demote, 'hot');
  setTier(retain, 'hot');
  const before = [promote, demote, retain].map(tier);
  // 실측 분포(이 db): 나이 [1, 1, 300]·회상 0 → 전체 p80 = 180.4 → λ 상한 2 → 기본 기준 44일
  const cal = calibrateStabilityDays(measureStabilityAges(db, { nowMs: NOW }));
  expect(cal.stability(5, 0)).toBe(44);
  const decay = applyMemoryDecay(db, { nowMs: NOW, stability: cal.stability });
  expect(decay).toEqual({ hot: 2, warm: 0, cold: 1, changed: 2, effects: { promoted: 1, demoted: 1, retained: 1 } });
  const after = [promote, demote, retain].map(tier);
  expect(after).toEqual(['hot', 'cold', 'hot']);
  // 효과 수치 노드 — decay 전후 tier 로 승격·강등·보존 건수
  const effects = effectCounts([
    { before: before[0] ?? null, after: after[0]! },
    { before: before[1] ?? null, after: after[1]! },
    { before: before[2] ?? null, after: after[2]! },
  ]);
  expect(effects).toEqual({ promoted: 1, demoted: 1, retained: 1 });
  db.close();
});
test('decay 경계 집계 — decay 직후(RIF·archive·prune 전) 같은 집합으로만 승격·강등·보존을 센다 (JUD HOLD 1121)', async () => {
  const { db, add, setTier } = fixtureDb();
  const promote = add(1);   // cold → hot 승격 대기(보정 λ=2 → 기준 44일이므로 1일은 hot)
  const demote = add(300);  // hot → cold 강등 대기(300일)
  setTier(promote, 'cold');
  setTier(demote, 'hot');
  const cal = calibrateStabilityDays(measureStabilityAges(db, { nowMs: NOW }));
  expect(cal.stability(5, 0)).toBe(44);
  let effects: DecayEffectCounts | undefined;
  const report = await runMemoryLifecycle({
    replay: () => ({ candidates: 0, strengthened: 0, themes: [] }),
    decay: () => {
      const r = decayWithEffectCounts(db, { stability: cal.stability, nowMs: NOW });
      effects = r.effects;
      return r.decay;
    },
    // 반증용 RIF — decay 뒤 승격된 행을 다시 cold 로 되돌린다. 전체 사이클 뒤 대조였다면 이 변경이
    // M1 효과 수치에 섞여 promoted 0 오판이 난다. 경계 집계는 영향을 받지 않아야 한다.
    rif: () => { db.run("UPDATE events SET tier = 'cold' WHERE id = ?", [promote]); return { clusters: 1, suppressed: 1 }; },
    recaps: () => ({ sessions: 0, promoted: 0 }),
    consolidate: () => Promise.resolve({ groups: 0, consolidated: 0, skipped: 0 }),
    archive: () => ({ archived: 0, skipped: 0 }),
    pruneEvents: () => 0,
    pruneKnowledge: () => 0,
  });
  // 반환값 전체 형(DecayResult — effects 포함)으로 명시해 초과 속성 검사를 정확한 계약에 맞춘다.
  const expectedDecay: DecayResult = { hot: 1, warm: 0, cold: 1, changed: 2, effects: { promoted: 1, demoted: 1, retained: 0 } };
  expect(report.decay).toEqual(expectedDecay); // 2행: 1일→hot · 300일→cold
  expect(effects).toEqual({ promoted: 1, demoted: 1, retained: 0 }); // RIF 되돌림은 M1 수치에 없음
  db.close();
});

test('decay 도중 다른 연결 행 삽입 — 효과 수는 decay가 실제 처리한 행에서만 (JUD HOLD #117655 · 3차)', () => {
  const { db, add, setTier } = fixtureDb();
  const promote = add(1); setTier(promote, 'cold');  // 1일 → hot 승격
  const demote = add(300); setTier(demote, 'hot');   // 300일 → cold 강등
  const cal = calibrateStabilityDays(measureStabilityAges(db, { nowMs: NOW }));
  expect(cal.stability(5, 0)).toBe(44);
  let injected = false;
  const stability = (importance: number | null | undefined, recallCount: number | null | undefined) => {
    if (!injected) {
      injected = true;
      // decay 루프 도중 다른 연결이 같은 원장에 행을 끼워넣는 꼴 — 전후 재조회 집계라면
      // 이 행(before=null→cold)이 강등 +1 로 효과 수에 섞인다. 처리 행 집합이 아니므로 불변이어야 한다.
      const intruder = recordEvent(db, { surface: 'sim', direction: 'inbound', text: 'intruder', importance: 3, ts: '2025-01-01T00:00:00.000Z' });
      setTier(intruder, 'cold');
    }
    return cal.stability(importance, recallCount);
  };
  const { decay, effects } = decayWithEffectCounts(db, { stability, nowMs: NOW });
  expect([decay.hot, decay.warm, decay.cold, decay.changed]).toEqual([1, 0, 1, 2]); // 실제 처리 행 = 2(삽입 행 제외)
  expect(decay.effects).toEqual({ promoted: 1, demoted: 1, retained: 0 }); // 반환값 집계 — 현재 코드엔 없어 빨강
  expect(effects).toEqual({ promoted: 1, demoted: 1, retained: 0 }); // 전후 재조회는 삽입 행 오염 {1,2,0} → 빨강
  db.close();
});

test('보정 근거 표 라벨 — 회상 표본 0이면 관측 집합(전체 대체)을 라벨에 반영 (JUD #119296)', () => {
  // 라이브 원장 실측(회상 0/7 강등/92724 보존)과 같은 상황: 회상된 기억이 하나도 없으면
  // observedP80 은 전체(all) p80 대체다. 그런데 근거 표 행 이름이 «회상 기억 p80»으로 고정돼 있으면
  // 실제 관측 집합이 아닌 출처를 표기한다 — 근거 표의 출처 오표기(JUD-B #119296).
  const samples: StabilityAgeSample[] = [10, 40, 90, 200].map((ageDays) => ({ ageDays, recalled: false }));
  const cal = calibrateStabilityDays(samples);
  expect(cal.source).toBe('measured');
  expect(cal.measured.events).toBe(4);
  expect(cal.measured.recalledEvents).toBe(0); // 회상 표본 0 → 전체 p80 대체 경로
  const p80Row = cal.rationale.find((row) => row.decision.includes('승격 기준'));
  expect(p80Row).toBeDefined();
  // 라벨은 실제 관측 집합(전체)을 말해야 한다 — 현재 코드는 «회상 기억 p80» 고정 → 빨강
  expect(p80Row!.row).toContain('전체 p80');
  expect(p80Row!.row).not.toContain('회상 기억 p80');
  // 관측 수치도 실제 관측 집합(전체)의 p80 과 정합
  expect(Number(p80Row!.observed)).toBeCloseTo(cal.measured.agesDays.p80, 1);
});
