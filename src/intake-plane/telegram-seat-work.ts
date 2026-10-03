import { debug } from '../debug/log.js';
import { telegramDecisionOwner } from '../decisions/telegram-decision-cards.js';
import { canonicalSeatId } from '../msg/msg-store.js';
import { dispatchCeoTask, type CeoCommandDeps } from '../seat-dispatch/ceo-commands.js';
import { ceoTaskDeps, classifyCeoIntent } from '../seat-dispatch/ceo-intent.js';
import { parseSeatAddress, resolveSeat } from '../seat-address/seat-address.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { answerAsSeat } from './seat-answer.js';
import {
  submitIntakeWork,
  type SubmitIntakeWorkDeps,
} from './submit-intake-work.js';
import type { TelegramWorkMessage } from './telegram-work.js';

export interface TelegramSeatWorkDeps extends SubmitIntakeWorkDeps {
  submit?: typeof submitIntakeWork;
  config?: UserConfig;
  answer?: typeof answerAsSeat;
  dispatch?: typeof dispatchCeoTask;
  commandDeps?: CeoCommandDeps;
}

/** Addressed work preserves graph intake except for one owner's private seat request. */
export async function handleTelegramSeatWork(
  text: string,
  msg: TelegramWorkMessage,
  deps: TelegramSeatWorkDeps = {},
): Promise<string | null> {
  const owner = (): { cfg: UserConfig; id: string } | null => {
    if (msg.userId === undefined || String(msg.chatId) !== String(msg.userId)) return null;
    const cfg = deps.config ?? getUserConfig();
    const id = telegramDecisionOwner(cfg);
    return id && id === String(msg.userId) ? { cfg, id } : null;
  };
  const sendTask = async (seat: string, body: string, cfg: UserConfig, id: string): Promise<string> => {
    const result = await (deps.dispatch ?? dispatchCeoTask)(seat, body, deps.commandDeps ?? ceoTaskDeps(cfg, id), { via: 'telegram' });
    debug.log('seat.dispatch', 'intent', { seat, intent: 'task', via: 'telegram', outcome: result.channel });
    return result.reply;
  };
  if (!text.startsWith('@')) {
    if (!text.trim() || /^\s*[/@＠]/.test(text)) return null;
    const auth = owner();
    const configured = (auth?.cfg.raw?.seatDispatch as { defaultSeat?: unknown } | undefined)?.defaultSeat;
    if (typeof configured !== 'string' || classifyCeoIntent(text) !== 'task') return null;
    const seat = resolveSeat(configured);
    if (!seat) return null;
    const id = canonicalSeatId(seat.id);
    return ['OP', 'TC', 'MK', 'UX'].includes(id) ? sendTask(id, text, auth!.cfg, auth!.id) : null;
  }
  const address = parseSeatAddress(text);
  if (!address) return null;

  const seats = address.seats.map((name) => ({ name, seat: resolveSeat(name) }));
  const names = address.seats;
  debug.log('seat-address.telegram', 'parsed', { seats: names });
  const unknown = seats.filter(({ seat }) => !seat).map(({ name }) => `@${name}`);
  if (unknown.length) {
    debug.log('seat-address.telegram', 'rejected', { seats: names, reason: 'unknown-seat' });
    return `어느 좌석을 말씀하시나요? ${unknown.join(', ')}은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.`;
  }
  const body = address.body.trim();
  if (!body) {
    debug.log('seat-address.telegram', 'rejected', { seats: names, reason: 'empty-body' });
    return '어떤 일을 맡길까요? 좌석 주소 뒤에 요청 내용을 적어 다시 보내 주세요.';
  }

  if (seats.length === 1 && seats[0]?.seat) {
    const auth = owner();
    const seatId = canonicalSeatId(seats[0].seat.id);
    if (auth && ['OP', 'TC', 'MK', 'UX'].includes(seatId)) {
      const intent = classifyCeoIntent(body);
      if (intent === 'task') return sendTask(seatId, body, auth.cfg, auth.id);
      const answer = await (deps.answer ?? answerAsSeat)(seats[0].name, body);
      debug.log('seat.dispatch', 'intent', { seat: seatId, intent, via: 'telegram', outcome: answer ? 'answered' : 'intake' });
      if (answer) return answer.text;
    }
  }

  const reportTo = {
    channel: 'telegram' as const,
    chatId: msg.chatId,
    ...(msg.botId ? { botId: msg.botId } : {}),
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
  };
  const replies: string[] = [];
  for (const { seat } of seats) {
    if (!seat) continue;
    const label = seat.title ?? seat.id;
    let result: Awaited<ReturnType<typeof submitIntakeWork>>;
    try {
      result = await (deps.submit ?? submitIntakeWork)({
        text: `@${label} ${body}`,
        track: 'graph',
        origin: {
          kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram',
          ref: `telegram:${msg.chatId}:${msg.messageId}`, reportTo,
        },
      }, deps);
    } catch (error) {
      // 접수 문이 던져도 사람은 같은 대화에서 결과를 받는다(리뷰 must-fix: 예외 시 응답 누락).
      debug.log('seat-address.telegram', 'rejected', { seats: [label], reason: 'submission-threw' });
      replies.push(`@${label} 접수 실패 — ${String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 200)}`);
      continue;
    }
    if (result.ok && result.track === 'graph') {
      debug.log('seat-address.telegram', 'enqueued', { seats: [label] });
      replies.push(`@${label} 접수번호: ${result.acceptanceId}`);
    } else {
      debug.log('seat-address.telegram', 'rejected', { seats: [label], reason: 'submission-failed' });
      replies.push(`@${label} 접수 실패 — ${result.ok ? '접수번호가 없습니다' : result.reason.split('\n')[0]!.slice(0, 200)}`);
    }
  }
  return replies.join('\n');
}
