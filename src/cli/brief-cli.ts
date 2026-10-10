import type { Command } from 'commander';
import { BRIEF_DOMAINS, BRIEF_PRIORITIES, BRIEF_REACTIONS, BRIEF_SLOTS, BriefItemsInputError, BriefItemsLedger, type BriefDomain, type BriefPriority, type BriefReaction, type BriefSendSlot } from '../briefing/brief-items.js';
import { kindRouteTarget } from '../domains/telegram-kind-route.js';
import { sendTelegramReturningId } from '../autopilot/mission-notify.js';
import { getUserConfig } from '../user-config.js';

export interface BriefCliDeps {
  ledger?: BriefItemsLedger;
  stateDir?: string;
  now?: () => Date;
  output?: (line: string) => void;
  error?: (line: string) => void;
  send?: (markdown: string) => number | null;
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
  const deliver = (slot: BriefSendSlot): string => ledger().withSendLock(slot, ({ markdown, ids }, markSent) => {
    if (ids.length === 0) return '(보낼 항목 없음)';
    const send = deps.send ?? ((text: string) => {
      const target = kindRouteTarget(getUserConfig(), 'ops-report');
      if (!target) return null;
      return sendTelegramReturningId(target.botToken, target.chatId, text);
    });
    const messageId = send(markdown);
    if (typeof messageId !== 'number' || !Number.isFinite(messageId) || messageId <= 0) {
      throw new Error('발송 실패: 양수 메시지 id 없음');
    }
    markSent(ids, slot);
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
