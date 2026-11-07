// ── autopilot 상태 루트 (ISO-3 · 2026-07-13) ─────────────────────────────────
//
// 미션 오발송 사건(2026-07-13): autopilot 스토어(미션 DB·origin·무장류)가
// homedir 고정이라 격리 테스트 데몬이 **운영 미션을 보고** 알림/실행까지
// 했다 — config 를 격리(ISO-1/2)해도 이 구멍으로 운영이 오염된다.
//
// 해소: 전 autopilot 경로가 `ELANOUS_STATE_DIR` 을 존중(logs.db·surface-events
// 동형). 격리 테스트 인스턴스는 빈 미션 우주에서 시작하고, 무장류
// (autopilot.json 등)는 test 루트에 부재 → fail-closed(DISARMED)가 기본.
//
// env 는 임포트 시점이 아니라 **호출 시점**에 읽는다(lazy — 부팅 순서 무관·
// log-store.ts logsDbPath 선례).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { logDiagnostic } from '../mss/logging/diagnostic-sink.js';

/** `ELANOUS_STATE_DIR ?? ~/.elanous` — autopilot 계열 경로의 단일 루트. */
export function elanousStateRoot(): string {
  const stateDir = process.env.ELANOUS_STATE_DIR?.trim();
  // ⚠️ env 값도 **리졸버를 거쳐 정규화**한다 — 여기서만 raw 로 돌려주면 상대경로·후행 슬래시에서
  //    config-dir(정규화됨)과 두 축이 실제로 갈라진다(이 트랙의 근본과 같은 결함).
  try {
    const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
    return effectiveInstanceRoot();
  } catch (e) {
    // ⚠️ 조용한 prod 폴백은 '격리 해석 실패 → 운영을 만짐' 이라는 fail-open 경로다.
    //    부팅 불침몰은 유지하되 **반드시 관측을 남긴다**(제1원칙).
    try {
      logDiagnostic('instance.identity', 'state-root-resolver-failed', {
        error: e instanceof Error ? e.message : String(e),
        envStateDir: stateDir ?? null,
        why: '리졸버 실패 — prod 로 폴백(격리를 의도했다면 운영 오염 위험이므로 조사 필요)',
      });
    } catch { /* */ }
    return stateDir && stateDir.length > 0 ? stateDir : join(homedir(), '.elanous');
  }
}
