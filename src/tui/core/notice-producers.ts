import type { NextTuiQueueItem, NextTuiQueueMailSpan, NextTuiQueueNoticeSource, NextTuiQueueTriageMeta } from './queue.js';
import { isUrgentSeatMail } from '../seat-mail-priority.js';
import { SEAT_MAIL_DIGEST_BODY_CHARS, SEAT_MAIL_PASSIVE_DIGEST_BODY_CHARS, seatMailDigestLine, seatMailDigestPrefix } from '../seat-mail-digest.js';
import { seatMailRoute } from '../seat-mail-turn-policy.js';
import { seatMessageContextBlock, type ContextHeaderInput } from '../../msg/msg-context-header.js';
import type { MessageOrigin } from '../../msg/msg-store.js';
import { legacyIntent } from '../../msg/msg-receipts.js';
import { classifySeatMail } from '../queue-finish-first.js';
import { FEDERATION_WORK_ORDER_NOTE, federationWorkOrderFrame, neutraliseFrameTags } from '../../chat/interjection.js';
import { seatMailTrustFor } from '../../msg/seat-mail-trust.js';

/**
 * ELN-CHILD-NOTICE-INTO-QUEUE (IMPL-TASK-QUEUE-1117 D칸) — 완료·도착 사건을 입력 큐의
 * `notice` 항목으로 만드는 생산자. 큐(queue.ts)는 순서만 소유하고, 이 파일은 «무엇이
 * 알림이 되는가»(사이드탭 결과 · 하니스 자식 종료 · 자리 우편 도착 · 감시 출력 줄)와 문구를 소유한다.
 */

/** 큐에서 생산자가 쓰는 표면만 — 단위시험은 가짜 없이 진짜 큐를 그대로 쓴다. */
export interface ChildNoticeQueue {
  enqueueNotice(text: string, source: NextTuiQueueNoticeSource, meta?: { msgId?: number; occurredAt?: number; urgent?: boolean; passive?: boolean; digest?: string; mailClass?: 'P0' | 'P1' | 'P2'; mailIntent?: string; mailKind?: string; replyTo?: number; mail?: NextTuiQueueMailSpan; triage?: NextTuiQueueTriageMeta }): NextTuiQueueItem;
  enqueueCapsuleDoneNotice?(text: string, capsuleId: string, status: string, occurredAt?: number, wake?: boolean): NextTuiQueueItem | null;
  readonly items: readonly NextTuiQueueItem[];
}

/** 사이드탭 미션 결과 한 줄 — 상태와 결과 파일 경로가 있으면 함께. */
export function sidetabResultNotice(result: { mission: string; status: string; resultPath?: string }): string {
  const base = `사이드탭 미션 완료: ${result.mission} — ${result.status}`;
  return result.resultPath === undefined ? base : `${base} · 결과 ${result.resultPath}`;
}

/** 하니스 자식(위임 루프) 종료 한 줄. */
export function harnessChildNotice(info: { goal: string; outcome: string }): string {
  return `하니스 자식 종료: ${info.goal} — ${info.outcome}`;
}

/** CAPSULE-B1 — 배경 캡슐 완료 한 줄(초인종). 결과 본문은 자식의 task-notification 배수가 그 턴에 싣는다. */
export function capsuleDoneNotice(event: { capsuleId: string; kind: string; status: string; summary: string }): string {
  return `캡슐 완료: ${event.kind} ${event.summary} — ${event.status} · capsule:${event.capsuleId}`;
}

/** 자리 우편 도착 한 줄 — 안 읽은 수는 도착 시점 스냅숏. */
export function seatMailNotice(info: { seat: string; unread: number }): string {
  return `${info.seat} 우편 도착 · 안 읽은 ${info.unread}건`;
}

/** 감시 한 줄의 최대 길이 — 말줄임 포함, 이 길이를 넘기지 않는다. */
export const EVENT_WATCH_LINE_MAX = 200;

/**
 * 한도 안으로 자른다. 넘치면 끝의 한 글자를 `…` 로 바꿔 전체 길이가 한도와 같다.
 */
export function trimEventWatchLine(text: string, max: number = EVENT_WATCH_LINE_MAX): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

/**
 * 접두어·명령·접미어를 한 줄로 잇되, 길면 명령만 줄인다.
 * 종료 코드·실패 이유는 접미어라 명령보다 먼저 남긴다.
 * 접미어 자체가 한도를 넘으면 접미어 끝을 말줄임하고, 그 뒤 줄 전체를 다시 자르지 않는다.
 */
export function eventWatchStatusLine(prefix: string, command: string, suffix: string): string {
  const sep = ' — ';
  const budget = EVENT_WATCH_LINE_MAX - prefix.length - sep.length;
  if (budget <= 1) return trimEventWatchLine(`${prefix}${sep}${suffix}`);
  // One column stays for the command mark. A suffix that fills the budget
  // used to drop the command and leave "prefix  — reason".
  const tailBudget = Math.max(0, budget - 1);
  const tail = suffix.length <= tailBudget
    ? suffix
    : `${suffix.slice(0, Math.max(0, tailBudget - 1))}…`;
  const room = budget - tail.length;
  const kept = command.length <= room
    ? command
    : room <= 1
      ? '…'
      : `${command.slice(0, room - 1)}…`;
  const line = `${prefix}${kept}${sep}${tail}`;
  return line.length <= EVENT_WATCH_LINE_MAX ? line : trimEventWatchLine(line);
}

/**
 * 감시 출력 한 줄(OP-EVENT-WATCH-WAKE). 빈 줄·공백뿐인 줄은 알림이 아니다(null).
 * 줄 끝 개행은 떼고, 한도를 넘으면 말줄임 포함 길이가 한도와 같다.
 */
export function eventWatchNotice(line: string): string | null {
  const trimmed = line.replace(/[\r\n]+$/u, '').trim();
  if (trimmed.length === 0) return null;
  return trimEventWatchLine(trimmed);
}

/** SEAT-INBOX B1-C §3a — 메시지 한 통 = notice 한 항목. 문구 = §5d 머리줄 ⊕ msg:<id> ⊕ 전문(모델 맥락 그대로). */
export type SeatMessageNoticeInput = ContextHeaderInput & { id: number; body: string; origin?: MessageOrigin;
  /** BULK-TRIAGE — the recipient seat, the ledger deadline and priority (structured · only the triage card reads them). */
  recipient?: string; deadlineAt?: string; priority?: number;
  createdAt?: string; unreadTotal?: number; replyTo?: number;
  /** SEAT-MAIL-PASSIVE-DEFAULT — the structured fields the turn router reads (seat-mail-turn-policy.ts). */
  refs?: readonly string[]; resultState?: 'done' | 'failed'; needsAck?: boolean; doneWhen?: string;
  /** The sender sits above the recipient on the federation ladder (computed by the arrival watcher; absent = unknown). */
  senderAbove?: boolean;
  /** SEAT-TURN-FOLLOWUPS ② — replyTo is a mail this seat sent · a `cell:` ref names a cell this seat owns/assigned. */
  replyToOwn?: boolean; cellDelegated?: boolean;
  /** LEADER-HAND-CONTRACT ② — the leader ✋ card appended after the mail (open ✋ table ⊕ standard answers ⊕ seat memories). */
  handCard?: string };
export function seatMessageNotice(message: SeatMessageNoticeInput, declaredSeats?: ReadonlySet<string>): string {
  return seatMessageNoticeParts(message, declaredSeats).text;
}

/**
 * FED-MAIL-WORK-ORDER — the notice text and where the mail's own body sits in it. Mail from a declared federation seat
 * (or a crown relay) is a work order: lead note ⊕ `<federation_work_order>` frame (body tags neutralised). Any other
 * mail keeps the plain header block unchanged. Trust comes from structured fields only.
 */
export function seatMessageNoticeParts(message: SeatMessageNoticeInput, declaredSeats?: ReadonlySet<string>, viaLedger = false): { text: string; bodyAt: number; bodyLength: number } {
  // Same origin source as the mid-turn path (arrival.origin.kind); `fromKind` only for callers that carry no origin.
  const trust = seatMailTrustFor({ from: message.fromSeat ?? message.sender, originKind: message.origin?.kind ?? message.fromKind ?? null,
    crownDirective: message.crownDirective ?? null, viaLedger }, declaredSeats);
  const tail = message.unreadTotal === undefined ? '' : `\n\n[미읽음 총 ${message.unreadTotal}통]`;
  if (!trust.trusted) {
    const block = seatMessageContextBlock(message);
    return { text: `${block}${tail}`, bodyAt: block.length - message.body.length, bodyLength: message.body.length };
  }
  const body = neutraliseFrameTags(message.body);
  const frame = federationWorkOrderFrame({ msgId: message.id, from: message.fromSeat ?? message.sender,
    intent: message.intent ?? legacyIntent(message.kind), crownDirective: message.crownDirective ?? null });
  const lead = `${FEDERATION_WORK_ORDER_NOTE}\n${frame.open}\n`;
  const block = seatMessageContextBlock({ ...message, body });
  return { text: `${lead}${block}\n${frame.close}${tail}`, bodyAt: lead.length + block.length - body.length, bodyLength: body.length };
}

/**
 * 생산자 묶음. 같은 (source, text) 가 아직 큐에 있으면 다시 넣지 않는다 — 같은 사건의
 * 중복 알림이 대기열을 채우는 일을 막는다. 내용이 달라지면(예: 안 읽은 수 증가) 별도 항목.
 */
export function createChildNoticeProducers(queue: ChildNoticeQueue) {
  const enqueueOnce = (
    text: string,
    source: NextTuiQueueNoticeSource,
    occurredAt?: number,
  ): NextTuiQueueItem | null => {
    const stillQueued = queue.items.some(
      (item) => item.kind === 'notice' && item.source === source && item.text === text,
    );
    if (stillQueued) return null;
    return queue.enqueueNotice(text, source, occurredAt === undefined ? {} : { occurredAt });
  };
  return {
    sidetabResult(result: Parameters<typeof sidetabResultNotice>[0], occurredAt?: number): NextTuiQueueItem | null {
      return enqueueOnce(sidetabResultNotice(result), 'sidetab', occurredAt);
    },
    harnessChildFinished(info: Parameters<typeof harnessChildNotice>[0], occurredAt?: number): NextTuiQueueItem | null {
      return enqueueOnce(harnessChildNotice(info), 'harness-child', occurredAt);
    },
    /** RUNSHELL-BG-ENDS-TURN — `wake`: the capsule's started result promised a wake (the row is actionable at once). */
    capsuleDone(event: Parameters<typeof capsuleDoneNotice>[0], occurredAt?: number, wake?: boolean): NextTuiQueueItem | null {
      if (queue.enqueueCapsuleDoneNotice) return queue.enqueueCapsuleDoneNotice(
        capsuleDoneNotice(event), event.capsuleId, event.status, occurredAt, wake);
      return enqueueOnce(capsuleDoneNotice(event), 'capsule-done', occurredAt);
    },
    seatMailArrived(info: Parameters<typeof seatMailNotice>[0], occurredAt?: number): NextTuiQueueItem | null {
      return enqueueOnce(seatMailNotice(info), 'seat-mail', occurredAt);
    },
    /** NODE-INNER-PROGRESS «추가» 4) — a graph node with no ledger activity past 25 minutes (✕), sidetab or not. */
    graphNodeStalled(text: string, occurredAt?: number): NextTuiQueueItem | null {
      return enqueueOnce(text, 'graph-node', occurredAt);
    },
    /**
     * 감시 출력 한 줄. 빈 줄은 넣지 않고, 같은 줄이 아직 대기 중이면 한 번만.
     * 알림은 조향하지 않는다 — 쉬는 경계에서 큐가 자기 턴으로 연다(#38102 문).
     */
    eventWatchLine(line: string, occurredAt?: number): NextTuiQueueItem | null {
      const text = eventWatchNotice(line);
      if (text === null) return null;
      return enqueueOnce(text, 'event-watch', occurredAt);
    },
    /**
     * SEAT-INBOX B1-C — 메시지 단위 생산자. 같은 msgId 가 아직 대기 중이면 다시 넣지 않는다(불변식 2).
     * 돌려준 항목이 곧 영수증 `delivered` 의 구조 근거다(호출자가 기록).
     */
    seatMessageArrived(message: SeatMessageNoticeInput): NextTuiQueueItem | null {
      const stillQueued = queue.items.some((item) => item.kind === 'notice' && item.source === 'seat-mail' && item.msgId === message.id);
      if (stillQueued) return null;
      const occurredAt = message.createdAt === undefined ? undefined : Date.parse(message.createdAt);
      // Only the ledger arrival watcher feeds this producer (seat-mail-arrival.ts) — the authenticated source.
      const notice = seatMessageNoticeParts(message, undefined, true);
      const routed = seatMailRoute({ ...message, origin: message.origin ?? null });
      const passive = routed.route === 'passive';
      // SEAT-TURN-FOLLOWUPS ② — a delegated result is P1: it joins open work after the 60 s window (several results → one turn).
      const delegatedResult = routed.reason === 'delegated-result';
      return queue.enqueueNotice(message.handCard ? `${notice.text}\n${message.handCard}` : notice.text, 'seat-mail', {
        msgId: message.id,
        ...(isUrgentSeatMail(message) ? { urgent: true } : {}),
        // SEAT-MAIL-PASSIVE-DEFAULT — only ✋ · crown · question/needs-reply · P0 alert · failed result · an order from above
        // open a turn; every other mail waits for the 10-min digest. Every mail carries its one digest line.
        ...(passive ? { passive: true } : {}),
        digest: seatMailDigestLine(message, passive ? SEAT_MAIL_PASSIVE_DIGEST_BODY_CHARS : SEAT_MAIL_DIGEST_BODY_CHARS),
        // QUEUE-FINISH-FIRST — the class rides the item from the structured ledger fields (never the body).
        mailClass: delegatedResult ? 'P1' : classifySeatMail({ intent: message.intent ?? legacyIntent(message.kind), fromKind: message.fromKind ?? null,
          crownDirective: message.crownDirective ?? null, ...(message.origin ? { origin: message.origin } : {}) }),
        mailIntent: message.intent ?? legacyIntent(message.kind),
        ...(message.kind ? { mailKind: message.kind } : {}),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        // NOTICE-FOLD-1LINE — the mail's own body inside this text and inside its digest line, by construction.
        mail: { sender: message.fromSeat ?? message.sender, bodyAt: notice.bodyAt,
          bodyLength: notice.bodyLength, digestBodyAt: seatMailDigestPrefix(message).length },
        // BULK-TRIAGE — the structured fields the bulk triage card ranks by (body clipped · never re-parsed).
        triage: { from: message.fromSeat ?? message.sender, ...(message.recipient ? { to: message.recipient } : {}),
          ...(message.kind ? { kind: message.kind } : {}), ...(message.intent ? { intent: message.intent } : {}),
          ...(message.crownDirective ? { crownDirective: message.crownDirective } : {}),
          ...((message.origin?.kind ?? message.fromKind) ? { originKind: (message.origin?.kind ?? message.fromKind)! } : {}),
          ...(message.deadlineAt ? { deadline: message.deadlineAt } : {}),
          ...(typeof message.priority === 'number' ? { priority: message.priority } : {}),
          body: message.body.length <= 300 ? message.body : message.body.slice(0, 300) },
        ...(occurredAt === undefined || Number.isNaN(occurredAt) ? {} : { occurredAt }),
      });
    },
  };
}

/**
 * 큐 없는 표면(클래식 대시보드)용 싱크 — 적입(enqueueNotice)이 곧 한 줄 표시다.
 * 소비 상태가 없으므로 `items` 는 항상 비고, 돌려주는 항목은 이미 소비된(delivered) 표시.
 * taskId당 1회 호출은 agent-wake 모듈이 이미 보장한다 — 여기는 표시만.
 */
export function createChildNoticeLineSink(
  display: (text: string, source: NextTuiQueueNoticeSource) => void,
): ChildNoticeQueue {
  let seq = 0;
  return {
    items: [],
    enqueueNotice: (text, source) => {
      seq += 1;
      display(text, source);
      return { id: `sink${seq}`, seq, kind: 'notice', mode: 'chat', delivery: 'queue', status: 'delivered', text, source };
    },
  };
}
