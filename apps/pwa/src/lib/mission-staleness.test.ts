import { describe, expect, it } from 'bun:test';
import {
  MISSION_ROLLUP_UNMEASURED_HINT,
  MISSION_TERMINAL_STATUSES,
  STALE_MISSION_DAYS,
  isMissionTerminalStatus,
  missionRollupLabel,
  missionStaleChip,
  missionStaleHint,
  missionStaleness,
} from './mission-staleness';

const now = Date.parse('2026-10-09T03:00:00Z');
const options = { timeZone: 'Asia/Seoul', status: 'running' };

describe('missionStaleness', () => {
  it('marks a running mission last updated 89 days ago as stale in Seoul time', () => {
    expect(missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, options)).toEqual({
      stale: true, days: 89, lastUpdated: '2026-07-12',
    });
  });

  it('keeps a mission updated 13 days ago fresh', () => {
    expect(missionStaleness(now - 13 * 86_400_000, now, options)).toEqual({
      stale: false, days: 13, lastUpdated: '2026-09-26',
    });
  });

  it('does not call a closed mission stale', () => {
    for (const status of ['done', 'failed', 'disarmed', 'rejected', 'completed', 'cancelled']) {
      expect(missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, { ...options, status })?.stale).toBe(false);
    }
  });

  it('returns null for missing or non-finite updates', () => {
    expect(missionStaleness(undefined, now, options)).toBeNull();
    expect(missionStaleness(Number.NaN, now, options)).toBeNull();
    expect(missionStaleness(Infinity, now, options)).toBeNull();
    expect(missionStaleness(Number.MAX_VALUE, now, options)).toBeNull();
  });

  it('uses a 14-day default threshold and accepts an override', () => {
    const updatedAt = now - 14 * 86_400_000;
    expect(missionStaleness(updatedAt, now, options)?.stale).toBe(true);
    expect(missionStaleness(updatedAt, now, { ...options, thresholdDays: 15 })?.stale).toBe(false);
  });
});

describe('mission-staleness — 기준 상수 한 곳 ⊕ 칩 문구 ⊕ 파생 라벨 (MISSIONS-STALE-MARK)', () => {
  it('기준(14일)은 «상수 한 곳»이고 힌트·판정이 모두 그것을 읽는다', () => {
    expect(STALE_MISSION_DAYS).toBe(14);
    expect(missionStaleHint()).toContain(`${STALE_MISSION_DAYS}일`);
    expect(missionStaleness(now - (STALE_MISSION_DAYS - 1) * 86_400_000, now, options)!.stale).toBe(false);
    expect(missionStaleness(now - STALE_MISSION_DAYS * 86_400_000, now, options)!.stale).toBe(true);
  });

  it('칩 문구 = «N일 멈춤 · 마지막 갱신 YYYY-MM-DD» (ask 실측 07-12~07-26 → 89~75일)', () => {
    expect(missionStaleChip(missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, options)!))
      .toBe('89일 멈춤 · 마지막 갱신 2026-07-12');
    expect(missionStaleChip(missionStaleness(Date.parse('2026-07-26T03:00:00Z'), now, options)!))
      .toBe('75일 멈춤 · 마지막 갱신 2026-07-26');
  });

  it('종료 상태는 «멈춤»이 아니다 — apm ⊕ TOX lifecycle «둘 다» 한 집합으로', () => {
    expect([...MISSION_TERMINAL_STATUSES].sort()).toEqual(
      ['done', 'failed', 'disarmed', 'rejected', 'completed', 'cancelled'].sort(),
    );
    for (const status of MISSION_TERMINAL_STATUSES) {
      expect(isMissionTerminalStatus(status)).toBe(true);
      expect(
        missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, { ...options, status })!.stale,
      ).toBe(false);
    }
    for (const status of ['running', 'armed', 'proposed', 'active', 'planning', 'executing']) {
      expect(isMissionTerminalStatus(status)).toBe(false);
      expect(
        missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, { ...options, status })!.stale,
      ).toBe(true);
    }
    // 미상·빈 상태는 «종료»로 «넘겨짚지» 않는다 (조용히 닫힌 미션이 되지 않게)
    expect(isMissionTerminalStatus(undefined)).toBe(false);
    expect(isMissionTerminalStatus(null)).toBe(false);
    expect(isMissionTerminalStatus('')).toBe(false);
  });

  it('파생 라벨 — «파생 미측정»(못 잼)과 «파생 0»(실측 0)은 «다른» 값이다', () => {
    expect(missionRollupLabel(undefined)).toBe('파생 미측정');
    expect(missionRollupLabel(null)).toBe('파생 미측정');
    expect(missionRollupLabel({ total: 0 })).toBe('파생 0');
    expect(missionRollupLabel({ total: 5 })).toBe('파생 5');
    expect(missionRollupLabel(undefined)).not.toBe(missionRollupLabel({ total: 0 }));
  });

  it('미측정 힌트는 «파생 0이 아니다»를 «문면으로» 말한다', () => {
    expect(MISSION_ROLLUP_UNMEASURED_HINT).toContain('«파생 0»이 아니라');
    expect(MISSION_ROLLUP_UNMEASURED_HINT).toContain('못 잰');
  });
});
