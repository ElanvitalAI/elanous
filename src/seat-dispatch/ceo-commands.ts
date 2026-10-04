// The owner hands a seat a task from Telegram: /coo /cto /cmo /cxo → one «[대표] → <seat>» line on the coordination PR,
// one 'ceo-task' message in the seat store, and a «받음» reply. The Telegram entrypoint writes only for the owner in a private chat.
// Goal: 내부 문서 `ASK-the-ceo-cannot-hand-a-seat-a-task-from-telegram-2026-10-02` (C2 phase 1).
import { debug } from '../debug/log.js';
import type { MessageEnvelope } from '../msg/msg-store.js';

export const CEO_SEAT_COMMANDS = { coo: 'OP', cto: 'TC', cmo: 'MK', cxo: 'UX' } as const;
export type CeoSeatCommand = keyof typeof CEO_SEAT_COMMANDS;

export interface CeoCommandContext { chatId: number | string; userId: number | string }

export interface CeoCommandDeps {
  /** Telegram user id of the owner (`telegramDecisionOwner`), null when none is configured. */
  ownerId: string | null;
  /** `decisions.replyGhPr` — "owner/repo#N". */
  replyTarget: string | null;
  runGh: (args: string[], stdin: string) => Promise<number>;
  append: (message: MessageEnvelope) => unknown;
  /** Whether the seat inbox already holds a message carrying this request ref (retry after a crash must not deliver twice). */
  hasMessage?: (seat: string, ref: string) => boolean;
  now?: () => Date;
}

function kstStamp(at: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(at);
}

export function ceoTaskLine(seat: string, task: string, at: Date): string {
  return `**[대표]** ${kstStamp(at)} KST → ${seat} · ${task}`;
}

export async function handleCeoSeatCommand(command: CeoSeatCommand, args: string[], ctx: CeoCommandContext, deps: CeoCommandDeps): Promise<string> {
  const seat = CEO_SEAT_COMMANDS[command];
  if (!deps.ownerId || String(ctx.userId) !== deps.ownerId) {
    debug.log('seat.dispatch', 'refused', { seat, reason: 'not-owner' });
    return '소유자만 쓸 수 있습니다.';
  }
  // A group would show the task to every member — private chat only (same rule as /decisions).
  if (String(ctx.chatId) !== String(ctx.userId)) {
    debug.log('seat.dispatch', 'refused', { seat, reason: 'not-private' });
    return '개인 대화에서만 쓸 수 있습니다.';
  }
  const task = args.join(' ').replace(/\s+/g, ' ').trim();
  if (!task) {
    debug.log('seat.dispatch', 'refused', { seat, reason: 'empty' });
    return `사용법: /${command} <할 일>`;
  }
  return (await dispatchCeoTask(seat, task, deps)).reply;
}

export interface CeoTaskExtra {
  attachments?: Array<{ name: string; path: string }>;
  /** Paths supplied by callers that do not have attachment names. */
  attachmentPaths?: readonly string[];
  via?: 'telegram' | 'discord' | 'pwa' | 'tui';
  /** Request ref written into the message body; with `deps.hasMessage` it makes delivery idempotent per request. */
  ref?: string;
}

export interface CeoTaskResult { reply: string; channel: 'posted' | 'failed' | 'unknown'; channelError?: string }

/** Dispatch an already-authorized seat request; callers must authenticate before invoking this helper. */
export async function dispatchCeoTask(seat: string, text: string, deps: CeoCommandDeps, extra: CeoTaskExtra = {}): Promise<CeoTaskResult> {
  const task = text.replace(/\s+/g, ' ').trim();
  if (!task) {
    debug.log('seat.dispatch', 'refused', { seat, reason: 'empty' });
    return { reply: '할 일을 입력해 주세요.', channel: 'unknown' };
  }
  const attachments = extra.attachments ?? [];
  const attachmentPaths = extra.attachmentPaths ?? [];
  const body = `${task}${attachments.map(({ name, path }) => `\n첨부: ${name} — ${path}`).join('')}${attachmentPaths.length ? `\n\n첨부 파일:\n${attachmentPaths.join('\n')}` : ''}${extra.ref ? `\n요청: ${extra.ref}` : ''}`;
  if (extra.ref && deps.hasMessage?.(seat, extra.ref)) {
    // A retry after a crash between delivery and the journal outcome: the message is already there, and whether
    // the channel line went out is unknown — say so instead of posting it again or claiming it was posted.
    debug.log('seat.dispatch', 'ceo-task-already-delivered', { seat, via: extra.via });
    return { reply: `받음 — ${seat} 메시지함에 이미 있습니다.`, channel: 'unknown' };
  }
  deps.append({ from: 'CEO', to: seat, body, kind: 'ceo-task' });
  debug.log('seat.dispatch', 'ceo-task', { seat, ...(extra.via ? { via: extra.via, attachments: attachments.length + attachmentPaths.length } : {}) });
  const channelError = await postToChannel(seat, task, deps, extra);
  if (channelError) {
    debug.log('seat.dispatch', 'channel-failed', { seat, reason: channelError }, { level: 'warn' });
    return { reply: `받음 — ${seat} 메시지함에는 넣었습니다. 다만 조율 채널에 못 남겼습니다(${channelError}).`, channel: 'failed', channelError };
  }
  return { reply: `받음 — ${seat}에 전했습니다.`, channel: 'posted' };
}

async function postToChannel(seat: string, task: string, deps: CeoCommandDeps, extra: CeoTaskExtra): Promise<string | null> {
  const target = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(deps.replyTarget?.trim() ?? '');
  if (!target) return deps.replyTarget ? 'decisions.replyGhPr 형식이 owner/repo#N 이 아님' : 'decisions.replyGhPr 미설정';
  try {
    const attachmentCount = (extra.attachments?.length ?? 0) + (extra.attachmentPaths?.length ?? 0);
    const code = await deps.runGh(['pr', 'comment', target[2]!, '--repo', target[1]!, '--body-file', '-'], `${ceoTaskLine(seat, task, deps.now?.() ?? new Date())}${attachmentCount ? ` · 첨부 ${attachmentCount}` : ''}${extra.via === 'pwa' ? ' (PWA)' : extra.via === 'tui' ? ' (TUI)' : ''}`);
    return code === 0 ? null : `gh 종료 코드 ${code}`;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 80) : 'gh 실행 실패';
  }
}
