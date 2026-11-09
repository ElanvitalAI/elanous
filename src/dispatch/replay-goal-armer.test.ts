// M4 · replay-goal-armer 단위테스트 (순수 게이트 + 인메모리 db + temp vault arm).
import { test, expect, describe, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  replayAutoGoalEnabled, inReplayWindow, replayTerminationRule, replayGoalArmerTick,
  armReplayGoal, finalizeReplayRuns, ensureReplayRunTable, REPLAY_MIN_CHARS,
} from './replay-goal-armer.js';
import { getAutoModeState, setAutoModeState } from '../auto-research/auto-mode/session.js';
import { INACTIVE_AUTO_MODE_STATE } from '../auto-research/auto-mode/types.js';
import type { ObsidianVault } from '../auto-research/obsidian-bridge.js';
import type { UserConfig } from '../user-config/types.js';

// 최소 cfg — 함수들이 cfg.finance?.replay?.autoGoal 만 읽는다.
function cfg(over: Record<string, unknown> = {}): UserConfig {
  return { finance: { replay: { autoGoal: { enabled: true, maxTurns: 3, tokenCap: 80_000, windowStartHour: 6, windowEndHour: 7, ...over } } } } as unknown as UserConfig;
}

// 로컬 시각 h시 m분의 epoch(테스트 결정론).
const at = (h: number, m = 0): number => new Date(2026, 6, 8, h, m, 0).getTime();

const tmpDirs: string[] = [];
function tempVault(): ObsidianVault {
  const dir = mkdtempSync(join(tmpdir(), 'replay-vault-'));
  tmpDirs.push(dir);
  return { root: dir } as ObsidianVault;
}

beforeEach(() => { setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE }); });
afterAll(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } } });

describe('순수 게이트 헬퍼', () => {
  test('replayAutoGoalEnabled — 기본 미주입 false', () => {
    expect(replayAutoGoalEnabled({} as UserConfig)).toBe(false);
    expect(replayAutoGoalEnabled({ finance: { replay: { autoGoal: { enabled: false } } } } as unknown as UserConfig)).toBe(false);
    expect(replayAutoGoalEnabled(cfg())).toBe(true);
  });

  test('inReplayWindow — [start,end) 반개구간', () => {
    expect(inReplayWindow(at(6, 0), 6, 7)).toBe(true);
    expect(inReplayWindow(at(6, 59), 6, 7)).toBe(true);
    expect(inReplayWindow(at(7, 0), 6, 7)).toBe(false);   // end 배타
    expect(inReplayWindow(at(5, 59), 6, 7)).toBe(false);
    expect(inReplayWindow(at(10, 0), 6, 7)).toBe(false);
  });

  test('replayTerminationRule — REPLAY.md ≥300자', () => {
    expect(replayTerminationRule()).toEqual({ kind: 'summary_written', path: 'REPLAY.md', minChars: REPLAY_MIN_CHARS });
  });
});

describe('replayGoalArmerTick — 게이트', () => {
  test('disarmed(비활성 config) → arm 안 함', async () => {
    const r = await replayGoalArmerTick({} as UserConfig);
    expect(r.action).toBe('disarmed');
  });

  test('시간창 밖 → off-window(양보)', async () => {
    const db = new Database(':memory:');
    const r = await replayGoalArmerTick(cfg(), { db, vault: tempVault(), now: () => at(10, 0) });
    expect(r.action).toBe('off-window');
    db.close();
  });

  test('active goal 있으면 → busy(싱글턴 양보)', async () => {
    setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE, active: true, goalSlug: 'other' });
    const db = new Database(':memory:');
    const r = await replayGoalArmerTick(cfg(), { db, vault: tempVault(), now: () => at(6, 30) });
    expect(r.action).toBe('busy');
    db.close();
  });

  test('오늘 이미 arm → daily-done(일일 1회)', async () => {
    const db = new Database(':memory:');
    ensureReplayRunTable(db);
    db.run(`INSERT INTO replay_runs(goal_slug, armed_at, status) VALUES ('replay-prev', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'done')`);
    const r = await replayGoalArmerTick(cfg(), { db, vault: tempVault(), now: () => at(6, 30) });
    expect(r.action).toBe('daily-done');
    db.close();
  });

  test('창 안 + idle + 오늘 미실행 → armed(state active·REPLAY 종료조건)', async () => {
    const db = new Database(':memory:');
    const vault = tempVault();
    const r = await replayGoalArmerTick(cfg(), { db, vault, now: () => at(6, 15) });
    expect(r.action).toBe('armed');
    expect(r.goalSlug).toContain('replay-');
    const st = getAutoModeState();
    expect(st.active).toBe(true);
    expect(st.goalSlug).toBe(r.goalSlug);
    expect(st.terminationRule).toEqual({ kind: 'summary_written', path: 'REPLAY.md', minChars: REPLAY_MIN_CHARS });
    // ACTIVE.md 가 실제 vault 에 쓰였는지(READ-ONLY 프롬프트).
    expect(existsSync(join(vault.root, 'goals', r.goalSlug!, 'ACTIVE.md'))).toBe(true);
    db.close();
  });
});

describe('finalizeReplayRuns — 정산', () => {
  test('REPLAY.md ≥300자 + 비활성 → done + 알림', async () => {
    const db = new Database(':memory:');
    ensureReplayRunTable(db);
    const vault = tempVault();
    await armReplayGoal(db, vault, cfg(), { now: () => at(6, 15) });
    const slug = getAutoModeState().goalSlug!;
    // 골 완료 시뮬: 비활성 전환 + REPLAY.md 작성.
    setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE });
    writeFileSync(join(vault.root, 'goals', slug, 'REPLAY.md'), 'x'.repeat(REPLAY_MIN_CHARS + 10));
    const notices: string[] = [];
    const n = finalizeReplayRuns(db, vault, { notify: (t) => notices.push(t), now: () => at(6, 20) });
    expect(n).toBe(1);
    expect((db.prepare(`SELECT status FROM replay_runs WHERE goal_slug=?`).get(slug) as any).status).toBe('done');
    expect(notices[0]).toContain('새벽 리플레이 완료');
    db.close();
  });

  test('REPLAY.md 부족(<300자) → abandoned(알림 없음)', async () => {
    const db = new Database(':memory:');
    ensureReplayRunTable(db);
    const vault = tempVault();
    await armReplayGoal(db, vault, cfg(), { now: () => at(6, 15) });
    const slug = getAutoModeState().goalSlug!;
    setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE });
    writeFileSync(join(vault.root, 'goals', slug, 'REPLAY.md'), 'too short');
    const notices: string[] = [];
    finalizeReplayRuns(db, vault, { notify: (t) => notices.push(t), now: () => at(6, 20) });
    expect((db.prepare(`SELECT status FROM replay_runs WHERE goal_slug=?`).get(slug) as any).status).toBe('abandoned');
    expect(notices.length).toBe(0);
  });
});
