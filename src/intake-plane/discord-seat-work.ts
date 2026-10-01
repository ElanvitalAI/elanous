import { parseSeatAddress, resolveSeat } from '../seat-address/seat-address.js';
import {
  submitIntakeWork,
  type SubmitIntakeWorkDeps,
} from './submit-intake-work.js';

export interface DiscordSeatWorkMessage {
  channelId: string;
  messageId: string;
  threadId?: string;
}

export interface DiscordSeatWorkDeps extends SubmitIntakeWorkDeps {
  submit?: typeof submitIntakeWork;
}

/** Addressed Discord work goes through the graph intake door, not the chat turn. */
export async function handleDiscordSeatWork(
  text: string,
  msg: DiscordSeatWorkMessage,
  deps: DiscordSeatWorkDeps = {},
): Promise<string | null> {
  const address = parseSeatAddress(text);
  if (!address) return null;

  const seats = address.seats.map((name) => ({ name, seat: resolveSeat(name) }));
  const unknown = seats.filter(({ seat }) => !seat).map(({ name }) => `@${name}`);
  if (unknown.length) return `어느 좌석을 말씀하시나요? ${unknown.join(', ')}은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.`;
  const body = address.body.trim();
  if (!body) return '어떤 일을 맡길까요? 좌석 주소 뒤에 요청 내용을 적어 다시 보내 주세요.';

  const reportTo = {
    channel: 'discord' as const,
    channelId: msg.channelId,
    ...(msg.threadId ? { discordThreadId: msg.threadId } : {}),
  };
  const replies: string[] = [];
  for (const { seat } of seats) {
    if (!seat) continue;
    const label = seat.title ?? seat.id;
    const result = await (deps.submit ?? submitIntakeWork)({
      text: `@${label} ${body}`,
      track: 'graph',
      origin: {
        kind: 'external', ledgerSource: 'memo', provider: 'other',
        ref: `discord:${msg.channelId}:${msg.messageId}`, reportTo,
      },
    }, deps);
    if (result.ok && result.track === 'graph') {
      replies.push(`@${label} 접수번호: ${result.acceptanceId}`);
    } else {
      replies.push(`@${label} 접수 실패 — ${result.ok ? '접수번호가 없습니다' : result.reason.split('\n')[0]!.slice(0, 200)}`);
    }
  }
  return replies.join('\n');
}
