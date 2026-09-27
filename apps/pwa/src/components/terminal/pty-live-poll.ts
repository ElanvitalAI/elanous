import type { DaemonTerminalSnapshotResult } from '@/lib/daemon-client';

export const PTY_LIVE_POLL_MS = 800;

export interface PtyLivePollState {
  failures: number;
  stopped: boolean;
  message: string | null;
  screen: string | null;
}

export const initialPtyLivePollState: PtyLivePollState = {
  failures: 0, stopped: false, message: null, screen: null,
};

/** 소유 프로세스 스냅샷 머리의 메타 줄 — `[screen 100x30 cursor=(row 29, col 0, visible true)]`. 화면 글자가 아니다. */
const SNAPSHOT_META_LINE = /^\[screen \d+x\d+ cursor=[^\]\n]*\]\r?\n/;

/** 스냅샷을 xterm 화면 교체 문자열로. 메타 줄을 떼고, 줄바꿈을 CRLF 로 바꾼다
 *  (LF 만 쓰면 xterm 이 줄 맨 앞으로 안 돌아가 줄마다 계단처럼 밀린다 · XtermView 재생과 같은 처리 · 2026-09-27 실물). */
export function ptySnapshotReplacement(screen: string): string {
  const body = screen.replace(SNAPSHOT_META_LINE, '').replace(/\r?\n/g, '\r\n');
  return `\x1b[H\x1b[2J${body}`;
}

export function shouldPollPty(visible: boolean, state: PtyLivePollState): boolean {
  return visible && !state.stopped;
}

export function nextPtyLivePollState(
  state: PtyLivePollState,
  result: DaemonTerminalSnapshotResult | null,
): PtyLivePollState {
  if (state.stopped) return state;
  if (result?.status === 'success' && typeof result.screen === 'string') {
    return { failures: 0, stopped: false, message: null, screen: ptySnapshotReplacement(result.screen) };
  }
  if (result?.status === 'unknown-pty') {
    return { ...state, stopped: true, message: 'PTY 가 끝났습니다' };
  }
  if (result?.status === 'denied') {
    return { ...state, failures: 0, stopped: true, message: result.reason || '화면 조회가 거부되었습니다' };
  }
  const failures = state.failures + 1;
  if (result?.status !== 'owner-unreachable') {
    return {
      ...state, failures, stopped: failures >= 5,
      message: result?.reason || '화면 조회에 실패했습니다',
    };
  }
  return {
    ...state,
    failures,
    stopped: failures >= 5,
    message: failures >= 5 ? '소유 프로세스에 닿지 않습니다' : result.reason ?? null,
  };
}
