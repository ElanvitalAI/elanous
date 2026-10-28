// SurfaceUx builders (2026-07-20).
//
// 두 진입점, 하나의 내부 빌더:
//   surfaceUxFromDispatchCtx(ctx)  — DaemonToolDispatchCtx(또는 그 구조적 부분집합)를
//                                    이미 흐르는 4필드로부터 SurfaceUx 로. dispatcher 용.
//   resolveSurfaceUx(input)        — raw 채널/sink/emit 조각으로부터 직접. 조립부(팩토리)용.
// 새 서피스 = resolveSurfaceUx 에 조각만 넘기면 됨(팩토리 한 줄).

import { requestConfirmation, type ConfirmChannel, type ConfirmRequest } from '../../hitl/confirm.js';
import { requestQuestion, type QuestionChannel } from '../../hitl/question.js';
import type { FileSink } from '../../channel/file-sink.js';
import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
} from '../../feedback/envelope.js';
import { debug } from '../../debug/log.js';
import type { SurfaceKind, SurfaceUx } from './types.js';

/** SurfaceUx 를 뒷받침하는 서피스별 조각. 전부 optional — 없는 능력은 no-op/fail-closed. */
const QUESTION_OBSERVATION_MODE = {
  noChannels: 'no-channels',
  answered: 'answered',
  unanswered: 'unanswered',
} as const;

export interface SurfaceUxSource {
  /** 관측/렌더 라벨. */
  surface?: SurfaceKind;
  /** progress 엔벨로프 sessionId(없으면 'unknown'). */
  sessionId?: string;
  /** progress 엔벨로프 parentToolCallId. */
  toolCallId?: string;
  /** HITL 승인 채널(race). 없거나 빈 배열 → confirm fail-closed(false). */
  surfaceHitlChannels?: ConfirmChannel[];
  /** 구조화 질문 채널(race). 없으면 question → null. */
  surfaceQuestionChannels?: QuestionChannel[];
  /** 큰 출력 spill sink. 없으면 spillFile no-op. */
  surfaceFileSink?: FileSink;
  /** 진행 push carrier. 없으면 progress no-op. */
  emitFeedback?: (env: FeedbackEnvelope) => void;
}

/** 내부 공용 빌더 — 두 진입점이 공유. */
function buildSurfaceUx(src: SurfaceUxSource): SurfaceUx {
  const surface: SurfaceKind = src.surface ?? 'unknown';
  const confirmChannels = src.surfaceHitlChannels;
  const questionChannels = src.surfaceQuestionChannels;
  const fileSink = src.surfaceFileSink;
  const emit = src.emitFeedback;
  const interactive = !!(confirmChannels && confirmChannels.length > 0);

  // progress 는 blockId 로 merge — 한 툴 호출의 진행 라인들이 같은 블록으로 갱신되게
  // 안정 blockId + per-instance seq. (Date.now 는 makeEnvelope 내부 · 런타임 코드라 OK)
  const seq = createSeqTracker();
  const progressBlockId = `${src.sessionId ?? 'sess'}:autotool:${src.toolCallId ?? 'run'}`;

  return {
    surface,
    interactive,
    async confirm(req: ConfirmRequest): Promise<boolean> {
      if (!confirmChannels || confirmChannels.length === 0) {
        // fail-closed — 채널 없으면 승인 없음(자동승인 금지·제1원칙).
        debug.log('surface-ux.confirm', 'fail-closed', { surface, reason: 'no-channels' });
        return false;
      }
      const res = await requestConfirmation({
        prompt: req.prompt,
        ...(req.detail ? { detail: req.detail } : {}),
        ...(req.yesLabel ? { yesLabel: req.yesLabel } : {}),
        ...(req.noLabel ? { noLabel: req.noLabel } : {}),
        ...(req.requestId ? { requestId: req.requestId } : {}),
        channels: confirmChannels,
      });
      debug.log('surface-ux.confirm', 'answered', { surface, channel: res.channel, answer: res.answer });
      return res.answer === true;
    },
    async question(req, opts) {
      if (!questionChannels || questionChannels.length === 0) {
        debug.log('surface-ux.confirm', 'question', {
          surface,
          mode: QUESTION_OBSERVATION_MODE.noChannels,
        });
        return null;
      }
      const res = await requestQuestion({ request: req, channels: questionChannels, ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) });
      if (res.channel === 'timeout') {
        debug.log('surface-ux.confirm', 'question', {
          surface,
          mode: 'timeout',
          elapsedMs: res.elapsedMs,
          timeoutMs: opts?.timeoutMs,
        });
        return null;
      }
      if (res.channel === 'all-failed') {
        debug.log('surface-ux.confirm', 'question', {
          surface,
          mode: QUESTION_OBSERVATION_MODE.unanswered,
        });
        return null;
      }
      debug.log('surface-ux.confirm', 'question', {
        surface,
        mode: QUESTION_OBSERVATION_MODE.answered,
      });
      return res.result;
    },
    spillFile(f) {
      if (!fileSink) return;
      const body = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
      fileSink.sendFile(body, {
        ext: f.ext,
        ...(f.name ? { name: f.name } : {}),
        ...(f.caption ? { caption: f.caption } : {}),
      });
    },
    progress(msg, opts) {
      if (!emit) return;
      try {
        emit(
          makeEnvelope(
            {
              kind: 'tool.progress',
              sessionId: src.sessionId ?? 'unknown',
              blockId: progressBlockId,
              phase: opts?.phase ?? 'delta',
              payload: { stream: 'generic', lines: [msg] },
              asciiFallback: [msg],
              ...(src.toolCallId ? { parentToolCallId: src.toolCallId } : {}),
            },
            seq,
          ),
        );
      } catch {
        // best-effort — progress 실패가 턴을 막지 않는다.
      }
    },
  };
}

/** DaemonToolDispatchCtx(또는 그 구조적 부분집합)에서 SurfaceUx 를 만든다.
 *  ctx 는 이미 surfaceHitlChannels/surfaceQuestionChannels/surfaceFileSink/emitFeedback
 *  을 실어 나른다 — dispatcher 가 4필드를 손으로 읽는 대신 이걸 부른다. */
export function surfaceUxFromDispatchCtx(
  ctx: SurfaceUxSource,
  opts?: { surface?: SurfaceKind },
): SurfaceUx {
  return buildSurfaceUx({ ...ctx, ...(opts?.surface ? { surface: opts.surface } : {}) });
}

/** raw 조각(채널·sink·emit)에서 직접 SurfaceUx 를 만드는 팩토리. 조립부(telegram
 *  assembly·ACP daemon-runtime)가 서피스별 프로듀서를 여기 넘긴다. */
export function resolveSurfaceUx(input: SurfaceUxSource): SurfaceUx {
  return buildSurfaceUx(input);
}
