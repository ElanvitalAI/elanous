/**
 * CEO-UTTERANCE-TAGGED-LAST — the person's line is its own, speaker-tagged, LAST user content part.
 *
 * 11-26 05:05 (session 553f08a1): the CEO's three lines reached the model as plain untagged user text inside a bundle
 * of recall, task notifications, wake batches and mail notices — the model answered the mail and missed the CEO.
 * Here the turn's user message is assembled as:
 *   [harness blocks (recall · notifications · wake batches · digests), each a tagged non-human block] →
 *   [images the person attached] → `<human from="CEO">…</human>` (always the final part).
 * Queue context the TUI put in front of the person's words (interrupt line · replacement candidate · triage card) is
 * harness context too: it moves into a `<harness_notice>` block, the tag holds only the person's own words.
 *
 * Pure module.
 */
import type { ContentBlock } from '../llm.js';
import { HUMAN_CLOSE, HUMAN_OPEN, stripQueueModelContext, wrapUserQuery } from '../chat/interjection.js';

export const HARNESS_NOTICE_CLOSE = '</harness_notice>';

/** A harness block as a tagged non-human part. Already-tagged blocks (`<task-notification>` …) are wrapped too. 순수. */
export function harnessNoticeBlock(text: string, kind = 'context'): string {
  const safeKind = /^[a-z0-9-]{1,32}$/u.test(kind) ? kind : 'context';
  const body = text.split(HARNESS_NOTICE_CLOSE).join(`‹${HARNESS_NOTICE_CLOSE.slice(1)}`).split(HUMAN_CLOSE).join(`‹${HUMAN_CLOSE.slice(1)}`);
  return `<harness_notice kind="${safeKind}" speaker="harness">\n${body}\n${HARNESS_NOTICE_CLOSE}`;
}

/** The person's own words of a turn text, and the harness context the queue put in front of them. 순수. */
export function splitHumanLine(userText: string): { human: string; context: string } {
  const human = stripQueueModelContext(userText);
  if (human === userText || !userText.endsWith(human)) return { human: userText, context: '' };
  return { human, context: userText.slice(0, userText.length - human.length).trim() };
}

/**
 * The final user message content of a person's turn: harness parts first (tagged non-human), then the person's
 * images, then `<human from="CEO">` LAST. Non-text harness parts (images from the person) keep their order. 순수.
 */
export function humanLastContent(userText: string, parts: readonly ContentBlock[] = []): ContentBlock[] {
  const { human, context } = splitHumanLine(userText);
  const harness: ContentBlock[] = [];
  const media: ContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') harness.push({ type: 'text', text: harnessNoticeBlock(part.text, harnessKind(part.text)) });
    else media.push(part);
  }
  if (context) harness.push({ type: 'text', text: harnessNoticeBlock(context, 'turn-context') });
  return [...harness, ...media, { type: 'text', text: wrapUserQuery(human) }];
}

function harnessKind(text: string): string {
  if (text.startsWith('<task-notification')) return 'task-notification';
  if (text.includes('기억') || text.startsWith('## ') || text.startsWith('<seat_memory')) return 'memory-recall';
  return 'context';
}

/** True when a user content (string or parts) ends with the tagged human part. 순수. */
export function endsWithHumanPart(content: string | readonly ContentBlock[]): boolean {
  const last = typeof content === 'string' ? content : [...content].reverse().find((part) => part.type === 'text');
  const text = typeof last === 'string' ? last : last && last.type === 'text' ? last.text : '';
  return text.trimEnd().endsWith(HUMAN_CLOSE) && text.includes(HUMAN_OPEN);
}

/**
 * The text a memory recall is keyed on — the person's line only. A notice bundle (no person) keys on the mail bodies
 * with our own harness lines removed (lead notes · frame/digest tags · notice heads · unread counts). 순수.
 */
export function recallKeyText(userText: string, fromKind: string | undefined): string {
  if (fromKind === 'human') return splitHumanLine(userText).human;
  return userText.split('\n').filter((line) => !isHarnessLine(line)).map((line) => line.replace(/^- #\d+ · [\w-]+ · [\w-]+ · /u, '').replace(/^msg:\d+ · /u, '')).join('\n').trim();
}

const HARNESS_LINE_PREFIXES = ['<mail_digest', '</mail_digest>', '<federation_work_order', '</federation_work_order>', '<seat_mail_untrusted',
  '</seat_mail_untrusted>', '[notice · ', '[미읽음 총 ', '[seat-mail digest]', '[from ', '[seat mail · ', '<harness_notice', HARNESS_NOTICE_CLOSE,
  'Information mail from other seats', '연방 자리가 보낸 업무 지시입니다', '작업 중에 자리 우편이 도착했습니다'];
function isHarnessLine(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || HARNESS_LINE_PREFIXES.some((prefix) => t.startsWith(prefix));
}
