// ⭐ ELN-SEAT-INBOX-TURN-BOUNDARY — 턴 경계 우편 자동 수신의 dashboard 배선.
// 사이즈 계약(src/tui/size-contract.test.ts — index.ts 순증가 0) 때문에 index.ts 는 이 팩토리
// 호출 1줄만 남기고, 자리 id 해석·상태 루트 조립·fail-soft 는 전부 이 모듈이 흡수한다.
// cwd 는 지연 평가(getCwd)로 받는다 — index.ts 에서 workingDir 선언(부팅 후반)보다 이 배선이
// 먼저 만들어져도 선언 전 사용(TDZ · TSC 2448)이 걸리지 않게, 실제 해석은 첫 턴 종료 시점에 한다.
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createSeatMailInbox, resolveSeatId, type SeatMailInboxController } from '../tui/seat-mail-boot.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { seatInboxAlivePath } from '../loops/inbox-liveness.js';
import { resolveSeatStateRoot } from '../loops/msg-wake.js';

export interface SeatMailInboxWiringDeps extends Pick<Parameters<typeof createSeatMailInbox>[0], 'startTurnIfIdle' | 'log'> {
  getCwd: () => string;
  /** §2b 박동 세션 id 공급원(OP #93799) — 세션이 박동 시작 후 확정되는 자리를 위해 lazy 공급. 없으면 박동 자체를 만들지 않는다(빈 id 박동 방지). */
  getSessionId?: () => (string | null);
  /** 박동 alive 파일 루트 오버라이드(시험용). 기본: resolveSeatStateRoot(). */
  seatStateRoot?: string;
}

export interface SeatMailInboxWiring {
  noteTurnEnded(): void;
  stop(): void;
}

/**
 * 판 밖 cwd(자리 id 없음)이거나 뭐가 하나라도 실패해도 예외를 밖으로 안 던지는 no-throw 파사드 —
 * 우편 인박스가 부팅이나 턴 정리를 막지 않게 한다. 실제 수신·주입·ack 은 createSeatMailInbox
 * (seat-mail-boot.ts) 가 담당: 턴 settle 순간에만 재고, 주입은 H2 문 startTurnIfIdle 로만.
 * 인박스 생성(자리 id 해석 포함)도 noteTurnEnded/stop 첫 호출까지 미룬다 — 부팅 순서 무관.
 */
export function createSeatMailInboxWiring(deps: SeatMailInboxWiringDeps): SeatMailInboxWiring {
  let inbox: SeatMailInboxController | null = null;
  let settled = false;
  const ensure = (): SeatMailInboxController | null => {
    if (settled) return inbox;
    settled = true;
    try {
      const seat = resolveSeatId(deps.getCwd());
      if (seat === null) return null;
      inbox = createSeatMailInbox({
        seat,
        msgPath: join(elanousStateRoot(), 'msg', 'messages.db'),
        startTurnIfIdle: deps.startTurnIfIdle,
        log: deps.log,
        // §2b inbox heartbeat (sprint O5 ③ · OP #93799) — 세션 id 공급원이 있을 때만 박동을 만든다.
        // alive 파일은 자리 상태 루트의 자리 폴더에, sessionId 는 getSessionId 로 매 박동 재평가.
        ...(deps.getSessionId ? {
          heartbeat: {
            alivePath: seatInboxAlivePath(deps.seatStateRoot ?? resolveSeatStateRoot(), seat),
            host: hostname(),
            getSessionId: deps.getSessionId,
          },
        } : {}),
      });
    } catch { inbox = null; /* fail-soft: 인박스 부재로 부팅이 막히지 않게 */ }
    return inbox;
  };
  return {
    noteTurnEnded() { try { ensure()?.noteTurnEnded(); } catch { /* fail-soft */ } },
    stop() { try { ensure()?.stop(); } catch { /* fail-soft */ } },
  };
}
