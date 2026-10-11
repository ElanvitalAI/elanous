#!/usr/bin/env bun
/**
 * LOG-DIET-2 (0.2.24) — «같은 부하»에서 관측 «행 수»가 얼마나 줄었나를 재생(replay)으로 잰다.
 *
 * 왜 재생인가: 판정선은 «같은 부하에서 시간당 행 −60%»인데 72분 실물 런은 이 칸의 창에 들어가지
 * 않는다. 그래서 칸 문면이 «측정값»으로 준 부하를 기록열로 재구성하고, 그 «같은» 기록열을
 * 0.2.23 정책과 현재 정책 두 가드에 흘려 내보낸 행을 센다. 측정은 «정책 차이»이지 실물 재현이
 * 아니다 — 이 한계를 출력에도 적는다.
 *
 * 실행: bun scripts/measure-log-diet-2.ts [--json]
 * 계약: bun test scripts/measure-log-diet-2.test.ts
 */
import { LOG_DIET_KEYS, LogDietGuard } from '../src/debug/log-diet.js';
import type { DebugEvent } from '../src/debug/log.js';

/** 0.2.23 절식 정책 — A/B «기준선»으로 얼려 둔 사본(현재 `LOG_DIET_KEYS` 와 의도적으로 다르다). */
export const LOG_DIET_KEYS_0_2_23: Readonly<Record<string, 'repeat' | 'consecutive'>> = {
  'watchdog/activity': 'consecutive',
  'user-config.llm/provider-resolved': 'repeat',
  'hitl.card-bridge/skipped': 'repeat',
  'input.cursor.claim/chat-main': 'repeat',
  'tox.loop/waiting-capacity': 'repeat',
  'tox.loop/tick': 'repeat',
};

/** 관측된 `log.diet/suppressed` 4,313행(72분) ≈ 초당 1회 flush — 그 주기를 기준선으로 쓴다. */
export const REPLAY_FLUSH_EVERY_MS = 1_000;
export const REPLAY_WINDOW_MS = 72 * 60_000;

export type ReplayRecord = Pick<DebugEvent, 'category' | 'event' | 'data' | 'level'> & { atMs: number };

export type LoadGroup = {
  /** `category/event` */
  key: string;
  level?: DebugEvent['level'];
  /** 창(72분) 동안 관측된 행 수 */
  rows: number;
  /** 서로 다른 payload 수 — 1 이면 전부 한 스트림으로 접힌다 */
  distinctValues: number;
  source: 'measured' | 'assumed';
  note: string;
};

/** 판정 부하: 칸 문면이 수로 준 군 ⊕ 판정 경로(미등록 키) 0-손실 대조군. */
export const LOG_DIET_2_LOAD: readonly LoadGroup[] = [
  {
    key: 'llm.credential/provider-key-missing', level: 'warn', rows: 5_207, distinctValues: 1,
    source: 'measured', note: '칸 문면 측정값 — 72분 5,207행, 같은 (provider, source, context)',
  },
  {
    key: 'log-diet.replay/judgment-path', rows: 300, distinctValues: 300,
    source: 'assumed', note: '합성 대조군 — 미등록(판정 경로) 키는 100% 통과해야 한다',
  },
];

export type ReplayResult = {
  rowsIn: number;
  /** 통과한 원본 행 + `log.diet/suppressed` 요약 행 */
  rowsOut: number;
  originalRows: number;
  summaryRows: number;
  /** 요약 행이 실어 나른 접힌 기록의 총수 — `originalRows + suppressedTotal === rowsIn` 이어야 한다 */
  suppressedTotal: number;
  judgmentRowsIn: number;
  judgmentRowsOut: number;
  judgmentLoss: number;
  /** 1 − rowsOut/rowsIn */
  reductionRatio: number;
  /** 참고값 — 내보낸 행 중 `log.diet` 요약 행의 비중(0~1). 판정 ② «총/목록 밖 비»가 «아니다» — 그 비는 재생으로 못 잰다. */
  summaryShare: number;
};

export function isJudgmentPath(rec: Pick<DebugEvent, 'category' | 'event'>): boolean {
  return rec.category !== 'log.diet' && !LOG_DIET_KEYS[`${rec.category}/${rec.event}`];
}

/** 같은 기록열을 두 정책(기준선/현재)에 흘릴 수 있게 군을 시간순 기록열로 펼친다. */
export function buildReplayRecords(
  groups: readonly LoadGroup[],
  windowMs = REPLAY_WINDOW_MS,
): ReplayRecord[] {
  const records: ReplayRecord[] = [];
  for (const group of groups) {
    const [category, event] = group.key.split('/');
    if (!category || !event) throw new Error(`잘못된 부하 키: ${group.key}`);
    const step = group.rows > 0 ? windowMs / group.rows : windowMs;
    for (let i = 0; i < group.rows; i++) {
      const seq = group.distinctValues > 1 ? i % group.distinctValues : 0;
      records.push({
        atMs: Math.round(i * step),
        category,
        event,
        data: { key: group.key, seq },
        ...(group.level ? { level: group.level } : {}),
      });
    }
  }
  return records.sort((a, b) => a.atMs - b.atMs);
}

export function replayDiet(
  records: readonly ReplayRecord[],
  makeGuard: (now: () => number) => LogDietGuard,
  flushEveryMs = REPLAY_FLUSH_EVERY_MS,
): ReplayResult {
  let clock = 0;
  const guard = makeGuard(() => clock);
  let originalRows = 0;
  let summaryRows = 0;
  let suppressedTotal = 0;
  let judgmentRowsIn = 0;
  let judgmentRowsOut = 0;
  let nextFlush = flushEveryMs;
  for (const rec of records) {
    while (nextFlush <= rec.atMs) {
      clock = nextFlush;
      const released = guard.flushPending();
      summaryRows += released.length;
      suppressedTotal += released.reduce((sum, s) => sum + s.count, 0);
      nextFlush += flushEveryMs;
    }
    clock = rec.atMs;
    const judgment = isJudgmentPath(rec);
    if (judgment) judgmentRowsIn++;
    const decision = guard.admit(rec);
    if (decision.pass) {
      originalRows++;
      if (judgment) judgmentRowsOut++;
    }
    summaryRows += decision.summaries.length;
    suppressedTotal += decision.summaries.reduce((sum, s) => sum + s.count, 0);
  }
  clock = (records.at(-1)?.atMs ?? 0) + flushEveryMs;
  const drained = guard.drain();
  summaryRows += drained.length;
  suppressedTotal += drained.reduce((sum, s) => sum + s.count, 0);
  const rowsOut = originalRows + summaryRows;
  return {
    rowsIn: records.length,
    rowsOut,
    originalRows,
    summaryRows,
    suppressedTotal,
    judgmentRowsIn,
    judgmentRowsOut,
    judgmentLoss: judgmentRowsIn - judgmentRowsOut,
    reductionRatio: records.length === 0 ? 0 : 1 - rowsOut / records.length,
    summaryShare: rowsOut === 0 ? 0 : summaryRows / rowsOut,
  };
}

export type Diet2Measurement = {
  windowMinutes: number;
  flushEveryMs: number;
  records: number;
  groups: readonly LoadGroup[];
  /** 0.2.23 정책(기준선) */
  before: ReplayResult;
  /** 현재 정책(LOG-DIET-2) */
  after: ReplayResult;
  /** 1 − after.rowsOut / before.rowsOut — 판정선 −60% 가 무는 값 */
  reduction: number;
};

export function measureLogDiet2(
  groups: readonly LoadGroup[] = LOG_DIET_2_LOAD,
  windowMs = REPLAY_WINDOW_MS,
): Diet2Measurement {
  const records = buildReplayRecords(groups, windowMs);
  const before = replayDiet(records, now => new LogDietGuard({
    now,
    keys: LOG_DIET_KEYS_0_2_23,
    summaryMinIntervalMs: 0,
    summaryMaxPending: 1,
  }));
  const after = replayDiet(records, now => new LogDietGuard({ now }));
  return {
    windowMinutes: Math.round(windowMs / 60_000),
    flushEveryMs: REPLAY_FLUSH_EVERY_MS,
    records: records.length,
    groups,
    before,
    after,
    reduction: before.rowsOut === 0 ? 0 : 1 - after.rowsOut / before.rowsOut,
  };
}

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

function report(m: Diet2Measurement): string {
  const lines: string[] = [
    `LOG-DIET-2 재생 측정 — 창 ${m.windowMinutes}분 · flush ${m.flushEveryMs}ms · 기록 ${m.records}행`,
    '⚠ 정책 차이의 재생 측정이다(72분 실물 런 아님). 부하 군:',
    ...m.groups.map(g => `   - ${g.key} ${g.rows}행/${g.distinctValues}값 [${g.source}] ${g.note}`),
    '',
    `기준선(0.2.23)  행 ${m.before.rowsOut} (원본 ${m.before.originalRows} + 요약 ${m.before.summaryRows} · 접힌 기록 ${m.before.suppressedTotal})`,
    `현재(LOG-DIET-2) 행 ${m.after.rowsOut} (원본 ${m.after.originalRows} + 요약 ${m.after.summaryRows} · 접힌 기록 ${m.after.suppressedTotal})`,
    `보존            : 원본+접힌 기록 = 입력  → ${m.after.originalRows}+${m.after.suppressedTotal}=${m.records}  ${m.after.originalRows + m.after.suppressedTotal === m.records ? 'PASS' : 'FAIL'}`,
    '',
    `판정 ① 같은 부하 시간당 행 −60%      : ${pct(m.reduction)} 감소  → ${m.reduction >= 0.6 ? 'PASS' : 'FAIL'}`,
    `판정 ② 총/목록 밖 비 ≤ 1.03          : 재생으로 못 잰다(unmeasured · 실물 logs 목록 대비 필요) — 참고: 요약 행 비중 ${m.after.summaryShare.toFixed(3)}`,
    `판정 ③ 판정 경로 이벤트 0 손실       : ${m.after.judgmentRowsOut}/${m.after.judgmentRowsIn} 통과 (손실 ${m.after.judgmentLoss})  → ${m.after.judgmentLoss === 0 ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const m = measureLogDiet2();
  if (process.argv.includes('--json')) console.log(JSON.stringify(m, null, 2));
  else console.log(report(m));
  const ok = m.reduction >= 0.6 && m.after.judgmentLoss === 0; // 판정 ② 는 여기서 판정하지 않는다(unmeasured)
  process.exit(ok ? 0 : 1);
}
