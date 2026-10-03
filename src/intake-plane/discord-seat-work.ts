import { debug } from '../debug/log.js';
import { discordDecisionOwner } from '../decisions/discord-decision-cards.js';
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

export interface DiscordSeatWorkMessage {
  channelId: string;
  messageId: string;
  userId?: string;
  isDm?: boolean;
  threadId?: string;
}

export interface DiscordSeatWorkDeps extends SubmitIntakeWorkDeps {
  submit?: typeof submitIntakeWork;
  config?: UserConfig;
  answer?: typeof answerAsSeat;
  dispatch?: typeof dispatchCeoTask;
  commandDeps?: CeoCommandDeps;
}

/** Addressed work preserves graph intake except for one owner's private seat request. */
export async function handleDiscordSeatWork(
  text: string,
  msg: DiscordSeatWorkMessage,
  deps: DiscordSeatWorkDeps = {},
): Promise<string | null> {
  const owner = (): { cfg: UserConfig; id: string } | null => {
    if (!msg.isDm || !msg.userId) return null;
    const cfg = deps.config ?? getUserConfig();
    const id = discordDecisionOwner(cfg);
    return id && id === msg.userId ? { cfg, id } : null;
  };
  const sendTask = async (seat: string, body: string, cfg: UserConfig, id: string): Promise<string> => {
    const result = await (deps.dispatch ?? dispatchCeoTask)(seat, body, deps.commandDeps ?? ceoTaskDeps(cfg, id), { via: 'discord' });
    debug.log('seat.dispatch', 'intent', { seat, intent: 'task', via: 'discord', outcome: result.channel });
    return result.reply;
  };
  const address = parseSeatAddress(text);
  if (!address) {
    if (!text.trim() || /^\s*[/@＠]/.test(text)) return null;
    const auth = owner();
    const configured = (auth?.cfg.raw?.seatDispatch as { defaultSeat?: unknown } | undefined)?.defaultSeat;
    if (typeof configured !== 'string' || classifyCeoIntent(text) !== 'task') return null;
    const seat = resolveSeat(configured);
    if (!seat) return null;
    const id = canonicalSeatId(seat.id);
    return ['OP', 'TC', 'MK', 'UX'].includes(id) ? sendTask(id, text, auth!.cfg, auth!.id) : null;
  }

  const seats = address.seats.map((name) => ({ name, seat: resolveSeat(name) }));
  const unknown = seats.filter(({ seat }) => !seat).map(({ name }) => `@${name}`);
  if (unknown.length) return `어느 좌석을 말씀하시나요? ${unknown.join(', ')}은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.`;
  const body = address.body.trim();
  if (!body) return '어떤 일을 맡길까요? 좌석 주소 뒤에 요청 내용을 적어 다시 보내 주세요.';

  if (seats.length === 1 && seats[0]?.seat) {
    const auth = owner();
    const seatId = canonicalSeatId(seats[0].seat.id);
    if (auth && ['OP', 'TC', 'MK', 'UX'].includes(seatId)) {
      const intent = classifyCeoIntent(body);
      if (intent === 'task') return sendTask(seatId, body, auth.cfg, auth.id);
      const answer = await (deps.answer ?? answerAsSeat)(seats[0].name, body);
      debug.log('seat.dispatch', 'intent', { seat: seatId, intent, via: 'discord', outcome: answer ? 'answered' : 'intake' });
      if (answer) return answer.text;
    }
  }

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
