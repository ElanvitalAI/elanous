// ── 상태줄 «⧗ 백그라운드 N» 상태 (TUI-BG-JOB-VISIBILITY · TUI 결함 #71 · 0.2.31) ──────────────
//
// 🚨 무엇을 푸는가: 10-16 07:3x OPT 가 «남은 리뷰 4건 실행 중 · 다음 점검 = …» 으로 턴을 «✔ 완료» 로
//   끝냈다. 상태줄엔 백그라운드 표시가 없어 바깥(OP·대표)에선 «12분 유휴» 로 보였다.
// ⭐ 이 모듈은 «상태줄에 몇 개를 그릴지» 와 그 관측만 쥔다 — 렌더는 `backgroundJobsSegment`
//   (src/status/bar.ts), 집계는 BackgroundSurface 의 `background`(src/shell-runner/background-surface.ts).
// ⛔ 깨우기(끝나면 턴을 여는 것)는 하지 않는다 — TUI-AGENT-IDLE-WAKE 칸(onEnqueue 배선 · H2 문) 몫.
// ⛔ 입력칸·외부 입력 대기열 주입 0(대표 비침투).
//
// 세 얼굴:
//   관측 = debug.log('status.bar', 'bg-jobs', { running, backgrounded, background, trigger:'rollup' })
//          — 등록된 백그라운드 수가 «바뀔 때만»(렌더마다·같은 수 반복엔 안 남긴다 · 처음 기준 = 0)
//   인지 = 등록된 백그라운드 일 > 0 이면 턴이 유휴여도 «일하는 중»
//   힐링 = 상태줄 «⧗ 백그라운드 N» — 사람·OP 가 «유휴인데 일하는 중» 을 본다 · 수가 바뀌면 다시 그린다 ·
//          읽기 실패는 0 으로 보고 상태줄을 막지 않는다 · 실패 시 TF(관측 로그)

import { debug } from '../debug/log.js';
import type { BackgroundJobsSummary } from '../status/bar.js';

export interface ShellRollupCounts {
  running: number;
  backgrounded: number;
  /** 턴을 넘어 사는 핸들(bg 모드 ⊕ backgrounded). 필수 — backgrounded 로 추정하면 도는 bg 모드 일을 빠뜨린다. */
  background: number;
}

export interface BackgroundJobsStatusDeps {
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface BackgroundJobsStatus {
  /** 집계가 왔다 — 등록된 백그라운드 수가 바뀌었으면 관측 한 줄 ⊕ true(호출자가 다시 그린다). */
  noteRollup(rollup: ShellRollupCounts): boolean;
  /** 상태줄 입력. */
  summary(): BackgroundJobsSummary;
}

function countOf(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function createBackgroundJobsStatus(deps: BackgroundJobsStatusDeps = {}): BackgroundJobsStatus {
  const log = deps.log ?? ((event, data) => { debug.log('status.bar', event, data); });
  // 처음 기준은 0 — 백그라운드 0 인 첫 집계(인라인 실행 등)는 «변화 없음» 이라 안 남긴다.
  let background = 0;

  return {
    noteRollup(rollup) {
      const next = countOf(rollup.background);
      if (next === background) return false;
      background = next;
      try {
        log('bg-jobs', {
          running: countOf(rollup.running),
          backgrounded: countOf(rollup.backgrounded),
          background: next,
          trigger: 'rollup',
        });
      } catch { /* 관측 실패가 상태줄을 막지 않는다 */ }
      return true;
    },
    summary() {
      return { background };
    },
  };
}
