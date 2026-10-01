import { debug } from '../debug/log.js';
import { parseSeatAddress, resolveSeat } from '../seat-address/seat-address.js';
import {
  submitIntakeWork,
  type SubmitIntakeWorkDeps,
} from './submit-intake-work.js';
import type { TelegramWorkMessage } from './telegram-work.js';

export interface TelegramSeatWorkDeps extends SubmitIntakeWorkDeps {
  submit?: typeof submitIntakeWork;
}

/** Addressed Telegram work goes through graph intake, not the chat turn. */
export async function handleTelegramSeatWork(
  text: string,
  msg: TelegramWorkMessage,
  deps: TelegramSeatWorkDeps = {},
): Promise<string | null> {
  if (!text.startsWith('@')) return null;
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
