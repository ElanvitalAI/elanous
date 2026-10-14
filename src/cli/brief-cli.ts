import type { Command } from 'commander';
import { BRIEF_DOMAINS, BRIEF_PRIORITIES, BRIEF_REACTIONS, BRIEF_SLOTS, BriefItemsInputError, BriefItemsLedger, type BriefDomain, type BriefPriority, type BriefReaction, type BriefSendSlot } from '../briefing/brief-items.js';
import { kindRouteTarget } from '../domains/telegram-kind-route.js';
import { sendTelegramButtonsTo, type TgButton } from '../autopilot/mission-notify.js';
import { getUserConfig } from '../user-config.js';

export function briefFeedbackButtons(ids: readonly number[]): TgButton[][] {
  return ids.map(id => [
    { text: `👀 ${id} 읽음`, data: `brief-item:${id}:read` },
    { text: `✅ ${id} 움직임`, data: `brief-item:${id}:button` },
    { text: `➖ ${id} 넘김`, data: `brief-item:${id}:ignore` },
  ]);
}

export interface BriefTelegramUpdate {
  botId: string;
  chatId: number;
  messageId: number;
  updateId: string;
  text?: string;
  callbackData?: string;
}

export function recordBriefTelegramUpdate(ledger: BriefItemsLedger, update: BriefTelegramUpdate): boolean {
  if (update.callbackData !== undefined) {
    const match = /^brief-item:([1-9]\d*):(read|button|ignore)$/.exec(update.callbackData);
    if (!match) return false;
    return ledger.recordTelegramFeedback({ botId: update.botId, chatId: update.chatId,
      messageId: update.messageId, updateId: update.updateId, itemId: Number(match[1]),
      reaction: match[2] === 'read' ? '열람' : match[2] === 'ignore' ? '무시' : '버튼' });
  }
  if (!update.text?.trim()) return false;
  const text = update.text.trim();
  const itemId = /^(?:#|항목\s*)([1-9]\d*)(?=\s|[:：]|$)/.exec(text)?.[1];
  return ledger.recordTelegramFeedback({ botId: update.botId, chatId: update.chatId,
    messageId: update.messageId, updateId: update.updateId,
    ...(itemId ? { itemId: Number(itemId) } : {}),
    reaction: /그게 아니라|(?:^|\s)정정\s*[:：]/.test(text) ? '정정' : '답장' });
}

/** Prefix each item line with `#<id>` so the 대표 can name the reply target ("#12 답장", "#12 그게 아니라 …"). */
function withItemNumbers(text: string, itemLines: ReadonlyMap<string, readonly number[]>): string {
  const linePositions = new Map<string, number>();
  return text.split('\n').map(line => {
    const ids = itemLines.get(line);
    if (!ids) return line;
    const position = linePositions.get(line) ?? 0;
    linePositions.set(line, position + 1);
    const itemId = ids[position];
    return itemId === undefined ? line : `#${itemId} ${line}`;
  }).join('\n');
}

/** Split only feedback-enabled pages; each Telegram message gets its own real item coordinate.
 * Item lines carry their `#<id>` so a plain text reply can name its target item.
 */
function briefDeliveryParts(markdown: string, itemLines: ReadonlyMap<string, readonly number[]>): Array<{ text: string; itemId: number }> {
  const parts: Array<{ text: string; itemId: number }> = [];
  const linePositions = new Map<string, number>();
  let pending = '';
  for (const line of markdown.trimEnd().split('\n')) {
    const ids = itemLines.get(line);
    const position = linePositions.get(line) ?? 0;
    const itemId = ids?.[position];
    if (itemId === undefined) {
      pending += `${line}\n`;
      continue;
    }
    linePositions.set(line, position + 1);
    const numbered = `#${itemId} ${line}`;
    // Leave room for the Telegram sender's newline and keep a button on every fragment.
    while (pending.length >= 3800) {
      parts.push({ text: pending.slice(0, 3800), itemId });
      pending = pending.slice(3800);
    }
    let remainder = pending + numbered;
    do {
      parts.push({ text: remainder.slice(0, 3800), itemId });
      remainder = remainder.slice(3800);
    } while (remainder.length);
    pending = '';
  }
  if (pending && parts.length) {
    const last = parts[parts.length - 1]!;
    if (last.text.length + pending.length <= 3800) last.text += pending;
    else {
      const room = 3800 - last.text.length;
      last.text += pending.slice(0, room);
      for (let i = room; i < pending.length; i += 3800) parts.push({ text: pending.slice(i, i + 3800), itemId: last.itemId });
    }
  }
  return parts;
}

export interface BriefCliDeps {
  ledger?: BriefItemsLedger;
  stateDir?: string;
  now?: () => Date;
  output?: (line: string) => void;
  error?: (line: string) => void;
  send?: (markdown: string) => number | null;
  /** Test seam for the Telegram button sender (one actual message per invocation). */
  sendWithButtons?: (text: string, buttons: TgButton[][]) => number | null;
  /** Allows an injected sender to exercise the same Telegram attribution as the real sender. */
  telegramTarget?: { botToken: string; chatId: number };
}

export function registerBriefCommands(program: Command, deps: BriefCliDeps = {}): void {
  const output = deps.output ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const ledger = () => deps.ledger ?? new BriefItemsLedger({
    ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const fail = (verb: string, cause: unknown) => {
    error(`brief ${verb}: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = cause instanceof BriefItemsInputError ? 2 : 1;
  };
  const brief = program.command('brief').description('대표 브리핑 항목 원장과 슬롯 발송')
    .action(() => {
      try {
        const { acted, total } = ledger().weeklyActions();
        output(`이번 주 브리핑 중 대표가 움직인 것 ${acted}/${total}`);
      } catch (cause) { fail('', cause); }
    });
  const deliver = (slot: BriefSendSlot): string => ledger().withSendLock(slot, ({ markdown, ids, itemLines }, markSent) => {
    if (ids.length === 0) return '(보낼 항목 없음)';
    const target = deps.telegramTarget ?? (deps.send ? null : kindRouteTarget(getUserConfig(), 'ops-report'));
    const numberedMarkdown = withItemNumbers(markdown, itemLines);
    const oneMessage = numberedMarkdown.length + numberedMarkdown.split('\n').length <= 3900 && ids.length <= 30;
    const send = (text: string, itemIds: readonly number[]) => deps.sendWithButtons
      ? deps.sendWithButtons(text, briefFeedbackButtons(itemIds))
      : deps.send ? deps.send(text)
      : target ? sendTelegramButtonsTo(target.botToken, target.chatId, text, briefFeedbackButtons(itemIds)) : null;
    const botId = target ? target.botToken.split(':')[0]! : '';
    if (target && !oneMessage) {
      // A sent fragment is not a completed item. Persist only items whose every fragment
      // succeeded; an incomplete item must remain available to the next send.
      const parts = briefDeliveryParts(markdown, itemLines);
      const remainingParts = new Map<number, number>();
      for (const part of parts) remainingParts.set(part.itemId, (remainingParts.get(part.itemId) ?? 0) + 1);
      const coordinates: Array<{ botId: string; chatId: number; messageId: number; itemId: number }> = [];
      let sendThrew = false;
      let sendCause: unknown;
      for (const part of parts) {
        let partMessageId: number | null;
        try { partMessageId = send(part.text, [part.itemId]); }
        catch (cause) { sendThrew = true; sendCause = cause; break; }
        if (typeof partMessageId !== 'number' || !Number.isSafeInteger(partMessageId) || partMessageId <= 0) break;
        coordinates.push({ botId, chatId: target.chatId, messageId: partMessageId, itemId: part.itemId });
        remainingParts.set(part.itemId, remainingParts.get(part.itemId)! - 1);
      }
      const deliveredIds = [...new Set(coordinates.map(row => row.itemId))].filter(id => remainingParts.get(id) === 0);
      if (deliveredIds.length > 0) markSent(deliveredIds, slot, coordinates.filter(row => deliveredIds.includes(row.itemId)));
      if (coordinates.length < parts.length) {
        if (sendThrew) throw sendCause;
        throw new Error(`발송 실패: ${deliveredIds.length}/${ids.length} 항목 전송 후 중단 — 나머지는 다음 발송에서 이어진다`);
      }
      const lastMessageId = coordinates[coordinates.length - 1]!.messageId;
      return `sent ${lastMessageId} (${ids.length} items)`;
    }
    const messageId = target ? send(numberedMarkdown, ids) : send(markdown, ids);
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('발송 실패: 양수 메시지 id 없음');
    }
    markSent(ids, slot, target ? { botId, chatId: target.chatId, messageId } : undefined);
    return `sent ${messageId} (${ids.length} items)`;
  });

  brief.command('add')
    .description('주장 한 줄을 원장에 추가한다 (원문 그대로)')
    .requiredOption('--text <text>', '주장 한 줄')
    .requiredOption('--domain <domain>', `도메인 (${BRIEF_DOMAINS.join('|')})`)
    .requiredOption('--priority <priority>', `중요도 (${BRIEF_PRIORITIES.join('|')})`)
    .requiredOption('--source <source>', '출처 (루프·자리·흡수·코나투스)')
    .option('--deadline <deadline>', '마감 (YYYY-MM-DD 또는 ISO)')
    .option('--evidence <evidence>', '근거 링크')
    .option('--created-at <iso>', '작성 시각 (ISO, 생략 시 지금)')
    .option('--send-now', 'P0 추가 직후 실시간 발송')
    .option('--json', 'JSON 출력')
    .action((opts: { text: string; domain: string; priority: string; source: string; deadline?: string; evidence?: string; createdAt?: string; sendNow?: boolean; json?: boolean }) => {
      try {
        if (opts.sendNow && opts.priority !== 'P0') throw new BriefItemsInputError('--send-now requires --priority P0');
        const item = ledger().add({
          text: opts.text,
          domain: opts.domain as BriefDomain,
          priority: opts.priority as BriefPriority,
          source: opts.source,
          ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
          ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
          ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
        });
        output(opts.json ? JSON.stringify(item) : `added ${item.id} [${item.priority}] ${item.domain}`);
        if (opts.sendNow) output(deliver('realtime'));
      } catch (cause) { fail('add', cause); }
    });

  brief.command('react')
    .description('발송된 브리핑 항목에 대한 대표 반응을 기록한다')
    .requiredOption('--item-id <id>', '발송 항목 id')
    .requiredOption('--reaction <reaction>', `반응 (${BRIEF_REACTIONS.join('|')})`)
    .action((opts: { itemId: string; reaction: string }) => {
      try {
        const id = Number(opts.itemId);
        ledger().recordReaction(id, opts.reaction as BriefReaction);
        output(`reacted ${id} ${opts.reaction}`);
      } catch (cause) { fail('react', cause); }
    });

  brief.command('list')
    .description('원장 항목을 추가 순으로 본다')
    .option('--domain <domain>', `도메인 필터 (${BRIEF_DOMAINS.join('|')})`)
    .option('--json', 'JSON 출력')
    .action((opts: { domain?: string; json?: boolean }) => {
      try {
        if (opts.domain !== undefined && !(BRIEF_DOMAINS as readonly string[]).includes(opts.domain)) {
          throw new BriefItemsInputError('invalid domain');
        }
        const items = ledger().list(opts.domain === undefined ? {} : { domain: opts.domain as BriefDomain });
        if (opts.json) output(JSON.stringify(items));
        else if (items.length === 0) output('(항목 없음)');
        else for (const item of items) output(`${item.id}\t${item.priority}\t${item.domain}\t${item.source}\t${item.text}`);
      } catch (cause) { fail('list', cause); }
    });

  brief.command('compose')
    .description('슬롯 이전의 미발송 항목을 한 장 마크다운으로 만든다 (표준 출력만, 발송 없음)')
    .requiredOption('--slot <slot>', `슬롯 (${BRIEF_SLOTS.join('|')})`)
    .action((opts: { slot: string }) => {
      try { output(ledger().compose(opts.slot)); }
      catch (cause) { fail('compose', cause); }
    });

  brief.command('send')
    .description('슬롯 이전의 미발송 항목을 한 장 발송하고 성공한 항목만 표시한다')
    .option('--slot <slot>', `슬롯 (${BRIEF_SLOTS.join('|')}, --realtime 시 불필요)`)
    .option('--realtime', '미발송 P0 및 오늘 마감 항목을 즉시 한 장 발송한다')
    .option('--dry-run', '한 장만 출력하고 발송·표시하지 않는다')
    .action((opts: { slot?: string; realtime?: boolean; dryRun?: boolean }) => {
      try {
        if (opts.realtime && opts.slot !== undefined) throw new BriefItemsInputError('--realtime cannot be combined with --slot');
        if (!opts.realtime && opts.slot === undefined) throw new BriefItemsInputError('--slot is required unless --realtime');
        const slot = opts.realtime ? 'realtime' : opts.slot!;
        if (opts.dryRun) {
          const { markdown, ids } = ledger().composeWithIds(slot);
          output(ids.length === 0 ? '(보낼 항목 없음)' : markdown);
          return;
        }
        output(deliver(slot as BriefSendSlot));
      } catch (cause) { fail('send', cause); }
    });
}
