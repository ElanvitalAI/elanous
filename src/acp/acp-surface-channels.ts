// ACP 서피스 채널 — ConfirmChannel/QuestionChannel 을 ACP 클라이언트로 (P0b · 2026-07-20)
//
// DESIGN-cross-surface-autonomy-membrane §10 P0b. ACP 코어 데몬 턴(createDaemonRunTurn → toolSurface dispatch·
// SelfImplement 가 도는 경로)엔 ConfirmChannel/QuestionChannel 이 없었다(ACP HITL 은 permission approver·
// elanous/ask 브릿지라는 다른 추상화). 이 어댑터가 `pushAskRequest`(elanous/ask → iPhone/PWA 시트)를 감싸
// SurfaceUx 가 소비하는 ConfirmChannel/QuestionChannel 로 만든다 → 막(SurfaceUx)이 ACP 서피스도 얻는다.
//
// ★ additive·fail-soft: pusher 가 null(붙은 peer 없음/미지원) 반환 → 채널이 null 반환 → requestConfirmation
//   이 그 채널을 drop → 채널 없으면 fail-closed(PR 안 열림). 즉 배선돼도 기존 안전(자동승인 금지) 불변.
// ★ 순수 매핑(주입된 pusher) — 테스트 가능. 실 pushAskRequest 는 daemon-runtime 이 getActiveAcpAskPusher 로 주입.

import type { ConfirmChannel, ConfirmRequest, HitlAnswer } from '../hitl/confirm.js';
import type { QuestionChannel } from '../hitl/question.js';
import type { AskUserQuestionRequest, AskUserQuestionResult } from '../ask-user-question/types.js';
import type { ElanousAskRequestPayload } from './ask-extensions.js';
import { debug } from '../debug/log.js';

/** ACP ask pusher — sessionId 로 붙은 cap-able peer 에 elanous/ask 를 보내고 답을 await. null=peer 없음/미지원. */
export type AcpAskPusher = (sessionId: string, payload: ElanousAskRequestPayload) => Promise<AskUserQuestionResult | null>;

let askSeq = 0;
function nextAskId(sessionId: string, requestId?: string): string {
  return `acp-${sessionId}-${requestId ?? `s${askSeq++}`}`;
}

/** confirm(y/n)을 2옵션 AskUserQuestion 으로 ACP 클라이언트에 — 답 === yesLabel → true. peer 없으면 null(drop·fail-closed). */
export function createAcpConfirmChannel(sessionId: string, pusher: AcpAskPusher): ConfirmChannel {
  return {
    name: 'acp',
    async request(req: ConfirmRequest): Promise<HitlAnswer | null> {
      const yes = req.yesLabel ?? 'Yes';
      const no = req.noLabel ?? 'No';
      const question = req.detail ? `${req.prompt}\n${req.detail}` : req.prompt;
      const payload: ElanousAskRequestPayload = {
        id: nextAskId(sessionId, req.requestId),
        request: {
          questions: [{
            id: 'confirm', header: req.header ?? '승인', question,
            options: [{ label: yes, description: '' }, { label: no, description: '' }],
            ...(req.header === '배포' ? { recommendedIndex: 1 } : {}),
            includeOther: false,
          }],
        },
      };
      const result = await pusher(sessionId, payload);
      if (!result || result.cancelled || result.answeredBy === 'agent') {
        debug.log('acp.surface-channel', 'confirm-drop', { sessionId, reason: result ? 'cancelled' : 'no-peer' });
        return null; // drop → requestConfirmation fail-closed
      }
      const ok = result.answers['confirm'] === yes;
      debug.log('acp.surface-channel', 'confirm', { sessionId, answer: ok });
      return ok;
    },
    cancel() { /* pushAskRequest 는 자체 타임아웃/취소 — no-op */ },
  };
}

/** 구조화 질문을 ACP 클라이언트에 그대로(멀티옵션 시트). peer 없으면 null(drop). */
export function createAcpQuestionChannel(sessionId: string, pusher: AcpAskPusher): QuestionChannel {
  return {
    name: 'acp',
    async ask(req: AskUserQuestionRequest): Promise<AskUserQuestionResult | null> {
      const result = await pusher(sessionId, { id: nextAskId(sessionId), request: req });
      if (!result) debug.log('acp.surface-channel', 'question-drop', { sessionId, reason: 'no-peer' });
      return result ?? null;
    },
    cancel() { /* no-op */ },
  };
}
