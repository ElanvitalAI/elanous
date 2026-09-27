import { describe, expect, test } from 'bun:test';
import { initialPtyLivePollState, nextPtyLivePollState, PTY_LIVE_POLL_MS, ptySnapshotReplacement, shouldPollPty } from './pty-live-poll';

describe('PTY live snapshot polling', () => {
  test('800ms cadence and hidden screen pause', () => {
    expect(PTY_LIVE_POLL_MS).toBe(800);
    expect(shouldPollPty(true, initialPtyLivePollState)).toBe(true);
    expect(shouldPollPty(false, initialPtyLivePollState)).toBe(false);
  });
  test('404 stops with ended reason', () => {
    const next = nextPtyLivePollState(initialPtyLivePollState, { status: 'unknown-pty' });
    expect(next.message).toBe('PTY 가 끝났습니다');
    expect(shouldPollPty(true, next)).toBe(false);
  });
  test('504 retries on next interval and success resets failures', () => {
    const next = nextPtyLivePollState(initialPtyLivePollState, { status: 'owner-unreachable' });
    expect(next.failures).toBe(1);
    expect(shouldPollPty(true, next)).toBe(true);
    expect(nextPtyLivePollState(next, { status: 'success', screen: 'ok' }).failures).toBe(0);
  });
  test('five consecutive failures stop with unreachable reason', () => {
    let state = initialPtyLivePollState;
    for (let i = 0; i < 5; i++) state = nextPtyLivePollState(state, { status: 'owner-unreachable' });
    expect(state.failures).toBe(5);
    expect(state.message).toBe('소유 프로세스에 닿지 않습니다');
    expect(shouldPollPty(true, state)).toBe(false);
  });
  test('409 stops with the actual denial reason; 502 and network errors retain their own reason', () => {
    const denied = nextPtyLivePollState(initialPtyLivePollState, { status: 'denied', reason: '권한 거부' });
    expect(denied.message).toBe('권한 거부');
    expect(shouldPollPty(true, denied)).toBe(false);
    let failed = initialPtyLivePollState;
    for (let i = 0; i < 6; i++) failed = nextPtyLivePollState(failed, { status: 'failed', reason: 'snapshot failed' });
    expect(failed.message).toBe('snapshot failed');
    expect(shouldPollPty(true, failed)).toBe(false);
    const network = nextPtyLivePollState(initialPtyLivePollState, null);
    expect(network.message).toBe('화면 조회에 실패했습니다');
    expect(network.stopped).toBe(false);
  });
  test('snapshot replaces the viewport including ANSI SGR', () => {
    expect(ptySnapshotReplacement('\x1b[31mred')).toBe('\x1b[H\x1b[2J\x1b[31mred');
    // 2026-09-27 실물: 소유 프로세스 스냅샷의 메타 머리줄을 떼고, LF 를 CRLF 로(안 그러면 줄이 계단처럼 밀린다).
    expect(ptySnapshotReplacement('[screen 100x30 cursor=(row 29, col 0, visible true)]\na\nb')).toBe('\x1b[H\x1b[2Ja\r\nb');
    expect(ptySnapshotReplacement('a\r\nb')).toBe('\x1b[H\x1b[2Ja\r\nb');
  });
});
