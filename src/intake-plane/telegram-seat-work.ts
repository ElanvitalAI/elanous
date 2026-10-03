import { debug } from '../debug/log.js';
import { telegramDecisionOwner } from '../decisions/telegram-decision-cards.js';
import { canonicalSeatId } from '../msg/msg-store.js';
import { awaitGlobalPersonaLoad, getGlobalPersonaRegistry } from '../persona/global-registry.js';
import type { PersonaSource } from '../persona/mention-parser.js';
import { dispatchCeoTask, type CeoCommandDeps } from '../seat-dispatch/ceo-commands.js';
import { ceoTaskDeps, classifyCeoIntent } from '../seat-dispatch/ceo-intent.js';
import { askSeat, parseSeatAsk, type SeatAskDeps } from '../seat-dispatch/seat-ask.js';
import { parseSeatAddress, resolveSeat } from '../seat-address/seat-address.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { answerAsSeat } from './seat-answer.js';
import { answerAsPersona, resolvePersonaAddress, type PersonaAnswerDeps } from './persona-answer.js';
import {
  submitIntakeWork,
  type SubmitIntakeWorkDeps,
} from './submit-intake-work.js';
import type { TelegramWorkMessage } from './telegram-work.js';

export interface TelegramSeatWorkDeps extends SubmitIntakeWorkDeps {
  submit?: typeof submitIntakeWork;
  config?: UserConfig;
  answer?: typeof answerAsSeat;
  personaSource?: PersonaSource;
  personaAnswer?: typeof answerAsPersona;
  personaAnswerDeps?: PersonaAnswerDeps;
  dispatch?: typeof dispatchCeoTask;
  commandDeps?: CeoCommandDeps;
  askDeps?: SeatAskDeps;
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
    if (parseSeatAsk(text)) {
      const auth = owner();
      if (!auth) return null;
      if (!deps.askDeps) throw new Error('seat ask delivery unavailable');
      return askSeat(text, { channel: 'telegram', chatId: msg.chatId, messageId: msg.messageId,
        ...(msg.threadId ? { threadId: msg.threadId } : {}), ...(msg.botId ? { botId: msg.botId } : {}) },
      deps.commandDeps ?? ceoTaskDeps(auth.cfg, auth.id), deps.askDeps);
    }
    if (!text.trim() || /^\s*[/@＠]/.test(text)) return null;
    const auth = owner();
    const configured = (auth?.cfg.raw?.seatDispatch as { defaultSeat?: unknown } | undefined)?.defaultSeat;
    if (typeof configured !== 'string' || classifyCeoIntent(text) !== 'task') return null;
    const seat = resolveSeat(configured);
    if (!seat) return null;
    const id = canonicalSeatId(seat.id);
    return ['OP', 'TC', 'MK', 'UX'].includes(id) ? sendTask(id, text, auth!.cfg, auth!.id) : null;
  }
  const address = parseSeatAddress(text.replace(/^(@[A-Za-z][A-Za-z0-9_-]*(?:,@?[A-Za-z][A-Za-z0-9_-]*)*)/, (prefix) => prefix.replaceAll(',@', ',')));
  if (!address) return null;

  const seats = address.seats.map((name) => ({ name, seat: resolveSeat(name) }));
  const names = address.seats;
  debug.log('seat-address.telegram', 'parsed', { seats: names });
  const hasUnresolved = seats.some(({ seat }) => !seat);
  const auth = hasUnresolved ? owner() : null;
  if (hasUnresolved && auth && !deps.personaSource) await awaitGlobalPersonaLoad();
  const source = hasUnresolved && auth ? (deps.personaSource ?? getGlobalPersonaRegistry()) : null;
  const addressed = seats.map(({ name, seat }) => ({
    name, seat, persona: !seat && source ? resolvePersonaAddress(name, source) : null,
  }));
  const unknown = addressed.filter(({ seat, persona }) => !seat && (!persona || !auth)).map(({ name }) => `@${name}`);
  if (unknown.length) {
    debug.log('seat-address.telegram', 'rejected', { seats: names, reason: 'unknown-seat' });
    return `어느 좌석을 말씀하시나요? ${unknown.join(', ')}은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.`;
  }
  const personas = addressed.filter(({ persona }) => persona);
  if (personas.length && addressed.length !== 1) {
    debug.log('persona.address', 'rejected', { reason: 'mixed' });
    return '페르소나는 한 번에 하나만 부를 수 있습니다';
  }
  const body = address.body.trim();
  if (!body) {
    debug.log('seat-address.telegram', 'rejected', { seats: names, reason: 'empty-body' });
    return '어떤 일을 맡길까요? 좌석 주소 뒤에 요청 내용을 적어 다시 보내 주세요.';
  }

  if (personas.length === 1 && personas[0]?.persona) {
    const { name, persona } = personas[0];
    debug.log('persona.address', 'resolved', { name, personaId: persona.personaId });
    return (deps.personaAnswer ?? answerAsPersona)(persona, body, deps.personaAnswerDeps);
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
