// ── 상태줄 «실행 판» 값 — 이 TUI 프로세스가 실은 코드의 판 ⊕ 재기동 필요 여부 ──
//
// ⛔ 하단 `⌥ HEAD@<sha>` 는 세션 cwd 트리의 HEAD 다(실은 코드 아님). 이 값은 기동 판(`runningBuild`)을
//    설치본 `current`(설치본으로 떴을 때) 또는 코드 뿌리 HEAD(체크아웃으로 떴을 때)와 비교한다.
// 매 draw 마다 불리므로 비교 대상 판독은 `ttlMs` 로 묶는다(설치 갱신 감지는 분 단위면 충분하다).

import type { RunningBuildState } from '../status/bar.js';
import {
  judgeBuildStaleness, readCheckoutHead, readCurrentInstallRecord, runningBuild,
  type InstalledRecord,
} from '../pty-shell/tui-run-state.js';
import type { PtyBuildIdentity } from '../pty-shell/pty-manifest.js';
import { debug } from '../debug/log.js';
import { matchFailureEvent, recordFailureSignatureMatch } from '../self-health/signatures.js';

export interface RunningBuildStatusDeps {
  readonly build?: () => PtyBuildIdentity;
  readonly readInstalled?: () => InstalledRecord;
  readonly readCheckoutHead?: (codeRoot: string) => string | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export function createRunningBuildStatus(deps: RunningBuildStatusDeps = {}): () => RunningBuildState {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 60_000;
  let cached: RunningBuildState = { sha: '', stale: null };
  let readAt = -Infinity;
  let reportedStaleSha: string | undefined;
  const log = deps.log ?? ((c: string, e: string, d: Record<string, unknown>) => debug.log(c, e, d));
  // 옛 판(결함 #13)은 «넘어가는 순간» 한 번만 남긴다 — 매 판독(분 단위)마다 쌓지 않는다.
  const reportStale = (state: RunningBuildState): void => {
    if (state.stale !== true) {
      // 해소되면 잊는다 — 같은 실행 판이 다시 옛 판이 되는 «두 번째 전환»도 센다.
      if (state.stale === false) reportedStaleSha = undefined;
      return;
    }
    if (reportedStaleSha === state.sha) return;
    reportedStaleSha = state.sha;
    try {
      const data = { sha: state.sha, currentSha: state.currentSha ?? null };
      log('tui.run-state', 'stale', data);
      const signature = matchFailureEvent({ category: 'tui.run-state', event: 'stale', data });
      if (signature) recordFailureSignatureMatch(signature, 'status-bar', log);
    } catch { /* fail-soft — 관측이 상태줄을 막지 않는다 */ }
  };
  return () => {
    const t = now();
    if (t - readAt < ttlMs) return cached;
    readAt = t;
    // 판을 모르면 칸을 숨기지 않고 «▶ 실행 ?» 로 — 모른다는 것도 보여야 트리 HEAD 와 헷갈리지 않는다.
    let build: PtyBuildIdentity;
    try { build = (deps.build ?? runningBuild)(); } catch { cached = { sha: '', stale: null }; return cached; }
    if (!build.sha) { cached = { sha: '', stale: null }; return cached; }
    // 비교 대상 판독이 터져도 기동 판은 보인다 — «비교 불가(?)»로.
    try {
      const installed = build.source === 'installed' ? (deps.readInstalled ?? readCurrentInstallRecord)() : {};
      const checkoutHead = build.source === 'checkout' && build.codeRoot
        ? (deps.readCheckoutHead ?? readCheckoutHead)(build.codeRoot)
        : undefined;
      const verdict = judgeBuildStaleness({ build, installed, ...(checkoutHead ? { checkoutHead } : {}) });
      cached = {
        sha: build.sha,
        stale: verdict.stale,
        ...(verdict.stale === true ? { currentSha: build.source === 'installed' ? installed.sha : checkoutHead } : {}),
      };
      reportStale(cached);
    } catch {
      cached = { sha: build.sha, stale: null };
    }
    return cached;
  };
}
