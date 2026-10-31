import { describe, expect, test } from 'bun:test';
import {
  createLifeRunSeries,
  evaluateLifeEnd,
  isLifeKind,
  LIFE_END_EVIDENCE_KINDS,
  LIFE_KIND_SPECS,
  LIFE_KINDS,
  requiredEndEvidence,
} from './life-kinds.js';

describe('LIFE-KINDS 종류 나열', () => {
  test('네 생애 종류가 dev·run·ops·admin 이고 각자 표시명과 끝의 증거를 가진다', () => {
    expect([...LIFE_KINDS]).toEqual(['dev', 'run', 'ops', 'admin']);
    expect(LIFE_KIND_SPECS.map((spec) => spec.kind)).toEqual([...LIFE_KINDS]);
    expect(LIFE_KIND_SPECS.map((spec) => spec.label)).toEqual(['개발', '실행 산출', '운영 조치', '행정']);
    expect(isLifeKind('dev')).toBe(true);
    expect(isLifeKind('tui')).toBe(false);
  });

  test('종류별 끝의 증거는 PR·산출물·상태 측정·증빙으로 갈린다(닫힌 목록)', () => {
    expect(requiredEndEvidence('dev')).toEqual(['pr']);
    expect(requiredEndEvidence('run')).toEqual(['artifact']);
    expect(requiredEndEvidence('ops')).toEqual(['state-measurement']);
    expect(requiredEndEvidence('admin')).toEqual(['proof']);
    for (const spec of LIFE_KIND_SPECS) for (const kind of spec.endsWith) expect(LIFE_END_EVIDENCE_KINDS).toContain(kind);
  });
});

describe('LIFE-KINDS 종류별 끝의 증거 판정', () => {
  test('필요 증거가 있는 종류만 충족이고, 빠진 종류와 빈 참조는 충족이 아니다', () => {
    expect(evaluateLifeEnd('admin', [{ kind: 'proof', ref: 'approval-card-7' }])).toEqual({
      kind: 'admin', required: ['proof'], present: [{ kind: 'proof', ref: 'approval-card-7' }], missing: [], satisfied: true,
    });
    const missing = evaluateLifeEnd('dev', [{ kind: 'artifact', ref: 'out/report.md' }, { kind: 'pr', ref: '   ' }]);
    expect(missing.satisfied).toBe(false);
    expect(missing.missing).toEqual(['pr']);
    expect(missing.present).toEqual([]);
  });

  test('다른 종류의 증거는 끝 판정을 바꾸지 않는다', () => {
    const verdict = evaluateLifeEnd('run', [{ kind: 'pr', ref: '26146' }]);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing).toEqual(['artifact']);
  });
});

describe('LIFE-KINDS 반복 실행 시리즈', () => {
  const clock = (iso: string) => () => new Date(iso);

  test('같은 종류는 seq 1,2,3 으로 쌓이고 다른 종류와 seq 를 나누지 않는다', () => {
    const series = createLifeRunSeries({ now: clock('2026-10-30T01:00:00.000Z') });
    const first = series.append({ kind: 'dev', note: '첫 조각' });
    const second = series.append({ kind: 'dev', evidence: [{ kind: 'pr', ref: '26146' }] });
    const opsRun = series.append({ kind: 'ops' });
    expect([first.seq, second.seq, opsRun.seq]).toEqual([1, 2, 1]);
    expect(first.satisfied).toBe(false);
    expect(second.satisfied).toBe(true);
    expect(series.list('dev').map((entry) => entry.seq)).toEqual([1, 2]);
    expect(series.list()).toHaveLength(3);
  });

  test('주입한 시계의 시각을 그대로 쓰고, lookup 은 종류+seq 로 한 칸을 찾는다', () => {
    const series = createLifeRunSeries({ now: clock('2026-10-30T02:03:04.000Z') });
    series.append({ kind: 'admin', note: '특허 송부' });
    expect(series.list('admin')[0]?.at).toBe('2026-10-30T02:03:04.000Z');
    expect(series.lookup({ kind: 'admin', seq: 1 })?.note).toBe('특허 송부');
    expect(series.lookup({ kind: 'admin', seq: 2 })).toBeUndefined();
  });

  test('파일에서 이어받은 시리즈는 앞 seq 다음으로 append 한다', () => {
    const seed = [{ seq: 1, kind: 'run' as const, at: '2026-10-29T00:00:00.000Z', evidence: [], satisfied: false }];
    const series = createLifeRunSeries({ now: clock('2026-10-30T00:00:00.000Z'), entries: seed });
    expect(series.append({ kind: 'run', evidence: [{ kind: 'artifact', ref: 'out/shorts.mp4' }] })).toMatchObject({ seq: 2, satisfied: true });
    expect(series.list('run')).toHaveLength(2);
  });

  test('파일 순서가 섞여도 그 종류의 가장 큰 seq 다음으로 이어 간다', () => {
    const seed = [
      { seq: 3, kind: 'run' as const, at: '2026-10-29T02:00:00.000Z', evidence: [], satisfied: false },
      { seq: 1, kind: 'run' as const, at: '2026-10-29T00:00:00.000Z', evidence: [], satisfied: false },
    ];
    const series = createLifeRunSeries({ now: clock('2026-10-30T00:00:00.000Z'), entries: seed });
    expect(series.append({ kind: 'run' })).toMatchObject({ seq: 4 });
  });
});
